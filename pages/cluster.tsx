import type { GetServerSidePropsContext } from "next";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { BandMap } from "@/components/cluster/BandMap";
import { SpotTable } from "@/components/cluster/SpotTable";
import { HelpTip } from "@/components/ui/HelpTip";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { apiPost, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { useBridgeSocket } from "@/lib/client/use-bridge-socket";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";
import type { ClusterApiResponse, ClusterSnapshot, ClusterSpot, ModeCategory } from "@/lib/cluster/types";
import {
  ALL_BANDS,
  bandsInUse,
  filterSpots,
  formatKhz,
  isClusterSpot,
  sortSpots,
  upsertSpot,
  type SpotFilter,
} from "@/lib/cluster/view";
import { freqToBand } from "@/lib/ham/bands";
import { settingsTabFor } from "@/lib/settings/tabs";
import { formatAgo, formatUtcTime } from "@/lib/time";
import { cn } from "@/lib/utils";

// The DX cluster: who is on the air, where, and which of them this log still needs.
//
// The list comes from the bridge (GET /api/cluster/spots), new spots arrive on the decode
// socket as { kind: "spot" }, and the socket's status frames say where the radio is, which
// is what the band map opens on. Clicking a spot tunes the receiver and nothing else.

interface Props extends Record<string, unknown> {
  wsUrl: string;
}

const AGE_CHOICES = [5, 10, 15, 30, 60, 120];
const DEFAULT_FILTER: SpotFilter = { band: ALL_BANDS, category: "ALL", neededOnly: false, maxAgeMin: 30 };
const FILTER_KEY = "digishack.cluster.filter";

/** The filter survives a reload; a page left open on a shack monitor should not forget it. */
function useStoredFilter(): [SpotFilter, (f: SpotFilter) => void] {
  const [filter, setFilter] = useState<SpotFilter>(DEFAULT_FILTER);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FILTER_KEY);
      if (raw) setFilter({ ...DEFAULT_FILTER, ...(JSON.parse(raw) as Partial<SpotFilter>) });
    } catch {
      /* private window or blocked storage: the default is fine */
    }
  }, []);
  const save = (f: SpotFilter) => {
    setFilter(f);
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      /* as above */
    }
  };
  return [filter, save];
}

function LinkBadge({ c }: { c: ClusterSnapshot }) {
  switch (c.state) {
    case "connected":
      return <Badge tone="ok">Connected</Badge>;
    case "connecting":
    case "login":
      return <Badge tone="warn">Connecting…</Badge>;
    case "waiting":
      return <Badge tone="danger">Reconnecting</Badge>;
    case "no-login":
      return <Badge tone="danger">No callsign</Badge>;
    default:
      return <Badge>Off</Badge>;
  }
}

export default function ClusterPage({ wsUrl }: Props) {
  const canTune = useCan("OPERATOR");
  const isAdmin = useCan("ADMIN");
  const { data, error, reload } = useApi<ClusterApiResponse>("/api/cluster/spots");
  const cluster = data?.cluster ?? null;

  const [spots, setSpots] = useState<ClusterSpot[]>([]);
  useEffect(() => {
    if (cluster) setSpots(cluster.spots);
  }, [cluster]);

  const [radio, setRadio] = useState<{ dialHz: number | null; band: string | null }>({
    dialHz: null,
    band: null,
  });
  const { connected: live } = useBridgeSocket(wsUrl, (msg) => {
    if (msg.kind === "spot" && isClusterSpot(msg.spot)) {
      const spot = msg.spot;
      setSpots((prev) => upsertSpot(prev, spot));
    } else if (msg.kind === "status" && msg.status && typeof msg.status === "object") {
      const st = msg.status as { dialFrequency?: unknown; band?: unknown };
      const dialHz = typeof st.dialFrequency === "number" ? st.dialFrequency : null;
      setRadio({
        dialHz,
        band: typeof st.band === "string" ? st.band.toUpperCase() : dialHz ? freqToBand(dialHz) : null,
      });
    }
  });

  // The socket brings new spots; the list is still re-read now and then for repeat counts,
  // re-judged "needed" flags and the link's own state — and often while it is not up yet.
  const settled = cluster?.state === "connected" && live;
  useVisibleInterval(() => void reload(), settled ? 60_000 : 15_000);

  const [now, setNow] = useState(() => Date.now());
  useVisibleInterval(() => setNow(Date.now()), 20_000);

  const [filter, setFilter] = useStoredFilter();
  const [mapBand, setMapBand] = useState<string | null>(null);
  const [tuning, setTuning] = useState<{ id: string; ok: boolean | null; text: string } | null>(null);

  const visible = useMemo(() => sortSpots(filterSpots(spots, filter, now)), [spots, filter, now]);
  // The band list ignores the band filter, or choosing one band would hide all the others.
  const bands = useMemo(
    () => bandsInUse(filterSpots(spots, { ...filter, band: ALL_BANDS }, now)),
    [spots, filter, now],
  );

  // The band map follows, in order: an explicit pick on the map, the band filter, the
  // radio's band if anything is spotted there, then the busiest band.
  const shownBand =
    mapBand ??
    (filter.band !== ALL_BANDS ? filter.band : null) ??
    (radio.band && bands.some((b) => b.band === radio.band) ? radio.band : null) ??
    bands.reduce<{ band: string; count: number } | null>((a, b) => (a === null || b.count > a.count ? b : a), null)
      ?.band ??
    radio.band;
  const mapSpots = useMemo(
    () => (shownBand ? filterSpots(spots, { ...filter, band: shownBand }, now) : []),
    [spots, filter, shownBand, now],
  );

  async function tune(s: ClusterSpot) {
    setTuning({ id: s.id, ok: null, text: `Tuning to ${formatKhz(s.freqHz)} kHz for ${s.dx}…` });
    try {
      await apiPost("/api/bridge/control", { action: "rig", freqHz: s.freqHz });
      setTuning({
        id: s.id,
        ok: true,
        text: `Receiver on ${formatKhz(s.freqHz)} kHz for ${s.dx}. The mode is as it was; nothing was transmitted.`,
      });
    } catch (err) {
      setTuning({ id: s.id, ok: false, text: err instanceof Error ? err.message : "The radio would not tune" });
    }
  }

  const settingsHref = `/settings?tab=${settingsTabFor("cluster").id}`;
  const header = (
    <PageHeader
      title="DX Cluster"
      subtitle={
        cluster?.enabled
          ? `${cluster.host}:${cluster.port}${cluster.login ? ` as ${cluster.login}` : ""}`
          : "Spots from a DX cluster node, with a band map"
      }
      actions={
        <>
          {cluster && <LinkBadge c={cluster} />}
          {cluster?.enabled && (
            <span className="text-xs text-fg-subtle" title="New spots arrive on the bridge's live socket">
              {live ? "live" : "live feed reconnecting"}
            </span>
          )}
          <HelpTip label="About the cluster page" align="right">
            Spots come from the node set in Settings → DX cluster, read by the bridge. Repeats of
            one call on one band inside ten minutes are counted, not listed again. A mode with a
            question mark was guessed from the frequency. The badges compare each spot&apos;s DXCC
            entity with this log: gold is an entity never worked, blue a band or mode not yet
            worked with it. Clicking a frequency tunes the receiver only.
          </HelpTip>
        </>
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorBanner>{error.message}</ErrorBanner>
      </>
    );
  }
  if (!data) {
    return (
      <>
        {header}
        <p className="text-sm text-fg-muted">Loading…</p>
      </>
    );
  }

  const offState = (() => {
    if (!data.running) {
      return <EmptyState title="The radio service is not running">{data.reason}</EmptyState>;
    }
    if (!cluster) {
      return <EmptyState title="The bridge has no DX cluster yet">{data.reason}</EmptyState>;
    }
    if (!cluster.enabled) {
      return data.settingEnabled ? (
        <EmptyState title="Starting…">
          The cluster is switched on; the bridge picks the change up within about 15 seconds.
        </EmptyState>
      ) : (
        <EmptyState
          title="DX cluster is off — enable it in Settings → DX cluster"
          action={
            isAdmin ? (
              <Link href={settingsHref} className="text-sm text-accent-bright hover:underline">
                Open Settings
              </Link>
            ) : undefined
          }
        >
          {isAdmin ? null : "An admin can switch it on."}
        </EmptyState>
      );
    }
    if (cluster.state === "no-login") {
      return (
        <EmptyState title="No callsign to log in with">
          Set the login in Settings → DX cluster, or create a station — its callsign is used when the
          login is blank.
        </EmptyState>
      );
    }
    if (spots.length === 0) {
      const connecting = cluster.state !== "connected";
      return (
        <EmptyState title={connecting ? `Connecting to ${cluster.host}…` : `Connected to ${cluster.host}`}>
          {connecting ? (
            <>
              {cluster.lastError && <span className="block text-danger">{cluster.lastError}</span>}
              {cluster.nextRetryAt && (
                <span className="block">Next attempt at {formatUtcTime(cluster.nextRetryAt)}.</span>
              )}
            </>
          ) : (
            "Waiting for the first spot."
          )}
        </EmptyState>
      );
    }
    return null;
  })();

  if (offState) {
    return (
      <>
        {header}
        <Card>{offState}</Card>
      </>
    );
  }
  // From here the cluster is enabled and has spots.
  const c = cluster!;
  // formatAgo says "now" inside a minute, and "now ago" is not English.
  const heardAgo = c.lastLineAt ? formatAgo(c.lastLineAt) : null;

  /** The band map's band buttons; placed by `className`, since a phone and a desktop put them in different spots. */
  const bandPicker = (className: string) =>
    bands.length > 1 ? (
      <div className={cn("flex flex-wrap gap-1", className)}>
        {bands.map((b) => (
          <button
            key={b.band}
            type="button"
            onClick={() => setMapBand(b.band)}
            aria-pressed={b.band === shownBand}
            title={`${b.count} spot${b.count === 1 ? "" : "s"} on ${b.band}${b.band === radio.band ? " — the radio is here" : ""}`}
            // Wider and 12px on a phone: the coarse-pointer rule already makes them 44px
            // tall there, but at 11px with 6px of padding "20M" was a sliver to aim at.
            className={cn(
              "rounded-sm border px-2.5 py-0.5 text-xs tnum sm:px-1.5 sm:text-[11px]",
              b.band === shownBand
                ? "border-accent bg-accent/10 text-accent-bright"
                : "border-line text-fg-muted hover:text-fg",
            )}
          >
            {b.band}
            {b.band === radio.band ? " •" : ""}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <>
      {header}

      {c.state !== "connected" && c.lastError && (
        <div className="mb-4">
          <ErrorBanner>
            {c.lastError}
            {c.nextRetryAt ? ` — next attempt at ${formatUtcTime(c.nextRetryAt)}.` : ""} The spots below are
            from before the link dropped.
          </ErrorBanner>
        </div>
      )}
      {c.dxccMissing && (
        <p className="mb-4 rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm text-fg-muted">
          No DXCC data is loaded, so spots have no entity and nothing can be marked as needed. An admin
          can load it from the DXCC data page.
        </p>
      )}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Band" htmlFor="cl-band">
            <Select
              id="cl-band"
              value={filter.band}
              onChange={(e) => {
                setFilter({ ...filter, band: e.target.value });
                setMapBand(null);
              }}
            >
              <option value={ALL_BANDS}>All bands</option>
              {bands.map((b) => (
                <option key={b.band} value={b.band}>
                  {b.band} ({b.count})
                </option>
              ))}
              {filter.band !== ALL_BANDS && !bands.some((b) => b.band === filter.band) && (
                <option value={filter.band}>{filter.band} (0)</option>
              )}
            </Select>
          </Field>
          <Field label="Mode" htmlFor="cl-mode">
            <Select
              id="cl-mode"
              value={filter.category}
              onChange={(e) => setFilter({ ...filter, category: e.target.value as ModeCategory | "ALL" })}
            >
              <option value="ALL">All modes</option>
              <option value="CW">CW</option>
              <option value="PHONE">Phone</option>
              <option value="DIGITAL">Digital</option>
            </Select>
          </Field>
          <Field label="Spotted within" htmlFor="cl-age">
            <Select
              id="cl-age"
              value={String(filter.maxAgeMin)}
              onChange={(e) => setFilter({ ...filter, maxAgeMin: Number(e.target.value) })}
            >
              {AGE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={filter.neededOnly}
              onChange={(e) => setFilter({ ...filter, neededOnly: e.target.checked })}
              className="size-4 accent-accent"
            />
            Needed only
          </label>
        </div>
        <p className="mt-3 text-xs text-fg-subtle">
          {c.counts.spots.toLocaleString()} spots and {c.counts.dupes.toLocaleString()} repeats since the
          bridge started
          {heardAgo
            ? ` · last heard from the node ${heardAgo === "now" ? "just now" : `${heardAgo} ago`}`
            : ""}
          {canTune ? " · click a frequency to tune the receiver" : ""}
        </p>
      </Card>

      {tuning && (
        <p
          role="status"
          className={cn(
            "mb-4 text-sm",
            tuning.ok === false ? "text-danger" : tuning.ok ? "text-ok" : "text-fg-muted",
          )}
        >
          {tuning.text}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card title={`Spots (${visible.length})`} className="min-w-0">
          {visible.length === 0 ? (
            <EmptyState title="No spots match the filters" className="py-8">
              {filter.neededOnly
                ? "Nothing spotted in that window is needed by this log."
                : "Widen the band, mode or time window."}
            </EmptyState>
          ) : (
            <SpotTable
              spots={visible}
              canTune={canTune}
              onTune={(s) => void tune(s)}
              tuningId={tuning?.ok === null ? tuning.id : null}
              now={now}
            />
          )}
        </Card>

        <Card
          title={shownBand ? `Band map — ${shownBand}` : "Band map"}
          className="min-w-0"
          actions={bandPicker("hidden justify-end sm:flex")}
        >
          {/* On a phone the picker sits in the body: beside the title, a row of band
              buttons squeezed "Band map — 20M" into a column three words tall. */}
          {bandPicker("mb-3 sm:hidden")}
          {shownBand ? (
            <BandMap
              band={shownBand}
              spots={mapSpots}
              dialHz={radio.dialHz}
              canTune={canTune}
              onTune={(s) => void tune(s)}
              tuningId={tuning?.ok === null ? tuning.id : null}
              now={now}
            />
          ) : (
            <p className="text-sm text-fg-subtle">No band to show yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  inner: async (ctx: GetServerSidePropsContext) => {
    const { wsUrl } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl } };
  },
});

// The band on a world map, GridTracker-style — live, self-contained, no tiles.
//
// Four populations on one map, each answering a different question:
//   * LIVE DECODES (websocket) — who is on the air right now, placed by the grid
//     square their message carried. CQs are green: those are the workable ones.
//   * WORKED SQUARES (the log) — every 4-character square worked in the period.
//   * LOGGED CONTACTS (the log) — where this station has been heard back from,
//     coloured by band with the shared palette.
//   * HEARD BY (PSKReporter) — receivers that heard US: the transmit answer to the
//     decode list's receive answer.
// Over them, optionally, day and night from the clock (lib/maps/greyline.ts), and a
// great-circle path from this station to whatever is hovered or tapped.
//
// The basemap is vendored Natural Earth coastlines (lib/geo/land.ts), equirectangular,
// drawn on a canvas by lib/maps/draw.ts — see there for the measurement that moved it off
// SVG.
//
// EVERY LIVE MARKER ON THIS MAP ARRIVES OVER ONE WEBSOCKET from the radio service. When that
// socket is not connected the map is not quiet, it is blind — and the two look identical.
// See the Calling CQ card at the bottom for the sentence that used to conflate them.

import Link from "next/link";
import type { GetServerSidePropsContext } from "next";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BandKey, LayerToggle } from "@/components/maps/Legend";
import { WorldMap } from "@/components/maps/WorldMap";
import { Badge, Card, ErrorBanner, Field, PageHeader, Select } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { useApi } from "@/lib/client/api";
import { useDistanceUnit } from "@/lib/client/use-distance-unit";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";
import { colourFor } from "@/lib/ham/band-colours";
import { BAND_NAMES } from "@/lib/ham/bands";
import { gridFromMessage } from "@/lib/ham/grid-message";
import type { HeardMarker, LiveMarker, LoggedMarker, MapScene, Marker, WorkedCell } from "@/lib/maps/draw";
import { formatBearing, formatDistance, gridToLatLon, greatCirclePath, paths } from "@/lib/maps/geodesy";
import { sunPosition } from "@/lib/maps/greyline";
import { ago, bandsPresent } from "@/lib/maps/legend";
import { MAP_COLOURS } from "@/lib/maps/palette";
import { gridCentre, project, squareSW, type LatLon } from "@/lib/maps/projection";
import { cn } from "@/lib/utils";

interface Props extends Record<string, unknown> {
  wsUrl: string;
}

/** A station heard on the air, placed on the map. */
interface LiveStation {
  callsign: string;
  grid: string;
  lat: number;
  lon: number;
  snr: number;
  at: number;
  isCq: boolean;
  message: string;
  band: string | null;
}

interface QsoPoint {
  lat: number;
  lon: number;
  band: string;
  mode: string;
  callsign: string;
  km: number;
  at: string;
}

interface QsoMap {
  home: { grid: string; lat: number; lon: number } | null;
  points: QsoPoint[];
  byGrid: { grid: string; count: number }[];
  truncated: boolean;
}

interface PskReceiver {
  receiverCall: string;
  receiverGrid: string | null;
  bestSnr: number | null;
  reports: number;
  lastAt: string;
  band: string | null;
}

interface HeardBy {
  receivers: PskReceiver[];
  totalReceivers: number;
  truncated: boolean;
  collector: { detail: string };
}

/** How long a heard station stays on the map. FT8 memory, not history. */
const LIVE_TTL_MS = 15 * 60_000;

interface Prefs {
  live: boolean;
  worked: boolean;
  logged: boolean;
  heard: boolean;
  greyline: boolean;
  band: string;
  /** Days back for the log layers; "0" is the whole log. */
  days: string;
  /** Minutes back for the heard-by layer. */
  heardMinutes: string;
}

const DEFAULT_PREFS: Prefs = {
  live: true,
  worked: true,
  logged: false,
  heard: false,
  greyline: true,
  band: "",
  days: "0",
  heardMinutes: "60",
};

const PREFS_KEY = "digishack.gridmap";

/** What a marker on the map stands for, for the card and the path readout. */
type Picked =
  | { kind: "live"; key: string; callsign: string; grid: string; at: LatLon; station: LiveStation }
  | { kind: "logged"; key: string; callsign: string; grid: string | null; at: LatLon; point: QsoPoint }
  | { kind: "heard"; key: string; callsign: string; grid: string; at: LatLon; receiver: PskReceiver };

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n} dB`;
}

export default function GridMapPage({ wsUrl }: Props) {
  const [live, setLive] = useState<Map<string, LiveStation>>(new Map());
  const [connected, setConnected] = useState(false);
  const [radioBand, setRadioBand] = useState<string | null>(null);
  const [deGrid, setDeGrid] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sunAt, setSunAt] = useState(() => Math.floor(Date.now() / 60_000));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [unit] = useDistanceUnit();

  // Display choices are per device, like the distance unit. Read after mount so the
  // server-rendered markup matches; every access guarded for private windows.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) setPrefs((p) => ({ ...p, ...(JSON.parse(raw) as Partial<Prefs>) }));
    } catch {
      /* defaults */
    }
  }, []);
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* this session only */
      }
      return next;
    });
  }, []);

  const bandQ = prefs.band ? `&band=${encodeURIComponent(prefs.band)}` : "";
  // Always fetched, because it carries the station's own grid — the marker and every path
  // are measured from it. Slim: aggregates only.
  const summary = useApi<QsoMap>(`/api/qso-map?slim=1&days=${prefs.days}${bandQ}`);
  const contacts = useApi<QsoMap>(prefs.logged ? `/api/qso-map?days=${prefs.days}${bandQ}` : null);
  const heardBy = useApi<HeardBy>(
    prefs.heard ? `/api/psk-spots?minutes=${prefs.heardMinutes}&limit=200` : null,
  );
  // The collector asks PSKReporter every five minutes; asking the server more often than
  // that would only redraw the same receivers.
  useVisibleInterval(() => void heardBy.reload(), 5 * 60_000, { enabled: prefs.heard, catchUp: false });

  // Ages drive the fade and the "heard 12 s ago" line. Stopped while hidden.
  useVisibleInterval(() => setNow(Date.now()), 1_000);
  // The sun moves a quarter of a degree a minute; redrawing the night more often is waste.
  useVisibleInterval(() => setSunAt(Math.floor(Date.now() / 60_000)), 60_000, { enabled: prefs.greyline });

  // The same reconnecting-socket shape as the decodes page, for the same reasons —
  // including the socket held OUTSIDE connect() so cleanup can actually close it.
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1_000;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        retry = setTimeout(connect, backoff);
        return;
      }
      socket = ws;
      ws.onopen = () => {
        setConnected(true);
        backoff = 1_000;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.kind === "status" && msg.status) {
            if (msg.status.band !== undefined) setRadioBand(msg.status.band);
            if (typeof msg.status.deGrid === "string") setDeGrid(msg.status.deGrid);
          }
          const decodes =
            msg.kind === "decode"
              ? [msg]
              : msg.kind === "backlog" && Array.isArray(msg.decodes)
                ? msg.decodes
                : [];
          if (decodes.length === 0) return;
          setLive((prev) => {
            const next = new Map(prev);
            for (const d of decodes) {
              if (!d.callsign) continue;
              const grid = gridFromMessage(d.message ?? "");
              const at = Date.parse(d.timestamp) || Date.now();
              const existing = next.get(d.callsign);
              // A station whose new message has no grid keeps its old position —
              // a report doesn't mean they moved, it means FT8 messages are short.
              const centre = grid ? gridCentre(grid) : null;
              if (!centre && !existing) continue;
              next.set(d.callsign, {
                callsign: d.callsign,
                grid: grid ?? existing!.grid,
                lat: centre?.lat ?? existing!.lat,
                lon: centre?.lon ?? existing!.lon,
                snr: d.snr,
                at,
                isCq: /^CQ\b/i.test(d.message ?? ""),
                message: d.message ?? "",
                band: typeof d.band === "string" ? d.band.toUpperCase() : (existing?.band ?? null),
              });
            }
            return next;
          });
        } catch {
          /* not JSON — not ours */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [wsUrl]);

  // Expire quietly rather than on render: once a minute keeps the Map bounded.
  // Left running while hidden deliberately: this one BOUNDS MEMORY rather than driving a
  // display — a hidden tab still receives decodes over the socket.
  useEffect(() => {
    const id = setInterval(() => {
      setLive((prev) => {
        const cutoff = Date.now() - LIVE_TTL_MS;
        if (![...prev.values()].some((s) => s.at < cutoff)) return prev;
        return new Map([...prev].filter(([, s]) => s.at >= cutoff));
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // ------------------------------------------------------------------- derived

  const home: (LatLon & { grid: string }) | null = useMemo(() => {
    const h = summary.data?.home;
    if (h) return { lat: h.lat, lon: h.lon, grid: h.grid };
    // No station grid in the log's settings: fall back to what the radio software uses.
    const g = deGrid ? gridToLatLon(deGrid) : null;
    return g && deGrid ? { ...g, grid: deGrid.toUpperCase() } : null;
  }, [summary.data, deGrid]);

  const liveList = useMemo(() => {
    const cutoff = now - LIVE_TTL_MS;
    return [...live.values()]
      .filter((s) => s.at >= cutoff && (!prefs.band || s.band === prefs.band))
      .sort((a, b) => b.at - a.at);
  }, [live, now, prefs.band]);
  const cqs = useMemo(() => liveList.filter((s) => s.isCq), [liveList]);

  const worked: WorkedCell[] = useMemo(() => {
    if (!prefs.worked || !summary.data) return [];
    const out: WorkedCell[] = [];
    for (const { grid, count } of summary.data.byGrid) {
      const sw = squareSW(grid);
      if (!sw) continue;
      const p = project(sw.lat + 1, sw.lon); // NW corner: y comes from the top
      // Denser with more contacts, on a log scale so one contact is visible and four
      // hundred is not a solid block.
      out.push({ x: p.x, y: p.y, alpha: Math.min(0.5, 0.14 + Math.log10(count) * 0.14) });
    }
    return out;
  }, [prefs.worked, summary.data]);

  const loggedPoints = useMemo(() => (prefs.logged ? (contacts.data?.points ?? []) : []), [prefs.logged, contacts.data]);
  const logged: LoggedMarker[] = useMemo(
    () =>
      loggedPoints.map((p) => ({
        key: `l:${p.callsign}:${p.at}`,
        kind: "logged" as const,
        ...project(p.lat, p.lon),
        colour: colourFor(p.band),
      })),
    [loggedPoints],
  );

  const receivers = useMemo(() => {
    if (!prefs.heard || !heardBy.data) return [];
    return heardBy.data.receivers.flatMap((r) => {
      if (prefs.band && r.band !== prefs.band) return [];
      const at = r.receiverGrid ? gridToLatLon(r.receiverGrid) : null;
      return at && r.receiverGrid ? [{ r, at, grid: r.receiverGrid.toUpperCase() }] : [];
    });
  }, [prefs.heard, prefs.band, heardBy.data]);
  const heard: HeardMarker[] = useMemo(
    () => receivers.map(({ r, at }) => ({ key: `h:${r.receiverCall}`, kind: "heard" as const, ...project(at.lat, at.lon) })),
    [receivers],
  );

  const liveMarkers: LiveMarker[] = useMemo(
    () =>
      prefs.live
        ? liveList
            .slice()
            .reverse()
            .map((s) => ({
              key: `d:${s.callsign}`,
              kind: "live" as const,
              ...project(s.lat, s.lon),
              callsign: s.callsign,
              isCq: s.isCq,
              opacity: Math.max(0.25, 1 - (now - s.at) / LIVE_TTL_MS),
            }))
        : [],
    [prefs.live, liveList, now],
  );

  /** Resolve a marker key back to what it stands for. */
  const resolve = useCallback(
    (key: string | null): Picked | null => {
      if (!key) return null;
      const [kind, ...rest] = key.split(":");
      if (kind === "d") {
        const s = live.get(rest[0] ?? "");
        return s && prefs.live ? { kind: "live", key, callsign: s.callsign, grid: s.grid, at: s, station: s } : null;
      }
      if (kind === "l") {
        const p = loggedPoints.find((q) => `l:${q.callsign}:${q.at}` === key);
        return p ? { kind: "logged", key, callsign: p.callsign, grid: null, at: p, point: p } : null;
      }
      if (kind === "h") {
        const hit = receivers.find(({ r }) => r.receiverCall === rest.join(":"));
        return hit ? { kind: "heard", key, callsign: hit.r.receiverCall, grid: hit.grid, at: hit.at, receiver: hit.r } : null;
      }
      return null;
    },
    [live, prefs.live, loggedPoints, receivers],
  );

  const selected = resolve(selectedKey);
  const hovered = resolve(hoverKey);
  const target = hovered ?? selected;
  const sun = useMemo(() => (prefs.greyline ? sunPosition(sunAt * 60_000) : null), [prefs.greyline, sunAt]);

  const homePt = useMemo(() => (home ? project(home.lat, home.lon) : null), [home]);
  const targetKey = target?.key ?? null;
  const targetLat = target?.at.lat;
  const targetLon = target?.at.lon;
  const targetCall = target?.callsign;
  const path = useMemo(
    () =>
      home && targetLat !== undefined && targetLon !== undefined
        ? greatCirclePath(home, { lat: targetLat, lon: targetLon }, 1)
        : null,
    [home, targetLat, targetLon],
  );
  const scene: MapScene = useMemo(
    () => ({
      worked,
      logged,
      heard,
      live: liveMarkers,
      home: homePt,
      target:
        targetKey && targetLat !== undefined && targetLon !== undefined
          ? { key: targetKey, ...project(targetLat, targetLon), label: targetCall ?? "" }
          : null,
      path,
      sun,
    }),
    [worked, logged, heard, liveMarkers, homePt, targetKey, targetLat, targetLon, targetCall, path, sun],
  );

  const onPick = useCallback((m: Marker | null) => setSelectedKey(m?.key ?? null), []);
  const onHover = useCallback((m: Marker | null) => setHoverKey(m?.key ?? null), []);

  const loggedBands = useMemo(() => bandsPresent(loggedPoints), [loggedPoints]);
  const noStationGrid = summary.error?.status === 409;
  const pathInfo = home && target ? paths(home, target.at) : null;

  return (
    <>
      <PageHeader
        title="Grid map"
        subtitle="Live decodes, your log and who heard you, on the world — with the greyline"
        actions={
          connected ? (
            <Badge tone="ok">Live{radioBand ? ` · ${radioBand}` : ""}</Badge>
          ) : (
            <Badge tone="warn">Reconnecting</Badge>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-3 min-w-0">
          {/* Two to a row on a phone, each filling its half, rather than fixed widths
              wrapping into a ragged 2 + 1. */}
          <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
            <Field label="Band" htmlFor="gm-band" className="sm:w-32">
              <Select id="gm-band" value={prefs.band} onChange={(e) => update({ band: e.target.value })}>
                <option value="">All bands</option>
                {BAND_NAMES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Log period" htmlFor="gm-days" className="sm:w-36">
              <Select id="gm-days" value={prefs.days} onChange={(e) => update({ days: e.target.value })}>
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="365">Last year</option>
                <option value="0">Whole log</option>
              </Select>
            </Field>
            <Field label="Heard-by window" htmlFor="gm-heard" className="sm:w-36">
              <Select id="gm-heard" value={prefs.heardMinutes} onChange={(e) => update({ heardMinutes: e.target.value })}>
                <option value="15">Last 15 minutes</option>
                <option value="60">Last hour</option>
                <option value="360">Last 6 hours</option>
                <option value="1440">Last 24 hours</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Map layers">
            <LayerToggle
              on={prefs.live}
              onToggle={() => update({ live: !prefs.live })}
              shape="dot"
              colour={MAP_COLOURS.cq}
              count={liveList.length}
              title="Stations decoded in the last 15 minutes. Green ones are calling CQ."
            >
              Live decodes
            </LayerToggle>
            <LayerToggle
              on={prefs.worked}
              onToggle={() => update({ worked: !prefs.worked })}
              shape="square"
              colour={MAP_COLOURS.worked}
              count={summary.data ? summary.data.byGrid.length : null}
              title="Every grid square worked in the log period, darker for more contacts"
            >
              Worked squares
            </LayerToggle>
            <LayerToggle
              on={prefs.logged}
              onToggle={() => update({ logged: !prefs.logged })}
              shape="bands"
              colours={loggedBands.length > 0 ? loggedBands.map((b) => b.colour) : [colourFor("40M"), colourFor("20M"), colourFor("10M")]}
              count={contacts.data ? loggedPoints.length : null}
              title="Logged contacts in the log period, coloured by band"
            >
              Logged
            </LayerToggle>
            <LayerToggle
              on={prefs.heard}
              onToggle={() => update({ heard: !prefs.heard })}
              shape="ring"
              colour={MAP_COLOURS.heard}
              count={heardBy.data ? receivers.length : null}
              title="PSKReporter receivers that heard this station in the heard-by window"
            >
              Heard by
            </LayerToggle>
            <LayerToggle
              on={prefs.greyline}
              onToggle={() => update({ greyline: !prefs.greyline })}
              shape="terminator"
              colour={MAP_COLOURS.terminator}
              title="Day and night now, with the twilight band — the greyline — computed from the clock"
            >
              Greyline
            </LayerToggle>
          </div>

          {summary.error && !noStationGrid && <ErrorBanner>Worked squares: {summary.error.message}</ErrorBanner>}
          {contacts.error && <ErrorBanner>Logged contacts: {contacts.error.message}</ErrorBanner>}
          {heardBy.error && <ErrorBanner>Heard by: {heardBy.error.message}</ErrorBanner>}
          {prefs.heard && heardBy.data?.collector.detail && (
            <p className="text-sm text-warn">{heardBy.data.collector.detail}</p>
          )}

          {/* Edge to edge on a phone, where the page gutter is 32px of a 371px screen. */}
          <section className="bg-surface border border-line shadow-panel overflow-hidden -mx-4 border-x-0 rounded-none sm:mx-0 sm:border-x sm:rounded-md">
            <WorldMap
              scene={scene}
              centreLon={home?.lon ?? null}
              onPick={onPick}
              onHover={onHover}
              label="World map of live decodes, worked squares, contacts and reception reports"
            />
            <div className="px-3 py-2 border-t border-line text-sm min-h-10 flex flex-wrap items-center gap-x-3 gap-y-1" aria-live="polite">
              {target && pathInfo && home ? (
                <>
                  <span className="font-display tracking-wide">{target.callsign}</span>
                  <span className="text-fg-subtle">
                    {home.grid} → {target.grid ?? "logged"}
                  </span>
                  <span className="tnum">{formatDistance(pathInfo.short.km, unit)}</span>
                  <span className="tnum">{formatBearing(pathInfo.short.bearing)}</span>
                  <span className="tnum text-fg-subtle">
                    long path {formatBearing(pathInfo.long.bearing)} · {formatDistance(pathInfo.long.km, unit)}
                  </span>
                </>
              ) : target ? (
                <span className="text-fg-muted">
                  {target.callsign} — paths need this station&apos;s grid square.{" "}
                  <Link href="/stations" className="text-accent-bright hover:underline">
                    Set it on Stations
                  </Link>
                </span>
              ) : noStationGrid && !home ? (
                <span className="text-fg-muted">
                  No station grid square is set, so there is no home marker and no paths.{" "}
                  <Link href="/stations" className="text-accent-bright hover:underline">
                    Set it on Stations
                  </Link>
                </span>
              ) : (
                <span className="text-fg-subtle">
                  {home ? `Your station is the ringed cross in ${home.grid}. ` : ""}
                  Hover or tap a station for its great-circle path, distance and beam heading.
                </span>
              )}
            </div>
          </section>

          {prefs.logged && loggedBands.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <BandKey bands={loggedBands} />
              {contacts.data?.truncated && (
                <span className="text-xs text-fg-subtle">Most recent {loggedPoints.length.toLocaleString()} shown</span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 min-w-0">
          {selected && (
            <Card
              title={<h2 className="font-display text-base text-fg tracking-wide">{selected.callsign}</h2>}
              actions={
                <button
                  type="button"
                  onClick={() => setSelectedKey(null)}
                  className="text-xs text-fg-subtle hover:text-fg"
                  aria-label="Clear selection"
                >
                  Clear
                </button>
              }
            >
              <dl className="text-sm flex flex-col gap-1.5">
                {selected.kind === "live" && (
                  <>
                    <MapRow label="Grid" value={selected.station.grid} />
                    <MapRow label="Signal" value={signed(selected.station.snr)} />
                    <MapRow label="Heard" value={`${ago(now - selected.station.at)}${selected.station.band ? ` on ${selected.station.band}` : ""}`} />
                    <MapRow label="Message" value={selected.station.message} />
                  </>
                )}
                {selected.kind === "logged" && (
                  <>
                    <MapRow label="Logged" value={`${selected.point.band} ${selected.point.mode}`} />
                    <MapRow label="On" value={new Date(selected.point.at).toISOString().slice(0, 16).replace("T", " ") + " UTC"} />
                  </>
                )}
                {selected.kind === "heard" && (
                  <>
                    <MapRow label="Grid" value={selected.grid} />
                    <MapRow label="Heard us" value={selected.receiver.bestSnr !== null ? `best ${signed(selected.receiver.bestSnr)}` : "no report"} />
                    <MapRow label="Reports" value={`${selected.receiver.reports.toLocaleString()}${selected.receiver.band ? ` on ${selected.receiver.band}` : ""}`} />
                    <MapRow label="Last" value={ago(now - Date.parse(selected.receiver.lastAt))} />
                  </>
                )}
                {home && (
                  <>
                    <MapRow label="Distance" value={formatDistance(paths(home, selected.at).short.km, unit)} />
                    <MapRow label="Beam" value={`${formatBearing(paths(home, selected.at).short.bearing)} (long ${formatBearing(paths(home, selected.at).long.bearing)})`} />
                  </>
                )}
              </dl>
              <Link
                href={`/qsos?q=${encodeURIComponent(selected.callsign)}`}
                className="mt-3 inline-block text-sm text-accent-bright hover:underline"
              >
                View {selected.callsign}&apos;s QSOs →
              </Link>
              {selected.kind === "live" && selected.station.isCq && (
                <p className="mt-3 pt-3 border-t border-line text-sm">
                  <Link href="/decodes" className="text-accent-bright hover:underline">
                    Calling CQ — work them from the Digital page →
                  </Link>
                </p>
              )}
            </Card>
          )}

          <Card title={`Calling CQ (${cqs.length})`}>
            {cqs.length === 0 ? (
              // AN EMPTY LIST HAS THREE CAUSES AND ONLY ONE OF THEM IS THE BAND.
              //
              // "Nobody in the last 15 minutes. CQs appear here the moment they decode." was
              // said in all three, and it is a claim about the air — the one an operator acts
              // on, by going to look at an antenna. It is true only when decodes are actually
              // arriving and none of them is a CQ.
              //
              // Ordered by what to fix first, the same rule as `collectorState` in
              // pages/api/psk-spots.ts: a closed socket outranks a silent one, because a
              // silent socket cannot be diagnosed until there is a socket.
              !connected ? (
                <p className="text-sm text-warn">
                  Not connected to the radio service, so nothing is arriving — this list stays
                  empty however busy the band is, and so does the map. It fills in on its own
                  when the connection comes back.
                </p>
              ) : liveList.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  Connected, and nothing at all has decoded in the last 15 minutes
                  {prefs.band ? ` on ${prefs.band}` : ""} — not just no CQs. That is as likely to
                  be a receiver that is not decoding as a quiet band; the{" "}
                  <Link href="/decodes" className="text-accent-bright hover:underline">
                    Digital page
                  </Link>{" "}
                  says which.
                </p>
              ) : (
                <p className="text-sm text-fg-subtle">
                  Nobody calling CQ in the last 15 minutes — but {liveList.length} station
                  {liveList.length === 1 ? " has" : "s have"} decoded in that time, so this
                  one is a fact about the band and not about the receiver.
                </p>
              )
            ) : (
              <ul className="flex flex-col divide-y divide-line -mx-4 max-h-[24rem] overflow-auto">
                {cqs.map((s) => {
                  const key = `d:${s.callsign}`;
                  const km = home ? paths(home, s).short.km : null;
                  return (
                    <li key={s.callsign}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(key === selectedKey ? null : key)}
                        onMouseEnter={() => setHoverKey(key)}
                        onMouseLeave={() => setHoverKey(null)}
                        aria-pressed={key === selectedKey}
                        className={cn(
                          "w-full flex items-center gap-2 px-4 py-1.5 text-sm text-left hover:bg-surface-2",
                          key === selectedKey && "bg-surface-2",
                        )}
                      >
                        <span className="font-display tracking-wide">{s.callsign}</span>
                        <span className="text-xs text-fg-subtle">{s.grid}</span>
                        {km !== null && <span className="tnum text-xs text-fg-subtle">{formatDistance(km, unit)}</span>}
                        <span className="tnum ml-auto text-fg-muted">{s.snr > 0 ? `+${s.snr}` : s.snr} dB</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function MapRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="text-fg-subtle shrink-0">{label}</dt>
      <dd className="ml-auto text-right break-all">{value}</dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  inner: async (ctx: GetServerSidePropsContext) => {
    const { wsUrl } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl } };
  },
});

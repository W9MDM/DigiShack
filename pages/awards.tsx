import Link from "next/link";
import { useMemo, useState } from "react";

import { CardTable } from "@/components/dashboard/CardTable";
import { plural } from "@/components/dashboard/format";
import { Loading, Notice } from "@/components/dashboard/Notice";
import { MeterKey, MeterLegend, ProgressMeter } from "@/components/dashboard/ProgressMeter";
import { Segmented } from "@/components/dashboard/Segmented";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  Td,
  Th,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { BAND_NAMES } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";
import type { ListResponse, Station } from "@/lib/types";
import { cn } from "@/lib/utils";

// Award progress, as a summary first: every award on one screen with its meter, and the
// codes behind each one a click away. It used to be six tall cards in a row, each a wall
// of chips, so comparing DXCC with WAS meant scrolling past four hundred entities.

interface AwardSlice {
  worked: number;
  confirmed: number;
}

interface AwardProgress {
  id: string;
  label: string;
  unit: string;
  total: number | null;
  worked: number;
  confirmed: number;
  /** Codes still needed, with names where the dimension has them. */
  missing: { code: string; name?: string }[] | null;
  totalUnreliable: boolean;
  entries: { code: string; label?: string; confirmed: boolean; count: number }[];
  byBand: Record<string, AwardSlice>;
  byMode: Record<string, AwardSlice>;
}

interface AwardsResult {
  qsoCount: number;
  confirmedQsoCount: number;
  dxccTotal: number | null;
  awards: AwardProgress[];
  generatedAt: string;
}

export default function AwardsPage() {
  const [stationId, setStationId] = useState("");
  const [band, setBand] = useState("");
  const [mode, setMode] = useState("");

  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (stationId) p.set("stationId", stationId);
    if (band) p.set("band", band);
    if (mode) p.set("mode", mode);
    const qs = p.toString();
    return `/api/awards${qs ? `?${qs}` : ""}`;
  }, [stationId, band, mode]);

  const { data, error, loading } = useApi<AwardsResult>(path);
  const { data: stationsData } = useApi<ListResponse<Station>>("/api/stations");
  const filtered = Boolean(stationId || band || mode);
  const clear = () => {
    setStationId("");
    setBand("");
    setMode("");
  };

  return (
    <>
      {/* The subtitle used to say "confirmed by card, LoTW or eQSL", but this count has
          never included eQSL — lib/awards/compute.ts leaves it out because ARRL and CQ
          do not accept it. The page now says what it counts. */}
      <PageHeader
        title="Awards"
        subtitle={
          data
            ? `${plural(data.qsoCount, "QSO")} · ${data.confirmedQsoCount.toLocaleString()} confirmed by card or LoTW`
            : "DXCC, states, zones, continents, grids and islands"
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
        <Field label="Station" htmlFor="awards-station" className="col-span-2 sm:col-span-1">
          <Select
            id="awards-station"
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
          >
            <option value="">All stations</option>
            {(stationsData?.rows ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.callsign}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Band" htmlFor="awards-band">
          <Select id="awards-band" value={band} onChange={(e) => setBand(e.target.value)}>
            <option value="">All bands</option>
            {BAND_NAMES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mode" htmlFor="awards-mode">
          <Select id="awards-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">All modes</option>
            {LOGGABLE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        {filtered && (
          <Button variant="ghost" onClick={clear} className="col-span-2 justify-self-start sm:col-span-1">
            Clear filters
          </Button>
        )}
      </div>
      <p className="mb-6 text-sm text-fg-subtle">
        Confirmed means a paper card or LoTW. eQSL is kept in the log, but ARRL and CQ do not
        accept it for these awards, so it is not counted here.
      </p>

      {error && (
        <div className="mb-6">
          <ErrorBanner>
            {error.message}
            {data ? " — showing the last figures that loaded." : " Retrying on its own."}
          </ErrorBanner>
        </div>
      )}

      {!data && !error && <Loading>Counting awards…</Loading>}

      {data && data.dxccTotal === null && (
        <Notice tone="warn" className="mb-6">
          No DXCC reference data is loaded, so DXCC has a count but no target.{" "}
          <Link href="/dxcc" className="underline underline-offset-2">
            Load cty.xml
          </Link>{" "}
          to get one.
        </Notice>
      )}

      {data &&
        (data.qsoCount === 0 ? (
          <Card>
            <EmptyState
              title={filtered ? "No contacts match these filters" : "Nothing logged yet"}
              action={filtered ? <Button onClick={clear}>Clear filters</Button> : undefined}
            >
              {filtered
                ? "Award progress is counted from the contacts the filters select."
                : "Award progress appears once the log has contacts in it."}
            </EmptyState>
          </Card>
        ) : (
          <Card
            title="Progress"
            actions={
              loading ? (
                <span role="status" className="text-xs text-fg-subtle">
                  Updating…
                </span>
              ) : undefined
            }
          >
            <div className={cn("transition-opacity", loading && "opacity-60")} aria-busy={loading}>
              <MeterKey />
              <ul className="-mx-4 mt-3 divide-y divide-line border-t border-line">
                {data.awards.map((award) => (
                  <AwardRow key={award.id} award={award} />
                ))}
              </ul>
            </div>
          </Card>
        ))}
    </>
  );
}

/** The total worth drawing against — none when the reference data is known to be short. */
const targetOf = (a: AwardProgress) =>
  a.total !== null && a.total > 0 && !a.totalUnreliable ? a.total : null;

function AwardRow({ award }: { award: AwardProgress }) {
  // The detail renders only while open: the grid award alone can be thousands of chips.
  const [open, setOpen] = useState(false);
  const target = targetOf(award);

  return (
    <li>
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="group"
      >
        {/* Spans throughout: <summary> takes phrasing content only. */}
        <summary className="flex cursor-pointer list-none flex-col gap-2 px-4 py-3 transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
          <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="flex items-baseline gap-2">
              <svg
                viewBox="0 0 12 12"
                aria-hidden="true"
                className="size-3 shrink-0 self-center text-fg-subtle transition-transform group-open:rotate-90"
              >
                <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span className="font-display text-base text-fg">{award.label}</span>
              <span className="text-xs text-fg-subtle">{award.unit}</span>
            </span>
            <span className="text-sm tnum text-fg-muted">
              <span className="text-fg">{award.confirmed.toLocaleString()}</span> confirmed ·{" "}
              <span className="text-fg">{award.worked.toLocaleString()}</span> worked
              {target !== null && ` · of ${target.toLocaleString()}`}
            </span>
          </span>
          <ProgressMeter worked={award.worked} confirmed={award.confirmed} total={target} />
          {award.totalUnreliable && (
            <span className="text-xs text-warn">
              {award.worked.toLocaleString()} worked is more than the {award.total} in the
              reference data, so its target is out of date. The counts are still right.
            </span>
          )}
          {award.total === null && (
            <span className="text-xs text-fg-subtle">No fixed total for this award.</span>
          )}
        </summary>
        {open && <AwardDetail award={award} />}
      </details>
    </li>
  );
}

type DetailTab = "worked" | "missing" | "bands";

/** Low bands first, as a band list is read; anything unrecognised after them. */
function bandRank(b: string): number {
  const i = BAND_NAMES.indexOf(b.toUpperCase());
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function AwardDetail({ award }: { award: AwardProgress }) {
  const [tab, setTab] = useState<DetailTab>("worked");
  const target = targetOf(award);

  const bands = Object.entries(award.byBand).sort(
    (a, b) => bandRank(a[0]) - bandRank(b[0]) || a[0].localeCompare(b[0]),
  );

  const options: { value: DetailTab; label: string }[] = [
    { value: "worked", label: `Worked (${award.worked.toLocaleString()})` },
    ...(award.missing
      ? [{ value: "missing" as const, label: `Missing (${award.missing.length.toLocaleString()})` }]
      : []),
    { value: "bands", label: `By band (${bands.length})` },
  ];

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <MeterLegend
        worked={award.worked}
        confirmed={award.confirmed}
        total={target}
        unit={award.unit}
      />
      {award.totalUnreliable && (
        <p className="text-sm text-warn">
          Reload cty.xml on the{" "}
          <Link href="/dxcc" className="underline underline-offset-2">
            DXCC page
          </Link>{" "}
          to bring the target up to date.
        </p>
      )}

      <Segmented
        value={tab}
        options={options}
        onChange={setTab}
        label={`${award.label} detail`}
        className="self-start"
      />

      {tab === "worked" &&
        (award.entries.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            Nothing worked yet — contacts need this field filled in to count.
          </p>
        ) : (
          <>
            <p className="text-xs text-fg-subtle">
              Green is confirmed; grey is worked and waiting for a card or LoTW.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {award.entries.map((e) => (
                <li
                  key={e.code}
                  title={`${e.label ?? e.code} — ${plural(e.count, "QSO")}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs",
                    e.confirmed
                      ? "border-ok/35 bg-ok/12 text-ok"
                      : "border-line-strong bg-surface-3 text-fg-muted",
                  )}
                >
                  <span className="tnum">{e.code}</span>
                  {e.label && <span className="max-w-40 truncate">{e.label}</span>}
                  <span className="sr-only">{e.confirmed ? ", confirmed" : ", not confirmed"}</span>
                </li>
              ))}
            </ul>
          </>
        ))}

      {tab === "missing" &&
        award.missing &&
        (award.missing.length === 0 ? (
          <p className="text-sm text-ok">Complete — nothing missing.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {award.missing.map((m) => (
              <li
                key={m.code}
                className="inline-flex items-center gap-1 rounded-sm border border-line-strong px-1.5 py-0.5 text-xs text-fg-muted"
              >
                <span className="tnum">{m.code}</span>
                {m.name && <span className="max-w-40 truncate">{m.name}</span>}
              </li>
            ))}
          </ul>
        ))}

      {tab === "bands" && <BandTable award={award} bands={bands} target={target} />}
    </div>
  );
}

function BandTable({
  award,
  bands,
  target,
}: {
  award: AwardProgress;
  bands: [string, AwardSlice][];
  target: number | null;
}) {
  if (bands.length === 0) {
    return <p className="text-sm text-fg-subtle">Nothing worked on any band yet.</p>;
  }
  // Every band's bar runs to the same length, so bands compare: the award's target where
  // it has one, otherwise everything worked on all bands together.
  const scale = target ?? Math.max(1, award.worked);

  return (
    <>
      <p className="text-xs text-fg-subtle">
        Each bar runs to{" "}
        {target !== null
          ? `the award's ${target.toLocaleString()} ${award.unit}`
          : `the ${award.worked.toLocaleString()} ${award.unit} worked on any band`}
        .
      </p>
      <CardTable label={`${award.label} by band`}>
        <thead>
          <tr className="bg-surface-2 text-left">
            <Th>Band</Th>
            <Th className="text-right">Confirmed</Th>
            <Th className="text-right">Worked</Th>
            <Th className="w-full">
              <span className="sr-only">Progress</span>
            </Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {bands.map(([b, slice]) => (
            <tr key={b}>
              <Td className="whitespace-nowrap text-fg-muted">{b}</Td>
              <Td className="text-right tnum">{slice.confirmed.toLocaleString()}</Td>
              <Td className="text-right tnum text-fg-muted">{slice.worked.toLocaleString()}</Td>
              <Td className="min-w-24">
                <ProgressMeter worked={slice.worked} confirmed={slice.confirmed} total={scale} />
              </Td>
            </tr>
          ))}
        </tbody>
      </CardTable>
    </>
  );
}

export const getServerSideProps = withPageAuth();

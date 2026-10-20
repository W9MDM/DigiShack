// Where this station's contacts are, drawn as bearing and distance from home.
//
// NOT a world map, deliberately — /gridmap is that. "Which way does my antenna work, and how
// far?" is a bearing and a distance, and a polar plot shows it in one glance: a dead sector
// is a wedge with nothing in it, and here it is shaded.

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { CoveragePlot, type PlotDot } from "@/components/maps/CoveragePlot";
import { BandKey } from "@/components/maps/Legend";
import { Card, EmptyState, ErrorBanner, Field, PageHeader, Select } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { useDistanceUnit } from "@/lib/client/use-distance-unit";
import { colourFor } from "@/lib/ham/band-colours";
import { BAND_NAMES } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";
import { formatBearing, formatDistance } from "@/lib/maps/geodesy";
import { bandsPresent } from "@/lib/maps/legend";
import { polarXY } from "@/lib/maps/polar";

interface Point {
  bearing: number;
  km: number;
  band: string;
  mode: string;
  callsign: string;
  continent: string | null;
  at: string;
}

interface MapResponse {
  home: { grid: string; lat: number; lon: number } | null;
  points: Point[];
  unplaceable: number;
  total: number;
  furthest: { callsign: string; km: number; bearing: number } | null;
  byContinent: { continent: string; count: number }[];
  bySector: { from: number; count: number; furthestKm: number }[];
  truncated: boolean;
}

export default function MapPage() {
  const [band, setBand] = useState("");
  const [mode, setMode] = useState("");
  const [days, setDays] = useState("0");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [unit] = useDistanceUnit();

  const params = new URLSearchParams();
  if (band) params.set("band", band);
  if (mode) params.set("mode", mode);
  if (days !== "0") params.set("days", days);
  const { data, error, loading } = useApi<MapResponse>(`/api/qso-map?${params}`);

  const keyed = useMemo(
    () => (data?.points ?? []).map((p, i) => ({ ...p, key: `${p.callsign}-${p.at}-${i}` })),
    [data],
  );
  const dots: PlotDot[] = useMemo(
    () => keyed.map((p) => ({ key: p.key, ...polarXY(p.bearing, p.km), colour: colourFor(p.band) })),
    [keyed],
  );
  const deadSectors = useMemo(
    () => (data && data.total > 0 ? data.bySector.filter((s) => s.count === 0).map((s) => s.from) : []),
    [data],
  );
  const bands = useMemo(() => bandsPresent(keyed), [keyed]);
  const onPick = useCallback((k: string | null) => setSelected(k), []);
  const onHover = useCallback((k: string | null) => setHovered(k), []);

  const focusKey = hovered ?? selected;
  const focus = focusKey ? keyed.find((p) => p.key === focusKey) : undefined;
  const noGrid = error?.status === 409;

  return (
    <>
      <PageHeader
        title="Coverage"
        subtitle="Every contact by bearing and distance from the station — which way the antenna works"
      />

      {/* Two to a row on a phone, each filling its half: as fixed widths they wrapped into
          a ragged 2 + 1 that stopped short of the plot's edge. */}
      <div className="grid grid-cols-2 gap-3 mb-4 sm:flex sm:flex-wrap sm:items-end">
        <Field label="Band" htmlFor="cov-band" className="sm:w-32">
          <Select id="cov-band" value={band} onChange={(e) => setBand(e.target.value)}>
            <option value="">All bands</option>
            {BAND_NAMES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mode" htmlFor="cov-mode" className="sm:w-32">
          <Select id="cov-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">All modes</option>
            {LOGGABLE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Period" htmlFor="cov-days" className="sm:w-36">
          <Select id="cov-days" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="0">Whole log</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="365">Last year</option>
          </Select>
        </Field>
      </div>

      {noGrid ? (
        <Card>
          <EmptyState
            title="No station grid square yet"
            action={
              <Link href="/stations" className="text-sm text-accent-bright hover:underline">
                Set it on Stations →
              </Link>
            }
          >
            Every bearing and distance here is measured from the station, so the plot needs its grid
            square first.
          </EmptyState>
        </Card>
      ) : error ? (
        <ErrorBanner>{error.message}</ErrorBanner>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Edge to edge on a phone: the page gutter is 32px of a 371px screen, and the
              plot is square, so the gutter cost it height as well as width. */}
          <section className="lg:col-span-2 bg-surface border border-line shadow-panel overflow-hidden -mx-4 border-x-0 rounded-none sm:mx-0 sm:border-x sm:rounded-md">
            <CoveragePlot
              dots={dots}
              unit={unit}
              deadSectors={deadSectors}
              highlight={focusKey}
              onPick={onPick}
              onHover={onHover}
            />
            <div className="px-3 py-2 border-t border-line text-sm min-h-10 flex flex-wrap items-center gap-x-3 gap-y-1" aria-live="polite">
              {focus ? (
                <>
                  <span className="font-display tracking-wide">{focus.callsign}</span>
                  <span className="text-fg-subtle">
                    {focus.band} {focus.mode}
                  </span>
                  <span className="tnum">{formatDistance(focus.km, unit)}</span>
                  <span className="tnum">{formatBearing(focus.bearing)}</span>
                  <span className="tnum text-fg-subtle">{focus.at.slice(0, 10)}</span>
                  <Link
                    href={`/qsos?q=${encodeURIComponent(focus.callsign)}`}
                    className="ml-auto text-accent-bright hover:underline"
                  >
                    View log →
                  </Link>
                </>
              ) : (
                <span className="text-fg-subtle">
                  {loading && !data
                    ? "Reading the log…"
                    : "Hover or tap a dot for the contact. Shaded wedges are directions never worked."}
                </span>
              )}
            </div>
            {bands.length > 0 && (
              <div className="px-3 pb-3">
                <BandKey bands={bands} />
              </div>
            )}
          </section>

          <div className="flex flex-col gap-6">
            <Card title="What it reaches">
              {loading || !data ? (
                <p className="text-sm text-fg-subtle">Reading the log…</p>
              ) : (
                <dl className="text-sm flex flex-col gap-1.5">
                  <Row label="Station" value={data.home?.grid ?? "—"} />
                  <Row label="Contacts" value={data.total.toLocaleString()} />
                  <Row
                    label="Furthest"
                    value={
                      data.furthest
                        ? `${data.furthest.callsign} · ${formatDistance(data.furthest.km, unit)} at ${formatBearing(data.furthest.bearing)}`
                        : "—"
                    }
                  />
                  {data.unplaceable > 0 && (
                    <Row label="No grid" value={`${data.unplaceable.toLocaleString()} not shown`} />
                  )}
                  {data.truncated && (
                    <Row label="Plotted" value={`Most recent ${data.points.length.toLocaleString()}`} />
                  )}
                </dl>
              )}
            </Card>

            <Card title="By continent">
              {!data || data.byContinent.length === 0 ? (
                <p className="text-sm text-fg-subtle">
                  Nothing resolved yet. Continents come from the DXCC lookup, so a log
                  imported without it shows none.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-line -mx-4">
                  {data.byContinent.map((c) => (
                    <li key={c.continent} className="flex px-4 py-1 text-sm">
                      <span>{c.continent}</span>
                      <span className="tnum ml-auto text-fg-muted">{c.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Dead sectors">
              {!data ? null : (
                <>
                  <p className="text-sm text-fg-subtle mb-2">
                    Sixteen sectors of 22.5°. An empty one is a direction this station has
                    never worked — which is either the antenna, the terrain, or nobody
                    being there.
                  </p>
                  <ul className="flex flex-col divide-y divide-line -mx-4">
                    {data.bySector
                      .filter((s) => s.count === 0)
                      .map((s) => (
                        <li key={s.from} className="flex px-4 py-1 text-sm">
                          <span className="tnum">
                            {s.from}°–{Math.round(s.from + 22.5)}°
                          </span>
                          <span className="ml-auto text-fg-subtle">nothing</span>
                        </li>
                      ))}
                    {data.bySector.every((s) => s.count > 0) && (
                      <li className="px-4 py-1 text-sm text-ok">Every direction worked at least once.</li>
                    )}
                  </ul>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="text-fg-subtle shrink-0">{label}</dt>
      <dd className="ml-auto text-right">{value}</dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth();

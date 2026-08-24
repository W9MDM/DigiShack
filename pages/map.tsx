// Where this station's contacts are, drawn as bearing and distance from home.
//
// NOT a world map, deliberately. A basemap means either a tile service — a cloud
// dependency in an application whose whole point is not having one — or vendoring a
// coastline dataset, and neither answers the question an operator actually has. "Which
// way does my antenna work, and how far?" is a bearing and a distance, and a polar plot
// shows it in one glance: a dead sector is a wedge with nothing in it.
//
// Coastlines would make it prettier and would not make it say more. If the day comes that
// somebody wants the pretty version, this page is the data source for it.

import { useMemo, useState } from "react";

import { Card, PageHeader, Select } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { colourFor } from "@/lib/ham/band-colours";
import { BAND_NAMES } from "@/lib/ham/bands";

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

/** Distance rings, km. The outermost is a little over half the Earth's circumference. */
const RINGS = [2_500, 5_000, 10_000, 20_000];
const MAX_KM = 20_000;


/** Radius on a square-root scale, so the near-in contacts are not a single blob. */
function radiusFor(km: number, size: number): number {
  const capped = Math.min(km, MAX_KM);
  return (Math.sqrt(capped / MAX_KM) * size) / 2;
}

export default function MapPage() {
  const [band, setBand] = useState("");
  const [mode, setMode] = useState("");
  const [days, setDays] = useState("0");

  const params = new URLSearchParams();
  if (band) params.set("band", band);
  if (mode) params.set("mode", mode);
  if (days !== "0") params.set("days", days);
  const { data, error, loading } = useApi<MapResponse>(`/api/qso-map?${params}`);

  const size = 560;
  const centre = size / 2;

  const dots = useMemo(() => {
    if (!data) return [];
    return data.points.map((p, i) => {
      // Screen coordinates: bearing 0 is north, which is UP, and bearings increase
      // clockwise. Straight trigonometry puts 0 to the right and increases the other way.
      const rad = ((p.bearing - 90) * Math.PI) / 180;
      const r = radiusFor(p.km, size);
      return {
        key: `${p.callsign}-${p.at}-${i}`,
        x: centre + r * Math.cos(rad),
        y: centre + r * Math.sin(rad),
        colour: colourFor(p.band),
        title: `${p.callsign} · ${p.band} ${p.mode} · ${p.km.toLocaleString()} km at ${p.bearing}°`,
      };
    });
  }, [data, centre]);

  const bandsPresent = useMemo(() => {
    const seen = new Set(data?.points.map((p) => p.band.toUpperCase()) ?? []);
    // Ordered as BAND_NAMES has them — wavelength order, which is how an operator reads
    // a band list. An unknown band sorts last rather than first.
    return [...seen].sort((a, b) => {
      const ia = BAND_NAMES.indexOf(a);
      const ib = BAND_NAMES.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [data]);

  return (
    <>
      <PageHeader
        title="Coverage"
        subtitle="Every contact by bearing and distance from the station — which way the antenna works"
      />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-subtle">Band</span>
          <Select value={band} onChange={(e) => setBand(e.target.value)} className="w-28">
            <option value="">All</option>
            {BAND_NAMES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-subtle">Mode</span>
          <Select value={mode} onChange={(e) => setMode(e.target.value)} className="w-28">
            <option value="">All</option>
            <option value="FT8">FT8</option>
            <option value="FT4">FT4</option>
            <option value="SSB">SSB</option>
            <option value="CW">CW</option>
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-subtle">Period</span>
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-36">
            <option value="0">The whole log</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="365">Last year</option>
          </Select>
        </label>
      </div>

      {error && (
        <Card title="Coverage">
          <p className="text-sm text-danger">{error.message}</p>
        </Card>
      )}

      {!error && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Bearing and distance" className="lg:col-span-2">
            <div className="flex justify-center">
              <svg
                width="100%"
                viewBox={`0 0 ${size} ${size}`}
                className="max-w-[560px]"
                role="img"
                aria-label="Contacts by bearing and distance"
              >
                {/* Distance rings, labelled on the north axis. */}
                {RINGS.map((km) => (
                  <g key={km}>
                    <circle
                      cx={centre}
                      cy={centre}
                      r={radiusFor(km, size)}
                      fill="none"
                      stroke="currentColor"
                      className="text-line"
                      strokeWidth="1"
                    />
                    <text
                      x={centre + 4}
                      y={centre - radiusFor(km, size) + 12}
                      className="fill-fg-subtle"
                      fontSize="10"
                    >
                      {km.toLocaleString()} km
                    </text>
                  </g>
                ))}

                {/* Compass spokes every 45°, labelled at the cardinals. */}
                {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
                  const rad = ((deg - 90) * Math.PI) / 180;
                  const r = size / 2;
                  return (
                    <line
                      key={deg}
                      x1={centre}
                      y1={centre}
                      x2={centre + r * Math.cos(rad)}
                      y2={centre + r * Math.sin(rad)}
                      stroke="currentColor"
                      className="text-line"
                      strokeWidth="1"
                    />
                  );
                })}
                {[
                  ["N", 0],
                  ["E", 90],
                  ["S", 180],
                  ["W", 270],
                ].map(([label, deg]) => {
                  const rad = ((Number(deg) - 90) * Math.PI) / 180;
                  const r = size / 2 - 10;
                  return (
                    <text
                      key={label as string}
                      x={centre + r * Math.cos(rad)}
                      y={centre + r * Math.sin(rad) + 4}
                      textAnchor="middle"
                      className="fill-fg-muted font-display"
                      fontSize="12"
                    >
                      {label as string}
                    </text>
                  );
                })}

                {dots.map((d) => (
                  <circle key={d.key} cx={d.x} cy={d.y} r="2.5" fill={d.colour} opacity="0.75">
                    <title>{d.title}</title>
                  </circle>
                ))}

                {/* Home. Drawn last so it is never hidden under a contact. */}
                <circle cx={centre} cy={centre} r="3" className="fill-accent-bright" />
              </svg>
            </div>

            {bandsPresent.length > 1 && (
              <div className="flex flex-wrap gap-3 mt-3 text-xs">
                {bandsPresent.map((b) => (
                  <span key={b} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ background: colourFor(b) }}
                    />
                    {b}
                  </span>
                ))}
              </div>
            )}
          </Card>

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
                        ? `${data.furthest.callsign} · ${data.furthest.km.toLocaleString()} km at ${data.furthest.bearing}°`
                        : "—"
                    }
                  />
                  {data.unplaceable > 0 && (
                    <Row
                      label="No grid"
                      value={`${data.unplaceable.toLocaleString()} not shown`}
                    />
                  )}
                  {data.truncated && (
                    <Row label="Plotted" value={`${data.points.length.toLocaleString()} of them`} />
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
                      <span className="tnum ml-auto text-fg-muted">
                        {c.count.toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Dead sectors">
              {!data ? null : (
                <>
                  <p className="text-xs text-fg-subtle mb-2">
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
                      <li className="px-4 py-1 text-sm text-ok">
                        Every direction worked at least once.
                      </li>
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
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="ml-auto text-right">{value}</dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth();

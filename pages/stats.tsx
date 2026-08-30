import Link from "next/link";
import { useState } from "react";

import { Card, ErrorBanner, PageHeader, Select, Td, Th } from "@/components/ui/primitives";
import { HelpTip } from "@/components/ui/HelpTip";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";

// What this station has done, as opposed to what it is doing.
//
// The dashboard answers today, yesterday, this week and what was new. Those are operating
// numbers. These are the ones an operator opens on a quiet evening — contacts a year, who
// they have worked most, which continents — and the Cloudlog audit named per-year and
// most-worked as the two people actually look at.

interface YearRow {
  year: number;
  qsos: number;
  confirmed: number;
  callsigns: number;
  entities: number;
}

interface WorkedRow {
  callsign: string;
  qsos: number;
  firstWorked: string;
  lastWorked: string;
  bands: number;
}

interface CountRow {
  label: string;
  qsos: number;
}

interface History {
  years: YearRow[];
  mostWorked: WorkedRow[];
  continents: CountRow[];
  modes: CountRow[];
  bands: CountRow[];
  totals: {
    qsos: number;
    confirmed: number;
    callsigns: number;
    entities: number;
    firstQso: string | null;
    lastQso: string | null;
  };
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

/**
 * A proportional bar behind a row.
 *
 * Scaled against the LARGEST value in the group rather than the total. Against the total, a
 * log dominated by one mode — which every FT8 station is — renders every other row as a bar
 * one pixel wide, and the comparison people want from these tables is between the small
 * values, not between each and the winner.
 */
function Bar({ value, max, children }: { value: number; max: number; children: React.ReactNode }) {
  const w = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <div className="relative px-2 py-1">
      <div
        className="absolute inset-y-0 left-0 bg-accent/15 rounded-sm"
        style={{ width: `${w}%` }}
        aria-hidden
      />
      <div className="relative flex justify-between gap-3 text-sm">{children}</div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  help,
}: {
  title: string;
  rows: CountRow[];
  help: string;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.qsos), 0);
  const total = rows.reduce((s, r) => s + r.qsos, 0);
  return (
    <Card title={title}>
      <p className="text-xs text-fg-subtle mb-2">{help}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle">Nothing logged yet.</p>
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => (
            <Bar key={r.label} value={r.qsos} max={max}>
              <span className="font-mono">{r.label}</span>
              <span className="tnum text-fg-muted">
                {r.qsos.toLocaleString()}
                <span className="text-fg-subtle"> · {pct(r.qsos, total)}</span>
              </span>
            </Bar>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function StatsPage() {
  const [top, setTop] = useState("25");
  const { data, error } = useApi<History>(`/api/stats/history?top=${top}`);

  const years = data?.years ?? [];
  const peakYear = years.reduce((m, y) => Math.max(m, y.qsos), 0);
  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Statistics"
        subtitle={
          t?.firstQso
            ? `${t.qsos.toLocaleString()} contacts, ${formatUtc(t.firstQso).slice(0, 10)} to ${formatUtc(t.lastQso ?? t.firstQso).slice(0, 10)}`
            : "Everything this station has worked"
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {!data && !error && <p className="text-sm text-fg-subtle">Reading the log…</p>}

      {data && (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Contacts", value: t!.qsos },
              { label: "Confirmed", value: t!.confirmed, of: t!.qsos },
              { label: "Unique callsigns", value: t!.callsigns },
              { label: "DXCC entities", value: t!.entities },
            ].map((c) => (
              <Card key={c.label} title={c.label}>
                <div className="text-2xl tnum">{c.value.toLocaleString()}</div>
                {c.of !== undefined && (
                  <div className="text-xs text-fg-subtle">{pct(c.value, c.of)} of the log</div>
                )}
              </Card>
            ))}
          </div>

          <Card title="By year">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left">
                    {["Year", "Contacts", "Confirmed", "Stations", "Entities"].map((h) => (
                      <Th key={h}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {years.map((y) => (
                    // A silent year is dimmed rather than omitted: the gap is part of the
                    // history, and a table that leaves it out reads as continuous activity.
                    <tr key={y.year} className={y.qsos === 0 ? "opacity-45" : ""}>
                      <Td className="tnum font-medium">{y.year}</Td>
                      <Td>
                        {/* The bar is scaled to the busiest year, so a quiet one reads as
                            quiet rather than as almost-nothing. */}
                        <div className="relative">
                          <div
                            className="absolute inset-y-0 left-0 bg-accent/20 rounded-sm"
                            style={{ width: `${peakYear ? (y.qsos / peakYear) * 100 : 0}%` }}
                            aria-hidden
                          />
                          <span className="relative tnum">{y.qsos.toLocaleString()}</span>
                        </div>
                      </Td>
                      <Td className="tnum text-fg-muted">
                        {y.confirmed.toLocaleString()}
                        <span className="text-fg-subtle"> · {pct(y.confirmed, y.qsos)}</span>
                      </Td>
                      <Td className="tnum text-fg-muted">
                        {y.callsigns.toLocaleString()}
                      </Td>
                      <Td className="tnum text-fg-muted">{y.entities}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Breakdown
              title="By mode"
              rows={data.modes}
              help="Every contact ever logged, by mode."
            />
            <Breakdown
              title="By band"
              rows={data.bands}
              help="Bars are scaled to the busiest band, not to the total."
            />
            <Breakdown
              title="By continent"
              rows={data.continents}
              help="A dash is a contact whose entity was never resolved — worth knowing, so it is shown rather than hidden."
            />
          </div>

          <Card
            title="Most worked"
            actions={
              <label className="flex items-center gap-2 text-xs text-fg-subtle">
                Show
                <Select value={top} onChange={(e) => setTop(e.target.value)} className="w-20">
                  {["10", "25", "50", "100"].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
            }
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-fg-subtle">
                Stations worked most often, with the span between the first and last contact.
              </span>
              <HelpTip label="About most worked">
                Repeat contacts are not duplicates to be avoided — on the digital bands the
                same stations are audible for years, and a high count usually means a reliable
                path rather than an error. The band count is the more interesting number: the
                same station on eight bands is eight award credits.
              </HelpTip>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left">
                    {["Callsign", "Contacts", "Bands", "First", "Last"].map((h) => (
                      <Th key={h}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.mostWorked.map((w) => (
                    <tr key={w.callsign}>
                      <Td>
                        {/* To their history rather than to the filtered log: the next
                            question after "who have I worked most" is "on what, and is it
                            confirmed", which the log's date-ordered rows answer badly. The
                            history page links on to the log for anyone who wants the rows. */}
                        <Link
                          href={`/calls/${encodeURIComponent(w.callsign)}`}
                          className="font-display tracking-wide hover:text-accent-bright"
                        >
                          {w.callsign}
                        </Link>
                      </Td>
                      <Td className="tnum">{w.qsos.toLocaleString()}</Td>
                      <Td className="tnum text-fg-muted">{w.bands}</Td>
                      <Td className="tnum text-fg-subtle whitespace-nowrap">
                        {formatUtc(w.firstWorked).slice(0, 10)}
                      </Td>
                      <Td className="tnum text-fg-subtle whitespace-nowrap">
                        {formatUtc(w.lastWorked).slice(0, 10)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

export const getServerSideProps = withPageAuth();

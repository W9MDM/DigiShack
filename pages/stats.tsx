import Link from "next/link";
import { useState } from "react";

import { BarList } from "@/components/dashboard/BarList";
import { CardTable } from "@/components/dashboard/CardTable";
import { pct, plural } from "@/components/dashboard/format";
import { Loading } from "@/components/dashboard/Notice";
import { Section } from "@/components/dashboard/Section";
import { HelpTip } from "@/components/ui/HelpTip";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Select,
  Td,
  Th,
} from "@/components/ui/primitives";
import { Stat } from "@/components/ui/Stat";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatUtcDate } from "@/lib/time";
import { cn } from "@/lib/utils";

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
  /** Newest first, with silent years filled in as zero rows. */
  years: YearRow[];
  /** Most contacts in one UTC day, and which day. Null on an empty log. */
  bestDay: { date: string; qsos: number } | null;
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

const TOP_OPTIONS = ["10", "25", "50", "100"] as const;

const toBars = (rows: CountRow[]) =>
  rows.map((r) => ({ key: r.label, label: r.label, value: r.qsos }));

export default function StatsPage() {
  const [top, setTop] = useState<string>("25");
  const { data, error, loading } = useApi<History>(`/api/stats/history?top=${top}`);
  const canLog = useCan("OPERATOR");

  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Statistics"
        subtitle={
          t?.firstQso
            ? `${plural(t.qsos, "contact")}, ${formatUtcDate(t.firstQso)} to ${formatUtcDate(t.lastQso ?? t.firstQso)} (UTC)`
            : "Everything this station has worked"
        }
      />

      {error && (
        <div className="mb-6">
          <ErrorBanner>
            {error.message}
            {data ? " — showing the last figures that loaded." : " Retrying on its own."}
          </ErrorBanner>
        </div>
      )}
      {!data && !error && <Loading>Reading the log…</Loading>}

      {data && t && t.qsos === 0 && (
        <Card>
          <EmptyState
            title="Nothing logged yet"
            action={
              canLog ? (
                <Link href="/qsos/new">
                  <Button variant="primary">Log a QSO</Button>
                </Link>
              ) : undefined
            }
          >
            Statistics appear once the log has contacts in it.
          </EmptyState>
        </Card>
      )}

      {data && t && t.qsos > 0 && (
        <div className="flex flex-col gap-6">
          <Totals data={data} />
          <Highlights data={data} />
          <ByYear years={data.years} />

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="By mode">
              <p className="mb-3 text-sm text-fg-subtle">Every contact ever logged, by mode.</p>
              <BarList rows={toBars(data.modes)} />
            </Card>
            <Card title="By band">
              <p className="mb-3 text-sm text-fg-subtle">
                Bars are scaled to the busiest band, not to the total.
              </p>
              <BarList rows={toBars(data.bands)} />
            </Card>
            <Card title="By continent">
              <p className="mb-3 text-sm text-fg-subtle">
                A dash is a contact whose entity was never resolved — shown rather than hidden.
              </p>
              <BarList rows={toBars(data.continents)} />
            </Card>
          </div>

          <MostWorked rows={data.mostWorked} top={top} setTop={setTop} updating={loading} />
        </div>
      )}
    </>
  );
}

function Totals({ data }: { data: History }) {
  const t = data.totals;
  // Oldest first for the sparkline; the table below runs newest first.
  const perYear = [...data.years].reverse();
  const first = perYear[0]?.year;
  const last = perYear[perYear.length - 1]?.year;

  return (
    <Section title="Totals">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Contacts"
          value={t.qsos}
          trend={perYear.length > 1 ? perYear.map((y) => y.qsos) : undefined}
          trendLabel={
            first !== undefined && last !== undefined
              ? `Contacts per year, ${first} to ${last}; the table below has the figures.`
              : undefined
          }
          hint={
            perYear.length > 1 && first !== undefined && last !== undefined
              ? `per year, ${first}–${last}`
              : undefined
          }
        />
        <Stat
          label="Confirmed"
          value={t.confirmed}
          tone="ok"
          hint={`${pct(t.confirmed, t.qsos)} of the log · card, LoTW or eQSL`}
        />
        <Stat label="Unique callsigns" value={t.callsigns} />
        <Stat label="DXCC entities" value={t.entities} href="/awards" />
      </div>
    </Section>
  );
}

/**
 * Records, apart from the totals.
 *
 * The best day used to sit on its own line above the totals for a reason that still
 * holds: it is a different KIND of number. "488" beside "30,082 contacts" invites the eye
 * to compare two things that are not comparable, so records get their own heading.
 *
 * The best day is a UTC day — every award, contest and duplicate rule here counts days in
 * UTC, and 00:00 UTC is evening local time in the Americas, so a local-day count would
 * split one evening across two days and under-report the best of them.
 */
function Highlights({ data }: { data: History }) {
  const t = data.totals;
  const bestYear = data.years.reduce<YearRow | null>(
    (best, y) => (best === null || y.qsos > best.qsos ? y : best),
    null,
  );
  const thisYear = new Date().getUTCFullYear();
  const topBand = data.bands[0];
  const mostWorked = data.mostWorked[0];

  return (
    <Section title="Highlights">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.bestDay && (
          <Stat
            label="Best day"
            value={data.bestDay.qsos}
            hint={`${data.bestDay.date} UTC · ${pct(data.bestDay.qsos, t.qsos)} of the log`}
          />
        )}
        {bestYear && bestYear.qsos > 0 && (
          <Stat
            label="Best year"
            value={bestYear.qsos}
            hint={`${bestYear.year}${bestYear.year === thisYear ? ", so far" : ""}`}
          />
        )}
        {topBand && (
          <Stat
            label="Busiest band"
            value={topBand.label}
            hint={`${plural(topBand.qsos, "contact")} · ${pct(topBand.qsos, t.qsos)}`}
          />
        )}
        {mostWorked && (
          <Stat
            label="Most worked"
            value={mostWorked.callsign}
            hint={`${plural(mostWorked.qsos, "contact")} on ${plural(mostWorked.bands, "band")}`}
            href={`/calls/${encodeURIComponent(mostWorked.callsign)}`}
          />
        )}
      </div>
    </Section>
  );
}

function ByYear({ years }: { years: YearRow[] }) {
  const peak = years.reduce((m, y) => Math.max(m, y.qsos), 0);
  const thisYear = new Date().getUTCFullYear();

  return (
    <Card title="By year">
      <CardTable>
        <thead>
          <tr className="bg-surface-2 text-left">
            <Th>Year</Th>
            <Th>Contacts</Th>
            <Th className="text-right">Confirmed</Th>
            <Th className="hidden text-right sm:table-cell">Stations</Th>
            <Th className="hidden text-right sm:table-cell">Entities</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {years.map((y) => {
            // A silent year stays in the table: the gap is part of the history, and a
            // table that leaves it out reads as continuous activity.
            const silent = y.qsos === 0;
            return (
              <tr key={y.year} className={cn(silent && "text-fg-subtle")}>
                <Td className="whitespace-nowrap tnum font-medium">
                  {y.year}
                  {y.year === thisYear && (
                    <span className="block text-xs font-normal text-fg-subtle sm:ml-1.5 sm:inline">
                      so far
                    </span>
                  )}
                </Td>
                <Td className="w-full min-w-28">
                  <div className="flex items-center gap-3">
                    <span className="w-14 shrink-0 text-right tnum">
                      {silent ? "—" : y.qsos.toLocaleString()}
                    </span>
                    {/* Scaled to the busiest year, so a quiet one reads as quiet rather
                        than as almost nothing. */}
                    <span aria-hidden="true" className="h-2 flex-1 rounded-sm bg-surface-2">
                      <span
                        className="block h-full rounded-r-sm bg-fg-subtle"
                        style={{ width: `${peak > 0 ? (y.qsos / peak) * 100 : 0}%` }}
                      />
                    </span>
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-right tnum text-fg-muted">
                  {silent ? (
                    "—"
                  ) : (
                    <>
                      {y.confirmed.toLocaleString()}
                      <span className="text-fg-subtle"> · {pct(y.confirmed, y.qsos)}</span>
                    </>
                  )}
                </Td>
                <Td className="hidden text-right tnum text-fg-muted sm:table-cell">
                  {silent ? "—" : y.callsigns.toLocaleString()}
                </Td>
                <Td className="hidden text-right tnum text-fg-muted sm:table-cell">
                  {silent ? "—" : y.entities.toLocaleString()}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </CardTable>
    </Card>
  );
}

function MostWorked({
  rows,
  top,
  setTop,
  updating,
}: {
  rows: WorkedRow[];
  top: string;
  setTop: (v: string) => void;
  updating: boolean;
}) {
  return (
    <Card
      title="Most worked"
      actions={
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          Show
          <Select value={top} onChange={(e) => setTop(e.target.value)} className="w-20">
            {TOP_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <p className="text-sm text-fg-subtle">
          Stations worked most often, with the span between the first and last contact.
        </p>
        <HelpTip label="About most worked" align="right">
          Repeat contacts are not duplicates to be avoided — on the digital bands the same
          stations are audible for years, and a high count usually means a reliable path
          rather than an error. The band count is the more interesting number: the same
          station on eight bands is eight award credits.
        </HelpTip>
      </div>
      {/* The previous rows stay up, dimmed, while a different count loads. */}
      <div className={cn("transition-opacity", updating && "opacity-60")} aria-busy={updating}>
        <CardTable>
          <thead>
            <tr className="bg-surface-2 text-left">
              <Th>Callsign</Th>
              <Th className="text-right">Contacts</Th>
              <Th className="text-right">Bands</Th>
              <Th className="hidden sm:table-cell">First</Th>
              <Th>Last</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((w) => (
              <tr key={w.callsign} className="hover:bg-surface-2">
                <Td>
                  {/* To their history rather than to the filtered log: the next question
                      after "who have I worked most" is "on what, and is it confirmed". */}
                  <Link
                    href={`/calls/${encodeURIComponent(w.callsign)}`}
                    className="font-display text-base tracking-wide hover:text-accent-bright"
                  >
                    {w.callsign}
                  </Link>
                </Td>
                <Td className="text-right tnum">{w.qsos.toLocaleString()}</Td>
                <Td className="text-right tnum text-fg-muted">{w.bands}</Td>
                <Td className="hidden whitespace-nowrap tnum text-fg-subtle sm:table-cell">
                  {formatUtcDate(w.firstWorked)}
                </Td>
                <Td className="whitespace-nowrap tnum text-fg-subtle">
                  {formatUtcDate(w.lastWorked)}
                </Td>
              </tr>
            ))}
          </tbody>
        </CardTable>
      </div>
    </Card>
  );
}

export const getServerSideProps = withPageAuth();

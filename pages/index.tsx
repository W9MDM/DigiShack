import Link from "next/link";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc } from "@/lib/time";
import type { StatsSummary } from "@/lib/types";

export default function DashboardPage() {
  const { data, error, loading } = useApi<StatsSummary>("/api/stats/summary");
  const canLog = useCan("OPERATOR");

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Logbook overview"
        actions={
          canLog ? (
            <Link href="/qsos/new">
              <Button variant="primary">Log a QSO</Button>
            </Link>
          ) : undefined
        }
      />

      {error && (
        <ErrorBanner>
          {error.status === 503
            ? "Can't reach the database. Check DATABASE_URL and that MySQL is running, then run `npm run db:deploy`."
            : error.message}
        </ErrorBanner>
      )}

      {loading && !data && (
        <p className="text-sm text-fg-subtle">Loading…</p>
      )}

      {data && (
        <div className="flex flex-col gap-6">
          {/* Two rows, because they answer different questions: how is TODAY going,
              and what does the log hold. Mixing them put "26,840 QSOs" next to
              "3 today" and made both harder to read. */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-fg-muted mb-2">
              Today
            </p>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
              {/* UTC day, matching the log rather than the wall clock. */}
              <Stat label="QSOs today" value={data.today} tone="accent" hint="since 00:00 UTC" />
              <Stat label="Yesterday" value={data.yesterday} />
              <Stat label="Last 7 days" value={data.week} />
              {/* The "new" counters mean never worked BEFORE today, not merely
                  distinct today — otherwise a daily regular would count as new
                  every day. Toned only when there is something to celebrate, so a
                  quiet day reads as quiet rather than as a wall of colour. */}
              <Stat
                label="New calls"
                value={data.newCallsToday}
                tone={data.newCallsToday > 0 ? "ok" : undefined}
                hint="never worked before"
              />
              <Stat
                label="New parks"
                value={data.newParksToday}
                tone={data.newParksToday > 0 ? "ok" : undefined}
                hint="POTA references"
              />
              <Stat
                label="New grids"
                value={data.newGridsToday}
                tone={data.newGridsToday > 0 ? "ok" : undefined}
              />
              <Stat
                label="New DXCC"
                value={data.newDxccToday}
                tone={data.newDxccToday > 0 ? "accent" : undefined}
                hint="entities"
              />
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-fg-muted mb-2">
              All time
            </p>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="QSOs" value={data.total} />
              {/* One definition across the whole application — card, LoTW or eQSL —
                  but the word alone does not say that, and each service means a
                  different thing to a different award. */}
              <Stat
                label="Confirmed"
                value={data.confirmed}
                tone="ok"
                hint="by card, LoTW or eQSL"
              />
              <Stat label="Unconfirmed" value={data.unconfirmed} />
              <Stat label="Unique calls" value={data.uniqueCallsigns} />
              <Stat label="Grids" value={data.uniqueGrids} />
              <Stat label="DXCC" value={data.uniqueDxcc} />
            </div>
          </div>

          {data.total === 0 ? (
            <Card>
              <EmptyState title="No QSOs logged yet">
                {data.stationCount === 0 ? (
                  <>
                    Start by creating a station on the{" "}
                    <Link href="/stations" className="text-accent-bright underline">
                      Stations
                    </Link>{" "}
                    page — a QSO has to be attributed to one.
                  </>
                ) : (
                  <>
                    <Link href="/qsos/new" className="text-accent-bright underline">
                      Log your first QSO
                    </Link>
                    .
                  </>
                )}
              </EmptyState>
            </Card>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card title="By band">
                <BreakdownList
                  rows={data.byBand.map((r) => ({
                    key: r.band,
                    label: r.band,
                    count: r.count,
                  }))}
                  total={data.total}
                />
              </Card>

              <Card title="By mode">
                <BreakdownList
                  rows={data.byMode.map((r) => ({
                    key: r.mode,
                    label: r.mode,
                    count: r.count,
                  }))}
                  total={data.total}
                />
              </Card>

              <Card
                title="Recent contacts"
                className="lg:col-span-2"
                actions={
                  <Link
                    href="/qsos"
                    className="text-xs text-accent-bright hover:underline"
                  >
                    View full log →
                  </Link>
                }
              >
                <ul className="divide-y divide-line">
                  {data.latest.map((q) => (
                    <li key={q.id}>
                      <Link
                        href={`/qsos/${q.id}`}
                        className="flex flex-wrap items-center gap-3 py-2 hover:bg-surface-2 -mx-2 px-2 rounded-sm"
                      >
                        <span className="font-display text-base tracking-wide w-32">
                          {q.callsign}
                        </span>
                        <Badge tone="neutral">{q.band}</Badge>
                        <Badge>{q.mode}</Badge>
                        <span className="tnum text-sm text-fg-muted">
                          {formatFreqMHz(q.freqHz)} MHz
                        </span>
                        <span className="tnum text-sm text-fg-subtle ml-auto">
                          {formatUtc(q.startTime)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone?: "ok" | "accent";
  /** Qualifier under the label, for a word that needs one. */
  hint?: string;
}) {
  return (
    <div className="bg-surface border border-line rounded-md px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-fg-subtle">
        {label}
      </p>
      <p
        className={`font-display text-2xl tnum ${
          tone === "ok" ? "text-ok" : tone === "accent" ? "text-accent-bright" : "text-fg"
        }`}
      >
        {value.toLocaleString()}
      </p>
      {hint && (
        <p className="text-[10px] text-fg-subtle mt-0.5">{hint}</p>
      )}
    </div>
  );
}

function BreakdownList({
  rows,
  total,
}: {
  rows: { key: string; label: string; count: number }[];
  total: number;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-subtle">No data.</p>;
  }
  const max = Math.max(...rows.map((r) => r.count));

  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3">
          <span className="w-16 text-sm text-fg-muted shrink-0">{r.label}</span>
          <div className="flex-1 h-3.5 bg-surface-2 rounded-sm overflow-hidden">
            <div
              className="h-full bg-accent"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
          <span className="tnum text-sm w-12 text-right">{r.count}</span>
          <span className="tnum text-xs text-fg-subtle w-12 text-right">
            {((r.count / total) * 100).toFixed(1)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

export const getServerSideProps = withPageAuth();

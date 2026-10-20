import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useRef } from "react";

import { BarList } from "@/components/dashboard/BarList";
import { CardTable } from "@/components/dashboard/CardTable";
import { pct } from "@/components/dashboard/format";
import { Loading } from "@/components/dashboard/Notice";
import { QuickLinks, type QuickLink } from "@/components/dashboard/QuickLinks";
import { MoreLink, Section } from "@/components/dashboard/Section";
import { StationPanel } from "@/components/dashboard/StationPanel";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Td,
  Th,
} from "@/components/ui/primitives";
import { Stat } from "@/components/ui/Stat";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";
import { formatAgo, formatUtc } from "@/lib/time";
import type { StatsSummary } from "@/lib/types";

// The landing page: what the station is doing, how today is going, what was just
// logged, and what the log holds — in that order, each a summary with a way onward.

const LINKS: readonly QuickLink[] = [
  {
    href: "/decodes",
    title: "Digital",
    description: "Live decodes, calling and automatic operating",
  },
  { href: "/spectrum", title: "Spectrum", description: "Panadapter and waterfall" },
  { href: "/tools", title: "Tools", description: "Lookups and station utilities" },
];

/** How often to ask whether anything new has been logged. */
const LOG_POLL_MS = 60_000;

export default function DashboardPage() {
  const { data, error, loading, reload } = useApi<StatsSummary>("/api/stats/summary");
  const canLog = useCan("OPERATOR");
  useRefetchOnNewContact(reload);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="The station, today's operating and the log"
        actions={
          canLog ? (
            <Link href="/qsos/new">
              <Button variant="primary">Log a QSO</Button>
            </Link>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-6">
        {/* Below `lg` the pair is one column anyway, so `contents` lets the links drop to
            the foot of the page: on a phone they repeat the menu and stood between the
            station and today's figures. From `lg` up, the side-by-side grid as before. */}
        <div className="contents gap-4 lg:grid lg:grid-cols-3">
          <StationPanel className="lg:col-span-2" />
          <QuickLinks links={LINKS} className="order-last lg:order-none" />
        </div>

        {error && (
          <ErrorBanner>
            {error.status === 503
              ? "Can't reach the database. Check DATABASE_URL and that MySQL is running, then run `npm run db:deploy`."
              : `${error.message}${data ? " — showing the last figures that loaded." : ""}`}
          </ErrorBanner>
        )}

        {loading && !data && !error && <Loading>Reading the log…</Loading>}

        {data && <LogOverview data={data} canLog={canLog} />}
      </div>
    </>
  );
}

/**
 * Refetch the summary when something new is logged, and not otherwise.
 *
 * The summary is a dozen queries including group-bys over the whole log, so polling it
 * would be the expensive way to keep a page that sits open in the shack current.
 * /api/stats/today is a single indexed count built to be polled; when its answer moves,
 * the summary is stale, and only then is it asked for again. Midnight UTC moves it too,
 * which is what rolls "today" over.
 */
function useRefetchOnNewContact(refetch: () => Promise<void>) {
  const { data, reload } = useApi<{ today: number; lastAt: string | null }>(
    "/api/stats/today",
  );
  useVisibleInterval(() => void reload(), LOG_POLL_MS);

  const signature = data ? `${data.today}|${data.lastAt ?? ""}` : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (signature === null) return;
    if (seen.current !== null && seen.current !== signature) void refetch();
    seen.current = signature;
  }, [signature, refetch]);
}

function LogOverview({ data, canLog }: { data: StatsSummary; canLog: boolean }) {
  const router = useRouter();

  if (data.total === 0) {
    return (
      <Card>
        <EmptyState
          title="No QSOs logged yet"
          action={
            data.stationCount === 0 ? (
              <Link href="/stations">
                <Button>Set up a station</Button>
              </Link>
            ) : canLog ? (
              <Link href="/qsos/new">
                <Button variant="primary">Log your first QSO</Button>
              </Link>
            ) : undefined
          }
        >
          {data.stationCount === 0
            ? "Every contact belongs to a station, so create one first."
            : "Contacts appear here as they are logged — by hand, from the Digital page, or from an ADIF import."}
        </EmptyState>
      </Card>
    );
  }

  const last = data.latest[0];

  return (
    <>
      <Section title="Today" description="The UTC day since 00:00Z — the day the log runs on.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <Stat
            label="QSOs today"
            value={data.today}
            tone={data.today > 0 ? "accent" : "neutral"}
            size="lg"
            hint={last ? `Last contact ${ago(last.startTime)}` : undefined}
            className="col-span-2"
          />
          <Stat label="Yesterday" value={data.yesterday} hint="the whole UTC day" />
          <Stat label="Last 7 days" value={data.week} hint="and today so far" />
          {/* "New" means never worked BEFORE today, not merely distinct today — or a
              daily regular would count as new every day. Coloured only when there is
              something to celebrate, so a quiet day reads as quiet. */}
          <Stat
            label="New calls"
            value={data.newCallsToday}
            tone={data.newCallsToday > 0 ? "ok" : "neutral"}
            hint="never worked before"
          />
          <Stat
            label="New parks"
            value={data.newParksToday}
            tone={data.newParksToday > 0 ? "ok" : "neutral"}
            hint="POTA references"
          />
          <Stat
            label="New grids"
            value={data.newGridsToday}
            tone={data.newGridsToday > 0 ? "ok" : "neutral"}
            hint="never logged before"
          />
          <Stat
            label="New DXCC"
            value={data.newDxccToday}
            tone={data.newDxccToday > 0 ? "accent" : "neutral"}
            hint="entities"
          />
        </div>
      </Section>

      <Card title="Recent contacts" actions={<MoreLink href="/qsos">Full log</MoreLink>}>
        <CardTable label="The most recent contacts in the log">
          <thead>
            <tr className="bg-surface-2 text-left">
              <Th>Time</Th>
              <Th>Callsign</Th>
              <Th>Band</Th>
              <Th>Mode</Th>
              <Th className="hidden sm:table-cell">Grid</Th>
              <Th className="hidden md:table-cell">Name</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.latest.map((q) => (
              <tr
                key={q.id}
                className="cursor-pointer hover:bg-surface-2"
                onClick={() => void router.push(`/qsos/${q.id}`)}
              >
                <Td className="whitespace-nowrap tnum text-fg-muted">
                  {/* Relative on a phone, where the full timestamp would push the
                      table sideways; the UTC time from sm up. */}
                  <span className="sm:hidden">{ago(q.startTime)}</span>
                  <span className="hidden sm:inline">{formatUtc(q.startTime)}</span>
                </Td>
                <Td>
                  <Link
                    href={`/qsos/${q.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-display text-base tracking-wide hover:text-accent-bright"
                  >
                    {q.callsign}
                  </Link>
                </Td>
                <Td>
                  <Badge size="sm">{q.band}</Badge>
                </Td>
                <Td>
                  <Badge size="sm">{q.mode}</Badge>
                </Td>
                <Td className="hidden sm:table-cell tnum text-fg-muted">
                  {q.gridSquare ?? "—"}
                </Td>
                <Td className="hidden md:table-cell max-w-56 truncate text-fg-muted">
                  {q.name ?? "—"}
                </Td>
              </tr>
            ))}
          </tbody>
        </CardTable>
      </Card>

      <Section title="All time" actions={<MoreLink href="/stats">Statistics</MoreLink>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="QSOs" value={data.total} href="/qsos" className="col-span-2 md:col-span-1" />
          {/* One definition of confirmed across the whole application. The word alone
              does not say which services count, and each means something different to
              a different award. */}
          <Stat
            label="Confirmed"
            value={data.confirmed}
            tone="ok"
            hint={`${pct(data.confirmed, data.total)} · card, LoTW or eQSL`}
          />
          <Stat label="Unique calls" value={data.uniqueCallsigns} href="/stats" />
          <Stat label="Grids" value={data.uniqueGrids} href="/gridmap" />
          <Stat label="DXCC" value={data.uniqueDxcc} hint="entities" href="/awards" />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="By band">
            <BarList
              rows={data.byBand.map((r) => ({ key: r.band, label: r.band, value: r.count }))}
              total={data.total}
              limit={8}
            />
          </Card>
          <Card title="By mode">
            <BarList
              rows={data.byMode.map((r) => ({ key: r.mode, label: r.mode, value: r.count }))}
              total={data.total}
              limit={8}
            />
          </Card>
        </div>
      </Section>
    </>
  );
}

/** "12m ago", or "just now" — never "now ago". */
function ago(iso: string): string {
  const a = formatAgo(iso);
  return a === "now" ? "just now" : `${a} ago`;
}

export const getServerSideProps = withPageAuth();

import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { LinkButton, TextLink, qrzUrl } from "@/components/log/links";
import {
  DEFAULT_LOG_QUERY,
  LOG_PAGE_SIZE,
  activeFilterCount,
  formatRange,
  isFiltered,
  logApiPath,
  logExportHref,
  logQuerySearch,
  parseLogQuery,
  rememberLogUrl,
  type LogConfirmed,
  type LogQuery,
  type LogSortField,
} from "@/components/log/log-query";
import { Pager } from "@/components/log/Pager";
import { QslBadges } from "@/components/log/QslBadges";
import { QsoListCard, qsoDistance, sigSummary } from "@/components/log/QsoListCard";
import { ResendQslButton } from "@/components/qsl/ResendQslButton";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  Td,
  Th,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { useDistanceUnit } from "@/lib/client/use-distance-unit";
import { BAND_NAMES, formatFreqMHz } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";
import { formatUtc, formatUtcDate } from "@/lib/time";
import type { ListResponse, Qso } from "@/lib/types";
import { cn } from "@/lib/utils";

// The page scrolls, not the table, so the header sticks below the app bar (Shell's h-12).
const STICKY_TH =
  "sticky top-[calc(3rem+env(safe-area-inset-top))] z-10 bg-surface-2 shadow-[inset_0_-1px_0_var(--color-line)]";
// Priority columns: the table only renders from md, and drops columns rather than scroll.
const LG = "hidden lg:table-cell";
const XL = "hidden xl:table-cell";

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "startTime:desc", label: "Newest first" },
  { value: "startTime:asc", label: "Oldest first" },
  { value: "callsign:asc", label: "Callsign A–Z" },
  { value: "callsign:desc", label: "Callsign Z–A" },
  { value: "band:asc", label: "Band" },
  { value: "mode:asc", label: "Mode" },
];

function searchOf(asPath: string): string {
  return asPath.split("#")[0]?.split("?")[1] ?? "";
}

export default function QsoLogPage() {
  const router = useRouter();
  const canLog = useCan("OPERATOR");
  const [unit, setUnit] = useDistanceUnit();

  // Every page here has getServerSideProps, so the query is known on the first render and
  // the first fetch is already the filtered one. The effect below covers a static render.
  const [query, setQuery] = useState<LogQuery>(() =>
    router.isReady ? parseLogQuery(router.query) : DEFAULT_LOG_QUERY,
  );
  const [ready, setReady] = useState(router.isReady);
  // What is in the search box. `query.q` follows it after a pause: each request is a
  // full-text scan over the whole log.
  const [qInput, setQInput] = useState(query.q);
  const [filtersOpen, setFiltersOpen] = useState(() => activeFilterCount(query) > 0);
  const listTop = useRef<HTMLDivElement | null>(null);
  // URLs this page wrote itself, so an echo of our own replace is not mistaken for a link.
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (ready || !router.isReady) return;
    const s = parseLogQuery(router.query);
    setQuery(s);
    setQInput(s.q);
    setFiltersOpen(activeFilterCount(s) > 0);
    setReady(true);
  }, [ready, router.isReady, router.query]);

  useEffect(() => {
    if (qInput === query.q) return;
    const id = setTimeout(() => setQuery((s) => ({ ...s, q: qInput, page: 0 })), 300);
    return () => clearTimeout(id);
  }, [qInput, query.q]);

  const search = logQuerySearch(query);
  const pageUrl = search ? `/qsos?${search}` : "/qsos";

  // State -> URL, so Back from a contact returns to this exact page of this exact filter.
  useEffect(() => {
    if (!ready) return;
    rememberLogUrl(pageUrl);
    if (searchOf(router.asPath) === search) return;
    pending.current.add(search);
    void router.replace(pageUrl, undefined, { shallow: true, scroll: false });
    // `router` is deliberately absent: it changes identity on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, ready]);

  // URL -> state, for a link into the log while it is already open (the nav's "Log").
  useEffect(() => {
    if (!ready) return;
    const current = searchOf(router.asPath);
    if (current === search) return;
    if (pending.current.delete(current)) return;
    pending.current.clear();
    const s = parseLogQuery(router.query);
    setQuery(s);
    setQInput(s.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.asPath, ready]);

  // "/" jumps to the search box from anywhere on the page that is not already a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      document.getElementById("log-search")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { data, error, loading, reload } = useApi<ListResponse<Qso>>(
    ready ? logApiPath(query) : null,
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
  const filtered = isFiltered(query);
  const filterCount = activeFilterCount(query);
  const initialLoading = !data && !error;
  const refreshing = loading && data !== null;

  // A URL from an old bookmark can point past the end; land on the last real page.
  useEffect(() => {
    if (!loading && data && query.page > 0 && query.page >= pageCount) {
      setQuery((s) => ({ ...s, page: pageCount - 1 }));
    }
  }, [loading, data, query.page, pageCount]);

  /** Any filter change invalidates the page offset. */
  function update(patch: Partial<LogQuery>) {
    setQuery((s) => ({ ...s, page: 0, ...patch }));
  }

  function toggleSort(field: LogSortField) {
    setQuery((s) =>
      s.sort === field
        ? { ...s, dir: s.dir === "asc" ? "desc" : "asc", page: 0 }
        : { ...s, sort: field, dir: field === "startTime" ? "desc" : "asc", page: 0 },
    );
  }

  function goToPage(page: number, scroll: boolean) {
    setQuery((s) => ({ ...s, page }));
    if (scroll) listTop.current?.scrollIntoView({ block: "start" });
  }

  function clearFilters() {
    setQInput("");
    setQuery((s) => ({ ...DEFAULT_LOG_QUERY, sort: s.sort, dir: s.dir }));
  }

  // The whole row opens the contact. Its own links and buttons keep their clicks, and a
  // drag that selected text (copying a callsign) is not a click on the row.
  function openRow(e: MouseEvent<HTMLTableRowElement>, id: string) {
    if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label")) return;
    if (window.getSelection()?.toString()) return;
    const href = `/qsos/${id}`;
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      window.open(href, "_blank", "noopener");
      return;
    }
    void router.push(href);
  }

  const subtitle = data
    ? filtered
      ? `${total.toLocaleString()} matching`
      : `${total.toLocaleString()} QSOs`
    : undefined;

  return (
    <>
      <PageHeader
        title="Log"
        subtitle={subtitle}
        actions={
          canLog ? (
            <LinkButton href="/qsos/new" variant="primary">
              New QSO
            </LinkButton>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))]">
          <div className="col-span-2 flex items-end gap-2 sm:col-span-3 xl:col-span-1">
            <Field label="Search" htmlFor="log-search" className="min-w-0 flex-1">
              <Input
                id="log-search"
                type="search"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Callsign, grid or notes"
                aria-keyshortcuts="/"
                title="Search the log (press / to jump here)"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Button
              className="sm:hidden"
              aria-expanded={filtersOpen}
              aria-controls="log-filters"
              onClick={() => setFiltersOpen((v) => !v)}
            >
              Filters
              {filterCount > 0 && (
                <Badge size="sm" tone="info">
                  {filterCount}
                </Badge>
              )}
            </Button>
          </div>

          {/* A grid of its own on a phone, where it folds away; `contents` from sm up, where
              its fields join the row above. */}
          <div
            id="log-filters"
            className={cn("col-span-2 grid grid-cols-2 gap-3 sm:contents", !filtersOpen && "hidden")}
          >
            <Field label="Band" htmlFor="log-band">
              <Select id="log-band" value={query.band} onChange={(e) => update({ band: e.target.value })}>
                <option value="">All bands</option>
                {BAND_NAMES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mode" htmlFor="log-mode">
              <Select id="log-mode" value={query.mode} onChange={(e) => update({ mode: e.target.value })}>
                <option value="">All modes</option>
                {LOGGABLE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Confirmation" htmlFor="log-confirmed" className="col-span-2 sm:col-span-1">
              <Select
                id="log-confirmed"
                value={query.confirmed}
                onChange={(e) => update({ confirmed: e.target.value as LogConfirmed })}
              >
                <option value="any">Any</option>
                <option value="yes">Confirmed (card, LoTW or eQSL)</option>
                <option value="no">Not confirmed</option>
              </Select>
            </Field>
            <Field label="From (UTC)" htmlFor="log-from">
              <Input
                id="log-from"
                type="date"
                value={query.from}
                max={query.to || undefined}
                onChange={(e) => update({ from: e.target.value })}
                className="tnum min-w-0"
              />
            </Field>
            <Field label="To (UTC)" htmlFor="log-to">
              <Input
                id="log-to"
                type="date"
                value={query.to}
                min={query.from || undefined}
                onChange={(e) => update({ to: e.target.value })}
                className="tnum min-w-0"
              />
            </Field>
            {/* The table's column headers sort from md up; below that there are none. */}
            <Field label="Sort" htmlFor="log-sort" className="col-span-2 sm:col-span-1 md:hidden">
              <Select
                id="log-sort"
                value={`${query.sort}:${query.dir}`}
                onChange={(e) => {
                  const [sort, dir] = e.target.value.split(":") as [LogSortField, "asc" | "desc"];
                  update({ sort, dir });
                }}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      <div
        ref={listTop}
        className="mb-3 flex scroll-mt-16 flex-wrap items-center gap-x-4 gap-y-2"
      >
        <p role="status" className="text-sm text-fg-muted tnum">
          {initialLoading
            ? "Loading the log…"
            : error && !data
              ? "Log unavailable"
              : total === 0
                ? "No contacts"
                : `${formatRange(query.page, total)}${filtered ? " matching" : ""}`}
        </p>
        {filtered && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        {/* Below sm, a full-width line of its own with the unit toggle at the left edge
            under the count and Export at the right, where `ml-auto` left both pushed right
            and wrapping ragged. The top pager is sm-up only. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:w-full max-sm:justify-between sm:ml-auto">
          <div role="group" aria-label="Distance unit" className="flex items-center gap-1">
            <span className="text-xs text-fg-subtle">Distance</span>
            {(["mi", "km"] as const).map((u) => (
              <Button
                key={u}
                size="sm"
                variant={unit === u ? "secondary" : "ghost"}
                aria-pressed={unit === u}
                onClick={() => setUnit(u)}
              >
                {u}
              </Button>
            ))}
          </div>
          <LinkButton href={logExportHref(query)} kind="file" size="sm" variant="ghost">
            Export this view as ADIF
          </LinkButton>
          <Pager
            page={query.page}
            pageCount={pageCount}
            onPage={(p) => goToPage(p, false)}
            label="Log pages, top"
            className="hidden sm:flex"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner>
            {error.status === 503
              ? "Can't reach the database. Check DATABASE_URL and that MySQL is running."
              : error.message}{" "}
            <Button size="sm" variant="link" className="ml-1" onClick={() => void reload()}>
              Try again
            </Button>
          </ErrorBanner>
        </div>
      )}

      {initialLoading ? (
        <LogSkeleton />
      ) : rows.length === 0 ? (
        !error && (
          <Card>
            <EmptyState
              title={filtered ? "No QSOs match" : "Nothing logged yet"}
              action={
                filtered ? (
                  <Button onClick={clearFilters}>Clear filters</Button>
                ) : canLog ? (
                  <LinkButton href="/qsos/new" variant="primary">
                    Log a QSO
                  </LinkButton>
                ) : undefined
              }
            >
              {filtered ? (
                "No contact matches these filters."
              ) : (
                <>
                  Contacts arrive here from the digital modes automatically, from{" "}
                  <TextLink href="/qsos/new">New QSO</TextLink> by hand, or from{" "}
                  <TextLink href="/adif">an ADIF import</TextLink>.
                </>
              )}
            </EmptyState>
          </Card>
        )
      ) : (
        <div
          aria-busy={refreshing || undefined}
          className={cn("transition-opacity", refreshing && "opacity-60")}
        >
          {/* In time order the cards are grouped by UTC day under a heading that sticks
              below the app bar, and each card shows its time alone: the full date on every
              card was most of what pushed its badges onto a third row. Any other order
              mixes days card to card, so it stays one list with the date on each card. */}
          {query.sort === "startTime" ? (
            <ul className="flex flex-col gap-2 md:hidden">
              {groupByDay(rows).map(([day, qsos]) => (
                <li key={day}>
                  <h2 className="sticky top-[calc(3rem+env(safe-area-inset-top))] z-15 -mx-4 bg-bg px-4 py-1.5 text-xs text-fg-subtle tnum">
                    {day}
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {qsos.map((qso) => (
                      <li key={qso.id}>
                        <QsoListCard qso={qso} unit={unit} dateless />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-2 md:hidden">
              {rows.map((qso) => (
                <li key={qso.id}>
                  <QsoListCard qso={qso} unit={unit} />
                </li>
              ))}
            </ul>
          )}

          {/* overflow-clip, not hidden: hidden makes a scroll container and the sticky
              header would stick to it instead of the viewport. */}
          <div className="hidden overflow-clip rounded-md border border-line bg-surface md:block">
            <table data-fits-viewport className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left">
                  <Th className={STICKY_TH} field="startTime" sort={query.sort} dir={query.dir} onSort={toggleSort}>
                    Time (UTC)
                  </Th>
                  <Th className={STICKY_TH} field="callsign" sort={query.sort} dir={query.dir} onSort={toggleSort}>
                    Callsign
                  </Th>
                  <Th className={STICKY_TH} field="band" sort={query.sort} dir={query.dir} onSort={toggleSort}>
                    Band
                  </Th>
                  <Th className={cn(STICKY_TH, XL)}>Freq</Th>
                  <Th className={STICKY_TH} field="mode" sort={query.sort} dir={query.dir} onSort={toggleSort}>
                    Mode
                  </Th>
                  <Th className={cn(STICKY_TH, LG)}>RST</Th>
                  <Th className={cn(STICKY_TH, LG)}>Grid</Th>
                  <Th className={cn(STICKY_TH, LG, "text-right")}>Distance</Th>
                  <Th className={cn(STICKY_TH, XL)}>Station / Op</Th>
                  <Th className={STICKY_TH}>QSL</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((qso) => {
                  const sig = sigSummary(qso);
                  const distance = qsoDistance(qso, unit);
                  return (
                    <tr
                      key={qso.id}
                      className="cursor-pointer hover:bg-surface-2 focus-within:bg-surface-2"
                      onClick={(e) => openRow(e, qso.id)}
                      onAuxClick={(e) => {
                        if (e.button === 1) openRow(e, qso.id);
                      }}
                    >
                      <Td className="tnum whitespace-nowrap text-fg-muted">
                        <time dateTime={qso.startTime}>{formatUtc(qso.startTime)}</time>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <Link
                            href={`/qsos/${qso.id}`}
                            className="font-display text-base tracking-wide text-fg underline-offset-4 hover:underline"
                          >
                            {qso.callsign}
                          </Link>
                          <a
                            href={qrzUrl(qso.callsign)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline"
                          >
                            QRZ<span aria-hidden="true">↗</span>
                            <span className="sr-only">
                              , {qso.callsign} on QRZ.com (opens in a new tab)
                            </span>
                          </a>
                          {/* A park is a property of the station worked, so it rides beside
                              the call; several parks show as a count, full list in the title. */}
                          {sig && (
                            <span className="tnum text-xs text-fg-subtle" title={sig.title}>
                              {sig.text}
                              {sig.extra > 0 && <span className="text-fg-muted"> +{sig.extra}</span>}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        {/* Neutral: every row has a band, so an accent here would mean nothing. */}
                        <Badge size="sm">{qso.band}</Badge>
                      </Td>
                      <Td className={cn(XL, "tnum whitespace-nowrap text-fg-muted")}>
                        {formatFreqMHz(qso.freqHz)}
                      </Td>
                      <Td>
                        <Badge size="sm">{qso.mode}</Badge>
                      </Td>
                      <Td className={cn(LG, "tnum whitespace-nowrap text-fg-muted")}>
                        {qso.rstSent ?? "—"} / {qso.rstRcvd ?? "—"}
                      </Td>
                      <Td className={cn(LG, "tnum text-fg-muted")}>{qso.gridSquare ?? "—"}</Td>
                      <Td className={cn(LG, "tnum whitespace-nowrap text-right text-fg-muted")}>
                        {distance ?? "—"}
                      </Td>
                      <Td className={cn(XL, "whitespace-nowrap text-fg-muted")}>
                        {qso.station.callsign}
                        {qso.operator && (
                          <span className="text-fg-subtle"> / {qso.operator.callsign}</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <QslBadges qso={qso} />
                          <ResendQslButton qsoId={qso.id} callsign={qso.callsign} />
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pageCount > 1 && rows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-fg-subtle tnum">{formatRange(query.page, total)}</span>
          <Pager
            page={query.page}
            pageCount={pageCount}
            onPage={(p) => goToPage(p, true)}
            label="Log pages, bottom"
          />
        </div>
      )}
    </>
  );
}

/** Consecutive rows that share a UTC day, in the order given. */
function groupByDay(rows: Qso[]): [string, Qso[]][] {
  const out: [string, Qso[]][] = [];
  for (const qso of rows) {
    const day = formatUtcDate(qso.startTime);
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(qso);
    else out.push([day, [qso]]);
  }
  return out;
}

function LogSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="flex flex-col gap-2 md:hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-md border border-line bg-surface" />
        ))}
      </div>
      <div className="hidden rounded-md border border-line bg-surface p-3 md:flex md:flex-col md:gap-3">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="h-5 animate-pulse rounded-sm bg-surface-2" />
        ))}
      </div>
    </div>
  );
}

export const getServerSideProps = withPageAuth();

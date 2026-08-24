import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";

import { ResendQslButton } from "@/components/qsl/ResendQslButton";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { BAND_NAMES, formatFreqMHz } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";
import { formatUtc } from "@/lib/time";
import type { ListResponse, Qso } from "@/lib/types";

type SortField = "startTime" | "callsign" | "band" | "mode";

const PAGE_SIZE = 50;

export default function QsoLogPage() {
  const router = useRouter();
  const canLog = useCan("OPERATOR");
  const [q, setQ] = useState("");
  // The value actually sent. Typing fires a request per keystroke otherwise, and
  // each one is a full-text scan over 26,000 rows.
  const [debouncedQ, setDebouncedQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [band, setBand] = useState("");
  const [mode, setMode] = useState("");
  const [confirmed, setConfirmed] = useState("any");
  const [sort, setSort] = useState<SortField>("startTime");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);

  // Seed the search from the URL, so `/qsos?q=W1ABC` opens the log filtered to them.
  //
  // The box was React state only and ignored the query string entirely, which made every
  // link into the log land on an unfiltered page — the Statistics page links a callsign here
  // precisely because the question after "who have I worked most" is "when". Applied once,
  // keyed on `router.isReady`: re-running it on every query change would fight the operator
  // as they typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !router.isReady) return;
    seeded.current = true;
    const initial = typeof router.query.q === "string" ? router.query.q : "";
    if (initial) {
      setQ(initial);
      setDebouncedQ(initial);
    }
  }, [router.isReady, router.query.q]);

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQ(q);
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const path = useMemo(() => {
    const params = new URLSearchParams({
      take: String(PAGE_SIZE),
      skip: String(page * PAGE_SIZE),
      sort,
      dir,
      confirmed,
    });
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    if (band) params.set("band", band);
    if (mode) params.set("mode", mode);
    // Whole UTC days, matching the ADIF export. A date without the time boundary
    // silently drops everything logged after midnight on the closing day.
    if (from) params.set("from", `${from}T00:00:00.000Z`);
    if (to) params.set("to", `${to}T23:59:59.999Z`);
    return `/api/qsos?${params}`;
  }, [debouncedQ, band, mode, confirmed, from, to, sort, dir, page]);

  const { data, error, loading } = useApi<ListResponse<Qso>>(path);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleSort(field: SortField) {
    if (sort === field) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setDir(field === "startTime" ? "desc" : "asc");
    }
    setPage(0);
  }

  // Any filter change invalidates the current page offset.
  function withReset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(0);
    };
  }

  return (
    <>
      <PageHeader
        title="Log"
        subtitle={total > 0 ? `${total.toLocaleString()} QSOs` : undefined}
        actions={
          canLog ? (
            <Link href="/qsos/new">
              <Button variant="primary">New QSO</Button>
            </Link>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            value={q}
            onChange={(e) => withReset(setQ)(e.target.value)}
            placeholder="Search callsign, grid, notes…"
            aria-label="Search the log by callsign, grid or notes"
            type="search"
            className="lg:col-span-2"
          />
          <Select
            value={band}
            onChange={(e) => withReset(setBand)(e.target.value)}
            aria-label="Filter by band"
          >
            <option value="">All bands</option>
            {BAND_NAMES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
          <Select
            value={mode}
            onChange={(e) => withReset(setMode)(e.target.value)}
            aria-label="Filter by mode"
          >
            <option value="">All modes</option>
            {LOGGABLE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Select
            value={confirmed}
            onChange={(e) => withReset(setConfirmed)(e.target.value)}
            aria-label="Filter by confirmation status"
          >
            <option value="any">Confirmed: any</option>
            <option value="yes">Confirmed (card, LoTW or eQSL)</option>
            <option value="no">Not confirmed by anything</option>
          </Select>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            From (UTC)
            <Input
              type="date"
              value={from}
              onChange={(e) => withReset(setFrom)(e.target.value)}
              className="tnum w-40"
              aria-label="Only contacts on or after this UTC date"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            To (UTC)
            <Input
              type="date"
              value={to}
              onChange={(e) => withReset(setTo)(e.target.value)}
              className="tnum w-40"
              aria-label="Only contacts on or before this UTC date"
            />
          </label>

          {(q || band || mode || from || to || confirmed !== "any") && (
            <Button
              onClick={() => {
                setQ("");
                setBand("");
                setMode("");
                setFrom("");
                setTo("");
                setConfirmed("any");
                setPage(0);
              }}
            >
              Clear filters
            </Button>
          )}

          {/* Export what is on screen, not the whole log.

              The ADIF page already accepts these same parameters, so a filtered view
              was one link away from being exportable and there was no way to get
              there. */}
          <a
            href={`/api/adif/export?${new URLSearchParams({
              ...(debouncedQ.trim() ? { q: debouncedQ.trim() } : {}),
              ...(band ? { band } : {}),
              ...(mode ? { mode } : {}),
              ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
              ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
              ...(confirmed !== "any" ? { confirmed } : {}),
            }).toString()}`}
            className="text-xs text-fg-muted hover:text-accent-bright underline underline-offset-2 ml-auto"
          >
            Export this view as ADIF
          </a>
        </div>
      </Card>

      {error && (
        <ErrorBanner>
          {error.status === 503
            ? "Can't reach the database. Check DATABASE_URL and that MySQL is running."
            : error.message}
        </ErrorBanner>
      )}

      {rows.length === 0 && !loading && !error ? (
        <Card>
          <EmptyState title={total === 0 ? "Nothing logged yet" : "No QSOs match"}>
            {total === 0 ? (
              <>
                Contacts arrive here from the digital modes automatically, from{" "}
                <Link href="/qsos/new" className="text-accent-bright underline underline-offset-2">
                  New QSO
                </Link>{" "}
                by hand, or from{" "}
                <Link href="/adif" className="text-accent-bright underline underline-offset-2">
                  an ADIF import
                </Link>
                .
              </>
            ) : (
              "No contact matches these filters. Clear them to see the whole log."
            )}
          </EmptyState>
        </Card>
      ) : (
        <div className="border border-line rounded-md overflow-x-auto bg-surface">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-2 text-left">
                <Th field="startTime" sort={sort} dir={dir} onSort={toggleSort}>
                  Time (UTC)
                </Th>
                <Th field="callsign" sort={sort} dir={dir} onSort={toggleSort}>
                  Callsign
                </Th>
                <Th field="band" sort={sort} dir={dir} onSort={toggleSort}>
                  Band
                </Th>
                <th className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide">
                  Freq
                </th>
                <Th field="mode" sort={sort} dir={dir} onSort={toggleSort}>
                  Mode
                </Th>
                <th className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide">
                  RST
                </th>
                <th className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide">
                  Grid
                </th>
                <th className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide">
                  Station / Op
                </th>
                <th className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide">
                  QSL
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((qso) => (
                <tr
                  key={qso.id}
                  className="hover:bg-surface-2 cursor-pointer"
                  onClick={() => void router.push(`/qsos/${qso.id}`)}
                >
                  <td className="px-3 py-1.5 tnum whitespace-nowrap text-fg-muted">
                    {formatUtc(qso.startTime)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Link
                      href={`/qsos/${qso.id}`}
                      className="font-display text-base tracking-wide hover:text-accent-bright"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {qso.callsign}
                    </Link>
                    {/* Shown beside the callsign rather than in a column of its own:
                        the table is already at its width, and a park is a property of
                        the station worked.

                        A contact can be several parks at once, so the count is shown
                        rather than a list that would push the column around — the full
                        set is in the tooltip and on the detail page. The bare programme
                        name appears when the activator only said "CQ POTA" and no spot
                        told us which park. */}
                    {qso.sig && (
                      <span
                        className="ml-1.5 text-[10px] uppercase tracking-wide text-fg-subtle tnum"
                        title={
                          qso.sigRefs?.length
                            ? `${qso.sig} — ${qso.sigRefs.map((r) => r.sigInfo).join(", ")}`
                            : qso.sigInfo
                              ? `${qso.sig} — ${qso.sigInfo}`
                              : `${qso.sig} — reference not known`
                        }
                      >
                        {qso.sigInfo ?? qso.sig}
                        {(qso.sigRefs?.length ?? 0) > 1 && (
                          <span className="text-accent-bright"> +{qso.sigRefs!.length - 1}</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge tone="accent">{qso.band}</Badge>
                  </td>
                  <td className="px-3 py-1.5 tnum whitespace-nowrap text-fg-muted">
                    {formatFreqMHz(qso.freqHz)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge>{qso.mode}</Badge>
                  </td>
                  <td className="px-3 py-1.5 tnum whitespace-nowrap text-fg-muted">
                    {qso.rstSent ?? "—"} / {qso.rstRcvd ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 tnum text-fg-muted">
                    {qso.gridSquare ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted whitespace-nowrap">
                    {qso.station.callsign}
                    {qso.operator && (
                      <span className="text-fg-subtle">
                        {" "}
                        / {qso.operator.callsign}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <QslCell qso={qso} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <span className="text-fg-subtle tnum">
            Page {page + 1} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
              ← Previous
            </Button>
            <Button
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function Th({
  field,
  sort,
  dir,
  onSort,
  children,
}: {
  field: SortField;
  sort: SortField;
  dir: "asc" | "desc";
  onSort: (f: SortField) => void;
  children: React.ReactNode;
}) {
  const active = sort === field;
  return (
    <th
      // `scope` is what tells a screen reader this cell heads a column; without it a
      // 50-row table reads as 450 unlabelled cells.
      scope="col"
      // `aria-sort` is the only way the current sort is conveyed non-visually — the
      // ▲/▼ is aria-hidden, correctly, because "black up-pointing triangle" is not
      // information.
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className="px-3 py-2 font-medium text-xs uppercase tracking-wide"
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`flex items-center gap-1 ${active ? "text-accent-bright" : "text-fg-muted hover:text-fg"}`}
      >
        {children}
        {active && <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
        <span className="sr-only">
          {active
            ? `, sorted ${dir === "asc" ? "ascending" : "descending"}. Activate to reverse.`
            : ", activate to sort by this column"}
        </span>
      </button>
    </th>
  );
}

function QslCell({ qso }: { qso: Qso }) {
  const confirmed =
    qso.qslRcvd === "CONFIRMED" || qso.lotwRcvd || qso.eqslRcvd;

  return (
    <div className="flex items-center gap-1">
      {confirmed && <Badge tone="ok">Cfm</Badge>}
      {qso.lotwRcvd ? (
        <Badge tone="ok">L</Badge>
      ) : qso.lotwSent ? (
        <Badge tone="info">L</Badge>
      ) : null}
      {qso.eqslRcvd ? (
        <Badge tone="ok">e</Badge>
      ) : qso.eqslSent ? (
        <Badge tone="info">e</Badge>
      ) : null}
      {/* "Card" means paper. "Email" means a card image was emailed. Keeping them
          apart is the whole point: someone who sends you a card and wants one back
          still needs a card, and a single badge for both hid that. */}
      {qso.qslSent === "SENT" && <Badge tone="info">Card</Badge>}
      {qso.emailQslSent ? <Badge tone="info">Email</Badge> : null}
      {!confirmed &&
        !qso.lotwSent &&
        !qso.eqslSent &&
        !qso.emailQslSent &&
        qso.qslSent === "NONE" && <span className="text-fg-subtle">—</span>}
      <ResendQslButton qsoId={qso.id} callsign={qso.callsign} />
    </div>
  );
}

export const getServerSideProps = withPageAuth();

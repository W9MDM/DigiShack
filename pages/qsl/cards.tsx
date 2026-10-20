import { useRouter } from "next/router";
import { useState } from "react";

import { LabelSheets, PrintCopy, sheetsFor, type LabelQso } from "@/components/qsl/LabelSheet";
import { callList, Notice, plural, TickBox } from "@/components/qsl/controls";
import {
  DEFAULT_LABEL_STOCK,
  LABEL_STOCKS,
  labelSheetCss,
  labelsPerSheet,
  labelStock,
} from "@/components/qsl/label-stock";
import { QslSectionNav, StatusTabs, tabId, tabPanelId } from "@/components/qsl/QslNav";
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
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { formatUtc, formatUtcDate } from "@/lib/time";
import { cn } from "@/lib/utils";

// Physical QSL cards: who is owed one, marking batches in and out, and a print-ready
// label sheet.
//
// Batch-oriented rather than per-contact, because that is how cards are actually
// worked — a stack gets written, posted via the bureau, and the whole batch is
// recorded at once.

type Route = "BUREAU" | "DIRECT" | "MANAGER";
type Which = "owed" | "sent" | "received";

const ROUTES: { id: Route; label: string }[] = [
  { id: "BUREAU", label: "Bureau" },
  { id: "DIRECT", label: "Direct" },
  { id: "MANAGER", label: "Manager" },
];

const TABS: { id: Which; label: string }[] = [
  { id: "owed", label: "Owed a card" },
  { id: "sent", label: "Sent" },
  { id: "received", label: "Received" },
];

/** The API's ceiling, and the batch ceiling for marking. */
const LIMIT = 500;

const TAB_IDS = "qsl-cards";

/** The one sentence explaining why the batch buttons are off, shared by all three. */
const NEEDS_SELECTION = "qsl-cards-needs-selection";

const STOCK_KEY = "digishack.qsl.labelStock";

interface CardQso extends LabelQso {
  qslSent: string;
  qslRcvd: string;
  qslSentVia: Route | null;
  qslRcvdVia: Route | null;
  qslSentAt: string | null;
}

interface CardsResponse {
  which: string;
  qsos: CardQso[];
  counts: Record<string, number>;
}

function parseWhich(raw: string | string[] | undefined): Which {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "sent" || v === "received" ? v : "owed";
}

function routeLabel(r: Route | null): string | null {
  return ROUTES.find((x) => x.id === r)?.label ?? null;
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

function readStock(): string {
  try {
    return window.localStorage.getItem(STOCK_KEY) ?? DEFAULT_LABEL_STOCK;
  } catch {
    return DEFAULT_LABEL_STOCK;
  }
}

function saveStock(id: string): void {
  try {
    window.localStorage.setItem(STOCK_KEY, id);
  } catch {
    // A private window: the choice simply is not remembered.
  }
}

/**
 * The label sheet, ready to print.
 *
 * Rendered twice: on screen at true size as the preview, and as a portal straight under
 * <body> as the copy that prints (see PrintCopy). It works from a SNAPSHOT of the chosen
 * contacts, so marking them sent from here — which drops them off the owed list — does not
 * empty the sheet you are about to print.
 */
function PrintView({
  qsos,
  route,
  onRoute,
  busy,
  marked,
  onMarkSent,
  onBack,
}: {
  qsos: CardQso[];
  route: Route;
  onRoute: (r: Route) => void;
  busy: boolean;
  marked: boolean;
  onMarkSent: () => void;
  onBack: () => void;
}) {
  const [stockId, setStockId] = useState(readStock);
  const [startAt, setStartAt] = useState(1);
  const [guides, setGuides] = useState(false);

  const stock = labelStock(stockId);
  const per = labelsPerSheet(stock);
  const skip = Math.min(Math.max(1, startAt), per) - 1;
  const sheets = sheetsFor(stock, qsos, skip);

  return (
    <>
      <style>{labelSheetCss(stock)}</style>

      <PageHeader
        title="Print labels"
        subtitle={`${plural(qsos.length, "card")} on ${plural(sheets.length, "sheet")} of ${stock.name}`}
        actions={<Button onClick={onBack}>← Back to the list</Button>}
      />

      <Card className="mb-4">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field label="Label stock" htmlFor="qsl-label-stock">
              <Select
                id="qsl-label-stock"
                value={stock.id}
                onChange={(e) => {
                  setStockId(e.target.value);
                  saveStock(e.target.value);
                  setStartAt(1);
                }}
              >
                {LABEL_STOCKS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.detail}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Start at label" htmlFor="qsl-label-start" hint={`1 to ${per}, for a part-used sheet`}>
              <Input
                id="qsl-label-start"
                type="number"
                inputMode="numeric"
                min={1}
                max={per}
                value={startAt}
                onChange={(e) => setStartAt(Number(e.target.value) || 1)}
              />
            </Field>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
            <TickBox checked={guides} onChange={setGuides} />
            Draw cut guides (plain paper, or a test print to hold against a sheet)
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => window.print()}>
              Print {plural(qsos.length, "label")}
            </Button>
            <span className="text-sm text-fg-muted">then</span>
            <Select
              aria-label="Sent via"
              value={route}
              onChange={(e) => onRoute(e.target.value as Route)}
              className="w-32"
            >
              {ROUTES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
            <Button disabled={busy || marked} loading={busy} onClick={onMarkSent}>
              {marked ? "Marked sent" : `Mark ${qsos.length} sent`}
            </Button>
          </div>

          <p className="text-sm text-fg-subtle">
            Print at 100% scale with margins on Default or None and headers and footers off —
            anything else moves the labels. Try the first sheet on plain paper and hold it
            against the label sheet before using labels.
          </p>
        </div>
      </Card>

      {/* True size on screen too; a phone scrolls it sideways rather than shrinking it. */}
      <div className="overflow-x-auto rounded-md border border-line bg-surface-2 p-4">
        <div className="mx-auto flex w-max flex-col gap-4">
          <LabelSheets stock={stock} sheets={sheets} guides={guides} forPrint={false} className="shadow-panel" />
        </div>
      </div>

      <PrintCopy>
        <LabelSheets stock={stock} sheets={sheets} guides={guides} forPrint />
      </PrintCopy>
    </>
  );
}

function SentBadge({ q, showDate }: { q: CardQso; showDate: boolean }) {
  if (q.qslSent === "NONE") return <span className="text-fg-subtle">—</span>;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {/* `warn` for anything short of SENT: REQUESTED and QUEUED are a card OUTSTANDING,
          and amber is what "waiting on me" looks like everywhere else in this interface. */}
      <Badge size="sm" tone={q.qslSent === "SENT" ? "ok" : "warn"}>
        {q.qslSent === "SENT" ? (routeLabel(q.qslSentVia) ?? "Sent") : titleCase(q.qslSent)}
      </Badge>
      {showDate && q.qslSentAt && (
        <span className="tnum hidden text-fg-subtle sm:inline">{formatUtcDate(q.qslSentAt)}</span>
      )}
    </span>
  );
}

export default function QslCardsPage() {
  const router = useRouter();
  const which = parseWhich(router.query.tab);

  // "Owed" is fetched whatever the tab: it is the number this page exists to answer.
  const owedApi = useApi<CardsResponse>(`/api/qsl/cards?which=owed&limit=${LIMIT}`);
  const otherApi = useApi<CardsResponse>(
    which === "owed" ? null : `/api/qsl/cards?which=${which}&limit=${LIMIT}`,
  );
  const active = which === "owed" ? owedApi : otherApi;
  // The response names its own list, so a tab switch in flight never shows the last tab.
  const fresh = active.data?.which === which ? active.data : null;
  const qsos = fresh?.qsos ?? [];
  const counts = active.data?.counts ?? owedApi.data?.counts ?? {};

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [route, setRoute] = useState<Route>("BUREAU");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [printing, setPrinting] = useState<{ qsos: CardQso[]; marked: boolean } | null>(null);

  const needle = filter.trim().toUpperCase();
  const visible = needle ? qsos.filter((q) => q.callsign.toUpperCase().includes(needle)) : qsos;
  const chosen = qsos.filter((q) => selected.has(q.id));
  const visibleChosen = visible.filter((q) => selected.has(q.id));
  const allVisibleChosen = visible.length > 0 && visibleChosen.length === visible.length;
  const nothingTicked = chosen.length === 0;
  /* The buttons are off whenever nothing is ticked, but the SENTENCE is only true when
     there is something to tick. On an empty list it would send the operator to rows that
     are not there, and the card body already says why it is empty. */
  const explainSelection = nothingTicked && qsos.length > 0;

  function reloadAll() {
    void owedApi.reload();
    if (which !== "owed") void otherApi.reload();
  }

  function selectTab(id: Which) {
    if (id === which) {
      reloadAll();
      return;
    }
    setSelected(new Set());
    setFilter("");
    void router.replace(
      { pathname: router.pathname, query: id === "owed" ? {} : { tab: id } },
      undefined,
      { shallow: true, scroll: false },
    );
  }

  async function mark(action: "mark-sent" | "mark-received", rows: CardQso[]): Promise<boolean> {
    if (rows.length === 0) return false;
    setBusy(action);
    setActionError(null);
    setNotice(null);
    try {
      const r = await apiPost<{ updated?: number }>("/api/qsl/cards", {
        action,
        qsoIds: rows.map((q) => q.id),
        via: route,
      });
      const n = typeof r?.updated === "number" ? r.updated : rows.length;
      setNotice(
        `Marked ${plural(n, "card")} ${action === "mark-sent" ? "sent" : "received"} via ` +
          `${(routeLabel(route) ?? route).toLowerCase()}: ${callList(rows.map((q) => q.callsign))}.`,
      );
      setSelected(new Set());
      return true;
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Request failed");
      return false;
    } finally {
      setBusy(null);
      reloadAll();
    }
  }

  const banners = (
    <div className="mb-4 flex flex-col gap-2 empty:hidden">
      {active.error && (
        <ErrorBanner>
          Could not load the list ({active.error.message}). Trying again automatically.
        </ErrorBanner>
      )}
      {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
      {notice && <Notice tone="ok" onDismiss={() => setNotice(null)}>{notice}</Notice>}
    </div>
  );

  if (printing) {
    return (
      <>
        {banners}
        <PrintView
          qsos={printing.qsos}
          route={route}
          onRoute={setRoute}
          busy={busy === "mark-sent"}
          marked={printing.marked}
          onMarkSent={() =>
            void mark("mark-sent", printing.qsos).then((ok) => {
              if (ok) setPrinting((p) => (p ? { ...p, marked: true } : p));
            })
          }
          onBack={() => setPrinting(null)}
        />
      </>
    );
  }

  const owedCount = owedApi.data?.which === "owed" ? owedApi.data.qsos.length : null;
  const tabCount = (id: Which): number | null =>
    id === "owed"
      ? owedCount
      : id === "sent"
        ? (counts.SENT ?? (owedApi.data || otherApi.data ? 0 : null))
        : which === "received" && fresh
          ? qsos.length
          : null;

  const loadingList = !fresh && !active.error;

  return (
    <>
      <PageHeader
        title="QSL cards"
        subtitle="Paper cards: who is owed one, batches in and out, and label sheets"
        actions={<QslSectionNav active="cards" />}
      />

      {banners}

      <Card>
        <StatusTabs
          tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: tabCount(t.id) }))}
          active={which}
          onSelect={selectTab}
          label="Which cards"
          idBase={TAB_IDS}
          className="-mx-4 -mt-1 px-2"
        />

        <div role="tabpanel" id={tabPanelId(TAB_IDS)} aria-labelledby={tabId(TAB_IDS, which)} className="pt-3">
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <Input
              type="search"
              placeholder="Find a callsign"
              aria-label="Find a callsign"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full sm:w-48"
            />
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <Select
                aria-label="Route"
                value={route}
                onChange={(e) => setRoute(e.target.value as Route)}
                className="w-32"
              >
                {ROUTES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
              {/* Three controls, ONE reason. All three are off until a row is ticked; the
                  sentence is written once and all three point at it with aria-describedby,
                  rather than `disabledReason` printing it three times. */}
              <Button
                variant={which === "sent" ? "secondary" : "primary"}
                disabled={busy !== null || nothingTicked}
                loading={busy === "mark-sent"}
                aria-describedby={explainSelection ? NEEDS_SELECTION : undefined}
                onClick={() => void mark("mark-sent", chosen)}
              >
                Mark sent
              </Button>
              <Button
                variant={which === "sent" ? "primary" : "secondary"}
                disabled={busy !== null || nothingTicked}
                loading={busy === "mark-received"}
                aria-describedby={explainSelection ? NEEDS_SELECTION : undefined}
                onClick={() => void mark("mark-received", chosen)}
              >
                Mark received
              </Button>
              <Button
                disabled={busy !== null || nothingTicked}
                aria-describedby={explainSelection ? NEEDS_SELECTION : undefined}
                onClick={() => {
                  setNotice(null);
                  setPrinting({ qsos: chosen, marked: false });
                }}
              >
                Print labels{nothingTicked ? "" : ` (${chosen.length})`}
              </Button>
            </div>
            {explainSelection && (
              <span id={NEEDS_SELECTION} className="basis-full text-sm text-fg-subtle">
                Tick contacts in the list below to mark them or print labels for them.
              </span>
            )}
          </div>

          {loadingList ? (
            <p className="py-6 text-sm text-fg-subtle">Loading…</p>
          ) : qsos.length === 0 ? (
            active.error ? (
              <p className="py-6 text-sm text-fg-subtle">This list could not be loaded.</p>
            ) : (
              <EmptyState
                className="py-8"
                title={which === "owed" ? "Nobody is owed a card" : which === "sent" ? "No cards sent yet" : "No cards received yet"}
              >
                {which === "owed"
                  ? "A contact lands here when their card arrives, or when it is marked as requested."
                  : which === "sent"
                    ? "Mark contacts sent from the Owed tab and they move here."
                    : "Cards marked received are recorded as confirmed, which is what the awards page counts."}
              </EmptyState>
            )
          ) : visible.length === 0 ? (
            <p className="py-6 text-sm text-fg-subtle">No callsign here matches “{filter.trim()}”.</p>
          ) : (
            <div className="-mx-4 max-h-[32rem] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-surface-2">
                  <tr className="text-left">
                    <Th size="sm" className="w-8 px-3">
                      <TickBox
                        checked={allVisibleChosen}
                        indeterminate={visibleChosen.length > 0 && !allVisibleChosen}
                        onChange={() =>
                          setSelected((s) => {
                            const next = new Set(s);
                            for (const q of visible) {
                              if (allVisibleChosen) next.delete(q.id);
                              else next.add(q.id);
                            }
                            return next;
                          })
                        }
                        label={allVisibleChosen ? "Untick every contact shown" : "Tick every contact shown"}
                      />
                    </Th>
                    <Th size="sm">Call</Th>
                    <Th size="sm">UTC</Th>
                    <Th size="sm" className="hidden sm:table-cell">Band</Th>
                    <Th size="sm" className="hidden sm:table-cell">Mode</Th>
                    <Th size="sm">Card sent</Th>
                    <Th size="sm">Card rcvd</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line font-mono text-xs">
                  {visible.map((q) => {
                    const on = selected.has(q.id);
                    return (
                      <tr key={q.id} className={cn("hover:bg-surface-2", on && "bg-accent/10")}>
                        <Td size="sm" className="px-3">
                          <TickBox
                            checked={on}
                            label={`Tick ${q.callsign}`}
                            onChange={() =>
                              setSelected((s) => {
                                const next = new Set(s);
                                if (next.has(q.id)) next.delete(q.id);
                                else next.add(q.id);
                                return next;
                              })
                            }
                          />
                        </Td>
                        <Td size="sm">
                          <span className="text-sm text-fg">{q.callsign}</span>
                          <span className="block text-fg-subtle sm:hidden">
                            {q.band} {q.mode}
                          </span>
                        </Td>
                        <Td size="sm" className="tnum whitespace-nowrap text-fg-subtle">
                          <span className="sm:hidden">{formatUtcDate(q.startTime)}</span>
                          <span className="hidden sm:inline">{formatUtc(q.startTime)}</span>
                        </Td>
                        <Td size="sm" className="tnum hidden sm:table-cell">{q.band}</Td>
                        <Td size="sm" className="hidden text-fg-muted sm:table-cell">{q.mode}</Td>
                        <Td size="sm">
                          <SentBadge q={q} showDate={which === "sent"} />
                        </Td>
                        <Td size="sm">
                          {q.qslRcvd === "NONE" ? (
                            <span className="text-fg-subtle">—</span>
                          ) : (
                            <Badge size="sm" tone="ok">
                              {routeLabel(q.qslRcvdVia) ?? "Yes"}
                            </Badge>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {qsos.length >= LIMIT && (
            <p className="mt-3 text-xs text-fg-subtle">
              Showing the oldest {LIMIT}. Mark a batch and the next ones appear.
            </p>
          )}
          <p className="mt-3 text-xs text-fg-subtle">
            The route (bureau, direct, manager) is stored as ADIF QSL_SENT_VIA and
            QSL_RCVD_VIA, so it survives export. An inbound card is recorded as
            CONFIRMED — that is what the awards page counts.
          </p>
        </div>
      </Card>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR" });

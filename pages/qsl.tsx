import { useRouter } from "next/router";
import { useState, type ReactNode } from "react";

import { GatewayBadge } from "@/components/qsl/GatewayBadge";
import { QslPreviewDialog } from "@/components/qsl/QslPreviewDialog";
import { QslSectionNav, StatusTabs, tabId, tabPanelId } from "@/components/qsl/QslNav";
import { ResendQslButton } from "@/components/qsl/ResendQslButton";
import { callList, Notice, plural, TickBox } from "@/components/qsl/controls";
import type { QslQueueEntry, QslQueueStatus } from "@/components/qsl/queue-types";
import { describeSendResult } from "@/components/qsl/send-summary";
import { HelpTip } from "@/components/ui/HelpTip";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiGet, apiPost, isNetworkFailure, useApi } from "@/lib/client/api";
import { useCanManageQsl } from "@/lib/client/session";
import { isUnconfirmedSend, unconfirmedSendState } from "@/lib/qsl/unconfirmed";
import { formatUtc, formatUtcDate } from "@/lib/time";
import { cn } from "@/lib/utils";

// QSL email review.
//
// Three deliberate steps, because these are unsolicited emails to other
// operators: queue (resolves the address and renders the message), review and
// approve, then send. Nothing skips a step, and the message that was reviewed is
// the message that goes out — the body is stored at queue time.
//
// THE FOURTH STEP IS INVISIBLE AND THAT WAS THE BUG. Automatic queuing, approval and sending
// all run on a timer inside the radio service, so a queue nothing is sending looks EXACTLY
// like a queue waiting for a person — same rows, same badges, same counts. `sender` on the
// queue response is the missing half; see QslSenderCheck in pages/api/qsl/queue.ts.
//
// Each tab fetches its own status (`?status=`), a page at a time with "Load more". The
// unfiltered GET returned the 200 OLDEST non-skipped rows, so on a station with a long sent
// history the pending and approved rows — the newest — were not in the response at all, while
// the counts said they existed. Sent is listed newest first (it is history); Pending is oldest
// first and Approved in send order, as the work is done.

interface Candidate {
  qsoId: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: string;
}

/** Whether anything will actually send this queue. See pages/api/qsl/queue.ts. */
interface QslSenderStatus {
  enabled: boolean;
  autoApprove: boolean;
  running: boolean;
  intervalMinutes: number;
  port: number;
  /** True only when something sends approved messages unattended. */
  sending: boolean;
  /** Ordered by what to fix first; empty only when something really is sending. */
  detail: string;
}

interface QueueResponse {
  queue: QslQueueEntry[];
  /** Pass back as `?cursor=` for the next page; null on the last one. */
  nextCursor?: string | null;
  counts: Record<string, number>;
  /** SENT rows whose sender died before recording the outcome. */
  interrupted?: number;
  candidates: Candidate[];
  sender?: QslSenderStatus;
}

/** What a `?cursor=` request returns: the next rows and nothing else. */
interface QueuePage {
  queue: QslQueueEntry[];
  nextCursor: string | null;
}

interface EnqueueResult {
  callsign: string;
  status: string;
  detail?: string;
}

interface NoticeState {
  tone: "ok" | "warn" | "info";
  text: ReactNode;
}

type TabId = "pending" | "approved" | "sent" | "failed" | "skipped";

const TABS: { id: TabId; status: QslQueueStatus; label: string; tone?: "warn" | "danger" }[] = [
  { id: "pending", status: "PENDING", label: "Pending" },
  { id: "approved", status: "APPROVED", label: "Approved", tone: "warn" },
  { id: "sent", status: "SENT", label: "Sent" },
  { id: "failed", status: "FAILED", label: "Failed", tone: "danger" },
  { id: "skipped", status: "SKIPPED", label: "Skipped" },
];

const TAB_IDS = "qsl-queue";

/** The API caps `enqueue` at 100 contacts per request. */
const ENQUEUE_MAX = 100;

function parseTab(raw: string | string[] | undefined): TabId {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return TABS.some((t) => t.id === v) ? (v as TabId) : "pending";
}

/** One sentence for every outcome `enqueue` can report, not just the two common ones. */
function describeEnqueue(results: EnqueueResult[]): NoticeState {
  const of = (...s: string[]) => results.filter((r) => s.includes(r.status));
  const queued = of("queued").length;
  const parts: string[] = [`Queued ${queued} of ${results.length}.`];
  const noAddress = of("no-address");
  if (noAddress.length) {
    parts.push(`No published address for ${callList(noAddress.map((r) => r.callsign))}.`);
  }
  const optedOut = of("opted-out");
  if (optedOut.length) {
    parts.push(`Asked not to be emailed: ${callList(optedOut.map((r) => r.callsign))}.`);
  }
  const already = of("already-queued", "already-sent");
  if (already.length) parts.push(`${plural(already.length, "was", "were")} already queued or sent.`);
  // Grouped by reason: "app.baseUrl is not set" twenty-five times is one fact, not twenty-five.
  const errors = of("error");
  const byReason = new Map<string, string[]>();
  for (const e of errors) {
    const reason = e.detail ?? "unknown error";
    byReason.set(reason, [...(byReason.get(reason) ?? []), e.callsign]);
  }
  for (const [reason, calls] of byReason) {
    parts.push(`Not queued (${callList(calls, 4)}): ${reason}`);
  }
  return { tone: queued > 0 && errors.length === 0 ? "ok" : "warn", text: parts.join(" ") };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sent / failed / skipped / taken by another sender — see components/qsl/send-summary.ts. */
const describeSend = (r: Record<string, unknown>): NoticeState => describeSendResult(r);

/**
 * Whether anything is sending, said before the queue rather than deduced from it.
 *
 * The tone is graded rather than uniformly red, because "automatic emailing is off" is the
 * deliberate default for unsolicited mail and colouring it as a failure would teach an
 * operator to ignore the line that matters. Red is reserved for the one case that IS a
 * fault: automatic sending switched on with nothing running it — and only that case puts
 * the server's full explanation on the page; the others keep it one tap away.
 */
function SenderLine({ sender, approvedWaiting }: { sender: QslSenderStatus; approvedWaiting: number }) {
  const fault = sender.enabled && !sender.running;
  const tone = sender.sending ? "ok" : fault ? "danger" : approvedWaiting > 0 ? "warn" : "quiet";
  const headline = sender.sending
    ? `Automatic sending is on: the radio service queues and sends every ${sender.intervalMinutes} min.`
    : !sender.enabled
      ? "Automatic sending is off. Approved messages go out only when someone presses Send."
      : !sender.running
        ? "Automatic sending is on, but the radio service is not running, so nothing is being sent."
        : `The radio service queues contacts every ${sender.intervalMinutes} min. A person approves and sends them.`;
  return (
    <div className="mb-4 flex items-start gap-2 text-sm">
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          tone === "ok" ? "bg-ok" : tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : "bg-line-strong",
        )}
      />
      <div className="min-w-0">
        <p className={cn(tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg-muted")}>
          {headline}
          {sender.detail && !fault && (
            <HelpTip className="ml-1.5" label="About automatic sending">
              {sender.detail}
            </HelpTip>
          )}
        </p>
        {fault && sender.detail && <p className="mt-0.5 text-xs text-fg-muted">{sender.detail}</p>}
      </div>
    </div>
  );
}

interface RequeueResult {
  scanned: number;
  requeued: number;
  byReason: { placeholder: number; winlink: number; arrl: number };
  unresolvable: { callsign: string; toAddress: string }[];
}

/**
 * Re-send the QSLs that these rules would have got through.
 *
 * Behind a dry run first, and worth the extra click: these rows currently read
 * SENT. They say that because our own SMTP server accepted them — the Winlink
 * rejection and the `mycall@` bounce both happen at the far end, hours later, and
 * nothing here ever heard about it. Lives on the Sent tab, folded away: it repairs
 * history rather than being part of the daily workflow.
 */
function GatewayRequeue({ onDone }: { onDone: (msg: string) => void }) {
  const [preview, setPreview] = useState<RequeueResult | null>(null);
  const [busy, setBusy] = useState<"check" | "requeue" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "check" : "requeue");
    setErr(null);
    try {
      const r = await apiPost<RequeueResult>("/api/qsl/queue", { action: "requeue-gateways", dryRun });
      if (dryRun) {
        setPreview(r);
      } else {
        setPreview(null);
        onDone(
          `Re-queued ${plural(r.requeued, "QSL")} ` +
            `(${r.byReason.placeholder} placeholder, ${r.byReason.winlink} Winlink, ` +
            `${r.byReason.arrl} arrl.net). They go back to Pending for review and out through the normal daily limit.`,
        );
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="mt-4 rounded-sm border border-line px-3 py-2">
      <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">
        Re-send QSLs that never arrived (Winlink and placeholder addresses)
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-sm text-fg-subtle">
          Covers only the QSLs we know did <em>not</em> arrive: Winlink rejects mail from
          anyone off the recipient&apos;s accept-list unless the subject carries its key,
          and an address like <span className="font-mono">mycall@example.org</span> was
          never a real mailbox. Both bounce <em>after</em> our server accepted them, which
          is why they are recorded here as sent. arrl.net is deliberately excluded — it
          forwards most mail successfully, so re-sending would put a duplicate in inboxes
          that already have one.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy !== null} loading={busy === "check"} onClick={() => void run(true)}>
            Check what would be re-sent
          </Button>
          {preview && preview.requeued > 0 && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              loading={busy === "requeue"}
              onClick={() => void run(false)}
            >
              Re-queue {preview.requeued}
            </Button>
          )}
        </div>
        {err && <p className="text-sm text-danger">{err}</p>}
        {preview && (
          <p className="text-sm text-fg-muted">
            {preview.requeued === 0
              ? `Checked ${preview.scanned} sent QSLs — none need re-sending.`
              : `${preview.requeued} of ${preview.scanned} would be re-queued: ` +
                `${preview.byReason.placeholder} placeholder address, ` +
                `${preview.byReason.winlink} Winlink, ${preview.byReason.arrl} arrl.net.`}
            {preview.unresolvable.length > 0 && (
              <>
                {" "}
                {plural(preview.unresolvable.length, "placeholder")} could not be resolved to a
                callsign and need an address by hand:{" "}
                <span className="font-mono">
                  {callList(preview.unresolvable.map((u) => u.callsign), 5)}
                </span>
                .
              </>
            )}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * How many go out on one click.
 *
 * Sent EXPLICITLY rather than left to the server's default, because the button prints this
 * number and a button that prints a number it cannot keep is worse than one that prints
 * none. `sendApprovedQsls` takes `opts.limit ?? 25` (lib/qsl/queue.ts), so `Send 40` sent
 * twenty-five and reported "Sent 25 of 25" — leaving fifteen approved rows and an operator
 * with no reason to think anything had gone wrong. Naming the limit here makes the count on
 * the button and the count on the wire the same by construction.
 *
 * 25 rather than the schema's maximum of 100 keeps the existing behaviour exactly: sending is
 * sequential with a 400 ms gap and re-renders a card per message, so a hundred is minutes of
 * held-open request. Raising it is a separate decision with a timeout to think about.
 */
const SEND_BATCH = 25;

/** Confirmation lists: who exactly is about to get mail. */
function RecipientList({ rows }: { rows: QslQueueEntry[] }) {
  return (
    <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto text-xs">
      {rows.map((e) => (
        <li key={e.id} className="flex gap-2">
          <span className="w-20 shrink-0 font-mono">{e.callsign}</span>
          <span className="truncate text-fg-muted">{e.toAddress}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Approved messages, and the send that puts them on the wire.
 *
 * THE FAULT: `Send 12` sent twelve emails on the first click, with no confirmation of any
 * kind. The only action on this page that reaches OTHER PEOPLE — unsolicited mail, which no
 * undo, retraction or delete can pull back once SMTP has accepted it — was the one action
 * that never asked. So: a quiet button that shows what WOULD happen, then a loud one that
 * names the count, with the recipients listed, because "did I approve the right rows" is
 * only answered by the callsigns and the addresses.
 *
 * The arming is tied to the count, not a bare boolean. The queue reloads underneath this
 * panel and the radio service can approve more while it is open; a confirmation that says
 * twelve and sends thirteen is not a confirmation.
 *
 * `approved` must be in SEND order — `sendApprovedQsls` takes the oldest approval first —
 * or the list shown is not the list sent.
 */
function SendApproved({
  approved,
  total,
  busy,
  sending,
  /** Whether anything sends unattended. `null` when the queue response did not say. */
  autoSends,
  onSend,
}: {
  approved: QslQueueEntry[];
  total: number;
  busy: boolean;
  sending: boolean;
  autoSends: boolean | null;
  onSend: (limit: number) => void;
}) {
  const [armedFor, setArmedFor] = useState<number | null>(null);

  const count = Math.min(total, SEND_BATCH);
  const held = total - count;
  const armed = armedFor === total;

  return (
    <div className="mb-3 flex flex-col gap-3 border-b border-line pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">
          <strong className="tnum">{total}</strong> approved and ready to send
          {/* "Ready to send" is not the same as "about to be sent", and for most of this
              application's life the page could not tell the two apart. */}
          {autoSends === false && (
            <span className="block text-xs text-warn">
              Nothing will send these on its own — the button is the only way out.
            </span>
          )}
        </span>
        {!armed && (
          <Button variant="primary" disabled={busy} onClick={() => setArmedFor(total)}>
            Review and send…
          </Button>
        )}
      </div>

      {armed && (
        <div className="flex flex-col gap-2 rounded-sm border border-danger/40 bg-danger/5 px-3 py-2">
          <p className="text-sm text-fg">
            Send {plural(count, "QSL email")} now — one message per contact, to{" "}
            {count === 1 ? "this address" : "these addresses"}?
          </p>
          <RecipientList rows={approved.slice(0, count)} />
          <p className="text-xs text-fg-muted">
            This cannot be undone. There is no recall and no unsend: once the message has
            left the server it is in someone else&apos;s mailbox, and these are unsolicited
            — the recipients did not ask for them.
            {held > 0 && ` The remaining ${held} stay approved and go out on the next send.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* `danger-solid` for weight, not severity: as an outline the most consequential
                control on the page rendered quieter than "Approve" beside it. Sending is
                irreversible but not destructive, so it stops at one confirmation rather than
                borrowing the typed REPLACE from pages/backup.tsx. */}
            <Button variant="danger-solid" disabled={busy} loading={sending} onClick={() => onSend(count)}>
              Send {plural(count, "email")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setArmedFor(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One message in the list. Two lines on every width, so a phone needs no columns. */
function QueueRow({
  entry,
  tab,
  selectable,
  selected,
  onToggle,
  onPreview,
  canAct,
  onResent,
}: {
  entry: QslQueueEntry;
  tab: TabId;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
  canAct: boolean;
  onResent: () => void;
}) {
  // A SENT row still carrying its sender's claim: the mail server may or may not have taken
  // it. At-most-once (lib/qsl/queue.ts) means nothing automatic sends it again, so the page
  // is the only place anybody learns of it.
  const unconfirmed = tab === "sent" ? unconfirmedSendState(entry) : null;
  const meta =
    tab === "sent" && entry.sentAt
      ? `${unconfirmed ? "Claimed" : "Sent"} ${formatUtc(entry.sentAt)}`
      : tab === "approved"
        ? entry.approvedBy
          ? `Approved by ${entry.approvedBy.name}`
          : "Approved automatically"
        : null;
  return (
    <li className={cn("flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2", selected && "bg-accent/10")}>
      {selectable && (
        <TickBox
          checked={selected}
          onChange={onToggle}
          label={`Select ${entry.callsign}`}
          className="mt-0.5"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-sm text-fg">{entry.callsign}</span>
          {unconfirmed === "interrupted" && (
            <span className="rounded-sm border border-warn/50 px-1 text-xs text-warn">
              Sent? — interrupted
            </span>
          )}
          {unconfirmed === "in-flight" && (
            <span className="rounded-sm border border-line px-1 text-xs text-fg-muted">Sending…</span>
          )}
          {entry.qso && (
            <span className="tnum text-xs text-fg-subtle">
              {entry.qso.band} · {entry.qso.mode} · {formatUtc(entry.qso.startTime)}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          <span className="truncate">{entry.toAddress}</span>
          {/* At the line's right end, where the HelpTip's right-anchored panel fits. */}
          <GatewayBadge address={entry.toAddress} className="ml-auto" />
        </div>
        {meta && <p className="tnum text-xs text-fg-subtle sm:hidden">{meta}</p>}
        {tab === "failed" && entry.error && (
          <p className="text-xs text-danger break-words">{entry.error}</p>
        )}
        {unconfirmed === "interrupted" && (
          <div className="mt-1 flex flex-col gap-1.5">
            <p className="text-xs text-warn">
              The sender stopped after taking this message and before recording what happened, so
              nobody knows whether the mail server accepted it. It will not be retried on its own —
              a duplicate to a stranger is worse than a missing QSL.
              {canAct ? " Resend queues it again for review." : ""}
            </p>
            {canAct && (
              <ResendQslButton
                qsoId={entry.qsoId}
                callsign={entry.callsign}
                variant="button"
                label="Resend"
                onQueued={onResent}
              />
            )}
          </div>
        )}
        {unconfirmed === "in-flight" && (
          <p className="text-xs text-fg-muted">
            A sender has it now. If this is still here in a quarter of an hour, that send was
            interrupted.
          </p>
        )}
      </div>
      {meta && <span className="tnum hidden shrink-0 pt-0.5 text-xs text-fg-subtle sm:block">{meta}</span>}
      <Button
        variant="ghost"
        size="sm"
        onClick={onPreview}
        aria-label={`Preview the QSL to ${entry.callsign}`}
        className="shrink-0"
      >
        Preview
      </Button>
    </li>
  );
}

export default function QslPage() {
  const router = useRouter();
  const tab = parseTab(router.query.tab);
  const tabDef = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  // Sent tab only: just the sends whose outcome was never recorded.
  const [onlyInterrupted, setOnlyInterrupted] = useState(false);
  const interruptedFilter = tab === "sent" && onlyInterrupted;
  const path = `/api/qsl/queue?status=${tabDef.status}${interruptedFilter ? "&unconfirmed=1" : ""}`;
  const { data, error, loading, reload } = useApi<QueueResponse>(path);
  const canAct = useCanManageQsl();

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approveArmedFor, setApproveArmedFor] = useState<number | null>(null);
  const [preview, setPreview] = useState<QslQueueEntry | null>(null);

  // Pages after the first, from "Load more". Keyed by the list they continue, so switching
  // tab or filter drops them without an effect; `firstPage` pins them to the response they
  // were fetched after, so a reload of the first page drops them too rather than splicing a
  // fresh head onto a stale tail.
  const [more, setMore] = useState<{
    path: string;
    firstPage: QueueResponse;
    rows: QslQueueEntry[];
    cursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = more && more.path === path && more.firstPage === data ? more : null;

  const counts = data?.counts ?? {};
  const candidates = data?.candidates ?? [];
  const sender = data?.sender;
  const autoSends = sender ? sender.sending : null;
  const approvedWaiting = counts.APPROVED ?? 0;
  const interrupted = data?.interrupted ?? 0;
  const nextCursor = extra ? extra.cursor : (data?.nextCursor ?? null);

  // Rows of THIS tab only: while a tab switch is in flight `data` still holds the last
  // tab's rows, and showing them under the new heading would be a lie. The server orders
  // them (Sent newest first, Approved in send order, the rest oldest first); a row that
  // moved between pages while they were being read appears once.
  const seen = new Set<string>();
  const rows = [...(data?.queue ?? []), ...(extra?.rows ?? [])].filter((q) => {
    if (q.status !== tabDef.status || seen.has(q.id)) return false;
    if (interruptedFilter && !isUnconfirmedSend(q)) return false;
    seen.add(q.id);
    return true;
  });
  const total = counts[tabDef.status] ?? rows.length;

  async function loadMore() {
    if (!data || !nextCursor) return;
    const firstPage = data;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiGet<QueuePage>(`${path}&cursor=${encodeURIComponent(nextCursor)}`);
      setMore((m) => {
        const base = m && m.path === path && m.firstPage === firstPage ? m.rows : [];
        return { path, firstPage, rows: [...base, ...page.queue], cursor: page.nextCursor };
      });
    } catch (err) {
      setMoreError(err instanceof ApiError ? err.message : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  }
  const waiting = rows.length === 0 && (loading || data === null) && !error;

  const selectable = canAct && (tab === "pending" || tab === "failed" || tab === "skipped");
  const chosen = rows.filter((r) => selected.has(r.id));
  const allChosen = rows.length > 0 && chosen.length === rows.length;
  const approveArmed = approveArmedFor !== null && approveArmedFor === chosen.length && chosen.length > 0;

  function selectTab(id: TabId) {
    if (id === tab) {
      void reload();
      return;
    }
    setSelected(new Set());
    setApproveArmedFor(null);
    setOnlyInterrupted(false);
    setMoreError(null);
    void router.replace(
      { pathname: router.pathname, query: id === "pending" ? {} : { tab: id } },
      undefined,
      { shallow: true, scroll: false },
    );
  }

  function toggle(id: string) {
    setApproveArmedFor(null);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function act(
    label: string,
    body: Record<string, unknown>,
    describe: (r: Record<string, unknown>) => NoticeState,
  ) {
    setBusy(label);
    setActionError(null);
    setNotice(null);
    try {
      const r = await apiPost<Record<string, unknown>>("/api/qsl/queue", body);
      setNotice(describe(r ?? {}));
      setSelected(new Set());
      setApproveArmedFor(null);
    } catch (err) {
      // No answer is not a refusal. Sending and QRZ lookups both run sequentially on the
      // server and can outlast the 30 s client timeout, so the work may well be happening.
      if (isNetworkFailure(err) && (body.action === "send" || body.action === "enqueue")) {
        setNotice({
          tone: "warn",
          text:
            body.action === "send"
              ? "No answer within 30 seconds. Sending may still be running on the server — check the Sent tab in a minute before pressing Send again."
              : "No answer within 30 seconds. The QRZ lookups may still be running on the server; the queue fills in as they finish.",
        });
      } else {
        setActionError(err instanceof ApiError ? err.message : "Request failed");
      }
    } finally {
      setBusy(null);
      void reload();
    }
  }

  const approve = () =>
    void act("approve", { action: "approve", ids: chosen.map((r) => r.id) }, (r) => {
      const n = num(r.approved);
      const missed = chosen.length - n;
      return {
        tone: "ok",
        text:
          `Approved ${n}.` +
          (missed > 0 ? ` ${missed} ${missed === 1 ? "was" : "were"} no longer pending.` : "") +
          (autoSends
            ? " The radio service sends them on its next runs."
            : " They are on the Approved tab, waiting for Send."),
      };
    });

  const skip = () =>
    void act("skip", { action: "skip", ids: chosen.map((r) => r.id) }, (r) => ({
      tone: "ok",
      text: `Skipped ${num(r.skipped)}. They are on the Skipped tab.`,
    }));

  const requeue = () =>
    void act(
      "requeue",
      { action: "enqueue", qsoIds: chosen.map((r) => r.qsoId) },
      (r) => describeEnqueue(Array.isArray(r.results) ? (r.results as EnqueueResult[]) : []),
    );

  const nothingTicked = chosen.length === 0;
  const tooManyToRequeue = chosen.length > ENQUEUE_MAX;
  const hintId = "qsl-queue-needs-selection";

  return (
    <>
      <PageHeader
        title="QSL email"
        subtitle="Queue, review, then send — one contact per message"
        actions={<QslSectionNav active="email" />}
      />

      {sender && <SenderLine sender={sender} approvedWaiting={approvedWaiting} />}

      {!canAct && (
        <p className="mb-4 text-sm text-fg-subtle">
          You can read the queue. Approving, skipping and sending QSL email needs an admin
          account.
        </p>
      )}

      <div className="mb-4 flex flex-col gap-2 empty:hidden">
        {error && (
          <ErrorBanner>
            Could not load the queue ({error.message}). Trying again automatically.
          </ErrorBanner>
        )}
        {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
        {notice && (
          <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Notice>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <Card className="min-w-0 lg:col-span-2">
          <StatusTabs
            tabs={TABS.map((t) => ({
              id: t.id,
              label: t.label,
              count: data ? (counts[t.status] ?? 0) : null,
              tone: t.tone,
            }))}
            active={tab}
            onSelect={selectTab}
            label="Queue status"
            idBase={TAB_IDS}
            className="-mx-4 -mt-1 px-2"
          />

          <div
            role="tabpanel"
            id={tabPanelId(TAB_IDS)}
            aria-labelledby={tabId(TAB_IDS, tab)}
            className="pt-3"
          >
            {tab === "approved" && canAct && approvedWaiting > 0 && rows.length > 0 && (
              <SendApproved
                approved={rows}
                total={approvedWaiting}
                busy={busy !== null}
                sending={busy === "send"}
                autoSends={autoSends}
                onSend={(limit) => void act("send", { action: "send", limit }, describeSend)}
              />
            )}

            {tab === "sent" && (interrupted > 0 || onlyInterrupted) && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-warn/50 bg-warn/5 px-3 py-2 text-sm">
                <span>
                  {interrupted > 0 ? (
                    <>
                      <strong className="tnum">{interrupted}</strong>{" "}
                      {interrupted === 1 ? "send was" : "sends were"} interrupted — delivery
                      unknown. Marked <span className="text-warn">Sent? — interrupted</span> below.
                    </>
                  ) : (
                    "No interrupted sends."
                  )}
                </span>
                <Button size="sm" onClick={() => setOnlyInterrupted((v) => !v)}>
                  {onlyInterrupted ? "Show all sent" : "Show only these"}
                </Button>
              </div>
            )}

            {tab === "pending" && approvedWaiting > 0 && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm">
                <span>
                  <strong className="tnum">{approvedWaiting}</strong> approved and waiting to be
                  sent.
                </span>
                <Button size="sm" onClick={() => selectTab("approved")}>
                  {canAct ? "Review and send" : "See them"}
                </Button>
              </div>
            )}

            {selectable && rows.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
                  <TickBox
                    checked={allChosen}
                    indeterminate={!nothingTicked && !allChosen}
                    onChange={() =>
                      setSelected(allChosen ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                  />
                  {nothingTicked ? "Select all" : `${chosen.length} selected`}
                </label>
                <div className="ml-auto flex flex-wrap gap-2">
                  {tab === "pending" && (
                    <>
                      <Button
                        variant="primary"
                        disabled={busy !== null || nothingTicked || approveArmed}
                        loading={busy === "approve"}
                        aria-describedby={nothingTicked ? hintId : undefined}
                        // Approving IS sending while the radio service sends on its own —
                        // it mails every approved row — so then it asks first.
                        onClick={() => (autoSends === false ? approve() : setApproveArmedFor(chosen.length))}
                      >
                        Approve{nothingTicked ? "" : ` ${chosen.length}`}
                      </Button>
                      <Button
                        disabled={busy !== null || nothingTicked}
                        loading={busy === "skip"}
                        aria-describedby={nothingTicked ? hintId : undefined}
                        onClick={skip}
                      >
                        Skip{nothingTicked ? "" : ` ${chosen.length}`}
                      </Button>
                    </>
                  )}
                  {(tab === "failed" || tab === "skipped") && (
                    <Button
                      variant={tab === "failed" ? "primary" : "secondary"}
                      disabled={busy !== null || nothingTicked || tooManyToRequeue}
                      loading={busy === "requeue"}
                      aria-describedby={nothingTicked || tooManyToRequeue ? hintId : undefined}
                      onClick={requeue}
                    >
                      Re-queue for review{nothingTicked ? "" : ` ${chosen.length}`}
                    </Button>
                  )}
                  {tab === "failed" && (
                    <Button
                      disabled={busy !== null || nothingTicked}
                      loading={busy === "skip"}
                      aria-describedby={nothingTicked ? hintId : undefined}
                      onClick={skip}
                    >
                      Skip{nothingTicked ? "" : ` ${chosen.length}`}
                    </Button>
                  )}
                </div>
                {(nothingTicked || tooManyToRequeue) && (
                  <p id={hintId} className="basis-full text-sm text-fg-subtle">
                    {tooManyToRequeue
                      ? `Re-queuing looks each contact up on QRZ again, ${ENQUEUE_MAX} at a time. Untick ${chosen.length - ENQUEUE_MAX}.`
                      : tab === "pending"
                        ? "Tick messages to approve or skip them. Preview shows exactly what each one says."
                        : tab === "failed"
                          ? "Tick messages to re-queue them for review, or skip them. Re-queuing looks the address up again."
                          : "Tick messages to put them back in the queue for review."}
                  </p>
                )}
              </div>
            )}

            {approveArmed && (
              <div className="mt-3 flex flex-col gap-2 rounded-sm border border-danger/40 bg-danger/5 px-3 py-2">
                <p className="text-sm text-fg">
                  {autoSends
                    ? `Automatic sending is on: the radio service mails approved QSLs on its own, a few every ${sender?.intervalMinutes ?? "few"} min. Approving ${plural(chosen.length, "message")} sends ${chosen.length === 1 ? "it" : "them"} without another step.`
                    : `This page could not tell whether the radio service sends approved QSLs on its own. If it does, approving ${plural(chosen.length, "message")} sends ${chosen.length === 1 ? "it" : "them"} without another step.`}
                </p>
                <RecipientList rows={chosen} />
                <p className="text-xs text-fg-muted">
                  There is no recall once a message has left the server.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="danger-solid" disabled={busy !== null} loading={busy === "approve"} onClick={approve}>
                    Approve and send {chosen.length}
                  </Button>
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setApproveArmedFor(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {rows.length > 0 ? (
              <>
                <ul className="-mx-4 divide-y divide-line">
                  {rows.map((e) => (
                    <QueueRow
                      key={e.id}
                      entry={e}
                      tab={tab}
                      selectable={selectable}
                      selected={selected.has(e.id)}
                      onToggle={() => toggle(e.id)}
                      onPreview={() => setPreview(e)}
                      canAct={canAct}
                      onResent={() => void reload()}
                    />
                  ))}
                </ul>
                {(nextCursor || moreError || (!interruptedFilter && total > rows.length)) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
                    {!interruptedFilter && (
                      <span className="tnum">
                        Showing {rows.length.toLocaleString("en-US")} of{" "}
                        {Math.max(total, rows.length).toLocaleString("en-US")}
                        {tab === "sent" ? ", newest first" : ""}.
                      </span>
                    )}
                    {nextCursor && (
                      <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                        Load more
                      </Button>
                    )}
                    {moreError && <span className="text-danger">{moreError}</span>}
                  </div>
                )}
              </>
            ) : waiting ? (
              <p className="py-6 text-sm text-fg-subtle">Loading…</p>
            ) : error ? (
              <p className="py-6 text-sm text-fg-subtle">This list could not be loaded.</p>
            ) : (
              <EmptyQueue tab={tab} sender={sender} />
            )}

            {tab === "sent" && canAct && (
              <GatewayRequeue
                onDone={(msg) => {
                  setNotice({ tone: "ok", text: msg });
                  void reload();
                }}
              />
            )}
          </div>
        </Card>

        <Card
          title="Not yet queued"
          actions={
            canAct && candidates.length > 0 ? (
              <Button
                size="sm"
                disabled={busy !== null}
                loading={busy === "enqueue"}
                onClick={() =>
                  void act(
                    "enqueue",
                    { action: "enqueue", qsoIds: candidates.map((c) => c.qsoId) },
                    (r) => describeEnqueue(Array.isArray(r.results) ? (r.results as EnqueueResult[]) : []),
                  )
                }
              >
                Queue all {candidates.length}
              </Button>
            ) : undefined
          }
        >
          {data === null ? (
            <p className="text-sm text-fg-subtle">{error ? "Could not load." : "Loading…"}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-fg-subtle">
              No unconfirmed contacts are waiting for a QSL email.
            </p>
          ) : (
            <>
              {/* Its own scroller only from sm up. On a phone this panel is below the queue,
                  at the foot of the page, and a list that scrolls inside a page that scrolls
                  catches the thumb: the page stops moving and the list moves instead. It is
                  at most 25 short rows, so a phone simply shows them all. */}
              <ul className="-mx-4 divide-y divide-line sm:max-h-[22rem] sm:overflow-y-auto">
                {candidates.map((c) => (
                  <li key={c.qsoId} className="flex items-baseline justify-between gap-3 px-4 py-1.5">
                    <span className="font-mono text-sm">{c.callsign}</span>
                    <span className="tnum text-xs text-fg-subtle">
                      {c.band} {c.mode} · {formatUtcDate(c.startTime)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-fg-subtle">
                Oldest first{candidates.length >= 25 ? ", 25 at a time" : ""}. Queuing looks each
                callsign up on QRZ for a published address; ones without a listed email are
                reported and skipped, not guessed at. Nothing is sent until it is approved.
              </p>
            </>
          )}
        </Card>
      </div>

      {preview && <QslPreviewDialog entry={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function EmptyQueue({ tab, sender }: { tab: TabId; sender: QslSenderStatus | undefined }) {
  if (tab === "pending") {
    return (
      <EmptyState title="Nothing waiting for review" className="py-6 sm:py-8">
        {/* Whether anything FILLS this list is a separate fact from whether it is empty.
            `!sender` says nothing rather than defaulting an unknown to a claim. The panel
            is named rather than placed: it is alongside from lg up and below this one
            under that, so "alongside" was wrong on every phone and tablet. Quoted, because
            bare, the panel's title read as part of the sentence. */}
        Queue some contacts from the “Not yet queued” list
        {!sender
          ? "."
          : sender.enabled && sender.running
            ? `, or leave it — the radio service adds eligible contacts every ${sender.intervalMinutes} min.`
            : sender.enabled
              ? ". Nothing is adding any automatically: the radio service is not running."
              : ". Nothing is adding any automatically — that is switched off."}
      </EmptyState>
    );
  }
  const copy: Record<Exclude<TabId, "pending">, [string, string]> = {
    approved: ["Nothing approved", "Approved messages wait here until they are sent."],
    sent: ["Nothing sent yet", "Every QSL email that leaves is recorded here, with its address and body."],
    failed: ["No failures", "A message the mail server refuses lands here with the reason."],
    skipped: ["Nothing skipped", "Skipped messages are kept here rather than deleted."],
  };
  const [title, body] = copy[tab];
  return (
    <EmptyState title={title} className="py-6 sm:py-8">
      {body}
    </EmptyState>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR", qsl: true });

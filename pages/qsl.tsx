import Link from "next/link";
import { useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { detectGateway, rulesFor } from "@/lib/qsl/gateways";
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

interface QueueEntry {
  id: string;
  qsoId: string;
  callsign: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: "PENDING" | "APPROVED" | "SENT" | "FAILED" | "SKIPPED";
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  qso: { band: string; mode: string; startTime: string; gridSquare: string | null } | null;
  approvedBy: { name: string } | null;
}

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
  queue: QueueEntry[];
  counts: Record<string, number>;
  candidates: Candidate[];
  sender?: QslSenderStatus;
}

/**
 * Marks an address that is a radio gateway or a forwarder rather than a mailbox.
 *
 * The rules themselves live in lib/qsl/gateways.ts and are applied server-side at
 * both queue and send time; this only reports them, so the badge cannot disagree
 * with what was sent.
 */
function GatewayBadge({ address }: { address: string }) {
  const gateway = detectGateway(address);
  if (!gateway) return null;
  const { notes } = rulesFor(address);
  return (
    <span className="ml-2 inline-flex shrink-0 items-center gap-1 align-middle">
      <span className="rounded-sm border border-warn/40 bg-warn/10 px-1 py-0.5 text-[10px] uppercase tracking-wide text-warn">
        {gateway === "winlink" ? "Winlink · text + //WL2K" : "arrl.net · forwarder"}
      </span>
      {/* THE FAULT: the whole explanation lived in `title={notes.join(" ")}`, and a native
          title never appears on a touch screen. The shack tablet showed an operator a badge
          reading "Winlink · text + //WL2K" with no way whatever to find out what that meant —
          not a shortened explanation, none at all. The badge is exactly the kind of label
          that is meaningless without its note, so on the device most likely to be propped up
          next to the radio it was pure decoration.

          `align="right"` because this sits in the second-to-last column; a left-anchored
          256px panel would open off the edge of the table. UNVERIFIED at phone width: the
          pending list is a `max-h-[26rem] overflow-auto` scroll container, so a panel opened
          on one of the last rows is reachable by scrolling rather than fully in view. */}
      <HelpTip
        align="right"
        label={
          gateway === "winlink"
            ? "About Winlink addresses"
            : "About arrl.net addresses"
        }
      >
        {notes.join(" ")}
      </HelpTip>
    </span>
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
 * nothing here ever heard about it.
 */
function GatewayRequeue({ onDone }: { onDone: (msg: string) => void }) {
  const [preview, setPreview] = useState<RequeueResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(dryRun: boolean, reasons?: string[]) {
    setBusy(true);
    setErr(null);
    try {
      const r = (await apiPost("/api/qsl/queue", {
        action: "requeue-gateways",
        dryRun,
        ...(reasons ? { reasons } : {}),
      })) as RequeueResult;
      if (dryRun) {
        setPreview(r);
      } else {
        setPreview(null);
        onDone(
          `Re-queued ${r.requeued} QSL${r.requeued === 1 ? "" : "s"} ` +
            `(${r.byReason.placeholder} placeholder, ${r.byReason.winlink} Winlink, ` +
            `${r.byReason.arrl} arrl.net). They go out through the normal daily limit.`,
        );
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const nothing = preview !== null && preview.requeued === 0;

  return (
    <div className="mb-4 rounded-sm border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-fg">Re-send to gateway addresses</span>
        <Button disabled={busy} onClick={() => void run(true)}>
          {busy ? "…" : "Check what would be re-sent"}
        </Button>
        {preview && preview.requeued > 0 && (
          <Button variant="primary" disabled={busy} onClick={() => void run(false)}>
            Re-queue {preview.requeued}
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-xs text-fg-subtle">
        Covers only the QSLs we know did <em>not</em> arrive: Winlink rejects mail from
        anyone off the recipient&apos;s accept-list unless the subject carries its key,
        and an address like <span className="font-mono">mycall@example.org</span> was
        never a real mailbox. Both bounce <em>after</em> our server accepted them, which
        is why they are recorded here as sent. arrl.net is deliberately excluded — it
        forwards most mail successfully, so re-sending would put a duplicate in inboxes
        that already have one.
      </p>
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
      {preview && (
        <p className="mt-1 text-xs text-fg-muted">
          {nothing
            ? `Checked ${preview.scanned} sent QSLs — none need re-sending.`
            : `${preview.requeued} of ${preview.scanned} would be re-queued: ` +
              `${preview.byReason.placeholder} placeholder address, ` +
              `${preview.byReason.winlink} Winlink, ${preview.byReason.arrl} arrl.net.`}
          {preview.unresolvable.length > 0 && (
            <>
              {" "}
              {preview.unresolvable.length} placeholder
              {preview.unresolvable.length === 1 ? "" : "s"} could not be resolved to a
              callsign and need an address by hand:{" "}
              <span className="font-mono">
                {preview.unresolvable.slice(0, 5).map((u) => u.callsign).join(", ")}
              </span>
              .
            </>
          )}
        </p>
      )}
    </div>
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

/**
 * Approved messages, and the send that puts them on the wire.
 *
 * THE FAULT: `Send 12` sent twelve emails on the first click, with no confirmation of any
 * kind. Deleting one QSO asks. Deleting one API key asks. Removing one operator asks.
 * Restoring a backup asks twice and makes you type REPLACE. The only action on this page
 * that reaches OTHER PEOPLE — unsolicited mail, to addresses scraped off QRZ, which no
 * undo, retraction or delete can pull back once SMTP has accepted it — was the one action
 * that never asked. A mis-aimed click here is not recoverable by anything this application
 * can do; it is recoverable by writing to twelve strangers and apologising.
 *
 * The two steps are GatewayRequeue's, ninety lines up this file, not a new invention: a
 * quiet button that shows what WOULD happen, then a loud one that names the count. The one
 * thing this adds is the recipient list, because the client already holds it and no round
 * trip is needed — "how many" is answered by a number, but "did I approve the right rows"
 * is only answered by the callsigns and the addresses, and the wrong row here is somebody
 * else's inbox.
 *
 * The arming is tied to the count, not a bare boolean. The queue reloads underneath this
 * panel and the radio service can approve more while it is open; a confirmation that says
 * twelve and sends thirteen is not a confirmation.
 */
function SendApproved({
  approved,
  busy,
  sending,
  /** Whether anything sends unattended. `null` when the queue response did not say. */
  autoSends,
  onSend,
}: {
  approved: QueueEntry[];
  busy: boolean;
  sending: boolean;
  autoSends: boolean | null;
  onSend: (limit: number) => void;
}) {
  const [armedFor, setArmedFor] = useState<number | null>(null);

  const count = Math.min(approved.length, SEND_BATCH);
  const held = approved.length - count;
  const armed = armedFor === approved.length;

  return (
    <div className="mt-4 pt-4 border-t border-line flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">
          <strong className="tnum">{approved.length}</strong> approved and ready to send
          {/* The whole point of the sender state, at the place an operator looks to
              find out why a number is not going down. "Ready to send" is not the same
              as "about to be sent", and for most of this application's life the page
              could not tell the two apart. */}
          {autoSends === false && (
            <span className="block text-xs text-warn">
              Nothing will send these on its own — the button is the only way out.
            </span>
          )}
        </span>
        {!armed && (
          <Button disabled={busy} onClick={() => setArmedFor(approved.length)}>
            Review and send…
          </Button>
        )}
      </div>

      {armed && (
        <div className="rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 flex flex-col gap-2">
          <p className="text-sm text-fg">
            Send {count} QSL email{count === 1 ? "" : "s"} now — one message per contact,
            to {count === 1 ? "this address" : "these addresses"}?
          </p>
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto text-xs">
            {approved.slice(0, count).map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="w-20 shrink-0 font-mono">{e.callsign}</span>
                <span className="truncate text-fg-muted">{e.toAddress}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-muted">
            This cannot be undone. There is no recall and no unsend: once the message has
            left the server it is in someone else&apos;s mailbox, and these are unsolicited
            — the recipients did not ask for them.
            {held > 0 &&
              ` The remaining ${held} stay approved and go out on the next send.`}
          </p>
          <div className="flex gap-2">
            {/* `danger-solid`, and the reason is weight rather than severity. This was
                `variant="danger"` — the transparent outline that "Delete this QSO" wears at
                the foot of the log form — so the most consequential control on the page
                rendered QUIETER than "Approve" beside it, and red-outline meant both "send
                my QSLs" and "destroy this record" depending on which screen you were on.
                `danger` is now used nowhere on this page, so the outline keeps one meaning.

                Sending is irreversible but it is not destructive: nothing here is deleted
                and no record is lost. That is why it stops at one confirmation and does not
                borrow the typed REPLACE from pages/backup.tsx — a ceremony reused where it
                does not fit is a ceremony people learn to click through. */}
            <Button
              variant="danger-solid"
              disabled={busy}
              loading={sending}
              onClick={() => onSend(count)}
            >
              Send {count} email{count === 1 ? "" : "s"}
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

const TONE: Record<QueueEntry["status"], "ok" | "accent" | "warn" | "danger"> = {
  PENDING: "accent",
  APPROVED: "warn",
  SENT: "ok",
  FAILED: "danger",
  SKIPPED: "accent",
};

export default function QslPage() {
  const { data, error, reload } = useApi<QueueResponse>("/api/qsl/queue");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<QueueEntry | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const queue = data?.queue ?? [];
  const candidates = data?.candidates ?? [];
  const pending = queue.filter((q) => q.status === "PENDING");
  const approved = queue.filter((q) => q.status === "APPROVED");
  const sender = data?.sender;

  async function act(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError(null);
    setLastResult(null);
    try {
      const r = (await apiPost("/api/qsl/queue", body)) as Record<string, unknown>;
      if (body.action === "enqueue") {
        const results = (r.results ?? []) as { status: string; callsign: string; detail?: string }[];
        const queued = results.filter((x) => x.status === "queued").length;
        const noAddr = results.filter((x) => x.status === "no-address");
        setLastResult(
          `Queued ${queued} of ${results.length}.` +
            (noAddr.length
              ? ` No published address for ${noAddr.map((x) => x.callsign).join(", ")}.`
              : ""),
        );
      } else if (body.action === "send") {
        setLastResult(`Sent ${r.sent} of ${r.attempted}. ${r.failed ? `${r.failed} failed.` : ""}`);
      }
      setSelected(new Set());
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <PageHeader
        title="QSL email"
        subtitle="Queue, review, then send — one contact per message"
        actions={
          <Link href="/qsl/cards" className="text-sm text-accent-bright hover:underline">
            Paper cards →
          </Link>
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {actionError && (
        <div className="mb-4">
          <ErrorBanner>{actionError}</ErrorBanner>
        </div>
      )}
      {lastResult && (
        <div className="mb-4 text-sm text-fg-muted border border-line rounded-sm px-3 py-2">
          {lastResult}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {(["PENDING", "APPROVED", "SENT", "FAILED"] as const).map((s) => (
          <span key={s} className="text-xs">
            <Badge tone={TONE[s]}>{s}</Badge>{" "}
            <span className="tnum text-fg-muted">{data?.counts?.[s] ?? 0}</span>
          </span>
        ))}
      </div>

      {/* WHETHER ANYTHING IS SENDING, said before the queue rather than deduced from it.

          The tone is graded rather than uniformly red, because "automatic emailing is off"
          is the deliberate default for unsolicited mail and colouring it as a failure would
          teach an operator to ignore the line that matters. Red is reserved for the one case
          that IS a fault: automatic sending switched on with nothing running it. */}
      {sender && (
        <p
          className={cn(
            "mb-4 text-sm",
            sender.sending
              ? "text-fg-muted"
              : sender.enabled && !sender.running
                ? "text-danger"
                : approved.length > 0
                  ? "text-warn"
                  : "text-fg-subtle",
          )}
        >
          {sender.sending
            ? `The radio service queues and sends automatically, every ${sender.intervalMinutes} min.`
            : sender.detail}
        </p>
      )}

      <GatewayRequeue onDone={(msg) => { setLastResult(msg); void reload(); }} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title={`Awaiting review (${pending.length})`}
          className="lg:col-span-2"
          actions={
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={busy !== null || selected.size === 0}
                onClick={() => void act({ action: "approve", ids: [...selected] }, "approve")}
              >
                Approve {selected.size || ""}
              </Button>
              <Button
                disabled={busy !== null || selected.size === 0}
                onClick={() => void act({ action: "skip", ids: [...selected] }, "skip")}
              >
                Skip
              </Button>
            </div>
          }
        >
          {pending.length === 0 ? (
            // "Nothing waiting" alone read as "there is nothing to do". Whether anything
            // FILLS this list is a separate fact from whether it is empty, and only one of
            // the two was ever on the page.
            <p className="text-sm text-fg-subtle">
              Nothing waiting for review. Queue some contacts from the panel on the right
              {/* `!sender` is its own branch and says nothing, rather than falling through
                  to "that is switched off". Defaulting an unknown to a claim is the exact
                  fault this page was being fixed for. */}
              {!sender
                ? "."
                : sender.enabled && sender.running
                  ? `, or leave it — the radio service adds eligible contacts every ${sender.intervalMinutes} min.`
                  : sender.enabled
                    ? ". Nothing is adding any automatically: the radio service is not running."
                    : ". Nothing is adding any automatically — that is switched off."}
            </p>
          ) : (
            <div className="overflow-auto -mx-4 max-h-[26rem]">
              <table className="w-full text-sm border-collapse">
                <tbody className="divide-y divide-line">
                  {pending.map((e) => (
                    <tr key={e.id} className="hover:bg-surface-2">
                      <td className="px-3 py-1.5 w-8">
                        <input
                          type="checkbox"
                          checked={selected.has(e.id)}
                          onChange={() => toggle(e.id)}
                          className="accent-accent"
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono">{e.callsign}</td>
                      <td className="px-2 py-1.5 text-fg-subtle tnum whitespace-nowrap">
                        {e.qso ? `${e.qso.band} ${e.qso.mode}` : ""}
                      </td>
                      {/* `truncate` moved off the cell and onto the address alone. It is
                          `overflow: hidden`, so with it on the cell the badge's help panel
                          was clipped out of existence the moment it opened — the popover
                          would have replaced a tooltip that does not show on touch with a
                          panel that does not show anywhere. */}
                      <td className="px-2 py-1.5 text-fg-muted max-w-[16rem]">
                        <span className="flex min-w-0 items-center">
                          <span className="truncate">{e.toAddress}</span>
                          {/* Say when an address is not an ordinary mailbox. Both of
                              these change what actually goes on the wire, and an
                              operator wondering why a QSL had no card should be able
                              to see the reason on the row rather than guess. */}
                          <GatewayBadge address={e.toAddress} />
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => setPreview(e)}
                          className="text-xs text-accent-bright hover:underline"
                        >
                          Preview
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {approved.length > 0 && (
            <SendApproved
              approved={approved}
              busy={busy !== null}
              sending={busy === "send"}
              autoSends={sender ? sender.sending : null}
              onSend={(limit) => void act({ action: "send", limit }, "send")}
            />
          )}
        </Card>

        <Card
          title={`Candidates (${candidates.length})`}
          actions={
            <Button
              disabled={busy !== null || candidates.length === 0}
              onClick={() =>
                void act(
                  { action: "enqueue", qsoIds: candidates.map((c) => c.qsoId) },
                  "enqueue",
                )
              }
            >
              {busy === "enqueue" ? "Looking up…" : "Queue all"}
            </Button>
          }
        >
          {candidates.length === 0 ? (
            <p className="text-sm text-fg-subtle">
              No unconfirmed contacts without a QSL email.
            </p>
          ) : (
            <>
              <ul className="text-sm flex flex-col gap-1 max-h-[20rem] overflow-auto">
                {candidates.map((c) => (
                  <li key={c.qsoId} className="flex justify-between gap-2">
                    <span className="font-mono">{c.callsign}</span>
                    <span className="text-fg-subtle tnum">
                      {c.band} {c.mode}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] text-fg-subtle">
                Queuing looks each callsign up on QRZ for a published address. Ones
                without a listed email are reported and skipped, not guessed at.
              </p>
            </>
          )}
        </Card>
      </div>

      {queue.some((q) => q.status === "FAILED") && (
        <Card title="Failed" className="mt-4">
          <ul className="text-sm flex flex-col gap-1">
            {queue
              .filter((q) => q.status === "FAILED")
              .map((q) => (
                <li key={q.id} className="flex gap-3">
                  <span className="font-mono">{q.callsign}</span>
                  <span className="text-danger text-xs">{q.error}</span>
                </li>
              ))}
          </ul>
        </Card>
      )}

      {preview && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
          onClick={() => setPreview(null)}
        >
          <div
            className="bg-surface border border-line rounded-sm max-w-2xl w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3">
              <div>
                <div className="font-display tracking-wide">{preview.callsign}</div>
                <div className="text-xs text-fg-subtle">{preview.toAddress}</div>
              </div>
              <Button onClick={() => setPreview(null)}>Close</Button>
            </div>
            <div className="px-4 py-3 text-sm">
              <div className="text-xs text-fg-muted mb-1">Subject</div>
              <div className="mb-3">{preview.subject}</div>
              <div className="text-xs text-fg-muted mb-1">Body</div>
              <pre className="font-mono text-xs whitespace-pre-wrap text-fg-muted">
                {preview.bodyText}
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR" });

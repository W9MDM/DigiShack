import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { GatewayBadge } from "@/components/qsl/GatewayBadge";
import { QUEUE_STATUS, type QslQueueEntry } from "@/components/qsl/queue-types";
import { Badge, Button } from "@/components/ui/primitives";
import { rulesFor } from "@/lib/qsl/gateways";
import { formatUtc } from "@/lib/time";

type CardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; url: string }
  | { kind: "error"; message: string };

/**
 * The card design, on request.
 *
 * The card for THIS contact cannot be shown: it is not stored with the message, it is
 * drawn at send time, and the only per-contact card URL needs a server-signed token.
 * /api/qsl/card-preview draws the current design with the latest logged contact, and the
 * caption says exactly that. Loaded on click, because each one is a sharp render.
 */
function CardDesign({ dropped }: { dropped: boolean }) {
  const [card, setCard] = useState<CardState>({ kind: "idle" });

  useEffect(() => {
    if (card.kind !== "ok") return;
    const url = card.url;
    return () => URL.revokeObjectURL(url);
  }, [card]);

  async function load() {
    setCard({ kind: "loading" });
    try {
      const r = await fetch("/api/qsl/card-preview", { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) {
        // 422 carries the reason as text, usually "artwork not found" with the setting named.
        const text = (await r.text().catch(() => "")).slice(0, 300);
        setCard({ kind: "error", message: text || `The card could not be drawn (${r.status}).` });
        return;
      }
      setCard({ kind: "ok", url: URL.createObjectURL(await r.blob()) });
    } catch {
      setCard({ kind: "error", message: "Could not reach the server for the card design." });
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-subtle">Card</h3>
      <p className="text-sm text-fg-muted">
        {dropped
          ? "This address gets a link to the card rather than the image itself."
          : "The card image is drawn when the message is sent, from your card design at that moment, so it is not stored with the message."}
      </p>
      {card.kind === "ok" ? (
        <figure className="flex flex-col gap-1">
          {/* A blob URL from our own endpoint; next/image adds nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={card.url}
            alt="Your current QSL card design"
            className="w-full rounded-sm border border-line"
          />
          <figcaption className="text-xs text-fg-subtle">
            Drawn with your most recent logged contact, not this one.
          </figcaption>
        </figure>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" loading={card.kind === "loading"} onClick={() => void load()}>
            Show the card design
          </Button>
          {card.kind === "error" && <p className="text-sm text-warn">{card.message}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * One queued message, as the recipient will read it.
 *
 * A native <dialog> opened with showModal(): focus is trapped, Escape closes, and the page
 * behind is inert, none of which a positioned div gives. The effect never calls close() —
 * under StrictMode that fires `close` and would unmount the dialog it just opened.
 * Removing an open dialog from the document ends its modal state on its own.
 */
export function QslPreviewDialog({
  entry,
  onClose,
}: {
  entry: QslQueueEntry;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const rules = rulesFor(entry.toAddress);
  const status = QUEUE_STATUS[entry.status] ?? { label: entry.status, tone: "neutral" as const };

  const history: [string, string][] = [["Queued", formatUtc(entry.createdAt)]];
  if (entry.approvedAt) {
    history.push([
      "Approved",
      `${formatUtc(entry.approvedAt)} · ${entry.approvedBy ? `by ${entry.approvedBy.name}` : "automatically"}`,
    ]);
  }
  if (entry.sentAt) history.push(["Sent", formatUtc(entry.sentAt)]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the dialog element itself is a click on the backdrop: the content
      // below fills the box edge to edge.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-auto w-[min(44rem,calc(100vw-2rem))] max-w-none rounded-md border border-line bg-surface p-0 text-fg shadow-panel backdrop:bg-bg/80"
    >
      <div className="flex max-h-[min(85vh,56rem)] flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="font-display text-lg tracking-wide">
                {entry.callsign}
              </h2>
              <Badge tone={status.tone} size="sm">
                {status.label}
              </Badge>
            </div>
            <p className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
              <span className="truncate">To {entry.toAddress}</span>
              <GatewayBadge address={entry.toAddress} />
            </p>
            {entry.qso && (
              <p className="tnum text-xs text-fg-subtle">
                {entry.qso.band} · {entry.qso.mode} · {formatUtc(entry.qso.startTime)}
                {entry.qso.gridSquare ? ` · ${entry.qso.gridSquare}` : ""}
              </p>
            )}
          </div>
          <Button size="sm" onClick={onClose} autoFocus>
            Close
          </Button>
        </header>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
          {entry.status === "FAILED" && entry.error && (
            <p className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              The mail server refused it: {entry.error}
            </p>
          )}
          {rules.notes.length > 0 && (
            <p className="text-sm text-fg-muted">{rules.notes.join(" ")}</p>
          )}

          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-fg-subtle">Subject</h3>
            <p className="text-sm break-words">{entry.subject}</p>
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-fg-subtle">
              Message{rules.plainTextOnly ? " (sent as plain text only)" : " (text version)"}
            </h3>
            <pre className="whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-2 p-3 font-mono text-[13px] leading-relaxed text-fg-muted">
              {entry.bodyText}
            </pre>
          </section>

          <CardDesign dropped={rules.dropCard} />

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {history.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-fg-subtle">{k}</dt>
                <dd className="tnum text-fg-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </dialog>
  );
}

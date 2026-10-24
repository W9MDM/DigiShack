import Link from "next/link";
import { useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { ApiError, apiPatch, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatUtc, formatUtcDate } from "@/lib/time";

// Received QSL cards, as the browser sees them: the shapes /api/qsl/received returns, the
// enlarge dialog, the assign-to-a-contact control, and the panel on the contact page.
//
// Types are restated here rather than imported from the API route, which reaches Prisma and
// the filesystem and must never be pulled into a page bundle (scripts/check-client-bundle.ts).

export type ReceivedKind = "CARD" | "REPLY" | "NOTICE" | "BOUNCE";
export type ReceivedMatch = "MATCHED" | "AMBIGUOUS" | "UNMATCHED" | "DISMISSED";

export interface ReceivedQso {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: string;
}

export interface ReceivedRow {
  id: string;
  kind: ReceivedKind;
  callsign: string;
  sender: string;
  subject: string;
  receivedAt: string;
  imageUrl: string | null;
  imageContentType: string | null;
  imageBytes: number | null;
  fileName: string | null;
  link: string | null;
  matchStatus: ReceivedMatch;
  matchNote: string | null;
  qso: ReceivedQso | null;
}

export const KIND_LABEL: Record<ReceivedKind, string> = {
  CARD: "Card",
  REPLY: "Reply to our card",
  NOTICE: "Waiting on a website",
  BOUNCE: "Our card bounced",
};

export function MatchBadge({ status }: { status: ReceivedMatch }) {
  const tone = status === "MATCHED" ? "ok" : status === "AMBIGUOUS" ? "warn" : "neutral";
  const word = status === "MATCHED" ? "Matched" : status === "AMBIGUOUS" ? "Ambiguous" : status === "UNMATCHED" ? "Unmatched" : "Dismissed";
  return (
    <Badge size="sm" tone={tone}>
      {word}
    </Badge>
  );
}

export function qsoLine(q: ReceivedQso): string {
  return `${q.band} ${q.mode} · ${formatUtc(q.startTime)}`;
}

/** A link only ever goes out as http(s), opened apart from this page. */
export function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
  let ok = false;
  try {
    const u = new URL(href);
    ok = u.protocol === "https:" || u.protocol === "http:";
  } catch {
    ok = false;
  }
  if (!ok) return <span className="text-fg-subtle">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-bright break-all hover:underline">
      {children}
    </a>
  );
}

/** The thumbnail, which opens the full card. */
export function CardThumb({ row, className }: { row: ReceivedRow; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!row.imageUrl) return null;
  const label = `QSL card from ${row.callsign || row.sender}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Enlarge the ${label}`}
        className={`block w-full overflow-hidden rounded-sm border border-line bg-surface-2 ${className ?? ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- an authed API image; next/image would proxy it */}
        <img src={row.imageUrl} alt={label} loading="lazy" className="aspect-[3/2] w-full object-cover" />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={row.callsign ? `Card from ${row.callsign}` : "Received card"}
        description={`${KIND_LABEL[row.kind]} · received ${formatUtc(row.receivedAt)} from ${row.sender}`}
        size="lg"
        footer={
          <>
            <a href={row.imageUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-bright hover:underline">
              Open full size
            </a>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </>
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
        <img src={row.imageUrl} alt={label} className="h-auto max-h-[70dvh] w-full object-contain" />
        {row.fileName && <p className="mt-2 break-all text-xs text-fg-subtle">{row.fileName}</p>}
      </Dialog>
    </>
  );
}

interface CandidatesResponse {
  candidates: ReceivedQso[];
}

/**
 * Link a card to a contact by hand: look the station up, pick the contact. Or dismiss it.
 *
 * Starts from the callsign the importer read, which is right far more often than not; the
 * operator can change it when the card was read wrongly or not at all.
 */
export function AssignPanel({ row, onChanged }: { row: ReceivedRow; onChanged: () => void }) {
  const canEdit = useCan("OPERATOR");
  const [call, setCall] = useState(row.callsign);
  const [searched, setSearched] = useState<string | null>(row.callsign || null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const found = useApi<CandidatesResponse>(searched ? `/api/qsl/received?call=${encodeURIComponent(searched)}` : null);

  if (!canEdit) return null;

  async function act(body: { action: "assign"; qsoId: string } | { action: "dismiss" } | { action: "unlink" }) {
    setBusy(body.action === "assign" ? body.qsoId : body.action);
    setError(null);
    try {
      await apiPatch(`/api/qsl/received/${row.id}`, body);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  const list = found.data?.candidates ?? [];
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearched(call.trim().toUpperCase() || null);
        }}
      >
        <Input
          aria-label="Callsign to look up"
          value={call}
          onChange={(e) => setCall(e.target.value)}
          placeholder="Callsign"
          className="w-36 font-mono uppercase"
        />
        <Button type="submit" size="sm">
          Find contacts
        </Button>
        {row.matchStatus !== "DISMISSED" && (
          <Button size="sm" variant="ghost" loading={busy === "dismiss"} disabled={busy !== null} onClick={() => void act({ action: "dismiss" })}>
            Dismiss
          </Button>
        )}
      </form>
      {searched && found.data && list.length === 0 && (
        <p className="text-sm text-fg-subtle">No contact with {searched} in the log.</p>
      )}
      {list.length > 0 && (
        <ul className="flex flex-col gap-1">
          {list.map((q) => (
            <li key={q.id}>
              <Button
                size="sm"
                variant={row.qso?.id === q.id ? "primary" : "secondary"}
                className="w-full justify-start font-mono"
                loading={busy === q.id}
                disabled={busy !== null}
                onClick={() => void act({ action: "assign", qsoId: q.id })}
              >
                {q.callsign} · {qsoLine(q)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/** "This was the wrong contact": back to the review list. */
export function UnlinkButton({ row, onChanged }: { row: ReceivedRow; onChanged: () => void }) {
  const canEdit = useCan("OPERATOR");
  const [busy, setBusy] = useState(false);
  if (!canEdit || row.matchStatus !== "MATCHED" || row.kind === "BOUNCE") return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      onClick={() => {
        setBusy(true);
        void apiPatch(`/api/qsl/received/${row.id}`, { action: "unlink" })
          .then(onChanged)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      Not this contact
    </Button>
  );
}

/** On the contact page: the cards this station sent us for this contact, if any. */
export function ContactReceivedCards({ qsoId }: { qsoId: string }) {
  const { data, reload } = useApi<{ rows: ReceivedRow[] }>(`/api/qsl/received?qsoId=${encodeURIComponent(qsoId)}`);
  const rows = data?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <Card title="Received QSL" actions={<Badge size="sm">{rows.length}</Badge>}>
      <ul className="flex flex-col gap-4">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2">
            <CardThumb row={r} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge size="sm" tone={r.kind === "BOUNCE" ? "warn" : "neutral"}>
                {KIND_LABEL[r.kind]}
              </Badge>
              <span className="tnum text-fg-subtle">{formatUtcDate(r.receivedAt)}</span>
            </div>
            <p className="break-all text-xs text-fg-subtle">From {r.sender}</p>
            {r.link && (
              <p className="text-sm">
                <SafeLink href={r.link}>See the card on the website</SafeLink>
              </p>
            )}
            {r.matchNote && <p className="text-xs text-fg-subtle">{r.matchNote}</p>}
            <div>
              <UnlinkButton row={r} onChanged={() => void reload()} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-fg-subtle">
        <Link href="/qsl/received" className="text-accent-bright hover:underline">
          All received cards
        </Link>
      </p>
    </Card>
  );
}

// A mailbox the card importer can read, whoever runs it.
//
// Two implementations: Microsoft 365 through Graph (graph-source.ts) and any IMAP server
// (imap-source.ts). The importer sees only this, so the rules about what is a card, what is
// ours and which contact it belongs to are written once.
//
// Every method READS. There is deliberately no way to mark, move or delete through this
// interface — an importer that cannot express a write cannot perform one by mistake.

import { createHash } from "node:crypto";

import type { MailSummary } from "@/lib/qsl/inbound/classify";

export interface SourceMessage {
  /** Stable identity for idempotency: the RFC 5322 Message-ID where there is one. */
  key: string;
  folder: string;
  receivedAt: Date;
  summary: MailSummary;
}

export interface SourceAttachment {
  /** Stable within the message — see attachmentKey. */
  key: string;
  name: string;
  contentType: string;
  /** As the service reports it; the bytes are still capped when read. */
  size: number;
  inline: boolean;
}

export interface MailSource {
  /** "Microsoft 365 (station@example.com)", for the report. */
  readonly label: string;
  /** The folders to read, in order. */
  folders(): string[];
  /** Messages received at or after `since`, oldest first. */
  list(folder: string, since: Date): AsyncIterable<SourceMessage>;
  /** The body, HTML or text, for finding a notice's link. Capped by the source. */
  body(m: SourceMessage): Promise<string>;
  attachments(m: SourceMessage): Promise<SourceAttachment[]>;
  /** The attachment's bytes, or null when it is larger than `max`. */
  attachmentBytes(m: SourceMessage, a: SourceAttachment, max: number): Promise<Uint8Array | null>;
  close?(): Promise<void>;
}

/** Longest key the ReceivedQsl.messageId column holds. */
const KEY_MAX = 191;

/**
 * The idempotency key for a message.
 *
 * The Message-ID header, because it is the one identity that survives the message being
 * moved between folders, re-fetched by another protocol, or the provider being switched.
 * Hashed when it is longer than the column rather than truncated — two truncated IDs can
 * collide, two hashes will not.
 */
export function messageKey(internetMessageId: string | null | undefined, fallback: string): string {
  const raw = (internetMessageId ?? "").trim() || fallback;
  return raw.length <= KEY_MAX ? raw : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * The idempotency key for one picture within a message: its name, and which of the
 * same-named parts it is. Not the provider's attachment id, which differs between Graph and
 * IMAP and changes with the message's folder in Graph.
 */
export function attachmentKey(name: string, nth: number): string {
  return createHash("sha256").update(`${name.toLowerCase()}#${nth}`).digest("hex").slice(0, 40);
}

/**
 * Read a response body, stopping as soon as it passes `max`.
 *
 * A Content-Length can be absent or wrong, so the count is of bytes actually arriving: a
 * hostile or broken server cannot make the importer hold more than `max` + one chunk.
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// The card importer: read a mailbox, keep what is a QSL, match it to the log.
//
// The mailbox, the database and the image store are all passed in (MailSource, InboundStore),
// so scripts/check-qsl-inbound.ts runs this exact code against fixtures and an in-memory store
// — including running it twice to prove the second run adds nothing.
//
// IDEMPOTENT by construction, at two levels:
//   * a message already imported (any row with its Message-ID) is skipped before anything is
//     downloaded, which is what makes a re-run cheap;
//   * every row carries (messageId, attachmentKey), unique in the database, so even two
//     importers racing — the bridge's timer and an "Import now" in the web process — cannot
//     store one card twice. The loser's image file is deleted.
//
// RESUMABLE: each folder is read oldest first, and the report carries the newest message
// fully handled in each. A run that stops part way — the per-run cap, a throttle, a crash —
// resumes from there. A message that failed half way holds that folder's mark where it was,
// so it is retried rather than stepped over.

import { randomBytes } from "node:crypto";

import {
  callFromAddress,
  callsInFilename,
  classifyMessage,
  extractLinks,
  isOwnCall,
  isOwnCardFile,
  MAX_IMAGE_BYTES,
  mightBeImage,
  parseCardFilename,
  pickNoticeLink,
  siteOfLink,
  sniffImage,
  type Classification,
  type FileHints,
  type ImageCheck,
} from "@/lib/qsl/inbound/classify";
import { matchQso, type MatchResult, type QsoCandidate, type SentCard } from "@/lib/qsl/inbound/match";
import type { NoticeImageResult } from "@/lib/qsl/inbound/notice";
import type { MailSource, SourceAttachment, SourceMessage } from "@/lib/qsl/inbound/source";

export type ReceivedKind = "CARD" | "REPLY" | "NOTICE" | "BOUNCE";

export interface NewReceived {
  id: string;
  qsoId: string | null;
  callsign: string;
  kind: ReceivedKind;
  sender: string;
  subject: string;
  messageId: string;
  attachmentKey: string;
  receivedAt: Date;
  imagePath: string | null;
  imageContentType: string | null;
  imageBytes: number | null;
  fileName: string | null;
  link: string | null;
  matchStatus: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  matchNote: string;
  /** Mark the contact as having received an emailed card. False for bounces and bare notices. */
  confirms: boolean;
}

export interface InboundStore {
  hasMessage(messageId: string): Promise<boolean>;
  candidatesFor(callsign: string): Promise<QsoCandidate[]>;
  sentCardsFor(callsign: string): Promise<SentCard[]>;
  /** Our emailed card a bounce is about: the latest SENT one to that call before the bounce. */
  bouncedCard(callsign: string, before: Date): Promise<{ qslEmailId: string; qsoId: string } | null>;
  /** Store the picture; returns the relative path recorded on the row. */
  saveImage(id: string, bytes: Uint8Array, ext: string): Promise<string>;
  deleteImage(relPath: string): Promise<void>;
  /** False when (messageId, attachmentKey) already exists — another run got there first. */
  insert(row: NewReceived): Promise<boolean>;
}

export interface ImportOptions {
  mailbox: string;
  ownCalls: string[];
  /** Addresses this station sends from, wherever its mail now lives. See ClassifyContext. */
  ownAddresses?: string[];
  /** Per folder: read messages received at or after this. */
  since: Record<string, Date>;
  /** Stop after this many messages, so one run cannot go on for an hour. */
  maxMessages: number;
  now?: () => Date;
}

export interface ImportDeps {
  source: MailSource;
  store: InboundStore;
  fetchNoticeImage?: (link: string) => Promise<NoticeImageResult>;
}

export interface ImportReport {
  source: string;
  startedAt: string;
  finishedAt: string;
  /** Messages looked at. */
  scanned: number;
  /** Already imported by an earlier run. */
  alreadySeen: number;
  /** Our own outgoing cards. */
  own: number;
  /** Not about a QSL at all, or nothing usable in it. */
  ignored: number;
  cards: number;
  replies: number;
  notices: number;
  bounces: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  images: number;
  /** Attachments that were not usable pictures, with why. */
  rejected: string[];
  bounceList: { callsign: string | null; subject: string; at: string; note: string }[];
  ignoredSamples: string[];
  errors: string[];
  /** Per folder: the newest receivedAt fully handled. Absent when nothing was. */
  newest: Record<string, string>;
  /** False when the run stopped early (cap or failure); the next run continues. */
  complete: boolean;
  /** Set when the run could not proceed at all (sign-in refused, mailbox not readable). */
  error?: string;
  /** Moving imported mail into its own folder, when that is switched on. */
  filing?: { folder: string; moved: number; failed: number; error?: string };
}

/** An image id: random rather than a database default, so the file can be written first. */
export function newReceivedId(): string {
  return randomBytes(12).toString("hex");
}

function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
}

interface Picture {
  name: string;
  key: string;
  bytes: Uint8Array;
  check: Extract<ImageCheck, { ok: true }>;
}

/** Most pictures taken from one message. A real card email has one, occasionally front and back. */
const MAX_PICTURES = 4;

/** Inline images smaller than this are signature logos, not cards. */
const INLINE_MIN_BYTES = 15_000;

export async function importMailbox(deps: ImportDeps, opts: ImportOptions): Promise<ImportReport> {
  const now = opts.now ?? (() => new Date());
  const report: ImportReport = {
    source: deps.source.label,
    startedAt: now().toISOString(),
    finishedAt: "",
    scanned: 0,
    alreadySeen: 0,
    own: 0,
    ignored: 0,
    cards: 0,
    replies: 0,
    notices: 0,
    bounces: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    images: 0,
    rejected: [],
    bounceList: [],
    ignoredSamples: [],
    errors: [],
    newest: {},
    complete: true,
  };
  const ctx = { mailbox: opts.mailbox, ownCalls: opts.ownCalls, ownAddresses: opts.ownAddresses ?? [] };
  const candidateCache = new Map<string, QsoCandidate[]>();
  const candidates = async (call: string) => {
    let c = candidateCache.get(call);
    if (!c) {
      c = await deps.store.candidatesFor(call);
      candidateCache.set(call, c);
    }
    return c;
  };

  const ignore = (m: SourceMessage, why: string) => {
    report.ignored++;
    if (report.ignoredSamples.length < 15) report.ignoredSamples.push(`${m.summary.subject.slice(0, 80)} — ${why}`);
  };

  const pictures = async (m: SourceMessage, allowInline: boolean): Promise<Picture[]> => {
    if (!m.summary.hasAttachments) return [];
    const out: Picture[] = [];
    const atts: SourceAttachment[] = await deps.source.attachments(m);
    for (const a of atts) {
      if (out.length >= MAX_PICTURES) break;
      if (!mightBeImage(a.name, a.contentType)) continue;
      if (isOwnCardFile(a.name, opts.ownCalls)) {
        report.rejected.push(`${a.name}: our own card, sent back with the reply`);
        continue;
      }
      if (a.inline && !allowInline) continue;
      // Graph's size includes some overhead, so the declared size is only a pre-filter; the
      // bytes themselves are what the limit is enforced on.
      if (a.size > MAX_IMAGE_BYTES * 1.5) {
        report.rejected.push(`${a.name}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
        continue;
      }
      const bytes = await deps.source.attachmentBytes(m, a, MAX_IMAGE_BYTES);
      if (!bytes) {
        report.rejected.push(`${a.name}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
        continue;
      }
      const check = sniffImage(bytes);
      if (!check.ok) {
        report.rejected.push(`${a.name}: ${check.reason}`);
        continue;
      }
      if (a.inline && bytes.length < INLINE_MIN_BYTES) continue;
      out.push({ name: a.name, key: a.key, bytes, check });
    }
    return out;
  };

  /** Store one row, its picture first. True when it was new. */
  const store = async (row: Omit<NewReceived, "id" | "imagePath" | "imageContentType" | "imageBytes">, pic?: { bytes: Uint8Array; check: Extract<ImageCheck, { ok: true }> }): Promise<boolean> => {
    const id = newReceivedId();
    let imagePath: string | null = null;
    if (pic) imagePath = await deps.store.saveImage(id, pic.bytes, pic.check.ext);
    let inserted = false;
    try {
      inserted = await deps.store.insert({
        ...row,
        id,
        imagePath,
        imageContentType: pic ? pic.check.contentType : null,
        imageBytes: pic ? pic.bytes.length : null,
      });
    } finally {
      if (!inserted && imagePath) await deps.store.deleteImage(imagePath).catch(() => undefined);
    }
    if (inserted) {
      if (pic) report.images++;
      if (row.kind !== "BOUNCE") {
        if (row.matchStatus === "MATCHED") report.matched++;
        else if (row.matchStatus === "AMBIGUOUS") report.ambiguous++;
        else report.unmatched++;
      }
    }
    return inserted;
  };

  const base = (m: SourceMessage) => ({
    sender: m.summary.from.slice(0, 191),
    subject: m.summary.subject.slice(0, 255),
    messageId: m.key,
    receivedAt: m.receivedAt,
  });

  const match = async (call: string | null, kind: "card" | "reply" | "notice", m: SourceMessage, hints: FileHints): Promise<MatchResult> => {
    if (!call) return matchQso({ callsign: null, kind, receivedAt: m.receivedAt, hints }, []);
    const sentCards = kind === "reply" ? await deps.store.sentCardsFor(call) : undefined;
    return matchQso({ callsign: call, kind, receivedAt: m.receivedAt, hints, sentCards }, await candidates(call));
  };

  const handle = async (m: SourceMessage): Promise<void> => {
    let c: Classification = classifyMessage(m.summary, ctx);
    // A bounce whose preview does not quote our card: the body usually does.
    if (c.kind === "ignore" && c.reason === "a bounce that does not mention a QSL") {
      const body = stripTags(await deps.source.body(m)).slice(0, 20_000);
      c = classifyMessage({ ...m.summary, preview: body }, ctx);
    }

    switch (c.kind) {
      case "own":
        report.own++;
        return;
      case "ignore":
        ignore(m, c.reason);
        return;

      case "bounce": {
        report.bounces++;
        const card = c.callsign ? await deps.store.bouncedCard(c.callsign, m.receivedAt) : null;
        const note = card
          ? `Our emailed card to ${c.callsign} bounced: ${m.summary.subject}`
          : c.callsign
            ? `A bounce about ${c.callsign}, but no emailed card to them was found.`
            : "A bounce of a QSL email; the message does not say which station.";
        // Recorded as a BOUNCE row linked to the contact, and listed in the report — NOT
        // written onto the QslEmail row. Its `error` column on a SENT row is the send claim
        // ("sending since …", see lib/qsl/queue.ts), and a second meaning in that column is
        // how a claim check one day reads a bounce as a send in flight.
        report.bounceList.push({ callsign: c.callsign, subject: m.summary.subject.slice(0, 160), at: m.receivedAt.toISOString(), note });
        await store({
          ...base(m),
          qsoId: card?.qsoId ?? null,
          callsign: c.callsign ?? "",
          kind: "BOUNCE",
          attachmentKey: "",
          fileName: null,
          link: null,
          matchStatus: card ? "MATCHED" : "UNMATCHED",
          matchNote: note,
          confirms: false,
        });
        return;
      }

      case "reply": {
        report.replies++;
        const pics = await pictures(m, true);
        if (pics.length === 0) {
          const r = await match(c.callsign, "reply", m, {});
          await store({
            ...base(m),
            qsoId: r.qsoId,
            callsign: c.callsign,
            kind: "REPLY",
            attachmentKey: "",
            fileName: null,
            link: null,
            matchStatus: r.status,
            matchNote: r.note,
            confirms: true,
          });
          return;
        }
        for (const p of pics) {
          const r = await match(c.callsign, "reply", m, parseCardFilename(p.name));
          await store(
            { ...base(m), qsoId: r.qsoId, callsign: c.callsign, kind: "REPLY", attachmentKey: p.key, fileName: p.name.slice(0, 255), link: null, matchStatus: r.status, matchNote: r.note, confirms: true },
            p,
          );
        }
        return;
      }

      case "notice": {
        report.notices++;
        const body = await deps.source.body(m);
        const link = pickNoticeLink(extractLinks(body), c.site);
        const site = c.site !== "other" ? c.site : link ? siteOfLink(link) : "other";
        let pic: { bytes: Uint8Array; check: Extract<ImageCheck, { ok: true }> } | undefined;
        let why = "";
        if (link && (site === "digiqsl" || site === "qslworld") && deps.fetchNoticeImage) {
          const got = await deps.fetchNoticeImage(link);
          if (got.ok) pic = { bytes: got.bytes, check: got.check };
          else why = ` The card was not fetched: ${got.reason}.`;
        } else if (site === "eqsl") {
          why = " eQSL cards need your eQSL login, which this importer does not use — the eQSL inbox sync (Settings → eQSL.cc) records those confirmations.";
        }
        const call = c.callsign;
        const r = await match(call, "notice", m, {});
        await store(
          {
            ...base(m),
            qsoId: r.qsoId,
            callsign: call ?? "",
            kind: "NOTICE",
            attachmentKey: pic ? "link" : "",
            fileName: null,
            link,
            matchStatus: r.status,
            matchNote: `${r.note}${link ? "" : " No link was found in the notice."}${why}`,
            // A notice alone is a promise of a card; with the card in hand it is a card.
            confirms: Boolean(pic),
          },
          pic,
        );
        return;
      }

      case "card": {
        const pics = await pictures(m, c.callsign !== null);
        const fallbackCall =
          c.callsign ??
          pics.map((p) => callsInFilename(p.name, opts.ownCalls)[0]).find(Boolean) ??
          callFromAddress(m.summary.from, opts.ownCalls);
        if (!fallbackCall && pics.length === 0) {
          ignore(m, "no callsign and no picture");
          return;
        }
        report.cards++;
        if (pics.length === 0) {
          const r = await match(fallbackCall, "card", m, {});
          await store({
            ...base(m),
            qsoId: r.qsoId,
            callsign: fallbackCall ?? "",
            kind: "CARD",
            attachmentKey: "",
            fileName: null,
            link: null,
            matchStatus: r.status,
            matchNote: `${r.note} No picture was attached.`,
            confirms: true,
          });
          return;
        }
        for (const p of pics) {
          const fromFile = callsInFilename(p.name, opts.ownCalls)[0];
          const call = c.callsign ?? fromFile ?? fallbackCall;
          const safeCall = call && !isOwnCall(call, opts.ownCalls) ? call : null;
          const r = await match(safeCall, "card", m, parseCardFilename(p.name));
          await store(
            { ...base(m), qsoId: r.qsoId, callsign: safeCall ?? "", kind: "CARD", attachmentKey: p.key, fileName: p.name.slice(0, 255), link: null, matchStatus: r.status, matchNote: r.note, confirms: true },
            p,
          );
        }
        return;
      }
    }
  };

  try {
    outer: for (const folder of deps.source.folders()) {
      const since = opts.since[folder];
      if (!since) continue;
      let held = false;
      for await (const m of deps.source.list(folder, since)) {
        if (report.scanned >= opts.maxMessages) {
          report.complete = false;
          break outer;
        }
        report.scanned++;
        try {
          if (await deps.store.hasMessage(m.key)) report.alreadySeen++;
          else await handle(m);
          if (!held) report.newest[folder] = m.receivedAt.toISOString();
        } catch (err) {
          // One bad message does not stop the run, but the folder's mark stops here so the
          // message is tried again next time instead of being stepped over.
          held = true;
          report.complete = false;
          const why = err instanceof Error ? err.message : String(err);
          if (report.errors.length < 20) report.errors.push(`${m.summary.subject.slice(0, 80)}: ${why}`);
          // A refusal of the whole mailbox will refuse every message; stop rather than repeat it.
          if (/\((401|403|404|429)\)/.test(why)) {
            report.error = why;
            break outer;
          }
        }
      }
    }
  } catch (err) {
    // Listing itself failed: sign-in refused, the mailbox not readable, throttled past the
    // retries. Nothing after this point would fare better.
    report.error = err instanceof Error ? err.message : String(err);
    report.complete = false;
  }

  report.finishedAt = now().toISOString();
  return report;
}

/** One line for the marker, the log and the page. */
export function describeImport(r: ImportReport): string {
  if (r.error) return `failed: ${r.error}`;
  const parts = [
    `${r.scanned} message(s) read`,
    r.cards + r.replies + r.notices > 0
      ? `${r.cards} card(s), ${r.replies} reply(ies), ${r.notices} notice(s): ${r.matched} matched, ${r.ambiguous} ambiguous, ${r.unmatched} unmatched`
      : "no new cards",
  ];
  if (r.bounces > 0) parts.push(`${r.bounces} bounce(s)`);
  if (r.errors.length > 0) parts.push(`${r.errors.length} error(s)`);
  if (r.filing?.error) parts.push(`not moved to ${r.filing.folder}: ${r.filing.error}`);
  else if (r.filing && r.filing.moved > 0) parts.push(`${r.filing.moved} moved to ${r.filing.folder}`);
  if (!r.complete) parts.push("more to read next run");
  return parts.join("; ");
}

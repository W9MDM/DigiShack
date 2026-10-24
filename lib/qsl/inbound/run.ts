// Running the card importer for real: settings, the database, image files, a lock, and the
// marker that lets a page say when it last ran.
//
// Called from two places — the radio service's timer and the "Import now" button in the web
// process — so it takes a lock in the database, not in memory: two processes do not share
// memory, and two importers on one mailbox would race to store the same card. The unique
// (messageId, attachmentKey) index would stop the duplicate anyway; the lock stops the wasted
// downloads.
//
// THE MARKER is written by this function on every exit, like `eqsl.lastSyncAt`: the thing
// that knows a run happened is the thing that records it. State, not configuration, so these
// keys are deliberately absent from the settings registry.

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { GraphClient } from "@/lib/mail/graph";
import { getReceiveProvider, loadGraphConfig, type ReceiveProvider } from "@/lib/mail/providers";
import { baseCall, isCallsign } from "@/lib/qsl/inbound/classify";
import { GraphMailSource, testGraphMailbox } from "@/lib/qsl/inbound/graph-source";
import { describeImport, importMailbox, type ImportReport, type InboundStore, type NewReceived } from "@/lib/qsl/inbound/import";
import { fetchNoticeImage } from "@/lib/qsl/inbound/notice";
import type { MailSource } from "@/lib/qsl/inbound/source";
import { getBooleanSetting, getSetting } from "@/lib/settings";

const KEY_LAST_RUN = "qsl.inbound.lastRunAt";
const KEY_LAST_REPORT = "qsl.inbound.lastReport";
const KEY_CURSOR = "qsl.inbound.cursor";
const KEY_LOCK = "qsl.inbound.lock";

/** A lock older than this belongs to a run that died; it is taken over. */
const LOCK_STALE_MS = 30 * 60_000;
/** Messages per run. The first run on a busy mailbox takes several; each resumes. */
const MAX_MESSAGES_PER_RUN = 400;
/** Re-read this much before the mark, for mail that arrived out of order. Seen ones are skipped. */
const OVERLAP_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Where the pictures live
// ---------------------------------------------------------------------------

export const IMAGE_DIR = "data/qsl-received";
const IMAGE_PATH_RE = /^data\/qsl-received\/([0-9a-f]{24})\.(jpg|png|gif|webp)$/;

/**
 * The file for a stored image path — or null for anything that is not exactly the shape this
 * module writes. The path comes from the database, and the database is not trusted to name a
 * file: no "..", no absolute path, no other directory, whatever ends up in that column.
 */
export function imageFile(rel: string | null): string | null {
  if (!rel) return null;
  const m = IMAGE_PATH_RE.exec(rel);
  if (!m) return null;
  return path.join(process.cwd(), "data", "qsl-received", `${m[1]}.${m[2]}`);
}

async function saveImage(id: string, bytes: Uint8Array, ext: string): Promise<string> {
  const rel = `${IMAGE_DIR}/${id}.${ext}`;
  const abs = imageFile(rel);
  if (!abs) throw new Error("refusing to write an image under an unexpected name");
  await mkdir(path.dirname(abs), { recursive: true });
  // "wx": never overwrite. The id is random, so an existing file means something is wrong.
  await writeFile(abs, bytes, { flag: "wx" });
  return rel;
}

async function deleteImage(rel: string): Promise<void> {
  const abs = imageFile(rel);
  if (abs) await unlink(abs).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The contact's summary flag
// ---------------------------------------------------------------------------

/**
 * Set `emailQslRcvd` from the cards actually linked to the contact.
 *
 * Recomputed rather than toggled, so assigning, unlinking and re-importing all leave it
 * right: true while any matched card or reply (or a notice with its picture) is linked, with
 * the earliest one's arrival as the date. Touches no other confirmation field — LoTW, eQSL
 * and the paper-card status are left exactly as they were.
 */
export async function refreshEmailCardFlag(qsoId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<void> {
  const first = await db.receivedQsl.findFirst({
    where: {
      qsoId,
      matchStatus: "MATCHED",
      OR: [{ kind: { in: ["CARD", "REPLY"] } }, { kind: "NOTICE", imagePath: { not: null } }],
    },
    orderBy: { receivedAt: "asc" },
    select: { receivedAt: true },
  });
  await db.qso.updateMany({
    where: { id: qsoId },
    data: first ? { emailQslRcvd: true, emailQslRcvdAt: first.receivedAt } : { emailQslRcvd: false, emailQslRcvdAt: null },
  });
}

// ---------------------------------------------------------------------------
// The database side of the importer
// ---------------------------------------------------------------------------

async function sameStation<T extends { callsign: string }>(rows: T[], call: string): Promise<T[]> {
  const b = baseCall(call);
  return rows.filter((r) => baseCall(r.callsign) === b);
}

export const prismaStore: InboundStore = {
  async hasMessage(messageId) {
    return (await prisma.receivedQsl.findFirst({ where: { messageId }, select: { id: true } })) !== null;
  },
  async candidatesFor(call) {
    const rows = await prisma.qso.findMany({
      where: { callsign: { contains: baseCall(call) } },
      select: { id: true, callsign: true, band: true, mode: true, startTime: true },
      orderBy: { startTime: "desc" },
      take: 500,
    });
    return sameStation(rows, call);
  },
  async sentCardsFor(call) {
    const rows = await prisma.qslEmail.findMany({
      where: { callsign: { contains: baseCall(call) }, status: "SENT" },
      select: { qsoId: true, callsign: true, sentAt: true, createdAt: true },
      take: 200,
    });
    return (await sameStation(rows, call)).map((r) => ({ qsoId: r.qsoId, at: r.sentAt ?? r.createdAt }));
  },
  async bouncedCard(call, before) {
    const rows = await prisma.qslEmail.findMany({
      where: { callsign: { contains: baseCall(call) }, status: "SENT" },
      select: { id: true, qsoId: true, callsign: true, sentAt: true, createdAt: true },
      take: 200,
    });
    const mine = (await sameStation(rows, call))
      .map((r) => ({ ...r, at: r.sentAt ?? r.createdAt }))
      .filter((r) => r.at.getTime() <= before.getTime())
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    const latest = mine[0];
    return latest ? { qslEmailId: latest.id, qsoId: latest.qsoId } : null;
  },
  saveImage,
  deleteImage,
  async insert(row: NewReceived) {
    const { confirms, ...data } = row;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.receivedQsl.create({ data });
        if (confirms && data.qsoId && data.matchStatus === "MATCHED") await refreshEmailCardFlag(data.qsoId, tx);
      });
      return true;
    } catch (err) {
      // Another importer stored this exact card first. Not an error: the card is in.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Settings and state
// ---------------------------------------------------------------------------

/** Every callsign this station operates as, plus the mailbox's own name when it is one. */
async function ownCalls(mailbox: string): Promise<string[]> {
  const [stations, operators] = await Promise.all([
    prisma.station.findMany({ select: { callsign: true } }),
    prisma.operator.findMany({ select: { callsign: true } }),
  ]);
  const set = new Set<string>();
  for (const r of [...stations, ...operators]) if (r.callsign) set.add(r.callsign.toUpperCase());
  const local = (mailbox.split("@")[0] ?? "").toUpperCase();
  if (isCallsign(local)) set.add(local);
  return [...set];
}

async function putState(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value, encrypted: false },
    update: { value },
  });
}

async function readCursor(): Promise<Record<string, string>> {
  const raw = (await prisma.setting.findUnique({ where: { key: KEY_CURSOR } }))?.value;
  try {
    const j = raw ? (JSON.parse(raw) as unknown) : {};
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The configured start date, or thirty days ago when none is set. */
export function parseStartDate(raw: string | null, now: Date): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? "").trim());
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now.getTime() - 30 * 86_400_000);
}

async function takeLock(): Promise<boolean> {
  const value = JSON.stringify({ at: new Date().toISOString(), pid: process.pid });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.setting.create({ data: { key: KEY_LOCK, value, encrypted: false } });
      return true;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const held = await prisma.setting.findUnique({ where: { key: KEY_LOCK } });
      let at = NaN;
      try {
        at = held ? Date.parse((JSON.parse(held.value) as { at?: string }).at ?? "") : NaN;
      } catch {
        /* unreadable: treated as stale */
      }
      if (Number.isFinite(at) && Date.now() - at < LOCK_STALE_MS) return false;
      // Stale: whoever held it died mid-run. Only the exact stale row is removed, so two
      // takers cannot both delete and both win.
      await prisma.setting.deleteMany({ where: { key: KEY_LOCK, value: held?.value ?? "" } });
    }
  }
  return false;
}

async function dropLock(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY_LOCK } }).catch(() => undefined);
}

export interface InboundLastRun {
  at: string | null;
  report: ImportReport | null;
}

export async function getInboundLastRun(): Promise<InboundLastRun> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [KEY_LAST_RUN, KEY_LAST_REPORT] } },
    select: { key: true, value: true },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value || null;
  let report: ImportReport | null = null;
  try {
    const raw = get(KEY_LAST_REPORT);
    report = raw ? (JSON.parse(raw) as ImportReport) : null;
  } catch {
    report = null;
  }
  return { at: get(KEY_LAST_RUN), report };
}

/**
 * IMAP and Gmail are in the settings and behind the same interface, and are NOT yet run.
 *
 * Microsoft 365 is the mailbox in use today and ships first. The IMAP client and MIME reader
 * exist (lib/mail/imap.ts, lib/mail/mime.ts) and are checked against recorded transcripts, but
 * have not met a live server; until they have, choosing them says so rather than importing.
 */
export const IMAP_COMING_NEXT =
  "Importing from IMAP and Gmail / Google Workspace is coming in the next release. " +
  "Choose Microsoft 365 for now (Settings → QSL → Received cards).";

/** The addresses this station sends from, for recognising its own cards wherever they turn up. */
async function ownAddresses(mailbox: string): Promise<string[]> {
  const out = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const addr = (/<([^>]+)>/.exec(raw ?? "")?.[1] ?? raw ?? "").trim().toLowerCase();
    if (addr.includes("@")) out.add(addr);
  };
  add(mailbox);
  add(await getSetting("smtp.from"));
  add(await getSetting("smtp.user"));
  add(await getSetting("ms365.mailbox"));
  add(await getSetting("imap.user"));
  return [...out];
}

async function openSource(provider: ReceiveProvider): Promise<{ ok: true; source: MailSource; mailbox: string } | { ok: false; reason: string }> {
  if (provider !== "graph") return { ok: false, reason: IMAP_COMING_NEXT };
  const loaded = await loadGraphConfig();
  if (!loaded.ok) return loaded;
  return { ok: true, source: new GraphMailSource(new GraphClient(loaded.config)), mailbox: loaded.config.mailbox };
}

export interface InboundRunResult {
  ran: boolean;
  reason?: string;
  report?: ImportReport;
  summary?: string;
}

/**
 * One import pass. `manual` is the Import now button: it runs whether or not the timer is
 * switched on, because pressing a button is the operator deciding.
 */
export async function runInboundImport(opts: { manual?: boolean } = {}): Promise<InboundRunResult> {
  if (!opts.manual && !(await getBooleanSetting("qsl.inbound.enabled", false))) {
    return { ran: false, reason: "Importing received cards is off." };
  }
  const provider = await getReceiveProvider();
  const opened = await openSource(provider);
  if (!opened.ok) return { ran: false, reason: opened.reason };

  if (!(await takeLock())) {
    await opened.source.close?.();
    return { ran: false, reason: "An import is already running." };
  }

  let report: ImportReport;
  try {
    const now = new Date();
    const start = parseStartDate(await getSetting("qsl.inbound.startDate"), now);
    const cursor = await readCursor();
    const since: Record<string, Date> = {};
    for (const folder of opened.source.folders()) {
      const mark = cursor[`${provider}:${folder}`];
      const t = mark ? Date.parse(mark) - OVERLAP_MS : NaN;
      since[folder] = Number.isFinite(t) && t > start.getTime() ? new Date(t) : start;
    }
    report = await importMailbox(
      { source: opened.source, store: prismaStore, fetchNoticeImage: (link) => fetchNoticeImage(link) },
      {
        mailbox: opened.mailbox,
        ownCalls: await ownCalls(opened.mailbox),
        ownAddresses: await ownAddresses(opened.mailbox),
        since,
        maxMessages: MAX_MESSAGES_PER_RUN,
      },
    );
    const next = { ...cursor };
    for (const [folder, iso] of Object.entries(report.newest)) next[`${provider}:${folder}`] = iso;
    await putState(KEY_CURSOR, JSON.stringify(next));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    report = {
      source: opened.source.label,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      scanned: 0, alreadySeen: 0, own: 0, ignored: 0, cards: 0, replies: 0, notices: 0, bounces: 0,
      matched: 0, ambiguous: 0, unmatched: 0, images: 0,
      rejected: [], bounceList: [], ignoredSamples: [], errors: [], newest: {},
      complete: false,
      error: why,
    };
  } finally {
    await opened.source.close?.().catch(() => undefined);
    await dropLock();
  }

  // The marker, on every path that got this far. Lists trimmed: the report is for a page.
  try {
    const stored: ImportReport = {
      ...report,
      rejected: report.rejected.slice(0, 20),
      bounceList: report.bounceList.slice(0, 50),
      ignoredSamples: report.ignoredSamples.slice(0, 15),
      errors: report.errors.slice(0, 20),
    };
    await putState(KEY_LAST_RUN, new Date().toISOString());
    await putState(KEY_LAST_REPORT, JSON.stringify(stored));
  } catch {
    /* a status note must never be able to fail an import */
  }
  return { ran: true, report, summary: describeImport(report) };
}

/** Test connection: sign in and count the inbox. Reads nothing else, imports nothing. */
export async function testInbound(): Promise<{ ok: boolean; detail: string }> {
  const provider = await getReceiveProvider();
  if (provider !== "graph") return { ok: false, detail: IMAP_COMING_NEXT };
  try {
    const loaded = await loadGraphConfig();
    if (!loaded.ok) return { ok: false, detail: loaded.reason };
    return { ok: true, detail: await testGraphMailbox(new GraphClient(loaded.config)) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "The mailbox could not be read." };
  }
}

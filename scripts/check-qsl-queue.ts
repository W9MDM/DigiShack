/* eslint-disable no-console */
// The QSL email queue as the page reads it.
//
//   1. A SKIPPED contact stays skipped. The candidate search left SKIPPED out of its "already
//      has an entry" filter, so every skipped contact came back under "Not yet queued", where
//      "Queue all" and the automatic timer (lib/qsl/auto.ts, which queues from the same
//      search) queued it again — contradicting skipQsl's own "kept so they are not re-queued".
//   2. The Sent tab pages newest first. It used to be the 200 OLDEST rows with no way past them.
//   3. The send summary counts what actually happened (sent / failed / opted out / taken by
//      another sender), not `attempted`, whose meaning changed in 1.231.0.
//   4. A send interrupted between claim and record is recognisable, and counted.
//
// Runs the real lib/qsl/queue.ts against a small in-memory Prisma stand-in that evaluates the
// `where` / `orderBy` / `take` the code actually builds — including the `qslEmails: { none }`
// relation filter, which is where (1) lived. Any model or method the stand-in does not know
// throws, so nothing passes by reaching an unmodelled call. No database, no network.

import { randomUUID } from "node:crypto";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { qso: [], qslEmail: [] };

function val(v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  return v as number | string;
}
function cmp(a: unknown, b: unknown): number {
  const x = val(a);
  const y = val(b);
  return x! < y! ? -1 : x! > y! ? 1 : 0;
}

function matches(table: string, row: Row, where: unknown): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where as Row)) {
    if (k === "AND") {
      if (!(cond as unknown[]).every((w) => matches(table, row, w))) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as unknown[]).some((w) => matches(table, row, w))) return false;
      continue;
    }
    if (table === "qso" && k === "qslEmails") {
      const related = tables.qslEmail!.filter((e) => e.qsoId === row.id);
      const { none, some, ...rest } = cond as { none?: unknown; some?: unknown };
      if (Object.keys(rest).length) throw new Error(`stub: unsupported relation filter ${Object.keys(rest).join()}`);
      if (none !== undefined && related.some((e) => matches("qslEmail", e, none))) return false;
      if (some !== undefined && !related.some((e) => matches("qslEmail", e, some))) return false;
      continue;
    }
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, arg] of Object.entries(cond as Row)) {
        if (op === "in") { if (!(arg as unknown[]).some((x) => val(x) === val(v))) return false; }
        else if (op === "not") { if (val(v) === val(arg)) return false; }
        else if (op === "lt") { if (v == null || cmp(v, arg) >= 0) return false; }
        else if (op === "lte") { if (v == null || cmp(v, arg) > 0) return false; }
        else if (op === "gt") { if (v == null || cmp(v, arg) <= 0) return false; }
        else if (op === "gte") { if (v == null || cmp(v, arg) < 0) return false; }
        else if (op === "startsWith") { if (typeof v !== "string" || !v.startsWith(arg as string)) return false; }
        else throw new Error(`stub: unsupported filter ${k}.${op}`);
      }
      continue;
    }
    if (val(v) !== val(cond)) return false;
  }
  return true;
}

/** MySQL semantics: NULL sorts first ascending and last descending unless `nulls` says otherwise. */
function sorter(orderBy: unknown): (a: Row, b: Row) => number {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => {
    const [field, spec] = Object.entries(o as Row)[0]!;
    const dir = typeof spec === "string" ? spec : (spec as { sort: string }).sort;
    const nulls = typeof spec === "string" ? (dir === "asc" ? "first" : "last") : ((spec as { nulls?: string }).nulls ?? (dir === "asc" ? "first" : "last"));
    return { field, desc: dir === "desc", nulls };
  });
  return (a, b) => {
    for (const k of keys) {
      const x = a[k.field];
      const y = b[k.field];
      if (x == null || y == null) {
        if (x == null && y == null) continue;
        return (x == null) === (k.nulls === "first") ? -1 : 1;
      }
      const c = cmp(x, y);
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  };
}

function delegate(table: string) {
  return {
    findMany: async (a: { where?: unknown; orderBy?: unknown; take?: number; select?: Row; include?: Row } = {}) => {
      let rows = tables[table]!.filter((r) => matches(table, r, a.where)).sort(sorter(a.orderBy));
      if (a.take !== undefined) rows = rows.slice(0, a.take);
      return rows.map((r) => {
        if (a.select) return Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]]));
        return { ...r, ...(a.include ? { qso: null, approvedBy: null } : {}) };
      });
    },
    count: async (a: { where?: unknown } = {}) => tables[table]!.filter((r) => matches(table, r, a.where)).length,
  };
}

const stub = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (typeof prop === "string" && prop in tables) return delegate(prop);
      throw new Error(`stub: prisma.${String(prop)} is not modelled`);
    },
  },
);
(globalThis as unknown as { prisma: unknown }).prisma = stub;

function qso(id: string, extra: Row = {}): Row {
  return {
    id,
    callsign: id.toUpperCase(),
    band: "20m",
    mode: "FT8",
    startTime: new Date(Date.UTC(2026, 9, 1, 0, Number(id.replace(/\D/g, "")) || 0)),
    qslSent: "NONE",
    emailQslSent: false,
    ...extra,
  };
}
function email(id: string, status: string, extra: Row = {}): Row {
  return {
    id,
    qsoId: `qso-${id}`,
    callsign: id.toUpperCase(),
    toAddress: `${id}@example.invalid`,
    status,
    error: null,
    approvedAt: null,
    sentAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 1)),
    ...extra,
  };
}

type Queue = typeof import("@/lib/qsl/queue");

async function main() {
  const q = (await import("@/lib/qsl/queue")) as Partial<Queue>;
  const { describeSendResult } = await import("@/components/qsl/send-summary");
  const u = await import("@/lib/qsl/unconfirmed");

  console.log("\na skipped contact stays skipped");
  {
    tables.qso = ["a1", "b2", "c3", "d4", "e5", "f6"].map((id) => qso(id));
    tables.qslEmail = [
      { ...email("b2", "SKIPPED"), qsoId: "b2" },
      { ...email("c3", "FAILED"), qsoId: "c3" },
      { ...email("d4", "PENDING"), qsoId: "d4" },
      { ...email("e5", "SENT"), qsoId: "e5" },
    ];
    const found = (await q.findQslCandidates!({ limit: 25 })).map((c) => c.qsoId);
    ok(!found.includes("b2"), "a QSO whose queue row is SKIPPED is not a candidate", JSON.stringify(found));
    ok(found.includes("a1") && found.includes("f6"), "QSOs with no queue row are");
    ok(found.includes("c3"), "a FAILED row is still a candidate (nobody decided against it)");
    ok(!found.includes("d4") && !found.includes("e5"), "PENDING and SENT rows are not");
    const auto = (await q.findQslCandidates!({ since: new Date(0), limit: 20 })).map((c) => c.qsoId);
    ok(!auto.includes("b2"), "nor in the automatic timer's search (since + limit, as lib/qsl/auto.ts calls it)");
  }

  console.log("\nthe Sent tab pages newest first");
  const hasPaging = typeof q.listQueuePage === "function";
  ok(hasPaging, "listQueuePage exists");
  if (hasPaging) {
    const t = (min: number) => new Date(Date.UTC(2026, 9, 10, 12, min));
    tables.qslEmail = [
      email("s01", "SENT", { sentAt: t(1) }),
      email("s02", "SENT", { sentAt: t(2) }),
      email("s03", "SENT", { sentAt: t(3) }),
      email("s04", "SENT", { sentAt: t(3) }), // same instant as s03: the id breaks the tie
      email("s05", "SENT", { sentAt: t(5) }),
      email("s06", "SENT", { sentAt: null }), // legacy row with no time: last
      email("s07", "SENT", { sentAt: t(7) }),
      email("p01", "PENDING", { createdAt: t(9) }),
      email("p02", "PENDING", { createdAt: t(8) }),
      email("a01", "APPROVED", { approvedAt: t(20), createdAt: t(1) }),
      email("a02", "APPROVED", { approvedAt: t(10), createdAt: t(2) }),
      email("k01", "SKIPPED"),
    ];
    const expected = ["s07", "s05", "s04", "s03", "s02", "s01", "s06"];
    const got: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<Queue["listQueuePage"]>> = await q.listQueuePage!({ status: "SENT", limit: 3, cursor });
      got.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    ok(JSON.stringify(got) === JSON.stringify(expected), "pages of 3 walk every SENT row once, newest first, timeless last", JSON.stringify(got));
    ok(pages === 3, "and the last page says there is no next one", String(pages));

    const first = await q.listQueuePage!({ status: "SENT", limit: 2 });
    tables.qslEmail.push(email("s99", "SENT", { sentAt: t(59) })); // sent while the page was open
    const second = await q.listQueuePage!({ status: "SENT", limit: 2, cursor: first.nextCursor });
    tables.qslEmail = tables.qslEmail.filter((r) => r.id !== "s99");
    ok(
      second.rows.every((r) => !first.rows.some((f) => f.id === r.id)) && second.rows[0]?.id === "s04",
      "a send arriving between pages does not repeat the first page in the second",
      JSON.stringify(second.rows.map((r) => r.id)),
    );

    const pending = (await q.listQueuePage!({ status: "PENDING" })).rows.map((r) => r.id);
    ok(JSON.stringify(pending) === '["p02","p01"]', "Pending stays oldest first", JSON.stringify(pending));
    const approved = (await q.listQueuePage!({ status: "APPROVED" })).rows.map((r) => r.id);
    ok(JSON.stringify(approved) === '["a02","a01"]', "Approved is in send order (oldest approval first)", JSON.stringify(approved));
    const all = (await q.listQueuePage!({})).rows.map((r) => r.id);
    ok(!all.includes("k01") && all.length === tables.qslEmail.length - 1, "unfiltered still leaves SKIPPED out");

    let threw = "";
    try {
      await q.listQueuePage!({ status: "SENT", cursor: "not-a-cursor" });
    } catch (e) {
      threw = e instanceof Error ? e.constructor.name : String(e);
    }
    ok(threw === "BadQueueCursor", "a cursor it did not issue is refused, not treated as page one", threw || "no error");

    tables.qslEmail = Array.from({ length: 450 }, (_, i) => email(`m${String(i).padStart(3, "0")}`, "SENT", { sentAt: t(i) }));
    const big = await q.listQueuePage!({ status: "SENT", limit: 10_000 });
    ok(big.rows.length === q.QUEUE_PAGE_MAX && big.nextCursor !== null, "a page is capped at QUEUE_PAGE_MAX, with a cursor past it", String(big.rows.length));
    ok(big.rows[0]?.id === "m449", "and starts at the newest of 450, not the oldest", String(big.rows[0]?.id));
  }

  console.log("\nan interrupted send is recognisable");
  {
    const now = Date.now();
    const claim = (at: number) => `${u.UNCONFIRMED_SEND_PREFIX}${new Date(at).toISOString()} [claim ${randomUUID()}]`;
    const oldClaim = claim(now - 60 * 60_000);
    const freshClaim = claim(now - 30_000);
    ok(u.unconfirmedSendState({ status: "SENT", error: oldClaim }, now) === "interrupted", "a claim an hour old reads as interrupted");
    ok(u.unconfirmedSendState({ status: "SENT", error: freshClaim }, now) === "in-flight", "a claim 30 s old reads as still sending (no Resend yet)");
    ok(u.unconfirmedSendState({ status: "SENT", error: null }, now) === null, "a recorded send is neither");
    ok(u.unconfirmedSendState({ status: "FAILED", error: oldClaim }, now) === null, "only SENT rows count");
    ok(
      u.unconfirmedSendState({ status: "SENT", error: `${u.UNCONFIRMED_SEND_PREFIX}garbage`, sentAt: new Date(now - 30_000) }, now) === "in-flight",
      "an unreadable claim time falls back to sentAt",
    );
    if (typeof q.countInterruptedSends === "function") {
      tables.qslEmail = [
        email("x1", "SENT", { error: oldClaim, sentAt: new Date(now - 60 * 60_000) }),
        email("x2", "SENT", { error: freshClaim, sentAt: new Date(now - 30_000) }),
        email("x3", "SENT", { error: null, sentAt: new Date(now - 60 * 60_000) }),
        email("x4", "FAILED", { error: oldClaim, sentAt: null }),
      ];
      ok((await q.countInterruptedSends(now)) === 1, "countInterruptedSends counts the stale claim only");
      const only = (await q.listQueuePage!({ unconfirmedOnly: true })).rows.map((r) => r.id).sort();
      ok(JSON.stringify(only) === '["x1","x2"]', "the unconfirmed filter lists SENT rows still carrying a claim", JSON.stringify(only));
    } else {
      ok(false, "countInterruptedSends exists");
    }
  }

  console.log("\nthe send summary says what happened");
  {
    const lost = describeSendResult({ attempted: 0, sent: 0, failed: 0, skipped: 0, contended: 4, failures: [] });
    ok(!/no approved messages/.test(lost.text) && /another sender/.test(lost.text), "losing every row to the radio service is not 'nothing was waiting'", lost.text);
    const opted = describeSendResult({ attempted: 2, sent: 2, failed: 0, skipped: 1, contended: 0, failures: [] });
    ok(/^Sent 2\./.test(opted.text) && /opted out/.test(opted.text), "an opt-out skipped mid-run is reported", opted.text);
    const failed = describeSendResult({ attempted: 3, sent: 2, failed: 1, skipped: 0, contended: 0, failures: [{ callsign: "K1ABC" }] });
    ok(failed.tone === "warn" && /1 failed \(K1ABC\)/.test(failed.text) && !/ of 3/.test(failed.text), "failures are named, without the old 'of attempted'", failed.text);
    const clean = describeSendResult({ attempted: 3, sent: 3, failed: 0, skipped: 0, contended: 0, failures: [] });
    ok(clean.tone === "ok" && clean.text === "Sent 3.", "a clean run is one short sentence", clean.text);
    const none = describeSendResult({ attempted: 0, sent: 0, failed: 0, skipped: 0, contended: 0, failures: [] });
    ok(/Nothing was sent/.test(none.text), "an empty run says so");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

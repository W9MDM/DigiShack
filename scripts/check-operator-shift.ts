/* eslint-disable no-console */
// Operator sign-on, and the QSO change cursor a club mirror pages through.
//
// The database is a small in-memory stub, as in check-qsl-queue: what matters is which rows
// sign-on opens and closes and which operator a contact is credited to, not MariaDB.

import { randomUUID } from "node:crypto";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

type Row = Record<string, unknown>;
const t: Record<string, Row[]> = { station: [], operator: [], operatorShift: [] };
let clock = Date.UTC(2026, 9, 26, 14, 0, 0);

function match(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}
function withOperator(s: Row): Row {
  const op = t.operator!.find((o) => o.id === s.operatorId)!;
  const st = t.station!.find((x) => x.id === op.stationId)!;
  return { ...s, operator: { ...op, station: { callsign: st.callsign } } };
}

const stub = {
  station: {
    findFirst: async () => [...t.station!].sort((a, b) => (a.createdAt as number) - (b.createdAt as number))[0] ?? null,
    findUnique: async ({ where }: { where: Row }) => t.station!.find((s) => s.id === where.id) ?? null,
  },
  operator: {
    findFirst: async ({ where }: { where: Row }) => t.operator!.find((o) => match(o, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => t.operator!.find((o) => o.id === where.id) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), createdAt: clock, ...data };
      t.operator!.push(row);
      return row;
    },
  },
  operatorShift: {
    findFirst: async ({ where }: { where: Row }) => {
      const open = t.operatorShift!.filter((s) => match(s, where));
      open.sort((a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime());
      return open[0] ? withOperator(open[0]) : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = t.operatorShift!.filter((s) => match(s, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), endedAt: null, ...data };
      t.operatorShift!.push(row);
      return withOperator(row);
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(stub),
};
(globalThis as unknown as { prisma: unknown }).prisma = stub;

async function main() {
  const shift = await import("@/lib/operators/shift");
  const { buildQsoWhere } = await import("@/lib/db/qso");
  const { qsoListQuerySchema } = await import("@/lib/validation/qso");

  t.station!.push({ id: "st-club", callsign: "K9PC", createdAt: 1 }, { id: "st-other", callsign: "K9XYZ", createdAt: 2 });
  const alice = { id: "u-alice", name: "Alice", callsign: "kd9aaa", email: "alice@example.org" };
  const bob = { id: "u-bob", name: "Bob", callsign: null, email: "bob@example.org" };

  console.log("\nSigning on");
  ok((await shift.currentShift()) === null, "nobody is on to begin with");
  ok((await shift.operatorIdFor("st-club")) === null, "  so a contact is logged with no operator");
  ok(shift.shiftView(null).signedOn === false, "  and the API says so");

  const s1 = await shift.signOn({ user: alice });
  const aliceOp = t.operator!.find((o) => o.userId === "u-alice");
  ok(!!aliceOp && aliceOp.callsign === "KD9AAA" && aliceOp.stationId === "st-club", "a user with no Operator gets one, from their callsign, at the bridge's station");
  ok(s1.operator.id === aliceOp?.id && s1.endedAt === null, "and an open shift");
  ok((await shift.operatorIdFor("st-club")) === aliceOp?.id, "contacts at that station are now theirs");
  ok((await shift.operatorIdFor("st-other")) === null, "but not contacts at another station record");

  clock += 60_000;
  await shift.signOn({ user: alice });
  ok(t.operator!.filter((o) => o.userId === "u-alice").length === 1, "signing on again reuses their Operator");
  ok(t.operatorShift!.filter((s) => s.endedAt === null).length === 1, "and leaves exactly one shift open");

  let refused = "";
  try {
    await shift.signOn({ user: bob });
  } catch (e) {
    refused = e instanceof shift.SignOnError ? e.message : "wrong error";
  }
  ok(refused.includes("no callsign"), "a login with no callsign is told to add one", refused);
  ok((await shift.operatorIdFor("st-club")) === aliceOp?.id, "  and the shift on the air is untouched");

  const guest = { id: "op-guest", name: "Guest", callsign: "N0GST", stationId: "st-club", userId: null, createdAt: clock };
  t.operator!.push(guest);
  const led = await shift.signOn({ user: alice, operatorId: "op-guest" });
  ok(led.operator.id === "op-guest" && led.signedOnBy === "KD9AAA", "a shift lead can sign a guest on, and is recorded as having done it");
  ok(t.operatorShift!.filter((s) => s.endedAt === null).length === 1, "the previous shift is closed");

  refused = "";
  t.operator!.push({ id: "op-elsewhere", name: "X", callsign: "W1X", stationId: "st-other", userId: null, createdAt: clock });
  try {
    await shift.signOn({ user: alice, operatorId: "op-elsewhere" });
  } catch (e) {
    refused = e instanceof Error ? e.message : "";
  }
  ok(refused.includes("different station"), "an operator of another station is refused", refused);

  const view = shift.shiftView(await shift.currentShift());
  ok(view.signedOn && view.operator?.callsign === "N0GST" && view.operator.stationCallsign === "K9PC", "the API shows who is on and where");

  ok((await shift.signOff()) === 1, "signing off closes the shift");
  ok((await shift.currentShift()) === null && (await shift.signOff()) === 0, "and a second sign-off has nothing to close");
  ok(t.operatorShift!.every((s) => s.endedAt instanceof Date), "every shift ends with a time: the history is kept");

  const realFind = stub.operatorShift.findFirst;
  stub.operatorShift.findFirst = async () => {
    throw new Error("database gone");
  };
  ok((await shift.operatorIdFor("st-club")) === null, "a failed lookup logs the contact without an operator rather than throwing");
  stub.operatorShift.findFirst = realFind;

  console.log("\nThe change cursor");
  const since = "2026-10-26T14:00:00.123Z";
  const q1 = qsoListQuerySchema.parse({ updatedSince: since, sort: "updatedAt", dir: "asc" });
  const w1 = JSON.stringify(buildQsoWhere(q1));
  ok(w1.includes('"updatedAt":{"gte":"2026-10-26T14:00:00.123Z"}'), "updatedSince alone is inclusive", w1);
  const q2 = qsoListQuerySchema.parse({ updatedSince: since, afterId: "c123", sort: "updatedAt", dir: "asc" });
  const w2 = JSON.stringify(buildQsoWhere(q2));
  ok(
    w2.includes('{"updatedAt":{"gt":"2026-10-26T14:00:00.123Z"}}') && w2.includes('"id":{"gt":"c123"}'),
    "with afterId it resumes after the exact (updatedAt, id) of the last row",
    w2,
  );
  const q3 = qsoListQuerySchema.parse({ updatedSince: since, confirmed: "yes", q: "K1" });
  const w3 = buildQsoWhere(q3);
  ok(Array.isArray(w3.OR) && Array.isArray(w3.AND) && (w3.AND as unknown[]).length === 2, "it composes with the confirmed filter and the search, overwriting neither");
  ok(qsoListQuerySchema.safeParse({ sort: "updatedAt" }).success, "sort=updatedAt is accepted");
  ok(!JSON.stringify(buildQsoWhere(qsoListQuerySchema.parse({}))).includes("updatedAt"), "and a query without it is unchanged");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

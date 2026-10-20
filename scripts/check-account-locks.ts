/* eslint-disable no-console */
// R13 + R14: first-run setup, and the last-active-admin rule, under CONCURRENT requests.
//
// Both were check-then-write races. Setup counted users and then created an admin, so two
// posts with different emails could each count zero and each create one. The users API
// counted the other active admins and then demoted/disabled/deleted, so two admins acting at
// once could each see the other still active and leave nobody able to sign in.
//
// Runs the real route handlers against scripts/fake-db.ts — an in-memory model of InnoDB row
// locks and REPEATABLE READ snapshots, installed before any application import. No database,
// no network. What it cannot show is that a real MySQL/MariaDB matches the model; see the
// header of lib/db/invariant-lock.ts for why it should.

import { createHash } from "node:crypto";

import { FakeDb, fakeRequest, fakeResponse, type Row } from "./fake-db";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

type Handler = (req: unknown, res: unknown) => Promise<void>;

const db = new FakeDb();
db.install();

async function call(h: Handler, r: Parameters<typeof fakeRequest>[0]): Promise<number> {
  const res = fakeResponse();
  await h(fakeRequest(r), res);
  return res.code;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function seedAdmins(): void {
  db.reset();
  const now = new Date();
  db.seed("user", [
    { id: "admin-a", email: "a@example.invalid", name: "A", callsign: null, role: "ADMIN", active: true, passwordHash: "x" },
    { id: "admin-b", email: "b@example.invalid", name: "B", callsign: null, role: "ADMIN", active: true, passwordHash: "x" },
    { id: "viewer-v", email: "v@example.invalid", name: "V", callsign: null, role: "VIEWER", active: true, passwordHash: "x" },
  ]);
  db.seed("session", [
    { id: "s-a", tokenHash: sha("token-a"), userId: "admin-a", expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: now },
    { id: "s-b", tokenHash: sha("token-b"), userId: "admin-b", expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: now },
  ]);
}

const activeAdmins = () => db.rows("user").filter((u: Row) => u.role === "ADMIN" && u.active === true).length;

async function main() {
  const setup = (await import("@/pages/api/auth/setup")).default as unknown as Handler;
  const users = (await import("@/pages/api/users/[id]")).default as unknown as Handler;

  console.log("first-run setup (R13)");
  {
    db.reset();
    const body = (email: string) => ({
      email,
      name: email.split("@")[0],
      password: "correct horse battery staple",
      stationCallsign: "N0CALL",
      stationGrid: "EN61",
    });
    const codes = await Promise.all([
      call(setup, { method: "POST", body: body("first@example.invalid") }),
      call(setup, { method: "POST", body: body("second@example.invalid") }),
      call(setup, { method: "POST", body: body("third@example.invalid") }),
    ]);
    const admins = db.rows("user").filter((u) => u.role === "ADMIN");
    ok(admins.length === 1, "three simultaneous setups with different emails create exactly one admin", `${admins.length} admins`);
    ok(db.rows("station").length === 1, "and exactly one station", `${db.rows("station").length} stations`);
    ok(
      [...codes].sort().join(",") === "201,409,409",
      "one request gets 201, the others 409",
      codes.join(","),
    );

    // The read-view argument in lib/db/invariant-lock.ts only holds if the lock is the
    // FIRST statement of the transaction that does the count. Pin that down.
    const counting = [...db.transactions().values()].filter((s) => s.some((x) => x.startsWith("SELECT COUNT user")));
    ok(
      counting.length > 0 && counting.every((s) => s[0] === "BEGIN" && s[1] === "LOCK setting"),
      "every transaction that counts users takes the lock as its first statement",
      JSON.stringify(counting.map((s) => s.slice(0, 3))),
    );

    const again = await call(setup, { method: "POST", body: body("late@example.invalid") });
    ok(again === 409, "a setup after the fact is refused", String(again));
  }

  console.log("\nthe last active admin (R14)");
  const cases: { label: string; a: Parameters<typeof fakeRequest>[0]; b: Parameters<typeof fakeRequest>[0] }[] = [
    {
      label: "two admins demoting themselves at once",
      a: { method: "PATCH", query: { id: "admin-a" }, body: { role: "OPERATOR" }, session: "token-a" },
      b: { method: "PATCH", query: { id: "admin-b" }, body: { role: "OPERATOR" }, session: "token-b" },
    },
    {
      label: "two admins disabling themselves at once",
      a: { method: "PATCH", query: { id: "admin-a" }, body: { active: false }, session: "token-a" },
      b: { method: "PATCH", query: { id: "admin-b" }, body: { active: false }, session: "token-b" },
    },
    {
      label: "each admin demoting the other",
      a: { method: "PATCH", query: { id: "admin-b" }, body: { role: "VIEWER" }, session: "token-a" },
      b: { method: "PATCH", query: { id: "admin-a" }, body: { role: "VIEWER" }, session: "token-b" },
    },
    {
      label: "one admin disabling the other while the other deletes them",
      a: { method: "PATCH", query: { id: "admin-b" }, body: { active: false }, session: "token-a" },
      b: { method: "DELETE", query: { id: "admin-a" }, session: "token-b" },
    },
    {
      label: "each admin deleting the other",
      a: { method: "DELETE", query: { id: "admin-b" }, session: "token-a" },
      b: { method: "DELETE", query: { id: "admin-a" }, session: "token-b" },
    },
  ];
  for (const c of cases) {
    seedAdmins();
    const codes = await Promise.all([call(users, c.a), call(users, c.b)]);
    ok(activeAdmins() === 1, `${c.label}: one active admin survives`, `${activeAdmins()} left, responses ${codes.join(",")}`);
    ok([...codes].sort().join(",") === "200,409", `${c.label}: one succeeds, the other is refused with 409`, codes.join(","));
  }

  // Ordinary, one-at-a-time behaviour is unchanged. (A has demoted itself below, so the
  // later requests are made as B, the remaining admin.)
  seedAdmins();
  ok((await call(users, cases[0]!.a)) === 200, "sequentially: demoting one of two admins is allowed");
  ok((await call(users, cases[0]!.b)) === 409, "and then demoting the last one is refused");
  ok(
    (await call(users, { method: "PATCH", query: { id: "viewer-v" }, body: { name: "Vee" }, session: "token-b" })) === 200,
    "an edit that cannot remove an admin still goes through",
  );
  ok(
    (await call(users, { method: "PATCH", query: { id: "nobody" }, body: { name: "x" }, session: "token-b" })) === 404,
    "and a missing user is still a 404, not retried",
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

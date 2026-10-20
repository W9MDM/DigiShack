/* eslint-disable no-console */
// R10 + R11: a partial QSO edit is validated as the row it will LEAVE, not as the request.
//
// THE FAULTS (code review 2026-10-14, both reproduced).
//
//   R10. The operator/station check ran only when the request carried a truthy
//        operatorId. A PATCH of just `stationId` moved the contact to station B and kept
//        station A's operator: 200, and an audit trail naming someone who was never there.
//   R11. The schema compares start and end only when both are in the same request. An
//        end-time-only PATCH saved an end before the stored start; a start-only edit could
//        likewise move past the stored end.
//
// Drives the real PATCH handler (through authedRoute, with a synthetic signed-in session)
// against a fake client holding one stored contact.
//
// Run: npx tsx scripts/check-qso-patch.ts

import { installFakePrisma, makeReporter } from "./fake-prisma";

const fake = installFakePrisma(["session", "qso", "operator", "setting"]);
const { ok, eq, section, finish } = makeReporter();

const OPERATORS = new Map([
  ["op-a", { id: "op-a", stationId: "station-a" }],
  ["op-b", { id: "op-b", stationId: "station-b" }],
]);
const START = new Date("2026-10-14T12:00:00Z");
const END = new Date("2026-10-14T12:01:00Z");

let stored: Record<string, unknown> = {};
let updates = 0;

function storeRow(overrides: Record<string, unknown> = {}): void {
  stored = {
    id: "qso-1",
    callsign: "K1ABC",
    freqHz: 14_074_000n,
    band: "20M",
    mode: "FT8",
    stationId: "station-a",
    operatorId: "op-a",
    startTime: START,
    endTime: END,
    sig: null,
    sigRefs: [],
    ...overrides,
  };
  updates = 0;
}

fake.session.findUnique = async () => ({
  id: "check-session",
  expiresAt: new Date(Date.now() + 3_600_000),
  lastSeenAt: new Date(),
  user: { id: "check-admin", email: "check@example.invalid", name: "Check", callsign: null, role: "ADMIN", active: true },
});
fake.setting.findMany = async () => [];
fake.operator.findUnique = async (args: { where: { id: string } }) => OPERATORS.get(args.where.id) ?? null;
fake.qso.findUnique = async (args: { select?: Record<string, boolean> }) => {
  const row = { ...stored };
  if (!args.select) return row;
  return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
};
fake.qso.update = async (args: { data: Record<string, unknown> }) => {
  updates++;
  stored = { ...stored, ...args.data };
  return { ...stored };
};

interface FakeResponse {
  code: number;
  body: any;
  headers: Record<string, unknown>;
  status(n: number): FakeResponse;
  setHeader(k: string, v: unknown): FakeResponse;
  getHeader(k: string): unknown;
  send(s: string): void;
  end(): void;
}
function response(): FakeResponse {
  return {
    code: 0,
    body: null,
    headers: {},
    status(n) {
      this.code = n;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    getHeader(k) {
      return this.headers[k];
    },
    send(s) {
      this.body = JSON.parse(s);
    },
    end() {},
  };
}

async function main(): Promise<void> {
  const { SESSION_COOKIE } = await import("@/lib/auth/session");
  const handler = (await import("@/pages/api/qsos/[id]")).default;

  const patch = async (body: Record<string, unknown>): Promise<FakeResponse> => {
    const res = response();
    await handler(
      { method: "PATCH", query: { id: "qso-1" }, cookies: { [SESSION_COOKIE]: "synthetic" }, headers: {}, body } as never,
      res as never,
    );
    return res;
  };
  const detail = (res: FakeResponse): string => `${res.code} ${JSON.stringify(res.body)}`;

  section("R10: the station/operator pair is checked as it will be stored");
  {
    storeRow();
    const res = await patch({ stationId: "station-b" });
    eq(res.code, 400, "moving the contact without its operator is refused");
    ok(updates === 0 && stored.operatorId === "op-a" && stored.stationId === "station-a", "and nothing is written");
    ok(Array.isArray(res.body?.details?.operatorId), "the refusal names the operator field", detail(res));
  }
  {
    storeRow();
    const res = await patch({ stationId: "station-b", operatorId: null });
    ok(res.code === 200 && stored.stationId === "station-b" && stored.operatorId === null, "moving it and clearing the operator works", detail(res));
  }
  {
    storeRow();
    const res = await patch({ stationId: "station-b", operatorId: "op-b" });
    ok(res.code === 200 && stored.operatorId === "op-b", "moving it with the new station's operator works", detail(res));
  }
  {
    storeRow();
    const res = await patch({ operatorId: "op-b" });
    eq(res.code, 400, "an operator from another station is refused");
  }
  {
    storeRow();
    const res = await patch({ operatorId: null });
    ok(res.code === 200 && stored.operatorId === null, "an explicit operatorId:null clears it", detail(res));
  }
  {
    storeRow({ operatorId: null });
    const res = await patch({ stationId: "station-b" });
    ok(res.code === 200 && stored.stationId === "station-b", "a contact with no operator moves freely", detail(res));
  }
  {
    storeRow();
    const res = await patch({ operatorId: "op-missing" });
    eq(res.code, 404, "an operator that does not exist is a 404");
  }
  {
    // Already inconsistent from before the fix: an unrelated edit is not held hostage.
    storeRow({ stationId: "station-b", operatorId: "op-a" });
    const res = await patch({ notes: "corrected" });
    ok(res.code === 200 && stored.notes === "corrected", "an edit touching neither field is not blocked", detail(res));
  }

  section("a partial edit changes only what it names");
  {
    // zod 4 applies .default() inside .partial(): a notes-only PATCH used to come back
    // with every QSL/upload flag reset and write them.
    const { updateQsoSchema } = await import("@/lib/validation/qso");
    eq(JSON.stringify(updateQsoSchema.parse({})), "{}", "an empty body parses to an empty object (no defaults)");
    storeRow({
      qslSent: "SENT",
      qslRcvd: "CONFIRMED",
      lotwSent: true,
      qrzSent: true,
      eqslSent: true,
      emailQslSent: true,
      emailQslSentAt: START,
    });
    const res = await patch({ notes: "only this" });
    ok(
      res.code === 200 &&
        stored.qslSent === "SENT" &&
        stored.qslRcvd === "CONFIRMED" &&
        stored.lotwSent === true &&
        stored.qrzSent === true &&
        stored.eqslSent === true &&
        stored.emailQslSent === true &&
        stored.emailQslSentAt === START,
      "a notes-only PATCH leaves QSL status, upload flags and the email-QSL date alone",
      detail(res),
    );
  }

  section("R11: start and end are checked as they will be stored");
  {
    storeRow();
    const res = await patch({ endTime: "2026-10-14T11:59:00Z" });
    eq(res.code, 400, "an end-only edit before the stored start is refused");
    ok(updates === 0 && (stored.endTime as Date).getTime() === END.getTime(), "and nothing is written");
    ok(Array.isArray(res.body?.details?.endTime), "the refusal names endTime", detail(res));
  }
  {
    storeRow();
    const res = await patch({ startTime: "2026-10-14T12:05:00Z" });
    eq(res.code, 400, "a start-only edit past the stored end is refused");
    ok(Array.isArray(res.body?.details?.startTime), "the refusal names startTime", detail(res));
  }
  {
    storeRow();
    const res = await patch({ startTime: "2026-10-14T12:00:30Z" });
    eq(res.code, 200, "a start-only edit that stays before the end is accepted");
  }
  {
    storeRow();
    const res = await patch({ endTime: "2026-10-14T12:00:00Z" });
    eq(res.code, 200, "an end equal to the start is accepted");
  }
  {
    storeRow();
    const res = await patch({ startTime: "2026-10-14T13:00:00Z", endTime: "2026-10-14T13:02:00Z" });
    ok(res.code === 200 && (stored.startTime as Date).getTime() === Date.parse("2026-10-14T13:00:00Z"), "moving both together is accepted", detail(res));
  }
  {
    storeRow();
    const res = await patch({ startTime: "2026-10-14T13:00:00Z", endTime: null });
    ok(res.code === 200 && stored.endTime === null, "moving the start while clearing the end is accepted", detail(res));
  }
  {
    storeRow();
    const res = await patch({ endTime: null });
    ok(res.code === 200 && stored.endTime === null, "clearing the end alone is accepted", detail(res));
  }
  {
    storeRow({ endTime: null });
    const res = await patch({ startTime: "2026-10-14T18:00:00Z" });
    eq(res.code, 200, "with no stored end, the start may move anywhere");
  }
  {
    storeRow();
    const res = await patch({ startTime: "2026-10-14T12:05:00Z", endTime: "2026-10-14T12:04:00Z" });
    eq(res.code, 400, "both supplied and reversed is still refused");
  }

  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

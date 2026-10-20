/* eslint-disable no-console */
// R03 + R09: an ADIF import writes each contact's park references onto THAT contact, writes
// them together with it, and dedupes only against the station being imported into.
//
// THE FAULTS (code review 2026-10-14, both reproduced).
//
//   R03. `createMany` returns no ids, so the importer read the new rows back by
//        (callsign, startTime) and kept the last match per pair. Any other contact with
//        the same call at the same time, on another band or another station, could win:
//        a new 20 m contact's US-1234 was written onto an existing 40 m contact. The QSO
//        rows and their reference rows were also separate writes, so a failure between
//        them left contacts with a `sigInfo` and no reference rows.
//   R09. The dedupe lookup matched by remote callsign only and its key carried no
//        station, so a contact at station A suppressed the same tuple imported into B
//        (`alreadyInLog: 1` for a contact the target station never made).
//
// Drives the real importAdifDocument() against an in-memory store that answers like
// MySQL: no ORDER BY means no order (it answers newest first), and an interactive
// transaction commits all of its writes or none.
//
// Run: npx tsx scripts/check-adif-import.ts

import { installFakePrisma, makeReporter } from "./fake-prisma";

interface QsoRow {
  id: string;
  stationId: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
  sig: string | null;
  sigInfo: string | null;
  [k: string]: unknown;
}
interface RefRow {
  qsoId: string;
  sig: string;
  sigInfo: string;
  primary: boolean;
}

const fake = installFakePrisma(["station", "qso", "qsoSigRef"]);
const { ok, eq, section, finish } = makeReporter();

const STATIONS = new Map([
  ["station-a", { id: "station-a", callsign: "K2AAA", operators: [] as { id: string; callsign: string }[] }],
  ["station-b", { id: "station-b", callsign: "K2BBB", operators: [] as { id: string; callsign: string }[] }],
  // Station B's portable profile: another Station row, the same callsign.
  ["station-p", { id: "station-p", callsign: "K2BBB", operators: [] as { id: string; callsign: string }[] }],
]);

const store = { qsos: [] as QsoRow[], refs: [] as RefRow[] };
const calls = {
  transactions: 0,
  findManyWheres: [] as Record<string, unknown>[],
  qsoCreateIds: [] as (string | undefined)[],
};
/** When set, the Nth reference insert (1-based, counting every attempt) throws. */
let failRefInsertNumber = 0;
let refInserts = 0;
let autoId = 0;

function reset(): void {
  store.qsos = [];
  store.refs = [];
  calls.transactions = 0;
  calls.findManyWheres = [];
  calls.qsoCreateIds = [];
  failRefInsertNumber = 0;
  refInserts = 0;
}

function matches(row: QsoRow, where: Record<string, any> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Record<string, any>[]).some((w) => matches(row, w))) return false;
    } else if (v && typeof v === "object" && !(v instanceof Date) && "in" in v) {
      if (!(v.in as unknown[]).includes(row[k])) return false;
    } else if (v instanceof Date) {
      if (!(row[k] instanceof Date) || (row[k] as Date).getTime() !== v.getTime()) return false;
    } else if (typeof v === "object" && v !== null) {
      throw new Error(`fake store cannot evaluate where.${k}: ${JSON.stringify(v)}`);
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

function project(row: QsoRow, select: Record<string, boolean> | undefined): Record<string, unknown> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

/** Delegates over a target: the committed store, or a transaction's pending writes. */
function delegates(pending: { qsos: QsoRow[]; refs: RefRow[] } | null) {
  return {
    qso: {
      findMany: async (args: { where?: Record<string, any>; select?: Record<string, boolean> }) => {
        calls.findManyWheres.push(args.where ?? {});
        const visible = [...store.qsos, ...(pending?.qsos ?? [])];
        // No ORDER BY: MySQL promises no order. Newest first is one it can produce.
        return visible.filter((r) => matches(r, args.where)).reverse().map((r) => project(r, args.select));
      },
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        const target = pending?.qsos ?? store.qsos;
        for (const d of args.data) {
          calls.qsoCreateIds.push(d.id as string | undefined);
          const id = (d.id as string | undefined) ?? `auto-${++autoId}`;
          if ([...store.qsos, ...(pending?.qsos ?? [])].some((r) => r.id === id)) {
            throw new Error(`duplicate primary key ${id}`);
          }
          target.push({ ...(d as QsoRow), id });
        }
        return { count: args.data.length };
      },
    },
    qsoSigRef: {
      createMany: async (args: { data: RefRow[]; skipDuplicates?: boolean }) => {
        refInserts++;
        if (failRefInsertNumber && refInserts === failRefInsertNumber) {
          throw new Error("injected failure writing reference rows");
        }
        const target = pending?.refs ?? store.refs;
        const allQsos = [...store.qsos, ...(pending?.qsos ?? [])];
        let count = 0;
        for (const d of args.data) {
          if (!allQsos.some((q) => q.id === d.qsoId)) throw new Error(`foreign key: no QSO ${d.qsoId}`);
          const dup = [...store.refs, ...(pending?.refs ?? [])].some(
            (r) => r.qsoId === d.qsoId && r.sig === d.sig && r.sigInfo === d.sigInfo,
          );
          if (dup && args.skipDuplicates) continue;
          if (dup) throw new Error("unique (qsoId, sig, sigInfo)");
          target.push({ ...d });
          count++;
        }
        return { count };
      },
    },
  };
}

const committed = delegates(null);
fake.station.findUnique = async (args: { where: { id: string } }) => STATIONS.get(args.where.id) ?? null;
// MySQL's default collation compares case-insensitively.
fake.station.findMany = async (args: { where: { callsign: string } }) =>
  [...STATIONS.values()]
    .filter((s) => s.callsign.toUpperCase() === args.where.callsign.toUpperCase())
    .map((s) => ({ id: s.id }));
fake.qso.findMany = committed.qso.findMany;
fake.qso.createMany = committed.qso.createMany;
fake.qsoSigRef.createMany = committed.qsoSigRef.createMany;
fake.$transaction = async (fn: unknown) => {
  if (typeof fn !== "function") throw new Error("fake store models only the interactive $transaction form");
  calls.transactions++;
  const pending = { qsos: [] as QsoRow[], refs: [] as RefRow[] };
  const result = await (fn as (tx: unknown) => Promise<unknown>)(delegates(pending));
  // Reached only if the callback resolved: commit everything, or (on a throw) nothing.
  store.qsos.push(...pending.qsos);
  store.refs.push(...pending.refs);
  return result;
};

// ---------------------------------------------------------------------------

const T = new Date("2026-10-14T12:00:00Z");

function field(name: string, value: string): string {
  return `<${name}:${Buffer.byteLength(value)}>${value}`;
}
function record(r: Record<string, string>): string {
  return `${Object.entries(r).map(([k, v]) => field(k, v)).join("")}<EOR>\n`;
}
function adif(records: Record<string, string>[]): Buffer {
  return Buffer.from(`Generated for check-adif-import\n<EOH>\n${records.map(record).join("")}`);
}
const k1abc = (band: "20M" | "40M", extra: Record<string, string> = {}): Record<string, string> => ({
  CALL: "K1ABC",
  BAND: band,
  FREQ: band === "20M" ? "14.074" : "7.074",
  MODE: "FT8",
  QSO_DATE: "20261014",
  TIME_ON: "120000",
  ...extra,
});
function seedExisting(row: Partial<QsoRow> & { id: string; stationId: string; band: string }): void {
  store.qsos.push({ callsign: "K1ABC", mode: "FT8", startTime: T, sig: null, sigInfo: null, ...row });
}
const refsOf = (id: string): RefRow[] => store.refs.filter((r) => r.qsoId === id);

async function main(): Promise<void> {
  const { importAdifDocument } = await import("@/lib/adif/import-service");

  section("R09: dedupe is scoped to the target station");
  {
    reset();
    seedExisting({ id: "existing-a-20m", stationId: "station-a", band: "20M" });
    const file = adif([k1abc("20M", { SIG: "POTA", SIG_INFO: "US-1234" })]);
    const r = await importAdifDocument(file, { stationId: "station-b", dryRun: false, dedupe: true });
    ok(r.ok, "the import succeeds");
    if (r.ok) {
      eq(r.report.alreadyInLog, 0, "another station's identical contact is not 'already in the log' here");
      eq(r.report.imported, 1, "so the contact is imported into station B");
    }
    const mine = store.qsos.filter((q) => q.stationId === "station-b");
    eq(mine.length, 1, "station B now holds it");
    ok(
      calls.findManyWheres.length > 0 &&
        calls.findManyWheres.every((w) => {
          const ids = (w.stationId as { in?: string[] } | undefined)?.in ?? [];
          return ids.includes("station-b") && !ids.includes("station-a");
        }),
      "the dedupe lookup asks only for contacts under the target station's callsign",
      JSON.stringify(calls.findManyWheres),
    );

    const again = await importAdifDocument(file, { stationId: "station-b", dryRun: false, dedupe: true });
    ok(again.ok && again.report.alreadyInLog === 1 && again.report.imported === 0, "re-importing into B is still deduped");
    eq(store.qsos.filter((q) => q.stationId === "station-b").length, 1, "and adds nothing");

    const intoA = await importAdifDocument(file, { stationId: "station-a", dryRun: true, dedupe: true });
    ok(intoA.ok && intoA.report.alreadyInLog === 1, "importing into A finds A's own contact");
  }

  section("one callsign, several Station rows: still one log");
  {
    // A QRZ sync into the home profile must not re-import what was logged on the portable one.
    reset();
    seedExisting({ id: "existing-p-20m", stationId: "station-p", band: "20M" });
    const file = adif([k1abc("20M")]);
    const r = await importAdifDocument(file, { stationId: "station-b", dryRun: false, dedupe: true });
    ok(r.ok && r.report.alreadyInLog === 1 && r.report.imported === 0, "a contact on a same-callsign profile counts as already in the log");
    eq(store.qsos.length, 1, "and no duplicate row is written");
  }

  section("R03: references land on the row that was created");
  {
    reset();
    // Same call, same minute, same station, other band; and another station's 20 m twin.
    seedExisting({ id: "existing-b-40m", stationId: "station-b", band: "40M" });
    seedExisting({ id: "existing-a-20m", stationId: "station-a", band: "20M" });
    const r = await importAdifDocument(adif([k1abc("20M", { SIG: "POTA", SIG_INFO: "US-1234" })]), {
      stationId: "station-b",
      dryRun: false,
      dedupe: true,
    });
    ok(r.ok && r.report.imported === 1, "the 20 m contact is imported");
    const created = store.qsos.find((q) => q.stationId === "station-b" && q.band === "20M");
    ok(Boolean(created), "and exists");
    const refs = created ? refsOf(created.id) : [];
    ok(refs.length === 1 && refs[0]!.sigInfo === "US-1234" && refs[0]!.primary, "its US-1234 is on it, as the primary");
    eq(refsOf("existing-b-40m").length, 0, "the 40 m contact at the same minute gets nothing");
    eq(refsOf("existing-a-20m").length, 0, "nor does the other station's 20 m twin");
  }

  section("R03: dedupe:false with collisions in the file and in the log");
  {
    reset();
    seedExisting({ id: "existing-a-20m", stationId: "station-a", band: "20M" });
    seedExisting({ id: "existing-b-20m", stationId: "station-b", band: "20M" });
    const file = adif([
      k1abc("20M", { SIG: "POTA", SIG_INFO: "US-1234" }),
      k1abc("40M", { SIG: "POTA", SIG_INFO: "US-5678", APP_DIGISHACK_SIGREFS: "US-5678,US-9999" }),
      { CALL: "K9XYZ", BAND: "20M", FREQ: "14.074", MODE: "FT8", QSO_DATE: "20261014", TIME_ON: "120000" },
    ]);
    const r = await importAdifDocument(file, { stationId: "station-b", dryRun: false, dedupe: false });
    ok(r.ok && r.report.imported === 3, "all three are written");
    const created = store.qsos.filter((q) => !q.id.startsWith("existing-"));
    const by = (band: string, call = "K1ABC") => created.find((q) => q.band === band && q.callsign === call);
    const r20 = by("20M");
    const r40 = by("40M");
    const plain = by("20M", "K9XYZ");
    ok(Boolean(r20 && r40 && plain), "each record became its own row");
    if (r20 && r40 && plain) {
      ok(
        JSON.stringify(refsOf(r20.id).map((x) => x.sigInfo)) === '["US-1234"]',
        "the 20 m row holds exactly its own reference",
        JSON.stringify(refsOf(r20.id)),
      );
      ok(
        JSON.stringify(refsOf(r40.id).map((x) => `${x.sigInfo}:${x.primary}`).sort()) ===
          '["US-5678:true","US-9999:false"]',
        "the 40 m row holds its two-fer, primary marked",
        JSON.stringify(refsOf(r40.id)),
      );
      ok(r20.sigInfo === "US-1234" && r40.sigInfo === "US-5678", "each row's sigInfo is its own primary reference");
      eq(refsOf(plain.id).length, 0, "a record without references gets none");
    }
    eq(refsOf("existing-a-20m").length + refsOf("existing-b-20m").length, 0, "no existing contact gains a reference");
    eq(store.refs.length, 3, "three reference rows in all");

    const ids = calls.qsoCreateIds;
    ok(ids.length === 3 && ids.every((id) => typeof id === "string"), "every row's id was chosen before the insert");
    ok(
      ids.every((id) => /^c[0-9a-z]{24}$/.test(id ?? "")) && new Set(ids).size === ids.length,
      "ids are distinct and shaped like Prisma's cuid()",
      JSON.stringify(ids),
    );
  }

  section("R03: a chunk and its references are written atomically");
  {
    reset();
    // 501 contacts with a reference each: two chunks. The second chunk's reference insert fails.
    const records = Array.from({ length: 501 }, (_, i) => ({
      CALL: `K${i}AB`,
      BAND: "20M",
      FREQ: "14.074",
      MODE: "FT8",
      QSO_DATE: "20261014",
      TIME_ON: `12${String(Math.floor(i / 60) % 60).padStart(2, "0")}${String(i % 60).padStart(2, "0")}`,
      SIG: "POTA",
      SIG_INFO: `US-${String(i).padStart(4, "0")}`,
    }));
    failRefInsertNumber = 2;
    let threw = false;
    try {
      await importAdifDocument(adif(records), { stationId: "station-b", dryRun: false, dedupe: false });
    } catch {
      threw = true;
    }
    ok(threw, "the failure is reported, not swallowed");
    eq(store.qsos.length, 500, "the first chunk is committed and the failed chunk's contacts are not");
    eq(store.refs.length, 500, "the first chunk's references are committed");
    const orphans = store.qsos.filter((q) => q.sigInfo && refsOf(q.id).length === 0);
    eq(orphans.length, 0, "no contact is left with a sigInfo and no reference rows");
    eq(calls.transactions, 2, "each chunk is its own transaction");
  }

  section("dry run");
  {
    reset();
    const r = await importAdifDocument(adif([k1abc("20M", { SIG: "POTA", SIG_INFO: "US-1234" })]), {
      stationId: "station-b",
      dryRun: true,
      dedupe: true,
    });
    ok(r.ok && r.report.pending === 1 && store.qsos.length === 0 && store.refs.length === 0, "writes nothing");
  }

  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

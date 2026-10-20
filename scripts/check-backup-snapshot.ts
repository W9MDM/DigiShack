/* eslint-disable no-console */
// R02: a database backup is ONE instant of the database, read in primary-key order.
//
// THE FAULT (code review 2026-10-14, reproduced). writeSqlDump() paged every table with
// `SELECT * ... LIMIT 500 OFFSET n` through the general connection pool: no ORDER BY, no
// transaction. Deleting one row before the second page shifted every unread row back by one
// and the dump skipped the last of them. 501 rows in, a "successful" 500-row backup out, and
// the bundle's checksum then faithfully certified the incomplete file. Reading related tables
// at different instants could also produce a dump that never was a database: a child row
// whose parent had been deleted by the time the parent table was read.
//
// This drives the real writeSqlDump() and backupBundle() against a fake client that behaves
// like InnoDB under REPEATABLE READ: reads inside the transaction all see the snapshot taken
// at its FIRST consistent read, reads outside it see the live tables, and other writers
// delete, insert and update rows while the dump is running. It proves:
//
//   * every original row is dumped exactly once and nothing that arrived later is;
//   * parents and children come from the same instant: no orphan, no missing parent,
//     no value that changed after the snapshot;
//   * rows are written in primary-key order whatever order the server stores them in;
//   * a composite primary key pages correctly across page boundaries;
//   * a table with no primary key is still dumped whole, duplicates included;
//   * every data read went through ONE transaction at REPEATABLE READ, with a timeout a
//     large log fits inside, paged by key rather than by OFFSET;
//   * the pre-update path (backupBundle, which lib/update/runner.ts calls before migrating)
//     gets the same dump.
//
// What it CANNOT prove is that a real MySQL or MariaDB server honours the snapshot rule.
// That is InnoDB's documented behaviour and this models it; a concurrent backup and restore
// against a real server is still owed. See the comment on writeSqlDump().
//
// Run: npx tsx scripts/check-backup-snapshot.ts

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { installFakePrisma, makeReporter } from "./fake-prisma";

type Row = Record<string, unknown>;
interface TableDef {
  name: string;
  /** Primary-key columns in key order; empty for a table with no primary key. */
  key: string[];
  columns: string[];
}
type Client = "global" | "tx";

const fake = installFakePrisma([]);
const { ok, eq, section, finish } = makeReporter();

// ---------------------------------------------------------------------------
// A small InnoDB: live tables, one read view per transaction, writers on hooks
// ---------------------------------------------------------------------------

const defs = new Map<string, TableDef>();
/** Live tables, in PHYSICAL order, which deliberately is not key order. */
const live = new Map<string, Row[]>();
/** Every statement, and which client sent it. */
const log: { client: Client; sql: string; params: unknown[] }[] = [];
/** Data pages served per table, counting both clients. */
const pagesServed = new Map<string, number>();
/** Concurrent writers: run once, right after page `afterPage` of `table` is served. */
const hooks: { table: string; afterPage: number; run: () => void; fired: boolean }[] = [];
/** The options each `$transaction` call was given. */
const txOptions: Record<string, unknown>[] = [];

/** The open transaction's read view, or null before its first consistent read. */
let readView: Map<string, Row[]> | null = null;
let txOpen = false;

function need(name: string | undefined): TableDef {
  const def = name ? defs.get(name) : undefined;
  if (!def) throw new Error(`fake InnoDB: no table ${name}`);
  return def;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * The keyset predicate, in the expanded form the dump writes:
 *   (`a` > ?) OR (`a` = ? AND `b` > ?) ...
 * Anything else is refused, so a change of SQL shape fails here loudly rather than being
 * half-understood.
 */
function compileWhere(where: string, params: unknown[]): (r: Row) => boolean {
  let p = 0;
  const groups = where.split(" OR ").map((group) => {
    const inner = group.trim().replace(/^\((.*)\)$/, "$1");
    return inner.split(" AND ").map((term) => {
      const m = /^`(\w+)` (>|=) \?$/.exec(term.trim());
      if (!m) throw new Error(`fake InnoDB cannot interpret WHERE term ${JSON.stringify(term)}`);
      if (p >= params.length) throw new Error("fake InnoDB: more placeholders than parameters");
      return { col: m[1]!, op: m[2]!, value: params[p++] };
    });
  });
  if (p !== params.length) {
    throw new Error(`fake InnoDB: ${params.length} parameters for ${p} placeholders`);
  }
  return (r) =>
    groups.some((terms) =>
      terms.every(({ col, op, value }) => {
        if (!(col in r)) throw new Error(`fake InnoDB: no column ${col}`);
        if (value === undefined || value === null) {
          throw new Error(`fake InnoDB: keyset parameter for ${col} is ${String(value)}`);
        }
        const c = cmp(r[col], value);
        return op === ">" ? c > 0 : c === 0;
      }),
    );
}

const SELECT_RE =
  /^SELECT \* FROM `(\w+)`(?: WHERE (.+?))?(?: ORDER BY ((?:`\w+`)(?:, `\w+`)*))?(?: LIMIT (\d+)(?: OFFSET (\d+))?)?$/;

function serve(client: Client, sql: string, params: unknown[]): Row[] {
  const s = sql.trim();
  log.push({ client, sql: s, params });

  if (s === "SHOW FULL TABLES") {
    // Reverse alphabetical: the dump must impose its own order.
    return [...defs.keys()]
      .sort()
      .reverse()
      .map((name) => ({ Tables_in_digishack: name, Table_type: "BASE TABLE" }));
  }

  let m = /^SHOW CREATE TABLE `(\w+)`$/.exec(s);
  if (m) {
    const def = need(m[1]);
    const cols = def.columns.map((c) => `  \`${c}\` varchar(191) NOT NULL`);
    if (def.key.length) cols.push(`  PRIMARY KEY (${def.key.map((k) => `\`${k}\``).join(",")})`);
    return [{ Table: def.name, "Create Table": `CREATE TABLE \`${def.name}\` (\n${cols.join(",\n")}\n)` }];
  }

  m = /^SHOW KEYS FROM `(\w+)` WHERE Key_name = 'PRIMARY'$/.exec(s);
  if (m) {
    const def = need(m[1]);
    // Reverse Seq_in_index order, so a composite key is only right if the dump sorts by it.
    return def.key
      .map((col, i) => ({
        Table: def.name,
        Non_unique: 0,
        Key_name: "PRIMARY",
        Seq_in_index: i + 1,
        Column_name: col,
      }))
      .reverse();
  }

  m = SELECT_RE.exec(s);
  if (m) {
    const [, table, where, orderBy, limit, offset] = m;
    const def = need(table);
    let source: Row[];
    if (client === "tx") {
      // InnoDB, REPEATABLE READ: the FIRST consistent read creates the transaction's read
      // view, of every table at once, and every later read in the transaction reuses it.
      if (!readView) readView = new Map([...live].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
      source = readView.get(def.name)!;
    } else {
      source = live.get(def.name)!;
    }
    let out = source.slice();
    if (where) out = out.filter(compileWhere(where, params));
    else if (params.length) throw new Error("fake InnoDB: parameters but no placeholders");
    if (orderBy) {
      const cols = orderBy.split(", ").map((c) => c.replace(/`/g, ""));
      out.sort((a, b) => {
        for (const c of cols) {
          const d = cmp(a[c], b[c]);
          if (d !== 0) return d;
        }
        return 0;
      });
    }
    if (offset) out = out.slice(Number(offset));
    if (limit) out = out.slice(0, Number(limit));

    const page = (pagesServed.get(def.name) ?? 0) + 1;
    pagesServed.set(def.name, page);
    for (const h of hooks) {
      if (!h.fired && h.table === def.name && h.afterPage === page) {
        h.fired = true;
        h.run();
      }
    }
    return out.map((r) => ({ ...r }));
  }

  throw new Error(`fake InnoDB does not understand: ${s}`);
}

fake.$queryRawUnsafe = async (sql: string, ...params: unknown[]) => serve("global", sql, params);
fake.$transaction = async (fn: unknown, opts?: Record<string, unknown>) => {
  if (typeof fn !== "function") throw new Error("fake InnoDB models only the interactive $transaction form");
  txOptions.push(opts ?? {});
  readView = null; // BEGIN creates no read view; the first consistent read does.
  txOpen = true;
  const tx = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (!txOpen) throw new Error("fake InnoDB: query on a closed transaction");
      return serve("tx", sql, params);
    },
  };
  try {
    return await (fn as (t: typeof tx) => Promise<unknown>)(tx);
  } finally {
    txOpen = false;
    readView = null;
  }
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Deterministic shuffle, so physical order is scrambled the same way every run. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = xs.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
const pad = (n: number, w: number): string => String(n).padStart(w, "0");

const AUDIT_ROWS = 501;
const FAMILY = 600;
const PAIR_A = [1, 2, 3];
const PAIR_B = 411; // 3 x 411 = 1,233 rows: page boundaries fall inside an `a` group
const NOKEY = [
  { label: "same", n: 1 },
  { label: "same", n: 1 }, // an identical row: indistinguishable, and both must survive
  { label: "x", n: 2 },
  { label: "y", n: 3 },
  { label: "z", n: 4 },
  { label: "w", n: 5 },
  { label: "v", n: 6 },
];

function seed(): void {
  defs.clear();
  live.clear();
  log.length = 0;
  pagesServed.clear();
  hooks.length = 0;
  txOptions.length = 0;

  const define = (name: string, key: string[], columns: string[], rows: Row[]): void => {
    defs.set(name, { name, key, columns });
    live.set(name, rows);
  };

  define(
    "AuditRow",
    ["id"],
    ["id", "note"],
    shuffled(
      Array.from({ length: AUDIT_ROWS }, (_, id) => ({ id, note: `row-${id}` })),
      7,
    ),
  );
  define(
    "Child",
    ["id"],
    ["id", "parentId"],
    shuffled(
      Array.from({ length: FAMILY }, (_, i) => ({ id: `c-${pad(i, 4)}`, parentId: `p-${pad(i, 3)}` })),
      11,
    ),
  );
  define(
    "Parent",
    ["id"],
    ["id", "name"],
    shuffled(
      Array.from({ length: FAMILY }, (_, i) => ({ id: `p-${pad(i, 3)}`, name: `parent-${i}` })),
      13,
    ),
  );
  define(
    "PairKey",
    ["a", "b"],
    ["a", "b", "v"],
    shuffled(
      PAIR_A.flatMap((a) =>
        Array.from({ length: PAIR_B }, (_, i) => ({ a, b: `k${pad(i, 3)}`, v: `${a}/${i}` })),
      ),
      17,
    ),
  );
  define("NoKey", [], ["label", "n"], NOKEY.map((r) => ({ ...r })));

  // Writers working while the backup runs.
  hooks.push({
    table: "AuditRow",
    afterPage: 1,
    fired: false,
    run: () => {
      // The review's reproduction: delete the first stored row once page one is out, and
      // add a new one.
      const rows = live.get("AuditRow")!;
      rows.splice(0, 1);
      rows.push({ id: 9001, note: "arrived-during-backup" });
    },
  });
  hooks.push({
    table: "Child",
    afterPage: 1,
    fired: false,
    run: () => {
      // Child is dumped before Parent (alphabetical). Delete a family whose child is
      // already in the dump, add a new family, and rename a parent not yet read.
      const children = live.get("Child")!;
      const parents = live.get("Parent")!;
      children.splice(children.findIndex((r) => r.id === "c-0000"), 1);
      parents.splice(parents.findIndex((r) => r.id === "p-000"), 1);
      parents.push({ id: "p-new", name: "arrived-during-backup" });
      children.push({ id: "c-9999", parentId: "p-new" });
      const last = parents.find((r) => r.id === "p-599")!;
      last.name = "renamed-during-backup";
    },
  });
  hooks.push({
    table: "PairKey",
    afterPage: 1,
    fired: false,
    run: () => {
      live.get("PairKey")!.push({ a: 2, b: "k205x", v: "arrived-during-backup" });
    },
  });
}

// ---------------------------------------------------------------------------
// Reading a dump back
// ---------------------------------------------------------------------------

/** Value tuples per table, from the INSERT statements, as raw literal strings. */
function tuplesByTable(
  sql: string,
  splitStatements: (s: string) => string[],
): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const stmt of splitStatements(sql)) {
    const m = /^INSERT INTO `(\w+)` \([^)]*\) VALUES\s*([\s\S]*)$/.exec(stmt);
    if (!m) continue;
    const list = out.get(m[1]!) ?? [];
    for (const t of m[2]!.matchAll(/\(([^()]*)\)/g)) {
      list.push(t[1]!.split(", ").map((v) => v.replace(/^'(.*)'$/, "$1")));
    }
    out.set(m[1]!, list);
  }
  return out;
}

function sortedCopy<T>(xs: T[], by: (a: T, b: T) => number): T[] {
  return xs.slice().sort(by);
}
const isSorted = <T>(xs: T[], by: (a: T, b: T) => number): boolean =>
  xs.every((x, i) => i === 0 || by(xs[i - 1]!, x) <= 0);

/** Every assertion about the CONTENT of a dump, shared by both entry points. */
function assertDumpContent(label: string, tuples: Map<string, string[][]>): void {
  // AuditRow: the review's reproduction, plus an insert during the dump.
  const audit = (tuples.get("AuditRow") ?? []).map((t) => Number(t[0]));
  eq(audit.length, AUDIT_ROWS, `${label}: AuditRow has all ${AUDIT_ROWS} rows that existed when the dump began`);
  ok(
    Array.from({ length: AUDIT_ROWS }, (_, i) => i).every((id) => audit.includes(id)),
    `${label}: including the row deleted mid-dump and the last row an OFFSET page skipped`,
    `missing ${Array.from({ length: AUDIT_ROWS }, (_, i) => i).filter((id) => !audit.includes(id)).join(",")}`,
  );
  ok(!audit.includes(9001), `${label}: and not the row inserted after the dump began`);
  ok(isSorted(audit, (a, b) => a - b), `${label}: AuditRow rows are written in primary-key order`);

  // Parent/child: one instant across tables.
  const children = tuples.get("Child") ?? [];
  const parents = tuples.get("Parent") ?? [];
  const parentIds = new Set(parents.map((t) => t[0]));
  const orphans = children.filter((t) => !parentIds.has(t[1]!)).map((t) => t[0]);
  eq(children.length, FAMILY, `${label}: Child has every row of the snapshot`);
  eq(parents.length, FAMILY, `${label}: Parent has every row of the snapshot`);
  ok(orphans.length === 0, `${label}: no child row without its parent`, `orphans ${orphans.join(",")}`);
  ok(
    parentIds.has("p-000") && !parentIds.has("p-new"),
    `${label}: a family deleted and one added during the dump do not leak in or out`,
  );
  ok(
    parents.some((t) => t[0] === "p-599" && t[1] === "parent-599"),
    `${label}: a row updated after the snapshot keeps its snapshot value`,
  );
  ok(
    isSorted(children.map((t) => t[0]!), (a, b) => cmp(a, b)) &&
      isSorted(parents.map((t) => t[0]!), (a, b) => cmp(a, b)),
    `${label}: string primary keys are written in key order`,
  );

  // Composite key.
  const pairs = (tuples.get("PairKey") ?? []).map((t) => ({ a: Number(t[0]), b: t[1]! }));
  const want = PAIR_A.flatMap((a) => Array.from({ length: PAIR_B }, (_, i) => `${a}|k${pad(i, 3)}`));
  const got = pairs.map((p) => `${p.a}|${p.b}`);
  eq(pairs.length, want.length, `${label}: composite-key table has every row exactly once`);
  ok(
    new Set(got).size === got.length && want.every((k) => got.includes(k)),
    `${label}: no pair duplicated or skipped across page boundaries`,
  );
  ok(
    isSorted(pairs, (x, y) => x.a - y.a || cmp(x.b, y.b)),
    `${label}: composite-key rows are in (a, b) key order`,
  );
  ok(!got.includes("2|k205x"), `${label}: a composite-key row inserted mid-dump is not included`);

  // No primary key.
  const nokey = (tuples.get("NoKey") ?? []).map((t) => `${t[0]}|${t[1]}`);
  const wantNoKey = NOKEY.map((r) => `${r.label}|${r.n}`);
  ok(
    JSON.stringify(sortedCopy(nokey, cmp)) === JSON.stringify(sortedCopy(wantNoKey, cmp)),
    `${label}: a table with no primary key is dumped whole, identical rows included`,
    `got ${JSON.stringify(nokey)}`,
  );
}

/** Assertions about HOW the dump read the database. */
function assertDumpMechanics(label: string): void {
  const dataReads = log.filter((e) => e.sql.startsWith("SELECT * FROM"));
  eq(txOptions.length, 1, `${label}: the whole dump is one transaction`);
  const opts = txOptions[0] ?? {};
  eq(opts.isolationLevel, "RepeatableRead", `${label}: at REPEATABLE READ, InnoDB's snapshot isolation`);
  ok(
    typeof opts.timeout === "number" && opts.timeout >= 30 * 60_000,
    `${label}: with a timeout sized for a large log (at least 30 minutes)`,
    `timeout ${String(opts.timeout)}`,
  );
  const outside = dataReads.filter((e) => e.client !== "tx");
  ok(
    dataReads.length > 0 && outside.length === 0,
    `${label}: every data read goes through that transaction, none through the pool`,
    `${outside.length} of ${dataReads.length} outside`,
  );
  const offsets = dataReads.filter((e) => /\bOFFSET\b/.test(e.sql));
  ok(offsets.length === 0, `${label}: pages are found by key, never by OFFSET`, offsets[0]?.sql);
  for (const def of defs.values()) {
    const reads = dataReads.filter((e) => e.sql.startsWith(`SELECT * FROM \`${def.name}\``));
    if (def.key.length === 0) continue;
    const order = `ORDER BY ${def.key.map((k) => `\`${k}\``).join(", ")}`;
    ok(
      reads.length > 0 && reads.every((e) => e.sql.includes(order)),
      `${label}: ${def.name} is read ${order}`,
      reads.find((e) => !e.sql.includes(order))?.sql,
    );
  }
  ok(hooks.every((h) => h.fired), `${label}: every concurrent writer actually ran mid-dump`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // BACKUP_DIR is fixed from the working directory when lib/db/backup.ts loads, so move to
  // a scratch directory first: backupBundle writes a real file and nothing here should land
  // in the project.
  const home = process.cwd();
  const scratch = await mkdtemp(path.join(tmpdir(), "digishack-backup-check-"));
  process.chdir(scratch);
  try {
    const { writeSqlDump, splitStatements } = await import("@/lib/db/backup");
    const { backupBundle } = await import("@/lib/db/bundle");
    const { tarUnpack } = await import("@/lib/db/tar");

    section("writeSqlDump: one snapshot while other writers work");
    seed();
    let dump = "";
    let counts: { tables: number; rows: number } | null = null;
    try {
      counts = await writeSqlDump(async (s) => {
        dump += s;
      });
    } catch (err) {
      ok(false, "writeSqlDump completed", err instanceof Error ? err.message : String(err));
    }
    if (counts) {
      eq(counts.tables, defs.size, "every table is counted");
      eq(
        counts.rows,
        AUDIT_ROWS + FAMILY * 2 + PAIR_A.length * PAIR_B + NOKEY.length,
        "the row count is the snapshot's row count",
      );
      assertDumpContent("dump", tuplesByTable(dump, splitStatements));
      assertDumpMechanics("dump");
    }

    section("backupBundle (the pre-update backup) uses the same snapshot");
    seed();
    try {
      const result = await backupBundle(false);
      const files = await readdir(path.join(scratch, "backups"));
      ok(files.includes(result.file), "the bundle was written to the backup directory");
      const entries = tarUnpack(gunzipSync(await readFile(path.join(scratch, "backups", result.file))));
      const sql = entries.find((e) => e.name === "database.sql")?.data.toString("utf8") ?? "";
      assertDumpContent("bundle", tuplesByTable(sql, splitStatements));
      assertDumpMechanics("bundle");
      eq(
        result.manifest.database.rows,
        AUDIT_ROWS + FAMILY * 2 + PAIR_A.length * PAIR_B + NOKEY.length,
        "bundle: the manifest's row count is the snapshot's",
      );
    } catch (err) {
      ok(false, "backupBundle completed", err instanceof Error ? err.message : String(err));
    }
  } finally {
    process.chdir(home);
    // Windows can hold a just-written archive open for a moment (a virus scanner reading
    // it), so retry, and never let tidying up fail a check that has already answered.
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (err: unknown) =>
        console.warn(`  (could not remove ${scratch}: ${err instanceof Error ? err.message : String(err)})`),
    );
  }

  console.log(
    "\nOffline: a fake client modelling InnoDB REPEATABLE READ. Not yet exercised against a real MySQL/MariaDB server under concurrent writes.",
  );
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

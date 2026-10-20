// Database backup and restore, for moving an installation to another machine.
//
// PURE NODE. No mysqldump, no mysql client, no external binaries at all — the dump
// is produced by reading the schema and rows through Prisma and writing SQL.
//
// The obvious implementation shells out to mysqldump, and the first version did.
// It does not work here: `mysqldump` and `mysql` are not on PATH on this machine,
// and they are not present by default on Windows at all, where most of this project
// runs. A backup feature that depends on tools the operator has to go and install
// separately is a backup feature that does not get used, and "self-contained" is the
// whole point of this application.
//
// What comes out is ordinary SQL — readable in an editor, loadable by any MySQL or
// MariaDB tool, and restorable by this application itself.
//
// This is NOT a substitute for ADIF export. ADIF moves QSOs between PROGRAMS. This
// moves an entire DigiShack: the log, the settings including their encrypted
// secrets, users, stations, DXCC reference data and the QSL queue.

import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createGunzip, createGzip } from "node:zlib";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

/** Where dumps are written. */
export const BACKUP_DIR = path.join(process.cwd(), "backups");

/** Rows per SELECT, and per INSERT statement. */
const CHUNK = 500;

/**
 * How long the dump's read transaction may stay open. A CEILING, not an estimate.
 *
 * Sized for the largest log this has to carry, not the typical one: about 40,000 contacts
 * plus the decode history, which grows by roughly 42,000 rows a day (lib/db/retention.ts)
 * and is kept forever when retention is 0. Each page is an index range scan, so even a
 * multi-million-row decode table is minutes of reading; two hours leaves a slow disk and a
 * slow gzip a very wide margin. Running out is LOUD — Prisma closes the transaction and
 * the next page throws, which deletes the partial file — never a short dump that claims
 * to be complete. A long read-only REPEATABLE READ transaction blocks no writer.
 */
const DUMP_TIMEOUT_MS = 2 * 60 * 60_000;

/** How long to wait for a pooled connection to start the dump on. */
const DUMP_MAX_WAIT_MS = 60_000;

/** What the dump needs from a client: raw reads, all on the one pinned connection. */
type RawReader = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

/**
 * Tables never included in a backup.
 *
 * Sessions are excluded deliberately: restoring them would hand every browser that
 * was logged in on the OLD machine a valid session on the new one, which is a
 * migration quietly becoming an access-control problem. Everyone signs in again —
 * that is the correct outcome, not an inconvenience.
 */
const SKIP_TABLES = new Set(["Session"]);

/**
 * Quote a value as a SQL literal.
 *
 * Hand-rolled because there is no driver here to do it. Every branch matters:
 *
 *   - Buffers become hex literals. A BLOB run through string escaping is corrupted
 *     silently and only shows up when something tries to read it back.
 *   - Dates are emitted in UTC with milliseconds. Local time would shift every
 *     timestamp in the log by the offset of whichever machine made the backup.
 *   - BigInt prints as digits, never with the `n` suffix.
 *   - Booleans become 1/0, which is what MySQL stores them as.
 *   - \0 and \x1a are escaped because MySQL requires it; \b and \t are escaped so
 *     the output stays on one line and remains diffable.
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) {
    return `'${v.toISOString().replace("T", " ").replace("Z", "")}'`;
  }
  if (Buffer.isBuffer(v)) return v.length === 0 ? "''" : `0x${v.toString("hex")}`;
  if (typeof v === "object") return sqlLiteral(JSON.stringify(v));

  const s = String(v);
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case "'": out += "\\'"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\b": out += "\\b"; break;
      case "\0": out += "\\0"; break;
      case "\x1a": out += "\\Z"; break;
      default: out += ch;
    }
  }
  return `'${out}'`;
}

/** Backtick-quote an identifier, rejecting anything that could break out. */
function ident(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to touch table name ${JSON.stringify(name)}`);
  }
  return `\`${name}\``;
}

async function listTables(db: RawReader): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Record<string, string>[]>("SHOW FULL TABLES");
  return rows
    .map((r) => {
      const vals = Object.values(r);
      // SHOW FULL TABLES returns (name, type); views cannot be dumped as data.
      return { name: String(vals[0] ?? ""), type: String(vals[1] ?? "BASE TABLE") };
    })
    .filter((t) => t.name && t.type === "BASE TABLE" && !SKIP_TABLES.has(t.name))
    .map((t) => t.name)
    .sort();
}

/**
 * The primary-key columns of `table`, in key order. Empty when it has none.
 *
 * Every Prisma model has a single-column key today, but the dump reads every table in the
 * database, and a composite key paged by only its first column would repeat or drop rows
 * at every page boundary that falls inside a run of equal first values.
 */
async function primaryKey(db: RawReader, table: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SHOW KEYS FROM ${ident(table)} WHERE Key_name = 'PRIMARY'`,
  );
  return rows
    .map((r) => ({ seq: Number(r.Seq_in_index), column: String(r.Column_name ?? "") }))
    .sort((a, b) => a.seq - b.seq)
    .map((k) => k.column);
}

/**
 * The next page of `table` in primary-key order: the rows after `after`, the previous
 * page's last key, or the first page when there is none.
 *
 * Keyset rather than OFFSET. Inside the snapshot OFFSET would be correct again, but this
 * does not lean on the snapshot to be right — no deletion can shift an unread row behind
 * the cursor — and each page is an index range scan instead of re-reading and discarding
 * everything before it, which made a large table quadratic.
 *
 * A composite key is compared as a tuple, spelled out as
 *   `a` > ? OR (`a` = ? AND `b` > ?) OR (`a` = ? AND `b` = ? AND `c` > ?)
 * rather than `(a, b) > (?, ?)`, because the expanded form is the one both MySQL's and
 * MariaDB's range optimisers turn into an index range. Values are bound, not inlined: a
 * literal would depend on the server's backslash-escaping mode.
 */
function pageQuery(
  table: string,
  key: string[],
  after: unknown[] | null,
): { sql: string; params: unknown[] } {
  const orderBy = key.map(ident).join(", ");
  if (!after) {
    return { sql: `SELECT * FROM ${ident(table)} ORDER BY ${orderBy} LIMIT ${CHUNK}`, params: [] };
  }
  const groups: string[] = [];
  const params: unknown[] = [];
  key.forEach((col, i) => {
    const terms: string[] = [];
    for (let j = 0; j < i; j++) {
      terms.push(`${ident(key[j]!)} = ?`);
      params.push(after[j]);
    }
    terms.push(`${ident(col)} > ?`);
    params.push(after[i]);
    groups.push(`(${terms.join(" AND ")})`);
  });
  return {
    sql: `SELECT * FROM ${ident(table)} WHERE ${groups.join(" OR ")} ORDER BY ${orderBy} LIMIT ${CHUNK}`,
    params,
  };
}

export interface BackupResult {
  file: string;
  bytes: number;
  tables: number;
  rows: number;
  createdAt: string;
}

/**
 * Write a gzipped SQL dump.
 *
 * Foreign keys are disabled for the whole restore rather than trying to order tables
 * by dependency: the graph has cycles in practice and getting the order wrong
 * produces a restore that fails halfway, leaving a half-populated database.
 */
export async function backupDatabase(): Promise<BackupResult> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(BACKUP_DIR, `digishack-${stamp}.sql.gz`);

  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(file);
  gzip.pipe(out);

  // One error listener for the whole dump, not one per write.
  //
  // Attaching `gzip.once("error", reject)` inside the write helper accumulated a
  // listener per call — about 190 of them for this log — and Node warned about a
  // leak at 11. Errors are surfaced through `finished` and through a captured flag
  // the writer checks, so a failure still aborts promptly.
  let streamError: Error | null = null;
  const noteError = (err: Error) => {
    streamError ??= err;
  };
  gzip.on("error", noteError);
  out.on("error", noteError);

  const write = (s: string): Promise<void> => {
    if (streamError) return Promise.reject(streamError);
    return new Promise((resolve) => {
      if (gzip.write(s)) resolve();
      else gzip.once("drain", resolve);
    });
  };

  const finished = new Promise<void>((resolve, reject) => {
    out.on("finish", () => (streamError ? reject(streamError) : resolve()));
    out.on("error", reject);
  });

  let totalRows = 0;
  let tableCount = 0;

  try {
    const counts = await writeSqlDump(write);
    tableCount = counts.tables;
    totalRows = counts.rows;
  } catch (err) {
    gzip.end();
    await unlink(file).catch(() => {});
    throw err;
  }

  gzip.end();
  await finished;

  const info = await stat(file);
  if (info.size < 512) {
    await unlink(file).catch(() => {});
    throw new Error(`The dump came out at ${info.size} bytes — that is not a usable backup`);
  }

  return {
    file: path.basename(file),
    bytes: info.size,
    tables: tableCount,
    rows: totalRows,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate the SQL dump, handing each chunk to `write`.
 *
 * Callback-based rather than returning a string: the raw SQL for this log is tens of
 * megabytes, and the plain-file path streams it straight into gzip without ever
 * holding it. The bundle path collects it, which it has to anyway. Both — and the
 * pre-update backup in lib/update/runner.ts, which is a bundle — come through here.
 *
 * ONE SNAPSHOT, READ IN KEY ORDER. This used to page every table with
 * `LIMIT 500 OFFSET n`, no ORDER BY, through the general connection pool. A row deleted
 * before the next page shifted every unread row back by one and the dump skipped one:
 * the 2026-10-14 code review started with 501 rows, deleted the first between pages, and
 * got a successful 500-row backup — which the bundle's checksum then certified. And
 * because every page was read at its own instant, a dump could hold a contact's park
 * reference rows without the contact, or a child without its parent: a database that
 * never existed. Now the whole dump is one REPEATABLE READ transaction, pinned to one
 * connection, and every table is paged by primary key.
 *
 * WHAT PRISMA ACTUALLY SENDS. Prisma 6.19's engine (quaint's MySQL connector) opens this
 * transaction as `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` followed by `BEGIN`.
 * There is no way to ask it for mysqldump's `START TRANSACTION WITH CONSISTENT SNAPSHOT`
 * — the engine binary contains no such statement — and sending one from in here would
 * implicitly COMMIT Prisma's transaction and open a new one at the SESSION's isolation
 * level, which on a server configured for READ COMMITTED takes no snapshot at all. It is
 * also unnecessary: under REPEATABLE READ, InnoDB creates a transaction's read view at
 * its FIRST consistent read, and every later consistent read in that transaction, on any
 * table, sees that same view. The first page of the first table pins the snapshot, one
 * statement later than WITH CONSISTENT SNAPSHOT would, and from there the dump is one
 * instant of the database. The SHOW statements before it read the data dictionary, not
 * rows; DDL against a table mid-dump makes MySQL refuse the read ("Table definition has
 * changed") rather than return something inconsistent. MariaDB's InnoDB behaves the same.
 *
 * UNVERIFIED against a real server: scripts/check-backup-snapshot.ts proves the dump
 * against a fake client that models the snapshot rule above, with writers deleting,
 * inserting and updating mid-dump. A backup and restore on the real MySQL/MariaDB with
 * the bridge writing decodes throughout is still owed. Non-InnoDB tables (MyISAM) have
 * no snapshot at all; Prisma creates none.
 */
export async function writeSqlDump(
  write: (s: string) => Promise<void>,
): Promise<{ tables: number; rows: number }> {
  return prisma.$transaction((tx) => dumpSnapshot(tx, write), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: DUMP_TIMEOUT_MS,
    maxWait: DUMP_MAX_WAIT_MS,
  });
}

async function dumpSnapshot(
  db: RawReader,
  write: (s: string) => Promise<void>,
): Promise<{ tables: number; rows: number }> {
  let totalRows = 0;
  let tableCount = 0;
  const tables = await listTables(db);

  await write(
    [
      `-- DigiShack backup`,
      `-- Created: ${new Date().toISOString()}`,
      `-- Tables: ${tables.length}`,
      `-- One consistent snapshot (a single REPEATABLE READ transaction), rows in primary-key order.`,
      `--`,
      `-- Restore with the Backup page, or: gunzip -c FILE | mysql -u USER -p DBNAME`,
      `--`,
      `-- The settings in here include encrypted secrets. The key that decrypts them`,
      `-- is SETTINGS_KEY in .env and is NOT part of this file — copy that across too`,
      `-- or every service credential restores as unreadable ciphertext.`,
      ``,
      `SET FOREIGN_KEY_CHECKS=0;`,
      `SET NAMES utf8mb4;`,
      `SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';`,
      ``,
    ].join("\n"),
  );

  for (const table of tables) {
    const created = await db.$queryRawUnsafe<Record<string, string>[]>(
      `SHOW CREATE TABLE ${ident(table)}`,
    );
    const ddl = Object.values(created[0] ?? {})[1];
    if (typeof ddl !== "string") throw new Error(`Could not read the schema for ${table}`);

    await write(`\n--\n-- ${table}\n--\n\n`);
    await write(`DROP TABLE IF EXISTS ${ident(table)};\n${ddl};\n\n`);
    tableCount++;

    // Paged rather than loaded whole: 40,000 QSOs with their text columns is not something
    // to hold in memory all at once.
    const key = await primaryKey(db, table);
    totalRows +=
      key.length > 0
        ? await dumpByKey(db, table, key, write)
        : await dumpWithoutKey(db, table, write);
  }

  await write(`\nSET FOREIGN_KEY_CHECKS=1;\n`);
  return { tables: tableCount, rows: totalRows };
}

/** One INSERT for a batch of rows, columns in the order the server returned them. */
function insertStatement(table: string, rows: Record<string, unknown>[]): string {
  const cols = Object.keys(rows[0]!);
  const colList = cols.map(ident).join(", ");
  const values = rows
    .map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`)
    .join(",\n  ");
  return `INSERT INTO ${ident(table)} (${colList}) VALUES\n  ${values};\n`;
}

async function dumpByKey(
  db: RawReader,
  table: string,
  key: string[],
  write: (s: string) => Promise<void>,
): Promise<number> {
  let rows = 0;
  let after: unknown[] | null = null;
  for (;;) {
    const { sql, params } = pageQuery(table, key, after);
    const page = await db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    if (page.length === 0) break;

    await write(insertStatement(table, page));
    rows += page.length;
    if (page.length < CHUNK) break;

    const last = page[page.length - 1]!;
    after = key.map((col) => {
      const v = last[col];
      // A key column that did not come back would bind as nothing and restart or end the
      // walk in the wrong place. Refuse rather than write a dump that is quietly short.
      if (v === undefined || v === null) {
        throw new Error(
          `Could not page ${table}: its primary-key column ${col} came back ${v === null ? "NULL" : "missing"}`,
        );
      }
      return v;
    });
  }
  return rows;
}

/**
 * A table with no primary key, read in one statement (still inside the snapshot).
 *
 * There is nothing to page it by that is both unique and ordered, and OFFSET over a sort
 * of every column is deterministic only up to max_sort_length on long text. Every Prisma
 * model has a key, so this is for tables something else created; it trades memory for an
 * exact copy.
 */
async function dumpWithoutKey(
  db: RawReader,
  table: string,
  write: (s: string) => Promise<void>,
): Promise<number> {
  const all = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM ${ident(table)}`,
  );
  for (let i = 0; i < all.length; i += CHUNK) {
    await write(insertStatement(table, all.slice(i, i + CHUNK)));
  }
  return all.length;
}

export interface RestoreResult {
  statements: number;
  bytes: number;
}

/**
 * Split SQL into statements on semicolons that are not inside a literal.
 *
 * A naive `split(";")` breaks any row containing a semicolon in a comment field or a
 * QSL template — and this log has plenty. Tracks quoting and escapes so only real
 * statement terminators count.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      else continue;
    }

    if (quote) {
      cur += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }

    // `--` only starts a comment when followed by whitespace, per MySQL.
    if (ch === "-" && sql[i + 1] === "-" && /\s/.test(sql[i + 2] ?? " ")) {
      lineComment = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Restore from a dump stream.
 *
 * DESTRUCTIVE — the dump drops every table it covers. There is no undo, and the
 * QSOs that vanish are the ones nobody exported. The caller must make the operator
 * say so explicitly.
 *
 * Restart the application afterwards. Prisma holds a connection pool and settings
 * are cached in memory; serving from that state once the tables underneath have been
 * replaced fails in ways that look like corruption rather than like a restore.
 */
export async function restoreDatabase(
  source: NodeJS.ReadableStream,
  opts: { gzipped: boolean },
): Promise<RestoreResult> {
  const stream = opts.gzipped ? source.pipe(createGunzip()) : source;

  const chunks: Buffer[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      bytes += b.length;
      chunks.push(b);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const result = await restoreSqlText(Buffer.concat(chunks).toString("utf8"));
  return { statements: result.statements, bytes };
}

/**
 * Apply a dump that is already in memory.
 *
 * Split out so a bundle can reuse it: the SQL there arrives as a tar entry, not a
 * stream, and having two copies of the statement loop would mean two places for the
 * "does this even look like a backup?" check to drift out of step.
 */
export async function restoreSqlText(sql: string): Promise<{ statements: number }> {
  if (!/CREATE TABLE/i.test(sql)) {
    throw new Error(
      "That file contains no CREATE TABLE statements — it does not look like a DigiShack backup",
    );
  }

  const statements = splitStatements(sql);
  let ran = 0;
  // ONE connection, not the pool. The dump opens with `SET FOREIGN_KEY_CHECKS=0` — a
  // SESSION variable — and a bare $executeRawUnsafe loop borrows whichever pooled
  // connection is free per statement, so the SET landed on one connection and the
  // INSERTs ran with checks on elsewhere. The dump writes tables alphabetically, so
  // digitaldecode's rows arrive before the qso rows they reference, and the first
  // restore of real data died mid-table on the foreign key. An interactive
  // transaction pins every statement to a single connection, which is the property
  // actually needed. (MySQL DDL still auto-commits inside it, so this is connection
  // pinning more than atomicity — the manifest checksum upstream is what protects
  // against applying a bad dump.)
  await prisma.$transaction(
    async (tx) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
        ran++;
      }
    },
    // A generous ceiling, not a target: 226k rows took well under a minute locally,
    // but a Raspberry-class disk should not lose its restore to a stopwatch.
    { timeout: 60 * 60_000, maxWait: 60_000 },
  );
  return { statements: ran };
}

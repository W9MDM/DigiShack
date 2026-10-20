// An in-memory stand-in for Prisma over InnoDB, for the concurrency checks.
//
// Installed as `globalThis.prisma` BEFORE any application module is imported, so
// lib/db/prisma.ts hands it out instead of a real client. Nothing here opens a socket.
//
// It models the three database behaviours the concurrency checks are about, and no others:
//
//   1. ROW LOCKS. A write takes an exclusive lock on every row it touches (and on every unique
//      value it inserts), held until its transaction commits or rolls back. A second writer to
//      the same row waits, and then acts on the latest committed version — as InnoDB does.
//   2. REPEATABLE READ. A transaction's consistent reads come from a snapshot taken at its
//      FIRST read — not at BEGIN — plus its own writes. This is the property the invariant
//      lock depends on, so a read placed before the lock would see stale data here too.
//   3. COMMIT VISIBILITY. Nothing a transaction writes is visible to anyone else until it
//      commits; a rollback discards it.
//
// Every statement yields to the event loop first, like a network round trip, so two requests
// started together interleave statement by statement rather than running back to back.
//
// It is a MODEL. A check passing on it shows the application takes the lock first and does its
// check and write under it. That a real MySQL/MariaDB behaves like the model is the documented
// behaviour of InnoDB, assumed rather than measured.

import { Prisma } from "@prisma/client";

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Table = Map<string, Row>;

interface Args {
  where?: Where;
  data?: Row | Row[];
  create?: Row;
  update?: Row;
  include?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
  skipDuplicates?: boolean;
}

/** Primary key and unique columns per model. */
const SPECS: Record<string, { pk: string; unique: string[] }> = {
  user: { pk: "id", unique: ["email"] },
  session: { pk: "id", unique: ["tokenHash"] },
  setting: { pk: "key", unique: [] },
  qslEmail: { pk: "id", unique: ["qsoId"] },
  qslOptOut: { pk: "id", unique: ["callsign"] },
};
function spec(table: string): { pk: string; unique: string[] } {
  return SPECS[table] ?? { pk: "id", unique: [] };
}

export class FakeTx {
  snapshot: Map<string, Table> | null = null;
  readonly writes = new Map<string, Map<string, Row | null>>();
  readonly locks = new Set<string>();
  constructor(readonly id: number) {}
}

/** A lazy statement, like a PrismaPromise: runs when awaited, or inside `$transaction([...])`. */
class Op<T> implements PromiseLike<T> {
  private started: Promise<T> | null = null;
  constructor(
    private readonly exec: (tx: FakeTx | null) => Promise<T>,
    private readonly tx: FakeTx | null,
  ) {}
  run(tx: FakeTx | null): Promise<T> {
    return this.exec(tx);
  }
  then<A = T, B = never>(
    ok?: ((v: T) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.started ??= this.exec(this.tx);
    return this.started.then(ok, bad);
  }
  catch<B = never>(bad: (e: unknown) => B | PromiseLike<B>): Promise<T | B> {
    return this.then(undefined, bad);
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, arg] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "not") { if (same(v, arg)) return false; }
        else if (op === "in") { if (!(arg as unknown[]).some((x) => same(v, x))) return false; }
        else if (op === "gte") { if (v == null || cmp(v, arg) < 0) return false; }
        else if (op === "lte") { if (v == null || cmp(v, arg) > 0) return false; }
        else if (op === "gt") { if (v == null || cmp(v, arg) <= 0) return false; }
        else if (op === "lt") { if (v == null || cmp(v, arg) >= 0) return false; }
        else throw new Error(`fake-db: unsupported filter ${k}.${op}`);
      }
      continue;
    }
    if (!same(v, cond)) return false;
  }
  return true;
}

function knownError(code: string, message: string): Error {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "fake-db" });
}

export class FakeDb {
  private committed = new Map<string, Table>();
  private holders = new Map<string, FakeTx>();
  private wakers: Array<() => void> = [];
  private txSeq = 0;
  private idSeq = 0;
  /** Every statement as the "server" ran it: `T<n> <op> <table>`; T0 is autocommit. */
  readonly log: string[] = [];
  /** When set, every write throws — the database went away. */
  failWrites: Error | null = null;
  /** Called before each statement runs; may be async. */
  beforeStatement: ((op: string, table: string, args: Args) => void | Promise<void>) | null = null;

  constructor(private readonly roundTripMs = 1) {}

  install(): void {
    (globalThis as unknown as { prisma: unknown }).prisma = this.client(null);
  }

  reset(): void {
    this.committed.clear();
    this.log.length = 0;
    this.failWrites = null;
    this.beforeStatement = null;
  }

  /** Committed rows of a table, for assertions. */
  rows(table: string): Row[] {
    return [...(this.committed.get(table)?.values() ?? [])];
  }

  /** Put rows straight into the committed state, as if they had always been there. */
  seed(table: string, rows: Row[]): void {
    const t = this.table(this.committed, table);
    for (const r of rows) {
      const pk = String(r[spec(table).pk] ?? `${table}-${++this.idSeq}`);
      t.set(pk, { ...r, [spec(table).pk]: pk });
    }
  }

  /** A committed write from "somebody else", outside any transaction the app knows about. */
  async poke(table: string, pk: string, data: Row): Promise<void> {
    await this.autocommit(async (tx) => {
      await this.lock(tx, `${table}:${pk}`);
      const cur = this.latest(tx, table).get(pk);
      if (cur) this.write(tx, table, pk, { ...cur, ...data });
    });
  }

  // -------------------------------------------------------------------------

  private table(m: Map<string, Table>, name: string): Table {
    let t = m.get(name);
    if (!t) m.set(name, (t = new Map()));
    return t;
  }

  private overlay(base: Table | undefined, tx: FakeTx | null, table: string): Table {
    const out: Table = new Map(base ?? []);
    for (const [pk, r] of tx?.writes.get(table) ?? []) {
      if (r === null) out.delete(pk);
      else out.set(pk, r);
    }
    return out;
  }

  /** What a consistent read sees. */
  private visible(tx: FakeTx | null, table: string): Table {
    if (!tx) return this.overlay(this.committed.get(table), null, table);
    if (!tx.snapshot) {
      tx.snapshot = new Map([...this.committed].map(([k, t]) => [k, new Map(t)]));
    }
    return this.overlay(tx.snapshot.get(table), tx, table);
  }

  /** What a locking statement sees: the latest committed rows, plus this transaction's own. */
  private latest(tx: FakeTx | null, table: string): Table {
    return this.overlay(this.committed.get(table), tx, table);
  }

  private write(tx: FakeTx, table: string, pk: string, row: Row | null): void {
    if (this.failWrites) throw this.failWrites;
    let w = tx.writes.get(table);
    if (!w) tx.writes.set(table, (w = new Map()));
    w.set(pk, row);
  }

  private async lock(tx: FakeTx, key: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const holder = this.holders.get(key);
      if (!holder || holder === tx) {
        this.holders.set(key, tx);
        tx.locks.add(key);
        return;
      }
      if (Date.now() > deadline) throw new Error(`fake-db: lock wait timeout on ${key}`);
      await new Promise<void>((resolve) => {
        this.wakers.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  private finish(tx: FakeTx, commit: boolean): void {
    if (commit) {
      for (const [table, w] of tx.writes) {
        const t = this.table(this.committed, table);
        for (const [pk, r] of w) {
          if (r === null) t.delete(pk);
          else t.set(pk, r);
        }
      }
    }
    for (const key of tx.locks) this.holders.delete(key);
    const wake = this.wakers;
    this.wakers = [];
    for (const w of wake) w();
  }

  private async autocommit<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    const tx = new FakeTx(0);
    try {
      const r = await fn(tx);
      this.finish(tx, true);
      return r;
    } catch (err) {
      this.finish(tx, false);
      throw err;
    }
  }

  private async begin<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    const tx = new FakeTx(++this.txSeq);
    this.log.push(`T${tx.id} BEGIN`);
    try {
      const r = await fn(tx);
      this.finish(tx, true);
      this.log.push(`T${tx.id} COMMIT`);
      return r;
    } catch (err) {
      this.finish(tx, false);
      this.log.push(`T${tx.id} ROLLBACK`);
      throw err;
    }
  }

  private withRelations(tx: FakeTx | null, row: Row, include: Args["include"]): Row {
    if (!include) return row;
    const out = { ...row };
    for (const rel of Object.keys(include)) {
      const fk = row[`${rel}Id`];
      if (typeof fk === "string") out[rel] = this.visible(tx, rel).get(fk) ?? null;
    }
    return out;
  }

  private async statement<T>(
    tx: FakeTx | null,
    op: string,
    table: string,
    args: Args,
    body: (tx: FakeTx | null) => Promise<T>,
  ): Promise<T> {
    await new Promise((r) => setTimeout(r, this.roundTripMs));
    if (this.beforeStatement) await this.beforeStatement(op, table, args);
    this.log.push(`T${tx?.id ?? 0} ${op} ${table}`);
    return body(tx);
  }

  private findRow(t: Table, table: string, where: Where | undefined): [string, Row] | undefined {
    const pk = spec(table).pk;
    const key = where?.[pk];
    if (typeof key === "string" && Object.keys(where ?? {}).length === 1) {
      const r = t.get(key);
      return r ? [key, r] : undefined;
    }
    for (const [k, r] of t) if (matches(r, where)) return [k, r];
    return undefined;
  }

  private async insert(tx: FakeTx, table: string, data: Row, skipDuplicates = false): Promise<Row | null> {
    const s = spec(table);
    const pk = String(data[s.pk] ?? `${table}-${++this.idSeq}`);
    await this.lock(tx, `${table}:${pk}`);
    for (const u of s.unique) if (data[u] !== undefined) await this.lock(tx, `${table}.${u}=${String(data[u])}`);
    const latest = this.latest(tx, table);
    const dup =
      latest.has(pk) ||
      s.unique.some((u) => data[u] !== undefined && [...latest.values()].some((r) => same(r[u], data[u])));
    if (dup) {
      if (skipDuplicates) return null;
      throw knownError("P2002", `Unique constraint failed on ${table}`);
    }
    const now = new Date();
    const row: Row = { createdAt: now, updatedAt: now, ...data, [s.pk]: pk };
    this.write(tx, table, pk, row);
    return row;
  }

  /** Locking UPDATE/DELETE of every row matching `where`, re-checked after each lock wait. */
  private async modify(tx: FakeTx, table: string, where: Where | undefined, change: Row | null): Promise<Row[]> {
    const candidates = [...this.latest(tx, table)].filter(([, r]) => matches(r, where)).map(([k]) => k);
    const done: Row[] = [];
    for (const pk of candidates) {
      await this.lock(tx, `${table}:${pk}`);
      const cur = this.latest(tx, table).get(pk);
      if (!cur || !matches(cur, where)) continue;
      const next = change === null ? null : { ...cur, ...change, updatedAt: new Date() };
      this.write(tx, table, pk, next);
      done.push(next ?? cur);
    }
    return done;
  }

  private delegate(table: string, bound: FakeTx | null): Record<string, (args?: Args) => Op<unknown>> {
    const st = <T>(op: string, args: Args, body: (tx: FakeTx | null) => Promise<T>) =>
      new Op<T>((tx) => this.statement(tx, op, table, args, body), bound);
    const inTx = <T>(tx: FakeTx | null, fn: (t: FakeTx) => Promise<T>) =>
      tx ? fn(tx) : this.autocommit(fn);
    return {
      findUnique: (a = {}) =>
        st("SELECT", a, async (tx) => {
          const hit = this.findRow(this.visible(tx, table), table, a.where);
          return hit ? this.withRelations(tx, hit[1], a.include) : null;
        }),
      findFirst: (a = {}) =>
        st("SELECT", a, async (tx) => {
          const hit = this.findRow(this.visible(tx, table), table, a.where);
          return hit ? this.withRelations(tx, hit[1], a.include) : null;
        }),
      findMany: (a = {}) =>
        st("SELECT", a, async (tx) => {
          let rows = [...this.visible(tx, table).values()].filter((r) => matches(r, a.where));
          const [field, dir] = Object.entries(a.orderBy ?? {})[0] ?? [];
          if (field) rows.sort((x, y) => cmp(x[field], y[field]) * (dir === "desc" ? -1 : 1));
          if (a.take !== undefined) rows = rows.slice(0, a.take);
          return rows.map((r) => this.withRelations(tx, r, a.include));
        }),
      count: (a = {}) =>
        st("SELECT COUNT", a, async (tx) =>
          [...this.visible(tx, table).values()].filter((r) => matches(r, a.where)).length,
        ),
      create: (a = {}) =>
        st("INSERT", a, (tx) => inTx(tx, async (t) => (await this.insert(t, table, a.data as Row))!)),
      createMany: (a = {}) =>
        st("INSERT", a, (tx) =>
          inTx(tx, async (t) => {
            let count = 0;
            for (const d of a.data as Row[]) if (await this.insert(t, table, d, a.skipDuplicates)) count++;
            return { count };
          }),
        ),
      update: (a = {}) =>
        st("UPDATE", a, (tx) =>
          inTx(tx, async (t) => {
            const [row] = await this.modify(t, table, a.where, a.data as Row);
            if (!row) throw knownError("P2025", `No ${table} record to update`);
            return row;
          }),
        ),
      updateMany: (a = {}) =>
        st("UPDATE", a, (tx) =>
          inTx(tx, async (t) => ({ count: (await this.modify(t, table, a.where, a.data as Row)).length })),
        ),
      upsert: (a = {}) =>
        st("UPSERT", a, (tx) =>
          inTx(tx, async (t) => {
            const [row] = await this.modify(t, table, a.where, a.update ?? {});
            return row ?? (await this.insert(t, table, { ...a.where, ...a.create }));
          }),
        ),
      delete: (a = {}) =>
        st("DELETE", a, (tx) =>
          inTx(tx, async (t) => {
            const [row] = await this.modify(t, table, a.where, null);
            if (!row) throw knownError("P2025", `No ${table} record to delete`);
            return row;
          }),
        ),
      deleteMany: (a = {}) =>
        st("DELETE", a, (tx) =>
          inTx(tx, async (t) => ({ count: (await this.modify(t, table, a.where, null)).length })),
        ),
    };
  }

  /** The one raw statement the application issues: the invariant lock. */
  private executeRaw(bound: FakeTx | null, strings: TemplateStringsArray, values: unknown[]): Op<number> {
    const sql = strings.join("?");
    const m = /^UPDATE `Setting` SET `value` = \? WHERE `key` = \?$/.exec(sql);
    if (!m) throw new Error(`fake-db: unsupported raw SQL: ${sql}`);
    const args: Args = { where: { key: values[1] }, data: { value: values[0] } };
    return new Op<number>(
      (tx) =>
        this.statement(tx, "LOCK", "setting", args, (t) =>
          (t ? Promise.resolve(t) : Promise.reject(new Error("lock outside a transaction"))).then(
            async (tt) => (await this.modify(tt, "setting", args.where, args.data as Row)).length,
          ),
        ),
      bound,
    );
  }

  client(bound: FakeTx | null): unknown {
    const delegates = new Map<string, unknown>();
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== "string") return undefined;
          if (prop === "then") return undefined;
          if (prop === "$executeRaw") {
            return (strings: TemplateStringsArray, ...values: unknown[]) =>
              this.executeRaw(bound, strings, values);
          }
          if (prop === "$transaction") {
            return (arg: unknown) => {
              if (Array.isArray(arg)) {
                return this.begin(async (tx) => {
                  const out: unknown[] = [];
                  for (const op of arg as Op<unknown>[]) out.push(await op.run(tx));
                  return out;
                });
              }
              return this.begin((tx) => (arg as (c: unknown) => Promise<unknown>)(this.client(tx)));
            };
          }
          if (prop.startsWith("$")) return async () => undefined;
          if (!delegates.has(prop)) delegates.set(prop, this.delegate(prop, bound));
          return delegates.get(prop);
        },
      },
    );
  }

  /** The statements of each transaction, in order, keyed by transaction number. */
  transactions(): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const line of this.log) {
      const m = /^T(\d+) (.*)$/.exec(line);
      if (!m || m[1] === "0") continue;
      const id = Number(m[1]);
      const list = out.get(id) ?? [];
      list.push(m[2]!);
      out.set(id, list);
    }
    return out;
  }
}

/** A minimal Next.js API response that records what the handler sent. */
export interface FakeResponse {
  code: number;
  body: unknown;
  headers: Record<string, unknown>;
  status(n: number): FakeResponse;
  setHeader(k: string, v: unknown): FakeResponse;
  getHeader(k: string): unknown;
  send(s: string): void;
}
export function fakeResponse(): FakeResponse {
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
  };
}

export function fakeRequest(r: {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  session?: string;
}): unknown {
  return {
    method: r.method,
    query: r.query ?? {},
    body: r.body,
    headers: {},
    cookies: r.session ? { digishack_session: r.session } : {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

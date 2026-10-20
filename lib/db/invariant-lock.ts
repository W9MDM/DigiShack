import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

// One lock around a check and the write that depends on it, held across every process that
// shares the database.
//
// THE FAULT (R13, R14 in the 1.185.2 review). First-run setup counted users and then created
// an admin. The users API counted the OTHER active admins and then demoted, disabled or
// deleted one. Each was a read followed by a write with nothing stopping a second request
// doing its own read in between: two setup posts with different emails could both count
// zero and both create an admin, and two admins demoting themselves at the same moment could
// each see the other still active, both succeed, and leave nobody able to sign in. Wrapping
// the pair in a transaction did not help on its own — under REPEATABLE READ each transaction
// simply counts its own snapshot — and the email unique index only arbitrates same-email races.
//
// THE LOCK is an InnoDB row lock on one fixed `Setting` row per invariant (`lock.<name>`),
// taken by an UPDATE that is the FIRST statement of a Prisma interactive transaction, and
// released by the server at COMMIT or ROLLBACK.
//
//   * Prisma runs every statement of an interactive transaction on one pooled connection, and
//     a row lock belongs to the transaction, so the lock, the check and the write share one
//     transaction and there is no release step to misplace: an exception, a Prisma timeout and
//     a dropped connection all end in a rollback that frees it.
//   * Not GET_LOCK. A named lock belongs to the CONNECTION, not the transaction. Released inside
//     the callback, it is free before Prisma's COMMIT, so the next holder can count before this
//     one's write is visible — the original race, narrowed. Released after, it would have to run
//     on a connection the pool has already handed back; never released, it stays held by
//     whichever pooled connection happened to take it.
//   * Why reads under the lock see the previous holder's writes: InnoDB fixes a REPEATABLE READ
//     snapshot at a transaction's first consistent READ, not at BEGIN, and Prisma opens MySQL
//     transactions with a plain BEGIN (its engine carries no `WITH CONSISTENT SNAPSHOT`). A
//     waiter's UPDATE only returns once the holder has committed, so the waiter's first read
//     comes after that commit. That is why the lock must be the first statement, and why `fn`
//     only ever runs after it. The isolation level is deliberately left alone: READ COMMITTED
//     would also work, but on a server logging binlog_format=STATEMENT every write under it
//     fails — including first-run setup.
//   * MariaDB is the same InnoDB locking. Its 11.8 `innodb_snapshot_isolation` can refuse a write
//     to a row somebody else changed after this transaction's first read ("Record has changed
//     since last read"); that, a deadlock, and a lock row that has disappeared (a restore of an
//     older backup) are retried from the top.
//
// UNVERIFIED against a real server: the checks run on an in-memory model of these semantics
// (scripts/fake-db.ts). That MySQL/MariaDB behave as modelled is the documented behaviour, not
// something measured here.
//
// The row is a lock, not a setting: absent from the registry like `lotw.lastRunAt`, and its
// value is only a stamp of the last acquisition.

/** Every invariant lock, named once so two callers cannot drift onto different rows. */
export const LOCKS = {
  /** Who the active admins are: first-run setup, and demoting, disabling or deleting a user. */
  admins: "users.admins",
} as const;

const MAX_ATTEMPTS = 3;

/** Lock rows already known to exist in this process — saves an INSERT IGNORE per call. */
const ensured = new Set<string>();

class LockRowMissing extends Error {}

function retryable(err: unknown): boolean {
  if (err instanceof LockRowMissing) return true;
  // "Transaction failed due to a write conflict or a deadlock. Please retry your transaction"
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") return true;
  // MariaDB's snapshot-isolation refusal (ER_CHECKREAD), which Prisma has no code for.
  return (
    err instanceof Error &&
    /Record has changed since last read|Deadlock found when trying to get lock/i.test(err.message)
  );
}

/**
 * Run `fn` holding the named invariant lock. `fn` gets the transaction client and must do
 * BOTH its check and its write through it; anything it reads it reads after the lock.
 *
 * `fn` may run more than once (see the retries above), so it must not have side effects
 * outside the database — hash passwords before calling, revoke sessions after.
 */
export async function withInvariantLock<T>(
  name: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const key = `lock.${name}`;
  for (let attempt = 1; ; attempt++) {
    if (!ensured.has(key)) {
      // INSERT IGNORE, in its own autocommit statement BEFORE the transaction. Inside it, two
      // first-time callers would each hold a shared lock on the duplicate and then both need
      // the exclusive one — a deadlock. Here it can only wait for a current holder's commit.
      await prisma.setting.createMany({ data: [{ key, value: "" }], skipDuplicates: true });
      ensured.add(key);
    }
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Raw, so it is exactly one statement: an ORM call is free to read before it writes,
          // and a read here would fix the snapshot before the lock was granted. The stamp is
          // unique so the row always CHANGES and the affected-row count is 1 whether or not
          // the server counts found rows or changed rows.
          const stamp = `${new Date().toISOString()} ${randomUUID()}`;
          const held = await tx.$executeRaw`UPDATE \`Setting\` SET \`value\` = ${stamp} WHERE \`key\` = ${key}`;
          if (held !== 1) throw new LockRowMissing(key);
          return fn(tx);
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch (err) {
      if (err instanceof LockRowMissing) ensured.delete(key);
      if (attempt < MAX_ATTEMPTS && retryable(err)) continue;
      throw err;
    }
  }
}

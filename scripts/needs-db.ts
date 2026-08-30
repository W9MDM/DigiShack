/* eslint-disable no-console */
// "Is there a database to check against?" — asked once, answered the same way everywhere.
//
// Three checks in the suite talk to MySQL. Without one they did not fail, they THREW: a
// raw `PrismaClientInitializationError` and a stack trace, which stops `npm run check`
// dead and takes every check after it with it.
//
// That is how an operator's update log came to read
//
//     SKIPPED  npm run check  exit 1
//
// The updater treats a failing suite as skipped rather than fatal — which is right, an
// update should not be blocked by a test environment — but it means a suite that cannot
// run looks exactly like a suite that ran and found nothing. Nobody reads a check that is
// expected to fail.
//
// So a missing database is reported as a SKIP with a reason, and the check exits 0. A
// database that is present and disagrees with the code still fails, which is the part that
// matters. The same distinction `check-card-fonts` already makes for a platform that
// resolves fonts through the OS.

import net from "node:net";

import { prisma } from "@/lib/db/prisma";

/**
 * Is a database server listening where DATABASE_URL points?
 *
 * A TCP connect rather than a Prisma query, for one practical reason: Prisma writes its
 * own `prisma:error … Can't reach database server` block to stderr, asynchronously, and
 * there is no per-query way to quiet it. Silencing stderr around the call does not catch
 * it — it is emitted after the promise settles — so the output became a red error block
 * followed by "Not a failure: nothing was checked", which reads as a failure being excused
 * rather than a skip. The noise was the thing this existed to remove.
 *
 * What this deliberately does NOT test: credentials, or whether the schema is migrated. A
 * server that answers on the port but rejects the login, or one with no tables, still
 * fails the check loudly — and it should. Those are real misconfigurations on a machine
 * that HAS a database. This distinguishes only "there is no database here", which is the
 * development and CI case and is not a fault.
 */
export async function databaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || 3306;
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Skip the calling check, cleanly, when there is no database.
 *
 * Returns true if the caller should stop. Print nothing else and exit 0 — a skip is not a
 * pass and must not be dressed up as one, but it is not a failure either.
 *
 *     if (await skipWithoutDatabase("check:pota-refs")) process.exit(0);
 */
export async function skipWithoutDatabase(name: string): Promise<boolean> {
  if (await databaseReachable()) return false;
  console.log(
    `  skip  ${name} needs a database and none is reachable — set DATABASE_URL and run ` +
      `\`npx prisma migrate deploy\`. Not a failure: nothing was checked.`,
  );
  await prisma.$disconnect().catch(() => undefined);
  return true;
}

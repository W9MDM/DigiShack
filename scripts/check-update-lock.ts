/* eslint-disable no-console */
// R15: exactly one self-update runs, however many requests arrive together.
//
// The route asked "is one running?" (the state file), then awaited a git fetch, then started a
// run that awaited another before writing "running" — so two requests in that window both
// started. Now admission is a synchronous O_EXCL lock file, taken before the first await.
//
// HERMETIC. The runner is imported with the working directory set to a fresh temp dir, so its
// state and lock files land there and never in this checkout. Every child process it would
// start — git, npm, pm2 — is replaced by a fake that exits 128, which the runner reads as "not
// a git checkout", so a run that starts ends at its first step. Nothing is fetched, installed,
// built or reloaded. The database is a stub that answers the session lookup and, after a
// deliberate delay, update.allowFromUi = true.

import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { fakeRequest, fakeResponse } from "./fake-db";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pid that has certainly exited, taken before spawn is replaced.
const deadPid = cp.spawnSync(process.execPath, ["-e", ""]).pid;

const spawned: string[] = [];
(cp as unknown as { spawn: unknown }).spawn = (cmd: string, args: string[]) => {
  spawned.push(`${cmd} ${args.join(" ")}`);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill() {},
    unref() {},
  });
  setTimeout(() => child.emit("close", 128), 5);
  return child;
};
(cp as unknown as { execFileSync: unknown }).execFileSync = () => {
  throw new Error("check-update-lock: no real git");
};

const SETTINGS_DELAY_MS = 150;
(globalThis as unknown as { prisma: unknown }).prisma = {
  session: {
    async findUnique() {
      return {
        id: "s-admin",
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt: new Date(),
        user: { id: "admin", email: "admin@example.invalid", name: "Admin", callsign: null, role: "ADMIN", active: true },
      };
    },
  },
  setting: {
    // The "delayed initial update check": the first await inside checkForUpdate.
    async findMany() {
      await sleep(SETTINGS_DELAY_MS);
      return [{ key: "update.allowFromUi", value: "true", encrypted: false }];
    },
  },
};

type Handler = (req: unknown, res: unknown) => Promise<void>;
type Runner = typeof import("@/lib/update/runner");

async function call(h: Handler, method: string, action?: string): Promise<{ code: number; body: unknown }> {
  const res = fakeResponse();
  await h(fakeRequest({ method, query: action ? { action } : {}, session: "token" }), res);
  return { code: res.code, body: res.body };
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "check-update-lock-"));
  const here = process.cwd();
  process.chdir(dir);
  let route: Handler;
  let runner: Runner;
  try {
    runner = await import("@/lib/update/runner");
    route = (await import("@/pages/api/update")).default as unknown as Handler;
  } finally {
    process.chdir(here);
  }
  const lockFile = path.join(dir, "logs", "update.lock");
  const stateFile = path.join(dir, "logs", "update-state.json");
  const until = async (cond: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(20);
    return cond();
  };
  const revParses = () => spawned.filter((s) => s === "git rev-parse --abbrev-ref HEAD").length;

  try {
    console.log("two update requests while the first one's check is still running");
    {
      const first = call(route, "POST", "run");
      const second = call(route, "POST", "run");
      await sleep(SETTINGS_DELAY_MS / 2);
      const during = await call(route, "GET");
      const codes = [(await first).code, (await second).code];
      ok([...codes].sort().join(",") === "202,409", "exactly one starts (202) and the other is refused (409)", codes.join(","));
      ok(
        (during.body as { running?: boolean } | null)?.running === true,
        "GET reports running while that first check is still under way",
        JSON.stringify(during.body),
      );
      ok(await until(() => !runner.isRunning()), "the run finishes and stops reporting running");
      let state: { phase?: string; error?: string | null } = {};
      try {
        state = JSON.parse(readFileSync(stateFile, "utf8")) as typeof state;
      } catch {
        /* reported by the assertion below */
      }
      ok(state.phase === "failed" && /Not a git checkout/.test(state.error ?? ""), "the one run reached the runner and ended at its first step", JSON.stringify(state));
      // One check in the admitted request, one inside its run. Two runs would make four.
      ok(revParses() === 2, "only one run was performed", `${revParses()} update checks`);
      ok(!existsSync(lockFile), "and its lock is gone");
      const after = await call(route, "POST", "run");
      ok(after.code === 202, "a later request is admitted again", String(after.code));
      await until(() => !runner.isRunning());
    }

    console.log("\nthe lock itself");
    const acquire = (runner as Partial<Runner>).acquireUpdateLock;
    if (typeof acquire !== "function") {
      ok(false, "lib/update/runner.ts exports acquireUpdateLock");
    } else {
      const put = (record: unknown, ageMs = 0) => {
        mkdirSync(path.dirname(lockFile), { recursive: true });
        writeFileSync(lockFile, typeof record === "string" ? record : JSON.stringify(record));
        const t = new Date(Date.now() - ageMs);
        utimesSync(lockFile, t, t);
      };
      const rec = (over: Record<string, unknown>) => ({
        token: "someone-else",
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        ...over,
      });
      const takes = (label: string) => {
        const l = acquire();
        ok(l !== null, label);
        l?.release();
      };
      const refuses = (label: string) => {
        const l = acquire();
        ok(l === null, label);
        l?.release();
      };

      const a = acquire();
      ok(a !== null && runner.isRunning(), "taken: isRunning() is true");
      refuses("a second acquire in the same process is refused");
      a?.release();
      a?.release();
      ok(!runner.isRunning() && !existsSync(lockFile), "released (twice, harmlessly): free again");

      put(rec({ pid: process.ppid }));
      refuses("a lock held by another live process on this host is respected");
      put(rec({ pid: deadPid }));
      takes(`a lock whose process (${deadPid}) has exited is cleared and taken`);
      put(rec({ token: "not-mine" }));
      takes("a lock naming this pid that this process never took (pid reuse) is cleared");
      put(rec({ host: "some-other-host", pid: 1 }));
      refuses("a fresh lock from another host is respected");
      put(rec({ host: "some-other-host", pid: 1, acquiredAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
      takes("a three-hour-old lock from another host is cleared");
      put("");
      refuses("an unreadable lock seconds old may still be being written: respected");
      put("{", 60_000);
      takes("an unreadable lock a minute old is cleared");

      const held = acquire();
      const before = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "";
      const refused = await runner.performUpdate("check-update-lock (direct call)");
      ok(refused.phase === "failed" && /already in progress/.test(refused.error ?? ""), "performUpdate() called while a run holds the lock refuses", JSON.stringify(refused.error));
      ok((existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "") === before, "and does not overwrite the running update's state file");
      held?.release();
    }
  } finally {
    await sleep(100);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      console.warn(`  (could not remove ${dir}: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getBooleanSetting, getSetting } from "@/lib/settings";

// Self-update: fetch the configured branch, install, migrate, build, reload.
//
// This is remote code execution as a feature. Three things contain it:
//
//   1. ADMIN only, enforced by the route.
//   2. `update.allowFromUi` defaults to FALSE, so upgrading DigiShack never
//      silently adds this capability to an existing install — an operator has to
//      consciously turn it on.
//   3. It refuses to run on a dirty working tree, and only ever fast-forwards, so
//      it cannot discard local work or rewrite history.
//
// State lives in a FILE, not just memory: the last step reloads the app under
// PM2, which kills this process. Without a persisted state the UI would lose the
// outcome of the very run it started.

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, "logs");
const STATE_FILE = path.join(STATE_DIR, "update-state.json");

export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface UpdateStep {
  name: string;
  status: StepStatus;
  detail?: string;
  ms?: number;
}

export interface UpdateState {
  phase: "idle" | "running" | "reloading" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  triggeredBy: string | null;
  versionBefore: string | null;
  versionAfter: string | null;
  steps: UpdateStep[];
  /** Redacted, tail-limited command output. */
  log: string[];
  error: string | null;
}

const MAX_LOG_LINES = 400;

function emptyState(): UpdateState {
  return {
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    triggeredBy: null,
    versionBefore: null,
    versionAfter: null,
    steps: [],
    log: [],
    error: null,
  };
}

export function readState(): UpdateState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as UpdateState;
  } catch {
    return emptyState();
  }
}

function writeState(state: UpdateState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("[update] could not persist state:", err);
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  output: string;
}

/** Secrets that must never reach the log or the browser. */
let redactions: string[] = [];

function redact(s: string): string {
  let out = s;
  for (const secret of redactions) {
    if (secret.length >= 4) out = out.split(secret).join("«redacted»");
  }
  return out;
}

/**
 * Commands that are batch-file shims on Windows and therefore need a shell.
 *
 * `git` is deliberately NOT one of them: with `shell: true` Windows re-joins argv
 * into a command line, which splits any argument containing a space into two
 * tokens. That turned `-c credential.helper=store --file=X` into two separate git
 * options and made git print its usage message instead of fetching.
 */
const NEEDS_SHELL = new Set(["npm", "npx", "pm2", "yarn", "pnpm"]);

function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
      shell: process.platform === "win32" && NEEDS_SHELL.has(cmd),
    });

    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Bound memory on a runaway build.
      if (output.length > 512 * 1024) output = output.slice(-512 * 1024);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          output += `\n[timed out after ${opts.timeoutMs}ms]`;
        }, opts.timeoutMs)
      : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${err.message}` });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

// ---------------------------------------------------------------------------
// Git credentials
// ---------------------------------------------------------------------------

/**
 * Write a throwaway git credential store.
 *
 * The token goes in a 0600 temp file rather than into the remote URL or a `-c`
 * argument: a URL-embedded token gets written into .git/config, and a `-c` value
 * is visible in the process list to every user on the box. Only the file path
 * appears in argv.
 */
/**
 * The hostname of `origin`, for the credential entry.
 *
 * Falls back to nothing rather than guessing: a credential store keyed to the wrong host is
 * indistinguishable from a bad token, and "check the token" is the least helpful thing to say
 * when the token is fine.
 */
function remoteHostname(): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Git, with no credential of any kind.
 *
 * DigiShack fetches its own PUBLIC repository, which anyone can clone anonymously. There
 * used to be a `withCredentials()` beside this that wrote an operator-supplied token into
 * a temporary file and pointed git's credential store at it — and a backslash-escaping
 * bug in that config value made git resolve the path against the REPOSITORY ROOT and
 * write a live token, in a plaintext URL, into the working tree. Five of them reached
 * origin/main.
 *
 * The token settings are gone with it. A private fork that genuinely needs auth
 * configures a git credential helper on the server, where secrets belong, rather than
 * handing one to the application to look after.
 */
function gitEnv() {
  return {
    // Never prompt. Without this a private remote hangs the fetch forever on a terminal
    // that nobody is watching, which is indistinguishable from a slow network and times
    // out at 120 s with nothing useful to say.
    GIT_TERMINAL_PROMPT: "0",
  } as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export interface UpdateCheck {
  allowed: boolean;
  branch: string | null;
  localSha: string | null;
  remoteSha: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  dirtyFiles: string[];
  version: string;
  /** Subject lines of the commits that would be pulled in. */
  incoming: string[];
  error: string | null;
  /**
   * The host `origin` points at — `github.com` on a public install, the private forge on
   * the operator's own.
   *
   * Reported so the UI can stop naming a specific forge. The Git access panel said "Mint
   * one in Gitea under your avatar" to every reader of the PUBLIC build, which is both
   * wrong instructions for a GitHub checkout and a description of infrastructure the
   * public has no business knowing about.
   */
  remoteHost: string;
  /**
   * Did the fetch get through?
   *
   * The public mirror is a public repository: anyone can fetch it anonymously and no
   * token exists to be configured. The page nonetheless said "No git token configured"
   * and — much worse — gated the box that ENABLES updating on a token being present, so
   * on a public install the Update button could never appear at all. This is the fact
   * that replaces both guesses: the fetch either worked or it did not.
   */
  anonymousOk: boolean;
  /**
   * What each incoming version actually DOES, newest first.
   *
   * The page listed commit subjects, and on the public mirror those are
   * "DigiShack 1.129.0" — a version number twice over. So the one question an
   * operator has before pressing Update, "what changes if I do this", had no
   * answer anywhere.
   *
   * Read from the CHANGELOG the mirror now carries, which publish-public.ts
   * generates from the private repository's commit subjects — one line per
   * release, by the convention that a commit subject IS its changelog heading.
   */
  changes: { version: string; summary: string }[];
}

async function currentVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const allowed = await getBooleanSetting("update.allowFromUi", false);
  const version = await currentVersion();

  const base: UpdateCheck = {
    allowed,
    branch: null,
    localSha: null,
    remoteSha: null,
    behind: 0,
    ahead: 0,
    dirty: false,
    dirtyFiles: [],
    version,
    incoming: [],
    error: null,
    remoteHost: remoteHostname(),
    // Assumed false until a fetch actually succeeds with no token in hand.
    anonymousOk: false,
    changes: [],
  };

  const branchRes = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchRes.code !== 0) {
    return { ...base, error: "Not a git checkout — self-update is unavailable." };
  }
  const branch = branchRes.output.trim();

  const statusRes = await run("git", ["status", "--porcelain"]);
  // Untracked files ("??") do not block an update. The refusal exists to protect
  // EDITS to tracked files, which a fast-forward would carry along or a repair
  // would lose; an untracked file cannot be clobbered silently — git refuses the
  // merge itself if an incoming commit would overwrite one. Observed live: a
  // leftover scripts/_backlog.tmp.ts held up every update until someone shelled
  // into the container to delete it.
  const dirtyFiles = statusRes.output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("??"))
    .slice(0, 20);

  // NO TOKEN IS NOT AN ERROR ANY MORE.
  //
  // It was, and that made the public build unusable for its own audience: the public mirror
  // lives on GitHub, where a public repository can be fetched by anyone with no credential at
  // all. Demanding a Gitea token there asked for something that does not exist, to reach
  // something that needs nothing. Reported as "for the public repo I think we can remove Git
  // access ... because it just needs to check the public github".
  //
  // So an absent token means an ANONYMOUS fetch. If the remote turns out to be private, git
  // says so and that error is reported as it comes back, which is a better message than
  // refusing up front on a guess about whether a credential is required.

  try {
    const fetchRes = await run("git", ["fetch", "origin", branch], {
      env: gitEnv(),
      timeoutMs: 120_000,
    });
    if (fetchRes.code !== 0) {
      return {
        ...base,
        branch,
        dirty: dirtyFiles.length > 0,
        dirtyFiles,
        error: `git fetch failed: ${redact(fetchRes.output).trim().slice(-400)}`,
      };
    }
    // It got through. If we had no token, this repository does not need one — which is
    // the whole answer for a public install, and is measured rather than assumed from
    // the hostname.
    base.anonymousOk = true;

    const local = (await run("git", ["rev-parse", "HEAD"])).output.trim();
    const remote = (
      await run("git", ["rev-parse", `origin/${branch}`])
    ).output.trim();

    const counts = (
      await run("git", [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...origin/${branch}`,
      ])
    ).output.trim();
    const [aheadRaw, behindRaw] = counts.split(/\s+/);

    const incoming =
      local === remote
        ? []
        : (
            await run("git", [
              "log",
              "--oneline",
              "--no-decorate",
              `HEAD..origin/${branch}`,
            ])
          ).output
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 30);

    // What the incoming versions actually do.
    //
    // Read from the REMOTE changelog rather than the local one, because the point is to
    // describe versions this installation does not have yet. Lines look like
    //
    //     - **1.129.0** — Answer in this window, late, rather than the next one
    //
    // newest first, and the running version is the stopping point: everything above it is
    // what pressing Update would bring in.
    let changes: { version: string; summary: string }[] = [];
    if (local !== remote) {
      const clog = await run("git", ["show", `origin/${branch}:CHANGELOG.md`]);
      if (clog.code === 0) {
        for (const line of clog.output.split("\n")) {
          const m = /^-\s+\*\*(\d+\.\d+\.\d+)\*\*\s+[—-]\s+(.+?)\s*$/.exec(line);
          if (!m) continue;
          if (m[1] === version) break;
          changes.push({ version: m[1]!, summary: m[2]! });
          // A long-neglected install could be dozens behind; the page needs the recent
          // ones, not a scroll of history.
          if (changes.length >= 30) break;
        }
      }
    }

    return {
      ...base,
      branch,
      localSha: local.slice(0, 8),
      remoteSha: remote.slice(0, 8),
      ahead: Number(aheadRaw) || 0,
      behind: Number(behindRaw) || 0,
      dirty: dirtyFiles.length > 0,
      dirtyFiles,
      incoming,
      changes,
    };
  } finally {
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * How long a "running" state may persist before it is treated as abandoned.
 *
 * An update that has genuinely been going for longer than this has lost its
 * process — the build is the long step and it runs inside a web process capped at
 * 512 MB, so being OOM-killed mid-build is a realistic way to get here.
 */
const STALE_AFTER_MS = 30 * 60_000;

export function isRunning(): boolean {
  const s = readState();

  // "reloading" is NEVER running from the perspective of a reader.
  //
  // It is written immediately before PM2 replaces this process, with finishedAt
  // already set, so the only process that can ever READ it is the replacement.
  // Treating it as in-flight meant that after the very first successful update the
  // new process saw the persisted "reloading", isRunning() returned true, and every
  // later update 409'd with the button disabled — permanently, with no way out but
  // editing logs/update-state.json by hand.
  if (s.phase === "reloading") return false;

  if (s.phase !== "running") return false;

  // A "running" state whose process died leaves the same dead end. Age it out.
  const started = s.startedAt ? Date.parse(s.startedAt) : NaN;
  if (Number.isFinite(started) && Date.now() - started > STALE_AFTER_MS) return false;

  return true;
}

/**
 * Perform the update. Resolves once the work is done or has failed; the PM2
 * reload is spawned detached at the very end so this process being replaced does
 * not abort it.
 */
export async function performUpdate(triggeredBy: string): Promise<UpdateState> {
  const check = await checkForUpdate();

  const state: UpdateState = {
    ...emptyState(),
    phase: "running",
    startedAt: new Date().toISOString(),
    triggeredBy,
    versionBefore: check.version,
    steps: [],
    log: [],
  };

  const fail = (msg: string) => {
    state.phase = "failed";
    state.error = msg;
    state.finishedAt = new Date().toISOString();
    writeState(state);
    return state;
  };

  if (!check.allowed) {
    return fail("Updating from the UI is turned off (Settings → Software updates).");
  }
  if (check.error) return fail(check.error);
  if (check.dirty) {
    return fail(
      `The working tree has uncommitted changes (${check.dirtyFiles.length}). Refusing to update so local edits aren't clobbered.`,
    );
  }
  if (check.behind === 0) {
    state.phase = "done";
    state.versionAfter = check.version;
    state.steps = [
      { name: "Check for updates", status: "ok", detail: "Already up to date" },
    ];
    state.finishedAt = new Date().toISOString();
    writeState(state);
    return state;
  }

  // Same reasoning as the check above: a public remote needs no credential, so an absent
  // token means an anonymous fetch rather than a refusal.

  const step = async (
    name: string,
    cmd: string,
    args: string[],
    opts: {
      timeoutMs?: number;
      optional?: boolean;
      env?: Record<string, string>;
    } = {},
  ): Promise<boolean> => {
    const entry: UpdateStep = { name, status: "running" };
    state.steps.push(entry);
    writeState(state);

    const started = Date.now();
    const res = await run(cmd, args, {
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
    entry.ms = Date.now() - started;

    const lines = redact(res.output)
      .split("\n")
      .map((l) => l.replace(/\r/g, "").trimEnd())
      .filter(Boolean);
    state.log.push(`$ ${name}`, ...lines.slice(-60));
    if (state.log.length > MAX_LOG_LINES) {
      state.log = state.log.slice(-MAX_LOG_LINES);
    }

    if (res.code === 0) {
      entry.status = "ok";
      writeState(state);
      return true;
    }

    entry.status = opts.optional ? "skipped" : "failed";
    entry.detail = `exit ${res.code}`;
    writeState(state);
    return opts.optional === true;
  };

  try {
    const branch = check.branch ?? "main";

    // Re-fetch inside the run: checkForUpdate() may have been a while ago, and
    // the merge below must act on current refs.
    if (
      !(await step("git fetch", "git", ["fetch", "origin", branch], {
        env: gitEnv(),
        timeoutMs: 120_000,
      }))
    ) {
      return fail("git fetch failed — check the token and network.");
    }

    // --ff-only: never create a merge commit, never rewrite history, and fail
    // loudly if the branch has diverged rather than trying to reconcile it.
    // No credentials needed — this operates on refs already fetched locally.
    if (
      !(await step("git merge --ff-only", "git", [
        "merge",
        "--ff-only",
        `origin/${branch}`,
      ]))
    ) {
      return fail("Fast-forward merge failed — the local branch has diverged.");
    }

    if (
      !(await step("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], {
        timeoutMs: 15 * 60_000,
      }))
    ) {
      return fail("Dependency install failed. The app was NOT reloaded.");
    }

    // Back up BEFORE migrating.
    //
    // `migrate deploy` alters tables and there is no undo. A migration that half
    // applies, or one whose data transformation turns out wrong, leaves a log that
    // cannot be recovered from anything the update itself produced — and the
    // operator finds out after the update reports success.
    //
    // Deliberately not a `step()`: a failure here must abort rather than be recorded
    // and carried on from, and the bundle path is in-process rather than a command.
    {
      const started = Date.now();
      try {
        const { backupBundle } = await import("@/lib/db/bundle");
        const result = await backupBundle(false);
        state.steps.push({
          name: "Backup before migrating",
          status: "ok",
          detail: `${result.file} — ${(result.bytes / 1024 / 1024).toFixed(1)} MB, ${result.manifest.database.rows.toLocaleString()} rows (${Math.round((Date.now() - started) / 1000)}s)`,
        });
        writeState(state);
      } catch (err) {
        state.steps.push({
          name: "Backup before migrating",
          status: "failed",
          detail: err instanceof Error ? err.message : "Backup failed",
        });
        // Refusing to continue is the whole point. An update that cannot take a
        // backup is an update that must not touch the schema.
        return fail(
          "Could not back up before migrating, so the update stopped. Nothing was changed. " +
            "Fix the backup (see the Backup page) and try again.",
        );
      }
    }

    if (
      !(await step("prisma migrate deploy", "npx", ["prisma", "migrate", "deploy"], {
        timeoutMs: 10 * 60_000,
      }))
    ) {
      return fail(
        "Database migration failed. The app was NOT reloaded, and a backup taken just " +
          "beforehand is in backups/.",
      );
    }

    if (
      !(await step("npm run build", "npm", ["run", "build"], {
        timeoutMs: 20 * 60_000,
      }))
    ) {
      return fail("Build failed. The app was NOT reloaded.");
    }

    await step("npm run check", "npm", ["run", "check"], {
      timeoutMs: 10 * 60_000,
      // Advisory: a failing assertion suite is worth surfacing but shouldn't
      // block a reload of code that already built.
      optional: true,
    });

    state.versionAfter = await currentVersion();

    // Reload last, and detached: PM2 replaces this process, so anything after
    // this point would never run.
    //
    // Through npx, not bare `pm2`: on the Windows install PM2 lives in the npx
    // cache and is on nobody's PATH — bare `pm2` spawned ENOENT, the describe
    // "failed", and every update ended "restart manually to apply" on the one
    // machine that runs under PM2 around the clock. npx resolves a global PM2
    // instantly where one exists (the LXC), so this costs the Linux path nothing.
    const pm2 = await run("npx", ["pm2", "describe", "digishack-web"]);
    if (pm2.code === 0) {
      state.phase = "reloading";
      state.steps.push({
        name: "pm2 reload",
        status: "ok",
        detail: "Reload issued — this process is being replaced",
      });
      state.finishedAt = new Date().toISOString();
      writeState(state);

      const child = spawn("npx", ["pm2", "reload", "ecosystem.config.js", "--update-env"], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
      });
      child.unref();
      return state;
    }

    state.phase = "done";
    state.steps.push({
      name: "pm2 reload",
      status: "skipped",
      detail: "No PM2 process named digishack-web — restart manually to apply",
    });
    state.finishedAt = new Date().toISOString();
    writeState(state);
    return state;
  } finally {
  }
}

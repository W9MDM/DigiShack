/* eslint-disable no-console */
// The shell side of installing and updating.
//
// 1. scripts/update.sh counted UNTRACKED files as a dirty tree, so a LoTW certificate or a
//    received SSTV picture in data/ refused every update. lib/update/runner.ts has always
//    skipped "??" lines; the shell path now does too. Tested by running update.sh's own
//    lines against a scratch git repository, not by reading them.
// 2. scripts/healthcheck.sh says install.sh puts it in cron; install.sh never did. The block
//    that does is run here twice against a fake crontab, to prove it adds exactly one line
//    and keeps what was already there.
//
// Hermetic: a temp directory, a throwaway `git init`, and stand-ins for crontab, id and the
// binaries the health check needs. Nothing is installed and no real crontab is read.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

function bash(script: string, cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
if (probe.error || probe.stdout.trim() !== "ok") {
  console.log("  skip  check:install-scripts needs bash on PATH. Not a failure: nothing was checked.");
  process.exit(0);
}

const work = mkdtempSync(path.join(tmpdir(), "ds-install-scripts-"));
try {
  console.log("\nthe scripts parse");
  for (const f of ["scripts/install.sh", "scripts/update.sh", "scripts/healthcheck.sh", "deploy/proxmox/digishack-lxc.sh"]) {
    const r = spawnSync("bash", ["-n", path.join(ROOT, f)], { encoding: "utf8" });
    ok(r.status === 0, `bash -n ${f}`, r.stderr);
  }

  console.log("\nupdate.sh: what counts as a dirty tree");
  {
    // update.sh's own assignments, lifted out verbatim.
    const src = read("scripts/update.sh");
    const line = (name: string) => {
      const m = new RegExp(`^\\s*(${name}="\\$\\(.*\\)")\\s*$`, "m").exec(src);
      if (!m?.[1]) throw new Error(`update.sh has no ${name}= line`);
      return m[1];
    };
    const filter = [line("TRACKED_STATUS"), line("DIRTY"), line("NPM_DIRTY")].join("\n");
    const report = `${filter}\nprintf 'DIRTY<%s>\\nNPM<%s>\\n' "$DIRTY" "$NPM_DIRTY"`;

    const repo = path.join(work, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export {};\n");
    writeFileSync(path.join(repo, "package.json"), "{}\n");
    const init = bash(
      "git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init",
      repo,
    );
    ok(init.status === 0, "a scratch repository", init.stderr);

    const run = () => bash(report, repo).stdout;

    ok(run().includes("DIRTY<>"), "a clean tree is clean", run());

    mkdirSync(path.join(repo, "data", "lotw"), { recursive: true });
    writeFileSync(path.join(repo, "data", "lotw", "K9XYZ.p12"), "cert");
    writeFileSync(path.join(repo, "data", "sstv-1.png"), "png");
    writeFileSync(path.join(repo, "package-lock.json"), "{}\n"); // untracked, and npm-shaped
    let out = run();
    ok(out.includes("DIRTY<>"), "untracked files (a LoTW cert, an SSTV picture) do not block", out);
    ok(out.includes("NPM<>"), "and an untracked package-lock.json is not 'reclaimed' with git checkout", out);

    writeFileSync(path.join(repo, "package.json"), '{"x":1}\n');
    out = run();
    ok(out.includes("DIRTY<>"), "a rewritten package.json still does not block", out);
    ok(out.includes("NPM<package.json>"), "and is the one file reclaimed", out);

    writeFileSync(path.join(repo, "src", "app.ts"), "export const edited = 1;\n");
    out = run();
    ok(/DIRTY< M src\/app\.ts>/.test(out), "a modified source file still blocks", out);
  }

  console.log("\ninstall.sh: the health-check cron line");
  {
    const src = read("scripts/install.sh");
    const start = src.indexOf("# --- health check");
    const end = src.indexOf("# --- done");
    ok(start > 0 && end > start, "install.sh has a health-check section");
    const fakeBin = path.join(work, "bin");
    mkdirSync(fakeBin);
    for (const b of ["curl", "pm2", "logger", "flock"]) {
      writeFileSync(path.join(fakeBin, b), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(fakeBin, b), 0o755);
    }
    const cronFile = path.join(work, "crontab.txt").replace(/\\/g, "/");
    // The block as written, with its /usr/bin paths pointed at the stand-ins.
    const block = src.slice(start, end).replace(/\/usr\/bin\//g, `${fakeBin.replace(/\\/g, "/")}/`);
    const harness = (uid: number) => `
set -euo pipefail
ROOT="/opt/digi shack"
step() { :; }
ok()   { printf 'ok %s\\n' "$1"; }
warn() { printf 'warn %s\\n' "$1"; }
die()  { printf 'die %s\\n' "$1"; exit 1; }
id() { echo ${uid}; }
crontab() {
  if [ "$1" = "-l" ]; then [ -f "${cronFile}" ] && cat "${cronFile}" || return 1;
  elif [ "$1" = "-" ]; then cat > "${cronFile}";
  fi
}
${block}
`;
    writeFileSync(cronFile, "0 4 * * * /usr/local/bin/something-else\n");

    const first = bash(harness(0), work);
    ok(first.status === 0, "runs as root", first.stderr + first.stdout);
    ok(/scheduled every minute/.test(first.stdout), "and schedules it", first.stdout);
    let cron = readFileSync(cronFile, "utf8");
    ok(cron.includes("something-else"), "keeping the line that was already there", cron);
    ok(cron.includes('* * * * * "/opt/digi shack/scripts/healthcheck.sh"'), "adding the quoted line", cron);

    const second = bash(harness(0), work);
    ok(/already in root's crontab/.test(second.stdout), "a second run notices it", second.stdout);
    cron = readFileSync(cronFile, "utf8");
    ok((cron.match(/healthcheck\.sh/g) ?? []).length === 1, "and does not add it twice", cron);

    rmSync(cronFile);
    const fresh = bash(harness(0), work);
    cron = readFileSync(cronFile, "utf8");
    ok(fresh.status === 0 && cron === '* * * * * "/opt/digi shack/scripts/healthcheck.sh"\n', "an empty crontab gets exactly the one line", JSON.stringify(cron));

    rmSync(cronFile);
    const user = bash(harness(1000), work);
    ok(/warn not root/.test(user.stdout), "not root: says what to add instead", user.stdout);
    let wrote = true;
    try {
      readFileSync(cronFile);
    } catch {
      wrote = false;
    }
    ok(!wrote, "and touches no crontab");

    rmSync(path.join(fakeBin, "curl"));
    const noCurl = bash(harness(0), work);
    ok(/not scheduled — it needs:.*curl/.test(noCurl.stdout), "without curl it refuses rather than restart a healthy station", noCurl.stdout);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

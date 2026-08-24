/* eslint-disable no-console */
// How many people are actually taking this.
//
//   npm run downloads
//
// WHAT COUNTS AS A DOWNLOAD HERE. DigiShack ships as a repository you clone and build,
// not as a release asset, so there is nothing in `releases/*/assets` to add up — the
// download IS the clone. Release assets are still reported if any ever exist, because
// the day one is published this script should not have to be rewritten.
//
// TWO THINGS GITHUB DOES NOT EXPOSE, stated so the numbers are not read as more than
// they are:
//
//   * "Source code (zip/tar.gz)" downloads from the releases page. Not in the API at
//     all — not zero, unavailable.
//   * Any breakdown of WHO cloned. Uniques are counted per day by GitHub's own
//     reckoning and cannot be summed across days without double-counting a person who
//     came back on Tuesday.
//
// WHY THIS WRITES A FILE. The traffic API keeps FOURTEEN DAYS. A script that only reads
// it therefore reports a rolling fortnight and silently loses the rest, so every run
// merges what it fetched into `data/traffic-history.json` keyed by date. That file is
// gitignored — it is this station's accumulated record, not source, and it is the only
// copy of anything older than two weeks.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "K9XYZ/DigiShack";
const HISTORY = path.resolve("data", "traffic-history.json");

/**
 * The token, from the environment or from git's own credential store.
 *
 * `GH_TOKEN` first because that is the convention across these repos and what CI would
 * set. Falling back to the credential helper means the script works on the machine that
 * already pushes to this repo without asking anyone to set anything up — the credential
 * is necessarily a PAT, since GitHub stopped accepting passwords over HTTPS in 2021.
 */
function token(): string | null {
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length).trim() || null : null;
  } catch {
    return null;
  }
}

interface DayPoint {
  count: number;
  uniques: number;
}
interface History {
  repo: string;
  /** ISO date -> the figures GitHub reported for that day. */
  clones: Record<string, DayPoint>;
  views: Record<string, DayPoint>;
  /** Release asset id -> its download total at last check. */
  assets: Record<string, { name: string; tag: string; downloads: number }>;
  firstSeen: string;
  lastRun: string;
}

function loadHistory(): History {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY, "utf8")) as History;
    // Tolerate a file written by an older version rather than throwing it away.
    return {
      repo: h.repo ?? REPO,
      clones: h.clones ?? {},
      views: h.views ?? {},
      assets: h.assets ?? {},
      firstSeen: h.firstSeen ?? new Date().toISOString(),
      lastRun: h.lastRun ?? "",
    };
  } catch {
    return {
      repo: REPO,
      clones: {},
      views: {},
      assets: {},
      firstSeen: new Date().toISOString(),
      lastRun: "",
    };
  }
}

async function api<T>(url: string, tok: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "DigiShack traffic reporter",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`  ! ${url.replace("https://api.github.com/repos/", "")} -> HTTP ${res.status}`);
    return null;
  }
  return (await res.json()) as T;
}

const day = (ts: string): string => ts.slice(0, 10);
const sum = (d: Record<string, DayPoint>, k: "count" | "uniques"): number =>
  Object.values(d).reduce((a, p) => a + (p[k] ?? 0), 0);

async function main(): Promise<void> {
  const tok = token();
  if (!tok) {
    console.error(
      "No GitHub token. Set GH_TOKEN, or run this on a machine whose git credential\n" +
        "store already has a GitHub PAT (the one used to push).",
    );
    process.exit(1);
  }

  const base = `https://api.github.com/repos/${REPO}`;
  const history = loadHistory();

  // Traffic. Both endpoints need PUSH access to the repository — a read-only token
  // returns 403 here while working fine everywhere else, which is a confusing failure
  // worth naming rather than reporting as zero.
  const clones = await api<{ clones?: { timestamp: string; count: number; uniques: number }[] }>(
    `${base}/traffic/clones`,
    tok,
  );
  const views = await api<{ views?: { timestamp: string; count: number; uniques: number }[] }>(
    `${base}/traffic/views`,
    tok,
  );

  let newDays = 0;
  for (const p of clones?.clones ?? []) {
    const d = day(p.timestamp);
    if (!(d in history.clones)) newDays++;
    history.clones[d] = { count: p.count, uniques: p.uniques };
  }
  for (const p of views?.views ?? []) {
    history.views[day(p.timestamp)] = { count: p.count, uniques: p.uniques };
  }

  // Release assets, for the day there are any.
  const releases =
    (await api<{ tag_name: string; assets: { id: number; name: string; download_count: number }[] }[]>(
      `${base}/releases?per_page=100`,
      tok,
    )) ?? [];
  let assetTotal = 0;
  for (const r of releases) {
    for (const a of r.assets ?? []) {
      history.assets[String(a.id)] = {
        name: a.name,
        tag: r.tag_name,
        downloads: a.download_count,
      };
      assetTotal += a.download_count;
    }
  }

  history.lastRun = new Date().toISOString();
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2) + "\n");

  // ---- report ----
  const days = Object.keys(history.clones).sort();
  const recent = days.slice(-14);
  console.log(`\n${REPO}\n`);
  console.log(`  clones      ${sum(history.clones, "count")} total, ${sum(history.clones, "uniques")} unique-days`);
  console.log(`  views       ${sum(history.views, "count")} total, ${sum(history.views, "uniques")} unique-days`);
  console.log(`  releases    ${releases.length} (${assetTotal} asset downloads)`);
  console.log(`  history     ${days.length} day(s) recorded, since ${history.firstSeen.slice(0, 10)}`);

  if (recent.length) {
    console.log("\n  last 14 days");
    for (const d of recent) {
      const c = history.clones[d]!;
      const v = history.views[d] ?? { count: 0, uniques: 0 };
      const bar = "#".repeat(Math.min(30, c.count));
      console.log(
        `    ${d}  clones ${String(c.count).padStart(3)} (${String(c.uniques).padStart(2)}u)` +
          `  views ${String(v.count).padStart(4)}  ${bar}`,
      );
    }
  }

  console.log("\n  notes");
  if (newDays > 0) console.log(`    - ${newDays} day(s) newly recorded this run.`);
  console.log("    - GitHub keeps only 14 days of traffic; anything older lives only in");
  console.log(`      ${path.relative(process.cwd(), HISTORY)}. Run this at least fortnightly.`);
  console.log('    - "Source code (zip/tar.gz)" downloads are not exposed by the API at all.');
  console.log("    - Unique counts are per day and must not be summed as people.");
  if (releases.length === 0) {
    console.log("    - No releases exist, so the clone count IS the download count.");
  }
  console.log("");
}

void main();

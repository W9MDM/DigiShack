/* eslint-disable no-console */
// A page must never report the absence of a background job's output as a fact about the world.
// Run: npm run check:job-visibility
//
// THE FAULT CLASS. Found four times now, fixed one at a time, and it always looks the same:
//
//     A job runs ONLY inside the radio service, on a timer. A page reads what that job
//     stored. When the job has never run — service not started, setting off, credentials
//     missing — the page shows an empty list and phrases it as a finding about the air.
//
// That is the worst kind of wrong, because the false reading is the ACTIONABLE one. An
// operator went and looked at an antenna when the answer was a setting. The four instances:
//
//   * Uploads         — `sweeper()` in pages/api/uploads/index.ts. "Turned uploads on and the
//                       log still is not uploading", with nothing anywhere to explain why.
//   * PSKReporter     — `collectorState()` in pages/api/psk-spots.ts. "Nobody yet, in the last
//                       hour" was said for four different situations, only one of them
//                       propagation.
//   * eQSL inbox      — the worst: `syncEqslInbox` stored NO marker at all, so no page in the
//                       application mentioned the sync's existence, never mind its last run.
//   * Incomplete /    — pages asserting "an empty list means every exchange completed" and
//     grid map / QSL    "nobody in the last 15 minutes" with no evidence for either.
//
// WHAT THIS PINS, and why it is these two things:
//
//   1. THE ORDERING of the detail messages. Every one of these state functions is a chain of
//      prerequisites, and the message an operator needs is the FIRST missing link, not the
//      last one tested. Reporting "the radio service is not running" to somebody who never
//      entered an eQSL password sends them to the wrong place — which is the same failure the
//      whole check exists to prevent, one level down. The assertions below break several
//      links at once and require the earliest one to win.
//
//   2. THE INVARIANT: an empty detail is reserved for a job that CAN have run and HAS run.
//      Silence is the thing that caused all four bugs, so silence has to be earned. Every
//      combination of the inputs is enumerated rather than sampled — there are sixteen and
//      eight of them, and a table small enough to enumerate should never be spot-checked.
//
// The prose on the pages themselves is checked by reading the source, because it cannot be
// imported: React pages drag the whole component tree in, which is why check-gridmap.ts
// restates the projection instead of importing it. The specific sentences that were wrong are
// named, so re-introducing one fails here rather than in front of an operator.

import { readFileSync } from "node:fs";

import {
  describeEqslSync,
  eqslInboxDetail,
  getEqslLastSync,
  type EqslInboxCheck,
  type EqslSyncResult,
} from "@/lib/integrations/eqsl";
import { qslSenderDetail, type QslSenderCheck } from "@/pages/api/qsl/queue";

import { skipWithoutDatabase } from "./needs-db";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/**
 * The part of a page a browser actually shows, flattened.
 *
 * COMMENTS ARE REMOVED FIRST, and that is not tidiness. The house style is to quote the
 * sentence that was wrong in the comment explaining why it was wrong — this file does it
 * three times — so a check that searched the raw source would fail on the very documentation
 * of the fix. It did, on the first run.
 *
 * Whitespace is then collapsed because JSX reflows prose across lines at the formatter's
 * discretion, and a sentence split over three lines is the same sentence.
 */
function flat(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join(" ")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------

console.log("\n1. eQSL inbox — the message is the FIRST missing link");
{
  const healthy: EqslInboxCheck = {
    configured: true,
    autoSync: true,
    running: true,
    intervalMinutes: 60,
    lastSyncAt: "2026-08-27T09:00:00.000Z",
    port: 3101,
  };
  const broken: EqslInboxCheck = {
    ...healthy,
    configured: false,
    autoSync: false,
    running: false,
    lastSyncAt: null,
  };

  check("a healthy sync says nothing at all", eqslInboxDetail(healthy) === "", eqslInboxDetail(healthy));

  // Everything is wrong at once. Each step fixes exactly one link and the message must move
  // on to the next — a function that tested `running` first would pass none of these.
  check(
    "no credentials outranks everything else",
    eqslInboxDetail(broken) === eqslInboxDetail({ ...healthy, configured: false }),
    eqslInboxDetail(broken),
  );
  check(
    "with credentials, the switch is next",
    eqslInboxDetail({ ...broken, configured: true }) ===
      eqslInboxDetail({ ...healthy, autoSync: false }),
    eqslInboxDetail({ ...broken, configured: true }),
  );
  check(
    "with the switch on, a stopped radio service is next",
    eqslInboxDetail({ ...broken, configured: true, autoSync: true }) ===
      eqslInboxDetail({ ...healthy, running: false }),
    eqslInboxDetail({ ...broken, configured: true, autoSync: true }),
  );
  check(
    "and 'never run' is last, because it is the only one that fixes itself",
    eqslInboxDetail({ ...healthy, lastSyncAt: null }) !== "" &&
      eqslInboxDetail({ ...healthy, lastSyncAt: null }) !==
        eqslInboxDetail({ ...healthy, running: false }),
  );

  // The messages have to name the thing to go and change. A detail that says "something is
  // wrong" is the empty string with extra steps.
  check(
    "the credentials message points at Settings",
    /Settings/.test(eqslInboxDetail({ ...healthy, configured: false })),
  );
  check(
    "the switch message names the setting",
    /automatically/i.test(eqslInboxDetail({ ...healthy, autoSync: false })),
  );
  check(
    "the stopped-service message names the radio service AND the address tried",
    /radio service/.test(eqslInboxDetail({ ...healthy, running: false })) &&
      eqslInboxDetail({ ...healthy, running: false, port: 3199 }).includes("127.0.0.1:3199"),
    eqslInboxDetail({ ...healthy, running: false, port: 3199 }),
  );
  check(
    "the never-run message says how often it will try",
    eqslInboxDetail({ ...healthy, lastSyncAt: null, intervalMinutes: 45 }).includes("45 min"),
  );
}

console.log("\n2. eQSL inbox — silence is earned, over all sixteen states");
{
  const bools = [false, true];
  let states = 0;
  const wrong: EqslInboxCheck[] = [];
  for (const configured of bools) {
    for (const autoSync of bools) {
      for (const running of bools) {
        for (const hasRun of bools) {
          states++;
          const s: EqslInboxCheck = {
            configured,
            autoSync,
            running,
            intervalMinutes: 60,
            lastSyncAt: hasRun ? "2026-08-27T09:00:00.000Z" : null,
            port: 3101,
          };
          const healthy = configured && autoSync && running && hasRun;
          if ((eqslInboxDetail(s) === "") !== healthy) wrong.push(s);
        }
      }
    }
  }
  check("all sixteen states were exercised", states === 16, states);
  // THE INVARIANT. An empty message is a claim that the sync is working, and every one of
  // these bugs was an empty message made in a state where the job could not have run.
  check("empty detail if and only if configured, on, running and has run", wrong.length === 0, wrong);
}

console.log("\n3. QSL email sender — the message is the FIRST missing link");
{
  const healthy: QslSenderCheck = {
    enabled: true,
    autoApprove: true,
    running: true,
    intervalMinutes: 30,
    port: 3101,
  };
  const broken: QslSenderCheck = {
    ...healthy,
    enabled: false,
    autoApprove: false,
    running: false,
  };

  check("a sender that really sends says nothing", qslSenderDetail(healthy) === "", qslSenderDetail(healthy));
  check(
    "automatic emailing being off outranks everything",
    qslSenderDetail(broken) === qslSenderDetail({ ...healthy, enabled: false }),
    qslSenderDetail(broken),
  );
  check(
    "with it on, a stopped radio service is next",
    qslSenderDetail({ ...broken, enabled: true }) === qslSenderDetail({ ...healthy, running: false }),
    qslSenderDetail({ ...broken, enabled: true }),
  );
  check(
    "and 'queues but never approves' is last",
    qslSenderDetail({ ...broken, enabled: true, running: true }) ===
      qslSenderDetail({ ...healthy, autoApprove: false }),
    qslSenderDetail({ ...broken, enabled: true, running: true }),
  );

  // "Off" is the deliberate default for unsolicited mail. The message has to state it as a
  // fact about the configuration and NOT as a failure, or an operator learns to ignore it —
  // and then misses the one case that is a fault.
  const off = qslSenderDetail({ ...healthy, enabled: false });
  check("the 'off' message says what to press instead", /Send/.test(off), off);
  check("the 'off' message does not call itself a fault", /deliberate|not a fault/i.test(off), off);
  check(
    "the stopped-service message names the address tried",
    qslSenderDetail({ ...healthy, running: false, port: 3199 }).includes("127.0.0.1:3199"),
  );
  // The nastiest configuration of the three: the queue GROWS while nothing leaves it, which
  // is indistinguishable from a backlog of review unless the page says so.
  const queueOnly = qslSenderDetail({ ...healthy, autoApprove: false });
  check(
    "the queue-only message says it approves and sends nothing",
    /approves nothing and sends nothing/.test(queueOnly),
    queueOnly,
  );
}

console.log("\n4. QSL email sender — silence is earned, over all eight states");
{
  const bools = [false, true];
  let states = 0;
  const wrong: QslSenderCheck[] = [];
  for (const enabled of bools) {
    for (const autoApprove of bools) {
      for (const running of bools) {
        states++;
        const s: QslSenderCheck = { enabled, autoApprove, running, intervalMinutes: 30, port: 3101 };
        // `runAutoQsl` returns before `sendApprovedQsls` unless all three hold. Two out of
        // three sends exactly as much mail as none of them.
        if ((qslSenderDetail(s) === "") !== (enabled && autoApprove && running)) wrong.push(s);
      }
    }
  }
  check("all eight states were exercised", states === 8, states);
  check("empty detail if and only if something will actually send", wrong.length === 0, wrong);
}

console.log("\n5. the pages no longer state findings they cannot support");
{
  // The exact sentences that were wrong, named so that re-introducing one fails here. Each
  // was a claim about the air made unconditionally by a page whose data comes from a process
  // that may never have started.
  const incomplete = flat("pages/incomplete.tsx");
  check(
    "incomplete.tsx no longer says an empty list means every exchange completed",
    !/so an empty list means every exchange/.test(incomplete),
  );
  check(
    "incomplete.tsx asks whether the radio service is answering",
    incomplete.includes("/api/bridge/status"),
  );
  check(
    "incomplete.tsx looks up when one was last recorded",
    incomplete.includes("/api/incomplete?all=1") && incomplete.includes("lastRecordedAt"),
  );
  check(
    "incomplete.tsx distinguishes 'not asked yet' from 'not running'",
    /bridge === null/.test(incomplete),
  );

  const gridmap = flat("pages/gridmap.tsx");
  check(
    "gridmap.tsx no longer says 'Nobody in the last 15 minutes' unconditionally",
    !/Nobody in the last 15 minutes\. CQs appear here/.test(gridmap),
  );
  check(
    "gridmap.tsx says so when the socket is not connected",
    /Not connected to the radio service/.test(gridmap),
  );
  check(
    "gridmap.tsx separates 'nothing decoded at all' from 'no CQs'",
    /not just no CQs/.test(gridmap),
  );

  const qsl = flat("pages/qsl.tsx");
  check("qsl.tsx reads the sender state", /data\?\.sender/.test(qsl));
  check(
    "qsl.tsx warns when approved messages have nothing to send them",
    /Nothing will send these on its own/.test(qsl),
  );

  const integrations = flat("pages/integrations.tsx");
  check(
    "integrations.tsx prints the eQSL last run the way it prints LoTW's",
    /eqsl\.lastSyncAt \? formatUtc\(eqsl\.lastSyncAt\) : "never"/.test(integrations),
  );
}

console.log("\n6. the eQSL marker is written by the sync itself, on every path");
{
  const eqsl = readFileSync("lib/integrations/eqsl.ts", "utf8");
  check("there is a marker key at all", eqsl.includes('"eqsl.lastSyncAt"'));
  // Recorded in lib/integrations/eqsl.ts and NOT in services/radio/index.ts. A marker written
  // by the caller is a marker the next caller forgets, which is precisely how a sync wired to
  // one timer ended up recording nothing at either end.
  check(
    "syncEqslInbox records a successful run",
    /if \(!opts\.dryRun\) await recordEqslSync\(describeEqslSync\(result\)\)/.test(eqsl),
  );
  // A marker that only advances on the happy path leaves a station whose sync throws every
  // hour looking exactly like one where nothing is scheduled — the original bug, one level in.
  check(
    "syncEqslInbox records a run that threw, then rethrows",
    /catch \(err\) \{[\s\S]*recordEqslSync\(`failed:[\s\S]*throw err;/.test(eqsl),
  );
  // A dry run answers a question; it does not change when the integration last did its job.
  // Same rule as syncLotwConfirmations.
  check(
    "a dry run does not move the marker",
    (eqsl.match(/if \(!opts\.dryRun\)/g) ?? []).length === 2,
  );

  const bridge = readFileSync("services/radio/index.ts", "utf8");
  check(
    "the tick does not record it — the sync does",
    !/recordEqslSync|eqsl\.lastSyncAt/.test(bridge),
  );

  // The line the marker stores IS the line the card prints, so a failure must never read as
  // a success there. "0 confirmations in the inbox" beside a red timestamp would be the same
  // bug in miniature: a true statement that answers a question nobody asked.
  const base: EqslSyncResult = {
    ok: true,
    found: 0,
    matched: 0,
    unmatched: 0,
    alreadyKnown: 0,
    unmatchedSamples: [],
  };
  check(
    "a failed sync is described as failed",
    describeEqslSync({ ...base, ok: false, error: "eQSL returned HTTP 503" }).startsWith("failed:"),
  );
  check(
    "a failure with no detail still says it failed",
    describeEqslSync({ ...base, ok: false }) === "failed: no detail",
  );
  check("an empty inbox is not a failure", describeEqslSync(base) === "0 confirmations in the inbox");
  check(
    "unmatched confirmations are counted, not called errors",
    describeEqslSync({ ...base, found: 9427, matched: 12, alreadyKnown: 7616, unmatched: 1799 }) ===
      "9427 confirmations: 12 newly confirmed, 7616 already known, 1799 not in this log",
    describeEqslSync({ ...base, found: 9427, matched: 12, alreadyKnown: 7616, unmatched: 1799 }),
  );
}

// ---------------------------------------------------------------------------
// The one part that needs a real database: the marker has to be READABLE, not just written.
// Everything above is pure and runs anywhere. Skipping this section is not a pass — see
// scripts/needs-db.ts for why a skip says so out loud rather than exiting quietly.

async function live(): Promise<void> {
  if (await skipWithoutDatabase("check:job-visibility (live marker)")) return;
  console.log("\n7. the stored marker reads back");
  const last = await getEqslLastSync();
  check(
    "getEqslLastSync returns a shape the page can render",
    (last.at === null || typeof last.at === "string") &&
      (last.result === null || typeof last.result === "string"),
    last,
  );
  // Null is a legitimate answer and IS the diagnosis — "never" is what the card prints.
  console.log(`  note last eQSL inbox sync: ${last.at ?? "never"}`);
}

void live().then(() => {
  console.log(
    failed === 0
      ? "\nAll job-visibility checks passed.\n"
      : `\n${failed} JOB-VISIBILITY CHECK(S) FAILED.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
});

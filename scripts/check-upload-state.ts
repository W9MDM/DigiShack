// Checks for the remote-log matcher behind upload tracking.
// Run: npm run check:upload-state
//
// The matcher decides which local QSOs a downloaded remote log accounts for, and
// therefore which of them get flagged as uploaded. Two properties matter more
// than anything else here:
//
//   * The ±30 minute window. Minute-exact matching rejected 52 % of a real 2,391
//     row eQSL inbox — including contacts demonstrably in the log — because a
//     remote record carries the OTHER operator's clock.
//   * Claim-once. Two remote records must never collapse onto one local QSO. If
//     they do, the log looks more uploaded than it is, and the QSOs that were
//     silently skipped never get sent.
//
// `matchLists` is the real function from lib/integrations/upload-state.ts, not a
// copy. check-dxcc.ts spent a long time asserting a rule that only its own local
// reimplementation followed, so tests here call production code.

import { MATCH_WINDOW_MS, matchLists, type RemoteQso } from "../lib/integrations/upload-state";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const T0 = new Date("2026-03-01T12:00:00Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

interface Local {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
}
const local = (id: string, callsign: string, band: string, mode: string, min: number): Local => ({
  id,
  callsign,
  band,
  mode,
  startTime: at(min),
});
const remote = (callsign: string, band: string, mode: string, min: number): RemoteQso => ({
  callsign,
  band,
  mode,
  startTime: at(min),
});

console.log("1. the time window");
{
  const L = [local("a", "SP1ABC", "20M", "FT8", 0)];
  check("exact time matches", matchLists([remote("SP1ABC", "20M", "FT8", 0)], L).matchedIds[0] === "a");
  check("+29 minutes matches", matchLists([remote("SP1ABC", "20M", "FT8", 29)], L).matchedIds[0] === "a");
  check("-29 minutes matches", matchLists([remote("SP1ABC", "20M", "FT8", -29)], L).matchedIds[0] === "a");
  check("+31 minutes does NOT match", matchLists([remote("SP1ABC", "20M", "FT8", 31)], L).matchedIds.length === 0);
  check("the window is 30 minutes", MATCH_WINDOW_MS === 30 * 60_000, MATCH_WINDOW_MS);
}

console.log("");
console.log("2. callsign and band must agree");
{
  const L = [local("a", "SP1ABC", "20M", "FT8", 0)];
  check("a different callsign does not match", matchLists([remote("SP9XYZ", "20M", "FT8", 0)], L).matchedIds.length === 0);
  check("a different band does not match", matchLists([remote("SP1ABC", "40M", "FT8", 0)], L).matchedIds.length === 0);
  check("case is ignored", matchLists([remote("sp1abc", "20m", "ft8", 0)], L).matchedIds[0] === "a");
  // A mode mismatch is TOLERATED. SSB/USB and MFSK/FT4 disagreements are routine
  // in third-party logs and are not a reason to refuse an otherwise good match.
  check("a mode mismatch still matches", matchLists([remote("SP1ABC", "20M", "SSB", 0)], L).matchedIds[0] === "a");
}

console.log("");
console.log("3. nearest in time wins, same mode preferred");
{
  const L = [
    local("early", "K1ABC", "20M", "FT8", 0),
    local("late", "K1ABC", "20M", "FT8", 20),
  ];
  check("picks the nearer of two candidates", matchLists([remote("K1ABC", "20M", "FT8", 18)], L).matchedIds[0] === "late");
  check("and the other way round", matchLists([remote("K1ABC", "20M", "FT8", 2)], L).matchedIds[0] === "early");

  // A same-mode match 25 minutes away beats a wrong-mode match 1 minute away:
  // the mode penalty is a full window, so it can never lose to time alone.
  const M = [
    local("wrongmode", "K1ABC", "20M", "SSB", 1),
    local("rightmode", "K1ABC", "20M", "FT8", 25),
  ];
  check(
    "same mode outranks a much closer wrong-mode QSO",
    matchLists([remote("K1ABC", "20M", "FT8", 0)], M).matchedIds[0] === "rightmode",
    matchLists([remote("K1ABC", "20M", "FT8", 0)], M),
  );
}

console.log("");
console.log("4. claim-once");
{
  // THE important one. Two remote records, one local QSO: the second must not
  // reuse the first's match, or the log reports more uploaded than it is and the
  // skipped QSOs are never sent.
  const L = [local("only", "DL1ABC", "20M", "FT8", 0)];
  const r = matchLists([remote("DL1ABC", "20M", "FT8", 0), remote("DL1ABC", "20M", "FT8", 5)], L);
  check("two remote records cannot claim one local QSO", r.matchedIds.length === 1, r);
  check("the loser is reported unmatched, not dropped", r.unmatched.length === 1, r.unmatched);

  // Two locals, two remotes — both should match, one each.
  const L2 = [
    local("a", "DL1ABC", "20M", "FT8", 0),
    local("b", "DL1ABC", "20M", "FT8", 5),
  ];
  const r2 = matchLists([remote("DL1ABC", "20M", "FT8", 0), remote("DL1ABC", "20M", "FT8", 5)], L2);
  check("two locals absorb two remotes", r2.matchedIds.length === 2, r2);
  check("and they are distinct", new Set(r2.matchedIds).size === 2, r2.matchedIds);
}

console.log("");
console.log("5. unmatched reporting");
{
  const L = [local("a", "SP1ABC", "20M", "FT8", 0)];
  const r = matchLists(
    [remote("SP1ABC", "20M", "FT8", 0), remote("VK3XYZ", "15M", "FT4", 0)],
    L,
  );
  check("matched and unmatched both reported", r.matchedIds.length === 1 && r.unmatched.length === 1, r);
  check("the unmatched record is the right one", r.unmatched[0]?.callsign === "VK3XYZ", r.unmatched);
  check("an empty remote log matches nothing", matchLists([], L).matchedIds.length === 0);
  check("an empty local log matches nothing", matchLists([remote("SP1ABC", "20M", "FT8", 0)], []).matchedIds.length === 0);
  check(
    "every remote record is accounted for exactly once",
    (() => {
      const rr = matchLists(
        [remote("SP1ABC", "20M", "FT8", 0), remote("SP1ABC", "20M", "FT8", 1), remote("X", "20M", "FT8", 0)],
        L,
      );
      return rr.matchedIds.length + rr.unmatched.length === 3;
    })(),
  );
}

console.log(
  failures === 0
    ? "\nAll upload-state checks passed.\n"
    : `\n${failures} UPLOAD-STATE CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

/* eslint-disable no-console */
// Checks that the auto-log dedup key recognises the same contact twice.
// Run: npm run check:log-dedup
//
// THE REPORT, from another operator's station on 20 m FT4 — three log entries per callsign:
//
//     14:07Z  KM4RL   20M  FT4  14.081616  --      -04 / +05
//     14:06Z  KM4RL   20M  FT4  14.081616  --      -14 / +06
//     14:06Z  KM4RL   20M  FT4  14.080717  EL88    -08 / +07
//     14:04Z  KB1EJQ  20M  FT4  14.081616  --      -03 / -12
//     14:04Z  KB1EJQ  20M  FT4  14.081616  --      -12 / -14
//     14:03Z  KB1EJQ  20M  FT4  14.081955  FN43    -08 / -13
//
// Two DIFFERENT stations sharing 14.081616 was the thread to pull: two stations cannot
// share an audio offset, so that is not their frequency, it is ours — which meant the
// duplicate rows came from the path that logs `msg.txFrequency`, the external-decoder
// logger, and not from the native controller.
//
// That logger has a 60-second memory. It could not have been working:
//
//     const key = `${msg.dxCall}|${band}|${msg.mode}`;   // raw, off the wire
//     callsign: msg.dxCall.toUpperCase(),                // stored
//     mode: normaliseMode(msg.mode),                     // stored
//
// WSJT-X reports FT4 as MFSK. The same contact announced once as MFSK and once as FT4 made
// two keys, collided with neither, and wrote two rows that read identically in the log.
//
// The window was never the problem. The guard was watching for a collision that could not
// happen — the same fault as the frequency guard in 1.164.0 and the deploy check in
// 1.170.4, three times in one week: a guard keyed on a value that is not the value it is
// guarding.

import { logDedupKey, normaliseCallsign, normaliseMode } from "../lib/radio/log-dedup";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

console.log("the mode the log records");
{
  eq(normaliseMode("MFSK"), "FT4", "MFSK is FT4 — what WSJT-X calls it is not what the log says");
  eq(normaliseMode("mfsk"), "FT4", "and lower case too");
  eq(normaliseMode("  MFSK  "), "FT4", "and padded");
  eq(normaliseMode("FT8"), "FT8", "FT8 is itself");
  eq(normaliseMode("ft4"), "FT4", "so is a lower-case FT4");
  eq(normaliseMode(""), "FT8", "an empty mode falls back rather than storing nothing");
  eq(normaliseMode("   "), "FT8", "so does whitespace");
  eq(normaliseMode("SUPERLONGMODENAME"), "SUPERLONGMODEN".slice(0, 12), "a long mode is cut to the column width");
}

console.log("\nTHE BUG: two spellings of one contact must collide");
{
  // This is the whole report. Each pair below is ONE contact, announced twice, and every
  // pair produced two different keys before the fix — so both rows were written.
  const pairs: [string, string, string, string][] = [
    ["KB1EJQ", "MFSK", "KB1EJQ", "FT4"],
    ["KB1EJQ", "mfsk", "KB1EJQ", "MFSK"],
    ["KM4RL", "FT4", "km4rl", "FT4"],
    ["KM4RL", " FT4", "KM4RL", "FT4"],
    ["kb1ejq", "mfsk", "KB1EJQ", "FT4"],
  ];
  for (const [c1, m1, c2, m2] of pairs) {
    const a = logDedupKey(c1, "20M", m1);
    const b = logDedupKey(c2, "20M", m2);
    ok(a === b, `${c1}/${m1} and ${c2}/${m2} are the same contact`, `${a} vs ${b}`);
  }
  // The exact pair from the report.
  eq(
    logDedupKey("KM4RL", "20M", "MFSK"),
    logDedupKey("KM4RL", "20M", "FT4"),
    "THE REPORT: MFSK and FT4 for KM4RL on 20M are one key",
  );
}

console.log("\nand genuinely different contacts must NOT collide");
{
  // The other half of being right. A key that collides too eagerly silently DROPS real
  // contacts out of the log, which is worse than a duplicate because nothing shows it
  // happened.
  const base = logDedupKey("KB1EJQ", "20M", "FT4");
  ok(base !== logDedupKey("KM4RL", "20M", "FT4"), "a different callsign is a different key");
  ok(base !== logDedupKey("KB1EJQ", "40M", "FT4"), "a different band is a different key");
  ok(base !== logDedupKey("KB1EJQ", "20M", "FT8"), "a different mode is a different key");
  ok(base !== logDedupKey("KB1EJQ", "20M", "FT2"), "FT2 is not FT4");
  ok(base !== logDedupKey("KB1EJQ", "20M", "CW"), "nor is CW");
  // FT8 and FT4 on the same band are separate contacts and both belong in the log.
  ok(
    logDedupKey("KM4RL", "20M", "FT8") !== logDedupKey("KM4RL", "20M", "MFSK"),
    "the same station worked on FT8 and on FT4 is two contacts",
  );
}

console.log("\nthe key is made of exactly what the row stores");
{
  // The invariant that keeps this fixed. If a future edit normalises the callsign or the
  // mode differently on the way to the database, the key stops protecting the row and the
  // duplicates come back with no test failing — unless that test is this one.
  for (const raw of ["kb1ejq", " KB1EJQ ", "Kb1EjQ"]) {
    const key = logDedupKey(raw, "20m", "mfsk");
    const storedCall = normaliseCallsign(raw);
    const storedMode = normaliseMode("mfsk");
    eq(key, `${storedCall}|20M|${storedMode}`, `the key for "${raw}" is built from the stored values`);
  }
  eq(normaliseCallsign(" kb1ejq "), "KB1EJQ", "the callsign is trimmed and upper-cased, as stored");
  // The band is normalised too, because `freqToBand` has returned both spellings over time.
  eq(logDedupKey("KB1EJQ", "20m", "FT4"), logDedupKey("KB1EJQ", "20M", "FT4"), "band case does not split the key");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all log-dedup assertions passed");

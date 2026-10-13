/* eslint-disable no-console */
// Assertions on FT8 Battle Royale scoring.
// Run: npm run check:ft8battle
//
// WHY THESE MATTER MORE THAN MOST. This scores a screen the operator makes decisions from
// inside a fifteen-second window. A wrong multiplier does not look wrong — it looks like a
// number, and it sends the station after the wrong callsign all afternoon. There is no
// feedback loop that would reveal it.
//
// THE ANCHOR IS THEIR OWN WORKED EXAMPLE, quoted from ft8battle.com/rules.php:
//
//     "You work a POTA station on 10m FT4 during Happy Hour for the first time today.
//      Base (1) + POTA Bonus (2) + First Contact (4) = 7 points
//      x 1.5 (10m band) x 2.0 (FT4/FT2 mode) = 21 points
//      x 2 (Happy Hour) = 42 points!"
//
// If this file agrees with that, the order of operations is right. Reproducing their
// arithmetic is the only external check available — there is no API to compare against.

import {
  BASE_POINTS,
  FIRST_CONTACT_BONUS,
  HAPPY_HOURS_UTC,
  POTA_BONUS,
  isHappyHour,
  rankByPoints,
  scoreContact,
} from "../lib/contest/ft8battle";

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

const HAPPY = new Date("2026-10-13T17:30:00Z");
const PLAIN = new Date("2026-10-13T12:30:00Z");

// ---------------------------------------------------------------------------
console.log("their published worked example, reproduced exactly");
// ---------------------------------------------------------------------------
{
  const s = scoreContact({ band: "10M", mode: "FT4", at: HAPPY, pota: true });
  eq(s.max, 42, "POTA + first contact, 10m FT4, Happy Hour = 42 points");
  // And the intermediate they also publish: without First Contact it is (1+2) x 6 = 18.
  eq(s.min, 18, "the same contact without the First Contact bonus is 18");
  eq(s.multiplier, 6, "the combined multiplier is 1.5 x 2 x 2 = 6");
}

// ---------------------------------------------------------------------------
console.log("the bonuses are summed BEFORE the multipliers, not after");
// ---------------------------------------------------------------------------
{
  // THE MISTAKE THIS CATCHES. Applying multipliers to the base and adding the bonuses flat
  // gives 1x6 + 2 + 4 = 12 for the example above, not 42 — and would rank a plain 20 m
  // contact above a first contact on 10 m FT4. Nothing on screen would look wrong.
  const s = scoreContact({ band: "10M", mode: "FT4", at: HAPPY, pota: true });
  const ifMultipliedSeparately = BASE_POINTS * 6 + POTA_BONUS + FIRST_CONTACT_BONUS;
  ok(s.max !== ifMultipliedSeparately, "the flat-bonus reading (12) is NOT what is produced", {
    correct: s.max,
    wrong: ifMultipliedSeparately,
  });
  eq(s.max, (BASE_POINTS + POTA_BONUS + FIRST_CONTACT_BONUS) * 6, "bonuses are inside the multiplier");
}

// ---------------------------------------------------------------------------
console.log("each multiplier, on its own");
// ---------------------------------------------------------------------------
eq(scoreContact({ band: "20M", mode: "FT8", at: PLAIN }).min, 1, "a plain 20m FT8 contact is 1 point");
eq(scoreContact({ band: "10M", mode: "FT8", at: PLAIN }).min, 2, "10m alone is x1.5, rounded to 2");
eq(scoreContact({ band: "6M", mode: "FT8", at: PLAIN }).min, 2, "6m is the other x1.5 band");
eq(scoreContact({ band: "20M", mode: "FT4", at: PLAIN }).min, 2, "FT4 alone is x2");
eq(scoreContact({ band: "20M", mode: "FT2", at: PLAIN }).min, 2, "FT2 is the other x2 mode");
eq(scoreContact({ band: "20M", mode: "FT8", at: HAPPY }).min, 2, "Happy Hour alone is x2");
// FT8 IS THE BASELINE, not a bonus. A x2 here would inflate every contact on the station's
// main mode and make the whole ranking meaningless.
eq(scoreContact({ band: "20M", mode: "FT8", at: PLAIN }).multiplier, 1, "FT8 carries no multiplier");
// Bands NOT on the bonus list must not get one — 40m is where most contacts happen.
eq(scoreContact({ band: "40M", mode: "FT8", at: PLAIN }).multiplier, 1, "40m carries no multiplier");
eq(scoreContact({ band: "17M", mode: "FT8", at: PLAIN }).multiplier, 1, "nor does 17m");

// Case must not decide the score. The band arrives as "10m" from some paths and "10M" from
// others, and a case-sensitive lookup would silently drop the multiplier on one of them.
eq(
  scoreContact({ band: "10m", mode: "ft4", at: PLAIN }).multiplier,
  3,
  "lower-case band and mode score identically",
);

// ---------------------------------------------------------------------------
console.log("Happy Hour is the clock and nothing else");
// ---------------------------------------------------------------------------
ok(isHappyHour(new Date("2026-10-13T07:00:00Z")), "07:00 UTC is Happy Hour");
ok(isHappyHour(new Date("2026-10-13T07:59:59Z")), "and 07:59:59 still is");
ok(!isHappyHour(new Date("2026-10-13T08:00:00Z")), "08:00 is not");
ok(isHappyHour(new Date("2026-10-13T17:00:00Z")), "17:00 UTC is the other one");
ok(!isHappyHour(new Date("2026-10-13T16:59:59Z")), "16:59:59 is not");
eq(HAPPY_HOURS_UTC.length, 2, "there are two scheduled Happy Hours");
// UTC, NOT LOCAL. This station is on CDT; reading local hours would put Happy Hour five
// hours off and have the operator chasing doubles at the wrong time of day.
ok(
  !isHappyHour(new Date("2026-10-13T12:00:00Z")),
  "noon UTC is not Happy Hour, even though it is 07:00 local on this station",
);

// ---------------------------------------------------------------------------
console.log("the duplicate penalty, which is the one that costs real points");
// ---------------------------------------------------------------------------
{
  const dup = scoreContact({ band: "20M", mode: "FT8", at: PLAIN, alreadyWorkedToday: true });
  eq(dup.penalty, -2, "a plain duplicate costs 2x what it would have earned");
  eq(dup.min, 0, "and earns nothing");
  eq(dup.max, 0, "including the first-contact ceiling");
  ok(dup.reasons.includes("DUPLICATE"), "and says so first", dup.reasons);

  // THE PENALTY SCALES WITH THE MULTIPLIERS, which is what makes it dangerous: a careless
  // re-work of a 10 m FT4 station during Happy Hour costs 36 points, not 2.
  const expensive = scoreContact({
    band: "10M", mode: "FT4", at: HAPPY, pota: true, alreadyWorkedToday: true,
  });
  eq(expensive.penalty, -36, "a duplicate on 10m FT4 in Happy Hour costs 36");
  ok(
    Math.abs(expensive.penalty) > Math.abs(dup.penalty),
    "so the expensive bands are the expensive mistakes",
  );

  // Scored against the floor, not the ceiling: a station already worked today cannot also
  // be a first contact, so First Contact must not inflate the penalty.
  const plain = scoreContact({ band: "10M", mode: "FT4", at: HAPPY, pota: true });
  eq(expensive.penalty, -2 * plain.min, "the penalty is twice the FLOOR, not twice the ceiling");
}

// ---------------------------------------------------------------------------
console.log("the ranking puts the best first and the dangerous last");
// ---------------------------------------------------------------------------
{
  const rows = [
    { call: "DUPE", band: "10M", mode: "FT4", worked: true },
    { call: "PLAIN", band: "20M", mode: "FT8", worked: false },
    { call: "TEN", band: "10M", mode: "FT8", worked: false },
    { call: "BEST", band: "10M", mode: "FT4", worked: false },
  ];
  const ranked = rankByPoints(rows, (r) =>
    scoreContact({ band: r.band, mode: r.mode, at: HAPPY, alreadyWorkedToday: r.worked }),
  );
  eq(ranked[0]!.item.call, "BEST", "the highest-scoring contact is first");
  eq(ranked[ranked.length - 1]!.item.call, "DUPE", "and the duplicate is last");
  // VISIBLE, NOT HIDDEN. An operator should be able to see that a station is on the band and
  // understand why it is not worth calling — dropping it would look like a decode failure.
  eq(ranked.length, rows.length, "nothing is dropped from the list");
  ok(
    ranked.every((r, i) => i === 0 || r.score.min <= ranked[i - 1]!.score.min || r.score.penalty < 0),
    "the order is non-increasing by known points",
  );
}

// ---------------------------------------------------------------------------
console.log("the unknown half is reported as a range, not invented");
// ---------------------------------------------------------------------------
{
  // First Contact and steal value both depend on what OTHER players have done today, which
  // this station cannot see. A scorer that guessed would rank the screen by a number with
  // nothing behind it, so the answer is a bound.
  const s = scoreContact({ band: "20M", mode: "FT8", at: PLAIN });
  ok(s.max > s.min, "an un-worked station reports a range", s);
  eq(s.max - s.min, FIRST_CONTACT_BONUS, "and the spread is exactly the First Contact bonus");
  // On a multiplied band the spread multiplies too, which is the point of showing it.
  const t = scoreContact({ band: "10M", mode: "FT4", at: HAPPY });
  eq(t.max - t.min, FIRST_CONTACT_BONUS * 6, "the spread scales with the multiplier");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all ft8battle assertions passed");

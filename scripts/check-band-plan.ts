/* eslint-disable no-console */
// The US HF band plan the panadapter shades.
//
// Tested harder than most things here because it is the one part of the display an
// operator might act on in a way that is not merely wrong but ILLEGAL. Every assertion
// below is a specific edge from FCC Part 97.301/97.305 rather than a self-consistency
// check — a table can be perfectly consistent and still put the General phone edge in the
// wrong place, and internal consistency would never notice.

import {
  isChannelised,
  permitted,
  segmentAt,
  segmentLabel,
  segmentsIn,
  US_BAND_PLAN,
} from "@/lib/ham/band-plan";

let failures = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

console.log("the table is well formed");
{
  let overlaps = 0;
  let inverted = 0;
  for (let i = 0; i < US_BAND_PLAN.length; i++) {
    const s = US_BAND_PLAN[i]!;
    if (s.endHz <= s.startHz) inverted++;
    for (let j = i + 1; j < US_BAND_PLAN.length; j++) {
      const t = US_BAND_PLAN[j]!;
      if (s.startHz < t.endHz && t.startHz < s.endHz) overlaps++;
    }
  }
  eq("no segment runs backwards", inverted, 0);
  // Overlapping segments would make segmentAt's answer depend on table order, which is
  // how a display ends up confidently naming the wrong privilege.
  eq("no two segments overlap", overlaps, 0);
  ok(
    "segments are in ascending order",
    US_BAND_PLAN.every((s, i) => i === 0 || s.startHz >= US_BAND_PLAN[i - 1]!.endHz),
  );
  ok("every segment names at least one class", US_BAND_PLAN.every((s) => s.classes.length > 0));
}

console.log("\n40 m, the band this was reported on");
{
  eq("7.000 is Extra-only CW", segmentLabel(segmentAt(7_000_000)!), "CW Extra");
  eq("7.030 is the data segment, open to Tech", segmentLabel(segmentAt(7_030_000)!), "Data Novice");
  eq("7.150 is phone but not for a General", segmentLabel(segmentAt(7_150_000)!), "Phone Advanced");
  eq("7.200 is General phone", segmentLabel(segmentAt(7_200_000)!), "Phone General");
  // The edge that matters most on this band, and the one an operator gets wrong.
  ok("a General may talk on 7.175", permitted(segmentAt(7_175_000), "G", "PHONE"));
  ok("but not on 7.174", !permitted(segmentAt(7_174_000), "G", "PHONE"));
  ok("an Extra may talk on 7.125", permitted(segmentAt(7_125_000), "E", "PHONE"));
  ok("nobody may talk on 7.100 — it is a data segment", !permitted(segmentAt(7_100_000), "E", "PHONE"));
  // Technician HF: CW yes, FT8 no, in the same segment.
  ok("a Tech may send CW on 7.030", permitted(segmentAt(7_030_000), "T", "CW"));
  ok("but not data on 7.030", !permitted(segmentAt(7_030_000), "T", "DATA"));
  ok("a General may send data there", permitted(segmentAt(7_030_000), "G", "DATA"));
  ok("no Tech privileges at 7.200", !permitted(segmentAt(7_200_000), "T", "PHONE"));
}

console.log("\n20 m");
{
  eq("14.070 is the data segment", segmentLabel(segmentAt(14_074_000)!), "Data General");
  ok("a General may run FT8 on 14.074", permitted(segmentAt(14_074_000), "G", "DATA"));
  // 20 m has no Novice or Technician privileges at all — a common misconception.
  ok("a Tech has nothing on 14.074", !permitted(segmentAt(14_074_000), "T", "DATA"));
  ok("nor on 14.250", !permitted(segmentAt(14_250_000), "T", "PHONE"));
  ok("a General may talk on 14.225", permitted(segmentAt(14_225_000), "G", "PHONE"));
  ok("but not on 14.224", !permitted(segmentAt(14_224_000), "G", "PHONE"));
  ok("an Advanced may talk on 14.175", permitted(segmentAt(14_175_000), "A", "PHONE"));
  ok("and an Extra 25 kHz lower still", permitted(segmentAt(14_150_000), "E", "PHONE"));
}

console.log("\n80 m and the bands with no phone at all");
{
  ok("a General may talk on 3.800", permitted(segmentAt(3_800_000), "G", "PHONE"));
  ok("but not on 3.799", !permitted(segmentAt(3_799_000), "G", "PHONE"));
  ok("an Advanced may, at 3.700", permitted(segmentAt(3_700_000), "A", "PHONE"));
  // 30 m: CW and data only, for everyone, forever.
  eq("30 m is a data segment", segmentAt(10_136_000)!.mode, "DATA");
  ok("no phone on 30 m even for an Extra", !permitted(segmentAt(10_136_000), "E", "PHONE"));
  ok("but data is fine", permitted(segmentAt(10_136_000), "E", "DATA"));
}

console.log("\n10 m, where a Technician gets phone");
{
  ok("a Tech may talk on 28.400", permitted(segmentAt(28_400_000), "T", "PHONE"));
  ok("but not on 28.600", !permitted(segmentAt(28_600_000), "T", "PHONE"));
  ok("a General may, on 28.600", permitted(segmentAt(28_600_000), "G", "PHONE"));
  // 10 m is the ONE HF band where a Technician has data as well as CW, and the first
  // version of this table got it wrong by pattern-matching the other three CW-only
  // segments. That would have told a Technician they may not run FT8 on 28.074 — very
  // likely the first HF digital contact they would ever make.
  ok("a Tech may send data on 28.100", permitted(segmentAt(28_100_000), "T", "DATA"));
  ok("and FT8 on 28.074", permitted(segmentAt(28_074_000), "T", "DATA"));
  // While the same licence on 40 m is CW-only in the equivalent segment.
  ok("but not data on 7.074", !permitted(segmentAt(7_074_000), "T", "DATA"));
  ok("nor on 21.074", !permitted(segmentAt(21_074_000), "T", "DATA"));
  ok("nor on 3.574", !permitted(segmentAt(3_574_000), "T", "DATA"));
}

console.log("\noutside the allocations, and 60 m");
{
  eq("a broadcast frequency is in no segment", segmentAt(9_500_000), null);
  eq("nor is the gap above 40 m", segmentAt(7_400_000), null);
  ok("nothing is permitted where there is no segment", !permitted(null, "E", "PHONE"));
  // 60 m is channels, not a range. Drawing it as a segment would say the whole span is
  // available, which is the one error this strip must not make.
  ok("60 m is flagged as channelised", isChannelised(5_332_000));
  eq("and has no continuous segment", segmentAt(5_332_000), null);
  ok("40 m is not channelised", !isChannelised(7_200_000));
}

console.log("\nclipping to a display window");
{
  // A 20 kHz window sitting entirely inside one segment must still paint full width.
  const inside = segmentsIn(7_200_000, 7_220_000);
  eq("a window inside one segment yields one", inside.length, 1);
  eq("  clipped to the window's start", inside[0]!.startHz, 7_200_000);
  eq("  and its end", inside[0]!.endHz, 7_220_000);

  // A window straddling the General phone edge yields both sides.
  const straddle = segmentsIn(7_170_000, 7_180_000);
  eq("a window across the 7.175 edge yields two", straddle.length, 2);
  eq("  the first ends at the edge", straddle[0]!.endHz, 7_175_000);
  eq("  and the second starts there", straddle[1]!.startHz, 7_175_000);

  // A whole-band view keeps every segment.
  eq("the whole of 40 m has four segments", segmentsIn(7_000_000, 7_300_000).length, 4);
  // Outside everything.
  eq("a window in no allocation is empty", segmentsIn(9_400_000, 9_600_000).length, 0);
  // Touching edges must not double-count: a segment ending exactly at lowHz is out.
  eq(
    "a segment ending exactly at the window start is excluded",
    segmentsIn(7_175_000, 7_300_000).length,
    1,
  );
}

console.log(
  failures === 0 ? "\nok — band plan" : `\n${failures} FAILED — band plan`,
);
process.exit(failures === 0 ? 0 : 1);

/* eslint-disable no-console */
// The calculators and references on the Tools page, against KNOWN answers.
//
// Every figure here was worked out independently of the code under test: the textbook
// identities (468/f, SWR 1.5 is |Γ| 0.2, 100 W is 50 dBm, S9 is 50 µV into 50 Ω), the
// published locator of W1AW (FN31pr), and great-circle paths computed with a vector method
// (cross and dot products on unit vectors) that shares no formula with the haversine
// grid.ts uses. A check that recomputed the answer the same way would agree with any bug.

import { isGrid4 as pack77IsGrid4 } from "@/lib/digital/pack77";
import { permitted, segmentAt } from "@/lib/ham/band-plan";
import {
  GRID4_ANY_CASE_RE,
  GRID4_OR_6_ANY_CASE_RE,
  GRID4_OR_6_RE,
  GRID4_PREFIX_RE,
  GRID4_RE,
  GRID_LOCATOR_RE,
  gridSquare,
  isGrid4,
} from "@/lib/ham/grid-geometry";
import * as geometry from "@/lib/ham/grid-geometry";
import * as toolsGrid from "@/lib/ham/tools/grid";
import { escapeHtml } from "@/lib/html";
import * as geodesy from "@/lib/maps/geodesy";
import * as propagation from "@/lib/propagation";
import { gridCentre } from "@/lib/maps/projection";
import { bearingDeg, distanceKm, gridToLatLon } from "@/lib/propagation";
import {
  antennaLengths,
  classicDipoleFt,
  classicLoopFt,
  DEFAULT_END_EFFECT,
  parseEndEffect,
  RULE_468_FACTOR,
} from "@/lib/ham/tools/antenna";
import { lineLengths, parseVelocityFactor, VF_PRESETS } from "@/lib/ham/tools/feedline";
import {
  antipode,
  compassPoint,
  greatCircle,
  kmToMiles,
  latLonToGrid,
  parseGrid,
  parseLatitude,
  parseLongitude,
} from "@/lib/ham/tools/grid";
import { feetInches, fmt, formatVolts, formatWatts, METRES_PER_FOOT, parseNumber } from "@/lib/ham/tools/number";
import {
  applyChain,
  dbmToMicrovolts,
  dbmToSLabel,
  levelFromWatts,
  microvoltsToDbm,
  parsePower,
  parseSReading,
  S9_DBM,
  sReadingToDbm,
} from "@/lib/ham/tools/power";
import {
  bandChart,
  classFromSetting,
  lookupFrequency,
  powerLimit,
  verdict,
} from "@/lib/ham/tools/privileges";
import { filterReference, REFERENCE_GROUPS } from "@/lib/ham/tools/reference";
import { mismatchFromPower, parseSwr } from "@/lib/ham/tools/swr";
import { dayOfYear, isValidZone, utcNow, zoneTime } from "@/lib/ham/tools/time";
import { bandForMHz, bandLabel, parseWave, wavelengthM } from "@/lib/ham/tools/wave";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(actual: number, expected: number, tol: number, label: string): void {
  ok(Math.abs(actual - expected) <= tol, label, `expected ${expected} ±${tol}, got ${actual}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  ok(Object.is(actual, expected), label, `expected ${String(expected)}, got ${String(actual)}`);
}

const M_TO_FT = 1 / METRES_PER_FOOT;

console.log("\nantenna lengths");
{
  near(classicDipoleFt(14.2), 32.958, 0.001, "468/f at 14.200 MHz is 32.96 ft");
  const a = antennaLengths(14.2, DEFAULT_END_EFFECT);
  near(a.wavelengthM, 21.1121, 0.0001, "free-space λ at 14.200 MHz is 21.112 m");
  near(a.dipoleTotalM * M_TO_FT, 32.901, 0.001, "λ/2 × 0.95 is 32.90 ft");
  near(a.dipoleLegM * 2, a.dipoleTotalM, 1e-9, "each leg is half the dipole");
  // 0.95 against 468/f's 0.9516: they must stay within 0.2 % or one of them is wrong.
  ok(Math.abs(a.dipoleTotalM * M_TO_FT - classicDipoleFt(14.2)) / classicDipoleFt(14.2) < 0.002, "and within 0.2 % of 468/f");
  near(RULE_468_FACTOR, 0.9516, 0.0001, "468/f is an end-effect factor of 0.9516");
  const at468 = antennaLengths(14.2, RULE_468_FACTOR);
  near(at468.dipoleTotalM * M_TO_FT, 32.958, 0.001, "and with that factor the two agree exactly");
  near(antennaLengths(7.1, 0.95).quarterRadiatorM, 10.028, 0.001, "λ/4 vertical at 7.1 MHz is 10.03 m");
  near(classicLoopFt(14.2), 70.775, 0.001, "1005/f loop at 14.2 MHz is 70.77 ft");
  near(a.loopSquareSideM * 4, a.loopPerimeterM, 1e-9, "a square loop's four sides make the perimeter");
  near(a.fiveEighthsM, 21.1121 * 0.625 * 0.95, 0.0001, "5/8 λ × 0.95");
  ok(!parseEndEffect("1.2").ok && !parseEndEffect("").ok && !parseEndEffect("abc").ok, "a factor outside 0.8–1 is refused");
  eq(feetInches(32.901), "32′ 10.8″", "feet and inches");
  eq(feetInches(11.999), "12′ 0.0″", "inches that round to 12 carry into the feet");
}

console.log("\nfeedline");
{
  const l = lineLengths(14.2, 0.66);
  near(l.quarterM, 3.4835, 0.0001, "electrical λ/4 at 14.2 MHz, VF 0.66, is 3.48 m");
  near(l.quarterM * M_TO_FT, 11.429, 0.001, "or 11.43 ft");
  near(l.halfM, 6.967, 0.001, "and λ/2 is 6.97 m");
  ok(VF_PRESETS.every((p) => p.label.includes("typical")), "every preset says it is typical");
  ok(VF_PRESETS.some((p) => p.vf === 0.66) && VF_PRESETS.some((p) => p.vf === 0.85), "solid PE 0.66 and LMR-400 0.85 are there");
  ok(!parseVelocityFactor("0").ok && !parseVelocityFactor("1.1").ok && parseVelocityFactor("1").ok, "VF must be above 0 and at most 1");
}

console.log("\npower and dB");
{
  const p = levelFromWatts(100);
  near(p.dbm, 50, 1e-9, "100 W is 50.0 dBm");
  near(p.dbw, 20, 1e-9, "and 20.0 dBW");
  const mw = parsePower("0", "dBm");
  ok(mw.ok && Math.abs(mw.value.watts - 0.001) < 1e-12, "0 dBm is 1 mW");
  const dbw = parsePower("30", "dBW");
  ok(dbw.ok && Math.abs(dbw.value.watts - 1000) < 1e-6, "30 dBW is 1 kW");
  ok(!parsePower("0", "W").ok, "0 W is refused rather than printed as -Infinity dBm");
  ok(!parsePower("-5", "W").ok, "and so is negative power");
  const chain = applyChain(levelFromWatts(100), [{ label: "coax", db: -3 }, { label: "antenna", db: 6 }]);
  near(chain.totalDb, 3, 1e-9, "a chain sums its decibels");
  near(chain.out.watts, 199.53, 0.01, "100 W through -3 then +6 dB is 199.5 W");
  eq(formatWatts(100), "100 W", "100 W reads as 100 W");
  eq(formatWatts(1500), "1,500 W", "1500 W reads in watts, not kW");
  eq(formatWatts(5.0119e-11), "50.1 pW", "-73 dBm reads as 50.1 pW");
}

console.log("\nS-meter (IARU R.1, 50 Ω)");
{
  near(dbmToMicrovolts(S9_DBM.hf), 50.1, 0.05, "HF S9, -73 dBm, is 50 µV");
  near(dbmToMicrovolts(S9_DBM.vhf), 5.01, 0.01, "VHF S9, -93 dBm, is 5 µV");
  near(microvoltsToDbm(1), -107, 0.02, "1 µV is -107 dBm");
  eq(formatVolts(dbmToMicrovolts(-73) * 1e-6), "50.1 µV", "and reads as 50.1 µV");
  const s8 = parseSReading("S8");
  ok(s8.ok && sReadingToDbm(s8.value, "hf") === -79, "S8 on HF is -79 dBm: six dB a unit");
  const over = parseSReading("s9 + 20 dB");
  ok(over.ok && sReadingToDbm(over.value, "hf") === -53, "S9+20 on HF is -53 dBm");
  eq(dbmToSLabel(-79, "hf"), "S8", "-79 dBm reads S8");
  eq(dbmToSLabel(-53, "hf"), "S9+20", "-53 dBm reads S9+20");
  eq(dbmToSLabel(-93, "vhf"), "S9", "-93 dBm is S9 above 30 MHz");
  eq(dbmToSLabel(-130, "hf"), "below S1", "-130 dBm is below S1");
  ok(!parseSReading("S7+10").ok, "only S9 takes a figure over");
  ok(!parseSReading("S0").ok && !parseSReading("S10").ok, "S-units run 1 to 9");
}

console.log("\nSWR and mismatch");
{
  const m = parseSwr("1.5");
  ok(m.ok, "1.5 parses");
  if (m.ok) {
    near(m.value.gamma, 0.2, 1e-12, "SWR 1.5 is |Γ| 0.200");
    near(m.value.returnLossDb ?? 0, 13.979, 0.001, "return loss 13.98 dB");
    near(m.value.mismatchLossDb, 0.1773, 0.0001, "mismatch loss 0.177 dB");
    near(m.value.reflectedPct, 4, 1e-9, "4.0 % reflected");
  }
  ok(parseSwr("1.5:1").ok, "1.5:1 is accepted");
  const perfect = parseSwr("1");
  ok(perfect.ok && perfect.value.returnLossDb === null && perfect.value.mismatchLossDb === 0, "a perfect match has no return-loss figure to print, and no loss");
  const three = parseSwr("3");
  ok(three.ok && Math.abs(three.value.mismatchLossDb - 1.249) < 0.001, "SWR 3 costs 1.25 dB");
  ok(!parseSwr("0.9").ok && !parseSwr("").ok && !parseSwr("x").ok, "below 1, empty and junk are refused");
  const pw = mismatchFromPower(100, 4);
  ok(pw.ok && Math.abs(pw.value.swr - 1.5) < 1e-9 && pw.value.deliveredW === 96, "100 W forward, 4 W reflected is SWR 1.5 and 96 W delivered");
  ok(!mismatchFromPower(100, 100).ok, "reflected equal to forward is a message, not Infinity");
  ok(!mismatchFromPower(100, 120).ok, "reflected over forward is refused");
  ok(!mismatchFromPower(0, 0).ok, "no forward power is refused");
}

console.log("\nwavelength and frequency");
{
  near(wavelengthM(14.2), 21.1121, 0.0001, "14.2 MHz is 21.11 m");
  const two = parseWave("2", "m");
  ok(two.ok && Math.abs(two.value.mhz - 149.896) < 0.001, "2 m is 149.9 MHz");
  const khz = parseWave("7074", "kHz");
  ok(khz.ok && Math.abs(khz.value.mhz - 7.074) < 1e-9, "7074 kHz is 7.074 MHz");
  eq(bandForMHz(14.074), "20 m", "14.074 is in 20 m");
  eq(bandForMHz(146.52), "2 m", "146.52 is in 2 m");
  eq(bandForMHz(9.5), null, "9.5 MHz is in no band");
  eq(bandLabel("70CM"), "70 cm", "ADIF 70CM reads 70 cm");
  eq(bandLabel("2190M"), "2200 m", "and ADIF 2190M is the 2200 m band");
  ok(!parseWave("0", "MHz").ok && !parseWave("-1", "m").ok, "zero and negatives are refused");
  ok(!parseNumber("1,5", { label: "Frequency" }).ok, "a comma is refused rather than guessed at");
}

console.log("\nMaidenhead");
{
  const w1aw = { lat: 41.714775, lon: -72.72726 };
  eq(latLonToGrid(w1aw, 4), "FN31", "W1AW is FN31");
  eq(latLonToGrid(w1aw, 6), "FN31pr", "and FN31pr, as published");
  eq(latLonToGrid(w1aw, 8), "FN31pr21", "and FN31pr21 to eight characters");
  eq(latLonToGrid({ lat: 90, lon: 180 }, 8), "RR99xx99", "the north pole on the antimeridian is the last square, not off the grid");
  eq(latLonToGrid({ lat: -90, lon: -180 }, 8), "AA00aa00", "and the south pole the first");
  const g = parseGrid("em48sq45");
  ok(g.ok && g.value.grid === "EM48sq45" && g.value.chars === 8, "lower case is accepted and normalised");
  if (g.ok) {
    near(g.value.centre.lat, 38.689583, 1e-6, "EM48sq45 centre latitude");
    near(g.value.centre.lon, -90.4625, 1e-6, "EM48sq45 centre longitude");
    eq(latLonToGrid(g.value.centre, 8), "EM48sq45", "its centre maps back to itself");
  }
  for (const bad of ["", "EN6", "EN61j", "ZZ99", "EN6A", "EM48sz", "EM48sq4x", "EM48sqXX99"]) {
    ok(!parseGrid(bad).ok, `"${bad}" is refused with a reason`);
  }
  // Agreement with the existing decoder the log and the maps use.
  for (const grid of ["EN61", "IO91", "QF56", "EM48sq", "FN31pr", "PM95vr"]) {
    const mine = parseGrid(grid);
    const theirs = gridToLatLon(grid);
    ok(
      mine.ok && theirs !== null && Math.abs(mine.value.centre.lat - theirs.lat) < 1e-9 && Math.abs(mine.value.centre.lon - theirs.lon) < 1e-9,
      `${grid} decodes the same as lib/propagation`,
    );
  }
  const lat = parseLatitude("41.71 N");
  const lon = parseLongitude("72.73W");
  ok(lat.ok && lat.value === 41.71 && lon.ok && lon.value === -72.73, "hemisphere letters are read");
  ok(!parseLatitude("91").ok && !parseLongitude("181").ok && !parseLatitude("41 E").ok && !parseLatitude("-41 S").ok, "out of range, wrong hemisphere and doubled signs are refused");
}

console.log("\ngreat-circle paths (vector-method answers)");
{
  const pairs: [string, string, number, number, number][] = [
    // from, to, short-path km, short-path bearing, long-path km
    ["EM48sq", "IO91wm", 6770.552, 45.413, 33259.622],
    ["FN31pr", "PM95vr", 10788.483, 333.93, 29241.691],
    ["EN61", "QF56", 14918.069, 260.324, 25112.105],
    ["EM48sq45", "JN58td", 7684.895, 44.294, 32345.279],
  ];
  for (const [a, b, km, brg, lp] of pairs) {
    const pa = parseGrid(a);
    const pb = parseGrid(b);
    if (!pa.ok || !pb.ok) {
      ok(false, `${a} and ${b} parse`);
      continue;
    }
    const p = greatCircle(pa.value.centre, pb.value.centre);
    near(p.km, km, 0.01, `${a} to ${b} is ${km} km`);
    near(p.bearing ?? -1, brg, 0.01, `  heading ${brg}°`);
    near(p.longKm, lp, 0.01, `  long path ${lp} km`);
    near(p.longBearing ?? -1, (brg + 180) % 360, 0.01, "  long path is the reciprocal heading");
    // And lib/propagation, which the log's distance column uses, must agree.
    near(distanceKm(pa.value.centre, pb.value.centre), p.km, 1e-6, "  lib/propagation agrees on distance");
    near(bearingDeg(pa.value.centre, pb.value.centre), p.bearing ?? -1, 1e-6, "  and on bearing");
  }
  near(kmToMiles(6362.64), 3953.56, 0.01, "6362.64 km is 3953.56 mi");
  const same = greatCircle({ lat: 41, lon: -87 }, { lat: 41, lon: -87 });
  ok(same.km === 0 && same.bearing === null, "the same point has no bearing rather than a fake 0°");
  const anti = antipode({ lat: 38.6875, lon: -90.458333 });
  near(anti.lat, -38.6875, 1e-9, "antipode latitude");
  near(anti.lon, 89.541667, 1e-6, "antipode longitude");
  eq(latLonToGrid(anti, 6), "NF41sh", "EM48sq's antipode is NF41sh");
  const across = greatCircle({ lat: 38.6875, lon: -90.458333 }, anti);
  ok(across.antipodal && across.bearing === null, "to the antipode every heading works, so none is claimed");
  near(greatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }).km, 10007.543, 0.001, "a quarter of the equator is 10,007.5 km");
  eq(compassPoint(47.657), "NE", "47.7° is NE");
  eq(compassPoint(354), "N", "354° is N");
}

// The copies that lib/ham/grid-geometry replaced, frozen here exactly as they were, so the
// consolidation can be shown to change nothing. Unlike the answers above these are not
// independent: they are the old code, and the point is that the new code agrees with it.
const before = {
  /** lib/ham/grid-geometry gridToLatLon, as of 1.256. */
  gridToLatLon(grid: string): { lat: number; lon: number } | null {
    const g = grid.trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?/.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 - 180;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90;
    lon += Number(g[2]) * 2;
    lat += Number(g[3]) * 1;
    if (g.length >= 6) {
      lon += (g.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;
      lat += (g.charCodeAt(5) - 65) * (1 / 24) + 0.5 / 24;
    } else {
      lon += 1;
      lat += 0.5;
    }
    return { lat, lon };
  },
  /** lib/ham/tools/grid parseGrid's arithmetic, given an already-valid uppercase locator. */
  square(u: string): { centre: { lat: number; lon: number }; south: number; north: number; west: number; east: number } {
    let west = (u.charCodeAt(0) - 65) * 20 - 180 + (u.charCodeAt(2) - 48) * 2;
    let south = (u.charCodeAt(1) - 65) * 10 - 90 + (u.charCodeAt(3) - 48);
    let w = 2;
    let h = 1;
    if (u.length >= 6) {
      w = 2 / 24;
      h = 1 / 24;
      west += (u.charCodeAt(4) - 65) * w;
      south += (u.charCodeAt(5) - 65) * h;
    }
    if (u.length === 8) {
      w = 2 / 240;
      h = 1 / 240;
      west += (u.charCodeAt(6) - 48) * w;
      south += (u.charCodeAt(7) - 48) * h;
    }
    return { centre: { lat: south + h / 2, lon: west + w / 2 }, south, north: south + h, west, east: west + w };
  },
  /** lib/ham/tools/grid greatCircle's own haversine, before it used distanceKm. */
  km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const r = (d: number) => (d * Math.PI) / 180;
    const h = Math.sin((r(b.lat) - r(a.lat)) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  },
  /** lib/maps/projection gridCentre, before it used gridToLatLon. */
  projectionCentre(grid: string): { lat: number; lon: number } | null {
    const g = grid.trim().toUpperCase();
    if (!/^[A-R]{2}\d{2}$/.test(g) || g === "RR73") return null;
    return {
      lat: (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) * 1 + 0.5,
      lon: (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2 + 1,
    };
  },
  /** lib/qsl/card esc and lib/qsl/email escapeHtml (identical). */
  escapeSequential(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  },
  /** pages/api/qsl/unsubscribe page() esc. */
  escapeOnePass(t: string): string {
    return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  },
};

const sameLatLon = (a: { lat: number; lon: number } | null, b: { lat: number; lon: number } | null): boolean =>
  a === null || b === null ? a === b : Object.is(a.lat, b.lat) && Object.is(a.lon, b.lon);

console.log("\none copy of the grid maths: the new code agrees with the copies it replaced");
{
  const good = [
    "EN61", "EM48sq", "FN31pr", "JJ00aa", "RR99xx", "AA00aa", "IO91", "QF56", "PM95vr",
    "FN31pr21", "EM48sq45", "RR99xx99", "AA00aa00", "RR73", "AR09", "RA90",
  ];
  const lower = ["en61", "em48SQ", "fn31pr", "jj00AA", "rr99xx", " FN31 ", "em48sq45"];
  const bad = ["", "EN", "EN6", "EN61j", "SN52", "ZZ99", "1234", "FN31pr2", "FN31 pr", "EM48sz", "EM48sqXX99", "EN61zz", "EN61ZZ", "FN31 extra"];
  const table = [...good, ...lower, ...bad];

  let agree = 0;
  for (const g of table) {
    if (sameLatLon(gridToLatLon(g), before.gridToLatLon(g))) agree++;
    else ok(false, `gridToLatLon("${g}") is unchanged`);
  }
  eq(agree, table.length, `gridToLatLon is bit-identical on all ${table.length} table entries`);
  eq(gridToLatLon("en61")?.lat, gridToLatLon("EN61")?.lat, "lower case reads the same as upper");
  // The lenient reader's quirk is kept, not fixed in passing: it does not range-check the
  // subsquare, so EN61ZZ lands outside EN61. Nothing that validates first can reach it.
  ok((gridToLatLon("EN61ZZ")?.lon ?? 0) > -86, "gridToLatLon still reads EN61ZZ past its square's east edge (kept)");

  for (const g of table) {
    const p = parseGrid(g);
    const sq = gridSquare(g);
    ok(p.ok === (sq !== null), `parseGrid and gridSquare agree on whether "${g}" is a locator`);
    if (!p.ok || !sq) continue;
    const o = before.square(g.trim().toUpperCase());
    ok(
      sameLatLon(p.value.centre, o.centre) && Object.is(p.value.south, o.south) && Object.is(p.value.north, o.north) &&
        Object.is(p.value.west, o.west) && Object.is(p.value.east, o.east),
      `  "${g}": centre and edges bit-identical to the old parseGrid`,
    );
    // Centre vs centre: the two readers agree for 4 and 6 characters. For 8, gridToLatLon
    // gives the centre of the 6-character subsquare on purpose; the Tools page gives the 8's.
    const loose = gridToLatLon(g)!;
    const want = p.value.chars === 8 ? gridSquare(g.trim().slice(0, 6))!.centre : p.value.centre;
    ok(Math.abs(loose.lat - want.lat) < 1e-9 && Math.abs(loose.lon - want.lon) < 1e-9, `  "${g}": gridToLatLon gives the ${p.value.chars === 8 ? "6-character subsquare's" : "same"} centre`);
  }
  ok(!parseGrid("EN61ßx").ok, "a locator that changes length when uppercased is refused, not read as 7 characters");

  let worst = 0;
  let bearingsSame = true;
  for (const a of good) {
    for (const b of good) {
      const pa = gridToLatLon(a)!;
      const pb = gridToLatLon(b)!;
      const gc = greatCircle(pa, pb);
      worst = Math.max(worst, Math.abs(gc.km - before.km(pa, pb)));
      ok(Object.is(gc.km, distanceKm(pa, pb)), `${a} to ${b}: greatCircle and distanceKm are one sum`);
      const pp = geodesy.paths(pa, pb);
      if (gc.bearing !== null && !Object.is(gc.bearing, pp.short.bearing)) bearingsSame = false;
      if (gc.bearing !== null && !Object.is(gc.bearing, bearingDeg(pa, pb))) bearingsSame = false;
      if (!Object.is(pp.short.km, gc.km) || Math.abs(pp.long.km - gc.longKm) > 1e-9) bearingsSame = false;
    }
  }
  ok(worst < 1e-9, "greatCircle's distance moved by less than a micrometre", `worst ${worst} km`);
  ok(bearingsSame, "greatCircle, paths and bearingDeg give one bearing and one long path");
  near(distanceKm(gridToLatLon("FN31pr")!, gridToLatLon("PM95vr")!), 10788.483, 0.01, "FN31pr to PM95vr is still 10,788.5 km");
  near(bearingDeg(gridToLatLon("FN31pr")!, gridToLatLon("PM95vr")!), 333.93, 0.01, "  heading 333.9°");

  let centres = 0;
  const L = "ABCDEFGHIJKLMNOPQR";
  for (const f1 of L) {
    for (const f2 of L) {
      for (let n = 0; n < 100; n++) {
        const g = `${f1}${f2}${String(n).padStart(2, "0")}`;
        if (sameLatLon(gridCentre(g), before.projectionCentre(g)) && sameLatLon(gridCentre(g.toLowerCase()), before.projectionCentre(g))) centres++;
      }
    }
  }
  eq(centres, 32_400, "the grid map's square centres are bit-identical for all 32,400 squares");
  eq(gridCentre("RR73"), null, "and RR73 is still never a dot on the map");

  // The re-exports are the same function objects, not lookalikes: a future edit that
  // restates one of them in place breaks this, before it can drift from the others.
  ok(
    propagation.gridToLatLon === geometry.gridToLatLon &&
      propagation.bearingDeg === geometry.bearingDeg &&
      propagation.distanceKm === geometry.distanceKm &&
      geodesy.gridToLatLon === geometry.gridToLatLon &&
      geodesy.bearingDeg === geometry.bearingDeg &&
      geodesy.distanceKm === geometry.distanceKm &&
      geodesy.formatDistance === geometry.formatDistance &&
      toolsGrid.greatCircle === geometry.greatCircle &&
      toolsGrid.latLonToGrid === geometry.latLonToGrid &&
      toolsGrid.antipode === geometry.antipode,
    "lib/propagation, lib/maps/geodesy and lib/ham/tools/grid re-export one copy",
  );
  eq(geodesy.EARTH_RADIUS_KM, geometry.EARTH_RADIUS_KM, "  and one Earth radius");
  eq(toolsGrid.EARTH_RADIUS_KM, geometry.EARTH_RADIUS_KM, "  on the Tools page too");
}

console.log("\none copy of the grid patterns: each replaces its regex exactly");
{
  // Every regex the shared patterns replaced, against the pattern that replaced it, over a
  // corpus of real locators, near misses and noise, in every case.
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = "ABJRSXYZabjrsxz0459 ß";
  const corpus = ["", "RR73", "EN61", "FN31pr", "FN31pr21", "EN", "fn31PR", "EN61ZZ", "FN31 extra"];
  for (let i = 0; i < 20_000; i++) {
    let s = "";
    for (let j = rnd(10); j > 0; j--) s += alphabet[rnd(alphabet.length)];
    corpus.push(s);
  }
  const all = corpus.flatMap((s) => [s, s.toUpperCase(), s.toLowerCase()]);
  const replaced: [string, RegExp, (s: string) => boolean][] = [
    ["lib/adif/parse, lib/validation/qso, lib/validation/station", /^[A-R]{2}(\d{2}([A-X]{2}(\d{2})?)?)?$/, (s) => GRID_LOCATOR_RE.test(s)],
    ["lib/cluster/parse", /^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/i, (s) => GRID4_OR_6_ANY_CASE_RE.test(s)],
    ["lib/validation/auth", /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i, (s) => GRID4_OR_6_ANY_CASE_RE.test(s)],
    ["lib/digital/pack77", /^[A-R][A-R][0-9][0-9]$/, pack77IsGrid4],
    ["lib/digital/jtty", /^[A-R]{2}[0-9]{2}$/, isGrid4],
    ["lib/digital/qso, lib/maps/projection", /^[A-R]{2}\d{2}$/, (s) => GRID4_RE.test(s)],
    ["lib/wsjtx/all-txt", /^[A-R]{2}\d{2}$/i, (s) => GRID4_ANY_CASE_RE.test(s)],
    ["lib/digital/js8-message js8PackHeartbeat", /^[A-R]{2}[0-9]{2}$/i, (s) => GRID4_ANY_CASE_RE.test(s)],
    ["lib/awards/reference", /^[A-R]{2}\d{2}/, (s) => GRID4_PREFIX_RE.test(s)],
    ["lib/ham/grid-geometry gridToLatLon", /^[A-R]{2}[0-9]{2}([A-X]{2})?/, (s) => GRID4_PREFIX_RE.test(s)],
  ];
  for (const [site, old, now] of replaced) {
    const differ = all.filter((s) => old.test(s) !== now(s));
    ok(differ.length === 0, `${site}: same answer on all ${all.length} strings`, `first difference: "${differ[0]}"`);
  }
  ok(GRID4_OR_6_RE.test("FN31PR") && !GRID4_OR_6_RE.test("fn31pr") && !GRID4_OR_6_RE.test("FN31PR21"), "the 4-or-6 pattern is upper case and refuses eight characters");
  ok(GRID_LOCATOR_RE.test("FN") && GRID_LOCATOR_RE.test("FN31PR21") && !GRID_LOCATOR_RE.test("FN3"), "the ADIF pattern takes 2, 4, 6 or 8 characters");
}

console.log("\none HTML escape: lib/html matches the QSL card, email and opt-out page copies");
{
  const samples = ["", "plain", "a&b", "<x y=\"1\">'q'</x>", "&amp;lt;", "O'Neil & \"Sons\" <73>", "éß—", "&&<<>>\"\"''"];
  ok(samples.every((s) => escapeHtml(s) === before.escapeSequential(s)), "byte-identical to the card and email copy");
  ok(samples.every((s) => escapeHtml(s) === before.escapeOnePass(s)), "byte-identical to the opt-out page's copy");
  eq(escapeHtml("it's"), "it's", "a single quote is left alone, as all three copies did");
}

console.log("\nwhere can I operate (US Part 97)");
{
  const ft8 = lookupFrequency(14_074_000);
  eq(ft8.band, "20 m", "14.074 is 20 m");
  eq(ft8.segment?.mode, "DATA", "  in the data segment");
  ok(ft8.classes.find((c) => c.cls === "G")?.emissions.includes("DATA") === true, "  a General may run data there");
  ok(verdict(ft8, "G").allowed && !verdict(ft8, "T").allowed, "  and a Technician may not");

  const g300 = lookupFrequency(14_300_000);
  eq(g300.segment?.mode, "PHONE", "14.300 is phone");
  ok(g300.classes.find((c) => c.cls === "G")?.emissions.includes("PHONE") === true, "  General OK");

  const e160 = lookupFrequency(14_160_000);
  eq(e160.segment?.mode, "PHONE", "14.160 is phone");
  const who = e160.classes.filter((c) => c.emissions.includes("PHONE")).map((c) => c.cls).join("");
  eq(who, "E", "  Extra only");

  const g7180 = lookupFrequency(7_180_000);
  ok(g7180.segment?.mode === "PHONE" && verdict(g7180, "G").allowed, "7.180 is phone, General OK");
  ok(!verdict(lookupFrequency(7_170_000), "G").allowed, "7.170 is not, for a General");

  // Power, §97.313.
  eq(powerLimit(14_074_000, "G").label, "1,500 W PEP", "1,500 W PEP by default");
  eq(powerLimit(10_136_000, "E").label, "200 W PEP", "30 m is 200 W PEP even for an Extra");
  eq(powerLimit(7_030_000, "T").label, "200 W PEP", "a Tech's CW on 40 m is 200 W PEP");
  eq(powerLimit(7_030_000, "G").label, "1,500 W PEP", "a General's is not");
  eq(powerLimit(28_400_000, "T").label, "200 W PEP", "a Tech on 10 m phone is 200 W PEP");
  eq(powerLimit(136_000, "G").label, "1 W EIRP", "2200 m is 1 W EIRP");
  eq(powerLimit(475_000, "G").label, "5 W EIRP", "630 m is 5 W EIRP");
  eq(powerLimit(223_500_000, "N").label, "25 W PEP", "a Novice on 1.25 m is 25 W PEP");
  eq(powerLimit(1_282_000_000, "N").label, "5 W PEP", "and on 23 cm 5 W PEP");
  eq(powerLimit(219_500_000, "T").label, "50 W PEP", "219–220 MHz is 50 W PEP");

  // 60 m after FCC 25-60.
  const dial = lookupFrequency(5_330_500);
  ok(dial.channel?.channel === 1 && dial.segment !== null, "5330.5 kHz, a USB dial, is channel 1");
  const gDial = dial.classes.find((c) => c.cls === "G");
  ok(gDial?.power?.label === "100 W ERP" && gDial.phoneNote === "USB" && !gDial.emissions.includes("IMAGE"), "  100 W ERP, phone as USB, no image");
  ok(!verdict(dial, "T").allowed, "  and nothing for a Technician");
  eq(lookupFrequency(5_357_000).classes.find((c) => c.cls === "G")?.power?.label, "9.15 W ERP", "5.357 is in the new range at 9.15 W ERP");
  const gap = lookupFrequency(5_340_000);
  ok(gap.segment === null && (gap.outside ?? "").includes("Between the 60 m channels"), "5.340 is between channels, and says so");

  // The other corrections to the band plan, through the tool.
  ok(lookupFrequency(28_400_000).classes.find((c) => c.cls === "T")?.phoneNote === "SSB only", "a Tech on 28.4 is SSB only");
  ok(lookupFrequency(28_400_000).classes.find((c) => c.cls === "N")?.emissions.includes("PHONE") === true, "a Novice has 10 m phone");
  ok(!permitted(segmentAt(50_050_000), "G", "DATA"), "no data below 50.1 MHz");
  ok(verdict(lookupFrequency(146_520_000), "T").allowed, "146.52 is open to a Tech");
  ok(lookupFrequency(9_500_000).outside !== null, "9.5 MHz is outside every allocation");
  eq(lookupFrequency(70_200_000).band, "4 m", "70.2 MHz names its band");
  ok((lookupFrequency(70_200_000).outside ?? "").includes("not a US amateur allocation"), "  and says the US has no 4 m");

  // The per-band chart.
  const gen = bandChart("G");
  const twenty = gen.find((r) => r.band === "20 m");
  eq(twenty?.ranges.map((r) => r.text).join(" | "), "14.025–14.150 MHz | 14.225–14.350 MHz", "a General's 20 m is two stretches");
  const extraTwenty = bandChart("E").find((r) => r.band === "20 m");
  eq(extraTwenty?.ranges.map((r) => r.text).join(" | "), "14.000–14.150 MHz | 14.150–14.350 MHz", "an Extra's merges into data and phone");
  const tech = bandChart("T");
  eq(tech.find((r) => r.band === "20 m")?.ranges.length, 0, "a Tech has nothing on 20 m");
  eq(tech.find((r) => r.band === "60 m")?.ranges.length, 0, "or 60 m");
  const sixty = gen.find((r) => r.band === "60 m");
  eq(sixty?.ranges.length, 5, "a General's 60 m is four channels and the range");
  ok((sixty?.ranges[0]?.text ?? "").includes("USB dial 5330.5"), "  channels are quoted by their dial");

  // The licence-class setting.
  eq(classFromSetting("us-general").cls, "G", "us-general is G");
  eq(classFromSetting("us-technician").cls, "T", "us-technician is T");
  eq(classFromSetting("other").status, "other", "other is outside the US");
  eq(classFromSetting(null).status, "unset", "unset is unset");
  eq(classFromSetting("junk").status, "unset", "and junk is treated as unset");
}

console.log("\ntime");
{
  const late = new Date("2026-07-31T23:42:15.500Z");
  const u = utcNow(late);
  eq(u.time, "23:42:15Z", "UTC time through lib/time");
  eq(u.date, "2026-07-31", "ISO date");
  eq(dayOfYear(new Date("2026-10-19T12:00:00Z")), 292, "19 October 2026 is day 292");
  eq(dayOfYear(new Date("2026-01-01T00:00:00Z")), 1, "1 January is day 1");
  eq(dayOfYear(new Date("2024-12-31T23:59:59Z")), 366, "31 December in a leap year is day 366");
  eq(u.daysInYear, 365, "2026 has 365 days");
  const chi = zoneTime(late, "America/Chicago");
  ok(chi !== null && chi.time === "18:42:15" && chi.date === "2026-07-31", "Chicago is 18:42:15 the same day", JSON.stringify(chi));
  ok(chi?.offsetLabel === "UTC−5" && chi.abbreviation === "CDT" && chi.dayShift === 0, "  UTC−5, CDT");
  const tokyo = zoneTime(late, "Asia/Tokyo");
  ok(tokyo?.time === "08:42:15" && tokyo.date === "2026-08-01" && tokyo.dayShift === 1 && tokyo.offsetLabel === "UTC+9", "Tokyo is 08:42:15 the next day, UTC+9", JSON.stringify(tokyo));
  eq(zoneTime(late, "Asia/Kolkata")?.offsetLabel, "UTC+5:30", "Kolkata is UTC+5:30");
  eq(zoneTime(new Date("2026-01-15T12:00:00Z"), "America/Los_Angeles")?.offsetMinutes, -480, "Los Angeles in winter is UTC−8");
  eq(zoneTime(late, "Pacific/Niue")?.dayShift, 0, "Niue (−11) is still 31 July");
  eq(zoneTime(late, "Not/AZone"), null, "a zone that does not exist is null, not a throw");
  ok(isValidZone("Europe/London") && !isValidZone("") && !isValidZone("Mars/Olympus"), "zone validation");

  // None of it may depend on the machine's own zone.
  const before = JSON.stringify([utcNow(late), zoneTime(late, "Asia/Tokyo"), zoneTime(late, "America/Chicago")]);
  const saved = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  const after = JSON.stringify([utcNow(late), zoneTime(late, "Asia/Tokyo"), zoneTime(late, "America/Chicago")]);
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
  eq(after, before, "identical with the process moved to UTC+14");
}

console.log("\nreferences");
{
  const phon = REFERENCE_GROUPS.find((g) => g.id === "ref-phonetics");
  eq(phon?.entries.length, 36, "26 letters and 10 digits");
  eq(phon?.entries.find((e) => e.term === "A")?.meaning, "Alfa", "ICAO spelling: Alfa");
  eq(phon?.entries.find((e) => e.term === "J")?.meaning, "Juliett", "and Juliett");
  const qrz = filterReference("qrz");
  ok(qrz.some((g) => g.entries.some((e) => e.term === "QRZ")), "filtering for qrz finds QRZ");
  ok(qrz.some((g) => g.entries.some((e) => e.term === "QRZ?")), "  and the abbreviation QRZ?");
  const k = filterReference("K");
  eq(k.find((g) => g.group.id === "ref-phonetics")?.entries[0]?.meaning, "Kilo", "K ranks Kilo first");
  ok(filterReference("73").some((g) => g.entries.some((e) => e.term === "73")), "73 is there");
  for (const term of ["88", "CQ", "DE", "QTH", "AR", "SK"]) {
    ok(filterReference(term).some((g) => g.entries.some((e) => e.term === term)), `${term} is there`);
  }
  eq(filterReference("zzzz").length, 0, "nonsense matches nothing");
  eq(filterReference("").length, REFERENCE_GROUPS.length, "an empty filter shows every group");
}

console.log("\nnothing prints NaN or Infinity");
{
  eq(fmt(Number.NaN), "—", "NaN formats as a dash");
  eq(fmt(Number.POSITIVE_INFINITY), "—", "so does Infinity");
  eq(fmt(-0.0001, 2), "0.00", "and -0.00 loses its sign");
  eq(formatWatts(0), "—", "0 W has no SI step");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

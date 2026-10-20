// Known answers for the grid map's day/night overlay and its great-circle paths.
//
// The failure these guard against is silent and plausible: a sign error in the equation of
// time or a swapped hemisphere still draws a tidy terminator — in the wrong place, on a map
// an operator reads to catch the greyline. So the sun is pinned to almanac values and the
// terminator to the latitudes geometry fixes exactly (the polar circles, the equator).

import {
  bearingDeg as libBearing,
  distanceKm as libDistance,
  formatDistance as libFormat,
  gridToLatLon as libGrid,
} from "@/lib/propagation";
import {
  bearingDeg,
  distanceKm,
  formatBearing,
  formatDistance,
  gridToLatLon,
  greatCirclePath,
  paths,
  splitAtAntimeridian,
} from "@/lib/maps/geodesy";
import {
  nightPolygon,
  nightSpan,
  solarAltitude,
  sunPosition,
  terminatorLine,
  twilightDepth,
  twilightGrid,
} from "@/lib/maps/greyline";

let pass = 0;
let fail = 0;
function ok(cond: boolean, what: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${what}`);
  } else {
    fail++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  }
}
function near(got: number, want: number, tol: number, what: string): void {
  ok(Math.abs(got - want) <= tol, what, `got ${got.toFixed(3)}, want ${want} ±${tol}`);
}
const utc = (s: string) => Date.parse(`${s}Z`);

console.log("\nthe sun's declination at the solstices and equinoxes (2026)");
{
  // Obliquity in 2026 is 23.436°; at a solstice the declination is stationary, so these
  // hold to the formula's own precision. At an equinox it moves 0.4°/day, so 0.1° allows
  // for the event time being quoted to the minute.
  near(sunPosition(utc("2026-06-21T08:24:00")).declination, 23.436, 0.05, "June solstice ≈ +23.4°");
  near(sunPosition(utc("2026-12-21T20:50:00")).declination, -23.436, 0.05, "December solstice ≈ −23.4°");
  near(sunPosition(utc("2026-03-20T14:46:00")).declination, 0, 0.1, "March equinox ≈ 0°");
  near(sunPosition(utc("2026-09-23T00:05:00")).declination, 0, 0.1, "September equinox ≈ 0°");
}

console.log("\nthe equation of time against the almanac's extremes");
{
  near(sunPosition(utc("2026-02-11T12:00:00")).equationOfTime, -14.2, 0.5, "mid-February ≈ −14.2 min");
  near(sunPosition(utc("2026-11-03T12:00:00")).equationOfTime, 16.4, 0.5, "early November ≈ +16.4 min");
  near(sunPosition(utc("2026-05-14T12:00:00")).equationOfTime, 3.7, 0.5, "mid-May ≈ +3.7 min");
  near(sunPosition(utc("2026-07-26T12:00:00")).equationOfTime, -6.5, 0.5, "late July ≈ −6.5 min");
}

console.log("\nthe subsolar longitude is −15°×(UTC − 12) less the equation of time");
{
  // 16.4 minutes of sundial-fast is 4.1° of longitude the sun has already passed.
  near(sunPosition(utc("2026-11-03T12:00:00")).subsolar.lon, -4.1, 0.5, "noon UTC in November sits 4° west of Greenwich");
  near(sunPosition(utc("2026-02-11T12:00:00")).subsolar.lon, 3.55, 0.5, "and in February 3.5° east");
  near(sunPosition(utc("2026-06-21T08:24:00")).subsolar.lon, 54.4, 1, "08:24 UTC at the June solstice is over the Arabian Sea");
  near(sunPosition(utc("2026-04-15T18:00:00")).subsolar.lon, -90, 1, "18:00 UTC near an EoT zero is 90°W");
  const midnight = sunPosition(utc("2026-06-13T00:00:00")).subsolar.lon;
  ok(Math.abs(Math.abs(midnight) - 180) < 1, "midnight UTC is on the antimeridian", `${midnight.toFixed(2)}`);
  ok(Math.abs(midnight) <= 180, "and the longitude stays wrapped to ±180");
}

console.log("\nthe sun is where the altitude says it is");
{
  const sun = sunPosition(utc("2026-06-21T08:24:00"));
  near(solarAltitude(sun, sun.subsolar.lat, sun.subsolar.lon), 90, 1e-6, "overhead at the subsolar point");
  near(solarAltitude(sun, -sun.subsolar.lat, sun.subsolar.lon + 180), -90, 1e-6, "and directly underfoot at the antisolar point");
  near(solarAltitude(sun, 90, 0), 23.436, 0.05, "the north pole sees the sun at the declination in June");
}

console.log("\nthe terminator crosses the latitudes geometry fixes");
{
  const sun = sunPosition(utc("2026-06-21T08:24:00"));
  const s = sun.subsolar.lon;
  // At the antisolar meridian the June terminator is the Arctic Circle (midnight sun), at
  // the subsolar meridian the Antarctic Circle, and 90° from the sun it crosses the equator.
  near(nightSpan(sun, s + 180 > 180 ? s - 180 : s + 180)[1], 90 - 23.436, 0.1, "midnight-sun edge at 66.6°N");
  near(nightSpan(sun, s)[1], -(90 - 23.436), 0.1, "noon-horizon edge at 66.6°S");
  near(nightSpan(sun, s + 90)[1], 0, 0.1, "crosses the equator 90° east of the sun");
  near(nightSpan(sun, s - 90)[1], 0, 0.1, "and 90° west");
  near(nightSpan(sun, s)[0], -90, 1e-9, "in June night holds the south pole");

  const dec = sunPosition(utc("2026-12-21T20:50:00"));
  near(nightSpan(dec, 0)[1], 90, 1e-9, "in December night holds the north pole instead");

  // A cap that holds no pole — civil twilight at an equinox — still makes a closed band.
  const eq = sunPosition(utc("2026-03-20T14:46:00"));
  const civil = nightSpan(eq, eq.subsolar.lon + 180 - 360);
  ok(civil[0] < 0 && civil[1] > 0, "night at an equinox spans the equator on the far side");
  const span = nightSpan(eq, eq.subsolar.lon, -6);
  ok(span[0] === span[1], "and twilight never reaches the noon meridian", `${span[0]}..${span[1]}`);
}

console.log("\nthe night polygon and the greyline");
{
  const sun = sunPosition(utc("2026-06-21T08:24:00"));
  const poly = nightPolygon(sun, 0, 1);
  ok(poly.length === 722, "one vertex per degree along each edge", `${poly.length}`);
  ok(poly.every(([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90), "every vertex is on Earth");
  // Every vertex of the northern edge agrees with the altitude: the sun is on the horizon
  // there unless the edge is a pole.
  const line = terminatorLine(sun, 1);
  const worst = Math.max(...line.map(([lon, lat]) => Math.abs(solarAltitude(sun, lat, lon))));
  ok(worst < 0.01, "the sun is on the horizon all along the greyline", `worst ${worst.toFixed(4)}°`);
  // Deeper twilight is a smaller cap, inside the one before it.
  const deeper = [-6, -12, -18].map((h) => nightSpan(sun, sun.subsolar.lon + 180 - 360, h)[1]);
  ok(deeper[0]! < 66.6 && deeper[1]! < deeper[0]! && deeper[2]! < deeper[1]!, "each twilight limit sits further into the night", deeper.map((d) => d.toFixed(1)).join(", "));
}

console.log("\nthe soft twilight band");
{
  ok(twilightDepth(5) === 0 && twilightDepth(0) === 0, "no shading while the sun is up");
  ok(twilightDepth(-18) === 1 && twilightDepth(-40) === 1, "full night past astronomical twilight");
  near(twilightDepth(-9), 0.5, 1e-9, "halfway through twilight is half dark");
  const sun = sunPosition(utc("2026-06-21T08:24:00"));
  const grid = twilightGrid(sun, 360, 180);
  ok(grid.length === 360 * 180, "one cell per degree");
  const at = (lat: number, lon: number) => grid[Math.floor(90 - lat) * 360 + Math.floor(lon + 180)]!;
  ok(at(sun.subsolar.lat, sun.subsolar.lon) === 0, "clear at the subsolar point");
  ok(at(-sun.subsolar.lat, sun.subsolar.lon - 180) === 255, "fully dark at the antisolar point");
}

console.log("\nthe map's geodesy agrees with lib/propagation");
{
  const probes = ["EN61", "IO91", "PM95", "QF56", "AA00", "RR99", "EN61XX", "JJ00aa", "FN42hn"];
  for (const g of probes) {
    const mine = gridToLatLon(g);
    const theirs = libGrid(g);
    ok(JSON.stringify(mine) === JSON.stringify(theirs), `${g} resolves identically`);
  }
  ok(gridToLatLon("ZZ99") === null && gridToLatLon("") === null, "and refuses what it refuses");
  const home = gridToLatLon("EN61")!;
  for (const g of ["IO91", "PM95", "QF56", "GG66", "KP20"]) {
    const there = gridToLatLon(g)!;
    ok(bearingDeg(home, there) === libBearing(home, there), `bearing to ${g} identical`);
    ok(distanceKm(home, there) === libDistance(home, there), `distance to ${g} identical`);
  }
  for (const km of [0, 1, 999.5, 6400, 19_999]) {
    ok(formatDistance(km, "km") === libFormat(km, "km") && formatDistance(km, "mi") === libFormat(km, "mi"), `${km} km formats identically in both units`);
  }
}

console.log("\nbearings, paths and the long way round");
{
  ok(formatBearing(47.4) === "47° NE", "47° reads NE", formatBearing(47.4));
  ok(formatBearing(359.7) === "0° N", "359.7° rounds to north, not 360", formatBearing(359.7));
  const home = gridToLatLon("EN61")!;
  const tokyo = gridToLatLon("PM95")!;
  const p = paths(home, tokyo);
  near(p.long.bearing, (p.short.bearing + 180) % 360, 1e-9, "the long path leaves the opposite way");
  near(p.short.km + p.long.km, 2 * Math.PI * 6371, 1e-6, "and the two add to the circumference");

  const segs = greatCirclePath(home, tokyo, 1);
  ok(segs.length === 2, "Illinois to Japan crosses the antimeridian once", `${segs.length} segments`);
  const flat = segs.flat();
  // Leaves home, arrives at Tokyo, and goes up over the Arctic rather than across the Pacific.
  near(flat[0]![0], home.lon, 1e-9, "starts at home");
  near(flat[flat.length - 1]![1], tokyo.lat, 1e-9, "ends at the far station");
  ok(Math.max(...flat.map(([, lat]) => lat)) > 60, "and goes poleward on the way", `${Math.max(...flat.map(([, lat]) => lat)).toFixed(1)}°N max`);
  ok(segs.every((s) => s.every(([lon]) => lon >= -180 && lon <= 180)), "no point leaves the map");
  const split = splitAtAntimeridian([[170, 10], [-170, 20]]);
  ok(split.length === 2 && split[0]![1]![0] === 180 && split[1]![0]![0] === -180, "a crossing ends one segment at 180 and starts the next at −180");
  near(split[0]![1]![1], 15, 1e-9, "at the interpolated latitude");
  const antipode = greatCirclePath({ lat: 10, lon: 20 }, { lat: -10, lon: -160 }, 2);
  ok(antipode.flat().every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)), "an antipodal pair still gives a finite path");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

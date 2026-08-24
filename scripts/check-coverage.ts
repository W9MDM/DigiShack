// Bearing and distance, which the coverage plot is entirely made of.
//
// Worth real assertions because the failure is silent and plausible: a sign error or a
// swapped argument produces a plot that looks like a plot, with every contact in the wrong
// quarter of the sky. An operator would point an antenna on it.

import { bearingDeg, distanceKm, gridToLatLon } from "@/lib/propagation";

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
  ok(Math.abs(got - want) <= tol, what, `got ${got.toFixed(1)}, want ${want} ±${tol}`);
}

/** This station, from its own settings. */
const HOME = gridToLatLon("EN61")!;

console.log("\nthe grid the whole page is measured from");
{
  ok(HOME !== null, "EN61 resolves");
  // EN61 is central Illinois: north of the equator, west of Greenwich.
  near(HOME.lat, 41.5, 1, "at about 41.5N");
  near(HOME.lon, -87, 1.5, "and about 87W — the CENTRE of the square, not its corner");
}

console.log("\nbearings that can be checked against the world");
{
  // Cardinal sanity first. A point due east of us on the same latitude must read close to
  // 90, and the small departure is real: a great-circle path east curves poleward.
  near(bearingDeg(HOME, { lat: HOME.lat, lon: -80 }), 90, 4, "due east reads about 90");
  near(bearingDeg(HOME, { lat: HOME.lat, lon: -94 }), 270, 4, "due west about 270");
  // Straight up and down the station's OWN meridian. Taking a round -89 here read 352,
  // which is correct for a point two degrees west of EN61's centre and was my error, not
  // the maths — the kind of near-miss that would have been "fixed" in the wrong file.
  near(bearingDeg(HOME, { lat: HOME.lat + 10, lon: HOME.lon }), 0, 0.1, "due north is 0");
  near(bearingDeg(HOME, { lat: HOME.lat - 10, lon: HOME.lon }), 180, 0.1, "due south is 180");

  // Real paths, the kind an operator would recognise. Illinois to Europe leaves to the
  // north-east, not east — which is the whole reason a great-circle bearing is not a
  // flat-map angle.
  const london = gridToLatLon("IO91")!;
  near(bearingDeg(HOME, london), 47, 6, "London is north-east of Illinois, not east");

  // Illinois to Japan leaves over the pole. A flat map says west-north-west; the sky says
  // nearly due north-west, and a beam pointed on the flat-map answer misses.
  const tokyo = gridToLatLon("PM95")!;
  const toTokyo = bearingDeg(HOME, tokyo);
  ok(
    toTokyo > 300 && toTokyo < 335,
    "Japan is north-west over the pole",
    `${toTokyo.toFixed(0)}°`,
  );

  // Australia is the long way round to the south-west.
  const sydney = gridToLatLon("QF56")!;
  const toSydney = bearingDeg(HOME, sydney);
  ok(toSydney > 220 && toSydney < 270, "Sydney is south-west", `${toSydney.toFixed(0)}°`);
}

console.log("\nbearings stay in compass range");
{
  // atan2 returns -180..180 and a compass does not. A negative bearing would land a
  // contact outside the plot entirely, silently.
  const probes = [
    { lat: 41.5, lon: -100 },
    { lat: 20, lon: 100 },
    { lat: -40, lon: -60 },
    { lat: 70, lon: 179 },
    { lat: -70, lon: -179 },
  ];
  ok(
    probes.every((p) => {
      const b = bearingDeg(HOME, p);
      return b >= 0 && b < 360;
    }),
    "every direction reads 0-360, never negative",
  );
  // Crossing the date line is where a naive longitude difference breaks.
  const east = bearingDeg({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
  near(east, 90, 1, "crossing the date line eastward still reads east");
}

console.log("\ndistances that can be checked against the world");
{
  const london = gridToLatLon("IO91")!;
  const tokyo = gridToLatLon("PM95")!;
  near(distanceKm(HOME, london), 6_400, 400, "Illinois to London is about 6,400 km");
  near(distanceKm(HOME, tokyo), 10_200, 600, "to Tokyo about 10,200 km");
  near(distanceKm(HOME, HOME), 0, 1, "and to itself, nothing");

  // The plot caps its outer ring at 20,000 km, which has to be past the antipode or the
  // furthest contacts would pile up on the rim.
  const antipode = distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
  ok(antipode > 19_000 && antipode < 20_100, "half the way round is under 20,000 km", `${antipode.toFixed(0)}`);
}

console.log("\ngrids that cannot be placed");
{
  // These arrive from imports and callsign lookups constantly, and the map counts them
  // rather than dropping them silently — but they must not resolve to a plausible point.
  ok(gridToLatLon("") === null, "an empty grid is null");
  ok(gridToLatLon("ZZ99") === null, "a field beyond R is null");
  ok(gridToLatLon("EN") === null, "a two-character field alone is null");
  ok(gridToLatLon("EN61XX") !== null, "and a six-character grid resolves");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

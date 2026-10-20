// Day and night on the grid map, computed from the clock — no network, no tables.
//
// The sun comes from the Astronomical Almanac's low-precision formulae (about 0.01° in
// declination over 1950–2050): mean longitude and anomaly give the ecliptic longitude, and
// from that the declination and right ascension. The equation of time is the mean sun's
// longitude minus the true sun's right ascension. The subsolar point is then the
// declination, at the longitude where it is local apparent noon.
//
// Night is drawn per meridian rather than as a projected small circle. On any one meridian
// the region where the sun is below a given altitude is a single latitude interval (a cap of
// at most a hemisphere is convex), so a polygon built from those intervals needs no special
// cases for a cap that contains a pole or one that straddles the antimeridian.

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Solar declination, degrees — also the subsolar latitude. */
  declination: number;
  /** Apparent minus mean solar time, minutes. Positive when a sundial runs fast. */
  equationOfTime: number;
  /** Where the sun is overhead. */
  subsolar: { lat: number; lon: number };
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The sun's position at an instant (ms since the epoch, or a Date). */
export function sunPosition(at: Date | number): SunPosition {
  const ms = typeof at === "number" ? at : at.getTime();
  // Days since J2000.0 (JD 2451545.0); the Unix epoch is JD 2440587.5.
  const n = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda)) / RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD;
  const equationOfTime = wrap180(L - ra) * 4;
  const utcMinutes = (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
  // Local apparent noon where lon/15 + UTC + EoT/60 = 12 h.
  const lon = wrap180(-(utcMinutes - 720 + equationOfTime) / 4);
  return { declination, equationOfTime, subsolar: { lat: declination, lon } };
}

/** The sun's altitude above the horizon at a place, degrees. */
export function solarAltitude(sun: SunPosition, lat: number, lon: number): number {
  const d = sun.declination * RAD;
  const phi = lat * RAD;
  const h = (lon - sun.subsolar.lon) * RAD;
  const s = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(h);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

/**
 * The latitudes on one meridian where the sun is below `altitude`, as [south, north].
 *
 * A meridian with no such stretch collapses to its darkest point, so polygons built from
 * these stay continuous where a twilight cap stops reaching a meridian.
 */
export function nightSpan(sun: SunPosition, lon: number, altitude = 0): [number, number] {
  // An exact-zero declination makes the terminator two meridians and the interval maths
  // divides by it; a nudge too small to draw keeps every case on the general path.
  const decl = Math.abs(sun.declination) < 1e-6 ? 1e-6 : sun.declination;
  const d = decl * RAD;
  const H = (lon - sun.subsolar.lon) * RAD;
  const A = Math.sin(d);
  const B = Math.cos(d) * Math.cos(H);
  const C = Math.sin(altitude * RAD);
  const f = (latDeg: number) => A * Math.sin(latDeg * RAD) + B * Math.cos(latDeg * RAD);

  // f(φ) = R·sin(φ + ψ); the crossings of C split the meridian into pieces to test.
  const breaks = [-90, 90];
  const R = Math.hypot(A, B);
  const psi = Math.atan2(B, A);
  if (R > 1e-12 && Math.abs(C / R) < 1) {
    const a = Math.asin(C / R);
    for (const base of [a - psi, Math.PI - a - psi]) {
      for (let k = -2; k <= 2; k++) {
        const phi = (base + 2 * Math.PI * k) / RAD;
        if (phi > -90 && phi < 90) breaks.push(phi);
      }
    }
  }
  breaks.sort((x, y) => x - y);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const a0 = breaks[i]!;
    const a1 = breaks[i + 1]!;
    if (a1 - a0 < 1e-9) continue;
    if (f((a0 + a1) / 2) < C) {
      lo = Math.min(lo, a0);
      hi = Math.max(hi, a1);
    }
  }
  if (lo <= hi) return [lo, hi];

  let darkest = -90;
  for (let k = -2; k <= 2; k++) {
    const phi = (-Math.PI / 2 - psi + 2 * Math.PI * k) / RAD;
    if (phi >= -90 && phi <= 90 && f(phi) < f(darkest)) darkest = phi;
  }
  if (f(90) < f(darkest)) darkest = 90;
  return [darkest, darkest];
}

/**
 * Where the sun is below `altitude` degrees, as a closed [lon, lat] polygon: west to east
 * along the northern edge, then back along the southern one. 0 is the terminator; −6, −12
 * and −18 are the civil, nautical and astronomical twilight limits.
 */
export function nightPolygon(sun: SunPosition, altitude = 0, stepDeg = 1): [number, number][] {
  const north: [number, number][] = [];
  const south: [number, number][] = [];
  const n = Math.round(360 / stepDeg);
  for (let i = 0; i <= n; i++) {
    const lon = -180 + (360 * i) / n;
    const [lo, hi] = nightSpan(sun, lon, altitude);
    north.push([lon, hi]);
    south.push([lon, lo]);
  }
  return [...north, ...south.reverse()];
}

/**
 * The terminator itself — the greyline — as a [lon, lat] polyline.
 *
 * Night always holds the pole the sun is not tilted toward, so the terminator is whichever
 * edge of the night interval is not that pole.
 */
export function terminatorLine(sun: SunPosition, stepDeg = 1): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.round(360 / stepDeg);
  const northernSummer = sun.declination >= 0;
  for (let i = 0; i <= n; i++) {
    const lon = -180 + (360 * i) / n;
    const [lo, hi] = nightSpan(sun, lon, 0);
    out.push([lon, northernSummer ? hi : lo]);
  }
  return out;
}

/** Below the horizon, how dark the sky is: 0 at sunset rising to 1 at astronomical night. */
export function twilightDepth(altitude: number): number {
  if (altitude >= 0) return 0;
  if (altitude <= -18) return 1;
  const t = -altitude / 18;
  return t * t * (3 - 2 * t);
}

/**
 * Twilight depth sampled once per cell over the whole world, row 0 at the north.
 *
 * The renderer stretches it with smoothing to get the soft band; values are 0–255 so it
 * drops straight into an ImageData alpha channel.
 */
export function twilightGrid(sun: SunPosition, width = 360, height = 180): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let row = 0; row < height; row++) {
    const lat = 90 - ((row + 0.5) / height) * 180;
    for (let col = 0; col < width; col++) {
      const lon = -180 + ((col + 0.5) / width) * 360;
      out[row * width + col] = Math.round(twilightDepth(solarAltitude(sun, lat, lon)) * 255);
    }
  }
  return out;
}

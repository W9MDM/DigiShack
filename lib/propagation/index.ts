// Propagation context from outside this station: PSKReporter activity and solar data.
//
// This is the one place DigiShack deliberately reaches out to third parties, so the
// rules are strict:
//
//   * Everything is CACHED and rate-limited. PSKReporter asks for no more than one
//     query per five minutes per client and enforces it; being blocked would take the
//     feature away from everyone running this code, not just one station.
//   * Every fetch fails SOFT. A band strip is a convenience, and losing the internet
//     must not take down the Digital page — each source returns null and the UI shows
//     what it has.
//   * Nothing here is required to log or operate. The station's own decode history
//     (lib/stats/band-activity.ts) needs no network and remains the primary source.
//
// ON "VOACAP": there is no free VOACAP HTTP API, and a real prediction needs the
// ITU/ITS engine plus its coefficient files. What IS free is the solar input VOACAP
// runs on — flux, sunspot number, Kp — so that is what this fetches, and the derived
// figure is called `usability` and labelled an estimate rather than borrowing the
// VOACAP name for something that is not VOACAP output.

import { freqToBand } from "@/lib/ham/bands";
import { prisma } from "@/lib/db/prisma";

/**
 * PSKReporter's own guidance. Going faster earns a block, not just a 503.
 *
 * Raised from five minutes to twelve after being refused outright:
 *
 *   {"message": "Your IP has made too many queries too often.
 *                Please moderate your requests."}
 *
 * Five minutes was the per-CALLER budget, and there are three callers on one IP —
 * the bridge's reception-report upload, the bridge asking which band is busiest for
 * hop decisions, and the web app drawing the band strip. They run in TWO PROCESSES,
 * so a module-level cache cannot be shared between them however careful each one is.
 * Three callers at one query per five minutes is a query every hundred seconds from
 * one address, which is what earned the block.
 */
const PSK_MIN_INTERVAL_MS = 12 * 60_000;

/**
 * How long to stand off after being refused.
 *
 * Longer than the ordinary interval, because the answer to "you are asking too often"
 * cannot be to keep asking at the same rate.
 */
const PSK_BACKOFF_MS = 30 * 60_000;
/** Solar indices move slowly, and NOAA updates every three hours. */
const SOLAR_TTL_MS = 30 * 60_000;

interface Cached<T> {
  at: number;
  value: T;
}

let pskCache: (Cached<PskBandActivity[]> & { mode: string }) | null = null;
let pskInFlight: Promise<PskBandActivity[] | null> | null = null;

/**
 * The band figures, shared between processes through the database.
 *
 * A module-level cache is per-process, and the bridge and the web application are two
 * processes on one IP address. However well each behaved on its own, together they
 * doubled the query rate to a service that counts queries per IP — and PSKReporter
 * refused us outright for it. Whichever process fetches now, both see the result, so
 * the rate is one query per interval for the whole installation rather than one per
 * process.
 *
 * State, not configuration: written directly and never shown on the Settings page.
 */
const KEY_PSK_SHARED = "psk.bandActivityCache";

async function readSharedPsk(
  mode: string,
): Promise<{ at: number; value: PskBandActivity[] } | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: KEY_PSK_SHARED } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as { at: number; mode: string; value: PskBandActivity[] };
    if (parsed.mode !== mode || !Array.isArray(parsed.value)) return null;
    return { at: parsed.at, value: parsed.value };
  } catch {
    // A cache that cannot be read is a cache miss, never an error worth surfacing.
    return null;
  }
}

async function writeSharedPsk(mode: string, value: PskBandActivity[]): Promise<void> {
  try {
    const payload = JSON.stringify({ at: Date.now(), mode, value });
    await prisma.setting.upsert({
      where: { key: KEY_PSK_SHARED },
      create: { key: KEY_PSK_SHARED, value: payload, encrypted: false },
      update: { value: payload },
    });
  } catch {
    /* the fetch already succeeded; failing to share it must not fail the caller */
  }
}
let solarCache: Cached<SolarConditions> | null = null;

export interface PskBandActivity {
  band: string;
  /**
   * Distinct stations TRANSMITTING on this band in the window.
   *
   * The headline figure — "how many people are doing FT8 on 20 m at the moment".
   * Counted from distinct sender callsigns, so one loud station spotted by fifty
   * receivers counts once.
   */
  transmitting: number;
  /** Distinct stations reporting, i.e. how well watched the band is. */
  receivers: number;
  /**
   * Distinct DXCC entities those transmitters were in.
   *
   * Often more telling than the raw count. 123 stations across 39 entities is a band
   * open widely; 150 across 12 is a regional opening.
   */
  entities: number;
  /** Best SNR reported anywhere on the band. */
  bestSnr: number | null;
  /** How many distinct stations reported hearing US on this band. */
  heardUsBy: number;
}

/** Maidenhead to lat/lon, centre of the square. */
export function gridToLatLon(grid: string): { lat: number; lon: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?/.test(g)) return null;
  const A = 65;
  let lon = (g.charCodeAt(0) - A) * 20 - 180;
  let lat = (g.charCodeAt(1) - A) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]) * 1;
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - A) * (2 / 24) + 1 / 24;
    lat += (g.charCodeAt(5) - A) * (1 / 24) + 0.5 / 24;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

/**
 * Initial great-circle bearing from a to b, in degrees true.
 *
 * The number a beam is pointed at. Not the same as the bearing you would read off a flat
 * map: the great-circle path from Illinois to Japan leaves over the pole, and a plot that
 * used the flat-map angle would tell an operator to point their antenna at the wrong
 * quarter of the sky.
 */
export function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  // atan2 gives -180..180; a compass bearing is 0..360.
  return (deg + 360) % 360;
}

/** Great-circle distance in km. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ReceptionReport {
  receiverCallsign: string;
  receiverLocator: string | null;
  senderCallsign: string | null;
  senderLocator: string | null;
  senderDxcc: string | null;
  frequency: number;
  mode: string;
  snr: number | null;
  at: number;
}

/**
 * Parse PSKReporter's XML by regex rather than with an XML parser.
 *
 * The payload is a flat list of `<receptionReport ... />` elements with no nesting, no
 * namespaces and no text content, so pulling attributes off each one is sufficient and
 * avoids a parser dependency for a single endpoint. If they ever nest anything this needs
 * revisiting.
 *
 * There is a SECOND parser of the same element in lib/pskreporter/retrieve.ts, and the
 * duplication is worth knowing about. They serve opposite questions — this one reads other
 * stations' reports to judge band activity, that one reads reports OF US — and they return
 * different fields. Consolidating them is a fair thing to want; doing it carelessly would
 * put band activity and the coverage view on one struct that suits neither.
 */
export function parseReceptionReports(xml: string): ReceptionReport[] {
  const out: ReceptionReport[] = [];
  // Tolerates a closing bracket with or without the slash. The self-closing form is what
  // PSKReporter sends today, and a parser that silently returns nothing if they ever stop
  // is a band-activity panel that reads "quiet everywhere" — the one answer nobody checks.
  const re = /<receptionReport\s([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]!;
    const get = (name: string): string | null => {
      const a = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return a ? a[1]! : null;
    };
    const freq = Number(get("frequency"));
    const call = get("receiverCallsign");
    if (!call || !Number.isFinite(freq) || freq <= 0) continue;
    const snrRaw = get("sNR");
    const secs = Number(get("flowStartSeconds"));
    out.push({
      receiverCallsign: call,
      receiverLocator: get("receiverLocator"),
      senderCallsign: get("senderCallsign"),
      senderLocator: get("senderLocator"),
      senderDxcc: get("senderDXCC"),
      frequency: freq,
      mode: get("mode") ?? "",
      snr:
        snrRaw !== null && snrRaw !== "" && Number.isFinite(Number(snrRaw))
          ? Number(snrRaw)
          : null,
      at: Number.isFinite(secs) ? secs * 1000 : 0,
    });
  }
  return out;
}

/**
 * Global FT8/FT4 activity per band, right now.
 *
 * NO callsign filter — this is a snapshot of what the whole network is hearing, which
 * is what "how many people are on 20 m" actually asks. Filtered to ONE mode, because
 * FT8 and FT4 occupy different sub-bands and different populations, and averaging them
 * describes neither.
 *
 * The result is a SAMPLE, not a census. PSKReporter returns a bounded slice of recent
 * reports — roughly 1,500 for a 15-minute window — so each count is a consistent lower
 * bound rather than the true number of operators. The ORDERING between bands is the
 * trustworthy part, and that is what the display is for; anyone reading "152" as the
 * exact number of stations on 20 m is being misled, which is why the UI says "seen".
 *
 * `ourCallsign` only marks which bands heard US. It never filters.
 */
export async function fetchPskActivity(opts: {
  mode: string;
  contact: string;
  ourCallsign?: string | null;
  windowSeconds?: number;
}): Promise<PskBandActivity[] | null> {
  const now = Date.now();
  const key = opts.mode.toUpperCase();
  if (pskCache && pskCache.mode === key && now - pskCache.at < PSK_MIN_INTERVAL_MS) {
    return pskCache.value;
  }
  // Collapse concurrent callers onto one request: several browser tabs polling would
  // otherwise each fire one and trip the rate limit together.
  if (pskInFlight) return pskInFlight;

  // Has the OTHER process already asked recently? The bridge and the web application
  // each keep their own memory cache and neither can see the other's, which is how
  // one installation came to be querying twice per interval from a single IP.
  const shared = await readSharedPsk(key);
  if (shared && now - shared.at < PSK_MIN_INTERVAL_MS) {
    pskCache = { at: shared.at, mode: key, value: shared.value };
    return shared.value;
  }

  // 15 minutes is the sweet spot — long enough to catch a few transmit cycles on every
  // band, short enough that "right now" means it.
  const window = Math.max(300, Math.min(opts.windowSeconds ?? 900, 3600));
  const url =
    `https://retrieve.pskreporter.info/query` +
    `?flowStartSeconds=-${window}` +
    `&mode=${encodeURIComponent(key)}` +
    `&rronly=1` +
    // PSKReporter asks automated users to identify themselves so they can make contact
    // before blocking. Honouring it is the difference between an email and a ban.
    `&appcontact=${encodeURIComponent(opts.contact)}`;

  const us = opts.ourCallsign?.trim().toUpperCase() ?? null;

  pskInFlight = (async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "DigiShack (amateur radio logger)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        // Keep the LAST GOOD figures rather than replacing them with nothing.
        //
        // The old line cached an empty array on failure, so one refusal blanked the
        // band strip to a row of dashes for everyone — and band conditions are the
        // one thing on that page that changes slowly enough for a stale reading to
        // still be worth having. Losing the data outright is the worse answer, and
        // it looks like a broken application rather than a service saying "later".
        //
        // The stand-off is longer than the ordinary interval: the answer to "you are
        // asking too often" cannot be to keep asking at the same rate.
        const keep = pskCache?.value ?? [];
        pskCache = { at: now + (PSK_BACKOFF_MS - PSK_MIN_INTERVAL_MS), mode: key, value: keep };
        if (res.status === 503) {
          console.warn(
            "[psk] refused (503) — holding the last band figures and standing off for " +
              `${Math.round(PSK_BACKOFF_MS / 60_000)} min`,
          );
        }
        return keep;
      }
      const reports = parseReceptionReports(await res.text());

      const perBand = new Map<
        string,
        {
          tx: Set<string>;
          rx: Set<string>;
          ent: Set<string>;
          best: number | null;
          heardUsBy: Set<string>;
        }
      >();

      for (const r of reports) {
        if (r.mode && r.mode.toUpperCase() !== key) continue;
        const band = freqToBand(r.frequency);
        if (!band) continue;
        const e =
          perBand.get(band) ??
          {
            tx: new Set<string>(),
            rx: new Set<string>(),
            ent: new Set<string>(),
            best: null as number | null,
            heardUsBy: new Set<string>(),
          };
        const sender = r.senderCallsign?.toUpperCase() ?? null;
        if (sender) e.tx.add(sender);
        e.rx.add(r.receiverCallsign.toUpperCase());
        if (r.senderDxcc) e.ent.add(r.senderDxcc);
        if (r.snr !== null) e.best = e.best === null ? r.snr : Math.max(e.best, r.snr);
        if (us && sender === us) e.heardUsBy.add(r.receiverCallsign.toUpperCase());
        perBand.set(band, e);
      }

      const value: PskBandActivity[] = [...perBand.entries()]
        .map(([band, e]) => ({
          band,
          transmitting: e.tx.size,
          receivers: e.rx.size,
          entities: e.ent.size,
          bestSnr: e.best,
          heardUsBy: e.heardUsBy.size,
        }))
        .sort((a, b) => b.transmitting - a.transmitting);

      pskCache = { at: Date.now(), mode: key, value };
      // Hand it to the other process too, so its next call costs no query.
      await writeSharedPsk(key, value);
      return value;
    } catch {
      // Offline, DNS failure, timeout. Keep what we had; the UI copes with null.
      return pskCache?.value ?? null;
    } finally {
      pskInFlight = null;
    }
  })();

  return pskInFlight;
}

export interface SolarConditions {
  /** 10.7 cm solar flux. */
  sfi: number | null;
  /** Effective sunspot number. */
  ssn: number | null;
  /** Planetary K index, 0-9. Above about 4 is a disturbed ionosphere. */
  kp: number | null;
  /** Running A index. */
  aIndex: number | null;
  observedAt: string | null;
  /** Which sources answered, so the UI can say what it is showing. */
  sources: string[];
}

/**
 * Solar indices from NOAA SWPC and prop.kc2g.com.
 *
 * Both free, neither needs a key. Fetched in parallel and independently, so one being
 * down does not cost the other's data.
 */
export async function fetchSolar(): Promise<SolarConditions | null> {
  const now = Date.now();
  if (solarCache && now - solarCache.at < SOLAR_TTL_MS) return solarCache.value;

  const out: SolarConditions = {
    sfi: null,
    ssn: null,
    kp: null,
    aIndex: null,
    observedAt: null,
    sources: [],
  };

  const [kp, essn] = await Promise.allSettled([
    fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", {
      signal: AbortSignal.timeout(20_000),
    }).then((r) => (r.ok ? (r.json() as Promise<unknown>) : null)),
    fetch("https://prop.kc2g.com/api/essn.json", {
      signal: AbortSignal.timeout(20_000),
    }).then((r) => (r.ok ? (r.json() as Promise<unknown>) : null)),
  ]);

  if (kp.status === "fulfilled" && Array.isArray(kp.value) && kp.value.length > 1) {
    // The newest reading is last; the first row is a header.
    const last = kp.value[kp.value.length - 1] as Record<string, unknown>;
    const k = Number(last.Kp);
    const a = Number(last.a_running);
    if (Number.isFinite(k)) out.kp = k;
    if (Number.isFinite(a)) out.aIndex = a;
    if (typeof last.time_tag === "string") out.observedAt = `${last.time_tag}Z`;
    out.sources.push("NOAA SWPC");
  }

  if (essn.status === "fulfilled" && essn.value) {
    const series = (essn.value as { "24h"?: { ssn?: number; sfi?: number }[] })["24h"];
    const last = Array.isArray(series) ? series[series.length - 1] : null;
    if (last) {
      if (Number.isFinite(Number(last.sfi))) out.sfi = Math.round(Number(last.sfi) * 10) / 10;
      if (Number.isFinite(Number(last.ssn))) out.ssn = Math.round(Number(last.ssn));
      out.sources.push("prop.kc2g.com");
    }
  }

  if (out.sources.length === 0) return solarCache?.value ?? null;
  solarCache = { at: Date.now(), value: out };
  return out;
}

/** A coarse day/night-aware usability estimate. */
export type Usability = "good" | "fair" | "poor" | "unknown";

/** Band centre frequencies, MHz, for the usability estimate. */
const BAND_MHZ: Record<string, number> = {
  "160M": 1.8,
  "80M": 3.5,
  "60M": 5.3,
  "40M": 7,
  "30M": 10.1,
  "20M": 14,
  "17M": 18,
  "15M": 21,
  "12M": 24.9,
  "10M": 28,
  "6M": 50,
};

/**
 * Estimate how usable a band is from solar flux and local time.
 *
 * DELIBERATELY NOT CALLED VOACAP. VOACAP is a specific engine with coefficient files
 * and a path model; this is a rule of thumb over solar flux and whether the sun is up.
 * It gets the broad shape right — high bands need flux and daylight, low bands work at
 * night, a disturbed ionosphere hurts everything — and it will be wrong about any
 * particular path.
 *
 * Where a real measurement exists — PSKReporter activity, or our own decodes — believe
 * that over this every time. It is here to fill in the bands nobody is watching.
 */
export function estimateUsability(
  band: string,
  solar: SolarConditions | null,
  atUtcHour: number,
  lonDeg: number,
): Usability {
  if (!solar || solar.sfi === null) return "unknown";
  const sfi = solar.sfi;
  const kp = solar.kp ?? 2;

  const mhz = BAND_MHZ[band.toUpperCase()];
  if (mhz === undefined) return "unknown";

  // Local solar hour from longitude, 15 degrees per hour. Only used to tell day from
  // night, which is all the accuracy this needs.
  const localHour = (((atUtcHour + lonDeg / 15) % 24) + 24) % 24;
  const day = localHour >= 7 && localHour <= 18;
  const stormed = kp >= 5;

  // Crude MUF proxy: rises with flux, far higher in daylight.
  const muf = day ? 6 + sfi * 0.22 : 4 + sfi * 0.07;

  if (stormed && mhz >= 21) return "poor";
  if (mhz <= 7) {
    // Low bands are absorption-limited by day and open at night.
    if (day) return mhz <= 3.5 ? "poor" : "fair";
    return stormed ? "fair" : "good";
  }
  if (mhz > muf * 1.15) return "poor";
  if (mhz > muf * 0.85) return "fair";
  return day ? "good" : "fair";
}

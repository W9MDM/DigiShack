// Reporting WSPR spots to wsprnet.org, the way WSPR and WSJT-X do.
//
// WHAT WSPRNET ACCEPTS. One HTTP request per spot, a GET of `/post` with the spot in the
// query string: the reporting station (`rcall`, `rgrid`), its dial frequency (`rqrg`, MHz),
// the date and time of the window (`date` YYMMDD, `time` HHMM), the measurements (`sig`
// in dB, `dt` in seconds, `drift` in Hz), the transmitting station (`tcall`, `tgrid`,
// `dbm`) and its frequency (`tqrg`, MHz to six places), a `version` naming the software,
// and `mode=2` for the two-minute mode. This is the format WSJT-X's WSPRNet.cpp sends;
// there is no documented API beyond what that program does, and this does the same.
//
// OFF BY DEFAULT. A spot names this station's callsign and grid on a public map, which is
// the point of the service and a thing to opt into, not a side effect of listening.
//
// FIRE AND FORGET, like PSKReporter and the UDP broadcast: a failed upload costs a log
// line, once a minute at most, and never a decode. wsprnet is sometimes slow and
// sometimes down; the decodes are already on the page.

import pkg from "@/package.json";

export const WSPRNET_POST_URL = "https://wsprnet.org/post";

export interface WsprSpotReport {
  /** The reporting station. */
  rcall: string;
  rgrid: string;
  /** The receiver's dial frequency, Hz. */
  dialHz: number;
  /** The window's start, UTC. */
  at: Date;
  /** What was decoded. */
  tcall: string;
  tgrid: string | null;
  dbm: number;
  snrDb: number;
  dtS: number;
  driftHz: number;
  /** The transmitter's frequency, Hz: dial plus the audio offset. */
  txHz: number;
}

/** The query string for one spot, as wsprnet expects it. Pure, so the format is assertable. */
export function wsprnetQuery(s: WsprSpotReport): URLSearchParams {
  const yy = String(s.at.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(s.at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(s.at.getUTCDate()).padStart(2, "0");
  const hh = String(s.at.getUTCHours()).padStart(2, "0");
  const mi = String(s.at.getUTCMinutes()).padStart(2, "0");
  return new URLSearchParams({
    function: "wspr",
    rcall: s.rcall,
    rgrid: s.rgrid,
    rqrg: (s.dialHz / 1e6).toFixed(6),
    date: `${yy}${mm}${dd}`,
    time: `${hh}${mi}`,
    sig: String(Math.round(s.snrDb)),
    dt: s.dtS.toFixed(1),
    drift: String(Math.trunc(s.driftHz)),
    tqrg: (s.txHz / 1e6).toFixed(6),
    tcall: s.tcall,
    tgrid: s.tgrid ?? "",
    dbm: String(s.dbm),
    version: `DigiShack ${pkg.version}`,
    mode: "2",
  });
}

/**
 * The station a decoded WSPR message names, for a spot. Three shapes, as wsprd prints
 * them: "K1ABC FN42 37", "PJ4/K1ABC 37" (no grid) and "<PJ4/K1ABC> FK52UD 37". A hash
 * nobody has resolved prints as "<...>" and is not a station to report.
 */
export function wsprSpotOf(message: string): { tcall: string; tgrid: string | null; dbm: number } | null {
  const t = message.trim().split(/\s+/);
  if (t.length < 2 || t.length > 3) return null;
  const dbm = Number(t[t.length - 1]);
  if (!Number.isInteger(dbm) || dbm < 0 || dbm > 60) return null;
  const tcall = t[0]!.replace(/^<|>$/g, "");
  if (!tcall || tcall === "...") return null;
  const tgrid = t.length === 3 ? t[1]! : null;
  return { tcall, tgrid, dbm };
}

let lastErrorAt = 0;

/**
 * Post spots, one request each, in order. Returns how many wsprnet accepted (HTTP 2xx).
 * Never throws; the first failure in a minute is logged, the rest are quiet.
 */
export async function postWsprSpots(
  spots: WsprSpotReport[],
  log: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  let accepted = 0;
  for (const s of spots) {
    try {
      const r = await fetch(`${WSPRNET_POST_URL}?${wsprnetQuery(s).toString()}`, {
        method: "GET",
        headers: { "user-agent": `DigiShack ${pkg.version}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        accepted++;
      } else if (Date.now() - lastErrorAt > 60_000) {
        lastErrorAt = Date.now();
        log(`[wsprnet] HTTP ${r.status} posting ${s.tcall} - will keep trying quietly`);
      }
    } catch (err) {
      if (Date.now() - lastErrorAt > 60_000) {
        lastErrorAt = Date.now();
        log(`[wsprnet] could not post ${s.tcall}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return accepted;
}

// Reading a DX cluster's "DX de" line.
//
// DX Spider, AR-Cluster, CC Cluster and the Reverse Beacon Network all send the same shape,
// inherited from the original PacketCluster:
//
//   DX de K2BBB:     14025.0  JA1ABC       up 2                           1234Z
//   DX de G4ABC:      7012.5  K1ABC        cq NA                          0712Z IO91
//   DX de DL1ABC-#:  14013.4  K0ABC          CW    23 dB  21 WPM  CQ      1925Z
//
// spotter, frequency in kHz, the spotted call, a free comment, the time as HHMMZ, and — on
// nodes configured for it — something about the SPOTTER after the time (DX Spider's
// SET/DXGRID puts their locator there; other nodes a US state or a zone). The columns are
// fixed-width on most nodes, but not all, and a long spotter call runs into the frequency
// ("VK2ABC-12-#:14025.0"), so this reads tokens rather than columns.
//
// Everything that is not a DX line — WWV and WCY propagation bulletins, "To ALL" announcements,
// talk, prompts, the login banner — returns null. Those are the node talking, not a spot.

import { freqToBand } from "@/lib/ham/bands";
import { GRID4_OR_6_ANY_CASE_RE as GRID } from "@/lib/ham/grid-geometry";

export interface SkimmerFields {
  mode: string;
  snrDb: number;
  speed: number | null;
  speedUnit: "WPM" | "BPS" | null;
  /** What the skimmer heard: CQ, DE, BEACON, NCDXF B. */
  kind: string;
}

export interface ParsedSpot {
  spotter: string;
  spotterRaw: string;
  skimmer: boolean;
  freqHz: number;
  dx: string;
  comment: string;
  /** HHMM from the line as minutes after midnight UTC; null when the line carries no time. */
  minuteOfDay: number | null;
  spotterGrid: string | null;
  skim: SkimmerFields | null;
}

/**
 * Control characters out, whitespace trimmed.
 *
 * Nodes ring the bell on a DX line (`…1234Z\x07\x07`) for users who asked for it, and a few
 * send a stray NUL or ESC. Tabs become spaces so the tokeniser sees them.
 */
export function cleanLine(raw: string): string {
  return raw
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

/**
 * Callsign-shaped: letters and digits, optional /portable parts, at least one of each.
 *
 * The digit is what refuses "CQ", "TEST" and "QRT", which turn up in the call column when
 * somebody types a spot by hand. Every issued callsign carries one.
 */
export function isCallsign(s: string): boolean {
  if (s.length < 3 || s.length > 20) return false;
  if (!/^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(s)) return false;
  return /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/** "KM3T-2-#" -> "KM3T". The SSID says which connection, not who. */
export function baseSpotter(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[-#]+$/, "")
    .replace(/-\d+$/, "")
    .replace(/[-#]+$/, "");
}

/** Maidenhead in its conventional case: field and square upper, subsquare lower. */
function normaliseGrid(g: string): string {
  return g.slice(0, 4).toUpperCase() + g.slice(4).toLowerCase();
}

/**
 * A skimmer's comment: `CW 23 dB 21 WPM CQ`, `RTTY 17 dB 45 BPS CQ`, `FT8 -12 dB CQ`.
 *
 * The RBN writes these in a fixed form, which is what makes the SNR and speed worth taking
 * out rather than leaving in a comment column.
 */
const SKIMMER_COMMENT =
  /^(CW|RTTY|PSK31|PSK63|PSK125|BPSK31|BPSK63|FT8|FT4|FT2|JS8|MSK144|Q65|FST4|SSB|USB|LSB|AM|FM)\s+(-?\d{1,3})\s*dB\b(?:\s+(\d{1,3})\s*(WPM|BPS)\b)?\s*(.*)$/i;

export function parseSkimmerComment(comment: string): SkimmerFields | null {
  const m = SKIMMER_COMMENT.exec(comment.trim());
  if (!m) return null;
  return {
    mode: m[1]!.toUpperCase(),
    snrDb: Number(m[2]),
    speed: m[3] !== undefined ? Number(m[3]) : null,
    speedUnit: m[4] !== undefined ? (m[4].toUpperCase() as "WPM" | "BPS") : null,
    kind: (m[5] ?? "").trim().toUpperCase(),
  };
}

const HEAD = /^DX\s+de\s+([A-Z0-9/\-#]+?)(?::\s*|\s+)(\d+(?:\.\d+)?)\s+(\S+)(?:\s+(.*))?$/i;
const TIME_TOKEN = /^([01]\d|2[0-3])([0-5]\d)Z$/i;

/**
 * kHz, as every node sends it — with one exception guarded.
 *
 * A hand-typed spot occasionally arrives in MHz ("14.025"). Read as kHz that is 14 kHz, which
 * is in no band; read as MHz it is 20 m. Only a reading that lands in no band is retried, so
 * 136.0 (2200 m, genuinely kHz) is left alone.
 */
function toHz(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const asKhz = Math.round(value * 1000);
  if (freqToBand(asKhz)) return asKhz;
  const asMhz = Math.round(value * 1_000_000);
  if (value < 1000 && freqToBand(asMhz)) return asMhz;
  // Out of band either way. Returned as kHz so the caller can count and drop it.
  return asKhz;
}

export function parseSpotLine(raw: string): ParsedSpot | null {
  let line = cleanLine(raw);
  if (!line) return null;

  // A prompt the node did not end with a newline, glued to the spot that followed it:
  // "K1ABC de GB7XYZ 19-Oct-2026 1234Z dxspider >DX de …". Only after a prompt's ">", so
  // an announcement that merely mentions "DX de" is not mistaken for one.
  const at = line.search(/DX\s+de\s/i);
  if (at > 0) {
    if (!/>\s*$/.test(line.slice(0, at))) return null;
    line = line.slice(at);
  } else if (at < 0) {
    return null;
  }

  const m = HEAD.exec(line);
  if (!m) return null;

  const spotterRaw = m[1]!.toUpperCase();
  const spotter = baseSpotter(spotterRaw);
  if (!isCallsign(spotter)) return null;

  const freqHz = toHz(Number(m[2]));
  if (freqHz === null) return null;

  const dx = m[3]!.toUpperCase();
  if (!isCallsign(dx)) return null;

  // The time is the LAST HHMMZ near the end: a comment can carry one of its own
  // ("QSX 1830Z later"), and what follows the real one is at most a few short tokens.
  const tokens = (m[4] ?? "").split(/\s+/).filter(Boolean);
  let timeIdx = -1;
  for (let i = tokens.length - 1; i >= Math.max(0, tokens.length - 4); i--) {
    if (TIME_TOKEN.test(tokens[i]!)) {
      timeIdx = i;
      break;
    }
  }

  let minuteOfDay: number | null = null;
  let commentTokens = tokens;
  let trailer: string[] = [];
  if (timeIdx >= 0) {
    const t = TIME_TOKEN.exec(tokens[timeIdx]!)!;
    minuteOfDay = Number(t[1]) * 60 + Number(t[2]);
    commentTokens = tokens.slice(0, timeIdx);
    trailer = tokens.slice(timeIdx + 1);
  }

  const grid = trailer.find((t) => GRID.test(t));
  const comment = commentTokens.join(" ");
  const skim = parseSkimmerComment(comment);

  return {
    spotter,
    spotterRaw,
    // "-#" is the RBN's own marker for a skimmer. The comment shape is the fallback for a
    // node that strips the suffix when it relays the spot.
    skimmer: /-#$/.test(spotterRaw) || (skim !== null && /^(CQ|DE|BEACON|NCDXF B|DX)?$/.test(skim.kind)),
    freqHz,
    dx,
    comment,
    minuteOfDay,
    spotterGrid: grid ? normaliseGrid(grid) : null,
    skim,
  };
}

/**
 * A spot's HHMMZ as an instant, from the moment it was received.
 *
 * The line carries no date. The same UTC day is right except across midnight: a spot timed
 * 2359Z that arrives at 0001Z belongs to yesterday. Anything more than half an hour in the
 * future is taken to be that case — clocks disagree by seconds or minutes, never by hours.
 */
export function spotTime(minuteOfDay: number | null, receivedAt: number): number {
  if (minuteOfDay === null) return receivedAt;
  const day = new Date(receivedAt);
  const candidate = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  );
  return candidate > receivedAt + 30 * 60_000 ? candidate - 86_400_000 : candidate;
}

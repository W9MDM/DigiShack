// JS8 - the message layer: what the 72 payload bits of a frame mean.
//
// Ported from JS8Call's varicode.cpp and decodedtext.cpp (GPL-3.0; DigiShack is GPL-3.0).
// The physical layer (js8.ts) carries 72 bits and a 3-bit transmission type per frame;
// this layer decides what the 72 bits are. Four shapes, told apart by their first bits:
//
//   000  heartbeat      a callsign (50 bits), a grid or nothing (15), and which of the
//                       eight HB or CQ strings (3). "KN4CRD: @HB HEARTBEAT EM73".
//   001  compound       the same frame with a callsign that does not fit the 28-bit
//                       standard form, sent before a directed frame that then says <....>.
//   010  compound       as above with a command in place of the grid.
//        directed
//   011  directed       from (28), to (28), a command (5), a number (6) and two portable
//                       flags: "KN4CRD: J1Y SNR -12". The command table is the protocol.
//   1xx  data           text: 1 then 0 then Huffman-coded characters, or 1 then 1 then
//                       words from a 262,144-entry dictionary ("JSC"), padded with 0111..
//
// The 72 bits travel as a 64-bit value and an 8-bit remainder through twelve six-bit
// characters of the frame alphabet (pack72bits). The 3-bit transmission type beside them
// marks the FIRST and LAST frames of a message (1 and 2, so a one-frame message is 3) and
// flags a fast-mode data frame (4). A receiver joins frames from the first to the last.
//
// Callsigns: a standard call packs into 28 bits the way FT8's did (37·36·10·27·27·27
// forms), with the group names @ALLCALL, @HB and the rest as reserved values past the
// end; a compound call or a group packs into 50 bits of an 11-character alphanumeric
// form. Grids: a 4-character locator as a 15-bit number of 2°×1° cells; 32767 means no
// grid; values above 32410 carry a command in a compound-directed frame.
//
// What this does NOT yet do: the JSC dictionary. Data frames whose second bit is 1 are
// words from JS8Call's 262,144-word table, and a sender picks whichever of Huffman and
// JSC fits more of the text, so most chat is JSC. Those frames unpack here as a marker
// until the table is carried; see js8-jsc.ts when it exists.

import { JS8_ALPHABET } from "@/lib/digital/js8";
import { GRID4_ANY_CASE_RE } from "@/lib/ham/grid-geometry";

export const JS8_TX_FIRST = 1;
export const JS8_TX_LAST = 2;
export const JS8_TX_DATA = 4;

export type Js8FrameKind = "heartbeat" | "compound" | "compound-directed" | "directed" | "data" | "unknown";

/** The payload alphabet's usable 64 characters. */
const ALPHABET72 = JS8_ALPHABET.slice(0, 64);
/** The callsign and grid alphabet: 39 characters, index is the value. */
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@";

/** The Huffman code for free text, from JS8Call's hufftable. Longest codes first when encoding. */
export const JS8_HUFFMAN: readonly (readonly [string, string])[] = [
  [" ", "01"], ["E", "100"], ["T", "1101"], ["A", "0011"], ["O", "11111"], ["I", "11100"],
  ["N", "10111"], ["S", "10100"], ["H", "00011"], ["R", "00000"], ["D", "111011"], ["L", "110011"],
  ["C", "110001"], ["U", "101101"], ["M", "101011"], ["W", "001011"], ["F", "001001"], ["G", "000101"],
  ["Y", "000011"], ["P", "1111011"], ["B", "1111001"], [".", "1110100"], ["V", "1100101"], ["K", "1100100"],
  ["-", "1100001"], ["+", "1100000"], ["?", "1011001"], ["!", "1011000"], ['"', "1010101"], ["X", "1010100"],
  ["0", "0010101"], ["J", "0010100"], ["1", "0010001"], ["Q", "0010000"], ["2", "0001001"], ["Z", "0001000"],
  ["3", "0000101"], ["5", "0000100"], ["4", "11110101"], ["9", "11110100"], ["8", "11110001"], ["6", "11110000"],
  ["7", "11101011"], ["/", "11101010"],
];

/** Directed commands, number by string, from directed_cmds. Strings carry their leading space. */
export const JS8_COMMANDS: readonly (readonly [string, number])[] = [
  [" HEARTBEAT", -1], [" HB", -1], [" CQ", -1],
  [" SNR?", 0], ["?", 0], [" DIT DIT", 1], [" NACK", 2], [" HEARING?", 3], [" GRID?", 4], [">", 5],
  [" STATUS?", 6], [" STATUS", 7], [" HEARING", 8], [" MSG", 9], [" MSG TO:", 10], [" QUERY", 11],
  [" QUERY MSGS", 12], [" QUERY MSGS?", 12], [" QUERY CALL", 13], [" ACK", 14], [" GRID", 15],
  [" INFO?", 16], [" INFO", 17], [" FB", 18], [" HW CPY?", 19], [" SK", 20], [" RR", 21], [" QSL?", 22],
  [" QSL", 23], [" CMD", 24], [" SNR", 25], [" NO", 26], [" YES", 27], [" 73", 28], [" HEARTBEAT SNR", 29],
  [" AGN?", 30], ["  ", 31], [" ", 31],
];
const SNR_COMMANDS = new Set([25, 29]);
export const JS8_AUTOREPLY_COMMANDS = new Set([0, 2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 16, 30]);
export const JS8_BUFFERED_COMMANDS = new Set([5, 9, 10, 11, 12, 13, 15, 24]);
export const JS8_CHECKSUM_COMMANDS: Readonly<Record<number, number>> = { 5: 16, 9: 16, 10: 16, 11: 16, 12: 16, 13: 16, 15: 0, 24: 16 };

/**
 * The command string for a number. The reference keeps its table in a QMap, sorted by key,
 * and QMap::key returns the first key with the value - so the lexicographically smallest
 * string: " SNR?" over "?", " QUERY MSGS" over " QUERY MSGS?", a single space over two.
 */
export function js8CommandString(num: number): string {
  const hits = JS8_COMMANDS.filter(([, n]) => n === num).map(([s]) => s).sort();
  return hits[0] ?? "";
}
export function js8CommandNumber(cmd: string): number | null {
  const hit = JS8_COMMANDS.find(([s]) => s === cmd);
  return hit ? hit[1] : null;
}

export const JS8_CQ_STRINGS = ["CQ CQ CQ", "CQ DX", "CQ QRP", "CQ CONTEST", "CQ FIELD", "CQ FD", "CQ CQ", "CQ"] as const;
/** All eight heartbeat variants print as HB; the number carries AUTO / RELAY / SPOT flags. */
export const JS8_HB_STRING = "HB";

const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
const NBASEGRID = 180 * 180;
const NUSERGRID = NBASEGRID + 10;
const NMAXGRID = (1 << 15) - 1;

/** Reserved callsign values: the incomplete-call placeholder and the groups. */
const BASECALL_NAMES: readonly (readonly [string, number])[] = [
  ["<....>", 1], ["@ALLCALL", 2], ["@JS8NET", 3], ["@DX/NA", 4], ["@DX/SA", 5], ["@DX/EU", 6], ["@DX/AS", 7],
  ["@DX/AF", 8], ["@DX/OC", 9], ["@DX/AN", 10], ["@REGION/1", 11], ["@REGION/2", 12], ["@REGION/3", 13],
  ["@GROUP/0", 14], ["@GROUP/1", 15], ["@GROUP/2", 16], ["@GROUP/3", 17], ["@GROUP/4", 18], ["@GROUP/5", 19],
  ["@GROUP/6", 20], ["@GROUP/7", 21], ["@GROUP/8", 22], ["@GROUP/9", 23], ["@COMMAND", 24], ["@CONTROL", 25],
  ["@NET", 26], ["@NTS", 27], ["@RESERVE/0", 28], ["@RESERVE/1", 29], ["@RESERVE/2", 30], ["@RESERVE/3", 31],
  ["@RESERVE/4", 32], ["@APRSIS", 33], ["@RAGCHEW", 34], ["@JS8", 35], ["@EMCOMM", 36], ["@ARES", 37],
  ["@MARS", 38], ["@AMRRON", 39], ["@RACES", 40], ["@RAYNET", 41], ["@RADAR", 42], ["@SKYWARN", 43],
  ["@CQ", 44], ["@HB", 45], ["@QSO", 46], ["@QSOPARTY", 47], ["@CONTEST", 48], ["@FIELDDAY", 49],
  ["@SOTA", 50], ["@IOTA", 51], ["@POTA", 52], ["@QRP", 53], ["@QRO", 54],
];
export const JS8_BASECALLS: readonly (readonly [string, number])[] = BASECALL_NAMES.map(([s, n]) => [s, NBASECALL + n] as const);

// ---------------------------------------------------------------------------
// 72 bits as twelve characters: a 64-bit value (as a BigInt) and an 8-bit remainder.
// ---------------------------------------------------------------------------

export function js8Pack72(value: bigint, rem: number): string {
  const out = new Array<string>(12);
  const remHigh = Number((value & 0xfn) << 2n) | (rem >> 6);
  const remLow = rem & 63;
  let v = value >> 4n;
  out[11] = ALPHABET72[remLow]!;
  out[10] = ALPHABET72[remHigh]!;
  for (let i = 0; i < 10; i++) {
    out[9 - i] = ALPHABET72[Number(v & 63n)]!;
    v >>= 6n;
  }
  return out.join("");
}

export function js8Unpack72(text: string): { value: bigint; rem: number } | null {
  if (text.length < 12) return null;
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    const idx = ALPHABET72.indexOf(text[i]!);
    if (idx < 0) return null;
    value |= BigInt(idx) << BigInt(58 - 6 * i);
  }
  const remHigh = ALPHABET72.indexOf(text[10]!);
  const remLow = ALPHABET72.indexOf(text[11]!);
  if (remHigh < 0 || remLow < 0) return null;
  value |= BigInt(remHigh >> 2);
  const rem = ((remHigh & 3) << 6) | remLow;
  return { value, rem };
}

/** The 72 bits of a frame as a bit array, value then remainder, most significant first. */
export function js8FrameBits(text: string): Uint8Array | null {
  const u = js8Unpack72(text);
  if (!u) return null;
  const bits = new Uint8Array(72);
  for (let i = 0; i < 64; i++) bits[i] = Number((u.value >> BigInt(63 - i)) & 1n);
  for (let i = 0; i < 8; i++) bits[64 + i] = (u.rem >> (7 - i)) & 1;
  return bits;
}

function bitsToBig(bits: ArrayLike<number>, start: number, n: number): bigint {
  let v = 0n;
  for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(bits[start + i]! & 1);
  return v;
}
function bitsToNum(bits: ArrayLike<number>, start: number, n: number): number {
  return Number(bitsToBig(bits, start, n));
}

// ---------------------------------------------------------------------------
// Callsigns and grids.
// ---------------------------------------------------------------------------

/** A standard callsign to 28 bits, or 0 when it will not pack. Sets `portable` for a /P suffix. */
export function js8PackCallsign(value: string): { packed: number; portable: boolean } {
  let callsign = value.toUpperCase().trim();
  const base = JS8_BASECALLS.find(([s]) => s === callsign);
  if (base) return { packed: base[1], portable: false };
  let portable = false;
  if (callsign.endsWith("/P")) {
    callsign = callsign.slice(0, -2);
    portable = true;
  }
  if (callsign.startsWith("3DA0")) callsign = "3D0" + callsign.slice(4);
  if (callsign.startsWith("3X") && callsign.length > 2 && callsign[2]! >= "A" && callsign[2]! <= "Z") callsign = "Q" + callsign.slice(2);
  const slen = callsign.length;
  if (slen < 2 || slen > 6) return { packed: 0, portable };
  const permutations = [callsign];
  if (slen === 2) permutations.push(" " + callsign + "   ");
  if (slen === 3) permutations.push(" " + callsign + "  ", callsign + "   ");
  if (slen === 4) permutations.push(" " + callsign + " ", callsign + "  ");
  if (slen === 5) permutations.push(" " + callsign, callsign + " ");
  const re = /([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])/;
  let matched = "";
  for (const p of permutations) {
    const m = re.exec(p);
    if (m) matched = m[0];
  }
  if (matched.length < 6) return { packed: 0, portable };
  let packed = ALPHANUMERIC.indexOf(matched[0]!);
  packed = 36 * packed + ALPHANUMERIC.indexOf(matched[1]!);
  packed = 10 * packed + ALPHANUMERIC.indexOf(matched[2]!);
  packed = 27 * packed + ALPHANUMERIC.indexOf(matched[3]!) - 10;
  packed = 27 * packed + ALPHANUMERIC.indexOf(matched[4]!) - 10;
  packed = 27 * packed + ALPHANUMERIC.indexOf(matched[5]!) - 10;
  return { packed, portable };
}

export function js8UnpackCallsign(value: number, portable: boolean): string {
  const base = JS8_BASECALLS.find(([, n]) => n === value);
  if (base) return base[0];
  const word = new Array<string>(6);
  let v = value;
  word[5] = ALPHANUMERIC[(v % 27) + 10]!;
  v = Math.floor(v / 27);
  word[4] = ALPHANUMERIC[(v % 27) + 10]!;
  v = Math.floor(v / 27);
  word[3] = ALPHANUMERIC[(v % 27) + 10]!;
  v = Math.floor(v / 27);
  word[2] = ALPHANUMERIC[v % 10]!;
  v = Math.floor(v / 10);
  word[1] = ALPHANUMERIC[v % 36]!;
  v = Math.floor(v / 36);
  word[0] = ALPHANUMERIC[v] ?? " ";
  let callsign = word.join("");
  if (callsign.startsWith("3D0")) callsign = "3DA0" + callsign.slice(3);
  if (callsign.startsWith("Q") && callsign.length > 1 && callsign[1]! >= "A" && callsign[1]! <= "Z") callsign = "3X" + callsign.slice(1);
  callsign = callsign.trim();
  return portable ? callsign + "/P" : callsign;
}

/** An 11-character alphanumeric (compound callsign or group) to 50 bits, as packAlphaNumeric50. */
export function js8PackAlphanumeric50(value: string): bigint {
  let word = value.toUpperCase().replace(/[^A-Z0-9 /@]/g, "");
  if (word.length > 3 && word[3] !== "/") word = word.slice(0, 3) + " " + word.slice(3);
  if (word.length > 7 && word[7] !== "/") word = word.slice(0, 7) + " " + word.slice(7);
  while (word.length < 11) word += " ";
  const ix = (i: number) => BigInt(ALPHANUMERIC.indexOf(word[i]!));
  const n38 = 38n;
  const a = n38 * n38 * n38 * 2n * n38 * n38 * n38 * 2n * n38 * n38 * ix(0);
  const b = n38 * n38 * n38 * 2n * n38 * n38 * n38 * 2n * n38 * ix(1);
  const c = n38 * n38 * n38 * 2n * n38 * n38 * n38 * 2n * ix(2);
  const d = n38 * n38 * n38 * 2n * n38 * n38 * n38 * (word[3] === "/" ? 1n : 0n);
  const e = n38 * n38 * n38 * 2n * n38 * n38 * ix(4);
  const f = n38 * n38 * n38 * 2n * n38 * ix(5);
  const g = n38 * n38 * n38 * 2n * ix(6);
  const h = n38 * n38 * n38 * (word[7] === "/" ? 1n : 0n);
  const i = n38 * n38 * ix(8);
  const j = n38 * ix(9);
  const k = ix(10);
  return a + b + c + d + e + f + g + h + i + j + k;
}

export function js8UnpackAlphanumeric50(packed: bigint): string {
  const word = new Array<string>(11);
  let v = packed;
  const take = (base: bigint) => {
    const t = Number(v % base);
    v /= base;
    return t;
  };
  word[10] = ALPHANUMERIC[take(38n)]!;
  word[9] = ALPHANUMERIC[take(38n)]!;
  word[8] = ALPHANUMERIC[take(38n)]!;
  word[7] = take(2n) ? "/" : " ";
  word[6] = ALPHANUMERIC[take(38n)]!;
  word[5] = ALPHANUMERIC[take(38n)]!;
  word[4] = ALPHANUMERIC[take(38n)]!;
  word[3] = take(2n) ? "/" : " ";
  word[2] = ALPHANUMERIC[take(38n)]!;
  word[1] = ALPHANUMERIC[take(38n)]!;
  word[0] = ALPHANUMERIC[take(39n)] ?? " ";
  return word.join("").replace(/ /g, "");
}

/** A 4-character grid to 15 bits of 2°x1° cells; 32767 when there is none. */
export function js8PackGrid(value: string): number {
  const grid = value.trim();
  if (grid.length < 4) return NMAXGRID;
  const { lon, lat } = js8GridToDeg(grid.slice(0, 4));
  // As the reference: int(lon), and int(lat + 90) - the 90 is added BEFORE truncation.
  const ilong = Math.trunc(lon);
  const ilat = Math.trunc(lat + 90);
  return Math.trunc((ilong + 180) / 2) * 180 + ilat;
}

export function js8UnpackGrid(value: number): string {
  if (value > NBASEGRID) return "";
  const dlat = (value % 180) - 90;
  const dlong = Math.trunc(value / 180) * 2 - 180 + 2;
  return js8DegToGrid(dlong, dlat).slice(0, 4);
}

/** grid2deg, as the reference computes it: the centre of the 6-character square. */
export function js8GridToDeg(grid: string): { lon: number; lat: number } {
  let g = grid.length < 6 ? grid.slice(0, 4) + "mm" : grid;
  g = g.slice(0, 4).toUpperCase() + g.slice(4, 6).toLowerCase();
  const nlong = 180 - 20 * (g.charCodeAt(0) - 65);
  const n20d = 2 * (g.charCodeAt(2) - 48);
  const xminlong = 5 * (g.charCodeAt(4) - 97 + 0.5);
  const lon = nlong - n20d - xminlong / 60;
  const nlat = -90 + 10 * (g.charCodeAt(1) - 65) + (g.charCodeAt(3) - 48);
  const xminlat = 2.5 * (g.charCodeAt(5) - 97 + 0.5);
  const lat = nlat + xminlat / 60;
  return { lon, lat };
}

/** deg2grid, as the reference computes it. Longitude positive WEST, as WSJT-X's convention. */
export function js8DegToGrid(dlong: number, dlat: number): string {
  let lon = dlong;
  if (lon < -180) lon += 360;
  if (lon > 180) lon -= 360;
  const nlong = Math.trunc((60 * (180 - lon)) / 5);
  let n1 = Math.trunc(nlong / 240);
  let n2 = Math.trunc((nlong - 240 * n1) / 24);
  let n3 = nlong - 240 * n1 - 24 * n2;
  const g = new Array<string>(6);
  g[0] = String.fromCharCode(65 + n1);
  g[2] = String.fromCharCode(48 + n2);
  g[4] = String.fromCharCode(97 + n3);
  const nlat = Math.trunc((60 * (dlat + 90)) / 2.5);
  n1 = Math.trunc(nlat / 240);
  n2 = Math.trunc((nlat - 240 * n1) / 24);
  n3 = nlat - 240 * n1 - 24 * n2;
  g[1] = String.fromCharCode(65 + n1);
  g[3] = String.fromCharCode(48 + n2);
  g[5] = String.fromCharCode(97 + n3);
  return g.join("");
}

/** A signed number -30..31 to its 6-bit field (value + 31); 0 means none. */
export function js8PackNum(num: string | number | null | undefined): number {
  if (num === null || num === undefined || num === "") return 0;
  const n = typeof num === "number" ? num : parseInt(num, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-30, Math.min(n, 31)) + 31;
}

/** A command and its number into the 7-bit field of a compound-directed frame. */
export function js8PackCmd(cmd: number, num: number): number {
  const str = js8CommandString(cmd);
  if (SNR_COMMANDS.has(cmd)) {
    return ((2 | (str === " HEARTBEAT SNR" ? 1 : 0)) << 6) + (num & 63);
  }
  return cmd & 127;
}
export function js8UnpackCmd(value: number): { cmd: number; num: number } {
  if (value & 128) return { cmd: value & 64 ? 29 : 25, num: value & 63 };
  return { cmd: value & 127, num: 0 };
}

export function js8FormatSnr(snr: number): string {
  if (snr < -60 || snr > 60) return "";
  const a = Math.abs(snr);
  return `${snr >= 0 ? "+" : "-"}${a < 10 ? "0" : ""}${a}`;
}

// ---------------------------------------------------------------------------
// Frames.
// ---------------------------------------------------------------------------

/** flag(3) + callsign(50) + num high 11 bits in the value; num low 5 bits and 3 extra bits in the remainder. */
export function js8PackCompoundFrame(callsign: string, type: 0 | 1 | 2, num: number, bits3: number): string | null {
  const packed = js8PackAlphanumeric50(callsign);
  if (packed === 0n) return null;
  const packed11 = (num >> 5) & 2047;
  const packed5 = num & 31;
  const rem = (packed5 << 3) | (bits3 & 7);
  const value = (BigInt(type) << 61n) | (packed << 11n) | BigInt(packed11);
  return js8Pack72(value, rem);
}

export interface Js8CompoundFrame {
  type: number;
  callsign: string;
  num: number;
  bits3: number;
}

export function js8UnpackCompoundFrame(text: string): Js8CompoundFrame | null {
  const bits = js8FrameBits(text);
  if (!bits) return null;
  const flag = bitsToNum(bits, 0, 3);
  if (flag === 3 || flag >= 4) return null;
  const packed = bitsToBig(bits, 3, 50);
  const packed11 = bitsToNum(bits, 53, 11);
  const rem = bitsToNum(bits, 64, 8);
  const num = (packed11 << 5) | (rem >> 3);
  return { type: flag, callsign: js8UnpackAlphanumeric50(packed), num, bits3: rem & 7 };
}

/** A heartbeat or CQ: "HB", "HEARTBEAT", or one of the CQ strings, with an optional grid. */
export function js8PackHeartbeat(callsign: string, kind: "HB" | (typeof JS8_CQ_STRINGS)[number], grid = ""): string | null {
  let extra = NMAXGRID;
  if (GRID4_ANY_CASE_RE.test(grid)) extra = js8PackGrid(grid);
  let bits3 = 0;
  if (kind !== "HB") {
    extra |= 1 << 15;
    bits3 = Math.max(0, JS8_CQ_STRINGS.indexOf(kind));
  }
  return js8PackCompoundFrame(callsign, 0, extra, bits3);
}

export interface Js8Directed {
  from: string;
  to: string;
  cmd: number;
  cmdString: string;
  num: number | null;
}

/** flag(3) + from(28) + to(28) + cmd(5) in the value; portable flags and the number in the remainder. */
export function js8PackDirected(from: string, to: string, cmd: number, num: string | number | null = null): string | null {
  const f = js8PackCallsign(from);
  const t = js8PackCallsign(to);
  if (f.packed === 0 || t.packed === 0) return null;
  const inum = js8PackNum(num);
  const rem = ((f.portable ? 1 : 0) << 7) | ((t.portable ? 1 : 0) << 6) | inum;
  const value = (3n << 61n) | (BigInt(f.packed) << 33n) | (BigInt(t.packed) << 5n) | BigInt(cmd & 31);
  return js8Pack72(value, rem);
}

export function js8UnpackDirected(text: string): Js8Directed | null {
  const bits = js8FrameBits(text);
  if (!bits) return null;
  if (bitsToNum(bits, 0, 3) !== 3) return null;
  const from = bitsToNum(bits, 3, 28);
  const to = bitsToNum(bits, 31, 28);
  const cmd = bitsToNum(bits, 59, 5);
  const rem = bitsToNum(bits, 64, 8);
  const extra = rem & 63;
  return {
    from: js8UnpackCallsign(from, ((rem >> 7) & 1) === 1),
    to: js8UnpackCallsign(to, ((rem >> 6) & 1) === 1),
    cmd,
    cmdString: js8CommandString(cmd),
    num: extra === 0 ? null : extra - 31,
  };
}

// ---------------------------------------------------------------------------
// Text: Huffman, as JS8Call's data frames carry it when the dictionary does no better.
// ---------------------------------------------------------------------------

const HUFF_BY_CODE = new Map(JS8_HUFFMAN.map(([ch, code]) => [code, ch] as const));
const HUFF_KEYS = JS8_HUFFMAN.map(([ch]) => ch).sort((a, b) => b.length - a.length || (a < b ? 1 : -1));

/** The characters the Huffman code can carry (upper case; anything else is dropped by the sender). */
export function js8HuffmanValid(ch: string): boolean {
  return JS8_HUFFMAN.some(([c]) => c === ch);
}

/** Text to Huffman bits, with how many characters each code took. Characters outside the table are skipped. */
export function js8HuffmanEncode(text: string): { bits: number[]; chars: number }[] {
  const out: { bits: number[]; chars: number }[] = [];
  let i = 0;
  while (i < text.length) {
    let found = false;
    for (const key of HUFF_KEYS) {
      if (text.startsWith(key, i)) {
        const code = JS8_HUFFMAN.find(([c]) => c === key)![1];
        out.push({ bits: code.split("").map(Number), chars: key.length });
        i += key.length;
        found = true;
        break;
      }
    }
    if (!found) i++;
  }
  return out;
}

export function js8HuffmanDecode(bits: ArrayLike<number>): string {
  let text = "";
  let s = Array.from(bits, (b) => (b ? "1" : "0")).join("");
  while (s.length > 0) {
    let found = false;
    for (const [code, ch] of HUFF_BY_CODE) {
      if (s.startsWith(code)) {
        text += ch;
        s = s.slice(code.length);
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  return text;
}

/**
 * A data frame of Huffman text: as many characters as fit after the two prefix bits (1 =
 * data, 0 = not compressed), padded with a 0 and then 1s. Returns the frame and how many
 * characters of the input it took.
 */
export function js8PackHuffmanFrame(text: string): { frame: string; chars: number } {
  const frameBits: number[] = [1, 0];
  let chars = 0;
  for (const piece of js8HuffmanEncode(text.toUpperCase())) {
    if (frameBits.length + piece.bits.length < 72) {
      frameBits.push(...piece.bits);
      chars += piece.chars;
      continue;
    }
    break;
  }
  const pad = 72 - frameBits.length;
  for (let i = 0; i < pad; i++) frameBits.push(i === 0 ? 0 : 1);
  const value = bitsToBig(frameBits, 0, 64);
  const rem = bitsToNum(frameBits, 64, 8);
  return { frame: js8Pack72(value, rem), chars };
}

export type Js8DataUnpack = { kind: "huffman"; text: string } | { kind: "jsc"; bits: Uint8Array };

/** A data frame's text, or its dictionary bits when it is a JSC frame. */
export function js8UnpackDataFrame(text: string): Js8DataUnpack | null {
  const bits = js8FrameBits(text);
  if (!bits || bits[0] !== 1) return null;
  const compressed = bits[1] === 1;
  // Strip the padding: everything after the last 0.
  let last = -1;
  for (let i = 2; i < 72; i++) if (bits[i] === 0) last = i;
  if (last < 2) return compressed ? { kind: "jsc", bits: new Uint8Array(0) } : { kind: "huffman", text: "" };
  const body = bits.subarray(2, last);
  if (compressed) return { kind: "jsc", bits: Uint8Array.from(body) };
  return { kind: "huffman", text: js8HuffmanDecode(body) };
}

// ---------------------------------------------------------------------------
// Reading a received frame, as DecodedText does: the shapes in the order it tries them.
// ---------------------------------------------------------------------------

export interface Js8ParsedFrame {
  kind: Js8FrameKind;
  /** What JS8Call would print for the frame. */
  display: string;
  /** The sending station, where the frame says. */
  from?: string;
  to?: string;
  grid?: string;
  cmdString?: string;
  num?: number | null;
  /** For a heartbeat or CQ frame: which. */
  isCq?: boolean;
  /** For a data frame: the text, or null when it needs the dictionary. */
  text?: string | null;
  first: boolean;
  last: boolean;
}

/**
 * The station a frame is from, for a decode row or a spot: the sender, unless the frame
 * came from a group (@ALLCALL, @HB) or names nobody (data). Never the station a directed
 * frame is TO - "N0GES: KQ4DNM HEARTBEAT SNR -18" is N0GES on the air, not KQ4DNM.
 */
export function js8StationOf(frame: Pick<Js8ParsedFrame, "from">): string | null {
  const from = frame.from?.trim();
  return from && !from.startsWith("@") ? from : null;
}

/** Interpret a frame's twelve characters and its 3-bit transmission type. */
export function js8ParseFrame(text: string, txType: number, jscDecode?: (bits: Uint8Array) => string | null): Js8ParsedFrame {
  const first = (txType & JS8_TX_FIRST) !== 0;
  const last = (txType & JS8_TX_LAST) !== 0;
  const isDataFlag = (txType & JS8_TX_DATA) === JS8_TX_DATA;
  const unknown: Js8ParsedFrame = { kind: "unknown", display: text, first, last };
  if (text.length < 12) return unknown;

  // Data, by the leading bit (a fast-mode data frame is flagged and raw; a normal one has the prefix).
  const data = js8UnpackDataFrame(text);
  if (data && !isDataFlag) {
    const t = data.kind === "huffman" ? data.text : jscDecode ? jscDecode(data.bits) : null;
    return { kind: "data", display: t ?? "<dictionary text>", text: t, first, last };
  }

  const compound = js8UnpackCompoundFrame(text);
  if (compound && compound.type === 0) {
    const isCq = (compound.num & (1 << 15)) !== 0;
    const grid = js8UnpackGrid(compound.num & 32767);
    const what = isCq ? `@ALLCALL ${JS8_CQ_STRINGS[compound.bits3 & 7] ?? "CQ"}` : "@HB HEARTBEAT";
    return {
      kind: "heartbeat",
      display: `${compound.callsign}: ${what}${grid ? " " + grid : ""}`,
      from: compound.callsign,
      grid: grid || undefined,
      isCq,
      first,
      last,
    };
  }
  if (compound && (compound.type === 1 || compound.type === 2)) {
    let extra = "";
    let cmdString: string | undefined;
    let num: number | null = null;
    if (compound.num <= NBASEGRID) {
      extra = js8UnpackGrid(compound.num);
    } else if (compound.num >= NUSERGRID && compound.num < NMAXGRID) {
      const c = js8UnpackCmd(compound.num - NUSERGRID);
      cmdString = js8CommandString(c.cmd);
      extra = cmdString;
      if (SNR_COMMANDS.has(c.cmd)) {
        num = c.num - 31;
        extra += " " + js8FormatSnr(num);
      }
    }
    return {
      kind: compound.type === 1 ? "compound" : "compound-directed",
      display: compound.type === 1 ? `${compound.callsign}: ${extra}` : `${compound.callsign}${extra}`,
      from: compound.callsign,
      grid: compound.type === 1 && extra ? extra : undefined,
      cmdString,
      num,
      first,
      last,
    };
  }

  const directed = js8UnpackDirected(text);
  if (directed) {
    const numStr = directed.num === null ? "" : SNR_COMMANDS.has(directed.cmd) ? " " + js8FormatSnr(directed.num) : ` ${directed.num}`;
    return {
      kind: "directed",
      display: `${directed.from}: ${directed.to}${directed.cmdString}${numStr}`,
      from: directed.from,
      to: directed.to,
      cmdString: directed.cmdString,
      num: directed.num,
      first,
      last,
    };
  }
  return unknown;
}

// ---------------------------------------------------------------------------
// Building frames to send, as buildMessageFrames does for the common cases.
// ---------------------------------------------------------------------------

export interface Js8OutFrame {
  frame: string;
  txType: number;
}

/**
 * A line of text to the frames that carry it: a heartbeat or CQ frame when it begins with
 * one; a directed frame when it begins with a callsign and a command; then Huffman data
 * frames for whatever is left. The first and last frames are flagged. Compound callsigns
 * and the dictionary are not used here yet, so a station with one cannot be addressed.
 */
export function js8BuildFrames(mycall: string, mygrid: string, line: string): Js8OutFrame[] {
  const frames: Js8OutFrame[] = [];
  let text = line.trim().toUpperCase();
  if (text.startsWith(mycall.toUpperCase() + ":")) text = text.slice(mycall.length + 1).trim();

  // Heartbeat / CQ at the start: "CQ CQ CQ EN61", "HB", "HEARTBEAT".
  const hb = /^(?:@(?:ALLCALL|HB)\s+)?(CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT)(?:\s([A-R]{2}[0-9]{2}))?\b/.exec(text);
  if (hb) {
    const kind = hb[1]!.startsWith("CQ") ? (hb[1] as (typeof JS8_CQ_STRINGS)[number]) : "HB";
    const grid = hb[2] ?? (kind === "HB" ? mygrid : mygrid);
    const frame = js8PackHeartbeat(mycall, kind, grid);
    if (frame) frames.push({ frame, txType: 0 });
    text = text.slice(hb[0].length).trim();
  } else {
    // Directed: "<CALL> <CMD>[ num]" with the command table's strings.
    const call = /^([@]?[A-Z0-9/]+)/.exec(text);
    if (call) {
      const rest = text.slice(call[1]!.length);
      let best: { cmd: number; str: string } | null = null;
      for (const [s, n] of JS8_COMMANDS) {
        if (n < 0 || s.trim() === "") continue;
        if (rest.startsWith(s) && (!best || s.length > best.str.length)) best = { cmd: n, str: s };
      }
      if (best && call[1] !== mycall.toUpperCase()) {
        const after = rest.slice(best.str.length);
        const numMatch = SNR_COMMANDS.has(best.cmd) || best.cmd === 0 ? /^\s?([-+]?\d{1,2})/.exec(after) : null;
        const frame = js8PackDirected(mycall, call[1]!, best.cmd, numMatch ? numMatch[1]! : null);
        if (frame) {
          frames.push({ frame, txType: 0 });
          text = after.slice(numMatch ? numMatch[0].length : 0).trim();
          // Free text after a non-buffered command goes as a data message in its own right.
        }
      } else if (call && call[1] !== mycall.toUpperCase() && rest.startsWith(" ") && !best) {
        // "CALL some text": the free-text command (31) carries the call, then data frames.
        const frame = js8PackDirected(mycall, call[1]!, 31, null);
        if (frame) {
          frames.push({ frame, txType: 0 });
          text = rest.trim();
        }
      }
    }
  }
  while (text.length > 0) {
    const { frame, chars } = js8PackHuffmanFrame(text);
    if (chars === 0) break;
    frames.push({ frame, txType: 0 });
    text = text.slice(chars);
  }
  if (frames.length > 0) {
    frames[0]!.txType |= JS8_TX_FIRST;
    frames[frames.length - 1]!.txType |= JS8_TX_LAST;
  }
  return frames;
}

/**
 * Joins frames from the first to the last into messages, per frequency, as a receiver must.
 * Feed frames in arrival order; a message is returned when its last frame arrives, or when
 * a new first frame interrupts an unfinished one on the same frequency.
 */
export class Js8MessageAssembler {
  private readonly open = new Map<number, { hz: number; parts: Js8ParsedFrame[]; at: number }>();
  private seq = 0;

  constructor(private readonly toleranceHz = 10) {}

  push(frame: Js8ParsedFrame, hz: number, at: number): { hz: number; parts: Js8ParsedFrame[]; text: string } | null {
    let key: number | null = null;
    for (const [k, v] of this.open) if (Math.abs(v.hz - hz) <= this.toleranceHz) key = k;
    let finished: { hz: number; parts: Js8ParsedFrame[]; text: string } | null = null;
    if (frame.first && key !== null) {
      const stale = this.open.get(key)!;
      this.open.delete(key);
      finished = { hz: stale.hz, parts: stale.parts, text: joinParts(stale.parts) };
      key = null;
    }
    if (key === null) {
      key = ++this.seq;
      this.open.set(key, { hz, parts: [], at });
    }
    const entry = this.open.get(key)!;
    entry.parts.push(frame);
    entry.at = at;
    if (frame.last) {
      this.open.delete(key);
      const done = { hz: entry.hz, parts: entry.parts, text: joinParts(entry.parts) };
      return finished ?? done;
    }
    return finished;
  }

  /** Messages that never got their last frame: everything older than `olderThanMs`. */
  expire(now: number, olderThanMs: number): { hz: number; parts: Js8ParsedFrame[]; text: string }[] {
    const out: { hz: number; parts: Js8ParsedFrame[]; text: string }[] = [];
    for (const [k, v] of this.open) {
      if (now - v.at > olderThanMs) {
        this.open.delete(k);
        out.push({ hz: v.hz, parts: v.parts, text: joinParts(v.parts) });
      }
    }
    return out;
  }
}

function joinParts(parts: Js8ParsedFrame[]): string {
  return parts
    .map((p) => (p.kind === "data" ? (p.text ?? "<dictionary text>") : p.display))
    .join("")
    .replace(/\s+$/, "");
}

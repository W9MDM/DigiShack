// WSPR — the codec and waveform, from the reference implementation.
//
// Ported from WSJT-X `lib/wsprd/` (GPL-3.0; DigiShack is GPL-3.0 — see LICENSE):
// `wsprsim_utils.c` (packing, encoding, interleaving), `wsprd_utils.c` (unpacking),
// `fano.c` (KA9Q's sequential decoder) and `nhash.c` (Bob Jenkins' lookup3, masked to
// 15 bits). Checked against the reference BINARIES built from those same sources on
// the live box: every packed-data and channel-symbol vector in scripts/check-wspr.ts
// was printed by `wsprsim -c -d`, not derived here.
//
// What WSPR is, as the code says it rather than as the folklore does:
//
//   * 50 bits of message: 28 for the callsign, 15 for the grid, 7 for the power (type 1).
//     Types 2 and 3 reuse the same 50 bits for a compound call or a six-character grid,
//     by hashing the callsign into 15 bits and sending the rest in a second transmission.
//   * A rate-1/2, K=32 convolutional code (the Layland-Lushbaugh polynomials) with 31
//     zero tail bits: 81 bits in, 162 out. Decoded with the Fano sequential algorithm,
//     which is why decoding has a cycle budget and can TIME OUT rather than fail cleanly.
//   * A bit-reversal interleave of the 162 coded bits.
//   * 4-FSK: channel symbol = 2 × coded bit + sync bit, the sync bit from a fixed
//     162-element pseudo-random vector the receiver correlates against to find the signal.
//   * 1.4648 baud (12000 / 8192), tone spacing equal to the baud, 110.6 s on the air,
//     beginning 1 s after an even UTC minute. Occupied bandwidth about 6 Hz, in a 200 Hz
//     window centred 1500 Hz above the dial frequency.
//
// Nothing here touches audio timing or the radio: that is the demodulator's and the
// pipeline's job, and the period and frequencies live where the scheduler can see them.

export const WSPR_SYMBOLS = 162;
export const WSPR_BITS = 81;
export const WSPR_SAMPLE_RATE = 12_000;
/** Samples per channel symbol at 12 kHz: 8192, giving 1.4648 baud. */
export const WSPR_SAMPLES_PER_SYMBOL = 8_192;
export const WSPR_BAUD = WSPR_SAMPLE_RATE / WSPR_SAMPLES_PER_SYMBOL;
/** Tone spacing equals the baud: 1.4648 Hz. */
export const WSPR_TONE_SPACING_HZ = WSPR_BAUD;
/** 162 × 8192 / 12000 = 110.592 s on the air. */
export const WSPR_TX_MS = (WSPR_SYMBOLS * WSPR_SAMPLES_PER_SYMBOL * 1000) / WSPR_SAMPLE_RATE;
/** The T/R period: two minutes, aligned to the even UTC minute. */
export const WSPR_PERIOD_MS = 120_000;
/** A transmission starts one second after the even minute. */
export const WSPR_TX_START_OFFSET_MS = 1_000;
/** Audio centre of the 200 Hz WSPR window above the dial frequency. */
export const WSPR_AUDIO_CENTER_HZ = 1_500;

/**
 * The sync vector, `pr3` in the reference. One bit per channel symbol; the symbol's
 * low bit on the air. The receiver's whole acquisition problem is finding this pattern.
 */
export const WSPR_SYNC: readonly number[] = [
  1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0,
  0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1,
  0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1,
  1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1,
  0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0,
  0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1,
  0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0,
  0, 0,
];

// ---------------------------------------------------------------------------
// Packing (wsprsim_utils.c)
// ---------------------------------------------------------------------------

/** The 37-symbol alphabet the callsign and grid fields are built from. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ";

function callsignCharCode(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c === 32) return 36;
  if (c >= 65 && c <= 90) return c - 55;
  return -1;
}

function locatorCharCode(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c === 32) return 36;
  if (c >= 65 && c <= 82) return c - 65;
  return -1;
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * A standard callsign as the 28-bit field: six characters with the digit in the third
 * place, a shorter call right-padded with spaces and a call with its digit second
 * shifted right by one. Null when it will not pack, where the reference packs garbage.
 */
export function packCallsign(callsign: string): number | null {
  if (callsign.length === 0 || callsign.length > 6) return null;
  const chars = new Array<string>(6).fill(" ");
  if (isDigit(callsign[2])) {
    for (let i = 0; i < callsign.length; i++) chars[i] = callsign[i]!;
  } else if (isDigit(callsign[1])) {
    if (callsign.length > 5) return null;
    for (let i = 0; i < callsign.length; i++) chars[i + 1] = callsign[i]!;
  } else {
    return null;
  }
  const codes = chars.map(callsignCharCode);
  if (codes.some((c) => c < 0)) return null;
  // Positions 4-6 are letters or space only: 27 values each, offset by 10.
  for (let i = 3; i < 6; i++) if (codes[i]! < 10) return null;
  let n = codes[0]!;
  n = n * 36 + codes[1]!;
  n = n * 10 + codes[2]!;
  n = n * 27 + codes[3]! - 10;
  n = n * 27 + codes[4]! - 10;
  n = n * 27 + codes[5]! - 10;
  return n;
}

/** The 15-bit grid plus 7-bit power field of a type 1 message. */
export function packGridAndPower(grid4: string, power: number): number | null {
  if (grid4.length !== 4) return null;
  const g = [...grid4].map(locatorCharCode);
  if (g.some((c) => c < 0)) return null;
  let m = (179 - 10 * g[0]! - g[2]!) * 180 + 10 * g[1]! + g[3]!;
  m = m * 128 + power + 64;
  return m;
}

/** Powers the format can carry: 0-60 dBm ending in 0, 3 or 7. */
export function isValidWsprPower(power: number): boolean {
  if (!Number.isInteger(power) || power < 0 || power > 60) return false;
  const nu = power % 10;
  return nu === 0 || nu === 3 || nu === 7;
}

/**
 * The reference's power snapping for types 2 and 3: any 0-60 rounds to the nearest
 * value the format can carry (`nu` in wsprsim_utils.c). Type 1 is not snapped there,
 * so a bad type 1 power is refused here rather than sent as something undecodable.
 */
const SNAP = [0, -1, 1, 0, -1, 2, 1, 0, -1, 1];
function snapPower(power: number): number {
  const p = Math.min(60, Math.max(0, Math.trunc(power)));
  return p + SNAP[p % 10]!;
}

/**
 * A compound callsign as the fields a type 2 message carries: `n` the packed base call,
 * `m` the prefix or suffix, `nadd` the flag that distinguishes the two encodings.
 */
export function packPrefix(callsign: string): { n: number; m: number; nadd: number } | null {
  const slash = callsign.indexOf("/");
  if (slash < 0) return null;
  const before = callsign.slice(0, slash);
  const after = callsign.slice(slash + 1);
  if (after.length === 1) {
    // Single-character suffix: K1ABC/P, K1ABC/7
    const n = packCallsign(before);
    if (n === null) return null;
    const c = after.charCodeAt(0);
    let m: number;
    if (c >= 48 && c <= 57) m = c - 48;
    else if (c >= 65 && c <= 90) m = c - 65 + 10;
    else m = 38;
    return { n, m: 60000 - 32768 + m, nadd: 1 };
  }
  if (after.length === 2) {
    // Two-digit suffix: K1ABC/10
    const n = packCallsign(before);
    if (n === null) return null;
    const m = 10 * (after.charCodeAt(0) - 48) + (after.charCodeAt(1) - 48);
    return { n, m: 60000 + 26 + m, nadd: 1 };
  }
  // A prefix: PJ4/K1ABC
  const n = packCallsign(after);
  if (n === null) return null;
  const plen = before.length;
  if (plen === 0 || plen > 3) return null;
  let m: number;
  if (plen === 1) m = 37 * 36 + 36;
  else if (plen === 2) m = 36;
  else m = 0;
  for (let i = 0; i < plen; i++) {
    const c = before.charCodeAt(i);
    let nc: number;
    if (c >= 48 && c <= 57) nc = c - 48;
    else if (c >= 65 && c <= 90) nc = c - 65 + 10;
    else nc = 36;
    m = 37 * m + nc;
  }
  let nadd = 0;
  if (m > 32768) {
    m -= 32768;
    nadd = 1;
  }
  return { n, m, nadd };
}

export type WsprMessageType = 1 | 2 | 3;

export interface WsprPacked {
  type: WsprMessageType;
  /** The 28-bit field. */
  n: number;
  /** The 22-bit field. */
  m: number;
  /** 50 message bits then 31 zero tail bits, high bit first, in 11 bytes. */
  data: Uint8Array;
}

/**
 * Pack a message. Three shapes, told apart as the reference tells them apart:
 *
 *   "K1ABC FN42 37"           type 1 — call, 4-character grid, dBm
 *   "PJ4/K1ABC 37"            type 2 — compound call, dBm; no grid
 *   "<PJ4/K1ABC> FK52UD 37"   type 3 — hashed call, 6-character grid, dBm
 *
 * A 4-character grid in a type 3 message is sent padded with two spaces, as the
 * reference expects it to be given.
 */
export function packWsprMessage(raw: string): WsprPacked | null {
  const message = raw.trim().toUpperCase();
  const parts = message.split(/\s+/);
  let n: number | null = null;
  let m: number | null = null;
  let type: WsprMessageType;

  if (message.startsWith("<")) {
    // Type 3
    const close = message.indexOf(">");
    if (close < 0) return null;
    const callsign = message.slice(1, close);
    const rest = message.slice(close + 1).trim().split(/\s+/);
    if (rest.length < 2 || callsign.length === 0) return null;
    let grid = rest[0]!;
    if (grid.length === 4) grid += "  ";
    if (grid.length !== 6) return null;
    const power = snapPower(Number(rest[1]));
    const ntype = -(power + 1);
    const ihash = nhash(callsign);
    m = 128 * ihash + ntype + 64;
    // The grid rides in the callsign field, rotated so its digit lands third.
    const rotated = grid.slice(1) + grid[0]!;
    n = packCallsign(rotated);
    type = 3;
  } else if (parts[0]!.includes("/")) {
    // Type 2
    if (parts.length < 2) return null;
    const packed = packPrefix(parts[0]!);
    if (!packed) return null;
    const power = snapPower(Number(parts[1]));
    const ntype = power + 1 + packed.nadd;
    m = 128 * packed.m + ntype + 64;
    n = packed.n;
    type = 2;
  } else {
    // Type 1
    if (parts.length < 3) return null;
    const call = parts[0]!;
    if (call.length < 3 || call.length > 6) return null;
    const power = Number(parts[2]);
    if (!isValidWsprPower(power)) return null;
    n = packCallsign(call);
    m = packGridAndPower(parts[1]!, power);
    type = 1;
  }
  if (n === null || m === null) return null;

  const data = new Uint8Array(11);
  data[0] = (n >>> 20) & 0xff;
  data[1] = (n >>> 12) & 0xff;
  data[2] = (n >>> 4) & 0xff;
  data[3] = ((n & 0x0f) << 4) | ((m >>> 18) & 0x0f);
  data[4] = (m >>> 10) & 0xff;
  data[5] = (m >>> 2) & 0xff;
  data[6] = (m & 0x03) << 6;
  return { type, n, m, data };
}

// ---------------------------------------------------------------------------
// The convolutional code (fano.c)
// ---------------------------------------------------------------------------

/** Layland-Lushbaugh K=32 rate-1/2 polynomials. */
const POLY1 = 0xf2d05351;
const POLY2 = 0xe4613c47;

function parity32(x: number): number {
  x ^= x >>> 16;
  x ^= x >>> 8;
  x ^= x >>> 4;
  x ^= x >>> 2;
  x ^= x >>> 1;
  return x & 1;
}

/** The two coded bits for an encoder state: POLY1's in the 2-bit, POLY2's in the 1-bit. */
export function convolve(encstate: number): number {
  return (parity32((encstate & POLY1) >>> 0) << 1) | parity32((encstate & POLY2) >>> 0);
}

/** 11 data bytes, high bit first, to 176 coded bits — the first 162 are used. */
export function encodeConvolutional(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length * 16);
  let encstate = 0;
  let k = 0;
  for (let b = 0; b < data.length; b++) {
    for (let i = 7; i >= 0; i--) {
      encstate = ((encstate << 1) | ((data[b]! >>> i) & 1)) >>> 0;
      const sym = convolve(encstate);
      out[k++] = sym >>> 1;
      out[k++] = sym & 1;
    }
  }
  return out;
}

/** Eight-bit reversal: what the reference's multiply-and-mask trick computes. */
function reverse8(i: number): number {
  let r = 0;
  for (let b = 0; b < 8; b++) r |= ((i >>> b) & 1) << (7 - b);
  return r;
}

/** The interleave: coded bit p goes to position bitreverse(i) for the i-th i whose reversal is < 162. */
export function interleave(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(WSPR_SYMBOLS);
  let p = 0;
  for (let i = 0; p < WSPR_SYMBOLS; i++) {
    const j = reverse8(i);
    if (j < WSPR_SYMBOLS) out[j] = bits[p++]!;
  }
  return out;
}

export function deinterleave(sym: Uint8Array): Uint8Array {
  const out = new Uint8Array(WSPR_SYMBOLS);
  let p = 0;
  for (let i = 0; p < WSPR_SYMBOLS; i++) {
    const j = reverse8(i);
    if (j < WSPR_SYMBOLS) out[p++] = sym[j]!;
  }
  return out;
}

/** The 162 channel symbols (0-3) for a message, or null when it will not pack. */
export function wsprChannelSymbols(message: string): Uint8Array | null {
  const packed = packWsprMessage(message);
  if (!packed) return null;
  return channelSymbolsFor(packed.data);
}

export function channelSymbolsFor(data: Uint8Array): Uint8Array {
  const coded = encodeConvolutional(data).subarray(0, WSPR_SYMBOLS);
  const inter = interleave(coded);
  const out = new Uint8Array(WSPR_SYMBOLS);
  for (let i = 0; i < WSPR_SYMBOLS; i++) out[i] = 2 * inter[i]! + WSPR_SYNC[i]!;
  return out;
}

// ---------------------------------------------------------------------------
// The Fano sequential decoder (fano.c, KA9Q)
// ---------------------------------------------------------------------------

export interface FanoResult {
  /** False when the cycle budget ran out: sequential decoding times out, it does not fail cleanly. */
  ok: boolean;
  /** 11 bytes: 50 message bits, the rest zero. */
  data: Uint8Array;
  metric: number;
  cycles: number;
}

/**
 * The integer branch metrics wsprd builds: round(10 × (table[i] − bias)), indexed by the
 * received symbol for a transmitted 1 and by 255 − symbol for a transmitted 0.
 */
export function wsprMetricTable(table: readonly number[], bias = 0.45): [Int32Array, Int32Array] {
  const m0 = new Int32Array(256);
  const m1 = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    m0[i] = Math.round(10 * (table[i]! - bias));
    m1[i] = Math.round(10 * (table[255 - i]! - bias));
  }
  return [m0, m1];
}

/**
 * Decode 162 soft symbols (0-255, 128 = no information) to 81 bits.
 *
 * A faithful port: the threshold `delta`, the per-bit cycle budget and the tail handling
 * are the reference's, because the decoder's sensitivity IS those numbers.
 */
export function fanoDecode(
  symbols: Uint8Array,
  mettab: [Int32Array, Int32Array],
  opts: { nbits?: number; delta?: number; maxCyclesPerBit?: number } = {},
): FanoResult {
  const nbits = opts.nbits ?? WSPR_BITS;
  const delta = opts.delta ?? 60;
  const maxcycles = (opts.maxCyclesPerBit ?? 10_000) * nbits;
  const lastnode = nbits - 1;
  const tail = nbits - 31;

  const enc = new Uint32Array(nbits + 1);
  const gamma = new Int32Array(nbits + 1);
  const metrics = new Int32Array(4 * nbits);
  const tm0 = new Int32Array(nbits + 1);
  const tm1 = new Int32Array(nbits + 1);
  const branch = new Uint8Array(nbits + 1);

  // Every possible branch metric for each symbol pair - the only look at the raw input.
  for (let np = 0; np <= lastnode; np++) {
    const s0 = symbols[2 * np]!;
    const s1 = symbols[2 * np + 1]!;
    metrics[4 * np] = mettab[0][s0]! + mettab[0][s1]!;
    metrics[4 * np + 1] = mettab[0][s0]! + mettab[1][s1]!;
    metrics[4 * np + 2] = mettab[1][s0]! + mettab[0][s1]!;
    metrics[4 * np + 3] = mettab[1][s0]! + mettab[1][s1]!;
  }

  let np = 0;
  enc[0] = 0;
  let lsym = convolve(enc[0]!);
  let m0 = metrics[lsym]!;
  // Both polynomials are odd, so the 1-branch's symbols are the complement of the 0-branch's.
  let m1 = metrics[3 ^ lsym]!;
  if (m0 > m1) {
    tm0[0] = m0;
    tm1[0] = m1;
  } else {
    tm0[0] = m1;
    tm1[0] = m0;
    enc[0] = 1;
  }
  branch[0] = 0;
  gamma[0] = 0;
  let t = 0;
  let i = 1;

  for (; i <= maxcycles; i++) {
    // Look forward.
    const ngamma = gamma[np]! + (branch[np] === 0 ? tm0[np]! : tm1[np]!);
    if (ngamma >= t) {
      if (gamma[np]! < t + delta) {
        // First visit: tighten the threshold.
        while (ngamma >= t + delta) t += delta;
      }
      gamma[np + 1] = ngamma;
      enc[np + 1] = (enc[np]! << 1) >>> 0;
      if (++np === lastnode + 1) break;
      lsym = convolve(enc[np]!);
      if (np >= tail) {
        // The tail is all zeroes: only the 0-branch exists.
        tm0[np] = metrics[4 * np + lsym]!;
      } else {
        m0 = metrics[4 * np + lsym]!;
        m1 = metrics[4 * np + (3 ^ lsym)]!;
        if (m0 > m1) {
          tm0[np] = m0;
          tm1[np] = m1;
        } else {
          tm0[np] = m1;
          tm1[np] = m0;
          enc[np] = (enc[np]! + 1) >>> 0;
        }
      }
      branch[np] = 0;
      continue;
    }
    // Threshold violated: look backward.
    for (;;) {
      if (np === 0 || gamma[np - 1]! < t) {
        // Cannot back up either: relax the threshold and try the better branch again.
        t -= delta;
        if (branch[np] !== 0) {
          branch[np] = 0;
          enc[np] = (enc[np]! ^ 1) >>> 0;
        }
        break;
      }
      // Back up.
      if (--np < tail && branch[np] !== 1) {
        branch[np] = 1;
        enc[np] = (enc[np]! ^ 1) >>> 0;
        break;
      }
    }
  }

  const data = new Uint8Array(11);
  const bytes = nbits >>> 3;
  for (let k = 0; k < bytes && k < 11; k++) data[k] = enc[7 + 8 * k]! & 0xff;
  return { ok: i < maxcycles, data, metric: gamma[np]!, cycles: i + 1 };
}

// ---------------------------------------------------------------------------
// Unpacking (wsprd_utils.c)
// ---------------------------------------------------------------------------

export function unpack50(data: Uint8Array): { n1: number; n2: number } {
  let n1 = (data[0]! & 255) << 20;
  n1 += (data[1]! & 255) << 12;
  n1 += (data[2]! & 255) << 4;
  n1 += (data[3]! >>> 4) & 15;
  let n2 = (data[3]! & 15) << 18;
  n2 += (data[4]! & 255) << 10;
  n2 += (data[5]! & 255) << 2;
  n2 += (data[6]! >>> 6) & 3;
  return { n1, n2 };
}

export function unpackCallsign(ncall: number): string | null {
  let n = ncall;
  if (n >= 262177560) return null;
  const tmp = new Array<string>(6);
  tmp[5] = ALPHABET[(n % 27) + 10]!;
  n = Math.floor(n / 27);
  tmp[4] = ALPHABET[(n % 27) + 10]!;
  n = Math.floor(n / 27);
  tmp[3] = ALPHABET[(n % 27) + 10]!;
  n = Math.floor(n / 27);
  tmp[2] = ALPHABET[n % 10]!;
  n = Math.floor(n / 10);
  tmp[1] = ALPHABET[n % 36]!;
  n = Math.floor(n / 36);
  tmp[0] = ALPHABET[n]!;
  return tmp.join("").replace(/^ +/, "").replace(/ +$/, "");
}

export function unpackGrid(ngrid: number): string | null {
  const g = ngrid >>> 7;
  if (g >= 32400) return null;
  const dlat = (g % 180) - 90;
  let dlong = Math.floor(g / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong += 360;
  const nlong = Math.trunc((60.0 * (180.0 - dlong)) / 5.0);
  let n1 = Math.trunc(nlong / 240);
  let n2 = Math.trunc((nlong - 240 * n1) / 24);
  const c0 = ALPHABET[10 + n1]!;
  const c2 = ALPHABET[n2]!;
  const nlat = Math.trunc((60.0 * (dlat + 90)) / 2.5);
  n1 = Math.trunc(nlat / 240);
  n2 = Math.trunc((nlat - 240 * n1) / 24);
  return c0 + ALPHABET[10 + n1]! + c2 + ALPHABET[n2]!;
}

export function unpackPrefix(nprefix: number, call: string): string | null {
  if (nprefix < 60000) {
    // A prefix of one to three characters.
    let n = nprefix;
    const pfx = ["", "", ""];
    for (let i = 2; i >= 0; i--) {
      const nc = n % 37;
      if (nc <= 9) pfx[i] = String.fromCharCode(nc + 48);
      else if (nc <= 35) pfx[i] = String.fromCharCode(nc + 55);
      else pfx[i] = " ";
      n = Math.floor(n / 37);
    }
    const joined = pfx.join("");
    const last = joined.lastIndexOf(" ");
    return (last >= 0 ? joined.slice(last + 1) : joined) + "/" + call;
  }
  // A suffix of one or two characters.
  const nc = nprefix - 60000;
  if (nc <= 9) return call + "/" + String.fromCharCode(nc + 48);
  if (nc <= 35) return call + "/" + String.fromCharCode(nc + 55);
  if (nc <= 125) {
    return call + "/" + String(Math.trunc((nc - 26) / 10)) + String((nc - 26) % 10);
  }
  return null;
}

/** What a station's hashed callsign resolves to, learned from its type 1 and 2 transmissions. */
export class WsprHashTable {
  private readonly calls = new Map<number, string>();
  private readonly grids = new Map<number, string>();
  learn(callsign: string, grid?: string): void {
    const h = nhash(callsign);
    this.calls.set(h, callsign);
    if (grid) this.grids.set(h, grid);
  }
  callFor(hash: number): string | undefined {
    return this.calls.get(hash);
  }
  gridFor(hash: number): string | undefined {
    return this.grids.get(hash);
  }
  get size(): number {
    return this.calls.size;
  }
}

export interface WsprMessage {
  type: WsprMessageType;
  /** As the reference prints it: "K1ABC FN42 37", "PJ4/K1ABC 37", "<PJ4/K1ABC> FK52UD 37". */
  text: string;
  /** The callsign, or "<...>" for a hash nobody has resolved yet. */
  callsign: string;
  /** Four or six characters, or null for a type 2 message, which carries none. */
  grid: string | null;
  /** dBm. */
  power: number;
}

/**
 * The 50 bits back to a message, or null for what the reference would not print:
 * a power the format cannot carry, a grid that is not a grid, the −64 type nobody has
 * explained. Learns callsigns for the hash table as it goes, exactly as the reference
 * does, so a type 3 message after its station's type 2 resolves.
 */
export function unpackWsprMessage(data: Uint8Array, hashes: WsprHashTable): WsprMessage | null {
  const { n1, n2 } = unpack50(data);
  let callsign = unpackCallsign(n1);
  if (callsign === null) return null;
  const grid = unpackGrid(n2);
  if (grid === null) return null;
  const ntype = (n2 & 127) - 64;

  if (ntype >= 0 && ntype <= 62) {
    const nu = ntype % 10;
    if (nu === 0 || nu === 3 || nu === 7) {
      // Type 1.
      hashes.learn(callsign, grid);
      return { type: 1, text: `${callsign} ${grid} ${ntype}`, callsign, grid, power: ntype };
    }
    // Type 2: the "power" carries the prefix/suffix flag.
    let nadd = nu;
    if (nu > 3) nadd = nu - 3;
    if (nu > 7) nadd = nu - 7;
    const n3 = Math.floor(n2 / 128) + 32768 * (nadd - 1);
    callsign = unpackPrefix(n3, callsign);
    if (callsign === null) return null;
    const power = ntype - nadd;
    if (!isValidWsprPower(power)) return null;
    hashes.learn(callsign);
    return { type: 2, text: `${callsign} ${power}`, callsign, grid: null, power };
  }

  if (ntype < 0) {
    // Type 3: the callsign field holds the grid, rotated; the hash names the station.
    const power = -(ntype + 1);
    const padded = callsign.padEnd(6, " ");
    const grid6 = (padded[5]! + padded.slice(0, 5)).replace(/ +$/, "");
    const nu = power % 10;
    if (
      (nu !== 0 && nu !== 3 && nu !== 7) ||
      !/^[A-Z]{2}[0-9]{2}/.test(grid6)
    ) {
      return null;
    }
    if (ntype === -64) return null;
    const ihash = (n2 - ntype - 64) / 128;
    const known = hashes.callFor(ihash);
    const shown = known ? `<${known}>` : "<...>";
    return { type: 3, text: `${shown} ${grid6} ${power}`, callsign: shown, grid: grid6, power };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The callsign hash (nhash.c: lookup3's hashlittle, masked to 15 bits)
// ---------------------------------------------------------------------------

function rot(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * The 15-bit hash a type 3 message carries in place of the callsign.
 *
 * The byte-at-a-time branch of hashlittle(), which on every machine gives the same
 * value as the aligned branches the C takes — that is what makes the hash portable, and
 * what makes a hash computed here match one computed by every other WSPR program.
 */
export function nhash(key: string, initval = 146): number {
  const bytes = new TextEncoder().encode(key);
  let length = bytes.length;
  let a = (0xdeadbeef + length + initval) >>> 0;
  let b = a;
  let c = a;
  let k = 0;

  const mix = () => {
    a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
  };
  const fin = () => {
    c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  };
  const at = (i: number) => bytes[k + i]!;

  while (length > 12) {
    a = (a + at(0) + (at(1) << 8) + (at(2) << 16) + (at(3) << 24)) >>> 0;
    b = (b + at(4) + (at(5) << 8) + (at(6) << 16) + (at(7) << 24)) >>> 0;
    c = (c + at(8) + (at(9) << 8) + (at(10) << 16) + (at(11) << 24)) >>> 0;
    mix();
    length -= 12;
    k += 12;
  }
  if (length === 0) return c & 32767;
  // The last block, every case falling through as in the reference.
  if (length >= 12) c = (c + (at(11) << 24)) >>> 0;
  if (length >= 11) c = (c + (at(10) << 16)) >>> 0;
  if (length >= 10) c = (c + (at(9) << 8)) >>> 0;
  if (length >= 9) c = (c + at(8)) >>> 0;
  if (length >= 8) b = (b + (at(7) << 24)) >>> 0;
  if (length >= 7) b = (b + (at(6) << 16)) >>> 0;
  if (length >= 6) b = (b + (at(5) << 8)) >>> 0;
  if (length >= 5) b = (b + at(4)) >>> 0;
  if (length >= 4) a = (a + (at(3) << 24)) >>> 0;
  if (length >= 3) a = (a + (at(2) << 16)) >>> 0;
  if (length >= 2) a = (a + (at(1) << 8)) >>> 0;
  if (length >= 1) a = (a + at(0)) >>> 0;
  fin();
  return c & 32767;
}

// ---------------------------------------------------------------------------
// The waveform
// ---------------------------------------------------------------------------

/**
 * The transmission as audio: continuous-phase 4-FSK, tone `sym` at f0 + (sym − 1.5) × baud,
 * no pulse shaping — WSPR has none. 162 × 8192 samples at 12 kHz, amplitude 1.
 */
export function wsprWaveform(
  symbols: Uint8Array,
  opts: { audioHz?: number; sampleRate?: number } = {},
): Float32Array {
  const fs = opts.sampleRate ?? WSPR_SAMPLE_RATE;
  const f0 = opts.audioHz ?? WSPR_AUDIO_CENTER_HZ;
  const spsym = Math.round((WSPR_SAMPLES_PER_SYMBOL * fs) / WSPR_SAMPLE_RATE);
  const out = new Float32Array(WSPR_SYMBOLS * spsym);
  let phi = 0;
  let k = 0;
  for (let i = 0; i < WSPR_SYMBOLS; i++) {
    const dphi = (2 * Math.PI * (f0 + (symbols[i]! - 1.5) * WSPR_TONE_SPACING_HZ)) / fs;
    for (let j = 0; j < spsym; j++) {
      out[k++] = Math.sin(phi);
      phi += dphi;
      if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    }
  }
  return out;
}

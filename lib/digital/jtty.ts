// JTTY: the WSJT project's keyboard mode for RTTY contesters (WSJT-X 3.2, announced
// 23 September 2026). Ported from lib/jtty in WSJT-X v3.3.0-beta2 - jtty_source_encoding.txt
// is the specification, and tbcc.f90, genjtty.f90, gen_jttywave.f90 and
// jtty_source_codec.f90 are the reference this follows line for line.
//
// The signal. A transmission is one or more frames sent back to back, each 1.888 s:
// 13 sync symbols then 46 data symbols of 4-GFSK at 31.25 baud, tones 31.25 Hz apart
// (h = 1), about 127 Hz wide. Not tied to UTC: a transmission starts whenever the
// operator sends.
//
// A frame. 34 source bits - 32 of message grammar, one reserved zero, and an
// end-of-message flag - plus a 12-bit CRC (polynomial 0x80F) make 46 bits, coded by a
// tail-biting rate-1/2 convolutional code (K = 10, generators 1167 and 1545 octal) into
// 92 bits, two per tone with a Gray mapping.
//
// The text. Each frame carries one "atom": a call action (CQ K1ABC CQ in one frame), a
// structured exchange field (599 123, 1D EMA, FN42), a control phrase (AGN?), or five
// characters of plain text. A message is a run of atoms, the last flagged.
//
// Licence: WSJT-X is GPL-3.0. The tables and algorithms here follow it.

import { chkcall, pack28, unpack28 } from "@/lib/digital/pack77";
import { isGrid4 } from "@/lib/ham/grid-geometry";

// --- The waveform's numbers -------------------------------------------------------

export const JTTY_BAUD = 31.25;
export const JTTY_SYNC_SYMBOLS = 13;
export const JTTY_DATA_SYMBOLS = 46;
export const JTTY_FRAME_SYMBOLS = JTTY_SYNC_SYMBOLS + JTTY_DATA_SYMBOLS;
/** 1.888 s. */
export const JTTY_FRAME_MS = (JTTY_FRAME_SYMBOLS / JTTY_BAUD) * 1000;
/** WSJT-X's default transmit and receive offset, Hz audio (the lowest tone). */
export const JTTY_DEFAULT_HZ = 1500;
/** The most frames a message may take: 80 characters of plain text. */
export const JTTY_MAX_FRAMES = 16;
/** The sync sequence: autocorrelation sidelobes 2/13 at most. jtty_fec_mod.f90. */
export const JTTY_SYNC: readonly number[] = [0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0];
/** GFSK bandwidth-time product, as the reference transmitter uses (transmit.f90). */
export const JTTY_BT = 2.0;

const PAYLOAD_BITS = 34;
const CRC_BITS = 12;
const INFO_BITS = PAYLOAD_BITS + CRC_BITS; // 46
const NU = 9;
const STATES = 1 << NU; // 512
const REGISTER_MASK = (1 << (NU + 1)) - 1;
const G0 = 0o1167;
const G1 = 0o1545;
const CRC_POLY = 0x80f;
/** 1-based: bit 33 is reserved zero, bit 34 is end of message. */
const RESERVED_BIT = 33;

function parity(v: number): number {
  let p = 0;
  for (let x = v; x > 0; x >>>= 1) p ^= x & 1;
  return p;
}

/** CRC-12 over bits, MSB first, register starting at zero: encode_crc12 in tbcc.f90. */
function crc12(bits: ArrayLike<number>, n: number): number {
  let reg = 0;
  for (let i = 0; i < n; i++) {
    reg ^= (bits[i]! & 1) << (CRC_BITS - 1);
    reg = reg & (1 << (CRC_BITS - 1)) ? ((reg << 1) ^ CRC_POLY) : reg << 1;
    reg &= (1 << CRC_BITS) - 1;
  }
  return reg;
}

/** 34 payload bits to 46 tones: CRC, then the tail-biting code, Gray-mapped. tbcc_encode. */
export function jttyEncodePayload(payload: ArrayLike<number>): number[] {
  if (payload.length !== PAYLOAD_BITS) throw new Error(`JTTY payload is ${PAYLOAD_BITS} bits`);
  const info = new Array<number>(INFO_BITS);
  for (let i = 0; i < PAYLOAD_BITS; i++) info[i] = payload[i]! & 1;
  const crc = crc12(info, PAYLOAD_BITS);
  for (let i = 0; i < CRC_BITS; i++) info[PAYLOAD_BITS + i] = (crc >> (CRC_BITS - 1 - i)) & 1;
  // Tail-biting: the register starts holding the frame's own last NU bits.
  let state = 0;
  for (let t = 0; t < NU; t++) state = ((state << 1) | info[INFO_BITS - NU + t]!) & (STATES - 1);
  const tones: number[] = [];
  for (let t = 0; t < INFO_BITS; t++) {
    const reg = ((state << 1) | info[t]!) & REGISTER_MASK;
    const b0 = parity(reg & G0);
    const b1 = parity(reg & G1);
    state = reg & (STATES - 1);
    tones.push(b0 === 0 ? (b1 === 0 ? 0 : 1) : b1 === 1 ? 2 : 3);
  }
  return tones;
}

/** The tone each trellis transition sends: [dropped bit][destination state]. build_incoming_tones. */
const INCOMING: [Int8Array, Int8Array] = (() => {
  const gray = [0, 1, 3, 2];
  const t: [Int8Array, Int8Array] = [new Int8Array(STATES), new Int8Array(STATES)];
  for (let s = 0; s < STATES; s++) {
    for (let d = 0; d < 2; d++) {
      const reg = s | (d << NU);
      t[d as 0 | 1][s] = gray[2 * parity(reg & G0) + parity(reg & G1)]!;
    }
  }
  return t;
})();

/**
 * Soft decision decode: the wrap-around Viterbi of tbcc_wava_fsk_decode. Two passes round
 * the circular trellis, a list of the best paths that end where they began, and the first
 * whose CRC checks with the reserved bit zero. `energies[t][tone]` is larger for likelier.
 * Returns the 34 payload bits, or null.
 */
export function jttyDecodeEnergies(energies: ArrayLike<ArrayLike<number>>, listSize = 32, passes = 2): number[] | null {
  let prev = new Float64Array(STATES);
  let curr = new Float64Array(STATES);
  const back = new Uint8Array(STATES * INFO_BITS);
  for (let pass = 0; pass < passes; pass++) {
    for (let t = 0; t < INFO_BITS; t++) {
      const e = energies[t]!;
      for (let s = 0; s < STATES; s++) {
        const p0 = s >> 1;
        const p1 = p0 | (1 << (NU - 1));
        const m0 = prev[p0]! + e[INCOMING[0][s]!]!;
        const m1 = prev[p1]! + e[INCOMING[1][s]!]!;
        if (m0 > m1) {
          curr[s] = m0;
          back[s * INFO_BITS + t] = 0;
        } else {
          curr[s] = m1;
          back[s * INFO_BITS + t] = 1;
        }
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
  }
  const final = prev;
  const list: { metric: number; bits: number[] }[] = [];
  const bits = new Array<number>(INFO_BITS);
  for (let s = 0; s < STATES; s++) {
    let cs = s;
    for (let t = INFO_BITS - 1; t >= 0; t--) {
      bits[t] = cs & 1;
      let ps = cs >> 1;
      if (back[cs * INFO_BITS + t] === 1) ps |= 1 << (NU - 1);
      cs = ps;
    }
    if (cs !== s) continue;
    const metric = final[s]!;
    if (list.length < listSize || metric > list[list.length - 1]!.metric) {
      list.push({ metric, bits: bits.slice() });
      list.sort((a, b) => b.metric - a.metric);
      if (list.length > listSize) list.pop();
    }
  }
  for (const c of list) {
    if (c.bits[RESERVED_BIT - 1] !== 0) continue;
    if (crc12(c.bits, INFO_BITS) !== 0) continue;
    const payload = c.bits.slice(0, PAYLOAD_BITS);
    // The all-zero grammar word is never sent: a sentinel, not a message.
    if (payload.slice(0, 32).every((b) => b === 0)) continue;
    return payload;
  }
  return null;
}

/** A frame's 59 tones: sync then data. genjtty_frames. */
export function jttyFrameTones(payload: ArrayLike<number>): number[] {
  return [...JTTY_SYNC, ...jttyEncodePayload(payload)];
}

// --- The source codec -------------------------------------------------------------

/** The 64-character alphabet of plain-text frames. */
export const JTTY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?!\"#$%,&*()_'=[]{}<>|:;";

export const JTTY_CONTROL_PHRASES: readonly string[] = [
  "AGN?", "CALL?", "AGN CALL", "NR?", "AGN NR", "EXCH?", "STATE?", "SECTION?", "ZONE?",
  "GRID?", "RPRT?", "QSL TU", "TU", "QRZ?", "QSO B4", "WAIT", "NIL?", "OK?",
];

/** ARRL and RAC sections, 1-based on the wire: PACK77_ARRL_SECTIONS in packjt77_grammar.f90. */
export const JTTY_ARRL_SECTIONS: readonly string[] = [
  "AB", "AK", "AL", "AR", "AZ", "BC", "CO", "CT", "DE", "EB", "EMA", "ENY", "EPA", "EWA", "GA", "GH",
  "IA", "ID", "IL", "IN", "KS", "KY", "LA", "LAX", "NS", "MB", "MDC", "ME", "MI", "MN", "MO", "MS",
  "MT", "NC", "ND", "NE", "NFL", "NH", "NL", "NLI", "NM", "NNJ", "NNY", "TER", "NTX", "NV", "OH", "OK",
  "ONE", "ONN", "ONS", "OR", "ORG", "PAC", "PR", "QC", "RI", "SB", "SC", "SCV", "SD", "SDG", "SF", "SFL",
  "SJV", "SK", "SNJ", "STX", "SV", "TN", "UT", "VA", "VI", "VT", "WCF", "WI", "WMA", "WNY", "WPA", "WTX",
  "WV", "WWA", "WY", "DX", "PE", "NB",
];

export type JttyAtom =
  /** action: 0 CQ X CQ, 1 X, 2 TU X CQ, 3 X TU, 4 X AGN?, 5 TU NOW X. */
  | { kind: "call"; action: number; call: string }
  /** kind: 0 serial, 1 CQ zone, 2 ITU zone, 3 age, 4 power, 5 check, 6 licence year, 7 generic. */
  | { kind: "num"; role: 0 | 1; numKind: number; value: number }
  /** kind: 0 state/province, 1 section, 2 country prefix, 3 generic QTH, 4 local admin code. */
  | { kind: "loc"; role: 0 | 1; locKind: number; token: string }
  | { kind: "zoneLoc"; zone: number; token: string }
  | { kind: "classSection"; count: number; cls: string; section: number }
  | { kind: "numTime"; role: 0 | 1; serial: number; minute: number }
  | { kind: "control"; phrase: number }
  | { kind: "grid"; role: 0 | 1; grid: string }
  | { kind: "text"; text: string };

const CALL_FORMS: readonly ((c: string) => string)[] = [
  (c) => `CQ ${c} CQ`,
  (c) => c,
  (c) => `TU ${c} CQ`,
  (c) => `${c} TU`,
  (c) => `${c} AGN?`,
  (c) => `TU NOW ${c}`,
];

/** A call JTTY can carry: a plain standard call that survives the 28-bit codec unchanged. standard_call. */
export function jttyStandardCall(call: string): boolean {
  const w = call.trim().toUpperCase();
  if (!w || w.includes("/") || w.startsWith("Q") || !/^[A-Z0-9]+$/.test(w)) return false;
  if (!chkcall(w).ok) return false;
  const back = unpack28(pack28(w));
  return back.ok && back.call.trim() === w;
}

function base36Value(token: string): number {
  let v = 0;
  for (const ch of token) v = v * 36 + (ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55);
  return v;
}

function base36Token(value: number, len: number): string {
  let s = "";
  let v = value;
  for (let i = 0; i < len; i++) {
    const d = v % 36;
    s = (d < 10 ? String.fromCharCode(48 + d) : String.fromCharCode(55 + d)) + s;
    v = Math.floor(v / 36);
  }
  return s;
}

/** A two- or three-character base-36 token as the wire allows: no leading zero on three. */
function validToken(token: string): boolean {
  if (!/^[0-9A-Z]{2,3}$/.test(token)) return false;
  return !(token.length === 3 && token[0] === "0");
}

function gridValue(grid: string): number | null {
  if (!isGrid4(grid)) return null;
  return ((grid.charCodeAt(0) - 65) * 18 + (grid.charCodeAt(1) - 65)) * 100 + Number(grid.slice(2));
}

function gridText(v: number): string {
  const f = Math.floor(v / 100);
  return String.fromCharCode(65 + Math.floor(f / 18), 65 + (f % 18)) + String(v % 100).padStart(2, "0");
}

function validNumber(kind: number, value: number): boolean {
  if (!Number.isInteger(value) || kind < 0 || kind > 7 || value < 0 || value > 131071) return false;
  if (kind === 1) return value >= 1 && value <= 40;
  if (kind === 2) return value >= 1 && value <= 90;
  if (kind === 6) return value <= 9999;
  return true;
}

function renderNumber(kind: number, value: number): string {
  if (kind === 0) return value < 1000 ? String(value).padStart(3, "0") : String(value);
  if (kind === 1 || kind === 2 || kind === 5) return value < 100 ? String(value).padStart(2, "0") : String(value);
  if (kind === 6) return String(value).padStart(4, "0");
  return String(value);
}

const role599 = (role: 0 | 1, field: string) => (role === 1 ? `599 ${field}` : field);

/** How an atom reads: render_jtty_atom. */
export function jttyRenderAtom(a: JttyAtom): string {
  switch (a.kind) {
    case "call":
      return CALL_FORMS[a.action]!(a.call);
    case "num":
      return role599(a.role, renderNumber(a.numKind, a.value));
    case "loc":
      return role599(a.role, a.token);
    case "zoneLoc":
      return `599 ${String(a.zone).padStart(2, "0")} ${a.token}`;
    case "classSection":
      return `${a.count}${a.cls} ${JTTY_ARRL_SECTIONS[a.section - 1]}`;
    case "numTime":
      return role599(a.role, `${renderNumber(0, a.serial)} ${String(Math.floor(a.minute / 60)).padStart(2, "0")}${String(a.minute % 60).padStart(2, "0")}`);
    case "control":
      return JTTY_CONTROL_PHRASES[a.phrase]!;
    case "grid":
      return role599(a.role, a.grid);
    case "text":
      return a.text;
  }
}

function toBits(value: bigint, n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(Number((value >> BigInt(i)) & 1n));
  return out;
}

function fromBits(bits: ArrayLike<number>, from: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 2 + (bits[from + i]! & 1);
  return v;
}

/** An atom to its 34 bits, or null when the atom is not valid on the wire. pack_jtty_atom. */
export function jttyPackAtom(a: JttyAtom, eom: boolean): number[] | null {
  let n32: bigint;
  const struct = (body: number, family: number) => ((BigInt(body) << 3n) | BigInt(family)) * 4n + 2n;
  switch (a.kind) {
    case "call": {
      if (a.action < 0 || a.action > 5 || !jttyStandardCall(a.call)) return null;
      const n28 = pack28(a.call.trim().toUpperCase());
      const i2 = a.action < 4 ? 0 : 1;
      const n2 = a.action < 4 ? a.action : a.action - 4;
      n32 = (BigInt(n28) << 4n) | BigInt(n2 << 2) | BigInt(i2);
      break;
    }
    case "num":
      if (!validNumber(a.numKind, a.value)) return null;
      n32 = struct((a.role << 26) | (a.numKind << 22) | (a.value << 5), 0);
      break;
    case "loc": {
      if (a.locKind < 0 || a.locKind > 4 || !validToken(a.token)) return null;
      const len = a.token.length === 3 ? 1 : 0;
      n32 = struct((a.role << 26) | (a.locKind << 22) | (len << 21) | (base36Value(a.token) << 5), 1);
      break;
    }
    case "zoneLoc": {
      if (a.zone < 1 || a.zone > 40 || !validToken(a.token)) return null;
      const len = a.token.length === 3 ? 1 : 0;
      const pair = (a.zone << 17) | (len << 16) | base36Value(a.token);
      n32 = struct((0 << 24) | (pair << 1), 2);
      break;
    }
    case "classSection": {
      const cls = a.cls.charCodeAt(0) - 65;
      if (a.count < 1 || a.count > 32 || cls < 0 || cls > 5 || a.section < 1 || a.section > JTTY_ARRL_SECTIONS.length) return null;
      const pair = (a.count << 17) | (cls << 14) | (a.section << 7);
      n32 = struct((1 << 24) | (pair << 1), 2);
      break;
    }
    case "numTime":
      if (a.serial < 0 || a.serial > 16383 || a.minute < 0 || a.minute > 1439) return null;
      n32 = struct((a.role << 26) | (a.serial << 12) | (a.minute << 1), 3);
      break;
    case "control":
      if (a.phrase < 0 || a.phrase >= JTTY_CONTROL_PHRASES.length) return null;
      n32 = struct((0 << 23) | (a.phrase << 16), 4);
      break;
    case "grid": {
      const g = gridValue(a.grid);
      if (g === null) return null;
      n32 = struct((1 << 23) | (a.role << 22) | (g << 7), 4);
      break;
    }
    case "text": {
      if (a.text.length > 5) return null;
      let top30 = 0n;
      for (const ch of a.text.padEnd(5, " ")) {
        const i = JTTY_ALPHABET.indexOf(ch);
        if (i < 0) return null;
        top30 = (top30 << 6n) | BigInt(i);
      }
      n32 = top30 * 4n + 3n;
      break;
    }
  }
  if (n32 === 0n) return null;
  return [...toBits(n32, 32), 0, eom ? 1 : 0];
}

/** 34 bits to an atom and its end-of-message flag, or null when not a valid source word. unpack_jtty_atom. */
export function jttyUnpackAtom(bits: ArrayLike<number>): { atom: JttyAtom; eom: boolean } | null {
  if (bits.length !== PAYLOAD_BITS || bits[32] !== 0) return null;
  let any = false;
  for (let i = 0; i < 32; i++) if (bits[i]) any = true;
  if (!any) return null;
  const eom = bits[33] === 1;
  const i2 = fromBits(bits, 30, 2);
  if (i2 === 0 || i2 === 1) {
    const n28 = fromBits(bits, 0, 28);
    const n2 = fromBits(bits, 28, 2);
    if (i2 === 1 && n2 > 1) return null;
    const u = unpack28(n28);
    const call = u.call.trim();
    if (!u.ok || !jttyStandardCall(call)) return null;
    return { atom: { kind: "call", action: i2 === 0 ? n2 : n2 + 4, call }, eom };
  }
  if (i2 === 3) {
    let text = "";
    for (let i = 0; i < 5; i++) text += JTTY_ALPHABET[fromBits(bits, i * 6, 6)];
    return { atom: { kind: "text", text }, eom };
  }
  // STRUCT30: body27 (bits 1-27), family3 (28-30).
  const family = fromBits(bits, 27, 3);
  const f = (from: number, n: number) => fromBits(bits, from - 1, n); // 1-based bit positions
  switch (family) {
    case 0: {
      const role = f(1, 1) as 0 | 1;
      const numKind = f(2, 4);
      const value = f(6, 17);
      if (f(23, 5) !== 0 || !validNumber(numKind, value)) return null;
      return { atom: { kind: "num", role, numKind, value }, eom };
    }
    case 1: {
      const role = f(1, 1) as 0 | 1;
      const locKind = f(2, 4);
      const len = f(6, 1) + 2;
      const v = f(7, 16);
      if (f(23, 5) !== 0 || locKind > 4 || v >= 36 ** len || (len === 3 && v < 36 * 36)) return null;
      return { atom: { kind: "loc", role, locKind, token: base36Token(v, len) }, eom };
    }
    case 2: {
      const schema = f(1, 3);
      if (f(27, 1) !== 0) return null;
      if (schema === 0) {
        const zone = f(4, 6);
        const len = f(10, 1) + 2;
        const v = f(11, 16);
        if (zone < 1 || zone > 40 || v >= 36 ** len || (len === 3 && v < 36 * 36)) return null;
        return { atom: { kind: "zoneLoc", zone, token: base36Token(v, len) }, eom };
      }
      if (schema === 1) {
        const count = f(4, 6);
        const cls = f(10, 3);
        const section = f(13, 7);
        if (f(20, 7) !== 0 || count < 1 || count > 32 || cls > 5 || section < 1 || section > JTTY_ARRL_SECTIONS.length) return null;
        return { atom: { kind: "classSection", count, cls: String.fromCharCode(65 + cls), section }, eom };
      }
      return null;
    }
    case 3: {
      const role = f(1, 1) as 0 | 1;
      const serial = f(2, 14);
      const minute = f(16, 11);
      if (f(27, 1) !== 0 || minute > 1439) return null;
      return { atom: { kind: "numTime", role, serial, minute }, eom };
    }
    case 4: {
      const sub = f(1, 4);
      if (sub === 0) {
        const phrase = f(5, 7);
        if (f(12, 16) !== 0 || phrase >= JTTY_CONTROL_PHRASES.length) return null;
        return { atom: { kind: "control", phrase }, eom };
      }
      if (sub === 1) {
        const role = f(5, 1) as 0 | 1;
        const g = f(6, 15);
        if (f(21, 7) !== 0 || g >= 32400) return null;
        return { atom: { kind: "grid", role, grid: gridText(g) }, eom };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Atoms to the displayed message: a structured atom and one space, plain text verbatim,
 * trailing spaces and padding dropped, 80 characters at most.
 */
export function jttyJoinAtoms(atoms: readonly JttyAtom[]): string {
  let s = "";
  for (const a of atoms) s += a.kind === "text" ? a.text : `${jttyRenderAtom(a)} `;
  return s.trimEnd().slice(0, 80);
}

/** Ordinary text as JTTY carries it: capitals, single spaces, anything else as '#'. */
export function jttyNormalize(text: string): string {
  const up = text.slice(0, 80).toUpperCase().replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of up) out += JTTY_ALPHABET.includes(ch) ? ch : "#";
  return out;
}

/** Structured atoms that read exactly as `span`, in the order the encoder prefers them. */
function candidatesFor(span: string): JttyAtom[] {
  const out: JttyAtom[] = [];
  const w = span.split(" ");
  // Call actions.
  const call = (c: string) => jttyStandardCall(c);
  if (w.length === 3 && w[0] === "CQ" && w[2] === "CQ" && call(w[1]!)) out.push({ kind: "call", action: 0, call: w[1]! });
  if (w.length === 1 && call(w[0]!)) out.push({ kind: "call", action: 1, call: w[0]! });
  if (w.length === 3 && w[0] === "TU" && w[2] === "CQ" && call(w[1]!)) out.push({ kind: "call", action: 2, call: w[1]! });
  if (w.length === 2 && w[1] === "TU" && call(w[0]!)) out.push({ kind: "call", action: 3, call: w[0]! });
  if (w.length === 2 && w[1] === "AGN?" && call(w[0]!)) out.push({ kind: "call", action: 4, call: w[0]! });
  if (w.length === 3 && w[0] === "TU" && w[1] === "NOW" && call(w[2]!)) out.push({ kind: "call", action: 5, call: w[2]! });
  // Control phrases.
  const phrase = JTTY_CONTROL_PHRASES.indexOf(span);
  if (phrase >= 0) out.push({ kind: "control", phrase });
  // Numbers, field-only or after 599: canonical decimal.
  const num = (t: string) => /^(0|[1-9][0-9]{0,5})$/.test(t) && Number(t) <= 131071;
  if (w.length === 1 && num(w[0]!)) out.push({ kind: "num", role: 0, numKind: 7, value: Number(w[0]) });
  if (w.length === 2 && w[0] === "599" && num(w[1]!)) out.push({ kind: "num", role: 1, numKind: 7, value: Number(w[1]) });
  // 599 and a QTH token with a letter in it.
  if (w.length === 2 && w[0] === "599" && validToken(w[1]!) && /[A-Z]/.test(w[1]!)) out.push({ kind: "loc", role: 1, locKind: 3, token: w[1]! });
  // Grids.
  if (w.length === 1 && gridValue(w[0]!) !== null) out.push({ kind: "grid", role: 0, grid: w[0]! });
  if (w.length === 2 && w[0] === "599" && gridValue(w[1]!) !== null) out.push({ kind: "grid", role: 1, grid: w[1]! });
  // Field Day class and section.
  const cs = w.length === 2 ? /^([1-9]|[12][0-9]|3[0-2])([A-F])$/.exec(w[0]!) : null;
  if (cs) {
    const section = JTTY_ARRL_SECTIONS.indexOf(w[1]!) + 1;
    if (section > 0) out.push({ kind: "classSection", count: Number(cs[1]), cls: cs[2]!, section });
  }
  // Each must survive the codec and read back exactly.
  return out.filter((a) => {
    const bits = jttyPackAtom(a, false);
    const back = bits && jttyUnpackAtom(bits);
    return back !== null && jttyRenderAtom(back.atom) === span;
  });
}

/**
 * Text to atoms, fewest frames first: the dynamic program of the specification over
 * character offsets. A structured atom starts at a word, reads exactly as its words, and
 * takes the space after it when another word follows; plain text takes five characters,
 * and only the last may be short. Null for an empty line.
 */
export function jttyPackText(raw: string): JttyAtom[] | null {
  const text = jttyNormalize(raw);
  const n = text.length;
  if (n === 0) return null;
  const best: ({ cost: number; atom: JttyAtom; next: number } | null)[] = new Array(n + 1).fill(null);
  best[n] = { cost: 0, atom: { kind: "text", text: "" }, next: n };
  for (let p = n - 1; p >= 0; p--) {
    let choice: { cost: number; atom: JttyAtom; next: number; structured: boolean; span: number } | null = null;
    const consider = (atom: JttyAtom, next: number, structured: boolean) => {
      const after = best[next];
      if (!after) return;
      const cost = after.cost + 1;
      const span = next - p;
      if (
        !choice ||
        cost < choice.cost ||
        (cost === choice.cost && structured && !choice.structured) ||
        (cost === choice.cost && structured === choice.structured && span > choice.span)
      ) {
        choice = { cost, atom, next, structured, span };
      }
    };
    // Structured atoms start at a word.
    if (text[p] !== " " && (p === 0 || text[p - 1] === " ")) {
      for (let end = p + 1; end <= n; end++) {
        if (end < n && text[end] !== " ") continue;
        const span = text.slice(p, end);
        if (span.split(" ").length > 3) break;
        for (const atom of candidatesFor(span)) consider(atom, end === n ? n : end + 1, true);
      }
    }
    // Plain text: five characters, or the rest if that is fewer.
    const take = Math.min(5, n - p);
    if (take === 5 || p + take === n) consider({ kind: "text", text: text.slice(p, p + take) }, p + take, false);
    best[p] = choice;
  }
  const atoms: JttyAtom[] = [];
  for (let p = 0; p < n; ) {
    const b = best[p];
    if (!b) return null;
    atoms.push(b.atom);
    p = b.next;
  }
  return atoms;
}

/** A line of text to its frames' payloads, the last flagged end of message. */
export function jttyPayloads(text: string): number[][] {
  const atoms = jttyPackText(text);
  if (!atoms) return [];
  return atoms.map((a, i) => {
    const bits = jttyPackAtom(a, i === atoms.length - 1);
    if (!bits) throw new Error(`JTTY could not pack ${jttyRenderAtom(a)}`);
    return bits;
  });
}

export function jttyDurationMs(text: string): number {
  return jttyPayloads(text).length * JTTY_FRAME_MS;
}

// --- The waveform -------------------------------------------------------------------

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

function gfskPulse(bt: number, t: number): number {
  const c = Math.PI * Math.sqrt(2 / Math.LN2);
  return 0.5 * (erf(c * bt * (t + 0.5)) - erf(c * bt * (t - 0.5)));
}

export interface JttyWaveformOptions {
  sampleRate: number;
  /** The lowest tone, Hz audio. WSJT-X's "Tx frequency". Default 1500. */
  baseHz?: number;
  amplitude?: number;
}

/**
 * Tones to audio: Gaussian-smoothed frequency pulses three symbols long, h = 1, the first
 * and last symbols extended, and a raised-cosine ramp an eighth of a symbol at each end.
 * gen_jttywave.f90, at any sample rate that is a whole number of samples per symbol.
 */
export function jttyToneWaveform(tones: readonly number[], opts: JttyWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const nsps = fs / JTTY_BAUD;
  if (!Number.isInteger(nsps)) throw new Error(`JTTY needs a whole number of samples per symbol; ${fs} Hz gives ${nsps}`);
  const f0 = opts.baseHz ?? JTTY_DEFAULT_HZ;
  const amp = opts.amplitude ?? 1;
  const nsym = tones.length;
  const pulse = new Float64Array(3 * nsps);
  for (let i = 0; i < 3 * nsps; i++) pulse[i] = gfskPulse(JTTY_BT, (i + 1 - 1.5 * nsps) / nsps);
  const dphi = new Float64Array((nsym + 2) * nsps);
  const peak = (2 * Math.PI) / nsps;
  for (let j = 0; j < nsym; j++) {
    const ib = j * nsps;
    for (let k = 0; k < 3 * nsps; k++) dphi[ib + k] = dphi[ib + k]! + peak * pulse[k]! * tones[j]!;
  }
  for (let k = 0; k < 2 * nsps; k++) dphi[k] = dphi[k]! + peak * tones[0]! * pulse[nsps + k]!;
  for (let k = 0; k < 2 * nsps; k++) dphi[nsym * nsps + k] = dphi[nsym * nsps + k]! + peak * tones[nsym - 1]! * pulse[k]!;
  const shift = (2 * Math.PI * f0) / fs;
  const n = nsym * nsps;
  const out = new Float32Array(n);
  let phi = 0;
  for (let k = 0; k < n; k++) {
    out[k] = amp * Math.sin(phi);
    phi = (phi + dphi[nsps + k]! + shift) % (2 * Math.PI);
  }
  const ramp = Math.round(nsps / 8);
  for (let i = 0; i < ramp; i++) {
    out[i] = out[i]! * ((1 - Math.cos((2 * Math.PI * i) / (2 * ramp))) / 2);
    out[n - ramp + i] = out[n - ramp + i]! * ((1 + Math.cos((2 * Math.PI * i) / (2 * ramp))) / 2);
  }
  return out;
}

/** A line of text as JTTY audio: its frames back to back. */
export function jttyWaveform(text: string, opts: JttyWaveformOptions): Float32Array {
  const tones = jttyPayloads(text).flatMap((p) => jttyFrameTones(p));
  if (tones.length === 0) throw new Error("Nothing to send");
  return jttyToneWaveform(tones, opts);
}

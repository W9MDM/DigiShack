// The 77-bit message payload shared by FT8, FT4 and FT2.
//
// Ported from wsjt-x_improved `lib/77bit/packjt77.f90` and `lib/chkcall.f90`
// (GPL-3.0; DigiShack is GPL-3.0).
//
// FT2 does not have its own message format. `genft2.f90` calls the same
// `pack77` FT8 does and then hands the 77 bits to LDPC(128,90):
//
//     call pack77(message,i3,n3,c77)
//     read(c77,"(77i1)") msgbits
//     call encode_128_90(msgbits,codeword)
//
// So this module is the payload layer for every mode we generate, and getting it
// right is what makes an FT2 transmission readable by WSJT-X rather than merely
// self-consistent.
//
// Implemented message types, which between them cover everything DigiShack
// transmits (see `standardMessages` in ./qso.ts):
//
//   i3=1  Standard: two callsigns plus grid, report, RRR, RR73 or 73.
//         28 + 1 + 28 + 1 + 1 + 15 + 3 bits.
//   i3=2  Identical layout, but the "/P" form used in EU VHF contests.
//   i3=4  One nonstandard callsign and one 12-bit hashed callsign — this is how
//         compound calls like PJ4/KA1ABC travel. 12 + 58 + 1 + 2 + 1 + 3 bits.
//   i3=0 n3=0  Free text, 13 characters. The fallback when nothing else fits.
//
// Deliberately NOT implemented: the contest exchanges (0.1 DXpedition, 0.3/0.4
// Field Day, 0.5 telemetry, 3 ARRL RTTY, 5 EU VHF). Packing them is dead weight
// for an FT2 station, and `unpack77` reports them as unsupported rather than
// mis-rendering them, so a decode is never silently wrong.

/** Alphabets, verbatim from the reference. Their exact contents and order matter. */
const A1 = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 37
const A2 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 36
const A3 = "0123456789"; // 10
const A4 = " ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 27
/** Hash alphabet — 38 characters, including "/". */
const AHASH = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/";
/** Free-text alphabet — 42 characters. */
const ATEXT = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?";

const NTOKENS = 2_063_592;
const MAX22 = 4_194_304;
const MAXGRID4 = 32_400;

const MASK64 = (1n << 64n) - 1n;
/** The multiplier in `ihashcall`. Not a round number and not negotiable. */
const HASH_MULTIPLIER = 47_055_833_459n;

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isLetter(c: string): boolean {
  return c >= "A" && c <= "Z";
}

/** Fortran `adjustr`: right-justify within a fixed width. */
function adjustR(s: string, width: number): string {
  const t = s.trimEnd().slice(0, width);
  return " ".repeat(width - t.length) + t;
}

/** Fortran fixed-length assignment: truncate or pad with blanks. */
function fixed(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

/**
 * `ihashcall` — the callsign hash, to `m` bits.
 *
 * A base-38 value over the first ELEVEN characters (not the whole 13), then a
 * 64-bit multiply, then the top `m` bits. Fortran's `ishft` with a negative
 * count is a logical shift, so the sign bit of the product must not propagate —
 * hence BigInt and an explicit mask rather than JS's `>>`, which would operate
 * on 32 bits and silently return garbage.
 */
export function ihashcall(call: string, m: number): number {
  const c13 = fixed(call.toUpperCase(), 13);
  let n8 = 0n;
  for (let i = 0; i < 11; i++) {
    // Fortran's `index(c,ch) - 1` IS JavaScript's `indexOf` — both give the
    // 0-based position, and both give -1 for a character outside the alphabet.
    // Subtracting 1 from indexOf as well shifts every symbol and produces a hash
    // that looks fine in isolation and matches nothing on the air.
    const j = BigInt(AHASH.indexOf(c13[i]!));
    n8 = (38n * n8 + j) & MASK64;
  }
  const prod = (HASH_MULTIPLIER * n8) & MASK64;
  return Number(prod >> BigInt(64 - m));
}

/**
 * The hash-call table.
 *
 * Types 4 and 5 send a 12- or 22-bit hash instead of a callsign, so a decoder
 * can only render them for stations it has already heard spell their call out in
 * full. That is a property of the protocol, not a shortcoming here: WSJT-X shows
 * `<...>` in exactly the same situation.
 */
export class HashCallBook {
  private readonly h10 = new Map<number, string>();
  private readonly h12 = new Map<number, string>();
  private readonly h22 = new Map<number, string>();

  /** Learn a callsign, so its hashes can later be resolved. Accepts `<CALL>`. */
  save(call: string): void {
    let cw = call.trim().toUpperCase();
    if (cw.startsWith("<")) cw = cw.slice(1);
    const gt = cw.indexOf(">");
    if (gt >= 0) cw = cw.slice(0, gt);
    cw = cw.trim();
    if (cw.length < 3 || cw === "<...>") return;
    this.h10.set(ihashcall(cw, 10), cw);
    this.h12.set(ihashcall(cw, 12), cw);
    this.h22.set(ihashcall(cw, 22), cw);
  }

  /** Resolve a hash to `<CALL>`, or `<...>` when the call has not been heard. */
  lookup(bits: 10 | 12 | 22, hash: number): string {
    const map = bits === 10 ? this.h10 : bits === 12 ? this.h12 : this.h22;
    const call = map.get(hash);
    return call ? `<${call}>` : "<...>";
  }

  get size(): number {
    return this.h22.size;
  }
}

export interface ChkCallResult {
  /** The base call, with any prefix or suffix stripped. */
  baseCall: string;
  ok: boolean;
}

/**
 * `chkcall` — could this word be a standard or compound callsign?
 *
 * Structural only: it knows nothing about which prefixes exist. `EN52` fails
 * because its last character is a digit, which is the check that keeps a grid
 * square from being mistaken for a callsign in `split77`.
 */
export function chkcall(word: string): ChkCallResult {
  const w = word.trim().toUpperCase();
  let bc = fixed(w, 6);
  const fail = (): ChkCallResult => ({ baseCall: bc.trim(), ok: false });

  const n1 = w.length;
  if (n1 > 11) return fail();
  if (/[.+\-?]/.test(w)) return fail();
  if (n1 > 6 && !w.includes("/")) return fail();

  const i0 = w.indexOf("/") + 1; // Fortran index(), 1-based, 0 when absent
  if (Math.max(i0 - 1, n1 - i0) > 6) return fail();
  if (i0 >= 2 && i0 <= n1 - 1) {
    // The shorter side of the slash is the base call — "PJ4/KA1ABC" -> KA1ABC.
    bc = i0 - 1 <= n1 - i0 ? fixed(w.slice(i0), 6) : fixed(w.slice(0, i0 - 1), 6);
  }

  const nbc = bc.trimEnd().length;
  if (nbc > 6) return fail();
  if (!isLetter(bc[0]!) && !isLetter(bc[1]!)) return fail();
  // No real call starts with Q, but QU1RK is WSJT-X's standard placeholder.
  if (bc[0] === "Q" && bc.slice(0, 5) !== "QU1RK") return fail();

  let i1 = 0;
  if (isDigit(bc[1]!)) i1 = 2;
  if (isDigit(bc[2]!)) i1 = 3;
  if (i1 === 0) return fail();
  if (i1 === nbc) return fail();

  let n = 0;
  for (let i = i1; i < nbc; i++) {
    if (!isLetter(bc[i]!)) return fail();
    n++;
  }
  if (n < 1 || n > 3) return fail();
  return { baseCall: bc.trim(), ok: true };
}

/**
 * `split77` — upper-case, collapse blanks, split into 13-character words.
 *
 * The one non-obvious step: when the message starts with "CQ" and the THIRD word
 * is a valid callsign, "CQ DX K9XYZ EN52" becomes the two words "CQ_DX" and
 * "K9XYZ" plus the grid, so the directed-CQ modifier rides inside the 28-bit
 * callsign field. Without this, a directed CQ falls through to free text.
 */
export function split77(msg: string): string[] {
  const collapsed = msg.replace(/\0/g, " ").trim().toUpperCase().split(/\s+/).filter(Boolean);
  const w = collapsed.map((x) => x.slice(0, 13));
  if (w.length >= 3 && chkcall(w[2]!).ok && w[0] === "CQ") {
    return [`CQ_${w[1]!.slice(0, 10)}`, ...w.slice(2)];
  }
  return w;
}

/** Pack a token, a hashed call, or a standard call into 28 bits. */
export function pack28(c13: string, book?: HashCallBook): number {
  const w = c13.trim().toUpperCase();
  let n28 = -1;

  if (w === "DE") return 0;
  if (w === "QRZ") return 1;
  if (w === "CQ") return 2;

  if (w.startsWith("CQ_")) {
    const tail = w.slice(3);
    if (tail.length >= 1 && tail.length <= 4) {
      const nlet = [...tail].filter(isLetter).length;
      const nnum = [...tail].filter(isDigit).length;
      if (nnum === 3 && nlet === 0) return 3 + Number(tail);
      if (nlet >= 1 && nlet <= 4 && nnum === 0) {
        const c4 = adjustR(tail, 4);
        let m = 0;
        for (const ch of c4) m = 27 * m + (isLetter(ch) ? ch.charCodeAt(0) - 64 : 0);
        return 3 + 1000 + m;
      }
    }
  }

  if (w.startsWith("<")) {
    book?.save(w);
    const inner = w.slice(1, w.indexOf(">"));
    return (NTOKENS + ihashcall(inner, 22)) & 0x0fff_ffff;
  }

  // Locate the call-area digit: the LAST digit, scanning from the right.
  const n = w.length;
  let iarea = 1;
  for (let i = n; i >= 2; i--) {
    iarea = i;
    if (isDigit(w[i - 1]!)) break;
  }
  let npdig = 0;
  let nplet = 0;
  for (let i = 1; i < iarea; i++) {
    if (isDigit(w[i - 1]!)) npdig++;
    if (isLetter(w[i - 1]!)) nplet++;
  }
  let nslet = 0;
  for (let i = iarea + 1; i <= n; i++) if (isLetter(w[i - 1]!)) nslet++;

  if (iarea < 2 || iarea > 3 || nplet === 0 || npdig >= iarea - 1 || nslet > 3) {
    // Nonstandard: send a 22-bit hash and hope the receiver has heard it before.
    book?.save(w);
    return (NTOKENS + ihashcall(w, 22)) & 0x0fff_ffff;
  }

  book?.save(w);
  // Align the call so the area digit lands in the third position.
  //
  // The reference also carries Swaziland (3DA0) and Guinea (3X) work-arounds
  // above this point, but they assign to `callsign` and are then overwritten
  // here — and those calls put the area digit at position 4 anyway, so they take
  // the nonstandard branch above and never reach this code. Reproducing the
  // reference's effective behaviour, not its evident intent, is what keeps us
  // interoperable.
  const callsign = iarea === 2 ? fixed(` ${w.slice(0, 5)}`, 6) : fixed(w.slice(0, 6), 6);
  const i1 = A1.indexOf(callsign[0]!);
  const i2 = A2.indexOf(callsign[1]!);
  const i3 = A3.indexOf(callsign[2]!);
  const i4 = A4.indexOf(callsign[3]!);
  const i5 = A4.indexOf(callsign[4]!);
  const i6 = A4.indexOf(callsign[5]!);
  if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0 || i6 < 0) {
    book?.save(w);
    return (NTOKENS + ihashcall(w, 22)) & 0x0fff_ffff;
  }
  n28 =
    36 * 10 * 27 * 27 * 27 * i1 +
    10 * 27 * 27 * 27 * i2 +
    27 * 27 * 27 * i3 +
    27 * 27 * i4 +
    27 * i5 +
    i6;
  return (n28 + NTOKENS + MAX22) & 0x0fff_ffff;
}

export interface Unpack28Result {
  call: string;
  ok: boolean;
}

/** Recover a callsign from 28 bits. */
export function unpack28(n28In: number, book?: HashCallBook): Unpack28Result {
  let n28 = n28In;
  let c13 = "";
  let ok = true;

  if (n28 < NTOKENS) {
    if (n28 === 0) return { call: "DE", ok: true };
    if (n28 === 1) return { call: "QRZ", ok: true };
    if (n28 === 2) return { call: "CQ", ok: true };
    if (n28 <= 1002) return { call: `CQ_${String(n28 - 3).padStart(3, "0")}`, ok: true };
    if (n28 <= 532_443) {
      let n = n28 - 1003;
      const i1 = Math.floor(n / (27 * 27 * 27));
      n -= 27 * 27 * 27 * i1;
      const i2 = Math.floor(n / (27 * 27));
      n -= 27 * 27 * i2;
      const i3 = Math.floor(n / 27);
      const i4 = n - 27 * i3;
      const tag = (A4[i1]! + A4[i2]! + A4[i3]! + A4[i4]!).trim();
      return { call: `CQ_${tag}`, ok: true };
    }
    // 532444..NTOKENS-1 is unassigned; fall through to the hash branch, as the
    // reference does by not returning here.
  }

  n28 -= NTOKENS;
  if (n28 < MAX22) {
    return { call: book ? book.lookup(22, n28) : "<...>", ok: true };
  }

  let n = n28 - MAX22;
  const i1 = Math.floor(n / (36 * 10 * 27 * 27 * 27));
  n -= 36 * 10 * 27 * 27 * 27 * i1;
  const i2 = Math.floor(n / (10 * 27 * 27 * 27));
  n -= 10 * 27 * 27 * 27 * i2;
  const i3 = Math.floor(n / (27 * 27 * 27));
  n -= 27 * 27 * 27 * i3;
  const i4 = Math.floor(n / (27 * 27));
  n -= 27 * 27 * i4;
  const i5 = Math.floor(n / 27);
  const i6 = n - 27 * i5;
  if (i1 >= A1.length || i2 >= A2.length || i3 >= A3.length) return { call: "QU1RK", ok: false };
  c13 = (A1[i1]! + A2[i2]! + A3[i3]! + A4[i4]! + A4[i5]! + A4[i6]!).trimStart();

  if (!chkcall(c13.trim()).ok) return { call: "QU1RK", ok: false };
  // An interior blank means the fields did not line up — a real call has none.
  const trimmed = c13.trimEnd();
  if (trimmed.includes(" ")) return { call: "QU1RK", ok: false };
  book?.save(trimmed);
  return { call: trimmed, ok };
}

/** Free text: 13 characters as a base-42 value, right-justified. */
export function packText77(text: string): bigint {
  const w = adjustR(text.toUpperCase(), 13);
  let n = 0n;
  for (const ch of w) {
    // Characters outside the 42-symbol alphabet become blanks, not errors.
    const j = ATEXT.indexOf(ch);
    n = n * 42n + BigInt(j < 0 ? 0 : j);
  }
  return n;
}

/** The inverse: a 71-bit value back to 13 characters. */
export function unpackText77(value: bigint): string {
  let n = value;
  const out: string[] = new Array(13).fill(" ");
  for (let i = 12; i >= 0; i--) {
    out[i] = ATEXT[Number(n % 42n)]!;
    n /= 42n;
  }
  return out.join("");
}

/** Grid square from the 15-bit field. */
export function toGrid4(nIn: number): { grid: string; ok: boolean } {
  let n = nIn;
  const j1 = Math.floor(n / (18 * 10 * 10));
  if (j1 < 0 || j1 > 17) return { grid: "", ok: false };
  n -= j1 * 18 * 10 * 10;
  const j2 = Math.floor(n / (10 * 10));
  if (j2 < 0 || j2 > 17) return { grid: "", ok: false };
  n -= j2 * 10 * 10;
  const j3 = Math.floor(n / 10);
  if (j3 < 0 || j3 > 9) return { grid: "", ok: false };
  const j4 = n - j3 * 10;
  if (j4 < 0 || j4 > 9) return { grid: "", ok: false };
  return {
    grid:
      String.fromCharCode(65 + j1) +
      String.fromCharCode(65 + j2) +
      String.fromCharCode(48 + j3) +
      String.fromCharCode(48 + j4),
    ok: true,
  };
}

const GRID4_RE = /^[A-R][A-R][0-9][0-9]$/;

/** Is this a four-character grid square? */
export function isGrid4(s: string): boolean {
  return GRID4_RE.test(s);
}

// ---------------------------------------------------------------------------
// Bit packing
// ---------------------------------------------------------------------------

function writeBits(out: Uint8Array, offset: number, value: bigint, nbits: number): number {
  for (let i = 0; i < nbits; i++) {
    out[offset + i] = Number((value >> BigInt(nbits - 1 - i)) & 1n);
  }
  return offset + nbits;
}

function readBits(bits: ArrayLike<number>, offset: number, nbits: number): bigint {
  let v = 0n;
  for (let i = 0; i < nbits; i++) v = (v << 1n) | BigInt(bits[offset + i]! & 1);
  return v;
}

export interface Pack77Result {
  /** The 77 payload bits, MSB-first, one per element. */
  bits: Uint8Array;
  /** Message type. */
  i3: number;
  /** Sub-type, meaningful when i3 = 0. */
  n3: number;
  /** The message as it will be received, which may differ from what was asked. */
  sent: string;
}

/**
 * Pack a message into 77 bits.
 *
 * Never throws and never refuses: anything that does not fit a structured type
 * becomes 13 characters of free text, matching WSJT-X. `sent` reports what will
 * actually go out, so a caller can see when a message was truncated rather than
 * discovering it from the other operator.
 */
export function pack77(message: string, book?: HashCallBook): Pack77Result {
  const w = split77(message);
  const bits = new Uint8Array(77);

  const structured = packStandard(w, bits, book) ?? packNonstandard(w, bits, book);
  if (structured) {
    const round = unpack77(bits, book);
    return { ...structured, bits, sent: round.ok ? round.message : message.trim().toUpperCase() };
  }

  // Free text. The message is collapsed and upper-cased first, then cut to 13.
  const text = w.join(" ").slice(0, 13);
  let off = writeBits(bits, 0, packText77(text), 71);
  off = writeBits(bits, off, 0n, 3); // n3
  writeBits(bits, off, 0n, 3); // i3
  return { bits, i3: 0, n3: 0, sent: unpackText77(packText77(text)).trim() };
}

/** Types 1 and 2. Returns null when the words do not fit. */
function packStandard(
  w: string[],
  bits: Uint8Array,
  book?: HashCallBook,
): { i3: number; n3: number } | null {
  const nwords = w.length;
  if (nwords < 2 || nwords > 4) return null;

  const w1 = w[0]!;
  const w2 = w[1]!;
  const c1 = chkcall(w1);
  const c2 = chkcall(w2);
  let ok1 = c1.ok;
  let ok2 = c2.ok;
  if (w1 === "DE" || w1.startsWith("CQ_") || w1 === "CQ" || w1 === "QRZ") ok1 = true;
  if (w1.startsWith("<") && w1.indexOf(">") >= 4) ok1 = true;
  if (w2.startsWith("<") && w2.indexOf(">") >= 4) ok2 = true;
  if (!ok1 || !ok2) return null;
  // A hashed call cannot be paired with a compound one: the receiver would have
  // no way to tell which half of the slash it heard.
  if (w1.startsWith("<") && w2.includes("/")) return null;
  if (w2.startsWith("<") && w1.includes("/")) return null;
  if (nwords === 2 && (!ok2 || w2.indexOf("/") >= 1)) return null;

  let ir = 0;
  let irpt = 0;
  const last = w[nwords - 1]!;

  if (nwords > 2) {
    const p1 = last[0]!;
    const p2 = last.slice(0, 2);
    const grid = last.slice(0, 4);
    if (
      !isGrid4(grid) &&
      p1 !== "+" &&
      p1 !== "-" &&
      p2 !== "R+" &&
      p2 !== "R-" &&
      last !== "RRR" &&
      last !== "RR73" &&
      last !== "73"
    ) {
      return null;
    }
    if (p1 === "+" || p1 === "-") {
      ir = 0;
      const v = Number(last);
      if (!Number.isFinite(v)) return null;
      irpt = (v >= -50 && v <= -31 ? v + 101 : v) + 35;
    } else if (p2 === "R+" || p2 === "R-") {
      ir = 1;
      const v = Number(last.slice(1));
      if (!Number.isFinite(v)) return null;
      irpt = (v >= -50 && v <= -31 ? v + 101 : v) + 35;
    } else if (last === "RRR") {
      irpt = 2;
    } else if (last === "RR73") {
      irpt = 3;
    } else if (last === "73") {
      irpt = 4;
    }
  }

  // Only 2, 3, or "call call R grid" reaches a type; anything else is free text.
  if (!(nwords === 2 || nwords === 3 || (nwords === 4 && w[2] === "R"))) return null;

  const i1p = `${w1} `.indexOf("/P ") + 1;
  const i2p = `${w2} `.indexOf("/P ") + 1;
  const i3 = i1p >= 4 || i2p >= 4 ? 2 : 1;

  let a = c1.baseCall;
  if (a.startsWith("CQ_") || w1.startsWith("<")) a = w1;
  else if (w1 === "CQ" || w1 === "DE" || w1 === "QRZ") a = w1;
  const n28a = pack28(a, book);

  let b = c2.baseCall;
  if (w2.startsWith("<")) b = w2;
  const n28b = pack28(b, book);

  const ipa = i1p >= 4 || `${w1} `.indexOf("/R ") + 1 >= 4 ? 1 : 0;
  const ipb = i2p >= 4 || `${w2} `.indexOf("/R ") + 1 >= 4 ? 1 : 0;

  let igrid4: number;
  const grid = last.slice(0, 4);
  if (nwords > 2 && isGrid4(grid)) {
    ir = w[2] === "R" ? 1 : 0;
    igrid4 =
      (grid.charCodeAt(0) - 65) * 18 * 10 * 10 +
      (grid.charCodeAt(1) - 65) * 10 * 10 +
      (grid.charCodeAt(2) - 48) * 10 +
      (grid.charCodeAt(3) - 48);
  } else {
    igrid4 = MAXGRID4 + irpt;
  }
  if (nwords === 2) {
    ir = 0;
    igrid4 = MAXGRID4 + 1;
  }

  let off = writeBits(bits, 0, BigInt(n28a), 28);
  off = writeBits(bits, off, BigInt(ipa), 1);
  off = writeBits(bits, off, BigInt(n28b), 28);
  off = writeBits(bits, off, BigInt(ipb), 1);
  off = writeBits(bits, off, BigInt(ir), 1);
  off = writeBits(bits, off, BigInt(igrid4), 15);
  writeBits(bits, off, BigInt(i3), 3);
  return { i3, n3: 0 };
}

/** Type 4: one nonstandard call and one 12-bit hash. */
function packNonstandard(
  w: string[],
  bits: Uint8Array,
  book?: HashCallBook,
): { i3: number; n3: number } | null {
  const nwords = w.length;
  if (nwords !== 2 && nwords !== 3) return null;

  const strip = (s: string) => (s.startsWith("<") ? s.slice(1, s.length - 1) : s);
  const call1 = strip(w[0]!);
  const call2 = strip(w[1]!);
  const c1 = chkcall(call1);
  const c2 = chkcall(call2);
  // Both plain and both valid means type 1 already handled it.
  if (call1 === c1.baseCall && call2 === c2.baseCall && c1.ok && c2.ok) return null;

  let icq = 0;
  if (w[0] === "CQ" || (c1.ok && c2.ok)) {
    if (w[0] === "CQ" && w[1]!.length <= 4) return null;
    if (w[0] === "CQ") icq = 1;
  } else if (!w[0]!.startsWith("<") && !w[1]!.startsWith("<")) {
    return null;
  }

  let iflip = 0;
  let n12 = 0;
  let c11: string;
  if (icq === 1) {
    c11 = adjustR(call2, 11);
    book?.save(w[1]!);
  } else if (w[0]!.startsWith("<")) {
    book?.save(w[0]!);
    n12 = ihashcall(call1, 12);
    c11 = adjustR(call2, 11);
  } else if (w[1]!.startsWith("<")) {
    iflip = 1;
    book?.save(w[1]!);
    n12 = ihashcall(call2, 12);
    c11 = adjustR(call1, 11);
  } else {
    // Neither call is hashed and they are not both standard — the sender must
    // choose which to hash. WSJT-X leaves c11 undefined here; we decline instead
    // of emitting whatever was left in the buffer.
    return null;
  }

  // Base-38 over exactly 11 characters, right-justified. `indexOf` already is
  // Fortran's `index()-1`; see the note in `ihashcall`.
  let n58 = 0n;
  for (const ch of c11) {
    const j = AHASH.indexOf(ch);
    n58 = n58 * 38n + BigInt(j < 0 ? 0 : j);
  }

  let nrpt = 0;
  const third = nwords === 3 ? w[2]! : "";
  if (third === "RRR") nrpt = 1;
  if (third === "RR73") nrpt = 2;
  if (third === "73") nrpt = 3;
  if (icq === 1) {
    iflip = 0;
    nrpt = 0;
  }

  let off = writeBits(bits, 0, BigInt(n12), 12);
  off = writeBits(bits, off, n58, 58);
  off = writeBits(bits, off, BigInt(iflip), 1);
  off = writeBits(bits, off, BigInt(nrpt), 2);
  off = writeBits(bits, off, BigInt(icq), 1);
  writeBits(bits, off, 4n, 3);
  return { i3: 4, n3: 0 };
}

export interface Unpack77Result {
  message: string;
  ok: boolean;
  i3: number;
  n3: number;
}

/**
 * Render 77 payload bits as text.
 *
 * `ok` false means "do not show this to the operator" — a failed CRC is not the
 * only way a decode can be wrong, and a message that unpacks to a structurally
 * impossible callsign is noise that happened to pass parity.
 */
export function unpack77(bits: ArrayLike<number>, book?: HashCallBook): Unpack77Result {
  if (bits.length !== 77) return { message: "", ok: false, i3: -1, n3: -1 };
  const i3 = Number(readBits(bits, 74, 3));
  const n3 = Number(readBits(bits, 71, 3));

  if (i3 === 0 && n3 === 0) {
    const msg = unpackText77(readBits(bits, 0, 71)).trim();
    return { message: msg, ok: msg.length > 0, i3, n3 };
  }

  if (i3 === 1 || i3 === 2) {
    const n28a = Number(readBits(bits, 0, 28));
    const ipa = Number(readBits(bits, 28, 1));
    const n28b = Number(readBits(bits, 29, 28));
    const ipb = Number(readBits(bits, 57, 1));
    const ir = Number(readBits(bits, 58, 1));
    const igrid4 = Number(readBits(bits, 59, 15));

    const a = unpack28(n28a, book);
    const b = unpack28(n28b, book);
    let ok = a.ok && b.ok;
    let call1 = a.call;
    let call2 = b.call;
    if (call1.startsWith("CQ_")) call1 = `CQ ${call1.slice(3)}`;
    const suffix = i3 === 1 ? "/R" : "/P";
    if (!call1.includes("<") && ipa === 1 && call1.length >= 3) call1 += suffix;
    if (!call2.includes("<") && ipb === 1 && call2.length >= 3) call2 += suffix;

    if (igrid4 <= MAXGRID4) {
      const g = toGrid4(igrid4);
      if (!g.ok) ok = false;
      const msg = `${call1} ${call2}${ir === 1 ? " R " : " "}${g.grid}`;
      // "CQ ... R GRID" is meaningless — a CQ cannot acknowledge anything.
      if (msg.startsWith("CQ ") && ir === 1) ok = false;
      return { message: msg, ok, i3, n3 };
    }

    const irpt = igrid4 - MAXGRID4;
    let msg = `${call1} ${call2}`;
    if (irpt === 2) msg += " RRR";
    else if (irpt === 3) msg += " RR73";
    else if (irpt === 4) msg += " 73";
    else if (irpt >= 5) {
      let isnr = irpt - 35;
      if (isnr > 50) isnr -= 101;
      const mag = String(Math.abs(isnr)).padStart(2, "0");
      const crpt = `${isnr < 0 ? "-" : "+"}${mag}`;
      msg += ir === 1 ? ` R${crpt}` : ` ${crpt}`;
    } else if (irpt !== 1) {
      ok = false;
    }
    if (msg.startsWith("CQ ") && irpt >= 2) ok = false;
    return { message: msg, ok, i3, n3 };
  }

  if (i3 === 4) {
    const n12 = Number(readBits(bits, 0, 12));
    let n58 = readBits(bits, 12, 58);
    const iflip = Number(readBits(bits, 70, 1));
    const nrpt = Number(readBits(bits, 71, 2));
    const icq = Number(readBits(bits, 73, 1));

    const chars: string[] = new Array(11).fill(" ");
    for (let i = 10; i >= 0; i--) {
      chars[i] = AHASH[Number(n58 % 38n)]!;
      n58 /= 38n;
    }
    const plain = chars.join("").trim();
    const hashed = book ? book.lookup(12, n12) : "<...>";

    const call1 = iflip === 0 ? hashed : plain;
    const call2 = iflip === 0 ? plain : hashed;
    if (plain.length >= 3) book?.save(plain);

    if (icq === 1) return { message: `CQ ${call2}`, ok: plain.length > 0, i3, n3 };
    let msg = `${call1} ${call2}`;
    if (nrpt === 1) msg += " RRR";
    else if (nrpt === 2) msg += " RR73";
    else if (nrpt === 3) msg += " 73";
    return { message: msg, ok: plain.length > 0, i3, n3 };
  }

  // A type we do not implement. Reporting it unsupported is safer than
  // rendering the bits through the wrong layout and showing a plausible
  // callsign that was never transmitted.
  return { message: "", ok: false, i3, n3 };
}

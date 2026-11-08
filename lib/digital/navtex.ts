// NAVTEX and SITOR-B: the code, the message format, the station list, and a test signal.
//
// NAVTEX is the marine safety broadcast every ship's bridge has a printer for: coast
// stations take turns, four hours apart in ten-minute slots, sending navigational and
// weather warnings on 518 kHz (international, English), 490 kHz (national languages) and
// 4209.5 kHz (tropical). It is SITOR mode B - the one-way, "collective" form of the ship
// teleprinter system - so this is receive-only by nature: there is nothing an amateur
// sends. The decoder is lib/digital/navtexdemod.ts; this file is everything it reads with.
//
// THE SIGNAL. 100 baud FSK, 170 Hz shift, synchronous: no start or stop bits, just a
// continuous stream of 7-bit characters. The higher frequency is the "B" state, a 1 bit
// here; the lower is "Y", a 0. fldigi puts mark (1) at centre + 85 Hz and space at centre
// - 85 Hz (navtex.cxx:860, 987-989) and keys a 1 as mark (send_bit, navtex.cxx:1799-1802),
// so on USB the audio and the RF agree: a station on 518.000 kHz with the dial at
// 517.000 kHz USB is centred on 1000 Hz audio, fldigi's default centre
// (dflt_center_freq, navtex.cxx:862), with B at 1085 Hz. On LSB the tones are swapped,
// which fldigi undoes with its reverse flag (navtex.cxx:1545-1552); the decoder here
// notices on its own (see navtexdemod.ts). Bits go out least significant first
// (send_string, navtex.cxx:1815-1819).
//
// THE CODE is CCIR 476 (ITU-R M.476): ITA2's letters and figures, re-coded so that every
// character is 7 bits with exactly 4 of them set. 35 of the 128 patterns qualify, which
// is the error detection: a single bit error leaves 3 or 5 marks and is seen. Six of the
// 35 are controls - LTRS, FIGS, the two phasing signals alpha and rep (they are also the
// idle and the "signal repetition" of the ARQ mode), beta and "char 32" - and the other 29
// are the 26 letters, space, CR and LF, with figures-case meanings for most of them. The
// tables are fldigi's (code_to_ltrs, ITA2_code_to_figs, USTTY_code_to_figs,
// navtex.cxx:465-508). fldigi picks the figures set from its RTTY preference
// (progdefaults.ITA2, navtex.cxx:526); NAVTEX is an international service and its texts
// are ITA2, so ITA2 is the default here.
//
// TIME DIVERSITY, the FEC of mode B. Every character is sent twice, five character slots
// (35 bits, 350 ms) apart, interleaved with the others: the first copy in the "DX"
// position, the repeat in the "RX" position, alternately. fldigi's create_fec
// (navtex.cxx:1728-1749) and the example it quotes from JNX: "NAUTICAL" goes out as
//
//   rep alpha rep alpha N alpha A alpha U N T A I U C T A I L C blank A blank L
//
// so slot p carries a new character when p is even and the one from slot p-5 when it is
// odd. A burst of static that takes one copy rarely takes the other; the receiver prints
// whichever copy has four marks (navtex.cxx:1238-1323).
//
// PHASING. Before a message the station sends at least ten seconds of phasing: rep in the
// DX positions, alpha in the RX positions, which is what the receiver's character clock
// locks on (find_alpha_characters, navtex.cxx:1120-1187). Note fldigi's own transmitter
// sends a plain carrier at the centre for phasing (send_phasing, navtex.cxx:1794-1797),
// which no real station does; the test generator below sends the real thing.
//
// THE MESSAGE, per the comment at navtex.cxx:1507-1521 (from ITU-R M.540):
//
//   ZCZC B1B2B3B4 CR LF  text  NNNN CR LF LF
//
// B1, a letter, is the station's slot (A to X; stations far enough apart share a letter);
// B2 is the subject (A navigational warning, B meteorological warning, D search and
// rescue, E forecast ... see NAVTEX_SUBJECTS); B3B4 is a serial, 01-99, that a receiver
// uses to print each message once (00 is "print always", for distress). fldigi's header
// detector is exacting - "ZCZC", one space, two alphanumerics, two digits, CR or LF
// (detect_header, navtex.cxx:716-751) - and its end detector is just "NNNN"
// (detect_end, navtex.cxx:753-768). NavtexMessageAssembler is both, as a stream.
//
// navtexWaveform is a TEST GENERATOR: it exists so the receiver can be checked against a
// signal that is known to be right. It is not a transmitter and is not offered on the air.

/** The keying rate, baud (navtex.cxx:958). */
export const NAVTEX_BAUD = 100;
/** The frequency shift, Hz: mark and space at centre plus and minus half of it (deviation_f, navtex.cxx:860). */
export const NAVTEX_SHIFT_HZ = 170;
/** fldigi's default audio centre, Hz (dflt_center_freq, navtex.cxx:862). */
export const NAVTEX_CENTRE_HZ = 1000;
/** The broadcast frequencies, kHz: international (English), national, tropical HF. */
export const NAVTEX_FREQUENCIES_KHZ = { international: 518, national: 490, tropical: 4209.5 } as const;
/** Bits in a character. */
export const CCIR476_BITS = 7;
/** Character slots between the DX copy of a character and its RX repeat (fec_offset, navtex.cxx:1080-1084). */
export const NAVTEX_FEC_SLOTS = 5;

// The six controls (navtex.cxx:502-507). All have four marks, like everything else.
export const CCIR476_LTRS = 0x5a;
export const CCIR476_FIGS = 0x36;
/** Phasing signal 1, sent in the RX positions while phasing; also the idle. */
export const CCIR476_ALPHA = 0x0f;
export const CCIR476_BETA = 0x33;
export const CCIR476_CHAR32 = 0x6a;
/** Phasing signal 2, "signal repetition", sent in the DX positions while phasing. */
export const CCIR476_REP = 0x66;

/** Which figures-case table: ITA2 (default, the international one) or US TTY. */
export type NavtexFigures = "ita2" | "us";

// fldigi's three tables, indexed by the 7-bit code, "_" for no character
// (navtex.cxx:465-499). Kept as strings of 128 so they read like the C source.
const LTRS_TABLE =
  "________________" +
  "_______J___F_CK_" +
  "_______W___Y_PQ_" +
  "_____G___MX_V___" +
  "_______A___S_IU_" +
  "___D_RE__N__ ___" +
  "___Z_L___H__\n___" +
  "_OB_T___\r_______";
const FIGS_ITA2_TABLE =
  "________________" +
  "_______'___!_:(_" +
  "_______2___6_01_" +
  "_____&___./_=___" +
  "_______-___'_87_" +
  "___$_43__,__ ___" +
  "___+_)___#__\n___" +
  "_9?_5___\r_______";
const FIGS_US_TABLE =
  "________________" +
  "_______'___!_:(_" +
  "_______2___6_01_" +
  "_____&___./_;___" +
  "_______-___\x07_87_" +
  "___$_43__,__ ___" +
  '___"_)___#__\n___' +
  "_9?_5___\r_______";

function table(s: string): readonly (string | null)[] {
  return Array.from(s, (c) => (c === "_" ? null : c));
}

/** Letters case, by code: the character, or null where there is none. */
export const CCIR476_LETTERS: readonly (string | null)[] = table(LTRS_TABLE);
/** Figures case, ITA2, by code. */
export const CCIR476_FIGURES_ITA2: readonly (string | null)[] = table(FIGS_ITA2_TABLE);
/** Figures case, US TTY, by code. */
export const CCIR476_FIGURES_US: readonly (string | null)[] = table(FIGS_US_TABLE);

function figuresTable(f: NavtexFigures | undefined): readonly (string | null)[] {
  return f === "us" ? CCIR476_FIGURES_US : CCIR476_FIGURES_ITA2;
}

/** Marks (1 bits) in a code. */
export function ccir476Marks(code: number): number {
  let v = code & 0x7f;
  let n = 0;
  while (v) {
    n++;
    v &= v - 1;
  }
  return n;
}

/** A code is valid when exactly four of its seven bits are set (check_bits, navtex.cxx:593-601). */
export function ccir476Valid(code: number): boolean {
  return code >= 0 && code < 128 && ccir476Marks(code) === 4;
}

/** All 35 valid codes, ascending. */
export const CCIR476_VALID_CODES: readonly number[] = Array.from({ length: 128 }, (_, i) => i).filter(ccir476Valid);

/** The character a code stands for in a case, or null (a control, or no character): code_to_char, navtex.cxx:562-575. */
export function ccir476Char(code: number, figures: boolean, variant: NavtexFigures = "ita2"): string | null {
  return (figures ? figuresTable(variant) : CCIR476_LETTERS)[code & 0x7f] ?? null;
}

/** A readable name for a code, for logs and tests. */
export function ccir476CodeName(code: number, figures = false, variant: NavtexFigures = "ita2"): string {
  switch (code) {
    case CCIR476_LTRS:
      return "LTRS";
    case CCIR476_FIGS:
      return "FIGS";
    case CCIR476_ALPHA:
      return "alpha";
    case CCIR476_BETA:
      return "beta";
    case CCIR476_CHAR32:
      return "char32";
    case CCIR476_REP:
      return "rep";
  }
  const c = ccir476Char(code, figures, variant);
  if (c === null) return ccir476Valid(code) ? "?" : "invalid";
  return c === "\r" ? "CR" : c === "\n" ? "LF" : c === " " ? "space" : c === "\x07" ? "BEL" : c;
}

/**
 * Text to codes, inserting LTRS and FIGS as the case changes: char_to_code
 * (navtex.cxx:541-560). The case starts in letters and no LTRS is sent first, as
 * fldigi's encode does (navtex.cxx:1752-1760). Space, CR and LF exist in both cases and
 * never cause a shift. Characters with no code are dropped. Lower case is sent as upper.
 */
export function ccir476Encode(text: string, variant: NavtexFigures = "ita2"): number[] {
  const figs = figuresTable(variant);
  const out: number[] = [];
  let shift = false;
  for (const raw of text) {
    const ch = raw.toUpperCase();
    // Prefer the last code that has the character, as fldigi's reverse tables do (the
    // ITA2 figures have the apostrophe twice; fldigi sends the later one).
    const f = figs.lastIndexOf(ch);
    const l = CCIR476_LETTERS.lastIndexOf(ch);
    if (shift && f > 0) out.push(f);
    else if (!shift && l > 0) out.push(l);
    else if (f > 0) {
      shift = true;
      out.push(CCIR476_FIGS, f);
    } else if (l > 0) {
      shift = false;
      out.push(CCIR476_LTRS, l);
    }
  }
  return out;
}

/**
 * Codes to text, a stream: owns the letters/figures case. Controls print nothing; a valid
 * code with no character in the current case prints nothing (fldigi logs it, navtex.cxx:1350-1353).
 */
export class Ccir476Decoder {
  private figures = false;
  constructor(private readonly variant: NavtexFigures = "ita2") {}

  reset(): void {
    this.figures = false;
  }

  get inFigures(): boolean {
    return this.figures;
  }

  /** The character for a code, or "" for a control or an unknown code. Returns CR as "\r". */
  push(code: number): string {
    if (code === CCIR476_LTRS) this.figures = false;
    else if (code === CCIR476_FIGS) this.figures = true;
    else if (code === CCIR476_ALPHA || code === CCIR476_BETA || code === CCIR476_CHAR32 || code === CCIR476_REP) return "";
    else return ccir476Char(code, this.figures, this.variant) ?? "";
    return "";
  }
}

/**
 * The FEC time-diversity stream for a run of codes: fldigi's create_fec
 * (navtex.cxx:1728-1749). Two rep/alpha pairs lead in, each code goes in a DX slot and
 * again five slots later in an RX slot, and two char32/code pairs close it so the last
 * codes get their repeats.
 */
export function navtexFecStream(codes: readonly number[]): number[] {
  const res: number[] = [];
  const offset = 2;
  for (let i = 0; i < offset; i++) res.push(CCIR476_REP, CCIR476_ALPHA);
  for (let i = 0; i < codes.length; i++) res.push(codes[i]!, i >= offset ? codes[i - offset]! : CCIR476_ALPHA);
  for (let i = 0; i < offset; i++) res.push(CCIR476_CHAR32, codes[codes.length - offset + i] ?? CCIR476_ALPHA);
  return res;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The subject indicators, B2: fldigi's msg_type (navtex.cxx:637-660), which follows the
 * IMO NAVTEX Manual. A, B, D and L cannot be refused by a receiver; the rest can.
 */
export const NAVTEX_SUBJECTS: Readonly<Record<string, string>> = {
  A: "Navigational warning",
  B: "Meteorological warning",
  C: "Ice report",
  D: "Search & rescue information, pirate warnings",
  E: "Meteorological forecast",
  F: "Pilot service message",
  G: "AIS message",
  H: "LORAN message",
  I: "Not used",
  J: "SATNAV messages",
  K: "Other electronic navaid messages",
  L: "Navigational warnings",
  T: "Test transmissions (UK only)",
  V: "Notice to fishermen (U.S. only)",
  W: "Environmental (U.S. only)",
  X: "Special services - allocation by IMO NAVTEX Panel",
  Y: "Special services - allocation by IMO NAVTEX Panel",
  Z: "No message on hand",
};

/** The subject's name for a B2 letter; fldigi's wording for one it does not know. */
export function navtexSubject(type: string): string {
  return NAVTEX_SUBJECTS[type.toUpperCase()] ?? "Invalid navtex subject";
}

export interface NavtexMessage {
  /** B1: the transmitting station's letter, A-X ("?" when the header was lost). */
  station: string;
  /** B2: the subject letter ("?" when the header was lost). */
  type: string;
  /** The subject's name: "Navigational warning", "Meteorological forecast" ... */
  subject: string;
  /** B3B4, two digits as sent ("" when the header was lost). */
  serial: string;
  /** The message text, cleaned up as fldigi does: runs of spaces to one, line breaks to "\n", trimmed. */
  text: string;
  /** No ZCZC header was seen before this text: the receiver came in during the message. */
  lostHeader: boolean;
  /** No NNNN: the next header arrived first, or ten minutes passed. */
  lostTrailer: boolean;
}

/**
 * fldigi's cleanup (navtex.cxx:663-690): leading blanks and line breaks go, a run of CR
 * and LF becomes one "\n", a run of spaces and tabs one space, and nothing trails. (A
 * blank line in the original is therefore lost; fldigi loses it too.)
 */
export function navtexCleanText(s: string): string {
  let out = "";
  let wasDelim = false;
  let wasSpace = false;
  let seen = false;
  for (const c of s) {
    if (c === "\n" || c === "\r") wasDelim = true;
    else if (c === " " || c === "\t") wasSpace = true;
    else {
      if (seen) {
        if (wasDelim) out += "\n";
        else if (wasSpace) out += " ";
      }
      wasDelim = wasSpace = false;
      seen = true;
      out += c;
    }
  }
  return out;
}

const HEADER_RE = /ZCZC\s*([A-Z0-9])([A-Z0-9])(\d)(\d)/;

/**
 * Parse one completed message: "ZCZC B1B2B3B4", the text, "NNNN" (optional). More forgiving
 * than the live detector - any whitespace, or none, after ZCZC - since a stored message
 * may have been re-wrapped. Returns null when there is no header.
 */
export function parseNavtexMessage(raw: string): NavtexMessage | null {
  const m = HEADER_RE.exec(raw.toUpperCase());
  if (!m) return null;
  const [, b1, b2, b3, b4] = m as unknown as [string, string, string, string, string];
  let body = raw.slice(m.index + m[0].length);
  const end = body.toUpperCase().indexOf("NNNN");
  const lostTrailer = end < 0;
  if (!lostTrailer) body = body.slice(0, end);
  return {
    station: b1,
    type: b2,
    subject: navtexSubject(b2),
    serial: b3 + b4,
    text: navtexCleanText(body),
    lostHeader: false,
    lostTrailer,
  };
}

/** How long a message may run without NNNN before it is closed anyway, s (process_timeout, navtex.cxx:1037). */
export const NAVTEX_MESSAGE_TIMEOUT_S = 600;

function isAlnum(c: string | undefined): boolean {
  return c !== undefined && /^[A-Z0-9]$/.test(c);
}
function isDigit(c: string | undefined): boolean {
  return c !== undefined && /^[0-9]$/.test(c);
}

/**
 * Received characters in, completed messages out: fldigi's process_messages,
 * detect_header and detect_end (navtex.cxx:1045-1078, 716-768) and its ten-minute
 * timeout (navtex.cxx:1032-1043). Feed it every character the decoder prints, CR included.
 *
 * Unlike fldigi, text before a header with no header of its own is only returned if it
 * ended in NNNN; the scraps of a message joined part way through, closed by the next
 * ZCZC, are dropped instead of logged as "[Lost header]".
 */
export class NavtexMessageAssembler {
  private buf = "";
  private headerFound = false;
  private station = "?";
  private type = "?";
  private serial = "";
  private lastTime = 0;
  private out: NavtexMessage[] = [];

  reset(): void {
    this.buf = "";
    this.headerFound = false;
    this.station = "?";
    this.type = "?";
    this.serial = "";
    this.lastTime = 0;
    this.out = [];
  }

  /** Completed messages since the last call, oldest first. */
  take(): NavtexMessage[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  /** Whether a header has been seen and its message is still open. */
  get inMessage(): boolean {
    return this.headerFound;
  }

  private emit(text: string, lostHeader: boolean, lostTrailer: boolean): void {
    const clean = navtexCleanText(text);
    if (lostHeader && (lostTrailer || !clean)) return;
    this.out.push({
      station: lostHeader ? "?" : this.station,
      type: lostHeader ? "?" : this.type,
      subject: lostHeader ? navtexSubject("?") : navtexSubject(this.type),
      serial: lostHeader ? "" : this.serial,
      text: clean,
      lostHeader,
      lostTrailer,
    });
  }

  /** Close an open message with no NNNN when it has run too long. Call now and then with the time. */
  tick(timeSec: number): void {
    if (this.headerFound && timeSec - this.lastTime > NAVTEX_MESSAGE_TIMEOUT_S) {
      this.emit(this.buf, false, true);
      this.headerFound = false;
      this.buf = "";
      this.lastTime = timeSec;
    }
  }

  /** One received character, at a time in seconds (any origin, increasing). */
  push(ch: string, timeSec = 0): void {
    this.tick(timeSec);
    this.buf += ch;
    // Keep the buffer from growing without bound on a long headerless stretch: nothing
    // older than a header's length matters to the detectors, and a headerless message is
    // only returned if it ends in NNNN.
    if (!this.headerFound && this.buf.length > 4096) this.buf = this.buf.slice(-2048);
    const q = this.buf.length;
    if (q >= 10) {
      const c = this.buf.slice(q - 10);
      if (
        c.startsWith("ZCZC ") &&
        isAlnum(c[5]) &&
        isAlnum(c[6]) &&
        isDigit(c[7]) &&
        isDigit(c[8]) &&
        (c[9] === "\r" || c[9] === "\n")
      ) {
        const before = this.buf.slice(0, q - 10);
        if (this.headerFound) this.emit(before, false, true);
        this.station = c[5]!;
        this.type = c[6]!;
        this.serial = c[7]! + c[8]!;
        this.headerFound = true;
        this.buf = "";
        this.lastTime = timeSec;
        return;
      }
    }
    if (q >= 4 && this.buf.endsWith("NNNN")) {
      this.emit(this.buf.slice(0, q - 4), !this.headerFound, false);
      this.headerFound = false;
      this.buf = "";
      this.lastTime = timeSec;
    }
  }
}

// ---------------------------------------------------------------------------
// The test generator
// ---------------------------------------------------------------------------

export interface NavtexWaveformOptions {
  sampleRate: number;
  /** Audio centre, Hz; mark is 85 Hz above it, space 85 Hz below. Default 1000. */
  centreHz?: number;
  /** B1, the station letter. Default "Z", fldigi's (navtex.cxx:1836): no real station uses it. */
  station?: string;
  /** B2, the subject letter. Default "I", fldigi's (navtex.cxx:1837): "not used". */
  type?: string;
  /** B3B4. Default 1. */
  serial?: number;
  /** Plain SITOR-B: the text alone, no ZCZC header and no NNNN. Default false. */
  sitorB?: boolean;
  /** Phasing before the message, s (rep/alpha pairs). ITU asks for at least 10. Default 10. */
  phasingSeconds?: number;
  /** Phasing after the message, s. Default 2. */
  tailSeconds?: number;
  /** Peak amplitude. Default 0.5. */
  amplitude?: number;
  /** Swap the tones, as an LSB receiver hears them. Default false. */
  reverse?: boolean;
  figures?: NavtexFigures;
  /**
   * Damage one copy of a character, for testing the time diversity: called for every code
   * of the message (index into ccir476Encode of the full text, header included) and each
   * of its two copies; true sends that copy with its lowest bit flipped (3 or 5 marks).
   */
  corrupt?: (index: number, copy: "dx" | "rx") => boolean;
}

/** What goes on the air for a message: header, text with CR LF line ends, trailer (navtex.cxx:1838-1842). */
export function navtexMessageText(text: string, opts: Pick<NavtexWaveformOptions, "station" | "type" | "serial" | "sitorB"> = {}): string {
  const body = text.replace(/\r?\n/g, "\r\n");
  if (opts.sitorB) return body;
  const serial = String(Math.max(0, Math.min(99, Math.round(opts.serial ?? 1)))).padStart(2, "0");
  return `ZCZC ${(opts.station ?? "Z").toUpperCase()}${(opts.type ?? "I").toUpperCase()}${serial}\r\n${body}\r\nNNNN\r\n\n`;
}

/** The whole stream of 7-bit codes: phasing, the FEC-interleaved message, phasing. */
export function navtexCodeStream(text: string, opts: Omit<NavtexWaveformOptions, "sampleRate"> = {}): number[] {
  const codes = ccir476Encode(navtexMessageText(text, opts), opts.figures);
  const corrupt = opts.corrupt;
  const fec = navtexFecStream(codes);
  if (corrupt) {
    // Slot 4 + 2i is code i's DX copy, slot 9 + 2i its RX copy (navtexFecStream's layout).
    for (let i = 0; i < codes.length; i++) {
      if (corrupt(i, "dx")) fec[4 + 2 * i] = fec[4 + 2 * i]! ^ 1;
      if (corrupt(i, "rx")) fec[9 + 2 * i] = fec[9 + 2 * i]! ^ 1;
    }
  }
  const pairs = (s: number) => Math.max(0, Math.round((s * NAVTEX_BAUD) / (2 * CCIR476_BITS)));
  const out: number[] = [];
  for (let i = 0; i < pairs(opts.phasingSeconds ?? 10); i++) out.push(CCIR476_REP, CCIR476_ALPHA);
  out.push(...fec);
  for (let i = 0; i < pairs(opts.tailSeconds ?? 2); i++) out.push(CCIR476_REP, CCIR476_ALPHA);
  return out;
}

/**
 * FOR TESTS ONLY. A valid SITOR-B / NAVTEX signal for a message: phasing, ZCZC header,
 * text, NNNN, phasing, as continuous-phase FSK on an exact 100-baud time grid. It exists
 * so the receiver can be checked against something known to be right; amateurs do not
 * transmit NAVTEX and nothing should put this on the air.
 */
export function navtexWaveform(text: string, opts: NavtexWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const centre = opts.centreHz ?? NAVTEX_CENTRE_HZ;
  const amp = opts.amplitude ?? 0.5;
  const half = (NAVTEX_SHIFT_HZ / 2) * (opts.reverse ? -1 : 1);
  const codes = navtexCodeStream(text, opts);
  const bits = codes.length * CCIR476_BITS;
  const total = Math.round((bits * fs) / NAVTEX_BAUD);
  const out = new Float32Array(total);
  let phase = 0;
  let n = 0;
  for (let b = 0; b < bits; b++) {
    const code = codes[Math.floor(b / CCIR476_BITS)]!;
    const bit = (code >> (b % CCIR476_BITS)) & 1;
    const dphi = (2 * Math.PI * (centre + (bit ? half : -half))) / fs;
    const end = Math.round(((b + 1) * fs) / NAVTEX_BAUD);
    for (; n < end; n++) {
      out[n] = amp * Math.sin(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

/** How long navtexWaveform's signal for a message lasts, ms. */
export function navtexDurationMs(text: string, opts: Omit<NavtexWaveformOptions, "sampleRate"> = {}): number {
  return ((navtexCodeStream(text, opts).length * CCIR476_BITS) / NAVTEX_BAUD) * 1000;
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export interface NavtexStation {
  country: string;
  /** ITU country code. */
  countryCode: string;
  /** Broadcast frequency, kHz: 518, 490 or 4209.5. */
  kHz: number;
  /** B1, the station's letter. */
  id: string;
  callsign: string;
  name: string;
  /** Degrees, north positive. */
  lat: number;
  /** Degrees, east positive. */
  lon: number;
  /** NAVAREA (Roman numerals; two for a station serving both, "XI/II"). */
  navarea: string;
  /** Language code(s) as the list gives them: EE English, FF French, SS Spanish ... */
  language: string;
}

// The station list is fldigi's data/NAVTEX_Stations.csv (fldigi 4.2.13, GPL v3, compiled
// for fldigi by Remi Chateauneu F4ECW from the ITU and IMO lists). Columns as in the CSV:
// country; country code; kHz; B1; callsign; name; latitude; longitude (converted here from
// "38 32 N" to decimal degrees); NAVAREA; language. Generated, not hand edited.
type Row = readonly [string, string, number, string, string, string, number, number, string, string];
const ROWS: readonly Row[] = [
  ["Azores", "AZR", 490, "J", "CTH", "Horta", 38.533, -28.633, "II", "PP"],
  ["Canada", "CAN", 490, "D", "VCK", "Riviere-au-Renard,  OC", 50.183, -66.117, "IV", "FF"],
  ["Canada", "CAN", 490, "J", "VOO", "Sydney,  NS", 46.183, -59.9, "IV", "FF"],
  ["Canada", "CAN", 490, "S", "VFF", "Iqaluit,  NU", 63.733, -68.55, "IV", "FF"],
  ["Canada", "CAN", 490, "V", "VAR-3", "Fundy,  NB", 43.75, -66.167, "IV", "FF"],
  ["Canary Isles", "CNR", 490, "A", "EAL", "Las Palmas", 28.15, -15.417, "II", "SS"],
  ["Cape Verde", "CPV", 490, "P", "D4A", "Sao Vicente", 16.85, -25, "II", "EE"],
  ["Ecuador", "EOA", 490, "A", "", "Ayora", -0.75, -90.317, "XII", "SS"],
  ["England", "ENG", 490, "T", "GNI", "Niton", 50.583, -1.3, "I", "FF"],
  ["England", "ENG", 490, "I", "GNI", "Niton", 50.583, -1.3, "I", "EE"],
  ["England", "ENG", 490, "U", "GOC", "Cullercoats", 55.067, -1.467, "I", "EE"],
  ["France", "FRA", 490, "E", "FRC", "CROSS Corsen", 48.4, -5.05, "II", "FF"],
  ["France", "FRA", 490, "S", "FRL", "CROSS La Garde", 43.1, 5.983, "III", "FF"],
  ["Germany", "DEU", 490, "L", "DDH47", "Pinneberg", 53.717, 9.917, "I", "DD"],
  ["Iceland", "ISL", 490, "R", "TFA", "Reykiavik", 64.083, -21.85, "I", "IS"],
  ["Italy", "ICH", 490, "I", "IAR", "La Maddalena", 41.217, 9.417, "III", "II"],
  ["Italy", "IQM", 490, "E", "IAR", "Mondolfo", 43.75, 13.083, "III", "II"],
  ["Italy", "ICI", 490, "W", "IAR", "Sellia Marina", 38.9, 16.733, "III", "II"],
  ["Portugal", "POR", 490, "G", "CTV", "Monsanto", 38.733, -9.183, "II", "PP"],
  ["Romania", "ROU", 490, "L", "YOI", "Constanta", 44.2, 28.667, "III", "RO"],
  ["Scotland", "SCT", 490, "C", "GPK", "Portpatrick", 54.85, -5.117, "I", "EE"],
  ["South Korea", "KOR", 490, "J", "", "Chukpyon", 37.05, 129.433, "XI", "KO"],
  ["South Korea", "KOR", 490, "K", "", "Pyonsan", 35.6, 126.483, "XI", "KO"],
  ["Spain", "ESP", 490, "M", "EAV", "Valencia (Cabo de la Nao)", 39.45, -0.333, "III", "SS"],
  ["Spain", "ESP", 490, "T", "EAC", "Tarifa", 36.017, -5.583, "II", "SS"],
  ["Spain", "ESP", 490, "W", "EAR", "Coruna", 43.367, -8.45, "II", "SS"],
  ["Taiwan", "TWN", 490, "V", "", "Lintou", 23.55, 119.633, "XI", "CC"],
  ["Taiwan", "TWN", 490, "X", "XSY", "Yenliaoken", 23.9, 121.6, "XI", "CC"],
  ["Turkey", "TUR", 490, "A", "TAF", "Samsun", 41.283, 36.333, "III", "TT"],
  ["Turkey", "TUR", 490, "B", "TAH", "Istanbul", 41.067, 28.95, "III", "TT"],
  ["Turkey", "TUR", 490, "C", "TAN", "Izmir", 38.367, 26.6, "III", "TT"],
  ["Turkey", "TUR", 490, "D", "TAL", "Antalya", 36.883, 30.7, "III", "TT"],
  ["Uruguay", "URG", 490, "A", "CWM27", "La Paloma", -34.667, -54.15, "VI", "SS"],
  ["Alaska", "ALS", 518, "J", "NOJ", "Kodiak (east of)", 57.767, -152.567, "XII", "EE"],
  ["Alaska", "ALS", 518, "X", "NOJ", "Kodiak (west of)", 57.767, -152.567, "XII", "EE"],
  ["Algeria", "ALG", 518, "B", "7TA", "Alger Radio", 36.667, 3.3, "III", "EE"],
  ["Argentina", "ARG", 518, "A", "L3K", "Ushuaia", -54.8, -68.3, "VI", "SS"],
  ["Argentina", "ARG", 518, "B", "L3D", "Rio Gallegos", -51.617, -69.05, "VI", "SS"],
  ["Argentina", "ARG", 518, "C", "L2W", "Comodoro Rivadavia", -45.85, -67.417, "VI", "SS"],
  ["Argentina", "ARG", 518, "D", "L2l", "Bahia Blanca", -38.717, -62.1, "VI", "SS"],
  ["Argentina", "ARG", 518, "E", "L2P", "Mar del Plata", -38.05, -57.533, "VI", "SS"],
  ["Argentina", "ARG", 518, "H", "L2B", "Buenos Aires", -34.45, -58.617, "VI", "SS"],
  ["Argentina", "ARG", 518, "M", "L3K", "Ushuaia", -54.8, -68.3, "VI", "EE"],
  ["Argentina", "ARG", 518, "N", "L3D", "Rio Gallegos", -51.617, -69.05, "VI", "EE"],
  ["Argentina", "ARG", 518, "O", "L2W", "Comodoro Rivadavia", -45.85, -67.417, "VI", "EE"],
  ["Argentina", "ARG", 518, "P", "L2l", "Bahia Blanca", -38.717, -62.1, "VI", "EE"],
  ["Argentina", "ARG", 518, "O", "L2P", "Mar del Plata", -38.05, -57.533, "VI", "EE"],
  ["Argentina", "ARG", 518, "R", "L2B", "Buenos Aires", -34.45, -58.617, "VI", "EE"],
  ["Azores", "AZR", 518, "F", "CTH", "Horta", 38.533, -28.633, "II", "EE"],
  ["Bahrain", "BHR", 518, "B", "A9M", "Amala", 26.217, 50.65, "IX", "EE"],
  ["Belgium", "BEL", 490, "B", "OST", "Oostende", 51.183, 2.8, "I", "DD"],
  ["Belgium", "BEL", 518, "M", "OST", "Oostende (Thames)", 51.183, 2.8, "I", "EE"],
  ["Belgium", "BEL", 518, "T", "OST", "Oostende", 51.183, 2.8, "I", "EE"],
  ["Bermuda", "BER", 518, "B", "ZBM", "Bermuda Harbour", 32.383, -64.683, "IV", "EE"],
  ["Bulgaria", "BUL", 518, "J", "LZW", "Varna", 43.067, 27.767, "III", "EE"],
  ["Canada", "CAN", 518, "C", "VOK", "Riviere-au-Renard,  OC", 50.183, -66.117, "IV", "EE"],
  ["Canada", "CAN", 518, "D", "VAJ", "Prince Rupert,  BC", 54.3, -130.417, "XII", "EE"],
  ["Canada", "CAN", 518, "H", "XMJ", "329 Prescott,  ON", 45.7, -125.533, "IV", "EE"],
  ["Canada", "CAN", 518, "H", "XLK835", "Tofino,  BC", 48.933, -125.533, "XII", "EE"],
  ["Canada", "CAN", 518, "O", "VON", "St. Johns,  NL", 47.617, -52.667, "IV", "EE"],
  ["Canada", "CAN", 518, "P", "XLJ", "895 Thunder Bay,  ON", 48.433, -89.217, "IV", "EE"],
  ["Canada", "CAN", 518, "O", "VCO", "Sydney,  NS", 46.183, -59.9, "IV", "EE"],
  ["Canada", "CAN", 518, "T", "VFF", "Iqaluit,  NT", 63.733, -68.55, "IV", "EE"],
  ["Canada", "CAN", 518, "U", "VAR-3", "Fundy,  NB", 45.233, -65.983, "IV", "EE"],
  ["Canada", "CAN", 518, "X", "VOK", "Labrador,  NL", 53.3, -60.55, "IV", "EE"],
  ["Canary Isles", "CNR", 518, "I", "EAL", "Las Palmas", 28.15, -15.417, "II", "EE"],
  ["Cape Verde", "CPV", 518, "U", "D4A", "San Vicente", 16.85, -25, "II", "EE"],
  ["Chile", "CHL", 518, "I", "CBV", "Valparaiso", -32.8, -71.483, "XV", "SS"],
  ["Chile", "CHL", 518, "A", "CBA", "Antofgasta", -23.667, -70.417, "XV", "EE"],
  ["Chile", "CHL", 518, "B", "CBV", "Valparaiso", -32.8, -71.483, "XV", "EE"],
  ["Chile", "CHL", 518, "C", "CBT", "Talcahuano", -36.7, -73.1, "XV", "EE"],
  ["Chile", "CHL", 518, "D", "CBP", "Puerto Montt", -41.483, -72.95, "XV", "EE"],
  ["Chile", "CHL", 518, "E", "CBM", "Magallenes", -52.933, -70.9, "XV", "EE"],
  ["Chile", "CHL", 518, "H", "CBA", "Antofgasta", -23.667, -70.417, "XV", "SS"],
  ["Chile", "CHL", 518, "J", "CBT", "Talcahuano", -36.7, -73.1, "XV", "SS"],
  ["Chile", "CHL", 518, "K", "CBP", "Puerto Montt", -41.483, -72.95, "XV", "EE"],
  ["Chile", "CHL", 518, "L", "CBM", "Magallenes", -52.933, -70.9, "XV", "SS"],
  ["China", "CHN", 518, "L", "VRX", "Hong Kong", 22.217, 114.25, "XI", "EE"],
  ["China", "CHN", 518, "M", "XSI", "Sanya", 18.233, 109.5, "XI", "EE/CC"],
  ["China", "CHN", 518, "N", "XSO", "Guangzhou", 23.15, 113.483, "XI", "EE/CC"],
  ["China", "CHN", 518, "O", "XSL", "Foochow", 26.033, 119.3, "XI", "EE"],
  ["China", "CHN", 518, "O", "XSG", "Shanghai", 31.117, 121.55, "XI", "EE"],
  ["China", "CHN", 518, "R", "XSZ", "Dalian", 38.867, 121.517, "XI", "EE"],
  ["Croatia", "HRV", 518, "O", "9AS", "Split", 43.5, 16.483, "III", "EE"],
  ["Cyprus", "CYP", 518, "M", "5BA", "Cyprus", 35.033, 33.283, "III", "EE"],
  ["Easter Island", "PAO", 518, "G", "CBY", "Isla de Pascua", -27.15, -109.383, "XV", "SS"],
  ["Easter Island", "PAO", 518, "H", "CBY", "Isla de Easter", -27.15, -109.383, "XV", "EE"],
  ["Egypt", "EGY", 518, "N", "SUH", "Alexandria", 31.2, 29.867, "III", "EE"],
  ["Egypt", "EGY", 518, "V", "SUK", "Kosseir", 26.1, 34.283, "IX", "EE"],
  ["Egypt", "EGY", 518, "X", "SUZ", "Serapeum (Ismailia)", 30.583, 32.283, "IX", "EE"],
  ["England", "ENG", 518, "E", "GNI", "Niton", 50.583, -1.3, "I", "EE"],
  ["England", "ENG", 518, "G", "GOC", "Cullercoats", 55.067, -1.467, "I", "EE"],
  ["England", "ENG", 518, "K", "GNI", "Niton (Northern France)", 50.583, -1.3, "I", "EE"],
  ["Equador", "EOA", 518, "L", "", "Aycra", -0.75, -90.317, "XII", "EE"],
  ["Equador", "EOA", 518, "M", "HOG", "Guayaquil", -2.283, -72.017, "XII", "EE"],
  ["Estonia", "EST", 518, "U", "ESA", "Tallinn", 59.5, 24.5, "I", "EE"],
  ["Faroes", "FRO", 518, "D", "OXJ", "Torshavn", 62, -6.783, "I", "EE"],
  ["France", "FRA", 518, "A", "FRC", "CROSS Corsen", 48.4, -5.05, "II", "EE"],
  ["France", "FRA", 518, "W", "FRL", "CROSS La Garde", 43.1, 5.983, "III", "EE"],
  ["Germany", "DEU", 518, "L", "DDH47", "Pinneberg", 53.717, 9.917, "I", "EE"],
  ["Greece", "GRC", 518, "H", "SVH", "Irakleio (Crete)", 35.333, 25.117, "III", "EE/GK"],
  ["Greece", "GRC", 518, "K", "SVK", "Kerkyra", 39.75, 19.867, "III", "EE/GK"],
  ["Greece", "GRC", 518, "L", "SVL", "Limnos", 39.867, 25.067, "III", "EE/GK"],
  ["Greenland", "GRL", 518, "W", "OXI", "Nuuk (Kook Island)", 64.067, -52.033, "IV", "EE"],
  ["Guam", "GUM", 518, "V", "NRV", "Guam", 13.483, 144.833, "XI", "EE"],
  ["Hawaii", "HWA", 518, "O", "NMO", "Honolulu", 21.367, -158.15, "XII", "EE"],
  ["Iceland", "ISL", 518, "R", "TFA", "Reykiavik", 64.083, -21.85, "I", "EE"],
  ["Iceland", "ISL", 518, "X", "TFA", "Reykiavik", 64.083, -21.85, "I", "EE"],
  ["India", "IND", 518, "G", "WNB", "Bombay", 19.083, 72.833, "VIII", "EE"],
  ["India", "IND", 518, "P", "VWM", "Madras", 13.083, 80.283, "VIII", "EE"],
  ["Indonesia", "INS", 518, "A", "PNK", "Jayapura", -2.517, 140.717, "XI", "EE"],
  ["Indonesia", "INS", 518, "B", "PKE", "Ambon", -3.7, 128.2, "XI", "EE"],
  ["Indonesia", "INS", 518, "D", "PKF", "Makassar", -5.1, -119.433, "XI", "EE"],
  ["Indonesia", "INS", 518, "E", "PKX", "Jakarta", -6.117, 106.867, "XI", "EE"],
  ["Iran", "IRN", 518, "A", "EQM", "Bushehr", 28.967, 50.833, "IX", "EE"],
  ["Iran", "IRN", 518, "H", "EOI", "Bandar Abbas", 27.133, 57.067, "IX", "EE"],
  ["Ireland", "IRL", 518, "O", "EJM", "Malin Head Coastguard", 55.367, -7.35, "I", "EE"],
  ["Ireland", "IRL", 518, "W", "EJK", "Valentia Coastguard", 51.45, -9.817, "I", "EE"],
  ["Israel", "ISR", 518, "P", "4XO", "Haifa", 32.817, 35, "III", "EE"],
  ["Italy", "ICH", 518, "R", "IAR", "La Maddalena", 41.217, 9.417, "III", "EE"],
  ["Italy", "IQM", 518, "U", "IAR", "Mondolfo", 43.75, 13.083, "III", "EE"],
  ["Italy", "ICI", 518, "V", "IAR", "Sellia Marina", 38.9, 16.733, "III", "EE"],
  ["Japan", "JPN", 518, "G", "JNB", "Naha", 26.15, 127.767, "XI", "EE"],
  ["Japan", "JPN", 518, "H", "JNR", "Moji", 33.867, 130.6, "XI", "EE"],
  ["Japan", "JPN", 518, "I", "JGC", "Yokohama", 35.367, 118.717, "XI", "EE"],
  ["Japan", "JPN", 518, "J", "JNL", "Otaru", 43.2, 141, "XI", "EE"],
  ["Japan", "JPN", 518, "K", "JNX", "Kushiro", 42.983, 144.383, "XI", "EE"],
  ["Malaysia", "MLA", 518, "S", "9WH 21", "Sandakan", 5.9, 118, "XI", "EE"],
  ["Malaysia", "MLA", 518, "T", "9WW", "Miri", 4.467, 114.017, "XI", "EE"],
  ["Malaysia", "MLA", 518, "U", "9MG", "Penang", 5.417, 100.4, "XI", "EE"],
  ["Malta", "MLT", 518, "O", "9HD", "Malta", 35.817, 14.533, "III", "EE"],
  ["Mauritius", "MAU", 518, "C", "MAU", "Mauritius", -20.167, 57.467, "II", "EE"],
  ["Morocco", "MRC", 518, "M", "CNP", "Casablanca", 33.6, -7.633, "II", "EE"],
  ["Namibia", "NMB", 518, "B", "V5W", "Walvis Bay", -23.05, 14.617, "VII", "EE"],
  ["Netherland", "ATN", 518, "H", "JPC", "Curacao", 12.167, -68.867, "IV", "EE"],
  ["Netherlands", "HOL", 518, "P", "PBK", "Netherlands Coast Guard", 52.1, 4.25, "I", "EE"],
  ["Norway", "NOR", 518, "B", "LGP", "Bode", 67.267, 14.383, "I", "EE"],
  ["Norway", "NOR", 518, "L", "LGO", "Rogaland", 58.65, 5.6, "I", "EE"],
  ["Norway", "NOR", 518, "N", "LGD", "Orlandet", 63.667, 9.55, "I", "EE"],
  ["Norway", "NOR", 518, "V", "LGV", "Varde", 70.367, 31.1, "", "EE"],
  ["Oman", "OMA", 518, "M", "A4M", "Muscat", 23.617, 58.517, "IX", "EE"],
  ["Pakistan", "PAK", 518, "P", "ASK", "Karachi", 24.85, 67.05, "IX", "EE"],
  ["Peru", "PRU", 518, "S", "OBY2", "Paita", -5.083, -81.117, "XV", "EE/SS"],
  ["Peru", "PRU", 518, "U", "OBC3", "Callao", -12.05, -77.15, "XV", "EE/SS"],
  ["Peru", "PRU", 518, "W", "OBF4", "Matarani", -17.017, -72.017, "XV", "EE/SS"],
  ["Philipines", "PHL", 518, "I", "", "Puerto Princesa", 9.733, 121.05, "XI", "EE"],
  ["Philipines", "PHL", 518, "J", "DZS", "Manila", 14.583, 121.05, "XI", "EE"],
  ["Philipines", "PHL", 518, "K", "", "Davao", 7.067, 125.6, "XI", "EE"],
  ["Portugal", "POR", 518, "R", "CTV-", "Monsanto", 38.733, -9.183, "II", "EE"],
  ["Puerto Rico", "PTR", 518, "R", "NMR", "Isabella - San Juan,  PR", 18.467, -67.067, "IV", "EE"],
  ["Russia", "RSE", 518, "A", "UIK", "Vladivostok", 43.383, 131.9, "XI/II", "EE"],
  ["Russia", "RSE", 518, "C", "UBA2", "Petropavlovsk", 53.25, 158.417, "XI/II", "EE"],
  ["Russia", "RSE", 518, "D", "UIB", "Magadan", 59.683, 150.15, "XI/II", "EE"],
  ["Russia", "RSE", 518, "G", "", "Okhotsk", 59.367, 143.2, "XI/II", "EE"],
  ["Russia", "RUS", 518, "A", "UDN", "Novorossiysk", 44.717, 37.783, "III", "EE"],
  ["Russia", "RSE", 518, "B", "UFO", "Kholmsk", 47.033, 142.05, "XIII", "EE"],
  ["Russia", "RUS", 518, "C", "UHS", "Murmansk", 68.767, 32.967, "", "EE"],
  ["Russia", "RUS", 518, "H", "UGE", "Arkhangelsk", 64.55, 40.533, "", "EE"],
  ["Russia (Caspian)", "RUS", 518, "W", "UJB", "Astrakhan", 46.3, 47.967, "III", "EE"],
  ["Sardinia", "SAR", 518, "T", "IDC", "Cagliari", 39.233, 9.233, "III", "EE"],
  ["Saudi Arabia", "ARS", 518, "H", "HZH", "Jeddah", 21.383, 39.183, "IX", "EE"],
  ["Scotland", "SCT", 518, "O", "GPK", "Portpatrick", 54.85, -5.117, "I", "EE"],
  ["Sicily", "SCY", 518, "V", "IQA", "Augusta", 37.233, 15.233, "III", "EE"],
  ["Singapore", "SNG", 518, "C", "9VG", "Singapore", 1.333, 103.7, "XI", "EE"],
  ["South Africa", "AFS", 518, "C", "ZSC", "Cape Town", -33.683, 18.717, "VII", "EE"],
  ["South Africa", "AFS", 518, "I", "ZSO", "Port Elizabeth", -33.95, 25.517, "VII", "EE"],
  ["South Africa", "AFS", 518, "O", "ZSD", "Durban", -29.8, 30.817, "VII", "EE"],
  ["South Korea", "KOR", 518, "V", "", "Chukpyon", 37.05, 129.433, "XI", "EE"],
  ["South Korea", "KOR", 518, "W", "", "Pyonsan", 35.6, 126.483, "XI", "EE"],
  ["Spain", "ESP", 518, "D", "EAR", "Coruna", 43.35, -8.45, "II", "EE"],
  ["Spain", "ESP", 518, "G", "EAC", "Tarifa", 36.017, -5.583, "II", "EE"],
  ["Spain", "ESP", 518, "X", "EAV", "Valencia (Cabo de la Nao)", 38.717, -0.15, "III", "EE"],
  ["Svalbard", "SVB", 518, "A", "LGS", "Svalbard", 78.067, 13.6, "", "EE"],
  ["Sweden", "SWE", 518, "H", "SAH", "Bjuroklubb", 64.467, 21.6, "I", "EE"],
  ["Sweden", "SWE", 518, "I", "SAG", "Grimeton", 57.1, 12.383, "I", "EE"],
  ["Sweden", "SWE", 518, "J", "SAA", "Gisovshammar", 55.483, 14.317, "I", "EE"],
  ["Taiwan", "TWN", 518, "P", "", "Lintou", 23.55, 119.633, "XI", "EE"],
  ["Taiwan", "TWN", 518, "P", "", "Yenliaoken", 23.9, 121.6, "XI", "EE"],
  ["Thailand", "THA", 518, "H", "HAS", "Bangkok (Nonthaburi)", 13.017, 100.017, "XI", "EE"],
  ["Turkey", "TUR", 518, "D", "TAH", "Istanbul", 41.067, 28.95, "III", "EE"],
  ["Turkey", "TUR", 518, "H", "TAF", "Samsun", 41.283, 36.333, "III", "EE"],
  ["Turkey", "TUR", 518, "H", "TAL", "Antalya", 36.583, 30.7, "III", "EE"],
  ["Turkey", "TUR", 518, "I", "TAN", "Izmir", 38.35, 26.583, "III", "EE"],
  ["Ukraine", "UKR", 518, "B", "UTW", "Kerch", 44.383, 36.467, "III", "EE"],
  ["Ukraine", "UKR", 518, "C", "UTT", "Odessa", 46.483, 30.733, "III", "EE"],
  ["United States", "USA", 518, "A", "NMA", "Miami,  FL", 25.5, -80.383, "IV", "EE"],
  ["United States", "USA", 518, "C", "NMC", "San Francisco (Point", 37.917, -122.7, "XII", "EE"],
  ["United States", "USA", 518, "H", "NMB", "Savannah,  GA", 32.133, -81.7, "IV", "EE"],
  ["United States", "USA", 518, "H", "NMF", "Boston,  MA", 41.717, -70.517, "IV", "EE"],
  ["United States", "USA", 518, "G", "NMG", "New Orleans,  LA", 29.883, -89.917, "IV", "EE"],
  ["United States", "USA", 518, "N", "NMN", "Portsmouth,  VA", 36.733, -76.017, "IV", "EE"],
  ["United States", "USA", 518, "O", "NMO", "Long Beach,  CA (Cambria)", 35.517, -121.05, "XII", "EE"],
  ["United States", "USA", 518, "W", "NMW", "Astoria,  OR", 46.167, -123.817, "XII", "EE"],
  ["Uruguay", "URG", 518, "H", "CWM27", "La Paloma", -34.667, -54.15, "VI", "EE"],
  ["Vietnam", "VTN", 518, "K", "XVT", "Danang", 16.083, 108.217, "XI", "EE"],
  ["Vietnam", "VTN", 518, "W", "XVG", "Haiphong", 20.733, 106.733, "XI", "EE"],
  ["Vietnam", "VTN", 518, "X", "XVS", "Ho Chi Minh-Ville", 10.783, 106.667, "XI", "EE"],
  ["Egypt", "EGY", 4209.5, "X", "SUZ", "Serapeum (Ismalia)", 30.467, 32.25, "IX", "EE"],
  ["Taiwan", "TWN", 4209.5, "P", "", "Ohi-lung (Keelung)", 25.133, 121.75, "XI", "EE"],
  ["Taiwan", "TWN", 4209.5, "P", "", "Linyuan", 22.483, 120.417, "XI", "EE"],
  ["Taiwan", "TWN", 4209.5, "V", "XSX", "Chi-lung (Keelung)", 25.133, 121.75, "XI", "CC"],
  ["Taiwan", "TWN", 4209.5, "X", "", "Linyuan", 22.483, 120.417, "XI", "CC"],
  ["Turkey", "TUR", 4209.5, "M", "TAH", "Istanbul", 41.067, 28.95, "III", "TT"],
  ["Vietnam", "VTN", 4209.5, "W", "", "Haiphong", 20.733, 106.733, "XI", ""],
];

/** fldigi's station list, as typed records. */
export const NAVTEX_STATIONS: readonly NavtexStation[] = ROWS.map(([country, countryCode, kHz, id, callsign, name, lat, lon, navarea, language]) => ({
  country,
  countryCode,
  kHz,
  id,
  callsign,
  name,
  lat,
  lon,
  navarea,
  language,
}));

/** Every station with a B1 letter, optionally on one frequency (kHz, within 1 %). */
export function navtexStations(id: string, kHz?: number): NavtexStation[] {
  const b1 = id.toUpperCase();
  return NAVTEX_STATIONS.filter((s) => s.id === b1 && (kHz === undefined || Math.abs(s.kHz - kHz) <= s.kHz * 0.01));
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Which station sent a message: fldigi's FindStation (navtex.cxx:335-462). B1 letters are
 * reused around the world, so the candidates on the frequency are narrowed by where the
 * listener is (nearest first) and, when there is still a choice, by a station name that
 * appears in the message text (fldigi uses an edit distance under 2; here the name must
 * appear as a word). Without a position the first candidate is returned only if it is the
 * only one. fldigi's frequency test is always true through a misplaced `||`
 * (freq_close, navtex.cxx:282-286); here it is the 1 % it means.
 */
export function navtexStation(
  id: string,
  opts: { kHz?: number; lat?: number; lon?: number; text?: string } = {},
): NavtexStation | null {
  let cands = navtexStations(id, opts.kHz);
  if (cands.length === 0 && opts.kHz !== undefined) cands = navtexStations(id);
  if (cands.length <= 1) return cands[0] ?? null;
  if (opts.text) {
    const words = new Set(opts.text.toUpperCase().split(/[^A-Z]+/));
    const named = cands.filter((s) => s.name.toUpperCase().split(/[^A-Z]+/).some((w) => w.length > 3 && words.has(w)));
    if (named.length === 1) return named[0]!;
  }
  if (opts.lat === undefined || opts.lon === undefined) return null;
  const { lat, lon } = opts as { lat: number; lon: number };
  return [...cands].sort((a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon))[0]!;
}

// RSID: the Reed-Solomon mode identifier fldigi sends before a transmission.
//
// A two-second burst of fifteen tones, 10.766 Hz apart, each 93 ms, that names the mode
// and marks where the signal is: a station that hears it can switch to that mode and that
// frequency without being told. fldigi, and most programs that follow it, send one when
// TxID is on and act on one when RxID is on.
//
// Ported from fldigi 4.2.13, src/rsid/rsid.cxx and rsid_defs.cxx (GPL; Patrick Lindecker
// F6CTE's design, Dave Freese W1HKJ's implementation):
//
//   THE CODE. A mode number of up to 12 bits is spread to fifteen 4-bit symbols by a
//   Reed-Solomon (15,3) code over GF(16) (Encode). A receiver accepts a word within one
//   symbol of a known one, so one tone lost to fading or QRM still identifies the mode.
//
//   ON THE AIR. Everything happens at 11025 samples a second, the rate the design was
//   made for: a symbol is 1024 samples (92.9 ms), a tone step is 11025/1024 Hz. Tone 0
//   sits 7 steps below the mode's carrier, so the burst straddles where the signal will
//   be. Five symbols of silence before it, the fifteen tones, five of silence after.
//
//   THE RECEIVER. A 2048-sample FFT (Hamming window) every 512 samples: two hops a
//   symbol, 5.38 Hz bins, two bins a tone. For each bin, which of the 16 tone positions
//   above it is loudest is remembered for the last thirty hops; a word is read from every
//   other hop (one per symbol) and compared with every known word.
//
//   TWO TABLES. Codes past the first table's room are sent as ESCAPE, ten symbols of
//   silence, then a second word from the second table.

import type { HellVariant } from "@/lib/digital/hell";
import type { OliviaBandwidth, OliviaCode, OliviaTones } from "@/lib/digital/olivia";
import type { PskSpeed } from "@/lib/digital/psk31";
import { modemForRsid, type ModemId } from "@/lib/radio/modems";

export const RSID_SAMPLE_RATE = 11025;
/** Samples a symbol at 11025: 92.9 ms. */
export const RSID_SYMBOL_SAMPLES = 1024;
export const RSID_SYMBOLS = 15;
/** The tone step, Hz: 10.766. */
export const RSID_TONE_HZ = RSID_SAMPLE_RATE / RSID_SYMBOL_SAMPLES;
const SYMBOL_SECONDS = RSID_SYMBOL_SAMPLES / RSID_SAMPLE_RATE;

const FFT_LEN = 2048;
const HOP = 512;
const BINS = 1024;
const NTIMES = RSID_SYMBOLS * 2;
/** Symbols a word may differ by and still be read: fldigi's default, "medium". */
const HAMMING_ALLOWED = 1;
const BIN_LOW = 10;
/** The resampler: taps either side of an output instant, and the fractional offsets tabled. */
const TAPS = 64;
const PHASES = 256;
const BIN_HIGH = BINS - 32;

/** GF(16) multiplication table, row-major: SQUARES[a * 16 + b] = a * b. */
const SQUARES = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  0, 2, 4, 6, 8, 10, 12, 14, 9, 11, 13, 15, 1, 3, 5, 7,
  0, 3, 6, 5, 12, 15, 10, 9, 1, 2, 7, 4, 13, 14, 11, 8,
  0, 4, 8, 12, 9, 13, 1, 5, 11, 15, 3, 7, 2, 6, 10, 14,
  0, 5, 10, 15, 13, 8, 7, 2, 3, 6, 9, 12, 14, 11, 4, 1,
  0, 6, 12, 10, 1, 7, 13, 11, 2, 4, 14, 8, 3, 5, 15, 9,
  0, 7, 14, 9, 5, 2, 11, 12, 10, 13, 4, 3, 15, 8, 1, 6,
  0, 8, 9, 1, 11, 3, 2, 10, 15, 7, 6, 14, 4, 12, 13, 5,
  0, 9, 11, 2, 15, 6, 4, 13, 7, 14, 12, 5, 8, 1, 3, 10,
  0, 10, 13, 7, 3, 9, 14, 4, 6, 12, 11, 1, 5, 15, 8, 2,
  0, 11, 15, 4, 7, 12, 8, 3, 14, 5, 1, 10, 9, 2, 6, 13,
  0, 12, 1, 13, 2, 14, 3, 15, 4, 8, 5, 9, 6, 10, 7, 11,
  0, 13, 3, 14, 6, 11, 5, 8, 12, 1, 15, 2, 10, 7, 9, 4,
  0, 14, 5, 11, 10, 4, 15, 1, 13, 3, 8, 6, 7, 9, 2, 12,
  0, 15, 7, 8, 14, 1, 9, 6, 5, 10, 2, 13, 11, 4, 12, 3,
];
const INDICES = [2, 4, 8, 9, 11, 15, 7, 14, 5, 10, 13, 3];

/** The fifteen tone numbers (0-15) that send a mode's code. */
export function rsidEncode(code: number): number[] {
  const r = new Array<number>(RSID_SYMBOLS).fill(0);
  r[0] = code >> 8;
  r[1] = (code >> 4) & 0x0f;
  r[2] = code & 0x0f;
  for (let i = 0; i < 12; i++) {
    for (let j = RSID_SYMBOLS - 1; j > 0; j--) r[j] = r[j - 1]! ^ SQUARES[(r[j]! << 4) + INDICES[i]!]!;
    r[0] = SQUARES[(r[0]! << 4) + INDICES[i]!]!;
  }
  return r;
}

/** What a heard RSID asks this station to switch to, for the modes DigiShack has. */
export type RsidMode =
  | { mode: "PSK31"; speed: PskSpeed; qpsk?: boolean; pskr?: boolean }
  | { mode: "RTTY"; baud: number; shiftHz: number }
  | { mode: "OLIVIA"; code: OliviaCode; tones: OliviaTones; bandwidth: OliviaBandwidth }
  | { mode: "HELL"; variant: HellVariant }
  | { mode: "CW" }
  /** A registered modem (lib/radio/modems.ts): MFSK, DominoEX, MT63. */
  | { mode: ModemId; sub: string };

export interface RsidEntry {
  code: number;
  /** fldigi's name for it. */
  name: string;
  /** Set when DigiShack has the mode. */
  mode?: RsidMode;
}

const ol = (code: OliviaCode, tones: OliviaTones, bandwidth: OliviaBandwidth): RsidMode => ({ mode: "OLIVIA", code, tones, bandwidth });

/** fldigi's first table, in its order (rsid_defs.cxx). */
export const RSID_TABLE: readonly RsidEntry[] = [
  { code: 263, name: "EOT" },
  { code: 6, name: "ESCAPE" },
  { code: 1, name: "BPSK31", mode: { mode: "PSK31", speed: 31 } },
  { code: 110, name: "QPSK31", mode: { mode: "PSK31", speed: 31, qpsk: true } },
  { code: 2, name: "BPSK63", mode: { mode: "PSK31", speed: 63 } },
  { code: 3, name: "QPSK63", mode: { mode: "PSK31", speed: 63, qpsk: true } },
  { code: 4, name: "BPSK125", mode: { mode: "PSK31", speed: 125 } },
  { code: 5, name: "QPSK125", mode: { mode: "PSK31", speed: 125, qpsk: true } },
  { code: 126, name: "BPSK250", mode: { mode: "PSK31", speed: 250 } },
  { code: 127, name: "QPSK250" },
  { code: 173, name: "BPSK500", mode: { mode: "PSK31", speed: 500 } },
  { code: 183, name: "PSK125R", mode: { mode: "PSK31", speed: 125, pskr: true } },
  { code: 186, name: "PSK250R", mode: { mode: "PSK31", speed: 250, pskr: true } },
  { code: 187, name: "PSK500R", mode: { mode: "PSK31", speed: 500, pskr: true } },
  { code: 7, name: "PSKFEC31" },
  { code: 8, name: "PSK10" },
  { code: 9, name: "MT63-500L" },
  { code: 10, name: "MT63-500S" },
  { code: 11, name: "MT63-500VS" },
  { code: 12, name: "MT63-1000L" },
  { code: 13, name: "MT63-1000S" },
  { code: 14, name: "MT63-1000VS" },
  { code: 15, name: "MT63-2000L" },
  { code: 17, name: "MT63-2000S" },
  { code: 18, name: "MT63-2000VS" },
  { code: 19, name: "PSKAM10" },
  { code: 20, name: "PSKAM31" },
  { code: 21, name: "PSKAM50" },
  { code: 22, name: "PSK63F", mode: { mode: "PSK31", speed: 63, pskr: true } },
  { code: 23, name: "PSK220F" },
  { code: 24, name: "CHIP64" },
  { code: 25, name: "CHIP128" },
  { code: 26, name: "CW", mode: { mode: "CW" } },
  { code: 27, name: "CCW-OOK-12" },
  { code: 28, name: "CCW-OOK-24" },
  { code: 29, name: "CCW-OOK-48" },
  { code: 30, name: "CCW-FSK-12" },
  { code: 31, name: "CCW-FSK-24" },
  { code: 33, name: "CCW-FSK-48" },
  { code: 34, name: "PACTOR1-FEC" },
  { code: 113, name: "PACKET-110" },
  { code: 35, name: "PACKET-300" },
  { code: 36, name: "PACKET-1200" },
  { code: 37, name: "RTTY-ASCII-7" },
  { code: 38, name: "RTTY-ASCII-8" },
  { code: 39, name: "RTTY-45", mode: { mode: "RTTY", baud: 45.45, shiftHz: 170 } },
  { code: 40, name: "RTTY-50", mode: { mode: "RTTY", baud: 50, shiftHz: 170 } },
  { code: 41, name: "RTTY-75", mode: { mode: "RTTY", baud: 75, shiftHz: 850 } },
  { code: 42, name: "AMTOR-FEC" },
  { code: 43, name: "THROB-1" },
  { code: 44, name: "THROB-2" },
  { code: 45, name: "THROB-4" },
  { code: 46, name: "THROBX-1" },
  { code: 47, name: "THROBX-2" },
  { code: 146, name: "THROBX-4" },
  { code: 204, name: "CONTESTIA-4-125", mode: ol("contestia", 4, 125) },
  { code: 55, name: "CONTESTIA-4-250", mode: ol("contestia", 4, 250) },
  { code: 54, name: "CONTESTIA-4-500", mode: ol("contestia", 4, 500) },
  { code: 255, name: "CONTESTIA-4-1000", mode: ol("contestia", 4, 1000) },
  { code: 254, name: "CONTESTIA-4-2000", mode: ol("contestia", 4, 2000) },
  { code: 169, name: "CONTESTIA-8-125", mode: ol("contestia", 8, 125) },
  { code: 49, name: "CONTESTIA-8-250", mode: ol("contestia", 8, 250) },
  { code: 52, name: "CONTESTIA-8-500", mode: ol("contestia", 8, 500) },
  { code: 117, name: "CONTESTIA-8-1000", mode: ol("contestia", 8, 1000) },
  { code: 247, name: "CONTESTIA-8-2000", mode: ol("contestia", 8, 2000) },
  { code: 275, name: "CONTESTIA-16-250", mode: ol("contestia", 16, 250) },
  { code: 50, name: "CONTESTIA-16-500", mode: ol("contestia", 16, 500) },
  { code: 53, name: "CONTESTIA-16-1000", mode: ol("contestia", 16, 1000) },
  { code: 259, name: "CONTESTIA-16-2000", mode: ol("contestia", 16, 2000) },
  { code: 51, name: "CONTESTIA-32-1000", mode: ol("contestia", 32, 1000) },
  { code: 201, name: "CONTESTIA-32-2000", mode: ol("contestia", 32, 2000) },
  { code: 194, name: "CONTESTIA-64-500", mode: ol("contestia", 64, 500) },
  { code: 193, name: "CONTESTIA-64-1000", mode: ol("contestia", 64, 1000) },
  { code: 191, name: "CONTESTIA-64-2000", mode: ol("contestia", 64, 2000) },
  { code: 56, name: "VOICE" },
  { code: 60, name: "MFSK8" },
  { code: 57, name: "MFSK16" },
  { code: 147, name: "MFSK32" },
  { code: 148, name: "MFSK11" },
  { code: 152, name: "MFSK22" },
  { code: 61, name: "RTTYM-8-250" },
  { code: 62, name: "RTTYM-16-500" },
  { code: 63, name: "RTTYM-32-1000" },
  { code: 65, name: "RTTYM-8-500" },
  { code: 66, name: "RTTYM-16-1000" },
  { code: 67, name: "RTTYM-4-500" },
  { code: 68, name: "RTTYM-4-250" },
  { code: 119, name: "RTTYM-8-1000" },
  { code: 170, name: "RTTYM-8-125" },
  { code: 203, name: "OLIVIA-4-125", mode: ol("olivia", 4, 125) },
  { code: 75, name: "OLIVIA-4-250", mode: ol("olivia", 4, 250) },
  { code: 74, name: "OLIVIA-4-500", mode: ol("olivia", 4, 500) },
  { code: 229, name: "OLIVIA-4-1000", mode: ol("olivia", 4, 1000) },
  { code: 238, name: "OLIVIA-4-2000", mode: ol("olivia", 4, 2000) },
  { code: 163, name: "OLIVIA-8-125", mode: ol("olivia", 8, 125) },
  { code: 69, name: "OLIVIA-8-250", mode: ol("olivia", 8, 250) },
  { code: 72, name: "OLIVIA-8-500", mode: ol("olivia", 8, 500) },
  { code: 116, name: "OLIVIA-8-1000", mode: ol("olivia", 8, 1000) },
  { code: 214, name: "OLIVIA-8-2000", mode: ol("olivia", 8, 2000) },
  { code: 70, name: "OLIVIA-16-500", mode: ol("olivia", 16, 500) },
  { code: 73, name: "OLIVIA-16-1000", mode: ol("olivia", 16, 1000) },
  { code: 234, name: "OLIVIA-16-2000", mode: ol("olivia", 16, 2000) },
  { code: 71, name: "OLIVIA-32-1000", mode: ol("olivia", 32, 1000) },
  { code: 221, name: "OLIVIA-32-2000", mode: ol("olivia", 32, 2000) },
  { code: 211, name: "OLIVIA-64-2000", mode: ol("olivia", 64, 2000) },
  { code: 76, name: "PAX" },
  { code: 77, name: "PAX2" },
  { code: 78, name: "DOMINOF" },
  { code: 79, name: "FAX" },
  { code: 81, name: "SSTV" },
  { code: 84, name: "DOMINOEX-4" },
  { code: 85, name: "DOMINOEX-5" },
  { code: 86, name: "DOMINOEX-8" },
  { code: 87, name: "DOMINOEX-11" },
  { code: 88, name: "DOMINOEX-16" },
  { code: 90, name: "DOMINOEX-22" },
  { code: 92, name: "DOMINOEX-4-FEC" },
  { code: 93, name: "DOMINOEX-5-FEC" },
  { code: 97, name: "DOMINOEX-8-FEC" },
  { code: 98, name: "DOMINOEX-11-FEC" },
  { code: 99, name: "DOMINOEX-16-FEC" },
  { code: 101, name: "DOMINOEX-22-FEC" },
  { code: 104, name: "FELD-HELL", mode: { mode: "HELL", variant: "feld" } },
  // fldigi's own PSK Hell has a code but no modem; DigiShack's PSK Hell is not that one.
  { code: 105, name: "PSK-HELL" },
  { code: 106, name: "HELL-80", mode: { mode: "HELL", variant: "hell80" } },
  { code: 107, name: "FM-HELL-105", mode: { mode: "HELL", variant: "fm105" } },
  { code: 108, name: "FM-HELL-245", mode: { mode: "HELL", variant: "fm245" } },
  { code: 114, name: "MODE-141A" },
  { code: 123, name: "DTMF" },
  { code: 125, name: "ALE400" },
  { code: 131, name: "FDMDV" },
  { code: 132, name: "JT65-A" },
  { code: 134, name: "JT65-B" },
  { code: 135, name: "JT65-C" },
  { code: 136, name: "THOR-4" },
  { code: 137, name: "THOR-8" },
  { code: 138, name: "THOR-16" },
  { code: 139, name: "THOR-5" },
  { code: 143, name: "THOR-11" },
  { code: 145, name: "THOR-22" },
  { code: 153, name: "CALL-ID" },
  { code: 155, name: "PACKET-PSK1200" },
  { code: 156, name: "PACKET-PSK250" },
  { code: 159, name: "PACKET-PSK63" },
  { code: 172, name: "MODE-188-110A-8N1" },
];

/** fldigi's second table: sent after ESCAPE. None are modes DigiShack has yet. */
export const RSID_TABLE2: readonly RsidEntry[] = [
  [450, "PSK63RX4"], [457, "PSK63RX5"], [458, "PSK63RX10"], [460, "PSK63RX20"], [462, "PSK63RX32"],
  [467, "PSK125RX4"], [497, "PSK125RX5"], [513, "PSK125RX10"], [519, "PSK125X12"], [522, "PSK125RX12"], [527, "PSK125RX16"],
  [529, "PSK250RX2"], [533, "PSK250RX3"], [539, "PSK250RX5"], [541, "PSK250X6"], [545, "PSK250RX6"], [551, "PSK250RX7"],
  [553, "PSK500RX2"], [558, "PSK500RX3"], [564, "PSK500RX4"], [566, "PSK500X2"], [569, "PSK500X4"],
  [570, "PSK1000"], [580, "PSK1000R"], [587, "PSK1000X2"], [595, "PSK1000RX2"], [604, "PSK800RX2"], [610, "PSK800X2"],
  [620, "MFSK64"], [625, "MFSK128"],
  [639, "THOR25x4"], [649, "THOR50x1"], [653, "THOR50x2"], [658, "THOR100"], [2119, "THOR32"], [2156, "THOR44"], [2157, "THOR56"], [713, "THOR25"],
  [662, "DOMINOEX-44"], [681, "DOMINOEX-88"], [687, "MFSK31"], [691, "DOMINOEX-MICRO"], [693, "THOR-MICRO"],
  [1026, "MFSK64L"], [1029, "MFSK128L"],
  [1066, "8PSK125"], [1071, "8PSK250"], [1076, "8PSK500"], [1047, "8PSK1000"],
  [1037, "8PSK125F"], [1038, "8PSK250F"], [1043, "8PSK500F"], [1078, "8PSK1000F"], [1058, "8PSK1200F"],
  [1239, "8PSK125FL"], [2052, "8PSK250FL"], [2053, "OFDM500F"], [2094, "OFDM750F"], [1171, "IFKP"],
].map(([code, name]) => ({ code: code as number, name: name as string }));

const RSID_ESCAPE = 6;
const RSID_EOT = 263;

/** The code fldigi sends for a mode as DigiShack runs it, or null when fldigi has none. */
export function rsidCodeFor(m: RsidMode): number | null {
  const hit = RSID_TABLE.find((e) => {
    const x = e.mode;
    if (!x || x.mode !== m.mode) return false;
    switch (m.mode) {
      case "PSK31":
        return (
          (x as typeof m).speed === m.speed &&
          ((x as typeof m).qpsk ?? false) === (m.qpsk ?? false) &&
          ((x as typeof m).pskr ?? false) === (m.pskr ?? false)
        );
      case "RTTY":
        return (x as typeof m).baud === m.baud && (x as typeof m).shiftHz === m.shiftHz;
      case "OLIVIA": {
        const o = x as typeof m;
        return o.code === m.code && o.tones === m.tones && o.bandwidth === m.bandwidth;
      }
      case "HELL":
        return (x as typeof m).variant === m.variant;
      case "CW":
        return true;
    }
    return false;
  });
  return hit?.code ?? null;
}

/** How long an RSID takes on the air, ms: five symbols of silence, fifteen tones, five more. */
export const RSID_DURATION_MS = 25 * SYMBOL_SECONDS * 1000;

/**
 * The RSID burst for `code` at `sampleRate`, centred on the mode's carrier `centreHz` as
 * fldigi sends it: tone 0 seven steps below. Silence before and after, as fldigi's.
 */
export function rsidWaveform(code: number, opts: { sampleRate: number; centreHz: number; amplitude?: number }): Float32Array {
  const fs = opts.sampleRate;
  const symLen = Math.floor(SYMBOL_SECONDS * fs);
  const amp = opts.amplitude ?? 1;
  const out = new Float32Array(symLen * 25);
  const base = opts.centreHz - 7 * RSID_TONE_HZ;
  let phase = 0;
  let at = symLen * 5;
  for (const tone of rsidEncode(code)) {
    const inc = (2 * Math.PI * (base + tone * RSID_TONE_HZ)) / fs;
    for (let j = 0; j < symLen; j++) {
      phase += inc;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      out[at++] = amp * Math.sin(phase);
    }
  }
  return out;
}

export interface RsidHeard {
  code: number;
  name: string;
  /** Set when DigiShack has the mode. */
  mode?: RsidMode;
  /** The mode's carrier, Hz audio, as fldigi computes it. */
  hz: number;
  /** End of transmission rather than a mode. */
  eot: boolean;
}

interface WordIndex {
  /** Words by their first symbol, and by their second. */
  byFirst: { entry: RsidEntry; word: number[] }[][];
  bySecond: { entry: RsidEntry; word: number[] }[][];
}

function indexWords(table: readonly RsidEntry[]): WordIndex {
  const byFirst = Array.from({ length: 16 }, () => [] as { entry: RsidEntry; word: number[] }[]);
  const bySecond = Array.from({ length: 16 }, () => [] as { entry: RsidEntry; word: number[] }[]);
  for (const entry of table) {
    const word = rsidEncode(entry.code);
    byFirst[word[0]!]!.push({ entry, word });
    bySecond[word[1]!]!.push({ entry, word });
  }
  return { byFirst, bySecond };
}

/** Radix-2 complex FFT, in place, for one size. */
class Fft {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  constructor(private readonly n: number) {
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  /** `re` in (real input), power spectrum of the first n/2 bins out. */
  power(input: Float64Array, out: Float64Array): void {
    const n = this.n;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[this.rev[i]!] = input[i]!;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const c = this.cos[j * step]!;
          const s = this.sin[j * step]!;
          const a = i + j;
          const b = a + half;
          const tr = re[b]! * c - im[b]! * s;
          const ti = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = re[i]! * re[i]! + im[i]! * im[i]!;
  }
}

/**
 * Listens for RSIDs in the received audio, at whatever rate the radio delivers: the audio
 * is low-passed and brought to 11025, then searched as fldigi searches it, across the
 * whole passband.
 */
export class RsidDetector {
  private readonly inRate: number;
  private readonly onHeard: (h: RsidHeard) => void;
  // Resampling to 11025 by windowed sinc, evaluated at each output instant from a table of
  // PHASES fractional offsets. Not a filter then linear interpolation: interpolating at 24
  // kHz leaves images of every tone at 24000 - f, and sampling at 11025 folds 21800 Hz to
  // 250 Hz. The image of a 2200 Hz RSID, 39 dB down but alone at the bottom of the band,
  // spelled the same word there and was found first.
  private readonly kernel: Float64Array[];
  /** The last TAPS inputs, twice over, so a window of them is always one contiguous run. */
  private readonly ring: Float64Array;
  private ringAt = 0;
  /** Inputs seen. */
  private count = 0;
  private readonly step: number;
  /** The next output instant, in input samples. */
  private next = 0;

  private readonly buf = new Float64Array(FFT_LEN);
  private filled = BINS;
  private readonly window = new Float64Array(FFT_LEN);
  private readonly windowed = new Float64Array(FFT_LEN);
  private readonly spectrum = new Float64Array(BINS);
  private readonly fft = new Fft(FFT_LEN);
  /** For each of the last thirty hops, each bin's loudest tone position above it. */
  private readonly buckets: Int8Array[] = Array.from({ length: NTIMES }, () => new Int8Array(BINS));
  /** After ESCAPE: seconds left to hear the second word in. */
  private secondaryLeft = 0;
  private readonly words1: WordIndex;
  private readonly words2: WordIndex;

  constructor(inRate: number, onHeard: (h: RsidHeard) => void) {
    this.inRate = inRate;
    this.onHeard = onHeard;
    // Input samples per output sample.
    this.step = inRate / RSID_SAMPLE_RATE;
    // Cut at 4.5 kHz (or below the input's own Nyquist): the radio's passband is under 3
    // kHz, and the search stops at 5.3 kHz.
    const fc = Math.min(4500, inRate / 2 - 500) / inRate;
    this.kernel = [];
    for (let ph = 0; ph <= PHASES; ph++) {
      const frac = ph / PHASES;
      const k = new Float64Array(TAPS);
      let sum = 0;
      for (let i = 0; i < TAPS; i++) {
        // Tap i is the input at offset i - (TAPS/2 - 1) from floor(t); its distance from t.
        const tau = i - (TAPS / 2 - 1) - frac;
        const sinc = Math.abs(tau) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * tau) / (Math.PI * tau);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * tau) / (TAPS / 2));
        k[i] = sinc * w;
        sum += k[i]!;
      }
      for (let i = 0; i < TAPS; i++) k[i]! /= sum;
      this.kernel.push(k);
    }
    this.ring = new Float64Array(2 * TAPS);
    // The first output waits for a full window of inputs behind it and ahead of it.
    this.next = TAPS / 2 - 1;
    for (let i = 0; i < FFT_LEN; i++) this.window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / FFT_LEN);
    this.words1 = indexWords(RSID_TABLE);
    this.words2 = indexWords(RSID_TABLE2);
  }

  reset(): void {
    for (const b of this.buckets) b.fill(0);
    this.buf.fill(0);
    this.filled = BINS;
    this.secondaryLeft = 0;
  }

  feed(samples: ArrayLike<number>): void {
    if (this.secondaryLeft > 0) {
      this.secondaryLeft -= samples.length / this.inRate;
      if (this.secondaryLeft <= 0) this.reset();
    }
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      this.ring[this.ringAt] = x;
      this.ring[this.ringAt + TAPS] = x;
      this.ringAt = (this.ringAt + 1) % TAPS;
      this.count++;
      // Every output whose window of inputs has now all arrived: floor(t) + TAPS/2 inputs.
      while (Math.floor(this.next) + TAPS / 2 < this.count) {
        const base = Math.floor(this.next);
        const k = this.kernel[Math.round((this.next - base) * PHASES)]!;
        // The window starts TAPS/2 - 1 before base; that input sits this far back in the ring.
        const first = base - (TAPS / 2 - 1);
        const at = (this.ringAt - (this.count - first) + 2 * TAPS) % TAPS;
        let y = 0;
        for (let j = 0; j < TAPS; j++) y += k[j]! * this.ring[at + j]!;
        this.push(y);
        this.next += this.step;
      }
    }
  }

  private push(x: number): void {
    this.buf[this.filled++] = x;
    if (this.filled < FFT_LEN) return;
    this.search();
    this.buf.copyWithin(0, HOP);
    this.filled -= HOP;
  }

  private search(): void {
    for (let i = 0; i < FFT_LEN; i++) this.windowed[i] = this.buf[i]! * this.window[i]!;
    this.fft.power(this.windowed, this.spectrum);
    // Age the history a hop and work out the newest row.
    const oldest = this.buckets.shift()!;
    oldest.fill(0);
    this.buckets.push(oldest);
    const row = oldest;
    const sp = this.spectrum;
    for (let i = 3; i < BIN_HIGH - NTIMES; i++) {
      let best = 0;
      let bestAmp = sp[i]!;
      for (let t = 1; t < 16; t++) {
        const a = sp[i + 2 * t]!;
        if (a > bestAmp) {
          bestAmp = a;
          best = t;
        }
      }
      row[i] = best;
    }

    if (this.secondaryLeft <= 0) {
      const hit = this.match(this.words1);
      if (!hit) return;
      if (hit.entry.code === RSID_ESCAPE) {
        // Ten symbols of silence, then the second word: 27 symbols to hear it in.
        this.secondaryLeft = 27 * SYMBOL_SECONDS;
        return;
      }
      this.heard(hit.entry, hit.bin);
      this.reset();
      return;
    }
    const hit2 = this.match(this.words2);
    if (hit2) {
      this.heard(hit2.entry, hit2.bin);
      this.reset();
    }
  }

  /** The best word within the allowed distance, read one symbol per two hops. */
  private match(words: WordIndex): { entry: RsidEntry; bin: number } | null {
    let bestDist = HAMMING_ALLOWED + 1;
    let best: { entry: RsidEntry; bin: number } | null = null;
    const b = this.buckets;
    const first = b[1]!;
    const second = b[3]!;
    for (let j = BIN_LOW; j < BIN_HIGH - NTIMES; j++) {
      // A word within one symbol agrees on its first symbol or its second: only those
      // need reading. Twenty-odd words a bin instead of all of them.
      for (const cands of [words.byFirst[first[j]!]!, words.bySecond[second[j]!]!]) {
        for (const { entry, word } of cands) {
          let d = 0;
          for (let s = 0, row = 1; s < RSID_SYMBOLS; s++, row += 2) {
            if (b[row]![j] !== word[s]) {
              if (++d >= bestDist) break;
            }
          }
          if (d < bestDist) {
            bestDist = d;
            best = { entry, bin: j };
            if (d === 0) return best;
          }
        }
      }
    }
    return best;
  }

  private heard(entry: RsidEntry, bin: number): void {
    // The carrier is seven tones, fourteen bins, above tone 0. fldigi adds fourteen and a
    // half, which reads its own signal 2.7 Hz high; the centre is what a click wants.
    const hz = ((bin + 14) * RSID_SAMPLE_RATE) / FFT_LEN;
    // A modem names its own codes in lib/radio/modems.ts, once it is registered.
    const m = modemForRsid(entry.code);
    const mode: RsidMode | undefined = entry.mode ?? (m ? { mode: m.modem, sub: m.sub } : undefined);
    this.onHeard({ code: entry.code, name: entry.name, mode, hz: Math.round(hz * 10) / 10, eot: entry.code === RSID_EOT });
  }
}

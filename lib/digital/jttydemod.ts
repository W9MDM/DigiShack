// The JTTY receiver: every station in the passband, as it transmits.
//
// JTTY has no time slots, so this runs on the stream pipeline like RTTY: audio in as it
// arrives, text out when a message ends. It follows jtty_decode.f90 in shape:
//
//   1. Decimate to 6000 samples a second, where a symbol is 192 samples.
//   2. A spectrogram one symbol long every 48 samples (8 ms), zero-padded to 384 points:
//      bins 15.625 Hz, so a tone sits two bins from the next.
//   3. At each column and bin, the 13-symbol sync scored as the share of each sync
//      symbol's power that is on the tone the sequence says: 1 on a clean signal, 1/4 on
//      noise. Local peaks over a threshold are candidates.
//   4. A candidate is refined - frequency to a hertz, then time to two milliseconds - by
//      correlating the sync's exact tones; the 46 data symbols' four tone energies go to
//      the wrap-around Viterbi, and a payload that passes the CRC, the reserved bit and
//      the grammar is a frame.
//   5. Frames are joined per station - the same frequency, each frame where the last one
//      ended - and a message is printed when its end-of-message frame arrives, or after
//      two frames of silence with what arrived.
//
// WSJT-X's own receiver adds a coherent list decoder, signal subtraction and AFC; this is
// the reference decoder they began from, which decodes the same signals a few dB less deep.

import { fftMixed } from "@/lib/dsp/fft-mixed";
import {
  JTTY_BAUD,
  JTTY_FRAME_SYMBOLS,
  JTTY_SYNC,
  JTTY_SYNC_SYMBOLS,
  jttyDecodeEnergies,
  jttyJoinAtoms,
  jttyRenderAtom,
  jttyUnpackAtom,
  type JttyAtom,
} from "@/lib/digital/jtty";

const FS = 6000;
const NSS = FS / JTTY_BAUD; // 192
const HOP = NSS / 4; // 48
const NFFT = 2 * NSS; // 384
const BIN_HZ = FS / NFFT; // 15.625
const FRAME = JTTY_FRAME_SYMBOLS * NSS; // 11328 samples
/** Lowest tone searched, and highest: the top tone must stay under 3 kHz. */
const LO_HZ = 200;
const HI_HZ = 2800;
const BIN_LO = Math.ceil(LO_HZ / BIN_HZ);
const BIN_HI = Math.floor(HI_HZ / BIN_HZ);
const SYNC_SPAN = (JTTY_SYNC_SYMBOLS - 1) * 4; // columns from first to last sync symbol
const RING = 1 << 15; // samples kept at 6 kHz: 5.4 s, nearly three frames
const COLS = 256; // spectrogram columns kept: 2 s
/** Sync score over which a peak is tried. Noise alone averages 0.25. */
const SYNC_THRESHOLD = 0.42;
/** At most this many candidates tried per spectrogram column: a bound on the CPU a busy band can take. */
const MAX_TRIES_PER_COLUMN = 6;

export interface JttyFrame {
  /** The lowest tone, Hz audio: where the station transmits. */
  hz: number;
  /** S/N in 2500 Hz, dB, from the sync. */
  snr: number;
  atom: JttyAtom;
  eom: boolean;
  /** The frame's first sample, at 6 kHz since the receiver started. */
  start: number;
}

export interface JttyMessage {
  hz: number;
  snr: number;
  text: string;
  /** Whether it ended with its end-of-message frame, rather than going quiet. */
  complete: boolean;
  frames: number;
}

export interface JttyDemodStats {
  frames: number;
  messages: number;
  /** Sync peaks tried since the start. */
  candidates: number;
  lastSnr: number | null;
  lastHz: number | null;
}

interface Slot {
  hz: number;
  atoms: JttyAtom[];
  nextStart: number;
  snr: number;
}

export class JttyDemodulator {
  private readonly decim: number;
  private readonly taps: Float64Array;
  private readonly hist: Float64Array;
  private histPos = 0;
  private phase = 0;
  /** 6 kHz samples, by absolute index modulo RING. */
  private readonly ring = new Float32Array(RING);
  private written = 0;
  /** Spectrogram columns, by absolute column index modulo COLS. */
  private readonly power: Float32Array[] = Array.from({ length: COLS }, () => new Float32Array(BIN_HI + 8));
  private columns = 0;
  /** Sync scores by column, modulo COLS. */
  private readonly score: Float32Array[] = Array.from({ length: COLS }, () => new Float32Array(BIN_HI + 8));
  private scored = 0;
  private pending: { start: number; bin: number; score: number }[] = [];
  private recent: { start: number; hz: number }[] = [];
  private slots: Slot[] = [];
  private out = "";
  private readonly stats: JttyDemodStats = { frames: 0, messages: 0, candidates: 0, lastSnr: null, lastHz: null };
  private readonly fftRe = new Float64Array(NFFT);
  private readonly fftIm = new Float64Array(NFFT);
  private readonly hann = Float64Array.from({ length: NSS }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / NSS));

  constructor(
    sampleRate: number,
    private readonly hooks: { onFrame?: (f: JttyFrame) => void; onMessage?: (m: JttyMessage) => void } = {},
  ) {
    this.decim = sampleRate / FS;
    if (!Number.isInteger(this.decim) || this.decim < 1) throw new Error(`JTTY needs a multiple of 6 kHz, not ${sampleRate}`);
    // A windowed-sinc low-pass at 2.9 kHz, ahead of the decimation.
    const n = this.decim === 1 ? 1 : 16 * this.decim + 1;
    this.taps = new Float64Array(n);
    if (n === 1) this.taps[0] = 1;
    else {
      const fc = 2900 / sampleRate;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const m = i - (n - 1) / 2;
        const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
        this.taps[i] = sinc * w;
        sum += sinc * w;
      }
      for (let i = 0; i < n; i++) this.taps[i] = this.taps[i]! / sum;
    }
    this.hist = new Float64Array(n);
  }

  get statistics(): Readonly<JttyDemodStats> {
    return this.stats;
  }

  /** Audio in; text out: a line per message as it ends. */
  feed(samples: ArrayLike<number>): string {
    for (let i = 0; i < samples.length; i++) {
      this.hist[this.histPos] = samples[i]!;
      this.histPos = (this.histPos + 1) % this.hist.length;
      if (++this.phase < this.decim) continue;
      this.phase = 0;
      let acc = 0;
      const n = this.taps.length;
      for (let k = 0; k < n; k++) acc += this.taps[k]! * this.hist[(this.histPos + k) % n]!;
      this.ring[this.written % RING] = acc;
      this.written++;
      if (this.written >= (this.columns * HOP) + NSS) this.addColumn();
    }
    this.flushQuiet();
    const t = this.out;
    this.out = "";
    return t;
  }

  private sample(abs: number): number {
    return this.ring[((abs % RING) + RING) % RING]!;
  }

  private addColumn(): void {
    const c = this.columns++;
    const base = c * HOP;
    this.fftRe.fill(0);
    this.fftIm.fill(0);
    for (let i = 0; i < NSS; i++) this.fftRe[i] = this.sample(base + i) * this.hann[i]!;
    fftMixed(this.fftRe, this.fftIm, -1);
    const p = this.power[c % COLS]!;
    for (let b = 0; b < p.length; b++) p[b] = this.fftRe[b]! ** 2 + this.fftIm[b]! ** 2;
    // Score the sync whose first symbol is SYNC_SPAN columns back.
    const s = c - SYNC_SPAN;
    if (s < 0) return;
    const row = this.score[s % COLS]!;
    for (let b = BIN_LO; b <= BIN_HI; b++) {
      let on = 0;
      let all = 0;
      for (let j = 0; j < JTTY_SYNC_SYMBOLS; j++) {
        const col = this.power[(s + 4 * j) % COLS]!;
        for (let t = 0; t < 4; t++) {
          const v = col[b + 2 * t] ?? 0;
          all += v;
          if (t === JTTY_SYNC[j]) on += v;
        }
      }
      row[b] = all > 1e-12 ? on / all : 0;
    }
    this.scored = s + 1;
    // A peak two columns back is final once the rows either side of it are scored.
    const r = s - 2;
    if (r >= 2) this.findPeaks(r);
    this.decodeReady();
  }

  private findPeaks(r: number): void {
    const row = this.score[r % COLS]!;
    for (let b = BIN_LO; b <= BIN_HI; b++) {
      const v = row[b]!;
      if (v < SYNC_THRESHOLD) continue;
      let peak = true;
      for (let dr = -2; dr <= 2 && peak; dr++) {
        const rr = this.score[(r + dr) % COLS]!;
        for (let db = -1; db <= 1; db++) {
          if (dr === 0 && db === 0) continue;
          const w = rr[b + db] ?? 0;
          if (w > v || (w === v && (dr < 0 || (dr === 0 && db < 0)))) {
            peak = false;
            break;
          }
        }
      }
      if (peak) this.pending.push({ start: r * HOP, bin: b, score: v });
    }
  }

  private decodeReady(): void {
    const keep: { start: number; bin: number; score: number }[] = [];
    const ready: { start: number; bin: number; score: number }[] = [];
    for (const c of this.pending) {
      // The whole frame, and a little either side for the refinement.
      if (this.written < c.start + FRAME + 2 * HOP) {
        keep.push(c);
        continue;
      }
      if (this.written - c.start > RING - 2 * HOP) continue; // fell out of the ring
      ready.push(c);
    }
    this.pending = keep;
    // Strongest first, so a frame's sidelobe peaks are skipped once the frame itself decodes.
    ready.sort((a, b) => b.score - a.score);
    for (const c of ready.slice(0, MAX_TRIES_PER_COLUMN)) this.tryDecode(c.start, c.bin * BIN_HZ);
  }

  /** |correlation|^2 of one symbol at `start` against a tone at `hz`. */
  private toneEnergy(start: number, hz: number): number {
    // A rotating phasor rather than a cosine and a sine per sample: five times faster,
    // and the drift over 192 steps is far below anything that matters here.
    const w = (2 * Math.PI * hz) / FS;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = 1;
    let sn = 0;
    let re = 0;
    let im = 0;
    const base = ((start % RING) + RING) % RING;
    for (let k = 0; k < NSS; k++) {
      const x = this.ring[(base + k) & (RING - 1)]!;
      re += x * c;
      im -= x * sn;
      const nc = c * cw - sn * sw;
      sn = sn * cw + c * sw;
      c = nc;
    }
    return re * re + im * im;
  }

  private syncEnergy(start: number, hz: number): number {
    let e = 0;
    for (let j = 0; j < JTTY_SYNC_SYMBOLS; j++) e += this.toneEnergy(start + j * NSS, hz + JTTY_SYNC[j]! * JTTY_BAUD);
    return e;
  }

  private tryDecode(start0: number, hz0: number): void {
    if (this.recent.some((d) => Math.abs(d.start - start0) < 2 * NSS && Math.abs(d.hz - hz0) < 25)) return;
    this.stats.candidates++;
    // Frequency to a hertz, then time to 12 samples (2 ms).
    let hz = hz0;
    let best = -1;
    for (let df = -10; df <= 10; df += 1) {
      const e = this.syncEnergy(start0, hz0 + df);
      if (e > best) {
        best = e;
        hz = hz0 + df;
      }
    }
    let start = start0;
    best = -1;
    for (let dt = -48; dt <= 48; dt += 12) {
      const e = this.syncEnergy(start0 + dt, hz);
      if (e > best) {
        best = e;
        start = start0 + dt;
      }
    }
    // S/N from the sync: power on the sequence's tones against the other three.
    let pt = 0;
    let pa = 0;
    for (let j = 0; j < JTTY_SYNC_SYMBOLS; j++) {
      for (let t = 0; t < 4; t++) {
        const e = this.toneEnergy(start + j * NSS, hz + t * JTTY_BAUD);
        pa += e;
        if (t === JTTY_SYNC[j]) pt += e;
      }
    }
    const pn = (pa - pt) / 3;
    const snrBin = pn > 0 ? (pt - pn) / pn : 0;
    const snr = Math.round(10 * Math.log10(Math.max(snrBin, 1e-3)) + 10 * Math.log10(JTTY_BAUD / 2500));
    // The data symbols' tone energies, scaled by their mean.
    const energies: number[][] = [];
    let sum = 0;
    for (let j = 0; j < 46; j++) {
      const s = start + (JTTY_SYNC_SYMBOLS + j) * NSS;
      const e = [0, 1, 2, 3].map((t) => this.toneEnergy(s, hz + t * JTTY_BAUD));
      sum += e[0]! + e[1]! + e[2]! + e[3]!;
      energies.push(e);
    }
    const mean = sum / (46 * 4) || 1;
    for (const e of energies) for (let t = 0; t < 4; t++) e[t] = e[t]! / mean;
    const payload = jttyDecodeEnergies(energies);
    if (!payload) return;
    const u = jttyUnpackAtom(payload);
    if (!u) return;
    this.recent.push({ start, hz });
    if (this.recent.length > 64) this.recent.shift();
    this.stats.frames++;
    this.stats.lastSnr = snr;
    this.stats.lastHz = Math.round(hz);
    const frame: JttyFrame = { hz: Math.round(hz), snr, atom: u.atom, eom: u.eom, start };
    this.hooks.onFrame?.(frame);
    this.join(frame);
  }

  /** A frame into its station's message: the same frequency, starting where the last one ended. */
  private join(f: JttyFrame): void {
    let slot = this.slots.find((s) => Math.abs(s.hz - f.hz) <= 12 && Math.abs(s.nextStart - f.start) <= NSS);
    if (!slot) {
      // A station that started a new message without ending the last: what came is printed.
      const stale = this.slots.filter((s) => Math.abs(s.hz - f.hz) <= 12);
      for (const s of stale) this.finish(s, false);
      slot = { hz: f.hz, atoms: [], nextStart: f.start, snr: f.snr };
      this.slots.push(slot);
    }
    slot.atoms.push(f.atom);
    slot.nextStart = f.start + FRAME;
    slot.snr = Math.max(slot.snr, f.snr);
    if (f.eom) this.finish(slot, true);
  }

  /** Messages whose next frame is two frames late have ended without saying so. */
  private flushQuiet(): void {
    for (const s of [...this.slots]) if (this.written > s.nextStart + 2 * FRAME) this.finish(s, false);
  }

  private finish(slot: Slot, complete: boolean): void {
    this.slots = this.slots.filter((s) => s !== slot);
    if (slot.atoms.length === 0) return;
    const text = jttyJoinAtoms(slot.atoms);
    const m: JttyMessage = { hz: slot.hz, snr: slot.snr, text, complete, frames: slot.atoms.length };
    this.stats.messages++;
    this.hooks.onMessage?.(m);
    const snr = `${slot.snr >= 0 ? "+" : ""}${slot.snr}`.padStart(3);
    this.out += `${String(slot.hz).padStart(4)} Hz ${snr} dB  ${text}${complete ? "" : " …"}\n`;
  }
}

/** For tests and tools: what each frame rendered as, in order. */
export function jttyDescribeFrame(f: JttyFrame): string {
  return `${f.hz} Hz ${f.snr} dB ${jttyRenderAtom(f.atom)}${f.eom ? " [end]" : ""}`;
}

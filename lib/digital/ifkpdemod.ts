// An IFKP demodulator: audio in, text out, as a stream.
//
// IFKP is FSQ's 33-tone incremental keying at a different rate and with a slightly
// different Varicode (lib/digital/ifkp.ts), so it is read by the same receiver
// (Ifk33Receiver, lib/digital/fsqdemod.ts) - matched filters a symbol long, symbol timing
// from the signal, the step between the strongest filters, and a character printed only
// when the symbols around it read as signal. See there for how and why it differs from
// fldigi's FFT-and-count receiver (ifkp.cxx:484-551).
//
// fldigi's IFKP receiver also band-pass filters the audio to 1.5 times the bandwidth before
// its FFT (rx_process, ifkp.cxx:647); the matched filters here are already that narrow, so
// that step is not needed. IFKP's idle is NUL, which prints nothing, and so is every other
// control character but LF.
//
// scripts/check-ifkp.ts runs it clean, offset, in noise, chunked, on noise alone and on
// digital silence.

import { ifk33Printable } from "@/lib/digital/fsq";
import { Ifk33Receiver, type Ifk33DemodStats } from "@/lib/digital/fsqdemod";
import { IFKP_CENTRE_HZ, IFKP_TONE_SPACING_HZ, IFKP_VARICODE, ifkpParams, ifkpToneHz, type IfkpSpeed } from "@/lib/digital/ifkp";

export interface IfkpDemodOptions {
  sampleRate: number;
  /** The operator's frequency, Hz audio: 1500 with fldigi's default frequency lock. */
  centreHz: number;
  speed: IfkpSpeed;
  /**
   * Squelch, 0 to 1: characters print only when the signal around them reads at least this
   * quality. Noise reads under 0.1, a signal at the edge of copy about 0.4, one that copies
   * every time 0.5 to 0.65, a clean one 1. 0 disables it. Default 0.2.
   */
  squelch?: number;
}

export class IfkpDemodulator {
  private readonly rx: Ifk33Receiver;

  constructor(opts: IfkpDemodOptions) {
    const p = ifkpParams(opts.speed);
    this.rx = new Ifk33Receiver({
      sampleRate: opts.sampleRate,
      baud: p.baud,
      toneSpacingHz: IFKP_TONE_SPACING_HZ,
      toneHz: ifkpToneHz,
      centreHz: opts.centreHz ?? IFKP_CENTRE_HZ,
      varicode: IFKP_VARICODE,
      printable: ifk33Printable,
      squelch: opts.squelch,
    });
  }

  get statistics(): Readonly<Ifk33DemodStats> {
    return this.rx.statistics;
  }

  get qualityDb(): number {
    return this.rx.qualityDb;
  }

  feed(samples: ArrayLike<number>): string {
    return this.rx.feed(samples);
  }

  retune(centreHz: number): void {
    this.rx.retune(centreHz);
  }

  reset(): void {
    this.rx.reset();
  }
}

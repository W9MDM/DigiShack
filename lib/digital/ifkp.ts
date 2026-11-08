// IFKP: the code and the waveform.
//
// IFKP (ZL1BPU and ZL2AFP's "IFK+ keyboard" mode, added to fldigi alongside FSQ) is FSQ's
// keyboard sibling: the same 33-tone incremental keying, where each symbol is a step of the
// nibble plus one from the last tone, modulo 33, and the same two-level nibble Varicode with
// three entries moved - here space is the one-nibble 28 and newline the two-nibble 28 30,
// and the idle is a single nibble 0. What differs is the arithmetic around it: fldigi works
// IFKP at 16000 Hz with a 4096-point FFT (`#define IFKP_SR 16000`, ifkp.cxx:58; ifkp.h:37-45),
// the tones three bins apart, so 3 x 16000 / 4096 = 11.72 Hz apart, and a symbol of 4096
// samples there - 3.906 baud - halved or doubled for the other two speeds (send_tone,
// ifkp.cxx:699-701). fldigi names them by multiple: "1/2 speed", "1x speed", "2x speed"
// (confdialog.cxx:14452-14463), and its status bar says IFKP 0.5, 1.0 and 2.0.
//
// There is no over framing beyond two idles before the text and one after
// (tx_process, ifkp.cxx:1056-1105): the idle after is what completes a last character of
// one nibble at the far end.
//
// Tone placement follows set_freq (ifkp.cxx:256-293): tone 0 is the bin at or just above
// the frequency less half the 386 Hz bandwidth, and tone n is 3n bins above that. fldigi's
// "IFKP frequency lock" (IFKPFREQLOCK) is on by default and holds the frequency at 1500 Hz,
// so on the air IFKP is nearly always on 1308.6 to 1683.6 Hz.
//
// Ported from fldigi 4.2.13 (W1HKJ and others, GPL): src/ifkp/ifkp.cxx, src/ifkp/ifkp_varicode.cxx,
// src/include/ifkp.h. Image and avatar transfer (IFKP-pic) are not ported.
//
// The decoder is lib/digital/ifkpdemod.ts; scripts/check-ifkp.ts runs one through the other.

import { ifk33Audio, ifk33EncodeTable, ifk33TextCodes, ifk33Tones, type Ifk33Varicode } from "@/lib/digital/fsq";

/** IFKP_SR, ifkp.cxx:58. */
export const IFKP_BASE_RATE = 16_000;
/** IFKP_FFTSIZE and IFKP_SYMLEN, ifkp.h:37-38. */
const IFKP_FFT = 4096;
/** IFKP_SPACING, ifkp.h:45. */
const IFKP_BIN_SPACING = 3;
export const IFKP_TONE_SPACING_HZ = (IFKP_BIN_SPACING * IFKP_BASE_RATE) / IFKP_FFT;
/** set_bandwidth(33 * IFKP_SPACING * samplerate / symlen), ints in fldigi: 1584000 / 4096 truncates to 386. */
export const IFKP_BANDWIDTH_HZ = Math.trunc((33 * IFKP_BIN_SPACING * IFKP_BASE_RATE) / IFKP_FFT);
/** Where fldigi's frequency lock (on by default) holds IFKP: set_freq, ifkp.cxx:258-259. */
export const IFKP_CENTRE_HZ = 1500;

export type IfkpSpeed = "0.5" | "1" | "2";

export const IFKP_SPEEDS: readonly IfkpSpeed[] = ["0.5", "1", "2"];

/** Symbol length at 16000 Hz: symlen x 2, x 1 or x 0.5 for ifkp_baud 0, 1, 2 (send_tone, ifkp.cxx:699-701). */
const SYMLEN: Record<IfkpSpeed, number> = { "0.5": 8192, "1": 4096, "2": 2048 };

export interface IfkpParams {
  speed: IfkpSpeed;
  /** Symbol length at 16000 Hz, samples. */
  symbolLen: number;
  baud: number;
  toneSpacingHz: number;
  bandwidthHz: number;
}

export function ifkpParams(speed: IfkpSpeed): IfkpParams {
  const symbolLen = SYMLEN[speed];
  if (!symbolLen) throw new Error(`IFKP ${speed} is not a speed`);
  return { speed, symbolLen, baud: IFKP_BASE_RATE / symbolLen, toneSpacingHz: IFKP_TONE_SPACING_HZ, bandwidthHz: IFKP_BANDWIDTH_HZ };
}

/**
 * The frequency fldigi actually uses for `centreHz`: kept clear of the passband edges by
 * half the bandwidth (set_freq, ifkp.cxx:263-264).
 */
export function ifkpClampCentre(centreHz: number): number {
  return Math.min(3900 - IFKP_BANDWIDTH_HZ / 2, Math.max(100 + IFKP_BANDWIDTH_HZ / 2, centreHz));
}

/** The FFT bin of tone 0: ceil((f - bandwidth / 2) * symlen / samplerate), set_freq, ifkp.cxx:272. */
export function ifkpBaseBin(centreHz: number): number {
  return Math.ceil(((ifkpClampCentre(centreHz) - IFKP_BANDWIDTH_HZ / 2) * IFKP_FFT) / IFKP_BASE_RATE);
}

/** The frequency of tone 0 to 32: send_tone, ifkp.cxx:692. */
export function ifkpToneHz(tone: number, centreHz: number): number {
  return ((ifkpBaseBin(centreHz) + tone * IFKP_BIN_SPACING) * IFKP_BASE_RATE) / IFKP_FFT;
}

/**
 * The IFKP Varicode, decoding side: ifkp_varicode.cxx (`ifkp_varidecode`), laid out as for
 * FSQ (see FSQ_VARICODE in fsq.ts). It is FSQ's table with three entries changed: single
 * nibble 0 is NUL (the idle) where FSQ has space, single 28 is space where FSQ has LF, and
 * 28 30 is LF where FSQ has NUL.
 */
export const IFKP_VARICODE: Ifk33Varicode = {
  single: [0, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 46, 32],
  double: [
    [64, 126, 61], [65, 49, 91], [66, 50, 92], [67, 51, 93], [68, 52, 94], [69, 53, 95], [70, 54, 123], [71, 55, 124],
    [72, 56, 125], [73, 57, 96], [74, 48, 177], [75, 33, 247], [76, 34, 176], [77, 35, 215], [78, 36, 163], [79, 37, -1],
    [80, 38, -1], [81, 39, -1], [82, 40, -1], [83, 41, -1], [84, 42, -1], [85, 43, -1], [86, 45, -1], [87, 47, -1],
    [88, 58, -1], [89, 59, -1], [90, 60, -1], [44, 62, 8], [63, 10, 127],
  ],
  // send_idle, ifkp.cxx:717-720: send_symbol(0).
  idle: [0],
};

/**
 * The encoding side: the inverse of the decoding table, as for FSQ, plus the one entry of
 * fldigi's ifkp_varicode[][2] that is not an inverse - Latin-1 248 (ø) is sent as 12 31,
 * which every receiver reads as 176 (°) (ifkp_varicode.cxx:33).
 */
const IFKP_ENCODE = ifk33EncodeTable(IFKP_VARICODE);
IFKP_ENCODE.set(248, [12, 31]);

/** The nibbles for one character code, or [] for one IFKP cannot send. 0 is the idle. */
export function ifkpCodeFor(code: number): number[] {
  if (code === 0) return [...IFKP_VARICODE.idle];
  return [...(IFKP_ENCODE.get(code) ?? [])];
}

/** The nibbles of a whole over: two idles, the text, one idle (tx_process, ifkp.cxx:1060-1104). */
export function ifkpNibbles(text: string): number[] {
  const body = ifk33TextCodes(text, IFKP_ENCODE).flatMap((c) => ifkpCodeFor(c));
  return [...ifkpCodeFor(0), ...ifkpCodeFor(0), ...body, ...ifkpCodeFor(0)];
}

export interface IfkpWaveformOptions {
  sampleRate: number;
  /** The operator's frequency, Hz audio: 1500 with fldigi's default frequency lock. */
  centreHz: number;
  speed: IfkpSpeed;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** The audio for a line of text: the whole over, phase-continuous, ends ramped (ifk33Audio). */
export function ifkpWaveform(text: string, opts: IfkpWaveformOptions): Float32Array {
  const p = ifkpParams(opts.speed);
  const tones = ifk33Tones(ifkpNibbles(text));
  return ifk33Audio(tones, (t) => ifkpToneHz(t, opts.centreHz), (p.symbolLen * opts.sampleRate) / IFKP_BASE_RATE, opts.sampleRate, opts.amplitude ?? 1);
}

export function ifkpDurationMs(text: string, opts: { speed: IfkpSpeed }): number {
  const p = ifkpParams(opts.speed);
  return (ifkpNibbles(text).length / p.baud) * 1000;
}

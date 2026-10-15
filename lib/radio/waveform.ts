// Generating the audio for a digital-mode transmission.
//
// Vendor-neutral on purpose. This was a method on `FlexDaxTransmitter`, where it used no
// instance state whatsoever — so when the Icom transmitter needed the same thing, the
// choice was between a second copy of the modulator and lifting this out. An FT8
// modulator tested once is worth more than two tested separately.
//
// The only thing that varies between radios is the sample rate: Flex DAX wants 24 kHz,
// Icom wants 48 kHz. Everything else — the encoders, the offset limits, the length cap —
// is a property of the mode, not of the radio.

import { ft2Encode } from "@/lib/digital/ft2";
import { js8EncodeFrame, js8Waveform } from "@/lib/digital/js8";
import { js8SubmodeNow } from "@/lib/radio/timing";
import type { Js8OutFrame } from "@/lib/digital/js8-message";
import { encodeFT4, encodeFT8 } from "@e04/ft8ts";

export type TxMode = "FT8" | "FT4" | "FT2" | "WSPR" | "RTTY" | "CW" | "JS8" | "PSK31" | "OLIVIA" | "SSTV";

/**
 * Symbol rates, in baud.
 *
 * Samples per symbol is derived from these rather than tabulated per rate, because a
 * table has to be right for every rate anyone adds and this cannot be wrong. At 24 kHz
 * they give 3840 / 1152 / 320, and at 48 kHz exactly double — both integer, which is
 * what matters: a fractional samples-per-symbol accumulates timing error across a
 * transmission and smears the last symbols.
 */
export const SYMBOL_RATE: Record<TxMode, number> = {
  FT8: 6.25,
  FT4: 20.833333333333332,
  FT2: 75,
  /** 12000 / 8192: the slowest thing here by a factor of fifty. */
  WSPR: 12_000 / 8_192,
  /** 45.45 baud: a stream of characters, never a frame. See lib/digital/rtty.ts. */
  RTTY: 1_000 / 22,
  /** No symbols here: the radio's own keyer sends CW. */
  CW: 0,
  /** JS8 normal mode: FT8's 6.25 baud. */
  JS8: 6.25,
  /** 31.25 baud: a stream of characters, never a frame. See lib/digital/psk31.ts. */
  PSK31: 31.25,
  /** 31.25 baud for the common sizes; per size in lib/digital/olivia.ts. A stream. */
  OLIVIA: 31.25,
  /** A picture, not symbols. */
  SSTV: 0,
};

/**
 * Nothing legitimate runs this long; a longer waveform is a bug, not a transmission.
 * 27 s since JS8 Slow, whose frame is 25.28 s; it was 20 s, which refused Slow on the Icom.
 */
export const MAX_TRANSMIT_MS = 27_000;

/**
 * Usable audio offsets.
 *
 * Outside this the SSB filter clips the tones — the transmission goes out sounding
 * fine to the operator and decodes nowhere. True of any radio, which is why the check
 * lives here rather than in either driver.
 */
export const MIN_OFFSET_HZ = 200;
export const MAX_OFFSET_HZ = 2800;

export function samplesPerSymbol(mode: TxMode, sampleRate: number): number {
  return Math.round(sampleRate / SYMBOL_RATE[mode]);
}

/**
 * Build the audio for a message without transmitting it.
 *
 * Separate from any transmit path on purpose: it lets the whole generation path be
 * exercised, and asserted against the decoder, with no possibility of keying.
 */
export function buildWaveform(
  message: string,
  mode: TxMode,
  offsetHz: number,
  sampleRate: number,
): Float32Array {
  if (!Number.isFinite(offsetHz) || offsetHz < MIN_OFFSET_HZ || offsetHz > MAX_OFFSET_HZ) {
    throw new Error(
      `Audio offset ${offsetHz} Hz is outside ${MIN_OFFSET_HZ}-${MAX_OFFSET_HZ} Hz; the transmit filter would clip it`,
    );
  }

  // FT2 is ours end to end — lib/digital, ported from the wsjt-x_improved reference —
  // rather than @e04/ft8ts, which does not implement it.
  // WSPR is listened to, not transmitted, in this release. The codec can make the
  // waveform (lib/digital/wspr.ts does, and the pipeline check uses it), but a 110-second
  // beacon on a schedule at a chosen power is its own feature, with its own gate.
  if (mode === "WSPR") {
    throw new Error("WSPR transmit is not enabled: DigiShack listens to WSPR and does not beacon");
  }
  // RTTY is text, not a framed message: lib/digital/rtty.ts makes its waveform from a
  // string, and the transmit path for that is part three of the mode.
  if (mode === "RTTY" || mode === "CW" || mode === "PSK31" || mode === "OLIVIA" || mode === "SSTV") {
    throw new Error(`${mode} is not a framed mode: nothing builds a ${mode} waveform from a structured message`);
  }
  // JS8 frames are built from the message layer's twelve characters and a transmission
  // type, not from a structured message: buildJs8Waveform below, from the frame on the
  // transmit request. A request that names the mode without a frame has nothing to send.
  if (mode === "JS8") {
    throw new Error("JS8 is sent as frames from the message layer; this request carries none");
  }
  let wave: Float32Array;
  if (mode === "FT2") {
    wave = ft2Encode(message, offsetHz, undefined, sampleRate).audio;
  } else {
    const opts = {
      sampleRate,
      samplesPerSymbol: samplesPerSymbol(mode, sampleRate),
      baseFrequency: offsetHz,
    };
    wave = mode === "FT4" ? encodeFT4(message, opts) : encodeFT8(message, opts);
  }

  if (wave.length === 0) {
    throw new Error(`Encoder produced no samples for "${message}"`);
  }

  const ms = (wave.length / sampleRate) * 1000;
  if (ms > MAX_TRANSMIT_MS) {
    throw new Error(
      `Waveform is ${(ms / 1000).toFixed(1)}s, over the ${MAX_TRANSMIT_MS / 1000}s cap`,
    );
  }

  return wave;
}

/**
 * One JS8 frame as audio, at an offset, for the framed transmitter. The frame is the
 * message layer's: twelve characters and the transmission type that marks the first and
 * last frames of a message (lib/digital/js8-message.ts); the physical layer makes the 79
 * tones and the GFSK waveform (lib/digital/js8.ts). 12.64 s at full scale, as FT8.
 */
export function buildJs8Waveform(frame: Js8OutFrame, offsetHz: number, sampleRate: number): Float32Array {
  if (!Number.isFinite(offsetHz) || offsetHz < MIN_OFFSET_HZ || offsetHz > MAX_OFFSET_HZ) {
    throw new Error(
      `Audio offset ${offsetHz} Hz is outside ${MIN_OFFSET_HZ}-${MAX_OFFSET_HZ} Hz; the transmit filter would clip it`,
    );
  }
  // At the speed in force: the Costas set and the symbol length are the submode's.
  const submode = js8SubmodeNow();
  const { tones } = js8EncodeFrame(frame.frame, frame.txType, submode);
  return js8Waveform(tones, { sampleRate, baseHz: offsetHz, submode });
}

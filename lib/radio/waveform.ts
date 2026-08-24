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
import { encodeFT4, encodeFT8 } from "@e04/ft8ts";

export type TxMode = "FT8" | "FT4" | "FT2";

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
};

/** Nothing legitimate runs this long; a longer waveform is a bug, not a transmission. */
export const MAX_TRANSMIT_MS = 20_000;

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

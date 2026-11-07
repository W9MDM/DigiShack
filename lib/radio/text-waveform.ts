// The audio a line of text goes out as, in the text modes sent as audio: RTTY, PSK31,
// Olivia, Hell and JTTY. Shared by the FlexRadio (DAX, 24 kHz) and the Icom (48 kHz)
// transmitters, which differ only in the rate. CW is not here: each radio keys it itself.

import { hellDurationMs, hellVariant, hellWaveform, type HellVariant } from "@/lib/digital/hell";
import { jttyDurationMs, jttyWaveform } from "@/lib/digital/jtty";
import {
  oliviaDurationMs,
  oliviaSymbols,
  oliviaWaveform,
  type OliviaBandwidth,
  type OliviaCode,
  type OliviaTones,
} from "@/lib/digital/olivia";
import { psk31DurationMs, psk31Waveform } from "@/lib/digital/psk31";
import { rttyDurationMs, rttyWaveform } from "@/lib/digital/rtty";

/** How long a line may be on the air: 240 characters of RTTY, about forty seconds. Slow Hell has its own. */
export const MAX_TEXT_MS = 40_000;

/** A line of text to send as it is: RTTY at a tone pair, PSK31 on a carrier, now. */
export interface TextTransmitRequest {
  /** RTTY, PSK31, Olivia, Hell and JTTY go out as audio; CW is handed to the radio's own keyer. */
  mode: "RTTY" | "CW" | "PSK31" | "OLIVIA" | "HELL" | "JTTY";
  text: string;
  /** Centre of the tone pair, Hz audio. */
  centreHz: number;
  shiftHz: number;
  sideband: "USB" | "LSB";
  figures?: "us" | "ita2";
  usos?: boolean;
  /** CW speed, words per minute. Default 20. */
  wpm?: number;
  /** RTTY speed. Default 45.45. */
  baud?: number;
  /** PSK: 31.25, 62.5 or 125 baud. Default 31. */
  speed?: 31 | 63 | 125;
  /** Olivia: the size. Default 500/16. */
  tones?: OliviaTones;
  bandwidth?: OliviaBandwidth;
  /** Olivia, or Contestia on the same engine. */
  code?: OliviaCode;
  /** Hell: which of the Hell modes. Default Feld Hell. */
  hellVariant?: HellVariant;
}

/**
 * The longest a line in this mode may be on the air, ms.
 *
 * Slow Hell is the one exception to forty seconds: a character takes 3.2 s.
 */
export function maxTextMs(req: Pick<TextTransmitRequest, "mode" | "hellVariant">): number {
  return req.mode === "HELL" ? hellVariant(req.hellVariant).maxSendMs : MAX_TEXT_MS;
}

/**
 * The audio for a line at `sampleRate`. Throws for an empty line or one over the cap, so a
 * bad line is refused before the radio is looked at.
 */
export function textWaveform(req: TextTransmitRequest, sampleRate: number): Float32Array {
  if (req.mode === "CW") throw new Error("CW is keyed by the radio, not sent as audio");
  const text = req.text.trim();
  if (!text) throw new Error("Nothing to send");
  const cap = maxTextMs(req);
  if (req.mode === "OLIVIA") {
    const size = { tones: req.tones ?? 16, bandwidth: req.bandwidth ?? 500, code: req.code ?? "olivia" } as const;
    const olMs = oliviaDurationMs(text, size);
    if (olMs > cap) {
      throw new Error(
        `${text.length} characters is ${(olMs / 1000).toFixed(0)} s of ${size.code === "contestia" ? "Contestia" : "Olivia"} ${size.bandwidth}/${size.tones}, over the ${cap / 1000} s cap - send it in pieces`,
      );
    }
    return oliviaWaveform(oliviaSymbols(text, size), { ...size, sampleRate, centreHz: req.centreHz });
  }
  if (req.mode === "JTTY") {
    // The packing is the specification's: fewest frames, sixteen at most (30 s).
    const jMs = jttyDurationMs(text);
    if (jMs > cap) {
      throw new Error(`${(jMs / 1000).toFixed(0)} s of JTTY is over the ${cap / 1000} s cap - send it in pieces`);
    }
    return jttyWaveform(text, { sampleRate, baseHz: req.centreHz });
  }
  if (req.mode === "HELL") {
    const v = hellVariant(req.hellVariant);
    const hellMs = hellDurationMs(text, v.id);
    if (hellMs > cap) {
      const cps = v.columnRate / 7;
      throw new Error(
        `${text.length} characters is ${(hellMs / 1000).toFixed(0)} s of ${v.label} at ${cps < 1 ? cps.toFixed(2) : cps.toFixed(1)} characters a second, over the ${cap / 1000} s cap - send it in pieces`,
      );
    }
    return hellWaveform(text, { sampleRate, centreHz: req.centreHz, variant: v.id });
  }
  if (req.mode === "PSK31") {
    const pskMs = psk31DurationMs(text, { speed: req.speed });
    if (pskMs > cap) {
      throw new Error(
        `${text.length} characters is ${(pskMs / 1000).toFixed(0)} s of PSK, over the ${cap / 1000} s cap - send it in pieces`,
      );
    }
    return psk31Waveform(text, { sampleRate, centreHz: req.centreHz, speed: req.speed });
  }
  const ms = rttyDurationMs(text, { baud: req.baud });
  if (ms > cap) {
    throw new Error(
      `${text.length} characters is ${(ms / 1000).toFixed(0)} s of RTTY, over the ${cap / 1000} s cap - send it in pieces`,
    );
  }
  return rttyWaveform(text, {
    sampleRate,
    centreHz: req.centreHz,
    shiftHz: req.shiftHz,
    sideband: req.sideband,
    figures: req.figures,
    usos: req.usos,
    baud: req.baud,
  });
}

// The keyboard modes that came from fldigi after the first ones: MFSK, DominoEX, MT63.
//
// RTTY, CW, PSK, Olivia and Hell were each written into the pipeline, both radios, the
// bridge, the page and the log by hand, about a hundred places a mode. These later ones
// share a shape - a centre frequency, a size or speed, a demodulator that turns audio into
// text, a waveform that turns text into audio - so they are described once here and every
// layer reads this table: the pipeline builds the demodulator from it, the transmitters
// the waveform, the bridge the tuning and the endpoint, the page the picker and the
// markers, the log the ADIF mode, RSID the codes.
//
// Adding one is an entry here, its calling frequencies in lib/ham/digital-freqs.ts, and
// its ADIF mapping; nothing else has to learn its name.

import { DOMINOEX_CENTRE_HZ, DOMINOEX_MODES, dominoexDurationMs, dominoexParams, dominoexWaveform, type DominoexMode } from "@/lib/digital/dominoex";
import { DominoexDemodulator } from "@/lib/digital/dominoexdemod";
import { MFSK_CENTRE_HZ, MFSK_MODES, mfskDurationMs, mfskWaveform, type MfskModeName } from "@/lib/digital/mfsk";
import { MfskDemodulator } from "@/lib/digital/mfskdemod";
import { MT63_MODES, mt63DurationMs, mt63Params, mt63Waveform, type Mt63Mode } from "@/lib/digital/mt63";
import { Mt63Demodulator } from "@/lib/digital/mt63demod";
import { THOR_CENTRE_HZ, THOR_MODES, thorDurationMs, thorParams, thorWaveform, type ThorMode } from "@/lib/digital/thor";
import { ThorDemodulator } from "@/lib/digital/thordemod";
import { THROB_CENTRE_HZ, THROB_MODES, throbDurationMs, throbParams, throbWaveform, type ThrobMode } from "@/lib/digital/throb";
import { ThrobDemodulator } from "@/lib/digital/throbdemod";
import { FSQ_BANDWIDTH_HZ, FSQ_CENTRE_HZ, FSQ_SPEEDS, fsqDurationMs, fsqWaveform, type FsqSpeed } from "@/lib/digital/fsq";
import { FsqDemodulator } from "@/lib/digital/fsqdemod";
import { IFKP_BANDWIDTH_HZ, IFKP_CENTRE_HZ, IFKP_SPEEDS, ifkpDurationMs, ifkpWaveform, type IfkpSpeed } from "@/lib/digital/ifkp";
import { IfkpDemodulator } from "@/lib/digital/ifkpdemod";
import { NAVTEX_CENTRE_HZ, navtexDurationMs, navtexWaveform } from "@/lib/digital/navtex";
import { NavtexDemodulator } from "@/lib/digital/navtexdemod";
import { WEFAX_CARRIER_HZ, WEFAX_MAX_LINES, wefaxTestPattern, wefaxWaveform } from "@/lib/digital/wefax";
import { WefaxDecoder } from "@/lib/digital/wefaxdemod";
import type { SstvEvent } from "@/lib/radio/decode-pipeline";

/** The registered keyboard modes. A name here with no entry in MODEMS is not offered anywhere. */
export type ModemId = "MFSK" | "DOMINO" | "MT63" | "THOR" | "THROB" | "FSQ" | "IFKP" | "NAVTEX" | "WEFAX";

export const MODEM_IDS: readonly ModemId[] = ["MFSK", "DOMINO", "MT63", "THOR", "THROB", "FSQ", "IFKP", "NAVTEX", "WEFAX"];

/** What every modem's demodulator does. */
export interface ModemDemodulator {
  feed(samples: ArrayLike<number>): string;
  retune(centreHz: number): void;
  reset(): void;
  readonly statistics: {
    chars: number;
    errors: number;
    /** 0 to 1: how sure the decoder is of what it is reading. */
    quality: number;
    afcHz: number;
    open: boolean;
    level: number;
  };
}

/** One size or speed of a modem: MFSK16, DominoEX 11, MT63-1000L. */
export interface ModemSub {
  id: string;
  /** As an operator says it. */
  label: string;
  /** The width it occupies, Hz: the waterfall marks this either side of the centre. */
  bandwidthHz: number;
  /**
   * As the log stores it (lib/ham/modes.ts), which lib/adif/fields.ts maps to MODE/SUBMODE.
   * None for a mode ADIF has no name for (IFKP): no log bar, as JTTY has none, because a
   * contact under a mode the upload services do not know is refused there.
   */
  logMode?: string;
  /** fldigi's RSID code for it, when it has one. */
  rsidCode?: number;
}

export interface ModemSpec {
  id: ModemId;
  label: string;
  subs: readonly ModemSub[];
  defaultSub: string;
  /** Where the centre starts, Hz audio. */
  defaultCentreHz: number;
  /** The longest a line may be on the air, ms. */
  maxSendMs: number;
  /**
   * Listen only (NAVTEX): no Send box, no exchange bar, and the bridge refuses to key.
   * `waveform` may still exist, as a test generator.
   */
  receiveOnly?: boolean;
  /**
   * Pictures rather than text (WEFAX): the decoder hands them to `onPicture` as SSTV's events,
   * and the page shows the picture panel instead of the text panel. The bridge saves them
   * beside the SSTV pictures.
   */
  picture?: boolean;
  demodulator(opts: { sampleRate: number; centreHz: number; sub: string; onPicture?: (e: SstvEvent) => void }): ModemDemodulator;
  /** `mycall`: the station's callsign, for a mode that heads each over with it (FSQ). */
  waveform(text: string, opts: { sampleRate: number; centreHz: number; sub: string; mycall?: string }): Float32Array;
  durationMs(text: string, sub: string): number;
}

/** fldigi's RSID codes for DominoEX, by speed (rsid_defs.cxx). The FEC variants are not sent. */
const DOMINOEX_RSID: Record<DominoexMode, number> = { 4: 84, 5: 85, 8: 86, 11: 87, 16: 88, 22: 90 };

const DOMINO: ModemSpec = {
  id: "DOMINO",
  label: "DominoEX",
  subs: DOMINOEX_MODES.map((m) => ({
    id: String(m),
    label: `DominoEX ${m}`,
    bandwidthHz: Math.round(dominoexParams(m).bandwidthHz),
    // ADIF has no DominoEX speeds: MODE=DOMINO SUBMODE=DOMINOEX whatever the speed.
    logMode: "DOMINOEX",
    rsidCode: DOMINOEX_RSID[m],
  })),
  defaultSub: "11",
  defaultCentreHz: DOMINOEX_CENTRE_HZ,
  // DominoEX 4 is about two characters a second: a minute holds a full line.
  maxSendMs: 60_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new DominoexDemodulator({ sampleRate, centreHz, mode: dominoexMode(sub) }),
  waveform: (text, { sampleRate, centreHz, sub }) => dominoexWaveform(text, { sampleRate, centreHz, mode: dominoexMode(sub) }),
  durationMs: (text, sub) => dominoexDurationMs(text, { mode: dominoexMode(sub) }),
};

function dominoexMode(sub: string): DominoexMode {
  const n = Number(sub);
  return (DOMINOEX_MODES as readonly number[]).includes(n) ? (n as DominoexMode) : 11;
}

/** fldigi's RSID codes for MFSK, by speed (rsid_defs.cxx). */
const MFSK_RSID: Record<MfskModeName, number> = { MFSK8: 60, MFSK11: 148, MFSK16: 57, MFSK22: 152, MFSK32: 147 };
const MFSK_ORDER: readonly MfskModeName[] = ["MFSK8", "MFSK11", "MFSK16", "MFSK22", "MFSK32"];

function mfskName(sub: string): MfskModeName {
  const n = `MFSK${sub}` as MfskModeName;
  return MFSK_ORDER.includes(n) ? n : "MFSK16";
}

const MFSK: ModemSpec = {
  id: "MFSK",
  label: "MFSK",
  subs: MFSK_ORDER.map((name) => ({
    id: name.slice(4),
    label: name,
    bandwidthHz: Math.round(MFSK_MODES[name].bandwidthHz),
    // ADIF's MFSK submodes, as FT4 is one: MODE=MFSK SUBMODE=MFSK16.
    logMode: name,
    rsidCode: MFSK_RSID[name],
  })),
  defaultSub: "16",
  defaultCentreHz: MFSK_CENTRE_HZ,
  // MFSK8 is under four characters a second: a minute holds a line.
  maxSendMs: 60_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new MfskDemodulator({ sampleRate, centreHz, mode: mfskName(sub) }),
  waveform: (text, { sampleRate, centreHz, sub }) => mfskWaveform(text, { sampleRate, centreHz, mode: mfskName(sub) }),
  durationMs: (text, sub) => mfskDurationMs(text, { mode: mfskName(sub) }),
};

/** fldigi's RSID codes for MT63 (rsid_defs.cxx). */
const MT63_RSID: Record<Mt63Mode, number> = { "500L": 9, "500S": 10, "1000L": 12, "1000S": 13, "2000L": 15, "2000S": 17 };

function mt63Mode(sub: string): Mt63Mode {
  return (MT63_MODES as readonly string[]).includes(sub) ? (sub as Mt63Mode) : "1000L";
}

const MT63: ModemSpec = {
  id: "MT63",
  label: "MT63",
  subs: MT63_MODES.map((m) => ({
    id: m,
    label: `MT63-${m}`,
    bandwidthHz: mt63Params(m).bandwidth,
    // ADIF has MT63 as a mode with no submodes.
    logMode: "MT63",
    rsidCode: MT63_RSID[m],
  })),
  // What NBEMS and ARES nets run most: 2000L on a wide channel, 1000L where it is tight.
  defaultSub: "1000L",
  defaultCentreHz: 1500,
  // The interleaver's fill and flush ride on every line: 13 s of them at MT63-500L.
  maxSendMs: 90_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new Mt63Demodulator({ sampleRate, centreHz, mode: mt63Mode(sub) }),
  waveform: (text, { sampleRate, centreHz, sub }) => mt63Waveform(text, { sampleRate, centreHz, mode: mt63Mode(sub) }),
  durationMs: (text, sub) => mt63DurationMs(text, { sampleRate: 12_000, centreHz: 1500, mode: mt63Mode(sub) }),
};

/** fldigi's RSID codes for Thor (rsid_defs.cxx): the fast ones are in its second table. */
const THOR_RSID: Record<ThorMode, number> = {
  "4": 136, "5": 139, "8": 137, "11": 143, "16": 138, "22": 145,
  "25x4": 639, "50x1": 649, "50x2": 653, "100": 658,
};

function thorMode(sub: string): ThorMode {
  return (THOR_MODES as readonly string[]).includes(sub) ? (sub as ThorMode) : "16";
}

const THOR: ModemSpec = {
  id: "THOR",
  label: "Thor",
  subs: THOR_MODES.map((m) => ({
    id: m,
    label: `Thor ${m}`,
    bandwidthHz: Math.round(thorParams(m).bandwidthHz),
    // ADIF's THOR submodes: THOR4 to THOR22, THOR25X4, THOR50X1, THOR50X2, THOR100.
    logMode: `THOR${m.toUpperCase()}`,
    rsidCode: THOR_RSID[m],
  })),
  defaultSub: "16",
  defaultCentreHz: THOR_CENTRE_HZ,
  // Thor 4 is about three characters a second, with the interleaver's flush on top.
  maxSendMs: 90_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new ThorDemodulator({ sampleRate, centreHz, mode: thorMode(sub) }),
  waveform: (text, { sampleRate, centreHz, sub }) => thorWaveform(text, { sampleRate, centreHz, mode: thorMode(sub) }),
  durationMs: (text, sub) => thorDurationMs(text, { mode: thorMode(sub) }),
};

/** fldigi's RSID codes for Throb and ThrobX (rsid_defs.cxx). */
const THROB_RSID: Record<ThrobMode, number> = { THROB1: 43, THROB2: 44, THROB4: 45, THROBX1: 46, THROBX2: 47, THROBX4: 146 };

function throbMode(sub: string): ThrobMode {
  const m = `THROB${sub}`;
  return (THROB_MODES as readonly string[]).includes(m) ? (m as ThrobMode) : "THROB2";
}

const THROB: ModemSpec = {
  id: "THROB",
  label: "Throb",
  subs: THROB_MODES.map((m) => {
    const sub = m.slice(5);
    return {
      id: sub,
      label: sub.startsWith("X") ? `ThrobX ${sub.slice(1)}` : `Throb ${sub}`,
      bandwidthHz: Math.round(throbParams(m).bandwidthHz),
      // fldigi logs Throb as MODE=THRB and ThrobX as MODE=THRB SUBMODE=THRBX (globals.cxx).
      logMode: sub.startsWith("X") ? "THRBX" : "THRB",
      rsidCode: THROB_RSID[m],
    };
  }),
  defaultSub: "2",
  defaultCentreHz: THROB_CENTRE_HZ,
  // Throb 1 is about a character a second.
  maxSendMs: 120_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new ThrobDemodulator({ sampleRate, centreHz, mode: throbMode(sub) }),
  waveform: (text, { sampleRate, centreHz, sub }) => throbWaveform(text, { sampleRate, centreHz, mode: throbMode(sub) }),
  durationMs: (text, sub) => throbDurationMs(text, { mode: throbMode(sub) }),
};

function fsqSpeed(sub: string): FsqSpeed {
  return (FSQ_SPEEDS as readonly string[]).includes(sub) ? (sub as FsqSpeed) : "4.5";
}

const FSQ: ModemSpec = {
  id: "FSQ",
  label: "FSQ",
  subs: FSQ_SPEEDS.map((s) => ({
    id: s,
    label: `FSQ ${s}`,
    bandwidthHz: FSQ_BANDWIDTH_HZ,
    // ADIF's FSQ is MFSK's FSQCALL submode. fldigi has no RSID code for FSQ.
    logMode: "FSQCALL",
  })),
  defaultSub: "4.5",
  defaultCentreHz: FSQ_CENTRE_HZ,
  // FSQ 1.5 is about a character a second.
  maxSendMs: 90_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new FsqDemodulator({ sampleRate, centreHz, speed: fsqSpeed(sub) }),
  // fldigi heads every FSQ over with "MYCALL:", which FSQ stations read as who is speaking.
  waveform: (text, { sampleRate, centreHz, sub, mycall }) => fsqWaveform(text, { sampleRate, centreHz, speed: fsqSpeed(sub), mycall }),
  durationMs: (text, sub) => fsqDurationMs(text, { speed: fsqSpeed(sub) }),
};

function ifkpSpeed(sub: string): IfkpSpeed {
  return (IFKP_SPEEDS as readonly string[]).includes(sub) ? (sub as IfkpSpeed) : "1";
}

const IFKP: ModemSpec = {
  id: "IFKP",
  label: "IFKP",
  subs: IFKP_SPEEDS.map((s) => ({
    id: s,
    label: `IFKP ${Number(s).toFixed(1)}`,
    bandwidthHz: IFKP_BANDWIDTH_HZ,
    // fldigi has one RSID code for IFKP, in its second table: on the default speed only,
    // since a heard code switches to the first sub that carries it.
    rsidCode: s === "1" ? 1171 : undefined,
  })),
  defaultSub: "1",
  defaultCentreHz: IFKP_CENTRE_HZ,
  maxSendMs: 90_000,
  demodulator: ({ sampleRate, centreHz, sub }) => new IfkpDemodulator({ sampleRate, centreHz, speed: ifkpSpeed(sub) }),
  waveform: (text, { sampleRate, centreHz, sub }) => ifkpWaveform(text, { sampleRate, centreHz, speed: ifkpSpeed(sub) }),
  durationMs: (text, sub) => ifkpDurationMs(text, { speed: ifkpSpeed(sub) }),
};

const NAVTEX: ModemSpec = {
  id: "NAVTEX",
  label: "NAVTEX",
  subs: [
    // 100 baud, 170 Hz shift: the two tones and the keying either side.
    { id: "NAVTEX", label: "NAVTEX", bandwidthHz: 270 },
    // The same signal on HF without NAVTEX's message framing.
    { id: "SITOR-B", label: "SITOR-B", bandwidthHz: 270 },
  ],
  defaultSub: "NAVTEX",
  defaultCentreHz: NAVTEX_CENTRE_HZ,
  // Only the test generator uses this: the bridge refuses to send in a listen-only mode.
  maxSendMs: 120_000,
  // Marine broadcasts: amateurs listen, nobody here sends. The waveform is the receiver's
  // test generator, never offered on the air.
  receiveOnly: true,
  demodulator: ({ sampleRate, centreHz, sub }) => new NavtexDemodulator({ sampleRate, centreHz, sub }),
  waveform: (text, { sampleRate, centreHz, sub }) => navtexWaveform(text, { sampleRate, centreHz, sitorB: sub === "SITOR-B", phasingSeconds: 3 }),
  durationMs: (text, sub) => navtexDurationMs(text, { sitorB: sub === "SITOR-B", phasingSeconds: 3 }),
};

/**
 * WEFAX as a modem: the decoder makes pictures, which go out as SSTV's start, rows and image
 * events so the SSTV panel draws them and the bridge saves them. feed() prints no text.
 */
function wefaxDemodulator(sampleRate: number, centreHz: number, onPicture?: (e: SstvEvent) => void): ModemDemodulator {
  let centre = centreHz;
  let mode = "WEFAX";
  const make = () =>
    new WefaxDecoder(
      sampleRate,
      {
        onStart: (info) => {
          mode = `WEFAX ${info.lpm} LPM IOC ${info.ioc}`;
          // The height is not known until the stop tone: the panel is given room for the most there can be.
          onPicture?.({ kind: "start", mode, width: info.width, height: WEFAX_MAX_LINES, at: info.at });
        },
        onRows: (img, from, to) =>
          onPicture?.({ kind: "rows", from, to, width: img.width, rgb: img.rgb.slice(from * img.width * 3, to * img.width * 3) }),
        onImage: (img, info) =>
          onPicture?.({
            kind: "image",
            mode,
            width: img.width,
            height: img.height,
            rgb: img.rgb,
            at: info.at,
            // SSTV's report fields, which a fax does not have: aligned is "sync found".
            signal: { syncFound: info.aligned ? 1 : 0, syncNoiseHz: 0 },
          }),
      },
      { carrierHz: centre },
    );
  let dec = make();
  const stats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0 };
  return {
    feed(samples) {
      dec.feed(samples);
      const s = dec.statistics;
      stats.chars = s.lines;
      stats.open = s.receiving;
      stats.level = Math.pow(10, s.levelDb / 20);
      stats.quality = s.receiving ? 1 : 0;
      return "";
    },
    retune(c) {
      centre = c;
      if (dec.statistics.receiving) onPicture?.({ kind: "abort", at: Date.now() });
      dec = make();
    },
    reset() {
      if (dec.statistics.receiving) onPicture?.({ kind: "abort", at: Date.now() });
      dec = make();
    },
    get statistics() {
      return stats;
    },
  };
}

const WEFAX: ModemSpec = {
  id: "WEFAX",
  label: "WEFAX",
  // The decoder takes IOC 576 or 288 from the start tone, and the line rate from the phasing.
  subs: [{ id: "auto", label: "WEFAX (IOC and LPM from the signal)", bandwidthHz: 1000 }],
  defaultSub: "auto",
  // Black 1500 Hz, white 2300: with the dial 1.9 kHz below the published frequency.
  defaultCentreHz: WEFAX_CARRIER_HZ,
  maxSendMs: 1_500_000,
  receiveOnly: true,
  picture: true,
  demodulator: ({ sampleRate, centreHz, onPicture }) => wefaxDemodulator(sampleRate, centreHz, onPicture),
  // The test generator, never offered on the air: a 40-line test chart.
  waveform: (_text, { sampleRate, centreHz }) =>
    wefaxWaveform(wefaxTestPattern(1809, 40), { sampleRate, ioc: 576, lpm: 120, carrierHz: centreHz, withApt: true }),
  durationMs: () => 0,
};

/** The table. Entries are added as each modem lands. */
export const MODEMS: Partial<Record<ModemId, ModemSpec>> = { MFSK, DOMINO, MT63, THOR, THROB, FSQ, IFKP, NAVTEX, WEFAX };

export function isModemId(mode: string | null | undefined): mode is ModemId {
  return !!mode && (MODEM_IDS as readonly string[]).includes(mode);
}

/** The modem's entry, when it has one. */
export function modem(id: string | null | undefined): ModemSpec | null {
  return isModemId(id) ? (MODEMS[id] ?? null) : null;
}

/** A sub of a modem, falling back to its default for an unknown one. */
export function modemSub(spec: ModemSpec, sub: string | null | undefined): ModemSub {
  return spec.subs.find((s) => s.id === sub) ?? spec.subs.find((s) => s.id === spec.defaultSub) ?? spec.subs[0]!;
}

/** The registered modems, in table order: what the pickers offer. */
export function registeredModems(): ModemSpec[] {
  return MODEM_IDS.map((id) => MODEMS[id]).filter((m): m is ModemSpec => !!m);
}

/** Every log mode the modems write, for the log's tables. */
export function modemLogModes(): string[] {
  return registeredModems().flatMap((m) => m.subs.flatMap((s) => (s.logMode ? [s.logMode] : [])));
}

/** The modem and sub an RSID code names, if any. */
export function modemForRsid(code: number): { modem: ModemId; sub: string } | null {
  for (const m of registeredModems()) {
    const s = m.subs.find((x) => x.rsidCode === code);
    if (s) return { modem: m.id, sub: s.id };
  }
  return null;
}

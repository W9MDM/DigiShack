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

/** The registered keyboard modes. A name here with no entry in MODEMS is not offered anywhere. */
export type ModemId = "MFSK" | "DOMINO" | "MT63";

export const MODEM_IDS: readonly ModemId[] = ["MFSK", "DOMINO", "MT63"];

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
  /** As the log stores it (lib/ham/modes.ts), which lib/adif/fields.ts maps to MODE/SUBMODE. */
  logMode: string;
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
  demodulator(opts: { sampleRate: number; centreHz: number; sub: string }): ModemDemodulator;
  waveform(text: string, opts: { sampleRate: number; centreHz: number; sub: string }): Float32Array;
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

/** The table. Entries are added as each modem lands. */
export const MODEMS: Partial<Record<ModemId, ModemSpec>> = { MFSK, DOMINO };

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
  return registeredModems().flatMap((m) => m.subs.map((s) => s.logMode));
}

/** The modem and sub an RSID code names, if any. */
export function modemForRsid(code: number): { modem: ModemId; sub: string } | null {
  for (const m of registeredModems()) {
    const s = m.subs.find((x) => x.rsidCode === code);
    if (s) return { modem: m.id, sub: s.id };
  }
  return null;
}

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

/** The table. Entries are added as each modem lands. */
export const MODEMS: Partial<Record<ModemId, ModemSpec>> = {};

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

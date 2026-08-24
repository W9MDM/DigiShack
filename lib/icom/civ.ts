// CI-V: Icom's control language.
//
// Unlike the network transport, this part is documented — CI-V is the same command set
// the USB CAT port speaks, and Icom publishes it in the back of the manual. Nothing
// here was reverse-engineered; the only thing the network adds is that the frames
// arrive over UDP port 50002 instead of a serial cable.
//
// Frames are `FE FE <to> <from> <cmd> [sub] [data...] FD`. Data is BCD, so no byte can
// exceed 0x99 and the terminator can never appear inside a payload. That is why there
// is no escaping anywhere in this file, and why there does not need to be.

/** Controller address. 0xE0 is the conventional "a PC is talking" value. */
export const CIV_CONTROLLER = 0xe0;

/**
 * Default radio addresses.
 *
 * Each model ships with its own, and an operator can change it in the menu — which is
 * why this is a starting point exposed as a setting rather than a constant compiled in.
 */
export const CIV_DEFAULT_ADDRESS: Record<string, number> = {
  "IC-7300": 0x94,
  "IC-705": 0xa4,
  "IC-9700": 0xa2,
  "IC-7610": 0x98,
};

const START = 0xfe;
const END = 0xfd;

export const CivCommand = {
  /** Broadcast from the radio when the operator turns the dial. */
  transceiveFrequency: 0x00,
  transceiveMode: 0x01,
  readFrequency: 0x03,
  readMode: 0x04,
  setFrequency: 0x05,
  setMode: 0x06,
  split: 0x0f,
  level: 0x14,
  meter: 0x15,
  /** On/off and multi-state receiver functions — AGC, noise blanker, noise reduction. */
  function: 0x16,
  /** 0x1c 0x00 is PTT. */
  control: 0x1c,
  /** Mode, data mode and filter together — what FT8 actually needs. */
  modeWithData: 0x26,
  /** The spectrum scope. See ScopeSub. */
  scope: 0x27,
} as const;

/**
 * Sub-commands of 0x27, the spectrum scope.
 *
 * From Icom's published CI-V table for the IC-7300. Only the ones this project
 * actually sends are here, and each is confirmed against the radio by
 * `scripts/probe-icom-scope.ts` rather than trusted — a sub-command a model does not
 * implement answers 0xFA, which `civWrite` reports as a refusal.
 *
 * `waveform` is the odd one out: it is never sent, only received. The radio pushes
 * waveform frames unprompted once `dataOutput` is on, which is the whole reason the
 * loading question in docs/panadapter.md had to be answered before any of this was
 * switched on.
 */
export const ScopeSub = {
  /** Waveform data, radio -> controller. Never sent by us. */
  waveform: 0x00,
  /** The scope itself, on the radio's own display. */
  onOff: 0x10,
  /** Whether the radio streams waveform data over CI-V. This is the tap. */
  dataOutput: 0x11,
  /** 0 centre mode, 1 fixed mode. */
  mode: 0x12,
  /** Span either side of centre, in centre mode. */
  span: 0x13,
  /** Hold. */
  hold: 0x15,
  /** Reference level. */
  reference: 0x16,
  /** Sweep speed. */
  speed: 0x17,
} as const;

/** Reply codes the radio sends instead of data. */
export const CivReply = {
  ok: 0xfb,
  notGood: 0xfa,
} as const;

export const CivMode = {
  LSB: 0x00,
  USB: 0x01,
  AM: 0x02,
  CW: 0x03,
  RTTY: 0x04,
  FM: 0x05,
  WFM: 0x06,
  "CW-R": 0x07,
  "RTTY-R": 0x08,
  DV: 0x17,
} as const;

export type CivModeName = keyof typeof CivMode;

export interface CivFrame {
  to: number;
  from: number;
  command: number;
  /** Present when the command has one; commands like 0x03 do not. */
  sub: number | null;
  data: Buffer;
}

// ------------------------------------------------------------------------- framing

export function buildFrame(f: {
  to: number;
  from?: number;
  command: number;
  sub?: number;
  data?: Buffer | number[];
}): Buffer {
  const data = f.data ? Buffer.from(f.data as number[]) : Buffer.alloc(0);
  const head = [START, START, f.to, f.from ?? CIV_CONTROLLER, f.command];
  if (f.sub !== undefined) head.push(f.sub);
  return Buffer.concat([Buffer.from(head), data, Buffer.from([END])]);
}

/**
 * Pull complete frames out of a stream.
 *
 * Returns the frames found and whatever trailing bytes did not form one, so a caller
 * can prepend the remainder to the next read. UDP does not guarantee a datagram holds
 * exactly one frame, and the radio does coalesce them.
 *
 * `sub` is reported as the byte after the command for every command, because whether
 * one exists is a property of the command and not of the framing. Callers that know
 * their command has no sub-command should read `data` from the raw payload instead —
 * `parseFrames` therefore also keeps the full payload available.
 */
export function parseFrames(buf: Buffer): { frames: CivFrame[]; rest: Buffer } {
  const frames: CivFrame[] = [];
  let i = 0;

  while (i < buf.length) {
    // Find the next FE FE.
    while (i + 1 < buf.length && !(buf[i] === START && buf[i + 1] === START)) i++;
    if (i + 1 >= buf.length) break;

    const end = buf.indexOf(END, i + 2);
    if (end === -1) break; // Incomplete — leave it for the next read.

    const body = buf.subarray(i + 2, end);
    if (body.length >= 3) {
      frames.push({
        to: body[0] as number,
        from: body[1] as number,
        command: body[2] as number,
        sub: body.length > 3 ? (body[3] as number) : null,
        data: Buffer.from(body.subarray(3)),
      });
    }
    i = end + 1;
  }

  return { frames, rest: Buffer.from(buf.subarray(i)) };
}

/**
 * True when a frame is our own command coming back at us.
 *
 * CI-V is a bus and the radio echoes what it hears. Treating an echo as a reply is the
 * classic CI-V bug: every read appears to succeed instantly and returns the value that
 * was just written, so a frequency read confirms whatever was last set rather than what
 * the radio is actually on.
 */
export function isEcho(frame: CivFrame, controller = CIV_CONTROLLER): boolean {
  return frame.from === controller;
}

// ----------------------------------------------------------------------------- BCD

/**
 * Frequency to the five little-endian BCD bytes CI-V wants.
 *
 * 14.074 MHz becomes `00 40 07 14 00`: least-significant pair first, two decimal digits
 * per byte. Sending this big-endian tunes the radio to something absurd, which at least
 * fails loudly.
 */
export function encodeFrequency(hz: number): Buffer {
  const out = Buffer.alloc(5);
  let v = Math.max(0, Math.round(hz));
  for (let i = 0; i < 5; i++) {
    const lo = v % 10;
    v = Math.floor(v / 10);
    const hi = v % 10;
    v = Math.floor(v / 10);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function decodeFrequency(buf: Buffer): number | null {
  if (buf.length < 5) return null;
  let hz = 0;
  for (let i = 4; i >= 0; i--) {
    const b = buf[i] as number;
    const hi = b >> 4;
    const lo = b & 0x0f;
    if (hi > 9 || lo > 9) return null; // Not BCD — a truncated or misaligned frame.
    hz = hz * 100 + hi * 10 + lo;
  }
  return hz;
}

/** Two-byte BCD, as the meters use: 0000-0255. */
export function decodeBcd2(buf: Buffer): number | null {
  if (buf.length < 2) return null;
  const [a, b] = [buf[0] as number, buf[1] as number];
  const digits = [a >> 4, a & 0x0f, b >> 4, b & 0x0f];
  if (digits.some((d) => d > 9)) return null;
  return digits[0]! * 1000 + digits[1]! * 100 + digits[2]! * 10 + digits[3]!;
}

export function encodeBcd2(value: number): Buffer {
  const v = Math.min(9999, Math.max(0, Math.round(value)));
  const d = [Math.floor(v / 1000) % 10, Math.floor(v / 100) % 10, Math.floor(v / 10) % 10, v % 10];
  return Buffer.from([(d[0]! << 4) | d[1]!, (d[2]! << 4) | d[3]!]);
}

// ------------------------------------------------------------------------ commands

export function readFrequency(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.readFrequency });
}

export function setFrequency(to: number, hz: number): Buffer {
  return buildFrame({ to, command: CivCommand.setFrequency, data: encodeFrequency(hz) });
}

export function readMode(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.readMode });
}

/**
 * Set mode, data mode and filter in one command.
 *
 * The plain 0x06 set-mode does not touch the data flag, and FT8 on a radio that is in
 * USB rather than USB-D routes audio to the microphone instead of the USB codec. The
 * symptom is a transmitter that keys and sends nothing, which is a long way to look for
 * a one-byte flag.
 */
export function setModeWithData(
  to: number,
  mode: CivModeName,
  dataMode: boolean,
  filter: 1 | 2 | 3 = 1,
): Buffer {
  return buildFrame({
    to,
    command: CivCommand.modeWithData,
    sub: 0x00,
    data: [CivMode[mode], dataMode ? 0x01 : 0x00, filter],
  });
}

export function readModeWithData(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.modeWithData, sub: 0x00 });
}

/**
 * Read back what 0x26 reports: mode, the data flag, and the filter.
 *
 * The one check that matters before a digital transmission. `dataMode` false means the
 * radio will take transmit audio from the microphone, key perfectly, and send nothing —
 * and nothing downstream can tell that from a dead band.
 */
export function modeWithDataFrom(data: Buffer): {
  mode: CivModeName | null;
  dataMode: boolean;
  filter: number | null;
} | null {
  // Payload is the echoed sub-command, then mode, data flag, filter.
  if (data.length < 4) return null;
  const modeByte = data[1] as number;
  const name =
    (Object.keys(CivMode) as CivModeName[]).find((k) => CivMode[k] === modeByte) ?? null;
  return { mode: name, dataMode: data[2] === 0x01, filter: data[3] ?? null };
}

/** True when a 0x1C 0x00 reply says the transmitter is keyed. */
export function pttFrom(data: Buffer): boolean {
  return (data.length > 1 ? data[1] : data[0]) === 0x01;
}

/** PTT. `true` keys the transmitter. */
export function setPtt(to: number, transmit: boolean): Buffer {
  return buildFrame({
    to,
    command: CivCommand.control,
    sub: 0x00,
    data: [transmit ? 0x01 : 0x00],
  });
}

export function readPtt(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.control, sub: 0x00 });
}

/**
 * Start the internal ATU's tune cycle. `0x1C 0x01` with `0x02`.
 *
 * THIS TRANSMITS. The radio drops to a low power carrier for a second or two while the
 * tuner finds a match, which is why every caller is behind the same transmit gate as
 * keying — an ATU cycle into a disconnected antenna is exactly as unwise as a CQ into
 * one.
 *
 * `0x00` and `0x01` on the same sub-command switch the tuner out and in. Those are not
 * exposed: an operator who wants the tuner bypassed can say so on the radio, and a
 * command that silently disables the ATU before a band change would be a good way to
 * transmit into a mismatch without knowing why.
 */
export function atuTune(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.control, sub: 0x01, data: [0x02] });
}

/** Ask the tuner what it is doing: 0 bypassed, 1 in line, 2 tuning right now. */
export function readAtu(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.control, sub: 0x01 });
}

export type AtuState = "bypassed" | "in-line" | "tuning" | "unknown";

export function atuStateFrom(data: Buffer): AtuState {
  // The reply echoes the sub-command byte, so the value is the byte after it.
  const v = data.length > 1 ? data[1] : data[0];
  if (v === 0x00) return "bypassed";
  if (v === 0x01) return "in-line";
  if (v === 0x02) return "tuning";
  return "unknown";
}

/** Read the transmit power level. Same 0-255 scale `setRfPower` writes. */
export function readRfPower(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.level, sub: 0x0a });
}

/**
 * Percent from a level reply, or null when the payload is not a level.
 *
 * The reply carries the sub-command byte first, then two BCD bytes — reading the BCD
 * from offset 0 gives a number that looks plausible and is wrong, which is the kind of
 * bug that survives review.
 */
export function rfPowerPercentFrom(data: Buffer): number | null {
  const raw = decodeBcd2(data.subarray(1));
  if (raw === null) return null;
  return Math.round((raw / 255) * 100);
}

/** Transmit power, 0-100%. The radio takes 0-255 across that range. */
export function setRfPower(to: number, percent: number): Buffer {
  const clamped = Math.min(100, Math.max(0, percent));
  return buildFrame({
    to,
    command: CivCommand.level,
    sub: 0x0a,
    data: encodeBcd2(Math.round((clamped / 100) * 255)),
  });
}

/**
 * Sub-commands of 0x16, the receiver functions.
 *
 * From the published CI-V table, common to the modern network-capable radios (IC-7300,
 * IC-7610, IC-9700, IC-705). Not verified against every model, and it does not need to
 * be: every write here goes through `civWrite`, which waits for the radio's own OK or NG
 * reply. A sub-command a radio does not implement answers NG and is reported as refused,
 * rather than silently doing nothing — which is the failure mode this whole endpoint
 * existed to avoid.
 */
export const FunctionSub = {
  preamp: 0x02,
  /** 01 fast, 02 mid, 03 slow. No "off" — see setAgc. */
  agc: 0x12,
  noiseBlanker: 0x22,
  noiseReduction: 0x40,
} as const;

/** Sub-commands of 0x14, the continuously variable levels. All 0000-0255 BCD. */
export const LevelSub = {
  rfGain: 0x02,
  noiseReductionLevel: 0x06,
  rfPower: 0x0a,
} as const;

export type AgcSetting = "fast" | "mid" | "slow";

const AGC_VALUE: Record<AgcSetting, number> = { fast: 0x01, mid: 0x02, slow: 0x03 };

/**
 * AGC time constant.
 *
 * The FlexRadio's panel offers off / slow / med / fast, and this command has no "off":
 * on these radios AGC-OFF is a per-mode menu item, not a CI-V function. So "off" is
 * refused by name at the endpoint rather than quietly mapped to fast, which would be a
 * control that appears to work and does the opposite of what it says.
 *
 * "med" is the FlexRadio's spelling of the same thing and is accepted as "mid".
 */
export function setAgc(to: number, setting: AgcSetting): Buffer {
  return buildFrame({
    to,
    command: CivCommand.function,
    sub: FunctionSub.agc,
    data: Buffer.from([AGC_VALUE[setting]]),
  });
}

export function readAgc(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.function, sub: FunctionSub.agc });
}

/** The AGC setting from a 0x16 0x12 reply, or null when the payload is not one. */
export function agcFrom(data: Buffer): AgcSetting | null {
  const v = data.length > 1 ? data[1] : data[0];
  if (v === 0x01) return "fast";
  if (v === 0x02) return "mid";
  if (v === 0x03) return "slow";
  return null;
}

/** Any simple on/off function: noise blanker, noise reduction, preamp. */
export function setFunction(
  to: number,
  sub: (typeof FunctionSub)[keyof typeof FunctionSub],
  on: boolean,
): Buffer {
  return buildFrame({
    to,
    command: CivCommand.function,
    sub,
    data: Buffer.from([on ? 0x01 : 0x00]),
  });
}

export function readFunction(
  to: number,
  sub: (typeof FunctionSub)[keyof typeof FunctionSub],
): Buffer {
  return buildFrame({ to, command: CivCommand.function, sub });
}

/** On/off from a 0x16 reply. The sub-command byte comes first, then the state. */
export function functionStateFrom(data: Buffer): boolean | null {
  const v = data.length > 1 ? data[1] : data[0];
  if (v === 0x00) return false;
  if (v === 0x01) return true;
  return null;
}

/**
 * A 0x14 level as a percentage. The radio's scale is 0-255 across the full range.
 *
 * The FlexRadio's rfGain is dB of attenuation on a -10..+30 scale and the Icom's is a
 * percentage of a different thing entirely, so the two are not interchangeable and the
 * web panel's number does not carry across. Percent is what every other level in this
 * file uses, and it is what the UI already sends for power.
 */
export function setLevel(
  to: number,
  sub: (typeof LevelSub)[keyof typeof LevelSub],
  percent: number,
): Buffer {
  const clamped = Math.min(100, Math.max(0, percent));
  return buildFrame({
    to,
    command: CivCommand.level,
    sub,
    data: encodeBcd2(Math.round((clamped / 100) * 255)),
  });
}

export function readLevel(
  to: number,
  sub: (typeof LevelSub)[keyof typeof LevelSub],
): Buffer {
  return buildFrame({ to, command: CivCommand.level, sub });
}

// ----------------------------------------------------------------- spectrum scope

/**
 * Turn the radio's CI-V waveform output on or off.
 *
 * THIS IS THE TAP, and it is not like any other command in this file. Everything
 * else here is a request/reply: one frame out, one frame back. This one makes the
 * radio push waveform frames continuously, on the SAME serial stream that carries
 * the frequency poll and all three meters — and that stream is paced 70 ms apart
 * precisely because the radio drops commands when it is busy. Measure before
 * switching it on; see docs/panadapter.md.
 *
 * `0x00` selects the main scope. The IC-7300 has only one, but the byte is required.
 */
export function setScopeDataOutput(to: number, on: boolean): Buffer {
  return buildFrame({
    to,
    command: CivCommand.scope,
    sub: ScopeSub.dataOutput,
    data: [on ? 0x01 : 0x00],
  });
}

export function readScopeDataOutput(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.scope, sub: ScopeSub.dataOutput });
}

/** Turn the scope on the radio's own display on or off. */
export function setScopeOn(to: number, on: boolean): Buffer {
  return buildFrame({
    to,
    command: CivCommand.scope,
    sub: ScopeSub.onOff,
    data: [on ? 0x01 : 0x00],
  });
}

export function readScopeOn(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.scope, sub: ScopeSub.onOff });
}

/**
 * Centre mode (the scope follows the dial) or fixed mode (a band segment).
 *
 * Centre is what a panadapter above a receiver normally wants. The leading `0x00`
 * is the scope selector, as on every other 0x27 sub-command.
 */
export function setScopeMode(to: number, mode: "centre" | "fixed"): Buffer {
  return buildFrame({
    to,
    command: CivCommand.scope,
    sub: ScopeSub.mode,
    data: [0x00, mode === "fixed" ? 0x01 : 0x00],
  });
}

/** The spans the IC-7300 offers, in Hz either side of centre. */
export const SCOPE_SPANS_HZ = [
  2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000,
] as const;

export type ScopeSpanHz = (typeof SCOPE_SPANS_HZ)[number];

/**
 * Set the span, in Hz either side of centre.
 *
 * The radio takes the span as a five-byte BCD frequency, the same encoding as a dial
 * frequency, preceded by the scope selector. A span the radio does not offer is
 * refused rather than rounded here: rounding would silently give a display whose
 * axis labels disagree with the data, which is the failure this whole exercise is
 * about.
 */
export function setScopeSpan(to: number, hz: ScopeSpanHz): Buffer {
  return buildFrame({
    to,
    command: CivCommand.scope,
    sub: ScopeSub.span,
    data: Buffer.concat([Buffer.from([0x00]), encodeFrequency(hz)]),
  });
}

export function readScopeSpan(to: number): Buffer {
  return buildFrame({ to, command: CivCommand.scope, sub: ScopeSub.span, data: [0x00] });
}

export const MeterSub = {
  sMeter: 0x02,
  power: 0x11,
  swr: 0x12,
} as const;

export function readMeter(to: number, sub: (typeof MeterSub)[keyof typeof MeterSub]): Buffer {
  return buildFrame({ to, command: CivCommand.meter, sub });
}

// -------------------------------------------------------------------- meter scaling

/**
 * S-meter reading to S-units.
 *
 * The radio reports 0-255 against calibration points Icom publishes: 0 is S0, 120 is
 * S9, and 241 is S9+60 dB. Between them it is linear enough for a display, and this
 * interpolates rather than pretending the whole range is one slope — treating it as
 * linear to 255 reads about two S-units low at S9.
 */
export function sMeterToSUnits(raw: number): number {
  if (raw <= 0) return 0;
  if (raw <= 120) return (raw / 120) * 9;
  return 9 + ((raw - 120) / (241 - 120)) * 6; // Each "S9+10dB" step counted as one unit.
}

/** S-meter reading to dBm, taking S9 as -73 dBm and each S-unit as 6 dB. */
export function sMeterToDbm(raw: number): number {
  const s = sMeterToSUnits(raw);
  return s <= 9 ? -73 - (9 - s) * 6 : -73 + (s - 9) * 10;
}

/**
 * SWR reading to a ratio.
 *
 * Calibration points from the manual: 0 is 1.0, 48 is 1.5, 80 is 2.0, 120 is 3.0.
 * Beyond 120 the radio stops being specific, so this extrapolates on the last segment
 * and the caller should treat anything over 3 as "too high" rather than a measurement.
 */
/**
 * Forward power from the Po meter, in watts.
 *
 * Icom's published scale for this meter is piecewise and nothing like linear: 0 is 0%,
 * 141 is 50% and 213 is 100% of the radio's rated output. Treating the raw 0-255 as a
 * straight percentage reads 55% at half power and 84% at full, which is wrong in the
 * direction that matters — it flatters a radio that is barely producing anything.
 *
 * `maxWatts` is the rig's rating: 100 for an IC-7300, 10 for an IC-705.
 *
 * WHY THIS IS WORTH HAVING, beyond a pretty meter: `MOD Input -> DATA MOD` set to
 * anything but LAN makes the radio key perfectly and transmit silence, and the
 * documentation here has said for weeks that no software can detect it. That is not
 * quite true. SSB with no modulation produces no output, so a Po meter reading of
 * nothing WHILE KEYED is exactly that fault, visible from software.
 */
export function poMeterToWatts(raw: number, maxWatts = 100): number {
  const pct =
    raw <= 0
      ? 0
      : raw <= 141
        ? (raw / 141) * 50
        : raw <= 213
          ? 50 + ((raw - 141) / (213 - 141)) * 50
          : 100;
  return (Math.min(100, pct) / 100) * maxWatts;
}

/** Watts as dBm, which is what the meter stream carries so both radios agree. */
export function wattsToDbm(watts: number): number | null {
  if (!(watts > 0)) return null;
  return 10 * Math.log10(watts * 1000);
}

export function swrFromRaw(raw: number): number {
  const points: Array<[number, number]> = [
    [0, 1],
    [48, 1.5],
    [80, 2],
    [120, 3],
  ];
  if (raw <= 0) return 1;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (raw <= x1) return y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0);
  }
  const [xl, yl] = points[points.length - 1]!;
  const [xp, yp] = points[points.length - 2]!;
  return yl + ((raw - xl) / (xl - xp)) * (yl - yp);
}

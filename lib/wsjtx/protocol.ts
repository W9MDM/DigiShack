// WSJT-X / wsjtx-omega UDP protocol — decode and encode.
//
// Derived from the decoder in the base contest logger (recoverable at
// `git show a8a48e2:lib/wsjtx/decoder.ts`), with three substantive changes:
//
//   1. Delta Frequency is captured. The original read and discarded it, which
//      is the one field DigitalDecode.freqOffset needs.
//   2. Status is parsed in full. The original stopped after dxCall, so
//      transmitting/decoding/txEnabled/deGrid/subMode were all unavailable — and
//      those are what a rig-status display is made of.
//   3. An ENCODER, which did not exist. Without it nothing can be sent back to
//      the decoder, so calling a station from the browser was impossible.
//
// Wire format: Qt QDataStream, big-endian.
//   magic (quint32 = 0xadbccbda), schema (quint32), type (quint32), id (utf8),
//   then type-specific fields.
// Strings are a quint32 byte length (0xffffffff = null) followed by UTF-8 bytes.

export const WSJTX_MAGIC = 0xadbccbda;

/** Schema 2 is what WSJT-X 2.x and Omega speak. */
export const WSJTX_SCHEMA = 2;

export enum WsjtxType {
  Heartbeat = 0,
  Status = 1,
  Decode = 2,
  Clear = 3,
  Reply = 4,
  QSOLogged = 5,
  Close = 6,
  Replay = 7,
  HaltTx = 8,
  FreeText = 9,
  WSPRDecode = 10,
  Location = 11,
  LoggedADIF = 12,
  HighlightCallsign = 13,
  SwitchConfiguration = 14,
  Configure = 15,
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  private buf: Buffer;
  private off = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Bytes left. Every read is guarded so a truncated packet throws rather than
   *  returning silently wrong values. */
  remaining(): number {
    return this.buf.length - this.off;
  }

  private need(n: number): void {
    if (this.remaining() < n) {
      throw new RangeError(
        `WSJT-X packet truncated: wanted ${n} bytes at offset ${this.off}, ${this.remaining()} left`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.off);
    this.off += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.off);
    this.off += 8;
    return v;
  }

  double(): number {
    this.need(8);
    const v = this.buf.readDoubleBE(this.off);
    this.off += 8;
    return v;
  }

  utf8(): string | null {
    const len = this.u32();
    if (len === 0xffffffff) return null; // Qt null string
    this.need(len);
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }

  /**
   * QDateTime: QDate (qint64 Julian day) + QTime (quint32 ms) + timespec
   * (quint8), and when the spec is OffsetFromUTC (2) a further qint32 of seconds.
   *
   * The original implementation read the spec byte and ignored the possible
   * offset, so every field after a QDateTime in a QSOLogged packet was read at
   * the wrong offset whenever WSJT-X sent spec 2.
   */
  dateTime(): { date: Date | null; timespec: number; offsetSeconds: number } {
    const julian = this.i64();
    const msSinceMidnight = this.u32();
    const timespec = this.u8();

    let offsetSeconds = 0;
    if (timespec === 2) offsetSeconds = this.i32();
    // Spec 3 (TimeZone) carries a zone id string; not emitted by WSJT-X, but
    // consume it rather than desynchronising if it ever appears.
    if (timespec === 3) this.utf8();

    return {
      date: julianToDate(julian, msSinceMidnight, offsetSeconds),
      timespec,
      offsetSeconds,
    };
  }
}

/** Julian day number + ms since midnight -> Date. Julian 2440588 is 1970-01-01. */
export function julianToDate(
  julian: bigint,
  msSinceMidnight: number,
  offsetSeconds = 0,
): Date | null {
  if (julian <= 0n) return null;
  const days = Number(julian) - 2440588;
  const ms = days * 86_400_000 + msSinceMidnight - offsetSeconds * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateToJulian(date: Date): {
  julian: bigint;
  msSinceMidnight: number;
} {
  const ms = date.getTime();
  const days = Math.floor(ms / 86_400_000);
  return {
    julian: BigInt(days + 2440588),
    msSinceMidnight: ms - days * 86_400_000,
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

class Writer {
  private parts: Buffer[] = [];

  u8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff);
    this.parts.push(b);
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.parts.push(b);
    return this;
  }

  i32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v | 0);
    this.parts.push(b);
    return this;
  }

  u64(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(v));
    this.parts.push(b);
    return this;
  }

  i64(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(v));
    this.parts.push(b);
    return this;
  }

  double(v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    this.parts.push(b);
    return this;
  }

  /** null encodes as 0xffffffff, which is distinct from an empty string. */
  utf8(v: string | null): this {
    if (v === null) return this.u32(0xffffffff);
    const bytes = Buffer.from(v, "utf8");
    this.u32(bytes.length);
    this.parts.push(bytes);
    return this;
  }

  dateTime(date: Date, timespec = 1): this {
    const { julian, msSinceMidnight } = dateToJulian(date);
    this.i64(julian);
    this.u32(msSinceMidnight);
    this.u8(timespec); // 1 = UTC
    return this;
  }

  /**
   * QColor. Qt writes: spec (quint8), then alpha, red, green, blue, pad — each
   * quint16, where 8-bit components are scaled by 0x101.
   */
  color(c: { r: number; g: number; b: number; a?: number } | null): this {
    if (c === null) {
      this.u8(0); // Invalid
      this.u32(0);
      this.u32(0);
      this.u32(0);
      return this;
    }
    const to16 = (v: number) => (Math.max(0, Math.min(255, v)) * 0x101) & 0xffff;
    const b = Buffer.alloc(11);
    b.writeUInt8(1, 0); // Rgb
    b.writeUInt16BE(to16(c.a ?? 255), 1);
    b.writeUInt16BE(to16(c.r), 3);
    b.writeUInt16BE(to16(c.g), 5);
    b.writeUInt16BE(to16(c.b), 7);
    b.writeUInt16BE(0, 9); // pad
    this.parts.push(b);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function header(type: WsjtxType, id: string): Writer {
  return new Writer().u32(WSJTX_MAGIC).u32(WSJTX_SCHEMA).u32(type).utf8(id);
}

// ---------------------------------------------------------------------------
// Decoded message types
// ---------------------------------------------------------------------------

export interface HeartbeatMsg {
  type: WsjtxType.Heartbeat;
  id: string;
  maxSchema: number;
  version: string | null;
  revision: string | null;
}

export interface StatusMsg {
  type: WsjtxType.Status;
  id: string;
  dialFrequency: number;
  mode: string;
  dxCall: string | null;
  report: string | null;
  txMode: string | null;
  txEnabled: boolean;
  transmitting: boolean;
  decoding: boolean;
  rxDF: number;
  txDF: number;
  deCall: string | null;
  deGrid: string | null;
  dxGrid: string | null;
  txWatchdog: boolean;
  subMode: string | null;
  fastMode: boolean;
  specialOpMode: number;
  frequencyTolerance: number;
  trPeriod: number;
  configurationName: string | null;
  txMessage: string | null;
}

export interface DecodeMsg {
  type: WsjtxType.Decode;
  id: string;
  isNew: boolean;
  /** ms since midnight UTC. */
  time: number;
  snr: number;
  deltaTime: number;
  /** Audio offset within the passband, in Hz. DigitalDecode.freqOffset. */
  deltaFrequency: number;
  mode: string;
  message: string;
  lowConfidence: boolean;
  offAir: boolean;
}

export interface QSOLoggedMsg {
  type: WsjtxType.QSOLogged;
  id: string;
  dateTimeOff: Date | null;
  dxCall: string;
  dxGrid: string | null;
  txFrequency: number;
  mode: string;
  reportSent: string | null;
  reportReceived: string | null;
  txPower: string | null;
  comments: string | null;
  name: string | null;
  dateTimeOn: Date | null;
  operatorCall: string | null;
  myCall: string | null;
  myGrid: string | null;
  exchangeSent: string | null;
  exchangeReceived: string | null;
  adifPropagationMode: string | null;
}

export interface ClearMsg {
  type: WsjtxType.Clear;
  id: string;
}

export interface CloseMsg {
  type: WsjtxType.Close;
  id: string;
}

export interface LoggedAdifMsg {
  type: WsjtxType.LoggedADIF;
  id: string;
  adif: string | null;
}

export interface OtherMsg {
  type: Exclude<
    WsjtxType,
    | WsjtxType.Heartbeat
    | WsjtxType.Status
    | WsjtxType.Decode
    | WsjtxType.QSOLogged
    | WsjtxType.Clear
    | WsjtxType.Close
    | WsjtxType.LoggedADIF
  >;
  id: string;
}

export type WsjtxMessage =
  | HeartbeatMsg
  | StatusMsg
  | DecodeMsg
  | QSOLoggedMsg
  | ClearMsg
  | CloseMsg
  | LoggedAdifMsg
  | OtherMsg;

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export interface DecodeFailure {
  ok: false;
  reason: "too-short" | "bad-magic" | "truncated";
  detail: string;
}

export type DecodeOutcome = { ok: true; message: WsjtxMessage } | DecodeFailure;

/**
 * Decode one datagram.
 *
 * Returns a discriminated failure rather than null so a bridge can log *why* a
 * packet was rejected — "bad magic" (something else is on the port) and
 * "truncated" (a real protocol mismatch) call for very different responses.
 */
export function decodePacket(buf: Buffer): DecodeOutcome {
  if (buf.length < 12) {
    return { ok: false, reason: "too-short", detail: `${buf.length} bytes` };
  }

  const r = new Reader(buf);

  let magic: number;
  let type: WsjtxType;
  let id: string;

  try {
    magic = r.u32();
    if (magic !== WSJTX_MAGIC) {
      return {
        ok: false,
        reason: "bad-magic",
        detail: `0x${magic.toString(16)} (expected 0x${WSJTX_MAGIC.toString(16)})`,
      };
    }
    r.u32(); // schema version — accepted as-is
    type = r.u32() as WsjtxType;
    id = r.utf8() ?? "";
  } catch (err) {
    return {
      ok: false,
      reason: "truncated",
      detail: err instanceof Error ? err.message : "header",
    };
  }

  try {
    switch (type) {
      case WsjtxType.Heartbeat:
        return {
          ok: true,
          message: {
            type,
            id,
            maxSchema: r.u32(),
            // Present from schema 2 onward; older senders stop after maxSchema.
            version: r.remaining() > 0 ? r.utf8() : null,
            revision: r.remaining() > 0 ? r.utf8() : null,
          },
        };

      case WsjtxType.Status:
        return {
          ok: true,
          message: {
            type,
            id,
            dialFrequency: Number(r.u64()),
            mode: r.utf8() ?? "",
            dxCall: r.utf8(),
            report: r.utf8(),
            txMode: r.utf8(),
            txEnabled: r.bool(),
            transmitting: r.bool(),
            decoding: r.bool(),
            rxDF: r.u32(),
            txDF: r.u32(),
            deCall: r.utf8(),
            deGrid: r.utf8(),
            dxGrid: r.utf8(),
            txWatchdog: r.bool(),
            subMode: r.utf8(),
            fastMode: r.bool(),
            // Trailing fields arrived in later schema revisions; treat absence as
            // a default rather than a truncated packet.
            specialOpMode: r.remaining() > 0 ? r.u8() : 0,
            frequencyTolerance: r.remaining() >= 4 ? r.u32() : 0,
            trPeriod: r.remaining() >= 4 ? r.u32() : 0,
            configurationName: r.remaining() > 0 ? r.utf8() : null,
            txMessage: r.remaining() > 0 ? r.utf8() : null,
          },
        };

      case WsjtxType.Decode:
        return {
          ok: true,
          message: {
            type,
            id,
            isNew: r.bool(),
            time: r.u32(),
            snr: r.i32(),
            deltaTime: r.double(),
            deltaFrequency: r.u32(),
            mode: r.utf8() ?? "",
            message: r.utf8() ?? "",
            lowConfidence: r.remaining() > 0 ? r.bool() : false,
            offAir: r.remaining() > 0 ? r.bool() : false,
          },
        };

      case WsjtxType.QSOLogged: {
        const off = r.dateTime();
        const dxCall = r.utf8() ?? "";
        const dxGrid = r.utf8();
        const txFrequency = Number(r.u64());
        const mode = r.utf8() ?? "";
        const reportSent = r.utf8();
        const reportReceived = r.utf8();
        const txPower = r.utf8();
        const comments = r.utf8();
        const name = r.utf8();
        const on = r.dateTime();
        const operatorCall = r.utf8();
        const myCall = r.utf8();
        const myGrid = r.utf8();
        const exchangeSent = r.remaining() > 0 ? r.utf8() : null;
        const exchangeReceived = r.remaining() > 0 ? r.utf8() : null;
        const adifPropagationMode = r.remaining() > 0 ? r.utf8() : null;

        return {
          ok: true,
          message: {
            type,
            id,
            dateTimeOff: off.date,
            dxCall,
            dxGrid,
            txFrequency,
            mode,
            reportSent,
            reportReceived,
            txPower,
            comments,
            name,
            dateTimeOn: on.date,
            operatorCall,
            myCall,
            myGrid,
            exchangeSent,
            exchangeReceived,
            adifPropagationMode,
          },
        };
      }

      case WsjtxType.Clear:
        return { ok: true, message: { type, id } };

      case WsjtxType.Close:
        return { ok: true, message: { type, id } };

      case WsjtxType.LoggedADIF:
        return { ok: true, message: { type, id, adif: r.utf8() } };

      default:
        return { ok: true, message: { type, id } as OtherMsg };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "truncated",
      detail: `${WsjtxType[type] ?? type}: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Encode — outbound to the decoder
// ---------------------------------------------------------------------------

export interface ReplyOptions {
  id: string;
  /** ms since midnight UTC, as reported in the Decode being replied to. */
  time: number;
  snr: number;
  deltaTime: number;
  deltaFrequency: number;
  mode: string;
  message: string;
  lowConfidence?: boolean;
  /** Qt keyboard modifier mask; 0 for a plain reply. */
  modifiers?: number;
}

/**
 * Reply — tell the decoder to call the station in a decode.
 *
 * The fields must echo the originating Decode closely: WSJT-X matches the reply
 * against its own decode list, and a mismatched time or delta frequency is
 * silently ignored rather than rejected.
 */
export function encodeReply(o: ReplyOptions): Buffer {
  return header(WsjtxType.Reply, o.id)
    .u32(o.time)
    .i32(o.snr)
    .double(o.deltaTime)
    .u32(o.deltaFrequency)
    .utf8(o.mode)
    .utf8(o.message)
    .bool(o.lowConfidence ?? false)
    .u8(o.modifiers ?? 0)
    .build();
}

export interface HighlightOptions {
  id: string;
  callsign: string;
  background?: { r: number; g: number; b: number } | null;
  foreground?: { r: number; g: number; b: number } | null;
  /** Highlight only the most recent occurrence rather than all of them. */
  lastOnly?: boolean;
}

/** HighlightCallsign — colour a callsign in the decoder's band activity window. */
export function encodeHighlightCallsign(o: HighlightOptions): Buffer {
  return header(WsjtxType.HighlightCallsign, o.id)
    .utf8(o.callsign)
    .color(o.background ?? null)
    .color(o.foreground ?? null)
    .bool(o.lastOnly ?? false)
    .build();
}

/** HaltTx — stop transmitting. `autoOnly` disables auto-Tx but finishes the cycle. */
export function encodeHaltTx(id: string, autoOnly = false): Buffer {
  return header(WsjtxType.HaltTx, id).bool(autoOnly).build();
}

/** Replay — ask the decoder to re-send its decodes for the current period. */
export function encodeReplay(id: string): Buffer {
  return header(WsjtxType.Replay, id).build();
}

/**
 * Clear — wipe a window. 0 = Band Activity, 1 = Rx Frequency, 2 = both.
 */
export function encodeClear(id: string, window = 0): Buffer {
  return header(WsjtxType.Clear, id).u8(window).build();
}

/** FreeText — set (and optionally send) an arbitrary message. */
export function encodeFreeText(id: string, text: string, send = false): Buffer {
  return header(WsjtxType.FreeText, id).utf8(text).bool(send).build();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ms since midnight UTC -> Date, using a reference day for the date part. */
export function decodeTimeToDate(msSinceMidnight: number, reference = new Date()): Date {
  const d = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
    ) + msSinceMidnight,
  );

  // A decode timestamped late in the UTC day, received just after midnight,
  // belongs to the previous day.
  if (d.getTime() - reference.getTime() > 12 * 3600_000) {
    return new Date(d.getTime() - 86_400_000);
  }
  return d;
}

/**
 * Extract the calling station from an FT8/FT4 message line.
 *
 * "CQ W1AW FN42" -> W1AW; "K0ABC W1AW -05" -> W1AW (the sender is the second
 * token in a directed call).
 */
export function callsignFromMessage(message: string): string | null {
  const tokens = message.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const looksLikeCall = (t: string) =>
    /^[A-Z0-9/]{3,}$/.test(t) && /\d/.test(t) && !/^(CQ|DE|QRZ|RR73|RRR|73|TU)$/.test(t);

  if (tokens[0] === "CQ" || tokens[0] === "QRZ") {
    // "CQ <call>", "CQ DX <call>", "CQ FD <call>", "CQ POTA <call>"
    for (let i = 1; i < tokens.length; i++) {
      if (looksLikeCall(tokens[i]!)) return tokens[i]!;
    }
    return null;
  }

  if (tokens.length >= 2 && looksLikeCall(tokens[1]!)) return tokens[1]!;
  if (looksLikeCall(tokens[0]!)) return tokens[0]!;
  return null;
}

/** Frequency (Hz) -> ADIF band name. Re-exported from the band plan. */
export { freqToBand } from "@/lib/ham/bands";

// Icom RS-BA1 transport packets.
//
// Packet layouts learned from kappanhang (https://github.com/nonoo/kappanhang),
// copyright 2020 Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed.
// See docs/icom-protocol.md for the wire format and where each field came from.
//
// This module is deliberately pure: bytes in, bytes out, no sockets. Every packet the
// protocol needs can therefore be tested against known-good captures without a radio
// on the bench, which matters because the radio is the one part of this that cannot be
// stood up in CI.

/** Common header, present on every packet regardless of type. */
export const HEADER_LENGTH = 16;

export const PacketType = {
  idle: 0,
  retransmit: 1,
  openRequest: 3,
  openReply: 4,
  /**
   * Disconnect. FIVE, not six.
   *
   * An earlier version of this file had `close: 6`, which was wrong twice over: 6 is
   * the second half of the OPEN handshake, so the radio's final "session established"
   * packet was being read as a disconnect and tore the session down on arrival. The
   * symptom was a login that timed out with the radio having answered everything it
   * was asked. Confirmed against a real IC-7300.
   */
  disconnect: 5,
  /** Session-open confirm — the fourth and last step of the open handshake. */
  sessionOpen: 6,
  ping: 7,
} as const;

export type PacketTypeName = keyof typeof PacketType;

export interface PacketHeader {
  /** The length the sender *claims*. Not trustworthy — see `parseHeader`. */
  declaredLength: number;
  type: number;
  seq: number;
  senderId: number;
  destinationId: number;
}

/**
 * The session IDs are big-endian. Everything else in the header is little-endian.
 *
 * Not a guess: the control packets write them as `byte(SID>>24), byte(SID>>16),
 * byte(SID>>8), byte(SID)`, most-significant first, while length, type and sequence
 * are all little-endian in the same packet. Mixed byte order inside one 16-byte header
 * is odd enough to look like a transcription error, so it is called out here.
 *
 * Ping alone would not reveal this — it only ever copies the two IDs around as opaque
 * blocks, so a consistently-wrong reader passes every ping test and then builds a login
 * packet the radio silently ignores.
 */
const readId = (b: Buffer, o: number): number => b.readUInt32BE(o);
const writeId = (b: Buffer, v: number, o: number): void => {
  b.writeUInt32BE(v >>> 0, o);
};

/**
 * Read the common header.
 *
 * `declaredLength` is reported but never used for framing. The radio sends pings with
 * the length field zeroed, so a parser that trusts it silently discards every keepalive
 * the radio sends — the session then dies after about three seconds with nothing in any
 * log to explain it. Callers must frame on the datagram's real length. UDP gives us
 * that for free, which is the only reason this is safe at all.
 */
export function parseHeader(buf: Buffer): PacketHeader | null {
  if (buf.length < HEADER_LENGTH) return null;
  return {
    declaredLength: buf.readUInt32LE(0),
    type: buf.readUInt16LE(4),
    seq: buf.readUInt16LE(6),
    senderId: readId(buf, 8),
    destinationId: readId(buf, 12),
  };
}

export interface HeaderFields {
  type: number;
  seq: number;
  senderId: number;
  destinationId: number;
}

/** Allocate a packet of `length` bytes with the header filled in. */
export function buildPacket(length: number, f: HeaderFields): Buffer {
  const b = Buffer.alloc(length);
  b.writeUInt32LE(length, 0);
  b.writeUInt16LE(f.type, 4);
  b.writeUInt16LE(f.seq, 6);
  writeId(b, f.senderId, 8);
  writeId(b, f.destinationId, 12);
  return b;
}

// ---------------------------------------------------------------------------- ping

export const PING_LENGTH = 21;

export interface Ping {
  seq: number;
  senderId: number;
  destinationId: number;
  /** True when the peer wants an answer; false when this *is* the answer. */
  isRequest: boolean;
  /** Four opaque bytes echoed back verbatim in the reply. */
  echo: Buffer;
}

/**
 * Recognise a ping.
 *
 * Matches on the real length and the type field, ignoring the declared length for the
 * reason given on `parseHeader`.
 */
export function isPing(buf: Buffer): boolean {
  return buf.length === PING_LENGTH && buf.readUInt16LE(4) === PacketType.ping;
}

export function parsePing(buf: Buffer): Ping | null {
  if (!isPing(buf)) return null;
  const h = parseHeader(buf);
  if (!h) return null;
  return {
    seq: h.seq,
    senderId: h.senderId,
    destinationId: h.destinationId,
    isRequest: buf[16] === 0x00,
    echo: Buffer.from(buf.subarray(17, 21)),
  };
}

/** Our own keepalive, which the radio is expected to answer. */
export function buildPingRequest(f: {
  seq: number;
  senderId: number;
  destinationId: number;
  echo?: Buffer;
}): Buffer {
  const b = buildPacket(PING_LENGTH, { ...f, type: PacketType.ping });
  b[16] = 0x00;
  if (f.echo) f.echo.copy(b, 17, 0, 4);
  return b;
}

/**
 * Answer a ping from the radio.
 *
 * The sequence and the trailing four bytes are echoed back unchanged, and the two IDs
 * swap. Getting the swap backwards produces a packet the radio ignores, which looks
 * exactly like not replying at all.
 */
export function buildPingReply(req: Ping): Buffer {
  const b = buildPacket(PING_LENGTH, {
    type: PacketType.ping,
    seq: req.seq,
    senderId: req.destinationId,
    destinationId: req.senderId,
  });
  b[16] = 0x01;
  req.echo.copy(b, 17, 0, 4);
  return b;
}

// ---------------------------------------------------------------------------- idle

export const IDLE_LENGTH = 16;

export function isIdle(buf: Buffer): boolean {
  return buf.length === IDLE_LENGTH && buf.readUInt16LE(4) === PacketType.idle;
}

export function buildIdle(f: Omit<HeaderFields, "type">): Buffer {
  return buildPacket(IDLE_LENGTH, { ...f, type: PacketType.idle });
}

// --------------------------------------------------------------------- retransmit

export const RETRANSMIT_ONE_LENGTH = 16;
export const RETRANSMIT_RANGE_LENGTH = 24;

/**
 * A request to replay packets we failed to deliver.
 *
 * Two forms share one type and are told apart by length: 16 bytes names a single
 * sequence number, 24 bytes names a range. The range form is `0x18` in the length
 * field — twenty-four, not eighteen, and reading that hex as decimal is a mistake that
 * produces a parser which silently mis-frames every range request.
 */
export interface RetransmitRequest {
  /** Sequence numbers being asked for. A single-packet request has one entry. */
  seqs: number[];
}

export function parseRetransmit(buf: Buffer): RetransmitRequest | null {
  if (buf.readUInt16LE(4) !== PacketType.retransmit) return null;
  if (buf.length === RETRANSMIT_ONE_LENGTH) {
    return { seqs: [buf.readUInt16LE(6)] };
  }
  if (buf.length === RETRANSMIT_RANGE_LENGTH) {
    // The range is inclusive at both ends, and it can wrap; expanding it here keeps
    // the wrap arithmetic in one place rather than at every call site.
    const start = buf.readUInt16LE(16);
    const end = buf.readUInt16LE(18);
    return { seqs: expandSeqRange(start, end) };
  }
  return null;
}

/**
 * Expand an inclusive sequence range, handling wrap.
 *
 * Sequence numbers are uint16 and they wrap roughly hourly at the ping rate. A naive
 * `for (i = start; i <= end; i++)` yields nothing at all when a range straddles 65535,
 * and "the stream stalls after an hour" is a bug that survives every short test.
 */
export function expandSeqRange(start: number, end: number): number[] {
  const out: number[] = [];
  // Bound the walk: a corrupt range must not spin for 65,536 iterations building an
  // array nobody wants.
  const span = (end - start) & 0xffff;
  if (span > 512) return [];
  for (let i = 0; i <= span; i++) out.push((start + i) & 0xffff);
  return out;
}

/**
 * True when `a` is at or after `b`, accounting for wrap.
 *
 * The standard serial-number comparison: treat the difference as signed within the
 * uint16 space, so 0 is "after" 65535 by one rather than behind it by 65535.
 */
export function seqAtOrAfter(a: number, b: number): boolean {
  return ((a - b) & 0xffff) < 0x8000;
}

// ---------------------------------------------------------------------- open/close

export function buildOpenRequest(f: Omit<HeaderFields, "type">): Buffer {
  return buildPacket(HEADER_LENGTH, { ...f, type: PacketType.openRequest });
}

export function buildDisconnect(f: Omit<HeaderFields, "type">): Buffer {
  return buildPacket(HEADER_LENGTH, { ...f, type: PacketType.disconnect });
}

/**
 * The second half of the open handshake.
 *
 * Sequence is 1, not 0 — the radio checks it. Sent after the open reply arrives and
 * answered by an identical packet from the radio; only then will a login be accepted.
 */
export function buildSessionOpen(f: Omit<HeaderFields, "type">): Buffer {
  return buildPacket(HEADER_LENGTH, { ...f, type: PacketType.sessionOpen, seq: 1 });
}

export function isSessionOpenReply(buf: Buffer): boolean {
  return buf.length === HEADER_LENGTH && buf.readUInt16LE(4) === PacketType.sessionOpen;
}

export function isOpenReply(buf: Buffer): boolean {
  return buf.length === HEADER_LENGTH && buf.readUInt16LE(4) === PacketType.openReply;
}

/** A random local ID, sent in the open request and echoed in every packet after. */
export function randomLocalId(): number {
  // Any 32-bit value works; the radio treats it as opaque.
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

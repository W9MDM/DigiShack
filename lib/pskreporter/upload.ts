// PSKReporter spot upload.
//
// Reporting our decodes is how K9XYZ shows up as a *receiver* on pskreporter.info
// — the counterpart to the queries we already make. The protocol is a binary
// IPFIX-like format over UDP to report.pskreporter.info:4739, the same one WSJT-X
// speaks, and it is documented at
// https://pskreporter.info/pskdev.html
//
// Structure of each datagram:
//
//   header (16 bytes)          magic, length, timestamp, sequence, random id
//   [descriptors, once]        template definitions for the two record types
//   receiver record set        who and where we are (sent periodically)
//   sender record set          one entry per decode
//
// Design notes that matter:
//
//   * Everything is big-endian, and every record set is padded to a 4-byte
//     boundary. Getting the padding wrong makes the server drop the datagram
//     silently — there is no acknowledgement of any kind.
//   * Strings are length-prefixed with a single byte.
//   * The descriptors must be repeated periodically (the server forgets them),
//     which is why they are re-sent every few minutes rather than only once.
//   * PSKReporter asks senders not to report more than once every 5 minutes.
//     That is a courtesy limit on a volunteer service, so it is enforced here
//     rather than left to the caller.

import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

const HOST = "report.pskreporter.info";
const PORT = 4739;

/** Minimum gap between datagrams. PSKReporter's stated limit. */
export const MIN_UPLOAD_INTERVAL_MS = 5 * 60_000;

/** Template ids. Any value above 255 works; these match WSJT-X's choice. */
const TEMPLATE_RX = 0x5000;
const TEMPLATE_TX = 0x5001;

export interface SpotToReport {
  /** Station we decoded. */
  callsign: string;
  /** Their grid, when the message carried one. */
  grid?: string | null;
  /** Absolute frequency in Hz (dial + audio offset). */
  freqHz: number;
  snr: number;
  mode: string;
  /** When we decoded it. */
  at: Date;
}

export interface ReceiverInfo {
  callsign: string;
  grid: string;
  /** Free-form; PSKReporter shows it as the receiving software. */
  software: string;
  /** Antenna description, optional. */
  antenna?: string | null;
}

/** One byte of length then the UTF-8 bytes. */
function pascalString(s: string): Buffer {
  const body = Buffer.from(s.slice(0, 254), "utf8");
  return Buffer.concat([Buffer.from([body.length]), body]);
}

/**
 * Assemble one IPFIX Set: pad the body to a 4-byte boundary and write the
 * header with the length INCLUDING that padding.
 *
 * Both halves matter. Unaligned sets desynchronise everything after them — the
 * receiver reads the next Set ID from the wrong offset — and the Set Length must
 * cover the padding, or a reader that trusts the length lands mid-pad. This is
 * silent either way: PSKReporter never acknowledges anything, so a malformed
 * datagram just vanishes.
 */
function buildSet(setId: number, parts: Buffer[], extraHeader?: Buffer): Buffer {
  const body = Buffer.concat(parts);
  const headerLen = 4 + (extraHeader?.length ?? 0);
  const unpadded = headerLen + body.length;
  const padding = (4 - (unpadded % 4)) % 4;

  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(setId, 0);
  hdr.writeUInt16BE(unpadded + padding, 2);

  return Buffer.concat([
    hdr,
    ...(extraHeader ? [extraHeader] : []),
    body,
    Buffer.alloc(padding),
  ]);
}

/**
 * The two template descriptors, as one record set.
 *
 * Field ids are PSKReporter's own (enterprise number 30351): 0x8000-series for
 * sender fields, 0x8002-series for receiver fields. `0x8000 | n` marks a field
 * as enterprise-specific, which is why every id has the high bit set and is
 * followed by the enterprise number.
 */
function buildDescriptors(): Buffer {
  const ent = Buffer.alloc(4);
  ent.writeUInt32BE(30351, 0);

  // Sender (a station we decoded).
  const txFields: [number, number][] = [
    [0x8001, 0xffff], // sender callsign, variable length
    [0x8005, 4], //     frequency, uint32
    [0x8006, 1], //     SNR, int8
    [0x8002, 0xffff], // sender grid
    [0x8003, 0xffff], // mode
    [0x8004, 0xffff], // info source
    [150, 4], //        observation time (standard IPFIX field)
  ];
  const txBody = Buffer.concat(
    txFields.map(([id, len]) => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(id, 0);
      b.writeUInt16BE(len, 2);
      return Buffer.concat([b, ent]);
    }),
  );
  // Template set: id 2, then (template id, field count) before the field specs.
  const txSpec = Buffer.alloc(4);
  txSpec.writeUInt16BE(TEMPLATE_TX, 0);
  txSpec.writeUInt16BE(txFields.length, 2);
  const txSet = buildSet(2, [txBody], txSpec);

  // Receiver (us).
  const rxFields: [number, number][] = [
    [0x8102, 0xffff], // receiver callsign
    [0x8103, 0xffff], // receiver grid
    [0x8101, 0xffff], // decoding software
    [0x8104, 0xffff], // antenna information
  ];
  const rxBody = Buffer.concat(
    rxFields.map(([id, len]) => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(id, 0);
      b.writeUInt16BE(len, 2);
      return Buffer.concat([b, ent]);
    }),
  );
  // Options template set: id 3, then (template id, field count, scope count).
  const rxSpec = Buffer.alloc(6);
  rxSpec.writeUInt16BE(TEMPLATE_RX, 0);
  rxSpec.writeUInt16BE(rxFields.length, 2);
  rxSpec.writeUInt16BE(1, 4); //                    one scope field
  const rxSet = buildSet(3, [rxBody], rxSpec);

  return Buffer.concat([txSet, rxSet]);
}

const DESCRIPTORS = buildDescriptors();

/** The receiver record set: who we are. */
function buildReceiverSet(rx: ReceiverInfo): Buffer {
  return buildSet(TEMPLATE_RX, [
    pascalString(rx.callsign.toUpperCase()),
    pascalString(rx.grid.toUpperCase()),
    pascalString(rx.software),
    pascalString(rx.antenna ?? ""),
  ]);
}

/** The sender record set: one entry per decode. */
function buildSenderSet(spots: SpotToReport[]): Buffer {
  const records = spots.map((s) => {
    const freq = Buffer.alloc(4);
    freq.writeUInt32BE(Math.round(s.freqHz), 0);
    const snr = Buffer.alloc(1);
    // int8, clamped: FT8 reports run -50..+49 but the field is one byte.
    snr.writeInt8(Math.max(-128, Math.min(127, Math.round(s.snr))), 0);
    const when = Buffer.alloc(4);
    when.writeUInt32BE(Math.floor(s.at.getTime() / 1000), 0);
    return Buffer.concat([
      pascalString(s.callsign.toUpperCase()),
      freq,
      snr,
      pascalString((s.grid ?? "").toUpperCase()),
      pascalString(s.mode.toUpperCase()),
      pascalString("DigiShack"),
      when,
    ]);
  });
  return buildSet(TEMPLATE_TX, records);
}

/**
 * Build one complete datagram.
 *
 * Exported for the assertion suite: the whole point of testing this is to check
 * the byte layout without sending anything to a live volunteer service.
 */
export function buildDatagram(
  rx: ReceiverInfo,
  spots: SpotToReport[],
  opts: { sequence: number; randomId: number; now?: Date; includeDescriptors?: boolean },
): Buffer {
  const sets = Buffer.concat([
    ...(opts.includeDescriptors === false ? [] : [DESCRIPTORS]),
    buildReceiverSet(rx),
    buildSenderSet(spots),
  ]);

  const header = Buffer.alloc(16);
  header.writeUInt32BE(0x000a0000 | (16 + sets.length), 0); // version 10 + length
  header.writeUInt32BE(Math.floor((opts.now ?? new Date()).getTime() / 1000), 4);
  header.writeUInt32BE(opts.sequence, 8);
  header.writeUInt32BE(opts.randomId, 12);

  return Buffer.concat([header, sets]);
}

/**
 * Queues decodes and uploads them on PSKReporter's schedule.
 *
 * Deliberately fire-and-forget: the protocol has no acknowledgement, so there is
 * nothing to await and nothing to retry. A failed send is logged and the spots
 * are dropped — they are a courtesy to a public service, not log data.
 */
export class PskReporterUploader {
  private readonly rx: ReceiverInfo;
  private readonly queue = new Map<string, SpotToReport>();
  private sequence = 0;
  private readonly randomId = randomBytes(4).readUInt32BE(0);
  private lastSentAt = 0;
  private lastDescriptorsAt = 0;

  constructor(receiver: ReceiverInfo) {
    this.rx = receiver;
  }

  get queued(): number {
    return this.queue.size;
  }

  /**
   * Add a decode. Deduplicated per callsign+band: reporting the same station six
   * times in five minutes tells the service nothing extra, and the strongest
   * report is the useful one.
   */
  add(spot: SpotToReport): void {
    const key = `${spot.callsign.toUpperCase()}|${Math.round(spot.freqHz / 1_000_000)}`;
    const existing = this.queue.get(key);
    if (!existing || spot.snr > existing.snr) this.queue.set(key, spot);
  }

  /** True when the courtesy interval has elapsed and there is something to send. */
  dueToSend(now = Date.now()): boolean {
    return this.queue.size > 0 && now - this.lastSentAt >= MIN_UPLOAD_INTERVAL_MS;
  }

  /**
   * Send the queue if it is due. Returns how many spots went out (0 if not due).
   *
   * The first datagram of a session always carries the descriptors, and they are
   * repeated every 5 minutes because the server forgets them.
   */
  async flush(now = Date.now()): Promise<number> {
    if (!this.dueToSend(now)) return 0;

    const spots = [...this.queue.values()];
    this.queue.clear();
    this.lastSentAt = now;

    const includeDescriptors = now - this.lastDescriptorsAt >= 5 * 60_000;
    if (includeDescriptors) this.lastDescriptorsAt = now;

    // A datagram must fit in one UDP packet; chunk to stay well under any MTU.
    const CHUNK = 40;
    let sent = 0;
    const socket = dgram.createSocket("udp4");
    try {
      for (let i = 0; i < spots.length; i += CHUNK) {
        const chunk = spots.slice(i, i + CHUNK);
        const datagram = buildDatagram(this.rx, chunk, {
          sequence: this.sequence++,
          randomId: this.randomId,
          now: new Date(now),
          includeDescriptors: includeDescriptors && i === 0,
        });
        await new Promise<void>((resolve, reject) => {
          socket.send(datagram, PORT, HOST, (err) => (err ? reject(err) : resolve()));
        });
        sent += chunk.length;
      }
    } finally {
      socket.close();
    }
    return sent;
  }
}

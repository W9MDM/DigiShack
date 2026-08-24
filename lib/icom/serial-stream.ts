// The serial stream: CI-V over UDP port 50002.
//
// Once open this is a byte pipe carrying exactly what the USB CAT port would carry, so
// everything in civ.ts applies unchanged. The only additions are a 21-byte wrapper, a
// third sequence counter, and an explicit open/close handshake on top of the transport
// one.
//
// Protocol from kappanhang (https://github.com/nonoo/kappanhang), copyright 2020
// Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed.

import {
  type CivFrame,
  isEcho,
  parseFrames,
} from "@/lib/icom/civ";
import { buildPacket, type parseHeader } from "@/lib/icom/packets";
import { IcomStreamBase, type StreamBaseOptions } from "@/lib/icom/stream-base";

/** Payload starts here; the wrapper is 21 bytes. */
const SERIAL_HEADER = 21;

/** Byte 16 says what a serial packet is. */
const Marker = {
  /** Open / close the serial channel. */
  control: 0xc0,
  /** Carries CI-V bytes. */
  data: 0xc1,
} as const;

export type SerialStreamEvents = {
  /** A complete CI-V frame from the radio, echoes already removed. */
  frame: [CivFrame];
  /** Raw bytes, before framing. Useful for a capture, ignored otherwise. */
  bytes: [Buffer];
  opened: [];
  error: [Error];
  closed: [{ reason: string }];
}

export interface SerialStreamOptions extends Omit<StreamBaseOptions, "name"> {
  /** Our CI-V address, used to recognise our own echoes. */
  controllerAddress?: number;
}

export class IcomSerialStream extends IcomStreamBase<SerialStreamEvents> {
  /** The serial channel's own counter, distinct from the transport sequence. */
  private serialSeq = 0;
  /** Bytes left over from a datagram that ended mid-frame. */
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly controller: number;

  constructor(opts: SerialStreamOptions) {
    super({ ...opts, name: "serial" });
    this.controller = opts.controllerAddress ?? 0xe0;
  }

  protected onOpened(): void {
    // The transport is up; now open the serial channel itself.
    this.sendTracked(this.controlPacket(0x05));
    this.emit("opened");
  }

  protected onFailure(err: Error): void {
    this.emit("error", err);
  }

  protected onClosed(reason: string): void {
    this.emit("closed", { reason });
  }

  protected onPayload(msg: Buffer, _header: ReturnType<typeof parseHeader>): void {
    if (msg.length <= SERIAL_HEADER) return;
    if (msg[16] !== Marker.data) return;

    const declared = msg[17] ?? 0;
    // Trust the datagram, not the declared length — same rule as everywhere else here,
    // and a truncated packet would otherwise read past the end of the payload.
    const available = msg.length - SERIAL_HEADER;
    const payload = msg.subarray(SERIAL_HEADER, SERIAL_HEADER + Math.min(declared, available));
    if (payload.length === 0) return;

    this.emit("bytes", Buffer.from(payload));

    // A datagram can hold several frames, or half of one. Carry the remainder.
    const { frames, rest } = parseFrames(Buffer.concat([this.pending, payload]));
    this.pending = rest.length > 512 ? Buffer.alloc(0) : rest;

    for (const frame of frames) {
      // CI-V is a bus and the radio echoes what it hears. An echo taken for a reply
      // means every read returns what was just written.
      if (isEcho(frame, this.controller)) continue;
      this.emit("frame", frame);
    }
  }

  /** Send a CI-V frame. Split automatically if it exceeds what one packet can carry. */
  write(civ: Buffer): void {
    if (this.phase !== "open") throw new Error("Serial stream is not open");
    // The length field is a single byte, so 255 is the hard ceiling. CI-V frames are
    // far shorter than that, but a caller passing a concatenated batch should not
    // silently lose the tail.
    for (let off = 0; off < civ.length; off += 255) {
      const chunk = civ.subarray(off, off + 255);
      this.sendTracked(this.dataPacket(chunk));
    }
  }

  private dataPacket(payload: Buffer): Buffer {
    const p = buildPacket(SERIAL_HEADER + payload.length, {
      type: 0,
      seq: 0,
      senderId: this.localSid,
      destinationId: this.remoteSid,
    });
    p[16] = Marker.data;
    p[17] = payload.length;
    p[18] = 0x00;
    // Big-endian, unlike the transport sequence two fields earlier in the same packet.
    p.writeUInt16BE(this.serialSeq & 0xffff, 19);
    this.serialSeq = (this.serialSeq + 1) & 0xffff;
    payload.copy(p, SERIAL_HEADER);
    return p;
  }

  private controlPacket(magic: number): Buffer {
    const p = buildPacket(22, {
      type: 0,
      seq: 0,
      senderId: this.localSid,
      destinationId: this.remoteSid,
    });
    p[16] = Marker.control;
    p[17] = 0x01;
    p[18] = 0x00;
    p.writeUInt16BE(this.serialSeq & 0xffff, 19);
    this.serialSeq = (this.serialSeq + 1) & 0xffff;
    p[21] = magic;
    return p;
  }

  override async close(reason = "closed by us"): Promise<void> {
    if (this.phase === "open") {
      // Close the serial channel before the transport, or the radio keeps it allocated.
      try {
        this.sendTracked(this.controlPacket(0x00));
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        // Best effort.
      }
    }
    await super.close(reason);
  }
}

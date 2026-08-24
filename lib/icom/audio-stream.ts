// The audio stream: 48 kHz signed 16-bit little-endian mono, UDP port 50003.
//
// Protocol from kappanhang (https://github.com/nonoo/kappanhang), copyright 2020
// Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed.
//
// Receive audio is converted to float32 and emitted; the decode pipeline above does not
// know or care which radio produced it. Transmit audio goes out in 20 ms chunks, split
// across two packets to stay inside a normal MTU.

import { buildPacket } from "@/lib/icom/packets";
import { IcomStreamBase, type StreamBaseOptions } from "@/lib/icom/stream-base";
import { s16leToFloat32 } from "@/lib/radio/types";

/** The wrapper on an audio data packet. */
const AUDIO_HEADER = 24;

/**
 * How often to send silence when nothing else is going out.
 *
 * 200 ms is well inside whatever the radio's patience is — the stall took a minute or
 * more to appear — and ten times a second is a trickle against the audio coming back.
 */
const SILENCE_INTERVAL_MS = 200;

export const ICOM_AUDIO_RATE = 48_000;

/**
 * One transmit chunk: 20 ms at 48 kHz mono 16-bit.
 *
 * 960 samples, 1920 bytes. Sent as 1364 + 556 because a single 1944-byte datagram
 * exceeds the usual 1500-byte MTU and would fragment — and a fragmented UDP datagram
 * that loses one fragment loses the whole thing, which on an audio stream is a click
 * for no reason.
 */
export const TX_CHUNK_BYTES = 1920;
const PART1_BYTES = 1364;

export type AudioStreamEvents = {
  /** Receive audio, converted to float32 mono at 48 kHz. */
  audio: [{ samples: Float32Array; at: number }];
  opened: [];
  error: [Error];
  closed: [{ reason: string }];
}

export type AudioStreamOptions = Omit<StreamBaseOptions, "name"> & {
  /** Send silence while idle. Default true — see IcomAudioStream.keepalive. */
  keepalive?: boolean;
};

export class IcomAudioStream extends IcomStreamBase<AudioStreamEvents> {
  /** The audio channel's own counter. Big-endian on the wire. */
  private audioSeq = 0;
  private lastRxSeq: number | null = null;
  private droppedPackets = 0;
  private receivedPackets = 0;
  private lastWriteAt = 0;
  private silenceSent = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  private readonly keepaliveWanted: boolean;

  constructor(opts: AudioStreamOptions) {
    super({ ...opts, name: "audio" });
    this.keepaliveWanted = opts.keepalive !== false;
  }

  /**
   * How many audio packets have arrived.
   *
   * The difference between a stream that is OPEN and a stream that is CARRYING. After a
   * restart the radio can leave the previous session's audio bound on its side, and the
   * new stream opens perfectly and then receives nothing at all — which reads from every
   * layer above as a dead band.
   */
  get received(): number {
    return this.receivedPackets;
  }

  /** How many receive packets went missing. Surfaced so a bad network is visible
   * rather than presenting as a receiver that decodes badly. */
  get dropped(): number {
    return this.droppedPackets;
  }

  protected onOpened(): void {
    if (this.keepalive) this.startSilenceKeepalive();
    else console.log("[icom] audio silence keepalive is OFF (icom.audioKeepalive=false)");
    this.emit("opened");
  }

  /**
   * Whether to send silence while idle. On by default; see startSilenceKeepalive.
   *
   * A switch exists because the keepalive's own justification is in doubt. It was added to
   * stop the radio cutting a receive-only client's audio, and the audio still stops with it
   * running — measured, not assumed: 95 keepalives went out during the 20 seconds before a
   * stall was declared. Worse, the radio answers at about the rate we send: 219 packets in
   * that window against our 10 datagrams a second, which is the shape of a radio reacting
   * to us rather than one ignoring us.
   *
   * So it may be the cause of the fault it was written to fix. That is a question for a
   * measurement, and a measurement needs a way to turn it off.
   */
  private get keepalive(): boolean {
    return this.keepaliveWanted;
  }

  /**
   * Send silence when we have nothing else to send.
   *
   * THE AUDIO STREAM IS BIDIRECTIONAL, and the radio appears to expect it to be used.
   * Left purely as a receiver — which is what a decode-only session is — the radio stops
   * sending audio after a minute or two while continuing to ping the same socket. That
   * asymmetry is what the ping counters proved: 219 pings arrived AFTER the audio
   * stopped, so the session was alive, the route was fine, and the radio had simply
   * stopped streaming.
   *
   * Silence costs 1920 bytes every 200 ms — a trickle next to the 48 kHz coming back —
   * and it carries no risk of transmitting: audio without PTT goes nowhere, which is the
   * same reason `MOD Input -> DATA MOD` being wrong produces a keyed radio sending
   * nothing.
   *
   * Suppressed while something real is being written, so a transmission is never
   * interleaved with silence.
   */
  private startSilenceKeepalive(): void {
    if (this.keepaliveTimer) return;
    const silence = Buffer.alloc(TX_CHUNK_BYTES);
    this.keepaliveTimer = setInterval(() => {
      if (this.phase !== "open") return;
      if (Date.now() - this.lastWriteAt < SILENCE_INTERVAL_MS) return;
      try {
        this.lastWriteAt = Date.now();
        this.sendTracked(this.dataPacket(silence.subarray(0, PART1_BYTES)));
        this.sendTracked(this.dataPacket(silence.subarray(PART1_BYTES)));
        this.silenceSent++;
      } catch {
        // A stream on its way down. The close path reports it; this must not throw from
        // a timer.
      }
    }, SILENCE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  /** How many silence keepalives have gone out. Exposed so a test can prove it runs. */
  get keepalivesSent(): number {
    return this.silenceSent;
  }

  protected onFailure(err: Error): void {
    this.emit("error", err);
  }

  protected onClosed(reason: string): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.emit("closed", { reason });
  }

  protected onPayload(msg: Buffer): void {
    if (msg.length <= AUDIO_HEADER) return;

    const declared = msg.readUInt16BE(22);
    const available = msg.length - AUDIO_HEADER;
    const pcm = msg.subarray(AUDIO_HEADER, AUDIO_HEADER + Math.min(declared, available));
    if (pcm.length < 2) return;

    const seq = msg.readUInt16BE(18);
    if (this.lastRxSeq !== null) {
      const gap = (seq - this.lastRxSeq - 1) & 0xffff;
      // A large "gap" is a wrap or a reorder, not 60000 lost packets.
      if (gap > 0 && gap < 256) this.droppedPackets += gap;
    }
    this.lastRxSeq = seq;

    // Deliberately no retransmit request for audio. By the time a replayed packet
    // arrived the moment it belonged to has passed, and asking turns a click into a
    // stall.
    this.receivedPackets++;
    this.emit("audio", { samples: s16leToFloat32(pcm, 1), at: Date.now() });
  }

  /**
   * Send transmit audio.
   *
   * Expects signed 16-bit little-endian mono at 48 kHz. Anything not a multiple of the
   * chunk size is padded with silence rather than truncated — a short final chunk would
   * shorten the transmission, and in FT8 that shifts the tail of the last symbol.
   */
  writeAudio(pcm: Buffer): void {
    if (this.phase !== "open") throw new Error("Audio stream is not open");
    this.lastWriteAt = Date.now();

    for (let off = 0; off < pcm.length; off += TX_CHUNK_BYTES) {
      let chunk = pcm.subarray(off, off + TX_CHUNK_BYTES);
      if (chunk.length < TX_CHUNK_BYTES) {
        const padded = Buffer.alloc(TX_CHUNK_BYTES);
        chunk.copy(padded);
        chunk = padded;
      }
      this.sendTracked(this.dataPacket(chunk.subarray(0, PART1_BYTES)));
      this.sendTracked(this.dataPacket(chunk.subarray(PART1_BYTES)));
    }
  }

  private dataPacket(pcm: Buffer): Buffer {
    const p = buildPacket(AUDIO_HEADER + pcm.length, {
      type: 0,
      seq: 0,
      senderId: this.localSid,
      destinationId: this.remoteSid,
    });
    p[16] = 0x80;
    p[17] = 0x00;
    // Both of these are big-endian, in a packet whose length and type are not.
    p.writeUInt16BE(this.audioSeq & 0xffff, 18);
    p.writeUInt16BE(pcm.length, 22);
    this.audioSeq = (this.audioSeq + 1) & 0xffff;
    pcm.copy(p, AUDIO_HEADER);
    return p;
  }
}

/**
 * Float32 mono to the signed 16-bit little-endian the radio wants.
 *
 * Clamped, not wrapped. A sample above 1.0 written without clamping wraps to full-scale
 * negative, and a waveform with a handful of those sounds like it is being torn — the
 * kind of distortion that gets blamed on the radio.
 */
export function float32ToS16le(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

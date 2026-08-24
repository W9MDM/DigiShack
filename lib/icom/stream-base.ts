// What all three Icom streams have in common.
//
// Control, serial and audio each run their own UDP conversation on their own port, and
// each one opens the same way: a type-3 request, a type-4 reply carrying the radio's
// session id, then a ping loop that must be answered or the radio drops us in about
// three seconds. Only what happens *after* that differs.
//
// This was extracted from the control stream once serial and audio needed it. The
// alternative was three copies of the ping loop and the retransmit buffer, which is
// three places for the sequence-wrap bug to live instead of one.
//
// Protocol from kappanhang (https://github.com/nonoo/kappanhang), copyright 2020
// Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed.

import dgram from "node:dgram";
import { EventEmitter } from "node:events";

import { LinkLatency } from "@/lib/radio/link-latency";

import {
  buildDisconnect,
  buildIdle,
  buildOpenRequest,
  buildSessionOpen,
  buildPacket,
  buildPingReply,
  buildPingRequest,
  HEADER_LENGTH,
  isPing,
  PacketType,
  parseHeader,
  parsePing,
  parseRetransmit,
  randomLocalId,
} from "@/lib/icom/packets";

/** Slower than the radio's 100 ms. What matters is answering its pings, not matching
 * their rate, and a quieter socket is easier to read in a capture. */
export const PING_INTERVAL_MS = 1_000;
export const IDLE_TIMEOUT_MS = 6_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Deep enough to cover a burst of loss. A radio asking for something older than this
 * has already lost the session, and a bigger buffer would not rescue it. */
const TX_BUFFER_DEPTH = 128;

export interface StreamBaseOptions {
  host: string;
  port: number;
  bindAddress?: string;
  /** Named in log messages, so a failure says which of the three streams it was. */
  name: string;
}

export type StreamPhase = "idle" | "opening" | "open" | "closed";

/** Send-sequence tracking plus the replay buffer the radio's retransmit requests need. */
class TxBuffer {
  /**
   * Starts at ONE, not zero.
   *
   * Measured against a real IC-7300, and it is absolute: a login sent with transport
   * sequence 0 is discarded in silence — no reply, no rejection, nothing — while the
   * identical packet with sequence 1 is answered in 30 ms. Nothing in the packet
   * differs but that one byte.
   *
   * This cost an afternoon. The transport handshake completed, the radio sent idle
   * keepalives every 100 ms, and every byte of the login matched the reference
   * implementation, so the wire looked perfect while the radio ignored us.
   */
  private seq = 1;
  private readonly sent = new Map<number, Buffer>();

  track(packet: Buffer): Buffer {
    const s = this.seq;
    packet.writeUInt16LE(s, 6);
    this.sent.set(s, Buffer.from(packet));
    this.seq = (this.seq + 1) & 0xffff;
    if (this.sent.size > TX_BUFFER_DEPTH) {
      const oldest = this.sent.keys().next();
      if (!oldest.done) this.sent.delete(oldest.value);
    }
    return packet;
  }

  get next(): number {
    return this.seq;
  }

  replay(seq: number): Buffer | null {
    return this.sent.get(seq) ?? null;
  }
}

/**
 * The transport half of an Icom stream.
 *
 * Subclasses supply their own event map and override the three hooks. The base never
 * emits anything itself — event names differ per stream and typing that through a
 * generic base is more trouble than calling a hook.
 */
export abstract class IcomStreamBase<
  E extends Record<string, unknown[]>,
> extends EventEmitter<E> {
  protected socket: dgram.Socket | null = null;
  protected phase: StreamPhase = "idle";
  protected readonly localSid = randomLocalId();
  protected remoteSid = 0;
  protected readonly tx = new TxBuffer();

  private pingSeq = 0;
  private datagrams = 0;
  private pingsIn = 0;
  /**
   * Round trips measured off this stream's own keepalive pings.
   *
   * The radio answers our ping requests with a reply carrying the same sequence
   * number, so the loop that already keeps the session alive measures the path for
   * free — no extra traffic. Over a VPN that path delays transmit keying and ages
   * every audio sample; see lib/radio/link-latency.ts for what is done with this.
   */
  readonly link = new LinkLatency();
  /** When each of our ping requests left, by sequence number. */
  private readonly pingSentAt = new Map<number, number>();

  /**
   * Traffic seen on this socket, for telling a silent radio from a silent network.
   *
   * `datagrams` counts everything that arrived; `pings` counts the radio's keepalives.
   * A stream where pings climb and payloads do not is a radio that has stopped sending
   * data while still holding the session open.
   */
  get traffic(): { datagrams: number; pings: number } {
    return { datagrams: this.datagrams, pings: this.pingsIn };
  }
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;

  constructor(protected readonly base: StreamBaseOptions) {
    super();
  }

  get state(): StreamPhase {
    return this.phase;
  }

  get localPort(): number | null {
    try {
      return this.socket?.address().port ?? null;
    } catch {
      return null;
    }
  }

  get sessionIds(): { localSid: number; remoteSid: number } {
    return { localSid: this.localSid, remoteSid: this.remoteSid };
  }

  /** Called once the radio has answered the open request. */
  protected abstract onOpened(): void;

  /** Anything that is not ping, retransmit, open or close. */
  protected abstract onPayload(msg: Buffer, header: ReturnType<typeof parseHeader>): void;

  /** Report a failure in whatever way the subclass's event map allows. */
  protected abstract onFailure(err: Error): void;

  /** Report a clean close. */
  protected abstract onClosed(reason: string): void;

  /**
   * Bind, send the open request, and resolve once the radio has answered.
   *
   * Resolving on the bind instead would be a lie with teeth: the caller carries on and
   * writes to a stream still in `opening`, which throws. That is not hypothetical — it
   * is what the first version did, and the rig test caught it on the very first poll.
   * Against a real radio, with real latency, the window is wider than on loopback.
   */
  async open(): Promise<void> {
    if (this.phase !== "idle") throw new Error(`${this.base.name} stream already ${this.phase}`);
    this.phase = "opening";

    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg) => this.handle(msg));
    socket.on("error", (err) => this.fail(err));

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind({ address: this.base.bindAddress ?? "0.0.0.0", port: 0 }, () => {
        socket.off("error", reject);
        resolve();
      });
    });

    const opened = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });

    this.armIdleTimeout();
    this.armHandshakeTimeout("open");
    // Twice, as the reference does. These two packets are the ones the whole session
    // depends on and there is no retransmit machinery yet at this point, so a single
    // dropped datagram would hang the connect until the handshake timeout.
    const open = buildOpenRequest({ seq: 0, senderId: this.localSid, destinationId: 0 });
    this.send(open);
    this.send(open);
    await opened;
  }

  /** Settled by the open reply, or by any failure before it arrives. */
  private openResolve: (() => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;

  private settleOpen(err?: Error): void {
    const resolve = this.openResolve;
    const reject = this.openReject;
    this.openResolve = null;
    this.openReject = null;
    if (err) reject?.(err);
    else resolve?.();
  }

  protected send(packet: Buffer): void {
    const socket = this.socket;
    if (!socket) return;
    socket.send(packet, this.base.port, this.base.host, (err) => {
      if (err) this.fail(err);
    });
  }

  /** Send with a sequence number, remembering it for replay. */
  protected sendTracked(packet: Buffer): void {
    this.send(this.tx.track(packet));
  }

  private handle(msg: Buffer): void {
    if (this.phase === "closed") return;
    this.armIdleTimeout();

    // Every datagram, counted by kind.
    //
    // This exists to answer one question that nothing else can: when the Icom's audio
    // stops arriving, has the RADIO stopped sending, or have we stopped reading? Both
    // look identical from above — windows on a timer, a frozen waterfall, no decodes.
    //
    // The audio socket also carries the radio's pings. So if pings keep arriving on that
    // socket while audio data does not, the radio is still talking to us on that port and
    // has deliberately stopped the audio; if EVERYTHING stops, the session or the route is
    // gone. One counter separates a protocol bug from a network one.
    this.datagrams++;

    // Frame on the datagram length. The radio zeroes the declared length on pings, and
    // a client that trusts the header drops all of them and dies silently.
    if (isPing(msg)) {
      this.pingsIn++;
      const ping = parsePing(msg);
      if (ping?.isRequest) this.send(buildPingReply(ping));
      else if (ping) {
        // The answer to one of ours: the reply echoes our sequence number, so the
        // send time looked up by it is a round trip. An unknown sequence (a stale
        // reply after a reconnect) is ignored rather than guessed at.
        const sentAt = this.pingSentAt.get(ping.seq);
        if (sentAt !== undefined) {
          this.pingSentAt.delete(ping.seq);
          this.link.sample(Date.now() - sentAt);
        }
      }
      return;
    }
    if (msg.length < HEADER_LENGTH) return;

    const header = parseHeader(msg);
    if (!header) return;

    if (header.type === PacketType.retransmit) {
      const req = parseRetransmit(msg);
      for (const seq of req?.seqs ?? []) {
        const replay = this.tx.replay(seq);
        if (replay) this.send(replay);
      }
      return;
    }
    // The open handshake is FOUR steps, not two: we send type 3, the radio answers
    // type 4, we send type 6, the radio answers type 6. Only then will it accept a
    // login. Stopping at the type-4 reply produced a session the radio answered
    // nothing further on, and the symptom was a login timeout with no error — it had
    // replied to everything it was actually asked.
    if (header.type === PacketType.openReply && msg.length === HEADER_LENGTH) {
      if (this.phase !== "opening") return;
      this.remoteSid = header.senderId;
      const confirm = buildSessionOpen({
        seq: 1,
        senderId: this.localSid,
        destinationId: this.remoteSid,
      });
      this.send(confirm);
      this.send(confirm);
      this.armHandshakeTimeout("session confirm");
      return;
    }
    if (header.type === PacketType.sessionOpen && msg.length === HEADER_LENGTH) {
      if (this.phase !== "opening") return;
      this.phase = "open";
      this.clearHandshakeTimeout();
      this.startPingLoop();
      this.settleOpen();
      this.onOpened();
      return;
    }
    if (header.type === PacketType.disconnect) {
      this.teardown("the radio closed the stream");
      return;
    }

    this.onPayload(msg, header);
  }

  private startPingLoop(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this.pingSentAt.set(this.pingSeq, Date.now());
      // A reply that never comes must not pin its send time forever. The interval is
      // slower than the radio's own 100 ms, so a handful of entries is a dead radio,
      // not a burst.
      if (this.pingSentAt.size > 8) {
        const oldest = this.pingSentAt.keys().next().value;
        if (oldest !== undefined) this.pingSentAt.delete(oldest);
      }
      this.send(
        buildPingRequest({
          seq: this.pingSeq,
          senderId: this.localSid,
          destinationId: this.remoteSid,
        }),
      );
      this.pingSeq = (this.pingSeq + 1) & 0xffff;
      this.sendTracked(
        buildIdle({ seq: 0, senderId: this.localSid, destinationId: this.remoteSid }),
      );
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  protected armIdleTimeout(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(new Error(`No traffic on the ${this.base.name} stream — session lost`));
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  protected armHandshakeTimeout(step: string): void {
    this.clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(() => {
      this.fail(new Error(`Timed out during ${step} on the ${this.base.name} stream`));
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();
  }

  protected clearHandshakeTimeout(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  protected fail(err: Error): void {
    if (this.phase === "closed") return;
    // Reject a pending open() first, or an awaiting caller hangs until its own timeout
    // rather than being told what went wrong.
    this.settleOpen(err);
    this.onFailure(err);
    this.teardown(err.message);
  }

  /** Send the disconnect packet, then drop the socket. */
  protected sendClosePacket(): void {
    if (!this.remoteSid) return;
    this.send(
      buildDisconnect({
        seq: 0,
        senderId: this.localSid,
        destinationId: this.remoteSid,
      }),
    );
  }

  protected teardown(reason: string): void {
    if (this.phase === "closed") return;
    this.settleOpen(new Error(`${this.base.name} stream closed before opening: ${reason}`));
    this.phase = "closed";
    for (const t of [this.pingTimer, this.idleTimer, this.handshakeTimer]) {
      if (t) clearTimeout(t);
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.idleTimer = null;
    this.handshakeTimer = null;
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = null;
    this.onClosed(reason);
  }

  async close(reason = "closed by us"): Promise<void> {
    if (this.phase === "open") {
      this.sendClosePacket();
      await new Promise((r) => setTimeout(r, 20));
    }
    this.teardown(reason);
  }
}

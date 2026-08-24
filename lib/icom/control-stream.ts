// The Icom control stream: log in, hold the session up, tear it down cleanly.
//
// The transport half — open handshake, ping loop, retransmit buffer — lives in
// stream-base.ts, shared with the serial and audio streams. What is here is only what
// is specific to control: the login exchange, the auth token lifecycle, and asking the
// radio to open the other two streams.
//
// Protocol from kappanhang (https://github.com/nonoo/kappanhang), copyright 2020
// Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed. Packet layouts are in
// packets.ts and control-packets.ts.

import {
  AuthMagic,
  buildAuth,
  buildLogin,
  buildSerialAudioRequest,
  ControlLength,
  IcomPorts,
  parseAuthReply,
  parseCapabilities,
  parseLoginReply,
  parseStreamOpenReply,
  type SessionIds,
} from "@/lib/icom/control-packets";
import type { parseHeader } from "@/lib/icom/packets";
import { IcomStreamBase, type StreamBaseOptions } from "@/lib/icom/stream-base";

/** Token renewal. The radio expects the confirm packet to keep arriving. */
const REAUTH_INTERVAL_MS = 60_000;

export interface ControlStreamOptions extends Omit<StreamBaseOptions, "name" | "port"> {
  port?: number;
  username: string;
  password: string;
  /** Ports to ask the radio to open for the other two streams. */
  serialPort?: number;
  audioPort?: number;
}

export interface StreamsReady {
  ids: SessionIds;
  authId: Buffer;
  /** What the radio calls itself. Used verbatim in the stream request. */
  radioName: string;
  audioName: string;
  serialPort: number;
  audioPort: number;
}

export type ControlStreamEvents = {
  /** Login complete and the radio has opened the serial and audio streams. */
  ready: [StreamsReady];
  /** The radio identified itself; fires before `ready`. */
  identified: [{ radioName: string; audioName: string }];
  error: [Error];
  closed: [{ reason: string }];
}

/** Where we are in the login sequence, on top of the transport's own phase. */
type AuthPhase = "none" | "logging-in" | "authenticating" | "ready";

export class IcomControlStream extends IcomStreamBase<ControlStreamEvents> {
  private authPhase: AuthPhase = "none";
  /** The control block's own counter, separate from the transport sequence. */
  private innerSeq = 0;

  private authId: Buffer | null = null;
  private a8ReplyId: Buffer | null = null;
  private radioName = "";
  private audioName = "";
  private authStartId = Buffer.alloc(2);
  private authOk = false;
  private requestedStreams = false;
  private reauthTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ControlStreamOptions) {
    super({
      host: opts.host,
      port: opts.port ?? IcomPorts.control,
      bindAddress: opts.bindAddress,
      name: "control",
    });
  }

  get ids(): SessionIds {
    return { localSid: this.localSid, remoteSid: this.remoteSid };
  }

  /** Combined view: the transport phase, or the login phase once transport is up. */
  get status(): StreamPhaseOrAuth {
    if (this.phase === "closed") return "closed";
    if (this.phase !== "open") return this.phase;
    return this.authPhase === "none" ? "open" : this.authPhase;
  }

  async connect(): Promise<void> {
    await this.open();
  }

  protected onOpened(): void {
    this.authPhase = "logging-in";
    this.authStartId = Buffer.from([
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
    ]);
    this.armHandshakeTimeout("login");
    this.sendTracked(
      buildLogin({
        ids: this.ids,
        username: this.opts.username,
        password: this.opts.password,
        innerSeq: this.innerSeq++,
        authStartId: this.authStartId,
      }),
    );
  }

  protected onFailure(err: Error): void {
    this.emit("error", err);
  }

  protected onClosed(reason: string): void {
    if (this.reauthTimer) clearInterval(this.reauthTimer);
    this.reauthTimer = null;
    this.authPhase = "none";
    this.emit("closed", { reason });
  }

  protected onPayload(msg: Buffer, _header: ReturnType<typeof parseHeader>): void {
    // Control payloads are discriminated by length, not by type.
    switch (msg.length) {
      case ControlLength.loginReply:
        this.onLoginReply(msg);
        break;
      case ControlLength.capabilities:
        this.onCapabilities(msg);
        break;
      case ControlLength.auth:
        this.onAuthReply(msg);
        break;
      case ControlLength.streamOpen:
        this.onStreamOpenReply(msg);
        break;
      case ControlLength.serialAudioRequest:
        this.onSerialAudioReply(msg);
        break;
      default:
        break;
    }
  }

  private onLoginReply(msg: Buffer): void {
    const reply = parseLoginReply(msg);
    if (!reply) return;

    // The radio's explicit "those credentials are wrong". Worth separating from a
    // timeout: one sends the operator to the password field, the other to the network.
    if (reply.invalidCredentials) {
      this.fail(new Error("The radio rejected the network user name or password"));
      return;
    }

    // The radio echoes our two random bytes at the head of the auth id. A reply that
    // does not is answering someone else's login — two clients on one network is an
    // ordinary configuration, and acting on it would authenticate us into the wrong
    // session.
    if (!reply.authId.subarray(0, 2).equals(this.authStartId)) {
      this.emit("error", new Error("login reply did not echo our auth start id — ignored"));
      return;
    }

    this.authId = reply.authId;
    this.authPhase = "authenticating";

    this.armHandshakeTimeout("authentication");
    for (const magic of [AuthMagic.acknowledge, AuthMagic.confirm] as const) {
      this.sendTracked(
        buildAuth({ ids: this.ids, authId: reply.authId, magic, innerSeq: this.innerSeq++ }),
      );
    }
  }

  /**
   * The radio describing itself. Arrives unprompted, and not necessarily before the
   * auth exchange finishes — so both this and `onAuthReply` try to move things on, and
   * whichever completes the pair wins.
   */
  private onCapabilities(msg: Buffer): void {
    const caps = parseCapabilities(msg);
    if (!caps) return;
    this.a8ReplyId = caps.a8ReplyId;
    this.radioName = caps.radioName;
    this.audioName = caps.audioName;
    this.emit("identified", { radioName: caps.radioName, audioName: caps.audioName });
    this.maybeRequestStreams();
  }

  private onAuthReply(msg: Buffer): void {
    const reply = parseAuthReply(msg);
    if (!reply?.complete) return;
    if (this.authPhase !== "authenticating") return;
    this.authOk = true;
    this.startReauthLoop();
    this.maybeRequestStreams();
  }

  /**
   * Ask for the serial and audio streams, once we can.
   *
   * Needs the auth exchange complete AND the capabilities packet, because the request
   * quotes both the auth id and the sixteen-byte id from the capabilities. They arrive
   * independently, so this is called from both paths and does nothing until the second
   * one lands.
   */
  private maybeRequestStreams(): void {
    if (this.requestedStreams) return;
    if (!this.authOk || !this.authId || !this.a8ReplyId) return;
    this.requestedStreams = true;

    this.armHandshakeTimeout("stream open");
    this.sendTracked(
      buildSerialAudioRequest({
        ids: this.ids,
        authId: this.authId,
        a8ReplyId: this.a8ReplyId,
        username: this.opts.username,
        // The radio's own name, not a hardcoded model — kappanhang sends IC-705 here
        // because that is what it was written for.
        radioName: this.radioName,
        innerSeq: this.innerSeq++,
        serialPort: this.opts.serialPort ?? IcomPorts.serial,
        audioPort: this.opts.audioPort ?? IcomPorts.audio,
      }),
    );
  }

  private onStreamOpenReply(msg: Buffer): void {
    const reply = parseStreamOpenReply(msg);
    if (!reply) return;
    if (reply.authFailed) {
      this.fail(
        new Error(
          this.authPhase === "ready"
            ? "Authentication failed"
            : "Authentication failed — if the username and password are right, the radio is probably still holding a session from a previous run. Reboot it.",
        ),
      );
      return;
    }
    if (reply.disconnected) this.fail(new Error("The radio disconnected us"));
  }

  private onSerialAudioReply(msg: Buffer): void {
    if (this.authPhase === "ready") return;
    if (msg[96] !== 1) return; // The radio confirms with byte 96 set.
    this.authPhase = "ready";
    this.clearHandshakeTimeout();
    this.emit("ready", {
      ids: this.ids,
      authId: this.authId ?? Buffer.alloc(6),
      radioName: this.radioName,
      audioName: this.audioName,
      serialPort: this.opts.serialPort ?? IcomPorts.serial,
      audioPort: this.opts.audioPort ?? IcomPorts.audio,
    });
  }

  private startReauthLoop(): void {
    if (this.reauthTimer) return;
    this.reauthTimer = setInterval(() => {
      if (!this.authId) return;
      this.sendTracked(
        buildAuth({
          ids: this.ids,
          authId: this.authId,
          magic: AuthMagic.confirm,
          innerSeq: this.innerSeq++,
        }),
      );
    }, REAUTH_INTERVAL_MS);
    this.reauthTimer.unref?.();
  }

  /**
   * Shut down properly.
   *
   * The token removal is the part that matters. Without it the radio keeps the session
   * and refuses the next connection until it times out — which looks like a broken
   * radio, not an untidy exit, and sends people to reboot the rig.
   */
  async disconnect(reason = "closed by us"): Promise<void> {
    if (this.phase === "open" && this.authId) {
      // Stop renewing before releasing, or a confirm already in flight can arrive after
      // the removal and hand the radio a session nobody owns.
      if (this.reauthTimer) clearInterval(this.reauthTimer);
      this.reauthTimer = null;

      // Send the removal MORE THAN ONCE, and give it time to leave.
      //
      // This used to be one datagram followed immediately by close(), which over a VPN
      // is a coin flip: UDP, unacknowledged, with the socket shutting behind it. When it
      // lost, the radio kept the session and the next start got a half-working set of
      // streams — control and audio but no CI-V, or CI-V and no audio — until another
      // restart happened to win the toss. That is the whole reason this radio appeared
      // not to survive a restart, and it cost most of an evening's testing.
      //
      // Three attempts spaced 120 ms apart is ~360 ms of shutdown for a session release
      // that saves a minute of confusion, and PM2's kill_timeout is 8 s.
      for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
        try {
          this.sendTracked(
            buildAuth({
              ids: this.ids,
              authId: this.authId,
              magic: AuthMagic.remove,
              innerSeq: this.innerSeq++,
            }),
          );
        } catch {
          // Best effort — a failure here must not stop the socket closing.
          break;
        }
        if (attempt < RELEASE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, RELEASE_GAP_MS));
        }
      }
      // A last moment for the final datagram to get out before the socket goes.
      await new Promise((r) => setTimeout(r, RELEASE_GAP_MS));
    }
    await this.close(reason);
  }
}

/**
 * How many times to send the token removal, and how far apart.
 *
 * The radio never acknowledges it, so repetition is the only defence against a lost
 * datagram — and a lost one means the next session inherits a radio that is still
 * holding this one.
 */
const RELEASE_ATTEMPTS = 3;
const RELEASE_GAP_MS = 120;

export type StreamPhaseOrAuth =
  | "idle"
  | "opening"
  | "open"
  | "closed"
  | "logging-in"
  | "authenticating"
  | "ready";

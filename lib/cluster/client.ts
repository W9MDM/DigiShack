// A receive-only telnet client for a DX cluster node.
//
// It logs in, listens, and hands every line to its owner. It never posts a spot and never
// sends a command beyond three: the login callsign, an empty line now and then as a
// keepalive, and BYE when it is stopped. BYE matters more than it looks: DX Spider holds a
// call that dropped without one as still connected, and the node's own advice for getting
// back in after an ungraceful disconnect is to log in with a different SSID.
//
// Reconnects back off exponentially, with jitter, to a five-minute ceiling. A public node is
// a volunteer's machine; a misconfigured login retried every few seconds forever is abuse,
// and a dozen stations reconnecting in step after an outage is a small thundering herd.

import net from "node:net";

import { TelnetLineDecoder } from "@/lib/cluster/telnet";

/**
 * The login prompts of the four node families: DX Spider's "login: ", AR-Cluster's, CC
 * Cluster's and the RBN's "Please enter your call: ", and the odd "Callsign:". A colon is
 * required, so banner text that merely ends in "call" does not trigger a login.
 */
export const LOGIN_PROMPT = /(?:login|call(?:\s?sign)?)\s*:\s*$/i;

/** A node that wants a registered user's password. There is no password setting to give it. */
export const PASSWORD_PROMPT = /password\s*:\s*$/i;

export type ClusterClientState = "idle" | "connecting" | "login" | "connected" | "waiting" | "stopped";

export interface ClusterClientStatus {
  state: ClusterClientState;
  host: string;
  port: number;
  login: string;
  connectedAt: number | null;
  lastRxAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  attempt: number;
}

export interface ClusterTiming {
  connectTimeoutMs: number;
  /** Send the callsign anyway when no prompt has been recognised after this long. */
  loginTimeoutMs: number;
  /** An empty line after this long with nothing received. */
  keepaliveMs: number;
  /** Give up on the connection after this long with nothing received at all. */
  idleTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A connection that stayed up this long resets the backoff. */
  stableMs: number;
  /** How often the keepalive and idle checks run. */
  tickMs: number;
}

/**
 * Keepalive at 5 minutes and idle at 15: a public node sends dozens of spots a minute, so a
 * quarter of an hour of total silence — after keepalives that should each have drawn a
 * prompt — is a dead link, not a quiet band.
 */
export const DEFAULT_TIMING: ClusterTiming = {
  connectTimeoutMs: 15_000,
  loginTimeoutMs: 20_000,
  keepaliveMs: 5 * 60_000,
  idleTimeoutMs: 15 * 60_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  stableMs: 2 * 60_000,
  tickMs: 15_000,
};

/**
 * Exponential with "equal jitter": half the ceiling fixed, half random. Never zero, so a
 * crash loop cannot become a tight loop, and never above the ceiling.
 */
export function backoffDelay(
  attempt: number,
  t: Pick<ClusterTiming, "backoffBaseMs" | "backoffMaxMs">,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(t.backoffMaxMs, t.backoffBaseMs * 2 ** Math.min(Math.max(0, attempt), 20));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** A socket error as a sentence an operator can act on. */
export function describeSocketError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Cannot find ${host} — check the node's hostname, and that this machine has DNS`;
    case "ECONNREFUSED":
      return `${host} refused a connection on port ${port} — check the port, or the node may be down`;
    case "ETIMEDOUT":
      return `${host}:${port} did not answer`;
    case "ECONNRESET":
      return `${host} reset the connection`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `No route to ${host}`;
    default:
      return err.message || String(err);
  }
}

export interface ClusterClientOptions {
  host: string;
  port: number;
  login: string;
  onLine: (line: string) => void;
  onStatus?: (status: ClusterClientStatus) => void;
  log?: (line: string) => void;
  timing?: Partial<ClusterTiming>;
  random?: () => number;
}

export class ClusterClient {
  private readonly t: ClusterTiming;
  private readonly decoder = new TelnetLineDecoder();
  private socket: net.Socket | null = null;
  private stopped = true;
  private state: ClusterClientState = "idle";
  private attempt = 0;
  private connectedAt: number | null = null;
  private loggedInAt: number | null = null;
  private lastRxAt: number | null = null;
  private lastKeepaliveAt = 0;
  private lastError: string | null = null;
  private nextRetryAt: number | null = null;
  /** Why the CURRENT connection is ending, when this side knows. */
  private reason: string | null = null;
  /** The last thing the node said, for "it hung up after saying …". */
  private lastText: string | null = null;
  private timers: {
    connect?: ReturnType<typeof setTimeout>;
    login?: ReturnType<typeof setTimeout>;
    retry?: ReturnType<typeof setTimeout>;
    tick?: ReturnType<typeof setInterval>;
  } = {};

  constructor(private readonly opts: ClusterClientOptions) {
    this.t = { ...DEFAULT_TIMING, ...opts.timing };
  }

  get status(): ClusterClientStatus {
    return {
      state: this.state,
      host: this.opts.host,
      port: this.opts.port,
      login: this.opts.login,
      connectedAt: this.loggedInAt,
      lastRxAt: this.lastRxAt,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      attempt: this.attempt,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timers.tick = setInterval(() => this.tick(), this.t.tickMs);
    this.timers.tick.unref?.();
    this.open();
  }

  /** Log out with BYE and close. Resolves once the socket is gone, or after a second regardless. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers(true);
    this.nextRetryAt = null;
    const sock = this.socket;
    if (sock && !sock.destroyed) {
      await new Promise<void>((resolve) => {
        const done = setTimeout(() => {
          sock.destroy();
          resolve();
        }, 1_000);
        sock.once("close", () => {
          clearTimeout(done);
          resolve();
        });
        try {
          if (this.loggedInAt !== null) sock.write("bye\r\n");
          sock.end();
        } catch {
          sock.destroy();
        }
      });
    }
    this.socket = null;
    this.setState("stopped");
  }

  private setState(s: ClusterClientState): void {
    this.state = s;
    this.opts.onStatus?.(this.status);
  }

  private clearTimers(all: boolean): void {
    clearTimeout(this.timers.connect);
    clearTimeout(this.timers.login);
    clearTimeout(this.timers.retry);
    if (all) clearInterval(this.timers.tick);
  }

  private open(): void {
    if (this.stopped) return;
    this.decoder.reset();
    this.reason = null;
    this.lastText = null;
    this.connectedAt = null;
    this.loggedInAt = null;
    this.setState("connecting");

    const sock = net.connect({ host: this.opts.host, port: this.opts.port });
    this.socket = sock;
    sock.setNoDelay(true);
    // The OS-level probe catches a link that died without a FIN long before the idle timer.
    sock.setKeepAlive(true, 60_000);

    this.timers.connect = setTimeout(() => {
      this.reason = `${this.opts.host}:${this.opts.port} did not answer within ${Math.round(this.t.connectTimeoutMs / 1000)} s`;
      sock.destroy();
    }, this.t.connectTimeoutMs);

    sock.on("connect", () => {
      clearTimeout(this.timers.connect);
      this.connectedAt = Date.now();
      this.lastRxAt = this.connectedAt;
      this.setState("login");
      // Some nodes print a banner and wait without a prompt this client recognises.
      this.timers.login = setTimeout(() => {
        if (this.state === "login") this.sendLogin();
      }, this.t.loginTimeoutMs);
    });
    sock.on("data", (chunk: Buffer) => {
      if (sock === this.socket) this.onData(chunk);
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      if (this.reason === null) this.reason = describeSocketError(err, this.opts.host, this.opts.port);
    });
    sock.on("close", () => this.onClose(sock));
  }

  private sendLogin(): void {
    const sock = this.socket;
    if (!sock || sock.destroyed) return;
    clearTimeout(this.timers.login);
    // The prompt is answered; left in the buffer it would come back as a line and read as
    // the node asking again.
    this.decoder.discardPartial();
    sock.write(`${this.opts.login}\r\n`);
    this.loggedInAt = Date.now();
    this.lastError = null;
    this.setState("connected");
    this.opts.log?.(`[cluster] logged in to ${this.opts.host}:${this.opts.port} as ${this.opts.login}`);
  }

  private refuse(reason: string): void {
    this.reason = reason;
    this.socket?.destroy();
  }

  private onData(chunk: Buffer): void {
    this.lastRxAt = Date.now();
    const { lines, reply } = this.decoder.push(chunk);
    if (reply) this.socket?.write(reply);

    for (const line of lines) {
      if (this.checkPrompt(line)) return;
      if (line.trim()) this.lastText = line.trim().slice(0, 160);
      this.opts.onLine(line);
    }
    this.checkPrompt(this.decoder.partial);
  }

  /** True when the prompt ended this connection. */
  private checkPrompt(text: string): boolean {
    if (this.state === "login" && LOGIN_PROMPT.test(text)) {
      this.sendLogin();
      return false;
    }
    if (this.state !== "connected" || this.loggedInAt === null) return false;
    // Asked again straight after logging in: the node did not take the call.
    if (LOGIN_PROMPT.test(text) && Date.now() - this.loggedInAt < 60_000) {
      this.refuse(
        `${this.opts.host} did not accept the login ${this.opts.login}` +
          (this.lastText ? ` — it said "${this.lastText}"` : ""),
      );
      return true;
    }
    if (PASSWORD_PROMPT.test(text)) {
      this.refuse(
        `${this.opts.host} asks ${this.opts.login} for a password. DigiShack has no cluster password setting — use a node that takes open logins, or a different SSID`,
      );
      return true;
    }
    return false;
  }

  private onClose(sock: net.Socket): void {
    if (sock !== this.socket) return;
    this.clearTimers(false);
    this.socket = null;
    const now = Date.now();
    const upFor = this.connectedAt === null ? 0 : now - this.connectedAt;
    if (this.connectedAt !== null && upFor >= this.t.stableMs) this.attempt = 0;

    if (!this.stopped) {
      this.lastError =
        this.reason ??
        (this.loggedInAt !== null
          ? `${this.opts.host} closed the connection` +
            (upFor < 60_000 && this.lastText ? ` after saying "${this.lastText}"` : "")
          : this.connectedAt !== null
            ? `${this.opts.host} closed the connection before the login`
            : `Could not connect to ${this.opts.host}:${this.opts.port}`);
    }
    this.connectedAt = null;
    this.loggedInAt = null;

    if (this.stopped) {
      this.setState("stopped");
      return;
    }
    const delay = backoffDelay(this.attempt, this.t, this.opts.random);
    this.attempt++;
    this.nextRetryAt = now + delay;
    this.opts.log?.(`[cluster] ${this.lastError}; retrying in ${Math.round(delay / 1000)} s`);
    this.setState("waiting");
    this.timers.retry = setTimeout(() => {
      this.nextRetryAt = null;
      this.open();
    }, delay);
    this.timers.retry.unref?.();
  }

  private tick(): void {
    const sock = this.socket;
    if (this.state !== "connected" || !sock || this.lastRxAt === null) return;
    const now = Date.now();
    const quiet = now - this.lastRxAt;
    if (quiet >= this.t.idleTimeoutMs) {
      this.refuse(`Nothing from ${this.opts.host} for ${Math.round(quiet / 60_000)} min — reconnecting`);
      return;
    }
    if (quiet >= this.t.keepaliveMs && now - this.lastKeepaliveAt >= this.t.keepaliveMs) {
      // An empty command line: every node family answers it with a fresh prompt, which is
      // the traffic that proves the link is alive.
      this.lastKeepaliveAt = now;
      sock.write("\r\n");
    }
  }
}

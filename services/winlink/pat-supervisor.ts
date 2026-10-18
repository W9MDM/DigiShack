// Supervised loopback Pat engine for DigiShack's Winlink workspace.
//
// Owns the Pat subprocess lifecycle: spawn it bound to loopback, wait until its HTTP API
// answers, restart it on an unexpected exit (bounded), and stop it cleanly. It refuses any
// non-loopback bind so the engine is never exposed on the LAN (Pat serves cleartext HTTP and,
// if listeners are enabled, a password-less telnet port — neither belongs on a network).
//
// Every side effect is injectable (spawn, health probe, sleep), so the whole state machine is
// verified offline by scripts/check-winlink-supervisor.ts without a real Pat or real timers.

import { spawn as nodeSpawn } from "node:child_process";

export interface PatSupervisorConfig {
  /** Path to the pinned pat binary. */
  binary: string;
  configPath: string;
  mbox: string;
  /** Pat's web/JSON API bind — MUST be loopback (enforced). */
  httpAddr: string;
  eventLog?: string;
  logFile?: string;
  mycall?: string;
}

/** The slice of a child process the supervisor needs — lets tests fake it. */
export interface SpawnedProcess {
  readonly pid?: number;
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;

export interface PatSupervisorOptions {
  /** How long to wait for the API to answer after a spawn. */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Restart on an unexpected exit (not on stop()). */
  autoRestart?: boolean;
  restartDelayMs?: number;
  /** Cap restarts so a crash loop can't hammer the box forever. */
  maxRestarts?: number;
  spawnImpl?: SpawnFn;
  healthProbe?: () => Promise<boolean>;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: (line: string) => void;
}

export interface PatSupervisorState {
  running: boolean;
  ready: boolean;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
}

/** Throw unless `httpAddr` binds a loopback host. Exported for the UI/settings validator. */
export function assertLoopback(httpAddr: string): void {
  let host = httpAddr.trim();
  const m = host.match(/^(.*):(\d+)$/);
  if (m) host = m[1]!;
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Pat httpAddr must be loopback (got "${httpAddr}"); never expose the engine on the LAN`);
  }
}

const DEFAULTS = {
  readyTimeoutMs: 15000,
  pollIntervalMs: 500,
  autoRestart: true,
  restartDelayMs: 2000,
  maxRestarts: 5,
};

export class PatSupervisor {
  private readonly cfg: PatSupervisorConfig;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;
  private readonly spawn: SpawnFn;
  private readonly healthProbe: () => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  private child: SpawnedProcess | null = null;
  private stopping = false;
  private readonly state: PatSupervisorState = {
    running: false,
    ready: false,
    pid: null,
    restarts: 0,
    lastExitCode: null,
  };

  constructor(cfg: PatSupervisorConfig, options: PatSupervisorOptions = {}) {
    assertLoopback(cfg.httpAddr);
    this.cfg = cfg;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.autoRestart = options.autoRestart ?? DEFAULTS.autoRestart;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULTS.restartDelayMs;
    this.maxRestarts = options.maxRestarts ?? DEFAULTS.maxRestarts;
    this.spawn = options.spawnImpl ?? ((c, a) => nodeSpawn(c, a, { stdio: "ignore" }) as unknown as SpawnedProcess);
    this.healthProbe = options.healthProbe ?? this.defaultHealthProbe;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = options.logger ?? (() => {});
  }

  getState(): PatSupervisorState {
    return { ...this.state };
  }

  /** Arguments mirror how the engine is launched by hand (see deploy notes). */
  buildArgs(): string[] {
    const args = ["--config", this.cfg.configPath, "--mbox", this.cfg.mbox];
    if (this.cfg.eventLog) args.push("--event-log", this.cfg.eventLog);
    if (this.cfg.logFile) args.push("--log", this.cfg.logFile);
    if (this.cfg.mycall) args.push("--mycall", this.cfg.mycall);
    args.push("http", "--addr", this.cfg.httpAddr);
    return args;
  }

  async start(): Promise<void> {
    if (this.state.running) return;
    this.stopping = false;
    this.spawnChild();
    await this.waitReady();
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.stopping = true;
    if (this.child) {
      this.log("stopping pat");
      this.child.kill(signal);
      this.child = null;
    }
    this.state.running = false;
    this.state.ready = false;
    this.state.pid = null;
  }

  private spawnChild(): void {
    const child = this.spawn(this.cfg.binary, this.buildArgs());
    this.child = child;
    this.state.running = true;
    this.state.ready = false;
    this.state.pid = child.pid ?? null;
    this.log(`spawned pat pid ${this.state.pid ?? "?"}`);
    child.on("exit", (code) => this.onExit(code));
  }

  private onExit(code: number | null): void {
    this.log(`pat exited (code ${code})`);
    this.state.running = false;
    this.state.ready = false;
    this.state.pid = null;
    this.state.lastExitCode = code;
    this.child = null;
    if (this.stopping || !this.autoRestart) return;
    if (this.state.restarts >= this.maxRestarts) {
      this.log(`pat exceeded ${this.maxRestarts} restarts; not restarting`);
      return;
    }
    this.state.restarts += 1;
    this.log(`restarting pat (#${this.state.restarts}) after ${this.restartDelayMs} ms`);
    void this.sleep(this.restartDelayMs).then(() => {
      if (this.stopping || this.state.running) return;
      this.spawnChild();
      void this.waitReady().catch((err) => this.log(`restart not ready: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  private async waitReady(): Promise<void> {
    const attempts = Math.max(1, Math.ceil(this.readyTimeoutMs / this.pollIntervalMs));
    for (let i = 0; i < attempts; i++) {
      if (!this.state.running) throw new Error("pat exited before becoming ready");
      if (await this.healthProbe()) {
        this.state.ready = true;
        this.log("pat ready");
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`pat did not answer on ${this.cfg.httpAddr} within ${this.readyTimeoutMs} ms`);
  }

  private defaultHealthProbe = async (): Promise<boolean> => {
    try {
      const res = await fetch(`http://${this.cfg.httpAddr}/api/status`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

import net from "node:net";
import { EventEmitter } from "node:events";

// FlexRadio SmartSDR command API client (TCP 4992).
//
// Wire protocol, verified against a FLEX-6400 on SmartSDR 4.2.18:
//
//   radio -> V1.4.0.0                 API version, first line on connect
//   radio -> H02F7A627                this client's handle (hex)
//   us    -> C<seq>|<command>
//   radio -> R<seq>|<hexStatus>|<message>
//   radio -> S<handle>|<object> <k>=<v> …     unsolicited status
//   radio -> M<code>|<text>                   human-readable message
//
// SAFETY: this client is read-oriented. `command()` will send whatever it is
// given, but nothing in DigiShack calls it with slice/mode/transmit commands, and
// `subscribe()` only ever requests read streams. An operator normally has a
// SmartSDR session open on the same radio; changing state underneath them would
// be both surprising and, in the case of TX, potentially illegal.

export interface FlexReply {
  seq: number;
  /** 0 is success. Anything else is a SmartSDR error code. */
  status: number;
  message: string;
  command: string;
}

/**
 * One unsolicited `S…` line, split into what names the object and what describes it.
 *
 * The original version of this took only the FIRST token as the object and a plain
 * integer as the index, which was enough for `slice 0 …` and `interlock …` and silently
 * threw away everything else. A panadapter reports as
 *
 *     display pan 0x40000000 center=14.100000 bandwidth=0.200000 …
 *
 * and arrived as object `display` with the words `pan` and `0x40000000` dropped on the
 * floor, because neither contains an `=`. Two panadapters on the radio are then
 * indistinguishable — every frame of one overwrites the other's centre frequency — and a
 * waterfall object (`display waterfall 0x42000000 …`) is indistinguishable from a
 * panadapter. That is the kind of merge this project keeps paying for.
 */
export interface FlexStatus {
  handle: string;
  /** The object's name, spaces and all: `slice`, `interlock`, `display pan`. */
  object: string;
  /** The object's identifier exactly as the radio wrote it: `0`, `0x40000000`. */
  id: string | null;
  /** `id` as a number when it is a plain index, for `slice 0`. */
  index: number | null;
  /** Bare words after the id — `connected` and `disconnected` on a client line. */
  flags: string[];
  fields: Record<string, string>;
}

export function parseStatusBody(body: string): Omit<FlexStatus, "handle"> {
  const tokens = body.split(/\s+/).filter(Boolean);

  // Leading words with no `=` name the object, up to the first one that looks like an
  // identifier. Stopping at the identifier rather than at the first `key=value` is what
  // makes `client 0x74C8037A connected client_id=…` come out as object `client` with a
  // flag, instead of object `client 0x74C8037A connected`.
  const path: string[] = [];
  const flags: string[] = [];
  let id: string | null = null;
  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.includes("=")) break;
    if (id === null && /^(?:0x[0-9A-Fa-f]+|\d+)$/.test(tok)) id = tok;
    else if (id === null) path.push(tok);
    else flags.push(tok);
  }

  const fields: Record<string, string> = {};
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const eq = tok.indexOf("=");
    if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }

  return {
    object: path.join(" "),
    id,
    index: id !== null && /^\d+$/.test(id) ? Number(id) : null,
    flags,
    fields,
  };
}

export interface FlexSlice {
  index: number;
  /** Hz. SmartSDR reports MHz as a decimal string; converted here. */
  freqHz: number | null;
  mode: string | null;
  /** Receive antenna. */
  rxAnt: string | null;
  txAnt: string | null;
  active: boolean;
  tx: boolean;
  /** Filter edges in Hz relative to the carrier. */
  filterLo: number | null;
  filterHi: number | null;
  raw: Record<string, string>;
}

export interface FlexRadioState {
  connected: boolean;
  handle: string | null;
  apiVersion: string | null;
  model: string | null;
  callsign: string | null;
  serial: string | null;
  softwareVersion: string | null;
  /** Slices keyed by index. */
  slices: Map<number, FlexSlice>;
  /** True while the radio is transmitting. */
  transmitting: boolean;
  atuPresent: boolean;
  numSlice: number | null;
  numTx: number | null;
}

type Events = {
  connected: [];
  disconnected: [Error | null];
  slice: [FlexSlice];
  transmit: [boolean];
  status: [FlexStatus];
  message: [{ code: string; text: string }];
};

export class FlexClient extends EventEmitter<Events> {
  readonly host: string;
  readonly port: number;

  private socket: net.Socket | null = null;
  private buffer = "";
  private seq = 1;
  private pending = new Map<
    number,
    { command: string; resolve: (r: FlexReply) => void; timer: NodeJS.Timeout }
  >();

  readonly state: FlexRadioState = {
    connected: false,
    handle: null,
    apiVersion: null,
    model: null,
    callsign: null,
    serial: null,
    softwareVersion: null,
    slices: new Map(),
    transmitting: false,
    atuPresent: false,
    numSlice: null,
    numTx: null,
  };

  constructor(host: string, port = 4992) {
    super();
    this.host = host;
    this.port = port;
  }

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.setKeepAlive(true, 30_000);

      const failed = (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };

      const timer = setTimeout(
        () => failed(new Error(`Timed out connecting to ${this.host}:${this.port}`)),
        timeoutMs,
      );

      socket.once("error", failed);

      // Resolve on the handle line rather than on TCP connect: a socket that
      // opens but never speaks (wrong port, or a radio mid-reboot) is not usable.
      const onReady = () => {
        clearTimeout(timer);
        socket.off("error", failed);
        this.state.connected = true;
        this.emit("connected");
        resolve();
      };
      this.once("connected", onReady);

      socket.on("data", (chunk: string) => this.onData(chunk));

      socket.on("close", () => {
        this.state.connected = false;
        this.failPending(new Error("Connection closed"));
        this.emit("disconnected", null);
      });

      socket.on("error", (err) => {
        this.state.connected = false;
        this.failPending(err);
        this.emit("disconnected", err);
      });
    });
  }

  disconnect(): void {
    this.failPending(new Error("Disconnected"));
    this.socket?.end();
    this.socket = null;
    this.state.connected = false;
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      // Resolve rather than reject: a caller awaiting several probes shouldn't
      // have one dropped connection turn into an unhandled rejection.
      p.resolve({ seq: -1, status: -1, message: err.message, command: p.command });
    }
    this.pending.clear();
  }

  /** Send a command and await its reply. */
  command(cmd: string, timeoutMs = 10_000): Promise<FlexReply> {
    if (!this.socket || !this.state.connected) {
      return Promise.resolve({
        seq: -1,
        status: -1,
        message: "Not connected",
        command: cmd,
      });
    }

    const seq = this.seq++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve({ seq, status: -1, message: "Timed out", command: cmd });
      }, timeoutMs);

      this.pending.set(seq, { command: cmd, resolve, timer });
      this.socket!.write(`C${seq}|${cmd}\n`);
    });
  }

  /**
   * Subscribe to a status stream. Read-only: subscriptions ask the radio to
   * report changes, they don't change anything.
   */
  async subscribe(what: "slice all" | "radio all" | "tx all" | "meter all"): Promise<FlexReply> {
    return this.command(`sub ${what}`);
  }

  /** `info` and `version`, both read-only. */
  async readInfo(): Promise<void> {
    const [version, info] = await Promise.all([
      this.command("version"),
      this.command("info"),
    ]);

    if (version.status === 0) {
      // e.g. SmartSDR-MB=4.2.18.41174#PSoC-MBTRX=1.0.3.0#…
      const mb = /SmartSDR-MB=([^#]+)/.exec(version.message)?.[1];
      if (mb) this.state.softwareVersion = mb;
    }

    if (info.status === 0) {
      const fields = parseInfoReply(info.message);
      this.state.model = fields.model ?? this.state.model;
      this.state.callsign = fields.callsign ?? this.state.callsign;
      this.state.serial = fields.chassis_serial ?? this.state.serial;
      this.state.atuPresent = fields.atu_present === "1";
      this.state.numSlice = fields.num_slice ? Number(fields.num_slice) : null;
      this.state.numTx = fields.num_tx ? Number(fields.num_tx) : null;
      if (fields.software_ver) this.state.softwareVersion = fields.software_ver;
    }
  }

  // -------------------------------------------------------------------------

  private onData(chunk: string): void {
    this.buffer += chunk;

    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    switch (line[0]) {
      case "V":
        this.state.apiVersion = line.slice(1);
        break;

      case "H":
        this.state.handle = line.slice(1);
        // The handle line is the last of the greeting; the link is usable now.
        this.emit("connected");
        break;

      case "R": {
        const bar1 = line.indexOf("|");
        const bar2 = line.indexOf("|", bar1 + 1);
        if (bar1 === -1) return;

        const seq = Number(line.slice(1, bar1));
        const statusHex = bar2 === -1 ? line.slice(bar1 + 1) : line.slice(bar1 + 1, bar2);
        const message = bar2 === -1 ? "" : line.slice(bar2 + 1);

        const p = this.pending.get(seq);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(seq);
        p.resolve({
          seq,
          status: parseInt(statusHex, 16) || 0,
          message,
          command: p.command,
        });
        break;
      }

      case "S": {
        const bar = line.indexOf("|");
        if (bar === -1) return;
        const handle = line.slice(1, bar);
        const body = line.slice(bar + 1);
        this.onStatus(handle, body);
        break;
      }

      case "M": {
        const bar = line.indexOf("|");
        this.emit("message", {
          code: line.slice(1, bar === -1 ? undefined : bar),
          text: bar === -1 ? "" : line.slice(bar + 1),
        });
        break;
      }

      default:
        break;
    }
  }

  private onStatus(handle: string, body: string): void {
    const { object, id, index, flags, fields } = parseStatusBody(body);

    this.emit("status", { handle, object, id, index, flags, fields });

    if (object === "slice" && index !== null) {
      this.onSliceStatus(index, fields);
    } else if (object === "interlock") {
      // state=TRANSMITTING is the authoritative TX indicator.
      const st = fields.state;
      if (st) {
        const tx = st === "TRANSMITTING";
        if (tx !== this.state.transmitting) {
          this.state.transmitting = tx;
          this.emit("transmit", tx);
        }
      }
    }
  }

  private onSliceStatus(index: number, fields: Record<string, string>): void {
    const existing = this.state.slices.get(index);

    // Status updates are partial — a mode change sends only `mode=…` — so fields
    // are merged rather than replacing the slice.
    const raw = { ...(existing?.raw ?? {}), ...fields };

    const mhz = raw.RF_frequency;
    const slice: FlexSlice = {
      index,
      // SmartSDR reports MHz as a decimal string; the log stores Hz.
      freqHz: mhz !== undefined ? Math.round(Number(mhz) * 1_000_000) : (existing?.freqHz ?? null),
      mode: raw.mode ?? existing?.mode ?? null,
      rxAnt: raw.rxant ?? existing?.rxAnt ?? null,
      txAnt: raw.txant ?? existing?.txAnt ?? null,
      active: raw.active !== undefined ? raw.active === "1" : (existing?.active ?? false),
      tx: raw.tx !== undefined ? raw.tx === "1" : (existing?.tx ?? false),
      filterLo: raw.filter_lo !== undefined ? Number(raw.filter_lo) : (existing?.filterLo ?? null),
      filterHi: raw.filter_hi !== undefined ? Number(raw.filter_hi) : (existing?.filterHi ?? null),
      raw,
    };

    // A removed slice reports in_use=0.
    if (raw.in_use === "0") {
      this.state.slices.delete(index);
      return;
    }

    this.state.slices.set(index, slice);
    this.emit("slice", slice);
  }

  /** The slice a logger should follow: the TX slice, else the active one, else the first. */
  activeSlice(): FlexSlice | null {
    const slices = [...this.state.slices.values()];
    return (
      slices.find((s) => s.tx) ?? slices.find((s) => s.active) ?? slices[0] ?? null
    );
  }
}

/**
 * The `info` reply is comma-separated key=value with quoted values that may
 * themselves contain commas (`options="GPS,ATU"`), so it can't just be split on
 * commas.
 */
export function parseInfoReply(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    out[m[1]!] = m[3] !== undefined ? m[3] : (m[2] ?? "");
  }
  return out;
}

/** SmartSDR mode -> ADIF-ish mode. DIGU/DIGL are the FT8/FT4 carriers. */
export function flexModeToLogMode(mode: string | null): string | null {
  if (!mode) return null;
  switch (mode.toUpperCase()) {
    case "USB":
    case "LSB":
      return "SSB";
    case "CW":
      return "CW";
    case "FM":
    case "NFM":
    case "DFM":
      return "FM";
    case "AM":
    case "SAM":
      return "AM";
    // A data slice can't tell you which data mode is in use — that depends on
    // what the decoder is doing, not the radio.
    case "DIGU":
    case "DIGL":
    case "RTTY":
      return null;
    default:
      return null;
  }
}

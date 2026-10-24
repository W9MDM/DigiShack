// A read-only IMAP client: just enough of RFC 3501 to read new mail, and nothing that writes.
//
// Written here rather than taken as a dependency — the card importer needs seven commands —
// and shaped so it CANNOT change a mailbox:
//
//   * folders are opened with EXAMINE, the read-only form of SELECT, so the server itself
//     refuses to set flags for this session;
//   * messages are fetched with BODY.PEEK[], which does not mark them read;
//   * every command is checked against a fixed list before it is written (STORE, EXPUNGE,
//     COPY, MOVE, APPEND, DELETE and plain SELECT are not on it).
//
// Security: TLS always. Port 993 is TLS from the first byte; with `tls` off the connection
// MUST upgrade with STARTTLS before the password is sent, and a server that will not is
// refused rather than given the password in the clear.
//
// The socket is abstracted (ImapSocket) so scripts/check-qsl-inbound.ts can play a recorded
// server conversation through the real parser without a network.
//
// UNVERIFIED against a live server from this code: tested against recorded Gmail-style
// responses (literals, quoted strings, untagged updates between responses). Said so in the
// settings help as well.

import net from "node:net";
import tls from "node:tls";

export interface ImapSocket {
  write(data: string): void;
  on(event: "data", fn: (chunk: Buffer) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  removeAllListeners(): unknown;
  destroy(): void;
}

export interface ImapResponse {
  /** The response line(s) with each literal replaced by \u0000<index>\u0000. */
  text: string;
  literals: Buffer[];
}

export class ImapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapError";
  }
}

/** Largest literal accepted from the server — a whole message, so above the card limit. */
export const MAX_LITERAL_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

/** The only commands this client will ever send. */
const ALLOWED = /^(CAPABILITY|NOOP|STARTTLS|LOGIN|EXAMINE|LOGOUT|UID SEARCH|UID FETCH)\b/;

/**
 * Turns a byte stream into complete IMAP responses. Pure, and the part the check exercises.
 *
 * A response ends at a CRLF that is not announcing a literal. `{123}` at the end of a line
 * means 123 raw bytes follow, after which the same response continues.
 */
export class ImapReader {
  private buf: Buffer = Buffer.alloc(0);
  private text = "";
  private literals: Buffer[] = [];
  private need = -1;

  constructor(private readonly onResponse: (r: ImapResponse) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.need >= 0) {
        if (this.buf.length < this.need) return;
        this.literals.push(this.buf.subarray(0, this.need));
        this.text += `\u0000${this.literals.length - 1}\u0000`;
        this.buf = this.buf.subarray(this.need);
        this.need = -1;
        continue;
      }
      const eol = this.buf.indexOf("\r\n");
      if (eol < 0) {
        if (this.buf.length > 1024 * 1024) throw new ImapError("The IMAP server sent a line over 1 MB.");
        return;
      }
      const line = this.buf.subarray(0, eol).toString("latin1");
      this.buf = this.buf.subarray(eol + 2);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (lit) {
        const n = Number(lit[1]);
        if (n > MAX_LITERAL_BYTES) throw new ImapError(`The IMAP server offered ${n} bytes in one piece; refusing.`);
        this.text += line.slice(0, lit.index);
        this.need = n;
        continue;
      }
      this.text += line;
      const done = { text: this.text, literals: this.literals };
      this.text = "";
      this.literals = [];
      this.onResponse(done);
    }
  }
}

/** A string as an IMAP quoted string. Refuses what cannot be quoted. */
export function quote(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new ImapError("A value contains a line break, which IMAP cannot carry.");
  if (/[^\x20-\x7e]/.test(s)) throw new ImapError("A value contains characters outside plain ASCII, which this client cannot send.");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** IMAP's SEARCH date: 22-Oct-2026. */
export function imapDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** INTERNALDATE "22-Oct-2026 18:38:00 +0000" → Date. */
export function parseInternalDate(s: string): Date | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mon < 0) return null;
  const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const off = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === "-" ? -1 : 1);
  return new Date(utc - off);
}

export interface FetchedHeader {
  uid: number;
  internalDate: Date | null;
  size: number;
  header: Buffer;
}

/** The parts of an untagged FETCH response this client asked for. */
export function parseFetch(r: ImapResponse): { uid: number; internalDate: Date | null; size: number; section: Buffer | null } | null {
  if (!/^\* \d+ FETCH \(/i.test(r.text)) return null;
  const uid = /\bUID (\d+)/i.exec(r.text);
  if (!uid) return null;
  const date = /\bINTERNALDATE "([^"]+)"/i.exec(r.text);
  const size = /\bRFC822\.SIZE (\d+)/i.exec(r.text);
  let section: Buffer | null = null;
  const lit = /\bBODY\[[^\]]*\](?:<\d+>)?\s*\u0000(\d+)\u0000/i.exec(r.text);
  if (lit) section = r.literals[Number(lit[1])] ?? null;
  else {
    const q = /\bBODY\[[^\]]*\](?:<\d+>)?\s*"((?:[^"\\]|\\.)*)"/i.exec(r.text);
    if (q) section = Buffer.from(q[1]!.replace(/\\(.)/g, "$1"), "latin1");
  }
  return {
    uid: Number(uid[1]),
    internalDate: date ? parseInternalDate(date[1]!) : null,
    size: size ? Number(size[1]) : 0,
    section,
  };
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  tls: boolean;
  /** For the check: a ready-made socket in place of a network connection. */
  socket?: ImapSocket;
  /** For the check: how STARTTLS upgrades the socket. */
  upgrade?: (s: ImapSocket) => Promise<ImapSocket>;
}

export class ImapClient {
  private sock: ImapSocket | null = null;
  private tag = 0;
  private waiting: { tag: string; untagged: ImapResponse[]; resolve: (r: { status: string; text: string; untagged: ImapResponse[] }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private greeting: { resolve: (r: ImapResponse) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  private attach(sock: ImapSocket): void {
    this.sock = sock;
    const reader = new ImapReader((r) => this.dispatch(r));
    sock.on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch (err) {
        this.fail(err instanceof Error ? err : new ImapError(String(err)));
      }
    });
    sock.on("error", (err) => this.fail(new ImapError(`IMAP connection error: ${err.message}`)));
    sock.on("close", () => this.fail(new ImapError("The IMAP server closed the connection.")));
  }

  private fail(err: Error): void {
    this.failure ??= err;
    const g = this.greeting;
    this.greeting = null;
    g?.reject(err);
    const w = this.waiting;
    this.waiting = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.sock?.destroy();
  }

  private dispatch(r: ImapResponse): void {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      g.resolve(r);
      return;
    }
    const w = this.waiting;
    if (!w) return; // unsolicited, between commands: nothing is waiting for it
    if (r.text.startsWith("* ") || r.text.startsWith("+")) {
      w.untagged.push(r);
      return;
    }
    const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/i.exec(r.text);
    if (m && m[1] === w.tag) {
      this.waiting = null;
      clearTimeout(w.timer);
      w.resolve({ status: m[2]!.toUpperCase(), text: m[3] ?? "", untagged: w.untagged });
    }
  }

  private run(command: string): Promise<{ status: string; text: string; untagged: ImapResponse[] }> {
    if (!ALLOWED.test(command)) throw new ImapError(`Refusing to send a command this read-only client does not use: ${command.split(" ")[0]}`);
    if (/^UID FETCH\b/.test(command) && /BODY\[/i.test(command)) {
      throw new ImapError("A fetch must use BODY.PEEK so the message is not marked read.");
    }
    if (this.failure) return Promise.reject(this.failure);
    if (!this.sock) return Promise.reject(new ImapError("Not connected."));
    const tag = `D${++this.tag}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ImapError(`The IMAP server did not answer ${command.split(" ").slice(0, 2).join(" ")} within a minute.`)), COMMAND_TIMEOUT_MS);
      this.waiting = { tag, untagged: [], resolve, reject, timer };
      this.sock!.write(`${tag} ${command}\r\n`);
    });
  }

  private async ok(command: string, what: string): Promise<{ text: string; untagged: ImapResponse[] }> {
    const r = await this.run(command);
    if (r.status !== "OK") throw new ImapError(`${what} was refused: ${r.status} ${r.text}`.trim());
    return r;
  }

  /** Connect, upgrade to TLS where needed, and sign in. */
  async connect(opts: ImapConnectOptions, user: string, password: string): Promise<void> {
    const greeted = new Promise<ImapResponse>((resolve, reject) => (this.greeting = { resolve, reject }));
    let sock: ImapSocket;
    if (opts.socket) sock = opts.socket;
    else if (opts.tls) {
      sock = tls.connect({ host: opts.host, port: opts.port, servername: opts.host });
    } else {
      sock = net.connect({ host: opts.host, port: opts.port });
    }
    this.attach(sock);
    // A server that accepts the connection and says nothing is failed, not waited on forever.
    const timer = setTimeout(
      () => this.fail(new ImapError(`No greeting from ${opts.host}:${opts.port} within 30 s.`)),
      30_000,
    );
    let g: ImapResponse;
    try {
      g = await greeted;
    } finally {
      clearTimeout(timer);
    }
    if (!/^\* (OK|PREAUTH)\b/i.test(g.text)) throw new ImapError(`The server did not greet as IMAP: ${g.text.slice(0, 120)}`);

    if (!opts.tls) {
      const r = await this.run("STARTTLS");
      if (r.status !== "OK") {
        throw new ImapError("The server will not start TLS, and the password is never sent unencrypted. Use port 993 with TLS on.");
      }
      // The old socket's listeners go; the encrypted one takes over the same reader state.
      sock.removeAllListeners();
      const upgraded = opts.upgrade
        ? await opts.upgrade(sock)
        : await new Promise<ImapSocket>((resolve, reject) => {
            const t = tls.connect({ socket: sock as net.Socket, servername: opts.host }, () => resolve(t));
            t.once("error", reject);
          });
      this.attach(upgraded);
    }
    await this.ok(`LOGIN ${quote(user)} ${quote(password)}`, "Signing in");
  }

  /** Open a folder read-only. Returns how many messages it holds. */
  async examine(folder: string): Promise<{ exists: number; uidValidity: string }> {
    const r = await this.ok(`EXAMINE ${quote(folder)}`, `Opening ${folder}`);
    let exists = 0;
    let uidValidity = "";
    for (const u of r.untagged) {
      const e = /^\* (\d+) EXISTS/i.exec(u.text);
      if (e) exists = Number(e[1]);
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.text);
      if (v) uidValidity = v[1]!;
    }
    return { exists, uidValidity };
  }

  /** UIDs of messages received on or after this day (IMAP's SINCE is by date). */
  async searchSince(day: Date): Promise<number[]> {
    const r = await this.ok(`UID SEARCH SINCE ${imapDate(day)}`, "Searching");
    const out: number[] = [];
    for (const u of r.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(u.text);
      if (m) for (const n of m[1]!.trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(Number(n));
    }
    return out.sort((a, b) => a - b);
  }

  /** Headers, date and size for a set of UIDs. */
  async fetchHeaders(uids: number[]): Promise<FetchedHeader[]> {
    if (uids.length === 0) return [];
    const r = await this.ok(
      `UID FETCH ${uids.join(",")} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])`,
      "Reading headers",
    );
    const out: FetchedHeader[] = [];
    for (const u of r.untagged) {
      const f = parseFetch(u);
      if (f && f.section) out.push({ uid: f.uid, internalDate: f.internalDate, size: f.size, header: f.section });
    }
    return out.sort((a, b) => a.uid - b.uid);
  }

  /** One whole message, without marking it read. */
  async fetchMessage(uid: number): Promise<Buffer | null> {
    const r = await this.ok(`UID FETCH ${uid} (UID BODY.PEEK[])`, "Reading a message");
    for (const u of r.untagged) {
      const f = parseFetch(u);
      if (f && f.uid === uid && f.section) return f.section;
    }
    return null;
  }

  async logout(): Promise<void> {
    try {
      if (this.sock && !this.failure) await this.run("LOGOUT");
    } catch {
      /* closing anyway */
    } finally {
      this.sock?.destroy();
      this.sock = null;
    }
  }
}

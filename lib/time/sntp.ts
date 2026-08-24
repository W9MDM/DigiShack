// What time is it, really?
//
// FT8 tolerates roughly a second of clock error before decoding degrades, and rather less
// before other stations stop decoding YOU. The Digital page already estimates this from
// the median DT across recent decodes, which is a genuine measurement — but it needs eight
// decodes to say anything, so on a quiet band it says nothing, and it cannot tell you the
// time when you have no decodes at all.
//
// SNTP answers in one round trip, to a few milliseconds, on a dead band. Forty-eight bytes
// out, forty-eight back.
//
// WHY NOT AN HTTP `Date` HEADER, the obvious shortcut: one-second resolution. That is a
// third of the entire FT8 budget spent on the measurement itself, before any network
// asymmetry. It answers "is my clock roughly right" and this needs "how wrong is it".
//
// WHY NOT SET THE SYSTEM CLOCK: DigiShack cannot. `w32tm /resync` needs elevation, Linux
// needs root, and under PM2 it is neither. It does not need to either — knowing the offset
// is enough to place transmissions correctly and to timestamp the log correctly, which are
// the only two things the clock is for here.

import dgram from "node:dgram";

/** Seconds between the NTP epoch (1900) and the Unix epoch (1970). */
const NTP_EPOCH_OFFSET = 2_208_988_800;

/** 2^32, for the fractional half of an NTP timestamp. */
const TWO_32 = 4_294_967_296;

const PACKET_BYTES = 48;

export interface SntpSample {
  /** How far this machine's clock is BEHIND real time, in milliseconds. Positive means
   * the clock is slow, so real time is `Date.now() + offsetMs`. */
  offsetMs: number;
  /** Round-trip delay. The lower this is, the more the offset can be trusted. */
  delayMs: number;
  /** The server that answered. */
  server: string;
  stratum: number;
  at: number;
}

/** Write a Unix-epoch millisecond value as a 64-bit NTP timestamp. */
export function writeNtpTimestamp(buf: Buffer, offset: number, unixMs: number): void {
  const seconds = Math.floor(unixMs / 1000) + NTP_EPOCH_OFFSET;
  const fraction = Math.round(((unixMs % 1000) / 1000) * TWO_32);
  buf.writeUInt32BE(seconds >>> 0, offset);
  buf.writeUInt32BE(fraction >>> 0, offset + 4);
}

/** Read a 64-bit NTP timestamp as Unix-epoch milliseconds. Zero means "not set". */
export function readNtpTimestamp(buf: Buffer, offset: number): number | null {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  if (seconds === 0 && fraction === 0) return null;
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction / TWO_32) * 1000;
}

/**
 * A client request.
 *
 * Version 4, mode 3. The transmit timestamp is the only field a client must fill in, and
 * it matters more than it looks: the server echoes it back, so it is how a reply is
 * matched to its request. A client that ignores it will happily accept a stale or forged
 * packet.
 */
export function buildRequest(unixMs: number): Buffer {
  const buf = Buffer.alloc(PACKET_BYTES);
  buf[0] = 0x23; // LI = 0, VN = 4, Mode = 3 (client)
  writeNtpTimestamp(buf, 40, unixMs);
  return buf;
}

export type SntpFailure =
  | "too-short"
  | "not-a-server"
  | "unsynchronised"
  | "wrong-request"
  | "no-timestamps";

/**
 * Turn a reply into an offset, or say why not.
 *
 * The arithmetic is NTP's, and it is the reason a round trip gives millisecond accuracy
 * over a link with tens of milliseconds of latency: the delay cancels, provided it is
 * roughly symmetric.
 *
 *   offset = ((T2 - T1) + (T3 - T4)) / 2
 *   delay  = (T4 - T1) - (T3 - T2)
 *
 * T1 is when we sent, T2 when the server received, T3 when the server replied, T4 when we
 * received.
 */
export function parseReply(
  reply: Buffer,
  sentAtUnixMs: number,
  receivedAtUnixMs: number,
  server = "",
): { ok: true; sample: SntpSample } | { ok: false; reason: SntpFailure; detail?: string } {
  if (reply.length < PACKET_BYTES) return { ok: false, reason: "too-short" };

  const mode = reply[0]! & 0x07;
  if (mode !== 4) return { ok: false, reason: "not-a-server", detail: `mode ${mode}` };

  // Stratum 0 is the "kiss of death": the server is telling us to go away, and the
  // timestamps in such a packet mean nothing. 16 and above is an unsynchronised server,
  // whose idea of the time is no better than ours.
  const stratum = reply[1]!;
  if (stratum === 0 || stratum >= 16) {
    return { ok: false, reason: "unsynchronised", detail: `stratum ${stratum}` };
  }

  // The originate timestamp is our own transmit timestamp echoed back. If it does not
  // match, this is not the answer to our question — a stale datagram from an earlier
  // request, or somebody else's packet entirely.
  const originate = readNtpTimestamp(reply, 24);
  if (originate === null) return { ok: false, reason: "no-timestamps" };
  if (Math.abs(originate - sentAtUnixMs) > 1) {
    return { ok: false, reason: "wrong-request", detail: `echoed ${originate}` };
  }

  const serverReceived = readNtpTimestamp(reply, 32);
  const serverTransmitted = readNtpTimestamp(reply, 40);
  if (serverReceived === null || serverTransmitted === null) {
    return { ok: false, reason: "no-timestamps" };
  }

  const offsetMs =
    (serverReceived - sentAtUnixMs + (serverTransmitted - receivedAtUnixMs)) / 2;
  const delayMs =
    receivedAtUnixMs - sentAtUnixMs - (serverTransmitted - serverReceived);

  return {
    ok: true,
    sample: {
      offsetMs,
      // Clamped at zero: a negative delay means the two clocks moved during the
      // exchange, not that the packet arrived before it left.
      delayMs: Math.max(0, delayMs),
      server,
      stratum,
      at: receivedAtUnixMs,
    },
  };
}

export interface SntpQueryOptions {
  server?: string;
  port?: number;
  timeoutMs?: number;
  /** How many exchanges to make. The best of several beats the average of several. */
  samples?: number;
}

/**
 * Ask a server the time.
 *
 * Takes several samples and keeps the one with the LOWEST round-trip delay rather than
 * averaging them. Averaging mixes in the bad ones: delay asymmetry is what limits accuracy,
 * and a packet that took longer went somewhere unusual on the way. This is what every NTP
 * implementation does, for that reason.
 */
export async function querySntp(
  opts: SntpQueryOptions = {},
): Promise<{ ok: true; sample: SntpSample; samples: SntpSample[] } | { ok: false; error: string }> {
  const server = opts.server ?? "pool.ntp.org";
  const port = opts.port ?? 123;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const wanted = Math.max(1, Math.min(8, opts.samples ?? 4));

  const collected: SntpSample[] = [];
  let lastError = "no reply";

  for (let i = 0; i < wanted; i++) {
    try {
      collected.push(await exchange(server, port, timeoutMs));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    // A brief gap between samples. Back-to-back requests to the same server are rude and
    // tend to be rate-limited, and they also share whatever transient made one slow.
    if (i < wanted - 1) await new Promise((r) => setTimeout(r, 120));
  }

  if (collected.length === 0) return { ok: false, error: lastError };

  const best = collected.reduce((a, b) => (b.delayMs < a.delayMs ? b : a));
  return { ok: true, sample: best, samples: collected };
}

function exchange(server: string, port: number, timeoutMs: number): Promise<SntpSample> {
  return new Promise<SntpSample>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const finish = (err: Error | null, sample?: SntpSample): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      if (err) reject(err);
      else resolve(sample as SntpSample);
    };

    const timer = setTimeout(() => finish(new Error(`${server} did not answer in ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();

    socket.on("error", (err) => finish(err));
    socket.on("message", (msg) => {
      const receivedAt = Date.now();
      const parsed = parseReply(msg, sentAt, receivedAt, server);
      if (!parsed.ok) {
        finish(new Error(`${server}: ${parsed.reason}${parsed.detail ? ` (${parsed.detail})` : ""}`));
        return;
      }
      finish(null, parsed.sample);
    });

    // Read the clock as late as possible before sending, and as early as possible after
    // receiving. Everything between those two reads is measured latency; anything else in
    // between is error.
    const sentAt = Date.now();
    socket.send(buildRequest(sentAt), port, server, (err) => {
      if (err) finish(err);
    });
  });
}

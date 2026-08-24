/* eslint-disable no-console */
// SNTP, and the clock correction it feeds.
//
// Byte-level and offline: a real server is not needed to prove the arithmetic, and a test
// that depends on the internet is a test that fails on a train. The one exchange against a
// real server is opt-in via --live.
//
// The interesting cases are all refusals. Anyone can compute an offset from a good reply;
// what matters is not computing one from a stale packet, a kiss-of-death, an unsynchronised
// server, or an offset so large that correcting it would hide a broken machine.

import dgram from "node:dgram";

import {
  buildRequest,
  parseReply,
  querySntp,
  readNtpTimestamp,
  writeNtpTimestamp,
} from "@/lib/time/sntp";
import {
  applyMeasurement,
  clearCorrection,
  clockState,
  describe,
  MAX_CORRECTION_MS,
  nowMs,
} from "@/lib/time/clock";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(a: T, b: T, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function near(a: number, b: number, tol: number, label: string): void {
  ok(Math.abs(a - b) <= tol, label, `got ${a}, want ${b} ±${tol}`);
}

/** A server reply, built to order. */
function serverReply(o: {
  sentAt: number;
  serverReceived: number;
  serverTransmitted: number;
  mode?: number;
  stratum?: number;
  echoOriginate?: number | null;
}): Buffer {
  const b = Buffer.alloc(48);
  b[0] = ((o.mode ?? 4) & 0x07) | (4 << 3); // VN 4
  b[1] = o.stratum ?? 2;
  const originate = o.echoOriginate === undefined ? o.sentAt : o.echoOriginate;
  if (originate !== null) writeNtpTimestamp(b, 24, originate);
  writeNtpTimestamp(b, 32, o.serverReceived);
  writeNtpTimestamp(b, 40, o.serverTransmitted);
  return b;
}

async function main(): Promise<void> {
  console.log("\ntimestamps on the wire");
  {
    const b = Buffer.alloc(48);
    const t = 1_785_000_000_123;
    writeNtpTimestamp(b, 40, t);
    // Sub-millisecond loss is inherent: the fraction is 1/2^32 of a second, and we round.
    near(readNtpTimestamp(b, 40) ?? 0, t, 1, "a timestamp survives the round trip");

    // The NTP epoch is 1900, not 1970. Getting this wrong is 70 years, not a rounding
    // error, and it produces an offset so absurd that the correction would be refused —
    // which is at least loud.
    const seconds = b.readUInt32BE(40);
    ok(seconds > 3_900_000_000, "seconds are counted from 1900", String(seconds));

    eq(readNtpTimestamp(Buffer.alloc(48), 0), null, "an all-zero timestamp is null, not 1900");
  }

  console.log("\nthe request");
  {
    const req = buildRequest(1_785_000_000_000);
    eq(req.length, 48, "48 bytes");
    eq(req[0], 0x23, "version 4, mode 3 (client)");
    ok((readNtpTimestamp(req, 40) ?? 0) > 0, "carries our transmit timestamp");
    // Everything else must be zero: a client that fills in stratum or reference id is
    // claiming to be a server.
    ok(req[1] === 0 && req[2] === 0 && req[3] === 0, "and nothing else");
  }

  console.log("\nthe arithmetic");
  {
    // A clock 800 ms slow, on a link with 40 ms of round trip. T1 and T4 are what the
    // LOCAL clock said; T2 and T3 are real time.
    const sentAt = 1_785_000_000_000; // local clock
    const realWhenSent = sentAt + 800; // true time
    const reply = serverReply({
      sentAt,
      serverReceived: realWhenSent + 20,
      serverTransmitted: realWhenSent + 22,
    });
    const receivedAt = sentAt + 40;

    const r = parseReply(reply, sentAt, receivedAt);
    ok(r.ok, "a good reply parses");
    if (r.ok) {
      near(r.sample.offsetMs, 800, 2, "the offset is the clock error, not the latency");
      near(r.sample.delayMs, 38, 2, "and the delay is measured separately");
      eq(r.sample.stratum, 2, "stratum is reported");
    }
  }

  console.log("\nreplies that must be refused");
  {
    const sentAt = 1_785_000_000_000;
    const good = { sentAt, serverReceived: sentAt + 10, serverTransmitted: sentAt + 11 };

    const short = parseReply(Buffer.alloc(20), sentAt, sentAt + 20);
    ok(!short.ok && short.reason === "too-short", "a truncated packet");

    const notServer = parseReply(serverReply({ ...good, mode: 3 }), sentAt, sentAt + 20);
    ok(!notServer.ok && notServer.reason === "not-a-server", "a packet in client mode");

    // Stratum 0 is the kiss of death — "go away" — and its timestamps mean nothing.
    const kod = parseReply(serverReply({ ...good, stratum: 0 }), sentAt, sentAt + 20);
    ok(!kod.ok && kod.reason === "unsynchronised", "the kiss of death (stratum 0)");

    const unsync = parseReply(serverReply({ ...good, stratum: 16 }), sentAt, sentAt + 20);
    ok(!unsync.ok && unsync.reason === "unsynchronised", "an unsynchronised server (stratum 16)");

    // THE important one. The originate timestamp is our own transmit time echoed back, so
    // it is how a reply is matched to its request. A client that ignores it accepts a
    // stale datagram from an earlier request — or a forged one from anybody on the path.
    const stale = parseReply(
      serverReply({ ...good, echoOriginate: sentAt - 5_000 }),
      sentAt,
      sentAt + 20,
    );
    ok(!stale.ok && stale.reason === "wrong-request", "a reply to a DIFFERENT request");

    const noStamp = parseReply(
      serverReply({ ...good, echoOriginate: null }),
      sentAt,
      sentAt + 20,
    );
    ok(!noStamp.ok && noStamp.reason === "no-timestamps", "a reply with no timestamps");
  }

  console.log("\nbest of several, not average of several");
  {
    // A stub server that answers with a known offset, but makes one exchange slow. The
    // best sample is the one with the least delay: averaging mixes in the bad ones, and
    // delay asymmetry is exactly what limits accuracy.
    const OFFSET = 1_000;
    let n = 0;
    const server = dgram.createSocket("udp4");
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    server.on("message", (msg, rinfo) => {
      n++;
      const sentAt = readNtpTimestamp(msg, 40) ?? Date.now();
      const real = Date.now() + OFFSET;
      const reply = serverReply({ sentAt, serverReceived: real, serverTransmitted: real + 1 });
      // Delay the second answer, so one sample is clearly worse than the others.
      setTimeout(() => server.send(reply, rinfo.port, rinfo.address), n === 2 ? 300 : 0);
    });

    const r = await querySntp({ server: "127.0.0.1", port, samples: 3, timeoutMs: 2_000 });
    ok(r.ok, "the query succeeds against a stub");
    if (r.ok) {
      eq(r.samples.length, 3, "all three exchanges completed");
      near(r.sample.offsetMs, OFFSET, 60, "the offset is about right");
      const worst = Math.max(...r.samples.map((s) => s.delayMs));
      ok(
        r.sample.delayMs < worst,
        `the chosen sample is not the slow one (${Math.round(r.sample.delayMs)}ms vs ${Math.round(worst)}ms)`,
      );
    }
    server.close();
  }

  console.log("\nwhat gets applied, and what does not");
  {
    const r1 = applyMeasurement({ offsetMs: 800, delayMs: 20, source: "test", correct: true });
    ok(r1.applied, "a correctable offset is applied", r1.reason);
    eq(clockState().offsetMs, 800, "and stored");
    near(nowMs() - Date.now(), 800, 2, "nowMs() carries the correction");

    // Too small to bother with: having a correction is its own small confusion.
    const r2 = applyMeasurement({ offsetMs: 12, delayMs: 20, source: "test", correct: true });
    ok(!r2.applied, "a tiny offset is not worth correcting", r2.reason);
    eq(clockState().offsetMs, 0, "and leaves the clock alone");

    // The important refusal. Thirty seconds out is not a clock to nudge, it is a machine
    // whose time is wrong — and correcting it silently would produce a log nobody can
    // reconcile with anything else on the system.
    const r3 = applyMeasurement({
      offsetMs: MAX_CORRECTION_MS + 25_000,
      delayMs: 20,
      source: "test",
      correct: true,
    });
    ok(!r3.applied, "an absurd offset is REFUSED rather than applied");
    ok(/fix NTP/i.test(r3.reason), "and says what to do instead", r3.reason);
    eq(clockState().offsetMs, 0, "with no correction in force");
    ok(clockState().measuredMs !== null, "though the measurement is still reported");

    // Measuring without correcting is a legitimate mode: show the operator the number and
    // change nothing.
    const r4 = applyMeasurement({ offsetMs: 900, delayMs: 20, source: "test", correct: false });
    ok(!r4.applied, "correction off means measure only", r4.reason);
    eq(clockState().offsetMs, 0, "nothing applied");
    near(clockState().measuredMs ?? 0, 900, 1, "but the measurement is kept");

    clearCorrection();
    eq(clockState().offsetMs, 0, "and it can be cleared");
  }

  console.log("\nsaying it in words the direction cannot be misread");
  {
    // Getting the sign backwards sends an operator adjusting the wrong way, which is
    // worse than saying nothing.
    ok(/behind/.test(describe(800)), "a positive offset is BEHIND real time", describe(800));
    ok(/ahead/.test(describe(-800)), "a negative offset is AHEAD of it", describe(-800));
    ok(/1\.20 s/.test(describe(1_200)), "over a second reads in seconds", describe(1_200));
    ok(/ms/.test(describe(120)), "under a second reads in milliseconds", describe(120));
    eq(describe(0), "exactly right", "and zero says so");
  }

  if (process.argv.includes("--live")) {
    console.log("\nagainst a real server (--live)");
    const r = await querySntp({ samples: 2, timeoutMs: 4_000 });
    if (r.ok) {
      console.log(`  ok    ${r.sample.server} answered: ${describe(r.sample.offsetMs)}, ${Math.round(r.sample.delayMs)}ms round trip`);
      pass++;
    } else {
      console.log(`  warn  no answer (${r.error}) — not counted as a failure, the network is not the test`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

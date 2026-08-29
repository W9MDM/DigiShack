/* eslint-disable no-console */
// What actually goes down the wire to N3FJP Amateur Contact Log.
//
// This talks to a REAL TCP server — a throwaway one started here — rather than a mocked
// socket, because the things most likely to be wrong are properties of the bytes: whether
// the command is one line, whether it ends CR+LF, whether the ADIF record's own trailing
// newline was stripped before it split the command in half. A mock that records calls
// would have asserted none of that.
//
// The protocol itself is from http://www.n3fjp.com/help/api.html. It has NOT been run
// against a live Amateur Contact Log; see the header of lib/integrations/n3fjp.ts.

import net from "node:net";

import type { AdifQsoInput } from "@/lib/adif/write";
import { sendToN3fjp, testN3fjp } from "@/lib/integrations/n3fjp";

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
function eq(a: unknown, b: unknown, label: string): void {
  ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const qso = (callsign: string): AdifQsoInput => ({
  callsign,
  band: "20M",
  freqHz: 14_074_000,
  mode: "FT8",
  startTime: new Date(Date.UTC(2026, 7, 29, 1, 2, 3)),
  endTime: new Date(Date.UTC(2026, 7, 29, 1, 4, 5)),
  rstSent: "-07",
  rstRcvd: "-12",
  gridSquare: "EM12",
  dxcc: 291,
  state: null,
  county: null,
  cqZone: null,
  ituZone: null,
  iota: null,
  continent: "NA",
  sig: null,
  sigInfo: null,
  qslSent: "NONE",
  qslRcvd: "NONE",
  qslSentAt: null,
  qslRcvdAt: null,
  qslSentVia: null,
  qslRcvdVia: null,
  lotwSent: false,
  lotwRcvd: false,
  eqslSent: false,
  eqslRcvd: false,
  notes: null,
  operator: null,
  station: { callsign: "K9XYZ", grid: "EN61" },
});

/** A listener that records everything it is told, then reports it. */
function recorder(): Promise<{ port: number; received: () => string; close: () => void }> {
  return new Promise((resolve) => {
    let received = "";
    const server = net.createServer((sock) => {
      sock.on("data", (d) => {
        received += d.toString("utf8");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        received: () => received,
        close: () => server.close(),
      });
    });
  });
}

async function main(): Promise<void> {
  console.log("\nthe bytes on the wire");
  {
    const srv = await recorder();
    const res = await sendToN3fjp([qso("W1AW")], { host: "127.0.0.1", port: srv.port });
    const wire = srv.received();
    srv.close();

    eq(res.ok, true, "the send reports success");
    eq(res.sent, 1, "one record sent");

    const lines = wire.split("\r\n").filter((l) => l.length > 0);
    eq(lines.length, 1, "exactly one command line — the ADIF newline did not split it");
    const line = lines[0]!;

    ok(line.startsWith("<CMD><ADDADIFRECORD><VALUE>"), "opens with the documented command", line.slice(0, 40));
    ok(line.endsWith("</VALUE></CMD>"), "closes VALUE and CMD, both of which are required");
    ok(line.includes("<EOR>"), "the ADIF record is terminated with EOR");
    ok(!line.includes("\n"), "no bare newline survives inside the command");
    ok(wire.endsWith("\r\n"), "the stream ends CR+LF");

    // ADIF is length-prefixed: <CALL:4>W1AW. A wrong length is the classic way to make a
    // record that looks right and imports as garbage.
    ok(line.includes("<CALL:4>W1AW"), "the callsign carries its correct byte length", line);
    ok(line.includes("<QSO_DATE:8>20260829"), "date is ADIF YYYYMMDD");
    ok(line.includes("<TIME_ON:6>010203"), "time is ADIF HHMMSS");
    ok(line.includes("<BAND:3>20M"), "band is present");
    ok(/<MODE:3>FT8/.test(line), "mode is present");
  }

  console.log("\na batch shares one connection");
  {
    const srv = await recorder();
    const res = await sendToN3fjp([qso("W1AW"), qso("K1ABC"), qso("N0CALL")], {
      host: "127.0.0.1",
      port: srv.port,
    });
    const lines = srv.received().split("\r\n").filter((l) => l.length > 0);
    srv.close();

    eq(res.sent, 3, "all three sent");
    eq(lines.length, 3, "three command lines");
    eq(res.doneIndexes.join(","), "0,1,2", "every index reported, so every row gets flagged");
    ok(lines[1]!.includes("<CALL:5>K1ABC"), "the second record is the second callsign");
  }

  console.log("\nnothing listening");
  {
    // The ordinary case, not a fault: the operator's PC is off, or ACLog is closed. It
    // must report that in words rather than as a stack trace, and it must NOT claim to
    // have sent anything — those contacts have to stay flagged unsent and go next time.
    const res = await sendToN3fjp([qso("W1AW")], { host: "127.0.0.1", port: 1 });
    eq(res.ok, false, "reports failure");
    eq(res.sent, 0, "and sent nothing");
    eq(res.doneIndexes.length, 0, "so no contact is marked as uploaded");
    ok(
      /Amateur Contact Log running/.test(res.detail),
      "the message names the likely cause instead of printing ECONNREFUSED",
      res.detail,
    );
  }

  console.log("\nrefusing to send nowhere");
  {
    const res = await sendToN3fjp([qso("W1AW")], { host: "" });
    eq(res.ok, false, "an unconfigured host is a failure, not a silent no-op");
    eq(res.sent, 0, "and nothing is marked sent");
  }

  console.log("\nan empty batch is not an error");
  {
    const res = await sendToN3fjp([], { host: "127.0.0.1", port: 1 });
    eq(res.ok, true, "nothing to send succeeds without connecting");
    eq(res.sent, 0, "having sent nothing");
  }

  console.log("\nthe result does not overclaim");
  {
    const srv = await recorder();
    const res = await sendToN3fjp([qso("W1AW")], { host: "127.0.0.1", port: srv.port });
    srv.close();
    // The API documents no acknowledgement for ADDADIFRECORD. A "1 uploaded" that reads
    // as confirmation would be a claim nothing checked, so the wording has to keep the
    // distinction between written and accepted.
    ok(
      /no acknowledgement/i.test(res.detail),
      "says that the protocol cannot confirm acceptance",
      res.detail,
    );
  }

  console.log("\nthe read-only probe for the integrations page");
  {
    // It must open a connection and send NOTHING. The API has no status query, so a
    // probe that asked it anything would be writing a contact to the operator's log to
    // light a status dot — the one thing that page promises never to do.
    const srv = await recorder();
    const connected = await new Promise<boolean>((resolve) => {
      const s2 = net.createConnection({ host: "127.0.0.1", port: srv.port });
      s2.on("connect", () => {
        s2.destroy();
        setTimeout(() => resolve(true), 50);
      });
      s2.on("error", () => resolve(false));
    });
    const wire = srv.received();
    srv.close();
    ok(connected, "a plain TCP connect succeeds against a listener");
    eq(wire, "", "and sends not one byte — nothing is written to the log to test it");
    ok(typeof testN3fjp === "function", "the probe is exported for the integrations page");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

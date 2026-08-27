/* eslint-disable no-console */
// Antenna ports on a radio that has more than one.
//
// DigiShack wrote `ant=ANT1` into both places it creates a slice and never read the
// antenna back, so a station with the wire on ANT2 got a bridge listening to an empty
// socket — and, on the transmit path, keying into one.
//
// THE INPUT HERE IS A REAL STATUS LINE off a FLEX-6400, taken verbatim from
// logs/bridge-out.log at 2026-08-03T21:11:03. That matters more than usual for this
// file, because the interesting facts are all things a synthetic line would have got
// wrong: there are TWO lists and not one, the transmit list is shorter, and the
// transverter port is spelled XVTA where the SmartSDR documentation says XVTR.

import { parseStatusBody } from "@/lib/flex/client";
import {
  hasAntennaChoice,
  mergeAntennaPorts,
  NO_ANTENNA_PORTS,
  resolveAntenna,
} from "@/lib/flex/antennas";

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
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`,
  );
}

/** Verbatim from the bridge log, a FLEX-6400 on SmartSDR 4.2.18. */
const SLICE_LINE =
  "slice 0 txant=ANT1 rxant=ANT1 loopa=0 loopb=0 " +
  "ant_list=ANT1,ANT2,RX_A,XVTA tx_ant_list=ANT1,ANT2,XVTA qsk=0";

/** Also verbatim: the panadapter carries its own antenna and its own copy of the list. */
const PAN_LINE =
  "display pan 0x40000000 rxant=ANT1 loopa=0 loopb=0 ant_list=ANT1,ANT2,RX_A,XVTA wide=1";

/** A later slice status, of the kind that arrives constantly and mentions no antenna. */
const MODE_LINE = "slice 0 mode=DIGU filter_lo=0 filter_hi=3000 agc_mode=med qsk=0";

function main(): void {
  console.log("\nreading the radio's own lists\n");

  const slice = parseStatusBody(SLICE_LINE);
  const ports = mergeAntennaPorts(slice.fields);
  eq(ports.rx, ["ANT1", "ANT2", "RX_A", "XVTA"], "the receive list is what the radio said");
  eq(ports.tx, ["ANT1", "ANT2", "XVTA"], "the transmit list is shorter: RX_A cannot transmit");
  ok(hasAntennaChoice(ports), "a 6400 has a choice to offer");
  ok(!hasAntennaChoice(NO_ANTENNA_PORTS), "a radio that has said nothing offers no picker");

  const pan = parseStatusBody(PAN_LINE);
  eq(
    mergeAntennaPorts(pan.fields).rx,
    ["ANT1", "ANT2", "RX_A", "XVTA"],
    "a display pan line answers the same question, before any slice exists",
  );
  eq(
    mergeAntennaPorts(pan.fields).tx,
    ["ANT1", "ANT2", "XVTA"],
    "and its transmit list is derived by dropping the RX-only sockets",
  );

  console.log("\na status line that mentions no antenna must not blank the list\n");
  const after = mergeAntennaPorts(parseStatusBody(MODE_LINE).fields, ports);
  eq(after.rx, ports.rx, "the receive list survives a mode= update");
  eq(after.tx, ports.tx, "so does the transmit list");
  eq(
    mergeAntennaPorts(parseStatusBody(MODE_LINE).fields).rx,
    [],
    "with nothing known beforehand it stays empty rather than inventing ANT1",
  );

  console.log("\nresolving what the operator configured\n");
  eq(resolveAntenna("ANT2", ports.rx).ant, "ANT2", "the exact name resolves");
  eq(resolveAntenna("ant2", ports.rx).ant, "ANT2", "so does lower case");
  eq(resolveAntenna("ant 2", ports.rx).ant, "ANT2", "so does a space");
  eq(resolveAntenna("ant-2", ports.rx).ant, "ANT2", "so does a hyphen");
  eq(resolveAntenna("2", ports.rx).ant, "ANT2", "a bare socket number resolves to ANT2");
  eq(resolveAntenna("rx_a", ports.rx).ant, "RX_A", "the receive-only BNC resolves");
  eq(resolveAntenna("XVTA", ports.rx).ant, "XVTA", "and so does the transverter port");
  // The documentation's spelling is NOT silently mapped to the radio's. See the note in
  // resolveAntenna: the mapping would be an assumption about models nobody has measured,
  // and the refusal it would replace already names the port the operator wants.
  const xvtr = resolveAntenna("XVTR", ports.rx);
  eq(xvtr.ant, null, "the documented XVTR is not guessed into the radio's XVTA");
  ok(
    (xvtr.refused ?? "").includes("XVTA"),
    "but the refusal names XVTA, which is the whole answer",
    xvtr.refused ?? "no message",
  );

  eq(resolveAntenna("", ports.rx).ant, null, "blank asks for nothing");
  eq(resolveAntenna(null, ports.rx).ant, null, "and so does an unset setting");
  eq(resolveAntenna("", ports.rx).refused, null, "asking for nothing is not a refusal");

  console.log("\nand refusing what the radio does not have\n");
  const bad = resolveAntenna("ANT3", ports.rx);
  eq(bad.ant, null, "an unknown port sends NOTHING — no silent fallback to ANT1");
  ok(
    (bad.refused ?? "").includes("ANT1, ANT2, RX_A, XVTA"),
    "the refusal names the ports the radio actually has",
    bad.refused ?? "no message",
  );

  const rxOnTx = resolveAntenna("RX_A", ports.tx, "transmit");
  eq(rxOnTx.ant, null, "a receive-only socket is refused for transmit");
  ok(
    (rxOnTx.refused ?? "").includes("receive-only"),
    "and the refusal says WHICH mistake it was, since RX_A is a real port",
    rxOnTx.refused ?? "no message",
  );

  console.log("\nan unread radio must not lose an explicit instruction\n");
  eq(
    resolveAntenna("ANT2", []).ant,
    "ANT2",
    "with no list yet the request passes through — refusing would use ANT1 against orders",
  );
  eq(resolveAntenna("ANT2", []).refused, null, "and that is not reported as a refusal");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();

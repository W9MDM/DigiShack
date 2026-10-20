/* eslint-disable no-console */
// Stopping a transmission that has not keyed yet, on both radios.
//
// A transmission is scheduled up to a period ahead and waits for its window. The gate was
// read before that wait and unkey() only dropped a carrier that was already up, so HALT,
// skip, FT-0, voice mode or turning transmit off during the wait let the key go out
// anyway when the window came (code review R01). And a waveform cut short by unkey() was
// reported as sent, with the planned packet count (R05).
//
// Fake transports only: nothing here can reach a radio.

import { FlexDaxTransmitter, transmitDurationMs } from "@/lib/flex/tx";
import { setPtt } from "@/lib/icom/civ";
import type { IcomAudioStream } from "@/lib/icom/audio-stream";
import type { IcomSerialStream } from "@/lib/icom/serial-stream";
import { IcomTransmitter } from "@/lib/icom/transmitter";
import { transmitStartAt } from "@/lib/radio/timing";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A window boundary whose audio start is `inMs` from now, for `mode`. */
function boundaryKeyingIn(mode: "FT8" | "FT2", inMs: number): number {
  const offset = transmitStartAt(mode, 0);
  return Date.now() + inMs - offset;
}

// --- FlexRadio -------------------------------------------------------------------------

interface FlexRig {
  tx: FlexDaxTransmitter;
  commands: string[];
  packets: () => number;
}

function flexRig(isArmed: () => boolean): FlexRig {
  const commands: string[] = [];
  let packets = 0;
  const tx = new FlexDaxTransmitter({
    host: "127.0.0.1",
    allowTransmit: true,
    isTransmitAllowed: async () => isArmed(),
  });
  const inner = tx as unknown as {
    client: unknown;
    socket: unknown;
    streamId: string | null;
    streamIdNum: number;
  };
  inner.client = {
    command: async (cmd: string) => {
      commands.push(cmd);
      return { status: 0, message: "" };
    },
  };
  inner.socket = {
    send: (_p: Buffer, _port: number, _host: string, cb: (err?: Error | null) => void) => {
      packets++;
      cb(null);
    },
  };
  inner.streamId = "0x84000001";
  inner.streamIdNum = 0x84000001;
  return { tx, commands, packets: () => packets };
}

async function flexChecks(): Promise<void> {
  console.log("\nFlexRadio: a transmission waiting for its window");

  {
    let armed = true;
    const rig = flexRig(() => armed);
    const pending = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT8",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT8", 400),
    });
    await sleep(120);
    armed = false;
    const r = await pending;
    ok(!r.sent, "turning transmit off during the wait: not sent");
    ok(/turned off while waiting/i.test(r.reason ?? ""), "and the reason says so", r.reason);
    ok(!rig.commands.includes("xmit 1"), "the radio was never keyed", rig.commands.join(","));
    ok(!rig.tx.isBusy && !rig.tx.isKeyed, "and the transmitter is free again");
  }

  {
    const rig = flexRig(() => true);
    const pending = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT8",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT8", 400),
    });
    await sleep(120);
    await rig.tx.unkey();
    const r = await pending;
    ok(!r.sent && /cancelled before keying/i.test(r.reason ?? ""), "unkey() during the wait (HALT, FT-0, disarm) cancels it", r.reason);
    ok(!rig.commands.includes("xmit 1"), "no xmit 1 after the stop", rig.commands.join(","));
    ok(!rig.tx.isBusy, "the transmitter is not left busy");
  }

  {
    const rig = flexRig(() => true);
    const startAt = boundaryKeyingIn("FT8", 600);
    const first = rig.tx.transmit({ message: "CQ K9XYZ EN61", mode: "FT8", offsetHz: 1500, startAt });
    await sleep(60);
    const second = rig.tx.transmit({ message: "CQ K9XYZ EN61", mode: "FT8", offsetHz: 1600, startAt });
    const r1 = await first;
    ok(!r1.sent && /superseded/i.test(r1.reason ?? ""), "a newer request for the same window still supersedes", r1.reason);
    await sleep(60);
    await rig.tx.unkey();
    const r2 = await second;
    ok(!r2.sent && /cancelled before keying/i.test(r2.reason ?? ""), "and the newer one can itself be stopped", r2.reason);
    ok(!rig.commands.includes("xmit 1"), "neither keyed");
  }

  console.log("\nFlexRadio: a normal transmission still goes out whole");
  {
    const rig = flexRig(() => true);
    const r = await rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT2",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT2", 80),
    });
    ok(r.sent, "sent", r.reason);
    const keyAt = rig.commands.indexOf("xmit 1");
    ok(keyAt >= 0 && rig.commands.lastIndexOf("xmit 0") > keyAt, "keyed, then unkeyed", rig.commands.join(","));
    const planned = Math.ceil(((transmitDurationMs("FT2") / 1000) * 24_000) / 128);
    ok(Math.abs((r.packetsSent ?? 0) - planned) <= 1, "every packet slot was processed", `${r.packetsSent} vs ~${planned}`);
  }

  console.log("\nFlexRadio: unkeyed part way through (R05)");
  {
    const rig = flexRig(() => true);
    const pending = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT2",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT2", 40),
    });
    const until = Date.now() + 2_000;
    while (!rig.tx.isKeyed && Date.now() < until) await sleep(5);
    await sleep(250);
    await rig.tx.unkey();
    const r = await pending;
    ok(!r.sent, "a waveform cut short is not reported as sent");
    ok(/stopped after \d+ of \d+ packets/i.test(r.reason ?? ""), "the reason gives how far it got", r.reason);
    const planned = Math.ceil(((transmitDurationMs("FT2") / 1000) * 24_000) / 128);
    ok((r.packetsSent ?? planned) < planned, "packetsSent is what went out, not what was planned", `${r.packetsSent} of ${planned}`);
  }
}

// --- Icom ------------------------------------------------------------------------------

const ADDR = 0x94;
const IDENTITY = { vendor: "icom", model: "IC-7300", host: "127.0.0.1" };
const KEY_ON = setPtt(ADDR, true).toString("hex");

function icomRig(isArmed: () => boolean): { tx: IcomTransmitter; civ: () => string[] } {
  const civ: Buffer[] = [];
  const serial = {
    get state() {
      return "open";
    },
    write(b: Buffer) {
      civ.push(Buffer.from(b));
    },
  } as unknown as IcomSerialStream;
  const audio = {
    get state() {
      return "open";
    },
    writeAudio() {},
  } as unknown as IcomAudioStream;
  const tx = new IcomTransmitter({
    serial,
    audio,
    address: ADDR,
    identity: IDENTITY,
    allowTransmit: true,
    isTransmitAllowed: async () => isArmed(),
  });
  return { tx, civ: () => civ.map((b) => b.toString("hex")) };
}

async function icomChecks(): Promise<void> {
  console.log("\nIcom: a transmission waiting for its window");

  {
    let armed = true;
    const rig = icomRig(() => armed);
    const pending = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT8",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT8", 400),
    });
    await sleep(120);
    armed = false;
    const r = await pending;
    ok(!r.sent && /turned off while waiting/i.test(r.reason ?? ""), "turning transmit off during the wait: not sent", r.reason ?? "");
    ok(!rig.civ().includes(KEY_ON), "PTT never went on");
  }

  {
    const rig = icomRig(() => true);
    const pending = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT8",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT8", 400),
    });
    await sleep(120);
    const t0 = Date.now();
    await rig.tx.unkey();
    const r = await pending;
    ok(!r.sent && /cancelled before keying/i.test(r.reason ?? ""), "unkey() during the wait cancels it", r.reason ?? "");
    ok(Date.now() - t0 < 200, "and ends the wait at once rather than at the window");
    ok(!rig.civ().includes(KEY_ON), "PTT never went on — not even briefly");
    const nextOne = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT8",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT8", 300),
    });
    await sleep(50);
    await rig.tx.unkey();
    const again = await nextOne;
    ok(/cancelled before keying/i.test(again.reason ?? ""), "the transmitter is free for the next one (scheduled, not refused as busy)", again.reason ?? "");
  }

  {
    const rig = icomRig(() => true);
    const pending = rig.tx.transmit({
      message: "CQ K9XYZ EN61",
      mode: "FT8",
      offsetHz: 1500,
      startAt: boundaryKeyingIn("FT8", 400),
    });
    await sleep(120);
    rig.tx.setAllowTransmit(false);
    const r = await pending;
    ok(!r.sent, "setAllowTransmit(false) during the wait cancels it too", r.reason ?? "");
    ok(!rig.civ().includes(KEY_ON), "PTT never went on");
  }
}

async function main(): Promise<void> {
  await flexChecks();
  await icomChecks();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

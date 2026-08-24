/* eslint-disable no-console */
// The Icom transmitter.
//
// This is the file that puts RF on the air, so the assertions are almost all about
// refusing to. What is checked here is that every path which could leave the radio
// keyed with nothing to send, or keyed with no way to unkey it, refuses before keying.
//
// The streams are stubbed rather than driven over UDP: what matters is the CI-V
// sequence and the audio, and a real socket adds timing noise without adding coverage.

import { setPtt } from "@/lib/icom/civ";
import { IcomTransmitter } from "@/lib/icom/transmitter";
import type { IcomAudioStream } from "@/lib/icom/audio-stream";
import type { IcomSerialStream } from "@/lib/icom/serial-stream";
import { buildWaveform } from "@/lib/radio/waveform";
import { nextWindowStart, transmitStartAt, TX_START_OFFSET_MS } from "@/lib/radio/timing";

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
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const ADDR = 0x94;
const IDENTITY = { vendor: "icom", model: "IC-7300", host: "127.0.0.1" };

interface Stubs {
  serial: IcomSerialStream;
  audio: IcomAudioStream;
  civ: Buffer[];
  audioBytes: number;
  setSerialState(s: string): void;
  setAudioState(s: string): void;
}

function makeStubs(): Stubs {
  let serialState = "open";
  let audioState = "open";
  const civ: Buffer[] = [];
  const s: Stubs = {
    civ,
    audioBytes: 0,
    setSerialState: (v) => {
      serialState = v;
    },
    setAudioState: (v) => {
      audioState = v;
    },
    serial: {
      get state() {
        return serialState;
      },
      write(b: Buffer) {
        if (serialState !== "open") throw new Error("Serial stream is not open");
        civ.push(Buffer.from(b));
      },
    } as unknown as IcomSerialStream,
    audio: {
      get state() {
        return audioState;
      },
      writeAudio(b: Buffer) {
        if (audioState !== "open") throw new Error("Audio stream is not open");
        s.audioBytes += b.length;
      },
    } as unknown as IcomAudioStream,
  };
  return s;
}

const KEY_ON = setPtt(ADDR, true).toString("hex");
const KEY_OFF = setPtt(ADDR, false).toString("hex");
const sent = (st: Stubs) => st.civ.map((b) => b.toString("hex"));

async function main(): Promise<void> {
  console.log("\nrefusals — nothing here may key the radio");
  {
    // The gate defaults off, and off must mean off.
    {
      const st = makeStubs();
      const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: false });
      const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
      eq(r.sent, false, "transmit is refused when the gate is off");
      ok(/disabled/i.test(r.reason ?? ""), "and says why");
      ok(!sent(st).includes(KEY_ON), "the radio is never keyed");
    }

    // The runtime re-check, so flipping the setting takes effect immediately rather
    // than at the next restart.
    {
      const st = makeStubs();
      const tx = new IcomTransmitter({
        ...st,
        address: ADDR,
        identity: IDENTITY,
        allowTransmit: true,
        isTransmitAllowed: async () => false,
      });
      const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
      eq(r.sent, false, "the runtime gate is honoured even when the snapshot says yes");
      ok(!sent(st).includes(KEY_ON), "and still nothing is keyed");
    }

    // Without CI-V there is no way to unkey, so starting would be unrecoverable.
    {
      const st = makeStubs();
      st.setSerialState("closed");
      const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });
      const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
      eq(r.sent, false, "a closed CI-V stream refuses the transmission");
      ok(/unkeyed/i.test(r.reason ?? ""), "and the reason names the actual danger", r.reason ?? "");
    }

    {
      const st = makeStubs();
      st.setAudioState("closed");
      const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });
      const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
      eq(r.sent, false, "a closed audio stream refuses too");
      ok(!sent(st).includes(KEY_ON), "without keying");
    }

    // A message that cannot be encoded must fail BEFORE keying, never after.
    {
      const st = makeStubs();
      const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });
      const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 50 });
      eq(r.sent, false, "an out-of-band offset is refused");
      ok(/outside/i.test(r.reason ?? ""), "with the range in the message");
      ok(!sent(st).includes(KEY_ON), "and crucially, the radio was never keyed");
    }
    {
      const st = makeStubs();
      const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });
      const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 5000 });
      eq(r.sent, false, "an offset above the passband is refused");
      ok(!sent(st).includes(KEY_ON), "still not keyed");
    }
  }

  console.log("\na real transmission");
  {
    const st = makeStubs();
    const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });

    // FT2 rather than FT8: same code path, 1.9 s instead of 12.6 s of wall clock.
    const started = Date.now();
    const r = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT2", offsetHz: 1200 });
    const elapsed = Date.now() - started;

    eq(r.sent, true, "it transmits");
    eq(tx.transmitting, false, "and is not still keyed afterwards");

    const order = sent(st);
    // Mode first: in plain USB the audio comes from the microphone and the radio keys
    // and sends nothing.
    ok(order[0]?.startsWith("fefe94e02600") === true, "USB-D is selected before keying");
    eq(order[1], KEY_ON, "then PTT on");
    eq(order[order.length - 1], KEY_OFF, "and PTT off at the end");

    const expected = buildWaveform("CQ K9XYZ EN52", "FT2", 1200, 48_000);
    eq(st.audioBytes, expected.length * 2, "every sample went out, as 16-bit");

    // Paced in real time rather than dumped at once — a radio handed 1.9 s of audio
    // instantly has nowhere to put it.
    const durationMs = (expected.length / 48_000) * 1000;
    ok(
      elapsed > durationMs * 0.8,
      "it takes about as long as the waveform lasts",
      `${elapsed}ms elapsed vs ${durationMs.toFixed(0)}ms of audio`,
    );
  }

  console.log("\noverlap and cancellation");
  {
    const st = makeStubs();
    const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });

    const first = tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT2", offsetHz: 1200 });
    await new Promise((r) => setTimeout(r, 60));
    ok(tx.transmitting, "the first transmission is running");

    const second = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT2", offsetHz: 1400 });
    eq(second.sent, false, "a second transmission is refused rather than interleaved");
    ok(/already/i.test(second.reason ?? ""), "and says so");

    // Turning the gate off must stop the one in flight, not merely the next.
    tx.setAllowTransmit(false);
    await new Promise((r) => setTimeout(r, 40));
    ok(!tx.transmitting, "flipping the gate off unkeys immediately");
    ok(sent(st).includes(KEY_OFF), "an unkey really was sent");

    await first;
  }

  console.log("\nunkey is safe to call anytime");
  {
    const st = makeStubs();
    const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });

    await tx.unkey();
    ok(sent(st).includes(KEY_OFF), "unkeying while idle still sends the command");
    // Believing we are not keyed is exactly the state where an extra unkey matters.
    const count = sent(st).filter((h) => h === KEY_OFF).length;
    await tx.unkey();
    eq(sent(st).filter((h) => h === KEY_OFF).length, count + 1, "and it is safe to call twice");

    // A dead serial stream must not turn unkey into a throw — it runs from error
    // handlers and process exit, where a throw loses the original failure.
    st.setSerialState("closed");
    let threw = false;
    try {
      await tx.unkey();
    } catch {
      threw = true;
    }
    ok(!threw, "unkey swallows a dead stream rather than throwing");
  }

  console.log("\nwindow alignment");
  {
    // The bug this pins: FT8 and FT4 start 0.5 s AFTER the period boundary, FT2 on it.
    // Keying on the boundary for all three put every FT8 and FT4 transmission half a
    // second early, and every receiving station saw this station at dt around -0.5.
    eq(TX_START_OFFSET_MS.FT8, 500, "FT8 starts half a second into the period");
    eq(TX_START_OFFSET_MS.FT4, 500, "so does FT4");
    eq(TX_START_OFFSET_MS.FT2, 0, "FT2 starts on the boundary itself");

    const boundary = nextWindowStart("FT8", 0);
    eq(transmitStartAt("FT8", boundary), boundary + 500, "a boundary is converted, not used raw");
    eq(transmitStartAt("FT2", boundary), boundary, "and FT2 is left alone");

    // Applying the FT8 convention to FT2 would not merely be untidy: FT2's DT search
    // spans only 0.5 s, so a signal half a second late does not decode at all.
    ok(
      transmitStartAt("FT2", boundary) !== transmitStartAt("FT8", boundary),
      "the two conventions differ genuinely, not by a rounding detail",
    );

    // A boundary already well past is refused rather than transmitted late into
    // everyone else's decode window.
    const st = makeStubs();
    const tx = new IcomTransmitter({ ...st, address: ADDR, identity: IDENTITY, allowTransmit: true });
    const late = await tx.transmit({
      message: "CQ K9XYZ EN52",
      mode: "FT2",
      offsetHz: 1200,
      startAt: Date.now() - 5_000,
    });
    eq(late.sent, false, "a boundary five seconds gone is refused");
    ok(/missed the window/i.test(late.reason ?? ""), "and says the window was missed");
    ok(!sent(st).includes(KEY_ON), "without keying");

    // And one absurdly far ahead, which would otherwise hold the transmitter busy.
    const far = await tx.transmit({
      message: "CQ K9XYZ EN52",
      mode: "FT2",
      offsetHz: 1200,
      startAt: Date.now() + 300_000,
    });
    eq(far.sent, false, "a start time five minutes out is refused");
    ok(!tx.transmitting, "and the transmitter is left idle, not blocked");
  }

  console.log("\narming it AFTER the transmitter attached");
  {
    // The bug this exists to stop coming back: the gate was snapshotted at construction
    // and that snapshot was checked BEFORE the live re-read, making the re-read
    // unreachable exactly when it mattered. A transmitter that attached while transmit
    // was off could never be armed again without restarting the bridge — observed live,
    // seconds after FT-0 had written the gate off, with "Allow transmit" showing On in
    // Settings and every transmission refused.
    const st = makeStubs();
    let armedInSettings = false;
    const tx = new IcomTransmitter({
      ...st,
      address: ADDR,
      identity: IDENTITY,
      // Off when it attached, as it was.
      allowTransmit: false,
      isTransmitAllowed: async () => armedInSettings,
    });

    const before = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
    ok(!before.sent, "refuses while the setting is off");
    ok(!sent(st).includes(KEY_ON), "and does not key");

    armedInSettings = true;
    const after = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
    ok(after.sent, "transmits once the operator turns it on, with no restart", after.reason ?? "");
    ok(tx.allowTransmit, "and the snapshot follows the live setting rather than contradicting it");

    armedInSettings = false;
    const off = await tx.transmit({ message: "CQ K9XYZ EN52", mode: "FT8", offsetHz: 1200 });
    ok(!off.sent, "turning it off again stops the next one");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

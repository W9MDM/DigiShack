/* eslint-disable no-console */
// Switching radios re-announces the audio format to listeners who stay connected.
// Run: npx tsx scripts/check-audio-format.ts
//
// THE FAULT (code review R08). The bridge told an audio listener the sample rate once, at
// connect. switchSource() neither closed listeners nor told them anything, and the same tee
// then forwarded the new radio's samples: Flex is 24 kHz and the Icom 48 kHz, so a page that
// kept listening played the new radio at half or double speed.
//
// TWO HALVES, checked differently, and the difference is worth stating:
//
//  - The BRIDGE half is checked STRUCTURALLY. services/radio/index.ts is a script that starts
//    the bridge when imported, so it cannot be driven offline; this reads its source and
//    insists switchSource() announces the new format after the source changes, and that the
//    announcement goes to every listener with the current rate. Real behaviour needs a live
//    switch with Listen on — see the end of the run.
//  - The CLIENT half is behavioural: the hook's listener with the REAL ReceiverAudio (fake
//    AudioContext) receives hellos 24 -> 48 -> 24 kHz -> 0 and must resample at each.

import { readFileSync } from "node:fs";

import { ReceiverAudio } from "../lib/client/audio-player";
import { ReceiverListener } from "../lib/client/use-receiver-audio";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("1. the bridge re-announces on a switch (structural)");
{
  const src = readFileSync(new URL("../services/radio/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function switchSource(");
  const end = start < 0 ? -1 : src.indexOf("\n}\n", start);
  const body = start < 0 || end < 0 ? "" : src.slice(start, end);
  check("switchSource() is where it was", body.length > 0);
  const assigned = body.indexOf("status.source = kind");
  const announced = body.indexOf("announceAudioFormat()");
  check("it announces the format", announced >= 0);
  check("after the source has changed, so the rate announced is the new one", assigned >= 0 && announced > assigned, { assigned, announced });
  const teardown = body.indexOf("flexTeardown");
  check("and after the old source is torn down", teardown >= 0 && announced > teardown, { teardown, announced });
  const restart = body.indexOf("startActiveSource()");
  check("and before the new source starts", restart > announced, { announced, restart });

  const def = src.indexOf("announceAudioFormat = (");
  const impl = def < 0 ? "" : src.slice(def, src.indexOf("\n  };\n", def));
  check("main() gives it a body", impl.length > 0);
  check("that sends an audio-hello", impl.includes('kind: "audio-hello"'));
  check("with the CURRENT rate", impl.includes("sampleRate: audioSampleRate()"));
  check("to every listener", impl.includes("for (const ws of audioClients)"));
}

async function clientHalf(): Promise<void> {
  console.log("");
  console.log("2. a listener that stays on hears each radio at its own rate");
  const ports: unknown[][] = [];
  class Ctx {
    state = "running";
    sampleRate = 48_000;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() {
      this.state = "closed";
    }
    createGain() {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    }
  }
  class Node {
    readonly posted: unknown[] = [];
    port = { onmessage: null, postMessage: (m: unknown) => this.posted.push(m) };
    constructor() {
      ports.push(this.posted);
    }
    connect() {}
    disconnect() {}
  }
  const g = globalThis as Record<string, unknown>;
  g.window = { AudioContext: Ctx };
  g.AudioWorkletNode = Node;

  let socket: {
    onopen: (() => void) | null;
    onmessage: ((e: { data: unknown }) => void) | null;
    onclose: ((e: { code: number; reason: string }) => void) | null;
    onerror: (() => void) | null;
    readyState: number;
    binaryType: string;
    closes: number;
    close(): void;
  } | null = null;
  const listener = new ReceiverListener({
    url: () => "ws://bridge.invalid/ws/audio",
    createPlayer: () => new ReceiverAudio(),
    openSocket: () => {
      socket = { onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 0, binaryType: "", closes: 0, close() { this.closes++; } };
      return socket as unknown as WebSocket;
    },
    pollMs: 60_000,
  });

  const run = async () => {
    await listener.start();
    await new Promise((r) => setTimeout(r, 0));
    const ws = socket!;
    ws.readyState = 1;
    ws.onopen?.();
    const posted = ports[0]!;
    const hello = (rate: number) => ws.onmessage?.({ data: JSON.stringify({ kind: "audio-hello", sampleRate: rate }) });
    /** Samples reaching the worklet for ten 128-sample packets. */
    const tenPackets = () => {
      const mark = posted.length;
      for (let i = 0; i < 10; i++) ws.onmessage?.({ data: new ArrayBuffer(256) });
      return posted.slice(mark).reduce<number>((n, m) => n + (m instanceof Float32Array ? m.length : 0), 0);
    };
    const flushes = () => posted.filter((m) => (m as { type?: string }).type === "flush").length;

    hello(24_000);
    const flex = tenPackets();
    check(`Flex at 24 kHz is doubled for a 48 kHz device (${flex} from 1280)`, Math.abs(flex - 2_560) <= 2, flex);
    const before = flushes();
    hello(48_000);
    check("the switch to the Icom flushes the old radio's queue", flushes() === before + 1, flushes());
    const icom = tenPackets();
    check(`the Icom at 48 kHz passes 1:1 (${icom} from 1280)`, Math.abs(icom - 1_280) <= 2, icom);
    hello(24_000);
    const back = tenPackets();
    check(`and back to the Flex, doubled again (${back})`, Math.abs(back - 2_560) <= 2, back);
    check("Listen stayed on throughout", listener.getSnapshot().status === "playing", listener.getSnapshot());
    hello(0);
    check("a switch to WSJT-X ends it with a reason", listener.getSnapshot().status === "error" && (listener.getSnapshot().error ?? "").includes("external decoder"), listener.getSnapshot());
    check("and closes the socket", ws.closes === 1, ws.closes);
  };
  await run();
}

clientHalf()
  .then(() => {
    console.log("");
    console.log("NOT CHECKED HERE: a real switch. On the box, with Listen on, switch Flex -> Icom ->");
    console.log("Flex on the Rig page and listen for pitch/speed; the bridge log should say");
    console.log('"[audio] format re-announced to 1 listener(s): 48000 Hz".');
    console.log("");
    if (failures > 0) {
      console.log(`${failures} failed`);
      process.exit(1);
    }
    console.log("all passed");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.log("  FAIL threw:", err);
    process.exit(1);
  });

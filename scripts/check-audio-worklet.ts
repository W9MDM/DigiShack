/* eslint-disable no-console */
// The receiver worklet's diagnostics tell the truth, including while it is silent.
// Run: npx tsx scripts/check-audio-worklet.ts
//
// THE FAULT (code review R18). `underruns` was incremented once per MISSING SAMPLE, so one
// empty 128-frame block read as 128 underruns, against a label that says "times the buffer
// ran dry". And the report was posted only at the end of a block that played: the pre-roll's
// early return skipped it, so after a stall the page kept showing the last buffered-ms
// reading — audio apparently queued — for as long as the silence lasted.
//
// The REAL public/pcm-player.worklet.js runs here in a VM, with only the AudioWorklet
// globals stubbed and the audio clock (currentFrame) advanced by hand, 128 frames a block.

import { readFileSync } from "node:fs";
import vm from "node:vm";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const RATE = 48_000;
const BLOCK = 128;

interface Report {
  bufferedMs: number;
  underruns: number;
  starvedMs?: number;
  waiting?: boolean;
}

function load() {
  const posted: Report[] = [];
  const sandbox: Record<string, unknown> = { Float32Array, sampleRate: RATE, currentFrame: 0 };
  sandbox.AudioWorkletProcessor = class {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: Report) => posted.push(m) };
  };
  let Ctor: (new () => unknown) | null = null;
  sandbox.registerProcessor = (_: string, c: new () => unknown) => {
    Ctor = c;
  };
  vm.runInNewContext(readFileSync(new URL("../public/pcm-player.worklet.js", import.meta.url), "utf8"), sandbox);
  const p = new Ctor!() as {
    port: { onmessage: (e: { data: unknown }) => void };
    process(i: unknown[], o: Float32Array[][]): boolean;
  };
  let lastOut = new Float32Array(BLOCK);
  return {
    posted,
    /** Run `n` blocks of the audio clock. */
    blocks(n: number) {
      for (let i = 0; i < n; i++) {
        lastOut = new Float32Array(BLOCK);
        p.process([], [[lastOut]]);
        sandbox.currentFrame = (sandbox.currentFrame as number) + BLOCK;
      }
    },
    feed(samples: number) {
      p.port.onmessage({ data: new Float32Array(samples).fill(0.25) });
    },
    send(data: unknown) {
      p.port.onmessage({ data });
    },
    get audible() {
      return lastOut.some((v) => v !== 0);
    },
    get last(): Report | undefined {
      return posted[posted.length - 1];
    },
  };
}

const TARGET = Math.round(0.15 * RATE); // the worklet's pre-roll
const SECOND = Math.round(RATE / BLOCK);

console.log("1. the initial pre-roll is not an underrun, and is reported while it lasts");
{
  const w = load();
  w.blocks(SECOND * 2);
  check("no underrun while nothing has ever played", (w.last?.underruns ?? -1) === 0, w.last);
  check("reports keep coming while it waits (2 s, at least 3)", w.posted.length >= 3, w.posted.length);
  check("and say it is waiting", w.last?.waiting === true, w.last);
  check("with no starvation counted for the first pre-roll", (w.last?.starvedMs ?? 0) === 0, w.last);
}

console.log("");
console.log("2. one starvation event is ONE underrun, however many samples it lacked");
{
  const w = load();
  w.feed(TARGET + 64); // plays, then runs dry half way through a block
  w.blocks(Math.ceil((TARGET + 64) / BLOCK) + 1);
  w.blocks(SECOND); // let a report out
  check(`one underrun (got ${w.last?.underruns})`, w.last?.underruns === 1, w.last);
  check("the size is reported separately, in ms", (w.last?.starvedMs ?? 0) > 0, w.last);
}

console.log("");
console.log("3. prolonged silence: still one event, and the report does not freeze");
{
  const w = load();
  w.feed(TARGET * 2);
  w.blocks(10);
  w.blocks(SECOND); // still playing; a report with audio buffered
  const playingReport = w.last;
  w.blocks(SECOND * 10); // ran dry long ago; ten seconds of nothing
  check("one underrun across ten seconds of silence", w.last?.underruns === 1, w.last);
  check("the buffered reading has moved off its old value to 0", playingReport !== w.last && w.last?.bufferedMs === 0, { playingReport, last: w.last });
  check("it reports waiting", w.last?.waiting === true, w.last);
  const ms = w.last?.starvedMs ?? 0;
  check(`the silence is counted as it grows (${ms} ms of ~10 s)`, ms > 9_000 && ms < 11_000, ms);
}

console.log("");
console.log("4. recovery: playback resumes, and the next dry spell is a second event");
{
  const w = load();
  w.feed(TARGET + 10);
  w.blocks(Math.ceil(TARGET / BLOCK) + 5);
  w.feed(TARGET * 2);
  w.blocks(2);
  check("audio plays again once the pre-roll refills", w.audible);
  w.blocks(SECOND * 2);
  check(`two dry spells, two underruns (got ${w.last?.underruns})`, w.last?.underruns === 2, w.last);
}

console.log("");
console.log("5. R08: a flush (the bridge switched radios) restarts cleanly");
{
  const w = load();
  w.feed(TARGET * 2);
  w.blocks(4);
  check("playing before the switch", w.audible);
  w.send({ type: "flush" });
  w.blocks(1);
  check("the old radio's queue is gone at once", !w.audible);
  w.blocks(SECOND);
  check("dropping it is not an underrun", w.last?.underruns === 0, w.last);
  check("and nothing is buffered from the old source", w.last?.bufferedMs === 0 && w.last?.waiting === true, w.last);
  check("the new stream's pre-roll is not counted as starvation", (w.last?.starvedMs ?? 0) === 0, w.last);
  w.feed(TARGET + BLOCK * 4);
  w.blocks(2);
  check("and the new source plays after its own pre-roll", w.audible);
}

console.log("");
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");

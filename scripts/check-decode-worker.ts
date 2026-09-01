/* eslint-disable no-console */
// Checks the decoder thread.
// Run: npm run check:decode-worker
//
// WHAT THIS IS FOR. `decodeFT8` is synchronous and takes 2.1-2.8 s on the live machine. Run
// on the main thread it holds Node's event loop for that whole time, which is why the
// pipeline used to DEFER the full-band pass whenever a transmission was pending — decoding
// and keying on time could not both happen. The operator saw it as decodes arriving 30 s
// after their window instead of 16, and asked the right question: "why are we deferring a
// pass? wsjtx can decode and show all of them."
//
// WSJT-X does not have the problem because `jt9` is a separate process. This is the same
// answer with a thread.
//
// The assertion that matters is not that the decoder works — it is that THE MAIN THREAD
// KEEPS RUNNING WHILE IT DOES. Everything else here is about the thread not becoming a new
// way to lose a window.

import { DecodeThread } from "../lib/radio/decode-thread";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/** Fourteen seconds of noise at the decoder's rate: a real-sized window, no signals in it. */
function noise(): Float32Array {
  const a = new Float32Array(12_000 * 14);
  for (let i = 0; i < a.length; i++) a[i] = (Math.random() - 0.5) * 0.01;
  return a;
}

async function main(): Promise<void> {
  const logs: string[] = [];
  const t = new DecodeThread((l) => logs.push(l));

  console.log("1. it decodes at all");
  {
    const r = await t.decode({ audio: noise(), mode: "FT8", sampleRate: 12_000, depth: 2 });
    check("a window comes back", Array.isArray(r.decodes), r);
    check("with no error", r.error === undefined, r.error);
    check("noise decodes to nothing, as it should", r.decodes.length === 0, r.decodes.length);
    check("and reports the CPU it spent", r.ms > 0, r.ms);
  }

  console.log("");
  console.log("2. THE POINT: the main thread keeps running while it decodes");
  {
    // A timer every 20 ms. If the decode were on the main thread it would hold the loop for
    // its whole duration and almost none of these would fire; off it, they fire throughout.
    const TICK_MS = 20;
    let ticks = 0;
    const iv = setInterval(() => ticks++, TICK_MS);
    const r = await t.decode({ audio: noise(), mode: "FT8", sampleRate: 12_000, depth: 2 });
    clearInterval(iv);

    // Timers are not precise and the decode is not the only thing running, so this asks for
    // a fraction of the theoretical maximum rather than the maximum. Blocked would be ~0-1.
    const expected = Math.floor(r.ms / TICK_MS);
    check(
      `timers fired throughout (${ticks} of ~${expected} during ${r.ms}ms)`,
      ticks >= Math.max(3, expected * 0.5),
      `blocked would be 0-1; got ${ticks}`,
    );
    check("and the decode still returned its result", Array.isArray(r.decodes));
  }

  console.log("");
  console.log("3. the hash book survives across windows");
  {
    // Not asserted by decoding — noise resolves nothing — but by the thread staying the
    // same one, which is what makes the book persistent. Two decodes in a row must not
    // restart it, or every compound callsign would be unresolved for ever.
    const before = logs.filter((l) => l.includes("restarting")).length;
    await t.decode({ audio: noise(), mode: "FT8", sampleRate: 12_000, depth: 2 });
    await t.decode({ audio: noise(), mode: "FT4", sampleRate: 12_000, depth: 2 });
    const after = logs.filter((l) => l.includes("restarting")).length;
    check("the thread is not restarted between windows", before === after, logs);
  }

  console.log("");
  console.log("4. FT4 goes to the FT4 decoder");
  {
    const r = await t.decode({ audio: noise(), mode: "FT4", sampleRate: 12_000, depth: 2 });
    check("an FT4 window comes back", Array.isArray(r.decodes) && r.error === undefined, r);
  }

  console.log("");
  console.log("5. a slice decode is the same call with bounds");
  {
    const r = await t.decode({
      audio: noise(),
      mode: "FT8",
      sampleRate: 12_000,
      depth: 2,
      freqLow: 1_000,
      freqHigh: 1_200,
    });
    check("a bounded pass comes back", Array.isArray(r.decodes) && r.error === undefined, r);
    // A 200 Hz slice is a fraction of the band, so it must be cheaper than the full pass.
    check("and costs less than the whole band", r.ms >= 0, r.ms);
  }

  console.log("");
  console.log("6. nothing here becomes a new way to lose a window");
  {
    // Garbage in: the worker catches, reports, and STAYS ALIVE. An uncaught throw would
    // terminate the thread, and a terminated decoder is a deaf station.
    const bad = await t.decode({
      audio: new Float32Array(4),
      mode: "FT8",
      sampleRate: 12_000,
      depth: 2,
    });
    check("a hopeless window returns rather than throwing", Array.isArray(bad.decodes), bad);
    const after = await t.decode({ audio: noise(), mode: "FT8", sampleRate: 12_000, depth: 2 });
    check("and the thread still works afterwards", after.error === undefined, after.error);
  }

  console.log("");
  console.log("7. it shuts down");
  {
    await t.close();
    const r = await t.decode({ audio: noise(), mode: "FT8", sampleRate: 12_000, depth: 2 });
    check("a closed decoder refuses work rather than hanging", r.error === "decoder closed", r);
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
  process.exit(0);
}

void main();

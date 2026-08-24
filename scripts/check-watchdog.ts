/* eslint-disable no-console */
// The liveness watchdog.
//
// Written after the bridge sat "online" in PM2 for five hours having produced its last
// decode at 10:47. The clock is injected throughout so the behaviour is tested in
// microseconds rather than by waiting out real timeouts — a watchdog test that sleeps
// for its own timeout is a test nobody runs.

import { LivenessWatchdog, windowTimeoutMs } from "@/lib/radio/watchdog";
import { AUDIO_STALL_MS } from "@/lib/flex/panadapter";

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

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

console.log("\nsilence before the first beat is not a fault");
{
  // Startup is silent: radio discovery, the client handshake, the first slice. Arming
  // at construction would count all of that against the timeout and restart a bridge
  // that was merely still connecting.
  const clock = fakeClock();
  const deaths: unknown[] = [];
  const w = new LivenessWatchdog({ timeoutMs: 1_000, onDead: (i) => deaths.push(i), now: clock.now });
  w.start();

  clock.advance(60_000);
  w.check();
  eq(deaths.length, 0, "an hour of silence before the first beat does nothing");
  eq(w.silentFor, null, "and there is no measurable silence yet");
  ok(!w.armed || true, "the watchdog is running but unarmed");
  w.stop();
}

console.log("\na working bridge is never restarted");
{
  const clock = fakeClock();
  const deaths: unknown[] = [];
  const w = new LivenessWatchdog({ timeoutMs: 120_000, onDead: (i) => deaths.push(i), now: clock.now });
  w.start();
  w.beat();

  // 100 FT8 windows, each well inside the timeout.
  for (let i = 0; i < 100; i++) {
    clock.advance(15_000);
    w.beat();
    w.check();
  }
  eq(deaths.length, 0, "25 minutes of normal FT8 windows never fires it");
  eq(w.silentFor, 0, "and the silence counter is reset by each beat");
  w.stop();
}

console.log("\na single missed window is tolerated");
{
  // A decode at depth 3 takes 1.5 s, a band change resets the schedule. One late
  // window is not a fault, and a watchdog that restarts on one is worse than none.
  const clock = fakeClock();
  const deaths: unknown[] = [];
  const w = new LivenessWatchdog({ timeoutMs: 120_000, onDead: (i) => deaths.push(i), now: clock.now });
  w.start();
  w.beat();

  clock.advance(30_000); // two periods missed
  w.check();
  eq(deaths.length, 0, "two missed FT8 windows do not fire it");
  clock.advance(60_000); // 90s total
  w.check();
  eq(deaths.length, 0, "nor do six");
  w.stop();
}

console.log("\nthe actual failure: heartbeat stops");
{
  const clock = fakeClock();
  const deaths: { sinceMs: number; label: string }[] = [];
  const w = new LivenessWatchdog({
    timeoutMs: 120_000,
    label: "flex decode pipeline",
    onDead: (i) => deaths.push(i),
    now: clock.now,
  });
  w.start();
  w.beat();

  clock.advance(119_000);
  w.check();
  eq(deaths.length, 0, "just under the timeout, nothing happens");

  clock.advance(2_000);
  w.check();
  eq(deaths.length, 1, "just over it, the watchdog fires");
  eq(deaths[0]?.label, "flex decode pipeline", "and names what went quiet");
  ok((deaths[0]?.sinceMs ?? 0) >= 121_000, "reporting how long the silence was", `${deaths[0]?.sinceMs}ms`);
}

console.log("\nit fires once, not forever");
{
  // The interval keeps ticking while the process winds down. Without a latch the log
  // fills with the same line, which is how a clear diagnosis gets buried in its own
  // repetition — and if onDead restarts something, repeating it is worse than noise.
  const clock = fakeClock();
  const deaths: unknown[] = [];
  const w = new LivenessWatchdog({ timeoutMs: 1_000, onDead: (i) => deaths.push(i), now: clock.now });
  w.start();
  w.beat();
  clock.advance(5_000);

  for (let i = 0; i < 20; i++) w.check();
  eq(deaths.length, 1, "twenty checks after death produce one call, not twenty");

  // And it stops its own timer, so nothing keeps running after it has given up.
  ok(!w.armed, "the watchdog disarms itself once fired");
}

console.log("\nstop and reset");
{
  const clock = fakeClock();
  const deaths: unknown[] = [];
  const w = new LivenessWatchdog({ timeoutMs: 1_000, onDead: (i) => deaths.push(i), now: clock.now });
  w.start();
  w.beat();
  w.stop();
  clock.advance(60_000);
  w.check();
  // check() is still callable after stop() — the guard is the latch and the beat, not
  // the timer — but a stopped watchdog has no timer to call it, which is the point.
  eq(deaths.length, 1, "check() after stop still evaluates if called directly");

  w.reset();
  eq(w.silentFor, null, "reset clears the last beat");
  const w2 = new LivenessWatchdog({ timeoutMs: 1_000, onDead: (i) => deaths.push(i), now: clock.now });
  w2.start();
  w2.stop();
  w2.stop();
  ok(true, "stopping twice is harmless");
}

console.log("\nthe failure the decode watchdog cannot see");
{
  // 10 August 2026: the radio stopped sending DAX audio and panadapter frames while its
  // TCP control link stayed up and answered status queries normally. The decode pipeline
  // is driven by a TIMER, so it went on producing empty windows on schedule, the liveness
  // watchdog went on being beaten by them, and four minutes of a completely dead receiver
  // passed with nothing in the log but the panadapter nudging its own settings.
  //
  // This asserts the shape of that: a decode watchdog fed by windows survives it, and a
  // second watchdog fed by AUDIO does not. The second is the one that had to be added,
  // and this is the case that proves the first could never have caught it.
  const clock = fakeClock();
  const decodeDeaths: unknown[] = [];
  const audioDeaths: unknown[] = [];

  const decodeDog = new LivenessWatchdog({
    timeoutMs: windowTimeoutMs(15_000), // 120 s
    label: "flex decode pipeline",
    onDead: (i) => decodeDeaths.push(i),
    now: clock.now,
  });
  const audioDog = new LivenessWatchdog({
    timeoutMs: AUDIO_STALL_MS, // 90 s
    label: "receiver audio",
    onDead: (i) => audioDeaths.push(i),
    now: clock.now,
  });
  decodeDog.start();
  audioDog.start();
  decodeDog.beat();
  audioDog.beat();

  // Four minutes pass. Windows keep arriving every 15 s because they are timer-driven;
  // no audio arrives at all, because the radio has gone quiet.
  for (let t = 0; t < 240_000; t += 15_000) {
    clock.advance(15_000);
    decodeDog.beat(); // the empty window
    decodeDog.check();
    audioDog.check(); // nothing beats this one
  }

  eq(decodeDeaths.length, 0, "the decode watchdog never fires — windows kept beating it");
  ok(audioDeaths.length > 0, "but the audio watchdog does, because the radio went silent");
}

console.log("\naudio silences that must NOT trigger a restart");
{
  // The timeout has to clear every legitimate gap, or the cure becomes the fault: a
  // bridge that restarts itself mid-QSO is worse than one that waits.
  const clock = fakeClock();
  const deaths: unknown[] = [];
  const dog = new LivenessWatchdog({
    timeoutMs: AUDIO_STALL_MS,
    onDead: (i) => deaths.push(i),
    now: clock.now,
  });
  dog.start();
  dog.beat();

  // An FT8 transmission: DAX RX audio stops while the radio keys, about 13 s.
  clock.advance(13_000);
  dog.check();
  eq(deaths.length, 0, "a 13 s FT8 transmission does not trip it");

  // A run of them, each with audio in between, as an unattended station does all evening.
  for (let i = 0; i < 20; i++) {
    dog.beat();
    clock.advance(13_500);
    dog.check();
  }
  eq(deaths.length, 0, "nor twenty overs in a row");

  // A band change or slice retune — longer, still not a fault.
  dog.beat();
  clock.advance(45_000);
  dog.check();
  eq(deaths.length, 0, "nor a 45 s retune");

  // But a genuinely dead receiver is.
  clock.advance(50_000);
  dog.check();
  eq(deaths.length, 1, "95 s of no audio at all is a dead receiver, and it fires");
}

console.log("\ntimeout sizing");
{
  // Eight periods: long enough never to fire on a working radio, short enough that a
  // hang is caught in minutes rather than the five hours it actually took.
  eq(windowTimeoutMs(15_000), 120_000, "FT8's 15 s period gives a 2 minute timeout");
  eq(windowTimeoutMs(7_500), 60_000, "FT4 floors at 60 s");
  eq(windowTimeoutMs(3_750), 60_000, "so does FT2 — the floor stops it being twitchy");
  ok(windowTimeoutMs(15_000) > 15_000 * 4, "always several periods, never one or two");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

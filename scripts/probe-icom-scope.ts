/* eslint-disable no-console */
// What does the IC-7300's spectrum scope COST?
//
// docs/panadapter.md is emphatic that this question comes before any scope work, and
// it is right to be. Scope frames arrive on the same CI-V stream as every command and
// every meter read, and that stream is paced 70 ms apart because the radio answers the
// first command of a burst and silently drops the rest. That behaviour already cost
// this project weeks of meters that reported nothing.
//
// So this measures rather than assumes, and it measures the thing that actually
// matters. Total frame count is NOT that thing: a radio sending 30 waveform frames a
// second and answering no reads at all has a magnificent frame count and a dead
// S-meter. What matters is whether each POLLED READ still comes back, so this counts
// replies per command, before and after.
//
// RECEIVE ONLY. No transmitter is attached, so nothing here can key.
//
//   npx tsx scripts/probe-icom-scope.ts [secondsPerPhase]

import { createIcomSource } from "@/lib/icom/from-settings";
import type { IcomSource } from "@/lib/icom/rig";
import { SCOPE_SPANS_HZ, type ScopeSpanHz } from "@/lib/icom/civ";
import { prisma } from "@/lib/db/prisma";

/** What the poll asks for every 2 s, and what each is worth if it stops coming back. */
const POLLED = [
  ["0x03", "frequency", "the log records the wrong band"],
  ["0x26/0x00", "mode + data flag", "a digital transmission into a microphone input"],
  ["0x15/0x02", "S-meter", "the signal bar goes blank"],
  ["0x15/0x12", "SWR", "the operating guards lose their antenna check"],
  ["0x15/0x11", "power", "a keyed radio producing no RF stops being detectable"],
] as const;

interface Phase {
  label: string;
  secs: number;
  frames: number;
  byCommand: Record<string, number>;
  unmatched: number;
  queueHighWater: number;
  scopeFrames: number;
  scopeBytes: number;
  /** Polls that should have happened in the window. */
  expectedPolls: number;
  /** Audio datagrams that arrived and that went missing, during this phase. */
  audioPackets: number;
  audioDropped: number;
}

/**
 * How lossy is the LINK, over the same window?
 *
 * Without this the whole measurement is uninterpretable. The path to this radio is a
 * remote one — 25 ms round trip — and a run on 3 August lost 202 of 436 audio
 * datagrams. A poll answered 50% of the time on a link like that says nothing about
 * the scope; it says the network ate half the traffic. Audio drops are counted from
 * gaps in the radio's own sequence numbers, so they measure the path and nothing else,
 * which makes them the control this experiment needs.
 */
async function measure(source: IcomSource, label: string, secs: number): Promise<Phase> {
  source.resetCivStats();
  const audio0 = source.audioPacketsSeen;
  const dropped0 = source.audioDropped;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, secs * 1_000));
  const elapsed = (Date.now() - t0) / 1000;
  const s = source.civStats;
  return {
    label,
    secs: elapsed,
    frames: s.frames,
    byCommand: s.byCommand,
    unmatched: s.unmatched,
    queueHighWater: s.queueHighWater,
    scopeFrames: s.scopeFrames,
    scopeBytes: s.scopeBytes,
    // POLL_INTERVAL_MS is 2 s.
    expectedPolls: Math.floor(elapsed / 2),
    audioPackets: source.audioPacketsSeen - audio0,
    audioDropped: source.audioDropped - dropped0,
  };
}

function report(p: Phase): void {
  console.log(`\n=== ${p.label} — ${p.secs.toFixed(1)} s ===`);
  console.log(
    `  ${p.frames} CI-V frames (${(p.frames / p.secs).toFixed(1)}/s)` +
      `  |  scope ${p.scopeFrames} frames (${(p.scopeFrames / p.secs).toFixed(1)}/s, ` +
      `${(p.scopeBytes / p.secs / 1024).toFixed(1)} kB/s)` +
      `  |  queue high-water ${p.queueHighWater}` +
      `  |  ${p.unmatched} frames matched no waiter`,
  );
  // The control. A poll answered half the time on a link losing half its datagrams is
  // a network measurement, not a scope measurement.
  const sent = p.audioPackets + p.audioDropped;
  const loss = sent > 0 ? (p.audioDropped / sent) * 100 : 0;
  console.log(
    `  link: ${p.audioPackets} audio datagrams arrived, ${p.audioDropped} lost in transit` +
      ` = ${loss.toFixed(1)}% loss` +
      (loss > 5 ? "   <-- READ EVERYTHING BELOW AGAINST THIS" : ""),
  );
  console.log(`  polled reads, against ${p.expectedPolls} polls in the window:`);
  for (const [key, what, cost] of POLLED) {
    const got = p.byCommand[key] ?? 0;
    const pct = p.expectedPolls > 0 ? (got / p.expectedPolls) * 100 : 0;
    const verdict = pct >= 90 ? "ok" : pct >= 50 ? "DEGRADED" : "STARVED";
    console.log(
      `    ${key.padEnd(10)} ${what.padEnd(18)} ${String(got).padStart(3)}/${String(p.expectedPolls).padEnd(3)}` +
        ` ${pct.toFixed(0).padStart(4)}%  ${verdict}${verdict === "ok" ? "" : `  — ${cost}`}`,
    );
  }
  const others = Object.entries(p.byCommand).filter(
    ([k]) => !POLLED.some(([pk]) => pk === k) && k !== "0x27/0x00",
  );
  if (others.length) {
    console.log(`  other replies: ${others.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
}

async function main(): Promise<void> {
  const secs = Number(process.argv[2] ?? 20);

  // Survive the audio stream dying, which on this radio it does — repeatedly, and
  // after `start()` has already resolved, so it arrives as an unhandled rejection
  // that takes the process with it. That is worth fixing in lib/icom, but it is not
  // this script's job and it must not abort a CI-V measurement that does not use
  // audio at all. Logged rather than swallowed: a run that hit this should say so.
  process.on("unhandledRejection", (e) => {
    console.log(`  (unhandled rejection, continuing: ${e instanceof Error ? e.message : String(e)})`);
  });
  process.on("uncaughtException", (e) => {
    console.log(`  (uncaught, continuing: ${e.message})`);
  });

  const source = await createIcomSource();
  if (!source) {
    console.log("Icom is not configured");
    return;
  }

  source.on("error", (e) => console.log(`  error: ${e.message}`));
  // In an object because TypeScript does not track assignments made inside callbacks:
  // a bare `let` stays narrowed to null and the truthy branch below becomes `never`.
  const first: { scope: Buffer | null } = { scope: null };
  const scopeSeq = new Map<number, number>();
  source.on("scopeFrame", (f) => {
    first.scope ??= Buffer.from(f.data);
    // Byte after the sub-command is the scope selector; the one after that is the
    // sequence number within a sweep. Counted, not trusted — the layout is the next
    // thing to establish and this says how many pieces a sweep comes in.
    const seq = f.data[2];
    if (seq !== undefined) scopeSeq.set(seq, (scopeSeq.get(seq) ?? 0) + 1);
  });

  console.log("connecting…");
  // Tolerate a failed start rather than giving up on the measurement.
  //
  // `start()` rejects if ANY of the three streams fails to come up, and on this radio
  // the AUDIO stream is the one that keeps dying — 202 of 436 datagrams lost on one
  // run, session gone in six seconds. But the question being asked here is about
  // CI-V, and audio is not needed to answer it. Giving up because the audio stream
  // died would be abandoning a measurement over a stream it does not use.
  try {
    await source.start();
  } catch (e) {
    console.log(`  start() rejected: ${e instanceof Error ? e.message : e}`);
    console.log("  continuing anyway — this measurement needs CI-V, not audio");
  }

  // Wait for CI-V specifically, not just for "a stream carried something". Audio comes
  // up within a packet or two while CI-V takes a poll, so a check that accepts either
  // reports success on a session whose command channel is dead — which is precisely
  // the state the first run of this probe found and mis-reported as a hard failure.
  const carrying = await source.streamsCarrying(30_000);
  if (!carrying.ok) {
    console.log(
      `streams are open but not both carrying (civ=${carrying.civ} audio=${carrying.audio})` +
        (carrying.civ === 0 && carrying.audio > 0
          ? " — audio is fine and CI-V is silent, which is the serial stream or the CI-V address, not the session"
          : ""),
    );
    if (carrying.civ === 0) {
      console.log("FAIL: no CI-V at all, so there is nothing to measure");
      await source.stop();
      await prisma.$disconnect();
      return;
    }
  }
  console.log(`connected: ${source.identity.model}, freq ${source.getFrequencyHz() ?? "?"}`);

  // Make sure we start from a known state rather than whatever the last session left.
  await source.setScopeDataOutput(false).catch((e) => console.log(`  (scope off: ${e.message})`));
  await new Promise((r) => setTimeout(r, 1_000));

  const before = await measure(source, "BASELINE — scope off", secs);
  report(before);

  console.log(`\nturning the scope data output on…`);
  let scopeOn = false;
  try {
    await source.setScopeOn(true);
    await source.setScopeDataOutput(true);
    scopeOn = true;
    console.log("  the radio confirmed it");
  } catch (e) {
    console.log(`  REFUSED: ${e instanceof Error ? e.message : e}`);
  }

  if (scopeOn) {
    const during = await measure(source, "SCOPE ON", secs);
    report(during);

    // Which spans the radio will actually accept, and what each costs. Only run if
    // the scope is carrying — otherwise this measures nothing.
    if (during.scopeFrames > 0) {
      console.log(`\n=== span sweep, ${Math.round(secs / 4)} s each ===`);
      for (const span of SCOPE_SPANS_HZ) {
        try {
          await source.setScopeSpan(span as ScopeSpanHz);
        } catch (e) {
          console.log(`  ±${(span / 1000).toString().padStart(4)} kHz  REFUSED: ${e instanceof Error ? e.message : e}`);
          continue;
        }
        const m = await measure(source, "", Math.max(4, Math.round(secs / 4)));
        const freqPct = m.expectedPolls > 0 ? ((m.byCommand["0x03"] ?? 0) / m.expectedPolls) * 100 : 0;
        console.log(
          `  ±${(span / 1000).toString().padStart(4)} kHz  ` +
            `${(m.scopeFrames / m.secs).toFixed(1).padStart(5)} scope frames/s  ` +
            `${(m.scopeBytes / m.secs / 1024).toFixed(1).padStart(5)} kB/s  ` +
            `frequency poll ${freqPct.toFixed(0).padStart(3)}%`,
        );
      }
    }

    console.log(`\nturning the scope data output off…`);
    await source.setScopeDataOutput(false).catch((e) => console.log(`  ${e.message}`));
    await new Promise((r) => setTimeout(r, 1_000));
    const after = await measure(source, "AFTER — scope off again", secs);
    report(after);

    // Did the poll come back? If the meters do not recover, the scope did lasting
    // damage to the session rather than merely competing for it while running.
    const recovered =
      (after.byCommand["0x15/0x02"] ?? 0) >= (before.byCommand["0x15/0x02"] ?? 0) * 0.9;
    console.log(
      `\nrecovery: the S-meter ${recovered ? "came back" : "DID NOT come back"} after the scope was turned off`,
    );
  }

  if (first.scope) {
    console.log(`\n--- first scope frame, ${first.scope.length} payload bytes ---`);
    console.log(`  ${first.scope.toString("hex")}`);
    console.log(`  sequence numbers seen: ${[...scopeSeq.keys()].sort((a, b) => a - b).join(" ")}`);
    console.log(`  counts per sequence:   ${[...scopeSeq].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  }

  await source.stop();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

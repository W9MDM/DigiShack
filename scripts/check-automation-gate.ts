/* eslint-disable no-console */
// The automation gate: what starts the station when nobody is at the screen, and where
// it must not. See lib/radio/automation-gate.ts for the five minutes on 40 m JS8 that
// made it.

import fs from "node:fs";

import type { AutoMode } from "@/lib/radio/auto-mode";
import { gateAutomation, hopModeFor, NO_SEQUENCER_MODES, noSequencerReason } from "@/lib/radio/automation-gate";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(got: T, want: T, label: string): void {
  ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** One turn of the event loop: a resolved promise's `.then` chain has run by then. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function make(sub: string | null, leaveResult: boolean | Error = true) {
  const auto = {
    state: { mode: "off" as AutoMode },
    setMode(m: AutoMode) {
      this.state.mode = m;
    },
  };
  const left: string[] = [];
  const log: string[] = [];
  const gated = gateAutomation(auto, {
    subMode: () => sub,
    leave: async (from) => {
      left.push(from);
      if (leaveResult instanceof Error) throw leaveResult;
      return leaveResult;
    },
    log: (l) => log.push(l),
  });
  return { auto, gated, left, log };
}

async function main(): Promise<void> {
  console.log("\nmodes with nothing to answer");
  for (const m of ["WSPR", "RTTY", "CW", "JS8", "PSK31", "OLIVIA"]) ok(NO_SEQUENCER_MODES.has(m), `${m} has no sequencer`);
  for (const m of ["FT8", "FT4", "FT2"]) ok(!NO_SEQUENCER_MODES.has(m), `${m} has one`);
  ok(noSequencerReason("JS8").includes("JS8"), "the JS8 reason names JS8");
  ok(noSequencerReason("WSPR").includes("receive-only"), "the WSPR reason says receive-only");
  ok(noSequencerReason("RTTY").includes("RTTY"), "and RTTY's names RTTY");

  console.log("\nthe band hop never lands on a frequency with nothing to answer");
  eq(hopModeFor("FT8"), "FT8", "FT8 stays FT8");
  eq(hopModeFor("FT4"), "FT4", "FT4 stays FT4");
  eq(hopModeFor("FT2"), "FT2", "FT2 stays FT2");
  eq(hopModeFor("JS8"), "FT8", "a hop while on JS8 goes to the next band's FT8 frequency, not its JS8 one");
  eq(hopModeFor("WSPR"), "FT8", "and from WSPR");
  eq(hopModeFor("CW"), "FT8", "and from CW");

  console.log("\nthe gate in front of the schedule and the restart resume");
  {
    const t = make("FT8");
    t.gated.setMode("hunt");
    eq(t.auto.state.mode, "hunt", "on FT8 the operator starts at once");
    eq(t.left.length, 0, "and nothing is retuned");
    eq(t.gated.state.mode, "hunt", "the gate shows the operator's own state");
  }
  {
    const t = make("FT4");
    t.gated.setMode("cq");
    eq(t.auto.state.mode, "cq", "FT4 too");
    eq(t.left.length, 0, "without a retune");
  }
  {
    const t = make("JS8");
    t.gated.setMode("off");
    eq(t.left.length, 0, "turning off never retunes");
    eq(t.auto.state.mode, "off", "and passes straight through");
  }
  {
    const t = make("JS8");
    t.gated.setMode("hunt");
    eq(t.auto.state.mode, "off", "on JS8 the operator does not start before the dial has moved");
    eq(t.left[0], "JS8", "the radio is asked to leave JS8");
    await tick();
    eq(t.auto.state.mode, "hunt", "and hunt starts once it has");
    ok(t.log.some((l) => l.includes("JS8") && l.includes("FT8")), "the log says what moved and why", t.log.join(" | "));
  }
  {
    const t = make("WSPR", false);
    t.gated.setMode("cq");
    await tick();
    eq(t.auto.state.mode, "cq", "a retune that fails still starts the mode: its first band hop lands on FT8");
    ok(t.log.some((l) => l.includes("anyway")), "and says so", t.log.join(" | "));
  }
  {
    const t = make("RTTY", new Error("radio away"));
    t.gated.setMode("hunt");
    await tick();
    eq(t.auto.state.mode, "hunt", "a retune that throws starts it too");
    ok(t.log.some((l) => l.includes("radio away")), "with the error in the log", t.log.join(" | "));
  }
  {
    const t = make(null);
    t.gated.setMode("hunt");
    eq(t.auto.state.mode, "hunt", "before the first window the mode is unknown and the start is not held");
    eq(t.left.length, 0, "nor retuned");
  }

  console.log("\nlanding on a mode with nothing to answer is saved as off");
  {
    const src = fs.readFileSync("services/radio/index.ts", "utf8");
    const at = src.indexOf("automatic mode stopped");
    const around = at >= 0 ? src.slice(Math.max(0, at - 900), at) : "";
    ok(
      /a\.setMode\("off"\)[\s\S]*persistAutoMode\("off"\)/.test(around),
      "the landing stop persists off, so a bridge restart does not resume the hunt and pull the radio away",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/* eslint-disable no-console */
// The operating schedule.
//
// Most of these assertions are about the two things that make an unattended station a
// nuisance rather than an asset: transmitting when it was told not to, and transmitting
// for so long that the finals suffer. Both are silent failures — nobody notices the
// station calling CQ at 3am except the person trying to sleep next to it.

import type { AutoMode } from "@/lib/radio/auto-mode";
import { startScheduleRunner } from "@/lib/radio/schedule-runner";
import {
  decideSchedule,
  formatHhmm,
  inRange,
  localMinutes,
  PaDutyTracker,
  parseHhmm,
  parseRange,
  parseSchedule,
  type ScheduleConfig,
} from "@/lib/radio/schedule";

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

/** A local-time Date for today at HH:MM — the schedule works in local time. */
function at(hh: number, mm = 0): Date {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d;
}

const IDLE = { resting: false, restUntil: null, txMinutes: 0 };

console.log("\nparsing times");
{
  eq(parseHhmm("08:00"), 480, "08:00 is 480 minutes past midnight");
  eq(parseHhmm("8:05"), 485, "a single-digit hour is accepted");
  eq(parseHhmm("23:59"), 1439, "the last minute of the day");
  eq(parseHhmm("00:00"), 0, "midnight is zero, not falsy-rejected");
  eq(parseHhmm("24:00"), null, "24:00 is refused");
  eq(parseHhmm("08:60"), null, "so is minute 60");
  eq(parseHhmm("0800"), null, "and a missing colon");
  eq(formatHhmm(480), "08:00", "and it round-trips");
  eq(formatHhmm(0), "00:00", "including midnight");
}

console.log("\nranges, including the one that wraps midnight");
{
  const day = parseRange("08:00-12:00");
  ok(inRange(480, day!), "08:00 is inside 08:00-12:00 — start is inclusive");
  ok(inRange(700, day!), "so is the middle");
  ok(!inRange(720, day!), "12:00 is NOT — end is exclusive, so adjacent blocks do not overlap");
  ok(!inRange(479, day!), "and 07:59 is outside");

  // Sleeping hours almost always wrap midnight. A naive start<=x<end test yields
  // nothing at all for 23:00-07:00, so the station would happily call CQ all night.
  const night = parseRange("23:00-07:00")!;
  ok(inRange(23 * 60 + 30, night), "23:30 is inside 23:00-07:00");
  ok(inRange(0, night), "so is midnight");
  ok(inRange(6 * 60 + 59, night), "so is 06:59");
  ok(!inRange(7 * 60, night), "07:00 is not — you are allowed up");
  ok(!inRange(12 * 60, night), "and noon certainly is not");
}

console.log("\nparsing a working-hours spec");
{
  const r = parseSchedule("08:00-12:00=hunt, 13:00-22:00=cq");
  eq(r.errors, [], "a clean spec has no errors");
  eq(r.blocks.length, 2, "two blocks");
  eq(r.blocks[0]?.mode, "hunt", "the first is hunt");
  eq(r.blocks[1]?.mode, "cq", "the second is cq");

  eq(parseSchedule("08:00-12:00=HUNT").blocks[0]?.mode, "hunt", "the mode is case-insensitive");
  eq(parseSchedule("08:00-12:00=hunt\n13:00-14:00=cq").blocks.length, 2, "newlines separate too");
  eq(parseSchedule("").blocks.length, 0, "an empty spec is empty, not an error");
  eq(parseSchedule("  ").errors, [], "and so is whitespace");

  // A typo in one block must not silently discard the others, and must be visible.
  const bad = parseSchedule("08:00-12:00=hunt, 13:00-22:00=wibble, 22:00-23:00=cq");
  eq(bad.blocks.length, 2, "a bad block is dropped, the good ones survive");
  eq(bad.errors.length, 1, "and the problem is reported rather than swallowed");
  ok(/wibble/.test(bad.errors[0] ?? ""), "naming the offending value", bad.errors[0]);

  eq(parseSchedule("08:00-12:00").errors.length, 1, "a range with no mode is an error");
  eq(parseSchedule("breakfast=hunt").errors.length, 1, "so is a range that is not a time");
  eq(parseSchedule("08:00-08:00=cq").errors.length, 1, "a zero-length block is an error, not silence");
}

console.log("\nwhat to do right now");
{
  const cfg: ScheduleConfig = {
    enabled: true,
    blocks: parseSchedule("08:00-12:00=hunt, 13:00-22:00=cq").blocks,
    sleep: parseRange("23:00-07:00"),
    paAfterMinutes: 0,
    paRestMinutes: 0,
  };

  eq(decideSchedule(cfg, at(9), IDLE).mode, "hunt", "09:00 hunts");
  eq(decideSchedule(cfg, at(15), IDLE).mode, "cq", "15:00 calls CQ");
  eq(decideSchedule(cfg, at(12, 30), IDLE).mode, "off", "the gap between blocks is off");
  ok(/nothing scheduled/i.test(decideSchedule(cfg, at(12, 30), IDLE).reason), "and says so plainly");
  eq(decideSchedule(cfg, at(2), IDLE).mode, "off", "02:00 is off — sleeping");
  ok(decideSchedule(cfg, at(2), IDLE).suppressed, "and that is a suppression, not an empty slot");
  ok(/sleeping/i.test(decideSchedule(cfg, at(2), IDLE).reason), "the reason names sleeping hours");

  eq(decideSchedule({ ...cfg, enabled: false }, at(9), IDLE).mode, "off", "a disabled schedule does nothing");
}

console.log("\nsleep beats the schedule");
{
  // The whole point. If a working block overlaps sleeping hours, sleep must win —
  // otherwise the setting that stops the station waking the house is advisory.
  const cfg: ScheduleConfig = {
    enabled: true,
    blocks: parseSchedule("00:00-23:59=cq").blocks,
    sleep: parseRange("23:00-07:00"),
    paAfterMinutes: 0,
    paRestMinutes: 0,
  };
  eq(decideSchedule(cfg, at(3), IDLE).mode, "off", "an all-day block still yields to sleeping hours");
  eq(decideSchedule(cfg, at(10), IDLE).mode, "cq", "and runs normally outside them");
}

console.log("\nthe PA cooldown");
{
  const cfg: ScheduleConfig = {
    enabled: true,
    blocks: parseSchedule("00:00-23:59=cq").blocks,
    sleep: null,
    paAfterMinutes: 30,
    paRestMinutes: 10,
  };
  const resting = { resting: true, restUntil: new Date(Date.now() + 5 * 60_000), txMinutes: 30 };
  eq(decideSchedule(cfg, new Date(), resting).mode, "off", "a resting PA overrides the schedule");
  ok(/cooling down/i.test(decideSchedule(cfg, new Date(), resting).reason), "and says how long is left");

  // Rest that has expired must not keep suppressing.
  const done = { resting: true, restUntil: new Date(Date.now() - 1_000), txMinutes: 30 };
  eq(decideSchedule(cfg, new Date(), done).mode, "cq", "an expired rest stops suppressing");
}

console.log("\ncounting transmit time, not wall time");
{
  // The distinction that makes this worth having. FT8 alternates transmit and receive,
  // so an hour of operating is about half an hour of transmitting. A cooldown measured
  // on wall-clock time would rest the radio twice as often as it needs, and would rest
  // an operator who spent the hour listening for no reason at all.
  const t0 = 1_000_000;
  const pa = new PaDutyTracker(10, 5);

  // Twelve minutes of wall time, six of it transmitting.
  let now = t0;
  for (let i = 0; i < 6; i++) {
    pa.keyed(now);
    now += 60_000; // a minute keyed
    pa.unkeyed(now);
    now += 60_000; // a minute listening
  }
  ok(Math.abs(pa.transmitMinutes - 6) < 0.01, "six transmit minutes out of twelve elapsed", `${pa.transmitMinutes}`);
  eq(pa.state(new Date(now)).resting, false, "under the 10-minute limit, no rest yet");

  // Four more transmit minutes crosses it.
  pa.keyed(now);
  now += 4 * 60_000;
  pa.unkeyed(now);
  const s = pa.state(new Date(now));
  eq(s.resting, true, "ten transmit minutes triggers the rest");
  ok(s.restUntil !== null && s.restUntil.getTime() > now, "with an end time in the future");

  // Still resting a minute later, done after five.
  eq(pa.state(new Date(now + 60_000)).resting, true, "still resting a minute in");
  const after = pa.state(new Date(now + 6 * 60_000));
  eq(after.resting, false, "and released after the rest period");
  ok(after.txMinutes < 0.01, "with the transmit counter reset for the next stint", `${after.txMinutes}`);
}

console.log("\ncooldown off, and other edges");
{
  // 0 disables it. An operator running QRP into a proper amplifier does not need this,
  // and forcing it on them makes a setting that only ever gets worked around.
  const pa = new PaDutyTracker(0, 10);
  pa.keyed(1_000);
  pa.unkeyed(1_000 + 3600_000);
  eq(pa.state().resting, false, "an hour of transmit never rests when the limit is 0");

  const p2 = new PaDutyTracker(10, 5);
  p2.unkeyed();
  eq(p2.transmitMinutes, 0, "unkeying without keying is harmless");
  p2.keyed(1000);
  p2.keyed(2000);
  p2.unkeyed(2000 + 60_000);
  ok(Math.abs(p2.transmitMinutes - 1.0167) < 0.05, "a second keyed() does not restart the clock", `${p2.transmitMinutes}`);

  p2.reset();
  eq(p2.transmitMinutes, 0, "reset clears it for manual control");
}

console.log("\nlocal time, stated plainly");
{
  // The schedule is local because "sleeping hours" is a fact about the house, not the
  // log. This asserts the intent so nobody "fixes" it to UTC later.
  const noon = at(12, 34);
  eq(localMinutes(noon), 12 * 60 + 34, "minutes come from the local clock");
  ok(noon.getHours() === 12, "and 12:00 local really is hour 12 here");
}

console.log("\napplying the schedule to a radio");
{
  // The runner, not the decision. Both rules here are ones that quietly regress: act
  // only on a CHANGE, and never overwrite what the operator chose mid-block.
  //
  // It also used to live inside startFlexSource, which meant an Icom session had no
  // schedule at all — no timed modes, no sleep hours, no PA duty rest. Testing it needs
  // no radio, which is the argument for it not living in the service.
  const cfg = {
    enabled: true,
    blocks: parseSchedule("06:00-22:00=hunt").blocks,
    sleep: null,
    paAfterMinutes: 0,
    paRestMinutes: 10,
  };

  const make = () => {
    const auto = {
      state: { mode: "off" as AutoMode },
      setMode(m: AutoMode) {
        this.state.mode = m;
      },
    };
    const changes: AutoMode[] = [];
    const runner = startScheduleRunner({
      // The fixture's clock. Without this the constructor's opening tick reads the real
      // wall time, and these assertions pass or fail depending on the hour of the day.
      now: () => inHours,
      cfg,
      errors: [],
      paDuty: { state: () => ({ resting: false, restUntil: null, txMinutes: 0 }) },
      auto: () => auto,
      onChanged: (m) => changes.push(m),
      log: () => {},
      logError: () => {},
      intervalMs: 60_000,
    });
    return { auto, changes, runner };
  };

  const inHours = new Date("2026-08-03T14:00:00");
  const outOfHours = new Date("2026-08-03T23:30:00");

  {
    const { auto, changes, runner } = make();
    runner.tick(inHours);
    eq(auto.state.mode, "hunt", "inside the block, the mode is set");
    eq(changes, ["hunt"], "and the change is reported once");

    // Same answer again: nothing to do, and nothing to say.
    runner.tick(inHours);
    eq(changes.length, 1, "an unchanged answer does not act again");

    runner.tick(outOfHours);
    eq(auto.state.mode, "off", "outside the block it stops");
    eq(changes, ["hunt", "off"], "and reports that too");
    runner.stop();
  }

  {
    // The rule that makes this a schedule rather than a fight.
    const { auto, changes, runner } = make();
    runner.tick(inHours);
    eq(auto.state.mode, "hunt", "scheduled on");

    // The operator disagrees, mid-block.
    auto.setMode("cq");
    runner.tick(inHours);
    eq(auto.state.mode, "cq", "an operator override survives the next tick");
    eq(changes.length, 1, "and the schedule does not report a change it did not make");

    // ...until the schedule's own answer changes.
    runner.tick(outOfHours);
    eq(auto.state.mode, "off", "the next boundary takes it back");
    runner.stop();
  }

  {
    // A source being rebuilt has no operator. The schedule must not throw, and must not
    // decide that it has already applied that answer.
    const changes: AutoMode[] = [];
    let auto: { state: { mode: AutoMode }; setMode(m: AutoMode): void } | null = null;
    const runner = startScheduleRunner({
      // The fixture's clock. Without this the constructor's opening tick reads the real
      // wall time, and these assertions pass or fail depending on the hour of the day.
      now: () => inHours,
      cfg,
      errors: [],
      paDuty: { state: () => ({ resting: false, restUntil: null, txMinutes: 0 }) },
      auto: () => auto,
      onChanged: (m) => changes.push(m),
      log: () => {},
      logError: () => {},
      intervalMs: 60_000,
    });
    runner.tick(inHours);
    eq(changes.length, 0, "no operator, nothing applied");

    auto = {
      state: { mode: "off" as AutoMode },
      setMode(m: AutoMode) {
        this.state.mode = m;
      },
    };
    runner.tick(inHours);
    eq(auto.state.mode, "hunt", "and it applies once the rebuilt operator appears");
    runner.stop();
  }

  {
    // The display hook: onDecision reports EVERY evaluation, not just changes, and
    // does so even while the source is being rebuilt — the browser's schedule line
    // must not blank out for the seconds a reconnect takes, and a PA rest's
    // minutes-remaining only ever arrives through here.
    const decisions: { mode: AutoMode; reason: string }[] = [];
    let auto: { state: { mode: AutoMode }; setMode(m: AutoMode): void } | null = null;
    const runner = startScheduleRunner({
      // The fixture's clock. Without this the constructor's opening tick reads the real
      // wall time, and these assertions pass or fail depending on the hour of the day.
      now: () => inHours,
      cfg,
      errors: [],
      paDuty: { state: () => ({ resting: false, restUntil: null, txMinutes: 0 }) },
      auto: () => auto,
      onChanged: () => {},
      onDecision: (d) => decisions.push({ mode: d.mode, reason: d.reason }),
      log: () => {},
      logError: () => {},
      intervalMs: 60_000,
    });
    const startupTicks = decisions.length; // the runner ticks once on start

    runner.tick(inHours);
    eq(decisions.length, startupTicks + 1, "a decision is reported with no operator attached");
    eq(decisions.at(-1)?.mode, "hunt", "and says what the schedule wants");

    runner.tick(inHours);
    eq(decisions.length, startupTicks + 2, "an UNCHANGED answer is still reported — it feeds a display");

    runner.tick(outOfHours);
    eq(decisions.at(-1)?.mode, "off", "and tracks the boundary");
    ok(/nothing scheduled/i.test(decisions.at(-1)?.reason ?? ""), "with the reason spelled out");
    runner.stop();
  }

  {
    // The restart case, which is where the override rule actually broke in the
    // field: the operator picked hunt-pota mid-block, the bridge restarted (a
    // deploy, or its own liveness watchdog), and the fresh runner treated the
    // same block as a new change and stamped hunt back. With the persisted
    // answer handed in, the same block is NOT a change and the override survives.
    const auto = {
      state: { mode: "hunt-pota" as AutoMode }, // the operator's mid-block choice
      setMode(m: AutoMode) {
        this.state.mode = m;
      },
    };
    const changes: AutoMode[] = [];
    const runner = startScheduleRunner({
      // The fixture's clock. Without this the constructor's opening tick reads the real
      // wall time, and these assertions pass or fail depending on the hour of the day.
      now: () => inHours,
      cfg,
      errors: [],
      paDuty: { state: () => ({ resting: false, restUntil: null, txMinutes: 0 }) },
      auto: () => auto,
      initialLastScheduled: "hunt", // what the schedule had applied before the restart
      onChanged: (m) => changes.push(m),
      log: () => {},
      logError: () => {},
      intervalMs: 60_000,
    });
    runner.tick(inHours);
    eq(auto.state.mode, "hunt-pota", "a restart mid-block does not stamp over the operator");
    eq(changes.length, 0, "and reports no change, because nothing changed");

    runner.tick(outOfHours);
    eq(auto.state.mode, "off", "the next real boundary still takes it back");
    eq(changes, ["off"], "and that one IS reported");
    runner.stop();
  }

  {
    // Disabled means disabled, and still returns a usable handle so no caller branches.
    const auto = {
      state: { mode: "off" as AutoMode },
      setMode(m: AutoMode) {
        this.state.mode = m;
      },
    };
    const runner = startScheduleRunner({
      // The fixture's clock. Without this the constructor's opening tick reads the real
      // wall time, and these assertions pass or fail depending on the hour of the day.
      now: () => inHours,
      cfg: { ...cfg, enabled: false },
      errors: [],
      paDuty: { state: () => ({ resting: false, restUntil: null, txMinutes: 0 }) },
      auto: () => auto,
      onChanged: () => fail++,
      log: () => fail++,
      logError: () => fail++,
    });
    runner.tick(inHours);
    eq(auto.state.mode, "off", "a disabled schedule changes nothing");
    runner.stop();
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

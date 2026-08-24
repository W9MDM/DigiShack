// Assertions on the radio-link latency compensation.
//
// The estimator and the caps are pure arithmetic, so they are asserted directly — no
// radio, no sockets, no waiting out T/R periods. The wiring (probes on the Flex command
// channel, the Icom ping echo, the transmitters' early keying) is exercised on the air,
// where a wrong sign shows up as every station's dt shifting by the compensation.

import {
  LinkLatency,
  MAX_LINK_COMPENSATION_MS,
  MIN_LINK_COMPENSATION_MS,
} from "@/lib/radio/link-latency";
import { effectiveLagMs, CUT_MARGIN_MS, TRANSMISSION_MS } from "@/lib/radio/decode-pipeline";
import { PERIOD_MS } from "@/lib/radio/timing";

let failed = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const ok = Object.is(actual, expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${what}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
}

console.log("the estimator is the minimum, not the mean");
{
  const link = new LinkLatency();
  eq(link.rttMs(), null, "no samples yet reads as null, never 0");
  eq(link.oneWayMs(), 0, "and compensates by nothing");

  // A quiet packet among noisy ones: queueing only ever ADDS, so the minimum is the
  // closest look at the true path. The mean of these is 173; the truth is nearer 80.
  for (const rtt of [180, 80, 260, 120, 225]) link.sample(rtt);
  eq(link.rttMs(), 80, "five mixed samples answer with the quietest");
  eq(link.oneWayMs(), 40, "one way is half the best round trip");
}

console.log("\nwhat gets refused, and what gets capped");
{
  const link = new LinkLatency();
  link.sample(-5);
  link.sample(Number.NaN);
  link.sample(31_000);
  eq(link.rttMs(), null, "garbage samples (negative, NaN, absurd) are dropped, not clamped");

  const lan = new LinkLatency();
  lan.sample(3);
  eq(lan.oneWayMs(), 0, `a LAN round trip compensates by nothing (floor ${MIN_LINK_COMPENSATION_MS}ms)`);
  eq(lan.state()?.rttMs, 3, "but is still reported, so the display can say the link is fine");

  const awful = new LinkLatency();
  awful.sample(6_000);
  eq(awful.oneWayMs(), MAX_LINK_COMPENSATION_MS, "a 6 s round trip is capped, not obeyed");
}

console.log("\nthe window schedule can never cut into the next window");
{
  const ft8Cut = TRANSMISSION_MS.FT8 + CUT_MARGIN_MS;
  const ft2Cut = TRANSMISSION_MS.FT2 + CUT_MARGIN_MS;

  eq(effectiveLagMs(0, PERIOD_MS.FT8, ft8Cut), 0, "no latency, no shift");
  eq(effectiveLagMs(150, PERIOD_MS.FT8, ft8Cut), 150, "a VPN's 150 ms passes through on FT8");

  // FT8 leaves 15000 - 13840 = 1160 ms of gap; minus scheduling slack, 1060 is the most
  // the cut may move. Anything larger surfaces as reduced late-DT tolerance instead.
  eq(effectiveLagMs(5_000, PERIOD_MS.FT8, ft8Cut), 1_060, "FT8 shift is capped at the gap");

  // FT2's gap is 3750 - 3147 = 603 ms; the cap must be per mode or FT2 windows would
  // be cut after the next window has already begun, stealing its head.
  eq(effectiveLagMs(1_000, PERIOD_MS.FT2, ft2Cut), 503, "FT2's tighter gap caps sooner");

  eq(effectiveLagMs(100, 1_000, 950), 0, "a gap smaller than the slack shifts nothing");
}

console.log("\nstale measurements expire");
{
  // TTL behaviour is asserted through the public surface: a sample recorded now is
  // alive, and the filter runs on read — so this at least pins that reading twice does
  // not consume the sample. Clock-travel tests would need to fake Date.now(); the TTL
  // constant is private and five minutes long, which live probes refresh every 15 s.
  const link = new LinkLatency();
  link.sample(90);
  eq(link.rttMs(), 90, "a fresh sample is alive");
  eq(link.rttMs(), 90, "and reading it is not consuming it");
  link.reset();
  eq(link.rttMs(), null, "reset forgets everything (used when a source stops)");
}

console.log(failed === 0 ? "\nall link-latency assertions passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

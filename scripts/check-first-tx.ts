/* eslint-disable no-console */
// The FIRST transmission of a contact: when it goes out, and when it is refused.
//
// WHAT THIS IS ABOUT. Every transmission after the first is scheduled from a decode of
// the station we are working, and 1.153.0 made those punctual by decoding the partner's
// ±100 Hz slice ahead of the band — measured live, replies went from a median 542 ms late
// to −1 ms. First calls did not move: they were, and remained, 1.3-1.4 s late, because at
// that moment there is no partner and nothing to point a slice at.
//
// There is something to point it at. In hunt mode the auto operator ranks every CQ it
// hears, and a station calling CQ transmits on one parity and listens on the other — so
// whoever called CQ two windows ago is very likely to be calling again in the window
// being cut now, on the same offset. That list is finished a full cycle before it is
// needed. The evidence it works is already in the log: a third call to OA4ENG went out at
// 0 ms instead of 1367 ms purely because the offset was known from an earlier decode. The
// rule is not "second transmission", it is "offset known".
//
// THE FAULTS THIS FILE HAS TO BE ABLE TO SEE. scripts/check-panadapter.ts records the
// rule: a test whose synthetic input cannot reproduce the real fault is worse than no
// test, because it passes while the fault ships. Four are available here.
//
//   1. THE DEAD ZONE in `firstTxWindow`. The old rule sent a transmission if there were
//      400 ms in hand, or if it was late but inside the tolerance. A lead BETWEEN 0 and
//      400 ms answered to neither, so the window was skipped and the call waited a full
//      thirty seconds. The automatic path lands there routinely — the log carries
//      `first transmission in 27.9s` forty times in one day. `the dead zone` below drives
//      the OLD rule and the new one over the same instants and shows the old one skipping.
//   2. MAKING THINGS FASTER MAKING THINGS WORSE. Because the dead zone sits ABOVE zero
//      lead, more delay used to make transmitting MORE likely. Any speed-up — the partner
//      slice, the candidate slice — moved the timing into the gap rather than past it.
//      Asserted directly: the timing the candidate slice produces is inside the old gap.
//   3. A CANDIDATE MISS COSTING SOMETHING. If the ranked candidate is not in the slice,
//      the window must behave exactly as it did before candidates existed: no event, no
//      deferral, the full pass in the same synchronous call.
//   4. THE TOLERANCE BEING WRONG PER MODE. FT8 is limited by its own window, FT4 and FT2
//      by what the far end can decode, and those are different numbers. Measured against
//      the real decoder here rather than reasoned.
//
// Real audio through the real decoder for everything that touches frequency or lateness.
// No radio, no network, no database.

import { EventEmitter } from "node:events";

import { DEFAULT_GUARDS, type QsoLogData } from "@/lib/digital/qso";
import { emptyWorkedIndex, type WorkedIndex } from "@/lib/digital/worth";
import { DAX_SAMPLE_RATE } from "@/lib/flex/dax";
import type { DigitalMode } from "@/lib/ham/digital-freqs";
import {
  anotherSliceFits,
  CANDIDATE_BUDGET_MS,
  CUT_MARGIN_MS,
  type Decode,
  DecodePipeline,
  MAX_CANDIDATE_SLICES,
  MAX_SLICE_WIDTH_HZ,
  PRIORITY_HALF_WIDTH_HZ,
  TRANSMISSION_MS,
} from "@/lib/radio/decode-pipeline";
import { PERIOD_MS, TX_START_OFFSET_MS } from "@/lib/radio/timing";
import type { DigitalTransmitter, TransmitOutcome } from "@/lib/radio/types";
import { buildWaveform, type TxMode } from "@/lib/radio/waveform";
import { lateTxToleranceMs, type QsoLogContext } from "@/services/radio/qso-controller";
import { buildOperating, type Operating, type OperatingDeps } from "@/services/radio/operating";

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
function eq<T>(a: T, b: T, label: string): void {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`,
  );
}

// ---------------------------------------------------------------------------
// A busy band, synthesised — the same ten stations check:decode-priority uses
// ---------------------------------------------------------------------------

const SIGNALS: [message: string, offsetHz: number][] = [
  ["CQ K1ABC FN42", 350],
  ["CQ DX W2XYZ EM12", 620],
  ["K9XYZ K3QRP -12", 905],
  ["CQ N4TST EL96", 1180],
  ["K5AAA W6BBB R-09", 1450],
  ["CQ VE7CCC CN89", 1725],
  ["K9XYZ DL2ABC RR73", 2010],
  ["CQ JA1DDD PM95", 2290],
  ["G4EEE F5FFF 73", 2560],
  ["CQ VK3GGG QF22", 2790],
];
/** Three stations calling CQ, well apart, for the multi-slice case. */
const CQ_A = { message: "CQ K1ABC FN42", offsetHz: 350, call: "K1ABC" };
const CQ_B = { message: "CQ N4TST EL96", offsetHz: 1180, call: "N4TST" };
const CQ_C = { message: "CQ JA1DDD PM95", offsetHz: 2290, call: "JA1DDD" };
/** Empty band. 200 Hz either side of this holds no signal at all. */
const EMPTY_OFFSET = 2150;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * One window of receive audio as the pipeline would have buffered it.
 *
 * `lateFor` places ONE station late by `lateMs` and leaves the rest on time, which is the
 * case the tolerance is about: our transmission is the late one and everybody else's
 * window is where it always was. Noise underneath, because a silent band is a different
 * decode — the candidate search has nothing to reject — and would understate every cost
 * measured here.
 */
function liveWindow(
  mode: TxMode,
  opts: { lateMs?: number; lateFor?: string; signals?: [string, number][] } = {},
): number[] {
  const signals = opts.signals ?? SIGNALS;
  const ms = TX_START_OFFSET_MS[mode] + TRANSMISSION_MS[mode] + CUT_MARGIN_MS;
  const buf = new Float32Array(Math.round((DAX_SAMPLE_RATE * ms) / 1000));
  for (const [message, offsetHz] of signals) {
    const late = opts.lateFor === undefined || message === opts.lateFor ? (opts.lateMs ?? 0) : 0;
    const lead = Math.round((DAX_SAMPLE_RATE * (TX_START_OFFSET_MS[mode] + late)) / 1000);
    const wave = buildWaveform(message, mode, offsetHz, DAX_SAMPLE_RATE);
    const n = Math.min(wave.length, buf.length - lead);
    for (let i = 0; i < n; i++) {
      buf[lead + i] = (buf[lead + i] as number) + (wave[i] as number) * 0.12;
    }
  }
  const rand = lcg(20260829);
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] as number) + (rand() - 0.5) * 0.02;
  return Array.from(buf);
}

interface SliceSeen {
  centreHz: number;
  loHz: number;
  hiHz: number;
  decodeMs: number;
  messages: string[];
}

interface Run {
  slices: SliceSeen[];
  full: Decode[] | null;
  fullRanSynchronously: boolean;
  errors: string[];
}

function watch(pipeline: DecodePipeline): Run {
  const run: Run = { slices: [], full: null, fullRanSynchronously: false, errors: [] };
  pipeline.on("priorityDecodes", (d) => {
    run.slices.push({
      centreHz: d.centreHz,
      loHz: d.loHz,
      hiHz: d.hiHz,
      decodeMs: d.decodeMs,
      messages: d.decodes.map((x) => x.message).sort(),
    });
  });
  pipeline.on("decodes", (d) => {
    run.full = d.decodes;
  });
  pipeline.on("error", (e) => run.errors.push(e.message));
  return run;
}

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
async function main(): Promise<void> {
  // =========================================================================
  console.log("\nthe arithmetic: slack, tolerance, and what the decoder actually reads");
  // =========================================================================
  // The lengths first, because every number below is derived from them and one of them
  // being wrong would make the rest agree with each other and with nothing else.
  for (const mode of ["FT8", "FT4", "FT2"] as TxMode[]) {
    const wave = buildWaveform("K9XYZ K5AAA -07", mode, 1450, DAX_SAMPLE_RATE);
    const realMs = Math.round((wave.length / DAX_SAMPLE_RATE) * 1000);
    eq(realMs, TRANSMISSION_MS[mode], `${mode}: the generated waveform really is ${TRANSMISSION_MS[mode]} ms`);
  }

  const slack: Record<TxMode, number> = { FT8: 0, FT4: 0, FT2: 0 };
  for (const mode of ["FT8", "FT4", "FT2"] as TxMode[]) {
    slack[mode] = PERIOD_MS[mode] - TX_START_OFFSET_MS[mode] - TRANSMISSION_MS[mode];
  }
  eq(slack.FT8, 1_860, "FT8 leaves 1,860 ms after a punctual transmission (15,000 - 500 - 12,640)");
  eq(slack.FT4, 1_960, "FT4 leaves 1,960 ms (7,500 - 500 - 5,040)");
  eq(slack.FT2, 1_803, "FT2 leaves 1,803 ms (3,750 - 0 - 1,947)");

  // THE TOLERANCE IS DERIVED FROM THOSE, not chosen. 0.8 of the slack, capped by what the
  // far end can actually decode — a different limit, and the one that binds on FT4 and FT2.
  //
  // THE FRACTION WAS 0.5, AND 0.5 WAS MEASURED WRONG IN SERVICE. At 0.5 the FT8 limit came
  // out at 930 ms, and on 2026-08-30 the live station refused 72 first calls in a morning
  // (lateness p50 1,359 ms, p90 1,673 ms) while the sends that did go out averaged ~400 ms.
  // Every refusal wastes a full cycle; the operator watched a picked CQ sit through three.
  // The hardcoded 1,500 ms this replaced had operated for months without a decode
  // complaint — field evidence the halving threw away. 0.8 restores that number (1,488)
  // while still ending 372 ms before the window closes.
  eq(lateTxToleranceMs("FT8"), 1_488, "FT8 tolerance is 0.8 of its slack — the field-proven 1,500, rederived");
  eq(lateTxToleranceMs("FT4"), 800, "FT4 tolerance is 800 — the DECODER binds, well under half of 1,960");
  eq(lateTxToleranceMs("FT2"), 0, "FT2 tolerance is zero, and no arithmetic gets a vote");
  for (const mode of ["FT8", "FT4", "FT2"] as TxMode[]) {
    ok(
      lateTxToleranceMs(mode) <= slack[mode],
      `${mode}: a transmission at the tolerance still ends inside its own window`,
      `${lateTxToleranceMs(mode)} against ${slack[mode]} of slack`,
    );
  }
  // The regression this replaces: 1,500 ms of a 1,860 ms slack is 80% of it, and the live
  // instrumentation measured transmissions overrunning the period by up to 367 ms.
  ok(
    slack.FT8 - lateTxToleranceMs("FT8") > 367,
    "and the reserve left over is more than the worst overrun measured live (367 ms)",
    `${slack.FT8 - lateTxToleranceMs("FT8")} ms reserve`,
  );
  ok(
    slack.FT8 - 1_500 < 367,
    "which the old 1,500 was NOT — this fixture can see the value it replaces being wrong",
    `${slack.FT8 - 1_500} ms reserve at the old tolerance`,
  );

  // =========================================================================
  console.log("\nhow late the real decoder still reads a transmission");
  // =========================================================================
  // MEASURED, one station placed late in the ten-signal window, everyone else on time.
  // This is the ceiling the arithmetic above is capped by, and it differs per mode by
  // more than the arithmetic ever would.
  // ASYNC SINCE THE DECODER MOVED TO ITS OWN THREAD. `processWindow` resolves when the
  // worker answers; reading `found` on the next line reads it before there is an answer.
  async function readsAt(mode: TxMode, lateMs: number, target: string): Promise<boolean> {
    const p = new DecodePipeline({ mode, inputSampleRate: DAX_SAMPLE_RATE, silenceRms: 1e-5 });
    let found = false;
    p.on("decodes", (d) => {
      found = d.decodes.some((x) => x.message === target);
    });
    await p.processWindow(liveWindow(mode, { lateMs, lateFor: target }), new Date(0));
    p.stop();
    return found;
  }
  const TARGET = "K5AAA W6BBB R-09";

  ok(await readsAt("FT8", lateTxToleranceMs("FT8"), TARGET), "FT8 at its tolerance (1,488 ms late) decodes");
  ok(await readsAt("FT8", slack.FT8, TARGET), "FT8 at its FULL slack (1,860 ms) still decodes — no cliff inside the window");
  ok(await readsAt("FT4", lateTxToleranceMs("FT4"), TARGET), "FT4 at its tolerance (800 ms late) decodes");
  ok(!(await readsAt("FT4", 1_000, TARGET)), "FT4 at 1,000 ms does NOT — the cliff is real and 800 sits inside it");
  ok(await readsAt("FT2", 400, TARGET), "FT2 at 400 ms late decodes");
  ok(
    !await readsAt("FT2", 500, TARGET),
    "FT2 at 500 ms does NOT — its DT search spans half a second, which is why its tolerance is zero",
  );
  ok(
    !await readsAt("FT2", Math.floor(slack.FT2 / 2), TARGET),
    "and a slack-only derivation would have given FT2 901 ms, which is unreadable — the pin is load-bearing",
  );

  // =========================================================================
  console.log("\nthe dead zone in firstTxWindow");
  // =========================================================================
  // THE OLD RULE, verbatim, so what it did can be shown rather than described. Two tests
  // with a gap between them: 400 ms of lead, or late but inside the tolerance.
  const OLD_LEAD_MS = 400;
  const OLD_TOLERANCE: Record<TxMode, number> = { FT8: 1_500, FT4: 800, FT2: 0 };
  function oldRule(mode: TxMode, txParity: 0 | 1, now: number): number | null {
    const period = PERIOD_MS[mode];
    const current = Math.floor(now / period) * period;
    for (let i = 0; i < 4; i++) {
      const w = current + i * period;
      if (Math.floor(w / period) % 2 !== txParity) continue;
      const lead = w + TX_START_OFFSET_MS[mode] - now;
      if (lead >= OLD_LEAD_MS) return w;
      if (lead < 0 && -lead <= OLD_TOLERANCE[mode]) return w;
    }
    return null;
  }

  const P = PERIOD_MS.FT8;
  const T0 = 1_800_000_000_000; // exactly divisible by 15,000; parity 0
  const OUR_WINDOW = T0 + P; // parity 1 — the window we would answer their CQ in
  const OUR_PARITY: 0 | 1 = 1;

  // Every instant is expressed as milliseconds past OUR window's boundary, which is how
  // the live measurements are quoted.
  const cases: { past: number; label: string }[] = [
    { past: 398, label: "decode-only timing: lead +102 ms" },
    { past: 500, label: "exactly on the due instant: lead 0" },
    { past: 900, label: "400 ms late" },
    { past: 1_400, label: "900 ms late" },
    { past: 1_900, label: "1,400 ms late — the measured first-call timing today" },
  ];
  console.log("        past boundary   old rule            new rule");
  for (const c of cases) {
    const now = OUR_WINDOW + c.past;
    const old = oldRule("FT8", OUR_PARITY, now);
    const scheduled = await scheduleFirstCall(now);
    const fmt = (w: number | null): string =>
      w === null ? "nothing" : w === OUR_WINDOW ? "this window" : `+${(w - OUR_WINDOW) / 1000}s`;
    console.log(`        ${String(c.past).padStart(5)} ms      ${fmt(old).padEnd(20)}${fmt(scheduled)}`);
  }

  // FAULT 1, shown rather than asserted away.
  eq(
    oldRule("FT8", OUR_PARITY, OUR_WINDOW + 398),
    OUR_WINDOW + 2 * P,
    "OLD: a lead of +102 ms satisfied neither branch, so the call waited two more periods",
  );
  eq(
    await scheduleFirstCall(OUR_WINDOW + 398),
    OUR_WINDOW,
    "NEW: the same instant transmits in this window — thirty seconds saved",
  );
  eq(await scheduleFirstCall(OUR_WINDOW + 500), OUR_WINDOW, "a lead of exactly 0 transmits");
  eq(await scheduleFirstCall(OUR_WINDOW + 499), OUR_WINDOW, "and so does every millisecond above it");
  // The whole dead zone, swept. There must be no instant between the two old branches
  // that the new rule refuses.
  {
    const skipped: number[] = [];
    for (let past = 0; past <= 500; past += 10) {
      if ((await scheduleFirstCall(OUR_WINDOW + past)) !== OUR_WINDOW) skipped.push(past);
    }
    eq(skipped, [], "no instant in the old 0-400 ms gap is refused any more");
  }
  // FAULT 2: the old rule got MORE likely to transmit as the station got slower, which is
  // what made speeding it up dangerous.
  ok(
    oldRule("FT8", OUR_PARITY, OUR_WINDOW + 398) !== OUR_WINDOW &&
      oldRule("FT8", OUR_PARITY, OUR_WINDOW + 1_900) === OUR_WINDOW,
    "OLD: being 1.4 s late transmitted while being 102 ms EARLY did not — more delay, more likely to send",
  );

  // The new rule still refuses what it should. Past the tolerance the transmission would
  // not finish inside its own window, and a 30 s wait is the lesser evil.
  eq(
    await scheduleFirstCall(OUR_WINDOW + 2_200),
    OUR_WINDOW + 2 * P,
    "1,700 ms late is past the tolerance and waits — the trade made in the open",
  );
  {
    // The exact edge: lateBy = KEY_PREP_MS - lead, accepted while <= the FT8 tolerance.
    const edge = OUR_WINDOW + TX_START_OFFSET_MS.FT8 + (lateTxToleranceMs("FT8") - 100);
    eq(await scheduleFirstCall(edge), OUR_WINDOW, "the last instant inside the tolerance transmits");
    eq(await scheduleFirstCall(edge + 20), OUR_WINDOW + 2 * P, "and the first one outside it does not");
  }

  // =========================================================================
  console.log("\nthe candidate's slice");
  // =========================================================================
  const samples = liveWindow("FT8");
  const WINDOW_AT = new Date(T0);

  // The baseline: nothing supplied at all.
  const plain = new DecodePipeline({ mode: "FT8", inputSampleRate: DAX_SAMPLE_RATE, silenceRms: 1e-5 });
  const plainRun = watch(plain);
  await plain.processWindow(samples, WINDOW_AT);
  const baseline = (plainRun.full ?? []).map((d) => d.message).sort();
  ok(plainRun.slices.length === 0, "no partner and no candidates, no priority pass at all");
  ok(baseline.length >= 8, "the fixture is a busy band, not one signal", `${baseline.length} decodes`);

  // One candidate.
  {
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      candidateOffsetsHz: () => [CQ_B.offsetHz],
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    eq(run.slices.length, 1, "one candidate, one slice");
    eq(run.slices[0]?.loHz, CQ_B.offsetHz - PRIORITY_HALF_WIDTH_HZ, "centred on them, 100 Hz below");
    eq(run.slices[0]?.hiHz, CQ_B.offsetHz + PRIORITY_HALF_WIDTH_HZ, "and 100 Hz above");
    ok(run.slices[0]?.messages.includes(CQ_B.message) === true, "and it finds their CQ");
    eq((run.full ?? []).map((d) => d.message).sort(), baseline, "the window's decodes are unchanged");
    eq(
      (run.full ?? []).filter((d) => d.message === CQ_B.message).length,
      1,
      "the candidate appears exactly once — no duplicate row, spot or decode-list entry",
    );
    console.log(`        one slice: ${run.slices[0]?.decodeMs} ms`);
  }

  // Three candidates, spread out.
  {
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      candidateOffsetsHz: () => [CQ_A.offsetHz, CQ_B.offsetHz, CQ_C.offsetHz],
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    ok(
      run.slices.length >= 1 && run.slices.length <= MAX_CANDIDATE_SLICES,
      "several candidates are searched, never more than the cap",
      `${run.slices.length} slices`,
    );
    const spent = run.slices.reduce((a, s) => a + s.decodeMs, 0);
    console.log(`        ${run.slices.length} slices, ${spent} ms total (budget ${CANDIDATE_BUDGET_MS} ms)`);
    eq((run.full ?? []).map((d) => d.message).sort(), baseline, "and the band still decodes exactly as it did");
    const dupes = baseline.filter(
      (m) => (run.full ?? []).filter((d) => d.message === m).length > 1,
    );
    eq(dupes, [], "with no message appearing twice, however many slices found it");
  }

  // Overlapping candidates become one search.
  {
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      candidateOffsetsHz: () => [1_450, 1_500, 1_520],
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    eq(run.slices.length, 1, "three candidates inside 100 Hz of each other are ONE slice, not three");
    eq(run.slices[0]?.loHz, 1_350, "widened down to the lowest");
    eq(run.slices[0]?.hiHz, 1_620, "and up to the highest");
  }

  // MERGING STOPS WHERE IT STOPS PAYING. Measured on this machine: a 200 Hz search is
  // 113 ms and a 400 Hz one 118 ms — the cost is nearly all fixed under 400 Hz — but a
  // 600 Hz search is 189 ms and a 1,030 Hz one covering two candidates is 360 ms against
  // 278 ms for the two separate searches it replaced. Past MAX_SLICE_WIDTH_HZ, merging is
  // the more expensive answer.
  {
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      // A chain, each within 200 Hz of the last: 1,000 / 1,150 / 1,300 / 1,450 / 1,600.
      // Merged without a bound this would be one 800 Hz search, and the cap on the NUMBER
      // of slices would never have fired.
      candidateOffsetsHz: () => [1_000, 1_150, 1_300, 1_450, 1_600],
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    const widest = Math.max(...run.slices.map((x) => x.hiHz - x.loHz));
    ok(
      widest <= MAX_SLICE_WIDTH_HZ,
      "a chain of near neighbours never widens one slice past the point merging pays",
      `widest ${widest} Hz against a ${MAX_SLICE_WIDTH_HZ} Hz cap`,
    );
    ok(
      run.slices.length <= MAX_CANDIDATE_SLICES,
      "and the number of them is still capped",
      `${run.slices.length} slices`,
    );
  }

  // THE PARTNER WINS. A live contact must not spend its margin on stations it is not
  // going to answer.
  {
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      priorityOffsetHz: () => 1_450,
      candidateOffsetsHz: () => [CQ_A.offsetHz, CQ_B.offsetHz, CQ_C.offsetHz],
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    eq(run.slices.length, 1, "a contact in progress searches exactly one slice");
    eq(run.slices[0]?.centreHz, 1_450, "and it is the partner's, not any candidate's");
  }

  // FAULT 3: a miss must cost nothing beyond the look.
  {
    let pending = false;
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      candidateOffsetsHz: () => [EMPTY_OFFSET],
      // Would defer if the slice had found anything. It must never get that far.
      transmitPending: () => {
        pending = true;
        return true;
      },
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    eq(run.slices.length, 0, "a candidate who is not transmitting emits no event at all");
    ok(run.full !== null, "and the full pass ran synchronously, in the same call");
    ok(!pending, "the transmitter was never even asked — there is nothing to defer behind");
    eq((run.full ?? []).map((d) => d.message).sort(), baseline, "with the whole band in it, unchanged");
    eq(run.errors, [], "and nothing was reported as an error");
  }

  // A candidate above the searched passband cannot have been decoded here in the first
  // place, so there is nothing to prioritise.
  {
    const pipe = new DecodePipeline({
      mode: "FT8",
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      maxHz: 3_000,
      candidateOffsetsHz: () => [4_500, -20, Number.NaN],
    });
    const run = watch(pipe);
    await pipe.processWindow(samples, WINDOW_AT);
    eq(run.slices.length, 0, "offsets outside the passband are refused, not clamped into a nonsense slice");
    ok((run.full ?? []).length >= 8, "and the band still decodes normally");
  }

  // FT4 and FT2 take no candidate slices, for the reasons already measured in
  // check:decode-priority — narrowing FT4 is slower AND lossier, and FT2's window is cut
  // after the transmission that would answer it was due.
  for (const mode of ["FT4", "FT2"] as const) {
    const pipe = new DecodePipeline({
      mode,
      inputSampleRate: DAX_SAMPLE_RATE,
      silenceRms: 1e-5,
      candidateOffsetsHz: () => [CQ_B.offsetHz],
      transmitPending: () => true,
    });
    const run = watch(pipe);
    await pipe.processWindow(liveWindow(mode), new Date(0));
    eq(run.slices.length, 0, `${mode}: no candidate pass, even with offsets supplied`);
    ok((run.full ?? []).length >= 5, `${mode}: and the full pass runs exactly as before`);
  }

  // =========================================================================
  console.log("\nthe budget, on this machine and on the live one");
  // =========================================================================
  // The behaviour cannot be shown here in both directions — this machine cannot be made
  // as slow as the live box — so the RULE is asserted with both machines' measured slice
  // costs. Dev: 95-98 ms. Live (Xeon E5-2630 v3): 420-476 ms.
  {
    const count = (sliceMs: number): number => {
      let n = 1;
      let spent = sliceMs;
      while (n < MAX_CANDIDATE_SLICES && anotherSliceFits(spent, sliceMs)) {
        n++;
        spent += sliceMs;
      }
      return n;
    };
    console.log(`        98 ms a slice -> ${count(98)} slices;  476 ms a slice -> ${count(476)} slices`);
    eq(count(98), 3, "on this machine three slices fit inside the budget");
    eq(count(476), 1, "on the live box exactly one does — the same constant, no second number");
    ok(!anotherSliceFits(476, 476), "a live-box slice never authorises a second");
    ok(anotherSliceFits(0, CANDIDATE_BUDGET_MS), "a slice costing the whole budget is still allowed to have run");
    ok(!anotherSliceFits(1, CANDIDATE_BUDGET_MS), "but nothing may follow it");
  }

  // =========================================================================
  console.log("\nthe auto operator: where the offsets come from");
  // =========================================================================
  await autoOperatorChecks();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// The operating layer, with a clock the fixture owns
// ---------------------------------------------------------------------------

const STATION = { id: "st1", callsign: "K9XYZ", grid: "EN52wa" };
const DIAL_HZ = 14_074_000;
const PERIOD = PERIOD_MS.FT8;
const BASE = 1_800_000_000_000;

interface Heard {
  message: string;
  snr: number;
  freqOffset: number;
}

class FakeSource extends EventEmitter {
  readonly periodMs = PERIOD;
  mode: DigitalMode = "FT8";
  at = BASE;
  now(): number {
    return this.at;
  }
  /** A receive window whose full-band decode has just finished. */
  window(windowStartMs: number, heard: Heard[], atMs?: number): void {
    this.at = atMs ?? windowStartMs + PERIOD + 400;
    this.emit("decodes", {
      windowStart: new Date(windowStartMs),
      decodes: heard.map((h) => ({ ...h, dt: 0.1, mode: this.mode })),
      rms: 0.01,
      decodeMs: 1_558,
    });
  }
  /** Our own transmit window: no receive audio, so only `window` fires. */
  ourWindow(windowStartMs: number): void {
    this.at = windowStartMs + PERIOD + 400;
    this.emit("window", { windowStart: new Date(windowStartMs), samples: 180_000, rms: 1e-3, skipped: true });
  }
}

class FakeTx implements DigitalTransmitter {
  readonly sent: { message: string; offsetHz: number; startAt: number }[] = [];
  async transmit(req: { message: string; mode: DigitalMode; offsetHz: number; startAt: number }): Promise<TransmitOutcome> {
    this.sent.push({ message: req.message, offsetHz: req.offsetHz, startAt: req.startAt });
    return { sent: true, message: req.message, startedAt: req.startAt, timingErrorMs: 0, packetsSent: 2_370 };
  }
  async unkey(): Promise<void> {}
}

class FakeSettings {
  constructor(private readonly rows: Record<string, string> = {}) {}
  async getString(key: string): Promise<string | null> {
    return this.rows[key] ?? null;
  }
  async getNumber(key: string, fallback: number): Promise<number> {
    const raw = this.rows[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  async getBoolean(key: string, fallback: boolean): Promise<boolean> {
    const raw = this.rows[key];
    if (raw === undefined) return fallback;
    return raw === "true";
  }
}

async function makeOperating(
  source: FakeSource,
  tx: FakeTx,
  entityLookups?: { n: number },
): Promise<Operating> {
  return buildOperating({
    kind: "flex",
    // TWO WINDOWS, which is what this whole scenario was written against — its own comment
    // below says so. Production listens 90 s before judging a band (6 FT8 windows), which
    // is the fix for a station that hopped every 15 s in FT4 without ever hearing
    // anything. What is being measured here is what happens AFTER the warm-up; its length
    // is asserted directly in check:band-hop.
    warmupMs: 30_000,
    source: source as unknown as OperatingDeps["source"],
    tx,
    station: STATION,
    dialHz: () => DIAL_HZ,
    now: () => source.now(),
    radio: () => "FLEX-6400",
    retune: async () => true,
    tuneHz: async () => true,
    broadcast: () => {},
    log: () => {},
    settings: new FakeSettings(),
    data: {
      wasWorked: async () => false,
      workedOnBandEver: async () => false,
      listedAs: async () => null,
      logQso: async (_l: QsoLogData, _ctx: QsoLogContext) => {},
      recordIncomplete: async () => {},
      workedIndex: async (): Promise<WorkedIndex> => emptyWorkedIndex(),
      resolveEntity: async () => {
        if (entityLookups) entityLookups.n++;
        return null;
      },
      potaSpots: async () => [],
    },
  });
}

/**
 * Where the controller schedules a first call made at `now`, as a window boundary.
 *
 * Drives the REAL `startCall`, not a copy of `firstTxWindow`: the dead zone was in the
 * shipped path and a re-implementation could not have shown it.
 */
async function scheduleFirstCall(now: number): Promise<number | null> {
  const source = new FakeSource();
  const tx = new FakeTx();
  const op = await makeOperating(source, tx);
  // Their CQ decoded in the window before ours, which fixes the parity.
  source.at = now;
  await op.qsoController.startCall({
    theirCall: "OA4ENG",
    theirSnr: -7,
    theirOffsetHz: 1_180,
    theirWindowStart: BASE,
    theirMessage: "CQ OA4ENG FH17",
  });
  await settle();
  return tx.sent.length === 0 ? null : (tx.sent[0]?.startAt ?? null);
}

async function autoOperatorChecks(): Promise<void> {
  // -- the list, and the parity rule that makes it mean anything ------------
  {
    const source = new FakeSource();
    const tx = new FakeTx();
    const op = await makeOperating(source, tx);
    const auto = op.autoOperator;
    auto.setMode("hunt");
    eq(auto.candidateOffsetsHz(BASE), [], "nothing has been heard yet, so nothing is prioritised");

    // Warm-up is two windows and nothing is ranked during it.
    source.window(BASE, [{ message: "CQ OA4ENG FH17", snr: -7, freqOffset: 1_180 }]);
    await settle();
    source.window(BASE + PERIOD, [{ message: "CQ K1ABC FN42", snr: -3, freqOffset: 350 }]);
    await settle();
    eq(auto.candidateOffsetsHz(BASE + 2 * PERIOD), [], "warm-up windows rank nothing — there is no first call to save yet");

    // Past warm-up. Their CQ in this window is the candidate for the NEXT window of the
    // SAME parity. The ordinary hunt calls the best of them straight away, which is the
    // normal outcome and not what is being measured here — halted, so the question the
    // list answers ("who WOULD we call") is asked with nobody being called.
    source.window(BASE + 2 * PERIOD, [
      { message: "CQ OA4ENG FH17", snr: -7, freqOffset: 1_180 },
      { message: "CQ VK3GGG QF22", snr: -18, freqOffset: 2_790 },
    ]);
    await settle();
    await op.qsoController.halt();
    const two = auto.candidateOffsetsHz(BASE + 4 * PERIOD);
    ok(two.length >= 1, "a hunted window leaves a candidate list behind", JSON.stringify(two));
    eq(two[0], 1_180, "best first — the stronger station leads");
    eq(
      auto.candidateOffsetsHz(BASE + 3 * PERIOD),
      [],
      "the NEXT window is the other parity: those stations are listening, not transmitting",
    );
    eq(
      auto.candidateOffsetsHz(BASE + 6 * PERIOD),
      [],
      "and two cycles on it is stale — a minute-old offset is a miss that costs a slice",
    );
  }

  // -- the list is kept up to date THROUGH a contact ------------------------
  //
  // THE CASE THAT MATTERS MOST. The commonest first call in the log is the one straight
  // after a contact ends, and during a contact the ordinary hunt never runs. If the
  // ranking lived inside `huntWindow` the list would be a minute stale at exactly that
  // moment, and the candidate slice would be pointed at nobody.
  {
    const source = new FakeSource();
    const tx = new FakeTx();
    const op = await makeOperating(source, tx);
    const auto = op.autoOperator;
    auto.setMode("hunt");
    source.window(BASE, []);
    await settle();
    source.window(BASE + PERIOD, []);
    await settle();

    await op.qsoController.startCall({
      theirCall: "K5AAA",
      theirSnr: -7,
      theirOffsetHz: 1_450,
      theirWindowStart: BASE + 2 * PERIOD,
      theirMessage: "CQ K5AAA EM12",
    });
    await settle();
    ok(op.qsoController.hasActive, "a contact is in progress");

    // A window of THEIR parity, mid-contact: our partner plus somebody else calling CQ.
    source.window(BASE + 4 * PERIOD, [
      { message: "K9XYZ K5AAA -07", snr: -7, freqOffset: 1_450 },
      { message: "CQ OA4ENG FH17", snr: -9, freqOffset: 1_180 },
    ]);
    await settle();
    eq(
      auto.candidateOffsetsHz(BASE + 6 * PERIOD),
      [],
      "while the contact runs the partner slice owns the window and the candidate list stands down",
    );

    await op.qsoController.halt();
    ok(!op.qsoController.hasActive, "the contact ends");
    eq(
      auto.candidateOffsetsHz(BASE + 6 * PERIOD),
      [1_180],
      "and the list ranked DURING it is there waiting — the first call after a QSO is the one to save",
    );
  }

  // -- the fast path: a candidate's slice starts the contact ----------------
  {
    const source = new FakeSource();
    const tx = new FakeTx();
    const op = await makeOperating(source, tx);
    const auto = op.autoOperator;
    auto.setMode("hunt");
    source.window(BASE, []);
    await settle();
    source.window(BASE + PERIOD, []);
    await settle();

    // The ordinary path, once, so the list exists and the comparison is fair: this is the
    // 1.3-1.4 s late first call the whole change is about.
    source.window(BASE + 2 * PERIOD, [
      { message: "CQ OA4ENG FH17", snr: -7, freqOffset: 1_180 },
      { message: "CQ K1ABC FN42", snr: -12, freqOffset: 350 },
    ]);
    await settle();
    eq(tx.sent.length, 1, "the ordinary hunt called them from the full pass, as it always did");
    await op.qsoController.halt();
    const before = tx.sent.length;

    // Now the next window of the SAME parity — the one the list predicts. The pipeline
    // cuts it at +13,840 ms and has the 1,180 Hz slice decoded a hundred milliseconds
    // later, which is where the fast path runs.
    const target = BASE + 4 * PERIOD;
    source.at = target + TRANSMISSION_MS.FT8 + CUT_MARGIN_MS + 100;
    eq(
      auto.candidateOffsetsHz(target),
      [1_180, 350],
      "the pipeline is told where to look, best first, before the window is decoded",
    );
    ok(!auto.callPending, "and nothing is pending yet");
    auto.onPriorityDecodes({
      windowStart: new Date(target),
      decodes: [{ message: "CQ OA4ENG FH17", snr: -6, freqOffset: 1_182 }],
    });
    ok(auto.callPending, "the flag is set SYNCHRONOUSLY, before any database read — see callPending");
    await settle(60);
    ok(!auto.callPending, "and cleared once the attempt has settled");
    eq(tx.sent.length, before + 1, "the candidate's slice alone started the contact");
    const first = tx.sent[tx.sent.length - 1]!;
    eq(first.startAt, target + PERIOD, "in the very next window");
    eq(first.offsetHz, 1_182, "on THIS window's offset, not the remembered one");
    const leadMs = first.startAt + TX_START_OFFSET_MS.FT8 - source.now();
    ok(leadMs > 0, "with the transmission still ahead of us — a punctual first call", `${leadMs} ms of lead`);
    console.log(`        candidate call scheduled with ${leadMs} ms of lead, before any database read`);

    // The window's own decodes arrive a second later. They must not start a second call.
    source.window(target, [
      { message: "CQ OA4ENG FH17", snr: -6, freqOffset: 1_182 },
      { message: "CQ K1ABC FN42", snr: -3, freqOffset: 350 },
    ]);
    await settle();
    eq(tx.sent.length, before + 1, "the full pass finds the contact already running and starts nothing");
  }

  // -- and the same call with the database in the way ----------------------
  //
  // THE FIXTURE ABOVE HAS NO DATABASE, AND THE LIVE STATION DOES. Between the slice and
  // the transmitter sit `mayCall` (the do-not-call list, the band slot, the dupe index)
  // and `startCall`'s own guard, and on the live box that chain is where most of the
  // measured 1.3-1.4 s goes. So the interesting question is not "is the ideal case
  // punctual" — it obviously is — but how much of that chain the window survives, and
  // what happens on either side of the edge.
  //
  // THE COLUMN THAT MATTERS IS THE MIDDLE ONE. Everything from 1,161 ms of database work
  // to 1,560 ms lands in the old dead zone: a lead between 0 and 400 ms, which the old
  // rule refused outright and sent to a thirty-second wait. That is the trap this change
  // had to defuse before it could be allowed to make anything faster.
  {
    console.log("        db work   lead     old rule     new rule");
    const rows: { extra: number; lead: number; oldW: string; newW: string }[] = [];
    for (const extra of [0, 800, 1_200, 1_560, 1_600, 2_390, 2_400, 2_940, 2_960]) {
      const source = new FakeSource();
      const tx = new FakeTx();
      const op = await makeOperating(source, tx);
      const auto = op.autoOperator;
      auto.setMode("hunt");
      source.window(BASE, []);
      await settle();
      source.window(BASE + PERIOD, []);
      await settle();
      source.window(BASE + 2 * PERIOD, [{ message: "CQ OA4ENG FH17", snr: -7, freqOffset: 1_180 }]);
      await settle();
      await op.qsoController.halt();
      const before = tx.sent.length;

      const target = BASE + 4 * PERIOD;
      // The slice is decoded 100 ms after the cut; `extra` is everything after that.
      source.at = target + TRANSMISSION_MS.FT8 + CUT_MARGIN_MS + 100 + extra;
      const lead = target + PERIOD + TX_START_OFFSET_MS.FT8 - source.now();
      auto.onPriorityDecodes({
        windowStart: new Date(target),
        decodes: [{ message: "CQ OA4ENG FH17", snr: -6, freqOffset: 1_182 }],
      });
      await settle(60);
      const sent = tx.sent.length > before ? tx.sent[tx.sent.length - 1]! : null;
      const newW =
        sent === null ? "nothing" : sent.startAt === target + PERIOD ? "next window" : "+30s";
      const oldW = lead >= 400 ? "next window" : lead < 0 && -lead <= 1_500 ? "next window" : "+30s";
      rows.push({ extra, lead, oldW, newW });
      console.log(
        `        ${String(extra).padStart(5)} ms  ${String(lead).padStart(6)}   ` +
          `${oldW.padEnd(13)}${newW}`,
      );
    }

    const inDeadZone = rows.filter((r) => r.lead >= 0 && r.lead < 400);
    ok(inDeadZone.length > 0, "the fixture reaches the old dead zone at all", `${inDeadZone.length} rows`);
    eq(
      inDeadZone.map((r) => r.oldW),
      inDeadZone.map(() => "+30s"),
      "OLD: every one of those was a thirty-second wait",
    );
    eq(
      inDeadZone.map((r) => r.newW),
      inDeadZone.map(() => "next window"),
      "NEW: every one of them transmits in the window it belongs to",
    );
    // The edge moved with the tolerance: 930 ms put it at 2,390 ms of database work,
    // 1,488 ms puts it at ~2,948. The rows that used to be the edge are now comfortably
    // inside, which is the point of the change — those were real refusals on the air.
    eq(
      rows.filter((r) => r.extra <= 2_940).map((r) => r.newW),
      rows.filter((r) => r.extra <= 2_940).map(() => "next window"),
      "the whole chain up to the tolerance edge survives — 2.94 s of database work and still on the air",
    );
    eq(
      rows.find((r) => r.extra === 2_960)?.newW,
      "+30s",
      "and past it the call waits rather than transmitting where it cannot finish",
    );
  }

  // -- the chain the MISS path still has to run through ---------------------
  //
  // The candidate slice makes the window where it hits punctual, and makes the window
  // where it misses slightly WORSE — the slice is decoded before the full pass either
  // way. On the live box that is about 450 ms added to a path already measured at
  // 1.3-1.4 s late, and the dominant cost in that path is not the decode: it is one DXCC
  // lookup per station calling CQ, twenty or thirty of them, between the decodes arriving
  // and the call going out. So the same change that adds a slice has to take that back.
  //
  // REASONED, NOT MEASURED, on the milliseconds: there is no database on this machine.
  // What is asserted is the lookup COUNT, which is what the milliseconds are made of.
  {
    const source = new FakeSource();
    const tx = new FakeTx();
    const lookups = { n: 0 };
    const op = await makeOperating(source, tx, lookups);
    const auto = op.autoOperator;
    auto.setMode("hunt");
    const band = [
      { message: "CQ K1ABC FN42", snr: -3, freqOffset: 350 },
      { message: "CQ N4TST EL96", snr: -9, freqOffset: 1_180 },
      { message: "CQ JA1DDD PM95", snr: -14, freqOffset: 2_290 },
      { message: "CQ VK3GGG QF22", snr: -18, freqOffset: 2_790 },
    ];
    // Two warm-up windows, which rank nothing, then six that do.
    source.window(BASE, band);
    await settle();
    source.window(BASE + PERIOD, band);
    await settle();
    eq(lookups.n, 0, "warm-up ranks nothing, so it asks the database nothing");

    let ranked = 0;
    for (let i = 2; i < 8; i++) {
      source.window(BASE + i * PERIOD, band);
      ranked++;
      await settle();
      if (op.qsoController.hasActive) await op.qsoController.halt();
    }
    console.log(
      `        ${lookups.n} entity lookups over ${ranked} ranked windows of the same ${band.length} stations ` +
        `(${ranked * band.length} without the memo)`,
    );
    eq(lookups.n, band.length, "one lookup per CALLSIGN, not one per callsign per window");
    ok(
      lookups.n < ranked * band.length,
      "which is the whole point: the same stations call CQ window after window",
      `${lookups.n} against ${ranked * band.length}`,
    );

    // The ranking itself must be unaffected — a memo that changed the answer would be
    // worse than the queries it saves.
    await op.qsoController.halt();
    eq(
      auto.candidateOffsetsHz(BASE + 9 * PERIOD),
      [350, 1_180, 2_290, 2_790],
      "and the ranked list is the same one, in the same order, strongest first",
    );
  }

  // -- a miss on the fast path changes nothing ------------------------------
  {
    const source = new FakeSource();
    const tx = new FakeTx();
    const op = await makeOperating(source, tx);
    const auto = op.autoOperator;
    auto.setMode("hunt");
    source.window(BASE, []);
    await settle();
    source.window(BASE + PERIOD, []);
    await settle();
    source.window(BASE + 2 * PERIOD, [{ message: "CQ OA4ENG FH17", snr: -7, freqOffset: 1_180 }]);
    await settle();
    await op.qsoController.halt();
    const before = tx.sent.length;
    const wasSaying = auto.state.lastAction;
    const target = BASE + 4 * PERIOD;
    source.at = target + TRANSMISSION_MS.FT8 + CUT_MARGIN_MS + 100;

    // The slice ran and found somebody — just not the candidate.
    auto.onPriorityDecodes({
      windowStart: new Date(target),
      decodes: [{ message: "CQ K1ABC FN42", snr: -3, freqOffset: 350 }],
    });
    await settle();
    eq(tx.sent.length, before, "a slice with none of our candidates in it transmits nothing");
    ok(!auto.callPending, "and nothing is left pending to hold the band's decodes");
    eq(auto.state.lastAction, wasSaying, "and the status line is left alone for the full pass");

    // The candidate answering somebody else is not a candidate either: the list ranks
    // CQs, and opening a contact with a station mid-exchange is wrong.
    auto.onPriorityDecodes({
      windowStart: new Date(target),
      decodes: [{ message: "W1XYZ OA4ENG -12", snr: -6, freqOffset: 1_180 }],
    });
    await settle();
    eq(tx.sent.length, before, "a candidate working somebody else is not called");

    // And the window's own decodes still do the ordinary thing.
    source.window(target, [{ message: "CQ OA4ENG FH17", snr: -7, freqOffset: 1_180 }]);
    await settle();
    eq(tx.sent.length, before + 1, "the full pass calls them, exactly as it did before candidates existed");
  }
}

void main();

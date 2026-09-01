/* eslint-disable no-console */
// The operating layer, characterised: guards, QSO controller, auto operator.
//
// WHY THIS EXISTS. The block that builds these three lives inline inside
// `startFlexSource()` in services/radio/index.ts — roughly 255 lines that can only run
// with a FlexRadio on the other end of a socket. It is about to be lifted out so the
// Icom can use it too, and that file drives this station every day.
//
// So the behaviour is pinned down FIRST, the way the decode-pipeline extraction was done
// in 0.86.0: write the test, move the code, prove not one assertion changed. Everything
// below the `makeOperating` factory is the characterisation. The factory is the only
// thing the extraction is allowed to touch, and `git diff` is what proves it.
//
// No radio, no network and NO DATABASE. The settings reader and the four data lookups
// are injected, which is also exactly what the extracted `buildOperating` will need in
// order to be callable from two places.
//
// The other claim this file makes is the one the whole extraction is for: run the SAME
// scenario with FlexRadio-shaped dependencies and Icom-shaped dependencies and the
// observations must be byte-identical. The only thing that differs between the two
// radios is how the dial gets moved.

import { EventEmitter } from "node:events";

import { DEFAULT_GUARDS, type QsoLogData } from "@/lib/digital/qso";
import { formatTranscript, TRANSCRIPT_MAX_ENTRIES } from "@/lib/digital/transcript";
import { emptyWorkedIndex, type WorkedIndex } from "@/lib/digital/worth";
import type { DigitalMode } from "@/lib/ham/digital-freqs";
import type { DigitalTransmitter, TransmitOutcome } from "@/lib/radio/types";
import type { QsoLogContext } from "@/services/radio/qso-controller";
import {
  buildOperating,
  type Operating,
  type OperatingDeps,
  type PotaSpot,
} from "@/services/radio/operating";

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
// Fakes
// ---------------------------------------------------------------------------

/** A period-aligned instant, so window parity is fixed rather than whatever the clock
 * happens to be doing when the test runs. 1_800_000_000_000 / 15_000 is exact. */
const T0 = 1_800_000_000_000;
const PERIOD = 15_000;

const STATION = { id: "st1", callsign: "K9XYZ", grid: "EN52wa" };
const DIAL_HZ = 14_074_000;

interface Heard {
  message: string;
  snr: number;
  freqOffset: number;
}

/**
 * A source that emits windows on demand.
 *
 * Only `periodMs`, `mode` and the two events are used by anything above the driver —
 * which is the observation lib/radio/types.ts was written around, and this class is what
 * it costs to test that claim.
 */
class FakeSource extends EventEmitter {
  readonly periodMs = PERIOD;
  mode: DigitalMode = "FT8";

  /**
   * The simulated instant, advanced by every window this fake emits.
   *
   * The QSO controller schedules the FIRST transmission of a call against a clock, and it
   * used to read the wall clock directly — so under test it compared a 2027 fixture
   * against the real Date.now() and picked a window several million periods away. Five
   * assertions here failed on that for four releases, reporting a spurious extra
   * transmission that no operator ever saw, because live the two clocks are the same one.
   *
   * Set to nine tenths of the way through the window just emitted: a decode is only
   * available once the transmission has finished (12.64 s of a 15 s window) and been
   * decoded, which is exactly the position the controller has to reason from when it
   * decides whether it can still make the next window.
   */
  at = T0;

  now(): number {
    return this.at;
  }

  /** A receive window that decoded something. */
  window(windowStartMs: number, heard: Heard[]): void {
    this.at = windowStartMs + Math.round(PERIOD * 0.9);
    this.emit("decodes", {
      windowStart: new Date(windowStartMs),
      decodes: heard.map((h) => ({ ...h, dt: 0.1, mode: this.mode })),
      rms: 0.01,
      decodeMs: 120,
    });
  }

  /** Our own transmit window: no receive audio, so only `window` fires. */
  ourWindow(windowStartMs: number): void {
    this.at = windowStartMs + Math.round(PERIOD * 0.9);
    this.emit("window", {
      windowStart: new Date(windowStartMs),
      samples: 180_000,
      rms: 1e-3,
      skipped: true,
    });
  }
}

class FakeTx implements DigitalTransmitter {
  readonly sent: { message: string; mode: string; offsetHz: number; startAt: number }[] = [];
  unkeys = 0;

  async transmit(req: {
    message: string;
    mode: DigitalMode;
    offsetHz: number;
    startAt: number;
  }): Promise<TransmitOutcome> {
    this.sent.push({ ...req });
    return {
      sent: true,
      message: req.message,
      startedAt: req.startAt,
      timingErrorMs: 0,
      packetsSent: 2_370,
    };
  }

  async unkey(): Promise<void> {
    this.unkeys++;
  }
}

/** Settings, without a database behind them. Absent keys fall back like the real ones. */
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

// ---------------------------------------------------------------------------
// The factory under characterisation
//
// It used to mirror the block inside `startFlexSource()` line for line, because that
// was the only way to run it. Now it calls the extracted `buildOperating`, and the
// assertions below have not changed — which is the whole proof the move was faithful.
// `git log -p scripts/check-operating.ts` is where to check that claim.
// ---------------------------------------------------------------------------

type Spot = PotaSpot;

interface FactoryDeps {
  kind: "flex" | "icom";
  source: FakeSource;
  tx: DigitalTransmitter;
  station: { id: string; callsign: string; grid: string };
  dialHz: () => number | null;
  /** The fixture's clock, so the first-transmission scheduler is testable at all. */
  now: () => number;
  radio: () => string | null;
  retune: (band: string, mode: DigitalMode) => Promise<boolean>;
  tuneHz: (hz: number) => Promise<boolean>;
  settings: FakeSettings;
  wasWorked: (call: string, band: string, mode: string, sinceMs: number) => Promise<boolean>;
  logQso: (log: QsoLogData, ctx: QsoLogContext) => Promise<void>;
  workedIndex: (band: string | null) => Promise<WorkedIndex>;
  potaSpots: () => Promise<Spot[]>;
  broadcast: (event: unknown) => void;
  log: (line: string) => void;
}

async function makeOperating(deps: FactoryDeps): Promise<Operating> {
  return buildOperating({
    kind: deps.kind,
    // TWO WINDOWS, as this whole scenario was written against.
    //
    // Production listens 90 s before judging a band, which is 6 FT8 windows — the fix for
    // a station that hopped every 15 s in FT4 without ever hearing anything. This fixture
    // is not testing the warmup's LENGTH (check:band-hop asserts that arithmetic
    // directly); it is testing what happens after it, and feeding four more windows of
    // nothing to every case would only make it slower and no more truthful.
    warmupMs: 30_000,
    // The fake emits `decodes` and `window` and reports a period and a mode, which is
    // the entire surface the operating layer uses. Casting says so out loud rather than
    // making the fake implement an EventEmitter generic it does not need.
    source: deps.source as unknown as OperatingDeps["source"],
    tx: deps.tx,
    station: deps.station,
    dialHz: deps.dialHz,
    now: deps.now,
    radio: deps.radio,
    retune: deps.retune,
    tuneHz: deps.tuneHz,
    broadcast: deps.broadcast,
    log: deps.log,
    settings: deps.settings,
    data: {
      wasWorked: deps.wasWorked,
      // Nothing in this harness exercises band slots or the do-not-call list, and both
      // must answer without a database — see OperatingData.onDoNotCall.
      workedOnBandEver: async () => false,
      listedAs: async () => null,
      logQso: deps.logQso,
      // Nothing here reaches the abandoned-exchange path, and it must answer without a
      // database for the same reason the two above do.
      recordIncomplete: async () => {},
      workedIndex: deps.workedIndex,
      // No cty data in a test. Award ranking degrades to signal strength, which is
      // what happens on a fresh install too.
      resolveEntity: async () => null,
      potaSpots: deps.potaSpots,
    },
  });
}

// ===========================================================================
// CHARACTERISATION — nothing below this line may change in the extraction.
// ===========================================================================

/** Let the fire-and-forget transmit and the async window handlers finish. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

interface Observations {
  guards: Record<string, number>;
  /** Every transmission, with `startAt` as a window index from T0. */
  sent: { message: string; mode: string; offset: number | string; window: number }[];
  logged: {
    call: string;
    reportSent: string;
    reportRcvd: string | null;
    band: string | null;
    mode: string;
    freqHz: number | null;
    sig: string | null;
    sigInfo: string | null;
    radio: string | null;
    transcript: string | null;
  }[];
  tuned: number[];
  retuned: string[];
  broadcasts: string[];
  qsoState: string | null;
  autoAction: string | null;
  unkeys: number;
}

/**
 * One full session: an operator-started QSO, an automatic CQ, and a POTA chase that
 * retunes to a park and finds its way home again.
 *
 * `kind` changes nothing except which radio's tuning functions are wired in — that is
 * the claim being tested.
 */
async function session(kind: "flex" | "icom"): Promise<Observations> {
  const source = new FakeSource();
  const tx = new FakeTx();
  const tuned: number[] = [];
  const retuned: string[] = [];
  const broadcasts: string[] = [];
  const logged: Observations["logged"] = [];

  // The spotted activator is callable when the spot arrives and a dupe by the time we
  // hear them — which is what sends the radio back to the calling frequency.
  let k4Worked = false;

  const spots: Spot[] = [
    {
      activator: "K4ABC",
      freqHz: 14_078_000,
      band: "20M",
      mode: "FT8",
      reference: "US-1689",
      parkName: "Somewhere",
    },
  ];

  const op = await makeOperating({
    kind,
    source,
    tx,
    station: STATION,
    dialHz: () => DIAL_HZ,
    // The fixture's clock, not the wall clock. See FakeSource.at.
    now: () => source.now(),
    // Both radios name themselves; the operating layer only passes it through.
    radio: () => (kind === "icom" ? "IC-7300MK2" : "FLEX-6400"),
    // The whole per-radio difference, in two functions.
    retune: async (band) => {
      retuned.push(band);
      return true;
    },
    tuneHz: async (hz) => {
      tuned.push(hz);
      return true;
    },
    settings: new FakeSettings({ "auto.maxSwr": "1.8", "auto.maxRunMinutes": "120" }),
    wasWorked: async (call) => (call === "K4ABC" ? k4Worked : false),
    logQso: async (l, ctx) => {
      logged.push({
        call: l.theirCall,
        reportSent: l.reportSent,
        reportRcvd: l.reportRcvd,
        band: ctx.band,
        mode: ctx.mode,
        freqHz: ctx.freqHz,
        sig: ctx.sig,
        sigInfo: ctx.sigInfo,
        radio: ctx.radio,
        transcript: ctx.transcript,
      });
    },
    workedIndex: async () => emptyWorkedIndex(),
    potaSpots: async () => spots,
    broadcast: (e) => broadcasts.push((e as { kind: string }).kind),
    log: () => {},
  });

  // --- an operator-started QSO, worked to completion -----------------------
  //
  // Their transmission decoded in the window at T0, so that parity is theirs and the
  // odd windows are ours.
  await op.qsoController.startCall({
    theirCall: "K1DEF",
    theirGrid: "DM33",
    theirSnr: -8,
    theirOffsetHz: 1234,
    theirWindowStart: T0,
    theirMessage: "CQ K1DEF DM33",
  });

  source.window(T0, [{ message: "CQ K1DEF DM33", snr: -8, freqOffset: 1234 }]);
  await settle();
  source.ourWindow(T0 + PERIOD);
  await settle();
  source.window(T0 + 2 * PERIOD, [{ message: "K9XYZ K1DEF -12", snr: -8, freqOffset: 1234 }]);
  await settle();
  source.ourWindow(T0 + 3 * PERIOD);
  await settle();
  source.window(T0 + 4 * PERIOD, [{ message: "K9XYZ K1DEF RR73", snr: -8, freqOffset: 1234 }]);
  await settle();

  const qsoState = op.qsoController.state.state;

  // --- automatic CQ --------------------------------------------------------
  op.autoOperator.setMode("cq");
  for (let w = 6; w <= 8; w++) {
    source.window(T0 + w * PERIOD, [{ message: "CQ N0XYZ EM48", snr: -14, freqOffset: 900 }]);
    await settle();
  }

  // --- POTA chase ----------------------------------------------------------
  op.autoOperator.setMode("pota-chase");
  for (let w = 9; w <= 11; w++) {
    source.window(T0 + w * PERIOD, [{ message: "CQ N0XYZ EM48", snr: -14, freqOffset: 900 }]);
    await settle();
  }

  // Parked on the park now. Hearing them is what settles it — and they turn out to be
  // already in the log, so there is nothing here and nothing else spotted.
  k4Worked = true;
  for (let w = 12; w <= 14; w++) {
    source.window(T0 + w * PERIOD, [
      { message: "CQ POTA K4ABC EM79", snr: -6, freqOffset: 1500 },
    ]);
    await settle();
  }

  // Read before stopping: setMode("off") overwrites the status line with "stopped",
  // which would throw away the one thing worth asserting about the chase.
  const autoAction = op.autoOperator.state.lastAction;
  op.autoOperator.setMode("off");

  return {
    guards: {
      maxSwr: op.guards.config.maxSwr,
      maxRunMinutes: op.guards.config.maxRunMinutes,
      maxCallAttempts: op.guards.config.maxCallAttempts,
      failureCooldownMs: op.guards.config.failureCooldownMs,
      dupeWindowMs: op.guards.config.dupeWindowMs,
      maxQsosPerRun: op.guards.config.maxQsosPerRun,
    },
    sent: tx.sent.map((t) => ({
      message: t.message,
      mode: t.mode,
      // A CQ picks a clear offset at random, so the assertion is the property that
      // matters — inside the band everyone's filters pass — rather than the number.
      offset: t.message.startsWith("CQ")
        ? t.offsetHz >= 1000 && t.offsetHz < 2600
          ? "clear 1000-2600"
          : `out of range: ${t.offsetHz}`
        : t.offsetHz,
      window: (t.startAt - T0) / PERIOD,
    })),
    logged,
    tuned,
    retuned,
    broadcasts: [...new Set(broadcasts)].sort(),
    qsoState,
    autoAction,
    unkeys: tx.unkeys,
  };
}

/**
 * The whole contact, as it is stored.
 *
 * Written out in full rather than asserted piecemeal: this string is what an operator
 * reads a year later when they doubt a QSO, and a golden copy of it is the only way a
 * change to the format shows up as a test failure rather than as a surprise in the log.
 */
const EXPECTED_TRANSCRIPT = [
  "08:00:00 RX  -8dB 1234Hz CQ K1DEF DM33",
  "08:00:15 TX       1234Hz K1DEF K9XYZ EN52",
  "08:00:30 RX  -8dB 1234Hz K9XYZ K1DEF -12",
  "08:00:45 TX       1234Hz K1DEF K9XYZ R-08",
  "08:01:00 RX  -8dB 1234Hz K9XYZ K1DEF RR73",
  "08:01:15 TX       1234Hz K1DEF K9XYZ 73",
].join("\n");

async function main(): Promise<void> {
  const flex = await session("flex");
  const icom = await session("icom");

  console.log("\nguards come from settings, not the hardcoded defaults");
  {
    eq(flex.guards.maxSwr, 1.8, "a configured threshold wins");
    eq(flex.guards.maxRunMinutes, 120, "and so does the run limit");
    eq(flex.guards.maxCallAttempts, DEFAULT_GUARDS.maxCallAttempts, "an unset one defaults");
    eq(flex.guards.failureCooldownMs, 30 * 60_000, "minutes are converted to milliseconds");
    eq(flex.guards.dupeWindowMs, 24 * 3_600_000, "and hours to milliseconds");
  }

  console.log("\nan operator-started QSO runs to a logged contact");
  {
    eq(
      flex.sent.slice(0, 3),
      [
        { message: "K1DEF K9XYZ EN52", mode: "FT8", offset: 1234, window: 1 },
        { message: "K1DEF K9XYZ R-08", mode: "FT8", offset: 1234, window: 3 },
        { message: "K1DEF K9XYZ 73", mode: "FT8", offset: 1234, window: 5 },
      ],
      "Tx1, Tx3 and the courtesy 73, each on our own parity",
    );
    eq(flex.qsoState, "complete", "the sequencer finished");
    eq(
      flex.logged,
      [
        {
          call: "K1DEF",
          reportSent: "-08",
          reportRcvd: "-12",
          band: "20M",
          mode: "FT8",
          freqHz: DIAL_HZ + 1234,
          sig: null,
          sigInfo: null,
          // Whatever the radio called itself, passed straight through — the operating
          // layer has no opinion about which radio it is driving.
          radio: "FLEX-6400",
          transcript: EXPECTED_TRANSCRIPT,
        },
      ],
      "logged once, with the band and the audio offset added to the dial",
    );
  }

  console.log("\nauto CQ waits out the warm-up, then calls");
  {
    const cq = flex.sent[3];
    eq(
      cq,
      { message: "CQ K9XYZ EN52", mode: "FT8", offset: "clear 1000-2600", window: 9 },
      "one CQ, on the window after the second warm-up window",
    );
  }

  console.log("\nPOTA chase moves the dial and finds its way home");
  {
    eq(flex.tuned, [14_078_000], "retuned to the spotted park frequency, once");
    eq(flex.retuned, ["20M"], "and back to the calling frequency when there was nothing left");
    ok(
      (flex.autoAction ?? "").includes("back to 20M"),
      "and says so",
      flex.autoAction ?? "(nothing)",
    );
  }

  console.log("\nthe contact keeps the whole exchange");
  {
    const t = flex.logged[0]?.transcript ?? "";
    eq(t, EXPECTED_TRANSCRIPT, "every message, both directions, oldest first");
    eq(t.split("\n").length, 6, "six lines for a six-message contact");
    ok(
      t.startsWith("08:00:00 RX  -8dB 1234Hz CQ K1DEF DM33"),
      "it opens with the CQ we answered, not with our own reply",
      t.split("\n")[0] ?? "(empty)",
    );
    ok(
      t.endsWith("K1DEF K9XYZ 73"),
      "and ends with the courtesy 73, which goes out in the same tick that logs",
      t.split("\n").at(-1) ?? "(empty)",
    );
    ok(!t.includes("N0XYZ"), "and nothing from the rest of the band is in it");
  }

  console.log("\ntranscript formatting");
  {
    eq(formatTranscript([]), null, "an empty exchange stores null, not an empty string");
    eq(
      formatTranscript([
        { at: T0, dir: "tx", message: "K1DEF K9XYZ EN52", offsetHz: 1500, refused: "Transmit is disabled in settings" },
      ]),
      "08:00:00 TX       1500Hz K1DEF K9XYZ EN52   [not sent: Transmit is disabled in settings]",
      "a refused transmission is recorded, with the reason",
    );
    eq(
      formatTranscript([{ at: T0, dir: "rx", message: "CQ K1DEF DM33", snr: 3 }]),
      "08:00:00 RX  +3dB        CQ K1DEF DM33",
      "a positive report keeps its sign, and a missing offset leaves a gap",
    );
    const many = Array.from({ length: TRANSCRIPT_MAX_ENTRIES + 3 }, (_, i) => ({
      at: T0 + i * PERIOD,
      dir: "tx" as const,
      message: `MSG ${i}`,
    }));
    const capped = (formatTranscript(many) ?? "").split("\n");
    eq(capped.length, TRANSCRIPT_MAX_ENTRIES + 1, "a runaway exchange is capped");
    ok(
      capped[0]?.includes("3 earlier message(s) not kept") ?? false,
      "and says how many it dropped",
      capped[0] ?? "(empty)",
    );
    ok(
      (capped.at(-1) ?? "").endsWith(`MSG ${TRANSCRIPT_MAX_ENTRIES + 2}`),
      "keeping the end, where the contact completes",
      capped.at(-1) ?? "(empty)",
    );
  }

  console.log("\nstations the transmitter cannot reach");
  {
    // The receiver can be told to search above 3 kHz and finds stations there. The
    // transmitter cannot follow, and answering on the wrong frequency is not a
    // fallback - they are listening where they transmitted.
    const source = new FakeSource();
    const tx = new FakeTx();
    const op = await makeOperating({
      kind: "flex",
      source,
      tx,
      station: STATION,
      dialHz: () => DIAL_HZ,
      now: () => source.now(),
      radio: () => "FLEX-6400",
      retune: async () => true,
      tuneHz: async () => true,
      settings: new FakeSettings(),
      wasWorked: async () => false,
      logQso: async () => {},
      workedIndex: async () => emptyWorkedIndex(),
      potaSpots: async () => [],
      broadcast: () => {},
      log: () => {},
    });

    const high = await op.qsoController.startCall({
      theirCall: "K9HIGH",
      theirSnr: -5,
      theirOffsetHz: 3400,
      theirWindowStart: T0,
      theirMessage: "CQ K9HIGH EN61",
    });
    ok(!high.ok, "a station at 3400 Hz is refused, not answered on the wrong frequency");
    ok(
      (high.reason ?? "").includes("2800"),
      "and the refusal says why",
      high.reason ?? "(no reason)",
    );

    const reachable = await op.qsoController.startCall({
      theirCall: "K9LOW",
      theirSnr: -5,
      theirOffsetHz: 2750,
      theirWindowStart: T0,
      theirMessage: "CQ K9LOW EN61",
    });
    ok(reachable.ok, "one just inside the ceiling is worked normally", reachable.reason ?? "");

    source.window(T0, [{ message: "CQ K9LOW EN61", snr: -5, freqOffset: 2750 }]);
    await settle();
    eq(tx.sent[0]?.offsetHz, 2750, "on their own frequency, not a clamped one");
  }

  console.log("\nwhat the operating layer tells the browser");
  {
    eq(
      flex.broadcasts,
      ["auto", "qso", "qso-logged", "qso-tx"],
      "the four event kinds, and no others",
    );
  }

  console.log("\nthe same session on the other radio");
  {
    // The point of the whole exercise. Only `retune` and `tuneHz` differ between the
    // two, so every observation must be identical — including the transmissions, the
    // logged contact and the frequencies the dial was moved to.
    eq(icom.sent, flex.sent, "the same transmissions, in the same windows");
    // Everything about the contact matches except the one field whose whole job is to
    // differ: which radio made it. Blanked for the comparison and asserted separately,
    // rather than dropped — a radio that failed to name itself would otherwise pass
    // this as "the same".
    const withoutRadio = (rows: Observations["logged"]) =>
      rows.map((r) => ({ ...r, radio: null }));
    eq(
      withoutRadio(icom.logged),
      withoutRadio(flex.logged),
      "the same logged contact, radio aside",
    );
    eq(
      [flex.logged[0]?.radio, icom.logged[0]?.radio],
      ["FLEX-6400", "IC-7300MK2"],
      "and each contact records the radio that actually made it",
    );
    eq(icom.tuned, flex.tuned, "the same chase frequency");
    eq(icom.retuned, flex.retuned, "the same way home");
    eq(icom.guards, flex.guards, "the same guards");
    eq(icom.broadcasts, flex.broadcasts, "the same events");
    eq(icom.qsoState, flex.qsoState, "the same final QSO state");
    eq(icom.autoAction, flex.autoAction, "the same closing status line");
    eq(icom.unkeys, flex.unkeys, "the same keying");
  }

  console.log("\nband hopping, on either radio");
{
  // Wired since the Icom went in and never exercised on the air, which is exactly the
  // state in which a path quietly stops working. The invariant that matters is not which
  // band it picks — it is that a hop goes through `retune`, because that is the only path
  // that runs the antenna tuner. A hop that reached `tuneHz` instead would land on a band
  // the tuner has never seen and the radio would fold back to a few watts, on a band
  // nobody is watching, unattended.
  const hop = async (kind: "flex" | "icom") => {
    const source = new FakeSource();
    const tx = new FakeTx();
    const retuned: string[] = [];
    const tuned: number[] = [];
    const op = await makeOperating({
      kind,
      source,
      tx,
      station: STATION,
      dialHz: () => DIAL_HZ,
      now: () => source.now(),
      radio: () => (kind === "flex" ? "FLEX-6400" : "IC-7300MK2"),
      retune: async (band, mode) => {
        retuned.push(`${band} ${mode}`);
        return true;
      },
      tuneHz: async (hz) => {
        tuned.push(hz);
        return true;
      },
      settings: new FakeSettings({
        "auto.bandHop": "true",
        "auto.hopBands": "40M,30M",
        // Two unanswered CQs is a dead band here; the real default is higher.
        //
        // It has to be THIS guard. A hop only follows a pause whose cause is "quiet",
        // and deliberately so: a fault — high SWR, a hot PA, a receiver that has gone
        // deaf — is not something a different band fixes, and hopping used to call
        // rearm(), which cleared the fault outright and carried on transmitting.
        "auto.maxUnansweredCqs": "2",
      }),
      wasWorked: async () => false,
      logQso: async () => {},
      workedIndex: async () => emptyWorkedIndex(),
      potaSpots: async () => [],
      broadcast: () => {},
      log: () => {},
    });

    op.autoOperator.setMode("cq");
    // CQ into a band that answers somebody else and never us — which is what a dead
    // band looks like from here, and what band hopping is for.
    for (let i = 0; i < 8; i++) {
      source.window(T0 + i * PERIOD, [
        { message: "CQ K7XYZ DM33", snr: -5, freqOffset: 1500 },
      ]);
      await settle();
    }
    return { retuned, tuned, action: op.autoOperator.state.lastAction ?? "" };
  };

  const flexHop = await hop("flex");
  const icomHop = await hop("icom");

  ok(flexHop.retuned.length > 0, "a band that never answers gets left", flexHop.action);
  // The FIRST band on the list, not the second. hopNext increments before reading, so
  // this was 30M until hopIndex started before the list rather than at its head.
  eq(flexHop.retuned[0], "40M FT8", "to the first band on the list, in the current mode");
  ok(
    flexHop.retuned.length < 2 || flexHop.retuned[1] === "30M FT8",
    "and on round the list from there",
    flexHop.retuned.join(" -> "),
  );
  eq(flexHop.tuned, [], "and never through tuneHz, which does not run the tuner");
  eq(icomHop.retuned, flexHop.retuned, "the Icom hops to exactly the same place");
  eq(icomHop.tuned, flexHop.tuned, "by the same path");
  eq(icomHop.action, flexHop.action, "and says the same thing about it");
}

console.log("\nwhat makes it hop, and what makes it hop again");
{
  // Band hopping ran on hardware for the first time on 3 August 2026, and the log looked
  // wrong: two hops and two ATU cycles inside 31 seconds, with no CQ between them. It was
  // correct. 40M at midday returned 0 decodes in its warmup, so the scan moved on and
  // settled on 20M, which returned 42. Both paths are deliberate and both are pinned here,
  // because a hop chain reads like a fault and the next person will assume it is one.
  const run = async (decodesPerWindow: number) => {
    const source = new FakeSource();
    const tx = new FakeTx();
    const hops: { to: string; cqsBefore: number }[] = [];
    const cqsSent = () => tx.sent.filter((t) => /^CQ\b/.test(t.message)).length;
    const op = await makeOperating({
      kind: "icom",
      source,
      tx,
      station: STATION,
      dialHz: () => DIAL_HZ,
      now: () => source.now(),
      radio: () => "IC-7300MK2",
      retune: async (band, mode) => {
        hops.push({ to: `${band} ${mode}`, cqsBefore: cqsSent() });
        return true;
      },
      tuneHz: async () => true,
      settings: new FakeSettings({
        "auto.bandHop": "true",
        "auto.hopBands": "40M,30M,80M",
        "auto.maxUnansweredCqs": "2",
      }),
      wasWorked: async () => false,
      logQso: async () => {},
      workedIndex: async () => emptyWorkedIndex(),
      potaSpots: async () => [],
      broadcast: () => {},
      log: () => {},
    });

    op.autoOperator.setMode("cq");
    for (let i = 0; i < 12; i++) {
      const heard = Array.from({ length: decodesPerWindow }, (_, n) => ({
        message: `CQ K7XY${n} DM33`,
        snr: -8,
        freqOffset: 1200 + n * 90,
      }));
      source.window(T0 + i * PERIOD, heard);
      await settle();
    }
    return { hops, cqs: cqsSent(), trail: hops.map((h) => `${h.to}@${h.cqsBefore}cq`).join(" -> ") };
  };

  // A band with traffic on it. Every hop here has to be earned by CQing into it and
  // getting nothing back.
  const busy = await run(6);
  ok(busy.hops.length > 0, "a busy band nobody answers on is still left", busy.trail);
  let earned = true;
  let previous = 0;
  for (const h of busy.hops) {
    if (h.cqsBefore <= previous) earned = false;
    previous = h.cqsBefore;
  }
  ok(earned, "and every hop follows a CQ sent on the band it leaves", busy.trail);

  // A band under the settle threshold. The scan moves on without CQing, deliberately —
  // calling into a band that produced almost nothing is a waste of a transmission.
  const dead = await run(1);
  ok(dead.hops.length > busy.hops.length, "a dead band is left faster than a busy one",
    `dead ${dead.hops.length} vs busy ${busy.hops.length}`);
  ok(
    dead.hops.some((h, i) => i > 0 && h.cqsBefore === dead.hops[i - 1]!.cqsBefore),
    "and the scan hops on with no CQ in between, which is the design",
    dead.trail,
  );

  // Whatever the reason, it must never hop to the band it is already on.
  for (const r of [busy, dead]) {
    let repeated = false;
    for (let i = 1; i < r.hops.length; i++) {
      if (r.hops[i]!.to === r.hops[i - 1]!.to) repeated = true;
    }
    ok(!repeated, `never hops to the band it is already on (${r.hops.length} hops)`, r.trail);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

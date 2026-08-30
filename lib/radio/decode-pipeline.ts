// Audio in, decodes out. No radio in sight.
//
// This was the second half of `FlexDaxSource`: the window buffer, the scheduler that
// cuts a window shortly after the transmission ends, the silence check, decimation to
// the decoders' 12 kHz, and the decode itself. None of it was ever Flex-specific — it
// operates on samples and produces messages — but it lived inside the Flex driver, so
// the Icom source could deliver perfect audio and had nothing to hand it to.
//
// The only thing a radio contributes here is its sample rate. Flex DAX is 24 kHz, Icom
// is 48 kHz, and both divide into 12 kHz exactly.
//
// WHAT MUST NOT DRIFT: `scripts/check-pipeline-golden.ts` pins the behaviour of this
// file — known message in, decoded message out, all three modes, plus the silence and
// short-window guards. It was written against the pre-extraction code specifically so
// the move could be proved to change nothing.

import { nowMs } from "@/lib/time/clock";
import { EventEmitter } from "node:events";

import { decodeFT4, decodeFT8, HashCallBook } from "@e04/ft8ts";

import { ft2DecodeAudio } from "@/lib/digital/ft2demod";
import { HashCallBook as Ft2HashCallBook } from "@/lib/digital/pack77";
import { PERIOD_MS, TRANSMISSION_MS } from "@/lib/radio/timing";
import type { TxMode } from "@/lib/radio/waveform";

/** What every decoder here is fed, whatever the radio delivered. */
export const DECODE_SAMPLE_RATE = 12_000;

/**
 * On-air length of a transmission, ms — where the guard time begins.
 *
 * FT2's 1947 includes the modulator's two-symbol pulse tail, not just its 144 channel
 * symbols; cutting at 1920 would clip the last symbol's energy.
 */
// Moved to lib/radio/timing.ts, beside PERIOD_MS and TX_START_OFFSET_MS, so the
// transmitter can read it without importing this module. Re-exported because the name is
// used widely here and in the checks.
export { TRANSMISSION_MS } from "@/lib/radio/timing";

/**
 * How long after the transmission ends the window is cut for decoding.
 *
 * The transmission occupies only the first 12.64 s (FT8) / 5.04 s (FT4) of the window;
 * the tail is guard time. Cutting shortly after the audio ends — rather than at the
 * boundary — buys the decode back that guard time, so results are ready BEFORE the next
 * window starts. That is what lets a QSO answer in the very next cycle with on-time
 * keying instead of keying a second late.
 *
 * But the margin also sets the LATEST DT that can be decoded, and 400 ms was too mean. A
 * station whose transmission starts at +0.5 s has audio running to 13.14 s (FT8), and
 * the buffer stopped at 13.04 s — so it was truncated and lost. That put a hard ceiling
 * of about +0.4 s on the DT column and quietly dropped every station with a slower clock
 * or a longer path, which is exactly the "why am I decoding fewer stations than WSJT-X"
 * complaint.
 *
 * 1200 ms roughly triples the tolerance to about +1.2 s while still leaving 1.16 s (FT8)
 * and 1.26 s (FT4) before the next boundary — comfortably more than the ~0.55 s a
 * depth-2 decode takes, so answering in the next cycle is unaffected.
 *
 * It is also FT2's floor. `ft2DecodeAudio` refuses any buffer under (144*10 + 375) * 16
 * = 29,040 samples at 12 kHz, i.e. 2.42 s. With the old 400 ms margin an FT2 window was
 * 2347 ms => 28,164 samples: 876 short, so every live FT2 window was thrown away at the
 * length gate before any demodulation ran, and the mode could never have decoded on air.
 */
export const CUT_MARGIN_MS = 1_200;

/**
 * Half-width of the priority slice searched around a QSO partner's offset, Hz.
 *
 * NOT A BUG FIX. Nothing here is broken: 1.139.1 corrected, in public, an earlier claim
 * that late transmissions were losing contacts, and the correction is the measurement —
 * completed and abandoned QSOs have the same median timing, 536 ms against 554 ms over
 * 26,000 transmissions. This is wasted margin being reclaimed, and that is all it is.
 *
 * WHAT IS ACTUALLY WASTED. A reply is scheduled from the `decodes` event, and that event
 * cannot fire until the window has ended and been decoded. MEASURED on the live box, FT8,
 * 15 s window, depth 2:
 *
 *     full 200-3000 Hz          1558 ms
 *     200 Hz slice around a
 *     known partner offset       420-476 ms
 *
 * REPRODUCED here on the development machine against a ten-signal synthetic window, which
 * is roughly 3.4x faster in absolute terms and agrees on the RATIO:
 *
 *     full 200-3000 Hz           360-466 ms
 *     200 Hz slice               102-113 ms
 *
 * The window is cut at 13,840 ms (12,640 + CUT_MARGIN_MS) and the reply is due on the air
 * at 15,500 ms — the next boundary plus FT8's 500 ms start offset. So the full search
 * lands at boundary+398 ms with about a tenth of a second left to build a 303,360-sample
 * waveform and get `xmit 1` across the network, while the slice lands 740 ms BEFORE the
 * boundary with 1,240 ms in hand. That is the margin.
 *
 * WHY 200 Hz AND NOT LESS OR MORE. Two facts decide it, and both were measured against
 * @e04/ft8ts rather than assumed:
 *
 *   - The bounds are HARD. A signal whose base frequency sits 10 Hz below `freqLow` is
 *     not decoded at all; one sitting exactly ON `freqLow` or exactly on `freqHigh` is.
 *     So a slice of centre +/- 100 Hz tolerates exactly +/- 100 Hz of drift in what we
 *     believe the partner's offset to be, and not one Hz more.
 *   - 100 Hz above the offset also clears the signal itself. FT8 is eight tones 6.25 Hz
 *     apart, so it occupies offset .. offset+43.75 Hz; FT4's four tones 20.83 Hz apart
 *     reach offset+62.5 Hz. Both fit inside the upper half with room to spare.
 *
 * Widening costs what it buys: +/- 150 Hz measured 122-136 ms against 102-113 ms at
 * +/- 100. The drift being tolerated is not the partner's oscillator — their offset is
 * placed in software and is stable to the Hz — it is our own belief about where they are,
 * which is refreshed from their last decode every cycle. 100 Hz is generous for that and
 * still three times cheaper than the full band.
 *
 * NARROWING BUYS ALMOST NOTHING, WHICH IS WORTH WRITING DOWN because the arithmetic
 * suggests otherwise. Measured on this machine against the same window, median of five:
 * +/-25 is 82 ms, +/-50 is 89 ms, +/-100 is 106 ms, and the full 200-3000 Hz band is
 * 405 ms. So going from +/-100 to +/-50 saves 17 ms — 16% of a slice, 4% of the full
 * pass — and halves the drift a belief may be wrong by. It is not a good trade: a
 * believed offset 40 Hz low still finds the station at +/-50 and does NOT at +/-25.
 *
 * The reason is that the cost is nearly all fixed. That is also what MAX_SLICE_WIDTH_HZ
 * is about, from the other end of the same curve.
 */
export const PRIORITY_HALF_WIDTH_HZ = 100;

/**
 * How many candidate slices one window may be searched for, at most.
 *
 * A HARD CAP ON TOP OF A TIME BUDGET, and it exists for a reason the budget cannot
 * express: three 200 Hz slices are 600 Hz, which is already 21% of the 200-3000 Hz band
 * this pipeline searches. Past that a "slice" stops being one and we are simply paying
 * for the band twice — once in pieces and once whole — for a window we were going to
 * search in full anyway.
 *
 * Three rather than one because the top-ranked candidate is not always the one we call.
 * `rankCandidates` orders by award value then signal, and `mayCall` then refuses dupes
 * and stations still cooling down, so the call frequently lands on the second or third
 * name. Each further slice costs the same and buys a smaller share of the remaining
 * probability, which is what makes this a cap and not a target.
 */
export const MAX_CANDIDATE_SLICES = 3;

/**
 * Widest a merged candidate slice may be before it is cheaper to run two, Hz.
 *
 * MEASURED, and the shape of the curve is the whole argument. One bounded FT8 search over
 * the same ten-signal window on this machine, median of five:
 *
 *      200 Hz  113 ms        900 Hz  250 ms
 *      400 Hz  118 ms       1400 Hz  405 ms
 *      600 Hz  189 ms       2800 Hz  516 ms   (the full band)
 *
 * The cost is almost entirely FIXED up to about 400 Hz — a 400 Hz search is 5 ms dearer
 * than a 200 Hz one — and grows roughly with width after that. So two candidates close
 * enough to share a slice should share it, and two that are not should not: measured,
 * 250-450 plus 1080-1280 as separate searches is 278 ms, while one 250-1280 search
 * covering both is 360 ms. Merging past this width makes things worse, which is exactly
 * the kind of "obviously cheaper" change that would never have been noticed.
 *
 * It is also what stops an unbounded widen. The ranked list can be twenty stations, and a
 * chain of them each within 200 Hz of the last would otherwise grow one slice across the
 * whole band while the cap on the NUMBER of slices never fired.
 */
export const MAX_SLICE_WIDTH_HZ = 400;

/**
 * Total time the candidate slices may spend before the full-band pass, ms.
 *
 * SELF-CALIBRATING, and it has to be. The first slice always runs — that is the cost
 * the partner slice has been paying since 1.153.0 and it is already accepted — and its
 * MEASURED duration then decides whether a second fits. So the same constant produces
 * three slices on this development machine and exactly one on the live box, without
 * either number being written down anywhere:
 *
 *     development machine   95-98 ms a slice     -> 3 slices, 294 ms
 *     live box (Xeon)      420-476 ms a slice    -> 1 slice
 *
 * WHY IT MUST BE SMALL. The slices run BEFORE the full-band pass, and `processWindow` is
 * synchronous, so every millisecond spent here delays the whole band's decodes by the
 * same millisecond. In the window where a candidate is found that does not matter: the
 * call goes out on time and the full pass defers behind it. In the window where nothing
 * is found it is pure loss, and it lands on the very path — the ordinary hunt, deciding
 * from the full pass — whose lateness this change exists to remove. So the miss has to
 * stay cheap even though the win is worth a lot.
 *
 * 300 ms is roughly a fifth of the 1,435-1,795 ms the full pass measures live and a
 * sixth of the 1,860 ms of slack an FT8 window has after its transmission. Reasoned from
 * those two, not measured as a threshold.
 */
export const CANDIDATE_BUDGET_MS = 300;

/**
 * The budget rule itself, as a function, so the arithmetic can be asserted directly.
 *
 * A check script cannot make this machine as slow as the live box, so asserting the
 * BEHAVIOUR would only ever exercise the count cap. Asserting the RULE covers both
 * machines from either one — scripts/check-first-tx.ts drives it with the live box's
 * measured 420-476 ms and with this machine's 95-98 ms and shows the two answers.
 *
 * `lastSliceMs` rather than an average: a candidate slice that ran long is the best
 * evidence available that the next one will too, and being wrong in that direction costs
 * the whole band's decodes.
 */
export function anotherSliceFits(spentMs: number, lastSliceMs: number): boolean {
  return spentMs + lastSliceMs <= CANDIDATE_BUDGET_MS;
}

/**
 * How close two decodes must be in frequency to be the same signal, Hz.
 *
 * Used only to recognise a priority decode in the full-band result so it is not appended
 * twice. The two passes agree to the Hz on synthetic audio; 10 Hz is slack for the case
 * where they do not, and is far narrower than the 6.25 Hz tone spacing times any number
 * of stations that could plausibly share a message string inside one 200 Hz slice.
 */
const PRIORITY_MATCH_HZ = 10;

/**
 * How often the deferred full-band pass asks whether the transmitter has finished, ms.
 *
 * See `transmitPending`. The wait being polled is 13 s long, so the granularity costs
 * nothing and a poll is far simpler to reason about than an event that has to be
 * unsubscribed on every teardown path.
 */
const DEFER_POLL_MS = 100;

export interface Decode {
  freqOffset: number;
  snr: number;
  dt: number;
  message: string;
  mode: TxMode;
  windowStart: Date;
}

export type DecodePipelineEvents = {
  decodes: [{ windowStart: Date; decodes: Decode[]; rms: number; decodeMs: number }];
  /**
   * A slice decoded ahead of the rest of the band — the QSO partner's, or a candidate's.
   *
   * FIRES ONCE PER SLICE THAT FOUND SOMETHING, so a window may emit it more than once.
   * There is only ever one partner slice, but there can be up to MAX_CANDIDATE_SLICES
   * candidate slices in a window where no contact is in progress, and each is reported
   * on its own with its own bounds and its own cost. Consumers already have to tolerate
   * a slice holding nobody they care about — that is the empty-slice rule below — and
   * several such slices is the same rule applied more than once.
   *
   * A SEPARATE EVENT, not an early `decodes`. Everything that consumes `decodes` —
   * the database write, the websocket feed, PSKReporter, the CSV, the auto operator —
   * treats it as "this window, complete", and two of them dedupe by window: the auto
   * operator's `onWindow` and the QSO controller's `afterWindow` both ignore the second
   * event for a window they have already seen. Emitting the slice as an early `decodes`
   * would therefore have handed the auto operator a window containing one station and
   * silently discarded the other twenty-nine — wrong `recentOffsets`, an undercounted
   * band-hop tally, and a tail-ender calling us at another offset never queued.
   *
   * So `decodes` keeps its exact meaning and firing pattern, and only the QSO controller
   * opts in to this. Every message here also appears in that window's `decodes`.
   */
  priorityDecodes: [
    {
      windowStart: Date;
      decodes: Decode[];
      /** The offset the slice was centred on — what we believed the partner's to be. */
      centreHz: number;
      loHz: number;
      hiHz: number;
      decodeMs: number;
    },
  ];
  window: [
    {
      windowStart: Date;
      samples: number;
      rms: number;
      skipped: boolean;
      /**
       * WHY it was skipped, because the two reasons could not be told apart.
       *
       * "silent" is the ordinary one: DAX RX audio goes quiet while the radio transmits,
       * so our own TX cycle arrives as a below-squelch window every time.
       *
       * "transmit" is the OTHER ordinary one, and separating it from "short" is the whole
       * point of having a reason at all. While we transmit, `muteUntil` discards receive
       * audio, so the window arrives with ZERO samples and takes the short-window branch
       * on its way out. Reported as packet loss it accuses the radio of a fault on every
       * single transmit cycle - which the first version of this warning did, within
       * minutes of shipping, on a station that was simply working someone.
       *
       * "short" is NEVER ordinary. The window did not contain enough audio to hold a
       * whole transmission - UDP packet loss on the DAX stream, or the buffer not yet
       * filled at startup. It was indistinguishable from "silent" downstream because it
       * reports `rms: 0`, and the only log for a skipped window was guarded on `rms > 0`
       * - so the one skip worth an operator's attention was the one that could not be
       * seen. Reported live as decode cycles missing while the station was not even
       * transmitting, with nothing in any log to show for it.
       */
      reason?: "silent" | "short" | "transmit";
      /** How many samples a whole transmission needs, so "short" can say how short. */
      minSamples?: number;
    },
  ];
  error: [Error];
};

export interface DecodePipelineOptions {
  mode: TxMode;
  /** The rate samples arrive at. 24 kHz for Flex DAX, 48 kHz for Icom. */
  inputSampleRate: number;
  /**
   * Decoder depth. 2 is the live default: ~0.6 s per window against real 20 m traffic,
   * comfortably inside the gap between cycles. Depth 3 is ~1.5 s and still fits; depth 4
   * takes over 11 s and cannot be used live.
   */
  depth?: number;
  /**
   * Windows quieter than this RMS are skipped without decoding.
   *
   * MUST differ per radio. The filter below has ~0.80 gain per halving, so 48 kHz audio
   * takes two passes and arrives about 20% quieter than 24 kHz audio taking one. Reusing
   * one radio's value on the other silently drops marginal windows, and the symptom
   * reads as an antenna fault.
   */
  silenceRms?: number;
  /**
   * Top of the audio passband to search, Hz.
   *
   * The library defaults to 3000, and so did the waterfall, so the two agreed by
   * coincidence. On a busy band that ceiling is real: 3,052 decodes out of 111,829 in
   * this station's log sit above 2800 Hz and the maximum is *exactly* 3000 on every
   * busy band, which is a clipped distribution rather than a natural one.
   *
   * Raising it costs decode time — a wider search means more candidates — so it is a
   * setting rather than a new default, and the cycle-overrun warning is what says when
   * it has been raised too far.
   */
  maxHz?: number;
  /**
   * Where the station we are working transmits, asked fresh at every window cut.
   *
   * Null — no contact in progress, or nobody has decoded yet — means no PARTNER pass,
   * and the window falls through to `candidateOffsetsHz` below. That is the answer for
   * the FIRST transmission of every contact: there is no partner yet, so nothing on this
   * option can help it, and the candidate list exists precisely because of that gap.
   *
   * A closure rather than a number, and a PULL rather than a push, for the reason
   * `txFilterHiHz` on QsoControllerOptions is one: the answer changes during a contact —
   * the partner's offset is re-read from their last decode every cycle — and a value
   * captured when the pipeline was built would be null for the life of the process.
   *
   * There is no new source of truth here. `QsoController.partnerOffsetHz` reports what
   * the controller had already recorded from their decodes.
   */
  priorityOffsetHz?: () => number | null;
  /**
   * Where the stations we are most likely to CALL transmit, for the window about to be
   * decoded. Asked at every window cut, with that window's start.
   *
   * THE FIRST TRANSMISSION OF A CONTACT IS WHAT THIS IS FOR, and it is the one
   * `priorityOffsetHz` above says plainly it cannot help: there is no partner yet. Yet
   * the first call is the transmission most worth rescuing — measured on the live box,
   * replies now go out 1 ms EARLY while first calls are still 1.3-1.4 s late, because a
   * reply has a partner offset and a first call has nothing.
   *
   * IT DOES NOT NEED ONE. In hunt mode the auto operator ranks every CQ it hears and
   * calls the best one it is allowed to; the ranked list for a window is finished long
   * before the NEXT window of the same parity is even cut. A station calling CQ transmits
   * on one parity and listens on the other, so whoever called CQ two windows ago is very
   * likely to be calling CQ again in the window being cut now, on the same offset. That
   * is where these come from — `AutoOperator.candidateOffsetsHz`, which reports the list
   * `huntWindow` already built rather than keeping a second one.
   *
   * PER-WINDOW, and the argument is not decoration: the answer depends on the window's
   * PARITY. Handing back the last window's candidates would search for stations that are
   * receiving, not transmitting, and find nothing every time.
   *
   * A PULL, like `priorityOffsetHz`, and for the same reason: the list is rebuilt from
   * every decoded window and a value captured at construction would be empty for ever.
   *
   * Best first. The pipeline searches them in order and stops when its budget runs out —
   * see MAX_CANDIDATE_SLICES and CANDIDATE_BUDGET_MS — so the order is what decides
   * which ones are actually looked at on a slow machine.
   */
  candidateOffsetsHz?: (windowStartMs: number) => number[];
  /**
   * "Is our transmit path occupied right now?" — asked once, after the priority pass.
   *
   * WITHOUT THIS THE PRIORITY PASS BUYS NOTHING, and would in fact make the lateness
   * worse. `processWindow` is synchronous, so a full-band search blocks the event loop
   * for its whole duration, and the transmitter's `await` on the instant to key is an
   * ordinary timer that cannot fire while it does. Running the two passes back to back
   * would block from the cut at 13,840 ms until 15,874 ms (the 1558 and 476 measured
   * live, added) — 374 ms PAST the instant the reply was due, where the single full pass
   * today ends at 15,398 ms. The slice would find the partner early and the full pass
   * would then sit on the event loop until after the moment it was found early FOR.
   *
   * So when the slice has produced decodes and the transmitter has taken work as a
   * direct, synchronous consequence of them, the full-band pass waits until that
   * transmission is over. `QsoController.transmitPending` is true from the instant
   * `runTick` hands a message to the transmitter until that promise settles, which spans
   * both the wait for the key instant and the paced packet stream in
   * `FlexDaxTransmitter.streamAudio` — that stream sleeps between packets against a
   * wall-clock deadline, so blocking the loop mid-transmission would stall it too.
   *
   * WHAT IT COSTS, stated plainly: in the windows where we do reply, the REST of that
   * window's decodes reach the decode list, the database and the auto operator about one
   * cycle later than they do today. They are not lost, and their timestamps do not move
   * — `windowStart` travels with them. Outside an active contact `priorityOffsetHz`
   * returns null, no priority pass runs, and nothing defers.
   */
  transmitPending?: () => boolean;
}

export class DecodePipeline extends EventEmitter<DecodePipelineEvents> {
  /** Top of the searched passband. Read by the waterfall too, so the two agree. */
  readonly maxHz: number;
  private mode: TxMode;
  private readonly inputRate: number;
  private readonly depth: number;
  private readonly silenceRms: number;

  private buffer: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Discard samples until this UTC ms — the tail of a window already taken. */
  private dropUntil = 0;
  /** The window most recently cut, so one window can never be cut twice. */
  private lastCutWindowMs = -1;
  /**
   * One-way transit from the radio, ms. See lib/radio/link-latency.ts.
   *
   * Audio over a VPN arrives this much after it happened at the antenna. The window
   * schedule works in ARRIVAL time: every cut and every drop boundary is shifted this
   * far later, so the buffer holds exactly the radio-time window it claims to — without
   * the shift, the last `lag` ms of every window have not arrived when it is cut, and
   * every decoded dt reads `lag` high.
   */
  private linkLatencyMs = 0;

  private readonly hashBook = new HashCallBook();
  private readonly ft2Book = new Ft2HashCallBook();

  private readonly priorityOffsetHz: (() => number | null) | null;
  private readonly candidateOffsetsHz: ((windowStartMs: number) => number[]) | null;
  private readonly transmitPendingFn: (() => boolean) | null;
  /**
   * The one full-band pass waiting for the transmitter, if any.
   *
   * At most one, ever. A second window cannot be cut while one is outstanding without
   * the outstanding one being run first — see `drainDeferred` — so decodes are never
   * dropped and never reordered relative to their windows.
   */
  private deferred: DeferredPass | null = null;
  private deferTimer: NodeJS.Timeout | null = null;

  constructor(opts: DecodePipelineOptions) {
    super();
    this.mode = opts.mode;
    this.inputRate = opts.inputSampleRate;
    this.depth = opts.depth ?? 2;
    this.silenceRms = opts.silenceRms ?? 0.001;
    this.priorityOffsetHz = opts.priorityOffsetHz ?? null;
    this.candidateOffsetsHz = opts.candidateOffsetsHz ?? null;
    this.transmitPendingFn = opts.transmitPending ?? null;
    // Clamped rather than trusted: the decoders work on 12 kHz audio, so anything at or
    // above 6 kHz is past Nyquist and asking for it would search noise. The floor keeps
    // a typo from producing a pipeline that decodes nothing at all.
    this.maxHz = Math.max(1_000, Math.min(5_500, Math.round(opts.maxHz ?? 3_000)));
    assertDecimable(this.inputRate);
  }

  get currentMode(): TxMode {
    return this.mode;
  }

  get periodMs(): number {
    return PERIOD_MS[this.mode];
  }

  get transmissionMs(): number {
    return TRANSMISSION_MS[this.mode];
  }

  /**
   * Tell the schedule how far away the radio is. Safe to call on every measurement —
   * it takes effect at the next window cut, which is the only place it is read.
   */
  setLinkLatencyMs(ms: number): void {
    this.linkLatencyMs = Math.max(0, Math.round(ms));
  }

  /**
   * The shift the schedule will actually use.
   *
   * Capped so the cut can never spill past the next boundary — FT2's window leaves only
   * ~600 ms between its cut point and the boundary, and a lag larger than the gap would
   * make the cut for window N fire after window N+1 began, taking N+1's head with it.
   * Exported as a pure function so check:link can assert the cap without waiting out
   * real T/R periods.
   */
  effectiveLagMs(): number {
    return effectiveLagMs(this.linkLatencyMs, this.periodMs, this.transmissionMs + CUT_MARGIN_MS);
  }

  /** Changing mode changes the window length, so the schedule restarts. */
  setMode(mode: TxMode): boolean {
    if (mode === this.mode) return false;
    // Anything still waiting on the transmitter was decoded under the OLD mode and is
    // still that mode's window. Run it before the switch rather than throwing it away.
    this.drainDeferred();
    this.mode = mode;
    this.buffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.start();
    }
    return true;
  }

  /**
   * Add received samples.
   *
   * Samples arriving between the cut and the next boundary are the guard-time tail of
   * the window already taken. They are dropped rather than buffered, or every window
   * would begin with a stale prefix.
   */
  push(samples: ArrayLike<number>): void {
    // The corrected clock, not Date.now(): dropUntil is derived from window starts,
    // which live on the corrected clock. Mixing the two frames made the drop run long
    // by exactly the SNTP offset, shaving the head off every window on a slow clock.
    if (nowMs() < this.dropUntil) return;
    for (let i = 0; i < samples.length; i++) this.buffer.push(samples[i] as number);
  }

  /** True while the tail of an already-decoded window is being discarded. */
  get dropping(): boolean {
    return nowMs() < this.dropUntil;
  }

  /**
   * Discard receive audio until `untilMs` — used while WE are transmitting.
   *
   * On a FlexRadio this is not needed: DAX receive audio goes silent while the radio
   * transmits, so the window is skipped as silent and nothing decodes. **The Icom keeps
   * streaming audio right through a transmission**, so without this the decoder hears our
   * own signal and reports it as a decode. Which it duly did, and the consequences were
   * worse than the cosmetic noise in the decode list:
   *
   *   - every one of our own transmissions was uploaded to PSKReporter as a station we
   *     had heard, so the coverage map showed us spotting ourselves
   *   - the deaf guard counts decodes to decide whether the receiver is working, and
   *     hearing ourselves would satisfy it while genuinely deaf
   *   - the clock check medians DT across decodes, and our own transmission is by
   *     definition perfectly timed, so it drags the estimate toward zero
   *
   * Never brought forward: a mute already extending past this is a longer transmission
   * than the one being asked about, and shortening it would un-mute mid-transmission.
   */
  muteUntil(untilMs: number): void {
    if (untilMs > this.dropUntil) this.dropUntil = untilMs;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleNextWindow();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
    // Decodes already paid for. Emitting them on the way down is strictly better than
    // discarding them — nothing downstream cares that the pipeline has stopped, and the
    // window they belong to is stamped on every one of them.
    this.drainDeferred();
  }

  /**
   * Arm the next cut.
   *
   * `afterWindowMs` is the window just taken. THE NEXT CUT IS DERIVED FROM IT, not from
   * "now", and that is the whole fix for a window that decoded nothing:
   *
   * This is called from INSIDE the cut, at which instant `(now - lag) % period` sits
   * exactly on `cutAt`. `setTimeout` may fire a fraction early, and `lag` is re-measured
   * between the two reads - on the live station it swung between 5 ms and 84 ms under
   * decode load. Either one puts `sincePeriod` a hair BELOW `cutAt`, so the "still ahead"
   * branch is taken and `delay` comes out at about a millisecond. The timer fires again
   * on the SAME window, against a buffer emptied a millisecond earlier, and emits a
   * zero-sample window - which the short-window branch then reports as packet loss.
   *
   * MEASURED, 2026-08-30: DAX delivered 600-650 kB of audio in every window including
   * the ones that decoded nothing, so the audio was always there and the pipeline was
   * discarding it. The dropped windows followed a transmission five times out of five,
   * because that is when the event loop is busiest and the jitter worst.
   *
   * Anchoring on the window just cut makes the next cut exactly one period later by
   * construction, so no amount of timer jitter or lag re-measurement can produce a second
   * cut of the same window.
   */
  private scheduleNextWindow(afterWindowMs?: number): void {
    const period = this.periodMs;
    const cutAt = this.transmissionMs + CUT_MARGIN_MS; // within the window

    // The whole schedule runs in the audio's ARRIVAL frame: real time minus the
    // one-way transit from the radio. A sample that left the antenna at boundary+cutAt
    // arrives lag ms later, and cutting before it arrives truncates every window by
    // the transit time. Subtracting lag from "now" shifts every cut and drop boundary
    // later by exactly that much, with no other arithmetic changing.
    const lag = this.effectiveLagMs();

    // Corrected time, not the OS clock. A window boundary is a claim about where the
    // rest of the world thinks the cycle starts, so it has to use the same clock the
    // rest of the world does — see lib/time/clock.ts.
    let delay: number;
    if (afterWindowMs !== undefined) {
      // One period after the window just taken, in arrival time. Never "now".
      delay = Math.max(1, afterWindowMs + period + cutAt + lag - nowMs());
    } else {
      // First arm only, where there is no previous window to anchor on.
      const sincePeriod = (nowMs() - lag) % period;
      // Next cut instant: this window's cut point if still ahead, else the next's.
      delay = sincePeriod < cutAt ? cutAt - sincePeriod : period - sincePeriod + cutAt;
    }

    this.timer = setTimeout(() => {
      // Re-read rather than captured: a measurement may have landed during the wait.
      const lagNow = this.effectiveLagMs();
      const samples = this.buffer;
      this.buffer = [];
      // We are at boundary+cutAt of the current window, in arrival time; identify
      // the window's start on the real clock.
      const windowStart = new Date(Math.floor((nowMs() - lagNow) / period) * period);

      // BELT AS WELL AS BRACES. The schedule above makes a repeat cut impossible; this
      // makes it harmless if it ever becomes possible again. A second cut of one window
      // has nothing to decode by definition - the first took the samples - so emitting it
      // can only ever produce a false empty window.
      if (windowStart.getTime() === this.lastCutWindowMs) {
        this.scheduleNextWindow(windowStart.getTime());
        return;
      }
      this.lastCutWindowMs = windowStart.getTime();

      // The guard-time tail also arrives lag late, so the drop extends by the same.
      this.dropUntil = windowStart.getTime() + period + lagNow;

      this.scheduleNextWindow(windowStart.getTime());
      this.processWindow(samples, windowStart);
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Decode one window.
   *
   * Public so it can be driven directly by the golden test, which is the only way to
   * assert this behaviour without waiting out real T/R periods.
   */
  processWindow(samples: number[], windowStart: Date): void {
    // A window from a LATER cut must never overtake decodes still waiting on the
    // transmitter. Bounded to one outstanding pass by construction: the deferral's own
    // deadline is the next cut, so in practice this fires only when the two race by a
    // few milliseconds.
    this.drainDeferred();

    // A partial window (startup, or packet loss) cannot contain a whole transmission.
    // The buffer covers the transmission span plus the cut margin, so the floor is
    // relative to that span rather than the full period.
    const minSamples = Math.floor(this.inputRate * (this.transmissionMs / 1000) * 0.7);
    if (samples.length < minSamples) {
      // WHY THIS DOES NOT TRY TO NAME OUR OWN TRANSMISSION. It cannot, and one release
      // spent believing it could: the test was `dropUntil > windowStart`, and `dropUntil`
      // is reassigned at EVERY cut to `windowStart + period + lag` for the guard tail, so
      // that condition is unconditionally true and classified every short window as ours.
      // The instrument went blind in exactly the case it was built for.
      //
      // `muteUntil` is also not the answer: only the Icom path calls it. A FlexRadio's DAX
      // audio simply stops during transmit, so the pipeline is never told at all.
      //
      // The bridge knows, because the RADIO tells it (`rig.on("transmit")`), and that is
      // where the classification belongs.
      this.emit("window", {
        windowStart,
        samples: samples.length,
        rms: 0,
        skipped: true,
        reason: "short",
        minSamples,
      });
      return;
    }

    let sumSq = 0;
    for (const s of samples) sumSq += s * s;
    const rms = Math.sqrt(sumSq / samples.length);

    if (rms < this.silenceRms) {
      // Almost certainly our own transmit cycle.
      this.emit("window", {
        windowStart,
        samples: samples.length,
        rms,
        skipped: true,
        reason: "silent",
      });
      return;
    }

    this.emit("window", { windowStart, samples: samples.length, rms, skipped: false });

    const audio = decimateTo12k(samples, this.inputRate);
    normalise(audio);

    // ---- the priority slices: the QSO partner, or the stations we are likely to call
    const slices = this.prioritySlices(windowStart);
    const priority: Decode[] = [];
    let spentMs = 0;
    for (const slice of slices) {
      const started = Date.now();
      let found: Decode[] = [];
      try {
        found = this.decodeFT8Range(audio, windowStart, slice.loHz, slice.hiHz);
      } catch (err) {
        // NEVER FATAL, unlike a failure of the full pass. This is an optimisation on top
        // of a search that is about to happen anyway, so the only correct response to it
        // failing is to say so and carry on to the search that matters.
        this.emit("error", err instanceof Error ? err : new Error("priority decode failed"));
        found = [];
      }
      const sliceMs = Date.now() - started;
      spentMs += sliceMs;
      if (found.length > 0) {
        priority.push(...found);
        this.emit("priorityDecodes", {
          windowStart,
          decodes: found,
          centreHz: slice.centreHz,
          loHz: slice.loHz,
          hiHz: slice.hiHz,
          decodeMs: sliceMs,
        });
        // `emit` is synchronous all the way down, so if that slice made us take the
        // transmitter there is nothing left to look for: the window's remaining
        // candidates are stations we are now NOT going to call, and every further slice
        // would be spent delaying the transmission it just produced.
        if (this.transmitPendingFn?.() === true) break;
      }
      // SELF-CALIBRATING, and measured rather than predicted: the slice that just ran is
      // the best estimate of what the next one costs on THIS machine. One slice always
      // runs — that is the cost the partner pass has paid since 1.153.0 — and a second
      // only runs when the first proved there is room for it.
      if (!anotherSliceFits(spentMs, sliceMs)) break;
    }

    // TWO CONDITIONS, AND BOTH MATTER.
    //
    // `priority.length > 0` is the "what if the slice finds nothing" case, and it is not
    // a corner: the slice is empty whenever the partner drifted, went quiet or was
    // stepped on, and in every one of those the full pass is all there is. An empty
    // slice therefore costs the ~110 ms of having looked and changes nothing else — no
    // event, no deferral, no delay. It CANNOT replace the full pass and it CANNOT
    // postpone it.
    //
    // `transmitPending` is the "did that actually make us key" case. `emit` is
    // synchronous all the way down, so by the time control reaches this line the
    // controller's handler has run, `runTick` has fired and the transmitter either took
    // the reply or did not. Only if it did is there anything to protect, and only then
    // does the full pass wait.
    if (priority.length > 0 && this.transmitPendingFn?.() === true) {
      this.deferred = {
        audio,
        windowStart,
        rms,
        priority,
        spentMs,
        // A safety valve, not the normal end of the wait — the transmitter clearing its
        // flag is. The two are ordered on purpose and the arithmetic is exact: our FT8
        // transmission ends 14,300 ms after this cut (15,000 - 13,840 to the next
        // boundary, plus 500 to the start of the transmission, plus 12,640 of it), and
        // this deadline is 15,000 ms, which is also the next window's cut. So a healthy
        // transmission always releases the wait first with 700 ms to spare, and the
        // deadline only ever fires for a flag that got stuck — where the lesser evil is
        // delaying the NEXT window's decode rather than losing this one.
        deadline: Date.now() + this.periodMs,
      };
      this.pollDeferred();
      return;
    }

    this.runFullPass({ audio, windowStart, rms, priority, spentMs, deadline: 0 });
  }

  /**
   * The full-band search, plus whatever the slice found that it did not.
   *
   * Extracted from `processWindow` unchanged in behaviour — same options, same mapping,
   * same event — so that it can also be reached from the deferral timer.
   */
  private runFullPass(p: DeferredPass): void {
    const started = Date.now();
    let decoded: { freq: number; snr: number; dt: number; msg: string }[];
    try {
      if (this.mode === "FT2") {
        // FT2 is decoded by our own port in lib/digital, not @e04/ft8ts, which does not
        // implement it. Mapped onto the same shape so nothing downstream has to know.
        decoded = ft2DecodeAudio(p.audio, {
          sampleRate: DECODE_SAMPLE_RATE,
          book: this.ft2Book,
        }).map((d) => ({
          freq: d.frequencyHz,
          snr: d.snrDb,
          dt: d.dtSeconds,
          msg: d.message,
        }));
      } else {
        const opts = {
          sampleRate: DECODE_SAMPLE_RATE,
          depth: this.depth,
          hashCallBook: this.hashBook,
          freqHigh: this.maxHz,
        };
        decoded = this.mode === "FT4" ? decodeFT4(p.audio, opts) : decodeFT8(p.audio, opts);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error("decode failed"));
      return;
    }
    // The CPU actually spent on this window, both passes, and NOT the deferral's idle
    // wait. The slow-decode warning in services/radio/index.ts reads this to judge
    // whether the machine can keep up, and a number inflated by 13 s of deliberate
    // waiting would answer a question nobody asked.
    const decodeMs = p.spentMs + (Date.now() - started);

    const full: Decode[] = decoded.map((d) => ({
      freqOffset: Math.round(d.freq),
      snr: Math.round(d.snr),
      dt: d.dt,
      message: d.msg.trim(),
      mode: this.mode,
      windowStart: p.windowStart,
    }));

    this.emit("decodes", {
      windowStart: p.windowStart,
      decodes: mergePriorityDecodes(full, p.priority),
      rms: p.rms,
      decodeMs,
    });
  }

  /**
   * The slices to search first, best first, or empty for "search the band as you always did".
   *
   * FT8 ONLY, and that is measured rather than cautious.
   *
   *   - FT4 CANNOT USEFULLY BE NARROWED. Measured against the same ten-signal window:
   *     a +/- 100 Hz slice centred exactly on a signal decodes NOTHING, and so does
   *     +/- 150; +/- 200 is the first width that finds it, at 92 ms against 75 ms for
   *     the whole 200-3000 Hz band. Narrowing FT4 is both slower and lossier. It also
   *     has nothing to buy: the full FT4 search costs a fifth of FT8's, and its window
   *     leaves 1,260 ms between the cut and the next boundary.
   *   - FT2 HAS NOTHING TO BUY EITHER, and the reason has been rewritten because the old
   *     one was arithmetic from a 3,000 ms period FT2 no longer has. The period is 3,750,
   *     the window is cut at 1,947 + 1,200 = 3,147, and the next transmission is due at
   *     the boundary itself — FT2 has no start offset. So the decode has 603 ms to finish
   *     in, and the whole 400-2800 Hz FT2 pass MEASURES 170 ms on this machine. It
   *     already fits, with three and a half times the room it needs.
   *
   *     FT4 is the same story with more slack: cut at 6,240 of a 7,500 ms period, the
   *     reply due at 8,000, so 1,760 ms of margin for a full pass measuring 92 ms.
   *
   * The whole of this file's priority machinery exists for ONE mode's arithmetic: FT8
   * cuts at 13,840, is due on the air at 15,500, and its full pass measures 1,435-1,795 ms
   * live. That is the only combination where the search does not comfortably fit.
   */
  private prioritySlices(windowStart: Date): PrioritySlice[] {
    if (this.mode !== "FT8") return [];

    // THE PARTNER WINS, ALONE AND WITHOUT A BUDGET.
    //
    // A contact in progress has one right answer to "who are we about to transmit to",
    // and it is not a guess: `QsoController.partnerOffsetHz` is their last decode. The
    // candidate list is the auto operator's opinion about who it MIGHT call next, which
    // is a different and weaker thing, and searching for those while a contact is live
    // would spend the window's margin looking for stations we are not going to answer.
    // So this returns exactly one slice and the loop in `processWindow` behaves as it
    // did before candidates existed.
    const partner = this.sliceAround(this.priorityOffsetHz?.());
    if (partner) return [{ ...partner, kind: "partner" }];

    const raw = this.candidateOffsetsHz?.(windowStart.getTime());
    if (!raw || raw.length === 0) return [];

    const out: PrioritySlice[] = [];
    for (const hz of raw) {
      const slice = this.sliceAround(hz);
      if (!slice) continue;
      // MERGED RATHER THAN REPEATED. Two candidates 80 Hz apart are one search, not two:
      // their slices overlap, the decoder would return the same signals twice, and the
      // second search would spend a whole slice's budget on audio just examined. Widening
      // the first is strictly cheaper and cannot lose either of them.
      // Only up to MAX_SLICE_WIDTH_HZ: past that the merged search costs more than the
      // two it replaced, and a long chain of near neighbours would widen one slice across
      // the band without the cap on the NUMBER of slices ever firing.
      const touching = out.find(
        (o) =>
          slice.loHz <= o.hiHz &&
          slice.hiHz >= o.loHz &&
          Math.max(o.hiHz, slice.hiHz) - Math.min(o.loHz, slice.loHz) <= MAX_SLICE_WIDTH_HZ,
      );
      if (touching) {
        touching.loHz = Math.min(touching.loHz, slice.loHz);
        touching.hiHz = Math.max(touching.hiHz, slice.hiHz);
        continue;
      }
      out.push({ ...slice, kind: "candidate" });
      if (out.length >= MAX_CANDIDATE_SLICES) break;
    }
    return out;
  }

  /** One centre offset to a bounded slice, or null when there is nothing to search. */
  private sliceAround(raw: number | null | undefined): { centreHz: number; loHz: number; hiHz: number } | null {
    if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
    const centreHz = Math.round(raw);
    // Outside the searched passband there is nothing to prioritise: a station reported
    // above `maxHz` cannot have been decoded by this pipeline in the first place.
    if (centreHz < 200 || centreHz > this.maxHz) return null;
    const loHz = Math.max(200, centreHz - PRIORITY_HALF_WIDTH_HZ);
    const hiHz = Math.min(this.maxHz, centreHz + PRIORITY_HALF_WIDTH_HZ);
    return { centreHz, loHz, hiHz };
  }

  /** One bounded FT8 search. Separate so the priority pass cannot drift from the full one. */
  private decodeFT8Range(
    audio: Float32Array,
    windowStart: Date,
    loHz: number,
    hiHz: number,
  ): Decode[] {
    return decodeFT8(audio, {
      sampleRate: DECODE_SAMPLE_RATE,
      depth: this.depth,
      // The SAME book as the full pass, deliberately: a hashed callsign resolved here is
      // resolved for the rest of the band a moment later, which is the whole reason the
      // library asks for one instance rather than one per call.
      hashCallBook: this.hashBook,
      freqLow: loHz,
      freqHigh: hiHz,
    }).map((d) => ({
      freqOffset: Math.round(d.freq),
      snr: Math.round(d.snr),
      dt: d.dt,
      message: d.msg.trim(),
      mode: this.mode,
      windowStart,
    }));
  }

  /** Ask again shortly whether the transmitter has finished. */
  private pollDeferred(): void {
    if (this.deferTimer) return;
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      const p = this.deferred;
      if (!p) return;
      if (Date.now() < p.deadline && this.transmitPendingFn?.() === true) {
        this.pollDeferred();
        return;
      }
      this.deferred = null;
      this.runFullPass(p);
    }, DEFER_POLL_MS);
    this.deferTimer.unref?.();
  }

  /** Run any outstanding full pass now. Safe to call when there is none. */
  private drainDeferred(): void {
    if (this.deferTimer) {
      clearTimeout(this.deferTimer);
      this.deferTimer = null;
    }
    const p = this.deferred;
    if (!p) return;
    this.deferred = null;
    this.runFullPass(p);
  }
}

/**
 * One bounded search to run before the full band, and where it came from.
 *
 * `kind` is not used to decide anything here — both kinds are decoded identically — but
 * it is what makes the budget rule legible: a partner slice is alone and unbudgeted, a
 * candidate slice is one of up to MAX_CANDIDATE_SLICES sharing CANDIDATE_BUDGET_MS.
 */
interface PrioritySlice {
  kind: "partner" | "candidate";
  centreHz: number;
  loHz: number;
  hiHz: number;
}

/** A full-band pass that has been paid for but not yet run. See `transmitPending`. */
interface DeferredPass {
  audio: Float32Array;
  windowStart: Date;
  rms: number;
  priority: Decode[];
  /** Milliseconds already spent decoding this window, so `decodeMs` stays honest. */
  spentMs: number;
  /** Wall-clock instant past which the wait ends regardless. 0 = not deferred. */
  deadline: number;
}

/**
 * The full-band result, plus any priority decode the full pass did not find.
 *
 * DUPLICATES ARE THE WHOLE RISK, and they are not merely untidy. `QsoSequencer.onDecode`
 * is NOT idempotent for an identical `(at, message)` — verified, not assumed, and
 * asserted in scripts/check-decode-priority.ts: a repeat of a message that does not move
 * the state machine falls through to `this.stalledRx++`, and `stalledRx >= maxRepeats`
 * abandons the contact with "they are not decoding us". Feeding one message twice
 * therefore halves the patience of a live QSO. A duplicate would also write a second
 * DigitalDecode row, a second websocket event and a second PSKReporter spot.
 *
 * The rule is deliberately narrow: a priority decode is the same signal as a full-band
 * one only when the message text matches AND the frequencies agree to within
 * PRIORITY_MATCH_HZ. Message text alone would be wrong — two stations calling "CQ DX" in
 * one window is ordinary — and frequency alone would be wrong on a crowded slice.
 *
 * The append case is rare but real: a marginal signal can decode inside a 200 Hz search
 * and not inside a 2,800 Hz one, because the candidate list is ranked and capped. Losing
 * it would mean the contact advanced off a decode that never appeared in the log or the
 * decode list, which is exactly the sort of untraceable gap this project has been bitten
 * by before.
 */
export function mergePriorityDecodes(full: Decode[], priority: Decode[]): Decode[] {
  if (priority.length === 0) return full;
  const extra = priority.filter(
    (p) =>
      !full.some(
        (f) =>
          f.message === p.message &&
          Math.abs(f.freqOffset - p.freqOffset) <= PRIORITY_MATCH_HZ,
      ),
  );
  return extra.length === 0 ? full : [...full, ...extra];
}

/**
 * How much of a measured link latency the window schedule may actually apply.
 *
 * The cut for window N happens at boundary(N) + cutAt + lag in wall time. If lag
 * exceeds the gap between the cut point and the next boundary, that instant falls
 * inside window N+1 and the cut steals its head. FT8 leaves ~1.2 s of gap, FT2 only
 * ~600 ms, so the cap is per mode and a link slower than the gap gets the gap — the
 * remainder shows up as reduced late-DT tolerance, which is the honest place for it.
 */
export function effectiveLagMs(latencyMs: number, periodMs: number, cutAtMs: number): number {
  const gap = periodMs - cutAtMs - 100; // 100 ms of scheduling slack
  if (gap <= 0) return 0;
  return Math.max(0, Math.min(Math.round(latencyMs), gap));
}

// ------------------------------------------------------------------------ filtering

/**
 * Anti-alias FIR taps for halving the sample rate.
 *
 * The taps sum to exactly 0.8000, so the passband gain is 0.80 and not unity. That is
 * not an accident of the design, it is the measurement: a 400 Hz tone goes in at 0.7071
 * RMS and comes out at 0.5639, and 0.5639/0.7071 = 0.797.
 *
 * It is also why `silenceRms` has to differ between a radio needing one pass and one
 * needing two. `normalise` removes the level difference before the decoder sees it, but
 * the silence check runs BEFORE normalisation, on the raw window.
 */
const DECIM_TAPS = [
  0.0072, 0.0303, 0.0904, 0.1633, 0.2176, 0.1633, 0.0904, 0.0303, 0.0072,
] as const;

function assertDecimable(rate: number): void {
  if (rate === DECODE_SAMPLE_RATE) return;
  const ratio = rate / DECODE_SAMPLE_RATE;
  if (!Number.isInteger(ratio) || (ratio & (ratio - 1)) !== 0) {
    throw new Error(
      `Sample rate ${rate} does not reduce to ${DECODE_SAMPLE_RATE} by halving; ` +
        `a resampler would be needed, and none exists here`,
    );
  }
}

/**
 * Halve the sample rate with an anti-alias FIR.
 *
 * Filtered in float64 first: the taps quantise badly at DAX's small amplitudes, which
 * peak around 0.07.
 */
export function decimateBy2(input: number[] | Float32Array): Float32Array {
  const n = input.length;
  const centre = (DECIM_TAPS.length - 1) >> 1;
  const filtered = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < DECIM_TAPS.length; k++) {
      const j = i - k + centre;
      if (j >= 0 && j < n) acc += DECIM_TAPS[k]! * (input[j] as number);
    }
    filtered[i] = acc;
  }

  const out = new Float32Array(Math.floor(n / 2));
  for (let i = 0; i < out.length; i++) out[i] = filtered[i * 2]!;
  return out;
}

/**
 * Reduce any supported rate to the decoders' 12 kHz.
 *
 * 24 kHz takes one halving, 48 kHz takes two. Both are exact, which is the reason no
 * resampler exists in this codebase and the reason `assertDecimable` refuses anything
 * else loudly rather than silently producing audio at the wrong rate — which decodes as
 * nothing at all, with no error to explain it.
 */
export function decimateTo12k(
  input: number[] | Float32Array,
  inputRate: number,
): Float32Array {
  assertDecimable(inputRate);
  let out: Float32Array =
    input instanceof Float32Array ? input : Float32Array.from(input);
  let rate = inputRate;
  while (rate > DECODE_SAMPLE_RATE) {
    out = decimateBy2(out);
    rate /= 2;
  }
  return out;
}

/** Scale to a usable amplitude in place. DAX audio peaks around 0.07. */
export function normalise(samples: Float32Array, target = 0.9): void {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return;
  const gain = target / peak;
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * gain;
}

import { nowMs } from "@/lib/time/clock";
import { PERIOD_MS, transmitStartAt, TX_START_OFFSET_MS } from "@/lib/radio/timing";
import { TRANSMISSION_MS } from "@/lib/radio/decode-pipeline";
import { MAX_OFFSET_HZ as WAVEFORM_MAX_OFFSET_HZ, type TxMode } from "@/lib/radio/waveform";

/**
 * How long it takes to get from "transmit this" to RF, ms.
 *
 * THIS REPLACES `FIRST_TX_LEAD_MS`, WHICH WAS 400 AND HAD A DEAD ZONE UNDER IT.
 *
 * The old rule was a pair of tests: send if there are 400 ms in hand, or send if we are
 * late but not late enough to matter. A lead BETWEEN 0 and 400 ms satisfied neither, so
 * `firstTxWindow` skipped the window and the call waited a full 30 seconds. That is not
 * a corner. It is where the automatic path habitually landed: the decode of the window
 * we are answering finishes about 1,500 ms after the boundary, the reply is due at +500,
 * and the arithmetic put the lead at roughly +102 ms. The log carries the consequence in
 * plain words — `first transmission in 27.9s`, forty times in one day.
 *
 * It also meant MORE DELAY MADE TRANSMITTING MORE LIKELY, because another second of
 * decoding pushed the lead below zero and back into the late branch. Anything that made
 * the station faster — the partner slice in 1.153.0, the candidate slice here — moved
 * the timing INTO the gap rather than past it.
 *
 * So the test is no longer "is there room to be comfortable" but "how late will the
 * audio actually be", and a lead of 0-400 ms is answered honestly: the transmission goes
 * out, a few tens of milliseconds late, which every mode here tolerates and which is
 * thirty seconds better than the alternative.
 *
 * MEASURED, on this machine: `buildWaveform` takes 7.4 ms median and 15 ms worst for a
 * 303,360-sample FT8 waveform (3.0 / 5.8 for FT4, 1.3 / 2.8 for FT2). The live box
 * benchmarks about 3.4x slower on decode work, so call it 50 ms there. The one-way trip
 * to this station's FlexRadio is a measured 11-40 ms, and `FlexDaxTransmitter.transmit`
 * already keys early by it whenever it has the lead to do so. 100 ms covers both with
 * room, and is a quarter of the 400 ms it replaces.
 */
const KEY_PREP_MS = 100;

/**
 * How late the FIRST transmission of a call may start, per mode — DERIVED, not chosen.
 *
 * The old table was three hand-picked numbers: FT8 1,500, FT4 800, FT2 0. The FT8 figure
 * was the one that hurt. An FT8 window has 1,860 ms of slack after its 12,640 ms of audio
 * (15,000 period, 500 start offset), and spending 1,500 of it leaves 360 ms — which is
 * less than the worst overrun the live instrumentation actually measured. Over eleven
 * days `TX refused: A transmission is already in progress` ran at 1.1-3.6% of attempts
 * and then stepped to 9.8% in the hour 1.129.0 landed; every refusal is `keyed and busy`,
 * the radio genuinely on the air, and the dominant cluster (62%, n=34) holds the
 * transmitter 14,248-15,367 ms against a 15,000 ms period — up to 367 ms PAST the end of
 * the window it belongs to.
 *
 * TWO CEILINGS, AND THE ANSWER IS THE LOWER ONE.
 *
 *   1. TIMING. Half the slack, so a late transmission never consumes more of the window's
 *      margin than it leaves behind. FT8 1,860 -> 930, FT4 1,960 -> 980, FT2 1,803 -> 901.
 *      The 930 ms left over is 2.5x the largest overrun measured.
 *   2. DECODABILITY. Being inside our own window is worthless if the far end cannot read
 *      it. MEASURED here against the real decoder, one station placed late in a
 *      ten-signal window — see scripts/check-first-tx.ts, which asserts these cliffs so
 *      they cannot quietly move:
 *
 *          FT8   still decodes at 2,000 ms late   (no cliff inside the slack at all)
 *          FT4   decodes at 900, GONE at 1,000
 *          FT2   decodes at 400, GONE at 500
 *
 * So FT8 is limited by timing and FT4 by the decoder, which is why FT4 keeps its 800 ms
 * — arrived at independently and now confirmed to sit one measured step inside its own
 * cliff. FT8 drops from 1,500 to 930.
 *
 * FT2 IS PINNED TO ZERO and the derivation does not get a vote. Its DT search spans only
 * 0.5 s — see lib/radio/timing.ts — and the measurement above agrees: 400 ms late reads,
 * 500 ms does not. Both ceilings would allow several hundred milliseconds; transmitting
 * there would cost a cycle AND put a signal on the air that nobody can decode, which is
 * worse than waiting. A slack derivation alone would have handed FT2 901 ms, and that is
 * exactly the sort of tidy arithmetic that ships an unreadable transmitter.
 */
// The tolerance moved to lib/radio/timing.ts so `lib/flex/tx.ts` can apply the SAME number
// as its own last-line refusal. It used to refuse below a hardcoded -1,500 ms for every
// mode, which meant it would have transmitted FT2 1.5 s late — a mode measured not to
// decode at all beyond 400 ms. Re-exported: this module is where the checks and the
// operating layer already look for it.
export { lateTxToleranceMs } from "@/lib/radio/timing";
import { lateTxToleranceMs } from "@/lib/radio/timing";

import type { FlexDaxSource } from "@/lib/flex/dax";
import type { DigitalSource, DigitalTransmitter } from "@/lib/radio/types";
import type { DigitalMode } from "@/lib/ham/digital-freqs";
import type { FlexDaxTransmitter } from "@/lib/flex/tx";
import {
  OperatingGuards,
  QsoSequencer,
  parseMessage,
  standardMessages,
  type AbandonedExchange,
  type QsoLogData,
} from "@/lib/digital/qso";
import { formatTranscript, type TranscriptEntry } from "@/lib/digital/transcript";

// Drives one QSO at a time over the native transmit path.
//
// FT8 is half-duplex by convention: the two stations transmit on opposite 15 s
// windows. Whoever we are working transmitted in a window of some parity, so we
// transmit on the other parity and listen on theirs. The controller never keys
// the radio on its own initiative — every transmission is a QsoSequencer tick on
// our parity, and the sequencer only exists because an operator (or, later, an
// explicitly enabled auto mode) started it.

/**
 * What the log entry needs that the FT8 exchange itself does not carry.
 *
 * The special-activity pair lives here rather than in `QsoSequencer` on purpose:
 * the park is a fact about why we called someone, not part of the protocol. An
 * FT8 message has no room for a park reference and the state machine has no
 * business knowing about POTA.
 */
export interface QsoLogContext {
  band: string | null;
  mode: string;
  freqHz: number | null;
  /** ADIF SIG — "POTA" when this contact was made chasing or answering one. */
  sig: string | null;
  /** ADIF SIG_INFO — the park reference, when we know which park. */
  sigInfo: string | null;
  /** Which radio made it, as the radio reports itself. ADIF MY_RIG. */
  radio: string | null;
  /**
   * ADIF TX_PWR — measured forward power for this contact, in watts.
   *
   * Null when the radio has no forward-power meter, or when nothing was measured
   * because the contact completed without us transmitting.
   */
  txPowerW: number | null;
  /**
   * The whole exchange, both directions, as text. Null when nothing was recorded.
   *
   * See lib/digital/transcript.ts. The exchange is the contact, and the log used to
   * keep two messages out of six.
   */
  transcript: string | null;
}

export interface QsoControllerOptions {
  /**
   * The radio's own transmit-filter ceiling in Hz, asked fresh, or null when it does not
   * report one.
   *
   * A closure rather than a number because it arrives asynchronously — the FlexRadio sends
   * `transmit … lo=100 hi=3100` when it feels like it, and a value read at construction
   * would be null for ever on a connection that had not seen one yet.
   */
  txFilterHiHz?: () => number | null;
  /**
   * The clock this controller schedules against. Defaults to the corrected wall clock.
   *
   * Injectable because it was NOT, and that was a hidden dependency rather than a
   * convenience. Every other instant in the QSO path arrives as an argument — window
   * events carry their own start, `tick` takes the instant it is advancing to — but
   * `firstTxWindow` reached for `nowMs()` directly. So the one piece of scheduling that
   * decides whether a call goes out in this window or the next was the one piece that
   * could not be driven by a test, and five assertions in `check:operating` had been
   * failing since it was written without anyone being able to see why.
   *
   * It works live, because there the wall clock and the window stream are the same clock.
   * That is exactly what made it invisible.
   */
  now?: () => number;
  /**
   * Typed to the narrow shapes in lib/radio/types.ts, not to the FlexRadio classes.
   *
   * These layers only ever read `source.periodMs` and call `tx.transmit` / `tx.unkey`.
   * Naming the concrete Flex types here was what made the whole operating layer look
   * Flex-specific when it never was — and it was the only thing stopping the Icom from
   * using it.
   */
  source: DigitalSource;
  tx: DigitalTransmitter;
  guards: OperatingGuards;
  identity: { myCall: string; myGrid: string };
  /** Current band/mode/dial, read at transmit time. */
  getBandMode: () => { band: string | null; mode: DigitalMode; dialHz: number | null };
  /** What the radio calls itself, for the log. */
  radio: () => string | null;
  /**
   * How each contact ended.
   *
   * The auto operator needs it to judge whether the band is paying: hearing plenty
   * and working nobody is a failure the decode count can never show.
   */
  onOutcome?: (result: "made" | "lost") => void;
  /**
   * Measured forward power for the contact in progress.
   *
   * Reset when a contact starts and read when it is logged, so the figure belongs
   * to THAT contact rather than to whatever the transmitter last did. Optional so a
   * test harness need not simulate a power meter; a radio without one simply logs
   * nothing for it.
   */
  txPower?: { reset(): void; watts(): number | null };
  /** "Is this call already logged on band+mode since sinceMs?" */
  wasWorked: (call: string, band: string, mode: string, sinceMs: number) => Promise<boolean>;
  /** Persist a completed QSO. */
  onLog: (log: QsoLogData, ctx: QsoLogContext) => Promise<void>;
  /**
   * An exchange that swapped reports and was never acknowledged.
   *
   * Optional so a harness need not care. Called with the same context `onLog` gets, because
   * the band, mode, frequency and transcript are what make the row judgeable later.
   */
  onIncomplete?: (x: AbandonedExchange, ctx: QsoLogContext) => Promise<void>;
  broadcast: (event: unknown) => void;
  log: (line: string) => void;
}

export interface QsoPublicState {
  active: boolean;
  theirCall: string | null;
  state: string | null;
  lastSent: string | null;
  txParity: 0 | 1 | null;
  txOffsetHz: number | null;
  pausedReason: string | null;
  messages: ReturnType<typeof standardMessages> | null;
  /**
   * The exchange so far, both directions, live.
   *
   * The panel showed `lastSent` — one line, our side only — so an operator watching a
   * contact could see what we had just transmitted and nothing of what came back. The
   * controller has recorded the whole thing all along; it was only written to the log at
   * completion, which is the one moment it is no longer needed on screen.
   *
   * Sent on every state broadcast. A whole FT8 exchange is six or so thirteen-character
   * messages, so this costs nothing next to the decode stream already going down the
   * same socket.
   */
  transcript: TranscriptEntry[];
}

/**
 * Highest audio offset we can actually transmit on.
 *
 * The RECEIVER can be told to search wider — `digital.passbandHz` does exactly that, and
 * finds stations above 3 kHz that were being clipped. The TRANSMITTER cannot follow: a
 * DIGU slice and an IC-7300's USB-D both roll off below 3 kHz, so audio placed up there
 * leaves the radio attenuated or not at all.
 *
 * So a station heard at 3400 Hz can be decoded and cannot be answered. Answering on the
 * wrong frequency is not a fallback — they are listening where they transmitted — and
 * clamping silently is how an operator ends up watching Auto Hunt call the same
 * unreachable station every cycle.
 */
export const MAX_TX_OFFSET_HZ = 2_800;
const MIN_TX_OFFSET_HZ = 200;

/**
 * Room left below the filter's edge for the signal itself.
 *
 * An offset names where a transmission STARTS; FT8 spreads eight tones 6.25 Hz apart above
 * it and FT4 four tones 20.83 Hz apart, so the signal reaches about 90 Hz higher than the
 * number. Answering at exactly the filter edge would put most of the tones outside it.
 */
const TX_EDGE_GUARD_HZ = 100;

/**
 * The highest offset a radio will actually transmit at, from what it reports.
 *
 * A free function as well as a method because the ANSWER has to be visible. Shipped in
 * 1.143.0 reading only from inside the controller, this was unfalsifiable from outside:
 * a `transmit` status line carries only the fields that changed, so if the radio never
 * sent `hi` the ceiling would stay at the conservative default and nothing anywhere would
 * say so — the fix would silently do nothing and look exactly like the fix working.
 * MEASURED since: `sub tx all` does deliver `lo=100 hi=3100` on a FLEX-6400 at subscribe.
 */
/**
 * Who sent a message, or null when the message names no sender.
 *
 * One definition for the two places that ask. `recordRx` decides whether a decode
 * belongs to the contact in progress and `onPriorityDecodes` decides whether the slice
 * held anything worth acting on early, and those must agree exactly: a message counted
 * as the partner's by one and not the other would be recorded in the transcript without
 * advancing anything, or the reverse.
 */
function senderOf(message: string): string | null {
  const p = parseMessage(message);
  return p.kind === "cq" || p.kind === "directed" ? p.from : null;
}

export function resolveMaxTxOffset(reported: number | null): number {
  if (reported === null || !Number.isFinite(reported)) return MAX_TX_OFFSET_HZ;
  // Never BELOW the conservative default: a radio reporting something implausibly narrow
  // must not silently shrink what we will answer.
  //
  // AND NEVER ABOVE WHAT WAVEFORM GENERATION WILL ACCEPT. `buildWaveform` refuses any
  // offset past `waveform.MAX_OFFSET_HZ` (2,800) unconditionally - that gate is about the
  // SSB crystal filter, not this radio's reported passband. With the FLEX reporting
  // hi=3100 this function used to answer 3,000, so the controller would commit to a
  // station at 2,995 Hz that generation then refused EVERY window: observed live as
  // "calling AA1SU" with three consecutive refusals and nothing ever on the air. Two
  // ceilings that disagree are worse than either, because the gap between them is a set
  // of stations the radio promises to answer and physically never will.
  return Math.min(
    WAVEFORM_MAX_OFFSET_HZ,
    Math.max(MAX_TX_OFFSET_HZ, Math.round(reported) - TX_EDGE_GUARD_HZ),
  );
}

export class QsoController {
  private readonly o: QsoControllerOptions;
  private seq: QsoSequencer | null = null;
  /** Window parity (windowIndex % 2) we transmit on. */
  private txParity: 0 | 1 | null = null;

  /**
   * The highest offset this radio will actually transmit at, asked fresh.
   *
   * `MAX_TX_OFFSET_HZ` is the conservative default and stays the answer for a radio that
   * does not report its transmit filter — an IC-7300 selects its passband in a menu that
   * CI-V cannot read. A FlexRadio DOES report it (`transmit … lo=100 hi=3100`), and
   * refusing to answer anyone between 2800 and 3100 Hz on a radio that says it can reach
   * 3100 is throwing away a slice of the band for no reason.
   */
  /** The clock, as configured. See `now` on the options. */
  private now(): number {
    return this.o.now ? this.o.now() : nowMs();
  }

  private maxTxOffset(): number {
    return resolveMaxTxOffset(this.o.txFilterHiHz?.() ?? null);
  }
  private txOffsetHz = 1500;
  private lastSent: string | null = null;
  private seenWindows = new Set<number>();
  /**
   * The transmit window `runTick` has already advanced the sequencer for.
   *
   * Needed once a call can schedule its OWN first transmission instead of waiting for the
   * next window event: both paths can arrive at the same target window, and ticking a
   * sequencer twice for one window would send the next message a cycle early.
   */
  private lastTickWindow: number | null = null;
  /**
   * Special activity for the contact in progress.
   *
   * Set when the call is started and cleared by the next one, so it can never
   * attach a park reference to an unrelated QSO.
   */
  private activity: { sig: string | null; sigInfo: string | null } = { sig: null, sigInfo: null };
  /**
   * Every message of the contact in progress, both directions.
   *
   * Reset by each new call for the same reason `activity` is: a transcript attached to
   * the wrong contact would be worse than no transcript.
   */
  private transcript: TranscriptEntry[] = [];
  /**
   * `at|message` pairs already handed to the sequencer, most recent windows only.
   *
   * NEEDED BECAUSE `QsoSequencer.onDecode` IS NOT IDEMPOTENT. That is verified rather
   * than believed — scripts/check-decode-priority.ts asserts it directly — and the
   * mechanism is specific: a message from our partner that does not move the state
   * machine falls through `applyOne`'s final comparison to `this.stalledRx++`, and
   * `tick` abandons the contact once `stalledRx` reaches `maxRepeats`, with "they are
   * not decoding us". So feeding one message twice does not merely waste a call, it
   * halves the patience of a live QSO and ends contacts that were working.
   *
   * It became reachable when the partner's slice started being decoded ahead of the
   * band: their reply now arrives once on `priorityDecodes` and again in that window's
   * `decodes`, which is by design — see DecodePipelineEvents.priorityDecodes — and both
   * paths feed the sequencer.
   *
   * The transcript has its own guard on the same `(at, message)` pair and always had
   * one; this is the sequencer's, which never did.
   */
  private fedToSeq = new Set<string>();
  /** See `transmitPending`. */
  private txPending = false;

  constructor(opts: QsoControllerOptions) {
    this.o = opts;

    // Both hooks matter: `decodes` fires for windows with signals, but the
    // window WE transmit in is silent on RX and only emits `window` — and the
    // repeat logic must still run after it.
    opts.source.on("decodes", ({ windowStart, decodes }) => {
      for (const d of decodes) {
        this.recordRx(d, windowStart.getTime());
        this.feedSequencer(d.message, windowStart.getTime());
      }
      this.afterWindow(windowStart.getTime());
    });
    opts.source.on("window", ({ windowStart, skipped }) => {
      if (skipped) this.afterWindow(windowStart.getTime());
    });
  }

  /**
   * The partner's slice, decoded ahead of the rest of the band. THE POINT OF ALL THIS.
   *
   * NOT A BUG FIX — 1.139.1 published the correction that lateness is not losing
   * contacts, and the measurement behind it stands: completed and abandoned QSOs have
   * the same median timing, 536 ms against 554 ms across 26,000 transmissions. What this
   * reclaims is margin, not contacts.
   *
   * The margin is real and it is arithmetic. A reply is scheduled from a decode, the
   * decode cannot start until the window has ended, and the full 200-3000 Hz search
   * measures 1558 ms on the live box against 420-476 ms for a 200 Hz slice around a
   * partner we already know the offset of. The window is cut at 13,840 ms and FT8's
   * reply is due on the air at 15,500 ms, so the full search leaves about a tenth of a
   * second to build the waveform and key the radio, while the slice leaves 1,240 ms.
   *
   * NOT WIRED THROUGH `source`. The event is real — see DecodePipelineEvents — but
   * `DigitalSource` in lib/radio/types.ts deliberately names only the two events the
   * operating layer needs, and widening that seam to carry an optimisation would undo
   * the point of having narrowed it. The bridge calls this instead.
   *
   * Called with a window the controller may already have seen, or with decodes belonging
   * to nobody we are working; both are handled here rather than by the caller.
   */
  onPriorityDecodes(d: { windowStart: Date; decodes: { message: string; snr: number; freqOffset: number }[] }): void {
    const seq = this.seq;
    if (!seq || seq.isDone) return;
    const at = d.windowStart.getTime();

    // ONLY OUR PARTNER SHORT-CIRCUITS THE WINDOW, and a slice that holds nothing of
    // theirs is treated as though it had never run.
    //
    // This is the "what if the narrow pass finds nothing" case and it is not a corner:
    // acting on an empty slice would tick the sequencer with no new information, and a
    // tick with nothing new RE-SENDS THE LAST MESSAGE. Their actual reply would then
    // arrive with the full pass a second later, into a sequencer that had already spent
    // the window repeating itself and counted a repeat against `maxRepeats`. Answering a
    // report with a repeated grid is worse than answering it a beat late.
    //
    // So: no partner in the slice, no state change of any kind, and `afterWindow` is
    // left for the full pass exactly as before.
    const mine = d.decodes.filter((x) => senderOf(x.message) === seq.theirCall);
    if (mine.length === 0) return;

    for (const x of mine) {
      this.recordRx(x, at);
      this.feedSequencer(x.message, at);
    }
    // The advance. `afterWindow` dedupes on the window, and `runTick` again on the
    // transmit window, so the full pass arriving later with the same message changes
    // nothing — asserted in scripts/check-decode-priority.ts rather than assumed.
    this.afterWindow(at);
  }

  /**
   * Where the station we are working transmits, or null when we are not working anyone.
   *
   * READ, NOT INVENTED. Their offset is recorded on every decode of theirs that reaches
   * the transcript — `recordRx` writes `offsetHz` from the decode itself — and the call
   * that opened the contact wrote the offset it was started from. So the last receive
   * line of the transcript IS the most recent measurement of where they are, refreshed
   * every cycle, and this reports it rather than keeping a second copy that could
   * disagree with it.
   *
   * The fallback is `txOffsetHz`, which is where WE are transmitting. That is their
   * frequency too by construction: `startCall` answers on the offset they were heard at,
   * and `startAnswer` keeps our CQ frequency because an answerer comes to it. It matters
   * for the first window of a contact started without a message — before any decode of
   * theirs exists.
   */
  get partnerOffsetHz(): number | null {
    if (!this.seq || this.seq.isDone) return null;
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const e = this.transcript[i]!;
      if (e.dir === "rx" && typeof e.offsetHz === "number" && Number.isFinite(e.offsetHz)) {
        return Math.round(e.offsetHz);
      }
    }
    return this.txOffsetHz;
  }

  /**
   * True from the instant a message is handed to the transmitter until it lets go.
   *
   * Set SYNCHRONOUSLY inside `runTick`, which matters: the decode pipeline asks this
   * question immediately after emitting the priority decodes, and `EventEmitter.emit` is
   * synchronous all the way down — emit, this controller's handler, `afterWindow`,
   * `runTick`, `tx.transmit(...)` — so the answer is already correct by the time the
   * pipeline reads it. Nothing has to be awaited and nothing has to be guessed.
   *
   * It stays true for the whole transmission, not just the wait before keying, because
   * `FlexDaxTransmitter.streamAudio` paces its packets against a wall-clock deadline
   * with a sleep between each. A full-band decode blocking the event loop mid-stream
   * would stall that pacing exactly as it stalls the key.
   */
  get transmitPending(): boolean {
    return this.txPending;
  }

  get state(): QsoPublicState {
    return {
      active: this.seq !== null && !this.seq.isDone,
      theirCall: this.seq?.theirCall ?? null,
      state: this.seq?.currentState ?? null,
      lastSent: this.lastSent,
      txParity: this.txParity,
      txOffsetHz: this.seq ? this.txOffsetHz : null,
      pausedReason: this.o.guards.pausedReason,
      // Copied, not handed out by reference: `record()` mutates this array in place and a
      // consumer holding the live one would see entries appear inside a message it had
      // already serialised.
      transcript: [...this.transcript],
      messages: this.seq
        ? standardMessages({
            myCall: this.o.identity.myCall,
            myGrid: this.o.identity.myGrid,
            theirCall: this.seq.theirCall,
            theirSnr: 0,
          })
        : null,
    };
  }

  /**
   * Start calling a station picked from the decode list.
   *
   * `theirWindowStart` is the window their transmission decoded in — it fixes
   * which parity is theirs, and therefore which is ours.
   */
  async startCall(req: {
    theirCall: string;
    theirGrid?: string | null;
    theirSnr: number;
    theirOffsetHz: number;
    theirWindowStart: number;
    /** ADIF SIG, e.g. "POTA" — recorded on the logged contact. */
    sig?: string | null;
    /** ADIF SIG_INFO, e.g. "US-1689". */
    sigInfo?: string | null;
    /**
     * The decoded message that made us call them, verbatim.
     *
     * Opens the transcript. Without it the record starts with our own reply to
     * something unrecorded, which reads as though we called into empty air.
     */
    theirMessage?: string | null;
  }): Promise<{ ok: boolean; reason?: string }> {
    const { band, mode } = this.o.getBandMode();

    if (this.seq && !this.seq.isDone) {
      return { ok: false, reason: `Already working ${this.seq.theirCall} — halt first` };
    }

    // Refused rather than clamped: see MAX_TX_OFFSET_HZ. Auto Hunt takes the `ok:
    // false` and moves to the next candidate, which is the right outcome — there will
    // be someone else, and there is nothing to be gained by calling into a passband the
    // transmitter cannot reach.
    const wanted = Math.round(req.theirOffsetHz);
    const ceiling = this.maxTxOffset();
    if (wanted > ceiling) {
      return {
        ok: false,
        reason: `${req.theirCall} is at ${wanted} Hz, above the ${ceiling} Hz the transmitter can place audio at — decodable, not answerable`,
      };
    }

    const may = await this.o.guards.mayCall(
      req.theirCall,
      band ?? "?",
      mode,
      Date.now(),
      this.o.wasWorked,
    );
    if (!may.allowed) return { ok: false, reason: may.reason };

    const period = this.o.source.periodMs;
    const theirParity = (Math.floor(req.theirWindowStart / period) % 2) as 0 | 1;
    this.txParity = ((theirParity + 1) % 2) as 0 | 1;
    // Answer on their frequency — the normal convention when calling a CQ.
    this.txOffsetHz = Math.max(MIN_TX_OFFSET_HZ, Math.min(ceiling, wanted));

    this.seq = new QsoSequencer({
      myCall: this.o.identity.myCall,
      myGrid: this.o.identity.myGrid,
      theirCall: req.theirCall,
      theirGrid: req.theirGrid ?? null,
      theirSnr: req.theirSnr,
      role: "caller",
      startedAt: this.now(),
    });
    this.activity = { sig: req.sig ?? null, sigInfo: req.sigInfo ?? null };
    this.transcript = [];
    // A new sequencer has a fresh patience budget, so the record of what has been fed to
    // one starts fresh too. See `fedToSeq`.
    this.fedToSeq.clear();
    // Power measured from here on belongs to THIS contact, not the last one.
    this.o.txPower?.reset();
    if (req.theirMessage) {
      this.record({
        at: req.theirWindowStart,
        dir: "rx",
        message: req.theirMessage,
        snr: req.theirSnr,
        offsetHz: req.theirOffsetHz,
      });
    }
    // RESUME THE EXCHANGE, rather than starting it again.
    //
    // Pressing Call on a decode built a fresh sequencer in the "calling" state, so a
    // station that had already sent us a report — or RR73 — was answered with an opening
    // grid message as though nothing had happened. Reported as "if i click call on their
    // rr73 it restarts the call ... it should pick back up where it was".
    //
    // The machine already knows how to do this: `onDecode` is what advances it during a
    // contact, and it advances the same way whether the message arrives live or is handed
    // over now. So the message that prompted the call is fed straight in. Their report
    // moves us to owing an R-report; their RR73 completes the contact and leaves the
    // courtesy 73 owed, which the next tick sends and logs.
    //
    // Only messages addressed to us by them move it — `onDecode` checks that itself — so
    // clicking Call on a CQ still opens normally.
    if (req.theirMessage) {
      // Through the same gate the decode paths use, so the window's own `decodes` event
      // — which fires around now, since this call was decided from inside it — cannot
      // hand the sequencer the same message a second time.
      this.feedSequencer(req.theirMessage, req.theirWindowStart);
      if (this.seq.currentState !== "calling") {
        this.o.log(
          `[qso] resuming with ${req.theirCall} at "${this.seq.currentState}" — they had already sent "${req.theirMessage}"`,
        );
      }
    }

    this.lastSent = null;
    this.lastTickWindow = null;
    this.o.guards.operatorTouched();
    this.o.log(
      `[qso] calling ${req.theirCall} at ${this.txOffsetHz} Hz, our parity ${this.txParity}`,
    );

    // TRANSMIT IN THE NEXT WINDOW OF OUR PARITY, rather than waiting for the next window
    // event to notice there is a sequencer now.
    //
    // Setting up the sequencer and returning is what made every call wait an extra cycle:
    // by the time the decode that prompted the call has been decoded, `afterWindow` has
    // already run for that window and found nothing to do, and the window after it belongs
    // to the station we are answering. See firstTxWindow.
    const first = this.firstTxWindow();
    if (first !== null) {
      this.o.log(`[qso] first transmission in ${((first - this.now()) / 1000).toFixed(1)}s`);
      this.runTick(first);
    }

    this.broadcastState();
    return { ok: true };
  }

  get hasActive(): boolean {
    return this.seq !== null && !this.seq.isDone;
  }

  /**
   * Answer a station that called US (they replied to our CQ).
   *
   * No dupe guard here on purpose: refusing to answer someone who just called
   * you is worse manners than a dupe. The runaway/deaf brakes still apply via
   * beforeTx like every other transmission. Parity and offset stay wherever our
   * CQ was — answerers come to the CQ frequency.
   */
  startAnswer(req: {
    theirCall: string;
    theirGrid?: string | null;
    theirSnr: number;
    parity: 0 | 1;
    offsetHz: number;
    sig?: string | null;
    sigInfo?: string | null;
    /** What they called us with, verbatim. Opens the transcript. */
    theirMessage?: string | null;
    /** The window it decoded in, for the transcript's first timestamp. */
    theirWindowStart?: number;
  }): boolean {
    if (this.seq && !this.seq.isDone) return false;
    this.txParity = req.parity;
    this.txOffsetHz = Math.max(
      MIN_TX_OFFSET_HZ,
      Math.min(this.maxTxOffset(), Math.round(req.offsetHz)),
    );
    this.seq = new QsoSequencer({
      myCall: this.o.identity.myCall,
      myGrid: this.o.identity.myGrid,
      theirCall: req.theirCall,
      theirGrid: req.theirGrid ?? null,
      theirSnr: req.theirSnr,
      role: "answerer",
      startedAt: this.now(),
    });
    this.activity = { sig: req.sig ?? null, sigInfo: req.sigInfo ?? null };
    this.transcript = [];
    this.fedToSeq.clear();
    this.o.txPower?.reset();
    if (req.theirMessage) {
      this.record({
        at: req.theirWindowStart ?? Date.now(),
        dir: "rx",
        message: req.theirMessage,
        snr: req.theirSnr,
        offsetHz: req.offsetHz,
      });
    }
    this.lastSent = null;
    this.lastTickWindow = null;
    this.o.log(`[qso] answering ${req.theirCall} (they called us)`);
    // Same reasoning as startCall: someone who has just called us is waiting through the
    // next window, and answering two periods later is how a tail-ender gives up and works
    // somebody else.
    const first = this.firstTxWindow();
    if (first !== null) this.runTick(first);
    this.broadcastState();
    return true;
  }

  /** Operator halt: stop the sequencer and force the transmitter down. */
  async halt(): Promise<void> {
    this.seq = null;
    this.txParity = null;
    this.lastTickWindow = null;
    this.fedToSeq.clear();
    // The operator's panic handle. Nothing may keep waiting on this transmission,
    // including a full-band decode deferred behind it.
    this.txPending = false;
    this.o.guards.operatorTouched();
    await this.o.tx.unkey();
    this.o.log("[qso] halted by operator");
    this.broadcastState();
  }

  /**
   * Give up on the station in progress, and only that.
   *
   * HALT is the panic handle — the caller stops the auto mode with it. Skip is the
   * polite version for "not this one": wrong station clicked, a dead-air exchange the
   * operator can see is going nowhere. The skipped call gets the same failure
   * cooldown a natural give-up would, because without it Auto Hunt would answer the
   * same station's very next CQ and the button would appear to do nothing.
   */
  async skip(): Promise<void> {
    const call = this.seq?.theirCall ?? null;
    this.seq = null;
    this.txParity = null;
    this.lastTickWindow = null;
    this.fedToSeq.clear();
    this.txPending = false;
    this.o.guards.operatorTouched();
    if (call) this.o.guards.recordFailure(call, Date.now());
    await this.o.tx.unkey();
    this.o.log(`[qso] ${call ?? "contact"} skipped by operator — cooling down`);
    this.broadcastState();
  }

  rearm(): void {
    this.o.guards.rearm();
    this.broadcastState();
  }

  /**
   * A receive window just finished (with or without decodes). If the next window
   * is ours and the sequencer wants to say something, transmit it.
   */
  private afterWindow(windowStartMs: number): void {
    // Both `decodes` and `window` can fire for the same window; act once.
    if (this.seenWindows.has(windowStartMs)) return;
    this.seenWindows.add(windowStartMs);
    if (this.seenWindows.size > 16) {
      for (const w of [...this.seenWindows].sort((a, b) => a - b).slice(0, 8)) {
        this.seenWindows.delete(w);
      }
    }

    const seq = this.seq;
    if (!seq || this.txParity === null) return;

    const period = this.o.source.periodMs;
    const next = windowStartMs + period;
    if (Math.floor(next / period) % 2 !== this.txParity) return;

    this.runTick(next);
  }

  /**
   * The next window of OUR parity that there is still time to key.
   *
   * Exists because `startCall` used to set up a sequencer and return, leaving the first
   * transmission to whenever the next window event happened to fire — and on the automatic
   * path that is always too late. The decision to call is made inside the `decodes`
   * handler, which fires roughly a decode-time (2 s here) after the `window` event that
   * drives `afterWindow`. So the window we should have answered in had already been
   * skipped for want of a sequencer, and the one after it is THEIR parity, so the first
   * message went out two periods late — one whole missed transmit opportunity, which is
   * exactly what an operator sees as "waiting an extra cycle before transmitting".
   *
   * Returns null when there is no usable window soon, which leaves the old behaviour
   * (wait for the next window event) rather than keying at a moment already gone. With
   * FT2, whose late tolerance is zero, that is a real outcome; for FT8 and FT4 the window
   * two periods out always qualifies, and the cost of reaching it is the 30-second wait
   * this function exists to avoid.
   */
  private firstTxWindow(): number | null {
    if (this.txParity === null) return null;
    const period = this.o.source.periodMs;
    const { mode } = this.o.getBandMode();
    const now = this.now();
    const late = lateTxToleranceMs(mode as TxMode);
    // Start at the window we are CURRENTLY IN, not the next one. That window is the whole
    // point: it is the one immediately after the station we are answering, and we are
    // inside it by a decode time rather than ahead of it.
    const current = Math.floor(now / period) * period;
    for (let i = 0; i < 4; i++) {
      const w = current + i * period;
      if (Math.floor(w / period) % 2 !== this.txParity) continue;
      const lead = transmitStartAt(mode as TxMode, w) - now;
      // ONE TEST, ON THE INSTANT THE AUDIO WILL ACTUALLY START.
      //
      // The old pair of tests — "at least 400 ms in hand" or "late, but inside the
      // tolerance" — left everything between 0 and 400 ms answering to neither, and the
      // automatic path lands there routinely. See KEY_PREP_MS.
      //
      // What the window is really being asked is how late the RF will be, and that is
      // `KEY_PREP_MS - lead`: with a full lead the transmitter waits and keys on time, and
      // with less than a full lead it keys as soon as the waveform is built and the
      // command has crossed the network. Both branches of the old rule are special cases
      // of this one, and the gap between them closes.
      const lateBy = Math.max(0, KEY_PREP_MS - lead);
      if (lateBy <= late) return w;
    }
    return null;
  }

  /** Advance the sequencer for `next` and send whatever it produces. */
  private runTick(next: number): void {
    const seq = this.seq;
    if (!seq || this.txParity === null) return;
    // One tick per transmit window, whichever path got here first.
    if (this.lastTickWindow === next) return;
    this.lastTickWindow = next;

    const tick = seq.tick(next);

    // Recorded before the log is written, not with the transmit result.
    //
    // The courtesy 73 goes out in the SAME tick that completes the QSO, so a transcript
    // assembled after the transmit resolves would be missing the last message of every
    // contact. The trade is that this one line is recorded as intended rather than as
    // confirmed: if the radio then refuses it, the refusal reaches the console and the
    // `qso-tx` event but not a transcript that has already been stored. Every earlier
    // message is amended in place below, because the log write comes later than they do.
    const pendingTx = tick.send
      ? this.record({ at: next, dir: "tx", message: tick.send, offsetHz: this.txOffsetHz })
      : null;

    if (tick.log) {
      const { band, mode, dialHz } = this.o.getBandMode();
      const freqHz = dialHz !== null ? dialHz + this.txOffsetHz : null;
      this.o.guards.qsoCompleted(tick.log.theirCall);
      this.o.onOutcome?.("made");
      this.o.log(`[qso] COMPLETE with ${tick.log.theirCall} — logging`);
      const transcript = formatTranscript(this.transcript);
      void this.o
        .onLog(tick.log, {
          band,
          mode,
          freqHz,
          ...this.activity,
          transcript,
          radio: this.o.radio(),
          // Read once, here, before the tracker is reset by the next contact.
          txPowerW: this.o.txPower?.watts() ?? null,
        })
        .catch((err) => this.o.log(`[qso] LOG FAILED: ${(err as Error).message}`));
      this.o.broadcast({ kind: "qso-logged", log: tick.log });
    }
    if (tick.abandonReason) {
      this.o.guards.recordFailure(seq.theirCall, Date.now());
      this.o.onOutcome?.("lost");
      this.o.log(`[qso] abandoned ${seq.theirCall}: ${tick.abandonReason}`);
      // Reports went both ways, so keep it. The far station heard our roger and logged the
      // contact; discarding this is how thirteen QRZ card requests ended up with no
      // corresponding QSO on this side, traceable only through a decode row with a null qsoId.
      if (tick.abandoned && this.o.onIncomplete) {
        const { band, mode, dialHz } = this.o.getBandMode();
        const freqHz = dialHz !== null ? dialHz + this.txOffsetHz : null;
        this.o.log(
          `[qso] keeping the incomplete exchange with ${tick.abandoned.theirCall} ` +
            `(sent ${tick.abandoned.reportSent}, got ${tick.abandoned.reportRcvd})`,
        );
        void this.o
          .onIncomplete(tick.abandoned, {
            band,
            mode,
            freqHz,
            ...this.activity,
            transcript: formatTranscript(this.transcript),
            radio: this.o.radio(),
            txPowerW: this.o.txPower?.watts() ?? null,
          })
          .catch((err) =>
            this.o.log(`[qso] could not keep the incomplete exchange: ${(err as Error).message}`),
          );
      }
    }

    if (tick.send) {
      const gate = this.o.guards.beforeTx();
      if (!gate.allowed) {
        this.o.log(`[qso] TX blocked: ${gate.reason}`);
        if (pendingTx) pendingTx.refused = gate.reason ?? "blocked by an operating guard";
        this.broadcastState();
        return;
      }
      const { mode } = this.o.getBandMode();
      this.lastSent = tick.send;
      // SET BEFORE THE CALL, not inside the promise. See `transmitPending`: the decode
      // pipeline reads this the instant its priority emit returns, which is inside this
      // very call stack, so a flag set from a `.then` would still read false and the
      // full-band pass would block the loop straight over the transmission it had just
      // scheduled.
      this.txPending = true;
      // Fire and forget: transmit() occupies the whole window and afterWindow
      // runs on the decode path, which must not stall.
      void this.o.tx
        .transmit({
          message: tick.send,
          mode,
          offsetHz: this.txOffsetHz,
          startAt: next,
        })
        .then((r) => {
          if (!r.sent && pendingTx) {
            pendingTx.refused = r.reason ?? "the radio would not transmit";
          }
          if (!r.sent) this.o.log(`[qso] TX refused: ${r.reason}`);
          else
            this.o.log(
              `[qso] sent "${r.message}" (timing ${r.timingErrorMs}ms, ${r.packetsSent} pkts)`,
            );
          this.o.broadcast({ kind: "qso-tx", message: tick.send, sent: r.sent, reason: r.reason });
        })
        .catch((err) => this.o.log(`[qso] TX error: ${(err as Error).message}`))
        // Cleared however it ended — sent, refused or thrown. A flag left set by a
        // failed transmission would hold a deferred full-band pass until its deadline
        // and delay the decode list for a transmission that never happened.
        .finally(() => {
          this.txPending = false;
        });
    }

    if (seq.isDone && this.seq === seq) {
      // Leave the record visible in state until the next call replaces it.
      this.txParity = null;
    this.lastTickWindow = null;
    }
    this.broadcastState();
  }

  /**
   * Hand one decode to the sequencer, at most once per `(window, message)`.
   *
   * See `fedToSeq` for why "at most once" is load-bearing rather than tidy.
   *
   * Bounded the same way `seenWindows` is, and for the same reason: this runs for every
   * decode of every window for as long as the bridge is up, and an unbounded Set on that
   * path is a leak. Sixteen windows is four minutes of FT8 — far longer than the two
   * events for one window are ever apart, which is one decode time.
   */
  private feedSequencer(message: string, at: number): void {
    const seq = this.seq;
    if (!seq || seq.isDone) return;
    const key = `${at}|${message}`;
    if (this.fedToSeq.has(key)) return;
    this.fedToSeq.add(key);
    if (this.fedToSeq.size > 64) {
      for (const k of [...this.fedToSeq].slice(0, 32)) this.fedToSeq.delete(k);
    }
    seq.onDecode(message, at);
  }

  /** Append to the exchange, and hand the entry back so it can be amended later. */
  private record(entry: TranscriptEntry): TranscriptEntry {
    this.transcript.push(entry);
    return entry;
  }

  /**
   * Record a decode that belongs to the contact in progress.
   *
   * Only messages between the two of us: their reply to us, and their CQ or their call
   * to somebody else while we are working them — a busy band produces thirty decodes a
   * window and none of the other twenty-nine are part of this contact.
   *
   * A finished sequencer stops recording. The contact is logged by then, and anything
   * after it belongs to whatever happens next.
   */
  private recordRx(
    d: { message: string; snr: number; freqOffset: number },
    at: number,
  ): void {
    const seq = this.seq;
    if (!seq || seq.isDone) return;
    if (senderOf(d.message) !== seq.theirCall) return;
    // The message that opened the transcript arrives as a decode too when the call was
    // started from the window it decoded in. Recording it twice would read as the station
    // having repeated itself, which is a thing that happens and would then be
    // indistinguishable from this.
    //
    // Checked against the WHOLE transcript rather than only its last entry. The last-entry
    // form assumed the duplicate arrives immediately after the original, and since 1.135.0
    // it need not: the first transmission is now scheduled inside `startCall`, so a TX line
    // can be written between the opening message and the decode that repeats it, and the
    // guard looked at the TX and let the duplicate through.
    //
    // MEASURED: 400 live transcripts on this station contain no duplicated line, so that
    // ordering does not arise on the production path — it was found by `check:operating`,
    // which does reach it. Widened anyway, because the narrow form was relying on an
    // ordering it never stated.
    //
    // A station genuinely repeating itself is unaffected: that repeat is in a later window
    // and so carries a different `at`.
    if (this.transcript.some((e) => e.dir === "rx" && e.at === at && e.message === d.message)) {
      return;
    }
    this.record({
      at,
      dir: "rx",
      message: d.message,
      snr: d.snr,
      offsetHz: d.freqOffset,
    });
    // Their reply is half the exchange, and until the transcript reached the UI nothing
    // needed redrawing when one arrived. It does now.
    this.broadcastState();
  }

  private broadcastState(): void {
    this.o.broadcast({ kind: "qso", qso: this.state });
  }
}

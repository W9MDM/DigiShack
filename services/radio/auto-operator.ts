import type { FlexDaxSource } from "@/lib/flex/dax";
import type { DigitalSource, DigitalTransmitter } from "@/lib/radio/types";
import type { DigitalMode } from "@/lib/ham/digital-freqs";
import type { FlexDaxTransmitter } from "@/lib/flex/tx";
import type { OperatingGuards } from "@/lib/digital/qso";
import { parseMessage, standardMessages, type MayCallChecks } from "@/lib/digital/qso";
import { callableFrom } from "@/lib/digital/callable";
import { rankCandidates, type Candidate, type WorkedIndex } from "@/lib/digital/worth";
import { cqIsForUs } from "@/lib/digital/cq-modifier";
import type { QsoController } from "./qso-controller";
import {
  bandHasNobodyToCall,
  bandIsUnproductive,
  pickBandForSwr,
  pickBusiestBand,
  shouldHopForBetterBand,
  shouldReturnToPreviousBand,
  type BandActivity,
} from "@/lib/radio/band-hop";

// The automated operating modes, layered over the QSO controller:
//
//   cq         call CQ on our cycle; work whoever answers; repeat
//   hunt       watch the decodes for callable CQs and work them, one at a time
//   hunt-pota  hunt, but only stations calling "CQ POTA"
//
// (Auto Call — working one chosen station through a full QSO — is the
// click-to-call flow itself, so it needs no mode here. The POTA spot-feed
// variant that retunes to activators is on the roadmap; this hunts the POTA
// CQs already audible on frequency.)
//
// Every transmission still goes through the operating guards: dupe suppression,
// attempt limits and cooldowns, the runaway brake, the deaf guard and the
// dead-band stop. When a guard pauses operation and band-hopping is enabled,
// the operator moves to the next band on the list, listens for two cycles, and
// either resumes or hops again.

// Defined in lib/radio/auto-mode.ts so the schedule and settings can share it.
// Imported for local use AND re-exported, because `export ... from` alone does not
// bring the name into this module's scope — the file uses AutoMode in three places.
import type { AutoMode } from "@/lib/radio/auto-mode";

export type { AutoMode };

export interface AutoState {
  mode: AutoMode;
  cqParity: 0 | 1 | null;
  cqOffsetHz: number | null;
  /** Windows to listen before transmitting (fresh enable or fresh band). */
  warmup: number;
  pausedReason: string | null;
  lastAction: string | null;
  /**
   * Callsigns that called us mid-QSO and are waiting to be called back.
   *
   * Oldest first, i.e. the order they will be worked in.
   */
  waiting: string[];
}

export interface PotaChasePrefs {
  /**
   * Bands chase mode may retune to.
   *
   * `null` means "the band chase started on, and only that one" — the default,
   * because it is the one that keeps the radio somewhere it can hear. An empty
   * array means any band.
   */
  bands: string[] | null;
  giveUpMs: number;
  retryMs: number;
  workAudible: boolean;
  preferNew: boolean;
  returnToCalling: boolean;
}

export interface AutoOperatorOptions {
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
  controller: QsoController;
  identity: { myCall: string; myGrid: string };
  getBandMode: () => { band: string | null; mode: DigitalMode; dialHz: number | null };
  wasWorked: (call: string, band: string, mode: string, sinceMs: number) => Promise<boolean>;
  /**
   * The do-not-call list and the band-slot check, resolved fresh at each call attempt.
   *
   * A function rather than a value because both are backed by the database and the list
   * can be edited while the station is operating — capturing it once at construction would
   * mean an operator adding somebody to the list watched the station call them anyway
   * until the next restart, which is the whole failure this feature exists to prevent.
   */
  callChecks: () => MayCallChecks;
  /** Retune the radio to a band's calling frequency. */
  retune: (band: string, mode: DigitalMode) => Promise<boolean>;
  bandHop: () => Promise<{
    enabled: boolean;
    bands: string[];
    toBusiest: boolean;
    /** Leave a working band when another is this many times busier. <=1 is off. */
    whenBetterRatio: number;
  }>;
  /**
   * Stations per band the PSKReporter network currently sees, for hop-to-busiest.
   *
   * Injected rather than imported so this file stays testable without a network, and
   * returns null when the feed is unavailable — the caller falls back to rotating.
   */
  bandActivity?: () => Promise<BandActivity[] | null>;
  /** Receive noise floor in dBm, or null when not measured. */
  noiseDbm?: () => number | null;
  /** What has been worked, for award-aware ranking. Refreshed periodically. */
  workedIndex: (band: string | null) => Promise<WorkedIndex>;
  /** Resolve a callsign to its DXCC entity, or null when no data is loaded. */
  resolveEntity: (
    call: string,
  ) => Promise<{ adif: number; name: string; cqZone: number | null; continent: string | null } | null>;
  /**
   * How long to listen before judging a band, ms. Defaults to `WARMUP_MS`.
   *
   * Injectable because it is a POLICY value, not a constant of the protocol, and because
   * an integration fixture should not silently depend on its exact size. When it changed
   * from two windows to ninety seconds, every scenario built around "the window after the
   * second warm-up window" broke at once - which is a test coupled to a number rather than
   * to the behaviour it means to check.
   */
  warmupMs?: number;
  /** Hunt preferences from settings. */
  huntPrefs: () => Promise<{ newOnly: boolean; minSnr: number; callFinished?: boolean }>;
  /** Current POTA activators on the digital modes. */
  potaSpots: () => Promise<
    { activator: string; freqHz: number; band: string | null; mode: string; reference: string; parkName: string | null }[]
  >;
  /** Move the radio to an exact frequency (POTA activators are off the calling frequency). */
  tuneHz: (hz: number) => Promise<boolean>;
  /** POTA chase preferences from settings. */
  potaPrefs: () => Promise<PotaChasePrefs>;
  broadcast: (event: unknown) => void;
  log: (line: string) => void;
}

/**
 * One ranked, callable CQ from a decoded window — everything `startCall` asks for.
 *
 * Deliberately the WHOLE record and not just the offset. The offset is what the decode
 * pipeline needs, but the fast path in `onPriorityDecodes` also has to start the contact,
 * and re-deriving the grid, the park and the SIG from a second decode a second later is
 * how two paths end up disagreeing about what a contact was for.
 */
interface HuntCandidate {
  call: string;
  grid: string | null;
  /** Why `rankCandidates` put them where it did, for the status line. */
  reasons: string[];
  snr: number;
  freqOffset: number;
  sig: string | null;
  sigInfo: string | null;
  message: string;
}

/**
 * What a hunted window OFFERED, as opposed to what it produced.
 *
 * Returned by `huntWindow` rather than accumulated inside it, and that is deliberate:
 * `huntPotaAudible` borrows `huntWindow` from chase mode, and a chase window that finds
 * no audible "CQ POTA" is the normal condition of chase mode rather than evidence about
 * the band. The caller decides whether the answer counts; the chase path drops it.
 */
interface HuntOutcome {
  /** At least one station here cleared `mayCall`. Breaks the streak. */
  callable: boolean;
  /**
   * Distinct callsigns that called CQ in this window, BEFORE `newOnly` and the SNR
   * floor took their cut.
   *
   * From the memo `rankWindow` already writes, so this is the same parse and the same
   * list — there is no second notion of who was heard.
   */
  cqs: readonly string[];
  /** Ranked candidates the guards refused: dupe, cooldown, do-not-call. */
  refused: number;
}

/**
 * How long a callsign's DXCC entity is remembered, ms.
 *
 * Half an hour, because the thing being cached does not change on a shorter timescale
 * than an administrator loading a new cty.xml. See `entityCache`.
 */
const ENTITY_CACHE_MS = 30 * 60_000;

/** Callsigns remembered at once. A busy evening on 20 m is a few hundred. */
const ENTITY_CACHE_MAX = 2_000;

/**
 * Listen at least this long after enabling a mode or changing band, ms.
 *
 * WAS TWO WINDOWS, AND TWO WINDOWS IS NOT A HEARING. Observed live on 2026-08-31 in FT4,
 * where two windows is FIFTEEN SECONDS:
 *
 *     19:15:51  band too quiet (0 decodes) - hopping on   -> 20M
 *     19:16:06  band too quiet (0 decodes) - hopping on   -> 40M
 *     19:16:21  band too quiet (0 decodes) - hopping on   -> 20M
 *     19:16:36  band too quiet (0 decodes) - hopping on   -> 40M
 *
 * It ran until the audio watchdog restarted the bridge. The loop is self-sustaining: the
 * station hops, judges the new band on almost no listening, hops again, and so never stays
 * anywhere long enough to hear the thing that would let it stay. Zero decodes was not
 * evidence the band was dead - it was evidence we had just arrived.
 *
 * Of those two windows, ONE is spent on the retune itself: the radio moves mid-window and
 * the DAX stream is rebuilt behind it ("DAX stream rebuilt" appears in that same log). So
 * the band was being asked for HOP_MIN_DECODES in roughly one usable window.
 *
 * A DURATION, NOT A WINDOW COUNT, because a band's activity is a property of propagation
 * and not of our T/R period. Two windows means 30 s in FT8, 15 s in FT4 and 7.5 s in FT2 -
 * the same rule getting four times stricter as the mode gets faster, which is exactly
 * backwards from what those modes need. Ninety seconds is the same hearing in every mode:
 * enough for the retune to settle, for both transmit parities to come round, and for a
 * genuinely quiet band to prove it.
 */
const WARMUP_MS = 90_000;

/** Never fewer than this, however long a period gets. */
const WARMUP_MIN_WINDOWS = 2;

/**
 * Consecutive quiet hops before the rotation stops and the station stays put.
 *
 * The backstop to the loop above. If the warmup is ever misconfigured again, or a receiver
 * is genuinely deaf on every band in the list, thrashing between them decodes nothing and
 * eventually trips the audio watchdog. Staying on one band decodes nothing either - but it
 * stops moving the radio, keeps the audio stream up, and leaves a station that can recover
 * the moment anything is heard.
 */
const MAX_QUIET_HOPS = 4;

/** Fewer decodes than this after a hop means the band is no better — move on. */
const HOP_MIN_DECODES = 3;

/**
 * How long a tail-ender is still worth calling back.
 *
 * Ten minutes is roughly forty FT8 cycles. Someone who called during a contact will
 * wait through the one they interrupted, but not through five more — past this they
 * have worked somebody else or moved band, and calling into empty air costs a full
 * give-up period of transmissions nobody answers.
 */
const CALLBACK_TTL_MS = 10 * 60_000;

/**
 * Most stations to hold.
 *
 * A pileup on a rare station is the case that would otherwise grow without bound.
 * Oldest are worked first, so this drops the newest arrival — the one likeliest to
 * still be calling by the time we get through the rest.
 */
const MAX_CALLBACKS = 8;

/**
 * How often to ask whether another band has overtaken this one.
 *
 * Five minutes, and the asymmetry is the reason: a needless hop throws away a
 * working band and spends two warm-up cycles finding out, while arriving five
 * minutes late to a better one costs almost nothing. It also keeps the question
 * well inside the PSKReporter fetcher own cache interval, so asking is free.
 */
const BETTER_BAND_CHECK_MS = 5 * 60_000;

/**
 * How much of the old band's decode rate a new band must deliver to be worth staying.
 *
 * Well below 1 on purpose: bands are not expected to match, only to not be markedly
 * worse. At parity the radio would bounce straight back from a band that was slightly
 * quieter but full of stations it had never worked.
 */
const KEEP_BAND_FRACTION = 0.6;

/** Windows on a band before its decode rate means anything. */
const RATE_MIN_WINDOWS = 4;

/** How long a band stays marked deaf here before it is worth trying again. */
const POOR_BAND_MS = 30 * 60_000;

/** How often to ask whether the band we are on is still worth sitting on. */
const PRODUCTIVITY_CHECK_MS = 10 * 60_000;

/** Windows before a band can be judged to have fallen away under us. */
const UNPRODUCTIVE_MIN_WINDOWS = 40;

/** Second half of a stay below this fraction of the first means it has gone. */
const UNPRODUCTIVE_DECAY = 0.4;

/**
 * Contact attempts before a success rate means anything, and the bar it must clear.
 *
 * Measured from this station across ~750 attempts: contacts complete 66% of the time
 * at 0..-5 dB, 67% at -6..-10, 51% at -11..-15 and 48% at -16..-20. So half is
 * NORMAL, and a band has to be well under it — a third — before that is evidence of
 * anything but ordinary luck.
 */
const UNPRODUCTIVE_MIN_ATTEMPTS = 8;
const UNPRODUCTIVE_MIN_SUCCESS = 0.34;

/**
 * Consecutive listening windows with NOBODY WORTH CALLING before the band is left.
 *
 * THE FAULT this closes, observed live on 30 Aug at 09:08: settled on 17 m at 09:03
 * with 3 decodes in the window and 17 in the rolling buffer, and 0 calls, 0 contacts
 * and 0 abandoned since arriving. "Band too quiet" wants literally 0 decodes and 3 is
 * not 0. "Not paying" wants UNPRODUCTIVE_MIN_ATTEMPTS attempts before a ratio means
 * anything, and the attempt count was 0 and could not grow. A band with a trickle and
 * nobody to work satisfies neither, so the station sits on it indefinitely. See
 * `bandHasNobodyToCall`.
 *
 * WHY 20 AND NOT 40. UNPRODUCTIVE_MIN_WINDOWS is 40 because the tests it gates are
 * INFERENCES from a decode rate — comparing one half of a stay against the other
 * needs a long enough baseline that a lull is not read as a fade. This is not an
 * inference, it is a COUNT: twenty consecutive windows in which the hunt's own
 * ranking and its own `mayCall` produced not one station to call. Ten of those
 * windows were each parity, so a station that only ever calls CQ on one of them had
 * ten chances to be heard. There is nothing further to learn by waiting.
 *
 * WHY IT HAS NO WALL-CLOCK TIMER, unlike PRODUCTIVITY_CHECK_MS. That timer exists so
 * a rate test is not re-asked of the same means every 15 seconds. This evidence
 * accumulates one window at a time and is complete the moment the streak reaches the
 * bar, so it is simply checked every window and fires once. At 15 s that is five
 * minutes, which is exactly how long the observed 17 m stay had produced nothing when
 * it was caught by eye.
 *
 * WINDOWS AND NOT MINUTES so it scales: 5 minutes on FT8, 2.5 on FT4, 75 s on FT2.
 * The unit of evidence is a window — one complete transmission from everyone on
 * frequency — and a faster mode genuinely does deliver its evidence faster.
 */
const NOBODY_TO_CALL_WINDOWS = 20;

/**
 * Callsigns remembered per streak, for the log line's "N stations called CQ here".
 *
 * Bounded because a streak has no upper length: once every band on the hop list has
 * been tried and marked poor there is nowhere to go, the hop declines, and the streak
 * keeps counting until something changes.
 */
const NOBODY_CQ_TALLY_MAX = 500;

/** Someone who called us while the transmitter was busy with another contact. */
interface PendingCallback {
  call: string;
  grid: string | null;
  snr: number;
  offsetHz: number;
  /** The window they called us in — fixes which parity is theirs. */
  windowStart: number;
  /** Verbatim, so the contact's transcript opens with what they said. */
  message: string;
  /** When they last called, for expiry. */
  at: number;
}

export class AutoOperator {
  private readonly o: AutoOperatorOptions;
  private mode: AutoMode = "off";
  private cqParity: 0 | 1 | null = null;
  private cqOffsetHz: number | null = null;
  private warmup = 0;
  /**
   * Bands hopped through in a row that heard nothing. Reset by any band that settles.
   *
   * See MAX_QUIET_HOPS. This exists so a receiver problem reads as a receiver problem
   * rather than as a radio that will not stop retuning itself.
   */
  private quietHops = 0;
  /** Callsigns whose directed CQ we have already declined, so the log says it once. */
  private readonly skippedCqs = new Set<string>();

  /**
   * Is anybody waiting for us to call them back?
   *
   * Checked by every path that would move the radio. Pruned first, so a queue full of
   * stations who gave up ten minutes ago does not pin the station to a dead band.
   */
  private hasWaitingCallers(): boolean {
    this.pruneCallbacks();
    return this.callbacks.length > 0;
  }

  /**
   * `WARMUP_MS` expressed in windows of the mode currently running.
   *
   * Read fresh each time rather than cached: the period changes with the mode, and a
   * warmup counted in FT8 windows would be four times too short if the operator switched
   * to FT2 while it was running.
   */
  private warmupWindows(): number {
    const period = this.o.source.periodMs;
    const target = this.o.warmupMs ?? WARMUP_MS;
    if (!Number.isFinite(period) || period <= 0) return WARMUP_MIN_WINDOWS;
    return Math.max(WARMUP_MIN_WINDOWS, Math.ceil(target / period));
  }
  private lastAction: string | null = null;
  private cqedLastWindow = false;
  private seenWindows = new Set<number>();
  /** Offsets heard recently, for picking a clear CQ frequency. */
  private recentOffsets: number[] = [];
  /**
   * Where we are in the hop list. Starts BEFORE the first entry, not at it.
   *
   * `hopNext` increments before reading, so starting at 0 meant the first hop went to
   * the second band on the list and the operator's first choice was skipped — every
   * subsequent hop reached it, so this was invisible except on the one hop most likely
   * to be watched. Starting at -1 makes the first hop the first band, and the
   * skip-the-current-band loop still moves past it when we are already there.
   */
  private hopIndex = -1;
  private hopDecodeCount = 0;
  /** When we last asked whether another band had overtaken this one. */
  private lastBetterCheck = 0;
  /**
   * SWR last measured while transmitting on each band.
   *
   * How the station learns its own antenna: a band that tripped the SWR guard is
   * remembered so it is not chosen again, and a band that loaded flat is preferred
   * over one never tried.
   */
  private bandSwr = new Map<string, number>();
  /** Decodes per cycle this receiver measured on each band. */
  private bandRate = new Map<string, number>();
  /** Windows spent on the current band, and decodes heard in them. */
  private windowsOnBand = 0;
  private decodesOnBand = 0;
  /**
   * Where to go back to if the band just moved to turns out to be deaf here.
   *
   * Set only by a move made on NETWORK figures, which are the ones that can be wrong
   * about this antenna. Carries the rate the old band was actually giving us, since
   * that is the thing the new band has to beat.
   */
  private returnIfWorse: { band: string; rate: number } | null = null;
  /**
   * Bands this receiver has proved deaf on, and when to reconsider them.
   *
   * Without this the network figures would send the radio straight back to the band
   * it just fled, every five minutes, for as long as the numbers looked good.
   */
  private poorBands = new Map<string, number>();
  /** Per-window decode counts for this stay, so a band can be judged against itself. */
  private windowDecodes: number[] = [];
  /** Contacts made and lost on this band since arriving. */
  private madeOnBand = 0;
  private lostOnBand = 0;
  /** Noise floor measured on each band, for a relative idea of "noisy". */
  private bandNoise = new Map<string, number>();
  private lastProductivityCheck = 0;
  /**
   * The "nobody to call" streak: consecutive hunted windows here that offered nobody.
   *
   * Only windows that actually reached the hunt count. Warm-up, a paused guard and a
   * contact in progress all return from `onWindow` before the hunt runs, so a live QSO
   * suppresses this exactly as it suppresses the other two band checks — and it must,
   * since a window spent working somebody is the strongest possible evidence AGAINST
   * the conclusion this draws.
   */
  private nobodyWindows = 0;
  /** Distinct callsigns heard calling CQ during the streak, for the log line. */
  private nobodyCqs = new Set<string>();
  /** Guard refusals during the streak — see BandOffering.refused. */
  private nobodyRefused = 0;
  private hopping = false;
  /** POTA chase: who we retuned for, and when to give up on them. */
  private chasing: { activator: string; since: number; reference: string } | null = null;
  private chaseTried = new Map<string, number>();
  private lastSpotCheck = 0;
  /**
   * The last spot list, held for the poll interval.
   *
   * Separating "how often to ask POTA" from "how often to decide" is what makes
   * giving up on an activator responsive. Gating the decision on the network poll
   * meant that after abandoning a dead frequency the radio stayed on it for up to
   * another minute — and, worse, could not take the way home either, because the
   * return path was behind the same gate.
   */
  private spotCache: Awaited<ReturnType<AutoOperatorOptions["potaSpots"]>> | null = null;
  /**
   * The band and mode chase mode started on, and the frequency we last retuned away
   * to.
   *
   * Both exist so the radio can find its way back. Chasing moves the dial — sometimes
   * to another band — and once the chase ends there is nothing else that knows where
   * "here" was. Without this the radio stays parked on the last activator's frequency,
   * hears nothing, and cannot fall back to ordinary hunting: observed live, sitting on
   * 18.100 MHz for an Argentine park while 20 m was producing 650 decodes an hour.
   */
  private chaseHome: { band: string; mode: DigitalMode } | null = null;
  private chaseParkedHz: number | null = null;
  /**
   * Stations that called us while we were already working someone.
   *
   * A tail-ender used to be dropped outright: the auto operator hands the
   * transmitter to the QSO controller for the duration of a contact and returned
   * before ever looking at the decodes, so somebody calling into the gap was heard,
   * ignored, and never called back. On a busy band that is the single most common
   * way to lose a contact that was offered to you.
   *
   * Oldest first — whoever asked first gets worked first.
   */
  private callbacks: PendingCallback[] = [];
  /**
   * The ranked candidates from the last window we listened to, and which window it was.
   *
   * ONE WINDOW, NOT A ROLLING SET, and the window it came from is half the value. A
   * station calling CQ transmits on one parity and listens on the other, so this list
   * only predicts the NEXT window of the SAME parity — two periods later. Applied to the
   * window in between it would search for stations that are receiving.
   *
   * An empty `list` is a real answer meaning "we listened on that parity and nobody was
   * calling CQ", which is why `rankWindow` writes one rather than leaving the field
   * alone. Without it a quiet window would silently reuse a list from a minute earlier.
   */
  private candidates: {
    at: number;
    heardCq: boolean;
    list: HuntCandidate[];
    /**
     * Everyone CALLABLE in that window, ranked or not.
     *
     * Named `cqCalls` still, because `scripts/check-band-hop.ts` reads these semantics and
     * renaming the field is a larger change than the honesty it buys. With
     * `auto.callFinishedStations` on it also holds stations admitted on a closing token, so
     * read it as "callable", not "called CQ".
     *
     * `list` is post-filter: with `huntNewOnly` on, or a station under the SNR floor, a
     * window where twenty stations called can rank to nothing. The streak's log line has
     * to be able to say which of those two happened, and re-parsing the decodes to find
     * out would be a second answer to a question already answered here.
     */
    cqCalls: string[];
  } | null = null;
  /** The window a candidate call has already been attempted for. One attempt per window. */
  private lastCandidateWindow: number | null = null;
  /** See `callPending`. */
  private startingCall = false;

  constructor(opts: AutoOperatorOptions) {
    this.o = opts;
    opts.source.on("decodes", ({ windowStart, decodes }) => {
      void this.onWindow(
        windowStart.getTime(),
        decodes.map((d) => ({ message: d.message, snr: d.snr, freqOffset: d.freqOffset })),
        false,
      );
    });
    opts.source.on("window", ({ windowStart, skipped, rms }) => {
      if (skipped) void this.onWindow(windowStart.getTime(), [], rms < 1e-5);
    });
  }

  get state(): AutoState {
    return {
      mode: this.mode,
      cqParity: this.cqParity,
      cqOffsetHz: this.cqOffsetHz,
      warmup: this.warmup,
      pausedReason: this.o.guards.pausedReason,
      lastAction: this.lastAction,
      waiting: this.callbacks.map((c) => c.call),
    };
  }

  /**
   * Put a station the OPERATOR named at the FRONT of the callback queue.
   *
   * Pressing Call on a decode while an automatic mode was running did nothing an
   * operator could see. The controller refuses a second QSO — correctly, it owns the
   * transmitter — and the refusal went into a panel that was busy rendering the QSO
   * already in progress. So the button looked broken, and the only way to work someone
   * the radio had not chosen was to halt everything and lose the contact in flight.
   *
   * The queue this joins already existed for stations that call US mid-QSO. An operator
   * naming a station is the same situation with a better reason, so it goes to the FRONT
   * rather than the back: the machine picked the others, a person picked this one.
   *
   * Returns how many are ahead of it — 0 means next.
   */
  queueOperatorCall(entry: Omit<PendingCallback, "at">): { position: number; moved: boolean } {
    // Already queued: move it to the front rather than adding a duplicate, so pressing
    // Call twice promotes rather than queueing the same station behind itself.
    const existing = this.callbacks.findIndex((c) => c.call === entry.call);
    const moved = existing >= 0;
    if (moved) this.callbacks.splice(existing, 1);

    this.callbacks.unshift({ ...entry, at: Date.now() });
    // The cap still applies, but it drops from the BACK now — the entries the operator
    // did not ask for are the ones to lose.
    if (this.callbacks.length > MAX_CALLBACKS) this.callbacks.length = MAX_CALLBACKS;

    this.lastAction = `${entry.call} queued by the operator — calling them next`;
    this.o.log(`[auto] ${this.lastAction}`);
    this.broadcastState();
    return { position: 0, moved };
  }

  setMode(mode: AutoMode): void {
    this.mode = mode;
    this.warmup = mode === "off" ? 0 : this.warmupWindows();
    this.cqParity = null; // chosen at the first CQ, from the clock
    this.cqOffsetHz = null;
    this.cqedLastWindow = false;
    this.hopping = false;
    // The band-comparison timer starts NOW, so a fresh mode listens for its first
    // interval before it will move on somebody else's figures.
    this.lastBetterCheck = Date.now();
    this.windowsOnBand = 0;
    this.decodesOnBand = 0;
    this.resetNobodyStreak();
    this.returnIfWorse = null;
    // Anyone waiting was waiting for the operating this mode change just ended.
    // Carrying them across a switch to Off — or to another band via chase — would
    // call someone back minutes later from somewhere they never heard us.
    this.callbacks = [];
    // Same argument, and the band case is the sharper one: a candidate list is a claim
    // about who is transmitting on this band at this parity, and after a hop every part
    // of that is wrong. Warm-up would suppress it anyway; clearing it says why.
    this.candidates = null;
    this.lastCandidateWindow = null;

    // Where chase mode should come back to. Captured here rather than derived later
    // because by the time the chase ends the dial has moved, possibly to another
    // band, and nothing else remembers where the operator left it.
    if (mode === "pota-chase") {
      const { band, mode: dMode } = this.o.getBandMode();
      this.chaseHome = band ? { band, mode: dMode } : null;
      this.chasing = null;
      this.chaseParkedHz = null;
      this.lastSpotCheck = 0; // poll on the first window, not 60 s in
      this.spotCache = null;
    } else {
      this.chaseHome = null;
    }

    if (mode !== "off") this.o.guards.rearm();
    this.lastAction = mode === "off" ? "stopped" : `enabled ${mode}`;
    this.o.log(`[auto] mode = ${mode}`);
    this.broadcastState();
  }

  /**
   * Where the stations we would most likely call are transmitting, best first.
   *
   * ASKED BY THE DECODE PIPELINE, at the instant it cuts `windowStartMs` and before it
   * has decoded a single sample of it. That is the whole point: the first transmission of
   * a contact is scheduled from a decode, and today it goes out 1.3-1.4 s late because the
   * full 200-3000 Hz search has to finish before anyone knows who to call. A reply does
   * not suffer from this — measured at -1 ms since 1.153.0 — because a reply has a
   * partner offset. This is the same trick with the same mechanism, given an offset for
   * the case where there is no partner yet.
   *
   * EXACTLY THE PREVIOUS WINDOW OF THIS PARITY, and nothing older. Two periods back is
   * the last time we listened while these stations were transmitting; four periods back
   * is a minute ago on FT8, and pointing a slice at where somebody used to be is a miss
   * that costs a slice. When the list is stale, absent, or from the wrong parity this
   * returns nothing and the pipeline searches the band exactly as it always did.
   *
   * EMPTY WHENEVER WE COULD NOT CALL ANYWAY. A contact in progress belongs to the
   * partner slice — the pipeline prefers it regardless, and this agrees so the two can
   * never both be searching. Paused guards, warm-up and the non-hunting modes have no
   * first call to make punctual.
   */
  candidateOffsetsHz(windowStartMs: number): number[] {
    if (!this.candidateReady(windowStartMs)) return [];
    return this.candidates!.list.map((c) => c.freqOffset);
  }

  /**
   * True from the synchronous start of a candidate call until it has been taken or refused.
   *
   * WITHOUT THIS THE CANDIDATE SLICE WOULD BE WORSE THAN USELESS. The pipeline asks
   * `transmitPending` the instant its priority emit returns, and defers the full-band
   * pass only if the answer is yes — because a full pass is synchronous and would hold
   * the event loop straight over the moment it just found the candidate early FOR. The
   * QSO controller can answer honestly there: its path is synchronous down to
   * `tx.transmit`. This one is NOT — `mayCall` reads the do-not-call list and the band
   * slot from the database, and `startCall` reads the dupe index — so by the time the
   * transmitter is taken the pipeline has long since stopped asking.
   *
   * So the flag is set BEFORE the first await and cleared when the attempt settles, and
   * the bridge ORs it with the controller's. There is no gap between the two: `startCall`
   * sets `QsoController.transmitPending` synchronously inside the call this is still
   * covering.
   *
   * WHAT IT COSTS WHEN THE CALL IS REFUSED: the window's full-band decodes wait out those
   * database reads and one 100 ms poll. Bounded, rare, and the deferral has its own
   * one-period deadline underneath it.
   */
  get callPending(): boolean {
    return this.startingCall;
  }

  /**
   * A candidate's slice, decoded ahead of the band. Call them NOW rather than in 1.4 s.
   *
   * NOT WIRED THROUGH `source`, for the same reason `QsoController.onPriorityDecodes` is
   * not: `DigitalSource` names the two events the operating layer needs and widening it
   * to carry an optimisation would undo the point of having narrowed it. The bridge calls
   * this.
   *
   * MUST NOT CONSUME THE WINDOW. `onWindow` dedupes on `windowStartMs` and is what feeds
   * `recentOffsets`, the dead-band counter, the band-hop tally and the callback queue.
   * Treating a slice as the window would hand all of that one station and silently
   * discard the other twenty-nine. So this touches none of it: it looks for one ranked
   * candidate, starts the contact if it is there, and leaves the window itself entirely
   * to the full pass — which will then find the contact already active and step aside.
   *
   * AN EMPTY OR IRRELEVANT SLICE DOES NOTHING AT ALL. No state, no status line, no
   * attempt marked as spent. That is the same rule the partner slice follows and it is
   * what makes a miss cost nothing beyond the decode itself.
   */
  onPriorityDecodes(d: {
    windowStart: Date;
    decodes: { message: string; snr: number; freqOffset: number }[];
  }): void {
    const at = d.windowStart.getTime();
    if (!this.candidateReady(at)) return;
    // One attempt per window, whichever of the (up to three) candidate slices got here
    // first. A second attempt could only be for a lower-ranked station in the same window,
    // and it would race the first one's database reads.
    if (this.lastCandidateWindow === at) return;

    const me = this.o.identity.myCall.toUpperCase();
    for (const c of this.candidates!.list) {
      // THIS window's decode of them, not the remembered one: the offset, the SNR and the
      // message are all facts about the transmission we are actually answering. The
      // remembered record supplies only what this window cannot — the grid, the park and
      // the SIG, which came from the same rank that chose them.
      const heard = d.decodes.find((x) => {
        const p = parseMessage(x.message);
        if (p.kind !== "cq" || p.from !== c.call || p.from === me) return false;
        return this.mode === "hunt-pota"
          ? (p as { modifier: string | null }).modifier === "POTA"
          : true;
      });
      if (!heard) continue;
      const p = parseMessage(heard.message);
      this.lastCandidateWindow = at;
      this.startingCall = true;
      void this.callCandidate(c, heard, p.kind === "cq" ? p.grid : c.grid, at);
      return;
    }
  }

  /** The gates every candidate path shares, so the pipeline and the fast path agree. */
  private candidateReady(windowStartMs: number): boolean {
    if (this.mode !== "hunt" && this.mode !== "hunt-pota") return false;
    if (this.warmup > 0) return false;
    if (this.o.guards.pausedReason) return false;
    // The partner slice owns a live contact, and a second call must never be started
    // under one. `startingCall` closes the window between deciding and the controller
    // knowing about it.
    if (this.o.controller.hasActive || this.startingCall) return false;
    const c = this.candidates;
    if (!c || c.list.length === 0) return false;
    // Same parity, one full cycle back. See `candidates`.
    return windowStartMs - c.at === 2 * this.o.source.periodMs;
  }

  /** Start the contact a candidate slice found. Async, and covered by `callPending`. */
  private async callCandidate(
    c: HuntCandidate,
    heard: { message: string; snr: number; freqOffset: number },
    grid: string | null,
    windowStartMs: number,
  ): Promise<void> {
    try {
      const { band, mode } = this.o.getBandMode();
      // THE SAME GATE THE ORDINARY HUNT USES, including `callChecks()`. `startCall` runs
      // `mayCall` too, but WITHOUT the do-not-call list and the band-slot check — those
      // are the auto operator's to apply, and a fast path that skipped them would call
      // stations the operator has explicitly excluded.
      const may = await this.o.guards.mayCall(
        c.call,
        band ?? "?",
        mode,
        Date.now(),
        this.o.wasWorked,
        this.o.callChecks(),
      );
      // Refused: step aside completely. The window's own `decodes` event is still coming
      // and `huntWindow` will rank it afresh, try the next name down, and say so in the
      // status line. Announcing anything here would overwrite that with a staler answer.
      if (!may.allowed) return;

      const result = await this.o.controller.startCall({
        theirCall: c.call,
        theirGrid: grid,
        theirSnr: heard.snr,
        theirOffsetHz: heard.freqOffset,
        theirWindowStart: windowStartMs,
        sig: c.sig,
        sigInfo: c.sigInfo,
        theirMessage: heard.message,
      });
      if (!result.ok) return;
      const why = c.reasons.length ? ` — ${c.reasons.join(", ")}` : "";
      this.lastAction = `hunting ${c.call} (${heard.snr} dB)${why} — from their slice, on time`;
      this.o.log(`[auto] ${this.lastAction}`);
      this.broadcastState();
    } catch (err) {
      this.o.log(`[auto] candidate call failed: ${(err as Error).message}`);
    } finally {
      // However it ended. A flag left set would hold this window's full-band decodes
      // until the pipeline's deferral deadline and block the next candidate window.
      this.startingCall = false;
    }
  }

  private async onWindow(
    windowStartMs: number,
    decodes: { message: string; snr: number; freqOffset: number }[],
    silent: boolean,
  ): Promise<void> {
    if (this.seenWindows.has(windowStartMs)) return;
    this.seenWindows.add(windowStartMs);
    if (this.seenWindows.size > 16) {
      for (const w of [...this.seenWindows].sort((a, b) => a - b).slice(0, 8)) {
        this.seenWindows.delete(w);
      }
    }

    // Remember where signals are, for clear-frequency selection.
    if (decodes.length > 0) {
      this.recentOffsets = decodes.map((d) => d.freqOffset);
      this.hopDecodeCount += decodes.length;
    }

    // Was our CQ answered in this window? Feed the guard's dead-band counter.
    const me = this.o.identity.myCall.toUpperCase();
    const answers = decodes.filter((d) => {
      const p = parseMessage(d.message);
      return p.kind === "directed" && p.to === me;
    });

    this.o.guards.afterRxWindow({
      decodes: decodes.length,
      silent,
      answeredUs: answers.length > 0,
      wasCqing: this.cqedLastWindow,
    });
    // The flag is consumed by any window that carried AUDIO, whether or not anything
    // decoded in it.
    //
    // It used to require a decode, which made the count wrong in both directions. On a band
    // with traffic an unanswered CQ was only counted if the very next window happened to
    // decode nothing, so on 20M at midday the guard barely counted at all — measured live,
    // three unanswered CQs produced two increments. On a quiet-but-not-silent band the flag
    // was never consumed and one CQ counted once per window.
    //
    // Keyed on `silent` because that is the distinction the original comment was reaching
    // for. Our own transmit window carries no receive audio — DAX goes quiet and the Icom's
    // is muted deliberately — so it is silent, and a silent window must not consume the flag
    // or an answer arriving in the NEXT window would be counted against a CQ nobody had
    // failed to answer. A band with nothing but noise still carries audio, so its windows
    // consume it, and one CQ counts once.

    if (this.mode === "off") return;

    // What the antenna did here, recorded every window. The guards only hold an SWR
    // reading taken while transmitting, so this is always about the band we are on.
    this.noteBandSwr();

    // And what this receiver actually HEARS here, which is the only measure of a
    // band that accounts for our own antenna and location.
    this.windowsOnBand++;
    this.decodesOnBand += decodes.length;
    // Per-window history, so a band can be judged against its own earlier self, and
    // the noise floor it is sitting under.
    this.windowDecodes.push(decodes.length);
    if (this.windowDecodes.length > 120) this.windowDecodes.shift();
    const noise = this.o.noiseDbm?.();
    const nowBand = this.o.getBandMode().band;
    if (nowBand && noise != null) this.bandNoise.set(nowBand.toUpperCase(), noise);

    // Note anyone calling us BEFORE the checks that gate transmitting.
    //
    // Remembering a station costs no transmission, so warm-up, a quiet pause and a
    // guard fault are all irrelevant to it — and each of those returns early below.
    // Placed after them, a tail-ender calling during the two warm-up windows of a
    // fresh band, or while the guards were paused, was heard and forgotten.
    //
    // ALWAYS, not only while busy. That condition used to be
    // `hasActive || startingCall`, which contradicted the paragraph above it: remembering
    // a station costs no transmission, so there is no reason to be selective about when we
    // are willing to remember one.
    //
    // What it cost, measured 2026-08-31 with the operator watching:
    //
    //     00:40:00  COMPLETE with KC3LVG          <- the station goes idle
    //     00:40:07  K9XYZ W8PP EM89               <- calling us
    //     00:40:07  K9XYZ KC1UVP FN42             <- calling us
    //     00:40:22  K9XYZ W8PP EM89               <- calling again
    //     00:40:22  K9XYZ KC1UVP FN42             <- calling again
    //     00:40:36  [auto] 20M is running 52 stations against 12 - moving
    //
    // Seven seconds after a contact ended, two stations answered - and because the
    // station was IDLE by then, neither was recorded. The hunt only ranks CQs
    // (`p.kind === "cq"`), so a directed call to us is invisible there too: not queued,
    // not hunted, not worked. The status line read "no callable CQs (dupes / cooling
    // down)" with an empty queue while two people called. Then it changed band.
    //
    // `answers` is already filtered to `p.to === me`, so this only ever remembers
    // somebody genuinely calling US.
    this.noteCallbacks(answers, windowStartMs);

    // A paused guard is where band-hopping takes over — otherwise wait for the
    // operator to re-arm.
    // Only hop on a QUIET pause — with ONE exception, high SWR.
    //
    // PA temperature and a dead receiver follow the radio to whatever band it moves
    // to, so hopping on those is just a paused station that also keeps retuning.
    // SWR is different: it is antenna resonance, and an aerial that will not load on
    // one band is very often flat on another. After the ATU has already had its go
    // there is nothing left to try except somewhere else.
    //
    // The old blanket rule was written to stop hopping calling rearm() and clearing
    // an SWR trip while STAYING on the same band, which kept transmitting into a
    // suspect antenna. Moving first and re-arming second is the opposite case.
    if (this.o.guards.pausedReason && this.o.guards.pauseCause !== "quiet") {
      if (this.isSwrFault() && (await this.hopAwayFromSwr())) {
        this.broadcastState();
        return;
      }
      this.lastAction = `paused: ${this.o.guards.pausedReason}`;
      return;
    }
    if (this.o.guards.pausedReason) {
      await this.maybeHop();
      this.broadcastState();
      return;
    }

    // ANSWERING SOMEBODY WHO CALLED US COMES BEFORE THE WARMUP, and that ordering is the
    // fix rather than an optimisation.
    //
    // The warmup exists to judge a BAND - it listens before deciding whether this one is
    // worth staying on. A station calling us needs none of that decided: they are already
    // here, on frequency, with our callsign in their message. Making them wait while we
    // work out whether we like the band is the same fault as never queuing them at all,
    // and it is how the queue behaved for the 90 seconds after every band change once the
    // warmup became a duration rather than two windows.
    //
    // Caught by check:callback-queue, which failed on six assertions the moment the
    // warmup got longer. The test was right and the code was wrong.
    // THE LENGTH IS CHECKED SYNCHRONOUSLY FIRST, and that matters more than it looks.
    //
    // `await` yields a microtask even when the function returns immediately, and this runs
    // on EVERY window while the queue is almost always empty. The candidate list built
    // further down is read by the decode pipeline for the next window, so an extra tick
    // here moves a real deadline — check:first-tx failed on seven assertions when this was
    // awaited unconditionally.
    if (
      this.callbacks.length > 0 &&
      !this.o.controller.hasActive &&
      !this.startingCall &&
      (await this.callBackWaiting())
    ) {
      this.broadcastState();
      return;
    }

    if (this.warmup > 0) {
      this.warmup--;
      // A fresh band that stays this quiet is not worth CQing into.
      //
      // This is why a hop is sometimes immediately followed by another with no CQ in
      // between, which looks like a fault in the log and is not. Seen on the first on-air
      // run: 40M at 10:29:29, judged quiet with 0 decodes, 20M at 10:30:00, settled there
      // with 42. Two hops and one ATU cycle each, in 31 seconds, exactly as designed.
      if (this.warmup === 0 && this.hopping) {
        if (this.hopDecodeCount < HOP_MIN_DECODES) {
          this.quietHops++;
          // THE BACKSTOP. Hopping decodes nothing while the radio is moving, and a
          // rotation that never finds anything moves it for ever — measured on
          // 2026-08-31 as a hop every 15 s until the audio watchdog restarted the
          // bridge. Staying put decodes nothing either, but it stops retuning, keeps
          // the audio stream up, and leaves a station that recovers the moment
          // anything is heard. The rotation resumes on the next band change or the
          // next decode.
          if (this.quietHops >= MAX_QUIET_HOPS) {
            this.hopping = false;
            this.lastAction =
              `${this.quietHops} bands in a row heard nothing — staying put rather than ` +
              `hopping on. Nothing is being decoded anywhere; check the antenna and the receiver.`;
            this.o.log(`[auto] ${this.lastAction}`);
          } else {
            this.lastAction = `band too quiet (${this.hopDecodeCount} decodes) — hopping on`;
            this.o.log(`[auto] ${this.lastAction}`);
            await this.hopNext();
          }
        } else {
          this.hopping = false;
          this.quietHops = 0;
          this.lastAction = `settled on new band (${this.hopDecodeCount} decodes)`;
          this.o.log(`[auto] ${this.lastAction}`);
        }
      }
      this.broadcastState();
      return;
    }

    // WHO WE WOULD CALL, WORKED OUT NOW RATHER THAN WHEN WE NEED IT.
    //
    // Ranking this window's CQs costs a cached worked-index read and one DXCC lookup per
    // callsign, and it happens about thirteen seconds before the next window is cut — as
    // far from the critical path as anything in this file gets. What it buys is that when
    // that window IS cut, the decode pipeline can be told where to look first, and the
    // first call of a contact stops going out 1.3-1.4 s late. See `candidateOffsetsHz`.
    //
    // DELIBERATELY BEFORE THE `hasActive` RETURN BELOW, and that placement is the whole
    // reason this is here and not left inside `huntWindow`. The commonest first call in
    // the log is the one right after a contact ends, and during that contact `huntWindow`
    // never runs — so the list would be a minute stale exactly when it matters most. Our
    // own transmit windows are silent and rank to an empty list, which is correct: we
    // heard nothing on that parity because we were talking.
    //
    // After the pause and warm-up returns, because a station that may not transmit has no
    // first call to make punctual, and a warming-up band has not been listened to yet.
    if (this.mode === "hunt" || this.mode === "hunt-pota") {
      await this.rankWindow(windowStartMs, decodes);
    }

    // Hand answers to the controller: someone called us while we were CQing.
    if (!this.o.controller.hasActive && !this.startingCall && answers.length > 0 && this.cqParity !== null) {
      // Strongest answer wins; the rest will call again next cycle.
      const best = answers.sort((a, b) => b.snr - a.snr)[0]!;
      const p = parseMessage(best.message);
      if (p.kind === "directed") {
        const grid = p.payload.type === "grid" ? p.payload.grid : null;
        this.o.controller.startAnswer({
          theirCall: p.from,
          theirGrid: grid,
          theirSnr: best.snr,
          parity: this.cqParity,
          offsetHz: this.cqOffsetHz ?? 1500,
          // What they called us with, for the contact's transcript.
          theirMessage: best.message,
          theirWindowStart: windowStartMs,
        });
        this.lastAction = `answering ${p.from}`;
        this.broadcastState();
        return;
      }
    }

    // While a QSO runs, the controller owns the transmitter. Anyone who called in
    // the meantime was noted above.
    //
    // `startingCall` counts as running. A candidate's slice starts the contact through
    // `mayCall` and `startCall`, both of which read the database, and until those settle
    // `hasActive` is still false — so without this a slow lookup would let this window's
    // full pass rank the band and call somebody ELSE, and the two would race for the
    // transmitter. The deferral in the decode pipeline usually keeps that window from
    // arriving at all; this is what holds when it does.
    if (this.o.controller.hasActive || this.startingCall) {
      this.broadcastState();
      return;
    }

    // Anyone who called while we were busy gets worked before we go looking for
    // someone new. They asked first, and they are still on frequency.
    //
    // Reached only when the warmup has already passed - the check above answers callers
    // during it - so this is the ordinary idle path rather than a duplicate of it.
    if (await this.callBackWaiting()) {
      this.broadcastState();
      return;
    }

    // Did the last move survive contact with our own antenna?
    //
    // Asked every window rather than at the end of warm-up, and that placement is
    // the whole point: warm-up is two windows and a decode rate needs four to mean
    // anything, so judging at the settle point asked a question the answer to which
    // was always "too early to say" — and then never asked again. Here it waits
    // until there is a real sample, roughly a minute after arriving.
    //
    // Before the better-band check below, because "was the last move wrong" has to
    // be settled before another one is considered.
    if (await this.maybeReturnFromDeafBand()) {
      this.broadcastState();
      return;
    }

    // Is the band we are on still worth sitting on at all? Independent of any hop.
    if (await this.maybeLeaveUnproductiveBand()) {
      this.broadcastState();
      return;
    }

    // ...and is it offering anybody to CALL? A band can be decoding perfectly well and
    // still have nothing on it for us, which neither of the checks above can see:
    // one wants zero decodes, the other wants attempts that a band with nobody to
    // attempt will never produce. Placed after them so that when both are ready the
    // longer-baseline rate and noise reasoning wins the log line.
    if (await this.maybeLeaveBandWithNobodyToCall()) {
      this.broadcastState();
      return;
    }

    // The band we are on may simply have been overtaken. Checked here, between
    // contacts, so this can never interrupt one.
    if (await this.maybeHopToBetterBand()) {
      this.broadcastState();
      return;
    }

    if (this.mode === "pota-chase") {
      await this.potaChaseWindow(windowStartMs, decodes);
    } else if (this.mode === "hunt" || this.mode === "hunt-pota") {
      this.noteHuntOutcome(await this.huntWindow(windowStartMs, decodes));
    } else if (this.mode === "cq") {
      await this.cqWindow(windowStartMs);
    }
    this.broadcastState();
  }

  /**
   * Find the best callable CQ in this window and go after it.
   *
   * "Best" is award value first, signal strength only as a tiebreaker: on a busy
   * band, ranking by SNR alone means working the same nearby stations forever
   * while a new entity two S-units down goes unanswered.
   */
  private async huntWindow(
    windowStartMs: number,
    decodes: { message: string; snr: number; freqOffset: number }[],
  ): Promise<HuntOutcome> {
    const { band, mode } = this.o.getBandMode();
    const ranked = await this.rankWindow(windowStartMs, decodes);
    // Who called CQ here at all. Read from the memo `rankWindow` just wrote, so it is the
    // same parse of the same decodes — see HuntOutcome.cqs.
    const cqs =
      this.candidates?.at === windowStartMs ? this.candidates.cqCalls : ([] as string[]);
    if (ranked === null) {
      // "callable" rather than "CQs": with `auto.callFinishedStations` on, a station that
      // just sent RR73 counts too, and a status line saying "no CQs" would be false on a
      // window where one was heard and admitted.
      this.lastAction = "nobody callable this window";
      return { callable: false, cqs, refused: 0 };
    }
    if (ranked.length === 0) {
      const prefs = await this.o.huntPrefs();
      this.lastAction = prefs.newOnly ? "nothing new on frequency" : "nothing above the SNR floor";
      return { callable: false, cqs, refused: 0 };
    }

    // Counted from the `mayCall` this loop was already going to run. No extra query, and
    // no second opinion about who is callable: the answer that decides whether we call
    // somebody is the same answer that decides whether this band is offering anybody.
    let refused = 0;
    let callable = false;
    for (const c of ranked) {
      const may = await this.o.guards.mayCall(
        c.call,
        band ?? "?",
        mode,
        Date.now(),
        this.o.wasWorked,
        this.o.callChecks(),
      );
      if (!may.allowed) {
        refused++;
        continue;
      }
      // The band offered somebody, whatever happens next. A transmitter that will not
      // take the contact is a fact about US, and must never be read as the band having
      // nothing on it.
      callable = true;

      const result = await this.o.controller.startCall({
        theirCall: c.call,
        theirGrid: c.grid,
        theirSnr: c.snr,
        theirOffsetHz: c.freqOffset,
        theirWindowStart: windowStartMs,
        sig: c.sig,
        sigInfo: c.sigInfo,
        theirMessage: c.message,
      });
      if (result.ok) {
        const why = c.reasons.length ? ` — ${c.reasons.join(", ")}` : "";
        this.lastAction = `hunting ${c.call} (${c.snr} dB)${why}`;
        this.o.log(`[auto] ${this.lastAction}`);
        return { callable: true, cqs, refused };
      }
    }
    const prefs = await this.o.huntPrefs();
    this.lastAction = prefs.newOnly
      ? "nothing new on frequency"
      : "nobody callable (dupes / cooling down)";
    return { callable, cqs, refused };
  }

  /**
   * Rank this window's CQs and REMEMBER the answer. Null when nobody called CQ.
   *
   * Split out of `huntWindow` because the ranking is worth more than the call it
   * immediately produces: it is also the only honest answer to "where will the station we
   * are most likely to call next be transmitting", and that question is asked by the
   * decode pipeline about a LATER window, before that window has been decoded. See
   * `candidateOffsetsHz`.
   *
   * NO SECOND SOURCE OF TRUTH. This is the list `huntWindow` has always built, kept
   * instead of discarded. The callsign, grid, SNR, offset and park all come from the same
   * decode and the same `rankCandidates` call that decides who gets called; nothing here
   * re-derives any of them, so the candidate slice can never be pointed somewhere the
   * hunt would not have gone.
   */
  private async rankWindow(
    windowStartMs: number,
    decodes: { message: string; snr: number; freqOffset: number }[],
  ): Promise<HuntCandidate[] | null> {
    // ONCE PER WINDOW. This is now called twice for every hunted window — once eagerly
    // from `onWindow` so the list exists before the next same-parity cut, and again from
    // `huntWindow` when the ordinary hunt runs — and the second call must not repeat a
    // DXCC lookup per callsign against the database.
    const memo = this.candidates;
    // `heardCq` rather than a length test: a window where twenty stations called CQ and
    // every one was filtered out by `newOnly` or `minSnr` is NOT a window where nobody
    // called, and the status line says something different about each.
    if (memo && memo.at === windowStartMs) return memo.heardCq ? memo.list : null;

    const { band } = this.o.getBandMode();
    const me = this.o.identity.myCall.toUpperCase();

    // PREFS BEFORE THE FILTER, because the filter now depends on them. Awaited here rather
    // than at its old position further down; it is the same call and `rankWindow` runs it
    // once per window.
    const prefs = await this.o.huntPrefs();

    const cqs = decodes
      .map((d) => ({ d, p: parseMessage(d.message) }))
      // CALLABILITY IS NOW A FUNCTION, not a condition. `lib/digital/callable.ts` decides
      // it, so the rule that admits a station which has just sent RR73 — and refuses one
      // that is mid-exchange with a stranger — is one testable thing rather than a
      // lengthening boolean here. See scripts/check-callable.ts for both directions.
      .filter((x) => callableFrom(x.p, { myCall: me, treatClosingAsCallable: prefs.callFinished === true }).callable)
      .filter((x) =>
        // POTA HUNT STAYS CQ-ONLY. "CQ POTA" is the activator announcing a park contact;
        // an RR73 carries no modifier, so admitting closings here would turn a park hunt
        // into a general one the moment the operator enabled the wider rule.
        this.mode === "hunt-pota"
          ? x.p.kind === "cq" && (x.p as { modifier: string | null }).modifier === "POTA"
          : true,
      );

    // A DIRECTED CQ IS NOT AN INVITATION. "CQ KH KD2TC" is calling Hawaii; answering it
    // from Indiana is rude and futile, and the four transmit cycles spent finding that out
    // produced nothing. Reported live, with the station calling KD2TC twice.
    //
    // FILTERED HERE AND ONLY HERE, because this list is the one source of truth — the
    // candidate fast path reads it rather than re-deriving its own, so a CQ refused here is
    // refused everywhere the hunt can reach.
    //
    // Deliberately NOT applied to the other ways a call starts: a station calling US has
    // chosen us and carries no modifier at all; a POTA chase is aimed at a named activator
    // from the spot feed; and a manual Call is the operator's decision, which this has no
    // business overruling.
    // OUR OWN ENTITY IS RESOLVED LAZILY, and that is not a micro-optimisation.
    //
    // Awaiting it unconditionally put an extra await on EVERY window, including the
    // overwhelming majority that carry no directed CQ at all — and the candidate list is
    // read by the decode pipeline for the NEXT window, so moving when it is populated
    // moves a real deadline. check:first-tx failed on five assertions the moment it was
    // added: the list was empty when the pipeline asked for it.
    //
    // Nothing is looked up unless a modifier actually needs judging.
    let mine: Awaited<ReturnType<typeof this.entityFor>> | undefined;
    const addressed: typeof cqs = [];
    for (const x of cqs) {
      // Narrowed rather than cast: the filter above has already established these are CQs,
      // but the compiler cannot see through it and a cast would hide a real change to the
      // filter from ever being caught here.
      //
      // AND THAT IS EXACTLY WHAT HAPPENED. This was `continue`, written when the only way
      // into this list was a CQ. `auto.callFinishedStations` made a directed closing token
      // a candidate too, and this line then dropped every one of them silently — the
      // candidate list came out empty and the status line said "nobody callable" on a
      // window that had somebody. Caught by the wiring assertion in check:first-tx, not by
      // the rule's own tests, which were all passing.
      //
      // A closing token carries no CQ modifier, so there is nothing for `cqIsForUs` to
      // judge and it is admitted directly. The comment above was right that a cast would
      // have hidden this; the `continue` hid it instead.
      if (x.p.kind !== "cq") {
        addressed.push(x);
        continue;
      }
      const modifier = x.p.modifier;
      if (!modifier) {
        addressed.push(x);
        continue;
      }
      if (mine === undefined) mine = await this.entityFor(me);
      const theirs = await this.entityFor(x.p.from);
      const verdict = cqIsForUs(modifier, {
        myCall: me,
        myContinent: mine?.continent ?? null,
        myDxcc: mine?.adif ?? null,
        theirDxcc: theirs?.adif ?? null,
      });
      if (verdict.forUs) {
        addressed.push(x);
      } else if (!this.skippedCqs.has(x.p.from)) {
        // Once per callsign, because a directed CQ repeats every cycle and the log is
        // read by people looking for faults.
        this.skippedCqs.add(x.p.from);
        if (this.skippedCqs.size > 200) this.skippedCqs.clear();
        this.o.log(`[auto] not answering ${x.p.from}: ${verdict.reason}`);
      }
    }
    cqs.length = 0;
    cqs.push(...addressed);
    if (cqs.length === 0) {
      // Recorded as an EMPTY list rather than left alone, so `candidateOffsetsHz` can
      // tell "this parity had nobody" from "this parity was never listened to". Without
      // that distinction a quiet window would silently reuse the offsets from a minute
      // ago and search where nobody is.
      this.candidates = { at: windowStartMs, heardCq: false, list: [], cqCalls: [] };
      return null;
    }

    const worked = await this.workedFor(band);

    const candidates: Candidate[] = [];
    const byCall = new Map<
      string,
      {
        snr: number;
        freqOffset: number;
        sig: string | null;
        sigInfo: string | null;
        /** The CQ verbatim, so the contact's transcript opens with what we answered. */
        message: string;
      }
    >();
    for (const { d, p } of cqs) {
      // `other` cannot reach here — `callableFrom` refuses it — but the narrowing has to be
      // written for the compiler, and this replaces an `if (p.kind !== "cq") continue` that
      // would have silently dropped every closing-token candidate the filter just admitted.
      if (p.kind === "other") continue;
      const isClosing = p.kind === "directed";
      // "CQ POTA" is the activator telling us this is a park contact. Which park is
      // not in the message — there is no room for it — so the reference comes from
      // the spot feed when it agrees on callsign AND band, and is left empty
      // otherwise. SIG without SIG_INFO is valid ADIF and is honestly what we know;
      // taking a reference from a spot on a different band would be inventing data.
      const mod = p.kind === "cq" ? (p as { modifier: string | null }).modifier : null;
      const isPota = mod === "POTA";
      const park = isPota ? this.parkFor(p.from, band) : null;
      byCall.set(p.from, {
        snr: d.snr,
        freqOffset: d.freqOffset,
        sig: isPota ? "POTA" : null,
        sigInfo: park,
        message: d.message,
      });
      candidates.push({
        call: p.from,
        snr: d.snr,
        // A closing token carries no grid — `lib/digital/qso.ts` gives `{type:"rr73"}` with
        // no locator, and RR73 must never be read as one. So a station admitted this way
        // simply forgoes the new-grid awards, which is correct: we do not know their grid.
        grid: isClosing ? null : p.grid,
        dxcc: await this.entityFor(p.from),
        // The same park the contact would be logged against, so an unworked
        // reference ranks an activator up — this is the scoring the decode list's
        // badges show, and the two must not disagree about what is worth calling.
        park,
        // They said "CQ POTA", which is true whether or not the spot feed has
        // caught up enough to tell us which park.
        potaCq: isPota,
      });
    }

    const ranked = rankCandidates(candidates, worked, {
      newOnly: prefs.newOnly,
      minSnr: prefs.minSnr,
    });

    const list: HuntCandidate[] = [];
    for (const c of ranked) {
      const heard = byCall.get(c.call);
      if (!heard) continue;
      list.push({ call: c.call, grid: c.grid, reasons: c.reasons, ...heard });
    }
    // `byCall` is keyed by callsign and built from every CQ in the window, BEFORE
    // `rankCandidates` applied `newOnly` and the SNR floor. That is the honest answer to
    // "was anybody calling here", which is a different question from "was anybody worth
    // calling" and the streak's log line has to tell them apart.
    this.candidates = { at: windowStartMs, heardCq: true, list, cqCalls: [...byCall.keys()] };
    return list;
  }

  /**
   * Chase spotted POTA activators: retune to a park frequency, work whoever is
   * there, move to the next spot.
   *
   * Different from hunt-pota, which only works activators already audible on the
   * calling frequency. Here the radio goes to them.
   *
   * The order of business each window matters, and the first version had it wrong.
   * A spot is a *reason to move the dial*, and moving the dial costs the give-up
   * period of hearing nothing if the guess was bad. So:
   *
   *   1. If parked on someone, deal with them.
   *   2. Otherwise work any POTA CQ already audible — free, no retune, and the
   *      activator is frequently audible before the spot feed catches up.
   *   3. Only then consider retuning, and only to a band that can actually be
   *      heard from here.
   *   4. With nothing to chase, go home to the calling frequency.
   *
   * Step 3's band rule is the whole difference between working parks and touring
   * empty frequencies. Live, 30 FT8 spots were spread over eight bands including
   * 160 m Poland and 10 m Brazil at 20:00 UTC from Indiana.
   */
  private async potaChaseWindow(
    windowStartMs: number,
    decodes: { message: string; snr: number; freqOffset: number }[],
  ): Promise<void> {
    const { band, mode } = this.o.getBandMode();
    const prefs = await this.o.potaPrefs();

    // Already parked on an activator: look for them in this window.
    if (this.chasing) {
      const target = this.chasing.activator;
      const heard = decodes
        .map((d) => ({ d, p: parseMessage(d.message) }))
        .find(
          (x) =>
            (x.p.kind === "cq" && x.p.from === target) ||
            (x.p.kind === "directed" && x.p.from === target),
        );

      if (heard) {
        const may = await this.o.guards.mayCall(
          target,
          band ?? "?",
          mode,
          Date.now(),
          this.o.wasWorked,
          this.o.callChecks(),
        );
        if (may.allowed) {
          const grid = heard.p.kind === "cq" ? heard.p.grid : null;
          const r = await this.o.controller.startCall({
            theirCall: target,
            theirGrid: grid,
            theirSnr: heard.d.snr,
            theirOffsetHz: heard.d.freqOffset,
            theirWindowStart: windowStartMs,
            // We know exactly which park this is: it is why we retuned.
            sig: "POTA",
            sigInfo: this.chasing.reference,
            theirMessage: heard.d.message,
          });
          if (r.ok) {
            this.lastAction = `chasing ${target} at ${this.chasing.reference}`;
            this.o.log(`[auto] ${this.lastAction}`);
            return;
          }
        }
        // Heard but not callable (dupe/cooldown) — no reason to stay parked.
        this.chaseTried.set(target, Date.now());
        this.chasing = null;
      } else if (Date.now() - this.chasing.since > prefs.giveUpMs) {
        // Long enough without hearing them: they have moved, gone, or are not
        // propagating here. Do not sit on a dead frequency.
        this.o.log(`[auto] gave up on ${target} (not heard)`);
        this.chaseTried.set(target, Date.now());
        this.chasing = null;
      } else {
        // Waiting for someone we cannot hear — but not deaf to everyone else.
        //
        // This branch used to `return`, and that cost four hours of an evening. The
        // radio sat parked on one silent activator after another while AE2NY, never
        // worked before, called CQ POTA at −6 dB on the same band for twelve minutes.
        // Every window was spent waiting for a station that was not there, and the
        // one that was got ignored, because the audible-CQ path lives below this
        // point and was never reached.
        //
        // A workable activator in front of us beats a silent one we retuned for, so
        // the park is abandoned rather than defended. The target is NOT marked as
        // tried: nothing failed with them, we simply took the better option, and they
        // are still worth chasing afterwards.
        if (prefs.workAudible && decodes.length > 0) {
          const before = this.o.controller.hasActive;
          await this.huntPotaAudible(windowStartMs, decodes);
          if (!before && this.o.controller.hasActive) return;
        }
        this.lastAction = `parked on ${target} (${this.chasing.reference}), listening`;
        return;
      }
    }

    // Free contacts first: a POTA CQ audible right here needs no retune and costs
    // no listening time. huntWindow already does exactly this selection, award
    // ranking included, so chase mode borrows it rather than growing a second copy
    // that would drift out of step.
    if (prefs.workAudible && decodes.length > 0) {
      const before = this.o.controller.hasActive;
      await this.huntPotaAudible(windowStartMs, decodes);
      if (!before && this.o.controller.hasActive) return;
    }

    // POTA is asked at most once a minute; the cached answer is re-examined every
    // window. The feed genuinely does not change faster than that, but our own
    // situation does — an activator we just abandoned changes which spot is next.
    let spots: Awaited<ReturnType<AutoOperatorOptions["potaSpots"]>>;
    if (this.spotCache && Date.now() - this.lastSpotCheck < 60_000) {
      spots = this.spotCache;
    } else {
      this.lastSpotCheck = Date.now();
      try {
        spots = await this.o.potaSpots();
        this.spotCache = spots;
      } catch (err) {
        this.lastAction = `POTA spots unavailable: ${(err as Error).message}`;
        // Fall back to the stale list rather than doing nothing: a network blip
        // should not strand the radio on a frequency it has given up on.
        if (!this.spotCache) return;
        spots = this.spotCache;
      }
    }

    // Blank setting means "stay on the band chase started on". Falling back to the
    // *current* band would defeat the purpose: one accepted cross-band spot would
    // silently redefine home and the restriction would follow the drift.
    const allowed = prefs.bands ?? (this.chaseHome ? [this.chaseHome.band] : band ? [band] : []);

    const candidates = spots.filter((s) => {
      if (s.mode !== mode) return false; // an FT8 chase must not retune to an FT4 spot
      if (allowed.length > 0 && (!s.band || !allowed.includes(s.band))) return false;
      const tried = this.chaseTried.get(s.activator);
      return !(tried && Date.now() - tried < prefs.retryMs);
    });

    for (const spot of await this.rankSpots(candidates, prefs.preferNew, band)) {
      const may = await this.o.guards.mayCall(
        spot.activator,
        spot.band ?? "?",
        spot.mode,
        Date.now(),
        this.o.wasWorked,
        this.o.callChecks(),
      );
      if (!may.allowed) continue;

      if (!(await this.o.tuneHz(spot.freqHz))) {
        this.lastAction = `could not tune to ${(spot.freqHz / 1e6).toFixed(3)} MHz`;
        continue;
      }
      this.chaseParkedHz = spot.freqHz;
      this.chasing = {
        activator: spot.activator,
        since: Date.now(),
        reference: spot.reference,
      };
      this.warmup = this.warmupWindows();
      this.lastAction = `tuned ${(spot.freqHz / 1e6).toFixed(3)} for ${spot.activator} (${spot.reference})`;
      this.o.log(`[auto] ${this.lastAction}`);
      return;
    }

    // Nothing worth chasing. Go home rather than sit on the last park's frequency
    // with the receiver pointed at nobody.
    const scope = allowed.length > 0 ? allowed.join("/") : "any band";
    if (prefs.returnToCalling && this.chaseParkedHz !== null && this.chaseHome) {
      const home = this.chaseHome;
      if (await this.o.retune(home.band, home.mode)) {
        this.chaseParkedHz = null;
        this.warmup = this.warmupWindows();
        this.lastAction = `no POTA activators on ${scope} — back to ${home.band} ${home.mode}`;
        this.o.log(`[auto] ${this.lastAction}`);
        return;
      }
    }
    this.lastAction = `no new POTA activators on ${mode}, ${scope} (${spots.length} spots)`;
  }

  /**
   * The park reference for an activator we can hear, from the cached spot feed.
   *
   * Requires the band to agree as well as the callsign. The same operator can be
   * spotted in one park on 20 m and — later, or by a stale spot — somewhere else
   * entirely; matching on callsign alone would write a confident, wrong reference
   * into the log, which is worse than writing none.
   *
   * Returns null when chase mode has never polled, which is the normal case in the
   * plain hunt modes. No reference is the honest answer there.
   */
  private parkFor(call: string, band: string | null): string | null {
    if (!this.spotCache || !band) return null;
    const hit = this.spotCache.find((s) => s.activator === call && s.band === band);
    return hit?.reference ?? null;
  }

  /**
   * Work an audible "CQ POTA" without moving the dial.
   *
   * Temporarily borrows huntWindow by way of `hunt-pota`, so the candidate
   * filtering, award ranking and guard checks are the same code in both modes. The
   * mode field is restored in a `finally` — leaking `hunt-pota` here would silently
   * turn a chase into a hunt.
   */
  private async huntPotaAudible(
    windowStartMs: number,
    decodes: { message: string; snr: number; freqOffset: number }[],
  ): Promise<void> {
    const saved = this.mode;
    this.mode = "hunt-pota";
    try {
      // The outcome is DELIBERATELY DROPPED. A chase window with no audible "CQ POTA" is
      // the ordinary condition of chase mode — the activators are somewhere else on the
      // dial, which is why the mode retunes — and feeding it to the "nobody to call"
      // streak would have chase mode hop bands out from under its own chase.
      await this.huntWindow(windowStartMs, decodes);
    } finally {
      this.mode = saved;
    }
  }

  /**
   * Order spots by how much they are worth going to.
   *
   * Freshness alone — what the feed gives — ignores the two things that decide
   * whether a retune pays off: whether the activator is on a band we are already
   * listening to (no retune, no deaf period at all), and whether the contact would
   * be new. Spots arrive freshest-first, so ties keep that order.
   *
   * Novelty is scored per DXCC entity and per band-slot, not per callsign: the
   * guards already refuse dupes, and "have I worked this exact activator" is a
   * question this ranking does not need to answer to put the right spot first.
   */
  private async rankSpots<T extends { activator: string; band: string | null }>(
    spots: T[],
    preferNew: boolean,
    currentBand: string | null,
  ): Promise<T[]> {
    if (spots.length === 0) return spots;

    const worked = preferNew ? await this.workedFor(currentBand) : null;
    const scored = await Promise.all(
      spots.map(async (s, i) => {
        // Same band outranks everything: it is the only case with no cost at all.
        let score = s.band && s.band === currentBand ? 100 : 0;
        if (worked) {
          const e = await this.o.resolveEntity(s.activator);
          if (e) {
            if (!worked.dxcc.has(e.adif)) score += 50;
            else if (s.band === currentBand && !worked.dxccThisBand.has(e.adif)) score += 15;
          }
        }
        return { s, score, i };
      }),
    );
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((x) => x.s);
  }

  /**
   * The worked index, cached for a minute.
   *
   * It is several aggregate queries over the whole log — at 26 k QSOs that is
   * not something to run every 15 seconds, and it changes only when we log
   * something (which invalidates it explicitly).
   */
  /**
   * DXCC entity per callsign, remembered.
   *
   * WHAT THIS IS ACTUALLY FOR IS TIMING, not database load. `rankWindow` resolves the
   * entity of every station calling CQ, and on a busy 20 m evening that is twenty or
   * thirty separate queries between the window's decodes arriving and the first call
   * going out — the chain that puts a first call 1.3-1.4 s behind its window. The
   * candidate slice steps around that chain when it hits; this shortens it for every
   * window where it does not, which is the case the slice makes slightly worse by
   * costing a decode before the full pass.
   *
   * SAFE TO REMEMBER, unlike the worked index next door. A callsign's DXCC entity is a
   * fact about the prefix and the date, and it changes only when an administrator loads a
   * new cty.xml — which is why this has a plain TTL and no invalidation hook, while
   * `workedCache` has `invalidateWorked()` called on every logged contact. The cost of
   * being half an hour stale is one contact ranked against yesterday's entity list; the
   * cost of a stale worked index is calling a dupe.
   *
   * NOT MEASURED AGAINST THE LIVE DATABASE. There is none on this machine. The shape of
   * the win is certain — the same twenty callsigns call CQ window after window, so after
   * one cycle nearly every lookup is a hit — but the milliseconds are not, and the live
   * `[qso] first transmission in` line is what will say.
   */
  private entityCache = new Map<string, { at: number; entity: Awaited<ReturnType<AutoOperatorOptions["resolveEntity"]>> }>();

  private workedCache: { band: string | null; at: number; index: WorkedIndex } | null = null;

  private async workedFor(band: string | null): Promise<WorkedIndex> {
    const c = this.workedCache;
    if (c && c.band === band && Date.now() - c.at < 60_000) return c.index;
    const index = await this.o.workedIndex(band);
    this.workedCache = { band, at: Date.now(), index };
    return index;
  }

  /** Called after a QSO is logged: the index is now stale. */
  invalidateWorked(): void {
    this.workedCache = null;
  }

  /** `resolveEntity`, remembered for ENTITY_CACHE_MS. See `entityCache`. */
  private async entityFor(
    call: string,
  ): Promise<Awaited<ReturnType<AutoOperatorOptions["resolveEntity"]>>> {
    const key = call.toUpperCase();
    const hit = this.entityCache.get(key);
    if (hit && Date.now() - hit.at < ENTITY_CACHE_MS) return hit.entity;
    const entity = await this.o.resolveEntity(call);
    // Bounded, because this runs for every callsign heard for as long as the bridge is
    // up. Oldest first: a Map iterates in insertion order, and the entries being dropped
    // are the ones least likely to call CQ again in the next few minutes.
    if (this.entityCache.size >= ENTITY_CACHE_MAX) {
      for (const k of [...this.entityCache.keys()].slice(0, ENTITY_CACHE_MAX / 4)) {
        this.entityCache.delete(k);
      }
    }
    this.entityCache.set(key, { at: Date.now(), entity });
    return entity;
  }

  /** Call CQ in the next window if it is (or becomes) our parity. */
  private async cqWindow(windowStartMs: number): Promise<void> {
    const period = this.o.source.periodMs;
    const next = windowStartMs + period;

    // First CQ picks the parity (the very next window) and a clear offset.
    if (this.cqParity === null) {
      this.cqParity = (Math.floor(next / period) % 2) as 0 | 1;
    }
    if (Math.floor(next / period) % 2 !== this.cqParity) return;

    if (this.cqOffsetHz === null) this.cqOffsetHz = this.pickClearOffset();

    const gate = this.o.guards.beforeTx();
    if (!gate.allowed) {
      this.lastAction = `CQ blocked: ${gate.reason}`;
      return;
    }

    const { mode } = this.o.getBandMode();
    const msg = standardMessages({
      myCall: this.o.identity.myCall,
      myGrid: this.o.identity.myGrid,
      theirCall: "X",
      theirSnr: 0,
    }).tx6;

    this.cqedLastWindow = true;
    this.lastAction = `CQ at ${this.cqOffsetHz} Hz`;
    void this.o.tx
      .transmit({ message: msg, mode, offsetHz: this.cqOffsetHz, startAt: next })
      .then((r) => {
        if (!r.sent) {
          this.o.log(`[auto] CQ refused: ${r.reason}`);
          // Correct the status line.
          //
          // It was set optimistically above and never revised, so a CQ the radio
          // refused — transmit gated off, a guard, another client holding the
          // transmitter — displayed as "CQ at 1500 Hz" indefinitely. The operator sees
          // a station calling CQ and hears nothing, and every other indicator agrees
          // with the lie.
          this.lastAction = `CQ refused: ${r.reason ?? "the radio would not transmit"}`;
          this.cqedLastWindow = false;
          this.broadcastState();
        } else {
          this.o.log(`[auto] sent "${msg}" (timing ${r.timingErrorMs}ms)`);
        }
        this.o.broadcast({ kind: "qso-tx", message: msg, sent: r.sent, reason: r.reason });
      })
      .catch((err) => {
        this.lastAction = `CQ failed: ${(err as Error).message}`;
        this.broadcastState();
        this.o.log(`[auto] CQ error: ${(err as Error).message}`);
      });
  }

  /**
   * A frequency with nothing decoded near it last cycle.
   *
   * Prefers the 1000–2600 Hz range (audible on everyone's filters) and requires
   * 60 Hz clearance either side — an FT8 signal is 50 Hz wide.
   */
  private pickClearOffset(): number {
    for (let attempt = 0; attempt < 40; attempt++) {
      const hz = 1000 + Math.floor(Math.random() * 1600);
      if (this.recentOffsets.every((o) => Math.abs(o - hz) > 60)) return hz;
    }
    return 1000 + Math.floor(Math.random() * 1600); // busy band: take pot luck
  }

  /**
   * Note anyone calling us while the transmitter is busy with someone else.
   *
   * The station we are CURRENTLY working is skipped: their messages are addressed to
   * us too, and queuing them would have us call back someone we just finished.
   */
  private noteCallbacks(
    answers: { message: string; snr: number; freqOffset: number }[],
    windowStartMs: number,
  ): void {
    if (answers.length === 0) return;
    const busyWith = this.o.controller.state.theirCall?.toUpperCase() ?? null;

    for (const d of answers) {
      const p = parseMessage(d.message);
      if (p.kind !== "directed") continue;
      const call = p.from.toUpperCase();
      if (call === busyWith) continue;

      const grid = p.payload.type === "grid" ? p.payload.grid : null;
      const existing = this.callbacks.find((c) => c.call === call);
      if (existing) {
        // Calling again: refresh what we know, but KEEP the original position in
        // the queue. Someone calling twice has waited longer, not less.
        existing.snr = d.snr;
        existing.offsetHz = d.freqOffset;
        existing.windowStart = windowStartMs;
        existing.at = Date.now();
        if (grid) existing.grid = grid;
        continue;
      }

      // Bounded: a genuine pileup could otherwise grow without limit, and nobody
      // at the back of a twenty-deep queue is still waiting by the time we reach
      // them. Oldest are served first, so the cap drops the newest arrival.
      if (this.callbacks.length >= MAX_CALLBACKS) continue;

      this.callbacks.push({
        call,
        grid,
        snr: d.snr,
        offsetHz: d.freqOffset,
        windowStart: windowStartMs,
        message: d.message,
        at: Date.now(),
      });
      this.o.log(
        busyWith
          ? `[auto] ${call} called during the QSO — queued for a call back`
          : `[auto] ${call} is calling us — queued`,
      );
    }
    this.lastAction =
      this.callbacks.length > 0
        ? `working ${busyWith ?? "someone"}; ${this.callbacks.length} waiting`
        : this.lastAction;
  }

  /** Drop anyone who has been waiting too long to still be there. */
  private pruneCallbacks(now = Date.now()): void {
    const before = this.callbacks.length;
    this.callbacks = this.callbacks.filter((c) => now - c.at < CALLBACK_TTL_MS);
    const dropped = before - this.callbacks.length;
    if (dropped > 0) {
      this.o.log(`[auto] gave up calling back ${dropped} station(s) — too long ago`);
    }
  }

  /**
   * Work the next station that called us while we were busy.
   *
   * Returns true when a call was started, so the caller knows not to go hunting.
   * Entries are dropped as they are tried: a station the guards refuse (a dupe, a
   * cooldown) must not sit at the head of the queue blocking everyone behind it.
   */
  private async callBackWaiting(): Promise<boolean> {
    this.pruneCallbacks();
    if (this.callbacks.length === 0) return false;

    const { band, mode } = this.o.getBandMode();
    while (this.callbacks.length > 0) {
      const next = this.callbacks.shift()!;
      const may = await this.o.guards.mayCall(
        next.call,
        band ?? "?",
        mode,
        Date.now(),
        this.o.wasWorked,
        this.o.callChecks(),
      );
      if (!may.allowed) {
        this.o.log(`[auto] not calling back ${next.call}: ${may.reason}`);
        continue;
      }

      const result = await this.o.controller.startCall({
        theirCall: next.call,
        theirGrid: next.grid,
        theirSnr: next.snr,
        theirOffsetHz: next.offsetHz,
        // The window they called US in fixes whose parity is whose. Still correct
        // however long ago that was — parity is the window index mod 2, so it
        // alternates predictably rather than drifting.
        theirWindowStart: next.windowStart,
        theirMessage: next.message,
      });
      if (result.ok) {
        this.lastAction = `calling back ${next.call} (${this.callbacks.length} still waiting)`;
        this.o.log(`[auto] ${this.lastAction}`);
        return true;
      }
      this.o.log(`[auto] could not call back ${next.call}: ${result.reason ?? "refused"}`);
    }
    return false;
  }

  /**
   * Leave a band that is working, because another one is working far better.
   *
   * The rule that was missing. Hopping only ever triggered on a QUIET pause — a dead
   * band or unanswered CQs — so a station making contacts on 40 m stayed there while
   * 20 m ran three times busier. An operator looking at the band strip could see it;
   * nothing in the software was looking.
   *
   * Rate-limited hard, because the cost of being wrong is asymmetric: a needless hop
   * throws away a working band and spends two warm-up cycles finding out, while
   * arriving five minutes late to a better one costs almost nothing.
   */
  private async maybeHopToBetterBand(): Promise<boolean> {
    const cfg = await this.o.bandHop();
    if (!cfg.enabled || cfg.whenBetterRatio <= 1 || cfg.bands.length === 0) return false;
    if (this.hopping || this.warmup > 0 || this.o.controller.hasActive) return false;
    if (this.hasWaitingCallers()) return false;
    // NEVER LEAVE PEOPLE WHO ARE CALLING US. Observed 2026-08-31: two stations answered,
    // and 29 seconds later the station changed band on network figures. A caller is the
    // best contact available anywhere - they have already heard us and are on frequency
    // now - and no number about another band outranks that.
    if (this.hasWaitingCallers()) return false;

    // Never leave a band we have not measured.
    //
    // Two reasons, and the second is the important one. A rate is needed to know
    // whether the move was worth making — and without it `returnIfWorse` is null, so
    // the deaf-band safety net does not arm and a bad move becomes permanent. The
    // very first window after enabling a mode used to satisfy the timer below (it
    // starts at zero), so the radio could move on network figures before it had
    // listened to where it already was.
    if (this.currentBandRate() === null) return false;

    const now = Date.now();
    if (now - this.lastBetterCheck < BETTER_BAND_CHECK_MS) return false;
    this.lastBetterCheck = now;

    if (!this.o.bandActivity) return false;
    let activity: BandActivity[] | null;
    try {
      activity = await this.o.bandActivity();
    } catch {
      return false;
    }

    const { band: current, mode } = this.o.getBandMode();
    const better = shouldHopForBetterBand({
      current,
      // Bands this receiver has already proved deaf on are off the table, however
      // good the network says they are — we have been and listened.
      bands: this.hearableBands(cfg.bands),
      activity,
      ratio: cfg.whenBetterRatio,
    });
    if (!better) return false;

    this.o.log(
      `[auto] ${better.band} is running ${better.to} stations against ${better.from} on ` +
        `${current} — moving`,
    );
    const ok = await this.o.retune(better.band, mode);
    if (!ok) {
      this.lastAction = `could not move to ${better.band}`;
      return false;
    }
    // Remember where to come back to, and what that band was really giving us.
    //
    // Only this path sets it: this is the move made on NETWORK figures, and network
    // figures are the ones that can be wrong about our antenna. A hop away from a
    // dead band has nothing worth returning to.
    const hereRate = this.currentBandRate();
    this.returnIfWorse =
      current && hereRate !== null ? { band: current, rate: hereRate } : null;
    this.resetBandCounters(current);

    // Same bookkeeping a quiet-band hop does: listen before transmitting, and drop
    // the CQ state that belonged to the band we just left.
    this.lastAction = `moved to ${better.band} (${better.to} stations vs ${better.from}), listening`;
    this.hopping = true;
    this.hopDecodeCount = 0;
    this.warmup = this.warmupWindows();
    this.cqParity = null;
    this.cqOffsetHz = null;
    this.cqedLastWindow = false;
    // Anyone waiting called us on the band we have just left.
    this.callbacks = [];
    const at = cfg.bands.indexOf(better.band);
    if (at >= 0) this.hopIndex = at;
    return true;
  }

  /**
   * The hop list, minus bands this receiver has recently proved deaf on.
   *
   * Expiry rather than a permanent mark: propagation is the usual reason a band was
   * deaf, and propagation changes. Half an hour later it is worth another look.
   */
  private hearableBands(bands: string[]): string[] {
    const now = Date.now();
    return bands.filter((b) => {
      const until = this.poorBands.get(b.toUpperCase());
      if (until === undefined) return true;
      if (now >= until) {
        this.poorBands.delete(b.toUpperCase());
        return true;
      }
      return false;
    });
  }

  /**
   * How a contact ended, for judging whether this band is paying.
   *
   * Called by the QSO controller. Hearing plenty and working nobody is a failure the
   * decode count can never show, and it is the expensive one — every abandoned call
   * costs four transmit cycles.
   */
  noteContactOutcome(result: "made" | "lost"): void {
    if (result === "made") this.madeOnBand++;
    else this.lostOnBand++;
    // Made or lost, somebody here was callable — we called them. This is the reset the
    // candidate fast path needs: `callCandidate` starts a contact without `huntWindow`
    // ever running, so the streak would otherwise survive a contact untouched.
    this.resetNobodyStreak();
  }

  /**
   * Leave a band that is not paying, even though nothing has hopped us here.
   *
   * The gap this closes: every other check compares the band we moved TO against the
   * one we left, so a band we simply sat down on and stayed — through a restart, or
   * because the network never showed anything better — was never questioned at all.
   * Observed live: 20 m at under two decodes a cycle for three hours, with a −80 dBm
   * noise floor, while 114 receivers were copying our transmit perfectly.
   */
  private async maybeLeaveUnproductiveBand(): Promise<boolean> {
    const cfg = await this.o.bandHop();
    if (!cfg.enabled || cfg.bands.length === 0) return false;
    if (this.hopping || this.warmup > 0 || this.o.controller.hasActive) return false;
    if (this.hasWaitingCallers()) return false;

    const now = Date.now();
    if (now - this.lastProductivityCheck < PRODUCTIVITY_CHECK_MS) return false;
    this.lastProductivityCheck = now;

    const { band: current, mode } = this.o.getBandMode();
    if (!current) return false;

    // The quietest floor this station has measured ANYWHERE, which is the only
    // honest yardstick for "noisy" — no absolute number means anything without
    // knowing what this receiver and antenna read on a good band.
    const here = this.o.noiseDbm?.() ?? null;
    let quietest: number | null = null;
    for (const [b, dbm] of this.bandNoise) {
      if (b === current.toUpperCase()) continue;
      if (quietest === null || dbm < quietest) quietest = dbm;
    }

    const verdict = bandIsUnproductive({
      here: {
        windows: this.windowDecodes,
        made: this.madeOnBand,
        lost: this.lostOnBand,
      },
      minWindows: UNPRODUCTIVE_MIN_WINDOWS,
      decayFraction: UNPRODUCTIVE_DECAY,
      minAttempts: UNPRODUCTIVE_MIN_ATTEMPTS,
      minSuccess: UNPRODUCTIVE_MIN_SUCCESS,
      noise: { hereDbm: here, quietestDbm: quietest },
    });
    if (!verdict) return false;

    return this.leaveBandFor(cfg, current, mode, verdict.reason);
  }

  /**
   * Leave the band we are on, for a reason already decided, and file it as poor.
   *
   * Shared by the two "this band is not worth sitting on" rules. It was a verbatim copy
   * in the second one first, and the copy is what this exists to prevent: the departure
   * is twenty lines of bookkeeping — poor-band marking, the return intent, the counters,
   * warm-up, the CQ state, the callback queue and the hop cursor — and a rule that
   * forgets one of them leaves the station in a state no reader would predict.
   *
   * MARKED POOR, and that is deliberate for BOTH callers. `poorBands` is named for the
   * receiver being deaf, but the job it does is "we have been and there was nothing here
   * for us, so the network figures must not walk us straight back in five minutes". A
   * band we left because nobody on it was callable qualifies for exactly that. It also
   * makes the touring self-limiting: once every band on the list is marked there is no
   * target left, this declines, and the station settles until the marks expire.
   */
  private async leaveBandFor(
    cfg: { bands: string[]; toBusiest: boolean },
    current: string,
    mode: DigitalMode,
    reason: string,
  ): Promise<boolean> {
    // Somewhere else to go, chosen the same way any other hop chooses.
    //
    // The emptiness test comes FIRST, before the band-activity lookup. With every band
    // on the list marked poor there is no answer the network could give that would be
    // used, and this path can be reached on consecutive windows — see the caller.
    const usable = this.hearableBands(cfg.bands).filter(
      (b) => b.toUpperCase() !== current.toUpperCase(),
    );
    if (usable.length === 0) return false;

    let target: string | null = null;
    if (cfg.toBusiest && this.o.bandActivity) {
      try {
        target = pickBusiestBand(usable, current, await this.o.bandActivity());
      } catch {
        target = null;
      }
    }
    if (!target) {
      target = usable.find((b) => b.toUpperCase() !== current.toUpperCase()) ?? null;
    }
    if (!target) return false;

    this.o.log(`[auto] leaving ${current}: ${reason} — trying ${target}`);
    if (!(await this.o.retune(target, mode))) {
      this.lastAction = `could not leave ${current}`;
      return false;
    }

    // Marked poor so the network figures cannot walk us straight back into it.
    this.poorBands.set(current.toUpperCase(), Date.now() + POOR_BAND_MS);
    this.returnIfWorse = null;
    this.resetBandCounters(current);
    this.lastAction = `left ${current} — ${reason}`;
    this.hopping = true;
    this.hopDecodeCount = 0;
    this.warmup = this.warmupWindows();
    this.cqParity = null;
    this.cqOffsetHz = null;
    this.cqedLastWindow = false;
    this.callbacks = [];
    const at = cfg.bands.indexOf(target);
    if (at >= 0) this.hopIndex = at;
    return true;
  }

  /**
   * Leave a band that is decoding perfectly well and has NOBODY ON IT TO CALL.
   *
   * THE FAULT, observed live on 30 Aug at 09:08: settled on 17 m at 09:03 with 3 decodes
   * in the window and 17 in the rolling buffer, and 0 calls, 0 contacts, 0 abandoned
   * since arriving. Neither existing escape could fire, and neither was broken —
   * "band too quiet" wants literally 0 decodes and had fired correctly twice that same
   * morning, and "not paying" wants UNPRODUCTIVE_MIN_ATTEMPTS contact attempts before a
   * success rate means anything, which a band offering nobody to attempt will never
   * supply. Between them those two measure "we hear nothing" and "we hear plenty and
   * convert none of it", and the gap is this: a dead band with two beacons on it, a band
   * where everything audible is already in the log, or one where every station heard is
   * already busy with somebody else.
   *
   * WHERE "CALLABLE" COMES FROM. The hunt's own answer and nothing else. Every window
   * `rankWindow` ranks the CQs with `rankCandidates`, and `huntWindow` puts that ranked
   * list through `guards.mayCall` — both run anyway, and the second is where the
   * do-not-call list, the dupe window and the band-slot rules live. A window counts as
   * empty when that pass produced nobody it would have called. No second notion of worth
   * and no second database read: `HuntOutcome` is the existing pass reporting what it
   * already saw. See `noteHuntOutcome`.
   *
   * A LIVE QSO SUPPRESSES IT, as the other two band checks do. `onWindow` returns before
   * the hunt while `controller.hasActive` or `startingCall` is set, so those windows
   * never enter the streak, and `noteContactOutcome` clears it outright when the contact
   * ends — a contact is proof the band had somebody on it.
   *
   * NOT THE DEAF-BAND CASE. While `returnIfWorse` is armed, a move made on network
   * figures is still waiting to be judged against what this receiver hears, and
   * `maybeReturnFromDeafBand` — which runs first, every window — owns that decision. It
   * needs four windows before it has a rate at all, so this stands down until then
   * rather than reaching a similar-looking conclusion from a different premise about our
   * own aerial.
   *
   * "NOTHING HERE" vs "NOTHING HERE FOR ME" — the deliberate decision. With
   * `auto.skipWorkedOnBandMode` on, or `auto.huntNewOnly`, a band packed with stations
   * this log has already worked produces exactly the same silence, and it FIRES ANYWAY.
   * The argument for staying is that those are real stations and the band is genuinely
   * open. The argument that wins is that an automatic operator exists to make contacts,
   * and a band it may call nobody on produces zero of them an hour whatever the reason.
   * Exempting the case would be worse than the fault it avoids: the operator's own dupe
   * setting would create a band the station could never leave, which is precisely the
   * observed fault with a different cause. What replaces the exemption is HONESTY IN THE
   * LOG — the reason line says whether nobody called at all, whether the guards refused
   * everybody, or whether nothing scored, so an operator can see when it is their own
   * filter talking. And the band is only marked poor for POOR_BAND_MS, so it is
   * reconsidered half an hour later, by which time both propagation and who is calling
   * have moved on.
   */
  private async maybeLeaveBandWithNobodyToCall(): Promise<boolean> {
    // Only the hunting modes have an opinion here. CQ mode calls nobody by design, and
    // chase mode's silence is about which frequency the dial is on. Cheap gates first:
    // the settings read below should not happen every window for a streak that has not
    // reached the bar.
    if (this.mode !== "hunt" && this.mode !== "hunt-pota") return false;
    if (this.hopping || this.warmup > 0) return false;
    if (this.hasWaitingCallers()) return false;
    if (this.o.controller.hasActive || this.startingCall) return false;
    if (this.returnIfWorse) return false;
    if (this.nobodyWindows < NOBODY_TO_CALL_WINDOWS) return false;

    const cfg = await this.o.bandHop();
    if (!cfg.enabled || cfg.bands.length === 0) return false;

    const { band: current, mode } = this.o.getBandMode();
    if (!current) return false;

    const verdict = bandHasNobodyToCall({
      here: {
        windowsWithNobody: this.nobodyWindows,
        cqsHeard: this.nobodyCqs.size,
        refused: this.nobodyRefused,
        windows: this.windowDecodes,
      },
      minWindows: NOBODY_TO_CALL_WINDOWS,
    });
    if (!verdict) return false;

    const left = await this.leaveBandFor(cfg, current, mode, verdict.reason);
    // Nowhere left to go, or the radio would not retune. Either way the evidence is
    // SPENT: without this the streak stays over the bar and the question is re-asked on
    // every window from now on, which puts a settings read — and, with hop-to-busiest
    // on, a band-activity lookup — behind every decode window for as long as the
    // station is stuck. Resetting asks again in another NOBODY_TO_CALL_WINDOWS, which
    // is also when the answer could next have changed.
    if (!left) this.resetNobodyStreak();
    return left;
  }

  /**
   * Fold one hunted window into the "nobody to call" streak.
   *
   * Called only from the hunt dispatch in `onWindow`, never from `huntPotaAudible` —
   * see the note there.
   */
  private noteHuntOutcome(outcome: HuntOutcome): void {
    if (outcome.callable) {
      this.resetNobodyStreak();
      return;
    }
    this.nobodyWindows++;
    this.nobodyRefused += outcome.refused;
    for (const call of outcome.cqs) {
      if (this.nobodyCqs.size >= NOBODY_CQ_TALLY_MAX) break;
      this.nobodyCqs.add(call);
    }
  }

  /** Somebody here was callable, or the band changed. The streak starts again. */
  private resetNobodyStreak(): void {
    this.nobodyWindows = 0;
    this.nobodyRefused = 0;
    this.nobodyCqs.clear();
  }

  /** Decodes per cycle on the band we are on, or null if too early to say. */
  private currentBandRate(): number | null {
    if (this.windowsOnBand < RATE_MIN_WINDOWS) return null;
    return this.decodesOnBand / this.windowsOnBand;
  }

  /**
   * Start counting again, filing what the band we are leaving actually gave us.
   *
   * Called on every band change, whatever caused it, so the record is of real
   * measured performance rather than of the reason for moving.
   */
  private resetBandCounters(leaving: string | null): void {
    const rate = this.currentBandRate();
    if (leaving && rate !== null) this.bandRate.set(leaving.toUpperCase(), rate);
    this.windowsOnBand = 0;
    this.decodesOnBand = 0;
    this.windowDecodes = [];
    this.madeOnBand = 0;
    this.lostOnBand = 0;
    this.lastProductivityCheck = Date.now();
    // A streak is a claim about ONE band. Carrying it across a hop would judge the new
    // band on windows spent listening to the old one.
    this.resetNobodyStreak();
  }

  /**
   * Go back, because the band the network recommended is deaf from here.
   *
   * The band-conditions figures are what the WHOLE PSKReporter network hears. They
   * are the best guide to where the activity is and they say nothing at all about
   * what one antenna in one place can hear — wrong time of day for the path, wrong
   * angle for the aerial, a local noise source. So a move made on those figures is
   * checked against decodes per cycle in this receiver, which is the only measure
   * that includes us.
   *
   * The band returned FROM is remembered as deaf for half an hour, or the same
   * figures would send the radio straight back every five minutes.
   */
  private async maybeReturnFromDeafBand(): Promise<boolean> {
    const back = this.returnIfWorse;
    if (!back) return false;

    const here = this.currentBandRate();
    // Not enough windows yet to judge. Leave the intent in place and decide later.
    if (here === null) return false;
    this.returnIfWorse = null;

    if (
      !shouldReturnToPreviousBand({
        hereRate: here,
        thereRate: back.rate,
        keepFraction: KEEP_BAND_FRACTION,
      })
    ) {
      return false;
    }

    const { band: current, mode } = this.o.getBandMode();
    if (current) this.poorBands.set(current.toUpperCase(), Date.now() + POOR_BAND_MS);

    this.o.log(
      `[auto] ${current ?? "?"} is hearing ${here.toFixed(1)} decodes a cycle against ` +
        `${back.rate.toFixed(1)} on ${back.band} — the network hears it, we do not. Going back.`,
    );
    if (!(await this.o.retune(back.band, mode))) {
      this.lastAction = `could not return to ${back.band}`;
      return false;
    }

    this.resetBandCounters(current);
    this.lastAction = `${current ?? "?"} was deaf here — back on ${back.band}`;
    // Settled, not hopping: this is a return to a band already known to work, so
    // there is nothing to re-judge when the warm-up ends.
    this.hopping = false;
    this.hopDecodeCount = 0;
    this.warmup = this.warmupWindows();
    this.cqParity = null;
    this.cqOffsetHz = null;
    this.cqedLastWindow = false;
    this.callbacks = [];
    return true;
  }

  /** Is the current pause the antenna refusing to load, rather than some other fault? */
  private isSwrFault(): boolean {
    return (
      this.o.guards.pauseCause === "fault" && /\bSWR\b/i.test(this.o.guards.pausedReason ?? "")
    );
  }

  /**
   * Record what the antenna did on this band, so a later SWR trip has somewhere to go.
   *
   * The guards only keep an SWR reading taken while actually transmitting, which is
   * the only time the figure means anything — so whatever is there belongs to the
   * band we are on now.
   */
  private noteBandSwr(): void {
    const { band } = this.o.getBandMode();
    const swr = this.o.guards.health.swr;
    if (band && swr !== null && swr > 0) this.bandSwr.set(band.toUpperCase(), swr);
  }

  /**
   * The antenna will not load here. Try a band where it will.
   *
   * Re-arming is safe ONLY because we have moved first: the fault was about this
   * band, and the new one is a genuinely different load. If nowhere is left to go,
   * this returns false and the station stays paused for a human — which is the right
   * answer for an antenna that is refusing everywhere, since that is a feedline or a
   * switch rather than a band.
   */
  private async hopAwayFromSwr(): Promise<boolean> {
    const cfg = await this.o.bandHop();
    if (!cfg.enabled || cfg.bands.length === 0) return false;
    if (this.o.controller.hasActive) return false;

    const { band: current, mode } = this.o.getBandMode();
    // Remember that THIS band failed before choosing, so it cannot be chosen again.
    const swrHere = this.o.guards.health.swr;
    if (current && swrHere !== null && swrHere > 0) {
      this.bandSwr.set(current.toUpperCase(), swrHere);
    }

    const target = pickBandForSwr({
      bands: cfg.bands,
      current,
      swrByBand: this.bandSwr,
      limit: this.o.guards.swrLimit,
    });
    if (!target) {
      this.o.log(
        `[auto] high SWR on ${current ?? "this band"} and no band left to try — staying paused`,
      );
      return false;
    }

    this.o.log(
      `[auto] SWR ${swrHere?.toFixed(1) ?? "?"}:1 on ${current ?? "?"} — trying ${target}`,
    );
    if (!(await this.o.retune(target, mode))) {
      this.lastAction = `could not move to ${target} after high SWR`;
      return false;
    }

    // Only now. A new band is a different load, so the reading that tripped the
    // guard no longer describes what the transmitter is about to key into.
    this.o.guards.rearm();
    this.returnIfWorse = null;
    this.resetBandCounters(current);
    this.lastAction = `high SWR on ${current ?? "?"} — moved to ${target}`;
    this.hopping = true;
    this.hopDecodeCount = 0;
    this.warmup = this.warmupWindows();
    this.cqParity = null;
    this.cqOffsetHz = null;
    this.cqedLastWindow = false;
    this.callbacks = [];
    const at = cfg.bands.indexOf(target);
    if (at >= 0) this.hopIndex = at;
    return true;
  }

  /** Guard paused us. If band-hopping is on, move; otherwise stay paused. */
  private async maybeHop(): Promise<void> {
    const cfg = await this.o.bandHop();
    if (!cfg.enabled || cfg.bands.length === 0 || this.o.controller.hasActive) return;
    await this.hopNext(cfg.bands);
  }

  /**
   * The band on the hop list the network sees the most stations on right now.
   *
   * Null when the feed is unavailable, when nothing on the list is being seen, or
   * when the only busy band is the one already tuned — every one of which means
   * "no better answer than rotating", and rotating is what the caller then does.
   *
   * Only bands from the configured list are ever considered: the list is the
   * operator's statement of what this antenna can actually work, and 6 m being alive
   * is no use to a station with no 6 m antenna.
   */
  private async busiestBand(bands: string[], current: string | null): Promise<string | null> {
    if (!this.o.bandActivity) return null;
    let activity: BandActivity[] | null;
    try {
      activity = await this.o.bandActivity();
    } catch {
      // A band-conditions lookup must never be able to stop the station operating.
      return null;
    }
    const best = pickBusiestBand(bands, current, activity);
    if (best) {
      const n = activity?.find((a) => a.band.toUpperCase() === best)?.transmitting ?? 0;
      this.o.log(`[auto] busiest band on the hop list: ${best} (${n} stations seen)`);
    }
    return best;
  }

  private async hopNext(bands?: string[]): Promise<void> {
    const hop = await this.o.bandHop();
    const cfg = bands ?? hop.bands;
    if (cfg.length === 0) return;

    const { band: current, mode } = this.o.getBandMode();

    // Busiest-first, when the operator asked for it and the network can answer.
    let target = hop.toBusiest ? await this.busiestBand(cfg, current) : null;
    if (target) {
      // Keep the rotation cursor with us, so a later fallback rotation carries on
      // from where we actually are rather than from wherever the cursor was left.
      const at = cfg.indexOf(target);
      if (at >= 0) this.hopIndex = at;
    } else {
      // Next band on the list that isn't the one we're on.
      for (let i = 0; i < cfg.length; i++) {
        this.hopIndex = (this.hopIndex + 1) % cfg.length;
        if (cfg[this.hopIndex] !== current) break;
      }
      target = cfg[this.hopIndex]!;
    }

    // A rotation hop is not a network-driven move, so there is nothing to come
    // back to — and any earlier intent belonged to a band we have now left twice.
    this.returnIfWorse = null;
    this.resetBandCounters(current);
    this.o.log(`[auto] band hop -> ${target}`);
    const ok = await this.o.retune(target, mode);
    if (!ok) {
      this.lastAction = `band hop to ${target} failed`;
      return;
    }
    this.lastAction = `hopped to ${target}, listening`;
    this.hopping = true;
    this.hopDecodeCount = 0;
    this.warmup = this.warmupWindows();
    this.cqParity = null;
    this.cqOffsetHz = null;
    // The outstanding CQ went out on the band we have just left.
    //
    // Without this it stays outstanding and the first window on the new band is counted
    // against it, so a band gets one window less than its share before being judged quiet.
    // Not the cause of anything observed — the first on-air hop chain was the deliberate
    // scan below doing its job — but a CQ belongs to the band it was sent on.
    this.cqedLastWindow = false;
    // rearmIfQuiet, not rearm: a band change is a response to a quiet band, and it
    // must not clear an SWR trip, a hot PA or a dead receiver. rearm() cleared all
    // of them — including lastSwr — so a fault hopped band and kept transmitting.
    this.o.guards.rearmIfQuiet();
  }

  private broadcastState(): void {
    this.o.broadcast({ kind: "auto", auto: this.state });
  }
}

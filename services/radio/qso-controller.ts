import { nowMs } from "@/lib/time/clock";
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

export class QsoController {
  private readonly o: QsoControllerOptions;
  private seq: QsoSequencer | null = null;
  /** Window parity (windowIndex % 2) we transmit on. */
  private txParity: 0 | 1 | null = null;
  private txOffsetHz = 1500;
  private lastSent: string | null = null;
  private seenWindows = new Set<number>();
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

  constructor(opts: QsoControllerOptions) {
    this.o = opts;

    // Both hooks matter: `decodes` fires for windows with signals, but the
    // window WE transmit in is silent on RX and only emits `window` — and the
    // repeat logic must still run after it.
    opts.source.on("decodes", ({ windowStart, decodes }) => {
      for (const d of decodes) {
        this.recordRx(d, windowStart.getTime());
        this.seq?.onDecode(d.message, windowStart.getTime());
      }
      this.afterWindow(windowStart.getTime());
    });
    opts.source.on("window", ({ windowStart, skipped }) => {
      if (skipped) this.afterWindow(windowStart.getTime());
    });
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
    if (wanted > MAX_TX_OFFSET_HZ) {
      return {
        ok: false,
        reason: `${req.theirCall} is at ${wanted} Hz, above the ${MAX_TX_OFFSET_HZ} Hz the transmitter can place audio at — decodable, not answerable`,
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
    this.txOffsetHz = Math.max(MIN_TX_OFFSET_HZ, Math.min(MAX_TX_OFFSET_HZ, wanted));

    this.seq = new QsoSequencer({
      myCall: this.o.identity.myCall,
      myGrid: this.o.identity.myGrid,
      theirCall: req.theirCall,
      theirGrid: req.theirGrid ?? null,
      theirSnr: req.theirSnr,
      role: "caller",
      startedAt: nowMs(),
    });
    this.activity = { sig: req.sig ?? null, sigInfo: req.sigInfo ?? null };
    this.transcript = [];
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
    this.lastSent = null;
    this.o.guards.operatorTouched();
    this.o.log(
      `[qso] calling ${req.theirCall} at ${this.txOffsetHz} Hz, our parity ${this.txParity}`,
    );
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
    this.txOffsetHz = Math.max(MIN_TX_OFFSET_HZ, Math.min(MAX_TX_OFFSET_HZ, Math.round(req.offsetHz)));
    this.seq = new QsoSequencer({
      myCall: this.o.identity.myCall,
      myGrid: this.o.identity.myGrid,
      theirCall: req.theirCall,
      theirGrid: req.theirGrid ?? null,
      theirSnr: req.theirSnr,
      role: "answerer",
      startedAt: nowMs(),
    });
    this.activity = { sig: req.sig ?? null, sigInfo: req.sigInfo ?? null };
    this.transcript = [];
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
    this.o.log(`[qso] answering ${req.theirCall} (they called us)`);
    this.broadcastState();
    return true;
  }

  /** Operator halt: stop the sequencer and force the transmitter down. */
  async halt(): Promise<void> {
    this.seq = null;
    this.txParity = null;
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
        .catch((err) => this.o.log(`[qso] TX error: ${(err as Error).message}`));
    }

    if (seq.isDone && this.seq === seq) {
      // Leave the record visible in state until the next call replaces it.
      this.txParity = null;
    }
    this.broadcastState();
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
    const p = parseMessage(d.message);
    const from =
      p.kind === "cq" ? p.from : p.kind === "directed" ? p.from : null;
    if (from !== seq.theirCall) return;
    // The message that opened the transcript arrives as a decode too when the call was
    // started from the window it decoded in. Recording it twice would read as the
    // station having repeated itself, which is a thing that happens and would then be
    // indistinguishable from this.
    const last = this.transcript.at(-1);
    if (last && last.dir === "rx" && last.at === at && last.message === d.message) return;
    this.record({
      at,
      dir: "rx",
      message: d.message,
      snr: d.snr,
      offsetHz: d.freqOffset,
    });
  }

  private broadcastState(): void {
    this.o.broadcast({ kind: "qso", qso: this.state });
  }
}

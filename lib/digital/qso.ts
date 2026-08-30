// FT8/FT4 QSO sequencing: message parsing, the standard message set, and the
// state machine that runs a contact — plus the operating guards that keep the
// automated modes polite and legal.
//
// Everything in this file is pure: no radio, no database, no clock of its own.
// Time comes in as arguments and side effects go out as return values, which is
// what makes the whole QSO flow testable offline the same way the transmit chain
// was — by the time this drives a transmitter, every path has already run.

export type QsoRole = "caller" | "answerer";

/** A decoded FT8/FT4 message, structurally understood. */
export type ParsedMessage =
  | {
      kind: "cq";
      from: string;
      grid: string | null;
      /** CQ modifier: DX, POTA, TEST, NA…, or null for a plain CQ. */
      modifier: string | null;
    }
  | {
      kind: "directed";
      to: string;
      from: string;
      payload: DirectedPayload;
    }
  | { kind: "other"; raw: string };

export type DirectedPayload =
  | { type: "grid"; grid: string }
  | { type: "report"; db: number }
  | { type: "rreport"; db: number }
  | { type: "rrr" }
  | { type: "rr73" }
  | { type: "73" };

const GRID_RE = /^[A-R]{2}\d{2}$/;
const REPORT_RE = /^([+-]\d{2})$/;
const R_REPORT_RE = /^R([+-]\d{2})$/;

/**
 * A callsign for sequencing purposes.
 *
 * Deliberately stricter than the logbook's callsign rule: automated modes should
 * not try to work hashed references (`<...>`) — the full call is unknown, so a
 * directed reply may not even be decodable by the other side.
 */
const CALL_RE = /^(?:[A-Z0-9]{1,4}\/)?[A-Z0-9]{1,8}(?:\/[A-Z0-9]{1,4})?$/;

function isCall(tok: string): boolean {
  return CALL_RE.test(tok) && /\d/.test(tok) && !GRID_RE.test(tok);
}

/**
 * A callsign, accepting the HASHED form that FT8 uses for long calls.
 *
 * FT8's 28-bit callsign field cannot hold every callsign, so once both ends have heard a
 * long one in full the protocol sends a 22-bit hash of it instead. WSJT-X renders that
 * hash back to the callsign in angle brackets — `<3D2USU>` — when it recognises it, and as
 * a bare `<...>` when it does not.
 *
 * The distinction is the whole reason this exists. The note on CALL_RE is right that an
 * automated mode must not try to work a reference whose call is unknown, but `<3D2USU>` is
 * not unknown: the decoder has already resolved it and is telling us what it is. Refusing
 * it cost a Fiji contact, which had to be recovered by hand.
 *
 * Returns the bare callsign, or null for a token that is neither.
 */
function unhash(tok: string): string | null {
  const m = /^<(.+)>$/.exec(tok);
  if (!m) return isCall(tok) ? tok : null;
  // "<...>" — the decoder saw a hash it could not resolve. Genuinely unknown, and
  // genuinely not workable.
  const inner = m[1]!;
  return isCall(inner) ? inner : null;
}

/**
 * Parse one decoded message into EVERY directed statement it carries.
 *
 * Usually one. A fox/hound transmission carries two:
 *
 *     K9XYZ RR73; DL2HIR <3D2USU> -20
 *
 * A DXpedition acknowledging one station and reporting to another in a single
 * transmission — that is a genuine RR73 to K9XYZ *and* a genuine report to DL2HIR, and the
 * single-value parse could represent neither, so it returned `other` and the sequencer
 * ignored it. The Fiji contact behind that had to be recovered by hand.
 *
 * Returning a list rather than picking a half is what makes it correct for both stations
 * at once: every caller already filters on "is this from my partner, addressed to me", so
 * each one finds its own half and ignores the other.
 *
 * The acknowledgement comes first, so `parseMessage` — which takes the head — keeps the
 * meaning that matters most to a station waiting on one.
 */
export function parseMessages(raw: string): ParsedMessage[] {
  const msg = raw.trim().toUpperCase().replace(/\s+/g, " ");

  // Fox/hound compound. The semicolon is the marker and it is not used for anything else
  // in the protocol, so its presence alone identifies the form.
  if (msg.includes(";")) {
    const out = compound(msg);
    if (out.length > 0) return out;
    // Not a form we know. Fall through rather than returning `other` here, so a message
    // that merely contains a semicolon is still parsed normally.
  }

  return [parseOne(msg)];
}

/**
 * The two halves of a fox/hound transmission: `<hound> RR73; <hound> <fox> <report>`.
 *
 * The fox's own callsign appears ONCE, in the right-hand half, and it is the sender of
 * both statements — the left half names only who is being acknowledged. So the left half
 * has to borrow the fox's call from the right, which is why this cannot be done by parsing
 * each side independently.
 *
 * Returns an empty list if it does not fit, so the caller can fall back.
 */
function compound(msg: string): ParsedMessage[] {
  const halves = msg.split(";");
  if (halves.length !== 2) return [];

  const lt = halves[0]!.trim().split(" ").filter(Boolean);
  const rt = halves[1]!.trim().split(" ").filter(Boolean);

  // Left: "<hound> RR73". RRR and 73 are accepted too — the form is documented with RR73
  // and that is what has been observed, but a fox closing with either is saying the same
  // thing and there is no reason to hear only one of them.
  if (lt.length !== 2) return [];
  const acked = unhash(lt[0]!);
  const closing = lt[1]!;
  if (!acked) return [];
  const payload: DirectedPayload | null =
    closing === "RR73"
      ? { type: "rr73" }
      : closing === "RRR"
        ? { type: "rrr" }
        : closing === "73"
          ? { type: "73" }
          : null;
  if (!payload) return [];

  // Right: "<hound> <fox> <report>". The fox is the middle token and is the sender of
  // both halves.
  if (rt.length !== 3) return [];
  const called = unhash(rt[0]!);
  const fox = unhash(rt[1]!);
  const report = rt[2]!;
  if (!fox) return [];

  const out: ParsedMessage[] = [{ kind: "directed", to: acked, from: fox, payload }];

  // The report half only exists if it IS a report. A malformed right-hand side must not
  // cost us the acknowledgement, which is the half that closes a contact.
  if (called && REPORT_RE.test(report)) {
    out.push({
      kind: "directed",
      to: called,
      from: fox,
      payload: { type: "report", db: Number(report) },
    });
  }
  return out;
}

/**
 * Parse one decoded message into its structural form.
 *
 * The head of `parseMessages`. Kept because most callers want exactly one answer and a
 * compound message is rare; anything that must not miss the second half — the QSO
 * sequencer above all — should call `parseMessages` instead.
 */
export function parseMessage(raw: string): ParsedMessage {
  return parseMessages(raw)[0]!;
}

function parseOne(msg: string): ParsedMessage {
  const tok = msg.split(" ");

  if (tok[0] === "CQ" && tok.length >= 2) {
    // "CQ K9XYZ EN61" or "CQ POTA K9XYZ EN61" — the modifier is any token
    // between CQ and the callsign (DX, POTA, TEST, a zone, a continent…).
    let i = 1;
    let modifier: string | null = null;
    if (tok.length >= 3 && !isCall(tok[1]!) && isCall(tok[2]!)) {
      modifier = tok[1]!;
      i = 2;
    }
    const from = tok[i];
    if (from && isCall(from)) {
      const g = tok[i + 1];
      return {
        kind: "cq",
        from,
        grid: g && GRID_RE.test(g) ? g : null,
        modifier,
      };
    }
    return { kind: "other", raw: msg };
  }

  // `unhash` rather than `isCall`: an ordinary directed message can carry a resolved hash
  // on either side once both ends have exchanged full calls — "K9XYZ <3D2USU> RR73".
  const toTok = tok[0] ? unhash(tok[0]) : null;
  const fromTok = tok[1] ? unhash(tok[1]) : null;
  if (tok.length >= 3 && toTok && fromTok) {
    const [to, from] = [toTok, fromTok];
    const p = tok[2]!;

    let payload: DirectedPayload | null = null;
    // RR73 before the grid test: it matches the grid pattern ([A-R]{2}\d{2}) by
    // design — the protocol picked a locator in the Arctic Ocean precisely so it
    // could be smuggled through the grid encoding. Parse order is therefore
    // significant, and grid must come last.
    if (p === "RR73") payload = { type: "rr73" };
    else if (p === "RRR") payload = { type: "rrr" };
    else if (p === "73") payload = { type: "73" };
    else if (REPORT_RE.test(p)) payload = { type: "report", db: Number(p) };
    else if (R_REPORT_RE.exec(p)) {
      payload = { type: "rreport", db: Number(p.slice(1)) };
    } else if (GRID_RE.test(p)) payload = { type: "grid", grid: p };

    if (payload) return { kind: "directed", to, from, payload };
  }

  return { kind: "other", raw: msg };
}

/** Format an SNR the way FT8 reports it: signed, two digits, clamped. */
export function formatReport(db: number): string {
  const clamped = Math.max(-50, Math.min(49, Math.round(db)));
  const sign = clamped < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(clamped)).padStart(2, "0")}`;
}

export interface StandardMessages {
  /** Tx1 — <them> <me> <grid> */
  tx1: string;
  /** Tx2 — <them> <me> <report> */
  tx2: string;
  /** Tx3 — <them> <me> R<report> */
  tx3: string;
  /** Tx4 — <them> <me> RR73 */
  tx4: string;
  /** Tx5 — <them> <me> 73 */
  tx5: string;
  /** Tx6 — CQ [modifier] <me> <grid> */
  tx6: string;
}

/** The WSJT-X standard message set, generated the same way its panel does. */
export function standardMessages(opts: {
  myCall: string;
  myGrid: string;
  theirCall: string;
  /** SNR we heard them at; used for Tx2/Tx3. */
  theirSnr: number;
  /** CQ modifier for Tx6 (e.g. "POTA"). */
  cqModifier?: string | null;
}): StandardMessages {
  const me = opts.myCall.toUpperCase();
  const them = opts.theirCall.toUpperCase();
  const grid4 = opts.myGrid.slice(0, 4).toUpperCase();
  const rpt = formatReport(opts.theirSnr);
  const mod = opts.cqModifier ? `${opts.cqModifier.toUpperCase()} ` : "";
  return {
    tx1: `${them} ${me} ${grid4}`,
    tx2: `${them} ${me} ${rpt}`,
    tx3: `${them} ${me} R${rpt}`,
    tx4: `${them} ${me} RR73`,
    tx5: `${them} ${me} 73`,
    tx6: `CQ ${mod}${me} ${grid4}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// The QSO state machine
// ---------------------------------------------------------------------------

export type QsoState =
  | "calling" //    caller: sending Tx1, waiting for their report
  | "report-sent" //  answerer: sending Tx2, waiting for R-report
  | "rreport-sent" // caller: sending Tx3, waiting for RR73
  | "rr73-sent" //   answerer: sending Tx4; their 73 is a courtesy
  | "complete"
  | "abandoned";

export interface QsoLogData {
  theirCall: string;
  theirGrid: string | null;
  /** Report we sent them (their signal at us). */
  reportSent: string;
  /** Report they gave us, when the exchange got that far. */
  reportRcvd: string | null;
  startedAt: number;
  completedAt: number;
}

export interface QsoTick {
  /** Message to transmit this window, or null to stay quiet. */
  send: string | null;
  state: QsoState;
  /** Set exactly once, when the QSO completes — this is the log entry. */
  log?: QsoLogData;
  /** Why the QSO was abandoned, when it was. */
  abandonReason?: string;
  /**
   * What was exchanged before it was abandoned, when reports went BOTH ways.
   *
   * Set alongside `abandonReason` and only then. It exists because discarding this loses a
   * contact the far station has: they heard our final roger, logged it, and asked for a card
   * months later — which is how thirteen of these were found, by reconciling QRZ card requests
   * against a log with no record of them.
   *
   * Absent when nothing was exchanged. "We called and nobody answered" is the overwhelming
   * majority of abandoned sequences and carries nothing worth keeping.
   */
  abandoned?: AbandonedExchange;
}

export interface AbandonedExchange {
  theirCall: string;
  theirGrid: string | null;
  /** The report we sent them. */
  reportSent: string;
  /** The report they sent us — always present, or this is not reported at all. */
  reportRcvd: string;
  /** How far the sequence got, which is what makes it interesting. */
  stage: QsoState;
  startedAt: number;
  endedAt: number;
}

export interface QsoOptions {
  myCall: string;
  myGrid: string;
  theirCall: string;
  theirGrid?: string | null;
  /** SNR we heard them at — becomes the report we send. */
  theirSnr: number;
  role: QsoRole;
  /**
   * Give up after re-sending the same message this many times with no reply.
   * FT8 etiquette: nobody wants to hear the same Tx3 for five minutes.
   */
  maxRepeats?: number;
  startedAt?: number;
}

/**
 * One QSO, from first call to logged contact.
 *
 * The driver calls `tick()` once per transmit window (it returns what to send)
 * and `onDecode()` for every decode that arrives in receive windows. The machine
 * never transmits on its own — it only answers the question "what would a
 * competent operator send right now?"
 */
export class QsoSequencer {
  readonly theirCall: string;
  private readonly o: Required<Omit<QsoOptions, "theirGrid">> & {
    theirGrid: string | null;
  };

  private state: QsoState;
  private theirGrid: string | null;
  private reportRcvd: string | null = null;
  private repeats = 0;
  private lastSent: string | null = null;
  private logged = false;

  constructor(opts: QsoOptions) {
    this.o = {
      ...opts,
      theirGrid: opts.theirGrid ?? null,
      maxRepeats: opts.maxRepeats ?? 4,
      startedAt: opts.startedAt ?? 0,
    };
    this.theirCall = opts.theirCall.toUpperCase();
    this.theirGrid = this.o.theirGrid;
    // A caller opens with Tx1; an answerer heard Tx1 already (or answers a call
    // to their CQ) and opens with the report.
    this.state = opts.role === "caller" ? "calling" : "report-sent";
  }

  get currentState(): QsoState {
    return this.state;
  }

  get isDone(): boolean {
    return this.state === "complete" || this.state === "abandoned";
  }

  private get msgs(): StandardMessages {
    return standardMessages({
      myCall: this.o.myCall,
      myGrid: this.o.myGrid,
      theirCall: this.theirCall,
      theirSnr: this.o.theirSnr,
    });
  }

  /**
   * Feed one decode. Only messages directed at us from our partner move the
   * machine; everything else is ignored (but a grid from their CQ is captured).
   */
  onDecode(raw: string, at: number): void {
    if (this.isDone) return;
    // Every statement in the transmission, not just the first. A fox/hound message carries
    // two — "K9XYZ RR73; DL2HIR <3D2USU> -20" acknowledges one station and reports to
    // another — and ours can be either half.
    for (const p of parseMessages(raw)) {
      this.applyOne(p, at);
      if (this.isDone) return;
    }
  }

  private applyOne(p: ParsedMessage, at: number): void {
    if (p.kind === "cq" && p.from === this.theirCall && p.grid) {
      this.theirGrid = this.theirGrid ?? p.grid;
      return;
    }
    if (p.kind !== "directed") return;
    if (p.from !== this.theirCall) return;
    if (p.to !== this.o.myCall.toUpperCase()) return;

    // Any on-topic reply resets the repeat counter — the path is alive.
    this.repeats = 0;

    switch (p.payload.type) {
      case "grid":
        this.theirGrid = p.payload.grid;
        break;
      case "report":
        this.reportRcvd = formatReport(p.payload.db);
        if (this.state === "calling") this.state = "rreport-sent";
        break;
      case "rreport":
        this.reportRcvd = formatReport(p.payload.db);
        if (this.state === "report-sent") this.state = "rr73-sent";
        break;
      // THREE MESSAGES CLOSE A CONTACT: RRR, RR73 and a bare 73.
      //
      // They are not interchangeable in what they OWE — an RRR or RR73 confirms our
      // report and leaves us to sign off, while a 73 has already signed off — but any of
      // the three, arriving once reports have crossed, means the far station considers
      // the contact made. Treating any of them as silence loses a QSO both operators have
      // logged.
      //
      // Measured against the live decode log: of 142 incomplete exchanges, eleven had an
      // acknowledgement addressed to us that we did not act on, including
      //
      //     K9XYZ EA3ISZ 73     K9XYZ KN6RK RRR     K9XYZ KI7OXA RRR
      //
      // because each token was accepted from only one side of the sequence.
      case "rrr":
      case "rr73":
        // Confirming our R-report (we were the caller), or confirming our RR73 with an
        // RRR instead of the 73 the old code insisted on (we were the answerer).
        if (
          this.state === "rreport-sent" ||
          this.state === "calling" ||
          this.state === "rr73-sent"
        ) {
          // Only the caller still owes a sign-off. An answerer in `rr73-sent` has already
          // sent RR73, so another transmission would burn a cycle on a finished contact.
          this.completeAt(at, this.state === "rr73-sent");
        }
        break;
      case "73":
        // A 73 closes from either side, and never leaves anything owed: they have signed
        // off, so answering with a second 73 is a wasted cycle.
        //
        // This used to complete only from `rr73-sent`. As the CALLER, in `rreport-sent`,
        // a plain 73 was ignored and the exchange was abandoned a minute later as
        // unacknowledged — three of the eleven above. Not every operator sends RR73, and
        // some software closes with 73 by default.
        if (this.state === "rr73-sent" || this.state === "rreport-sent") {
          this.completeAt(at, true);
        }
        break;
    }
  }

  /**
   * `closedWith73` means THEY signed off, not merely confirmed.
   *
   * The distinction decides whether we owe a courtesy 73. It used to be inferred from the
   * state alone — `calling` or `rreport-sent` meant we were mid-sequence and therefore
   * owed one — and that inference was safe only while a bare 73 could not reach those
   * states. Now that it can (see the `73` case above), the state no longer tells the two
   * apart: an RR73 in `rreport-sent` leaves us owing a sign-off, and a 73 in the same
   * state does not, because both operators have already said it.
   */
  private completeAt(at: number, closedWith73 = false): void {
    if (this.state !== "complete") {
      // A courtesy 73 is owed only when THEY closed with RR73/RRR and we were still
      // mid-sequence. When their 73 closes it, both sides have signed off and one more
      // transmission would just burn a cycle on a finished contact.
      this.owes73 =
        !closedWith73 && (this.state === "calling" || this.state === "rreport-sent");
      this.state = "complete";
      this.completedAtMs = at;
    }
  }
  private completedAtMs = 0;
  private owes73 = false;

  /**
   * What to transmit this window.
   *
   * `at` is the window start (UTC ms). The same message being returned again
   * counts as a repeat; too many repeats abandons the QSO rather than calling
   * into the void forever.
   */
  tick(at: number): QsoTick {
    if (this.state === "abandoned") {
      return { send: null, state: this.state };
    }

    if (this.state === "complete") {
      // One courtesy 73 if we completed off their RR73, then silence. The log
      // entry is produced exactly once.
      const tickResult: QsoTick = { send: null, state: this.state };
      if (!this.logged) {
        this.logged = true;
        tickResult.send =
          this.owes73 && this.lastSent !== this.msgs.tx5 ? this.msgs.tx5 : null;
        tickResult.log = {
          theirCall: this.theirCall,
          theirGrid: this.theirGrid,
          reportSent: formatReport(this.o.theirSnr),
          reportRcvd: this.reportRcvd,
          startedAt: this.o.startedAt,
          completedAt: this.completedAtMs || at,
        };
      }
      return tickResult;
    }

    const next =
      this.state === "calling"
        ? this.msgs.tx1
        : this.state === "report-sent"
          ? this.msgs.tx2
          : this.state === "rreport-sent"
            ? this.msgs.tx3
            : this.msgs.tx4; // rr73-sent

    if (next === this.lastSent) {
      this.repeats++;
      if (this.repeats >= this.o.maxRepeats) {
        // rr73-sent is special: WE consider the QSO good (they roger'd our
        // report); only their courtesy 73 is missing. Log it rather than
        // throwing away a valid contact — this is what WSJT-X does too.
        if (this.state === "rr73-sent") {
          this.completeAt(at);
          return this.tick(at);
        }
        this.state = "abandoned";
        const abandonReason = `No reply after ${this.repeats} repeats of "${next}"`;
        // REPORTS WENT BOTH WAYS, so this is worth keeping rather than discarding.
        //
        // `reportRcvd` is only set once they have given us a report, which as the caller means
        // we reached `rreport-sent` — we rogered their report and waited for an RR73 that never
        // decoded. The far station heard that roger and logged the contact; thirteen of these
        // were found months later by reconciling QRZ card requests against a log that had no
        // record of them, and the only surviving trace was a decode row with a null qsoId.
        //
        // NOT logged as a QSO here. "We sent the final roger and heard nothing" fits both a
        // contact they kept and one they gave up on too, and only the operator can judge which
        // — see IncompleteExchange. The case above is different and does log: there we sent the
        // RR73, so the exchange was complete from our side and only their courtesy 73 is
        // missing.
        if (this.reportRcvd) {
          return {
            send: null,
            state: this.state,
            abandonReason,
            abandoned: {
              theirCall: this.theirCall,
              theirGrid: this.theirGrid,
              reportSent: formatReport(this.o.theirSnr),
              reportRcvd: this.reportRcvd,
              stage: "rreport-sent",
              startedAt: this.o.startedAt,
              endedAt: at,
            },
          };
        }
        return { send: null, state: this.state, abandonReason };
      }
    }
    this.lastSent = next;

    return { send: next, state: this.state };
  }
}

// ---------------------------------------------------------------------------
// Operating guards — the safeties for automated operation
// ---------------------------------------------------------------------------

/**
 * Is a limit switched on?
 *
 * Zero — and anything not a positive finite number — means "no limit". This has to be
 * uniform, and it was not: `maxRunMinutes` already tested `> 0`, but `maxConsecutiveTx`
 * did not, so setting that one to zero to disable it would have tripped the guard on the
 * very first transmission — the exact opposite of switching it off.
 *
 * The settings UI writes 0 when a limit's checkbox is cleared, so every guard has to
 * agree on what that means.
 */
export function limitOn(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

/**
 * The two checks that need to reach outside the guard object.
 *
 * Passed per call rather than held on the guards, because both are backed by the database
 * and the guards are a pure, testable thing that must not grow a Prisma import.
 *
 * Both are async, and the do-not-call side is cheap anyway — it reads a Set cached on a
 * short TTL, so the await is a memory hit in the ordinary case and a single small query at
 * worst. Resolving it per attempt rather than capturing it is what makes an entry added
 * mid-run take effect on the next call.
 */
export interface MayCallChecks {
  /**
   * What the do-not-call list says about this callsign: "NEVER", "NO_DUPES", or null.
   *
   * Two kinds because people make two different requests. Returning a bare boolean forced
   * every entry to mean "never call them", which is the stronger request and the wrong one
   * for the operator who prompted the list — he asked not to be worked TWICE on a band and
   * mode and said he would welcome anything else.
   */
  listedAs?: (call: string) => Promise<"NEVER" | "NO_DUPES" | null>;
  /** Have we ever worked them on this band, any mode? */
  workedOnBandEver?: (call: string, band: string) => Promise<boolean>;
}

export interface GuardConfig {
  /** Give up calling a station that never answers after this many calls. */
  maxCallAttempts: number;
  /** Do not re-call a station for this long after giving up on them. */
  failureCooldownMs: number;
  /** Skip stations already worked within this window on the same band+mode. */
  dupeWindowMs: number;
  /**
   * Never re-work the same station on the same BAND AND MODE, however long ago.
   *
   * DEFAULTS TO TRUE, and it is the only guard here that does so on the strength of a
   * complaint from the other end. K1XYZ wrote in twice — "I see we have worked on the same
   * band & same mode several times. There is no point in duplicate contacts", and then
   * "You have made another duplicate contact. Please refrain." The log agreed: seventeen
   * contacts with him, eight of them on 20 m FT8, seven of those inside a fortnight. And
   * he was not singular — 2,673 band+mode slots in that log had been worked more than
   * once, one station nineteen times.
   *
   * The cause was `dupeWindowMs` alone, which asks only whether the contact was RECENT.
   * At its 24-hour default the same station on the same band and mode became fair game
   * again the next day, and then every day after that. A window is the right shape for
   * "not twice in one session" and the wrong shape entirely for "not twice, ever".
   *
   * This is what Lee actually asked for, and it is narrower than it could have been on
   * purpose: he went on to say "Feel free to make another contact with me if it is not a
   * duplicate. I would rather work a new station or someone I've worked before on a
   * different band/mode." So the rule is band AND mode — a different mode on the same band
   * is a new slot and stays allowed — and he is deliberately NOT on the do-not-call list,
   * because putting him there would honour more than he asked and cost him contacts he
   * said he wants.
   */
  skipWorkedOnBandModeEver: boolean;
  /**
   * Never call a station already worked on THIS BAND, however long ago and whatever mode.
   *
   * A different question from `dupeWindowMs`, which asks "have we worked them recently on
   * this band AND mode" and exists to stop the same contact repeating inside a session.
   * This asks "do we already have this band" — the band-slot question an award chaser
   * actually operates by. Asked for as "an ignore list that checks to see if i have made a
   * contact with said person on that band before and not make contact if we already have".
   *
   * Mode-agnostic on purpose: a band slot is a band slot, and somebody worked on 20 m FT4
   * is not a new 20 m contact because today it is FT8.
   *
   * Off by default. On a quiet band an operator usually wants contacts rather than only
   * new ones, and turning this on for a station with 26,000 QSOs silences a great deal of
   * a domestic band.
   */
  skipWorkedOnBandEver: boolean;
  /** Stop auto-CQ after this many consecutive unanswered CQs. */
  maxUnansweredCqs: number;
  /**
   * Hard brake: this many consecutive transmit windows without operator input
   * pauses all automatic transmission until re-armed.
   */
  maxConsecutiveTx: number;
  /**
   * If this many consecutive receive windows decode nothing AND carry no audio,
   * we are deaf (dead audio path, wrong slice, antenna fault). A station that
   * cannot hear must not transmit.
   */
  deafWindowLimit: number;
  /**
   * Stop transmitting above this SWR. High SWR unattended means a damaged or
   * disconnected antenna, and continuing risks the PA — this is the one guard
   * about protecting hardware rather than manners.
   */
  maxSwr: number;
  /** Stop transmitting above this PA temperature, degrees C. */
  maxPaTempC: number;
  /**
   * Wall-clock ceiling on one automatic run, minutes. 0 disables it.
   *
   * The only guard that bounds automatic operation in TIME. Every other brake
   * counts events, and all of them reset: `maxConsecutiveTx` is zeroed by any
   * completed QSO and by any operator interaction, so a station that keeps making
   * contacts can transmit indefinitely. WSJT-X has had a watchdog for fifteen
   * years for exactly this reason.
   */
  maxRunMinutes: number;
  /** Ceiling on QSOs in one automatic run. 0 disables it. */
  maxQsosPerRun: number;
}

export const DEFAULT_GUARDS: GuardConfig = {
  maxCallAttempts: 5,
  failureCooldownMs: 30 * 60_000,
  dupeWindowMs: 24 * 60 * 60_000,
  // OFF. Duplicates are prevented per callsign, from the list — see the note in mayCall.
  // This switch imposes one operator's preference on every station worked, which is the
  // operator's decision to make and not a default to inherit.
  skipWorkedOnBandModeEver: false,
  skipWorkedOnBandEver: false,
  maxUnansweredCqs: 15,
  maxConsecutiveTx: 20,
  deafWindowLimit: 4,
  // 3:1 is where a Flex folds back power anyway; past it something is wrong.
  maxSwr: 3,
  maxPaTempC: 75,
  // Four hours and 100 QSOs. Generous for a deliberate session, and still a
  // bound — the point is that "indefinitely" stops being an option.
  maxRunMinutes: 240,
  maxQsosPerRun: 100,
};

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * The judgement layer over the sequencer: everything here is about not being a
 * nuisance (or a violation) when nobody is watching the screen.
 *
 * Dupe checking takes a caller-supplied lookup so this stays pure — the radio
 * service passes a closure over the Qso table.
 */
export class OperatingGuards {
  private readonly cfg: GuardConfig;

  /** The thresholds in force, for display and for logging at start-up. */
  get config(): GuardConfig {
    return this.cfg;
  }
  /** call -> { attempts, lastGaveUpAt } for stations we tried and failed. */
  private readonly failed = new Map<string, number>();
  private consecutiveTx = 0;
  private unansweredCqs = 0;
  private deafWindows = 0;
  /**
   * Why automatic TX is paused, and WHAT KIND of pause it is.
   *
   * The cause is what makes the difference between "this band is quiet, try
   * another" and "the antenna is broken, stop". It used to be a bare string, so
   * nothing downstream could tell them apart — and the auto-operator band-hopped on
   * ANY pause, calling rearm() as it went, which cleared a high-SWR trip and kept
   * keying on the next band.
   *
   *   fault    — the radio or the station is in a bad state. SWR, PA temperature,
   *              a dead receiver. Changing band does not fix any of these.
   *   quiet    — nobody is answering. A different band is a reasonable response.
   *   runaway  — we have transmitted a lot without a human. Needs a human, not a
   *              band change.
   */
  private paused: { reason: string; cause: "fault" | "quiet" | "runaway" } | null = null;
  private lastSwr: number | null = null;
  /** When the current automatic run began, for the wall-clock watchdog. */
  private runStartedAt: number | null = null;
  private qsosThisRun = 0;
  private lastPaTempC: number | null = null;

  constructor(cfg?: Partial<GuardConfig>) {
    this.cfg = { ...DEFAULT_GUARDS, ...cfg };
  }

  /** Why automatic TX is paused, or null when it is allowed. */
  get pausedReason(): string | null {
    return this.paused?.reason ?? null;
  }

  /**
   * What kind of pause this is, for callers deciding how to respond.
   *
   * A band-hop is only ever a sane answer to "quiet". Anything else needs the
   * operator.
   */
  get pauseCause(): "fault" | "quiet" | "runaway" | null {
    return this.paused?.cause ?? null;
  }

  /**
   * Operator re-arm: clears the brakes but not the per-station cooldowns.
   *
   * Also clears the last SWR reading — otherwise a single bad reading would
   * re-pause instantly on the next telemetry frame and re-arm would appear
   * broken. A genuinely bad antenna trips it again on the next transmission,
   * which is the correct behaviour.
   */
  rearm(): void {
    this.paused = null;
    this.consecutiveTx = 0;
    this.unansweredCqs = 0;
    this.deafWindows = 0;
    this.lastSwr = null;
    this.runStartedAt = Date.now();
    this.qsosThisRun = 0;
  }

  /**
   * Clear only a QUIET pause, leaving faults and runaways in place.
   *
   * This is what band-hopping needs. It used to call `rearm()`, which cleared
   * everything including `lastSwr` — so a high-SWR trip hopped to the next band and
   * carried on transmitting into a suspect antenna. Changing band does not repair
   * an antenna, cool a PA, or substitute for a human.
   */
  rearmIfQuiet(): boolean {
    if (this.paused && this.paused.cause !== "quiet") return false;
    this.paused = null;
    this.unansweredCqs = 0;
    this.deafWindows = 0;
    return true;
  }

  /**
   * Start the wall-clock run, or CONTINUE an earlier one.
   *
   * `startedAt` exists for an automatic resume after a radio reconnect. Resetting
   * the clock there would let a flapping radio extend an unattended session without
   * limit — each outage would hand it a fresh four hours. Carrying the original
   * start forward means the watchdog still bounds the whole session.
   */
  beginRun(startedAt?: number, qsosSoFar = 0): void {
    this.runStartedAt = startedAt ?? Date.now();
    this.qsosThisRun = qsosSoFar;
  }

  /** How long the current run has been going, and how many QSOs it has made. */
  get runState(): { minutes: number | null; qsos: number } {
    return {
      minutes: this.runStartedAt === null ? null : (Date.now() - this.runStartedAt) / 60_000,
      qsos: this.qsosThisRun,
    };
  }

  /**
   * The wall-clock and QSO-count watchdog.
   *
   * Checked before every transmission. Unlike the other brakes this one cannot be
   * reset by making progress — that is the entire point.
   */
  private checkRunLimits(): void {
    if (this.paused) return;
    if (limitOn(this.cfg.maxRunMinutes) && this.runStartedAt !== null) {
      const mins = (Date.now() - this.runStartedAt) / 60_000;
      if (mins >= this.cfg.maxRunMinutes) {
        this.paused = {
          cause: "runaway",
          reason: `Automatic operation has run for ${Math.round(mins)} minutes (limit ${this.cfg.maxRunMinutes}) — stopping until re-armed`,
        };
        return;
      }
    }
    if (limitOn(this.cfg.maxQsosPerRun) && this.qsosThisRun >= this.cfg.maxQsosPerRun) {
      this.paused = {
        cause: "runaway",
        reason: `Made ${this.qsosThisRun} QSOs this run (limit ${this.cfg.maxQsosPerRun}) — stopping until re-armed`,
      };
    }
  }

  /**
   * May we start (or continue trying to start) a QSO with this station?
   *
   * `wasWorked` answers "is there a logged QSO with this call on this band and
   * mode since `sinceMs`?" — the database closure.
   */
  async mayCall(
    call: string,
    band: string,
    mode: string,
    now: number,
    wasWorked: (call: string, band: string, mode: string, sinceMs: number) => Promise<boolean>,
    extra: MayCallChecks = {},
  ): Promise<GuardDecision> {
    // THE DO-NOT-CALL LIST COMES FIRST, before the pause check and before anything that
    // could be relaxed by configuration.
    //
    // Every other guard here protects the station — its finals, its manners, its operator's
    // time — and every one of them is a number somebody may reasonably turn up. This one
    // protects a third party who asked to be left alone, and it is the only check in this
    // file that is about somebody else's wishes rather than our own. It is therefore not
    // conditional on a setting, not subject to a cooldown, and not something a wider dupe
    // window can talk round.
    //
    // Ordered before `this.paused` deliberately: the reason must say the list, because
    // "paused" would send an operator hunting a fault that does not exist.
    const listed = extra.listedAs ? await extra.listedAs(call) : null;
    if (listed === "NEVER") {
      return {
        allowed: false,
        reason: `${call.toUpperCase()} is on the do-not-call list`,
      };
    }

    if (this.paused) return { allowed: false, reason: this.paused.reason };

    const gaveUpAt = this.failed.get(call.toUpperCase());
    if (gaveUpAt !== undefined && now - gaveUpAt < this.cfg.failureCooldownMs) {
      const mins = Math.ceil((this.cfg.failureCooldownMs - (now - gaveUpAt)) / 60_000);
      return {
        allowed: false,
        reason: `Gave up on ${call} recently — cooling down another ${mins} min`,
      };
    }

    if (await wasWorked(call, band, mode, now - this.cfg.dupeWindowMs)) {
      return {
        allowed: false,
        reason: `${call} already worked on ${band} ${mode} within the dupe window`,
      };
    }

    // The same band AND mode, ever. Reuses `wasWorked` with a zero epoch rather than
    // taking a new dependency: "worked since the beginning of time" is exactly the
    // question, and the [callsign, band, mode] index already serves it.
    // PER CALLSIGN FIRST, then the station-wide switch.
    //
    // 1.83.0 shipped this as a station-wide default, on the strength of one operator's
    // complaint and 2,673 duplicate slots in the log. That was the wrong shape: "I don't
    // want the rule on everyone, just a list of people." One person asking not to be
    // duplicated is a fact about that person, and imposing their preference on every
    // station worked is a different decision that belongs to the operator.
    //
    // So the list is the normal route and the switch is available for anyone who does want
    // it everywhere. Either path gives the same answer for a listed station, which is why
    // they share one check.
    if (listed === "NO_DUPES" || this.cfg.skipWorkedOnBandModeEver) {
      if (await wasWorked(call, band, mode, 0)) {
        return {
          allowed: false,
          reason:
            listed === "NO_DUPES"
              ? `${call} asked for no duplicates — already worked on ${band} ${mode}`
              : `${call} already worked on ${band} ${mode} — a duplicate contact`,
        };
      }
    }

    // The band slot, if the operator is chasing them. Mode-agnostic and unbounded in
    // time, which is what makes it a different question from the dupe window above.
    if (this.cfg.skipWorkedOnBandEver && extra.workedOnBandEver) {
      if (await extra.workedOnBandEver(call, band)) {
        return {
          allowed: false,
          reason: `${call} already worked on ${band} — already have that band`,
        };
      }
    }

    return { allowed: true };
  }

  /** Record that we gave up on a station (starts their cooldown). */
  recordFailure(call: string, now: number): void {
    this.failed.set(call.toUpperCase(), now);
  }

  /** Record a completed QSO — clears any failure state for that call. */
  recordSuccess(call: string): void {
    this.failed.delete(call.toUpperCase());
  }

  /**
   * Called before every automatic transmission. Counts toward the runaway
   * brake; returns whether transmitting is still allowed.
   */
  beforeTx(): GuardDecision {
    this.checkRunLimits();
    if (this.paused) return { allowed: false, reason: this.paused.reason };
    if (limitOn(this.cfg.deafWindowLimit) && this.deafWindows >= this.cfg.deafWindowLimit) {
      this.paused = {
        cause: "fault",
        reason: `Heard nothing for ${this.deafWindows} receive windows — receiver may be dead, refusing to transmit blind`,
      };
      return { allowed: false, reason: this.paused.reason };
    }
    this.consecutiveTx++;
    if (limitOn(this.cfg.maxConsecutiveTx) && this.consecutiveTx > this.cfg.maxConsecutiveTx) {
      this.paused = {
        cause: "runaway",
        reason: `Sent ${this.consecutiveTx - 1} transmissions without operator input — pausing until re-armed`,
      };
      return { allowed: false, reason: this.paused.reason };
    }
    return { allowed: true };
  }

  /** Any operator interaction resets the runaway brake. */
  operatorTouched(): void {
    this.consecutiveTx = 0;
  }

  /**
   * Feed radio health in. SWR is only read while transmitting — the meter is
   * meaningless on receive, and a stale reading must not trip the guard.
   */
  onTelemetry(t: { swr: number | null; paTempC: number | null; transmitting: boolean }): void {
    if (t.transmitting && t.swr !== null && t.swr > 0) this.lastSwr = t.swr;
    if (t.paTempC !== null) this.lastPaTempC = t.paTempC;

    if (limitOn(this.cfg.maxSwr) && this.lastSwr !== null && this.lastSwr > this.cfg.maxSwr) {
      this.paused = {
        cause: "fault",
        reason: `SWR ${this.lastSwr.toFixed(1)}:1 exceeds ${this.cfg.maxSwr}:1 — check the antenna before transmitting again`,
      };
    }
    if (limitOn(this.cfg.maxPaTempC) && this.lastPaTempC !== null && this.lastPaTempC > this.cfg.maxPaTempC) {
      this.paused = {
        cause: "fault",
        reason: `PA temperature ${this.lastPaTempC.toFixed(0)}°C over ${this.cfg.maxPaTempC}°C — letting it cool`,
      };
    }
  }

  /** Latest health readings, for display. */
  get health(): { swr: number | null; paTempC: number | null } {
    return { swr: this.lastSwr, paTempC: this.lastPaTempC };
  }

  /**
   * The SWR that trips a fault, so callers can judge a band against the same bar.
   *
   * Exposed because band-aware SWR handling has to ask "would this OTHER band also
   * trip it?" — and inferring the limit by parsing it back out of the pause reason
   * would break the moment that wording changed.
   */
  get swrLimit(): number {
    return this.cfg.maxSwr;
  }

  /**
   * Called after every receive window with what it produced. Feeds the deaf
   * guard and the unanswered-CQ counter.
   */
  afterRxWindow(opts: { decodes: number; silent: boolean; answeredUs: boolean; wasCqing: boolean }): void {
    if (opts.decodes === 0 && opts.silent) this.deafWindows++;
    else this.deafWindows = 0;

    if (opts.wasCqing) {
      if (opts.answeredUs) this.unansweredCqs = 0;
      else {
        this.unansweredCqs++;
        if (limitOn(this.cfg.maxUnansweredCqs) && this.unansweredCqs >= this.cfg.maxUnansweredCqs) {
          this.paused = {
            cause: "quiet",
            reason: `${this.unansweredCqs} CQs with no answer — stopping (band may be dead)`,
          };
        }
      }
    }
  }

  /** A completed exchange also proves we are not transmitting into the void. */
  qsoCompleted(call: string): void {
    this.recordSuccess(call);
    this.consecutiveTx = 0;
    // Counted, and NOT reset by anything short of a re-arm. Zeroing
    // consecutiveTx here is why the event brakes alone can never bound a session:
    // a run of successful QSOs keeps clearing them.
    this.qsosThisRun++;
  }
}

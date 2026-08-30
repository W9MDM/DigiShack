/* eslint-disable no-console */
// Offline checks for the QSO engine: message parsing, the standard message set,
// full QSO sequences in both roles, and every operating guard.
//
// Same philosophy as check-tx.ts: by the time this logic keys a transmitter,
// every path has already run.

import {
  DEFAULT_GUARDS,
  OperatingGuards,
  QsoSequencer,
  formatReport,
  parseMessage,
  parseMessages,
  standardMessages,
} from "@/lib/digital/qso";
import { MAX_TX_OFFSET_HZ, resolveMaxTxOffset } from "@/services/radio/qso-controller";

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

async function main(): Promise<void> {
  console.log("\nmessage parsing");
  {
    eq(
      parseMessage("CQ K9XYZ EN61"),
      { kind: "cq", from: "K9XYZ", grid: "EN61", modifier: null },
      "plain CQ with grid",
    );
    eq(
      parseMessage("CQ POTA K9XYZ EN61"),
      { kind: "cq", from: "K9XYZ", grid: "EN61", modifier: "POTA" },
      "CQ POTA",
    );
    eq(
      parseMessage("CQ DX K1DEF"),
      { kind: "cq", from: "K1DEF", grid: null, modifier: "DX" },
      "CQ DX without grid",
    );
    eq(
      parseMessage("K9XYZ K1DEF DM33"),
      { kind: "directed", to: "K9XYZ", from: "K1DEF", payload: { type: "grid", grid: "DM33" } },
      "directed grid",
    );
    eq(
      parseMessage("K9XYZ K1DEF -14"),
      { kind: "directed", to: "K9XYZ", from: "K1DEF", payload: { type: "report", db: -14 } },
      "directed report",
    );
    eq(
      parseMessage("K9XYZ K1DEF R+03"),
      { kind: "directed", to: "K9XYZ", from: "K1DEF", payload: { type: "rreport", db: 3 } },
      "directed R-report",
    );
    eq(
      parseMessage("K9XYZ K1DEF RR73"),
      { kind: "directed", to: "K9XYZ", from: "K1DEF", payload: { type: "rr73" } },
      "RR73",
    );
    eq(
      parseMessage("K9XYZ K1DEF 73"),
      { kind: "directed", to: "K9XYZ", from: "K1DEF", payload: { type: "73" } },
      "73",
    );
    ok(parseMessage("<...> K1DEF RR73").kind === "other", "hashed calls are not sequenced");
    ok(parseMessage("TNX QSO GL 73").kind === "other", "free text is other");
    ok(parseMessage("CQ TEST").kind === "other", "CQ with no callsign is other");
    // A compound call still parses.
    const c = parseMessage("CQ VP2E/K9XYZ EN61");
    ok(c.kind === "cq" && c.from === "VP2E/K9XYZ", "compound call in CQ");
  }

  console.log("\nreports");
  {
    eq(formatReport(-14.4), "-14", "negative rounds");
    eq(formatReport(3), "+03", "positive zero-pads");
    eq(formatReport(0), "+00", "zero is +00");
    eq(formatReport(-3.6), "-04", "round half away");
    eq(formatReport(99), "+49", "clamped high");
  }

  console.log("\nstandard message set (the WSJT-X Tx1–Tx6 panel)");
  {
    const m = standardMessages({
      myCall: "K9XYZ",
      myGrid: "EN61jj",
      theirCall: "AA1ABC",
      theirSnr: -18,
    });
    eq(m.tx1, "AA1ABC K9XYZ EN61", "Tx1");
    eq(m.tx2, "AA1ABC K9XYZ -18", "Tx2");
    eq(m.tx3, "AA1ABC K9XYZ R-18", "Tx3");
    eq(m.tx4, "AA1ABC K9XYZ RR73", "Tx4");
    eq(m.tx5, "AA1ABC K9XYZ 73", "Tx5");
    eq(m.tx6, "CQ K9XYZ EN61", "Tx6");
    const p = standardMessages({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "AA1ABC",
      theirSnr: -18,
      cqModifier: "POTA",
    });
    eq(p.tx6, "CQ POTA K9XYZ EN61", "Tx6 with POTA modifier");
  }

  console.log("\nfull QSO — we answer their CQ (caller role)");
  {
    // We heard "CQ K1DEF DM33" at -14 and click to call.
    const q = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "K1DEF",
      theirGrid: "DM33",
      theirSnr: -14,
      role: "caller",
      startedAt: 1000,
    });
    let t = q.tick(15_000);
    eq(t.send, "K1DEF K9XYZ EN61", "first tick sends Tx1");
    // They answer with our report.
    q.onDecode("K9XYZ K1DEF -10", 22_000);
    t = q.tick(30_000);
    eq(t.send, "K1DEF K9XYZ R-14", "their report advances us to Tx3");
    // They confirm.
    q.onDecode("K9XYZ K1DEF RR73", 37_000);
    t = q.tick(45_000);
    eq(t.send, "K1DEF K9XYZ 73", "RR73 completes; we send the courtesy 73");
    ok(t.log !== undefined, "log entry produced");
    eq(t.log!.reportSent, "-14", "report sent is what we heard them at");
    eq(t.log!.reportRcvd, "-10", "report received captured");
    eq(t.log!.theirGrid, "DM33", "their grid captured");
    ok(q.isDone, "QSO is done");
    t = q.tick(60_000);
    ok(t.send === null && t.log === undefined, "after completion: silence, log only once");
  }

  console.log("\nfull QSO — they answer our CQ (answerer role)");
  {
    // Our CQ was answered: "K9XYZ AA1ABC EL98" heard at -07.
    const q = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "AA1ABC",
      theirGrid: "EL98",
      theirSnr: -7,
      role: "answerer",
    });
    let t = q.tick(15_000);
    eq(t.send, "AA1ABC K9XYZ -07", "first tick sends the report (Tx2)");
    q.onDecode("K9XYZ AA1ABC R-12", 22_000);
    t = q.tick(30_000);
    eq(t.send, "AA1ABC K9XYZ RR73", "their R-report advances to RR73");
    q.onDecode("K9XYZ AA1ABC 73", 37_000);
    t = q.tick(45_000);
    ok(t.log !== undefined, "their 73 completes and logs");
    eq(t.log!.reportRcvd, "-12", "R-report captured as received report");
    ok(t.send === null, "no further transmission needed after their 73");
  }

  console.log("\nsequencing edge cases");
  {
    // Repeats: nobody answers our Tx1.
    const q = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "K1DEF",
      theirSnr: -14,
      role: "caller",
      maxRepeats: 3,
    });
    ok(q.tick(0).send !== null, "call 1");
    ok(q.tick(15_000).send !== null, "call 2 (repeat 1)");
    ok(q.tick(30_000).send !== null, "call 3 (repeat 2)");
    const t = q.tick(45_000);
    ok(t.state === "abandoned" && t.send === null, "abandoned after max repeats");
    ok(t.abandonReason !== undefined, "abandon reason present");

    // Missing courtesy 73 must still log (they sent RR73 and left) — as WSJT-X does.
    const q2 = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "AA1ABC",
      theirSnr: -7,
      role: "answerer",
      maxRepeats: 2,
    });
    q2.tick(0); //                        Tx2
    q2.onDecode("K9XYZ AA1ABC R-12", 5_000);
    q2.tick(15_000); //                   RR73
    q2.tick(30_000); //                   RR73 again (repeat 1)
    const t2 = q2.tick(45_000); //        repeat limit -> complete, not abandoned
    ok(t2.state === "complete", "rr73-sent repeat limit completes rather than abandons");
    ok(t2.log !== undefined, "still produces the log entry");

    // Messages from third parties must not ADVANCE the machine.
    //
    // This assertion used to cover two cases with one claim — "third-party messages
    // ignored" — and one of the two was the bug. `K1ABC K1DEF -09` is our target
    // answering somebody else, which is not noise to be ignored: it is the plainest
    // statement available that they are not listening for us, and ignoring it is what had
    // this station transmitting into other people's exchanges. See "They are working
    // somebody else" below. Split, because the two halves now have different answers.
    const q3 = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "K1DEF",
      theirSnr: -14,
      role: "caller",
    });
    q3.tick(0);
    q3.onDecode("K9XYZ N0CALL -05", 5_000); // a different station calling us
    ok(q3.currentState === "calling", "a stranger calling us does not advance the machine");
    q3.onDecode("K1ABC K1DEF -09", 6_000); //  our target working someone else
    ok(q3.currentState === "abandoned", "our target answering somebody else ends the call");
  }

  console.log("\noperating guards");
  {
    const never = async () => false;
    const g = new OperatingGuards({
      maxCallAttempts: 3,
      failureCooldownMs: 60_000,
      dupeWindowMs: 1_000_000,
      maxUnansweredCqs: 3,
      maxConsecutiveTx: 5,
      deafWindowLimit: 2,
    });

    ok((await g.mayCall("K1DEF", "40M", "FT8", 0, never)).allowed, "fresh call allowed");

    // Dupe: already in the log today on this band+mode.
    const worked = async (c: string, b: string) => c === "K1DEF" && b === "40M";
    const dupe = await g.mayCall("K1DEF", "40M", "FT8", 0, worked);
    ok(!dupe.allowed && /already worked/i.test(dupe.reason ?? ""), "dupe on same band+mode blocked");
    ok((await g.mayCall("K1DEF", "20M", "FT8", 0, worked)).allowed, "same call on another band allowed");

    // Failure cooldown.
    g.recordFailure("N0ANS", 100_000);
    const cd = await g.mayCall("N0ANS", "40M", "FT8", 130_000, never);
    ok(!cd.allowed && /cooling down/i.test(cd.reason ?? ""), "recently-failed call is cooling down");
    ok((await g.mayCall("N0ANS", "40M", "FT8", 170_000, never)).allowed, "cooldown expires");
    g.recordSuccess("N0ANS");

    // ---- The do-not-call list ----
    //
    // The one guard in this file that protects somebody else rather than this station, so
    // it is tested harder than the rest: it must beat every other condition, must not be
    // reachable round by any configuration, and must say WHY in words an operator will
    // recognise.
    {
      const onList = async (c: string) =>
        c.toUpperCase() === "W1ABC" ? ("NEVER" as const) : null;
      const blocked = await g.mayCall("W1ABC", "40M", "FT8", 500_000, never, {
        listedAs: onList,
      });
      ok(
        !blocked.allowed && /do-not-call/i.test(blocked.reason ?? ""),
        "a listed callsign is refused, and the reason names the list",
      );
      // Case must not be a way round it.
      ok(
        !(await g.mayCall("w1abc", "40M", "FT8", 500_000, never, { listedAs: onList }))
          .allowed,
        "and lower case is the same station",
      );
      // Every band, every mode, no cooldown, forever.
      ok(
        !(await g.mayCall("W1ABC", "20M", "FT4", 9_999_999, never, { listedAs: onList }))
          .allowed,
        "on any band, in any mode, at any time",
      );
      ok(
        (await g.mayCall("K1DEF", "40M", "FT8", 500_000, never, { listedAs: onList }))
          .allowed,
        "while everybody else is unaffected",
      );
      // ORDERING. A station that is BOTH on the list and inside a failure cooldown must
      // report the list, because the cooldown is transient and expires — an operator told
      // "cooling down" will try again in half an hour and be told something different,
      // which is how a permanent request gets treated as a temporary one.
      const both = new OperatingGuards({ ...DEFAULT_GUARDS });
      both.recordFailure("W1ABC", 0);
      const cooling = await both.mayCall("W1ABC", "40M", "FT8", 60_000, never, {
        listedAs: onList,
      });
      ok(
        !cooling.allowed && /do-not-call/i.test(cooling.reason ?? ""),
        "and the list is reported ahead of a transient cooldown",
      );
    }

    // ---- No duplicate contacts: same band AND mode, ever ----
    //
    // The K1XYZ case, kept as a regression because it reached a real operator twice before
    // anything caught it. Seventeen contacts, eight on 20 m FT8, seven of those inside a
    // fortnight, and 2,673 duplicate band+mode slots station-wide. The dupe window alone
    // permitted every one of them: it asks only whether the contact was RECENT.
    {
      // The log as it stood: worked on 20M FT8, and the most recent one LONG AGO.
      //
      // The stub has to honour `sinceMs` or it proves nothing — a stub that answers "yes"
      // whatever window it is handed makes the 24-hour dupe check fire first, and the test
      // then passes on the OLD guard's reason while saying it tested the new one.
      const LAST_WORKED = 1_000_000; // epoch ms: ancient by any window's reckoning
      const inLog = async (c: string, b: string, m: string, sinceMs: number) =>
        c.toUpperCase() === "K1XYZ" && b === "20M" && m === "FT8" && sinceMs <= LAST_WORKED;

      // FROM THE LIST, per callsign — not a station-wide rule. "I don't want the rule on
      // everyone, just a list of people."
      const listed = async (c: string) =>
        c.toUpperCase() === "K1XYZ" ? ("NO_DUPES" as const) : null;
      const d = new OperatingGuards({ ...DEFAULT_GUARDS });

      const dupe = await d.mayCall("K1XYZ", "20M", "FT8", Date.now(), inLog, {
        listedAs: listed,
      });
      ok(
        !dupe.allowed && /no duplicates/i.test(dupe.reason ?? ""),
        "a listed station is refused a duplicate, and the reason says it was their request",
      );

      // The dupe WINDOW cannot save it: a year later is still a duplicate.
      const yearLater = await d.mayCall("K1XYZ", "20M", "FT8", 400 * 86_400_000, inLog, {
        listedAs: listed,
      });
      ok(!yearLater.allowed, "and still refused a year later, which the window allowed");

      // NOBODY ELSE IS AFFECTED. This is the whole point of the list over the switch: a
      // station with the same duplicate in the log, but not listed, is still callable.
      ok(
        (await d.mayCall("W0ABC", "20M", "FT8", Date.now(),
          async (c, b, m, since) =>
            c.toUpperCase() === "W0ABC" && b === "20M" && m === "FT8" && since <= LAST_WORKED,
          { listedAs: listed })).allowed,
        "while an unlisted station with the same duplicate is still called",
      );

      // A NEVER entry is stronger and does not need the log consulted at all.
      const never = async (c: string) =>
        c.toUpperCase() === "K1XYZ" ? ("NEVER" as const) : null;
      const hard = await d.mayCall("K1XYZ", "15M", "FT4", Date.now(), inLog, {
        listedAs: never,
      });
      ok(
        !hard.allowed && /do-not-call/i.test(hard.reason ?? ""),
        "and a NEVER entry blocks a band and mode never worked at all",
      );

      // What Lee explicitly said he WOULD welcome must stay allowed, or the rule punishes
      // him for complaining.
      ok(
        (await d.mayCall("K1XYZ", "20M", "FT4", Date.now(), inLog, { listedAs: listed }))
          .allowed,
        "a different mode on the same band is a new slot and is allowed",
      );
      ok(
        (await d.mayCall("K1XYZ", "15M", "FT8", Date.now(), inLog, { listedAs: listed }))
          .allowed,
        "and so is the same mode on a band never worked",
      );
      ok(
        (await d.mayCall("W0ABC", "20M", "FT8", Date.now(), inLog, { listedAs: listed }))
          .allowed,
        "while a station not in the log is unaffected",
      );

      // Switchable off for anyone with a reason to want duplicates.
      // The station-wide switch still exists for anyone who does want it everywhere.
      const everyone = new OperatingGuards({
        ...DEFAULT_GUARDS,
        skipWorkedOnBandModeEver: true,
      });
      ok(
        !(await everyone.mayCall("W0ABC", "20M", "FT8", Date.now(),
          async (c, b, m, since) =>
            c.toUpperCase() === "W0ABC" && b === "20M" && m === "FT8" && since <= LAST_WORKED))
          .allowed,
        "and the station-wide switch still catches an unlisted duplicate when turned on",
      );
      // Off by default, which is the correction this release makes.
      ok(
        !DEFAULT_GUARDS.skipWorkedOnBandModeEver,
        "but it is OFF by default — the list is the normal route",
      );
    }

    // ---- Band slots: worked on this band, ever ----
    {
      const everOnBand = async (c: string, b: string) =>
        c.toUpperCase() === "K1DEF" && b === "40M";
      // Off by default, so an operator who has not asked for it keeps working people.
      const loose = new OperatingGuards({ ...DEFAULT_GUARDS, dupeWindowMs: 0 });
      ok(
        (await loose.mayCall("K1DEF", "40M", "FT8", 0, never, {
          workedOnBandEver: everOnBand,
        })).allowed,
        "a station worked on this band years ago is allowed by default",
      );

      const strict = new OperatingGuards({
        ...DEFAULT_GUARDS,
        dupeWindowMs: 0,
        skipWorkedOnBandEver: true,
      });
      const slot = await strict.mayCall("K1DEF", "40M", "FT8", 0, never, {
        workedOnBandEver: everOnBand,
      });
      ok(
        !slot.allowed && /already have that band/i.test(slot.reason ?? ""),
        "with the rule on, the band slot blocks them",
      );
      // Mode-agnostic: the whole point. A 40 m slot is filled whichever mode filled it.
      ok(
        !(await strict.mayCall("K1DEF", "40M", "FT4", 0, never, {
          workedOnBandEver: everOnBand,
        })).allowed,
        "and a different mode on the same band is still the same slot",
      );
      ok(
        (await strict.mayCall("K1DEF", "20M", "FT8", 0, never, {
          workedOnBandEver: everOnBand,
        })).allowed,
        "while a band never worked is still open",
      );
      // With the rule on but no checker supplied, it must not refuse everybody.
      ok(
        (await strict.mayCall("K1DEF", "40M", "FT8", 0, never)).allowed,
        "and with no band-slot checker wired it stays out of the way",
      );
    }

    // Runaway TX brake.
    const g2 = new OperatingGuards({ maxConsecutiveTx: 3 });
    ok(g2.beforeTx().allowed && g2.beforeTx().allowed && g2.beforeTx().allowed, "tx 1-3 allowed");
    const brake = g2.beforeTx();
    ok(!brake.allowed && /pausing until re-armed/i.test(brake.reason ?? ""), "runaway brake trips");
    ok(!(await g2.mayCall("K1DEF", "40M", "FT8", 0, never)).allowed, "paused blocks new calls too");
    g2.rearm();
    ok(g2.beforeTx().allowed, "re-arm restores transmission");

    // Operator interaction resets the runaway counter.
    const g3 = new OperatingGuards({ maxConsecutiveTx: 3 });
    g3.beforeTx();
    g3.beforeTx();
    g3.operatorTouched();
    ok(g3.beforeTx().allowed && g3.beforeTx().allowed, "operator input resets the brake");

    // Deaf guard: silent windows with no decodes pause TX.
    const g4 = new OperatingGuards({ deafWindowLimit: 2 });
    g4.afterRxWindow({ decodes: 0, silent: true, answeredUs: false, wasCqing: false });
    g4.afterRxWindow({ decodes: 0, silent: true, answeredUs: false, wasCqing: false });
    const deaf = g4.beforeTx();
    ok(!deaf.allowed && /refusing to transmit blind/i.test(deaf.reason ?? ""), "deaf receiver refuses to transmit");
    // A busy band would have reset it.
    const g5 = new OperatingGuards({ deafWindowLimit: 2 });
    g5.afterRxWindow({ decodes: 0, silent: true, answeredUs: false, wasCqing: false });
    g5.afterRxWindow({ decodes: 12, silent: false, answeredUs: false, wasCqing: false });
    g5.afterRxWindow({ decodes: 0, silent: true, answeredUs: false, wasCqing: false });
    ok(g5.beforeTx().allowed, "hearing anything resets the deaf counter");

    // Unanswered CQs.
    const g6 = new OperatingGuards({ maxUnansweredCqs: 2 });
    g6.afterRxWindow({ decodes: 4, silent: false, answeredUs: false, wasCqing: true });
    g6.afterRxWindow({ decodes: 4, silent: false, answeredUs: false, wasCqing: true });
    ok(g6.pausedReason !== null && /no answer/i.test(g6.pausedReason), "unanswered CQ limit pauses");
    const g7 = new OperatingGuards({ maxUnansweredCqs: 2 });
    g7.afterRxWindow({ decodes: 4, silent: false, answeredUs: false, wasCqing: true });
    g7.afterRxWindow({ decodes: 4, silent: false, answeredUs: true, wasCqing: true });
    g7.afterRxWindow({ decodes: 4, silent: false, answeredUs: false, wasCqing: true });
    ok(g7.pausedReason === null, "an answer resets the CQ counter");

    // Defaults are sane.
    ok(DEFAULT_GUARDS.maxConsecutiveTx <= 30, "default runaway brake is tight");
    ok(DEFAULT_GUARDS.dupeWindowMs >= 12 * 3_600_000, "default dupe window covers the day");
  }

  console.log("\nabandoned after reports went both ways");
  {
    // As the CALLER: we call, they answer with a report, we roger it, and their RR73 never
    // decodes. From their side the contact completed and they logged it - which is how thirteen
    // of these were found months later, by reconciling QRZ card requests against a log with no
    // record of them. The only surviving trace was a decode row with a null qsoId.
    const q = new QsoSequencer({
      myCall: "K9XYZ", myGrid: "EN61", theirCall: "K5PYT", theirSnr: -12,
      role: "caller", maxRepeats: 3, startedAt: 1000,
    });
    q.tick(15_000);
    q.onDecode("K9XYZ K5PYT +25", 22_000);
    // The transition tick is the one that carries the reason and the payload; ticking past it
    // returns a bare abandoned state. Keep the first one that reports it.
    let last = q.tick(30_000);
    for (let n = 0; n < 8 && !last.abandonReason; n++) last = q.tick(45_000 + n * 15_000);

    eq(last.state, "abandoned", "the sequence gives up");
    ok(Boolean(last.abandonReason), "with a reason");
    ok(Boolean(last.abandoned), "and the exchange is reported rather than discarded");
    eq(last.abandoned?.theirCall, "K5PYT", "naming the station");
    eq(last.abandoned?.reportRcvd, "+25", "the report they sent us");
    eq(last.abandoned?.reportSent, "-12", "and the one we sent them");
    eq(last.abandoned?.stage, "rreport-sent", "at the stage that makes it interesting");
    ok(last.log === undefined, "and NOT logged as a contact - only the operator judges that");
  }

  console.log("\nabandoned with nothing exchanged");
  {
    // The overwhelming majority of abandoned sequences: we called and nobody answered. Storing
    // these would bury the ones that matter under thousands that carry no information.
    const q = new QsoSequencer({
      myCall: "K9XYZ", myGrid: "EN61", theirCall: "K5PYT", theirSnr: -12,
      role: "caller", maxRepeats: 3, startedAt: 1000,
    });
    let last = q.tick(15_000);
    for (let n = 0; n < 8 && !last.abandonReason; n++) last = q.tick(30_000 + n * 15_000);
    eq(last.state, "abandoned", "it still gives up");
    ok(Boolean(last.abandonReason), "with a reason");
    ok(last.abandoned === undefined, "but nothing is kept, because nothing was exchanged");
  }


  console.log("\nclicking Call on a message mid-exchange resumes it");
  {
    // The reported fault: "if i click call on their rr73 it restarts the call ... it
    // should pick back up where it was". A sequencer is built in the "calling" state and
    // then handed the message that prompted the call, exactly as the controller now does.

    // They already sent us a REPORT — we owe an R-report, not an opening grid message.
    const a = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "XE1JVO",
      theirSnr: -6,
      role: "caller",
      startedAt: 1000,
    });
    a.onDecode("K9XYZ XE1JVO -02", 15_000);
    eq(a.currentState, "rreport-sent", "their report moves us straight to owing Tx3");
    eq(a.tick(30_000).send, "XE1JVO K9XYZ R-06", "so we answer with the R-report");

    // They already sent RR73 — the contact is over bar the courtesy 73, and it must be
    // LOGGED rather than started again from the top.
    const b = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "XE1JVO",
      theirSnr: -6,
      role: "caller",
      startedAt: 1000,
    });
    b.onDecode("K9XYZ XE1JVO RR73", 15_000);
    ok(b.isDone, "their RR73 completes it immediately");
    const t = b.tick(30_000);
    eq(t.send, "XE1JVO K9XYZ 73", "we owe only the courtesy 73");
    ok(t.log !== undefined, "and the contact is logged, not restarted");

    // A CQ carries no state, so clicking it must still open normally.
    const c = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "DL2MIJ",
      theirSnr: -9,
      role: "caller",
      startedAt: 1000,
    });
    c.onDecode("CQ DX DL2MIJ JN58", 15_000);
    eq(c.currentState, "calling", "a CQ leaves us at the beginning");
    eq(c.tick(30_000).send, "DL2MIJ K9XYZ EN61", "and we open with Tx1");

    // Somebody else's exchange must not move our machine at all.
    const d = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "XE1JVO",
      theirSnr: -6,
      role: "caller",
      startedAt: 1000,
    });
    d.onDecode("K4ANC F5LOW RR73", 15_000);
    eq(d.currentState, "calling", "a message between two other stations is ignored");
  }


  console.log("\na bare 73 closes the contact from either side");
  {
    // Measured against the live decode log: of 142 incomplete exchanges, three had a
    // plain 73 addressed to us that arrived while the sequence was still running and was
    // discarded, because 73 only completed from the answerer's rr73-sent state.
    //
    //     K9XYZ EA3ISZ 73      K9XYZ AK6TB 73      K9XYZ AA1HR 73
    //
    // Not every operator sends RR73, and some software closes with 73 by default.
    const q = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "EA3ISZ",
      theirSnr: -16,
      role: "caller",
      startedAt: 1000,
    });
    q.tick(15_000);
    q.onDecode("K9XYZ EA3ISZ -08", 22_000);
    eq(q.currentState, "rreport-sent", "their report leaves us owing the R-report");
    q.tick(30_000);
    q.onDecode("K9XYZ EA3ISZ 73", 37_000);
    ok(q.isDone, "their bare 73 completes the contact");
    const t = q.tick(45_000);
    ok(t.log !== undefined, "and it is logged");
    // They have already signed off. Sending 73 back burns a cycle on a finished contact,
    // which is why completeAt distinguishes a 73 from an RR73 rather than reading state.
    eq(t.send, null, "we do NOT send a courtesy 73 back at somebody who just sent one");
  }

  console.log("\nan RR73 still owes the courtesy 73");
  {
    const q = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "K1DEF",
      theirSnr: -14,
      role: "caller",
      startedAt: 1000,
    });
    q.tick(15_000);
    q.onDecode("K9XYZ K1DEF -10", 22_000);
    q.tick(30_000);
    q.onDecode("K9XYZ K1DEF RR73", 37_000);
    eq(q.tick(45_000).send, "K1DEF K9XYZ 73", "RR73 leaves us owing a sign-off, as before");
  }


  console.log("\nall three acknowledgements close a contact, from either side");
  {
    // RRR, RR73 and 73. Each was previously accepted from only one side of the sequence,
    // and the live decode log shows all three arriving and being discarded.
    const mk = (role: "caller" | "answerer") =>
      new QsoSequencer({
        myCall: "K9XYZ",
        myGrid: "EN61",
        theirCall: "K1DEF",
        theirSnr: -14,
        role,
        startedAt: 1000,
      });

    // Answerer: we sent the report, they rogered it, we sent RR73 and are waiting.
    for (const token of ["RRR", "RR73", "73"]) {
      const q = mk("answerer");
      q.tick(15_000);
      q.onDecode("K9XYZ K1DEF R-10", 22_000);
      eq(q.currentState, "rr73-sent", `answerer reaches rr73-sent before ${token}`);
      q.tick(30_000);
      q.onDecode(`K9XYZ K1DEF ${token}`, 37_000);
      ok(q.isDone, `answerer: ${token} closes the contact`);
      const t = q.tick(45_000);
      ok(t.log !== undefined, `answerer: ${token} is logged`);
      eq(t.send, null, `answerer: nothing more is sent after ${token}`);
    }

    // Caller: they rogered our call with a report, we sent the R-report.
    for (const token of ["RRR", "RR73"]) {
      const q = mk("caller");
      q.tick(15_000);
      q.onDecode("K9XYZ K1DEF -10", 22_000);
      q.tick(30_000);
      q.onDecode(`K9XYZ K1DEF ${token}`, 37_000);
      ok(q.isDone, `caller: ${token} closes the contact`);
      // The caller still owes a sign-off after RRR/RR73 — that has always been true and
      // must stay true; only the answerer's side changed.
      eq(q.tick(45_000).send, "K1DEF K9XYZ 73", `caller: ${token} still owes the 73`);
    }
  }


  // ---------------------------------------------------------------------------------
  // The transmit ceiling - how high up the passband we are willing to answer.
  //
  // > "?? are we not suing the full ft8 band?"
  //
  // Beside a decode reading "KF6FIR is at 2903 Hz, above the 2800 Hz the transmitter can
  // place audio at". The radio disagreed: `transmit freq=7.074000 lo=100 hi=3100`. The
  // 2800 constant reasons about an IC-7300's USB-D roll-off - correct for an IC-7300 and
  // needlessly tight on a Flex, so this station was refusing everyone in a 300 Hz strip.
  //
  // Asserted here because the failure mode is SILENCE. A radio that never reports `hi`
  // leaves the ceiling at the default, and the fix doing nothing looks exactly like the
  // fix working.
  console.log("");
  console.log("Transmit ceiling");
  {
    eq(resolveMaxTxOffset(null), MAX_TX_OFFSET_HZ, "a radio that says nothing keeps 2800");
    eq(resolveMaxTxOffset(NaN), MAX_TX_OFFSET_HZ, "so does a garbled reading");
    // MEASURED on a FLEX-6400: `sub tx all` delivers lo=100 hi=3100 at subscribe, so this
    // is the number a Flex install actually resolves to.
    eq(resolveMaxTxOffset(3100), 3000, "a Flex reporting hi=3100 answers up to 3000");
    ok(resolveMaxTxOffset(3100) > 2903, "which is above the KF6FIR decode that started this");
    // 100 Hz of guard, because an offset names where a transmission STARTS and FT8 puts
    // eight tones about 90 Hz above it. Answering at the edge puts most of them outside.
    eq(resolveMaxTxOffset(2900), MAX_TX_OFFSET_HZ, "the guard is 100 Hz below the edge");
    // Never BELOW the conservative default. A radio reporting an implausibly narrow filter
    // must not silently shrink what we will answer.
    eq(resolveMaxTxOffset(1500), MAX_TX_OFFSET_HZ, "an implausibly narrow filter cannot shrink it");
    eq(resolveMaxTxOffset(0), MAX_TX_OFFSET_HZ, "nor can a zero");
    eq(resolveMaxTxOffset(-1), MAX_TX_OFFSET_HZ, "nor a negative");
  }

  // ---------------------------------------------------------------------------------
  // Fox/hound compound messages.
  //
  //     K9XYZ RR73; DL2HIR <3D2USU> -20
  //
  // A DXpedition acknowledging one station and reporting to another in ONE transmission.
  // That is a genuine RR73 to K9XYZ and a genuine report to DL2HIR at the same time, and
  // the single-value parse could represent neither, so it returned `other` and the
  // sequencer ignored it. The contact behind this - Fiji - was recovered by hand.
  console.log("");
  console.log("Fox/hound compound messages");
  {
    const both = parseMessages("K9XYZ RR73; DL2HIR <3D2USU> -20");
    eq(both.length, 2, "carries two statements");

    const ack = both[0]!;
    ok(ack.kind === "directed", "the first is directed");
    if (ack.kind === "directed") {
      eq(ack.to, "K9XYZ", "acknowledges K9XYZ");
      // The fox's call appears only in the RIGHT half, so the left one has to borrow it.
      // Parsing each side independently would leave this null and lose the contact.
      eq(ack.from, "3D2USU", "from the fox, whose call is only in the other half");
      eq(ack.payload.type, "rr73", "and it is an RR73");
    }

    const rep = both[1]!;
    ok(rep.kind === "directed", "the second is directed");
    if (rep.kind === "directed") {
      eq(rep.to, "DL2HIR", "reports to DL2HIR");
      eq(rep.from, "3D2USU", "from the same fox");
      eq(rep.payload.type, "report", "and it is a report");
      if (rep.payload.type === "report") eq(rep.payload.db, -20, "of -20 dB");
    }

    // parseMessage takes the head, so a station waiting on an acknowledgement still gets
    // the meaning that matters most to it from the single-value call.
    const head = parseMessage("K9XYZ RR73; DL2HIR <3D2USU> -20");
    ok(head.kind === "directed" && head.payload.type === "rr73", "parseMessage yields the RR73");

    // RRR and 73 close a contact from either side, so a fox using them says the same thing.
    for (const token of ["RRR", "73"]) {
      const r = parseMessages(`K9XYZ ${token}; DL2HIR <3D2USU> -20`)[0]!;
      ok(
        r.kind === "directed" && r.payload.type === token.toLowerCase(),
        `a fox closing with ${token} is heard`,
      );
    }

    // A malformed right-hand side must not cost the acknowledgement, which is the half
    // that closes a contact.
    const salvaged = parseMessages("K9XYZ RR73; DL2HIR <3D2USU> WHAT");
    eq(salvaged.length, 1, "a broken report half is dropped, not the whole message");
    ok(salvaged[0]!.kind === "directed", "and the acknowledgement survives it");

    // A message that merely contains a semicolon is still parsed normally rather than
    // being swallowed by the compound path.
    const plain = parseMessages("K9XYZ K1DEF RR73");
    eq(plain.length, 1, "an ordinary message yields one statement");
  }

  console.log("");
  console.log("Hashed callsigns");
  {
    // FT8 sends a 22-bit hash for a callsign too long for the 28-bit field once both ends
    // have heard it in full; WSJT-X renders it back in angle brackets when it knows it.
    const p = parseMessage("K9XYZ <3D2USU> RR73");
    ok(p.kind === "directed", "a resolved hash is a workable callsign");
    if (p.kind === "directed") eq(p.from, "3D2USU", "and the brackets come off");

    // "<...>" is a hash the decoder could NOT resolve. That call really is unknown, and
    // answering it would send a message the other end may not decode.
    const unknown = parseMessage("K9XYZ <...> RR73");
    eq(unknown.kind, "other", "an unresolved hash stays unworkable");

    const foxUnknown = parseMessages("K9XYZ RR73; DL2HIR <...> -20");
    eq(foxUnknown.length, 1, "a compound from an unresolved fox yields nothing usable");
    eq(foxUnknown[0]!.kind, "other", "and is not mistaken for a directed message");
  }

  // The whole point, end to end: the sequencer must now close on the compound form.
  console.log("");
  console.log("The Fiji case");
  {
    const q = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "3D2USU",
      // A DXpedition on a bad path, which is exactly the situation fox/hound exists for.
      theirSnr: -20,
      role: "caller",
      startedAt: 0,
    });
    q.tick(15_000);
    q.onDecode("K9XYZ 3D2USU -12", 22_000);
    q.tick(30_000);
    // Exactly the transmission that was ignored.
    q.onDecode("K9XYZ RR73; DL2HIR <3D2USU> -20", 37_000);
    ok(q.isDone, "a fox/hound RR73 closes the contact");
  }

  // ---------------------------------------------------------------------------------
  // Do not spend a window on a station that is not listening.
  //
  // > "on a decode if we are calling another station and you see that they are calling
  // >  another station why do we continue to call"
  //
  // From the transcript that prompted it - W9ABC calling N5MIG/P:
  //
  //     37:45  CQ N5MIG/P EM64
  //     38:15  KO4OIG N5MIG/P +03      <- they answered KO4OIG, not us
  //     38:30  N5MIG/P W9ABC EN61       <- we called anyway
  //     38:45  KO4OIG N5MIG/P RR73
  //     39:00  N5MIG/P W9ABC EN61       <- and again
  //     39:15  CE8VJG N5MIG/P EM64     <- now working CE8VJG
  //     39:30  N5MIG/P W9ABC EN61       <- and again
  //
  // The information was in the decodes the whole time; `applyOne` discarded any message
  // from them not addressed to us.
  //
  // THE FIX IS TO RELEASE THE TRANSMITTER, NOT TO GO QUIET. Those are different, and the
  // difference is the whole point: while a sequencer is live the auto operator will not
  // touch the transmitter, so holding silent costs exactly as many windows as calling into
  // a conversation - it just wastes them quietly. Ending the call hands the window back to
  // be spent on somebody who might answer.
  console.log("");
  console.log("They are working somebody else");
  {
    const mk = (): QsoSequencer =>
      new QsoSequencer({
        myCall: "W9ABC",
        myGrid: "EN61",
        theirCall: "N5MIG/P",
        theirSnr: -3,
        role: "caller",
        startedAt: 0,
      });

    {
      const q = mk();
      eq(q.tick(15_000).send, "N5MIG/P W9ABC EN61", "we call once");
      q.onDecode("KO4OIG N5MIG/P +03", 22_000);
      ok(q.isDone, "seeing them answer somebody else ends the call at once");
      const t = q.tick(45_000);
      eq(t.send, null, "we do not transmit into their exchange");
      eq(t.state, "abandoned", "the transmitter is free for the auto operator");
      eq(t.abandonReason, "They are working KO4OIG", "and the reason names who, not 'no reply'");
    }

    {
      // Decided at DECODE time, which is what makes it free. Their message lands in their
      // window, so the release happens before our next transmit window comes round.
      const q = mk();
      q.tick(15_000);
      q.onDecode("KO4OIG N5MIG/P +03", 22_000);
      ok(q.isDone, "released on the decode, not deferred to the next tick");
    }

    {
      // A CLOSING TOKEN IS THE OPPOSITE SIGNAL. Their RR73 to somebody else means they are
      // free, and the next window is the one to be in - ahead of everyone else waiting.
      const q = mk();
      q.tick(15_000);
      q.onDecode("KO4OIG N5MIG/P RR73", 22_000);
      ok(!q.isDone, "their RR73 to another station does not end our call");
      eq(q.tick(45_000).send, "N5MIG/P W9ABC EN61", "we call straight into the gap");
    }

    {
      // Nor does a CQ, which is the same signal by another route.
      const q = mk();
      q.tick(15_000);
      q.onDecode("CQ N5MIG/P", 22_000);
      ok(!q.isDone, "a CQ from them means they are listening");
    }

    {
      // Somebody else calling THEM is not evidence about them at all - it is evidence
      // about the caller. Only a message FROM our partner counts.
      const q = mk();
      q.tick(15_000);
      q.onDecode("N5MIG/P KO4OIG EM64", 22_000);
      ok(!q.isDone, "another station calling them proves nothing; they may still pick us");
    }

    {
      // Reports had gone BOTH ways before they wandered off, so the exchange is kept
      // rather than discarded - the far station may well have logged it. Same rule as the
      // no-reply abandon; thirteen contacts went missing before it existed.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC N5MIG/P -12", 22_000);
      q.tick(45_000);
      q.onDecode("KO4OIG N5MIG/P +03", 52_000);
      const t = q.tick(75_000);
      eq(t.state, "abandoned", "they moved on mid-exchange");
      ok(t.abandoned !== undefined, "and the incomplete exchange is kept, not thrown away");
      eq(t.abandoned?.reportRcvd, "-12", "with the report they gave us");
    }

    {
      // Reported exactly once. A second tick must not re-announce it, or the controller
      // would log the abandonment twice and record the incomplete exchange twice with it.
      const q = mk();
      q.tick(15_000);
      q.onDecode("KO4OIG N5MIG/P +03", 22_000);
      ok(q.tick(45_000).abandonReason !== undefined, "first tick carries the reason");
      eq(q.tick(75_000).abandonReason, undefined, "the next one does not repeat it");
    }

    {
      // The whole sequence from the report, end to end. Three transmissions into a
      // conversation nobody was listening to; one now, and the rest of the airtime is the
      // auto operator's to spend on somebody workable.
      const q = mk();
      const sent: string[] = [];
      const push = (t: { send: string | null }): void => {
        if (t.send) sent.push(t.send);
      };
      q.onDecode("CQ N5MIG/P EM64", 0);
      push(q.tick(15_000));
      q.onDecode("KO4OIG N5MIG/P +03", 20_000);
      push(q.tick(45_000));
      q.onDecode("KO4OIG N5MIG/P RR73", 50_000);
      push(q.tick(75_000));
      q.onDecode("CE8VJG N5MIG/P EM64", 80_000);
      push(q.tick(105_000));
      eq(sent.length, 1, "one call, not three");
      eq(sent[0], "N5MIG/P W9ABC EN61", "and it is the one that had a chance");
    }
  }

  // ---------------------------------------------------------------------------------
  // THE ENDLESS LOOP.
  //
  // Observed live, W9ABC calling KM4SXE, and it had been running for at least six rounds
  // when it was caught:
  //
  //     29:00  W9ABC KM4SXE +07     <- their report
  //     29:15  KM4SXE W9ABC R-07    <- our roger
  //     29:30  W9ABC KM4SXE +07     <- their report, again
  //     29:45  KM4SXE W9ABC R-07    <- our roger, again
  //     30:00  W9ABC KM4SXE +07
  //     30:15  KM4SXE W9ABC R-07
  //     ...
  //
  // `maxRepeats` is 4 and should have stopped it. It could not, because every message
  // from them ran `this.repeats = 0` on the grounds that "the path is alive". The path
  // WAS alive - and stuck. A reply that changes nothing is evidence of a stall, not of
  // progress, and resetting the budget on it made the budget unreachable.
  console.log("");
  console.log("A station that replies but never advances");
  {
    const mk = (): QsoSequencer =>
      new QsoSequencer({
        myCall: "W9ABC",
        myGrid: "EN61",
        theirCall: "KM4SXE",
        theirSnr: -7,
        role: "caller",
        startedAt: 0,
      });

    {
      // The loop itself. Drive the exact exchange and require that it ends.
      const q = mk();
      q.tick(15_000); //                                     KM4SXE W9ABC EN61
      q.onDecode("W9ABC KM4SXE +07", 22_000); //              their report -> we advance
      eq(q.tick(45_000).send, "KM4SXE W9ABC R-07", "we roger their report");

      let sent = 0;
      let ended = null as string | undefined | null;
      for (let i = 0; i < 20 && !q.isDone; i++) {
        // They repeat, verbatim, for ever.
        q.onDecode("W9ABC KM4SXE +07", 50_000 + i * 30_000);
        const t = q.tick(75_000 + i * 30_000);
        if (t.send) sent++;
        if (t.abandonReason) ended = t.abandonReason;
      }

      ok(q.isDone, "the exchange ENDS rather than running for ever");
      ok(sent <= 4, `and we stop repeating (sent ${sent} more times, budget is 4)`);
      ok(
        /without acknowledging|not decoding us/i.test(ended ?? ""),
        "the reason says they never acknowledged, not 'no reply'",
      );
    }

    {
      // Reports went BOTH ways before it stalled, so this is a contact the far station
      // may well have logged. Kept, not discarded - the same rule that recovered thirteen
      // QSOs found months later through QRZ card requests.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000);
      q.tick(45_000);
      let kept = false;
      for (let i = 0; i < 20 && !q.isDone; i++) {
        q.onDecode("W9ABC KM4SXE +07", 50_000 + i * 30_000);
        const t = q.tick(75_000 + i * 30_000);
        if (t.abandoned) kept = true;
      }
      ok(kept, "the incomplete exchange is kept for the operator to judge");
    }

    {
      // PROGRESS MUST STILL RESET THE BUDGET. This is the half that has to keep working:
      // a station repeating because it genuinely has not decoded us deserves several
      // tries, and a long exchange that keeps advancing must never be cut short.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000); //   advances calling -> rreport-sent
      q.tick(45_000);
      // Three stalled repeats, then real progress.
      q.onDecode("W9ABC KM4SXE +07", 52_000);
      q.tick(75_000);
      q.onDecode("W9ABC KM4SXE +07", 82_000);
      q.tick(105_000);
      ok(!q.isDone, "three repeats is not yet a stall — they may just not have heard us");
      q.onDecode("W9ABC KM4SXE RR73", 112_000); // progress
      ok(q.isDone, "and their RR73 still completes the contact normally");
    }

    {
      // A repeat that carries a DIFFERENT report is still not progress. The state is what
      // decides, not whether the bytes changed - otherwise a station cycling -07/-08/-09
      // would reset the budget every time and loop for ever exactly as before.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000);
      q.tick(45_000);
      for (let i = 0; i < 20 && !q.isDone; i++) {
        q.onDecode(`W9ABC KM4SXE +0${(i % 3) + 5}`, 50_000 + i * 30_000);
        q.tick(75_000 + i * 30_000);
      }
      ok(q.isDone, "a drifting report number does not buy them unlimited retries");
    }
  }

  // ---------------------------------------------------------------------------------
  // The same transmission delivered twice must not spend the contact's patience.
  //
  // This machine is deliberately NOT idempotent about repeats - since the endless-loop fix
  // a message that moves nothing increments the stall counter, and at maxRepeats the call
  // ends. That is the point. But "repeating" means a LATER window; the same message at the
  // same instant is one transmission counted twice, and counting it halves the patience of
  // a live contact.
  //
  // Found by the decode-priority work, which feeds the sequencer from two passes over the
  // same window and measured the cost: an exchange survives 4 of their windows delivered
  // once and only 2 delivered twice.
  console.log("");
  console.log("A decode delivered twice");
  {
    const mk = (): QsoSequencer =>
      new QsoSequencer({
        myCall: "W9ABC", myGrid: "EN61", theirCall: "KM4SXE",
        theirSnr: -7, role: "caller", startedAt: 0,
      });

    {
      // Same window, same message, twice: the second is ignored entirely.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000);
      eq(q.tick(45_000).send, "KM4SXE W9ABC R-07", "a duplicate does not advance the machine twice");

      let windows = 0;
      for (let i = 0; i < 20 && !q.isDone; i++) {
        // Delivered TWICE every window, as a two-pass decoder would.
        q.onDecode("W9ABC KM4SXE +07", 50_000 + i * 30_000);
        q.onDecode("W9ABC KM4SXE +07", 50_000 + i * 30_000);
        q.tick(75_000 + i * 30_000);
        windows++;
      }
      // Without the guard this ends in half the windows.
      ok(windows >= 4, `survives ${windows} doubled windows, same as undoubled (>= 4)`);
    }

    {
      // The endless-loop fix must still fire: a genuine repeat is a LATER window, so it
      // carries a different `at` and still counts.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000);
      q.tick(45_000);
      for (let i = 0; i < 20 && !q.isDone; i++) {
        q.onDecode("W9ABC KM4SXE +07", 50_000 + i * 30_000);
        q.tick(75_000 + i * 30_000);
      }
      ok(q.isDone, "a station repeating across windows still ends the call");
    }

    {
      // Two stations in one window are two decodes, not a duplicate.
      const q = mk();
      q.tick(15_000);
      q.onDecode("W9ABC N0CALL -05", 22_000);
      q.onDecode("W9ABC KM4SXE +07", 22_000);
      eq(q.tick(45_000).send, "KM4SXE W9ABC R-07", "a different message in the same window still lands");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

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
  standardMessages,
} from "@/lib/digital/qso";

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

    // Messages from third parties must not advance the machine.
    const q3 = new QsoSequencer({
      myCall: "K9XYZ",
      myGrid: "EN61",
      theirCall: "K1DEF",
      theirSnr: -14,
      role: "caller",
    });
    q3.tick(0);
    q3.onDecode("K9XYZ N0CALL -05", 5_000); // different station calling us
    q3.onDecode("K1ABC K1DEF -09", 6_000); //  our target working someone else
    ok(q3.currentState === "calling", "third-party messages ignored");
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


  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

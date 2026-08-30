/* eslint-disable no-console */
// Logging an activation of your OWN park: MY_SIG, MY_SIG_INFO, MY_GRIDSQUARE.
// Run: npm run check:activation
//
// THE FAULT THESE GUARD. `Qso.sig` / `Qso.sigInfo` record the park the OTHER station is
// in — the hunter's half — and that was the only half this schema had. The schema said so
// itself: "these are THEIR activity. An activation of our own would be MY_SIG /
// MY_SIG_INFO, which is a separate pair and not yet stored." So when the operator was the
// ACTIVATOR at US-4567 working forty hunters, nothing recorded that they were at US-4567,
// the ADIF export carried no MY_SIG/MY_SIG_INFO, and POTA cannot read such a file as an
// activation. Forty contacts, correctly logged, and no activation.
//
// Three properties carry most of the weight here:
//
//   * MY_ IS NOT THEIRS. `mySigInfo` and `sigInfo` are one character apart and mean
//     opposite things. Reading the wrong one turns a day of park CHASING into an
//     "activation" of a park never visited, and the number looks entirely plausible.
//   * THE COUNT IS SCOPED TWICE. Ten contacts, at ONE reference, in ONE UTC DAY. A
//     counter that quietly counts a different park — or two days at once — is worse than
//     no counter, because a counter is believed.
//   * THE ACTIVATION OUTLIVES THE CONTACT. The in-progress-contact draft is cleared by
//     every successful save; the activation has to survive forty of them, and a tab
//     discard on top. That is why it is a second storage key rather than a draft field.
//
// Everything below calls the real exports. Nothing is reimplemented locally —
// check-dxcc.ts spent a long time asserting a rule only its own copy obeyed.
//
// WHAT IS NOT COVERED, deliberately and by force. There is NO DATABASE on the development
// machine (127.0.0.1:3306 is not listening), so nothing here executes a query. The
// migration, the columns and the composite index are asserted AS TEXT, which proves they
// are DECLARED and proves nothing whatever about MySQL. The count itself is exercised
// against the pure counter, which is the same rule the API filter is built from — but
// that the filter returns those rows needs the migration applied and a real activation.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTIVATION_KEY,
  ACTIVATION_VERSION,
  QSO_DRAFT_KEY,
  type ActivationSession,
  type QsoFormValues,
  activationFromValues,
  applyActivation,
  carrySession,
  clearActivation,
  emptyValues,
  hasContactContent,
  parseActivation,
  readActivation,
  serialiseActivation,
  toRequestBody,
  writeActivation,
} from "@/components/qso/QsoForm";
import { adifRecord, type AdifQsoInput } from "@/lib/adif/write";
import { parseAdif } from "@/lib/adif/parse";
import { toAdifInput, type QsoRowForAdif } from "@/lib/adif/from-row";
import {
  ACTIVATION_MINIMUM,
  activationCountQuery,
  activationProgress,
  countActivationQsos,
  normaliseRef,
  utcDayKey,
  utcDayStart,
} from "@/lib/pota/activation";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const root = join(__dirname, "..");

// ---------------------------------------------------------------------------
console.log("1. the ten-contact rule, scoped to the park AND the UTC day");
{
  check("the threshold is POTA's ten", ACTIVATION_MINIMUM === 10, ACTIVATION_MINIMUM);

  // An ordinary activation afternoon, plus the three things that must NOT be counted.
  const rows = [
    // Nine at the park we are activating, on the day in question.
    ...Array.from({ length: 9 }, (_, i) => ({
      mySigInfo: "US-4567",
      startTime: new Date(Date.UTC(2026, 7, 30, 14, i, 0)),
    })),
    // The SECOND park of a two-park day. Same operator, same afternoon, different
    // activation — and carrying these across is how somebody is told they qualified at a
    // park where they made four contacts.
    { mySigInfo: "US-4568", startTime: new Date("2026-08-30T15:00:00Z") },
    { mySigInfo: "US-4568", startTime: new Date("2026-08-30T15:01:00Z") },
    // YESTERDAY at the same park. A previous activation, already counted once.
    { mySigInfo: "US-4567", startTime: new Date("2026-08-29T23:59:59.999Z") },
    // TOMORROW at the same park, one millisecond over the line.
    { mySigInfo: "US-4567", startTime: new Date("2026-08-31T00:00:00.000Z") },
    // A park we CHASED, not activated. `sigInfo` would be set on this contact and
    // `mySigInfo` must not be — this is the row that catches a counter reading the wrong
    // column, because on a real hunter's log there are thousands of them.
    { mySigInfo: null, startTime: new Date("2026-08-30T14:30:00Z") },
  ];

  const noon = new Date("2026-08-30T12:00:00Z");
  check("counts only this park, this UTC day", countActivationQsos(rows, "US-4567", noon) === 9, countActivationQsos(rows, "US-4567", noon));
  check("the second park of the day counts separately", countActivationQsos(rows, "US-4568", noon) === 2, countActivationQsos(rows, "US-4568", noon));
  check("a park not activated counts zero", countActivationQsos(rows, "US-9999", noon) === 0);
  check("chased contacts (mySigInfo null) are never counted", countActivationQsos(rows, "", noon) === 0);

  // The boundary, from both sides, at millisecond resolution — which is the column's own
  // resolution, DATETIME(3).
  const edges = [
    { mySigInfo: "US-4567", startTime: new Date("2026-08-30T00:00:00.000Z") },
    { mySigInfo: "US-4567", startTime: new Date("2026-08-30T23:59:59.999Z") },
    { mySigInfo: "US-4567", startTime: new Date("2026-08-29T23:59:59.999Z") },
    { mySigInfo: "US-4567", startTime: new Date("2026-08-31T00:00:00.000Z") },
  ];
  check("UTC midnight itself is inside the day", countActivationQsos(edges, "US-4567", noon) === 2, countActivationQsos(edges, "US-4567", noon));

  // THE FAILURE A LOCAL-TIME COUNTER WOULD PRODUCE. POTA's day boundary is UTC midnight,
  // which in the US falls in the EVENING — 00:00 UTC is 20:00 EDT — so an activation
  // running through it spans two POTA days while feeling like one afternoon. Asserted at
  // an instant where the UTC date and every US local date disagree.
  const lateUtc = new Date("2026-08-31T01:30:00Z"); // 21:30 EDT on the 30th
  check(
    "an evening in the US is already the NEXT UTC day",
    countActivationQsos(rows, "US-4567", lateUtc) === 1,
    countActivationQsos(rows, "US-4567", lateUtc),
  );
  check("and the day start is the UTC one", utcDayStart(lateUtc).toISOString() === "2026-08-31T00:00:00.000Z", utcDayStart(lateUtc).toISOString());
  check("the day key names the UTC date", utcDayKey(lateUtc) === "2026-08-31", utcDayKey(lateUtc));

  // The ISO strings the API actually returns, not just Dates.
  const wire = [
    { mySigInfo: "US-4567", startTime: "2026-08-30T14:00:00.000Z" },
    { mySigInfo: "us-4567", startTime: "2026-08-30T14:01:00.000Z" },
    { mySigInfo: " US-4567 ", startTime: "2026-08-30T14:02:00.000Z" },
  ];
  check("ISO strings from the API count too", countActivationQsos(wire, "US-4567", noon) === 3, countActivationQsos(wire, "US-4567", noon));
  check("case and stray spaces do not split a park in two", normaliseRef(" us-4567 ") === "US-4567", normaliseRef(" us-4567 "));

  // A row with an unparseable timestamp must be skipped, not counted and not thrown on.
  check(
    "a broken timestamp is skipped rather than counted",
    countActivationQsos([{ mySigInfo: "US-4567", startTime: "not a date" }], "US-4567", noon) === 0,
  );

  const nine = activationProgress(9);
  const ten = activationProgress(10);
  check("nine is an attempt", nine.qualifies === false && nine.remaining === 1, nine);
  check("ten is an activation", ten.qualifies === true && ten.remaining === 0, ten);
  check("past ten, remaining never goes negative", activationProgress(41).remaining === 0);
  check("a nonsense count reads as zero", activationProgress(Number.NaN).count === 0);
}

// ---------------------------------------------------------------------------
console.log("\n2. the query the page sends for that count");
{
  const q = new URLSearchParams(activationCountQuery("us-4567", new Date("2026-08-30T18:00:00Z")));

  // THE ASSERTION THIS SECTION EXISTS FOR. `sigInfo` would answer "how many contacts have
  // I made WITH US-4567 today", which for a hunter is a real number and the wrong one.
  check("filters on mySigInfo", q.get("mySigInfo") === "US-4567", q.get("mySigInfo"));
  check("and NOT on sigInfo", q.get("sigInfo") === null, q.get("sigInfo"));

  check("lower bound is UTC midnight", q.get("from") === "2026-08-30T00:00:00.000Z", q.get("from"));
  // Both ends bounded, so a page left open across UTC midnight describes ONE day rather
  // than accumulating across two.
  check("upper bound is the last millisecond of the same UTC day", q.get("to") === "2026-08-30T23:59:59.999Z", q.get("to"));
  check("asks for the count, not a page of contacts", q.get("take") === "1", q.get("take"));

  // The server-side half of the same rule. Not imported — `lib/db/qso.ts` pulls in Prisma
  // and there is no database here — so it is asserted as text, which proves the clause is
  // written and not that it runs.
  const dbQso = readFileSync(join(root, "lib", "db", "qso.ts"), "utf8");
  check("the where-builder reads mySigInfo", /where\.mySigInfo\s*=\s*q\.mySigInfo/.test(dbQso));
  check("the list query schema accepts it", /mySigInfo:/.test(readFileSync(join(root, "lib", "validation", "qso.ts"), "utf8")));
}

// ---------------------------------------------------------------------------
console.log("\n3. the activation session, which outlives the contact draft");
{
  check("the key is namespaced and versioned", ACTIVATION_KEY === "digishack:activation:v1", ACTIVATION_KEY);
  // A SECOND KEY, not a draft field, and the distinction is structural: the draft is
  // cleared by every successful save — it has to be, or it is offered back as an unlogged
  // contact and logged twice — while an activation has to outlive forty saves.
  check("and is NOT the draft key", (ACTIVATION_KEY as string) !== (QSO_DRAFT_KEY as string));

  const session: ActivationSession = {
    v: ACTIVATION_VERSION,
    sig: "POTA",
    ref: "US-4567",
    grid: "EN61BX",
    startedAt: "2026-08-30T13:00:00.000Z",
  };
  const back = parseActivation(serialiseActivation(session));
  check("a session round-trips", JSON.stringify(back) === JSON.stringify(session), back);

  // NEVER THROWS, for any input. This runs inside a mount effect on the logging page: an
  // exception here takes the page down at the moment the operator is trying to log.
  const junk: [string, string | null | undefined][] = [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["not json", "{oh no"],
    ["an array", "[1,2,3]"],
    ["a bare number", "42"],
    ["a string", '"US-4567"'],
    ["a future version", '{"v":99,"ref":"US-4567"}'],
    ["no reference", '{"v":1,"sig":"POTA","grid":"EN61"}'],
    ["a blank reference", '{"v":1,"ref":"   "}'],
    ["a reference of the wrong type", '{"v":1,"ref":["US-4567"]}'],
    ["nested nonsense", '{"v":1,"ref":{"a":{"b":{"c":1}}}}'],
  ];
  let threw: unknown = null;
  for (const [label, raw] of junk) {
    let got: ActivationSession | null = null;
    try {
      got = parseActivation(raw);
    } catch (e) {
      threw = e;
    }
    check(`${label} parses to null without throwing`, threw === null && got === null, threw ?? got);
  }

  // A session with no reference is not a session: a programme name alone, or a grid alone,
  // would light the counter for an activation of nothing.
  check("a reference is what makes it a session", parseActivation('{"v":1,"ref":"us-4567"}')?.ref === "US-4567");
  check("the programme defaults to POTA when it went missing", parseActivation('{"v":1,"ref":"US-4567"}')?.sig === "POTA");
  check("a missing grid is empty, not undefined", parseActivation('{"v":1,"ref":"US-4567"}')?.grid === "");

  // Values -> session -> values, the path the form and storage actually take.
  const v: QsoFormValues = { ...emptyValues(), mySig: "pota", mySigInfo: "us-4567", myGridSquare: "en61bx" };
  const fromValues = activationFromValues(v);
  check("a form with a reference yields a session", fromValues?.ref === "US-4567", fromValues);
  check("and upper-cases as it goes", fromValues?.sig === "POTA" && fromValues?.grid === "EN61BX", fromValues);
  check("a form without one yields null", activationFromValues(emptyValues()) === null);
  check("a form with only a grid is NOT an activation", activationFromValues({ ...emptyValues(), myGridSquare: "EN61" }) === null);

  const applied = applyActivation(emptyValues(), session);
  check("applying a session fills the three fields", applied.mySig === "POTA" && applied.mySigInfo === "US-4567" && applied.myGridSquare === "EN61BX", applied);
  const cleared = applyActivation(applied, null);
  check("applying null clears them", cleared.mySigInfo === "" && cleared.mySig === "" && cleared.myGridSquare === "");
  check("and touches nothing else", cleared.callsign === "" && cleared.mode === applied.mode);

  // The activation is a SESSION field, so a form holding only an activation is not a
  // contact in progress. Without this, merely opening the page with an activation set
  // would write a draft and then offer it back as an unlogged contact.
  check("an activation alone is not a contact in progress", hasContactContent(applied) === false, applied);
  check("but a callsign on top of it is", hasContactContent({ ...applied, callsign: "K1ABC" }) === true);
}

// ---------------------------------------------------------------------------
console.log("\n4. storage: no localStorage, then a real one");
{
  // Node has no `window` — the same branch a blocked or absent store takes in the browser
  // (Safari private mode, Firefox with site data blocked, a full quota). Nothing may
  // throw, and a failed write must report failure rather than pretend.
  let threw: unknown = null;
  let wrote = true;
  let read: unknown = "not run";
  try {
    read = readActivation();
    wrote = writeActivation({ v: 1, sig: "POTA", ref: "US-4567", grid: "", startedAt: "" });
    clearActivation();
  } catch (e) {
    threw = e;
  }
  check("readActivation does not throw with no localStorage", threw === null, threw);
  check("it returns null", read === null, read);
  check("writeActivation reports FALSE rather than claiming success", wrote === false);
  check("clearActivation does not throw", threw === null, threw);
}
{
  // Now with a store, which is what the browser actually has. This is the tab-discard
  // case: write, throw the page away, read it back into a fresh form.
  const map = new Map<string, string>();
  const memory = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, val: string) => void map.set(k, String(val)),
  };
  (globalThis as { window?: unknown }).window = { localStorage: memory };

  const started = new Date("2026-08-30T13:00:00.000Z").toISOString();
  check(
    "a session writes",
    writeActivation({ v: 1, sig: "POTA", ref: "US-4567", grid: "EN61BX", startedAt: started }) === true,
  );
  check("under its own key", map.has(ACTIVATION_KEY), [...map.keys()]);

  // The tab is discarded here. A fresh form comes back with the activation still set.
  const recovered = readActivation();
  check("it survives a tab discard", recovered?.ref === "US-4567", recovered);
  check("with the grid", recovered?.grid === "EN61BX", recovered);
  check("and with when it started", recovered?.startedAt === started, recovered);
  const restoredForm = applyActivation(emptyValues(), recovered);
  check("and lands back in an empty form", restoredForm.mySigInfo === "US-4567", restoredForm);
  check("without inventing a contact", hasContactContent(restoredForm) === false);

  // Ending an activation is clearing the reference. One path, so the form and storage
  // cannot disagree about whether the operator is still in the park.
  check("an empty reference ends the session", writeActivation({ v: 1, sig: "POTA", ref: "  ", grid: "", startedAt: started }) === false);
  check("and removes it from storage", readActivation() === null, [...map.keys()]);

  // Corrupt storage is dropped rather than handed to `parseActivation` on every mount for
  // the life of the profile.
  map.set(ACTIVATION_KEY, "{not json");
  check("unreadable storage reads as no activation", readActivation() === null);
  check("and is cleaned up", map.has(ACTIVATION_KEY) === false, [...map.keys()]);

  delete (globalThis as { window?: unknown }).window;
}

// ---------------------------------------------------------------------------
console.log("\n5. the session carries across a save; the reports do not");
{
  // A contact just logged, mid-activation, mid-run.
  const logged: QsoFormValues = {
    ...emptyValues(),
    callsign: "K1ABC",
    freqMHz: "14.074",
    band: "20M",
    mode: "FT8",
    rstSent: "-08",
    rstRcvd: "-14",
    gridSquare: "FN42",
    name: "Matt",
    notes: "gave him a 599",
    sig: "POTA",
    sigInfo: "US-0765",
    stationId: "st_1",
    operatorId: "op_1",
    mySig: "POTA",
    mySigInfo: "US-4567",
    myGridSquare: "EN61BX",
  };

  const next = carrySession(logged);

  // THE POINT OF THE WHOLE FEATURE. Re-typing "US-4567" forty times is not a workflow, and
  // the fortieth time it is mistyped the ADIF file stops proving the activation.
  check("the activation reference carries", next.mySigInfo === "US-4567", next.mySigInfo);
  check("the activation programme carries", next.mySig === "POTA", next.mySig);
  check("the portable grid carries", next.myGridSquare === "EN61BX", next.myGridSquare);

  // The existing run-logging behaviour, unchanged. These are what make the form usable
  // during a pileup and they must not have regressed.
  check("the station carries", next.stationId === "st_1");
  check("the operator carries", next.operatorId === "op_1");
  check("frequency, band and mode carry", next.freqMHz === "14.074" && next.band === "20M" && next.mode === "FT8");

  // And the per-contact half is gone. A signal report inherited from the last contact is
  // how a log quietly fills with wrong numbers.
  check("the callsign is cleared", next.callsign === "", next.callsign);
  // Back to the mode's default, and specifically NOT the report just given. Inheriting
  // "-08" for the next caller is how a log quietly fills with numbers nobody sent.
  const modeDefault = emptyValues().rstSent;
  check("RST SENT is NOT carried", next.rstSent !== "-08" && next.rstSent === modeDefault, next.rstSent);
  check("RST RCVD is NOT carried", next.rstRcvd !== "-14" && next.rstRcvd === emptyValues().rstRcvd, next.rstRcvd);
  check("their grid is cleared", next.gridSquare === "");
  check("their name is cleared", next.name === "");
  check("the notes are cleared", next.notes === "");
  // THEIR park is per-contact — the next caller is at a different one, or at none.
  check("THEIR reference is cleared", next.sigInfo === "" && next.sig === "", [next.sig, next.sigInfo]);
  check("and the emptied form is not a contact in progress", hasContactContent(next) === false, next);

  // Forty contacts of an activation: the reference must still be there at the end.
  let running = logged;
  for (let i = 0; i < 40; i++) running = carrySession({ ...running, callsign: `K1AB${i % 10}` });
  check("still set after forty saves", running.mySigInfo === "US-4567", running.mySigInfo);

  // What actually goes on the wire.
  const body = toRequestBody(logged);
  check("the request body carries MY_SIG", body.mySig === "POTA", body.mySig);
  check("the request body carries MY_SIG_INFO", body.mySigInfo === "US-4567", body.mySigInfo);
  check("the request body carries MY_GRIDSQUARE", body.myGridSquare === "EN61BX", body.myGridSquare);
  // Their park and our park travel separately and both survive.
  check("and THEIR park is still separate on the wire", body.sigInfo === "US-0765", body.sigInfo);
  check("an empty activation sends null, not an empty string", toRequestBody(emptyValues()).mySigInfo === null);
}

// ---------------------------------------------------------------------------
console.log("\n6. ADIF: the export POTA will accept, and back again");

/** A contact made while activating US-4567, as the database holds it. */
const activationRow: QsoRowForAdif = {
  callsign: "K1ABC",
  band: "20M",
  freqHz: 14_074_000n,
  mode: "FT8",
  startTime: new Date("2026-08-30T14:12:00Z"),
  endTime: null,
  rstSent: "-08",
  rstRcvd: "-14",
  gridSquare: "FN42",
  txPowerW: null,
  name: null,
  qth: null,
  dxcc: 291,
  state: "MA",
  county: null,
  cqZone: 5,
  ituZone: 8,
  iota: null,
  continent: "NA",
  // THEIR park is null here: an ordinary hunter calling an activator is not himself in a
  // park. Both being set at once is the park-to-park case, checked below.
  sig: null,
  sigInfo: null,
  sigRefs: [],
  mySig: "POTA",
  mySigInfo: "US-4567",
  // The operator is NOT at home — that is the entire point of the field.
  myGridSquare: "EN52AB",
  qslSent: "NONE",
  qslRcvd: "NONE",
  qslSentAt: null,
  qslRcvdAt: null,
  lotwSent: false,
  lotwRcvd: false,
  eqslSent: false,
  eqslRcvd: false,
  notes: null,
  station: { callsign: "K9XYZ", grid: "EN61" },
  operator: { callsign: "K9XYZ" },
};

{
  const record = adifRecord(toAdifInput(activationRow));

  // POTA's activation upload requires all of these on every record. A file missing any of
  // them is a hunter log, and POTA credits the contacts to the other side of the exchange
  // or refuses them — which is what every export from this program was until now.
  for (const tag of ["MY_SIG", "MY_SIG_INFO", "MY_GRIDSQUARE", "STATION_CALLSIGN", "OPERATOR"]) {
    check(`the record carries ${tag}`, new RegExp(`<${tag}:\\d+>`).test(record), record);
  }
  check("MY_SIG is the programme", record.includes("<MY_SIG:4>POTA"), record);
  check("MY_SIG_INFO is our reference", record.includes("<MY_SIG_INFO:7>US-4567"), record);

  // THE PRECEDENCE THAT MAKES THE COLUMN WORTH HAVING. `station.grid` is the HOME grid;
  // exporting it for a contact made in a park is a false statement about where the signal
  // came from, and POTA and LoTW both read this field.
  check("MY_GRIDSQUARE is where the operator WAS", record.includes("<MY_GRIDSQUARE:6>EN52AB"), record);
  check("and NOT the station's home grid", record.includes("EN61") === false, record);

  // Their park and our park are separate tags and must not be confused on the way out.
  check("no SIG is emitted for a contact that had none", /<SIG:/.test(record) === false, record);

  const { qsos, problems } = parseAdif(record);
  check("it parses back as one record", qsos.length === 1 && problems.length === 0, { qsos: qsos.length, problems });
  const r = qsos[0]!;
  check("MY_SIG re-imports", r.mySig === "POTA", r.mySig);
  check("MY_SIG_INFO re-imports", r.mySigInfo === "US-4567", r.mySigInfo);
  check("MY_GRIDSQUARE re-imports", r.myGridSquare === "EN52AB", r.myGridSquare);
  // The round trip that matters for a restore: an exported activation must come back an
  // activation, not an ordinary contact.
  check("it is still recognisably an activation", r.mySigInfo === activationRow.mySigInfo);
  check("and THEIR park is still absent", r.sigInfo === null && r.sigRefs.length === 0, [r.sigInfo, r.sigRefs]);
}

{
  // PARK-TO-PARK: we are at US-4567, they are at US-0765 and US-2258. All four fields set
  // at once, which is the case where confusing the two pairs loses half the contact.
  const p2p = adifRecord(
    toAdifInput({ ...activationRow, sig: "POTA", sigInfo: "US-0765", sigRefs: [
      { sigInfo: "US-0765", primary: true },
      { sigInfo: "US-2258", primary: false },
    ] }),
  );
  check("park-to-park: our reference is MY_SIG_INFO", p2p.includes("<MY_SIG_INFO:7>US-4567"), p2p);
  check("park-to-park: their reference is SIG_INFO", p2p.includes("<SIG_INFO:7>US-0765"), p2p);
  check("park-to-park: their extra park still rides in the APP_ field", p2p.includes("US-0765,US-2258"), p2p);

  const back = parseAdif(p2p).qsos[0]!;
  check("park-to-park: our park comes back as ours", back.mySigInfo === "US-4567", back.mySigInfo);
  check("park-to-park: their park comes back as theirs", back.sigInfo === "US-0765", back.sigInfo);
  check("park-to-park: both of their parks survive", back.sigRefs.join(",") === "US-0765,US-2258", back.sigRefs);
}

{
  // THE BACK CATALOGUE: 29,800 contacts have none of these columns. Their export must not
  // change by so much as a byte, or every historical file this program produced becomes a
  // different file.
  const home: AdifQsoInput = toAdifInput({
    ...activationRow,
    mySig: null,
    mySigInfo: null,
    myGridSquare: null,
    dxcc: 291,
  });
  const record = adifRecord(home);
  check("no MY_SIG is emitted when there was no activation", /<MY_SIG:/.test(record) === false, record);
  check("no MY_SIG_INFO either", /<MY_SIG_INFO:/.test(record) === false, record);
  // MY_GRIDSQUARE FALLS THROUGH rather than disappearing — it has always been exported
  // from the station, and dropping it would break LoTW for the entire existing log.
  check("MY_GRIDSQUARE falls back to the station's grid", record.includes("<MY_GRIDSQUARE:4>EN61"), record);

  const r = parseAdif(record).qsos[0]!;
  check("re-imports with no activation", r.mySig === null && r.mySigInfo === null, [r.mySig, r.mySigInfo]);
  check("and reads the station grid back as MY_GRIDSQUARE", r.myGridSquare === "EN61", r.myGridSquare);
}

{
  // A malformed locator is dropped rather than stored. It would otherwise be exported
  // onward as fact, and a grid wrong by one character places the activation in the wrong
  // square just as confidently as a right one.
  const bad = parseAdif("<CALL:5>K1ABC<QSO_DATE:8>20260830<TIME_ON:6>141200<BAND:3>20M<MODE:3>FT8<MY_GRIDSQUARE:5>ZZ99Z<EOR>").qsos[0]!;
  check("a malformed MY_GRIDSQUARE is dropped, not stored", bad.myGridSquare === null, bad.myGridSquare);
  const good = parseAdif("<CALL:5>K1ABC<QSO_DATE:8>20260830<TIME_ON:6>141200<BAND:3>20M<MODE:3>FT8<MY_GRIDSQUARE:6>en52ab<EOR>").qsos[0]!;
  check("a lower-case one is accepted and upper-cased", good.myGridSquare === "EN52AB", good.myGridSquare);
}

// ---------------------------------------------------------------------------
console.log("\n7. the columns and the index, as DECLARED");
{
  // Text assertions. They prove the schema and the migration say the right thing. They
  // prove NOTHING about the live database — see the note at the top of this file.
  const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
  const migration = readFileSync(
    join(root, "prisma", "migrations", "20260830120000_qso_my_activation", "migration.sql"),
    "utf8",
  );
  // The statements only. The comment block above them discusses `NOT NULL DEFAULT ''` as
  // a shape that was REJECTED, and an assertion that grepped the whole file would read
  // the explanation as the thing it is warning about.
  const sql = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  check("schema declares Qso.mySig", /\n\s*mySig\s+String\?/.test(schema));
  check("schema declares Qso.mySigInfo", /\n\s*mySigInfo\s+String\?/.test(schema));
  check("schema declares Qso.myGridSquare", /\n\s*myGridSquare\s+String\?/.test(schema));

  // NULLABLE IS LOAD-BEARING. 29,800 existing contacts backfill as NULL and are untouched,
  // and NULL is a meaning here — "this was not our activation" — rather than an absence.
  check("all three are nullable", /mySig\s+String\?/.test(schema) && /mySigInfo\s+String\?/.test(schema) && /myGridSquare\s+String\?/.test(schema));
  // No `@default`. A default would give 29,800 existing rows a value they did not have,
  // and for `myGridSquare` that value could only be a guess about where somebody was.
  check(
    "none carries a default",
    ["mySig", "mySigInfo", "myGridSquare"].every(
      (f) => !new RegExp(`\\n\\s*${f}\\s+String\\?[^\\n]*@default`).test(schema),
    ),
  );
  check("widths match the fields they mirror", /mySig\s+String\?\s+@db\.VarChar\(32\)/.test(schema) && /mySigInfo\s+String\?\s+@db\.VarChar\(32\)/.test(schema) && /myGridSquare\s+String\?\s+@db\.VarChar\(12\)/.test(schema));

  check("the composite index is declared", /@@index\(\[mySigInfo, startTime\]\)/.test(schema));
  check("in that order — equality first, range second", /@@index\(\[mySigInfo, startTime\]\)/.test(schema) && !/@@index\(\[startTime, mySigInfo\]\)/.test(schema));

  check("the migration adds all three columns", /ADD COLUMN `mySig` VARCHAR\(32\) NULL/.test(sql) && /ADD COLUMN `mySigInfo` VARCHAR\(32\) NULL/.test(sql) && /ADD COLUMN `myGridSquare` VARCHAR\(12\) NULL/.test(sql));
  check("every column is NULL, none NOT NULL", /NOT NULL/.test(sql) === false, sql.match(/NOT NULL/g));
  // A backfill from Station.grid would assert about tens of thousands of contacts that the
  // operator was at home, and afterwards nothing would distinguish a guess from a fact.
  check("the migration backfills nothing", /UPDATE\s+`?Qso`?/i.test(sql) === false);
  check("the migration creates the composite index", /CREATE INDEX `Qso_mySigInfo_startTime_idx` ON `Qso`\(`mySigInfo`, `startTime`\)/.test(sql));
  check("it is not unique — an activation is many contacts at one reference", /CREATE UNIQUE INDEX/.test(sql) === false);
  // The one thing a reader of this migration must not miss.
  check("the migration says out loud that it has never been executed", /HAS NOT BEEN EXECUTED/.test(migration));
}

console.log(
  failures === 0
    ? "\nAll activation checks passed.\n"
    : `\n${failures} ACTIVATION CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

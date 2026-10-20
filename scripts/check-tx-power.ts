/* eslint-disable no-console */
// Measured transmit power.
//
// The number this produces goes onto a QSL card and into an ADIF export as a factual
// claim about a contact. It also goes to QRZ, Club Log and Cloudlog. Getting the
// scaling wrong would not fail loudly anywhere — it would just publish a wrong
// figure, which is the argument for pinning the conversion here.

import {
  applyNoPowerVerdict,
  dbmToWatts,
  NO_POWER_TAG,
  NoPowerWatch,
  roundWatts,
  TxPowerTracker,
  UNMETERED_TAG,
  type NoPowerVerdict,
} from "@/lib/radio/power";

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
function near(a: number, b: number, tol: number, label: string): void {
  ok(Math.abs(a - b) <= tol, label, `got ${a}, want ${b} ±${tol}`);
}

console.log("\ndBm to watts");
{
  near(dbmToWatts(30), 1, 1e-9, "30 dBm is 1 W — the definition");
  near(dbmToWatts(50), 100, 1e-6, "50 dBm is 100 W");
  near(dbmToWatts(0), 0.001, 1e-9, "0 dBm is 1 mW");
  near(dbmToWatts(60), 1000, 1e-4, "60 dBm is 1 kW");
  // The live verification recorded in lib/flex/dax.ts: FWDPWR raw 6342, with the
  // slider at 85 %. If this drifts, the meter scaling has been changed and every
  // logged power goes wrong with it.
  //
  // That note reads "6342 = 49.5 dBm ≈ 89 W", which rounds the dBm before
  // converting. The raw value is 49.546875 dBm and converts to 90.1 W — the two
  // figures are the same measurement, and asserting both keeps the note honest
  // without pretending the rounded one is what the meter said.
  near(dbmToWatts(49.5), 89, 0.5, "49.5 dBm — the note's rounded figure — is ~89 W");
  near(dbmToWatts(6342 / 128), 90.1, 0.3, "the raw meter value itself is ~90 W");
  near(dbmToWatts(49.03), 80, 1, "80 W reads about 49 dBm");
}

console.log("\nrounding the way an operator writes it");
{
  ok(roundWatts(87.34) === 87, "whole watts above 10");
  ok(roundWatts(99.6) === 100, "rounding up");
  // A QRP contact is the whole point of a QRP contact. Rounding 2.5 W to 3, or
  // 0.5 W to either 0 or 1, misreports it.
  ok(roundWatts(2.54) === 2.5, "one decimal below 10 W");
  ok(roundWatts(0.5) === 0.5, "half a watt survives");
  ok(roundWatts(0.47) === 0.5, "and rounds sensibly");
}

console.log("\ntracking one contact");
{
  const t = new TxPowerTracker();
  ok(t.watts() === null, "nothing measured yet reports null, not zero");

  // FT8 is constant-envelope: the transmitter sits at full output for 12.6 s, and
  // the low samples are the key-up and key-down ramps. The PEAK is the steady state;
  // averaging the ramps in would under-report every contact.
  t.sample(20); // ramp up, 0.1 W
  t.sample(49); // steady, ~79 W
  t.sample(49.03);
  t.sample(35); // ramp down
  near(t.watts()!, 80, 1, "the peak is the steady-state output, not the mean");

  t.reset();
  ok(t.watts() === null, "reset clears it for the next contact");
}

console.log("\nreadings that must not become a logged power");
{
  const t = new TxPowerTracker();
  // Receive: the source sends null precisely so a stale TX reading cannot be
  // mistaken for a live one.
  t.sample(null);
  t.sample(undefined);
  ok(t.watts() === null, "nulls on receive are ignored");

  t.sample(Number.NaN);
  t.sample(Number.POSITIVE_INFINITY);
  ok(t.watts() === null, "NaN and Infinity are not powers");

  // A corrupt meter packet decodes to an enormous dBm. Publishing that would claim
  // an illegal station on a QSL card.
  t.sample(70); // 10 kW
  ok(t.watts() === null, "an implausible reading is rejected, not clamped");

  // The tail of a transmission is not a QRP contact.
  const t2 = new TxPowerTracker();
  t2.sample(10); // 0.01 W
  ok(t2.watts() === null, "a near-zero reading is the ramp, not a contact");

  // ...but a genuine QRP station must still register.
  const t3 = new TxPowerTracker();
  t3.sample(27); // ~0.5 W
  near(t3.watts()!, 0.5, 0.05, "a real half-watt QRP signal IS recorded");
}

console.log("\nthe boundary between a valid and a rejected reading");
{
  const hi = new TxPowerTracker();
  hi.sample(63); // ~2000 W, at the ceiling
  ok(hi.watts() !== null, "2 kW is accepted — a legal amateur station can run 1.5 kW");
  const tooHi = new TxPowerTracker();
  tooHi.sample(65); // ~3.1 kW
  ok(tooHi.watts() === null, "3 kW is not");
}

// Keyed with nothing out. The readings are the ones measured on the K9XYZ FLEX-6400:
// FWDPWR sits at 0.0 dBm on receive, reads 1.6 dBm on the first packet after the key and
// 49.1 dBm (81 W) from then on.
function span(w: NoPowerWatch, at: number, ms: number, dbm: (number | null)[]): NoPowerVerdict | null {
  w.keyed(at);
  for (const d of dbm) w.sample(d);
  return w.unkeyed(at + ms);
}
const T = 1_792_520_000_000;
const RX = Array<number>(40).fill(0);

console.log("\nkeyed with no power out");
{
  const w = new NoPowerWatch();
  const good = span(w, T, 12_640, [1.6, ...Array<number>(45).fill(49.1)]);
  ok(good?.kind === "powered", "an FT8 transmission at 81 W made power");

  // 2026-10-20 13:27: keyed 30.9 s, the meter reporting 0.0 dBm throughout, and not one
  // PSKReporter spot or completed contact for the whole stretch. A real fault, and the
  // alarm must still fire for it.
  const dead = span(w, T, 30_900, RX);
  ok(dead?.kind === "no-power", "keyed 30.9 s with the meter at 0.0 dBm is NO POWER OUT", JSON.stringify(dead));
  ok(dead?.heldMs === 30_900, "and reports how long it was keyed");
  ok(dead?.carrier === false, "and is not mistaken for a tune");

  // The key-up edge alone is not power.
  const edge = span(w, T, 12_640, [1.6, 0, 0, 0]);
  ok(edge?.kind === "no-power", "1.6 dBm (1.4 mW) at the key-up is not power out");

  // A reading taken before the key belongs to the previous transmission.
  w.sample(49.1);
  const late = span(w, T, 12_640, RX);
  ok(late?.kind === "no-power", "a reading from before the key does not count for it");

  ok(w.unkeyed(T) === null, "an unkey with no key seen has nothing to judge");
}

console.log("\nnot an alarm");
{
  const w = new NoPowerWatch();
  // No FWDPWR meter found, or the meter stream stopped with the DAX stream: the source
  // sends null. That is not a reading of zero, and must not say the transmitter is broken.
  const blind = span(w, T, 12_640, Array<null>(40).fill(null));
  ok(blind?.kind === "unmetered", "a transmission the meter never reported on is unmetered, not no-power", JSON.stringify(blind));
  const corrupt = span(w, T, 12_640, [70, 70]);
  ok(corrupt?.kind === "unmetered", "a corrupt 10 kW packet is not a reading either");

  // An ATU relay cycle or a keying blip.
  const blip = span(w, T, 1_500, [0, 0]);
  ok(blip?.kind === "short", "1.5 s keyed is too short to judge");

  // The Rig page Tune: noted, then the radio reports the key a round trip later, and the
  // bridge ends it at TUNE_MAX_MS. 10 W of tune power is 40 dBm.
  w.carrier(T - 80);
  const tune = span(w, T, 30_900, [0, ...Array<number>(100).fill(40)]);
  ok(tune?.kind === "powered", "a 30.9 s Tune carrier at 10 W is powered");
  ok(tune?.carrier === true, "and is known to be a tune carrier");

  // QRP is power.
  const qrp = span(w, T, 12_640, Array<number>(40).fill(27));
  ok(qrp?.kind === "powered", "half a watt is power out");
}

console.log("\ntune and ATU carriers that make nothing");
{
  const w = new NoPowerWatch();
  w.carrier(T - 50);
  const tune = span(w, T, 30_000, RX);
  ok(tune?.kind === "no-power" && tune.carrier, "a Tune carrier at 0 W is still a fault, and is marked as a tune");

  // The note is used once, and an old one does not reach a later transmission.
  const next = span(w, T + 60_000, 12_640, RX);
  ok(next?.kind === "no-power" && !next.carrier, "the next transmission is not called a tune");
  w.carrier(T);
  const later = span(w, T + 60_000, 12_640, RX);
  ok(later !== null && !later.carrier, "a Tune request a minute before the key is not what keyed it");
}

console.log("\nthe warning raises, replaces and clears");
{
  const alarm = (s: string) => `Keyed ${s} with ${NO_POWER_TAG}`;
  const power = "RF power is 90% — consider lowering it for a first test";
  const w = new NoPowerWatch();

  let list = [power];
  list = applyNoPowerVerdict(list, span(w, T, 30_900, RX), alarm("30.9s"));
  ok(list[0] === alarm("30.9s") && list.includes(power), "a no-power verdict raises the alarm and keeps the others");
  list = applyNoPowerVerdict(list, span(w, T, 21_600, RX), alarm("21.6s"));
  ok(
    list.filter((x) => x.includes(NO_POWER_TAG)).length === 1 && list[0] === alarm("21.6s"),
    "a second one replaces the first rather than stacking",
  );

  const kept = applyNoPowerVerdict(list, span(w, T, 12_640, Array<null>(40).fill(null)), alarm("12.6s"));
  ok(kept === list, "an unmetered transmission leaves the list exactly as it was");
  ok(applyNoPowerVerdict(list, span(w, T, 900, RX), alarm("0.9s")) === list, "so does a blip");
  ok(applyNoPowerVerdict(list, null, alarm("?")) === list, "and an unkey with nothing to judge");

  // 15:45:38 the last alarm; 15:45:45 PSKReporter spots resume. The alarm was still on
  // the Rig page at the 15:59 restart, because nothing ever took it down.
  list = applyNoPowerVerdict(list, span(w, T, 12_640, [1.6, ...Array<number>(45).fill(49.1)]), alarm("12.6s"));
  ok(!list.some((x) => x.includes(NO_POWER_TAG)), "the first transmission that makes power clears it", JSON.stringify(list));
  ok(list.length === 1 && list[0] === power, "and leaves every other warning alone");

  const quiet = [power];
  ok(applyNoPowerVerdict(quiet, span(w, T, 12_640, Array<number>(40).fill(49.1)), alarm("x")) === quiet, "a good transmission with no alarm up changes nothing");
}

// 2026-10-20 11:49: the radio's whole UDP feed stopped - receive audio, panadapter, meters -
// while the hunt kept transmitting. Not a NO POWER OUT, but not nothing either.
console.log("\nkeyed blind");
{
  const note = (s: string) => `Keyed ${s} and the forward-power meter never reported - ${UNMETERED_TAG}`;
  const alarm = (s: string) => `Keyed ${s} with ${NO_POWER_TAG}`;
  const power = "RF power is 90% — consider lowering it for a first test";
  const blind = Array<null>(40).fill(null);
  const w = new NoPowerWatch();

  let list = applyNoPowerVerdict([power], span(w, T, 12_640, blind), note("12.6s"));
  ok(list[0] === note("12.6s") && list.includes(power), "an unmeasured transmission puts up a note", JSON.stringify(list));
  ok(!list.some((x) => x.includes(NO_POWER_TAG)), "  which is not the NO POWER OUT alarm");
  list = applyNoPowerVerdict(list, span(w, T, 12_640, blind), note("12.7s"));
  ok(list.filter((x) => x.includes(UNMETERED_TAG)).length === 1, "  and replaces itself rather than stacking", JSON.stringify(list));
  list = applyNoPowerVerdict(list, span(w, T, 30_900, RX), alarm("30.9s"));
  ok(list[0] === alarm("30.9s") && !list.some((x) => x.includes(UNMETERED_TAG)), "a real no-power verdict takes its place");
  const held = applyNoPowerVerdict(list, span(w, T, 12_640, blind), note("12.6s"));
  ok(held === list, "an unmeasured transmission never takes down a real alarm");
  list = applyNoPowerVerdict(
    applyNoPowerVerdict([power], span(w, T, 12_640, blind), note("12.6s")),
    span(w, T, 12_640, Array<number>(40).fill(49.1)),
    alarm("x"),
  );
  ok(list.length === 1 && list[0] === power, "and a transmission that makes power clears the note", JSON.stringify(list));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

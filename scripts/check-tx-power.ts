/* eslint-disable no-console */
// Measured transmit power.
//
// The number this produces goes onto a QSL card and into an ADIF export as a factual
// claim about a contact. It also goes to QRZ, Club Log and Cloudlog. Getting the
// scaling wrong would not fail loudly anywhere — it would just publish a wrong
// figure, which is the argument for pinning the conversion here.

import { dbmToWatts, roundWatts, TxPowerTracker } from "@/lib/radio/power";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

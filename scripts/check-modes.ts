// Modulation: what to send the radio, and what to use on a frequency.
//
// Every failure here is silent. A modulation the radio does not recognise is ignored and the
// picker springs back; a data flag set the wrong way produces a radio that keys and transmits
// nothing; the wrong sideband is inaudible rather than wrong-looking. None of it throws.

import {
  digitalCallingFrequency,
  fromCivMode,
  fromFlexMode,
  isDataModulation,
  MODULATIONS,
  modulationForFrequency,
  nearestDigitalFrequency,
  toCivMode,
  toFlexMode,
} from "@/lib/radio/modes";

let pass = 0;
let fail = 0;

function ok(cond: boolean, what: string, detail = ""): void {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`); }
}
function eq(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `got ${a}, want ${b}`);
}

console.log("\nthe data flag, which decides whether the microphone exists");
{
  // The bug this replaces: USB, DIGU and USB-D were all answered with setDataMode(), so
  // asking for plain USB put the radio in USB-D and the microphone stopped working.
  eq(toCivMode("USB"), { mode: "USB", data: false }, "USB is USB with data OFF");
  eq(toCivMode("USB-D"), { mode: "USB", data: true }, "USB-D is USB with data ON");
  eq(toCivMode("DIGU"), { mode: "USB", data: true }, "DIGU is SmartSDR's name for the same");
  eq(toCivMode("LSB"), { mode: "LSB", data: false }, "LSB with data off");
  eq(toCivMode("DIGL"), { mode: "LSB", data: true }, "and DIGL with it on");
  eq(toCivMode("CW"), { mode: "CW", data: false }, "CW");
  eq(toCivMode("AM"), { mode: "AM", data: false }, "AM");
  eq(toCivMode("FM"), { mode: "FM", data: false }, "FM");
  eq(toCivMode("RTTY"), { mode: "RTTY", data: false }, "RTTY");
  eq(toCivMode("lsb"), { mode: "LSB", data: false }, "case does not matter");

  // Refused rather than guessed. A radio sent a mode byte for something it does not have
  // answers NG at best and does something unexpected at worst.
  eq(toCivMode("DV"), null, "a mode this map does not cover is refused, not guessed");
  eq(toCivMode(""), null, "and so is nothing");

  ok(isDataModulation("USB-D"), "USB-D is a data mode");
  ok(!isDataModulation("USB"), "USB is not");
  ok(!isDataModulation("nonsense"), "and an unknown name is not assumed to be one");
}

console.log("\nreading a mode back");
{
  eq(fromCivMode("USB", true), "USB-D", "USB plus data reads as USB-D");
  eq(fromCivMode("USB", false), "USB", "and without it, USB");
  eq(fromCivMode("LSB", true), "LSB-D", "LSB likewise");
  // Round trip: every name the picker offers must survive being sent and read back, or the
  // picker will show something it cannot select.
  for (const m of MODULATIONS) {
    const civ = toCivMode(m);
    ok(civ !== null, `${m} is one the radio can be asked for`);
    if (civ) eq(fromCivMode(civ.mode, civ.data), m, `${m} round-trips`);
  }
}

console.log("\nthe modulation a frequency implies");
{
  // The digital watering holes. Tuning to 14.074 and being left in plain USB is a radio that
  // hears FT8 perfectly and cannot transmit it.
  eq(modulationForFrequency(14_074_000), "USB-D", "14.074 is FT8, so a data mode");
  // USB-D below 10 MHz too. This line used to demand LSB-D "on lower sideband", which is
  // the voice convention — FT8 is upper sideband on every band. The assertion enforced the
  // bug: voice-off on 40 m put the radio in DIGL, and the decoder went silent on inverted
  // audio while the waterfall carried on looking normal.
  eq(modulationForFrequency(7_074_000), "USB-D", "7.074 too — data is USB on every band");
  eq(modulationForFrequency(1_840_000), "USB-D", "even 160m, deep in LSB voice country");
  eq(modulationForFrequency(14_075_500), "USB-D", "and a couple of kHz up is still FT8");

  // Voice, by the convention every other station on the band uses.
  eq(modulationForFrequency(7_200_000), "LSB", "7.200 is lower sideband");
  eq(modulationForFrequency(3_800_000), "LSB", "80m too");
  eq(modulationForFrequency(14_250_000), "USB", "20m voice is upper");
  eq(modulationForFrequency(28_400_000), "USB", "and 10m");
  eq(modulationForFrequency(10_000_000), "USB", "the 10 MHz boundary goes upper");

  // A typo must move the dial at most, never the mode.
  eq(modulationForFrequency(0), null, "zero implies nothing");
  eq(modulationForFrequency(Number.NaN), null, "nor does a non-number");
  eq(modulationForFrequency(99_000_000_000), null, "nor a frequency off the end of the radio");
}

console.log("\nis this a frequency an automatic mode may run on");
{
  // This station transmitted FT8 on 7.200 MHz once — a phone frequency — because a test left
  // the dial there and CQ mode was enabled without anybody checking where the radio was
  // pointing. Nothing refused it: the transmit gate was open, the guards were happy, and the
  // band was legal. An automatic mode is exactly the case where nobody is watching the dial.
  ok(digitalCallingFrequency(14_074_000) === 14_074_000, "14.074 is FT8");
  ok(digitalCallingFrequency(7_074_000) === 7_074_000, "7.074 is FT8");
  ok(digitalCallingFrequency(14_075_000) === 14_074_000, "and a kHz up is still within it");
  ok(digitalCallingFrequency(7_200_000) === null, "7.200 is NOT — that is a phone frequency");
  ok(digitalCallingFrequency(14_250_000) === null, "nor is 14.250");
  ok(digitalCallingFrequency(10_000_000) === null, "nor WWV");

  // FT4 lives elsewhere, so the mode is part of the question.
  ok(digitalCallingFrequency(14_080_000, "FT4") !== null, "14.080 is FT4");
  ok(digitalCallingFrequency(14_080_000, "FT8") === null, "and is not FT8");

  // A refusal that names somewhere to go beats one that only says no.
  eq(nearestDigitalFrequency(7_200_000), 7_074_000, "the nearest FT8 to 7.200 is 7.074");
  eq(nearestDigitalFrequency(14_240_000), 14_074_000, "and to 14.240, 14.074");
  ok(nearestDigitalFrequency(14_074_000) === 14_074_000, "and on frequency, itself");
}

console.log("\ntwo radios, two vocabularies, one picker");
{
  // The FlexRadio calls the data modes DIGU and DIGL. Sending it "USB-D" does nothing, and the
  // endpoint's own pattern allowed letters only, so it was rejected before the radio ever saw
  // it. Every data mode selection on the Flex silently did nothing while the same picker worked
  // on the Icom.
  eq(toFlexMode("USB-D"), "DIGU", "USB-D goes out as DIGU");
  eq(toFlexMode("LSB-D"), "DIGL", "LSB-D as DIGL");
  eq(toFlexMode("USB"), "USB", "plain sidebands pass through");
  eq(toFlexMode("LSB"), "LSB", "both of them");
  eq(toFlexMode("CW"), "CW", "and CW");
  eq(toFlexMode("DIGU"), "DIGU", "SmartSDR's own name survives a round trip");
  eq(toFlexMode("nonsense"), null, "and an unknown name is refused rather than sent");

  // And back, because the panel showed "DIGU" — a value in none of its own options, so the
  // picker fell through to its disabled placeholder and looked broken on one radio only.
  eq(fromFlexMode("DIGU"), "USB-D", "DIGU reads back as USB-D");
  eq(fromFlexMode("DIGL"), "LSB-D", "DIGL as LSB-D");
  eq(fromFlexMode("USB"), "USB", "USB is USB on both radios");
  eq(fromFlexMode(null), null, "and nothing stays nothing");

  // Every name the picker offers must survive the trip to a FlexRadio and back, or the control
  // displays a value it cannot select — which is the bug this pins.
  for (const m of MODULATIONS) {
    const out = toFlexMode(m);
    ok(out !== null, `${m} can be sent to a FlexRadio`);
    if (out) eq(fromFlexMode(out), m, `${m} round-trips through SmartSDR's vocabulary`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

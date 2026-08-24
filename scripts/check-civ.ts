/* eslint-disable no-console */
// CI-V framing, BCD and meter scaling.
//
// This is the documented half of Icom control, so the tests are about the encodings
// that are easy to get subtly wrong: BCD byte order, echo suppression, and the meter
// calibration curves that are piecewise rather than linear.

import {
  setLevel,
  setFunction,
  setAgc,
  readLevel,
  readFunction,
  readAgc,
  LevelSub,
  functionStateFrom,
  FunctionSub,
  agcFrom,
  atuStateFrom,
  atuTune,
  buildFrame,
  CIV_CONTROLLER,
  CIV_DEFAULT_ADDRESS,
  CivMode,
  decodeBcd2,
  decodeFrequency,
  encodeBcd2,
  encodeFrequency,
  isEcho,
  modeWithDataFrom,
  poMeterToWatts,
  parseFrames,
  pttFrom,
  readAtu,
  readFrequency,
  readRfPower,
  rfPowerPercentFrom,
  readMeter,
  MeterSub,
  setFrequency,
  setModeWithData,
  setPtt,
  setRfPower,
  sMeterToDbm,
  sMeterToSUnits,
  wattsToDbm,
  swrFromRaw,
} from "@/lib/icom/civ";

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
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function hex(b: Buffer): string {
  return b.toString("hex");
}

const R = CIV_DEFAULT_ADDRESS["IC-7300"]!;

console.log("\nframing");
{
  eq(R, 0x94, "the IC-7300 answers to 0x94 by default");
  eq(hex(readFrequency(R)), "fefe94e003fd", "read frequency is FE FE 94 E0 03 FD");
  eq(hex(setPtt(R, true)), "fefe94e01c0001fd", "key the transmitter");
  eq(hex(setPtt(R, false)), "fefe94e01c0000fd", "and unkey it");

  const { frames, rest } = parseFrames(Buffer.from("fefe94e003fd", "hex"));
  eq(frames.length, 1, "one frame parses");
  eq(frames[0]?.to, 0x94, "addressed to the radio");
  eq(frames[0]?.from, CIV_CONTROLLER, "from the controller");
  eq(frames[0]?.command, 0x03, "command 0x03");
  eq(rest.length, 0, "nothing left over");
}

console.log("\nframes arriving badly");
{
  // UDP does not promise one frame per datagram and the radio does coalesce them.
  const two = Buffer.from("fefe94e003fd" + "fefee094000040071400fd", "hex");
  const { frames } = parseFrames(two);
  eq(frames.length, 2, "two frames in one datagram both come out");
  eq(frames[1]?.command, 0x00, "the second is a transceive broadcast");

  // A frame split across reads must not be lost or half-parsed.
  const whole = Buffer.from("fefe94e003fd", "hex");
  const a = parseFrames(whole.subarray(0, 4));
  eq(a.frames.length, 0, "an incomplete frame yields nothing");
  eq(a.rest.length, 4, "and is handed back to prepend to the next read");
  const b = parseFrames(Buffer.concat([a.rest, whole.subarray(4)]));
  eq(b.frames.length, 1, "rejoined, it parses");

  // Leading rubbish before the preamble is skipped rather than derailing everything.
  const noisy = parseFrames(Buffer.from("00112233fefe94e003fd", "hex"));
  eq(noisy.frames.length, 1, "junk before FE FE is skipped");
}

console.log("\necho suppression");
{
  // CI-V is a bus and the radio echoes what it hears. Treating an echo as a reply
  // means every read returns the value just written, so a frequency read confirms
  // whatever was last set rather than where the radio actually is.
  const sent = parseFrames(setFrequency(R, 14_074_000)).frames[0]!;
  ok(isEcho(sent), "our own command coming back is recognised as an echo");

  const fromRadio = parseFrames(
    buildFrame({ to: CIV_CONTROLLER, from: R, command: 0x03, data: encodeFrequency(14_074_000) }),
  ).frames[0]!;
  ok(!isEcho(fromRadio), "a genuine reply from the radio is not");
}

console.log("\nfrequency BCD");
{
  // Little-endian, two decimal digits per byte. 14.074 MHz is the FT8 watering hole
  // and the number most likely to be eyeballed in a packet capture.
  eq(hex(encodeFrequency(14_074_000)), "0040071400", "14.074 MHz encodes to 00 40 07 14 00");
  eq(decodeFrequency(encodeFrequency(14_074_000)), 14_074_000, "and round-trips");

  eq(hex(encodeFrequency(7_074_000)), "0040070700", "40 m");
  eq(hex(encodeFrequency(50_313_000)), "0030315000", "6 m");
  eq(hex(encodeFrequency(1_840_000)), "0000840100", "160 m");
  eq(decodeFrequency(encodeFrequency(1)), 1, "one hertz survives");
  eq(decodeFrequency(encodeFrequency(0)), 0, "zero survives");

  for (const hz of [1_800_000, 3_573_000, 10_136_000, 21_074_000, 28_074_000, 144_174_000]) {
    eq(decodeFrequency(encodeFrequency(hz)), hz, `round-trip ${hz} Hz`);
  }

  // A misaligned or truncated frame produces bytes that are not valid BCD. Returning
  // null beats returning a plausible-looking wrong frequency that gets acted on.
  eq(decodeFrequency(Buffer.from("00400714ff", "hex")), null, "non-BCD is refused, not guessed");
  eq(decodeFrequency(Buffer.from("004007", "hex")), null, "a short buffer is refused");
}

console.log("\nmode with data");
{
  // Plain 0x06 leaves the data flag alone, and FT8 on a radio in USB rather than USB-D
  // routes transmit audio to the microphone. The radio keys and sends nothing.
  const b = setModeWithData(R, "USB", true, 1);
  eq(hex(b), "fefe94e02600" + "010101" + "fd", "USB-D with filter 1");
  eq(hex(setModeWithData(R, "USB", false, 1)), "fefe94e02600010001fd", "plain USB clears the flag");
  eq(CivMode.USB, 0x01, "USB is mode 0x01");
  eq(CivMode.CW, 0x03, "CW is mode 0x03");
}

console.log("\npower and meters");
{
  // 0-100% maps onto the radio's 0-255.
  eq(hex(setRfPower(R, 100)), "fefe94e0140a0255fd", "100% is 255");
  eq(hex(setRfPower(R, 0)), "fefe94e0140a0000fd", "0% is 0");
  eq(hex(setRfPower(R, 50)), "fefe94e0140a0128fd", "50% is 128");
  eq(hex(setRfPower(R, 150)), "fefe94e0140a0255fd", "over 100% clamps rather than wrapping");
  eq(hex(setRfPower(R, -5)), "fefe94e0140a0000fd", "negative clamps too");

  eq(hex(readMeter(R, MeterSub.swr)), "fefe94e01512fd", "read SWR");
  eq(hex(readMeter(R, MeterSub.sMeter)), "fefe94e01502fd", "read the S-meter");

  eq(decodeBcd2(Buffer.from("0241", "hex")), 241, "two-byte BCD decodes");
  eq(hex(encodeBcd2(241)), "0241", "and encodes");
  eq(decodeBcd2(Buffer.from("00ff", "hex")), null, "non-BCD refused");
}

console.log("\nmeter calibration is piecewise, not linear");
{
  // Icom's published points: 0 = S0, 120 = S9, 241 = S9+60dB. Treating the whole
  // 0-255 range as one slope reads about two S-units low at S9, which is the
  // difference between "weak but workable" and "not there".
  ok(Math.abs(sMeterToSUnits(0) - 0) < 0.01, "0 is S0");
  ok(Math.abs(sMeterToSUnits(120) - 9) < 0.01, "120 is exactly S9");
  ok(Math.abs(sMeterToSUnits(60) - 4.5) < 0.01, "halfway to S9 is S4.5");
  ok(sMeterToSUnits(241) > 14, "241 is well past S9");

  const naive = (120 / 255) * 9; // What a single linear scale would have said.
  ok(Math.abs(naive - 9) > 4, "a naive linear scale would read S4 at S9", `naive ${naive.toFixed(1)}`);

  ok(Math.abs(sMeterToDbm(120) + 73) < 0.01, "S9 is -73 dBm");
  ok(sMeterToDbm(0) < -100, "S0 is very weak");
  ok(sMeterToDbm(241) > -73, "S9+ is stronger than S9");

  // SWR: 0=1.0, 48=1.5, 80=2.0, 120=3.0.
  ok(Math.abs(swrFromRaw(0) - 1) < 0.01, "0 is a perfect match");
  ok(Math.abs(swrFromRaw(48) - 1.5) < 0.01, "48 is 1.5:1");
  ok(Math.abs(swrFromRaw(80) - 2) < 0.01, "80 is 2:1");
  ok(Math.abs(swrFromRaw(120) - 3) < 0.01, "120 is 3:1");
  ok(Math.abs(swrFromRaw(24) - 1.25) < 0.01, "and it interpolates between them");
  ok(swrFromRaw(200) > 3, "beyond the last point it extrapolates upward");
}

console.log("\nforward power, which is how you tell RF from silence");
{
  // Icom's published Po scale is piecewise: 0 = 0%, 141 = 50%, 213 = 100% of rated
  // output. Reading the raw 0-255 as a percentage says 55% at half power and 84% at
  // full, which flatters a radio that is barely producing anything — the wrong
  // direction for the one reading that proves RF is leaving the set.
  ok(Math.abs(poMeterToWatts(0) - 0) < 0.01, "0 is nothing");
  ok(Math.abs(poMeterToWatts(141) - 50) < 0.01, "141 is half of a 100 W radio");
  ok(Math.abs(poMeterToWatts(213) - 100) < 0.01, "213 is full output");
  ok(Math.abs(poMeterToWatts(255) - 100) < 0.01, "and it does not exceed the rating");
  ok(Math.abs(poMeterToWatts(141, 10) - 5) < 0.01, "an IC-705 is rated 10 W, not 100");

  const naive = (141 / 255) * 100;
  ok(Math.abs(naive - 50) > 4, "a naive linear scale would call half power 55%", naive.toFixed(0));

  // The meter stream carries dBm so both radios can share one display.
  ok(Math.abs((wattsToDbm(100) ?? 0) - 50) < 0.01, "100 W is 50 dBm");
  ok(Math.abs((wattsToDbm(30) ?? 0) - 44.77) < 0.01, "30 W is 44.8 dBm");
  eq(wattsToDbm(0), null, "and nothing is null rather than minus infinity");
}

console.log("\nthe ATU, and the reads preflight needs");
{
  // 0x1C 0x01 with 0x02 starts the tune cycle. 0x1C 0x00 is PTT and lives one
  // sub-command away, which is a good reason to assert the bytes rather than trust
  // them: a transposed sub-command here keys the transmitter instead of tuning.
  const tune = atuTune(0x94);
  eq([...tune], [0xfe, 0xfe, 0x94, 0xe0, 0x1c, 0x01, 0x02, 0xfd], "atuTune is 1C 01 02");
  eq([...readAtu(0x94)], [0xfe, 0xfe, 0x94, 0xe0, 0x1c, 0x01, 0xfd], "reading it omits the data byte");
  ok(tune[4] === 0x1c && tune[5] === 0x01, "and it is NOT the PTT sub-command");

  // Replies echo the sub-command byte first, so the value is the one after it.
  eq(atuStateFrom(Buffer.from([0x01, 0x00])), "bypassed", "0 is bypassed");
  eq(atuStateFrom(Buffer.from([0x01, 0x01])), "in-line", "1 is in line");
  eq(atuStateFrom(Buffer.from([0x01, 0x02])), "tuning", "2 is tuning right now");
  eq(atuStateFrom(Buffer.alloc(0)), "unknown", "an empty payload is unknown, not a guess");

  eq([...readRfPower(0x94)], [0xfe, 0xfe, 0x94, 0xe0, 0x14, 0x0a, 0xfd], "power reads on level 0x0A");
  // 255 is full scale. Reading the BCD from the wrong offset gives a plausible wrong
  // answer, which is exactly the bug worth a test.
  eq(rfPowerPercentFrom(Buffer.concat([Buffer.from([0x0a]), encodeBcd2(255)])), 100, "full scale is 100%");
  eq(rfPowerPercentFrom(Buffer.concat([Buffer.from([0x0a]), encodeBcd2(128)])), 50, "half scale is 50%");
  eq(rfPowerPercentFrom(Buffer.concat([Buffer.from([0x0a]), encodeBcd2(0)])), 0, "zero is 0%");
  eq(rfPowerPercentFrom(Buffer.from([0x0a])), null, "a truncated reply is null, not 0");

  // The mode read is the one check that can catch a radio about to transmit silence
  // - as far as CI-V can see it, anyway.
  eq(
    modeWithDataFrom(Buffer.from([0x00, 0x01, 0x01, 0x01])),
    { mode: "USB", dataMode: true, filter: 1 },
    "USB with data on, filter 1",
  );
  eq(modeWithDataFrom(Buffer.from([0x00, 0x01, 0x00, 0x02]))?.dataMode, false, "the data flag is read, not assumed");
  eq(modeWithDataFrom(Buffer.from([0x00, 0x03, 0x00, 0x01]))?.mode, "CW", "and the mode byte is decoded");
  eq(modeWithDataFrom(Buffer.from([0x00, 0x01])), null, "a short payload is null");

  ok(pttFrom(Buffer.from([0x00, 0x01])), "PTT reply 1 is transmitting");
  ok(!pttFrom(Buffer.from([0x00, 0x00])), "and 0 is not");
}

console.log("\nthe receiver controls");
{
  // The CAT panel's AGC, RF gain, noise blanker and noise reduction, which the Icom used
  // to refuse by name. Every one of these writes is confirmed by the radio's own OK/NG
  // reply, so a wrong byte here reports itself on the air rather than silently doing
  // nothing — but the frames are still worth pinning, because "silently doing nothing"
  // is precisely what a wrong SUB-command looks like on a radio that answers OK to the
  // command anyway.
  const A = 0x94;

  eq(
    [...setAgc(A, "fast")],
    [0xfe, 0xfe, A, CIV_CONTROLLER, 0x16, 0x12, 0x01, 0xfd],
    "AGC fast is 0x16 0x12 0x01",
  );
  eq([...setAgc(A, "mid")][6], 0x02, "mid is 2");
  eq([...setAgc(A, "slow")][6], 0x03, "slow is 3");

  eq(agcFrom(Buffer.from([0x12, 0x01])), "fast", "and the reply reads back");
  eq(agcFrom(Buffer.from([0x12, 0x03])), "slow", "slow too");
  // The sub-command byte comes first in a reply. Reading the state from offset 0 gives
  // a value that looks plausible and is the sub-command — the same trap rfPowerPercentFrom
  // documents, and the reason these all take the payload including it.
  eq(agcFrom(Buffer.from([0x12, 0x04])), null, "an unknown constant is null, not guessed");

  eq(
    [...setFunction(A, FunctionSub.noiseBlanker, true)],
    [0xfe, 0xfe, A, CIV_CONTROLLER, 0x16, 0x22, 0x01, 0xfd],
    "noise blanker on is 0x16 0x22 0x01",
  );
  eq([...setFunction(A, FunctionSub.noiseBlanker, false)][6], 0x00, "and off is 0");
  eq([...setFunction(A, FunctionSub.noiseReduction, true)][5], 0x40, "noise reduction is sub 0x40");

  ok(functionStateFrom(Buffer.from([0x22, 0x01])) === true, "on reads back as on");
  ok(functionStateFrom(Buffer.from([0x22, 0x00])) === false, "off as off");
  eq(functionStateFrom(Buffer.from([0x22, 0x02])), null, "and anything else is null");

  // RF gain shares the 0-255 BCD scale with transmit power, and 100% must be the same
  // bytes the power command sends for 100% — if these diverge one of them is wrong.
  eq(
    [...setLevel(A, LevelSub.rfGain, 100)].slice(4),
    [0x14, 0x02, 0x02, 0x55, 0xfd],
    "RF gain 100% is 0x14 0x02 with 0255 BCD",
  );
  eq(
    [...setLevel(A, LevelSub.rfGain, 100)].slice(6, 8),
    [...setRfPower(A, 100)].slice(6, 8),
    "and full scale is the same bytes as full power",
  );
  eq([...setLevel(A, LevelSub.rfGain, 0)].slice(6, 8), [0x00, 0x00], "zero is 0000");
  eq([...setLevel(A, LevelSub.rfGain, 50)].slice(6, 8), [0x01, 0x28], "50% is 128 of 255");
  // Clamped rather than wrapped: 0-255 BCD has no room for 300, and encodeBcd2 of a
  // number over 255 would produce a frame the radio reads as something else entirely.
  eq([...setLevel(A, LevelSub.rfGain, 300)].slice(6, 8), [0x02, 0x55], "over 100 clamps");
  eq([...setLevel(A, LevelSub.rfGain, -20)].slice(6, 8), [0x00, 0x00], "and under 0 clamps");

  // A read carries no payload. A read that accidentally carried one would be a WRITE of
  // whatever those bytes decode to — asking the radio a question and changing it instead.
  eq([...readAgc(A)], [0xfe, 0xfe, A, CIV_CONTROLLER, 0x16, 0x12, 0xfd], "reading AGC sends no data");
  eq([...readLevel(A, LevelSub.rfGain)].length, 7, "nor does reading a level");
  eq(
    [...readFunction(A, FunctionSub.noiseReduction)],
    [0xfe, 0xfe, A, CIV_CONTROLLER, 0x16, 0x40, 0xfd],
    "nor a function",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

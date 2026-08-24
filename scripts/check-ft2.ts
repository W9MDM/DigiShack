/* eslint-disable no-console */
// FT2 checks, against the reference implementation's own constants
// (wsjt-x_improved 3.1.0, lib/ft2). Every number here traces to a specific
// parameter or line in that source, not to any published description.

import {
  FT2_BANDWIDTH_HZ,
  FT2_BAUD,
  FT2_CODEWORD_BITS,
  FT2_INFO_BITS,
  FT2_MESSAGE_BITS,
  FT2_MOD_INDEX,
  FT2_SAMPLES_PER_SYMBOL,
  FT2_SAMPLE_RATE,
  FT2_SYMBOL_SEC,
  FT2_SYNC,
  FT2_SYNC_SYMBOLS,
  FT2_TOTAL_SYMBOLS,
  FT2_TX_MS,
  FT2_TX_SAMPLES,
  ft2ChannelSymbols,
  ft2GenerateWaveform,
  ft2GfskPulse,
  ft2PulseTable,
  ft2Encode,
  ft2DecodeSymbols,
  ft2SamplesPerSymbol,
} from "@/lib/digital/ft2";
import { CRC13_POLY, ft2AddCrc13, ft2CheckCrc13, ft2Crc13, ft2Crc13Buffer } from "@/lib/digital/crc13";
import {
  FT2_DEVIATION_HZ,
  FT2_DOWN_RATE,
  FT2_DOWN_SPS,
  FT2_NDOWN,
  ft2DecodeAudio,
  ft2Downsample,
  ft2SyncSearch,
  ft2Decimation,
} from "@/lib/digital/ft2demod";
import { FlexDaxTransmitter, nextWindowStart, periodMs, transmitDurationMs } from "@/lib/flex/tx";
import { DECODE_SAMPLE_RATE, FT2_PERIOD_MS, decimateBy2, normalise } from "@/lib/flex/dax";
import { DIGITAL_FREQUENCIES, inferDigitalMode, periodMsFor } from "@/lib/ham/digital-freqs";
import { bpDecode128_90, checkSparseParity, parityGraph, platanh } from "@/lib/digital/bpdecode12890";
import { checkParity, encode128_90, ldpcGenerator } from "@/lib/digital/ldpc12890";
import {
  HashCallBook,
  chkcall,
  ihashcall,
  isGrid4,
  pack28,
  pack77,
  packText77,
  split77,
  unpack28,
  unpack77,
  unpackText77,
} from "@/lib/digital/pack77";
import { adifToQslRoute } from "@/lib/adif/fields";
import { toAdifMode, fromAdifMode } from "@/lib/adif/fields";
import { isDigitalMode, isLoggableMode } from "@/lib/ham/modes";

/**
 * A seeded LCG. The AWGN assertions below have fixed numeric thresholds, so the
 * noise has to be reproducible — with Math.random the suite would pass or fail
 * by luck and nobody would trust it.
 */
function seededRandom(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

/** Box-Muller, one value per call. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomMessage(rng: () => number): Uint8Array {
  const m = new Uint8Array(77);
  for (let i = 0; i < 77; i++) m[i] = rng() < 0.5 ? 0 : 1;
  return m;
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function near(a: number, b: number, tol: number, label: string): void {
  ok(Math.abs(a - b) <= tol, label, `${a} vs ${b}`);
}

console.log("\nparameters (ft2_params.f90)");
{
  ok(FT2_SAMPLE_RATE === 12_000, "12 kHz DSP rate");
  ok(FT2_SAMPLES_PER_SYMBOL === 160, "NSPS = 160");
  near(FT2_BAUD, 75, 1e-9, "75 baud");
  near(FT2_SYMBOL_SEC * 1000, 13.3333, 0.001, "13.333 ms per symbol");
  ok(FT2_INFO_BITS === 90, "KK = 90 information bits");
  ok(FT2_MESSAGE_BITS === 77, "77 message bits");
  ok(FT2_INFO_BITS - FT2_MESSAGE_BITS === 13, "leaving 13 bits of CRC (CRC-13, not CRC-14)");
  ok(FT2_CODEWORD_BITS === 128, "ND = 128 codeword bits");
  ok(FT2_SYNC_SYMBOLS === 16, "NS = 16 sync symbols");
  ok(FT2_TOTAL_SYMBOLS === 144, "NN = 144 channel symbols");
  ok(FT2_TX_SAMPLES === 23_040, "NZ = 23040 samples");
  near(FT2_TX_MS, 1920, 0.001, "1.92 s transmission");
  ok(FT2_MOD_INDEX === 0.8, "modulation index 0.8 (MSK is 0.5, FSK 1.0)");
  near(FT2_BANDWIDTH_HZ, 112.5, 1e-9, "112.5 Hz occupied bandwidth");
}

console.log("\nframe arithmetic actually closes (unlike the published description)");
{
  // The whole point: one bit per symbol, so 128 data symbols carry exactly the
  // 128 codeword bits. No shortfall.
  const dataSymbols = FT2_TOTAL_SYMBOLS - FT2_SYNC_SYMBOLS;
  ok(dataSymbols === FT2_CODEWORD_BITS, "128 data symbols carry 128 coded bits at 1 bit/symbol");
  // For contrast, the circulated spec's numbers cannot work: 4-GFSK, 65 data
  // symbols, LDPC(174,91).
  ok(65 * 2 !== 174, "the published 4-GFSK/65-symbol frame could not carry LDPC(174,91)");
  near(65 * 2, 130, 0, "it would provide 130 bits, 44 short");
}

console.log("\nsync pattern (s16 in genft2.f90)");
{
  ok(FT2_SYNC.length === 16, "16 bits long");
  ok(
    FT2_SYNC.join("") === "0000111111110000",
    "matches s16 exactly",
    FT2_SYNC.join(""),
  );
  ok(
    FT2_SYNC.every((b) => b === 0 || b === 1),
    "binary — not a Costas array, because FT2 is binary keyed",
  );
}

console.log("\nGaussian frequency pulse (gfsk_pulse.f90)");
{
  // Symmetric about zero, peaks at the centre, and falls away either side.
  near(ft2GfskPulse(0), ft2GfskPulse(0), 0, "deterministic");
  ok(ft2GfskPulse(0) > ft2GfskPulse(1), "peaks at the symbol centre");
  near(ft2GfskPulse(-0.7), ft2GfskPulse(0.7), 1e-12, "symmetric about zero");
  ok(ft2GfskPulse(0) > 0.9, "near unity at the centre", ft2GfskPulse(0).toFixed(4));
  ok(Math.abs(ft2GfskPulse(3)) < 0.01, "negligible three symbols out", ft2GfskPulse(3).toExponential(2));

  const table = ft2PulseTable();
  ok(table.length === 480, "pulse table spans 3 symbols (480 samples)");
  // The peak sits in the middle of the table.
  let peakAt = 0;
  for (let i = 1; i < table.length; i++) if (table[i]! > table[peakAt]!) peakAt = i;
  ok(Math.abs(peakAt - 240) <= 2, "pulse peak is centred", `${peakAt}`);
  // A GFSK pulse should sum to approximately one symbol period of unit area.
  const sum = table.reduce((a, b) => a + b, 0);
  near(sum / FT2_SAMPLES_PER_SYMBOL, 1, 0.02, "unit area over one symbol");
}

console.log("\nchannel symbol assembly");
{
  const codeword = new Uint8Array(128);
  for (let i = 0; i < 128; i++) codeword[i] = i % 2;
  const sym = ft2ChannelSymbols(codeword);
  ok(sym.length === 144, "144 symbols out");
  ok(sym.slice(0, 16).join("") === FT2_SYNC.join(""), "sync leads the frame");
  ok(sym[16] === 0 && sym[17] === 1, "codeword follows the sync");
  for (const bad of [127, 129, 0]) {
    let threw = false;
    try {
      ft2ChannelSymbols(new Uint8Array(bad));
    } catch {
      threw = true;
    }
    ok(threw, `rejects a ${bad}-bit codeword`);
  }
}

console.log("\nwaveform (ft2_gfsk_iwave.f90)");
{
  const codeword = new Uint8Array(128);
  for (let i = 0; i < 128; i++) codeword[i] = (i * 7 + 3) % 2;
  const sym = ft2ChannelSymbols(codeword);
  const wave = ft2GenerateWaveform(sym, 1500);

  // NWAVE = (NN + 2) * NSPS
  ok(wave.length === (144 + 2) * 160, "NWAVE = 23360 samples", `${wave.length}`);

  let peak = 0;
  for (const v of wave) peak = Math.max(peak, Math.abs(v));
  // UNIT peak, and the tolerance is tight on purpose. "peak <= 1.5" was the old
  // assertion and it happily passed a waveform peaking at 1.4142 that clipped 49.7%
  // of its samples once tx.ts clamped to int16 — the test was holding the bug open.
  ok(peak > 0.99 && peak <= 1.0, "peak amplitude is unity, like FT8 and FT4", peak.toFixed(4));
  let clipped = 0;
  for (const v of wave) if (Math.abs(v) >= 1.0000001) clipped++;
  ok(clipped === 0, "no sample exceeds full scale", `${clipped} of ${wave.length}`);

  // Ramps: the very first and last samples must be near silent, or the
  // transmission clicks and splatters outside its 112 Hz.
  ok(Math.abs(wave[0]!) < 0.05, "starts from silence", wave[0]!.toFixed(4));
  // The ramp-down leaves the final sample at ~1e-4, not exactly zero. That is
  // faithful: the reference's `wave(146*160+1:)=0` is a no-op because NWAVE is
  // exactly 146*160, so the last symbol is shaped by the cosine ramp and nothing
  // else. Well below audibility, and the point is that it does not click.
  ok(Math.abs(wave[wave.length - 1]!) < 1e-3, "ends effectively silent", wave[wave.length - 1]!.toExponential(2));
  // The reference zeroes everything past symbol 146.
  let tailEnergy = 0;
  for (let i = 146 * 160; i < wave.length; i++) tailEnergy += Math.abs(wave[i]!);
  ok(tailEnergy === 0, "tail past symbol 146 is zeroed");

  // The middle of the transmission must be fully up.
  let midPeak = 0;
  for (let i = 40 * 160; i < 60 * 160; i++) midPeak = Math.max(midPeak, Math.abs(wave[i]!));
  ok(midPeak > 0.9 && midPeak <= 1.0, "mid-transmission reaches full scale without exceeding it", midPeak.toFixed(3));

  // Frequency check: measure the dominant tone by counting zero crossings over
  // the steady middle. A 1500 Hz carrier at 12 kHz gives ~1500 crossings/sec.
  let crossings = 0;
  const from = 40 * 160;
  const to = 100 * 160;
  for (let i = from + 1; i < to; i++) {
    if ((wave[i - 1]! < 0) !== (wave[i]! < 0)) crossings++;
  }
  const seconds = (to - from) / FT2_SAMPLE_RATE;
  const measuredHz = crossings / 2 / seconds;
  // Binary GFSK at h=0.8 shifts ±30 Hz around the carrier, so allow for that.
  near(measuredHz, 1500, 60, "carrier lands near 1500 Hz");

  // A different base frequency must actually move it.
  const wave2 = ft2GenerateWaveform(sym, 1000);
  let crossings2 = 0;
  for (let i = from + 1; i < to; i++) {
    if ((wave2[i - 1]! < 0) !== (wave2[i]! < 0)) crossings2++;
  }
  near(crossings2 / 2 / seconds, 1000, 60, "retunes to 1000 Hz");

  for (const bad of [50, 5000, NaN]) {
    let threw = false;
    try {
      ft2GenerateWaveform(sym, bad);
    } catch {
      threw = true;
    }
    ok(threw, `rejects a ${bad} Hz base frequency`);
  }
  let threw = false;
  try {
    ft2GenerateWaveform(new Uint8Array(100), 1500);
  } catch {
    threw = true;
  }
  ok(threw, "rejects a wrong-length symbol vector");
}

console.log("\nCRC-13 (crc13.cpp, POLY 0x15D7, boost augmented_crc)");
{
  ok(CRC13_POLY === 0x15d7, "polynomial 0x15D7");

  // The augmented convention: message + correct CRC recomputes to zero. That is
  // the property the reference's own crc13_check() relies on, and it makes this
  // port verifiable without external test vectors.
  // The CRC is computed over a 12-BYTE buffer (77 message bits + 3 pad + two
  // zero bytes), not over the 90-bit information vector. Getting that wrong
  // yields a self-consistent CRC that no real FT2 station can read, and only the
  // caller in encode_128_90.f90 reveals it.
  {
    const b = ft2Crc13Buffer(new Uint8Array(77).fill(1));
    ok(b.length === 12, "CRC input is 12 bytes / 96 bits");
    ok(b[10] === 0 && b[11] === 0, "final two bytes zero — they supply the augmentation");
    ok((b[9]! & 0x07) === 0, "pad bits 77..79 are zero even for an all-ones message");
  }

  let roundTrip = true;
  for (let t = 0; t < 200; t++) {
    const msg = new Uint8Array(77);
    // Vary every bit position with t, or the fixture collapses to two messages.
    let x = t * 2654435761 + 1;
    for (let i = 0; i < 77; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      msg[i] = (x >>> 16) & 1;
    }
    const info = ft2AddCrc13(msg);
    if (!ft2CheckCrc13(info)) roundTrip = false;
  }
  ok(roundTrip, "200 varied messages round-trip through ft2AddCrc13/ft2CheckCrc13");

  const msg = new Uint8Array(77);
  for (let i = 0; i < 77; i++) msg[i] = i % 3 === 0 ? 1 : 0;
  const good = ft2AddCrc13(msg);
  ok(good.length === 90, "produces 90 information bits (77 + 13)");
  ok(ft2CheckCrc13(good), "its own CRC verifies");

  // Every single-bit error must be caught, or the CRC is not doing its job.
  let missed = 0;
  for (let i = 0; i < 90; i++) {
    const bad = Uint8Array.from(good);
    bad[i] = (bad[i] ?? 0) ^ 1;
    if (ft2CheckCrc13(bad)) missed++;
  }
  ok(missed === 0, "all 90 single-bit flips detected");

  let two = 0;
  let caught = 0;
  for (let i = 0; i < 90; i++) {
    for (let j = i + 1; j < 90; j++) {
      const bad = Uint8Array.from(good);
      bad[i] = (bad[i] ?? 0) ^ 1;
      bad[j] = (bad[j] ?? 0) ^ 1;
      two++;
      if (!ft2CheckCrc13(bad)) caught++;
    }
  }
  ok(caught === two, `all ${two} two-bit flips detected`);

  for (const n of [76, 78]) {
    let threw = false;
    try {
      ft2AddCrc13(new Uint8Array(n));
    } catch {
      threw = true;
    }
    ok(threw, `rejects ${n} message bits`);
  }
}

section("LDPC(128,90) (encode_128_90.f90 + ldpc_128_90_generator.f90)");
{
  const g = ldpcGenerator();
  ok(g.length === 38, "38 generator rows (M = 128 - 90)");
  ok(g.every((r) => r.length === 90), "each row is 90 columns");
  // The 23rd hex character contributes only its top TWO bits. Taking all four
  // gives 92 columns and silently wrong parity.
  ok(22 * 4 + 2 === 90, "22 nibbles plus 2 bits = 90 columns");
  ok(
    g[0]![0] === 1 && g[0]![1] === 0 && g[0]![2] === 1 && g[0]![3] === 0,
    "row 0 begins 1010, from hex 'a'",
  );
  const ones = g.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0);
  const density = ones / (38 * 90);
  ok(density > 0.3 && density < 0.7, `generator density ${(density * 100).toFixed(1)}% is plausible`);

  let systematic = true;
  let parityHolds = true;
  let mixed = 0;
  for (let t = 0; t < 200; t++) {
    const msg = new Uint8Array(77);
    // Vary every bit position with t. An earlier fixture used (t*37 + i*13) % 2,
    // which reduces to t % 2 — 200 iterations produced two distinct messages and
    // the "non-degenerate parity" count came out at exactly 100. The encoder was
    // fine; the test was measuring itself.
    let x = t * 2246822519 + 7;
    for (let i = 0; i < 77; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      msg[i] = (x >>> 16) & 1;
    }
    const info = ft2AddCrc13(msg);
    const cw = encode128_90(info);
    if (cw.length !== 128) systematic = false;
    for (let i = 0; i < 90; i++) if (cw[i] !== info[i]) systematic = false;
    if (checkParity(cw).length !== 0) parityHolds = false;
    let p = 0;
    for (let i = 90; i < 128; i++) p += cw[i]!;
    if (p > 0 && p < 38) mixed++;
  }
  ok(systematic, "systematic: the 90 information bits appear in the codeword verbatim");
  ok(parityHolds, "every parity check satisfies on all 200 codewords");
  ok(mixed === 200, "parity bits are non-degenerate on all 200 codewords", String(mixed));

  const msg = new Uint8Array(77);
  for (let i = 0; i < 77; i++) msg[i] = i % 4 === 0 ? 1 : 0;
  const cw = encode128_90(ft2AddCrc13(msg));
  let detected = 0;
  for (let i = 0; i < 128; i++) {
    const bad = Uint8Array.from(cw);
    bad[i] = (bad[i] ?? 0) ^ 1;
    if (checkParity(bad).length > 0) detected++;
  }
  ok(detected === 128, "all 128 single-bit flips break at least one parity check");

  for (const n of [89, 91]) {
    let threw = false;
    try {
      encode128_90(new Uint8Array(n));
    } catch {
      threw = true;
    }
    ok(threw, `rejects ${n} information bits`);
  }
}

section("77-bit payload (packjt77.f90) - shared with FT8 and FT4");
{
  // pack28 of a standard call, computed by hand from the reference's alphabets:
  //   K1ABC -> the area digit sits at position 2, so the call shifts to " K1ABC"
  //   i1=0(' ') i2=20('K') i3=1('1') i4=1('A') i5=2('B') i6=3('C')
  //   36*10*27^3*0 + 10*27^3*20 + 27^3*1 + 27^2*1 + 27*2 + 3 = 3,957,069
  //   + NTOKENS(2,063,592) + MAX22(4,194,304)                = 10,214,965
  // An independent value rather than a round-trip: a self-consistent packer
  // passes every round-trip test and is still unreadable on the air.
  ok(
    pack28("K1ABC") === 10_214_965,
    "pack28('K1ABC') matches the hand-computed 10,214,965",
    String(pack28("K1ABC")),
  );
  ok(pack28("DE") === 0 && pack28("QRZ") === 1 && pack28("CQ") === 2, "DE/QRZ/CQ are tokens 0/1/2");
  ok(pack28("CQ_014") === 3 + 14, "CQ_014 is token 3+14, the directed-CQ frequency form");
  ok(unpack28(pack28("K1ABC")).call === "K1ABC", "pack28/unpack28 round-trip");

  // All three hash widths take the top m bits of ONE 64-bit product, so the
  // narrow hashes are shifts of the wide one. Wrong shift arithmetic breaks it.
  const h22 = ihashcall("K9XYZ", 22);
  ok(ihashcall("K9XYZ", 12) === h22 >> 10, "hash12 is hash22 >> 10");
  ok(ihashcall("K9XYZ", 10) === h22 >> 12, "hash10 is hash22 >> 12");

  ok(chkcall("K9XYZ").ok, "K9XYZ is a valid callsign");
  ok(!chkcall("EN52").ok, "EN52 is NOT a callsign - its last character is a digit");
  ok(chkcall("PJ4/KA1ABC").baseCall === "KA1ABC", "the base call of PJ4/KA1ABC is KA1ABC");
  ok(!chkcall("QRZ").ok && !chkcall("CQ").ok, "tokens are not callsigns; pack77_1 whitelists them");
  ok(isGrid4("EN52") && !isGrid4("SN52") && !isGrid4("EN5"), "grid4 accepts A-R only, exactly 4");

  // split77 folds a directed CQ into the first word so it rides inside the
  // 28-bit callsign field. Without it, "CQ DX ..." falls through to free text.
  ok(split77("cq dx k9xyz en52").join("|") === "CQ_DX|K9XYZ|EN52", "CQ DX collapses to CQ_DX");
  ok(
    split77("CQ K9XYZ EN52").join("|") === "CQ|K9XYZ|EN52",
    "a plain CQ does not, because EN52 is not a callsign",
  );

  ok(unpackText77(packText77("TNX 73 GL")).trim() === "TNX 73 GL", "free text round-trips");
  ok(packText77("HELLO") < 1n << 71n, "free text fits in 71 bits");

  const book = new HashCallBook();
  book.save("PJ4/KA1ABC");
  book.save("K9XYZ");

  const type1 = [
    "CQ K9XYZ EN52",
    "CQ DX K9XYZ EN52",
    "CQ POTA K9XYZ EN52",
    "CQ 014 K9XYZ EN52",
    "SP1ABC K9XYZ EN52",
    "SP1ABC K9XYZ R FN42",
    "SP1ABC K9XYZ -12",
    "SP1ABC K9XYZ +05",
    "SP1ABC K9XYZ R-08",
    "SP1ABC K9XYZ RRR",
    "SP1ABC K9XYZ RR73",
    "SP1ABC K9XYZ 73",
    "SP1ABC K9XYZ",
    "HI8JSA K9XYZ -01",
    "II1ABC K9XYZ +00",
  ];
  let n1 = 0;
  for (const m of type1) {
    const p = pack77(m, book);
    const u = unpack77(p.bits, book);
    if (p.i3 === 1 && u.ok && u.message === m) n1++;
  }
  ok(
    n1 === type1.length,
    `all ${type1.length} standard messages pack as type 1 and round-trip`,
    String(n1),
  );

  ok(pack77("WA9XYZ/R KA1ABC/R R FN42", book).i3 === 1, "the /R form is type 1");
  ok(pack77("PA3XYZ/P GM4ABC/P R JO22", book).i3 === 2, "the /P form is type 2, for EU VHF");

  // Type 4: one nonstandard callsign plus a 12-bit hash. Only resolvable once
  // the hashed call has been heard spelled out - a property of the protocol.
  for (const m of ["<K9XYZ> PJ4/KA1ABC RR73", "CQ PJ4/KA1ABC"]) {
    const p = pack77(m, book);
    const u = unpack77(p.bits, book);
    ok(p.i3 === 4 && u.message === m, `type 4 round-trips: ${m}`, `i3=${p.i3} -> ${u.message}`);
  }
  const u4 = unpack77(pack77("<K9XYZ> PJ4/KA1ABC RR73", new HashCallBook()).bits, new HashCallBook());
  ok(u4.message.includes("<...>"), "an unheard hashed call shows <...>, as WSJT-X does", u4.message);

  // A compound call written without the <> notation loses its prefix to
  // base-call packing. That is what WSJT-X does, and why `sent` exists.
  const lossy = pack77("PJ4/KA1ABC K9XYZ RR73", book);
  ok(
    lossy.i3 === 1 && lossy.sent === "KA1ABC K9XYZ RR73",
    "sent reports the prefix that was dropped",
    lossy.sent,
  );

  ok(pack77("TNX BOB 73 GL", book).i3 === 0, "unstructured text falls back to free text");
  ok(
    pack77("THIS IS FAR TOO LONG TO SEND", book).sent.length <= 13,
    "free text is cut to 13 characters",
  );

  const bogus = new Uint8Array(77);
  bogus[74] = 1;
  bogus[76] = 1; // i3 = 5, the EU VHF contest type, which we do not implement
  ok(!unpack77(bogus).ok, "an unimplemented payload type is reported unsupported, not guessed at");
}

section("sparse parity graph (ldpc_128_90_reordered_parity.f90)");
{
  const g = parityGraph();
  ok(g.nm.length === 38, "38 checks");
  ok(g.mn.length === 128, "128 bits");
  ok(g.mn.every((r) => r.length === 3), "column weight is exactly 3 for every bit");
  ok(
    [...new Set(g.nrw)].sort((a, b) => a - b).join(",") === "10,11",
    "row weights are 10 or 11 — sparse, as belief propagation requires",
  );
  ok(g.nrw.reduce((a, b) => a + b, 0) === 384, "384 edges = 128 bits x 3 checks");

  // THE cross-check. The dense generator in ldpc12890.ts and the sparse graph
  // here are independent transcriptions of the same code, and neither can be
  // validated by round-tripping against itself. If every codeword produced by
  // the dense generator satisfies all 38 sparse checks, both are right.
  let rng = seededRandom(12345);
  let sparseAgrees = 0;
  for (let t = 0; t < 500; t++) {
    const cw = encode128_90(ft2AddCrc13(randomMessage(rng)));
    if (checkSparseParity(cw).length === 0) sparseAgrees++;
  }
  ok(
    sparseAgrees === 500,
    "the sparse graph annihilates all 500 codewords from the dense generator",
    String(sparseAgrees),
  );

  const bent = encode128_90(ft2AddCrc13(randomMessage(rng)));
  bent[7] = bent[7]! ^ 1;
  ok(
    checkSparseParity(bent).length === 3,
    "one flipped bit breaks exactly 3 checks — the column weight",
    String(checkSparseParity(bent).length),
  );

  ok(Math.abs(platanh(0) - 0) < 1e-12, "platanh(0) = 0");
  ok(platanh(1.0) === 7 && platanh(-1.0) === -7, "platanh saturates at +/-7");
  ok(Number.isFinite(platanh(0.99999)), "platanh stays finite where atanh would not");
  ok(platanh(-0.5) === -platanh(0.5), "platanh is odd");
}

section("belief propagation over AWGN (bpdecode128_90.f90)");
{
  // Clean input must decode immediately — the reference tests for a codeword
  // before doing any iteration, so a perfect frame costs one pass.
  const rng0 = seededRandom(4242);
  const msg = randomMessage(rng0);
  const cw = encode128_90(ft2AddCrc13(msg));
  const clean = bpDecode128_90(Array.from(cw, (b) => (2 * b - 1) * 6));
  ok(clean.ok, "a clean frame decodes");
  ok(clean.iterations === 0, "and does so at iteration 0, before any message passing");
  ok(clean.hardErrors === 0, "with 0 corrected bits");
  ok(clean.message!.every((b, i) => b === msg[i]), "recovering the message exactly");

  let threw = false;
  try {
    bpDecode128_90(new Float64Array(127));
  } catch {
    threw = true;
  }
  ok(threw, "rejects the wrong number of LLRs");

  // The waterfall. Sigma is the AWGN standard deviation on a +/-1 symbol, and
  // the LLR is the properly calibrated 2y/sigma^2 — feeding BP arbitrarily
  // scaled values costs several dB and looks like a broken decoder.
  const TRIALS = 300;
  let falseAccepts = 0;
  const results = new Map<number, { bp: number; hard: number; rawBer: number }>();
  for (const sigma of [0.5, 0.6, 0.9]) {
    const rng = seededRandom(777);
    let bp = 0;
    let hard = 0;
    let rawErrors = 0;
    for (let t = 0; t < TRIALS; t++) {
      const m = randomMessage(rng);
      const c = encode128_90(ft2AddCrc13(m));
      const llr = new Float64Array(128);
      const hd = new Uint8Array(128);
      for (let i = 0; i < 128; i++) {
        const y = 2 * c[i]! - 1 + gaussian(rng) * sigma;
        llr[i] = (2 * y) / (sigma * sigma);
        hd[i] = y > 0 ? 1 : 0;
        if (hd[i] !== c[i]) rawErrors++;
      }
      if (checkParity(hd).length === 0) hard++;
      const r = bpDecode128_90(llr);
      if (r.ok) {
        if (r.message!.every((b, i) => b === m[i])) bp++;
        else falseAccepts++;
      }
    }
    results.set(sigma, { bp, hard, rawBer: (100 * rawErrors) / (TRIALS * 128) });
  }

  const s5 = results.get(0.5)!;
  const s6 = results.get(0.6)!;
  const s9 = results.get(0.9)!;
  ok(s5.rawBer > 1.5 && s5.rawBer < 3.5, `sigma 0.5 gives ${s5.rawBer.toFixed(2)}% raw bit errors`);
  // Thresholds are fractions of TRIALS, not absolute counts. An earlier revision
  // hard-coded 350 and then dropped TRIALS to 300, which failed a decoder that
  // was performing exactly as measured.
  ok(
    s5.bp >= 0.95 * TRIALS,
    `at ${s5.rawBer.toFixed(1)}% raw BER, BP recovers ${s5.bp}/${TRIALS} frames`,
    `hard-decision managed ${s5.hard}`,
  );
  ok(
    s5.hard <= 0.1 * TRIALS,
    `hard-decision parity alone recovers only ${s5.hard}/${TRIALS} at the same SNR`,
  );
  ok(
    s5.bp > s5.hard * 5,
    "soft decision is worth more than 5x the hard-decision yield — the reason this file exists",
  );
  ok(
    s6.bp >= 0.75 * TRIALS,
    `at ${s6.rawBer.toFixed(1)}% raw BER, BP still recovers ${s6.bp}/${TRIALS}`,
  );
  ok(s9.bp === 0, `at ${s9.rawBer.toFixed(1)}% raw BER nothing decodes, as expected`, String(s9.bp));

  // The CRC is the only thing standing between a mis-converged codeword and a
  // wrong callsign in the log. Across 900 noisy frames it must never let one by.
  ok(falseAccepts === 0, `no false accepts in ${3 * TRIALS} noisy frames`, String(falseAccepts));

  const stalled = bpDecode128_90(new Float64Array(128).fill(0.01));
  ok(!stalled.ok, "near-zero LLRs do not produce a decode");
  ok(stalled.hardErrors === -1, "and report hardErrors = -1 on failure");
}

section("demodulator (ft2_decode.f90)");
{
  ok(FT2_NDOWN === 16, "decimate by 16");
  ok(FT2_DOWN_RATE === 750, "750 Hz after decimation");
  ok(FT2_DOWN_SPS === 10, "10 samples per symbol after decimation");
  // h*baud/2 = 0.8*75/2. The reference reaches this the long way round, via
  // dphi=twopi/2*baud*h*dt*16 with the PRE-decimation NSPS, which cancels out to
  // exactly the same number. Worth pinning, since the roundabout form looks like
  // it should give something else.
  ok(FT2_DEVIATION_HZ === 30, "peak deviation is 30 Hz = h*baud/2");

  // The decimator must pass a tone at the candidate frequency to DC unchanged.
  const tone = new Float32Array(12000);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.cos((2 * Math.PI * 1500 * i) / 12000);
  const mixed = ft2Downsample(tone, 1500);
  let mag = 0;
  for (let i = 100; i < 500; i++) mag += Math.hypot(mixed.re[i]!, mixed.im[i]!);
  mag /= 400;
  ok(mag > 0.4 && mag < 0.6, `an on-frequency tone lands at DC with gain ~0.5 — ${mag.toFixed(3)}`);

  // ...and reject one far outside the passband.
  const far = new Float32Array(12000);
  for (let i = 0; i < far.length; i++) far[i] = Math.cos((2 * Math.PI * 2500 * i) / 12000);
  const rejected = ft2Downsample(far, 1500);
  let rmag = 0;
  for (let i = 100; i < 500; i++) rmag += Math.hypot(rejected.re[i]!, rejected.im[i]!);
  rmag /= 400;
  ok(rmag < 0.005, `a tone 1000 Hz away is rejected — ${rmag.toExponential(1)}`);
  ok(mag / Math.max(rmag, 1e-12) > 100, "at least 40 dB of selectivity between the two");
}

section("FT2 over the air: audio in, message out");
{
  const book = new HashCallBook();
  book.save("K9XYZ");

  /** Put a transmission in a longer noisy window, as a receiver sees it. */
  const receive = (
    audio: Float32Array,
    leadSeconds: number,
    noise: number,
    seed: number,
  ): Float32Array => {
    const rng = seededRandom(seed);
    const lead = Math.round(leadSeconds * 12000);
    const total = lead + audio.length + 12000;
    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) out[i] = gaussian(rng) * noise;
    for (let i = 0; i < audio.length; i++) out[lead + i] = out[lead + i]! + audio[i]!;
    return out;
  };

  const MSG = "CQ K9XYZ EN52";
  const enc = ft2Encode(MSG, 1500, book);

  // The sync search must recover both the frequency offset and the arrival time.
  const clean = receive(enc.audio, 0.2, 0, 1);
  const sync = ft2SyncSearch(ft2Downsample(clean, 1500));
  ok(sync.df === 0, `no frequency error on an exactly-placed signal — df=${sync.df}`);
  ok(sync.magnitude > 50, `strong sync correlation — ${sync.magnitude.toFixed(0)}`);

  const first = ft2DecodeAudio(clean, { frequencies: [1500], book });
  ok(first.length === 1, "one decode from one signal");
  ok(first[0]!.message === MSG, `recovered "${first[0]?.message}"`);
  ok(first[0]!.syncQuality === 16, "all 16 sync symbols correct");
  ok(first[0]!.hardErrors === 0, "no bits needed correcting");
  ok(first[0]!.i3 === 1, "payload type 1");
  // dtSeconds compensates the one-symbol modulator group delay; a signal placed
  // at 0.200 s must report ~0.200 s, not 0.213 s.
  ok(
    Math.abs(first[0]!.dtSeconds - 0.2) < 0.02,
    `reports dt = ${first[0]!.dtSeconds.toFixed(3)} s for a signal placed at 0.200 s`,
  );
  ok(
    Math.abs(first[0]!.frequencyHz - 1500) <= 1,
    `reports ${first[0]!.frequencyHz.toFixed(0)} Hz for a signal at 1500 Hz`,
  );

  // Noise. The SNR estimate must fall monotonically as noise rises, or it is not
  // measuring anything.
  const snrs: number[] = [];
  let decodedAll = 0;
  // Levels are relative to a UNIT-peak signal. They used to run to 4.0 and all six
  // decoded — but that was against the pre-fix waveform peaking at 1.4142, i.e.
  // 3 dB hotter, and hot only because it was clipping. Removing the clipping
  // legitimately costs that 3 dB here, so the top of the sweep comes down with it.
  // Raising the threshold back by re-inflating the signal would be testing the bug.
  for (const noise of [0, 0.5, 1, 2, 2.5, 3]) {
    const d = ft2DecodeAudio(receive(enc.audio, 0.2, noise, 7), { frequencies: [1500], book });
    if (d.length === 1 && d[0]!.message === MSG) {
      decodedAll++;
      snrs.push(d[0]!.snrDb);
    }
  }
  ok(decodedAll === 6, `decodes at all 6 noise levels up to 3x the signal amplitude`, String(decodedAll));
  ok(
    snrs.every((v, i) => i === 0 || v < snrs[i - 1]!),
    `the SNR estimate falls monotonically with noise — ${snrs.map((v) => v.toFixed(0)).join(", ")} dB`,
  );
  ok(snrs.every((v) => v > -30 && v < 40), "and stays in a range an operator would recognise");

  // A frequency error inside the +/-30 Hz search range must still decode: the
  // candidate grid is coarse, so this is the normal case, not an edge case.
  const off = ft2DecodeAudio(receive(enc.audio, 0.3, 0.5, 11), { frequencies: [1478], book });
  ok(off.length === 1 && off[0]!.message === MSG, "decodes from a candidate 22 Hz off frequency");
  ok(
    off.length === 1 && Math.abs(off[0]!.frequencyHz - 1500) <= 2,
    "and still reports the true frequency",
    off[0] ? off[0].frequencyHz.toFixed(0) : "-",
  );

  // Swept candidate grid, with no waterfall to help.
  const swept = ft2DecodeAudio(receive(enc.audio, 0.25, 0.5, 13), {
    book,
    minFrequencyHz: 1400,
    maxFrequencyHz: 1700,
    stepHz: 50,
  });
  ok(swept.length === 1 && swept[0]!.message === MSG, "a blind frequency sweep finds it");

  // Two signals in the same window, which is the ordinary case on a live band.
  const second = ft2Encode("SP1ABC K9XYZ RR73", 1000, book);
  const both = receive(enc.audio, 0.2, 0.5, 17);
  const lead = Math.round(0.2 * 12000);
  for (let i = 0; i < second.audio.length; i++) both[lead + i] = both[lead + i]! + second.audio[i]!;
  const pair = ft2DecodeAudio(both, { frequencies: [1000, 1500], book });
  ok(pair.length === 2, `both simultaneous signals decode — got ${pair.length}`);
  ok(
    pair.some((d) => d.message === MSG) && pair.some((d) => d.message === "SP1ABC K9XYZ RR73"),
    "and both messages are correct",
    pair.map((d) => d.message).join(" | "),
  );

  // FALSE DECODES. This is the assertion that matters most: a decoder that
  // invents QSOs is worse than one that misses them, because the invented ones
  // get logged and uploaded. 40 windows of pure noise must yield nothing.
  let falseDecodes = 0;
  for (let seed = 100; seed < 140; seed++) {
    const noiseOnly = receive(new Float32Array(0), 0, 1.0, seed);
    falseDecodes += ft2DecodeAudio(noiseOnly, { frequencies: [1500], book }).length;
  }
  ok(falseDecodes === 0, "40 windows of pure noise produce no decodes", String(falseDecodes));

  ok(ft2DecodeAudio(new Float32Array(1000), { frequencies: [1500] }).length === 0,
    "a buffer too short to hold a transmission returns nothing");
  ok(ft2DecodeAudio(clean, { frequencies: [200, 5800], book }).length === 0,
    "candidates within 375 Hz of the band edges are refused, as the reference does");

  // Free text and a hashed call travel the same path.
  for (const m of ["TNX 73 GL", "<K9XYZ> PJ4/KA1ABC RR73"]) {
    const b2 = new HashCallBook();
    b2.save("K9XYZ");
    b2.save("PJ4/KA1ABC");
    const e = ft2Encode(m, 1200, b2);
    const d = ft2DecodeAudio(receive(e.audio, 0.2, 0.5, 23), { frequencies: [1200], book: b2 });
    ok(d.length === 1 && d[0]!.message === m, `round-trips through audio: ${m}`, d[0]?.message);
  }
}

section("sample-rate independence (DAX supplies 24 kHz, FT2 is defined at 12)");
{
  ok(ft2SamplesPerSymbol(12_000) === 160, "160 samples/symbol at the native 12 kHz");
  ok(ft2SamplesPerSymbol(24_000) === 320, "320 at DAX's 24 kHz");
  ok(ft2Decimation(12_000) === 16 && ft2Decimation(24_000) === 32, "decimation is 16 or 32");
  // The detector always runs at 750 Hz — 10 samples/symbol. Decimating to a FIXED
  // RATE rather than by a fixed FACTOR is what makes one demodulator serve both
  // rates: only the factor and the anti-alias filter change.
  ok(FT2_DOWN_RATE === 750, "the detector always works at 750 Hz");

  for (const bad of [8000, 11_025, 44_100]) {
    let threw = false;
    try {
      ft2Decimation(bad);
    } catch {
      threw = true;
    }
    ok(threw, `refuses to demodulate at ${bad} Hz — it does not divide to 750`);
  }
  // 11025 and 44100 DO give whole samples/symbol (147 and 588), so they can
  // generate a valid waveform even though this detector cannot read one back.
  // The two functions guard different things and it would be wrong to conflate
  // them: symbol timing versus detector rate.
  ok(ft2SamplesPerSymbol(44_100) === 588, "44.1 kHz gives whole symbols, so TX is fine there");
  let spsThrew = false;
  try {
    ft2SamplesPerSymbol(8000);
  } catch {
    spsThrew = true;
  }
  ok(spsThrew, "but 8 kHz gives 106.67 samples/symbol and is refused");

  const book = new HashCallBook();
  book.save("K9XYZ");
  const MSG = "CQ K9XYZ EN52";
  for (const rate of [12_000, 24_000, 48_000]) {
    const enc = ft2Encode(MSG, 1500, book, rate);
    ok(
      enc.audio.length === 146 * ft2SamplesPerSymbol(rate),
      `${rate} Hz: ${enc.audio.length} samples`,
    );
    // The duration must be identical at every rate. A fixed samples-per-symbol
    // with a changing rate is exactly the bug that once made an FT8 frame come
    // out at 6.32 s instead of 12.64 s — it looks like a working transmitter.
    ok(
      Math.abs(enc.audio.length / rate - 1.9467) < 0.001,
      `${rate} Hz: 1.947 s, the same as every other rate`,
      (enc.audio.length / rate).toFixed(4),
    );

    const rng = seededRandom(rate);
    const lead = Math.round(0.2 * rate);
    const w = new Float32Array(lead + enc.audio.length + rate);
    for (let i = 0; i < w.length; i++) w[i] = gaussian(rng) * 0.8;
    for (let i = 0; i < enc.audio.length; i++) w[lead + i] = w[lead + i]! + enc.audio[i]!;
    const d = ft2DecodeAudio(w, { frequencies: [1500], book, sampleRate: rate });
    ok(d.length === 1 && d[0]!.message === MSG, `${rate} Hz: decodes back to "${d[0]?.message}"`);
    ok(
      d.length === 1 && Math.abs(d[0]!.dtSeconds - 0.2) < 0.02,
      `${rate} Hz: DT is right too — ${d[0]?.dtSeconds.toFixed(3)} s`,
    );
    ok(
      d.length === 1 && Math.abs(d[0]!.frequencyHz - 1500) <= 2,
      `${rate} Hz: frequency is right — ${d[0]?.frequencyHz.toFixed(0)} Hz`,
    );
  }
}

section("wired into the radio: transmit path through the DAX receive path");
{
  // Timing. FT2's guard time is the number that constrains everything else.
  ok(periodMs("FT8") === 15_000 && periodMs("FT4") === 7_500, "FT8/FT4 periods unchanged");
  // 3.75 s is `m_TRperiod=3.75` in on_actionFT2_triggered — the integrated mode's
  // own scheduler value. This was 2.5 s for several releases, taken from
  // NMAX=30000 in ft2_params.f90, which is the decode-buffer length in K1JT's
  // standalone harness and NOT a T/R period. Both numbers are in the reference
  // tree; only one of them is this.
  ok(periodMs("FT2") === 3_750, "FT2's T/R period is 3.75 s");
  ok(FT2_PERIOD_MS === periodMs("FT2"), "the DAX and TX sides agree on the period");
  const guard = periodMs("FT2") - transmitDurationMs("FT2");
  ok(
    Math.round(transmitDurationMs("FT2")) === 1947,
    `FT2 transmits for ${transmitDurationMs("FT2").toFixed(0)} ms — 146 symbols, including the pulse tail`,
  );
  ok(guard > 1_700 && guard < 1_900, `leaving ${guard.toFixed(0)} ms of guard time`);
  // With the wrong 2.5 s period the guard came out at 553 ms and FT2 looked like
  // it needed special timing treatment. It does not.
  ok(
    guard > (periodMs("FT8") - transmitDurationMs("FT8")) / 2,
    "over half of FT8's guard time, so FT2 needs no special window handling",
  );
  // Anchor on an actual 3.75 s boundary. 1_700_000_000_000 is not one — it is a
  // multiple of 2500 but not of 3750, which is exactly why the old 2.5 s value let
  // a sloppier version of this assertion pass.
  const t = Math.ceil(1_700_000_000_000 / 3_750) * 3_750;
  ok(t % 3_750 === 0, "test anchor is on a 3.75 s boundary");
  ok(nextWindowStart("FT2", t) === t, "a boundary instant is its own window start");
  ok(nextWindowStart("FT2", t + 1) === t + 3_750, "and the next boundary is 3.75 s out");
  ok(nextWindowStart("FT2", t + 3_749) === t + 3_750, "anywhere inside the window rounds up");

  // FT2 HAS calling frequencies — every one marked `// provisional` in WSJT-X
  // Improved's own FrequencyList.cpp. An earlier release asserted the opposite on
  // the strength of a hard-coded fMHz=7.074 in the standalone harness's decoder.
  const ft2Freqs = DIGITAL_FREQUENCIES.filter((f) => f.mode === "FT2");
  ok(ft2Freqs.length === 12, `12 FT2 calling frequencies`, String(ft2Freqs.length));
  for (const [hz, band] of [
    [14_084_000, "20M"],
    [28_184_000, "10M"],
    [7_052_000, "40M"],
    [144_177_000, "2M"],
  ] as const) {
    const hit = ft2Freqs.find((f) => f.hz === hz);
    ok(hit?.band === band, `${(hz / 1e6).toFixed(3)} MHz is FT2 on ${band}`);
    ok(inferDigitalMode(hz).mode === "FT2", `and ${(hz / 1e6).toFixed(3)} infers as FT2`);
  }
  // FT2 sits 4 kHz above FT4 on most bands, which is close enough that a sloppy
  // tolerance would confuse them.
  ok(inferDigitalMode(14_080_000).mode === "FT4", "14.080 is still FT4, 4 kHz below");
  ok(inferDigitalMode(7_074_000).mode === "FT8", "7.074 is still FT8");
  // 60 m is genuinely shared: WSJT-X lists FT8, FT4 and FT2 all on 5.357, because
  // the band is narrow and channelised. The tie resolves to whichever is listed
  // first, and FT8 leads the table — the right answer, since FT8 is far and away
  // the most likely occupant and picking FT2 there would stop FT8 decoding.
  ok(
    ft2Freqs.some((f) => f.hz === 5_357_000),
    "FT2 is listed on 5.357 MHz",
  );
  ok(
    inferDigitalMode(5_357_000).mode === "FT8",
    "but the 60 m collision resolves to FT8, which is listed first",
    inferDigitalMode(5_357_000).mode,
  );
  // periodMsFor was a ternary that silently answered 15 s for FT2 the moment FT2
  // joined DigitalMode. A 15 s window on a 3.75 s mode decodes nothing and looks
  // perfectly healthy doing it.
  ok(periodMsFor("FT2") === 3_750, "periodMsFor knows FT2 is 3.75 s");
  ok(
    periodMsFor("FT8") === 15_000 && periodMsFor("FT4") === 7_500,
    "and still has FT8/FT4 right",
  );

  // The real integration: build the transmit waveform exactly as the radio
  // service does, then push it through the DAX receive chain — 24 kHz down to
  // 12 kHz, normalised — and decode it. This is the on-air path end to end.
  const tx = new FlexDaxTransmitter({ host: "127.0.0.1", allowTransmit: false });
  const MSG = "CQ K9XYZ EN52";
  const wave = tx.buildWaveform(MSG, "FT2", 1500);
  ok(wave.length === 46_720, `buildWaveform gives ${wave.length} samples at 24 kHz`);
  ok(
    Math.abs(wave.length / 24_000 - 1.9467) < 0.001,
    "which is the same 1.947 s the 12 kHz path produces",
  );

  const book = new HashCallBook();
  book.save("K9XYZ");
  let through = 0;
  for (const noise of [0, 0.3, 0.8]) {
    const rng = seededRandom(31 + Math.round(noise * 10));
    const lead = Math.round(0.2 * 24_000);
    const w24 = new Float32Array(lead + wave.length + 24_000);
    // DAX audio arrives at around 0.07 peak, so scale to that rather than testing
    // at full scale — `normalise` exists precisely because the levels are small,
    // and a test at unity amplitude would not exercise it.
    for (let i = 0; i < w24.length; i++) w24[i] = gaussian(rng) * noise * 0.05;
    for (let i = 0; i < wave.length; i++) w24[lead + i] = w24[lead + i]! + wave[i]! * 0.05;

    const a12 = decimateBy2(w24);
    normalise(a12);
    const d = ft2DecodeAudio(a12, {
      frequencies: [1500],
      book,
      sampleRate: DECODE_SAMPLE_RATE,
    });
    if (d.length === 1 && d[0]!.message === MSG && Math.abs(d[0]!.dtSeconds - 0.2) < 0.02) {
      through++;
    }
  }
  ok(
    through === 3,
    "transmit waveform survives the DAX decimate-and-normalise path at all 3 noise levels",
    String(through),
  );

  // The offset guard must apply to FT2 as it does to the other modes: outside
  // 200-2800 Hz the slice filter clips the signal.
  for (const off of [150, 3000]) {
    let threw = false;
    try {
      tx.buildWaveform(MSG, "FT2", off);
    } catch {
      threw = true;
    }
    ok(threw, `refuses a ${off} Hz audio offset for FT2`);
  }
}


section("the live DAX window is long enough for the FT2 decoder");
{
  // ft2DecodeAudio refuses a buffer shorter than the frame plus the DT search
  // span. That gate is invisible from inside the codec tests, which hand it a
  // generous buffer, and it silently rejected EVERY window on the live path for
  // several releases: the 0.42.1 on-air run concluded "the silence is absence of
  // signals, not a dead decoder" when in truth the decoder was never reached.
  //
  // Asserting against the real window arithmetic is what closes that gap.
  const DAX_RATE = 24_000;
  const frameMs = transmitDurationMs("FT2");
  const cutMarginMs = 1_200; // FlexDaxSource.CUT_MARGIN_MS, shared by every mode
  const windowMs = frameMs + cutMarginMs;
  const at24k = Math.round((windowMs / 1000) * DAX_RATE);
  const at12k = Math.floor(at24k / 2); // decimateBy2
  const needed = (144 * 10 + 375) * ft2Decimation(DECODE_SAMPLE_RATE);

  ok(windowMs < periodMs("FT2"), `window ${windowMs} ms fits inside the ${periodMs("FT2")} ms period`);
  ok(
    at12k >= needed,
    `the live window gives ${at12k} samples at 12 kHz, decoder needs ${needed}`,
    `short by ${needed - at12k}`,
  );
  // And prove it with the real decoder rather than trusting the arithmetic.
  const book = new HashCallBook();
  book.save("K9XYZ");
  const enc = ft2Encode("CQ K9XYZ EN52", 1500, book, DECODE_SAMPLE_RATE);
  const buf = new Float32Array(at12k);
  for (let i = 0; i < enc.audio.length && 300 + i < buf.length; i++) buf[300 + i] = enc.audio[i]!;
  const d = ft2DecodeAudio(buf, { frequencies: [1500], book, sampleRate: DECODE_SAMPLE_RATE });
  ok(d.length === 1, "a signal in a real-length live window actually decodes", `${d.length} decodes`);
}

section("FT2 end to end: text -> audio -> text");
{
  const book = new HashCallBook();
  book.save("K9XYZ");
  const messages = ["CQ K9XYZ EN52", "SP1ABC K9XYZ -12", "SP1ABC K9XYZ RR73", "TNX 73 GL"];
  let good = 0;
  for (const m of messages) {
    const enc = ft2Encode(m, 1500, book);
    if (enc.audio.length !== 23_360 || enc.symbols.length !== 144) continue;
    const dec = ft2DecodeSymbols(enc.symbols, book);
    if (dec.ok && dec.message === m && dec.syncErrors === 0 && dec.parityErrors === 0) good++;
  }
  ok(good === messages.length, `all ${messages.length} messages survive encode -> decode`, String(good));

  const enc = ft2Encode("CQ K9XYZ EN52", 1500, book);
  ok(enc.i3 === 1, "a CQ encodes as payload type 1");
  ok(enc.sent === "CQ K9XYZ EN52", "sent matches the request when nothing is lost");
  ok(enc.messageBits.length === 77, "77 payload bits");

  // Damage must be detected, never silently mis-decoded.
  const bent = Uint8Array.from(enc.symbols);
  bent[40] = bent[40]! ^ 1;
  const d = ft2DecodeSymbols(bent, book);
  ok(!d.ok && d.parityErrors > 0, "a single flipped data symbol fails parity", d.reason);

  const desynced = Uint8Array.from(enc.symbols);
  for (let i = 0; i < 16; i++) desynced[i] = desynced[i]! ^ 1;
  const ds = ft2DecodeSymbols(desynced, book);
  ok(ds.syncErrors === 16, "an inverted sync pattern is counted");
  ok(ds.ok, "sync errors alone do not reject - the demodulator decides what to tolerate");

  let threw = false;
  try {
    ft2Encode("CQ K9XYZ EN52", 50, book);
  } catch {
    threw = true;
  }
  ok(threw, "an out-of-range audio frequency is refused");
}

console.log("\nFT2 as a logbook mode");
{
  const a = toAdifMode("FT2");
  ok(a.mode === "MFSK" && a.submode === "FT2", "exports as MODE=MFSK SUBMODE=FT2");
  ok(fromAdifMode("MFSK", "FT2") === "FT2", "imports from MFSK/FT2");
  ok(fromAdifMode("FT2") === "FT2", "imports from a bare MODE=FT2");
  ok(isDigitalMode("FT2"), "counts as digital");
  ok(isLoggableMode("FT2"), "is loggable");
  ok(adifToQslRoute("B") === "BUREAU", "sanity: unrelated ADIF helpers still fine");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

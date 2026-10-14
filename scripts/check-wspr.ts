/* eslint-disable no-console */
// Assertions on the WSPR codec.
// Run: npm run check:wspr
//
// THE GOLDEN VECTORS ARE THE REFERENCE'S OWN. Every "Data is" line and every channel-symbol
// vector below was printed by `wsprsim -c -d`, built from WSJT-X lib/wsprd on the live box
// on 2026-10-14 — the same sources this port was written from, compiled and RUN rather than
// read. A port that agrees with its own round trip proves only that its encoder and decoder
// share a mistake; agreeing byte for byte with the binary every WSPR station on the air is
// decoded by proves the packing, the convolutional code, the interleave, the sync vector and
// the hash are the real ones.

import {
  WSPR_BAUD,
  WSPR_SAMPLES_PER_SYMBOL,
  WSPR_SYMBOLS,
  WSPR_SYNC,
  WSPR_TX_MS,
  WsprHashTable,
  channelSymbolsFor,
  deinterleave,
  encodeConvolutional,
  fanoDecode,
  interleave,
  nhash,
  packWsprMessage,
  unpack50,
  unpackWsprMessage,
  wsprChannelSymbols,
  wsprMetricTable,
  wsprWaveform,
} from "../lib/digital/wspr";
import { WSPR_METRIC_TABLE } from "../lib/digital/wspr-metric";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
const syms = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map(Number));

/** `wsprsim -c -d "<message>"` on the box, verbatim. */
const GOLDEN: { message: string; type: 1 | 2 | 3; data: string; symbols: string }[] = [
  {
    message: "K1ABC FN42 37",
    type: 1,
    data: "F7 0C 23 8B 0D 19 40 00 00 00 00",
    symbols:
      "3 3 0 0 2 0 0 0 1 0 2 0 1 3 1 2 2 2 1 0 0 3 2 3 1 3 3 2 2 0 2 0 0 0 3 2 0 1 2 3 2 2 0 0 2 2 3 2 1 1 0 2 3 3 2 1 0 2 2 1 3 2 1 2 2 2 0 3 3 0 3 0 3 0 1 2 1 0 2 1 2 0 3 2 1 3 2 0 0 3 3 2 3 0 3 2 2 0 3 0 2 0 2 0 1 0 2 3 0 2 1 1 1 2 3 3 0 2 3 1 2 1 2 2 2 1 3 3 2 0 0 0 0 1 0 3 2 0 1 3 2 2 2 2 2 0 2 3 3 2 3 2 3 3 2 0 0 3 1 2 2 2",
  },
  {
    message: "W1AW FN31 37",
    type: 1,
    data: "F9 4C EE FB 23 79 40 00 00 00 00",
    symbols:
      "3 3 2 2 2 0 0 0 1 2 2 0 3 3 3 2 2 2 3 0 2 1 0 1 3 1 3 0 0 0 0 0 0 0 1 2 0 1 0 3 2 0 2 0 0 2 3 2 3 1 2 2 1 3 0 1 2 2 2 1 1 2 3 2 2 0 0 1 3 0 1 0 1 0 1 2 1 0 2 1 0 0 1 0 1 1 2 0 0 3 3 0 1 0 1 2 2 2 1 2 0 2 0 2 1 0 2 3 2 0 1 1 3 0 1 3 0 2 1 1 2 3 2 0 0 1 3 3 2 2 2 0 2 3 0 3 0 0 3 3 2 2 0 2 2 0 0 3 3 0 3 2 1 3 0 0 0 1 3 2 2 0",
  },
  {
    message: "K9AN EN50 33",
    type: 1,
    data: "F7 32 AA CB D7 58 40 00 00 00 00",
    symbols:
      "3 3 2 0 0 2 0 2 1 0 0 0 1 3 1 0 2 2 3 0 2 3 0 1 1 1 1 2 0 2 0 2 0 0 3 2 2 3 0 1 2 2 0 2 2 2 1 0 1 1 2 2 1 3 0 3 0 0 0 1 1 0 3 2 2 0 2 3 3 2 1 0 3 2 1 0 3 0 0 3 2 0 3 0 1 3 0 0 0 3 1 2 1 2 1 2 2 0 1 2 0 2 0 0 1 0 2 1 0 2 3 3 1 2 3 3 2 2 1 1 0 1 2 0 0 1 3 3 2 2 0 0 2 3 2 1 2 0 3 3 0 2 2 0 2 2 0 3 1 0 3 2 3 1 2 2 0 3 1 2 2 2",
  },
  {
    message: "PJ4/K1ABC 37",
    type: 2,
    data: "F7 0C 23 81 0E 99 C0 00 00 00 00",
    symbols:
      "3 1 0 2 2 0 0 0 1 0 2 2 1 3 1 0 2 0 1 0 0 1 2 3 1 3 1 2 2 0 2 2 0 2 3 0 0 3 0 3 2 2 0 2 2 0 1 0 1 3 0 0 3 1 0 1 0 0 0 3 3 2 3 2 2 2 0 1 3 0 1 0 3 0 1 2 1 0 0 3 2 0 3 2 1 1 2 2 0 3 3 2 3 0 3 0 2 2 3 0 2 2 0 2 1 0 2 3 0 0 1 3 1 0 3 1 0 0 3 1 2 3 0 0 2 1 3 3 2 0 0 0 0 1 0 1 2 0 1 1 2 2 2 2 2 2 2 1 3 2 3 2 3 1 0 2 0 1 1 0 2 2",
  },
  {
    message: "K1ABC/P 37",
    type: 2,
    data: "F7 0C 23 8D 4F 39 C0 00 00 00 00",
    symbols:
      "3 1 0 2 2 0 0 0 1 0 2 2 1 1 1 0 2 0 1 0 0 1 2 1 1 1 3 2 2 2 0 2 0 0 3 0 0 1 2 1 2 2 0 2 2 2 3 0 1 3 0 0 3 3 0 1 0 0 0 1 3 2 3 2 2 2 0 1 3 0 3 2 3 0 1 2 1 0 0 3 2 2 3 2 1 3 0 2 0 1 1 2 3 2 3 0 2 2 3 0 2 0 0 0 1 0 2 3 0 2 1 3 1 2 3 3 0 0 1 1 2 3 0 0 2 1 3 3 2 0 0 0 0 3 0 1 2 0 1 3 2 0 0 2 2 0 2 3 3 0 1 2 3 1 2 2 0 3 3 0 2 0",
  },
  {
    message: "<PJ4/K1ABC> FK52UD 37",
    type: 3,
    data: "88 24 7C 69 A2 E6 80 00 00 00 00",
    symbols:
      "3 3 2 0 2 2 2 2 3 0 0 2 1 3 3 2 0 2 3 0 0 3 0 3 1 3 1 2 2 0 2 2 2 0 1 2 0 3 2 3 0 0 2 0 0 0 1 0 3 1 0 0 1 3 2 1 0 2 0 3 1 0 3 0 0 0 2 1 1 0 1 0 1 0 3 2 3 0 2 1 0 0 1 0 1 3 0 0 2 1 1 2 3 0 3 2 2 0 1 2 0 2 2 2 1 2 0 3 0 2 1 3 1 0 1 3 0 2 1 1 0 1 2 2 0 1 1 1 2 2 2 2 0 3 2 1 2 2 3 1 0 0 2 0 0 0 0 3 1 0 1 0 1 1 0 0 0 1 1 2 0 2",
  },
  {
    message: "<K1ABC> FN42JJ 37",
    type: 3,
    data: "9C 38 5D F3 2F 26 80 00 00 00 00",
    symbols:
      "3 3 0 2 2 2 2 2 3 0 2 0 3 1 3 2 2 0 1 2 0 1 0 3 1 1 1 2 2 2 0 2 2 0 1 2 0 3 0 1 2 0 0 2 0 0 1 0 1 3 2 2 3 1 0 1 2 0 0 1 3 0 1 0 0 2 2 1 1 0 3 2 3 2 1 0 3 0 0 1 0 2 3 0 3 1 0 0 2 3 3 2 1 2 3 2 2 0 1 0 0 2 2 2 3 2 2 1 0 2 3 3 3 0 1 3 0 2 3 1 0 3 2 0 0 1 3 1 2 2 2 2 2 3 2 1 2 2 1 3 2 2 0 0 2 0 0 1 1 0 1 0 1 1 0 2 2 3 1 2 0 2",
  },
];

// ---------------------------------------------------------------------------
console.log("parameters");
// ---------------------------------------------------------------------------
{
  eq(WSPR_SYMBOLS, 162, "162 channel symbols");
  eq(WSPR_SAMPLES_PER_SYMBOL, 8192, "8192 samples per symbol at 12 kHz");
  ok(Math.abs(WSPR_BAUD - 1.4648) < 0.0001, `1.4648 baud (${WSPR_BAUD.toFixed(5)})`);
  ok(Math.abs(WSPR_TX_MS - 110592) < 1, `110.592 s on the air (${WSPR_TX_MS} ms)`);
  eq(WSPR_SYNC.length, 162, "the sync vector has one bit per symbol");
  // 63 is counted from pr3, not published anywhere; the section after this one is what
  // actually verifies the vector, bit for bit, against the reference's symbols.
  eq(WSPR_SYNC.filter((b) => b === 1).length, 63, "with 63 ones");
}

// ---------------------------------------------------------------------------
console.log("\nthe sync vector is the low bit of every reference symbol vector");
// ---------------------------------------------------------------------------
for (const g of GOLDEN) {
  const s = syms(g.symbols);
  eq(s.length, 162, `${g.message}: 162 symbols from wsprsim`);
  ok(s.every((v, i) => (v & 1) === WSPR_SYNC[i]), `${g.message}: symbol & 1 == sync for all 162`);
}

// ---------------------------------------------------------------------------
console.log("\npacking: the 11 data bytes, byte for byte, for all three message types");
// ---------------------------------------------------------------------------
for (const g of GOLDEN) {
  const p = packWsprMessage(g.message);
  ok(p !== null, `${g.message}: packs`);
  if (!p) continue;
  eq(p.type, g.type, `${g.message}: type ${g.type}`);
  eq(hex(p.data), g.data, `${g.message}: data == wsprsim's`);
}
{
  ok(packWsprMessage("K1ABC FN42 35") === null, "a type 1 power the format cannot carry (35) is refused");
  const p = packWsprMessage("PJ4/K1ABC 35");
  ok(p !== null && unpackWsprMessage(p.data, new WsprHashTable())?.power === 37, "a type 2 power is snapped as the reference snaps it: 35 -> 37");
  ok(packWsprMessage("K1ABC") === null, "a bare callsign is not a message");
  ok(packWsprMessage("ABCDEFG FN42 37") === null, "a seven-character call does not fit");
}

// ---------------------------------------------------------------------------
console.log("\nthe code and the interleave: channel symbols, all 162, for every message");
// ---------------------------------------------------------------------------
for (const g of GOLDEN) {
  const s = wsprChannelSymbols(g.message);
  ok(s !== null && hex(s) === hex(syms(g.symbols)), `${g.message}: symbols == wsprsim's`);
}
{
  const coded = encodeConvolutional(Uint8Array.from([0xf7, 0x0c, 0x23, 0x8b, 0x0d, 0x19, 0x40, 0, 0, 0, 0]));
  eq(coded.length, 176, "11 bytes encode to 176 coded bits");
  const first162 = coded.subarray(0, 162);
  const back = deinterleave(interleave(first162));
  ok(first162.every((b, i) => b === back[i]), "deinterleave(interleave(x)) == x");
  const golden = syms(GOLDEN[0]!.symbols);
  const bits = deinterleave(golden.map((v) => v >> 1));
  ok(bits.every((b, i) => b === first162[i]), "deinterleaving the reference symbols gives the coded bits");
}

// ---------------------------------------------------------------------------
console.log("\nunpacking: back to the text, and the hash table learns as the reference does");
// ---------------------------------------------------------------------------
{
  const hashes = new WsprHashTable();
  for (const g of GOLDEN.filter((x) => x.type !== 3)) {
    const m = unpackWsprMessage(Uint8Array.from(g.data.split(" ").map((h) => parseInt(h, 16))), hashes);
    eq(m?.text, g.message, `${g.message}: unpacks to itself`);
  }
  // Type 3 before anybody has said PJ4/K1ABC in the clear: the hash is unknown.
  const fresh = new WsprHashTable();
  const t3 = GOLDEN.find((x) => x.message.startsWith("<PJ4"))!;
  const bytes3 = Uint8Array.from(t3.data.split(" ").map((h) => parseInt(h, 16)));
  eq(unpackWsprMessage(bytes3, fresh)?.text, "<...> FK52UD 37", "a type 3 with an unknown hash shows <...>");
  // After the type 2 has been heard, it resolves.
  eq(unpackWsprMessage(bytes3, hashes)?.text, "<PJ4/K1ABC> FK52UD 37", "and resolves once the station's type 2 has been heard");
  const t3b = GOLDEN.find((x) => x.message.startsWith("<K1ABC"))!;
  eq(
    unpackWsprMessage(Uint8Array.from(t3b.data.split(" ").map((h) => parseInt(h, 16))), hashes)?.text,
    "<K1ABC> FN42JJ 37",
    "a six-character grid comes back whole",
  );
}

// ---------------------------------------------------------------------------
console.log("\nthe hash: nhash agrees with the hash the reference packed into its type 3 bytes");
// ---------------------------------------------------------------------------
{
  for (const [call, msg] of [["PJ4/K1ABC", "<PJ4/K1ABC> FK52UD 37"], ["K1ABC", "<K1ABC> FN42JJ 37"]] as const) {
    const g = GOLDEN.find((x) => x.message === msg)!;
    const { n2 } = unpack50(Uint8Array.from(g.data.split(" ").map((h) => parseInt(h, 16))));
    const ntype = (n2 & 127) - 64;
    const referenceHash = (n2 - ntype - 64) / 128;
    eq(nhash(call), referenceHash, `nhash("${call}") == ${referenceHash}, the value wsprsim packed`);
  }
  ok(nhash("K1ABC") !== nhash("K1ABD"), "a one-letter change changes the hash");
  ok(nhash("K1ABC") < 32768, "and it is 15 bits");
}

// ---------------------------------------------------------------------------
console.log("\nthe Fano decoder: the reference's metrics, the reference's thresholds");
// ---------------------------------------------------------------------------
{
  const mettab = wsprMetricTable(WSPR_METRIC_TABLE);
  eq(mettab[0][0], Math.round(10 * (WSPR_METRIC_TABLE[0]! - 0.45)), "metric[0][i] = round(10 * (table[i] - bias))");
  eq(mettab[1][0], Math.round(10 * (WSPR_METRIC_TABLE[255]! - 0.45)), "metric[1][i] = round(10 * (table[255 - i] - bias))");

  // A deterministic generator, so a failure is reproducible.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const gaussian = () => {
    const u = rnd() || 1e-9;
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const toSoft = (bits: Uint8Array, amp: number, noise: number): Uint8Array => {
    const out = new Uint8Array(162);
    for (let i = 0; i < 162; i++) {
      const v = (bits[i] ? amp : -amp) + noise * gaussian();
      out[i] = Math.max(0, Math.min(255, Math.round(v + 128)));
    }
    return out;
  };

  for (const g of GOLDEN) {
    const data = Uint8Array.from(g.data.split(" ").map((h) => parseInt(h, 16)));
    const coded = deinterleave(channelSymbolsFor(data).map((v) => v >> 1));
    const clean = fanoDecode(toSoft(coded, 50, 0), mettab);
    ok(clean.ok && hex(clean.data) === g.data, `${g.message}: decodes from clean symbols`, hex(clean.data));
  }

  const data = Uint8Array.from(GOLDEN[0]!.data.split(" ").map((h) => parseInt(h, 16)));
  const coded = deinterleave(channelSymbolsFor(data).map((v) => v >> 1));
  let decoded = 0;
  const TRIALS = 20;
  for (let t = 0; t < TRIALS; t++) {
    const r = fanoDecode(toSoft(coded, 50, 50), mettab);
    if (r.ok && hex(r.data) === GOLDEN[0]!.data) decoded++;
  }
  ok(decoded === TRIALS, `decodes ${decoded}/${TRIALS} trials at noise equal to the symbol amplitude (0 dB per symbol)`);

  const erased = toSoft(coded, 50, 0);
  for (let i = 0; i < 162; i += 4) erased[i] = 128;
  const e = fanoDecode(erased, mettab);
  ok(e.ok && hex(e.data) === GOLDEN[0]!.data, "a quarter of the symbols erased (128) still decodes");

  let timedOut = 0;
  for (let t = 0; t < 5; t++) {
    const junk = new Uint8Array(162);
    for (let i = 0; i < 162; i++) junk[i] = Math.round(128 + 50 * gaussian());
    const r = fanoDecode(junk, mettab);
    if (!r.ok) timedOut++;
  }
  ok(timedOut === 5, `noise alone times out, 5/5 (${timedOut}/5) - the decoder has no false-success mode short of a real message`);
}

// ---------------------------------------------------------------------------
console.log("\nthe waveform: 4-FSK at the right tones, phase-continuous, no shaping");
// ---------------------------------------------------------------------------
{
  const s = syms(GOLDEN[0]!.symbols);
  const audio = wsprWaveform(s);
  eq(audio.length, 162 * 8192, "162 x 8192 samples at 12 kHz");
  let maxJump = 0;
  for (let i = 1; i < audio.length; i++) maxJump = Math.max(maxJump, Math.abs(audio[i]! - audio[i - 1]!));
  ok(maxJump < 0.8, `no phase discontinuity: largest sample-to-sample step ${maxJump.toFixed(3)} (a 1503 Hz tone steps at most 0.787)`);
  // Each symbol correlates best with its own tone.
  let right = 0;
  for (let i = 0; i < 162; i++) {
    let best = -1;
    let bestP = -1;
    for (let tone = 0; tone < 4; tone++) {
      const f = 1500 + (tone - 1.5) * WSPR_BAUD;
      let re = 0;
      let im = 0;
      for (let j = 0; j < 8192; j++) {
        const ph = (2 * Math.PI * f * j) / 12000;
        re += audio[i * 8192 + j]! * Math.cos(ph);
        im += audio[i * 8192 + j]! * Math.sin(ph);
      }
      const p = re * re + im * im;
      if (p > bestP) {
        bestP = p;
        best = tone;
      }
    }
    if (best === s[i]) right++;
  }
  eq(right, 162, "every symbol's block correlates best with its own tone");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all wspr assertions passed");

/* eslint-disable no-console */
// NAVTEX / SITOR-B checks: the CCIR 476 code against its defining property and the ITU
// patterns, the FEC layout against the example fldigi quotes from JNX, the message header
// parser and assembler, the station list, and the receiver end to end - at 12, 24 and 48
// kHz, chunked, off frequency, inverted, against damaged copies of every character, in
// noise down to the copy limit, and on noise and digital silence alone.
// Run: npx tsx scripts/check-navtex.ts
//
// There is no fldigi binary to compare against here. The tables are compared against
// fldigi's arrays by their spot values and their structure (every code four marks of
// seven, 35 of them), and the receiver against navtexWaveform, a test generator built
// from the same specification (ITU-R M.476 / M.625 / M.540) by a different path.

import {
  CCIR476_ALPHA,
  CCIR476_CHAR32,
  CCIR476_FIGS,
  CCIR476_FIGURES_ITA2,
  CCIR476_FIGURES_US,
  CCIR476_LETTERS,
  CCIR476_LTRS,
  CCIR476_REP,
  CCIR476_VALID_CODES,
  Ccir476Decoder,
  NAVTEX_STATIONS,
  NAVTEX_SUBJECTS,
  NavtexMessageAssembler,
  ccir476Encode,
  ccir476Marks,
  ccir476Valid,
  navtexCleanText,
  navtexCodeStream,
  navtexDurationMs,
  navtexFecStream,
  navtexMessageText,
  navtexStation,
  navtexStations,
  navtexSubject,
  navtexWaveform,
  parseNavtexMessage,
  type NavtexWaveformOptions,
} from "@/lib/digital/navtex";
import { NavtexDemodulator, type NavtexDemodOptions } from "@/lib/digital/navtexdemod";

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
  ok(JSON.stringify(a) === JSON.stringify(b), what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** Deterministic Gaussian noise: an LCG under Box-Muller, so a noise assertion is repeatable. */
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** A signal with `lead` and `tail` seconds of silence round it, and optional noise at an S/N in 2500 Hz. */
function signal(text: string, opts: NavtexWaveformOptions & { lead?: number; tail?: number; snrDb?: number; seed?: number }): Float32Array {
  const fs = opts.sampleRate;
  const sig = navtexWaveform(text, opts);
  const lead = Math.round((opts.lead ?? 0.5) * fs);
  const x = new Float32Array(lead + sig.length + Math.round((opts.tail ?? 0.5) * fs));
  x.set(sig, lead);
  if (opts.snrDb !== undefined) {
    const amp = opts.amplitude ?? 0.5;
    const noiseIn2500 = (amp * amp) / 2 / 10 ** (opts.snrDb / 10);
    const sigma = Math.sqrt((noiseIn2500 * (fs / 2)) / 2500);
    const g = gaussian(opts.seed ?? 1);
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + sigma * g();
  }
  return x;
}

function decode(x: Float32Array, opts: NavtexDemodOptions, chunk = 4096): { text: string; d: NavtexDemodulator } {
  const d = new NavtexDemodulator(opts);
  let text = "";
  for (let i = 0; i < x.length; i += chunk) text += d.feed(x.subarray(i, i + chunk));
  return { text, d };
}

/** What the receiver prints for a message: what was sent, without the CRs. */
function printed(text: string, opts: Parameters<typeof navtexMessageText>[1] = {}): string {
  return navtexMessageText(text, opts).replace(/\r/g, "");
}

const MSG = "SECURITE. GALE WARNING 12. SOUTHERN NORTH SEA, WINDS SW 8 TO 9.\nTIME 0630 UTC 05/11. CHART 1234 (WGS84) 51-03.9N 001-09.2E?";

// ---------------------------------------------------------------------------
console.log("the CCIR 476 code");
// ---------------------------------------------------------------------------
{
  eq(CCIR476_VALID_CODES.length, 35, "35 of the 128 seven-bit patterns have exactly four marks");
  eq(CCIR476_LETTERS.length, 128, "letters table: 128 entries");
  eq(CCIR476_FIGURES_ITA2.length, 128, "ITA2 figures table: 128 entries");
  eq(CCIR476_FIGURES_US.length, 128, "US figures table: 128 entries");
  for (const [name, t] of [["letters", CCIR476_LETTERS], ["ITA2 figures", CCIR476_FIGURES_ITA2], ["US figures", CCIR476_FIGURES_US]] as const) {
    const bad = t.map((c, i) => (c !== null && ccir476Marks(i) !== 4 ? i : -1)).filter((i) => i >= 0);
    eq(bad, [], `every code in the ${name} table has four marks of seven`);
  }
  for (const c of [CCIR476_LTRS, CCIR476_FIGS, CCIR476_ALPHA, CCIR476_REP, CCIR476_CHAR32, 0x33]) ok(ccir476Valid(c), `control 0x${c.toString(16)} has four marks`);
  const letters = CCIR476_LETTERS.filter((c): c is string => c !== null && /^[A-Z]$/.test(c));
  eq(letters.length, 26, "every letter is in the letters case");
  eq(new Set(letters).size, 26, "each exactly once");
  const used = CCIR476_LETTERS.map((c, i) => (c !== null ? i : -1)).filter((i) => i >= 0);
  eq(used.length + 6, 35, "26 letters, space, CR, LF and the six controls use all 35 codes");
  // ITU-R M.476's patterns, written first bit first with B the higher frequency (1).
  const pattern = (code: number) => Array.from({ length: 7 }, (_, k) => ((code >> k) & 1 ? "B" : "Y")).join("");
  eq(pattern(CCIR476_ALPHA), "BBBBYYY", "alpha (phasing signal 1) is BBBBYYY");
  eq(pattern(CCIR476_REP), "YBBYYBB", "rep (phasing signal 2) is YBBYYBB");
  eq(pattern(CCIR476_LETTERS.indexOf("A")), "BBBYYYB", "A is BBBYYYB");
  eq(CCIR476_LETTERS[0x47], "A", "fldigi's table: 0x47 is A (navtex.cxx:471)");
  eq(CCIR476_LETTERS[0x5c], " ", "0x5c is space");
  eq(CCIR476_LETTERS[0x78], "\r", "0x78 is CR");
  eq(CCIR476_LETTERS[0x6c], "\n", "0x6c is LF");
  eq(CCIR476_FIGURES_ITA2[0x2d], "0", "figures: 0x2d (P) is 0");
  eq(CCIR476_FIGURES_ITA2[0x72], "?", "figures: 0x72 (B) is ?");
  eq(CCIR476_FIGURES_ITA2[0x3c], "=", "ITA2 figures: 0x3c (V) is =");
  eq(CCIR476_FIGURES_US[0x3c], ";", "US figures: 0x3c (V) is ;");
  eq(CCIR476_FIGURES_US[0x4b], "\x07", "US figures: 0x4b (S) is BEL");
  // Error detection: one bit wrong anywhere in any character is always seen.
  let undetected = 0;
  for (const c of CCIR476_VALID_CODES) for (let k = 0; k < 7; k++) if (ccir476Valid(c ^ (1 << k))) undetected++;
  eq(undetected, 0, "every single-bit error in every character leaves an invalid code (245 cases)");
  // Round trip through the encoder and the decoder.
  const all = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 -?:()./,'=+!&$# \r\n";
  for (const variant of ["ita2", "us"] as const) {
    const codes = ccir476Encode(all, variant);
    ok(codes.every(ccir476Valid), `${variant}: everything the encoder sends has four marks`);
    const dec = new Ccir476Decoder(variant);
    const back = codes.map((c) => dec.push(c)).join("");
    const expect = variant === "us" ? all.replace("=", "").replace("+", "") : all;
    eq(back, expect, `${variant}: every character round-trips through encoder and decoder`);
  }
  const codes = ccir476Encode("A1 B");
  eq(codes, [0x47, CCIR476_FIGS, 0x2e, 0x5c, CCIR476_LTRS, 0x72], "A1 B: FIGS before the digit, space stays in figures, LTRS before B (char_to_code)");
  eq(ccir476Encode("é~"), [], "characters with no code are dropped");
}

// ---------------------------------------------------------------------------
console.log("FEC time diversity layout");
// ---------------------------------------------------------------------------
{
  const name = (c: number) => (c === CCIR476_REP ? "rep" : c === CCIR476_ALPHA ? "alpha" : c === CCIR476_CHAR32 ? "blank" : (CCIR476_LETTERS[c] ?? "?"));
  const fec = navtexFecStream(ccir476Encode("NAUTICAL")).map(name).join(" ");
  eq(fec, "rep alpha rep alpha N alpha A alpha U N T A I U C T A I L C blank A blank L", "NAUTICAL as JNX and fldigi lay it out (navtex.cxx:1725-1727)");
  const s = navtexFecStream([1, 2, 3, 4, 5, 6, 7, 8].map((i) => CCIR476_VALID_CODES[i]!));
  let apart = true;
  for (let p = 9; p < s.length - 4; p += 2) if (s[p] !== s[p - 5]) apart = false;
  ok(apart, "every RX slot repeats the DX slot five before it: 35 bits, 350 ms");
  const stream = navtexCodeStream("X", { phasingSeconds: 1 });
  eq(stream.slice(0, 4), [CCIR476_REP, CCIR476_ALPHA, CCIR476_REP, CCIR476_ALPHA], "phasing is rep in DX, alpha in RX");
  const slots = navtexCodeStream("X", { phasingSeconds: 10, tailSeconds: 2 }).length;
  eq(navtexDurationMs("X", { phasingSeconds: 10, tailSeconds: 2 }), slots * 70, "duration: 70 ms a character slot");
  eq(navtexCodeStream("X", { phasingSeconds: 10, tailSeconds: 0 }).slice(0, 142).every((c, i) => c === (i % 2 ? CCIR476_ALPHA : CCIR476_REP)), true, "10 s of phasing is 71 rep/alpha pairs");
}

// ---------------------------------------------------------------------------
console.log("messages: header, parser, assembler, subjects");
// ---------------------------------------------------------------------------
{
  const raw = "ZCZC GA45\r\nNITON NAV WARNING 123\r\nWRECK IN 50-40.2N 001-03.7W.\r\nNNNN\r\n\n";
  const m = parseNavtexMessage(raw);
  eq(m && [m.station, m.type, m.serial, m.subject], ["G", "A", "45", "Navigational warning"], "ZCZC GA45: station G, type A, serial 45, a navigational warning");
  eq(m?.text, "NITON NAV WARNING 123\nWRECK IN 50-40.2N 001-03.7W.", "text between the header and NNNN, cleaned as fldigi does");
  eq(m?.lostTrailer, false, "NNNN seen");
  eq(parseNavtexMessage("ZCZC EE01 GALES")?.lostTrailer, true, "no NNNN: lost trailer");
  eq(parseNavtexMessage("NO HEADER NNNN"), null, "no ZCZC: not a message");
  eq(navtexSubject("B"), "Meteorological warning", "B: meteorological warning");
  eq(navtexSubject("D"), "Search & rescue information, pirate warnings", "D: search and rescue");
  eq(navtexSubject("E"), "Meteorological forecast", "E: weather forecast");
  eq(navtexSubject("q"), navtexSubject("Q"), "subject letters are case-blind");
  eq(Object.keys(NAVTEX_SUBJECTS).length, 18, "fldigi's 18 subjects (navtex.cxx:637-660)");
  eq(navtexCleanText("\r\n  A  B\r\n\r\nC \r\n"), "A B\nC", "cleanup: leading space gone, runs collapsed, nothing trailing");

  const asm = new NavtexMessageAssembler();
  for (const c of "JUNK" + raw + "ZCZC EB07\r\nGALE\r\n" + "ZCZC EE08\r\nFAIR\r\nNNNN") asm.push(c, 0);
  const got = asm.take();
  eq(got.map((x) => `${x.station}${x.type}${x.serial}:${x.text}:${x.lostHeader ? "H" : ""}${x.lostTrailer ? "T" : ""}`), [
    "GA45:NITON NAV WARNING 123\nWRECK IN 50-40.2N 001-03.7W.:",
    "EB07:GALE:T",
    "EE08:FAIR:",
  ], "assembler: a message, one cut short by the next header (lost trailer), and another; junk before a header dropped");
  for (const c of "TAIL OF A MESSAGE\r\nNNNN") asm.push(c, 1);
  eq(asm.take().map((x) => [x.lostHeader, x.text]), [[true, "TAIL OF A MESSAGE"]], "text ending in NNNN with no header: lost header");
  for (const c of "ZCZC AA01\r\nNEVER ENDS") asm.push(c, 10);
  asm.tick(10 + 599);
  eq(asm.take().length, 0, "an open message is not closed before ten minutes");
  asm.tick(10 + 601);
  eq(asm.take().map((x) => [x.serial, x.lostTrailer]), [["01", true]], "after ten minutes with no NNNN it is closed (process_timeout)");
  for (const c of "ZCZC A01\r\n") asm.push(c, 700);
  ok(!asm.inMessage, "a header with a digit missing is not a header (detect_header is strict)");
}

// ---------------------------------------------------------------------------
console.log("stations");
// ---------------------------------------------------------------------------
{
  eq(NAVTEX_STATIONS.length, 204, "fldigi's list: 204 stations");
  ok(NAVTEX_STATIONS.every((s) => [490, 518, 4209.5].includes(s.kHz)), "every one on 490, 518 or 4209.5 kHz");
  ok(NAVTEX_STATIONS.every((s) => /^[A-Z]$/.test(s.id) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180), "every one with a B1 letter and a position");
  const niton = navtexStations("E", 518).find((s) => s.name === "Niton");
  eq(niton && [niton.callsign, niton.lat, niton.lon], ["GNI", 50.583, -1.3], "E on 518: Niton, GNI, 50 35 N 01 18 W");
  eq(navtexStation("H", { kHz: 518, lat: 42.36, lon: -71.06 })?.name, "Boston,  MA", "H on 518 heard near Boston: Boston, not Savannah");
  eq(navtexStation("H", { kHz: 518, lat: 32.0, lon: -81.0 })?.name, "Savannah,  GA", "H on 518 heard near Savannah: Savannah");
  eq(navtexStation("N", { kHz: 518, lat: 41.9, lon: -88.0 })?.callsign, "NMN", "N on 518 heard in Illinois: Portsmouth VA, NMN");
  eq(navtexStation("H", { kHz: 518 }), null, "two candidates and no position: no guess");
  eq(navtexStation("H", { kHz: 518, text: "SAVANNAH NAVTEX" })?.name, "Savannah,  GA", "unless the message names one");
}

// ---------------------------------------------------------------------------
console.log("receiver: exact decode at 12, 24 and 48 kHz");
// ---------------------------------------------------------------------------
const clean12 = signal(MSG, { sampleRate: 12_000, station: "E", type: "A", serial: 42 });
const expect = printed(MSG, { station: "E", type: "A", serial: 42 });
for (const fs of [12_000, 24_000, 48_000]) {
  const x = fs === 12_000 ? clean12 : signal(MSG, { sampleRate: fs, station: "E", type: "A", serial: 42 });
  const t0 = Date.now();
  const { text, d } = decode(x, { sampleRate: fs, centreHz: 1000 });
  const ms = Date.now() - t0;
  eq(text, expect, `${fs} Hz: the whole message, exactly`);
  const msgs = d.takeMessages();
  eq(msgs.map((m) => [m.station, m.type, m.serial, m.subject, m.text, m.lostHeader, m.lostTrailer]), [["E", "A", "42", "Navigational warning", MSG, false, false]], `${fs} Hz: one message, header parsed`);
  ok(ms < (x.length / fs) * 1000 * 0.25, `${fs} Hz: decodes at under a quarter of real time (${ms} ms for ${(x.length / fs).toFixed(0)} s)`);
  const upToEnd = new NavtexDemodulator({ sampleRate: fs });
  upToEnd.feed(x.subarray(0, x.length - Math.round(0.6 * fs)));
  eq(upToEnd.statistics.errors, 0, `${fs} Hz: no character needed working out while the signal lasted`);
}

// ---------------------------------------------------------------------------
console.log("receiver: chunk sizes");
// ---------------------------------------------------------------------------
{
  const whole = decode(clean12, { sampleRate: 12_000 }, clean12.length).text;
  eq(whole, expect, "one call with the whole signal");
  eq(decode(clean12, { sampleRate: 12_000 }, 97).text, whole, "97-sample chunks: the same");
  eq(decode(clean12, { sampleRate: 12_000 }, 1).text, whole, "one sample at a time: the same");
}

// ---------------------------------------------------------------------------
console.log("receiver: phasing sync");
// ---------------------------------------------------------------------------
{
  const fs = 12_000;
  const x = signal(MSG, { sampleRate: fs, phasingSeconds: 10, lead: 0, station: "E", type: "A", serial: 42 });
  const d = new NavtexDemodulator({ sampleRate: fs });
  let lockedAt = -1;
  let during = "";
  for (let i = 0; i < 9 * fs; i += 120) {
    during += d.feed(x.subarray(i, i + 120));
    if (lockedAt < 0 && d.statistics.open) lockedAt = (i + 120) / fs;
  }
  ok(lockedAt > 0 && lockedAt < 2, `locked on phasing within 2 s (at ${lockedAt.toFixed(2)} s)`);
  eq(during, "", "phasing prints nothing");
  ok(d.statistics.quality > 0.9, `quality on clean phasing near 1 (${d.statistics.quality.toFixed(2)})`);
  eq(d.feed(x.subarray(9 * fs)), expect, "and the message after it decodes from the first character");
  // Joining part way through: no phasing, the signal picked up in the middle of the text.
  const long = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. ".repeat(4);
  const y = navtexWaveform(long, { sampleRate: fs, phasingSeconds: 10 });
  const cut = y.subarray(Math.round(14 * fs));
  const mid = decode(cut, { sampleRate: fs }).text;
  ok(mid.length > 60 && long.includes(mid.slice(0, 40)), `joined mid-message: locks on the text itself (${JSON.stringify(mid.slice(0, 40))}...)`);
}

// ---------------------------------------------------------------------------
console.log("receiver: FEC recovers one damaged copy of every character");
// ---------------------------------------------------------------------------
{
  const fs = 12_000;
  const cases: [string, NavtexWaveformOptions["corrupt"]][] = [
    ["every RX copy damaged", (_i, c) => c === "rx"],
    ["every DX copy damaged", (_i, c) => c === "dx"],
    ["alternate copies damaged", (i, c) => (i % 2 === 0 ? c === "rx" : c === "dx")],
  ];
  for (const [what, corrupt] of cases) {
    const x = signal(MSG, { sampleRate: fs, station: "E", type: "A", serial: 42, corrupt });
    const { text, d } = decode(x, { sampleRate: fs });
    eq(text, expect, `${what}: the message exactly`);
    eq(d.takeMessages().map((m) => m.text), [MSG], `${what}: and the message is framed`);
  }
  const both = signal(MSG, { sampleRate: fs, corrupt: (i) => i === 20 });
  const t = decode(both, { sampleRate: fs }).text;
  const e2 = printed(MSG);
  ok(levenshtein(t, e2) <= 1, `both copies of one character damaged: at most that one character wrong (${levenshtein(t, e2)})`);
}

// ---------------------------------------------------------------------------
console.log("receiver: off frequency, inverted");
// ---------------------------------------------------------------------------
{
  const fs = 12_000;
  for (const off of [7, -12, 30, -45]) {
    const x = signal(MSG, { sampleRate: fs, centreHz: 1000 + off, station: "E", type: "A", serial: 42 });
    const d = new NavtexDemodulator({ sampleRate: fs, centreHz: 1000 });
    const text = d.feed(x.subarray(0, x.length - fs));
    eq(text, expect, `${off > 0 ? "+" : ""}${off} Hz off: exact`);
    ok(Math.abs(d.statistics.afcHz - off) < 2, `${off > 0 ? "+" : ""}${off} Hz off: the AFC reads ${d.statistics.afcHz.toFixed(1)} Hz`);
  }
  // A transmitter whose clock is 500 ppm out: made at 12006 Hz, read as 12000, so 99.95
  // baud, a bit lost every 20 s against a free-running clock.
  const slow = signal(MSG, { sampleRate: 12_006, station: "E", type: "A", serial: 42 });
  eq(decode(slow, { sampleRate: fs }).text, expect, "transmitter clock 500 ppm slow: exact (the bit clock follows)");
  const x = signal(MSG, { sampleRate: fs, reverse: true, station: "E", type: "A", serial: 42 });
  const r = decode(x, { sampleRate: fs });
  eq(r.text, expect, "tones swapped (LSB): decodes anyway");
  eq(r.d.statistics.reversed, true, "and says it found them swapped");
  eq(decode(x, { sampleRate: fs, polarity: "normal" }).text, "", "with the polarity pinned to normal, a swapped signal prints nothing");
  const sb = decode(signal("SITOR B TEXT 123", { sampleRate: fs, sitorB: true }), { sampleRate: fs, sub: "SITOR-B" });
  eq(sb.text, "SITOR B TEXT 123", "SITOR-B: plain text with no header");
  eq(sb.d.takeMessages(), [], "SITOR-B: no message framing");
}

// ---------------------------------------------------------------------------
console.log("receiver: noise");
// ---------------------------------------------------------------------------
{
  const fs = 12_000;
  // S/N in 2500 Hz. 100-baud FSK has Eb/N0 14 dB above that figure, so -5 dB is Eb/N0 9 dB,
  // a raw bit error rate near 1 % (measured: 0.2 % at -3, 2.4 % at -6, 10 % at -9 - the
  // non-coherent FSK curve), which the FEC copies clean.
  for (const seed of [1, 2, 3]) {
    const x = signal(MSG, { sampleRate: fs, snrDb: -5, seed, station: "E", type: "A", serial: 42 });
    const { text, d } = decode(x, { sampleRate: fs });
    eq(text, expect, `-5 dB S/N in 2500 Hz, seed ${seed}: exact`);
    eq(d.takeMessages().length, 1, `-5 dB, seed ${seed}: framed`);
  }
  let dist = 0;
  let total = 0;
  for (const seed of [4, 5, 6]) {
    const x = signal(MSG, { sampleRate: fs, snrDb: -7, seed, station: "E", type: "A", serial: 42 });
    const t = decode(x, { sampleRate: fs }).text;
    dist += levenshtein(t, expect);
    total += expect.length;
  }
  ok(dist / total < 0.03, `-7 dB (raw bit errors ~4 %): under 3 % of characters wrong (${dist} in ${total})`);
  let junk = 0;
  for (const seed of [7, 8]) junk += decode(signal(MSG, { sampleRate: fs, snrDb: -12, seed }), { sampleRate: fs }).text.length;
  ok(junk < 20, `-12 dB, below copy: next to nothing printed (${junk} characters in two messages)`);

  const n = 60 * fs;
  for (const [what, level, seed] of [["60 s of band noise", 0.1, 11], ["60 s of loud noise", 0.7, 12], ["60 s of faint noise", 0.001, 13]] as const) {
    const g = gaussian(seed);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = level * g();
    const { text, d } = decode(x, { sampleRate: fs });
    ok(text.length <= 2, `${what}: ${text.length} characters printed`, JSON.stringify(text));
    eq(d.takeMessages().length, 0, `${what}: no messages`);
  }
  // Impulse noise: clicks on a quiet band.
  {
    const g = gaussian(14);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.01 * g() + (i % 2711 === 0 ? 0.9 : 0);
    const text = decode(x, { sampleRate: fs }).text;
    ok(text.length <= 2, `60 s of clicks: ${text.length} characters printed`);
  }
}

// ---------------------------------------------------------------------------
console.log("receiver: silence, reset");
// ---------------------------------------------------------------------------
{
  const fs = 48_000;
  const zeros = new Float32Array(4 * fs);
  const { text, d } = decode(zeros, { sampleRate: fs });
  eq(text, "", "4 s of exact digital silence prints nothing");
  eq([d.statistics.open, d.statistics.chars, d.statistics.level], [false, 0, 0], "and opens nothing, at level 0");
  // A message followed by DAX silence: nothing after NNNN.
  const sig = navtexWaveform(MSG, { sampleRate: 12_000, station: "E", type: "A", serial: 42, tailSeconds: 0 });
  const x = new Float32Array(sig.length + 4 * 12_000);
  x.set(sig);
  eq(decode(x, { sampleRate: 12_000 }).text, expect, "a message cut straight to digital silence: the message and nothing after");

  const r = new NavtexDemodulator({ sampleRate: 12_000, centreHz: 1000 });
  r.feed(signal(MSG, { sampleRate: 12_000, centreHz: 1020, reverse: true }).subarray(0, 12 * 12_000));
  ok(r.statistics.open && r.statistics.reversed && r.statistics.afcHz !== 0, "mid-message: locked, reversed, AFC moved");
  r.reset();
  eq(
    { ...r.statistics },
    { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0, reversed: false, messages: 0 },
    "reset() clears every statistic, the polarity and the AFC",
  );
  eq(r.takeMessages(), [], "and the message queue");
  eq(r.feed(clean12), decode(clean12, { sampleRate: 12_000 }).text, "and decodes afterwards exactly as a new receiver does");
  r.retune(1100);
  eq(r.statistics.afcHz, 0, "retune() starts the AFC over");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all NAVTEX assertions passed");

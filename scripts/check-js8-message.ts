/* eslint-disable no-console */
// JS8 message-layer checks: the 72-bit layouts round-trip, callsigns and grids pack as the
// reference packs them, the directed command table is the protocol's, heartbeats and
// directed frames print as JS8Call prints them, Huffman and dictionary text survive a frame,
// a typed line becomes the right frames with first and last flagged, and a receiver joins
// them back into a message.
// Run: npm run check:js8-message

import {
  JS8_BASECALLS,
  JS8_COMMANDS,
  JS8_HUFFMAN,
  JS8_TX_FIRST,
  JS8_TX_LAST,
  Js8MessageAssembler,
  js8BuildFrames,
  js8CommandNumber,
  js8CommandString,
  js8DegToGrid,
  js8FormatSnr,
  js8FrameBits,
  js8GridToDeg,
  js8HuffmanDecode,
  js8HuffmanEncode,
  js8Pack72,
  js8PackAlphanumeric50,
  js8PackCallsign,
  js8PackDirected,
  js8PackGrid,
  js8PackHeartbeat,
  js8PackHuffmanFrame,
  js8PackNum,
  js8ParseFrame,
  js8StationOf,
  js8Unpack72,
  js8UnpackAlphanumeric50,
  js8UnpackCallsign,
  js8UnpackCompoundFrame,
  js8UnpackDataFrame,
  js8UnpackDirected,
  js8UnpackGrid,
} from "@/lib/digital/js8-message";
import { js8JscAvailable, js8JscCodeword, js8JscCompress, js8JscDecompress, js8JscFrameBits, js8JscWord, js8PackDataFrame } from "@/lib/digital/js8-jsc";
import { js8EncodeFrame, js8UnpackFrame } from "@/lib/digital/js8";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
const J = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() + "n" : v));
function eq(a: unknown, b: unknown, what: string): void {
  ok(J(a) === J(b), what, `expected ${J(b)}, got ${J(a)}`);
}

// ---------------------------------------------------------------------------
console.log("72 bits as twelve characters");
// ---------------------------------------------------------------------------
{
  const f = js8Pack72(0n, 0);
  eq(f, "000000000000", "zero is twelve zeros");
  const v = 0x123456789abcdef0n;
  const f2 = js8Pack72(v, 0xa5);
  eq(f2.length, 12, "twelve characters");
  eq(js8Unpack72(f2), { value: v, rem: 0xa5 }, "and back: the 64-bit value and the 8-bit remainder");
  const all = js8Pack72((1n << 64n) - 1n, 255);
  eq(all, "++++++++++++", "all ones is twelve of the alphabet's 64th character");
  const bits = js8FrameBits(f2)!;
  eq(bits.length, 72, "72 bits");
  eq(Array.from(bits.subarray(64)), [1, 0, 1, 0, 0, 1, 0, 1], "the remainder is the last eight, most significant first");
  eq(js8Unpack72("/?.0000000000"), null, "a character outside the 64 is refused");
}

// ---------------------------------------------------------------------------
console.log("\ncallsigns");
// ---------------------------------------------------------------------------
{
  for (const call of ["K9XYZ", "KN4CRD", "K1ABC", "VK9XY", "2E0ABC", "W1AW", "3DA0ABC", "3XY1AB"]) {
    const p = js8PackCallsign(call);
    ok(p.packed > 0 && p.packed < 1 << 28, `${call} packs into 28 bits`, p.packed);
    eq(js8UnpackCallsign(p.packed, p.portable), call, `and unpacks`);
  }
  const port = js8PackCallsign("KN4CRD/P");
  ok(port.portable, "/P sets the portable flag");
  eq(js8UnpackCallsign(port.packed, true), "KN4CRD/P", "and comes back with it");
  eq(js8PackCallsign("KN4CRD/MM").packed, 0, "a suffix that is not /P does not pack as a standard call");
  eq(js8PackCallsign("@ALLCALL").packed, JS8_BASECALLS.find(([s]) => s === "@ALLCALL")![1], "@ALLCALL is a reserved value past the standard forms");
  eq(js8UnpackCallsign(js8PackCallsign("@HB").packed, false), "@HB", "and reads back by name");
  eq(js8UnpackCallsign(js8PackCallsign("<....>").packed, false), "<....>", "so does the incomplete-call placeholder");
  // The reference's arithmetic, by hand: " K9XYZ" is space, W, 9, M, D, M.
  const idx = (c: string) => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@".indexOf(c);
  let expect = idx(" ");
  expect = 36 * expect + idx("W");
  expect = 10 * expect + idx("9");
  expect = 27 * expect + idx("M") - 10;
  expect = 27 * expect + idx("D") - 10;
  expect = 27 * expect + idx("M") - 10;
  eq(js8PackCallsign("K9XYZ").packed, expect, "K9XYZ is the 37·36·10·27·27·27 mixed-radix number the reference computes");

  for (const c of ["KN4CRD/P", "VK2ABC/QRP", "K9XYZ", "@ALLCALL", "DL/K9XYZ", "@GROUP/0"]) {
    eq(js8UnpackAlphanumeric50(js8PackAlphanumeric50(c)), c, `${c} survives the 50-bit alphanumeric form`);
  }
  ok(js8PackAlphanumeric50("KN4CRD/P") < 1n << 50n, "and it fits in 50 bits");
}

// ---------------------------------------------------------------------------
console.log("\ngrids");
// ---------------------------------------------------------------------------
{
  for (const g of ["EN61", "FN42", "JO01", "QF22", "AA00", "RR99", "EM73"]) {
    const p = js8PackGrid(g);
    ok(p < 180 * 180, `${g} packs below 32400`, p);
    eq(js8UnpackGrid(p), g, `and unpacks`);
  }
  eq(js8PackGrid(""), 32767, "no grid is 32767");
  eq(js8UnpackGrid(32767), "", "and reads as none");
  const d = js8GridToDeg("EN61");
  ok(Math.abs(d.lon - 87) < 1.5 && Math.abs(d.lat - 41.5) < 1, "EN61 is near 87 W 41.5 N in the reference's convention (longitude positive west)", d);
  eq(js8DegToGrid(87.4, 41.4).slice(0, 4), "EN61", "and back");
}

// ---------------------------------------------------------------------------
console.log("\nnumbers, commands, SNR");
// ---------------------------------------------------------------------------
{
  eq(js8PackNum(null), 0, "no number is 0");
  eq(js8PackNum("-12"), 19, "-12 is 19 (value + 31)");
  eq(js8PackNum("+5"), 36, "+5 is 36");
  eq(js8PackNum("40"), 62, "clamped at 31");
  eq(js8PackNum("-40"), 1, "and -30");
  eq(js8CommandNumber(" SNR?"), 0, "SNR? is 0");
  eq(js8CommandNumber("?"), 0, "and so is ? for compatibility");
  eq(js8CommandString(0), " SNR?", "the first entry with a number is what prints");
  eq(js8CommandNumber(" 73"), 28, "73 is 28");
  eq(js8CommandNumber(" ACK"), 14, "ACK is 14");
  eq(js8CommandNumber(" "), 31, "a bare space is free text, 31");
  eq(JS8_COMMANDS.filter(([, n]) => n >= 0).length, 35, "35 command strings with numbers");
  eq(js8FormatSnr(-12), "-12", "SNR formatting");
  eq(js8FormatSnr(5), "+05", "with a sign and two digits");
  eq(js8FormatSnr(0), "+00", "zero is +00");
}

// ---------------------------------------------------------------------------
console.log("\nheartbeats and CQs");
// ---------------------------------------------------------------------------
{
  const hb = js8PackHeartbeat("KN4CRD", "HB", "EM73")!;
  eq(hb.length, 12, "a heartbeat is one frame");
  const c = js8UnpackCompoundFrame(hb)!;
  eq(c.type, 0, "type 0");
  eq(c.callsign, "KN4CRD", "with the callsign");
  eq(js8UnpackGrid(c.num & 32767), "EM73", "and the grid");
  eq(c.bits3, 0, "HB plain");
  const parsed = js8ParseFrame(hb, JS8_TX_FIRST | JS8_TX_LAST);
  eq(parsed.kind, "heartbeat", "parses as a heartbeat");
  eq(parsed.display, "KN4CRD: @HB HEARTBEAT EM73", "and prints as JS8Call prints it");
  ok(parsed.first && parsed.last, "first and last");

  const cq = js8PackHeartbeat("K9XYZ", "CQ CQ CQ", "EN61")!;
  const pc = js8ParseFrame(cq, 3);
  eq(pc.display, "K9XYZ: @ALLCALL CQ CQ CQ EN61", "a CQ is a heartbeat with the alt bit");
  ok(pc.isCq === true, "and is marked as one");
  const dx = js8ParseFrame(js8PackHeartbeat("K9XYZ", "CQ DX")!, 3);
  eq(dx.display, "K9XYZ: @ALLCALL CQ DX", "CQ DX, with no grid");
  const compound = js8ParseFrame(js8PackHeartbeat("KN4CRD/P", "HB", "EM73")!, 3);
  eq(compound.display, "KN4CRD/P: @HB HEARTBEAT EM73", "a compound callsign fits the 50-bit form");
}

// ---------------------------------------------------------------------------
console.log("\ndirected frames");
// ---------------------------------------------------------------------------
{
  const f = js8PackDirected("KN4CRD", "J1Y", 25, -12)!;
  const d = js8UnpackDirected(f)!;
  eq(d.from, "KN4CRD", "from");
  eq(d.to, "J1Y", "to");
  eq(d.cmdString, " SNR", "the command");
  eq(d.num, -12, "and its number");
  const p = js8ParseFrame(f, 3);
  eq(p.kind, "directed", "parses as directed");
  eq(p.display, "KN4CRD: J1Y SNR -12", "and prints as JS8Call prints it");
  const q = js8ParseFrame(js8PackDirected("K9XYZ", "KN4CRD", 0, null)!, 3);
  eq(q.display, "K9XYZ: KN4CRD SNR?", "a query with no number");
  const portable = js8UnpackDirected(js8PackDirected("K9XYZ/P", "KN4CRD", 28, null)!)!;
  eq(portable.from, "K9XYZ/P", "a portable sender keeps its /P through the flag bit");
  const group = js8ParseFrame(js8PackDirected("K9XYZ", "@ALLCALL", 11, null)!, 3);
  eq(group.display, "K9XYZ: @ALLCALL QUERY", "a group as the destination");
  eq(js8PackDirected("K9XYZ", "KN4CRD/MM", 28, null), null, "a destination that does not pack standard is refused (the sender uses compound frames for it)");
}

// ---------------------------------------------------------------------------
console.log("\nHuffman text");
// ---------------------------------------------------------------------------
{
  eq(JS8_HUFFMAN.length, 44, "44 codes");
  const codes = JS8_HUFFMAN.map(([, c]) => c);
  let prefixFree = true;
  for (const a of codes) for (const b of codes) if (a !== b && b.startsWith(a)) prefixFree = false;
  ok(prefixFree, "the code is prefix-free");
  const enc = js8HuffmanEncode("HELLO WORLD");
  eq(enc.reduce((n, p) => n + p.chars, 0), 11, "every character of HELLO WORLD is coded");
  eq(js8HuffmanDecode(enc.flatMap((p) => p.bits)), "HELLO WORLD", "and decodes back");
  const { frame, chars } = js8PackHuffmanFrame("HELLO WORLD THIS IS A TEST OF THE FRAME");
  ok(chars >= 10 && chars < 20, "a frame carries ten to twenty Huffman characters", chars);
  const u = js8UnpackDataFrame(frame)!;
  eq(u.kind, "huffman", "unpacks as Huffman text");
  eq(u.kind === "huffman" ? u.text : "", "HELLO WORLD THIS IS A TEST OF THE FRAME".slice(0, chars), "with the characters it took");
  eq(js8ParseFrame(frame, 1).kind, "data", "and parses as data");
  // Through the physical layer: the frame's twelve characters are a JS8 payload.
  const { info } = js8EncodeFrame(frame, 3);
  eq(js8UnpackFrame(info).text, frame, "the twelve characters survive the physical frame");
}

// ---------------------------------------------------------------------------
console.log("\nthe dictionary");
// ---------------------------------------------------------------------------
{
  ok(js8JscAvailable(), "the word table is present");
  eq(js8JscWord(0), "E", "index 0 is E, the commonest letter");
  eq(js8JscWord(67), " ", "index 67 is a space");
  eq(js8JscCodeword(0, false), [0, 0, 0, 0, 0], "index 0 is one group of 4 bits and a 0 (no space)");
  eq(js8JscCodeword(3, true), [0, 0, 1, 1, 1], "index 3 with a space following: (3 << 1) + 1 = 7, in five bits");
  eq(js8JscCodeword(7, false), [0, 1, 1, 1, 0, 0, 0, 0, 0], "index 7 needs a leading group: (0 + 7) then 0");
  for (const text of ["HELLO WORLD", "CQ CQ CQ DE K9XYZ EN61", "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG", "73 AND GOOD DX", "QSL VIA LOTW TNX"]) {
    const codes = js8JscCompress(text);
    const bits = codes.flatMap((c) => c.bits);
    eq(js8JscDecompress(bits), text, `${JSON.stringify(text)} compresses and decompresses`);
    eq(codes.reduce((n, c) => n + c.chars, 0), text.length, "and every character was accounted for");
  }
  const { bits, chars } = js8JscFrameBits("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG");
  eq(bits.length, 72, "a dictionary frame is 72 bits");
  ok(chars > 15, "and carries more characters than Huffman would", chars);
  const chosen = js8PackDataFrame("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG");
  const parsed = js8ParseFrame(chosen.frame, 1, js8JscDecompress);
  eq(parsed.kind, "data", "the chosen data frame parses as data");
  eq(parsed.text, "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG".slice(0, chosen.chars), "and decodes with the dictionary to the characters it took");
  const without = js8ParseFrame(chosen.frame, 1);
  eq(without.text, null, "without the dictionary a JSC frame reads as null");
}

// ---------------------------------------------------------------------------
console.log("\nbuilding and joining messages");
// ---------------------------------------------------------------------------
{
  const cq = js8BuildFrames("K9XYZ", "EN61", "CQ CQ CQ EN61");
  eq(cq.length, 1, "a CQ is one frame");
  eq(cq[0]?.txType, JS8_TX_FIRST | JS8_TX_LAST, "flagged first and last");
  eq(js8ParseFrame(cq[0]!.frame, cq[0]!.txType).display, "K9XYZ: @ALLCALL CQ CQ CQ EN61", "and reads back");

  const hb = js8BuildFrames("K9XYZ", "EN61", "HB");
  eq(js8ParseFrame(hb[0]!.frame, hb[0]!.txType).display, "K9XYZ: @HB HEARTBEAT EN61", "a heartbeat takes the station's grid");

  const snr = js8BuildFrames("K9XYZ", "EN61", "KN4CRD SNR -07");
  eq(snr.length, 1, "a directed report is one frame");
  eq(js8ParseFrame(snr[0]!.frame, snr[0]!.txType).display, "K9XYZ: KN4CRD SNR -07", "with its number");

  const chat = js8BuildFrames("K9XYZ", "EN61", "KN4CRD HELLO FROM INDIANA HOW COPY");
  ok(chat.length >= 2, "free text to a station is a directed frame and then data frames", chat.length);
  eq(chat[0]?.txType, JS8_TX_FIRST, "first frame flagged first");
  eq(chat[chat.length - 1]?.txType, JS8_TX_LAST, "last frame flagged last");
  const asm = new Js8MessageAssembler();
  let done: { text: string } | null = null;
  chat.forEach((f, i) => {
    const r = asm.push(js8ParseFrame(f.frame, f.txType), 1500 + (i % 2), 1000 * i);
    if (r) done = r;
  });
  ok(done !== null, "the assembler returns the message on its last frame");
  eq((done as { text: string } | null)?.text, "K9XYZ: KN4CRD HELLO FROM INDIANA HOW COPY", "joined as the receiver prints it");

  const long = js8BuildFrames("K9XYZ", "EN61", "THIS IS A LONGER LINE OF TEXT THAT WILL NOT FIT IN ONE FRAME AT ALL");
  ok(long.length >= 3, "a long line takes several data frames", long.length);
  const asm2 = new Js8MessageAssembler();
  let text = "";
  for (const f of long) {
    const r = asm2.push(js8ParseFrame(f.frame, f.txType), 2000, 0);
    if (r) text = r.text;
  }
  eq(text, "THIS IS A LONGER LINE OF TEXT THAT WILL NOT FIT IN ONE FRAME AT ALL", "and joins back to the line");
}

console.log("\nthe station a frame is from");
{
  eq(js8StationOf({ from: "N0GES" }), "N0GES", "a directed frame's sender is the station, not the one it answers");
  eq(js8StationOf({ from: "N6GRG" }), "N6GRG", "a heartbeat's sender, as heard on 40 m");
  eq(js8StationOf({ from: "@ALLCALL" }), null, "a group is not a station");
  eq(js8StationOf({ from: undefined }), null, "a data frame names nobody");
  eq(js8StationOf({ from: "  " }), null, "nor does a blank");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all JS8 message assertions passed");

/* eslint-disable no-console */
// The DX cluster: reading spot lines, the telnet layer, dedupe, mode guesses, "needed", the
// band map's layout — and the client itself, against a REAL TCP server started here.
//
// The fake node is a socket, not a mock, for the reason check-n3fjp gives: the faults worth
// catching are properties of the bytes. Whether the telnet negotiation is refused, whether
// the prompt is seen without a newline after it, whether the login goes out with CR LF,
// whether a dropped link comes back. None of it has been run against a live node; see the
// registry comment on cluster.host.
//
// Callsigns are the fictional ones this repository uses elsewhere (K1ABC, DL1ABC, K2BBB …).

import fs from "node:fs";
import net from "node:net";

import { SpotBook } from "@/lib/cluster/book";
import { backoffDelay, ClusterClient, type ClusterClientStatus } from "@/lib/cluster/client";
import { SpotDeduper, spotKey } from "@/lib/cluster/dedupe";
import { inferSpotMode, modeCategory, modeFromComment } from "@/lib/cluster/mode";
import { cleanLine, parseSpotLine, spotTime } from "@/lib/cluster/parse";
import { normaliseLogin } from "@/lib/cluster/service";
import { neededFor, slotsFromRows } from "@/lib/cluster/slots";
import { TelnetLineDecoder } from "@/lib/cluster/telnet";
import type { ClusterSpot, SpotEntity } from "@/lib/cluster/types";
import {
  bandMapLayout,
  bandMapRange,
  bandsInUse,
  filterSpots,
  formatKhz,
  spotClock,
  tickStepHz,
  toPanadapterSpots,
  upsertSpot,
} from "@/lib/cluster/view";
import { SETTING_GROUPS, SETTINGS } from "@/lib/settings/registry";

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
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  ok(sa === sb, label, `got ${sa}, want ${sb}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parserChecks(): void {
  console.log("\nDX de lines, as the four node families send them");

  const human = parseSpotLine("DX de K2BBB:     14025.0  JA1ABC       up 2                           1234Z");
  eq(
    human && {
      spotter: human.spotter,
      freqHz: human.freqHz,
      dx: human.dx,
      comment: human.comment,
      minuteOfDay: human.minuteOfDay,
      grid: human.spotterGrid,
      skimmer: human.skimmer,
    },
    {
      spotter: "K2BBB",
      freqHz: 14_025_000,
      dx: "JA1ABC",
      comment: "up 2",
      minuteOfDay: 12 * 60 + 34,
      grid: null,
      skimmer: false,
    },
    "DX Spider human spot: spotter, kHz, call, comment, time",
  );

  const grid = parseSpotLine("DX de G4ABC:      7012.5  K1ABC        cq NA                          0712Z IO91");
  eq([grid?.freqHz, grid?.spotterGrid, grid?.comment], [7_012_500, "IO91", "cq NA"], "the spotter's locator after the time");

  const grid6 = parseSpotLine("DX de G4ABC:  3505.0  UA9ABC  cq  0750Z kp23xr");
  eq(grid6?.spotterGrid, "KP23xr", "a six-character locator, in its conventional case");

  const state = parseSpotLine("DX de K2BBB:     21025.0  ZL1ABC       599                            1820Z NJ");
  eq([state?.spotterGrid, state?.minuteOfDay], [null, 18 * 60 + 20], "a US state after the time is not a grid");

  const rbn = parseSpotLine("DX de DL1ABC-#:  14013.4  K0ABC          CW    23 dB  21 WPM  CQ      1925Z");
  eq(
    rbn && [rbn.spotter, rbn.spotterRaw, rbn.skimmer, rbn.skim?.mode, rbn.skim?.snrDb, rbn.skim?.speed, rbn.skim?.kind],
    ["DL1ABC", "DL1ABC-#", true, "CW", 23, 21, "CQ"],
    "RBN CW skimmer: SNR, WPM and CQ taken out of the comment",
  );

  const rbnSsid = parseSpotLine("DX de VK2ABC-2-#: 7023.1  ZL1ABC         CW    11 dB  18 WPM  CQ      0915Z");
  eq([rbnSsid?.spotter, rbnSsid?.freqHz], ["VK2ABC", 7_023_100], "skimmer with an SSID");

  const glued = parseSpotLine("DX de VK2ABC-12-#:14025.0  JA1ABC  CW 5 dB 30 WPM CQ 1234Z");
  eq([glued?.spotter, glued?.freqHz, glued?.dx], ["VK2ABC", 14_025_000, "JA1ABC"], "a long spotter run into the frequency");

  const rtty = parseSpotLine("DX de K1ABC-#:   14085.3  EA8ABC         RTTY  17 dB  45 BPS  CQ      1442Z");
  eq([rtty?.skim?.mode, rtty?.skim?.speedUnit], ["RTTY", "BPS"], "RBN RTTY skimmer");

  const ft8 = parseSpotLine("DX de K1ABC-#:   14074.0  PY2ABC         FT8   -12 dB  CQ             2019Z");
  eq([ft8?.skim?.mode, ft8?.skim?.snrDb], ["FT8", -12], "RBN FT8 spot with a negative SNR");

  const jtalert = parseSpotLine("DX de K2BBB:     14075.6  VK2ABC       FT8 -15dB from QF56 1234Hz      2103Z");
  eq([jtalert?.freqHz, jtalert?.comment], [14_075_600, "FT8 -15dB from QF56 1234Hz"], "an FT8 spot typed by a logging program");

  const bare = parseSpotLine("DX de K2BBB:     28495.0  LU1ABC                                      1609Z");
  eq([bare?.comment, bare?.minuteOfDay], ["", 16 * 60 + 9], "no comment at all");

  const noTime = parseSpotLine("DX de K2BBB: 14025.0 JA1ABC up 2");
  eq([noTime?.minuteOfDay, noTime?.comment], [null, "up 2"], "no time: the comment is all of it");

  const integer = parseSpotLine("DX de K2BBB:  3799  K1ABC  CQ 1609Z");
  eq(integer?.freqHz, 3_799_000, "a frequency with no decimal");

  const mhz = parseSpotLine("DX de K2BBB: 14.025 JA1ABC hand typed 1234Z");
  eq(mhz?.freqHz, 14_025_000, "a hand-typed MHz frequency, read as MHz only because kHz lands in no band");

  const lf = parseSpotLine("DX de G4ABC:  136.0  G3ABC  QRSS 1234Z");
  eq(lf?.freqHz, 136_000, "136.0 stays kHz — 2200 m is a band");

  const micro = parseSpotLine("DX de G4ABC:   10368100.0  G3ABC  JO01<TR>JO02 599  1234Z");
  eq(micro?.freqHz, 10_368_100_000, "microwave frequencies");

  const bell = parseSpotLine("DX de K2BBB:     14025.0  JA1ABC       up 2                           1234Z\x07\x07");
  eq([bell?.dx, bell?.minuteOfDay], ["JA1ABC", 754], "bell characters on the end are stripped");

  const portable = parseSpotLine("DX de K2BBB:     18100.0  F/K1ABC      FT8                            1234Z");
  eq(portable?.dx, "F/K1ABC", "a portable call");

  const lower = parseSpotLine("dx de k2bbb: 14025.0 ja1abc test 1234z");
  eq([lower?.spotter, lower?.dx, lower?.minuteOfDay], ["K2BBB", "JA1ABC", 754], "lower case, as some nodes relay it");

  const twoTimes = parseSpotLine("DX de K2BBB: 14025.0 JA1ABC QSX 1830Z later 1234Z");
  eq([twoTimes?.minuteOfDay, twoTimes?.comment], [754, "QSX 1830Z later"], "the LAST HHMMZ is the time");

  const prompt = parseSpotLine("K1ABC de GB7XYZ 19-Oct-2026 1234Z dxspider >DX de K2BBB: 14025.0 JA1ABC up 2 1234Z");
  eq(prompt?.dx, "JA1ABC", "a spot glued to an unterminated prompt");

  console.log("\nnot spots");
  for (const line of [
    "WWV de K2BBB <18>:   SFI=153, A=8, K=2, No Storms -> No Storms",
    "WCY de DK0WCY-1 <17> : K=2 expK=2 A=9 R=106 SFI=158 SA=eru GMF=qui Au=no",
    "To ALL de K1ABC: QRV 14.025 DX de nobody",
    "K1ABC de GB7XYZ 19-Oct-2026 1234Z dxspider >",
    "login: ",
    "Please enter your call: ",
    "",
    "   ",
    "DX de K2BBB: 14025.0 CQ test 1234Z",
    "DX de : 14025.0 JA1ABC 1234Z",
    "DX de K2BBB: abc JA1ABC 1234Z",
    "Hello K1ABC, this is GB7XYZ in Somewhere running DXSpider",
  ]) {
    ok(parseSpotLine(line) === null, `ignored: ${JSON.stringify(line.slice(0, 48))}`);
  }
  eq(cleanLine("\x07DX de\tK2BBB\x00 "), "DX de K2BBB", "cleanLine strips control characters and turns tabs to spaces");

  console.log("\nthe spot's HHMMZ as an instant");
  const rx = Date.UTC(2026, 9, 19, 12, 35, 10);
  eq(new Date(spotTime(12 * 60 + 34, rx)).toISOString(), "2026-10-19T12:34:00.000Z", "same day");
  const pastMidnight = Date.UTC(2026, 9, 20, 0, 1, 0);
  eq(new Date(spotTime(23 * 60 + 59, pastMidnight)).toISOString(), "2026-10-19T23:59:00.000Z", "2359Z received at 0001Z is yesterday");
  eq(spotTime(null, rx), rx, "no time: the moment it was received");
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

function modeChecks(): void {
  console.log("\nmode: comment first, then a watering hole, then the band plan");
  const m = (khz: number, comment = "", skim: string | null = null) => {
    const g = inferSpotMode(Math.round(khz * 1000), comment, skim);
    return [g.mode, g.category, g.source];
  };
  eq(m(14025.0), ["CW", "CW", "band-plan"], "14.025 with no comment: CW, marked as a guess");
  eq(m(14074.0), ["FT8", "DIGITAL", "frequency"], "14.074: FT8");
  eq(m(14075.6), ["FT8", "DIGITAL", "frequency"], "14.0756, a signal above the FT8 dial: FT8");
  eq(m(14080.5), ["FT4", "DIGITAL", "frequency"], "14.0805: FT4, not JS8 — the nearer dial below");
  eq(m(14078.9), ["JS8", "DIGITAL", "frequency"], "14.0789: JS8");
  eq(m(14070.6), ["PSK31", "DIGITAL", "frequency"], "14.0706: PSK31");
  eq(m(7035.5), ["CW", "CW", "band-plan"], "7.0355 is not Region 1's PSK31 dial here — region-specific holes are skipped");
  eq(m(7040.0), ["CW", "CW", "band-plan"], "7.040 is not WSPR");
  eq(m(14195.0), ["SSB", "PHONE", "band-plan"], "14.195: SSB");
  eq(m(7080.0, "SSB up 5"), ["SSB", "PHONE", "comment"], "the comment wins over the US data segment");
  eq(m(14195.0, "CW"), ["CW", "CW", "comment"], "and over the phone segment");
  eq(m(1822.0), ["CW", "CW", "band-plan"], "160 m below 1.843: CW by convention");
  eq(m(1910.0), ["SSB", "PHONE", "band-plan"], "160 m above: SSB");
  eq(m(14085.3, "RTTY 17 dB 45 BPS CQ", "RTTY"), ["RTTY", "DIGITAL", "comment"], "a skimmer's mode is stated");
  eq(m(5357.0), ["FT8", "DIGITAL", "frequency"], "60 m FT8");
  eq(m(5403.5), [null, null, null], "60 m otherwise: channels, no guess");
  eq(m(144174.0), ["FT8", "DIGITAL", "frequency"], "2 m FT8");
  eq(m(144300.0), [null, null, null], "2 m otherwise: not in the US HF plan, no guess");
  eq(m(28020.0, "cq FM18 tnx"), ["CW", "CW", "band-plan"], "a grid like FM18 is not FM");
  eq(modeFromComment("CW, SSB later"), "CW", "the first mode named wins");
  eq(modeFromComment("am QRV later"), null, "lower-case 'am' is a word, not AM");
  eq([modeCategory("FT4"), modeCategory("USB"), modeCategory("SSTV"), modeCategory("MFSK"), modeCategory("XYZ")], ["DIGITAL", "PHONE", "PHONE", "DIGITAL", null], "categories, including the log's ADIF spellings");
}

// ---------------------------------------------------------------------------
// Telnet layer
// ---------------------------------------------------------------------------

function telnetChecks(): void {
  console.log("\ntelnet negotiation is refused and stripped");
  const d = new TelnetLineDecoder();
  const r1 = d.push(Buffer.from([255, 253, 24, 255, 251, 1, ...Buffer.from("Hello\r\n")]));
  eq(r1.lines, ["Hello"], "IAC DO TTYPE + IAC WILL ECHO do not reach the text");
  eq([...(r1.reply ?? [])], [255, 252, 24, 255, 254, 1], "answered WONT TTYPE and DONT ECHO");
  const r2 = d.push(Buffer.from([255, 253, 24]));
  eq(r2.reply, null, "the same request again is not answered twice — no negotiation loop");
  const r3 = d.push(Buffer.from([255, 250, 24, 1, 255, 240, ...Buffer.from("after SB\n")]));
  eq(r3.lines, ["after SB"], "subnegotiation discarded whole");
  d.push(Buffer.from([65, 255]));
  const r4 = d.push(Buffer.from([253, 3, 66, 10]));
  eq([r4.lines, [...(r4.reply ?? [])]], [["AB"], [255, 252, 3]], "an IAC split across two reads");

  console.log("\nline framing");
  const f = new TelnetLineDecoder();
  eq(f.push(Buffer.from("one\r\ntwo\n\rthree\rfour\nfi")).lines, ["one", "two", "three", "four"], "CRLF, LFCR, CR and LF all end a line; no empty lines");
  eq(f.partial, "fi", "the unterminated rest is the partial");
  eq(f.push(Buffer.from("ve\r\0six\r\n")).lines, ["five", "six"], "CR NUL is a line end; the NUL is dropped");
  f.push(Buffer.from("login: "));
  eq(f.partial, "login: ", "a prompt with no newline is visible as the partial");
  f.discardPartial();
  eq(f.push(Buffer.from("\r\n")).lines, [], "and once answered it does not come back as a line");
  const euro = Buffer.from("Grüße\n", "utf8");
  f.push(euro.subarray(0, 3));
  eq(f.push(euro.subarray(3)).lines, ["Grüße"], "UTF-8 split across reads is decoded whole");
  const small = new TelnetLineDecoder(8);
  eq(small.push(Buffer.from("0123456789AB\n")).lines, ["01234567", "89AB"], "an over-long line is cut, not buffered without limit");
}

// ---------------------------------------------------------------------------
// Dedupe, the book, needed
// ---------------------------------------------------------------------------

async function bookChecks(): Promise<void> {
  console.log("\ndedupe: one call on one band, for ten minutes");
  const dd = new SpotDeduper(10 * 60_000, 3_500);
  const t0 = Date.UTC(2026, 9, 19, 12, 0);
  const k = spotKey("JA1ABC", "20M");
  ok(!dd.isDupe(k, 14_025_000, t0), "first sighting is new");
  ok(dd.isDupe(k, 14_025_300, t0 + 60_000), "a second spotter 300 Hz off is a repeat");
  ok(!dd.isDupe(spotKey("JA1ABC", "40M"), 7_025_000, t0 + 60_000), "the same call on another band is new");
  ok(!dd.isDupe(k, 14_030_000, t0 + 120_000), "a 5 kHz QSY on the same band is new");
  ok(!dd.isDupe(k, 14_030_000, t0 + 120_000 + 10 * 60_000), "after the window it is new again");

  console.log("\nthe spot book, with a fake cty table and a fake log");
  const entities: Record<string, SpotEntity> = {
    JA1ABC: { adif: 339, name: "Japan", prefix: "JA", continent: "AS", cqZone: 25 },
    K1ABC: { adif: 291, name: "United States", prefix: "K", continent: "NA", cqZone: 5 },
    VP8ABC: { adif: 240, name: "Falkland Is.", prefix: "VP8", continent: "SA", cqZone: 13 },
  };
  // Japan worked on 40 m CW only; the USA on 20 m in phone and digital.
  const slots = slotsFromRows(
    [
      { dxcc: 339, band: "40M" },
      { dxcc: 291, band: "20M" },
      { dxcc: null, band: "20M" },
    ],
    [
      { dxcc: 339, mode: "CW" },
      { dxcc: 291, mode: "SSB" },
      { dxcc: 291, mode: "FT8" },
    ],
  );
  let clock = Date.UTC(2026, 9, 19, 12, 35);
  const book = new SpotBook(
    { entityFor: async (c) => entities[c] ?? null, slots: async () => slots, now: () => clock },
    4,
  );
  const a = await book.ingest("DX de K2BBB:     14025.0  JA1ABC       up 2         1234Z");
  eq([a?.band, a?.mode, a?.entity?.name, a?.needed], ["20M", "CW", "Japan", { entity: false, band: true, mode: false }], "Japan on 20 m CW: new band, not new mode");
  const b = await book.ingest("DX de K2BBB:     14074.0  JA1ABC       FT8          1234Z");
  eq([b?.mode, b?.needed?.mode], ["FT8", true], "the same call 49 kHz up is a QSY — a new spot, and digital is a new mode for Japan");
  clock += 1000;
  const listed = book.list();
  eq(listed.length, 1, "it replaced the 14.025 entry: one entry per call and band");
  eq(listed[0]?.freqHz, 14_074_000, "and the entry is where the station is now");
  const c = await book.ingest("DX de DL1ABC-#:  14074.3  JA1ABC  FT8 -10 dB CQ  1235Z");
  eq(c, null, "a skimmer 300 Hz off within the window is a repeat");
  eq([book.list()[0]?.count, book.counts.dupes], [2, 1], "counted on the spot it repeats");
  const v = await book.ingest("DX de K2BBB:     14195.0  VP8ABC       SSB          1236Z");
  eq(v?.needed, { entity: true, band: true, mode: true }, "an entity never worked");
  const u = await book.ingest("DX de K2BBB:     14240.0  K1ABC        59           1236Z");
  eq(u?.needed, { entity: false, band: false, mode: false }, "worked on the band and the mode: nothing needed");
  const x = await book.ingest("DX de K2BBB:     14240.0  ZZ9ZZZ       59           1236Z");
  eq([x?.entity, x?.needed], [null, null], "no entity: needed is unknown, not false");
  const out = await book.ingest("DX de K2BBB:     6000.0  K1ABC  SWBC  1236Z");
  eq([out, book.counts.ignored], [null, 1], "outside every amateur band: dropped and counted");
  await book.ingest("DX de K2BBB: 7010.0 K1ABC cq 1237Z");
  await book.ingest("DX de K2BBB: 3510.0 K1ABC cq 1237Z");
  eq(book.list().length, 4, "the book keeps at most its cap");
  const failing = new SpotBook({
    entityFor: async () => {
      throw new Error("database away");
    },
    slots: async () => slots,
  });
  const f = await failing.ingest("DX de K2BBB: 14025.0 JA1ABC up 2 1234Z");
  eq([f?.dx, f?.entity], ["JA1ABC", null], "a lookup that throws still yields the spot");
  const skip = await failing.ingest("DX de K2BBB: 7025.0 JA1ABC up 2 1234Z", { enrich: false });
  eq(skip?.entity, null, "enrich:false skips the lookup");

  console.log("\nneeded, directly");
  eq(neededFor(slots, 339, "40m", "CW"), { entity: false, band: false, mode: false }, "band case does not matter");
  eq(neededFor(slots, 339, "40M", null), { entity: false, band: false, mode: false }, "an unknown mode claims no mode slot");
}

// ---------------------------------------------------------------------------
// The view helpers
// ---------------------------------------------------------------------------

function fakeSpot(over: Partial<ClusterSpot>): ClusterSpot {
  const now = Date.UTC(2026, 9, 19, 12, 0);
  return {
    id: "x",
    key: "K1ABC|20M",
    dx: "K1ABC",
    freqHz: 14_025_000,
    band: "20M",
    spotter: "K2BBB",
    skimmer: false,
    comment: "",
    at: now,
    receivedAt: now,
    lastSeenAt: now,
    count: 1,
    spotterGrid: null,
    snrDb: null,
    wpm: null,
    mode: "CW",
    modeCategory: "CW",
    modeSource: "comment",
    entity: null,
    needed: null,
    ...over,
  };
}

function viewChecks(): void {
  console.log("\nfilters");
  const now = Date.UTC(2026, 9, 19, 12, 30);
  const spots = [
    fakeSpot({ id: "a", key: "A|20M", lastSeenAt: now - 5 * 60_000 }),
    fakeSpot({ id: "b", key: "B|40M", band: "40M", freqHz: 7_074_000, mode: "FT8", modeCategory: "DIGITAL", lastSeenAt: now - 50 * 60_000 }),
    fakeSpot({ id: "c", key: "C|20M", needed: { entity: false, band: true, mode: false }, lastSeenAt: now - 60_000 }),
  ];
  const ids = (xs: ClusterSpot[]) => xs.map((s) => s.id);
  eq(ids(filterSpots(spots, { band: "ALL", category: "ALL", neededOnly: false, maxAgeMin: 30 }, now)), ["a", "c"], "max age is from the latest sighting");
  eq(ids(filterSpots(spots, { band: "40M", category: "ALL", neededOnly: false, maxAgeMin: 120 }, now)), ["b"], "by band");
  eq(ids(filterSpots(spots, { band: "ALL", category: "DIGITAL", neededOnly: false, maxAgeMin: 120 }, now)), ["b"], "by mode category");
  eq(ids(filterSpots(spots, { band: "ALL", category: "ALL", neededOnly: true, maxAgeMin: 120 }, now)), ["c"], "needed only");
  eq(bandsInUse(spots), [{ band: "40M", count: 1 }, { band: "20M", count: 2 }], "bands in band order with counts");
  eq(ids(upsertSpot(spots, fakeSpot({ id: "d", key: "A|20M" }))), ["d", "b", "c"], "a new spot replaces the one with its key");
  eq([spotClock(Date.UTC(2026, 9, 19, 9, 5)), formatKhz(14_025_300)], ["09:05Z", "14025.3"], "time to the minute, frequency in kHz");

  console.log("\nband map");
  eq(bandMapRange("20M", []), { lowHz: 14_000_000, highHz: 14_350_000, cropped: false }, "20 m is shown whole");
  const tenM = bandMapRange("10M", [{ freqHz: 28_074_000 }, { freqHz: 28_020_000 }]);
  ok(tenM.cropped && tenM.lowHz === 28_000_000 && tenM.highHz <= 28_150_000 && tenM.highHz >= 28_099_000, "10 m is cropped to the busy part", JSON.stringify(tenM));
  const crowd = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, freqHz: 14_020_000 + i * 100 }));
  const lay = bandMapLayout(crowd, 14_000_000, 14_350_000, 560, 24);
  ok(lay.height >= 40 * 24, "forty spots in 4 kHz stretch the map rather than drop labels", String(lay.height));
  eq(lay.placed.length, 40, "every spot is placed");
  let overlaps = 0;
  for (let i = 1; i < lay.placed.length; i++) {
    if (lay.placed[i]!.labelY < lay.placed[i - 1]!.labelY + 24 - 0.001) overlaps++;
  }
  eq(overlaps, 0, "no two labels overlap, and they stay in frequency order");
  ok(lay.placed.every((p) => p.labelY >= 0 && p.labelY + 24 <= lay.height + 0.001), "every label is inside the map");
  const sparse = bandMapLayout([{ id: "x", freqHz: 14_175_000 }], 14_000_000, 14_350_000, 560, 24);
  ok(Math.abs(sparse.placed[0]!.labelY + 12 - 280) < 0.001, "a lone label sits level with its frequency");
  eq(tickStepHz(350_000, 560), 25_000, "a ruler step that keeps ticks apart on 20 m");

  console.log("\nfor the panadapter");
  const p = toPanadapterSpots([fakeSpot({ id: "z", entity: { adif: 339, name: "Japan", prefix: "JA", continent: "AS", cqZone: 25 }, comment: "up 2" })]);
  eq([p[0]?.key, p[0]?.callsign, p[0]?.detail], ["dx:z", "K1ABC", "Japan · up 2 · de K2BBB 12:00Z"], "the Panadapter's spot shape, keys prefixed");
}

// ---------------------------------------------------------------------------
// The client, against a fake node
// ---------------------------------------------------------------------------

interface FakeNode {
  port: number;
  connections: number;
  received: string[];
  close: () => Promise<void>;
}

/** A node that runs `script` for each connection, with the connection index. */
function fakeNode(script: (sock: net.Socket, n: number, node: FakeNode) => void): Promise<FakeNode> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const node: FakeNode = { port: 0, connections: 0, received: [], close: async () => {} };
    const server = net.createServer((sock) => {
      sockets.add(sock);
      const n = node.connections++;
      node.received[n] = "";
      sock.on("data", (d) => {
        node.received[n] += d.toString("latin1");
      });
      sock.on("error", () => {});
      sock.on("close", () => sockets.delete(sock));
      script(sock, n, node);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      node.port = typeof addr === "object" && addr ? addr.port : 0;
      node.close = () =>
        new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        });
      resolve(node);
    });
  });
}

const FAST = {
  connectTimeoutMs: 1_000,
  loginTimeoutMs: 400,
  keepaliveMs: 150,
  idleTimeoutMs: 600,
  backoffBaseMs: 40,
  backoffMaxMs: 160,
  stableMs: 60_000,
  tickMs: 25,
};

async function clientChecks(): Promise<void> {
  console.log("\nbackoff");
  const t = { backoffBaseMs: 5_000, backoffMaxMs: 300_000 };
  eq([backoffDelay(0, t, () => 0), backoffDelay(0, t, () => 1)], [2_500, 5_000], "first retry 2.5-5 s");
  eq(backoffDelay(3, t, () => 1), 40_000, "doubles each attempt");
  eq([backoffDelay(30, t, () => 0), backoffDelay(30, t, () => 1)], [150_000, 300_000], "never above five minutes, never below half of it");

  console.log("\nlogin, spots, a dropped link, and back");
  const states: string[] = [];
  const lines: string[] = [];
  const node = await fakeNode((sock, n) => {
    if (n === 0) {
      // DX Spider style: negotiate, banner, prompt with no newline.
      sock.write(Buffer.from([255, 253, 24]));
      sock.write("Hello, this is a fake node\r\nlogin: ");
      sock.once("data", () => {
        sock.write("Hello K1ABC-2\r\n");
        sock.write("DX de K2BBB:     14025.0  JA1ABC       up 2                           1234Z\r\n");
        sock.write("WWV de K2BBB <18>:   SFI=153, A=8, K=2\r\n");
        sock.write("DX de DL1ABC-#:  7013.4  K0ABC  CW 23 dB 21 WPM CQ  1925Z\r\n");
        setTimeout(() => sock.destroy(), 50);
      });
    } else {
      // AR-Cluster style prompt on the reconnect.
      sock.write("Please enter your call: ");
      sock.once("data", () => sock.write("DX de K2BBB: 21025.0 ZL1ABC 599 1240Z\r\n"));
    }
  });
  const client = new ClusterClient({
    host: "127.0.0.1",
    port: node.port,
    login: "K1ABC-2",
    onLine: (l) => lines.push(l),
    onStatus: (s: ClusterClientStatus) => {
      if (states[states.length - 1] !== s.state) states.push(s.state);
    },
    timing: FAST,
    random: () => 0.5,
  });
  client.start();
  ok(await until(() => lines.some((l) => l.includes("ZL1ABC")), 3_000), "the spot after the reconnect arrived");
  eq(node.received[0]?.slice(0, 3), "\xff\xfc\x18", "the client refused TTYPE before anything else");
  ok(node.received[0]?.includes("K1ABC-2\r\n") ?? false, "logged in with the call and CR LF at the DX Spider prompt");
  ok(node.received[1]?.startsWith("K1ABC-2\r\n") ?? false, "and again at the AR-Cluster prompt");
  ok(lines.some((l) => l.includes("JA1ABC")) && lines.some((l) => l.includes("K0ABC")), "both spots of the first session were handed on");
  ok(!lines.some((l) => /login:/.test(l)), "the answered prompt never came through as a line");
  eq(states.slice(0, 7), ["connecting", "login", "connected", "waiting", "connecting", "login", "connected"], "status went through the reconnect");
  await client.stop();
  ok(node.received[1]?.endsWith("bye\r\n") ?? false, "stop() logs out with BYE");
  const after = node.connections;
  await sleep(400);
  eq([client.status.state, node.connections], ["stopped", after], "and nothing reconnects after it");
  await node.close();

  console.log("\nkeepalive, then the idle timeout");
  const quiet = await fakeNode((sock) => sock.write("login: "));
  const logged: string[] = [];
  const qc = new ClusterClient({
    host: "127.0.0.1",
    port: quiet.port,
    login: "K1ABC",
    onLine: () => {},
    log: (l) => logged.push(l),
    timing: FAST,
    random: () => 0.5,
  });
  qc.start();
  ok(await until(() => quiet.connections >= 2, 3_000), "a node that goes silent is dropped and dialled again");
  ok((quiet.received[0] ?? "").replace("K1ABC\r\n", "").includes("\r\n"), "an empty line went out as a keepalive first");
  ok(logged.some((l) => /Nothing from 127\.0\.0\.1/.test(l)), "and the reason was given", logged.join(" | "));
  await qc.stop();
  await quiet.close();

  console.log("\nprompts that end the session");
  const pw = await fakeNode((sock) => {
    sock.write("login: ");
    sock.once("data", () => sock.write("password: "));
  });
  const pc = new ClusterClient({ host: "127.0.0.1", port: pw.port, login: "K1ABC", onLine: () => {}, timing: FAST, random: () => 0.5 });
  pc.start();
  ok(await until(() => /password/.test(pc.status.lastError ?? ""), 2_000), "a password prompt is reported, not answered", pc.status.lastError ?? "");
  await pc.stop();
  await pw.close();

  const reject = await fakeNode((sock) => {
    sock.write("login: ");
    sock.once("data", () => sock.write("Sorry, K1ABC is not a valid callsign\r\nlogin: "));
  });
  const rc = new ClusterClient({ host: "127.0.0.1", port: reject.port, login: "K1ABC", onLine: () => {}, timing: FAST, random: () => 0.5 });
  rc.start();
  ok(await until(() => /did not accept/.test(rc.status.lastError ?? ""), 2_000), "asked to log in again: the node refused the call");
  ok(/not a valid callsign/.test(rc.status.lastError ?? ""), "and its words are kept", rc.status.lastError ?? "");
  await rc.stop();
  await reject.close();

  const mute = await fakeNode((sock) => sock.write("Welcome. Type your call.\r\n"));
  const mc = new ClusterClient({ host: "127.0.0.1", port: mute.port, login: "K1ABC", onLine: () => {}, timing: FAST, random: () => 0.5 });
  mc.start();
  ok(await until(() => (mute.received[0] ?? "").includes("K1ABC\r\n"), 2_000), "no recognisable prompt: the call goes out after the login timeout");
  await mc.stop();
  await mute.close();

  console.log("\nnothing listening");
  const gone = await fakeNode(() => {});
  const port = gone.port;
  await gone.close();
  const gc = new ClusterClient({ host: "127.0.0.1", port, login: "K1ABC", onLine: () => {}, timing: FAST, random: () => 0.5 });
  gc.start();
  ok(await until(() => gc.status.state === "waiting" && /refused/.test(gc.status.lastError ?? ""), 2_000), "connection refused: waiting to retry, with the reason", gc.status.lastError ?? "");
  ok(gc.status.nextRetryAt !== null, "and when it will try again");
  await gc.stop();
}

// ---------------------------------------------------------------------------
// Settings and the bridge hunk
// ---------------------------------------------------------------------------

function wiringChecks(): void {
  console.log("\nsettings");
  const get = (k: string) => SETTINGS.find((s) => s.key === k);
  eq([get("cluster.enabled")?.type, get("cluster.enabled")?.default], ["boolean", "false"], "cluster.enabled is off by default");
  ok(Boolean(get("cluster.host")?.default), "cluster.host has a default node");
  eq([get("cluster.port")?.type, get("cluster.port")?.default], ["number", "7300"], "cluster.port");
  eq(get("cluster.login")?.default, undefined, "cluster.login defaults to the station callsign, so has no default of its own");
  eq(SETTING_GROUPS[SETTING_GROUPS.length - 1]?.id, "cluster", "the cluster group is last");
  eq([normaliseLogin(" n0call-2 "), normaliseLogin("N0CALL"), normaliseLogin("CQ"), normaliseLogin(""), normaliseLogin("K1ABC-123")], ["N0CALL-2", "N0CALL", null, null, null], "login normalisation");

  console.log("\nthe bridge");
  const src = fs.readFileSync("services/radio/index.ts", "utf8");
  const at = src.indexOf('url.pathname === "/cluster/spots"');
  const handler = at >= 0 ? src.slice(at, at + 700) : "";
  ok(/x-bridge-token/.test(handler) && /401/.test(handler), "GET /cluster/spots checks X-Bridge-Token");
  ok(/broadcast\(\{ kind: "spot", spot \}\)/.test(src), 'each new spot goes out as { kind: "spot", spot }');
  ok(/cluster\.stop\(\)/.test(src), "shutdown logs out of the node");
}

async function main(): Promise<void> {
  parserChecks();
  modeChecks();
  telnetChecks();
  await bookChecks();
  viewChecks();
  await clientChecks();
  wiringChecks();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

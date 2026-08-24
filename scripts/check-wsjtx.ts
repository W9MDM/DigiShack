// WSJT-X / Omega UDP protocol assertions.
// Run: npm run check:wsjtx
//
// Builds real datagrams byte by byte and decodes them, rather than trusting the
// implementation to agree with itself. That matters here because there is no way
// to test against Omega in CI, and a silently wrong byte offset produces
// plausible-looking garbage — a decode at the wrong audio frequency, or a QSO
// logged with the operator's callsign in the comments field.

import { inferDigitalMode, periodMsFor } from "../lib/ham/digital-freqs";
import {
  WSJTX_MAGIC,
  WsjtxType,
  callsignFromMessage,
  dateToJulian,
  decodePacket,
  decodeTimeToDate,
  encodeClear,
  encodeFreeText,
  encodeHaltTx,
  encodeHighlightCallsign,
  encodeReplay,
  encodeReply,
  julianToDate,
} from "../lib/wsjtx/protocol";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

// --------------------------------------------------------------------------
// Byte-level packet builder, independent of the library's own Writer.
// --------------------------------------------------------------------------

class Pkt {
  private parts: Buffer[] = [];
  u8(v: number) { const b = Buffer.alloc(1); b.writeUInt8(v); this.parts.push(b); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.parts.push(b); return this; }
  i32(v: number) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.parts.push(b); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64BE(v); this.parts.push(b); return this; }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64BE(v); this.parts.push(b); return this; }
  f64(v: number) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.parts.push(b); return this; }
  str(v: string | null) {
    if (v === null) return this.u32(0xffffffff);
    const b = Buffer.from(v, "utf8");
    this.u32(b.length);
    this.parts.push(b);
    return this;
  }
  raw(b: Buffer) { this.parts.push(b); return this; }
  build() { return Buffer.concat(this.parts); }
}

const head = (type: WsjtxType, id = "WSJT-X") =>
  new Pkt().u32(WSJTX_MAGIC).u32(2).u32(type).str(id);

// --------------------------------------------------------------------------
console.log("\n1. rejecting things that aren't WSJT-X packets");

check("empty buffer", decodePacket(Buffer.alloc(0)).ok === false);
{
  const r = decodePacket(Buffer.alloc(4));
  check("4 bytes -> too-short", r.ok === false && r.reason === "too-short", r);
}
{
  const bad = new Pkt().u32(0xdeadbeef).u32(2).u32(0).str("x").build();
  const r = decodePacket(bad);
  check("wrong magic -> bad-magic", r.ok === false && r.reason === "bad-magic", r);
}
{
  // Valid header, then a Decode that stops mid-field.
  const trunc = head(WsjtxType.Decode).bool(true).u32(1000).build();
  const r = decodePacket(trunc);
  check("short payload -> truncated", r.ok === false && r.reason === "truncated", r);
}

// --------------------------------------------------------------------------
console.log("\n2. Heartbeat");
{
  const p = head(WsjtxType.Heartbeat, "OMEGA").u32(3).str("2.7.0").str("abc123").build();
  const r = decodePacket(p);
  check("decodes", r.ok === true);
  if (r.ok && r.message.type === WsjtxType.Heartbeat) {
    const m = r.message;
    check("id", m.id === "OMEGA", m.id);
    check("maxSchema", m.maxSchema === 3, m.maxSchema);
    check("version", m.version === "2.7.0", m.version);
    check("revision", m.revision === "abc123", m.revision);
  }
}
{
  // Pre-schema-2 senders stop after maxSchema.
  const p = head(WsjtxType.Heartbeat).u32(2).build();
  const r = decodePacket(p);
  check(
    "older heartbeat without version/revision still decodes",
    r.ok === true && r.message.type === WsjtxType.Heartbeat && r.message.version === null,
    r,
  );
}

// --------------------------------------------------------------------------
console.log("\n3. Decode — including Delta Frequency, which the old parser dropped");
{
  const p = head(WsjtxType.Decode)
    .bool(true)        // isNew
    .u32(52_245_000)   // time: 14:30:45 UTC
    .i32(-13)          // snr
    .f64(0.2)          // delta time
    .u32(1478)         // delta frequency  <-- DigitalDecode.freqOffset
    .str("FT8")
    .str("CQ W1AW FN42")
    .bool(false)       // low confidence
    .bool(false)       // off air
    .build();

  const r = decodePacket(p);
  check("decodes", r.ok === true, r);
  if (r.ok && r.message.type === WsjtxType.Decode) {
    const m = r.message;
    check("isNew", m.isNew === true);
    check("time (ms since midnight)", m.time === 52_245_000, m.time);
    check("negative snr", m.snr === -13, m.snr);
    check("delta time", Math.abs(m.deltaTime - 0.2) < 1e-9, m.deltaTime);
    check("DELTA FREQUENCY captured", m.deltaFrequency === 1478, m.deltaFrequency);
    check("mode", m.mode === "FT8", m.mode);
    check("message", m.message === "CQ W1AW FN42", m.message);
    check("lowConfidence", m.lowConfidence === false);
    check("offAir", m.offAir === false);
  }
}

// --------------------------------------------------------------------------
console.log("\n4. Status — full parse, not just the first three fields");
{
  const p = head(WsjtxType.Status)
    .u64(14_074_000n)  // dial frequency
    .str("FT8")
    .str("DL1ABC")     // dx call
    .str("-07")        // report
    .str("FT8")        // tx mode
    .bool(true)        // tx enabled
    .bool(false)       // transmitting
    .bool(true)        // decoding
    .u32(1500)         // rx DF
    .u32(1200)         // tx DF
    .str("K9XYZ")      // de call
    .str("EN61")       // de grid
    .str("JO31")       // dx grid
    .bool(false)       // tx watchdog
    .str("")           // sub mode
    .bool(false)       // fast mode
    .u8(0)             // special op mode
    .u32(50)           // frequency tolerance
    .u32(15)           // T/R period
    .str("Default")    // configuration name
    .str("W1AW K9XYZ EN61") // tx message
    .build();

  const r = decodePacket(p);
  check("decodes", r.ok === true, r);
  if (r.ok && r.message.type === WsjtxType.Status) {
    const m = r.message;
    check("dial frequency", m.dialFrequency === 14_074_000, m.dialFrequency);
    check("dxCall", m.dxCall === "DL1ABC", m.dxCall);
    check("txEnabled", m.txEnabled === true);
    check("transmitting", m.transmitting === false);
    check("decoding", m.decoding === true);
    check("rxDF", m.rxDF === 1500, m.rxDF);
    check("txDF", m.txDF === 1200, m.txDF);
    check("deCall", m.deCall === "K9XYZ", m.deCall);
    check("deGrid", m.deGrid === "EN61", m.deGrid);
    check("dxGrid", m.dxGrid === "JO31", m.dxGrid);
    check("trPeriod", m.trPeriod === 15, m.trPeriod);
    check("configurationName", m.configurationName === "Default", m.configurationName);
    check("txMessage", m.txMessage === "W1AW K9XYZ EN61", m.txMessage);
  }
}
{
  // A sender that stops after fastMode must not be treated as truncated.
  const p = head(WsjtxType.Status)
    .u64(7_074_000n).str("FT8").str(null).str(null).str("FT8")
    .bool(false).bool(false).bool(false).u32(0).u32(0)
    .str("K9XYZ").str("EN61").str(null).bool(false).str(null).bool(false)
    .build();
  const r = decodePacket(p);
  check(
    "short Status decodes with defaults",
    r.ok === true && r.message.type === WsjtxType.Status && r.message.trPeriod === 0,
    r,
  );
}

// --------------------------------------------------------------------------
console.log("\n5. QSOLogged — QDateTime handling, incl. the OffsetFromUTC case");

function qdt(p: Pkt, d: Date, timespec: number, offsetSeconds?: number) {
  const { julian, msSinceMidnight } = dateToJulian(d);
  p.i64(julian).u32(msSinceMidnight).u8(timespec);
  if (timespec === 2) p.i32(offsetSeconds ?? 0);
  return p;
}

for (const timespec of [1, 2]) {
  const on = new Date("2026-07-31T14:30:00.000Z");
  const off = new Date("2026-07-31T14:32:00.000Z");

  const p = head(WsjtxType.QSOLogged);
  qdt(p, off, timespec, 0);
  p.str("DL1ABC").str("JO31").u64(14_074_000n).str("FT8")
   .str("-07").str("-12").str("50").str("via Omega").str("Hans");
  qdt(p, on, timespec, 0);
  p.str("K9XYZ").str("K9XYZ").str("EN61").str("").str("").str("");

  const r = decodePacket(p.build());
  const label = timespec === 1 ? "UTC" : "OffsetFromUTC";
  check(`timespec ${label}: decodes`, r.ok === true, r);
  if (r.ok && r.message.type === WsjtxType.QSOLogged) {
    const m = r.message;
    check(`timespec ${label}: dxCall`, m.dxCall === "DL1ABC", m.dxCall);
    check(`timespec ${label}: dxGrid`, m.dxGrid === "JO31", m.dxGrid);
    check(`timespec ${label}: txFrequency`, m.txFrequency === 14_074_000, m.txFrequency);
    check(`timespec ${label}: reports`, m.reportSent === "-07" && m.reportReceived === "-12", [m.reportSent, m.reportReceived]);
    check(`timespec ${label}: name survives`, m.name === "Hans", m.name);
    check(`timespec ${label}: myGrid survives`, m.myGrid === "EN61", m.myGrid);
    check(
      `timespec ${label}: dateTimeOn round-trips`,
      m.dateTimeOn?.toISOString() === on.toISOString(),
      m.dateTimeOn?.toISOString(),
    );
  }
}

// --------------------------------------------------------------------------
console.log("\n6. Julian date conversion");
for (const iso of ["1970-01-01T00:00:00.000Z", "2026-07-31T14:30:00.000Z", "1999-12-31T23:59:59.000Z"]) {
  const d = new Date(iso);
  const { julian, msSinceMidnight } = dateToJulian(d);
  const back = julianToDate(julian, msSinceMidnight);
  check(`${iso} round-trips`, back?.toISOString() === iso, back?.toISOString());
}
check("julian 0 is null (Qt's invalid date)", julianToDate(0n, 0) === null);

// --------------------------------------------------------------------------
console.log("\n7. encoder — every outbound message decodes back");
{
  const buf = encodeReply({
    id: "OMEGA", time: 52_245_000, snr: -13, deltaTime: 0.2,
    deltaFrequency: 1478, mode: "FT8", message: "CQ W1AW FN42",
  });
  check("Reply has the magic number", buf.readUInt32BE(0) === WSJTX_MAGIC);
  check("Reply declares type 4", buf.readUInt32BE(8) === WsjtxType.Reply);
  // Decoded as "Other" — Reply is inbound-only for us, so this asserts the
  // header is well-formed rather than the payload.
  const r = decodePacket(buf);
  check("Reply header parses", r.ok === true && r.message.id === "OMEGA", r);
}
{
  const buf = encodeHighlightCallsign({
    id: "OMEGA", callsign: "W1AW",
    background: { r: 194, g: 24, b: 7 }, foreground: { r: 255, g: 255, b: 255 },
  });
  check("HighlightCallsign type 13", buf.readUInt32BE(8) === WsjtxType.HighlightCallsign);
  check("HighlightCallsign header parses", decodePacket(buf).ok === true);
  // spec byte 1 == Rgb, then alpha 0xffff for an opaque colour.
  const idx = buf.indexOf(Buffer.from("W1AW", "utf8")) + 4;
  check("QColor spec byte is Rgb(1)", buf.readUInt8(idx) === 1, buf.readUInt8(idx));
  check("QColor alpha is 0xffff", buf.readUInt16BE(idx + 1) === 0xffff, buf.readUInt16BE(idx + 1));
  check("QColor red scales by 0x101", buf.readUInt16BE(idx + 3) === 194 * 0x101, buf.readUInt16BE(idx + 3));
}
check("HaltTx type 8", encodeHaltTx("OMEGA").readUInt32BE(8) === WsjtxType.HaltTx);
check("Replay type 7", encodeReplay("OMEGA").readUInt32BE(8) === WsjtxType.Replay);
check("Clear type 3", encodeClear("OMEGA", 2).readUInt32BE(8) === WsjtxType.Clear);
check("FreeText type 9", encodeFreeText("OMEGA", "TU 73", true).readUInt32BE(8) === WsjtxType.FreeText);

// --------------------------------------------------------------------------
console.log("\n8. callsign extraction from FT8/FT4 message lines");
const cases: [string, string | null][] = [
  ["CQ W1AW FN42", "W1AW"],
  ["CQ DX DL1ABC JO31", "DL1ABC"],
  ["CQ POTA K4ABC EM73", "K4ABC"],
  ["K0ABC W1AW -05", "W1AW"],
  ["W1AW K0ABC R-12", "K0ABC"],
  ["VP2E/K9XYZ K0ABC RR73", "K0ABC"],
  ["CQ TEST", null],
  ["RR73", null],
  ["", null],
];
for (const [msg, want] of cases) {
  const got = callsignFromMessage(msg);
  check(`"${msg}" -> ${want ?? "null"}`, got === want, got);
}

// --------------------------------------------------------------------------
console.log("\n9. decode timestamp resolves to a real instant");
{
  const ref = new Date("2026-07-31T14:31:00.000Z");
  const d = decodeTimeToDate(52_245_000, ref); // 14:30:45
  check("same-day decode", d.toISOString() === "2026-07-31T14:30:45.000Z", d.toISOString());
}
{
  // Decode stamped 23:59:45 arriving at 00:00:10 belongs to the previous day.
  const ref = new Date("2026-08-01T00:00:10.000Z");
  const d = decodeTimeToDate(86_385_000, ref);
  check(
    "decode across UTC midnight goes back a day",
    d.toISOString() === "2026-07-31T23:59:45.000Z",
    d.toISOString(),
  );
}

// --------------------------------------------------------------------------
// A DIGU slice does not say whether it carries FT8 or FT4, and the two use
// different window lengths — decode one as the other and you get nothing at all.
// The dial frequency is the only reliable discriminator, and on 30 m the two
// calling frequencies are just 4 kHz apart.
console.log("\n10. digital mode inferred from dial frequency");
{
  const cases: [number, "FT8" | "FT4", boolean][] = [
    [14_074_000, "FT8", true],
    [14_080_000, "FT4", true],
    [10_136_000, "FT8", true],
    [10_140_000, "FT4", true], // 4 kHz from the FT8 frequency
    [7_074_000, "FT8", true],
    [7_047_500, "FT4", true],
    [21_074_000, "FT8", true],
    [21_140_000, "FT4", true],
    [50_313_000, "FT8", true],
    [50_318_000, "FT4", true],
    [14_074_300, "FT8", true], // within tolerance of the calling frequency
    [14_200_000, "FT8", false], // SSB: no match, falls back and says so
  ];

  for (const [hz, mode, certain] of cases) {
    const g = inferDigitalMode(hz);
    check(
      `${(hz / 1e6).toFixed(4)} MHz -> ${mode}${certain ? "" : " (uncertain)"}`,
      g.mode === mode && g.certain === certain,
      g,
    );
  }

  check("FT8 window is 15s", periodMsFor("FT8") === 15_000);
  check("FT4 window is 7.5s", periodMsFor("FT4") === 7_500);
  check("null dial does not throw", inferDigitalMode(null).certain === false);
}

console.log(
  failures === 0
    ? "\nAll WSJT-X checks passed.\n"
    : `\n${failures} WSJT-X CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

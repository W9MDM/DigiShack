/* eslint-disable no-console */
// Assertions on the logged-contact UDP broadcast.
// Run: npm run check:adif-udp
//
// WHAT THIS IS FOR. Everything in amateur radio that wants to know "a contact just happened"
// listens for one datagram: the one WSJT-X sends when "Enable logged contact ADIF broadcast"
// is ticked. GridTracker, Log4OM, JTAlert, N1MM and the live scoring sites all consume it
// and none of them has another way in.
//
// SO THE WHOLE VALUE IS IN BYTE-FOR-BYTE IMITATION, which is exactly the kind of thing that
// cannot be verified by looking at it. A receiver written for WSJT-X will not tell us it
// rejected our datagram; it will simply never show the contact. These assertions pin the
// wire format against the decoder this repo already has — if the encoder and decoder agree,
// a receiver that speaks the same protocol will agree too.

import { adifDatagramBody, parseExtraFields, sendable } from "../lib/logging/adif-udp";
import { destinationProblem, normaliseHost } from "../lib/logging/broadcast-fields";
import { decodePacket, encodeLoggedADIF, WsjtxType, WSJTX_MAGIC } from "../lib/wsjtx/protocol";

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

// ---------------------------------------------------------------------------
console.log("the datagram is the one WSJT-X sends, byte for byte");
// ---------------------------------------------------------------------------
{
  const buf = encodeLoggedADIF("WSJT-X", "<call:5>K9XYZ<eor>");

  // THE MAGIC AND TYPE ARE WHAT A RECEIVER CHECKS FIRST, and a receiver that rejects on
  // either simply shows nothing — there is no error path to notice.
  eq(buf.readUInt32BE(0), WSJTX_MAGIC, "the magic number is WSJT-X's");
  eq(buf.readUInt32BE(4), 2, "schema 2, which is what WSJT-X 2.x speaks");
  eq(buf.readUInt32BE(8), WsjtxType.LoggedADIF, `the type is LoggedADIF (${WsjtxType.LoggedADIF})`);

  // BIG-ENDIAN, because Qt's QDataStream is. Reading it little-endian would give a
  // plausible-looking number and a datagram nothing accepts.
  ok(
    buf.readUInt32LE(0) !== WSJTX_MAGIC,
    "and it is big-endian — the little-endian read does NOT match",
  );
}

{
  // ROUND TRIP THROUGH THIS REPO'S OWN DECODER. The decoder was written against real
  // WSJT-X traffic, so agreeing with it is evidence about real receivers rather than about
  // my own encoder agreeing with itself.
  const adif = "<call:5>K9XYZ<band:3>20m<mode:3>FT8<eor>";
  const out = decodePacket(encodeLoggedADIF("WSJT-X", adif));
  ok(out.ok, "the decoder accepts what the encoder produced", out.ok ? "" : out);
  if (out.ok) {
    eq(out.message.type, WsjtxType.LoggedADIF, "and reads it back as LoggedADIF");
    eq((out.message as { adif?: string }).adif, adif, "with the ADIF payload intact");
  }
}

{
  // A NON-ASCII FIELD MUST SURVIVE. Names and QTH come back from callbooks with accents,
  // and the length prefix is a BYTE count rather than a character count — getting that
  // wrong truncates the record at the first accented letter and every field after it is
  // garbage, which a receiver reports as nothing at all.
  const adif = "<call:5>K9XYZ<name:6>José Ñ<eor>";
  const o1 = decodePacket(encodeLoggedADIF("WSJT-X", adif));
  eq(o1.ok ? (o1.message as { adif?: string }).adif : null, adif,
     "a record with accents round-trips");

  const id = "DigiShack-Ω";
  const o2 = decodePacket(encodeLoggedADIF(id, "<eor>"));
  eq(o2.ok ? (o2.message as { id?: string }).id : null, id,
     "and so does a non-ASCII station id");
}

// ---------------------------------------------------------------------------
console.log("the payload is a document a receiver will parse");
// ---------------------------------------------------------------------------
{
  const row = {
    id: "x",
    callsign: "K1ABC",
    band: "20M",
    mode: "FT8",
    freqHz: BigInt(14_074_000),
    startTime: new Date("2026-10-13T21:40:00Z"),
    endTime: new Date("2026-10-13T21:41:00Z"),
    rstSent: -10,
    rstRcvd: -12,
    gridSquare: "FN42",
    dxcc: 291,
    cqZone: 5,
    continent: "NA",
    sig: null,
    sigInfo: null,
    sigRefs: [],
    station: { callsign: "K9XYZ", gridSquare: "EN61AA" },
    operator: null,
  } as unknown as Parameters<typeof adifDatagramBody>[0];

  const body = adifDatagramBody(row, { programId: "WSJT-X", comment: "" });

  // A FULL DOCUMENT, NOT A BARE RECORD. WSJT-X sends header, <EOH>, then the record, and
  // receivers differ in how much they tolerate — some want the header. Sending what WSJT-X
  // sends is the only choice that cannot be wrong for software written against WSJT-X.
  ok(/<eoh>/i.test(body), "the document has an <EOH>, as WSJT-X's does");
  ok(/<eor>/i.test(body), "and the record is terminated with <EOR>");
  // LOWER-CASED FOR THE POSITION CHECK. ADIF tags are emitted upper-case, and the first
  // version of this compared case-sensitively: both `indexOf` calls returned -1 and
  // `-1 < -1` is false, so a correct document failed. The checks around it used /i or
  // toLowerCase and passed, which is exactly how one inconsistent assertion hides.
  const lower = body.toLowerCase();
  ok(
    lower.indexOf("<eoh>") >= 0 && lower.indexOf("<eoh>") < lower.indexOf("<call:"),
    "the header comes before the record",
  );

  // The fields a logger files a contact under. A datagram missing these parses cleanly and
  // is useless, which is the failure mode worth asserting.
  for (const f of ["call:", "band:", "mode:", "qso_date:", "time_on:"]) {
    ok(body.toLowerCase().includes(`<${f}`), `the record carries <${f}…>`);
  }
  ok(body.includes("K1ABC"), "and the callsign actually worked is in it");
}

// ---------------------------------------------------------------------------
console.log("it is off until somebody turns it on");
// ---------------------------------------------------------------------------
{
  // THIS PUTS THE STATION'S LOG ON A NETWORK as cleartext UDP to an address typed into a
  // settings box. That is fine aimed at a logger on the desk and a decision worth making
  // deliberately otherwise, so the default must be off — asserted against the registry
  // rather than trusted, because a default is one careless edit from flipping.
  const { SETTINGS } = require("../lib/settings/registry") as {
    SETTINGS: { key: string; default?: string; legacyKeys?: string[] }[];
  };
  const def = (key: string) => SETTINGS.find((s) => s.key === key);

  // THE BROADCAST FOR OTHER PROGRAMS: its own switch, off until somebody turns it on.
  eq(def("udp.enabled")?.default, "false", "the UDP broadcast defaults to OFF");
  ok(
    def("udp.host") !== undefined && def("udp.port") !== undefined,
    "a destination host and port are registered",
  );
  // 2333 is GridTracker's, and a neutral default is right because the correct port is
  // whatever the RECEIVER listens on — FT8BR publishes 2237, which is also WSJT-X's status
  // port, so neither number is universally right and the operator must be told to check.
  ok(def("udp.port")?.default !== "2237", "and the port does not default to the status-protocol port");

  // BATTLE ROYALE: BR MODE IS THE SWITCH. "only transmit to that when br mode is on" — so
  // there is no second enable to leave off by mistake, and the port defaults to the one
  // FT8BR publishes, because that destination is not a guess.
  eq(def("br.enabled")?.default, "false", "BR mode defaults to OFF");
  ok(def("br.udpEnabled") === undefined, "and the BR broadcast has no switch of its own");
  eq(def("br.port")?.default, "2237", "the BR port defaults to the one FT8BR publishes");

  // AN EXISTING INSTALL KEEPS ITS DESTINATION. The settings that used to be the only
  // broadcast were pointed at FT8BR by the operator who asked for this, so the BR keys read
  // the old udpLog.* rows as legacy names — and the other-programs keys do NOT, or turning
  // the UDP button on would report to the contest server under a second identity.
  for (const f of ["host", "port", "programId", "comment", "extraFields", "stationId"]) {
    ok((def(`br.${f}`)?.legacyKeys ?? []).includes(`udpLog.${f}`), `br.${f} reads the old udpLog.${f}`);
    ok((def(`udp.${f}`)?.legacyKeys ?? []).length === 0, `udp.${f} starts clean`);
  }
}

// ---------------------------------------------------------------------------
console.log("a broadcast goes out only when it is on AND pointed somewhere");
// ---------------------------------------------------------------------------
{
  const base = { enabled: true, host: "192.0.2.99", port: 2237 };
  ok(sendable(base), "on, a host and a valid port: sendable");
  ok(!sendable({ ...base, enabled: false }), "off: not sendable, whatever else is set");
  ok(!sendable({ ...base, host: "" }), "no host: not sendable");
  ok(!sendable({ ...base, port: 0 }), "port 0 asks the OS to choose, which for a destination is nowhere");
  ok(!sendable({ ...base, port: 70000 }), "nor a port above 65535");
  ok(!sendable({ ...base, port: Number.NaN }), "nor a port that is not a number");
}

// ---------------------------------------------------------------------------
console.log("NOTHING IDENTIFYING LEAVES THE STATION UNLESS THE OPERATOR PUT IT THERE");
// ---------------------------------------------------------------------------

// THE REPORT: "i dont want it to say its logging from digishack ... some contests only allow
// a wsjtx adif". Three separate markers were going out with every contact, and one of them
// was worse than a name:
//
//   PROGRAMID        "DigiShack"                   hardcoded in adifHeader
//   COMMENT          "DigiShack native FT8/FT4"    from the row's own notes field
//   APP_DIGISHACK_*  sigrefs, emailqslsent         this program's private fields
//
// The COMMENT is the one that mattered. It is the field the live scoring sites read for
// their own commands — a POTA reference, a /name request — so filling it with an internal
// note did not merely identify the software, it quietly made those features unusable.
{
  const row = {
    id: "x",
    callsign: "K1ABC",
    band: "20M",
    mode: "FT4",
    freqHz: BigInt(14_080_000),
    startTime: new Date("2026-10-13T21:40:00Z"),
    endTime: new Date("2026-10-13T21:41:00Z"),
    rstSent: -10,
    rstRcvd: -12,
    gridSquare: "FN42",
    txPowerW: 90,
    name: null,
    notes: "DigiShack native FT8/FT4",
    myGridSquare: null,
    sigRefs: [],
    station: { callsign: "K9XYZ", grid: "EN61AA" },
    operator: null,
  } as unknown as Parameters<typeof adifDatagramBody>[0];

  const out = adifDatagramBody(row, { programId: "WSJT-X", comment: "" });

  // THE ASSERTION THE OPERATOR ASKED FOR, stated as a property rather than a field list so
  // it keeps holding when fields are added later.
  ok(!/digishack/i.test(out), "no form of the word appears anywhere in the datagram", out);
  ok(!out.includes("DigiShack native FT8/FT4"), "the row's internal note is not sent");
  ok(!/APP_/i.test(out), "and no APP_ private fields are sent");

  // AND THE COMMENT IS EMPTY RATHER THAN ABSENT-BUT-DEFAULTED. An empty setting must send no
  // COMMENT at all, leaving the field free for whatever the operator puts there.
  ok(!/<comment:/i.test(out), "an empty comment sends no COMMENT field");

  const withComment = adifDatagramBody(row, { programId: "WSJT-X", comment: "POTA US-1012" });
  ok(/<comment:12>POTA US-1012/i.test(withComment), "and the operator's comment is sent verbatim");

  // PROGRAMID IS THE OPERATOR'S CHOICE, which is the whole point of the setting.
  ok(/<programid:6>WSJT-X/i.test(out), "PROGRAMID carries the configured value");
  const asSelf = adifDatagramBody(row, { programId: "DigiShack", comment: "" });
  ok(/<programid:9>DigiShack/i.test(asSelf), "and can be set back to DigiShack deliberately");
}

{
  // THE MODE SPLIT, because the scoring sites read the SUBMODE to decide the FT4/FT2
  // multiplier and ADIF spells FT4 as MODE=MFSK. Sending MODE=FT4 is a mode nothing written
  // against WSJT-X is looking for, and it would silently score at 1x instead of 2x.
  const row = {
    id: "x", callsign: "K1ABC", band: "20M", mode: "FT4",
    freqHz: BigInt(14_080_000),
    startTime: new Date("2026-10-13T21:40:00Z"), endTime: new Date("2026-10-13T21:41:00Z"),
    rstSent: -10, rstRcvd: -12, gridSquare: "FN42", txPowerW: null, name: null,
    notes: null, myGridSquare: null, sigRefs: [],
    station: { callsign: "K9XYZ", grid: "EN61AA" }, operator: null,
  } as unknown as Parameters<typeof adifDatagramBody>[0];
  const out = adifDatagramBody(row, { programId: "WSJT-X", comment: "" });
  ok(/<mode:4>MFSK/i.test(out), "FT4 is sent as MODE=MFSK, the way ADIF and WSJT-X spell it");
  ok(/<submode:3>FT4/i.test(out), "with SUBMODE=FT4, which is what carries the multiplier");
}

// ---------------------------------------------------------------------------
console.log("CONTACT DATA CANNOT BE EDITED, STATION METADATA CAN");
// ---------------------------------------------------------------------------

// "allow extra ones that arent ft8 actual data to be edited" — the right instinct, and the
// boundary has to be drawn by something other than taste. Everything refused below was
// measured by the radio or typed into a contact: a text box that could rewrite CALL or
// RST_SENT is not a formatting option, it is a tool for logging contacts that did not
// happen, and every scoring site bans fabricated QSOs outright.
{
  const good = parseExtraFields("MY_ANTENNA=EFHW, MY_RIG=FLEX-6400");
  eq(good.fields.length, 2, "station metadata is accepted");
  eq(good.refused.length, 0, "and nothing is refused");
  eq(good.fields[0]!.name, "MY_ANTENNA", "names are upper-cased");

  // EVERY PROTECTED FIELD, named individually. A loop over the set would assert the code
  // against itself; these are written out so the list is reviewable as a decision.
  for (const f of [
    "CALL", "GRIDSQUARE", "MODE", "SUBMODE", "RST_SENT", "RST_RCVD",
    "QSO_DATE", "TIME_ON", "BAND", "FREQ",
  ]) {
    const r = parseExtraFields(`${f}=XXX`);
    eq(r.fields.length, 0, `${f} is refused — it comes from the contact`);
    ok(r.refused[0]?.reason.includes("cannot be set") ?? false, `and ${f} says why`);
  }

  // THE ONE PEOPLE REACH FOR. Sending a different STATION_CALLSIGN is impersonation, which
  // contests and scoring sites treat as a banned offence rather than a preference.
  const call = parseExtraFields("STATION_CALLSIGN=W1AW");
  eq(call.fields.length, 0, "STATION_CALLSIGN cannot be overridden");

  // Case and spacing must not be a way past the list.
  eq(parseExtraFields("call=W1AW").fields.length, 0, "lower case does not evade the refusal");
  eq(parseExtraFields("  Call = W1AW ").fields.length, 0, "nor does padding");

  // MALFORMED LINES ARE REPORTED, NOT SWALLOWED. A setting that silently drops half its
  // content is the failure the preview exists to prevent.
  const bad = parseExtraFields(["MY_ANTENNA=EFHW", "nonsense", "MY_RIG=", "9BAD=x"].join("\n"));
  eq(bad.fields.length, 1, "the one good line survives");
  eq(bad.refused.length, 3, "and all three bad ones are reported");
  ok(bad.refused.some((r) => r.reason.includes("NAME=value")), "a line with no = is named");
  ok(bad.refused.some((r) => r.reason.includes("empty value")), "an empty value is named");
  ok(bad.refused.some((r) => r.reason.includes("valid ADIF")), "a bad field name is named");

  // A duplicate is refused rather than sent twice — two values for one field is not a
  // record a parser can read.
  const dup = parseExtraFields("MY_RIG=A, MY_RIG=B");
  eq(dup.fields.length, 1, "a repeated field is only sent once");
  ok(dup.refused[0]?.reason.includes("already set") ?? false, "and the repeat says so");
}

{
  // AND THE ACCEPTED ONES REACH THE WIRE, appended after the contact's own fields so they
  // cannot displace one even if the parser ever let a protected name through.
  const row = {
    id: "x", callsign: "K1ABC", band: "20M", mode: "FT8",
    freqHz: BigInt(14_074_000),
    startTime: new Date("2026-10-13T21:40:00Z"), endTime: new Date("2026-10-13T21:41:00Z"),
    rstSent: -10, rstRcvd: -12, gridSquare: "FN42", txPowerW: null, name: null,
    notes: null, myGridSquare: null, sigRefs: [],
    station: { callsign: "K9XYZ", grid: "EN61AA" }, operator: null,
  } as unknown as Parameters<typeof adifDatagramBody>[0];

  const out = adifDatagramBody(row, {
    programId: "WSJT-X",
    comment: "",
    extra: parseExtraFields("MY_ANTENNA=EFHW").fields,
  });
  ok(/<my_antenna:4>EFHW/i.test(out), "an accepted extra field is on the wire");
  ok(out.indexOf("MY_ANTENNA") > out.indexOf("CALL"), "and appended after the contact's own");
  // The contact's callsign is still the real one.
  ok(/<call:5>K1ABC/i.test(out), "and the worked callsign is untouched");
}

// ---------------------------------------------------------------------------
console.log("A PASTED URL IS NOT A HOSTNAME");
// ---------------------------------------------------------------------------

// FROM THE LIVE STATION, once per contact and in a log nobody had a reason to open:
//
//     [udp-log] could not send to http://129.212.188.3/:2237:
//               getaddrinfo ENOTFOUND http://129.212.188.3/
//
// The operator pasted the address the scoring site shows. Every other address in this
// application is a URL, so that is an entirely reasonable thing to type — and UDP has no
// URLs, so the whole string went to getaddrinfo as a hostname and every contact failed
// silently. The setting took it without complaint, which is the actual defect.
{
  eq(normaliseHost("http://129.212.188.3/"), "129.212.188.3", "the exact string that failed, fixed");
  eq(normaliseHost("https://example.com/path"), "example.com", "scheme and path both go");
  eq(normaliseHost("udp://10.0.0.5"), "10.0.0.5", "any scheme, not just http");
  eq(normaliseHost("  129.212.188.3  "), "129.212.188.3", "padding is trimmed");
  eq(normaliseHost("129.212.188.3"), "129.212.188.3", "and a plain address is untouched");
  eq(normaliseHost(""), "", "empty stays empty");

  // IPv6 literals survive, brackets removed. Stripping a "port" off one would corrupt the
  // address, which is the same trap lib/auth/client-ip.ts documents.
  eq(normaliseHost("[2001:db8::1]"), "2001:db8::1", "a bracketed IPv6 literal keeps its address");
  eq(normaliseHost("2001:db8::1"), "2001:db8::1", "and a bare one is left alone");
}

{
  // WHAT CANNOT BE GUESSED IS REPORTED, not silently resolved. An inline port that disagrees
  // with the port box is two sources of truth, and picking one would be a coin toss the
  // operator never sees.
  ok(destinationProblem("http://129.212.188.3/", 2237) !== null, "a URL is reported");
  ok(
    destinationProblem("http://129.212.188.3/", 2237)!.includes("no URLs"),
    "and says why in words",
  );
  ok(destinationProblem("1.2.3.4:9999", 2237)!.includes("twice"), "an inline port is reported");
  ok(destinationProblem("", 2237)!.includes("nothing is being sent"), "an empty host is reported");
  ok(destinationProblem("1.2.3.4", 0)!.includes("not a usable port"), "a bad port is reported");

  // AND A GOOD DESTINATION IS SILENT. A validator that always has something to say is a
  // validator people stop reading.
  eq(destinationProblem("129.212.188.3", 2237), null, "the real destination reports nothing");
  eq(destinationProblem("127.0.0.1", 2333), null, "nor does a local logger");
  eq(destinationProblem("[2001:db8::1]", 2237), null, "nor an IPv6 literal");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all adif-udp assertions passed");

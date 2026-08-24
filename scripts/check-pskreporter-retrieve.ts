// Reception reports — the other direction from the upload.
//
// The database half is not exercised here; what is worth pinning is the query, the parse,
// and the rule that decides which contact a report belongs to. Every one of those can be
// wrong in a way that looks like success: a query that asks for the wrong window returns
// valid XML, a parse that drops the SNR reads as a station with no signal report, and a
// matcher that is too generous attributes a reception to the wrong contact.

import {
  MATCH_MARGIN_MS,
  pickQso,
} from "@/lib/pskreporter/collect";
import {
  buildQueryUrl,
  isRateLimited,
  MAX_LOOKBACK_SECONDS,
  MIN_QUERY_INTERVAL_MS,
  parseReceptionReports,
  type ReceptionReport,
} from "@/lib/pskreporter/retrieve";

let pass = 0;
let fail = 0;

function ok(cond: boolean, what: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${what}`);
  } else {
    fail++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `got ${a}, want ${b}`);
}

console.log("\nthe query");
{
  const url = buildQueryUrl({ senderCallsign: "k9xyz", lookbackSeconds: 900, contact: "a@b.c" });
  ok(url.includes("senderCallsign=K9XYZ"), "asks about us, upper cased");
  ok(url.includes("flowStartSeconds=-900"), "negative seconds — their spelling of 'ago'");
  ok(url.includes("rronly=1"), "reception reports only, not the active-receiver list");
  ok(url.includes("appcontact=a%40b.c"), "and identifies us, which is how not to get blocked");

  // A day of reports to find the last few minutes' worth is a lot of XML off a free
  // service running on donated hardware.
  ok(
    buildQueryUrl({ senderCallsign: "K9XYZ", lookbackSeconds: 999_999 }).includes(
      `flowStartSeconds=-${MAX_LOOKBACK_SECONDS}`,
    ),
    "an enormous lookback is clamped",
  );
  ok(
    buildQueryUrl({ senderCallsign: "K9XYZ", lookbackSeconds: 1 }).includes("flowStartSeconds=-60"),
    "and a tiny one is floored at a minute",
  );
  ok(
    !buildQueryUrl({ senderCallsign: "K9XYZ" }).includes("appcontact"),
    "no contact set means the parameter is left off, not sent empty",
  );
  eq(MIN_QUERY_INTERVAL_MS, 5 * 60_000, "five minutes between queries, as they ask");
}

console.log("\nreading the reports");
{
  const xml = `<?xml version="1.0" ?>
<receptionReports currentSeconds="1785000000">
  <receptionReport receiverCallsign="K1ABC" receiverLocator="FN42aa" frequency="14074613"
    flowStartSeconds="1785000060" mode="FT8" sNR="-12" senderCallsign="K9XYZ"
    senderLocator="EN61" />
  <receptionReport receiverCallsign="ve3xyz" receiverLocator="FN03" frequency="14074500"
    flowStartSeconds="1785000075" mode="FT8" sNR="0" senderCallsign="K9XYZ" />
  <activeReceiver callsign="K9NOISE" frequency="14074000" mode="FT8" />
</receptionReports>`;

  const reports = parseReceptionReports(xml);
  eq(reports.length, 2, "two reports, and the activeReceiver is not one of them");
  eq(reports[0]?.receiverCall, "K1ABC", "the receiver's callsign");
  eq(reports[0]?.receiverGrid, "FN42AA", "and its grid, upper cased");
  eq(reports[0]?.snr, -12, "the signal report");
  eq(reports[0]?.freqHz, 14074613, "the frequency they heard us on");
  eq(reports[0]?.reportedAt.toISOString(), new Date(1785000060_000).toISOString(), "the time");
  eq(reports[1]?.receiverCall, "VE3XYZ", "a lower-case callsign is normalised");

  // 0 dB is a strong signal. Reading a missing SNR as zero would invent one, and an
  // absent report is a real state — some modes do not carry one.
  eq(reports[1]?.snr, 0, "a report of exactly 0 dB is kept as 0");
  const noSnr = parseReceptionReports(
    `<receptionReport receiverCallsign="K1ABC" frequency="14074000" flowStartSeconds="1785000060" />`,
  );
  eq(noSnr[0]?.snr, null, "and a missing one is null, not 0");
  eq(noSnr[0]?.receiverGrid, null, "a missing grid is null too");
}

console.log("\nresponses that are not reports");
{
  eq(parseReceptionReports("").length, 0, "an empty body yields nothing");
  eq(parseReceptionReports("<receptionReports/>").length, 0, "so does an empty report set");

  // Each of these is missing something that IS the report. Storing a partial one would
  // put a reception in the log that nobody sent.
  eq(
    parseReceptionReports(
      `<receptionReport frequency="14074000" flowStartSeconds="1785000060" />`,
    ).length,
    0,
    "no receiver callsign, no report",
  );
  eq(
    parseReceptionReports(
      `<receptionReport receiverCallsign="K1ABC" flowStartSeconds="1785000060" />`,
    ).length,
    0,
    "nor without a frequency",
  );
  eq(
    parseReceptionReports(`<receptionReport receiverCallsign="K1ABC" frequency="14074000" />`)
      .length,
    0,
    "nor without a time",
  );
  eq(
    parseReceptionReports(
      `<receptionReport receiverCallsign="K1ABC" frequency="0" flowStartSeconds="1785000060" />`,
    ).length,
    0,
    "nor with a frequency of zero",
  );
}

console.log("\nbeing told to slow down");
{
  // The reading that matters. A rate-limited query answered as "0 reports" says nobody
  // heard us — which is what would send an operator out to check their antenna.
  ok(isRateLimited(503, ""), "a 503 is a refusal");
  ok(
    isRateLimited(200, "You have made this query too often. Please wait."),
    "and so is prose about querying too often, whatever the status",
  );
  ok(!isRateLimited(200, "<receptionReports/>"), "an empty report set is not a refusal");
}

console.log("\nwhich contact a report belongs to");
{
  const T = Date.parse("2026-08-03T14:00:00Z");
  const report = (atMs: number, freqHz = 14_074_000): ReceptionReport => ({
    receiverCall: "K1ABC",
    receiverGrid: "FN42",
    senderCall: "K9XYZ",
    snr: -10,
    freqHz,
    reportedAt: new Date(atMs),
    mode: "FT8",
  });

  const twenty = {
    id: "q20",
    band: "20M",
    startTime: new Date(T),
    endTime: new Date(T + 120_000),
  };
  const forty = {
    id: "q40",
    band: "40M",
    startTime: new Date(T),
    endTime: new Date(T + 120_000),
  };

  eq(pickQso(report(T + 60_000), [twenty, forty])?.id, "q20", "band decides between two");
  eq(
    pickQso(report(T + 60_000, 7_074_000), [twenty, forty])?.id,
    "q40",
    "and the frequency is what says which band",
  );

  // A report of the CQ that started the exchange belongs with the exchange.
  eq(
    pickQso(report(T - 30_000), [twenty])?.id,
    "q20",
    "a report just before the contact is inside the margin",
  );
  eq(
    pickQso(report(T + 150_000), [twenty])?.id,
    "q20",
    "and just after it, likewise",
  );
  eq(
    pickQso(report(T - MATCH_MARGIN_MS - 1_000), [twenty]),
    null,
    "beyond the margin it belongs to nothing",
  );

  // The majority case, and not an error: most reports of an FT8 station are of CQs that
  // led to no contact at all.
  eq(pickQso(report(T + 3_600_000), [twenty]), null, "an hour later, nothing");
  eq(pickQso(report(T, 1_000), [twenty]), null, "a frequency on no amateur band, nothing");

  // Two contacts a minute apart could both reach a report through their margins. Only
  // the closer one may have it, or the same reception is counted twice.
  const first = { id: "first", band: "20M", startTime: new Date(T), endTime: new Date(T + 60_000) };
  const second = {
    id: "second",
    band: "20M",
    startTime: new Date(T + 90_000),
    endTime: new Date(T + 150_000),
  };
  eq(
    pickQso(report(T + 70_000), [first, second])?.id,
    "first",
    "the nearer contact wins — 10s after one, 20s before the other",
  );
  eq(
    pickQso(report(T + 85_000), [first, second])?.id,
    "second",
    "and the other way round",
  );
  eq(
    pickQso(report(T + 30_000), [first, second])?.id,
    "first",
    "a report inside a contact beats one that only reached a margin",
  );

  // An in-progress contact has no end time.
  const open = { id: "open", band: "20M", startTime: new Date(T), endTime: null };
  eq(pickQso(report(T + 30_000), [open])?.id, "open", "a contact with no end time still matches");
  eq(
    pickQso(report(T + MATCH_MARGIN_MS + 1_000), [open]),
    null,
    "measured from its start, since that is all there is",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

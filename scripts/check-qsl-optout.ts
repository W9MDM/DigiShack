/* eslint-disable no-console */
// Opting out of QSL email.
//
// These are unsolicited messages to strangers, so the tests are about the two things that
// make that defensible: an easy way out, and honouring it the first time. The prompting
// case is in here by name — K2XYZ replied to a QSL email with the single word
// "Unsubscribe", because the message gave him nothing to click and no instruction to
// follow.

import { qrzMarkerIn, tokenValid, unsubscribeToken, unsubscribeUrl } from "@/lib/qsl/opt-out";

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
function eq<T>(a: T, b: T, label: string): void {
  ok(Object.is(a, b), label, `got ${String(a)}, want ${String(b)}`);
}

// The token is signed under SETTINGS_KEY; give the test one.
process.env.SETTINGS_KEY = process.env.SETTINGS_KEY ?? "test-key-for-optout-checks";

console.log("the QRZ opt-out marker");
{
  // The convention documented at n1et.com/optout: a marker in the QSL-route field, which
  // QRZ calls `qslmgr` and which this application already reads as `qslVia`.
  eq(qrzMarkerIn("NOQSOCC"), "NOQSOCC", "NOQSOCC is honoured");
  eq(qrzMarkerIn("NOEQSL"), "NOEQSL", "so is NOEQSL");
  eq(qrzMarkerIn("noqsocc"), "NOQSOCC", "case does not matter");
  // Free text, so the marker sits alongside whatever else they wrote.
  eq(
    qrzMarkerIn("Direct or bureau, NOQSOCC please"),
    "NOQSOCC",
    "and it is found inside a sentence",
  );
  eq(qrzMarkerIn("LoTW and eQSL preferred"), null, "an ordinary QSL route is not a marker");
  // "eQSL" alone must NOT match NOEQSL — that would opt out everybody who mentions eQSL,
  // which is most of the hobby, and the failure would be silent.
  eq(qrzMarkerIn("eQSL"), null, "mentioning eQSL is not opting out");
  eq(qrzMarkerIn("Bureau only"), null, "nor is a bureau preference");
  eq(qrzMarkerIn(null), null, "no route at all is not a marker");
  eq(qrzMarkerIn(""), null, "nor is an empty one");
}

console.log("\nthe unsubscribe token");
{
  const a = unsubscribeToken("K2XYZ");
  ok(a.length >= 16, `long enough not to be guessed (${a.length} chars)`);
  eq(unsubscribeToken("k2xyz"), a, "case-insensitive: one operator, one token");
  eq(unsubscribeToken(" K2XYZ "), a, "and whitespace does not change it");
  ok(unsubscribeToken("K1XYZ") !== a, "different callsigns get different tokens");

  ok(tokenValid("K2XYZ", a), "a real token validates");
  ok(tokenValid("k2xyz", a), "in any case");
  ok(!tokenValid("K1XYZ", a), "one callsign's token does not work for another");
  ok(!tokenValid("K2XYZ", ""), "an empty token is refused");
  ok(!tokenValid("K2XYZ", "x".repeat(32)), "and so is a forged one of the right length");
  // A truncated token must fail rather than throw: mail clients break long links.
  ok(!tokenValid("K2XYZ", a.slice(0, 20)), "a truncated link fails cleanly");
}

console.log("\nthe link that goes in the email");
{
  const url = unsubscribeUrl("https://shack.example.com", "K2XYZ");
  ok(url.startsWith("https://shack.example.com/api/qsl/unsubscribe?"), "points at the endpoint");
  ok(url.includes("call=K2XYZ"), "carries the callsign");
  ok(url.includes(`t=${unsubscribeToken("K2XYZ")}`), "and the matching token");
  // A trailing slash on the configured base must not produce a double slash — some mail
  // clients will not linkify a URL with one, which would break the only way out.
  ok(
    !unsubscribeUrl("https://shack.example.com/", "K2XYZ").includes("com//"),
    "a trailing slash on the base URL is tolerated",
  );
  // Portable calls carry a slash, which must be escaped or the query breaks.
  ok(
    unsubscribeUrl("https://x.test", "K2XYZ/P").includes("call=K2XYZ%2FP"),
    "a portable callsign is percent-encoded",
  );
  ok(tokenValid("K2XYZ/P", unsubscribeToken("K2XYZ/P")), "and still validates");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

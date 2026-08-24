/* eslint-disable no-console */
// Cloudlog / Wavelog URL handling.
//
// The only part of this integration with logic worth testing, and the part where a
// mistake is hardest to diagnose: a wrong path returns 404, which an operator reads as
// "my server is down" rather than "the URL I pasted had a trailing slash".

import { cloudlogQsoUrl, isDuplicateReply } from "@/lib/integrations/cloudlog";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

function eq(actual: string, expected: string, label: string): void {
  if (actual === expected) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} — got "${actual}", want "${expected}"`);
  }
}

const WANT = "https://logging.example.com/index.php/api/qso";

console.log("\nwhatever the operator pastes");
{
  eq(cloudlogQsoUrl("https://logging.example.com"), WANT, "bare host");
  eq(cloudlogQsoUrl("https://logging.example.com/"), WANT, "trailing slash");
  eq(cloudlogQsoUrl("https://logging.example.com///"), WANT, "several trailing slashes");
  eq(cloudlogQsoUrl("  https://logging.example.com  "), WANT, "surrounding whitespace");
  eq(cloudlogQsoUrl("https://logging.example.com/index.php"), WANT, "already has index.php");
  eq(cloudlogQsoUrl(WANT), WANT, "already the full API path — not doubled");
  eq(
    cloudlogQsoUrl("https://logging.example.com/index.php/api/qso/"),
    WANT,
    "full path with a trailing slash",
  );
}

console.log("\ninstalls in a subdirectory");
{
  // Common when Cloudlog shares a host with something else.
  eq(
    cloudlogQsoUrl("https://example.com/cloudlog"),
    "https://example.com/cloudlog/index.php/api/qso",
    "subdirectory install",
  );
  eq(
    cloudlogQsoUrl("https://example.com/cloudlog/"),
    "https://example.com/cloudlog/index.php/api/qso",
    "subdirectory with a trailing slash",
  );
}

console.log("\ncase");
{
  // A pasted URL may carry any capitalisation of the path; matching must not care,
  // or the path gets appended twice and every upload 404s.
  eq(
    cloudlogQsoUrl("https://logging.example.com/INDEX.PHP"),
    "https://logging.example.com/INDEX.PHP/api/qso",
    "index.php in caps is recognised, not appended again",
  );
  eq(
    cloudlogQsoUrl("https://logging.example.com/index.php/API/QSO"),
    "https://logging.example.com/index.php/API/QSO",
    "an upper-case API path is left alone",
  );
}

console.log("\nduplicates are not failures");
{
  // CAPTURED from Wavelog, which reports a duplicate with HTTP 400 and this body. The old
  // code asserted in a comment that duplicates arrive with a 200 and are "reported rather
  // than erroring" — the opposite of what happens — so the `!res.ok` branch caught them
  // first AND returned from inside the upload loop. One duplicate therefore ended the whole
  // sweep, and with duplicates scattered through a 28,000-contact backlog it would have
  // stopped at the first one every run, uploading nothing after it.
  const real =
    '{"status":"abort","type":"adif","string":"","adif_count":1,"adif_errors":1,' +
    '"messages":["","Date\/Time: 2017-12-02 01:15:00 Callsign: K9LOT Band: 2m ' +
    'Duplicate for K9XYZ<br>"]}';
  ok(isDuplicateReply(real), "the real Wavelog duplicate reply is recognised");
  ok(
    !isDuplicateReply('{"status":"created","type":"adif","adif_count":1,"adif_errors":0}'),
    "and a successful create is not",
  );
  ok(
    !isDuplicateReply('{"status":"abort","messages":["Band not supported"]}'),
    "nor an unrelated rejection",
  );
}


console.log(`
${pass} passed, ${fail} failed
`);
if (fail > 0) process.exit(1);

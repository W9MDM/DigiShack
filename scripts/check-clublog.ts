/* eslint-disable no-console */
// Checks how Club Log's replies are read.
// Run: npm run check:clublog
//
// THE FAULT THESE GUARD. Club Log answers 200 for both success and refusal and says which
// in the BODY, so the status alone decides nothing. Two of those bodies are traps:
//
//   "Dupe"  — a contact Club Log ALREADY HOLDS. That is the goal achieved, not a failure.
//             Read as a failure it leaves the row flagged unsent and re-sends it every
//             sweep for ever, at a service that blocks addresses for repeated requests.
//             Uploads are now one contact per request, so this would be a permanent
//             self-inflicted load rather than one wasted batch.
//
//   a bare  — what a MISSING API KEY looks like: refused before PHP, so no error text and
//   nginx     no mention of credentials. This was diagnosed for a month as Club Log
//   403       blocking the installation at its edge, unfixably, because reads kept working
//             from the same address the whole time and "reads pass, writes do not" fits a
//             firewall rule as well as it fits an absent form field. It was an absent form
//             field.
//
// These call the real `classifyClubLogReply`, not a copy: check-dxcc.ts spent a long time
// asserting a rule only its own local reimplementation followed.
//
// The replies quoted below are VERBATIM from the live service on 2026-08-30, from the
// station's own address, with a valid API key attached.

import { classifyClubLogReply } from "../lib/integrations/clublog-reply";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const NGINX_403 =
  "<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n" +
  "<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>";

console.log("1. the replies that were actually measured");
{
  const ok = classifyClubLogReply(200, "OK");
  check('realtime.php "OK" is a success', ok.ok && !ok.duplicate, ok);

  const dupe = classifyClubLogReply(200, "Dupe");
  check('realtime.php "Dupe" is a SUCCESS', dupe.ok, dupe);
  check("and is flagged as a duplicate", dupe.duplicate, dupe);

  const batch = classifyClubLogReply(
    200,
    "digishack.adi (546 bytes) => K9XYZ : Upload accepted and queued!",
  );
  check("putlogs.php acceptance is a success", batch.ok, batch.detail);
  check("and is not mistaken for a duplicate", !batch.duplicate, batch);
}

console.log("");
console.log("2. THE DUPE TRAP: it must never be read as a refusal");
{
  // If this ever fails, every contact Club Log already holds is re-sent on every sweep,
  // for ever, one request each.
  for (const body of ["Dupe", "dupe", "DUPE", "Dupe.", "Dupe - already in log"]) {
    const v = classifyClubLogReply(200, body);
    check(`"${body}" -> success, duplicate`, v.ok && v.duplicate, v);
  }
  // Ordering: the dupe test runs BEFORE the refusal words, and a body carrying both must
  // still come out a duplicate rather than a failure.
  const both = classifyClubLogReply(200, "Dupe: rejected as already present");
  check("a dupe mentioning a refusal word is still a duplicate", both.ok && both.duplicate, both);
}

console.log("");
console.log("3. THE MISSING KEY: a bare nginx 403 names the fix");
{
  const v = classifyClubLogReply(403, NGINX_403);
  check("is a failure", !v.ok, v);
  check("is not a duplicate", !v.duplicate, v);
  // The whole correction. This used to say the installation could never upload and that
  // the operator should go and use LoTW instead. It was wrong, and it was wrong for a
  // month.
  check("names the API key as the cause", /api key/i.test(v.detail), v.detail);
  check("tells the operator where to set it", /settings/i.test(v.detail), v.detail);
  check(
    "does NOT claim the condition is hopeless",
    !/never|nothing here can|point club log at lotw/i.test(v.detail),
    v.detail,
  );
}

console.log("");
console.log("4. but Club Log's OWN 403 is a different thing");
{
  // It carries its own words, so it is reported verbatim rather than blamed on a key.
  const v = classifyClubLogReply(403, "Club Log: your account is over quota for today");
  check("is a failure", !v.ok, v);
  check("is reported in Club Log's words", /quota/i.test(v.detail), v.detail);
  check("is not blamed on the API key", !/api key/i.test(v.detail), v.detail);
}

console.log("");
console.log("5. refusals that arrive as 200");
{
  for (const body of [
    "Error: invalid callsign",
    "Invalid password",
    "Access denied",
    "Upload failed",
    "Record rejected",
  ]) {
    const v = classifyClubLogReply(200, body);
    check(`"${body}" -> failure`, !v.ok, v);
  }
}

console.log("");
console.log("6. an empty 200 is a failure, and that is the safe direction");
{
  // A judgement call rather than a measurement: Club Log answered every measured request
  // with words. Reading silence as success marks the contact sent, so it is never retried
  // and never arrives; reading it as failure costs one repeat that earns a "Dupe".
  for (const body of ["", "   ", "\n"]) {
    const v = classifyClubLogReply(200, body);
    check(`${JSON.stringify(body)} -> failure`, !v.ok, v);
  }
  check(
    "and says so rather than reporting an empty message",
    classifyClubLogReply(200, "").detail.length > 0,
  );
}

console.log("");
console.log("7. other transport failures are reported verbatim");
{
  const v = classifyClubLogReply(500, "Internal Server Error");
  check("a 500 is a failure", !v.ok, v);
  check("carrying the status", /500/.test(v.detail), v.detail);
  const t = classifyClubLogReply(429, "Too Many Requests");
  check("a 429 is a failure", !t.ok, t);
  check("and is not blamed on the API key", !/api key/i.test(t.detail), t.detail);
}

console.log("");
console.log("8. no reply is ever both accepted and refused");
{
  const cases: [number, string][] = [
    [200, "OK"],
    [200, "Dupe"],
    [200, ""],
    [200, "Error"],
    [403, NGINX_403],
    [500, "boom"],
  ];
  for (const [status, body] of cases) {
    const v = classifyClubLogReply(status, body);
    const label = `${status} ${JSON.stringify(body.slice(0, 12))}`;
    // A duplicate is a KIND of success. Anything flagged duplicate while not ok would
    // leave the row unsent and re-send it, which is the fault section 2 exists to stop.
    check(`${label}: duplicate implies ok`, !v.duplicate || v.ok, v);
    check(`${label}: has a detail`, v.detail.length > 0, v);
  }
}

console.log("");
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");

/* eslint-disable no-console */
// The signed QSL card link.
//
// Winlink recipients get a link instead of the image, because the message travels over an
// HF radio link and a 200 kB attachment there is antisocial. The token matters: without a
// signature the URL would be /api/qsl/card/<id>, and contact ids could be walked.

import { cardToken, cardTokenValid, cardUrl } from "@/lib/qsl/card-link";

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

process.env.SETTINGS_KEY = process.env.SETTINGS_KEY ?? "test-key-for-card-links";

console.log("the card token");
{
  const a = cardToken("clx123");
  ok(a.length >= 16, `long enough not to be guessed (${a.length} chars)`);
  ok(cardToken("clx123") === a, "stable for one contact");
  ok(cardToken("clx124") !== a, "and different for the next id along");
  ok(cardTokenValid("clx123", a), "a real token validates");
  // The point of signing: one contact's link must not open another's.
  ok(!cardTokenValid("clx124", a), "one contact's token does not open another's card");
  ok(!cardTokenValid("clx123", ""), "an empty token is refused");
  ok(!cardTokenValid("clx123", "x".repeat(32)), "and a forgery of the right length");
  // Mail clients break long links across lines; a truncated token must fail, not throw.
  ok(!cardTokenValid("clx123", a.slice(0, 20)), "a truncated link fails cleanly");
}

console.log("\nthe link");
{
  const u = cardUrl("https://shack.example.com", "clx123");
  ok(u.startsWith("https://shack.example.com/api/qsl/card/"), "points at the endpoint");
  ok(u.includes("clx123"), "carries the contact id");
  ok(u.includes(`t=${cardToken("clx123")}`), "and the matching token");
  // A trailing slash on the configured base must not produce a double slash: some mail
  // clients refuse to linkify one, which would break the only way to see the card.
  ok(
    !cardUrl("https://shack.example.com/", "clx123").includes("com//"),
    "a trailing slash on the base URL is tolerated",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

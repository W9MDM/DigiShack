/* eslint-disable no-console */
// Addresses that are not ordinary mailboxes.
//
// Every assertion here is a claim about someone else's mail system, and each failure
// mode is silent from our side: our own SMTP server accepts the message and it
// disappears on the second hop. That is the argument for testing it offline.

import {
  detectGateway,
  isPlaceholderAddress,
  prepareForGateway,
  resolvePlaceholderAddress,
  rulesFor,
  withWl2kPrefix,
  WL2K_PREFIX,
} from "@/lib/qsl/gateways";

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
  ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

console.log("\nrecognising the gateways");
{
  eq(detectGateway("k9xyz@winlink.org"), "winlink", "winlink.org");
  eq(detectGateway("K9XYZ@Winlink.ORG"), "winlink", "case does not matter");
  eq(detectGateway("k9xyz@arrl.net"), "arrl", "arrl.net");
  eq(detectGateway("k9xyz@gmail.com"), null, "an ordinary mailbox is not a gateway");
  eq(detectGateway(""), null, "empty");
  eq(detectGateway(null), null, "null");
  eq(detectGateway("not-an-address"), null, "no domain at all");
  // The check is on the domain, not a substring: a lookalike must not inherit
  // Winlink's rules, and more importantly must not get //WL2K in its subject.
  eq(detectGateway("a@notwinlink.org"), null, "a lookalike domain is NOT winlink");
  eq(detectGateway("a@winlink.org.example.com"), null, "nor is a domain merely containing it");
  eq(detectGateway("a@mail.winlink.org"), "winlink", "but a real subdomain is");
}

console.log("\nwinlink: the //WL2K key, which is the difference between arriving and bouncing");
{
  const r = rulesFor("k9xyz@winlink.org");
  ok(r.plainTextOnly, "plain text only — it is carried over radio");
  ok(r.dropCard, "and no card attachment");
  ok(r.notes.length > 0, "with a reason the operator can read");

  eq(withWl2kPrefix("QSL de K9XYZ"), `${WL2K_PREFIX}QSL de K9XYZ`, "the key is prefixed");

  // Idempotence matters: subjects are STORED on the queue, and re-queuing a row
  // must not build up //WL2K R///WL2K R/...
  const once = withWl2kPrefix("QSL de K9XYZ");
  eq(withWl2kPrefix(once), once, "prefixing twice changes nothing");
  eq(
    withWl2kPrefix(`${WL2K_PREFIX}QSL`),
    `${WL2K_PREFIX}QSL`,
    "an already-keyed subject is left alone",
  );
  // Any precedence letter counts as already keyed — an operator who deliberately
  // marked something Priority must not have it downgraded to Routine.
  eq(withWl2kPrefix("//WL2K P/Urgent"), "//WL2K P/Urgent", "an existing precedence is respected");
  eq(withWl2kPrefix("Re://WL2K R/QSL"), "Re://WL2K R/QSL", "including on a reply");
}

console.log("\narrl.net: a forwarder, not a mailbox");
{
  const r = rulesFor("k9xyz@arrl.net");
  ok(r.plainTextOnly, "plain text, to survive the relay's filtering");
  // THE CARD GOES TO arrl.net. This used to assert the opposite, on the theory that an
  // attachment through a forwarder would be filtered. Measured in practice it is not -
  // members receive the image - and dropping it meant sending a QSL email with no QSL in
  // it to a large fraction of US operators. Plain text is a separate question and stands.
  ok(!r.dropCard, "the card is attached: arrl.net members do receive it");
  ok(r.notes.some((n) => /SPF|DKIM|relay/i.test(n)), "the note names the actual mechanism");

  // The two gateways now differ, which is the whole point; a future edit could quietly
  // collapse them back together.
  const w2 = rulesFor("k1abc@winlink.org");
  ok(w2.dropCard && !r.dropCard, "Winlink loses the card, arrl.net keeps it");

  // The //WL2K key is Winlink's alone. Putting it on anything else is nonsense in
  // the subject line of a stranger's inbox.
  const p = prepareForGateway({ address: "k9xyz@arrl.net", subject: "QSL", callsign: "K9XYZ" });
  eq(p.subject, "QSL", "arrl.net does NOT get the //WL2K key");
}

console.log("\nordinary mailboxes are untouched");
{
  const p = prepareForGateway({ address: "someone@gmail.com", subject: "QSL", callsign: "K1ABC" });
  eq(p.subject, "QSL", "subject unchanged");
  eq(p.address, "someone@gmail.com", "address unchanged");
  ok(!p.plainTextOnly, "HTML still sent");
  ok(!p.dropCard, "card still attached");
  ok(p.gateway === null, "and no gateway reported");
}

console.log("\nplaceholder addresses — the wia.org.au bounce");
{
  // The real one: "Your message to mycall@wia.org.au couldn't be delivered.
  //                mycall wasn't found at wia.org.au."
  const f = resolvePlaceholderAddress("mycall@wia.org.au", "VK2ABC");
  eq(f.address, "vk2abc@wia.org.au", "mycall@ becomes THEIR callsign");
  ok(f.substituted, "and is reported as substituted");
  ok(!f.unresolved, "and is resolved");

  eq(resolvePlaceholderAddress("MyCall@wia.org.au", "VK2ABC").address, "vk2abc@wia.org.au", "case-insensitive");
  eq(resolvePlaceholderAddress("<mycall>@wia.org.au", "VK2ABC").address, "vk2abc@wia.org.au", "angle brackets tolerated");
  eq(resolvePlaceholderAddress("[mycall]@wia.org.au", "VK2ABC").address, "vk2abc@wia.org.au", "square brackets too");
  eq(resolvePlaceholderAddress("mycallsign@x.org", "VK2ABC").address, "vk2abc@x.org", "mycallsign");
  eq(resolvePlaceholderAddress("callsign@x.org", "VK2ABC").address, "vk2abc@x.org", "callsign");
  eq(resolvePlaceholderAddress("my_call@x.org", "VK2ABC").address, "vk2abc@x.org", "my_call");

  // Must not touch real mailboxes.
  const real = resolvePlaceholderAddress("matt@example.com", "VK2ABC");
  eq(real.address, "matt@example.com", "a real local part is left alone");
  ok(!real.substituted, "and not reported as substituted");
  // "call@" is a working mailbox at plenty of companies; substituting would
  // capture a real address and send a stranger someone else's QSL.
  eq(resolvePlaceholderAddress("call@example.com", "VK2ABC").address, "call@example.com", "a bare 'call' is NOT a placeholder");
}

console.log("\nportable callsigns in a placeholder");
{
  eq(
    resolvePlaceholderAddress("mycall@x.org", "VE2/F4MUZ").address,
    "f4muz@x.org",
    "a prefixed call substitutes the operator's own call, not the prefix",
  );
  eq(
    resolvePlaceholderAddress("mycall@x.org", "K9XYZ/P").address,
    "k9xyz@x.org",
    "a /P suffix is dropped",
  );

  // When it cannot be reduced to something addressable, refuse rather than send to
  // a literal "mycall@" — that is a guaranteed bounce against our own reputation.
  const bad = resolvePlaceholderAddress("mycall@x.org", "???");
  ok(!bad.substituted, "an unusable callsign does not substitute");
  ok(bad.unresolved, "and is flagged unresolved so the send is held");
  eq(bad.address, "mycall@x.org", "leaving the address as it was, for the operator to see");
}

console.log("\nspotting rows queued before any of this existed");
{
  ok(isPlaceholderAddress("mycall@wia.org.au"), "a stored placeholder is recognisable");
  ok(isPlaceholderAddress("<MyCall>@wia.org.au"), "however it was typeset");
  ok(!isPlaceholderAddress("k9xyz@wia.org.au"), "a resolved one is not");
  ok(!isPlaceholderAddress("matt@example.com"), "nor is an ordinary address");
}

console.log("\nend to end");
{
  const w = prepareForGateway({
    address: "mycall@winlink.org",
    subject: "QSL de K9XYZ",
    callsign: "K1ABC",
  });
  eq(w.address, "k1abc@winlink.org", "placeholder resolved first...");
  eq(w.subject, `${WL2K_PREFIX}QSL de K9XYZ`, "...then the gateway rules applied to it");
  ok(w.plainTextOnly && w.dropCard, "and the transport rules come with it");
  eq(w.gateway, "winlink", "reported for the UI");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

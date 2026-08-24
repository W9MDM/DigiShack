// Which decodes belong to a contact.
//
// The rule matters more than it looks. Attaching the wrong decodes to a contact writes a
// false record of what was said, and the retention sweep keeps whatever is attached — so a
// mistake here is preserved deliberately, past the cutoff, forever.

import { LINK_MARGIN_MS, linkWindow, mentionsCall, sentByEither } from "@/lib/digital/decode-link";
import { parseMessage } from "@/lib/digital/qso";

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

/** The same sender reader the live path and the backfill both use. */
function senderOf(message: string): string | null {
  const p = parseMessage(message);
  return p.kind === "cq" || p.kind === "directed" ? p.from : null;
}

console.log("\na callsign matches as a whole token");
{
  ok(mentionsCall("K9XYZ K1ABC -12", "K1ABC"), "the sender");
  ok(mentionsCall("K1ABC K9XYZ EN61", "K1ABC"), "the addressee");
  ok(mentionsCall("CQ K1ABC FN42", "K1ABC"), "a CQ");
  ok(mentionsCall("cq k1abc fn42", "k1abc"), "case does not matter");

  // The whole point. A substring test attaches K1ABC's decodes to a contact with K1AB,
  // and the wrong callsign on a contact is the one error that cannot be recovered.
  ok(!mentionsCall("CQ K1ABC FN42", "K1AB"), "K1AB does not match inside K1ABC");
  ok(!mentionsCall("CQ K1AB FN42", "K1ABC"), "and not the other way round either");
  ok(mentionsCall("K9XYZ VE3ABC/P -05", "VE3ABC/P"), "a portable suffix is part of the call");
  ok(!mentionsCall("K9XYZ VE3ABC -05", "VE3ABC/P"), "and is not optional");
  ok(!mentionsCall("CQ K1ABC FN42", ""), "an empty callsign matches nothing");
}

console.log("\nwhat belongs to the contact is what the two stations SENT");
{
  const THEM = "II1ABC";
  const ME = "K9XYZ";

  // The case that made this rule exist, found by reading a rebuilt transcript.
  ok(
    !sentByEither("II1ABC W2ABC -07", senderOf, THEM, ME),
    "a third station calling ours is a different conversation",
  );
  ok(
    sentByEither("W2ABC II1ABC R-16", senderOf, THEM, ME),
    "but ours answering somebody else belongs in the transcript",
  );
  ok(sentByEither("K9XYZ II1ABC -12", senderOf, THEM, ME), "them working us, obviously");
  ok(sentByEither("CQ II1ABC JN55", senderOf, THEM, ME), "and the CQ that started it");

  // Our own transmissions, which only ever appear as decodes on a radio that hears
  // itself — the Icom did until 1.27.0, and those decodes are genuinely ours.
  ok(sentByEither("II1ABC K9XYZ EN61", senderOf, THEM, ME), "our own transmission counts");

  // Two stations, neither of them in this contact.
  ok(!sentByEither("K7XYZ K9ABC -03", senderOf, THEM, ME), "an unrelated exchange does not");

  // A message whose sender cannot be read is not attributed to anyone. Guessing would put
  // words in a station's mouth, in a record kept past the retention cutoff.
  ok(!sentByEither("TU 73 GL", senderOf, THEM, ME), "free text is attributed to nobody");
  ok(!sentByEither("", senderOf, THEM, ME), "and neither is an empty message");
}

console.log("\nthe window around a contact");
{
  const T = Date.parse("2026-08-03T04:08:00Z");
  const w = linkWindow({ startTime: new Date(T), endTime: new Date(T + 120_000) });
  eq(w.from.getTime(), T - LINK_MARGIN_MS, "reaches back a period before the contact");
  eq(w.to.getTime(), T + 120_000 + LINK_MARGIN_MS, "and a period past the end of it");

  // A margin, not a guess: the CQ that caused the contact is decoded before the contact's
  // own start time, and it is part of the exchange as an operator would describe it.
  ok(LINK_MARGIN_MS >= 15_000, "at least one FT8 period wide", `${LINK_MARGIN_MS}ms`);

  // An in-progress contact has no end. Measuring from its start is all there is, and is
  // right: nothing has happened after it yet.
  const open = linkWindow({ startTime: new Date(T), endTime: null });
  eq(open.to.getTime(), T + LINK_MARGIN_MS, "a contact with no end time measures from its start");
  eq(open.from.getTime(), T - LINK_MARGIN_MS, "with the same margin before it");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

/* eslint-disable no-console */
// Checks what a chat message is allowed to become.
// Run: npm run check:youtube-chat
//
// WHY THIS IS THE MOST CAREFULLY ASSERTED PARSER IN THE PROJECT. Every other input comes
// off the air: thirteen characters, a fixed alphabet, produced by a codec. A chat message is
// arbitrary text typed by anyone on the internet, and what it is being turned into is a
// station this transmitter might be pointed at.
//
// The requirement was "people can comment what band they are on or their callsign and i will
// go hunt them" — so this produces REQUESTS for an operator to look at, and calls nobody.
// These assertions are about the two ways that can go wrong: turning ordinary chat into a
// callsign, and failing to recognise a real one.
//
// Of the two, the FIRST is worse. A missed request costs one contact. A word promoted to a
// callsign puts something on the operator's screen labelled as a station, and the operator
// asked for that list precisely so they could act on it.

import { parseChatRequest, mergeRequests, nextPollDelay } from "../lib/integrations/youtube-chat";

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

const AT = 1_800_000_000_000;
const call = (t: string) => parseChatRequest(t, "viewer", AT)?.callsign ?? null;
const band = (t: string) => parseChatRequest(t, "viewer", AT)?.band ?? null;

console.log("a real request is understood");
{
  eq(call("W1AW"), "W1AW", "a bare callsign");
  eq(call("w1aw on 20m"), "W1AW", "lower case, with a band");
  eq(band("w1aw on 20m"), "20M", "and the band comes with it");
  eq(band("W1AW 20"), "20M", "a bare number is a band");
  eq(band("W1AW on 40 meters"), "40M", "so is one with the word after it");
  eq(call("Hi! W1AW here, calling on 15M"), "W1AW", "inside a sentence");
  eq(band("Hi! W1AW here, calling on 15M"), "15M", "with its band");
  eq(call("K5MGY/P"), "K5MGY/P", "a portable suffix survives");
  eq(call("VK9/W1ABC"), "VK9/W1ABC", "and a prefix");
  eq(call("W1AW!"), "W1AW", "punctuation does not hide it");
  eq(call("(W1AW)"), "W1AW", "nor do brackets");
  eq(band("W1AW"), null, "no band given is null, not a guess");
}

console.log("");
console.log("ORDINARY CHAT IS NOT A CALLSIGN — the half that matters most");
{
  // Everything here is real chat. Any one of them appearing as a "request" would put a
  // word on the operator's screen labelled as a station worth calling.
  for (const t of [
    "hello",
    "great stream!",
    "GOOD MORNING",
    "what antenna are you using",
    "73",
    "RR73",
    "CQ",
    "wow",
    "how many QSOs today",
    "nice waterfall",
    "SCOTLAND",
    "hello from Texas",
    "first",
    "20m is open here",
    "the band sounds busy",
  ]) {
    ok(call(t) === null, `"${t}" is not a callsign`, call(t));
  }

  // A DIGIT ALONE IS NOT ENOUGH, which is the rule that keeps most of the above out.
  ok(call("COVID19") === null, "a word with a trailing number is not a callsign", call("COVID19"));
  ok(call("2026") === null, "a year is not a callsign");
  ok(call("100") === null, "nor a number");
  ok(call("HELLO123") === null, "nor a word with digits appended", call("HELLO123"));
}

console.log("");
console.log("rubbish in, nothing out");
{
  ok(parseChatRequest("", "v", AT) === null, "an empty message");
  ok(parseChatRequest("   ", "v", AT) === null, "whitespace");
  ok(parseChatRequest("!!!???", "v", AT) === null, "punctuation only");
  // A very long message is somebody pasting, not asking to be worked, and scanning it is
  // work done on behalf of whoever sent it.
  ok(parseChatRequest("W1AW ".repeat(300), "v", AT) === null, "an absurdly long message");

  // ONE REQUEST PER MESSAGE, the first callsign. A message naming several is somebody
  // talking about a pile-up, and four requests from it is how a screen fills with noise.
  eq(call("W1AW K5MGY N0WOK"), "W1AW", "several callsigns yield only the first");

  // The author's name is carried but bounded — it is displayed, and it is also attacker
  // controlled.
  const long = parseChatRequest("W1AW", "x".repeat(200), AT);
  ok((long?.from.length ?? 0) <= 40, "a long display name is truncated", long?.from.length);
  const spill = parseChatRequest("W1AW " + "y".repeat(400), "v", AT);
  ok((spill?.text.length ?? 0) <= 200, "and so is the message kept for display", spill?.text.length);
}

console.log("");
console.log("the list stays short and current");
{
  const r = (c: string, at: number) => ({ callsign: c, band: null, from: "v", at, text: c });

  // NEWEST WINS PER CALLSIGN. People repeat themselves when nothing appears to happen, and
  // that should occupy one line rather than five.
  const merged = mergeRequests([r("W1AW", AT)], [r("W1AW", AT + 1000)], { now: AT + 2000 });
  eq(merged.length, 1, "a repeated callsign is one entry");
  eq(merged[0]?.at, AT + 1000, "and it is the newest one");

  // EXPIRED REQUESTS LEAVE. A callsign asked for an hour ago is not on the air now, and a
  // stale list invites calling somebody who has gone.
  const old = mergeRequests([r("OLD", AT)], [], { now: AT + 31 * 60_000 });
  eq(old.length, 0, "a request older than the window is dropped");
  const fresh = mergeRequests([r("NEW", AT)], [], { now: AT + 29 * 60_000 });
  eq(fresh.length, 1, "one inside it is kept");

  // Capped, so a busy chat cannot push the rest of the overlay off the frame.
  const many = Array.from({ length: 50 }, (_, i) => r(`W${i}AAA`, AT + i));
  const capped = mergeRequests([], many, { now: AT + 100 });
  ok(capped.length <= 8, `fifty requests become at most eight (${capped.length})`);
  eq(capped[0]?.callsign, "W49AAA", "and the newest survive, not the oldest");
}

console.log("");
console.log("polling respects BOTH limits");
{
  // YouTube asks for an interval; following it exactly would exhaust a default daily quota
  // long before an operating day ended. The LONGER of the two wins, so YouTube's floor is
  // respected and the operator's setting is what actually paces it.
  eq(nextPollDelay(5_000, 30), 30_000, "our slower interval wins over YouTube's suggestion");
  eq(nextPollDelay(60_000, 30), 60_000, "but a slower suggestion from YouTube is obeyed");
  eq(nextPollDelay(null, 30), 30_000, "no suggestion falls back to ours");
  // A setting of zero must not become a hot loop against a quota.
  eq(nextPollDelay(null, 0), 5_000, "a zero interval is floored, not honoured");
  eq(nextPollDelay(null, -10), 5_000, "and so is a negative one");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all YouTube chat assertions passed");

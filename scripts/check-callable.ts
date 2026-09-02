/* eslint-disable no-console */
// Checks which decoded messages the hunt may call.
// Run: npm run check:callable
//
// THIS DECIDES WHAT KEYS A TRANSMITTER, so it is asserted before it is wired to one.
//
// The request: "somewhere on the digital page need a treat rrr rr73 73 as cq checkbox".
// A station that has just sent RR73 is finished — free, still warm, and everyone else is
// waiting for their next CQ. It is the best moment on the band to call them.
//
// THE HAZARD IS THE OTHER HALF OF THE SAME MESSAGE SHAPE. "KO4OIG N5MIG/P -05" is also
// directed at a third party, and that station is committed for several windows and is not
// listening. Calling then is doubling on somebody else's contact — which would trade the
// rudeness this feature fixes for a worse one.
//
// The distinction was already written down, at lib/digital/qso.ts:571, for a different
// question:
//
//     // A CLOSING TOKEN FREES THEM. `KO4OIG N5MIG/P RR73` ends their exchange, so this
//     // is the best possible moment to be calling rather than a reason to stop.
//
// So both directions are pinned here: every closing token admits, and every mid-exchange
// payload the parser can produce is refused. The refusals matter more than the admissions —
// a missed contact costs one QSO, and doubling on a stranger's exchange costs the station's
// manners on a band where everyone can hear it.

import { callableFromMessage } from "../lib/digital/callable";
import { parseMessage } from "../lib/digital/qso";

const ME = "K9XYZ";
const ON = { myCall: ME, treatClosingAsCallable: true };
const OFF = { myCall: ME, treatClosingAsCallable: false };

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

function callable(msg: string, opts: typeof ON): boolean {
  return callableFromMessage(msg, opts).callable;
}
function why(msg: string, opts: typeof ON): string {
  const v = callableFromMessage(msg, opts);
  return v.callable ? `callable via ${v.via}` : v.reason;
}

console.log("OFF is the default, and off means exactly what it did before");
{
  // The switch must be inert when off, or it changes the station's behaviour for operators
  // who never asked for it. Every non-CQ shape stays refused.
  ok(callable("CQ K1ABC FN42", OFF), "a CQ is callable, as always");
  ok(callable("CQ DX K1ABC FN42", OFF), "so is a modified CQ");
  for (const m of [
    "KO4OIG N5MIG RR73",
    "KO4OIG N5MIG RRR",
    "KO4OIG N5MIG 73",
    "KO4OIG N5MIG -05",
    "KO4OIG N5MIG R-05",
    "KO4OIG N5MIG FN42",
  ]) {
    ok(!callable(m, OFF), `"${m}" is refused with the switch off`, why(m, OFF));
  }
}

console.log("\nON: a closing token frees them, and that is the whole point");
{
  // The three tokens that end an exchange. `rrr` is included because it ends the older
  // sequence and a station sending it is as free as one sending RR73.
  for (const m of ["KO4OIG N5MIG RR73", "KO4OIG N5MIG RRR", "KO4OIG N5MIG 73"]) {
    ok(callable(m, ON), `"${m}" is callable — they have just finished`, why(m, ON));
  }
  // Compound and portable callsigns, which is where a naive token index goes wrong.
  ok(callable("KO4OIG N5MIG/P RR73", ON), "a portable sender is callable");
  ok(callable("KO4OIG/QRP N5MIG RR73", ON), "so is a closing to a portable station");
  ok(callable("VK9/W1ABC K1XYZ 73", ON), "and a compound prefix");
}

console.log("\nON: MID-EXCHANGE IS STILL REFUSED — the half that must not break");
{
  // Every payload type the parser can produce that is NOT a closing token. If a future
  // payload is added to DirectedPayload and not considered here, the exhaustiveness check
  // at the bottom of this section fails.
  const midExchange = [
    ["KO4OIG N5MIG FN42", "grid"],
    ["KO4OIG N5MIG -05", "report"],
    ["KO4OIG N5MIG +00", "report at zero"],
    ["KO4OIG N5MIG R-05", "rreport"],
    ["KO4OIG N5MIG R FN42", "rgrid, the contest form"],
    ["KO4OIG N5MIG R 2B EMA", "rexchange, Field Day"],
    ["KO4OIG N5MIG R 579 WI", "rexchange, RTTY Roundup"],
  ] as const;
  for (const [m, label] of midExchange) {
    ok(!callable(m, ON), `${label}: "${m}" is REFUSED — they are working somebody else`, why(m, ON));
    ok(
      why(m, ON).startsWith("mid-exchange with"),
      `and the reason names the station they are working`,
      why(m, ON),
    );
  }

  // EXHAUSTIVENESS. Every payload type the parser produces is either asserted callable
  // above or asserted refused here. A new DirectedPayload variant that nobody classified
  // would otherwise default to refused silently — which is the safe direction, but silently
  // safe is how a feature quietly stops working.
  const seen = new Set<string>();
  for (const m of [
    "KO4OIG N5MIG RR73",
    "KO4OIG N5MIG RRR",
    "KO4OIG N5MIG 73",
    "KO4OIG N5MIG FN42",
    "KO4OIG N5MIG -05",
    "KO4OIG N5MIG R-05",
    "KO4OIG N5MIG R FN42",
    "KO4OIG N5MIG R 2B EMA",
  ]) {
    const p = parseMessage(m);
    if (p.kind === "directed") seen.add(p.payload.type);
  }
  const EXPECTED = ["rr73", "rrr", "73", "grid", "report", "rreport", "rgrid", "rexchange"];
  for (const t of EXPECTED) {
    ok(seen.has(t), `the fixtures above actually exercise payload type "${t}"`, [...seen]);
  }
}

console.log("\nON: our own transmissions and our own contact closing");
{
  // A decoder hears its own transmission on a shared receiver or from a loud neighbour.
  ok(!callable(`CQ ${ME} EN61`, ON), "our own CQ is not an invitation to ourselves");
  ok(!callable(`K1ABC ${ME} RR73`, ON), "and neither is our own sign-off");
  ok(
    why(`K1ABC ${ME} RR73`, ON) === "our own transmission",
    "named as ours, not as mid-exchange",
    why(`K1ABC ${ME} RR73`, ON),
  );

  // THEIR sign-off TO US is our own contact ending. The sequencer is already handling it;
  // treating it as an invitation would queue up the station we just worked, which the dupe
  // guard would refuse — but only after spending a window on it.
  ok(!callable(`${ME} K1ABC RR73`, ON), "their RR73 to US is our contact closing, not a lead");
  ok(!callable(`${ME} K1ABC 73`, ON), "same for a bare 73 to us");
  ok(
    why(`${ME} K1ABC RR73`, ON).includes("our own contact"),
    "and the reason says so",
    why(`${ME} K1ABC RR73`, ON),
  );
  // Case must not let it through.
  ok(!callable(`${ME.toLowerCase()} k1abc rr73`, ON), "lower case does not evade either check");
}

console.log("\nrubbish in, refusal out");
{
  for (const m of ["", "   ", "?", "TU 73 GL", "K1ABC"]) {
    ok(!callable(m, ON), `"${m}" is not callable`, why(m, ON));
  }
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all callable assertions passed");

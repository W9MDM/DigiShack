/* eslint-disable no-console */
// JS8 automatic replies: what gets answered, what does not, and that each answer builds
// into frames the message layer can send.

import { js8BuildFrames, js8ParseFrame } from "@/lib/digital/js8-message";
import { Js8AutoReplier, type Js8Heard } from "@/lib/radio/js8-autoreply";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(got: T, want: T, label: string): void {
  ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const hb = (from: string, snr: number, grid = "FN31"): Js8Heard => ({ kind: "heartbeat", from, grid, isCq: false, snr });
const cq = (from: string, snr: number): Js8Heard => ({ kind: "heartbeat", from, grid: "FN31", isCq: true, snr });
const directed = (from: string, to: string, cmdString: string, snr: number): Js8Heard => ({ kind: "directed", from, to, cmdString, snr });

async function main(): Promise<void> {
  let clock = 1_000_000;
  const make = (level: "off" | "hb" | "all") =>
    new Js8AutoReplier({ level, mycall: "K9XYZ", mygrid: "EN61AA", info: "DigiShack on a FLEX-6400", now: () => clock });

  console.log("\noff");
  eq(make("off").repliesFor([hb("KK4COV", -6)]).length, 0, "off answers nothing");

  console.log("\nheartbeat acknowledgements");
  {
    const r = make("hb");
    eq(r.repliesFor([hb("KK4COV", -6)]).join("|"), "KK4COV HEARTBEAT SNR -06", "a heartbeat is acknowledged with the report, as the air does it");
    eq(r.repliesFor([hb("KK4COV", -6)]).length, 0, "and not again inside the cooldown");
    clock += 16 * 60_000;
    eq(r.repliesFor([hb("KK4COV", +3)]).join("|"), "KK4COV HEARTBEAT SNR +03", "after the cooldown it is, with the new report");
    eq(r.repliesFor([cq("N6GRG", -10)]).length, 0, "a CQ is not a heartbeat and gets no acknowledgement");
    eq(r.repliesFor([hb("@HB", -10)]).length, 0, "a group is not a station");
    eq(r.repliesFor([hb("K9XYZ", -1)]).length, 0, "our own heartbeat is not answered");
    eq(r.repliesFor([hb("k9xyz", -1)]).length, 0, "in any case");
    const two = r.repliesFor([hb("N0GES", -18), hb("WD4U", -4), hb("N0GES", -17)]);
    eq(two.join("|"), "N0GES HEARTBEAT SNR -18|WD4U HEARTBEAT SNR -04", "several stations in a window each get one line, in the order heard");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " SNR?", -11)]).length, 0, "at hb level a query to us is left for the operator");
  }

  console.log("\ndirected queries at level all");
  {
    const r = make("all");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " SNR?", -11)]).join("|"), "KE4ZDJ SNR -11", "SNR? gets the report");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " GRID?", -11)]).join("|"), "KE4ZDJ GRID EN61", "GRID? gets the four-character grid");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " INFO?", -11)]).join("|"), "KE4ZDJ INFO DigiShack on a FLEX-6400", "INFO? gets the info line");
    eq(r.repliesFor([directed("KE4ZDJ", "k9xyz", " SNR?", -11)]).length, 1, "the destination is matched in any case");
    eq(r.repliesFor([directed("KE4ZDJ", "KK4COV", " SNR?", -11)]).length, 0, "a query to someone else is not ours to answer");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " HEARING?", -11)]).length, 0, "HEARING? is not answered");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " QUERY MSGS", -11)]).length, 0, "nor QUERY MSGS");
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " 73", -11)]).length, 0, "nor 73");
    eq(r.repliesFor([directed("@ALLCALL", "K9XYZ", " SNR?", -11)]).length, 0, "a group cannot ask");
    r.configure({ info: "   " });
    eq(r.repliesFor([directed("KE4ZDJ", "K9XYZ", " INFO?", -11)]).length, 0, "no info configured, no INFO reply");
    r.configure({ level: "off" });
    eq(r.repliesFor([hb("KK4COV", -6)]).length, 0, "reconfigured off, nothing");
  }

  console.log("\nevery line builds into frames the message layer can send");
  {
    const r = make("all");
    const lines = [
      ...r.repliesFor([hb("KK4COV", -6)]),
      ...r.repliesFor([directed("KE4ZDJ", "K9XYZ", " SNR?", -11)]),
      ...r.repliesFor([directed("N0GES", "K9XYZ", " GRID?", 2)]),
      ...r.repliesFor([directed("WD4U", "K9XYZ", " INFO?", 2)]),
    ];
    eq(lines.length, 4, "four lines");
    const frames = lines.map((l) => js8BuildFrames("K9XYZ", "EN61AA", l));
    eq(frames[0]!.length, 1, "an acknowledgement is one directed frame");
    eq(js8ParseFrame(frames[0]![0]!.frame, frames[0]![0]!.txType).display, "K9XYZ: KK4COV HEARTBEAT SNR -06", "and prints as the air prints it");
    eq(frames[1]!.length, 1, "an SNR reply is one frame");
    eq(js8ParseFrame(frames[1]![0]!.frame, frames[1]![0]!.txType).display, "K9XYZ: KE4ZDJ SNR -11", "with the report");
    ok(frames[2]!.length >= 2, "a GRID reply is the directed frame and the grid as text", `${frames[2]!.length}`);
    eq(js8ParseFrame(frames[2]![0]!.frame, frames[2]![0]!.txType).display, "K9XYZ: N0GES GRID", "led by the GRID command");
    ok(frames[3]!.length >= 2, "an INFO reply is the directed frame and the text", `${frames[3]!.length}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

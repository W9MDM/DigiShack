/* eslint-disable no-console */
// Checks which directed CQs we are entitled to answer.
// Run: npm run check:cq-modifier
//
// THE FAULT. "CQ KH KD2TC" is a station calling HAWAII. Reported from a live station,
// which answered it twice from Indiana:
//
//     ▼ CQ KH KD2TC        52:30 -17
//     ▲ KD2TC W9ABC EN61    53:15
//     ▲ KD2TC W9ABC EN61    53:45
//
// The parser has captured the modifier since it was written and nothing read it except the
// POTA hunt, so every other directed CQ was answered as though it were a plain one. That
// is rude — the caller has said who they want — and it is futile, because they will not
// come back. Four transmit cycles per attempt, on a station that was never going to answer.
//
// THE OTHER HALF OF BEING RIGHT HERE is not refusing contacts we could have made. A rule
// that guesses "unknown word means restriction" would silently cost real QSOs, which is a
// worse failure and a harder one to notice. So the permissive cases are asserted as
// carefully as the refusals.

import { cqIsForUs } from "../lib/digital/cq-modifier";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

// The reporting station: Indiana, USA, ninth call area, DXCC 291, North America.
const US = { myCall: "W9ABC", myContinent: "NA", myDxcc: 291, theirDxcc: 291 };

function main(): void {
  console.log("1. THE REPORT: a prefix-directed CQ we do not match");
  {
    const v = cqIsForUs("KH", US);
    check("CQ KH is refused from a W9", !v.forUs, v);
    check("and the reason names both sides", /KH/.test(v.reason ?? "") && /W9ABC/.test(v.reason ?? ""), v.reason);
    // The same call FROM Hawaii would be answerable.
    check("but a KH6 station may answer it", cqIsForUs("KH", { ...US, myCall: "KH6ABC" }).forUs);
  }

  console.log("");
  console.log("2. other prefixes and call areas");
  {
    for (const m of ["JA", "VK", "ZL", "DL", "G"]) {
      check(`CQ ${m} is refused from a W9`, !cqIsForUs(m, US).forUs);
    }
    check("CQ W is answerable by a W9", cqIsForUs("W", US).forUs);
    check("CQ W9 is answerable by W9ABC", cqIsForUs("W9", US).forUs);
    check("CQ W1 is not", !cqIsForUs("W1", US).forUs);
    // A bare digit is a call area.
    check("CQ 9 is answerable by W9ABC", cqIsForUs("9", US).forUs);
    check("CQ 1 is not", !cqIsForUs("1", US).forUs);
  }

  console.log("");
  console.log("3. continents");
  {
    check("CQ NA is answerable from North America", cqIsForUs("NA", US).forUs);
    check("CQ EU is not", !cqIsForUs("EU", US).forUs);
    check("CQ AS is not", !cqIsForUs("AS", US).forUs);
    check("CQ OC is not", !cqIsForUs("OC", US).forUs);
    // Unknown continent must not become a refusal: a station we have not looked up would
    // otherwise look like a restriction it never carried.
    check(
      "an unknown continent answers rather than refusing",
      cqIsForUs("EU", { ...US, myContinent: null }).forUs,
    );
  }

  console.log("");
  console.log("4. CQ DX");
  {
    check(
      "refused when we are in the caller's own entity",
      !cqIsForUs("DX", { ...US, myDxcc: 291, theirDxcc: 291 }).forUs,
    );
    check(
      "answered when we are genuinely DX to them",
      cqIsForUs("DX", { ...US, myDxcc: 291, theirDxcc: 230 }).forUs,
    );
    // Missing data must not manufacture a restriction.
    check("answered when their entity is unknown", cqIsForUs("DX", { ...US, theirDxcc: null }).forUs);
    check("answered when ours is unknown", cqIsForUs("DX", { ...US, myDxcc: null }).forUs);
  }

  console.log("");
  console.log("5. ACTIVITIES ARE INVITATIONS, NOT RESTRICTIONS");
  {
    // "CQ POTA" means "I am in a park, call me" — the opposite of a filter, and answering
    // it is the entire point of the POTA hunt. Refusing these would break a shipped mode.
    for (const m of ["POTA", "SOTA", "IOTA", "WWFF", "FD", "TEST", "CONTEST", "QRP", "WW"]) {
      check(`CQ ${m} is answerable`, cqIsForUs(m, US).forUs);
    }
  }

  console.log("");
  console.log("6. a plain CQ, and anything we do not recognise");
  {
    check("no modifier at all is answerable", cqIsForUs(null, US).forUs);
    // THE DELIBERATE PERMISSIVENESS. Amateurs invent modifiers faster than anyone can
    // enumerate them, and a missed contact is worse than an occasional wasted call.
    for (const m of ["SKCC", "FISTS", "RAGCHEW", "NEWBIE", "BINGO"]) {
      check(`CQ ${m} is unrecognised and therefore answered`, cqIsForUs(m, US).forUs);
    }
  }

  console.log("");
  console.log("7. case does not matter");
  {
    check("cq kh is still refused", !cqIsForUs("kh", US).forUs);
    check("cq pota is still answered", cqIsForUs("pota", US).forUs);
    check("a lower-case continent still matches", cqIsForUs("na", US).forUs);
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
}

main();

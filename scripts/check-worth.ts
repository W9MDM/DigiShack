/* eslint-disable no-console */
// Offline checks for award-aware hunt scoring.

import {
  emptyWorkedIndex,
  rankCandidates,
  scoreCandidate,
  type Candidate,
} from "@/lib/digital/worth";

let pass = 0;
let fail = 0;
function eqArr(a: unknown[], b: unknown[], label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const dx = (adif: number, name: string, cqZone = 14, continent = "EU") => ({
  adif,
  name,
  cqZone,
  continent,
});

console.log("\nscoring");
{
  const worked = emptyWorkedIndex();
  worked.dxcc.add(291); // USA
  worked.dxccThisBand.add(291);
  worked.continents.add("NA");
  worked.cqZones.add(4);
  worked.grids.add("EM38");
  // "All-worked" has to mean all of it: worked on THIS band, and this callsign
  // worked before. A fixture that only says "EM38 somewhere, some time" describes a
  // station that still offers a band slot and a first contact, and the scoring is
  // right to say so.
  worked.gridsThisBand.add("EM38");
  worked.calls.add("K5ABC");

  const routine: Candidate = {
    call: "K5ABC",
    snr: 10,
    grid: "EM38",
    dxcc: dx(291, "United States", 4, "NA"),
  };
  const s1 = scoreCandidate(routine, worked);
  ok(s1.routine, "an all-worked station is routine", s1.reasons.join(","));

  const newEntity: Candidate = {
    call: "SP1ABC",
    snr: -18,
    grid: "JO80",
    dxcc: dx(269, "Poland", 15, "EU"),
  };
  const s2 = scoreCandidate(newEntity, worked);
  ok(!s2.routine, "a new entity is not routine");
  ok(
    s2.score > s1.score,
    "a weak new DXCC outranks a strong worked one",
    `${s2.score.toFixed(1)} vs ${s1.score.toFixed(1)}`,
  );
  ok(
    s2.reasons.some((r) => /NEW DXCC/.test(r)),
    "reason names the new entity",
    s2.reasons.join(","),
  );
  ok(
    s2.reasons.some((r) => /new continent EU/.test(r)),
    "new continent also credited",
  );

  // Same entity, new band slot only.
  const workedOtherBand = emptyWorkedIndex();
  workedOtherBand.dxcc.add(269);
  workedOtherBand.continents.add("EU");
  workedOtherBand.cqZones.add(15);
  const s3 = scoreCandidate(newEntity, workedOtherBand);
  ok(
    s3.reasons.some((r) => /new on this band/.test(r)),
    "band-slot newness credited when the entity is already worked",
  );
  ok(s3.score < s2.score, "a band slot is worth less than a new entity");
}

console.log("\nSNR as tiebreaker only");
{
  const worked = emptyWorkedIndex();
  const strong = scoreCandidate({ call: "A", snr: 10, grid: null, dxcc: dx(1, "X") }, worked);
  const weak = scoreCandidate({ call: "B", snr: -20, grid: null, dxcc: dx(1, "X") }, worked);
  ok(strong.score > weak.score, "stronger wins between identical stations");
  ok(strong.score - weak.score < 10, "but SNR cannot outweigh a real award", `${(strong.score - weak.score).toFixed(1)}`);
}

console.log("\nranking");
{
  const worked = emptyWorkedIndex();
  worked.dxcc.add(291);
  worked.dxccThisBand.add(291);
  worked.continents.add("NA");
  // Zone and grids must be populated too, or these "worked" stations still
  // offer a new WAZ zone / new grid and are correctly not routine.
  worked.cqZones.add(5);
  worked.grids.add("FN42");
  worked.grids.add("FN20");
  // Worked on THIS band too, not merely somewhere. Without these the fixture
  // describes a station that has never worked FN42/FN20 on the current band, and
  // "new on this band" is then the correct answer for the locals — which is what
  // this block is asserting they are NOT.
  worked.gridsThisBand.add("FN42");
  worked.gridsThisBand.add("FN20");
  // Both locals are already in the log; "never worked" is informational and does
  // not affect newOnly, but leaving them out would make the fixture describe two
  // strangers rather than the loud regulars it means to.
  worked.calls.add("K1LOUD");
  worked.calls.add("W2NEAR");

  const cands: Candidate[] = [
    { call: "K1LOUD", snr: 15, grid: "FN42", dxcc: dx(291, "United States", 5, "NA") },
    { call: "VK3DX", snr: -15, grid: "QF22", dxcc: dx(150, "Australia", 30, "OC") },
    { call: "W2NEAR", snr: 8, grid: "FN20", dxcc: dx(291, "United States", 5, "NA") },
  ];
  const ranked = rankCandidates(cands, worked);
  ok(ranked[0]!.call === "VK3DX", "new DX ranks above loud locals", ranked.map((r) => r.call).join(","));
  ok(ranked.length === 3, "nothing dropped by default");

  const newOnly = rankCandidates(cands, worked, { newOnly: true });
  ok(newOnly.length === 1 && newOnly[0]!.call === "VK3DX", "newOnly keeps just the new one");

  const floor = rankCandidates(cands, worked, { minSnr: 0 });
  ok(!floor.some((c) => c.call === "VK3DX"), "minSnr drops signals too weak to complete");

  // No DXCC data loaded at all: must still rank, on grid + SNR.
  const noData: Candidate[] = [
    { call: "A", snr: 0, grid: "AA00", dxcc: null },
    { call: "B", snr: 12, grid: "AA00", dxcc: null },
  ];
  const r2 = rankCandidates(noData, emptyWorkedIndex());
  ok(r2[0]!.call === "B", "without DXCC data it falls back to grid + signal");
}

console.log("\nthe axes a mature station still has open");
{
  // Why these exist: against 26,840 QSOs — 159 DXCC, all 7 continents, 39 zones,
  // WAS complete on 40 m AND 20 m — every axis the original scoring had was closed,
  // so a domestic band produced no badges at all. These are the ones still open.
  const worked = emptyWorkedIndex();
  worked.dxcc.add(291);
  worked.dxccThisBand.add(291);
  worked.continents.add("NA");
  worked.cqZones.add(5);
  worked.grids.add("EN61"); // worked, but on some OTHER band
  worked.states.add("IN");
  worked.calls.add("W9OLD");
  worked.parks.add("US-0001");

  const usa = dx(291, "United States", 5, "NA");

  // 1. Grid band slot — 448 of these were open on 40 m and scored as routine.
  const slot = scoreCandidate({ call: "W9OLD", snr: 5, grid: "EN61", dxcc: usa }, worked);
  ok(
    slot.reasons.some((r) => /EN61 new on this band/.test(r)),
    "a grid worked on another band is credited as a band slot",
    slot.reasons.join(","),
  );
  ok(!slot.routine, "and that counts as non-routine");

  worked.gridsThisBand.add("EN61");
  const noSlot = scoreCandidate({ call: "W9OLD", snr: 5, grid: "EN61", dxcc: usa }, worked);
  ok(noSlot.routine, "once worked on this band too, it is routine again", noSlot.reasons.join(","));

  // 2. Never worked — informational, and must NOT make a station non-routine, or
  //    auto.huntNewOnly silently stops filtering anything.
  const fresh = scoreCandidate({ call: "W9NEW", snr: 5, grid: "EN61", dxcc: usa }, worked);
  ok(fresh.reasons.includes("never worked"), "a callsign never worked says so");
  ok(fresh.routine, "but never-worked alone is still ROUTINE — newOnly must not keep it");
  ok(
    !scoreCandidate({ call: "W9OLD", snr: 5, grid: "EN61", dxcc: usa }, worked).reasons.includes(
      "never worked",
    ),
    "a callsign already worked does not",
  );

  // 3. Park — the axis that matters most for an operator running the POTA modes.
  const park = scoreCandidate(
    { call: "W9NEW", snr: 5, grid: "EN61", dxcc: usa, park: "US-4567" },
    worked,
  );
  ok(park.reasons.some((r) => /new park US-4567/.test(r)), "an unworked park is credited");
  ok(!park.routine, "and is an award reason, unlike never-worked");
  ok(
    scoreCandidate({ call: "W9NEW", snr: 5, grid: "EN61", dxcc: usa, park: "US-0001" }, worked)
      .reasons.every((r) => !/new park/.test(r)),
    "a park already worked is not",
  );

  // 4. State — the axis whose POINTS existed and whose scoring never ran.
  const st = scoreCandidate({ call: "W9NEW", snr: 5, grid: "EN61", dxcc: usa, state: "MT" }, worked);
  ok(st.reasons.some((r) => /new state MT/.test(r)), "a new state is credited at last");
  const stSlot = scoreCandidate(
    { call: "W9NEW", snr: 5, grid: "EN61", dxcc: usa, state: "IN" },
    worked,
  );
  ok(
    stSlot.reasons.some((r) => /IN new on this band/.test(r)),
    "a worked state still open on this band is a slot",
    stSlot.reasons.join(","),
  );

  // 5. What Auto Hunt actually calls first.
  //
  // The ORDER is the contract, not the individual point values — those can be
  // retuned, but a station never worked before must not lose to a loud dupe, and a
  // park must not lose to a local. Both were true before the tiers were fixed:
  // `neverWorked` was worth 2 against a signal tiebreaker worth up to 6.
  const loudDupe: Candidate = { call: "W9OLD", snr: 15, grid: "EN61", dxcc: usa };
  const weakNew: Candidate = { call: "W9NEW", snr: -18, grid: "EN61", dxcc: usa };
  const potaUnknown: Candidate = {
    call: "W9PARK",
    snr: -18,
    grid: "EN61",
    dxcc: usa,
    potaCq: true,
  };
  const order = rankCandidates([loudDupe, weakNew, potaUnknown], worked).map((r) => r.call);
  eqArr(
    order,
    ["W9PARK", "W9NEW", "W9OLD"],
    "a POTA activator, then someone never worked, then the loud regular",
  );

  // A park we can confirm is new outranks one we merely suspect.
  const potaKnownNew: Candidate = {
    call: "W9KNOWN",
    snr: -20,
    grid: "EN61",
    dxcc: usa,
    park: "US-9999",
    potaCq: true,
  };
  ok(
    scoreCandidate(potaKnownNew, worked).score > scoreCandidate(potaUnknown, worked).score,
    "a confirmed new park beats an unidentified activation",
  );
  // ...and one already worked is not boosted at all: we can SEE it is not new.
  const potaWorked: Candidate = {
    call: "W9DUPEPARK",
    snr: -20,
    grid: "EN61",
    dxcc: usa,
    park: "US-0001",
    potaCq: true,
  };
  ok(
    !scoreCandidate(potaWorked, worked).reasons.some((r) => /park|POTA/i.test(r)),
    "a park already worked earns no park credit",
    scoreCandidate(potaWorked, worked).reasons.join(","),
  );

  // Real awards still win. Prioritising new stations must not demote a new entity.
  const newEntityWorked: Candidate = {
    call: "W9OLD",
    snr: -20,
    grid: "EN61",
    dxcc: dx(24, "Bouvet", 38, "AF"),
  };
  ok(
    scoreCandidate(newEntityWorked, worked).score >
      scoreCandidate(potaUnknown, worked).score,
    "a new DXCC entity still outranks everything, even on a worked callsign",
  );

  // 6. Ordering — the row shows reasons[0], so the biggest must lead.
  const both = scoreCandidate(
    { call: "3Y0J", snr: -15, grid: "JJ99", dxcc: dx(24, "Bouvet", 38, "AF"), park: "NO-1234" },
    worked,
  );
  ok(/NEW DXCC/.test(both.reasons[0]!), "a new entity leads the reasons", both.reasons[0]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

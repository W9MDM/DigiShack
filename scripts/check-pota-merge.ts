/* eslint-disable no-console */
// Offline checks for merging POTA's logbook into an existing log.
//
// The failure mode this guards against is not a crash — it is a successful import
// that writes the wrong park onto real contacts. Afterwards a wrong reference is
// indistinguishable from a right one, and every "have I worked this park?" answer is
// quietly poisoned. So every rule that refuses to guess has a test, and so does
// every rule that decides it is safe to.

import {
  decide,
  groupRows,
  otherStation,
  planMerge,
  type LocalQso,
  type RemoteQso,
  type RemoteRow,
} from "@/lib/pota/merge";

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

const T = Date.UTC(2026, 6, 15, 14, 30, 0);
const min = (n: number) => n * 60_000;

const local = (over: Partial<LocalQso> = {}): LocalQso => ({
  id: "q1",
  callsign: "K1ABC",
  band: "20M",
  mode: "FT8",
  startTimeMs: T,
  refs: [],
  ...over,
});

const remote = (over: Partial<RemoteQso> = {}): RemoteQso => ({
  callsign: "K1ABC",
  band: "20M",
  mode: "FT8",
  timeMs: T,
  references: ["US-1689"],
  ...over,
});

console.log("\nthe ordinary case");
{
  const d = decide(remote(), [local()]);
  ok(d.outcome === "matched" && d.qsoId === "q1", "an exact match is taken", d.outcome);
}
{
  // Their clock, our clock, and where each side thinks the QSO started.
  const d = decide(remote({ timeMs: T + min(3) }), [local()]);
  ok(d.outcome === "matched", "three minutes apart still matches", d.outcome);
}
{
  const d = decide(remote({ timeMs: T + min(45) }), [local()]);
  ok(d.outcome === "missing", "forty-five minutes apart is a different contact", d.outcome);
}
{
  const d = decide(remote(), []);
  ok(d.outcome === "missing", "a contact we never logged is reported, not invented", d.outcome);
}

console.log("\nmode naming");
{
  // POTA takes the mode from the activator's ADIF. DATA and MFSK are what a lot of
  // loggers write for FT8 and FT4, and refusing those would drop most digital rows.
  const d = decide(remote({ mode: "DATA" }), [local({ mode: "FT8" })]);
  ok(d.outcome === "matched", "DATA matches an FT8 contact", d.outcome);
}
{
  const d = decide(remote({ mode: "MFSK" }), [local({ mode: "FT4" })]);
  ok(d.outcome === "matched", "MFSK matches an FT4 contact", d.outcome);
}
{
  // One candidate, and mode disagreeing is not enough to reject it — the naming is
  // too unreliable to be a hard filter.
  const d = decide(remote({ mode: "SSB" }), [local({ mode: "FT8" })]);
  ok(d.outcome === "matched", "a lone candidate survives a mode disagreement", d.outcome);
}
{
  // Two candidates: now mode earns its keep as a discriminator.
  const d = decide(remote({ mode: "CW" }), [
    local({ id: "ft8", mode: "FT8", startTimeMs: T }),
    local({ id: "cw", mode: "CW", startTimeMs: T + min(2) }),
  ]);
  ok(d.qsoId === "cw", "with two candidates, mode picks the right one", d.qsoId);
}

console.log("\nband");
{
  // Ordinary at a park: the activator works you on 20 m and again on 40 m minutes
  // later. Taking the wrong one attaches a correct park to the wrong contact, which
  // still corrupts every band-slot answer.
  const d = decide(remote({ band: "40M", timeMs: T + min(1) }), [
    local({ id: "twenty", band: "20M", startTimeMs: T }),
    local({ id: "forty", band: "40M", startTimeMs: T + min(4) }),
  ]);
  ok(d.qsoId === "forty", "band wins over being closer in time", d.qsoId);
}
{
  const d = decide(remote({ band: "40M" }), [local({ band: "20M" })]);
  ok(
    d.outcome === "ambiguous",
    "a band that matches nothing is refused, not forced",
    `${d.outcome} ${d.detail ?? ""}`,
  );
}
{
  const d = decide(remote({ band: null }), [local({ band: "20M" })]);
  ok(d.outcome === "matched", "no band from POTA is not a reason to refuse", d.outcome);
}

console.log("\nrefusing to guess");
{
  // The case the whole module exists for. Two contacts equally distant, nothing else
  // to separate them: one is wrong and there is no way to know which.
  const d = decide(remote(), [
    local({ id: "before", startTimeMs: T - min(5) }),
    local({ id: "after", startTimeMs: T + min(5) }),
  ]);
  ok(d.outcome === "ambiguous", "equally close is ambiguous", d.outcome);
  ok(d.candidateIds?.length === 2, "and both candidates are reported", String(d.candidateIds));
}
{
  const d = decide(remote(), [
    local({ id: "near", startTimeMs: T + min(1) }),
    local({ id: "far", startTimeMs: T + min(6) }),
  ]);
  ok(d.qsoId === "near", "a clear nearest is not ambiguous", d.qsoId);
}
{
  const d = decide(remote({ references: [] }), [local()]);
  ok(d.outcome === "unusable", "a contact with no park is unusable");
}
{
  const d = decide(remote({ timeMs: null }), [local()]);
  ok(d.outcome === "unusable", "a contact with no timestamp is unusable");
}

console.log("\nn-fers: one contact, several parks");
{
  // The case the first version got wrong. POTA sends one row per reference, so a
  // three-fer arrives as three rows differing only in the park.
  const rows: RemoteRow[] = [
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-0765" },
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-2258" },
  ];
  const grouped = groupRows(rows);
  ok(grouped.length === 1, "rows for one contact collapse into one", String(grouped.length));
  ok(
    grouped[0]?.references.join(",") === "US-0765,US-2258",
    "carrying both parks",
    grouped[0]?.references.join(","),
  );
}
{
  // Indiana Dunes: the national park and the state park inside it. A real pair from
  // this station's log, and both references are correct.
  const d = decide(remote({ references: ["US-0765", "US-2258"] }), [local()]);
  ok(d.outcome === "matched", "a two-fer matches", d.outcome);
  ok(d.adding?.length === 2, "and adds both parks", String(d.adding));
}
{
  const rows: RemoteRow[] = [
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-0765" },
    { callsign: "W9ABC", band: "40M", mode: "FT8", timeMs: T, reference: "US-2258" },
  ];
  ok(groupRows(rows).length === 2, "a different band is a different contact");
}
{
  const rows: RemoteRow[] = [
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-0765" },
    { callsign: "K1ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-2258" },
  ];
  ok(groupRows(rows).length === 2, "a different station is a different contact");
}
{
  // Mode is deliberately not part of the grouping key: rows for one contact come
  // from one ADIF record, so a stray difference must not split a real n-fer into two
  // contacts that then fight over the same QSO.
  const rows: RemoteRow[] = [
    { callsign: "W9ABC", band: "20M", mode: "DATA", timeMs: T, reference: "US-0765" },
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-2258" },
  ];
  ok(groupRows(rows).length === 1, "a mode difference does not split a contact");
}
{
  const rows: RemoteRow[] = [
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-0765" },
    { callsign: "W9ABC", band: "20M", mode: "FT8", timeMs: T, reference: "US-0765" },
  ];
  ok(
    groupRows(rows)[0]?.references.length === 1,
    "a repeated reference is not counted twice",
  );
}

console.log("\nmerging is additive, not replacement");
{
  const d = decide(remote(), [local({ refs: ["US-1689"] })]);
  ok(d.outcome === "already-set", "nothing new is a no-op", d.outcome);
}
{
  // We already knew one park of a two-fer and POTA is filling in the other. This is
  // the ordinary case for a contact made by the chase, which records the one park it
  // retuned for and cannot know about the park surrounding it.
  const d = decide(remote({ references: ["US-0765", "US-2258"] }), [
    local({ refs: ["US-0765"] }),
  ]);
  ok(d.outcome === "matched", "an overlapping set merges", d.outcome);
  ok(d.adding?.join(",") === "US-2258", "adding only what is missing", String(d.adding));
}
{
  // Completely disjoint: either the match is wrong or one of the records is. Not
  // something to merge quietly.
  const d = decide(remote({ references: ["US-1689"] }), [local({ refs: ["US-9999"] })]);
  ok(d.outcome === "conflict", "a disjoint set is a conflict", d.outcome);
  ok(
    d.existing?.join(",") === "US-9999",
    "and the log value is reported",
    String(d.existing),
  );
}
{
  const d = decide(remote({ references: ["US-1689"] }), [local({ refs: ["US-9999"] })], {
    overwrite: true,
  });
  ok(d.outcome === "matched", "which can be overridden deliberately");
  ok(
    d.adding?.join(",") === "US-1689",
    "and even then the existing park is kept, not replaced",
    String(d.adding),
  );
}

console.log("\nthe whole plan");
{
  const byCall = new Map<string, LocalQso[]>([
    ["K1ABC", [local({ id: "a" })]],
    ["W2XYZ", [local({ id: "b", callsign: "W2XYZ", startTimeMs: T + min(30) })]],
  ]);
  const plan = planMerge(
    [
      remote(),
      remote({ callsign: "W2XYZ", timeMs: T + min(30), references: ["US-0002"] }),
      remote({ callsign: "N0ONE", references: ["US-0003"] }),
    ],
    byCall,
  );
  ok(plan.counts.matched === 2, "two matched", String(plan.counts.matched));
  ok(plan.counts.missing === 1, "one we never logged", String(plan.counts.missing));
  ok(plan.updates.length === 2, "two contacts to update", String(plan.updates.length));
  ok(
    plan.updates.some(
      (u) => u.qsoId === "a" && u.references.join(",") === "US-1689",
    ),
    "with the right park on the right contact",
  );
}
{
  // A three-fer through the whole plan: one contact, three references, one update.
  const byCall = new Map<string, LocalQso[]>([["K1ABC", [local({ id: "a" })]]]);
  const grouped = groupRows(
    ["US-0001", "US-0002", "US-0003"].map((reference) => ({
      callsign: "K1ABC",
      band: "20M",
      mode: "FT8",
      timeMs: T,
      reference,
    })),
  );
  const plan = planMerge(grouped, byCall);
  ok(plan.updates.length === 1, "one contact to update", String(plan.updates.length));
  ok(plan.referencesAdded === 3, "three references added", String(plan.referencesAdded));
  ok(plan.counts.ambiguous === 0, "and nothing flagged as ambiguous");
}
{
  // Two POTA contacts matching the same local QSO with DISJOINT parks. Observed on
  // the air: an activator at two parks a minute apart, and one QSO in this log to
  // attribute. Nothing can tell which, so it is reported.
  const byCall = new Map<string, LocalQso[]>([["K1ABC", [local({ id: "a" })]]]);
  const plan = planMerge(
    [remote({ timeMs: T }), remote({ timeMs: T + min(2), references: ["US-0002"] })],
    byCall,
  );
  ok(plan.counts.ambiguous === 1, "a disjoint second contact is flagged", String(plan.counts.ambiguous));
  ok(plan.updates.length === 1, "and only the first is applied", String(plan.updates.length));
}
{
  // The same contact recorded twice by the activator's software, one second apart.
  // Observed on the air as eight rows for one four-fer, at 20:53:48 and 20:53:49.
  // Grouping cannot join them because the timestamps really differ, so the matching
  // reference sets are what identify them as one contact.
  const byCall = new Map<string, LocalQso[]>([["K1ABC", [local({ id: "a" })]]]);
  const four = ["US-3378", "US-4510", "US-6936", "US-8313"];
  const plan = planMerge(
    [remote({ timeMs: T, references: four }), remote({ timeMs: T + 1000, references: four })],
    byCall,
  );
  ok(plan.counts.ambiguous === 0, "a duplicate contact is not a clash", String(plan.counts.ambiguous));
  ok(plan.referencesAdded === 4, "and its parks are counted once", String(plan.referencesAdded));
}
{
  // Partial overlap is still the same contact: an activator who logged three parks
  // in one record and four in the duplicate.
  const byCall = new Map<string, LocalQso[]>([["K1ABC", [local({ id: "a" })]]]);
  const plan = planMerge(
    [
      remote({ timeMs: T, references: ["US-0001", "US-0002"] }),
      remote({ timeMs: T + 1000, references: ["US-0002", "US-0003"] }),
    ],
    byCall,
  );
  ok(plan.counts.ambiguous === 0, "an overlapping second contact merges");
  ok(plan.referencesAdded === 3, "taking the union of both", String(plan.referencesAdded));
}
console.log("\nwhich callsign is theirs");
{
  const ours = new Set(["K9XYZ"]);
  // A hunter row comes from the activator's log: they are the station, we are worked.
  ok(
    otherStation(
      { stationCallsign: "KB1ABC", operatorCallsign: "KB1ABC", workedCallsign: "K9XYZ" },
      ours,
    ) === "KB1ABC",
    "the activator is found in a hunter row",
  );
  // An activator row is the other way round, and the same rule handles it — which is
  // why the rule is "whichever is not ours" rather than a fixed field.
  ok(
    otherStation(
      { stationCallsign: "K9XYZ", operatorCallsign: "K9XYZ", workedCallsign: "K4CAE" },
      ours,
    ) === "K4CAE",
    "and in an activator row",
  );
  ok(
    otherStation({ stationCallsign: "K9XYZ", operatorCallsign: null, workedCallsign: null }, ours) ===
      null,
    "a row with only our own callsign yields nothing",
  );
  // Portable and club calls: an operator with several callsigns must not be mistaken
  // for the other station in their own log.
  ok(
    otherStation(
      { stationCallsign: "K9XYZ/P", operatorCallsign: "K9XYZ", workedCallsign: "K1ABC" },
      new Set(["K9XYZ", "K9XYZ/P"]),
    ) === "K1ABC",
    "every callsign of ours is excluded",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

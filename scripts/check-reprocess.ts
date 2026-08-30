// Checks for reprocessing one contact to chosen destinations.
// Run: npm run check:reprocess
//
// > "need a way on a contact in the log to reprocess, like if it didnt hit any logs so if
// >  they open the contact and hit reprocess they pick which logging softwares or
// >  integrations to send it to again"
//
// The rule being asserted is the one that is silent when it is wrong. Every filter in the
// upload path exists to stop a SWEEP sending things unasked — the sent flag, the cutoff,
// the eQSL reciprocal rule — and a reprocess has to bypass all of them, because the
// contact being reprocessed is usually one already MARKED sent. Leave the sent flag in the
// query and it finds nothing, uploads nothing, and reports a clean run of zero, which
// reads as success. Nobody would see a failure; the contact simply stays missing.
//
// These call the real `pendingWhere` and `resolveServices`, not copies of them. That is
// deliberate: check-dxcc.ts spent a long time asserting a rule only its own local
// reimplementation followed.

import {
  SENT_FIELD_FOR,
  UPLOADABLE,
  pendingWhere,
  resolveServices,
  type UploadableService,
} from "../lib/integrations/upload-runner";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const SINCE = new Date("2026-08-01T00:00:00Z");
const ALL_OFF = Object.fromEntries(UPLOADABLE.map((s) => [s, false])) as Record<
  UploadableService,
  boolean
>;

console.log("1. a sweep filters on the sent flag");
{
  for (const service of UPLOADABLE) {
    const w = pendingWhere(service, { since: SINCE });
    const field = Object.keys(w).find((k) => k.endsWith("Sent"));
    check(`${service}: filters on a *Sent field`, field !== undefined, Object.keys(w));
    check(`${service}: wants it false`, field !== undefined && w[field] === false, w);
  }
  const w = pendingWhere("qrz", { since: SINCE });
  check("the cutoff is applied", JSON.stringify(w).includes("2026-08-01"), w);
}

console.log("");
console.log("2. ignoreCutoff drops the date bound and NOTHING else");
{
  const w = pendingWhere("qrz", { since: SINCE, ignoreCutoff: true });
  check("no startTime bound", !("startTime" in w), w);
  check("still only unsent contacts", w.qrzSent === false, w);
}

console.log("");
console.log("3. the eQSL reciprocal rule applies to eQSL alone");
{
  const e = pendingWhere("eqsl", { since: SINCE, reciprocalOnly: true });
  check("eQSL requires a card received", e.eqslRcvd === true, e);
  for (const service of UPLOADABLE.filter((s) => s !== "eqsl")) {
    const w = pendingWhere(service, { since: SINCE, reciprocalOnly: true });
    check(`${service} is unaffected by it`, !("eqslRcvd" in w), w);
  }
  const off = pendingWhere("eqsl", { since: SINCE, reciprocalOnly: false });
  check("and only when it is switched on", !("eqslRcvd" in off), off);
}

console.log("");
console.log("4. NAMED CONTACTS BYPASS EVERY FILTER — the reprocess path");
{
  for (const service of UPLOADABLE) {
    const w = pendingWhere(service, {
      since: SINCE,
      reciprocalOnly: true,
      qsoIds: ["qso-1"],
    });
    // The whole point: a contact already marked sent must still be selected.
    check(
      `${service}: the sent flag is NOT a filter`,
      !Object.keys(w).some((k) => k.endsWith("Sent")),
      w,
    );
    check(`${service}: the cutoff is not applied`, !("startTime" in w), w);
    check(`${service}: the reciprocal rule is not applied`, !("eqslRcvd" in w), w);
    check(
      `${service}: it selects exactly the named contact`,
      JSON.stringify(w) === JSON.stringify({ id: { in: ["qso-1"] } }),
      w,
    );
  }
  const many = pendingWhere("qrz", { qsoIds: ["a", "b", "c"] });
  check("several ids are kept", JSON.stringify(many) === JSON.stringify({ id: { in: ["a", "b", "c"] } }), many);
  // An empty list must NOT be read as "no filter". `{ id: { in: [] } }` selects nothing,
  // which is right; falling through to the sweep query would select the whole backlog and
  // send it — the worst possible outcome from an empty selection.
  const none = pendingWhere("qrz", { qsoIds: [] });
  check("an empty list selects nothing, not everything", JSON.stringify(none) === JSON.stringify({ id: { in: [] } }), none);
}

console.log("");
console.log("5. picking the destinations");
{
  const prefs = { ...ALL_OFF, qrz: true, lotw: true };
  check(
    "with nothing named, the preferences decide",
    JSON.stringify(resolveServices({}, prefs)) === JSON.stringify(["qrz", "lotw"]),
    resolveServices({}, prefs),
  );
  check(
    "`only` overrides them",
    JSON.stringify(resolveServices({ only: "eqsl" }, prefs)) === JSON.stringify(["eqsl"]),
  );
  // The reprocess case. A service switched off for automatic sweeps says nothing about
  // whether the operator may send ONE contact there deliberately, so an explicit list must
  // not be intersected with the preferences.
  check(
    "an explicit list wins over preferences that are all off",
    JSON.stringify(resolveServices({ services: ["clublog", "n3fjp"] }, ALL_OFF)) ===
      JSON.stringify(["clublog", "n3fjp"]),
    resolveServices({ services: ["clublog", "n3fjp"] }, ALL_OFF),
  );
  check(
    "an explicit list wins over `only`",
    JSON.stringify(resolveServices({ only: "qrz", services: ["eqsl"] }, prefs)) ===
      JSON.stringify(["eqsl"]),
  );
  check(
    "nothing enabled and nothing named means nothing runs",
    resolveServices({}, ALL_OFF).length === 0,
  );
}

console.log("");
console.log("6. the baseline marks the same column it counted");
{
  // `baselineAsUploaded` writes a *Sent column and the endpoint that previews it counts
  // against one. If those two ever name different columns the preview says 4,992 and the
  // write touches a different set — and because nothing is uploaded, there is no service
  // response to disagree with it. It would simply be wrong, quietly.
  const seen = new Set<string>();
  for (const service of UPLOADABLE) {
    const field = SENT_FIELD_FOR(service);
    check(`${service} -> ${field}`, field === `${service}Sent`, field);
    check(`${service}'s column is its own`, !seen.has(field), field);
    seen.add(field);
    // The same column the sweep filters on, so a baselined contact is one the sweep then
    // skips. That is the entire effect of the feature.
    const w = pendingWhere(service, {});
    check(`${service}: the sweep filters on that same column`, field in w, w);
  }
  check("every service has a distinct column", seen.size === UPLOADABLE.length, [...seen]);
}

console.log("");
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");

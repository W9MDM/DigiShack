/* eslint-disable no-console */
// Checks for the in-progress-contact draft and its idempotency key.
// Run: npm run check:qso-draft
//
// THE FAULT THESE GUARD. A contact typed into /qsos/new lived in React state and nowhere
// else. `public/sw.js` does not intercept `POST /api/qsos` — `isLive()` returns true for
// every non-GET and the fetch handler returns without `respondWith`, which is the right
// call for a radio — so a submit on a dead link threw `ApiError(0, "Failed to fetch")`,
// rendered a red banner at the top of a 21-field form the operator had scrolled past, and
// then lost the contact outright the moment anything unmounted the page: switching apps,
// a manifest shortcut, the back gesture, the phone locking. On a park activation that is
// unrecoverable — the other operator is 800 miles away and gone.
//
// Three properties matter more than anything else here:
//
//   * PARSE NEVER THROWS. This code reads a string written by an older release, mangled
//     by an extension, or typed into devtools. An exception inside the mount effect takes
//     down the logging page at exactly the moment the operator is trying to recover a
//     contact from it, so every malformed input has to end as `null` and an empty form.
//   * RESTORE CANNOT STOMP. The recovery path must never itself destroy a contact, so a
//     draft is offered only into a form the operator has not started typing into.
//   * ONE KEY PER CONTACT. A retry has to carry the SAME key — that is what makes the
//     second tap safe — and a save has to rotate it, or the next contact collides with
//     the one just logged and the server hands back the wrong QSO.
//
// Everything below calls the real exports from components/qso/QsoForm.tsx and
// lib/client/api.ts. check-dxcc.ts spent a long time asserting a rule only its own local
// copy obeyed, so nothing here is reimplemented.
//
// WHAT IS NOT COVERED, deliberately. The server half — `readClientId` and the
// P2002-to-200 path in pages/api/qsos/index.ts — cannot be reached from a script: that
// module imports `@/lib/db/prisma`, and there is no database on the development machine.
// The unique index is asserted against prisma/schema.prisma as text instead, which proves
// the constraint is declared and NOT that MySQL is enforcing it. That needs the migration
// applied on the live box and a real double tap. Said out loud because it is exactly the
// distinction between measured and assumed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  QSO_DRAFT_KEY,
  QSO_DRAFT_VERSION,
  type QsoFormValues,
  clearDraft,
  draftFailureMessage,
  emptyValues,
  hasContactContent,
  isClientIdShape,
  newClientId,
  parseDraft,
  readDraft,
  serialiseDraft,
  writeDraft,
} from "@/components/qso/QsoForm";
import { ApiError, isNetworkFailure } from "@/lib/client/api";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/** A contact part-way through being typed, the way one actually looks mid-QSO. */
function inProgress(): QsoFormValues {
  return {
    ...emptyValues(),
    callsign: "K1ABC",
    freqMHz: "14.074",
    band: "20M",
    mode: "FT8",
    rstSent: "-08",
    rstRcvd: "-14",
    gridSquare: "FN42",
    name: "Matt",
    sig: "POTA",
    sigInfo: "US-0765",
    notes: "two-fer, second park to follow",
    stationId: "st_1",
  };
}

console.log("1. round trip");
{
  const values = inProgress();
  const saved = new Date("2026-08-29T14:32:00Z");
  const draft = parseDraft(serialiseDraft(values, "abcdefgh-1234-4567-89ab-cdef01234567", saved));

  check("a serialised draft parses back", draft !== null);
  check("every field survives", JSON.stringify(draft?.values) === JSON.stringify(values), draft?.values);
  check("the client id survives", draft?.clientId === "abcdefgh-1234-4567-89ab-cdef01234567", draft?.clientId);
  check("savedAt survives as ISO-8601", draft?.savedAt === saved.toISOString(), draft?.savedAt);
  check("the version is stamped", draft?.v === QSO_DRAFT_VERSION, draft?.v);

  // The one that would silently lose data: booleans must not come back as strings, or a
  // restored contact quietly flips a QSL flag on the way to the server.
  const flagged = { ...values, lotwSent: true, eqslRcvd: true, qrzSent: false };
  const back = parseDraft(serialiseDraft(flagged, "k".repeat(12)));
  check("booleans stay booleans", back?.values.lotwSent === true && back?.values.qrzSent === false, back?.values);

  // Notes are the field most likely to carry something that breaks a naive encoder.
  const awkward = { ...values, notes: 'he said "59 in Åland" — {"json":true}\n\ttabbed\\' };
  check(
    "quotes, braces, newlines and backslashes in notes survive",
    parseDraft(serialiseDraft(awkward, "k".repeat(12)))?.values.notes === awkward.notes,
  );

  check("the storage key is namespaced and versioned", QSO_DRAFT_KEY === "digishack:qso-draft:v1", QSO_DRAFT_KEY);
}

console.log("");
console.log("2. corrupt and foreign stored data never throws");
{
  // Each of these is a real way for the value to arrive wrong. None may throw, and none
  // may produce a half-populated form.
  const junk: [string, string | null | undefined][] = [
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["truncated JSON", '{"v":1,"values":{"callsign":"K1A'],
    ["not JSON at all", "half a contact, honestly"],
    ["a bare number", "42"],
    ["a bare string", '"K1ABC"'],
    ["JSON null", "null"],
    ["an array", '[{"v":1}]'],
    ["an object with no version", '{"values":{"callsign":"K1ABC"}}'],
    ["a version from the future", '{"v":9,"values":{"callsign":"K1ABC"}}'],
    ["a version from the past", '{"v":0,"values":{"callsign":"K1ABC"}}'],
    ["a string version", '{"v":"1","values":{"callsign":"K1ABC"}}'],
    ["values that are not an object", '{"v":1,"values":"K1ABC"}'],
    ["values that are an array", '{"v":1,"values":["K1ABC"]}'],
    ["values that are null", '{"v":1,"values":null}'],
    ["no values at all", '{"v":1}'],
  ];

  for (const [what, raw] of junk) {
    let threw: unknown = null;
    let got: unknown = "not run";
    try {
      got = parseDraft(raw);
    } catch (e) {
      threw = e;
    }
    check(`${what} returns null and does not throw`, threw === null && got === null, threw ?? got);
  }

  // A v1 draft written before a field existed. The fields it DOES carry must restore, and
  // the ones it does not must fall back to the empty form rather than to undefined — a
  // form value of `undefined` turns a controlled input into an uncontrolled one and React
  // starts warning at the operator instead of logging their contact.
  const old = parseDraft('{"v":1,"savedAt":"2026-01-01T00:00:00.000Z","clientId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","values":{"callsign":"VK3XYZ","freqMHz":"7.074","retiredField":"gone"}}');
  check("an older v1 draft still restores what it carries", old?.values.callsign === "VK3XYZ" && old?.values.freqMHz === "7.074", old?.values);
  check("missing fields fall back to the empty form, not to undefined", old?.values.notes === "" && old?.values.lotwSent === false, old?.values);
  check("no field is undefined", old !== null && Object.values(old.values).every((x) => x !== undefined));
  check("unknown stored keys are dropped", old !== null && !("retiredField" in old.values), Object.keys(old?.values ?? {}));

  // Wrong-typed values are dropped rather than coerced. `Boolean("false")` is true, and
  // that coercion would mark a contact as uploaded to LoTW.
  const wrongTypes = parseDraft('{"v":1,"values":{"callsign":123,"lotwSent":"false","notes":{"a":1},"qslSent":["NONE"]}}');
  check("a number where a string belongs is dropped", wrongTypes?.values.callsign === "", wrongTypes?.values.callsign);
  check('"false" does NOT become true', wrongTypes?.values.lotwSent === false, wrongTypes?.values.lotwSent);
  check("an object where a string belongs is dropped", wrongTypes?.values.notes === "", wrongTypes?.values.notes);
  check("an array where a string belongs is dropped", wrongTypes?.values.qslSent === "NONE", wrongTypes?.values.qslSent);

  // A stored key that could not be trusted must not be handed to the server as an
  // idempotency key — it would either be ignored there or collide with someone else's.
  check("a mangled client id is discarded", parseDraft('{"v":1,"clientId":"../../etc/passwd","values":{}}')?.clientId === "");
  check("a short client id is discarded", parseDraft('{"v":1,"clientId":"abc","values":{}}')?.clientId === "");
  check("an over-long client id is discarded", parseDraft(`{"v":1,"clientId":"${"a".repeat(65)}","values":{}}`)?.clientId === "");
  check("a 64-character client id is kept", parseDraft(`{"v":1,"clientId":"${"a".repeat(64)}","values":{}}`)?.clientId === "a".repeat(64));
}

console.log("");
console.log("3. what counts as a contact worth keeping");
{
  check("a fresh form has nothing to keep", hasContactContent(emptyValues()) === false);
  check("a contact in progress does", hasContactContent(inProgress()) === true);

  // The session fields are exactly the ones /qsos/new carries across a save. If any of
  // them counted as content, a draft would be written the moment the page opened, and a
  // successful save would immediately re-create the draft it had just cleared — offering
  // the operator a contact they had already logged.
  const session = emptyValues();
  const afterSave: QsoFormValues = {
    ...session,
    stationId: "st_1",
    operatorId: "op_1",
    freqMHz: "14.074",
    band: "20M",
    mode: "FT8",
  };
  check("the carried-over session alone is not a contact", hasContactContent(afterSave) === false, afterSave);
  check("the preselected station alone is not a contact", hasContactContent({ ...session, stationId: "st_1" }) === false);
  check("a clock tick on startTime is not a contact", hasContactContent({ ...session, startTime: "2026-08-29T14:32" }) === false);

  // Switching mode rewrites both reports to that mode's default. That is the form
  // following the operator, not the operator typing a report.
  check("switching FT8 -> SSB is not a contact", hasContactContent({ ...session, mode: "SSB", rstSent: "59", rstRcvd: "59" }) === false);
  check("but a typed report IS a contact", hasContactContent({ ...session, mode: "SSB", rstSent: "59", rstRcvd: "44" }) === true);

  // One field each, because any one of them is somebody's contact.
  for (const key of ["callsign", "endTime", "gridSquare", "name", "qth", "dxcc", "state", "cqZone", "iota", "sig", "sigInfo", "continent", "notes"] as const) {
    check(`${key} alone counts as a contact`, hasContactContent({ ...session, [key]: "X" }) === true);
  }
}

console.log("");
console.log("4. the idempotency key");
{
  const ids = new Set<string>();
  for (let i = 0; i < 5000; i++) ids.add(newClientId());
  check("5000 keys, no collisions", ids.size === 5000, ids.size);

  const one = newClientId();
  check("shaped like a UUID v4", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(one), one);
  check("fits VARCHAR(64)", one.length <= 64, one.length);
  check("passes its own shape check", isClientIdShape(one) === true, one);

  // The server's rule is a bounded token from a URL- and SQL-safe charset. It is not
  // imported — that module pulls in Prisma — so the client contract is asserted from this
  // side: whatever `newClientId` produces must satisfy it.
  check("uses only characters the server accepts", /^[A-Za-z0-9._:-]{8,64}$/.test(one), one);

  check("rejects a non-string", isClientIdShape(42) === false);
  check("rejects undefined", isClientIdShape(undefined) === false);
  check("rejects an empty string", isClientIdShape("") === false);
  check("rejects a path traversal", isClientIdShape("../../x") === false);
  check("rejects a quote", isClientIdShape("abcdefgh'; DROP TABLE Qso; --") === false);

  // The property the whole mechanism rests on: a retry carries the key the FIRST attempt
  // used. The draft is the only thing that survives the tab being discarded, so the key
  // has to travel inside it.
  const values = inProgress();
  const firstAttempt = newClientId();
  const recovered = parseDraft(serialiseDraft(values, firstAttempt));
  check("a recovered draft retries under the ORIGINAL key", recovered?.clientId === firstAttempt, recovered?.clientId);
  check("and with the original contact intact", recovered?.values.callsign === "K1ABC");
}

console.log("");
console.log("5. the unique index that makes the key mean anything");
{
  // Text assertions against the schema and the hand-written migration. They prove the
  // constraint is DECLARED. They do not prove MySQL is enforcing it — that needs the
  // migration applied on the live box.
  const root = join(__dirname, "..");
  const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
  const migration = readFileSync(
    join(root, "prisma", "migrations", "20260829120000_qso_client_id", "migration.sql"),
    "utf8",
  );

  check("schema declares Qso.clientId", /\n\s*clientId\s+String\?/.test(schema), false);
  check("it is unique", /clientId\s+String\?\s+@unique/.test(schema), false);
  check("it is nullable, so the back catalogue and imports are unconstrained", /clientId\s+String\?/.test(schema));
  check("it is bounded to 64 characters", /clientId\s+String\?\s+@unique\s+@db\.VarChar\(64\)/.test(schema), false);
  check("the migration adds the column", /ALTER TABLE `Qso` ADD COLUMN `clientId` VARCHAR\(64\) NULL/.test(migration));
  check("the migration creates the unique index", /CREATE UNIQUE INDEX `Qso_clientId_key` ON `Qso`\(`clientId`\)/.test(migration));
  check("the index carries the name Prisma would generate", migration.includes("Qso_clientId_key"));
}

console.log("");
console.log("6. honest failure messaging");
{
  // status 0 is the api helpers' sentinel for "never reached the server". A real HTTP
  // response always carries a real status, so nothing else can look like this.
  check("status 0 is a network failure", isNetworkFailure(new ApiError(0, "Failed to fetch")) === true);
  check("a 400 is not", isNetworkFailure(new ApiError(400, "Validation failed")) === false);
  check("a 409 is not", isNetworkFailure(new ApiError(409, "Already worked K1ABC")) === false);
  check("a 503 is not", isNetworkFailure(new ApiError(503, "Database unavailable")) === false);
  check("a plain Error is not", isNetworkFailure(new Error("Failed to fetch")) === false);
  check("null is not", isNetworkFailure(null) === false);

  const kept = draftFailureMessage("Failed to fetch", true);
  const lost = draftFailureMessage("Failed to fetch", false);

  // The whole point: the operator must not be told a raw browser string and left to guess
  // whether their contact still exists.
  check("the kept message says it is not logged", /not logged/i.test(kept), kept);
  check("the kept message promises the contact survives", /held on this device/i.test(kept), kept);
  check("the kept message names the phone-lock case", /lock/i.test(kept), kept);
  check("the kept message offers Retry", /retry/i.test(kept), kept);
  check("the kept message says a retry cannot duplicate", /cannot be duplicated/i.test(kept), kept);
  check("it still carries the underlying cause", kept.includes("Failed to fetch"), kept);

  // And when storage is blocked it must NOT make the promise. Getting this backwards is
  // worse than saying nothing: the operator closes the tab because they were reassured.
  check("with storage blocked it does not claim the device holds it", /held on this device/i.test(lost) === false, lost);
  check("with storage blocked it says not to close the page", /do not close/i.test(lost), lost);
  check("the two messages differ", kept !== lost);
  check("neither is the bare browser string", kept !== "Failed to fetch" && lost !== "Failed to fetch");

  // The 30-second timeout is the other status-0 shape, and it must be carried through
  // rather than replaced: "the server did not answer" and "there is no network" call for
  // different guesses about what to do next.
  const timedOut = draftFailureMessage("The server did not answer within 30 seconds. It may be busy or unreachable.", true);
  check("a timeout keeps its own explanation", timedOut.includes("30 seconds"), timedOut);
}

console.log("");
console.log("7. storage access with no localStorage present");
{
  // Node has no `window`, which is the same branch a blocked or absent store takes in the
  // browser. Nothing may throw, and a failed write must report failure rather than
  // pretending — the failure message depends on that boolean being true.
  let threw: unknown = null;
  let wrote = true;
  let read: unknown = "not run";
  try {
    read = readDraft();
    wrote = writeDraft(inProgress(), newClientId());
    clearDraft();
  } catch (e) {
    threw = e;
  }
  check("readDraft does not throw without localStorage", threw === null, threw);
  check("readDraft returns null", read === null, read);
  check("writeDraft reports FALSE rather than claiming success", wrote === false);
  check("clearDraft does not throw", threw === null, threw);
}

console.log(
  failures === 0
    ? "\nAll qso-draft checks passed.\n"
    : `\n${failures} QSO-DRAFT CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

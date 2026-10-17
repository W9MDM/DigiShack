/* eslint-disable no-console */
// HamDB callsign -> licence class mapping and response parsing, offline.
//
// No network: parseHamdb and licenceClassFromHamdb are pure, and HamDB answers a miss with
// HTTP 200 + every field "NOT_FOUND", so the parser must reject that rather than return a
// station called "NOT_FOUND".

import { licenceClassFromHamdb, parseHamdb } from "@/lib/ham/hamdb";

let pass = 0;
let fail = 0;
function eq(a: unknown, b: unknown, label: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}

function hit(fields: Record<string, string>) {
  return { hamdb: { version: "1", callsign: fields, messages: { status: "OK" } } };
}

console.log("\nclass letter -> licence class");
eq(licenceClassFromHamdb("E", "United States"), "us-extra", "E -> extra");
eq(licenceClassFromHamdb("A", "United States"), "us-advanced", "A -> advanced");
eq(licenceClassFromHamdb("G", "United States"), "us-general", "G -> general");
eq(licenceClassFromHamdb("T", "United States"), "us-technician", "T -> technician");
eq(licenceClassFromHamdb("N", "United States"), "us-technician", "N (Novice) -> technician (closest)");
eq(licenceClassFromHamdb("g", "United States"), "us-general", "lower-case letter still maps");
eq(licenceClassFromHamdb("E", "Canada"), "other", "non-US licence -> other, whatever the letter");
eq(licenceClassFromHamdb("", "United States"), "other", "unknown letter -> other");

console.log("\nparsing a response");
eq(
  parseHamdb(hit({ call: "K9XYZ", class: "G", grid: "EN61aa", fname: "Matthew", name: "Melton", state: "IN", country: "United States" }), "k9xyz"),
  { call: "K9XYZ", classLetter: "G", licenceClass: "us-general", grid: "EN61aa", name: "Matthew Melton", state: "IN", country: "United States" },
  "a clean US hit maps and is case-insensitive on the requested call",
);
eq(
  parseHamdb({ hamdb: { callsign: { call: "NOT_FOUND", class: "NOT_FOUND", grid: "NOT_FOUND", country: "NOT_FOUND" }, messages: { status: "NOT_FOUND" } } }, "ZZ9ZZ"),
  null,
  "a NOT_FOUND miss is rejected, not read as a station",
);
eq(parseHamdb({ hamdb: { messages: { status: "OK" } } }, "K9XYZ"), null, "no callsign block -> null");
eq(parseHamdb({}, "K9XYZ"), null, "empty body -> null");
eq(
  parseHamdb(hit({ call: "KX9X", class: "E", grid: "NOT_FOUND", fname: "NOT_FOUND", name: "NOT_FOUND", country: "United States" }), "kx9x"),
  { call: "KX9X", classLetter: "E", licenceClass: "us-extra", grid: null, name: null, state: null, country: "United States" },
  "partial NOT_FOUND fields are scrubbed to null, the class still maps",
);
eq(
  parseHamdb(hit({ call: "K9XYZ", class: "G", country: "United States" }), "KD8XYZ"),
  null,
  "a response for a different call than requested is rejected",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

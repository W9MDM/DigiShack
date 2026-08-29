/* eslint-disable no-console */
// Every setting explains itself, and every help icon points somewhere real.
//
// Written after an audit found 24 settings with NO help text at all — including every
// credential field for QRZ, LoTW, eQSL, Club Log and SMTP, which are exactly the ones a
// new operator meets first and the ones where the wrong guess is most expensive. Club Log
// authenticates by registered email rather than callsign; LoTW's password is the website
// one and not the certificate passphrase; QRZ's lookup login and its logbook API key are
// different credentials for different jobs. None of that was written anywhere the operator
// would look.
//
// A settings page is documentation. This keeps it that way.

import { existsSync } from "node:fs";
import path from "node:path";

import { SETTINGS, SETTING_GROUPS } from "@/lib/settings/registry";

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

/**
 * Shortest help worth having.
 *
 * Not an arbitrary number: it is about the length of one useful sentence. "Optional." and
 * "The port." pass a presence check while telling the reader nothing they could not read
 * off the label, and that is the failure mode this guards — help that exists so a test
 * goes green.
 */
const MIN_HELP = 40;

function main(): void {
  console.log("\nevery setting has help");
  {
    const missing = SETTINGS.filter((s) => !s.help?.trim());
    ok(missing.length === 0, "no setting is undocumented", missing.map((s) => s.key).join(", "));
  }

  console.log("\nand the help says something");
  {
    const thin = SETTINGS.filter((s) => (s.help?.trim().length ?? 0) < MIN_HELP);
    ok(
      thin.length === 0,
      `no help is shorter than ${MIN_HELP} characters`,
      thin.map((s) => `${s.key} (${s.help?.trim().length})`).join(", "),
    );
  }

  console.log("\nevery setting belongs to a group that exists");
  {
    const ids = new Set(SETTING_GROUPS.map((g) => g.id));
    const orphans = SETTINGS.filter((s) => !ids.has(s.group));
    ok(orphans.length === 0, "no orphaned settings", orphans.map((s) => s.key).join(", "));
    const empty = SETTING_GROUPS.filter((g) => !SETTINGS.some((s) => s.group === g.id));
    ok(empty.length === 0, "no empty groups", empty.map((g) => g.id).join(", "));
  }

  console.log("\nevery group introduces itself");
  {
    const noBlurb = SETTING_GROUPS.filter((g) => !g.blurb?.trim());
    ok(noBlurb.length === 0, "every group has a blurb", noBlurb.map((g) => g.id).join(", "));
  }

  console.log("\nand every help icon points at a document that exists");
  {
    // The failure worth catching: a doc link surviving a file being renamed or removed.
    // A help icon leading to a 404 is worse than no icon, because it costs a click and
    // teaches the reader not to trust the next one.
    const broken = SETTING_GROUPS.filter(
      (g) => g.doc && !existsSync(path.join(process.cwd(), "docs", `${g.doc}.md`)),
    );
    ok(
      broken.length === 0,
      "no group links to a missing document",
      broken.map((g) => `${g.id} -> docs/${g.doc}.md`).join(", "),
    );

    const linked = SETTING_GROUPS.filter((g) => g.doc);
    ok(linked.length > 0, `${linked.length} of ${SETTING_GROUPS.length} groups link to docs`);

    // A link with no label is a bare "i" that says nothing about where it goes.
    const unlabelled = SETTING_GROUPS.filter((g) => g.doc && !g.docLabel?.trim());
    ok(
      unlabelled.length === 0,
      "every linked group says what the reader will find",
      unlabelled.map((g) => g.id).join(", "),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();

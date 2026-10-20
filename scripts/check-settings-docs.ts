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

import { selectChoices } from "@/components/settings/select-choices";
import { LICENCE_CLASSES, parseLicenceClass } from "@/lib/radio/sstv-licence";
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

  console.log("\nevery picker has something to pick");
  {
    // A `select` with no options renders an empty dropdown, which is worse than the text
    // box it replaced: the operator cannot type the value they wanted either.
    const selects = SETTINGS.filter((s) => s.type === "select");
    const empty = selects.filter((s) => (s.options?.length ?? 0) === 0);
    ok(empty.length === 0, "no select setting is missing its options", empty.map((s) => s.key).join(", "));

    // A default that is not among the choices leaves the picker showing a value it cannot
    // offer, and the first save silently changes it to something else.
    const strayDefault = selects.filter(
      (s) => s.default !== undefined && !(s.options ?? []).some((o) => o.value === s.default),
    );
    ok(
      strayDefault.length === 0,
      "every select default is one of its own options",
      strayDefault.map((s) => `${s.key}=${s.default}`).join(", "),
    );
    ok(selects.length > 0, `${selects.length} setting(s) offer a list rather than free text`);

    const dupes = selects.filter((s) => new Set((s.options ?? []).map((o) => o.value)).size !== (s.options ?? []).length);
    ok(dupes.length === 0, "no select offers the same value twice", dupes.map((s) => s.key).join(", "));
  }

  console.log("\na picker offers only what its reader accepts");
  {
    // The licence class, decode source and JS8 replies were text boxes. Each choice must be
    // a string the code that reads the setting acts on, or picking it would be the typo the
    // list was added to prevent.
    const values = (key: string) => (SETTINGS.find((s) => s.key === key)?.options ?? []).map((o) => o.value);
    const licence = values("station.licenceClass");
    ok(
      LICENCE_CLASSES.every((c) => licence.includes(c)),
      "every licence class the SSTV check knows is offered",
    );
    ok(
      licence.every((v) => v === "" || parseLicenceClass(v) === v),
      "every licence choice parses as itself (or is 'not set')",
      licence.join(", "),
    );
    ok(
      values("js8.autoreply").every((v) => ["off", "hb", "all"].includes(v)) && values("js8.autoreply").includes("off"),
      "JS8 automatic replies offers off, hb and all only",
      values("js8.autoreply").join(", "),
    );
    ok(
      values("digital.source").every((v) => ["wsjtx", "flex", "icom"].includes(v)),
      "decode source offers wsjtx, flex and icom only",
      values("digital.source").join(", "),
    );
  }

  console.log("\nan unexpected stored value still shows, and can still be changed");
  {
    const opts = [
      { value: "wsjtx", label: "External" },
      { value: "flex", label: "Flex" },
    ];
    const odd = selectChoices(opts, "omega");
    ok(odd[0]?.value === "omega" && !odd[0]?.disabled, "a stored value not among the choices is listed, selectable, first");
    ok(opts.every((o) => odd.some((c) => c.value === o.value && !c.disabled)), "and every real choice is still there to pick");
    const known = selectChoices(opts, "flex");
    ok(known.length === opts.length, "a stored value among the choices adds nothing");
    const blank = selectChoices(opts, "");
    ok(blank[0]?.value === "" && blank[0]?.disabled === true, "nothing stored and no 'not set' choice: a disabled placeholder");
    const own = selectChoices([{ value: "", label: "Not set" }, ...opts], "");
    ok(own.length === 3 && !own.some((c) => c.disabled), "a list with its own 'not set' gets no second one");
    // Every real select, at every value it can hold today, lists that value exactly once.
    const bad = SETTINGS.filter((s) => s.type === "select").filter((s) =>
      [s.default ?? "", "unexpected-value", ""].some(
        (v) => selectChoices(s.options, v).filter((c) => c.value === v).length !== 1,
      ),
    );
    ok(bad.length === 0, "every select lists its current value exactly once", bad.map((s) => s.key).join(", "));
  }

  console.log("\nprotections are never tucked away");
  {
    // `advanced` puts a setting behind its group's disclosure. Right for a port or a
    // threshold; wrong for anything that stops the station doing harm, because an operator
    // has to be able to SEE whether the radio is armed, what power a picture goes out at and
    // where the guards trip without knowing to open anything first. Listed by key rather than
    // inferred: "protects something" is a judgement, and writing it down is the point.
    const PROTECTIONS = [
      // Power and the PA.
      "sstv.powerPct",
      "icom.rfPowerPercent",
      "schedule.paAfterMinutes",
      "schedule.paRestMinutes",
      // Guard trips, and the brakes that bound an unattended run.
      "auto.maxSwr",
      "auto.maxPaTempC",
      "auto.maxRunMinutes",
      "auto.maxQsosPerRun",
      "auto.maxConsecutiveTx",
      "auto.deafWindowLimit",
      // Duplicate protection.
      "auto.dupeWindowHours",
      "auto.skipWorkedOnBandMode",
      "auto.skipWorkedOnBand",
      // Things that key the radio on their own.
      "flex.atuOnBandChange",
      "icom.atuOnBandChange",
      "js8.autoreply",
      // Nothing transmits during these hours.
      "schedule.sleep",
    ];
    const byKey = new Map(SETTINGS.map((s) => [s.key, s]));
    const gone = PROTECTIONS.filter((k) => !byKey.has(k));
    ok(gone.length === 0, "every listed protection is still a setting", gone.join(", "));
    const hidden = PROTECTIONS.filter((k) => byKey.get(k)?.advanced);
    ok(hidden.length === 0, "no listed protection is advanced", hidden.join(", "));

    // Two rules that need no list. Every per-radio transmit gate, including one for a radio
    // added later; and every setting with a `confirm`, which is the registry's own
    // definition of a value that removes a protection.
    const gates = SETTINGS.filter((s) => s.key.endsWith(".allowTransmit"));
    ok(gates.length >= 2, `${gates.length} transmit gates found`);
    const hiddenGates = gates.filter((s) => s.advanced);
    ok(hiddenGates.length === 0, "no transmit gate is advanced", hiddenGates.map((s) => s.key).join(", "));
    const hiddenConfirm = SETTINGS.filter((s) => s.confirm && s.advanced);
    ok(
      hiddenConfirm.length === 0,
      "no setting with a confirmation is advanced",
      hiddenConfirm.map((s) => s.key).join(", "),
    );
  }


  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();

/* eslint-disable no-console */
// The keyboard modes' exchange and log: the F-key lines with the calls and report filled in,
// and every mode the log bar writes exporting as its proper ADIF MODE and SUBMODE, and
// coming back as itself from an ADIF import.
// Run: npm run check:text-log

import { fillMacro, QSO_MACROS } from "@/components/digital/QsoBar";
import { fromAdifMode, toAdifMode } from "@/lib/adif/fields";
import { isDigitalMode, isLoggableMode, rstStyleFor, TEXT_LOG_MODES } from "@/lib/ham/modes";

let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("the F-key lines");
{
  const v = { my: "KC9QRS", their: "KD9XYZ", report: "579", name: "Tom" };
  const line = (key: string) => fillMacro(QSO_MACROS.find((m) => m.key === key)!.text, v);
  ok(line("F1") === "CQ CQ CQ DE KC9QRS KC9QRS KC9QRS K", `F1 calls CQ: ${line("F1")}`);
  ok(line("F2") === "KD9XYZ KD9XYZ DE KC9QRS KC9QRS KC9QRS K", `F2 answers: ${line("F2")}`);
  ok(line("F3") === "KD9XYZ DE KC9QRS TNX FER CALL UR 579 579 579 BK", `F3 gives the report: ${line("F3")}`);
  ok(QSO_MACROS.find((m) => m.key === "F4")!.ends === true, "F4 (73) is the one that ends the contact, and logs it");
  ok(QSO_MACROS.filter((m) => m.ends).length === 1, "and the only one");
  ok(fillMacro("%H DE %M K", { ...v, their: "" }) === null, "a line that needs their call is not sent without it");
  ok(fillMacro("CQ DE %M", { ...v, my: null }) === null, "nor one that needs mine, before it is set");
  ok(fillMacro("UR %R", { ...v, report: "" }) === "UR 599", "an empty report goes as 599");
  ok(QSO_MACROS.map((m) => m.key).join(",") === "F1,F2,F3,F4,F5,F6,F7,F8", "F1 to F8, in order");
}

console.log("\neach mode logs as ADIF knows it");
{
  const want: Record<string, [string, string | undefined]> = {
    RTTY: ["RTTY", undefined],
    CW: ["CW", undefined],
    PSK31: ["PSK", "PSK31"],
    PSK63: ["PSK", "PSK63"],
    PSK125: ["PSK", "PSK125"],
    OLIVIA: ["OLIVIA", undefined],
    CONTESTI: ["CONTESTI", undefined],
    HELL: ["HELL", undefined],
    FSKH105: ["HELL", "FSKH105"],
    FSKH245: ["HELL", "FSKH245"],
    HELL80: ["HELL", "HELL80"],
    SLOWHELL: ["HELL", "SLOWHELL"],
    PSKHELL: ["HELL", "PSKHELL"],
  };
  ok(Object.keys(want).sort().join() === [...TEXT_LOG_MODES].sort().join(), `the bar logs exactly these: ${TEXT_LOG_MODES.join(", ")}`);
  for (const [mode, [m, sub]] of Object.entries(want)) {
    const a = toAdifMode(mode);
    ok(a.mode === m && a.submode === sub, `${mode} -> MODE=${a.mode}${a.submode ? ` SUBMODE=${a.submode}` : ""}`);
    ok(fromAdifMode(a.mode, a.submode) === mode, `  and an ADIF import of that comes back as ${mode}`);
    // CW is its own award category, not digital.
    ok(isLoggableMode(mode) && isDigitalMode(mode) === (mode !== "CW"), `  loggable, and ${mode === "CW" ? "CW" : "digital"} for awards`);
    ok(rstStyleFor(mode) === "RST", `  reported as RST (599)`);
  }
  ok(!TEXT_LOG_MODES.includes("JTTY"), "JTTY is not logged from the bar: it has no ADIF mode yet");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all text-log assertions passed");

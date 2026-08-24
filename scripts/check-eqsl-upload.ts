/* eslint-disable no-console */
// eQSL upload: the ADIF fragment and the reply parser.
//
// Both are worth testing because both are string handling against a service that answers in
// prose with an HTTP 200 whatever happened — so the BODY is the status code, and a
// misreading marks contacts uploaded that eQSL never accepted.

import { eqslAdifFragment, readEqslReply,
  explainEqslError,
} from "@/lib/integrations/eqsl";

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
function eq<T>(a: T, b: T, label: string): void {
  ok(Object.is(a, b), label, `got ${String(a)}, want ${String(b)}`);
}

const CREDS = { username: "K9XYZ", password: "secret", qthNickname: "HOME" };
const REC = {
  callsign: "K1ABC",
  band: "20M",
  mode: "FT8",
  startTime: new Date("2026-08-23T14:05:09Z"),
  rstSent: "-12",
};

console.log("the ADIF fragment");
{
  const f = eqslAdifFragment(REC, CREDS);

  // Every ADIF field declares its own length, and a wrong length is the one error eQSL
  // cannot recover from — it reads the next field from the wrong offset.
  for (const [name, value] of [
    ["CALL", "K1ABC"],
    ["BAND", "20M"],
    ["MODE", "FT8"],
    ["RST_SENT", "-12"],
    ["EQSL_USER", "K9XYZ"],
  ] as const) {
    ok(f.includes(`<${name}:${value.length}>${value}`), `${name} declares its real length`);
  }

  // Dates and times are UTC, and TIME_ON is HHMM with no seconds — eQSL rejects seconds.
  ok(f.includes("<QSO_DATE:8>20260823"), "QSO_DATE is YYYYMMDD in UTC");
  ok(f.includes("<TIME_ON:4>1405"), "TIME_ON is HHMM with the seconds dropped");
  ok(!/<TIME_ON:6>/.test(f), "and never HHMMSS");

  ok(f.includes("<EOH>"), "the header is terminated");
  ok(f.trimEnd().endsWith("<EOR>"), "and the record is");
  // Header before record: eQSL reads credentials from the header, so a record that
  // precedes it is unauthenticated.
  ok(f.indexOf("<EOH>") < f.indexOf("<CALL:"), "the header comes before the contact");

  // An absent optional field is omitted, not sent empty. `<SUBMODE:0>` is a length-zero
  // field, which is a different statement from "no submode" and eQSL treats it as garbage.
  const bare = eqslAdifFragment(
    { callsign: "K1ABC", band: "20M", mode: "FT8", startTime: REC.startTime },
    { username: "K9XYZ", password: "s" },
  );
  ok(!/SUBMODE/.test(bare), "an absent submode is omitted entirely");
  ok(!/RST_SENT/.test(bare), "as is an absent RST");
  ok(!/QTH_NICKNAME/.test(bare), "and an unset QTH nickname");
  ok(!/:0>/.test(bare), "no zero-length field is ever emitted");

  // The nickname picks WHICH profile the card comes from, so it must survive when given.
  ok(
    eqslAdifFragment(REC, CREDS).includes("<APP_EQSL_QTH_NICKNAME:4>HOME"),
    "the QTH nickname is sent when configured",
  );
  // Callsigns and bands upper-case; eQSL matches on them.
  ok(
    eqslAdifFragment({ ...REC, callsign: "k1abc", band: "20m" }, CREDS).includes(
      "<CALL:5>K1ABC",
    ),
    "a lower-case callsign is upper-cased",
  );
}

console.log("\nreading eQSL's reply");
{
  eq(readEqslReply("Result: 1 out of 1 records added").status, "sent", "the success string");
  // Both of eQSL's two ways of saying "already there" count as duplicates, and the caller
  // marks those done — being there is the state we wanted.
  eq(
    readEqslReply("Result: 0 out of 1 records added").status,
    "duplicate",
    "0-of-1 is a duplicate",
  );
  eq(
    readEqslReply("Warning: Y=2013 M=08 D=11 K1ABC 15M JT65 Bad record: Duplicate").status,
    "duplicate",
    "and so is an explicit Bad record: Duplicate",
  );
  // 0-of-0 means eQSL could not PARSE it — our bug, not a contact already sent. Counting
  // it as done would mark contacts uploaded that eQSL never saw.
  eq(
    readEqslReply("Result: 0 out of 0 records added").status,
    "rejected",
    "0-of-0 is a formatting fault, NOT a duplicate",
  );
  eq(
    readEqslReply("Error: No match on eQSL_User/eQSL_Pswd").status,
    "bad-credentials",
    "wrong credentials are their own outcome",
  );
  // Credentials are checked before the result strings: eQSL sometimes says both, and
  // "1 out of 1 added" alongside an auth error must not read as success.
  eq(
    readEqslReply("Error: No match on eQSL_User/eQSL_Pswd Result: 1 out of 1 records added")
      .status,
    "bad-credentials",
    "and outrank a success string appearing beside them",
  );
  eq(readEqslReply("").status, "error", "an empty body is an error, not a success");
  const weird = readEqslReply("<html>502 upstream</html>");
  eq(weird.status, "error", "anything unrecognised is an error");
  ok(
    weird.status === "error" && weird.detail.includes("502"),
    "  and carries eQSL's own words, not 'upload failed'",
  );
  // Line breaks and padding must not defeat the match.
  eq(
    readEqslReply("\n\n  Result:   1 out of 1 records added  \n").status,
    "sent",
    "whitespace and newlines are tolerated",
  );
}


console.log("\neQSL's misleading error for a wrong QTH");
{
  // MEASURED. A nickname that does not exist gets this, verbatim — and the credentials are
  // fine. eQSL is saying it cannot find that user AT that QTH, and its own wording names
  // every cause except the one that applies, so an operator reading it rotates a password
  // that was never the problem. This is the error somebody gets after moving and forgetting
  // to change the QTH on their eQSL account.
  const wrongQth =
    "Error: No such Username/Password found This could mean the wrong callsign or the wrong " +
    "password, or the user does not exist.";
  const withNick = explainEqslError(wrongQth, "SR2");
  ok(withNick.includes("SR2"), "the configured nickname is named in the explanation");
  ok(/nickname/i.test(withNick), "and the nickname is identified as the likely cause");
  ok(
    /before changing your password/i.test(withNick),
    "with the password explicitly ruled out first",
  );

  // With NO nickname configured the same message really might be the password, so it must
  // pass through unchanged rather than blaming a setting that is not in use.
  eq(
    explainEqslError(wrongQth, null),
    wrongQth,
    "and with no nickname set the message is left alone",
  );

  const multi =
    "Error: Username/Password found more than 1 account Please specify the desired User";
  ok(
    /QTH nickname/i.test(explainEqslError(multi, null)),
    "the more-than-one-account error names the setting that fixes it",
  );

  // An unrelated error must not be rewritten into something about QTHs.
  const other = "Error: Your account has expired";
  eq(explainEqslError(other, "SR2"), other, "an unrelated error is passed through verbatim");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

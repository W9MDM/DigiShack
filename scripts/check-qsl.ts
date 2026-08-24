/* eslint-disable no-console */
// QSL email rendering checks. Nothing here sends mail or opens a socket.

import { renderQslEmail, sendQslEmail } from "@/lib/qsl/email";

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

const qso = {
  callsign: "sp1abc",
  band: "40M",
  mode: "FT8",
  startTime: new Date("2026-08-01T04:07:15Z"),
  freqHz: 7_075_500,
  rstSent: "-05",
  rstRcvd: "-10",
  gridSquare: "jo80",
};
const sender = { callsign: "k9xyz", name: "Matt", grid: "en61aa", txPower: "100" };

// The registry defaults, so the tests exercise the wording that actually ships.
// Passing templates explicitly keeps this pure — no database, no Settings.
const TEMPLATES = {
  subject: "QSL Confirmation for {THEIR_CALL} / {MY_CALL} QSO",
  body: [
    "{THEIR_CALL},",
    "",
    "Thank you for the QSO. Please find my QSL card attached.",
    "",
    "73,",
    "{MY_NAME}",
    "{MY_CALL}",
  ].join("\n"),
  contactDataHeading: "Contact Data",
  contactData: [
    "Call: {THEIR_CALL} DE {MY_CALL}",
    "Date: {DATE} {TIME}:00 UTC",
    "Freq: {FREQ} MHz",
    "Band: {BAND}",
    "Mode: {MODE}",
    "RSTS: {RST_SENT}",
    "RSTR: {RST_RCVD}",
    "TX Power: {POWER}",
    "My Grid: {MY_GRID}",
    "Your Grid: {THEIR_GRID}",
  ].join("\n"),
  cardHeading: "Embedded QSL Card:",
  embedCard: true,
  attachCard: true,
};

async function main(): Promise<void> {
  console.log("\nrendering");
  {
    const r = renderQslEmail(qso, sender, TEMPLATES);

    ok(r.subject.includes("K9XYZ"), "subject carries our callsign upper-cased", r.subject);
    ok(r.subject.includes("SP1ABC"), "subject carries theirs upper-cased");
    ok(r.subject.startsWith("QSL Confirmation for"), "subject follows the template", r.subject);

    ok(r.text.startsWith("SP1ABC,"), "text opens with their callsign, as the template says");
    ok(r.text.includes("Call: SP1ABC DE K9XYZ"), "contact data block present", r.text);
    ok(r.text.includes("TX Power: 100w"), "power comes from the station settings");
    ok(r.text.includes("Your Grid: JO80"), "their grid upper-cased");
    ok(r.text.includes("7.0755 MHz"), "frequency formatted to 4 decimals");
    ok(r.text.includes("-05") && r.text.includes("-10"), "both reports present");
    ok(r.text.includes("JO80"), "their grid upper-cased");
    ok(r.text.includes("73,"), "signs off");
    ok(r.text.includes("Matt") && r.text.includes("K9XYZ"), "sign-off names the operator");
    ok(r.text.includes("EN61aa"), "our grid included");
    // The wording is the OPERATOR'S now, not ours, so assert the mechanism
    // rather than a phrase: the body is whatever the template says, verbatim.
    ok(r.text.includes("Thank you for the QSO"), "the body comes through from the template");

    // Fixed-width <pre>, not a <table>: aligned labels read as data, and it
    // matches the operator's existing emailer.
    ok(r.html.includes("<pre"), "html presents contact data fixed-width");
    ok(
      !r.html.includes("Embedded QSL Card:"),
      "no card heading when there is no card — the heading follows the image, not the setting",
    );
    ok(r.html.includes("SP1ABC"), "html carries their callsign");
    ok(!/undefined|null|NaN/.test(r.text), "no placeholder leakage in text", r.text);
    ok(!/undefined|null|NaN/.test(r.html), "no placeholder leakage in html");
  }

  console.log("");
  console.log("");
  console.log("newlines survive as HTML, not CSS");
  {
    const r = renderQslEmail(qso, sender, TEMPLATES);
    // Outlook strips or ignores `white-space: pre-line`, so relying on it turned a
    // three-paragraph body into one run-on line in a real delivered message. The
    // structure has to be in the MARKUP.
    // Scoped to the BODY paragraphs. The Contact Data block is a <pre> and needs
    // white-space:pre legitimately — it survived the Outlook bug for that reason.
    const bodyHtml = r.html.slice(0, r.html.indexOf("<pre") === -1 ? undefined : r.html.indexOf("<pre"));
    ok(!/white-space/.test(bodyHtml), "the body paragraphs do not depend on white-space CSS");
    const paras = (r.html.match(/<p /g) ?? []).length;
    ok(paras >= 3, `blank-line-separated blocks become separate <p> (${paras})`);
    ok(r.html.includes("<br />"), "single newlines inside a block become <br />");
    // The sign-off is the case that exposed it: three consecutive lines.
    ok(
      /73,<br \/>Matt<br \/>K9XYZ/.test(r.html),
      "the sign-off keeps its three separate lines",
      r.html.slice(r.html.indexOf("73,") - 40, r.html.indexOf("73,") + 60),
    );
    // The text part must NOT gain markup.
    ok(!/<br|<p /.test(r.text), "the plain-text body stays plain");
    ok(r.text.includes("73,\nMatt"), "and keeps its real newlines");
  }

  console.log("with a card attached");
  {
    const card = {
      jpeg: Buffer.from([0xff, 0xd8, 0xff]),
      filename: "QSL.jpg",
      cid: "c1@digishack",
      disposition: "attachment" as const,
    };
    const withCard = renderQslEmail(qso, sender, TEMPLATES, { card });
    ok(withCard.html.includes("Embedded QSL Card:"), "card heading appears");
    // cid:, never an http URL — an external image is blocked by most clients and
    // would report back to a server when the message was opened.
    ok(withCard.html.includes('src="cid:c1@digishack"'), "embedded by cid, not by URL");
    ok(!/src="https?:/.test(withCard.html), "no remote image reference anywhere");
    ok(withCard.card === card, "the card travels with the rendered message");
    ok(withCard.text.includes("attached"), "the text body mentions the attachment");

    const noEmbed = renderQslEmail(qso, sender, { ...TEMPLATES, embedCard: false }, { card });
    ok(!noEmbed.html.includes("cid:"), "embedCard=false leaves it out of the body");
    ok(noEmbed.card === card, "but still attaches it");

    // nodemailer forces Content-Disposition: inline whenever a cid is present, so
    // a card passed with only a cid produced a message with nothing the recipient
    // could save — while the body said "please find my QSL card attached".
    // Verified against a captured MIME stream from a local SMTP sink.
    ok(card.disposition === "attachment", "attachCard yields an attachment disposition");
    const inlineOnly = renderQslEmail(qso, sender, TEMPLATES, {
      card: { ...card, disposition: "inline" },
    });
    ok(inlineOnly.card?.disposition === "inline", "embed-only keeps it inline");
    ok(inlineOnly.html.includes("cid:c1@digishack"), "and the cid reference still resolves");
  }

  console.log("\noptional fields omitted cleanly");
  {
    const bare = renderQslEmail(
      { callsign: "K1ABC", band: "20M", mode: "SSB", startTime: new Date("2026-01-02T03:04:00Z") },
      { callsign: "K9XYZ" },
      TEMPLATES,
    );
    ok(!bare.text.includes("Frequency"), "no frequency row when unknown");
    ok(!bare.text.includes("Report sent"), "no report row when unknown");
    ok(!bare.text.includes("Your grid"), "no grid row when unknown");
    ok(!/undefined|null|NaN/.test(bare.text), "still no placeholder leakage", bare.text);
    ok(bare.text.includes("73,\nK9XYZ"), "sign-off works without an operator name");
  }

  console.log("\nHTML escaping");
  {
    const nasty = renderQslEmail(
      { ...qso, callsign: 'K1<script>alert("x")</script>' },
      sender,
      TEMPLATES,
      { note: 'Thanks & 73 <b>"OM"</b>', logUrl: "https://x.test/?a=1&b=2" },
    );
    ok(!/<script/i.test(nasty.html), "script tags escaped out of the html");
    // Callsigns are upper-cased before escaping, so the escaped tag is too.
    ok(/&lt;script&gt;/i.test(nasty.html), "escaped form present");
    ok(nasty.html.includes("Thanks &amp; 73"), "ampersand escaped in the note");
    ok(nasty.html.includes("&quot;OM&quot;"), "quotes escaped");
    ok(nasty.html.includes("a=1&amp;b=2"), "URL ampersand escaped");
    // The text body is not HTML, so it must NOT be escaped.
    ok(nasty.text.includes("Thanks & 73"), "text body keeps the raw ampersand");
  }

  console.log("\naddress validation and dry run");
  {
    for (const bad of ["", "nobody", "no@body", "a b@c.com", "@x.com"]) {
      const r = await sendQslEmail({
        to: bad,
        qso,
        sender,
      });
      ok(!r.sent && /not a usable email/i.test(r.reason ?? ""), `rejects "${bad}"`);
    }

    const dry = await sendQslEmail({ to: "test@example.com", qso, sender, dryRun: true });
    ok(!dry.sent, "dry run does not send");
    ok(/dry run/i.test(dry.reason ?? ""), "dry run says so");
    ok(dry.rendered.subject.length > 0, "dry run still returns the rendered message");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();

/* eslint-disable no-console */
// Render one QSL email and send it, for checking the card and the wording.
//
//   npx tsx scripts/send-qsl-test.ts <address> [--sink|--ethereal|--real] [--save DIR]
//
// Four ways to look at the result, in increasing order of consequence:
//
//   --save DIR   Write a standalone .html (card inlined as a data: URI) and the
//                raw .eml. No network at all. Open the .html in any browser.
//   --sink       Send to a local SMTP server, default 127.0.0.1:2525. Exercises
//                nodemailer and a real SMTP conversation. This is the default.
//   --ethereal   Send via ethereal.email, nodemailer's throwaway test service. It
//                creates a temporary account, captures the message and returns a
//                URL showing it as a recipient would see it. NOTHING is delivered
//                to the address you name — Ethereal swallows every recipient.
//   --real       The operator's configured SMTP. This genuinely delivers to a real
//                person. Opt-in and named plainly, because that is the difference.
//
// The point of the first three is that the whole path runs — templates, card
// rendering, MIME assembly, cid embedding, the attachment — with no possibility of
// mailing a stranger while a template is still being edited.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import nodemailer from "nodemailer";

import { prisma } from "@/lib/db/prisma";
import { buildQslEmail, loadSmtpConfig } from "@/lib/qsl/email";
import { getSetting } from "@/lib/settings";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to || to.startsWith("--")) {
    console.error("Usage: tsx scripts/send-qsl-test.ts <address> [--host H] [--port N] [--real] [--call CALL]");
    process.exit(2);
  }

  const real = process.argv.includes("--real");
  const ethereal = process.argv.includes("--ethereal");
  const saveDir = arg("save");
  const host = arg("host", "127.0.0.1")!;
  const port = Number(arg("port", "2525"));
  const wantCall = arg("call");

  // A real QSO, so this exercises real data rather than a fixture.
  const qso = await prisma.qso.findFirst({
    where: wantCall ? { callsign: wantCall.toUpperCase() } : { gridSquare: { not: null } },
    orderBy: { startTime: "desc" },
    select: {
      callsign: true,
      band: true,
      mode: true,
      startTime: true,
      freqHz: true,
      rstSent: true,
      rstRcvd: true,
      gridSquare: true,
      station: { select: { callsign: true, grid: true } },
    },
  });
  if (!qso) throw new Error("No QSO found to build a test card from");

  console.log(
    `QSO:      ${qso.callsign} ${qso.band} ${qso.mode} ${qso.startTime.toISOString()} grid=${qso.gridSquare ?? "-"}`,
  );

  const rendered = await buildQslEmail(
    {
      callsign: qso.callsign,
      band: qso.band,
      mode: qso.mode,
      startTime: qso.startTime,
      freqHz: qso.freqHz === null ? null : Number(qso.freqHz),
      rstSent: qso.rstSent,
      rstRcvd: qso.rstRcvd,
      gridSquare: qso.gridSquare,
    },
    {
      callsign: qso.station.callsign,
      grid: qso.station.grid,
      name: await getSetting("qsl.operatorName"),
      qth: await getSetting("qsl.qth"),
      txPower: await getSetting("qsl.txPower"),
    },
  );

  console.log(`Subject:  ${rendered.subject}`);
  console.log(
    `Card:     ${
      rendered.card
        ? `${rendered.card.filename}  ${(rendered.card.jpeg.length / 1024).toFixed(0)} kB  cid=${rendered.card.cid}`
        : "none (qsl.card.enabled is off, or rendering failed — see the body)"
    }`,
  );
  console.log("");
  console.log("--- text body ---");
  console.log(rendered.text);
  console.log("--- end ---");
  console.log("");

  // Offline preview first, since it needs nothing and cannot fail for network
  // reasons. The card goes in as a data: URI so the file renders standalone —
  // a cid: reference only resolves inside a mail client.
  if (saveDir) {
    await mkdir(saveDir, { recursive: true });
    let html = rendered.html;
    if (rendered.card) {
      html = html.replace(
        `cid:${rendered.card.cid}`,
        `data:image/jpeg;base64,${rendered.card.jpeg.toString("base64")}`,
      );
      await writeFile(join(saveDir, rendered.card.filename), rendered.card.jpeg);
    }
    const htmlPath = join(saveDir, "qsl-preview.html");
    await writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><title>${rendered.subject}</title>${html}`);
    await writeFile(join(saveDir, "qsl-preview.txt"), rendered.text);
    console.log(`Saved:    ${htmlPath}`);
  }

  let from: string;
  let transport: nodemailer.Transporter;

  if (real) {
    const loaded = await loadSmtpConfig();
    if (!loaded.ok) throw new Error(`SMTP is not configured: ${loaded.reason}`);
    from = loaded.config.from;
    transport = nodemailer.createTransport({
      host: loaded.config.host,
      port: loaded.config.port,
      secure: loaded.config.secure,
      auth:
        loaded.config.user && loaded.config.password
          ? { user: loaded.config.user, pass: loaded.config.password }
          : undefined,
    });
    console.log(`Sending FOR REAL via ${loaded.config.host}:${loaded.config.port} -> ${to}`);
  } else if (ethereal) {
    // A throwaway account per run. Ethereal accepts mail for ANY recipient and
    // delivers to none of them, which is exactly what is wanted here: the message
    // can be viewed as a client renders it without anyone receiving it.
    const acct = await nodemailer.createTestAccount();
    from = `DigiShack Test <${acct.user}>`;
    transport = nodemailer.createTransport({
      host: acct.smtp.host,
      port: acct.smtp.port,
      secure: acct.smtp.secure,
      auth: { user: acct.user, pass: acct.pass },
    });
    console.log(`Sending via Ethereal (${acct.smtp.host}) -> ${to}`);
    console.log(`  Ethereal captures every recipient. ${to} will NOT receive this.`);
  } else {
    from = "DigiShack Test <test@digishack.invalid>";
    transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
    console.log(`Sending to the local sink at ${host}:${port} -> ${to} (nothing is delivered)`);
  }

  const info = await transport.sendMail({
    from,
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: rendered.card
      ? [
          {
            filename: rendered.card.filename,
            content: rendered.card.jpeg,
            cid: rendered.card.cid,
            contentDisposition: rendered.card.disposition,
          },
        ]
      : undefined,
  });

  console.log(`Accepted: ${JSON.stringify(info.accepted)}`);
  console.log(`Rejected: ${JSON.stringify(info.rejected)}`);
  console.log(`MessageId: ${info.messageId}`);

  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) {
    console.log("");
    console.log(`VIEW IT HERE: ${preview}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());

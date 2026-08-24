import nodemailer, { type Transporter } from "nodemailer";

import { loadCardSettings, renderQslCard } from "@/lib/qsl/card";
import { rulesFor, withWl2kPrefix } from "@/lib/qsl/gateways";
import { applyTemplate, renderTemplate, templateValues } from "@/lib/qsl/template";
import { getSetting, getBooleanSetting, getNumberSetting } from "@/lib/settings";

// QSL confirmation email.
//
// These are unsolicited messages to other operators, which shapes every decision
// here:
//
//   * One QSO per email, addressed to one person. No bulk BCC.
//   * The template states plainly who is writing, which contact it refers to and
//     that no reply is expected. A QSL that reads like marketing is worse than no
//     QSL at all.
//   * `renderQslEmail` is pure and separately tested, so the wording and the
//     escaping can be verified without an SMTP server or sending anything.
//   * Sending requires an explicit recipient — nothing here looks up an address
//     on its own, so a bug cannot mail someone who was never chosen.

export interface QslQsoDetails {
  callsign: string;
  band: string;
  mode: string;
  /** UTC start of the contact. */
  startTime: Date;
  freqHz?: number | null;
  rstSent?: string | null;
  rstRcvd?: string | null;
  gridSquare?: string | null;
  /** ADIF TX_PWR — measured watts for this contact. Beats the station constant. */
  txPowerW?: number | null;
}

export interface QslSender {
  /** Our callsign. */
  callsign: string;
  /** Operator name, for the sign-off. */
  name?: string | null;
  grid?: string | null;
  qth?: string | null;
  /** Transmit power as text, from Settings. Fills {POWER}. */
  txPower?: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /**
   * The rendered card, when one was produced.
   *
   * Carried on the rendered message rather than fetched at send time so the
   * review queue sends exactly what a human approved — including the card. A
   * template or artwork change between approval and send must not alter an
   * approved message.
   */
  card?: {
    jpeg: Buffer;
    filename: string;
    cid: string;
    /**
     * How the part is presented.
     *
     * "attachment" keeps a Content-ID as well, so the HTML can still show it
     * inline AND the client lists it as a saveable file — which is what a body
     * reading "please find my QSL card attached" requires.
     */
    disposition: "inline" | "attachment";
  };
}

/** Templates and station details, loaded from Settings. */
export interface QslTemplates {
  subject: string;
  body: string;
  contactDataHeading: string;
  contactData: string;
  cardHeading: string;
  embedCard: boolean;
  attachCard: boolean;
}

export async function loadQslTemplates(): Promise<QslTemplates> {
  return {
    subject:
      (await getSetting("qsl.email.subject")) ??
      "QSL Confirmation for {THEIR_CALL} / {MY_CALL} QSO",
    body: (await getSetting("qsl.email.body")) ?? "",
    contactDataHeading: (await getSetting("qsl.email.contactDataHeading")) ?? "Contact Data",
    contactData: (await getSetting("qsl.email.contactData")) ?? "",
    cardHeading: (await getSetting("qsl.email.cardHeading")) ?? "",
    embedCard: await getBooleanSetting("qsl.email.embedCard", true),
    attachCard: await getBooleanSetting("qsl.email.attachCard", true),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn plain text into email-safe HTML paragraphs.
 *
 * Blank-line-separated blocks become <p>, and single newlines inside a block
 * become <br />. Explicit markup, NOT `white-space: pre-line`.
 *
 * The previous version emitted `<p style="white-space:pre-line">` and trusted the
 * client to honour it. Outlook does not — it strips or ignores the declaration —
 * so a body written as
 *
 *     AB8DE,
 *
 *     Thank you for the QSO...
 *
 *     73,
 *     Sam Example
 *     K9XYZ
 *
 * arrived as one run-on paragraph: "AB8DE, Thank you for the QSO... 73, Sam Example
 * K9XYZ". The Contact Data block escaped only because it sits inside <pre>.
 *
 * Email clients strip CSS aggressively and Outlook's engine is the least forgiving
 * of them, so anything structural has to be in the markup itself.
 */
function htmlParagraphs(text: string): string {
  const NL = String.fromCharCode(10);
  return text
    .split(new RegExp(`${NL}{2,}`))
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p style="margin:0 0 12px">${block
          .split(NL)
          .map((line) => escapeHtml(line))
          .join("<br />")}</p>`,
    )
    .join(NL);
}

/**
 * Render the QSL email from the operator's templates.
 *
 * Both a plain-text and an HTML body: many amateurs read mail in clients that
 * show text only, and a QSL that arrives as an empty message is embarrassing.
 *
 * `card` is passed in rather than rendered here so this function stays pure and
 * testable — rendering needs the filesystem and sharp.
 */
export function renderQslEmail(
  qso: QslQsoDetails,
  sender: QslSender,
  templates: QslTemplates,
  opts: {
    note?: string | null;
    logUrl?: string | null;
    /**
     * One-click opt-out link, per recipient.
     *
     * Optional because `renderQslEmail` stays pure and callers that have no public URL for
     * this instance cannot build one — a broken link would be worse than none.
     */
    unsubscribeUrl?: string | null;
    card?: RenderedEmail["card"];
  } = {},
): RenderedEmail {
  const values = templateValues(qso, sender);

  const subject = applyTemplate(templates.subject, values).trim();
  const body = renderTemplate(templates.body, values);
  const detail = templates.contactData ? renderTemplate(templates.contactData, values) : "";

  const textParts: string[] = [body];
  if (detail) {
    textParts.push("", ...(templates.contactDataHeading ? [templates.contactDataHeading] : []), detail);
  }
  if (opts.note) textParts.push("", opts.note);
  if (opts.card && templates.attachCard) {
    textParts.push("", "The QSL card is attached.");
  }
  if (opts.logUrl) textParts.push("", `Log: ${opts.logUrl}`);
  // THE UNSUBSCRIBE LINE.
  //
  // Last, plainly worded, and in every message. K2XYZ replied to one of these with the
  // single word "Unsubscribe" because there was nothing to click and no instruction to
  // follow — his only route was to write to a human and hope one read it. One link removes
  // that entirely.
  //
  // Worded as QSL EMAIL rather than "unsubscribe", because this is not a mailing list and
  // the difference matters to the reader: clicking it stops cards, not contacts.
  if (opts.unsubscribeUrl) {
    textParts.push(
      "",
      "---",
      `Would you rather not receive QSL email from me? One click, no reply needed:`,
      opts.unsubscribeUrl,
    );
  }
  const text = textParts.join("\n");

  const htmlParts: string[] = [
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">`,
    htmlParagraphs(body),
  ];
  if (detail) {
    if (templates.contactDataHeading) {
      htmlParts.push(`<p style="margin-bottom:4px"><strong>${escapeHtml(templates.contactDataHeading)}</strong></p>`);
    }
    // Fixed-width, mirroring how the operator's existing emailer presents it —
    // aligned labels read as data rather than prose.
    htmlParts.push(
      `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;margin:0 0 12px;white-space:pre">${escapeHtml(detail)}</pre>`,
    );
  }
  if (opts.note) htmlParts.push(htmlParagraphs(opts.note));
  if (opts.card && templates.embedCard) {
    if (templates.cardHeading) {
      htmlParts.push(`<p style="margin-bottom:6px"><strong>${escapeHtml(templates.cardHeading)}</strong></p>`);
    }
    // cid: reference, so the card shows inline from the attachment rather than
    // being fetched from a server — an external image would be blocked by most
    // clients and would leak when the message was opened.
    htmlParts.push(
      `<img src="cid:${escapeHtml(opts.card.cid)}" alt="QSL card" style="max-width:100%;height:auto;border:0" />`,
    );
  }
  if (opts.logUrl) {
    htmlParts.push(`<p><a href="${escapeHtml(opts.logUrl)}">${escapeHtml(opts.logUrl)}</a></p>`);
  }
  if (opts.unsubscribeUrl) {
    // Small and grey, below a rule: present for anyone looking for it, not competing with
    // the card. Deliberately a plain link rather than a styled button — a button in an
    // unsolicited email reads as marketing, which is precisely the impression to avoid.
    htmlParts.push(
      `<hr style="border:0;border-top:1px solid #ddd;margin:16px 0" />`,
      `<p style="font-size:12px;color:#777;margin:0">Would you rather not receive QSL email from me? ` +
        `<a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#777">Unsubscribe in one click</a> — no reply needed.</p>`,
    );
  }
  htmlParts.push(`</div>`);

  return { subject, text, html: htmlParts.join("\n"), card: opts.card };
}


/**
 * Load templates, render the card, and build the message.
 *
 * Separate from `renderQslEmail`, which stays pure: this one touches Settings and
 * the filesystem. A card that fails to render does NOT fail the email — the
 * reason is carried through as a note so the operator sees it, because a
 * text-only QSL is still a QSL while a silent failure is not.
 */
export async function buildQslEmail(
  qso: QslQsoDetails,
  sender: QslSender,
  opts: {
    note?: string | null;
    logUrl?: string | null;
    unsubscribeUrl?: string | null;
  } = {},
): Promise<RenderedEmail> {
  const templates = await loadQslTemplates();
  let card: RenderedEmail["card"];
  let cardProblem: string | null = null;

  const cardCfg = await loadCardSettings();
  if (cardCfg.enabled) {
    try {
      const rendered = await renderQslCard(qso, sender, cardCfg);
      card = {
        jpeg: rendered.jpeg,
        filename: `QSL-${sender.callsign.toUpperCase()}-${qso.callsign.toUpperCase()}-${qso.startTime.toISOString().slice(0, 10)}.jpg`,
        // Stable per message, and not guessable across messages.
        cid: `qslcard-${qso.startTime.getTime().toString(36)}@digishack`,
        // The operator's two switches are genuinely independent: attach makes it
        // saveable, embed shows it in the body. Both on is the normal case.
        disposition: templates.attachCard ? "attachment" : "inline",
      };
    } catch (err) {
      cardProblem = err instanceof Error ? err.message : "Card rendering failed";
    }
  }

  const note = [opts.note, cardProblem].filter(Boolean).join("\n") || null;
  return renderQslEmail(qso, sender, templates, { ...opts, note, card });
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

/** Read SMTP configuration, or explain what is missing. */
export async function loadSmtpConfig(): Promise<
  { ok: true; config: SmtpConfig } | { ok: false; reason: string }
> {
  const host = await getSetting("smtp.host");
  const from = await getSetting("smtp.from");
  if (!host) return { ok: false, reason: "smtp.host is not set" };
  if (!from) return { ok: false, reason: "smtp.from is not set" };

  return {
    ok: true,
    config: {
      host,
      port: await getNumberSetting("smtp.port", 587),
      secure: await getBooleanSetting("smtp.secure", false),
      user: await getSetting("smtp.user"),
      password: await getSetting("smtp.password"),
      from,
    },
  };
}

function transportFor(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
  });
}

/**
 * Check the SMTP settings actually work, without sending anything.
 *
 * `verify()` opens the connection and completes the handshake and login, then
 * disconnects. That distinguishes "the settings are wrong" from "the message was
 * rejected", which are very different problems to debug.
 */
export async function verifySmtp(): Promise<{ ok: boolean; detail: string }> {
  const loaded = await loadSmtpConfig();
  if (!loaded.ok) return { ok: false, detail: loaded.reason };

  const transport = transportFor(loaded.config);
  try {
    await transport.verify();
    return {
      ok: true,
      detail: `Connected to ${loaded.config.host}:${loaded.config.port} and authenticated`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "SMTP verify failed" };
  } finally {
    transport.close();
  }
}

export interface SendResult {
  sent: boolean;
  messageId?: string;
  reason?: string;
}

/**
 * Send a small plain-text message from the system itself — password resets, and
 * whatever operational mail comes next. Lives here because this file owns the SMTP
 * transport; a second transport in lib/auth would be a second set of settings to
 * drift. No templates, no attachments: system mail should read like a telegram.
 */
export async function sendSystemEmail(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<SendResult> {
  const loaded = await loadSmtpConfig();
  if (!loaded.ok) return { sent: false, reason: loaded.reason };

  const transport = transportFor(loaded.config);
  try {
    const info = await transport.sendMail({
      from: loaded.config.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "send failed" };
  } finally {
    transport.close();
  }
}

/** Send one QSL email to one recipient. */
export async function sendQslEmail(args: {
  to: string;
  qso: QslQsoDetails;
  sender: QslSender;
  note?: string | null;
  logUrl?: string | null;
  /** One-click opt-out link for this recipient; also sent as List-Unsubscribe. */
  unsubscribeUrl?: string | null;
  /**
   * Where to view the card, for recipients whose gateway cannot carry the image.
   *
   * Only used when the gateway rules drop the card. Optional because a caller with no
   * public URL configured cannot build one, and a broken link is worse than none.
   */
  cardUrl?: string | null;
  /** Render and report, but do not send. */
  dryRun?: boolean;
  /**
   * Send this exact message instead of rendering one.
   *
   * Used by the review queue: the body a human approved must be the body that
   * goes out, so re-rendering at send time is not acceptable — a template edit
   * between approval and send would silently change an approved message.
   */
  preRendered?: RenderedEmail;
}): Promise<SendResult & { rendered: RenderedEmail }> {
  const rendered = args.preRendered ?? (await buildQslEmail(args.qso, args.sender, {
    note: args.note,
    logUrl: args.logUrl,
  }));

  // A syntactically impossible address is a caller bug, not an SMTP failure.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.to)) {
    return { sent: false, reason: `"${args.to}" is not a usable email address`, rendered };
  }

  if (args.dryRun) {
    return { sent: false, reason: "Dry run — nothing sent", rendered };
  }

  const loaded = await loadSmtpConfig();
  if (!loaded.ok) return { sent: false, reason: loaded.reason, rendered };

  // Winlink and arrl.net are not ordinary mailboxes — see lib/qsl/gateways.ts.
  //
  // Applied HERE rather than only at queue time so a row queued before these rules
  // existed is still handled correctly, and so nothing can send HTML or a 200 kB
  // JPEG over a radio link by taking a different code path to the transport.
  const gateway = rulesFor(args.to);
  const html = gateway.plainTextOnly ? undefined : rendered.html;
  const card = gateway.dropCard ? undefined : rendered.card;
  // A LINK INSTEAD OF THE CARD, when the card cannot travel.
  //
  // Dropping the image is right for both gateways and left those operators with a QSL
  // email containing no QSL and no way to see one. A link costs forty characters on a
  // channel where the attachment cost 200 kB, and it is fetched later over the recipient's
  // ordinary connection rather than over the radio link the message arrived on.
  //
  // Appended to the TEXT body here rather than rendered upstream, for the same reason the
  // gateway rules are applied here: a row queued before this existed carries a stored body
  // without it, and there are hundreds of those waiting.
  const text =
    gateway.dropCard && args.cardUrl
      ? `${rendered.text}

Your card is an image, which does not travel well to this ` +
        `address, so it is here instead:
${args.cardUrl}`
      : rendered.text;
  // The //WL2K key is applied here as well as at queue time, because a row queued
  // BEFORE these rules existed carries a stored subject without it — and there are
  // hundreds of those waiting. `withWl2kPrefix` is idempotent, so a row that already
  // has it is unchanged.
  const subject =
    gateway.gateway === "winlink" ? withWl2kPrefix(rendered.subject) : rendered.subject;

  const transport = transportFor(loaded.config);
  try {
    const info = await transport.sendMail({
      from: loaded.config.from,
      to: args.to,
      subject,
      text,
      html,
      // LIST-UNSUBSCRIBE, so the mail client offers its own button.
      //
      // This is the mechanism behind the "Unsubscribe" control Gmail and Outlook show
      // beside a sender's name, and it is why it is worth setting even though the body
      // already carries a link: a recipient who reaches for the client's own button gets
      // the same result instead of concluding there is no way out.
      //
      // One-Click needs POST, per RFC 8058, and the endpoint accepts both — the header
      // pair is only honoured when both are present, and a GET-only URL here would show
      // the button and then fail to work.
      ...(args.unsubscribeUrl
        ? {
            headers: {
              "List-Unsubscribe": `<${args.unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
      // ONE part, carrying both a Content-ID and an explicit disposition.
      //
      // nodemailer forces `Content-Disposition: inline` whenever a `cid` is
      // present, so an earlier version that passed only `cid` produced a message
      // with no multipart/mixed container and nothing the recipient could save —
      // while the body said "please find my QSL card attached". Setting the
      // disposition explicitly keeps the cid reference working for the inline
      // image and still lists the file, without sending 200 kB twice.
      attachments: card
        ? [
            {
              filename: card.filename,
              content: card.jpeg,
              cid: card.cid,
              contentDisposition: card.disposition,
            },
          ]
        : undefined,
    });
    return { sent: true, messageId: info.messageId, rendered };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "Send failed",
      rendered,
    };
  } finally {
    transport.close();
  }
}

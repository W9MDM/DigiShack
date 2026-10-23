import type { NextApiRequest, NextApiResponse } from "next";

import { clientIp } from "@/lib/auth/client-ip";
import { UNSUBSCRIBE_LIMIT } from "@/lib/auth/throttle";
import { escapeHtml } from "@/lib/html";
import { optOut, tokenValid } from "@/lib/qsl/opt-out";

// The one-click opt-out endpoint.
//
// DELIBERATELY UNAUTHENTICATED, and that is not an oversight. The person clicking is a
// stranger who has no account here and never will; requiring a login would make the link
// useless to exactly the people it exists for. The token is an HMAC of their callsign, so
// the link only ever works for the address it was mailed to.
//
// The worst a forged token achieves is that somebody stops receiving unsolicited email
// they never asked for. That is not an attack worth defending against, which is why there
// is no confirmation step: a confirmation page is one more thing between a person and the
// outcome they have already asked for twice.
//
// IT IS RATE LIMITED, per address, and not because of forged tokens. It is the one
// endpoint the whole internet may call without an account, and each valid call is a
// database write, so it gets a budget of its own (UNSUBSCRIBE_LIMIT, lib/auth/throttle.ts)
// on top of nginx's. Spent before the token is checked, so it also caps guessing. Sized for
// people, with room for a mail provider's One-Click POSTs arriving from one server.
//
// GET and POST both. GET is the link in the body; POST is RFC 8058 One-Click, which is
// what Gmail and Outlook use for their own Unsubscribe button. A GET-only endpoint would
// make that button appear and then fail.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).end("Method not allowed");
    return;
  }

  // Same address helper as the login throttle: through the tunnel the socket is loopback.
  const ip = clientIp({ headers: req.headers, socketAddress: req.socket.remoteAddress }) ?? "unknown";
  const limited = UNSUBSCRIBE_LIMIT.hit(ip);
  if (!limited.allowed) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    res.setHeader("Cache-Control", "no-store");
    res.status(429).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      page(
        "Too many requests",
        `This address has made too many requests in the last minute. Try the link again in ${limited.retryAfterSeconds} seconds, ` +
          "or reply to the email and it will be handled by hand.",
      ),
    );
    return;
  }

  const call = typeof req.query.call === "string" ? req.query.call : "";
  const token = typeof req.query.t === "string" ? req.query.t : "";

  if (!call || !tokenValid(call, token)) {
    // No detail, and no hint about which half was wrong. Nothing here is worth probing,
    // but a stranger reading an error message deserves a next step rather than a code.
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      page(
        "That link did not work",
        "The unsubscribe link looks incomplete — some mail programs break long links across lines. " +
          "Reply to the email instead and it will be handled by hand.",
      ),
    );
    return;
  }

  try {
    await optOut(call, "LINK", "Clicked the unsubscribe link in a QSL email");
  } catch {
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      page(
        "Something went wrong",
        "The request could not be recorded. Reply to the email and it will be handled by hand — " +
          "you will not be emailed again either way.",
      ),
    );
    return;
  }

  // 200 with a page for a browser; the One-Click POST ignores the body and wants the 200.
  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    page(
      "Done — no more QSL email",
      `${call.toUpperCase()} has been removed. No further QSL cards will be emailed to you from this station. ` +
        "This does not affect contacts on the air, uploads to LoTW, eQSL, QRZ or Clublog, or anything else. " +
        "Sorry for the nuisance, and 73.",
    ),
  );
}

/** A self-contained page. No stylesheet, no fonts, nothing fetched — a stranger's browser. */
function page(title: string, body: string): string {
  const esc = escapeHtml;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)}</title></head>
<body style="font-family:Helvetica,Arial,sans-serif;line-height:1.5;max-width:34em;margin:12vh auto;padding:0 1.2em;color:#222">
<h1 style="font-size:1.3rem;margin:0 0 .6em">${esc(title)}</h1>
<p style="margin:0">${esc(body)}</p>
</body></html>`;
}

import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { API_HEAVY_LIMIT } from "@/lib/auth/throttle";
import { getSendProvider } from "@/lib/mail/providers";
import { sendSystemEmail } from "@/lib/qsl/email";
import { getSetting } from "@/lib/settings";

// POST /api/mail/test-send — send ONE short message to the station itself, through whichever
// service Settings says sends mail.
//
// The only proof a sender works is a message that arrives; a sign-in proves the credentials,
// not the permission to send. So this sends — but only when pressed, and only to the station's
// own addresses: the alerts address if one is set, otherwise the mailbox it is sent from,
// otherwise the signed-in admin. Never to an address in the request, so the button cannot be
// used to mail anybody else.

function address(raw: string | null): string | null {
  const a = (/<([^>]+)>/.exec(raw ?? "")?.[1] ?? raw ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
}

async function post(_req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const provider = await getSendProvider();
  const to =
    address(await getSetting("alerts.email")) ??
    (provider === "graph" ? address(await getSetting("ms365.mailbox")) : null) ??
    address(await getSetting("smtp.from")) ??
    address(auth.user.email);
  if (!to) {
    sendJson(res, 200, { ok: false, detail: "There is no station address to send a test to. Set the alerts address in Settings → System." });
    return;
  }
  const via = provider === "graph" ? "Microsoft 365" : "SMTP";
  const r = await sendSystemEmail({
    to,
    subject: "[DigiShack] Test message",
    text: [
      `This is a test from DigiShack, sent through ${via} because somebody pressed Send a test message.`,
      "",
      "If it arrived, QSL cards and alerts will go out the same way. Nothing else was sent.",
    ].join("\n"),
  });
  sendJson(res, 200, r.sent ? { ok: true, detail: `Sent through ${via} to ${to}. Check that it arrived.` } : { ok: false, detail: `${via} did not send it: ${r.reason ?? "no detail"}` });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post, rateLimit: API_HEAVY_LIMIT } });

import type { NextApiRequest, NextApiResponse } from "next";

import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { exchangeCode, storeRefreshToken } from "@/lib/integrations/youtube-api";

import { baseUrlFrom, consumeState } from "./connect";

// Where Google returns after the operator approves.
//
// RENDERS A PAGE, not JSON: a browser lands here, not a script. It is the only route in the
// application that answers HTML, and it does so because Google chose the destination.
//
// The refresh token is written and NEVER shown. It is a standing grant to act as the
// channel, so the page says "connected" and nothing more — a token echoed onto a screen is
// a token in a screenshot.

function page(title: string, body: string, ok: boolean): string {
  const colour = ok ? "#4ad27a" : "#dc5050";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{background:#16161c;color:#f2f2f4;font:16px/1.6 system-ui,sans-serif;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:34rem;padding:2rem}
h1{font-size:1.3rem;margin:0 0 .75rem;color:${colour}}
p{color:#babac5;margin:0 0 1rem}
a{color:#58a6ff}
</style></head><body><main><h1>${title}</h1><p>${body}</p>
<p><a href="/settings">Back to settings</a></p></main></body></html>`;
}

async function get(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const denied = typeof req.query.error === "string" ? req.query.error : null;

  if (denied) {
    res.status(400).send(page("Not connected", `Google reported: ${denied}`, false));
    return;
  }
  if (!code || !state) {
    res.status(400).send(page("Not connected", "Google returned no authorisation code.", false));
    return;
  }
  // THE STATE CHECK, which is the only thing stopping a code from somebody else's Google
  // account being handed to this station and stored as ours.
  if (!consumeState(state)) {
    res
      .status(400)
      .send(
        page(
          "Not connected",
          "That authorisation link has expired or was already used. Start again from Settings.",
          false,
        ),
      );
    return;
  }

  const clientId = (await getSetting("youtube.clientId"))?.trim();
  const clientSecret = (await getSetting("youtube.clientSecret"))?.trim();
  if (!clientId || !clientSecret) {
    res.status(400).send(page("Not connected", "The client ID or secret is missing.", false));
    return;
  }

  try {
    const tokens = await exchangeCode(code, clientId, clientSecret, baseUrlFrom(req));
    await storeRefreshToken(tokens.refreshToken!, auth.user.id);
    res
      .status(200)
      .send(
        page(
          "Connected to YouTube",
          "DigiShack can now rename the broadcast and read live chat. The token is stored " +
            "encrypted on this server and is never shown again — revoke it any time at " +
            "myaccount.google.com/permissions.",
          true,
        ),
      );
  } catch (e) {
    res.status(400).send(page("Not connected", (e as Error).message, false));
  }
}

export default authedRoute({ GET: { role: "ADMIN", handler: get } });

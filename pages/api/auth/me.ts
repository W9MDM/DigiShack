import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendJson } from "@/lib/api/respond";
import { getAuth, needsSetup } from "@/lib/auth/session";

// Returns 200 in both cases rather than 401 when signed out: this is the endpoint
// the client uses to *discover* its auth state, and a 401 here would be noise in
// the console on every visit to the login page.
async function get(req: NextApiRequest, res: NextApiResponse) {
  const auth = await getAuth(req);

  if (!auth) {
    sendJson(res, 200, {
      user: null,
      needsSetup: await needsSetup(),
    });
    return;
  }

  sendJson(res, 200, { user: auth.user, needsSetup: false });
}

export default route({ GET: get });

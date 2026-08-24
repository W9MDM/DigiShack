import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import {
  checkForUpdate,
  isRunning,
  performUpdate,
  readState,
} from "@/lib/update/runner";

// GET               current version, branch, whether behind, and the last run's state
// POST ?action=check  refresh the comparison against the remote
// POST ?action=run    fetch, install, migrate, build, reload
//
// ADMIN on both. `run` additionally requires update.allowFromUi, which is off by
// default — see lib/update/runner.ts for why.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, {
    state: readState(),
    running: isRunning(),
  });
}

async function post(
  req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) {
  const action = req.query.action === "run" ? "run" : "check";

  if (action === "check") {
    sendJson(res, 200, { check: await checkForUpdate(), state: readState() });
    return;
  }

  if (isRunning()) {
    sendError(res, 409, "An update is already in progress.");
    return;
  }

  const check = await checkForUpdate();
  if (!check.allowed) {
    sendError(
      res,
      403,
      "Updating from the UI is turned off. Enable it under Settings → Software updates.",
    );
    return;
  }

  // Started, not awaited: the run takes minutes and ends by replacing this
  // process, so there is no response to send at the end of it. The client polls
  // GET for progress, and the state file survives the reload.
  void performUpdate(`${auth.user.email} (${auth.user.role})`).catch((err) => {
    console.error("[update] run failed:", err);
  });

  sendJson(res, 202, {
    started: true,
    triggeredBy: auth.user.email,
    behind: check.behind,
    incoming: check.incoming,
  });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "ADMIN", handler: post },
});

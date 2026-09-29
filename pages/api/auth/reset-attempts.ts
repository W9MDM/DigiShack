import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { listResetAttempts } from "@/lib/auth/reset-audit";

// Every "forgot password" request, for an administrator to read.
//
// "in the admin UI log password reset requests and the ip they came from" — asked after an
// afternoon spent establishing over SSH that four requests had reached the server that day
// and all four were mine. That evidence should have been a page, and now it is.
//
// ADMIN ONLY, and that is not a formality. These rows are the one place the endpoint's true
// outcome exists: the HTTP response is deliberately identical whether an address has an
// account or not, so that nobody can use the login page to discover who has one. The rows
// break that symmetry — "no-account" against an address says plainly that it has none — so
// they must never be readable by anyone the symmetry was protecting the accounts from.
//
// It is also, incidentally, a list of addresses somebody typed at a login page, which is
// worth keeping behind the highest role on its own merits.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const limit = Number(
    Array.isArray(req.query.limit) ? req.query.limit[0] : (req.query.limit ?? 100),
  );
  const rows = await listResetAttempts(Number.isFinite(limit) ? limit : 100);
  sendJson(res, 200, { rows, total: rows.length });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
});

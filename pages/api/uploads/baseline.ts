import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import {
  SENT_FIELD_FOR,
  UPLOADABLE,
  baselineAsUploaded,
  isConfigured,
  type UploadableService,
} from "@/lib/integrations/upload-runner";

// "Treat everything up to now as already uploaded."
//
// `baselineAsUploaded()` was written, tested, and had no caller — there was no way to reach
// it from a browser, so the honest way to adopt an upload target on a log that predates it
// did not exist. The consequence is not theoretical: N3FJP shows **29,739 contacts
// pending** on this installation, so switching it on today replays the entire log at a
// desktop program on somebody's shack PC.
//
// THIS SETS FLAGS. IT SENDS NOTHING. That is the point — an operator whose 26,000 contacts
// are already at QRZ from a previous logger wants the flags to say so, not 26,000 API calls
// that each come back "duplicate".
//
// It is also effectively IRREVERSIBLE. Once a contact is marked sent, nothing here
// remembers that the mark was asserted rather than earned, and the sweep will never look at
// it again. So two guards:
//
//   1. GET says exactly how many contacts would be marked, for the same cutoff, without
//      touching anything.
//   2. POST requires the caller to echo that number back in `expected`. If the count has
//      moved — a contact logged in between, another operator baselining at the same moment
//      — it refuses and returns the new figure rather than marking a different set than
//      the one the operator was shown. A confirmation dialog that describes 4,992 contacts
//      and then acts on 4,993 is not a confirmation.

/** Contacts this would mark, for a cutoff. The number the operator is shown. */
async function affected(service: UploadableService, before: Date): Promise<number> {
  return prisma.qso.count({
    where: { [SENT_FIELD_FOR(service)]: false, startTime: { lt: before } },
  });
}

const querySchema = z.object({
  service: z.enum(UPLOADABLE),
  /** ISO instant. Defaults to now — "everything I have logged so far". */
  before: z.string().datetime().optional(),
});

async function get(req: NextApiRequest, res: NextApiResponse) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "Which service?", parsed.error.flatten().fieldErrors);
    return;
  }
  const service = parsed.data.service as UploadableService;
  const before = parsed.data.before ? new Date(parsed.data.before) : new Date();
  sendJson(res, 200, {
    service,
    before: before.toISOString(),
    count: await affected(service, before),
    configured: await isConfigured(service),
  });
}

const bodySchema = z.object({
  service: z.enum(UPLOADABLE),
  before: z.string().datetime().optional(),
  /**
   * The count the operator was shown and agreed to. Not optional, and not advisory.
   *
   * Zero is a legitimate value — it means "nothing to do" — so this cannot default.
   */
  expected: z.number().int().min(0),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 400, "Bad baseline request", parsed.error.flatten().fieldErrors);
    return;
  }
  const service = parsed.data.service as UploadableService;
  const before = parsed.data.before ? new Date(parsed.data.before) : new Date();

  const count = await affected(service, before);
  if (count !== parsed.data.expected) {
    // 409, not 400: the request was well-formed and the world moved. The new figure goes
    // back so the caller can show it and ask again rather than guessing.
    sendError(res, 409, `That count has changed — ${count} contacts now match, not ${parsed.data.expected}`, {
      count,
    });
    return;
  }

  const marked = await baselineAsUploaded(service, before);
  sendJson(res, 200, { service, before: before.toISOString(), marked });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  // ADMIN, not OPERATOR. Every other upload route sends contacts and can be undone by
  // sending them again; this one asserts that thousands of contacts were sent when they may
  // not have been, and nothing afterwards can tell the difference.
  POST: { role: "ADMIN", handler: post },
});

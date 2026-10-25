import type { NextApiRequest, NextApiResponse } from "next";

import type { Prisma } from "@prisma/client";

import { queryParam, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { canManageQsl, type AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getReceiveProvider, getSendProvider, loadGraphConfig } from "@/lib/mail/providers";
import { baseCall } from "@/lib/qsl/inbound/classify";
import { getInboundLastRun, IMAP_COMING_NEXT } from "@/lib/qsl/inbound/run";
import { inboundDetail, type InboundCheck } from "@/lib/qsl/inbound/status";
import { getBooleanSetting, getNumberSetting } from "@/lib/settings";

// GET /api/qsl/received              — one view of the received cards, plus counts and status
// GET /api/qsl/received?qsoId=…      — the cards linked to one contact (the contact page)
// GET /api/qsl/received?call=K1ABC   — contacts with that station, for assigning a card by hand
//
// Read-only. The mailbox is never touched from here; that is run.ts.

export type ReceivedView = "cards" | "replies" | "review" | "notices" | "bounces";
const VIEWS: ReceivedView[] = ["cards", "replies", "review", "notices", "bounces"];

const LIMIT = 200;

function whereFor(view: ReceivedView): Prisma.ReceivedQslWhereInput {
  switch (view) {
    case "cards":
      return { imagePath: { not: null }, matchStatus: { not: "DISMISSED" } };
    case "replies":
      // Confirmations with no picture: replies to our card, and cards sent as text.
      return { kind: { in: ["REPLY", "CARD"] }, imagePath: null, matchStatus: "MATCHED" };
    case "review":
      return { kind: { not: "BOUNCE" }, matchStatus: { in: ["AMBIGUOUS", "UNMATCHED"] } };
    case "notices":
      return { kind: "NOTICE", matchStatus: { not: "DISMISSED" } };
    case "bounces":
      return { kind: "BOUNCE" };
  }
}

const SELECT = {
  id: true,
  kind: true,
  callsign: true,
  sender: true,
  subject: true,
  receivedAt: true,
  imagePath: true,
  imageContentType: true,
  imageBytes: true,
  fileName: true,
  link: true,
  matchStatus: true,
  matchNote: true,
  qso: { select: { id: true, callsign: true, band: true, mode: true, startTime: true } },
} satisfies Prisma.ReceivedQslSelect;

type Row = Prisma.ReceivedQslGetPayload<{ select: typeof SELECT }>;

/** What the browser gets: the image as a URL to the authed route, never a filesystem path. */
function present(r: Row) {
  const { imagePath, ...rest } = r;
  return { ...rest, imageUrl: imagePath ? `/api/qsl/received/image/${r.id}` : null };
}

/** Is the radio service answering? A local copy — see pages/api/integrations/status.ts for why. */
async function bridgeUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function status(admin: boolean) {
  const [enabled, provider, sendProvider, intervalMinutes, port, last] = await Promise.all([
    getBooleanSetting("qsl.inbound.enabled", false),
    getReceiveProvider(),
    getSendProvider(),
    getNumberSetting("qsl.inbound.intervalMinutes", 15),
    getNumberSetting("bridge.port", 3101),
    getInboundLastRun(),
  ]);
  let configProblem: string | null = null;
  if (provider === "graph") {
    const g = await loadGraphConfig();
    configProblem = g.ok ? null : g.reason;
  } else configProblem = IMAP_COMING_NEXT;
  const check: InboundCheck = {
    enabled,
    configProblem,
    provider: provider === "graph" ? "graph" : "imap",
    running: await bridgeUp(port),
    intervalMinutes: Math.max(5, intervalMinutes),
    lastRunAt: last.at,
    port,
  };
  // The subjects of mail that was NOT a card come from the operator's own mailbox, which may
  // hold anything. Shown to an admin, who can read the mailbox anyway; withheld from viewers.
  const lastReport = last.report && !admin ? { ...last.report, ignoredSamples: [] } : last.report;
  return { ...check, sendProvider, receiveProvider: provider, detail: inboundDetail(check), lastReport };
}

async function get(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const qsoId = queryParam(req, "qsoId");
  if (qsoId) {
    const rows = await prisma.receivedQsl.findMany({
      where: { qsoId },
      orderBy: { receivedAt: "desc" },
      select: SELECT,
      take: 50,
    });
    sendJson(res, 200, { rows: rows.map(present) });
    return;
  }

  const call = queryParam(req, "call")?.trim().toUpperCase();
  if (call !== undefined) {
    if (!/^[A-Z0-9/]{3,16}$/.test(call)) {
      sendJson(res, 200, { candidates: [] });
      return;
    }
    const b = baseCall(call);
    const rows = await prisma.qso.findMany({
      where: { callsign: { contains: b } },
      select: { id: true, callsign: true, band: true, mode: true, startTime: true },
      orderBy: { startTime: "desc" },
      take: 100,
    });
    sendJson(res, 200, { candidates: rows.filter((r) => baseCall(r.callsign) === b).slice(0, 50) });
    return;
  }

  const raw = queryParam(req, "view");
  const view: ReceivedView = VIEWS.includes(raw as ReceivedView) ? (raw as ReceivedView) : "cards";
  const [rows, ...counts] = await Promise.all([
    prisma.receivedQsl.findMany({ where: whereFor(view), orderBy: { receivedAt: "desc" }, select: SELECT, take: LIMIT }),
    ...VIEWS.map((v) => prisma.receivedQsl.count({ where: whereFor(v) })),
  ]);
  sendJson(res, 200, {
    view,
    rows: rows.map(present),
    counts: Object.fromEntries(VIEWS.map((v, i) => [v, counts[i] ?? 0])),
    limit: LIMIT,
    status: await status(canManageQsl(auth.user)),
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });

import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import {
  RecentCommands,
  bridgeRequestFor,
  commandSchema,
  reduceStatus,
  type BridgeStatusPayload,
  type CommandResult,
  type RadioLock,
} from "@/lib/radio/api";
import { bridgeCommand, bridgeStatus } from "@/lib/radio/bridge-client";
import { radioCapabilities, type RadioSourceName } from "@/lib/radio/capabilities";

// A command from a client that is not a browser: a knob, through its worker.
//
// FOUR COMMANDS, and nothing that keys the transmitter: relative tuning, an absolute
// frequency, a modulation, and stopping the automatic operator. OPERATOR, with an API key
// allowed, because an operator who can start Auto Hunt from a browser can turn a knob.
//
// THE LOCKS ARE ENFORCED IN THE BRIDGE, not here. This route reads the state to answer
// with it, but the decision to refuse a move while a contact is running is made where the
// contact is running: `respectLocks` on the bridge's /rig makes it check at the moment of
// the command, so two things cannot both believe the receiver is free. Stop-automation is
// the exception the policy names, because it is how a lock is lifted.
//
// EVERY COMMAND HAS AN ID the worker chose, and a retried id is answered with the first
// outcome rather than applied again. A dial that lost the response to "+100 Hz" must not
// move 200.

const recent = new RecentCommands(256);

async function state(): Promise<ReturnType<typeof reduceStatus>> {
  const answer = await bridgeStatus();
  const raw: BridgeStatusPayload = answer.reachable
    ? { running: true, ...(answer.body as object) }
    : { running: false, reason: "No bridge answering" };
  return reduceStatus(raw, new Date());
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = commandSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad radio command", parsed.error.flatten().fieldErrors);
    return;
  }
  const cmd = parsed.data;

  const before = recent.seen(cmd.id);
  if (before) {
    sendJson(res, 200, { ...before, status: "duplicate", state: await state() });
    return;
  }

  // An absolute frequency is checked against the active radio's range here, because the
  // bridge only knows the amateur spectrum and the dial should hear "this radio stops at
  // 54 MHz" rather than a bare refusal.
  if (cmd.command === "set-frequency") {
    const answer = await bridgeStatus();
    const st = answer.reachable ? ((answer.body as BridgeStatusPayload).status ?? null) : null;
    const caps = radioCapabilities((st?.source ?? null) as RadioSourceName);
    const hz = cmd.frequencyHz!;
    if (hz < caps.tuneLowHz || hz > caps.tuneHighHz) {
      const result: CommandResult = {
        id: cmd.id,
        command: cmd.command,
        status: "rejected",
        reason: `${hz} Hz is outside ${caps.label}'s range of ${caps.tuneLowHz}-${caps.tuneHighHz} Hz`,
      };
      recent.remember(result);
      sendJson(res, 409, { ...result, state: await state() });
      return;
    }
  }

  const { path, payload } = bridgeRequestFor(cmd);
  const answer = await bridgeCommand(path, payload);
  let result: CommandResult;
  if (answer.tokenMissing) {
    result = { id: cmd.id, command: cmd.command, status: "rejected", reason: "The radio service has never started on this install, so it has no access key yet." };
  } else if (!answer.reachable) {
    result = { id: cmd.id, command: cmd.command, status: "rejected", reason: "The radio service is not answering. Is it running?" };
  } else if (answer.status === 409) {
    const body = answer.body as { error?: string; locks?: RadioLock[] } | null;
    result = { id: cmd.id, command: cmd.command, status: "rejected", reason: body?.error ?? "The receiver is not free", locks: body?.locks ?? [], bridge: answer.body };
  } else if (answer.status >= 200 && answer.status < 300) {
    result = { id: cmd.id, command: cmd.command, status: "accepted", bridge: answer.body };
  } else {
    const body = answer.body as { error?: string } | null;
    result = { id: cmd.id, command: cmd.command, status: "rejected", reason: body?.error ?? `The radio service answered HTTP ${answer.status}`, bridge: answer.body };
  }
  recent.remember(result);
  // The state AFTER the command, so the worker renders the confirmed frequency and not
  // the one it asked for. A refusal returns 409 with the same shape.
  sendJson(res, result.status === "accepted" ? 200 : 409, { ...result, state: await state() });
}

export default authedRoute({
  POST: { role: "OPERATOR", handler: post, allowApiKey: true },
});

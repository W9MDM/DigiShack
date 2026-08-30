import type { NextApiRequest, NextApiResponse } from "next";
import { Prisma } from "@prisma/client";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { QSO_INCLUDE, listQsos } from "@/lib/db/qso";
import { freqInBand } from "@/lib/ham/bands";
import {
  createQsoSchema,
  qsoListQuerySchema,
  resolveBand,
} from "@/lib/validation/qso";

async function get(req: NextApiRequest, res: NextApiResponse) {
  const query = qsoListQuerySchema.parse(req.query);
  const { rows, total } = await listQsos(query);

  sendJson(res, 200, {
    rows,
    total,
    take: query.take,
    skip: query.skip,
  });
}

/**
 * A client-chosen idempotency key, or undefined.
 *
 * Deliberately NOT part of `createQsoSchema`. That schema is shared with PATCH and with
 * the ADIF importer, and this is a property of one HTTP attempt rather than of a contact —
 * an imported QSO has no such key and should never be made to invent one.
 *
 * OPAQUE to the server. The browser generates a UUID (see `newClientId` in
 * components/qso/QsoForm.tsx), but nothing here parses it: the only requirements are that
 * it be unique and fit in VARCHAR(64), and pinning the column to a UUID grammar would make
 * any future client that keys differently a schema change.
 *
 * A malformed key is IGNORED rather than rejected. The contact is what matters and the key
 * is a safeguard; answering 400 and refusing to log a QSO because an idempotency token had
 * a bad character would turn a safeguard into the very data loss it exists to prevent. The
 * cost is that such a request falls back to the old duplicate-on-double-tap behaviour,
 * which is the status quo and not a regression.
 */
function readClientId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { clientId?: unknown }).clientId;
  if (typeof raw !== "string") return undefined;
  return /^[A-Za-z0-9._:-]{8,64}$/.test(raw) ? raw : undefined;
}

/**
 * The contact this key already logged, if any.
 *
 * Answered with 200 and the existing row rather than 409. A conflict is the truth about
 * the database and a lie about the operator situation: they tapped Log QSO, the contact is
 * in the log, and that is a success. An error here would send someone hunting for a problem
 * that does not exist, and — on a phone with one bar — would be indistinguishable from the
 * failure they were retrying.
 */
async function sendExisting(res: NextApiResponse, clientId: string): Promise<boolean> {
  const existing = await prisma.qso.findUnique({
    where: { clientId },
    include: QSO_INCLUDE,
  });
  if (!existing) return false;
  res.setHeader("Location", `/api/qsos/${existing.id}`);
  // 200, not 201: nothing was created by THIS request, and saying otherwise would make
  // the response header a lie for any client that reads it.
  sendJson(res, 200, existing);
  return true;
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const input = createQsoSchema.parse(req.body);
  const clientId = readClientId(req.body);

  // The retry case, and the common one: the operator tapped Log QSO twice, or tapped it
  // once on a link that dropped the response. Checked BEFORE the station and operator
  // lookups so a repeat costs one indexed read.
  if (clientId && (await sendExisting(res, clientId))) return;

  // Band is optional on input; derive it from the frequency when absent. When
  // present, createQsoSchema has already checked it contains freqHz.
  const band = resolveBand(input.freqHz, input.band);

  // The station must exist before we attempt the insert, so the caller gets a
  // clear 404 instead of a raw foreign-key error.
  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: { id: true },
  });
  if (!station) {
    sendError(res, 404, `No station with id ${input.stationId}`);
    return;
  }

  if (input.operatorId) {
    const operator = await prisma.operator.findUnique({
      where: { id: input.operatorId },
      select: { id: true, stationId: true },
    });
    if (!operator) {
      sendError(res, 404, `No operator with id ${input.operatorId}`);
      return;
    }
    // An operator belongs to one station; logging them under a different one
    // would produce a nonsense audit trail.
    if (operator.stationId !== input.stationId) {
      sendError(res, 400, "That operator belongs to a different station", {
        operatorId: ["Operator is not registered to this station"],
      });
      return;
    }
  }

  // THE RACE the pre-check above cannot close. A double tap on a slow link puts two
  // identical requests in flight at once; both find no existing row, both reach the insert,
  // and the unique index refuses the loser with P2002. Without this the operator would be
  // shown "A record with these values already exists" for a contact that had just been
  // logged perfectly well by the request beside it.
  //
  // Narrow on purpose: it re-reads by clientId and only answers when a row is actually
  // there. Any other P2002 — a duplicate reference inside `sigRefs`, say — finds nothing and
  // is rethrown to the normal error translation rather than being swallowed.
  let qso;
  try {
    qso = await prisma.qso.create({
      data: {
        clientId: clientId ?? null,
        callsign: input.callsign,
        band,
        freqHz: BigInt(input.freqHz),
        mode: input.mode,
        startTime: input.startTime,
        endTime: input.endTime ?? null,
        rstSent: input.rstSent ?? null,
        rstRcvd: input.rstRcvd ?? null,
        gridSquare: input.gridSquare ?? null,
        name: input.name ?? null,
        qth: input.qth ?? null,
        dxcc: input.dxcc ?? null,
        state: input.state ?? null,
        county: input.county ?? null,
        cqZone: input.cqZone ?? null,
        ituZone: input.ituZone ?? null,
        iota: input.iota ?? null,
        continent: input.continent ?? null,
        sig: input.sig ?? null,
        // The primary. `sigRefs` below carries the whole set — a contact can be
        // several parks at once.
        sigInfo: input.sigRefs?.[0] ?? input.sigInfo ?? null,
        // OUR OWN activation, and the reason a POTA activation could not be logged here
        // at all. Stored on every contact rather than on a session row: an ADIF record
        // has to carry MY_SIG/MY_SIG_INFO itself, POTA reads them per record, and a
        // contact whose activation lived somewhere else would export as an ordinary QSO.
        mySig: input.mySig ?? null,
        mySigInfo: input.mySigInfo ?? null,
        // Null means "the station's grid was right" — the ADIF writer falls back to it.
        // Not defaulted from the station here, deliberately: writing the home grid onto
        // a contact made in a park would be a false record rather than a helpful one,
        // and once written it is indistinguishable from a typed value.
        myGridSquare: input.myGridSquare ?? null,
        qslSent: input.qslSent,
        qslRcvd: input.qslRcvd,
        qslSentAt: input.qslSentAt ?? null,
        qslRcvdAt: input.qslRcvdAt ?? null,
        lotwSent: input.lotwSent,
        lotwRcvd: input.lotwRcvd,
        qrzSent: input.qrzSent,
        qrzRcvd: input.qrzRcvd,
        eqslSent: input.eqslSent,
        eqslRcvd: input.eqslRcvd,
        notes: input.notes ?? null,
        stationId: input.stationId,
        operatorId: input.operatorId ?? null,
        // Nested rather than a second call: a contact created without its references
        // would be briefly visible as an ordinary QSO, and a failure between the two
        // would leave it that way permanently.
        sigRefs: {
          create: (input.sigRefs ?? (input.sigInfo ? [input.sigInfo] : [])).map(
            (sigInfo, i) => ({ sig: input.sig ?? "POTA", sigInfo, primary: i === 0 }),
          ),
        },
      },
      include: QSO_INCLUDE,
    });
  } catch (err) {
    if (
      clientId &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      (await sendExisting(res, clientId))
    ) {
      return;
    }
    throw err;
  }

  // Defence in depth: if the band/frequency pair ever gets past validation the
  // row is still wrong, so assert rather than persist silently-bad award data.
  if (!freqInBand(Number(qso.freqHz), qso.band)) {
    console.warn(
      `[qso] created ${qso.id} with freq ${qso.freqHz} outside band ${qso.band}`,
    );
  }

  res.setHeader("Location", `/api/qsos/${qso.id}`);
  sendJson(res, 201, qso);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
});

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NextApiRequest, NextApiResponse } from "next";

import sharp from "sharp";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { writeSettings } from "@/lib/settings";

// Upload the QSL card artwork.
//
// Until now `qsl.card.baseImage` was a FILESYSTEM PATH typed into a settings box, which
// meant the only way to change your card was to get a file onto the server yourself — SSH,
// or nothing. Reported as "I don't see a place for anyone else to upload an image", and the
// word that matters there is "anyone else": an operator who did not build the server has no
// way in at all.
//
// Raw body rather than multipart. The image is the entire request, so a multipart parser
// (and a dependency for it) would only be wrapping one field, and Next's own body parser is
// disabled below because it would try to JSON-parse a JPEG.

export const config = { api: { bodyParser: false } };

/** 12 MB. Comfortably above any real card scan, far below anything that hurts the server. */
const MAX_BYTES = 12 * 1024 * 1024;

const DIR = "data/qsl";

async function readBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    // Abort as it arrives rather than after buffering it all — the point of a limit is
    // not to hold 400 MB in memory before rejecting it.
    if (total > MAX_BYTES) throw new Error("TOO_LARGE");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function post(req: NextApiRequest, res: NextApiResponse, ctx: AuthContext) {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof Error && err.message === "TOO_LARGE") {
      sendError(res, 413, `That image is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    sendError(res, 400, "Could not read the upload");
    return;
  }
  if (body.length === 0) {
    sendError(res, 400, "No image was uploaded");
    return;
  }

  // VALIDATE BY DECODING, not by trusting a content type or an extension. A file that
  // sharp cannot read would be accepted here and then throw at send time, turning a bad
  // upload into a failed QSL email hours later — and the operator would have no reason to
  // connect the two.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(body).metadata();
  } catch {
    sendError(res, 400, "That file is not an image DigiShack can read (PNG, JPEG or WebP).");
    return;
  }
  if (!meta.width || !meta.height) {
    sendError(res, 400, "That image has no readable dimensions.");
    return;
  }
  if (meta.width < 400) {
    sendError(
      res,
      400,
      `That artwork is only ${meta.width} px wide. The card is rendered at 1600 px by ` +
        "default, so anything under about 800 px will look soft.",
    );
    return;
  }

  // Normalised to PNG at a FIXED filename.
  //
  // Fixed so the setting does not need rewriting on every upload and old files do not
  // accumulate; PNG because the table is composited over this and a re-encoded JPEG would
  // be generation-lossy every time the artwork was replaced.
  const rel = path.join(DIR, "card-base.png");
  const abs = path.join(process.cwd(), rel);
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, await sharp(body).png().toBuffer());
  } catch (err) {
    sendError(
      res,
      500,
      `Could not save the artwork: ${err instanceof Error ? err.message : "write failed"}`,
    );
    return;
  }

  // Point the setting at it, in case it was aimed somewhere else — otherwise a successful
  // upload changes nothing visible and reads as a broken button.
  // Attributed, like every other settings write — the audit trail should not have a
  // hole where the upload path is.
  await writeSettings([{ key: "qsl.card.baseImage", value: rel }], ctx.user.id);

  sendJson(res, 200, {
    ok: true,
    path: rel,
    width: meta.width,
    height: meta.height,
    format: meta.format ?? null,
  });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });

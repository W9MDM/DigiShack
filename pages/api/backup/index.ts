import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readdir, stat, unlink } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { BACKUP_DIR, backupDatabase, restoreDatabase } from "@/lib/db/backup";
import { backupBundle, restoreBundle } from "@/lib/db/bundle";

// Database backup and restore.
//
// ADMIN only, and for good reason in both directions: a backup contains every
// credential, every session and the whole log, and a restore destroys whatever is
// there now.
//
// GET            list backups, and report whether the client tools are present
// POST           make a backup
// GET ?file=     download one
// DELETE ?file=  remove one
// PUT            restore from an uploaded dump (body is the file)

/** Filenames this route will touch. Anything else is rejected outright. */
//
// Two shapes: a bare SQL dump, and a bundle that also carries the customised files.
const NAME_RE = /^digishack-[0-9T:.\-]+(\.bundle\.tar|\.sql)\.gz$/;

/**
 * Resolve a requested filename inside BACKUP_DIR.
 *
 * Pattern-matched AND path-resolved. The pattern alone would already exclude
 * traversal, but a filename arriving from a browser is untrusted input reaching the
 * filesystem, and confirming the resolved path still sits under BACKUP_DIR costs
 * nothing and does not depend on the regex being airtight.
 */
function resolveBackup(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const full = path.resolve(BACKUP_DIR, name);
  const root = path.resolve(BACKUP_DIR);
  if (full !== path.join(root, path.basename(full))) return null;
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

const RESTART_NOTE =
  "Restored. RESTART the application and the radio service now — Prisma holds a connection pool and settings are cached in memory, and serving from that state after the tables underneath have been replaced fails in ways that look like corruption.";

/** Buffer the upload. Both restore paths need the whole thing before they start. */
async function readBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

/**
 * Is this a bundle rather than a bare SQL dump?
 *
 * Both arrive gzipped, so the test has to look inside. A tar's first entry header
 * carries the `ustar` magic at byte 257, and a SQL dump starts with a comment — the
 * two are unmistakable once decompressed.
 */
function looksLikeBundle(body: Buffer, gzipped: boolean): boolean {
  try {
    const head = gzipped ? gunzipSync(body).subarray(0, 512) : body.subarray(0, 512);
    return head.length >= 263 && head.subarray(257, 262).toString("ascii") === "ustar";
  } catch {
    // Unreadable as gzip is not this function's problem to report; let the restore
    // path produce the error, which explains itself properly.
    return false;
  }
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const wanted = typeof req.query.file === "string" ? req.query.file : null;

  if (wanted) {
    const full = resolveBackup(wanted);
    if (!full) {
      sendError(res, 400, "Not a backup filename");
      return;
    }
    try {
      const info = await stat(full);
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Length", String(info.size));
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(full)}"`);
      createReadStream(full).pipe(res);
    } catch {
      sendError(res, 404, "No such backup");
    }
    return;
  }

  let files: { name: string; bytes: number; createdAt: string }[] = [];
  try {
    const names = await readdir(BACKUP_DIR);
    files = (
      await Promise.all(
        names
          .filter((n) => NAME_RE.test(n))
          .map(async (n) => {
            const info = await stat(path.join(BACKUP_DIR, n));
            return { name: n, bytes: info.size, createdAt: info.mtime.toISOString() };
          }),
      )
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    /* directory does not exist yet */
  }

  sendJson(res, 200, {
    files,
    // Surfaced with the listing rather than buried in documentation, because
    // discovering it AFTER the move means every service credential is silently
    // unreadable on the new machine.
    settingsKeyWarning:
      "A backup contains your settings, but the key that decrypts the secrets in them does NOT live in the database — it is SETTINGS_KEY in .env. Copy that line to the new machine as well, or QRZ, LoTW, eQSL, Club Log and SMTP credentials will restore as unreadable ciphertext.",
  });
}

/**
 * Make a backup.
 *
 * A bundle by DEFAULT, because the SQL dump alone does not move an installation —
 * the QSL artwork lives on disk, and a restore without it renders every card against
 * a missing background. `?sql=1` still produces the bare dump, for feeding straight
 * to `mysql`.
 *
 * `?key=1` puts SETTINGS_KEY in the bundle. Off by default and deliberately a real
 * choice: the dump already holds every credential encrypted, so a bundle WITH the key
 * is a single file that can act as this station on every service it touches.
 */
async function post(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.query.sql === "1") {
      const result = await backupDatabase();
      sendJson(res, 200, { ok: true, kind: "sql", ...result });
      return;
    }
    const result = await backupBundle(req.query.key === "1");
    sendJson(res, 200, {
      ok: true,
      kind: "bundle",
      file: result.file,
      bytes: result.bytes,
      tables: result.manifest.database.tables,
      rows: result.manifest.database.rows,
      files: result.manifest.files,
      skipped: result.manifest.skipped,
      includesSettingsKey: result.manifest.includesSettingsKey,
      schemaVersion: result.manifest.schemaVersion,
      createdAt: result.manifest.createdAt,
    });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "Backup failed");
  }
}

async function del(req: NextApiRequest, res: NextApiResponse) {
  const wanted = typeof req.query.file === "string" ? req.query.file : null;
  const full = wanted ? resolveBackup(wanted) : null;
  if (!full) {
    sendError(res, 400, "Not a backup filename");
    return;
  }
  try {
    await unlink(full);
    sendJson(res, 200, { ok: true });
  } catch {
    sendError(res, 404, "No such backup");
  }
}

/**
 * Restore from the uploaded body.
 *
 * Requires `?confirm=replace-everything` in the query. A restore drops every table
 * the dump covers, and the QSOs that vanish are precisely the ones nobody exported —
 * so it must not be reachable by a mis-aimed request.
 */
async function put(req: NextApiRequest, res: NextApiResponse) {
  if (req.query.confirm !== "replace-everything") {
    sendError(
      res,
      400,
      "A restore replaces the entire database. Send ?confirm=replace-everything to proceed.",
    );
    return;
  }

  const name = typeof req.query.name === "string" ? req.query.name : "";
  const gzipped = name.endsWith(".gz") || req.headers["content-encoding"] === "gzip";

  try {
    // Which shape it is comes from the CONTENT, not the filename: a browser upload
    // can arrive renamed, and guessing wrong means either refusing a valid backup or
    // handing tar bytes to the SQL splitter.
    const body = await readBody(req);
    if (looksLikeBundle(body, gzipped)) {
      const result = await restoreBundle(body);
      sendJson(res, 200, {
        ok: true,
        kind: "bundle",
        statements: result.statements,
        filesWritten: result.filesWritten,
        settingsKeyPresent: result.settingsKeyPresent,
        manifest: result.manifest,
        warnings: result.warnings,
        detail: RESTART_NOTE,
      });
      return;
    }
    const result = await restoreDatabase(Readable.from(body), { gzipped });
    sendJson(res, 200, {
      ok: true,
      kind: "sql",
      warnings: [
        "This was a bare SQL dump, so no QSL artwork and no settings key came with it.",
      ],
      ...result,
      detail: RESTART_NOTE,
    });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : "Restore failed");
  }
}

// The restore body is a raw dump, so Next must not try to parse it, and it can be
// large — a whole log gzipped.
export const config = { api: { bodyParser: false } };

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "ADMIN", handler: post },
  PUT: { role: "ADMIN", handler: put },
  DELETE: { role: "ADMIN", handler: del },
});

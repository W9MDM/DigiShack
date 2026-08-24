// A complete, portable backup: the database AND every customised file.
//
// The SQL dump alone is not enough to move an installation, and that gap was quiet
// enough to be dangerous. Three things live outside the database:
//
//   * QSL card artwork under data/ — the operator's own asset, tens of megabytes,
//     deliberately kept out of git. Restore without it and every card renders
//     against a missing background.
//   * SETTINGS_KEY from .env — the key that decrypts the credentials the dump
//     contains. Without it QRZ, LoTW, eQSL, Club Log and SMTP restore as unreadable
//     ciphertext, and the operator finds out days later when something silently
//     stops working.
//   * Which schema version the dump came from, so a restore into an older or newer
//     application can be recognised rather than half-applied.
//
// A bundle is a gzipped tar. See lib/db/tar.ts for why the format is hand-rolled
// rather than pulled in as a dependency.
//
// The settings key is included only when explicitly asked for, and that choice is
// real rather than ceremonial: the dump already holds every credential encrypted, so
// a bundle WITH the key is a single file that can impersonate this station on every
// service it uses. Splitting them is the only thing that makes a stray copy harmless.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import pkg from "@/package.json";
import { prisma } from "@/lib/db/prisma";
import { BACKUP_DIR, restoreSqlText, writeSqlDump } from "@/lib/db/backup";
import { tarPack, tarUnpack, type TarEntry } from "@/lib/db/tar";

/** Directories whose contents belong in a bundle, relative to the project root. */
const ASSET_DIRS = ["data"];

/** Names inside the archive. */
const SQL_ENTRY = "database.sql";
const MANIFEST_ENTRY = "manifest.json";
const KEY_ENTRY = "settings-key.txt";
const README_ENTRY = "RESTORE.md";
const FILES_PREFIX = "files/";

/**
 * Anything larger than this is left out, with a note in the manifest.
 *
 * A bundle is held in memory to be written, and an operator who has dropped a video
 * file into data/ should get a working backup and a warning rather than an
 * out-of-memory crash.
 */
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export interface BundleManifest {
  format: 1;
  application: "DigiShack";
  version: string;
  createdAt: string;
  /** The latest applied migration, so a restore can spot a schema mismatch. */
  schemaVersion: string | null;
  database: { tables: number; rows: number; bytes: number; sha256: string };
  /**
   * The server's `lower_case_table_names`, and the identifier case actually used.
   *
   * The trap this exists for: MySQL and MariaDB on Windows default to
   * `lower_case_table_names=1` and fold every table name, so this database holds
   * `qso` and `qsosigref` where Prisma's schema says `Qso` and `QsoSigRef` — which is
   * invisible locally, because the server is then case-insensitive about it too.
   *
   * Restore that dump onto Linux, where the default is 0 and names are
   * case-SENSITIVE, and it creates lowercase tables that Prisma cannot find. The
   * application starts, connects, and fails every query with "table doesn't exist".
   * Windows to Linux is the most likely move this feature will ever be asked to make.
   */
  server: {
    version: string | null;
    lowerCaseTableNames: string | null;
    /** True when the dump's DDL uses names Prisma would not recognise verbatim. */
    identifiersFolded: boolean;
  };
  files: { name: string; bytes: number }[];
  includesSettingsKey: boolean;
  /** Assets skipped for being too large, so their absence is never silent. */
  skipped: { name: string; bytes: number; reason: string }[];
}

/**
 * This build's version.
 *
 * Imported statically rather than read from disk at runtime: reading
 * `path.join(process.cwd(), "package.json")` made the bundler trace the whole project
 * into the deployment output, and every other route already imports it this way.
 */
function appVersion(): string {
  return pkg.version;
}

/**
 * How this server treats identifier case, and whether it has folded ours.
 *
 * `identifiersFolded` is measured rather than inferred from the variable: a table
 * named `qso` when the schema says `Qso` is the fact that matters, and reading it
 * from the database is more reliable than reasoning about platform defaults.
 */
async function serverCase(): Promise<BundleManifest["server"]> {
  const q = async <T>(sql: string): Promise<T[]> => {
    try {
      return await prisma.$queryRawUnsafe<T[]>(sql);
    } catch {
      return [];
    }
  };
  const vars = await q<{ Variable_name: string; Value: string }>(
    "SHOW VARIABLES LIKE 'lower_case_table_names'",
  );
  const ver = await q<Record<string, string>>("SELECT VERSION() AS v");
  const tables = await q<Record<string, string>>("SHOW TABLES");
  const names = tables.map((r) => String(Object.values(r)[0] ?? ""));
  return {
    version: ver[0]?.v ?? null,
    lowerCaseTableNames: vars[0]?.Value ?? null,
    // Prisma's models are PascalCase. If not one table name has a capital in it, the
    // server folded them.
    identifiersFolded: names.length > 0 && !names.some((n) => /[A-Z]/.test(n)),
  };
}

/** The newest applied migration, read from Prisma's own table. */
async function schemaVersion(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

/** Every file under the asset directories, recursively. */
async function collectAssets(): Promise<{
  entries: TarEntry[];
  skipped: BundleManifest["skipped"];
}> {
  const entries: TarEntry[] = [];
  const skipped: BundleManifest["skipped"] = [];

  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // the directory simply is not there
    }
    for (const name of names) {
      const full = path.join(dir, name);
      // Forward slashes inside the archive regardless of platform — a tar written on
      // Windows with backslashes in the names extracts as one long filename on Linux.
      const relPath = rel ? `${rel}/${name}` : name;
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full, relPath);
        continue;
      }
      if (info.size > MAX_ASSET_BYTES) {
        skipped.push({
          name: relPath,
          bytes: info.size,
          reason: `larger than ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB`,
        });
        continue;
      }
      entries.push({
        name: `${FILES_PREFIX}${relPath}`,
        data: await readFile(full),
        mtime: info.mtime,
      });
    }
  };

  for (const dir of ASSET_DIRS) {
    // The bundler warns that walking a directory under process.cwd() might be a
    // dynamic import and traces the project into the deployment output. It is not;
    // these are runtime data paths, and the exclusion is declared in next.config.ts.
    await walk(path.join(process.cwd(), dir), dir);
  }
  return { entries, skipped };
}

function restoreReadme(m: BundleManifest): string {
  return [
    `# DigiShack backup — ${m.createdAt}`,
    ``,
    `DigiShack ${m.version}, schema \`${m.schemaVersion ?? "unknown"}\`.`,
    `${m.database.tables} tables, ${m.database.rows.toLocaleString()} rows, ${m.files.length} file(s).`,
    ``,
    `## Restoring`,
    ``,
    `Upload this file on the Backup page of the new installation. That replaces the`,
    `database, writes the files back, and tells you what it did.`,
    ``,
    `## By hand`,
    ``,
    `    tar xzf THIS_FILE`,
    `    mysql -u USER -p DBNAME < database.sql`,
    ``,
    `Then copy \`files/data\` into the application directory.`,
    ``,
    `## The settings key`,
    ``,
    m.includesSettingsKey
      ? [
          `\`${KEY_ENTRY}\` IS included. **Treat this file as a password.** Together with`,
          `the database it can act as this station on QRZ, LoTW, eQSL, Club Log and your`,
          `mail server. Put the line into \`.env\` on the new machine.`,
        ].join("\n")
      : [
          `\`${KEY_ENTRY}\` is NOT included, so the encrypted credentials in the database`,
          `cannot be read without it. Copy the \`SETTINGS_KEY=\` line from the old`,
          `machine's \`.env\` by hand, or re-enter every service credential in Settings.`,
        ].join("\n"),
    ``,
    ...(m.server.identifiersFolded
      ? [
          `## Moving to Linux — read this first`,
          ``,
          `This dump came from a server that folds table names to lower case`,
          `(\`lower_case_table_names=${m.server.lowerCaseTableNames ?? "?"}\`), which is the`,
          `default on Windows. So it creates \`qso\` where Prisma's schema says \`Qso\`.`,
          ``,
          `On Linux the default is 0 and table names are case-SENSITIVE. The restore will`,
          `appear to succeed and the application will then fail every query with "table`,
          `doesn't exist". Two ways out:`,
          ``,
          `1. Set \`lower_case_table_names=1\` in the new server's config and restart it`,
          `   BEFORE creating the database. It cannot be changed on an existing one.`,
          `2. Or run \`npm run db:deploy\` against an empty database to create the tables`,
          `   with their proper names, then load only the \`INSERT\` statements from`,
          `   \`database.sql\`.`,
          ``,
        ]
      : []),
    `## What is NOT in here`,
    ``,
    `* \`DATABASE_URL\` — machine-specific; point the new install at its own database.`,
    `* Login sessions — everyone signs in again, which is the correct outcome for a`,
    `  migration rather than an inconvenience.`,
    ...(m.skipped.length
      ? [
          ``,
          `## Left out`,
          ``,
          ...m.skipped.map((s) => `* \`${s.name}\` (${s.bytes} bytes) — ${s.reason}`),
        ]
      : []),
    ``,
  ].join("\n");
}

export interface BundleResult {
  file: string;
  bytes: number;
  manifest: BundleManifest;
}

/**
 * Write a complete bundle.
 *
 * @param includeSettingsKey include SETTINGS_KEY, making the file able to decrypt
 *        every credential in the dump. Off unless the operator chooses it.
 */
export async function backupBundle(includeSettingsKey = false): Promise<BundleResult> {
  await mkdir(BACKUP_DIR, { recursive: true });

  const chunks: string[] = [];
  const counts = await writeSqlDump(async (s) => {
    chunks.push(s);
  });
  const sql = Buffer.from(chunks.join(""), "utf8");
  if (sql.length < 512) {
    throw new Error(`The dump came out at ${sql.length} bytes — that is not a usable backup`);
  }

  const { entries: assets, skipped } = await collectAssets();

  const key = includeSettingsKey ? (process.env.SETTINGS_KEY ?? null) : null;
  if (includeSettingsKey && !key) {
    throw new Error(
      "SETTINGS_KEY is not set in this environment, so it cannot be included. Uncheck the option, or fix .env first.",
    );
  }

  const manifest: BundleManifest = {
    format: 1,
    application: "DigiShack",
    version: appVersion(),
    createdAt: new Date().toISOString(),
    schemaVersion: await schemaVersion(),
    database: {
      tables: counts.tables,
      rows: counts.rows,
      bytes: sql.length,
      // So a restore can prove the dump arrived intact rather than discovering it
      // halfway through applying statements.
      sha256: createHash("sha256").update(sql).digest("hex"),
    },
    server: await serverCase(),
    files: assets.map((a) => ({
      name: a.name.slice(FILES_PREFIX.length),
      bytes: a.data.length,
    })),
    includesSettingsKey: Boolean(key),
    skipped,
  };

  const tarEntries: TarEntry[] = [
    { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    { name: README_ENTRY, data: Buffer.from(restoreReadme(manifest), "utf8") },
    { name: SQL_ENTRY, data: sql },
    ...assets,
  ];
  if (key) {
    tarEntries.push({
      name: KEY_ENTRY,
      data: Buffer.from(`SETTINGS_KEY=${key}\n`, "utf8"),
      mode: 0o600,
    });
  }

  const stamp = manifest.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(BACKUP_DIR, `digishack-${stamp}.bundle.tar.gz`);
  const gz = gzipSync(tarPack(tarEntries), { level: 6 });
  await writeFile(file, gz);

  return { file: path.basename(file), bytes: gz.length, manifest };
}

export interface BundleRestoreResult {
  manifest: BundleManifest | null;
  statements: number;
  filesWritten: { name: string; bytes: number }[];
  settingsKeyPresent: boolean;
  warnings: string[];
}

/**
 * Restore from a bundle.
 *
 * Everything is verified before anything is applied. Half a restore is worse than
 * none: the database would be replaced and the artwork missing, or the artwork
 * written over a database that then failed to load.
 *
 * The settings key is never written into `.env` automatically. Editing the file the
 * application reads its own database credentials from, from a web request, is not
 * something this should do on its own — it is reported and the operator copies one
 * line.
 */
export async function restoreBundle(gzipped: Buffer): Promise<BundleRestoreResult> {
  const warnings: string[] = [];

  let entries: TarEntry[];
  try {
    entries = tarUnpack(gunzipSync(gzipped));
  } catch (err) {
    throw new Error(
      `That is not a readable DigiShack bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const byName = new Map(entries.map((e) => [e.name, e]));
  const sqlEntry = byName.get(SQL_ENTRY);
  if (!sqlEntry) {
    throw new Error(
      `The bundle has no ${SQL_ENTRY}. If this is a plain .sql.gz dump, upload it as one — the page accepts both.`,
    );
  }

  let manifest: BundleManifest | null = null;
  const manifestEntry = byName.get(MANIFEST_ENTRY);
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.data.toString("utf8")) as BundleManifest;
    } catch {
      warnings.push("The manifest could not be read, so the dump was applied unverified.");
    }
  } else {
    warnings.push("The bundle has no manifest — it was not made by this version.");
  }

  if (manifest?.database?.sha256) {
    const actual = createHash("sha256").update(sqlEntry.data).digest("hex");
    if (actual !== manifest.database.sha256) {
      throw new Error(
        "The SQL dump does not match the checksum in the manifest — the bundle is corrupt. Nothing was changed.",
      );
    }
  }

  const here = appVersion();
  if (manifest && manifest.version !== here) {
    // Reported, not refused. Restoring a backup from a different version is the
    // normal case when moving to a machine that has since been updated, and the
    // schema check below is the one that actually matters.
    warnings.push(`The bundle was made by DigiShack ${manifest.version}; this is ${here}.`);
  }
  // Identifier case, which is the one difference that lets a restore succeed
  // completely and leave an application that cannot read its own database.
  const caseHere = await serverCase();
  if (manifest?.server && manifest.server.identifiersFolded !== caseHere.identifiersFolded) {
    warnings.push(
      manifest.server.identifiersFolded
        ? "The bundle was made on a server that folds table names to lower case " +
          `(lower_case_table_names=${manifest.server.lowerCaseTableNames ?? "?"}, typically Windows), ` +
          `and this one does not (${caseHere.lowerCaseTableNames ?? "?"}). The dump will create ` +
          "lower-case tables that Prisma cannot find, and every query will fail with " +
          "\"table doesn't exist\". Set lower_case_table_names=1 on this server, or run " +
          "`npm run db:deploy` on an empty database and import only the INSERT statements."
        : "This server folds table names to lower case and the bundle's server did not. " +
          "The restore will succeed; the names simply arrive folded, which is consistent " +
          "with everything else here.",
    );
  }

  const schemaHere = await schemaVersion();
  if (manifest?.schemaVersion && schemaHere && manifest.schemaVersion !== schemaHere) {
    warnings.push(
      `Schema differs: the bundle is at ${manifest.schemaVersion}, this database at ${schemaHere}. ` +
        `The dump carries its own CREATE TABLE statements so the restore will succeed, but run ` +
        `\`npm run db:deploy\` afterwards if this application is the newer one.`,
    );
  }

  // The database first. If it fails, the files are untouched and the operator still
  // has a coherent installation to try again from.
  const { statements } = await restoreSqlText(sqlEntry.data.toString("utf8"));

  const filesWritten: { name: string; bytes: number }[] = [];
  const root = path.resolve(process.cwd());
  for (const e of entries) {
    if (!e.name.startsWith(FILES_PREFIX)) continue;
    const rel = e.name.slice(FILES_PREFIX.length);

    // A tar entry name is untrusted input reaching the filesystem, and "../" in it is
    // the oldest trick there is. Resolve and confirm the result is still inside the
    // project before writing a byte.
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      warnings.push(`Refused a file that would land outside the application: ${rel}`);
      continue;
    }
    if (!ASSET_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) {
      warnings.push(`Refused a file outside the asset directories: ${rel}`);
      continue;
    }

    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, e.data);
    filesWritten.push({ name: rel, bytes: e.data.length });
  }

  const settingsKeyPresent = byName.has(KEY_ENTRY);
  if (settingsKeyPresent) {
    warnings.push(
      `The bundle carries a SETTINGS_KEY. It has NOT been written to .env — copy the line from ${KEY_ENTRY} yourself, then restart.`,
    );
  } else {
    warnings.push(
      "No SETTINGS_KEY in the bundle. If this database came from another machine, its saved credentials stay unreadable until that key is in .env.",
    );
  }

  return { manifest, statements, filesWritten, settingsKeyPresent, warnings };
}

/** Read a bundle's manifest without restoring anything. */
export function inspectBundle(gzipped: Buffer): BundleManifest | null {
  const entries = tarUnpack(gunzipSync(gzipped));
  const m = entries.find((e) => e.name === MANIFEST_ENTRY);
  if (!m) return null;
  try {
    return JSON.parse(m.data.toString("utf8")) as BundleManifest;
  } catch {
    return null;
  }
}

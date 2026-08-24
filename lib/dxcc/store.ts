import { prisma } from "@/lib/db/prisma";
import { type CtyFile, decompressIfNeeded, parseCtyXml } from "@/lib/dxcc/parse";
import { getSetting } from "@/lib/settings";

// Import and status for the DXCC reference tables.
//
// Metadata lives in Setting rows under `dxcc.*`. Those keys are written here, not
// through the /settings UI, so they are deliberately absent from
// lib/settings/registry.ts — describeSettings() only lists registry keys, so they
// never appear as editable fields.

const KEY_IMPORTED_AT = "dxcc.importedAt";
const KEY_FILE_DATE = "dxcc.fileDate";
const KEY_SOURCE = "dxcc.source";

/** Rows per createMany. cty.xml exceptions run to tens of thousands. */
const CHUNK = 1000;

export interface DxccImportReport {
  entities: number;
  prefixes: number;
  exceptions: number;
  /** Prefix/exception records naming an adif with no matching entity. */
  orphaned: number;
  fileDate: string | null;
  problems: string[];
  source: string;
}

export interface DxccStatus {
  loaded: boolean;
  entityCount: number;
  prefixCount: number;
  exceptionCount: number;
  /** When Club Log generated the file. */
  fileDate: string | null;
  importedAt: string | null;
  source: string | null;
  /** True once a cty API key is configured, so the UI can offer Fetch. */
  canFetch: boolean;
}

export async function getDxccStatus(): Promise<DxccStatus> {
  const [importedAt, fileDate, source, entityCount, prefixCount, exceptionCount, apiKey] =
    await Promise.all([
      prisma.setting.findUnique({ where: { key: KEY_IMPORTED_AT } }),
      prisma.setting.findUnique({ where: { key: KEY_FILE_DATE } }),
      prisma.setting.findUnique({ where: { key: KEY_SOURCE } }),
      prisma.dxccEntity.count(),
      prisma.dxccPrefix.count({ where: { exact: false } }),
      prisma.dxccPrefix.count({ where: { exact: true } }),
      getSetting("dxcc.ctyApiKey"),
    ]);

  return {
    loaded: Boolean(importedAt?.value) && entityCount > 0,
    entityCount,
    prefixCount,
    exceptionCount,
    fileDate: fileDate?.value ?? null,
    importedAt: importedAt?.value ?? null,
    source: source?.value ?? null,
    canFetch: Boolean(apiKey),
  };
}

/**
 * Replace the DXCC tables with the contents of a parsed cty.xml.
 *
 * Not wrapped in one transaction — tens of thousands of inserts in a single
 * MySQL transaction is a long lock for no benefit. Safety instead comes from
 * ordering: `dxcc.importedAt` is deleted BEFORE anything is touched and only
 * written once the import completes. resolveDxcc() treats a missing
 * `importedAt` as "no data", so a failed or interrupted import yields "not
 * loaded" rather than answers drawn from half a table.
 */
export async function importCty(
  cty: CtyFile,
  source: string,
): Promise<DxccImportReport> {
  // Mark the data unusable for the duration.
  await prisma.setting.deleteMany({ where: { key: KEY_IMPORTED_AT } });

  // Prefixes first — they reference entities.
  await prisma.dxccPrefix.deleteMany({});
  await prisma.dxccEntity.deleteMany({});

  for (let i = 0; i < cty.entities.length; i += CHUNK) {
    await prisma.dxccEntity.createMany({
      data: cty.entities.slice(i, i + CHUNK).map((e) => ({
        adif: e.adif,
        name: e.name,
        prefix: e.prefix,
        deleted: e.deleted,
        cqZone: e.cqZone,
        continent: e.continent,
        latitude: e.latitude,
        longitude: e.longitude,
        validFrom: e.validFrom,
        validTo: e.validTo,
      })),
      skipDuplicates: true,
    });
  }

  const knownAdif = new Set(
    (await prisma.dxccEntity.findMany({ select: { adif: true } })).map(
      (e) => e.adif,
    ),
  );

  let orphaned = 0;
  let prefixCount = 0;
  let exceptionCount = 0;

  const insert = async (rows: CtyFile["prefixes"], exact: boolean) => {
    // A record pointing at an entity the file didn't define would fail the
    // foreign key and abort the whole chunk, so drop and count those instead.
    const usable = rows.filter((r) => {
      if (knownAdif.has(r.adif)) return true;
      orphaned++;
      return false;
    });

    for (let i = 0; i < usable.length; i += CHUNK) {
      await prisma.dxccPrefix.createMany({
        data: usable.slice(i, i + CHUNK).map((r) => ({
          call: r.call,
          exact,
          adif: r.adif,
          cqZone: r.cqZone,
          continent: r.continent,
          latitude: r.latitude,
          longitude: r.longitude,
          validFrom: r.validFrom,
          validTo: r.validTo,
        })),
      });
    }
    return usable.length;
  };

  prefixCount = await insert(cty.prefixes, false);
  exceptionCount = await insert(cty.exceptions, true);

  const fileDate = cty.fileDate ? cty.fileDate.toISOString() : null;
  const now = new Date().toISOString();

  await prisma.setting.upsert({
    where: { key: KEY_FILE_DATE },
    create: { key: KEY_FILE_DATE, value: fileDate ?? "", encrypted: false },
    update: { value: fileDate ?? "" },
  });
  await prisma.setting.upsert({
    where: { key: KEY_SOURCE },
    create: { key: KEY_SOURCE, value: source, encrypted: false },
    update: { value: source },
  });
  // Written last: this is the flag that makes the data live.
  await prisma.setting.upsert({
    where: { key: KEY_IMPORTED_AT },
    create: { key: KEY_IMPORTED_AT, value: now, encrypted: false },
    update: { value: now },
  });

  return {
    entities: cty.entities.length,
    prefixes: prefixCount,
    exceptions: exceptionCount,
    orphaned,
    fileDate,
    problems: cty.problems.slice(0, 50),
    source,
  };
}

export const CTY_URL = "https://cdn.clublog.org/cty.php";

/**
 * Download cty.xml from Club Log. The key is not part of a public API — Club Log
 * issues one on request — so it lives in Settings as a secret rather than being
 * hardcoded anywhere.
 */
export async function fetchCty(apiKey: string): Promise<Buffer> {
  const url = `${CTY_URL}?api=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "DigiShack/0.5 (amateur radio logbook)" },
    // The file is a few MB; a stuck request shouldn't hang the route forever.
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(
      `Club Log returned HTTP ${res.status}. Check the cty API key on the Settings page.`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());

  // An invalid key yields a short HTML or text error rather than an archive.
  if (buf.length < 1024) {
    throw new Error(
      `Club Log returned only ${buf.length} bytes — that is an error response, not cty.xml. Check the API key.`,
    );
  }

  return buf;
}

/** Parse an uploaded or downloaded file, gunzipping if necessary. */
export function parseCtyBuffer(buf: Buffer): CtyFile {
  return parseCtyXml(decompressIfNeeded(buf));
}

import { prisma } from "@/lib/db/prisma";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  settingsKeyAvailable,
  settingsKeyProblem,
} from "@/lib/settings/crypto";
import {
  SETTINGS,
  type SettingDef,
  getSettingDef,
  isSecret,
} from "@/lib/settings/registry";

export { settingsKeyAvailable, settingsKeyProblem };

// Resolution order for every setting:
//
//   1. the database (decrypted if it's a secret)
//   2. the value's envFallback, so an existing .env install keeps working
//      after upgrading rather than losing its configuration
//   3. the registry default
//   4. null
//
// Cached process-wide with a short TTL. A TTL rather than pure
// invalidate-on-write because the Phase 4a bridge is a separate process and
// won't see this one's writes — 30 seconds is a tolerable lag for a credential
// change and avoids a query per setting read.

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  /** Raw stored value — still ciphertext for secrets. */
  value: string;
  encrypted: boolean;
}

const globalForSettings = globalThis as unknown as {
  __digishackSettings?: { rows: Map<string, CacheEntry>; loadedAt: number };
};

async function load(force = false): Promise<Map<string, CacheEntry>> {
  const cached = globalForSettings.__digishackSettings;
  if (
    !force &&
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS
  ) {
    return cached.rows;
  }

  const rows = await prisma.setting.findMany({
    select: { key: true, value: true, encrypted: true },
  });

  const map = new Map<string, CacheEntry>(
    rows.map((r) => [r.key, { value: r.value, encrypted: r.encrypted }]),
  );
  globalForSettings.__digishackSettings = { rows: map, loadedAt: Date.now() };
  return map;
}

export function invalidateSettingsCache(): void {
  globalForSettings.__digishackSettings = undefined;
}

/**
 * One stored row, decrypted if it needs to be.
 *
 * Returns null both for "no row" and for "a row that will not decrypt", which are
 * treated the same on purpose: silently using a different credential than the one shown
 * in the UI would be worse than having none.
 */
function readRow(
  rows: Map<string, CacheEntry>,
  key: string,
): string | null {
  const row = rows.get(key);
  if (!row) return null;
  if (row.encrypted) {
    const plain = decryptSecret(row.value);
    if (plain !== null) return plain;
    console.error(
      `[settings] ${key} could not be decrypted — SETTINGS_KEY may have changed`,
    );
    return null;
  }
  return row.value === "" ? null : row.value;
}

/** Resolved value, or null when nothing is configured anywhere. */
export async function getSetting(key: string): Promise<string | null> {
  const def = getSettingDef(key);
  const rows = await load();

  const current = readRow(rows, key);
  if (current !== null) return current;

  // A key this setting used to live under, before a rename. Ahead of `envFallback`
  // because a value the operator saved in the UI must outrank one left in a .env file,
  // and behind the current key because a value saved since the rename is the newest
  // thing anybody said.
  for (const legacy of def?.legacyKeys ?? []) {
    const old = readRow(rows, legacy);
    if (old !== null) return old;
  }

  if (def?.envFallback) {
    const fromEnv = process.env[def.envFallback];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  }

  return def?.default ?? null;
}

export async function getNumberSetting(
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await getSetting(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function getBooleanSetting(
  key: string,
  fallback = false,
): Promise<boolean> {
  const raw = await getSetting(key);
  if (raw === null) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Several at once, for a service that needs a whole credential set. */
export async function getSettings(
  keys: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = await getSetting(key);
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SettingUpdate {
  key: string;
  /** null clears the stored value; "" on a secret means "leave unchanged". */
  value: string | null;
}

export interface WriteResult {
  updated: string[];
  cleared: string[];
  unchanged: string[];
  rejected: { key: string; reason: string }[];
}

export async function writeSettings(
  updates: SettingUpdate[],
  updatedById: string,
): Promise<WriteResult> {
  const result: WriteResult = {
    updated: [],
    cleared: [],
    unchanged: [],
    rejected: [],
  };

  for (const { key, value } of updates) {
    const def = getSettingDef(key);
    if (!def) {
      result.rejected.push({ key, reason: "Unknown setting" });
      continue;
    }

    if (value === null) {
      await prisma.setting.deleteMany({ where: { key } });
      result.cleared.push(key);
      continue;
    }

    // A blank secret means the form was submitted without retyping it — the UI
    // never receives the current value, so blank cannot mean "set to empty".
    // Clearing a secret is done explicitly, with value: null.
    if (def.type === "secret" && value === "") {
      result.unchanged.push(key);
      continue;
    }

    if (def.type === "secret") {
      if (!settingsKeyAvailable()) {
        result.rejected.push({
          key,
          reason: settingsKeyProblem() ?? "SETTINGS_KEY unavailable",
        });
        continue;
      }
      const ciphertext = encryptSecret(value);
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: ciphertext, encrypted: true, updatedById },
        update: { value: ciphertext, encrypted: true, updatedById },
      });
      result.updated.push(key);
      continue;
    }

    const normalized = normalize(def, value);
    if (normalized === null) {
      result.rejected.push({
        key,
        reason: `Not a valid ${def.type}`,
      });
      continue;
    }

    await prisma.setting.upsert({
      where: { key },
      create: { key, value: normalized, encrypted: false, updatedById },
      update: { value: normalized, encrypted: false, updatedById },
    });
    result.updated.push(key);
  }

  invalidateSettingsCache();
  return result;
}

function normalize(def: SettingDef, value: string): string | null {
  switch (def.type) {
    case "number": {
      const n = Number(value.trim());
      return Number.isFinite(n) ? String(n) : null;
    }
    case "boolean":
      return value === "true" || value === "1" ? "true" : "false";
    default:
      return value.trim();
  }
}

// ---------------------------------------------------------------------------
// Client-facing view
// ---------------------------------------------------------------------------

export type SettingSource = "database" | "env" | "default" | "unset";

export interface SettingView {
  key: string;
  label: string;
  type: SettingDef["type"];
  group: string;
  help?: string;
  placeholder?: string;
  source: SettingSource;
  /** Non-secret values only. Always null for secrets. */
  value: string | null;
  /** Secrets only: `••••••1234`, so it's clear which credential is stored. */
  masked: string | null;
  configured: boolean;
  /** True when the value still comes from .env and hasn't been moved yet. */
  fromEnv: boolean;
  envFallback?: string;
}

/**
 * Everything /settings needs, with plaintext secrets never included — a secret
 * that reaches the browser is a secret in a browser cache, a proxy log and a
 * devtools history.
 */
export async function describeSettings(): Promise<SettingView[]> {
  const rows = await load(true);
  const views: SettingView[] = [];

  for (const def of SETTINGS) {
    const row = rows.get(def.key);
    const secret = isSecret(def.key);

    let source: SettingSource = "unset";
    let value: string | null = null;
    let masked: string | null = null;

    if (row && (row.encrypted || row.value !== "")) {
      source = "database";
      if (row.encrypted) {
        const plain = decryptSecret(row.value);
        masked = plain === null ? "⚠ undecryptable" : maskSecret(plain);
      } else {
        value = row.value;
      }
    } else if (def.envFallback && process.env[def.envFallback]) {
      source = "env";
      const fromEnv = process.env[def.envFallback] ?? "";
      if (secret) masked = maskSecret(fromEnv);
      else value = fromEnv;
    } else if (def.default !== undefined) {
      source = "default";
      if (!secret) value = def.default;
    }

    views.push({
      key: def.key,
      label: def.label,
      type: def.type,
      group: def.group,
      help: def.help,
      placeholder: def.placeholder,
      source,
      value,
      masked,
      configured: source === "database" || source === "env",
      fromEnv: source === "env",
      envFallback: def.envFallback,
    });
  }

  return views;
}

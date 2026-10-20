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
 * What one stored row holds.
 *
 *   absent      no row, or a plain row holding "" (how a cleared field can be stored)
 *   unreadable  a row IS there and will not decrypt
 *   value       a usable value; `encrypted` says whether it was stored as a secret
 */
type StoredValue =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "value"; value: string; encrypted: boolean };

function readRow(
  rows: Map<string, CacheEntry>,
  key: string,
  quiet = false,
): StoredValue {
  const row = rows.get(key);
  if (!row) return { kind: "absent" };
  if (row.encrypted) {
    const plain = decryptSecret(row.value);
    if (plain !== null) return { kind: "value", value: plain, encrypted: true };
    if (!quiet) {
      console.error(
        `[settings] ${key} could not be decrypted — SETTINGS_KEY may have changed`,
      );
    }
    return { kind: "unreadable" };
  }
  return row.value === ""
    ? { kind: "absent" }
    : { kind: "value", value: row.value, encrypted: false };
}

/**
 * How a setting resolved.
 *
 * `unreadable` is the case `getSetting` cannot express: a value IS stored, for this key or
 * one of its legacy keys, and it will not decrypt. Nothing falls back past it.
 */
export type SettingState =
  | { status: "value"; value: string; source: "database" | "env" | "default" }
  | { status: "unreadable"; /** The stored key that would not decrypt. */ storedKey: string }
  | { status: "unset" };

type Resolution =
  | { status: "value"; value: string; source: "database" | "env" | "default"; encrypted: boolean }
  | { status: "unreadable"; storedKey: string }
  | { status: "unset" };

/**
 * The one resolution order, shared by the readers and the settings page so they cannot
 * disagree:
 *
 *   1. this key's row, then each legacy key's row (a key this setting lived under before
 *      a rename — ahead of `envFallback` because a value the operator saved in the UI must
 *      outrank one left in a .env file, behind the current key because a value saved since
 *      the rename is the newest thing anybody said);
 *   2. the envFallback;
 *   3. the registry default.
 *
 * ONLY AN ABSENT ROW MOVES ON. This used to treat "will not decrypt" exactly like "no row"
 * and carry on down the list, so a corrupt saved qrz.password logged in with whatever
 * QRZ_PASSWORD an old .env still held — a different credential from the one the operator
 * saved, used without a word (code review R12, reproduced). An unreadable row now stops
 * the walk and the setting is unavailable until it is re-entered.
 */
function resolve(
  rows: Map<string, CacheEntry>,
  key: string,
  quiet = false,
): Resolution {
  const def = getSettingDef(key);
  for (const k of [key, ...(def?.legacyKeys ?? [])]) {
    const stored = readRow(rows, k, quiet);
    if (stored.kind === "value") {
      return { status: "value", value: stored.value, source: "database", encrypted: stored.encrypted };
    }
    if (stored.kind === "unreadable") return { status: "unreadable", storedKey: k };
  }

  if (def?.envFallback) {
    const fromEnv = process.env[def.envFallback];
    if (fromEnv !== undefined && fromEnv !== "") {
      return { status: "value", value: fromEnv, source: "env", encrypted: false };
    }
  }

  if (def?.default !== undefined) {
    return { status: "value", value: def.default, source: "default", encrypted: false };
  }
  return { status: "unset" };
}

/**
 * Resolved value, or null when nothing usable is configured.
 *
 * Null also for a stored value that cannot be decrypted. That keeps every caller's
 * contract — nothing that reads a setting starts throwing — and every caller already
 * treats null as "not configured", which fails closed. Use `getSettingState` to tell the
 * two apart.
 */
export async function getSetting(key: string): Promise<string | null> {
  const r = resolve(await load(), key);
  return r.status === "value" ? r.value : null;
}

/** Like `getSetting`, but says whether a stored value was there and unreadable. */
export async function getSettingState(key: string): Promise<SettingState> {
  const r = resolve(await load(), key);
  if (r.status !== "value") return r;
  return { status: "value", value: r.value, source: r.source };
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
  /** Choices, for a `select`. Carried from the registry so the page needs no table. */
  options?: { value: string; label: string }[];
  source: SettingSource;
  /** Non-secret values only. Always null for secrets. */
  value: string | null;
  /** Secrets only: `••••••1234`, so it's clear which credential is stored. */
  masked: string | null;
  configured: boolean;
  /** True when the value still comes from .env and hasn't been moved yet. */
  fromEnv: boolean;
  envFallback?: string;
  /**
   * A value IS stored and cannot be decrypted. Nothing falls back past it — not a legacy
   * key, not .env — so the service using it is off until it is re-entered. `source` is
   * "database" and `configured` stays true, so the field can still be cleared.
   */
  unreadable: boolean;
  /** What is wrong with this field and what to do, for the page to show. Null when fine. */
  problem: string | null;
}

/** Shown in the mask slot, which the page already renders as "Currently …". */
const UNREADABLE_MASK = "⚠ can't be decrypted — re-enter it";

function unreadableProblem(def: SettingDef, storedKey: string): string {
  const where =
    storedKey === def.key
      ? "The stored value"
      : `The value stored under its old key ${storedKey}`;
  const why = settingsKeyAvailable()
    ? "SETTINGS_KEY has changed since it was saved, or the stored row is damaged"
    : "SETTINGS_KEY is missing or unusable on this server";
  const fallback = def.envFallback ? ` or to ${def.envFallback}` : "";
  return `${where} can't be decrypted — re-enter it. ${why}. Nothing falls back to an older value${fallback} while it is unreadable.`;
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
    // THE SAME RESOLUTION `getSetting` USES, so the page shows the value that will be used.
    // A renamed key shows its legacy row: a Battle Royale server that the sender reads from
    // the old udpLog.host row while the settings page shows the field empty is the kind of
    // disagreement that gets a destination typed in twice, or a working one "fixed". And an
    // unreadable row is shown as unreadable, because nothing falls back past it.
    const r = resolve(rows, def.key, true);
    const secret = isSecret(def.key);

    let source: SettingSource = "unset";
    let value: string | null = null;
    let masked: string | null = null;
    let unreadable = false;
    let problem: string | null = null;

    if (r.status === "unreadable") {
      source = "database";
      masked = UNREADABLE_MASK;
      unreadable = true;
      problem = unreadableProblem(def, r.storedKey);
    } else if (r.status === "value") {
      source = r.source;
      if (r.source === "database") {
        if (r.encrypted) masked = maskSecret(r.value);
        else value = r.value;
      } else if (r.source === "env") {
        if (secret) masked = maskSecret(r.value);
        else value = r.value;
      } else if (!secret) {
        value = r.value;
      }
    }

    views.push({
      key: def.key,
      label: def.label,
      type: def.type,
      group: def.group,
      help: def.help,
      placeholder: def.placeholder,
      // The choices, for a `select`. Sent with the setting rather than hardcoded in the
      // page, so adding a bundled font is a change to the registry alone and the picker
      // cannot drift out of step with what is actually installed.
      options: def.options,
      source,
      value,
      masked,
      configured: source === "database" || source === "env",
      fromEnv: source === "env",
      envFallback: def.envFallback,
      unreadable,
      problem,
    });
  }

  return views;
}

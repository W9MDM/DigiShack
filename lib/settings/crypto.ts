import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// AES-256-GCM for settings secrets at rest.
//
// GCM rather than CBC because it authenticates as well as encrypts: a tampered
// ciphertext fails to decrypt instead of yielding plausible garbage that then
// gets sent to QRZ or an SMTP server as a password.
//
// Stored format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. The version prefix is
// there so the scheme can be changed later without guessing at old rows.

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;

export class SettingsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsKeyError";
  }
}

/**
 * Master key from SETTINGS_KEY. Accepts 64 hex chars or 44-char base64 — both
 * are 32 bytes. Generate one with:
 *
 *   openssl rand -hex 32
 *
 * Deliberately NOT derived from a passphrase and NOT given a default: a default
 * key is the same as no encryption, and silently generating one per boot would
 * make every stored secret unreadable after a restart.
 */
function loadKey(): Buffer {
  const raw = (process.env.SETTINGS_KEY ?? "").trim();

  if (!raw) {
    throw new SettingsKeyError(
      "SETTINGS_KEY is not set. Generate one with `openssl rand -hex 32` and put it in .env — without it, service credentials cannot be stored.",
    );
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      throw new SettingsKeyError(
        "SETTINGS_KEY is not valid hex or base64. Expected 32 bytes (64 hex characters).",
      );
    }
  }

  if (key.length !== KEY_BYTES) {
    throw new SettingsKeyError(
      `SETTINGS_KEY must decode to exactly ${KEY_BYTES} bytes; got ${key.length}. Generate one with \`openssl rand -hex 32\`.`,
    );
  }

  // Reject an all-zero key — that's what a placeholder like
  // SETTINGS_KEY=00000... looks like, and it should fail loudly rather than
  // "work".
  if (timingSafeEqual(key, Buffer.alloc(KEY_BYTES))) {
    throw new SettingsKeyError(
      "SETTINGS_KEY is all zeroes, which is a placeholder rather than a key. Generate a real one with `openssl rand -hex 32`.",
    );
  }

  return key;
}

/** True when secrets can be read and written. Checked before offering the UI. */
export function settingsKeyAvailable(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

export function settingsKeyProblem(): string | null {
  try {
    loadKey();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "SETTINGS_KEY is unusable";
  }
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Returns null rather than throwing on anything unreadable — a corrupt row, or a
 * row written under a different SETTINGS_KEY, must not take down every page that
 * happens to read a setting. Callers treat null as "not configured".
 */
export function decryptSecret(stored: string): string | null {
  const parts = stored.split(":");
  if (parts.length !== 4) return null;

  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) return null;

  try {
    const key = loadKey();
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");

    if (iv.length !== IV_BYTES || tag.length !== 16) return null;

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Wrong key, tampered ciphertext, or missing SETTINGS_KEY.
    return null;
  }
}

/** `••••••1234` — enough to confirm which credential is stored, no more. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "••••";
  return `••••••${plaintext.slice(-4)}`;
}

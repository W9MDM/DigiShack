import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt from node:crypto rather than argon2 or bcrypt.
//
// Both alternatives are native modules, which means prebuilt binaries per
// platform — this repo is authored on Windows and deployed on Linux under PM2,
// and a failed native rebuild on deploy takes down login. scrypt is memory-hard,
// is on OWASP's accepted list for password storage, and ships in Node core, so
// there is nothing to compile and nothing to break on the target host.
//
// N=2^16, r=8, p=1 costs ~64 MB and ~100ms per hash. That is deliberately slow:
// logins are rare, and the cost is what makes offline cracking expensive.
// Swapping in argon2id later is a drop-in — the stored format carries its own
// parameters, so old hashes stay verifiable (see needsRehash).

const N = 2 ** 16;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

// Node's default maxmem is 32 MB, which these parameters exceed.
const MAXMEM = 256 * 1024 * 1024;

/** Stored form: `scrypt$N$r$p$saltBase64$hashBase64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored value, so a corrupt row can't be distinguished from a wrong password.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;

  const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  if (scheme !== "scrypt" || !nRaw || !rRaw || !pRaw || !saltB64 || !hashB64) {
    return false;
  }

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  // Refuse absurd stored parameters rather than letting a poisoned row exhaust
  // memory on every login attempt.
  if (n > 2 ** 20 || r > 32 || p > 16) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
    salt = Buffer.from(saltB64, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

// Re-exported so server-side callers keep one import. The value itself lives in
// password-policy.ts, which the browser can load — this module cannot, because of the
// node:crypto import at the top, and a page that reached for the constant here crashed on
// load rather than failing to build. See the note in password-policy.ts.
export { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";

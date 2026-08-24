import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { Role } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

// Bearer tokens for the public REST API.
//
// Same storage reasoning as sessions: only the SHA-256 of the token is kept, so a
// database leak yields no usable credentials. A plain hash rather than a slow KDF
// is correct — the token is 256 bits of CSPRNG output, so there is no dictionary
// to attack, and an API key is verified on every request where a 100 ms KDF would
// be a denial of service against ourselves.

/** Recognisable prefix so a leaked key is greppable in logs and repos. */
const TOKEN_PREFIX = "dsk_";
const TOKEN_BYTES = 32;

export interface ApiKeyIdentity {
  kind: "apikey";
  id: string;
  name: string;
  role: Role;
}

export function generateApiKey(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    hash: hashApiKey(token),
    // Enough to tell two keys apart in a list, not enough to be useful.
    prefix: token.slice(0, 12),
  };
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** `Authorization: Bearer dsk_…`, or `X-API-Key: dsk_…`. */
export function readApiKeyFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
  }

  const header = req.headers["x-api-key"];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.trim() || null;
}

/**
 * Resolve a request's API key, or null.
 *
 * Rejects inactive and expired keys on every request rather than at issue time,
 * so revoking a key takes effect immediately.
 */
export async function getApiKeyIdentity(
  req: IncomingMessage,
): Promise<ApiKeyIdentity | null> {
  const token = readApiKeyFromRequest(req);
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    select: {
      id: true,
      name: true,
      role: true,
      active: true,
      expiresAt: true,
      lastUsedAt: true,
    },
  });

  if (!key || !key.active) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

  // Throttled like session lastSeenAt — one write per request would double the
  // cost of every API call for information that is only ever read by a human.
  const stale =
    !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 5 * 60 * 1000;
  if (stale) {
    await prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return { kind: "apikey", id: key.id, name: key.name, role: key.role };
}

/** Roles an API key may hold. Deliberately excludes ADMIN. */
export const API_KEY_ROLES = ["VIEWER", "OPERATOR"] as const;

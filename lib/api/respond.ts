import type { NextApiRequest, NextApiResponse } from "next";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// BigInt-safe JSON
// ---------------------------------------------------------------------------
//
// `Qso.freqHz` and `PskSpot.freqHz` are Prisma `BigInt`, and `res.json()` throws
// "Do not know how to serialize a BigInt" the moment one appears in a payload.
// Every JSON response in DigiShack must go through sendJson().
//
// BigInts are emitted as JSON *numbers*, not strings. The highest amateur
// allocation is 250 GHz (2.5e11 Hz), eleven orders of magnitude below
// Number.MAX_SAFE_INTEGER (9.007e15), so no precision is lost — and a public API
// that returns frequency as a number is far easier for third-party clients
// (fldigi, GridTracker) to consume than one that returns a quoted string.
// Anything genuinely too large to represent throws rather than silently
// rounding.

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(
        `BigInt ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be serialized safely`,
      );
    }
    return Number(value);
  }
  return value;
}

export function sendJson(
  res: NextApiResponse,
  status: number,
  data: unknown,
): void {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // JSON.stringify (not res.json) so the replacer runs. Dates still serialize
  // to ISO-8601 via their own toJSON.
  res.send(JSON.stringify(data, bigintReplacer));
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export function sendError(
  res: NextApiResponse,
  status: number,
  error: string,
  details?: unknown,
): void {
  sendJson(res, status, details === undefined ? { error } : { error, details });
}

// ---------------------------------------------------------------------------
// Method routing + error translation
// ---------------------------------------------------------------------------

type Handler = (
  req: NextApiRequest,
  res: NextApiResponse,
) => Promise<void> | void;

/**
 * Dispatch by HTTP method, with a correct 405 (including the `Allow` header,
 * which the spec's public REST API will need to behave properly for clients).
 * Wraps every handler so thrown Zod/Prisma errors become the right status code
 * instead of an opaque 500.
 */
export function route(handlers: Partial<Record<string, Handler>>): Handler {
  const allowed = Object.keys(handlers);

  return async (req, res) => {
    const handler = req.method ? handlers[req.method] : undefined;

    if (!handler) {
      res.setHeader("Allow", allowed.join(", "));
      sendError(res, 405, `Method ${req.method ?? "?"} not allowed`);
      return;
    }

    try {
      await handler(req, res);
    } catch (err) {
      handleError(res, err);
    }
  };
}

function handleError(res: NextApiResponse, err: unknown): void {
  if (err instanceof ZodError) {
    sendError(res, 400, "Validation failed", flattenZodError(err));
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        sendError(res, 409, "A record with these values already exists", {
          target: err.meta?.target,
        });
        return;
      case "P2003":
      case "P2025":
        // Missing FK target, or update/delete against a row that isn't there.
        sendError(res, 404, "Referenced record not found", {
          cause: err.meta?.cause ?? err.meta?.field_name,
        });
        return;
      case "P2000":
        sendError(res, 400, "A value is too long for its column", {
          column: err.meta?.column_name,
        });
        return;
    }
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    // Almost always a bad DATABASE_URL or MySQL not running. Surfacing this
    // clearly saves a lot of guessing on first setup.
    console.error("[api] database unavailable:", err.message);
    sendError(res, 503, "Database unavailable — check DATABASE_URL and that MySQL is running");
    return;
  }

  console.error("[api] unhandled error:", err);
  sendError(res, 500, "Internal server error");
}

/** Field-keyed messages, which is what a form needs to render inline errors. */
export function flattenZodError(err: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query-param helpers
// ---------------------------------------------------------------------------

/** Next gives `string | string[] | undefined`; collapse to the first value. */
export function queryParam(
  req: NextApiRequest,
  key: string,
): string | undefined {
  const v = req.query[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

export function queryInt(
  req: NextApiRequest,
  key: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = queryParam(req, key);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

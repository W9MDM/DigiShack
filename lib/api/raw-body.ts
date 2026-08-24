import type { NextApiRequest } from "next";

// Read the request body as an untouched Buffer.
//
// Next's built-in body parser decodes the body to a string for anything it does
// not recognise as JSON or form data. That is lossy for binary — a gzipped
// cty.xml comes back with its magic bytes mangled — and it is subtly wrong even
// for text, because ADIF field lengths are byte counts and a decode/re-encode
// round trip can shift them.
//
// Routes using this must disable the parser:
//
//   export const config = { api: { bodyParser: false } };

export interface RawBodyOptions {
  /** Reject anything larger, rather than buffering it. Default 64 MiB. */
  maxBytes?: number;
}

export class BodyTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Request body exceeds the ${Math.round(limit / 1024 / 1024)} MB limit`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

export async function readRawBody(
  req: NextApiRequest,
  { maxBytes = 64 * 1024 * 1024 }: RawBodyOptions = {},
): Promise<Buffer> {
  // If something upstream already parsed it, use that rather than re-reading a
  // consumed stream.
  if (Buffer.isBuffer(req.body)) return req.body;

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) {
      // Stop reading immediately; don't accumulate a body we've already refused.
      req.destroy();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks, total);
}

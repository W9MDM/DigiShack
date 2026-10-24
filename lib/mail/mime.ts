// A small MIME reader: enough of RFC 2045-2047 and 2231 to find who sent a message, what it
// is about, its text, and the pictures attached to it.
//
// Written here rather than added as a dependency, and kept deliberately narrow: it is used
// only by the IMAP card importer, which needs headers, multipart structure, base64 and
// quoted-printable, encoded-word subjects and RFC 2231 filenames — and nothing else. It never
// executes, renders or follows anything it parses.
//
// Binary-safe by working in latin1 strings, which map bytes 0-255 one to one, and turning
// only the decoded text into Unicode at the end.
//
// LIMITS, against a hostile or broken message: nesting stops at eight levels and at 200
// parts; anything beyond is ignored rather than recursed into.

export interface MimeLeaf {
  /** "image/jpeg", lower-case, no parameters. */
  contentType: string;
  /** "inline", "attachment", or null when the part did not say. */
  disposition: string | null;
  filename: string | null;
  contentId: string | null;
  /** Decoded bytes. */
  body: Buffer;
  charset: string | null;
}

export interface ParsedMessage {
  headers: Map<string, string[]>;
  subject: string;
  from: { address: string; name: string };
  date: Date | null;
  messageId: string | null;
  contentType: string;
  leaves: MimeLeaf[];
  /** The first text/plain and text/html bodies that are not attachments, decoded. */
  text: string;
  html: string;
}

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

/** Split at the first empty line. Accepts bare LF as well as CRLF. */
function splitHead(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  if (lf >= 0) return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
  return { head: raw, body: "" };
}

/** Header lines, unfolded, keyed lower-case. Values stay in latin1 until decoded. */
export function parseHeaders(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    const list = out.get(name);
    if (list) list.push(value);
    else out.set(name, [value]);
  }
  return out;
}

function decodeCharset(bytes: Buffer, charset: string | null): string {
  const cs = (charset ?? "utf-8").toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

/** Latin1 header text that was really UTF-8 on the wire, as modern mailers send it. */
function rawHeaderText(v: string): string {
  const bytes = Buffer.from(v, "latin1");
  const utf8 = bytes.toString("utf8");
  return utf8.includes("�") ? v : utf8;
}

/** RFC 2047 encoded words: =?utf-8?B?...?= and =?iso-8859-1?Q?...?=. */
export function decodeWords(value: string): string {
  // Whitespace BETWEEN two encoded words is not part of the text (RFC 2047 §6.2).
  // Raw 8-bit UTF-8 first (modern mailers send it unencoded), THEN the encoded words, whose
  // decoded text is already Unicode and must not be reinterpreted.
  const joined = rawHeaderText(value).replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1");
  const decoded = joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
    const charset = cs.split("*")[0] ?? "utf-8";
    let bytes: Buffer;
    if (enc.toUpperCase() === "B") bytes = Buffer.from(text, "base64");
    else bytes = Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return decodeCharset(bytes, charset);
  });
  return decoded;
}

/** "type/sub; name=value; ..." → the value and its parameters, RFC 2231 included. */
export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && quoted && i + 1 < value.length) {
      cur += value[++i];
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  const main = (parts.shift() ?? "").trim().toLowerCase();
  const plain: Record<string, string> = {};
  // RFC 2231: name*=charset'lang'%XX, and continuations name*0, name*1*, ...
  const continued = new Map<string, { n: number; v: string; enc: boolean }[]>();
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i <= 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    const v = p.slice(i + 1).trim();
    const m = /^([^*]+)\*(?:(\d+))?(\*)?$/.exec(key);
    if (m) {
      const name = m[1]!;
      const n = m[2] !== undefined ? Number(m[2]) : 0;
      const enc = m[3] === "*" || (m[2] === undefined && key.endsWith("*"));
      const list = continued.get(name) ?? [];
      list.push({ n, v, enc });
      continued.set(name, list);
    } else {
      plain[key] = v;
    }
  }
  for (const [name, list] of continued) {
    list.sort((a, b) => a.n - b.n);
    let charset = "utf-8";
    const bytes: number[] = [];
    list.forEach((seg, idx) => {
      let v = seg.v;
      if (seg.enc && idx === 0) {
        const q = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (q) {
          charset = q[1] || "utf-8";
          v = q[2] ?? "";
        }
      }
      if (seg.enc) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
            bytes.push(parseInt(v.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(v.charCodeAt(i) & 0xff);
        }
      } else {
        for (let i = 0; i < v.length; i++) bytes.push(v.charCodeAt(i) & 0xff);
      }
    });
    plain[name] = decodeCharset(Buffer.from(bytes), charset);
  }
  return { value: main, params: plain };
}

export function decodeQuotedPrintable(s: string): Buffer {
  const soft = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const ch = soft[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeTransfer(body: string, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(body, "latin1");
}

/** The parts of a multipart body, between its boundary lines. */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  let pos = 0;
  let start = -1;
  for (;;) {
    let at = body.indexOf(delim, pos);
    // A delimiter only counts at the start of a line.
    while (at > 0 && body[at - 1] !== "\n") at = body.indexOf(delim, at + 1);
    if (at < 0) break;
    if (start >= 0) {
      // The CRLF before a delimiter belongs to the delimiter, not the part.
      let end = at;
      if (body[end - 1] === "\n") end--;
      if (body[end - 1] === "\r") end--;
      parts.push(body.slice(start, end));
    }
    const close = body.startsWith("--", at + delim.length);
    if (close) return parts;
    const eol = body.indexOf("\n", at);
    if (eol < 0) break;
    start = eol + 1;
    pos = start;
  }
  // No closing delimiter: keep what was there, as most clients do.
  if (start >= 0 && start < body.length) parts.push(body.slice(start));
  return parts;
}

function walk(raw: string, depth: number, leaves: MimeLeaf[], defaultType = "text/plain"): void {
  if (leaves.length >= MAX_PARTS) return;
  const { head, body } = splitHead(raw);
  const headers = parseHeaders(head);
  const ct = parseParams(headers.get("content-type")?.[0] ?? defaultType);
  const type = ct.value || defaultType;
  if (type.startsWith("multipart/") && ct.params.boundary) {
    if (depth >= MAX_DEPTH) return;
    const inner = type === "multipart/digest" ? "message/rfc822" : "text/plain";
    for (const part of splitMultipart(body, ct.params.boundary)) walk(part, depth + 1, leaves, inner);
    return;
  }
  const disp = headers.get("content-disposition")?.[0];
  const dp = disp ? parseParams(disp) : null;
  const rawName = dp?.params.filename ?? ct.params.name ?? null;
  leaves.push({
    contentType: type,
    disposition: dp?.value || null,
    filename: rawName ? decodeWords(rawName) : null,
    contentId: headers.get("content-id")?.[0]?.replace(/^<|>$/g, "") ?? null,
    body: decodeTransfer(body, headers.get("content-transfer-encoding")?.[0] ?? "7bit"),
    charset: ct.params.charset ?? null,
  });
}

/** "Name" <addr@x>, Name <addr@x>, or addr@x. */
export function parseAddress(value: string): { address: string; name: string } {
  const decoded = decodeWords(value);
  const angle = /<([^>]*)>/.exec(decoded);
  if (angle) {
    const name = decoded.slice(0, angle.index).trim().replace(/^"|"$/g, "").trim();
    return { address: (angle[1] ?? "").trim().toLowerCase(), name };
  }
  const bare = /[^\s<>"]+@[^\s<>"]+/.exec(decoded);
  return { address: (bare?.[0] ?? "").toLowerCase(), name: "" };
}

/** Parse a whole message, or just its headers (pass the header block alone). */
export function parseMime(input: Buffer): ParsedMessage {
  const raw = input.toString("latin1");
  const { head } = splitHead(raw);
  const headers = parseHeaders(head);
  const leaves: MimeLeaf[] = [];
  walk(raw, 0, leaves);
  const isAttachment = (l: MimeLeaf) => l.disposition === "attachment" || (l.filename !== null && !l.contentType.startsWith("text/"));
  const textLeaf = leaves.find((l) => l.contentType === "text/plain" && !isAttachment(l));
  const htmlLeaf = leaves.find((l) => l.contentType === "text/html" && !isAttachment(l));
  const dateRaw = headers.get("date")?.[0];
  const date = dateRaw ? new Date(dateRaw) : null;
  return {
    headers,
    subject: decodeWords(headers.get("subject")?.[0] ?? ""),
    from: parseAddress(headers.get("from")?.[0] ?? ""),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    messageId: headers.get("message-id")?.[0]?.trim() ?? null,
    contentType: parseParams(headers.get("content-type")?.[0] ?? "text/plain").value,
    leaves,
    text: textLeaf ? decodeCharset(textLeaf.body, textLeaf.charset) : "",
    html: htmlLeaf ? decodeCharset(htmlLeaf.body, htmlLeaf.charset) : "",
  };
}

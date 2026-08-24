// A minimal tar reader and writer, in pure Node.
//
// Same reasoning as the SQL dump next door: a backup that depends on a tool the
// operator has to install separately is a backup that does not get used. There is no
// `tar` on a default Windows box and no archive library in this project's
// dependencies, so rather than add one for a format this simple, here it is.
//
// The format is ustar (POSIX.1-1988): a 512-byte header per entry, the file contents
// padded to a 512-byte boundary, and two zero blocks at the end. That is the whole
// specification for what is needed here. Nothing exotic is emitted — no symlinks, no
// long-name extensions, no sparse files — and the reader accepts long names in the
// GNU and PAX forms only far enough to fail clearly rather than silently.
//
// The archive is gzipped as a whole, by the caller. Files are NOT compressed
// individually: the SQL dump compresses about 20:1 and PNG artwork not at all, and
// compressing the stream once is both smaller and simpler than per-entry.

/** Every field in a tar header is a fixed-width slice of 512 bytes. */
const BLOCK = 512;

export interface TarEntry {
  name: string;
  data: Buffer;
  /** Unix mode. Only used on extraction by tools that care. */
  mode?: number;
  mtime?: Date;
}

function octal(value: number, width: number): string {
  // Width includes the trailing NUL that tar expects on numeric fields.
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/**
 * Build one 512-byte header.
 *
 * The checksum is computed with the checksum field itself treated as eight spaces —
 * a quirk of the format, and the single most common way a hand-written tar comes out
 * unreadable. Every extractor verifies it.
 */
function header(entry: TarEntry): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const name = entry.name.replace(/^\/+/, "");

  // 100 bytes for the name. Longer needs a PAX extension, and rather than write one
  // and get it subtly wrong, this refuses: every name it produces is short.
  const nameBytes = Buffer.byteLength(name, "utf8");
  if (nameBytes > 100) {
    throw new Error(`tar: name too long (${nameBytes} bytes, max 100): ${name}`);
  }

  buf.write(name, 0, "utf8");
  buf.write(octal(entry.mode ?? 0o644, 8), 100, "ascii"); // mode
  buf.write(octal(0, 8), 108, "ascii"); // uid
  buf.write(octal(0, 8), 116, "ascii"); // gid
  buf.write(octal(entry.data.length, 12), 124, "ascii"); // size
  buf.write(octal(Math.floor((entry.mtime ?? new Date()).getTime() / 1000), 12), 136, "ascii");
  buf.write("        ", 148, "ascii"); // checksum placeholder: eight spaces
  buf.write("0", 156, "ascii"); // type flag: regular file
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");

  let sum = 0;
  for (const byte of buf) sum += byte;
  // Six octal digits, a NUL, then a space. Writing it any other way is accepted by
  // some extractors and rejected by others, which is worse than being wrong.
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

function pad(length: number): Buffer {
  const rem = length % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/** Pack entries into an uncompressed tar archive. */
export function tarPack(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e), e.data, pad(e.data.length));
  }
  // Two zero blocks terminate the archive. One is enough for some readers and not
  // for others; the specification says two.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const s = readString(buf, offset, length).trim();
  if (s === "") return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Unpack a tar archive.
 *
 * Verifies every checksum. A backup that restores mangled data is far worse than one
 * that refuses to restore, so a bad block is an error rather than a skipped entry.
 */
export function tarUnpack(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let offset = 0;
  let terminated = false;

  while (offset + BLOCK <= buf.length) {
    const head = buf.subarray(offset, offset + BLOCK);

    // An all-zero block is the terminator.
    if (head.every((b) => b === 0)) {
      terminated = true;
      break;
    }

    const stored = readOctal(head, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      // The checksum field counts as spaces, exactly as when it was written.
      sum += i >= 148 && i < 156 ? 0x20 : head[i]!;
    }
    if (sum !== stored) {
      throw new Error(
        `tar: checksum mismatch at byte ${offset} (got ${sum}, header says ${stored}) — the archive is corrupt or truncated`,
      );
    }

    const name = readString(head, 0, 100);
    const size = readOctal(head, 124, 12);
    const type = readString(head, 156, 1);
    const mtime = new Date(readOctal(head, 136, 12) * 1000);
    const mode = readOctal(head, 100, 8);

    offset += BLOCK;

    // Long-name extensions (GNU 'L', PAX 'x'/'g') are never produced here. Failing
    // loudly beats extracting an entry under the wrong name.
    if (type === "L" || type === "x" || type === "g") {
      throw new Error(`tar: extended header type '${type}' is not supported`);
    }

    const dataEnd = offset + size;
    if (dataEnd > buf.length) {
      throw new Error(`tar: entry '${name}' claims ${size} bytes but the archive ends first`);
    }

    // Type "0" and the historical "\0" both mean a regular file. Directories ("5")
    // carry no data and are not needed: every entry name includes its full path.
    if (type === "0" || type === "" || type === "\0") {
      out.push({ name, data: Buffer.from(buf.subarray(offset, dataEnd)), mode, mtime });
    }

    offset = dataEnd + pad(size).length;
  }

  // No terminator means the archive was cut short.
  //
  // Truncation part-way through a payload is caught above, but truncation on a block
  // boundary is not: every entry read is valid and the loop simply runs out of input.
  // A bundle that lost its tail in transfer would then restore whatever arrived and
  // report success — the artwork silently missing, or the dump silently partial.
  if (!terminated) {
    throw new Error(
      `tar: the archive ends without a terminator after ${out.length} entr${out.length === 1 ? "y" : "ies"} — it is truncated`,
    );
  }

  return out;
}

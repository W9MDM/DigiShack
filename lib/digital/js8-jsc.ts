// JS8's dictionary compression ("JSC"): words and word pieces from a 262,144-entry table,
// written as variable-length codes of 4-bit groups.
//
// Ported from JS8Call's jsc.cpp (GPL-3.0; DigiShack is GPL-3.0). The table itself is
// jsc_map.cpp, six megabytes of C++ initialiser, carried here as one word per line in
// js8-jsc-words.txt in table order, so that the line number is the code index. It is read
// once, on first use, by the process that decodes (the bridge); nothing in a page imports
// this module.
//
// THE CODE. An index i is written as a run of 4-bit groups: first the "higher digits",
// each in [s, 16) where s = 7 (so nine values, base c = 9), most significant first, then
// a final group in [0, s) carrying the lowest digit, and after that final group one more
// bit: 1 if a space follows the word, 0 if not. Decoding reads groups until one is below
// s, reads the bit after it, and rebuilds the index with an offset for the run length
// (the `base` table), which is how a run of k groups maps onto a distinct index range.
//
// COMPRESSING is a choice of segmentation; any valid run of codes decodes to the same
// text, so this takes the longest dictionary entry that prefixes the remaining word at
// each step, which is what the reference's prefix-ordered search amounts to. A word with
// no entry at all stops the frame, as the reference's does.

import fs from "node:fs";
import path from "node:path";

import { js8Pack72, js8PackHuffmanFrame } from "@/lib/digital/js8-message";

const B = 4;
const S = 7;
const C = (1 << B) - S;
const SIZE = 262144;

let words: string[] | null = null;
let lookup: Map<string, number> | null = null;
let longest = 0;

/** Where the table lives: under the project root (where the bridge runs from), or beside this module. */
function tablePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "lib/digital/js8-jsc-words.json"),
    path.resolve(__dirname, "js8-jsc-words.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("js8-jsc-words.json is missing: the JS8 dictionary table is not where the bridge runs from");
}

function load(): string[] {
  if (words) return words;
  const list = JSON.parse(fs.readFileSync(tablePath(), "utf8")) as unknown;
  if (!Array.isArray(list) || list.length !== SIZE) throw new Error(`js8-jsc-words.json does not hold ${SIZE} entries`);
  words = list as string[];
  return words;
}

function index(): Map<string, number> {
  if (lookup) return lookup;
  const list = load();
  const m = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!;
    // The first occurrence wins, as the reference's search returns the first match.
    if (!m.has(w)) m.set(w, i);
    if (w.length > longest) longest = w.length;
  }
  lookup = m;
  return m;
}

/** Whether the table is available here. */
export function js8JscAvailable(): boolean {
  try {
    tablePath();
    return true;
  } catch {
    return false;
  }
}

/** The word at a code index, for tests. */
export function js8JscWord(i: number): string | undefined {
  return load()[i];
}

/** The code for an index, as JSC::codeword. `separate` says a space follows. */
export function js8JscCodeword(idx: number, separate: boolean): number[] {
  const groups: number[][] = [];
  const v = ((idx % S) << 1) + (separate ? 1 : 0);
  groups.unshift(toBits(v, B + 1));
  let x = Math.floor(idx / S);
  while (x > 0) {
    x -= 1;
    groups.unshift(toBits((x % C) + S, B));
    x = Math.floor(x / C);
  }
  return groups.flat();
}

function toBits(value: number, n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push((value >> i) & 1);
  return out;
}

/** Text to codes: each entry is the bits and how many characters of the text they took (including a following space). */
export function js8JscCompress(text: string): { bits: number[]; chars: number }[] {
  const dict = index();
  const out: { bits: number[]; chars: number }[] = [];
  const parts = text.split(" ");
  for (let i = 0; i < parts.length; i++) {
    let w = parts[i]!;
    const isLastWord = i === parts.length - 1;
    let isSpaceCharacter = false;
    if (w === "" && !isLastWord) {
      w = " ";
      isSpaceCharacter = true;
    }
    while (w.length > 0) {
      // Longest entry that prefixes what is left of the word.
      let hit: { idx: number; len: number } | null = null;
      for (let len = Math.min(w.length, longest); len >= 1; len--) {
        const idx = dict.get(w.slice(0, len));
        if (idx !== undefined) {
          hit = { idx, len };
          break;
        }
      }
      if (!hit) return out;
      w = w.slice(hit.len);
      const isLast = w.length === 0;
      const shouldAppendSpace = isLast && !isSpaceCharacter && !isLastWord;
      out.push({ bits: js8JscCodeword(hit.idx, shouldAppendSpace), chars: hit.len + (shouldAppendSpace ? 1 : 0) });
    }
  }
  return out;
}

/** Codes to text, as JSC::decompress. */
export function js8JscDecompress(bits: ArrayLike<number>): string {
  const list = load();
  const base = [0, S];
  for (let k = 2; k < 8; k++) base.push(base[k - 1]! + S * C ** (k - 1));
  const bytes: number[] = [];
  const separators: number[] = [];
  let i = 0;
  const count = bits.length;
  while (i < count) {
    if (count - i < 4) break;
    let byte = 0;
    for (let k = 0; k < 4; k++) byte = (byte << 1) | (bits[i + k]! & 1);
    bytes.push(byte);
    i += 4;
    if (byte < S) {
      if (count - i > 0 && bits[i]) separators.push(bytes.length - 1);
      i += 1;
    }
  }
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let k = 0;
    let j = 0;
    while (start + k < bytes.length && bytes[start + k]! >= S) {
      j = j * C + (bytes[start + k]! - S);
      k++;
    }
    if (j >= SIZE) break;
    if (start + k >= bytes.length) break;
    j = j * S + bytes[start + k]! + (base[k] ?? Infinity);
    if (j >= SIZE) break;
    out.push(list[j]!);
    if (separators.length > 0 && separators[0] === start + k) {
      out.push(" ");
      separators.shift();
    }
    start = start + (k + 1);
  }
  return out.join("");
}

/**
 * A data frame for a text: whichever of Huffman and the dictionary carries more of it, as
 * the reference's packDataMessage chooses. Returns the frame and how many characters it took.
 */
export function js8PackDataFrame(text: string): { frame: string; chars: number; compressed: boolean } {
  const huff = js8PackHuffmanFrame(text);
  const jsc = js8JscFrameBits(text);
  if (huff.chars > jsc.chars) return { frame: huff.frame, chars: huff.chars, compressed: false };
  let value = 0n;
  for (let i = 0; i < 64; i++) value = (value << 1n) | BigInt(jsc.bits[i]! & 1);
  let rem = 0;
  for (let i = 64; i < 72; i++) rem = (rem << 1) | (jsc.bits[i]! & 1);
  return { frame: js8Pack72(value, rem), chars: jsc.chars, compressed: true };
}

/**
 * A data frame of dictionary text: the prefix bits 1 and 1, as many codes as fit, then the
 * padding (a 0 and then 1s). Returns the frame's 72 bits and how many characters it took.
 */
export function js8JscFrameBits(text: string): { bits: number[]; chars: number } {
  const frameBits: number[] = [1, 1];
  let chars = 0;
  for (const piece of js8JscCompress(text)) {
    if (frameBits.length + piece.bits.length < 72) {
      frameBits.push(...piece.bits);
      chars += piece.chars;
      continue;
    }
    break;
  }
  const pad = 72 - frameBits.length;
  for (let i = 0; i < pad; i++) frameBits.push(i === 0 ? 0 : 1);
  return { bits: frameBits, chars };
}

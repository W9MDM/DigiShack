// Reading an SSTV picture's text: the callsigns and the report a station writes on what it
// sends. SSTV carries no text of its own - "N3CHX DE K9XYZ UR 595" is drawn on the picture -
// so the only way to read it is to read the picture, with OCR. Done on the bridge after the
// picture is saved, by tesseract.js with the English data from @tesseract.js-data/eng in
// node_modules, so nothing is fetched at run time. What it reads is a suggestion for the
// reply box, never logged unseen: a fade across the caption, or a callsign in a fancy font,
// reads wrong as easily as right.

import path from "node:path";

/** A callsign as written on a picture: prefix, digit, suffix, optionally /P and the like. */
const CALL = /^(?:[A-Z]{1,2}|[A-Z]\d|\d[A-Z])\d[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;
/** Words that put a report after them. */
const REPORT_WORDS = new Set(["UR", "RSV", "RST", "RPT", "RPRT", "RS", "REPORT", "SIG"]);
/** An RSV (595) or, after a report word, an RS (59). */
const RSV = /^[1-5][1-9][1-9]$/;
const RS = /^[1-5][1-9]$/;

export interface SstvRead {
  /** Every callsign read, in the order written, ours excepted. */
  calls: string[];
  /** The station that sent it: the call after DE, or the first one that is not ours. */
  theirCall: string | null;
  /** The report it gives us, when it names us or puts one after UR/RSV/RST. */
  reportRcvd: string | null;
  /** Our callsign is on it: the picture was sent to us. */
  toUs: boolean;
  /** The text as read, for the operator to check against. */
  text: string;
}

/**
 * OCR's commonest slips in a callsign's digit: O for 0, I or L for 1. Only for the word after
 * DE, where a call is expected: anywhere else "FROM" and "HELLO" would turn into FR0M and
 * HE1LO, which have a callsign's shape.
 */
function fixDigit(tok: string): string {
  if (tok.length < 4) return tok;
  return tok.replace(/^([A-Z]{1,2}|[A-Z]\d|\d[A-Z])([OIL])(?=[A-Z]{1,4}(?:\/|$))/, (_, p: string, d: string) => p + (d === "O" ? "0" : "1"));
}

/**
 * Our own call, allowing one character misread: we know what it should say, and OCR reads
 * K9XYZ as WOMDM or WIMDM on a busy picture. Four characters or more, so a short word is
 * never taken for it.
 */
function isMine(word: string, mine: string): boolean {
  const w = word.replace(/\/.*$/, "");
  if (!mine || w.length !== mine.length) return false;
  if (w === mine) return true;
  if (mine.length < 4) return false;
  let diff = 0;
  for (let i = 0; i < w.length; i++) if (w[i] !== mine[i]) diff++;
  return diff <= 1;
}

/** The calls and report in OCR text. Pure, so check:sstv-read tests it without the OCR. */
export function parseSstvText(text: string, myCall: string | null): SstvRead {
  const mine = (myCall ?? "").toUpperCase().replace(/\/.*$/, "");
  const words = text
    .toUpperCase()
    .split(/[^A-Z0-9/]+/)
    .filter((w) => w.length > 0);
  const calls: string[] = [];
  let theirCall: string | null = null;
  let reportRcvd: string | null = null;
  let toUs = false;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!;
    if (isMine(raw, mine)) {
      toUs = true;
      continue;
    }
    const w = CALL.test(raw) || words[i - 1] !== "DE" ? raw : fixDigit(raw);
    if (CALL.test(w) && /\d/.test(w)) {
      if (!calls.includes(w)) calls.push(w);
      if (theirCall === null && words[i - 1] === "DE") theirCall = w;
      continue;
    }
    if (reportRcvd === null && REPORT_WORDS.has(words[i - 1] ?? "") && (RSV.test(raw) || RS.test(raw))) reportRcvd = raw;
  }
  // A bare 595 with no report word counts only on a picture addressed to us.
  if (reportRcvd === null && toUs) reportRcvd = words.find((w) => RSV.test(w)) ?? null;
  return { calls, theirCall: theirCall ?? calls[0] ?? null, reportRcvd, toUs, text: text.trim() };
}

type OcrWorker = { recognize: (img: Buffer) => Promise<{ data: { text: string } }>; setParameters: (p: Record<string, string>) => Promise<unknown> };
let worker: Promise<{ w: OcrWorker; sparse: string; block: string }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<{ w: OcrWorker; sparse: string; block: string }> {
  worker ??= (async () => {
    const { createWorker, PSM } = await import("tesseract.js");
    const langPath = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
    const w = (await createWorker("eng", 1, { langPath, cacheMethod: "none", gzip: true })) as unknown as OcrWorker;
    return { w, sparse: String(PSM.SPARSE_TEXT), block: String(PSM.SINGLE_BLOCK) };
  })().catch((err) => {
    worker = null;
    throw err;
  });
  return worker;
}

/** Rows [top, top + h) of a picture, scaled up twice over, smoothly (bilinear). */
function strip2x(width: number, rgb: ArrayLike<number>, top: number, h: number): { width: number; height: number; rgb: Uint8Array } {
  const W = width * 2;
  const H = h * 2;
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(h - 1, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(width - 1, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const dx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number) => rgb[((top + yy) * width + xx) * 3 + c]!;
        const v = (p(y0, x0) * (1 - dx) + p(y0, x1) * dx) * (1 - dy) + (p(y1, x0) * (1 - dx) + p(y1, x1) * dx) * dy;
        out[(y * W + x) * 3 + c] = Math.round(v);
      }
    }
  }
  return { width: W, height: H, rgb: out };
}

/**
 * Read the text on a picture. One at a time: a picture is minutes apart, OCR is a second.
 *
 * Three passes, their text joined. The bottom and top fifths, where a caption goes, scaled
 * up twice and read as one block: a reply's "K9XYZ DE KD9XYZ UR 577" is 17 pixels tall on a
 * 320-pixel picture, too small to read at its own size and read almost exactly at twice it.
 * Then the whole picture as received, sparse text, which catches a call written anywhere:
 * the N3CHX picture's corner call reads that way and is lost by scaling the whole picture.
 */
export function readSstvPicture(
  width: number,
  height: number,
  rgb: ArrayLike<number>,
  myCall: string | null,
  encodePng: (w: number, h: number, rgb: ArrayLike<number>) => Buffer,
): Promise<SstvRead> {
  const job = queue.then(async () => {
    const { w, sparse, block } = await getWorker();
    const fifth = Math.max(8, Math.round(height / 5));
    const texts: string[] = [];
    await w.setParameters({ tessedit_pageseg_mode: block });
    for (const top of [height - fifth, 0]) {
      const s = strip2x(width, rgb, top, fifth);
      texts.push((await w.recognize(encodePng(s.width, s.height, s.rgb))).data.text);
    }
    await w.setParameters({ tessedit_pageseg_mode: sparse });
    texts.push((await w.recognize(encodePng(width, height, rgb))).data.text);
    return parseSstvText(texts.join("\n"), myCall);
  });
  queue = job.catch(() => undefined);
  return job;
}

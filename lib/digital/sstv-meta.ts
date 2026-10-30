// The notes the bridge keeps beside each received SSTV picture, data/sstv/<picture>.json:
// where it was heard, how it came through, what was read off it, and the contact it was
// logged as. Written by services/radio/index.ts and /api/sstv/log, read by /api/sstv.
import fs from "node:fs";
import path from "node:path";

import type { SstvSignal } from "@/lib/digital/sstv";
import type { SstvRead } from "@/lib/digital/sstv-read";

export const SSTV_DIR = path.join(process.cwd(), "data", "sstv");
export const SSTV_PICTURE_NAME = /^\d{8}-\d{6}-[A-Za-z0-9]+\.png$/;

export interface SstvMeta {
  mode: string;
  at: string;
  freqHz: number | null;
  band: string | null;
  signal: SstvSignal;
  sMeterDbm: number | null;
  rsv: { r: number; s: number; v: number; report: string; sMeasured: boolean };
  read?: SstvRead;
  logged?: { qsoId: string; callsign: string; at: string };
}

const metaPath = (file: string) => path.join(SSTV_DIR, file.replace(/\.png$/, ".json"));

/** A picture's notes, or null for one saved before there were any. */
export async function readSstvMeta(file: string): Promise<SstvMeta | null> {
  if (!SSTV_PICTURE_NAME.test(file)) return null;
  try {
    return JSON.parse(await fs.promises.readFile(metaPath(file), "utf8")) as SstvMeta;
  } catch {
    return null;
  }
}

export async function writeSstvMeta(file: string, meta: Partial<SstvMeta>): Promise<void> {
  if (!SSTV_PICTURE_NAME.test(file)) throw new Error("Not a picture name");
  await fs.promises.writeFile(metaPath(file), JSON.stringify(meta));
}

// Every decode, on disk, one file per UTC day.
//
// The database already holds decodes, and prunes them after thirty days by default —
// 42,000 rows a day on a busy band is 3.7 GB a year, and that retention is the right
// call for a table the application queries. But it means the raw feed is gone, and the
// raw feed is what you want months later when the question is "what did this station
// actually hear on the night of the contest", or when something needs re-analysing with
// a tool that is not this one.
//
// A CSV per UTC day is the format that survives: greppable, sortable, opens in
// anything, and needs no schema. The day boundary comes from each decode's OWN
// timestamp rather than from the clock at write time, so a window that lands at 23:59:45
// goes in the day it belongs to rather than the day it was flushed in.
//
// Failure here must never affect operating. A full disk, a directory that vanished, a
// permissions change — all of them cost decodes in a file and nothing else, so every
// error is logged once per minute and swallowed.

import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DecodeRow {
  /** When the window this decode came from started. */
  at: Date;
  band: string | null;
  mode: string;
  snr: number;
  /**
   * Seconds into the window their transmission started, or null when it was not kept.
   *
   * `DigitalDecode` has never stored DT — it is a decode-quality figure rather than log
   * data — so rows exported from the database leave this empty rather than inventing a
   * zero, which would read as perfect timing.
   */
  dt: number | null;
  /** Audio offset within the passband. */
  offsetHz: number;
  /** Dial frequency, so a row is meaningful without the rest of the file. */
  dialHz: number | null;
  message: string;
  callsign: string | null;
  /** Which radio heard it. */
  radio: string | null;
}

const HEADER = "utc,band,mode,snr,dt,offset_hz,dial_hz,callsign,message,radio";

/**
 * One CSV field.
 *
 * Quoted only when it has to be. FT8 messages are thirteen characters of uppercase and
 * digits and never need it, but this also carries park names and radio models, and a
 * comma in one of those would silently shift every later column by one.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(r: DecodeRow): string {
  return [
    csvField(r.at.toISOString()),
    csvField(r.band),
    csvField(r.mode),
    csvField(r.snr),
    // Two decimals: DT is meaningful to about a hundredth and the raw float prints
    // seventeen digits of noise.
    csvField(r.dt === null ? null : r.dt.toFixed(2)),
    csvField(Math.round(r.offsetHz)),
    csvField(r.dialHz),
    csvField(r.callsign),
    csvField(r.message),
    csvField(r.radio),
  ].join(",");
}

/** `decodes-2026-08-02.csv`, from the decode's own UTC day. */
export function fileNameFor(at: Date): string {
  return `decodes-${at.toISOString().slice(0, 10)}.csv`;
}

export class DecodeCsvLog {
  /** Files known to exist already, so the header is written exactly once each. */
  private readonly started = new Set<string>();
  private lastErrorAt = 0;

  constructor(
    private readonly dir: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Create the directory up front, so a bad path is reported at start rather than
   * silently once per window forever. Throws — the caller decides whether that is
   * fatal. */
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Append a window's worth.
   *
   * Grouped by day before writing: one append per file rather than one per decode,
   * because a busy FT8 window is thirty rows and thirty appends is thirty syscalls for
   * no reason. Split across files only at a day boundary, which happens once a day.
   */
  async append(rows: DecodeRow[]): Promise<void> {
    if (rows.length === 0) return;

    const byFile = new Map<string, string[]>();
    for (const r of rows) {
      const name = fileNameFor(r.at);
      const lines = byFile.get(name);
      if (lines) lines.push(csvLine(r));
      else byFile.set(name, [csvLine(r)]);
    }

    for (const [name, lines] of byFile) {
      const path = join(this.dir, name);
      try {
        // The header goes on only when the file is genuinely new. Checked on disk the
        // first time rather than assumed, so a restart mid-day appends to the existing
        // file instead of putting a header in the middle of it.
        if (!this.started.has(name)) {
          const exists = await stat(path).then(
            (s) => s.size > 0,
            () => false,
          );
          this.started.add(name);
          if (!exists) await appendFile(path, `${HEADER}\n`, "utf8");
        }
        await appendFile(path, `${lines.join("\n")}\n`, "utf8");
      } catch (err) {
        this.report(err);
      }
    }
  }

  /**
   * Complain at most once a minute.
   *
   * A disk that filled up produces one of these per window, which is four an hour on
   * FT8 — enough to see, not enough to bury the log the operator is trying to read.
   */
  private report(err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorAt < 60_000) return;
    this.lastErrorAt = now;
    this.onError(err instanceof Error ? err.message : String(err));
  }
}

// One line per transmission: what the radio said and did between key and unkey.
//
// On 2026-10-25 at 18:38Z the K9XYZ FLEX-6400 went from a clean QSO with K1FRA to keying with
// no forward power, every `xmit 0` going unanswered for 10 s, so each 12.6 s FT8 transmission
// held the radio keyed 27-30 s. Six in a row, a restart that did not help, and auto switched
// itself off. The log had the verdict and nothing else: the interlock's own state changes and
// their `reason=`, the ATU, the radio's `M` messages, the SWR and PA temperature while keyed,
// whether the radio was answering anything else at the time - all of it arrived on the API and
// was dropped. Afterwards the radio was idle and healthy, so none of it could be asked for.
//
// So it is all kept, per transmission, and written as one line when the radio unkeys. Every
// transmission, not only the bad ones: a bad one is only readable next to a good one.

import { dbmToWatts } from "@/lib/radio/power";

/** Kept from before the key: the `xmit 1` and the interlock's PTT_REQUESTED precede it. */
const LEAD_MS = 3_000;
/** A span's notes are capped; a radio stuck keyed must not grow one line without bound. */
const MAX_NOTES = 60;

interface Note {
  at: number;
  text: string;
}

function fmtSecs(ms: number): string {
  return `${ms >= 0 ? "+" : ""}${(ms / 1000).toFixed(2)}s`;
}

export class TxTrace {
  private keyedAt: number | null = null;
  private notes: Note[] = [];
  private dropped = 0;
  private fwdPeakW: number | null = null;
  private fwdReadings = 0;
  private lastPoweredAt: number | null = null;
  private swrMax: number | null = null;
  private paTempMax: number | null = null;
  private refPeakW: number | null = null;
  private pings = 0;
  private pingFails = 0;
  private pingMaxMs = 0;

  /** Something the radio said or did. Outside a span, kept only long enough to lead the next. */
  note(at: number, text: string): void {
    if (this.keyedAt === null) {
      this.notes = this.notes.filter((n) => at - n.at <= LEAD_MS);
      this.notes.push({ at, text });
      return;
    }
    if (this.notes.length >= MAX_NOTES) {
      this.dropped++;
      return;
    }
    this.notes.push({ at, text });
  }

  /** The radio reports it is transmitting. */
  keyed(at: number): void {
    this.notes = this.notes.filter((n) => at - n.at <= LEAD_MS);
    this.keyedAt = at;
    this.dropped = 0;
    this.fwdPeakW = null;
    this.fwdReadings = 0;
    this.lastPoweredAt = null;
    this.swrMax = null;
    this.paTempMax = null;
    this.refPeakW = null;
    this.pings = 0;
    this.pingFails = 0;
    this.pingMaxMs = 0;
  }

  get open(): boolean {
    return this.keyedAt !== null;
  }

  /** Forward power, dBm; null is "no fresh reading". */
  fwd(at: number, dbm: number | null | undefined): void {
    if (this.keyedAt === null || dbm === null || dbm === undefined || !Number.isFinite(dbm)) return;
    const w = dbmToWatts(dbm);
    if (w > 2_000) return;
    this.fwdReadings++;
    if (this.fwdPeakW === null || w > this.fwdPeakW) this.fwdPeakW = w;
    if (w > 0.05) this.lastPoweredAt = at;
  }

  health(t: { swr: number | null; paTempC: number | null; reflectedDbm: number | null }): void {
    if (this.keyedAt === null) return;
    if (t.swr !== null && Number.isFinite(t.swr)) this.swrMax = Math.max(this.swrMax ?? 0, t.swr);
    if (t.paTempC !== null && Number.isFinite(t.paTempC)) this.paTempMax = Math.max(this.paTempMax ?? -100, t.paTempC);
    if (t.reflectedDbm !== null && Number.isFinite(t.reflectedDbm)) {
      const w = dbmToWatts(t.reflectedDbm);
      if (w <= 2_000) this.refPeakW = Math.max(this.refPeakW ?? 0, w);
    }
  }

  /** A round trip on a second connection while keyed: null is no answer. Is the radio answering anything? */
  ping(ms: number | null): void {
    if (this.keyedAt === null) return;
    this.pings++;
    if (ms === null) this.pingFails++;
    else this.pingMaxMs = Math.max(this.pingMaxMs, ms);
  }

  /** The radio reports it has stopped. The line to log, or null if no key was seen. */
  unkeyed(at: number): string | null {
    if (this.keyedAt === null) return null;
    const k = this.keyedAt;
    this.keyedAt = null;
    const w = (x: number) => (x >= 10 ? `${Math.round(x)} W` : `${x.toFixed(1)} W`);
    const parts = [
      `keyed ${new Date(k).toISOString().slice(11, 23)}Z for ${((at - k) / 1000).toFixed(1)}s`,
      this.fwdReadings === 0
        ? "fwd: no readings"
        : `fwd peak ${w(this.fwdPeakW ?? 0)} (${this.fwdReadings} readings` +
          (this.lastPoweredAt !== null ? `, last RF ${fmtSecs(this.lastPoweredAt - k)})` : ", none above 0.05 W)"),
      this.swrMax !== null ? `swr max ${this.swrMax.toFixed(2)}` : "swr: none",
      this.refPeakW !== null ? `refl peak ${w(this.refPeakW)}` : null,
      this.paTempMax !== null ? `pa ${this.paTempMax.toFixed(0)}C` : null,
      this.pings === 0
        ? "api ping: none"
        : `api ping ${this.pings - this.pingFails}/${this.pings} answered, max ${this.pingMaxMs}ms`,
    ].filter(Boolean);
    const events = this.notes.map((n) => `${fmtSecs(n.at - k)} ${n.text}`);
    if (this.dropped > 0) events.push(`(${this.dropped} more not kept)`);
    this.notes = [];
    return `${parts.join(" | ")} || ${events.join("; ") || "no radio events"}`;
  }
}

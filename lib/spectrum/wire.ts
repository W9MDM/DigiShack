// Spectrum frames as they arrive on the bridge socket, into one shape the views share.
//
// The message types are the bridge's own (type-only imports, so nothing server-side reaches
// the bundle): `spectrum` is offsets inside the audio passband, `panadapter` is absolute RF.
// They stay distinct kinds on the wire for the reason lib/radio/panadapter.ts gives; here
// each is resolved to "the low edge of bin 0 and the width of a bin", which is all a
// renderer needs and cannot be misread as the other.
//
// The base64 step is the same atob loop as the private helpers in pages/decodes.tsx,
// pages/rig.tsx, HellPanel and SstvPanel, writing into a reused buffer instead of a new
// array per frame. `decodeBase64Bins` is exported so those copies can share it.

import type { PanadapterMessage } from "@/lib/radio/panadapter";
import type { SpectrumMessage } from "@/lib/radio/spectrum";

export type FeedKind = "audio" | "rf";

/** One decoded frame. The decoder reuses this object and its `bytes`: copy before keeping. */
export interface WireFrame {
  kind: FeedKind;
  /** The first `count` entries are this frame's bins; the buffer may be longer. */
  bytes: Uint8Array;
  count: number;
  lowHz: number;
  binHz: number;
  floorDb: number;
  ceilingDb: number;
  /** False when the bridge sent no floor/ceiling (an older bridge): levels are relative only. */
  calibrated: boolean;
  at: number;
  /** Digital mode the audio row was taken in ("FT8"), and its T/R period. Audio only. */
  mode: string | null;
  periodMs: number | null;
  /** Which radio produced a panadapter row. RF only. */
  radio: string | null;
}

/** base64 -> bytes. */
export function decodeBase64Bins(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** base64 -> bytes written into `out`. Returns the decoded length, or -1 if `out` is too small. */
export function decodeBase64Into(b64: string, out: Uint8Array): number {
  const raw = atob(b64);
  if (raw.length > out.length) return -1;
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return raw.length;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class FrameDecoder {
  private scratch = new Uint8Array(4096);
  private readonly frame: WireFrame = {
    kind: "audio",
    bytes: this.scratch,
    count: 0,
    lowHz: 0,
    binHz: 0,
    floorDb: 0,
    ceilingDb: 0,
    calibrated: true,
    at: 0,
    mode: null,
    periodMs: null,
    radio: null,
  };

  /** Any bridge message: a frame for `spectrum` and `panadapter`, null for everything else. */
  decode(msg: Record<string, unknown>): WireFrame | null {
    if (msg.kind === "spectrum") return this.spectrum(msg as Partial<SpectrumMessage>);
    if (msg.kind === "panadapter") return this.panadapter(msg as Partial<PanadapterMessage>);
    return null;
  }

  spectrum(m: Partial<SpectrumMessage>): WireFrame | null {
    const binHz = num(m.binHz);
    const at = num(m.at);
    if (typeof m.bins !== "string" || binHz === null || binHz <= 0 || at === null) return null;
    const bytes = this.bytes(m.bins);
    if (!bytes) return null;
    const f = this.frame;
    f.kind = "audio";
    f.lowHz = 0;
    f.binHz = binHz;
    f.at = at;
    f.mode = typeof m.mode === "string" && m.mode ? m.mode : null;
    const period = num(m.periodMs);
    f.periodMs = period !== null && period > 0 ? period : null;
    f.radio = null;
    this.levels(num(m.floorDb), num(m.ceilingDb));
    return f;
  }

  panadapter(m: Partial<PanadapterMessage>): WireFrame | null {
    const centerHz = num(m.centerHz);
    const spanHz = num(m.spanHz);
    const at = num(m.at);
    if (typeof m.bins !== "string" || centerHz === null || spanHz === null || spanHz <= 0 || at === null) {
      return null;
    }
    const bytes = this.bytes(m.bins);
    if (!bytes) return null;
    const f = this.frame;
    f.kind = "rf";
    // binHz is on the wire, but span / bins is the definition the panadapter display uses
    // to place bins, and the two agree by construction (lib/radio/panadapter.ts).
    f.binHz = spanHz / f.count;
    f.lowHz = centerHz - spanHz / 2;
    f.at = at;
    f.mode = null;
    f.periodMs = null;
    f.radio = typeof m.radio === "string" && m.radio ? m.radio : null;
    this.levels(num(m.floorDb), num(m.ceilingDb));
    return f;
  }

  private bytes(b64: string): Uint8Array | null {
    let n: number;
    try {
      n = decodeBase64Into(b64, this.scratch);
      if (n < 0) {
        // Bigger than any frame so far: grow once, keep the larger buffer.
        this.scratch = new Uint8Array(Math.ceil((b64.length * 3) / 4) + 4);
        n = decodeBase64Into(b64, this.scratch);
      }
    } catch {
      return null;
    }
    if (n <= 0) return null;
    this.frame.bytes = this.scratch;
    this.frame.count = n;
    return this.scratch;
  }

  private levels(floorDb: number | null, ceilingDb: number | null): void {
    const f = this.frame;
    if (floorDb !== null && ceilingDb !== null && ceilingDb > floorDb) {
      f.floorDb = floorDb;
      f.ceilingDb = ceilingDb;
      f.calibrated = true;
    } else {
      // Bytes as dB above an unknown floor, 40 dB full scale — the audio display's own span.
      f.floorDb = 0;
      f.ceilingDb = 40;
      f.calibrated = false;
    }
  }
}

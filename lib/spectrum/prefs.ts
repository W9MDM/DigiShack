// The Spectrum page's view preferences, as stored in localStorage.
//
// Read back through `sanitizePrefs`, which accepts anything — an older shape, a hand-edited
// value, another tab's half-written JSON — and returns something valid. A preference store
// that can wedge a page into an unusable state is worse than none.

import { DEFAULT_COLORMAP, isColormapId, type ColormapId } from "@/lib/spectrum/colormaps";
import {
  MAX_FLOOR_OFFSET_DB,
  MAX_RANGE_DB,
  MIN_FLOOR_OFFSET_DB,
  MIN_RANGE_DB,
  type Contrast,
} from "@/lib/spectrum/levels";
import type { FeedKind } from "@/lib/spectrum/wire";

export type SpectrumView = "spectrogram" | "3d" | "split";

export const VIEWS: readonly { id: SpectrumView; label: string }[] = [
  { id: "spectrogram", label: "Spectrogram" },
  { id: "3d", label: "3D" },
  { id: "split", label: "Split" },
];

export const HISTORY_CHOICES_SEC = [60, 120, 300, 600, 900] as const;
export const DEPTH_CHOICES_SEC = [15, 30, 60, 120, 300] as const;
export const MIN_HEIGHT_SCALE = 0.2;
export const MAX_HEIGHT_SCALE = 3;

export interface SpectrumPrefs {
  view: SpectrumView;
  source: FeedKind;
  colormap: ColormapId;
  /** Per source: an audio passband and an RF panadapter want very different windows. */
  contrast: Record<FeedKind, Contrast>;
  historySec: number;
  timeLabels: "utc" | "ago";
  heightScale: number;
  depthSec: number;
}

export const DEFAULT_PREFS: SpectrumPrefs = {
  view: "spectrogram",
  source: "audio",
  colormap: DEFAULT_COLORMAP,
  contrast: {
    audio: { floorOffsetDb: 0, rangeDb: null },
    rf: { floorOffsetDb: 0, rangeDb: null },
  },
  historySec: 120,
  timeLabels: "utc",
  heightScale: 1,
  depthSec: 60,
};

export const PREFS_KEY = "digishack.spectrum.prefs.v1";

export function isView(v: unknown): v is SpectrumView {
  return v === "spectrogram" || v === "3d" || v === "split";
}

export function isFeedKind(v: unknown): v is FeedKind {
  return v === "audio" || v === "rf";
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sanitizeContrast(v: unknown, fallback: Contrast): Contrast {
  if (!v || typeof v !== "object") return { ...fallback };
  const o = v as Record<string, unknown>;
  const floor = finite(o.floorOffsetDb);
  const range = o.rangeDb === null ? null : finite(o.rangeDb);
  return {
    floorOffsetDb:
      floor === null ? fallback.floorOffsetDb : Math.max(MIN_FLOOR_OFFSET_DB, Math.min(MAX_FLOOR_OFFSET_DB, floor)),
    rangeDb: range === null ? null : Math.max(MIN_RANGE_DB, Math.min(MAX_RANGE_DB, range)),
  };
}

function nearest(choices: readonly number[], v: number | null, fallback: number): number {
  if (v === null) return fallback;
  return choices.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), choices[0]!);
}

export function sanitizePrefs(raw: unknown): SpectrumPrefs {
  const d = DEFAULT_PREFS;
  if (!raw || typeof raw !== "object") return structuredCloneish(d);
  const o = raw as Record<string, unknown>;
  const contrast = (o.contrast && typeof o.contrast === "object" ? o.contrast : {}) as Record<string, unknown>;
  const height = finite(o.heightScale);
  return {
    view: isView(o.view) ? o.view : d.view,
    source: isFeedKind(o.source) ? o.source : d.source,
    colormap: isColormapId(o.colormap) ? o.colormap : d.colormap,
    contrast: {
      audio: sanitizeContrast(contrast.audio, d.contrast.audio),
      rf: sanitizeContrast(contrast.rf, d.contrast.rf),
    },
    historySec: nearest(HISTORY_CHOICES_SEC, finite(o.historySec), d.historySec),
    timeLabels: o.timeLabels === "ago" ? "ago" : "utc",
    heightScale: height === null ? d.heightScale : Math.max(MIN_HEIGHT_SCALE, Math.min(MAX_HEIGHT_SCALE, height)),
    depthSec: nearest(DEPTH_CHOICES_SEC, finite(o.depthSec), d.depthSec),
  };
}

function structuredCloneish(p: SpectrumPrefs): SpectrumPrefs {
  return { ...p, contrast: { audio: { ...p.contrast.audio }, rf: { ...p.contrast.rf } } };
}

/** Read from storage; any failure (private mode, blocked storage, bad JSON) yields the defaults. */
export function loadPrefs(storage: Pick<Storage, "getItem"> | null | undefined): SpectrumPrefs {
  try {
    const text = storage?.getItem(PREFS_KEY);
    return sanitizePrefs(text ? JSON.parse(text) : null);
  } catch {
    return sanitizePrefs(null);
  }
}

export function savePrefs(storage: Pick<Storage, "setItem"> | null | undefined, prefs: SpectrumPrefs): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or blocked: preferences are a convenience */
  }
}

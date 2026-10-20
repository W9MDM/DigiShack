// Per-device view preferences for the Digital page: decode text size, waterfall height,
// the Debug box, and the phone/desktop switch.
//
// localStorage on purpose: these are one operator's comfort on one screen and must not
// follow an account onto a different monitor. Every access is wrapped, the accessor
// included, because Firefox throws on `getItem` when site data is blocked; a blocked
// store simply means "the default, every time".

import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode, blocked site data, or a full quota */
  }
}

/**
 * True below Tailwind's `lg` (1024px, duplicated here because a breakpoint cannot be read
 * back out of the stylesheet). Only for what CSS cannot do: the waterfall's canvas height
 * is a number, and a <details> has to be forced open on desktop.
 *
 * Starts `false` so the server render and the first client render agree; a phone gets
 * one extra render after mount.
 */
export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023.98px)");
    const apply = () => setCompact(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return compact;
}

/**
 * The decode list's text size, in px. Two reviewers wanted opposite things — 12px
 * monospace was unreadable with age-related vision decline, and a DXer on a 27-inch
 * monitor wanted more rows — so the number belongs to whoever is reading.
 */
const DECODE_SIZE_KEY = "digishack:decode-size:v1";
const DECODE_SIZES = [10, 11, 12, 13, 15, 17, 20] as const;
const DECODE_SIZE_DEFAULT = DECODE_SIZES.indexOf(12);

export interface DecodeSize {
  px: number;
  bigger: () => void;
  smaller: () => void;
  canGrow: boolean;
  canShrink: boolean;
  reset: () => void;
  isDefault: boolean;
}

export function useDecodeSize(): DecodeSize {
  // Starts at the default and applies the stored value in an effect, or hydration mismatches.
  const [i, setI] = useState(DECODE_SIZE_DEFAULT);

  useEffect(() => {
    const n = Number.parseInt(readStored(DECODE_SIZE_KEY) ?? "", 10);
    // Validated against the current list: an index from an older build could run off the end.
    if (Number.isInteger(n) && n >= 0 && n < DECODE_SIZES.length) setI(n);
  }, []);

  const move = (delta: number): void => {
    setI((prev) => {
      const next = Math.min(DECODE_SIZES.length - 1, Math.max(0, prev + delta));
      writeStored(DECODE_SIZE_KEY, String(next));
      return next;
    });
  };

  return {
    px: DECODE_SIZES[i]!,
    bigger: () => move(1),
    smaller: () => move(-1),
    canGrow: i < DECODE_SIZES.length - 1,
    canShrink: i > 0,
    reset: () => {
      writeStored(DECODE_SIZE_KEY, String(DECODE_SIZE_DEFAULT));
      setI(DECODE_SIZE_DEFAULT);
    },
    isDefault: i === DECODE_SIZE_DEFAULT,
  };
}

/**
 * Waterfall height in px, dragged from the handle beneath it. No constant suits both a
 * phone and a 27-inch monitor, so it is stored per device, apart from the defaults.
 */
const WATERFALL_KEY = "digishack:waterfall-height:v1";
const WATERFALL_MIN = 60;
const WATERFALL_MAX = 640;

export interface WaterfallHeight {
  height: number;
  onHandleDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  reset: () => void;
  custom: boolean;
}

export function useWaterfallHeight(compact: boolean): WaterfallHeight {
  const fallback = compact ? 120 : 300;
  const [stored, setStored] = useState<number | null>(null);

  useEffect(() => {
    const n = Number.parseInt(readStored(WATERFALL_KEY) ?? "", 10);
    if (Number.isFinite(n) && n >= WATERFALL_MIN && n <= WATERFALL_MAX) setStored(n);
  }, []);

  const height = stored ?? fallback;

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    // Captured, so a fast drag that leaves the thin handle keeps resizing.
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent): void => {
      setStored(Math.min(WATERFALL_MAX, Math.max(WATERFALL_MIN, startH + (ev.clientY - startY))));
    };
    const up = (ev: PointerEvent): void => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      // Written on release, not per frame: a drag is ~200 events and localStorage is synchronous.
      setStored((h) => {
        if (h !== null) writeStored(WATERFALL_KEY, String(h));
        return h;
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return {
    height,
    onHandleDown,
    reset: () => {
      try {
        window.localStorage.removeItem(WATERFALL_KEY);
      } catch {
        /* nothing to do */
      }
      setStored(null);
    },
    custom: stored !== null,
  };
}

/** An on/off preference kept as "1"/"0". Starts false so the server render matches. */
export function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (readStored(key) === "1") setOn(true);
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      writeStored(key, next ? "1" : "0");
    },
    [key],
  );
  return [on, set];
}

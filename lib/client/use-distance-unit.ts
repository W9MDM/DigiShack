import { useCallback, useEffect, useState } from "react";

import type { DistanceUnit } from "@/lib/propagation";

const KEY = "digishack.distanceUnit";

/**
 * The operator's distance-unit preference — miles (US) or kilometres (metric).
 *
 * Per-device, in localStorage, like the other display preferences: distance is a display
 * choice, not station state, so it does not need to reach the bridge or persist server-side.
 * Starts at "mi" so the server-rendered markup matches, then reads the saved choice on mount;
 * every access is wrapped because a private window or blocked site-data throws.
 */
export function useDistanceUnit(): [DistanceUnit, (u: DistanceUnit) => void] {
  const [unit, setUnit] = useState<DistanceUnit>("mi");
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v === "km" || v === "mi") setUnit(v);
    } catch {
      /* no stored preference */
    }
  }, []);
  const choose = useCallback((u: DistanceUnit) => {
    setUnit(u);
    try {
      localStorage.setItem(KEY, u);
    } catch {
      /* in-memory only this session */
    }
    // So other mounted components (decodes, maps) using this hook update immediately,
    // not only after a reload — localStorage events don't fire in the same document.
    try {
      window.dispatchEvent(new CustomEvent("digishack:distance-unit", { detail: u }));
    } catch {
      /* no window (SSR) */
    }
  }, []);
  useEffect(() => {
    const onChange = (e: Event) => {
      const u = (e as CustomEvent).detail;
      if (u === "km" || u === "mi") setUnit(u);
    };
    window.addEventListener("digishack:distance-unit", onChange);
    return () => window.removeEventListener("digishack:distance-unit", onChange);
  }, []);
  return [unit, choose];
}

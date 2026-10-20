import { useSyncExternalStore } from "react";

import { apiGet } from "@/lib/client/api";
import { GATE_OFFLINE, type StationGate } from "@/lib/radio/station-gate";

// One poll of /api/bridge/gate for the whole page, shared by every header control that
// shows transmit state (FT-0, Arm TX). Polls only while something is subscribed and the
// tab is visible; refresh() after an action so the header answers at once.

const POLL_MS = 4_000;

let current: StationGate | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

function emit(): void {
  for (const l of listeners) l();
}

async function fetchOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      current = await apiGet<StationGate>("/api/bridge/gate");
    } catch {
      // Signed out, or the web tier is restarting: show nothing rather than a stale "armed".
      current = GATE_OFFLINE;
    } finally {
      inFlight = null;
      emit();
    }
  })();
  return inFlight;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  timer = setTimeout(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      schedule();
      return;
    }
    void fetchOnce().finally(schedule);
  }, POLL_MS);
}

function onVisible(): void {
  if (document.visibilityState === "visible" && listeners.size > 0) {
    void fetchOnce().finally(schedule);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisible);
    void fetchOnce().finally(schedule);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/** Re-read now — after arming, disarming or FT-0. */
export async function refreshStationGate(): Promise<void> {
  // A poll already in flight started BEFORE the action, so its answer is stale: wait it out,
  // then ask again.
  if (inFlight) await inFlight.catch(() => {});
  return fetchOnce().finally(schedule);
}

/** Null until the first answer arrives. */
export function useStationGate(): StationGate | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

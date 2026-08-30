import { useEffect, useRef } from "react";

// A timer that stops when nobody is looking.
//
// THE FAULT: there was no `visibilitychange` handler anywhere in the client. Nine intervals
// across six pages kept running with the phone in a pocket — a POTA operator on tethered LTE
// pays a full modem wake-up and TLS round trip for each one, and on flaky signal a FAILED
// fetch is worse, because the radio ramps to full power hunting for a connection it will not
// find. The heaviest offenders:
//
//   pages/pota.tsx          60 s   a network round trip a minute, for ever
//   pages/rig.tsx            2 s   a fetch every two seconds
//   pages/update.tsx         2 s   the same
//   pages/decodes.tsx        1 s   a re-render of the largest component in the app, plus a
//                                  progress bar with a 1 s CSS transition that never idles
//   pages/gridmap.tsx        1 s   the same shape
//   BandConditions.tsx     120 s   mounted in the /decodes header, so it runs while operating
//
// None of them is wrong to exist. All of them are wrong to run against a locked screen.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH: the decode WebSocket. Those frames are the reason
// the page exists and dropping the connection would cost the operator live decodes and a
// reconnect. Throttling what a hidden page RENDERS from that socket is a separate change and
// a larger one; this is the cheap half.

/**
 * Run `fn` every `ms`, but only while the document is visible.
 *
 * `fn` is held in a ref, so a caller may pass a fresh closure every render without
 * restarting the timer — which is the trap that makes most hand-rolled versions of this
 * either stale or a reconnect loop.
 *
 * On becoming visible again the callback fires once immediately by default: a page that has
 * been hidden for ten minutes is showing ten-minute-old numbers, and waiting a further
 * interval before correcting them is the wrong trade. Pass `catchUp: false` where an
 * immediate run would be expensive or surprising.
 */
export function useVisibleInterval(
  fn: () => void,
  ms: number,
  opts: { catchUp?: boolean; enabled?: boolean } = {},
): void {
  const { catchUp = true, enabled = true } = opts;
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!enabled || ms <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => saved.current(), ms);
    };

    const apply = (): void => {
      // `document.hidden` rather than the focus events `useApi` uses: a page can be
      // perfectly visible on a second monitor while unfocused, and stopping a live readout
      // because the operator clicked another window would be a worse bug than the one this
      // fixes.
      if (document.hidden) {
        stop();
        return;
      }
      const wasStopped = timer === null;
      start();
      if (wasStopped && catchUp) saved.current();
    };

    // Start without an immediate call: the caller's own effect has usually just fetched.
    // The catch-up only applies to RETURNING from hidden, which is the stale case.
    if (!document.hidden) start();

    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      stop();
    };
  }, [ms, catchUp, enabled]);
}

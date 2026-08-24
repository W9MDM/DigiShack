import { useEffect, useState } from "react";
import { formatUtcDate, formatUtcTime } from "@/lib/time";

/**
 * UTC clock for the header.
 *
 * Amateur radio runs on UTC — every log entry, every ADIF record, every sked is
 * in it — and the digital modes depend on the clock being right to within a
 * fraction of a second. Having it on screen at all times means a drifting or
 * wrong-zone clock is noticed rather than discovered from a page of failed decodes.
 *
 * Renders nothing on the first client paint deliberately. The server has no idea
 * what time it will be when the markup reaches the browser, so rendering a time
 * during SSR guarantees a hydration mismatch; an empty slot of fixed width avoids
 * both the warning and a layout shift.
 */
export function UtcClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // Align to the second boundary, then tick. A plain 1000 ms interval started at
    // an arbitrary moment shows each second for a random fraction of its life and
    // visibly stutters.
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = setTimeout(tick, 1000 - (d.getTime() % 1000));
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  // Through the shared formatters like everything else, so there is exactly one
  // definition of what a time looks like here.
  const hhmmss = now ? formatUtcTime(now) : "--:--:--";
  const date = now ? formatUtcDate(now) : "";

  return (
    <div
      className="hidden md:flex flex-col items-end leading-none tnum shrink-0"
      // A live region would announce every second, which is intolerable with a
      // screen reader. The time is decorative here; the log carries the
      // authoritative timestamps.
      aria-hidden="true"
      title={now ? `${date} ${hhmmss}` : "UTC"}
    >
      <span className="text-sm text-fg tabular-nums">{hhmmss}</span>
      <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {date ? `${date} UTC` : "UTC"}
      </span>
    </div>
  );
}

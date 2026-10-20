import { useEffect, useId, useState } from "react";

import { Button, Field, Input } from "@/components/ui/primitives";
import { ToolSection } from "@/components/tools/shared";
import {
  browserZone,
  DEFAULT_ZONES,
  isValidZone,
  knownZones,
  utcNow,
  zoneTime,
  type ZoneTime,
} from "@/lib/ham/tools/time";

const ZONES_KEY = "digishack.toolsZones";

function dayNote(z: ZoneTime): string {
  return z.dayShift > 0 ? "tomorrow" : z.dayShift < 0 ? "yesterday" : "";
}

function ZoneRow({ z, onRemove, label }: { z: ZoneTime; onRemove?: () => void; label?: string }) {
  const shift = dayNote(z);
  return (
    <li className="flex items-center gap-3 py-1.5 border-b border-line/50 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg truncate">{label ?? z.place}</p>
        <p className="text-xs text-fg-subtle truncate">
          {z.zone} · {z.offsetLabel}
          {z.abbreviation ? ` · ${z.abbreviation}` : ""}
        </p>
      </div>
      <div className="text-right tnum">
        <p className="text-sm text-fg">{z.time}</p>
        <p className="text-xs text-fg-subtle">{shift ? `${z.date}, ${shift}` : z.date}</p>
      </div>
      {onRemove && (
        <Button size="sm" variant="ghost" aria-label={`Remove ${z.place}`} onClick={onRemove}>
          ✕
        </Button>
      )}
    </li>
  );
}

/**
 * Clocks. Nothing renders until mount: the server cannot know the time the page will be
 * read at, nor the reader's zone, and guessing either is a hydration mismatch.
 */
export function TimeTool() {
  const ids = useId();
  const [now, setNow] = useState<Date | null>(null);
  const [zones, setZones] = useState<string[]>([...DEFAULT_ZONES]);
  const [local, setLocal] = useState<string>("UTC");
  const [all, setAll] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocal(browserZone());
    setAll(knownZones());
    try {
      const saved = JSON.parse(localStorage.getItem(ZONES_KEY) ?? "null") as unknown;
      if (Array.isArray(saved)) setZones(saved.filter((z): z is string => typeof z === "string" && isValidZone(z)));
    } catch {
      /* no saved list */
    }
    // Aligned to the second, as the header clock is, so the seconds do not stutter.
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = setTimeout(tick, 1000 - (d.getTime() % 1000));
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  const save = (next: string[]) => {
    setZones(next);
    try {
      localStorage.setItem(ZONES_KEY, JSON.stringify(next));
    } catch {
      /* this session only */
    }
  };

  const add = () => {
    const z = adding.trim();
    const match = all.find((x) => x.toLowerCase() === z.toLowerCase()) ?? z;
    if (!isValidZone(match)) {
      setError(`"${z}" is not a time zone this browser knows — use a name like Europe/Paris`);
      return;
    }
    if (zones.includes(match)) {
      setError(`${match} is already on the list`);
      return;
    }
    setError(null);
    setAdding("");
    save([...zones, match]);
  };

  const u = now ? utcNow(now) : null;
  const here = now ? zoneTime(now, local) : null;

  return (
    <ToolSection id="time" title="Time">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-fg-subtle">UTC</p>
          <p className="font-display text-3xl text-fg tnum" aria-hidden={!u}>
            {u ? u.time : "--:--:--Z"}
          </p>
        </div>
        <dl className="text-right text-sm tnum">
          <div>
            <dt className="sr-only">Date</dt>
            <dd className="text-fg">{u ? `${u.weekday} ${u.date}` : "—"}</dd>
          </div>
          <div>
            <dt className="sr-only">Day of year</dt>
            <dd className="text-fg-muted">{u ? `Day ${u.dayOfYear} of ${u.daysInYear}` : ""}</dd>
          </div>
        </dl>
      </div>

      <ul className="mt-3">
        {here && <ZoneRow z={here} label={`Here — ${here.place}`} />}
        {now &&
          zones.map((zone) => {
            const z = zoneTime(now, zone);
            return z ? <ZoneRow key={zone} z={z} onRemove={() => save(zones.filter((x) => x !== zone))} /> : null;
          })}
      </ul>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Add a zone" htmlFor={`${ids}-z`} errors={error ? [error] : undefined} className="flex-1 min-w-48">
          <Input
            id={`${ids}-z`}
            list={`${ids}-zones`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="Europe/Paris"
            autoComplete="off"
          />
        </Field>
        <datalist id={`${ids}-zones`}>
          {all.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <Button onClick={add} disabled={!adding.trim()}>
          Add
        </Button>
        <Button variant="ghost" onClick={() => save([...DEFAULT_ZONES])}>
          Reset
        </Button>
      </div>
      <p className="mt-2 text-xs text-fg-subtle">
        The log is always UTC. These clocks are for skeds; the list is kept in this browser.
      </p>
    </ToolSection>
  );
}

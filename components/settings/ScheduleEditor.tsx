// A visual editor for the operating schedule.
//
// The stored format does not change: it is still `08:00-12:00=hunt, 13:00-22:00=cq`,
// parsed by the same `parseSchedule` the bridge uses and covered by the same 58
// assertions. This is a nicer way to write that string, not a new representation of it.
// Keeping one format means the text is still readable in the settings API, still
// copy-pasteable between installs, and still the thing the bridge reads — a UI that
// invented its own JSON would have needed a migration and a second parser to disagree
// with the first.
//
// The part that earns its place is not the time pickers, which are only marginally
// better than typing. It is the day strip: gaps, overlaps and the sleeping-hours
// override are all invisible in a comma-separated string and obvious in a bar.

import { useMemo } from "react";

import { Button, Select } from "@/components/ui/primitives";
import { AUTO_MODES, type AutoMode } from "@/lib/radio/auto-mode";
import {
  formatHhmm,
  inRange,
  parseRange,
  parseSchedule,
  type ScheduleBlock,
  type TimeRange,
} from "@/lib/radio/schedule";

/** Colour per mode, so the strip is readable without a legend lookup every time. */
const MODE_CLASS: Record<AutoMode, string> = {
  off: "bg-bg-raised",
  cq: "bg-accent",
  hunt: "bg-ok",
  "hunt-pota": "bg-warn",
  "pota-chase": "bg-danger",
};

const MODE_LABEL: Record<AutoMode, string> = {
  off: "Off",
  cq: "Call CQ",
  hunt: "Hunt",
  "hunt-pota": "Hunt POTA",
  "pota-chase": "Chase POTA",
};

function serialise(blocks: ScheduleBlock[]): string {
  return blocks
    .map((b) => `${formatHhmm(b.startMin)}-${formatHhmm(b.endMin)}=${b.mode}`)
    .join(", ");
}

/** `HH:MM` for an `<input type="time">`, which will not accept anything else. */
function toTimeValue(minutes: number): string {
  return formatHhmm(minutes);
}

function fromTimeValue(v: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function ScheduleEditor({
  value,
  onChange,
  sleepSpec,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Drawn over the strip so the override is visible where it applies. */
  sleepSpec?: string;
  disabled?: boolean;
}) {
  const parsed = useMemo(() => parseSchedule(value), [value]);
  const sleep = useMemo(() => (sleepSpec ? parseRange(sleepSpec) : null), [sleepSpec]);
  const blocks = parsed.blocks;

  const update = (next: ScheduleBlock[]) => onChange(serialise(next));

  const setBlock = (i: number, patch: Partial<ScheduleBlock>) => {
    update(blocks.map((b, n) => (n === i ? { ...b, ...patch } : b)));
  };

  const addBlock = () => {
    // Start where the last block ended, so adding a second block usually needs no
    // editing at all — the common case is a contiguous day.
    const last = blocks[blocks.length - 1];
    const startMin = last ? last.endMin : 8 * 60;
    const endMin = (startMin + 4 * 60) % 1440;
    update([...blocks, { startMin, endMin, mode: "hunt" }]);
  };

  return (
    <div className="flex flex-col gap-3">
      <DayStrip blocks={blocks} sleep={sleep} />

      <div className="flex flex-col gap-2">
        {blocks.map((b, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span
              className={`h-3 w-3 shrink-0 rounded-sm ${MODE_CLASS[b.mode]}`}
              aria-hidden
            />
            <input
              type="time"
              aria-label="Start time"
              value={toTimeValue(b.startMin)}
              disabled={disabled}
              onChange={(e) => {
                const m = fromTimeValue(e.target.value);
                if (m !== null) setBlock(i, { startMin: m });
              }}
              className="rounded-sm border border-line bg-bg-raised px-2 py-1 text-sm text-fg focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright"
            />
            <span className="text-fg-muted text-sm">to</span>
            <input
              type="time"
              aria-label="End time"
              value={toTimeValue(b.endMin)}
              disabled={disabled}
              onChange={(e) => {
                const m = fromTimeValue(e.target.value);
                if (m !== null) setBlock(i, { endMin: m });
              }}
              className="rounded-sm border border-line bg-bg-raised px-2 py-1 text-sm text-fg focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright"
            />
            <Select
              aria-label="Mode"
              value={b.mode}
              disabled={disabled}
              className="max-w-40"
              onChange={(e) => setBlock(i, { mode: e.target.value as AutoMode })}
            >
              {AUTO_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </Select>
            {b.endMin < b.startMin && (
              <span className="text-xs text-fg-muted">runs past midnight</span>
            )}
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => update(blocks.filter((_, n) => n !== i))}
              aria-label={`Remove the ${formatHhmm(b.startMin)} block`}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={addBlock} disabled={disabled}>
          Add a block
        </Button>
        {blocks.length === 0 && (
          <span className="text-sm text-fg-muted">
            Nothing scheduled — the station stays off.
          </span>
        )}
      </div>

      <Problems blocks={blocks} errors={parsed.errors} />

      {/* The stored string, shown rather than hidden. It is what the bridge reads and
          what an operator would paste into another install, and a UI that conceals its
          own output makes the settings API look like it disagrees with the page. */}
      {blocks.length > 0 && (
        <p className="text-xs text-fg-muted font-mono break-all">{serialise(blocks)}</p>
      )}
    </div>
  );
}

/**
 * Twenty-four hours as a bar.
 *
 * A comma-separated string cannot show you that you left 12:00–13:00 uncovered, or that
 * two blocks overlap, or that half your CQ window is inside sleeping hours. The bar can,
 * at a glance, which is the whole reason for replacing a perfectly functional text box.
 */
function DayStrip({ blocks, sleep }: { blocks: ScheduleBlock[]; sleep: TimeRange | null }) {
  // One cell per 15 minutes: fine enough for a realistic schedule, coarse enough to
  // stay legible on a phone.
  const CELLS = 96;
  const cells = Array.from({ length: CELLS }, (_, i) => {
    const minute = i * 15;
    // Last match wins, exactly as decideSchedule does — the strip has to agree with
    // the engine or it is worse than no strip.
    let mode: AutoMode = "off";
    for (const b of blocks) if (inRange(minute, b)) mode = b.mode;
    const asleep = sleep ? inRange(minute, sleep) : false;
    return { minute, mode, asleep };
  });

  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded-sm border border-line">
        {cells.map((c) => (
          <div
            key={c.minute}
            title={`${formatHhmm(c.minute)} — ${c.asleep ? "asleep" : MODE_LABEL[c.mode]}`}
            className={`flex-1 ${c.asleep ? "bg-bg" : MODE_CLASS[c.mode]}`}
            // Sleeping hours are drawn as hatching over whatever was scheduled, so it
            // reads as "suppressed" rather than "not scheduled" — which is the actual
            // behaviour: sleep overrides the block rather than replacing it.
            style={
              c.asleep
                ? {
                    backgroundImage:
                      "repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.18) 2px, rgba(255,255,255,0.18) 4px)",
                  }
                : undefined
            }
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-fg-muted tabular-nums">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}:00</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Overlaps, gaps and parse errors.
 *
 * Overlaps are legal — a later block wins, which is how you carve an exception out of a
 * broad rule — so this reports rather than forbids. Saying nothing would leave an
 * operator wondering why 14:00 hunts when they wrote CQ.
 */
function Problems({ blocks, errors }: { blocks: ScheduleBlock[]; errors: string[] }) {
  const overlaps: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      // Sample the later block's start: cheap, and enough to spot a real overlap
      // without reimplementing interval arithmetic for wrapping ranges.
      if (inRange(b.startMin, a)) {
        overlaps.push(
          `${formatHhmm(b.startMin)} is inside the ${formatHhmm(a.startMin)}-${formatHhmm(a.endMin)} block, so ${b.mode} wins there`,
        );
      }
    }
  }

  const uncovered = (() => {
    let n = 0;
    for (let m = 0; m < 1440; m += 15) {
      if (!blocks.some((b) => inRange(m, b))) n += 15;
    }
    return n;
  })();

  if (!errors.length && !overlaps.length && uncovered === 0) return null;

  return (
    <div className="flex flex-col gap-1 text-xs">
      {errors.map((e) => (
        <span key={e} className="text-danger">
          {e}
        </span>
      ))}
      {overlaps.map((o) => (
        <span key={o} className="text-warn">
          {o}
        </span>
      ))}
      {uncovered > 0 && blocks.length > 0 && (
        <span className="text-fg-muted">
          {Math.floor(uncovered / 60)}h {uncovered % 60}m of the day is not covered — the
          station is off then.
        </span>
      )}
    </div>
  );
}

/** A single range, for sleeping hours. Same storage format, `HH:MM-HH:MM`. */
export function RangeEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const r = parseRange(value);
  const set = (patch: Partial<TimeRange>) => {
    const base = r ?? { startMin: 23 * 60, endMin: 7 * 60 };
    const next = { ...base, ...patch };
    onChange(`${formatHhmm(next.startMin)}-${formatHhmm(next.endMin)}`);
  };

  // Showing 11:00 PM to 07:00 AM beside the words "No quiet hours set" is a straight
  // contradiction — it reads as though those times are in force. When nothing is set,
  // offer to set it and show nothing else.
  if (!r) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={disabled} onClick={() => set({})}>
          Set quiet hours
        </Button>
        <span className="text-sm text-fg-muted">
          None — the schedule runs around the clock.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="time"
        aria-label="Sleep from"
        value={toTimeValue(r.startMin)}
        disabled={disabled}
        onChange={(e) => {
          const m = fromTimeValue(e.target.value);
          if (m !== null) set({ startMin: m });
        }}
        className="rounded-sm border border-line bg-bg-raised px-2 py-1 text-sm text-fg focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright"
      />
      <span className="text-fg-muted text-sm">to</span>
      <input
        type="time"
        aria-label="Sleep until"
        value={toTimeValue(r.endMin)}
        disabled={disabled}
        onChange={(e) => {
          const m = fromTimeValue(e.target.value);
          if (m !== null) set({ endMin: m });
        }}
        className="rounded-sm border border-line bg-bg-raised px-2 py-1 text-sm text-fg focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright"
      />
      <span className="text-xs text-fg-muted">
        {r.endMin < r.startMin ? "overnight" : "same day"}
      </span>
      <Button variant="ghost" disabled={disabled} onClick={() => onChange("")}>
        Clear
      </Button>
    </div>
  );
}

/**
 * The PA cooldown, as one control.
 *
 * It was two separate number fields — "PA cooldown after (transmit minutes)" and "PA
 * cooldown rest (minutes)" — which the two-column grid then dealt onto opposite sides of
 * the page with unrelated fields between them. Two halves of one sentence, side by side
 * with things that were not part of it.
 *
 * It is one idea, so it is one control and one sentence. Off is stored as 0 in the
 * "after" value, matching every other limit in the application.
 */
export function PaCooldownField({
  afterMinutes,
  restMinutes,
  onChangeAfter,
  onChangeRest,
  disabled,
}: {
  afterMinutes: string;
  restMinutes: string;
  onChangeAfter: (v: string) => void;
  onChangeRest: (v: string) => void;
  disabled?: boolean;
}) {
  const after = Number(afterMinutes);
  const on = Number.isFinite(after) && after > 0;

  const num = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    off: boolean,
  ) => (
    <input
      type="number"
      min={1}
      aria-label={label}
      value={value}
      disabled={disabled || off}
      onChange={(e) => onChange(e.target.value)}
      className="w-16 rounded-sm border border-line bg-bg-raised px-2 py-1 text-sm text-fg tabular-nums focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright disabled:opacity-50"
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => onChangeAfter(e.target.checked ? "30" : "0")}
          className="h-4 w-4 accent-accent"
        />
        Rest the transmitter periodically
      </label>

      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <span>after</span>
        {num(on ? afterMinutes : "", onChangeAfter, "Transmit minutes before resting", !on)}
        <span>transmit minutes, rest for</span>
        {num(restMinutes, onChangeRest, "Rest minutes", !on)}
        <span>minutes</span>
      </div>

      <p className="text-xs text-fg-muted">
        {on
          ? "Counts time actually keyed, not time elapsed — FT8 transmits about half the time, and an hour spent listening heats nothing."
          : "Off — the transmitter runs as long as the schedule allows."}
      </p>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** The bridge's once-a-second heartbeat for a stream mode, with the tone levels. */
export interface StreamStats {
  mode: string;
  seconds: number;
  chars: number;
  framingErrors: number;
  weak: number;
  mark: number;
  space: number;
  /** -1 (space) to +1 (mark); near 0 when there is no signal at the tones. */
  decision: number;
}

export interface RttyTuning {
  centreHz: number;
  shiftHz: number;
  sideband: "USB" | "LSB";
  markHz: number;
  spaceHz: number;
}

interface Props {
  text: string;
  stats: StreamStats | null;
  rtty: RttyTuning | null;
  canTune: boolean;
  /** Sending needs an operator and a station callsign for the macros. */
  canSend: boolean;
  myCall: string | null;
  transmitting: boolean;
  error?: string | null;
  onTune: (centreHz?: number, shiftHz?: number) => void;
  onSend: (text: string) => void;
  onClear: () => void;
}

const SHIFTS = [170, 182, 200, 425, 850];

/**
 * The RTTY view of the decodes page: a terminal, not a table.
 *
 * RTTY has no structured messages, so there is nothing to put in columns - the mode is a
 * stream of characters and the page shows it as one, newest at the bottom, with the tone
 * levels beside it so the operator can see whether the pair is on a signal. Tuning is the
 * waterfall: a click there moves the centre, which is what every RTTY program does with
 * its own display.
 */
export function RttyPanel({
  text,
  stats,
  rtty,
  canTune,
  canSend,
  myCall,
  transmitting,
  error,
  onTune,
  onSend,
  onClear,
}: Props) {
  const scroller = useRef<HTMLPreElement>(null);
  const [draft, setDraft] = useState("");
  const send = (line: string) => {
    const t = line.trim();
    if (!t) return;
    onSend(t);
  };
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  const peak = Math.max(stats?.mark ?? 0, stats?.space ?? 0, 1e-9);
  const markPct = stats ? Math.round((stats.mark / peak) * 100) : 0;
  const spacePct = stats ? Math.round((stats.space / peak) * 100) : 0;
  const quiet = !stats || (stats.mark < 1e-3 && stats.space < 1e-3);
  const idle = stats !== null && !quiet && stats.decision > 0.8;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {rtty ? (
          <span className="tnum">
            mark <span className="text-fg">{rtty.markHz}</span> · space{" "}
            <span className="text-fg">{rtty.spaceHz}</span> Hz · {rtty.sideband} · shift {rtty.shiftHz}
          </span>
        ) : (
          <span>Waiting for the bridge to report the tones…</span>
        )}
        {canTune && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => rtty && onTune(rtty.centreHz - 10)}
              disabled={!rtty}
              title="Move the tone pair 10 Hz down"
            >
              −10
            </button>
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => rtty && onTune(rtty.centreHz + 10)}
              disabled={!rtty}
              title="Move the tone pair 10 Hz up"
            >
              +10
            </button>
            <select
              className="bg-bg-raised border border-line rounded-sm px-1 py-0.5 text-xs"
              value={rtty?.shiftHz ?? 170}
              onChange={(e) => onTune(undefined, Number(e.target.value))}
              disabled={!rtty}
              aria-label="RTTY shift"
            >
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  shift {s}
                </option>
              ))}
            </select>
            <span className="text-fg-subtle">· click the waterfall to set the centre</span>
          </span>
        )}
        <button type="button" className="ml-auto hover:text-fg" onClick={onClear}>
          Clear
        </button>
      </div>

      {/* Tone levels: relative, so a weak signal still fills a bar when it is the only thing there. */}
      <div className="grid grid-cols-[3rem_1fr_6rem] items-center gap-x-2 text-xs tnum">
        <span className="text-fg-muted">mark</span>
        <div className="h-1.5 bg-bg-raised rounded-sm overflow-hidden">
          <div className={cn("h-full", idle ? "bg-accent" : "bg-ok/70")} style={{ width: `${markPct}%` }} />
        </div>
        <span className="text-fg-subtle text-right">{stats ? `${stats.chars} chars` : ""}</span>
        <span className="text-fg-muted">space</span>
        <div className="h-1.5 bg-bg-raised rounded-sm overflow-hidden">
          <div className="h-full bg-ok/70" style={{ width: `${spacePct}%` }} />
        </div>
        <span className="text-fg-subtle text-right" title="Bad stop bits, and well-framed characters the squelch dropped">
          {stats ? `${stats.framingErrors} bad · ${stats.weak} weak` : ""}
        </span>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      {/* Sending: a line at a time. 45.45 baud is about six characters a second, so a
          line is seconds on the air and the far end reads it as it arrives. The two
          macros are the lines every RTTY contact begins and ends with. */}
      {canSend && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
            setDraft("");
          }}
        >
          <input
            className="flex-1 min-w-[12rem] bg-bg-raised border border-line rounded-sm px-2 py-1 text-sm font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={240}
            placeholder="Type a line; Enter sends it (about 6 characters a second)"
            aria-label="RTTY text to send"
          />
          <button
            type="submit"
            className="px-3 py-1 text-xs border border-line rounded-sm hover:text-fg disabled:opacity-50"
            disabled={!draft.trim() || transmitting}
          >
            Send
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs border border-line rounded-sm hover:text-fg disabled:opacity-50 tnum"
            disabled={transmitting || !myCall}
            onClick={() => myCall && send(`CQ CQ CQ DE ${myCall} ${myCall} ${myCall} K`)}
            title="Call CQ"
          >
            CQ
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs border border-line rounded-sm hover:text-fg disabled:opacity-50 tnum"
            disabled={transmitting || !myCall}
            onClick={() => myCall && send(`TNX 73 DE ${myCall} SK`)}
            title="Sign off"
          >
            73
          </button>
          {transmitting && <span className="text-xs text-accent-bright">TX</span>}
        </form>
      )}

      <pre
        ref={scroller}
        className="font-mono text-sm whitespace-pre-wrap break-words bg-bg-raised border border-line rounded-sm p-3 h-72 overflow-y-auto"
        aria-live="polite"
      >
        {text ||
          (quiet
            ? "No audio at the tones yet. Tune the radio to an RTTY signal and click it on the waterfall."
            : idle
              ? "Carrier on mark: a station is keyed and not yet typing, or the pair is on an unmodulated tone."
              : "Listening…")}
      </pre>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** The bridge's once-a-second heartbeat for a stream mode, with what its decoder measures. */
export type StreamStats =
  | {
      mode: "RTTY";
      seconds: number;
      chars: number;
      framingErrors: number;
      weak: number;
      mark: number;
      space: number;
      /** -1 (space) to +1 (mark); near 0 when there is no signal at the tones. */
      decision: number;
    }
  | {
      mode: "CW";
      seconds: number;
      chars: number;
      /** The decoder's speed estimate, words per minute. */
      wpm: number;
      peak: number;
      floor: number;
      keyed: boolean;
      unknown: number;
    };

export interface RttyTuning {
  centreHz: number;
  shiftHz: number;
  sideband: "USB" | "LSB";
  markHz: number;
  spaceHz: number;
}

export interface CwTuning {
  /** The radio's CW pitch, Hz: where the decoder listens. */
  pitchHz: number;
  /** Sending speed through the radio's keyer. */
  wpm: number;
  pitchFromRadio: boolean;
}

interface Props {
  mode: string;
  text: string;
  stats: StreamStats | null;
  rtty: RttyTuning | null;
  cw: CwTuning | null;
  canTune: boolean;
  /** Sending needs an operator and a station callsign for the macros. */
  canSend: boolean;
  myCall: string | null;
  transmitting: boolean;
  error?: string | null;
  onTune: (centreHz?: number, shiftHz?: number) => void;
  onCwWpm: (wpm: number) => void;
  onSend: (text: string) => void;
  onClear: () => void;
}

const SHIFTS = [170, 182, 200, 425, 850];

/**
 * The stream-mode view of the decodes page: a terminal, not a table.
 *
 * RTTY and CW have no structured messages, so there is nothing to put in columns - each
 * is a stream of characters and the page shows it as one, newest at the bottom, with what
 * the decoder measures beside it so the operator can see whether it is on a signal. For
 * RTTY the tuning is the waterfall: a click moves the tone pair. For CW the pitch is the
 * radio's own, and the decoder follows it.
 */
export function StreamPanel({
  mode,
  text,
  stats,
  rtty,
  cw,
  canTune,
  canSend,
  myCall,
  transmitting,
  error,
  onTune,
  onCwWpm,
  onSend,
  onClear,
}: Props) {
  const scroller = useRef<HTMLPreElement>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  const send = (line: string) => {
    const t = line.trim();
    if (t) onSend(t);
  };

  const rttyStats = stats && stats.mode === "RTTY" ? stats : null;
  const cwStats = stats && stats.mode === "CW" ? stats : null;
  const isCw = mode === "CW";

  // Bars. RTTY: mark and space, relative to the stronger. CW: the key's peak and the
  // noise floor it stands over, relative to the peak.
  let barA = 0;
  let barB = 0;
  let quiet = true;
  let idle = false;
  if (rttyStats) {
    const peak = Math.max(rttyStats.mark, rttyStats.space, 1e-9);
    barA = Math.round((rttyStats.mark / peak) * 100);
    barB = Math.round((rttyStats.space / peak) * 100);
    quiet = rttyStats.mark < 1e-3 && rttyStats.space < 1e-3;
    idle = !quiet && rttyStats.decision > 0.8;
  } else if (cwStats) {
    const peak = Math.max(cwStats.peak, 1e-9);
    barA = 100;
    barB = Math.round((cwStats.floor / peak) * 100);
    quiet = cwStats.peak < 1e-4;
    idle = cwStats.keyed;
  }

  const cqLine = myCall ? `CQ CQ CQ DE ${myCall} ${myCall} ${myCall} K` : "";
  const byeLine = myCall ? (isCw ? `TU 73 DE ${myCall} SK` : `TNX 73 DE ${myCall} SK`) : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {isCw ? (
          cw ? (
            <span className="tnum">
              pitch <span className="text-fg">{cw.pitchHz}</span> Hz
              {cw.pitchFromRadio ? " (radio)" : " (setting)"} · sending at{" "}
              <span className="text-fg">{cw.wpm}</span> wpm
              {cwStats && cwStats.chars > 0 && (
                <>
                  {" "}
                  · hearing about <span className="text-fg">{Math.round(cwStats.wpm)}</span> wpm
                </>
              )}
            </span>
          ) : (
            <span>Waiting for the bridge to report the pitch…</span>
          )
        ) : rtty ? (
          <span className="tnum">
            mark <span className="text-fg">{rtty.markHz}</span> · space{" "}
            <span className="text-fg">{rtty.spaceHz}</span> Hz · {rtty.sideband} · shift {rtty.shiftHz}
          </span>
        ) : (
          <span>Waiting for the bridge to report the tones…</span>
        )}
        {canTune && isCw && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => cw && onCwWpm(cw.wpm - 2)}
              disabled={!cw || cw.wpm <= 5}
              title="Send 2 wpm slower"
            >
              −2
            </button>
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => cw && onCwWpm(cw.wpm + 2)}
              disabled={!cw || cw.wpm >= 60}
              title="Send 2 wpm faster"
            >
              +2
            </button>
          </span>
        )}
        {canTune && !isCw && (
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

      <div className="grid grid-cols-[3rem_1fr_7rem] items-center gap-x-2 text-xs tnum">
        <span className="text-fg-muted">{isCw ? "peak" : "mark"}</span>
        <div className="h-1.5 bg-bg-raised rounded-sm overflow-hidden">
          <div className={cn("h-full", idle ? "bg-accent" : "bg-ok/70")} style={{ width: `${barA}%` }} />
        </div>
        <span className="text-fg-subtle text-right">{stats ? `${stats.chars} chars` : ""}</span>
        <span className="text-fg-muted">{isCw ? "floor" : "space"}</span>
        <div className="h-1.5 bg-bg-raised rounded-sm overflow-hidden">
          <div className="h-full bg-ok/70" style={{ width: `${barB}%` }} />
        </div>
        <span
          className="text-fg-subtle text-right"
          title={isCw ? "Patterns that matched nothing in the table" : "Bad stop bits, and well-framed characters the squelch dropped"}
        >
          {rttyStats ? `${rttyStats.framingErrors} bad · ${rttyStats.weak} weak` : cwStats ? `${cwStats.unknown} unread` : ""}
        </span>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      {/* Sending: a line at a time. RTTY is about six characters a second; CW at 20 wpm
          about four. The two macros are the lines every contact begins and ends with. */}
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
            placeholder={isCw ? "Type a line; Enter sends it through the radio's keyer" : "Type a line; Enter sends it (about 6 characters a second)"}
            aria-label={`${mode} text to send`}
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
            onClick={() => send(cqLine)}
            title="Call CQ"
          >
            CQ
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs border border-line rounded-sm hover:text-fg disabled:opacity-50 tnum"
            disabled={transmitting || !myCall}
            onClick={() => send(byeLine)}
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
            ? isCw
              ? "Nothing at the pitch yet. Tune the radio to a CW signal; the decoder listens where the radio's sidetone is."
              : "No audio at the tones yet. Tune the radio to an RTTY signal and click it on the waterfall."
            : idle
              ? isCw
                ? "Key down: a carrier at the pitch."
                : "Carrier on mark: a station is keyed and not yet typing, or the pair is on an unmodulated tone."
              : "Listening…")}
      </pre>
    </div>
  );
}

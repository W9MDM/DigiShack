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
    }
  | {
      mode: "PSK31";
      seconds: number;
      chars: number;
      errors: number;
      /** 0 to 1: how consistently the symbols read as 0 or pi; the squelch is a floor on it. */
      quality: number;
      afcHz: number;
      level: number;
      open: boolean;
    }
  | {
      mode: "OLIVIA";
      seconds: number;
      chars: number;
      blocks: number;
      /** The synchroniser's signal over noise; the threshold is a floor on it. */
      snr: number;
      freqOffsetHz: number;
      open: boolean;
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

export interface PskTuning {
  /** The carrier, Hz audio: where the decoder listens and the transmitter sends. */
  centreHz: number;
  speed: 31 | 63 | 125;
}

export interface OliviaTuning {
  /** Centre of the tone set, Hz audio. */
  centreHz: number;
  tones: number;
  bandwidth: number;
  /** Olivia, or Contestia on the same engine. */
  code?: "olivia" | "contestia";
}

/** The sizes the picker offers, as the bridge accepts them. */
export const OLIVIA_SIZES: readonly { tones: number; bandwidth: number }[] = [
  { tones: 8, bandwidth: 250 },
  { tones: 8, bandwidth: 500 },
  { tones: 16, bandwidth: 500 },
  { tones: 32, bandwidth: 1000 },
  { tones: 16, bandwidth: 1000 },
  { tones: 64, bandwidth: 2000 },
];

interface Props {
  mode: string;
  text: string;
  stats: StreamStats | null;
  rtty: RttyTuning | null;
  cw: CwTuning | null;
  psk: PskTuning | null;
  olivia: OliviaTuning | null;
  canTune: boolean;
  /** Sending needs an operator and a station callsign for the macros. */
  canSend: boolean;
  myCall: string | null;
  transmitting: boolean;
  error?: string | null;
  onTune: (centreHz?: number, shiftHz?: number) => void;
  onCwWpm: (wpm: number) => void;
  onPskTune: (centreHz?: number, speed?: 31 | 63 | 125) => void;
  onOliviaTune: (centreHz?: number, size?: { tones: number; bandwidth: number }, code?: "olivia" | "contestia") => void;
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
  psk,
  olivia,
  canTune,
  canSend,
  myCall,
  transmitting,
  error,
  onTune,
  onCwWpm,
  onPskTune,
  onOliviaTune,
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
  const pskStats = stats && stats.mode === "PSK31" ? stats : null;
  const oliviaStats = stats && stats.mode === "OLIVIA" ? stats : null;
  const isCw = mode === "CW";
  const isPsk = mode === "PSK31";
  const isOlivia = mode === "OLIVIA";

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
  } else if (pskStats) {
    // PSK: the quality (the squelch's measure) and the level at the carrier.
    barA = Math.round(Math.min(1, pskStats.quality) * 100);
    barB = Math.round(Math.min(1, pskStats.level * 4) * 100);
    quiet = pskStats.level < 1e-3;
    idle = pskStats.open;
  } else if (oliviaStats) {
    // Olivia: the synchroniser's signal over noise (noise alone reads about 3), and whether it is printing.
    barA = Math.round(Math.min(1, oliviaStats.snr / 20) * 100);
    barB = oliviaStats.open ? 100 : 0;
    quiet = oliviaStats.snr < 1;
    idle = oliviaStats.open;
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
        ) : isOlivia ? (
          olivia ? (
            <span className="tnum">
              centre <span className="text-fg">{olivia.centreHz}</span> Hz · {olivia.code === "contestia" ? "Contestia" : "Olivia"} {olivia.bandwidth}/{olivia.tones}
              {oliviaStats && oliviaStats.snr > 0 && (
                <>
                  {" "}
                  · S/N <span className="text-fg">{oliviaStats.snr.toFixed(1)}</span>
                  {Math.abs(oliviaStats.freqOffsetHz) >= 8 && (
                    <>
                      {" "}
                      · {oliviaStats.snr >= 4 ? "found" : "best guess"}{" "}
                      <span className="text-fg">{oliviaStats.freqOffsetHz > 0 ? "+" : ""}{Math.round(oliviaStats.freqOffsetHz)}</span> Hz off
                    </>
                  )}
                </>
              )}
            </span>
          ) : (
            <span>Waiting for the bridge to report the centre…</span>
          )
        ) : isPsk ? (
          psk ? (
            <span className="tnum">
              carrier <span className="text-fg">{psk.centreHz}</span> Hz · BPSK{psk.speed}
              {pskStats && Math.abs(pskStats.afcHz) >= 0.5 && (
                <>
                  {" "}
                  · AFC <span className="text-fg">{pskStats.afcHz > 0 ? "+" : ""}{pskStats.afcHz.toFixed(1)}</span> Hz
                </>
              )}
            </span>
          ) : (
            <span>Waiting for the bridge to report the carrier…</span>
          )
        ) : rtty ? (
          <span className="tnum">
            mark <span className="text-fg">{rtty.markHz}</span> · space{" "}
            <span className="text-fg">{rtty.spaceHz}</span> Hz · {rtty.sideband} · shift {rtty.shiftHz}
          </span>
        ) : (
          <span>Waiting for the bridge to report the tones…</span>
        )}
        {canTune && isOlivia && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => olivia && onOliviaTune(olivia.centreHz - 10)}
              disabled={!olivia}
              title="Move the tone set 10 Hz down"
            >
              −10
            </button>
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => olivia && onOliviaTune(olivia.centreHz + 10)}
              disabled={!olivia}
              title="Move the tone set 10 Hz up"
            >
              +10
            </button>
            <select
              className="bg-bg-raised border border-line rounded-sm px-1 py-0.5 text-xs"
              value={olivia ? `${olivia.bandwidth}/${olivia.tones}` : "500/16"}
              onChange={(e) => {
                const [bw, t] = e.target.value.split("/").map(Number);
                if (bw && t) onOliviaTune(undefined, { tones: t, bandwidth: bw });
              }}
              disabled={!olivia}
              aria-label="Olivia size"
            >
              {OLIVIA_SIZES.map((s) => (
                <option key={`${s.bandwidth}/${s.tones}`} value={`${s.bandwidth}/${s.tones}`}>
                  {s.bandwidth}/{s.tones}
                </option>
              ))}
            </select>
            <select
              className="bg-bg-raised border border-line rounded-sm px-1 py-0.5 text-xs"
              value={olivia?.code ?? "olivia"}
              onChange={(e) => onOliviaTune(undefined, undefined, e.target.value === "contestia" ? "contestia" : "olivia")}
              disabled={!olivia}
              aria-label="Olivia or Contestia"
            >
              <option value="olivia">Olivia</option>
              <option value="contestia">Contestia</option>
            </select>
            <span className="text-fg-subtle">· click the waterfall to set the centre</span>
          </span>
        )}
        {canTune && isPsk && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => psk && onPskTune(psk.centreHz - 10)}
              disabled={!psk}
              title="Move the carrier 10 Hz down"
            >
              −10
            </button>
            <button
              type="button"
              className="px-2 py-0.5 border border-line rounded-sm hover:text-fg tnum"
              onClick={() => psk && onPskTune(psk.centreHz + 10)}
              disabled={!psk}
              title="Move the carrier 10 Hz up"
            >
              +10
            </button>
            <select
              className="bg-bg-raised border border-line rounded-sm px-1 py-0.5 text-xs"
              value={psk?.speed ?? 31}
              onChange={(e) => onPskTune(undefined, Number(e.target.value) as 31 | 63 | 125)}
              disabled={!psk}
              aria-label="PSK speed"
            >
              <option value={31}>BPSK31</option>
              <option value={63}>BPSK63</option>
              <option value={125}>BPSK125</option>
            </select>
            <span className="text-fg-subtle">· click the waterfall to set the carrier</span>
          </span>
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
        {canTune && !isCw && !isPsk && !isOlivia && (
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
        <span className="text-fg-muted">{isCw ? "peak" : isPsk ? "quality" : isOlivia ? "S/N" : "mark"}</span>
        <div className="h-1.5 bg-bg-raised rounded-sm overflow-hidden">
          <div className={cn("h-full", idle ? "bg-accent" : "bg-ok/70")} style={{ width: `${barA}%` }} />
        </div>
        <span className="text-fg-subtle text-right">{stats ? `${stats.chars} chars` : ""}</span>
        <span className="text-fg-muted">{isCw ? "floor" : isPsk ? "level" : isOlivia ? "sync" : "space"}</span>
        <div className="h-1.5 bg-bg-raised rounded-sm overflow-hidden">
          <div className="h-full bg-ok/70" style={{ width: `${barB}%` }} />
        </div>
        <span
          className="text-fg-subtle text-right"
          title={
            isCw
              ? "Patterns that matched nothing in the table"
              : isPsk
                ? "Varicodes no character has"
                : isOlivia
                  ? "Blocks printed"
                  : "Bad stop bits, and well-framed characters the squelch dropped"
          }
        >
          {rttyStats
            ? `${rttyStats.framingErrors} bad · ${rttyStats.weak} weak`
            : cwStats
              ? `${cwStats.unknown} unread`
              : pskStats
                ? `${pskStats.errors} unread`
                : oliviaStats
                  ? `${oliviaStats.blocks} blocks`
                  : ""}
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
            placeholder={
              isCw
                ? "Type a line; Enter sends it through the radio's keyer"
                : isPsk
                  ? "Type a line; Enter sends it (about 5 characters a second at BPSK31)"
                  : isOlivia
                    ? "Type a line; Enter sends it (about 2 characters a second at 500/16)"
                    : "Type a line; Enter sends it (about 6 characters a second)"
            }
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
              : isPsk
                ? "No signal at the carrier yet. Tune the radio to a PSK31 signal and click it on the waterfall."
                : isOlivia
                  ? "No Olivia block has synced yet. Click the signal's centre on the waterfall; a block takes two seconds, and the first prints a few blocks later."
                  : "No audio at the tones yet. Tune the radio to an RTTY signal and click it on the waterfall."
            : idle
              ? isCw
                ? "Key down: a carrier at the pitch."
                : isPsk
                  ? "A PSK signal at the carrier: idle, or not yet typing."
                  : isOlivia
                    ? "Synced on an Olivia signal: idle blocks, or not yet typing."
                    : "Carrier on mark: a station is keyed and not yet typing, or the pair is on an unmodulated tone."
              : "Listening…")}
      </pre>
    </div>
  );
}

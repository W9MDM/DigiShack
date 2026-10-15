// The JS8 panel on the decodes page: the messages joined from their frames, and a line to
// send. A line is a heartbeat (`@HB HEARTBEAT`), a CQ, a directed message (`KK4COV SNR?`)
// or text; the bridge turns it into frames and sends one per fifteen-second window from
// the next boundary, at the offset chosen here or picked on the waterfall. The panel shows
// which frame is out and when the next window is, and can stop a message after the frame
// on the air.

import { useState } from "react";

/** What the bridge reports about a message going out, from `status.js8`. */
export interface Js8SendState {
  sending: boolean;
  text: string | null;
  frames: number;
  sent: number;
  /** The boundary of the next frame's window, UTC ms. */
  nextWindow: number | null;
  /** Why the last message stopped short, or null. */
  stopped: string | null;
  offsetHz: number;
}

export type Js8Speed = "normal" | "fast" | "turbo" | "slow";

interface Props {
  speed: Js8Speed;
  onSpeed: (s: Js8Speed) => void;
  /** Messages joined from their frames, one line each, with [TX] lines for what went out. */
  text: string;
  myCall: string | null;
  myGrid: string | null;
  offsetHz: number;
  onOffsetHz: (hz: number) => void;
  state: Js8SendState | null;
  transmitting: boolean;
  canSend: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClear: () => void;
}

const hhmmss = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)}Z`;

const BUTTON = "px-2 py-1 text-xs border border-line rounded-sm hover:text-fg disabled:opacity-50";

const SPEEDS: { id: Js8Speed; label: string }[] = [
  { id: "normal", label: "Normal 15 s" },
  { id: "fast", label: "Fast 10 s" },
  { id: "turbo", label: "Turbo 6 s" },
  { id: "slow", label: "Slow 30 s" },
];

export function Js8Panel({
  speed,
  onSpeed,
  text,
  myCall,
  myGrid,
  offsetHz,
  onOffsetHz,
  state,
  transmitting,
  canSend,
  error,
  onSend,
  onCancel,
  onClear,
}: Props) {
  const [draft, setDraft] = useState("");
  const sending = state?.sending ?? false;
  const send = (line: string) => {
    const t = line.trim();
    if (t) onSend(t);
  };
  const frameNow = state ? Math.min(state.sent + 1, state.frames) : 0;

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-xs text-fg-muted mb-1">
        <span className="flex items-center gap-2">
          Messages, joined from their frames
          <select
            className="bg-bg-raised border border-line rounded-sm px-1 py-0.5 text-xs"
            value={speed}
            onChange={(e) => onSpeed(e.target.value as Js8Speed)}
            disabled={!canSend || sending}
            aria-label="JS8 speed"
            title="Both ends must use the same speed; most stations run Normal"
          >
            {SPEEDS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </span>
        <button type="button" className="hover:text-fg" onClick={onClear}>
          Clear
        </button>
      </div>
      <pre className="font-mono text-sm whitespace-pre-wrap break-words bg-bg-raised border border-line rounded-sm p-3 max-h-56 overflow-y-auto">
        {text || "No complete message yet. Frames appear below as they decode; a message prints here when its last frame arrives."}
      </pre>

      {canSend && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
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
            placeholder={myGrid ? "A line: KK4COV SNR?, or text. One window per frame; Enter sends." : "A line to send; Enter sends it"}
            aria-label="JS8 text to send"
            disabled={sending}
          />
          <label className="flex items-center gap-1 text-xs text-fg-muted">
            <span>at</span>
            <input
              type="number"
              className="w-20 bg-bg-raised border border-line rounded-sm px-2 py-1 text-sm font-mono tnum"
              value={offsetHz}
              min={200}
              max={2800}
              step={10}
              onChange={(e) => onOffsetHz(Number(e.target.value))}
              aria-label="JS8 audio offset, Hz"
              disabled={sending}
            />
            <span>Hz</span>
          </label>
          <button type="submit" className={`px-3 py-1 ${BUTTON}`} disabled={!draft.trim() || sending || !myCall}>
            Send
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={sending || !myCall}
            onClick={() => send("@HB HEARTBEAT")}
            title="A heartbeat: your callsign and grid, one frame"
          >
            HB
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={sending || !myCall}
            onClick={() => send("CQ CQ CQ")}
            title="CQ CQ CQ with your grid, one frame"
          >
            CQ
          </button>
          {sending && (
            <button type="button" className={BUTTON} onClick={onCancel} title="Stop after the frame on the air">
              Cancel
            </button>
          )}
        </form>
      )}
      {canSend && !myCall && <p className="mt-1 text-xs text-fg-muted">Set your callsign in Settings to send: every frame names its sender.</p>}
      {state && (sending || state.stopped) && (
        <p className="mt-1 text-xs text-fg-muted tnum">
          {sending
            ? `Sending "${state.text}": frame ${frameNow} of ${state.frames}` +
              (state.nextWindow ? `, window ${hhmmss(state.nextWindow)}` : "") +
              (transmitting ? " · on the air" : "")
            : `Stopped: ${state.stopped}`}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-accent-bright">{error}</p>}
    </div>
  );
}

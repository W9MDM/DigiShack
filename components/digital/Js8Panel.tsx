// The JS8 panel on the decodes page: the messages joined from their frames, and a line to
// send. A line is a heartbeat (`@HB HEARTBEAT`), a CQ, a directed message (`KK4COV SNR?`)
// or text; the bridge turns it into frames and sends one per fifteen-second window from
// the next boundary, at the offset chosen here or picked on the waterfall. The panel shows
// which frame is out and when the next window is, and can stop a message after the frame
// on the air.

import { useEffect, useRef, useState } from "react";

import { NativeSelect } from "@/components/decodes/controls";
import { Button, Input } from "@/components/ui/primitives";

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
  /**
   * A station picked from the decode list: the line starts with its callsign, ready for a
   * command or text. `n` changes on every pick, so picking the same station twice still
   * fills the line.
   */
  prefill?: { call: string; n: number } | null;
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

const SPEEDS: { id: Js8Speed; label: string }[] = [
  { id: "normal", label: "Normal 15 s" },
  { id: "fast", label: "Fast 10 s" },
  { id: "turbo", label: "Turbo 6 s" },
  { id: "slow", label: "Slow 30 s" },
];

export function Js8Panel({
  prefill,
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
  const input = useRef<HTMLInputElement>(null);
  const sending = state?.sending ?? false;
  useEffect(() => {
    if (!prefill) return;
    setDraft(`${prefill.call} `);
    input.current?.focus();
  }, [prefill]);
  const send = (line: string) => {
    const t = line.trim();
    if (t) onSend(t);
  };
  const frameNow = state ? Math.min(state.sent + 1, state.frames) : 0;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted mb-1">
        <span className="flex items-center gap-2">
          Messages, joined from their frames
          <NativeSelect
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
          </NativeSelect>
        </span>
        <Button size="sm" variant="ghost" onClick={onClear} title="Clear the joined messages">
          Clear
        </Button>
      </div>
      <pre className="font-mono text-sm whitespace-pre-wrap break-words bg-surface-2 border border-line rounded-sm p-3 max-h-56 overflow-y-auto">
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
          {/* Raw, not the Input primitive: the prefill focuses it through a ref, which Input does not forward. */}
          <input
            ref={input}
            className="flex-1 min-w-48 bg-surface-2 border border-line-strong rounded-sm px-2.5 py-1 text-sm font-mono text-fg placeholder:text-fg-subtle focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright disabled:opacity-50"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={240}
            placeholder={myGrid ? "A line: KK4COV SNR?, or text. One window per frame; Enter sends." : "A line to send; Enter sends it"}
            aria-label="JS8 text to send"
            disabled={sending}
          />
          <label className="flex items-center gap-1 text-xs text-fg-muted">
            <span>at</span>
            <Input
              type="number"
              className="w-20 py-1 font-mono tnum"
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
          <Button type="submit" size="sm" disabled={!draft.trim() || sending || !myCall}>
            Send
          </Button>
          <Button
            size="sm"
            disabled={sending || !myCall}
            onClick={() => send("@HB HEARTBEAT")}
            title="A heartbeat: your callsign and grid, one frame"
          >
            HB
          </Button>
          {/* The usual first things to say to a station picked from the list. */}
          {draft.trim() && /^[A-Z0-9/]+$/i.test(draft.trim()) &&
            [" SNR?", " GRID?", " INFO?", " HELLO"].map((c) => (
              <Button
                key={c}
                size="sm"
                disabled={sending || !myCall}
                onClick={() => {
                  send(`${draft.trim()}${c}`);
                  setDraft("");
                }}
                title={`Send ${draft.trim()}${c}`}
              >
                {c.trim()}
              </Button>
            ))}
          <Button
            size="sm"
            disabled={sending || !myCall}
            onClick={() => send("CQ CQ CQ")}
            title="CQ CQ CQ with your grid, one frame"
          >
            CQ
          </Button>
          {sending && (
            <Button size="sm" variant="danger" onClick={onCancel} title="Stop after the frame on the air">
              Cancel
            </Button>
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
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

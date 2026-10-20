// The Feld Hell panel on the decodes page: the page as it is painted, column by column,
// the carrier's controls, and a line to send.
//
// Nothing here is decoded. The bridge sends painted columns over the socket (kind
// "hell-cols", 28 bytes a column, bottom row first, 0 paper to 255 ink), and this draws
// them: left to right along a line, a new line under it when one fills, the oldest
// scrolling off the top. Each column is drawn twice, one copy above the other, as Hell
// receivers always have - the receiver's clock is not the sender's, so a character can
// start part way up a column, and between the two copies there is always a whole one.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Nudge } from "@/components/decodes/controls";
import { Badge, Button, Input } from "@/components/ui/primitives";

export interface HellStats {
  mode: "HELL";
  seconds: number;
  columns: number;
  levelDb: number;
  signal: boolean;
}

export type HellMessage = { kind: "hell-cols"; rows: number; data: string } | { kind: "hell-backlog"; rows: number; data: string };

export interface HellPanelHandle {
  receive: (msg: HellMessage) => void;
}

/** Columns along a line: twelve seconds, thirty characters. */
const LINE_COLS = 210;
/** Lines on the page. */
const LINES = 6;
/** Canvas pixels across per column: a 5x7 glyph comes out about as wide as it is tall. */
const COL_PX = 3;
/** Paper between lines. */
const GAP_PX = 4;

function decodeBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const HellPanel = forwardRef<
  HellPanelHandle,
  {
    stats: HellStats | null;
    hell: { centreHz: number } | null;
    /** The [TX] lines, from the stream text. */
    text: string;
    canTune: boolean;
    canSend: boolean;
    myCall: string | null;
    transmitting: boolean;
    error?: string | null;
    onTune: (centreHz: number) => void;
    onSend: (text: string) => void;
    onClear: () => void;
  }
>(function HellPanel({ stats, hell, text, canTune, canSend, myCall, transmitting, error, onTune, onSend, onClear }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef({ col: 0, line: 0, rows: 28 });
  const [draft, setDraft] = useState("");
  const [painted, setPainted] = useState(false);

  const lineHeight = (rows: number) => rows * 2 + GAP_PX;

  const clear = useCallback(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const rows = cursor.current.rows;
    c.width = LINE_COLS * COL_PX;
    c.height = LINES * lineHeight(rows);
    g.fillStyle = "#000";
    g.fillRect(0, 0, c.width, c.height);
    cursor.current = { col: 0, line: 0, rows };
    setPainted(false);
  }, []);

  useEffect(() => clear(), [clear]);

  const paint = useCallback(
    (rows: number, data: Uint8Array) => {
      const c = canvas.current;
      const g = c?.getContext("2d");
      if (!c || !g) return;
      if (rows !== cursor.current.rows) {
        cursor.current.rows = rows;
        clear();
      }
      const lh = lineHeight(rows);
      const img = g.createImageData(COL_PX, rows * 2);
      for (let off = 0; off + rows <= data.length; off += rows) {
        const cur = cursor.current;
        if (cur.col >= LINE_COLS) {
          cur.col = 0;
          if (cur.line < LINES - 1) cur.line++;
          else {
            // The page is full: everything up a line, a clean line at the bottom.
            g.drawImage(c, 0, -lh);
            g.fillStyle = "#000";
            g.fillRect(0, (LINES - 1) * lh, c.width, lh);
          }
        }
        // The column, bottom row at the bottom, twice over.
        for (let r = 0; r < rows; r++) {
          const v = data[off + r]!;
          for (const copy of [0, 1]) {
            const y = copy * rows + (rows - 1 - r);
            for (let x = 0; x < COL_PX; x++) {
              const i = (y * COL_PX + x) * 4;
              img.data[i] = v;
              img.data[i + 1] = v;
              img.data[i + 2] = Math.round(v * 0.9);
              img.data[i + 3] = 255;
            }
          }
        }
        g.putImageData(img, cur.col * COL_PX, cur.line * lh);
        cur.col++;
      }
      setPainted(true);
    },
    [clear],
  );

  useImperativeHandle(
    ref,
    () => ({
      receive: (msg: HellMessage) => {
        if (msg.kind === "hell-backlog") clear();
        paint(msg.rows, decodeBase64(msg.data));
      },
    }),
    [clear, paint],
  );

  const send = (line: string) => {
    const t = line.trim();
    if (t) onSend(t);
  };
  const cqLine = myCall ? `CQ CQ CQ DE ${myCall} ${myCall} ${myCall} K` : "";
  const byeLine = myCall ? `TNX 73 DE ${myCall} SK` : "";
  const txLines = text
    .split("\n")
    .filter((l) => l.startsWith("[TX"))
    .slice(-4);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {hell ? (
          <span className="tnum">
            carrier <span className="text-fg">{hell.centreHz}</span> Hz · Feld Hell
            {stats && (
              <>
                {" "}
                · level <span className="text-fg">{stats.levelDb.toFixed(0)}</span> dB ·{" "}
                <span className={stats.signal ? "text-accent-bright" : ""}>{stats.signal ? "signal" : "no signal"}</span>
              </>
            )}
          </span>
        ) : (
          <span>Waiting for the bridge to report the carrier…</span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          title="Clear the page"
          onClick={() => {
            clear();
            onClear();
          }}
        >
          Clear
        </Button>
      </div>
      {canTune && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Nudge
            step={10}
            disabled={!hell}
            onStep={(d) => hell && onTune(hell.centreHz + d)}
            downTitle="Move the carrier 10 Hz down"
            upTitle="Move the carrier 10 Hz up"
          />
          <span className="text-fg-subtle">or click the signal on the waterfall to centre it</span>
        </div>
      )}

      <div className="relative bg-bg border border-line rounded-sm overflow-hidden">
        <canvas
          ref={canvas}
          className="block w-full"
          style={{ imageRendering: "pixelated" }}
          aria-label="The Hell page as it is painted: each line of text drawn twice, one copy above the other"
        />
        {!painted && (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-fg-subtle">
            Nothing painted yet. Tune to a Feld Hell signal and click it on the waterfall: text appears here as it is sent, twice over.
          </p>
        )}
      </div>
      <p className="text-xs text-fg-subtle">
        Read whichever copy is whole. Lines that slope mean the two stations' clocks differ; the text still reads.
      </p>

      {error && <p className="text-xs text-danger">{error}</p>}

      {canSend && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
            setDraft("");
          }}
        >
          <Input
            className="flex-1 min-w-48 w-auto py-1 font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={96}
            placeholder="Type a line; Enter sends it (2.5 characters a second, sent in capitals)"
            aria-label="Hell text to send"
          />
          <Button type="submit" size="sm" disabled={!draft.trim() || transmitting}>
            Send
          </Button>
          <Button size="sm" className="tnum" disabled={transmitting || !myCall} onClick={() => send(cqLine)} title="Call CQ">
            CQ
          </Button>
          <Button size="sm" className="tnum" disabled={transmitting || !myCall} onClick={() => send(byeLine)} title="Sign off">
            73
          </Button>
          {transmitting && (
            <Badge tone="danger" size="sm">
              TX
            </Badge>
          )}
        </form>
      )}
      {txLines.length > 0 && <pre className="font-mono text-xs whitespace-pre-wrap break-words text-fg-muted">{txLines.join("\n")}</pre>}
    </div>
  );
});

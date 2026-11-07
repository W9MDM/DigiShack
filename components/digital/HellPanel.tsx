// The Hell panel on the decodes page: the page as it is painted, column by column, which
// Hell mode, the carrier's controls, where Hell is on the air, and a line to send.
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
import { HELL_VARIANTS, hellVariant, type HellVariant } from "@/lib/digital/hell";
import { HELL_CALLING, HELL_NETS, nextNetStart, type HellSpot } from "@/lib/ham/hell-nets";
import { decodeBase64Bins } from "@/lib/spectrum/wire";
import { useNightMode } from "@/lib/client/use-theme";

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

/**
 * Ink colour for a column value (0 paper .. 255 ink). By day a warm white, as it always was;
 * at night amber on black — red and green only — so the page does not light up the room.
 * The red channel is the ink value in both, which is what lets recolourHell swap a painted
 * page from one to the other without the column data.
 */
export function hellInk(v: number, night: boolean): [number, number, number] {
  return night ? [v, Math.round(v * 0.45), 0] : [v, v, Math.round(v * 0.9)];
}

function recolourHell(c: HTMLCanvasElement, night: boolean): void {
  const g = c.getContext("2d");
  if (!g || c.width === 0 || c.height === 0) return;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, gg, b] = hellInk(d[i]!, night);
    d[i] = r;
    d[i + 1] = gg;
    d[i + 2] = b;
  }
  g.putImageData(img, 0, 0);
}

export const HellPanel = forwardRef<
  HellPanelHandle,
  {
    stats: HellStats | null;
    hell: { centreHz: number; variant?: HellVariant } | null;
    /** The band the radio is on, to pick out that band's frequencies. */
    band: string | null;
    /** The [TX] lines, from the stream text. */
    text: string;
    canTune: boolean;
    canSend: boolean;
    myCall: string | null;
    transmitting: boolean;
    error?: string | null;
    onTune: (centreHz: number, variant?: HellVariant) => void;
    /** Put the radio on a frequency or net: the dial a carrier below it, in its mode. */
    onTuneSpot: (spot: HellSpot) => void;
    onSend: (text: string) => void;
    onClear: () => void;
  }
>(function HellPanel({ stats, hell, band, text, canTune, canSend, myCall, transmitting, error, onTune, onTuneSpot, onSend, onClear }, ref) {
  const mode = hellVariant(hell?.variant);
  const cps = mode.columnRate / 7;
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef({ col: 0, line: 0, rows: 28 });
  const [draft, setDraft] = useState("");
  const [painted, setPainted] = useState(false);
  const night = useNightMode();
  const nightRef = useRef(night);
  // A theme change re-inks what is already on the page.
  useEffect(() => {
    if (nightRef.current === night) return;
    nightRef.current = night;
    if (canvas.current) recolourHell(canvas.current, night);
  }, [night]);

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
          const [ir, ig, ib] = hellInk(data[off + r]!, nightRef.current);
          for (const copy of [0, 1]) {
            const y = copy * rows + (rows - 1 - r);
            for (let x = 0; x < COL_PX; x++) {
              const i = (y * COL_PX + x) * 4;
              img.data[i] = ir;
              img.data[i + 1] = ig;
              img.data[i + 2] = ib;
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
        paint(msg.rows, decodeBase64Bins(msg.data));
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
            carrier <span className="text-fg">{hell.centreHz}</span> Hz · {mode.label}
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
          <label className="flex items-center gap-1 text-fg-muted">
            Mode
            <select
              className="rounded-sm border border-line bg-bg px-1 py-0.5 text-fg"
              value={mode.id}
              disabled={!hell}
              onChange={(e) => hell && onTune(hell.centreHz, e.target.value as HellVariant)}
            >
              {HELL_VARIANTS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
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
            Nothing painted yet. Tune to a {mode.label} signal and click it on the waterfall: text appears here as it is sent, twice over.
          </p>
        )}
      </div>
      <p className="text-xs text-fg-subtle">
        Read whichever copy is whole. Lines that slope mean the two stations' clocks differ; the text still reads.
      </p>
      {canTune && <HellWhere band={band} onTuneSpot={onTuneSpot} />}

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
            placeholder={`Type a line; Enter sends it (${cps < 1 ? cps.toFixed(2) : cps.toFixed(1)} characters a second, sent in capitals)`}
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

/**
 * Where Hell is on the air in North America: the weekly nets, soonest first, with when they
 * next meet in local time and UTC, and Feld Hell's calling frequencies. Tune puts the radio
 * on one in its mode. See lib/ham/hell-nets.ts for the sources.
 */
function HellWhere({ band, onTuneSpot }: { band: string | null; onTuneSpot: (spot: HellSpot) => void }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nets = now === null ? [] : HELL_NETS.map((n) => ({ n, at: nextNetStart(n, now) })).sort((a, b) => a.at - b.at);
  const mhz = (hz: number) => (hz / 1e6).toFixed(4).replace(/0$/, "");
  const when = (at: number) => {
    const d = new Date(at);
    const local = d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    const utc = `${d.toUTCString().slice(0, 3)} ${d.toISOString().slice(11, 16)}Z`;
    const mins = Math.round((at - (now ?? at)) / 60_000);
    const soon = mins <= 0 ? " · on now" : mins < 120 ? ` · in ${mins} min` : "";
    return `${local} (${utc})${soon}`;
  };
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-fg-muted">Where Hell is: North American nets and calling frequencies</summary>
      <div className="mt-2 flex flex-col gap-1">
        {nets.map(({ n, at }) => (
          <div key={n.label} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" onClick={() => onTuneSpot(n)}>
              Tune
            </Button>
            <span className="tnum text-fg">{mhz(n.hz)} MHz</span>
            <span className="text-fg-muted">
              {n.label} · {hellVariant(n.variant).label} · {n.coordinator} · next {when(at)}
              {n.altHz ? ` · ${mhz(n.altHz)} if busy` : ""}
            </span>
          </div>
        ))}
        <div className="mt-1 flex flex-wrap items-center gap-1 text-fg-muted">
          Feld Hell calling:
          {HELL_CALLING.map((c) => (
            <Button key={c.hz} size="sm" variant={c.band === band ? "primary" : "ghost"} title={c.label} onClick={() => onTuneSpot(c)}>
              {c.band.toLowerCase()} {mhz(c.hz)}
            </Button>
          ))}
        </div>
        <p className="text-fg-subtle">
          The nets run FM Hell-105, so Tune switches the mode too. Times are the nets' own, in Eastern time, shown in yours.
        </p>
      </div>
    </details>
  );
}

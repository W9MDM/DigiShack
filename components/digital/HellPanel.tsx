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

/** `tx` marks what we sent: on a live message, all of it; on the backlog, a byte a column. */
export type HellMessage =
  | { kind: "hell-cols"; rows: number; data: string; tx?: boolean }
  | { kind: "hell-backlog"; rows: number; data: string; tx?: string };

export interface HellPanelHandle {
  receive: (msg: HellMessage) => void;
}

/**
 * Columns along a line, by the Size picker. Fewer columns a line means each is wider on the
 * screen, so the letters grow: 210 is twelve seconds of Feld Hell, thirty characters.
 */
const LINE_COLS_BY_SIZE = { S: 210, M: 150, L: 105 } as const;
type HellSize = keyof typeof LINE_COLS_BY_SIZE;
/** Lines on the page. */
const LINES = 6;
/**
 * Canvas pixels across per column. A glyph is 5 columns by 24 painted rows, so 5 makes it
 * about square. It was 3, and on another station's page the letters read as a picket fence.
 */
const COL_PX = 5;

/** Per-viewer preferences, kept in this browser. */
const PREFS_KEY = "digishack.hellPage";
/** Paper between lines. */
const GAP_PX = 4;

/**
 * Ink colour for a column value (0 paper .. 255 ink). By day a warm white, as it always was;
 * at night amber on black — red and green only — so the page does not light up the room.
 */
export function hellInk(v: number, night: boolean): [number, number, number] {
  return night ? [v, Math.round(v * 0.45), 0] : [v, v, Math.round(v * 0.9)];
}

/**
 * What we sent, painted in red-orange among what we received, so the tape reads as the
 * conversation. The same by day and at night: red keeps a dark room dark.
 */
export function hellTxInk(v: number): [number, number, number] {
  return [v, Math.round(v * 0.18), Math.round(v * 0.08)];
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
  const [size, setSize] = useState<HellSize>("M");
  /** 0..100: how much of the faint end is pushed down to paper. */
  const [contrast, setContrast] = useState(30);
  const lineCols = useRef<number>(LINE_COLS_BY_SIZE.M);
  const floor = useRef(0.18);
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as { size?: HellSize; contrast?: number } | null;
      if (p?.size && p.size in LINE_COLS_BY_SIZE) setSize(p.size);
      if (typeof p?.contrast === "number") setContrast(Math.max(0, Math.min(100, p.contrast)));
    } catch {
      /* no saved preferences */
    }
  }, []);
  useEffect(() => {
    floor.current = (contrast / 100) * 0.6;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ size, contrast }));
    } catch {
      /* this session only */
    }
  }, [size, contrast]);
  const cps = mode.columnRate / 7;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState("");
  const [painted, setPainted] = useState(false);
  const night = useNightMode();
  const nightRef = useRef(night);

  // THE TAPE. The page is one strip of paper wrapped into LINES lines: a new column goes in
  // at the bottom right and everything before it slides left, the start of each line
  // wrapping up onto the end of the one above. Text never jumps to a new line; it moves
  // through the page as tape moves through a printer. MikeShack does this, and against it
  // the old page - written left to right, a line at a time - read as a stutter.
  //
  // So the page keeps the COLUMNS, not pixels, and is redrawn from them: which is also why
  // contrast and the day and night inks apply to the whole page at once.
  const tape = useRef<{ rows: number; cols: Uint8Array[]; tx: boolean[] }>({ rows: 28, cols: [], tx: [] });
  const frame = useRef<number | null>(null);

  const lineHeight = (rows: number) => rows * 2 + GAP_PX;

  const redraw = useCallback(() => {
    frame.current = null;
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const { rows, cols, tx } = tape.current;
    const per = lineCols.current;
    const lh = lineHeight(rows);
    const w = per * COL_PX;
    const h = LINES * lh;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const img = g.createImageData(w, h);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    const k = floor.current;
    const nightNow = nightRef.current;
    // The newest column sits at the very end of the last line; column j back from it is
    // j places to the left, wrapping up a line at the left edge.
    const shown = Math.min(cols.length, per * LINES);
    for (let j = 0; j < shown; j++) {
      const idx = cols.length - 1 - j;
      const col = cols[idx]!;
      const sent = tx[idx]!;
      const slot = per * LINES - 1 - j;
      const line = Math.floor(slot / per);
      const x0 = (slot % per) * COL_PX;
      const y0 = line * lh;
      for (let r = 0; r < rows; r++) {
        // Contrast: the faint end, mostly noise, goes to paper and the rest is stretched
        // back to full. What we sent is clean and drawn as it is.
        const raw = col[r]!;
        const v = sent ? raw : Math.round(Math.max(0, Math.min(1, (raw / 255 - k) / (1 - k))) * 255);
        if (v === 0) continue;
        const [ir, ig, ib] = sent ? hellTxInk(v) : hellInk(v, nightNow);
        // Bottom row at the bottom, twice over, one copy above the other.
        for (const copy of [0, 1]) {
          const y = y0 + copy * rows + (rows - 1 - r);
          let i = (y * w + x0) * 4;
          for (let x = 0; x < COL_PX; x++, i += 4) {
            d[i] = ir;
            d[i + 1] = ig;
            d[i + 2] = ib;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
  }, []);

  /** At most once a frame: columns arrive in handfuls several times a second. */
  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(redraw);
  }, [redraw]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const clear = useCallback(() => {
    tape.current = { rows: tape.current.rows, cols: [], tx: [] };
    setPainted(false);
    schedule();
  }, [schedule]);

  useEffect(() => clear(), [clear]);
  // A new size is a new width of paper; the tape is kept and simply rewraps.
  useEffect(() => {
    lineCols.current = LINE_COLS_BY_SIZE[size];
    schedule();
  }, [size, schedule]);
  // Contrast and the theme redraw what is already there.
  useEffect(() => {
    nightRef.current = night;
    schedule();
  }, [night, contrast, schedule]);

  const paint = useCallback(
    (rows: number, data: Uint8Array, tx: (column: number) => boolean = () => false) => {
      const t = tape.current;
      if (rows !== t.rows) tape.current = { rows, cols: [], tx: [] };
      const keep = LINE_COLS_BY_SIZE.S * LINES;
      for (let off = 0, c = 0; off + rows <= data.length; off += rows, c++) {
        tape.current.cols.push(data.slice(off, off + rows));
        tape.current.tx.push(tx(c));
      }
      const extra = tape.current.cols.length - keep;
      if (extra > 0) {
        tape.current.cols.splice(0, extra);
        tape.current.tx.splice(0, extra);
      }
      setPainted(true);
      schedule();
    },
    [schedule],
  );

  useImperativeHandle(
    ref,
    () => ({
      receive: (msg: HellMessage) => {
        if (msg.kind === "hell-backlog") {
          clear();
          const flags = msg.tx ? decodeBase64Bins(msg.tx) : null;
          paint(msg.rows, decodeBase64Bins(msg.data), (c) => flags?.[c] === 1);
        } else {
          paint(msg.rows, decodeBase64Bins(msg.data), () => msg.tx === true);
        }
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span className="flex items-center gap-1">
          Size
          {(Object.keys(LINE_COLS_BY_SIZE) as HellSize[]).map((z) => (
            <Button key={z} size="sm" variant={size === z ? "primary" : "ghost"} onClick={() => setSize(z)} title={`${LINE_COLS_BY_SIZE[z]} columns a line`}>
              {z}
            </Button>
          ))}
        </span>
        <label className="flex items-center gap-2">
          Contrast
          <input type="range" min={0} max={100} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} aria-label="Contrast: how much faint noise is drawn as paper" />
        </label>
        <span className="text-fg-subtle">The page scrolls like tape: the newest column is at the bottom right.</span>
      </div>
      <p className="text-xs text-fg-subtle">
        Read whichever copy is whole. Lines that slope mean the two stations' clocks differ; the text still reads. What you send is painted in red as it goes out.
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

// The SSTV panel on the decodes page: the picture coming in, drawn row by row as the bridge
// decodes it, and the pictures already received. The bridge names the mode from the VIS
// header and sends rows over the socket (kind "sstv-rows"); finished pictures are saved as
// PNG and listed by /api/sstv.

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";

import { useApi } from "@/lib/client/api";
import { SstvSend, type SstvTxState } from "@/components/digital/SstvSend";

export interface SstvStats {
  mode: "SSTV";
  seconds: number;
  receiving: string | null;
  rows: number;
  pictures: number;
  visHeard: number;
}

/** What the page's socket handler hands the panel. */
export type SstvMessage =
  | { kind: "sstv-vis"; code: number; name: string; decoded: boolean; at: number }
  | { kind: "sstv-start"; mode: string; width: number; height: number; at: number }
  | { kind: "sstv-rows"; from: number; to: number; width: number; rgb: string }
  | { kind: "sstv-image"; file: string; mode: string; at: number };

export interface SstvPanelHandle {
  receive: (msg: SstvMessage) => void;
}

interface Picture {
  file: string;
  mode: string;
  at: string;
}

function decodeBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const time = (iso: string) => `${iso.slice(11, 16)}Z`;

export const SstvPanel = forwardRef<
  SstvPanelHandle,
  { stats: SstvStats | null; myCall: string | null; canSend: boolean; tx: SstvTxState | null }
>(function SstvPanel({ stats, myCall, canSend, tx }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState<{ mode: string; width: number; height: number; rows: number } | null>(null);
  const [picked, setPicked] = useState<Picture | null>(null);
  /** The last header heard, so one that cannot be drawn still says what it was. */
  const [lastVis, setLastVis] = useState<{ name: string; decoded: boolean; at: number } | null>(null);
  const { data, reload } = useApi<{ pictures: Picture[]; total: number }>("/api/sstv?limit=48");

  const receive = useCallback(
    (msg: SstvMessage) => {
      if (msg.kind === "sstv-vis") {
        setLastVis({ name: msg.name, decoded: msg.decoded, at: msg.at });
        return;
      }
      if (msg.kind === "sstv-start") {
        setPicked(null);
        setLive({ mode: msg.mode, width: msg.width, height: msg.height, rows: 0 });
        const c = canvas.current;
        if (c) {
          c.width = msg.width;
          c.height = msg.height;
          const g = c.getContext("2d");
          if (g) {
            g.fillStyle = "#000";
            g.fillRect(0, 0, msg.width, msg.height);
          }
        }
        return;
      }
      if (msg.kind === "sstv-rows") {
        const c = canvas.current;
        const g = c?.getContext("2d");
        if (c && g && c.width === msg.width) {
          const rgb = decodeBase64(msg.rgb);
          const rows = msg.to - msg.from;
          const img = g.createImageData(msg.width, rows);
          for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
            img.data[j] = rgb[i]!;
            img.data[j + 1] = rgb[i + 1]!;
            img.data[j + 2] = rgb[i + 2]!;
            img.data[j + 3] = 255;
          }
          g.putImageData(img, 0, msg.from);
        }
        setLive((l) => (l ? { ...l, rows: msg.to } : l));
        return;
      }
      setLive(null);
      void reload();
    },
    [reload],
  );
  useImperativeHandle(ref, () => ({ receive }), [receive]);

  // A picture finished while the page was elsewhere still shows up: refresh now and then.
  useEffect(() => {
    const id = setInterval(() => void reload(), 60_000);
    return () => clearInterval(id);
  }, [reload]);

  const pictures = data?.pictures ?? [];
  const showing = picked ?? (live ? null : pictures[0] ?? null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted tnum">
        {live ? (
          <span className="text-accent-bright">
            Receiving {live.mode} · row {live.rows} of {live.height}
          </span>
        ) : stats?.receiving ? (
          <span className="text-accent-bright">Receiving {stats.receiving} · row {stats.rows}</span>
        ) : (
          <span>Waiting for a picture: the decoder starts on the VIS header that opens one.</span>
        )}
        {stats && (
          <span>
            {stats.pictures} received this session · {stats.visHeard} headers heard
          </span>
        )}
        {lastVis && !lastVis.decoded && (
          <span>
            Last header: {lastVis.name} at {new Date(lastVis.at).toISOString().slice(11, 16)}Z - not a mode decoded here
          </span>
        )}
        <span className="text-fg-subtle">Martin, Scottie, Robot 36 and PD modes, named by the header</span>
      </div>

      <div className="bg-bg border border-line rounded-sm overflow-hidden flex justify-center">
        {/* The canvas is the picture coming in; a picture from the gallery replaces it until the next one starts. */}
        <canvas
          ref={canvas}
          width={320}
          height={256}
          className={live ? "block w-full max-w-[640px] [image-rendering:pixelated]" : "hidden"}
          aria-label={live ? `${live.mode} picture being received` : undefined}
        />
        {!live && showing && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/sstv/${showing.file}`}
            alt={`${showing.mode} picture received ${time(showing.at)}`}
            className="block w-full max-w-[640px]"
          />
        )}
        {!live && !showing && (
          <div className="aspect-[5/4] w-full max-w-[640px] grid place-items-center text-xs text-fg-subtle">
            No pictures yet. 14.230 is busiest at weekends.
          </div>
        )}
      </div>

      <SstvSend myCall={myCall} canSend={canSend} galleryFile={showing?.file ?? null} tx={tx} />

      {pictures.length > 0 && (
        <div>
          <div className="text-xs text-fg-muted mb-1">
            Received ({data?.total ?? pictures.length}){showing && !live ? ` · showing ${showing.mode}, ${time(showing.at)}` : ""}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {pictures.map((p) => (
              <button
                key={p.file}
                type="button"
                onClick={() => setPicked(p)}
                className={
                  "shrink-0 border rounded-sm overflow-hidden focus-visible:outline-2 focus-visible:outline-accent-bright " +
                  (showing?.file === p.file ? "border-accent" : "border-line hover:border-fg-muted")
                }
                title={`${p.mode}, ${time(p.at)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/sstv/${p.file}`} alt={`${p.mode} ${time(p.at)}`} className="block h-16 w-20 object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

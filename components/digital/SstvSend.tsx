// Sending an SSTV picture: choose one (a file, a picture from the gallery, or the test
// card) and a mode, see it at the mode's size with the callsign stamped on, and send.
// The bridge checks the licence class, the transmit gate and the PA, sends at the SSTV
// power, and reports progress as `sstv-tx` messages, which the page passes in as `tx`.

import { useCallback, useEffect, useRef, useState } from "react";

import { NativeSelect } from "@/components/decodes/controls";
import { Button } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import { sstvImageSeconds, sstvModeByName, sstvTestCard } from "@/lib/digital/sstv";

/** The modes offered for sending: the common ones on the air. The bridge enforces the same list. */
const SEND_MODES = ["Martin 1", "Martin 2", "Scottie 1", "Scottie 2", "Scottie DX", "Robot 36", "Robot 72", "PD 90", "PD 120", "PD 180"];

export interface SstvTxState {
  sending: boolean;
  mode: string;
  startedAt?: number;
  durationMs?: number;
  powerPct?: number | null;
  sent?: boolean;
  reason?: string | null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function SstvSend({
  myCall,
  canSend,
  galleryFile,
  tx,
}: {
  myCall: string | null;
  canSend: boolean;
  /** The gallery picture on show, offered as a source. */
  galleryFile: string | null;
  tx: SstvTxState | null;
}) {
  const [open, setOpen] = useState(false);
  const [modeName, setModeName] = useState("Martin 1");
  const [source, setSource] = useState<CanvasImageSource | "card" | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [stamp, setStamp] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const preview = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mode = sstvModeByName(modeName)!;

  // Draw the preview: the source scaled to fill the mode's frame, cropped to its shape,
  // and the callsign in the top left, white on a dark outline, as SSTV pictures carry it.
  useEffect(() => {
    const c = preview.current;
    if (!c) return;
    c.width = mode.width;
    c.height = mode.height;
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "#000";
    g.fillRect(0, 0, mode.width, mode.height);
    if (source === "card") {
      const card = sstvTestCard(mode.width, mode.height);
      const img = g.createImageData(mode.width, mode.height);
      for (let i = 0, j = 0; i < card.rgb.length; i += 3, j += 4) {
        img.data[j] = card.rgb[i]!;
        img.data[j + 1] = card.rgb[i + 1]!;
        img.data[j + 2] = card.rgb[i + 2]!;
        img.data[j + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    } else if (source) {
      const sw = (source as HTMLImageElement).naturalWidth || (source as HTMLCanvasElement).width;
      const sh = (source as HTMLImageElement).naturalHeight || (source as HTMLCanvasElement).height;
      const scale = Math.max(mode.width / sw, mode.height / sh);
      const w = sw * scale;
      const h = sh * scale;
      g.drawImage(source, (mode.width - w) / 2, (mode.height - h) / 2, w, h);
    }
    if (stamp && myCall && source) {
      const size = Math.round(mode.height / 9);
      g.font = `bold ${size}px sans-serif`;
      g.textBaseline = "top";
      g.lineWidth = Math.max(2, size / 8);
      g.strokeStyle = "#000";
      g.fillStyle = "#fff";
      g.strokeText(myCall, size / 3, size / 4);
      g.fillText(myCall, size / 3, size / 4);
    }
  }, [mode, source, stamp, myCall]);

  // A second hand while a picture is going out.
  useEffect(() => {
    if (!tx?.sending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tx?.sending]);

  const loadUrl = useCallback((url: string, label: string) => {
    const img = new Image();
    img.onload = () => {
      setSource(img);
      setSourceLabel(label);
      setError(null);
    };
    img.onerror = () => setError("That picture could not be read");
    img.src = url;
  }, []);

  const send = async () => {
    const c = preview.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const data = g.getImageData(0, 0, mode.width, mode.height).data;
    const rgb = new Uint8Array(mode.width * mode.height * 3);
    for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
      rgb[i] = data[j]!;
      rgb[i + 1] = data[j + 1]!;
      rgb[i + 2] = data[j + 2]!;
    }
    try {
      await apiPost("/api/sstv/send", { mode: mode.name, width: mode.width, height: mode.height, rgb: toBase64(rgb) });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send");
    }
  };

  const stop = async () => {
    try {
      await apiPost("/api/sstv/send", { stop: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not stop");
    }
  };

  if (!canSend) return null;
  const sending = tx?.sending ?? false;
  const elapsed = sending && tx?.startedAt ? now - tx.startedAt : 0;

  return (
    <div className="border border-line rounded-sm p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide sending" : "Send a picture"}
        </Button>
        {sending && tx && (
          <>
            <span className="text-accent-bright tnum">
              Sending {tx.mode} · {mmss(elapsed)} of {mmss(tx.durationMs ?? 0)}
              {tx.powerPct != null ? ` · ${tx.powerPct}% power` : ""}
            </span>
            <Button size="sm" variant="danger" onClick={() => void stop()}>
              Stop
            </Button>
          </>
        )}
        {!sending && tx && tx.sent === false && tx.reason && <span className="text-danger">Not sent: {tx.reason}</span>}
        {!sending && tx?.sent && <span className="text-fg-muted">Sent {tx.mode}.</span>}
      </div>

      {open && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              Choose a file…
            </Button>
            {/* Hidden rather than sr-only, so it is not a second tab stop beside the button. */}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadUrl(URL.createObjectURL(f), f.name);
              }}
            />
            <Button
              size="sm"
              disabled={!galleryFile}
              onClick={() => galleryFile && loadUrl(`/api/sstv/${galleryFile}`, "the gallery picture")}
            >
              Use the gallery picture
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setSource("card");
                setSourceLabel("the test card");
              }}
            >
              Test card
            </Button>
            <NativeSelect
              value={modeName}
              onChange={(e) => setModeName(e.target.value)}
              aria-label="SSTV mode to send"
            >
              {SEND_MODES.map((m) => (
                <option key={m} value={m}>
                  {m} · {Math.round(sstvImageSeconds(sstvModeByName(m)!))} s
                </option>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} />
              <span>{myCall ? `Stamp ${myCall}` : "Stamp callsign (set it in Settings)"}</span>
            </label>
          </div>
          <div className="bg-bg border border-line rounded-sm overflow-hidden flex justify-center">
            <canvas ref={preview} className="block w-full max-w-[480px]" aria-label="The picture as it will be sent" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <Button size="sm" disabled={!source || sending} onClick={() => void send()}>
              Send {mode.name}
            </Button>
            <span>
              {source ? `From ${sourceLabel}. ` : "Choose a picture. "}
              {Math.round(sstvImageSeconds(mode))} s of carrier, at the SSTV power in Settings; the licence class decides where it may go.
            </span>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

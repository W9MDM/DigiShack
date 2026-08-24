import { useEffect, useMemo, useRef, useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import { ApiError } from "@/lib/client/api";

// The QSL card designer: upload the artwork, and see the result while changing it.
//
// Two faults this fixes, both reported. `qsl.card.baseImage` was a filesystem path typed
// into a settings box, so the only way to change your card was to get a file onto the
// server yourself — "I don't see a place for anyone else to upload an image", and the
// operative words are "anyone else". And the dozen numbers that place the table had no
// feedback at all: the loop was edit a setting, save, email yourself a QSL, open the
// attachment. Nobody runs that twice, which is why the defaults had never been changed.
//
// The preview renders server-side through the SAME code that renders the real card, with
// the unsaved values passed as query parameters. A preview drawn by different code would
// eventually disagree with the article, and the disagreement would be invisible.

/** The geometry and colour keys this previews, and their setting names. */
const DRAFT_KEYS = [
  "tableRight",
  "tableBottom",
  "tableWidth",
  "fontScale",
  "textColor",
  "headingBg",
  "cellBg",
  "borderColor",
  "columns",
] as const;
type DraftKey = (typeof DRAFT_KEYS)[number];

const SETTING_OF: Record<DraftKey, string> = {
  tableRight: "qsl.card.tableRight",
  tableBottom: "qsl.card.tableBottom",
  tableWidth: "qsl.card.tableWidth",
  fontScale: "qsl.card.fontScale",
  textColor: "qsl.card.textColor",
  headingBg: "qsl.card.headingBg",
  cellBg: "qsl.card.cellBg",
  borderColor: "qsl.card.borderColor",
  columns: "qsl.card.columns",
};

export function QslCardDesigner({
  draft,
}: {
  /** The settings page's unsaved values, so the preview shows what Save would produce. */
  draft: Record<string, string>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // Bumped to force a re-fetch after an upload, since the URL is otherwise unchanged.
  const [version, setVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The query string that describes the CURRENT draft. Only keys the operator has actually
  // touched are sent; the endpoint falls back to the saved value for anything absent, so an
  // untouched field previews as it really is rather than as a client-side guess.
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const key of DRAFT_KEYS) {
      const v = draft[SETTING_OF[key]];
      if (v !== undefined && v !== "") p.set(key, v);
    }
    p.set("v", String(version));
    return p.toString();
  }, [draft, version]);

  // Debounced, because these are dragged sliders and text fields: rendering on every
  // keystroke would queue a sharp composite per character.
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const id = setTimeout(() => setSettled(query), 400);
    return () => clearTimeout(id);
  }, [query]);

  const src = `/api/qsl/card-preview?${settled}`;

  // A failed render returns TEXT with a 4xx, not an image, so the reason can be shown
  // instead of a broken-image icon. Fetched rather than relying on <img onError>, which
  // reports that something failed and never what.
  useEffect(() => {
    let alive = true;
    setRenderError(null);
    void fetch(src)
      .then(async (r) => {
        if (!alive) return;
        if (!r.ok) setRenderError((await r.text()) || `The preview failed (${r.status})`);
      })
      .catch(() => alive && setRenderError("Could not reach the preview"));
    return () => {
      alive = false;
    };
  }, [src]);

  async function upload(file: File) {
    setBusy(true);
    setProblem(null);
    try {
      // Raw body: the image IS the request. The endpoint has Next's body parser disabled
      // because it would try to JSON-parse a PNG.
      const res = await fetch("/api/qsl/card-image", {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = (await res.json().catch(() => null)) as
        | { path?: string; width?: number; height?: number; error?: string }
        | null;
      if (!res.ok) {
        setProblem(body?.error ?? `Upload failed (${res.status})`);
        return;
      }
      setUploaded(
        body?.width && body?.height
          ? `Saved — ${body.width}×${body.height}px`
          : "Saved",
      );
      setVersion((v) => v + 1);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not upload that file");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1 border-t border-line/60">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">Card artwork</span>
        <HelpTip label="About the card designer">
          Upload your artwork with no table or placeholder text on it — the contact table is
          composited on top, at the position and colours set below. The preview is rendered
          by the same code that builds the real card, using the values currently on screen,
          so what you see is what Save would send.
        </HelpTip>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          aria-label="QSL card artwork"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          className="text-xs text-fg-muted file:mr-2 file:rounded-sm file:border file:border-line file:bg-bg-raised file:px-2 file:py-1 file:text-xs file:text-fg-muted hover:file:text-fg"
        />
        {busy && <span className="text-xs text-fg-subtle">uploading…</span>}
        {uploaded && !busy && <span className="text-xs text-ok">{uploaded}</span>}
      </div>
      {problem && <p className="text-xs text-danger">{problem}</p>}
      <p className="text-[11px] text-fg-subtle">
        PNG, JPEG or WebP, up to 12&nbsp;MB. Stored outside git as
        {" "}<code>data/qsl/card-base.png</code> and never committed. Uploading replaces the
        current artwork and points the setting at it.
      </p>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">Preview</span>
        {renderError ? (
          // A configuration state rather than a crash — most often "no artwork yet" — so it
          // reads as an instruction and names the thing to fix.
          <p className="text-xs text-warn border border-warn/40 bg-warn/10 rounded-sm px-2 py-1.5">
            {renderError}
          </p>
        ) : (
          <img
            src={src}
            alt="Preview of the QSL card with the current settings"
            className="w-full max-w-xl rounded-sm border border-line"
          />
        )}
        <p className="text-[11px] text-fg-subtle">
          Uses your most recent contact so the columns show real widths, and updates a
          moment after you stop typing. Rendered smaller than the real card, which is
          1600&nbsp;px wide by default.
        </p>
      </div>
    </div>
  );
}

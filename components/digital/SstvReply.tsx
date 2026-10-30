// Answering an SSTV picture and logging the contact.
//
// SSTV carries no text: a station writes "K9XYZ DE N3CHX UR 595" on the picture itself. So
// the bridge reads the picture (OCR, lib/digital/sstv-read.ts) for their call and the report
// they gave us, and measures the signal for the report we give them (RSV: readability from
// the sync pulses found, strength from the S-meter, video from how clean the pulses were).
// All of it arrives here filled in and editable, since the OCR can misread a callsign as
// easily as read it. "Reply" hands a caption to the send box; "Log" writes the contact.

import { useEffect, useState } from "react";

import { Button, Input } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import type { SstvRead } from "@/lib/digital/sstv-read";

export interface SstvPictureInfo {
  file: string;
  mode: string;
  at: string;
  freqHz: number | null;
  rsv: { r: number; s: number; v: number; report: string; sMeasured: boolean } | null;
  read: SstvRead | null;
  logged: { qsoId: string; callsign: string } | null;
}

/** The caption a reply carries: who it is for, from us, their report, and a word. */
export function replyCaption(theirCall: string, myCall: string | null, rsv: string, message: string): string {
  return [theirCall && `${theirCall} DE ${myCall ?? ""}`.trim(), rsv && `UR ${rsv}`, message].filter(Boolean).join(" ");
}

export function SstvReply({
  picture,
  myCall,
  dialHz,
  canSend,
  onReply,
  onLogged,
}: {
  picture: SstvPictureInfo;
  myCall: string | null;
  dialHz: number | null;
  canSend: boolean;
  /** Open the send box with this caption on the picture. */
  onReply: (caption: string) => void;
  onLogged: () => void;
}) {
  const [call, setCall] = useState("");
  const [sent, setSent] = useState("");
  const [rcvd, setRcvd] = useState("");
  const [message, setMessage] = useState("TNX PIC 73");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggedAs, setLoggedAs] = useState<{ id: string; callsign: string } | null>(null);

  // A new picture, or its reading arriving after it: fill in what the bridge found. Only
  // into empty fields once the operator has typed, so a late OCR does not undo a correction.
  useEffect(() => {
    setCall(picture.read?.theirCall ?? "");
    setSent(picture.rsv?.report ?? "");
    setRcvd(picture.read?.reportRcvd ?? "");
    setError(null);
    setLoggedAs(picture.logged ? { id: picture.logged.qsoId, callsign: picture.logged.callsign } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture.file]);
  useEffect(() => {
    if (picture.read?.theirCall) setCall((c) => c || picture.read!.theirCall!);
    if (picture.read?.reportRcvd) setRcvd((r) => r || picture.read!.reportRcvd!);
  }, [picture.read]);

  const log = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ id: string; callsign: string }>("/api/sstv/log", {
        file: picture.file,
        callsign: call,
        rstSent: sent || null,
        rstRcvd: rcvd || null,
        freqHz: dialHz,
      });
      setLoggedAs(r);
      onLogged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log the contact");
    } finally {
      setBusy(false);
    }
  };

  const rsv = picture.rsv;
  const others = (picture.read?.calls ?? []).filter((c) => c !== call);

  return (
    <div className="border border-line rounded-sm p-3 flex flex-col gap-2 text-xs">
      <div className="text-fg-muted">
        Reply and log · {picture.mode}, {picture.at.slice(11, 16)}Z
        {rsv && (
          <span className="tnum">
            {" "}
            · measured R{rsv.r} S{rsv.s}
            {rsv.sMeasured ? "" : " (estimated, no S-meter)"} V{rsv.v}
          </span>
        )}
        {picture.read ? (
          picture.read.theirCall || picture.read.reportRcvd ? (
            <span> · read off the picture: {[picture.read.theirCall, picture.read.reportRcvd && `report ${picture.read.reportRcvd}`].filter(Boolean).join(", ")}</span>
          ) : (
            <span> · no callsign read off the picture</span>
          )
        ) : rsv ? (
          <span> · reading the picture…</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Their call</span>
          <Input value={call} onChange={(e) => setCall(e.target.value.toUpperCase())} placeholder="N3CHX" spellCheck={false} autoCapitalize="characters" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Report I give (RSV)</span>
          <Input value={sent} onChange={(e) => setSent(e.target.value)} placeholder="595" inputMode="numeric" className="tnum" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Report they gave me</span>
          <Input value={rcvd} onChange={(e) => setRcvd(e.target.value)} placeholder="595" inputMode="numeric" className="tnum" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Message</span>
          <Input value={message} onChange={(e) => setMessage(e.target.value.toUpperCase())} maxLength={24} />
        </label>
      </div>
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-fg-muted">
          Also read:
          {others.map((c) => (
            <button key={c} type="button" className="rounded-sm border border-line px-1.5 hover:border-fg-muted" onClick={() => setCall(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canSend && (
          <Button size="sm" disabled={!call} onClick={() => onReply(replyCaption(call, myCall, sent, message))}>
            Reply with a picture…
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!call || busy || loggedAs !== null} loading={busy} onClick={() => void log()}>
          {loggedAs ? `Logged as ${loggedAs.callsign}` : "Log contact"}
        </Button>
        {loggedAs && (
          <a className="text-accent-bright underline" href={`/qsos/${loggedAs.id}`}>
            Open in the log
          </a>
        )}
        {picture.read?.text && (
          <details className="text-fg-subtle">
            <summary className="cursor-pointer">Text read</summary>
            <pre className="whitespace-pre-wrap font-mono">{picture.read.text}</pre>
          </details>
        )}
      </div>
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

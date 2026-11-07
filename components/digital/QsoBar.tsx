// The exchange and the log for the keyboard modes: RTTY, CW, PSK, Olivia and the Hell
// modes. These have no sequencer, so a contact is typed - and most of what is typed is the
// same few lines with two callsigns and a report in them. F1-F8 send those lines with the
// calls and the report filled in (%M my call, %H theirs, %R the report I give, %N their
// name), and Log writes the contact with the mode as ADIF knows it. Sending the 73 key logs
// it too, unless that is turned off.

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Input } from "@/components/ui/primitives";
import { ApiError, apiGet, apiPost } from "@/lib/client/api";

export interface QsoMacro {
  key: string;
  label: string;
  text: string;
  /** Sending this one ends the contact: log it, if logging on 73 is on. */
  ends?: boolean;
}

/** The lines every keyboard mode uses. %M my call, %H their call, %R the report I give, %N their name. */
export const QSO_MACROS: readonly QsoMacro[] = [
  { key: "F1", label: "CQ", text: "CQ CQ CQ DE %M %M %M K" },
  { key: "F2", label: "Answer", text: "%H %H DE %M %M %M K" },
  { key: "F3", label: "Report", text: "%H DE %M TNX FER CALL UR %R %R %R BK" },
  { key: "F4", label: "73", text: "%H DE %M TNX QSO %N 73 SK", ends: true },
  { key: "F5", label: "Repeat?", text: "%H DE %M PSE AGN K" },
  { key: "F6", label: "Over", text: "%H DE %M K" },
  { key: "F7", label: "Thanks, report", text: "%H DE %M R R TNX UR %R %R BK" },
  { key: "F8", label: "My call", text: "%M" },
];

/** Fill a macro in. A line that needs their call and has none is not sent. */
export function fillMacro(text: string, v: { my: string | null; their: string; report: string; name: string }): string | null {
  if (text.includes("%M") && !v.my) return null;
  if (text.includes("%H") && !v.their) return null;
  return text
    .replace(/%M/g, v.my ?? "")
    .replace(/%H/g, v.their)
    .replace(/%R/g, v.report || "599")
    .replace(/%N/g, v.name)
    .replace(/\s+/g, " ")
    .trim();
}

const CALL = /^[A-Z0-9]{1,4}\/?[A-Z0-9]{2,8}(\/[A-Z0-9]{1,4})?$/;

export function QsoBar({
  logMode,
  modeLabel,
  freqHz,
  myCall,
  canSend,
  transmitting,
  onSend,
  pickedCall,
}: {
  /** The mode as the log stores it: HELL, FSKH105, PSK63, RTTY and so on. */
  logMode: string;
  /** What the operator calls it, for the Log button. */
  modeLabel: string;
  /** The signal's frequency: dial plus carrier. Null while the radio has not said. */
  freqHz: number | null;
  myCall: string | null;
  canSend: boolean;
  transmitting: boolean;
  onSend: (text: string) => void;
  /** A callsign picked elsewhere on the page (a click in the received text). */
  pickedCall?: { call: string; at: number } | null;
}) {
  const [call, setCall] = useState("");
  const [sent, setSent] = useState("599");
  const [rcvd, setRcvd] = useState("");
  const [name, setName] = useState("");
  const [qth, setQth] = useState("");
  const [grid, setGrid] = useState("");
  const [logOn73, setLogOn73] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; id?: string } | null>(null);
  const loggedFor = useRef<string | null>(null);

  useEffect(() => {
    if (pickedCall?.call) setCall(pickedCall.call);
  }, [pickedCall]);

  // A different station is a different contact: what was typed for the last one goes.
  useEffect(() => {
    setRcvd("");
    setName("");
    setQth("");
    setGrid("");
    setStartedAt(null);
    setNote(null);
    loggedFor.current = null;
  }, [call]);

  const valid = CALL.test(call);

  // Who they are, from QRZ (or HamDB without a QRZ login), once the call has stopped
  // changing. Fills only what is still empty, so nothing typed is overwritten, and the
  // first name rather than the whole one, because that is what goes in an exchange.
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  useEffect(() => {
    setLookedUp(null);
    if (!valid) return;
    let live = true;
    const t = setTimeout(() => {
      void apiGet<{ found: boolean; source: string | null; firstName: string | null; name: string | null; qth: string | null; grid: string | null; note: string | null }>(
        `/api/callsign-lookup?call=${encodeURIComponent(call)}`,
      )
        .then((r) => {
          if (!live) return;
          if (!r.found) {
            setLookedUp(r.note ? `Not found (${r.note})` : "Not found on QRZ or HamDB");
            return;
          }
          setName((v) => v || r.firstName || r.name || "");
          setQth((v) => v || r.qth || "");
          setGrid((v) => v || r.grid || "");
          setLookedUp(`${r.name ?? call}${r.qth ? `, ${r.qth}` : ""} · from ${r.source === "qrz" ? "QRZ" : "HamDB"}`);
        })
        .catch(() => live && setLookedUp(null));
    }, 700);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [call, valid]);

  const log = useCallback(async () => {
    if (!valid || freqHz === null) return;
    setBusy(true);
    try {
      const r = await apiPost<{ id: string; callsign: string; band: string }>("/api/digital/log", {
        mode: logMode,
        callsign: call,
        rstSent: sent || null,
        rstRcvd: rcvd || null,
        freqHz: Math.round(freqHz),
        name: name || null,
        qth: qth || null,
        grid: grid || null,
        startedAt,
      });
      loggedFor.current = call;
      setNote({ ok: true, text: `Logged ${r.callsign} on ${r.band}, ${modeLabel}`, id: r.id });
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : "Could not log the contact" });
    } finally {
      setBusy(false);
    }
  }, [valid, freqHz, logMode, call, sent, rcvd, name, qth, grid, startedAt, modeLabel]);

  const fire = useCallback(
    (m: QsoMacro) => {
      const line = fillMacro(m.text, { my: myCall, their: call, report: sent, name });
      if (!line) {
        setNote({ ok: false, text: m.text.includes("%H") ? "Type their call first" : "Set your callsign in Settings first" });
        return;
      }
      if (call && startedAt === null && m.text.includes("%H")) setStartedAt(Date.now());
      onSend(line);
      if (m.ends && logOn73 && valid && loggedFor.current !== call) void log();
    },
    [myCall, call, sent, name, startedAt, onSend, logOn73, valid, log],
  );

  // F1-F8 anywhere on the page while this bar is showing, as in fldigi.
  useEffect(() => {
    if (!canSend) return;
    const onKey = (e: KeyboardEvent) => {
      const m = QSO_MACROS.find((x) => x.key === e.key);
      if (!m || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      if (!transmitting) fire(m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSend, transmitting, fire]);

  return (
    <div className="flex flex-col gap-2 border border-line rounded-sm p-2 text-xs">
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
          <span className="text-fg-muted">Their call</span>
          <Input value={call} onChange={(e) => setCall(e.target.value.toUpperCase().trim())} placeholder="Type their call" spellCheck={false} autoCapitalize="characters" className="font-mono" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Sent</span>
          <Input value={sent} onChange={(e) => setSent(e.target.value)} inputMode="numeric" className="tnum" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Rcvd</span>
          <Input value={rcvd} onChange={(e) => setRcvd(e.target.value)} placeholder="RST" inputMode="numeric" className="tnum" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">QTH</span>
          <Input value={qth} onChange={(e) => setQth(e.target.value)} placeholder="optional" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Grid</span>
          <Input value={grid} onChange={(e) => setGrid(e.target.value)} placeholder="optional" spellCheck={false} />
        </label>
      </div>

      {canSend && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
          {QSO_MACROS.map((m) => {
            const line = fillMacro(m.text, { my: myCall, their: call, report: sent, name });
            return (
              <Button
                key={m.key}
                size="sm"
                variant="ghost"
                className="flex flex-col items-start border border-line text-left"
                disabled={transmitting || !line}
                title={line ?? m.text}
                onClick={() => fire(m)}
              >
                <span className="flex w-full justify-between gap-2 text-fg-subtle">
                  <span>{m.key}</span>
                  <span>{m.label}</span>
                </span>
                <span className="w-full truncate font-mono text-fg">{line ?? m.text}</span>
              </Button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!valid || busy || freqHz === null || loggedFor.current === call} onClick={() => void log()}>
          {loggedFor.current === call && call ? `Logged ${call}` : `Log contact (${modeLabel})`}
        </Button>
        {canSend && (
          <label className="flex items-center gap-1 text-fg-muted">
            <input type="checkbox" checked={logOn73} onChange={(e) => setLogOn73(e.target.checked)} />
            Log when I send 73 (F4)
          </label>
        )}
        {note && (
          <span className={note.ok ? "text-accent-bright" : "text-danger"}>
            {note.text}
            {note.id && (
              <>
                {" · "}
                <a className="underline" href={`/qsos/${note.id}`}>
                  open
                </a>
              </>
            )}
          </span>
        )}
      </div>
      {lookedUp && <p className="text-fg-muted">{lookedUp}</p>}
      {canSend && <p className="text-fg-subtle">F1–F8 on the keyboard send these too. %M is your call, %H theirs, %R the report you give.</p>}
    </div>
  );
}

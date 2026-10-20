// Operating: the automatic mode (a dropdown in the on-air bar, with its status, Re-arm and
// the one HALT TX on the page) and the contact being worked (a compact panel under the
// waterfall). The QSO controller and the auto operator share one set of guards, so there is
// one HALT TX (the only solid red on the page) and one Re-arm, in the bar.

import { useState } from "react";

import type { AutoState, DecodeEvent, QsoState, RigStatus } from "@/components/decodes/types";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, Input, Select } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import type { ClearSlot } from "@/lib/digital/slot";
import { gridFromMessage } from "@/lib/ham/grid-message";
import { cn } from "@/lib/utils";

type Schedule = NonNullable<RigStatus["schedule"]>;

/** The automatic mode, what it is doing, Re-arm and HALT TX — for the on-air bar. */
export function AutoControls({
  sequencer,
  auto,
  qso,
  schedule,
}: {
  /** The mode has an FT8-style sequencer. On the others the bridge refuses calls and auto. */
  sequencer: boolean;
  auto: AutoState | null;
  qso: QsoState | null;
  schedule: Schedule | null;
}) {
  const active = qso?.active ?? false;
  const running = (auto?.mode ?? "off") !== "off";
  const pausedReason = auto?.pausedReason ?? qso?.pausedReason ?? null;
  // Outside the sequencer modes there is nothing to pick, so it only appears when something
  // is still running or paused and needs a hand on it.
  if (!(sequencer || running || active || pausedReason !== null || schedule !== null)) return null;
  return <AutoBar auto={auto} qso={qso} schedule={schedule} pausedReason={pausedReason} />;
}

/** The contact being worked, or the station picked — compact, for under the waterfall. */
export function WorkPanel({
  sequencer,
  auto,
  qso,
  target,
  suggestSlot,
  lastTx,
  myCall,
  myGrid,
  onClose,
}: {
  sequencer: boolean;
  auto: AutoState | null;
  qso: QsoState | null;
  target: DecodeEvent | null;
  suggestSlot: () => ClearSlot;
  lastTx: string | null;
  myCall: string | null;
  myGrid: string | null;
  onClose: () => void;
}) {
  const active = qso?.active ?? false;
  if (!(sequencer || active)) return null;
  return (
    <section
      className={cn(
        "rounded-md border bg-surface shadow-panel",
        active ? "border-accent/40" : "border-line",
      )}
    >
      <WorkStation
        target={target}
        qso={qso}
        auto={auto}
        suggestSlot={suggestSlot}
        lastTx={lastTx}
        myCall={myCall}
        myGrid={myGrid}
        onClose={onClose}
      />
    </section>
  );
}

const MODES: { id: AutoState["mode"]; label: string; short: string; hint: string }[] = [
  { id: "off", label: "Off", short: "Off", hint: "No automatic transmissions" },
  { id: "cq", label: "Auto CQ", short: "CQ", hint: "Call CQ, work whoever answers, log, repeat" },
  { id: "hunt", label: "Auto Hunt", short: "Hunt", hint: "Answer callable CQs (skips dupes), one at a time" },
  { id: "hunt-pota", label: "Hunt POTA", short: "POTA", hint: "Only stations calling CQ POTA" },
  {
    id: "pota-chase",
    label: "Chase POTA",
    short: "Chase",
    hint: "Retune to spotted POTA activators and work them (uses the POTA spot feed)",
  },
];

const running = (mode: string): boolean => mode !== "off";

/** The automatic modes, what they are doing, and the stop. */
function AutoBar({
  auto,
  qso,
  schedule,
  pausedReason,
}: {
  auto: AutoState | null;
  qso: QsoState | null;
  schedule: Schedule | null;
  pausedReason: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = auto?.mode ?? "off";
  const waiting = auto?.waiting ?? [];

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/bridge/control", body);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const doing =
    (auto?.lastAction ?? "") +
    (auto && auto.warmup > 0 ? ` (listening, ${auto.warmup} more cycle${auto.warmup === 1 ? "" : "s"})` : "");

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
      <div className="flex items-center gap-1.5">
        <Select
          aria-label="Automatic operating mode"
          title={MODES.find((m) => m.id === mode)?.hint}
          className={cn("w-32 py-1 text-sm", running(mode) && "border-accent text-accent-bright")}
          value={mode}
          disabled={busy}
          onChange={(e) => void act({ action: "auto", autoMode: e.target.value })}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === "off" ? "Auto: off" : m.label}
            </option>
          ))}
        </Select>
        <HelpTip label="About the automatic modes">
          {MODES.map((m) => (
            <span key={m.id} className="block">
              <span className="text-fg">{m.label}</span> — {m.hint}.
            </span>
          ))}
        </HelpTip>
      </div>

      <span className="text-xs text-fg-subtle min-w-0 max-w-[22rem] truncate">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : pausedReason ? (
          <span className="text-warn">⚠ {pausedReason}</span>
        ) : (
          doing || (mode !== "off" ? MODES.find((m) => m.id === mode)?.hint : "")
        )}
      </span>

      {/* Tail-enders: someone who called while we were busy will be answered, not missed. */}
      {waiting.length > 0 && (
        <span
          className="text-xs whitespace-nowrap rounded-sm border border-ok/40 bg-ok/10 px-1.5 py-0.5 text-ok"
          title={`Called us during a contact and will be worked next, in this order: ${waiting.join(", ")}`}
        >
          ↩ {waiting.length} waiting: {waiting.slice(0, 3).join(", ")}
          {waiting.length > 3 ? "…" : ""}
        </span>
      )}
      {schedule && (
        <span
          className={cn("text-xs whitespace-nowrap", schedule.suppressed ? "text-warn" : "text-fg-muted")}
          title="The operating schedule (Settings → Schedule) is driving the mode. A mode picked by hand holds until the next scheduled boundary."
        >
          ⏱ {schedule.reason}
        </span>
      )}

      {pausedReason && (
        <Button size="sm" disabled={busy} onClick={() => void act({ action: "rearm" })}>
          Re-arm transmit
        </Button>
      )}
      {/* A full-width bar of its own on a phone, where there is no Escape key and it was
          otherwise wherever the wrap happened to leave it; inline from `sm` up. */}
      {(mode !== "off" || qso?.active) && (
        <Button
          variant="danger-solid"
          disabled={busy}
          onClick={() => void act({ action: "qso-halt" })}
          title="Stop transmitting immediately — this contact AND any automatic mode. Escape does the same."
          className="w-full py-2.5 sm:w-auto sm:py-1.5"
        >
          HALT TX
        </Button>
      )}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  calling: "Calling — waiting for their report",
  "report-sent": "Report sent — waiting for R-report",
  "rreport-sent": "R-report sent — waiting for RR73",
  "rr73-sent": "RR73 sent — waiting for their 73",
  complete: "QSO complete — logged",
  // Nobody replied, or they answered somebody else and we released the transmitter.
  abandoned: "Call ended",
};

/**
 * One contact: the station picked from the decode list, the call, the exchange as it
 * advances. Modelled on WSJT-X's Tx1–Tx6, but the bridge's QsoController sequences it.
 */
function WorkStation({
  target,
  qso,
  auto,
  suggestSlot,
  lastTx,
  myCall,
  myGrid,
  onClose,
}: {
  target: DecodeEvent | null;
  qso: QsoState | null;
  /** Needed to know whether a queued call would ever actually be made. */
  auto: AutoState | null;
  suggestSlot: () => ClearSlot;
  lastTx: string | null;
  myCall: string | null;
  myGrid: string | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A successful-but-different outcome, e.g. "queued behind the current contact". */
  const [notice, setNotice] = useState<string | null>(null);

  const active = qso?.active ?? false;
  const autoRunning = (auto?.mode ?? "off") !== "off";
  /** Someone selected who is NOT the station currently being worked. */
  const other =
    target?.callsign && (!active || target.callsign !== qso?.theirCall) ? target.callsign : null;
  const call = active ? qso!.theirCall : (target?.callsign ?? null);

  async function act(
    action: "call" | "qso-skip",
    /** A station that has not decoded here: a sked, or someone you are told is on. */
    manual?: { theirCall: string; theirOffsetHz: number },
    /** Halt the contact in flight and call this one immediately. */
    takeOver?: boolean,
  ) {
    setBusy(true);
    setError(null);
    try {
      const reply = await apiPost<{ queued?: boolean; reason?: string }>("/api/bridge/control", {
        action,
        ...(takeOver ? { takeOver: true } : {}),
        ...(action === "call" && manual
          ? {
              theirCall: manual.theirCall,
              theirGrid: null,
              // Unheard, so there is no report to echo; the one we send is measured from their reply.
              theirSnr: 0,
              theirOffsetHz: manual.theirOffsetHz,
              // Not 0: the bridge derives our transmit parity from this, and 0 would put every
              // manual call on odd windows — half the time on top of the station we call.
              // Now is the current window, so we answer in the next one.
              theirWindowStart: Date.now(),
            }
          : {}),
        ...(action === "call" && !manual && target
          ? {
              theirCall: target.callsign,
              theirGrid: gridFromMessage(target.message),
              theirSnr: target.snr,
              theirOffsetHz: target.freqOffset,
              theirWindowStart: new Date(target.timestamp).getTime(),
              // So the logged transcript opens with the message that prompted the call.
              message: target.message,
            }
          : {}),
      });
      // "Queued behind KC1YTV" and "calling now" must not look the same.
      setNotice(reply?.queued && reply.reason ? reply.reason : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Control request failed");
    } finally {
      setBusy(false);
    }
  }

  // Nothing selected. The sentence naming the click stays on screen — this panel once
  // rendered nothing until after the click nobody knew to make — and the manual-call form
  // (a sked, a net, a station that has not decoded) folds away. It stays mounted while
  // folded, so its clear-slot pick happens at load, as before; "Find clear slot" refreshes it.
  if (!target && !active) {
    return (
      <div className="px-3 py-2 text-sm text-fg-muted">
        <details>
          <summary className="cursor-pointer select-none">
            Pick a station to work: press <span className="text-fg">Call</span> on a decode below, or
            click its row.
            <span className="ml-1.5 text-xs text-fg-subtle">Not decoded here? Call by callsign.</span>
          </summary>
          <div className="mt-2 border-t border-line pt-2">
            <p className="mb-1.5 text-xs text-fg-subtle">
              The exchange then runs itself: report, roger-report, RR73, logged. We transmit in the
              next cycle, so they answer in the one after.
            </p>
            <ManualCall
              busy={busy}
              suggestSlot={suggestSlot}
              onCall={(c, hz) => void act("call", { theirCall: c, theirOffsetHz: hz })}
            />
          </div>
        </details>
        {/* Outside the <details>: a refused call must never be hidden in a closed one. */}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="font-display text-base text-fg">{active ? "Working" : "Selected"}</h2>
          {call && <Badge tone={active ? "ok" : "accent"}>{call}</Badge>}
          {active && <Badge tone="danger">ON AIR</Badge>}
          {qso?.state && (
            <span className="text-xs text-fg-muted">{STATE_LABEL[qso.state] ?? qso.state}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!active && target?.callsign && (
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => void act("call")}
              title="Calls on their frequency, on the opposite cycle. The sequencer answers each reply and logs the QSO on completion."
            >
              Call {target.callsign}
            </Button>
          )}
          {/* Picked while another contact is in flight: queue them, or drop it and call now. */}
          {active && other && (
            <>
              {autoRunning ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("call")}
                  title={`Work ${other} as soon as the contact with ${qso?.theirCall ?? "the current station"} finishes. Nothing on the air is disturbed.`}
                >
                  Queue {other}
                </Button>
              ) : (
                // With auto off nothing drains the queue, so "queue" would be a promise never kept.
                <span
                  className="text-xs text-fg-subtle"
                  title="The call-back queue is worked by the automatic modes. With auto off, finish or halt this contact first."
                >
                  auto is off — no queue
                </span>
              )}
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => void act("call", undefined, true)}
                title={`Halt the contact with ${qso?.theirCall ?? "the current station"} and call ${other} immediately. They are mid-exchange, so this leaves them hanging.`}
              >
                Call {other} now
              </Button>
            </>
          )}
          {active && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void act("qso-skip")}
              title="Give up on this station and move on — any automatic mode keeps running"
            >
              Skip contact
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>
      </div>

      {target && !active && (
        <>
          <div className="font-mono text-xs text-fg-muted">
            heard: {target.message} ({target.snr} dB @ {target.freqOffset} Hz)
          </div>
          {myCall && myGrid && target.callsign && (
            // The exchange the sequencer will run, on one line: the messages differ only at the end.
            <div className="font-mono text-xs">
              <span className="text-fg">
                → {target.callsign} {myCall} {myGrid.slice(0, 4)}
              </span>
              <span className="text-fg-subtle">
                {"  ·  R"}
                {target.snr < 0 ? target.snr : `+${target.snr}`}
                {"  ·  73"}
              </span>
            </div>
          )}
        </>
      )}
      {/* The whole exchange, both directions, left to right like a conversation. */}
      {(qso?.transcript?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap items-stretch gap-1">
          {qso!.transcript!.map((t, i) => (
            <div
              key={`${t.at}-${i}-${t.message}`}
              className={cn(
                "rounded-sm border px-1.5 py-0.5 font-mono text-xs leading-tight",
                t.refused
                  ? "border-danger/50 bg-danger/10 text-danger"
                  : t.dir === "tx"
                    ? "border-accent/40 bg-accent/10 text-accent-bright"
                    : "border-line text-fg",
              )}
              title={
                (t.refused ? `REFUSED: ${t.refused}\n` : "") +
                `${new Date(t.at).toISOString().slice(11, 19)}Z` +
                (t.snr != null ? ` · ${t.snr > 0 ? "+" : ""}${t.snr} dB` : "") +
                (t.offsetHz != null ? ` · ${t.offsetHz} Hz` : "")
              }
            >
              <div className="flex items-center gap-1">
                <span className={t.dir === "tx" ? "text-accent-bright" : "text-fg-subtle"}>
                  {t.dir === "tx" ? "▲" : "▼"}
                </span>
                <span>{t.message}</span>
              </div>
              <div className="text-fg-subtle tnum">
                {new Date(t.at).toISOString().slice(14, 19)}
                {t.snr != null && ` ${t.snr > 0 ? "+" : ""}${t.snr}`}
                {t.refused && " refused"}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {qso?.lastSent && <div className="font-mono text-xs text-accent-bright">sent: {qso.lastSent}</div>}
          {lastTx && lastTx !== qso?.lastSent && (
            <div className="font-mono text-xs text-fg-subtle">tx: {lastTx}</div>
          )}
        </>
      )}
      {error && <div className="text-danger text-xs">{error}</div>}
      {notice && <div className="text-accent-bright text-xs">{notice}</div>}
    </div>
  );
}

/**
 * Call a station that is not on the decode list. The offset opens on a clear slot rather
 * than 1500 Hz, the most contested frequency on the band, and can be re-picked because the
 * band moves.
 */
function ManualCall({
  busy,
  onCall,
  suggestSlot,
}: {
  busy: boolean;
  onCall: (call: string, offsetHz: number) => void;
  suggestSlot: () => ClearSlot;
}) {
  const [call, setCall] = useState("");
  const [slot, setSlot] = useState<ClearSlot>(() => suggestSlot());
  const [offset, setOffset] = useState(() => String(slot.hz));

  function findClear() {
    const next = suggestSlot();
    setSlot(next);
    setOffset(String(next.hz));
  }

  const trimmed = call.trim().toUpperCase();
  // Loose on purpose: portable and special-event calls are full of slashes and digits. The
  // bridge and the encoder validate properly; this only stops empty submits.
  const valid = /^[A-Z0-9/]{3,16}$/.test(trimmed);
  const offsetHz = Number(offset);
  // 2900, not 3000: most radios will not place audio above about 2.9 kHz.
  const offsetOk = Number.isFinite(offsetHz) && offsetHz >= 200 && offsetHz <= 2900;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && offsetOk && !busy) onCall(trimmed, Math.round(offsetHz));
      }}
    >
      <Input
        value={call}
        onChange={(e) => setCall(e.target.value.toUpperCase())}
        placeholder="W1AW"
        aria-label="Callsign to call"
        className="w-32 tnum"
      />
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        at
        <Input
          value={offset}
          onChange={(e) => setOffset(e.target.value)}
          inputMode="numeric"
          aria-label="Audio offset in hertz"
          className="w-20 tnum"
        />
        Hz
      </label>
      <Button
        onClick={findClear}
        disabled={busy}
        title="Pick the middle of the widest gap between the stations heard in the last two minutes."
      >
        Find clear slot
      </Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!valid || !offsetOk}>
        Call
      </Button>
      {/* What the number means. A full band is said, not hidden behind a confident pick. */}
      {String(slot.hz) === offset.trim() && (
        <span
          className={cn("text-xs", slot.crowded ? "text-warn" : "text-fg-subtle")}
          title={
            slot.crowded
              ? "Every gap is narrower than an FT8 signal — expect to share the frequency."
              : "Distance to the nearest station heard recently."
          }
        >
          {slot.crowded
            ? `band is full — only ${slot.clearanceHz} Hz clear`
            : `${slot.clearanceHz} Hz clear either side`}
        </span>
      )}
      {call !== "" && !valid && <span className="text-xs text-danger">Not a callsign</span>}
      {!offsetOk && <span className="text-xs text-danger">Offset must be 200–2900 Hz</span>}
    </form>
  );
}

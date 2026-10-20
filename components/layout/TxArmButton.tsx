import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { apiPost } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";
import { refreshStationGate, useStationGate } from "@/lib/client/use-station-gate";
import { gateRadioLabel } from "@/lib/radio/station-gate";
import { cn } from "@/lib/utils";

type Tone = "air" | "armed" | "off" | "held" | "idle";

const PILL: Record<Tone, string> = {
  air: "border-accent bg-accent text-accent-fg",
  armed: "border-accent bg-accent/15 text-accent-bright hover:bg-accent/25",
  off: "border-line text-fg-muted hover:text-fg hover:border-line-strong",
  held: "border-warn/50 bg-warn/10 text-warn",
  idle: "border-line text-fg-subtle",
};

const DOT: Record<Tone, string> = {
  air: "bg-accent-fg motion-safe:animate-pulse",
  armed: "bg-accent-bright",
  off: "bg-fg-subtle",
  held: "bg-warn",
  idle: "bg-line-strong",
};

/**
 * Arm or disarm transmit, from every page.
 *
 * The same per-radio gate as Settings → "Allow transmit", which used to be the only way
 * to change it. Arming asks first (admin only, as in Settings); disarming is one click for
 * any operator, because it only ever makes the station safer: the bridge halts the
 * contact in flight, pauses auto, and cancels a transmission waiting for its window.
 */
export function TxArmButton() {
  const gate = useStationGate();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelOpen = confirming || error !== null;

  useEffect(() => {
    if (!panelOpen) return;
    const close = () => {
      setConfirming(false);
      setError(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [panelOpen]);

  if (!user || !gate) return null;

  const isAdmin = user.role === "ADMIN";
  const canDisarm = user.role !== "VIEWER";
  const radio = gateRadioLabel(gate);
  const power = gate.rfPowerPct !== null ? ` at ${gate.rfPowerPct}% power` : "";

  const send = async (armed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/bridge/control", { action: "transmit-gate", armed });
      setConfirming(false);
    } catch (err) {
      setError(
        `${armed ? "Could not arm" : "Could not disarm"}: ${
          err instanceof Error ? err.message : "the radio service did not answer"
        }`,
      );
    } finally {
      setBusy(false);
      void refreshStationGate();
    }
  };

  let tone: Tone;
  let label: string;
  // The phone label. It used to be "TX" for armed, off and voice alike and "AIR" on the
  // air, which read as a truncated "ON AIR" and left armed and off told apart by colour
  // alone. Every state now has a word of its own, none longer than "ON AIR", so the pill
  // also stops changing width at every key-up; Shell.tsx tightens the header to fit it.
  let short: string;
  let title: string;
  let onClick: (() => void) | null = null;
  // While FT-0 is engaged the pill can only say "off" and cannot be pressed, and the
  // FT-0 badge beside it already says why. On a phone that badge and its "resume" need
  // the pill's width, so the pill steps aside there.
  let phoneHidden = false;

  if (!gate.running) {
    tone = "idle";
    label = "TX —";
    short = "TX —";
    title = "The radio service isn't running, so nothing can transmit.";
  } else if (gate.transmitting) {
    tone = "air";
    label = "ON AIR";
    short = "ON AIR";
    title = `Transmitting on ${radio}.${canDisarm ? " Click to disarm: stops this transmission now." : ""}`;
    if (canDisarm) onClick = () => void send(false);
  } else if (gate.armed) {
    tone = "armed";
    label = "TX ARMED";
    short = "ARMED";
    title =
      `Transmit is armed on ${radio}${power}.` +
      (canDisarm ? " Click to disarm: halts any contact in progress and pauses auto." : "");
    if (canDisarm) onClick = () => void send(false);
  } else if (gate.ft0) {
    tone = "off";
    label = "TX OFF";
    short = "TX OFF";
    title = "FT-0 is engaged. Resume the radio first, then arm transmit.";
    phoneHidden = true;
  } else if (gate.voice) {
    tone = "held";
    label = "TX · VOICE";
    short = "VOICE";
    title = gate.offReason ?? "Voice mode is holding transmit.";
  } else {
    tone = "off";
    label = "TX OFF";
    short = "TX OFF";
    title = isAdmin
      ? `Transmit is off on ${radio}. Click to arm.`
      : "Transmit is off. Only an admin can arm it.";
    if (isAdmin) onClick = () => setConfirming((v) => !v);
  }

  return (
    <div ref={wrapRef} className={cn("relative", phoneHidden && "hidden sm:block")}>
      <button
        type="button"
        onClick={onClick ?? undefined}
        disabled={!onClick || busy}
        aria-haspopup={tone === "off" && isAdmin ? "dialog" : undefined}
        aria-expanded={tone === "off" && isAdmin ? confirming : undefined}
        aria-label={title}
        title={title}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border px-1.5 sm:px-2 py-1 text-xs font-medium tracking-wide",
          // Never wraps on a phone: "ON AIR" broken over two lines in a squeezed header is
          // worse than the few pixels it would give back.
          "whitespace-nowrap sm:whitespace-normal",
          "transition-colors disabled:cursor-default",
          busy && "opacity-60",
          PILL[tone],
        )}
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[tone])} />
        <span className="sm:hidden">{short}</span>
        <span className="hidden sm:inline">{label}</span>
      </button>

      {panelOpen && (
        <div
          role={confirming ? "dialog" : "alert"}
          aria-label={confirming ? "Arm transmit" : undefined}
          className={cn(
            // On a phone the pill sits mid-header, so a right-anchored 288px panel ran off the
            // left edge; pin it to the screen width under the header instead.
            "fixed inset-x-4 top-[calc(3rem+env(safe-area-inset-top)+0.5rem)] z-40",
            "sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72",
            "rounded-md border border-line-strong bg-surface p-3 text-sm shadow-pop",
          )}
        >
          {confirming && (
            <>
              <p className="font-medium text-fg">Arm transmit on {radio}?</p>
              <p className="mt-1 text-xs text-fg-muted">
                {gate.rfPowerPct !== null ? `RF power is ${gate.rfPowerPct}%. ` : ""}
                Make sure an antenna or dummy load is connected. Auto resumes if a disarm here
                paused it.
              </p>
            </>
          )}
          {error && <p className={cn("text-xs text-danger", confirming && "mt-2")}>{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              {confirming ? "Cancel" : "Close"}
            </Button>
            {confirming && (
              <Button
                autoFocus
                size="sm"
                variant="danger-solid"
                loading={busy}
                onClick={() => void send(true)}
              >
                Arm transmit
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

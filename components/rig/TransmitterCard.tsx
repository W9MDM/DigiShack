import { useEffect, useRef, useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import { Button, Card } from "@/components/ui/primitives";

import { ChoiceButton, ControlGrid, ControlRow, InlineError, Readout } from "./controls";
import type { Telemetry } from "./types";

/** Keys that move a range input, so a keyboard change is committed like a drag release. */
const RANGE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * RF power, sent once on release rather than on every drag step — each change is a radio
 * command and a drag emits dozens.
 *
 * The released value is held until the radio reports it back, so the thumb does not jump
 * to the old setting for the moment between the command and the next status.
 */
function PowerControl({
  current,
  disabled,
  onCommit,
}: {
  current: number | null;
  disabled: boolean;
  onCommit: (percent: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const inFlight = useRef(false);

  // Released once the radio agrees, or after a few seconds if it reports something else —
  // its answer is the truth, not the thumb.
  useEffect(() => {
    if (sent === null) return;
    if (current === sent) {
      setSent(null);
      return;
    }
    const t = setTimeout(() => setSent(null), 4_000);
    return () => clearTimeout(t);
  }, [current, sent]);

  async function commit() {
    if (draft === null || inFlight.current) return;
    const value = draft;
    setDraft(null);
    if (value === current) return;
    inFlight.current = true;
    setSent(value);
    try {
      if (!(await onCommit(value))) setSent(null);
    } finally {
      inFlight.current = false;
    }
  }

  const shown = draft ?? sent ?? current;
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={shown ?? 1}
        disabled={disabled || current === null}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => void commit()}
        onKeyUp={(e) => {
          if (RANGE_KEYS.has(e.key)) void commit();
        }}
        onBlur={() => void commit()}
        aria-label="RF power"
        aria-valuetext={shown === null ? "not reported" : `${shown} percent`}
        className="min-w-0 flex-1 accent-accent disabled:opacity-50"
      />
      <span className="w-20 shrink-0 text-right text-sm tnum">
        {shown === null ? (
          <span className="text-fg-subtle">not reported</span>
        ) : (
          `${shown}%`
        )}
      </span>
    </div>
  );
}

function swrTone(swr: number): string {
  return swr > 3 ? "text-danger" : swr > 2 ? "text-warn" : "text-ok";
}

export function TransmitterCard({
  connected,
  rfPower,
  telemetry,
  transmitting,
  voiceOn,
  allowTransmit,
  transmitOffReason,
  txWarnings,
  canControl,
  busy,
  onVoice,
  onAtu,
  onPower,
  atuNote,
  error,
}: {
  connected: boolean;
  rfPower: number | null;
  telemetry: Telemetry | null;
  transmitting: boolean;
  voiceOn: boolean;
  /** Undefined from a radio service that does not report the gate. */
  allowTransmit: boolean | undefined;
  transmitOffReason: string | null;
  txWarnings: string[];
  canControl: boolean;
  busy: string | null;
  onVoice: (active: boolean) => void;
  onAtu: () => void;
  onPower: (percent: number) => Promise<boolean>;
  /** What the last tuner run reported, when it succeeded. */
  atuNote: string | null;
  error: string | null;
}) {
  // The Decodes page's freshness rule for SWR, kept identical so the two pages never
  // disagree about one meter. Nothing at all once the radio is gone: the bridge keeps its
  // last telemetry, and a disconnected radio's PA temperature is not a reading.
  const t = connected ? telemetry : null;
  const swrFresh = t !== null && (transmitting || Date.now() - t.at < 3_000);
  const swr = swrFresh && t.swr !== null && t.swr > 0 ? t.swr : null;
  const readouts: { label: string; value: string; tone?: string }[] = [];
  if (swr !== null) readouts.push({ label: "SWR", value: `${swr.toFixed(1)}:1`, tone: swrTone(swr) });
  if (t?.paTempC != null) {
    readouts.push({
      label: "PA",
      value: `${t.paTempC.toFixed(0)} °C`,
      tone: t.paTempC > 75 ? "text-danger" : t.paTempC > 60 ? "text-warn" : undefined,
    });
  }
  if (t?.voltsPa != null) {
    readouts.push({
      label: "Supply",
      value: `${t.voltsPa.toFixed(1)} V`,
      tone: t.voltsPa < 12 ? "text-warn" : undefined,
    });
  }
  if (t?.fanRpm != null && t.fanRpm > 0) {
    readouts.push({ label: "Fan", value: `${t.fanRpm} rpm` });
  }

  return (
    <Card title="Transmitter">
      <ControlGrid>
        <ControlRow
          label="Operating"
          help={
            <HelpTip label="About voice mode">
              Voice moves the radio out of the data mode that ignores the microphone, turns
              automatic operation off and closes digital transmit until you switch back.
              Switching back does not restart automatic operation.
            </HelpTip>
          }
        >
          <div role="group" aria-label="Operating mode" className="flex flex-wrap gap-1">
            <ChoiceButton
              selected={!voiceOn}
              disabled={!canControl || busy === "voice"}
              onClick={() => voiceOn && onVoice(false)}
              title={voiceOn ? "Back to digital operating" : "Digital operating"}
            >
              Digital
            </ChoiceButton>
            <ChoiceButton
              selected={voiceOn}
              tone="warn"
              disabled={!canControl || busy === "voice"}
              onClick={() => !voiceOn && onVoice(true)}
              title={voiceOn ? "Voice mode is on" : "Switch to voice"}
            >
              Voice
            </ChoiceButton>
          </div>
        </ControlRow>

        <ControlRow label="Power">
          <PowerControl
            current={rfPower}
            disabled={!canControl || busy === "power"}
            onCommit={onPower}
          />
        </ControlRow>

        <ControlRow label="Tuner">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              size="sm"
              disabled={!canControl}
              loading={busy === "atu"}
              onClick={onAtu}
              title="Run the antenna tuner. Keys a brief low-power carrier, so the radio service gates it on Allow transmit like anything else that keys."
            >
              Tune ATU
            </Button>
            {/* Informational only: the radio service decides, and refuses with its reason. */}
            <span className="text-xs text-fg-subtle">
              {allowTransmit === false ? (
                <span className="text-warn">
                  Refused while transmit is off
                  {transmitOffReason ? `: ${transmitOffReason}` : ""}
                </span>
              ) : (
                (atuNote ?? "Keys a brief low-power carrier")
              )}
            </span>
          </div>
        </ControlRow>

        <ControlRow
          label="Meters"
          help={
            <HelpTip label="About the meters" align="right">
              As the radio reports them; a meter the radio does not report is not shown, so
              the Icom shows SWR alone. SWR only means something while transmitting. Past
              3:1 or 75 °C the radio service stops unattended transmission.
            </HelpTip>
          }
        >
          {readouts.length > 0 ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {readouts.map((r) => (
                <Readout key={r.label} label={r.label} value={r.value} tone={r.tone} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">
              {connected ? "Nothing reported yet" : "Not connected"}
            </p>
          )}
        </ControlRow>
      </ControlGrid>

      {txWarnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-warn">
          {txWarnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {error && <InlineError>{error}</InlineError>}
    </Card>
  );
}

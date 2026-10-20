import type { ReactNode } from "react";

import { Badge, Select } from "@/components/ui/primitives";
import { formatFreqDial } from "@/lib/ham/bands";
import { MODULATIONS } from "@/lib/radio/modes";
import { cn } from "@/lib/utils";

import { InlineError } from "./controls";

/**
 * The dial: frequency, modulation and what the station is doing, read left to right.
 *
 * The modulation picker IS the modulation readout. There used to be a text readout here
 * and a separate picker in the control deck below — one fact shown twice, and on the
 * FlexRadio in two vocabularies (DIGU beside USB-D).
 */
export function RigDial({
  dialHz,
  pending,
  radioMode,
  decodingMode,
  transmitting,
  voiceOn,
  canSetMode,
  modeBusy,
  onMode,
  actions,
  children,
  error,
}: {
  dialHz: number | null;
  /** The arrow keys have moved the dial and the radio has not confirmed it yet. */
  pending: boolean;
  radioMode: string | null;
  /** What the decoder is listening for, when that says more than the modulation does. */
  decodingMode: string | null;
  transmitting: boolean;
  voiceOn: boolean;
  /** False when nothing here can change the radio — the picker becomes a readout. */
  canSetMode: boolean;
  modeBusy: boolean;
  onMode: (mode: string) => void;
  actions?: ReactNode;
  children?: ReactNode;
  error: string | null;
}) {
  // A modulation the radio reports but the picker does not offer (SAM, NFM) is shown as
  // itself rather than falling through to a blank, which reads as a broken control.
  const unlisted =
    radioMode !== null && !(MODULATIONS as readonly string[]).includes(radioMode);

  return (
    <section className="rounded-md border border-line bg-surface shadow-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-baseline gap-1.5">
          {/* The nudged reading while the arrow keys move it, so the number leads the
              radio instead of lagging a round trip; tinted until the radio confirms. */}
          <span
            className={cn(
              "font-display text-4xl leading-none tnum",
              pending && "text-accent-bright",
            )}
            title={pending ? "Tuning — the radio has not confirmed this yet" : undefined}
          >
            {dialHz ? formatFreqDial(dialHz) : "—"}
          </span>
          <span className="text-xs text-fg-subtle">MHz</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canSetMode ? (
            <Select
              id="rig-mode"
              aria-label="Modulation"
              value={radioMode ?? ""}
              disabled={modeBusy}
              onChange={(e) => onMode(e.target.value)}
              className="w-auto min-w-[6.5rem] py-1 font-medium tnum"
            >
              <option value="" disabled>
                not reported
              </option>
              {unlisted && (
                <option value={radioMode} disabled>
                  {radioMode}
                </option>
              )}
              {MODULATIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          ) : (
            radioMode && <span className="text-sm text-fg-muted tnum">{radioMode}</span>
          )}
          {decodingMode && (
            <Badge tone="neutral" className="tnum">
              <span title="What the decoder is listening for">{decodingMode}</span>
            </Badge>
          )}
          {transmitting && <Badge tone="danger">TX</Badge>}
          {voiceOn && <Badge tone="warn">Voice</Badge>}
        </div>

        {actions && (
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>

      {children}

      {error && (
        <div className="px-4 pb-3">
          <InlineError>{error}</InlineError>
        </div>
      )}
    </section>
  );
}

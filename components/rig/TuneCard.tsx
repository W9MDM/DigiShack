import { useMemo, useState } from "react";

import { tuneStepFor } from "@/components/digital/Panadapter";
import { Button, Card, Input } from "@/components/ui/primitives";
import { formatFreqMHz, getBand, parseFreqToHz } from "@/lib/ham/bands";
import { frequenciesForRegion, ituRegionFromGrid } from "@/lib/ham/digital-freqs";
import { canTune, type RadioCapabilities } from "@/lib/radio/capabilities";
import { modulationForFrequency } from "@/lib/radio/modes";

import { ChoiceButton, InlineError } from "./controls";
import type { RigSend } from "./types";

type BandTarget = "calling" | "centre";

/**
 * The bands this radio can reach, each with both places a band button can land.
 *
 * ONE list whichever target is chosen. The calling-frequency row used to list only bands
 * with an FT8 frequency and the band-centre row every ADIF band in range, so flipping the
 * choice made buttons appear and vanish — and the centre row offered 2190M, 630M and 560M,
 * which the radio service refuses below 1.8 MHz. Bands with an FT8 calling frequency in the
 * station's ITU region are the amateur HF/6 m bands an operator actually means, so that is
 * the list for both. The region keeps 4 m (Region 1 only) off a Region 2 station's Icom.
 *
 * FT8 lists two 6 m frequencies; the lower one wins and the exact figure is in the tooltip.
 */
function bandChoices(caps: RadioCapabilities, grid: string | null) {
  const byBand = new Map<string, number>();
  for (const f of frequenciesForRegion(ituRegionFromGrid(grid))) {
    if (f.mode !== "FT8" || !canTune(caps, f.hz)) continue;
    const seen = byBand.get(f.band);
    if (seen === undefined || f.hz < seen) byBand.set(f.band, f.hz);
  }
  return [...byBand].map(([band, callingHz]) => {
    const b = getBand(band);
    return {
      band,
      callingHz,
      centreHz: b ? Math.round((b.lowHz + b.highHz) / 2) : callingHz,
    };
  });
}

function stepLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

export function TuneCard({
  caps,
  grid,
  band,
  radioMode,
  canControl,
  busy,
  send,
  error,
}: {
  caps: RadioCapabilities;
  grid: string | null;
  /** The band the radio reports it is on. */
  band: string | null;
  radioMode: string | null;
  canControl: boolean;
  busy: string | null;
  send: RigSend;
  error: string | null;
}) {
  const [freqInput, setFreqInput] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [target, setTarget] = useState<BandTarget>("calling");
  const bands = useMemo(() => bandChoices(caps, grid), [caps, grid]);

  async function tuneTyped() {
    const hz = parseFreqToHz(freqInput);
    if (hz === null) {
      setTypedError(`"${freqInput}" is not a frequency I can read`);
      return;
    }
    if (!canTune(caps, hz)) {
      setTypedError(`${formatFreqMHz(hz)} MHz is outside what ${caps.label} can tune`);
      return;
    }
    setTypedError(null);
    // The modulation goes with the dial: 7.200 left in USB-D hears nothing an operator
    // wants, and 14.074 left in LSB is the same in reverse. Null is a frequency in no
    // amateur band, and then only the dial moves, so a typo does not also change the mode.
    const modulation = modulationForFrequency(hz);
    const ok = await send(
      modulation ? { freqHz: hz, mode: modulation } : { freqHz: hz },
      "freq",
      "tune",
    );
    // Kept on a refusal, so the operator can correct what they typed rather than retype it.
    if (ok) setFreqInput("");
  }

  const step = tuneStepFor(radioMode);

  return (
    <Card title="Tune" className="h-full">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void tuneTyped();
        }}
      >
        <Input
          id="rig-freq"
          aria-label="Frequency"
          value={freqInput}
          onChange={(e) => setFreqInput(e.target.value)}
          placeholder="14.074 or 14074000"
          autoComplete="off"
          inputMode="decimal"
          className="flex-1 min-w-0"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!canControl || freqInput.trim() === ""}
          loading={busy === "freq"}
        >
          Tune
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <span id="rig-bands-label" className="text-sm text-fg-muted">
          Bands
        </span>
        <div role="group" aria-label="Band buttons go to" className="flex gap-1">
          {(
            [
              ["calling", "FT8 calling", "Each band button goes to its FT8 calling frequency."],
              ["centre", "Band centre", "Each band button goes to the middle of the band."],
            ] as const
          ).map(([value, label, hint]) => (
            <ChoiceButton
              key={value}
              selected={target === value}
              onClick={() => setTarget(value)}
              title={hint}
            >
              {label}
            </ChoiceButton>
          ))}
        </div>
      </div>
      {/* Four even columns of taller buttons on a phone, rather than a ragged wrap that
          left 6M alone on its own row. From `sm` up they wrap as before. */}
      <div
        role="group"
        aria-labelledby="rig-bands-label"
        className="mt-2 grid grid-cols-4 gap-1 sm:flex sm:flex-wrap"
      >
        {bands.map((b) => {
          const hz = target === "calling" ? b.callingHz : b.centreHz;
          const label = `band-${b.band}`;
          return (
            <ChoiceButton
              key={b.band}
              selected={band === b.band}
              disabled={!canControl || busy === label}
              onClick={() => void send({ freqHz: hz }, label, "tune")}
              title={`${b.band} — ${formatFreqMHz(hz)} MHz`}
              className="min-w-[3rem] py-2 sm:py-1"
            >
              {b.band}
            </ChoiceButton>
          );
        })}
      </div>

      {/* The step the arrow keys and a spectrum click both move by: the question an
          operator has is not "can I tune" but "by how much". */}
      <p className="mt-3 text-xs text-fg-subtle tnum">
        Arrow keys tune by {stepLabel(step)}
        {radioMode ? ` in ${radioMode}` : ""}, Shift ×10.
        {caps.panadapter && " Clicking the spectrum snaps to the same step."}
      </p>

      {(typedError ?? error) && <InlineError>{typedError ?? error}</InlineError>}
    </Card>
  );
}

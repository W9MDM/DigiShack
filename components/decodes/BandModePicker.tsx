// Band and mode buttons: each retunes the radio to that band's calling frequency for the
// mode, through the bridge. Limited to the listed frequencies on purpose — a free-form box
// is a good way to end up outside a band edge or on top of another mode.
//
// The antenna tuner sits beside the bands because a new band is when it is needed.

import { useId, useMemo, useState } from "react";

import { ToggleButton } from "@/components/decodes/controls";
import { Button } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import { DIGITAL_FREQUENCIES, frequenciesForRegion, type DigitalMode } from "@/lib/ham/digital-freqs";
import { cn } from "@/lib/utils";

const MODES = [
  "FT8",
  "FT4",
  "FT2",
  "WSPR",
  "RTTY",
  "CW",
  "JS8",
  "PSK31",
  "OLIVIA",
  "SSTV",
  "HELL",
  "JTTY",
] as const satisfies readonly DigitalMode[];

export function BandModePicker({
  currentBand,
  decodingAs,
  region,
  onTuned,
}: {
  currentBand: string | null;
  decodingAs: DigitalMode;
  /** ITU region from the station grid; bands that do not exist there are not offered. */
  region: 1 | 2 | 3 | null;
  onTuned: () => void;
}) {
  /** "band/mode" while a retune is in flight, "atu" while the tuner is asked to run. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Phones only: the rows fold behind the current band and mode. */
  const [open, setOpen] = useState(false);
  const rowsId = useId();

  // Every band this region has a frequency for in ANY mode, so the row keeps its length and
  // does not reflow when the mode changes; a band with nothing for this mode is disabled.
  // Deduped, because 6 m lists two FT8 frequencies.
  const bands = useMemo(() => [...new Set(frequenciesForRegion(region).map((f) => f.band))], [region]);
  const bandsWithMode = useMemo(
    () =>
      new Set(
        frequenciesForRegion(region)
          .filter((f) => f.mode === decodingAs)
          .map((f) => f.band),
      ),
    [decodingAs, region],
  );

  // A mode switch is a retune: the modes live on different frequencies and the bridge
  // follows the dial. A band with no listed frequency for a mode cannot switch to it.
  const bandFor = (m: DigitalMode): string | null =>
    currentBand !== null && DIGITAL_FREQUENCIES.some((f) => f.mode === m && f.band === currentBand)
      ? currentBand
      : null;

  async function tune(band: string, mode: DigitalMode) {
    setBusy(`${band}/${mode}`);
    setError(null);
    try {
      // Through the bridge, which owns the radio and knows which one it is.
      await apiPost("/api/bridge/control", { action: "tune", band, mode });
      // The decodes on screen belong to the old band.
      onTuned();
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not retune the radio");
    } finally {
      setBusy(null);
    }
  }

  async function tuneAtu() {
    setBusy("atu");
    setError(null);
    try {
      await apiPost("/api/bridge/control", { action: "atu" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the tuner");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1 sm:items-end">
      {/* Below `sm` the two rows are a third of the screen above the decode list, so they
          fold behind one button naming where the radio is. */}
      <Button
        size="sm"
        className="sm:hidden self-start tnum"
        aria-expanded={open}
        aria-controls={rowsId}
        onClick={() => setOpen((o) => !o)}
      >
        {currentBand ?? "Band"} · {decodingAs}
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </Button>

      <div id={rowsId} className={cn(open ? "flex" : "hidden", "sm:flex flex-col gap-1")}>
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Band">
            {bands.map((band) => {
              const hasMode = bandsWithMode.has(band);
              return (
                <ToggleButton
                  key={band}
                  pressed={currentBand === band}
                  className={cn("tnum", !hasMode && "border-line/50 text-fg-subtle")}
                  disabled={busy !== null || !hasMode}
                  onClick={() => hasMode && void tune(band, decodingAs)}
                  title={
                    hasMode
                      ? `Tune to ${band} — moves the TX slice to the ${decodingAs} calling frequency`
                      : `${band} has no listed ${decodingAs} frequency`
                  }
                >
                  {busy === `${band}/${decodingAs}` ? "…" : band}
                </ToggleButton>
              );
            })}
          </div>
          <Button
            size="sm"
            loading={busy === "atu"}
            disabled={busy !== null}
            onClick={() => void tuneAtu()}
            title="Run the antenna tuner (keys a brief low-power carrier)"
          >
            Tune ATU
          </Button>
        </div>

        <div className="flex flex-wrap gap-1" role="group" aria-label="Digital mode">
          {MODES.map((m) => {
            const active = decodingAs === m;
            const target = bandFor(m);
            const canSwitch = active || target !== null;
            return (
              <ToggleButton
                key={m}
                pressed={active}
                className={cn("tnum", !canSwitch && "border-line/50 text-fg-subtle")}
                disabled={busy !== null || active || !canSwitch}
                onClick={() => target && void tune(target, m)}
                title={
                  active
                    ? `Decoding ${m}`
                    : canSwitch
                      ? `Retune ${target} to its ${m} frequency`
                      : `${currentBand ?? "This band"} has no listed ${m} frequency`
                }
              >
                {m}
              </ToggleButton>
            );
          })}
        </div>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

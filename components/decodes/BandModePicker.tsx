// Band and mode: two dropdowns that retune the radio to that band's calling frequency for
// the mode, through the bridge. Limited to the listed frequencies on purpose — a free-form box
// is a good way to end up outside a band edge or on top of another mode.
//
// They were 26 buttons in two rows; the dropdowns keep the same rules (a band with no
// frequency for this mode, or a mode with none on this band, is listed but disabled).
//
// The antenna tuner sits beside the bands because a new band is when it is needed.

import { useMemo, useState } from "react";

import { Button, Select } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import { DIGITAL_FREQUENCIES, frequenciesForRegion, type DigitalMode } from "@/lib/ham/digital-freqs";

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
  /** "tune" while a retune is in flight, "atu" while the tuner is asked to run. */
  const [busy, setBusy] = useState<"tune" | "atu" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every band this region has a frequency for in ANY mode, so the list keeps its shape when
  // the mode changes; a band with nothing for this mode is disabled. Deduped (6 m lists two).
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
    setBusy("tune");
    setError(null);
    try {
      // Through the bridge, which owns the radio and knows which one it is.
      await apiPost("/api/bridge/control", { action: "tune", band, mode });
      // The decodes on screen belong to the old band.
      onTuned();
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

  // An off-list dial (a band the picker does not offer) still shows where the radio is.
  const bandValue = currentBand ?? "";
  const bandListed = currentBand !== null && bands.includes(currentBand);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          aria-label="Band"
          title="Tune to a band — moves the TX slice to this mode's calling frequency there"
          className="w-24 py-1 text-sm tnum"
          value={bandValue}
          disabled={busy !== null}
          onChange={(e) => {
            const band = e.target.value;
            if (band && band !== currentBand && bandsWithMode.has(band)) void tune(band, decodingAs);
          }}
        >
          {!bandListed && <option value={bandValue}>{currentBand ?? "Band"}</option>}
          {bands.map((band) => (
            <option key={band} value={band} disabled={!bandsWithMode.has(band)}>
              {band}
              {bandsWithMode.has(band) ? "" : ` (no ${decodingAs})`}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Digital mode"
          title="Change mode — retunes this band to that mode's calling frequency"
          className="w-28 py-1 text-sm"
          value={decodingAs}
          disabled={busy !== null}
          onChange={(e) => {
            const m = e.target.value as DigitalMode;
            const target = bandFor(m);
            if (m !== decodingAs && target) void tune(target, m);
          }}
        >
          {MODES.map((m) => {
            const canSwitch = m === decodingAs || bandFor(m) !== null;
            return (
              <option key={m} value={m} disabled={!canSwitch}>
                {m}
                {canSwitch ? "" : " (not on this band)"}
              </option>
            );
          })}
        </Select>
        <Button
          size="sm"
          loading={busy === "atu"}
          disabled={busy !== null}
          onClick={() => void tuneAtu()}
          title="Run the antenna tuner (keys a brief low-power carrier)"
        >
          Tune ATU
        </Button>
        {busy === "tune" && <span className="text-xs text-fg-subtle">tuning…</span>}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

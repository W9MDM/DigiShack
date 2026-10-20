import { useId, useState } from "react";

import { Field, Input, Select } from "@/components/ui/primitives";
import { Readout, Readouts, ToolSection } from "@/components/tools/shared";
import { fmt, METRES_PER_FOOT } from "@/lib/ham/tools/number";
import { bandForMHz, parseWave, WAVE_UNITS, type WaveUnit } from "@/lib/ham/tools/wave";

/** MHz with enough decimals to mean something at any scale. */
function mhzText(mhz: number): string {
  return fmt(mhz, mhz >= 1000 ? 1 : mhz >= 1 ? 4 : 6);
}

export function WavelengthTool() {
  const ids = useId();
  const [text, setText] = useState("14.2");
  const [unit, setUnit] = useState<WaveUnit>("MHz");
  const w = parseWave(text, unit);
  const band = w.ok ? bandForMHz(w.value.mhz) : null;

  return (
    <ToolSection id="wavelength" title="Wavelength and frequency">
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Frequency or wavelength" htmlFor={`${ids}-v`} errors={w.ok ? undefined : [w.error]}>
          <Input id={`${ids}-v`} value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
        </Field>
        <Field label="Unit" htmlFor={`${ids}-u`}>
          <Select id={`${ids}-u`} value={unit} onChange={(e) => setUnit(e.target.value as WaveUnit)}>
            {WAVE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {w.ok && (
        <Readouts className="mt-3">
          <Readout label="Frequency" value={`${mhzText(w.value.mhz)} MHz`} sub={`${fmt(w.value.mhz * 1000, 1)} kHz`} />
          <Readout
            label="Wavelength"
            value={`${fmt(w.value.metres, w.value.metres >= 100 ? 1 : 3)} m`}
            sub={`${fmt(w.value.metres / METRES_PER_FOOT, 2)} ft · ${fmt(w.value.metres * 100, 1)} cm`}
          />
          <Readout label="Amateur band" value={band ?? "none"} />
        </Readouts>
      )}
      <p className="mt-2 text-xs text-fg-subtle">λ = c / f, with c = 299,792,458 m/s. Free space; see Feedline for a line.</p>
    </ToolSection>
  );
}

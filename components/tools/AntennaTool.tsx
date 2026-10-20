import { useId, useState } from "react";

import { Field, Input, Td, Th } from "@/components/ui/primitives";
import { HelpTip } from "@/components/ui/HelpTip";
import { Footnote, Problem, ToolSection } from "@/components/tools/shared";
import {
  antennaLengths,
  classicDipoleFt,
  DEFAULT_END_EFFECT,
  parseEndEffect,
  RULE_468_FACTOR,
} from "@/lib/ham/tools/antenna";
import { feetInches, fmt, METRES_PER_FOOT } from "@/lib/ham/tools/number";
import { parseMHz } from "@/lib/ham/tools/wave";

export function Length({ m }: { m: number }) {
  const ft = m / METRES_PER_FOOT;
  return (
    <>
      <Td size="sm" className="tnum text-right whitespace-nowrap">
        {fmt(ft, 2)} ft
        <span className="block text-[0.8em] text-fg-subtle">{feetInches(ft)}</span>
      </Td>
      <Td size="sm" className="tnum text-right whitespace-nowrap align-top">
        {fmt(m, 3)} m
      </Td>
    </>
  );
}

export function AntennaTool() {
  const ids = useId();
  const [freqText, setFreqText] = useState("14.2");
  const [kText, setKText] = useState(String(DEFAULT_END_EFFECT));
  const f = parseMHz(freqText);
  const k = parseEndEffect(kText);

  const rows = (() => {
    if (!f.ok || !k.ok) return null;
    const a = antennaLengths(f.value, k.value);
    return {
      a,
      list: [
        { name: "Half-wave dipole, total", m: a.dipoleTotalM },
        { name: "Half-wave dipole, each leg", m: a.dipoleLegM },
        { name: "Quarter-wave vertical, radiator", m: a.quarterRadiatorM },
        { name: "Quarter-wave vertical, each elevated radial", m: a.quarterRadialM },
        { name: "Full-wave loop, perimeter (1005/f)", m: a.loopPerimeterM },
        { name: "Full-wave loop, side of a square", m: a.loopSquareSideM },
        { name: "Full-wave loop, side of a triangle", m: a.loopDeltaSideM },
        { name: "5/8-wave vertical, radiator", m: a.fiveEighthsM },
      ],
    };
  })();

  return (
    <ToolSection id="antenna" title="Antenna lengths">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Frequency (MHz)" htmlFor={`${ids}-f`} errors={f.ok ? undefined : [f.error]}>
          <Input id={`${ids}-f`} value={freqText} onChange={(e) => setFreqText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
        </Field>
        <Field label="End-effect factor" htmlFor={`${ids}-k`} errors={k.ok ? undefined : [k.error]} hint="0.95 for bare wire; less for thick or insulated wire">
          <Input id={`${ids}-k`} value={kText} onChange={(e) => setKText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
        </Field>
      </div>
      {!rows ? (
        <Problem>Fix the inputs above to see lengths.</Problem>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <Th size="sm">Element</Th>
                  <Th size="sm" className="text-right">Feet</Th>
                  <Th size="sm" className="text-right">Metres</Th>
                </tr>
              </thead>
              <tbody>
                {rows.list.map((r) => (
                  <tr key={r.name} className="border-t border-line/60 align-top">
                    <Td size="sm" className="text-fg-muted">{r.name}</Td>
                    <Length m={r.m} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-fg-muted tnum">
            Free-space wavelength {fmt(rows.a.wavelengthM, 3)} m ({fmt(rows.a.wavelengthM / METRES_PER_FOOT, 2)} ft).
            The 468/f rule gives {fmt(classicDipoleFt(f.ok ? f.value : 1), 2)} ft — the same dipole with a factor of{" "}
            {fmt(RULE_468_FACTOR, 4)}.
            <HelpTip label="Why the factor" className="ml-1">
              A wire resonates a little shorter than the wavelength it is cut for, because of the
              capacitance at its open ends. A loop has no ends, so it uses 1005/f — about 1.02 λ —
              and ignores the factor.
            </HelpTip>
          </p>
          <Footnote>
            Cut long and trim to resonance: height, nearby objects and wire insulation all move it.
            On-ground radials are detuned by the soil, so their length is not critical; more of
            them matters more than their length. A 5/8-wave vertical needs a matching coil at the base.
          </Footnote>
        </>
      )}
    </ToolSection>
  );
}

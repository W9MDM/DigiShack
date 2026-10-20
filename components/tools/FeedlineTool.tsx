import { useId, useState } from "react";

import { Field, Input, Select, Td, Th } from "@/components/ui/primitives";
import { Length } from "@/components/tools/AntennaTool";
import { Footnote, Problem, ToolSection } from "@/components/tools/shared";
import { lineLengths, parseVelocityFactor, VF_PRESETS } from "@/lib/ham/tools/feedline";
import { parseMHz } from "@/lib/ham/tools/wave";

export function FeedlineTool() {
  const ids = useId();
  const [freqText, setFreqText] = useState("14.2");
  const [vfText, setVfText] = useState("0.66");
  const f = parseMHz(freqText);
  const vf = parseVelocityFactor(vfText);
  const preset = VF_PRESETS.find((p) => String(p.vf) === vfText.trim() || p.vf === Number(vfText));
  const l = f.ok && vf.ok ? lineLengths(f.value, vf.value) : null;

  return (
    <ToolSection id="feedline" title="Feedline">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Frequency (MHz)" htmlFor={`${ids}-f`} errors={f.ok ? undefined : [f.error]}>
          <Input id={`${ids}-f`} value={freqText} onChange={(e) => setFreqText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
        </Field>
        <Field label="Line" htmlFor={`${ids}-p`}>
          <Select
            id={`${ids}-p`}
            value={preset?.id ?? "custom"}
            onChange={(e) => {
              const p = VF_PRESETS.find((x) => x.id === e.target.value);
              if (p) setVfText(String(p.vf));
            }}
          >
            {VF_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom — type it below</option>
          </Select>
        </Field>
        <Field
          label="Velocity factor"
          htmlFor={`${ids}-vf`}
          errors={vf.ok ? undefined : [vf.error]}
          hint="From the manufacturer's data sheet if you have it"
        >
          <Input id={`${ids}-vf`} value={vfText} onChange={(e) => setVfText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
        </Field>
      </div>
      {!l ? (
        <Problem>Fix the inputs above to see lengths.</Problem>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <Th size="sm">Length</Th>
                <Th size="sm" className="text-right">Feet</Th>
                <Th size="sm" className="text-right">Metres</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line/60 align-top">
                <Td size="sm" className="text-fg-muted">Electrical λ/4</Td>
                <Length m={l.quarterM} />
              </tr>
              <tr className="border-t border-line/60 align-top">
                <Td size="sm" className="text-fg-muted">Electrical λ/2</Td>
                <Length m={l.halfM} />
              </tr>
              <tr className="border-t border-line/60 align-top">
                <Td size="sm" className="text-fg-subtle">Free-space λ/4, for comparison</Td>
                <Length m={l.freeSpaceM / 4} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <Footnote>
        Presets are typical figures; foam coax alone runs from about 0.78 to 0.88 by maker. A
        half wave repeats the load impedance at the other end and a quarter wave inverts it,
        so a stub that has to be right is cut long and trimmed against an analyser.
      </Footnote>
    </ToolSection>
  );
}

import { useId, useState } from "react";

import { Field, Input } from "@/components/ui/primitives";
import { Footnote, Readout, Readouts, Segmented, ToolSection } from "@/components/tools/shared";
import { fmt, formatWatts, parseNumber } from "@/lib/ham/tools/number";
import { mismatchFromPower, parseSwr, type Mismatch } from "@/lib/ham/tools/swr";

function MismatchReadouts({ m, showSwr }: { m: Mismatch; showSwr: boolean }) {
  return (
    <Readouts className="mt-3">
      {showSwr && <Readout label="SWR" value={`${fmt(m.swr, 2)}:1`} />}
      <Readout label="Reflection coefficient |Γ|" value={fmt(m.gamma, 3)} />
      <Readout label="Return loss" value={m.returnLossDb === null ? "no reflection" : `${fmt(m.returnLossDb, 2)} dB`} />
      <Readout label="Mismatch loss" value={`${fmt(m.mismatchLossDb, 3)} dB`} />
      <Readout label="Power reflected" value={`${fmt(m.reflectedPct, 1)} %`} sub={`${fmt(m.deliveredPct, 1)} % reaches the load`} />
    </Readouts>
  );
}

export function SwrTool() {
  const ids = useId();
  const [mode, setMode] = useState<"swr" | "power">("swr");
  const [swrText, setSwrText] = useState("1.5");
  const [fwdText, setFwdText] = useState("100");
  const [refText, setRefText] = useState("4");

  const fromSwr = parseSwr(swrText);
  const fwd = parseNumber(fwdText, { label: "Forward power", unit: "W", min: 0, exclusiveMin: true });
  const ref = parseNumber(refText, { label: "Reflected power", unit: "W", min: 0 });
  const fromPower = fwd.ok && ref.ok ? mismatchFromPower(fwd.value, ref.value) : null;

  return (
    <ToolSection id="swr" title="SWR and mismatch">
      <Segmented
        label="Start from"
        options={[
          { value: "swr", label: "From SWR" },
          { value: "power", label: "From forward and reflected power" },
        ]}
        value={mode}
        onChange={setMode}
        className="mb-3"
      />
      {mode === "swr" ? (
        <>
          <Field label="SWR" htmlFor={`${ids}-swr`} errors={fromSwr.ok ? undefined : [fromSwr.error]} hint="1.5 or 1.5:1">
            <Input id={`${ids}-swr`} value={swrText} onChange={(e) => setSwrText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
          </Field>
          {fromSwr.ok && <MismatchReadouts m={fromSwr.value} showSwr={false} />}
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Forward (W)" htmlFor={`${ids}-fwd`} errors={fwd.ok ? undefined : [fwd.error]}>
              <Input id={`${ids}-fwd`} value={fwdText} onChange={(e) => setFwdText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
            </Field>
            <Field label="Reflected (W)" htmlFor={`${ids}-ref`} errors={ref.ok ? undefined : [ref.error]}>
              <Input id={`${ids}-ref`} value={refText} onChange={(e) => setRefText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
            </Field>
          </div>
          {fromPower && !fromPower.ok && (
            <p role="alert" className="mt-2 text-sm text-danger">{fromPower.error}</p>
          )}
          {fromPower?.ok && (
            <>
              <MismatchReadouts m={fromPower.value} showSwr />
              <Readouts>
                <Readout label="Delivered" value={formatWatts(fromPower.value.deliveredW)} />
              </Readouts>
            </>
          )}
        </>
      )}
      <Footnote>
        Mismatch loss is what the mismatch alone costs at the load. It is not feedline loss — a
        lossy line makes the SWR at the radio look better than it is at the antenna.
      </Footnote>
    </ToolSection>
  );
}

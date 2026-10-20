import { useId, useState } from "react";

import { Button, Field, Input, Select, Td, Th } from "@/components/ui/primitives";
import { Footnote, Readout, Readouts, Segmented, SubHead, ToolSection } from "@/components/tools/shared";
import { fmt, fmtSigned, formatVolts, formatWatts, parseNumber } from "@/lib/ham/tools/number";
import {
  applyChain,
  dbmToMicrovolts,
  dbmToSLabel,
  microvoltsToDbm,
  parsePower,
  parseSReading,
  POWER_UNITS,
  S9_DBM,
  S_TABLE,
  sReadingLabel,
  sReadingToDbm,
  type PowerLevel,
  type PowerUnit,
  type SMeterScale,
} from "@/lib/ham/tools/power";

function LevelReadouts({ level }: { level: PowerLevel }) {
  return (
    <Readouts>
      <Readout label="Watts" value={formatWatts(level.watts)} />
      <Readout label="dBm" value={fmt(level.dbm, 1)} />
      <Readout label="dBW" value={fmt(level.dbw, 1)} />
    </Readouts>
  );
}

function Convert() {
  const ids = useId();
  const [text, setText] = useState("100");
  const [unit, setUnit] = useState<PowerUnit>("W");
  const p = parsePower(text, unit);
  return (
    <section className="min-w-0">
      <SubHead>Watts, dBm and dBW</SubHead>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Power" htmlFor={`${ids}-v`} errors={p.ok ? undefined : [p.error]}>
          <Input id={`${ids}-v`} value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
        </Field>
        <Field label="Unit" htmlFor={`${ids}-u`}>
          <Select id={`${ids}-u`} value={unit} onChange={(e) => setUnit(e.target.value as PowerUnit)}>
            {POWER_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {p.ok && (
        <div className="mt-2">
          <LevelReadouts level={p.value} />
        </div>
      )}
    </section>
  );
}

interface StageText {
  key: number;
  label: string;
  db: string;
}

function Chain() {
  const ids = useId();
  const [startText, setStartText] = useState("100");
  const [stages, setStages] = useState<StageText[]>([
    { key: 1, label: "Coax loss", db: "-1.5" },
    { key: 2, label: "Antenna gain (dBd)", db: "6" },
  ]);
  const [nextKey, setNextKey] = useState(3);
  const start = parsePower(startText, "W");
  const parsed = stages.map((s) => ({ s, r: parseNumber(s.db, { label: "Gain", min: -200, max: 200 }) }));
  const bad = parsed.find((x) => !x.r.ok);
  const result =
    start.ok && !bad
      ? applyChain(
          start.value,
          parsed.map((x) => ({ label: x.s.label, db: x.r.ok ? x.r.value : 0 })),
        )
      : null;

  const update = (key: number, patch: Partial<StageText>) =>
    setStages((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  return (
    <section className="min-w-0">
      <SubHead>Gain and loss</SubHead>
      <Field label="Transmitter (W)" htmlFor={`${ids}-start`} errors={start.ok ? undefined : [start.error]}>
        <Input id={`${ids}-start`} value={startText} onChange={(e) => setStartText(e.target.value)} inputMode="decimal" autoComplete="off" className="tnum" />
      </Field>
      <ul className="mt-2 flex flex-col gap-2">
        {parsed.map(({ s, r }, i) => (
          <li key={s.key} className="grid grid-cols-[1fr_5rem_auto] gap-2 items-start">
            <Input
              aria-label={`Stage ${i + 1} name`}
              value={s.label}
              onChange={(e) => update(s.key, { label: e.target.value })}
            />
            <Input
              aria-label={`Stage ${i + 1} gain in dB, negative for a loss`}
              aria-invalid={!r.ok || undefined}
              value={s.db}
              onChange={(e) => update(s.key, { db: e.target.value })}
              inputMode="decimal"
              className="tnum"
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${s.label || `stage ${i + 1}`}`}
              onClick={() => setStages((list) => list.filter((x) => x.key !== s.key))}
              className="mt-0.5"
            >
              ✕
            </Button>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        className="mt-2"
        onClick={() => {
          setStages((list) => [...list, { key: nextKey, label: "", db: "0" }]);
          setNextKey((k) => k + 1);
        }}
      >
        Add a stage
      </Button>
      {bad && !bad.r.ok && <p role="alert" className="mt-2 text-sm text-danger">{bad.s.label || "A stage"}: {bad.r.error}</p>}
      {result && (
        <Readouts className="mt-2">
          <Readout label="Total" value={`${fmtSigned(result.totalDb, 1)} dB`} />
          <Readout label="Out" value={formatWatts(result.out.watts)} sub={`${fmt(result.out.dbm, 1)} dBm · ${fmt(result.out.dbw, 1)} dBW`} />
        </Readouts>
      )}
      <p className="mt-2 text-xs text-fg-subtle">
        Gains positive, losses negative. Ending on antenna gain in dBd gives ERP; add 2.15 dB for EIRP.
      </p>
    </section>
  );
}

type SUnit = "S" | "dBm" | "µV";

function SMeter() {
  const ids = useId();
  const [scale, setScale] = useState<SMeterScale>("hf");
  const [unit, setUnit] = useState<SUnit>("S");
  const [text, setText] = useState("S9");

  let dbm: number | null = null;
  let error: string | null = null;
  if (unit === "S") {
    const r = parseSReading(text);
    if (r.ok) dbm = sReadingToDbm(r.value, scale);
    else error = r.error;
  } else if (unit === "dBm") {
    const r = parseNumber(text, { label: "Level", unit: "dBm", min: -200, max: 50 });
    if (r.ok) dbm = r.value;
    else error = r.error;
  } else {
    const r = parseNumber(text, { label: "Voltage", unit: "µV", min: 0, exclusiveMin: true, max: 1e9 });
    if (r.ok) dbm = microvoltsToDbm(r.value);
    else error = r.error;
  }

  return (
    <section className="min-w-0">
      <SubHead>S-meter</SubHead>
      <Segmented
        label="S-meter scale"
        options={[
          { value: "hf", label: "HF: S9 = −73 dBm" },
          { value: "vhf", label: "Above 30 MHz: S9 = −93 dBm" },
        ]}
        value={scale}
        onChange={setScale}
        className="mb-2"
      />
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Reading" htmlFor={`${ids}-v`} errors={error ? [error] : undefined}>
          <Input id={`${ids}-v`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" className="tnum" />
        </Field>
        <Field label="As" htmlFor={`${ids}-u`}>
          <Select id={`${ids}-u`} value={unit} onChange={(e) => setUnit(e.target.value as SUnit)}>
            <option value="S">S units</option>
            <option value="dBm">dBm</option>
            <option value="µV">µV</option>
          </Select>
        </Field>
      </div>
      {dbm !== null && (
        <Readouts className="mt-2">
          <Readout label="S reading" value={dbmToSLabel(dbm, scale)} />
          <Readout label="Level" value={`${fmt(dbm, 1)} dBm`} sub={formatWatts(10 ** ((dbm - 30) / 10))} />
          <Readout label="Into 50 Ω" value={formatVolts(dbmToMicrovolts(dbm) * 1e-6)} />
        </Readouts>
      )}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">The whole scale</summary>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-left">
                <Th size="sm">Reading</Th>
                <Th size="sm" className="text-right">dBm</Th>
                <Th size="sm" className="text-right">50 Ω</Th>
              </tr>
            </thead>
            <tbody>
              {S_TABLE.map((r) => {
                const d = sReadingToDbm(r, scale);
                return (
                  <tr key={sReadingLabel(r)} className="border-t border-line/60">
                    <Td size="sm">{sReadingLabel(r)}</Td>
                    <Td size="sm" className="tnum text-right">{fmt(d, 0)}</Td>
                    <Td size="sm" className="tnum text-right">{formatVolts(dbmToMicrovolts(d) * 1e-6)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
      <p className="mt-2 text-xs text-fg-subtle">
        IARU Region 1 R.1: S9 is {S9_DBM.hf} dBm below 30 MHz and {S9_DBM.vhf} dBm above, 6 dB a
        unit. Few receivers are calibrated to it — a meter reading is an indication, not a measurement.
      </p>
    </section>
  );
}

export function PowerTool() {
  return (
    <ToolSection id="power" title="Power and dB" wide>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Convert />
        <Chain />
        <SMeter />
      </div>
      <Footnote>dBm is decibels relative to a milliwatt, dBW to a watt: 0 dBW is 30 dBm is 1 W.</Footnote>
    </ToolSection>
  );
}

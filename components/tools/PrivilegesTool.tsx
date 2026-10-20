import { useId, useMemo, useState } from "react";

import { Badge, Field, Input, Select, Td, Th } from "@/components/ui/primitives";
import { Footnote, Problem, SubHead, ToolSection } from "@/components/tools/shared";
import type { Emission, LicenseClass } from "@/lib/ham/band-plan";
import { formatFreqMHz, parseFreqToHz } from "@/lib/ham/bands";
import {
  bandChart,
  CLASS_NAMES,
  CLASS_ORDER,
  describeEmissions,
  lookupFrequency,
  verdict,
  type ChartSegment,
} from "@/lib/ham/tools/privileges";
import { cn } from "@/lib/utils";

export interface LicenceDefault {
  cls: LicenseClass | null;
  status: "set" | "unset" | "other";
}

const COLUMNS: readonly { e: Emission; label: string }[] = [
  { e: "CW", label: "CW" },
  { e: "DATA", label: "Data" },
  { e: "PHONE", label: "Phone" },
  { e: "IMAGE", label: "Image" },
];

/** The panadapter's band-plan colours, so the two displays agree. */
function fillFor(s: ChartSegment): string {
  if (s.emissions.length === 0) return "bg-surface-3";
  if (s.emissions.includes("PHONE")) return "bg-accent/60";
  if (s.emissions.includes("DATA")) return "bg-ok/50";
  return "bg-warn/50";
}

function Yes({ on, note }: { on: boolean; note?: string | null }) {
  if (!on) {
    return (
      <>
        <span aria-hidden className="text-fg-subtle">—</span>
        <span className="sr-only">no</span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden className="text-ok">✓</span>
      <span className="sr-only">yes</span>
      {note && <span className="block text-[0.8em] text-fg-subtle whitespace-nowrap">{note}</span>}
    </>
  );
}

export function PrivilegesTool({ licence }: { licence: LicenceDefault }) {
  const ids = useId();
  const [freqText, setFreqText] = useState("14.074");
  // Unset defaults to the narrowest common class, the safe direction for "may I transmit";
  // "other" (licensed outside the US) to Extra, the whole US allocation.
  const [cls, setCls] = useState<LicenseClass>(licence.cls ?? (licence.status === "other" ? "E" : "T"));

  const hz = freqText.trim() ? parseFreqToHz(freqText) : null;
  const answer = hz !== null ? lookupFrequency(hz) : null;
  const v = answer ? verdict(answer, cls) : null;
  const chart = useMemo(() => bandChart(cls), [cls]);

  const classHint =
    licence.status === "set"
      ? "Yours, from Settings. Change it here to see another class."
      : licence.status === "other"
        ? "Your licence is set to outside the US: these are US Part 97 rules, shown here for an Extra."
        : "No licence class is set in Settings (General), so this starts at Technician. Pick yours.";

  return (
    <ToolSection id="privileges" title="Where can I operate?" wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
        <Field
          label="Frequency"
          htmlFor={`${ids}-f`}
          errors={freqText.trim() && hz === null ? ["Could not read that frequency — write MHz with a decimal point, e.g. 14.074"] : undefined}
          hint="MHz (14.074), kHz (7074) or Hz all work"
        >
          <Input
            id={`${ids}-f`}
            value={freqText}
            onChange={(e) => setFreqText(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            className="tnum"
          />
        </Field>
        <Field label="Licence class" htmlFor={`${ids}-c`} hint={classHint}>
          <Select id={`${ids}-c`} value={cls} onChange={(e) => setCls(e.target.value as LicenseClass)}>
            {CLASS_ORDER.map((c) => (
              <option key={c} value={c}>
                {CLASS_NAMES[c]}
                {licence.cls === c ? " (yours)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {!answer || !v ? (
        <Problem>Type a frequency to see who may transmit there, in what mode, and how much power.</Problem>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge tone={v.allowed ? "ok" : "danger"}>{v.allowed ? "Permitted" : "Not permitted"}</Badge>
            <p className="text-sm text-fg">{v.text}</p>
          </div>
          <p className="text-sm text-fg-muted tnum">
            {formatFreqMHz(answer.hz)} MHz
            {answer.band && ` · ${answer.band}`}
            {answer.range && ` · ${answer.range}`}
            {answer.label && ` · ${answer.label}`}
          </p>
          {answer.segment && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <Th size="sm">Class</Th>
                    {COLUMNS.map((c) => (
                      <Th key={c.e} size="sm" className="text-center">
                        {c.label}
                      </Th>
                    ))}
                    <Th size="sm">Power</Th>
                  </tr>
                </thead>
                <tbody>
                  {answer.classes.map((row) => (
                    <tr
                      key={row.cls}
                      className={cn("border-t border-line/60", row.cls === cls && "bg-accent/10")}
                    >
                      <Td size="sm" className="whitespace-nowrap">
                        {CLASS_NAMES[row.cls]}
                        {row.cls === cls && <span className="sr-only"> (selected)</span>}
                      </Td>
                      {COLUMNS.map((c) => (
                        <Td key={c.e} size="sm" className="text-center">
                          <Yes on={row.emissions.includes(c.e)} note={c.e === "PHONE" ? row.phoneNote : null} />
                        </Td>
                      ))}
                      <Td size="sm" className="tnum whitespace-nowrap text-fg-muted">
                        {row.power ? (
                          <>
                            {row.power.label}
                            <span className="block text-[0.8em] text-fg-subtle">{row.power.cite}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {answer.notes.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-fg-muted flex flex-col gap-1">
              {answer.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-6">
        <SubHead>Privileges by band — {CLASS_NAMES[cls]}</SubHead>
        <div className="flex flex-wrap gap-3 text-xs text-fg-muted mb-3" aria-hidden>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-accent/60" />Phone</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-ok/50" />CW and data</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-warn/50" />CW only</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-surface-3" />Not yours</span>
        </div>
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">
          {chart.map((row) => {
            const span = row.highHz - row.lowHz;
            return (
              <li key={row.band} className="grid grid-cols-[3.5rem_1fr] gap-x-3 items-start">
                <span className={cn("font-display text-sm tnum", row.ranges.length ? "text-fg" : "text-fg-subtle")}>
                  {row.band}
                </span>
                <div className="min-w-0">
                  <div className="relative h-3 rounded-sm bg-bg border border-line overflow-hidden" aria-hidden>
                    {row.segments.map((s) => (
                      <div
                        key={s.startHz}
                        className={cn("absolute inset-y-0 border-r border-bg", fillFor(s))}
                        style={{
                          left: `${((s.startHz - row.lowHz) / span) * 100}%`,
                          width: `${Math.max(((s.endHz - s.startHz) / span) * 100, 0.8)}%`,
                        }}
                      />
                    ))}
                  </div>
                  {row.ranges.length === 0 ? (
                    <p className="mt-1 text-xs text-fg-subtle">No privileges</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-fg-muted">
                      {row.ranges.map((r) => (
                        <li key={r.startHz} className="tnum">
                          <span className="text-fg">{r.text}</span>
                          {" · "}
                          {describeEmissions({ cls, emissions: r.emissions, phoneNote: r.phoneNote, power: r.power })}
                          {r.power.label !== "1,500 W PEP" && <span className="text-warn"> · {r.power.label}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <Footnote>
        US Part 97 only — §97.301 (who), §97.305(c) and §97.307(f) (which emissions), §97.313
        (power) — as in force from 13 February 2026, when FCC 25-60 rewrote 60 m. Power is
        1,500 W PEP unless shown, and always the least that does the job (§97.313(a)). The
        mainland edges: Hawaii, most of Alaska and Puerto Rico have extra 40 m phone. This is a
        reading of the rules, not a transmit interlock; the licensee decides where to key.
      </Footnote>
    </ToolSection>
  );
}

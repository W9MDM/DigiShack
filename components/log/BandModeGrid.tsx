import { Badge, Td, Th } from "@/components/ui/primitives";
import { BAND_NAMES } from "@/lib/ham/bands";
import { formatUtc } from "@/lib/time";
import { cn } from "@/lib/utils";

export interface BandModeSlice {
  band: string;
  mode: string;
  qsos: number;
  confirmed: boolean;
  lastWorked: string;
}

/** Bands in frequency order (unknown names last); modes by how often they were used. */
export function pivotSlices(slices: BandModeSlice[]): {
  bands: string[];
  modes: string[];
  cell: (band: string, mode: string) => BandModeSlice | undefined;
} {
  const byKey = new Map(slices.map((s) => [`${s.band}|${s.mode}`, s]));
  const rank = (b: string) => {
    const i = BAND_NAMES.indexOf(b.toUpperCase());
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const bands = [...new Set(slices.map((s) => s.band))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  const modeCount = new Map<string, number>();
  for (const s of slices) modeCount.set(s.mode, (modeCount.get(s.mode) ?? 0) + s.qsos);
  const modes = [...modeCount.keys()].sort(
    (a, b) => (modeCount.get(b) ?? 0) - (modeCount.get(a) ?? 0) || a.localeCompare(b),
  );
  return { bands, modes, cell: (band, mode) => byKey.get(`${band}|${mode}`) };
}

/**
 * Worked / confirmed per band and mode — the unit awards are counted in. A tick and green is
 * confirmed; a plain count is worked and still waiting for a QSL.
 */
export function BandModeGrid({ slices }: { slices: BandModeSlice[] }) {
  const { bands, modes, cell } = pivotSlices(slices);
  // A phone card with one to three modes left the grid in its left third. There it spans
  // the card, the band column held at 4rem and the modes sharing the rest. More modes
  // than that fill the width anyway; from sm up it stays its natural width.
  const stretch = modes.length <= 3;
  return (
    <div className="overflow-x-auto">
      <table className={cn("border-collapse text-sm", stretch && "max-sm:w-full")}>
        <thead>
          <tr className="text-left">
            <Th size="sm" className={stretch ? "max-sm:w-16" : undefined}>
              <span className="sr-only">Band</span>
            </Th>
            {modes.map((m) => (
              <Th key={m} size="sm" className="text-center">
                {m}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {bands.map((b) => (
            <tr key={b}>
              <Td size="sm" role="rowheader" className="font-medium text-fg-muted tnum">
                {b}
              </Td>
              {modes.map((m) => {
                const s = cell(b, m);
                return (
                  <Td key={m} size="sm" className="text-center">
                    {s ? (
                      <span title={`${b} ${m} — last worked ${formatUtc(s.lastWorked)}`}>
                        <span aria-hidden="true">
                          <Badge size="sm" tone={s.confirmed ? "ok" : "neutral"} className="tnum">
                            {s.confirmed ? `✓ ${s.qsos}` : s.qsos}
                          </Badge>
                        </span>
                        <span className="sr-only">
                          {s.qsos} contact{s.qsos === 1 ? "" : "s"},{" "}
                          {s.confirmed ? "confirmed" : "not confirmed"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-fg-subtle">
                        <span aria-hidden="true">·</span>
                        <span className="sr-only">not worked</span>
                      </span>
                    )}
                  </Td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

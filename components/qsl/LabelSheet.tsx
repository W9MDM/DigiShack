import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  labelDensity,
  labelsPerSheet,
  PRINT_ROOT_CLASS,
  sheetGeometry,
  type LabelDensity,
  type LabelStock,
} from "@/components/qsl/label-stock";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc } from "@/lib/time";
import { cn } from "@/lib/utils";

/** The contact fields a label prints. */
export interface LabelQso {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: string;
  freqHz: number | null;
  rstSent: string | null;
  rstRcvd: string | null;
  gridSquare: string | null;
  station: { callsign: string; grid: string } | null;
}

function LabelBody({ qso, density }: { qso: LabelQso; density: LabelDensity }) {
  const when = formatUtc(qso.startTime);
  const freq = qso.freqHz && qso.freqHz > 0 ? `${formatFreqMHz(qso.freqHz)} MHz` : null;
  const from = qso.station?.callsign ?? "";

  // A one-inch label holds four short lines, so the grid and the received report go.
  if (density === "compact") {
    return (
      <>
        <div className="qsl-call">{qso.callsign}</div>
        <div>
          {when} · {qso.band} {qso.mode}
        </div>
        <div>{[freq, `RST ${qso.rstSent ?? "—"}`].filter(Boolean).join(" · ")}</div>
        <div>Cfm QSO {from} · TNX 73</div>
      </>
    );
  }

  return (
    <>
      <div className="qsl-call">{qso.callsign}</div>
      <div>{when}</div>
      <div>
        {qso.band} · {qso.mode}
        {freq ? ` · ${freq}` : ""}
      </div>
      <div>
        RST sent {qso.rstSent ?? "—"}
        {qso.rstRcvd ? ` · rcvd ${qso.rstRcvd}` : ""}
      </div>
      {qso.gridSquare && <div>Grid {qso.gridSquare}</div>}
      <div className="qsl-rule">
        Confirming QSO with {from}
        {qso.station?.grid ? ` (${qso.station.grid})` : ""} · TNX 73
      </div>
    </>
  );
}

/** Contacts laid onto sheets, with `skip` blank positions first for a part-used sheet. */
export function sheetsFor(
  stock: LabelStock,
  qsos: LabelQso[],
  skip: number,
): (LabelQso | null)[][] {
  const per = labelsPerSheet(stock);
  const slots: (LabelQso | null)[] = [
    ...Array.from({ length: Math.max(0, Math.min(skip, per - 1)) }, () => null),
    ...qsos,
  ];
  const sheets: (LabelQso | null)[][] = [];
  for (let i = 0; i < slots.length; i += per) sheets.push(slots.slice(i, i + per));
  return sheets;
}

export function LabelSheets({
  stock,
  sheets,
  guides,
  forPrint,
  className,
}: {
  stock: LabelStock;
  sheets: (LabelQso | null)[][];
  guides: boolean;
  forPrint: boolean;
  className?: string;
}) {
  const density = labelDensity(stock);
  const geometry = sheetGeometry(stock, forPrint);
  return (
    <>
      {sheets.map((slots, i) => (
        <div
          key={i}
          className={cn("qsl-sheet", guides && "qsl-guides", className)}
          data-density={density}
          style={geometry}
        >
          {slots.map((q, j) =>
            q ? (
              <div key={q.id} className="qsl-label">
                <LabelBody qso={q} density={density} />
              </div>
            ) : (
              <div key={`skip-${j}`} className="qsl-label" aria-hidden="true" />
            ),
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The copy that actually prints, as a direct child of <body>.
 *
 * The print stylesheet hides every other child of <body>, which takes the app's header,
 * nav and this page's own controls with it without having to know their names.
 */
export function PrintCopy({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(<div className={PRINT_ROOT_CLASS}>{children}</div>, document.body);
}

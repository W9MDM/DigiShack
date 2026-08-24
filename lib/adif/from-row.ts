import type { AdifQsoInput } from "@/lib/adif/write";

// One place that turns a Qso row into the shape the writers want.
//
// This mapping existed twice — in the ADIF export route and in the upload runner — and CSV
// export would have made three. Three copies is where it stops being duplication and becomes a
// hazard: a field added to the model and to two of them is a field silently missing from the
// third, and the symptom is an export or an upload that is quietly incomplete rather than a
// build error.
//
// `QSO_INCLUDE` travels with the mapper for the same reason. The mapper needs the station,
// operator and SIG references joined, and a caller that forgets one gets a type error here
// rather than nulls in an export.

export const QSO_INCLUDE = {
  station: { select: { callsign: true, grid: true } },
  operator: { select: { callsign: true } },
  sigRefs: { select: { sigInfo: true, primary: true } },
} as const;

/** The row shape `toAdifInput` needs. Structural, so any query selecting these fields fits. */
export interface QsoRowForAdif {
  callsign: string;
  band: string;
  freqHz: bigint | number;
  mode: string;
  startTime: Date;
  endTime: Date | null;
  rstSent: string | null;
  rstRcvd: string | null;
  gridSquare: string | null;
  txPowerW: number | null;
  name: string | null;
  qth: string | null;
  dxcc: number | null;
  state: string | null;
  county: string | null;
  cqZone: number | null;
  ituZone: number | null;
  iota: string | null;
  continent: string | null;
  sig: string | null;
  sigInfo: string | null;
  sigRefs: { sigInfo: string; primary: boolean }[];
  qslSent: string;
  qslRcvd: string;
  qslSentAt: Date | null;
  qslRcvdAt: Date | null;
  qslSentVia?: string | null;
  qslRcvdVia?: string | null;
  lotwSent: boolean;
  lotwRcvd: boolean;
  eqslSent: boolean;
  eqslRcvd: boolean;
  emailQslSent?: boolean;
  notes: string | null;
  station: { callsign: string; grid: string | null };
  operator: { callsign: string } | null;
}

export function toAdifInput(q: QsoRowForAdif): AdifQsoInput {
  return {
    callsign: q.callsign,
    band: q.band,
    freqHz: q.freqHz,
    mode: q.mode,
    startTime: q.startTime,
    endTime: q.endTime,
    rstSent: q.rstSent,
    rstRcvd: q.rstRcvd,
    gridSquare: q.gridSquare,
    txPowerW: q.txPowerW,
    name: q.name,
    qth: q.qth,
    dxcc: q.dxcc,
    state: q.state,
    county: q.county,
    cqZone: q.cqZone,
    ituZone: q.ituZone,
    iota: q.iota,
    continent: q.continent,
    sig: q.sig,
    sigInfo: q.sigInfo,
    // Primary first, so the APP_ field's order matches SIG_INFO.
    sigRefs: [...q.sigRefs]
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      .map((r) => r.sigInfo),
    qslSent: q.qslSent as AdifQsoInput["qslSent"],
    qslRcvd: q.qslRcvd as AdifQsoInput["qslRcvd"],
    qslSentAt: q.qslSentAt,
    qslRcvdAt: q.qslRcvdAt,
    qslSentVia: q.qslSentVia ?? null,
    qslRcvdVia: q.qslRcvdVia ?? null,
    lotwSent: q.lotwSent,
    lotwRcvd: q.lotwRcvd,
    eqslSent: q.eqslSent,
    eqslRcvd: q.eqslRcvd,
    emailQslSent: q.emailQslSent ?? false,
    notes: q.notes,
    station: q.station,
    operator: q.operator,
  };
}

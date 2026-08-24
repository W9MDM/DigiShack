import {
  adifToQslRoute,
  qslRouteToAdif,
  ADIF_VERSION,
  boolToAdif,
  qslRcvdToAdif,
  qslSentToAdif,
  toAdifDate,
  toAdifMode,
  toAdifTime,
  type QslStatus,
} from "@/lib/adif/fields";

// ADIF 3.x writer.
//
// Format: each field is `<NAME:byteLength>value`, a record ends with `<EOR>`, and
// the header ends with `<EOH>`. The length is a BYTE count, not a character
// count — which matters for any non-ASCII in a name or comment field, so
// Buffer.byteLength is used rather than String.length.

function field(name: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.length === 0) return "";
  return `<${name.toUpperCase()}:${Buffer.byteLength(s, "utf8")}>${s}`;
}

export interface AdifQsoInput {
  callsign: string;
  band: string;
  freqHz: bigint | number;
  mode: string;
  startTime: Date;
  endTime: Date | null;
  rstSent: string | null;
  rstRcvd: string | null;
  gridSquare: string | null;
  dxcc: number | null;
  /** ADIF NAME. */
  name?: string | null;
  /** ADIF QTH — free text, distinct from the grid and from STATE. */
  qth?: string | null;
  /** ADIF TX_PWR — transmit power in watts, measured for this contact. */
  txPowerW?: number | null;
  state: string | null;
  county: string | null;
  cqZone: number | null;
  ituZone: number | null;
  iota: string | null;
  continent: string | null;
  /** ADIF SIG — special activity programme, e.g. "POTA". */
  sig: string | null;
  /** ADIF SIG_INFO — the PRIMARY reference, e.g. "US-1689". */
  sigInfo: string | null;
  /**
   * Every reference on the contact, primary included.
   *
   * A park contact can legitimately be several parks — nested and overlapping
   * parks are common. ADIF has no repeated fields and no multi-value SIG_INFO, so
   * the primary goes in the standard field and the full set in an APP_ field.
   */
  sigRefs?: string[];
  qslSent: QslStatus;
  /** ADIF QSL_SENT_VIA — BUREAU | DIRECT | ELECTRONIC | MANAGER. */
  qslSentVia?: string | null;
  qslRcvdVia?: string | null;
  qslRcvd: QslStatus;
  qslSentAt: Date | null;
  qslRcvdAt: Date | null;
  lotwSent: boolean;
  lotwRcvd: boolean;
  eqslSent: boolean;
  /** An emailed card image — not a paper QSL. Exported as an APP_ field. */
  emailQslSent?: boolean;
  eqslRcvd: boolean;
  notes: string | null;
  /** Which radio made it. Exported as MY_RIG. */
  radio?: string | null;
  station: { callsign: string; grid: string | null };
  operator: { callsign: string } | null;
}

export interface AdifHeaderOptions {
  programVersion: string;
  /** Free text on the first line, before the header fields. */
  comment?: string;
  createdAt?: Date;
}

export function adifHeader(opts: AdifHeaderOptions): string {
  const created = opts.createdAt ?? new Date();
  const lines = [
    opts.comment ?? "ADIF export from DigiShack",
    field("ADIF_VER", ADIF_VERSION),
    field("PROGRAMID", "DigiShack"),
    field("PROGRAMVERSION", opts.programVersion),
    field(
      "CREATED_TIMESTAMP",
      `${toAdifDate(created)} ${toAdifTime(created)}`,
    ),
    "<EOH>",
    "",
  ];
  return lines.join("\n");
}

export function adifRecord(q: AdifQsoInput): string {
  const { mode, submode } = toAdifMode(q.mode);
  const freqMHz = (Number(q.freqHz) / 1_000_000).toFixed(6);

  const parts = [
    field("CALL", q.callsign),
    field("QSO_DATE", toAdifDate(q.startTime)),
    field("TIME_ON", toAdifTime(q.startTime)),
    // QSO_DATE_OFF is only written when the QSO spans a UTC midnight, which is
    // what the standard intends it for.
    q.endTime && toAdifDate(q.endTime) !== toAdifDate(q.startTime)
      ? field("QSO_DATE_OFF", toAdifDate(q.endTime))
      : "",
    q.endTime ? field("TIME_OFF", toAdifTime(q.endTime)) : "",
    field("BAND", q.band),
    field("FREQ", freqMHz),
    field("MODE", mode),
    submode ? field("SUBMODE", submode) : "",
    field("RST_SENT", q.rstSent),
    field("RST_RCVD", q.rstRcvd),
    field("GRIDSQUARE", q.gridSquare),
    field("NAME", q.name ?? null),
    field("QTH", q.qth ?? null),
    // ADIF TX_PWR is watts. Emitted only when the radio actually measured it —
    // a station constant belongs in the operator's own template, not in a field
    // that claims to describe this contact.
    q.txPowerW != null ? field("TX_PWR", String(q.txPowerW)) : "",
    q.dxcc !== null ? field("DXCC", String(q.dxcc)) : "",
    field("STATE", q.state),
    field("CNTY", q.county),
    q.cqZone !== null ? field("CQZ", String(q.cqZone)) : "",
    q.ituZone !== null ? field("ITUZ", String(q.ituZone)) : "",
    field("IOTA", q.iota),
    field("CONT", q.continent),
    // Special activity — POTA, SOTA, WWFF. Standard fields, so a park contact
    // exported from here is a park contact everywhere else, including POTA's own
    // hunter log upload.
    field("SIG", q.sig),
    field("SIG_INFO", q.sigInfo),
    // ADIF cannot express a contact that is two parks at once: there is one
    // SIG_INFO and no repeated fields. Rather than pick one and lose the rest, or
    // emit a comma list that other programs would read as a single odd reference,
    // the extras go in the APP_ space the spec reserves for exactly this. Written
    // only when there IS more than one, so an ordinary contact is unchanged.
    (q.sigRefs?.length ?? 0) > 1
      ? field("APP_DIGISHACK_SIGREFS", q.sigRefs!.join(","))
      : "",
    field("QSL_SENT", qslSentToAdif(q.qslSent)),
    field("QSL_RCVD", qslRcvdToAdif(q.qslRcvd)),
    q.qslSentAt ? field("QSLSDATE", toAdifDate(q.qslSentAt)) : "",
    q.qslRcvdAt ? field("QSLRDATE", toAdifDate(q.qslRcvdAt)) : "",
    field("QSL_SENT_VIA", qslRouteToAdif(q.qslSentVia)),
    field("QSL_RCVD_VIA", qslRouteToAdif(q.qslRcvdVia)),
    field("LOTW_QSL_SENT", boolToAdif(q.lotwSent)),
    field("LOTW_QSL_RCVD", boolToAdif(q.lotwRcvd)),
    field("EQSL_QSL_SENT", boolToAdif(q.eqslSent)),
    field("EQSL_QSL_RCVD", boolToAdif(q.eqslRcvd)),
    // ADIF has no standard field for "I emailed a card image", so this uses the
    // APP_<PROGRAMID>_<FIELD> form the spec reserves for exactly that. It must NOT
    // be folded into QSL_SENT: that means a paper card, and a program importing
    // this file would otherwise believe a card is in the post.
    q.emailQslSent ? field("APP_DIGISHACK_EMAILQSLSENT", "Y") : "",
    // ADIF MY_RIG is free text describing our own radio, which is exactly what this
    // is. The column is `radio` rather than `rig` because `Rig` is a different thing
    // in this schema — see the note on Qso.radio.
    field("MY_RIG", q.radio ?? null),
    field("STATION_CALLSIGN", q.station.callsign),
    field("MY_GRIDSQUARE", q.station.grid),
    // ADIF OPERATOR is the person at the key, which is exactly what
    // Qso.operator records.
    q.operator ? field("OPERATOR", q.operator.callsign) : "",
    // Newlines would corrupt the record, and ADIF has no escape for them.
    field("COMMENT", q.notes?.replace(/[\r\n]+/g, " ") ?? null),
    "<EOR>",
  ];

  return parts.filter(Boolean).join(" ") + "\n";
}

/** Convenience for small exports; large ones should stream record by record. */
export function buildAdif(
  qsos: AdifQsoInput[],
  opts: AdifHeaderOptions,
): string {
  return adifHeader(opts) + qsos.map(adifRecord).join("");
}

/** `digishack-20260731-194200.adi` */
export function adifFilename(now = new Date()): string {
  return `digishack-${toAdifDate(now)}-${toAdifTime(now)}.adi`;
}

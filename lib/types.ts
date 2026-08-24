// Wire shapes — what the API actually returns, as opposed to Prisma's model
// types. Two differences matter:
//
//   * `freqHz` is a number, not BigInt (see lib/api/respond.ts for why).
//   * Dates are ISO-8601 strings, because they went through JSON.
//
// Using Prisma's generated types directly in components would be wrong on both
// counts, so these are declared by hand.

export type QslStatus = "NONE" | "REQUESTED" | "SENT" | "CONFIRMED";
export type Role = "ADMIN" | "OPERATOR" | "VIEWER";
export interface StationRef {
  id: string;
  callsign: string;
  grid?: string;
}

export interface OperatorRef {
  id: string;
  name: string;
  callsign: string;
}

export interface Qso {
  id: string;
  callsign: string;
  band: string;
  freqHz: number;
  mode: string;
  startTime: string;
  endTime: string | null;
  rstSent: string | null;
  rstRcvd: string | null;
  gridSquare: string | null;
  dxcc: number | null;
  /** ADIF NAME — the operator's name. */
  name: string | null;
  /** ADIF QTH — free text location, distinct from the grid. */
  qth: string | null;
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
  /** Every reference on this contact — a nested-park contact has several. */
  sigRefs?: { sigInfo: string; primary: boolean }[];
  qslSent: QslStatus;
  qslRcvd: QslStatus;
  qslSentAt: string | null;
  qslRcvdAt: string | null;
  lotwSent: boolean;
  lotwRcvd: boolean;
  /** QRZ Logbook has it. Set by the QRZ sync as well as by our own uploads. */
  qrzSent: boolean;
  /** QRZ reports both operators logged it. Not a LoTW confirmation, and not DXCC credit. */
  qrzRcvd: boolean;
  eqslSent: boolean;
  /**
   * A card image was EMAILED. Distinct from `qslSent`, which means paper.
   *
   * Someone who sends a card and wants one back still needs a card, so these two
   * cannot share a field or a badge.
   */
  emailQslSent: boolean;
  emailQslSentAt: string | null;
  eqslRcvd: boolean;
  /**
   * Which radio made the contact — "FLEX-6400", "IC-7300MK2". ADIF MY_RIG.
   *
   * What the radio called itself over the air interface, so it cannot disagree with
   * reality and needs no setting up.
   */
  radio: string | null;
  /**
   * ADIF TX_PWR — measured transmit power in watts.
   *
   * The radio's own forward-power meter, not the power slider. Null on contacts
   * made before this was recorded, and on radios without a meter.
   */
  txPowerW: number | null;
  notes: string | null;
  /**
   * The full digital exchange, one message per line.
   *
   * Native FT8/FT4 contacts only — a manual entry, an ADIF import or a contact logged
   * through an external decoder never saw the messages, so null there means "not
   * recorded", not "nothing was said".
   */
  transcript: string | null;
  stationId: string;
  operatorId: string | null;
  station: StationRef;
  operator: OperatorRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface PskSpot {
  id: string;
  receiverCall: string;
  receiverGrid: string | null;
  snr: number | null;
  freqHz: number;
  reportedAt: string;
}

export interface DigitalDecode {
  id: string;
  timestamp: string;
  freqOffset: number;
  snr: number;
  message: string;
  mode: string;
  band: string;
}

/** The QSL email record for a QSO — who it went to and what happened. */
export interface QslEmailRecord {
  id: string;
  toAddress: string;
  subject: string;
  status: "PENDING" | "APPROVED" | "SENT" | "FAILED" | "SKIPPED";
  error: string | null;
  approvedAt: string | null;
  /** null for an automatic approval — there genuinely was no approver. */
  approvedById: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface QsoDetail extends Qso {
  spots: PskSpot[];
  decodes: DigitalDecode[];
  qslEmails: QslEmailRecord[];
}

export interface Operator extends OperatorRef {
  stationId: string;
  role: Role;
  station?: StationRef;
  _count?: { qsos: number };
}

export interface Station {
  id: string;
  callsign: string;
  grid: string;
  operators: Operator[];
  _count?: { qsos: number };
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  callsign: string | null;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Live session count — how many devices are currently signed in. */
  _count?: { sessions: number };
}

export interface ListResponse<T> {
  rows: T[];
  total: number;
  take?: number;
  skip?: number;
}

export interface StatsSummary {
  total: number;
  confirmed: number;
  /** QSOs since 00:00 UTC — the day the log runs on, not the local one. */
  today: number;
  /** The whole UTC day before this one, bounded at both ends. */
  yesterday: number;
  /** Rolling seven days. */
  week: number;
  /** Worked today and never before — see lib/stats/summary.ts. */
  newCallsToday: number;
  newParksToday: number;
  newDxccToday: number;
  newGridsToday: number;
  unconfirmed: number;
  uniqueCallsigns: number;
  uniqueGrids: number;
  uniqueDxcc: number;
  stationCount: number;
  byBand: { band: string; count: number }[];
  byMode: { mode: string; count: number }[];
  latest: Qso[];
}

export interface DupeCheckResponse {
  duplicate: boolean;
  previous: {
    id: string;
    startTime: string;
    rstSent: string | null;
    rstRcvd: string | null;
  } | null;
}

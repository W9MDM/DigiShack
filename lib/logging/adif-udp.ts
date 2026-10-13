// Announcing a logged contact over UDP, the way WSJT-X does.
//
// WHY THIS EXISTS. Everything in amateur radio that wants to know "a contact just happened"
// listens for one thing: the datagram WSJT-X sends when "Enable logged contact ADIF
// broadcast" is ticked. GridTracker, Log4OM, JTAlert, N1MM and the live scoring sites all
// consume it, and none of them has any other way in. Emitting the same datagram means all
// of them work with DigiShack without any of them having to know DigiShack exists.
//
// SO THIS IMITATES WSJT-X ON PURPOSE. A DigiShack-shaped message carrying the same facts
// would be useless — the entire value is in being indistinguishable to a receiver that was
// written for WSJT-X and will never be changed for us.
//
// OFF BY DEFAULT, and that is not timidity. This takes the station's log — callsigns, grids,
// times, the operator's own callsign — and sprays it onto a LAN as cleartext UDP to an
// address somebody types into a settings box. That is fine when it is pointed at a logger on
// the desk and worth a deliberate decision when it is not, so nothing is sent until an
// operator turns it on and says where.
//
// FIRE AND FORGET, deliberately. UDP has no delivery guarantee and a logging side-channel
// must never be able to fail a contact: the QSO is in the database before this is called,
// and if the datagram is lost the log is still right. Errors are logged once and swallowed.

import dgram from "node:dgram";

import { field } from "@/lib/adif/write";
import { toAdifMode } from "@/lib/adif/fields";
import {
  normaliseHost,
  parseExtraFields,
  type ExtraField,
} from "@/lib/logging/broadcast-fields";
import { toAdifInput, type QsoRowForAdif } from "@/lib/adif/from-row";
import { prisma } from "@/lib/db/prisma";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";
import { encodeLoggedADIF } from "@/lib/wsjtx/protocol";

/**
 * The id WSJT-X puts in the datagram, and what receivers key their "station" on.
 *
 * Defaults to "WSJT-X" because some receivers match on it literally before they will accept
 * the message at all. An operator running several instances can change it, but the default
 * has to be the one that works everywhere.
 */
const DEFAULT_ID = "WSJT-X";

/** One socket for the process. Opening one per contact would be a file descriptor per QSO. */
let socket: dgram.Socket | null = null;
/** So a misconfigured destination complains once rather than on every contact. */
let lastErrorAt = 0;

function sock(): dgram.Socket {
  if (socket) return socket;
  const s = dgram.createSocket("udp4");
  // An unhandled 'error' on a dgram socket is an uncaught exception, which on this process
  // would take the radio down with it. A bad destination must cost a log line, nothing more.
  s.on("error", (err) => {
    const now = Date.now();
    if (now - lastErrorAt > 60_000) {
      lastErrorAt = now;
      console.warn(`[udp-log] socket error: ${err.message}`);
    }
  });
  s.unref();
  socket = s;
  return s;
}

/**
 * The ADIF document for one contact.
 *
 * A FULL DOCUMENT, not a bare record. WSJT-X sends header, `<EOH>`, then the record, and
 * receivers differ in how much they tolerate — some parse the record alone, some want the
 * header. Sending what WSJT-X sends is the only choice that cannot be wrong for a receiver
 * written against WSJT-X, which is the whole point of this file.
 *
 * Exported so the shape can be asserted without a socket.
 */
export { PROTECTED_FIELDS, parseExtraFields, type ExtraField } from "@/lib/logging/broadcast-fields";

export interface BroadcastIdentity {
  /** The PROGRAMID in the header. Receivers that only accept WSJT-X ADIF check this. */
  programId: string;
  /** What goes in COMMENT. Empty sends no comment field at all. */
  comment: string;
  /** Operator-supplied fields appended to each record. Never contact data — see PROTECTED_FIELDS. */
  extra?: ExtraField[];
}

/**
 * The fields WSJT-X puts in a logged-contact record, in its order.
 *
 * A DELIBERATELY LEANER RECORD than `adifRecord`, which is the archival export and is right
 * for that job: it carries QSL state, upload flags, county, IOTA, zones and the
 * `APP_DIGISHACK_*` fields the spec reserves for a program's own use. None of that means
 * anything to a receiver listening for a contact, and two parts of it were actively wrong to
 * send.
 *
 * Exported so the operator can be shown exactly what leaves the station.
 */
export function broadcastRecord(row: QsoRowForAdif, id: BroadcastIdentity): string {
  const q = toAdifInput(row);
  // THE SAME MODE SPLIT THE EXPORT USES. ADIF spells FT4 as MODE=MFSK with SUBMODE=FT4, and
  // so does WSJT-X — which matters beyond tidiness here, because the scoring sites read the
  // submode to decide the FT4/FT2 multiplier. Sending MODE=FT4 would be a mode no receiver
  // written against WSJT-X is looking for.
  const { mode, submode } = toAdifMode(q.mode);
  const hz = typeof row.freqHz === "bigint" ? Number(row.freqHz) : row.freqHz;
  const mhz = hz > 0 ? (hz / 1e6).toFixed(6) : null;
  const d = (x: Date): string => x.toISOString().slice(0, 10).replace(/-/g, "");
  const t = (x: Date): string => x.toISOString().slice(11, 19).replace(/:/g, "");

  return (
    [
      field("CALL", q.callsign),
      field("GRIDSQUARE", q.gridSquare),
      field("MODE", mode),
      field("SUBMODE", submode),
      field("RST_SENT", q.rstSent),
      field("RST_RCVD", q.rstRcvd),
      field("QSO_DATE", d(row.startTime)),
      field("TIME_ON", t(row.startTime)),
      field("QSO_DATE_OFF", d(row.endTime ?? row.startTime)),
      field("TIME_OFF", t(row.endTime ?? row.startTime)),
      field("BAND", q.band),
      field("FREQ", mhz),
      field("STATION_CALLSIGN", row.station.callsign),
      field("MY_GRIDSQUARE", row.myGridSquare ?? row.station.grid),
      field("TX_PWR", row.txPowerW === null ? null : String(row.txPowerW)),
      field("OPERATOR", row.operator?.callsign ?? null),
      field("NAME", row.name),
      // THE COMMENT IS THE OPERATOR'S, NOT OURS. The row's `notes` carries DigiShack's own
      // description of how the contact was made — right in the log, wrong on the wire: it
      // identifies the software, and it occupies the one field the scoring sites read for
      // their own commands (POTA references, /name). Sending the internal note would quietly
      // make those impossible to use.
      field("COMMENT", id.comment || null),
      // APPENDED LAST, so a field the operator adds cannot displace one the contact
      // supplied even if the parser above ever let a protected name through.
      ...(id.extra ?? []).map((f) => field(f.name, f.value)),
    ]
      .filter(Boolean)
      .join(" ") + " <EOR>"
  );
}

/**
 * The whole datagram payload: header, EOH, one record.
 *
 * WSJT-X sends a full document and receivers differ in how much they tolerate, so this sends
 * what WSJT-X sends. The header is built here rather than through `adifHeader`, which
 * hardcodes `PROGRAMID: DigiShack` — correct for an export the operator is keeping, wrong for
 * a datagram whose entire job is to be accepted by software written for WSJT-X.
 */
export function adifDatagramBody(row: QsoRowForAdif, id: BroadcastIdentity): string {
  return [
    field("ADIF_VER", "3.1.4"),
    field("PROGRAMID", id.programId),
    "<EOH>",
    broadcastRecord(row, id),
  ].join("\n");
}

/** Where to send, or null when the operator has not turned this on. */
async function destination(): Promise<
  | {
      host: string;
      port: number;
      id: string;
      programId: string;
      comment: string;
      extra: ExtraField[];
    }
  | null
> {
  if (!(await getBooleanSetting("udpLog.enabled", false))) return null;
  // NORMALISED, because a pasted URL is a reasonable thing to type and used to fail
  // once per contact in a log nobody reads.
  const host = normaliseHost(String((await getSetting("udpLog.host")) ?? ""));
  const port = await getNumberSetting("udpLog.port", 2333);
  if (!host) return null;
  // A port of 0 asks the OS to choose, which for a DESTINATION means nowhere.
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  const id = String((await getSetting("udpLog.stationId")) ?? "").trim() || DEFAULT_ID;
  // The ADIF identity is separate from the datagram's station id: one is the envelope the
  // protocol carries, the other is a field inside the document. Receivers check different
  // ones, so neither can be inferred from the other.
  const programId = String((await getSetting("udpLog.programId")) ?? "").trim() || DEFAULT_ID;
  const comment = String((await getSetting("udpLog.comment")) ?? "").trim();
  // Refusals are dropped silently HERE and surfaced in the preview instead: the send path
  // runs on every contact and must not log the same complaint a thousand times a day.
  const extra = parseExtraFields(String((await getSetting("udpLog.extraFields")) ?? "")).fields;
  return { host, port, id, programId, comment, extra };
}

/**
 * Announce one logged contact. Never throws.
 *
 * Called after the QSO row is written, so a failure here cannot lose a contact — which is
 * why every path below returns rather than raising.
 */
export async function broadcastLoggedQso(qsoId: string): Promise<void> {
  try {
    const to = await destination();
    // CHECKED BEFORE THE READ. This runs on every contact, and when the feature is off —
    // which is the default — it must cost nothing at all, not a database round trip.
    if (!to) return;

    // RE-READ WITH THE RELATIONS. `prisma.qso.create` returns the row's own columns, and an
    // ADIF record needs the station callsign, the operator and any POTA references that
    // live alongside it. Sending the partial row would produce a datagram that parses
    // cleanly and is missing the fields a logger files the contact under.
    const row = await prisma.qso.findUnique({
      where: { id: qsoId },
      include: { sigRefs: true, station: true, operator: true },
    });
    if (!row) return;

    const datagram = encodeLoggedADIF(to.id, adifDatagramBody(row, {
      programId: to.programId,
      comment: to.comment,
      extra: to.extra,
    }));
    sock().send(datagram, to.port, to.host, (err) => {
      if (!err) return;
      const now = Date.now();
      if (now - lastErrorAt > 60_000) {
        lastErrorAt = now;
        console.warn(`[udp-log] could not send to ${to.host}:${to.port}: ${err.message}`);
      }
    });
  } catch (err) {
    console.warn(`[udp-log] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

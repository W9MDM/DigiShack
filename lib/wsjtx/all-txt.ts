// Recovering contacts from WSJT-X's ALL.TXT.
//
// WHY THIS EXISTS. Other operators hold confirmations for contacts that are not in this log —
// 106 of 134 QRZ card requests and ~1,400 eQSL confirmations. The WSJT-X log does not explain
// them: importing all 22,271 of its records adds nothing, because every one is already here.
//
// ALL.TXT does explain them. It is WSJT-X's raw decode history, every transmission and
// reception, and the exchanges are in it in full:
//
//   260111_162215  7.074 Tx FT8   0  0.0 1340 KD3ATB K9XYZ EN61
//   260111_162230  7.074 Rx FT8 -21  0.1  819 K9XYZ KD3ATB -09
//   260111_162245  7.074 Tx FT8   0  0.0 1340 KD3ATB K9XYZ R-21
//   260111_162400  7.074 Rx FT8 -24  0.1  820 K9XYZ KD3ATB RR73
//   260111_162415  7.074 Tx FT8   0  0.0 1340 KD3ATB K9XYZ 73
//
// A complete contact: both reports exchanged and acknowledged. The operator's account of why
// it was never logged — "they sent me the 73, WSJT-X just didn't log sending ours" — matches
// what is on the line, and the far station logged it, which is why their card request exists.
//
// THE RULE THIS FOLLOWS. A contact is reconstructed only when the far station ACKNOWLEDGED —
// `RR73`, `RRR` or `73` addressed to us. Everything short of that is left alone however
// promising it looks, because the same file holds the failures next to the successes: the same
// station, the previous day, on 20 m FT4, exchanged reports twice and never acknowledged. That
// is not a contact, and inventing one from a hopeful-looking exchange would put a QSO in the
// log that the other operator has no record of — which is worse than the missing entry.

/** One line of ALL.TXT. */
export interface DecodeLine {
  at: Date;
  /** Dial frequency in MHz, as printed. */
  mhz: number;
  dir: "Tx" | "Rx";
  mode: string;
  /** Signal report of THIS decode, which is not the exchanged report. */
  snr: number | null;
  /** The message body, e.g. `K9XYZ KD3ATB RR73`. */
  message: string;
}

/**
 * Parse one line.
 *
 * The format is column-ish rather than delimited, and WSJT-X has changed it between versions,
 * so this splits on whitespace and takes the message as everything after the audio offset. A
 * line it cannot read returns null and is counted rather than throwing: a 388 MB file
 * accumulated over years will contain truncated lines from crashes and power cuts, and one bad
 * line must not end the recovery.
 */
export function parseDecodeLine(raw: string): DecodeLine | null {
  const line = raw.trim();
  if (!line) return null;

  const m = /^(\d{6})_(\d{6})\s+(\d+\.\d+)\s+(Tx|Rx)\s+(\S+)\s+(-?\d+)\s+(-?[\d.]+)\s+(\d+)\s+(.*)$/.exec(
    line,
  );
  if (!m) return null;

  const [, ymd, hms, mhz, dir, mode, snr, , , message] = m;
  const yy = Number(ymd!.slice(0, 2));
  // Two-digit years. WSJT-X writes them, so the century has to be assumed — 2000s, which is
  // correct for every log that exists and wrong only for one written after 2099.
  const at = new Date(
    Date.UTC(
      2000 + yy,
      Number(ymd!.slice(2, 4)) - 1,
      Number(ymd!.slice(4, 6)),
      Number(hms!.slice(0, 2)),
      Number(hms!.slice(2, 4)),
      Number(hms!.slice(4, 6)),
    ),
  );
  if (Number.isNaN(at.getTime())) return null;

  return {
    at,
    mhz: Number(mhz),
    dir: dir as "Tx" | "Rx",
    mode: mode!.toUpperCase(),
    snr: Number.isFinite(Number(snr)) ? Number(snr) : null,
    message: message!.trim(),
  };
}

/** A message addressed to us, split into who it is from and what it says. */
export interface Addressed {
  /** Who the message is TO. */
  to: string;
  /** Who it is FROM. */
  from: string;
  /** The remainder: a grid, a report, `R-07`, `RR73`, `RRR`, `73`. */
  rest: string;
}

/**
 * Split a standard FT8/FT4 message.
 *
 * `<to> <from> <rest>`. CQ messages have no addressee and are skipped: a CQ is not part of an
 * exchange with anybody in particular, and treating the second token as a correspondent would
 * pair us with every station we ever heard calling.
 */
export function splitMessage(message: string): Addressed | null {
  const parts = message.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === "CQ" || parts[0] === "QRZ") return null;
  // Compound and portable calls carry a slash; angle brackets are WSJT-X's hashed-callsign
  // notation for a call it could not send in full, and one of those is not identifiable.
  const to = parts[0]!.replace(/[<>]/g, "");
  const from = parts[1]!.replace(/[<>]/g, "");
  if (!to || !from) return null;
  return { to, from, rest: parts.slice(2).join(" ") };
}

/** Did the far station acknowledge? This is the whole test for "was it a contact". */
export function isAcknowledgement(rest: string): boolean {
  return /^(RR73|RRR|73)\b/i.test(rest.trim());
}

/**
 * A signal report out of a message body, or null.
 *
 * `-09`, `+03`, `R-21`, `R+03`. NOT a grid: `EN61` is four characters and would parse as
 * nothing, but `R-21` and a grid can both follow the callsigns, so the shape has to be
 * checked rather than the position.
 */
export function reportIn(rest: string): string | null {
  const m = /^R?([+-]\d{2})\b/.exec(rest.trim());
  return m ? m[1]! : null;
}

/** A contact reconstructed from the decode history. */
export interface RecoveredQso {
  callsign: string;
  band: string;
  mode: string;
  freqHz: number;
  /** First transmission of the exchange. */
  startTime: Date;
  /** The acknowledgement, which is when the contact was complete. */
  endTime: Date;
  /**
   * When THEY first came back to us with a report.
   *
   * `startTime` is our first transmission, which on a station we called repeatedly can be
   * minutes of unanswered calling before anything two-way happened — four calls to AE0DC
   * before it answered. This is the moment the exchange actually became a QSO, and it is what
   * WSJT-X would have recorded had it logged one, which makes it the better timestamp when a
   * recovered contact has to line up with what other people logged.
   *
   * Null when they never sent a report, which for an acknowledged contact means they answered
   * with `RR73` straight off.
   */
  theirFirstReportAt: Date | null;
  /** The report WE sent THEM. */
  rstSent: string | null;
  /** The report THEY sent US. */
  rstRcvd: string | null;
  gridSquare: string | null;
  /** The lines this was built from, so a human can check any single conclusion. */
  evidence: string[];
}

/**
 * How long an exchange may run before a later contact with the same station is a new one.
 *
 * Thirty minutes. An FT8 exchange takes about a minute and an FT4 one under half that; the
 * generous window covers a QSO interrupted by a fade and resumed, while still separating the
 * two contacts with KD3ATB that are twenty hours and one band apart in this very file.
 */
const EXCHANGE_GAP_MS = 30 * 60_000;

interface Pending {
  callsign: string;
  mode: string;
  mhz: number;
  first: Date;
  last: Date;
  /** Report we sent them, from our own Tx lines. */
  sent: string | null;
  /** Report they sent us. */
  rcvd: string | null;
  grid: string | null;
  /** When they first sent us a report. */
  firstReportAt: Date | null;
  /** They acknowledged. */
  acked: boolean;
  /** We acknowledged, which alone is not enough — see the note at the top. */
  weAcked: boolean;
  evidence: string[];
}

export interface RecoverResult {
  /** Lines read. */
  lines: number;
  /** Lines the parser could not read, which is expected in a years-old file. */
  unparsed: number;
  /** Exchanges that reached an acknowledgement from the far station. */
  recovered: RecoveredQso[];
  /** Exchanges that got as far as swapping reports and were never acknowledged. */
  incomplete: number;
  /**
   * Those same unacknowledged exchanges, in full, when `keepIncomplete` is set.
   *
   * NOT for logging on their own — the whole point of the acknowledgement rule is that these
   * are not contacts. They are exposed because a SECOND, independent source can supply the
   * missing half: 26 of this station's QRZ card requests name a date where the decode history
   * shows a complete exchange ending in our own final report and no acknowledgement we ever
   * decoded. The far operator heard that report, logged the contact and asked for a card. One
   * record short on its own; two records agreeing when paired.
   *
   * Anything drawn from here needs that corroboration named, and the caller is where it lives.
   */
  unacknowledged: RecoveredQso[];
}

/**
 * Reconstruct contacts from decode lines.
 *
 * `myCall` is required and is not guessed. Every message in the file names both stations, so a
 * wrong assumption about which one is ours would invert every report — `rstSent` and
 * `rstRcvd` swapped on hundreds of records, which no later check would catch because both
 * values are plausible.
 */
export function recoverQsos(
  lines: Iterable<string>,
  opts: { myCall: string; bandOf: (hz: number) => string | null; keepIncomplete?: boolean },
): RecoverResult {
  const me = opts.myCall.trim().toUpperCase();
  const result: RecoverResult = {
    lines: 0,
    unparsed: 0,
    recovered: [],
    incomplete: 0,
    unacknowledged: [],
  };
  // Keyed by correspondent + mode + dial frequency: the same station on two bands at once is
  // two exchanges, and this file contains exactly that case.
  const open = new Map<string, Pending>();

  const close = (p: Pending) => {
    const hz = Math.round(p.mhz * 1_000_000);
    const band = opts.bandOf(hz);

    if (!p.acked) {
      // Reports were swapped but the far station never confirmed. Counted always; returned in
      // full only when asked for, and never mixed in with `recovered`.
      if (p.sent || p.rcvd) {
        result.incomplete++;
        if (opts.keepIncomplete && band) {
          result.unacknowledged.push({
            callsign: p.callsign,
            band,
            mode: p.mode,
            freqHz: hz,
            startTime: p.first,
            endTime: p.last,
            theirFirstReportAt: p.firstReportAt,
            rstSent: p.sent,
            rstRcvd: p.rcvd,
            gridSquare: p.grid,
            evidence: p.evidence.slice(0, 12),
          });
        }
      }
      return;
    }
    if (!band) return;
    result.recovered.push({
      callsign: p.callsign,
      band,
      mode: p.mode,
      freqHz: hz,
      startTime: p.first,
      endTime: p.last,
      theirFirstReportAt: p.firstReportAt,
      rstSent: p.sent,
      rstRcvd: p.rcvd,
      gridSquare: p.grid,
      evidence: p.evidence.slice(0, 12),
    });
  };

  for (const raw of lines) {
    result.lines++;
    const d = parseDecodeLine(raw);
    if (!d) {
      if (raw.trim()) result.unparsed++;
      continue;
    }
    const a = splitMessage(d.message);
    if (!a) continue;

    // Only exchanges involving US, in either direction.
    const theirs = d.dir === "Tx" ? a.to : a.from;
    const ours = d.dir === "Tx" ? a.from : a.to;
    if (ours !== me || theirs === me) continue;

    const key = `${theirs}|${d.mode}|${d.mhz.toFixed(3)}`;
    let p = open.get(key);
    if (p && d.at.getTime() - p.last.getTime() > EXCHANGE_GAP_MS) {
      close(p);
      open.delete(key);
      p = undefined;
    }
    if (!p) {
      p = {
        callsign: theirs,
        mode: d.mode,
        mhz: d.mhz,
        first: d.at,
        last: d.at,
        sent: null,
        rcvd: null,
        grid: null,
        firstReportAt: null,
        acked: false,
        weAcked: false,
        evidence: [],
      };
      open.set(key, p);
    }
    p.last = d.at;
    if (p.evidence.length < 12) p.evidence.push(raw.trim());

    const report = reportIn(a.rest);
    if (d.dir === "Tx") {
      // OUR transmission. A report in it is the one we are giving them.
      if (report) p.sent = report;
      if (isAcknowledgement(a.rest)) p.weAcked = true;
    } else {
      // THEIR transmission. A report in it is the one they are giving us.
      if (report) {
        p.rcvd = report;
        // FIRST only. They repeat the report while waiting for our roger, and the last
        // repetition is not when the exchange became two-way.
        p.firstReportAt ??= d.at;
      }
      if (isAcknowledgement(a.rest)) {
        p.acked = true;
      } else if (/^[A-R]{2}\d{2}$/i.test(a.rest.trim())) {
        // A bare four-character grid, which is what they answer a CQ with.
        //
        // ELSE-IF, and the acknowledgement is tested FIRST. `RR73` is two letters in A-R
        // followed by two digits, so it satisfies the grid pattern exactly — and it appears in
        // the same position in the message. The first version tested both independently and
        // wrote GRIDSQUARE=RR73 into the recovered contacts, which a dry-run of the generated
        // ADIF surfaced. A grid is not something a later check would question: RR73 is a real
        // square in the South Atlantic.
        p.grid = a.rest.trim().toUpperCase();
      }
    }
  }

  for (const p of open.values()) close(p);
  result.recovered.sort((x, y) => x.startTime.getTime() - y.startTime.getTime());
  result.unacknowledged.sort((x, y) => x.startTime.getTime() - y.startTime.getTime());
  return result;
}

/**
 * Which recovered contacts are not already in the log.
 *
 * A TOLERANCE WINDOW, not an exact key, and the difference is 10,265 against 1,389.
 *
 * The first version of this comparison used `dupeKey` — callsign, band, mode and the minute,
 * with seconds zeroed — which is exactly right for re-importing an ADIF and wrong here. A
 * recovered contact's `startTime` is our FIRST TRANSMISSION of the exchange, and the log
 * recorded whatever WSJT-X considered the start; measured over 400 samples, the log sits a
 * median of 45 seconds later, which crosses a minute boundary about half the time. The
 * minute-exact key therefore reported 10,265 contacts as missing when 381 of every 400 were
 * present all along.
 *
 * That over-count was caught by its own implausibility — it was an order of magnitude above
 * what the far stations' confirmations implied — rather than by anything in the code. Two
 * independent records of the same event do not agree to the second, so the comparison has to
 * allow for it, which is the same reason the eQSL matcher uses a window.
 *
 * THREE HOURS, not fifteen minutes, and the reason is a measured asymmetry. Offsets to the
 * nearest log entry, over 21,427 recovered exchanges that have one:
 *
 *     0-2 min      8,852 log later    9,609 log earlier
 *     2-10 min     2,038 log later        8 log earlier
 *     10-15 min      296 log later        0 log earlier
 *     15-30 min      437 log later        2 log earlier
 *     30-180 min     183 log later        2 log earlier
 *
 * Inside two minutes it is symmetric — the same contact, clocks disagreeing. Past that it is
 * 99% ONE-SIDED: the log entry is later, essentially never earlier. Genuinely separate
 * contacts with the same station would scatter both ways, so a one-sided tail is not a
 * population of second QSOs; it is the same QSOs written down late.
 *
 * Which is why the count is so sensitive to this number — 1,389 missing at fifteen minutes,
 * 807 at an hour, 765 at three hours, 754 at twelve. It flattens after an hour, so three hours
 * sits past the logged-late tail and short of absurdity.
 *
 * 455 of them have that station, on that band, in that mode, NOWHERE in the log at any time.
 * Those need no window judgement at all and are the floor under every figure above.
 */
export function missingFromLog(
  recovered: RecoveredQso[],
  logged: { callsign: string; band: string; mode: string; startTime: Date }[],
  toleranceMs = 3 * 3_600_000,
): RecoveredQso[] {
  const key = (c: string, b: string, m: string) =>
    `${c.trim().toUpperCase()}|${b.trim().toUpperCase()}|${m.trim().toUpperCase()}`;

  const index = new Map<string, number[]>();
  for (const q of logged) {
    const k = key(q.callsign, q.band, q.mode);
    const list = index.get(k);
    if (list) list.push(q.startTime.getTime());
    else index.set(k, [q.startTime.getTime()]);
  }

  return recovered.filter((r) => {
    const times = index.get(key(r.callsign, r.band, r.mode));
    if (!times) return true;
    const t = r.startTime.getTime();
    return !times.some((x) => Math.abs(x - t) <= toleranceMs);
  });
}

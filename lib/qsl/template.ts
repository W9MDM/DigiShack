// Placeholder substitution for QSL email and card templates.
//
// Everything an operator might want to word differently — the subject, the body,
// the card's footer line, the promise about mailing paper cards — is a template
// in Settings rather than a string in this file. A QSL card carries a claim about
// how you operate ("I have uploaded to LoTW, eQSL, QRZ and Club Log", "will QSL
// by mail for any cards received"), and that is not something code should assert
// on the operator's behalf.
//
// Deliberately not a real template language: no conditionals, no loops, no
// expression evaluation. Substitution only. A template comes from Settings, and
// Settings is editable by an admin over the web — anything evaluable there is a
// way to run code on the server.

/** A token's value, already formatted for display. */
export type TemplateValues = Record<string, string>;

/**
 * Every token, with a description. Drives both substitution and the help text
 * shown in Settings, so the two can never drift apart.
 */
export const QSL_TOKENS: readonly { token: string; describes: string }[] = [
  { token: "THEIR_CALL", describes: "the other station's callsign" },
  { token: "MY_CALL", describes: "your callsign" },
  { token: "MY_NAME", describes: "your name" },
  { token: "MY_GRID", describes: "your grid square" },
  { token: "THEIR_GRID", describes: "their grid square, blank if unknown" },
  { token: "DATE", describes: "QSO date, YYYY-MM-DD" },
  { token: "TIME", describes: "QSO time UTC, HH:MM" },
  { token: "DATETIME", describes: "date and time together, UTC" },
  { token: "YEAR", describes: "QSO year" },
  { token: "BAND", describes: "band, e.g. 20m" },
  { token: "MODE", describes: "mode, e.g. FT8" },
  { token: "FREQ", describes: "frequency in MHz, blank if not logged" },
  { token: "RST_SENT", describes: "report you sent" },
  { token: "RST_RCVD", describes: "report you received" },
  { token: "POWER", describes: "transmit power — this contact's measured watts, else the station setting" },
  { token: "MY_QTH", describes: "your location text" },
];

/** One line of help listing the tokens, for the Settings hint. */
export function tokenHelp(): string {
  return QSL_TOKENS.map((t) => `{${t.token}}`).join(" ");
}

/**
 * Substitute `{TOKEN}` occurrences.
 *
 * Unknown tokens are left ALONE rather than blanked. A typo like `{THEIR_CAL}`
 * then shows up in the output where the operator will see it, instead of silently
 * producing an email with a missing callsign — which is the sort of thing you only
 * discover after sending a few hundred.
 *
 * A token whose value is genuinely empty (no grid on file, power not logged)
 * resolves to an empty string, and `tidy` cleans up the wreckage that leaves.
 */
export function applyTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole,
  );
}

/**
 * Substitute and drop lines whose content vanished, in one pass.
 *
 * Per-line, and it needs the ORIGINAL line to decide: a line that was already
 * blank in the template is a deliberate paragraph break and must survive, while a
 * line that HELD a token and came back empty should disappear entirely. `tidy`
 * alone cannot tell those apart, which left "73,", "", "K9XYZ" when the operator
 * had no name configured — a stray blank line in the middle of a sign-off.
 *
 * Also drops a line reduced to a bare label: "Your Grid: {THEIR_GRID}" with no
 * grid on file would otherwise read "Your Grid:" and look like missing data
 * rather than an omitted field.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const hadToken = /\{[A-Z_][A-Z0-9_]*\}/.test(line);
    const filled = applyTemplate(line, values).replace(/[ 	]+$/, "");

    if (hadToken) {
      if (filled.trim() === "") continue;
      // Label with nothing after it.
      if (/^\s*[A-Za-z][A-Za-z0-9 /]*:\s*$/.test(filled)) continue;
    }
    // Never two blank lines in a row.
    if (filled.trim() === "" && out.length > 0 && out[out.length - 1]!.trim() === "") continue;
    out.push(filled);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  while (out.length > 0 && out[0]!.trim() === "") out.shift();
  return out.join("\n");
}

export interface QsoForTemplate {
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
  freqHz?: number | null;
  rstSent?: string | null;
  rstRcvd?: string | null;
  gridSquare?: string | null;
  /** Free text, e.g. "100" — a station constant from Settings. */
  txPower?: string | null;
  /**
   * ADIF TX_PWR — this contact's measured transmit power in watts.
   *
   * Takes precedence over the station constant when present. See the POWER token.
   */
  txPowerW?: number | null;
}

export interface StationForTemplate {
  callsign: string;
  name?: string | null;
  grid?: string | null;
  qth?: string | null;
  /** Transmit power as text, from Settings. */
  txPower?: string | null;
}

/** Build the token values for one QSO. */
export function templateValues(
  qso: QsoForTemplate,
  station: StationForTemplate,
): TemplateValues {
  const iso = qso.startTime.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  // Frequency is shown to 4 decimals — the convention on cards and in ADIF, and
  // enough to distinguish two signals in the same passband.
  const freq =
    qso.freqHz && Number.isFinite(qso.freqHz) ? (qso.freqHz / 1_000_000).toFixed(4) : "";

  return {
    THEIR_CALL: qso.callsign.toUpperCase(),
    MY_CALL: station.callsign.toUpperCase(),
    MY_NAME: station.name ?? "",
    MY_GRID: (station.grid ?? "").toUpperCase(),
    THEIR_GRID: (qso.gridSquare ?? "").toUpperCase(),
    DATE: date,
    TIME: time,
    DATETIME: `${date} ${time} UTC`,
    YEAR: date.slice(0, 4),
    BAND: qso.band,
    MODE: qso.mode,
    FREQ: freq,
    RST_SENT: qso.rstSent ?? "",
    RST_RCVD: qso.rstRcvd ?? "",
    // The contact's OWN measured power wins over the station constant.
    //
    // `qsl.txPower` is one number typed into Settings for every contact ever made.
    // When the radio actually measured this one, that measurement is the truthful
    // answer and the setting is only a fallback for contacts made before there was
    // a meter reading — or on a radio that has no meter.
    POWER: qso.txPowerW != null ? `${qso.txPowerW}w` : station.txPower ? `${station.txPower}w` : "",
    MY_QTH: station.qth ?? "",
  };
}

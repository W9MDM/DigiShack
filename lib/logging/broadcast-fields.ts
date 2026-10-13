// The rules about WHICH fields may be broadcast, with nothing that opens a socket.
//
// WHY THIS IS ITS OWN FILE. The settings panel needs the protected list so it can mark a
// field "from the contact" rather than keeping a second copy that would eventually disagree
// with the one doing the refusing. Importing it from `adif-udp.ts` pulled `node:dgram` into
// the browser bundle — which builds and typechecks cleanly and then throws in the page.
//
// `check:client-bundle` caught it, which is the whole reason that check exists: nothing
// about the import looks wrong, and the failure only appears when somebody opens the page.

/**
 * Fields that come from the CONTACT and may never be overridden.
 *
 * THE LINE THIS DRAWS. An operator asked to be able to edit "every field that isn't FT8
 * actual data", which is the right instinct and needs a boundary drawn by something other
 * than taste — because the fields on the wrong side of it are the ones that make a log a
 * record of what happened.
 *
 * Everything here was measured by the radio or typed into a contact: who was worked, when,
 * on what, and what reports were exchanged. A text box that could rewrite CALL or RST_SENT
 * would not be a formatting option, it would be a tool for logging contacts that did not
 * happen — and the scoring sites ban fabricated QSOs outright.
 *
 * STATION_CALLSIGN is on this list for the same reason, and it is the one people reach for.
 * It is the station's own licensed callsign; sending a different one is impersonation, which
 * every contest and every scoring site treats as a banned offence rather than a preference.
 */
export const PROTECTED_FIELDS = new Set([
  "CALL",
  "GRIDSQUARE",
  "MODE",
  "SUBMODE",
  "RST_SENT",
  "RST_RCVD",
  "QSO_DATE",
  "TIME_ON",
  "QSO_DATE_OFF",
  "TIME_OFF",
  "BAND",
  "FREQ",
  "STATION_CALLSIGN",
  "EOR",
  "EOH",
]);

export interface ExtraField {
  name: string;
  value: string;
}

/**
 * Parse the operator's extra fields.
 *
 * `NAME=value` per line, or comma separated. Deliberately not JSON: this is typed into a
 * settings box by someone who wants `MY_ANTENNA=EFHW` or `CONTEST_ID=CQ-WW-DIGI`, and a
 * format that punishes a missing brace is a format that loses the setting.
 *
 * REFUSALS ARE RETURNED, NOT THROWN. A bad line must not stop the good ones being sent, and
 * the operator needs to be told which line was dropped and why — a silently ignored setting
 * is the thing this whole preview exists to prevent.
 */
export function parseExtraFields(raw: string): {
  fields: ExtraField[];
  refused: { input: string; reason: string }[];
} {
  const fields: ExtraField[] = [];
  const refused: { input: string; reason: string }[] = [];

  for (const piece of raw.split(/[\r\n,]+/)) {
    const line = piece.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      refused.push({ input: line, reason: "expected NAME=value" });
      continue;
    }
    const name = line.slice(0, eq).trim().toUpperCase();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      refused.push({ input: line, reason: "not a valid ADIF field name" });
      continue;
    }
    if (PROTECTED_FIELDS.has(name)) {
      refused.push({ input: line, reason: `${name} comes from the contact and cannot be set` });
      continue;
    }
    if (fields.some((f) => f.name === name)) {
      refused.push({ input: line, reason: `${name} is already set above` });
      continue;
    }
    if (!value) {
      refused.push({ input: line, reason: "empty value" });
      continue;
    }
    fields.push({ name, value });
  }
  return { fields, refused };
}

/**
 * The destination as a bare host, whatever the operator typed.
 *
 * THE FAULT THIS FIXES, from the live station's log, once per contact:
 *
 *     [udp-log] could not send to http://129.212.188.3/:2237:
 *               getaddrinfo ENOTFOUND http://129.212.188.3/
 *
 * The setting took `http://129.212.188.3/` without complaint — which is an entirely
 * reasonable thing to paste, because every other address in this application is a URL. UDP
 * has no URLs: there is no scheme, no path, and nothing to GET. So the whole string went to
 * `getaddrinfo` as a hostname, and every contact failed in a log nobody had a reason to read.
 *
 * Stripping rather than refusing: the operator's intent is unambiguous, and a setting that
 * rejects a paste is a setting that gets fought with. What CANNOT be guessed — a port that
 * disagrees with the one in its own box — is reported instead, by `destinationProblem`.
 */
export function normaliseHost(raw: string): string {
  let h = raw.trim();
  if (!h) return "";
  // A scheme, and anything after the authority. Both are meaningless for a datagram.
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  h = h.split("/")[0] ?? "";
  // A bracketed IPv6 literal keeps its address. A trailing :port is deliberately NOT stripped
  // here — the port has its own setting, and silently honouring an inline one would leave two
  // sources of truth disagreeing with nothing to say so. `destinationProblem` names it.
  const bracket = /^\[([0-9a-f:.]+)\]/i.exec(h);
  if (bracket) return bracket[1]!;
  return h.trim();
}

/**
 * What is wrong with the destination, in words, or null when it is fine.
 *
 * Surfaced in the preview panel rather than only written to a log. The whole reason the fault
 * above survived is that its only evidence was a line in a log the operator had no reason to
 * open, repeated once per contact.
 */
export function destinationProblem(rawHost: string, port: number): string | null {
  const raw = rawHost.trim();
  if (!raw) return "No destination set, so nothing is being sent.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return `UDP has no URLs — use just the address, not "${raw}".`;
  }
  const host = normaliseHost(raw);
  if (!host) return `"${raw}" does not contain an address.`;
  // An inline port is the one ambiguity worth refusing to guess at.
  const inline = /^(?!\[)([^:]+):(\d+)$/.exec(host);
  if (inline) {
    return `The port belongs in its own box — "${host}" sets it twice (${inline[2]} here, ${port} below).`;
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return `${port} is not a usable port.`;
  }
  return null;
}

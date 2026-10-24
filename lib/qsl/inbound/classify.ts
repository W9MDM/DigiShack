// What an email in the station mailbox IS, as far as QSLs go — decided from the cheap
// fields alone (sender, subject, a preview), before anything is downloaded.
//
// Pure, and separately tested by scripts/check-qsl-inbound.ts against the real shapes found
// in the operator's mailbox. What that probe found, and what each rule below is for:
//
//   * 259 of the matches were OUR OWN outgoing cards — "QSL Confirmation for KK1XYZ / K9XYZ
//     QSO" with QSL-K9XYZ-KK1XYZ-2026-10-22.jpg attached, sent from the mailbox itself (which
//     Exchange reports as an internal "/o=ExchangeLabs/..." address). Importing those would
//     credit every contact with the card WE sent. They are skipped first, before any other
//     rule can see them.
//   * Bounces of those cards — "Undeliverable: QSL Confirmation for …", "Mail Delivery
//     failure." — are not received cards either. They are evidence a card did not arrive.
//   * Received cards: an image attached to "QSL Contact - K9XYZ DE K1ABC", "eQSL — K9XYZ de
//     F1ABC", "QSO Contact from K5ABC", and some with no image at all ("QSL from K4ABC to
//     K9XYZ").
//   * Replies to our card — "Re: QSL Confirmation for WB1ABC / K9XYZ QSO", or via Winlink
//     "Re: //WL2K R/QSL Confirmation for …". The station answering our card confirms the
//     contact whether or not they attach a picture.
//   * Notices that a card is waiting on a website: digiqsl, qslworld, eQSL.
//   * And unrelated mail — a newsletter — that a naive "QSL" search also finds.

/** The shapes a callsign takes in practice, without any boundary. Case-insensitive callers uppercase. */
const CALL_CORE = "[A-Z0-9]?[A-Z][0-9A-Z]?[0-9][A-Z]{1,4}(?:\\/[A-Z0-9]{1,4})?";

/** Words that look like callsigns and are not. WL2K is Winlink's subject marker. */
const NOT_CALLS = new Set(["WL2K"]);

const CALL_FULL = new RegExp(`^${CALL_CORE}$`);

/** True when `s` is shaped like an amateur callsign. */
export function isCallsign(s: string): boolean {
  const u = s.toUpperCase();
  return CALL_FULL.test(u) && !NOT_CALLS.has(u) && /[0-9]/.test(u) && u.length <= 16;
}

/**
 * The home call, without portable or country designators: K9XYZ/P → K9XYZ, VE3/K9XYZ → K9XYZ.
 *
 * The longest part that is itself a callsign, which is the home call in every common form.
 */
export function baseCall(call: string): string {
  const parts = call.toUpperCase().split("/").filter(Boolean);
  let best = parts[0] ?? "";
  for (const p of parts) if (isCallsign(p) && p.length > best.length) best = p;
  return best;
}

/** Is this one of ours? Compared on the home call, so K9XYZ/P is still us. */
export function isOwnCall(call: string, own: readonly string[]): boolean {
  const b = baseCall(call);
  return own.some((o) => baseCall(o) === b);
}

/**
 * Is this attachment OUR card, come back quoted in somebody's reply?
 *
 * Mail programs re-attach the original's pictures to a reply, so a "Re: QSL Confirmation"
 * often carries our own card next to — or instead of — theirs. Recognised by the names our
 * senders give the file: the earlier emailer's `QSL_<THEM>_<US>.jpg` (our call last) and
 * DigiShack's `QSL-<US>-<THEM>-<date>.jpg`. A station that names ITS card for us —
 * `QSL_<US>_<THEM>.jpg`, `<US>_20251104_1519_17m_FT8.jpg` — is not matched: our call is in
 * the other place.
 */
export function isOwnCardFile(name: string, own: readonly string[]): boolean {
  const stem = name.trim().replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const old = /^QSL_([A-Z0-9/]+)_([A-Z0-9/]+)$/i.exec(stem);
  if (old?.[1] && old[2] && isOwnCall(old[2], own) && !isOwnCall(old[1], own)) return true;
  const ds = /^QSL-([A-Z0-9/]+)-([A-Z0-9/]+)-\d{4}-\d{2}-\d{2}$/i.exec(stem);
  return Boolean(ds?.[1] && ds[2] && isOwnCall(ds[1], own) && !isOwnCall(ds[2], own));
}

/**
 * Subject patterns that NAME the other station, most specific first.
 *
 * Each captures one callsign; our own call is rejected afterwards rather than excluded in the
 * pattern, so "QSL Contact - K9XYZ DE K1ABC" can match `QSL Contact - (K9XYZ)` harmlessly and
 * still find K1ABC through `DE`.
 */
const SUBJECT_PATTERNS: RegExp[] = [
  new RegExp(`QSL Confirmation for\\s+(${CALL_CORE})`, "gi"),
  new RegExp(`(?<![A-Z0-9])de\\s+(${CALL_CORE})(?![A-Z0-9])`, "gi"),
  new RegExp(`QSL Contact\\s*[,:\\-–—]\\s*(${CALL_CORE})(?![A-Z0-9])`, "gi"),
  new RegExp(`(?<![A-Z0-9])from\\s+(${CALL_CORE})(?![A-Z0-9])`, "gi"),
  new RegExp(`(?<![A-Z0-9/])(${CALL_CORE})\\s+sent you a QSL`, "gi"),
  // "KF0VR QSL Card — K9XYZ — 20260920": the sender's call first, then what it is.
  new RegExp(`^\\s*(${CALL_CORE})\\s+(?:e?QSL|QSO)\\b`, "gi"),
];

function firstForeign(found: Iterable<string>, own: readonly string[]): string | null {
  for (const raw of found) {
    const c = raw.toUpperCase();
    if (isCallsign(c) && !isOwnCall(c, own)) return c;
  }
  return null;
}

/** The other station's call, from a subject line, or null. */
export function callFromSubject(subject: string, own: readonly string[]): string | null {
  const found: string[] = [];
  for (const re of SUBJECT_PATTERNS) {
    for (const m of subject.matchAll(re)) if (m[1]) found.push(m[1]);
  }
  return firstForeign(found, own);
}

/** Callsign-shaped tokens of a filename, ours excluded: K1ABC_QSL.jpg → K1ABC. */
export function callsInFilename(name: string, own: readonly string[]): string[] {
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return stem
    .split(/[_\-\s.+]+/)
    .map((t) => t.toUpperCase())
    .filter((t) => isCallsign(t) && !isOwnCall(t, own));
}

/**
 * A call from the sender's address: wb1abc@gmail.com → WB1ABC, kg1abc_qsl@… → KG1ABC.
 *
 * The LOCAL part only. A domain like w8abc.example names a station too, but it also names the
 * mail host of anybody who uses it.
 */
export function callFromAddress(address: string, own: readonly string[]): string | null {
  const local = address.split("@")[0] ?? "";
  return firstForeign(local.split(/[._+\-]+/), own);
}

export interface MailSummary {
  /** Sender address, lower-cased. Exchange's internal "/o=…" form included. */
  from: string;
  fromName: string;
  subject: string;
  /** The first couple of hundred characters of body text, where the service gives them. */
  preview: string;
  hasAttachments: boolean;
}

export interface ClassifyContext {
  /** The mailbox being read. Mail from it is ours. */
  mailbox: string;
  /** Every callsign this station operates as. Never imported as the other station. */
  ownCalls: readonly string[];
  /**
   * Every address this station sends from: the configured sender, the Microsoft 365 mailbox,
   * any other mailbox in use. Mail from any of them is ours, whichever mailbox it turns up in —
   * the cards may be sent from one domain and read from another.
   */
  ownAddresses?: readonly string[];
}

/** Our outgoing card's subject: "QSL Confirmation for <THEM> / <US> QSO". Captures <US>. */
const OWN_SUBJECT = new RegExp(`^QSL Confirmation for\\s+${CALL_CORE}\\s*/\\s*(${CALL_CORE})`, "i");

export type NoticeSite = "digiqsl" | "qslworld" | "eqsl" | "other";

export type Classification =
  | { kind: "own"; reason: string }
  | { kind: "bounce"; callsign: string | null }
  | { kind: "reply"; callsign: string }
  | { kind: "notice"; callsign: string | null; site: NoticeSite }
  | { kind: "card"; callsign: string | null }
  | { kind: "ignore"; reason: string };

const NOTICE_DOMAINS: Record<string, NoticeSite> = {
  "digiqsl.com": "digiqsl",
  "qslworld.com": "qslworld",
  "eqsl.cc": "eqsl",
};

export function domainOf(address: string): string {
  return (address.split("@")[1] ?? "").toLowerCase();
}

function siteForDomain(domain: string): NoticeSite | null {
  for (const [d, site] of Object.entries(NOTICE_DOMAINS)) {
    if (domain === d || domain.endsWith(`.${d}`)) return site;
  }
  return null;
}

/** Who sends bounces: Exchange's postmaster, the usual daemons, relay bounce domains. */
function isBounceSender(from: string): boolean {
  const local = from.split("@")[0] ?? "";
  const domain = domainOf(from);
  return (
    /^(microsoftexchange[0-9a-f]*|mailer-daemon|postmaster|mail-daemon)$/i.test(local) ||
    /(^|\.)bounces?\./i.test(domain) ||
    /^bounces?\b/i.test(domain)
  );
}

const BOUNCE_SUBJECT =
  /^\s*(undeliverable|undelivered|mail delivery fail|delivery status notification|returned mail|delivery has failed|failure notice)/i;

/** A reply prefix, any number deep and in the usual languages: Re:, AW:, SV:, Antw:. */
const REPLY_PREFIX = /^\s*(?:(?:re|aw|sv|antw|odp|r)\s*(?:\[\d+\])?\s*:\s*)+/i;

const NOTICE_SUBJECT =
  /sent you a QSL card|new QSL card|QSL cards? (?:is |are )?waiting|QSL card arrived|have \d+ QSL cards?/i;

/** Mail that is about QSLs in general rather than being one. */
const BULK_SUBJECT = /newsletter|digest|bulletin|webinar|unsubscribe|% off|sale\b/i;

const QSL_WORDS = /\be?QSL\b|\bQSO\b|\bcontact\b/i;

/**
 * Decide what one message is. Order matters and is the point: our own mail is excluded
 * before anything else can look at it, and a bounce before its subject — which quotes our
 * card's — can be read as a reply or a card.
 */
export function classifyMessage(m: MailSummary, ctx: ClassifyContext): Classification {
  const from = m.from.trim().toLowerCase();
  const subject = m.subject.trim();
  const mailbox = ctx.mailbox.trim().toLowerCase();

  // 1. OURS. Exchange reports the mailbox's own sent items with its internal X.500 address,
  //    so "starts with /o=" is the mailbox itself, whatever the SMTP address is.
  if (from.startsWith("/o=")) return { kind: "own", reason: "sent from this mailbox (internal address)" };
  if (mailbox && from === mailbox) return { kind: "own", reason: "sent from this mailbox" };
  if ((ctx.ownAddresses ?? []).some((a) => a.trim().toLowerCase() === from)) {
    return { kind: "own", reason: "sent from one of this station's addresses" };
  }
  // Our card's own subject, "QSL Confirmation for KK1XYZ / K9XYZ QSO", with no reply prefix: our
  // card, whatever address it came from. Keyed on OUR call after the slash rather than on an
  // address, so moving the station's mail to another domain cannot let our cards back in.
  const ours = OWN_SUBJECT.exec(subject);
  if (ours?.[1] && (ctx.ownCalls.length === 0 || isOwnCall(ours[1], ctx.ownCalls))) {
    return { kind: "own", reason: "our own card's subject" };
  }

  // 2. BOUNCES of our cards. Never a received card.
  if (isBounceSender(from) || BOUNCE_SUBJECT.test(subject)) {
    const quoted = `${subject}\n${m.preview}`;
    const about = new RegExp(`QSL Confirmation for\\s+(${CALL_CORE})`, "i").exec(quoted);
    if (!about && !/\bQSL\b/i.test(quoted)) {
      return { kind: "ignore", reason: "a bounce that does not mention a QSL" };
    }
    const call = about?.[1] ? about[1].toUpperCase() : null;
    return { kind: "bounce", callsign: call && !isOwnCall(call, ctx.ownCalls) ? call : null };
  }

  // 3. REPLIES to our card. The callsign is the one our subject was addressed to.
  if (REPLY_PREFIX.test(subject)) {
    const m2 = new RegExp(`QSL Confirmation for\\s+(${CALL_CORE})`, "i").exec(subject);
    const call = m2?.[1]?.toUpperCase();
    if (call && isCallsign(call) && !isOwnCall(call, ctx.ownCalls)) return { kind: "reply", callsign: call };
  }

  // 4. NOTICES from the card sites, or in their words from a station's own domain.
  const site = siteForDomain(domainOf(from));
  if (site || NOTICE_SUBJECT.test(subject)) {
    return { kind: "notice", callsign: callFromSubject(subject, ctx.ownCalls), site: site ?? "other" };
  }

  if (BULK_SUBJECT.test(subject)) return { kind: "ignore", reason: "looks like bulk mail" };

  // 5. CARDS. Either the subject names the station and talks about a QSL/QSO, or there is
  //    an attachment to look at and the subject is about a QSL at all.
  const named = callFromSubject(subject, ctx.ownCalls);
  if (QSL_WORDS.test(subject) && (named || m.hasAttachments)) {
    return { kind: "card", callsign: named };
  }

  return { kind: "ignore", reason: "not about a QSL" };
}

// ---------------------------------------------------------------------------
// What a card's filename says about the contact
// ---------------------------------------------------------------------------

export interface FileHints {
  /** YYYY-MM-DD, UTC. */
  date?: string;
  /** HHMM, UTC. */
  time?: string;
  /** As the log spells it: "20M". */
  band?: string;
  mode?: string;
}

const MODES = new Set([
  "FT8", "FT4", "FT2", "JT65", "JT9", "Q65", "MSK144", "WSPR", "JS8", "SSB", "USB", "LSB",
  "CW", "RTTY", "PSK31", "PSK63", "PSK", "OLIVIA", "SSTV", "FM", "AM", "MFSK", "VARAC", "HELL", "JTTY",
]);

const BANDS = new Set([
  "2190M", "630M", "560M", "160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M",
  "10M", "6M", "4M", "2M", "1.25M", "70CM", "33CM", "23CM", "13CM",
]);

function validDate(y: number, mo: number, d: number): boolean {
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Date, time, band and mode from a card filename: K9XYZ_20261023_1838_20M_FT4.jpg.
 *
 * Token by token rather than one pattern, because the order and the separators vary from
 * one logging program to the next and a single regex would match one of them. The band is
 * case-insensitive ("40m" from N3FJP-style names) and is kept only when it is a real band.
 */
export function parseCardFilename(name: string): FileHints {
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const tokens = stem.split(/[_\-\s+]+/).filter(Boolean);
  const out: FileHints = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const u = t.toUpperCase();
    if (!out.date && /^\d{8}$/.test(t)) {
      const y = Number(t.slice(0, 4)), mo = Number(t.slice(4, 6)), d = Number(t.slice(6, 8));
      if (validDate(y, mo, d)) {
        out.date = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
        const next = tokens[i + 1];
        if (next && /^\d{4}z?$/i.test(next)) {
          const hh = Number(next.slice(0, 2)), mm = Number(next.slice(2, 4));
          if (hh < 24 && mm < 60) {
            out.time = next.slice(0, 4);
            i++;
          }
        }
        continue;
      }
    }
    // 2026-10-23 split into three tokens by the separators.
    if (!out.date && /^\d{4}$/.test(t) && /^\d{2}$/.test(tokens[i + 1] ?? "") && /^\d{2}$/.test(tokens[i + 2] ?? "")) {
      const y = Number(t), mo = Number(tokens[i + 1]), d = Number(tokens[i + 2]);
      if (validDate(y, mo, d)) {
        out.date = `${t}-${tokens[i + 1]}-${tokens[i + 2]}`;
        i += 2;
        continue;
      }
    }
    if (!out.band && BANDS.has(u)) {
      out.band = u;
      continue;
    }
    if (!out.mode && MODES.has(u)) out.mode = u;
  }
  return out;
}

export interface BodyHints extends FileHints {
  /** The other station, where the text names it: "Call: KF0VR DE K9XYZ", "the QSO with KF0VR". */
  callsign?: string;
}

/**
 * What the text of an email says about the contact — the labelled lines most senders write:
 *
 *   Date: 20260920 / Time: 140830 UTC / Band: 20m / Mode: FT8      (KF0VR's emailer)
 *   Call: KF0VR DE K9XYZ / Date: 2026-09-20 14:08:00 UTC / Band: 20m (our own card, quoted
 *                                                                    back in a reply)
 *
 * Works on tag-stripped text with the line breaks gone, so every pattern stops at the value
 * it wants rather than at the end of a line. The first of each wins: in a reply that is the
 * station's own words, ahead of the quote. "Date: Sun, 20 Sep" headers of a quoted message
 * have no digits where the pattern wants them and are passed over.
 */
export function parseBodyHints(text: string, own: readonly string[]): BodyHints {
  const out: BodyHints = {};
  const date = /\b(?:QSO\s+)?Date\s*[:=]\s*(\d{4})-?(\d{2})-?(\d{2})(?![0-9])(?:[ T]+(\d{2}):?(\d{2}))?/i.exec(text);
  if (date && validDate(Number(date[1]), Number(date[2]), Number(date[3]))) {
    out.date = `${date[1]}-${date[2]}-${date[3]}`;
    if (date[4] && date[5] && Number(date[4]) < 24 && Number(date[5]) < 60) out.time = `${date[4]}${date[5]}`;
  }
  if (!out.time) {
    const time = /\b(?:QSO\s+)?(?:Time|UTC)\s*[:=]\s*(\d{2}):?(\d{2})(?::?\d{2})?(?![0-9])/i.exec(text);
    if (time && Number(time[1]) < 24 && Number(time[2]) < 60) out.time = `${time[1]}${time[2]}`;
  }
  // Labelled, or in a sentence: digiqsl's "confirm our FT8 QSO on the 40m band".
  const band =
    /\bBand\s*[:=]\s*(\d+(?:\.\d+)?)\s*(c?m)\b/i.exec(text) ?? /\bon the\s+(\d+(?:\.\d+)?)\s*(c?m)\s+band\b/i.exec(text);
  if (band && BANDS.has(`${band[1]}${band[2]}`.toUpperCase())) out.band = `${band[1]}${band[2]}`.toUpperCase();
  const mode = /\bMode\s*[:=]\s*([A-Z0-9]+)/i.exec(text) ?? /\b([A-Z0-9]{2,6})\s+(?:QSO|contact)\s+on the\b/i.exec(text);
  if (mode?.[1] && MODES.has(mode[1].toUpperCase())) out.mode = mode[1].toUpperCase();
  const found: string[] = [];
  for (const re of [
    new RegExp(`\\bCall\\s*[:=]\\s*(${CALL_CORE})(?![A-Z0-9])`, "gi"),
    new RegExp(`\\b(?:QSO|contact)\\s+with\\s+(${CALL_CORE})(?![A-Z0-9])`, "gi"),
    new RegExp(`\\bRESPOND TO\\s+(${CALL_CORE})(?![A-Z0-9])`, "gi"),
  ]) {
    for (const m of text.matchAll(re)) if (m[1]) found.push(m[1]);
  }
  const call = firstForeign(found, own);
  if (call) out.callsign = call;
  return out;
}

/**
 * `first`'s hints, gaps filled from `then`. A time is only borrowed with its own date: a card
 * named for one day and a text naming another do not make a moment between them.
 */
export function fillHints(first: FileHints, then: FileHints): FileHints {
  const out: FileHints = { ...first };
  if (!out.date && then.date) {
    out.date = then.date;
    if (!out.time && then.time) out.time = then.time;
  } else if (out.date && out.date === then.date && !out.time && then.time) {
    out.time = then.time;
  }
  if (!out.band && then.band) out.band = then.band;
  if (!out.mode && then.mode) out.mode = then.mode;
  return out;
}

// ---------------------------------------------------------------------------
// Is it really a picture?
// ---------------------------------------------------------------------------

/** Largest card accepted. A scanned card is a few hundred kB; this is generous. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageCheck =
  | { ok: true; ext: "jpg" | "png" | "gif" | "webp"; contentType: string }
  | { ok: false; reason: string };

/**
 * What the bytes are, decided from the bytes.
 *
 * Never from the filename or the declared type: KG1ABC's card arrived as
 * application/octet-stream and is a perfectly good JPEG, and a file called card.jpg can be
 * anything. Four formats a browser draws natively and nothing else — SVG in particular is
 * refused, because an SVG can carry script and these are served back to the operator.
 */
export function sniffImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  }
  if (bytes.length < 12) return { ok: false, reason: "too small to be an image" };
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ok: true, ext: "jpg", contentType: "image/jpeg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { ok: true, ext: "png", contentType: "image/png" };
  }
  const head = String.fromCharCode(...b.slice(0, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return { ok: true, ext: "gif", contentType: "image/gif" };
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return { ok: true, ext: "webp", contentType: "image/webp" };
  return { ok: false, reason: "not a JPEG, PNG, GIF or WebP image" };
}

/** Worth downloading to sniff? Images by name or type, and the octet-stream that hides them. */
export function mightBeImage(name: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/") && !ct.includes("svg")) return true;
  if (ct === "application/octet-stream" || ct === "") return /\.(jpe?g|png|gif|webp|jfif)$/i.test(name);
  return /\.(jpe?g|png|gif|webp|jfif)$/i.test(name) && !ct.startsWith("text/");
}

// ---------------------------------------------------------------------------
// Links in a notice
// ---------------------------------------------------------------------------

/** Every http(s) link in an HTML or text body, entities decoded, in order. */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const decoded = raw.replace(/&amp;/gi, "&").replace(/&#x2f;/gi, "/").replace(/&#47;/g, "/").trim();
    let u: URL;
    try {
      u = new URL(decoded);
    } catch {
      return;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    if (!seen.has(u.href)) {
      seen.add(u.href);
      out.push(u.href);
    }
  };
  for (const m of body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) if (m[1]) add(m[1]);
  for (const m of body.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) add(m[0]);
  return out;
}

/**
 * The link most likely to be the card: on the card site's own domain, not an unsubscribe,
 * settings or logo link. Falls back to the first plausible link for an "other" notice.
 */
export function pickNoticeLink(links: string[], site: NoticeSite): string | null {
  const boring = /unsubscribe|optout|opt-out|preferences|privacy|facebook|twitter|x\.com|instagram|\.(png|gif|jpe?g|css)(\?|$)/i;
  const usable = links.filter((l) => !boring.test(l));
  const domain = Object.entries(NOTICE_DOMAINS).find(([, s]) => s === site)?.[0];
  if (domain) {
    const on = usable.find((l) => {
      const h = new URL(l).hostname.toLowerCase();
      return h === domain || h.endsWith(`.${domain}`);
    });
    if (on) return on;
  }
  // A notice from a station's own domain (W8ABC's) usually links to one of the card sites.
  for (const d of Object.keys(NOTICE_DOMAINS)) {
    const on = usable.find((l) => {
      const h = new URL(l).hostname.toLowerCase();
      return h === d || h.endsWith(`.${d}`);
    });
    if (on) return on;
  }
  return usable[0] ?? null;
}

/** Which card site a link is on. */
export function siteOfLink(link: string): NoticeSite {
  try {
    return siteForDomain(new URL(link).hostname.toLowerCase()) ?? "other";
  } catch {
    return "other";
  }
}

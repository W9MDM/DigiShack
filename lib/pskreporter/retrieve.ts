// PSKReporter reception reports — who heard US.
//
// The other direction from upload.ts. That one sends the stations we decode, so DigiShack
// appears as a receiver on the coverage maps; this one asks PSKReporter which receivers
// reported hearing our transmissions, which is the only way to find out that the antenna
// is working, or that it is not.
//
// https://pskreporter.info/pskdev.html — the retrieval query is documented there, loosely.
//
// Read-only, no credentials, and rate limited hard. PSKReporter is a free service run on
// donated hardware and it asks automated users not to repeat a query more often than once
// every five minutes. It enforces that with a 503 and a plain-text scolding, and the
// remedy for being blocked is an email to a person. Honour the limit.

const QUERY_HOST = "https://retrieve.pskreporter.info/query";

/**
 * PSKReporter's stated minimum gap between identical queries.
 *
 * The same number the uploader uses, for the same reason and from the same page.
 */
export const MIN_QUERY_INTERVAL_MS = 5 * 60_000;

/**
 * How far back a query may reach.
 *
 * Their documentation allows a day; asking for one moves a great deal of XML to find
 * reports of a handful of transmissions, and every report older than the last poll has
 * already been stored. A quarter of an hour covers an ordinary poll cycle several times
 * over, which is what a lookback is for — the boundary, not the history.
 */
export const MAX_LOOKBACK_SECONDS = 3_600;
export const DEFAULT_LOOKBACK_SECONDS = 900;

export interface ReceptionReport {
  receiverCall: string;
  receiverGrid: string | null;
  /** The station the receiver heard. Ours, unless the query went wrong. */
  senderCall: string;
  snr: number | null;
  freqHz: number;
  /** When the transmission they heard went out. */
  reportedAt: Date;
  mode: string | null;
}

/**
 * Build the query URL.
 *
 * `rronly=1` asks for reception reports without the active-receiver list, which is the
 * bulk of the response and is of no interest here.
 *
 * `appcontact` is not optional in spirit. PSKReporter asks automated users to identify
 * themselves so they can make contact before blocking anyone, and honouring that is the
 * difference between an email and a ban.
 */
export function buildQueryUrl(opts: {
  senderCallsign: string;
  lookbackSeconds?: number;
  contact?: string | null;
}): string {
  const back = Math.max(
    60,
    Math.min(MAX_LOOKBACK_SECONDS, Math.round(opts.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS)),
  );
  const params = new URLSearchParams({
    senderCallsign: opts.senderCallsign.toUpperCase(),
    // Negative means "seconds before now" in their query language.
    flowStartSeconds: String(-back),
    rronly: "1",
  });
  if (opts.contact) params.set("appcontact", opts.contact);
  return `${QUERY_HOST}?${params.toString()}`;
}

/** Read one XML attribute off a tag. Their attribute values never contain a quote. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(tag);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/**
 * Parse the reception reports out of a query response.
 *
 * Read with a regex rather than an XML parser, deliberately and consistently with the
 * rest of this project: the response is a flat list of attribute-only elements, there is
 * no nesting to get wrong, and an XML dependency to read six attributes would be the
 * larger risk.
 *
 * A report missing a receiver callsign, a frequency or a time is dropped. Those three are
 * the report — without them there is nothing to store and nothing to attach it to, and
 * inventing a value would put a reception report in the log that nobody sent.
 */
export function parseReceptionReports(xml: string): ReceptionReport[] {
  const out: ReceptionReport[] = [];
  // Self-closing or not; PSKReporter has used both.
  const tags = xml.match(/<receptionReport\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    const receiverCall = attr(tag, "receiverCallsign");
    const senderCall = attr(tag, "senderCallsign");
    const freqRaw = attr(tag, "frequency");
    const whenRaw = attr(tag, "flowStartSeconds");
    if (!receiverCall || !freqRaw || !whenRaw) continue;

    const freqHz = Number.parseInt(freqRaw, 10);
    const seconds = Number.parseInt(whenRaw, 10);
    if (!Number.isFinite(freqHz) || freqHz <= 0) continue;
    if (!Number.isFinite(seconds) || seconds <= 0) continue;

    // sNR is the spelling in their XML, and it is legitimately absent for modes that
    // do not report one. Absent is not zero: 0 dB is a strong signal.
    const snrRaw = attr(tag, "sNR");
    const snr = snrRaw === null ? null : Number.parseInt(snrRaw, 10);

    out.push({
      receiverCall: receiverCall.toUpperCase(),
      receiverGrid: attr(tag, "receiverLocator")?.toUpperCase() ?? null,
      senderCall: (senderCall ?? "").toUpperCase(),
      snr: snr !== null && Number.isFinite(snr) ? snr : null,
      freqHz,
      reportedAt: new Date(seconds * 1_000),
      mode: attr(tag, "mode")?.toUpperCase() ?? null,
    });
  }

  return out;
}

/**
 * True when the response is PSKReporter telling us to slow down.
 *
 * It answers a too-frequent query with a 503 and a sentence of prose rather than XML.
 * Recognising it matters because the alternative is logging "0 reports" and concluding
 * nobody heard us — the reading that would send an operator to check their antenna.
 */
export function isRateLimited(status: number, body: string): boolean {
  if (status === 503) return true;
  return /too often|rate limit|slow down/i.test(body.slice(0, 500));
}

export interface FetchResult {
  ok: boolean;
  reports: ReceptionReport[];
  /** Set when the fetch failed or was refused. */
  error?: string;
  rateLimited?: boolean;
}

/**
 * Ask PSKReporter who heard us.
 *
 * Never throws: this runs on a timer inside the radio bridge, and an unhandled rejection
 * there takes the radio down with it. A failure is a result, not an exception.
 */
export async function fetchReceptionReports(opts: {
  senderCallsign: string;
  lookbackSeconds?: number;
  contact?: string | null;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}): Promise<FetchResult> {
  const url = buildQueryUrl(opts);
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  timer.unref?.();

  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "DigiShack" },
    });
    const body = await res.text();

    if (isRateLimited(res.status, body)) {
      return {
        ok: false,
        reports: [],
        rateLimited: true,
        error: "PSKReporter refused the query as too frequent",
      };
    }
    if (!res.ok) {
      return { ok: false, reports: [], error: `PSKReporter returned ${res.status}` };
    }
    return { ok: true, reports: parseReceptionReports(body) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, reports: [], error: why };
  } finally {
    clearTimeout(timer);
  }
}

// Fill the operator's licence class from their callsign, via hamdb.org.
//
// A US callsign no longer ENCODES the class — vanity calls broke the old 1x2=Extra
// heuristic in the 1990s — so the class has to come from a lookup, not a parse. HamDB is
// free, US-focused, and needs no account: GET https://api.hamdb.org/v1/<call>/json/<app>.
// It is a convenience that FILLS a field the operator can still override; it is never on a
// transmit path and a failure just returns null (keep the existing setting).

import type { LicenceClass } from "@/lib/radio/sstv-licence";

export interface HamdbLookup {
  call: string;
  /** The FCC licence class letter HamDB reports: N, T, G, A or E. */
  classLetter: string;
  /** Mapped to DigiShack's SSTV licence class; "other" for a non-US licence. */
  licenceClass: LicenceClass;
  grid: string | null;
  name: string | null;
  state: string | null;
  country: string | null;
}

/** HamDB's single-letter class -> DigiShack's SSTV licence class. */
export function licenceClassFromHamdb(classLetter: string, country: string | null): LicenceClass {
  // A non-US licence has its own band plan; DigiShack models only the US phone sub-bands,
  // so anything outside the US maps to "other" (SSTV gating then defers to local rules).
  if (country && !/united states/i.test(country)) return "other";
  switch (classLetter.trim().toUpperCase()) {
    case "E":
      return "us-extra";
    case "A":
      return "us-advanced";
    case "G":
      return "us-general";
    case "T":
      return "us-technician";
    // Novice: HF phone only on 10 m (28.3-28.5 MHz), which is exactly the Technician phone
    // sub-band DigiShack models, so Technician is the closest safe match — there is no
    // us-novice class, and Novices are all but extinct.
    case "N":
      return "us-technician";
    default:
      return "other";
  }
}

/**
 * Parse a HamDB JSON body into a lookup, or null if it is not a clean hit.
 *
 * Separated from the fetch so it is testable without a network: HamDB answers a miss with
 * HTTP 200 and `messages.status = "NOT_FOUND"`, filling every field with the literal
 * "NOT_FOUND", so a hit is confirmed by the returned call matching what was asked.
 */
export function parseHamdb(data: unknown, expectedCall: string): HamdbLookup | null {
  const root = (data as { hamdb?: { callsign?: Record<string, unknown>; messages?: { status?: unknown } } })?.hamdb;
  const cs = root?.callsign;
  if (!cs || typeof cs.call !== "string" || !cs.call) return null;
  const status = root?.messages?.status;
  if (status && String(status).toUpperCase() !== "OK") return null;
  if (cs.call.toUpperCase() !== expectedCall.trim().toUpperCase()) return null;
  const clean = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s && s.toUpperCase() !== "NOT_FOUND" ? s : null;
  };
  const country = clean(cs.country);
  const name = [clean(cs.fname), clean(cs.name)].filter(Boolean).join(" ").trim() || null;
  return {
    call: cs.call,
    classLetter: clean(cs.class) ?? "",
    licenceClass: licenceClassFromHamdb(typeof cs.class === "string" ? cs.class : "", country),
    grid: clean(cs.grid),
    name,
    state: clean(cs.state),
    country,
  };
}

/** Look up a callsign at HamDB. Returns null on any failure — it is a convenience, not a gate. */
export async function lookupHamdb(
  call: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<HamdbLookup | null> {
  const c = call.trim().toUpperCase();
  // Bare call or call with a /P style suffix; reject anything that is not a plausible call.
  if (!/^[A-Z0-9]+(\/[A-Z0-9]+)?$/.test(c) || c.length < 3) return null;
  const url = `https://api.hamdb.org/v1/${encodeURIComponent(c)}/json/digishack`;
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: { "user-agent": "DigiShack" } });
    if (!res.ok) return null;
    return parseHamdb(await res.json(), c);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

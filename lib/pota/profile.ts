// POTA profile, stats and awards from api.pota.app.
//
// A read-only public endpoint — no key, no account, nothing to configure. One call to
// `/profile/{callsign}` returns the lot: activator and hunter totals, every award with
// its endorsements, and recent activity on both sides.
//
// Cached, and failing soft like everything else that reaches outside this machine.
// POTA runs on donated infrastructure and a logging program polling it hard on every
// page view is exactly the behaviour that gets an app blocked.

const PROFILE_URL = "https://api.pota.app/profile";

/** Profiles change when you log a park, not by the second. */
const TTL_MS = 10 * 60_000;

const cache = new Map<string, { at: number; value: PotaProfile }>();
const inFlight = new Map<string, Promise<PotaProfile | null>>();

export interface PotaActivatorStats {
  activations: number;
  parks: number;
  qsos: number;
}

export interface PotaHunterStats {
  parks: number;
  qsos: number;
}

export interface PotaAward {
  name: string;
  granted: string | null;
  /**
   * Bands and modes this award has been endorsed for.
   *
   * POTA awards work on endorsements rather than levels alone — "Bronze Hunter" with
   * 13 band and mode endorsements is a very different achievement from the bare award,
   * and hiding them would throw away most of what the profile says.
   */
  endorsements: string[];
}

export interface PotaActivation {
  date: string;
  reference: string;
  park: string;
  location: string | null;
  cw: number;
  data: number;
  phone: number;
  total: number;
}

export interface PotaHunterQso {
  date: string;
  callsign: string;
  band: string | null;
  mode: string | null;
  reference: string;
  park: string;
  location: string | null;
}

export interface PotaProfile {
  callsign: string;
  name: string | null;
  qth: string | null;
  grid: string | null;
  activator: PotaActivatorStats;
  /** Attempts include activations that fell short of the 10-QSO threshold. */
  attempts: PotaActivatorStats;
  hunter: PotaHunterStats;
  awardCount: number;
  endorsementCount: number;
  awards: PotaAward[];
  recentActivations: PotaActivation[];
  recentHunterQsos: PotaHunterQso[];
  fetchedAt: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Shape the API response into something typed.
 *
 * Every field is read defensively. This is a third-party API with no published
 * contract, and a page that throws because one key was renamed is worse than a page
 * showing zeros — the operator can see zeros are wrong.
 */
export function parsePotaProfile(raw: unknown, callsign: string): PotaProfile {
  const d = (raw ?? {}) as Record<string, unknown>;
  const stats = (d.stats ?? {}) as Record<string, unknown>;
  const recent = (d.recent_activity ?? {}) as Record<string, unknown>;

  const activator = (stats.activator ?? {}) as Record<string, unknown>;
  const attempts = (stats.attempts ?? {}) as Record<string, unknown>;
  const hunter = (stats.hunter ?? {}) as Record<string, unknown>;

  const awardsRaw = Array.isArray(d.awards) ? d.awards : [];
  const actsRaw = Array.isArray(recent.activations) ? recent.activations : [];
  const huntRaw = Array.isArray(recent.hunter_qsos) ? recent.hunter_qsos : [];

  return {
    callsign: str(d.callsign) ?? callsign.toUpperCase(),
    name: str(d.name),
    qth: str(d.qth),
    // POTA returns mixed case ("EN61aa"); grids are conventionally upper.
    grid: str(d.grid)?.toUpperCase() ?? null,
    activator: {
      activations: num(activator.activations),
      parks: num(activator.parks),
      qsos: num(activator.qsos),
    },
    attempts: {
      activations: num(attempts.activations),
      parks: num(attempts.parks),
      qsos: num(attempts.qsos),
    },
    hunter: { parks: num(hunter.parks), qsos: num(hunter.qsos) },
    awardCount: num(stats.awards),
    endorsementCount: num(stats.endorsements),
    awards: awardsRaw.map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return {
        name: str(x.name) ?? "(unnamed)",
        granted: str(x.granted),
        endorsements: Array.isArray(x.endorsements)
          ? x.endorsements.filter((e): e is string => typeof e === "string")
          : [],
      };
    }),
    recentActivations: actsRaw.map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return {
        date: str(x.date) ?? "",
        reference: str(x.reference) ?? "",
        park: str(x.park) ?? "",
        location: str(x.location),
        cw: num(x.cw),
        data: num(x.data),
        phone: num(x.phone),
        total: num(x.total),
      };
    }),
    recentHunterQsos: huntRaw.map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return {
        date: str(x.date) ?? "",
        callsign: str(x.callsign) ?? "",
        band: str(x.band),
        mode: str(x.mode),
        reference: str(x.reference) ?? "",
        park: str(x.park) ?? "",
        location: str(x.location),
      };
    }),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch a POTA profile.
 *
 * Returns null rather than throwing when POTA is unreachable or does not know the
 * callsign — an operator who has never worked a park is an ordinary case, not an error.
 */
export async function fetchPotaProfile(callsign: string): Promise<PotaProfile | null> {
  const key = callsign.trim().toUpperCase();
  if (!/^[A-Z0-9/]{3,16}$/.test(key)) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`${PROFILE_URL}/${encodeURIComponent(key)}`, {
        headers: { "User-Agent": "DigiShack (amateur radio logger)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return cache.get(key)?.value ?? null;
      const parsed = parsePotaProfile(await res.json(), key);
      cache.set(key, { at: Date.now(), value: parsed });
      return parsed;
    } catch {
      return cache.get(key)?.value ?? null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

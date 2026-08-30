// Choosing where to hop.
//
// Pure, and separate from the auto-operator for the same reason the schedule is:
// "which band should we move to" needs no radio, no socket and no network, and it is
// exactly the kind of decision that is awkward to observe live — a wrong answer costs
// an operator a band change and two quiet cycles before anything looks amiss.

export interface BandActivity {
  band: string;
  /** Distinct stations transmitting there, as the PSKReporter network sees them. */
  transmitting: number;
}

/**
 * The band on the hop list with the most stations on it right now.
 *
 * Null means "no better answer than rotating", and every route to null is a real
 * case the caller must handle by falling back:
 *
 *   * no activity data at all — the network is unreachable
 *   * nothing on the hop list is being seen
 *   * the only band being seen is the one already tuned
 *
 * ONLY bands on the list are considered. The list is the operator's statement of what
 * this antenna can work; 6 m being wide open is worth nothing to a station that
 * cannot transmit on it, and a hop there would strand the session on a dead band.
 *
 * Ties break toward the earlier entry on the list, so an operator's ordering still
 * means something when two bands are equally busy.
 */
/**
 * Should we leave a working band because another one is far better?
 *
 * The gap this fills: band-hopping only ever triggered on a QUIET pause — a dead
 * band, or CQs going unanswered. A band that is merely WORSE than another never
 * triggered anything, so a station making contacts on 40 m at 62 stations sat there
 * while 20 m ran at 163. The operator watching the band strip could see it; the
 * software had no rule that looked.
 *
 * Deliberately a RATIO, not a difference. "Twice as busy" means the same thing at
 * 30 stations as at 300, where "80 more stations" is a rout on one band and noise on
 * the other. A ratio at or below 1 disables this entirely — that is the off switch.
 *
 * Returns null when the current band is unknown, when it is not being seen at all
 * (there is no ratio against zero, and a band we cannot measure is not evidence to
 * move), or when nothing on the list clears the bar.
 */
export function shouldHopForBetterBand(opts: {
  current: string | null;
  bands: readonly string[];
  activity: readonly BandActivity[] | null;
  /** How many times busier the target must be. <= 1 disables. */
  ratio: number;
}): { band: string; from: number; to: number } | null {
  const { current, bands, activity, ratio } = opts;
  if (ratio <= 1 || !current || !activity || activity.length === 0) return null;

  const seen = new Map<string, number>();
  for (const a of activity) {
    const b = a.band.toUpperCase();
    seen.set(b, Math.max(seen.get(b) ?? 0, a.transmitting));
  }

  const here = seen.get(current.toUpperCase()) ?? 0;
  // Nothing seen on the band we are ON. That is far more likely to mean the feed has
  // no reports from here yet than that the band is empty — we are making contacts on
  // it. Moving on that basis would be acting on missing data.
  if (here <= 0) return null;

  const best = pickBusiestBand(bands, current, activity);
  if (!best) return null;
  const there = seen.get(best) ?? 0;
  return there >= here * ratio ? { band: best, from: here, to: there } : null;
}

/**
 * A band this antenna can actually load, after the current one would not tune.
 *
 * High SWR is the one fault a band change genuinely fixes. PA temperature and a dead
 * receiver follow the radio wherever it goes, but SWR is antenna resonance: a dipole
 * that will not load on 80 m may be flat on 20 m, and after the ATU has already had
 * its go there is nothing left to try except somewhere else.
 *
 * Ordering, best first:
 *   1. bands measured BELOW the limit, lowest SWR first — known good beats hopeful
 *   2. bands never measured, in list order — worth a try
 *
 * Bands measured at or above the limit are excluded outright: the antenna has
 * already said no there, and cycling back would key a transmitter into a load that
 * tripped the guard once.
 */
/**
 * Was the move a mistake? Judged on what THIS receiver actually hears.
 *
 * The band-conditions figures come from PSKReporter, which is what the whole network
 * hears — hundreds of receivers, everywhere. It is the best available guide to where
 * the activity is and it says nothing whatever about what one antenna in one place
 * can hear. A band showing 163 stations worldwide can be dead from here: wrong time
 * of day for the path, wrong antenna for the angle, a local noise source.
 *
 * So a hop made on network figures has to be checked against reality, and reality is
 * decodes per cycle in this receiver. Returning is not a failure of the move; it is
 * the only way to find out, since nothing short of listening can tell you.
 *
 * `keepFraction` is deliberately well below 1: bands are not expected to match, only
 * to not be markedly worse. Requiring parity would bounce the radio back from a band
 * that was slightly quieter but full of stations it had never worked.
 */
export function shouldReturnToPreviousBand(opts: {
  /** Decodes per cycle measured since arriving. */
  hereRate: number;
  /** Decodes per cycle measured on the band we left. */
  thereRate: number;
  /** Fraction of the old rate the new band must reach to be worth staying on. */
  keepFraction: number;
}): boolean {
  const { hereRate, thereRate, keepFraction } = opts;
  // Nothing to compare against — the old band was never measured properly, so
  // there is no evidence the move was wrong.
  if (thereRate <= 0) return false;
  return hereRate < thereRate * keepFraction;
}

/** What the band we are sitting on has actually produced since we arrived. */
export interface BandPerformance {
  /** Decode counts per window, oldest first, for this stay on this band. */
  windows: readonly number[];
  /** Contacts completed here. */
  made: number;
  /** Contacts abandoned here — called, and nobody came back. */
  lost: number;
}

export interface UnproductiveVerdict {
  /** Wording for the log and the operator. */
  reason: string;
}

/**
 * Has the band we are ON stopped paying?
 *
 * Two independent triggers, because a band can fail in two quite different ways and
 * only one of them is visible in the decode count.
 *
 *  1. IT WENT QUIET. Compares the second half of this stay against the first, so the
 *     band is judged against ITSELF rather than against a threshold — 3 decodes a
 *     cycle is a dead 20 m afternoon and a busy 160 m night, and no fixed number is
 *     right for both.
 *
 *  2. NOBODY ANSWERS. Measured from this station's own logs across ~750 attempts,
 *     contacts complete 66% of the time at 0..-5 dB, 67% at -6..-10, 51% at -11..-15
 *     and 48% at -16..-20. So roughly half is NORMAL, and a band has to be well under
 *     that before it means anything. Hearing plenty and working nobody is the case
 *     the decode count alone will never catch — and it is the one that wastes the
 *     most time, since every failed attempt costs four transmit cycles.
 *
 * Returns null when the band is fine OR when there is not enough evidence yet.
 * Deciding early is worse than not deciding: a band change costs two warm-up cycles
 * and throws away whatever was working.
 */
export function bandIsUnproductive(opts: {
  here: BandPerformance;
  /** Windows needed before the quiet test means anything. */
  minWindows: number;
  /** Second half must fall below this fraction of the first. */
  decayFraction: number;
  /** Contact attempts needed before the success test means anything. */
  minAttempts: number;
  /** Success at or below this over `minAttempts` says the band is not paying. */
  minSuccess: number;
  /**
   * Decodes per cycle at or below which a band counts as quiet.
   *
   * The contact-success trigger is gated on this: a band being heard well is one to
   * keep trying on however the last ten attempts went.
   */
  quietRate?: number;
  /**
   * The noise floor here, and the quietest this station has measured anywhere.
   *
   * Relative, with no absolute threshold anywhere — "high noise" is meaningless
   * without knowing what this receiver, antenna and location read on a good band.
   * Null on either side simply skips the test.
   */
  noise?: { hereDbm: number | null; quietestDbm: number | null };
  /** dB above the quietest known band before the floor counts as elevated. */
  noiseElevatedBy?: number;
  /** Decodes per cycle at or below which a noisy band is not worth sitting on. */
  noisyBandMaxRate?: number;
}): UnproductiveVerdict | null {
  const { here, minWindows, decayFraction, minAttempts, minSuccess } = opts;

  const heardRate =
    here.windows.length === 0
      ? 0
      : here.windows.reduce((a, b) => a + b, 0) / here.windows.length;

  // 1. Contacts are not completing — but ONLY when the band is also not hearing
  //    much.
  //
  // The guard on `heardRate` is the whole lesson of this rule's first afternoon on
  // air. It fired on 20 m at "2 of 10 contacts completed (20%)" and moved the radio
  // to 15 m. 20 m had been decoding ELEVEN stations a cycle; 15 m gave two, then
  // zero. The completion ratio was right and the decision was wrong.
  //
  // A low completion rate on a band you can hear is not a dead band, it is a busy
  // one: everybody is calling the same DX and 100 W does not win every pileup.
  // Contacts are lumpy — ten attempts is twenty minutes and one good run changes the
  // ratio completely — while decodes arrive every cycle and are the leading
  // indicator. So a band that is being heard well is one to stay on and keep trying,
  // and only a band that is BOTH not converting and not hearing is worth leaving.
  const attempts = here.made + here.lost;
  if (attempts >= minAttempts && heardRate <= (opts.quietRate ?? 4)) {
    const rate = here.made / attempts;
    if (rate <= minSuccess) {
      return {
        reason:
          `${here.made} of ${attempts} contacts completed here ` +
          `(${Math.round(rate * 100)}%) and only ${heardRate.toFixed(1)} decodes a cycle`,
      };
    }
  }

  // 2. Are we simply buried? A high floor AND little to show for sitting in it.
  //
  // Both halves are required. A noisy band that is still producing contacts is one
  // to stay on — the noise is not the point, what gets through it is. And a quiet
  // band with a low floor is just a quiet band, which the tests above cover.
  const noise = opts.noise;
  if (noise?.hereDbm != null && noise.quietestDbm != null && here.windows.length > 0) {
    const elevated = noise.hereDbm - noise.quietestDbm;
    if (elevated >= (opts.noiseElevatedBy ?? 10) && heardRate <= (opts.noisyBandMaxRate ?? 3)) {
      return {
        reason:
          `noise floor ${noise.hereDbm.toFixed(0)} dBm is ${elevated.toFixed(0)} dB above the ` +
          `quietest band this station has measured, and only ${heardRate.toFixed(1)} decodes a ` +
          `cycle are getting through it`,
      };
    }
  }

  // 3. Did the band fall away under us?
  if (here.windows.length >= minWindows) {
    const half = Math.floor(here.windows.length / 2);
    const early = here.windows.slice(0, half);
    const late = here.windows.slice(half);
    const mean = (xs: readonly number[]) =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const earlyRate = mean(early);
    const lateRate = mean(late);
    // No comparison to make against a band that was never producing anything —
    // that case belongs to the flat floor, not here.
    if (earlyRate > 0 && lateRate < earlyRate * decayFraction) {
      return {
        reason:
          `decodes fell from ${earlyRate.toFixed(1)} to ${lateRate.toFixed(1)} a cycle ` +
          `while we sat here`,
      };
    }
  }

  return null;
}

/** What a band actually OFFERED while we listened to it. */
export interface BandOffering {
  /**
   * Consecutive listening windows here in which nothing was callable.
   *
   * Windows, not minutes, and that is the whole reason this is not a duration. A
   * window is one complete transmission from everybody on frequency, which is the
   * unit of evidence — and it is 15 s on FT8, 7.5 s on FT4 and 3.75 s on FT2. Twenty
   * windows is twenty complete looks at the band in every one of them; twenty
   * MINUTES is eighty looks in one mode and three hundred and twenty in another,
   * which would make the same rule mean four different things.
   */
  windowsWithNobody: number;
  /** Distinct stations heard calling CQ during that streak. */
  cqsHeard: number;
  /**
   * Ranked candidates the operating guards refused during the streak.
   *
   * Counted per refusal, not per station, so it is NOT comparable with `cqsHeard` —
   * the same dupe refused in ten windows is ten. It is only ever asked whether it is
   * zero, which separates "the guards said no to everyone" from "nothing here scored
   * highly enough to try".
   */
  refused: number;
  /** Decode counts per window, oldest first, for this stay on this band. */
  windows: readonly number[];
}

/**
 * Is there simply NOBODY TO CALL here?
 *
 * THE FAULT. Observed live on 30 Aug at 09:08. The station had settled on 17 m at
 * 09:03 with 3 decodes in the window, 17 in the rolling buffer, and 0 calls, 0
 * contacts and 0 abandoned attempts since arriving. Both existing escapes were mute
 * and neither could ever have fired:
 *
 *   * "band too quiet" wants LITERALLY ZERO decodes. It works — it fired twice that
 *     same morning, at 07:56 and 08:40 — but 3 decodes is not 0, so it had nothing
 *     to say about a band that is decoding a little.
 *   * "not paying" wants `minAttempts` contact attempts before a success rate means
 *     anything, and 8 is the right number for a ratio. But the attempt count here
 *     was ZERO and could not grow, because there was nobody to attempt. A rule that
 *     divides by attempts can never fire on a band that offers none.
 *
 * So the two triggers between them cover "we hear nothing" and "we hear plenty and
 * convert none of it", and the gap between those is a real and common condition: a
 * dead band with two beacons on it, a band where everything audible is already in
 * the log, or one where every station heard is mid-QSO with somebody else. The
 * decode count says the band is alive. The contact count says nothing at all,
 * forever.
 *
 * WHAT IS MEASURED IS WORKABLE STATIONS — not decodes, and not attempts. The count
 * comes from the hunt's own ranking and its own `mayCall`, which run every window
 * anyway; nothing here re-derives worth and nothing here costs a query. See
 * `AutoOperator.noteHuntOutcome`.
 *
 * REJECTED: a decode-rate floor ("under N a cycle, leave"). That is the flat
 * threshold `bandIsUnproductive` exists to avoid — 3 decodes a cycle is a dead 20 m
 * afternoon and a busy 160 m night — and it would have fired on the 17 m case for
 * the wrong reason, then fired again on a band that was quiet but full of new ones.
 *
 * REJECTED: requiring some decodes before this may fire. A band with genuinely
 * nothing on it that we merely SAT DOWN on — after a restart, or because the network
 * never showed anything better — is never reached by the quiet trigger at all, since
 * that only runs at the end of a hop's warm-up. Silence gets its own wording rather
 * than its own exemption.
 *
 * Returns null when the streak is too short to mean anything, and when `minWindows`
 * is zero or less, which is the off switch.
 */
export function bandHasNobodyToCall(opts: {
  here: BandOffering;
  /** Consecutive empty windows before this means anything. <= 0 disables. */
  minWindows: number;
}): UnproductiveVerdict | null {
  const { here, minWindows } = opts;
  if (minWindows <= 0) return null;
  if (here.windowsWithNobody < minWindows) return null;

  const rate =
    here.windows.length === 0
      ? 0
      : here.windows.reduce((a, b) => a + b, 0) / here.windows.length;
  const w = here.windowsWithNobody;
  const one = here.cqsHeard === 1;
  const s = one ? "" : "s";
  const every = one ? "it was refused" : "every one was refused";

  // Nobody called CQ at all. Said separately because it is a different fact about
  // the band from "they called and we could not work them", and an operator reading
  // the log needs to know which one they are looking at.
  if (here.cqsHeard === 0) {
    return {
      reason:
        `${w} windows here without a single CQ to answer, at ${rate.toFixed(1)} decodes a cycle`,
    };
  }

  // They were there and the guards said no to every one of them: already worked,
  // cooling down after a failed attempt, or on the do-not-call list. The band is
  // being heard perfectly well and has nothing on it FOR US, which is the same
  // number of contacts an hour as a dead one.
  if (here.refused > 0) {
    return {
      reason:
        `${here.cqsHeard} station${s} called CQ here in ${w} windows and ${every} ` +
        `as a dupe, a cooldown or a do-not-call, while ${rate.toFixed(1)} ` +
        `decodes a cycle are being heard`,
    };
  }

  // They were there and none of them scored: below the SNR floor, or nothing new on
  // a station running "new ones only". Also the operator's own settings, and also
  // zero contacts an hour.
  return {
    reason:
      `${here.cqsHeard} station${s} called CQ here in ${w} windows and not one was worth ` +
      `calling, at ${rate.toFixed(1)} decodes a cycle`,
  };
}

export function pickBandForSwr(opts: {
  bands: readonly string[];
  current: string | null;
  /** SWR last measured while transmitting on each band. */
  swrByBand: ReadonlyMap<string, number>;
  /** The guard's limit — at or above this a band is refused. */
  limit: number;
}): string | null {
  const { bands, current, swrByBand, limit } = opts;
  const here = current?.toUpperCase() ?? null;

  const known: { band: string; swr: number }[] = [];
  const untried: string[] = [];

  for (const raw of bands) {
    const band = raw.toUpperCase();
    if (band === here) continue;
    const swr = swrByBand.get(band);
    if (swr === undefined) {
      untried.push(band);
    } else if (swr < limit) {
      known.push({ band, swr });
    }
    // At or above the limit: the antenna has already refused this one.
  }

  known.sort((a, b) => a.swr - b.swr);
  return known[0]?.band ?? untried[0] ?? null;
}

export function pickBusiestBand(
  bands: readonly string[],
  current: string | null,
  activity: readonly BandActivity[] | null,
): string | null {
  if (!activity || activity.length === 0) return null;

  const seen = new Map<string, number>();
  for (const a of activity) {
    const b = a.band.toUpperCase();
    // The feed can carry a band more than once; keep the largest rather than
    // whichever happened to arrive last.
    seen.set(b, Math.max(seen.get(b) ?? 0, a.transmitting));
  }

  const here = current?.toUpperCase() ?? null;
  let best: { band: string; n: number } | null = null;
  for (const raw of bands) {
    const band = raw.toUpperCase();
    if (band === here) continue;
    const n = seen.get(band) ?? 0;
    // `>` not `>=`: first entry wins a tie.
    if (n > 0 && (best === null || n > best.n)) best = { band, n };
  }
  return best?.band ?? null;
}

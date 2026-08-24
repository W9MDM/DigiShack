// How far away the radio is, in milliseconds.
//
// The SNTP correction in lib/time/clock.ts fixes what this MACHINE thinks the time is.
// It cannot see the network between this machine and the radio — and over a VPN that
// path is not free. Every transmission is late by the one-way transit: the key command
// and the audio both have to travel to the radio before any RF leaves the antenna. And
// every received sample is old by the same amount when it arrives, so decode windows
// cut on the wall clock capture audio shifted late — which eats DT headroom from the
// top and biases every dt reading high by the transit time.
//
// A clock corrected to the millisecond with 150 ms of unmeasured VPN in front of the
// radio is a station transmitting 150 ms late with a log that swears it was on time.
//
// So the transit is measured, from traffic both radios already carry: the FlexRadio's
// TCP command/reply round trip, and the Icom's keepalive pings (whose reply echoes four
// opaque bytes — a timestamp fits). One-way is estimated as half the round trip; the
// path is symmetric enough for FT8, whose decoder tolerates ±1.2 s of dt.
//
// THE ESTIMATOR IS THE MINIMUM, NOT THE MEAN. An RTT sample is the true path delay plus
// whatever queueing, VPN crypto batching and event-loop lag happened to that one packet
// — noise that only ever ADDS. The smallest recent sample is therefore the closest look
// at the real path anyone gets, and averaging would fold everyone's bad luck into a
// number that drifts with load. (NTP filters its samples the same way, for the same
// reason.)

/**
 * Below this, no compensation is applied.
 *
 * A LAN round trip is a millisecond or two; "compensating" for it is pretending to a
 * precision the event loop does not have, and it would make every local install carry a
 * correction of zero-ish that reads as though something was wrong.
 */
export const MIN_LINK_COMPENSATION_MS = 10;

/**
 * Compensation is capped here, and a link this slow is reported rather than hidden.
 *
 * Not a safety margin — a diagnosis, same reasoning as MAX_CORRECTION_MS on the clock.
 * Two seconds of one-way transit is not a link that needs nudging: the decoder's own dt
 * window is ±1.2 s, so audio that old straddles window boundaries whatever we do, and
 * keying two seconds early on a jittery link risks landing in the PREVIOUS window.
 */
export const MAX_LINK_COMPENSATION_MS = 1_000;

/** Samples older than this stop counting. A VPN rerouted an hour ago is not now. */
const SAMPLE_TTL_MS = 5 * 60_000;

/** Enough history to let the minimum find a quiet packet, small enough to adapt. */
const SAMPLE_LIMIT = 20;

export interface LinkState {
  /** Best (minimum) recent round trip, ms. */
  rttMs: number;
  /** The compensation actually applied to keying and decode windows, ms. */
  oneWayMs: number;
  /** How many samples the estimate stands on. */
  samples: number;
  /** When the newest sample arrived (OS clock ms). */
  at: number;
}

export class LinkLatency {
  private samples: { rtt: number; at: number }[] = [];

  /** Record one measured round trip. Garbage (negative, absurd) is dropped, not clamped. */
  sample(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 30_000) return;
    this.samples.push({ rtt: rttMs, at: Date.now() });
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }

  /** Minimum live round trip, or null before the first sample (or after all expired). */
  rttMs(): number | null {
    const cutoff = Date.now() - SAMPLE_TTL_MS;
    this.samples = this.samples.filter((s) => s.at > cutoff);
    if (this.samples.length === 0) return null;
    return Math.min(...this.samples.map((s) => s.rtt));
  }

  /**
   * The compensation to apply, ms — half the best round trip, floored and capped.
   *
   * Returns 0 rather than null when unknown: every consumer treats "no measurement"
   * and "too small to matter" identically, as no adjustment.
   */
  oneWayMs(): number {
    const rtt = this.rttMs();
    if (rtt === null) return 0;
    const oneWay = Math.round(rtt / 2);
    if (oneWay < MIN_LINK_COMPENSATION_MS) return 0;
    return Math.min(oneWay, MAX_LINK_COMPENSATION_MS);
  }

  /** For status reporting. Null before any measurement survives the TTL. */
  state(): LinkState | null {
    const rtt = this.rttMs();
    if (rtt === null) return null;
    return {
      rttMs: Math.round(rtt),
      oneWayMs: this.oneWayMs(),
      samples: this.samples.length,
      at: this.samples[this.samples.length - 1]?.at ?? 0,
    };
  }

  reset(): void {
    this.samples = [];
  }
}

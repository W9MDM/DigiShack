// JS8 automatic replies: what a station answers on its own, and what it leaves alone.
//
// A JS8 station is expected to take part: when it hears a heartbeat it acknowledges it
// with the signal report ("KK4COV HEARTBEAT SNR -06", which is how the four stations in
// 1.198.1 answered ours), and when a station asks it something directly - SNR?, GRID?,
// INFO? - it answers from what it knows. JS8Call does both, each behind its own switch.
// This is the decision: given what a window decoded, the lines to send. The bridge turns
// each line into frames with js8BuildFrames and hands them to the sender one at a time.
//
// What is never answered: our own frames, CQs (an acknowledgement is for heartbeats),
// anything from a group (@ALLCALL has no QTH), a directed frame to anyone but us, and a
// station acknowledged within the cooldown - a heartbeat every few minutes from a
// station that never calls would otherwise have us keying every few minutes for it.

import { js8FormatSnr } from "@/lib/digital/js8-message";

export type Js8AutoReplyLevel = "off" | "hb" | "all";

export interface Js8Heard {
  kind: string;
  from?: string;
  to?: string;
  grid?: string;
  isCq?: boolean;
  cmdString?: string;
  snr: number;
}

export interface Js8AutoReplyOptions {
  /** off: nothing. hb: acknowledge heartbeats. all: that, and answer SNR?, GRID? and INFO? sent to us. */
  level: Js8AutoReplyLevel;
  mycall: string;
  mygrid: string;
  /** What INFO? gets. Upper-cased on the air by the message layer. */
  info: string;
  /** How long after acknowledging a station its next heartbeat is let go. Default 15 minutes. */
  cooldownMs?: number;
  now?: () => number;
}

/** The queries answered at level "all", and the line each gets. */
const QUERIES: Record<string, (from: string, o: Js8AutoReplyOptions, snr: number) => string | null> = {
  " SNR?": (from, _o, snr) => `${from} SNR ${js8FormatSnr(snr)}`,
  " GRID?": (from, o) => (o.mygrid ? `${from} GRID ${o.mygrid.slice(0, 4)}` : null),
  " INFO?": (from, o) => (o.info.trim() ? `${from} INFO ${o.info.trim()}` : null),
};

function isStation(call: string | undefined): call is string {
  return !!call && !call.startsWith("@");
}

export class Js8AutoReplier {
  private readonly acked = new Map<string, number>();

  constructor(private opts: Js8AutoReplyOptions) {}

  configure(opts: Partial<Js8AutoReplyOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  get level(): Js8AutoReplyLevel {
    return this.opts.level;
  }

  /** The lines to send for what a window decoded, in the order heard, one per station. */
  repliesFor(heard: readonly Js8Heard[]): string[] {
    const o = this.opts;
    if (o.level === "off" || !o.mycall) return [];
    const me = o.mycall.toUpperCase();
    const now = (o.now ?? Date.now)();
    const cooldown = o.cooldownMs ?? 15 * 60_000;
    const out: string[] = [];
    const answered = new Set<string>();
    for (const h of heard) {
      if (!isStation(h.from)) continue;
      const from = h.from.toUpperCase();
      if (from === me || answered.has(from)) continue;
      if (h.kind === "heartbeat" && !h.isCq) {
        const last = this.acked.get(from) ?? -Infinity;
        if (now - last < cooldown) continue;
        this.acked.set(from, now);
        answered.add(from);
        out.push(`${from} HEARTBEAT SNR ${js8FormatSnr(h.snr)}`);
        continue;
      }
      if (o.level !== "all" || h.kind !== "directed") continue;
      if ((h.to ?? "").toUpperCase() !== me) continue;
      const make = h.cmdString ? QUERIES[h.cmdString] : undefined;
      if (!make) continue;
      const line = make(from, o, h.snr);
      if (!line) continue;
      answered.add(from);
      out.push(line);
    }
    return out;
  }

  /** Forget the cooldowns: a new day, or a test. */
  reset(): void {
    this.acked.clear();
  }
}

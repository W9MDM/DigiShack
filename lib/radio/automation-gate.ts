// What starts the station when nobody is at the screen, and where it must not.
//
// The automatic modes - cq, hunt, hunt-pota, pota-chase - are an FT8 sequencer: they read
// structured messages and answer them. Four modes give them nothing to answer: WSPR is a
// beacon, RTTY and CW are text, JS8 has a conversation model of its own. The HTTP handler
// refuses to start an automatic mode on them, the Call button is not offered on their rows,
// and landing on one of their frequencies with a mode running stops it. Two paths start a
// mode WITHOUT an operator at the screen, and 1.197.0 found them on the air: the operating
// schedule at its morning boundary, and the resume after a restart. Both went straight to
// the operator. The resumed hunt ran five minutes on 40 m JS8, found no CQ, hopped to the
// next band's JS8 frequency - the hop tunes for the mode the decoder is on - and stopped
// itself on landing there. A station left on JS8 the evening before would have idled the
// whole scheduled day.
//
// The gate in front of those two paths does what the operator at the screen would: puts
// the radio on FT8 on the same band, then starts the mode. The hop is told the same thing
// in one place: a hop while on a mode with nothing to answer goes to the next band's FT8
// frequency, never to its JS8 one.

import type { AutoMode } from "@/lib/radio/auto-mode";
import type { SchedulableAuto } from "@/lib/radio/schedule-runner";

/** Modes with nothing for a sequencer to answer: no automatic mode runs on them and nothing is called. */
export const NO_SEQUENCER_MODES: ReadonlySet<string> = new Set(["WSPR", "RTTY", "CW", "JS8", "PSK31", "OLIVIA", "SSTV"]);

export function noSequencerReason(mode: string): string {
  if (mode === "WSPR") return "WSPR is receive-only: tune to an FT8, FT4 or FT2 frequency before starting an automatic mode";
  if (mode === "JS8") {
    return "JS8 has its own conversation model; the FT8 sequencer does not run on it. Tune to an FT8, FT4 or FT2 frequency for the automatic modes.";
  }
  return `${mode} has no sequencer: there are no structured messages to answer. Tune to an FT8, FT4 or FT2 frequency for the automatic modes.`;
}

/** The mode a band hop tunes for: the mode the station is answering, never one it cannot. */
export function hopModeFor<T extends string>(mode: T): T | "FT8" {
  return NO_SEQUENCER_MODES.has(mode) ? "FT8" : mode;
}

export interface AutomationGateDeps {
  /** The decoder's current mode, or null before the first window. */
  subMode: () => string | null;
  /** Put the radio on FT8 on its current band. Resolves true when the dial moved. */
  leave: (from: string) => Promise<boolean>;
  log: (line: string) => void;
}

/**
 * The operator as the schedule and the restart resume see it: a start on a mode with
 * nothing to answer first leaves that mode for FT8 on the same band, then starts.
 *
 * The retune is asynchronous and the start follows it, so the operator is never running
 * on JS8 even for a window. A retune that fails or throws starts the mode anyway and says
 * so: the mode then runs where it is, and its first band hop (see `hopModeFor`) lands it
 * on FT8. Turning off passes straight through.
 */
export function gateAutomation(auto: SchedulableAuto, deps: AutomationGateDeps): SchedulableAuto {
  return {
    get state() {
      return auto.state;
    },
    setMode(mode: AutoMode): void {
      const sub = deps.subMode();
      if (mode === "off" || !sub || !NO_SEQUENCER_MODES.has(sub)) {
        auto.setMode(mode);
        return;
      }
      deps.log(`${sub} has nothing for a sequencer to answer - tuning to FT8 on this band before starting ${mode}`);
      void deps
        .leave(sub)
        .then(
          (moved) => {
            if (!moved) deps.log(`could not leave ${sub}; starting ${mode} anyway - its first band hop lands on FT8`);
          },
          (err: unknown) => {
            deps.log(
              `could not leave ${sub} (${err instanceof Error ? err.message : String(err)}); starting ${mode} anyway - its first band hop lands on FT8`,
            );
          },
        )
        .then(() => auto.setMode(mode));
    },
  };
}

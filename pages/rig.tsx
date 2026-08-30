import type { GetServerSidePropsContext } from "next";
import { useEffect, useMemo, useRef, useState } from "react";

import { SourcePicker } from "@/components/radio/SourcePicker";
import { MODULATIONS, modulationForFrequency } from "@/lib/radio/modes";
import { Panadapter, snapHz, tuneStepFor } from "@/components/digital/Panadapter";
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { ReceiverAudio } from "@/lib/client/audio-player";
import { useBridgeSocket } from "@/lib/client/use-bridge-socket";
import { formatFreqDial, formatFreqMHz, parseFreqToHz } from "@/lib/ham/bands";
import { bandsFor, canTune, radioCapabilities } from "@/lib/radio/capabilities";
import { DIGITAL_FREQUENCIES } from "@/lib/ham/digital-freqs";
import {
  filterEdgesFor,
  filterMatches,
  type ReceiverControls,
} from "@/lib/radio/receiver-controls";
import { HelpTip } from "@/components/ui/HelpTip";
import { cn } from "@/lib/utils";

import { useVisibleInterval } from "@/lib/client/use-visible-interval";
// CAT control for the radio DigiShack is already connected to.
//
// This is deliberately not a general-purpose rig-control app: it exposes the
// controls that matter for digital operating and reads back what the radio
// actually reports, rather than assuming a command took effect. Anything that
// keys the transmitter is gated on `flex.allowTransmit` in the radio service —
// the UI does not get to decide that.

interface VoiceState {
  active: boolean;
  mode: string | null;
  since: number | null;
}

interface Telemetry {
  paTempC: number | null;
  swr: number | null;
  voltsPa: number | null;
  fanRpm: number | null;
  reflectedDbm: number | null;
  at: number;
}

interface RigStatus {
  connected: boolean;
  dialFrequency: number | null;
  band: string | null;
  mode: string | null;
  subMode: string | null;
  deCall: string | null;
  deGrid: string | null;
  transmitting: boolean;
  rfPower: number | null;
  commandChannel: boolean;
  /** Which radio the bridge is driving, for the picker below the Radio card. */
  source: "flex" | "icom" | "wsjtx" | null;
  /**
   * The radio's MODULATION — USB, LSB-D, CW.
   *
   * `mode` above is the digital mode on the Icom path and the slice's modulation on the
   * FlexRadio, which is why the modulation picker reads this instead.
   */
  radioMode: string | null;
  /** AGC / NB / NR / filter as the RADIO reports them. Null means not read yet, not "off". */
  receiver?: ReceiverControls;
  /** Voice mode: digital closed, radio in a microphone mode. */
  voice?: VoiceState;
}

interface Props extends Record<string, unknown> {
  wsUrl: string;
}

export default function RigPage({ wsUrl }: Props) {
  const { data, error, reload } = useApi<{
    running: boolean;
    reason?: string;
    status: RigStatus | null;
    telemetry: Telemetry | null;
  }>("/api/bridge/status");

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [freqInput, setFreqInput] = useState("");

  // ONE spectrum display on this page: the RF panadapter, tens of kHz of band with every
  // station on it, from the radio's own FFT.
  //
  // There used to be two. The second was the AUDIO passband — 0-3 kHz of what the
  // receiver is demodulating, which is ONE signal — and it was drawn here with an empty
  // markers array, so it was the same component doing none of its useful work. That
  // display earns its place on the Decodes page, where each decode's offset is marked on
  // it and it shows exactly the span the decoder searches. Here it was a second
  // waterfall of the same audio, above the fold, pushing the RF spectrum down the page.
  //
  // The two are not views of one thing and no setting bridges them: see
  // docs/panadapter.md. Nothing was merged — the audio waterfall was simply moved off a
  // page that had no use for it.
  //
  // Listening to the receiver.
  //
  // The player and its socket live in refs, not state: the scheduling cursor inside the
  // player must survive re-renders untouched, and this page re-renders every two seconds
  // from a status poll. Audio that stutters on every poll would be worse than none.
  const playerRef = useRef<ReceiverAudio | null>(null);
  const audioSocketRef = useRef<WebSocket | null>(null);
  /**
   * Marks the next socket close as deliberate, so `onclose` can tell a stop from a
   * failure. A ref rather than state for the same reason the socket is: it is read
   * inside a socket callback that closed over an older render.
   */
  const closeAudioIntentRef = useRef<(() => void) | null>(null);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [audioInfo, setAudioInfo] = useState<{
    rate: number;
    packets: number;
    context: string;
    bufferedMs: number;
    underruns: number;
  } | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Stop on the way out, always. A page left for another one would otherwise keep an audio
  // device open and a socket pulling 96 kB/s from the bridge for as long as the tab lived.
  useEffect(() => {
    return () => {
      // Same intent flag as an explicit stop: leaving the page is not a failure, and
      // without this the close handler would report a dead bridge into a component
      // that no longer exists.
      closeAudioIntentRef.current?.();
      audioSocketRef.current?.close();
      void playerRef.current?.stop();
    };
  }, []);

  async function startListening() {
    setAudioError(null);

    // The AudioContext is created HERE, in the click, before the socket is opened.
    //
    // It used to be created when the first message arrived with the sample rate — a network
    // round trip later — and every browser blocks audio started outside a user gesture. The
    // failure is silent: the context exists, packets are scheduled against it, and nothing
    // comes out of the speakers. That is what "I still don't hear any audio" was.
    const player = new ReceiverAudio();
    try {
      await player.start(volume);
    } catch {
      setAudioError("The browser would not start audio. Click Listen again.");
      return;
    }
    playerRef.current = player;

    try {
      const url = wsUrl.replace(/\/ws\/decodes$/, "/ws/audio");
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      audioSocketRef.current = ws;

      // Did the bridge ever tell us the format? A socket that opens and closes again
      // without a hello is a bridge that went away mid-connect — a restart, or a
      // proxy that upgraded the connection and then hung up. Without this the button
      // flicks to "Listening" and straight back with nothing said, which reads as a
      // dead button rather than as a bridge problem.
      let gotHello = false;
      // Deliberate stops must not raise an error. `stopListening` closes the socket,
      // which reaches the same onclose as a failure.
      let closingOnPurpose = false;
      closeAudioIntentRef.current = () => {
        closingOnPurpose = true;
      };

      ws.onopen = () => setListening(true);

      ws.onmessage = (ev) => {
        // The first frame is JSON and carries the sample rate; everything after it is PCM.
        // The Icom streams 48 kHz and the FlexRadio 24, so a player told the wrong one sounds
        // like fast forward or like it is under water.
        if (typeof ev.data === "string") {
          try {
            const hello = JSON.parse(ev.data) as { sampleRate?: number };
            const rate = hello.sampleRate ?? 0;
            if (!rate) {
              setAudioError(
                "The bridge has no radio audio to send — the source is an external decoder.",
              );
              ws.close();
              return;
            }
            gotHello = true;
            player.setSampleRate(rate);
            setAudioInfo({
              rate,
              packets: 0,
              context: player.state.contextState,
              bufferedMs: 0,
              underruns: 0,
            });
          } catch {
            setAudioError("Could not read the audio stream's format");
          }
          return;
        }
        player.push(ev.data as ArrayBuffer);
      };

      ws.onerror = () =>
        setAudioError(
          `Could not reach the audio stream at ${url}. The bridge listens on loopback only, ` +
            "so a browser on another machine needs bridge.wsUrl pointing at a proxy.",
        );
      ws.onclose = () => {
        setListening(false);
        void playerRef.current?.stop();
        playerRef.current = null;
        // Only when it went away by itself, and only when it never said what it was
        // sending — `setAudioError` in the hello handler has already given a better
        // reason than this one in the case where the bridge answered honestly.
        if (!closingOnPurpose && !gotHello) {
          setAudioError(
            `The audio stream at ${url} closed before sending anything. The bridge is ` +
              "probably not running — start it with `npm run bridge`.",
          );
        }
      };
    } catch {
      setAudioError("Could not open the audio connection");
      await player.stop();
      playerRef.current = null;
    }
  }

  async function stopListening() {
    // Tell the socket's own onclose that this was deliberate, BEFORE closing it.
    closeAudioIntentRef.current?.();
    audioSocketRef.current?.close();
    audioSocketRef.current = null;
    await playerRef.current?.stop();
    playerRef.current = null;
    setListening(false);
    // A stopped listener has no diagnostics. Leaving the last packet count on screen
    // implies audio is still arriving, and leaving an error implies the stop failed.
    setAudioInfo(null);
    setAudioError(null);
  }

  // A counter that proves audio is arriving, rather than a button that merely looks pressed.
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => {
      const st = playerRef.current?.state;
      if (st) {
        setAudioInfo({
          rate: st.sampleRate,
          packets: st.packets,
          context: st.contextState,
          bufferedMs: st.bufferedMs,
          underruns: st.underruns,
        });
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [listening]);

  const [pan, setPan] = useState<{ bins: Uint8Array; at: number } | null>(null);
  const [panScale, setPanScale] = useState<{
    centerHz: number;
    spanHz: number;
    binHz: number;
    // The dB window the bytes span. On the wire from the start; unused until the trace
    // grew a vertical scale, and a panadapter without one cannot tell a local station
    // from a marginal one.
    floorDb: number;
    ceilingDb: number;
    radio: string;
  } | null>(null);
  const { connected: wsConnected } = useBridgeSocket(wsUrl, (msg) => {
    if (msg.kind === "panadapter") {
      const m = msg as unknown as {
        bins: string;
        centerHz: number;
        spanHz: number;
        binHz: number;
        floorDb: number;
        ceilingDb: number;
        at: number;
        radio: string;
      };
      setPan({ bins: decodeSpectrumBins(m.bins), at: m.at });
      setPanScale({
        centerHz: m.centerHz,
        spanHz: m.spanHz,
        binHz: m.binHz,
        floorDb: m.floorDb,
        ceilingDb: m.ceilingDb,
        radio: m.radio,
      });
    }
  });

  const status = data?.status ?? null;
  const telemetry = data?.telemetry ?? null;
  const voice = status?.voice ?? null;
  const voiceOn = voice?.active === true;

  // What this radio actually has. Every control below asks rather than assuming —
  // see lib/radio/capabilities.ts for the three defects that made that necessary.
  const caps = radioCapabilities(status?.source ?? null);

  // The antenna ports, when the radio has a choice to offer.
  //
  // Not a capability in lib/radio/capabilities.ts, deliberately: the ports differ between
  // a 6300 and a 6600, and again with a transverter fitted, so a table there would be a
  // second opinion about hardware — and the radio states this itself in every slice
  // status (`ant_list`, `tx_ant_list`). Null when there is nothing to choose between,
  // which is a single-socket radio, an external decoder, or a radio that has not spoken
  // yet, and all three want the same thing: no picker.
  const antennas = useMemo(() => {
    const ports = status?.receiver?.antennas;
    if (!ports) return null;
    return ports.rx.length > 1 || ports.tx.length > 1 ? ports : null;
  }, [status?.receiver?.antennas]);

  // Where a band button lands. Two behaviours that used to be two separate rows of
  // identical-looking buttons, with the explanation at the bottom of the second one.
  const [bandTarget, setBandTarget] = useState<"calling" | "centre">("calling");

  // One entry per band, deduplicated.
  //
  // FT8 has TWO 6 m frequencies (50.313 and 50.323), and the row rendered `f.band`
  // only — so two identical `6M` buttons appeared with no way to tell them apart.
  // React never complained because the key included the frequency. The primary
  // (lowest) frequency wins and the exact number goes in the tooltip.
  const callingBands = useMemo(() => {
    const byBand = new Map<string, number>();
    for (const f of DIGITAL_FREQUENCIES) {
      if (f.mode !== "FT8") continue;
      if (!canTune(caps, f.hz)) continue;
      const seen = byBand.get(f.band);
      if (seen === undefined || f.hz < seen) byBand.set(f.band, f.hz);
    }
    return [...byBand].map(([band, hz]) => ({ band, hz }));
  }, [caps]);

  const centreBands = useMemo(
    () =>
      bandsFor(caps).map((b) => ({
        band: b.name,
        hz: Math.round((b.lowHz + b.highHz) / 2),
      })),
    [caps],
  );

  const bandButtons = bandTarget === "calling" ? callingBands : centreBands;

  // Poll: the radio can be changed from its own front panel or SmartSDR, and a
  // control panel showing stale values is worse than one showing none.
  //
  // Suspended while the tab is hidden — a control panel nobody is looking at is not
  // showing stale values, it is showing nothing, and two requests a second against a
  // locked phone is the most expensive thing this page does. The catch-up on return is
  // what makes the "stale is worse" argument still hold: the first thing a returning
  // operator sees is current.
  useVisibleInterval(() => reload(), 2_000);

  async function send(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError(null);
    try {
      await apiPost("/api/bridge/control", { action: "rig", ...body });
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Command failed");
    } finally {
      setBusy(null);
    }
  }

  // ---- Who is on the air, for the panadapter overlay ----
  //
  // POTA rather than the reception reports in `PskSpot`: those record who heard US, which
  // is the wrong direction entirely for a display asking "who can I work". POTA spots are
  // activators announcing a frequency, which is exactly the question.
  //
  // `modes=all` because this page is not only digital when the operator is on voice — an
  // SSB operator looking at 40 m wants the phone and CW activators, and the endpoint's
  // FT8/FT4 default is right for the chase list and wrong here.
  const spotsPath = status?.band
    ? `/api/pota/spots?modes=all&bands=${encodeURIComponent(status.band)}`
    : null;
  const { data: spotData, reload: reloadSpots } = useApi<{
    spots: { spotId: number; activator: string; freqHz: number; mode: string; reference: string; parkName: string | null }[];
  }>(spotsPath);

  // POTA is a volunteer service and the endpoint caches for 60 s, so asking more often
  // than that buys nothing but load.
  useVisibleInterval(() => void reloadSpots(), 60_000, { enabled: Boolean(spotsPath) });

  const panSpots = useMemo(
    () =>
      (spotData?.spots ?? []).map((s) => ({
        key: String(s.spotId),
        callsign: s.activator,
        freqHz: s.freqHz,
        mode: s.mode,
        detail: [s.reference, s.parkName].filter(Boolean).join(" "),
      })),
    [spotData],
  );

  // ---- Nudging the dial with the arrow keys ----
  //
  // Deliberately NOT routed through send(). That helper sets `busy`, which disables every
  // control on the page, and calls reload() for a fresh status — fine for a button press,
  // wrong for a key an operator holds down. Browser auto-repeat delivers keydown every few
  // tens of milliseconds, so the direct route would grey out the page and put a POST and a
  // full status reload on the wire for each one.
  //
  // Instead the target moves instantly in local state and the radio is told once the keys
  // stop, which is how a tuning knob behaves: the display leads and the hardware follows.
  const nudgeTargetRef = useRef<number | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nudgeHz, setNudgeHz] = useState<number | null>(null);

  // The dial the PAGE draws: the pending nudge if there is one, otherwise the radio's own
  // reading. Everything showing a frequency uses this, so the readout, the panadapter
  // cursor and the passband all move together on the first keypress.
  const shownDialHz = nudgeHz ?? status?.dialFrequency ?? null;

  // Latest values for the keydown handler, which is registered once and would otherwise
  // close over the first render's status forever.
  const liveRef = useRef({ dialHz: null as number | null, mode: null as string | null });
  liveRef.current = {
    dialHz: status?.dialFrequency ?? null,
    mode: status?.radioMode ?? null,
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Never steal a keystroke from something being typed into. The Tune box is on this
      // page and arrow keys move a text cursor; a page that hijacks them while someone is
      // editing a frequency is worse than one with no shortcut at all.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      // Leave browser and OS shortcuts alone. Shift is ours — it means a coarser step.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      let direction = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") direction = 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") direction = -1;
      else return;

      const { dialHz, mode } = liveRef.current;
      if (dialHz === null) return;
      e.preventDefault(); // or the page scrolls under the operator

      // Shift is ten steps. The same mode-derived step the spectrum click uses, so the
      // keyboard and the mouse never disagree about what a "step" is on this band.
      const step = tuneStepFor(mode) * (e.shiftKey ? 10 : 1);
      // From the pending target when one exists, so held keys accumulate rather than each
      // one starting again from the radio's last reported dial.
      const base = nudgeTargetRef.current ?? dialHz;
      // Snapped, because the radio may be sitting off-step — from a memory, or from
      // somebody else's client — and the first nudge should land ON the grid rather than
      // carry the offset forward forever.
      const next = snapHz(base + direction * step, mode);
      nudgeTargetRef.current = next;
      setNudgeHz(next);

      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = setTimeout(() => {
        const target = nudgeTargetRef.current;
        nudgeTargetRef.current = null;
        if (target === null) return;
        // Straight to the control API rather than through send(): no `busy`, so the page
        // stays usable, and no reload storm. The status poll brings the radio's own
        // reading along shortly and `nudgeHz` is cleared when it agrees.
        void apiPost("/api/bridge/control", { action: "rig", freqHz: target }).catch(
          (err) => {
            setActionError(err instanceof ApiError ? err.message : "Tuning failed");
            setNudgeHz(null);
          },
        );
      }, 180);
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    };
  }, []);

  // Drop the optimistic reading once the radio reports the frequency we asked for. Without
  // this the page would show its own guess forever if a command were refused — and a dial
  // that disagrees with the radio is the one thing worse than a dial that lags it.
  useEffect(() => {
    if (nudgeHz === null) return;
    if (nudgeTargetRef.current !== null) return; // still mid-nudge
    if (status?.dialFrequency === nudgeHz) setNudgeHz(null);
  }, [status?.dialFrequency, nudgeHz]);

  async function tuneTyped() {
    const hz = parseFreqToHz(freqInput);
    if (hz === null) {
      setActionError(`"${freqInput}" is not a frequency I can read`);
      return;
    }
    // Set the modulation along with the dial.
    //
    // Moving to 7.200 and staying in USB-D is a radio that hears nothing an operator wants
    // and cannot transmit what they say; moving to 14.074 and staying in LSB is the same in
    // reverse. The band follows on its own — the radio reports its dial and the band comes
    // from that — but the modulation does not, so it is sent here. Null means a frequency in
    // no amateur band, and then only the dial moves: a typo should not also change the mode.
    const modulation = modulationForFrequency(hz);
    await send(
      modulation ? { freqHz: hz, mode: modulation } : { freqHz: hz },
      "freq",
    );
    setFreqInput("");
  }

  return (
    <>
      <PageHeader
        title="Rig control"
        subtitle={
          status?.connected
            ? `${status.dialFrequency ? formatFreqMHz(status.dialFrequency) + " MHz" : "—"} · ${status.mode ?? "?"}`
            : "CAT control for the connected FlexRadio"
        }
      />

      {/* PERSISTENT, and not dismissible.
          This page is the least finished part of DigiShack and the banner says so in the
          same words the setting that reveals it uses. A dismissible warning is a warning
          that is dismissed once and never seen again by the person who most needs it — the
          one who comes back a month later having forgotten which parts were measured.

          The specifics are named rather than gestured at, because "experimental" alone
          tells an operator nothing they can act on: knowing the dB scale is uncalibrated is
          what stops somebody reporting a signal report from it. */}
      <div className="mb-4 rounded-sm border border-warn/50 bg-warn/10 px-3 py-2">
        <p className="text-xs text-fg">
          <span className="font-medium uppercase tracking-wide text-warn">Experimental</span>{" "}
          — this page is a work in progress. It is genuinely useful and genuinely unfinished:
          the panadapter&apos;s dB window is <strong>not calibrated</strong>, the FlexRadio
          accepts display settings it never reports back, and some controls are reasoned from
          documentation rather than measured against hardware. Treat readings here as
          relative, not absolute.
        </p>
      </div>

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {data && !data.running && (
        <div className="mb-4">
          <ErrorBanner>
            {data.reason ?? "The radio service is not running."}
          </ErrorBanner>
        </div>
      )}
      {status && !status.commandChannel && (
        <div className="mb-4">
          <ErrorBanner>
            The radio&apos;s command channel is down, so nothing here can change
            the rig. Decodes may still be arriving — DAX audio is a separate UDP
            stream. The radio service retries automatically.
          </ErrorBanner>
        </div>
      )}
      {actionError && (
        <div className="mb-4">
          <ErrorBanner>{actionError}</ErrorBanner>
        </div>
      )}

      {/* THE CONSOLE.
          One screen, not a column of cards. This used to be six stacked Card panels,
          each with a header, its own padding and an explanatory paragraph — "our page is
          like a mile long and clunky", and it was. Worse, the spectrum, which is the
          reason to be on this page at all, shared the first screenful with a second
          waterfall of the same audio the Decodes page already draws.
          Laid out the way an SDR console is: the dial and the meters on one line, the
          spectrum given the room it deserves, every control in one compact deck
          underneath. The explanations that were paragraphs are tooltips now — still
          there when wanted, no longer occupying a screenful each. */}
      <div className="flex flex-col gap-3">
        {/* THE DIAL LINE. Frequency, what the radio is doing, and its health, read left
            to right without scrolling. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2 bg-bg-raised border border-line rounded-sm">
          <div className="flex items-baseline gap-1.5">
            {/* The nudged reading while the arrow keys are moving it, so the big number
                leads the radio instead of lagging a round trip behind it. Dimmed while
                pending, which is the honest signal that the radio has not confirmed yet. */}
            <span
              className={cn(
                "font-display text-3xl leading-none tnum",
                nudgeHz !== null && "text-accent-bright",
              )}
              title={
                nudgeHz !== null
                  ? "Tuning — the radio has not confirmed this yet"
                  : undefined
              }
            >
              {shownDialHz ? formatFreqDial(shownDialHz) : "—"}
            </span>
            <span className="text-[11px] text-fg-subtle">MHz</span>
            {/* The step the arrows and a spectrum click both move by. RemoteHamRadio puts
                the same thing on its display as "df: 200 Hz", and it answers the question
                an operator actually has, which is not "can I tune" but "by how much". */}
            {status?.radioMode && (
              <span className="text-[10px] text-fg-subtle tnum ml-1">
                &Delta;f{" "}
                {tuneStepFor(status.radioMode) >= 1000
                  ? `${tuneStepFor(status.radioMode) / 1000} kHz`
                  : `${tuneStepFor(status.radioMode)} Hz`}
                <span className="text-fg-subtle/70"> · &larr;&rarr; to tune</span>
              </span>
            )}
          </div>
          {status?.band && <Badge tone="neutral">{status.band}</Badge>}
          {status?.transmitting && <Badge tone="danger">TX</Badge>}
          {voiceOn && <Badge tone="warn">VOICE</Badge>}
          <span className="text-xs text-fg-muted tnum">
            {status?.radioMode ?? "—"}
          </span>
          {/* The digital mode only when it IS one: on the FlexRadio this field holds the
              slice's modulation, so showing it unconditionally printed "DIGU" an inch
              from a Modulation picker reading "USB-D" — one fact, twice, in two
              vocabularies, which reads as one of them being wrong. */}
          {/^FT\d/i.test(status?.mode ?? "") && (
            <span className="text-xs text-accent-bright tnum">{status?.mode}</span>
          )}

          {/* The meters, inline: a six-row table for six numbers was most of a card.
              Each appears only once the radio has actually reported it. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Meter
              label="PWR"
              value={
                status?.rfPower !== null && status?.rfPower !== undefined
                  ? `${status.rfPower}%`
                  : null
              }
            />
            <Meter
              label="SWR"
              value={
                telemetry?.swr !== null &&
                telemetry?.swr !== undefined &&
                telemetry.swr > 0
                  ? `${telemetry.swr.toFixed(1)}:1`
                  : null
              }
              tone={
                telemetry?.swr !== null && telemetry?.swr !== undefined
                  ? telemetry.swr > 3
                    ? "text-danger"
                    : telemetry.swr > 2
                      ? "text-warn"
                      : "text-ok"
                  : undefined
              }
            />
            <Meter
              label="PA"
              value={
                telemetry?.paTempC !== null && telemetry?.paTempC !== undefined
                  ? `${telemetry.paTempC.toFixed(0)}°C`
                  : null
              }
              tone={
                telemetry?.paTempC !== null && telemetry?.paTempC !== undefined
                  ? telemetry.paTempC > 75
                    ? "text-danger"
                    : telemetry.paTempC > 60
                      ? "text-warn"
                      : undefined
                  : undefined
              }
            />
            <Meter
              label="VOLTS"
              value={
                telemetry?.voltsPa !== null && telemetry?.voltsPa !== undefined
                  ? `${telemetry.voltsPa.toFixed(1)} V`
                  : null
              }
            />
            <Meter
              label="FAN"
              value={
                telemetry?.fanRpm !== null &&
                telemetry?.fanRpm !== undefined &&
                telemetry.fanRpm > 0
                  ? `${telemetry.fanRpm}`
                  : null
              }
            />
          </div>

          {/* The three actions that are about the station rather than the dial. */}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void apiPost("/api/bridge/control", { action: "atu" }).catch(
                  () => {},
                )
              }
              title="Run the antenna tuner. Keys a brief low-power carrier, so it is gated on Allow transmit like anything else that keys."
              className="px-2 py-1 text-xs rounded-sm border border-line text-fg-muted hover:text-fg hover:border-fg-muted"
            >
              ATU
            </button>
            <button
              type="button"
              onClick={() =>
                void (listening ? stopListening() : startListening())
              }
              title={
                listening
                  ? "Stop monitoring the receiver"
                  : "Listen to the receiver in this browser. The audio waterfall this page used to draw lives on the Decodes page, where decode offsets are marked on it."
              }
              className={cn(
                "px-2 py-1 text-xs rounded-sm border",
                listening
                  ? "border-accent text-accent-bright"
                  : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
              )}
            >
              {listening ? "Listening" : "Listen"}
            </button>
            <button
              type="button"
              disabled={busy === "voice"}
              onClick={async () => {
                // Confirmed on the way IN, because it stops an unattended station: an
                // auto operator part way through a contact is turned OFF by this, not
                // paused.
                if (
                  !voiceOn &&
                  !window.confirm(
                    "Switch to voice? This turns off automatic operation and closes digital " +
                      "transmit until you switch back.",
                  )
                ) {
                  return;
                }
                setBusy("voice");
                setActionError(null);
                try {
                  await apiPost("/api/bridge/control", {
                    action: "voice",
                    active: !voiceOn,
                  });
                  reload();
                } catch (err) {
                  setActionError(
                    err instanceof ApiError
                      ? err.message
                      : "Could not switch mode",
                  );
                } finally {
                  setBusy(null);
                }
              }}
              title={
                voiceOn
                  ? "Back to digital operating"
                  : "Switch to voice: moves the radio out of the data mode that ignores the microphone, and stops anything digital from keying over you."
              }
              className={cn(
                "px-2 py-1 text-xs rounded-sm border",
                voiceOn
                  ? "border-warn text-warn"
                  : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
              )}
            >
              {voiceOn ? "Digital" : "Voice"}
            </button>
          </div>
        </div>

        {/* Listening diagnostics. A suspended audio context schedules everything and
            plays none of it, which is indistinguishable from a dead radio unless it is
            said out loud.

            The ERROR half is deliberately NOT gated on `listening`, and that gate was the
            whole of "the Listen button doesn't work". `listening` is only ever set true in
            `ws.onopen`, so every way this can fail — the browser refusing to start audio,
            the socket never reaching the bridge, the bridge answering with no audio source
            and closing — leaves it false. The message was being set correctly in all three
            cases and then rendered by nothing, so the button flicked back to "Listen" and
            the page stayed silent about why. An error nobody can see is the same as no
            error handling at all. */}
        {(audioError || (listening && audioInfo)) && (
          <div className="text-[11px] text-fg-subtle tnum -mt-1 px-1">
            {listening && audioInfo && (
              <>
                {(audioInfo.rate / 1000).toFixed(0)} kHz &middot;{" "}
                {audioInfo.packets.toLocaleString()} packets
                {audioInfo.context !== "running" && (
                  <span className="text-warn">
                    {" "}
                    &middot; audio {audioInfo.context}
                  </span>
                )}
                {audioInfo.packets === 0 && (
                  <span className="text-warn">
                    {" "}
                    &middot; no packets arriving
                  </span>
                )}
                {audioInfo.bufferedMs > 0 && (
                  <> &middot; {audioInfo.bufferedMs} ms buffered</>
                )}
                {audioInfo.underruns > 0 && (
                  <span className="text-warn">
                    {" "}
                    &middot; {audioInfo.underruns} underruns
                  </span>
                )}
                <label className="inline-flex items-center gap-1.5 ml-3 align-middle">
                  <span>vol</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setVolume(v);
                      playerRef.current?.setVolume(v);
                    }}
                    className="accent-accent w-24 align-middle"
                  />
                </label>
              </>
            )}
            {audioError && <span className="text-danger"> {audioError}</span>}
          </div>
        )}

        {/* THE BAND. The reason to be on this page: tens of kHz of RF with every station
            on it. Given the height it deserves now it is not sharing the screen. */}
        {pan && panScale ? (
          <div>
            <Panadapter
              row={pan}
              centerHz={panScale.centerHz}
              spanHz={panScale.spanHz}
              binHz={panScale.binHz}
              floorDb={panScale.floorDb}
              ceilingDb={panScale.ceilingDb}
              dialHz={shownDialHz}
              radioMode={status?.radioMode ?? null}
              // The radio's real filter, so the shaded passband is the slice's actual
              // width rather than the width its modulation conventionally implies.
              filterLoHz={status?.receiver?.filterLo ?? null}
              filterHiHz={status?.receiver?.filterHi ?? null}
              spots={panSpots}
              // Clicking a spot goes to the EXACT spotted frequency, unsnapped, and takes
              // the modulation with it. Both differ from a click on bare spectrum, and
              // deliberately: a spot is a stated frequency rather than a pointed-at one,
              // so rounding it to the tuning step would move off the very signal being
              // aimed at — and arriving on a POTA activator's SSB frequency still in a
              // data mode is a receiver that hears nothing the operator wants.
              onSpot={(s) => {
                const modulation =
                  modulationForFrequency(s.freqHz) ?? status?.radioMode ?? null;
                void send(
                  modulation
                    ? { freqHz: s.freqHz, mode: modulation }
                    : { freqHz: s.freqHz },
                  "freq",
                );
              }}
              height={260}
              traceHeight={96}
              onTune={(hz) => void send({ freqHz: hz }, "freq")}
              // Zoom does not go through send(): that posts action "rig" and reloads the
              // whole status. The span comes back on the next panadapter frame by
              // itself, so there is nothing to reload.
              onSpan={(hz) => {
                void apiPost("/api/bridge/control", {
                  action: "pan-span",
                  spanHz: hz,
                }).catch((err) =>
                  setActionError(
                    err instanceof ApiError ? err.message : "Zoom failed",
                  ),
                );
              }}
            />
            <p className="text-[11px] text-fg-subtle mt-1 tnum">
              {formatFreqMHz(panScale.centerHz - panScale.spanHz / 2)}&ndash;
              {formatFreqMHz(panScale.centerHz + panScale.spanHz / 2)} MHz from{" "}
              {panScale.radio} &middot; click the spectrum to tune
            </p>
          </div>
        ) : (
          <p className="text-sm text-fg-subtle px-3 py-6 bg-bg-raised border border-line rounded-sm">
            {caps.panadapter
              ? "Waiting for the radio's panadapter. If nothing appears, turn on “RF panadapter” in Settings → FlexRadio."
              : (caps.panadapterNote ??
                "No RF spectrum is available from this source.")}
          </p>
        )}

        {/* THE CONTROL DECK. What used to be four cards, in one strip of groups. */}
        <div className="grid gap-x-6 gap-y-4 px-3 py-3 bg-bg-raised border border-line rounded-sm md:grid-cols-2 xl:grid-cols-4">
          {/* Tune, and the bands. Two columns wide, because eleven band buttons on one
              line beats two rows of six. */}
          <div className="md:col-span-2">
            <Legend>Tune</Legend>
            <form
              className="flex gap-2 mb-2"
              onSubmit={(e) => {
                e.preventDefault();
                void tuneTyped();
              }}
            >
              <Input
                id="freq"
                value={freqInput}
                onChange={(e) => setFreqInput(e.target.value)}
                placeholder="14.074 or 14074000"
                autoComplete="off"
                className="flex-1"
              />
              <Button type="submit" variant="primary" disabled={busy !== null}>
                {busy === "freq" ? "…" : "Go"}
              </Button>
            </form>

            {/* ONE band row. There used to be two — "FT8 calling frequencies" and a
                separate "Bands" card — with identical-looking buttons, different
                behaviour, and the sentence explaining the difference at the bottom of the
                second one. The behaviour is a choice now, not a second row. */}
            <div className="flex items-center gap-2 mb-1.5">
              <div className="flex rounded-sm border border-line overflow-hidden">
                {(
                  [
                    ["calling", "FT8 calling"],
                    ["centre", "Band centre"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setBandTarget(value)}
                    title={
                      value === "calling"
                        ? "Band buttons go to the FT8 calling frequency. Only bands with one are listed."
                        : "Band buttons go to the middle of the band."
                    }
                    className={cn(
                      "px-2 py-0.5 text-[11px] transition-colors",
                      bandTarget === value
                        ? "bg-accent/15 text-accent-bright"
                        : "text-fg-muted hover:text-fg",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-fg-subtle">{caps.label}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {bandButtons.map((b) => (
                <button
                  key={b.band}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void send({ freqHz: b.hz }, `band-${b.band}`)}
                  title={`${b.band} — ${formatFreqMHz(b.hz)} MHz`}
                  className={cn(
                    "px-2 py-1 text-xs rounded-sm border tnum transition-colors",
                    status?.band === b.band
                      ? "border-accent bg-accent/15 text-accent-bright"
                      : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
                  )}
                >
                  {b.band}
                </button>
              ))}
            </div>
          </div>

          {/* Modulation and AGC. */}
          <div className="flex flex-col gap-3">
            <div>
              <Legend>Modulation</Legend>
              <Select
                id="mode"
                /* radioMode, not mode: the latter holds the DIGITAL mode on the Icom
                   path, so this picker used to display "FT8" — a value in no list of
                   modulations, which made it look broken and made every selection spring
                   back. */
                value={status?.radioMode ?? ""}
                disabled={busy !== null}
                onChange={(e) => void send({ mode: e.target.value }, "mode")}
              >
                <option value="" disabled>
                  {status?.radioMode ?? "unknown"}
                </option>
                {MODULATIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </div>
            {/* The antenna port, on a radio that has more than one.
                
                Drawn from the list THE RADIO reported and only when there is a choice in
                it, which is the rule the rest of this page follows: a FLEX-6400 answers
                ANT1, ANT2, RX_A, XVTA, an IC-7300 has one socket and gets no picker, and
                nothing here keeps a table of models. Two lists because the radio keeps
                two — RX_A is a receive-only BNC and appears in one and not the other, so
                a transmit picker that offered it would be offering a port that cannot
                transmit. */}
            {antennas && (
              <div>
                <Legend>
                  Antenna
                  <HelpTip label="About the antenna ports">
                    The sockets this radio says it has, and the one it says it is using.
                    DigiShack used to write ANT1 into every slice it created and never read
                    the antenna back, so a station with the wire on ANT2 got a bridge
                    listening to an empty socket. Changing the receive port moves the RF
                    panadapter with it — a panadapter carries its own antenna, and one left
                    behind draws a spectrum of the wrong aerial with correct axis labels.
                  </HelpTip>
                </Legend>
                <div className="flex gap-2">
                  {(
                    [
                      ["RX", "rxAnt", antennas.rx, status?.receiver?.rxAnt ?? null],
                      ["TX", "txAnt", antennas.tx, status?.receiver?.txAnt ?? null],
                    ] as const
                  )
                    // A list of one is not a choice. On a radio where only the receive
                    // list is longer — a receive-only BNC and one transmit socket — this
                    // draws the RX picker alone rather than a TX picker with nothing in it.
                    .filter(([, , list]) => list.length > 1)
                    .map(([label, field, list, current]) => (
                      <label key={field} className="flex-1 min-w-0">
                        <span className="sr-only">{label} antenna</span>
                        <Select
                          id={field}
                          /* The radio's own answer, like the AGC picker beside it —
                             never the last click. The antenna can be changed in
                             SmartSDR or on the radio's own screen. */
                          value={current ?? ""}
                          disabled={busy !== null}
                          onChange={(e) => void send({ [field]: e.target.value }, field)}
                          title={`${label} antenna${current ? ` — on ${current}` : ""}`}
                        >
                          <option value="" disabled>
                            {current ? `${label} ${current}` : `${label} not reported yet`}
                          </option>
                          {list.map((a) => (
                            <option key={a} value={a}>
                              {label} {a}
                            </option>
                          ))}
                        </Select>
                      </label>
                    ))}
                </div>
              </div>
            )}
            <div>
              <Legend>
                AGC
                <HelpTip label="About AGC">
                  As the radio reports it. Blank means it has not said yet, which is not
                  the same as off - the two look identical on a panel that guesses.
                </HelpTip>
              </Legend>
              <Select
                id="agc"
                /* The radio's own answer, polled — not `defaultValue=""`, which showed
                   "select" forever because nothing was read back and the control could
                   only remember what had been clicked. */
                value={status?.receiver?.agc ?? ""}
                disabled={busy !== null || caps.agc.length === 0}
                onChange={(e) => void send({ agc: e.target.value }, "agc")}
              >
                <option value="" disabled>
                  {/* Three states, named. "reading…" forever is what an unanswered poll
                      looked like, and it reads as a broken page rather than as a radio
                      that has not said. */}
                  {status?.receiver?.agc ??
                    (caps.agc.length === 0
                      ? "not available"
                      : "not reported yet")}
                </option>
                {/* Per radio: these Icoms have no AGC-OFF in this command set, and
                    offering it meant offering a setting certain to be refused. */}
                {caps.agc.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {/* Filters and noise. */}
          <div className="flex flex-col gap-3">
            <div>
              <Legend>
                Filter
                <HelpTip label="About the filter buttons">
                  These light from what the RADIO reports, not from your last click, so a
                  change made on the front panel or by another client shows here. The
                  edges are signed and asymmetric: on lower sideband the receiver listens
                  BELOW the dial, so the same preset reads negative.
                </HelpTip>
              </Legend>
              {/* Only when the radio actually takes a passband in Hz. The Icom selects
                  FIL1/2/3, whose widths live in its own menu, so the endpoint refuses
                  these BY NAME — four buttons that could only ever produce an error. A
                  control that cannot work should not be drawn. */}
              {caps.filterEdgesHz ? (
                <>
                  <div className="flex flex-wrap gap-1">
                    {[
                      {
                        label: "DIG",
                        lo: 0,
                        hi: 3000,
                        hint: "Digital 0–3000 Hz",
                      },
                      {
                        label: "SSB",
                        lo: 100,
                        hi: 2800,
                        hint: "SSB 100–2800 Hz",
                      },
                      {
                        label: "NAR",
                        lo: 300,
                        hi: 2400,
                        hint: "Narrow 300–2400 Hz",
                      },
                      { label: "CW", lo: -250, hi: 250, hint: "CW 500 Hz" },
                    ].map((f) => {
                      // Against what the RADIO reports, not against the last button
                      // pressed. The distinction is the whole point: the filter can be
                      // changed on the radio's own front panel, by a mode change, or by
                      // another client, and a row of buttons tracking our own clicks
                      // would confidently show the wrong one in all three cases.
                      const active = filterMatches(
                        status?.receiver,
                        status?.radioMode,
                        f.lo,
                        f.hi,
                      );
                      // Signed for the modulation in force: these presets are written
                      // the way filters are spoken about, which is the USB convention,
                      // and on LSB the receiver listens below the dial. See
                      // filterEdgesFor — sending them unsigned pointed the filter at the
                      // wrong sideband entirely.
                      const edges = filterEdgesFor(status?.radioMode, f.lo, f.hi);
                      return (
                        <button
                          key={f.label}
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            void send(
                              { filterLo: edges.lo, filterHi: edges.hi },
                              "filt",
                            )
                          }
                          title={
                            active
                              ? `${f.hint} — in force now`
                              : f.hint
                          }
                          className={cn(
                            "px-2 py-1 text-xs rounded-sm border tnum",
                            active
                              ? "border-accent text-accent-bright"
                              : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
                          )}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                  {/* The measured passband, always. A preset that matches lights up
                      above, but a radio sitting on any other width — set on its own
                      front panel, or by a mode change — would otherwise light nothing
                      and look identical to a radio that had not been read yet. */}
                  <p className="mt-1 text-[11px] text-fg-subtle tnum">
                    {status?.receiver?.filterLo != null &&
                    status?.receiver?.filterHi != null ? (
                      <>
                        Radio: {status.receiver.filterLo}–{status.receiver.filterHi} Hz
                        <span className="text-fg-muted">
                          {" "}
                          ({Math.abs(
                            status.receiver.filterHi - status.receiver.filterLo,
                          )}{" "}
                          Hz wide)
                        </span>
                      </>
                    ) : (
                      "The radio has not reported its filter yet"
                    )}
                  </p>
                </>
              ) : (
                <p className="text-xs text-fg-subtle">{caps.filterNote}</p>
              )}
            </div>

            {/* One control each, showing the radio's state, rather than an on and an off
                button that looked identical whatever the radio was doing — four buttons
                that could not show which was in force, because nothing read it back. */}
            <div>
              <Legend>
                Noise
                <HelpTip label="About the noise controls">
                  A FlexRadio never broadcasts a change to its noise blanker, so this is
                  the one place the panel keeps its own record of a command the radio
                  accepted. It is re-read from the radio whenever the bridge reconnects.
                </HelpTip>
              </Legend>
              <div className="flex gap-1">
                {(
                  [
                    ["NB", "nb", status?.receiver?.nb ?? null],
                    ["NR", "nr", status?.receiver?.nr ?? null],
                  ] as const
                ).map(([label, key, on]) => (
                  <button
                    key={key}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void send({ [key]: !on }, key)}
                    className={cn(
                      "px-2 py-1 text-xs rounded-sm border tnum",
                      on === true
                        ? "border-accent text-accent-bright"
                        : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
                    )}
                    title={
                      on === null
                        ? `The radio has not reported ${label} yet — which is a different thing from it being off`
                        : on
                          ? `${label} is on — click to turn it off`
                          : `${label} is off — click to turn it on`
                    }
                  >
                    {label} {on === null ? "?" : on ? "on" : "off"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Which radio this page is driving, and who it says we are. Last, because it
            changes least often. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2 bg-bg-raised border border-line rounded-sm">
          <span className="text-xs text-fg-muted">
            <span className="text-fg-subtle">Station</span>{" "}
            <span className="text-fg tnum">{status?.deCall ?? "—"}</span>
            {status?.deGrid ? (
              <span className="text-fg-muted"> · {status.deGrid}</span>
            ) : null}
          </span>
          <div className="ml-auto">
            <SourcePicker source={status?.source ?? null} />
          </div>
        </div>
      </div>
    </>
  );
}

/** One inline meter. Renders nothing at all when the radio has not reported the value. */
function Meter({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: string;
}) {
  if (value === null) return null;
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[9px] uppercase tracking-wide text-fg-subtle">
        {label}
      </span>
      <span className={cn("text-xs tnum", tone ?? "text-fg")}>{value}</span>
    </span>
  );
}

/** The small-caps label above a group in the control deck. */
function Legend({ children }: { children: React.ReactNode }) {
  // flex + gap so a HelpTip sits beside the label rather than inheriting the uppercase
  // tracking, which is unreadable for the sentence inside the tip.
  return (
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fg-muted mb-1.5">
      {children}
    </div>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  role: "OPERATOR",
  inner: async (ctx: GetServerSidePropsContext) => {
    const { wsUrl } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl } };
  },
});

/**
 * Spectrum bins arrive base64-encoded, one byte per bin.
 *
 * Base64 rather than an array of numbers because a 512-bin row every 250 ms is 4 kB/s of
 * JSON digits against 700 bytes of text, and this runs over a WebSocket a browser holds
 * open all day.
 */
function decodeSpectrumBins(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

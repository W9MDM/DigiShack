import type { GetServerSidePropsContext } from "next";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { modulationForFrequency } from "@/lib/radio/modes";
import { Panadapter, snapHz, tuneStepFor } from "@/components/digital/Panadapter";
import { Waterfall } from "@/components/digital/Waterfall";
import { InlineSpectrum, useInlineView, useLiveSpectrum, ViewSwitch } from "@/components/spectrum/InlineSpectrum";
import { ReceiverCard } from "@/components/rig/ReceiverCard";
import { RigDial } from "@/components/rig/RigDial";
import { StationActions } from "@/components/rig/StationActions";
import { TransmitterCard } from "@/components/rig/TransmitterCard";
import { TuneCard } from "@/components/rig/TuneCard";
import type { RigArea, RigSend, RigStatus, Telemetry } from "@/components/rig/types";
import { HelpTip } from "@/components/ui/HelpTip";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { useReceiverAudio } from "@/lib/client/use-receiver-audio";
import { useBridgeSocket } from "@/lib/client/use-bridge-socket";
import type { ClusterApiResponse, ClusterSpot } from "@/lib/cluster/types";
import { filterSpots, isClusterSpot, toPanadapterSpots, upsertSpot } from "@/lib/cluster/view";
import { formatFreqMHz } from "@/lib/ham/bands";
import { radioCapabilities } from "@/lib/radio/capabilities";
import { decodeBase64Bins } from "@/lib/spectrum/wire";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";

/** DX cluster spots older than this (by their latest repeat) are left off the panadapter. */
const DX_SPOT_MAX_AGE_MIN = 30;

// CAT control for the radio DigiShack is already connected to.
//
// Deliberately not a general-purpose rig-control app: it exposes the controls that matter
// for digital operating and reads back what the radio actually reports, rather than
// assuming a command took effect. Anything that keys the transmitter is gated in the radio
// service — the UI does not get to decide that.
//
// One surface, in the order an operator reads a radio: the dial, the band, then the
// receiver and the transmitter. Every control asks the connected radio's capability profile
// (lib/radio/capabilities.ts) and is not drawn where the radio cannot do it.

/** Names the decoder reports, as opposed to modulations. */
const DIGITAL_MODES = new Set([
  "FT8", "FT4", "FT2", "WSPR", "RTTY", "CW", "JS8", "PSK31", "OLIVIA", "SSTV", "HELL", "JTTY",
]);

/** No panadapter frame for this long and the picture is called stalled, not live. */
const PAN_STALE_MS = 5_000;

const SOURCE_NAMES = { flex: "FlexRadio", icom: "Icom", wsjtx: "External decoder" } as const;

interface Props extends Record<string, unknown> {
  wsUrl: string;
}

export default function RigPage({ wsUrl }: Props) {
  const { data, error, reload } = useApi<{
    running: boolean;
    reason?: string;
    status: RigStatus | null;
    telemetry: Telemetry | null;
    /** Counters only — the stream key is never in this payload. */
    stream: { running: boolean; since?: number | null; frames?: number; lastError?: string | null } | null;
  }>("/api/bridge/status");

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ area: RigArea; text: string } | null>(null);
  const [atuNote, setAtuNote] = useState<string | null>(null);
  const errorIn = (area: RigArea): string | null =>
    actionError?.area === area ? actionError.text : null;

  // Listening to the receiver.
  //
  // The player and its socket live in refs, not state: the scheduling cursor inside the
  // player must survive re-renders untouched, and this page re-renders every two seconds
  // from a status poll. Audio that stutters on every poll would be worse than none.
  // The player, its socket and its diagnostics: shared with the Decodes page.
  const {
    listening,
    volume,
    setVolume,
    info: audioInfo,
    error: audioError,
    start: startListening,
    stop: stopListening,
  } = useReceiverAudio(wsUrl);

  const [pan, setPan] = useState<{ bins: Uint8Array; at: number } | null>(null);
  const [panScale, setPanScale] = useState<{
    centerHz: number;
    spanHz: number;
    binHz: number;
    // The dB window the bytes span, for the trace's vertical scale.
    floorDb: number;
    ceilingDb: number;
    radio: string;
  } | null>(null);
  // When the last panadapter frame ARRIVED, by this browser's clock — the frame's own `at`
  // is the bridge's, and the two clocks are not comparable.
  const [panReceivedAt, setPanReceivedAt] = useState<number | null>(null);
  // The audio spectrum — the same stream the Decodes page draws — so a source without an
  // RF panadapter (the Icom today) still shows a live waterfall here instead of a bare note.
  const [audioSpec, setAudioSpec] = useState<{ bins: Uint8Array; at: number } | null>(null);
  const [audioScale, setAudioScale] = useState<{ binHz: number; maxHz: number; periodMs: number } | null>(null);
  // DX cluster spots: the bridge's list once, then each new spot off the same socket.
  const [clusterSpots, setClusterSpots] = useState<ClusterSpot[]>([]);
  // The same frames, recorded for the Waterfall HD / 3D / analyzer views of the display, and whether we
  // are on the air while they are. The 2 s status poll alone is too late for Delta: it
  // keys up to two seconds after the audio goes quiet, and those rows would be compared as the
  // whole band dropping out. The bridge's status message on the socket comes with every change,
  // so it leads; a poll only overrides it when its own answer changes, so a poll that set off
  // before the key-up cannot undo it.
  const polledOnAir = data?.status?.transmitting === true;
  const [onAir, setOnAir] = useState(false);
  useEffect(() => setOnAir(polledOnAir), [polledOnAir]);
  const liveRf = useLiveSpectrum("rf", onAir);
  const liveAudio = useLiveSpectrum("audio", onAir);
  const [rigView, setRigView] = useInlineView("digishack.rig.view");
  const { connected: wsConnected } = useBridgeSocket(wsUrl, (msg) => {
    if (msg.kind === "panadapter") {
      liveRf.ingest(msg);
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
      setPan({ bins: decodeBase64Bins(m.bins), at: m.at });
      setPanReceivedAt(Date.now());
      setPanScale({
        centerHz: m.centerHz,
        spanHz: m.spanHz,
        binHz: m.binHz,
        floorDb: m.floorDb,
        ceilingDb: m.ceilingDb,
        radio: m.radio,
      });
    } else if (msg.kind === "spectrum") {
      liveAudio.ingest(msg);
      // The audio spectrum (receiver passband), broadcast by every source including the
      // Icom. The RF panadapter is FlexRadio-only today; this is the fallback.
      const s = msg as unknown as { bins: string; binHz: number; maxHz: number; at: number; periodMs: number };
      setAudioSpec({ bins: decodeBase64Bins(s.bins), at: s.at });
      setAudioScale({ binHz: s.binHz, maxHz: s.maxHz, periodMs: s.periodMs });
    } else if (msg.kind === "status") {
      const s = msg.status as { transmitting?: unknown } | null | undefined;
      if (s && typeof s.transmitting === "boolean") setOnAir(s.transmitting);
    } else if (msg.kind === "spot" && isClusterSpot(msg.spot)) {
      const spot = msg.spot;
      setClusterSpots((p) => upsertSpot(p, spot));
    }
  });

  const status = data?.status ?? null;
  const telemetry = data?.telemetry ?? null;
  const voiceOn = status?.voice?.active === true;
  const stream = data?.stream ?? null;
  const streaming = stream?.running === true;
  const source = status?.source ?? null;

  // What this radio actually has. Every control below asks rather than assuming.
  const caps = radioCapabilities(source);
  // An external decoder is not a radio DigiShack drives: nothing here could reach it.
  const controllable = source === "flex" || source === "icom";
  // The command channel is what changes the rig; with it down every control would only fail.
  const canControl = controllable && status?.commandChannel === true;

  // A display left over from the OTHER radio is a frozen picture of the wrong band: the
  // FlexRadio's last panadapter frame stayed on screen after switching to the Icom.
  useEffect(() => {
    setPan(null);
    setPanScale(null);
    setPanReceivedAt(null);
    setAudioSpec(null);
    setAudioScale(null);
  }, [source]);

  // Poll: the radio can be changed from its own front panel or SmartSDR, and a control
  // panel showing stale values is worse than one showing none. Suspended while the tab is
  // hidden, with a catch-up on return, so the first thing a returning operator sees is
  // current.
  useVisibleInterval(() => reload(), 2_000);

  /** One control command. Only the control that sent it waits on it. */
  async function run(
    body: Record<string, unknown>,
    label: string,
    area: RigArea,
  ): Promise<unknown | undefined> {
    setBusy(label);
    setActionError(null);
    try {
      const reply = await apiPost<unknown>("/api/bridge/control", body);
      reload();
      return reply ?? true;
    } catch (err) {
      setActionError({ area, text: err instanceof ApiError ? err.message : "Command failed" });
      return undefined;
    } finally {
      setBusy((b) => (b === label ? null : b));
    }
  }

  const send: RigSend = async (body, label, area) =>
    (await run({ action: "rig", ...body }, label, area)) !== undefined;

  // ---- Who is on the air, for the panadapter overlay ----
  //
  // POTA rather than PskSpot reception reports: those record who heard US, the wrong
  // direction for "who can I work". `modes=all` because an SSB operator on 40 m wants the
  // phone and CW activators too.
  const spotsPath = status?.band
    ? `/api/pota/spots?modes=all&bands=${encodeURIComponent(status.band)}`
    : null;
  const { data: spotData, reload: reloadSpots } = useApi<{
    spots: { spotId: number; activator: string; freqHz: number; mode: string; reference: string; parkName: string | null }[];
  }>(spotsPath);

  // POTA is a volunteer service and the endpoint caches for 60 s.
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

  // DX cluster spots on the same overlay, only while the cluster is switched on. The list is
  // re-read now and then for spots missed while the socket was down, and for the setting.
  const { data: clusterData, reload: reloadCluster } = useApi<ClusterApiResponse>("/api/cluster/spots");
  const clusterOn = clusterData?.settingEnabled === true && clusterData.cluster?.enabled === true;
  useEffect(() => {
    setClusterSpots(clusterData?.cluster?.spots ?? []);
  }, [clusterData]);
  useVisibleInterval(() => void reloadCluster(), 60_000);
  const [clusterNow, setClusterNow] = useState(() => Date.now());
  useVisibleInterval(() => setClusterNow(Date.now()), 60_000);

  const allSpots = useMemo(() => {
    const band = status?.band?.toUpperCase();
    if (!clusterOn || !band) return panSpots;
    const dx = filterSpots(
      clusterSpots,
      { band, category: "ALL", neededOnly: false, maxAgeMin: DX_SPOT_MAX_AGE_MIN },
      clusterNow,
    );
    // The Panadapter draws every spot alike, so the label says which list it came from.
    return [...panSpots, ...toPanadapterSpots(dx).map((s) => ({ ...s, callsign: `DX ${s.callsign}` }))];
  }, [panSpots, clusterOn, clusterSpots, clusterNow, status?.band]);

  // ---- Nudging the dial with the arrow keys ----
  //
  // Deliberately NOT routed through send(): browser auto-repeat delivers keydown every few
  // tens of milliseconds, and a POST plus a status reload for each one is wrong for a key
  // an operator holds down. The target moves instantly in local state and the radio is
  // told once the keys stop, which is how a tuning knob behaves.
  const nudgeTargetRef = useRef<number | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nudgeHz, setNudgeHz] = useState<number | null>(null);

  // The dial the PAGE draws: the pending nudge if there is one, otherwise the radio's own
  // reading, so the readout, the panadapter cursor and the passband move together.
  const shownDialHz = nudgeHz ?? status?.dialFrequency ?? null;

  // Latest values for the keydown handler, which is registered once.
  const liveRef = useRef({ dialHz: null as number | null, mode: null as string | null });
  liveRef.current = {
    dialHz: canControl ? (status?.dialFrequency ?? null) : null,
    mode: status?.radioMode ?? null,
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Never steal a keystroke from something being typed into.
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
      // Nor from a menu, the nav drawer or a dialog: arrows move through those, and an
      // ArrowDown through the drawer's links used to retune the radio behind it.
      if (t?.closest?.('nav, [role="dialog"], [role="menu"], [aria-modal="true"]')) return;
      // Leave browser and OS shortcuts alone. Shift is ours — it means a coarser step.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      let direction = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") direction = 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") direction = -1;
      else return;

      const { dialHz, mode } = liveRef.current;
      if (dialHz === null) return;
      e.preventDefault(); // or the page scrolls under the operator

      // The same mode-derived step the spectrum click uses, so the keyboard and the mouse
      // never disagree about what a "step" is on this band.
      const step = tuneStepFor(mode) * (e.shiftKey ? 10 : 1);
      // From the pending target, so held keys accumulate.
      const base = nudgeTargetRef.current ?? dialHz;
      // Snapped, so the first nudge from an off-step dial lands ON the grid.
      const next = snapHz(base + direction * step, mode);
      nudgeTargetRef.current = next;
      setNudgeHz(next);

      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = setTimeout(() => {
        const target = nudgeTargetRef.current;
        nudgeTargetRef.current = null;
        if (target === null) return;
        void apiPost("/api/bridge/control", { action: "rig", freqHz: target }).catch(
          (err) => {
            setActionError({
              area: "dial",
              text: err instanceof ApiError ? err.message : "Tuning failed",
            });
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

  // Drop the optimistic reading once the radio reports the frequency we asked for, so a
  // refused command never leaves the page showing its own guess.
  useEffect(() => {
    if (nudgeHz === null) return;
    if (nudgeTargetRef.current !== null) return; // still mid-nudge
    if (status?.dialFrequency === nudgeHz) setNudgeHz(null);
  }, [status?.dialFrequency, nudgeHz]);

  async function setVoice(active: boolean) {
    // Confirmed on the way IN, because it stops an unattended station: an auto operator
    // part way through a contact is turned OFF by this, not paused.
    if (
      active &&
      !window.confirm(
        "Switch to voice? This turns off automatic operation and closes digital " +
          "transmit until you switch back.",
      )
    ) {
      return;
    }
    await run({ action: "voice", active }, "voice", "transmitter");
  }

  async function tuneAtu() {
    setAtuNote(null);
    const reply = (await run({ action: "atu" }, "atu", "transmitter")) as
      | { state?: string; detail?: string }
      | true
      | undefined;
    if (reply === undefined) return;
    const said = reply === true ? undefined : (reply.state ?? reply.detail);
    setAtuNote(said ? `Tuner: ${said}` : "Tuner started");
  }

  // What the decoder is listening for. The FlexRadio carries it in `subMode` and the Icom
  // in `mode`; it was shown only on the Icom because only `mode` was read.
  const decodingMode =
    voiceOn
      ? null
      : ([status?.subMode, status?.mode].find(
          (m): m is string => typeof m === "string" && DIGITAL_MODES.has(m.toUpperCase()),
        ) ?? null);

  const radioName =
    status?.radio?.model ?? (source ? SOURCE_NAMES[source] : null);
  const subtitle = [
    radioName,
    status && !status.connected && controllable ? "not connected" : null,
    status?.deCall,
    status?.deGrid,
  ]
    .filter(Boolean)
    .join(" · ");

  const panStale = panReceivedAt !== null && Date.now() - panReceivedAt > PAN_STALE_MS;

  return (
    <>
      <PageHeader
        title="Rig control"
        subtitle={subtitle || undefined}
        actions={
          status ? (
            <StationActions
              source={source}
              streaming={streaming}
              onError={(text) => setActionError(text ? { area: "top", text } : null)}
              onChanged={reload}
            />
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4">
        {/* PERSISTENT, and not dismissible: a dismissed warning is never seen again by the
            operator who most needs it, the one back a month later. The specifics are named
            because "experimental" alone tells nobody what to distrust. Still shown on a
            phone, but at the foot of the page: there its five lines stood between the
            operator and the dial and any "will not transmit" banner. */}
        <p className="order-last rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-muted md:order-none">
          <span className="font-medium uppercase tracking-wide text-warn">Experimental</span>{" "}
          — useful and unfinished. The panadapter&apos;s dB window is{" "}
          <strong className="text-fg">not calibrated</strong>, the FlexRadio accepts display
          settings it never reports back, and some controls are reasoned from documentation
          rather than measured against hardware. Treat readings as relative.
        </p>

        {error && <ErrorBanner>{error.message}</ErrorBanner>}
        {data && !data.running && (
          <ErrorBanner>{data.reason ?? "The radio service is not running."}</ErrorBanner>
        )}
        {status && controllable && !status.connected && (
          <ErrorBanner>
            {`Not connected to ${caps.label}${status.connectionError ? `: ${status.connectionError}` : ""}. The radio service retries automatically.`}
          </ErrorBanner>
        )}
        {status && controllable && status.connected && !status.commandChannel && (
          <ErrorBanner>
            The radio&apos;s command channel is down, so nothing here can change the rig.
            Decodes may still be arriving — DAX audio is a separate UDP stream. The radio
            service retries automatically.
          </ErrorBanner>
        )}
        {errorIn("top") && <ErrorBanner>{errorIn("top")}</ErrorBanner>}
        {/* WHY THE STREAM STOPPED: a rejected key kills ffmpeg a second after it connects,
            so "Go live" flips back on its own and needs the reason beside it. */}
        {!streaming && stream?.lastError && (
          <ErrorBanner>
            {`The YouTube stream stopped: ${stream.lastError}. If YouTube rejected it, check the stream key in Settings → YouTube Live — a key is per-channel and YouTube rotates it when you reset it in Studio.`}
          </ErrorBanner>
        )}
        {/* Keying produces nothing while any of these stand: no DAX source, no transmit
            slice, an interlock, a transmit slice on another band. From the radio's own
            status. Warnings live with the transmitter. */}
        {status && (status.txBlockers?.length ?? 0) > 0 && (
          <ErrorBanner>
            <span className="font-medium">The radio will not transmit:</span>{" "}
            {status.txBlockers!.join(" · ")}
          </ErrorBanner>
        )}

        <RigDial
          dialHz={shownDialHz}
          pending={nudgeHz !== null}
          radioMode={status?.radioMode ?? null}
          decodingMode={decodingMode !== status?.radioMode ? decodingMode : null}
          transmitting={status?.transmitting === true}
          voiceOn={voiceOn}
          canSetMode={controllable}
          modeBusy={!canControl || busy === "mode"}
          onMode={(m) => void send({ mode: m }, "mode", "dial")}
          error={errorIn("dial")}
          actions={
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={listening}
              onClick={() =>
                void (listening ? stopListening() : startListening())
              }
              title={
                listening
                  ? "Stop monitoring the receiver"
                  : "Listen to the receiver in this browser."
              }
              className={
                listening
                  ? "border-accent bg-accent/12 text-accent-bright hover:bg-accent/20"
                  : undefined
              }
            >
              {listening ? "Listening" : "Listen"}
            </Button>
          }
        >
          {/* Listening diagnostics. A suspended audio context schedules everything and
              plays none of it, which is indistinguishable from a dead radio unless it is
              said out loud. The ERROR half is deliberately NOT gated on `listening`: every
              way this fails leaves `listening` false, and an error rendered by nothing was
              the whole of "the Listen button doesn't work". */}
          {(audioError || (listening && audioInfo)) && (
            <div className="flex flex-wrap items-center gap-x-1 border-t border-line px-4 py-2 text-xs text-fg-subtle tnum">
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
                  <label className="ml-3 inline-flex items-center gap-1.5">
                    <span>Volume</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={volume}
                      onChange={(e) => {
                        setVolume(Number(e.target.value));
                      }}
                      className="w-24 accent-accent"
                    />
                  </label>
                </>
              )}
              {audioError && <span className="text-danger"> {audioError}</span>}
            </div>
          )}
        </RigDial>

        {/* THE BAND. The reason to be on this page: tens of kHz of RF with every station
            on it — as the panadapter, or in Waterfall HD / 3D / the analyzer views of the same frames. */}
        {((pan && panScale) || (!caps.panadapter && audioSpec && audioScale)) && (
          <div className="-mb-2 flex items-center justify-end">
            <ViewSwitch value={rigView} onChange={setRigView} />
          </div>
        )}
        {rigView !== "waterfall" && ((pan && panScale) || (!caps.panadapter && audioSpec && audioScale)) ? (
          <InlineSpectrum
            feed={pan && panScale ? liveRf.feed : liveAudio.feed}
            view={rigView}
            height={356}
            dialHz={shownDialHz ?? null}
          />
        ) : pan && panScale ? (
          <Panadapter
            row={pan}
            centerHz={panScale.centerHz}
            spanHz={panScale.spanHz}
            binHz={panScale.binHz}
            floorDb={panScale.floorDb}
            ceilingDb={panScale.ceilingDb}
            dialHz={shownDialHz}
            radioMode={status?.radioMode ?? null}
            // The radio's real filter, so the shaded passband is the slice's actual width.
            filterLoHz={status?.receiver?.filterLo ?? null}
            filterHiHz={status?.receiver?.filterHi ?? null}
            spots={allSpots}
            // A spot goes to the EXACT spotted frequency, unsnapped, and takes the
            // modulation with it: rounding a stated frequency to the step moves off the
            // very signal aimed at, and arriving on a POTA SSB frequency in a data mode is a
            // receiver that hears nothing the operator wants.
            onSpot={(s) => {
              if (!canControl) return;
              const modulation =
                modulationForFrequency(s.freqHz) ?? status?.radioMode ?? null;
              void send(
                modulation ? { freqHz: s.freqHz, mode: modulation } : { freqHz: s.freqHz },
                "freq",
                "dial",
              );
            }}
            height={260}
            traceHeight={96}
            onTune={canControl ? (hz) => void send({ freqHz: hz }, "freq", "dial") : undefined}
            // Zoom does not go through send(): the span comes back on the next panadapter
            // frame by itself, so there is nothing to reload.
            onSpan={(hz) => {
              void apiPost("/api/bridge/control", {
                action: "pan-span",
                spanHz: hz,
              }).catch((err) =>
                setActionError({
                  area: "dial",
                  text: err instanceof ApiError ? err.message : "Zoom failed",
                }),
              );
            }}
            caption={
              <>
                {`${formatFreqMHz(panScale.centerHz - panScale.spanHz / 2)}–${formatFreqMHz(panScale.centerHz + panScale.spanHz / 2)} MHz · ${panScale.radio}`}
                {" · "}
                <Link
                  href="/spectrum?source=rf&view=3d"
                  className="text-accent-bright hover:underline"
                  title="This band in Waterfall HD, 3D and the analyzer views"
                >
                  Open spectrum
                </Link>
              </>
            }
            stale={panStale}
          />
        ) : !caps.panadapter && audioSpec && audioScale ? (
          // No RF scope on this source (the Icom today): the AUDIO waterfall, the receiver
          // spectrum the Decodes page draws, rather than a bare "scope unavailable" note.
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span>Receiver audio — {caps.label} has no RF panadapter here</span>
              <HelpTip label="About this display">
                {caps.panadapterNote ?? "This source sends no RF spectrum."} This is the
                passband the radio is demodulating, not tens of kHz of band; the Decodes
                page marks decode offsets on the same spectrum.
              </HelpTip>
              <Link
                href="/spectrum?source=audio"
                className="ml-auto text-accent-bright hover:underline"
                title="The receiver audio in Waterfall HD, 3D and the analyzer views"
              >
                Open spectrum
              </Link>
            </div>
            <Waterfall
              row={audioSpec}
              binHz={audioScale.binHz}
              maxHz={audioScale.maxHz}
              periodMs={voiceOn ? null : audioScale.periodMs}
              rowIntervalMs={voiceOn ? 50 : 250}
              markers={[]}
              height={260}
            />
          </div>
        ) : (
          <div className="rounded-md border border-line bg-bg">
            <EmptyState
              className="py-10"
              title={
                !wsConnected
                  ? "Connecting to the live stream…"
                  : caps.panadapter
                    ? "Waiting for the radio's panadapter"
                    : status?.connected
                      ? "Waiting for receiver audio"
                      : "No spectrum"
              }
            >
              {!wsConnected
                ? "The spectrum comes from the radio service over a WebSocket, which is not connected yet."
                : caps.panadapter
                  ? "If nothing appears, turn on “RF panadapter” in Settings → FlexRadio."
                  : status?.connected
                    ? null
                    : (caps.panadapterNote ?? "No RF spectrum is available from this source.")}
            </EmptyState>
          </div>
        )}

        {controllable ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="md:col-span-2 xl:col-span-1">
              <TuneCard
                caps={caps}
                grid={status?.deGrid ?? null}
                band={status?.band ?? null}
                radioMode={status?.radioMode ?? null}
                canControl={canControl}
                busy={busy}
                send={send}
                error={errorIn("tune")}
              />
            </div>
            <ReceiverCard
              caps={caps}
              receiver={status?.receiver}
              radioMode={status?.radioMode ?? null}
              canControl={canControl}
              busy={busy}
              send={send}
              error={errorIn("receiver")}
            />
            <TransmitterCard
              connected={status?.connected === true}
              rfPower={status?.rfPower ?? null}
              telemetry={telemetry}
              transmitting={status?.transmitting === true}
              voiceOn={voiceOn}
              allowTransmit={status?.allowTransmit}
              transmitOffReason={status?.transmitOffReason ?? null}
              txWarnings={status?.txWarnings ?? []}
              canControl={canControl}
              busy={busy}
              onVoice={(active) => void setVoice(active)}
              onAtu={() => void tuneAtu()}
              onPower={async (percent) =>
                (await run({ action: "power", percent }, "power", "transmitter")) !== undefined
              }
              atuNote={atuNote}
              error={errorIn("transmitter")}
            />
          </div>
        ) : (
          status && (
            <Card>
              <EmptyState className="py-8" title="No rig control on this source">
                {caps.filterNote ??
                  "DigiShack does not control this radio."}{" "}
                Choose a radio with the Radio picker above to tune, filter and transmit from
                here.
              </EmptyState>
            </Card>
          )
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  role: "OPERATOR",
  inner: async (ctx: GetServerSidePropsContext) => {
    const { wsUrl } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl } };
  },
});

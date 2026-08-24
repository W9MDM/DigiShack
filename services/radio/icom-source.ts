// Wiring the Icom into the bridge.
//
// A sibling of `startFlexSource`, not a generalisation of it. The two radios differ
// almost entirely in CONSTRUCTION — discovery, slices and DAX channels on one side, a
// login and three UDP streams on the other — and hardly at all in what happens to the
// events afterwards. So the heavy shared logic (`onDecodedWindow`) is shared, and the
// short radio-specific parts are written twice rather than contorted into one function
// with a `kind` parameter threaded through four hundred lines.
//
// What the Icom does NOT have yet, stated plainly rather than discovered later:
//
//   * Preflight cannot check the one thing that matters most. `MOD Input -> DATA MOD`
//     must be LAN or the radio keys perfectly and transmits silence, and that setting
//     is not exposed over CI-V. Preflight says so out loud rather than implying a clean
//     bill of health it cannot give.

import { prisma } from "@/lib/db/prisma";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";
import { isTransmitArmed, transmitGate } from "@/lib/radio/transmit-gate";
import { createIcomSource } from "@/lib/icom/from-settings";
import { IcomTransmitter } from "@/lib/icom/transmitter";
import type { IcomSource } from "@/lib/icom/rig";
import { spectrumMessage } from "@/lib/radio/spectrum";
import type { DigitalTransmitter } from "@/lib/radio/types";
import { inferDigitalMode } from "@/lib/ham/digital-freqs";
import { buildOperating, callingFrequencyHz, type Operating } from "./operating";
import { watchGuardFaults } from "./guard-alerts";

export interface IcomBridgeDeps {
  onDecodedWindow(
    d: {
      windowStart: Date;
      decodes: { message: string; snr: number; dt: number; freqOffset: number; mode: string }[];
      decodeMs: number;
    },
    depthSetting: string,
  ): void;
  broadcast(msg: unknown): void;
  /**
   * Receiver audio, as it arrived. Optional: a caller with nowhere to send it passes
   * nothing and the source never converts a sample.
   */
  onAudio?(samples: Float32Array): void;
  /** Write out buffered decode rows. See OperatingDeps.flushDecodes. */
  flushDecodes?: () => Promise<void>;
  /**
   * The bridge's shared status object, mutated in place and broadcast.
   *
   * Structurally typed to exactly the fields this file touches — no index signature,
   * because that would stop the real `RigStatus` matching and would also quietly permit
   * typos in field names that only show up as a UI field that never updates.
   */
  status: {
    connected: boolean;
    lastHeartbeat: number | null;
    dialFrequency: number | null;
    band: string | null;
    mode: string | null;
    /** The radio's modulation, distinct from the digital mode above. */
    radioMode: string | null;
    /** AGC / NB / NR as the radio reports them; null means not read yet. */
    receiver: { agc: string | null; nb: boolean | null; nr: boolean | null };
    allowTransmit: boolean;
    commandChannel: boolean;
    rfPower: number | null;
    radio: { vendor: string; model: string; host: string } | null;
    transmitting: boolean;
    txBlockers: string[];
    txWarnings: string[];
    deCall: string | null;
    deGrid: string | null;
  };
  freqToBand(hz: number): string | null;
  /** Called when a spectrum row is ready, already throttled by the source. */
  onSpectrum(row: unknown): void;
  onTelemetry(t: unknown): void;
  /** Receive noise floor in dBm, measured by the caller from the meter stream. */
  noiseDbm?: () => number | null;
  onSmeter(m: { dbm: number; fwdDbm: number | null; at: number }): void;
  /** Arm the liveness watchdog against this source's window cadence. */
  armWatchdog(periodMs: number, label: string): void;
  /** Beat it on every window. */
  beatWatchdog(): void;
  /**
   * The session dropped and is not coming back on its own.
   *
   * The caller owns the rebuild: this file knows how to stand a radio up, and the
   * bridge knows what else has to be put back afterwards — the operating handles, the
   * auto mode, the watchdog. Called at most once per session; the supervisor guards
   * against re-entry.
   */
  onLost?(reason: string): void;
}

export interface IcomBridge {
  source: IcomSource;
  transmitter: IcomTransmitter | null;
  /**
   * Guards, the QSO controller and the auto operator — the same ones the FlexRadio
   * gets, from the same builder.
   *
   * Null when there is no transmitter (no CI-V stream, or no station record). Auto
   * modes are meaningless without something to key, and returning a controller that
   * always refuses would hide the reason.
   */
  operating: Operating | null;
  /**
   * Whether the streams are actually carrying, measured at startup.
   *
   * "Open" is a socket fact and not the interesting one — after a restart the radio can
   * leave the previous session bound on its side and the new streams deliver nothing.
   * The caller acts on this; see startIcomBridge.
   */
  carrying: { ok: boolean; civ: number; audio: number };
  stop(): Promise<void>;
}



/**
 * How long the audio may be silent before the session is rebuilt.
 *
 * Comfortably past a full FT8 transmission (12.6 s) plus the gap, so a keyed radio can
 * never trip it even if the transmitting flag were missed.
 */
const AUDIO_DEAD_MS = 20_000;
const AUDIO_CHECK_MS = 5_000;

export async function startIcomSource(deps: IcomBridgeDeps): Promise<IcomBridge> {
  const source = await createIcomSource();
  if (!source) {
    throw new Error(
      "Icom is selected as the decode source but the address, user name or password is not set. Settings -> Icom (network).",
    );
  }

  const { status, broadcast } = deps;

  source.on("identified", (i) => {
    console.log(`[bridge] Icom identified: ${i.radioName} (audio ${i.audioName})`);
  });

  source.on("connected", (id) => {
    status.connected = true;
    status.commandChannel = true;
    status.lastHeartbeat = Date.now();
    // What the radio calls itself — "IC-7300MK2" — straight from its own identification.
    status.radio = { vendor: id.vendor, model: id.model, host: id.host };
    console.log(`[bridge] ${id.model} at ${id.host}: control, CI-V and audio all open`);
    broadcast({ kind: "status", status });
  });

  source.on("disconnected", ({ reason }) => {
    status.connected = false;
    status.commandChannel = false;
    console.error(`[bridge] Icom disconnected: ${reason}`);
    broadcast({ kind: "status", status });
    // Only once the session is up. A drop while opening is reported by the promise
    // below, and handing the same failure to the supervisor as well would start two
    // rebuilds for one outage.
    if (opened) deps.onLost?.(reason);
  });

  source.on("error", (err) => console.error("[bridge] icom source:", err.message));
  source.on("smeter", (m) => deps.onSmeter(m));
  source.on("telemetry", (t) => deps.onTelemetry(t));
  // Through the shared encoder. Broadcasting the raw row sends `bins` as a Uint8Array,
  // which JSON-serialises to an object rather than an array, and the client sits on
  // "waiting for spectrum..." forever.
  source.on("spectrum", (row) =>
    deps.onSpectrum(spectrumMessage(row, source.mode, source.periodMs)),
  );

  // Receiver audio to anyone listening in a browser. 48 kHz here against the FlexRadio's
  // 24 kHz, which is why a listener is told the rate rather than assuming one.
  source.on("audio", ({ samples }) => deps.onAudio?.(samples));

  // The modulation, which the mode poll reports — so a change made on the radio's own front
  // panel reaches the CAT panel too, not only changes we asked for.
  source.on("radioMode", (name) => {
    deps.status.radioMode = name;
    deps.broadcast({ kind: "status", status: deps.status });
  });

  // The receiver controls, which were write-only until now: the panel could show what had
  // been clicked but never what the radio was actually doing.
  source.on("receiverControls", (rx) => {
    deps.status.receiver = rx;
    deps.broadcast({ kind: "status", status: deps.status });
  });

  source.on("window", (w) => {
    deps.beatWatchdog();
    // Windows arrive every T/R period whether or not anything decoded, so this is the
    // honest liveness signal. Beating only on decodes means a quiet band reads as a
    // dead radio.
    status.lastHeartbeat = Date.now();
    if (w.skipped && w.rms > 0) {
      console.log(
        `[bridge] window ${w.windowStart.toISOString().slice(11, 19)} skipped (rms ${w.rms.toExponential(1)})`,
      );
    }
  });

  source.on("decodes", (d) => deps.onDecodedWindow(d, "icom.decodeDepth"));

  // `start()` resolves when the CONTROL transport is up, which is not when the radio is
  // usable: the serial and audio streams open later, on the control stream's `ready`.
  // Attaching the transmitter straight after start() therefore found no CI-V stream and
  // logged "transmit unavailable" on every boot — the radio was fine, we simply asked
  // half a second too early. Wait for the source's own `connected`, which fires once all
  // three streams are open.
  let opened = false;
  const connected = new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("Icom did not finish opening its streams within 20s")),
      20_000,
    );
    source.once("connected", () => {
      clearTimeout(t);
      opened = true;
      resolve();
    });
    source.once("disconnected", ({ reason }) => {
      clearTimeout(t);
      reject(new Error(`the Icom session dropped while opening: ${reason}`));
    });
  });

  // This promise must never be an UNHANDLED rejection, and it very nearly always was.
  //
  // `source.start()` below throws when the radio is unreachable — a VPN down, the radio off,
  // no traffic on the control stream. The caller catches that and logs "carrying on without a
  // radio", which is the whole point of starting without one. But `connected` was created
  // BEFORE that throw and nothing ever awaited it, so when the disconnect arrived a moment
  // later it rejected a promise with no handler. Node exits on an unhandled rejection, PM2
  // restarts, the radio is still unreachable, and round it goes: 187 restarts in an evening,
  // with the log cheerfully saying it was carrying on without a radio each time.
  //
  // Attaching a catch here does not consume the rejection — the `await` below still sees it —
  // it only guarantees somebody is listening.
  connected.catch(() => {});

  await source.start();
  await connected;

  // The dial frequency comes from CI-V rather than from a slice, and it arrives on the
  // poll rather than at connect. Publishing it on a timer keeps the UI honest about
  // where the radio actually is, including when the operator turns the knob.
  const configuredMode = ((await getSetting("digital.mode")) ?? "auto").toLowerCase();

  const publishFrequency = () => {
    const hz = source.getFrequencyHz();
    if (hz === null || hz === status.dialFrequency) return;
    status.dialFrequency = hz;
    status.band = deps.freqToBand(hz);

    // Which digital mode lives here, unless the operator pinned one.
    //
    // The FlexRadio path has done this since the beginning; this one decoded FT8
    // wherever the radio was tuned, so moving to an FT4 frequency produced a screen
    // full of nothing — the same symptom as a dead band, a wrong antenna or a broken
    // audio path, which is exactly the confusion inferDigitalMode exists to prevent.
    if (configuredMode === "auto") {
      const guess = inferDigitalMode(hz);
      if (source.setMode(guess.mode)) {
        console.log(
          `[bridge] ${(hz / 1e6).toFixed(3)} MHz -> decoding ${guess.mode}` +
            (guess.certain
              ? ` (${guess.matched?.band} calling frequency)`
              : " (no known calling frequency nearby — defaulting to FT8)"),
        );
      }
    }
    status.mode = source.mode;
    status.radioMode = source.radioMode;
    broadcast({ kind: "status", status });
  };
  // Once straight away, then on a short timer. The source polls CI-V every two seconds
  // and this used to poll the result every two more, so the band could take four
  // seconds to appear after connecting — long enough to read as "it does not know what
  // band it is on" rather than as a brief wait.
  publishFrequency();
  const freqTimer = setInterval(publishFrequency, 500);

  // Do not proceed until all three streams are genuinely CARRYING.
  //
  // "Open" is a socket fact and it is not the interesting one. When a restart leaves the
  // radio holding the previous session, the new streams open perfectly and then deliver
  // nothing — no CI-V, or no audio, or both — and every layer above reports something
  // plausible and wrong: a blank band, a dead receiver, a radio that will not tune. The
  // operator watching it said "every time you push a code change it breaks the
  // connection to the Icom", which was exactly right and took far too long to believe.
  //
  // Rebuilding clears it, because by then the orphaned session has timed out. Bounded at
  // two attempts: if the CI-V address is genuinely wrong, or the radio is genuinely
  // silent, no number of rebuilds helps and an endless loop would throw away whichever
  // half does work.
  // REPORTED, not acted on. The caller decides whether to rebuild, because only it
  // knows how to take the session down — and calling back into it from here reached a
  // teardown that did not exist yet, which crashed the process on the first restart
  // that failed to carry. A callback into a half-built closure is a trap; handing the
  // fact back is not.
  const carrying = await source.streamsCarrying();
  if (carrying.ok) {
    console.log(
      `[radio] Icom streams carrying: ${carrying.civ} CI-V frames, ` +
        `${carrying.audio} audio packets, ${source.getFrequencyHz() ?? "?"} Hz`,
    );
  } else {
    console.error(
      `[radio] Icom opened but is carrying nothing useful: ${carrying.civ} CI-V frames, ` +
        `${carrying.audio} audio packets.`,
    );
  }
  freqTimer.unref?.();

  deps.armWatchdog(source.periodMs, "icom decode pipeline");

  // Transmit, if the operator has armed it. Same gate as the Flex path: off by default,
  // re-read at transmit time so flipping the setting takes effect without a restart.
  let transmitter: IcomTransmitter | null = null;
  let operating: Operating | null = null;
  const allowTransmit = await isTransmitArmed("icom");
  const serial = source.serialStream;
  const audio = source.audioStream;
  if (serial && audio) {
    transmitter = new IcomTransmitter({
      serial,
      audio,
      address: source.address,
      identity: source.identity,
      allowTransmit,
      isTransmitAllowed: transmitGate("icom"),
      // Measured off the audio stream's own keepalives — near zero on the shack
      // LAN, real for a remote radio. See lib/radio/link-latency.ts.
      linkOneWayMs: () => source.linkOneWayMs(),
    });
    status.allowTransmit = allowTransmit;
    console.log(
      `[radio] Icom transmitter attached (CI-V 0x${source.address.toString(16)}, allowTransmit=${allowTransmit})`,
    );

    // Power, if the operator set one. The Flex path does this through its GUI client;
    // here it is one CI-V command and it is worth doing, because an IC-7300 left at
    // 100% into a digital mode is how PAs die.
    const pct = await getNumberSetting("icom.rfPowerPercent", 0);
    if (pct > 0) {
      const { setRfPower } = await import("@/lib/icom/civ");
      serial.write(setRfPower(source.address, pct));
      status.rfPower = pct;
      console.log(`[radio] Icom RF power set to ${pct}%`);
    } else {
      console.log(
        "[radio] Icom RF power left as the radio has it — set icom.rfPowerPercent to have DigiShack manage it",
      );
    }

    // Ask the RADIO what it thinks, once, at attach — the counterpart to the Flex's
    // preflight, which has been catching real misconfiguration on that path.
    try {
      const pre = await source.preflight();
      status.txBlockers = pre.blockers;
      status.txWarnings = pre.warnings;

      // A radio found keyed gets unkeyed, not merely reported.
      //
      // Twice on consecutive evenings this radio was left transmitting by a bridge
      // restart that happened mid-transmission: the unkey has to reach it over the same
      // CI-V stream being torn down, and the next session inherited an orphan it could
      // not unkey through. Preflight SAW it both times — `The radio is already
      // transmitting` — and did nothing, because the finding was a string in a list.
      //
      // A fresh session has a working CI-V stream, which is exactly what the stuck one
      // lacked, so it is the right place to fix it. Unconditional: there is no state in
      // which we want to attach to a radio that is transmitting something we did not ask
      // for.
      if (pre.transmitting) {
        console.error(
          "[radio] the radio was already transmitting when we attached — unkeying it now. " +
            "That is what a restart during a transmission leaves behind.",
        );
        await transmitter.unkey().catch(() => undefined);
        const still = await source.isKeyed();
        console.error(
          still === false
            ? "[radio] confirmed unkeyed."
            : still === null
              ? "[radio] sent the unkey; the radio would not confirm either way."
              : "[radio] STILL TRANSMITTING after an unkey — power-cycle the radio.",
        );
      }
      // The slider reads this. It sat blank on the Icom because nothing ever set it,
      // so the one control that decides how hard the finals work showed nothing at all.
      if (pre.rfPower !== null) status.rfPower = pre.rfPower;
      for (const b of pre.blockers) console.warn(`[radio] TX BLOCKER: ${b}`);
      for (const w of pre.warnings) console.warn(`[radio] tx warning: ${w}`);
      for (const n of pre.notes) console.log(`[radio] preflight: ${n}`);
      if (pre.blockers.length === 0 && pre.warnings.length === 0) {
        console.log(
          `[radio] preflight clean (${pre.mode ?? "?"}${pre.dataMode ? "-D" : ""}, ` +
            `${pre.rfPower ?? "?"}% power, ATU ${pre.atu})`,
        );
      }
      broadcast({ kind: "status", status });
    } catch (err) {
      console.warn(
        `[radio] preflight could not run: ${err instanceof Error ? err.message : err}`,
      );
    }

    // The operating layer. Identical to the FlexRadio's, from the same builder — the
    // two functions below are the entire difference between the radios.
    //
    // Identity comes from the logbook's own station record. The radio knows a callsign
    // but not a grid, and the log is the authority anyway.
    const station = await prisma.station.findFirst({ orderBy: { createdAt: "asc" } });
    if (!station) {
      console.warn(
        "[radio] Icom automatic modes unavailable: no station exists — create one first",
      );
    } else {
      status.deCall = station.callsign;
      status.deGrid = station.grid;

      // Tuning is one CI-V command, and `setFrequencyHz` throws when the serial stream
      // has gone away rather than returning false, so the boolean the operating layer
      // wants is made here. A failed retune is a reason to stay put, never to throw
      // into a window handler.
      const tuneHz = async (hz: number): Promise<boolean> => {
        try {
          await source.setFrequencyHz(hz);
          return true;
        } catch (err) {
          console.warn(
            `[radio] could not tune to ${(hz / 1e6).toFixed(3)} MHz: ${err instanceof Error ? err.message : err}`,
          );
          return false;
        }
      };

      // Mute the decoder for the window we transmit in.
      //
      // Wrapped here rather than inside the transmitter because this is a property of the
      // RADIO — the Icom streams receive audio through a transmission and the FlexRadio
      // does not — and the transmitter has no business knowing about a decode pipeline.
      //
      // `startAt` is the window boundary, so muting to the end of that window covers the
      // whole transmission with margin. It also discards the tail of the window already
      // decoded, which was being thrown away anyway.
      const keyed = transmitter;
      const mutingTx: DigitalTransmitter = {
        transmit: async (req) => {
          if (req.startAt) source.muteReceiveUntil(req.startAt + source.periodMs);
          return keyed.transmit(req);
        },
        unkey: () => keyed.unkey(),
      };

      operating = await buildOperating({
        kind: "icom",
        source,
        tx: mutingTx,
        station,
        dialHz: () => status.dialFrequency,
        radio: () => status.radio?.model ?? null,
        // Same as the FlexRadio path: a floor lets the operator tell a quiet band
        // from one buried in local noise.
        noiseDbm: deps.noiseDbm,
        retune: async (band, mode) => {
          const hz = callingFrequencyHz(band, mode);
          if (hz === null) return false;
          if (!(await tuneHz(hz))) return false;
          // Run the tuner on a band change, when the operator has asked for it.
          //
          // Off by default, and gated on transmit like every other keying path: an ATU
          // cycle is a low-power carrier, and one into a disconnected antenna is
          // exactly as unwise as a CQ into one. Without this a band hop lands on a band
          // the tuner has never seen and the radio folds back.
          if (
            (await getBooleanSetting("icom.atuOnBandChange", false)) &&
            (await isTransmitArmed("icom"))
          ) {
            const r = await source.tuneAtu().catch((err: unknown) => ({
              ok: false,
              state: "unknown" as const,
              reason: err instanceof Error ? err.message : String(err),
            }));
            console.log(
              r.ok
                ? `[radio] ATU tuned for ${band} (${r.state})`
                : `[radio] ATU tune failed on ${band}: ${r.reason ?? "no reason given"}`,
            );
          }
          return true;
        },
        tuneHz,
        broadcast,
        log: (line) => console.log(`[radio] ${line}`),
        flushDecodes: deps.flushDecodes,
      });
    }
  } else {
    console.error("[radio] Icom transmit unavailable: the CI-V or audio stream is not open");
  }

  // Radio health into the guards. SWR is the one reading that should stop unattended
  // transmission on its own, and the guard only trusts it while the radio is actually
  // keyed — which the transmitter is the authority on, since nothing else on this path
  // tracks it.
  source.on("telemetry", (t) => {
    const keyed = transmitter?.transmitting ?? false;
    status.transmitting = keyed;
    if (operating) {
      operating.guards.onTelemetry({ swr: t.swr, paTempC: t.paTempC, transmitting: keyed });
      watchGuardFaults(operating.guards);
    }
  });

  // Did that transmission actually produce RF?
  //
  // `MOD Input -> DATA MOD` must be LAN. On anything else the radio keys perfectly, the
  // timing is perfect, and it transmits silence — and this project has said for weeks
  // that no software can detect it. That was true only while the meters did not work.
  // SSB with no modulation produces no output, so **forward power reading zero while
  // keyed is exactly that fault**, and forward power reports now.
  //
  // Watched rather than asked: the Po meter is polled every two seconds and a
  // transmission lasts 12.6, so several samples land inside each one. The peak is what
  // matters — a single zero at the very start or end of a transmission means nothing.
  //
  // Said once per session, not once per transmission. An operator who has not fixed the
  // radio's menu does not need it every fifteen seconds, and burying the log helps
  // nobody.
  let txPeakWatts = 0;
  let wasTransmitting = false;
  let silentCarrierReported = false;
  const rfWatch = setInterval(() => {
    const keyed = transmitter?.transmitting ?? false;

    if (keyed) {
      wasTransmitting = true;
      txPeakWatts = Math.max(txPeakWatts, source.forwardPowerWatts);
      return;
    }

    if (!wasTransmitting) return;
    wasTransmitting = false;
    const peak = txPeakWatts;
    txPeakWatts = 0;

    if (peak > 0.5 || silentCarrierReported) return;
    silentCarrierReported = true;
    console.error(
      "[radio] THAT TRANSMISSION PRODUCED NO RF. The radio keyed and the forward-power " +
        "meter never left zero, which means no audio reached the transmitter. Check " +
        "MOD Input -> DATA MOD = LAN in the radio's menu — on anything else it keys " +
        "perfectly, the timing is perfect, and nobody hears you. Said once per session.",
    );
  }, 1_000);
  rfWatch.unref?.();

  // Watch the AUDIO, because nothing else does.
  //
  // The liveness watchdog counts decode windows, and the pipeline emits those on a
  // timer whether or not a single sample arrived — so a radio that stops sending audio
  // looks perfectly alive to it: windows on schedule, heartbeat fresh, and no decodes
  // for as long as you care to wait. Measured on the air: 350 spectrum frames in 90
  // seconds of which ONE differed from the one before, which is the analyser recomputing
  // the same frozen ring. From the operating chair it is indistinguishable from a dead
  // band, and it is why "it stopped decoding again" kept coming back.
  //
  // The packet counter is the honest signal. Transmitting is excluded because receive
  // audio legitimately stops while keyed, and the threshold sits well past the longest
  // transmission so a slow FT8 cycle can never trip it.
  let lastAudioCount = source.audioPacketsSeen;
  let lastAudioAt = Date.now();
  let audioAlarmed = false;
  let trafficAtStall = source.audioTraffic;
  let keepalivesAtStall = 0;
  let droppedAtStall = 0;
  const audioWatch = setInterval(() => {
    const now = source.audioPacketsSeen;
    if (now !== lastAudioCount) {
      lastAudioCount = now;
      lastAudioAt = Date.now();
      audioAlarmed = false;
      trafficAtStall = source.audioTraffic;
      // Snapshotted with the traffic, so both counters measure the same interval — the one
      // beginning at the last audio packet that actually arrived.
      keepalivesAtStall = source.audioKeepalivesSent;
      droppedAtStall = source.audioDropped;
      return;
    }
    // Receive audio stops while the radio is keyed. That is not a fault.
    if (transmitter?.transmitting) {
      lastAudioAt = Date.now();
      return;
    }
    const silentMs = Date.now() - lastAudioAt;
    if (silentMs < AUDIO_DEAD_MS || audioAlarmed) return;
    audioAlarmed = true;

    // WHICH kind of silence is this? The audio socket carries the radio's pings as well
    // as its audio, so the two counters separate a protocol fault from a network one —
    // and they are the difference between "the radio stopped sending" and "we stopped
    // receiving", which look identical from every layer above.
    const nowTraffic = source.audioTraffic;
    const newDatagrams = nowTraffic.datagrams - trafficAtStall.datagrams;
    const newPings = nowTraffic.pings - trafficAtStall.pings;
    const verdict =
      newPings > 0
        ? `the radio is STILL PINGING on the audio socket (${newPings} since the audio ` +
          `stopped) — it is holding the session and has stopped sending audio, which makes ` +
          `this the radio's doing rather than the network's`
        : newDatagrams > 0
          ? `${newDatagrams} non-audio datagrams arrived but no pings — unexpected; worth a capture`
          : `NOTHING at all has arrived on the audio socket — the session or the route is gone, ` +
            `not just the audio`;

    console.error(
      `[radio] Icom audio has stopped: no packet for ${Math.round(silentMs / 1000)}s ` +
        `(${now} received in total). Windows keep arriving because the pipeline runs on a ` +
        `timer, so nothing else notices — rebuilding the session.`,
    );
    // How much silence we sent while it was stalling. The keepalive exists precisely to
    // stop this fault, so a stall with the counter climbing means the keepalive is not the
    // answer — and a stall with it stuck means the keepalive itself died.
    const sent = source.audioKeepalivesSent - keepalivesAtStall;
    // Gaps in the radio's audio sequence numbers, which is what separates a network path
    // from a radio. Lost datagrams leave holes in the middle of the stream; a radio that
    // stops streaming leaves none, because nothing is missing — the sequence just ends.
    const lost = source.audioDropped - droppedAtStall;
    console.error(
      `[radio] audio stall diagnosis: ${verdict}. We sent ${sent} silence keepalive(s) ` +
        `in that time (${source.audioKeepalivesSent} this session). ` +
        (lost > 0
          ? `${lost} audio packet(s) went missing before it stopped — gaps in the sequence, ` +
            `which points at the network path rather than the radio.`
          : `No gaps in the audio sequence (${source.audioDropped} lost all session), so the ` +
            `stream ENDED rather than being interrupted — that is the radio, not the link.`),
    );
    deps.onLost?.("audio stopped arriving");
  }, AUDIO_CHECK_MS);
  audioWatch.unref?.();

  return {
    source,
    transmitter,
    operating,
    carrying,
    async stop() {
      clearInterval(freqTimer);
      clearInterval(audioWatch);
      clearInterval(rfWatch);

      // Unkey, then CONFIRM, and only then release the streams.
      //
      // The unkey is one CI-V datagram and nothing acknowledges it. Sending it and
      // immediately closing the stream it travels over is how this radio ended up
      // transmitting for four minutes after a restart. Reading PTT back costs a few
      // hundred milliseconds of shutdown — PM2 allows eight seconds — and it is the
      // difference between believing the radio is quiet and knowing it.
      if (transmitter) {
        await transmitter.unkey().catch(() => undefined);
        for (let attempt = 0; attempt < 3; attempt++) {
          const keyed = await source.isKeyed();
          if (keyed === false) break;
          if (keyed === null) {
            // No answer. One more unkey and out — a radio that will not talk cannot be
            // reasoned with, and its own transmit timeout is the last line of defence.
            await transmitter.unkey().catch(() => undefined);
            break;
          }
          console.error(
            `[radio] the radio is still transmitting on shutdown — unkeying again (${attempt + 1}/3)`,
          );
          await transmitter.unkey().catch(() => undefined);
        }
      }

      await source.stop().catch(() => undefined);
    },
  };
}

/** Read once so the caller can log what it is about to do. */
export async function icomTarget(): Promise<string> {
  return (await getSetting("icom.host")) ?? "(unset)";
}

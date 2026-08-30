import { nowMs } from "@/lib/time/clock";
import dgram from "node:dgram";

import { FlexClient } from "@/lib/flex/client";
import { resolveAntenna } from "@/lib/flex/antennas";
import {
  lateTxToleranceMs,
  nextWindowStart,
  PERIOD_MS,
  transmitStartAt,
} from "@/lib/radio/timing";
import { buildWaveform, samplesPerSymbol } from "@/lib/radio/waveform";

// Native FT8/FT4 transmit over FlexRadio DAX TX. No external decoder, no WSJT-X.
//
// THIS PUTS RF ON THE AIR. Everything here is written on the assumption that the
// dangerous failure is not "no signal" but "transmitter left keyed": that jams the
// band, can damage the PA, and is a licence problem. So:
//
//   * `allowTransmit` must be explicitly enabled; it defaults to off.
//   * The waveform is generated BEFORE keying. A message that fails to encode can
//     never leave the radio keyed with nothing to send.
//   * A watchdog unkeys unconditionally, independent of the send loop, and fires
//     even if that loop throws, hangs, or the socket dies.
//   * unkey() is idempotent and runs on error, on stop, and on process exit.
//   * Transmissions are capped in length and refuse to overlap.
//
// Wire format matches the receive path, verified against a FLEX-6400: VITA-49 with
// a 28-byte header then interleaved stereo float32 big-endian at 24 kHz.

const VITA_HEADER_BYTES = 28;

const DAX_RATE = 24_000;

/** Frames per packet, matching what the radio sends on receive. */
const FRAMES_PER_PACKET = 128;

/**
 * The radio's VITA-49 UDP port for data sent TO it.
 *
 * 4991. Note this is NOT the port the radio sends *from* — that is 4993, and
 * mistaking the observed source port for the destination is an easy wrong turn,
 * because nothing reports an error either way: the radio still keys on command and
 * reports TRANSMITTING, so the only symptom is a transmission with no output.
 */
const RADIO_VITA_PORT = 4991;

/** FlexRadio OUI and information-class word, as observed on the RX stream. */
const OUI = 0x001c2d;
const INFO_CLASS = 0x534c;

/**
 * Packet class for reduced-bandwidth DAX TX audio: mono int16 BE at 24 kHz.
 * Requires `client set send_reduced_bw_dax=true`. (0x03e3, the class the radio
 * uses on receive, means float32 — and mono 48 kHz in the TX direction.)
 */
const PACKET_CLASS_TX_S16 = 0x0123;

/**
 * Channel symbols per frame, including the modulator's pulse-shaping tail.
 *
 * FT2 is 146 rather than its 144 channel symbols: the GFSK modulator convolves
 * each symbol with a 3-symbol Gaussian pulse, so the waveform runs two symbols
 * past the last one. Using 144 here would size the watchdog 27 ms short of the
 * actual transmission.
 */
const SYMBOLS_PER_FRAME = { FT8: 79, FT4: 105, FT2: 146 } as const;

/** Extra time before the watchdog fires, allowing for scheduling jitter. */
const WATCHDOG_MARGIN_MS = 2_000;

export type TxMode = "FT8" | "FT4" | "FT2";

/**
 * Above this percentage of the radio's rated output, say something.
 *
 * A percentage of the radio, not watts — a FLEX-6400 at 90% is about 90 W and a 6600 at
 * 90% is about 180 W, and the radio reports the percentage rather than the power. Worth
 * being precise about, because the two get conflated when reading it back to somebody.
 *
 * Exported so the live re-check in the bridge uses the same threshold as the preflight
 * that first raised it. Two copies of this number is how a warning appears at one level
 * and disappears at another.
 */
export const RF_POWER_WARN_PCT = 30;

export interface TransmitterOptions {
  host: string;
  port?: number;
  daxChannel?: number;
  /**
   * Dial frequency for the slice DigiShack creates when the radio has none.
   * Ignored when a slice already exists — the existing TX slice is used as-is.
   */
  freqHz?: number;
  /**
   * Which antenna port to transmit into, on a radio that has more than one.
   *
   * This was `ANT1`, hardcoded into the `slice create` below. On the live path it never
   * ran — the transmitter shares the decode path's slice, which is where the antenna is
   * now applied — but the standalone path is what every bench script and every
   * receive-disabled test uses, and a transmitter that keys into a socket the operator
   * has nothing plugged into is worse than one that refuses.
   *
   * Ignored in shared mode, where the slice and its antenna belong to the DAX source.
   */
  antenna?: { tx?: string | null; rx?: string | null };
  /** Must be true for anything to key the radio. */
  allowTransmit: boolean;
  /**
   * Re-read the master gate at transmit time.
   *
   * `allowTransmit` above is a snapshot taken at construction, and
   * `setAllowTransmit()` had zero callers — so flipping the setting in Settings did
   * nothing until the service restarted, while the setting's own help text promises
   * "Off means nothing can key the radio, ever". Supplying this closure makes the
   * switch immediate, which is how `transmit tune` and `atu start` already behave.
   */
  isTransmitAllowed?: () => Promise<boolean>;
  /**
   * Share an existing connection instead of opening one.
   *
   * This is how the radio service runs: its decode path is already a GUI client
   * named DigiShack with a slice and a registered UDP port, and a second GUI
   * client from the same process would claim a second slice — on a two-slice
   * radio, that is half the radio spent on a name. In shared mode start() only
   * adds what transmit needs (TX routing and the dax_tx stream) and stop() only
   * removes what it added.
   */
  shared?: {
    client: FlexClient;
    socket: dgram.Socket;
    sliceIndex: number;
  };
  /**
   * One-way transit to the radio, ms, asked fresh at each transmission.
   *
   * The key command and the audio both cross the network before any RF leaves the
   * antenna, so over a VPN every transmission is late by the transit time — with the
   * clock itself perfectly corrected. Supplied as a closure (from the DAX source's
   * measurement) rather than a number so a VPN that reroutes mid-session is picked up
   * by the next transmission, not the next restart. See lib/radio/link-latency.ts.
   */
  linkOneWayMs?: () => number;
}

export interface TransmitRequest {
  message: string;
  mode: TxMode;
  /** Audio offset within the passband, Hz. */
  offsetHz: number;
  /**
   * UTC ms at which the transmission should begin. Rounded to the mode's window
   * boundary by the caller; this class does not guess timing.
   */
  startAt: number;
}

export interface TransmitResult {
  sent: boolean;
  reason?: string;
  message: string;
  mode: TxMode;
  offsetHz: number;
  /** Actual keying instant, for comparison against the intended one. */
  keyedAt?: number;
  unkeyedAt?: number;
  /** How far keying missed the window boundary. FT8 tolerates roughly ±1.5 s. */
  timingErrorMs?: number;
  packetsSent?: number;
}

export class FlexDaxTransmitter {
  private readonly opts: Required<
    Omit<TransmitterOptions, "allowTransmit" | "shared" | "isTransmitAllowed" | "linkOneWayMs">
  > & {
    allowTransmit: boolean;
    isTransmitAllowed: (() => Promise<boolean>) | null;
    shared: TransmitterOptions["shared"] | null;
    linkOneWayMs: (() => number) | null;
  };

  private client: FlexClient | null = null;
  private socket: dgram.Socket | null = null;
  private streamId: string | null = null;
  private streamIdNum = 0;
  /** Slice the DAX channel is attached to. */
  private sliceIndex: number | null = null;
  /** True when the slice was created by us and should be removed on stop(). */
  private createdSlice = false;
  /** GUI clients other than us, counted before we registered. */
  private otherGuiClients = 0;

  /** True between xmit 1 and xmit 0. */
  private keyed = false;
  private busy = false;
  /**
   * When `busy` was set, and for which window. Null whenever `busy` is false.
   *
   * Recorded because `TX refused: A transmission is already in progress` has been the most
   * common refusal in the log by a wide margin - 831 occurrences, and the rate tripled from
   * ~2% of attempts to ~10% the hour 1.129.0 landed - and the message cannot say WHICH of
   * the two flags refused it, nor for how long it has been set. Diagnosing it from the log
   * meant inferring intervals between unrelated lines, which produced a plausible theory
   * about window slack that a measurement then disproved.
   *
   * A refusal is cheap; a refusal nobody can explain is not.
   */
  private busySince: number | null = null;
  private busyForWindow: number | null = null;
  /**
   * Bumped on every accepted transmit request, so a superseded one can tell it no longer
   * owns the transmitter and must not clear state the new owner is using.
   */
  private txGen = 0;
  /**
   * The transmission that is WAITING for its window and has not keyed yet.
   *
   * Null once keying starts — from that moment there is a real signal on the air and
   * nothing may take the transmitter. See the supersede rule in `transmit`.
   */
  private pendingKey: { gen: number; startAt: number; abort: () => void } | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private packetCount = 0;

  constructor(options: TransmitterOptions) {
    this.opts = {
      host: options.host,
      port: options.port ?? 4992,
      daxChannel: options.daxChannel ?? 1,
      freqHz: options.freqHz ?? 7_074_000,
      antenna: {
        tx: options.antenna?.tx ?? null,
        rx: options.antenna?.rx ?? options.antenna?.tx ?? null,
      },
      allowTransmit: options.allowTransmit,
      isTransmitAllowed: options.isTransmitAllowed ?? null,
      shared: options.shared ?? null,
      linkOneWayMs: options.linkOneWayMs ?? null,
    };
  }

  /** Enable or disable transmit at runtime (the master gate, from settings). */
  setAllowTransmit(allowed: boolean): void {
    this.opts.allowTransmit = allowed;
  }

  get isKeyed(): boolean {
    return this.keyed;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async start(): Promise<void> {
    if (this.opts.shared) {
      await this.startShared(this.opts.shared);
      return;
    }

    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    await new Promise<void>((resolve) => socket.bind(0, "0.0.0.0", () => resolve()));

    const client = new FlexClient(this.opts.host, this.opts.port);
    this.client = client;
    await client.connect();

    // Register as a GUI client — this is the piece everything else hinged on.
    //
    // A NON-GUI client can issue every one of the commands below with status 0x0,
    // key the radio, and stream perfectly formatted audio — and the radio will
    // discard every sample without an error anywhere. The live A/B that proved it:
    // as a non-GUI client a full-scale tone read the same forward power as digital
    // silence (~2 dBm of noise); the moment the same session registered with
    // `client gui`, the same tone read 42 dBm — right at the 20 %-power target.
    //
    // Being a GUI client also means owning slices, which is what a self-contained
    // DigiShack wants anyway: no dependence on SmartSDR or AetherSDR being open.
    // Count the GUI clients that were here before us. This decides whether an
    // existing slice belongs to an operator (leave it alone) or is the radio's
    // restored default profile (ours to steer).
    const seen = new Set<string>();
    const onClient = (st: { object: string; fields: Record<string, string> }): void => {
      if (st.object.startsWith("client") && st.fields.client_id && st.fields.program) {
        seen.add(st.fields.client_id);
      }
    };
    client.on("status", onClient);
    await client.command("sub client all");
    await new Promise((r) => setTimeout(r, 1_000));
    client.off("status", onClient);
    this.otherGuiClients = seen.size;

    const gui = await client.command("client gui");
    if (gui.status !== 0) {
      throw new Error(
        `Could not register as a GUI client (0x${gui.status.toString(16)})`,
      );
    }
    await client.command("client station DigiShack").catch(() => {});

    // Register our UDP port, exactly as the receive path must. The radio ties
    // streams to a client's registered port; without this the stream is created
    // against the wrong endpoint.
    const addr = socket.address();
    const udpPort = typeof addr === "object" ? addr.port : 0;
    const reg = await client.command(`client udpport ${udpPort}`);
    if (reg.status !== 0) {
      throw new Error(
        `Radio rejected 'client udpport ${udpPort}' (0x${reg.status.toString(16)})`,
      );
    }

    // The whole DAX wiring below follows nDAX (kc2g-flex-tools), the only open
    // implementation that demonstrably transmits through a Flex. The pieces that
    // were missing before it was consulted are marked.

    // Reduced-bandwidth DAX: 16-bit @ 24 kHz rather than float32 @ 48 kHz. This is
    // what selects the payload format the packetiser below emits.
    await client.command("client set send_reduced_bw_dax=true").catch(() => {});

    // Find the transmit slice — the DAX channel has to be attached to a slice.
    // If the radio has none (nothing else is connected), create our own in DIGU.
    // Slices belong to GUI clients, so ours disappears with our connection.
    await client.command("sub slice all");
    await new Promise((r) => setTimeout(r, 1_200));
    let slices = [...client.state.slices.values()];
    let txSlice = slices.find((s) => s.tx) ?? slices[0];

    if (!txSlice) {
      const mhz = (this.opts.freqHz / 1_000_000).toFixed(6);
      // `ant=` on a create is the receive port. ANT1 stays the fallback for a station
      // that has configured nothing, but it is no longer the only possibility.
      const createAnt =
        resolveAntenna(this.opts.antenna.rx, client.state.antennas.rx).ant ?? "ANT1";
      const madeSlice = await client.command(
        `slice create freq=${mhz} ant=${createAnt} mode=DIGU`,
      );
      if (madeSlice.status !== 0) {
        throw new Error(
          `The radio has no slice and one could not be created (0x${madeSlice.status.toString(16)})`,
        );
      }
      this.createdSlice = true;
      await new Promise((r) => setTimeout(r, 1_200));
      slices = [...client.state.slices.values()];
      txSlice = slices.find((s) => s.tx) ?? slices[0];
      if (!txSlice) throw new Error("Created a slice but the radio never reported it");
      if (!txSlice.tx) {
        // NOT SWALLOWED. A slice without `tx=1` is not the transmit slice, so the radio
        // keys and puts NOTHING on the air — measured 2026-08-30 as 0.0 W across 45
        // forward-power readings per transmission, with the operator watching a station
        // that looked like it was working people. Every other command in this method
        // checks its status and throws; this one caught and discarded the answer, which
        // is how a fatal refusal became a silent one.
        const setTx = await client.command(`slice set ${txSlice.index} tx=1`);
        if (setTx.status !== 0) {
          throw new Error(
            `The radio refused to make slice ${txSlice.index} the transmit slice ` +
              `(0x${setTx.status.toString(16)}). Without a transmit slice, keying produces no RF.`,
          );
        }
      }
    } else if (client.state.slices.size > 0 && this.otherGuiClients === 0) {
      // The slice existed before we did anything explicit — but when no other GUI
      // client is connected, it is the radio's restored default profile brought up
      // by OUR `client gui` registration, not something an operator is using. Left
      // alone, that profile transmits wherever it last sat (a real one restored at
      // 14.100 USB at 100 % power). Steer it to the intended frequency and mode.
      const mhz = (this.opts.freqHz / 1_000_000).toFixed(6);
      await client.command(`slice tune ${txSlice.index} ${mhz}`).catch(() => {});
      if (!/^DIG[UL]$/i.test(txSlice.mode ?? "")) {
        await client.command(`slice set ${txSlice.index} mode=DIGU`).catch(() => {});
      }
    }
    this.sliceIndex = txSlice.index;

    // The transmit port, on a slice that is ours to steer — ours by creation, or the
    // restored default profile. Same condition as the tune and mode steering above, and
    // for the same reason: an operator's own slice stays on the antenna they chose.
    //
    // A port the radio does not have is REFUSED, not silently replaced with ANT1. This
    // is the transmit path, so a wrong antenna is not a display fault: it is RF into a
    // socket with a cap on it.
    if (this.createdSlice || this.otherGuiClients === 0) {
      const ports = client.state.antennas;
      const rx = resolveAntenna(this.opts.antenna.rx, ports.rx, "receive");
      const tx = resolveAntenna(this.opts.antenna.tx, ports.tx, "transmit");
      for (const refused of [rx.refused, tx.refused]) {
        if (refused) console.warn(`[flex/tx] ${refused}`);
      }
      const sets = [
        ...(rx.ant ? [`rxant=${rx.ant}`] : []),
        ...(tx.ant ? [`txant=${tx.ant}`] : []),
      ];
      if (sets.length > 0) {
        const r = await client.command(`slice set ${txSlice.index} ${sets.join(" ")}`);
        if (r.status !== 0) {
          console.warn(
            `[flex/tx] the radio refused ${sets.join(" ")} on slice ${txSlice.index} ` +
              `(0x${r.status.toString(16)})`,
          );
        } else {
          console.log(`[flex/tx] slice ${txSlice.index} ${sets.join(" ")}`);
        }
      }
    }

    // MISSING PIECE #1: the slice must be told which DAX channel feeds it. Without
    // this the channel is connected to nothing, and TX audio sent to it is
    // discarded with no error — keying still works, so the only symptom is a
    // transmission with no output.
    const attach = await client.command(
      `slice set ${txSlice.index} dax=${this.opts.daxChannel}`,
    );
    if (attach.status !== 0) {
      throw new Error(
        `Could not attach DAX channel ${this.opts.daxChannel} to slice ${txSlice.index} (0x${attach.status.toString(16)})`,
      );
    }

    // MISSING PIECE #2: the dax audio route needs the slice index and tx=1
    // together. (Plain `dax audio set <ch> tx=1` without slice= is rejected.)
    const route = await client.command(
      `dax audio set ${this.opts.daxChannel} slice=${txSlice.index} tx=1`,
    );
    if (route.status !== 0) {
      throw new Error(
        `Could not route DAX channel ${this.opts.daxChannel} for TX (0x${route.status.toString(16)})`,
      );
    }

    const created = await client.command(
      `stream create type=dax_tx dax_channel=${this.opts.daxChannel}`,
    );
    if (created.status !== 0) {
      throw new Error(
        `Could not create a DAX TX stream (0x${created.status.toString(16)})`,
      );
    }
    this.streamId = created.message.trim();
    this.streamIdNum = parseInt(this.streamId, 16);

    // The radio also needs DAX selected as the transmit source globally. This is
    // normally already on for digital operation, and it is deliberately never
    // turned back off in stop(): other software on the same radio (WSJT-X, for
    // one) depends on it, and silently disabling its transmit path would be a
    // nasty surprise.
    // Set unconditionally: there is no supported way to read it back first
    // (`transmit info` answers 0x50000016 on SmartSDR 4.2), and setting it when it
    // is already on is a no-op.
    const daxSrc = await client.command("transmit set dax=1");
    if (daxSrc.status !== 0) {
      // ALSO NOT SWALLOWED, for the same reason and with the same consequence: with DAX
      // not selected as the transmit source the radio takes audio from the microphone and
      // ignores the stream entirely. The preflight already had a blocker for this
      // condition ("DAX is not selected as the transmit source") — it fired on the live
      // station and nothing acted on it, because the command that should have prevented
      // it had thrown its own answer away.
      throw new Error(
        `The radio refused to select DAX as the transmit source (0x${daxSrc.status.toString(16)}). ` +
          `Transmissions would key the radio and put no audio on the air.`,
      );
    }

    // Last line of defence: if this process dies mid-transmission, the radio must
    // not be left keyed.
    process.once("exit", () => void this.emergencyUnkey());
    process.once("SIGINT", () => void this.emergencyUnkey());
    process.once("SIGTERM", () => void this.emergencyUnkey());
  }

  /**
   * Shared-mode start: the decode path already owns a GUI-client connection, a
   * registered UDP port and a slice with the DAX channel attached. Transmit only
   * has to add its own routing and stream on top.
   */
  private async startShared(shared: NonNullable<TransmitterOptions["shared"]>): Promise<void> {
    this.client = shared.client;
    this.socket = shared.socket;
    this.sliceIndex = shared.sliceIndex;
    this.createdSlice = false; // never ours to remove in shared mode

    // The dax audio route must carry tx=1 *from this connection* — the official
    // docs are explicit that the radio records the sender of this command as the
    // client that will supply transmit samples. Shared mode uses the same
    // connection as decode, so this is exactly right.
    const route = await shared.client.command(
      `dax audio set ${this.opts.daxChannel} slice=${shared.sliceIndex} tx=1`,
    );
    if (route.status !== 0) {
      throw new Error(
        `Could not route DAX channel ${this.opts.daxChannel} for TX (0x${route.status.toString(16)})`,
      );
    }

    const created = await shared.client.command(
      `stream create type=dax_tx dax_channel=${this.opts.daxChannel}`,
    );
    if (created.status !== 0) {
      throw new Error(
        `Could not create a DAX TX stream (0x${created.status.toString(16)})`,
      );
    }
    this.streamId = created.message.trim();
    this.streamIdNum = parseInt(this.streamId, 16);

    await shared.client.command("transmit set dax=1").catch(() => {});

    process.once("exit", () => void this.emergencyUnkey());
    process.once("SIGINT", () => void this.emergencyUnkey());
    process.once("SIGTERM", () => void this.emergencyUnkey());
  }

  async stop(): Promise<void> {
    await this.unkey();

    if (this.client && this.streamId) {
      // The 0x prefix is required — see the receive path.
      await this.client.command(`stream remove 0x${this.streamId}`).catch(() => {});
    }
    this.streamId = null;

    if (this.opts.shared) {
      // Shared mode: the connection, socket and slice belong to the decode path.
      // Undo only our TX routing and leave everything else exactly as found.
      if (this.client && this.sliceIndex !== null) {
        await this.client
          .command(`dax audio set ${this.opts.daxChannel} slice=${this.sliceIndex} tx=0`)
          .catch(() => {});
      }
      this.client = null;
      this.socket = null;
      this.sliceIndex = null;
      return;
    }

    // Only remove a slice we created; someone else's slice is not ours to close.
    if (this.client && this.createdSlice && this.sliceIndex !== null) {
      await this.client.command(`slice remove ${this.sliceIndex}`).catch(() => {});
      this.createdSlice = false;
    }
    this.sliceIndex = null;

    this.client?.disconnect();
    this.client = null;

    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  /**
   * Read the radio's own view of its transmit state.
   *
   * Read-only, and worth doing before any first transmission: it is the difference
   * between "we think this is safe" and "the radio says it is". `blockers` lists
   * conditions that would make keying wrong rather than merely unusual.
   */
  async preflight(): Promise<{
    freqMhz: string | null;
    rfPower: number | null;
    txSliceMode: string | null;
    filterHiHz: number | null;
    inhibit: boolean;
    daxEnabled: boolean;
    tuning: boolean;
    interlockState: string | null;
    txAllowed: boolean;
    /** Another client (WSJT-X, SmartSDR) currently owns the transmitter. */
    otherClientOwnsTx: boolean;
    blockers: string[];
    warnings: string[];
  }> {
    const client = this.client;
    if (!client) throw new Error("Transmitter is not started");

    const fields: Record<string, Record<string, string>> = {};
    const onStatus = (s: {
      object: string;
      fields: Record<string, string>;
    }): void => {
      const key = s.object.split(/\s+/)[0] ?? s.object;
      fields[key] = { ...(fields[key] ?? {}), ...s.fields };
    };
    client.on("status", onStatus);
    await client.command("sub tx all");
    await client.command("sub slice all");
    await new Promise((r) => setTimeout(r, 1_500));
    client.off("status", onStatus);

    const tr = fields.transmit ?? {};
    const il = fields.interlock ?? {};

    const rfPower = tr.rfpower ? Number(tr.rfpower) : null;
    const txSliceMode = tr.tx_slice_mode ?? null;
    const inhibit = tr.inhibit === "1";
    const daxEnabled = tr.dax === "1";
    const tuning = tr.tune === "1";
    const txAllowed = il.tx_allowed !== "0";
    const interlockState = il.state ?? null;
    const otherClientOwnsTx = Boolean(
      il.tx_client_handle &&
        client.state.handle &&
        il.tx_client_handle.replace(/^0x/i, "").toUpperCase() !==
          client.state.handle.replace(/^0x/i, "").toUpperCase(),
    );

    const txSlice = [...client.state.slices.values()].find((s) => s.tx);
    const filterHiHz = txSlice?.filterHi ?? (tr.filter_hi ? Number(tr.filter_hi) : null);

    const blockers: string[] = [];
    const warnings: string[] = [];

    if (inhibit) blockers.push("Transmit is inhibited on the radio");
    if (!txAllowed) blockers.push("The radio reports transmit is not allowed");
    if (tuning) blockers.push("The radio is in tune mode");
    if (interlockState === "TRANSMITTING") {
      blockers.push(
        "The radio is already transmitting — another program (WSJT-X?) is using it",
      );
    }
    if (!daxEnabled) blockers.push("DAX is not selected as the transmit source");

    // WHICH SLICE IS THE TRANSMIT SLICE, AND IS IT THE ONE WE ARE USING.
    //
    // Observed live 2026-08-30, with the station apparently working people and putting
    // 0.0 W on the air across every transmission:
    //
    //     slice 0 | 7.074000  | DIGU | tx 1 | dax 1 | active 0
    //     slice 1 | 14.074000 | CW   | tx 0 | dax 0 | active 1
    //
    // Transmit was bound to a 40 m slice while the operator worked 20 m on a second slice
    // that was in CW with no transmit and no DAX. Reported as "you keep adding a b slice"
    // and "theres no tx on b slice" — the operator could see it on the radio's own display
    // and nothing in this application ever looked.
    const allSlices = [...client.state.slices.values()];
    if (allSlices.length > 0 && !txSlice) {
      blockers.push(
        `No slice is set as the transmit slice (${allSlices.length} slice(s) in use) — ` +
          `keying would produce no RF`,
      );
    }
    // A tolerance rather than equality: the transmit slice sits at the dial and the
    // operator may have nudged it, but a whole band away is a different slice entirely.
    const OFF_FREQUENCY_HZ = 50_000;
    if (txSlice?.freqHz && this.opts.freqHz) {
      const offBy = Math.abs(txSlice.freqHz - this.opts.freqHz);
      if (offBy > OFF_FREQUENCY_HZ) {
        blockers.push(
          `The transmit slice is on ${(txSlice.freqHz / 1e6).toFixed(6)} MHz but this station is ` +
            `operating on ${(this.opts.freqHz / 1e6).toFixed(6)} MHz — transmissions would go out ` +
            `on the wrong frequency, or nowhere`,
        );
      }
    }
    if (allSlices.length > 1) {
      warnings.push(
        `${allSlices.length} slices are in use (` +
          allSlices
            .map(
              (sl) =>
                `${sl.index}: ${sl.freqHz ? (sl.freqHz / 1e6).toFixed(3) : "?"} ${sl.mode ?? "?"}` +
                `${sl.tx ? " TX" : ""}`,
            )
            .join(", ") +
          `) — DigiShack transmits on the one marked TX`,
      );
    }

    // DIGU/DIGL are the modes that pass audio flat. Transmitting FT8 through a
    // voice-processed mode would produce a poor signal rather than no signal, so
    // this warns instead of blocking.
    if (txSliceMode && !/^DIG[UL]$/i.test(txSliceMode)) {
      warnings.push(`TX slice mode is ${txSliceMode}, not DIGU/DIGL`);
    }
    if (rfPower !== null && rfPower > RF_POWER_WARN_PCT) {
      warnings.push(`RF power is ${rfPower}% — consider lowering it for a first test`);
    }
    if (otherClientOwnsTx) {
      warnings.push("Another client currently owns the transmitter");
    }

    return {
      freqMhz: tr.freq ?? null,
      rfPower,
      txSliceMode,
      filterHiHz,
      inhibit,
      daxEnabled,
      tuning,
      interlockState,
      txAllowed,
      otherClientOwnsTx,
      blockers,
      warnings,
    };
  }

  /**
   * Build the audio for a message without transmitting.
   *
   * Separate from `transmit` on purpose: it lets the whole generation path be
   * exercised, and asserted against the decoder, with no possibility of keying.
   */
  buildWaveform(message: string, mode: TxMode, offsetHz: number): Float32Array {
    // The generator itself is in lib/radio/waveform.ts, shared with the Icom
    // transmitter. It never used any state from this class; the only thing that
    // differs between radios is the sample rate.
    return buildWaveform(message, mode, offsetHz, DAX_RATE);
  }

  /**
   * Transmit one message, keying at `startAt`.
   *
   * Returns rather than throws for expected refusals, so a caller can surface the
   * reason without a try/catch around something that puts RF on the air.
   */
  async transmit(req: TransmitRequest): Promise<TransmitResult> {
    const base: TransmitResult = {
      sent: false,
      message: req.message,
      mode: req.mode,
      offsetHz: req.offsetHz,
    };

    // Re-read the gate, so turning it off in Settings takes effect on the very next
    // transmission rather than at the next restart. Falls back to the snapshot when
    // no provider was supplied.
    let allowed = this.opts.allowTransmit;
    if (this.opts.isTransmitAllowed) {
      try {
        allowed = await this.opts.isTransmitAllowed();
        this.opts.allowTransmit = allowed;
      } catch {
        // If the setting cannot be read, refuse. An unreadable master gate is not
        // an invitation to key the radio.
        allowed = false;
      }
    }
    if (!allowed) {
      return {
        ...base,
        reason:
          "Transmit is disabled. Enable flex.allowTransmit in Settings, and be sure the radio is connected to a suitable load.",
      };
    }
    if (!this.client || !this.socket || !this.streamId) {
      return { ...base, reason: "Transmitter is not started" };
    }
    // SUPERSEDE A TRANSMISSION THAT HAS NOT KEYED YET.
    //
    // `busy` is held across the pre-transmission wait so that two transmissions can never
    // be scheduled at once, and that much is right. But `startCall` schedules up to a
    // period ahead — the live log carries `first transmission in 27.9s` forty times in one
    // day — and for those whole 28 seconds every other request was refused with a message
    // saying a transmission was in progress when the radio was silent. Measured at 13% of
    // all refusals.
    //
    // A request for the SAME window or an EARLIER one is not a competitor, it is a
    // correction: the sequencer has decided something newer, and the queued transmission is
    // stale. So the pending wait is aborted and this request takes over.
    //
    // The moment `keyed` is true this does not apply at any price — there is RF on the air
    // and taking the transmitter would truncate a real transmission mid-symbol.
    // ANY un-keyed pending transmission is superseded, not just an earlier-or-equal one.
    //
    // The first version compared `req.startAt <= pendingKey.startAt`, on the reasoning that
    // a request for a LATER window is not urgent enough to displace a queued one. That is
    // the wrong model: the transmitter is not a queue, and the sequencer does not schedule
    // speculatively. If it has decided something new, the queued message is what it decided
    // BEFORE — a station that has since answered, or been abandoned, or been superseded by
    // one worth more. Sending the stale one and refusing the fresh one is exactly backwards.
    //
    // `keyed` still stops everything: there is RF on the air and taking the transmitter
    // would truncate a real transmission mid-symbol.
    if (this.busy && !this.keyed && this.pendingKey) {
      this.pendingKey.abort();
      this.pendingKey = null;
      this.busy = false;
      this.busySince = null;
      this.busyForWindow = null;
    }

    if (this.busy || this.keyed) {
      // WHICH flag, and for how long. The two mean different things: `keyed` is the radio
      // actually on the air, `busy` is this object holding the transmitter - including
      // across the pre-transmission wait below, which can legitimately be tens of seconds
      // and is the one case where "in progress" is not literally true.
      const held = this.busySince === null ? null : Math.round(nowMs() - this.busySince);
      const which = this.keyed && this.busy ? "keyed and busy" : this.keyed ? "keyed" : "busy";
      const forWin =
        this.busyForWindow === null ? "" : `, holding for window ${this.busyForWindow}`;
      return {
        ...base,
        reason:
          `A transmission is already in progress (${which}` +
          `${held === null ? "" : ` for ${held}ms`}${forWin})`,
      };
    }

    // Generate FIRST. If this throws we have not keyed, which is the whole point
    // of doing it before rather than during.
    let wave: Float32Array;
    try {
      wave = this.buildWaveform(req.message, req.mode, req.offsetHz);
    } catch (err) {
      return {
        ...base,
        reason: err instanceof Error ? err.message : "Could not encode the message",
      };
    }

    const durationMs = (wave.length / DAX_RATE) * 1000;

    // `startAt` is a period BOUNDARY. FT8 and FT4 do not start there — they start
    // 0.5 s in, and keying on the boundary put every transmission this station has
    // ever made 0.5 s early. FT2 does start on the boundary, so the offset is
    // per-mode and lives in lib/radio/timing.ts with the measurements behind it.
    const audioStartAt = transmitStartAt(req.mode, req.startAt);
    // Key EARLY by the one-way transit to the radio: `xmit 1` and the audio both have
    // to cross the network (a VPN, for this station) before any RF exists, so keying
    // at the due instant puts the signal on the air late by exactly that transit.
    // Zero when unmeasured or on a LAN — see lib/radio/link-latency.ts.
    const linkLagMs = this.opts.linkOneWayMs?.() ?? 0;
    // Corrected: this is the one subtraction where the offset must NOT cancel. The
    // instant to key is real time; the clock we wait against is ours.
    const waitMs = audioStartAt - linkLagMs - nowMs();

    // PER MODE, from the same function the scheduler uses. This was a hardcoded -1,500 for
    // every mode, and the transmitter is the LAST line of defence — so it was the one place
    // holding the wrong number. FT2 was measured to stop decoding entirely beyond about
    // 400 ms late, and this would have sent it 1.5 s late without comment.
    //
    // FT8 930, FT4 800, FT2 0. See lateTxToleranceMs in lib/radio/timing.ts for the
    // derivation and the measured DT cliffs behind it.
    const lateLimitMs = lateTxToleranceMs(req.mode);
    if (waitMs < -lateLimitMs) {
      // Late enough that the receiving stations' decode windows have moved on.
      return {
        ...base,
        reason:
          `Missed the window by ${Math.abs(Math.round(waitMs))}ms — ` +
          `${req.mode} tolerates ${lateLimitMs}ms, not transmitting late`,
      };
    }
    if (waitMs > 60_000) {
      return { ...base, reason: "Start time is more than a minute away" };
    }

    this.busy = true;
    this.busySince = nowMs();
    this.busyForWindow = Math.round(audioStartAt);
    const gen = ++this.txGen;

    try {
      // HELD ACROSS THE WAIT, DELIBERATELY - two transmissions must not be scheduled at
      // once - but that means `busy` is true for a transmission that has not started, for
      // as long as `waitMs`. With `startCall` scheduling up to a period ahead, the log
      // shows `first transmission in 27.9s` forty times in one day, and every tick in that
      // window is refused with a message claiming a transmission is in progress when none
      // is. Measured: only ~18% of refusals coincide with a far-ahead pending transmission,
      // so this is a real defect and NOT the main cause. The rest is still open; the
      // instrumentation above exists to find it rather than guess again.
      if (waitMs > 0) {
        // Abortable, so a newer request for this window or an earlier one can take over
        // rather than being refused for the length of the wait. Resolves either way; the
        // generation check below decides whether this call is still the owner.
        let superseded = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          this.pendingKey = {
            gen,
            startAt: req.startAt,
            abort: () => {
              superseded = true;
              clearTimeout(timer);
              resolve();
            },
          };
        });
        this.pendingKey = null;
        if (superseded || gen !== this.txGen) {
          // Someone newer owns the transmitter. Return without keying and WITHOUT touching
          // the shared flags — the `finally` below is generation-guarded for the same
          // reason. Clearing them here would unlock a transmitter that is now in use.
          return { ...base, reason: "Superseded by a newer transmission for the same window" };
        }
      }

      // Watchdog armed BEFORE keying, and deliberately not cleared by the send
      // loop's own success path alone — unkey() is idempotent, so a redundant
      // unkey is harmless while a missed one is not.
      this.armWatchdog(durationMs + WATCHDOG_MARGIN_MS);

      const keyedAt = nowMs();
      const keyResult = await this.client.command("xmit 1");
      if (keyResult.status !== 0) {
        this.clearWatchdog();
        this.busy = false;
        // Status -1 is the client's own code for "never reached the radio"
        // (socket closed, or the reply timed out) — not a refusal by the radio.
        // Distinguishing them matters: one is a dead TCP connection while DAX
        // audio keeps flowing over UDP, which looks like a healthy session.
        return {
          ...base,
          reason:
            keyResult.status === -1
              ? `Could not reach the radio to key it: ${keyResult.message}. The command connection is down (DAX audio can still be arriving — it is a separate UDP socket).`
              : `Radio refused to key (0x${keyResult.status.toString(16)})`,
        };
      }
      this.keyed = true;

      const packetsSent = await this.streamAudio(wave);

      await this.unkey();
      const unkeyedAt = Date.now();

      return {
        ...base,
        sent: true,
        keyedAt,
        unkeyedAt,
        // Against the instant audio was due, not the raw boundary — and in ON-AIR
        // terms: keying is deliberately linkLagMs early so the signal arrives on
        // time, and reporting the raw difference would show every compensated
        // transmission as "early" by exactly the compensation.
        timingErrorMs: keyedAt + linkLagMs - audioStartAt,
        packetsSent,
      };
    } catch (err) {
      // Any failure at all must leave the transmitter down.
      await this.unkey();
      return {
        ...base,
        reason: err instanceof Error ? err.message : "Transmission failed",
      };
    } finally {
      // ONLY IF THIS CALL STILL OWNS THE TRANSMITTER. A superseded request reaching here
      // would otherwise clear the flags belonging to the transmission that replaced it,
      // and the next request would key on top of a live one.
      if (gen === this.txGen) {
        this.busy = false;
        this.busySince = null;
        this.busyForWindow = null;
        this.pendingKey = null;
      }
    }
  }

  /**
   * Send the waveform as paced VITA-49 packets.
   *
   * Paced against a wall-clock deadline per packet rather than a fixed interval:
   * setInterval drift over 12.6 seconds would accumulate into an audible timing
   * error, and FT8 decoding depends on the transmission staying aligned to its
   * window.
   */
  private async streamAudio(wave: Float32Array): Promise<number> {
    const socket = this.socket;
    if (!socket) throw new Error("Socket closed");

    const totalPackets = Math.ceil(wave.length / FRAMES_PER_PACKET);
    const packetMs = (FRAMES_PER_PACKET / DAX_RATE) * 1000;
    const startedAt = Date.now();

    for (let i = 0; i < totalPackets; i++) {
      if (!this.keyed) break; // unkeyed underneath us — stop sending

      const offset = i * FRAMES_PER_PACKET;
      const frames = Math.min(FRAMES_PER_PACKET, wave.length - offset);

      // All-zero packets are skipped (their sequence slot still advances), the
      // same as nDAX. Official DAX behaves as a live source only while there is
      // signal; a stream of digital zeros is "no audio", not "silence".
      let silent = true;
      for (let s = offset; s < offset + frames; s++) {
        if ((wave[s] ?? 0) !== 0) {
          silent = false;
          break;
        }
      }

      if (!silent) {
        const packet = this.buildPacket(wave, offset, frames);
        await new Promise<void>((resolve, reject) => {
          socket.send(packet, RADIO_VITA_PORT, this.opts.host, (err) =>
            err ? reject(err) : resolve(),
          );
        });
      } else {
        this.packetCount++;
      }

      const dueAt = startedAt + (i + 1) * packetMs;
      const sleep = dueAt - Date.now();
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
    }

    return totalPackets;
  }

  /**
   * One TX audio packet, in the format nDAX uses for reduced-bandwidth DAX.
   *
   * This is NOT the format the radio sends on receive, and mirroring the receive
   * packets (type 3, stereo float32, class 0x03e3, the dummy timestamp pattern)
   * was a dead end that cost several transmissions: the radio silently discards
   * them. Transmit audio is:
   *
   *   - packet type 1 (IF data with stream id), first byte 0x18
   *   - TSI/TSF nibble 0xd with the 4-bit packet count: byte1 = 0xd0 | count
   *   - size, in words, of the whole packet (header is 7 words)
   *   - class 0x534c0123: MONO int16 big-endian at 24 kHz
   *     (float32 mono at 48 kHz under class 0x03e3 is the non-reduced variant)
   *   - all three timestamp words zero
   */
  private buildPacket(
    wave: Float32Array,
    offset: number,
    frames: number,
  ): Buffer {
    const payloadBytes = frames * 2; // mono, int16
    const buf = Buffer.alloc(VITA_HEADER_BYTES + payloadBytes);

    const count = this.packetCount & 0x0f;
    this.packetCount++;

    buf.writeUInt8(0x18, 0);
    buf.writeUInt8(0xd0 | count, 1);
    buf.writeUInt16BE(payloadBytes / 4 + 7, 2);
    buf.writeUInt32BE(this.streamIdNum >>> 0, 4);
    buf.writeUInt32BE(OUI, 8);
    buf.writeUInt16BE(INFO_CLASS, 12);
    buf.writeUInt16BE(PACKET_CLASS_TX_S16, 14);
    buf.writeUInt32BE(0, 16);
    buf.writeUInt32BE(0, 20);
    buf.writeUInt32BE(0, 24);

    let p = VITA_HEADER_BYTES;
    for (let i = 0; i < frames; i++) {
      const s = wave[offset + i] ?? 0;
      const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      buf.writeInt16BE(v, p);
      p += 2;
    }

    return buf;
  }

  private armWatchdog(ms: number): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (this.keyed) {
        console.error(
          `[tx] WATCHDOG: still keyed after ${ms}ms — forcing unkey`,
        );
      }
      void this.emergencyUnkey();
    }, ms);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Idempotent. Safe to call when not keyed. */
  async unkey(): Promise<void> {
    this.clearWatchdog();
    if (!this.client) {
      this.keyed = false;
      return;
    }
    // Sent unconditionally, not only when `keyed` is true: if our own state ever
    // disagrees with the radio, the safe direction is to insist on unkeyed.
    await this.client.command("xmit 0").catch(() => {});
    this.keyed = false;
  }

  /** Fire-and-forget unkey for exit handlers, where awaiting is not possible. */
  private emergencyUnkey(): void {
    this.clearWatchdog();
    this.keyed = false;
    void this.client?.command("xmit 0").catch(() => {});
  }
}

/** Next window boundary for a mode, in UTC ms. */
// Re-exported from lib/radio/timing.ts, which both radios share. Kept exported here
// so existing importers do not have to move.
export { nextWindowStart, transmitStartAt, TX_START_OFFSET_MS } from "@/lib/radio/timing";

/** Expected on-air duration, for display and for watchdog sizing. */
export function transmitDurationMs(mode: TxMode): number {
  // Derived from the shared symbol rates rather than a local table, so this cannot
  // drift away from what the generator actually produces.
  return (SYMBOLS_PER_FRAME[mode] * samplesPerSymbol(mode, DAX_RATE) * 1000) / DAX_RATE;
}

/** T/R period for a mode, ms. */
export function periodMs(mode: TxMode): number {
  return PERIOD_MS[mode];
}

// Playing the receiver in a browser.
//
// The hard part is not decoding — it is 16-bit PCM and Web Audio takes it directly. The hard
// part is TIME, and the first version got it wrong in an audible way.
//
// It scheduled every arriving packet as its own AudioBufferSourceNode. A FlexRadio's DAX
// stream delivers 128 samples at a time, so that is 188 separately-timed buffers a second,
// each one a seam where the next sample can land a fraction late. The result was a periodic
// roughness at exactly the packet rate. The operator's description was "it doesn't sound like
// that on any other radio", which is precisely right: no radio has a 188 Hz seam in it.
//
// Now there is one ring buffer feeding one continuous node on the audio thread. See
// public/pcm-player.worklet.js.

/** Where the worklet lives. Served from /public, so no bundler involvement. */
const WORKLET_URL = "/pcm-player.worklet.js";

export interface AudioPlayerState {
  playing: boolean;
  sampleRate: number;
  /** Packets handed to the player, for a display that proves audio is arriving. */
  packets: number;
  /** How much audio is buffered, reported by the worklet itself. */
  bufferedMs: number;
  /** Times the ring ran dry — the honest network-quality reading. Events, not samples. */
  underruns: number;
  /** The silence those dropouts added up to, ms. Not counted for the first pre-roll. */
  starvedMs: number;
  /** True while the worklet is holding back for its pre-roll and playing silence. */
  waiting: boolean;
  /** What the AudioContext says about itself: running, suspended or closed. */
  contextState: string;
}

/**
 * Thrown by `start()` when `stop()` was called before it finished. The stop won: everything
 * the start had built is already released, and there is nothing to report to the operator.
 */
export class AudioStartCancelled extends Error {
  constructor() {
    super("Audio start was cancelled by stop()");
    this.name = "AudioStartCancelled";
  }
}

/** Contexts already being closed, so a second release of one never calls close() again. */
const closing = new WeakSet<AudioContext>();

/**
 * Close a context and swallow the outcome. A context that fails to close is not news worth
 * replacing a real failure with, and a closed one cannot be closed twice.
 */
async function closeQuietly(ctx: AudioContext): Promise<void> {
  if (closing.has(ctx) || ctx.state === "closed") return;
  closing.add(ctx);
  try {
    await ctx.close();
  } catch {
    /* already closed, or the browser refused; either way it is not ours any more */
  }
}

/**
 * Convert 16-bit little-endian PCM to the float samples Web Audio wants.
 *
 * Divided by 32768 rather than 32767: the range is -32768..32767, so dividing by the positive
 * maximum makes the most negative sample slightly exceed -1.0. Inaudible on one sample and
 * wrong in principle, which is the sort of thing that gets copied into a transmit path where
 * it is neither.
 */
export function s16leToFloat(pcm: ArrayBuffer): Float32Array {
  const view = new DataView(pcm);
  const count = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * Linear resampling from the radio's rate to the output's.
 *
 * The two radios differ — 48 kHz on the Icom's network stream, 24 kHz off FlexRadio DAX — and
 * the browser's hardware runs at whatever it runs at, usually 48 kHz. An AudioBuffer used to
 * do this conversion for free; a ring buffer cannot, because it hands raw frames to the
 * hardware clock.
 *
 * Linear interpolation is enough here, and it is worth saying why rather than reaching for
 * something better. The material is a 3 kHz voice passband sampled at 24 kHz — eight times the
 * highest frequency present — so the error it makes sits far above anything audible in it.
 */
export class StreamingResampler {
  private previous: number | null = null;
  private position = 0;

  constructor(private readonly from: number, private readonly to: number) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0)
      throw new Error("Audio sample rates must be positive finite numbers");
  }

  push(input: Float32Array): Float32Array {
    if (this.from === this.to || input.length === 0) return input;
    const prefix = this.previous === null ? 0 : 1;
    const length = input.length + prefix;
    const at = (i: number): number => i < prefix ? this.previous! : input[i - prefix]!;
    const ratio = this.from / this.to;
    // Keep the last sample until its neighbour arrives. Repeating it at each packet
    // boundary makes a seam even at an exact 24 -> 48 kHz ratio. Fractional phase must
    // also survive packets, otherwise 44.1 kHz output loses 37.5 samples every second.
    const count = Math.max(0, Math.ceil((length - 1 - this.position) / ratio));
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const pos = this.position + i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = at(idx);
      out[i] = a + (at(Math.min(idx + 1, length - 1)) - a) * frac;
    }
    this.position += count * ratio - (length - 1);
    this.previous = input[input.length - 1]!;
    return out;
  }
}

/**
 * A live audio sink fed packet by packet.
 *
 * Deliberately not a React hook: the buffer must survive re-renders untouched, and this page
 * re-renders every two seconds from a status poll.
 */
export class ReceiverAudio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private node: AudioWorkletNode | null = null;
  private packets = 0;
  private bufferedMs = 0;
  private underruns = 0;
  private starvedMs = 0;
  private waiting = true;
  private resampler: StreamingResampler | null = null;

  /** The start in progress, so a second call joins it instead of building a second context. */
  private starting: Promise<void> | null = null;
  /** The context that start is building, so stop() can close it before it is ever published. */
  private pendingCtx: AudioContext | null = null;
  /** Bumped by stop(). A start that finds it changed has been overruled and backs out. */
  private generation = 0;

  /**
   * The radio's sample rate, which arrives AFTER the context has to be created.
   *
   * Taking it as a constructor argument forced the context to be built inside the WebSocket's
   * first message handler — a network round trip after the click — and every browser blocks
   * audio started outside a user gesture. The failure is silent: packets are accepted, the
   * counter climbs, and nothing reaches the speakers.
   */
  private sampleRate = 0;

  /**
   * The stream's format, from the bridge's hello — and again whenever the bridge sends a new
   * one mid-stream, which it does when it switches radios (Flex 24 kHz, Icom 48 kHz).
   *
   * A hello is a fresh start of the stream either way: the resampler is rebuilt, so the old
   * radio's last sample is not interpolated into the new radio's first and the ratio is the
   * new one, and whatever the worklet still has queued from the old source is dropped so the
   * new one starts on a clean pre-roll. Nothing is lost by the drop that was worth hearing:
   * it is a fraction of a second of the radio that was just switched away from.
   */
  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.resampler = null;
    this.node?.port.postMessage({ type: "flush" });
  }

  /**
   * Start the audio context and load the worklet.
   *
   * Must be called from a user gesture, and the context is created SYNCHRONOUSLY inside this
   * call, before its first await: Safari only honours a gesture within the same call stack.
   * Awaiting `addModule` afterwards is fine — the context already exists.
   *
   * Never leaves anything behind. A failure at any step (resume refused, worklet unreachable,
   * node construction) closes the context it created and rethrows the ORIGINAL error, which is
   * what the page shows. A stop() during startup wins: the context is closed at once, and this
   * rejects with `AudioStartCancelled` instead of publishing anything. Calls made while a start
   * is already in flight join it.
   */
  start(volume = 0.8): Promise<void> {
    if (this.ctx) return Promise.resolve();
    if (this.starting) return this.starting;
    const attempt = this.build(this.generation, volume).finally(() => {
      if (this.starting === attempt) this.starting = null;
    });
    this.starting = attempt;
    return attempt;
  }

  private async build(generation: number, volume: number): Promise<void> {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.pendingCtx = ctx;
    let node: AudioWorkletNode | null = null;
    let gain: GainNode | null = null;
    const overruled = () => this.generation !== generation;

    try {
      if (ctx.state === "suspended") await ctx.resume();
      if (overruled()) throw new AudioStartCancelled();

      // Absent, not failing, on a page that is not a secure context: AudioWorklet is
      // https-or-localhost only. Said as such, because "cannot read properties of undefined"
      // sends the operator looking at the radio.
      if (!ctx.audioWorklet) {
        throw new Error(
          window.isSecureContext === false
            ? "audio worklets need a secure page; open DigiShack over https (or on localhost)"
            : "this browser has no AudioWorklet",
        );
      }
      await ctx.audioWorklet.addModule(WORKLET_URL);
      if (overruled()) throw new AudioStartCancelled();

      node = new AudioWorkletNode(ctx, "pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event: MessageEvent) => {
        const m = event.data as {
          bufferedMs?: number;
          underruns?: number;
          starvedMs?: number;
          waiting?: boolean;
        };
        if (typeof m.bufferedMs === "number") this.bufferedMs = m.bufferedMs;
        if (typeof m.underruns === "number") this.underruns = m.underruns;
        if (typeof m.starvedMs === "number") this.starvedMs = m.starvedMs;
        if (typeof m.waiting === "boolean") this.waiting = m.waiting;
      };

      gain = ctx.createGain();
      gain.gain.value = volume;
      node.connect(gain);
      gain.connect(ctx.destination);
    } catch (err) {
      // Everything this attempt made goes, whichever step failed. A failed start used to
      // keep its AudioContext open with nothing able to close it, and browsers cap how many
      // a page may hold.
      for (const made of [node, gain]) {
        try {
          made?.disconnect();
        } catch {
          /* never connected */
        }
      }
      if (this.pendingCtx === ctx) this.pendingCtx = null;
      await closeQuietly(ctx);
      throw err;
    }

    this.pendingCtx = null;
    this.ctx = ctx;
    this.gain = gain;
    this.node = node;
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, volume));
  }

  /** Queue one packet of PCM. Convert, resample, hand it to the audio thread. */
  push(pcm: ArrayBuffer): void {
    const ctx = this.ctx;
    const node = this.node;
    if (!ctx || !node || this.sampleRate <= 0) return;

    this.resampler ??= new StreamingResampler(this.sampleRate, ctx.sampleRate);
    const samples = this.resampler.push(s16leToFloat(pcm));
    if (samples.length === 0) return;
    // Transferred rather than copied: this runs 188 times a second on the FlexRadio.
    node.port.postMessage(samples, [samples.buffer]);
    this.packets++;
  }

  get state(): AudioPlayerState {
    return {
      playing: this.ctx !== null,
      sampleRate: this.sampleRate,
      packets: this.packets,
      bufferedMs: this.bufferedMs,
      underruns: this.underruns,
      starvedMs: this.starvedMs,
      waiting: this.waiting,
      // "running" is the only value that makes sound: a suspended context accepts everything
      // and plays none of it, which is exactly what "I still don't hear any audio" looks like.
      contextState: this.ctx?.state ?? "closed",
    };
  }

  /**
   * Stop and release the device. Idempotent — called from cleanup and from a button.
   *
   * Also overrules a start still in flight, and closes the context it is building NOW rather
   * than whenever that start next looks: a worklet load that never settles would otherwise
   * hold the device open for as long as the tab lives.
   */
  async stop(): Promise<void> {
    this.generation++;
    // Forgotten as well as overruled, so a start() after this builds afresh instead of
    // joining the attempt that is about to reject as cancelled.
    this.starting = null;
    const ctx = this.ctx;
    const pending = this.pendingCtx;
    for (const made of [this.node, this.gain]) {
      try {
        made?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.ctx = null;
    this.gain = null;
    this.node = null;
    this.pendingCtx = null;
    this.resampler = null;
    await Promise.all([ctx ? closeQuietly(ctx) : null, pending ? closeQuietly(pending) : null]);
  }
}

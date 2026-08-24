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
  /** Times the ring ran dry — the honest network-quality reading. */
  underruns: number;
  /** What the AudioContext says about itself: running, suspended or closed. */
  contextState: string;
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
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const count = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
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

  /**
   * The radio's sample rate, which arrives AFTER the context has to be created.
   *
   * Taking it as a constructor argument forced the context to be built inside the WebSocket's
   * first message handler — a network round trip after the click — and every browser blocks
   * audio started outside a user gesture. The failure is silent: packets are accepted, the
   * counter climbs, and nothing reaches the speakers.
   */
  private sampleRate = 0;

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
  }

  /**
   * Start the audio context and load the worklet.
   *
   * Must be called from a user gesture. Awaiting `addModule` inside it is fine — the gesture's
   * permission survives an await in the same chain, unlike a context first created in a
   * network callback.
   */
  async start(volume = 0.8): Promise<void> {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    if (ctx.state === "suspended") await ctx.resume();

    await ctx.audioWorklet.addModule(WORKLET_URL);

    const node = new AudioWorkletNode(ctx, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (event: MessageEvent) => {
      const m = event.data as { bufferedMs?: number; underruns?: number };
      if (typeof m.bufferedMs === "number") this.bufferedMs = m.bufferedMs;
      if (typeof m.underruns === "number") this.underruns = m.underruns;
    };

    const gain = ctx.createGain();
    gain.gain.value = volume;
    node.connect(gain);
    gain.connect(ctx.destination);

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

    const samples = resampleLinear(s16leToFloat(pcm), this.sampleRate, ctx.sampleRate);
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
      // "running" is the only value that makes sound: a suspended context accepts everything
      // and plays none of it, which is exactly what "I still don't hear any audio" looks like.
      contextState: this.ctx?.state ?? "closed",
    };
  }

  /** Stop and release the device. Idempotent — called from cleanup and from a button. */
  async stop(): Promise<void> {
    const ctx = this.ctx;
    this.node?.disconnect();
    this.gain?.disconnect();
    this.ctx = null;
    this.gain = null;
    this.node = null;
    if (ctx) await ctx.close().catch(() => {});
  }
}

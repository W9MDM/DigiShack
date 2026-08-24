// Continuous playback of receiver audio, on the audio thread.
//
// The first version scheduled every arriving packet as its own AudioBufferSourceNode. At
// 188 packets a second — which is what a FlexRadio's DAX stream delivers, 128 samples at a
// time — that is 188 separately-timed buffers a second, each one a seam where the next
// sample can land a fraction late. The result is a periodic roughness at the packet rate:
// audible, unmistakably digital, and nothing like a radio.
//
// One ring buffer and one continuous output node has no seams at all. A late packet becomes
// a moment of quiet instead of a click, and the audio thread keeps pulling at exactly the
// hardware's rate whatever the page is doing.
//
// On the audio thread deliberately. This page draws a waterfall twenty times a second in
// voice mode, and a ScriptProcessorNode — the main-thread alternative — would be competing
// with that for the same frames.

/** Ring capacity. Four seconds is far more than the target fill; it is headroom, not latency. */
const CAPACITY = 48000 * 4;

/**
 * How much audio to hold before playing, and the ceiling before catching up.
 *
 * Below the target the buffer is refilling and output is silence rather than a stutter.
 * Above the ceiling the listener is hearing a conversation late, which cannot be recovered by
 * waiting — the only way back is to drop what has piled up.
 */
const TARGET_SECONDS = 0.15;
const MAX_SECONDS = 0.6;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.filled = 0;
    this.started = false;
    this.underruns = 0;
    this.dropped = 0;

    this.port.onmessage = (event) => {
      const chunk = event.data;
      if (!(chunk instanceof Float32Array)) return;

      // Overflow means the network delivered faster than the hardware consumed, which happens
      // after a stall clears. Drop the OLDEST audio: the newest is the part still worth
      // hearing, and keeping the old would play a conversation permanently behind itself.
      if (this.filled + chunk.length > CAPACITY) {
        const excess = this.filled + chunk.length - CAPACITY;
        this.read = (this.read + excess) % CAPACITY;
        this.filled -= excess;
        this.dropped += excess;
      }

      for (let i = 0; i < chunk.length; i++) {
        this.buf[this.write] = chunk[i];
        this.write = (this.write + 1) % CAPACITY;
      }
      this.filled += chunk.length;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    const target = TARGET_SECONDS * sampleRate;
    const max = MAX_SECONDS * sampleRate;

    // Wait for the target before the first sample, so a slow start does not stutter its way
    // in. After that, play whatever there is.
    if (!this.started) {
      if (this.filled < target) {
        out.fill(0);
        return true;
      }
      this.started = true;
    }

    // Too far behind: skip forward rather than play late for ever. Done here rather than by
    // resampling because a jump of a few tens of milliseconds is one soft click, and pitching
    // the audio to catch up is audible for as long as it lasts.
    if (this.filled > max) {
      const skip = Math.floor(this.filled - target);
      this.read = (this.read + skip) % CAPACITY;
      this.filled -= skip;
      this.dropped += skip;
    }

    for (let i = 0; i < out.length; i++) {
      if (this.filled === 0) {
        out[i] = 0;
        this.underruns++;
        // Re-arm the pre-roll: having run dry once, playing the next single packet
        // immediately would run dry again on the next frame.
        this.started = false;
        continue;
      }
      out[i] = this.buf[this.read];
      this.read = (this.read + 1) % CAPACITY;
      this.filled--;
    }

    // Cheap enough for the audio thread and the only window into whether this is working:
    // "no sound" and "sound arriving late" and "buffer starving" look identical otherwise.
    if (currentFrame % (sampleRate | 0) < out.length) {
      this.port.postMessage({
        bufferedMs: Math.round((this.filled / sampleRate) * 1000),
        underruns: this.underruns,
        dropped: this.dropped,
      });
    }

    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);

// Streaming the station to YouTube Live over RTMP.
//
// WHAT MAKES THIS WORTH WATCHING is not the picture — it is that the audio is the actual
// band. The bridge already has receiver audio flowing through it for the decoder, so the
// stream carries what the operator is hearing, under a waterfall that scrolls in real time.
// A silent screen recording would be neither interesting nor, as far as YouTube is
// concerned, a healthy stream.
//
// SHAPE. One ffmpeg child process with two inputs:
//
//   video   raw RGB frames on a fifo, drawn by lib/stream/frame.ts
//   audio   raw 16-bit PCM on a second fifo, tapped from DAX
//
// Two fifos rather than stdin, because a process has one stdin and this needs two streams.
// ffmpeg reads both, overlays the text file, encodes H.264 + AAC and pushes RTMP.
//
// NOTHING HERE RUNS ON THE BRIDGE'S EVENT LOOP except writing bytes to a pipe. After an
// evening spent proving that a 2.5 s decode must not share a thread with transmit timing,
// an encoder certainly must not: ffmpeg is a child process, it is watched, and if it dies
// the radio does not notice.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, writeFileSync, type WriteStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** YouTube's ingest endpoint. The key is appended; it is a credential, not a URL. */
export const YOUTUBE_RTMP = "rtmp://a.rtmp.youtube.com/live2";

export interface StreamOptions {
  /** YouTube stream key. NEVER logged — see `redact`. */
  streamKey: string;
  width?: number;
  height?: number;
  fps?: number;
  videoBitrateKbps?: number;
  /** Sample rate of the PCM being written. DAX is 24 kHz mono. */
  audioRate?: number;
  /** Where fifos and the overlay file live. */
  workDir?: string;
  /**
   * Where to send it. Defaults to YouTube.
   *
   * Overridable so `scripts/verify-stream.ts` can point the REAL code path at a local file
   * and inspect what came out. Everything except the RTMP handshake itself — the fifo
   * ordering, the overlay reload, the muxing, the audio/video sync — is then measured
   * rather than reasoned about, and the only part left unverified is the part that
   * genuinely needs a stream key.
   */
  destination?: string;
  /** Container. `flv` for RTMP; the verifier writes `mp4`. */
  format?: string;
  onLog?: (line: string) => void;
}

export interface StreamStatus {
  running: boolean;
  since: number | null;
  /** Frames handed to the encoder. */
  frames: number;
  /** Audio samples handed to the encoder. */
  samples: number;
  /** Frames ffmpeg says it has actually ENCODED, from its own progress output. */
  encoded: number;
  /** The last thing ffmpeg printed, with the stream key removed. */
  lastFfmpegLine: string | null;
  restarts: number;
  lastError: string | null;
}

/**
 * A stream key in a log line is a stream key in a bug report.
 *
 * Anyone holding it can broadcast to the operator's channel as the operator. It is a
 * `secret` setting, it never reaches the browser, and it does not reach the log either —
 * ffmpeg's own command line is rewritten before anything prints it.
 */
export function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("<stream key>");
}

export class YouTubeStream {
  private ff: ChildProcess | null = null;
  private video: WriteStream | null = null;
  private audio: WriteStream | null = null;
  private readonly dir: string;
  private readonly opts: Required<Omit<StreamOptions, "onLog">> & { onLog?: (l: string) => void };
  private stat: StreamStatus = {
    running: false,
    since: null,
    frames: 0,
    samples: 0,
    encoded: 0,
    lastFfmpegLine: null,
    restarts: 0,
    lastError: null,
  };

  constructor(options: StreamOptions) {
    this.opts = {
      streamKey: options.streamKey,
      width: options.width ?? 1280,
      height: options.height ?? 720,
      fps: options.fps ?? 10,
      videoBitrateKbps: options.videoBitrateKbps ?? 2500,
      audioRate: options.audioRate ?? 24_000,
      workDir: options.workDir ?? join(tmpdir(), "digishack-stream"),
      destination: options.destination ?? "",
      format: options.format ?? "flv",
      onLog: options.onLog,
    };
    this.dir = this.opts.workDir;
  }

  get status(): StreamStatus {
    return { ...this.stat };
  }

  private log(line: string): void {
    this.opts.onLog?.(redact(line, this.opts.streamKey));
  }

  /**
   * The overlay text ffmpeg re-reads every frame.
   *
   * Written to a temporary name and RENAMED into place, because `rename` is atomic on the
   * same filesystem and a half-written file read mid-frame shows the viewer a torn line.
   */
  setOverlay(text: string): void {
    try {
      const tmp = join(this.dir, "overlay.next");
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, join(this.dir, "overlay.txt"));
    } catch {
      /* an overlay that fails to write is a cosmetic fault, never a reason to drop a stream */
    }
  }

  async start(): Promise<void> {
    if (this.ff) return;
    if (!this.opts.streamKey && !this.opts.destination) {
      throw new Error("No YouTube stream key is set");
    }

    mkdirSync(this.dir, { recursive: true });
    const videoPipe = join(this.dir, "video.pipe");
    const audioPipe = join(this.dir, "audio.pipe");
    // Recreated every start: a fifo left behind by a killed process is still a fifo, but
    // one with a reader that no longer exists blocks the first write for ever.
    for (const p of [videoPipe, audioPipe]) {
      try {
        execFileSync("rm", ["-f", p]);
        execFileSync("mkfifo", [p]);
      } catch (err) {
        throw new Error(`Could not create the stream pipes: ${(err as Error).message}`);
      }
    }
    this.setOverlay("");

    const { width, height, fps, videoBitrateKbps, audioRate } = this.opts;
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
    const overlay = join(this.dir, "overlay.txt");

    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      // ffmpeg's own machine-readable heartbeat, on stdout. Read for two things: the
      // startup gate above, and the encoder's real frame count afterwards.
      "-progress", "pipe:1",
      "-nostats",
      // NO PROBING ON EITHER INPUT, and this one is load-bearing.
      //
      // ffmpeg probes an input for `analyzeduration` before it will start, and the default
      // is FIVE SECONDS. On a live fifo that means it sits waiting for five seconds of
      // audio that only arrives once it is running — a deadlock that presented as "ffmpeg
      // did not start encoding", with the video input opened and the audio input never
      // reached. There is nothing to probe: `-f`, `-ar`, `-ac`, `-s` and `-pix_fmt` state
      // the format exactly, so probing can only confirm what it was already told.
      "-analyzeduration", "0", "-probesize", "32",
      // `thread_queue_size` raised from the default of 8 on ffmpeg's own advice — it warns
      // about it by name.
      "-thread_queue_size", "512",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps),
      "-i", videoPipe,
      // AUDIO: the receiver, as 16-bit mono PCM at DAX's own rate. Resampled by ffmpeg
      // rather than by us — it is better at it and it costs us nothing.
      "-analyzeduration", "0", "-probesize", "32",
      "-thread_queue_size", "512",
      "-f", "s16le", "-ar", String(audioRate), "-ac", "1",
      "-i", audioPipe,
      // `reload=1` re-reads the file every frame, which is how the decode list updates
      // without restarting ffmpeg or rebuilding the filter graph.
      "-vf",
      `drawtext=fontfile=${font}:textfile=${overlay}:reload=1:fontcolor=white:fontsize=17:` +
        `line_spacing=4:x=18:y=14:box=1:boxcolor=black@0.45:boxborderw=10`,
      // CONSTANT FRAME RATE at the output, so a dropped frame holds the previous picture
      // rather than shortening the video. Without it the stream runs slowly behind real
      // time and the gap grows all day — which on a twelve-second test looks like a
      // rounding error and on a four-hour stream is minutes of drift.
      "-fps_mode", "cfr",
      "-c:v", "libx264",
      // `veryfast` and not slower: this shares a machine with an FT8 decoder, and a
      // prettier picture is not worth a late transmission.
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-b:v", `${videoBitrateKbps}k`,
      "-maxrate", `${videoBitrateKbps}k`,
      "-bufsize", `${videoBitrateKbps * 2}k`,
      // YouTube wants a keyframe every 2 s or it re-buffers viewers.
      "-g", String(fps * 2),
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
      "-f", this.opts.format,
      this.opts.destination || `${YOUTUBE_RTMP}/${this.opts.streamKey}`,
    ];

    this.log(
      `[stream] starting ffmpeg -> ${this.opts.destination || `${YOUTUBE_RTMP}/<stream key>`}`,
    );
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.ff = ff;

    ff.stderr?.on("data", (d: Buffer) => {
      const line = redact(d.toString().trim(), this.opts.streamKey);
      if (!line) return;
      // KEPT, so a startup failure can say what ffmpeg said. "ffmpeg exited (1)" sends an
      // operator to a log file; "Server returned 403" sends them to their stream key.
      const parts = line.split("\n");
      this.stat.lastFfmpegLine = parts[parts.length - 1] ?? null;
      this.log(`[stream] ${parts.slice(-2).join(" | ")}`);
    });

    // The progress stream, once the startup gate has had its first block. Kept DRAINED: an
    // unread pipe fills at 64 KB and then blocks its writer, which here is the encoder.
    ff.stdout?.on("data", (d: Buffer) => {
      const m = /frame=(\d+)/.exec(d.toString());
      if (m) this.stat.encoded = Number(m[1]);
    });
    ff.on("error", (err) => {
      this.stat.lastError = err.message;
      this.log(`[stream] ffmpeg failed to start: ${err.message}`);
      this.teardown();
    });
    ff.on("close", (code) => {
      if (this.ff !== ff) return;
      this.stat.lastError = code === 0 ? null : `ffmpeg exited with code ${code}`;
      this.log(`[stream] ffmpeg exited (${code})`);
      this.teardown();
    });

    // OPENED READ-WRITE, which is the whole reason this works.
    //
    // Opening a fifo write-only BLOCKS until a reader appears, and if none ever does —
    // ffmpeg failed to start, or died during its RTMP handshake — the open never returns.
    // That is not a hypothetical: waiting on it wedged a verification run indefinitely, and
    // in the bridge it would have been worse, because a blocked open holds a libuv
    // threadpool thread and four failed attempts would stall every file operation in the
    // process.
    //
    // O_RDWR on a fifo never blocks: the descriptor is its own reader. It also means writes
    // never raise EPIPE when ffmpeg goes away, which is why `stop()` kills the process
    // rather than relying on it seeing end-of-file.
    this.video = createWriteStream(videoPipe, { flags: "r+" });
    this.audio = createWriteStream(audioPipe, { flags: "r+" });
    for (const s of [this.video, this.audio]) {
      // EPIPE when ffmpeg goes away is expected, not exceptional.
      s.on("error", () => {});
    }

    // WAIT FOR ffmpeg TO SAY IT IS ENCODING before reporting success or feeding it.
    //
    // Two faults at once. Frames written before ffmpeg reads go into Node's queue and are
    // dropped by the backpressure guard — measured at 7 of 120, deterministically, in the
    // first 0.7 s of every run, which is how long ffmpeg takes to start. Nobody is watching
    // in the first second so the frames did not matter, but `stat.frames` is a health
    // number and one that always reports a loss teaches the operator to ignore it.
    //
    // The other is worse: a rejected stream key kills ffmpeg about a second after it
    // connects, and without this `start()` would return "streaming" to a button that is
    // already wrong. `-progress` is ffmpeg's own machine-readable heartbeat and is the only
    // honest signal that it is actually processing.
    // PRIMED BEFORE WAITING, because ffmpeg cannot report progress on input it has not
    // been given and the caller does not start feeding until start() returns — which
    // without this is a deadlock, and was: the gate timed out at 20 s every run.
    //
    // Half a second of black and silence. It also means YouTube receives a valid picture
    // the instant the connection is up, rather than one arbitrary waterfall row.
    const blank = Buffer.alloc(width * height * 3);
    const silence = new Float32Array(Math.round(audioRate / 2));
    for (let i = 0; i < Math.max(2, Math.round(fps / 2)); i++) this.video.write(blank);
    this.audio.write(Buffer.alloc(silence.length * 2));

    try {
      await this.waitEncoding(ff);
    } catch (err) {
      this.stat.lastError = (err as Error).message;
      this.teardown();
      try {
        ff.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      throw err;
    }

    this.stat.running = true;
    this.stat.since = Date.now();
    this.stat.frames = 0;
    this.stat.samples = 0;
    this.stat.encoded = 0;
  }

  /**
   * Hand one frame to the encoder.
   *
   * DROPPED WHEN THE PIPE IS FULL rather than queued. A waterfall row is worthless late and
   * the next one is along in 100 ms; buffering them would grow the bridge's memory to keep
   * pictures nobody will ever see — which is exactly the fault fixed in the decode
   * broadcast path, and it would be careless to reintroduce it here.
   */
  writeFrame(rgb: Buffer): void {
    const v = this.video;
    if (!v || v.destroyed) return;
    if (v.writableLength > rgb.length * 3) return;
    // COPIED ONLY WHEN SOMETHING IS ALREADY QUEUED. The canvas reuses one buffer, and a
    // stream queues the reference rather than the bytes — so two queued writes would both
    // encode whatever the buffer holds by the time they drain, which is the newest picture
    // twice. Copying every frame unconditionally would be 27 MB a second of garbage next to
    // a decoder, and the queue is empty on the common path anyway.
    v.write(v.writableLength > 0 ? Buffer.from(rgb) : rgb);
    this.stat.frames++;
  }

  /** Hand receiver audio to the encoder, converting float to 16-bit PCM. */
  writeAudio(samples: Float32Array): void {
    const a = this.audio;
    if (!a || a.destroyed) return;
    // Audio is NOT droppable the way video is: a gap is audible, and the encoder needs a
    // continuous stream to keep sync. The cap is high enough never to be reached by a
    // healthy pipe and low enough to bound the damage if ffmpeg wedges.
    if (a.writableLength > 4 * 1024 * 1024) return;
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]!));
      pcm.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    a.write(pcm);
    this.stat.samples += samples.length;
  }

  /**
   * Resolve once ffmpeg reports its first progress block, or explain why it never will.
   *
   * Raced against ffmpeg's own exit and a timeout, so every way this can fail produces a
   * sentence rather than a hang. The 20 s allowance is for the RTMP handshake: YouTube's
   * ingest is not always quick, and giving up at 5 s would fail on a slow link for no
   * reason.
   */
  private waitEncoding(ff: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        ff.stdout?.off("data", onData);
        ff.off("close", onClose);
        fn();
      };
      const onData = (d: Buffer) => {
        if (d.toString().includes("progress=")) finish(resolve);
      };
      const onClose = (code: number | null) =>
        finish(() =>
          reject(
            new Error(
              `ffmpeg exited immediately (code ${code}). ` +
                (this.stat.lastFfmpegLine ?? "Check the stream key."),
            ),
          ),
        );
      const timer = setTimeout(
        () => finish(() => reject(new Error("ffmpeg did not start encoding within 20 seconds"))),
        20_000,
      );
      ff.stdout?.on("data", onData);
      ff.once("close", onClose);
    });
  }

  private teardown(): void {
    this.stat.running = false;
    this.stat.since = null;
    try {
      this.video?.destroy();
      this.audio?.destroy();
    } catch {
      /* going away anyway */
    }
    this.video = null;
    this.audio = null;
    this.ff = null;
  }

  async stop(): Promise<void> {
    const ff = this.ff;
    this.teardown();
    if (!ff) return;
    this.log("[stream] stopping");
    ff.kill("SIGTERM");
    // SIGKILL after a grace period: ffmpeg flushing to a dead RTMP socket can hang, and a
    // stream that will not stop is worse than one that stops abruptly.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          ff.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 3_000);
      ff.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

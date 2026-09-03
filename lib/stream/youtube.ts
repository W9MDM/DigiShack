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
// A `export ... from` re-export creates no local binding, so the filter graph below needs
// a real import as well as the re-export further down.
import {
  FRAME_W,
  FRAME_H,
  FONT_SIZE,
  LINE_SPACING,
  LEFT_X,
  LEFT_Y,
  SIDE_X,
  SIDE_Y,
  TICKER_FONT,
  TICKER_TEXT_Y,
  TICKER_X,
  TICKER_W,
  BOX_BORDER,
} from "@/lib/stream/layout";

/** YouTube's ingest endpoint. The key is appended; it is a credential, not a URL. */
export const YOUTUBE_RTMP = "rtmp://a.rtmp.youtube.com/live2";

// THE LAYOUT LIVES IN `lib/stream/layout.ts` and is re-exported here so existing importers
// keep working. It was moved because none of it could be asserted while half sat in this
// file — which imports `child_process` — and half sat in `const`s inside a function body in
// `services/radio/index.ts`. Every geometry fault so far was found by the operator looking
// at his own stream rather than by a check.
export { LINE_H, TICKER_H, TICKER_Y } from "@/lib/stream/layout";

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
  /**
   * The bitrate ffmpeg reports actually going out, in kbps.
   *
   * The number to compare against the DECLARED rate. YouTube buffers when the two disagree,
   * and until this existed nothing here could tell them apart.
   */
  bitrateKbps: number | null;
  /** Bytes pushed so far, from the same progress block. */
  totalBytes: number | null;
  /** The last thing ffmpeg printed, with the stream key removed. */
  lastFfmpegLine: string | null;
  restarts: number;
  lastError: string | null;
  /**
   * Why the picture is frozen, or null when it is live.
   *
   * PAUSED IS NOT STOPPED, and the difference is the whole point. Stopping drops the RTMP
   * connection, and a dropped connection ENDS the broadcast — permanently, because a
   * completed broadcast cannot be reused. Measured on the operator's own channel:
   *
   *     0ssC_QvaTk8 | complete   <- was live; the bridge restarted and it died
   *     HQdV-N_UFIQ | live       <- the replacement YouTube minted afterwards
   *
   * A new broadcast is a new URL, so anybody watching is dropped and the day's view count
   * splits in two. Pausing keeps the connection and keeps both pipes fed, so the broadcast
   * stays live with a frozen picture and a note.
   */
  paused: string | null;
  /** Silence written to cover a gap in receiver audio, in samples. */
  silenceSamples: number;
}

/**
 * How long a gap in receiver audio may go uncovered before silence is written for it.
 *
 * WHY SILENCE MATTERS AT ALL. ffmpeg is muxing two live inputs, and it can only produce
 * output as fast as the SLOWER one arrives. If DAX stops — which it did today, twice, before
 * the watchdog gave up — the video pipe keeps filling, the audio pipe goes quiet, and the
 * muxer stalls. YouTube then sees a stream that has stopped delivering and eventually ends
 * the broadcast, which is the outcome pausing exists to avoid.
 *
 * 400 ms is comfortably longer than the 24 kHz DAX packet interval, so a healthy stream
 * never triggers it, and short enough that a real dropout is covered before the muxer
 * notices.
 */
export const AUDIO_GAP_MS = 400;

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

/**
 * The video filter graph, as a pure function of the four file paths.
 *
 * EXTRACTED SO IT CAN BE ASSERTED. The ticker's backing is a `box` on its own drawtext
 * rather than pixels in the canvas, and that is not a style choice — it is the fix for an
 * artifact no assertion could see while this string was built inside `start()`, halfway
 * through an argv array, next to a `spawn`. `scripts/check-stream-layout.ts` now reads it.
 */
export function videoFilter(paths: {
  font: string;
  overlay: string;
  side: string;
  ticker: string;
}): string {
  const { font, overlay, side, ticker } = paths;
  // `reload=1` re-reads the file every frame, which is how the decode list updates without
  // restarting ffmpeg or rebuilding the filter graph.
  //
  // THREE TEXT BLOCKS, chained. The left column is the station and the decode feed; the
  // right is band conditions beside the map; the third is the ticker. Every size comes from
  // the exported layout constants rather than a literal, so the labels `drawtext` paints
  // cannot drift away from the boxes `lib/stream/panels.ts` paints under them.
  return (
    `drawtext=fontfile=${font}:textfile=${overlay}:reload=1:fontcolor=white:` +
    `fontsize=${FONT_SIZE}:line_spacing=${LINE_SPACING}:x=${LEFT_X}:y=${LEFT_Y}:` +
    `box=1:boxcolor=black@0.45:boxborderw=${BOX_BORDER},` +
    `drawtext=fontfile=${font}:textfile=${side}:reload=1:fontcolor=white:` +
    `fontsize=${FONT_SIZE}:line_spacing=${LINE_SPACING}:x=${SIDE_X}:y=${SIDE_Y},` +
    // THE TICKER, centred IN ITS BAR rather than in the frame — the bar starts at
    // `TICKER_X` so centring on the whole frame would push the text left of its own
    // background. `text_w` is ffmpeg's own expression, so it stays centred as the message
    // changes length; a fixed x would need the character width and would drift.
    `drawtext=fontfile=${font}:textfile=${ticker}:reload=1:fontcolor=white:` +
    // VERTICALLY CENTRED by `TICKER_TEXT_Y`, derived from the two heights rather than
    // nudged — "the words are still to high they should be centered" was the report the
    // first time this was a hand-picked offset.
    `fontsize=${TICKER_FONT}:x=${TICKER_X}+(${TICKER_W}-text_w)/2:y=${TICKER_TEXT_Y}:` +
    // THE BACKING IS THE FILTER'S. Painted over finished video every frame, so unlike the
    // rectangle this replaces it cannot be dragged upward by the waterfall's scroll.
    `box=1:boxcolor=0x0a0a10@0.88:boxborderw=14`
  );
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
    bitrateKbps: null,
    totalBytes: null,
    lastFfmpegLine: null,
    restarts: 0,
    lastError: null,
    paused: null,
    silenceSamples: 0,
  };
  /** When receiver audio last arrived, so a gap can be covered with silence. */
  private lastAudioAt = 0;
  /** The last live picture, frozen and dimmed while paused. */
  private frozen: Buffer | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(options: StreamOptions) {
    this.opts = {
      streamKey: options.streamKey,
      width: options.width ?? FRAME_W,
      height: options.height ?? FRAME_H,
      fps: options.fps ?? 10,
      // RAISED WITH THE RESOLUTION. 2500 kbps was YouTube's own recommendation for 720p;
      // sending 1080p at that rate invites the transcoder to treat it as an over-large
      // picture on a thin pipe, which is the situation this change exists to get out of.
      // 4500 is the 1080p figure, and at ten frames a second it is generous per frame.
      videoBitrateKbps: options.videoBitrateKbps ?? 4500,
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

  /**
   * The RESOLVED encode settings, after defaults have been applied.
   *
   * Exists so the caller's log line reports what ffmpeg was actually given rather than what
   * the caller happened to pass. The bridge used to log its own local variable, which went
   * `undefined` the moment the default moved in here — a log that lies about the bitrate is
   * worse than no log on a fault that is ABOUT the bitrate.
   */
  get encoding(): { width: number; height: number; fps: number; videoBitrateKbps: number } {
    const { width, height, fps, videoBitrateKbps } = this.opts;
    return { width, height, fps, videoBitrateKbps };
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
    this.writeOverlayFile("overlay", text);
  }

  /**
   * The right-hand text block: solar indices and the band list.
   *
   * A SECOND `drawtext` rather than more lines in the first, because the two columns are
   * different widths and different subjects, and one block cannot be in two places. ffmpeg
   * chains filters, so a second instance costs a filter and nothing else.
   */
  setSideOverlay(text: string): void {
    this.writeOverlayFile("side", text);
  }

  /** The invitation along the bottom. Empty for the quiet part of its cycle. */
  setTickerOverlay(text: string): void {
    this.writeOverlayFile("ticker", text);
  }

  private writeOverlayFile(name: string, text: string): void {
    try {
      const tmp = join(this.dir, `${name}.next`);
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, join(this.dir, `${name}.txt`));
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
    this.setSideOverlay("");
    this.setTickerOverlay("");

    const { width, height, fps, videoBitrateKbps, audioRate } = this.opts;
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
    const overlay = join(this.dir, "overlay.txt");
    const side = join(this.dir, "side.txt");
    const ticker = join(this.dir, "ticker.txt");

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
      // TWO TEXT BLOCKS, chained. The left column is the station and the decode feed; the
      // right is band conditions beside the map. `SIDE_X` and `SIDE_Y` are shared with
      // lib/stream/panels.ts through the caller, which draws the colour swatches at the
      // same line pitch. Every size here comes from the exported constants rather than a
      // literal, so the swatches cannot drift away from their labels.
      "-vf",
      videoFilter({ font, overlay, side, ticker }),
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
      // TRUE CBR, WITH FILLER. This is the fix for YouTube's
      //
      //     "YouTube is not receiving enough video to maintain smooth streaming.
      //      As such, viewers will experience buffering."
      //
      // `-b:v` and `-maxrate` are a TARGET and a CEILING, never a floor. A waterfall is a
      // nearly static picture at ten frames a second, so x264 encoded it to a small
      // fraction of the 2500 kbps we had declared and YouTube saw a trickle where it had
      // been promised a stream.
      //
      // Measured before changing anything: frames fed 9.99/s against a declared 10, frames
      // encoded 9.84/s, audio 24,034 Hz against 24,000. The input side was exactly right,
      // which is what ruled out the other explanation — a starved encoder — and left this
      // one.
      //
      // `-minrate` equal to `-maxrate` asks for CBR; `nal-hrd=cbr` is what makes x264
      // actually pad with filler NAL units to reach it. Without the second half the first
      // is advisory and low-motion content still undershoots.
      "-b:v", `${videoBitrateKbps}k`,
      "-minrate", `${videoBitrateKbps}k`,
      "-maxrate", `${videoBitrateKbps}k`,
      "-bufsize", `${videoBitrateKbps * 2}k`,
      "-x264-params", "nal-hrd=cbr:force-cfr=1",
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
      const text = d.toString();
      const m = /frame=(\d+)/.exec(text);
      if (m) this.stat.encoded = Number(m[1]);
      // WHAT WE ARE ACTUALLY SENDING, which nothing measured until YouTube complained.
      //
      // The declared bitrate was in the ffmpeg arguments and in the settings page, and the
      // real one was nowhere — so "is the stream healthy" could only be answered by asking
      // YouTube. ffmpeg reports it in the same progress block the frame count comes from;
      // it cost one more regular expression.
      const b = /bitrate=\s*([\d.]+)kbits\/s/.exec(text);
      if (b) this.stat.bitrateKbps = Math.round(Number(b[1]));
      const t = /total_size=(\d+)/.exec(text);
      if (t) this.stat.totalBytes = Number(t[1]);
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
    // The gap-filler starts with the stream. Primed to "now" so the first real DAX packet,
    // which is a second or two away, is not mistaken for a dropout and covered with silence.
    this.lastAudioAt = Date.now();
    this.startKeepAlive();
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
    this.stat.bitrateKbps = null;
    this.stat.totalBytes = null;
  }

  /**
   * Freeze the picture WITHOUT dropping the connection.
   *
   * "can we pause the stream for a second and not disconnect it so the daily stream doesnt
   * die?" — and the concern is exactly right. `stop()` ends the RTMP session, YouTube ends
   * the broadcast, and a completed broadcast can never be reused: the next start is a new
   * broadcast at a new URL with the viewers gone. That happened today.
   *
   * So this changes only what is SENT, never whether anything is sent. The frozen frame is
   * dimmed so a viewer can tell a paused stream from a stalled one — a still picture that
   * looks live is worse than an obviously halted one, because the second answers the
   * question the first raises.
   */
  pause(reason: string): void {
    if (this.stat.paused) return;
    this.stat.paused = reason || "paused";
    // DIMMED ONCE, not per frame. Copying and dimming 6.2 MB ten times a second would be
    // 62 MB/s of work to display a picture that is not changing.
    if (this.frozen) {
      for (let i = 0; i < this.frozen.length; i++) this.frozen[i] = (this.frozen[i]! * 45) >> 8;
    }
    this.log(`[stream] paused: ${this.stat.paused} — connection held, broadcast stays live`);
  }

  /** Resume sending the live picture. */
  resume(): void {
    if (!this.stat.paused) return;
    this.log(`[stream] resumed after: ${this.stat.paused}`);
    this.stat.paused = null;
    this.frozen = null;
  }

  /**
   * Cover a gap in receiver audio with silence.
   *
   * Runs on its own timer rather than being driven by the caller, BECAUSE the caller is the
   * thing that has stopped. Audio arrives from DAX; when DAX dies there is no callback left
   * to notice, so anything depending on one would go quiet exactly when it was needed.
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    const rate = this.opts.audioRate;
    this.keepAlive = setInterval(() => {
      if (!this.audio || this.audio.destroyed) return;
      const gap = Date.now() - this.lastAudioAt;
      if (gap < AUDIO_GAP_MS) return;
      // Write exactly the gap, so the muxer's clocks stay together rather than drifting by
      // whatever the timer happened to fire at.
      const samples = Math.round((gap / 1000) * rate);
      if (samples <= 0) return;
      this.lastAudioAt = Date.now();
      this.audio.write(Buffer.alloc(samples * 2));
      this.stat.silenceSamples += samples;
    }, Math.round(AUDIO_GAP_MS / 2));
    this.keepAlive.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
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
    // PAUSED STILL WRITES. Returning here would starve the video pipe, ffmpeg would stop
    // producing output, and YouTube would end the broadcast — which is the exact thing
    // pausing exists to prevent. Only the CONTENT changes.
    if (this.stat.paused) {
      if (!this.frozen) {
        this.frozen = Buffer.from(rgb);
        for (let i = 0; i < this.frozen.length; i++) this.frozen[i] = (this.frozen[i]! * 45) >> 8;
      }
      if (v.writableLength > this.frozen.length * 3) return;
      v.write(v.writableLength > 0 ? Buffer.from(this.frozen) : this.frozen);
      this.stat.frames++;
      return;
    }
    // Kept while live, so a pause has something to freeze. One buffer, reused.
    if (!this.frozen || this.frozen.length !== rgb.length) this.frozen = Buffer.allocUnsafe(rgb.length);
    rgb.copy(this.frozen);
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
    // Recorded BEFORE the conversion below, so a slow write does not look like a gap.
    this.lastAudioAt = Date.now();
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
    this.stat.paused = null;
    this.frozen = null;
    this.stopKeepAlive();
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

/* eslint-disable no-console */
// Runs the REAL streaming path against a local file and inspects what came out.
// Run: npx tsx scripts/verify-stream.ts        (needs ffmpeg and ffprobe)
//
// NOT PART OF `npm run check`, deliberately: it spawns ffmpeg, writes a video and takes
// fifteen seconds. It is the thing to run after touching lib/stream/, and the thing that
// turns "reasoned" into "measured" for everything except the RTMP handshake itself.
//
// WHAT IT ACTUALLY PROVES, none of which the pure frame checks can:
//
//   - the two fifos are created and opened in an order that does not deadlock
//   - ffmpeg accepts raw RGB at our size and rate, and raw PCM at DAX's rate
//   - `drawtext` finds the font and re-reads the overlay file WHILE encoding
//   - video and audio mux together and come out the length they should
//   - a frame extracted from the result actually contains the waterfall and the text
//
// The one thing left over is YouTube's own ingest, which needs a real stream key and
// therefore cannot be exercised from a script. That remains stated as unverified.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WaterfallCanvas, overlayText } from "../lib/stream/frame";
import { YouTubeStream } from "../lib/stream/youtube";
import {
  FRAME_W,
  FRAME_H,
  MAX_DECODES,
  DECODE_CHARS,
  TOP_MARGIN,
  LEFT_MARGIN,
} from "../lib/stream/layout";

// TAKEN FROM THE LAYOUT, not restated. These were hardcoded 1280x720, so after the frame
// grew to 1080p this script would have gone on cheerfully verifying a size the real path
// no longer uses — a verifier that passes while testing the wrong thing is worse than none.
const W = FRAME_W;
const H = FRAME_H;
const FPS = 10;
const SECONDS = 30;
const AUDIO_RATE = 24_000;

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

function have(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A spectrum row that looks like a band rather than noise.
 *
 * Three carriers on a rising noise floor, which is what an FT8 segment looks like and
 * what the nearest-neighbour mapping has to keep intact. Deterministic, so a frame pulled
 * out of the result can be compared against what should be there.
 */
function bandRow(t: number): Uint8Array {
  const bins = new Uint8Array(700);
  for (let i = 0; i < bins.length; i++) {
    bins[i] = 20 + Math.round(15 * Math.sin(i / 40 + t / 8));
  }
  for (const [at, strength] of [
    [120, 250],
    [355, 190],
    [590, 220],
  ] as const) {
    // A few bins wide, as a real signal is.
    for (let d = -2; d <= 2; d++) bins[at + d] = strength - Math.abs(d) * 30;
  }
  return bins;
}

/** One second of a 1 kHz tone, which is audible in the result and easy to measure. */
function tone(seconds: number): Float32Array {
  const n = Math.round(AUDIO_RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / AUDIO_RATE);
  return out;
}

function ffprobe(file: string, args: string[]): string {
  return execFileSync("ffprobe", ["-v", "error", ...args, file]).toString().trim();
}

async function main(): Promise<void> {
  console.log("0. what this machine has");
  {
    check("ffmpeg is installed", have("ffmpeg"));
    check("ffprobe is installed", have("ffprobe"));
    if (failures > 0) {
      console.log("\nCannot verify without ffmpeg. apt install ffmpeg fonts-dejavu-core");
      process.exit(1);
    }
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"]).toString();
    check("libx264 is available", encoders.includes("libx264"));
    check("aac is available", /\baac\b/.test(encoders));
    const filters = execFileSync("ffmpeg", ["-hide_banner", "-filters"]).toString();
    check("drawtext is available (needs freetype)", filters.includes("drawtext"));
    check(
      "DejaVu Sans Mono is installed",
      existsSync("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    );
    if (failures > 0) {
      console.log("\nMissing pieces above. apt install ffmpeg fonts-dejavu-core");
      process.exit(1);
    }
  }

  const dir = join(tmpdir(), "digishack-stream-verify");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "out.mp4");

  console.log("");
  console.log(`1. encoding ${SECONDS}s through the real path`);
  const logs: string[] = [];
  const stream = new YouTubeStream({
    // NO KEY, and this is itself worth asserting: a destination alone must be enough, or
    // the verifier would be exercising a different code path from the real one.
    streamKey: "",
    destination: out,
    format: "mp4",
    width: W,
    height: H,
    fps: FPS,
    audioRate: AUDIO_RATE,
    workDir: dir,
    onLog: (l) => logs.push(l),
  });

  // THE MARGINS COME FROM THE LAYOUT TOO. W and H were repointed and these were not, so the
  // verifier built a canvas with the retired 720p top margin and NO left margin at all —
  // its waterfall spanned the full 1920 px and scrolled straight through the region the
  // decode column occupies, which is the exact arrangement the left margin exists to
  // prevent. It passed the whole time.
  const canvas = new WaterfallCanvas(
    { width: W, height: H },
    { topMargin: TOP_MARGIN, leftMargin: LEFT_MARGIN },
  );

  const t0 = Date.now();
  await stream.start();
  check("ffmpeg started without deadlocking on the fifos", stream.status.running);

  // Feed it in real time, exactly as the bridge does — not as fast as possible, because a
  // fifo that is written faster than it is read is a different situation from the one that
  // actually happens and would hide a backpressure fault rather than expose it.
  const frameMs = Math.round(1000 / FPS);
  let frames = 0;
  const overlayEvery = FPS; // once a second, as the bridge does
  for (let i = 0; i < SECONDS * FPS; i++) {
    canvas.push({ bins: bandRow(i), binHz: 3.2, maxHz: 2240 });
    stream.writeFrame(canvas.rgb);
    frames++;
    if (i % overlayEvery === 0) {
      const second = Math.floor(i / FPS);
      stream.setOverlay(
        overlayText({
          callsign: "K9XYZ",
          grid: "EN71",
          band: "20m",
          mode: "FT8",
          dialHz: 14_074_000,
          qsosToday: second,
          // A FULL COLUMN, not eight lines. Eight filled a quarter of it and would have
          // hidden a budget that overran the frame — the fault the operator reported as
          // "your still not running decodes all the way to the bottom either".
          decodes: Array.from({ length: MAX_DECODES }, (_, k) => ({
            at: `14:3${second % 10}:${String(k * 7).padStart(2, "0")}`,
            message: `CQ TEST${String(k).padStart(2, "0")} AA00`,
            snr: -5 - (k % 20),
          })),
          maxDecodes: MAX_DECODES,
          columnChars: DECODE_CHARS,
          // A CONTACT IN PROGRESS for part of the run, so the frame extracted at the end
          // actually carries the working block rather than only the decode list.
          working:
            second % 8 < 5
              ? {
                  theirCall: "K5MGY",
                  phase: ["calling", "report-sent", "rreport-sent", "rr73-sent"][second % 4]!,
                  transcript: [
                    { dir: "tx" as const, message: "K5MGY K9XYZ EN61" },
                    { dir: "rx" as const, message: "K9XYZ K5MGY -09", snr: -5 },
                    { dir: "tx" as const, message: "K5MGY K9XYZ R-05" },
                  ],
                  hunting: null,
                }
              : { theirCall: null, phase: null, transcript: [], hunting: "hunting K1ABC (-7 dB)" },
        }),
      );
      stream.writeAudio(tone(1));
    }
    await new Promise((r) => setTimeout(r, frameMs));
  }
  const elapsed = (Date.now() - t0) / 1000;

  check(`fed ${frames} frames in ${elapsed.toFixed(1)}s`, frames === SECONDS * FPS);
  check("the encoder was still alive at the end", stream.status.running, {
    lastError: stream.status.lastError,
    logs: logs.slice(-3),
  });
  // EVERY ONE, not "essentially all". Once start() waits for the pipes there is no
  // legitimate reason to lose a frame on an idle machine, and a threshold that tolerates
  // a few would have hidden the startup drop this check was what found.
  check(
    `it accepted every frame (${stream.status.frames}/${frames})`,
    stream.status.frames === frames,
    { fed: frames, accepted: stream.status.frames },
  );

  await stream.stop();
  // mp4 needs its moov atom written on close; give the process a moment to finish.
  await new Promise((r) => setTimeout(r, 1_500));

  console.log("");
  console.log("2. what came out");
  {
    check("a file exists", existsSync(out));
    if (!existsSync(out)) {
      console.log(logs.join("\n"));
      process.exit(1);
    }
    const bytes = statSync(out).size;
    check(`it is a real file, not an empty one (${Math.round(bytes / 1024)} KB)`, bytes > 50_000);

    const streams = ffprobe(out, [
      "-show_entries", "stream=codec_name,codec_type,width,height,sample_rate",
      "-of", "csv=p=0",
    ]);
    check("there is an H.264 video stream", /h264/.test(streams), streams);
    check("at the size we asked for", streams.includes(`${W},${H}`), streams);
    // THE AUDIO IS THE POINT OF THE FEATURE and the easiest thing to lose silently: a
    // wrong fifo, a wrong sample format, and the encode still succeeds with video only.
    check("there is an AAC audio stream", /aac/.test(streams), streams);

    const dur = Number(ffprobe(out, ["-show_entries", "format=duration", "-of", "csv=p=0"]));
    check(`the duration is about ${SECONDS}s (${dur.toFixed(1)}s)`, Math.abs(dur - SECONDS) < 3, dur);

    // AUDIO AND VIDEO MUST BE THE SAME LENGTH. If they drift, the stream desyncs and then
    // stalls — and a duration check on the container alone would not catch it, because the
    // container reports the longer of the two.
    const vdur = Number(
      ffprobe(out, ["-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0"]),
    );
    const adur = Number(
      ffprobe(out, ["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0"]),
    );
    check(
      `video and audio agree on the length (${vdur.toFixed(1)}s / ${adur.toFixed(1)}s)`,
      Math.abs(vdur - adur) < 1.5,
      { vdur, adur },
    );
  }

  console.log("");
  console.log("3. the picture actually has something in it");
  {
    // A black video encodes beautifully and proves nothing, so a frame is pulled out and
    // measured. Taken from late in the clip, by which time the waterfall has scrolled and
    // the overlay has been rewritten several times.
    const png = join(dir, "frame.png");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(SECONDS - 3), "-i", out, "-frames:v", "1", "-y", png,
    ]);
    check("a frame can be extracted", existsSync(png));

    // Average brightness of the waterfall area versus the header strip. The waterfall must
    // be lit; the header must be dark enough for white text to read against it.
    // `signalstats`, NOT a scale-to-1x1 and read-the-byte, which was the first attempt and
    // reported 0 for a frame whose real mean was 18.9. A measurement that reads zero when
    // the thing is fine is worse than no measurement: it condemned a working encode.
    const sample = (crop: string): number =>
      Number(
        execFileSync("ffprobe", [
          "-v", "error",
          "-f", "lavfi", "-i", `movie=${png},crop=${crop},signalstats`,
          "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
          "-of", "csv=p=0",
        ]).toString().trim(),
      ) || 0;
    const waterfall = sample(`${W}:400:0:${H - 400}`);
    const header = sample(`${W}:200:0:0`);
    console.log(`       (waterfall ${waterfall}, header ${header})`);
    check(`the waterfall area is lit (mean ${waterfall})`, waterfall > 10, waterfall);
    check(`the header strip stays dark behind the text (mean ${header})`, header < 120, header);

    // AND THE TEXT IS ON IT. Not read back — that would need OCR — but the header cannot be
    // pure black if drawtext put white glyphs and a translucent box on it, and it was pure
    // black before. This is what catches a missing font, which is the confusing failure:
    // ffmpeg exits 0 and the stream is simply textless.
    check(`drawtext drew something (header is not pure black: ${header})`, header > 2, header);
  }

  console.log("");
  console.log("4. the stream key never appears anywhere");
  {
    // Run again with a key that is a recognisable string, and grep everything the module
    // said. The failure this guards against is ffmpeg's own stderr, which prints the whole
    // RTMP URL when a connection fails — key included.
    const KEY = "abcd-efgh-ijkl-mnop-qrst";
    const spy: string[] = [];
    const s2 = new YouTubeStream({
      streamKey: KEY,
      workDir: join(dir, "leak"),
      onLog: (l) => spy.push(l),
    });
    try {
      await s2.start();
    } catch {
      /* it will fail to reach YouTube, which is the point */
    }
    await new Promise((r) => setTimeout(r, 4_000));
    await s2.stop();
    const said = spy.join("\n");
    check(`it logged something to check (${spy.length} lines)`, spy.length > 0);
    check("and the key is in none of it", !said.includes(KEY), said.slice(0, 400));
    check("the placeholder is there instead", said.includes("<stream key>"), said.slice(0, 200));
  }

  console.log("");
  console.log(`artifacts in ${dir}`);
  if (failures > 0) {
    console.log(`\n${failures} failed`);
    console.log(logs.slice(-10).join("\n"));
    process.exit(1);
  }
  console.log("\nall passed");
  process.exit(0);
}

void main();

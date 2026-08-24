/* eslint-disable no-console */
// Golden output for the decode pipeline.
//
// WHY THIS EXISTS: the pipeline half of `FlexDaxSource` — window buffer, silence check,
// decimation, decode — was lifted into `lib/radio/decode-pipeline.ts` so the Icom source
// could feed it too. That code decodes this station's FlexRadio every day, and "I believe
// the refactor changed nothing" is not a checkable statement.
//
// So this pinned the behaviour first: known message in, decoded message out, all three
// modes. It was written against the old private method, run, then repointed at the new
// module — and not one assertion changed. That is the evidence the move was safe.
//
// It earns its keep from here on: any future change to decimation, normalisation, the
// silence check or the window guards has to face it.
//
// Synthetic waveforms rather than a recorded capture, deliberately: no fixture file to
// go stale, no radio needed, and the expected output is derivable rather than remembered.

import { DAX_SAMPLE_RATE } from "@/lib/flex/dax";
import {
  CUT_MARGIN_MS,
  type Decode,
  DecodePipeline,
  decimateTo12k,
  TRANSMISSION_MS,
} from "@/lib/radio/decode-pipeline";
import { buildWaveform, type TxMode } from "@/lib/radio/waveform";
import { binsForRate, fftSizeForRate, SPECTRUM_SPAN_HZ } from "@/lib/radio/spectrum";

/** The pipeline's private buffer, for asserting what reached it. */
function inner(p: DecodePipeline): { buffer: number[] } {
  return p as unknown as { buffer: number[] };
}

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/**
 * Push one window through the pipeline and collect what comes out.
 *
 * Before the extraction this reached past `private` into `FlexDaxSource.processWindow`,
 * because the point was to pin the exact code that was about to move rather than a
 * wrapper that might route around it. It now calls the extracted module directly, and —
 * the part that matters — **not one assertion below changed.** That is the evidence the
 * move was behaviour-preserving.
 *
 * `silenceRms` is passed explicitly at the FlexDaxSource default of 1e-5 rather than
 * left to the pipeline's own default, which is higher. Relying on a default here would
 * mean the test silently measured a different threshold than the live Flex path.
 */
function runWindow(
  mode: TxMode,
  samples: Float32Array,
  inputRate = DAX_SAMPLE_RATE,
): { decodes: Decode[]; rms: number; skipped: boolean } {
  const pipeline = new DecodePipeline({
    mode,
    inputSampleRate: inputRate,
    depth: 2,
    silenceRms: 1e-5,
  });

  let decodes: Decode[] = [];
  let rms = 0;
  let skipped = false;
  pipeline.on("decodes", (d) => {
    decodes = d.decodes;
    rms = d.rms;
  });
  pipeline.on("window", (w) => {
    skipped = w.skipped;
  });
  pipeline.on("error", (e) => {
    fail++;
    console.log(`  FAIL  pipeline error — ${e.message}`);
  });

  pipeline.processWindow(Array.from(samples), new Date(0));
  return { decodes, rms, skipped };
}

const MESSAGE = "CQ K9XYZ EN52";
const OFFSET = 1200;

/**
 * Where in the period a correctly-timed station starts transmitting.
 *
 * FT8 and FT4 begin 0.5 s after the boundary — measured, not assumed: place the signal
 * at +0.5 s and the decoder reports dt of -0.005 and +0.047; place it at the boundary
 * and it reports -0.505 and -0.452. FT2 starts at the boundary itself, and its DT search
 * spans only 0.5 s, so a signal half a second late does not decode at all.
 *
 * This is what the pipeline's buffer is aligned to, so it is what the test must model.
 *
 * The windows built below are transmission span plus cut margin, NOT the bare
 * transmission. The first draft fed the waveform alone and FT2 decoded nothing, which
 * looked like a pipeline bug and was a test bug: `ft2DecodeAudio` refuses any buffer
 * under 29,040 samples at 12 kHz — 2.42 s — and a bare 1.947 s FT2 transmission is below
 * that gate. A decode test that feeds a bare transmission is not testing the pipeline,
 * because the pipeline never sees one.
 */
const TX_START_MS: Record<TxMode, number> = { FT8: 500, FT4: 500, FT2: 0 };

function liveWindow(mode: TxMode, wave: Float32Array): Float32Array {
  const lead = Math.round((DAX_SAMPLE_RATE * TX_START_MS[mode]) / 1000);
  const ms = TX_START_MS[mode] + TRANSMISSION_MS[mode] + CUT_MARGIN_MS;
  const buf = new Float32Array(Math.round((DAX_SAMPLE_RATE * ms) / 1000));
  buf.set(wave.subarray(0, Math.min(wave.length, buf.length - lead)), lead);
  return buf;
}

console.log("\nknown signal in, known message out");
for (const mode of ["FT8", "FT4", "FT2"] as const) {
  const wave = buildWaveform(MESSAGE, mode, OFFSET, DAX_SAMPLE_RATE);
  const { decodes, skipped } = runWindow(mode, liveWindow(mode, wave));

  ok(!skipped, `${mode}: the window is decoded, not skipped as silence`);
  ok(decodes.length >= 1, `${mode}: something decoded`, `${decodes.length} decodes`);

  const hit = decodes.find((d) => d.message === MESSAGE);
  ok(hit !== undefined, `${mode}: the message round-trips through encode and decode`,
    decodes.map((d) => d.message).join(" | ") || "nothing decoded");

  if (hit) {
    eq(hit.mode, mode, `${mode}: tagged with the right mode`);
    // The encoder was told 1200 Hz; the decoder should agree within a few Hz.
    ok(
      Math.abs(hit.freqOffset - OFFSET) <= 5,
      `${mode}: frequency lands within 5 Hz of where it was put`,
      `${hit.freqOffset} Hz`,
    );
    // A correctly-timed station decodes at dt near zero. This is the assertion that
    // caught DigiShack transmitting FT8 and FT4 half a second early: the transmitter
    // keys at the period boundary, but these modes are supposed to start 0.5 s in.
    ok(Math.abs(hit.dt) < 0.1, `${mode}: a correctly-timed signal decodes at dt near zero`, `${hit.dt}`);
    // Clean synthetic audio, so the reported SNR should be high rather than marginal.
    ok(hit.snr > 0, `${mode}: a noiseless signal reports a positive SNR`, `${hit.snr} dB`);
  }
}

console.log("\nthe same pipeline at the Icom's 48 kHz");
{
  // The reason the extraction happened. Identical assertions, two decimation passes
  // instead of one, and the decoder cannot tell which radio delivered the audio.
  for (const mode of ["FT8", "FT2"] as const) {
    const rate = 48_000;
    const wave = buildWaveform(MESSAGE, mode, OFFSET, rate);
    const lead = Math.round((rate * TX_START_MS[mode]) / 1000);
    const ms = TX_START_MS[mode] + TRANSMISSION_MS[mode] + CUT_MARGIN_MS;
    const buf = new Float32Array(Math.round((rate * ms) / 1000));
    buf.set(wave.subarray(0, Math.min(wave.length, buf.length - lead)), lead);

    const { decodes } = runWindow(mode, buf, rate);
    const hit = decodes.find((d) => d.message === MESSAGE);
    ok(hit !== undefined, `${mode} @48k: the message round-trips`,
      decodes.map((d) => d.message).join(" | ") || "nothing decoded");
    if (hit) {
      ok(Math.abs(hit.freqOffset - OFFSET) <= 5, `${mode} @48k: frequency is right`, `${hit.freqOffset} Hz`);
      ok(Math.abs(hit.dt) < 0.1, `${mode} @48k: dt is near zero`, `${hit.dt}`);
    }
  }
}

console.log("\nrates that do not divide");
{
  // 44.1 kHz is the rate someone will eventually try, from a sound card rather than a
  // radio. There is no resampler here, and there should not silently be one: audio at
  // the wrong rate decodes as nothing at all, with no error to explain it. So refuse
  // loudly at construction rather than quietly at 3am.
  let threw = "";
  try {
    new DecodePipeline({ mode: "FT8", inputSampleRate: 44_100 });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(/does not reduce/i.test(threw), "44.1 kHz is refused at construction", threw || "no error");
  ok(/resampler/i.test(threw), "and the message says why, not just that it failed");

  // The two real rates, and the degenerate one.
  for (const rate of [12_000, 24_000, 48_000]) {
    let bad = false;
    try {
      new DecodePipeline({ mode: "FT8", inputSampleRate: rate });
    } catch {
      bad = true;
    }
    ok(!bad, `${rate} Hz is accepted`);
  }

  eq(decimateTo12k(new Float32Array(4800), 48_000).length, 1200, "48 kHz decimates by four");
  eq(decimateTo12k(new Float32Array(4800), 24_000).length, 2400, "24 kHz decimates by two");
  eq(decimateTo12k(new Float32Array(4800), 12_000).length, 4800, "12 kHz passes through untouched");
}

console.log("\nthe silence check");
{
  // Windows below the RMS threshold are skipped without decoding at all. This is the
  // behaviour the per-radio silenceRms defaults depend on, so it has to survive the
  // extraction unchanged.
  const quiet = new Float32Array(DAX_SAMPLE_RATE * 13);
  const { skipped, decodes } = runWindow("FT8", quiet);
  ok(skipped, "a silent window is skipped");
  eq(decodes.length, 0, "and nothing is decoded from it");
}

console.log("\nthe short-window guard");
{
  // A partial window cannot hold a whole transmission — startup, or packet loss. It
  // must be dropped rather than fed to the decoder.
  const oneSecond = new Float32Array(DAX_SAMPLE_RATE);
  const { decodes } = runWindow("FT8", oneSecond);
  eq(decodes.length, 0, "a one-second window produces no decodes");
}

console.log("\nthe waterfall looks the same on every radio");
{
  // The FFT size scales with the sample rate so bin width and time window come out
  // identical. A fixed 4096 was the first version and it was wrong twice over at
  // 48 kHz: 11.72 Hz bins cannot separate FT8 tones 6.25 Hz apart, and the 85 ms window
  // meant consecutive frames 250 ms apart shared almost nothing — which is what "the
  // waterfall just randomly refreshes" looks like.
  //
  // Defined relative to 24 kHz, so the FlexRadio path is arithmetically unchanged.
  const rates = [12_000, 24_000, 48_000];

  eq(fftSizeForRate(24_000), 4096, "24 kHz is still 4096 — the Flex path does not move");

  for (const r of rates) {
    const width = r / fftSizeForRate(r);
    const windowMs = (fftSizeForRate(r) / r) * 1000;
    const bins = binsForRate(r);
    ok(Math.abs(width - 5.859) < 0.01, `${r} Hz gives 5.86 Hz per bin`, width.toFixed(2));
    ok(Math.abs(windowMs - 170.7) < 1, `${r} Hz covers 171 ms per frame`, `${windowMs.toFixed(0)} ms`);
    ok(
      Math.abs(bins * width - SPECTRUM_SPAN_HZ) < 20,
      `${r} Hz shows the same ${SPECTRUM_SPAN_HZ} Hz span`,
      `${Math.round(bins * width)} Hz`,
    );
  }

  // The resolution that actually matters: FT8 tones are 6.25 Hz apart, so a bin wider
  // than that cannot tell two of them apart at all.
  ok(
    rates.every((r) => r / fftSizeForRate(r) < 6.25),
    "every rate resolves finer than FT8's 6.25 Hz tone spacing",
  );

  // Powers of two, or FftPlan throws — including for a rate that is not a clean
  // multiple of 24 kHz.
  for (const r of [...rates, 44_100]) {
    const n = fftSizeForRate(r);
    ok((n & (n - 1)) === 0, `${r} Hz yields a power-of-two FFT size`, String(n));
  }
}

console.log("\nmuting the decoder while we transmit");
{
  // The Icom streams receive audio straight through a transmission, unlike DAX which goes
  // silent, so without a mute the decoder hears our own signal and reports it as a decode.
  // It did, and the consequences were worse than the noise in the decode list: every one
  // of our own transmissions was uploaded to PSKReporter as a station we had heard, the
  // deaf guard counted them as proof the receiver worked, and the clock estimate was
  // dragged toward zero by a signal that is perfectly timed by construction.
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: 24_000, silenceRms: 1e-5 });

  const audio = new Float32Array(2_400);
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin((2 * Math.PI * 1200 * i) / 24_000);

  p.push(audio);
  ok(inner(p).buffer.length > 0, "audio reaches the buffer normally");

  const before = inner(p).buffer.length;
  p.muteUntil(Date.now() + 5_000);
  ok(p.dropping, "muteUntil puts it in the dropping state");
  p.push(audio);
  eq(inner(p).buffer.length, before, "and nothing more is buffered while muted");

  // Never brought forward: a mute already extending past this is a longer transmission
  // than the one being asked about, and shortening it would un-mute mid-transmission.
  p.muteUntil(Date.now() + 100);
  ok(p.dropping, "a shorter mute does not shorten a longer one");

  p.muteUntil(0);
  ok(p.dropping, "nor does muting until the past");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

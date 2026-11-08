/* eslint-disable no-console */
// WEFAX: the start and stop tones for both IOCs, a test chart through the receiver and back
// - grey levels, width, left edge, row count - at the three rates the radios give, with
// the sound card's clock 200 ppm off, fed in different chunk sizes, in noise; and noise and
// silence alone, which must start no picture. Ends with the CPU it costs.
// Run: npx tsx scripts/check-wefax.ts
import {
  WEFAX_APT_START_HZ,
  wefaxTestPattern,
  wefaxTestPixel,
  wefaxTestRegions,
  wefaxWaveform,
  wefaxWidth,
  WEFAX_TEST_BAR_PX,
  type WefaxImage,
  type WefaxIoc,
  type WefaxWaveformOptions,
} from "@/lib/digital/wefax";
import { WefaxDecoder, type WefaxDecoderOptions, type WefaxEndInfo, type WefaxInfo } from "@/lib/digital/wefaxdemod";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
}

/** White Gaussian noise for an SNR measured in 2500 Hz, as check-sstv does. */
function addNoise(w: Float32Array, snrDb: number, fs: number, seed = 3, refPower?: number): Float32Array {
  let p = refPower ?? 0;
  if (refPower === undefined) {
    let n = 0;
    for (const v of w) {
      if (v !== 0) {
        p += v * v;
        n++;
      }
    }
    p /= Math.max(1, n);
  }
  const sigma = Math.sqrt((p / 10 ** (snrDb / 10)) * (fs / 2 / 2500));
  const rnd = random(seed);
  return w.map((v) => v + sigma * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
}

interface Result {
  starts: WefaxInfo[];
  images: { img: WefaxImage; info: WefaxEndInfo }[];
  stops: number;
  rows: number;
  dec: WefaxDecoder;
  /** Rows as onRows delivered them, for the chunking check. */
  streamed: Uint8ClampedArray[];
}

function decode(wave: Float32Array, fs: number, chunk = 4096, opts: WefaxDecoderOptions = {}, keepStream = false): Result {
  const r: Result = { starts: [], images: [], stops: 0, rows: 0, dec: null as unknown as WefaxDecoder, streamed: [] };
  r.dec = new WefaxDecoder(
    fs,
    {
      onStart: (i) => r.starts.push(i),
      onRows: (img, a, b) => {
        r.rows += b - a;
        if (keepStream) for (let y = a; y < b; y++) r.streamed.push(img.rgb.slice(y * img.width * 3, (y + 1) * img.width * 3));
      },
      onImage: (img, info) => r.images.push({ img, info }),
      onStop: () => r.stops++,
    },
    opts,
  );
  for (let i = 0; i < wave.length; i += chunk) r.dec.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return r;
}

const px = (img: WefaxImage, x: number, y: number) => img.rgb[(y * img.width + x) * 3]!;

/** Pearson correlation of the decoded picture (rows offset by `off`) with the chart. */
function correlate(img: WefaxImage, chart: WefaxImage, off: number): number {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = 0; y < chart.height; y++) {
    const yd = y + off;
    if (yd < 0 || yd >= img.height) continue;
    for (let x = 0; x < chart.width; x += 3) {
      const a = px(img, x, yd);
      const b = px(chart, x, y);
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
    }
  }
  if (n === 0) return 0;
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
}

function bestOffset(img: WefaxImage, chart: WefaxImage): { off: number; r: number } {
  let best = { off: 0, r: -2 };
  for (let off = -3; off <= 3; off++) {
    const r = correlate(img, chart, off);
    if (r > best.r) best = { off, r };
  }
  return best;
}

/** Share of chart rows whose flat bar middles and gradient points read within `tol` grey levels. */
function greyCheck(img: WefaxImage, chart: WefaxImage, off: number, tol: number): { share: number; worst: number } {
  const W = chart.width;
  const reg = wefaxTestRegions(W);
  const xs: number[] = [];
  for (let b = reg.barsFrom; b + WEFAX_TEST_BAR_PX <= reg.barsTo; b += WEFAX_TEST_BAR_PX) {
    for (let x = b + Math.round(WEFAX_TEST_BAR_PX * 0.3); x < b + Math.round(WEFAX_TEST_BAR_PX * 0.7); x += 3) xs.push(x);
  }
  for (let x = reg.gradFrom + 40; x < reg.gradTo - 40; x += 25) xs.push(x);
  let good = 0, rows = 0, worst = 0;
  for (let y = 0; y < chart.height; y++) {
    const yd = y + off;
    if (yd < 0 || yd >= img.height) continue;
    rows++;
    let rowWorst = 0;
    for (const x of xs) rowWorst = Math.max(rowWorst, Math.abs(px(img, x, yd) - wefaxTestPixel(x, y, W)));
    if (rowWorst <= tol) good++;
    worst = Math.max(worst, rowWorst);
  }
  return { share: rows ? good / rows : 0, worst };
}

/** Where the white margin falls to the first black bar in a chart row (unflipped rows only), in pixel-edge units. */
function leftEdge(img: WefaxImage, yd: number): number | null {
  const W = img.width;
  const reg = wefaxTestRegions(W);
  for (let x = reg.barsFrom - 40; x < reg.barsFrom + 40; x++) {
    const a = px(img, x, yd);
    const b = px(img, x + 1, yd);
    if (a >= 127.5 && b < 127.5) return x + 0.5 + (a - 127.5) / (a - b);
  }
  return null;
}

function edgeDrift(img: WefaxImage, chart: WefaxImage, off: number): { first: number; last: number; maxErr: number; mean: number } {
  const truth = wefaxTestRegions(chart.width).barsFrom;
  const rows: number[] = [];
  for (let y = 0; y < chart.height; y++) if (Math.floor(y / 40) % 2 === 0 && y + off < img.height) rows.push(y);
  const at = (ys: number[]) => {
    const v = ys.map((y) => leftEdge(img, y + off)).filter((e): e is number => e !== null);
    return v.reduce((s, e) => s + e, 0) / Math.max(1, v.length) - truth;
  };
  let maxErr = 0;
  for (const y of rows) {
    const e = leftEdge(img, y + off);
    maxErr = Math.max(maxErr, e === null ? 999 : Math.abs(e - truth));
  }
  return { first: at(rows.slice(0, 10)), last: at(rows.slice(-10)), maxErr, mean: at(rows) };
}

function wave(chart: WefaxImage | null, o: Partial<WefaxWaveformOptions> & { sampleRate: number; ioc: WefaxIoc }): Float32Array {
  return wefaxWaveform(chart, { lpm: 120, ...o });
}

// ---------------------------------------------------------------------------

console.log("the start and stop tones");
for (const ioc of [576, 288] as WefaxIoc[]) {
  const fs = 12000;
  const chart = wefaxTestPattern(wefaxWidth(ioc), 60);
  const r = decode(wave(chart, { sampleRate: fs, ioc }), fs);
  const s = r.dec.statistics;
  ok(s.aptHeard === 1, `IOC ${ioc}: start tone (${WEFAX_APT_START_HZ[ioc]} Hz) heard once`, s);
  ok(r.starts.length === 1 && r.starts[0]!.ioc === ioc && r.starts[0]!.apt, `IOC ${ioc}: one picture started, IOC from the tone`, r.starts);
  ok(r.images.length === 1 && r.images[0]!.info.reason === "stop" && r.stops === 1, `IOC ${ioc}: ended by the stop tone (450 Hz)`, r.images.map((i) => i.info.reason));
  const h = r.images[0]?.img.height ?? 0;
  ok(h === 61, `IOC ${ioc}: 61 rows (fldigi's white line + 60), stop tone trimmed off (got ${h})`);
  ok(!s.receiving && s.pictures === 1, `IOC ${ioc}: idle again afterwards`, s);
}

console.log("a test chart at 12, 24 and 48 kHz");
for (const fs of [12000, 24000, 48000]) {
  for (const ioc of [576, 288] as WefaxIoc[]) {
    const W = wefaxWidth(ioc);
    const chart = wefaxTestPattern(W, 120);
    const r = decode(wave(chart, { sampleRate: fs, ioc }), fs);
    const img = r.images[0]?.img;
    if (!img) {
      ok(false, `${fs} Hz IOC ${ioc}: a picture`, r.starts);
      continue;
    }
    const { off, r: corr } = bestOffset(img, chart);
    const g = greyCheck(img, chart, off, 12);
    const e = edgeDrift(img, chart, off);
    const st = r.starts[0]!;
    ok(img.width === W && st.width === W, `${fs} Hz IOC ${ioc}: ${W} pixels wide`);
    ok(st.aligned && st.lpm === 120 && st.phasingLines >= 15, `${fs} Hz IOC ${ioc}: aligned on ${st.phasingLines} phasing lines, 120 LPM measured`, st);
    ok(off === 1, `${fs} Hz IOC ${ioc}: rows line up (picture starts on fldigi's white line, offset ${off})`);
    ok(g.share >= 0.99, `${fs} Hz IOC ${ioc}: grey levels within 12 on ${(g.share * 100).toFixed(1)}% of rows (worst ${g.worst.toFixed(0)}), r=${corr.toFixed(3)}`);
    ok(e.maxErr <= 2, `${fs} Hz IOC ${ioc}: left edge within 2 px on every row (worst ${e.maxErr.toFixed(2)} px, mean ${e.first.toFixed(2)})`);
  }
}

console.log("lines per minute: 60, 90, 240 from the phasing");
for (const lpm of [60, 90, 240]) {
  const fs = 12000;
  const chart = wefaxTestPattern(1809, 40);
  const r = decode(wefaxWaveform(chart, { sampleRate: fs, ioc: 576, lpm }), fs);
  const img = r.images[0]?.img;
  const st = r.starts[0];
  ok(!!st && st.lpm === lpm, `${lpm} LPM measured`, st);
  if (img) {
    const { off } = bestOffset(img, chart);
    const g = greyCheck(img, chart, off, lpm === 240 ? 20 : 12);
    const e = edgeDrift(img, chart, off);
    ok(g.share >= 0.95 && e.maxErr <= 3, `${lpm} LPM: greys ok on ${(g.share * 100).toFixed(1)}% of rows, left edge worst ${e.maxErr.toFixed(2)} px`);
  }
}

console.log("inverted phasing, and no start tone (tuned in during the phasing)");
{
  const fs = 12000;
  const chart = wefaxTestPattern(1809, 40);
  const a = decode(wave(chart, { sampleRate: fs, ioc: 576, invertedPhasing: true }), fs);
  const ea = a.images[0] ? edgeDrift(a.images[0].img, chart, bestOffset(a.images[0].img, chart).off) : null;
  ok(a.starts[0]?.aligned === true && !!ea && ea.maxErr <= 2, `inverted phasing aligns (worst ${ea?.maxErr.toFixed(2)} px)`);
  const b = decode(wave(chart, { sampleRate: fs, ioc: 576, withApt: false, phasingLines: 30 }), fs);
  const st = b.starts[0];
  ok(b.dec.statistics.aptHeard === 0 && st?.aligned === true && st.apt === false, "phasing alone starts an aligned picture", st);
}

console.log("sound card 200 ppm off");
let slantReport = "";
for (const ppm of [200, -200]) {
  const fs = 12000;
  const rows = 400;
  const chart = wefaxTestPattern(1809, rows);
  const w = wave(chart, { sampleRate: fs, ioc: 576, ppmError: ppm });
  const r = decode(w, fs);
  const img = r.images[0]?.img;
  const st = r.starts[0];
  if (!img || !st) {
    ok(false, `${ppm} ppm: a picture`);
    continue;
  }
  const { off } = bestOffset(img, chart);
  const e = edgeDrift(img, chart, off);
  const drift = e.last - e.first;
  const residualPpm = (drift / 1809 / rows) * 1e6;
  ok(Math.abs(st.ppm - ppm) < 20, `${ppm} ppm: measured from the phasing as ${st.ppm.toFixed(1)} ppm`);
  ok(Math.abs(drift) <= 3 && e.maxErr <= 3, `${ppm} ppm: left edge drifts ${drift.toFixed(2)} px over ${rows} rows (residual ${residualPpm.toFixed(1)} ppm; uncorrected would be ${((ppm * 1e-6 * rows) * 1809).toFixed(0)} px)`);
  slantReport += ` ${ppm}: ${drift.toFixed(2)} px/${rows} rows (${residualPpm.toFixed(1)} ppm);`;
  // Without the automatic correction, with the manual one set to the right value.
  const m = decode(w, fs, 4096, { autoSlant: false, slantPpm: ppm });
  const mi = m.images[0]?.img;
  const me = mi ? edgeDrift(mi, chart, bestOffset(mi, chart).off) : null;
  ok(!!me && Math.abs(me.last - me.first) <= 3 && m.starts[0]?.slant === "manual", `${ppm} ppm: the manual slant setting does the same (drift ${me ? (me.last - me.first).toFixed(2) : "?"} px)`);
  const u = decode(w, fs, 4096, { autoSlant: false });
  const ui = u.images[0]?.img;
  const ue = ui ? edgeDrift(ui, chart, bestOffset(ui, chart).off) : null;
  ok(!!ue && Math.abs(ue.last - ue.first) > 50, `${ppm} ppm: and with neither, it leans more than 50 px (the measurement window clips it), so the check is real`);
}

console.log("chunk sizes 1, 97 and whole give the same picture");
{
  const fs = 12000;
  const chart = wefaxTestPattern(1809, 30);
  const w = wave(chart, { sampleRate: fs, ioc: 576, phasingLines: 10 });
  const a = decode(w, fs, 1, {}, true);
  const b = decode(w, fs, 97, {}, true);
  const c = decode(w, fs, w.length, {}, true);
  const same = (x: Uint8ClampedArray, y: Uint8ClampedArray) => x.length === y.length && x.every((v, i) => v === y[i]);
  const ia = a.images[0]?.img, ib = b.images[0]?.img, ic = c.images[0]?.img;
  ok(!!ia && !!ib && !!ic && same(ia.rgb, ib.rgb) && same(ia.rgb, ic.rgb), `identical pictures (${ia?.height} rows)`);
  ok(a.streamed.length >= (ia?.height ?? 1) && a.streamed.slice(0, ia!.height).every((row, y) => same(row, c.streamed[y]!)), "identical rows as they streamed");
}

console.log("in noise");
let noiseReport = "";
for (const snr of [20, 10, 5]) {
  const fs = 12000;
  const chart = wefaxTestPattern(1809, 120);
  const w = addNoise(wave(chart, { sampleRate: fs, ioc: 576 }), snr, fs, 7);
  const r = decode(w, fs);
  const img = r.images[0]?.img;
  if (!img) {
    ok(snr < 10, `${snr} dB SNR in 2500 Hz: a picture`, { starts: r.starts.length, apt: r.dec.statistics.aptHeard });
    noiseReport += ` ${snr} dB: none;`;
    continue;
  }
  const { off, r: corr } = bestOffset(img, chart);
  const st = r.starts[0]!;
  const e = edgeDrift(img, chart, off);
  noiseReport += ` ${snr} dB: r=${corr.toFixed(3)};`;
  if (snr >= 10) {
    ok(corr >= 0.9 && st.aligned && Math.abs(e.mean) <= 1.5, `${snr} dB SNR in 2500 Hz: recognisable, correlation ${corr.toFixed(3)} with the chart, aligned, left edge off by ${e.mean.toFixed(2)} px on average (worst row ${e.maxErr.toFixed(1)}), ended by ${r.images[0]!.info.reason}`);
  } else {
    console.log(`  info  ${snr} dB SNR: correlation ${corr.toFixed(3)}, aligned ${st.aligned}, ended by ${r.images[0]!.info.reason}`);
  }
}

console.log("noise and silence alone");
{
  const fs = 12000;
  const n = new Float32Array(fs * 60);
  const noise = addNoise(n, 0, fs, 11, 0.1);
  const r = decode(noise, fs);
  ok(r.starts.length === 0 && r.dec.statistics.aptHeard === 0, "60 s of noise starts nothing", { starts: r.starts.length, apt: r.dec.statistics.aptHeard });
  for (const f of [24000, 48000]) {
    const nz = addNoise(new Float32Array(f * 60), 0, f, 13, 0.1);
    const rz = decode(nz, f);
    ok(rz.starts.length === 0 && rz.dec.statistics.aptHeard === 0, `60 s of noise at ${f} Hz starts nothing`);
  }
  const s = decode(new Float32Array(fs * 4), fs);
  ok(s.starts.length === 0 && s.dec.statistics.aptHeard === 0 && !s.dec.statistics.receiving, "4 s of digital silence starts nothing", s.dec.statistics);
}

console.log("how a picture ends without a stop tone");
{
  const fs = 12000;
  const chart = wefaxTestPattern(1809, 80);
  const join = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const noApt = wave(chart, { sampleRate: fs, ioc: 576, withApt: false, phasingLines: 30, leadSeconds: 0 });
  const lost = decode(addNoise(join(noApt, new Float32Array(fs * 40)), 20, fs, 17, 0.32), fs);
  ok(lost.images.length === 1 && lost.images[0]!.info.reason === "lost" && Math.abs(lost.images[0]!.img.height - 81) <= 3, `station goes off into noise: ended as lost, ${lost.images[0]?.img.height} rows kept`, lost.images.map((i) => i.info.reason));
  const quiet = decode(join(noApt, new Float32Array(fs * 15)), fs);
  ok(quiet.images.length === 1 && quiet.images[0]!.info.reason === "silence" && quiet.images[0]!.img.height === 81, `station goes off into silence: ended after 10 s, ${quiet.images[0]?.img.height} rows kept`, quiet.images.map((i) => [i.info.reason, i.img.height]));
  const two = decode(join(noApt, noApt), fs);
  ok(two.images.length === 1 && two.images[0]!.info.reason === "phasing" && Math.abs(two.images[0]!.img.height - 81) <= 1 && two.starts.length === 2, `a second picture's phasing ends the first (${two.images[0]?.img.height} rows) and starts the second`, two.images.map((i) => [i.info.reason, i.img.height]));
  const aptAgain = wave(chart, { sampleRate: fs, ioc: 576 });
  const cut = aptAgain.subarray(0, aptAgain.length - Math.round(fs * 5.5));
  const pair = decode(join(cut, aptAgain), fs);
  ok(pair.images.length === 2 && pair.images[0]!.info.reason === "apt" && Math.abs(pair.images[0]!.img.height - 81) <= 1 && pair.dec.statistics.aptHeard === 2, `a start tone with no stop before it ends one picture (${pair.images[0]?.img.height} rows) and starts the next`, pair.images.map((i) => [i.info.reason, i.img.height]));
}

console.log("reset, the line cap, and statistics");
{
  const fs = 12000;
  const chart = wefaxTestPattern(1809, 50);
  const w = wave(chart, { sampleRate: fs, ioc: 576 });
  const r = decode(w.subarray(0, Math.floor(w.length * 0.6)), fs);
  ok(r.dec.statistics.receiving && r.dec.statistics.lines > 0, `mid-picture: receiving, ${r.dec.statistics.lines} lines`);
  ok(r.dec.statistics.levelDb > -5 && r.dec.statistics.levelDb < 0, `level ${r.dec.statistics.levelDb.toFixed(1)} dBFS for a 0.8 peak sine`);
  r.dec.reset();
  const s = r.dec.statistics;
  ok(!s.receiving && s.lines === 0 && s.pictures === 0 && s.aptHeard === 0, "reset clears everything", s);
  const capped = decode(w, fs, 4096, { maxLines: 20 });
  ok(capped.images.length >= 1 && capped.images[0]!.img.height === 20 && capped.images[0]!.info.reason === "max", "a picture is ended at the line cap", capped.images.map((i) => [i.img.height, i.info.reason]));
}

console.log("CPU");
{
  const fs = 24000;
  const chart = wefaxTestPattern(1809, 200);
  const w = addNoise(wave(chart, { sampleRate: fs, ioc: 576 }), 15, fs, 5);
  const t0 = performance.now();
  decode(w, fs, 2048);
  const ms = performance.now() - t0;
  const seconds = w.length / fs;
  const pct = (ms / 1000 / seconds) * 100;
  console.log(`  info  ${seconds.toFixed(0)} s of audio at 24 kHz in ${ms.toFixed(0)} ms: ${pct.toFixed(2)}% of a core`);
  ok(pct < 10, "under 10% of a core at 24 kHz");
}

console.log(`\nslant residual:${slantReport}`);
console.log(`noise:${noiseReport}`);
if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall WEFAX checks passed");

/* eslint-disable no-console */
// SSTV replies: the RSV report measured off a picture's sync pulses and the S-meter, the
// calls and report read out of a picture's text, and the OCR itself on a real picture off
// the air (N3CHX, 14.230, docs/sstv-first-n3chx.png).
// Run: npm run check:sstv-read
import fs from "node:fs";
import path from "node:path";

import { SstvDecoder, sstvModeByName, sstvRsv, sstvTestCard, sstvWaveform, type SstvSignal } from "@/lib/digital/sstv";
import { parseSstvText, readSstvPicture } from "@/lib/digital/sstv-read";
import { encodePng } from "@/lib/digital/png";
import sharp from "sharp";

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

function addNoise(w: Float32Array, snrDb: number, fs: number, seed = 3): Float32Array {
  let p = 0;
  for (const v of w) p += v * v;
  p /= w.length;
  const sigma = Math.sqrt((p / 10 ** (snrDb / 10)) * (fs / 2 / 2500));
  const rnd = random(seed);
  return w.map((v) => v + sigma * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
}

function signalOf(name: string, snrDb: number | null): SstvSignal | null {
  const fs = 24000;
  const mode = sstvModeByName(name)!;
  const clean = sstvWaveform(mode, sstvTestCard(mode.width, mode.height), { sampleRate: fs, leadMs: 500 });
  let got: SstvSignal | null = null;
  const d = new SstvDecoder(fs, { onImage: (_i, _m, s) => (got = s) });
  d.feed(snrDb === null ? clean : addNoise(clean, snrDb, fs));
  d.feed(new Float32Array(fs * 2));
  return got;
}

console.log("the report measured off the picture");
for (const name of ["Martin 1", "Robot 36"]) {
  const clean = signalOf(name, null)!;
  const r = sstvRsv(clean, null);
  ok(r.r === 5 && r.v >= 8, `${name} clean reads R5 and V8 or V9 (${r.report}, ${clean.syncNoiseHz.toFixed(0)} Hz)`);
  const noisy = signalOf(name, 10)!;
  const n = sstvRsv(noisy, null);
  ok(n.v <= 5 && n.v < r.v, `${name} at 10 dB reads a lower V (${n.report}, ${noisy.syncNoiseHz.toFixed(0)} Hz)`);
}
ok(sstvRsv({ syncFound: 1, syncNoiseHz: 20 }, -73).s === 9, "S9 at -73 dBm");
ok(sstvRsv({ syncFound: 1, syncNoiseHz: 20 }, -97).s === 5, "S5 at -97 dBm, 6 dB a unit");
ok(sstvRsv({ syncFound: 1, syncNoiseHz: 20 }, -40).s === 9, "over S9 is still 9");
ok(sstvRsv({ syncFound: 1, syncNoiseHz: 20 }, -140).s === 1, "under S1 is 1");
ok(!sstvRsv({ syncFound: 1, syncNoiseHz: 20 }, null).sMeasured, "no S-meter: S is marked estimated");
ok(sstvRsv({ syncFound: 0.5, syncNoiseHz: 20 }, null).r === 2, "half the syncs lost: R2");

console.log("\nthe calls and report in a picture's text");
const a = parseSstvText("KC9QRS DE N3CHX\nUR 595\nTNX 73", "KC9QRS");
ok(a.theirCall === "N3CHX" && a.reportRcvd === "595" && a.toUs, "KC9QRS DE N3CHX UR 595: them, the report, to us", a);
const b = parseSstvText("CQ CQ DE K4ABC/P", "KC9QRS");
ok(b.theirCall === "K4ABC/P" && b.reportRcvd === null && !b.toUs, "a CQ: their call with /P, no report", b);
const c = parseSstvText("Greetings from VE3XYZ 73 RSV 57 9", "KC9QRS");
ok(c.theirCall === "VE3XYZ" && c.reportRcvd === "57" && c.calls.length === 1, "an RS after RSV, and \"from\" is not FR0M", c);
const d = parseSstvText("KC9QRS 595 from G4ABC", "KC9QRS");
ok(d.reportRcvd === "595" && d.theirCall === "G4ABC", "a bare 595 counts on a picture to us", d);
const e = parseSstvText("2026 595 G4ABC", "KC9QRS");
ok(e.reportRcvd === null, "a bare 595 on a picture not to us does not", e);
const f = parseSstvText("KC9QRS DE KIABC UR 57", "KC9QRS");
ok(f.theirCall === "K1ABC" && f.reportRcvd === "57", "I for 1 in the digit, and an RS after UR", f);
const h = parseSstvText("KC9ORS DE KD9XYZ UR 577", "KC9QRS");
ok(h.toUs && h.theirCall === "KD9XYZ" && h.calls.length === 1, "our call misread by one character is still ours", h);
const g = parseSstvText("sid HELLO 73 KC9QRS", "KC9QRS");
ok(g.theirCall === null && g.calls.length === 0, "words are not callsigns", g);

console.log("\nOCR on a picture off the air");
(async () => {
  const file = path.join(process.cwd(), "docs", "sstv-first-n3chx.png");
  if (!fs.existsSync(file)) {
    ok(false, "docs/sstv-first-n3chx.png is there");
  } else {
    // Decoded to RGB as the decoder hands it over, so the OCR runs the bridge path whole.
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const started = Date.now();
    const read = await readSstvPicture(info.width, info.height, data, "KC9QRS", encodePng);
    ok(read.theirCall === "N3CHX", `N3CHX read off the picture (${JSON.stringify(read.text)}, ${Date.now() - started} ms)`, read);

    // A reply as the send box draws one: yellow on a dark band across the bottom. Short enough
    // to fit in any sans font: librsvg on the box ignores textLength and draws wider than here.
    const band = Math.round(info.height / 7);
    const caption = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}">` +
        `<rect x="0" y="${info.height - band}" width="${info.width}" height="${band}" fill="black" fill-opacity="0.75"/>` +
        `<text x="${info.width / 2}" y="${info.height - band / 2}" font-family="sans-serif" font-weight="bold" font-size="17" fill="#ff0" stroke="#000" stroke-width="2" paint-order="stroke" text-anchor="middle" dominant-baseline="middle">KC9QRS DE KD9XYZ UR 577</text>` +
        `</svg>`,
    );
    const replied = await sharp(file).composite([{ input: caption }]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const r2 = await readSstvPicture(replied.info.width, replied.info.height, replied.data, "KC9QRS", encodePng);
    ok(r2.theirCall === "KD9XYZ" && r2.reportRcvd === "577" && r2.toUs, `a reply caption read: KD9XYZ, 577, to us (${JSON.stringify(r2.text)})`, r2);
  }
  console.log(failed === 0 ? "\nall ok" : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

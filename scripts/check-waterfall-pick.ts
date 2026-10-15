/* eslint-disable no-console */
// The waterfall is a control on RTTY, PSK31, Olivia and JS8: a click puts the decoder (or
// the JS8 send offset) where the signal is. It did nothing for all four until 1.201.1,
// because SpectrumCanvas wraps every overlay in a pointer-events-none layer - so the
// ruler and markers never swallow a scroll or a touch - and the click layer inside it
// inherited that. Nothing errored; the click simply never arrived.
//
// This reads the two components and checks the pair of facts that decide it: the click
// layer must opt back in with pointer-events-auto whenever the canvas wraps overlays in
// pointer-events-none, and the page must hand the waterfall a pick handler for every mode
// whose panel tells the operator to click it.
// Run: npm run check:waterfall-pick

import fs from "node:fs";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

const canvas = fs.readFileSync("components/digital/spectrum-canvas.tsx", "utf8");
const waterfall = fs.readFileSync("components/digital/Waterfall.tsx", "utf8");
const page = fs.readFileSync("pages/decodes.tsx", "utf8");
const panel = fs.readFileSync("components/digital/StreamPanel.tsx", "utf8");

console.log("the click reaches the waterfall");
const wrapsInert = /pointer-events-none">\{children\}/.test(canvas);
const pick = /\{onPickHz && \(\s*<div\s+className="([^"]*)"/.exec(waterfall);
ok(pick !== null, "the waterfall has a click layer for onPickHz");
const cls = pick?.[1] ?? "";
ok(cls.includes("absolute") && cls.includes("inset-0"), "covering the whole display", cls);
ok(!wrapsInert || cls.includes("pointer-events-auto"), "and opting back into pointer events, since the canvas wraps overlays in pointer-events-none", cls);
ok(/onClick=\{\(e\) => \{[\s\S]{0,200}onPickHz\(/.test(waterfall), "the click turns into a frequency and calls the handler");

console.log("\nevery mode that says 'click the waterfall' gets a handler");
const says = panel.match(/click the waterfall to set the (centre|carrier)/g) ?? [];
ok(says.length >= 3, `the stream panel tells the operator to click (${says.length} places)`);
const handler = /onPickHz=\{([\s\S]*?)\n\s{12}\}/.exec(page)?.[1] ?? "";
for (const mode of ["RTTY", "PSK31", "OLIVIA", "JS8"]) {
  ok(handler.includes(`decodingAs === "${mode}"`), `the decodes page hands the waterfall a pick handler on ${mode}`);
}

console.log("\nthe found tags are clickable and honest");
ok(/tags\.map\([\s\S]{0,400}pointer-events-auto/.test(waterfall), "a tag opts into pointer events, as the click layer does");
ok(/stopPropagation\(\)/.test(waterfall), "and a click on a tag does not also land on the click layer beneath it");
ok(/tags=\{foundTags\}/.test(page), "the decodes page hands the waterfall its found tags");
ok(/streamStats\.snr < 4/.test(page), "an Olivia tag only appears with the synchroniser over its threshold");
ok(/!streamStats\.open/.test(page), "a PSK31 tag only with the squelch open");

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all waterfall-pick assertions passed");

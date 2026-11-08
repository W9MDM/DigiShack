/* eslint-disable no-console */
// The registered modems (lib/radio/modems.ts) end to end, through the layers that read the
// table: the pipeline decodes them, the text path sends them with or without RSID, RSID
// switches to them, and the log writes each as its ADIF mode.
// Run: npm run check:modems

import { toAdifMode } from "@/lib/adif/fields";
import { RsidDetector, rsidWaveform, type RsidHeard } from "@/lib/digital/rsid";
import { isLoggableMode, rstStyleFor, TEXT_LOG_MODES } from "@/lib/ham/modes";
import { DecodePipeline, isStreamMode } from "@/lib/radio/decode-pipeline";
import { isModemId, MODEM_IDS, modemSub, registeredModems } from "@/lib/radio/modems";
import { maxTextMs, textRsidCode, textWaveform } from "@/lib/radio/text-waveform";
import { NO_SEQUENCER_MODES } from "@/lib/radio/automation-gate";

let failed = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail: unknown = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== "" ? ` - ${String(detail)}` : ""}`);
  }
}

const RATE = 24_000;
const LINE = "CQ CQ DE KC9QRS KC9QRS K";

console.log("the table");
{
  const reg = registeredModems();
  ok(reg.length > 0, `registered: ${reg.map((m) => m.id).join(", ")}`);
  for (const id of MODEM_IDS) {
    const registered = reg.some((m) => m.id === id);
    ok(isStreamMode(id) === registered, `${id} is a stream mode ${registered ? "now that it is registered" : "only once it is registered"}`);
  }
  for (const m of reg) {
    ok(m.subs.some((s) => s.id === m.defaultSub), `${m.id}: its default (${m.defaultSub}) is one of its sizes`);
    ok(NO_SEQUENCER_MODES.has(m.id), `${m.id}: no automatic mode runs on it`);
    for (const s of m.subs) {
      ok(isLoggableMode(s.logMode) && TEXT_LOG_MODES.includes(s.logMode) && rstStyleFor(s.logMode) === "RST", `${s.label}: logs as ${s.logMode} (${JSON.stringify(toAdifMode(s.logMode))}), 599`);
    }
  }
}

for (const m of registeredModems()) {
  console.log(`\n${m.label}`);
  for (const sub of m.subs.filter((s) => s.id === m.defaultSub || s === m.subs[m.subs.length - 1])) {
    const pipe = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
    let text = "";
    const beats: { mode: string; sub?: string; chars?: number }[] = [];
    pipe.on("text", (t) => (text += t.text));
    pipe.on("stream", (b) => beats.push(b as never));
    pipe.on("error", () => {});
    pipe.setStream({ mode: m.id, centreHz: 1300, sub: sub.id });
    const w = textWaveform({ mode: m.id, text: LINE, centreHz: 1300, shiftHz: 0, sideband: "USB", sub: sub.id }, RATE);
    for (let i = 0; i < w.length; i += 480) pipe.push(w.subarray(i, Math.min(w.length, i + 480)));
    pipe.push(new Float32Array(RATE * 4));
    // Exactly the line: four seconds of digital silence after it (DAX between overs) print nothing.
    // MT63 prints a few characters of the random interleaver fill before the line, as
    // fldigi does; nothing may follow the line.
    const got = text.trim();
    ok(got.endsWith(LINE) && got.length - LINE.length <= 10, `${sub.label}: sent through the text path, decoded by the pipeline, and nothing after it (${JSON.stringify(got)})`);
    const last = beats[beats.length - 1];
    ok(last?.mode === m.id && last.sub === sub.id && (last.chars ?? 0) >= LINE.length, `  and the heartbeat names it, with the count`, JSON.stringify(last));
    ok(Math.abs((w.length / RATE) * 1000 - m.durationMs(LINE, sub.id)) < 50, `  and the line is as long as its duration says`);
  }

  // A retune keeps the decoder; a size change makes a new one.
  {
    const pipe = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
    let text = "";
    pipe.on("text", (t) => (text += t.text));
    pipe.on("error", () => {});
    pipe.setStream({ mode: m.id, centreHz: 1000, sub: m.defaultSub });
    pipe.setStream({ mode: m.id, centreHz: 1600, sub: m.defaultSub });
    const w = textWaveform({ mode: m.id, text: LINE, centreHz: 1600, shiftHz: 0, sideband: "USB", sub: m.defaultSub }, RATE);
    pipe.push(w);
    pipe.push(new Float32Array(RATE * 4));
    ok(text.includes(LINE), `a signal at the new centre decodes after the retune`);
  }

  // RSID: sent before the line, and heard as this modem at this size.
  const withCode = m.subs.find((s) => s.rsidCode !== undefined);
  if (withCode) {
    const req = { mode: m.id, text: LINE, centreHz: 1400, shiftHz: 0, sideband: "USB" as const, sub: withCode.id, rsid: true };
    ok(textRsidCode(req) === withCode.rsidCode, `${withCode.label} sends RSID ${withCode.rsidCode}`);
    ok(maxTextMs(req) > maxTextMs({ ...req, rsid: false }), `  and the cap grows to hold it`);
    const heard: RsidHeard[] = [];
    const d = new RsidDetector(RATE, (h) => heard.push(h));
    d.feed(rsidWaveform(withCode.rsidCode!, { sampleRate: RATE, centreHz: 1400 }));
    d.feed(new Float32Array(RATE));
    const h = heard[0];
    ok(h?.mode !== undefined && "sub" in h.mode && h.mode.mode === m.id && h.mode.sub === withCode.id, `  and a station hearing it is told ${m.id} ${withCode.id}`, JSON.stringify(h));
  }
  ok(isModemId(m.id) && modemSub(m, "nonsense").id === m.defaultSub, `an unknown size falls back to the default`);
}

console.log("\nPSK at every speed, and QPSK, through the same layers");
for (const [speed, qpsk] of [[31, false], [250, false], [500, false], [31, true], [63, true], [125, true]] as const) {
  const name = `${qpsk ? "QPSK" : "BPSK"}${speed}`;
  const pipe = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
  let text = "";
  pipe.on("text", (t) => (text += t.text));
  pipe.on("error", () => {});
  pipe.setStream({ mode: "PSK31", centreHz: 1500, speed, qpsk });
  const req = { mode: "PSK31" as const, text: LINE, centreHz: 1500, shiftHz: 0, sideband: "USB" as const, speed, qpsk, rsid: true };
  const w = textWaveform(req, RATE);
  for (let i = 0; i < w.length; i += 480) pipe.push(w.subarray(i, Math.min(w.length, i + 480)));
  pipe.push(new Float32Array(RATE * 2));
  ok(text.trim() === LINE, `${name}: sent with its RSID through the text path, decoded by the pipeline (${JSON.stringify(text.trim())})`);
  const code = textRsidCode(req);
  const want: Record<string, number> = { BPSK31: 1, BPSK250: 126, BPSK500: 173, QPSK31: 110, QPSK63: 3, QPSK125: 5 };
  ok(code === want[name], `  and the RSID is fldigi's ${want[name]} (${code})`);
  const heard: RsidHeard[] = [];
  const d = new RsidDetector(RATE, (h) => heard.push(h));
  d.feed(w);
  const m = heard[0]?.mode;
  ok(m?.mode === "PSK31" && "speed" in m && m.speed === speed && (m.qpsk ?? false) === qpsk, `  and a station hearing it is told ${name}`, JSON.stringify(heard[0]));
  const logMode = `${qpsk ? "QPSK" : "PSK"}${speed}`;
  const adif = toAdifMode(logMode);
  ok(isLoggableMode(logMode) && adif.mode === "PSK" && adif.submode === logMode, `  and logs as MODE=PSK SUBMODE=${logMode}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

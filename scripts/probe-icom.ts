/* eslint-disable no-console */
// Point the Icom driver at the real radio and report what happens.
//
// RECEIVE ONLY. IcomSource has no transmitter attached, so nothing here can key.
import { createIcomSource } from "@/lib/icom/from-settings";
import type { IcomSource } from "@/lib/icom/rig";
import type { SpectrumRow } from "@/lib/radio/spectrum";
import { prisma } from "@/lib/db/prisma";

async function main() {
  const source: IcomSource | null = await createIcomSource();
  if (!source) { console.log("Icom is not configured"); return; }

  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  let audioPackets = 0, audioSamples = 0, decodeWindows = 0, decodes = 0, spectrumRows = 0;
  // In an object because TypeScript does not track assignments made inside callbacks:
  // a bare `let` stays narrowed to null and the truthy branch below becomes `never`.
  const last: { row: SpectrumRow | null } = { row: null };
  const errors: string[] = [];

  source.on("identified", (i) => console.log(`[${el()}] identified: ${i.radioName} / ${i.audioName}`));
  source.on("connected", (i) => console.log(`[${el()}] CONNECTED: ${i.model} at ${i.host}`));
  source.on("disconnected", (d) => console.log(`[${el()}] disconnected: ${d.reason}`));
  source.on("error", (e) => { errors.push(e.message); console.log(`[${el()}] error: ${e.message}`); });
  source.on("audio", (a) => { audioPackets++; audioSamples += a.samples.length; });
  source.on("smeter", (m) => { if (audioPackets % 200 === 0) console.log(`[${el()}] S-meter ${m.dbm.toFixed(0)} dBm`); });
  source.on("telemetry", (t) => console.log(`[${el()}] telemetry: SWR ${t.swr?.toFixed(2) ?? "?"}`));
  source.on("spectrum", (r) => { spectrumRows++; last.row = r; });
  source.on("window", (w) => { decodeWindows++; console.log(`[${el()}] window: ${w.samples} samples rms ${w.rms.toExponential(1)}${w.skipped ? " SKIPPED" : ""}`); });
  source.on("decodes", (d) => { decodes += d.decodes.length; for (const x of d.decodes) console.log(`[${el()}]   DECODE ${x.freqOffset}Hz ${x.snr}dB  ${x.message}`); });

  try {
    await source.start();
  } catch (e) {
    console.log(`start() threw: ${e instanceof Error ? e.message : e}`);
  }

  // Optional: tune and select USB-D before listening. Receive only — nothing here
  // keys the radio, and setDataMode only changes the mode, not the PTT.
  const tuneHz = Number(process.argv[3] ?? 0);
  if (tuneHz > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await source.setFrequencyHz(tuneHz);
      await source.setDataMode();
      console.log(`[${el()}] tuned to ${(tuneHz / 1e6).toFixed(3)} MHz, USB-D`);
    } catch (e) {
      console.log(`[${el()}] tune failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const seconds = Number(process.argv[2] ?? 45);
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 4 || i === seconds - 1) {
      console.log(`[${el()}] freq=${source.getFrequencyHz() ?? "?"} connected=${source.connected} canTx=${source.canTransmit} audioPkts=${audioPackets}`);
    }
  }

  console.log(`\n--- after ${seconds}s ---`);
  console.log(`connected      ${source.connected}`);
  console.log(`radio          ${source.identity.model}`);
  console.log(`CI-V address   0x${source.address.toString(16)}`);
  console.log(`frequency      ${source.getFrequencyHz() ?? "not reported"}`);
  console.log(`audio packets  ${audioPackets} (${audioSamples} samples = ${(audioSamples/48000).toFixed(1)}s)`);
  console.log(`dropped        ${source.audioStream?.dropped ?? "?"}`);
  console.log(`windows        ${decodeWindows}, decodes ${decodes}`);
  console.log(`spectrum rows  ${spectrumRows}`);
  const row = last.row;
  if (row) {
    const b = row.bins;
    console.log(`  ${b.length} bins, ${row.binHz.toFixed(2)} Hz each, up to ${row.maxHz} Hz`);
    let peak = 0, peakAt = 0, nonZero = 0;
    for (let i = 0; i < b.length; i++) { if (b[i]! > peak) { peak = b[i]!; peakAt = i; } if (b[i]! > 8) nonZero++; }
    console.log(`  peak ${peak}/255 at ${Math.round(peakAt * row.binHz)} Hz, ${nonZero} bins above noise`);
    // A crude picture, so the shape is visible rather than merely numeric.
    const cols = 60, step = Math.floor(b.length / cols);
    let bar = "";
    for (let c = 0; c < cols; c++) {
      let m = 0;
      for (let k = 0; k < step; k++) m = Math.max(m, b[c * step + k] ?? 0);
      bar += " .:-=+*#%@"[Math.min(9, Math.floor(m / 26))];
    }
    console.log(`  0Hz |${bar}| ${row.maxHz}Hz`);
  }
  console.log(`errors         ${errors.length}${errors.length ? ": " + errors.slice(0,5).join(" | ") : ""}`);

  await source.stop();
  await prisma.$disconnect();
}
void main().catch((e) => { console.error(e); process.exit(1); });

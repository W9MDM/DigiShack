/* eslint-disable no-console */
// Point the FlexRadio panadapter at a piece of band and draw what comes back.
//
// This is the acceptance test for lib/flex/panadapter.ts against real hardware: it
// drives the real driver, reassembles real frames, and renders one so a human can
// see whether it is spectrum or nonsense. Everything the driver asserts about the
// wire — packet class, payload layout, bin ceiling, the y-pixel scale — was measured
// here first.
//
// It never keys, never tunes a slice and never changes a mode. It DOES steer a
// panadapter object, and an operator with SmartSDR open will see it move.
//
//   npx tsx scripts/probe-flex-pan.ts [centreMHz] [spanKHz] [seconds]
//
// Defaults to a VOICE segment, deliberately. A digital calling frequency is a 3 kHz
// sliver: across a 50 kHz span it is one pixel wide, so "the numbers changed when I
// retuned" is the most such a test can ever prove. An SSB segment has 2.8 kHz-wide
// carriers spread over tens of kHz — the display either shows stations where
// stations are or it does not, which is the whole question.
//
//   npx tsx scripts/probe-flex-pan.ts 7.200 100     40 m voice
//   npx tsx scripts/probe-flex-pan.ts 14.250 150    20 m voice
//   npx tsx scripts/probe-flex-pan.ts 7.074 20      40 m FT8, for comparison

import dgram from "node:dgram";
import { FlexClient } from "@/lib/flex/client";
import {
  FlexPanadapter,
  PAN_PACKET_CLASS,
  WATERFALL_PACKET_CLASS,
  type PanFrame,
} from "@/lib/flex/panadapter";
import { getSetting } from "@/lib/settings";
import { prisma } from "@/lib/db/prisma";

async function main(): Promise<void> {
  const centreMHz = Number(process.argv[2] ?? 7.2);
  const spanKHz = Number(process.argv[3] ?? 100);
  const seconds = Number(process.argv[4] ?? 6);

  const host = (await getSetting("flex.host"))?.trim();
  if (!host) {
    console.log("flex.host is not set");
    return;
  }

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let onPacket: ((b: Buffer) => void) | null = null;
  socket.on("message", (b) => onPacket?.(b));
  const udpPort = await new Promise<number>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "0.0.0.0", () => resolve((socket.address() as { port: number }).port));
  });

  const client = new FlexClient(host, 4992);
  await client.connect();

  const pans = new Map<string, Record<string, string>>();
  client.on("status", (s) => {
    if (s.object === "display pan" && s.id) {
      pans.set(s.id, { ...(pans.get(s.id) ?? {}), ...s.fields });
    }
  });

  // Registering as a GUI client is itself what produces a panadapter — the radio
  // restores this client's profile and one comes with it.
  await client.command("client gui");
  await client.command("client station DigiShackPanProbe").catch(() => {});
  const reg = await client.command(`client udpport ${udpPort}`);
  if (reg.status !== 0) throw new Error(`client udpport refused (0x${reg.status.toString(16)})`);
  await client.readInfo();
  await client.command("sub pan all");
  await new Promise((r) => setTimeout(r, 2_000));

  console.log(`${client.state.model} ${client.state.softwareVersion} at ${host}`);
  console.log(`panadapters on the radio: ${pans.size} (ours is the one owned by 0x${client.state.handle})`);

  const pan = new FlexPanadapter(client, { bins: 4096, fps: 15, spanHz: spanKHz * 1_000 });
  pan.on("error", (e) => console.log(`  pan error: ${e.message}`));

  await pan.start(Math.round(centreMHz * 1e6), pans);
  console.log(`using pan ${pan.objectId}`);

  let latest: PanFrame | null = null;
  let frames = 0;
  let panBytes = 0;
  let waterfallBytes = 0;
  onPacket = (buf) => {
    if (buf.length <= 28) return;
    const cls = buf.readUInt16BE(14);
    if (cls === WATERFALL_PACKET_CLASS) {
      waterfallBytes += buf.length;
      return;
    }
    if (cls !== PAN_PACKET_CLASS) return;
    panBytes += buf.length;
    pan.onPacket(buf);
  };
  pan.on("frame", (f) => {
    frames++;
    latest = f;
  });

  // Let it settle before measuring — the first frames after a retune are drawn while
  // the radio is still moving.
  await new Promise((r) => setTimeout(r, 1_500));
  frames = 0;
  panBytes = 0;
  waterfallBytes = 0;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1_000));
  const elapsed = (Date.now() - t0) / 1000;
  onPacket = null;

  const counts = pan.frameCounts;
  console.log(
    `\n${frames} whole frames in ${elapsed.toFixed(1)} s = ${(frames / elapsed).toFixed(1)} fps` +
      `  |  ${counts.incomplete} frames dropped with bins missing` +
      `  |  ${(panBytes / elapsed / 1024).toFixed(1)} kB/s FFT` +
      ` + ${(waterfallBytes / elapsed / 1024).toFixed(1)} kB/s of the radio's own waterfall we ignore`,
  );

  if (!latest) {
    console.log("FAIL: no complete frame arrived");
  } else {
    render(latest);
  }

  await pan.stop();
  client.disconnect();
  try {
    socket.close();
  } catch {
    /* already closed */
  }
  await prisma.$disconnect();
}

/**
 * Draw one frame as text.
 *
 * Peak per column, not average — the same reduction `Waterfall.tsx` makes and for the
 * same reason: a carrier narrower than a column must stay visible rather than being
 * averaged into the noise. Averaging here would hide exactly the signals the display
 * exists to find.
 */
function render(f: PanFrame): void {
  const toDbm = (v: number): number => f.minDbm + (v / f.yPixels) * (f.maxDbm - f.minDbm);
  const lowHz = f.centerHz - f.spanHz / 2;
  const binHz = f.spanHz / f.bins.length;

  const sorted = Float64Array.from(f.bins).sort();
  const floor = sorted[Math.floor(sorted.length * 0.25)]!;
  const peak = sorted[sorted.length - 1]!;

  console.log(`\n  ======================= ONE FFT FRAME =======================`);
  console.log(`  centre        ${(f.centerHz / 1e6).toFixed(6)} MHz`);
  console.log(`  span          ${(f.spanHz / 1e3).toFixed(1)} kHz`);
  console.log(
    `  edges         ${(lowHz / 1e6).toFixed(6)} — ${((lowHz + f.spanHz) / 1e6).toFixed(6)} MHz`,
  );
  console.log(`  bins          ${f.bins.length}`);
  console.log(`  resolution    ${binHz.toFixed(1)} Hz per bin`);
  console.log(
    `  levels        raw ${sorted[0]} … ${peak} of ${f.yPixels}` +
      `  =>  ${toDbm(sorted[0]!).toFixed(1)} … ${toDbm(peak).toFixed(1)} dBm (uncalibrated)`,
  );
  console.log(`  noise floor   ${toDbm(floor).toFixed(1)} dBm, peak is ${((peak - floor) / f.yPixels * (f.maxDbm - f.minDbm)).toFixed(1)} dB above it`);

  // Peak-per-column into a fixed width, then a vertical bar chart.
  const width = 100;
  const cols = new Float64Array(width);
  const per = f.bins.length / width;
  for (let c = 0; c < width; c++) {
    let m = 0;
    for (let i = Math.floor(c * per); i < Math.floor((c + 1) * per) && i < f.bins.length; i++) {
      if (f.bins[i]! > m) m = f.bins[i]!;
    }
    cols[c] = m;
  }

  const height = 14;
  const top = peak + (peak - floor) * 0.1;
  const bottom = floor - (peak - floor) * 0.1;
  const rows: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    const level = bottom + ((top - bottom) * r) / (height - 1);
    let line = "";
    for (let c = 0; c < width; c++) line += cols[c]! >= level ? "█" : " ";
    rows.push(`  ${toDbm(level).toFixed(0).padStart(5)} |${line}`);
  }
  console.log("");
  for (const r of rows) console.log(r);

  // Frequency axis.
  let axis = "        +";
  for (let c = 0; c < width; c++) axis += c % 10 === 0 ? "+" : "-";
  console.log(axis);
  let labels = "         ";
  for (let c = 0; c < width; c += 20) {
    const hz = lowHz + (c + 0.5) * per * binHz;
    labels += (hz / 1e6).toFixed(3).padEnd(20);
  }
  console.log(labels);

  // Name the strongest few, spaced apart so one wide signal is not listed six times.
  const order = [...f.bins.keys()].sort((a, b) => f.bins[b]! - f.bins[a]!);
  const picked: number[] = [];
  const minSeparationHz = 2_000;
  for (const i of order) {
    if (picked.length >= 8) break;
    if (picked.some((p) => Math.abs(p - i) * binHz < minSeparationHz)) continue;
    if (f.bins[i]! - floor < (peak - floor) * 0.25) break;
    picked.push(i);
  }
  if (picked.length > 0) {
    console.log(`\n  strongest signals, ${minSeparationHz / 1000} kHz apart or more:`);
    for (const i of picked.sort((a, b) => a - b)) {
      const hz = lowHz + (i + 0.5) * binHz;
      console.log(
        `    ${(hz / 1e6).toFixed(4)} MHz   ${toDbm(f.bins[i]!).toFixed(1)} dBm` +
          `   ${(((f.bins[i]! - floor) / f.yPixels) * (f.maxDbm - f.minDbm)).toFixed(1)} dB above the floor`,
      );
    }
  }
  console.log(`  =============================================================`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

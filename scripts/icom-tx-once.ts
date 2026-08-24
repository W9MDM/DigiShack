/* eslint-disable no-console */
// ONE transmission from the Icom, deliberately.
//
// THIS PUTS RF ON THE AIR. It exists because the transmit path had never been proved
// against real hardware, and wiring the automatic operating modes on top of an unproven
// transmitter would mean debugging two things at once.
//
// Everything about it is deliberate and bounded:
//
//   * One message, one window. No loop, no auto mode, no retry.
//   * RF power is set explicitly over CI-V first, and reported.
//   * USB-D is selected before keying — in plain USB the audio comes from the
//     microphone and the radio keys into silence.
//   * The transmitter's own watchdog unkeys unconditionally if the send loop dies.
//   * It refuses to run unless transmit is armed in Settings.
//
// Usage: tsx scripts/icom-tx-once.ts [powerPercent] [freqHz] [message]

import { decodeBcd2, MeterSub, readMeter, setRfPower } from "@/lib/icom/civ";
import { createIcomSource } from "@/lib/icom/from-settings";
import { IcomTransmitter } from "@/lib/icom/transmitter";
import { prisma } from "@/lib/db/prisma";
import { nextWindowStart } from "@/lib/radio/timing";
import { getBooleanSetting } from "@/lib/settings";
import { isTransmitArmed, transmitGate } from "@/lib/radio/transmit-gate";

async function main(): Promise<void> {
  const powerPct = Number(process.argv[2] ?? 10);
  const freqHz = Number(process.argv[3] ?? 14_074_000);

  const station = await prisma.station.findFirst({ select: { callsign: true, grid: true } });
  if (!station) {
    console.error("No station configured — nothing to identify as.");
    process.exit(1);
  }
  const message =
    process.argv[4] ?? `CQ ${station.callsign} ${station.grid.slice(0, 4).toUpperCase()}`;

  if (!(await isTransmitArmed("icom"))) {
    console.error("Transmit is disabled in Settings. Not keying.");
    process.exit(1);
  }

  const source = await createIcomSource();
  if (!source) {
    console.error("Icom is not configured.");
    process.exit(1);
  }
  source.on("error", (e) => console.error("  source error:", e.message));

  console.log(`connecting to ${source.identity.host} ...`);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("did not connect in 20s")), 20_000);
    source.on("connected", () => {
      clearTimeout(t);
      resolve();
    });
    void source.start();
  });

  const serial = source.serialStream;
  const audio = source.audioStream;
  if (!serial || !audio) {
    console.error("CI-V or audio stream is not open — refusing to key.");
    await source.stop();
    process.exit(1);
  }
  console.log(`connected: ${source.identity.model}, CI-V 0x${source.address.toString(16)}`);

  // Power first, and say so. A first test at whatever the front panel happened to be
  // set to is how a 50%-duty mode meets a 100 W amplifier.
  serial.write(setRfPower(source.address, powerPct));
  console.log(`RF power set to ${powerPct}%`);

  await source.setFrequencyHz(freqHz);
  await source.setDataMode();
  console.log(`tuned ${(freqHz / 1e6).toFixed(3)} MHz, USB-D`);
  // Wait for the radio to CONFIRM the new frequency rather than sleeping a fixed
  // 1.5 s. The CI-V poll runs every two seconds, so a shorter wait prints the
  // pre-tune value and makes it look as though the tune was ignored.
  for (let i = 0; i < 20 && source.getFrequencyHz() !== freqHz; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const confirmed = source.getFrequencyHz();
  console.log(`radio confirms ${confirmed} Hz${confirmed === freqHz ? "" : "  <-- NOT the requested frequency"}`);

  const tx = new IcomTransmitter({
    serial,
    audio,
    address: source.address,
    identity: source.identity,
    allowTransmit: true,
    isTransmitAllowed: transmitGate("icom"),
  });

  // Next FT8 boundary at least two seconds out, so there is time to build the
  // waveform and so we are not keying into the tail of the current window.
  const startAt = nextWindowStart("FT8", Date.now() + 2_000);
  const wait = ((startAt - Date.now()) / 1000).toFixed(1);
  console.log(`\nTRANSMITTING "${message}" at 1500 Hz in ${wait}s ...`);

  // Poll the power and SWR meters WHILE transmitting.
  //
  // "The radio accepted PTT and took 12.64 s of audio" is not the same claim as "RF
  // left the antenna socket". Only the Po meter can tell them apart, and if the answer
  // is zero then the fault is in the radio's setup rather than anywhere in this code.
  const po: number[] = [];
  const swr: number[] = [];
  serial.on("frame", (f) => {
    if (f.command !== 0x15) return;
    const v = decodeBcd2(f.data.subarray(1));
    if (v === null) return;
    if (f.sub === MeterSub.power) po.push(v);
    if (f.sub === MeterSub.swr) swr.push(v);
  });
  const meterTimer = setInterval(() => {
    try {
      serial.write(readMeter(source.address, MeterSub.power));
      serial.write(readMeter(source.address, MeterSub.swr));
    } catch {
      /* stream closed */
    }
  }, 400);

  const r = await tx.transmit({ message, mode: "FT8", offsetHz: 1500, startAt });
  clearInterval(meterTimer);

  console.log(`\nsent:          ${r.sent}`);
  if (r.reason) console.log(`reason:        ${r.reason}`);
  if (r.timingErrorMs !== undefined) console.log(`timing error:  ${r.timingErrorMs} ms`);
  if (r.packetsSent !== undefined) console.log(`packets:       ${r.packetsSent}`);
  console.log(`still keyed:   ${tx.transmitting}`);

  const peakPo = po.length ? Math.max(...po) : 0;
  const peakSwr = swr.length ? Math.max(...swr) : 0;
  console.log(`\nPo meter:      peak ${peakPo}/255 over ${po.length} reads`);
  console.log(`SWR meter:     peak ${peakSwr}/255 over ${swr.length} reads`);
  if (peakPo === 0) {
    console.log(
      [
        "",
        "  >> The radio reported ZERO forward power for the whole transmission.",
        "     PTT and the audio path are working, so this is the radio's own setup:",
        "     check the data-mode input source (USB vs ACC), the USB MOD level, and",
        "     that an antenna is connected.",
      ].join("\n"),
    );
  } else {
    console.log("\n  >> RF confirmed: the radio produced forward power while keyed.");
  }

  await tx.unkey();
  await source.stop();
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

/* eslint-disable no-console */
// Transmit exactly one FT8/FT4 message, then stop.
//
// Deliberately a one-shot with no loop and no automatic repeat: the first live
// transmissions from new code should be individually chosen, not scheduled. `--yes`
// is required, so nothing here can key a radio by accident.
//
//   npx tsx scripts/tx-once.ts --host 192.0.2.10 --message "CQ K9XYZ EN61" --yes
//
// Without --yes it runs the whole preflight and prints what it *would* do, which is
// the recommended way to look before keying.

import { FlexDaxTransmitter, nextWindowStart, transmitDurationMs } from "@/lib/flex/tx";
import { DIGITAL_FREQUENCIES } from "@/lib/ham/digital-freqs";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = arg("host", "192.0.2.10")!;
const mode = (arg("mode", "FT8")!.toUpperCase() === "FT4" ? "FT4" : "FT8") as "FT8" | "FT4";
const offsetHz = Number(arg("offset", "1500"));
const message = arg("message", "CQ K9XYZ EN61")!;
const armed = process.argv.includes("--yes");

async function main(): Promise<void> {
  console.log(`\nDigiShack one-shot transmit`);
  console.log(`  radio     ${host}`);
  console.log(`  message   "${message}"`);
  console.log(`  mode      ${mode} (${(transmitDurationMs(mode) / 1000).toFixed(2)}s on air)`);
  console.log(`  offset    ${offsetHz} Hz`);
  console.log(`  armed     ${armed ? "YES — this will key the transmitter" : "no (dry run, --yes to arm)"}\n`);

  const freqHz =
  DIGITAL_FREQUENCIES.find((f) => f.mode === mode && f.band === (arg("band", "40M") ?? "40M").toUpperCase())?.hz ?? 7_074_000;

const tx = new FlexDaxTransmitter({ host, allowTransmit: armed, daxChannel: 1, freqHz });

  try {
    await tx.start();
    console.log("DAX TX stream open, routed, udpport registered");

    const pf = await tx.preflight();
    console.log("\npreflight (the radio's own view):");
    console.log(`  frequency        ${pf.freqMhz} MHz`);
    console.log(`  TX slice mode    ${pf.txSliceMode}`);
    console.log(`  TX filter high   ${pf.filterHiHz} Hz`);
    console.log(`  RF power         ${pf.rfPower}%`);
    console.log(`  DAX as source    ${pf.daxEnabled ? "yes" : "NO"}`);
    console.log(`  inhibit          ${pf.inhibit ? "SET" : "clear"}`);
    console.log(`  tx allowed       ${pf.txAllowed ? "yes" : "NO"}`);
    console.log(`  interlock        ${pf.interlockState}`);

    // A signal outside the transmit filter is clipped rather than radiated.
    if (pf.filterHiHz !== null && offsetHz > pf.filterHiHz) {
      pf.blockers.push(`Offset ${offsetHz} Hz is above the TX filter (${pf.filterHiHz} Hz)`);
    }

    // The dial must sit on a known FT8/FT4 calling frequency. This exists because
    // of a real incident: registering as a GUI client made the radio restore its
    // default profile — a slice at 14.100 USB at 100 % power — and a CQ went out
    // there before anything checked. Frequency is a hard blocker, overridable only
    // with an explicit --anywhere.
    if (pf.freqMhz !== null) {
      const dialHz = Math.round(Number(pf.freqMhz) * 1_000_000);
      const listed = DIGITAL_FREQUENCIES.some(
        (f) => f.mode === mode && Math.abs(f.hz - dialHz) < 500,
      );
      if (!listed && !process.argv.includes("--anywhere")) {
        pf.blockers.push(
          `${pf.freqMhz} MHz is not a listed ${mode} calling frequency (pass --anywhere to override)`,
        );
      }
    }

    for (const w of pf.warnings) console.log(`  warning          ${w}`);
    for (const b of pf.blockers) console.log(`  BLOCKER          ${b}`);

    if (pf.blockers.length > 0) {
      console.log("\nRefusing to transmit — resolve the blockers above.\n");
      return;
    }

    // Generated up front. If this fails, we have not keyed.
    const wave = tx.buildWaveform(message, mode, offsetHz);
    console.log(`\nwaveform ready: ${wave.length} samples, ${(wave.length / 24000).toFixed(3)}s`);

    // Leave enough lead time to finish setup before the boundary, rather than
    // racing it and starting late.
    const period = mode === "FT4" ? 7_500 : 15_000;
    let startAt = nextWindowStart(mode, Date.now() + 2_000);
    if (startAt - Date.now() < 1_500) startAt += period;

    const waitS = ((startAt - Date.now()) / 1000).toFixed(1);
    console.log(`window starts at ${new Date(startAt).toISOString()} (in ${waitS}s)`);

    if (!armed) {
      console.log("\nDry run — not arming. Re-run with --yes to transmit.\n");
      return;
    }

    console.log("keying at the boundary…");
    const result = await tx.transmit({ message, mode, offsetHz, startAt });

    if (result.sent) {
      console.log(`\nTRANSMITTED`);
      console.log(`  keyed at        ${new Date(result.keyedAt!).toISOString()}`);
      console.log(`  unkeyed at      ${new Date(result.unkeyedAt!).toISOString()}`);
      console.log(`  timing error    ${result.timingErrorMs}ms vs the window boundary`);
      console.log(`  on air for      ${((result.unkeyedAt! - result.keyedAt!) / 1000).toFixed(3)}s`);
      console.log(`  packets sent    ${result.packetsSent}`);
      console.log(`  still keyed     ${tx.isKeyed} (must be false)`);
    } else {
      console.log(`\nNOT SENT — ${result.reason}`);
    }
  } catch (err) {
    console.log(`\nERROR ${(err as Error).message}`);
  } finally {
    // Unkeys, then removes the stream, whatever happened above.
    await tx.stop();
    console.log("stopped: unkeyed, stream removed\n");
  }
}

void main();

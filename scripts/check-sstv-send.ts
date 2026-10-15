/* eslint-disable no-console */
// SSTV sending's safety: where each licence class may send an image mode, and the
// transmitter's refusals - transmit off, nothing started, over the cap - none of which
// may key a radio. Plus the picture as audio: the right length, and readable.
// Run: npm run check:sstv-send
import { SstvDecoder, sstvImageSeconds, sstvModeByName, sstvTestCard, sstvWaveform } from "@/lib/digital/sstv";
import { FlexDaxTransmitter } from "@/lib/flex/tx";
import { parseLicenceClass, sstvTransmitRefusal } from "@/lib/radio/sstv-licence";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

async function main(): Promise<void> {
  console.log("where an image mode may go, by licence class");
  const may = (cls: string | null, hz: number, sb: "USB" | "LSB") => sstvTransmitRefusal(parseLicenceClass(cls), hz, sb) === null;
  ok(!may(null, 14_230_000, "USB"), "no class set: refused, with the reason");
  ok(/Set your licence class/.test(sstvTransmitRefusal(null, 14_230_000, "USB") ?? ""), "and the reason says what to do");
  ok(may("us-general", 14_230_000, "USB"), "a General may send on 14.230");
  ok(!may("us-general", 7_171_000, "LSB"), "but not on 7.171, below General's 7.175 phone edge");
  ok(may("us-advanced", 7_171_000, "LSB") && may("us-extra", 7_171_000, "LSB"), "where Advanced and Extra may");
  ok(may("us-general", 3_845_000, "LSB"), "a General may send on 3.845");
  ok(may("us-general", 21_340_000, "USB") && may("us-general", 28_680_000, "USB"), "and on 21.340 and 28.680");
  ok(!may("us-technician", 14_230_000, "USB"), "a Technician may not on 14.230");
  ok(!may("us-technician", 28_680_000, "USB"), "nor 28.680, above the Technician's 28.300-28.500");
  ok(may("us-technician", 28_400_000, "USB"), "but may inside it");
  ok(!may("us-general", 14_223_500, "USB") && may("us-general", 14_224_000, "USB"), "the whole occupied width counts, not the dial: 14.2235 USB straddles the 14.225 edge, 14.224 does not");
  ok(may("other", 7_100_000, "LSB"), "a licence outside the US: its own rules, not checked here");
  ok(parseLicenceClass("nonsense") === null, "an unknown class reads as unset");

  console.log("\nthe transmitter refuses without keying");
  const card = sstvTestCard(320, 256);
  const m1 = sstvModeByName("Martin 1")!;
  const build = (rate: number) => sstvWaveform(m1, card, { sampleRate: rate, leadMs: 300 });
  const off = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: false });
  const r1 = await off.transmitAudio(build, "SSTV Martin 1", "SSTV", 5 * 60_000);
  ok(!r1.sent && /disabled/i.test(r1.reason ?? ""), "transmit off: refused", r1.reason);
  const on = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: true });
  const r2 = await on.transmitAudio(build, "SSTV Martin 1", "SSTV", 5 * 60_000);
  ok(!r2.sent && /not started/i.test(r2.reason ?? ""), "nothing started: refused", r2.reason);
  const r3 = await on.transmitAudio(build, "SSTV Martin 1", "SSTV", 60_000);
  ok(!r3.sent && /over the 60 s cap/.test(r3.reason ?? ""), "a picture longer than the cap: refused before the gate", r3.reason);
  const r4 = await on.transmitAudio(() => {
    throw new Error("no picture");
  }, "SSTV", "SSTV", 60_000);
  ok(!r4.sent && r4.reason === "no picture", "a picture that cannot be built: refused, nothing keyed");
  ok(!on.isKeyed && !on.isBusy, "and the transmitter is neither keyed nor busy after any of it");

  console.log("\nthe picture as it goes out");
  const wave = build(24_000);
  ok(Math.abs(wave.length / 24_000 - (sstvImageSeconds(m1) + 0.6 + 0.94)) < 0.5, `Martin 1 is about ${(sstvImageSeconds(m1) + 1.5).toFixed(0)} s of audio, header and lead included (${(wave.length / 24_000).toFixed(1)} s)`);
  let got: string | null = null;
  const d = new SstvDecoder(24_000, { onImage: (_i, m) => (got = m.name) });
  for (let i = 0; i < wave.length; i += 256) d.feed(wave.subarray(i, i + 256));
  d.feed(new Float32Array(48_000));
  ok(got === "Martin 1", "and what goes out reads back as a Martin 1 picture", got);

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all SSTV send assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

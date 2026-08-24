/*
 * List every slice the radio has open.
 *
 * Written because the bridge reported the dial at 7.200 MHz LSB while the panadapter
 * sat at 7.074 and FT8 decodes kept arriving — three facts that cannot all describe
 * one slice. If there are two, the panadapter was right all along and the DIAL readout
 * is the thing pointing at the wrong one.
 */
import { FlexClient } from "@/lib/flex/client";
import { getSetting } from "@/lib/settings";

async function main(): Promise<void> {
  const host = process.env.FLEX_HOST ?? (await getSetting("flex.host")) ?? "192.0.2.10";

  const c = new FlexClient(String(host));
  await c.connect();
  await c.subscribe("slice all");
  await c.subscribe("tx all");
  await new Promise((r) => setTimeout(r, 1_500));

  console.log(`${c.state.slices.size} slice(s) on ${String(host)}:`);
  for (const s of c.state.slices.values()) {
    console.log(
      `  slice ${s.index}: ${s.freqHz !== null ? (s.freqHz / 1e6).toFixed(6) : "?"} MHz` +
        `  mode=${s.mode}  tx=${s.tx}  active=${s.active}  dax=${s.raw.dax ?? "-"}`,
    );
  }
  const a = c.activeSlice();
  console.log(`activeSlice() picks slice ${a?.index} — this is what the dial readout shows`);
  process.exit(0);
}

void main();

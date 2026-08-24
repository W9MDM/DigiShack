/*
 * Does the panadapter follow the dial?
 *
 * Reported as "top waterfall doesn't update when freq changes". The retune listener
 * exists in lib/flex/dax.ts and looks correct on inspection, which is exactly the
 * situation where reading harder is a waste of time — the Icom driver had four bugs
 * that were invisible on the page and obvious on the wire.
 *
 * Reads the bridge's own panadapter broadcasts. Does not command the radio: run it,
 * change band from the UI, and watch what centerHz does.
 */
import WebSocket from "ws";

const url = process.env.BRIDGE_WS ?? "ws://127.0.0.1:8787";
const ws = new WebSocket(url);

let lastCenter = 0;
let frames = 0;

ws.on("open", () => {
  console.log(`watching ${url} — change band in the UI now; Ctrl-C to stop`);
  // Frame RATE, not just centre changes. The first version only logged when centerHz
  // moved, so a DEAD stream and a correctly-parked one looked identical: one frame at
  // connect (the bridge replays its last panadapter message to every new client) and
  // then silence.
  setInterval(() => {
    console.log(`  ${frames} frame(s) in the last 5 s, centre ${(lastCenter / 1e6).toFixed(6)} MHz`);
    frames = 0;
  }, 5_000);
});

ws.on("message", (data) => {
  let msg: { kind?: string; centerHz?: number; spanHz?: number; at?: number };
  try {
    msg = JSON.parse(String(data));
  } catch {
    return;
  }
  if (msg.kind !== "panadapter") return;
  frames++;
  const c = msg.centerHz ?? 0;
  if (c !== lastCenter) {
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] centre -> ${(c / 1e6).toFixed(6)} MHz` +
        ` span ${((msg.spanHz ?? 0) / 1000).toFixed(1)} kHz  (after ${frames} frames)`,
    );
    lastCenter = c;
  }
});

ws.on("error", (e) => {
  console.error("socket error:", e.message);
  process.exit(1);
});

/* eslint-disable no-console */
// The web tier's wait on the radio service, and the token the service checks.
//
// 1. pages/api/bridge/control.ts gave EVERY action five seconds. An Icom ATU tune waits up
//    to 20 s for the match, a source switch up to 20 s for the Icom's streams, and the
//    operator was told "the radio service is not answering" while the radio was busy doing
//    what it was asked. Slow actions now get their own wait, and a wait that runs out says
//    the action is still running rather than blaming a dead service.
// 2. The bridge compared X-Bridge-Token with `!==`, which returns sooner the earlier the
//    first wrong character. It now uses the constant-time compare the WebSocket gate uses.
//
// Loopback only: one local server that never answers, and one closed local port.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  controlTimeoutMessage,
  controlTimeoutMs,
  isTimeoutError,
} from "../lib/bridge/control-timeout";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** A number literal like `20_000` out of `source`, by the regex's first group. */
function msFrom(source: string, re: RegExp, what: string): number {
  const m = re.exec(source);
  if (!m?.[1]) throw new Error(`could not find ${what}`);
  return Number(m[1].replace(/_/g, ""));
}

async function main(): Promise<void> {
  console.log("\nper-action waits");
  {
    eq(controlTimeoutMs("call"), DEFAULT_CONTROL_TIMEOUT_MS, "a QSO call keeps the ordinary wait");
    eq(controlTimeoutMs("power"), DEFAULT_CONTROL_TIMEOUT_MS, "so does power");
    eq(controlTimeoutMs("restart"), DEFAULT_CONTROL_TIMEOUT_MS, "restart answers before it exits, so it needs no more");
    eq(controlTimeoutMs("rig", { freqHz: 14_074_000 }), DEFAULT_CONTROL_TIMEOUT_MS, "a plain CAT change keeps it too");
    eq(DEFAULT_CONTROL_TIMEOUT_MS, 5_000, "and the ordinary wait is still five seconds");

    // The bridge's own worst cases, read from the code that has them, so a longer wait
    // there cannot quietly outgrow the proxy's again.
    const atuMs = msFrom(read("lib/icom/rig.ts"), /async tuneAtu\(timeoutMs = ([\d_]+)\)/, "tuneAtu's timeout");
    const streamsMs = msFrom(
      read("services/radio/icom-source.ts"),
      /did not finish opening its streams within \d+s"\)\),\s*([\d_]+)/,
      "the Icom stream wait",
    );
    const ffmpegMs = msFrom(read("lib/stream/youtube.ts"), /start encoding within \d+ seconds"\)\)\),\s*([\d_]+)/, "ffmpeg's start wait");
    const sntpMs = msFrom(read("lib/time/sntp.ts"), /opts\.timeoutMs \?\? ([\d_]+)/, "the SNTP exchange timeout");
    const flexMs = msFrom(read("lib/flex/client.ts"), /command\(cmd: string, timeoutMs = ([\d_]+)\)/, "the FlexRadio command timeout");

    ok(controlTimeoutMs("atu") > atuMs, `atu outlasts the Icom tuner's ${atuMs} ms`, `${controlTimeoutMs("atu")}`);
    ok(controlTimeoutMs("rig", { tune: true }) > atuMs, "and so does the CAT panel's Tune, which runs the same cycle");
    ok(controlTimeoutMs("source") > streamsMs, `source outlasts the Icom's ${streamsMs} ms stream wait`);
    ok(controlTimeoutMs("ft0") > streamsMs, "ft0 release reconnects the same way");
    ok(controlTimeoutMs("stream") > ffmpegMs, `stream outlasts ffmpeg's ${ffmpegMs} ms`);
    ok(controlTimeoutMs("time/sync") > 4 * sntpMs, `time/sync outlasts four ${sntpMs} ms SNTP exchanges`);
    ok(controlTimeoutMs("tune") > flexMs, `tune outlasts one ${flexMs} ms FlexRadio command`);
    ok(controlTimeoutMs("voice") > flexMs, "voice too");

    // The browser gives up at its own deadline. A proxy wait past it would mean the
    // operator sees a bare network timeout instead of this tier's explanation.
    const browserMs = msFrom(read("lib/client/api.ts"), /AbortSignal\.timeout\(([\d_]+)\)/, "the browser deadline");
    for (const a of ["atu", "source", "ft0", "stream", "time/sync", "tune", "voice"]) {
      ok(controlTimeoutMs(a) < browserMs, `${a} stays under the browser's ${browserMs} ms`);
    }
    ok(controlTimeoutMs("rig", { tune: true }) < browserMs, "rig tune too");
  }

  console.log("\nthe proxy uses them");
  {
    const src = read("pages/api/bridge/control.ts");
    ok(/AbortSignal\.timeout\(timeoutMs\)/.test(src), "control.ts waits controlTimeoutMs(), not a literal");
    ok(!/AbortSignal\.timeout\(\s*[\d_]+\s*\)/.test(src), "no fixed timeout left in it");
    ok(/isTimeoutError\(err\)/.test(src) && /controlTimeoutMessage\(/.test(src), "a timeout gets its own answer");
  }

  console.log("\na wait that runs out is told apart from a dead service");
  {
    // A server that accepts and never answers: what a bridge mid-ATU-cycle looks like.
    const silent: Server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const silentPort = (silent.address() as AddressInfo).port;
    let timedOut: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${silentPort}/atu`, { method: "POST", signal: AbortSignal.timeout(150) });
    } catch (err) {
      timedOut = err;
    }
    silent.closeAllConnections();
    await new Promise<void>((r) => silent.close(() => r()));
    ok(timedOut !== null && isTimeoutError(timedOut), "fetch's own timeout error is recognised", String(timedOut));

    // A port nobody listens on: what a stopped bridge looks like.
    const closed: Server = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    let refused: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${closedPort}/atu`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    } catch (err) {
      refused = err;
    }
    ok(refused !== null && !isTimeoutError(refused), "a refused connection is not mistaken for one", String(refused));

    const msg = controlTimeoutMessage("atu", 25_000);
    ok(/still running/i.test(msg) && /Rig page/.test(msg), "the answer says it is still running and where to look", msg);
    ok(!/not answering/i.test(msg), "and does not say the service is not answering");
    ok(/25 seconds/.test(msg), "and how long it waited");
  }

  console.log("\nthe bridge token is compared in constant time");
  {
    const { tokensEqual } = await import("../lib/bridge/ws-auth");
    const token = "a".repeat(64);
    ok(tokensEqual(token, token), "the right token matches");
    ok(!tokensEqual(`b${token.slice(1)}`, token), "a wrong first character does not");
    ok(!tokensEqual(`${token.slice(0, -1)}b`, token), "nor a wrong last one");
    ok(!tokensEqual(token.slice(0, 32), token), "a shorter token does not (and does not throw)");
    ok(!tokensEqual(`${token}a`, token), "nor a longer one");
    ok(!tokensEqual("", token), "nor an empty header");

    const bridge = read("services/radio/index.ts");
    ok(!/!==\s*token\b|\btoken\s*!==|===\s*token\b/.test(bridge), "services/radio/index.ts compares no token with !== or ===");
    ok((bridge.match(/tokensEqual\(/g) ?? []).length >= 2, "both X-Bridge-Token checks use tokensEqual");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

function eq(a: unknown, b: unknown, label: string): void {
  ok(Object.is(a, b), label, `got ${String(a)}, want ${String(b)}`);
}

main().then(
  () => process.exit(fail > 0 ? 1 : 0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

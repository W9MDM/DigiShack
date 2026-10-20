/* eslint-disable no-console */
// One FlexRadio greeting is one `connected` event, and a failed connect leaves nothing behind.
// Run: npx tsx scripts/check-flex-greeting.ts
//
// THE FAULT (code review R19). The greeting handler emitted `connected`, and connect()'s own
// once-listener for that event emitted it AGAIN, so anything listening heard every greeting
// twice — the first time while `state.connected` was still false. Startup happens to attach
// its listeners after `await connect()`, which masked it. A failed attempt (timeout, refused)
// also left that once-listener registered, so the next successful connect fired the stale
// one as well: three events for one greeting.
//
// No radio: a TCP server on loopback speaks the two greeting lines SmartSDR sends.

import net from "node:net";

import { FlexClient } from "../lib/flex/client";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/**
 * A loopback server. `greet` decides, per connection (numbered from 0), whether it speaks the
 * greeting or just holds the line open the way a radio mid-reboot does.
 */
async function fakeRadio(
  greet: boolean | ((connection: number) => boolean),
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const n = connections++;
    if (typeof greet === "function" ? greet(n) : greet) socket.write("V1.4.0.0\nH1234ABCD\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port with nothing listening on it: a server opened and closed again. */
async function deadPort(): Promise<number> {
  const s = await fakeRadio(false);
  await s.close();
  return s.port;
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("1. one greeting, one connected");
  {
    const radio = await fakeRadio(true);
    const client = new FlexClient("127.0.0.1", radio.port);
    const seen: boolean[] = [];
    // Attached BEFORE connect(), which is what startup's ordering happened to avoid.
    client.on("connected", () => seen.push(client.state.connected));
    await client.connect(2_000);
    await tick(50); // anything late would have arrived by now
    check("exactly one event", seen.length === 1, seen);
    check("and state.connected was already true when it fired", seen.every(Boolean), seen);
    check("the handle was read", client.state.handle === "1234ABCD", client.state.handle);
    check("no readiness listener is left behind", client.listenerCount("connected") === 1, client.listenerCount("connected"));
    client.disconnect();
    await radio.close();
  }

  console.log("");
  console.log("2. a connect that times out leaves no listener behind");
  {
    const silent = await fakeRadio(false);
    const client = new FlexClient("127.0.0.1", silent.port);
    const before = client.listenerCount("connected");
    let rejected = false;
    await client.connect(150).catch(() => (rejected = true));
    check("the attempt is rejected", rejected);
    check("and its readiness listener is removed", client.listenerCount("connected") === before, client.listenerCount("connected"));
    await silent.close();
  }

  console.log("");
  console.log("3. a refused connect leaves no listener behind");
  {
    const client = new FlexClient("127.0.0.1", await deadPort());
    const before = client.listenerCount("connected");
    let rejected = false;
    await client.connect(2_000).catch(() => (rejected = true));
    check("the attempt is rejected", rejected);
    check("and its readiness listener is removed", client.listenerCount("connected") === before, client.listenerCount("connected"));
  }

  console.log("");
  console.log("4. reconnecting after failures: still one event per greeting");
  {
    // Silent for the first two connections, as a radio still booting is; greets the third.
    const radio = await fakeRadio((n) => n >= 2);
    // One client object across attempts, the way a retry loop would hold it.
    const client = new FlexClient("127.0.0.1", radio.port);
    let events = 0;
    client.on("connected", () => events++);
    await client.connect(150).catch(() => {});
    await client.connect(150).catch(() => {});
    await client.connect(2_000);
    await tick(50);
    check(`one event after two failed attempts (got ${events})`, events === 1, events);
    check("and no readiness listener is left behind", client.listenerCount("connected") === 1, client.listenerCount("connected"));
    client.disconnect();
    await radio.close();
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.log("  FAIL threw:", err);
  process.exit(1);
});

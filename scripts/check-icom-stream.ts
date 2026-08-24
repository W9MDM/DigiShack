/* eslint-disable no-console */
// The Icom control stream, driven against a stub radio on localhost.
//
// There is no IC-7300 on this machine and there will not be one in CI, so the only way
// to test the state machine is to write the other end of it. This stub answers the open
// request, issues a login reply, completes the auth exchange and confirms the stream
// request — enough to walk the client from `idle` all the way to `ready`.
//
// It is a stub, not a simulator. It proves the sequence, the field plumbing and the
// timers. It cannot prove the radio agrees with our reading of the protocol; that needs
// hardware, and it is the one thing left that does.

import dgram from "node:dgram";

import { ControlLength } from "@/lib/icom/control-packets";
import { IcomControlStream } from "@/lib/icom/control-stream";
import { buildPacket, isPing, PacketType, parsePing } from "@/lib/icom/packets";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  ok(actual === expected, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

interface StubOptions {
  /** Answer the login with an auth id that does NOT echo the client's start bytes. */
  wrongAuthEcho?: boolean;
  /** Reply to the stream request with an auth-failed 80-byte packet. */
  refuseAuth?: boolean;
  /** Zero the length field on pings, as a real radio does. */
  lieAboutPingLength?: boolean;
  radioName?: string;
}

interface Stub {
  port: number;
  seen: string[];
  pingRepliesReceived: number;
  close(): void;
  /** Start pinging the client, to check it answers. */
  startPinging(): void;
}

async function startStubRadio(o: StubOptions = {}): Promise<Stub> {
  const socket = dgram.createSocket("udp4");
  const seen: string[] = [];
  const radioSid = 0x38ff557d;
  const radioName = o.radioName ?? "IC-7300";
  let clientAddr: { address: string; port: number } | null = null;
  let pingSeq = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  const stub: Stub = {
    port: 0,
    seen,
    pingRepliesReceived: 0,
    close() {
      if (pingTimer) clearInterval(pingTimer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
    startPinging() {
      pingTimer = setInterval(() => {
        if (!clientAddr) return;
        // A real radio zeroes the length field here. Reproduce that, because a client
        // that frames on the declared length drops every one of these and then dies.
        const p = Buffer.alloc(21);
        if (!o.lieAboutPingLength) p.writeUInt32LE(21, 0);
        p.writeUInt16LE(PacketType.ping, 4);
        p.writeUInt16LE(pingSeq++, 6);
        p.writeUInt32BE(radioSid, 8);
        p.writeUInt32BE(clientSid, 12);
        p[16] = 0x00;
        Buffer.from([0x57, 0x2b, 0x12, 0x00]).copy(p, 17);
        socket.send(p, clientAddr.port, clientAddr.address);
      }, 60);
      pingTimer.unref?.();
    },
  };

  let clientSid = 0;
  let clientAuthStart = Buffer.alloc(2);

  socket.on("message", (msg, rinfo) => {
    clientAddr = { address: rinfo.address, port: rinfo.port };
    const reply = (b: Buffer) => socket.send(b, rinfo.port, rinfo.address);

    if (isPing(msg)) {
      const p = parsePing(msg);
      if (p && !p.isRequest) stub.pingRepliesReceived++;
      seen.push(p?.isRequest ? "ping-request" : "ping-reply");
      return;
    }

    const type = msg.readUInt16LE(4);

    if (type === PacketType.sessionOpen && msg.length === 16) {
      // Step four of the open handshake: the radio echoes our confirm back.
      const r = buildPacket(16, {
        type: PacketType.sessionOpen,
        seq: 1,
        senderId: radioSid,
        destinationId: msg.readUInt32BE(8),
      });
      socket.send(r, rinfo.port, rinfo.address);
      return;
    }
    if (type === PacketType.openRequest && msg.length === 16) {
      seen.push("open");
      clientSid = msg.readUInt32BE(8);
      const r = buildPacket(16, {
        type: PacketType.openReply,
        seq: 0,
        senderId: radioSid,
        destinationId: clientSid,
      });
      reply(r);
      return;
    }

    if (type === PacketType.disconnect) {
      seen.push("close");
      return;
    }

    switch (msg.length) {
      case ControlLength.login: {
        seen.push("login");
        clientAuthStart = Buffer.from(msg.subarray(26, 28));
        const r = Buffer.alloc(ControlLength.loginReply);
        r.writeUInt32LE(ControlLength.loginReply, 0);
        r.writeUInt16LE(0, 4);
        r.writeUInt16LE(2, 6);
        r.writeUInt32BE(radioSid, 8);
        r.writeUInt32BE(clientSid, 12);
        // The auth id begins with the client's two random bytes.
        const authId = Buffer.from([0, 0, 0x00, 0x00, 0x4f, 0x0d]);
        if (o.wrongAuthEcho) {
          Buffer.from([0xde, 0xad]).copy(authId, 0);
        } else {
          clientAuthStart.copy(authId, 0);
        }
        authId.copy(r, 26);
        r.write("FTTH", 64, "ascii");
        reply(r);

        // Capabilities are a SEPARATE 168-byte packet, sent after the login reply.
        // Conflating the two is what made the real radio look unresponsive.
        const caps = Buffer.alloc(ControlLength.capabilities);
        caps.writeUInt32LE(ControlLength.capabilities, 0);
        caps.writeUInt32BE(radioSid, 8);
        caps.writeUInt32BE(clientSid, 12);
        Buffer.alloc(16, 0xbb).copy(caps, 66);
        caps.write(radioName, 82, "ascii");
        caps.write("ICOM_VAUDIO", 114, "ascii");
        reply(caps);
        return;
      }
      case ControlLength.auth: {
        const magic = msg[21];
        seen.push(`auth-${magic}`);
        if (magic === 0x05) {
          const r = Buffer.alloc(ControlLength.auth);
          r.writeUInt32LE(ControlLength.auth, 0);
          r.writeUInt32BE(radioSid, 8);
          r.writeUInt32BE(clientSid, 12);
          r[19] = 0x30;
          r[20] = 0x02;
          r[21] = 0x05;
          reply(r);
        }
        return;
      }
      case ControlLength.serialAudioRequest: {
        seen.push("stream-request");
        // Record what model name the client claimed — the portability point.
        seen.push(`name:${msg.toString("ascii", 64, 71).replace(/\0.*/, "")}`);
        if (o.refuseAuth) {
          const r = Buffer.alloc(ControlLength.streamOpen);
          r.writeUInt32LE(ControlLength.streamOpen, 0);
          Buffer.from([0xff, 0xff, 0xff]).copy(r, 48);
          reply(r);
          return;
        }
        const r = Buffer.alloc(ControlLength.serialAudioRequest);
        r.writeUInt32LE(ControlLength.serialAudioRequest, 0);
        r.writeUInt32BE(radioSid, 8);
        r.writeUInt32BE(clientSid, 12);
        r[96] = 1;
        reply(r);
        return;
      }
      default:
        seen.push(`unknown-${msg.length}`);
    }
  });

  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  stub.port = socket.address().port;
  return stub;
}

function waitFor<T>(fn: (resolve: (v: T) => void, reject: (e: Error) => void) => void, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    fn(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function main(): Promise<void> {
  console.log("\nthe full handshake, end to end");
  {
    const stub = await startStubRadio({ radioName: "IC-7300" });
    const client = new IcomControlStream({
      host: "127.0.0.1",
      port: stub.port,
      username: "k9xyz",
      password: "secret",
      bindAddress: "127.0.0.1",
    });

    eq(client.status, "idle", "starts idle");

    let identified: { radioName: string } | null = null;
    client.on("identified", (i) => {
      identified = i;
    });

    try {
      const ready = await waitFor<{ radioName: string; audioName: string }>(
        (resolve, reject) => {
          client.on("ready", resolve);
          client.on("error", reject);
          void client.connect();
        },
        5_000,
        "ready",
      );

      eq(client.status, "ready", "reaches ready");
      eq(ready.radioName, "IC-7300", "the radio's name survives to the ready event");
      eq(ready.audioName, "ICOM_VAUDIO", "and the audio device name with it");
      ok(identified !== null, "identified fires before ready");

      // The sequence actually walked, in order.
      // The open request and the session confirm are each sent twice on purpose —
      // they are the two packets the whole session depends on and there is no
      // retransmit machinery yet at that point. Collapse the duplicates so the order
      // assertion is about sequence rather than about how many copies went out.
      const raw = stub.seen.filter((s) => !s.startsWith("ping") && !s.startsWith("name:"));
      ok(
        raw.filter((x) => x === "open").length === 2,
        "the open request is sent twice, deliberately",
        `${raw.filter((x) => x === "open").length} copies`,
      );
      const order = raw.filter((x, i) => x !== raw[i - 1]);
      eq(order[0], "open", "1. open");
      eq(order[1], "login", "2. login");
      eq(order[2], "auth-2", "3. acknowledge");
      eq(order[3], "auth-5", "4. confirm");
      eq(order[4], "stream-request", "5. request the streams");

      // kappanhang would have sent IC-705 here. We send what the radio told us.
      ok(stub.seen.includes("name:IC-7300"), "the stream request quotes the radio's own name");

      await client.disconnect();
      // Token removal is auth magic 0x01, and skipping it leaves the radio holding
      // the session so the next connection is refused.
      ok(stub.seen.includes("auth-1"), "disconnect removes the token");

      // And sends it MORE THAN ONCE, which is the whole difference between a radio
      // that survives a restart and one that does not.
      //
      // It used to be a single datagram followed immediately by close(): UDP,
      // unacknowledged, socket shutting behind it. Over a VPN that is a coin flip, and
      // when it lost the radio kept the session — so the next start got streams that
      // opened and carried nothing, no CI-V or no audio. Every restart was a fresh
      // toss, which from the operating chair looks exactly like "every code change
      // breaks the Icom". It did.
      const removals = stub.seen.filter((x) => x === "auth-1").length;
      ok(removals >= 2, "and repeats it, because nothing acknowledges it", `${removals} sent`);
      eq(client.status, "closed", "and ends closed");
    } catch (err) {
      fail++;
      console.log(`  FAIL  handshake — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      stub.close();
    }
  }

  console.log("\npings from a radio that lies about packet length");
  {
    // The real failure this guards: a radio ping has its length field zeroed. A client
    // that frames on the declared length silently drops all of them and the session
    // dies after ~3 s with nothing in any log pointing at the cause.
    const stub = await startStubRadio({ lieAboutPingLength: true });
    const client = new IcomControlStream({
      host: "127.0.0.1",
      port: stub.port,
      username: "k9xyz",
      password: "secret",
      bindAddress: "127.0.0.1",
    });
    try {
      await waitFor<unknown>(
        (resolve, reject) => {
          client.on("ready", resolve);
          client.on("error", reject);
          void client.connect();
        },
        5_000,
        "ready",
      );
      stub.startPinging();
      await new Promise((r) => setTimeout(r, 400));
      ok(
        stub.pingRepliesReceived >= 3,
        "zero-length pings are answered anyway",
        `got ${stub.pingRepliesReceived} replies`,
      );
    } catch (err) {
      fail++;
      console.log(`  FAIL  ping handling — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await client.disconnect();
      stub.close();
    }
  }

  console.log("\na login reply meant for somebody else");
  {
    // Two clients on one network is a real configuration. A reply whose auth id does
    // not echo our random bytes is answering someone else's login, and acting on it
    // would authenticate us into the wrong session.
    const stub = await startStubRadio({ wrongAuthEcho: true });
    const client = new IcomControlStream({
      host: "127.0.0.1",
      port: stub.port,
      username: "k9xyz",
      password: "secret",
      bindAddress: "127.0.0.1",
    });
    let sawEchoError = false;
    client.on("error", (e) => {
      if (/auth start id/i.test(e.message)) sawEchoError = true;
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 400));
    ok(sawEchoError, "the mismatched reply is rejected");
    ok(client.status !== "ready", "and we do not reach ready on it", `state ${client.status}`);
    await client.disconnect();
    stub.close();
  }

  console.log("\nauthentication refused");
  {
    const stub = await startStubRadio({ refuseAuth: true });
    const client = new IcomControlStream({
      host: "127.0.0.1",
      port: stub.port,
      username: "k9xyz",
      password: "wrong",
      bindAddress: "127.0.0.1",
    });
    let message = "";
    client.on("error", (e) => {
      if (!message) message = e.message;
    });
    await client.connect();
    await new Promise((r) => setTimeout(r, 500));
    ok(/authentication failed/i.test(message), "reports an auth failure", message);
    // The advice matters: a stale session from an untidy exit is by far the most
    // common cause, and the fix is to reboot the radio.
    ok(/reboot/i.test(message), "and suggests rebooting the radio, which is usually it");
    eq(client.status, "closed", "the stream closes itself");
    stub.close();
  }

  console.log("\nthe radio going quiet");
  {
    const stub = await startStubRadio();
    const client = new IcomControlStream({
      host: "127.0.0.1",
      port: stub.port,
      username: "k9xyz",
      password: "secret",
      bindAddress: "127.0.0.1",
    });
    await waitFor<unknown>(
      (resolve, reject) => {
        client.on("ready", resolve);
        client.on("error", reject);
        void client.connect();
      },
      5_000,
      "ready",
    );
    // Not waited out here — the idle timeout is 6 s and a test that sleeps that long
    // to prove a setTimeout exists is not worth the wall clock. What is checked is
    // that closing the socket under it does not throw or hang.
    stub.close();
    await client.disconnect();
    eq(client.status, "closed", "disconnect is safe after the peer vanishes");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

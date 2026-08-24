/* eslint-disable no-console */
// IcomSource end to end, against a stub radio serving all three ports.
//
// This is the first test where the pieces are assembled: control authenticates, the
// serial and audio streams open on the ports the control stream negotiated, CI-V
// answers a frequency read, and receive audio arrives at the top as float32. What it
// proves is that the wiring is right. What it cannot prove is that a real IC-7300
// agrees with any of it.

import dgram from "node:dgram";

import { buildFrame, CIV_CONTROLLER, encodeBcd2, encodeFrequency } from "@/lib/icom/civ";
import { ControlLength } from "@/lib/icom/control-packets";
import { buildPacket, isPing, PacketType, parsePing } from "@/lib/icom/packets";
import { parseCivAddress } from "@/lib/icom/from-settings";
import { IcomSource } from "@/lib/icom/rig";
import { float32ToS16le } from "@/lib/icom/audio-stream";
import { buildWaveform } from "@/lib/radio/waveform";

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
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const RADIO_SID = 0x5f8b1e89;
const RADIO_ADDR = 0x94;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

interface Port {
  port: number;
  sock: dgram.Socket;
  clientSid: number;
  addr: { address: string; port: number } | null;
  received: Buffer[];
}

async function bindPort(handler: (p: Port, msg: Buffer) => void): Promise<Port> {
  const sock = dgram.createSocket("udp4");
  const p: Port = { port: 0, sock, clientSid: 0, addr: null, received: [] };
  sock.on("message", (msg, rinfo) => {
    p.addr = { address: rinfo.address, port: rinfo.port };
    if (isPing(msg)) {
      const ping = parsePing(msg);
      if (ping?.isRequest) {
        // Answer, swapping the ids.
        const r = Buffer.from(msg);
        r.writeUInt32BE(ping.destinationId, 8);
        r.writeUInt32BE(ping.senderId, 12);
        r[16] = 0x01;
        sock.send(r, rinfo.port, rinfo.address);
      }
      return;
    }
    const type = msg.readUInt16LE(4);
    if (type === PacketType.sessionOpen && msg.length === 16) {
      // Step four of the open handshake: the radio echoes our confirm back.
      const r = buildPacket(16, {
        type: PacketType.sessionOpen,
        seq: 1,
        senderId: RADIO_SID,
        destinationId: msg.readUInt32BE(8),
      });
      sock.send(r, rinfo.port, rinfo.address);
      return;
    }
    if (type === PacketType.openRequest && msg.length === 16) {
      p.clientSid = msg.readUInt32BE(8);
      sock.send(
        buildPacket(16, {
          type: PacketType.openReply,
          seq: 0,
          senderId: RADIO_SID,
          destinationId: p.clientSid,
        }),
        rinfo.port,
        rinfo.address,
      );
      return;
    }
    if (msg.length === 16) return; // idle
    p.received.push(Buffer.from(msg));
    handler(p, msg);
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  p.port = sock.address().port;
  return p;
}

function serialWrap(payload: Buffer, seq: number, clientSid: number): Buffer {
  const p = buildPacket(21 + payload.length, {
    type: 0,
    seq: 0,
    senderId: RADIO_SID,
    destinationId: clientSid,
  });
  p[16] = 0xc1;
  p[17] = payload.length;
  p.writeUInt16BE(seq, 19);
  payload.copy(p, 21);
  return p;
}

function audioWrap(pcm: Buffer, seq: number, clientSid: number): Buffer {
  const p = buildPacket(24 + pcm.length, {
    type: 0,
    seq: 0,
    senderId: RADIO_SID,
    destinationId: clientSid,
  });
  p[16] = 0x80;
  p.writeUInt16BE(seq, 18);
  p.writeUInt16BE(pcm.length, 22);
  pcm.copy(p, 24);
  return p;
}

/** A control port that completes the login handshake. One per test — the handshake
 *  state is per-connection, and sharing one across tests fails the second connect. */
async function controlStub(): Promise<Port> {
  return bindPort((p, msg) => {
    const send = (b: Buffer) => {
      if (p.addr) p.sock.send(b, p.addr.port, p.addr.address);
    };
    if (msg.length === ControlLength.login) {
      const r = Buffer.alloc(ControlLength.loginReply);
      r.writeUInt32LE(ControlLength.loginReply, 0);
      r.writeUInt32BE(RADIO_SID, 8);
      r.writeUInt32BE(p.clientSid, 12);
      const authId = Buffer.alloc(6);
      msg.subarray(26, 28).copy(authId, 0);
      authId.copy(r, 26);
      r.write("FTTH", 64, "ascii");
      send(r);

      // Capabilities arrive separately, as a 168-byte packet.
      const caps = Buffer.alloc(ControlLength.capabilities);
      caps.writeUInt32LE(ControlLength.capabilities, 0);
      caps.writeUInt32BE(RADIO_SID, 8);
      caps.writeUInt32BE(p.clientSid, 12);
      Buffer.alloc(16, 0xbb).copy(caps, 66);
      caps.write("IC-7300", 82, "ascii");
      caps.write("ICOM_VAUDIO", 114, "ascii");
      send(caps);
    } else if (msg.length === ControlLength.auth && msg[21] === 0x05) {
      const r = Buffer.alloc(ControlLength.auth);
      r.writeUInt32LE(ControlLength.auth, 0);
      r.writeUInt32BE(RADIO_SID, 8);
      r.writeUInt32BE(p.clientSid, 12);
      r[21] = 0x05;
      send(r);
    } else if (msg.length === ControlLength.serialAudioRequest) {
      const r = Buffer.alloc(ControlLength.serialAudioRequest);
      r.writeUInt32LE(ControlLength.serialAudioRequest, 0);
      r.writeUInt32BE(RADIO_SID, 8);
      r.writeUInt32BE(p.clientSid, 12);
      r[96] = 1;
      send(r);
    }
  });
}

async function main(): Promise<void> {
  // --- serial: answer CI-V reads --------------------------------------------------
  let civSeq = 0;
  let tunedTo: number | null = null;
  let dataModeSet = false;
  const serial = await bindPort((p, msg) => {
    if (msg[16] !== 0xc1) return; // channel open/close, ignore
    const payload = msg.subarray(21, 21 + (msg[17] ?? 0));
    if (payload.length < 5) return;
    const command = payload[4];
    const sub = payload[5];

    const reply = (b: Buffer) => {
      if (p.addr) p.sock.send(serialWrap(b, civSeq++, p.clientSid), p.addr.port, p.addr.address);
    };

    if (command === 0x03) {
      reply(
        buildFrame({
          to: CIV_CONTROLLER,
          from: RADIO_ADDR,
          command: 0x03,
          data: encodeFrequency(tunedTo ?? 14_074_000),
        }),
      );
    } else if (command === 0x05) {
      tunedTo = null;
      // Radio does not acknowledge a set with the value; it just retunes.
      const hz = payload.subarray(5, 10);
      let v = 0;
      for (let i = 4; i >= 0; i--) {
        const b = hz[i] as number;
        v = v * 100 + (b >> 4) * 10 + (b & 0x0f);
      }
      tunedTo = v;
    } else if (command === 0x26) {
      // Mode + data + filter.
      dataModeSet = payload[6] === 0x01 && payload[7] === 0x01;
    } else if (command === 0x15) {
      // Meters: sub 0x02 S-meter, 0x12 SWR. Payload echoes the sub then two BCD bytes.
      const raw = sub === 0x02 ? 120 : 48;
      reply(
        buildFrame({
          to: CIV_CONTROLLER,
          from: RADIO_ADDR,
          command: 0x15,
          sub,
          data: encodeBcd2(raw),
        }),
      );
    }
  });

  // --- audio: silent until pushed -------------------------------------------------
  const audio = await bindPort(() => undefined);

  const control = await controlStub();

  console.log("\nthe whole radio, assembled");
  const source = new IcomSource({
    host: "127.0.0.1",
    username: "k9xyz",
    password: "secret",
    controlPort: control.port,
    serialPort: serial.port,
    audioPort: audio.port,
    bindAddress: "127.0.0.1",
  });

  const audioBlocks: Float32Array[] = [];
  const smeters: number[] = [];
  let swr: number | null = null;
  source.on("audio", (a) => audioBlocks.push(a.samples));
  source.on("smeter", (s) => smeters.push(s.dbm));
  source.on("telemetry", (t) => {
    if (t.swr !== null) swr = t.swr;
  });
  source.on("error", () => {
    /* asserted below */
  });

  try {
    const connected = await new Promise<boolean>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("never connected")), 6_000);
      source.on("connected", () => {
        clearTimeout(t);
        resolve(true);
      });
      void source.start();
    });
    ok(connected, "connects through all three streams");
    eq(source.identity.model, "IC-7300", "the radio identifies itself");
    eq(source.identity.vendor, "icom", "and reports its vendor");
    eq(source.audioFormat.sampleRate, 48_000, "48 kHz");
    eq(source.address, 0x94, "the CI-V address defaults from the model name");

    await settle(300);
    eq(source.getFrequencyHz(), 14_074_000, "the frequency comes back over CI-V");
    ok(source.canTransmit, "transmit is possible once serial and audio are both up");

    // Meters.
    ok(smeters.length > 0, "the S-meter reports");
    ok(Math.abs((smeters[0] ?? 0) + 73) < 1, "raw 120 reads as S9, which is -73 dBm", `${smeters[0]}`);
    ok(swr !== null && Math.abs(swr - 1.5) < 0.01, "raw 48 reads as 1.5:1 SWR", `${swr}`);

    // Tuning.
    await source.setFrequencyHz(7_074_000);
    await settle(300);
    eq(source.getFrequencyHz(), 7_074_000, "retuning takes effect and is confirmed by the poll");

    // Data mode, without which FT8 keys and sends nothing.
    await source.setDataMode();
    await settle();
    ok(dataModeSet, "USB-D is selected, not plain USB");

    // Receive audio all the way to the top.
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(16384, 2);
    if (audio.addr) {
      audio.sock.send(audioWrap(pcm, 1, audio.clientSid), audio.addr.port, audio.addr.address);
    }
    await settle();
    eq(audioBlocks.length, 1, "receive audio reaches the source");
    ok(Math.abs((audioBlocks[0]?.[1] ?? 0) - 0.5) < 0.001, "converted to float on the way");

    await source.stop();
    eq(source.connected, false, "and it stops cleanly");
    ok(!source.canTransmit, "transmit is refused once stopped");
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const p of [control, serial, audio]) {
      try {
        p.sock.close();
      } catch {
        /* already closed */
      }
    }
  }

  console.log("\naudio reaches the decode pipeline");
  {
    // The wiring this proves: a UDP audio packet from the radio ends up in the shared
    // pipeline's buffer. That the pipeline then decodes 48 kHz correctly is proven by
    // check-pipeline-golden.ts, which drives it directly with no sockets and no
    // scheduler — the right place for it, because here the real window scheduler is
    // running and will cut and clear the buffer partway through a long push.
    const stub = await bindPort(() => undefined);
    const ctl2 = await controlStub();
    const ser2 = await bindPort(() => undefined);
    const source = new IcomSource({
      host: "127.0.0.1",
      username: "k9xyz",
      password: "secret",
      controlPort: ctl2.port,
      serialPort: ser2.port,
      audioPort: stub.port,
      bindAddress: "127.0.0.1",
      mode: "FT8",
      silenceRms: 1e-5,
    });
    source.on("error", () => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("never connected")), 6_000);
        source.on("connected", () => {
          clearTimeout(t);
          resolve();
        });
        void source.start();
      });

      // Spy on the pipeline rather than inspecting its buffer.
      //
      // The buffer is the wrong thing to assert on: the real window scheduler is
      // running, and for the ~1.2 s after each cut the pipeline deliberately drops
      // incoming samples as the guard-time tail of a window it has already taken. A
      // test that pushes audio into that gap sees zero and fails, roughly one run in
      // twelve — correct behaviour, flaky assertion. What is actually being claimed
      // here is "audio from the socket is handed to the pipeline", so count the calls.
      const pipeline = (source as unknown as {
        pipeline: { push(s: ArrayLike<number>): void };
      }).pipeline;
      const realPush = pipeline.push.bind(pipeline);
      let pushedSamples = 0;
      pipeline.push = (samples: ArrayLike<number>) => {
        pushedSamples += samples.length;
        realPush(samples);
      };

      // Twenty 20 ms packets — 0.4 s of audio. Paced, because a tight loop of UDP sends
      // on loopback overruns the receive buffer and most of them vanish, which is a
      // property of this harness and not of the radio.
      const tone = new Float32Array(960);
      for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 1200 * i) / 48_000);
      for (let n = 0; n < 20; n++) {
        if (stub.addr) {
          stub.sock.send(
            audioWrap(float32ToS16le(tone), n, stub.clientSid),
            stub.addr.port,
            stub.addr.address,
          );
        }
        await settle(5);
      }
      await settle(200);

      ok(
        pushedSamples > 960 * 15,
        "audio from the socket is handed to the decode pipeline",
        `${pushedSamples} samples from ${20 * 960} sent`,
      );
    } catch (err) {
      fail++;
      console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await source.stop();
      for (const port of [stub, ctl2, ser2]) {
        try {
          port.sock.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  console.log("\nCI-V address from a setting");
  {
    // Manuals print it as "94h", and people paste it every way they have seen it.
    eq(parseCivAddress("94"), 0x94, "bare hex");
    eq(parseCivAddress("0x94"), 0x94, "with a 0x prefix");
    eq(parseCivAddress("0XA4"), 0xa4, "upper case, IC-705");
    eq(parseCivAddress("  94  "), 0x94, "surrounding whitespace");

    // Blank must mean "use whatever the radio's model implies", not "address zero".
    // Returning a default here instead would override a correct model-derived address
    // with a wrong literal, and the radio would simply ignore every command.
    eq(parseCivAddress(""), undefined, "blank defers to the radio's model");
    eq(parseCivAddress(null), undefined, "unset defers too");
    eq(parseCivAddress("zzz"), undefined, "nonsense defers rather than guessing");
    eq(parseCivAddress("0"), undefined, "zero is not a valid address");
    eq(parseCivAddress("1FF"), undefined, "out of range defers");
  }

  console.log("\nCI-V goes out one command at a time");
  {
    // The bug this stops coming back cost every meter on the radio.
    //
    // The poll wrote four commands in the same tick, and the radio answered the FIRST
    // and dropped the rest: 0x03 frequency came back every time while the three 0x15
    // meters never came back at all. So the signal bar was blank, forward power never
    // displayed, and SWR never reached the operating guards — the guard that protects
    // the finals. Preflight's single reads were intermittent for the same reason,
    // depending on whether they landed inside a burst.
    const ctl = await controlStub();
    const civ: { at: number; frame: Buffer }[] = [];
    const ser = await bindPort((_p, msg) => {
      // A real CI-V frame, not one of the stream's own 22-byte control packets — those
      // are also "longer than the header" and counting them made the first gap read as
      // zero. CI-V always starts FE FE.
      const body = msg.subarray(21);
      if (body.length >= 5 && body[0] === 0xfe && body[1] === 0xfe) {
        civ.push({ at: Date.now(), frame: body });
      }
    });
    const aud = await bindPort(() => undefined);
    const source = new IcomSource({
      host: "127.0.0.1",
      username: "k9xyz",
      password: "secret",
      controlPort: ctl.port,
      serialPort: ser.port,
      audioPort: aud.port,
      bindAddress: "127.0.0.1",
      mode: "FT8",
    });
    source.on("error", () => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("never connected")), 6_000);
        source.on("connected", () => {
          clearTimeout(t);
          resolve();
        });
        void source.start();
      });

      // The poll fires once immediately on connect: four commands, one queue.
      await settle(60);
      const immediate = civ.length;
      ok(immediate <= 2, `at most one or two commands go out at once (${immediate})`, String(immediate));
      ok(source.civQueueDepth > 0, "the rest are queued", `depth ${source.civQueueDepth}`);

      // Long enough for four commands at 70 ms, with room to spare.
      await settle(450);
      ok(civ.length >= 4, `all four arrive shortly after (${civ.length})`, String(civ.length));

      // And spaced, not bunched. The first gap is the one that matters — it is the one
      // the radio used to miss.
      const gaps: number[] = [];
      for (let i = 1; i < Math.min(civ.length, 4); i++) {
        gaps.push((civ[i] as { at: number }).at - (civ[i - 1] as { at: number }).at);
      }
      ok(
        gaps.every((g) => g >= 40),
        `each command is spaced from the last (gaps ${gaps.join(", ")} ms)`,
        gaps.join(", "),
      );
    } catch (err) {
      fail++;
      console.log(`  FAIL  pacing — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await source.stop().catch(() => undefined);
      for (const port of [ctl, ser, aud]) port.sock.close();
    }
  }

  console.log("\nopen is not the same as carrying");
  {
    // The distinction that cost an evening. When a restart leaves the radio holding the
    // previous session, the new streams open perfectly and then deliver nothing — and
    // every layer above reports something plausible and wrong: a blank band, a dead
    // receiver, a radio that will not tune. "Open" is a socket fact; "carrying" is the
    // one worth gating on.
    //
    // Stubs that accept the connection and then say nothing, which is exactly the
    // failure mode: a control stub that completes the handshake, a serial port that
    // never answers CI-V, and an audio port that never sends a packet.
    const ctl = await controlStub();
    const ser = await bindPort(() => undefined);
    const aud = await bindPort(() => undefined);
    const source = new IcomSource({
      host: "127.0.0.1",
      username: "k9xyz",
      password: "secret",
      controlPort: ctl.port,
      serialPort: ser.port,
      audioPort: aud.port,
      bindAddress: "127.0.0.1",
      mode: "FT8",
    });
    source.on("error", () => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("never connected")), 6_000);
        source.on("connected", () => {
          clearTimeout(t);
          resolve();
        });
        void source.start();
      });

      eq(source.connected, true, "the source reports connected — the sockets are open");

      // Short timeout: the point is that it reports honestly, not that it waits eight
      // seconds to do so.
      const carrying = await source.streamsCarrying(1_200);
      eq(carrying.ok, false, "but streamsCarrying says no, because nothing arrived");
      eq(carrying.civ, 0, "no CI-V frames");
      eq(carrying.audio, 0, "no audio packets");
      eq(source.getFrequencyHz(), null, "and there is no frequency to report");
    } catch (err) {
      fail++;
      console.log(`  FAIL  carrying — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await source.stop().catch(() => undefined);
      for (const p of [ctl, ser, aud]) p.sock.close();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

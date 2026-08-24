/* eslint-disable no-console */
// The serial and audio streams, against a stub radio.
//
// Both share the transport in stream-base.ts, so what is tested here is what they add:
// the serial wrapper and its CI-V framing, and the audio wrapper with its big-endian
// sequence and payload length. The stub does the open handshake and then plays back
// whatever the test needs.

import dgram from "node:dgram";

import { float32ToS16le, IcomAudioStream, TX_CHUNK_BYTES } from "@/lib/icom/audio-stream";
import { CIV_CONTROLLER, encodeFrequency, buildFrame, setFrequency } from "@/lib/icom/civ";
import { buildPacket, PacketType } from "@/lib/icom/packets";
import { IcomSerialStream } from "@/lib/icom/serial-stream";

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

const RADIO_SID = 0x11223344;

interface Stub {
  port: number;
  /** Everything the client sent, after the open handshake. */
  received: Buffer[];
  /** Push a datagram to the client. */
  push(b: Buffer): void;
  clientSid: number;
  close(): void;
}

async function stubRadio(): Promise<Stub> {
  const socket = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  let addr: { address: string; port: number } | null = null;
  const stub: Stub = {
    port: 0,
    received,
    clientSid: 0,
    push(b) {
      if (addr) socket.send(b, addr.port, addr.address);
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };

  socket.on("message", (msg, rinfo) => {
    addr = { address: rinfo.address, port: rinfo.port };
    const type = msg.readUInt16LE(4);
    if (type === PacketType.sessionOpen && msg.length === 16) {
      // Step four of the open handshake: the radio echoes our confirm back.
      const r = buildPacket(16, {
        type: PacketType.sessionOpen,
        seq: 1,
        senderId: RADIO_SID,
        destinationId: msg.readUInt32BE(8),
      });
      socket.send(r, rinfo.port, rinfo.address);
      return;
    }
    if (type === PacketType.openRequest && msg.length === 16) {
      stub.clientSid = msg.readUInt32BE(8);
      socket.send(
        buildPacket(16, {
          type: PacketType.openReply,
          seq: 0,
          senderId: RADIO_SID,
          destinationId: stub.clientSid,
        }),
        rinfo.port,
        rinfo.address,
      );
      return;
    }
    // Ignore pings and idles; record everything else.
    if (msg.length === 21 || msg.length === 16) return;
    received.push(Buffer.from(msg));
  });

  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  stub.port = socket.address().port;
  return stub;
}

/** Wrap CI-V bytes the way the radio would. */
function serialPacket(payload: Buffer, seq: number, clientSid: number): Buffer {
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

/** Wrap PCM the way the radio would. */
function audioPacket(pcm: Buffer, seq: number, clientSid: number): Buffer {
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

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("\nserial stream — CI-V in and out");
  {
    const stub = await stubRadio();
    const serial = new IcomSerialStream({
      host: "127.0.0.1",
      port: stub.port,
      bindAddress: "127.0.0.1",
    });
    const frames: Array<{ command: number; data: Buffer }> = [];
    serial.on("frame", (f) => frames.push({ command: f.command, data: f.data }));
    serial.on("error", () => {
      /* reported by the assertions below */
    });

    await serial.open();
    await settle();
    eq(serial.state, "open", "the serial stream opens");

    // The channel-open control packet goes out before any data.
    const first = stub.received[0];
    eq(first?.[16], 0xc0, "a control packet opens the serial channel");
    eq(first?.[21], 0x05, "with magic 0x05");

    serial.write(setFrequency(0x94, 14_074_000));
    await settle();
    const data = stub.received.find((b) => b[16] === 0xc1);
    ok(data !== undefined, "the CI-V frame is sent as a data packet");
    if (data) {
      eq(data[17], 11, "the declared payload length matches the frame");
      eq(data.subarray(21).toString("hex"), "fefe94e0050040071400fd", "the CI-V bytes go out intact");
    }

    // A reply from the radio.
    stub.push(
      serialPacket(
        buildFrame({ to: CIV_CONTROLLER, from: 0x94, command: 0x03, data: encodeFrequency(14_074_000) }),
        1,
        stub.clientSid,
      ),
    );
    await settle();
    eq(frames.length, 1, "the radio's reply arrives as a parsed frame");
    eq(frames[0]?.command, 0x03, "and it is the frequency reply");

    // Our own command echoed back must not be mistaken for a reply.
    stub.push(serialPacket(setFrequency(0x94, 21_074_000), 2, stub.clientSid));
    await settle();
    eq(frames.length, 1, "an echo of our own command is dropped, not counted as a reply");

    await serial.close();
    stub.close();
  }

  console.log("\nserial stream — frames split across datagrams");
  {
    const stub = await stubRadio();
    const serial = new IcomSerialStream({
      host: "127.0.0.1",
      port: stub.port,
      bindAddress: "127.0.0.1",
    });
    const frames: number[] = [];
    serial.on("frame", (f) => frames.push(f.command));
    serial.on("error", () => {});
    await serial.open();
    await settle();

    // A frame arriving in two halves must be rejoined, not lost. UDP does not promise
    // one frame per datagram and the radio does coalesce and split them.
    const whole = buildFrame({ to: CIV_CONTROLLER, from: 0x94, command: 0x03, data: encodeFrequency(7_074_000) });
    stub.push(serialPacket(whole.subarray(0, 5), 1, stub.clientSid));
    await settle(60);
    eq(frames.length, 0, "half a frame yields nothing yet");
    stub.push(serialPacket(whole.subarray(5), 2, stub.clientSid));
    await settle();
    eq(frames.length, 1, "the second half completes it");

    // Two frames in one datagram.
    const two = Buffer.concat([
      buildFrame({ to: CIV_CONTROLLER, from: 0x94, command: 0x04, data: Buffer.from([0x01, 0x01]) }),
      buildFrame({ to: CIV_CONTROLLER, from: 0x94, command: 0x03, data: encodeFrequency(14_074_000) }),
    ]);
    stub.push(serialPacket(two, 3, stub.clientSid));
    await settle();
    eq(frames.length, 3, "two frames in one datagram both come through");

    await serial.close();
    stub.close();
  }

  console.log("\naudio stream — receive");
  {
    const stub = await stubRadio();
    const audio = new IcomAudioStream({
      host: "127.0.0.1",
      port: stub.port,
      bindAddress: "127.0.0.1",
    });
    const blocks: Float32Array[] = [];
    audio.on("audio", (a) => blocks.push(a.samples));
    audio.on("error", () => {});
    await audio.open();
    await settle();
    eq(audio.state, "open", "the audio stream opens");

    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(16384, 2);
    pcm.writeInt16LE(-16384, 4);
    pcm.writeInt16LE(32767, 6);
    stub.push(audioPacket(pcm, 1, stub.clientSid));
    await settle();

    eq(blocks.length, 1, "one packet, one block of samples");
    eq(blocks[0]?.length, 4, "four samples from eight bytes");
    ok(Math.abs((blocks[0]?.[1] ?? 0) - 0.5) < 0.001, "and they are scaled to float");

    // Loss is counted so a bad network is visible, rather than presenting as a
    // receiver that decodes badly for no apparent reason.
    eq(audio.dropped, 0, "nothing dropped yet");
    stub.push(audioPacket(pcm, 5, stub.clientSid));
    await settle();
    eq(audio.dropped, 3, "a gap of three is counted");

    // A wrap must not be read as 65000 lost packets.
    stub.push(audioPacket(pcm, 2, stub.clientSid));
    await settle();
    eq(audio.dropped, 3, "an out-of-order packet does not invent a huge loss");

    await audio.close();
    stub.close();
  }

  console.log("\naudio stream — the silence keepalive");
  {
    // THE fix for the fault that made this radio look unusable.
    //
    // The audio stream is bidirectional and the radio expects it to be used. Left purely
    // as a receiver — which a decode-only session is — the radio stops sending audio
    // after a minute or two while continuing to ping the same socket. The ping counters
    // proved that asymmetry: 219 pings arrived AFTER the audio stopped, so the session
    // was alive and the route was fine, and the radio had simply stopped streaming.
    //
    // Sending silence when there is nothing else to send keeps it flowing. Measured on
    // the air: sessions died every 1-2 minutes before, and ran twelve minutes at 68-95
    // decodes a minute after.
    const stub = await stubRadio();
    const audio = new IcomAudioStream({
      host: "127.0.0.1",
      port: stub.port,
      bindAddress: "127.0.0.1",
    });
    audio.on("error", () => {});
    await audio.open();

    stub.received.length = 0;
    // Long enough for a few keepalives at 200 ms.
    await new Promise((r) => setTimeout(r, 700));

    const silence = stub.received.filter((b) => b[16] === 0x80);
    ok(silence.length >= 4, `silence goes out unprompted (${silence.length} packets)`, String(silence.length));
    ok(audio.keepalivesSent >= 2, `and the stream counts them (${audio.keepalivesSent})`, String(audio.keepalivesSent));
    ok(
      silence.every((b) => b.length <= 1400),
      "each still fits inside a normal MTU",
    );
    // It is silence, not stale audio: every sample zero.
    const body = silence[0]!.subarray(24);
    ok(body.every((byte) => byte === 0), "and it is actually silence");

    // Real audio suppresses it, so a transmission is never interleaved with silence.
    stub.received.length = 0;
    const before = audio.keepalivesSent;
    for (let i = 0; i < 5; i++) {
      audio.writeAudio(Buffer.alloc(TX_CHUNK_BYTES, 7));
      await new Promise((r) => setTimeout(r, 60));
    }
    eq(audio.keepalivesSent, before, "no keepalive interrupts a transmission");

    await audio.close("test");
    const stopped = audio.keepalivesSent;
    await new Promise((r) => setTimeout(r, 400));
    eq(audio.keepalivesSent, stopped, "and it stops when the stream closes");
    // Closing the stub matters more than it looks: a bound dgram socket holds Node's
    // event loop, and with the keepalive writing every 200 ms the process never exits.
    // Leaving this out hung `npm run check` after this file, twice, while the file
    // itself passed.
    stub.close();
  }

  console.log("\naudio stream — transmit");
  {
    const stub = await stubRadio();
    const audio = new IcomAudioStream({
      host: "127.0.0.1",
      port: stub.port,
      bindAddress: "127.0.0.1",
    });
    audio.on("error", () => {});
    await audio.open();
    await settle();

    // One 20 ms chunk goes out as two packets, so a 1944-byte datagram never has to
    // be fragmented by IP. A lost fragment loses the whole datagram, which on audio
    // is a click for no reason.
    audio.writeAudio(Buffer.alloc(TX_CHUNK_BYTES));
    await settle();
    const sent = stub.received.filter((b) => b[16] === 0x80);
    eq(sent.length, 2, "one chunk goes out as two packets");
    ok(sent.every((b) => b.length <= 1400), "and neither exceeds a normal MTU");
    eq(sent[0]?.readUInt16BE(22), 1364, "the first carries 1364 bytes");
    eq(sent[1]?.readUInt16BE(22), 556, "the second carries 556, totalling 1920");
    eq(sent[0]!.readUInt16BE(22) + sent[1]!.readUInt16BE(22), TX_CHUNK_BYTES, "which is 20 ms at 48 kHz");
    eq(sent[1]?.readUInt16BE(18), (sent[0]!.readUInt16BE(18) + 1) & 0xffff, "the audio sequence advances");

    // A short final chunk is padded rather than truncated: shortening a transmission
    // shifts the tail of the last FT8 symbol.
    stub.received.length = 0;
    audio.writeAudio(Buffer.alloc(100));
    await settle();
    const padded = stub.received.filter((b) => b[16] === 0x80);
    eq(padded.length, 2, "a short buffer still goes out as a full chunk");
    eq(
      padded[0]!.readUInt16BE(22) + padded[1]!.readUInt16BE(22),
      TX_CHUNK_BYTES,
      "padded with silence to the full 1920 bytes",
    );

    await audio.close();
    stub.close();
  }

  console.log("\nfloat to PCM");
  {
    const b = float32ToS16le(Float32Array.from([0, 0.5, -0.5, 1, -1]));
    eq(b.length, 10, "two bytes per sample");
    eq(b.readInt16LE(0), 0, "zero");
    eq(b.readInt16LE(6), 32767, "full scale positive");
    eq(b.readInt16LE(8), -32767, "full scale negative");

    // Clamped, not wrapped. A sample above 1.0 written without clamping wraps to
    // full-scale NEGATIVE, and a handful of those sounds like the audio is tearing —
    // distortion that gets blamed on the radio.
    const hot = float32ToS16le(Float32Array.from([1.5, -1.5, 99]));
    eq(hot.readInt16LE(0), 32767, "an over-range sample clamps positive");
    eq(hot.readInt16LE(2), -32767, "and negative");
    ok(hot.readInt16LE(4) > 0, "a wildly hot sample does not wrap to negative");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

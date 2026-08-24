/* eslint-disable no-console */
// Icom RS-BA1 packet and passcode tests.
//
// The radio cannot be stood up in CI, so everything that can be verified without one
// is verified here. The ping exchange below is a REAL capture, taken from the comments
// in kappanhang's pkt7.go: a request the radio sent and the reply the PC sent back. If
// our reply matches that byte for byte, the header layout, the ID swap, the echo and
// the request/reply flag are all correct — which is most of the transport.

import {
  buildIdle,
  buildOpenRequest,
  buildPingReply,
  buildPingRequest,
  expandSeqRange,
  HEADER_LENGTH,
  isIdle,
  isPing,
  PacketType,
  parseHeader,
  parsePing,
  parseRetransmit,
  PING_LENGTH,
  seqAtOrAfter,
} from "@/lib/icom/packets";
import { passcode, PASSCODE_LENGTH } from "@/lib/icom/passcode";
import {
  AuthMagic,
  parseCapabilities,
  buildAuth,
  buildLogin,
  buildSerialAudioRequest,
  classifyControl,
  parseAuthReply,
  parseLoginReply,
  parseStreamOpenReply,
} from "@/lib/icom/control-packets";
import { DECODE_SAMPLE_RATE, decimateBy2 } from "@/lib/flex/dax";
import { s16leToFloat32 } from "@/lib/radio/types";

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

function eqBytes(actual: Buffer, expected: Buffer, label: string): void {
  ok(
    actual.equals(expected),
    label,
    `got ${actual.toString("hex")}, want ${expected.toString("hex")}`,
  );
}

function eq(actual: unknown, expected: unknown, label: string): void {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

// --------------------------------------------------------------- the real capture

// From kappanhang pkt7.go, verbatim.
const RADIO_REQUEST = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x1c, 0x0e, 0xe4, 0x35, 0xdd, 0x72, 0xbe, 0xd9,
  0xf2, 0x63, 0x00, 0x57, 0x2b, 0x12, 0x00,
]);
const PC_ANSWER = Buffer.from([
  0x15, 0x00, 0x00, 0x00, 0x07, 0x00, 0x1c, 0x0e, 0xbe, 0xd9, 0xf2, 0x63, 0xe4, 0x35,
  0xdd, 0x72, 0x01, 0x57, 0x2b, 0x12, 0x00,
]);

console.log("\nping — against a real captured exchange");
{
  ok(isPing(RADIO_REQUEST), "the radio's ping is recognised");

  const req = parsePing(RADIO_REQUEST);
  ok(req !== null, "the radio's ping parses");
  if (req) {
    eq(req.seq, 0x0e1c, "sequence is little-endian (0x0e1c, not 0x1c0e)");
    eq(req.isRequest, true, "byte 16 of 0x00 means the radio wants an answer");
    eqBytes(req.echo, Buffer.from([0x57, 0x2b, 0x12, 0x00]), "the four echo bytes");

    // The whole point of this file.
    eqBytes(buildPingReply(req), PC_ANSWER, "our reply is byte-identical to the capture");
  }

  const answer = parsePing(PC_ANSWER);
  ok(answer?.isRequest === false, "byte 16 of 0x01 marks a reply, not a request");
}

console.log("\nthe declared length is not trustworthy");
{
  // The radio zeroes the length field on pings. A parser that frames on the header
  // drops every keepalive the radio sends, the session dies after ~3 s, and nothing
  // in any log says why. This is the single most expensive mistake available here.
  const h = parseHeader(RADIO_REQUEST);
  eq(h?.declaredLength, 0, "the radio really does send length 0");
  ok(RADIO_REQUEST.length === PING_LENGTH, "the datagram is 21 bytes regardless");
  ok(isPing(RADIO_REQUEST), "recognition uses the real length, so it still matches");
}

console.log("\nheader");
{
  const b = buildPingRequest({ seq: 0x1234, senderId: 0xaabbccdd, destinationId: 0x11223344 });
  const h = parseHeader(b);
  eq(h?.declaredLength, PING_LENGTH, "we write an honest length");
  eq(h?.type, PacketType.ping, "type 7");
  eq(h?.seq, 0x1234, "sequence round-trips");
  eq(h?.senderId, 0xaabbccdd, "sender id round-trips");
  eq(h?.destinationId, 0x11223344, "destination id round-trips");
  ok(parseHeader(Buffer.alloc(4)) === null, "a runt packet parses as null, not garbage");
}

console.log("\nidle and open");
{
  const idle = buildIdle({ seq: 7, senderId: 1, destinationId: 2 });
  eq(idle.length, HEADER_LENGTH, "idle is 16 bytes");
  ok(isIdle(idle), "idle is recognised");
  ok(!isPing(idle), "idle is not mistaken for a ping");
  eqBytes(
    idle.subarray(0, 6),
    Buffer.from([0x10, 0x00, 0x00, 0x00, 0x00, 0x00]),
    "idle starts 10 00 00 00 00 00",
  );

  const open = buildOpenRequest({ seq: 0, senderId: 0xdeadbeef, destinationId: 0 });
  eqBytes(
    open.subarray(0, 6),
    Buffer.from([0x10, 0x00, 0x00, 0x00, 0x03, 0x00]),
    "open request is type 3",
  );
}

console.log("\nretransmit requests");
{
  const one = Buffer.alloc(16);
  one.writeUInt32LE(16, 0);
  one.writeUInt16LE(PacketType.retransmit, 4);
  one.writeUInt16LE(0x0042, 6);
  eq(parseRetransmit(one)?.seqs, [0x42], "the 16-byte form names one sequence");

  // 0x18 in the length field is TWENTY-FOUR. Reading that hex as decimal gives a
  // parser that mis-frames every range request.
  const range = Buffer.alloc(24);
  range.writeUInt32LE(24, 0);
  range.writeUInt16LE(PacketType.retransmit, 4);
  range.writeUInt16LE(10, 16);
  range.writeUInt16LE(13, 18);
  eq(parseRetransmit(range)?.seqs, [10, 11, 12, 13], "the 24-byte form names a range");

  eq(parseRetransmit(buildIdle({ seq: 0, senderId: 0, destinationId: 0 })), null, "idle is not a retransmit request");
}

console.log("\nsequence wrap — the bug that only shows up after an hour");
{
  eq(expandSeqRange(65534, 1), [65534, 65535, 0, 1], "a range straddling 65535 expands");
  eq(expandSeqRange(5, 5), [5], "a single-element range is one element, not zero");
  eq(expandSeqRange(0, 5000).length, 0, "an absurd range is refused rather than walked");

  ok(seqAtOrAfter(0, 65535), "0 is after 65535");
  ok(seqAtOrAfter(5, 5), "a sequence is at-or-after itself");
  ok(!seqAtOrAfter(65535, 0), "65535 is not after 0");
  ok(seqAtOrAfter(100, 50), "ordinary ordering still works");
}

console.log("\npasscode");
{
  // Hand-computed from the published table. '1' is 49, +0 = 49, table[49] = 0x39;
  // '2' is 50, +1 = 51, table[51] = 0x2d; '3' +2 = 53 -> 0x7e; '4' +3 = 55 -> 0x65.
  eqBytes(
    passcode("1234").subarray(0, 4),
    Buffer.from([0x39, 0x2d, 0x7e, 0x65]),
    "known input encodes to the hand-computed bytes",
  );

  eq(passcode("").length, PASSCODE_LENGTH, "always 16 bytes, even empty");
  eq(passcode("x").length, PASSCODE_LENGTH, "always 16 bytes, short input");
  eqBytes(
    passcode("ab").subarray(2),
    Buffer.alloc(14),
    "the tail is zero-padded",
  );

  // The `+ i` is the only thing making this more than a Caesar shift: the same
  // character encodes differently depending on where it sits.
  const aa = passcode("aa");
  ok(aa[0] !== aa[1], "the same character encodes differently by position");

  // Bug-compatible with the reference: truncated, not rejected. An operator with a
  // 20-character radio password connects on the first 16 and never learns why the
  // rest did not matter.
  const long = "abcdefghijklmnopQRSTUVWX";
  eqBytes(passcode(long), passcode(long.slice(0, 16)), "input over 16 chars is truncated");

  // Distinctness across the printable range — a table transcribed with a duplicated
  // or dropped entry would show up as collisions here.
  const seen = new Set<number>();
  for (let c = 32; c <= 126; c++) seen.add(passcode(String.fromCharCode(c))[0] ?? -1);
  eq(seen.size, 95, "all 95 printable characters map to distinct bytes at position 0");
}

console.log("\nlogin reply — parsed from a real 168-byte capture");
{
  // Verbatim from kappanhang controlstream.go. The whole point of keeping it is that
  // the field offsets are otherwise unverifiable without a radio.
  const CAPABILITIES = Buffer.from(
    (
      "a8000000 00000200 01131118 38ff557d" +
      "00000098 02020007 00007f91 00004f0d" +
      "00000000 00000000 00000000 00000000" +
      "00000000 00000000 00000000 00000000" +
      "0001938a 01241764 bc4ba3a0 13584104" +
      "582d4943 2d373035 00000000 00000000" +
      "00000000 00000000 00000000 00000000" +
      "00004943 4f4d5f56 41554449 4f000000" +
      "00000000 00000000 00000000 00000000" +
      "00003f3f a401ff01 ff010101 00004b00" +
      "01500 0b80b000000"
    ).replace(/\s/g, ""),
    "hex",
  );
  eq(CAPABILITIES.length, 168, "the capture reassembles to 168 bytes");

  // This 168-byte packet is the CAPABILITIES packet, not the login reply. They were
  // conflated at first, and against a real IC-7300 that meant the actual 96-byte login
  // reply matched no case and was dropped — a login that timed out while the radio had
  // answered instantly.
  const caps = parseCapabilities(CAPABILITIES);
  ok(caps !== null, "the capabilities packet parses");
  if (caps) {
    eq(caps.radioName, "IC-705", "the radio names itself at byte 82");
    eq(caps.audioName, "ICOM_VAUDIO", "the audio device name is at byte 114");
    eq(caps.a8ReplyId.length, 16, "the a8 reply id is sixteen bytes");
    eqBytes(
      caps.a8ReplyId.subarray(0, 4),
      Buffer.from([0x93, 0x8a, 0x01, 0x24]),
      "the a8 reply id starts at byte 66",
    );
  }
  ok(parseLoginReply(CAPABILITIES) === null, "and it is NOT accepted as a login reply");
  eq(classifyControl(CAPABILITIES), "capabilities", "168 bytes classifies as capabilities");

  // The real login reply, from kappanhang's own example.
  const LOGIN_REPLY = Buffer.from(
    (
      "60000000 00000100 e6b27b7b bb413f2b" + // 0-15   header
      "00000050 02000000 00005d37 12823bde" + // 16-31  inner len 0x50, authId at 26
      "00000000 00000000 00000000 00000000" + // 32-47
      "00000000 00000000 00000000 00000000" + // 48-63  ff ff ff fe here = rejected
      "46545448 00000000 00000000 00000000" + // 64-79  "FTTH"
      "01000000 00000000 00000000 00000000"   // 80-95
    ).replace(/\s/g, ""),
    "hex",
  );
  eq(LOGIN_REPLY.length, 96, "the login reply is 96 bytes, not 168");
  const lr = parseLoginReply(LOGIN_REPLY);
  ok(lr !== null, "it parses");
  eqBytes(
    lr!.authId,
    Buffer.from([0x5d, 0x37, 0x12, 0x82, 0x3b, 0xde]),
    "the auth id comes off bytes 26-31",
  );
  eq(lr!.invalidCredentials, false, "and these credentials were accepted");
  eq(lr!.connectionType, "FTTH", "the radio reports how it is connected");

  // Bad credentials are announced, not merely unanswered. Telling the two apart sends
  // the operator to the password field rather than to their network.
  const REJECTED = Buffer.from(LOGIN_REPLY);
  Buffer.from([0xff, 0xff, 0xff, 0xfe]).copy(REJECTED, 48);
  eq(parseLoginReply(REJECTED)?.invalidCredentials, true, "ff ff ff fe means wrong user or password");

  ok(parseLoginReply(Buffer.alloc(64)) === null, "a wrong-length buffer is refused");
}

console.log("\nlogin request");
{
  const ids = { localSid: 0x01131118, remoteSid: 0x38ff557d };
  const b = buildLogin({
    ids,
    username: "k9xyz",
    password: "secret",
    innerSeq: 7,
    authStartId: Buffer.from([0xab, 0xcd]),
  });

  eq(b.length, 128, "the login packet is 128 bytes");
  eq(b.readUInt32LE(0), 128, "length is little-endian at byte 0");
  eq(b.readUInt16LE(4), 0, "control packets are type 0");
  eq(b[19], 0x70, "the inner block declares its own length at byte 19");
  eq(b.readUInt16LE(23), 7, "the inner sequence is its own counter, little-endian");

  // The session IDs are big-endian while everything around them is little-endian.
  // A reader that gets this wrong still passes every ping test, because ping only
  // ever copies the two IDs around as opaque blocks.
  eq(b.readUInt32BE(8), 0x01131118, "our session id is big-endian at byte 8");
  eq(b.readUInt32BE(12), 0x38ff557d, "the radio's session id is big-endian at byte 12");

  eqBytes(b.subarray(26, 28), Buffer.from([0xab, 0xcd]), "the auth start id is echoed at 26");
  eqBytes(b.subarray(64, 80), passcode("k9xyz"), "username, obfuscated, at byte 64");
  eqBytes(b.subarray(80, 96), passcode("secret"), "password, obfuscated, at byte 80");
  eq(b.toString("ascii", 96, 103), "icom-pc", "the client name is plain ASCII at byte 96");
  ok(!b.includes(Buffer.from("secret", "ascii")), "the password never appears in clear");
}

console.log("\nauth lifecycle");
{
  const ids = { localSid: 1, remoteSid: 2 };
  const authId = Buffer.from([0x7f, 0x91, 0x00, 0x00, 0x4f, 0x0d]);

  for (const [name, magic] of [
    ["acknowledge", AuthMagic.acknowledge],
    ["confirm", AuthMagic.confirm],
    ["remove", AuthMagic.remove],
  ] as const) {
    const b = buildAuth({ ids, authId, magic, innerSeq: 3 });
    eq(b.length, 64, `${name} is 64 bytes`);
    eq(b[21], magic, `${name} carries magic 0x0${magic}`);
    eqBytes(b.subarray(26, 32), authId, `${name} quotes the auth id`);
  }

  // The radio's own 64-byte reply, from the capture.
  const AUTH_REPLY = Buffer.from(
    (
      "40000000 00001000 3360d4e5 f46786e1" +
      "00000030 02050002 00003534 761 1b9d0" +
      "00000000 00000000 00000000 00000000" +
      "00000000 00000000 00000000 00000000"
    ).replace(/\s/g, ""),
    "hex",
  );
  eq(AUTH_REPLY.length, 64, "the auth reply capture is 64 bytes");
  const parsed = parseAuthReply(AUTH_REPLY);
  eq(parsed?.magic, 0x05, "the radio answered our confirm");
  eq(parsed?.complete, true, "magic 0x05 means login is complete");
  eq(
    parseAuthReply(buildAuth({ ids, authId, magic: AuthMagic.acknowledge, innerSeq: 0 }))?.complete,
    false,
    "the first acknowledge is not yet complete",
  );
}

console.log("\nserial and audio request");
{
  const b = buildSerialAudioRequest({
    ids: { localSid: 1, remoteSid: 2 },
    authId: Buffer.alloc(6, 0xaa),
    a8ReplyId: Buffer.alloc(16, 0xbb),
    username: "k9xyz",
    radioName: "IC-7300",
    innerSeq: 9,
  });

  eq(b.length, 144, "the request is 144 bytes");
  eq(b[19], 0x80, "the inner block is 128 bytes");
  eq(b[21], 0x03, "marker 0x03 asks for the streams");

  // kappanhang hardcodes IC-705. Using the name the radio gave us is the portable
  // choice, and it is the difference between working on a 7300 and not.
  eq(b.toString("ascii", 64, 71), "IC-7300", "the radio's own name goes at byte 64");

  // Big-endian from byte 112 on, in the same packet whose header is little-endian.
  eq(b.readUInt16BE(118), 48_000, "the sample rate is big-endian");
  eq(b.readUInt16BE(122), 48_000, "and again for the second rate field");
  eq(b.readUInt16BE(126), 50_002, "the serial port");
  eq(b.readUInt16BE(130), 50_003, "the audio port");
  eqBytes(b.subarray(96, 112), passcode("k9xyz"), "the username is repeated, obfuscated");
  eqBytes(b.subarray(32, 48), Buffer.alloc(16, 0xbb), "the a8 reply id is echoed back");

  // 48000 as little-endian would be 0x80bb rather than 0xbb80 — the streams open and
  // the audio is unintelligible, which is a long way to look for a byte-order bug.
  ok(b.readUInt16LE(118) !== 48_000, "little-endian at 118 would be wrong, and is not what we wrote");
}

console.log("\nstream-open refusals");
{
  const mk = (marker: number[], b64 = 0x00) => {
    const b = Buffer.alloc(80);
    b.writeUInt32LE(80, 0);
    Buffer.from(marker).copy(b, 48);
    b[64] = b64;
    return b;
  };
  eq(parseStreamOpenReply(mk([0xff, 0xff, 0xff]))?.authFailed, true, "three 0xff means auth failed");
  eq(parseStreamOpenReply(mk([0x00, 0x00, 0x00], 0x01))?.disconnected, true, "zeros plus 0x01 means disconnected");
  eq(parseStreamOpenReply(mk([0x01, 0x02, 0x03]))?.authFailed, false, "anything else is neither");
  eq(classifyControl(mk([0, 0, 0])), "streamOpen", "80 bytes classifies as stream-open");
}

console.log("\naudio conversion");
{
  // Icom sends signed 16-bit little-endian mono at 48 kHz.
  const b = Buffer.alloc(8);
  b.writeInt16LE(0, 0);
  b.writeInt16LE(32767, 2);
  b.writeInt16LE(-32768, 4);
  b.writeInt16LE(16384, 6);
  const f = s16leToFloat32(b, 1);
  eq(f.length, 4, "four samples from eight bytes");
  eq(f[0], 0, "zero stays zero");
  ok(Math.abs((f[1] ?? 0) - 0.99997) < 0.001, "full positive scale is just under +1");
  eq(f[2], -1, "full negative scale is exactly -1");
  eq(f[3], 0.5, "half scale is 0.5");

  // A radio that puts signal on one channel only must not decode as half silence.
  const st = Buffer.alloc(8);
  st.writeInt16LE(16384, 0);
  st.writeInt16LE(0, 2);
  st.writeInt16LE(16384, 4);
  st.writeInt16LE(0, 6);
  const m = s16leToFloat32(st, 2);
  eq(m.length, 2, "stereo halves the frame count");
  eq(m[0], 0.25, "channels are mixed, not dropped");

  ok(s16leToFloat32(Buffer.alloc(0)).length === 0, "empty input is empty output, not a throw");
  ok(s16leToFloat32(Buffer.alloc(3)).length === 1, "a trailing odd byte is ignored");
}

console.log("\n48 kHz to the decoders' 12 kHz");
{
  // The doc claims this is exact integer decimation by 4 — two applications of the
  // existing halving filter, no resampler, no drift. Worth checking rather than
  // asserting, because the whole audio plan rests on it.
  eq(48_000 / DECODE_SAMPLE_RATE, 4, "48 kHz is exactly four times the decode rate");

  const input = new Float32Array(4800);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 400 * i) / 48_000);
  const half = decimateBy2(input);
  const quarter = decimateBy2(half);
  eq(half.length, 2400, "one pass halves the sample count");
  eq(quarter.length, 1200, "two passes give a quarter — 0.1 s at 12 kHz");

  // A 400 Hz tone is far below the 6 kHz Nyquist limit after decimation, so it must
  // survive both passes. It does — but at about 0.8 amplitude per pass, because the
  // FIR's taps do not sum to unity. Measured, not assumed: 0.7071 in, 0.5639 after
  // one pass, 0.4455 after two, and the interior matches the whole array so this is
  // the filter's gain and not an edge transient.
  const rms = (a: Float32Array) => {
    let s = 0;
    for (const v of a) s += v * v;
    return Math.sqrt(s / a.length);
  };
  const gain = rms(half) / rms(input);
  ok(Math.abs(gain - 0.7975) < 0.01, "one pass has ~0.80 gain, not unity", `measured ${gain.toFixed(4)}`);
  ok(
    Math.abs(rms(quarter) / rms(input) - gain * gain) < 0.01,
    "two passes compound to ~0.64 — the loss is the filter, not the edges",
  );

  // THE TRAP THIS ENCODES:
  //
  // Flex is 24 kHz and needs ONE pass. Icom is 48 kHz and needs TWO. So identical air
  // signals reach the decoder ~20% quieter on the Icom path. `silenceRms` — the
  // threshold below which a window is skipped without decoding — is therefore ~20%
  // stricter for Icom at the same setting. Carrying the Flex default across unchanged
  // would silently skip marginal windows, and the symptom is "the Icom decodes fewer
  // signals than the Flex", which reads as an antenna or receiver problem and is not.
  ok(gain * gain < gain, "two passes really are quieter than one — silenceRms must differ per radio");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

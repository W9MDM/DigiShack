// Icom RS-BA1 control-stream packets: login, authentication, stream setup.
//
// Layouts learned from kappanhang (https://github.com/nonoo/kappanhang), copyright
// 2020 Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed.
//
// These sit above the transport in packets.ts. They share the 16-byte header but are
// told apart by LENGTH rather than by type — every one of them carries type 0. So the
// dispatch rule for the control stream is: 64 is auth, 80 is stream-open, 128 is login,
// 144 is the serial/audio request, 168 is the login reply.
//
// All of them carry an "inner" block starting at byte 16 with its own length at byte 19
// and its own sequence counter at bytes 23-24, entirely separate from the transport
// sequence at bytes 6-7. Two sequence spaces in one packet, and conflating them means
// the radio rejects everything after the first exchange.

import { buildPacket, HEADER_LENGTH } from "@/lib/icom/packets";
import { passcode } from "@/lib/icom/passcode";

export const ControlLength = {
  auth: 64,
  streamOpen: 80,
  /** The answer to a login: 0x60 bytes, carrying the auth token. */
  loginReply: 96,
  login: 128,
  serialAudioRequest: 144,
  /**
   * Radio capabilities — model name, audio device name, and the id echoed back in the
   * stream request. Arrives unprompted AFTER the login reply, not instead of it.
   *
   * These two were conflated in an earlier version: `loginReply` was 168, so the real
   * 96-byte reply matched no case and was dropped on the floor. Against a real IC-7300
   * that presented as a login that timed out while the radio had in fact answered
   * immediately — the worst kind of bug, because the wire was working perfectly.
   */
  capabilities: 168,
} as const;

/** Default UDP ports. Adjustable per installation — the radio can be told to use
 * others, and nothing here assumes these beyond providing the defaults. */
export const IcomPorts = {
  control: 50001,
  serial: 50002,
  audio: 50003,
} as const;

/** The radio's audio is always this. Not negotiable, and conveniently 4x the decode rate. */
export const ICOM_AUDIO_SAMPLE_RATE = 48_000;

export interface SessionIds {
  /** Our own ID, chosen at open. */
  localSid: number;
  /** The radio's, learned from the open reply. */
  remoteSid: number;
}

/** Shared preamble: header plus the inner block's length, marker and sequence. */
function controlPacket(
  length: number,
  ids: SessionIds,
  innerLength: number,
  marker: number,
  innerSeq: number,
): Buffer {
  const b = buildPacket(length, {
    // Type is 0 for every control packet; the transport sequence at bytes 6-7 is
    // filled in by the tracked-send layer, not here.
    type: 0,
    seq: 0,
    senderId: ids.localSid,
    destinationId: ids.remoteSid,
  });
  b[19] = innerLength;
  b[20] = 0x01;
  b[21] = marker;
  b.writeUInt16LE(innerSeq & 0xffff, 23);
  return b;
}

// --------------------------------------------------------------------------- login

export interface LoginRequest {
  ids: SessionIds;
  username: string;
  password: string;
  /** Counter for the inner sequence space, incremented by the caller per packet. */
  innerSeq: number;
  /**
   * Two random bytes the radio echoes at the start of the auth ID it issues.
   *
   * Supplying them rather than generating them inside keeps this function pure and
   * lets a test assert the echo, which is the only way to notice that the radio has
   * answered *our* login rather than replayed someone else's.
   */
  authStartId: Buffer;
}

/**
 * The login packet: username and password, obfuscated, plus a client name.
 *
 * The client name is the literal ASCII `icom-pc`. It appears to be arbitrary, but it is
 * what every known implementation sends and there is no reason to find out the hard way
 * whether the radio cares.
 */
export function buildLogin(req: LoginRequest): Buffer {
  const b = controlPacket(ControlLength.login, req.ids, 0x70, 0x00, req.innerSeq);
  req.authStartId.copy(b, 26, 0, 2);
  passcode(req.username).copy(b, 64);
  passcode(req.password).copy(b, 80);
  b.write("icom-pc", 96, "ascii");
  return b;
}

export interface LoginReply {
  /** Six bytes the radio issues; every later auth packet must quote it. */
  authId: Buffer;
  /** The radio rejected the username or password. */
  invalidCredentials: boolean;
  /** How the radio describes the link, e.g. "FTTH". Informational. */
  connectionType: string;
}

/** The later, unprompted packet describing the radio. */
export interface Capabilities {
  /** Sixteen bytes echoed back in the serial/audio request. */
  a8ReplyId: Buffer;
  /** What the radio calls itself: "IC-705", "IC-7300". */
  radioName: string;
  /** The audio device name, e.g. "ICOM_VAUDIO". */
  audioName: string;
}

function readCString(buf: Buffer, start: number, max: number): string {
  const end = Math.min(start + max, buf.length);
  let stop = end;
  for (let i = start; i < end; i++) {
    if (buf[i] === 0) {
      stop = i;
      break;
    }
  }
  return buf.toString("ascii", start, stop);
}

export function parseLoginReply(buf: Buffer): LoginReply | null {
  if (buf.length !== ControlLength.loginReply) return null;
  if (buf.readUInt32LE(0) !== ControlLength.loginReply) return null;
  return {
    authId: Buffer.from(buf.subarray(26, 32)),
    // The radio's way of saying the credentials were wrong. Distinguishing this from
    // "no reply" is the difference between telling an operator to check the password
    // and sending them to look at their network.
    invalidCredentials: buf.subarray(48, 52).equals(Buffer.from([0xff, 0xff, 0xff, 0xfe])),
    connectionType: readCString(buf, 64, 16),
  };
}

export function parseCapabilities(buf: Buffer): Capabilities | null {
  if (buf.length !== ControlLength.capabilities) return null;
  if (buf.readUInt32LE(0) !== ControlLength.capabilities) return null;
  return {
    a8ReplyId: Buffer.from(buf.subarray(66, 82)),
    radioName: readCString(buf, 82, 16),
    audioName: readCString(buf, 114, 16),
  };
}

// ---------------------------------------------------------------------------- auth

/**
 * What an auth packet is asking for.
 *
 * The lifecycle matters more than the values. `acknowledge` then `confirm` completes
 * login; `confirm` repeated on a timer keeps the token alive; `remove` releases it.
 *
 * **Skipping `remove` on shutdown is the mistake with the worst symptom.** The radio
 * holds the session open, and the next connection is refused until it times out — which
 * presents as "the radio is broken" rather than "the last program exited untidily", and
 * sends people to reboot the rig.
 */
export const AuthMagic = {
  remove: 0x01,
  acknowledge: 0x02,
  confirm: 0x05,
} as const;

export type AuthMagicValue = (typeof AuthMagic)[keyof typeof AuthMagic];

export function buildAuth(req: {
  ids: SessionIds;
  authId: Buffer;
  magic: AuthMagicValue;
  innerSeq: number;
}): Buffer {
  const b = controlPacket(ControlLength.auth, req.ids, 0x30, req.magic, req.innerSeq);
  req.authId.copy(b, 26, 0, 6);
  return b;
}

export interface AuthReply {
  magic: number;
  /** True once the radio has accepted the second auth — login is complete. */
  complete: boolean;
}

export function parseAuthReply(buf: Buffer): AuthReply | null {
  if (buf.length !== ControlLength.auth) return null;
  if (buf.readUInt32LE(0) !== ControlLength.auth) return null;
  const magic = buf[21] ?? 0;
  return { magic, complete: magic === AuthMagic.confirm };
}

// -------------------------------------------------------------- serial and audio

export interface SerialAudioRequest {
  ids: SessionIds;
  authId: Buffer;
  a8ReplyId: Buffer;
  username: string;
  /**
   * The radio's own name, as it reported it in the login reply.
   *
   * kappanhang hardcodes `IC-705` here because that is the radio it was written for.
   * Sending the name the radio itself gave us is the portable choice and costs nothing;
   * hardcoding a model we do not have is a coin-flip that would be discovered only with
   * a 7300 on the bench, which is exactly the sort of thing that should not be left to
   * chance in code written before the hardware arrives.
   */
  radioName: string;
  innerSeq: number;
  serialPort?: number;
  audioPort?: number;
  sampleRate?: number;
  /** How much transmit audio the radio should buffer, in milliseconds. */
  txBufferMs?: number;
}

export function buildSerialAudioRequest(req: SerialAudioRequest): Buffer {
  const b = controlPacket(
    ControlLength.serialAudioRequest,
    req.ids,
    0x80,
    0x03,
    req.innerSeq,
  );
  req.authId.copy(b, 26, 0, 6);
  req.a8ReplyId.copy(b, 32, 0, 16);
  b.write(req.radioName.slice(0, 16), 64, "ascii");
  passcode(req.username).copy(b, 96);

  const sampleRate = req.sampleRate ?? ICOM_AUDIO_SAMPLE_RATE;
  b[112] = 0x01;
  b[113] = 0x01;
  b[114] = 0x04;
  b[115] = 0x04;
  // Every numeric field from here on is BIG-endian, unlike the header's length, type
  // and sequence. Same packet, both orders. Writing 48000 little-endian here yields a
  // radio that opens the streams and then sends audio nobody can decode.
  b.writeUInt16BE(sampleRate, 118);
  b.writeUInt16BE(sampleRate, 122);
  b.writeUInt16BE(req.serialPort ?? IcomPorts.serial, 126);
  b.writeUInt16BE(req.audioPort ?? IcomPorts.audio, 130);
  b.writeUInt16BE(req.txBufferMs ?? 500, 134);
  b[136] = 0x01;
  return b;
}

// ---------------------------------------------------------------------- stream open

/**
 * The 80-byte packet, which is also how the radio reports a refusal.
 *
 * Three `0xff` bytes at offset 48 mean authentication failed. The distinction
 * kappanhang draws is worth keeping: if the streams had never opened, the advice is to
 * reboot the radio, because it is probably still holding a stale session from a
 * previous run that did not send its token removal.
 */
export interface StreamOpenReply {
  authFailed: boolean;
  disconnected: boolean;
}

export function parseStreamOpenReply(buf: Buffer): StreamOpenReply | null {
  if (buf.length !== ControlLength.streamOpen) return null;
  if (buf.readUInt32LE(0) !== ControlLength.streamOpen) return null;
  const marker = buf.subarray(48, 51);
  return {
    authFailed: marker.equals(Buffer.from([0xff, 0xff, 0xff])),
    disconnected: marker.equals(Buffer.from([0x00, 0x00, 0x00])) && buf[64] === 0x01,
  };
}

/**
 * Classify a control-stream packet by length.
 *
 * Returns null for anything the transport layer should have taken (ping, idle,
 * retransmit) or that we do not recognise. Length alone is the discriminator here —
 * see the note at the top of this file.
 */
export function classifyControl(
  buf: Buffer,
): "auth" | "streamOpen" | "login" | "serialAudio" | "loginReply" | "capabilities" | null {
  if (buf.length < HEADER_LENGTH) return null;
  switch (buf.length) {
    case ControlLength.auth:
      return "auth";
    case ControlLength.streamOpen:
      return "streamOpen";
    case ControlLength.login:
      return "login";
    case ControlLength.serialAudioRequest:
      return "serialAudio";
    case ControlLength.loginReply:
      return "loginReply";
    case ControlLength.capabilities:
      return "capabilities";
    default:
      return null;
  }
}

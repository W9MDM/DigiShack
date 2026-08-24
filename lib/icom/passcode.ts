// Icom RS-BA1 credential obfuscation.
//
// Ported from kappanhang (https://github.com/nonoo/kappanhang), copyright 2020
// Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), MIT licensed. MIT permits use in
// this GPL-3.0 work provided the notice is kept, which is what this comment is.
//
// THIS IS NOT ENCRYPTION. It is a fixed substitution table, published in the source of
// every implementation including this one. It stops a password appearing in plain text
// in a packet capture and it stops nothing else. The radio password should be treated
// as readable by anyone on the network path.
//
// See docs/icom-protocol.md.

/**
 * The substitution table, indices 32–126 (printable ASCII).
 *
 * Stored as a string rather than a 95-entry object literal: the value at index `i` is
 * the char code at position `i - 32`. Same data, one line, and no chance of an entry
 * silently going missing in a merge.
 */
const TABLE = Uint8Array.from(
  [
    0x47, 0x5d, 0x4c, 0x42, 0x66, 0x20, 0x23, 0x46, 0x4e, 0x57, 0x45, 0x3d, 0x67, 0x76,
    0x60, 0x41, 0x62, 0x39, 0x59, 0x2d, 0x68, 0x7e, 0x7c, 0x65, 0x7d, 0x49, 0x29, 0x72,
    0x73, 0x78, 0x21, 0x6e, 0x5a, 0x5e, 0x4a, 0x3e, 0x71, 0x2c, 0x2a, 0x54, 0x3c, 0x3a,
    0x63, 0x4f, 0x43, 0x75, 0x27, 0x79, 0x5b, 0x35, 0x70, 0x48, 0x6b, 0x56, 0x6f, 0x34,
    0x32, 0x6c, 0x30, 0x61, 0x6d, 0x7b, 0x2f, 0x4b, 0x64, 0x38, 0x2b, 0x2e, 0x50, 0x40,
    0x3f, 0x55, 0x33, 0x37, 0x25, 0x77, 0x24, 0x26, 0x74, 0x6a, 0x28, 0x53, 0x4d, 0x69,
    0x22, 0x5c, 0x44, 0x31, 0x36, 0x58, 0x3b, 0x7a, 0x51, 0x5f, 0x52,
  ],
);

/** Every credential field on the wire is exactly this long, zero-padded. */
export const PASSCODE_LENGTH = 16;

/**
 * Obfuscate a username or password for the login packet.
 *
 * Always returns exactly 16 bytes. Two behaviours are bug-compatible with the
 * reference implementation on purpose, because matching it is the requirement:
 *
 * - Input longer than 16 characters is **truncated**, not rejected. A 20-character
 *   password authenticates on its first 16 characters, so an operator who sets a long
 *   password on the radio and pastes it here will connect, and the extra characters
 *   buy nothing.
 * - An index that falls outside the table becomes `0x00`. Unreachable for printable
 *   ASCII within 16 characters — the maximum is 126 + 15 = 141, which wraps to 46 —
 *   but reachable for control characters, and the reference yields zero there.
 */
export function passcode(s: string): Buffer {
  const out = Buffer.alloc(PASSCODE_LENGTH);
  const n = Math.min(s.length, PASSCODE_LENGTH);
  for (let i = 0; i < n; i++) {
    let p = s.charCodeAt(i) + i;
    // The wrap is `32 + p % 127`, which yields 32–158. Above 126 there is no table
    // entry and the reference returns zero; `TABLE[...] ?? 0` reproduces that.
    if (p > 126) p = 32 + (p % 127);
    out[i] = p >= 32 && p <= 126 ? (TABLE[p - 32] ?? 0) : 0;
  }
  return out;
}

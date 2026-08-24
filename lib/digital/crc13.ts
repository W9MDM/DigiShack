// CRC-13, as FT2 and MSK144 use it.
//
// Ported from wsjt-x_improved `lib/crc13.cpp` (GPL-3.0; DigiShack is GPL-3.0):
//
//     #define POLY 0x15D7
//     short crc13 (data, length) {
//       return boost::augmented_crc<13, POLY> (data, length);
//     }
//
// Two details from that file matter and are easy to get wrong:
//
//   * It is the AUGMENTED variant. A conventional CRC appends 13 zero bits and
//     divides; the augmented form expects those zeros to be present in the data
//     already. WSJT-X relies on this — its own comment says "assumes CRC is last
//     13 bits of the data and is set to zero". So the caller zeroes the CRC field
//     first, and the same routine both computes and checks.
//   * Initial remainder 0, no input or output reflection, no final XOR. Any of
//     those applied by habit produces a plausible-looking wrong answer.
//
// The check property is what makes this verifiable without external test
// vectors: recomputing over a message that already carries its correct CRC must
// give exactly zero.

/** Truncated polynomial — the x^13 term is implicit. */
export const CRC13_POLY = 0x15d7;

const MASK = 0x1fff; // 13 bits

/**
 * CRC-13 over a byte buffer, MSB-first.
 *
 * The buffer is expected to already contain zeroed CRC bits where the CRC will
 * go, matching the augmented convention.
 */
export function crc13(data: Uint8Array): number {
  let rem = 0;
  for (const byte of data) {
    for (let bit = 7; bit >= 0; bit--) {
      const top = (rem >> 12) & 1;
      rem = ((rem << 1) | ((byte >> bit) & 1)) & MASK;
      if (top) rem ^= CRC13_POLY;
    }
  }
  return rem;
}

/** True when the buffer's embedded CRC is correct. */
export function crc13Check(data: Uint8Array): boolean {
  return crc13(data) === 0;
}

/**
 * CRC-13 over a bit array (one bit per element), MSB-first.
 *
 * FT2 works in 77- and 90-bit vectors rather than bytes, so this avoids the
 * caller packing and unpacking around a byte-oriented API. The bit length need
 * not be a multiple of eight.
 */
export function crc13Bits(bits: ArrayLike<number>): number {
  let rem = 0;
  for (let i = 0; i < bits.length; i++) {
    const top = (rem >> 12) & 1;
    rem = ((rem << 1) | (bits[i]! & 1)) & MASK;
    if (top) rem ^= CRC13_POLY;
  }
  return rem;
}

/**
 * The exact buffer FT2 computes its CRC over: 12 bytes, i.e. 96 bits.
 *
 * This is NOT the 90-bit information vector, which is the intuitive assumption
 * and is wrong. `encode_128_90.f90` does:
 *
 *     tmpchar(1:77)  = the message bits
 *     tmpchar(78:80) = '000'                  ! pad to a byte boundary
 *     i1MsgBytes     = 0                      ! 12 bytes
 *     read(tmpchar,'(10b8)') i1MsgBytes(1:10) ! first 80 bits
 *     ncrc13 = crc13(i1MsgBytes, 12)          ! over all 96 bits
 *
 * So the CRC input is 77 message bits, three zero pad bits, then two entirely
 * zero bytes. Those last 16 zeros supply the augmentation. Computing over the
 * 90-bit vector instead produces a self-consistent but non-interoperable CRC —
 * it round-trips perfectly against itself and no real FT2 station can read it.
 * Only reading the caller reveals this; the CRC routine alone does not say.
 */
export function ft2Crc13Buffer(messageBits: ArrayLike<number>): Uint8Array {
  const buf = new Uint8Array(12);
  for (let i = 0; i < 77; i++) {
    if (messageBits[i]! & 1) buf[i >> 3] = buf[i >> 3]! | (0x80 >> (i & 7));
  }
  // Bits 77..95 stay zero: the three pad bits and the two zero bytes.
  return buf;
}

/** FT2's CRC-13 over a 77-bit message, using the reference's 12-byte buffer. */
export function ft2Crc13(messageBits: ArrayLike<number>): number {
  if (messageBits.length !== 77) {
    throw new Error(`FT2 needs 77 message bits, got ${messageBits.length}`);
  }
  return crc13(ft2Crc13Buffer(messageBits));
}

/**
 * Build FT2's 90 information bits: 77 message bits then the 13-bit CRC.
 *
 * The CRC comes from `ft2Crc13`, i.e. the 12-byte buffer, and is then written
 * into bits 77..89 big-endian — `write(tmpchar(78:90),'(b13)')` in the reference.
 */
export function ft2AddCrc13(messageBits: ArrayLike<number>): Uint8Array {
  const crc = ft2Crc13(messageBits);
  const out = new Uint8Array(90);
  for (let i = 0; i < 77; i++) out[i] = messageBits[i]! & 1;
  for (let i = 0; i < 13; i++) out[77 + i] = (crc >> (12 - i)) & 1;
  return out;
}

/**
 * Verify a 90-bit vector: recompute the CRC from its message half and compare.
 *
 * Cannot use the zero-remainder trick, because the CRC was not computed over
 * these 90 bits — it was computed over the padded 96-bit buffer.
 */
export function ft2CheckCrc13(bits90: ArrayLike<number>): boolean {
  if (bits90.length !== 90) return false;
  const msg = new Uint8Array(77);
  for (let i = 0; i < 77; i++) msg[i] = bits90[i]! & 1;
  const expect = ft2Crc13(msg);
  let got = 0;
  for (let i = 0; i < 13; i++) got = (got << 1) | (bits90[77 + i]! & 1);
  return got === expect;
}

// LDPC(128,90) encoder for FT2.
//
// Ported from wsjt-x_improved `lib/encode_128_90.f90` and
// `lib/ldpc_128_90_generator.f90` (GPL-3.0; DigiShack is GPL-3.0).
//
// Systematic code: the 128-bit codeword is the 90 information bits unchanged,
// followed by 38 parity bits. Each parity bit is the mod-2 sum of the message
// bits selected by one row of the generator matrix.
//
// The generator is stored exactly as the reference stores it: 38 rows of 23 hex
// characters. The last character contributes only its top TWO bits, giving
// 22*4 + 2 = 90 columns. Taking all four bits of that final character — the
// obvious reading — produces a 92-column matrix and silently wrong parity.

/** M = N - K = 128 - 90. */
export const LDPC_PARITY_BITS = 38;
export const LDPC_INFO_BITS = 90;
export const LDPC_CODEWORD_BITS = 128;

/**
 * Generator matrix rows, verbatim from `ldpc_128_90_generator.f90`.
 *
 * Kept as hex strings rather than expanded, so they can be compared against the
 * reference by eye without reformatting.
 */
const GENERATOR_HEX: readonly string[] = [
  "a08ea80879050a5e94da994", "59f3b48040ca089c81ee880",
  "e4070262802e31b7b17d3dc", "95cbcbaf032dc3d960bacc8",
  "c4d79b5dcc21161a254ffbc", "93fde9cdbf2622a70868424",
  "e73b888bb1b01167379ba28", "45a0d0a0f39a7ad2439949c",
  "759acef19444bcad79c4964", "71eb4dddf4f5ed9e2ea17e0",
  "80f0ad76fb247d6b4ca8d38", "184fff3aa1b82dc66640104",
  "ca4e320bb382ed14cbb1094", "52514447b90e25b9e459e28",
  "dd10c1666e071956bd0df38", "99c332a0b792a2da8ef1ba8",
  "7bd9f688e7ed402e231aaac", "00fcad76eb647d6a0ca8c38",
  "6ac8d0499c43b02eed78d70", "2c2c764baf795b4788db010",
  "0e907bf9e280d2624823dd0", "b857a6e315afd8c1c925e64",
  "8deb58e22d73a141cae3778", "22d3cb80d92d6ac132dfe08",
  "754763877b28c187746855c", "1d1bb7cf6953732e04ebca4",
  "2c65e0ea4466ab9f5e1deec", "6dc530ca37fc916d1f84870",
  "49bccbbee152355be7ac984", "e8387f3f4367cf45a150448",
  "8ce25e03d67d51091c81884", "b798012ffa40a93852752c8",
  "2e43307933adfca37adc3c8", "ca06e0a42ca1ec782d6c06c",
  "c02b762927556a7039e638c", "4a3e9b7d08b6807f8619fac",
  "45e8030f68997bb68544424", "7e79362c16773efc6482e30",
];

/**
 * Expand the hex rows into a 38x90 bit matrix.
 *
 * The final hex character of each row yields two bits, not four — that is what
 * makes the row 90 columns wide rather than 92.
 */
function buildGenerator(): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (const hex of GENERATOR_HEX) {
    if (hex.length !== 23) {
      throw new Error(`Generator row must be 23 hex characters, got ${hex.length}`);
    }
    const row = new Uint8Array(LDPC_INFO_BITS);
    let col = 0;
    for (let j = 0; j < 23; j++) {
      const nibble = parseInt(hex[j]!, 16);
      if (Number.isNaN(nibble)) throw new Error(`Bad hex in generator row: ${hex}`);
      // Fortran: ibmax = 4, except 2 on the 23rd character.
      const bits = j === 22 ? 2 : 4;
      for (let b = 0; b < bits; b++) {
        // btest(istr, 4-jj) with jj counting from 1 — i.e. MSB of the nibble first.
        row[col++] = (nibble >> (3 - b)) & 1;
      }
    }
    if (col !== LDPC_INFO_BITS) {
      throw new Error(`Generator row expanded to ${col} columns, expected 90`);
    }
    rows.push(row);
  }
  if (rows.length !== LDPC_PARITY_BITS) {
    throw new Error(`Expected ${LDPC_PARITY_BITS} generator rows, got ${rows.length}`);
  }
  return rows;
}

let generator: Uint8Array[] | null = null;

/** The expanded generator matrix, built once. */
export function ldpcGenerator(): Uint8Array[] {
  generator ??= buildGenerator();
  return generator;
}

/**
 * Encode 90 information bits into a 128-bit codeword.
 *
 * Systematic, so the message occupies the first 90 bits verbatim and a decoder
 * that gives up on the parity can still read the payload.
 */
export function encode128_90(infoBits: ArrayLike<number>): Uint8Array {
  if (infoBits.length !== LDPC_INFO_BITS) {
    throw new Error(`LDPC(128,90) needs ${LDPC_INFO_BITS} information bits, got ${infoBits.length}`);
  }
  const gen = ldpcGenerator();
  const codeword = new Uint8Array(LDPC_CODEWORD_BITS);
  for (let i = 0; i < LDPC_INFO_BITS; i++) codeword[i] = infoBits[i]! & 1;

  for (let i = 0; i < LDPC_PARITY_BITS; i++) {
    const row = gen[i]!;
    let sum = 0;
    for (let j = 0; j < LDPC_INFO_BITS; j++) sum ^= (infoBits[j]! & 1) & row[j]!;
    codeword[LDPC_INFO_BITS + i] = sum;
  }
  return codeword;
}

/**
 * Recompute the parity of a codeword and report which checks fail.
 *
 * Not a decoder — it corrects nothing. It exists so the encoder can be verified
 * and so a caller can tell "clean" from "damaged" without running belief
 * propagation.
 */
export function checkParity(codeword: ArrayLike<number>): number[] {
  if (codeword.length !== LDPC_CODEWORD_BITS) {
    throw new Error(`Codeword must be ${LDPC_CODEWORD_BITS} bits`);
  }
  const gen = ldpcGenerator();
  const bad: number[] = [];
  for (let i = 0; i < LDPC_PARITY_BITS; i++) {
    const row = gen[i]!;
    let sum = 0;
    for (let j = 0; j < LDPC_INFO_BITS; j++) sum ^= (codeword[j]! & 1) & row[j]!;
    if (sum !== (codeword[LDPC_INFO_BITS + i]! & 1)) bad.push(i);
  }
  return bad;
}

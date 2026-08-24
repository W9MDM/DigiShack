// Log-domain belief-propagation decoder for FT2's LDPC(128,90).
//
// Ported from wsjt-x_improved `lib/bpdecode128_90.f90`, its included tables in
// `lib/ldpc_128_90_reordered_parity.f90`, `lib/platanh.f90`, and the CRC check in
// `lib/ft8/chkcrc13a.f90` (GPL-3.0; DigiShack is GPL-3.0).
//
// This is what makes FT2 work at low signal-to-noise. Hard-decision parity
// checking (`checkParity` in ./ldpc12890.ts) only says whether a frame is already
// clean; belief propagation uses the *confidence* of each symbol decision and
// recovers frames with several wrong bits. On a weak signal that is the
// difference between a decode and silence.
//
// Two independent descriptions of the same code now live in this codebase, and it
// is worth being explicit about why:
//
//   * ./ldpc12890.ts holds the DENSE 38x90 generator matrix, ~49% ones. That is
//     what you encode with.
//   * The sparse parity-check graph below has row weight 10-11 and column weight
//     exactly 3. That is what you decode with — belief propagation needs a sparse
//     graph or it has nothing to propagate.
//
// They must describe the same code, and `scripts/check-ft2.ts` asserts it: every
// codeword out of `encode128_90` satisfies all 38 sparse checks. That single
// assertion validates both transcriptions against each other, which matters
// because neither can be verified by round-tripping against itself.
//
// LLR sign convention, matching the reference: POSITIVE means the bit is more
// likely to be 1. Reversed, the decoder fails on clean input and occasionally
// "succeeds" on noise.

import { ft2CheckCrc13 } from "@/lib/digital/crc13";

/** Codeword length. */
const N = 128;
/** Information bits. */
const K = 90;
/** Parity checks. */
const M = N - K;
/** Checks per bit — the column weight, constant across this graph. */
const NCW = 3;

/**
 * `Nm` — for each of the 38 checks, the 1-based bit indices it covers.
 *
 * Transcribed verbatim from `ldpc_128_90_reordered_parity.f90`, kept as strings
 * so the rows can be diffed against the Fortran by eye. The reference also ships
 * `Mn` (checks per bit) and `nrw` (row weights); both are derived below instead
 * of transcribed, because a derivation cannot disagree with this table whereas a
 * second hand-copied table can. They were checked against the Fortran versions
 * and reproduce them exactly, including the ordering within each row.
 */
const NM_ROWS: readonly string[] = [
  "2 15 27 40 53 65 77 91 94 115",
  "3 6 28 41 54 66 78 92 94 120",
  "4 16 29 42 55 67 77 90 93 106 118",
  "5 17 30 43 52 64 79 92 102 119",
  "6 18 31 44 56 68 80 89 95 108 125",
  "7 14 32 45 57 68 79 90 96 116 121",
  "4 19 33 43 58 69 81 97 107 121",
  "2 20 30 39 54 70 80 98 107 128",
  "3 21 34 46 59 67 79 99 107 123",
  "8 15 29 47 56 71 82 100 111 128",
  "9 22 34 44 52 72 83 101 103 126",
  "10 17 26 48 60 73 84 91 110 121",
  "7 23 35 38 55 73 82 101 109 120",
  "11 19 36 49 53 70 85 102 104 126",
  "10 20 37 46 58 71 85 105 109 122",
  "5 23 37 47 57 74 86 93 110 125",
  "12 13 27 41 61 68 87 97 109 113",
  "11 16 38 45 58 72 78 99 108 115",
  "4 22 31 41 60 74 82 105 112 115",
  "12 24 32 39 62 63 88 99 102 118",
  "1 19 25 45 62 75 77 100 112 119",
  "6 25 33 50 59 71 83 98 117 118",
  "10 16 39 51 53 66 83 95 111 124",
  "9 24 35 42 59 76 89 94 114 122",
  "7 17 37 50 54 75 88 111 114 123",
  "11 25 35 48 61 65 88 105 116 125",
  "9 21 32 49 55 69 84 86 95 113 119",
  "2 18 28 47 63 73 87 96 106 126",
  "12 26 31 49 64 72 81 100 106 120",
  "13 15 28 48 51 76 85 93 103 123",
  "8 20 36 44 57 75 78 91 113 117",
  "5 21 29 40 51 70 81 96 117 122",
  "8 26 34 40 62 74 80 92 116 127",
  "1 13 14 36 42 64 66 84 101 108",
  "14 22 27 50 63 69 89 104 110 128",
  "1 18 30 46 60 65 90 97 114 127",
  "3 23 33 52 56 76 87 104 112 124",
  "24 38 43 61 67 86 98 103 124 127",
];

function buildGraph(): {
  nm: number[][];
  mn: number[][];
  nrw: number[];
} {
  const nm = NM_ROWS.map((row) => row.split(" ").map(Number));
  if (nm.length !== M) throw new Error(`Expected ${M} check rows, got ${nm.length}`);
  const nrw = nm.map((r) => r.length);
  const mn: number[][] = Array.from({ length: N }, () => []);
  for (let j = 0; j < nm.length; j++) {
    for (const bit of nm[j]!) {
      if (!Number.isInteger(bit) || bit < 1 || bit > N) {
        throw new Error(`Bad bit index ${bit} in check ${j + 1}`);
      }
      mn[bit - 1]!.push(j + 1);
    }
  }
  for (let i = 0; i < N; i++) {
    // Column weight is exactly 3 for every bit. If a transcription slip dropped
    // or duplicated an index this is where it surfaces, rather than as a decoder
    // that quietly performs worse than it should.
    if (mn[i]!.length !== NCW) {
      throw new Error(`Bit ${i + 1} appears in ${mn[i]!.length} checks, expected ${NCW}`);
    }
  }
  return { nm, mn, nrw };
}

const GRAPH = buildGraph();
const NM = GRAPH.nm;
const MN = GRAPH.mn;
const NRW = GRAPH.nrw;

/**
 * `platanh` — the reference's piecewise-linear atanh.
 *
 * Ported rather than replaced with `Math.atanh`, and not only for fidelity: the
 * saturation at ±7 is load-bearing. Real `atanh` goes to infinity as its argument
 * approaches ±1, which happens routinely on a strong signal, and one infinite LLR
 * turns every later sum into NaN. The approximation bounds the message magnitude
 * for free.
 */
export function platanh(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  if (z <= 0.664) return x / 0.83;
  if (z <= 0.9217) return (sign * (z - 0.4064)) / 0.322;
  if (z <= 0.9951) return (sign * (z - 0.8378)) / 0.0524;
  if (z <= 0.9998) return (sign * (z - 0.9914)) / 0.0012;
  return sign * 7.0;
}

export interface BpDecodeResult {
  ok: boolean;
  /** The 77 message bits, on success. */
  message?: Uint8Array;
  /** The 128-bit codeword as finally decided — present even on failure. */
  codeword: Uint8Array;
  /**
   * Bits whose final decision disagreed with the raw input LLR.
   *
   * WSJT-X shows this as a quality indicator: a decode that needed 20 bits
   * corrected sits far closer to the noise floor than one that needed 2. It is
   * −1 when the decode failed.
   */
  hardErrors: number;
  /** Iterations used. */
  iterations: number;
  /** Unsatisfied parity checks when it gave up; 0 on success. */
  unsatisfiedChecks: number;
  reason?: string;
}

/**
 * Decode 128 log-likelihood ratios into a 77-bit message.
 *
 * Success requires BOTH a valid codeword and a valid CRC-13. Parity alone is not
 * enough: converging to the *wrong* codeword is an ordinary event at low SNR, not
 * a pathological one, and the CRC is what stops a confidently wrong callsign
 * reaching the log.
 *
 * `apmask` marks bits known a priori — WSJT-X uses it for hinted decoding, where
 * the expected callsigns are already known. Masked bits keep their input LLR and
 * ignore the graph. Omit it for the ordinary case.
 */
export function bpDecode128_90(
  llr: ArrayLike<number>,
  opts: { maxIterations?: number; apmask?: ArrayLike<number> } = {},
): BpDecodeResult {
  if (llr.length !== N) {
    throw new Error(`bpDecode128_90 needs ${N} LLRs, got ${llr.length}`);
  }
  const maxIterations = opts.maxIterations ?? 30;
  const apmask = opts.apmask;

  // tov[bit][k] — the message from the k-th check covering this bit, back to it.
  const tov: Float64Array[] = Array.from({ length: N }, () => new Float64Array(NCW));
  // toc[check][i] — the message from the i-th bit of this check, up to it.
  const toc: Float64Array[] = Array.from({ length: M }, (_, j) => new Float64Array(NRW[j]!));
  const tanhtoc: Float64Array[] = Array.from({ length: M }, (_, j) => new Float64Array(NRW[j]!));

  const zn = new Float64Array(N);
  const cw = new Uint8Array(N);
  let ncnt = 0;
  let nclast = 0;
  let ncheck = 0;
  let iter = 0;

  for (iter = 0; iter <= maxIterations; iter++) {
    for (let i = 0; i < N; i++) {
      if (apmask && apmask[i] === 1) {
        zn[i] = llr[i]!;
      } else {
        const t = tov[i]!;
        zn[i] = llr[i]! + t[0]! + t[1]! + t[2]!;
      }
      cw[i] = zn[i]! > 0 ? 1 : 0;
    }

    // Test for a codeword BEFORE iterating, so clean input costs a single pass.
    ncheck = 0;
    for (let j = 0; j < M; j++) {
      const row = NM[j]!;
      let sum = 0;
      for (let i = 0; i < row.length; i++) sum += cw[row[i]! - 1]!;
      if (sum % 2 !== 0) ncheck++;
    }

    if (ncheck === 0) {
      const info = cw.subarray(0, K);
      if (ft2CheckCrc13(info)) {
        let hard = 0;
        for (let i = 0; i < N; i++) if ((2 * cw[i]! - 1) * llr[i]! < 0) hard++;
        return {
          ok: true,
          message: Uint8Array.from(info.subarray(0, 77)),
          codeword: Uint8Array.from(cw),
          hardErrors: hard,
          iterations: iter,
          unsatisfiedChecks: 0,
        };
      }
      // A valid codeword with a bad CRC means we landed on the wrong one. The
      // reference keeps going, and so do we — the graph messages may still pull
      // the decision elsewhere.
    }

    if (iter > 0) {
      // Early stop: once the unsatisfied-check count has failed to fall for three
      // consecutive iterations and is still high, it is not going to.
      if (ncheck - nclast < 0) ncnt = 0;
      else ncnt++;
      if (ncnt >= 3 && iter >= 5 && ncheck > 10) {
        return {
          ok: false,
          codeword: Uint8Array.from(cw),
          hardErrors: -1,
          iterations: iter,
          unsatisfiedChecks: ncheck,
          reason: "stalled — unsatisfied checks stopped falling",
        };
      }
    }
    nclast = ncheck;

    // Bits -> checks: forward everything except what this check itself said.
    for (let j = 0; j < M; j++) {
      const row = NM[j]!;
      const t = toc[j]!;
      for (let i = 0; i < row.length; i++) {
        const ibj = row[i]! - 1;
        let v = zn[ibj]!;
        const checks = MN[ibj]!;
        const back = tov[ibj]!;
        for (let kk = 0; kk < NCW; kk++) {
          if (checks[kk]! - 1 === j) v -= back[kk]!;
        }
        t[i] = v;
      }
    }

    // Checks -> bits, in the tanh domain.
    for (let j = 0; j < M; j++) {
      const t = toc[j]!;
      const th = tanhtoc[j]!;
      for (let i = 0; i < t.length; i++) th[i] = Math.tanh(-t[i]! / 2);
    }

    for (let j = 0; j < N; j++) {
      const checks = MN[j]!;
      const out = tov[j]!;
      for (let i = 0; i < NCW; i++) {
        const ichk = checks[i]! - 1;
        const row = NM[ichk]!;
        const th = tanhtoc[ichk]!;
        // Product over every OTHER bit in this check — excluding bit j is the
        // whole point of message passing. Include it and the decoder feeds its
        // own output back and converges on nonsense.
        let tmn = 1;
        for (let q = 0; q < row.length; q++) {
          if (row[q]! - 1 !== j) tmn *= th[q]!;
        }
        out[i] = 2 * platanh(-tmn);
      }
    }
  }

  return {
    ok: false,
    codeword: Uint8Array.from(cw),
    hardErrors: -1,
    iterations: iter,
    unsatisfiedChecks: ncheck,
    reason: `no codeword after ${maxIterations} iterations`,
  };
}

/**
 * Verify a codeword against the SPARSE parity graph.
 *
 * Distinct from `checkParity` in ./ldpc12890.ts, which uses the dense generator.
 * Both must agree on every codeword; that is the cross-check validating the two
 * transcriptions against each other.
 */
export function checkSparseParity(codeword: ArrayLike<number>): number[] {
  if (codeword.length !== N) throw new Error(`Codeword must be ${N} bits`);
  const bad: number[] = [];
  for (let j = 0; j < M; j++) {
    const row = NM[j]!;
    let sum = 0;
    for (let i = 0; i < row.length; i++) sum += codeword[row[i]! - 1]! & 1;
    if (sum % 2 !== 0) bad.push(j);
  }
  return bad;
}

/** The parity graph, for tests and diagnostics. */
export function parityGraph(): {
  nm: readonly (readonly number[])[];
  mn: readonly (readonly number[])[];
  nrw: readonly number[];
} {
  return { nm: NM, mn: MN, nrw: NRW };
}

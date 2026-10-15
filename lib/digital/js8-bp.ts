// Log-domain belief-propagation decoder for JS8's LDPC(174,87).
//
// Ported from JS8Call's lib/ft8/bpdecode174.f90 (GPL-3.0; DigiShack is GPL-3.0), the same
// algorithm lib/digital/bpdecode12890.ts ports for FT2's code and with the same shape: the
// sparse graph from js8-ldpc-tables.ts, bits-to-checks and checks-to-bits in the tanh
// domain, a codeword test before every iteration so clean input costs one pass, and the
// reference's early stop when the unsatisfied-check count has stopped falling. The LLR
// convention is the reference's: POSITIVE means the bit is more likely to be 1.
//
// What differs from FT2's: three checks per bit again, but 5, 6 or 7 bits per check (the
// nrw table), the early-stop thresholds of this reference (five flat iterations, after
// ten, with more than fifteen checks still unsatisfied), and the CRC that decides whether
// a codeword is a frame (js8UnpackFrame).

import {
  JS8_CODEWORD_BITS,
  JS8_INFO_BITS,
  JS8_PARITY_BITS,
  js8InfoBitsOf,
  js8UnpackFrame,
} from "@/lib/digital/js8";
import { JS8_LDPC_MN, JS8_LDPC_NM, JS8_LDPC_NRW } from "@/lib/digital/js8-ldpc-tables";
import { platanh } from "@/lib/digital/bpdecode12890";

const N = JS8_CODEWORD_BITS;
const M = JS8_PARITY_BITS;
const NCW = 3;

export interface Js8BpResult {
  ok: boolean;
  /** The 87 information bits, when a codeword with a good CRC was found. */
  info?: Uint8Array;
  codeword: Uint8Array;
  hardErrors: number;
  iterations: number;
  unsatisfiedChecks: number;
  reason?: string;
}

export function js8BpDecode(llr: ArrayLike<number>, opts: { maxIterations?: number } = {}): Js8BpResult {
  if (llr.length !== N) throw new Error(`js8BpDecode needs ${N} LLRs, got ${llr.length}`);
  const maxIterations = opts.maxIterations ?? 30;

  const tov: Float64Array[] = Array.from({ length: N }, () => new Float64Array(NCW));
  const toc: Float64Array[] = Array.from({ length: M }, (_, j) => new Float64Array(JS8_LDPC_NRW[j]!));
  const tanhtoc: Float64Array[] = Array.from({ length: M }, (_, j) => new Float64Array(JS8_LDPC_NRW[j]!));
  const zn = new Float64Array(N);
  const cw = new Uint8Array(N);
  let ncnt = 0;
  let nclast = 0;
  let ncheck = 0;
  let iter = 0;

  for (iter = 0; iter <= maxIterations; iter++) {
    for (let i = 0; i < N; i++) {
      const t = tov[i]!;
      zn[i] = llr[i]! + t[0]! + t[1]! + t[2]!;
      cw[i] = zn[i]! > 0 ? 1 : 0;
    }

    ncheck = 0;
    for (let j = 0; j < M; j++) {
      const row = JS8_LDPC_NM[j]!;
      let sum = 0;
      for (let i = 0; i < JS8_LDPC_NRW[j]!; i++) sum += cw[row[i]! - 1]!;
      if (sum % 2 !== 0) ncheck++;
    }

    if (ncheck === 0) {
      const info = js8InfoBitsOf(cw);
      if (js8UnpackFrame(info).crcOk) {
        let hard = 0;
        for (let i = 0; i < N; i++) if ((2 * cw[i]! - 1) * llr[i]! < 0) hard++;
        return {
          ok: true,
          info: Uint8Array.from(info),
          codeword: Uint8Array.from(cw),
          hardErrors: hard,
          iterations: iter,
          unsatisfiedChecks: 0,
        };
      }
      // A codeword with a bad CRC: the reference returns it as a decode and lets the
      // CRC check outside reject it. Here that is the same as not having found one, and
      // the messages may still move elsewhere, so carry on.
    }

    if (iter > 0) {
      if (ncheck - nclast < 0) ncnt = 0;
      else ncnt++;
      if (ncnt >= 5 && iter >= 10 && ncheck > 15) {
        return {
          ok: false,
          codeword: Uint8Array.from(cw),
          hardErrors: -1,
          iterations: iter,
          unsatisfiedChecks: ncheck,
          reason: "stalled - unsatisfied checks stopped falling",
        };
      }
    }
    nclast = ncheck;

    // Bits -> checks: what the bit knows, less what this check told it.
    for (let j = 0; j < M; j++) {
      const row = JS8_LDPC_NM[j]!;
      const t = toc[j]!;
      for (let i = 0; i < JS8_LDPC_NRW[j]!; i++) {
        const ibj = row[i]! - 1;
        let v = zn[ibj]!;
        const checks = JS8_LDPC_MN[ibj]!;
        const back = tov[ibj]!;
        for (let kk = 0; kk < NCW; kk++) if (checks[kk]! - 1 === j) v -= back[kk]!;
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
      const checks = JS8_LDPC_MN[j]!;
      const out = tov[j]!;
      for (let i = 0; i < NCW; i++) {
        const ichk = checks[i]! - 1;
        const row = JS8_LDPC_NM[ichk]!;
        const th = tanhtoc[ichk]!;
        let tmn = 1;
        for (let q = 0; q < JS8_LDPC_NRW[ichk]!; q++) if (row[q]! - 1 !== j) tmn *= th[q]!;
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

/** Hard bits to LLRs of a given confidence, for tests. */
export function js8HardLlr(bits: ArrayLike<number>, confidence = 4): Float64Array {
  const llr = new Float64Array(JS8_CODEWORD_BITS);
  for (let i = 0; i < JS8_CODEWORD_BITS; i++) llr[i] = bits[i] ? confidence : -confidence;
  return llr;
}

export { JS8_INFO_BITS };

// Interval analysis of the values the generated CSS computes for each IR node.
//
// The CSS templates compute the mathematical (un-wrapped) result of every operation, so
// the intervals here are over unbounded integers: a Wasm wrap-around shows up as an
// interval that leaves the i32 range, and therefore the exact range as well. The result is
// an over-approximation; translate() turns every node that may leave the exactly
// representable range into a CSS guard, so a viewer who edits the initial value sees
// either the exact Wasm result or OUT OF RANGE, never a plausible wrong number.
import { topoOrder } from './ir.js';

const BIG = 2 ** 62; // cap to keep arithmetic finite; anything this large is out of range anyway
const cap = (v) => Math.max(-BIG, Math.min(BIG, v));
export const interval = (lo, hi) => ({ lo: cap(Math.min(lo, hi)), hi: cap(Math.max(lo, hi)) });
const I = interval;
const hull = (a, b) => I(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi));
const BOOL = I(0, 1);

// Smallest n with [lo, hi] inside [-2^n, 2^n).
function width(r) {
  let n = 0;
  while (n < 63 && (r.lo < -(2 ** n) || r.hi >= 2 ** n)) n++;
  return n;
}

export function transfer(n, A, B, C) {
  const cb = n.args[1]?.op === 'const' ? n.args[1].value : undefined;
  switch (n.op) {
    case 'const': return I(n.value, n.value);
    case 'add': return I(A.lo + B.lo, A.hi + B.hi);
    case 'sub': return I(A.lo - B.hi, A.hi - B.lo);
    case 'mul': {
      const p = [A.lo * B.lo, A.lo * B.hi, A.hi * B.lo, A.hi * B.hi];
      return I(Math.min(...p), Math.max(...p));
    }
    case 'div_s': {
      if (cb !== undefined && cb !== 0) return I(Math.trunc(A.lo / cb), Math.trunc(A.hi / cb));
      const m = Math.max(Math.abs(A.lo), Math.abs(A.hi));
      return I(-m, m);
    }
    case 'rem_s': {
      const m = cb !== undefined && cb !== 0 ? Math.abs(cb) - 1 : Math.max(Math.abs(B.lo), Math.abs(B.hi));
      const lo = A.lo >= 0 ? 0 : -Math.min(m, -A.lo);
      const hi = A.hi <= 0 ? 0 : Math.min(m, A.hi);
      return I(lo, hi);
    }
    case 'div_u': {
      if (cb !== undefined && cb > 0) {
        if (A.lo >= 0) return I(Math.floor(A.lo / cb), Math.floor(A.hi / cb));
        return I(Math.min(0, Math.floor(Math.max(A.lo, 0) / cb)), Math.floor((2 ** 32 - 1) / cb));
      }
      if (cb !== undefined && cb < 0) return BOOL;
      return I(Math.min(0, A.lo), Math.max(0, A.hi)); // valid domain a >= 0, b > 0 is guarded
    }
    case 'rem_u': {
      if (cb !== undefined && cb > 0) return I(0, cb - 1);
      if (cb !== undefined && cb < 0) return I(Math.min(A.lo, 0), Math.max(A.hi, A.lo < 0 ? A.lo - cb : 0));
      return I(Math.min(0, A.lo), Math.max(0, A.hi, B.hi));
    }
    case 'and': case 'or': case 'xor': {
      if (n.op === 'and') {
        if (A.lo >= 0 && B.lo >= 0) return I(0, Math.min(A.hi, B.hi));
        if (A.lo >= 0) return I(0, A.hi);
        if (B.lo >= 0) return I(0, B.hi);
      }
      if (n.op === 'xor' && cb === -1) return I(-A.hi - 1, -A.lo - 1);
      const w = Math.max(width(A), width(B));
      if (A.lo >= 0 && B.lo >= 0) return I(0, 2 ** w - 1);
      return I(-(2 ** w), 2 ** w - 1);
    }
    case 'shl': {
      if (cb !== undefined) { const f = 2 ** (cb & 31); return I(A.lo * f, A.hi * f); }
      return I(Math.min(A.lo, A.lo * 2 ** 31), Math.max(A.hi, A.hi * 2 ** 31));
    }
    case 'shr_s': {
      if (cb !== undefined) { const f = 2 ** (cb & 31); return I(Math.floor(A.lo / f), Math.floor(A.hi / f)); }
      return I(Math.min(A.lo, A.lo < 0 ? -1 : 0), Math.max(A.hi, 0));
    }
    case 'shr_u': {
      if (cb === undefined) return I(Math.min(0, A.lo), 2 ** 32);
      const k = cb & 31;
      if (k === 0) return A;
      const f = 2 ** k, top = 2 ** (32 - k);
      const c = [];
      if (A.hi >= 0) c.push(Math.floor(Math.max(A.lo, 0) / f), Math.floor(A.hi / f));
      if (A.lo < 0) c.push(Math.floor(A.lo / f) + top, Math.floor(Math.min(A.hi, -1) / f) + top);
      return I(Math.min(...c), Math.max(...c));
    }
    case 'clz': case 'ctz': case 'popcnt': return I(0, 32);
    case 'extend8_s': return I(-128, 127);
    case 'extend16_s': return I(-32768, 32767);
    case 'select': return hull(B, C);
    case 'eqz': case 'eq': case 'ne': case 'lt_s': case 'lt_u': case 'gt_s': case 'gt_u':
    case 'le_s': case 'le_u': case 'ge_s': case 'ge_u': case 'land': case 'lor': case 'lnot':
      return BOOL;
    default:
      return I(-BIG, BIG);
  }
}

// roots: IR nodes; inputRange: { lo, hi } for every IR input.
export function analyzeRanges(roots, inputRange) {
  const ranges = new Map();
  for (const n of topoOrder(roots)) {
    if (n.op === 'input') { ranges.set(n.id, I(inputRange.lo, inputRange.hi)); continue; }
    const [A, B, C] = n.args.map((a) => ranges.get(a.id));
    ranges.set(n.id, transfer(n, A, B, C));
  }
  return ranges;
}

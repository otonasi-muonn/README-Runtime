// Expression IR for pure i32 functions.
// Nodes are hash-consed (structurally shared), constant-folded and lightly simplified.
// `evalExact` gives the true WebAssembly i32 result for every node; it is the oracle that
// both the CSS translation and the real Wasm engine are checked against.

const INT_MIN = -2147483648;
const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor', 'eq', 'ne', 'land', 'lor']);
const BOOL_OPS = new Set(['eqz', 'eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u', 'land', 'lor', 'lnot']);

export const ARITY = {
  const: 0, input: 0,
  add: 2, sub: 2, mul: 2, div_s: 2, div_u: 2, rem_s: 2, rem_u: 2,
  and: 2, or: 2, xor: 2, shl: 2, shr_s: 2, shr_u: 2, rotl: 2, rotr: 2,
  clz: 1, ctz: 1, popcnt: 1, eqz: 1, extend8_s: 1, extend16_s: 1,
  eq: 2, ne: 2, lt_s: 2, lt_u: 2, gt_s: 2, gt_u: 2, le_s: 2, le_u: 2, ge_s: 2, ge_u: 2,
  select: 3, land: 2, lor: 2, lnot: 1,
};

function popcount32(x) {
  x >>>= 0;
  let n = 0;
  while (x) { n += x & 1; x >>>= 1; }
  return n;
}

// Exact WebAssembly semantics on signed 32-bit JS numbers. Division by zero yields 0 here:
// traps are tracked separately as explicit conditions, because both arms of a branch are
// evaluated speculatively once control flow is turned into selects.
export function applyOp(op, a, b, c) {
  switch (op) {
    case 'add': return (a + b) | 0;
    case 'sub': return (a - b) | 0;
    case 'mul': return Math.imul(a, b);
    case 'div_s': return b === 0 ? 0 : (a === INT_MIN && b === -1 ? INT_MIN : (Math.trunc(a / b) | 0));
    case 'div_u': return b === 0 ? 0 : (Math.floor((a >>> 0) / (b >>> 0)) | 0);
    case 'rem_s': return b === 0 ? 0 : ((a % b) | 0);
    case 'rem_u': return b === 0 ? 0 : (((a >>> 0) % (b >>> 0)) | 0);
    case 'and': return a & b;
    case 'or': return a | b;
    case 'xor': return a ^ b;
    case 'shl': return a << (b & 31);
    case 'shr_s': return a >> (b & 31);
    case 'shr_u': return (a >>> (b & 31)) | 0;
    case 'rotl': { const k = b & 31; return k === 0 ? a : ((a << k) | (a >>> (32 - k))) | 0; }
    case 'rotr': { const k = b & 31; return k === 0 ? a : ((a >>> k) | (a << (32 - k))) | 0; }
    case 'clz': return Math.clz32(a);
    case 'ctz': return a === 0 ? 32 : 31 - Math.clz32(a & -a);
    case 'popcnt': return popcount32(a);
    case 'eqz': return a === 0 ? 1 : 0;
    case 'eq': return a === b ? 1 : 0;
    case 'ne': return a !== b ? 1 : 0;
    case 'lt_s': return a < b ? 1 : 0;
    case 'lt_u': return (a >>> 0) < (b >>> 0) ? 1 : 0;
    case 'gt_s': return a > b ? 1 : 0;
    case 'gt_u': return (a >>> 0) > (b >>> 0) ? 1 : 0;
    case 'le_s': return a <= b ? 1 : 0;
    case 'le_u': return (a >>> 0) <= (b >>> 0) ? 1 : 0;
    case 'ge_s': return a >= b ? 1 : 0;
    case 'ge_u': return (a >>> 0) >= (b >>> 0) ? 1 : 0;
    case 'extend8_s': return (a << 24) >> 24;
    case 'extend16_s': return (a << 16) >> 16;
    case 'select': return a !== 0 ? b : c; // select(cond, ifTrue, ifFalse)
    case 'land': return a !== 0 && b !== 0 ? 1 : 0;
    case 'lor': return a !== 0 || b !== 0 ? 1 : 0;
    case 'lnot': return a === 0 ? 1 : 0;
    default: throw new Error(`applyOp: unknown op ${op}`);
  }
}

export class IR {
  constructor() {
    this.nodes = [];
    this.table = new Map();
  }

  _intern(op, args, extra) {
    const key = `${op}|${args.map((a) => a.id).join(',')}|${extra ?? ''}`;
    let n = this.table.get(key);
    if (n) return n;
    n = { id: this.nodes.length, op, args, bool: false };
    if (op === 'const') { n.value = extra; n.bool = extra === 0 || extra === 1; }
    if (op === 'input') n.index = extra;
    if (BOOL_OPS.has(op)) n.bool = true;
    if (op === 'select' && args[1].bool && args[2].bool) n.bool = true;
    if (op === 'and' && (args[0].bool || args[1].bool)) n.bool = true;
    if ((op === 'or' || op === 'xor') && args[0].bool && args[1].bool) n.bool = true;
    this.nodes.push(n);
    this.table.set(key, n);
    return n;
  }

  const(v) { return this._intern('const', [], v | 0); }
  input(i) { return this._intern('input', [], i); }

  // Build (and simplify) an operation node.
  op(op, ...args) {
    if (ARITY[op] === undefined) throw new Error(`unknown IR op ${op}`);
    if (args.length !== ARITY[op]) throw new Error(`IR op ${op} expects ${ARITY[op]} args`);
    if (args.every((a) => a.op === 'const')) {
      return this.const(applyOp(op, ...args.map((a) => a.value)));
    }
    if (COMMUTATIVE.has(op) && args[0].op === 'const') args = [args[1], args[0]];
    else if (COMMUTATIVE.has(op) && args[1].op !== 'const' && args[0].id > args[1].id) args = [args[1], args[0]];
    const s = this._simplify(op, args);
    if (s) return s;
    return this._intern(op, args);
  }

  bool(x) { return x.bool ? x : this.op('ne', x, this.const(0)); }
  not(x) { return this.op('lnot', this.bool(x)); }
  and(a, b) { return this.op('land', this.bool(a), this.bool(b)); }

  _simplify(op, [a, b, c]) {
    const isC = (n, v) => n.op === 'const' && (v === undefined || n.value === v);
    switch (op) {
      case 'add': if (isC(b, 0)) return a; break;
      case 'sub': if (isC(b, 0)) return a; if (a === b) return this.const(0); break;
      case 'mul': if (isC(b, 1)) return a; if (isC(b, 0)) return b; break;
      case 'and':
        if (isC(b, 0)) return b; if (isC(b, -1)) return a; if (a === b) return a;
        if (isC(b, 1) && a.bool) return a;
        if (a.bool && b.bool) return this.op('land', a, b);
        break;
      case 'or': if (isC(b, 0)) return a; if (a === b) return a; if (a.bool && b.bool) return this.op('lor', a, b); break;
      case 'xor': if (isC(b, 0)) return a; if (a === b) return this.const(0); break;
      case 'shl': case 'shr_s': case 'shr_u': case 'rotl': case 'rotr':
        if (b.op === 'const' && (b.value & 31) === 0) return a;
        break;
      case 'ne': if (isC(b, 0) && a.bool) return a; break;
      case 'eq': if (isC(b, 0)) return this.op('eqz', a); if (a === b) return this.const(1); break;
      case 'eqz': if (a.bool) return this.op('lnot', a); break;
      case 'select':
        if (a.op === 'const') return a.value !== 0 ? b : c;
        if (b === c) return b;
        if (isC(b, 1) && isC(c, 0)) return this.bool(a);
        if (isC(b, 0) && isC(c, 1)) return this.not(a);
        if (!a.bool) return this.op('select', this.bool(a), b, c);
        break;
      case 'land':
        if (isC(a, 0) || isC(b, 0)) return this.const(0);
        if (isC(a, 1)) return b; if (isC(b, 1)) return a;
        if (a === b) return a;
        if ((a.op === 'lnot' && a.args[0] === b) || (b.op === 'lnot' && b.args[0] === a)) return this.const(0);
        break;
      case 'lor': {
        if (isC(a, 1) || isC(b, 1)) return this.const(1);
        if (isC(a, 0)) return b; if (isC(b, 0)) return a;
        if (a === b) return a;
        if ((a.op === 'lnot' && a.args[0] === b) || (b.op === 'lnot' && b.args[0] === a)) return this.const(1);
        // (g & c) | (g & !c)  ==>  g    (re-joining the two arms of a branch)
        if (a.op === 'land' && b.op === 'land') {
          for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
            const g1 = a.args[x], c1 = a.args[1 - x], g2 = b.args[y], c2 = b.args[1 - y];
            if (g1 === g2 && ((c1.op === 'lnot' && c1.args[0] === c2) || (c2.op === 'lnot' && c2.args[0] === c1))) return g1;
          }
        }
        break;
      }
      case 'lnot': if (a.op === 'lnot') return a.args[0]; break;
      default: break;
    }
    return null;
  }
}

// Evaluate a set of root nodes for given input values, with exact i32 semantics.
export function evalExact(roots, inputs) {
  const memo = new Map();
  const ev = (n) => {
    let v = memo.get(n.id);
    if (v !== undefined) return v;
    if (n.op === 'const') v = n.value;
    else if (n.op === 'input') {
      v = inputs[n.index];
      if (v === undefined) throw new Error(`missing input ${n.index}`);
      v |= 0;
    } else v = applyOp(n.op, ...n.args.map(ev));
    memo.set(n.id, v);
    return v;
  };
  return roots.map(ev);
}

// Nodes reachable from roots, children before parents.
export function topoOrder(roots) {
  const seen = new Set();
  const out = [];
  const stack = roots.map((r) => [r, false]);
  while (stack.length) {
    const [n, expanded] = stack.pop();
    if (expanded) { out.push(n); continue; }
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    stack.push([n, true]);
    for (let i = n.args.length - 1; i >= 0; i--) if (!seen.has(n.args[i].id)) stack.push([n.args[i], false]);
  }
  return out;
}

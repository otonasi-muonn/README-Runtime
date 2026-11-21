// IR -> CSS math translation, serialization, and a simulator of how browsers evaluate it.
//
// CSS has no integer type with wrap-around: calc() works on floating-point numbers, so the
// translation is exact only while values stay small. Measured limits (see README):
//   * Chromium stores computed numbers with 6 significant digits when they are substituted
//     through var(): stored values must satisfy |v| <= 999,999.
//   * Firefox evaluates calc() in float32: every intermediate must stay below 2^23.
//   * WebKit uses doubles throughout.
// Instead of trusting static bounds, `simulate()` evaluates the generated CSS under each
// model and the build compares every model against the real WebAssembly engine.

import { topoOrder } from './ir.js';
import { transfer, interval, analyzeRanges } from './range.js';

export const STORED_LIMIT = 999999;
// Inline (unstored) values: float32 represents every integer with |v| <= 2^24 exactly, so a
// guard that fires for |v| >= 2^24 is sound even when the browser rounds. Operands of a
// division or modulo by anything but a power of two need |v| < 2^23 so that the float32
// quotient never rounds across an integer.
export const INLINE_LIMIT = 2 ** 24 - 1;
export const DIVISION_OPERAND_LIMIT = 2 ** 23 - 1;
const isPow2 = (v) => v > 0 && (v & (v - 1)) === 0;
// The tightest limit any consumer imposes on a node.
function consumerLimits(order) {
  const lim = new Map();
  const tighten = (n, v) => { if (v < (lim.get(n.id) ?? INLINE_LIMIT)) lim.set(n.id, v); };
  for (const n of order) {
    if (['div_s', 'div_u', 'rem_s', 'rem_u'].includes(n.op)) {
      const d = n.args[1];
      if (!(d.op === 'const' && isPow2(Math.abs(d.value)))) n.args.forEach((a) => tighten(a, DIVISION_OPERAND_LIMIT));
    }
    if (n.op === 'extend8_s') tighten(n.args[0], INLINE_LIMIT - 128);
    if (n.op === 'extend16_s') tighten(n.args[0], INLINE_LIMIT - 32768);
  }
  return lim;
}
const BITS = 23; // bits that carry information for values inside the supported range

// ---------------------------------------------------------------------------------------
// CSS math AST
//   { k: 'n', v }                     number literal
//   { k: 'v', name }                  var(--name)
//   { k: '+'|'-'|'*'|'/', a, b }      arithmetic
//   { k: 'f', fn, args, mode? }       round/mod/rem/min/max/clamp/pow
//   { k: 'ref', node }                placeholder for an IR child (translation only)

export const N = (v) => ({ k: 'n', v });
export const V = (name) => ({ k: 'v', name });
const isN = (x, v) => x.k === 'n' && (v === undefined || x.v === v);

export function add(a, b) {
  if (isN(a) && isN(b)) return N(a.v + b.v);
  if (isN(b, 0)) return a;
  if (isN(a, 0)) return b;
  return { k: '+', a, b };
}
export function sub(a, b) {
  if (isN(a) && isN(b)) return N(a.v - b.v);
  if (isN(b, 0)) return a;
  return { k: '-', a, b };
}
export function mul(a, b) {
  if (isN(a) && isN(b)) return N(a.v * b.v);
  if (isN(a, 1)) return b;
  if (isN(b, 1)) return a;
  if (isN(a, 0) || isN(b, 0)) return N(0);
  return { k: '*', a, b };
}
export function div(a, b) {
  if (isN(b, 1)) return a;
  return { k: '/', a, b };
}
export const fn = (name, ...args) => ({ k: 'f', fn: name, args });
export const round = (mode, x) => ({ k: 'f', fn: 'round', mode, args: [x] });
export const mod = (a, b) => fn('mod', a, b);
export const rem = (a, b) => fn('rem', a, b);
export const min = (a, b) => fn('min', a, b);
export const max = (a, b) => fn('max', a, b);
export const clamp = (lo, x, hi) => fn('clamp', lo, x, hi);
export const pow = (a, b) => fn('pow', a, b);

const neg = (x) => mul(N(-1), x);
export const signBit = (x) => clamp(N(0), neg(x), N(1));      // 1 if x < 0
export const nonZero = (x) => min(N(1), max(x, neg(x)));       // 1 if x != 0
export const absV = (x) => max(x, neg(x));
const bit = (x, j) => (j === 0 ? mod(x, N(2)) : mod(round('down', div(x, N(2 ** j))), N(2)));

// ---------------------------------------------------------------------------------------
// Serialization

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };
const prec = (n) => PREC[n.k] ?? 3;

function fmt(v) {
  if (!Number.isFinite(v)) throw new Error(`cannot serialize ${v}`);
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

function ser(n, refName) {
  switch (n.k) {
    case 'n': return fmt(n.v);
    case 'v': return `var(--${n.name})`;
    case 'ref': return refName(n.node);
    case 'f': {
      const args = n.args.map((a) => ser(a, refName));
      return n.fn === 'round' ? `round(${n.mode}, ${args[0]})` : `${n.fn}(${args.join(', ')})`;
    }
    default: {
      const p = PREC[n.k];
      let a = ser(n.a, refName);
      let b = ser(n.b, refName);
      if (prec(n.a) < p) a = `(${a})`;
      if (prec(n.b) <= p && prec(n.b) !== 3) b = `(${b})`;
      if (n.b.k === 'n' && n.b.v < 0) b = `(${b})`;
      return `${a} ${n.k} ${b}`;
    }
  }
}

// Serialize as a full property value.
export function toCss(n, refName = () => { throw new Error('unresolved ref'); }) {
  const s = ser(n, refName);
  return prec(n) < 3 ? `calc(${s})` : s;
}

// ---------------------------------------------------------------------------------------
// IR -> CSS templates (children appear as refs)

function template(node, inputAst) {
  const [A, B, C] = node.args.map((c) => (c.op === 'const' ? N(c.value) : { k: 'ref', node: c }));
  const a = node.args[0], b = node.args[1], c = node.args[2];
  const cv = (x) => (x && x.op === 'const' ? x.value : undefined);
  const safe = (x, X) => {
    const v = cv(x);
    if (v !== undefined) return N(v === 0 ? 1 : v);
    return x.bool ? N(1) : add(X, sub(N(1), nonZero(X)));
  };
  const and2 = (x, X, y, Y) => {
    const k = cv(y);
    if (x.bool && y.bool) return mul(X, Y);
    if (k === undefined && y.bool) return mul(Y, mod(X, N(2)));
    if (x.bool) return mul(X, mod(Y, N(2)));
    if (k !== undefined) {
      if (k >= 0 && (k & (k + 1)) === 0) return mod(X, N(k + 1));
      if (k < 0 && ((-k) & (-k - 1)) === 0) return sub(X, mod(X, N(-k)));
      let s = N(0);
      for (let j = 0; j < BITS; j++) if ((k >>> j) & 1) s = add(s, mul(N(2 ** j), bit(X, j)));
      const high = k - (k & (2 ** BITS - 1));
      return add(s, mul(N(high), signBit(X)));
    }
    let s = N(0);
    for (let j = 0; j < BITS; j++) s = add(s, mul(N(2 ** j), mul(bit(X, j), bit(Y, j))));
    return sub(s, mul(N(2 ** BITS), mul(signBit(X), signBit(Y))));
  };
  const ltU = (X, y, Y) => {
    const k = cv(y);
    if (k !== undefined && k >= 0) return sub(clamp(N(0), sub(N(k), X), N(1)), signBit(X));
    return clamp(N(0), add(clamp(N(0), sub(Y, X), N(1)), sub(signBit(Y), signBit(X))), N(1));
  };
  const shrU = (X, k, x) => {
    if (k === 0) return X;
    const q = round('down', div(X, N(2 ** k)));
    return x.bool ? q : add(q, mul(signBit(X), N(2 ** (32 - k))));
  };
  switch (node.op) {
    case 'const': return N(node.value);
    case 'input': return inputAst(node.index);
    case 'add': return add(A, B);
    case 'sub': return sub(A, B);
    case 'mul': return mul(A, B);
    case 'div_s': return round('to-zero', div(A, safe(b, B)));
    case 'div_u': {
      // Unsigned: a negative i32 means a + 2^32. With a constant divisor this is exact:
      // floor(u(a)/d) = floor(a/d) + s*(floor(2^32/d) + floor((mod(a,d) + 2^32 mod d)/d)).
      const d = cv(b);
      if (d !== undefined && d > 0) {
        const q = round('down', div(A, N(d)));
        if (a.bool) return q;
        // (the large constant is multiplied by the sign first, so a >= 0 never produces a
        // large intermediate value)
        const sA = signBit(A);
        const carry = round('down', div(add(mod(A, N(d)), N(2 ** 32 % d)), N(d)));
        return add(add(q, mul(sA, N(Math.floor(2 ** 32 / d)))), mul(sA, carry));
      }
      if (d !== undefined && d < 0) return mul(signBit(A), clamp(N(0), add(sub(A, N(d)), N(1)), N(1))); // u(d) >= 2^31
      return round('down', div(A, safe(b, B))); // variable divisor: valid for a >= 0, b > 0 (guarded)
    }
    case 'rem_s': return rem(A, safe(b, B));
    case 'rem_u': {
      const d = cv(b);
      if (d !== undefined && d > 0) {
        if (a.bool) return d === 1 ? N(0) : A;
        return mod(add(mod(A, N(d)), mul(signBit(A), N(2 ** 32 % d))), N(d));
      }
      // u(d) >= 2^31: a >= 0 -> a; d <= a < 0 -> a - d; a < d -> a + 2^32 (guarded)
      if (d !== undefined && d < 0) return add(A, mul(signBit(A), N(-d)));
      return mod(A, safe(b, B)); // variable divisor: valid for a >= 0, b > 0 (guarded)
    }
    case 'and': return and2(a, A, b, B);
    case 'or':
      if (a.bool && b.bool) return max(A, B);
      return sub(add(A, B), and2(a, A, b, B));
    case 'xor':
      if (cv(b) === -1) return sub(neg(A), N(1));
      if (a.bool && b.bool) return absV(sub(A, B));
      return sub(add(A, B), mul(N(2), and2(a, A, b, B)));
    case 'shl': {
      const k = cv(b);
      return k !== undefined ? mul(A, N(2 ** (k & 31))) : mul(A, pow(N(2), mod(B, N(32))));
    }
    case 'shr_s': {
      const k = cv(b);
      return k !== undefined ? round('down', div(A, N(2 ** (k & 31)))) : round('down', div(A, pow(N(2), mod(B, N(32)))));
    }
    case 'shr_u': {
      const k = cv(b);
      if (k !== undefined) return shrU(A, k & 31, a);
      const K = mod(B, N(32));
      return add(round('down', div(A, pow(N(2), K))), mul(mul(signBit(A), nonZero(K)), pow(N(2), sub(N(32), K))));
    }
    case 'clz': {
      let s = N(0);
      for (let j = 0; j < BITS; j++) s = add(s, clamp(N(0), sub(A, N(2 ** j - 1)), N(1)));
      return mul(sub(N(1), signBit(A)), sub(N(32), s));
    }
    case 'ctz': {
      let s = N(0);
      for (let j = 1; j <= BITS; j++) s = add(s, sub(N(1), min(N(1), mod(A, N(2 ** j)))));
      return add(s, mul(N(32 - BITS), sub(N(1), nonZero(A))));
    }
    case 'popcnt': {
      let s = N(0);
      for (let j = 0; j < BITS; j++) s = add(s, bit(A, j));
      return add(s, mul(N(32 - BITS), signBit(A)));
    }
    case 'eqz': return sub(N(1), a.bool ? A : nonZero(A));
    case 'eq': return sub(N(1), nonZero(sub(A, B)));
    case 'ne': return nonZero(sub(A, B));
    case 'lt_s': return clamp(N(0), sub(B, A), N(1));
    case 'gt_s': return clamp(N(0), sub(A, B), N(1));
    case 'le_s': return clamp(N(0), add(sub(B, A), N(1)), N(1));
    case 'ge_s': return clamp(N(0), add(sub(A, B), N(1)), N(1));
    case 'lt_u': return ltU(A, b, B);
    case 'gt_u': return ltU(B, a, A);
    case 'le_u': return sub(N(1), ltU(B, a, A));
    case 'ge_u': return sub(N(1), ltU(A, b, B));
    case 'select': {
      const t = cv(b), f = cv(c);
      if (t !== undefined && f !== undefined) return add(N(f), mul(N(t - f), A));
      return add(mul(B, A), mul(C, sub(N(1), A)));
    }
    case 'land': return mul(A, B);
    case 'lor': return max(A, B);
    case 'lnot': return sub(N(1), A);
    case 'extend8_s': return sub(mod(add(A, N(128)), N(256)), N(128));
    case 'extend16_s': return sub(mod(add(A, N(32768)), N(65536)), N(32768));
    default:
      throw new Error(`no CSS translation for IR op ${node.op}`);
  }
}

function forEachRef(ast, f) {
  if (ast.k === 'ref') f(ast.node);
  else if (ast.k === 'f') ast.args.forEach((x) => forEachRef(x, f));
  else if (ast.a) { forEachRef(ast.a, f); forEachRef(ast.b, f); }
}

function ownSize(ast) {
  // Rough text length excluding refs.
  if (ast.k === 'ref') return 0;
  if (ast.k === 'n') return fmt(ast.v).length;
  if (ast.k === 'v') return ast.name.length + 8;
  if (ast.k === 'f') return ast.fn.length + 2 + (ast.mode ? ast.mode.length + 2 : 0) + ast.args.reduce((s, x) => s + ownSize(x) + 2, 0);
  return ownSize(ast.a) + ownSize(ast.b) + 5;
}

const TEMP_MIN_SIZE = 40;
// Maximum parenthesis nesting of one inlined expression. Browsers silently drop calc()
// trees that are nested too deeply (measured: Firefox fails beyond ~75 levels, Chromium
// ~95, WebKit ~105). Substituting a registered property resets the depth, so deeper
// expressions are split into temporaries.
export const MAX_DEPTH = 24;
// Every emitted declaration (including the machine's wrappers and guards) must stay below.
export const MAX_DECL_DEPTH = 40;

// Parenthesis depth of ser(ast); refDepth(node) gives the depth of an inlined child.
// refPrec(node) gives the precedence the inlined child will have once resolved (a child
// that is an operator gets parenthesized, which adds a level).
export function astDepth(n, refDepth = () => 0, refPrec = () => 3) {
  const P = (x) => (x.k === 'ref' ? refPrec(x.node) : prec(x));
  switch (n.k) {
    case 'n': return 0;
    case 'v': return 1;
    case 'ref': return refDepth(n.node);
    case 'f': return 1 + Math.max(0, ...n.args.map((a) => astDepth(a, refDepth, refPrec)));
    default: {
      const p = PREC[n.k];
      let da = astDepth(n.a, refDepth, refPrec);
      let db = astDepth(n.b, refDepth, refPrec);
      if (P(n.a) < p) da += 1;
      const pb = P(n.b);
      if ((pb <= p && pb !== 3) || (n.b.k === 'n' && n.b.v < 0)) db += 1;
      return Math.max(da, db);
    }
  }
}

// Maximum nesting of parentheses in a serialized declaration value.
export function textDepth(str) {
  let d = 0, m = 0;
  for (const ch of str) {
    if (ch === '(') { d++; if (d > m) m = d; } else if (ch === ')') d--;
  }
  return m;
}

const isLeaf = (n) => n.op === 'const' || n.op === 'input';
const exceedsLimit = (r, limit) => !r || r.lo < -limit || r.hi > limit;
const MAX_DUPLICATION = 20000; // characters of CSS a non-storable shared value may be copied into
const exceeds = (r, limit) => !r || r.lo < -limit || r.hi > limit;

// Translate IR roots into CSS property definitions.
//   roots: [{ node, name }]   each root becomes the property --name
//   inputAst(i):              CSS AST for IR input i
//   tempPrefix:               prefix for shared temporaries (registered <integer> props)
//   ranges:                   optional Map(node id -> {lo, hi}) from analyzeRanges(); when
//                             given, a guard is emitted for every node whose value may leave
//                             the exactly representable range for some admissible input
//   checkedRoots:             root names whose range the caller already guards
// Returns { defs: [{ name, ast, node }], temps: [names], guards: [ast] } in dependency
// order. Each guard evaluates to 1 when the value it watches cannot be exact.
export function translate(roots, inputAst, { tempPrefix = 'rr-t', inputRange = null, checkedRoots = new Set() } = {}) {
  const order = topoOrder(roots.map((r) => r.node));
  const tmpl = new Map();
  const size = new Map();
  for (const n of order) {
    const t = template(n, inputAst);
    tmpl.set(n.id, t);
    let s = ownSize(t);
    forEachRef(t, (c) => { s += size.get(c.id); });
    size.set(n.id, s);
  }
  const rootName = new Map();
  for (const r of roots) if (!rootName.has(r.node.id)) rootName.set(r.node.id, r.name);
  const uses = new Map();
  for (const r of roots) uses.set(r.node.id, (uses.get(r.node.id) ?? 0) + 1);
  const temp = new Map(); // node id -> property name
  let tempCount = 0;
  // 1) shared subexpressions become temporaries (top-down, so use counts are final). A value
  //    that may exceed STORED_LIMIT stays inline (stored values keep only 6 significant
  //    digits in Chromium) unless duplicating it would be too large.
  const unclamped = inputRange ? analyzeRanges(roots.map((r) => r.node), inputRange) : null;
  const storable = (n) => !unclamped || !exceedsLimit(unclamped.get(n.id), STORED_LIMIT);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    const u = uses.get(n.id) ?? 0;
    if (rootName.has(n.id) && !isLeaf(n)) temp.set(n.id, rootName.get(n.id));
    else if (!isLeaf(n) && u >= 2 && size.get(n.id) > TEMP_MIN_SIZE && (storable(n) || size.get(n.id) * u > MAX_DUPLICATION)) temp.set(n.id, `${tempPrefix}${tempCount++}`);
    const mult = temp.has(n.id) ? 1 : u;
    if (mult === 0) continue;
    forEachRef(tmpl.get(n.id), (c) => uses.set(c.id, (uses.get(c.id) ?? 0) + mult));
  }
  // 2) keep every inlined expression shallow: split the deepest inline child into a
  //    temporary until the node fits (bottom-up, so children are already final)
  const depth = new Map();
  const refDepth = (c) => (temp.has(c.id) ? 1 : depth.get(c.id));
  const refPrec = (c) => {
    if (temp.has(c.id)) return 3;
    const t = tmpl.get(c.id);
    return t.k === 'ref' ? refPrec(t.node) : prec(t);
  };
  for (const n of order) {
    if (isLeaf(n)) { depth.set(n.id, astDepth(tmpl.get(n.id))); continue; }
    for (;;) {
      const d = astDepth(tmpl.get(n.id), refDepth, refPrec);
      if (d <= MAX_DEPTH) { depth.set(n.id, d); break; }
      let best = null;
      forEachRef(tmpl.get(n.id), (c) => {
        if (!temp.has(c.id) && !isLeaf(c) && (!best || depth.get(c.id) > depth.get(best.id))) best = c;
      });
      if (!best) throw new Error(`internal: cannot split an expression of depth ${d}`);
      temp.set(best.id, `${tempPrefix}${tempCount++}`);
    }
  }
  // Resolve templates into concrete ASTs (refs to temps become var(), others inline).
  const resolved = new Map();
  const resolve = (ast) => {
    if (ast.k === 'ref') {
      const c = ast.node;
      if (temp.has(c.id)) return V(temp.get(c.id));
      return resolveNode(c);
    }
    if (ast.k === 'f') return { ...ast, args: ast.args.map(resolve) };
    if (ast.a) return { k: ast.k, a: resolve(ast.a), b: resolve(ast.b) };
    return ast;
  };
  const resolveNode = (n) => {
    let r = resolved.get(n.id);
    if (!r) { r = resolve(tmpl.get(n.id)); resolved.set(n.id, r); }
    return r;
  };
  const defs = [];
  for (const n of order) {
    if (!temp.has(n.id)) continue;
    defs.push({ name: temp.get(n.id), ast: resolveNode(n), node: n });
  }
  // Roots that are leaves (const/input) still need a definition.
  for (const r of roots) {
    if (!defs.some((d) => d.name === r.name)) defs.push({ name: r.name, ast: resolveNode(r.node), node: r.node });
  }
  const temps = defs.filter((d) => !roots.some((r) => r.name === d.name)).map((d) => d.name);

  // 3) guards. A stored value must have at most 6 significant digits (Chromium), an inline
  //    value must stay below 2^23 (Firefox float32; division stays exact too). Every Wasm
  //    wrap-around lies far outside both. Interval analysis over the admissible inputs finds
  //    each node whose value can first leave its range; that node gets a guard and its range
  //    is clamped for its consumers (if the guard does not fire, the value is within the
  //    limit). So "exact or flagged" holds for every admissible input, not only for the
  //    verified trajectory.
  const guards = [];
  if (inputRange) {
    const valueOf = (n) => (temp.has(n.id) ? V(temp.get(n.id)) : resolveNode(n));
    const R = new Map();
    const consumer = consumerLimits(order);
    for (const n of order) {
      const args = n.args.map((a) => R.get(a.id));
      let r = n.op === 'input' ? interval(inputRange.lo, inputRange.hi) : transfer(n, ...args);
      if (!isLeaf(n)) {
        const stored = temp.has(n.id);
        const limit = stored ? STORED_LIMIT : (consumer.get(n.id) ?? INLINE_LIMIT);
        if (r.lo < -limit || r.hi > limit) {
          if (!(stored && checkedRoots.has(temp.get(n.id)))) guards.push(clamp(N(0), sub(absV(valueOf(n)), N(limit)), N(1)));
          r = interval(Math.max(r.lo, -limit), Math.min(r.hi, limit));
        }
        // unsigned division by a variable is translated for non-negative operands only
        if (n.op === 'div_u' || n.op === 'rem_u') {
          const [x, y] = n.args;
          if (y.op !== 'const') {
            for (const [arg, ar] of [[x, args[0]], [y, args[1]]]) {
              if (arg.op === 'const' && arg.value < 0) guards.push(N(1));
              else if (arg.op !== 'const' && ar.lo < 0) guards.push(signBit(valueOf(arg)));
            }
          } else if (n.op === 'rem_u' && y.value < 0 && x.op !== 'const' && args[0].lo < y.value) {
            guards.push(clamp(N(0), sub(N(y.value), valueOf(x)), N(1))); // x < d: the result is x + 2^32
          }
        }
      }
      R.set(n.id, r);
    }
  }
  return { defs, temps, guards };
}

// ---------------------------------------------------------------------------------------
// Simulation of browser arithmetic

export const MODELS = {
  // Doubles everywhere (WebKit; also the ideal model).
  exact: { op: (x) => x, store: (x) => x, modrem: 'exact' },
  // Firefox: calc() in float32 (rem/mod as a - b*trunc/floor(a/b), measured); integers
  // stored as i32.
  firefox: { op: Math.fround, store: (x) => Math.fround(x), modrem: 'divide' },
  // Chromium: doubles inside calc(), but a registered value is re-serialized with
  // 6 significant digits when substituted via var(); integers are clamped to int32.
  chromium: {
    op: (x) => x,
    modrem: 'exact',
    store: (x) => {
      const c = Math.max(-2147483648, Math.min(2147483647, x));
      return Number(c.toPrecision(6));
    },
  },
};

export function evalAst(ast, env, model, stats) {
  const F = model.op;
  let exempt = 0;
  const track = (v) => {
    if (stats && !exempt) {
      const m = Math.abs(v);
      if (m > stats.maxInline) stats.maxInline = m;
    }
    return v;
  };
  const ev = (n) => {
    switch (n.k) {
      case 'n': return F(n.v);
      case 'v': {
        const v = env(n.name);
        if (v === undefined) throw new Error(`simulate: undefined var --${n.name}`);
        return v;
      }
      case '+': return track(F(ev(n.a) + ev(n.b)));
      case '-': return track(F(ev(n.a) - ev(n.b)));
      case '*': return track(F(ev(n.a) * ev(n.b)));
      case '/': return track(F(ev(n.a) / ev(n.b)));
      case 'f': {
        const cmp = n.fn === 'clamp' || n.fn === 'min' || n.fn === 'max';
        if (cmp) exempt++;
        const xs = n.args.map(ev);
        if (cmp) exempt--;
        switch (n.fn) {
          case 'round': {
            const x = xs[0];
            const r = n.mode === 'down' ? Math.floor(x) : n.mode === 'up' ? Math.ceil(x)
              : n.mode === 'to-zero' ? Math.trunc(x) : Math.floor(x + 0.5);
            return track(F(r));
          }
          case 'mod': {
            if (model.modrem === 'divide') return track(F(xs[0] - F(xs[1] * Math.floor(F(xs[0] / xs[1])))));
            let r = xs[0] % xs[1];
            if (r !== 0 && (r < 0) !== (xs[1] < 0)) r += xs[1];
            return track(F(r));
          }
          case 'rem':
            if (model.modrem === 'divide') return track(F(xs[0] - F(xs[1] * Math.trunc(F(xs[0] / xs[1])))));
            return track(F(xs[0] % xs[1]));
          case 'min': return Math.min(...xs);
          case 'max': return Math.max(...xs);
          case 'clamp': return Math.max(xs[0], Math.min(xs[1], xs[2]));
          case 'pow': return track(F(Math.pow(xs[0], xs[1])));
          default: throw new Error(`simulate: unknown function ${n.fn}`);
        }
      }
      default: throw new Error(`simulate: bad node ${n.k}`);
    }
  };
  return ev(ast);
}

// Store a computed value into a registered <integer> custom property under `model`.
export function storeInteger(v, model) {
  if (!Number.isFinite(v)) return NaN;
  const r = Math.floor(v + 0.5); // CSS rounds to the nearest integer, ties toward +infinity
  return model.store(r);
}

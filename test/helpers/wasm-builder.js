// Tiny WebAssembly binary builder for tests (no external assembler needed).
export const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d;
export const op = {
  unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
  br: 0x0c, br_if: 0x0d, br_table: 0x0e, return: 0x0f, call: 0x10, drop: 0x1a, select: 0x1b,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i32_const: 0x41, i64_const: 0x42,
  eqz: 0x45, eq: 0x46, ne: 0x47, lt_s: 0x48, lt_u: 0x49, gt_s: 0x4a, gt_u: 0x4b, le_s: 0x4c, le_u: 0x4d, ge_s: 0x4e, ge_u: 0x4f,
  clz: 0x67, ctz: 0x68, popcnt: 0x69, add: 0x6a, sub: 0x6b, mul: 0x6c, div_s: 0x6d, div_u: 0x6e, rem_s: 0x6f, rem_u: 0x70,
  and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shr_s: 0x75, shr_u: 0x76, rotl: 0x77, rotr: 0x78,
  i64_add: 0x7c, f32_add: 0x92, extend8_s: 0xc0, extend16_s: 0xc1,
};

export function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
export function sleb(n) {
  const out = [];
  let more = true;
  n = BigInt(n);
  while (more) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) more = false; else b |= 0x80;
    out.push(b);
  }
  return out;
}
const str = (s) => { const b = [...Buffer.from(s, 'utf8')]; return [...uleb(b.length), ...b]; };
const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
const vec = (items) => [...uleb(items.length), ...items.flat()];

// Shorthands for instruction bytes.
export const c = (v) => [op.i32_const, ...sleb(v)];
export const get = (i) => [op.local_get, ...uleb(i)];
export const set = (i) => [op.local_set, ...uleb(i)];
export const tee = (i) => [op.local_tee, ...uleb(i)];

// funcs: [{ name?, params: [types], results: [types], locals?: [types], body: [bytes], export? }]
// imports: [{ module, name, params, results }]   (function imports, indices come first)
// globals: [{ type, mutable, init }]
export function buildModule({ funcs, imports = [], globals = [], memory = false }) {
  const types = [];
  const typeIndex = (params, results) => {
    const key = `${params}|${results}`;
    let i = types.findIndex((t) => t.key === key);
    if (i < 0) { types.push({ key, bytes: [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))] }); i = types.length - 1; }
    return i;
  };
  const importEntries = imports.map((im) => [...str(im.module), ...str(im.name), 0x00, ...uleb(typeIndex(im.params, im.results))]);
  const funcTypes = funcs.map((f) => uleb(typeIndex(f.params, f.results)));
  const exportsList = [];
  funcs.forEach((f, i) => { if (f.export !== false) exportsList.push([...str(f.name ?? `f${i}`), 0x00, ...uleb(imports.length + i)]); });
  const codes = funcs.map((f) => {
    const locals = f.locals ?? [];
    const groups = locals.map((t) => [1, t]);
    const body = [...vec(groups), ...f.body.flat(), op.end];
    return [...uleb(body.length), ...body];
  });
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(...section(1, vec(types.map((t) => t.bytes))));
  if (imports.length) bytes.push(...section(2, vec(importEntries)));
  bytes.push(...section(3, vec(funcTypes)));
  if (memory) bytes.push(...section(5, vec([[0x00, 0x01]])));
  if (globals.length) {
    bytes.push(...section(6, vec(globals.map((g) => [g.type, g.mutable ? 1 : 0, op.i32_const, ...sleb(g.init), op.end]))));
  }
  bytes.push(...section(7, vec(exportsList)));
  bytes.push(...section(10, vec(codes)));
  return new Uint8Array(bytes);
}

// A single-function module `f: (i32) -> i32`.
export function unary(body, { locals = [], extraFuncs = [], globals = [], imports = [], memory = false } = {}) {
  return buildModule({
    funcs: [{ name: 'f', params: [I32], results: [I32], locals, body }, ...extraFuncs],
    globals, imports, memory,
  });
}

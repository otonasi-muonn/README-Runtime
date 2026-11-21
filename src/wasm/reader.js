// Minimal WebAssembly binary reader: just enough structure to lift pure i32 functions.
// Anything we do not understand is reported precisely instead of being guessed.

export class WasmFormatError extends Error {}

const SECTION = { custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6, export: 7, start: 8, element: 9, code: 10, data: 11, datacount: 12, tag: 13 };
export const VALTYPE = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref' };

// Opcode names (used for decoding and for error messages).
export const OPNAMES = {
  0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else', 0x0b: 'end',
  0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return', 0x10: 'call', 0x11: 'call_indirect',
  0x1a: 'drop', 0x1b: 'select', 0x1c: 'select_t',
  0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee', 0x23: 'global.get', 0x24: 'global.set',
  0x25: 'table.get', 0x26: 'table.set',
  0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load', 0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u',
  0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u', 0x30: 'i64.load8_s', 0x31: 'i64.load8_u', 0x32: 'i64.load16_s',
  0x33: 'i64.load16_u', 0x34: 'i64.load32_s', 0x35: 'i64.load32_u', 0x36: 'i32.store', 0x37: 'i64.store',
  0x38: 'f32.store', 0x39: 'f64.store', 0x3a: 'i32.store8', 0x3b: 'i32.store16', 0x3c: 'i64.store8',
  0x3d: 'i64.store16', 0x3e: 'i64.store32', 0x3f: 'memory.size', 0x40: 'memory.grow',
  0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
  0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s', 0x49: 'i32.lt_u', 0x4a: 'i32.gt_s',
  0x4b: 'i32.gt_u', 0x4c: 'i32.le_s', 0x4d: 'i32.le_u', 0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u',
  0x50: 'i64.eqz', 0x51: 'i64.eq', 0x52: 'i64.ne', 0x53: 'i64.lt_s', 0x54: 'i64.lt_u', 0x55: 'i64.gt_s',
  0x56: 'i64.gt_u', 0x57: 'i64.le_s', 0x58: 'i64.le_u', 0x59: 'i64.ge_s', 0x5a: 'i64.ge_u',
  0x5b: 'f32.eq', 0x5c: 'f32.ne', 0x5d: 'f32.lt', 0x5e: 'f32.gt', 0x5f: 'f32.le', 0x60: 'f32.ge',
  0x61: 'f64.eq', 0x62: 'f64.ne', 0x63: 'f64.lt', 0x64: 'f64.gt', 0x65: 'f64.le', 0x66: 'f64.ge',
  0x67: 'i32.clz', 0x68: 'i32.ctz', 0x69: 'i32.popcnt', 0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul',
  0x6d: 'i32.div_s', 0x6e: 'i32.div_u', 0x6f: 'i32.rem_s', 0x70: 'i32.rem_u', 0x71: 'i32.and', 0x72: 'i32.or',
  0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x76: 'i32.shr_u', 0x77: 'i32.rotl', 0x78: 'i32.rotr',
  0x79: 'i64.clz', 0x7a: 'i64.ctz', 0x7b: 'i64.popcnt', 0x7c: 'i64.add', 0x7d: 'i64.sub', 0x7e: 'i64.mul',
  0x7f: 'i64.div_s', 0x80: 'i64.div_u', 0x81: 'i64.rem_s', 0x82: 'i64.rem_u', 0x83: 'i64.and', 0x84: 'i64.or',
  0x85: 'i64.xor', 0x86: 'i64.shl', 0x87: 'i64.shr_s', 0x88: 'i64.shr_u', 0x89: 'i64.rotl', 0x8a: 'i64.rotr',
  0x8b: 'f32.abs', 0x8c: 'f32.neg', 0x8d: 'f32.ceil', 0x8e: 'f32.floor', 0x8f: 'f32.trunc', 0x90: 'f32.nearest',
  0x91: 'f32.sqrt', 0x92: 'f32.add', 0x93: 'f32.sub', 0x94: 'f32.mul', 0x95: 'f32.div', 0x96: 'f32.min',
  0x97: 'f32.max', 0x98: 'f32.copysign', 0x99: 'f64.abs', 0x9a: 'f64.neg', 0x9b: 'f64.ceil', 0x9c: 'f64.floor',
  0x9d: 'f64.trunc', 0x9e: 'f64.nearest', 0x9f: 'f64.sqrt', 0xa0: 'f64.add', 0xa1: 'f64.sub', 0xa2: 'f64.mul',
  0xa3: 'f64.div', 0xa4: 'f64.min', 0xa5: 'f64.max', 0xa6: 'f64.copysign', 0xa7: 'i32.wrap_i64',
  0xa8: 'i32.trunc_f32_s', 0xa9: 'i32.trunc_f32_u', 0xaa: 'i32.trunc_f64_s', 0xab: 'i32.trunc_f64_u',
  0xac: 'i64.extend_i32_s', 0xad: 'i64.extend_i32_u', 0xae: 'i64.trunc_f32_s', 0xaf: 'i64.trunc_f32_u',
  0xb0: 'i64.trunc_f64_s', 0xb1: 'i64.trunc_f64_u', 0xb2: 'f32.convert_i32_s', 0xb3: 'f32.convert_i32_u',
  0xb4: 'f32.convert_i64_s', 0xb5: 'f32.convert_i64_u', 0xb6: 'f32.demote_f64', 0xb7: 'f64.convert_i32_s',
  0xb8: 'f64.convert_i32_u', 0xb9: 'f64.convert_i64_s', 0xba: 'f64.convert_i64_u', 0xbb: 'f64.promote_f32',
  0xbc: 'i32.reinterpret_f32', 0xbd: 'i64.reinterpret_f64', 0xbe: 'f32.reinterpret_i32', 0xbf: 'f64.reinterpret_i64',
  0xc0: 'i32.extend8_s', 0xc1: 'i32.extend16_s', 0xc2: 'i64.extend8_s', 0xc3: 'i64.extend16_s', 0xc4: 'i64.extend32_s',
  0xd0: 'ref.null', 0xd1: 'ref.is_null', 0xd2: 'ref.func',
};

class Cursor {
  constructor(u8, pos = 0, end = u8.length) { this.u8 = u8; this.pos = pos; this.end = end; }
  eof() { return this.pos >= this.end; }
  byte() {
    if (this.pos >= this.end) throw new WasmFormatError(`unexpected end of data at offset ${this.pos}`);
    return this.u8[this.pos++];
  }
  bytes(n) {
    if (this.pos + n > this.end) throw new WasmFormatError(`unexpected end of data at offset ${this.pos}`);
    const out = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u32() {
    let result = 0, shift = 0, b;
    do {
      b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 35) throw new WasmFormatError(`LEB128 u32 too long at offset ${this.pos}`);
    } while (b & 0x80);
    if (result > 0xffffffff) throw new WasmFormatError(`LEB128 u32 out of range at offset ${this.pos}`);
    return result;
  }
  // Signed LEB128 decoded with BigInt so any width (i32/i33/i64) is exact.
  sleb(bits) {
    let result = 0n, shift = 0n, b;
    do {
      b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (shift > BigInt(bits) + 7n) throw new WasmFormatError(`LEB128 s${bits} too long at offset ${this.pos}`);
    } while (b & 0x80);
    if (b & 0x40) result -= 1n << shift;
    return result;
  }
  s32() { return Number(BigInt.asIntN(32, this.sleb(32))); }
  name() { return new TextDecoder().decode(this.bytes(this.u32())); }
}

function readValType(c) {
  const b = c.byte();
  const t = VALTYPE[b];
  if (!t) throw new WasmFormatError(`unknown value type 0x${b.toString(16)} at offset ${c.pos - 1}`);
  return t;
}

function readLimits(c) {
  const flag = c.byte();
  const min = c.u32();
  const max = flag & 1 ? c.u32() : undefined;
  return { min, max };
}

// Constant expressions (global initializers): we only need i32.const / global.get.
function readConstExpr(c) {
  const op = c.byte();
  let value;
  if (op === 0x41) value = { kind: 'i32', value: c.s32() };
  else if (op === 0x42) value = { kind: 'i64', value: c.sleb(64) };
  else if (op === 0x43) { c.bytes(4); value = { kind: 'f32' }; }
  else if (op === 0x44) { c.bytes(8); value = { kind: 'f64' }; }
  else if (op === 0x23) value = { kind: 'global.get', index: c.u32() };
  else if (op === 0xd0) { c.byte(); value = { kind: 'ref.null' }; }
  else if (op === 0xd2) value = { kind: 'ref.func', index: c.u32() };
  else throw new WasmFormatError(`unsupported constant expression opcode 0x${op.toString(16)} at offset ${c.pos - 1}`);
  const end = c.byte();
  if (end !== 0x0b) throw new WasmFormatError(`unsupported extended constant expression at offset ${c.pos - 1}`);
  return value;
}

function readBlockType(c) {
  const b = c.u8[c.pos];
  if (b === 0x40) { c.pos++; return { params: [], results: [] }; }
  if (VALTYPE[b]) { c.pos++; return { params: [], results: [VALTYPE[b]] }; }
  const idx = Number(c.sleb(33));
  return { typeIndex: idx };
}

// Decode a function body into a flat instruction list: { op, name, offset, ...immediates }.
export function decodeBody(c) {
  const out = [];
  let depth = 0;
  for (;;) {
    const offset = c.pos;
    const op = c.byte();
    const ins = { op, name: OPNAMES[op] ?? `0x${op.toString(16)}`, offset };
    switch (op) {
      case 0x02: case 0x03: case 0x04: ins.blockType = readBlockType(c); depth++; break;
      case 0x0b: if (depth === 0) { out.push(ins); return out; } depth--; break;
      case 0x0c: case 0x0d: ins.label = c.u32(); break;
      case 0x0e: {
        const n = c.u32();
        ins.labels = [];
        for (let i = 0; i < n; i++) ins.labels.push(c.u32());
        ins.defaultLabel = c.u32();
        break;
      }
      case 0x10: ins.func = c.u32(); break;
      case 0x11: ins.type = c.u32(); ins.table = c.u32(); break;
      case 0x1c: { const n = c.u32(); ins.types = []; for (let i = 0; i < n; i++) ins.types.push(readValType(c)); break; }
      case 0x20: case 0x21: case 0x22: ins.local = c.u32(); break;
      case 0x23: case 0x24: ins.global = c.u32(); break;
      case 0x25: case 0x26: ins.table = c.u32(); break;
      case 0x3f: case 0x40: c.u32(); break;
      case 0x41: ins.value = c.s32(); break;
      case 0x42: ins.value = c.sleb(64); break;
      case 0x43: c.bytes(4); break;
      case 0x44: c.bytes(8); break;
      case 0xd0: c.byte(); break;
      case 0xd2: ins.func = c.u32(); break;
      case 0xfc: { ins.sub = c.u32(); ins.name = `0xfc ${ins.sub}`; throw new UnsupportedOpcode(ins); }
      case 0xfd: throw new UnsupportedOpcode({ ...ins, name: 'SIMD (0xfd prefix)' });
      case 0xfb: throw new UnsupportedOpcode({ ...ins, name: 'GC (0xfb prefix)' });
      default:
        if (op >= 0x28 && op <= 0x3e) { ins.align = c.u32(); ins.memOffset = c.u32(); break; }
        if (OPNAMES[op] === undefined) throw new UnsupportedOpcode(ins);
    }
    out.push(ins);
  }
}

export class UnsupportedOpcode extends WasmFormatError {
  constructor(ins) {
    super(`unsupported or unknown instruction ${ins.name} at byte offset ${ins.offset}`);
    this.ins = ins;
  }
}

export function parseModule(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0x00 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) {
    throw new WasmFormatError('not a WebAssembly binary (missing \\0asm magic)');
  }
  const version = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
  if (version !== 1) throw new WasmFormatError(`unsupported WebAssembly version ${version} (component model binaries are not supported)`);
  const mod = {
    types: [], imports: [], funcs: [], globals: [], exports: [], memories: 0,
    importedFuncs: 0, importedGlobals: 0, funcNames: new Map(),
  };
  const c = new Cursor(u8, 8);
  let funcTypeIndices = [];
  while (!c.eof()) {
    const id = c.byte();
    const size = c.u32();
    const end = c.pos + size;
    if (end > u8.length) throw new WasmFormatError(`section ${id} overruns the file`);
    const s = new Cursor(u8, c.pos, end);
    switch (id) {
      case SECTION.type: {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const form = s.byte();
          if (form !== 0x60) throw new WasmFormatError(`unsupported type form 0x${form.toString(16)} (GC types are not supported)`);
          const params = []; const np = s.u32(); for (let j = 0; j < np; j++) params.push(readValType(s));
          const results = []; const nr = s.u32(); for (let j = 0; j < nr; j++) results.push(readValType(s));
          mod.types.push({ params, results });
        }
        break;
      }
      case SECTION.import: {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const module = s.name(), name = s.name(), kind = s.byte();
          const imp = { module, name, kind };
          if (kind === 0) { imp.type = s.u32(); mod.importedFuncs++; mod.funcs.push({ imported: true, typeIndex: imp.type, import: imp }); }
          else if (kind === 1) { s.byte(); readLimits(s); }
          else if (kind === 2) { readLimits(s); mod.memories++; }
          else if (kind === 3) { const t = readValType(s); const mut = s.byte(); mod.globals.push({ imported: true, type: t, mutable: !!mut, import: imp }); mod.importedGlobals++; }
          else if (kind === 4) { s.byte(); s.u32(); }
          else throw new WasmFormatError(`unknown import kind ${kind}`);
          mod.imports.push(imp);
        }
        break;
      }
      case SECTION.function: {
        const n = s.u32();
        funcTypeIndices = [];
        for (let i = 0; i < n; i++) funcTypeIndices.push(s.u32());
        break;
      }
      case SECTION.memory: mod.memories += s.u32(); break;
      case SECTION.global: {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const type = readValType(s);
          const mutable = !!s.byte();
          const init = readConstExpr(s);
          mod.globals.push({ imported: false, type, mutable, init });
        }
        break;
      }
      case SECTION.export: {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const name = s.name(); const kind = s.byte(); const index = s.u32();
          mod.exports.push({ name, kind: ['func', 'table', 'memory', 'global', 'tag'][kind] ?? `kind${kind}`, index });
        }
        break;
      }
      case SECTION.code: {
        const n = s.u32();
        if (n !== funcTypeIndices.length) throw new WasmFormatError('function and code section sizes differ');
        for (let i = 0; i < n; i++) {
          const bodySize = s.u32();
          const bodyEnd = s.pos + bodySize;
          const b = new Cursor(u8, s.pos, bodyEnd);
          const locals = [];
          const groups = b.u32();
          for (let g = 0; g < groups; g++) {
            const count = b.u32();
            const t = readValType(b);
            if (locals.length + count > 50000) throw new WasmFormatError('too many locals');
            for (let k = 0; k < count; k++) locals.push(t);
          }
          const bodyStart = b.pos;
          mod.funcs.push({ imported: false, typeIndex: funcTypeIndices[i], locals, body: null, bodyStart, bodyEnd, u8 });
          s.pos = bodyEnd;
        }
        break;
      }
      case SECTION.custom: {
        const name = s.name();
        if (name === 'name') {
          try {
            while (!s.eof()) {
              const sub = s.byte(); const len = s.u32(); const subEnd = s.pos + len;
              if (sub === 1) {
                const cnt = s.u32();
                for (let i = 0; i < cnt; i++) { const idx = s.u32(); mod.funcNames.set(idx, s.name()); }
              }
              s.pos = subEnd;
            }
          } catch { /* names are cosmetic */ }
        }
        break;
      }
      default: break; // table, start, element, data, datacount, tag: irrelevant for pure functions
    }
    c.pos = end;
  }
  return mod;
}

// Lazily decode (and cache) the instruction list of a defined function.
export function functionBody(mod, funcIndex) {
  const f = mod.funcs[funcIndex];
  if (!f || f.imported) return null;
  if (!f.body) f.body = decodeBody(new Cursor(f.u8, f.bodyStart, f.bodyEnd));
  return f.body;
}

export function functionType(mod, funcIndex) {
  const f = mod.funcs[funcIndex];
  return mod.types[f.typeIndex];
}

export function functionName(mod, funcIndex) {
  const exp = mod.exports.find((e) => e.kind === 'func' && e.index === funcIndex);
  return mod.funcNames.get(funcIndex) ?? exp?.name ?? `func[${funcIndex}]`;
}

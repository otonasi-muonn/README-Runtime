// Symbolic execution of a WebAssembly function into the expression IR.
// Structured control flow (block / if / br / br_if / br_table / return) is turned into
// path guards and selects; calls to other module functions are inlined. Everything the
// CSS runtime cannot express faithfully is rejected with a precise error.

import { functionBody, functionName, functionType } from '../wasm/reader.js';
import { IR } from './ir.js';

export class UnsupportedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const I32_BINOPS = {
  0x6a: 'add', 0x6b: 'sub', 0x6c: 'mul', 0x6d: 'div_s', 0x6e: 'div_u', 0x6f: 'rem_s', 0x70: 'rem_u',
  0x71: 'and', 0x72: 'or', 0x73: 'xor', 0x74: 'shl', 0x75: 'shr_s', 0x76: 'shr_u', 0x77: 'rotl', 0x78: 'rotr',
  0x46: 'eq', 0x47: 'ne', 0x48: 'lt_s', 0x49: 'lt_u', 0x4a: 'gt_s', 0x4b: 'gt_u', 0x4c: 'le_s', 0x4d: 'le_u',
  0x4e: 'ge_s', 0x4f: 'ge_u',
};
const I32_UNOPS = { 0x45: 'eqz', 0x67: 'clz', 0x68: 'ctz', 0x69: 'popcnt', 0xc0: 'extend8_s', 0xc1: 'extend16_s' };

const MAX_INLINE_DEPTH = 16;
export const MAX_IR_NODES = 20000;

function hint(ins) {
  const n = ins.name;
  if (n === 'loop') return 'loops are not supported inside the step function; README Runtime itself iterates step() once per frame, so write one step without a loop';
  if (/load|store|memory\./.test(n)) return 'linear memory is not available; pass the state as an i32 argument and return the new state (and compile with -O2 so locals stay in registers)';
  if (n.startsWith('i64') || n.includes('_i64') || n.endsWith('i64')) return 'only i32 arithmetic is supported; use 32-bit int types';
  if (n.startsWith('f32') || n.startsWith('f64') || /_f32|_f64/.test(n)) return 'floating point is not supported; use integer arithmetic';
  if (n === 'call_indirect') return 'indirect calls (function pointers) are not supported';
  if (n === 'global.set') return 'the step function must be pure: it may not write globals';
  return 'this instruction has no CSS equivalent in README Runtime yet';
}

export function liftFunction(mod, funcIndex, { ir = new IR() } = {}) {
  const type = functionType(mod, funcIndex);
  for (const t of [...type.params, ...type.results]) {
    if (t !== 'i32') {
      throw new UnsupportedError(`${functionName(mod, funcIndex)} has signature (${type.params.join(', ')}) -> (${type.results.join(', ')}); only i32 parameters and results are supported`);
    }
  }
  const inputs = type.params.map((_, i) => ir.input(i));
  const traps = [];
  const results = liftCall(ir, mod, funcIndex, inputs, ir.const(1), traps, [], 0);
  return { ir, inputs, results, traps };
}

function liftCall(ir, mod, funcIndex, args, entryGuard, traps, callStack, depth) {
  const fname = functionName(mod, funcIndex);
  const f = mod.funcs[funcIndex];
  if (!f) throw new UnsupportedError(`call to unknown function index ${funcIndex}`);
  if (f.imported) {
    throw new UnsupportedError(`${callStack.at(-1) ?? fname} calls imported function ${f.import.module}.${f.import.name}; imports cannot run inside CSS`);
  }
  if (callStack.includes(funcIndex)) throw new UnsupportedError(`recursion is not supported (${[...callStack.map((i) => functionName(mod, i)), fname].join(' -> ')})`);
  if (depth > MAX_INLINE_DEPTH) throw new UnsupportedError(`call depth exceeds ${MAX_INLINE_DEPTH} while inlining ${fname}`);
  const type = functionType(mod, funcIndex);
  for (const t of [...type.params, ...type.results]) {
    if (t !== 'i32') throw new UnsupportedError(`${fname} uses type ${t}; only i32 is supported`);
  }
  const body = functionBody(mod, funcIndex);
  const locals = [...args];
  for (const t of f.locals) {
    if (t !== 'i32') throw new UnsupportedError(`${fname} declares a local of type ${t}; only i32 is supported`);
    locals.push(ir.const(0));
  }
  const stack = callStack.concat([funcIndex]);

  const fail = (ins, msg) => {
    const where = `${fname} at byte offset ${ins.offset}`;
    throw new UnsupportedError(`${msg ?? `unsupported instruction '${ins.name}'`} in ${where}: ${hint(ins)}`, { instruction: ins.name, offset: ins.offset, function: fname });
  };

  const blockArity = (ins) => {
    const bt = ins.blockType;
    const t = bt.typeIndex !== undefined ? mod.types[bt.typeIndex] : bt;
    if (!t) fail(ins, 'invalid block type');
    if (t.params.length) fail(ins, 'blocks with parameters (multi-value) are not supported');
    if (t.results.length > 1) fail(ins, 'blocks with multiple results are not supported');
    if (t.results.some((r) => r !== 'i32')) fail(ins, `block result type ${t.results[0]} is not supported`);
    return t.results.length;
  };

  // Label frames: innermost last. Each collects the states that jump to its end.
  const frames = [{ kind: 'func', arity: type.results.length, exits: [], height: 0 }];

  const skipToEnd = (pc) => {
    let d = 0;
    for (; pc < body.length; pc++) {
      const op = body[pc].op;
      if (op === 0x02 || op === 0x03 || op === 0x04) d++;
      else if (op === 0x0b) { if (d === 0) return pc; d--; }
      else if (op === 0x05 && d === 0) return pc;
    }
    throw new UnsupportedError(`malformed function body in ${fname}`);
  };

  const check = () => {
    if (ir.nodes.length > MAX_IR_NODES) throw new UnsupportedError(`${fname} is too large to translate (more than ${MAX_IR_NODES} expression nodes)`);
  };

  const exitTo = (ins, label, st) => {
    const frame = frames[frames.length - 1 - label];
    if (!frame) fail(ins, `branch to invalid label ${label}`);
    if (frame.kind === 'loop') fail({ ...ins, name: 'loop' }, 'branch back to a loop header');
    if (st.stack.length < frame.arity) fail(ins, 'stack underflow at branch');
    frame.exits.push({ guard: st.guard, locals: st.locals.slice(), values: st.stack.slice(st.stack.length - frame.arity) });
  };

  const mergeValues = (entries, pick) => {
    const vals = entries.map(pick);
    if (vals.every((v) => v === vals[0])) return vals[0];
    let v = vals[vals.length - 1];
    for (let i = vals.length - 2; i >= 0; i--) v = ir.op('select', entries[i].guard, vals[i], v);
    return v;
  };

  // Join all states arriving at the end of `frame`. `fallthrough` may be null.
  const join = (frame, fallthroughs, baseStack) => {
    const entries = [];
    for (const ft of fallthroughs) {
      if (!ft) continue;
      if (ft.stack.length !== frame.height + frame.arity) {
        throw new UnsupportedError(`stack height mismatch at block end in ${fname}`);
      }
      entries.push({ guard: ft.guard, locals: ft.locals, values: ft.stack.slice(ft.stack.length - frame.arity) });
    }
    entries.push(...frame.exits);
    if (!entries.length) return null;
    const locals = entries[0].locals.map((_, j) => mergeValues(entries, (e) => e.locals[j]));
    const values = [];
    for (let j = 0; j < frame.arity; j++) values.push(mergeValues(entries, (e) => e.values[j]));
    let guard = entries[0].guard;
    for (let i = 1; i < entries.length; i++) guard = ir.op('lor', guard, entries[i].guard);
    check();
    return { guard, locals, stack: baseStack.concat(values) };
  };

  const run = (pc, st) => {
    for (;;) {
      const ins = body[pc];
      if (!ins) throw new UnsupportedError(`unexpected end of body in ${fname}`);
      if (ins.op === 0x0b || ins.op === 0x05) return { pc, st };
      if (st === null) { pc = skipToEnd(pc); continue; }
      const pop = () => {
        if (st.stack.length <= frames[frames.length - 1].height) fail(ins, 'stack underflow');
        return st.stack.pop();
      };
      const push = (v) => st.stack.push(v);
      const op = ins.op;
      if (I32_BINOPS[op]) {
        const b = pop(), a = pop();
        const name = I32_BINOPS[op];
        if (name === 'div_s' || name === 'div_u' || name === 'rem_s' || name === 'rem_u') {
          if (!(b.op === 'const' && b.value !== 0)) traps.push(ir.and(st.guard, ir.op('eqz', b)));
          if (name === 'div_s' && !(b.op === 'const' && b.value !== -1)) {
            const ovf = ir.and(ir.op('eq', a, ir.const(-2147483648)), ir.op('eq', b, ir.const(-1)));
            if (!(ovf.op === 'const' && ovf.value === 0)) traps.push(ir.and(st.guard, ovf));
          }
        }
        if (name === 'rotl' || name === 'rotr') {
          if (b.op !== 'const') fail(ins, `'${ins.name}' with a variable rotation amount is not supported`);
          const k = (name === 'rotl' ? b.value : 32 - b.value) & 31;
          push(k === 0 ? a : ir.op('or', ir.op('shl', a, ir.const(k)), ir.op('shr_u', a, ir.const(32 - k))));
          pc++; check(); continue;
        }
        push(ir.op(name, a, b));
        pc++; check(); continue;
      }
      if (I32_UNOPS[op]) { push(ir.op(I32_UNOPS[op], pop())); pc++; continue; }
      switch (op) {
        case 0x01: pc++; break; // nop
        case 0x41: push(ir.const(ins.value)); pc++; break;
        case 0x20: {
          if (ins.local >= st.locals.length) fail(ins, `invalid local index ${ins.local}`);
          push(st.locals[ins.local]); pc++; break;
        }
        case 0x21: case 0x22: {
          if (ins.local >= st.locals.length) fail(ins, `invalid local index ${ins.local}`);
          const v = pop();
          st.locals[ins.local] = v;
          if (op === 0x22) push(v);
          pc++; break;
        }
        case 0x23: {
          const g = mod.globals[ins.global];
          if (!g) fail(ins, `invalid global index ${ins.global}`);
          if (g.imported) fail(ins, 'reads an imported global');
          if (g.mutable) fail(ins, 'reads a mutable global (for example the C stack pointer: compile with -O2 and avoid arrays/addresses)');
          if (g.type !== 'i32' || g.init.kind !== 'i32') fail(ins, `reads a non-i32 global`);
          push(ir.const(g.init.value)); pc++; break;
        }
        case 0x1a: pop(); pc++; break; // drop
        case 0x1b: case 0x1c: { // select
          if (op === 0x1c && (ins.types.length !== 1 || ins.types[0] !== 'i32')) fail(ins, 'typed select on non-i32 values');
          const c = pop(), b = pop(), a = pop();
          push(ir.op('select', c, a, b)); pc++; check(); break;
        }
        case 0x02: { // block
          const arity = blockArity(ins);
          const frame = { kind: 'block', arity, exits: [], height: st.stack.length };
          frames.push(frame);
          const base = st.stack.slice();
          const r = run(pc + 1, { guard: st.guard, locals: st.locals.slice(), stack: st.stack.slice() });
          frames.pop();
          if (body[r.pc].op !== 0x0b) fail(body[r.pc], "unexpected 'else' in block");
          st = join(frame, [r.st], base);
          pc = r.pc + 1;
          break;
        }
        case 0x04: { // if
          const arity = blockArity(ins);
          const cond = ir.bool(pop());
          const frame = { kind: 'if', arity, exits: [], height: st.stack.length };
          const base = st.stack.slice();
          frames.push(frame);
          const thenGuard = ir.and(st.guard, cond);
          const elseGuard = ir.and(st.guard, ir.not(cond));
          const r1 = run(pc + 1, { guard: thenGuard, locals: st.locals.slice(), stack: st.stack.slice() });
          let elseState, endPc;
          if (body[r1.pc].op === 0x05) {
            const r2 = run(r1.pc + 1, { guard: elseGuard, locals: st.locals.slice(), stack: st.stack.slice() });
            elseState = r2.st; endPc = r2.pc;
          } else {
            if (arity) fail(ins, "'if' with a result but no 'else'");
            elseState = { guard: elseGuard, locals: st.locals.slice(), stack: st.stack.slice() };
            endPc = r1.pc;
          }
          frames.pop();
          st = join(frame, [r1.st, elseState], base);
          pc = endPc + 1;
          break;
        }
        case 0x0c: exitTo(ins, ins.label, st); st = null; pc++; break; // br
        case 0x0d: { // br_if
          const c = ir.bool(pop());
          exitTo(ins, ins.label, { guard: ir.and(st.guard, c), locals: st.locals, stack: st.stack });
          st = { guard: ir.and(st.guard, ir.not(c)), locals: st.locals, stack: st.stack };
          pc++; check(); break;
        }
        case 0x0e: { // br_table
          const idx = pop();
          let rest = st.guard;
          ins.labels.forEach((label, j) => {
            const hit = ir.op('eq', idx, ir.const(j));
            exitTo(ins, label, { guard: ir.and(rest, hit), locals: st.locals, stack: st.stack });
            rest = ir.and(rest, ir.not(hit));
          });
          exitTo(ins, ins.defaultLabel, { guard: rest, locals: st.locals, stack: st.stack });
          st = null; pc++; check(); break;
        }
        case 0x0f: exitTo(ins, frames.length - 1, st); st = null; pc++; break; // return
        case 0x00: traps.push(st.guard); st = null; pc++; break; // unreachable
        case 0x10: { // call -> inline
          const ct = functionType(mod, ins.func);
          if (!ct) fail(ins, `call to invalid function ${ins.func}`);
          const cargs = [];
          for (let i = 0; i < ct.params.length; i++) cargs.unshift(pop());
          const res = liftCall(ir, mod, ins.func, cargs, st.guard, traps, stack, depth + 1);
          for (const r of res) push(r);
          pc++; break;
        }
        default: fail(ins);
      }
    }
  };

  const final = run(0, { guard: entryGuard, locals, stack: [] });
  if (body[final.pc].op !== 0x0b || final.pc !== body.length - 1) throw new UnsupportedError(`malformed function body in ${fname}`);
  const out = join(frames[0], [final.st], []);
  if (!out) {
    // Every path traps: the function can never return.
    return type.results.map(() => ir.const(0));
  }
  return out.stack;
}

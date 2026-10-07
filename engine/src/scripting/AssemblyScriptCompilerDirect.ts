import { ENTITY_SCRIPT_SDK } from './EntityScriptSDK.generated.ts';
import { ENTITY_FUEL, MAX_SCRIPT_SOURCE_BYTES, MEMORY_PAGES_SECTION } from './EntityScriptModule.ts';

type CompilerDependencies = [typeof import('assemblyscript/asc'), typeof import('binaryen')];
let compiler: Promise<CompilerDependencies> | null = null;
export function preloadAssemblyScriptRuntime(): Promise<CompilerDependencies> {
  if (!compiler) {
    const pending = Promise.all([import('assemblyscript/asc'), import('binaryen')]);
    compiler = pending;
    void pending.catch(() => { if (compiler === pending) compiler = null; });
  }
  return compiler;
}
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<WebAssembly.Module>>();

/** Instrument the FINAL optimized WASM, so optimization cannot erase budget checks. */
function meter(binary: Uint8Array, b: any): Uint8Array {
  const m = b.readBinary(binary);
  m.setFeatures(b.Features.MVP | b.Features.BulkMemory | b.Features.BulkMemoryOpt | b.Features.NontrappingFPToInt | b.Features.SignExt);
  try {
    const memory = m.getMemoryInfo();
    if (memory.module !== 'env' || memory.base !== 'memory' || memory.shared || memory.is64
      || memory.initial < 1 || memory.initial > 64 || memory.max !== 64) {
      throw new Error('Invalid entity WASM memory import');
    }
    m.addCustomSection(MEMORY_PAGES_SECTION, Uint8Array.of(memory.initial));
    m.addFunctionImport('__entityBudget', 'entity', 'budget', b.none, b.none);
    m.addGlobal('__entityFuel', b.i32, true, m.i32.const(ENTITY_FUEL));
    const keys: Record<number, string[]> = {
      [b.BlockId]: ['children'], [b.IfId]: ['condition', 'ifTrue', 'ifFalse'], [b.LoopId]: ['body'],
      [b.BreakId]: ['condition', 'value'], [b.SwitchId]: ['condition', 'value'],
      [b.CallId]: ['operands'], [b.CallIndirectId]: ['target', 'operands'],
      [b.LocalSetId]: ['value'], [b.GlobalSetId]: ['value'], [b.LoadId]: ['ptr'],
      [b.StoreId]: ['ptr', 'value'], [b.UnaryId]: ['value'], [b.BinaryId]: ['left', 'right'],
      [b.SelectId]: ['condition', 'ifTrue', 'ifFalse'], [b.DropId]: ['value'], [b.ReturnId]: ['value'],
      [b.MemoryGrowId]: ['delta'], [b.MemoryCopyId]: ['dest', 'source', 'size'],
      [b.MemoryFillId]: ['dest', 'value', 'size'], [b.MemoryInitId]: ['dest', 'offset', 'size'],
    };
    const leaves = new Set([b.ConstId, b.LocalGetId, b.GlobalGetId, b.NopId, b.UnreachableId, b.MemorySizeId, b.DataDropId]);
    const checkpoint = () => m.call('__entityMeter', [], b.none);
    const visit = (ref: number) => {
      if (!ref) return;
      if (leaves.has(b._BinaryenExpressionGetId(ref))) return;
      const info = b.getExpressionInfo(ref);
      const fields = keys[info.id];
      if (!fields) throw new Error(`Unsupported WASM instruction in sandbox: ${info.id}`);
      for (const key of fields) {
        const value = info[key];
        if (Array.isArray(value)) value.forEach(visit);
        else if (value) visit(value);
      }
      if (info.id === b.LoopId) {
        b._BinaryenLoopSetBody(ref, m.block(null, [checkpoint(), info.body], b.getExpressionType(info.body)));
      }
    };
    const count = m.getNumFunctions();
    for (let i = 0; i < count; i++) {
      const fn = m.getFunctionByIndex(i), info = b.getFunctionInfo(fn);
      if (!info.body) continue;
      visit(info.body);
      b._BinaryenFunctionSetBody(fn, m.block(null, [checkpoint(), info.body], b.getExpressionType(info.body)));
    }
    m.addFunction('__entityMeter', b.none, b.none, [], m.block(null, [
      m.global.set('__entityFuel', m.i32.sub(m.global.get('__entityFuel', b.i32), m.i32.const(1))),
      m.if(m.i32.or(
        m.i32.lt_s(m.global.get('__entityFuel', b.i32), m.i32.const(0)),
        m.i32.eqz(m.i32.and(m.global.get('__entityFuel', b.i32), m.i32.const(255)))
      ), m.call('__entityBudget', [], b.none))
    ]));
    m.addFunction('__setFuel', b.i32, b.none, [], m.global.set('__entityFuel', m.local.get(0, b.i32)));
    m.addFunctionExport('__setFuel', '__setFuel');
    m.addFunction('__fuel', b.none, b.i32, [], m.global.get('__entityFuel', b.i32));
    m.addFunctionExport('__fuel', '__fuel');
    if (!m.validate()) throw new Error('Invalid metered entity WASM');
    return m.emitBinary();
  } finally { m.dispose(); }
}

export function compileEntityScriptDirect(source: string): Promise<WebAssembly.Module> {
  if (new TextEncoder().encode(source).length > MAX_SCRIPT_SOURCE_BYTES) {
    return Promise.reject(new Error('AssemblyScript source exceeds 64 KiB'));
  }
  const existing = cache.get(source);
  if (existing) return existing;
  const result = queue.then(async () => {
    const [asc, { default: binaryen }] = await preloadAssemblyScriptRuntime();
    const program = `import { Component, Context, Value, State, Api, Body, Input, World, Messages, Voxels, MicroVoxels, Constraints, Selection, CommandResults, Blocks } from './sdk';\nexport function __tick(selfHandle: i32, ctxHandle: i32): void {\nconst self = new Component(selfHandle);\nconst ctx = new Context(ctxHandle);\n${source}\n}`;
    // Only these two virtual source files and the compiler's embedded standard
    // library are accessible. No filesystem, npm imports, transforms or WASI.
    const files: Record<string, string> = { 'entity.ts': program, 'sdk.ts': ENTITY_SCRIPT_SDK };
    let bytes: Uint8Array | null = null;
    const errors = asc.createMemoryStream();
    const output = await asc.main(['entity.ts', '--outFile', 'entity.wasm', '--runtime', 'stub',
      '--exportRuntime', '--importMemory', '--initialMemory', '0', '--maximumMemory', '64', '--stackSize', '16384',
      '--optimizeLevel', '2', '--shrinkLevel', '0', '--disable', 'simd,threads,exception-handling,tail-calls'], {
      readFile: (name: string) => files[name] ?? null,
      listFiles: () => [],
      writeFile: (name, data) => { if (name === 'entity.wasm' && data instanceof Uint8Array) bytes = data; },
      stderr: errors,
    });
    if (output.error || !bytes) throw new Error(errors.toString().trim() || 'AssemblyScript compilation failed');
    const wasm = meter(bytes, binaryen);
    const module = new WebAssembly.Module(wasm as BufferSource);
    const allowed = new Set(['get', 'number', 'boolean', 'stringLength', 'stringCopy', 'make', 'set', 'call', 'budget']);
    for (const entry of WebAssembly.Module.imports(module)) {
      const allowedFunction = entry.kind === 'function' && (entry.module === 'entity' && allowed.has(entry.name)
        || entry.module === 'env' && ['abort', 'seed', 'trace'].includes(entry.name));
      const allowedMemory = entry.kind === 'memory' && entry.module === 'env' && entry.name === 'memory';
      if (!allowedFunction && !allowedMemory) {
        throw new Error(`Unsupported entity import: ${entry.module}.${entry.name}`);
      }
    }
    return module;
  });
  queue = result.catch(() => {});
  cache.set(source, result);
  // Bound compiled-module retention across edited/deleted entities.
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  result.catch(() => { if (cache.get(source) === result) cache.delete(source); });
  return result;
}


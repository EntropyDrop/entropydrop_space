import { compileEntityScript, getCompiledEntityScript, getEntityScriptMemoryPages, ENTITY_FUEL } from './AssemblyScriptCompiler.ts';
import { createEntityScriptHost } from './EntityScriptHost.ts';
import { getEntityScriptInstancePolicy, SCRIPT_INITIALIZATION_LIMIT_MS, ENTITY_INITIALIZATION_LIMIT_MS,
  SCRIPT_EXECUTION_LIMIT_MS, ENTITY_EXECUTION_LIMIT_MS, ENTITY_TICK_LIMIT_MS } from './EntityScriptModule.ts';
import { copyScriptData as dataCopy, validateScriptData, validateScriptDataWrite,
  ScriptBudgetError as BudgetError, SCRIPT_DATA_LIMIT_BYTES as DATA_LIMIT,
  BLOCKED_SCRIPT_DATA_KEYS as BLOCKED_KEYS } from './BoundedScriptData.ts';
export { preloadAssemblyScriptRuntime } from './AssemblyScriptCompiler.ts';

const MEMORY_LIMIT = 4 * 1024 * 1024;
const own = (value: any, key: string) => value != null && Object.prototype.hasOwnProperty.call(value, key);

type ComponentMemory = {
  module: WebAssembly.Module; memory: WebAssembly.Memory; initialBytes: number; inUse: boolean;
  instance?: WebAssembly.Instance; initialMemory?: Uint8Array;
  bindings: { entity: Record<string, Function>; env: Record<string, Function> } | null;
};
type Entity = { modules: Map<string, WebAssembly.Module>; memories: Map<string, ComponentMemory>; revisions: Map<string, number>; pending: Set<Promise<any>>; disposed: boolean; preparationDeferrals: number };
class TimeBudgetError extends BudgetError {
  readonly budgetPhase: 'initialization' | 'execution' | 'tick';
  constructor(message: string, budgetPhase: 'initialization' | 'execution' | 'tick') {
    super(message);
    this.budgetPhase = budgetPhase;
  }
}
export function createAssemblyScriptRuntimeService() {
  const entities = new Map<string, Entity>();
  const stringDecoder = new TextDecoder('utf-16le', { ignoreBOM: true });
  const entityFor = (id: string): Entity => {
    let e = entities.get(id);
    if (!e) entities.set(id, e = { modules: new Map(), memories: new Map(), revisions: new Map(), pending: new Set(), disposed: false, preparationDeferrals: 0 });
    return e;
  };
  const trimCache = (entity: Entity) => {
    const bytes = (entry: ComponentMemory) => entry.memory.buffer.byteLength + (entry.initialMemory?.byteLength || 0);
    let retained = [...entity.memories.values()].reduce((sum, entry) => sum + bytes(entry), 0);
    for (const [id, entry] of entity.memories) {
      if (retained <= MEMORY_LIMIT) break;
      entity.memories.delete(id);
      retained -= bytes(entry);
    }
  };
  const tick = (entity: Entity, message: any) => {
    const started = performance.now();
    const snapshot = message.snapshot || {};
    let rays = 0, reads = 0, fuel = ENTITY_FUEL, memoryUsed = 0, bridgeBytes = 0;
    const host = createEntityScriptHost((kind, position, offset) => {
      if (++reads > 256) return 'null';
      const result = kind === 'micro' ? message.hostApi?.worldMicroVoxelGet?.(position, offset)
        : message.hostApi?.worldVoxelGet?.(position);
      return JSON.stringify(dataCopy(result ?? { block: 0, color: 0, materialId: 0 }));
    }, (origin, direction, options) => {
      if (++rays > 64) return 'null';
      return JSON.stringify(dataCopy(message.hostApi?.worldRaycast?.(origin, direction, options) ?? null));
    });
    const errors: any[] = [], executionTimes: Record<string, number> = {}, initializationTimes: Record<string, number> = {};
    let initializationMs = 0, executionMs = 0, instancesCreated = 0, instancesReused = 0;
    const metrics = () => ({ initializationTimes, executionTimes, initializationMs, executionMs,
      instancesCreated, instancesReused, fuelUsed: ENTITY_FUEL - fuel, elapsedMs: performance.now() - started });
    let executedComponents = 0;
    try {
      validateScriptData(snapshot.states || {});
      host.beginTick(snapshot);
      const order = (snapshot.scriptOrder || [...entity.modules.keys()]).slice(0, 64);
      for (const nodeId of order) {
        const module = entity.modules.get(nodeId);
        if (!module || snapshot.enabled?.[nodeId] === false) continue;
        const self = host.getSelf(nodeId);
        if (!self) continue;
        const componentStarted = performance.now();
        let executionStarted: number | null = null;
        let seed = 2166136261;
        for (const character of `${snapshot.entityId || ''}:${nodeId}:${snapshot.tick || 0}`) {
          seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
        }
        let instance: WebAssembly.Instance | null = null;
        let componentMemory: ComponentMemory | undefined;
        let hostOperations = 0;
        let phase = 'bridge-setup';
        let lastHostCall = 'none';
        const handles: any[] = [null];
        const writable = new WeakSet<object>();
        const allowWrite = (v: any) => {
          if (!v || typeof v !== 'object' || Object.isFrozen(v) || writable.has(v)) return;
          writable.add(v);
          Object.values(v).forEach(allowWrite);
        };
        // All component states are intentionally shared within this entity.
        for (const node of snapshot.components || []) allowWrite(host.getSelf(node.id)?.state);
        const memory = () => (instance!.exports.memory as WebAssembly.Memory).buffer;
        const check = () => {
          const now = performance.now();
          const kind = executionStarted === null ? 'initialization' : 'execution';
          const componentElapsed = now - (executionStarted ?? componentStarted);
          const limit = executionStarted === null ? SCRIPT_INITIALIZATION_LIMIT_MS : SCRIPT_EXECUTION_LIMIT_MS;
          if (componentElapsed > limit) {
            const label = executionStarted === null ? 'WASM initialization' : 'Script';
            throw new TimeBudgetError(`${label} exceeded ${limit} ms and the entity was stopped (elapsed=${componentElapsed.toFixed(1)} ms, phase=${phase}, hostOps=${hostOperations}, lastHostCall=${lastHostCall})`, kind);
          }
          const aggregate = executionStarted === null ? initializationMs : executionMs;
          const aggregateLimit = executionStarted === null ? ENTITY_INITIALIZATION_LIMIT_MS : ENTITY_EXECUTION_LIMIT_MS;
          if (aggregate + componentElapsed > aggregateLimit) throw new TimeBudgetError(`Entity exceeded the aggregate ${aggregateLimit} ms ${kind} limit`, kind);
          if (now - started > ENTITY_TICK_LIMIT_MS) throw new TimeBudgetError(`Entity exceeded the total ${ENTITY_TICK_LIMIT_MS} ms tick limit`, 'tick');
          if (instance && (instance.exports.__fuel as Function)() < 0) throw new BudgetError('Entity exceeded its WASM execution fuel budget');
          if (componentMemory && memoryUsed + componentMemory.memory.buffer.byteLength > MEMORY_LIMIT) throw new BudgetError('Entity exceeded 4 MiB WASM memory');
        };
        const operation = () => {
          check();
          if (++hostOperations > 16384) throw new BudgetError('Entity host operation limit exceeded');
        };
        const put = (v: any): number => {
          if (v == null) return 0;
          bridgeBytes += typeof v === 'string' ? v.length * 2 + 32 : 32;
          if (bridgeBytes > DATA_LIMIT) throw new BudgetError('Entity bridge allocation exceeds 1 MiB');
          if (handles.length >= 16384) throw new BudgetError('Entity handle limit exceeded');
          return handles.push(v) - 1;
        };
        const value = (h: number) => {
          if (!Number.isInteger(h) || h < 0 || h >= handles.length) throw new Error('Invalid entity handle');
          return handles[h];
        };
        const stringAt = (ptr: number): string => {
          if (!ptr) return '';
          const buffer = memory();
          if (ptr < 4 || ptr % 2 || ptr > buffer.byteLength) throw new Error('Invalid WASM string pointer');
          const length = new DataView(buffer).getUint32(ptr - 4, true);
          if (length > 128 * 1024 || length % 2 || ptr + length > buffer.byteLength) throw new Error('Invalid WASM string length');
          return stringDecoder.decode(new Uint8Array(buffer, ptr, length));
        };
        const keyAt = (ptr: number) => {
          const key = stringAt(ptr);
          if (BLOCKED_KEYS.has(key)) throw new Error('Reserved entity property');
          return key;
        };
        const imports = {
          budget: check,
          get: (h: number, keyPtr: number) => { operation(); const v = value(h), key = keyAt(keyPtr); return put(own(v, key) ? v[key] : null); },
          number: (h: number) => { operation(); const v = value(h); return typeof v === 'number' && Number.isFinite(v) ? v : 0; },
          boolean: (h: number) => { operation(); return value(h) === true ? 1 : 0; },
          stringLength: (h: number) => { operation(); const v = value(h); return typeof v === 'string' ? v.length : 0; },
          stringCopy: (h: number, ptr: number) => {
            operation(); const v = value(h); if (typeof v !== 'string') return;
            if (ptr < 0 || ptr % 2 || ptr + v.length * 2 > memory().byteLength) throw new Error('Invalid WASM string destination');
            const target = new Uint16Array(memory(), ptr, v.length);
            for (let i = 0; i < v.length; i++) target[i] = v.charCodeAt(i);
          },
          make: (kind: number, n: number, ptr: number) => {
            operation();
            const v = kind === 0 ? Object.create(null) : kind === 1 ? [] : kind === 2 ? n : kind === 3 ? stringAt(ptr) : kind === 4 ? n !== 0 : null;
            if (v && typeof v === 'object') writable.add(v);
            return put(v);
          },
          set: (h: number, keyPtr: number, source: number) => {
            operation(); const target = value(h), key = keyAt(keyPtr);
            if (!target || !writable.has(target) || Object.isFrozen(target)) throw new Error('Entity snapshot is read-only');
            if (Array.isArray(target) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) > 16383 || Number(key) > target.length)) throw new Error('Invalid array index');
            const allocation = { bytes: 0, nodes: 0 };
            const copy = dataCopy(value(source), allocation);
            bridgeBytes += allocation.bytes;
            if (bridgeBytes > DATA_LIMIT) throw new BudgetError('Entity bridge allocation exceeds 1 MiB');
            // Validate the complete value BEFORE writing, including aliases and growth.
            validateScriptDataWrite(target, key, copy);
            target[key] = copy;
            allowWrite(copy);
          },
          call: (h: number, namePtr: number, argsHandle: number) => {
            operation(); const target = value(h), name = keyAt(namePtr), args = value(argsHandle);
            if (!own(target, name) || typeof target[name] !== 'function' || !Array.isArray(args) || args.length > 16) throw new Error('Unknown entity API call');
            lastHostCall = name;
            return put(target[name](...args));
          }
        };
        try {
          phase = 'memory-preparation';
          componentMemory = entity.memories.get(nodeId);
          if (!componentMemory || componentMemory.module !== module || componentMemory.inUse) {
            const pages = getEntityScriptMemoryPages(module);
            componentMemory = { module, memory: new WebAssembly.Memory({ initial: pages, maximum: 64 }),
              initialBytes: pages * 65536, inUse: false, bindings: null };
            entity.memories.delete(nodeId);
            entity.memories.set(nodeId, componentMemory);
            // Also bound the cache when preparation fails before instantiation.
            trimCache(entity);
          }
          componentMemory.inUse = true;
          const policy = getEntityScriptInstancePolicy(module);
          componentMemory.bindings = { entity: imports, env: {
            abort: (msg: number) => {
              const message = instance ? stringAt(msg) : 'AssemblyScript abort';
              if (/memory|allocat|heap/i.test(message)) throw new BudgetError(message);
              throw new Error(message);
            },
            seed: () => { operation(); return seed || 1; }, trace: () => { operation(); }
          } };
          if (policy.resettable && componentMemory.instance && componentMemory.initialMemory) {
            phase = 'instance-reset';
            instance = componentMemory.instance;
            new Uint8Array(componentMemory.memory.buffer).set(componentMemory.initialMemory);
            (instance.exports.__resetGlobals as Function)();
            instancesReused++;
          } else {
            new Uint8Array(componentMemory.memory.buffer).fill(0);
            check();
            phase = 'wasm-instantiation';
            // Cached WASM imports dispatch to this invocation's host closures.
            // They retain neither old snapshots nor old command buffers.
            const entry = componentMemory;
            const dispatch = (group: 'entity' | 'env', name: string) => (...args: any[]) => {
              if (!entry.bindings) throw new Error('Entity WASM instance is inactive');
              return entry.bindings[group][name](...args);
            };
            instance = new WebAssembly.Instance(module, {
              entity: Object.fromEntries(Object.keys(imports).map(name => [name, dispatch('entity', name)])),
              env: { memory: entry.memory, abort: dispatch('env', 'abort'), seed: dispatch('env', 'seed'), trace: dispatch('env', 'trace') }
            });
            instancesCreated++;
            if (policy.resettable) {
              // Capture active data segments BEFORE guest startup. The start
              // function must run again with this tick's seed and fuel allowance.
              entry.initialMemory = new Uint8Array(entry.memory.buffer).slice();
              entry.instance = instance;
            }
            trimCache(entity); // Includes both linear memory and its reset image.
          }
          (instance.exports.__setFuel as Function)(fuel);
          check();
          if (policy.explicitStart) {
            phase = 'wasm-start';
            (instance.exports.__initialize as Function)();
            check();
          }
          phase = 'context-construction';
          const context = host.context(nodeId);
          check();
          executionStarted = performance.now();
          initializationTimes[nodeId] = executionStarted - componentStarted;
          initializationMs += initializationTimes[nodeId];
          phase = 'wasm-execution';
          executedComponents++;
          (instance.exports.__tick as Function)(put(self), put(context));
          phase = 'final-check';
          check();
        } catch (error: any) {
          if (host.isStop(error)) break;
          // Engine preparation can be interrupted by a browser/GC stall before
          // guest code executes. Abort this untouched frame and let the caller
          // retain the last completed commands, just as while compilation is
          // pending. Do not retry guest execution, a trapped module start,
          // memory/fuel failures, aggregate overruns, or unlimited slow starts.
          if (error instanceof TimeBudgetError && error.budgetPhase === 'initialization' && componentMemory
            && (phase === 'memory-preparation' || phase === 'wasm-instantiation' || phase === 'instance-reset')
            && hostOperations === 0 && executedComponents === 0 && errors.length === 0
            && performance.now() - componentStarted > SCRIPT_INITIALIZATION_LIMIT_MS
            && initializationMs + performance.now() - componentStarted <= ENTITY_INITIALIZATION_LIMIT_MS
            && performance.now() - started <= ENTITY_TICK_LIMIT_MS
            && memoryUsed + componentMemory.memory.buffer.byteLength <= MEMORY_LIMIT
            && (instance ? (instance.exports.__fuel as Function)() : fuel) >= 0
            && entity.preparationDeferrals < 2) {
            entity.preparationDeferrals++;
            return { requestId: message.requestId, ok: true, pending: true,
              deferredReason: 'wasm-preparation', ...metrics(),
              initializationMs: initializationMs + performance.now() - componentStarted };
          }
          if (error instanceof BudgetError || error instanceof WebAssembly.RuntimeError || error instanceof RangeError) throw error;
          errors.push({ nodeId, error: String(error?.message || error).slice(0, 2000) });
        } finally {
          if (componentMemory) {
            componentMemory.inUse = false;
            componentMemory.bindings = null;
            // Memory cannot shrink. Retaining a grown buffer would expose a
            // different memory.size on the next frame, so discard it instead.
            if (componentMemory.memory.buffer.byteLength !== componentMemory.initialBytes
              && entity.memories.get(nodeId) === componentMemory) entity.memories.delete(nodeId);
          }
          if (instance) {
            fuel = (instance.exports.__fuel as Function)();
            memoryUsed += memory().byteLength;
          }
          if (executionStarted === null) {
            initializationTimes[nodeId] = performance.now() - componentStarted;
            initializationMs += initializationTimes[nodeId];
          } else {
            executionTimes[nodeId] = performance.now() - executionStarted;
            executionMs += executionTimes[nodeId];
          }
        }
        if (host.shouldStop()) break;
      }
      const result = host.finish();
      validateScriptData(result.states);
      if (performance.now() - started > ENTITY_TICK_LIMIT_MS) throw new TimeBudgetError(`Entity exceeded the total ${ENTITY_TICK_LIMIT_MS} ms tick limit`, 'tick');
      entity.preparationDeferrals = 0;
      return { requestId: message.requestId, ...result, errors, ...metrics() };
    } catch (error: any) {
      // Never apply partially emitted commands or state after a budget/memory trap.
      return { requestId: message.requestId, ok: false, fatal: true, errors, ...metrics(),
        budgetPhase: error instanceof TimeBudgetError ? error.budgetPhase : undefined, error: error?.message || String(error) };
    }
  };
  function handle(message: any): any {
    const { type, entityRuntimeId, requestId, nodeId } = message;
    if (type === 'dispose') {
      const entity = entities.get(entityRuntimeId);
      if (entity) { entity.disposed = true; entity.modules.clear(); entity.memories.clear(); }
      entities.delete(entityRuntimeId);
      return { requestId, ok: true };
    }
    const entity = entityFor(entityRuntimeId);
    if (type === 'set-script') {
      const revision = (entity.revisions.get(nodeId) || 0) + 1;
      entity.revisions.set(nodeId, revision);
      entity.modules.delete(nodeId);
      entity.memories.delete(nodeId);
      const code = String(message.code || '');
      if (!code.trim()) return { requestId, nodeId, ok: true };
      if (entity.modules.size + entity.pending.size >= 64) return { requestId, nodeId, ok: false, error: 'Entity script component limit exceeded' };
      const cached = getCompiledEntityScript(code);
      if (cached) { entity.modules.set(nodeId, cached); return { requestId, nodeId, ok: true }; }
      const pending = compileEntityScript(code).then(module => {
        if (!entity.disposed && entity.revisions.get(nodeId) === revision) entity.modules.set(nodeId, module);
        return { requestId, nodeId, ok: true, stale: entity.disposed || entity.revisions.get(nodeId) !== revision };
      }, error => ({ requestId, nodeId, ok: false, error: error.message || String(error), stale: entity.disposed || entity.revisions.get(nodeId) !== revision }));
      entity.pending.add(pending);
      pending.finally(() => entity.pending.delete(pending));
      return pending;
    }
    if (type === 'reset') {
      entity.preparationDeferrals = 0;
      for (const entry of entity.memories.values()) {
        if (!entry.inUse) new Uint8Array(entry.memory.buffer).fill(0);
      }
      return { requestId, ok: true };
    }
    if (type === 'ready') return Promise.all([...entity.pending]).then(() => ({ requestId, ok: true }));
    if (type === 'tick') {
      if (entity.pending.size) return { requestId, ok: true, pending: true };
      return tick(entity, message);
    }
    return { requestId, ok: false, error: `Unknown entity message: ${type}` };
  }
  return { handle };
}

import { tokenizer } from 'acorn';
import { createAssemblyScriptRuntimeService } from './AssemblyScriptRuntimeService.ts';

type WorkerResponse = { requestId: number; ok: boolean; [key: string]: any };

/** Full type checking happens in the AssemblyScript compiler when the code is saved. */
export function validateEntityScriptSyntax(code: string): string | null {
  if (new TextEncoder().encode(code).length > 64 * 1024) return 'AssemblyScript source exceeds 64 KiB';
  try { Array.from(tokenizer(code, { ecmaVersion: 'latest' })); return null; }
  catch (error: any) { return error.message || String(error); }
}

/** Token-aware literal child-id rewriting also accepts AssemblyScript type annotations. */
export function remapEntityScriptChildIds(code: string, ids: ReadonlyMap<string, string> | Record<string, string>): string {
  const source = String(code || '');
  const lookup = ids instanceof Map ? ids : new Map(Object.entries(ids || {}));
  let tokens: any[];
  try { tokens = Array.from(tokenizer(source, { ecmaVersion: 'latest' })); } catch { return source; }
  const replacements: { start: number; end: number; value: string }[] = [];
  for (let i = 0; i < tokens.length - 4; i++) {
    const [dot, name, open, arg, close] = tokens.slice(i, i + 5);
    if (dot.type.label === '.' && name.value === 'child' && open.type.label === '(' && arg.type.label === 'string' && close.type.label === ')') {
      const value = lookup.get(arg.value);
      if (value && value !== arg.value) replacements.push({ start: arg.start, end: arg.end, value: JSON.stringify(value) });
    }
  }
  let output = source;
  for (const r of replacements.reverse()) output = output.slice(0, r.start) + r.value + output.slice(r.end);
  return output;
}

class EntityScriptMainThreadBroker {
  service = createAssemblyScriptRuntimeService();
  nextRequestId = 1;
  request(message: Record<string, any>): WorkerResponse | Promise<WorkerResponse> {
    return this.service.handle({ ...message, requestId: this.nextRequestId++ });
  }
}

const broker = new EntityScriptMainThreadBroker();
let nextEntityRuntimeId = 1;

/** Host handle for one entity. Source compiles asynchronously; ticks run bounded native WASM. */
export class EntityScriptRuntimeClient {
  readonly runtimeId: string;
  inFlight = false;
  pendingResult: any = null;
  disposed = false;
  initialized = false;
  compiling = new Map<string, number>();
  private nextCompilation = 0;
  onCompileResult: ((result: any) => void) | null = null;

  constructor() {
    this.runtimeId = `entity-runtime-${nextEntityRuntimeId++}`;
  }

  setScript(nodeId: string, code: string) {
    if (this.disposed) return { ok: false, error: 'Runtime disposed' };
    if (!this.initialized && !code.trim()) return { ok: true, nodeId };
    this.initialized = true;
    const revision = ++this.nextCompilation;
    this.compiling.delete(nodeId);
    const response = broker.request({
      type: 'set-script',
      entityRuntimeId: this.runtimeId,
      nodeId,
      code
    });
    if (response instanceof Promise) {
      this.compiling.set(nodeId, revision);
      response.then(result => {
        if (this.compiling.get(nodeId) !== revision) return;
        this.compiling.delete(nodeId);
        if (!this.disposed && !result.stale) this.onCompileResult?.(result);
      }).catch(error => {
        if (this.compiling.get(nodeId) !== revision) return;
        this.compiling.delete(nodeId);
        if (!this.disposed) this.onCompileResult?.({ ok: false, nodeId, error: error.message || String(error) });
      });
      return { ok: true, pending: true };
    }
    return response;
  }

  tick(snapshot: any, hostApi: any = null): { submitted: boolean; result: any | null } {
    if (this.disposed || this.inFlight) return { submitted: false, result: null };
    this.initialized = true;
    const response = broker.request({
      type: 'tick',
      entityRuntimeId: this.runtimeId,
      snapshot,
      hostApi
    });
    if (response instanceof Promise) {
      this.inFlight = true;
      response.then(result => {
        this.pendingResult = result;
        this.inFlight = false;
      }).catch(error => {
        this.pendingResult = { ok: false, fatal: true, error: error.message || String(error) };
        this.inFlight = false;
      });
      return { submitted: true, result: null };
    }
    return response.pending ? { submitted: false, result: null } : { submitted: true, result: response };
  }

  async ready() {
    await broker.request({ type: 'ready', entityRuntimeId: this.runtimeId });
  }

  takePendingResult() {
    const result = this.pendingResult;
    this.pendingResult = null;
    return result;
  }

  reset(states: Record<string, any> = {}) {
    if (this.disposed || !this.initialized) return;
    const response = broker.request({
      type: 'reset',
      entityRuntimeId: this.runtimeId,
      states
    });
    if (response instanceof Promise) response.catch(() => {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.compiling.clear();
    if (!this.initialized) return;
    const response = broker.request({ type: 'dispose', entityRuntimeId: this.runtimeId });
    if (response instanceof Promise) response.catch(() => {});
  }
}

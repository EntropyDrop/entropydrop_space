import { MAX_SCRIPT_SOURCE_BYTES } from './EntityScriptModule.ts';

export type CompilerRequest = { id: number; kind: 'compile'; source: string } | { id: number; kind: 'preload' };
export type CompilerResponse = { id: number; kind: 'compiled'; module: WebAssembly.Module }
  | { id: number; kind: 'ready' } | { id: number; kind: 'error'; error: string };
type CompilerWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
type Pending = {
  kind: CompilerRequest['kind'];
  resolve: (module: WebAssembly.Module | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Owns one disposable worker, bounded requests and failure recovery. */
export class BrowserScriptCompiler {
  private readonly createWorker: () => CompilerWorker;
  private readonly timeoutMs: number;
  private worker: CompilerWorker | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, Pending>();
  private readonly compiling = new Map<string, Promise<WebAssembly.Module>>();
  private preload: Promise<void> | null = null;

  constructor(createWorker: () => CompilerWorker = () => new Worker(
    new URL('./AssemblyScriptCompiler.worker.ts', import.meta.url), { type: 'module' }
  ), timeoutMs = 30_000) {
    this.createWorker = createWorker;
    this.timeoutMs = timeoutMs;
  }

  private stop(error: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.preload = null;
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.waiting.clear();
    this.compiling.clear();
  }

  private request(command: Omit<Extract<CompilerRequest, { kind: 'compile' }>, 'id'>
    | Omit<Extract<CompilerRequest, { kind: 'preload' }>, 'id'>): Promise<WebAssembly.Module | undefined> {
    if (this.waiting.size >= 64) return Promise.reject(new Error('AssemblyScript compilation queue is full'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      try {
        if (!this.worker) {
          const worker = this.createWorker();
          this.worker = worker;
          worker.onmessage = ({ data }: MessageEvent<unknown>) => {
            if (this.worker !== worker) return;
            const reply = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {};
            const pending = typeof reply.id === 'number' ? this.waiting.get(reply.id) : undefined;
            if (!pending) return;
            this.waiting.delete(reply.id as number);
            clearTimeout(pending.timer);
            if (reply.kind === 'error' && typeof reply.error === 'string') pending.reject(new Error(reply.error));
            else if (pending.kind === 'compile' && reply.kind === 'compiled' && reply.module instanceof WebAssembly.Module) pending.resolve(reply.module);
            else if (pending.kind === 'preload' && reply.kind === 'ready') pending.resolve(undefined);
            else pending.reject(new Error('Invalid AssemblyScript compiler response'));
          };
          worker.onerror = worker.onmessageerror = () => {
            if (this.worker === worker) this.stop(new Error('AssemblyScript compiler worker failed'));
          };
        }
        const timer = setTimeout(() => this.stop(new Error('AssemblyScript compilation timed out')), this.timeoutMs);
        this.waiting.set(id, { kind: command.kind, resolve, reject, timer });
        this.worker.postMessage({ id, ...command } satisfies CompilerRequest);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.stop(failure);
        reject(failure);
      }
    });
  }

  compile(source: string): Promise<WebAssembly.Module> {
    const existing = this.compiling.get(source);
    if (existing) return existing;
    if (new TextEncoder().encode(source).length > MAX_SCRIPT_SOURCE_BYTES) {
      return Promise.reject(new Error('AssemblyScript source exceeds 64 KiB'));
    }
    const result = this.request({ kind: 'compile', source }).then(module => {
      if (!module) throw new Error('Missing compiled AssemblyScript module');
      return module;
    });
    this.compiling.set(source, result);
    const cleanup = () => { if (this.compiling.get(source) === result) this.compiling.delete(source); };
    void result.then(cleanup, cleanup);
    return result;
  }

  warmup(): Promise<void> {
    if (!this.preload) {
      const pending = this.request({ kind: 'preload' }).then(() => {});
      this.preload = pending;
      void pending.catch(() => { if (this.preload === pending) this.preload = null; });
    }
    return this.preload;
  }
}

const compiler = new BrowserScriptCompiler();
export const compileScript = (source: string) => compiler.compile(source);
export const preloadCompiler = () => compiler.warmup();

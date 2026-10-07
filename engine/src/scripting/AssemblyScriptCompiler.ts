import { compileScript, preloadCompiler } from '#entity-script-compiler';
import { MAX_SCRIPT_SOURCE_BYTES } from './EntityScriptModule.ts';
export { ENTITY_FUEL, MAX_SCRIPT_SOURCE_BYTES, getEntityScriptMemoryPages } from './EntityScriptModule.ts';

const readyModules = new Map<string, WebAssembly.Module>();
const pendingModules = new Map<string, Promise<WebAssembly.Module>>();
export const getCompiledEntityScript = (source: string) => readyModules.get(source);
export async function preloadAssemblyScriptRuntime(): Promise<void> { await preloadCompiler(); }

/** Coalesce identical source while compiling and retain a bounded module cache. */
export function compileEntityScript(source: string): Promise<WebAssembly.Module> {
  const ready = readyModules.get(source);
  if (ready) {
    readyModules.delete(source);
    readyModules.set(source, ready);
    return Promise.resolve(ready);
  }
  const pending = pendingModules.get(source);
  if (pending) return pending;
  if (new TextEncoder().encode(source).length > MAX_SCRIPT_SOURCE_BYTES) {
    return Promise.reject(new Error('AssemblyScript source exceeds 64 KiB'));
  }
  const result = Promise.resolve().then(() => compileScript(source)).then(module => {
    readyModules.set(source, module);
    if (readyModules.size > 128) readyModules.delete(readyModules.keys().next().value!);
    return module;
  });
  pendingModules.set(source, result);
  const cleanup = () => { if (pendingModules.get(source) === result) pendingModules.delete(source); };
  void result.then(cleanup, cleanup);
  return result;
}

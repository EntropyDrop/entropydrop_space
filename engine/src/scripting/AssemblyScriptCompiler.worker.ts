/// <reference lib="webworker" />
import { compileEntityScriptDirect } from './AssemblyScriptCompiler.ts';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }) => {
  try { scope.postMessage({ id: data.id, module: await compileEntityScriptDirect(data.source) }); }
  catch (error: any) { scope.postMessage({ id: data.id, error: error?.message || String(error) }); }
};

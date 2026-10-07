/// <reference lib="webworker" />
import { compileEntityScriptDirect, preloadAssemblyScriptRuntime } from './AssemblyScriptCompilerDirect.ts';
import type { CompilerRequest, CompilerResponse } from './AssemblyScriptCompiler.browser.ts';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }: MessageEvent<CompilerRequest>) => {
  let response: CompilerResponse;
  try {
    if (data.kind === 'preload') {
      await preloadAssemblyScriptRuntime();
      response = { id: data.id, kind: 'ready' };
    } else {
      response = { id: data.id, kind: 'compiled', module: await compileEntityScriptDirect(data.source) };
    }
  } catch (error) {
    response = { id: data.id, kind: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(response);
};

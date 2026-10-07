// The Node/hosted runtime uses the in-process compiler. Browser builds resolve
// the package import to the worker client instead.
export { compileEntityScriptDirect as compileScript, preloadAssemblyScriptRuntime as preloadCompiler } from './AssemblyScriptCompilerDirect.ts';

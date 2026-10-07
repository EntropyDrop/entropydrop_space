/** The main browser graph must reach the compiler only through its worker. */
export function compilerWorkerBoundary() {
  return {
    name: 'compiler-worker-boundary',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const path = id.replaceAll('\\', '/');
          if (/\/node_modules\/(assemblyscript|binaryen)\//.test(path)
            || /\/AssemblyScriptCompiler(Direct|\.node)\.ts$/.test(path)) {
            this.error(`Compiler implementation leaked into the main browser graph: ${id}`);
          }
        }
      }
    },
  };
}

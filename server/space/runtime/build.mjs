import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the shared engine package so the deployed worker needs no source checkout.
await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['hosting-runtime.ts'],
  outfile: 'dist/hosting-runtime.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Ship the pinned AssemblyScript compiler and Binaryen as production dependencies.
  external: ['assemblyscript/asc', 'binaryen'],
  logLevel: 'info',
});

await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['terrain-surface.ts'],
  outfile: 'dist/terrain-surface.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  logLevel: 'info',
});

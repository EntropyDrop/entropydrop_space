import { registerHooks } from 'node:module';

// The local engine package has its own development dependencies. Use the app's
// Three instance in integration tests, matching Vite's resolve.dedupe setting.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three' || specifier.startsWith('three/')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
});
await import('@entropydrop/space-engine/testing/setup');

export const MAX_SCRIPT_SOURCE_BYTES = 64 * 1024;
export const ENTITY_FUEL = 100_000;
export const MEMORY_PAGES_SECTION = 'entity-memory-pages';
export const INSTANCE_POLICY_SECTION = 'entity-instance-policy';
export const SCRIPT_INITIALIZATION_LIMIT_MS = 100;
export const ENTITY_INITIALIZATION_LIMIT_MS = 250;
export const SCRIPT_EXECUTION_LIMIT_MS = 50;
export const ENTITY_EXECUTION_LIMIT_MS = 250;
export const ENTITY_TICK_LIMIT_MS = 500;
const memoryPages = new WeakMap<WebAssembly.Module, number>();
const instancePolicies = new WeakMap<WebAssembly.Module, { explicitStart: boolean; resettable: boolean }>();

/** Only compiler-certified modules can reuse an instance across invocations. */
export function getEntityScriptInstancePolicy(module: WebAssembly.Module) {
  let policy = instancePolicies.get(module);
  if (policy) return policy;
  const sections = WebAssembly.Module.customSections(module, INSTANCE_POLICY_SECTION);
  const bytes = sections.length === 1 ? new Uint8Array(sections[0]) : new Uint8Array();
  const flags = bytes.length === 2 && bytes[0] === 1 ? bytes[1] : 0;
  policy = { explicitStart: (flags & 1) !== 0, resettable: flags === 3 };
  instancePolicies.set(module, policy);
  return policy;
}

/** The custom section survives the compiler worker's structured clone. */
export function getEntityScriptMemoryPages(module: WebAssembly.Module): number {
  const cached = memoryPages.get(module);
  if (cached !== undefined) return cached;
  const sections = WebAssembly.Module.customSections(module, MEMORY_PAGES_SECTION);
  const pages = sections.length === 1 && sections[0].byteLength === 1
    ? new Uint8Array(sections[0])[0] : 0;
  if (pages < 1 || pages > 64) throw new Error('Invalid entity WASM memory layout');
  memoryPages.set(module, pages);
  return pages;
}


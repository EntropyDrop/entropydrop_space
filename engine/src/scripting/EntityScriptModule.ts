export const MAX_SCRIPT_SOURCE_BYTES = 64 * 1024;
export const ENTITY_FUEL = 100_000;
export const MEMORY_PAGES_SECTION = 'entity-memory-pages';
const memoryPages = new WeakMap<WebAssembly.Module, number>();

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


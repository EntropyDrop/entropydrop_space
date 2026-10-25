/** Retire render objects before Three clears the renderer's node/pipeline maps.
 * r183 otherwise leaves material.dispose listeners pointing at those empty maps
 * when a shared world material outlives an editor preview renderer. */
export function trackRenderObjectLifetime(objects: {
  createRenderObject: (...args: any[]) => { dispose(): void; onDispose: () => void };
}) {
  const live = new Set<ReturnType<typeof objects.createRenderObject>>();
  const create = objects.createRenderObject;
  objects.createRenderObject = function(...args) {
    const object = create.apply(this, args);
    const onDispose = object.onDispose;
    live.add(object);
    object.onDispose = () => {
      live.delete(object);
      onDispose();
    };
    return object;
  };
  return () => {
    for (const object of [...live]) object.dispose();
    live.clear();
  };
}

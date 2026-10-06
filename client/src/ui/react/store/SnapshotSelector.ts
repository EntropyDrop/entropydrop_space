/** Preserve selection identity when an unrelated part of the store changes. */
export function selectSnapshot<S, T>(getSnapshot: () => S, selector: (snapshot: S) => T,
  isEqual: (left: T, right: T) => boolean = Object.is): () => T {
  let initialized = false;
  let previousSnapshot: S;
  let previousSelection: T;
  return () => {
    const snapshot = getSnapshot();
    if (initialized && Object.is(snapshot, previousSnapshot)) return previousSelection;
    const selection = selector(snapshot);
    previousSnapshot = snapshot;
    if (!initialized || !isEqual(previousSelection, selection)) previousSelection = selection;
    initialized = true;
    return previousSelection;
  };
}

export function shallowEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

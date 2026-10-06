import { useMemo, useSyncExternalStore } from 'react';
import { spaceUiStore, type SpaceUiSnapshot } from './SpaceUiStore.ts';
import { selectSnapshot, shallowEqual } from './SnapshotSelector.ts';

/** Subscribe a React component to the immutable simulation/UI snapshot. */
export function useSpaceUi<T>(selector: (snapshot: SpaceUiSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is): T {
  const getSelection = useMemo(() => selectSnapshot(spaceUiStore.getSnapshot, selector, isEqual), [selector, isEqual]);
  return useSyncExternalStore(
    spaceUiStore.subscribe,
    getSelection,
    getSelection
  );
}

export function useSpaceUiFields<K extends keyof SpaceUiSnapshot>(...keys: K[]): Pick<SpaceUiSnapshot, K> {
  return useSpaceUi(snapshot => {
    const selected = {} as Pick<SpaceUiSnapshot, K>;
    for (const key of keys) selected[key] = snapshot[key];
    return selected;
  }, shallowEqual);
}

import { useSyncExternalStore } from 'react';
import { spaceUiStore, type SpaceUiSnapshot } from './SpaceUiStore.ts';

/** Subscribe a React component to the immutable simulation/UI snapshot. */
export function useSpaceUi<T>(selector: (snapshot: SpaceUiSnapshot) => T): T {
  const snapshot = useSyncExternalStore(
    spaceUiStore.subscribe,
    spaceUiStore.getSnapshot,
    spaceUiStore.getSnapshot
  );
  return selector(snapshot);
}

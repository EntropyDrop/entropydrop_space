import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSnapshot, shallowEqual } from '../src/ui/react/store/SnapshotSelector.ts';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

test('selector subscriptions skip HUD-only updates but observe selected values and new selectors', () => {
  let snapshot = { fps: 60, modal: null as string | null, selectedColor: 1 };
  const selected = selectSnapshot(() => snapshot, s => ({ modal: s.modal, color: s.selectedColor }), shallowEqual);
  const first = selected();
  assert.equal(selected(), first);
  snapshot = { ...snapshot, fps: 30 };
  assert.equal(selected(), first);
  snapshot = { ...snapshot, modal: 'inventory' };
  assert.notEqual(selected(), first);
  assert.deepEqual(selected(), { modal: 'inventory', color: 1 });
  const changedSelector = selectSnapshot(() => snapshot, s => s.fps);
  assert.equal(changedSelector(), 30);
});

test('inventory subscriptions see in-place edits without subscribing to telemetry', () => {
  const store = new SpaceUiStore();
  const selected = selectSnapshot(store.getSnapshot, s => ({
    controller: s.controller, revision: s.inventoryRevision,
  }), shallowEqual);
  const first = selected();
  store.setHostingError('unrelated status');
  assert.equal(selected(), first);
  store.refresh();
  assert.notEqual(selected(), first);
});

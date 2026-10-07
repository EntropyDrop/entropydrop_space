import { uiStub } from './fixtures.ts';
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

test('HUD retains unchanged selector and nearby views across telemetry updates', () => {
  const store = new SpaceUiStore();
  const internal = store as any;
  const position = { x: 1, y: 2, z: 3 };
  const entity = { id: 'one', rootComponentId: 'root', position: { ...position }, bodyType: 'dynamic' };
  store.setContraptions(uiStub('contraptions', { contraptions: [entity] }));
  store.updateHUD(60, position, null, null);
  const first = store.getSnapshot();
  internal.lastHudPublishAt = 0;
  store.updateHUD(30, position, null, null);
  const second = store.getSnapshot();
  assert.equal(second.selector, first.selector);
  assert.equal(second.nearbyEntities, first.nearbyEntities);
  assert.equal(second.entityLabels, first.entityLabels);
  entity.position.x++;
  internal.lastHudPublishAt = 0;
  store.updateHUD(30, position, null, null);
  assert.notEqual(store.getSnapshot().nearbyEntities, second.nearbyEntities);
  assert.equal(store.getSnapshot().entityLabels, second.entityLabels, 'moving labels use the frame overlay, not React');
  assert.equal(first.nearbyEntities[0].pos.x, 1, 'published positions remain immutable');
});

test('narrowed views publish aim, entity status, inspector and mutable modeling edits', () => {
  const store = new SpaceUiStore();
  const internal = store as any;
  const entity = { id: 'one', rootComponentId: 'root', rootComponentName: 'Before', scriptStatus: 'stopped',
    getComponentName() { return this.rootComponentName; },
    getNodeProperties() { return { id: 'root', name: this.rootComponentName }; } };
  const value = { id: 'trim', color: 1, position: [1, 2, 3] };
  const modeling = { isDragging: false, canUndo: false, canRedo: false,
    getDisplaySelection: () => ({ contraption: entity, componentId: 'root', decorationId: 'trim', value }) };
  const controller = { hoveredContraption: null as typeof entity | null, modeling, canEditEntityInternals: () => true };
  internal.patch({ controller, contraptions: { contraptions: [entity] }, editingContraption: entity, activeModal: 'code' });
  const before = store.getSnapshot();
  store.setHostingError('unrelated');
  assert.equal(store.getSnapshot().entityLabels, before.entityLabels);
  assert.equal(store.getSnapshot().modelingView, before.modelingView);
  assert.equal(store.getSnapshot().componentProperties, before.componentProperties);
  controller.hoveredContraption = entity;
  entity.rootComponentName = 'After';
  entity.scriptStatus = 'running';
  value.position[0] = 7;
  modeling.canUndo = true;
  store.refresh();
  const after = store.getSnapshot();
  assert.equal(after.wrenchTarget, entity);
  assert.equal(after.entityLabels[0].name, 'After');
  assert.equal(after.entityLabels[0].status.running, true);
  assert.equal(after.componentProperties?.name, 'After');
  assert.equal(after.modelingView.selection?.value.position?.[0], 7);
  assert.equal(after.modelingView.canUndo, true);
  assert.equal(before.entityLabels[0].name, 'Before');
  assert.equal(before.modelingView.selection?.value.position?.[0], 1);
});

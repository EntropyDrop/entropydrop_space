import { worldStub } from './fixtures.ts';
import { requireValue } from './fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { normalizeDecorations } from '../src/contraption/Decorations.ts';
import { encodeInventoryResource, decodeInventoryResource, runtimeEntityToPortable, portableEntityToRuntime } from '../src/storage/InventoryProtobuf.ts';
import { bendPointForView } from '../src/torus/TorusWorld.ts';

const block = (x: number, entityId = 'base') => ({ localX: x, localY: 0, localZ: 0, size: 1, color: 0x123456, block: 1, entityId });
const decoration = { id: 'trim', position: [4, 1, 0] as [number, number, number], scale: [2, 0.1, 1] as [number, number, number], color: 0xff0000 };

test('decoration defaults, quaternion signs and sorting have one canonical wire representation', () => {
  const source: any = { rootComponentId: 'base', blocks: [{ dx: 0, dy: 0, dz: 0, color: 1, entityId: 'base' }], decorations: [
    { id: 'z', color: 0, position: [-0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0, -1] },
    { ...decoration, rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)] },
  ] };
  const portable = runtimeEntityToPortable(source);
  const encoded = encodeInventoryResource('entity', portable);
  const decoded = decodeInventoryResource(encoded, 'entity').portable;
  assert.deepEqual(requireValue(decoded.root.decorations).map(value => value.id), ['trim', 'z']);
  assert.deepEqual(requireValue(decoded.root.decorations)[1], { id: 'z', color: 0 });
  assert.deepEqual(encodeInventoryResource('entity', decoded), encoded);
  source.decorations[1].rotation = source.decorations[1].rotation.map((value: number) => -value);
  assert.deepEqual(encodeInventoryResource('entity', runtimeEntityToPortable(source)), encoded);
  assert.deepEqual(portableEntityToRuntime(decoded).decorations, decoded.root.decorations);
  const legacy = runtimeEntityToPortable({ rootComponentId: 'base', blocks: [{ dx: 0, dy: 0, dz: 0, color: 1, entityId: 'base' }] });
  assert.deepEqual(encodeInventoryResource('entity', legacy), encodeInventoryResource('entity', { ...legacy, root: { ...legacy.root, decorations: [] } }));
});

test('decorations reject malformed transforms and duplicate component-local identities', () => {
  for (const patch of [{ scale: [0, 1, 1] }, { scale: [-1, 1, 1] }, { position: [Infinity, 0, 0] },
    { rotation: [0, 0, 0, 0] }, { materialId: 2 }, { color: 0x1000000 }, { id: '' }]) {
    assert.throws(() => normalizeDecorations([{ ...decoration, ...patch }]));
  }
  assert.throws(() => normalizeDecorations([decoration, decoration]), /unique/);
});

test('visual edits preserve every physical body and collision index, while picking works outside voxel bounds', () => {
  const entity = new Contraption(1, [block(0)], new THREE.Vector3(), new THREE.Scene(), { rootComponentId: 'base' });
  try {
    const body = entity.getRigidBody('base');
    const collision = entity.collisionCells;
    const physical = [entity.mass, entity.boundingRadius, entity.voxelVolume, requireValue(body).mass, requireValue(body).inverseInertia, entity.collisionPoseVersion];
    assert.equal(entity.setComponentDecorations('base', [decoration]), true);
    assert.equal(entity.getRigidBody('base'), body);
    assert.equal(entity.collisionCells, collision);
    assert.deepEqual([entity.mass, entity.boundingRadius, entity.voxelVolume, requireValue(body).mass, requireValue(body).inverseInertia, entity.collisionPoseVersion], physical);
    const origin = new THREE.Vector3(4, 1, 4), direction = new THREE.Vector3(0, 0, -1);
    assert.equal(entity.raycastCollisionCells(origin, direction, 8), null);
    assert.equal(entity.raycastDecorations(origin, direction, 8, false)?.decorationId, 'trim');
    const start = bendPointForView(4, 1, 4), end = bendPointForView(4, 1, 0);
    assert.equal(entity.raycastDecorations(start, end.sub(start).normalize(), 8, true)?.decorationId, 'trim');
    assert.ok(entity.getVisualWorldBounds().max.x >= 5);
    assert.equal(entity.maxLocal.x, 1);
    entity.setComponentDecorations('base', []);
    assert.equal(entity.raycastDecorations(origin, direction, 8, false), null);
  } finally { entity.dispose(); }
});

test('child decorations follow their owning frame and survive hierarchy rebuilds and serialization', () => {
  const entity = new Contraption(2, [block(0), block(2, 'arm')], new THREE.Vector3(), new THREE.Scene(), {
    rootComponentId: 'base', childEntities: [{ id: 'arm', parentId: 'base', pivot: [2.5, 0.5, 0.5], decorations: [decoration] }],
  });
  try {
    const node = entity.getEntityNode('arm');
    requireValue(node).group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const expected = entity.entityLocalToWorld('arm', new THREE.Vector3().fromArray(decoration.position));
    const mesh = entity.decorationGroups.get('arm')!.children[0];
    assert.ok(mesh.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-9);
    entity.rebuildEntityHierarchy();
    assert.deepEqual(entity.getComponentDecorations('arm'), [decoration]);
    const slot = entity.serializeSubtree('arm');
    assert.deepEqual(requireValue(slot).decorations, [decoration]);
    assert.deepEqual(portableEntityToRuntime(runtimeEntityToPortable(entity.serializeSubtree('base'))).childEntities[0].decorations, [decoration]);
  } finally { entity.dispose(); }
});

test('component installation rebases decoration positions together with voxels and pivots', () => {
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, worldStub(), null, null);
  const source: any = { rootComponentId: 'source', blocks: [block(0, 'source'), block(2, 'arm')], decorations: [decoration],
    childEntities: [{ id: 'arm', parentId: 'source', pivot: [2.5, 0.5, 0.5], decorations: [decoration] }] };
  const target = manager.buildFromSlot({ rootComponentId: 'base', blocks: [block(0)] }, new THREE.Vector3(), null, false);
  requireValue(target).stopAllNodeScripts();
  requireValue(target).setPhysicsSimulationEnabled(false);
  try {
    const result = requireValue(target).installEntitySlot(source, 'base', new THREE.Vector3(8, 2, 0), null, new THREE.Quaternion());
    assert.equal(result.ok, true, JSON.stringify(result));
    const root = [...requireValue(target).childDefinitions.values()].find(value => value.parentId === 'base');
    assert.ok(root);
    const expected = new THREE.Vector3(12, 3, 0);
    const actual = requireValue(target).entityLocalToWorld(root.id, new THREE.Vector3().fromArray(requireValue(requireValue(root.decorations)[0].position)));
    assert.ok(actual.distanceTo(expected) < 1e-9, `${actual.toArray()} vs ${expected.toArray()}`);
    const installedArm = [...requireValue(target).childDefinitions.values()].find(value => value.parentId === root.id);
    assert.deepEqual(requireValue(installedArm).decorations, root.decorations);
    assert.equal(requireValue(target).getDecorationCount(), 2);
  } finally { requireValue(target).dispose(); }
});

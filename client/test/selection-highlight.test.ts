import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { TORUS_SIZE_X } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { collectSelectionVolumeBoxes } from '../src/engine/render/SelectionVolume.ts';
import { computeSelectionCells, type SelectorShape } from '../src/engine/controls/SelectorShapes.ts';

function fixture() {
  const scene = new THREE.Scene();
  const world = new World(scene, 42, undefined, 9);
  const renderer = Object.create(SceneRenderer.prototype) as SceneRenderer;
  renderer.scene = scene;
  renderer.world = world;
  renderer.setupSelectionHologram();
  return { world, renderer };
}

function resizeFixture(micro: boolean) {
  const { world, renderer } = fixture();
  renderer.setupSelectionAxisGizmo();
  const manager = new ContraptionManager(renderer.scene, world, null, null);
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    activeTool: SpecialTool.SELECTOR, selectorMicroMode: micro, world, contraptions: manager,
    sceneRenderer: renderer, camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
    isLocked: true, sound: { playWrenchClick() {} }, ui: { updateToolPanelMode() {} },
  });
  controller.camera.position.set(20, 40, 30);
  controller.camera.lookAt(10, 30, 10);
  controller.camera.updateMatrixWorld();
  const drag = (axis: 'x' | 'y' | 'z', direction: 1 | -1, steps: number) => {
    const center = renderer.selectionGroup.position.clone();
    const unit = new THREE.Vector3();
    unit[axis] = 1;
    const a = center.clone().project(controller.camera), b = center.add(unit).project(controller.camera);
    const delta = new THREE.Vector2(b.x - a.x, a.y - b.y).normalize().multiplyScalar(direction * steps * (micro ? 8 : 16) * 1.001);
    controller.startGizmoDrag({ handleKey: `${direction > 0 ? '+' : '-'}${axis}`, axis, direction });
    controller.updateGizmoDrag({ movementX: delta.x, movementY: delta.y });
    controller.releaseGizmoDrag();
  };
  return { world, renderer, manager, controller, drag };
}

for (const micro of [false, true]) {
  for (const shape of ['box', 'cylinder', 'sphere', 'stairs', 'line'] as const) {
    test(`${micro ? 'micro' : 'standard'} ${shape} resizing in air keeps highlight, bounds and shape anchor synchronized`, () => {
      const { renderer, manager, controller, drag } = resizeFixture(micro);
      const scale = micro ? 8 : 1;
      const a = { x: 10 * scale, y: 30 * scale, z: 10 * scale };
      const b = { x: a.x + 2, y: a.y + 2, z: a.z + 2 };
      manager.setCornerA({ x: a.x / scale, y: a.y / scale, z: a.z / scale }, { micro });
      manager.setCornerB({ x: b.x / scale, y: b.y / scale, z: b.z / scale }, { micro });
      controller.selectionShapeAnchor = { cornerA: a, cornerB: b, micro };
      controller.setSelectorShape(shape);
      for (const [axis, direction, steps] of [['x', 1, 2], ['x', 1, -1], ['z', -1, 1]] as const) {
        const oldGeometry = renderer.selectionHighlight.geometry;
        const oldBounds = micro ? manager.getMicroSelectionBounds()! : manager.getSelectionBounds()!;
        const expectedBounds = { ...oldBounds };
        const key = `${direction > 0 ? 'max' : 'min'}${axis.toUpperCase()}` as keyof typeof expectedBounds;
        expectedBounds[key] += direction * steps;
        drag(axis, direction, steps);
        const anchor = controller.selectionShapeAnchor;
        assert.deepEqual(anchor.cornerA, { x: expectedBounds.minX, y: expectedBounds.minY, z: expectedBounds.minZ });
        assert.deepEqual(anchor.cornerB, { x: expectedBounds.maxX, y: expectedBounds.maxY, z: expectedBounds.maxZ });
        assert.notEqual(renderer.selectionHighlight.geometry, oldGeometry, 'drag rebuilds the selected volume');
        assert.equal(renderer.selectionHighlight.visible, true, 'air receives the shape highlight too');
        const afterDrag = renderer.selectionHighlight.geometry.attributes.position.array.slice();
        controller.setSelectorShape(shape);
        assert.deepEqual(renderer.selectionHighlight.geometry.attributes.position.array, afterDrag, 'reapplying the shape must not jump to the old region');
        assert.deepEqual(controller.selectionShapeAnchor.cornerB, anchor.cornerB);
      }
    });
  }

  test(`${micro ? 'micro' : 'standard'} entity resize updates the volume and subsequent shape changes`, () => {
    const { renderer, manager, controller } = resizeFixture(micro);
    const entity = new Contraption(1, [0, 1, 2].map(x => ({ localX: x, localY: 0, localZ: 0, block: 1 })), new THREE.Vector3(), renderer.scene);
    try {
      const nodeId = entity.rootComponentId;
      controller.selectedBlockSelection = {
        contraption: entity, nodeId, blocks: entity.blocks,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 0 },
      };
      controller.setSelectorShape('box');
      controller.expandEntitySelectionAxis('x', 1, 1, micro);
      const selected = controller.selectedBlockSelection;
      assert.equal(selected.blocks.length, 3);
      assert.equal(manager.entitySelection?.kind, 'entity-blocks');
      assert.equal((manager.entitySelection as any).blocks, selected.blocks, 'shared actions target the resized blocks');
      assert.equal(controller.selectionShapeAnchor.cornerB.x, 2);
      const surface = renderer.selectionHighlight;
      assert.equal(surface.visible, true);
      assert.equal(entity.subtreeHighlightBoxes[0].group.getObjectByName('SelectedEntityVoxels'), undefined, 'the volume replaces the occupied-only tint');
      const geometry = surface.geometry.attributes.position.array.slice();
      controller.setSelectorShape('box');
      assert.deepEqual(surface.geometry.attributes.position.array, geometry, 'shape refresh retains the resized orange surface');
      controller.expandEntitySelectionAxis('x', 1, -1, micro);
      assert.equal(controller.selectedBlockSelection.blocks.length, 2);
      assert.equal(controller.selectionShapeAnchor.cornerB.x, 1);
    } finally { entity.dispose(); }
  });
}

test('resizing a box replaces a previous sparse cell mask with the new region', () => {
  const { world, renderer, manager, controller, drag } = resizeFixture(false);
  for (let x = 10; x <= 13; x++) world.setBlock(x, 30, 10, 1, false);
  manager.setCornerA({ x: 10, y: 30, z: 10 });
  manager.setCornerB({ x: 11, y: 30, z: 10 });
  controller.setSelectorShape('box');
  manager.connectedSelection = [{ x: 10, y: 30, z: 10 }, { x: 11, y: 30, z: 10 }];
  drag('x', 1, 2);
  assert.equal(manager.getSelectionBounds()!.maxX, 13);
  renderer.selectionHighlight.geometry.computeBoundingBox();
  assert.equal(renderer.selectionHighlight.geometry.boundingBox!.max.x, 4, 'the tint follows the resized volume');
});

test('dragging the negative Z arrow into air expands the orange volume while selected blocks stay unchanged', () => {
  const { world, renderer, manager, controller, drag } = resizeFixture(false);
  for (let x = 10; x <= 11; x++) for (let y = 30; y <= 32; y++) for (let z = 10; z <= 11; z++) world.setBlock(x, y, z, 1, false);
  manager.setCornerA({ x: 10, y: 30, z: 10 });
  manager.setCornerB({ x: 11, y: 32, z: 11 });
  controller.setSelectorShape('box');
  const oldGeometry = renderer.selectionHighlight.geometry;
  drag('z', -1, 2);
  assert.equal(manager.getSelectionBounds()!.minZ, 8);
  assert.equal(world.getStandardCollisionBoxesInAABB({ minX: 10, minY: 30, minZ: 8, maxX: 12, maxY: 33, maxZ: 12 }).length, 12);
  assert.notEqual(renderer.selectionHighlight.geometry, oldGeometry);
  renderer.selectionHighlight.geometry.computeBoundingBox();
  assert.equal(renderer.selectionHighlight.position.z + renderer.selectionHighlight.geometry.boundingBox!.min.z, 8, 'orange reaches the new air boundary');
  assert.ok(renderer.selectionHighlight.geometry.getIndex(), 'face vertices are shared while following terrain curvature');
});

for (const micro of [false, true]) for (const shape of ['box', 'cylinder', 'sphere', 'stairs', 'line'] as SelectorShape[]) {
  test(`${micro ? 'micro' : 'standard'} ${shape} highlights its full shape including empty cells`, () => {
    const a = { x: 10, y: 30, z: 10 }, b = { x: 14, y: 34, z: 14 };
    const bounds = { minX: a.x, minY: a.y, minZ: a.z, maxX: b.x, maxY: b.y, maxZ: b.z };
    const cells = computeSelectionCells(shape, a, b, micro);
    const original = JSON.stringify(cells);
    const boxes = collectSelectionVolumeBoxes(bounds, shape === 'box' ? null : cells, micro);
    const scale = micro ? 0.125 : 1;
    if (shape === 'box') {
      assert.deepEqual(boxes, [{ minX: 10 * scale, minY: 30 * scale, minZ: 10 * scale, maxX: 15 * scale, maxY: 35 * scale, maxZ: 15 * scale }]);
    } else {
      assert.equal(boxes.length, cells.length);
      assert.deepEqual(boxes.map(box => ({ x: box.minX / scale, y: box.minY / scale, z: box.minZ / scale })), cells.map(({ x, y, z }) => ({ x, y, z })));
    }
    assert.equal(JSON.stringify(cells), original, 'drawing must preserve the cells used by selection actions');
  });
}

test('micro cylinder includes empty interior cells and excludes corner cells outside its shape', () => {
  const { world, renderer } = fixture();
  const a = { x: 80, y: 240, z: 80 }, b = { x: 103, y: 255, z: 103 };
  const bounds = { minX: a.x, minY: a.y, minZ: a.z, maxX: b.x, maxY: b.y, maxZ: b.z };
  const cells = computeSelectionCells('cylinder', a, b, true);
  world.setMicroBlock(a.x, a.y, a.z, 0xffffff);
  const boxes = collectSelectionVolumeBoxes(bounds, cells, true);
  assert.equal(boxes.length, cells.length);
  assert.ok(boxes.some(box => box.minX === 91 / 8 && box.minY === 245 / 8 && box.minZ === 91 / 8));
  assert.ok(!boxes.some(box => box.minX === a.x / 8 && box.minY === a.y / 8 && box.minZ === a.z / 8));
  renderer.updateSelectionHologram(bounds, null, cells, true);
  assert.equal(renderer.selectionHighlight.material.color.getHex(), 0xff9500);
  assert.equal(renderer.selectionHighlight.visible, true);
  const geometry = renderer.selectionHighlight.geometry;
  renderer.updateSelectionHologram({ ...bounds }, null, cells, true);
  assert.equal(renderer.selectionHighlight.geometry, geometry, 'steady frames reuse the same mesh');
  world.setMicroBlock(91, 245, 91, 0xffffff);
  renderer.updateSelectionHologram(bounds, null, cells, true);
  assert.equal(renderer.selectionHighlight.geometry, geometry, 'terrain occupancy no longer changes the selected volume');
});

test('micro box highlights its complete volume even with an empty materialized cell list', () => {
  const { renderer } = fixture();
  const bounds = { minX: 80, minY: 240, minZ: 80, maxX: 89, maxY: 243, maxZ: 83 };
  renderer.updateSelectionHologram(null, null, [], false, null, bounds);
  assert.deepEqual(renderer.selectionGroup.scale.toArray(), [1.25, 0.5, 0.5]);
  assert.equal(renderer.selectionHighlight.visible, true);
  assert.deepEqual(collectSelectionVolumeBoxes(bounds, null, true), [{ minX: 10, minY: 30, minZ: 10, maxX: 11.25, maxY: 30.5, maxZ: 10.5 }]);
  renderer.selectionHighlight.geometry.computeBoundingBox();
  assert.equal(renderer.selectionHighlight.geometry.boundingBox!.max.x, 1.25);
  renderer.updateSelectionHologram(null);
  assert.equal(renderer.selectionGroup.visible, false);
  assert.equal(renderer.selectionHighlight.visible, false);
});

test('selection volume remains continuous across the torus seam', () => {
  const boxes = collectSelectionVolumeBoxes({ minX: TORUS_SIZE_X - 1, maxX: TORUS_SIZE_X, minY: 30, maxY: 30, minZ: 10, maxZ: 10 }, null, false);
  assert.deepEqual(boxes, [{ minX: TORUS_SIZE_X - 1, maxX: TORUS_SIZE_X + 1, minY: 30, maxY: 31, minZ: 10, maxZ: 11 }]);
});

test('entity volume follows its component frame and keeps the same geometry while moving', () => {
  const { renderer } = fixture();
  const object = new THREE.Group();
  object.position.set(10, 20, 30);
  object.rotation.y = Math.PI / 2;
  const pivot = new THREE.Vector3(2, 3, 4);
  const bounds = { minX: 2, minY: 3, minZ: 4, maxX: 4, maxY: 5, maxZ: 6 };
  renderer.updateSelectionHologram(bounds, null, null, false, { object, pivot });
  assert.equal(renderer.selectionHighlight.visible, true, 'empty entity space is highlighted');
  assert.deepEqual(renderer.selectionHighlight.position.toArray(), [10, 20, 30]);
  assert.ok(renderer.selectionHighlight.quaternion.equals(object.quaternion));
  const geometry = renderer.selectionHighlight.geometry;
  object.position.x = 15;
  renderer.updateSelectionHologram(bounds, null, null, false, { object, pivot });
  assert.equal(renderer.selectionHighlight.geometry, geometry);
  assert.deepEqual(renderer.selectionHighlight.position.toArray(), [15, 20, 30]);
  renderer.updateSelectionHologram(bounds);
  assert.deepEqual(renderer.selectionHighlight.position.toArray(), [2, 3, 4]);
  assert.ok(renderer.selectionHighlight.quaternion.equals(new THREE.Quaternion()));
});

test('entity highlights preserve holes, follow their node and dispose the orange surface', () => {
  const entity = new Contraption(1, [0, 2].map(x => ({ localX: x, localY: 0, localZ: 0, block: 1 })), new THREE.Vector3(), new THREE.Scene());
  try {
    entity.highlightBlocks(entity.blocks);
    const entry = entity.subtreeHighlightBoxes[0];
    const surface = entry.group.getObjectByName('SelectedEntityVoxels');
    entry.group.updateWorldMatrix(true, true);
    const at = (x: number) => {
      const origin = surface.localToWorld(new THREE.Vector3(x - 1.5, 0, 3));
      return new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -1)).intersectObject(surface).length;
    };
    assert.ok(at(0.5) > 0);
    assert.equal(at(1.5), 0, 'the empty gap in a selected component has no orange surface');
    assert.ok(at(2.5) > 0);
    let disposed = false;
    surface.geometry.addEventListener('dispose', () => { disposed = true; });
    entity.clearSubtreeHighlight();
    assert.equal(disposed, true);
  } finally { entity.dispose(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import {
  getWorldShapeMode,
  setWorldShapeMode,
  TORUS_SPAWN_X,
  TORUS_SPAWN_Z,
} from '@entropydrop/space-engine/torus/TorusWorld.ts';

/**
 * Direct spoon carving subdivides a standard block into 8x8x8 and immediately removes
 * the microcell under the crosshair, without a separate conversion step.
 */

function makeSpoonController(overrides = {}) {
  const controller = Object.create(PlayerController.prototype);
  const breakSounds = [];
  controller.activeTool = SpecialTool.SPOON;
  controller.hoveredContraptionHit = null;
  controller.currentRaycast = { hit: false };
  controller.selectedColor = 0xff0000;
  controller.particles = { emitBlockBreak() {} };
  controller.sound = { playBlockBreak(options) { breakSounds.push(options); } };
  controller.ui = { showToast() {}, notifyContraptionStructureChanged() {} };
  Object.assign(controller, overrides);
  controller.__breakSounds = breakSounds;
  return controller;
}

test('world: clicking a standard block subdivides it and removes the hit microcell', () => {
  let subdivided = 0;
  let removed = null;
  const controller = makeSpoonController({
    currentRaycast: {
      hit: true,
      kind: 'standard',
      hitPos: { x: 2, y: 2, z: 2 },
      distance: 5,
      normal: { x: 0, y: 0, z: -1 },
      color: 0xffffff,
      // Torus raycasts provide the hit-face entry point directly.
      entry: { x: 2.4, y: 2.3, z: 2.1 }
    },
    physics: {
      // The ray enters cell (2,2,2) from +Z at (2.4,2.3,2.1).
      getEyePosition: () => new THREE.Vector3(2.4, 2.3, 7.1)
    },
    camera: { quaternion: new THREE.Quaternion() },
    world: {
      subdivideBlock: (wx, wy, wz) => {
        subdivided++;
        assert.deepEqual([wx, wy, wz], [2, 2, 2]);
        return 512;
      },
      removeMicroBlock: (mx, my, mz) => {
        removed = { mx, my, mz };
        return true;
      }
    }
  });
  controller.handleLeftClick();
  assert.equal(subdivided, 1, 'the whole standard cell should subdivide');
  assert.ok(removed, 'one microcell should be removed immediately');
  // Entry (2.4,2.3,2.1) maps to microcell (19,18,16), inside [16..23].
  assert.deepEqual(removed, { mx: 19, my: 18, mz: 16 });
  assert.deepEqual(controller.__breakSounds, [{ kind: 'micro', count: 1 }]);
});

test('world: a boundary entry point clamps the removed microcell inside the hit cell', () => {
  let removed = null;
  const controller = makeSpoonController({
    currentRaycast: {
      hit: true,
      kind: 'standard',
      hitPos: { x: 0, y: 0, z: 0 },
      distance: 1,
      normal: { x: 0, y: 0, z: -1 },
      color: 0xffffff,
      entry: { x: 0.1, y: 0.1, z: 0.01 }
    },
    physics: {
      // Entry lies extremely close to the z=0 boundary, exercising floating-point error.
      getEyePosition: () => new THREE.Vector3(0.1, 0.1, 1.01)
    },
    camera: { quaternion: new THREE.Quaternion() },
    world: {
      subdivideBlock: () => 512,
      removeMicroBlock: (mx, my, mz) => { removed = { mx, my, mz }; return true; }
    }
  });
  controller.handleLeftClick();
  assert.ok(removed);
  assert.ok(removed.mx >= 0 && removed.mx <= 4, 'mx must stay inside [0..4]');
  assert.ok(removed.my >= 0 && removed.my <= 4);
  assert.ok(removed.mz >= 0 && removed.mz <= 4);
});

test('world: three rapid spoon clicks consume three micro layers before remesh publication', () => {
  const previousMode = getWorldShapeMode();
  setWorldShapeMode('torus');
  try {
    const world = new World(new THREE.Scene()) as any;
    const mx = TORUS_SPAWN_X * 8;
    const mz = TORUS_SPAWN_Z * 8;
    const ys = [160, 161, 162];
    for (const my of ys) world.setMicroBlock(mx, my, mz, 0x123456);
    world.microVoxels.updateMesh();

    const camera = new THREE.PerspectiveCamera();
    camera.rotation.set(-Math.PI / 2, 0, 0);
    camera.updateMatrixWorld(true);
    const eye = new THREE.Vector3(mx / 8 + 0.0625, 25, mz / 8 + 0.0625);
    const controller = makeSpoonController({
      camera,
      physics: { getEyePosition: () => eye },
      world,
      contraptions: null,
      sceneRenderer: { setCursor() {}, setMicroCarvePreview() {} },
      perspective: 'first_person',
      pitch: -Math.PI / 2,
      yaw: 0,
      hoveredContraption: null,
    }) as any;
    controller.syncDrivenVehiclePose = () => {};
    controller.updateCameraPosition = () => {};
    controller.updateWrenchPivotGizmo = () => {};
    controller.updateMicroCarvePreview = () => {};
    controller.updateInventoryPlacementPreview = () => {};

    for (let click = 0; click < 3; click++) {
      controller.updateAimRaycast();
      controller.handleLeftClick();
      controller.refreshAimAfterPointerAction();
      // Preserve the stale published mesh just as an exhausted frame budget
      // does while the user clicks faster than the partition can rebuild.
      world.microVoxels.updateMesh(1, null, null, 0);
    }

    assert.deepEqual(
      ys.map(my => world.getMicroBlock(mx, my, mz)),
      [null, null, null],
    );
    assert.equal(controller.currentRaycast.microPos.y, 162,
      'hover remains tied to the old published mesh until its replacement is ready');
    assert.deepEqual(controller.__breakSounds, [
      { kind: 'micro', count: 1 },
      { kind: 'micro', count: 1 },
      { kind: 'micro', count: 1 },
    ]);
  } finally {
    setWorldShapeMode(previousMode);
  }
});

test('world: rapid spoon clicks continue while standard-to-micro publication is pending', () => {
  const previousMode = getWorldShapeMode();
  setWorldShapeMode('torus');
  try {
    const world = new World(new THREE.Scene()) as any;
    const wx = TORUS_SPAWN_X;
    const wy = 200;
    const wz = TORUS_SPAWN_Z;
    world.setRenderDistance(3);
    world.updateChunksAround(wx, wz);
    world.setBlock(wx, wy, wz, BlockTypes.COLOR_BLOCK, true, 0x123456);
    world.updateChunksAround(wx, wz);

    const camera = new THREE.PerspectiveCamera();
    camera.rotation.set(-Math.PI / 2, 0, 0);
    camera.updateMatrixWorld(true);
    const eye = new THREE.Vector3(wx + 0.1, wy + 5, wz + 0.1);
    const controller = makeSpoonController({
      camera,
      physics: { getEyePosition: () => eye },
      world,
      contraptions: null,
      sceneRenderer: { setCursor() {}, setMicroCarvePreview() {} },
      perspective: 'first_person',
      pitch: -Math.PI / 2,
      yaw: 0,
      hoveredContraption: null,
    }) as any;
    controller.syncDrivenVehiclePose = () => {};
    controller.updateCameraPosition = () => {};
    controller.updateWrenchPivotGizmo = () => {};
    controller.updateMicroCarvePreview = () => {};
    controller.updateInventoryPlacementPreview = () => {};

    for (let click = 0; click < 3; click++) {
      controller.updateAimRaycast();
      controller.handleLeftClick();
      controller.refreshAimAfterPointerAction();
      world.microVoxels.updateMesh(1, null, null, 0, world.crossLayerPublicationChunks);
    }

    assert.equal(world.getBlock(wx, wy, wz), BlockTypes.AIR);
    assert.equal(world.microVoxels.cells.size, 509,
      'the subdivision plus two immediate follow-up clicks should consume three microcells');
    assert.equal(controller.currentRaycast.kind, 'standard',
      'hover remains on the visible standard mesh until the atomic replacement publishes');
  } finally {
    setWorldShapeMode(previousMode);
  }
});

test('world: a live retry cannot carve terrain hidden behind an entity', () => {
  const removeCalls = [];
  const controller = makeSpoonController({
    currentRaycast: {
      hit: true,
      kind: 'micro',
      microPos: { x: 10, y: 12, z: 10 },
      hitPos: { x: 2, y: 2.4, z: 2 },
      color: 0x123456,
    },
    world: {
      removeMicroBlock(mx, my, mz) {
        removeCalls.push([mx, my, mz]);
        return false;
      },
    },
  });
  controller.performAimRaycast = () => ({
    kind: 'entity',
    entityHit: { distance: 2 },
    worldHit: {
      hit: true,
      kind: 'micro',
      microPos: { x: 10, y: 11, z: 10 },
      hitPos: { x: 2, y: 2.2, z: 2 },
      color: 0x654321,
      distance: 3,
    },
  });

  controller.handleLeftClick();

  assert.deepEqual(removeCalls, [[10, 12, 10]],
    'the failed published target is not retried through the nearer entity');
  assert.deepEqual(controller.__breakSounds, [], 'a failed carve must stay silent');
});

test('entity: clicking a standard block subdivides 512 cells and removes one', () => {
  const blocks = [
    { localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0xffffff, entityId: 'root' }
  ];
  const contraption = { blocks, rebuildAfterBlockChange() {} };
  let rebuilt = 0;
  contraption.rebuildAfterBlockChange = () => { rebuilt++; };

  const controller = makeSpoonController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      cell: { x: 0, y: 0, z: 0 },
      kind: 'standard',
      point: new THREE.Vector3(1.0, 0.125, 0.125),
      // +X hit: adjacent microcell x=1.0 maps back to hit microcell x=0.875 (ix=7).
      placeMicroPos: { localX: 1.0, localY: 0.125, localZ: 0.125 },
      normal: { x: 1, y: 0, z: 0 },
      color: 0xffffff
    }
  });
  controller.handleLeftClick();

  assert.equal(rebuilt, 1, 'the operation should rebuild once');
  assert.equal(contraption.blocks.length, 511, 'subdivide 512 cells and remove one');
  const carvedAway = contraption.blocks.some(b =>
    (b.size || 1) < 1 &&
    Math.abs(b.localX - 0.875) < 1e-3 &&
    Math.abs(b.localY - 0.125) < 1e-3 &&
    Math.abs(b.localZ - 0.125) < 1e-3
  );
  assert.equal(carvedAway, false, 'hit microcell (0.875,0.125,0.125) must be removed');
  const kept = contraption.blocks.filter(b => (b.size || 1) < 1 && Math.abs(b.localX - 0.0) < 1e-3);
  assert.equal(kept.length, 64, 'the other 64 microcells in the ix=0 plane should remain');
  assert.deepEqual(controller.__breakSounds, [{ kind: 'micro', count: 1 }]);
});

test('entity: a -X hit removes the opposite boundary microcell', () => {
  const blocks = [
    { localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK, color: 0xffffff, entityId: 'root' }
  ];
  const contraption = { blocks, rebuildAfterBlockChange() {} };
  const controller = makeSpoonController({
    hoveredContraptionHit: {
      contraption,
      entityId: 'root',
      cell: { x: 0, y: 0, z: 0 },
      kind: 'standard',
      point: new THREE.Vector3(0, 0.125, 0.125),
      // -X hit: adjacent x=-0.125 maps to hit microcell x=0 (ix=0).
      placeMicroPos: { localX: -0.125, localY: 0.125, localZ: 0.125 },
      normal: { x: -1, y: 0, z: 0 },
      color: 0xffffff
    }
  });
  controller.handleLeftClick();
  assert.equal(contraption.blocks.length, 511);
  const carvedAway = contraption.blocks.some(b =>
    (b.size || 1) < 1 &&
    Math.abs(b.localX - 0.0) < 1e-3 &&
    Math.abs(b.localY - 0.125) < 1e-3 &&
    Math.abs(b.localZ - 0.125) < 1e-3
  );
  assert.equal(carvedAway, false, 'hit microcell (0,0.125,0.125) must be removed');
});

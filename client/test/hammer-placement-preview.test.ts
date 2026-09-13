import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { ContraptionManager } from '@entropydrop/space-engine/contraption/ContraptionManager.ts';
import { SceneRenderer, getInventoryPreviewBlocks, buildUnifiedInventoryPreviewMesh } from '../src/engine/render/SceneRenderer.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';

function makeController(slot) {
  const controller = Object.create(PlayerController.prototype);
  controller.activeTool = SpecialTool.HAMMER;
  controller.inventorySlots = [slot];
  controller.selectedInventoryIndex = 0;
  controller.currentRaycast = { hit: false };
  controller.hoveredContraptionHit = null;
  controller.physics = { getEyePosition: () => new THREE.Vector3(1, 2, 3) };
  controller.camera = { quaternion: new THREE.Quaternion() };
  controller.inventoryPlacementPreview = null;
  return controller;
}

function flatTerrain(topFor: (x: number, z: number) => number = (_x, _z) => 0) {
  return {
    raycast(origin, _direction, maxDistance) {
      const top = topFor(origin.x, origin.z);
      const distance = origin.y - top;
      return distance >= 0 && distance <= maxDistance
        ? { hit: true, distance }
        : { hit: false };
    },
    raycastMicro() {
      return { hit: false };
    }
  };
}

test('Hammer hover preview uses the same snapped pose as block-set placement', () => {
  const slot = {
    kind: 'blockset',
    blockCount: 1,
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 0x48dbfb }]
  };
  const controller = makeController(slot);
  // Entity hit wins over terrain behind it, just like left-click placement.
  controller.hoveredContraptionHit = {
    point: new THREE.Vector3(4.75, 5.2, 6.9),
    normal: new THREE.Vector3(1, 0, 0)
  };
  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 20, y: 20, z: 20 },
    normal: { x: 0, y: 1, z: 0 }
  };

  controller.updateInventoryPlacementPreview();
  const buildPose = controller.getInventoryPlacementPose(slot);

  assert.ok(controller.inventoryPlacementPreview);
  assert.deepEqual(controller.inventoryPlacementPreview.position.toArray(), [5, 5, 6]);
  assert.deepEqual(buildPose.position.toArray(), [5, 5, 6]);
  assert.equal(controller.inventoryPlacementPreview.slot, slot);
});

test('Hammer aims a micro block set on the adjacent 0.125 m cell of a focused micro voxel', () => {
  const slot = {
    kind: 'blockset',
    blockCount: 2,
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 0.125, color: 0x48dbfb },
      { dx: 0.125, dy: 0, dz: 0, size: 0.125, color: 0xf2a93b }
    ]
  };
  const controller = makeController(slot);
  controller.currentRaycast = {
    hit: true,
    kind: 'micro',
    microPos: { x: 18, y: 3, z: 10 },
    placeMicroPos: { x: 19, y: 3, z: 10 },
    hitPos: { x: 2.25, y: 0.375, z: 1.25 },
    normal: { x: 1, y: 0, z: 0 }
  };

  controller.updateInventoryPlacementPreview();
  const buildPose = controller.getInventoryPlacementPose(slot);

  assert.deepEqual(controller.inventoryPlacementPreview.position.toArray(), [2.375, 0.375, 1.25]);
  assert.deepEqual(buildPose.position.toArray(), [2.375, 0.375, 1.25]);
});

test('Hammer aims a micro block set at 0.125 m precision across a standard block face', () => {
  const slot = {
    kind: 'blockset',
    blockCount: 1,
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 0.125, color: 0x48dbfb }]
  };
  const controller = makeController(slot);
  controller.currentRaycast = {
    hit: true,
    kind: 'standard',
    hitPos: { x: 4, y: 5, z: 7 },
    entry: { x: 4.46, y: 6, z: 7.73 },
    normal: { x: 0, y: 1, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.deepEqual(pose.position.toArray(), [4.375, 6, 7.625]);
});

test('Hammer keeps block sets containing standard voxels on the 1 m grid', () => {
  const slot = {
    kind: 'blockset',
    blockCount: 2,
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 0.125, color: 0x48dbfb },
      { dx: 1, dy: 0, dz: 0, size: 1, color: 0xf2a93b }
    ]
  };
  const controller = makeController(slot);
  controller.currentRaycast = {
    hit: true,
    kind: 'micro',
    placeMicroPos: { x: 19, y: 3, z: 10 },
    hitPos: { x: 2.25, y: 0.375, z: 1.25 },
    normal: { x: 1, y: 0, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.deepEqual(pose.position.toArray(), [3, 0, 1]);
});

test('Hammer centres entity geometry on the hit and settles its bottom onto terrain', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [
      { localX: 4, localY: 3, localZ: -2, size: 1, entityId: 'root' },
      { localX: 5, localY: 3, localZ: -2, size: 1, entityId: 'root' }
    ]
  };
  const controller = makeController(slot);
  controller.world = flatTerrain(() => 2);
  controller.physics.getAABB = () => ({
    minX: -100, minY: 0, minZ: -100,
    maxX: -99, maxY: 2, maxZ: -99
  });
  controller.currentRaycast = {
    hit: true,
    kind: 'standard',
    hitPos: { x: 9, y: 8, z: 19 },
    entry: { x: 10, y: 9, z: 20 },
    normal: { x: 0, y: 1, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);
  const minX = pose.position.x + 4;
  const maxX = pose.position.x + 6;
  const minY = pose.position.y + 3;
  const minZ = pose.position.z - 2;
  const maxZ = pose.position.z - 1;

  assert.ok(Math.abs((minX + maxX) / 2 - 10) < 1e-8, 'X footprint should centre on the hit');
  assert.ok(Math.abs((minZ + maxZ) / 2 - 20) < 1e-8, 'Z footprint should centre on the hit');
  assert.ok(Math.abs(minY - 2) < 1e-8, 'the lowest authored voxel should rest on terrain');
});

test('standalone entity build keeps the rotated Hammer ghost pose exactly', () => {
  const slot = {
    name: 'Asymmetric entity',
    kind: 'entity',
    rootComponentId: 'root',
    blockCount: 2,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0x48dbfb, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, size: 1, color: 0xf2a93b, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [],
    scripts: [{ id: 'root', code: 'self.state.started = true;' }],
    enabled: [{ id: 'root', enabled: false }],
    constraints: []
  };
  const controller: any = makeController(slot);
  const manager: any = new ContraptionManager(new THREE.Scene(), null, null, null);
  controller.contraptions = manager;
  controller.sound = { playBlockPlace() {} };
  controller.ui = { showToast() {} };
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const pose = {
    position: new THREE.Vector3(10, 3, 20),
    quaternion: rotation
  };

  const created = controller.finishEntitySlotBuild(slot, pose);
  const expected = new THREE.Vector3(2.5, 0.5, 0.5)
    .applyQuaternion(rotation)
    .add(pose.position);
  const actual = created.getBlockWorldCenter(created.blocks[1]);

  assert.ok(actual.distanceTo(expected) < 1e-8);
  assert.ok(created.quaternion.angleTo(rotation) < 1e-8);
  assert.equal(created.isPhysicsSimulationEnabled(), true);
  assert.equal(created.isNodeScriptEnabled('root'), true, 'Hammer placement acts like global Play');
  assert.equal(created.scriptStatus, 'running');
});

test('Hammer keeps an entity outside a side face while centring it along the tangent axis', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [
      { localX: 4, localY: 0, localZ: -2, size: 1, entityId: 'root' },
      { localX: 5, localY: 0, localZ: -2, size: 1, entityId: 'root' }
    ]
  };
  const controller = makeController(slot);
  controller.world = flatTerrain(() => 0);
  controller.currentRaycast = {
    hit: true,
    kind: 'standard',
    hitPos: { x: 9, y: 2, z: 19 },
    entry: { x: 10, y: 2.5, z: 20 },
    normal: { x: 1, y: 0, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.ok(Math.abs(pose.position.x + 4 - 10) < 1e-8,
    'the nearest X face should touch, not cross, the hit wall');
  assert.ok(Math.abs(pose.position.z - 2 + 0.5 - 20) < 1e-8,
    'the tangent footprint should stay centred on the hit');
  assert.ok(Math.abs(pose.position.y) < 1e-8, 'the side placement should drop to terrain');
});

test('Hammer drops a ceiling placement without treating the hit ceiling as floor support', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root' }]
  };
  const controller = makeController(slot);
  controller.world = {
    raycast(origin) {
      // A ray starting above the underside at Y=5 would still be inside the
      // ceiling. A correct downward-face probe begins below it and reaches Y=0.
      return origin.y > 5
        ? { hit: true, distance: 0 }
        : { hit: true, distance: origin.y };
    },
    raycastMicro() {
      return { hit: false };
    }
  };
  controller.currentRaycast = {
    hit: true,
    kind: 'standard',
    hitPos: { x: 0, y: 5, z: 0 },
    entry: { x: 0.5, y: 5, z: 0.5 },
    normal: { x: 0, y: -1, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.ok(Math.abs(pose.position.y) < 1e-8);
});

test('Hammer uses the highest sampled terrain support instead of embedding a wide entity', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root' },
      { localX: 1, localY: 0, localZ: 0, size: 1, entityId: 'root' }
    ]
  };
  const controller = makeController(slot);
  controller.world = flatTerrain(x => x > 10 ? 4 : 2);
  controller.currentRaycast = {
    hit: true,
    kind: 'standard',
    hitPos: { x: 9, y: 7, z: 19 },
    entry: { x: 10, y: 8, z: 20 },
    normal: { x: 0, y: 1, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.ok(Math.abs(pose.position.y - 4) < 1e-8,
    'the footprint should rest on the highest support sampled below it');
});

test('Hammer keeps terrain placement centred even when it overlaps the player', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root' }]
  };
  const controller = makeController(slot);
  controller.world = flatTerrain(() => 0);
  const player = { minX: 0.2, minY: 0, minZ: 0.2, maxX: 0.8, maxY: 1.8, maxZ: 0.8 };
  controller.physics.getAABB = () => player;
  controller.currentRaycast = {
    hit: true,
    kind: 'standard',
    hitPos: { x: 0, y: -1, z: 0 },
    entry: { x: 0.5, y: 0, z: 0.5 },
    normal: { x: 0, y: 1, z: 0 }
  };

  const pose = controller.getInventoryPlacementPose(slot);
  const placed = {
    minX: pose.position.x,
    minY: pose.position.y,
    minZ: pose.position.z,
    maxX: pose.position.x + 1,
    maxY: pose.position.y + 1,
    maxZ: pose.position.z + 1
  };
  const overlaps = placed.maxX > player.minX && placed.minX < player.maxX
    && placed.maxY > player.minY && placed.minY < player.maxY
    && placed.maxZ > player.minZ && placed.minZ < player.maxZ;

  assert.equal(overlaps, true, 'entity placement no longer moves away from the player body');
  assert.deepEqual(pose.position.toArray(), [0, 0, 0]);
});

test('top-facing component installation keeps the target entity surface as support', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [{ localX: 2, localY: 3, localZ: 4, size: 1, entityId: 'root' }]
  };
  const controller = makeController(slot);
  controller.world = flatTerrain(() => 0);
  const target = {};
  controller.hoveredContraptionHit = {
    point: new THREE.Vector3(10, 10, 10),
    worldNormal: new THREE.Vector3(0, 1, 0),
    contraption: target,
    entityId: 'root'
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.equal(pose.targetContraption, target);
  assert.ok(Math.abs(pose.position.y + 3 - 10) < 1e-8,
    'terrain below must not pull a module through the top surface it is installed on');
});

test('entity-on-entity placement snaps to the targeted component micro grid without terrain correction', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 0.125, entityId: 'root' }]
  };
  const controller = makeController(slot);
  const targetOrigin = new THREE.Vector3(10.13, 7.07, -2.11);
  const targetRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 6
  );
  const inverseTargetRotation = targetRotation.clone().invert();
  const target = {
    worldToEntityLocal(_nodeId, point) {
      return point.clone().sub(targetOrigin).applyQuaternion(inverseTargetRotation);
    },
    entityLocalToWorld(_nodeId, point) {
      return point.clone().applyQuaternion(targetRotation).add(targetOrigin);
    },
    getEntityNodeWorldQuaternion() {
      return targetRotation.clone();
    }
  };
  const hitLocal = new THREE.Vector3(2.07, 1.2, -0.13);
  controller.hoveredContraptionHit = {
    point: target.entityLocalToWorld('arm', hitLocal),
    worldNormal: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 1, 0),
    contraption: target,
    entityId: 'arm'
  };
  controller.world = {
    raycast() { throw new Error('entity placement must not query terrain support'); },
    raycastMicro() { throw new Error('entity placement must not query micro terrain support'); }
  };
  controller.physics.getAABB = () => {
    throw new Error('entity placement must not apply free-form player avoidance');
  };

  const pose = controller.getInventoryPlacementPose(slot);
  const targetLocalOrigin = target.worldToEntityLocal('arm', pose.position);

  assert.equal(pose.targetContraption, target);
  assert.equal(pose.targetNodeId, 'arm');
  for (const coordinate of targetLocalOrigin.toArray()) {
    assert.ok(Math.abs(coordinate * 8 - Math.round(coordinate * 8)) < 1e-8,
      `target-local coordinate ${coordinate} must lie on the 0.125 m grid`);
  }
  assert.ok(pose.position.y > 7,
    'an entity side/top target must remain at the target instead of dropping to terrain');
  assert.ok(pose.quaternion.angleTo(targetRotation) < 1e-8,
    'top placement should inherit the targeted component grid orientation');
});

test('entity side placement rotates its authored up axis outward and stays tangent-centred', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root' },
      { localX: 0, localY: 1, localZ: 0, size: 1, entityId: 'root' }
    ]
  };
  const controller = makeController(slot);
  const target = {
    collisionPoseVersion: 1,
    collisionEntries: [],
    blocks: [],
    worldToEntityLocal(_nodeId, point) { return point.clone(); },
    entityLocalToWorld(_nodeId, point) { return point.clone(); },
    getEntityNodeWorldQuaternion() { return new THREE.Quaternion(); }
  };
  const surface = new THREE.Vector3(1, 2.4, 3.6);
  controller.hoveredContraptionHit = {
    point: surface,
    worldNormal: new THREE.Vector3(1, 0, 0),
    normal: new THREE.Vector3(1, 0, 0),
    contraption: target,
    entityId: 'arm'
  };

  const pose = controller.getInventoryPlacementPose(slot);
  const outward = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
  const placedCenters = getInventoryPreviewBlocks(slot).map(entry => (
    entry.center.clone().applyQuaternion(pose.quaternion).add(pose.position)
  ));
  const minX = Math.min(...placedCenters.map((center, index) => center.x - getInventoryPreviewBlocks(slot)[index].size / 2));
  const centerY = (Math.min(...placedCenters.map(center => center.y - 0.5))
    + Math.max(...placedCenters.map(center => center.y + 0.5))) / 2;
  const centerZ = (Math.min(...placedCenters.map(center => center.z - 0.5))
    + Math.max(...placedCenters.map(center => center.z + 0.5))) / 2;

  assert.ok(outward.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-8);
  assert.ok(Math.abs(minX - surface.x) < 1e-8, 'the rotated bottom face should touch the target side');
  assert.ok(Math.abs(centerY - surface.y) <= 0.1 + 1e-8);
  assert.ok(Math.abs(centerZ - surface.z) <= 0.1 + 1e-8);
});

test('entity-on-entity placement moves outward on the micro grid until target voxels no longer overlap', () => {
  const slot = {
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [{ localX: 0, localY: 0, localZ: 0, size: 1, entityId: 'root' }]
  };
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  const target = manager.buildFromSlot({
    kind: 'entity',
    rootComponentId: 'root',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xffffff, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 1, localY: 0, localZ: 0, size: 1, color: 0xffffff, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [], scripts: [], enabled: [], constraints: []
  }, new THREE.Vector3(), null, false);
  const controller = makeController(slot);
  controller.hoveredContraptionHit = {
    point: new THREE.Vector3(1, 0.5, 0.5),
    worldNormal: new THREE.Vector3(1, 0, 0),
    normal: new THREE.Vector3(1, 0, 0),
    contraption: target,
    entityId: 'root'
  };

  const pose = controller.getInventoryPlacementPose(slot);

  assert.ok(Math.abs(pose.position.x - 2) < 1e-8,
    'the centred x=1 pose overlaps an existing block and must move to the first clear 0.2-grid offset');
  assert.equal((controller as any).entitySlotOverlapsTarget(slot, pose.position, pose.quaternion, target), false);
});

test('Hammer ghost hides without a hovered surface, on an empty slot, or in another tool', () => {
  const slot = {
    kind: 'blockset',
    blocks: [{ dx: 0, dy: 0, dz: 0, size: 1 }]
  };
  const controller = makeController(slot);

  controller.updateInventoryPlacementPreview();
  assert.equal(controller.inventoryPlacementPreview, null, 'air is not a hover target');

  controller.currentRaycast = {
    hit: true,
    hitPos: { x: 2, y: 3, z: 4 },
    normal: { x: 0, y: 1, z: 0 }
  };
  controller.updateInventoryPlacementPreview();
  assert.ok(controller.inventoryPlacementPreview);

  controller.activeTool = SpecialTool.SELECTOR;
  controller.updateInventoryPlacementPreview();
  assert.equal(controller.inventoryPlacementPreview, null);

  controller.activeTool = SpecialTool.HAMMER;
  controller.inventorySlots[0] = null;
  controller.updateInventoryPlacementPreview();
  assert.equal(controller.inventoryPlacementPreview, null);
});

test('entity preview blocks reproduce the hierarchy pose built from the same slot', () => {
  const slot = {
    rootComponentId: 'root',
    blockCount: 2,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xf2a93b, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, size: 1, color: 0x48dbfb, block: BlockTypes.COLOR_BLOCK, entityId: 'arm' }
    ],
    childEntities: [{
      id: 'arm',
      parentId: 'root',
      pivot: [2.5, 0.5, 0.5],
      localPosition: [1.25, 0.5, 0],
      localRotation: [0, 0, Math.PI / 2]
    }],
    scripts: [],
    enabled: []
  };
  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, {}, null, null);
  const entity = manager.buildFromSlot(slot, new THREE.Vector3());
  const previewBlocks = getInventoryPreviewBlocks(slot);

  assert.equal(previewBlocks.length, entity.blocks.length);
  for (let index = 0; index < entity.blocks.length; index++) {
    const builtCenter = entity.getBlockWorldCenter(entity.blocks[index]);
    assert.ok(
      previewBlocks[index].center.distanceTo(builtCenter) < 1e-8,
      `preview block ${index} must match the built hierarchy pose`
    );
  }
});

test('renderer shows colored, scaled unified voxel mesh at the placement origin', () => {
  const renderer = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupInventoryPlacementPreview();
  const slot = {
    kind: 'blockset',
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 1, color: 0xeb4d4b },
      { dx: 1, dy: 2, dz: 3, size: 0.125, color: 0x48dbfb }
    ]
  };

  renderer.setInventoryPlacementPreview({
    slot,
    kind: 'blockset',
    position: new THREE.Vector3(10, 20, 30),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  });
  assert.equal(renderer.inventoryPlacementGroup.visible, true);
  assert.deepEqual(renderer.inventoryPlacementGroup.position.toArray(), [10, 20, 30]);
  assert.ok(renderer.inventoryPlacementGroup.quaternion.angleTo(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  ) < 1e-8);
  assert.ok(renderer.inventoryPlacementFill);
  assert.ok(renderer.inventoryPlacementFill.isMesh);
  assert.ok(renderer.inventoryPlacementFill.geometry.getAttribute('position').count > 0);
  assert.ok(renderer.inventoryPlacementFill.geometry.getAttribute('color').count > 0);

  renderer.setInventoryPlacementPreview(null);
  assert.equal(renderer.inventoryPlacementGroup.visible, false);
});

test('hammer ghost is a unified outer boundary mesh with internal face culling', () => {
  const renderer = Object.create(SceneRenderer.prototype);
  renderer.scene = { add() {} };
  renderer.setupInventoryPlacementPreview();
  const slot = {
    kind: 'blockset',
    blocks: [
      { dx: 0, dy: 0, dz: 0, size: 1, color: 0xeb4d4b },
      { dx: 1, dy: 2, dz: 3, size: 0.125, color: 0x48dbfb }
    ]
  };

  renderer.setInventoryPlacementPreview({
    slot,
    kind: 'blockset',
    position: new THREE.Vector3(10, 20, 30)
  });

  // No X-ray: both passes depth-test against the scene.
  assert.equal(renderer.inventoryPlacementFill.material.depthTest, true);
  assert.equal(renderer.inventoryPlacementFill.material.depthWrite, true,
    'the fill must write depth so interior edges hide behind the outer shell');
  assert.equal(renderer.inventoryPlacementFill.material.vertexColors, true);
  assert.equal(renderer.inventoryPlacementWire.material.depthTest, true);
  assert.equal(renderer.inventoryPlacementWire.material.depthWrite, false);

  // The outline is line segments, not a triangulated wireframe mesh.
  const wire = renderer.inventoryPlacementWire;
  assert.equal(wire.isLineSegments, true);
  assert.equal(wire.material.wireframe, undefined);
  const wireGeometry = wire.geometry;
  assert.ok(wireGeometry.getAttribute('position').count > 0);

  // Rebuilding disposes the previous wire geometry instead of leaking it.
  let disposedGeometryEvent = false;
  let disposedMaterialEvent = false;
  wireGeometry.addEventListener('dispose', () => { disposedGeometryEvent = true; });
  wire.material.addEventListener('dispose', () => { disposedMaterialEvent = true; });
  renderer.setInventoryPlacementPreview({
    slot: {
      kind: 'blockset',
      blocks: [{ dx: 0, dy: 0, dz: 0, size: 1, color: 0x20bf6b }]
    },
    kind: 'blockset',
    position: new THREE.Vector3(10, 20, 30)
  });
  assert.equal(disposedGeometryEvent, true, 'the previous wire geometry is disposed on rebuild');
  assert.equal(disposedMaterialEvent, true, 'the previous wire material is disposed on rebuild');
});

test('buildUnifiedInventoryPreviewMesh culls internal touching faces between adjacent voxels', () => {
  // 1. Two adjacent blocks at (0,0,0) and (1,0,0) with size 1
  const twoAdjacentBlocks = [
    { center: new THREE.Vector3(0.5, 0.5, 0.5), size: 1, color: '#ff0000' },
    { center: new THREE.Vector3(1.5, 0.5, 0.5), size: 1, color: '#00ff00' }
  ];
  const twoResult = buildUnifiedInventoryPreviewMesh(twoAdjacentBlocks);
  assert.ok(twoResult);
  // Two isolated cubes would have 12 faces = 24 triangles.
  // With internal face between them culled, exactly 10 faces = 20 triangles (60 vertex positions)
  assert.equal(twoResult.patchCount, 10);
  assert.equal(twoResult.fillGeometry.getAttribute('position').count, 60);

  // 2. 3x3x3 solid cube of 27 blocks (size 1)
  const cubeBlocks = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        cubeBlocks.push({
          center: new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5),
          size: 1,
          color: '#ffffff'
        });
      }
    }
  }
  const cubeResult = buildUnifiedInventoryPreviewMesh(cubeBlocks);
  assert.ok(cubeResult);
  // 27 separate cubes would have 27 * 6 = 162 faces (324 triangles).
  // With all internal faces culled, only outer 6 faces of 3x3 (54 surface quads = 108 triangles = 324 vertices).
  assert.equal(cubeResult.patchCount, 54);
  assert.equal(cubeResult.fillGeometry.getAttribute('position').count, 324);
});

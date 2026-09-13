import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CuteCharacter } from '../src/engine/render/CuteCharacter.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';
import { spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';
import { createHeldVoxelTool, normalizeHeldTool, type HeldVoxelToolMesh } from '../src/engine/render/HeldVoxelTool.ts';

const tools = spaceUiStore.getSnapshot().hotbarSlots.map(slot => slot.value);
type ToolMesh = HeldVoxelToolMesh;

function character(model: 'strong' | 'slim' = 'strong', createFirstPersonHand = true) {
  return new CuteCharacter(new THREE.Texture(), {
    width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255)
  } as ImageData, { model, showOverlay: false, createFirstPersonHand });
}

function visibleTools(root: THREE.Object3D): ToolMesh[] {
  const result: ToolMesh[] = [];
  root.traverseVisible(object => {
    if (object.name.startsWith('HeldVoxelTool:')) result.push(object as ToolMesh);
  });
  return result;
}

test('tools stay compact and share the standard hand grip posture', () => {
  for (const tool of tools) {
    const mesh = createHeldVoxelTool(normalizeHeldTool(tool)!);
    const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    const expectedLength = 6.4;
    assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - expectedLength) < 1e-5,
      `${tool}: tools must stay compact at 6.4`);
    if (tool === 'shovel') {
      assert.ok(Math.abs(mesh.geometry.boundingBox!.min.y - (-4.5 * 6.4 / 25 + 0.65)) < 1e-5,
        'the shaft heel must remain in its original position');
      const positions = mesh.geometry.getAttribute('position');
      let shaftWidth = 0;
      for (let i = 0; i < positions.count; i++) {
        if (positions.getY(i) < 2) shaftWidth = Math.max(shaftWidth, Math.abs(positions.getX(i)) * 2);
      }
      assert.ok(Math.abs(shaftWidth - 3 * 6.4 / 25) < 1e-5, 'the shaft width must match spoon');
    }
    mesh.geometry.dispose();
    for (const material of mesh.material) {
      material.envMap?.dispose();
      material.dispose();
    }
  }
  const rig = character();
  rig.setHeldTool('hammer');
  rig.update(0, { grounded: true });
  rig.object3d.updateMatrixWorld(true);
  rig.firstPersonHand.updateMatrixWorld(true);
  for (const root of [rig.object3d, rig.firstPersonHand]) {
    const mesh = visibleTools(root)[0];
    const grip = mesh.localToWorld(new THREE.Vector3());
    const head = mesh.localToWorld(new THREE.Vector3(0, 4, 0));
    assert.ok(head.y > grip.y + 0.1, 'the hammer handle must point up from the grip');
  }
  const worldHammer = visibleTools(rig.object3d)[0];
  assert.ok(Math.abs(worldHammer.rotation.x - Math.PI / 2) < 1e-5, 'hammer must share standard grip rotation');
  const strikingDirection = new THREE.Vector3(-1, 0, 0).transformDirection(worldHammer.matrixWorld);
  assert.ok(strikingDirection.z < -0.5, 'the hammer head striking face must point forward');
  assert.equal(worldHammer.position.x, 0);
  assert.equal(worldHammer.position.y, 0);
  assert.equal(worldHammer.position.z, 0);
  rig.dispose();
});

test('held tools exit at the same palm opening with their heel inside the fist', () => {
  for (const model of ['strong', 'slim'] as const) {
    const rig = character(model);
    const armWidth = model === 'strong' ? 4 : 3;
    const palmBounds = new THREE.Box3(new THREE.Vector3(-armWidth / 2, -8, -2), new THREE.Vector3(armWidth / 2, 0, 2));
    let referenceExit: THREE.Vector3 | null = null;
    for (const tool of ['selector', 'shovel', 'spoon', 'wrench', 'brush', 'hammer', 'selector', 'hammer']) {
      rig.setHeldTool(tool);
      for (const dt of [0, 0.12, 0.12]) {
        if (dt) rig.playToolUseAnimation();
        rig.update(dt, { grounded: true });
        rig.object3d.updateMatrixWorld(true);
        const mesh = visibleTools(rig.object3d)[0];
        const arm = mesh.parent!.parent!;
        const inArm = (point: THREE.Vector3) => arm.worldToLocal(mesh.localToWorld(point));
        const shaftTop = inArm(new THREE.Vector3(0, 3, 0));
        const towardHeel = inArm(new THREE.Vector3()).sub(shaftTop).normalize();
        const exit = new THREE.Ray(shaftTop, towardHeel).intersectBox(palmBounds, new THREE.Vector3());
        assert.ok(exit, `${model}/${tool}: shaft misses the hand`);
        if (!referenceExit) referenceExit = exit.clone();
        assert.ok(exit.distanceTo(referenceExit) < 1e-5, `${model}/${tool}: shaft moved away from the palm opening`);
        if (tool === 'hammer') {
          const positions = mesh.geometry.getAttribute('position');
          const heelY = mesh.geometry.boundingBox!.min.y;
          for (let i = 0; i < positions.count; i++) {
            if (positions.getY(i) > heelY + 1e-5) continue;
            assert.ok(palmBounds.containsPoint(inArm(new THREE.Vector3().fromBufferAttribute(positions, i))),
              `${model}: hammer heel protrudes through the fist`);
          }
        }
      }
    }
    rig.dispose();
  }
});

test('the brush has matte wood and bristles in both views', () => {
  const rig = character();
  rig.setHeldTool('brush');
  rig.update(0);
  rig.firstPersonHand.updateMatrixWorld(true);
  for (const root of [rig.object3d, rig.firstPersonHand]) {
    const brush = visibleTools(root)[0];
    assert.deepEqual(brush.material.map(material => material.name), ['ToolSilver', 'BrushWood', 'BrushBristles']);
    assert.deepEqual(brush.geometry.groups.map(group => group.materialIndex), [0, 1, 2]);
    for (const material of brush.material.slice(1)) {
      assert.equal(material.metalness, 0);
      assert.ok(material.roughness >= 0.85);
      assert.equal(material.envMap, null);
    }
  }
  rig.dispose();
});

test('equipping replaces the visible first-person arm with the tool, and clearing it restores the arm', () => {
  const rig = new CuteCharacter(new THREE.Texture(), {
    width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255)
  } as ImageData, { model: 'strong', showOverlay: true });
  const meshes = () => {
    const result: THREE.Mesh[] = [];
    rig.firstPersonHand.traverseVisible(object => {
      if (object instanceof THREE.Mesh) result.push(object);
    });
    return result;
  };
  const emptyHand = meshes();
  assert.ok(emptyHand.length > 1, 'the fixture must cover both skin and sleeve overlay');
  for (const tool of tools) {
    rig.setHeldTool(tool);
    assert.deepEqual(meshes(), visibleTools(rig.firstPersonHand), `${tool}: skin or sleeve remains visible`);
    rig.playToolUseAnimation();
    rig.update(0.1);
    assert.deepEqual(meshes(), visibleTools(rig.firstPersonHand), `${tool}: swinging revealed the arm`);
    rig.setHeldTool(null);
    rig.update(0);
    assert.deepEqual(meshes(), emptyHand, `${tool}: clearing the tool did not restore the same arm`);
    assert.equal(visibleTools(rig.object3d).length, 0);
  }
  rig.dispose();
});

test('only accepted, pointer-locked left clicks request a hand stroke, including misses', t => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners = new Map<string, (event: any) => void>();
  globalThis.document = { addEventListener: (name, callback) => listeners.set(name, callback) } as any;
  globalThis.window = { addEventListener() {} } as any;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });
  const controller = Object.assign(Object.create(PlayerController.prototype), {
    _activeTool: 'shovel', toolUseSequence: 0, isLocked: false,
    currentRaycast: { hit: false }, updateAimRaycast() {},
    refreshAimAfterPointerAction() {}, handleRightClick() {},
    ui: { showToast() {} }
  });
  controller.setupEventListeners();
  const click = listeners.get('mousedown')!;
  click({ button: 0 });
  assert.equal(controller.toolUseSequence, 0, 'UI clicks must not animate');
  controller.isLocked = true;
  click({ button: 0 });
  assert.equal(controller.toolUseSequence, 1, 'a miss still swings the hand');
  click({ button: 2 });
  assert.equal(controller.toolUseSequence, 1, 'right-click does not request a stroke');
  controller.bulkEditJob = { label: 'Building' };
  click({ button: 0 });
  assert.equal(controller.toolUseSequence, 1, 'rejected actions must not queue strokes');
});

test('left-click strokes animate both perspectives, queue smoothly, and return to the idle pose', () => {
  for (const tool of tools) {
    const rig = character();
    const restingRig = character();
    const scene = {
      playerAvatar: new THREE.Group(), playerAvatarCharacter: rig,
      camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100)
    };
    scene.camera.add(rig.firstPersonHand);
    scene.playerAvatar.add(rig.object3d);
    restingRig.setHeldTool(tool);
    const update = (sequence: number, dt = 1 / 60) => {
      SceneRenderer.prototype.updatePlayerAvatar.call(scene, new THREE.Vector3(), 0, dt, {
        activeTool: tool, toolUseSequence: sequence, grounded: true
      });
      restingRig.update(dt, { grounded: true });
    };
    update(7, 0); // Loading a skin must not replay previous clicks.
    const viewPose = rig.firstPersonHand.getObjectByName('CuteFirstPersonToolPose')!;
    const restViewPose = restingRig.firstPersonHand.getObjectByName('CuteFirstPersonToolPose')!;
    const arm = visibleTools(rig.object3d)[0].parent!.parent!;
    const restArm = visibleTools(restingRig.object3d)[0].parent!.parent!;
    assert.ok(viewPose.quaternion.angleTo(restViewPose.quaternion) < 1e-7);
    let viewMotion = 0;
    let armMotion = 0;
    let previousArm = arm.quaternion.clone();
    for (let frame = 0; frame < 70; frame++) {
      // Several clicks during the first stroke coalesce into one follow-up.
      update(frame < 3 ? 8 : frame < 4 ? 9 : 10);
      viewMotion = Math.max(viewMotion, viewPose.quaternion.angleTo(restViewPose.quaternion));
      armMotion = Math.max(armMotion, arm.quaternion.angleTo(restArm.quaternion));
      assert.ok(arm.quaternion.angleTo(previousArm) < 0.2, `${tool}: repeated clicks snapped the arm`);
      previousArm.copy(arm.quaternion);
      scene.camera.updateMatrixWorld(true);
      const mesh = visibleTools(rig.firstPersonHand)[0];
      const position = new THREE.Vector3();
      const vertices = mesh.geometry.getAttribute('position');
      for (let index = 0; index < vertices.count; index++) {
        position.fromBufferAttribute(vertices, index).applyMatrix4(mesh.matrixWorld).project(scene.camera);
        assert.ok(position.x > 0.25, `${tool}: the stroke blocks the crosshair`);
        assert.ok(position.z > -1 && position.z < 1, `${tool}: the stroke crosses a clipping plane`);
      }
    }
    assert.ok(viewMotion > 0.25 && armMotion > 0.5, `${tool}: stroke did not reach both views`);
    assert.ok(viewPose.quaternion.angleTo(restViewPose.quaternion) < 1e-7);
    assert.ok(arm.quaternion.angleTo(restArm.quaternion) < 1e-7);
    assert.ok(viewPose.position.distanceTo(restViewPose.position) < 1e-10);
    rig.playToolUseAnimation();
    rig.update(0.1);
    rig.setHeldTool(tool === 'shovel' ? 'brush' : 'shovel');
    rig.update(0);
    assert.ok(viewPose.quaternion.angleTo(restViewPose.quaternion) < 1e-7, 'switching tools cancels the previous stroke');
    rig.dispose();
    restingRig.dispose();
  }
});

test('every toolbar selection reaches both right hands through the scene update', () => {
  const rig = character();
  const scene = {
    playerAvatar: new THREE.Group(),
    playerAvatarCharacter: rig,
    camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100)
  };
  scene.playerAvatar.add(rig.object3d);
  // This also covers selection before the asynchronous skin has arrived:
  // the next scene update supplies the current selection to the new rig.
  const update = (activeTool: string | null) => SceneRenderer.prototype.updatePlayerAvatar.call(
    scene, new THREE.Vector3(10, 5, 20), 0.3, 1 / 60, { activeTool, grounded: true }
  );
  const geometries = new Map<string, THREE.BufferGeometry>();
  for (const tool of [...tools, ...tools].reverse()) {
    update(tool);
    const world = visibleTools(rig.object3d);
    const view = visibleTools(rig.firstPersonHand);
    assert.equal(world.length, 1);
    assert.equal(view.length, 1);
    assert.equal(world[0].name, `HeldVoxelTool:${tool}`);
    assert.equal(view[0].name, world[0].name);
    assert.equal(world[0].parent?.name, 'CuteRightHandGrip');
    assert.equal(view[0].parent?.name, 'CuteFirstPersonGrip');
    assert.equal(view[0].geometry, world[0].geometry);
    assert.notEqual(view[0].material, world[0].material, 'torus shader must never leak to the viewmodel');
    assert.equal(view[0].userData.torusPreBent, true);
    assert.equal(view[0].castShadow, false);
    for (const [index, material] of view[0].material.entries()) {
      assert.notEqual(material, world[0].material[index]);
      assert.equal(material.depthTest, true);
      assert.equal(material.depthWrite, true);
      assert.equal(material.transparent, false);
      assert.equal(material.fog, false);
    }
    assert.ok(view[0].material[0].metalness > 0.5);
    assert.ok(view[0].material[0].envMap, 'silver needs reflections in shadow');
    if (geometries.has(tool)) assert.equal(world[0].geometry, geometries.get(tool));
    geometries.set(tool, world[0].geometry);
  }
  assert.equal(new Set(geometries.values()).size, tools.length, 'each toolbar tool needs its own shape');
  update('pipette');
  assert.equal(visibleTools(rig.firstPersonHand)[0].name, 'HeldVoxelTool:brush');
  update('unknown');
  assert.equal(visibleTools(rig.object3d).length, 0);
  assert.equal(visibleTools(rig.firstPersonHand).length, 0);
  update(null);
  assert.equal(visibleTools(rig.firstPersonHand).length, 0);
  rig.dispose();
});

test('held tools enter from the cropped lower-right edge while their working ends remain visible across FOV and movement', () => {
  for (const model of ['strong', 'slim'] as const) {
    const rig = character(model);
    for (const [fov, aspect] of [[40, 1], [75, 16 / 9], [110, 21 / 9], [120, 9 / 16]]) {
      const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
      camera.add(rig.firstPersonHand);
      rig.updateFirstPersonProjection(camera);
      for (const motion of [
        { grounded: true, speed: 0 },
        { grounded: true, speed: 5, forwardSpeed: 5 },
        { grounded: false, speed: 5, sideSpeed: 5, flying: true },
        { grounded: false, verticalSpeed: 5 }
      ]) {
        for (let frame = 0; frame < 45; frame++) rig.update(1 / 60, motion);
        for (const tool of tools) {
          rig.setHeldTool(tool);
          rig.update(0, motion);
          camera.updateMatrixWorld(true);
          const mesh = visibleTools(rig.firstPersonHand)[0];
          const bounds = new THREE.Box3();
          const position = new THREE.Vector3();
          const attribute = mesh.geometry.getAttribute('position');
          for (let i = 0; i < attribute.count; i++) {
            position.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld).project(camera);
            bounds.expandByPoint(position);
          }
          const label = `${model}/${tool}/${fov}/${aspect}`;
          assert.ok(bounds.min.x > 0.3, `${label}: tool covers the crosshair`);
          assert.ok(bounds.min.x < 0.9 && bounds.max.x < 1.4, `${label}: too much of the tool is offscreen`);
          assert.ok(bounds.min.y < -1, `${label}: the handle must extend beyond the bottom edge`);
          assert.ok(bounds.max.y > -0.5 && bounds.max.y < 0.35, `${label}: the working end is not in the right-side view`);
          assert.ok(bounds.min.z > -1 && bounds.max.z < 1, `${label}: tool crosses the clipping planes`);
        }
      }
      camera.remove(rig.firstPersonHand);
    }
    rig.dispose();
  }
});

test('the world tool follows the right arm and cached resources are released once on skin disposal', () => {
  const rig = character();
  for (const tool of tools) rig.setHeldTool(tool);
  const mesh = visibleTools(rig.object3d)[0];
  rig.object3d.updateMatrixWorld(true);
  const rest = mesh.getWorldPosition(new THREE.Vector3());
  for (let i = 0; i < 30; i++) rig.update(1 / 60, { grounded: true, speed: 5, forwardSpeed: 5 });
  rig.object3d.updateMatrixWorld(true);
  assert.ok(mesh.getWorldPosition(new THREE.Vector3()).distanceTo(rest) > 0.01);
  rig.setCastShadow(false);
  assert.equal(mesh.castShadow, false);
  rig.setHeldTool(tools[0]);
  assert.equal(visibleTools(rig.object3d)[0].castShadow, false);

  const resources = new Map<THREE.BufferGeometry | THREE.Material | THREE.Texture, number>();
  for (const root of [rig.object3d, rig.firstPersonHand]) root.traverse(object => {
    if (!object.name.startsWith('HeldVoxelTool:')) return;
    const tool = object as ToolMesh;
    for (const resource of [tool.geometry, ...tool.material, ...tool.material.map(material => material.envMap).filter(Boolean)]) {
      if (resources.has(resource)) continue;
      resources.set(resource, 0);
      resource.addEventListener('dispose', () => resources.set(resource, resources.get(resource)! + 1));
    }
  });
  rig.dispose();
  assert.equal(resources.size, tools.length * 4 + 4, 'brush wood and bristle materials are separate in each view');
  for (const count of resources.values()) assert.equal(count, 1);

  const remote = character('slim', false);
  remote.setHeldTool('hammer');
  assert.equal(remote.firstPersonHand.children.length, 0);
  assert.equal(visibleTools(remote.object3d).length, 1);
  remote.dispose();
});

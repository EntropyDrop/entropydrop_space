import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CuteCharacter, detectSkinModel } from '../src/engine/render/CuteCharacter.ts';
import { decodePng } from '../tools/png-decode.mjs';

function createTestCharacter(model: 'strong' | 'slim' = 'strong') {
  const data = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  return new CuteCharacter(
    new THREE.Texture(),
    { width: 64, height: 64, data } as ImageData,
    { model, showOverlay: false, castShadow: false }
  );
}

test('the renderer skin fixture is a 64x64 strong model skin', () => {
  const skin = decodePng(fileURLToPath(new URL('../skin_D2A9EB7A.png', import.meta.url)));
  assert.equal(skin.width, 64);
  assert.equal(skin.height, 64);
  assert.equal(skin.channels, 4);
  assert.equal(detectSkinModel(skin), 'strong');
});

test('skin model detection recognizes the slim arm metadata pixel', () => {
  const data = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  data[(20 * 64 + 55) * 4 + 3] = 0;
  assert.equal(detectSkinModel({ width: 64, height: 64, data }), 'slim');
});

test('strong uses the slim cute torso with four-pixel outward-tilted arms', () => {
  const strong = createTestCharacter('strong');
  const slim = createTestCharacter('slim');
  const strongRig = strong as any;
  const slimRig = slim as any;
  const strongTorso = strongRig.parts.body.children[0].children[0] as THREE.Mesh;
  const slimTorso = slimRig.parts.body.children[0].children[0] as THREE.Mesh;
  const strongArm = strongRig.parts.leftArm.getObjectByProperty('type', 'Mesh') as THREE.Mesh;

  assert.deepEqual(
    Array.from(strongTorso.geometry.attributes.position.array),
    Array.from(slimTorso.geometry.attributes.position.array),
    'strong and slim should share the same tapered torso geometry'
  );
  assert.equal((strongArm.geometry as THREE.BoxGeometry).parameters.width, 4);
  assert.ok(Math.abs(strongRig.parts.leftArm.position.x - 3.725) < 1e-12);
  assert.ok(Math.abs(strongRig.parts.rightArm.position.x + 3.725) < 1e-12);
  assert.equal(strongRig.parts.leftArm.rotation.z, 0.2);
  assert.equal(strongRig.parts.rightArm.rotation.z, -0.2);

  strong.dispose();
  slim.dispose();
});

test('remote characters expose a one-plane billboard and switch expensive details off', () => {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 8; y < 16; y++) {
    for (let x = 8; x < 16; x++) {
      const index = (y * 64 + x) * 4;
      data[index] = 0x12;
      data[index + 1] = 0x34;
      data[index + 2] = 0x56;
      data[index + 3] = 255;
    }
  }
  const character = new CuteCharacter(
    new THREE.Texture(),
    { width: 64, height: 64, data } as ImageData,
    {
      model: 'strong',
      showOverlay: true,
      castShadow: true,
      createBillboard: true,
      createFirstPersonHand: false,
    }
  );

  assert.ok(character.billboard instanceof THREE.Mesh);
  assert.equal(character.billboard.geometry.parameters.width, 0.9);
  assert.equal(character.billboard.geometry.parameters.height, 1.8);
  const billboardImage = character.billboard.material.map!.image as { width: number; height: number };
  assert.equal(billboardImage.width, 16);
  assert.equal(billboardImage.height, 32);
  assert.equal(character.billboard.castShadow, false);
  assert.equal(character.firstPersonHand.children.length, 0);

  const overlays: THREE.Group[] = [];
  const meshes: THREE.Mesh[] = [];
  character.object3d.traverse(object => {
    if (object instanceof THREE.Group && object.userData.cuteCharacterOverlay) overlays.push(object);
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  assert.equal(overlays.length, 6);
  assert.ok(meshes.every(mesh => mesh.castShadow));

  character.setOverlayVisible(false);
  character.setCastShadow(false);
  assert.ok(overlays.every(overlay => !overlay.visible));
  assert.ok(meshes.every(mesh => !mesh.castShadow));
  character.dispose();
});

test('locomotion blends in and out instead of snapping between poses', () => {
  const character = createTestCharacter();
  const rig = character as any;
  character.update(1 / 60, {
    speed: 5,
    forwardSpeed: 5,
    maxSpeed: 5,
    grounded: true
  });
  assert.ok(rig.locomotionBlend > 0 && rig.locomotionBlend < 0.25);
  assert.ok(Math.abs(rig.parts.leftLeg.rotation.x) < 0.1);

  for (let frame = 0; frame < 60; frame++) {
    character.update(1 / 60, {
      speed: 5,
      forwardSpeed: 5,
      maxSpeed: 5,
      grounded: true
    });
  }
  assert.ok(rig.locomotionBlend > 0.98);

  character.update(1 / 60, { speed: 0, grounded: true });
  assert.ok(rig.locomotionBlend > 0.8);
  for (let frame = 0; frame < 90; frame++) {
    character.update(1 / 60, { speed: 0, grounded: true });
  }
  assert.ok(rig.locomotionBlend < 0.001);
  character.dispose();
});

test('walking swings one-piece Y-downsampled limbs and airborne/look states receive distinct poses', () => {
  const character = createTestCharacter();
  const rig = character as any;
  const leftArmMesh = rig.parts.leftArm.getObjectByProperty('type', 'Mesh') as THREE.Mesh;
  const leftLegMesh = rig.parts.leftLeg.getObjectByProperty('type', 'Mesh') as THREE.Mesh;
  assert.equal((leftArmMesh.geometry as THREE.BoxGeometry).parameters.height, 8);
  assert.equal((leftLegMesh.geometry as THREE.BoxGeometry).parameters.height, 8);
  assert.equal(rig.parts.leftArm.scale.x, 0.85, 'X cell width must remain unchanged');
  assert.equal(rig.parts.leftArm.scale.y, 0.85, 'Y cells should stay square instead of being squashed');
  assert.equal(rig.parts.leftArm.position.y, 3.4);
  assert.equal(rig.parts.leftLeg.position.y, -3.4);
  const armMaterials = leftArmMesh.material as THREE.MeshBasicMaterial[];
  assert.equal((armMaterials[4].map!.image as { width: number; height: number }).width, 4);
  assert.equal((armMaterials[4].map!.image as { width: number; height: number }).height, 8);
  assert.equal((armMaterials[2].map!.image as { width: number; height: number }).height, 4);
  assert.equal(rig.parts.leftLowArm, undefined);
  assert.equal(rig.parts.leftLowLeg, undefined);

  let maximumLegSwing = 0;
  for (let frame = 0; frame < 120; frame++) {
    character.update(1 / 60, {
      speed: 5,
      forwardSpeed: 5,
      maxSpeed: 5,
      grounded: true,
      lookPitch: 0.5
    });
    maximumLegSwing = Math.max(
      maximumLegSwing,
      Math.abs(rig.parts.leftLeg.rotation.x),
      Math.abs(rig.parts.rightLeg.rotation.x)
    );
  }
  assert.ok(maximumLegSwing > 0.5);
  assert.ok(rig.parts.head.rotation.x < -0.2);

  for (let frame = 0; frame < 30; frame++) {
    character.update(1 / 60, {
      speed: 2,
      forwardSpeed: 2,
      verticalSpeed: 8,
      maxSpeed: 5,
      grounded: false
    });
  }
  assert.ok(rig.airborneBlend > 0.98);
  assert.ok(Math.abs(rig.parts.leftLeg.rotation.x) > 0.5);
  assert.ok(Math.abs(rig.parts.rightLeg.rotation.x) > 0.5);
  assert.ok(Math.abs(rig.parts.leftArm.rotation.x) > 0.38);
  assert.ok(Math.abs(rig.parts.rightArm.rotation.x) > 0.38);
  assert.ok(rig.parts.leftLeg.rotation.x * rig.parts.rightLeg.rotation.x < 0);
  assert.ok(rig.parts.leftArm.rotation.x * rig.parts.rightArm.rotation.x < 0);
  character.dispose();
});

test('jumping extends all limbs once and holds the maximum pose', () => {
  const character = createTestCharacter();
  const rig = character as any;
  let minimumLeft = Number.POSITIVE_INFINITY;
  let maximumLeft = Number.NEGATIVE_INFINITY;
  let takeoffPhase = 0;

  for (let frame = 0; frame < 180; frame++) {
    character.update(1 / 60, {
      speed: 5,
      forwardSpeed: 5,
      verticalSpeed: 0,
      maxSpeed: 5,
      grounded: false
    });
    if (frame === 0) takeoffPhase = rig.gaitPhase;
    if (frame < 90) continue;
    minimumLeft = Math.min(minimumLeft, rig.parts.leftArm.rotation.x);
    maximumLeft = Math.max(maximumLeft, rig.parts.leftArm.rotation.x);
  }

  assert.ok(rig.airborneBlend > 0.99);
  assert.equal(rig.gaitPhase, takeoffPhase, 'the gait cycle should pause in the air');
  assert.ok(maximumLeft - minimumLeft < 0.001, 'the extended jump pose should not oscillate');
  assert.ok(Math.abs(Math.abs(rig.parts.leftArm.rotation.x) - 0.62 * 0.78) < 0.001);
  assert.ok(Math.abs(Math.abs(rig.parts.rightArm.rotation.x) - 0.62 * 0.78) < 0.001);
  assert.ok(Math.abs(Math.abs(rig.parts.leftLeg.rotation.x) - 0.62) < 0.001);
  assert.ok(Math.abs(Math.abs(rig.parts.rightLeg.rotation.x) - 0.62) < 0.001);
  character.dispose();
});

test('rapid forward/backward switches keep the gait continuous', () => {
  const character = createTestCharacter();
  const rig = character as any;
  let previous = rig.parts.leftLeg.rotation.x;
  let largestStep = 0;

  for (let frame = 0; frame < 180; frame++) {
    const forward = Math.floor(frame / 6) % 2 === 0 ? 5 : -5;
    character.update(1 / 60, {
      speed: 5,
      forwardSpeed: forward,
      maxSpeed: 5,
      grounded: true
    });
    const current = rig.parts.leftLeg.rotation.x;
    largestStep = Math.max(largestStep, Math.abs(current - previous));
    previous = current;
  }

  // Normal max-speed cadence advances about 0.13 rad/frame. A direction-sign
  // phase flip would jump close to the full stride (roughly 1 radian).
  assert.ok(largestStep < 0.18, `limb pose jumped by ${largestStep.toFixed(3)} radians`);
  character.dispose();
});

test('flight eases into a leaned trailing-limb pose and exposes one first-person arm', () => {
  const character = createTestCharacter();
  const rig = character as any;
  const handMeshes: THREE.Mesh[] = [];
  character.firstPersonHand.traverse(object => {
    if (object instanceof THREE.Mesh) handMeshes.push(object);
  });
  assert.equal(handMeshes.length, 1);
  assert.equal((handMeshes[0].geometry as THREE.BoxGeometry).parameters.height, 8);
  assert.equal(handMeshes[0].userData.torusPreBent, true);
  for (const handMesh of handMeshes) {
    const handMaterials = Array.isArray(handMesh.material) ? handMesh.material : [handMesh.material];
    for (const material of handMaterials) {
      assert.equal(material.depthTest, true);
      assert.equal(material.depthWrite, true);
      assert.equal(material.transparent, false);
      assert.equal(material.opacity, 1);
      assert.equal(material.side, THREE.FrontSide);
    }
  }

  character.update(1 / 60, {
    speed: 5,
    forwardSpeed: 5,
    maxSpeed: 5,
    grounded: false,
    flying: true
  });
  assert.ok(rig.flightBlend > 0 && rig.flightBlend < 0.2);

  for (let frame = 0; frame < 90; frame++) {
    character.update(1 / 60, {
      speed: 5,
      forwardSpeed: 5,
      maxSpeed: 5,
      grounded: false,
      flying: true
    });
  }
  assert.ok(rig.flightBlend > 0.99);
  assert.ok(rig.parts.body.rotation.x > 0.5);
  assert.ok(rig.parts.leftLeg.rotation.x > 0.2);
  assert.ok(rig.parts.rightLeg.rotation.x > rig.parts.leftLeg.rotation.x);
  assert.ok(character.firstPersonHand.children[0].position.z < -0.65);
  character.dispose();
});

test('flight banks toward lateral travel and uses distinct forward/backward poses', () => {
  const samplePose = (forwardSpeed: number, sideSpeed: number) => {
    const character = createTestCharacter();
    const rig = character as any;
    for (let frame = 0; frame < 120; frame++) {
      character.update(1 / 60, {
        speed: 5,
        forwardSpeed,
        sideSpeed,
        maxSpeed: 5,
        grounded: false,
        flying: true
      });
    }
    const pose = {
      pitch: rig.parts.body.rotation.x,
      yaw: rig.parts.body.rotation.y,
      roll: rig.parts.body.rotation.z,
      leftArm: rig.parts.leftArm.rotation.x,
      leftLeg: rig.parts.leftLeg.rotation.x
    };
    character.dispose();
    return pose;
  };

  const forward = samplePose(5, 0);
  const backward = samplePose(-5, 0);
  const right = samplePose(0, 5);
  const left = samplePose(0, -5);

  assert.ok(forward.pitch > 0.5, `forward pitch=${forward.pitch.toFixed(3)}`);
  assert.ok(backward.pitch < -0.25, `backward pitch=${backward.pitch.toFixed(3)}`);
  assert.ok(forward.leftArm > backward.leftArm + 0.35);
  assert.ok(forward.leftLeg > backward.leftLeg + 0.45);
  assert.ok(right.roll > 0.15 && right.yaw > 0.04, 'right strafe should bank and turn right');
  assert.ok(left.roll < -0.15 && left.yaw < -0.04, 'left strafe should bank and turn left');
  assert.ok(Math.abs(right.pitch) < 0.1 && Math.abs(left.pitch) < 0.1, 'pure strafing should stay upright');
});

test('the MC first-person arm rises from below the right side toward the visible hand', () => {
  const character = createTestCharacter();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
  camera.add(character.firstPersonHand);
  character.updateFirstPersonProjection(camera);
  camera.updateMatrixWorld(true);

  const arm = character.firstPersonHand.children[0].children[0];
  const shoulder = new THREE.Vector3(0, 0, 0).applyMatrix4(arm.matrixWorld);
  const hand = new THREE.Vector3(0, -8, 0).applyMatrix4(arm.matrixWorld);
  const shoulderScreen = shoulder.clone().project(camera);
  const handScreen = hand.clone().project(camera);

  assert.ok(hand.z < shoulder.z, 'hand end should be farther from the camera');
  assert.ok(handScreen.x < shoulderScreen.x, 'hand should extend in from the right edge');
  assert.ok(handScreen.y > shoulderScreen.y, 'hand should extend up from the bottom edge');
  assert.ok(shoulderScreen.x > 0.7 && shoulderScreen.x < 1 && shoulderScreen.y < -1,
    'the MC shoulder anchor should sit below the bottom edge, in the right side of the view');
  assert.ok(handScreen.x > 0.35 && handScreen.x < 0.6 && handScreen.y > -0.55 && handScreen.y < -0.25,
    'the fist should rise into the MC hand region, instead of remaining tucked against the bottom-right corner');
  character.dispose();
});

test('the first-person hand keeps the same safe framing across camera FOVs and aspect ratios', () => {
  const character = createTestCharacter();
  const samples: Array<[number, number]> = [
    [40, 1],
    [50, 4 / 3],
    [75, 16 / 9],
    [90, 21 / 9],
    [110, 16 / 10],
    [120, 21 / 9]
  ];
  let reference: { shoulder: THREE.Vector3; hand: THREE.Vector3 } | null = null;

  for (const [fov, aspect] of samples) {
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    camera.add(character.firstPersonHand);
    character.updateFirstPersonProjection(camera);
    camera.updateMatrixWorld(true);

    const arm = character.firstPersonHand.children[0].children[0];
    const shoulder = new THREE.Vector3(0, 0, 0).applyMatrix4(arm.matrixWorld).project(camera);
    const hand = new THREE.Vector3(0, -8, 0).applyMatrix4(arm.matrixWorld).project(camera);
    assert.ok(shoulder.y < -1, `shoulder leaked above the bottom edge at ${fov} degrees`);
    assert.ok(hand.x > -1 && hand.x < 1 && hand.y > -1 && hand.y < 1, `hand left view at ${fov} degrees`);

    if (reference) {
      assert.ok(shoulder.distanceTo(reference.shoulder) < 1e-10, `shoulder framing changed at ${fov} degrees`);
      assert.ok(hand.distanceTo(reference.hand) < 1e-10, `hand framing changed at ${fov} degrees`);
    } else {
      reference = { shoulder, hand };
    }
    camera.remove(character.firstPersonHand);
  }

  character.dispose();
});

test('the first-person arm root and raised skin layer remain fully outside the viewport', () => {
  const data = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  const character = new CuteCharacter(
    new THREE.Texture(),
    { width: 64, height: 64, data } as ImageData,
    { model: 'strong', showOverlay: true, castShadow: false }
  );

  // Flight moves the hand closest to the viewport and is the least forgiving
  // animation state for the shoulder edge.
  for (let frame = 0; frame < 120; frame++) {
    character.update(1 / 60, {
      speed: 5,
      forwardSpeed: 5,
      maxSpeed: 5,
      grounded: false,
      flying: true
    });
  }

  for (const fov of [40, 75, 120]) {
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
    camera.add(character.firstPersonHand);
    character.updateFirstPersonProjection(camera);
    camera.updateMatrixWorld(true);

    const arm = character.firstPersonHand.children[0].children[0];
    const armWorldInverse = new THREE.Matrix4().copy(arm.matrixWorld).invert();
    let rootVertexCount = 0;
    let minimumRootScreenX = Number.POSITIVE_INFINITY;
    let maximumRootScreenY = Number.NEGATIVE_INFINITY;
    arm.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const positions = object.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) {
        const world = new THREE.Vector3()
          .fromBufferAttribute(positions, index)
          .applyMatrix4(object.matrixWorld);
        const armLocal = world.clone().applyMatrix4(armWorldInverse);
        if (armLocal.y < -0.4) continue;
        rootVertexCount++;
        const screen = world.project(camera);
        minimumRootScreenX = Math.min(minimumRootScreenX, screen.x);
        maximumRootScreenY = Math.max(maximumRootScreenY, screen.y);
      }
    });
    assert.ok(rootVertexCount > 0, 'the test should inspect the base cap and raised skin layer');
    assert.ok(
      minimumRootScreenX > 1 || maximumRootScreenY < -1,
      `root geometry leaked into view at ${fov} degrees`
    );
    camera.remove(character.firstPersonHand);
  }

  character.dispose();
});

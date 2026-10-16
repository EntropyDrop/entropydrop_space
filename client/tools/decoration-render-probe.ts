import * as THREE from 'three/webgpu';
import { createDecorationGroup, editDecorationGroup, captureDecorationTransforms,
  interpolateDecorationTransforms } from '../../engine/src/contraption/DecorationMeshes.ts';
import type { DecorationDefinition } from '../../engine/src/contraption/Decorations.ts';
import { applyCameraBend, setTorusViewCorrection } from '../../engine/src/torus/TorusWorld.ts';

/** Isolated entry point for decoration-render-probe.html; no game or server data. */
type Comparison = (phase: string, expected: ArrayLike<number>, actual: ArrayLike<number>) => void;
export async function runStandalone(compare?: Comparison) {
  const renderer = new THREE.WebGPURenderer();
  try {
    await renderer.init();
    return await run({ sceneRenderer: { renderer, flatCameraPosition: new THREE.Vector3() } }, compare);
  } finally {
    renderer.dispose();
  }
}

/** GPU regression probe: import this module in the local browser and call run(game).
 * CPU matrix tests cannot detect shader builders reordering instance deformation.
 * Compare rendered pixels against separate meshes before and after buffer updates. */
export async function run(game: any, compare?: Comparison) {
  const renderer: THREE.WebGPURenderer = game.sceneRenderer.renderer;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(1, 2, 3);
  const anchor = new THREE.Vector3(6520, 35, 740);
  const camera = new THREE.PerspectiveCamera(40, 2, .1, 1000);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.position.copy(anchor).add(new THREE.Vector3(0, 0, 30));
  camera.lookAt(anchor); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const flatEye = camera.position.clone();
  applyCameraBend(camera);
  const values: DecorationDefinition[] = Array.from({ length: 16 }, (_, i) => ({
    id: `d${i}`, color: i % 2 ? 0xff5533 : 0x33dd88,
    position: [(i % 8 - 3.5) * 2, (Math.floor(i / 8) - .5) * 3, 0],
    scale: [1, 1, 1], ...(i % 3 ? {} : { materialId: 1 }),
  }));
  const batched = createDecorationGroup(values, new THREE.Vector3());
  batched.position.copy(anchor); scene.add(batched);
  const target = new THREE.RenderTarget(512, 256);
  const results = [];
  let reference: THREE.Group | null = null;
  const dispose = (root: THREE.Object3D) => {
    root.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  };
  const capture = async () => {
    const previousTarget = renderer.getRenderTarget();
    try {
      setTorusViewCorrection(flatEye);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      setTorusViewCorrection(game.sceneRenderer.flatCameraPosition);
    }
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 256);
  };
  try {
    for (const phase of ['initial', 'animated']) {
      if (phase === 'animated') {
        // Directional light checks rotated/scaled normals with clearly visible faces.
        scene.add(light);
        captureDecorationTransforms(batched);
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .2, .4)).toArray();
        for (const value of values) editDecorationGroup(batched, value.id, {
          ...value, rotation, scale: [.4, 1.8, .7],
        }, new THREE.Vector3());
        interpolateDecorationTransforms(batched, .5);
        batched.quaternion.setFromEuler(new THREE.Euler(.15, .25, .1));
      }
      reference = new THREE.Group();
      reference.position.copy(batched.position); reference.quaternion.copy(batched.quaternion);
      for (const value of values) {
        const handle = batched.children.find(object => object.userData.decorationId === value.id)!;
        reference.add(createDecorationGroup([{ ...value, position: handle.position.toArray(),
          rotation: handle.quaternion.toArray(), scale: handle.scale.toArray() }], new THREE.Vector3()));
      }
      scene.add(reference);
      batched.visible = reference.visible = true;
      await renderer.compileAsync(scene, camera);
      batched.visible = false;
      const expected = await capture();
      batched.visible = true; reference.visible = false;
      const actual = await capture();
      compare?.(phase, expected, actual);
      let visiblePixels = 0, differingPixels = 0, absoluteError = 0;
      for (let i = 0; i < actual.length; i += 4) {
        if (expected[i] + expected[i + 1] + expected[i + 2] > 30) visiblePixels++;
        const error = Math.abs(actual[i] - expected[i]) + Math.abs(actual[i + 1] - expected[i + 1]) + Math.abs(actual[i + 2] - expected[i + 2]);
        absoluteError += error;
        if (error > 30) differingPixels++;
      }
      // Allow sparse rasterization differences from separate versus batched
      // world-matrix rounding at distant torus coordinates.
      const result = { phase, visiblePixels, differingPixels, absoluteError,
        passed: visiblePixels > 500 && differingPixels / visiblePixels < .02 };
      results.push(result);
      console.log('DECORATION_GPU_CHECK', JSON.stringify(result));
      dispose(reference); reference = null;
    }
  } finally {
    if (reference) dispose(reference);
    dispose(batched); target.dispose();
  }
  if (results.some(result => !result.passed)) throw new Error(`Decoration render mismatch: ${JSON.stringify(results)}`);
  return results;
}

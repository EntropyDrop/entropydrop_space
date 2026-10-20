import * as THREE from 'three/webgpu';
import { reference } from 'three/tsl';
import { MAX_SELECTION_BEND_SEGMENTS } from '../constants/SpaceConstants.ts';

const occludedMaterials = new WeakMap<THREE.MeshStandardNodeMaterial, THREE.MeshStandardNodeMaterial>();
const occludedOutlines = new WeakMap<THREE.Mesh, THREE.Mesh>();

/** Twelve square beams, with open faces and enough vertices to follow the torus. */
export class SelectionOutlineGeometry extends THREE.BufferGeometry {
  override readonly type = 'SelectionOutlineGeometry';
  readonly parameters: { width: number; height: number; depth: number; thickness: number };

  constructor(width = 1, height = 1, depth = 1) {
    super();
    const dimensions = [width, height, depth];
    const thickness = Math.min(1 / 16, Math.min(...dimensions) / 8);
    this.parameters = { width, height, depth, thickness };
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    for (let axis = 0; axis < 3; axis++) {
      const sideA = (axis + 1) % 3;
      const sideB = (axis + 2) % 3;
      const size = [thickness, thickness, thickness];
      size[axis] = dimensions[axis];
      const segments = [1, 1, 1];
      segments[axis] = Math.max(1, Math.min(MAX_SELECTION_BEND_SEGMENTS, Math.round(dimensions[axis] * 5)));
      for (const signA of [-1, 1]) {
        for (const signB of [-1, 1]) {
          const offset = [0, 0, 0];
          offset[sideA] = signA * (dimensions[sideA] - thickness) / 2;
          offset[sideB] = signB * (dimensions[sideB] - thickness) / 2;
          const beam = new THREE.BoxGeometry(...size as [number, number, number], ...segments as [number, number, number]);
          beam.translate(...offset as [number, number, number]);
          const vertexOffset = positions.length / 3;
          positions.push(...beam.getAttribute('position').array);
          normals.push(...beam.getAttribute('normal').array);
          for (const index of beam.getIndex()!.array) indices.push(index + vertexOffset);
          beam.dispose();
        }
      }
    }
    this.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    this.setIndex(indices);
    this.computeBoundingBox();
    this.computeBoundingSphere();
  }
}

export function createSelectionOutlineMaterial(color: number, opacity = 0.95) {
  const material = new THREE.MeshStandardNodeMaterial({
    color,
    roughness: 0.8,
    metalness: 0,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    // Keep coplanar beams visible on the surface while geometry occludes them.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    fog: true,
    toneMapped: true,
  });
  // Hidden hover boxes use opacity zero and must not leave shadows behind.
  material.maskShadowNode = reference('opacity', 'float', material).greaterThan(0);
  return material;
}

/** Show hidden edges faintly while keeping visible edges at their normal opacity. */
export function createSelectionOutline(geometry: THREE.BufferGeometry, material: THREE.MeshStandardNodeMaterial) {
  let occludedMaterial = occludedMaterials.get(material);
  if (!occludedMaterial) {
    occludedMaterial = material.clone();
    // NodeMaterial.copy omits the standard material's scalar surface properties.
    occludedMaterial.roughness = material.roughness;
    occludedMaterial.metalness = material.metalness;
    occludedMaterial.depthFunc = THREE.GreaterDepth;
    occludedMaterial.color = material.color;
    occludedMaterial.opacityNode = reference('opacity', 'float', material).mul(0.3);
    const ownedMaterial = occludedMaterial;
    material.addEventListener('dispose', () => ownedMaterial.dispose());
    occludedMaterials.set(material, occludedMaterial);
  }
  const outline = new THREE.Mesh(geometry, material);
  outline.castShadow = true;
  outline.receiveShadow = true;
  const occluded = new THREE.Mesh(geometry, occludedMaterial);
  occluded.receiveShadow = true;
  occluded.name = 'OccludedSelectionOutline';
  // Draw faint edges before all the visible selection outlines (orders 23–42).
  occluded.renderOrder = 20;
  occluded.raycast = () => {};
  outline.add(occluded);
  occludedOutlines.set(outline, occluded);
  return outline;
}

/** Keep world-space beam thickness uniform when the caller scales a unit box. */
export function updateSelectionOutlineGeometry(outline: THREE.Mesh, width: number, height: number, depth: number) {
  const signature = `${width},${height},${depth}`;
  if (outline.userData.selectionOutlineSize === signature) return;
  const geometry = new SelectionOutlineGeometry(width, height, depth);
  geometry.scale(1 / width, 1 / height, 1 / depth);
  outline.geometry.dispose();
  outline.geometry = geometry;
  const occluded = occludedOutlines.get(outline);
  if (occluded) occluded.geometry = geometry;
  outline.userData.selectionOutlineSize = signature;
}

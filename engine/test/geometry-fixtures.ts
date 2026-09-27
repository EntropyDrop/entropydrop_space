import * as THREE from 'three';
import type { NumericObb } from '../src/wasm/GeometryKernels.ts';

export function geometryObb(index: number, shift = 0): NumericObb {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(index * .17, index * .37, index * .11));
  return { center: new THREE.Vector3(Math.sin(index * .7) * 2 + shift, Math.cos(index * .3), Math.sin(index * .9)),
    axes: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(axis => axis.applyQuaternion(quaternion).normalize()),
    halfExtents: [.2 + (index % 7) * .2, .3 + (index % 11) * .1, .2 + (index % 5) * .3] };
}

export function geometryCube(size = 1, angle = 0) {
  const vertices = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]].map(v => (
    new THREE.Vector3().fromArray(v).applyEuler(new THREE.Euler(angle, angle * .7, angle * .3)).toArray()
  ));
  const quads = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]];
  return quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]])
    .map(([a, b, c]) => ({ a: vertices[a] as [number, number, number], b: vertices[b] as [number, number, number], c: vertices[c] as [number, number, number] }));
}

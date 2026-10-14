/** Recompute clearance from the actual scene transforms, independently of the
 * layout's formula. Point-to-circle distances are exact; a dense angular scan
 * brackets all observed minima, then golden-section refinement resolves them.
 * Run from the workspace root: node client/tools/linked-world-clearance.ts
 */
import * as THREE from 'three';
import { TORUS_R, TORUS_RHO } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { linkedWorldTransform, LINKED_WORLD_CLEARANCE, linkedWorldPairClearance, LINKED_WORLD_ROTATION_CYCLE_SECONDS } from '../src/engine/render/LinkedWorldGeometry.ts';

const phases = [];
for (const elapsedSeconds of [0, 90, 240, 540, 720, 1080, LINKED_WORLD_ROTATION_CYCLE_SECONDS]) {
  const rings = ([0, 1, 2] as const).map(slot => {
    const transform = linkedWorldTransform(slot, elapsedSeconds);
    return {
      radius: TORUS_R,
      tube: TORUS_RHO,
      center: new THREE.Vector3().setFromMatrixPosition(transform),
      normal: new THREE.Vector3(0, 1, 0).transformDirection(transform),
      u: new THREE.Vector3(1, 0, 0).transformDirection(transform),
      v: new THREE.Vector3(0, 0, 1).transformDirection(transform),
    };
  });
  const samples = 8192, step = 2 * Math.PI / samples;
  const pairs: Array<{ worlds: number[]; centerlineMeters: number; referenceSurfaceMeters: number }> = [];
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
    const a = rings[i], b = rings[j], delta = new THREE.Vector3();
    const distance = (angle: number) => {
      delta.copy(a.center).addScaledVector(a.u, a.radius * Math.cos(angle))
        .addScaledVector(a.v, a.radius * Math.sin(angle)).sub(b.center);
      const normal = delta.dot(b.normal);
      const radial = Math.sqrt(Math.max(0, delta.lengthSq() - normal * normal));
      return Math.hypot(normal, radial - b.radius);
    };
    const distances = Array.from({ length: samples }, (_, k) => distance(k * step));
    let minimum = Math.min(...distances);
    for (let k = 0; k < samples; k++) {
      if (distances[k] > distances[(k + 1) % samples]
        || distances[k] > distances[(k + samples - 1) % samples]) continue;
      let left = (k - 1) * step, right = (k + 1) * step;
      const ratio = (Math.sqrt(5) - 1) / 2;
      let p = right - ratio * (right - left), q = left + ratio * (right - left);
      let fp = distance(p), fq = distance(q);
      for (let iteration = 0; iteration < 80; iteration++) {
        if (fp < fq) {
          right = q; q = p; fq = fp;
          p = right - ratio * (right - left); fp = distance(p);
        } else {
          left = p; p = q; fp = fq;
          q = left + ratio * (right - left); fq = distance(q);
        }
      }
      minimum = Math.min(minimum, fp, fq);
    }
    if (Math.abs(minimum - linkedWorldPairClearance(i, j, 0)) > 1e-6) throw new Error(`Unexpected clearance for rings ${i}/${j}.`);
    pairs.push({ worlds: [i, j], centerlineMeters: minimum, referenceSurfaceMeters: minimum - a.tube - b.tube });
  }
  phases.push({ elapsedSeconds, pairs });
}
console.log(JSON.stringify({ majorRadiusMeters: TORUS_R, tubeRadiusMeters: TORUS_RHO, scales: linkedWorldPairClearance, phases,
  fullHeightTerrainEnvelopeGapMeters: LINKED_WORLD_CLEARANCE.terrainEnvelope,
  scope: 'Reference-surface distances are exact for ideal tori. Terrain envelope is a conservative bound throughout rotation, not a live mesh measurement. Entities and camera-local correction are excluded.',
}, null, 2));

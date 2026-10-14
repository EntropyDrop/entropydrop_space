import * as THREE from 'three/webgpu';
import { linkedWorldTransform, linkedWorldSpinAngle } from './LinkedWorldGeometry.ts';

/** Independent snapshot links. Fixed placements preserve the chain topology;
 * local surface rotation moves frozen terrain around each ring's own axis.
 */
export class LinkedWorldRig {
  readonly group = new THREE.Group();
  readonly surfaces = [new THREE.Group(), new THREE.Group()] as const;

  constructor() {
    this.group.name = 'Chain world snapshots (read only)';
    this.surfaces.forEach((surface, index) => {
      const placement = new THREE.Group();
      placement.name = index === 0 ? 'Left chain link' : 'Right chain link';
      placement.applyMatrix4(linkedWorldTransform(index === 0 ? 1 : 2));
      placement.add(surface);
      this.group.add(placement);
    });
    this.update(0);
  }

  update(elapsedSeconds: number): void {
    this.surfaces[0].rotation.y = linkedWorldSpinAngle(0, elapsedSeconds);
    this.surfaces[1].rotation.y = linkedWorldSpinAngle(1, elapsedSeconds);
  }
}

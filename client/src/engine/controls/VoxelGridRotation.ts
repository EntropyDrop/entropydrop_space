import * as THREE from 'three';

const GRID_ALIGNED_ORIENTATIONS = (() => {
  const directions = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
  ];
  const orientations: THREE.Quaternion[] = [];
  for (const xAxis of directions) {
    for (const yAxis of directions) {
      if (Math.abs(xAxis.dot(yAxis)) > 1e-9) continue;
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
      const quaternion = new THREE.Quaternion()
        .setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
        .normalize();
      // A quaternion and its negation describe the same orientation. Keeping a
      // canonical sign makes ties deterministic and the helper easy to test.
      if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
      orientations.push(quaternion);
    }
  }
  return Object.freeze(orientations);
})();

/** Return the closest of the 24 proper rotations whose axes align to the voxel grid. */
export function nearestGridAlignedQuaternion(quaternion: any): THREE.Quaternion {
  const current = quaternion?.isQuaternion
    ? quaternion.clone().normalize()
    : new THREE.Quaternion();
  let nearest = GRID_ALIGNED_ORIENTATIONS[0];
  let nearestDot = -1;
  for (const candidate of GRID_ALIGNED_ORIENTATIONS) {
    const dot = Math.abs(current.dot(candidate));
    if (dot > nearestDot) {
      nearestDot = dot;
      nearest = candidate;
    }
  }
  return nearest.clone();
}

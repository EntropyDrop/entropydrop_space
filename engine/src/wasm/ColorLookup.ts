import * as THREE from 'three';

let lookup: Float64Array | undefined;
let enabled: boolean | undefined;

/** Use Three's own conversion; unsupported working spaces keep the JS mesher. */
export function linearSrgbLookup(): Float64Array | null {
  if (THREE.ColorManagement.workingColorSpace !== THREE.LinearSRGBColorSpace) return null;
  if (!lookup || enabled !== THREE.ColorManagement.enabled) {
    const color = new THREE.Color();
    lookup = Float64Array.from({ length: 256 }, (_, i) => color.setHex(i << 16).r);
    enabled = THREE.ColorManagement.enabled;
  }
  return lookup;
}

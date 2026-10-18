import * as THREE from 'three';
import type { Contraption } from './Contraption.ts';

/** Transfer render resources out of a runtime that is about to be disposed. */
export function detachEntityRenderProxy(entity: Contraption) {
  entity.endRenderInterpolation();
  entity.setDecorationSelection(null);
  entity.setHighlightedNode(null);
  entity.clearGlueSelection();
  entity.clearFocusHighlight();
  entity.clearSubtreeHighlight();
  entity.setHighlighted(false);
  const proxy = new THREE.Group();
  proxy.name = `CachedEntity_${entity.publicId}`;
  proxy.position.copy(entity.rootGroup.position);
  proxy.quaternion.copy(entity.rootGroup.quaternion);
  proxy.scale.copy(entity.rootGroup.scale);
  proxy.add(entity.meshGroup);
  // Picking must never treat a cached visual as a live entity, even when a
  // caller raycasts the scene rather than the manager's active collection.
  proxy.traverse(object => { object.raycast = () => {}; });
  return proxy;
}

export function disposeEntityRenderProxy(proxy: THREE.Group) {
  proxy.removeFromParent();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  proxy.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return;
    if (object instanceof THREE.InstancedMesh) object.dispose();
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  proxy.clear();
}

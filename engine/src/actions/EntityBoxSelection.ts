import type { RuntimeVoxel } from '../contraption/EntityTypes.ts';
import * as THREE from 'three';
import type { Contraption } from '../contraption/Contraption.ts';
import { blockOwnerId, toPoint } from './ActionValues.ts';

export function entityBoxMatches(contraption: Contraption, nodeId: string, pointA: unknown, pointB: unknown, space = 'node-local', microOnly = false, allComponents = false) {
  const node = contraption?.entityNodes?.get(nodeId);
  const a = toPoint(pointA);
  const b = toPoint(pointB);
  if (!node || !a || !b) return { selected: [], components: [] };
  node.group?.updateWorldMatrix?.(true, false);
  const isMicroBlock = (block: RuntimeVoxel) => (block.size || 1) < 1;
  const worldA = space === 'world' ? a.clone() : node.group.localToWorld(a.clone());
  const worldB = space === 'world' ? b.clone() : node.group.localToWorld(b.clone());

  if (allComponents) {
    const selected: RuntimeVoxel[] = [];
    const componentsSet = new Set<string>();
    const blockBounds = new THREE.Box3();

    const isWorldSpace = space === 'world';
    const baseBox = new THREE.Box3(
      new THREE.Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
      new THREE.Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z))
    );

    for (const targetNode of contraption.entityNodes.values()) {
      if (targetNode.id !== nodeId) {
        const isDescendant = typeof contraption.isEntityDescendantOf === 'function'
          ? contraption.isEntityDescendantOf(targetNode.id, nodeId)
          : (targetNode.parentId === nodeId);
        const isRoot = nodeId === (contraption.rootComponentId || 'root');
        if (!isDescendant && !isRoot) {
          continue;
        }
      }
      targetNode.group?.updateWorldMatrix?.(true, false);
      let bounds: THREE.Box3;
      if (isWorldSpace) {
        const invTarget = targetNode.group ? targetNode.group.matrixWorld.clone().invert() : new THREE.Matrix4();
        bounds = baseBox.clone().applyMatrix4(invTarget).expandByScalar(1e-6);
      } else if (targetNode.id === nodeId) {
        bounds = baseBox.clone().expandByScalar(1e-6);
      } else {
        node.group?.updateWorldMatrix?.(true, false);
        const invTarget = targetNode.group.matrixWorld.clone().invert();
        const nodeToTarget = invTarget.multiply(node.group.matrixWorld);
        bounds = baseBox.clone().applyMatrix4(nodeToTarget).expandByScalar(1e-6);
      }
      const pivot = targetNode.pivotLocal;

      const matchingMicro: RuntimeVoxel[] = [];
      const matchingStandard: RuntimeVoxel[] = [];
      for (const block of contraption.blocks) {
        if (blockOwnerId(contraption, block) !== targetNode.id) continue;
        const isMicro = isMicroBlock(block);
        const size = block.size || 1;
        blockBounds.min.set(block.localX - pivot.x, block.localY - pivot.y, block.localZ - pivot.z);
        blockBounds.max.set(block.localX + size - pivot.x, block.localY + size - pivot.y, block.localZ + size - pivot.z);
        if (blockBounds.intersectsBox(bounds)) {
          if (targetNode.id !== nodeId) {
            const overlap = blockBounds.clone().intersect(bounds);
            const dx = Math.max(0, overlap.max.x - overlap.min.x);
            const dy = Math.max(0, overlap.max.y - overlap.min.y);
            const dz = Math.max(0, overlap.max.z - overlap.min.z);
            const eps = isMicro ? 1e-4 : 1e-3;
            if (dx <= eps || dy <= eps || dz <= eps) {
              continue;
            }
          }
          if (isMicro) {
            matchingMicro.push(block);
          } else {
            matchingStandard.push(block);
          }
        }
      }
      const toAdd = (microOnly && matchingMicro.length > 0)
        ? matchingMicro
        : (microOnly ? matchingStandard : [...matchingMicro, ...matchingStandard]);
      if (toAdd.length > 0) {
        selected.push(...toAdd);
        componentsSet.add(targetNode.id);
      }
    }
    return { selected, components: Array.from(componentsSet).sort() };
  }

  const aLocal = space === 'world' ? node.group.worldToLocal(a.clone()) : a;
  const bLocal = space === 'world' ? node.group.worldToLocal(b.clone()) : b;
  const bounds = new THREE.Box3(
    new THREE.Vector3(Math.min(aLocal.x, bLocal.x), Math.min(aLocal.y, bLocal.y), Math.min(aLocal.z, bLocal.z)),
    new THREE.Vector3(Math.max(aLocal.x, bLocal.x), Math.max(aLocal.y, bLocal.y), Math.max(aLocal.z, bLocal.z))
  ).expandByScalar(1e-6);
  const pivot = node.pivotLocal;
  const blockBounds = new THREE.Box3();
  const matchingMicro: RuntimeVoxel[] = [];
  const matchingStandard: RuntimeVoxel[] = [];
  for (const block of contraption.blocks) {
    if (blockOwnerId(contraption, block) !== nodeId) continue;
    const isMicro = isMicroBlock(block);
    const size = block.size || 1;
    blockBounds.set(
      new THREE.Vector3(block.localX - pivot.x, block.localY - pivot.y, block.localZ - pivot.z),
      new THREE.Vector3(block.localX + size - pivot.x, block.localY + size - pivot.y, block.localZ + size - pivot.z)
    );
    if (blockBounds.intersectsBox(bounds)) {
      if (isMicro) {
        matchingMicro.push(block);
      } else {
        matchingStandard.push(block);
      }
    }
  }
  const selected = (microOnly && matchingMicro.length > 0)
    ? matchingMicro
    : (microOnly ? matchingStandard : [...matchingMicro, ...matchingStandard]);

  const components: string[] = [];
  if (selected.length === 0 && node.group) {
    node.group.updateWorldMatrix(true, false);
    for (const other of contraption.entityNodes.values()) {
      if (other.id === nodeId) continue;
      other.group?.updateWorldMatrix?.(true, false);
      const otherInv = other.group.matrixWorld.clone().invert();
      const nodeToOther = otherInv.multiply(node.group.matrixWorld);
      const otherBounds = bounds.clone().applyMatrix4(nodeToOther);
      const otherPivot = other.pivotLocal;
      const found = contraption.blocks.some(block => {
        if (blockOwnerId(contraption, block) !== other.id) return false;
        const size = block.size || 1;
        blockBounds.set(
          new THREE.Vector3(block.localX - otherPivot.x, block.localY - otherPivot.y, block.localZ - otherPivot.z),
          new THREE.Vector3(block.localX + size - otherPivot.x, block.localY + size - otherPivot.y, block.localZ + size - otherPivot.z)
        );
        return blockBounds.intersectsBox(otherBounds);
      });
      if (found) components.push(other.id);
    }
  }
  return { selected, components };
}

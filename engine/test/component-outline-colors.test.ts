import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '../src/contraption/Contraption.ts';
import { MAX_ENTITY_HIERARCHY_DEPTH } from '../src/constants/SpaceConstants.ts';
import { COMPONENT_OUTLINE_COLORS, componentOutlineColor, componentOutlineDepth } from '../src/render/ComponentOutlineColors.ts';

test('all 16 hierarchy levels alternate white and black, starting with a white root', () => {
  assert.equal(COMPONENT_OUTLINE_COLORS.length, MAX_ENTITY_HIERARCHY_DEPTH);
  assert.equal(new Set(COMPONENT_OUTLINE_COLORS).size, 2);
  assert.equal(COMPONENT_OUTLINE_COLORS[0], 0xffffff);
  assert.equal(COMPONENT_OUTLINE_COLORS.at(-1), 0x000000);
  COMPONENT_OUTLINE_COLORS.forEach((color, depth) => {
    assert.equal(color, depth % 2 === 0 ? 0xffffff : 0x000000);
    if (depth > 0) assert.notEqual(color, COMPONENT_OUTLINE_COLORS[depth - 1]);
  });
  const nodes = new Map([['chassis', { parentId: null as string | null }]]);
  for (let depth = 1; depth <= MAX_ENTITY_HIERARCHY_DEPTH; depth++) {
    nodes.set(`node_${depth}`, { parentId: depth === 1 ? 'chassis' : `node_${depth - 1}` });
    assert.equal(componentOutlineDepth(nodes, `node_${depth}`), depth);
    assert.equal(componentOutlineColor(nodes, `node_${depth}`), depth % 2 === 0 ? 0xffffff : 0x000000);
    assert.notEqual(componentOutlineColor(nodes, `node_${depth}`), componentOutlineColor(nodes, nodes.get(`node_${depth}`)!.parentId!));
  }
  nodes.set('cycle', { parentId: 'cycle' });
  assert.equal(componentOutlineDepth(nodes, 'cycle'), MAX_ENTITY_HIERARCHY_DEPTH);
  assert.equal(componentOutlineColor(undefined, 'missing'), COMPONENT_OUTLINE_COLORS[0]);
});

test('all component depths keep their colors across subtree focus, block selection and pulses', () => {
  const ids = Array.from({ length: MAX_ENTITY_HIERARCHY_DEPTH }, (_, depth) => depth ? `node_${depth}` : 'chassis');
  const entity = new Contraption(1, ids.map((id, depth) => ({
    localX: depth, localY: 0, localZ: 0, block: 1, entityId: id
  })), new THREE.Vector3(0, 10, 0), new THREE.Scene(), {
    rootComponentId: ids[0],
    childEntities: ids.slice(1).map((id, index) => ({ id, parentId: ids[index], pivot: [index + 1, 0, 0] }))
  });
  try {
    entity.stopAllNodeScripts();
    entity.setFocusHighlight(ids[0]);
    assert.equal(entity.focusHighlightMaterials?.size, MAX_ENTITY_HIERARCHY_DEPTH);
    const originalColors = new Map(entity.focusHighlightEntries.map(entry => [entry.ownerNode.id,
      ((entry.container.children[0] as THREE.Mesh).material as THREE.MeshStandardNodeMaterial).color.getHex()]));
    ids.forEach((id, depth) => assert.equal(originalColors.get(id), COMPONENT_OUTLINE_COLORS[depth]));

    entity.setFocusHighlight(ids[4]);
    entity.updateGlueSelectionPulse();
    for (const entry of entity.focusHighlightEntries) {
      const material = (entry.container.children[0] as THREE.Mesh).material as THREE.MeshStandardNodeMaterial;
      assert.equal(material.color.getHex(), originalColors.get(entry.ownerNode.id), 'focusing deeper must not recolor descendants');
    }

    for (const depth of [8, 9]) {
      const expected = depth % 2 === 0 ? 0xffffff : 0x000000;
      const selected = entity.blocks.find(block => block.entityId === ids[depth])!;
      entity.highlightBlocks([selected]);
      assert.equal(entity.subtreeHighlightBoxes[0].materials.lineMat.color.getHex(), expected);
      entity.setHighlightedNode(ids[depth]);
      assert.equal(entity.nodeHighlightMaterials?.lineMat.color.getHex(), expected);
      entity.setGlueSelection(ids[depth], [`${depth},0,0`]);
      assert.equal(entity.glueHighlightMaterials?.selectedLine.color.getHex(), expected);
    }
  } finally { entity.dispose(); }
});

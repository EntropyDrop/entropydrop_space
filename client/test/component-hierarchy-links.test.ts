import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

for (const tool of [SpecialTool.SELECTOR, SpecialTool.SHOVEL, SpecialTool.SPOON, SpecialTool.WRENCH]) {
  test(`${tool} focus animates parent and child waves at the rendered component pivots`, () => {
    const scene = new THREE.Scene();
    const entity = new Contraption(1, [
      { localX: 0, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'arm' },
      { localX: -2, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'wing' },
      { localX: 4, localY: 0, localZ: 0, size: 1, block: 1, entityId: 'hand' },
    ], new THREE.Vector3(10, 20, 30), scene, { rootComponentId: 'root', childEntities: [
      { id: 'arm', parentId: 'root', pivot: [2, 1, 0] },
      { id: 'wing', parentId: 'root', pivot: [-2, 1, 0] },
      { id: 'hand', parentId: 'arm', pivot: [4, 1, 0] },
    ] });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(5, 10, 15);
    const renderer: any = Object.assign(Object.create(SceneRenderer.prototype), { scene, camera });
    const controller: any = Object.assign(Object.create(PlayerController.prototype), {
      sceneRenderer: renderer, contraptions: { contraptions: [entity] }, isLocked: false,
      clearHammerRotation() {}, clearSelection() {}, releaseWrenchGizmoDrag() {},
      releaseWrenchGrab() {}, clearWrenchPivotDisplay() {},
    });
    controller._activeTool = tool;
    const focus = (entityId?: string) => {
      controller.hoveredContraptionHit = { contraption: entity, entityId };
      controller.updateComponentHierarchyLinks();
    };
    const pivot = (id: string) => entity.getEntityNode(id)!.group.getWorldPosition(new THREE.Vector3());
    try {
      entity.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
      entity.updateTransform();
      // Seed the renderer's straight-line fallback to verify focus replaces it.
      renderer.setComponentHierarchyLinks(entity, 'root');
      const lines = renderer.componentHierarchyLinks.lines as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicNodeMaterial>;
      focus('root');
      const childLinks = () => (renderer.componentChildLinks || []).filter((link: { group: THREE.Group }) => link.group.visible);
      const childLinkCount = () => childLinks().length;
      const assertWaveLink = (group: THREE.Group, child: string, parent: string) => {
        assert.equal(group.visible, true);
        const wave = group.getObjectByName('OwnershipWave') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
        assert.equal(wave.material.color.getHex(), 0xffdc73);
        const buffer = wave.geometry.getAttribute('position');
        const ringCenter = (start: number) => {
          const sum = new THREE.Vector3();
          for (let i = 0; i < 6; i++) sum.add(new THREE.Vector3().fromBufferAttribute(buffer, start + i));
          return group.localToWorld(sum.divideScalar(6));
        };
        assert.ok(ringCenter(0).distanceTo(pivot(child)) < 1e-6);
        assert.ok(ringCenter(buffer.count - 6).distanceTo(pivot(parent)) < 1e-6);
        assert.ok(group.getObjectByName('OwnerPivot')!.getWorldPosition(new THREE.Vector3()).distanceTo(pivot(parent)) < 1e-6);
      };
      const assertLink = (index: number, child: string, parent: string) => {
        assertWaveLink(childLinks()[index].group, child, parent);
      };
      assert.equal(lines.visible, false, 'every white child line is replaced with a wave');
      assert.equal(childLinkCount(), 2, 'focus works without clicking or locking the pointer');
      assert.equal(lines.material.color.getHex(), 0xffffff);
      assert.equal(lines.material.depthTest, false);
      assertLink(0, 'arm', 'root');
      assertLink(1, 'wing', 'root');
      renderer.setComponentHierarchyLinks(entity, 'root', { animateChildren: true, seconds: 0 });
      const buffers = childLinks().map((link: { group: THREE.Group }) =>
        (link.group.getObjectByName('OwnershipWave') as THREE.Mesh).geometry.getAttribute('position'));
      const firstFrames = buffers.map((buffer: THREE.BufferAttribute) => Array.from(buffer.array));
      renderer.setComponentHierarchyLinks(entity, 'root', { animateChildren: true, seconds: 0.2 });
      for (let index = 0; index < buffers.length; index++) {
        assert.equal((childLinks()[index].group.getObjectByName('OwnershipWave') as THREE.Mesh).geometry.getAttribute('position'), buffers[index]);
        assert.notDeepEqual(Array.from(buffers[index].array), firstFrames[index], 'each child wave animates in its reused buffer');
      }
      controller.activeTool = tool === SpecialTool.SELECTOR ? SpecialTool.WRENCH : SpecialTool.SELECTOR;
      controller.updateComponentHierarchyLinks();
      assert.equal(lines.visible, false, 'switching between inspection tools keeps the same wave style');
      assert.equal(childLinks().length, 2);
      controller.activeTool = tool;
      controller.updateComponentHierarchyLinks();
      entity.getEntityNode('root')!.group.position.add(new THREE.Vector3(1, 2, 3));
      entity.getEntityNode('arm')!.group.position.add(new THREE.Vector3(0, 1, 0));
      controller.updateComponentHierarchyLinks();
      assert.equal((childLinks()[0].group.getObjectByName('OwnershipWave') as THREE.Mesh).geometry.getAttribute('position'), buffers[0],
        'moving components and switching tools reuse the wave buffer');
      assertLink(0, 'arm', 'root');
      assertLink(1, 'wing', 'root');
      focus('arm');
      assert.equal(childLinkCount(), 1, 'only the direct child is linked, with unused waves hidden');
      assertLink(0, 'hand', 'arm');
      const parentLink = renderer.componentParentLink.group as THREE.Group;
      const wave = parentLink.getObjectByName('OwnershipWave') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
      const wavePositions = wave.geometry.getAttribute('position');
      const assertParentLink = (child: string, parent: string) => {
        assertWaveLink(parentLink, child, parent);
      };
      assert.equal(wave.material.color.getHex(), 0xffdc73);
      renderer.setComponentHierarchyLinks(entity, 'arm', { animateChildren: true, seconds: 0 });
      const firstFrame = Array.from(wavePositions.array);
      renderer.setComponentHierarchyLinks(entity, 'arm', { animateChildren: true, seconds: 0.2 });
      assert.equal(wave.geometry.getAttribute('position'), wavePositions, 'animation reuses the wave buffer');
      assert.notDeepEqual(Array.from(wavePositions.array), firstFrame, 'the parent wave animates between frames');
      assertParentLink('arm', 'root');
      focus('hand');
      assert.equal(lines.visible, false, 'a leaf has no direct child lines');
      assert.equal(childLinkCount(), 0, 'a leaf has no child waves');
      assert.equal(lines.geometry.drawRange.count, 0, 'grandparents and siblings are not linked');
      assertParentLink('hand', 'arm');
      entity.getEntityNode('arm')!.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
      controller.updateComponentHierarchyLinks();
      assertParentLink('hand', 'arm');
      focus('removed-node');
      assert.equal(lines.visible, false, 'a removed component leaves no stale parent link');
      assert.equal(parentLink.visible, false);
      focus();
      assert.equal(childLinkCount(), 2, 'missing hit node defaults to root');
      assert.equal(parentLink.visible, false, 'root focus hides the previous parent wave');
      entity.serverCanEdit = false;
      controller.updateComponentHierarchyLinks();
      assert.equal(childLinkCount(), 2, 'read-only entities can be inspected');
      controller.hoveredContraptionHit = null;
      controller.updateComponentHierarchyLinks();
      assert.equal(lines.visible, false, 'losing focus hides the links');
      assert.equal(childLinks().length, 0);
      focus('arm');
      controller.worldPickingSuspended = true;
      controller.updateComponentHierarchyLinks();
      assert.equal(lines.visible, false);
      assert.equal(parentLink.visible, false);
      assert.equal(childLinks().length, 0);
      controller.worldPickingSuspended = false;
      focus('arm');
      controller.activeTool = SpecialTool.HAMMER;
      assert.equal(lines.visible, false, 'switching tools hides links immediately');
      assert.equal(parentLink.visible, false);
      assert.equal(childLinks().length, 0);
      controller.updateComponentHierarchyLinks();
      assert.equal(lines.visible, false, 'unrelated tools do not show hierarchy links');
      controller._activeTool = tool;
      focus('arm');
      controller.contraptions.contraptions = [];
      controller.updateComponentHierarchyLinks();
      assert.equal(lines.visible, false, 'removed entities leave no stale links');
      assert.equal(parentLink.visible, false);
      assert.equal(childLinks().length, 0);
    } finally {
      renderer.componentHierarchyLinks?.dispose();
      renderer.componentParentLink?.dispose();
      for (const link of renderer.componentChildLinks || []) link.dispose();
      entity.dispose();
    }
  });
}

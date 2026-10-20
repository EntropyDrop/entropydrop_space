import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { BlockTypes } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { ModelingTool } from '../src/engine/controls/ModelingTool.ts';
import { SceneRenderer } from '../src/engine/render/SceneRenderer.ts';

function makeHoverController(tool: string, micro: boolean) {
  const entity = new Contraption(1, [
    { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
    { localX: 0, localY: 1, localZ: 0, block: BlockTypes.COLOR_BLOCK }
  ], new THREE.Vector3(0, 10, 0), new THREE.Scene(), {
    childEntities: [{ id: 'arm', parentId: 'root', kind: 'child', pivot: [0, 1, 0], blockKeys: [['0', '1', '0']] }]
  });
  entity.stopAllNodeScripts();
  const hit = {
    contraption: entity, entityId: 'arm', block: entity.blocks[1],
    cell: { x: 0, y: 1, z: 0 }, point: new THREE.Vector3(0.5, 11.5, 0.5),
    kind: 'standard'
  };
  const controller: any = Object.create(PlayerController.prototype);
  Object.assign(controller, {
    activeTool: tool,
    selectorMicroMode: micro, brushMicroMode: micro,
    hoveredContraption: entity,
    hoveredContraptionHit: hit,
    contraptions: { hasChildSelection: () => false, selectionCornerA: null, selectionCornerB: null },
    syncDrivenVehiclePose() {}, updateCameraPosition() {},
    updateWrenchPivotGizmo() {}, updateInventoryPlacementPreview() {}, updateSelectionAxisGizmo() {},
    performAimRaycast: () => ({
      kind: 'entity', entityHit: hit,
      worldHit: { hit: true, kind: 'standard', hitPos: { x: 0, y: 0, z: 0 } }
    })
  });
  return { controller, entity, hit };
}

const runStates = {
  scripts(entity: Contraption) { entity.scriptStatus = 'running'; },
  physics(entity: Contraption) { entity.setPhysicsSimulationEnabled(true); },
  server(entity: Contraption) {
    entity.serverManaged = true;
    entity.serverCanEdit = true;
    entity.serverDesiredRunState = 'running';
  }
};

for (const tool of new Set(Object.values(SpecialTool))) {
  for (const micro of [false, true]) {
    for (const [state, start] of Object.entries(runStates)) {
      test(`${tool} has no entity hover boxes while ${state} runs (${micro ? 'micro' : 'standard'})`, () => {
        const { controller, entity, hit } = makeHoverController(tool, micro);
        entity.setHighlighted(true);
        entity.setFocusHighlight('root');
        assert.ok(entity.focusHighlightEntries.length > 1, 'the previous hover includes child bounds');
        controller.microCarvePreview = { stale: true };
        controller.focusBlockPreview = { stale: true };
        controller.boxSelectionPreview = { stale: true };
        start(entity);

        controller.updateAimRaycast();

        assert.equal(controller.hoveredContraptionHit, hit, 'tool interactions retain the exact entity hit');
        assert.equal(entity.isHighlighted, false);
        assert.equal(entity.highlightBox?.material.opacity, 0);
        assert.equal(entity.focusedHighlightNodeId, null);
        assert.equal(entity.focusHighlightEntries.length, 0);
        assert.equal(controller.getCursorHighlight(), null, 'the terrain behind the entity must not produce a cursor');
        assert.equal(controller.microCarvePreview, null);
        assert.equal(controller.focusBlockPreview, null);
        assert.equal(controller.boxSelectionPreview, null);

        entity.serverDesiredRunState = 'stopped';
        entity.stopAllNodeScripts();
        controller.updateAimRaycast();

        assert.equal(entity.isHighlighted, ![SpecialTool.SELECTOR, SpecialTool.WRENCH, SpecialTool.MODELING].includes(tool));
        assert.equal(entity.focusedHighlightNodeId,
          [SpecialTool.BRUSH, SpecialTool.WRENCH, SpecialTool.MODELING].includes(tool) ? null : 'arm');
        assert.equal(!!controller.getCursorHighlight(), ![SpecialTool.MODELING, SpecialTool.HAMMER].includes(tool));
        assert.equal(!!controller.microCarvePreview, tool === SpecialTool.SPOON);
        assert.equal(!!controller.focusBlockPreview, tool === SpecialTool.BRUSH);
      });
    }
  }
}

test('a pending world selection does not draw a preview over a running entity', () => {
  const { controller, entity } = makeHoverController(SpecialTool.SELECTOR, false);
  controller.contraptions.selectionCornerA = { x: 2, y: 3, z: 4 };
  entity.setPhysicsSimulationEnabled(true);
  controller.updateMicroCarvePreview();
  assert.equal(controller.boxSelectionPreview, null);
});

function makeGizmoController(tool: string, micro = false) {
  const fixture = makeHoverController(tool, micro);
  const { controller, entity } = fixture;
  delete controller.updateWrenchPivotGizmo;
  delete controller.updateSelectionAxisGizmo;
  controller.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  controller.camera.position.copy(entity.position).add(new THREE.Vector3(0, 0, 5));
  controller.camera.lookAt(entity.position);
  controller.physics = { getEyePosition: () => controller.camera.position.clone() };
  controller.contraptions.contraptions = [entity];
  const renderer: any = Object.create(SceneRenderer.prototype);
  renderer.scene = entity.scene;
  controller.sceneRenderer = renderer;
  return { ...fixture, renderer };
}

for (const [state, start] of Object.entries(runStates)) {
  for (const locked of [false, true]) {
    for (const refresh of ['aim', 'retained target', 'pointer', 'render']) {
      test(`Wrench hides XYZ and rotation handles when ${state} starts (${refresh}, locked=${locked})`, () => {
        const { controller, entity, hit, renderer } = makeGizmoController(SpecialTool.WRENCH);
        controller.isLocked = locked;
        controller.updateWrenchPivotGizmo(hit);
        assert.equal(renderer.wrenchPivotGizmo.visible, true);
        controller.hoveredWrenchGizmoHandle = { handleKey: 'rotate-x' };
        start(entity);
        const raycast = renderer.raycastWrenchPivotGizmoBent.bind(renderer);
        renderer.raycastWrenchPivotGizmoBent = () => assert.fail('running entities must not pick cached handles');

        if (refresh === 'aim') controller.updateWrenchPivotGizmo(hit);
        if (refresh === 'retained target') controller.updateWrenchPivotGizmo(null);
        if (refresh === 'pointer') controller.updateWrenchGizmoPointerHover({ clientX: 0, clientY: 0 });
        if (refresh === 'render') controller.renderWrenchPivotTarget();

        assert.equal(renderer.wrenchPivotGizmo.visible, false);
        assert.equal(controller.wrenchPivotTarget, null);
        assert.equal(controller.hoveredWrenchGizmoHandle, null);
        assert.equal(raycast(controller.camera.position, new THREE.Vector3(0, 0, -1)), null);
        assert.equal(controller.isEntityRunning(entity), true, 'hiding the handles must not stop playback');

        renderer.raycastWrenchPivotGizmoBent = raycast;
        entity.serverDesiredRunState = 'stopped';
        entity.stopAllNodeScripts();
        controller.updateWrenchPivotGizmo(hit);
        assert.equal(renderer.wrenchPivotGizmo.visible, true);
        renderer.wrenchTransformGizmo.dispose();
      });
    }
  }

  for (const micro of [false, true]) {
    for (const selection of ['blocks', 'subtree']) {
      test(`Selector hides cached ${selection} axes when ${state} starts (micro=${micro})`, () => {
        const { controller, entity, renderer } = makeGizmoController(SpecialTool.SELECTOR, micro);
        if (selection === 'blocks') controller.selectedBlockSelection = {
          contraption: entity, nodeId: 'arm', blocks: [entity.blocks[1]]
        };
        else controller.selectedSubtree = { contraption: entity, rootId: 'arm', nodeIds: new Set(['arm']) };
        controller.updateSelectionAxisGizmo();
        assert.equal(renderer.selectionAxisGizmo.visible, true);
        controller.hoveredGizmoHandle = { handleKey: 'x+' };
        start(entity);

        controller.updateSelectionAxisGizmo();

        assert.equal(renderer.selectionAxisGizmo.visible, false);
        assert.equal(controller.hoveredGizmoHandle, null);
        assert.equal(controller.isEntityRunning(entity), true);
        entity.serverDesiredRunState = 'stopped';
        entity.stopAllNodeScripts();
        controller.updateSelectionAxisGizmo();
        assert.equal(renderer.selectionAxisGizmo.visible, true);
      });
    }
  }

  test(`Modeling hides XYZ and rotation handles when ${state} starts`, () => {
    const { controller, entity, renderer } = makeGizmoController(SpecialTool.MODELING);
    entity.setComponentDecorations('arm', [{ id: 'cube', color: 0xff0000 }]);
    const modeling = new ModelingTool(controller);
    modeling.selected = { contraption: entity, componentId: 'arm', decorationId: 'cube' };
    modeling.update({});
    assert.equal(renderer.modelingGizmo.visible, true);
    start(entity);

    modeling.update({});

    assert.equal(renderer.modelingGizmo.visible, false);
    assert.equal(controller.isEntityRunning(entity), true);
    entity.serverDesiredRunState = 'stopped';
    entity.stopAllNodeScripts();
    modeling.update({});
    assert.equal(renderer.modelingGizmo.visible, true);
    modeling.deactivate();
  });
}

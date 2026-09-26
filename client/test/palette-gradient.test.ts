import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerController } from '../src/engine/controls/PlayerController.ts';


function controllerHarness() {
  const controller: any = Object.create(PlayerController.prototype);
  controller.bulkEditJob = null;
  controller.selectedColor = 0x000000;
  controller.selectedMaterialId = 1;
  controller.selectedGradientStops = [
    { color: '#000000', position: 0 },
    { color: '#ffffff', position: 1 },
  ];
  controller.sound = { playBlockPlace() {} };
  controller.ui = { showToast() {}, updateToolPanelMode() {} };
  controller.world = {};
  controller.selectedSubtree = null;
  controller.selectorMicroMode = false;
  controller.requireConfirmedSelection = () => true;
  controller.materializeMicroSelection = () => true;
  controller.updateSelectionAxisGizmo = () => {};
  return controller;
}

test('world A/B fill samples a linear gradient and applies the palette material', () => {
  const controller = controllerHarness();
  const commands: any[] = [];
  const manager: any = {
    selectionBoxConfirmed: true,
    selectionCornerA: { x: 0, y: 0, z: 0 },
    selectionCornerB: { x: 2, y: 0, z: 0 },
    connectedSelection: null,
    microSelection: null,
    microBounds: null,
    hasValidSelection: () => true,
    getSelectionBounds: () => ({ minX: 0, maxX: 2, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }),
    clearSelection() {},
  };
  controller.contraptions = manager;
  controller.performBasicAction = (command: any) => {
    commands.push(command);
    return { ok: true, placed: 1 };
  };
  controller.startBulkEditJob = ({ total, step, finish }: any) => {
    for (let index = 0; index < total; index += 1) step(index);
    finish();
    return true;
  };

  controller.fillSelectionBlocks();

  assert.deepEqual(commands.map(command => command.color), [0x000000, 0x808080, 0xffffff]);
  assert.deepEqual(commands.map(command => command.options.materialId), [1, 1, 1]);
});

test('entity A/B paint uses a gradient while select-all uses only its first stop', () => {
  const makeSelection = (gradientEligible: boolean) => {
    const controller = controllerHarness();
    const commands: any[] = [];
    const blocks = [0, 1, 2].map(localX => ({ localX, localY: 0, localZ: 0, size: 1, color: 0x123456 }));
    const contraption = {
      entityNodes: new Map([['root', { pivotLocal: { x: 0, y: 0, z: 0 } }]]),
      clearSubtreeHighlight() {},
    };
    controller.contraptions = {};
    controller.selectedBlockSelection = {
      contraption,
      nodeId: 'root',
      blocks,
      gradientEligible,
      confirmedRange: {
        pointA: { x: 0.5, y: 0.5, z: 0.5 },
        pointB: { x: 2.5, y: 0.5, z: 0.5 },
      },
    };
    controller.performBasicAction = (command: any) => {
      commands.push(command);
      return { ok: true, painted: blocks.length };
    };
    controller.paintSelectionBlocks();
    return commands[0];
  };

  const boxCommand = makeSelection(true);
  assert.deepEqual(boxCommand.colors, [0x000000, 0x808080, 0xffffff]);
  assert.equal(boxCommand.options.materialId, 1);

  const selectAllCommand = makeSelection(false);
  assert.equal(selectAllCommand.colors, undefined);
  assert.equal(selectAllCommand.color, 0x000000);
  assert.equal(selectAllCommand.options.materialId, 1);
});

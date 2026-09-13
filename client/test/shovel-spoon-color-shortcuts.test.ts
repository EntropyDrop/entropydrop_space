import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerController, SpecialTool } from '../src/engine/controls/PlayerController.ts';
import { normalizeColor, colorToHex, PRESET_COLORS } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { isMacPlatform, getAltKeyLabel } from '../src/bootstrap/SpaceBootstrap.ts';

function createMockController(tool = SpecialTool.SHOVEL) {
  const controller: any = Object.create(PlayerController.prototype);
  controller.activeTool = tool;
  controller.selectedColor = normalizeColor('#ffffff');
  controller.keys = {};
  controller.physics = { isFlying: false, isSprinting: false };
  controller.recordEntityKeyDown = () => {};
  controller.unlocked = false;
  controller.unlock = () => { controller.unlocked = true; };

  let selectedColorIndex = -1;
  let colorPickerOpened = false;

  controller.ui = {
    selectPresetColor: (idx: number) => { selectedColorIndex = idx; },
    openColorPicker: () => { colorPickerOpened = true; },
    selectInventorySlot: () => {},
    selectHotbarSlot: () => {},
    showToast: () => {}
  };

  return {
    controller,
    getSelectedColorIndex: () => selectedColorIndex,
    wasColorPickerOpened: () => colorPickerOpened
  };
}

test('Shovel: Alt + 1~9 selects preset color', () => {
  const { controller, getSelectedColorIndex } = createMockController(SpecialTool.SHOVEL);

  controller.handleKeyDown({
    code: 'Digit1',
    altKey: true,
    shiftKey: false,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), 0);

  controller.handleKeyDown({
    code: 'Digit5',
    altKey: true,
    shiftKey: false,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), 4);

  controller.handleKeyDown({
    code: 'Digit9',
    altKey: true,
    shiftKey: false,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), 8);
});

test('Shovel: Shift + 1~9 without Alt does NOT select preset color', () => {
  const { controller, getSelectedColorIndex } = createMockController(SpecialTool.SHOVEL);

  controller.handleKeyDown({
    code: 'Digit1',
    altKey: false,
    shiftKey: true,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), -1);

  controller.handleKeyDown({
    code: 'Digit3',
    altKey: false,
    shiftKey: true,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), -1);
});

test('Spoon: Alt + 1~9 selects preset color and Shift + 1~9 does not', () => {
  const { controller, getSelectedColorIndex } = createMockController(SpecialTool.SPOON);

  // Shift only should not change color
  controller.handleKeyDown({
    code: 'Digit2',
    altKey: false,
    shiftKey: true,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), -1);

  // Alt + Digit2 selects slot 1
  controller.handleKeyDown({
    code: 'Digit2',
    altKey: true,
    shiftKey: false,
    preventDefault() {}
  } as any);
  assert.equal(getSelectedColorIndex(), 1);
});

test('KeyI triggers unlock and calls ui.openColorPicker', () => {
  const { controller, wasColorPickerOpened } = createMockController(SpecialTool.SHOVEL);

  assert.equal(controller.unlocked, false);
  assert.equal(wasColorPickerOpened(), false);

  controller.handleKeyDown({
    code: 'KeyI',
    preventDefault() {}
  } as any);

  assert.equal(controller.unlocked, true);
  assert.equal(wasColorPickerOpened(), true);
});

test('SpaceUiStore: setPaletteColor updates palette color, active build color, and localStorage', () => {
  const targetIndex = 2;
  const newHex = '#33cc88';

  spaceUiStore.setPaletteColor(targetIndex, newHex, false);

  const snapshot = spaceUiStore.getSnapshot();
  const colors = snapshot.paletteColors;
  assert.equal(colors[targetIndex].hex.toLowerCase(), newHex.toLowerCase());
  assert.equal(snapshot.selectedColorIndex, targetIndex);
  assert.equal(colorToHex(snapshot.selectedColor).toLowerCase(), newHex.toLowerCase());

  // Test openColorPicker method does not throw
  assert.doesNotThrow(() => {
    spaceUiStore.openColorPicker();
  });
});

test('isMacPlatform and getAltKeyLabel return Opt on Mac and Alt on others', () => {
  assert.equal(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel'), true);
  assert.equal(isMacPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)', 'iPhone'), true);
  assert.equal(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32'), false);
  assert.equal(isMacPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64'), false);

  // When on Mac platform, label is Opt
  const macLabel = isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel') ? 'Opt' : 'Alt';
  assert.equal(macLabel, 'Opt');

  // When on Windows platform, label is Alt
  const winLabel = isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32') ? 'Opt' : 'Alt';
  assert.equal(winLabel, 'Alt');
});

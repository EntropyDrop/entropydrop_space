import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { compareComponentIds } from '@entropydrop/space-engine/contraption/Contraption.ts';

const COMPONENT_FILES = [
  '../src/ui/react/SpaceRoot.tsx',
  '../src/ui/react/components/Hud.tsx',
  '../src/ui/react/components/WorldWidgets.tsx',
  '../src/ui/react/components/SimpleModals.tsx',
  '../src/ui/react/components/InventoryModal.tsx',
  '../src/ui/react/components/EditorModal.tsx'
];

const componentSource = COMPONENT_FILES
  .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n');

const REQUIRED_UI_IDS = [
  'canvas-container', 'crosshair', 'hud-overlay', 'fps-val', 'ping-val', 'pos-val',
  'hud-entities-list', 'home-btn', 'global-settings-btn', 'color-palette-bar', 'inventory-bar',
  'selector-panel-wrapper', 'hotbar', 'toast', 'code-editor-modal',
  'global-playback-group', 'component-tree-list', 'component-inspector-panel',
  'inspector-tab-defaults', 'inspector-tab-runtime',
  'prop-node-anchor-quaternion', 'prop-node-local-quaternion', 'prop-node-world-quaternion',
  'runtime-body-quaternion', 'entity-authority-grid',
  'code-tab-bar', 'script-textarea', 'entity-preview-canvas', 'tele-console-logs',
  'agent-chat-box', 'inventory-modal',
  'inventory-grid', 'api-docs-modal', 'api-docs-body', 'global-settings-modal',
  'pause-screen', 'start-btn', 'minimap-container', 'nav-system-container', 'nav-start-btn'
];

test('React components own every stable game UI contract', () => {
  for (const id of REQUIRED_UI_IDS) {
    assert.match(componentSource, new RegExp(`id=[{]?['\"]${id}['\"]`), `missing React UI contract #${id}`);
  }
  assert.doesNotMatch(componentSource, /getElementById|querySelector|\.innerHTML\s*=|createElement\(/);
});

test('legacy UIManager is removed and the engine uses the DOM-free store', () => {
  const managerUrl = new URL('../src/ui/UIManager.ts', import.meta.url);
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const storeSource = readFileSync(new URL('../src/ui/react/store/SpaceUiStore.ts', import.meta.url), 'utf8');
  assert.equal(existsSync(managerUrl), false);
  assert.doesNotMatch(mainSource, /UIManager|uiManager/);
  assert.match(mainSource, /spaceUiStore/);
  assert.doesNotMatch(storeSource, /getElementById|querySelector|\.innerHTML\s*=|createElement\(/);
});

test('index.html contains only the auth gate and React host', () => {
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(indexHtml, /id="space-entry-gate"/);
  assert.match(indexHtml, /id="space-entry-progress"[^>]*role="progressbar"/s);
  assert.match(indexHtml, /aria-valuemin="0"/);
  assert.match(indexHtml, /aria-valuemax="100"/);
  assert.match(indexHtml, /id="space-react-root"/);
  assert.doesNotMatch(indexHtml, /id="canvas-container"|id="hud-overlay"|id="pause-screen"|id="inventory-modal"/);
});

test('Space entry progress follows real bootstrap stages and exposes percentage state', () => {
  const bootstrapSource = readFileSync(new URL('../src/bootstrap/SpaceBootstrap.ts', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const styleSource = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(bootstrapSource, /prepareOnlineSpace\(reportProgress\)/);
  assert.match(bootstrapSource, /completeOnlineSpace\(prepared, reportProgress\)/);
  assert.match(bootstrapSource, /progress\.setAttribute\('aria-valuenow'/);
  assert.match(bootstrapSource, /progressFill\.style\.width/);
  assert.match(mainSource, /await game\.preloadInitialTerrain\(reportProgress\)/);
  assert.match(mainSource, /game\.start\(\)/);
  assert.match(styleSource, /\.space-entry-progress-fill/);
  assert.match(styleSource, /prefers-reduced-motion/);
});

test('global settings remains English-only', () => {
  const settingsSource = readFileSync(
    new URL('../src/ui/react/components/SimpleModals.tsx', import.meta.url),
    'utf8',
  );
  assert.match(settingsSource, /\['earth', 'Earth Mode'\]/);
  assert.match(settingsSource, /\['torus', 'Donut Mode'\]/);
  assert.match(settingsSource, />PERFORMANCE</);
  assert.match(settingsSource, /id="setting-shadows-group"/);
  assert.match(settingsSource, /id="setting-minimap-group"/);
  assert.match(settingsSource, /id="setting-music-group"/);
  assert.match(settingsSource, /id="setting-effects-group"/);
  assert.match(settingsSource, />Background Music</);
  assert.match(settingsSource, />Sound Effects</);
  assert.doesNotMatch(settingsSource, /setting-mute-group|>Mute Audio</);
  assert.match(settingsSource, /may reduce performance while moving/);
  assert.match(settingsSource, /Set as My Skin/);
  assert.match(settingsSource, /href="\/skin\/collection"/);
  assert.match(settingsSource, /href="\/skin\/generate"/);
  assert.doesNotMatch(settingsSource, /Entity Gravity|setting-gravity-group|setGravity/);
  assert.doesNotMatch(settingsSource, /[\u3400-\u9fff]/);
});

test('React mounts synchronously before Game construction', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const mountIndex = mainSource.indexOf('mountSpaceUi();');
  const gameClassIndex = mainSource.indexOf('class Game');
  assert.ok(mountIndex >= 0 && mountIndex < gameClassIndex);
});

test('component-facing UI uses the shared ASCII id order', () => {
  assert.deepEqual(
    ['z', 'root', 'a', 'B'].sort(compareComponentIds),
    ['B', 'a', 'root', 'z']
  );

  const editorSource = readFileSync(
    new URL('../src/ui/react/components/EditorModal.tsx', import.meta.url),
    'utf8'
  );
  const storeSource = readFileSync(
    new URL('../src/ui/react/store/SpaceUiStore.ts', import.meta.url),
    'utf8'
  );
  assert.match(
    editorSource,
    /const nodes =[\s\S]{0,240}compareComponentIds/,
    'code tabs must sort entity node values explicitly'
  );
  assert.match(
    editorSource,
    /const childIds = nodes[\s\S]{0,320}\.sort\(compareComponentIds\)/,
    'the runtime title must sort child ids explicitly'
  );
  assert.match(
    storeSource,
    /allComponents:[^\n]*\.sort\(compareComponentIds\)/,
    'Agent component context must not expose Map insertion order'
  );
});

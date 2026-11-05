import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';
import { uiStub } from './fixtures.ts';
import { DistantSurfaceLayer, normalizeDistantSurfaceSettings } from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { DEFAULT_VOXEL_TEXTURE_BAKE } from '@entropydrop/space-engine/render/VoxelTextureBake.ts';

function settingsFixture(t: test.TestContext) {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  let enabled = true;
  const calls: boolean[] = [];
  const world = uiStub('world', {
    renderDistance: 8,
    distantSurface: { isEnabled: () => enabled },
    setDistantSurfaceEnabled(value: boolean) { calls.push(value); return enabled = value; },
  });
  const store = new SpaceUiStore();
  const toasts: string[] = [];
  t.mock.method(store, 'showToast', (message: string) => { toasts.push(message); });
  store.setWorld(world);
  return { store, world, values, calls, toasts };
}

test('the master switch applies immediately, persists and survives renderer setup and reload', t => {
  const { store, world, values } = settingsFixture(t);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  store.setDistantSurfaceEnabled(false);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'false');
  store.setSceneRenderer(uiStub('sceneRenderer', {}));
  assert.equal(store.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(world.distantSurface.isEnabled(), false);

  const restored = new SpaceUiStore();
  restored.setWorld(world);
  restored.setSceneRenderer(uiStub('sceneRenderer', {}));
  assert.equal(restored.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(world.distantSurface.isEnabled(), false);
  restored.setDistantSurfaceEnabled(true);
  assert.equal(world.distantSurface.isEnabled(), true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
});

test('the master switch saves the far layer choice without changing near distance or resolution', t => {
  const { store, world, values, calls, toasts } = settingsFixture(t);
  store.setResolutionScale('0.5', false);
  store.setDistantSurfaceEnabled(false);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, false);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'false');
  assert.equal(store.getSnapshot().renderDistance, 8);
  assert.equal(store.getSnapshot().resolutionScaleMode, '0.5');
  assert.deepEqual(calls, [true, false]);
  assert.equal(toasts.length, 0);

  store.setDistantSurfaceEnabled(true);
  assert.equal(world.distantSurface.isEnabled(), true);
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(toasts.length, 0);
});

test('resetting recommended settings restores the master switch', t => {
  const { store, values } = settingsFixture(t);
  store.setDistantSurfaceEnabled(false);
  store.resetDistantSurfaceSettings();
  assert.equal(store.getSnapshot().distantSurfaceEnabled, true);
  assert.equal(values.get('space_setting_distant_surface_enabled'), 'true');
});

test('texture bake settings persist, normalize old saves, apply and reset together', t => {
  const {store,values}=settingsFixture(t), layer=new DistantSurfaceLayer();t.after(()=>layer.voxels.dispose());
  const world=uiStub('world',{renderDistance:8,distantSurface:layer,
    getDistantSurfaceSettings:()=>layer.getSettings(),setDistantSurfaceSettings:value=>layer.setSettings(value),
    setDistantSurfaceEnabled:value=>layer.setEnabled(value)});
  store.setWorld(world);
  for(const [key,value] of Object.entries({textureProxyEnabled:true,textureProxyEdge:32,textureProxyDensity:2,textureProxyLodBias:1,textureProxyBatching:2,
    textureProxyDistance:768,textureProxyBudgetMiB:64,textureProxyLinear:true})) store.setDistantSurfaceSetting(key as any,value);
  assert.equal(layer.getSettings().textureProxyEdge,32);
  assert.equal(layer.voxels.getArenaPageCapacity(),1024*1024);assert.equal(layer.voxels.getUnifiedBakedArena(),true);
  const restored=new SpaceUiStore();restored.setWorld(world);
  assert.equal(restored.getSnapshot().distantSurfaceSettings.textureProxyEnabled,true);
  assert.equal(restored.getSnapshot().distantSurfaceSettings.textureProxyLinear,true);
  assert.equal(restored.getSnapshot().distantSurfaceSettings.textureProxyDistance,768);
  assert.equal(restored.getSnapshot().distantSurfaceSettings.textureProxyLodBias,1);
  assert.equal(restored.getSnapshot().distantSurfaceSettings.textureProxyBatching,2);
  restored.setDistantSurfaceSetting('textureProxyBatching',1);
  assert.equal(layer.voxels.getArenaPageCapacity(),1024*1024);assert.equal(layer.voxels.getUnifiedBakedArena(),false);
  restored.setDistantSurfaceSetting('textureProxyBatching',0);
  assert.equal(layer.voxels.getArenaPageCapacity(),256*1024);
  restored.setDistantSurfaceSetting('textureProxyBatching',2);
  restored.setDistantSurfaceSetting('textureProxyEnabled',false);
  assert.equal(layer.voxels.getArenaPageCapacity(),256*1024);assert.equal(layer.voxels.getUnifiedBakedArena(),false);
  restored.resetDistantSurfaceSettings();
  assert.equal(restored.getSnapshot().distantSurfaceSettings.textureProxyBatching,1);
  const saved=JSON.parse(values.get('space_setting_distant_surface')!);
  for(const [key,value] of Object.entries(DEFAULT_VOXEL_TEXTURE_BAKE))assert.equal(saved[key],value);
  const bounded=normalizeDistantSurfaceSettings({textureProxyEdge:999,textureProxyLodBias:999,textureProxyBatching:999,textureProxyDensity:0,textureProxyDistance:-1,textureProxyBudgetMiB:Infinity});
  assert.equal(bounded.textureProxyLodBias,2);assert.equal(bounded.textureProxyBatching,2);
  assert.equal(normalizeDistantSurfaceSettings({}).textureProxyBatching,1);
  assert.equal(bounded.textureProxyEdge,32);assert.equal(bounded.textureProxyDensity,1);assert.equal(bounded.textureProxyDistance,256);
  assert.equal(normalizeDistantSurfaceSettings({textureProxyEnabled:'true'} as any).textureProxyEnabled,false);
});

test('torus backface filtering defaults off, applies to the far layer, persists and resets off', t => {
  const { store, values } = settingsFixture(t);
  const layer = new DistantSurfaceLayer();
  t.after(() => layer.voxels.dispose());
  const world = uiStub('world', { renderDistance: 8, distantSurface: layer,
    getDistantSurfaceSettings: () => layer.getSettings(),
    setDistantSurfaceSettings: value => layer.setSettings(value),
    setDistantSurfaceEnabled: value => layer.setEnabled(value),
  });
  store.setWorld(world);
  assert.equal(store.getSnapshot().distantSurfaceSettings.torusBackfaceCulling, false);
  assert.equal(layer.voxels.getTorusBackfaceCullingEnabled(), false);
  store.setDistantSurfaceSetting('torusBackfaceCulling', true);
  assert.equal(layer.voxels.getTorusBackfaceCullingEnabled(), true);
  assert.equal(JSON.parse(values.get('space_setting_distant_surface')!).torusBackfaceCulling, true);
  const restored = new SpaceUiStore(); restored.setWorld(world);
  restored.setSceneRenderer(uiStub('sceneRenderer', {}));
  assert.equal(restored.getSnapshot().distantSurfaceSettings.torusBackfaceCulling, true);
  assert.equal(layer.voxels.getTorusBackfaceCullingEnabled(), true);
  restored.setDistantSurfaceEnabled(false);
  restored.setDistantSurfaceEnabled(true);
  assert.equal(layer.voxels.getTorusBackfaceCullingEnabled(), true);
  restored.resetDistantSurfaceSettings();
  assert.equal(layer.voxels.getTorusBackfaceCullingEnabled(), false);
  assert.equal(JSON.parse(values.get('space_setting_distant_surface')!).torusBackfaceCulling, false);
  for (const value of [undefined, 'true', 'false', 1, null])
    assert.equal(normalizeDistantSurfaceSettings({ torusBackfaceCulling: value } as any).torusBackfaceCulling, false);
});

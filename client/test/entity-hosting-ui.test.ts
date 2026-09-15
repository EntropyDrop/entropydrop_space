import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as THREE from 'three';
import { spaceUiStore, hostingErrorMessage, hostingAvailabilityMessage } from '../src/ui/react/store/SpaceUiStore.ts';
import { wrapX, wrapZ } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { hostingList, hostingStatus } from './hosting-fixtures.ts';

const componentUrl = new URL('../src/ui/react/components/HostedEntities.tsx', import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url !== componentUrl) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText };
} });
const { HostedEntities } = await import(componentUrl);
hook.deregister();

function render(state: any, props: { defaultExpanded?: boolean } = { defaultExpanded: true }) {
  const original = spaceUiStore.getSnapshot();
  try {
    (spaceUiStore as any).patch(state);
    return renderToStaticMarkup(React.createElement(HostedEntities, props));
  } finally { (spaceUiStore as any).patch(original); }
}

test('hosting HUD starts collapsed while keeping the hosted entity count visible', () => {
  const markup = render({ hosting: hostingList(), hostingBusyIds: [], hostingError: 'Hosting capacity is full.' }, {});
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /Hosted Entities \(1\)/);
  assert.match(markup, /transform:none/);
  assert.doesNotMatch(markup, /hud-entities-body|Hosted Walker|Teleport|Stop hosting|Hosting capacity is full/);
});

test('hosting HUD lists off-AOI entities with English icon-and-text Teleport and early Stop', () => {
  const markup = render({ hosting: hostingList(), hostingBusyIds: [], hostingError: null });
  assert.match(markup, /Hosted Entities \(1\)/);
  assert.match(markup, /Hosting available/);
  assert.doesNotMatch(markup, /128|Cores \d+\/|max 128/);
  assert.match(markup, /Hosted Walker/);
  assert.match(markup, /Core 1/);
  assert.match(markup, /aria-label="Teleport to Hosted Walker"[^>]*><svg[^]*? Teleport<\/button>/);
  assert.match(markup, /aria-label="Stop hosting Hosted Walker"[^>]*><svg[^]*? Stop<\/button>/);
  assert.match(markup, /preserve unused prepaid time/);
  assert.doesNotMatch(markup, /disabled=""/);
});

test('HUD keeps failures visible and busy/foreign actions cannot be repeated', () => {
  const markup = render({ hosting: hostingList({ items: [hostingStatus({ state: 'unavailable', can_manage: false })] }),
    hostingBusyIds: [], hostingError: 'Hosting capacity is full.' });
  assert.match(markup, /role="status">Hosting capacity is full/);
  assert.match(markup, /Unavailable/);
  assert.match(markup, /aria-label="Stop hosting Hosted Walker"[^>]*disabled=""/);
  const busy = render({ hosting: hostingList(), hostingBusyIds: [hostingStatus().entity_id] });
  assert.match(busy, /aria-label="Teleport to Hosted Walker"[^>]*disabled=""/);
});

function storeHarness(handlers: any) {
  const original = spaceUiStore.getSnapshot();
  const internal = spaceUiStore as any;
  const previousHandlers = internal.entityHostingHandlers;
  const previousToast = spaceUiStore.showToast;
  const toasts: string[] = [];
  spaceUiStore.showToast = (text: string) => { toasts.push(text); };
  spaceUiStore.setEntityHostingHandlers(handlers);
  return { toasts, restore() {
    internal.entityHostingHandlers = previousHandlers;
    spaceUiStore.showToast = previousToast;
    internal.patch(original);
  } };
}

test('hosting failures are clear English feedback and clear the single-flight busy guard', async () => {
  const fixture = storeHarness({ host: async () => { throw { code: 'HOSTING_CORES_FULL', detail: { total: 2 } }; } });
  try {
    assert.equal(await spaceUiStore.hostEntity({ publicId: 'one' }, 1), false);
    assert.equal(fixture.toasts[0], 'Hosting capacity is full. Stop a hosted entity or try again later.');
    assert.deepEqual(spaceUiStore.getSnapshot().hostingBusyIds, []);
    assert.equal(await spaceUiStore.hostEntity({ publicId: 'one' }, 169), false);
    assert.match(fixture.toasts[1], /between 1 and 168/);
    assert.match(hostingErrorMessage({ code: 'HOSTING_WORKER_UNAVAILABLE' }), /worker is unavailable/);
    assert.match(hostingErrorMessage({ code: 'ENTITY_OCCUPIED' }), /occupied/);
  } finally { fixture.restore(); }
});

test('hosting availability reports disabled, unavailable and full capacity without exposing the ceiling', () => {
  const states = [
    [hostingList({ enabled: false }), 'Server hosting is disabled'],
    [hostingList({ worker_available: false }), 'Hosting worker unavailable'],
    [hostingList({ capacity: { limit: 128, total: 128, used: 128, available: 0 }, items: [] }), 'Hosting capacity is full'],
    [hostingList(), 'Hosting available'],
  ] as const;
  for (const [hosting, message] of states) {
    assert.equal(hostingAvailabilityMessage(hosting as any), message);
    const markup = render({ hosting, hostingError: null, hostingBusyIds: [] });
    assert.ok(markup.includes(message));
    assert.doesNotMatch(markup, /128|Cores \d+\//);
  }
  assert.doesNotMatch(hostingErrorMessage({ code: 'HOSTING_CORES_FULL', detail: { total: 128, limit: 128 } }), /128/);
});

test('hosting settings show the running count, not the world hosting quota ceiling', () => {
  const settings = readFileSync(new URL('../src/ui/react/components/SimpleModals.tsx', import.meta.url), 'utf8');
  assert.match(settings, /Hosted entities · entire world<\/dt><dd>\{usage\.quotas\.hosted_entities_world\.used\.toLocaleString\(\)\} running/);
  assert.doesNotMatch(settings, /usage\.quotas\.hosted_entities_world\.(limit|remaining)/);
  assert.doesNotMatch(settings, /\['Hosted entities · entire world', usage\.quotas\.hosted_entities_world/);
});

test('paid receipt reaches HUD despite list refresh failure and duplicate clicks grant only once', async () => {
  let finish!: (value: any) => void;
  let starts = 0;
  const fixture = storeHarness({ host: () => { starts++; return new Promise(resolve => { finish = resolve; }); },
    stop: async () => hostingStatus({ execution_mode: 'browser', enabled: false, state: 'paused', core_id: null, can_manage: false }) });
  try {
    const first = spaceUiStore.hostEntity({ publicId: hostingStatus().entity_id }, 1);
    assert.equal(await spaceUiStore.hostEntity({ publicId: hostingStatus().entity_id }, 1), false);
    finish(hostingStatus());
    assert.equal(await first, true);
    assert.equal(starts, 1);
    assert.equal(spaceUiStore.getSnapshot().hosting.items.length, 1);
    assert.equal(await spaceUiStore.stopHostedEntity(hostingStatus().entity_id), true);
    assert.equal(spaceUiStore.getSnapshot().hosting.items.length, 0);
    assert.match(fixture.toasts.at(-1)!, /Unused prepaid time is preserved/);
  } finally { fixture.restore(); }
});

test('teleport reads fresh hosted pose, shifts AOI before loading terrain, and preserves free camera', async () => {
  const fixture = storeHarness({ get: async () => hostingStatus({ teleport_position: { x_cm: -100, y_cm: 3400, z_cm: -200 } }) });
  const calls: string[] = [];
  const physics: any = { position: new THREE.Vector3(1, 2, 3), velocity: new THREE.Vector3(1, 1, 1),
    resetRenderInterpolation() { calls.push('reset'); },
    setInitialPosition(x: number, y: number, z: number) { calls.push('safe spawn'); this.position.set(x, y, z); } };
  const controller = { physics, viewYaw: 1.2, viewPitch: .4, isDriving: true, wrenchGrab: {},
    toggleDriveVehicle() { calls.push('unmount'); }, releaseWrenchGrab() { calls.push('release grab'); },
    unlock() { calls.push('unlock'); }, requestLock() { calls.push('relock'); } };
  try {
    (spaceUiStore as any).patch({ controller, navigationSystem: { stopNavigation() { calls.push('stop navigation'); } },
      world: { async preloadTerrainAoi(x: number, z: number) {
        calls.push('preload');
        assert.equal(physics.position.x, x, 'game loop AOI must already track destination during async preload');
        assert.equal(physics.position.z, z);
        assert.equal(physics.isFlying, true);
        assert.equal(physics.velocity.length(), 0);
      } } });
    assert.equal(await spaceUiStore.teleportToHostedEntity('distant'), true);
    assert.deepEqual(calls, ['stop navigation', 'unmount', 'release grab', 'unlock', 'reset', 'preload', 'safe spawn', 'relock']);
    assert.equal(physics.position.x, wrapX(-1));
    assert.equal(physics.position.z, wrapZ(-2));
    assert.equal(controller.viewYaw, 1.2);
    assert.equal(controller.viewPitch, .4);
    assert.match(fixture.toasts[0], /Teleported to Hosted Walker/);
  } finally { fixture.restore(); }
});

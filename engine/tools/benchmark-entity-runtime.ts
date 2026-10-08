/** CPU-only entity benchmarks. Run: node --import ./engine/test/setup.ts engine/tools/benchmark-entity-runtime.ts
 * Compilation, construction and warmup are excluded. Each row measures a different
 * workload; timings are not additive and do not measure browser frame rate. */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { createAssemblyScriptRuntimeService } from '../src/scripting/AssemblyScriptRuntimeService.ts';
import type { ScriptSnapshot } from '../src/scripting/ScriptProtocol.ts';
import { worldStub } from '../test/fixtures.ts';

function measure(run: () => void) {
  for (let i = 0; i < 60; i++) run();
  const times: number[] = [];
  for (let i = 0; i < 160; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: +times[80].toFixed(4), p95Ms: +times[152].toFixed(4) };
}

const ids = ['root', ...Array.from({ length: 63 }, (_, i) => `part_${i}`)];
const blocks = Array.from({ length: 4096 }, (_, i) => ({
  localX: i % 32, localY: Math.floor(i / 1024), localZ: Math.floor(i / 32) % 32,
  block: 1, entityId: ids[i % ids.length],
}));
const entity = new Contraption('snapshot', blocks, new THREE.Vector3(0, 10, 0), new THREE.Scene(), {
  bodyType: BodyType.KINEMATIC,
  childEntities: ids.slice(1).map(id => ({
    id, parentId: 'root', bodyType: BodyType.KINEMATIC,
    blockKeys: blocks.filter(block => block.entityId === id).map(block => [block.localX, block.localY, block.localZ]),
  })),
});
try {
  console.log(JSON.stringify({ fixture: 'snapshot', components: 64, voxels: 4096,
    ...measure(() => { entity.buildScriptRuntimeSnapshot(.05, null, null, 1, 20); }) }));
} finally { entity.dispose(); }

for (const fixture of ['context', 'state-writes'] as const) {
  const service = createAssemblyScriptRuntimeService();
  const componentIds = fixture === 'context' ? ids.slice(0, 32) : ['root'];
  const code = fixture === 'context'
    ? 'self.state.setNumber("time", ctx.time); self.state.setNumber("players", ctx.players.length); self.state.setVector("position", ctx.position);'
    : 'const state = self.state; const dt = ctx.deltaTime; for (let i = 0; i < 32; i++) state.setNumber("k" + i.toString(), dt + <f64>i);';
  for (const nodeId of componentIds) {
    const result = await service.handle({ type: 'set-script', entityRuntimeId: fixture, nodeId, code });
    assert.equal(result.ok, true, result.error);
  }
  const snapshot: ScriptSnapshot & { scriptOrder: string[] } = {
    entityId: fixture, rootComponentId: 'root', scriptOrder: componentIds, time: 1, deltaTime: .05, tick: 20,
    position: [1, 2, 3], velocity: [0, 0, 0], rotation: [0, 0, 0], gravity: [0, -18, 0],
    states: Object.fromEntries(componentIds.map(id => [id, Object.fromEntries(
      Array.from({ length: fixture === 'state-writes' ? 1024 : 0 }, (_, i) => [`k${i}`, i]),
    )])),
    players: fixture === 'context' ? Array.from({ length: 32 }, (_, i) => ({
      id: `player_${i}`, position: [i, 2, 3], eyePosition: [i, 3, 3], feetPosition: [i, 1, 3],
      velocity: [0, 0, 0], yaw: 0, pitch: 0, mass: 80, isLocal: i === 0, isOnGround: true, isFlying: false,
    })) : [],
    components: componentIds.map((id, i) => ({ id, parentId: i === 0 ? null : 'root',
      children: i === 0 ? componentIds.slice(1) : [], body: { type: 'kinematic', mass: 10 } })),
  };
  try {
    console.log(JSON.stringify({ fixture, components: componentIds.length,
      ...measure(() => {
        const result = service.handle({ type: 'tick', entityRuntimeId: fixture, snapshot });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.errors.length, 0);
      }) }));
  } finally { service.handle({ type: 'dispose', entityRuntimeId: fixture }); }
}

for (const fragmented of [false, true]) {
  const world = worldStub({ terrainVersion: 0, getBlock: () => 0, getMicroBlocksInAABB: () => [],
    raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }) });
  const scene = new THREE.Scene(), manager = new ContraptionManager(scene, world, null, null);
  const physics = new ContraptionPhysics(world);
  manager.setPhysics(physics);
  manager.entityPersistenceMode = 'none';
  const blocks = Array.from({ length: 100 }, (_, i) => ({
    localX: i % 10 * (fragmented ? 2 : 1), localY: 0,
    localZ: Math.floor(i / 10) * (fragmented ? 2 : 1), entityId: 'root', block: 1,
  }));
  for (let i = 0; i < 100; i++) {
    const c = new Contraption(`sleep_${i}`, blocks, new THREE.Vector3(i % 10 * 40, 30, Math.floor(i / 10) * 40), scene);
    c.useGravity = false;
    manager.registerContraption(c);
  }
  try {
    for (let i = 0; i < 45; i++) manager.update(.05, null);
    assert.equal(manager.contraptions.filter(c => physics.isSleeping(c)).length, 100);
    console.log(JSON.stringify({ fixture: 'sleeping', entities: 100, voxelsEach: 100, fragmented,
      ...measure(() => manager.update(.05, null)) }));
  } finally { for (const c of [...manager.contraptions]) c.dispose(); }
}

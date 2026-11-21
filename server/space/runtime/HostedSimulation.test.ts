import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInventoryResource,
  decodeInventoryResource,
  INVENTORY_PROTOBUF_SCHEMA_VERSION,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { HostedSimulation } from './HostedSimulation.ts';
import { EntityScriptRuntimeClient } from '@entropydrop/space-engine/scripting/EntityScriptRuntime.ts';
import { RapierContraptionPhysics } from '@entropydrop/space-engine/rapier/RapierContraptionPhysics.ts';

const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_ID = '10000000-0000-4000-8000-000000000002';

test('hosted simulation preserves component decorations across checkpoints', async () => {
  const input = inputFor('self.state.setNumber("count", self.state.getNumber("count") + 1);');
  const resource: any = decodeInventoryResource(Buffer.from(input.entities[0].definition_base64, 'base64'), 'entity').portable;
  resource.root.decorations = [{ id: 'trim', color: 0x112233, position: [4, 1, 0], scale: [2, 0.1, 1], materialId: 1 }];
  input.entities[0].definition_base64 = Buffer.from(encodeInventoryResource('entity', resource)).toString('base64');
  const first: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(first.faults, []);
  const restored: any = decodeInventoryResource(Buffer.from(first.entities[0].definition_base64, 'base64'), 'entity').portable;
  assert.deepEqual(restored.root.decorations, resource.root.decorations);
  input.entities[0].definition_base64 = first.entities[0].definition_base64;
  input.entities[0].snapshot = first.entities[0].snapshot;
  const second: any = await new HostedSimulation(1337).step(input);
  const checkpoint: any = decodeInventoryResource(Buffer.from(second.entities[0].definition_base64, 'base64'), 'entity').portable;
  assert.deepEqual(checkpoint.root.decorations, resource.root.decorations);
  assert.equal(second.entities[0].snapshot.states.root.count, 2);
});

test('hosted decoration animation is checkpointed independently from the authored definition', async () => {
  const input = inputFor(`
    if (!self.state.getBoolean("created")) {
      self.decorations.upsert("panel", Value.object().setNumber("color", 123).setVector("position", [2, 1, 0]));
      self.state.setBoolean("created", true);
    } else {
      self.state.setNumber("restored", self.decorations.get("panel").getNumber("color"));
      self.decorations.upsert("panel", Value.object().setVector("position", [3, 1, 0]));
    }
  `);
  const first: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(first.faults, []);
  assert.deepEqual(first.entities[0].snapshot.runtimeDecorations, [
    { id: 'root', decorations: [{ id: 'panel', color: 123, position: [2, 1, 0] }] },
  ]);
  const authored: any = decodeInventoryResource(Buffer.from(first.entities[0].definition_base64, 'base64'), 'entity').portable;
  assert.equal(authored.root.decorations?.length || 0, 0);
  input.entities[0].definition_base64 = first.entities[0].definition_base64;
  input.entities[0].snapshot = first.entities[0].snapshot;
  const second: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(second.faults, []);
  assert.equal(second.entities[0].snapshot.states.root.restored, 123);
  assert.deepEqual(second.entities[0].snapshot.runtimeDecorations[0].decorations[0].position, [3, 1, 0]);
  assert.equal(second.entities[0].definition_base64, first.entities[0].definition_base64);
});

test('hosted physics collides with terrain decorations from the chunk snapshot', async () => {
  const fall = async (decorations: unknown[]) => {
    const input: any = inputFor('self.state.setNumber("ticks", self.state.getNumber("ticks") + 1);', 20);
    const resource: any = decodeInventoryResource(Buffer.from(input.entities[0].definition_base64, 'base64'), 'entity').portable;
    resource.root.body = { type: 'dynamic', useGravity: true };
    input.entities[0].definition_base64 = Buffer.from(encodeInventoryResource('entity', resource)).toString('base64');
    // A 16 m plate 15 m above its anchor voxel: its top face is y = 215.625.
    input.chunks[0].standard = [[82, 200, 82, 1, 0x808080]];
    input.chunks[0].decorations = decorations;
    const result: any = await new HostedSimulation(1337).step(input);
    assert.deepEqual(result.faults, []);
    return result.entities[0].snapshot.position[1];
  };
  const plate = { id: 'd_plate', x: 82, y: 200, z: 82, color: 0, position: [0, 15, 0], scale: [16, 0.25, 16] };
  // The snapshot reports the voxel's centre, half a metre above its bottom face.
  const resting = await fall([plate]);
  assert.ok(Math.abs(resting - 216.125) < 0.02, `the entity rests on the plate, y=${resting}`);
  const falling = await fall([]);
  assert.ok(falling < 215.5, `without the decoration the entity falls past it, y=${falling}`);
});

test('hosted Rapier steps live micro terrain and restores a checkpoint after the floor is removed', async t => {
  const dispose = t.mock.method(RapierContraptionPhysics.prototype, 'dispose');
  const input: any = inputFor(`
    if (ctx.contacts.length > 0) {
      const contact = ctx.contacts.at(0);
      self.state.setString("contact", contact.getString("kind"));
      self.state.setVector("point", contact.get("position").asVector());
    }
  `, 20);
  const actor = input.entities[0];
  actor.position = [82, 220, 82];
  const resource: any = decodeInventoryResource(Buffer.from(actor.definition_base64, 'base64'), 'entity').portable;
  resource.root.body = { type: 'dynamic', useGravity: true };
  actor.definition_base64 = Buffer.from(encodeInventoryResource('entity', resource)).toString('base64');
  for (let mx = 648; mx < 672; mx++) for (let mz = 648; mz < 672; mz++) {
    input.chunks[0].micro.push([mx, 215 * 8, mz, 0x808080]);
  }

  const simulation = new HostedSimulation(1337);
  const first: any = await simulation.step(input);
  assert.deepEqual(first.faults, []);
  const entity = first.entities[0];
  const y = entity.snapshot.position[1];
  assert.ok(Math.abs(y - 215.625) < 0.025, `body height on the microvoxel floor ${y}`);
  assert.equal(entity.snapshot.states.root.contact, 'terrain');
  assert.ok(Math.abs(entity.snapshot.states.root.point[1] - 215.125) < 0.05);
  assert.equal(entity.elapsed_ms, 1000);
  assert.equal(entity.poses.length, 20);

  const retried: any = await simulation.step(input);
  assert.deepEqual(retried.faults, []);
  assert.deepEqual(retried.entities[0].poses, entity.poses, 'retrying starts with clean solver state');
  assert.deepEqual(retried.entities[0].snapshot.states, entity.snapshot.states);
  assert.deepEqual(retried.mutations, first.mutations);

  actor.definition_base64 = entity.definition_base64;
  actor.snapshot = entity.snapshot;
  input.steps = 6;
  input.chunks[0].revision++;
  input.chunks[0].micro = [];
  const resumed: any = await simulation.step(input);
  assert.deepEqual(resumed.faults, []);
  assert.ok(resumed.entities[0].snapshot.position[1] < y - 0.5);
  assert.equal(resumed.entities[0].elapsed_ms, 300);
  assert.deepEqual(dispose.mock.calls.map(call => (call.this as RapierContraptionPhysics).counts.steps), [60, 60, 18]);
});

test('a hosted script clearing micro terrain invalidates the resident Rapier floor in the same batch', async () => {
  const input: any = inputFor(`
    if (ctx.isOnGround && !self.state.getBoolean("cleared")) {
      const result = ctx.world.voxels.clearCell([82, 215, 82]);
      self.state.setBoolean("cleared", result.getBoolean("ok"));
    }
  `, 20);
  const actor = input.entities[0];
  actor.position = [82, 216, 82];
  const resource: any = decodeInventoryResource(Buffer.from(actor.definition_base64, 'base64'), 'entity').portable;
  resource.root.body = { type: 'dynamic', useGravity: true };
  actor.definition_base64 = Buffer.from(encodeInventoryResource('entity', resource)).toString('base64');
  for (let mx = 656; mx < 664; mx++) for (let mz = 656; mz < 664; mz++) {
    input.chunks[0].micro.push([mx, 215 * 8, mz, 0x808080]);
  }
  const result: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(result.faults, []);
  assert.equal(result.entities[0].snapshot.states.root.cleared, true);
  assert.ok(result.mutations.some((mutation: any) => mutation.kind === 'clear_micro_cell'));
  assert.ok(result.entities[0].snapshot.position[1] < 214.9);
});

test('hosted Rapier keeps constrained bodies on the compatible Space solver', async t => {
  const dispose = t.mock.method(RapierContraptionPhysics.prototype, 'dispose');
  const input = inputFor('self.applyForce([0, -100, 0]);', 10);
  const actor = input.entities[0];
  const resource: any = decodeInventoryResource(Buffer.from(actor.definition_base64, 'base64'), 'entity').portable;
  resource.constraints = [{ id: 'anchor', type: 'point', bodyA: null, bodyB: 'root',
    anchorA: [80.5, 220.5, 80.5], anchorB: [0, 0, 0], stiffness: 1 }];
  actor.definition_base64 = Buffer.from(encodeInventoryResource('entity', resource)).toString('base64');
  const result: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(result.faults, []);
  assert.equal(result.entities[0].stopped, false);
  assert.ok(Math.abs(result.entities[0].snapshot.position[1] - 220.5) < 0.01);
  assert.deepEqual(dispose.mock.calls.map(call => (call.this as RapierContraptionPhysics).counts.steps), [0]);
});

test('hosted AssemblyScript restores typed state across transaction batches', async () => {
  const input = inputFor('self.state.setNumber("count", self.state.getNumber("count") + 1);');
  const first: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(first.faults, []);
  assert.equal(first.entities[0].snapshot.states.root.count, 1);
  input.entities[0].snapshot = first.entities[0].snapshot;
  input.entities[0].definition_base64 = first.entities[0].definition_base64;
  const second: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(second.faults, []);
  assert.equal(second.entities[0].snapshot.states.root.count, 2);
});

for (const restoreSnapshot of [false, true]) {
  test(`inactive neighbors skip compilation and retain colliders (${restoreSnapshot ? 'checkpoint' : 'fresh'})`, async t => {
    const rootScript = 'self.state.setNumber("neighborTicks", self.state.getNumber("neighborTicks") + 1);';
    const childScript = 'self.state.setNumber("childTicks", self.state.getNumber("childTicks") + 1);';
    const neighborInput = inputFor(rootScript);
    const neighbor = neighborInput.entities[0];
    neighbor.id = TARGET_ID;
    neighbor.position = [84, 220, 80];
    neighbor.anchor = [84, 80];
    const definition: any = decodeInventoryResource(Buffer.from(neighbor.definition_base64, 'base64'), 'entity').portable;
    definition.root.children = [{
      id: 'arm', body: { type: 'kinematic', useGravity: false },
      blocks: [{ dx: 0, dy: 2, dz: 0, block: 1, color: 456 }],
      script: childScript, scriptLanguage: 'assemblyscript', children: [], seats: [],
    }];
    neighbor.definition_base64 = Buffer.from(encodeInventoryResource('entity', definition)).toString('base64');
    if (restoreSnapshot) {
      const checkpoint: any = await new HostedSimulation(1337).step(neighborInput);
      assert.deepEqual(checkpoint.faults, []);
      neighbor.snapshot = checkpoint.entities[0].snapshot;
    }
    neighbor.running = false;
    const originalNeighbor = structuredClone(neighbor);
    const actorScript = `
      const options = Value.object().setString("include", "entities").setNumber("maxDistance", 8);
      const rootHit = ctx.world.raycastWithOptions([83, 220.5, 80.5], [1, 0, 0], options);
      const childHit = ctx.world.raycastWithOptions([83, 222.5, 80.5], [1, 0, 0], options);
      self.state.setString("rootEntity", rootHit.getString("entityId"));
      self.state.setString("rootNode", rootHit.getString("nodeId"));
      self.state.setString("childEntity", childHit.getString("entityId"));
      self.state.setString("childNode", childHit.getString("nodeId"));
    `;
    const input = inputFor(actorScript);
    input.entities.push(neighbor);
    const install = t.mock.method(EntityScriptRuntimeClient.prototype, 'setScript');
    const ready = t.mock.method(EntityScriptRuntimeClient.prototype, 'ready');
    const simulation = new HostedSimulation(1337);
    const result: any = await simulation.step(input);
    assert.deepEqual(install.mock.calls.map(call => call.arguments[1]), [actorScript]);
    assert.equal(ready.mock.callCount(), 1);
    assert.deepEqual(result.faults, []);
    assert.deepEqual(result.entities.map((entity: any) => entity.id), [SOURCE_ID]);
    assert.deepEqual(result.entities[0].snapshot.states.root, {
      rootEntity: TARGET_ID, rootNode: 'root', childEntity: TARGET_ID, childNode: 'arm',
    });
    assert.deepEqual(neighbor, originalNeighbor, 'loading a replica must preserve its source and checkpoint');

    // The same definition must still compile and execute when this process owns it.
    input.entities[0].running = false;
    neighbor.running = true;
    const resumed: any = await simulation.step(input);
    assert.deepEqual(install.mock.calls.map(call => call.arguments[1]), [actorScript, rootScript, childScript]);
    assert.equal(ready.mock.callCount(), 2);
    assert.deepEqual(resumed.faults, []);
    assert.deepEqual(resumed.entities.map((entity: any) => entity.id), [TARGET_ID]);
    assert.equal(resumed.entities[0].snapshot.states.root.neighborTicks, restoreSnapshot ? 2 : 1);
    assert.equal(resumed.entities[0].snapshot.states.arm.childTicks, restoreSnapshot ? 2 : 1);
    const saved: any = decodeInventoryResource(Buffer.from(resumed.entities[0].definition_base64, 'base64'), 'entity').portable;
    assert.equal(saved.root.script, rootScript);
    assert.equal(saved.root.children[0].script, childScript);
  });
}

test('hosted entity code errors automatically stop execution', async () => {
  const input = inputFor('self.state.setBoolean("partial", true); throw new Error("hosted failure");');
  const result: any = await new HostedSimulation(1337).step(input);

  assert.deepEqual(result.faults, []);
  assert.equal(result.entities[0].stopped, true);
  assert.equal(result.entities[0].snapshot.physicsSimulationEnabled, false);
  assert.deepEqual(result.entities[0].snapshot.states.root, {});
  assert.match(result.entities[0].snapshot.scriptError, /hosted failure/);
});

test('hosted entityAPI observes the selected runtime world identity', async () => {
  for (const [slug, name, version] of [['nature', 'Nature', 1], ['copper-metropolis', 'Copper Metropolis', 2]] as const) {
    const input = { ...inputFor(`
      const world = ctx.world.getInfo();
      self.state.setString("worldId", world.getString("id"));
      self.state.setString("worldSlug", world.getString("slug"));
      self.state.setString("worldName", world.getString("name"));
      self.state.setNumber("generator", world.getNumber("terrainGeneratorVersion"));
    `), world_id: `test-${slug}`, world_slug: slug, world_name: name, terrain_generator_version: version };
    const result: any = await new HostedSimulation(1337, version).step(input);
    assert.deepEqual(result.faults, []);
    assert.deepEqual(result.entities[0].snapshot.states.root, {
      worldId: `test-${slug}`, worldSlug: slug, worldName: name, generator: version,
    });
  }
});

function inputFor(script: string, steps = 1) {
  const definition = encodeInventoryResource('entity', {
    type: 'space-entity',
    version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
    root: {
      name: 'Message test',
      id: 'root',
      body: { type: 'dynamic', useGravity: false },
      blocks: [{ dx: 0, dy: 0, dz: 0, block: 1, color: 123 }],
      script,
      scriptLanguage: "assemblyscript",
      children: [],
      seats: [],
    },
    constraints: [],
  });
  return {
    world_id: 'test-world',
    seed: 1337,
    terrain_generator_version: 1,
    steps,
    entities: [{
      id: SOURCE_ID,
      running: true,
      position: [80, 220, 80],
      anchor: [80, 80],
      yaw_quarter_turns: 0,
      snapshot: null as any,
      definition_base64: Buffer.from(definition).toString('base64'),
      message_results: [] as any[],
    }],
    chunks: [{ chunk_x: 5, chunk_z: 5, revision: 0, standard: [], micro: [] }],
  };
}

test('hosted runtime delivers native decoration clicks once and acknowledges original inbox indices', async () => {
  const input: any = inputFor(`
    const click = ctx.clickedBlock;
    if (!click.isNull) {
      self.state.setNumber("clicks", self.state.getNumber("clicks") + 1);
      self.state.setString("handle", click.getString("decorationId"));
    }
    self.state.setNumber("messages", self.state.getNumber("messages") + ctx.messages.received.length);
  `, 3);
  const click = { eventId: 'click-1', entityId: SOURCE_ID, playerId: 'visitor', nodeId: 'root',
    kind: 'decoration', position: [1, 2, 3], size: null, decorationId: 'handle',
    point: [80, 220, 80], localPoint: [1, 2, 3.5] };
  input.entities[0].messages = [
    { clickedBlock: click }, { clickedBlock: { ...click, eventId: 'click-2' } },
    { messageId: 'ordinary', sourceId: TARGET_ID, targetId: SOURCE_ID, type: 'clicked_block', encoding: 'utf8', payload: '{}' },
  ];
  const first: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(first.faults, []);
  assert.equal(first.entities[0].snapshot.states.root.clicks, 2);
  assert.equal(first.entities[0].snapshot.states.root.handle, 'handle');
  assert.equal(first.entities[0].snapshot.states.root.messages, 1);
  assert.deepEqual(first.entities[0].consumed_message_indices, [0, 1, 2]);
  input.entities[0].snapshot = first.entities[0].snapshot;
  input.entities[0].definition_base64 = first.entities[0].definition_base64;
  input.entities[0].messages = [];
  const second: any = await new HostedSimulation(1337).step(input);
  assert.deepEqual(second.faults, []);
  assert.equal(second.entities[0].snapshot.states.root.clicks, 2, 'checkpoint restoration never replays a click');
});

test('hosted acknowledgements handle rejected entries, duplicates and independent frame budgets', async () => {
  const input: any = inputFor(`
    if (!ctx.clickedBlock.isNull) self.state.setNumber("clicks", self.state.getNumber("clicks") + 1);
    self.state.setNumber("messages", self.state.getNumber("messages") + ctx.messages.received.length);
  `);
  const click = { eventId: 'same-event-id', entityId: SOURCE_ID, playerId: 'visitor-1', nodeId: 'root',
    kind: 'standard', position: [0, 0, 0], size: 1, decorationId: null,
    point: [80, 220, 80], localPoint: [0, 0, 0] };
  input.entities[0].messages = [
    { clickedBlock: { ...click, nodeId: String.fromCodePoint(0x1F600).repeat(128) } },
    { clickedBlock: click },
    { clickedBlock: click },
    { clickedBlock: { ...click, playerId: 'visitor-2' } },
    { messageId: 'ordinary', sourceId: TARGET_ID, targetId: SOURCE_ID, type: 'chat', encoding: 'utf8', payload: 'hello' },
  ];
  const simulation = new HostedSimulation(1337);
  const first: any = await simulation.step(input);
  assert.deepEqual(first.faults, []);
  assert.equal(first.entities[0].snapshot.states.root.clicks, 1);
  assert.equal(first.entities[0].snapshot.states.root.messages, 1, 'messages pass the queued second click');
  assert.deepEqual(first.entities[0].consumed_message_indices, [0, 1, 2, 4]);
  // A failed database commit retries the original candidate, including its inbox.
  const retried: any = await simulation.step(input);
  assert.deepEqual(retried.entities[0].snapshot.states, first.entities[0].snapshot.states);
  assert.deepEqual(retried.entities[0].consumed_message_indices, [0, 1, 2, 4]);
  input.entities[0].messages = input.entities[0].messages.filter((_: unknown, index: number) => (
    !first.entities[0].consumed_message_indices.includes(index)
  ));
  input.entities[0].snapshot = first.entities[0].snapshot;
  input.entities[0].definition_base64 = first.entities[0].definition_base64;
  const second: any = await simulation.step(input);
  assert.deepEqual(second.faults, []);
  assert.equal(second.entities[0].snapshot.states.root.clicks, 2);
  assert.equal(second.entities[0].snapshot.states.root.messages, 1);
  assert.deepEqual(second.entities[0].consumed_message_indices, [0]);
});

test('hosted message command ids remain unique across transaction batches', async () => {
  const input = inputFor(`
if (self.state.getString("last").length) self.state.set("receipt", ctx.commands.result(self.state.getString("last")));
const queued = ctx.messages.send('${TARGET_ID}', 'chat', 'hello');
self.state.setString("last", queued.getString("commandId"));
`);
  const simulation = new HostedSimulation(1337);
  const first: any = await simulation.step(input);
  assert.deepEqual(first.faults, []);
  assert.equal(first.messages.length, 1);
  const firstId = first.messages[0].commandId;

  input.entities[0].snapshot = first.entities[0].snapshot;
  input.entities[0].definition_base64 = first.entities[0].definition_base64;
  input.entities[0].message_results = [{
    commandId: firstId,
    status: 'committed',
    scope: 'messages',
    path: 'send',
    nodeId: 'root',
    deliveryStatus: 'routed',
  }];
  const second: any = await simulation.step(input);
  assert.deepEqual(second.faults, []);
  assert.notEqual(second.messages[0].commandId, firstId);
  assert.equal(second.entities[0].snapshot.states.root.receipt.commandId, firstId);
  assert.equal(second.entities[0].snapshot.states.root.receipt.deliveryStatus, 'routed');
});

test('hosted runtime returns a rejection produced on the final simulated frame', async () => {
  const input = inputFor(`
if (ctx.tick === 20) {
  for (let index = 0; index < 21; index++) {
    self.state.set("last", ctx.messages.send('${TARGET_ID}', 'chat', 'hello'));
  }
}
`, 20);
  const simulation = new HostedSimulation(1337);
  const result: any = await simulation.step(input);
  assert.deepEqual(result.faults, []);
  assert.equal(result.messages.length, 20);
  assert.equal(result.entities[0].message_results.length, 1);
  assert.equal(result.entities[0].message_results[0].commandId, result.entities[0].snapshot.states.root.last.commandId);
  assert.equal(result.entities[0].message_results[0].status, 'rejected');
  assert.equal(result.entities[0].message_results[0].reason, 'message_batch_limit');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInventoryResource,
  decodeInventoryResource,
  INVENTORY_PROTOBUF_SCHEMA_VERSION,
} from '@entropydrop/space-engine/storage/InventoryProtobuf.ts';
import { HostedSimulation } from './HostedSimulation.ts';

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

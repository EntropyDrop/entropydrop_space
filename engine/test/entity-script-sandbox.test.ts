import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblyScriptRuntimeService } from '../src/scripting/AssemblyScriptRuntimeService.ts';
import { compileEntityScript } from '../src/scripting/AssemblyScriptCompiler.ts';
import { remapEntityScriptChildIds } from '../src/scripting/EntityScriptRuntime.ts';
import { SPACE_SCRIPT_API_V3 } from '../src/contraption/ScriptApiContract.ts';

function fixture() {
  const service = createAssemblyScriptRuntimeService();
  const send = (message: any) => service.handle({ entityRuntimeId: 'entity', ...message });
  const set = (code: string, nodeId = 'root') => send({ type: 'set-script', nodeId, code });
  const tick = (extra: any = {}, hostApi: any = {}) => send({ type: 'tick', hostApi, snapshot: {
    rootComponentId: 'root', scriptOrder: ['root', 'arm'], time: 1, deltaTime: 0.05, tick: 20,
    entityId: '10000000-0000-4000-8000-000000000000', states: {},
    position: [1, 2, 3], velocity: [0, 0, 0], rotation: [0, 0, 0], gravity: [0, -18, 0],
    input: { down: ['KeyW'], pressed: ['Space'], released: [] },
    components: [{ id: 'root', parentId: null, children: ['arm'], body: { type: 'dynamic', mass: 10 } },
      { id: 'arm', parentId: 'root', children: [], body: { type: 'kinematic' } }], ...extra
  } });
  return { service, send, set, tick };
}

test('typed decoration API provides shared optimistic reads, immutable snapshots and command receipts', async () => {
  const f = fixture();
  assert.equal((await f.set(`
    const arm = self.child("arm");
    if (arm) {
      const result = arm.decorations.upsert("trim", Value.object().setVector("position", [2, 1, 0]).setNumber("color", 123));
      self.state.setString("queued", result.getString("reason"));
      self.state.setNumber("color", arm.decorations.get("trim").getNumber("color"));
      self.state.setNumber("count", arm.decorations.all().length);
      self.state.setBoolean("invalid", arm.decorations.upsert("trim", Value.object().setVector("scale", [0, 1, 1])).getBoolean("ok"));
    }
  `)).ok, true);
  assert.equal((await f.set(`
    self.state.setNumber("seen", self.decorations.get("trim").getNumber("color"));
    self.decorations.remove("trim");
    self.state.setBoolean("absent", self.decorations.get("trim").isNull);
  `, 'arm')).ok, true);
  const result = f.tick();
  assert.deepEqual(result.states.root, { queued: 'queued', color: 123, count: 1, invalid: false });
  assert.deepEqual(result.states.arm, { seen: 123, absent: true });
  assert.deepEqual(result.commands.map(command => [command.nodeId, command.path]),
    [['arm', 'decorations.upsert'], ['arm', 'decorations.remove']]);
  assert.ok(result.commands.every(command => command.commandId));
  await f.set(`self.decorations.upsert("trim", Value.object()); self.decorations.get("trim").setNumber("color", 4);`);
  assert.match(f.tick().errors[0].error, /read-only/);
});

test('decoration command and entity limits reject without changing the optimistic view', async () => {
  const f = fixture();
  assert.equal((await f.set(`
    for (let i = 0; i < 256; i++) self.decorations.upsert("trim", Value.object().setNumber("color", i));
    const rejected = self.decorations.upsert("trim", Value.object().setNumber("color", 999));
    self.state.setString("reason", rejected.getString("reason"));
    self.state.setNumber("color", self.decorations.get("trim").getNumber("color"));
  `)).ok, true);
  const limited = f.tick();
  assert.equal(limited.commands.length, 256);
  assert.deepEqual(limited.states.root, { reason: 'command_limit', color: 255 });
  await f.set(`self.state.setString("reason", self.decorations.upsert("extra", Value.object()).getString("reason"));`);
  const full = f.tick({ components: [
    { id: 'root', parentId: null, children: ['arm'], decorations: [] },
    { id: 'arm', parentId: 'root', children: [], decorations: Array.from({ length: 1024 }, (_, i) => ({ id: 'd'+i, color: 0 })) },
  ] });
  assert.equal(full.states.root.reason, 'too_many_decorations');
  assert.deepEqual(full.commands, []);
});

test('AssemblyScript executes native WASM with typed state, input and command buffers', async () => {
  const f = fixture();
  assert.equal((await f.set(`
    self.state.setNumber("count", self.state.getNumber("count") + 1);
    self.state.setBoolean("held", ctx.input.down("KeyW"));
    self.state.setString("id", ctx.entityId);
    self.state.setVector("position", ctx.position);
    self.applyForce([0, 100, 0]);
    const arm = self.child("arm");
    if (arm) arm.setLocalSpin([0, 1, 0], 60);
  `)).ok, true);
  const first = f.tick();
  assert.equal(first.ok, true, first.error);
  assert.equal(first.states.root.count, 1);
  assert.equal(first.states.root.held, true);
  assert.deepEqual(first.states.root.position, [1, 2, 3]);
  assert.deepEqual(first.commands.map(c => c.path), ['applyForce', 'setLocalSpin']);
  assert.equal(f.tick({ states: first.states }).states.root.count, 2);
});

test('host/browser globals, dynamic JS, npm imports and unregistered imports fail compilation', async () => {
  for (const source of ['window.alert("x");', 'eval("x");', 'self.state.foo = 1;',
    'const x = {foo: 1}; ctx.log(x.foo);', 'import x from "fs";',
    '} @external("evil", "run") declare function attack(): void; export function x(): void { attack();']) {
    await assert.rejects(compileEntityScript(source), undefined, source);
  }
});

test('entityAPI reads frozen world identity through the typed WASM SDK', async () => {
  const f = fixture();
  assert.equal((await f.set(`
    const world = ctx.world.getInfo();
    self.state.setString("worldId", world.getString("id"));
    self.state.setString("worldSlug", world.getString("slug"));
    self.state.setNumber("generator", world.getNumber("terrainGeneratorVersion"));
  `)).ok, true);
  for (const [slug, generator] of [['nature', 1], ['copper-metropolis', 2]] as const) {
    const result = f.tick({ world: { info: { id: `world-${slug}`, slug, terrainGeneratorVersion: generator } } });
    assert.equal(result.states.root.worldId, `world-${slug}`);
    assert.equal(result.states.root.worldSlug, slug);
    assert.equal(result.states.root.generator, generator);
    assert.deepEqual(result.commands, []);
  }
  await f.set('ctx.world.getInfo().setString("id", "another-world");');
  const rejected = f.tick({ world: { info: { id: 'world-nature' } } });
  assert.match(rejected.errors[0].error, /read-only/);
});

test('optimized empty loops and recursion are bounded and discard the entire frame', async () => {
  for (const code of ['self.state.setNumber("x", 1); self.applyForce([1,0,0]); while (true) {}',
    'recurse(); } function recurse(): void { recurse(); } function unused(): void {']) {
    const f = fixture();
    assert.equal((await f.set(code)).ok, true);
    const result = f.tick();
    assert.equal(result.fatal, true);
    assert.equal(result.commands, undefined);
    assert.equal(result.states, undefined);
    assert.match(result.error, /fuel|stack|50 ms|bounds|unreachable/i);
  }
});

test('memory exhaustion traps without affecting another entity', async () => {
  const f = fixture();
  assert.equal((await f.set('const bytes = new Uint8Array(8 * 1024 * 1024); self.state.setNumber("n", bytes.length);')).ok, true);
  const result = f.tick();
  assert.equal(result.ok, false);
  const healthy = fixture();
  await healthy.set('self.state.setNumber("ok", 42);');
  assert.equal(healthy.tick().states.root.ok, 42);
});

test('snapshot mutation and prototype traversal are rejected', async () => {
  for (const code of ['ctx.limits.setNumber("maxForce", 999);', 'self.state.get("constructor");']) {
    const f = fixture(); await f.set(code);
    const result = f.tick();
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /read-only|Reserved/);
  }
});

test('state data is copied and cannot contain cycles or unbounded nesting', async () => {
  const f = fixture();
  await f.set(`const v = Value.object().setNumber("x", 1); self.state.set("saved", v); v.setNumber("x", 2);`);
  assert.equal(f.tick().states.root.saved.x, 1);
  await f.set('let v = Value.object(); for(let i = 0; i < 40; i++) v = Value.object().set("child", v); self.state.set("v", v);');
  const result = f.tick(); assert.equal(result.fatal, true); assert.equal(result.states, undefined);
});

test('world reads and raycasts use synchronous host queries and bounded admission', async () => {
  const f = fixture();
  const code = `self.state.setNumber("block", ctx.world.voxels.get([1,2,3]).getNumber("block"));
    self.state.setNumber("micro", ctx.world.microVoxels.get([1,2,3], [0,1,2]).getNumber("color"));
    const hit = ctx.world.raycastWithOptions([0,0,0], [0,-1,0], Value.object().setNumber("maxDistance", 8));
    self.state.setNumber("distance", hit.getNumber("distance"));`;
  assert.equal((await f.set(code)).ok, true);
  const result = f.tick({}, { worldVoxelGet: () => ({ block: 1 }), worldMicroVoxelGet: () => ({ color: 123 }), worldRaycast: () => ({ distance: 4 }) });
  assert.deepEqual(result.states.root, { block: 1, micro: 123, distance: 4 });
});

test('component body settings, constraints, voxels, selection and message SDK compile together', async () => {
  const f = fixture();
  const compile = await f.set(`
    self.body.setMass(12); self.body.setType("dynamic");
    self.body.setMaterial(Value.object().setNumber("friction", 0.5));
    self.body.setGravityEnabled(false); self.body.setCollisionEnabled(false);
    self.body.applyLocalForce([1,2,3]); self.body.applyTorque([0,1,0]);
    self.constraints.create(Value.object().setString("type", "point").setString("id", "joint"));
    self.voxels.set([0,0,0], Value.object().setNumber("color", 0xff0000));
    self.microVoxels.paint([0,0,0], [1,2,3], Value.object().setNumber("color", 1));
    ctx.selection.box([0,0,0], [1,1,1]);
    ctx.selection.entityBox(ctx.entityId, "root", [0,0,0], [1,1,1]);
    const r = ctx.messages.send("20000000-0000-4000-8000-000000000000", "chat", "hello");
    self.state.setBoolean("sent", r.getBoolean("ok"));
  `);
  assert.equal(compile.ok, true, compile.error);
  // Warm the same compiled module before asserting the command semantics.
  const result = f.tick();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.states.root.sent, true);
  assert.ok(result.commands.some(c => c.path === 'constraints.create'));
});

test('root stop short-circuits child scripts and preserves its control command', async () => {
  const f = fixture(); await f.set('self.stop(); self.state.setBoolean("after", true);');
  await f.set('self.state.setBoolean("ran", true);', 'arm');
  const result = f.tick();
  assert.equal(result.stopped, true);
  assert.equal(result.states.root.after, undefined);
  assert.equal(result.states.arm?.ran, undefined);
  assert.equal(result.commands[0].path, 'stop');
});

test('last edit wins across compilation, clear and disposal races', async () => {
  const f = fixture();
  const old = f.set('self.state.setNumber("old", 1);');
  f.set(''); await old;
  assert.equal(f.tick().states.root?.old, undefined);
  const newer = f.set('self.state.setNumber("newer", 1);');
  f.send({ type: 'dispose' }); assert.equal((await newer).stale, true);
});

test('typed child-id rewriting leaves comments, state and unrelated strings intact', () => {
  const source = `// self.child("arm")\nconst arm: Component | null = self.child("arm"); self.state.setString("name", "arm");`;
  assert.equal(remapEntityScriptChildIds(source, { arm: 'arm_2' }), source.replace('= self.child("arm")', '= self.child("arm_2")'));
});

test('every public AssemblyScript documentation example compiles', async () => {
  const walk = async (section: any) => {
    for (const example of section.examples || []) await compileEntityScript(example.code);
    for (const child of section.subsections || []) await walk(child);
  };
  for (const section of SPACE_SCRIPT_API_V3.sections) await walk(section);
});

test('host array builders reject sparse expansion before it can amplify JSON output', async () => {
  const f = fixture();
  assert.equal((await f.set('const a = Value.array(); a.set("16383", Value.number(1)); self.state.set("a", a);')).ok, true);
  const result = f.tick();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /Invalid array index/);
  assert.equal(result.states.root.a, undefined);
});

test('host handles share a bounded byte allowance for copied strings', async () => {
  const f = fixture();
  const result = await f.set('const s = "x".repeat(60000); for(let i = 0; i < 20; i++) Value.string(s);');
  assert.equal(result.ok, true, result.error);
  const frame = f.tick();
  assert.equal(frame.fatal, true);
  assert.match(frame.error, /allocation|fuel|50 ms/i);
  assert.equal(frame.states, undefined);
});

test('standard-library randomness is reproducible for a frame and varies across ticks', async () => {
  const f = fixture();
  assert.equal((await f.set('self.state.setNumber("sample", Math.random());')).ok, true);
  const sample = f.tick({ tick: 1 }).states.root.sample;
  assert.equal(f.tick({ tick: 1 }).states.root.sample, sample);
  assert.notEqual(f.tick({ tick: 2 }).states.root.sample, sample);
  assert.ok(sample >= 0 && sample < 1);
});

import {
  checkBehavior, makeSpace, makeTerrain, rounds, sceneNames, stateWidth, ticks, warmup,
  type Fixture, type SceneName,
} from './scenes.ts';

type Backend = Pick<ReturnType<typeof makeSpace>, 'step' | 'edit' | 'publish' | 'dispose'>;
type Rapier = typeof import('@dimforge/rapier3d-compat');
const xyz = ([x, y, z]: readonly number[]) => ({ x, y, z });
const identity = { x: 0, y: 0, z: 0, w: 1 };

function makeRapier(rapier: Rapier, fixture: Fixture): Backend {
  const world = new rapier.World(xyz(fixture.gravity));
  world.timestep = fixture.timestep;
  const terrainHost = fixture.removeTerrain === null ? null : makeTerrain(fixture.name);
  const bodies = fixture.bodies.map(spec => {
    const descriptor = spec.fixed ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic();
    const [x, y, z, w] = spec.rotation;
    const body = world.createRigidBody(descriptor.setTranslation(...spec.position).setRotation({ x, y, z, w })
      .setLinvel(...spec.velocity).setAngvel(xyz(spec.angular))
      .setGravityScale(fixture.name === 'hinges' ? 0 : 1).setCanSleep(false).setCcdEnabled(spec.collider)
      .setLinearDamping(spec.damping).setAngularDamping(spec.angularDamping)
      .setAdditionalMassProperties(spec.mass, xyz([0, 0, 0]), xyz([spec.inertia, spec.inertia, spec.inertia]), identity));
    if (spec.collider) world.createCollider(rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5)
      .setDensity(0).setFriction(spec.friction).setRestitution(spec.restitution), body);
    return body;
  });
  const colliders = fixture.terrain.map(box => world.createCollider(rapier.ColliderDesc.cuboid(...box.half)
    .setTranslation(...box.center).setFriction(0.7)));
  for (const joint of fixture.joints) {
    const data = rapier.JointData.revolute(xyz(joint.anchorA), xyz(joint.anchorB), xyz(joint.axis));
    const hinge = world.createImpulseJoint(data, bodies[joint.a], bodies[joint.b], true) as InstanceType<Rapier['RevoluteImpulseJoint']>;
    hinge.setLimits(...joint.limits);
    hinge.setContactsEnabled(false);
  }

  return {
    step() { for (let i = 0; i < fixture.substeps; i++) world.step(); },
    edit() {
      terrainHost!.edit();
      if (!terrainHost!.editedPadIsEmpty()) throw Error('Edited micro geometry still contains the pad');
      world.removeCollider(colliders[fixture.removeTerrain!], true);
    },
    publish(state) {
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        const p = body.translation(), q = body.rotation(), v = body.linvel(), w = body.angvel();
        const offset = i * stateWidth;
        state[offset] = p.x; state[offset + 1] = p.y; state[offset + 2] = p.z;
        state[offset + 3] = q.x; state[offset + 4] = q.y; state[offset + 5] = q.z; state[offset + 6] = q.w;
        state[offset + 7] = v.x; state[offset + 8] = v.y; state[offset + 9] = v.z;
        state[offset + 10] = w.x; state[offset + 11] = w.y; state[offset + 12] = w.z;
      }
    },
    dispose() { world.free(); },
  };
}

export type Timing = { update: number[]; editedUpdate: number[]; qualityFrames: number[][] };
export function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

export function summarize(fixture: Fixture, timing: Timing) {
  return {
    update: stats(timing.update),
    ...(timing.editedUpdate.length ? { editedUpdate: stats(timing.editedUpdate) } : {}),
    behavior: checkBehavior(fixture, timing.qualityFrames),
  };
}

function readFixture(name: SceneName) {
  const instance = makeSpace(name);
  try { return instance.fixture; } finally { instance.dispose(); }
}

export function fixtures() {
  return sceneNames.map(readFixture);
}

function sample(factory: () => Backend, fixture: Fixture, timing: Timing | null) {
  const instance = factory();
  try {
    const state = new Float64Array(fixture.bodies.length * stateWidth);
    for (let i = 0; i < warmup; i++) {
      instance.step();
      instance.publish(state);
    }
    for (let i = 0; i < ticks; i++) {
      const start = performance.now();
      instance.step();
      instance.publish(state);
      timing?.update.push(performance.now() - start);
    }
    if (fixture.removeTerrain !== null) {
      const start = performance.now();
      instance.edit();
      instance.step();
      instance.publish(state);
      timing?.editedUpdate.push(performance.now() - start);
    }
  } finally { instance.dispose(); }
}

function behavior(factory: () => Backend, fixture: Fixture) {
  const instance = factory();
  try {
    const state = new Float64Array(fixture.bodies.length * stateWidth);
    const frames: number[][] = [];
    for (let i = 0; i < warmup; i++) instance.step();
    instance.publish(state);
    frames.push(Array.from(state));
    if (fixture.removeTerrain !== null) instance.edit();
    for (let i = 0; i < fixture.qualityTicks; i++) {
      instance.step();
      instance.publish(state);
      frames.push(Array.from(state));
    }
    return frames;
  } finally { instance.dispose(); }
}

export async function benchmark(rapier: Rapier) {
  await rapier.init();
  return {
    rapierVersion: rapier.version(),
    scenes: fixtures().map(fixture => {
      const factories = [() => makeSpace(fixture.name), () => makeRapier(rapier, fixture)];
      const samples = factories.map((): Timing => ({ update: [], editedUpdate: [], qualityFrames: [] }));
      for (let round = -6; round < rounds; round++) {
        const order = round % 2 === 0 ? [0, 1] : [1, 0];
        for (const index of order) sample(factories[index], fixture, round < 0 ? null : samples[index]);
      }
      for (const [index, factory] of factories.entries()) samples[index].qualityFrames = behavior(factory, fixture);
      return {
        name: fixture.name,
        space: summarize(fixture, samples[0]), rapier: summarize(fixture, samples[1]),
        raw: { space: samples[0], rapier: samples[1] },
      };
    }),
  };
}

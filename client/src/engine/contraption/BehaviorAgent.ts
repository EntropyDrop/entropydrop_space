import { TORUS_SIZE_X, TORUS_SIZE_Z } from '@entropydrop/space-engine/torus/TorusWorld.ts';

const NUMBER_PATTERN = /(-?\d+(?:\.\d+)?)/;

function firstNumber(text, fallback, patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  const match = text.match(NUMBER_PATTERN);
  return match ? Number(match[1]) : fallback;
}

function scriptHeader(prompt, title) {
  return `/**
 * Agent generated controller: ${title}
 * Intent: ${prompt.replace(/\*\//g, '* /')}
 *
 * The controller can read state through ctx and can only change motion by
 * applying forces or torques through self's capability API.
 */`;
}

function hoverController(prompt, targetHeight) {
  return `${scriptHeader(prompt, 'PD hover')}

const targetHeight = ${targetHeight.toFixed(2)};
const heightError = targetHeight - ctx.groundDistance;
const lift = ctx.mass * Math.abs(ctx.gravity[1])
  + heightError * 34.0
  - ctx.velocity[1] * 13.0;

self.applyForce([0, Math.max(0, lift), 0]);
self.applyTorque([
  -ctx.rotation[0] * 32.0 - ctx.angularVelocity[0] * 10.0,
  -ctx.angularVelocity[1] * 3.0,
  -ctx.rotation[2] * 32.0 - ctx.angularVelocity[2] * 10.0
]);

if (ctx.tick % 90 === 0) {
  ctx.log(\`Agent · hover \${ctx.groundDistance.toFixed(1)} / ${targetHeight.toFixed(1)} m\`);
}`;
}

function followController(prompt, distance) {
  return `${scriptHeader(prompt, 'follow player')}

function wrappedDelta(from, to, size) {
  return ((to - from) % size + size + size / 2) % size - size / 2;
}

if (!ctx.players || ctx.players.length === 0) {
  if (ctx.tick % 120 === 0) ctx.log('Agent · waiting for player position API');
} else {
  const followDistance = ${distance.toFixed(2)};
  const playerPos = ctx.players[0].position;

  // Player positions are eye positions; keep a further 1.8 m above the eye.
  const target = [
    playerPos[0],
    playerPos[1] + 1.8,
    playerPos[2] + followDistance
  ];
  const error = [
    wrappedDelta(ctx.position[0], target[0], ${TORUS_SIZE_X}),
    target[1] - ctx.position[1],
    wrappedDelta(ctx.position[2], target[2], ${TORUS_SIZE_Z})
  ];
  const force = error.map((value, axis) => value * 18.0 - ctx.velocity[axis] * 8.0);
  force[1] += ctx.mass * Math.abs(ctx.gravity[1]);

  self.applyForce(force);
  self.applyTorque([
    -ctx.rotation[0] * 28.0 - ctx.angularVelocity[0] * 9.0,
    -ctx.angularVelocity[1] * 4.0,
    -ctx.rotation[2] * 28.0 - ctx.angularVelocity[2] * 9.0
  ]);
}`;
}

function orbitController(prompt, period) {
  return `${scriptHeader(prompt, 'orbit')}

function wrappedDelta(from, to, size) {
  return ((to - from) % size + size + size / 2) % size - size / 2;
}

if (!self.state.orbitCenter) {
  self.state.orbitCenter = [...ctx.position];
}

const period = ${period.toFixed(2)};
const radius = 7.0;
const angle = ctx.time * Math.PI * 2 / period;
const target = [
  self.state.orbitCenter[0] + Math.cos(angle) * radius,
  self.state.orbitCenter[1] + 3.0,
  self.state.orbitCenter[2] + Math.sin(angle) * radius
];
const error = [
  wrappedDelta(ctx.position[0], target[0], ${TORUS_SIZE_X}),
  target[1] - ctx.position[1],
  wrappedDelta(ctx.position[2], target[2], ${TORUS_SIZE_Z})
];
const force = error.map((value, axis) => value * 16.0 - ctx.velocity[axis] * 7.0);
force[1] += ctx.mass * Math.abs(ctx.gravity[1]);

self.applyForce(force);
self.applyTorque([0, 7.0 - ctx.angularVelocity[1] * 2.0, 0]);`;
}

function rocketController(prompt, duration) {
  return `${scriptHeader(prompt, 'timed launch')}

if (self.state.ignitionTime === undefined) self.state.ignitionTime = ctx.time;
const flightTime = ctx.time - self.state.ignitionTime;

if (flightTime < ${duration.toFixed(2)}) {
  self.applyLocalForce([0, ctx.mass * 44.0, 0]);
} else {
  const hold = ctx.mass * Math.abs(ctx.gravity[1]) - ctx.velocity[1] * 8.0;
  self.applyForce([0, Math.max(0, hold), 0]);
}

self.applyTorque([
  -ctx.rotation[0] * 36.0 - ctx.angularVelocity[0] * 12.0,
  -ctx.angularVelocity[1] * 3.0,
  -ctx.rotation[2] * 36.0 - ctx.angularVelocity[2] * 12.0
]);`;
}

function spinController(prompt, rpm) {
  const targetAngularSpeed = rpm * Math.PI * 2 / 60;
  return `${scriptHeader(prompt, 'constant spin')}

const targetAngularSpeed = ${targetAngularSpeed.toFixed(4)};
const yawError = targetAngularSpeed - ctx.angularVelocity[1];
self.applyTorque([0, yawError * 22.0, 0]);

// Keep the entity supported while it spins.
const lift = ctx.mass * Math.abs(ctx.gravity[1]) - ctx.velocity[1] * 7.0;
self.applyForce([0, Math.max(0, lift), 0]);`;
}

function stabilizeController(prompt) {
  return `${scriptHeader(prompt, 'attitude stabilization')}

self.applyTorque([
  -ctx.rotation[0] * 70.0 - ctx.angularVelocity[0] * 18.0,
  -ctx.angularVelocity[1] * 8.0,
  -ctx.rotation[2] * 70.0 - ctx.angularVelocity[2] * 18.0
]);`;
}

/**
 * Deterministic local intent compiler used by the prototype. It deliberately
 * keeps the same result contract that a remote LLM agent can implement later.
 */
export function compileBehaviorPrompt(rawPrompt) {
  const prompt = String(rawPrompt || '').trim();
  const normalized = prompt.toLowerCase();

  if (!prompt) {
    return {
      ok: false,
      error: 'Describe the action you want the entity to perform first, e.g. "hover 5 meters above the ground".'
    };
  }

  if (/\b(?:stop|disable)\b|\bfree\s+fall\b|\bfall\b/i.test(normalized)) {
    return {
      ok: true,
      intent: 'stop',
      title: 'Stop control / free physics',
      summary: 'Stop every component controller and reset runtime state.',
      code: 'ctx.root.stop();'
    };
  }

  if (/(follow|escort|fly\s+with\s+me)/i.test(normalized)) {
    const distance = firstNumber(normalized, 3, [/(?:behind|distance|keep)\s*(-?\d+(?:\.\d+)?)/i]);
    return {
      ok: true,
      intent: 'follow',
      title: 'Follow player',
      summary: `Follow the player, keeping formation about ${Math.abs(distance).toFixed(1)} m behind.`,
      code: followController(prompt, Math.max(1, Math.abs(distance)))
    };
  }

  if (/(orbit|circle)/i.test(normalized)) {
    const period = firstNumber(normalized, 10, [/(?:period|every)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i]);
    return {
      ok: true,
      intent: 'orbit',
      title: 'Periodic orbit',
      summary: `Orbit around the current position, completing one lap every ${Math.max(2, period).toFixed(1)} seconds.`,
      code: orbitController(prompt, Math.max(2, period))
    };
  }

  if (/(rocket|launch|liftoff)/i.test(normalized)) {
    const duration = firstNumber(normalized, 5, [/(?:thrust|ignite|for)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i]);
    return {
      ok: true,
      intent: 'launch',
      title: 'Timed launch',
      summary: `Thrust vertically for ${Math.max(1, duration).toFixed(1)} seconds, then switch to altitude hold.`,
      code: rocketController(prompt, Math.max(1, duration))
    };
  }

  if (/(spin|rotate|rpm)/i.test(normalized)) {
    const rpm = firstNumber(normalized, 18, [/(\d+(?:\.\d+)?)\s*rpm/i]);
    return {
      ok: true,
      intent: 'spin',
      title: 'Constant spin',
      summary: `Maintain about ${Math.max(1, rpm).toFixed(1)} RPM via a torque feedback loop.`,
      code: spinController(prompt, Math.max(1, rpm))
    };
  }

  if (
    /(stabili[sz]e|balance|level)/i.test(normalized) &&
    !/(hover|altitude|height)/i.test(normalized)
  ) {
    return {
      ok: true,
      intent: 'stabilize',
      title: 'Three-axis attitude stabilization',
      summary: 'Read attitude and angular velocity; restore level attitude automatically with damping torques.',
      code: stabilizeController(prompt)
    };
  }

  if (/(hover|altitude|height)/i.test(normalized)) {
    const height = firstNumber(normalized, 5, [/(?:altitude|height|at)\s*(-?\d+(?:\.\d+)?)\s*(?:meters?|blocks?|m)?/i]);
    return {
      ok: true,
      intent: 'hover',
      title: 'PD auto hover',
      summary: `Hold ${Math.max(0.5, height).toFixed(1)} m above the ground and automatically damp attitude oscillation.`,
      code: hoverController(prompt, Math.max(0.5, height))
    };
  }

  return {
    ok: false,
    error: 'The local Agent could not recognize this intent. Supported intents: hover, follow, orbit, launch, spin, stabilize, stop.'
  };
}

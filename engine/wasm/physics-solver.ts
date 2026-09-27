// Trusted f64 solvers. All objects below are unmanaged views into host-owned
// memory or fixed scratch. The three scalar transcendental imports retain the
// host's Math rounding, which matters when a tiny pose difference changes the
// chosen contact feature. No body data or solver control flow crosses the ABI.
// Body (20 f64): position[3], quaternion[4], velocity[3], angularVelocity[3],
// inverseMass, inverseInertia, dynamic, restitution, friction, mass, reserved.
// Joint (24 f64): body indices[2], kind, stiffness, anchors[6], axes[6],
// references[6], lower limit, upper limit. Kinds: point=0, hinge=1, limited=2, weld=3.

@external('math', 'sin') declare function nativeSin(x: f64): f64;
@external('math', 'cos') declare function nativeCos(x: f64): f64;
@external('math', 'atan2') declare function nativeAtan2(y: f64, x: f64): f64;

@unmanaged class Q { x: f64; y: f64; z: f64; w: f64; }
@unmanaged class V {
  x: f64; y: f64; z: f64;
  @inline set(x: f64, y: f64, z: f64): V { this.x = x; this.y = y; this.z = z; return this; }
  @inline copy(v: V): V { return this.set(v.x, v.y, v.z); }
  @inline add(v: V): V { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  @inline sub(v: V): V { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  @inline mul(s: f64): V { this.x *= s; this.y *= s; this.z *= s; return this; }
  @inline div(s: f64): V { return this.mul(1 / s); }
  @inline addScaled(v: V, s: f64): V { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  @inline dot(v: V): f64 { return this.x * v.x + this.y * v.y + this.z * v.z; }
  @inline lengthSq(): f64 { return this.x * this.x + this.y * this.y + this.z * this.z; }
  @inline length(): f64 { return Math.sqrt(this.lengthSq()); }
  @inline normalize(): V { const l = this.length(); return this.div(l == 0 ? 1 : l); }
  @inline cross(v: V): V {
    const x = this.x, y = this.y, z = this.z;
    return this.set(y * v.z - z * v.y, z * v.x - x * v.z, x * v.y - y * v.x);
  }
  @inline rotate(q: Q): V {
    // Same operation ordering as Three.Vector3.applyQuaternion.
    const x = this.x, y = this.y, z = this.z;
    const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
    return this.set(x + q.w * tx + q.y * tz - q.z * ty,
      y + q.w * ty + q.z * tx - q.x * tz, z + q.w * tz + q.x * ty - q.y * tx);
  }
}

const SCRATCH = memory.data(40 * 24);
@inline function temp(i: usize): V { return changetype<V>(SCRATCH + i * 24); }
@inline function vec(p: usize): V { return changetype<V>(p); }
@inline function pos(b: usize): V { return vec(b); }
@inline function quat(b: usize): Q { return changetype<Q>(b + 24); }
@inline function vel(b: usize): V { return vec(b + 56); }
@inline function angular(b: usize): V { return vec(b + 80); }
@inline function massInv(b: usize): f64 { return load<f64>(b + 104); }
@inline function inertia(b: usize): f64 { return load<f64>(b + 112); }
@inline function dynamic(b: usize): bool { return load<f64>(b + 120) != 0; }

function rotateBody(b: usize, rotation: V): void {
  if (!dynamic(b)) return;
  const angle = rotation.length();
  if (angle < 1e-10) return;
  const inverseAngle = 1 / angle, s = nativeSin(angle / 2);
  const ax = (rotation.x * inverseAngle) * s, ay = (rotation.y * inverseAngle) * s;
  const az = (rotation.z * inverseAngle) * s, aw = nativeCos(angle / 2);
  const q = quat(b), bx = q.x, by = q.y, bz = q.z, bw = q.w;
  q.x = ax * bw + aw * bx + ay * bz - az * by;
  q.y = ay * bw + aw * by + az * bx - ax * bz;
  q.z = az * bw + aw * bz + ax * by - ay * bx;
  q.w = aw * bw - ax * bx - ay * by - az * bz;
  const length = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (length == 0) { q.x = q.y = q.z = 0; q.w = 1; }
  else { const inv = 1 / length; q.x *= inv; q.y *= inv; q.z *= inv; q.w *= inv; }
}

@inline function pointCorrection(b: usize, impulse: V, lever: V): void {
  if (massInv(b) <= 0) return;
  pos(b).addScaled(impulse, massInv(b));
  rotateBody(b, temp(12).copy(lever).cross(impulse).mul(inertia(b)));
}

@inline function angularCorrection(a: usize, b: usize, rotation: V): void {
  const ia = dynamic(a) ? inertia(a) : 0, ib = dynamic(b) ? inertia(b) : 0, total = ia + ib;
  if (total <= 0 || rotation.lengthSq() < 1e-14) return;
  if (ia > 0) rotateBody(a, temp(12).copy(rotation).mul(-ia / total));
  if (ib > 0) rotateBody(b, temp(12).copy(rotation).mul(ib / total));
}

function pointConstraint(a: usize, b: usize, joint: usize, worldAnchor: bool): void {
  const anchorA = temp(0).copy(vec(joint + 32));
  if (!worldAnchor) anchorA.rotate(quat(a)).add(pos(a));
  const anchorB = temp(1).copy(vec(joint + 56)).rotate(quat(b)).add(pos(b));
  const error = temp(2).copy(anchorB).sub(anchorA), distance = error.length();
  if (distance < 1e-7) return;
  const normal = error.div(distance), leverA = temp(3).copy(anchorA).sub(pos(a));
  const leverB = temp(4).copy(anchorB).sub(pos(b));
  const aa = dynamic(a) ? temp(5).copy(leverA).cross(normal).lengthSq() * inertia(a) : 0;
  const ab = dynamic(b) ? temp(5).copy(leverB).cross(normal).lengthSq() * inertia(b) : 0;
  const denominator = massInv(a) + massInv(b) + aa + ab;
  if (denominator <= 1e-10) return;
  const impulse = normal.mul(distance * load<f64>(joint + 24) / denominator);
  pointCorrection(a, impulse, leverA);
  pointCorrection(b, temp(6).copy(impulse).mul(-1), leverB);
}

function hingeConstraint(a: usize, b: usize, joint: usize, kind: i32): void {
  const stiffness = load<f64>(joint + 24);
  const axisA = temp(0).copy(vec(joint + 80)).rotate(quat(a)).normalize();
  const axisB = temp(1).copy(vec(joint + 104)).rotate(quat(b)).normalize();
  angularCorrection(a, b, temp(2).copy(axisB).cross(axisA).mul(stiffness));
  // References use the corrected orientations, but hinge axes retain the
  // values from the start of this constraint, matching the reference solver.
  const referenceA = temp(3).copy(vec(joint + 128)).rotate(quat(a));
  const referenceB = temp(4).copy(vec(joint + 152)).rotate(quat(b));
  const hingeAxis = temp(5).copy(axisA).add(axisB);
  if (hingeAxis.lengthSq() < 1e-9) hingeAxis.copy(axisA);
  hingeAxis.normalize();
  referenceA.addScaled(hingeAxis, -referenceA.dot(hingeAxis)).normalize();
  referenceB.addScaled(hingeAxis, -referenceB.dot(hingeAxis)).normalize();
  const angle = nativeAtan2(hingeAxis.dot(temp(6).copy(referenceA).cross(referenceB)),
    Math.max(-1, Math.min(1, referenceA.dot(referenceB))));
  let target = angle;
  if (kind == 3) target = 0;
  else if (kind == 2) target = Math.max(load<f64>(joint + 176), Math.min(load<f64>(joint + 184), angle));
  else return;
  const correction = target - angle;
  if (Math.abs(correction) > 1e-7) angularCorrection(a, b, hingeAxis.mul(correction * stiffness));
}

export function solveJoints(bodies: usize, joints: usize, count: i32, iterations: i32): void {
  for (let iteration = 0; iteration < iterations; iteration++) for (let i = 0; i < count; i++) {
    const joint = joints + usize(i) * 192;
    const a = bodies + usize(load<f64>(joint)) * 160, b = bodies + usize(load<f64>(joint + 8)) * 160;
    if (massInv(a) + massInv(b) <= 0) continue;
    pointConstraint(a, b, joint, a == bodies);
    const kind = i32(load<f64>(joint + 16));
    if (kind != 0) hingeConstraint(a, b, joint, kind);
  }
}

@inline function pointVelocity(b: usize, point: V, out: V): V {
  const lever = temp(20).copy(point).sub(pos(b));
  return out.copy(vel(b)).add(temp(21).copy(angular(b)).cross(lever));
}

@inline function pairImpulse(a: usize, b: usize, leverA: V, leverB: V, impulse: V, ia: f64, ib: f64): void {
  vel(a).addScaled(impulse, -ia); vel(b).addScaled(impulse, ib);
  if (ia > 0) angular(a).addScaled(temp(19).copy(leverA).cross(impulse), -inertia(a));
  if (ib > 0) angular(b).addScaled(temp(19).copy(leverB).cross(impulse), inertia(b));
}

export function solvePairImpulse(a: usize, b: usize, ownerA: usize, ownerB: usize,
  contact: usize, ia: f64, ib: f64, restingVelocity: f64): f64 {
  const normal = vec(contact), point = vec(contact + 24);
  const leverA = temp(0).copy(point).sub(pos(a)), leverB = temp(1).copy(point).sub(pos(b));
  const carrierA = pointVelocity(a, point, temp(2)), carrierB = pointVelocity(b, point, temp(3));
  const offsetA = temp(4).set(0, 0, 0), offsetB = temp(5).set(0, 0, 0);
  if (a != ownerA) pointVelocity(ownerA, point, offsetA).sub(carrierA);
  if (b != ownerB) pointVelocity(ownerB, point, offsetB).sub(carrierB);
  const normalVelocity = carrierB.add(offsetB).sub(carrierA.add(offsetA)).dot(normal);
  let magnitude: f64 = 0;
  if (normalVelocity < 0) {
    const aa = ia > 0 ? temp(6).copy(leverA).cross(normal).lengthSq() * inertia(a) : 0;
    const ab = ib > 0 ? temp(6).copy(leverB).cross(normal).lengthSq() * inertia(b) : 0;
    const denominator = ia + ib + aa + ab;
    if (denominator > 1e-10) {
      const restitution = Math.abs(normalVelocity) < 0.5 ? 0 : Math.max(load<f64>(ownerA + 128), load<f64>(ownerB + 128));
      magnitude = -(1 + restitution) * normalVelocity / denominator;
      pairImpulse(a, b, leverA, leverB, temp(7).copy(normal).mul(magnitude), ia, ib);
      const postA = pointVelocity(a, point, temp(8)).add(offsetA);
      const tangent = pointVelocity(b, point, temp(9)).add(offsetB).sub(postA);
      tangent.addScaled(normal, -tangent.dot(normal));
      const speed = tangent.length();
      if (speed > 0.01 && magnitude > 0) {
        tangent.div(speed);
        const ta = ia > 0 ? temp(6).copy(leverA).cross(tangent).lengthSq() * inertia(a) : 0;
        const tb = ib > 0 ? temp(6).copy(leverB).cross(tangent).lengthSq() * inertia(b) : 0;
        const td = ia + ib + ta + tb;
        if (td > 1e-10) {
          const friction = Math.sqrt(Math.max(0, load<f64>(ownerA + 136) * load<f64>(ownerB + 136)));
          pairImpulse(a, b, leverA, leverB, tangent.mul(Math.max(-magnitude * friction, -speed / td)), ia, ib);
        }
      }
    }
  }
  const total = ia + ib;
  if (total > 1e-10) {
    const residual = temp(6).copy(vel(b)).add(offsetB).sub(temp(7).copy(vel(a)).add(offsetA)).dot(normal);
    if (Math.abs(residual) < restingVelocity) {
      const correction = -residual / total;
      vel(a).addScaled(normal, -correction * ia); vel(b).addScaled(normal, correction * ib);
    }
  }
  return magnitude;
}

function supportWidth(points: usize, count: i32, normal: V): f64 {
  if (count <= 2) return 0;
  const tangent = temp(30).set(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) tangent.set(0, 1, 0);
  const bitangent = temp(31).copy(normal).cross(tangent).normalize();
  tangent.copy(bitangent).cross(normal).normalize();
  let mu: f64 = 0, mv: f64 = 0;
  for (let i = 0; i < count; i++) { const p = vec(points + usize(i) * 24); mu += p.dot(tangent); mv += p.dot(bitangent); }
  mu /= count; mv /= count;
  let suu: f64 = 0, svv: f64 = 0, suv: f64 = 0;
  for (let i = 0; i < count; i++) {
    const p = vec(points + usize(i) * 24), du = p.dot(tangent) - mu, dv = p.dot(bitangent) - mv;
    suu += du * du; svv += dv * dv; suv += du * dv;
  }
  const trace = suu + svv, determinant = suu * svv - suv * suv;
  const discriminant = Math.max(0, trace * trace / 4 - determinant);
  return 2 * Math.sqrt(Math.max(0, trace / 2 - Math.sqrt(discriminant)));
}

export function toppleSupport(b: usize, normalPtr: usize, dt: f64, gravity: f64): void {
  if (!dynamic(b)) return;
  const normal = vec(normalPtr), face = temp(32).set(1, 0, 0).rotate(quat(b));
  const axis = temp(33).set(0, 1, 0).rotate(quat(b));
  if (Math.abs(axis.dot(normal)) > Math.abs(face.dot(normal))) face.copy(axis);
  axis.set(0, 0, 1).rotate(quat(b));
  if (Math.abs(axis.dot(normal)) > Math.abs(face.dot(normal))) face.copy(axis);
  if (face.dot(normal) < 0) face.mul(-1);
  if (face.dot(normal) < 0.995) {
    face.cross(normal);
    const instability = face.length();
    if (instability > 1e-6) angular(b).addScaled(face.div(instability), (gravity * 0.25 * instability) * dt);
  }
}

// The row buffer holds lever[3], effective inverse mass, target velocity and
// accumulated impulse. All iterations consume the immediately updated velocity.
export function solveTerrainImpulse(b: usize, contact: usize, points: usize, pointCount: i32,
  manifold: usize, count: i32, rows: usize, penetration: f64, dt: f64,
  restitutionEnabled: bool, contactIterations: i32, gravity: f64,
  restingVelocity: f64, narrowWidth: f64): f64 {
  const normal = vec(contact), hit = vec(contact + 24);
  pos(b).addScaled(normal, Math.max(0, penetration - 0.001));
  const r = temp(0).copy(hit).sub(pos(b)), inv = 1 / load<f64>(b + 144);
  for (let i = 0; i < count; i++) {
    const row = rows + usize(i) * 48, lever = vec(row).copy(vec(manifold + usize(i) * 24)).sub(pos(b)).cross(normal);
    const initial = vel(b).dot(normal) + angular(b).dot(lever);
    store<f64>(row + 24, inv + lever.lengthSq() * inertia(b));
    store<f64>(row + 32, restitutionEnabled && initial < -0.5 ? -initial * load<f64>(b + 128) : 0);
    store<f64>(row + 40, 0);
  }
  const iterations = count > 1 ? contactIterations : 1;
  for (let iteration = 0; iteration < iterations; iteration++) for (let i = 0; i < count; i++) {
    const row = rows + usize(i) * 48, denominator = load<f64>(row + 24);
    if (denominator <= 1e-9) continue;
    const normalVelocity = vel(b).dot(normal) + angular(b).dot(vec(row));
    const previous = load<f64>(row + 40);
    const next = Math.max(0, previous + (load<f64>(row + 32) - normalVelocity) / denominator), delta = next - previous;
    store<f64>(row + 40, next);
    vel(b).addScaled(normal, delta * inv); angular(b).addScaled(vec(row), delta * inertia(b));
  }
  let magnitude: f64 = 0;
  for (let i = 0; i < count; i++) magnitude += load<f64>(rows + usize(i) * 48 + 40);
  if (magnitude <= 0) return 0;
  const tangent = temp(1).copy(vel(b)).add(temp(2).copy(angular(b)).cross(r));
  tangent.addScaled(normal, -tangent.dot(normal));
  const speed = tangent.length();
  if (speed > 0.01 && magnitude > 0) {
    tangent.div(speed);
    const lever = temp(2).copy(r).cross(tangent), denominator = inv + lever.lengthSq() * inertia(b);
    if (denominator > 1e-9) {
      const friction = Math.max(-magnitude * load<f64>(b + 136), -speed / denominator);
      vel(b).addScaled(tangent, friction * inv); angular(b).addScaled(lever, friction * inertia(b));
    }
  }
  if (normal.y > 0.5 && supportWidth(points, pointCount, normal) < narrowWidth) toppleSupport(b, contact, dt, gravity);
  const residual = vel(b).dot(normal);
  if (Math.abs(residual) < restingVelocity) vel(b).addScaled(normal, -residual);
  if (vel(b).lengthSq() < 0.01) vel(b).set(0, 0, 0);
  return magnitude;
}

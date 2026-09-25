import { MICRO_DIVISIONS, MICRO_SIZE } from '../voxel/MicroGrid.ts';
// =============================================================================
// TorusWorld — toroidal world geometry.
//
// Design: flat simulation plus bent rendering. World X wraps around the major ring
// (1024 chunks × 16 = 16384 cells), while Z wraps around the tube (128 × 16 =
// 2048 cells). Physics, collision, and mesh data remain in flat coordinates. The
// renderer bends vertices and the camera onto the torus, revealing the ring at range.
//
// Bend mapping (flat → bent):
//   θ = wx·2π/16384        major-ring angle
//   t = wz·2π/2048; φ = 2 atan2(√((R/r+1)/(R/r−1)) sin(t/2), cos(t/2))
//   s = (R + r·cosφ)/R; ρ = r + (wy − GREF)·s
//   P = ((R + ρ·cosφ)·cosθ, ρ·sinφ, (R + ρ·cosφ)·sinθ)
//   R = 16384/2π ≈ 2607.59, r = 2048/2π ≈ 325.95
//
// Performance: material.onBeforeCompile bends every vertex on the GPU. Per frame,
// the CPU bends one camera, frustum-culls chunk spheres, and unbends ray samples.
// =============================================================================
import * as THREE from 'three';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';

export const TORUS_CHUNKS_X = 1024;
export const TORUS_CHUNKS_Z = 128;
export const TORUS_SIZE_X = TORUS_CHUNKS_X * 16;    // 16384
export const TORUS_SIZE_Z = TORUS_CHUNKS_Z * 16;    // 2048
export const TORUS_R = TORUS_SIZE_X / (Math.PI * 2);   // Major radius ≈ 2607.59.
export const TORUS_RHO = TORUS_SIZE_Z / (Math.PI * 2); // Tube radius ≈ 325.95.
export const TORUS_GREF = 16;                         // Reference ground height on the torus surface.
export const TORUS_SPAWN_X = TORUS_SIZE_X / 2;        // θ=π, midpoint of the inner major ring.
export const TORUS_SPAWN_Z = TORUS_SIZE_Z / 2;        // φ=π, inner tube surface.
export const TORUS_MAX_RHO = TORUS_R - 1;             // Keep ρ ≤ R−1 so the embedding stays injective.
export const TORUS_K_THETA = (Math.PI * 2) / TORUS_SIZE_X;
export const TORUS_K_PHI = (Math.PI * 2) / TORUS_SIZE_Z;

const WORLD_PROJECTION_REVISION = 1;

/** The torus projection is immutable, so cached bent-space bounds never need a mode revision. */
export function getWorldProjectionRevision(): number {
  return WORLD_PROJECTION_REVISION;
}

// -----------------------------------------------------------------------------
// Coordinate wrapping into [0, size).
// -----------------------------------------------------------------------------
export function wrapX(x) {
  return ((x % TORUS_SIZE_X) + TORUS_SIZE_X) % TORUS_SIZE_X;
}
export function wrapZ(z) {
  return ((z % TORUS_SIZE_Z) + TORUS_SIZE_Z) % TORUS_SIZE_Z;
}
export function wrapChunkX(cx) {
  return ((cx % TORUS_CHUNKS_X) + TORUS_CHUNKS_X) % TORUS_CHUNKS_X;
}
export function wrapChunkZ(cz) {
  return ((cz % TORUS_CHUNKS_Z) + TORUS_CHUNKS_Z) % TORUS_CHUNKS_Z;
}
export function wrapMicroX(mx) {
  const m = TORUS_SIZE_X * MICRO_DIVISIONS;
  return ((mx % m) + m) % m;
}
export function wrapMicroZ(mz) {
  const m = TORUS_SIZE_Z * MICRO_DIVISIONS;
  return ((mz % m) + m) % m;
}

/**
 * Return the periodic equivalent of value that is nearest to anchor.
 *
 * Selection and interpolation code use this to keep a small range that crosses
 * a torus seam continuous (for example X 16383..16385 instead of 0..16383).
 * Storage and world lookup may still wrap the returned coordinate normally.
 */
export function unwrapPeriodicNear(value, anchor, period) {
  if (!Number.isFinite(value) || !Number.isFinite(anchor) || !Number.isFinite(period) || period <= 0) {
    return value;
  }
  let delta = ((value - anchor) % period + period) % period;
  if (delta > period / 2) delta -= period;
  return anchor + delta;
}

// -----------------------------------------------------------------------------
// Bend and unbend.
// -----------------------------------------------------------------------------
const TORUS_ASPECT = TORUS_R / TORUS_RHO;
const TORUS_TUBE_ANGLE_FACTOR = Math.sqrt((TORUS_ASPECT + 1) / (TORUS_ASPECT - 1));
const TORUS_TUBE_ANGLE_FACTOR_SQUARED = TORUS_TUBE_ANGLE_FACTOR ** 2;
const TORUS_TUBE_INVERSE_FACTOR = 1 / TORUS_TUBE_ANGLE_FACTOR;
const _tubeTrig = new THREE.Vector2();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
const _viewOrigin = new THREE.Vector3();
const _viewMatrix = new THREE.Matrix3();
const _viewInverse = new THREE.Matrix3();
const _viewEnabled = { value: 0 };
const VIEW_FLAT_RADIUS = 96;
const VIEW_TORUS_RADIUS = 256;
const _viewJacobian = new THREE.Matrix3();
const _viewFrame = new THREE.Matrix3();
const _viewDx = new THREE.Vector3();
const _viewDy = new THREE.Vector3();
const _viewDz = new THREE.Vector3();
const _viewSample = new THREE.Vector3();
const _viewProjected = new THREE.Vector3();
let _viewNearBoundScale = 1;
let _viewTransitionBoundScale = 1;

function matrixOperatorBound(matrix: THREE.Matrix3, subtractIdentity = false) {
  const e = matrix.elements;
  const a = e.map((value, index) => value - (subtractIdentity && index % 4 === 0 ? 1 : 0));
  const row = Math.max(
    Math.abs(a[0]) + Math.abs(a[3]) + Math.abs(a[6]),
    Math.abs(a[1]) + Math.abs(a[4]) + Math.abs(a[7]),
    Math.abs(a[2]) + Math.abs(a[5]) + Math.abs(a[8]),
  );
  const column = Math.max(
    Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]),
    Math.abs(a[3]) + Math.abs(a[4]) + Math.abs(a[5]),
    Math.abs(a[6]) + Math.abs(a[7]) + Math.abs(a[8]),
  );
  return Math.sqrt(row * column);
}

/** Redistribute the tube angle so ground-level X and Z lengths differ by under 1%. */
export function torusTubeAngle(z: number) {
  const halfAngle = z * TORUS_K_PHI * 0.5;
  return 2 * Math.atan2(
    TORUS_TUBE_ANGLE_FACTOR * Math.sin(halfAngle),
    Math.cos(halfAngle),
  );
}

function torusTubeTrig(z: number, out: THREE.Vector2) {
  const halfAngle = z * TORUS_K_PHI * 0.5;
  const sine = Math.sin(halfAngle);
  const cosine = Math.cos(halfAngle);
  const sineSquared = sine * sine;
  const cosineSquared = cosine * cosine;
  const denominator = cosineSquared + TORUS_TUBE_ANGLE_FACTOR_SQUARED * sineSquared;
  return out.set(
    (cosineSquared - TORUS_TUBE_ANGLE_FACTOR_SQUARED * sineSquared) / denominator,
    2 * TORUS_TUBE_ANGLE_FACTOR * sine * cosine / denominator,
  );
}

function bendTorusPoint(x: number, y: number, z: number, out: THREE.Vector3) {
  const theta = x * TORUS_K_THETA;
  torusTubeTrig(z, _tubeTrig);
  const cp = _tubeTrig.x;
  const sp = _tubeTrig.y;
  const localScale = (TORUS_R + TORUS_RHO * cp) / TORUS_R;
  let rho = TORUS_RHO + (y - TORUS_GREF) * localScale;
  if (rho > TORUS_MAX_RHO) rho = TORUS_MAX_RHO;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const rad = TORUS_R + rho * cp;
  return out.set(rad * ct, rho * sp, rad * st);
}

/** Map flat (x,y,z) to bent (bx,by,bz). Reuse out for zero-allocation hot paths. */
export function bendPoint(x, y, z, out = new THREE.Vector3()) {
  return bendTorusPoint(x, y, z, out);
}

/** Conservative sphere for every bent vertex/triangle in a flat AABB. The
 * maximum projection derivative bounds curvature between sampled vertices. */
export function computeBentBoundsSphere(bounds, out = new THREE.Sphere()) {
  bendPoint((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2, out.center);
  const maxHeightOffset = Math.max(
    Math.abs(bounds.minY - TORUS_GREF),
    Math.abs(bounds.maxY - TORUS_GREF),
  );
  const rho = Math.min(
    TORUS_RHO + maxHeightOffset * (1 + TORUS_RHO / TORUS_R),
    TORUS_MAX_RHO,
  );
  // Also cover the small radial component of the Z derivative above ground.
  const scale = Math.max(1, (TORUS_R + rho) / TORUS_R,
    rho / TORUS_RHO * 1.15 + maxHeightOffset * 0.0005);
  out.radius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ) * 0.5 * scale + 1e-6;
  return out;
}

/** Map bent coordinates back to flat space. The outer solution is unique for ρ ≤ R−1. */
export function unbendPoint(bx, by, bz, out = new THREE.Vector3()) {
  const rxy = Math.hypot(bx, bz);
  let u = rxy - TORUS_R; // Outer solution for ρ·cosφ = ±rxy − R.
  if (u < -TORUS_MAX_RHO) u = -rxy - TORUS_R; // Hole fallback, outside the world and treated as air.
  const rho = Math.hypot(u, by);
  const phi = Math.atan2(by, u);
  const halfPhi = phi * 0.5;
  const tubeAngle = 2 * Math.atan2(
    TORUS_TUBE_INVERSE_FACTOR * Math.sin(halfPhi),
    Math.cos(halfPhi),
  );
  let theta = Math.atan2(bz, bx);
  let wx = (theta / (Math.PI * 2)) * TORUS_SIZE_X;
  let wz = (tubeAngle / (Math.PI * 2)) * TORUS_SIZE_Z;
  wx = ((wx % TORUS_SIZE_X) + TORUS_SIZE_X) % TORUS_SIZE_X;
  wz = ((wz % TORUS_SIZE_Z) + TORUS_SIZE_Z) % TORUS_SIZE_Z;
  const localScale = (TORUS_R + TORUS_RHO * Math.cos(phi)) / TORUS_R;
  const wy = (rho - TORUS_RHO) / localScale + TORUS_GREF;
  return out.set(wx, wy, wz);
}

// Local orthonormal frame: flat basis (X→eθ, Y→eρ, Z→eφ) to the bent tangent basis.
function torusFrameAxes(x, y, z) {
  const theta = x * TORUS_K_THETA;
  torusTubeTrig(z, _tubeTrig);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = _tubeTrig.x;
  const sp = _tubeTrig.y;
  _vA.set(-st, 0, ct);           // e_θ
  _vB.set(cp * ct, sp, cp * st); // e_ρ is the surface normal.
  _vC.set(-sp * ct, cp, -sp * st); // e_φ
}

/** Map a flat direction to a bent direction using local linearization. */
export function bendDirection(x, y, z, dir, out = new THREE.Vector3()) {
  torusFrameAxes(x, y, z);
  const ex = _vA, ey = _vB, ez = _vC;
  return out.set(
    ex.x * dir.x + ey.x * dir.y + ez.x * dir.z,
    ex.y * dir.x + ey.y * dir.y + ez.y * dir.z,
    ex.z * dir.x + ey.z * dir.y + ez.z * dir.z
  );
}

/** Map a bent direction to flat space for picking flat meshes. */
export function unbendDirection(x, y, z, dir, out = new THREE.Vector3()) {
  torusFrameAxes(x, y, z);
  return out.set(
    dir.x * _vA.x + dir.y * _vA.y + dir.z * _vA.z,
    dir.x * _vB.x + dir.y * _vB.y + dir.z * _vB.z,
    dir.x * _vC.x + dir.y * _vC.y + dir.z * _vC.z
  );
}

/** Quaternion mapping the flat basis to the bent basis at a flat-space position. */
export function bendFrameQuaternion(x, y, z, out = _quatA) {
  torusFrameAxes(x, y, z);
  _basis.makeBasis(_vA, _vB, _vC);
  return out.setFromRotationMatrix(_basis);
}

/** Keep the player's nearby cubic geometry in a flat tangent chart. The chart
 * smoothly rejoins the closed torus outside the interaction distance. */
export function setTorusViewCorrection(flatCamera: THREE.Vector3 | null) {
  if (!flatCamera) {
    _viewEnabled.value = 0;
    return;
  }
  const { x, y, z } = flatCamera;
  bendPoint(x, y, z, _viewOrigin);
  const epsilon = 0.01;
  bendPoint(x + epsilon, y, z, _viewDx);
  bendPoint(x, y + epsilon, z, _viewDy);
  bendPoint(x, y, z + epsilon, _viewDz);
  _viewDx.sub(_viewOrigin).divideScalar(epsilon);
  _viewDy.sub(_viewOrigin).divideScalar(epsilon);
  _viewDz.sub(_viewOrigin).divideScalar(epsilon);
  _viewJacobian.set(
    _viewDx.x, _viewDy.x, _viewDz.x,
    _viewDx.y, _viewDy.y, _viewDz.y,
    _viewDx.z, _viewDy.z, _viewDz.z,
  );
  bendFrameQuaternion(x, y, z, _quatB);
  _viewDx.set(1, 0, 0).applyQuaternion(_quatB);
  _viewDy.set(0, 1, 0).applyQuaternion(_quatB);
  _viewDz.set(0, 0, 1).applyQuaternion(_quatB);
  _viewFrame.set(
    _viewDx.x, _viewDy.x, _viewDz.x,
    _viewDx.y, _viewDy.y, _viewDz.y,
    _viewDx.z, _viewDy.z, _viewDz.z,
  );
  _viewMatrix.copy(_viewFrame).multiply(_viewJacobian.invert());
  _viewInverse.copy(_viewMatrix).invert();
  _viewNearBoundScale = Math.max(1, matrixOperatorBound(_viewMatrix));
  _viewTransitionBoundScale = _viewNearBoundScale
    + matrixOperatorBound(_viewMatrix, true) * VIEW_TORUS_RADIUS * 1.5
      / (VIEW_TORUS_RADIUS - VIEW_FLAT_RADIUS);
  _viewEnabled.value = 1;
}

export function projectBentPointForView(point: THREE.Vector3, out = new THREE.Vector3()) {
  if (!_viewEnabled.value) return out.copy(point);
  const dx = point.x - _viewOrigin.x;
  const dy = point.y - _viewOrigin.y;
  const dz = point.z - _viewOrigin.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance >= VIEW_TORUS_RADIUS) return out.copy(point);
  const t = THREE.MathUtils.clamp(
    (distance - VIEW_FLAT_RADIUS) / (VIEW_TORUS_RADIUS - VIEW_FLAT_RADIUS), 0, 1,
  );
  const weight = 1 - t * t * (3 - 2 * t);
  const e = _viewMatrix.elements;
  return out.set(
    point.x + weight * (e[0] * dx + e[3] * dy + e[6] * dz - dx),
    point.y + weight * (e[1] * dx + e[4] * dy + e[7] * dz - dy),
    point.z + weight * (e[2] * dx + e[5] * dy + e[8] * dz - dz),
  );
}

export function bendPointForView(x: number, y: number, z: number, out = new THREE.Vector3()) {
  return projectBentPointForView(bendPoint(x, y, z, out), out);
}

export function unbendPointForView(bx: number, by: number, bz: number, out = new THREE.Vector3()) {
  if (!_viewEnabled.value) return unbendPoint(bx, by, bz, out);
  const dx = bx - _viewOrigin.x;
  const dy = by - _viewOrigin.y;
  const dz = bz - _viewOrigin.z;
  if (Math.hypot(dx, dy, dz) < VIEW_FLAT_RADIUS * 0.5) {
    const e = _viewInverse.elements;
    return unbendPoint(
      _viewOrigin.x + e[0] * dx + e[3] * dy + e[6] * dz,
      _viewOrigin.y + e[1] * dx + e[4] * dy + e[7] * dz,
      _viewOrigin.z + e[2] * dx + e[5] * dy + e[8] * dz,
      out,
    );
  }
  // A few fixed-point steps cover the 96–256 m blend zone used by previews.
  _viewSample.set(bx, by, bz);
  for (let i = 0; i < 6; i++) {
    projectBentPointForView(_viewSample, _viewProjected);
    _viewSample.x += bx - _viewProjected.x;
    _viewSample.y += by - _viewProjected.y;
    _viewSample.z += bz - _viewProjected.z;
  }
  return unbendPoint(_viewSample.x, _viewSample.y, _viewSample.z, out);
}

export function projectBentSphereForView(sphere: THREE.Sphere, out = new THREE.Sphere()) {
  const rawDistance = sphere.center.distanceTo(_viewOrigin);
  projectBentPointForView(sphere.center, out.center);
  // The blend can enlarge a bound near its transition. This covers both the
  // local inverse Jacobian and the extra derivative of the blend weight.
  const scale = !_viewEnabled.value || rawDistance - sphere.radius >= VIEW_TORUS_RADIUS
    ? 1
    : rawDistance + sphere.radius <= VIEW_FLAT_RADIUS
      ? _viewNearBoundScale
      : _viewTransitionBoundScale;
  out.radius = sphere.radius * scale;
  return out;
}

/** Bend a flat-space camera position and orientation onto the torus. */
export function applyCameraBend(camera) {
  const px = camera.position.x;
  const py = camera.position.y;
  const pz = camera.position.z;
  const flatQuat = _quatA.copy(camera.quaternion);
  bendPoint(px, py, pz, camera.position);
  bendFrameQuaternion(px, py, pz, _quatB);
  camera.quaternion.copy(_quatB).multiply(flatQuat);
  camera.updateMatrixWorld(true);
}

/** Bent-space chunk bounding sphere used for correct frustum culling. */
export function computeChunkBentSphere(
  cx,
  cz,
  out = null,
  minY = 0,
  maxY = CHUNK_SIZE_Y,
  span = 16,
) {
  const ox = cx * 16;
  const oz = cz * 16;
  const safeSpan = THREE.MathUtils.clamp(Number(span) || 16, 0.2, 16);
  const safeMinY = THREE.MathUtils.clamp(Number(minY) || 0, 0, CHUNK_SIZE_Y);
  const safeMaxY = THREE.MathUtils.clamp(Number(maxY) || 0, safeMinY, CHUNK_SIZE_Y);
  let boundsMinX = Infinity, boundsMinY = Infinity, boundsMinZ = Infinity;
  let boundsMaxX = -Infinity, boundsMaxY = -Infinity, boundsMaxZ = -Infinity;
  for (let yi = 0; yi < 2; yi++) {
    const ly = yi === 0 ? safeMinY : safeMaxY;
    for (let xi = 0; xi < 3; xi++) {
      const lx = ox + xi * safeSpan * 0.5;
      for (let zi = 0; zi < 3; zi++) {
        const lz = oz + zi * safeSpan * 0.5;
        const p = bendPoint(lx, ly, lz, _vA);
        if (p.x < boundsMinX) boundsMinX = p.x;
        if (p.y < boundsMinY) boundsMinY = p.y;
        if (p.z < boundsMinZ) boundsMinZ = p.z;
        if (p.x > boundsMaxX) boundsMaxX = p.x;
        if (p.y > boundsMaxY) boundsMaxY = p.y;
        if (p.z > boundsMaxZ) boundsMaxZ = p.z;
      }
    }
  }
  const cx2 = (boundsMinX + boundsMaxX) / 2;
  const cy2 = (boundsMinY + boundsMaxY) / 2;
  const cz2 = (boundsMinZ + boundsMaxZ) / 2;
  let radius = 0;
  for (let yi = 0; yi < 2; yi++) {
    const ly = yi === 0 ? safeMinY : safeMaxY;
    for (let xi = 0; xi < 3; xi++) {
      const lx = ox + xi * safeSpan * 0.5;
      for (let zi = 0; zi < 3; zi++) {
        const lz = oz + zi * safeSpan * 0.5;
        const p = bendPoint(lx, ly, lz, _vA);
        const d = Math.hypot(p.x - cx2, p.y - cy2, p.z - cz2);
        if (d > radius) radius = d;
      }
    }
  }
  if (!out) out = {};
  out.cx = cx2;
  out.cy = cy2;
  out.cz = cz2;
  // Covers the small amount of curvature between the 3×3 samples.
  out.radius = radius + 1;
  return out;
}

// -----------------------------------------------------------------------------
// GPU bending: inject the torus transform into every material vertex shader.
// -----------------------------------------------------------------------------
const TORUS_GLSL_PREFIX = `
uniform float uTorusKTheta;
uniform float uTorusKPhi;
uniform float uTorusR;
uniform float uTorusRho;
uniform float uTorusGRef;
uniform float uTorusMaxRho;
uniform float uTorusTubeAngleFactor;
uniform float uTorusViewEnabled;
uniform vec3 uTorusViewOrigin;
uniform mat3 uTorusViewMatrix;

vec2 torusTubeTrig( float z ) {
	float halfAngle = z * uTorusKPhi * 0.5;
	float factor = uTorusTubeAngleFactor;
	float sine = sin(halfAngle);
	float cosine = cos(halfAngle);
	float sineSquared = sine * sine;
	float cosineSquared = cosine * cosine;
	float denominator = cosineSquared + factor * factor * sineSquared;
	return vec2(
		(cosineSquared - factor * factor * sineSquared) / denominator,
		2.0 * factor * sine * cosine / denominator
	);
}

vec3 torusBend( vec3 p ) {
	float theta = p.x * uTorusKTheta;
	vec2 tubeTrig = torusTubeTrig( p.z );
	float cp = tubeTrig.x;
	float localScale = (uTorusR + uTorusRho * cp) / uTorusR;
	float rho = uTorusRho + ( p.y - uTorusGRef ) * localScale;
	rho = min( rho, uTorusMaxRho );
	float ct = cos( theta );
	float st = sin( theta );
	float sp = tubeTrig.y;
	float rad = uTorusR + rho * cp;
	return vec3( rad * ct, rho * sp, rad * st );
}

vec3 torusBendForView( vec3 p ) {
	vec3 bent = torusBend( p );
	if (uTorusViewEnabled < 0.5) return bent;
	vec3 delta = bent - uTorusViewOrigin;
	float t = smoothstep(${VIEW_FLAT_RADIUS.toFixed(1)}, ${VIEW_TORUS_RADIUS.toFixed(1)}, length(delta));
	return bent + (1.0 - t) * (uTorusViewMatrix * delta - delta);
}

mat3 torusFrame( vec3 p ) {
	float theta = p.x * uTorusKTheta;
	vec2 tubeTrig = torusTubeTrig( p.z );
	float ct = cos( theta );
	float st = sin( theta );
	float cp = tubeTrig.x;
	float sp = tubeTrig.y;
	return mat3(
		vec3( -st, 0.0, ct ),
		vec3( cp * ct, sp, cp * st ),
		vec3( -sp * ct, cp, -sp * st )
	);
}
`;

const TORUS_PROJECT_VERTEX = `
vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	worldPosition = modelMatrix * ( instanceMatrix * vec4( transformed, 1.0 ) );
#endif
worldPosition.xyz = torusBendForView( worldPosition.xyz );
vec4 mvPosition = viewMatrix * worldPosition;
gl_Position = projectionMatrix * mvPosition;
`;

const TORUS_NORMAL_VERTEX = `
vec4 torusWp = modelMatrix * vec4( position, 1.0 );
vec3 torusObjectNormal = objectNormal;
#ifdef TORUS_VOXEL_POSITION
    torusWp = modelMatrix * vec4(voxelPosition(position.xy), 1.0);
    torusObjectNormal = voxelNormal();
#endif
#ifdef TORUS_SURFACE_POSITION
    // Interpolate the curved surface normal per vertex. A constant normal at
    // each LOD cell centre produces visible rings even below the pixel budget.
    #ifdef TORUS_SURFACE_AXIS
        vec2 torusAlong = mix(vec2(1.0, 0.0), vec2(0.0, 1.0), surfaceAxis);
        float torusWinding = mix(surfaceNormal.y, -surfaceNormal.x, surfaceAxis);
        float torusAlongPosition = torusWinding >= 0.0 ? position.x : 1.0 - position.x;
        vec2 torusSurfaceXZ = surfaceOffset + torusAlong * torusAlongPosition * surfaceSize;
        float torusSurfaceY = mix(surfaceBottomHeight, surfaceHeight, position.y) * ${MICRO_SIZE};
    #else
        vec2 torusSurfaceXZ = surfaceOffset + position.xz * surfaceSize;
        float torusSurfaceY = surfaceHeight * ${MICRO_SIZE};
    #endif
    torusWp = modelMatrix * vec4(torusSurfaceXZ.x, torusSurfaceY, torusSurfaceXZ.y, 1.0);
#endif
#ifdef TORUS_SURFACE_NORMAL
	torusObjectNormal = vec3(surfaceNormal.x, 0.0, surfaceNormal.y);
#endif
#ifdef USE_INSTANCING
	torusWp = modelMatrix * ( instanceMatrix * vec4( position, 1.0 ) );
	torusObjectNormal = mat3( instanceMatrix ) * torusObjectNormal;
#endif
// defaultnormal_vertex normally returns a view-space normal. Preserve object
// rotation first, then apply the local torus frame, then enter view space.
vec3 transformedNormal = mat3( viewMatrix )
	* torusFrame( torusWp.xyz )
	* normalize( mat3( modelMatrix ) * torusObjectNormal );
transformedNormal = normalize( transformedNormal );
`;

const hookedMaterials = new WeakSet();
const torusDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

function hookMaterialForTorus(material) {
  if (!material || hookedMaterials.has(material)) return;
  hookedMaterials.add(material);
  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof previousOnBeforeCompile === 'function') {
      previousOnBeforeCompile.call(material, shader, renderer);
    }
    const u = shader.uniforms;
    u.uTorusKTheta = { value: TORUS_K_THETA };
    u.uTorusKPhi = { value: TORUS_K_PHI };
    u.uTorusR = { value: TORUS_R };
    u.uTorusRho = { value: TORUS_RHO };
    u.uTorusGRef = { value: TORUS_GREF };
    u.uTorusMaxRho = { value: TORUS_MAX_RHO };
    u.uTorusTubeAngleFactor = { value: TORUS_TUBE_ANGLE_FACTOR };
    u.uTorusViewEnabled = _viewEnabled;
    u.uTorusViewOrigin = { value: _viewOrigin };
    u.uTorusViewMatrix = { value: _viewMatrix };
    let vs = shader.vertexShader;
    if (!vs.includes('torusBend')) {
      vs = TORUS_GLSL_PREFIX + vs;
      if (vs.includes('#include <project_vertex>')) {
        vs = vs.replace('#include <project_vertex>', TORUS_PROJECT_VERTEX);
      }
      if (vs.includes('#include <worldpos_vertex>')) {
        // worldPosition was already bent by the project_vertex override.
        vs = vs.replace('#include <worldpos_vertex>', '// worldPosition bent by torus project_vertex override');
      }
      if (vs.includes('#include <defaultnormal_vertex>')) {
        vs = vs.replace('#include <defaultnormal_vertex>', TORUS_NORMAL_VERTEX);
      }
    }
    shader.vertexShader = vs;
  };
  material.customProgramCacheKey = () => {
    const prior = typeof previousCacheKey === 'function'
      ? previousCacheKey.call(material)
      : '';
    return `${prior}|torus-bend-v6`;
  };
  material.needsUpdate = true;
}

hookMaterialForTorus(torusDepthMaterial);

/** Scan the scene at low frequency and inject bending into new materials; WeakSet deduplicates them. */
export function hookSceneMaterials(root) {
  root.traverse((obj) => {
    // Some helpers may already provide geometry in bent coordinates.
    if (obj.userData?.torusPreBent) return;
    const mat = obj.material;
    if (mat) {
      // The shader moves vertices from flat logical coordinates into bent
      // space, but Three.js frustum tests happen before the vertex shader and
      // would use the stale flat-space bounding sphere. Runtime helpers
      // (selection boxes/cursors) and assembled contraptions were therefore
      // incorrectly culled even though their bent geometry was on screen.
      // Terrain chunk parents still use cullChunks() below, so disabling the
      // built-in per-renderable test does not disable our coarse terrain cull.
      obj.frustumCulled = false;
      if (Array.isArray(mat)) {
        for (const m of mat) hookMaterialForTorus(m);
      } else {
        hookMaterialForTorus(mat);
      }
    }
    if (obj.isMesh && obj.castShadow) {
      if (obj.customDepthMaterial) hookMaterialForTorus(obj.customDepthMaterial);
      else obj.customDepthMaterial = torusDepthMaterial;
    }
  });
}

// -----------------------------------------------------------------------------
// Bent-space frustum culling for terrain chunks.
// -----------------------------------------------------------------------------
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _cullingRawSphere = new THREE.Sphere();
const _cullingViewSphere = new THREE.Sphere();
const _cullingViewBounds = { cx: 0, cy: 0, cz: 0, radius: 0 };
const TERRAIN_SHADOW_CASTER_DISTANCE = 64;

function projectedCullingBounds(bs) {
  _cullingRawSphere.center.set(bs.cx, bs.cy, bs.cz);
  _cullingRawSphere.radius = bs.radius;
  projectBentSphereForView(_cullingRawSphere, _cullingViewSphere);
  _cullingViewBounds.cx = _cullingViewSphere.center.x;
  _cullingViewBounds.cy = _cullingViewSphere.center.y;
  _cullingViewBounds.cz = _cullingViewSphere.center.z;
  _cullingViewBounds.radius = _cullingViewSphere.radius;
  return _cullingViewBounds;
}

function isLocalShadowCaster(camera, bs): boolean {
  return Math.hypot(
    camera.position.x - bs.cx,
    camera.position.y - bs.cy,
    camera.position.z - bs.cz,
  ) <= bs.radius + TERRAIN_SHADOW_CASTER_DISTANCE;
}

function isBentSphereVisible(camera, bs): boolean {
  // Parent visibility also gates the directional-light shadow pass. Keep a
  // compact ring of nearby casters even when they sit just behind the camera.
  const cameraDistance = Math.hypot(
    camera.position.x - bs.cx,
    camera.position.y - bs.cy,
    camera.position.z - bs.cz,
  );
  if (cameraDistance <= bs.radius + 80) return true;

  for (let i = 0; i < 6; i++) {
    const p = _frustum.planes[i];
    if (p.normal.x * bs.cx + p.normal.y * bs.cy + p.normal.z * bs.cz + p.constant < -bs.radius) {
      return false;
    }
  }
  return true;
}

export function cullChunks(camera, world) {
  if (!world || !world.chunks) return;
  world.distantSurface?.updateHandoffs();
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
  for (const [chunkKey, chunk] of world.chunks) {
    const mesh = chunk.mesh;
    if (!mesh) continue;
    if (world.activeChunkKeys && !world.activeChunkKeys.has(chunkKey)
      && !world.distantSurface?.retainsDetailChunk(chunk.cx, chunk.cz)) {
      mesh.visible = false;
      continue;
    }
    world.distantSurface?.handoff.hook(mesh);
    let bs = mesh.userData && mesh.userData.bentSphere;
    if (!bs || mesh.userData.bentSphereRevision !== WORLD_PROJECTION_REVISION) {
      const occupiedRange = chunk.getOccupiedYRange?.();
      const minY = Number.isFinite(mesh.userData?.occupiedMinY)
        ? mesh.userData.occupiedMinY
        : occupiedRange?.min ?? 0;
      const maxY = Number.isFinite(mesh.userData?.occupiedMaxY)
        ? mesh.userData.occupiedMaxY
        : occupiedRange ? occupiedRange.max + 1 : CHUNK_SIZE_Y;
      bs = computeChunkBentSphere(chunk.cx, chunk.cz, bs, minY, maxY);
      mesh.userData.bentSphere = bs;
      mesh.userData.bentSphereRevision = WORLD_PROJECTION_REVISION;
    }

    mesh.visible = isBentSphereVisible(camera, projectedCullingBounds(bs));
    const castShadow = mesh.visible && isLocalShadowCaster(camera, bs);
    mesh.traverse((child) => {
      if (child.isMesh) child.castShadow = castShadow;
    });
  }

  // Micro voxels use independent horizontal meshes and bypass Three's native
  // flat-space frustum test. Apply the same coarse culling here so a large
  // authored area does not render every micro mesh around the torus.
  const microMeshes = world.microVoxels?.renderMeshes ?? world.microVoxels?.meshChunks;
  if (!microMeshes) return;
  for (const [chunkKey, mesh] of microMeshes) {
    const standardChunkKey = mesh.userData?.standardChunkKey ?? chunkKey;
    const [standardCx, standardCz] = String(standardChunkKey).split(',').map(Number);
    if (world.activeChunkKeys && !world.activeChunkKeys.has(standardChunkKey)
      && !world.distantSurface?.retainsDetailChunk(standardCx, standardCz)) {
      mesh.visible = false;
      continue;
    }
    world.distantSurface?.handoff.hook(mesh);
    let bs = mesh.userData?.bentSphere;
    if (!bs || mesh.userData.bentSphereRevision !== WORLD_PROJECTION_REVISION) {
      let cx = Number(mesh.userData?.projectionChunkCx);
      let cz = Number(mesh.userData?.projectionChunkCz);
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) {
        [cx, cz] = String(chunkKey).split(',').map(Number);
      }
      const minY = Number.isFinite(mesh.userData?.occupiedMinY)
        ? mesh.userData.occupiedMinY
        : 0;
      const maxY = Number.isFinite(mesh.userData?.occupiedMaxY)
        ? mesh.userData.occupiedMaxY
        : CHUNK_SIZE_Y;
      const span = Number.isFinite(mesh.userData?.bentSpan) ? mesh.userData.bentSpan : 16;
      bs = computeChunkBentSphere(cx, cz, bs, minY, maxY, span);
      mesh.userData.bentSphere = bs;
      mesh.userData.bentSphereRevision = WORLD_PROJECTION_REVISION;
    }
    mesh.visible = isBentSphereVisible(camera, projectedCullingBounds(bs));
    mesh.castShadow = mesh.visible && isLocalShadowCaster(camera, bs);
  }
}

import type { Contraption, EntityCollisionBounds } from '../contraption/Contraption.ts';
import type { CollisionBounds } from './CollisionGeometry.ts';
import * as THREE from 'three';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import type { PlayerTerrain } from './PhysicsTerrain.ts';

const AXIS_SUFFIX = { x: 'X', y: 'Y', z: 'Z' } as const;
type SolidBlock = { x: number; y: number; z: number; size?: number; block?: number };
export interface PlayerMoveInput {
  forward?: boolean; backward?: boolean; right?: boolean; left?: boolean;
  jump?: boolean;
  /** A fresh press latched until the next physics tick, including short taps. */
  jumpPressed?: boolean;
  crouch?: boolean;
}

const COLLISION_EPSILON = 1e-5;
const FACE_TOLERANCE = 0.08;
// Treat shallow foot penetration below a mounted entity's top surface as standing
// on the platform, then lift the player to the top instead of pushing sideways.
const STAND_TOLERANCE = 0.4;

export const PLAYER_MASS_KG = 50;
export const PLAYER_GRAVITY_MPS2 = -24;
export const PLAYER_AIR_DASH_DISTANCE = 5;
export const PLAYER_AIR_DASH_DURATION = 0.4;
const DASH_HOLD_TIME = PLAYER_AIR_DASH_DURATION / 2;

function dashEase(progress: number, entrySlope = 0, exitSlope = 0): number {
  const squared = progress * progress;
  const cubed = squared * progress;
  return squared * (3 - 2 * progress)
    + entrySlope * (cubed - 2 * squared + progress)
    + exitSlope * (cubed - squared);
}

/** Extend the midpoint's peak speed while held, without repeating the easing. */
function dashDistance(start: number, dt: number, held: boolean, entrySlope: number, exitSlope: number): number {
  const end = Math.min(held ? DASH_HOLD_TIME : PLAYER_AIR_DASH_DURATION, start + dt);
  const eased = PLAYER_AIR_DASH_DISTANCE * (
    dashEase(end / PLAYER_AIR_DASH_DURATION, entrySlope, exitSlope)
    - dashEase(start / PLAYER_AIR_DASH_DURATION, entrySlope, exitSlope)
  );
  const cruiseTime = held ? Math.max(0, start + dt - DASH_HOLD_TIME) : 0;
  const cruiseSpeed = PLAYER_AIR_DASH_DISTANCE / PLAYER_AIR_DASH_DURATION * (1.5 - (entrySlope + exitSlope) / 4);
  return eased + cruiseTime * cruiseSpeed;
}

function entityBodyId(contraption: Contraption | null | undefined, value?: unknown): string {
  if (value !== undefined && value !== null) return String(value);
  if (typeof contraption?.rootComponentId === 'string') return contraption.rootComponentId;
  for (const node of contraption?.entityNodes?.values?.() || []) {
    if (node?.parentId === null) return String(node.id);
  }
  return '';
}

export class PlayerPhysics {
  world: PlayerTerrain;
  contraptionManager: { contraptions: Contraption[] } | null;

  // Player position (bottom center of bounding box)
  position: THREE.Vector3;
  previousPosition: THREE.Vector3;
  renderSimulationPosition: THREE.Vector3;
  renderInterpolated: boolean;
  velocity: THREE.Vector3;

  // Dimensions
  width: number;
  height: number;
  eyeHeight: number;

  // Physics parameters
  gravity: number;
  jumpForce: number;
  walkSpeed: number;
  sprintSpeed: number;
  flySpeed: number;

  // Fixed physical mass (kg). Weight is derived from the current gravity and
  // exposed in newtons through the getter below.
  readonly mass: number = PLAYER_MASS_KG;

  get weight(): number {
    return this.mass * Math.abs(this.gravity);
  }

  // State flags
  isOnGround: boolean;
  isFlying: boolean;
  isCrouching: boolean;
  isSprinting: boolean;
  isInWater: boolean;
  private jumpHeld = false;
  private airJumpAvailable = false;
  private dashElapsed = PLAYER_AIR_DASH_DURATION;
  private dashDirection = new THREE.Vector3();
  private dashEntrySlope = 0;
  private dashExitSlope = 0;
  private dashHoldAllowed = false;
  private dashAim = new THREE.Vector3();
  private dashTurn = new THREE.Quaternion();
  private dashTurnTarget = new THREE.Quaternion();
  private dashRenderStep: { start: number; end: number; dt: number; held: boolean;
    entrySlope: number; exitSlope: number } | null = null;
  private renderedDashElapsed: number | null = null;

  get isDashing(): boolean {
    return this.dashElapsed < PLAYER_AIR_DASH_DURATION;
  }

  get dashIntensity(): number {
    const elapsed = this.renderInterpolated && this.renderedDashElapsed !== null
      ? this.renderedDashElapsed : this.dashElapsed;
    if (elapsed <= 0 || elapsed >= PLAYER_AIR_DASH_DURATION) return 0;
    return Math.sin(Math.PI * elapsed / PLAYER_AIR_DASH_DURATION) ** 2;
  }

  private stopDash() {
    if (this.isDashing) {
      this.velocity.set(0, 0, 0);
    }
    this.dashElapsed = PLAYER_AIR_DASH_DURATION;
    this.dashHoldAllowed = false;
  }

  /** Discard airborne actions when teleporting, flying, navigating or seated. */
  resetJumpState(jumpHeld = false) {
    this.stopDash();
    this.dashRenderStep = null;
    this.renderedDashElapsed = null;
    this.airJumpAvailable = false;
    this.jumpHeld = jumpHeld;
  }

  // Moving Platform attachment (when standing on a moving contraption)
  ridingContraption: Contraption | null;
  ridingBodyId: string | null;
  lastRidingPlatformPos: THREE.Vector3 | null;
  private ridingPlatformPose: { contraption: Contraption; bodyId: string; matrix: THREE.Matrix4 } | null = null;
  private ridingInverseMatrix = new THREE.Matrix4();
  private ridingTargetPosition = new THREE.Vector3();
  private ridingDisplacement = new THREE.Vector3();
  private currentCollisionBoxes = new WeakMap<object, EntityCollisionBounds>();
  private observedColliderPoses = new WeakMap<object, Map<string, THREE.Matrix4>>();

  constructor(world: PlayerTerrain, contraptionManager: {contraptions: Contraption[]} | null = null) {
    this.world = world;
    this.contraptionManager = contraptionManager;

    // Player position (bottom center of bounding box)
    this.position = new THREE.Vector3(8, 20, 8);
    this.previousPosition = this.position.clone();
    this.renderSimulationPosition = this.position.clone();
    this.renderInterpolated = false;
    this.velocity = new THREE.Vector3(0, 0, 0);

    // Dimensions
    this.width = 0.6;
    this.height = 1.8;
    this.eyeHeight = 1.62;

    // Physics parameters
    this.gravity = PLAYER_GRAVITY_MPS2;
    this.jumpForce = 8.8;
    this.walkSpeed = 5.0;
    this.sprintSpeed = 7.8;
    this.flySpeed = 14.0;

    // Fixed physical mass: 50kg, immutable and non-writable at runtime.
    Object.defineProperty(this, 'mass', {
      value: PLAYER_MASS_KG,
      writable: false,
      configurable: false,
      enumerable: true
    });

    // State flags
    this.isOnGround = false;
    this.isFlying = false;
    this.isCrouching = false;
    this.isSprinting = false;
    this.isInWater = false;

    // Moving Platform attachment (when standing on a moving contraption)
    this.ridingContraption = null;
    this.ridingBodyId = null;
    this.lastRidingPlatformPos = null;
  }

  setContraptionManager(contraptionManager: {contraptions: Contraption[]} | null) {
    this.contraptionManager = contraptionManager;
  }

  getEyePosition() {
    return new THREE.Vector3(
      this.position.x,
      this.position.y + (this.isCrouching ? 1.3 : this.eyeHeight),
      this.position.z
    );
  }

  getAABB(pos = this.position) {
    const hw = this.width / 2;
    const h = this.isCrouching ? 1.45 : this.height;
    return {
      minX: pos.x - hw,
      maxX: pos.x + hw,
      minY: pos.y,
      maxY: pos.y + h,
      minZ: pos.z - hw,
      maxZ: pos.z + hw
    };
  }

  resetRenderInterpolation() {
    this.previousPosition.copy(this.position);
    this.renderSimulationPosition.copy(this.position);
    this.renderInterpolated = false;
    this.dashRenderStep = null;
    this.renderedDashElapsed = null;
  }

  /**
   * Restore a player pose only after all terrain beneath its collision box is
   * available. If the saved feet position is below the world or now intersects
   * edited terrain, raise it to the first free height instead of leaving the
   * character permanently embedded.
   */
  setInitialPosition(x: number, y: number, z: number) {
    this.resetJumpState();
    this.world.preparePlayerSpawnArea?.(x, z, this.width / 2);
    const requestedY = Number(y) || 0;
    const initialY = Math.max(0, requestedY);
    this.position.set(x, initialY, z);
    this.velocity.set(0, 0, 0);
    this.isOnGround = false;
    this.ridingContraption = null;
    this.ridingBodyId = null;

    let adjusted = initialY !== requestedY;
    for (let attempt = 0; attempt < CHUNK_SIZE_Y + 2; attempt++) {
      const overlaps = this.getIntersectingSolidBlocks(this.getAABB());
      if (overlaps.length === 0) break;
      const nextY = Math.max(...overlaps.map(block => block.y + (block.size || 1)));
      if (!(nextY > this.position.y + COLLISION_EPSILON)) break;
      this.position.y = nextY;
      adjusted = true;
    }

    this.resetRenderInterpolation();
    return adjusted;
  }

  capturePreviousPosition() {
    this.previousPosition.copy(this.position);
    this.dashRenderStep = null;
  }

  beginRenderInterpolation(alpha: number) {
    if (this.renderInterpolated) return;
    const amount = Math.max(0, Math.min(1, Number(alpha) || 0));
    this.renderSimulationPosition.copy(this.position);
    this.position.lerpVectors(this.previousPosition, this.renderSimulationPosition, amount);
    this.renderedDashElapsed = null;
    const dash = this.dashRenderStep;
    if (dash) {
      const elapsed = Math.min(dash.end, dash.start + dash.dt * amount);
      const distanceAt = (delta: number) => dashDistance(dash.start, delta, dash.held, dash.entrySlope, dash.exitSlope);
      const span = distanceAt(dash.dt);
      const easedAmount = span > 1e-12 ? distanceAt(dash.dt * amount) / span : amount;
      // Evaluate the same curve between 20 Hz ticks, avoiding stepped speed in
      // first person. Interrupted/colliding steps retain linear safe positions.
      this.position.lerpVectors(this.previousPosition, this.renderSimulationPosition, easedAmount);
      this.renderedDashElapsed = elapsed;
    }
    this.renderInterpolated = true;
  }

  endRenderInterpolation() {
    if (!this.renderInterpolated) return;
    this.position.copy(this.renderSimulationPosition);
    this.renderInterpolated = false;
  }

  update(dt: number, moveInput: PlayerMoveInput, cameraYaw: number, cameraDirection?: THREE.Vector3) {
    this.capturePreviousPosition();
    if (dt > 0.1) dt = 0.1;
    if (!(dt > 0)) return;
    const jumpPressed = moveInput.jumpPressed ?? (!!moveInput.jump && !this.jumpHeld);
    this.jumpHeld = !!moveInput.jump;

    // Follow the solved contact-point transform, not velocity * dt. Collision
    // push-outs and scripted rotations can change the pose without matching
    // velocity; predicting another step also doubles platform motion.
    this.followRidingPlatformPose();

    // 2. Calculate movement vector aligned with camera yaw
    const forward = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw)).normalize();
    const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw)).normalize();

    let targetMove = new THREE.Vector3();
    if (moveInput.forward) targetMove.add(forward);
    if (moveInput.backward) targetMove.sub(forward);
    if (moveInput.right) targetMove.add(right);
    if (moveInput.left) targetMove.sub(right);

    if (targetMove.lengthSq() > 0.001) {
      targetMove.normalize();
    }

    const speed = this.isFlying
      ? (this.isSprinting ? this.flySpeed * 1.8 : this.flySpeed)
      : (this.isSprinting ? this.sprintSpeed : this.walkSpeed);

    if (this.isFlying) {
      this.resetJumpState(!!moveInput.jump);
      // 3D Flying Mode
      this.velocity.x = targetMove.x * speed;
      this.velocity.z = targetMove.z * speed;

      let flyY = 0;
      if (moveInput.jump) flyY += speed;
      if (moveInput.crouch) flyY -= speed;
      this.velocity.y = flyY;

      this.position.x += this.velocity.x * dt;
      this.position.y += this.velocity.y * dt;
      this.position.z += this.velocity.z * dt;
      this.isOnGround = false;
      this.ridingContraption = null;
      this.ridingBodyId = null;
      return;
    }

    if (this.isOnGround) {
      this.stopDash();
      this.airJumpAvailable = true;
    }
    const accel = this.isOnGround ? 14.0 : 4.0;

    // A release ends the sustained portion permanently. A third fresh press
    // also implies a release between ticks and cannot extend the spent dash.
    if (this.isDashing && (!moveInput.jump || jumpPressed)) this.dashHoldAllowed = false;

    // A dash controls all three axes; gravity resumes when it finishes.
    if (!this.isDashing) {
      this.velocity.y += this.gravity * dt;
      if (this.velocity.y < -30) this.velocity.y = -30;
    }

    // Jump
    if (jumpPressed && (this.isOnGround || this.airJumpAvailable)) {
      if (!this.isOnGround) {
        this.airJumpAvailable = false;
        this.dashElapsed = 0;
        this.dashHoldAllowed = !!moveInput.jump;
        // Lock the crosshair's full 3D direction at takeoff, independent of WASD.
        // Headless callers without a camera retain the yaw-aligned default.
        this.dashDirection.copy(forward);
        const directionLengthSq = cameraDirection?.lengthSq() ?? 0;
        if (cameraDirection && Number.isFinite(directionLengthSq) && directionLengthSq > 1e-12) {
          this.dashDirection.copy(cameraDirection).normalize();
        }
        const slopeScale = PLAYER_AIR_DASH_DURATION / PLAYER_AIR_DASH_DISTANCE;
        this.dashEntrySlope = THREE.MathUtils.clamp(this.velocity.dot(this.dashDirection), 0, speed) * slopeScale;
        this.dashExitSlope = Math.max(0, targetMove.dot(this.dashDirection)) * speed * slopeScale;
      } else {
        this.velocity.y = this.jumpForce;
      }
      this.isOnGround = false;
      this.ridingContraption = null;
      this.ridingBodyId = null;
    }

    const dashing = this.isDashing;
    let nextDashElapsed = this.dashElapsed;
    if (dashing) {
      const holding = this.dashHoldAllowed;
      nextDashElapsed = Math.min(holding ? DASH_HOLD_TIME : PLAYER_AIR_DASH_DURATION, this.dashElapsed + dt);
      if (holding && this.dashElapsed >= DASH_HOLD_TIME - 1e-9) {
        // Steer sustained flight toward the live crosshair. Quaternion rotation
        // keeps speed stable even through a 180-degree turn.
        this.dashAim.copy(forward);
        const directionLengthSq = cameraDirection?.lengthSq() ?? 0;
        if (cameraDirection && Number.isFinite(directionLengthSq) && directionLengthSq > 1e-12) {
          this.dashAim.copy(cameraDirection).normalize();
        }
        this.dashTurnTarget.setFromUnitVectors(this.dashDirection, this.dashAim);
        this.dashTurn.identity().slerp(this.dashTurnTarget, 1 - Math.exp(-12 * dt));
        this.dashDirection.applyQuaternion(this.dashTurn).normalize();
      }
      // A tap still integrates to exactly 5 m. Holding extends only the cruise
      // phase; releasing resumes the original eased deceleration.
      const distance = dashDistance(this.dashElapsed, dt, holding, this.dashEntrySlope, this.dashExitSlope);
      this.velocity.copy(this.dashDirection).multiplyScalar(distance / dt);
    } else {
      this.velocity.x += (targetMove.x * speed - this.velocity.x) * Math.min(1.0, accel * dt);
      this.velocity.z += (targetMove.z * speed - this.velocity.z) * Math.min(1.0, accel * dt);
    }

    // Step-by-step collision resolution with terrain AND contraptions
    const startX = this.position.x;
    const startY = this.position.y;
    const startZ = this.position.z;
    const expectedX = this.velocity.x * dt;
    const expectedY = this.velocity.y * dt;
    const expectedZ = this.velocity.z * dt;
    this.moveWithCollision(dt);
    if (dashing) {
      const blocked = Math.abs(this.position.x - startX - expectedX) > COLLISION_EPSILON
        || Math.abs(this.position.y - startY - expectedY) > COLLISION_EPSILON
        || Math.abs(this.position.z - startZ - expectedZ) > COLLISION_EPSILON;
      const completed = nextDashElapsed >= PLAYER_AIR_DASH_DURATION - 1e-9;
      if (!blocked && !this.isOnGround) {
        this.dashRenderStep = { start: this.dashElapsed, end: nextDashElapsed,
          dt, held: this.dashHoldAllowed,
          entrySlope: this.dashEntrySlope, exitSlope: this.dashExitSlope };
      }
      if (blocked || this.isOnGround || completed) {
        this.stopDash();
        if (completed && !blocked && !this.isOnGround) {
          // Continue held forward movement instead of braking to zero for a tick.
          const exitSpeed = Math.max(0, targetMove.dot(this.dashDirection)) * speed;
          this.velocity.copy(this.dashDirection).multiplyScalar(exitSpeed);
        }
      } else {
        this.dashElapsed = nextDashElapsed;
      }
    }
    if (this.isOnGround) this.airJumpAvailable = true;
  }

  moveWithCollision(dt: number) {
    const nearbyContraptions = this.getNearbyContraptions();

    // -----------------------------------------------------------------------
    // 1. Move & Resolve Vertical (Y)
    // -----------------------------------------------------------------------
    const dy = this.velocity.y * dt;
    const previousYAABB = this.getAABB();
    this.position.y += dy;
    this.isOnGround = false;

    // 1a. World Voxel Collision Y
    let aabb = this.getAABB();
    const blocksY = this.getIntersectingSolidBlocks(this.sweptBounds(previousYAABB, aabb));
    const worldVerticalHit = this.resolveWorldVerticalCollision(blocksY, dy, previousYAABB);

    // 1b. Contraption collision Y. Only a downward face crossing can count as
    // landing; side penetration is deliberately never resolved by moving up.
    if (!worldVerticalHit) {
      this.resolveContraptionVerticalSweep(this.getContraptionCollisionBoxes(nearbyContraptions,
        this.sweptBounds(previousYAABB, this.getAABB())), dy, previousYAABB);
    }

    // The world has a hard lower boundary at y=0 even where no voxel is
    // present. Keep a falling player above it instead of allowing gravity to
    // move the character below the world indefinitely.
    if (this.position.y < 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.isOnGround = true;
      this.ridingContraption = null;
      this.ridingBodyId = null;
    }

    // -----------------------------------------------------------------------
    // 2. Move & Resolve Horizontal (X)
    // -----------------------------------------------------------------------
    const dx = this.velocity.x * dt;
    const previousXAABB = this.getAABB();
    this.position.x += dx;
    aabb = this.getAABB();

    // 2a. World Voxel Collision X
    const blocksX = this.getIntersectingSolidBlocks(this.sweptBounds(previousXAABB, aabb));
    this.resolveWorldHorizontalCollision(blocksX, 'x', dx);

    // 2b. Swept cell collision catches a face even when one frame crosses the
    // entire cell, preventing tunnelling at high relative speed.
    this.resolveContraptionHorizontalSweep(this.getContraptionCollisionBoxes(nearbyContraptions,
      this.sweptBounds(previousXAABB, this.getAABB())), 'x', dx, previousXAABB);

    // -----------------------------------------------------------------------
    // 3. Move & Resolve Horizontal (Z)
    // -----------------------------------------------------------------------
    const dz = this.velocity.z * dt;
    const previousZAABB = this.getAABB();
    this.position.z += dz;
    aabb = this.getAABB();

    // 3a. World Voxel Collision Z
    const blocksZ = this.getIntersectingSolidBlocks(this.sweptBounds(previousZAABB, aabb));
    this.resolveWorldHorizontalCollision(blocksZ, 'z', dz);

    // 3b. Contraption Collision Z
    this.resolveContraptionHorizontalSweep(this.getContraptionCollisionBoxes(nearbyContraptions,
      this.sweptBounds(previousZAABB, this.getAABB())), 'z', dz, previousZAABB);

    // Recover moving-entity contacts. Side penetration still resolves only in
    // X/Z; riding and a real upward face crossing are separate from auto-step.
    this.resolveDynamicContraptionOverlaps(nearbyContraptions);
    if (!this.isOnGround) {
      this.ridingContraption = null;
      this.ridingBodyId = null;
    }
    this.captureRidingPlatformPose();
  }

  private captureRidingPlatformPose() {
    const contraption = this.ridingContraption;
    const bodyId = entityBodyId(contraption, this.ridingBodyId);
    const group = contraption?.entityNodes?.get?.(bodyId)?.group;
    if (!contraption || !this.isOnGround || !group) {
      this.ridingPlatformPose = null;
      return;
    }
    group.updateWorldMatrix(true, false);
    if (this.ridingPlatformPose?.contraption !== contraption || this.ridingPlatformPose.bodyId !== bodyId) {
      this.ridingPlatformPose = { contraption, bodyId, matrix: group.matrixWorld.clone() };
    } else {
      this.ridingPlatformPose.matrix.copy(group.matrixWorld);
    }
  }

  private followRidingPlatformPose() {
    const contraption = this.ridingContraption;
    if (!contraption || !this.isOnGround || this.isFlying) {
      this.ridingPlatformPose = null;
      return false;
    }
    if (!this.contraptionManager?.contraptions?.includes(contraption)) {
      this.ridingContraption = null;
      this.ridingBodyId = null;
      this.ridingPlatformPose = null;
      this.isOnGround = false;
      return false;
    }
    const bodyId = entityBodyId(contraption, this.ridingBodyId);
    if (contraption.isNodeCollisionEnabled?.(bodyId) === false) {
      this.ridingContraption = null;
      this.ridingBodyId = null;
      this.ridingPlatformPose = null;
      this.isOnGround = false;
      return false;
    }
    const group = contraption.entityNodes?.get?.(bodyId)?.group;
    const previous = this.ridingPlatformPose;
    if (!group || previous?.contraption !== contraption || previous.bodyId !== bodyId) {
      this.captureRidingPlatformPose();
      return false;
    }
    group.updateWorldMatrix(true, false);
    if (previous.matrix.equals(group.matrixWorld)) return false;
    this.ridingTargetPosition.copy(this.position)
      .applyMatrix4(this.ridingInverseMatrix.copy(previous.matrix).invert())
      .applyMatrix4(group.matrixWorld);
    this.ridingDisplacement.subVectors(this.ridingTargetPosition, this.position);
    previous.matrix.copy(group.matrixWorld);
    if (this.ridingDisplacement.lengthSq() <= 1e-24) return false;

    // Platform carriage must still respect ceilings, terrain walls and other
    // entities. Do not collide against the carrier's own previous swept volume.
    this.moveWithExternalDisplacement(this.ridingDisplacement, contraption);
    return true;
  }

  private refreshRidingSupport() {
    if (!this.ridingContraption || !this.isOnGround) return;
    const aabb = this.getAABB();
    const bounds = { ...aabb, minY: aabb.minY - COLLISION_EPSILON, maxY: aabb.minY + COLLISION_EPSILON };
    const supported = this.getContraptionCollisionBoxes([this.ridingContraption], bounds).some(box => (
      Math.abs(box.maxY - aabb.minY) <= COLLISION_EPSILON
      && this.intervalsOverlap(aabb.minX, aabb.maxX, box.minX, box.maxX)
      && this.intervalsOverlap(aabb.minZ, aabb.maxZ, box.minZ, box.maxZ)
    ));
    if (!supported) {
      this.isOnGround = false;
      this.ridingContraption = null;
      this.ridingBodyId = null;
      this.ridingPlatformPose = null;
    }
  }

  private moveWithExternalDisplacement(displacement: THREE.Vector3, carrier: Contraption) {
    const others = this.getNearbyContraptions().filter(entity => entity !== carrier);
    for (const axis of ['y', 'x', 'z'] as const) {
      const delta = displacement[axis];
      if (Math.abs(delta) <= 1e-12) continue;
      const before = this.getAABB();
      this.position[axis] += delta;
      const bounds = this.sweptBounds(before, this.getAABB());
      const blocks = this.getIntersectingSolidBlocks(bounds);
      if (axis === 'y') {
        if (!this.resolveWorldVerticalCollision(blocks, delta, before)) {
          this.resolveContraptionVerticalSweep(this.getContraptionCollisionBoxes(others, bounds), delta, before);
        }
      } else {
        this.resolveWorldHorizontalCollision(blocks, axis, delta);
        this.resolveContraptionHorizontalSweep(this.getContraptionCollisionBoxes(others, bounds), axis, delta, before);
      }
    }
  }

  /** Keep moving-entity CCD separate from current-pose overlap recovery. The
   * swept broadphase envelope is never a persistent floor or a solid wall. */
  private resolveMovingContraptionSweeps(contraptions: Contraption[]) {
    let moved = false;
    for (const contraption of contraptions) {
      let observed = this.observedColliderPoses.get(contraption);
      if (!observed) this.observedColliderPoses.set(contraption, observed = new Map());
      const movingNodes = new Set<string>();
      for (const node of contraption.entityNodes?.values?.() || []) {
        node.group.updateWorldMatrix(true, false);
        const previous = observed.get(node.id);
        if (previous && node.previousWorldMatrix && !previous.equals(node.group.matrixWorld)
          && previous.equals(node.previousWorldMatrix)) movingNodes.add(node.id);
        if (previous) previous.copy(node.group.matrixWorld);
        else observed.set(node.id, node.group.matrixWorld.clone());
      }
      if (contraption === this.ridingContraption || movingNodes.size === 0) continue;
      const candidates = contraption.queryCollisionWorldAABBs?.(this.getAABB()) || [];
      for (const box of candidates) {
        if (!movingNodes.has(box.entityId)) continue;
        const aabb = this.getAABB();
        let entry = -Infinity, exit = Infinity;
        let hitAxis: 'x' | 'y' | 'z' | null = null;
        let hitSign = 0;
        for (const axis of ['x', 'y', 'z'] as const) {
          const suffix = AXIS_SUFFIX[axis];
          const previousMin = box[`previousMin${suffix}`], previousMax = box[`previousMax${suffix}`];
          const currentMin = box[`currentMin${suffix}`], currentMax = box[`currentMax${suffix}`];
          // Linear face sweeps are exact for translations. Rotating intrusions
          // continue through current-pose overlap recovery, not inflated CCD.
          if (Math.abs((currentMax - currentMin) - (previousMax - previousMin)) > COLLISION_EPSILON) {
            exit = -Infinity;
            break;
          }
          const delta = currentMin - previousMin;
          const min = aabb[`min${suffix}`], max = aabb[`max${suffix}`];
          if (Math.abs(delta) <= COLLISION_EPSILON) {
            if (!this.intervalsOverlap(min, max, previousMin, previousMax)) { exit = -Infinity; break; }
            continue;
          }
          const near = (delta > 0 ? min - previousMax : max - previousMin) / delta;
          const far = (delta > 0 ? max - previousMin : min - previousMax) / delta;
          if (near > entry) { entry = near; hitAxis = axis; hitSign = Math.sign(delta); }
          exit = Math.min(exit, far);
        }
        if (!hitAxis || entry < 0 || entry > 1 || entry > exit) continue;
        const normal = new THREE.Vector3();
        normal[hitAxis] = hitSign;
        const surface = box[`${hitSign > 0 ? 'currentMax' : 'currentMin'}${AXIS_SUFFIX[hitAxis]}`];
        const contactPoint = this.position.clone();
        contactPoint[hitAxis] = surface;
        const closingSpeed = this.getContraptionBodyPointVelocity(contraption,
          entityBodyId(contraption, box.bodyId ?? box.entityId), contactPoint).sub(this.velocity).dot(normal);
        this.recordPlayerContact(box, normal.clone().negate(), closingSpeed, contactPoint);
        const target = surface + (hitAxis === 'y'
          ? (hitSign > 0 ? 0 : -(this.isCrouching ? 1.45 : this.height))
          : hitSign * this.width / 2);
        this.moveWithExternalDisplacement(normal.multiplyScalar((target - this.position[hitAxis]) * hitSign), contraption);
        this.velocity[hitAxis] = 0;
        if (hitAxis === 'y' && hitSign > 0) {
          this.isOnGround = true;
          this.ridingContraption = contraption;
          this.ridingBodyId = entityBodyId(contraption, box.bodyId ?? box.entityId);
        }
        moved = true;
      }
    }
    return moved;
  }

  getNearbyContraptions() {
    if (!this.contraptionManager || !this.contraptionManager.contraptions) return [];
    const nearby = [];
    for (const c of this.contraptionManager.contraptions) {
      const center = typeof c.getWorldCenter === 'function'
        ? c.getWorldCenter()
        : (c.localCenter ? c.localToWorld(c.localCenter.clone()) : c.position);
      const radius = Math.max(1.0, Number(c.boundingRadius) || 1.0);
      const dist = Math.min(
        this.position.distanceTo(center),
        this.position.distanceTo(c.position)
      );
      if (dist < radius + 4.0) {
        nearby.push(c);
      }
    }
    return nearby;
  }

  private sweptBounds(a: CollisionBounds, b: CollisionBounds) {
    return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ) };
  }

  getContraptionCollisionBoxes(contraptions: Contraption[] = this.getNearbyContraptions(), bounds: CollisionBounds | null = null) {
    const boxes = [];
    for (const contraption of contraptions) {
      if (typeof contraption.getCollisionWorldAABBs !== 'function') continue;
      const candidates = bounds && typeof contraption.queryCollisionWorldAABBs === 'function'
        ? contraption.queryCollisionWorldAABBs(bounds)
        : contraption.getCollisionWorldAABBs();
      // Swept bounds are broadphase candidates, not solid volume. Resolving
      // against their previous/current union creates ghost floors and walls.
      for (const box of candidates) {
        let current = this.currentCollisionBoxes.get(box);
        if (!current) {
          current = { ...box,
            minX: box.currentMinX ?? box.minX, maxX: box.currentMaxX ?? box.maxX,
            minY: box.currentMinY ?? box.minY, maxY: box.currentMaxY ?? box.maxY,
            minZ: box.currentMinZ ?? box.minZ, maxZ: box.currentMaxZ ?? box.maxZ };
          this.currentCollisionBoxes.set(box, current);
        }
        boxes.push(current);
      }
    }
    return boxes;
  }

  getContraptionBodyPointVelocity(contraption: Contraption | null, bodyId = entityBodyId(contraption), worldPoint: THREE.Vector3 = this.position) {
    const body = contraption?.getRigidBody?.(entityBodyId(contraption, bodyId));
    if (!body) return contraption?.getVelocityAtPoint?.(worldPoint) || new THREE.Vector3();
    const lever = worldPoint.clone().sub(body.position);
    return body.velocity.clone().add(body.angularVelocity.clone().cross(lever));
  }

  /**
   * Player/entity collision is deliberately one-way. Every endpoint can resolve
   * its local character against the authoritative entity pose, but only one
   * endpoint advances entity physics. Record the contact for scripts without
   * allowing the local player to mutate entity velocity or wake sleeping bodies.
   */
  recordPlayerContact(box: EntityCollisionBounds, direction: THREE.Vector3, relativeClosingSpeed: number, worldPoint: THREE.Vector3) {
    if (!box) return false;
    const normal = direction.clone().normalize();
    box.contraption?.recordScriptContact?.({
      kind: 'player',
      selfNodeId: entityBodyId(box.contraption, box.entityId ?? box.bodyId),
      otherEntityId: null,
      otherNodeId: null,
      playerId: 'local',
      position: worldPoint?.toArray?.() || [0, 0, 0],
      normal: normal.toArray(),
      relativeVelocity: normal.clone().multiplyScalar(Number(relativeClosingSpeed) || 0).toArray(),
      impulse: 0
    });
    return true;
  }

  intervalsOverlap(minA: number, maxA: number, minB: number, maxB: number) {
    return maxA > minB + COLLISION_EPSILON && minA < maxB - COLLISION_EPSILON;
  }

  aabbIntersects(a: CollisionBounds, b: CollisionBounds) {
    return this.intervalsOverlap(a.minX, a.maxX, b.minX, b.maxX)
      && this.intervalsOverlap(a.minY, a.maxY, b.minY, b.maxY)
      && this.intervalsOverlap(a.minZ, a.maxZ, b.minZ, b.maxZ);
  }

  getBlockAABB(block: SolidBlock) {
    const size = block.size || 1;
    return {
      minX: block.x,
      maxX: block.x + size,
      minY: block.y,
      maxY: block.y + size,
      minZ: block.z,
      maxZ: block.z + size
    };
  }

  resolveWorldVerticalCollision(blocks: SolidBlock[], dy: number, previousAABB: CollisionBounds) {
    if (Math.abs(dy) <= COLLISION_EPSILON) return false;

    const currentAABB = this.getAABB();
    let surface = null;

    for (const block of blocks) {
      const box = this.getBlockAABB(block);
      if (!this.intervalsOverlap(currentAABB.minX, currentAABB.maxX, box.minX, box.maxX)
        || !this.intervalsOverlap(currentAABB.minZ, currentAABB.maxZ, box.minZ, box.maxZ)) {
        continue;
      }

      if (dy < 0) {
        // A neighboring wall is not ground. The player's previous feet must
        // actually have been on/above this top face before falling through it.
        const crossedTop = previousAABB.minY >= box.maxY - COLLISION_EPSILON
          && currentAABB.minY <= box.maxY;
        if (crossedTop && (surface === null || box.maxY > surface)) surface = box.maxY;
      } else {
        const crossedBottom = previousAABB.maxY <= box.minY + COLLISION_EPSILON
          && currentAABB.maxY >= box.minY;
        if (crossedBottom && (surface === null || box.minY < surface)) surface = box.minY;
      }
    }

    if (surface === null) return false;

    if (dy < 0) {
      this.position.y = surface;
      this.isOnGround = true;
      this.ridingContraption = null;
      this.ridingBodyId = null;
    } else {
      const h = this.isCrouching ? 1.45 : this.height;
      this.position.y = surface - h;
    }
    this.velocity.y = 0;
    return true;
  }

  resolveWorldHorizontalCollision(blocks: SolidBlock[], axis: 'x' | 'z', delta: number) {
    if (Math.abs(delta) <= COLLISION_EPSILON || blocks.length === 0) return false;

    const halfWidth = this.width / 2;
    let stop = null;

    for (const block of blocks) {
      const box = this.getBlockAABB(block);
      const candidate = delta > 0
        ? (axis === 'x' ? box.minX : box.minZ) - halfWidth
        : (axis === 'x' ? box.maxX : box.maxZ) + halfWidth;

      if (delta > 0 && (stop === null || candidate < stop)) stop = candidate;
      if (delta < 0 && (stop === null || candidate > stop)) stop = candidate;
    }

    if (stop === null) return false;
    this.position[axis] = stop;
    this.velocity[axis] = 0;
    return true;
  }

  resolveContraptionVerticalSweep(collisionBoxes: EntityCollisionBounds[], dy: number, previousAABB: CollisionBounds) {
    if (Math.abs(dy) <= COLLISION_EPSILON) return false;

    const currentAABB = this.getAABB();
    let hit = null;

    for (const box of collisionBoxes) {
      if (!this.intervalsOverlap(currentAABB.minX, currentAABB.maxX, box.minX, box.maxX)
        || !this.intervalsOverlap(currentAABB.minZ, currentAABB.maxZ, box.minZ, box.maxZ)) {
        continue;
      }

      if (dy < 0) {
        const crossedTop = previousAABB.minY >= box.maxY - COLLISION_EPSILON
          && currentAABB.minY <= box.maxY
          && currentAABB.maxY > box.minY;
        if (crossedTop && (!hit || box.maxY > hit.surface)) {
          hit = { surface: box.maxY, contraption: box.contraption, box };
        }
      } else {
        const crossedBottom = previousAABB.maxY <= box.minY + COLLISION_EPSILON
          && currentAABB.maxY >= box.minY
          && currentAABB.minY < box.maxY;
        if (crossedBottom && (!hit || box.minY < hit.surface)) {
          hit = { surface: box.minY, contraption: box.contraption, box };
        }
      }
    }

    if (!hit) return false;

    const contactPoint = new THREE.Vector3(this.position.x, hit.surface, this.position.z);
    const bodyVelocity = this.getContraptionBodyPointVelocity(
      hit.contraption,
      entityBodyId(hit.contraption, hit.box.bodyId ?? hit.box.entityId),
      contactPoint
    );
    const impulseDirection = new THREE.Vector3(0, dy < 0 ? -1 : 1, 0);
    const attached = this.ridingPlatformPose?.contraption === hit.contraption
      && this.ridingPlatformPose.bodyId === entityBodyId(hit.contraption, hit.box.bodyId ?? hit.box.entityId);
    // An attached rider's velocity is already relative to the transported
    // platform pose. Subtracting carrier velocity again invents extra impacts.
    const relativeClosingSpeed = (attached ? this.velocity : this.velocity.clone().sub(bodyVelocity)).dot(impulseDirection);
    this.recordPlayerContact(hit.box, impulseDirection, relativeClosingSpeed, contactPoint);

    if (dy < 0) {
      this.position.y = hit.surface;
      this.isOnGround = true;
      this.ridingContraption = hit.contraption;
      this.ridingBodyId = entityBodyId(hit.contraption, hit.box.bodyId ?? hit.box.entityId);
      this.captureRidingPlatformPose();
    } else {
      const h = this.isCrouching ? 1.45 : this.height;
      this.position.y = hit.surface - h;
    }
    this.velocity.y = 0;
    return true;
  }

  resolveContraptionHorizontalSweep(collisionBoxes: EntityCollisionBounds[], axis: 'x' | 'z', delta: number, previousAABB: CollisionBounds) {
    if (Math.abs(delta) <= COLLISION_EPSILON) return false;

    const currentAABB = this.getAABB();
    const halfWidth = this.width / 2;
    let hit = null;

    for (const box of collisionBoxes) {
      const overlapsOtherAxes = axis === 'x'
        ? this.intervalsOverlap(currentAABB.minY, currentAABB.maxY, box.minY, box.maxY)
          && this.intervalsOverlap(currentAABB.minZ, currentAABB.maxZ, box.minZ, box.maxZ)
        : this.intervalsOverlap(currentAABB.minY, currentAABB.maxY, box.minY, box.maxY)
          && this.intervalsOverlap(currentAABB.minX, currentAABB.maxX, box.minX, box.maxX);
      if (!overlapsOtherAxes) continue;

      const minKey = axis === 'x' ? 'minX' : 'minZ';
      const maxKey = axis === 'x' ? 'maxX' : 'maxZ';

      if (delta > 0) {
        const crossedNearFace = previousAABB[maxKey] <= box[minKey] + FACE_TOLERANCE
          && currentAABB[maxKey] >= box[minKey];
        const candidate = box[minKey] - halfWidth;
        if (crossedNearFace && (!hit || candidate < hit.stop)) hit = { stop: candidate, box };
      } else {
        const crossedNearFace = previousAABB[minKey] >= box[maxKey] - FACE_TOLERANCE
          && currentAABB[minKey] <= box[maxKey];
        const candidate = box[maxKey] + halfWidth;
        if (crossedNearFace && (!hit || candidate > hit.stop)) hit = { stop: candidate, box };
      }
    }

    if (!hit) return false;
    const direction = new THREE.Vector3();
    direction[axis] = delta > 0 ? 1 : -1;
    const contactPoint = new THREE.Vector3(
      axis === 'x' ? (delta > 0 ? hit.box.minX : hit.box.maxX) : this.position.x,
      Math.max(hit.box.minY, Math.min(hit.box.maxY, this.position.y + this.height * 0.5)),
      axis === 'z' ? (delta > 0 ? hit.box.minZ : hit.box.maxZ) : this.position.z
    );
    const bodyVelocity = this.getContraptionBodyPointVelocity(
      hit.box.contraption,
      entityBodyId(hit.box.contraption, hit.box.bodyId ?? hit.box.entityId),
      contactPoint
    );
    const relativeClosingSpeed = this.velocity.clone().sub(bodyVelocity).dot(direction);
    this.recordPlayerContact(hit.box, direction, relativeClosingSpeed, contactPoint);

    this.position[axis] = hit.stop;
    this.velocity[axis] = 0;
    return true;
  }

  /**
   * Resolve overlap caused by a moving entity after the player's own sweep.
   * There is intentionally no Y side-penetration candidate: side contact may push the
   * player sideways, but can never act like automatic climbing or teleport up.
   */
  resolveDynamicContraptionOverlaps(contraptions: Contraption[] = this.getNearbyContraptions()) {
    if (this.isFlying || contraptions.length === 0) return false;

    let moved = this.followRidingPlatformPose();
    moved = this.resolveMovingContraptionSweeps(contraptions) || moved;

    for (let iteration = 0; iteration < 6; iteration++) {
      const aabb = this.getAABB();
      const overlaps = this.getContraptionCollisionBoxes(contraptions, aabb)
        .filter(box => this.aabbIntersects(aabb, box));
      if (overlaps.length === 0) break;

      // Standing on a ridden contraption: entity position corrections (terrain
      // push-out, entity-entity impulses) modify position directly without
      // touching velocity, so the player's velocity-follow can lag a few mm
      // into the top face. Lift the player back onto the face and keep riding
      // instead of shoving them sideways off the platform.
      const standingBox = overlaps.filter(box =>
        box.contraption === this.ridingContraption &&
        entityBodyId(box.contraption, box.bodyId ?? box.entityId) === entityBodyId(this.ridingContraption, this.ridingBodyId) &&
        aabb.minY >= box.maxY - STAND_TOLERANCE
      ).sort((a, b) => b.maxY - a.maxY)[0];
      if (standingBox) {
        this.position.y = standingBox.maxY;
        this.velocity.y = 0;
        this.isOnGround = true;
        moved = true;
        continue;
      }

      const correctionCandidates: {axis: 'x' | 'z'; amount: number}[] = [
        {
          axis: 'x',
          amount: Math.min(...overlaps.map(box => box.minX - aabb.maxX)) - COLLISION_EPSILON
        },
        {
          axis: 'x',
          amount: Math.max(...overlaps.map(box => box.maxX - aabb.minX)) + COLLISION_EPSILON
        },
        {
          axis: 'z',
          amount: Math.min(...overlaps.map(box => box.minZ - aabb.maxZ)) - COLLISION_EPSILON
        },
        {
          axis: 'z',
          amount: Math.max(...overlaps.map(box => box.maxZ - aabb.minZ)) + COLLISION_EPSILON
        }
      ];
      correctionCandidates.sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
      const correction = correctionCandidates[0];

      // If a moving body created the overlap, retain its closing velocity in
      // the one-way player contact record without mutating entity dynamics.
      const playerNormal = new THREE.Vector3();
      playerNormal[correction.axis] = Math.sign(correction.amount) || 1;
      const contactPoint = new THREE.Vector3(
        this.position.x,
        Math.max(aabb.minY, Math.min(aabb.maxY, this.position.y + this.height * 0.5)),
        this.position.z
      );
      let impactBox = null;
      let impactSpeed = 0;
      for (const box of overlaps) {
        const bodyVelocity = this.getContraptionBodyPointVelocity(
          box.contraption,
          entityBodyId(box.contraption, box.bodyId ?? box.entityId),
          contactPoint
        );
        const closingSpeed = bodyVelocity.clone().sub(this.velocity).dot(playerNormal);
        if (closingSpeed > impactSpeed) {
          impactSpeed = closingSpeed;
          impactBox = box;
        }
      }
      if (impactBox) {
        this.recordPlayerContact(
          impactBox,
          playerNormal.clone().multiplyScalar(-1),
          impactSpeed,
          contactPoint
        );
      }

      this.position[correction.axis] += correction.amount;
      this.velocity[correction.axis] = 0;
      this.ridingContraption = null;
      this.ridingBodyId = null;
      moved = true;
    }

    this.refreshRidingSupport();
    this.captureRidingPlatformPose();
    return moved;
  }

  getIntersectingSolidBlocks(aabb: CollisionBounds) {
    const minX = Math.floor(aabb.minX);
    const maxX = Math.floor(aabb.maxX);
    const minY = Math.floor(aabb.minY);
    const maxY = Math.floor(aabb.maxY);
    const minZ = Math.floor(aabb.minZ);
    const maxZ = Math.floor(aabb.maxZ);

    const solidBlocks = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = this.world.getBlock(x, y, z);
          if (block !== BlockTypes.AIR) {
            solidBlocks.push({ x, y, z, size: 1, block });
          }
        }
      }
    }
    solidBlocks.push(...this.world.getMicroBlocksInAABB(aabb, true));

    // Integer scan bounds include cells that merely touch the player's AABB.
    // Filter those out so walking parallel to an adjacent block cannot be
    // misread as penetration or a vertical landing.
    return solidBlocks.filter(block => this.aabbIntersects(aabb, this.getBlockAABB(block)));
  }
}

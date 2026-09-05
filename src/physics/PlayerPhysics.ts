import * as THREE from 'three';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import type { World } from '../voxel/World.ts';

const COLLISION_EPSILON = 1e-5;
const FACE_TOLERANCE = 0.08;
// Treat shallow foot penetration below a mounted entity's top surface as standing
// on the platform, then lift the player to the top instead of pushing sideways.
const STAND_TOLERANCE = 0.4;

export const PLAYER_MASS_KG = 50;
export const PLAYER_GRAVITY_MPS2 = -24;

function entityBodyId(contraption: any, value?: unknown): string {
  if (value !== undefined && value !== null) return String(value);
  if (typeof contraption?.rootComponentId === 'string') return contraption.rootComponentId;
  for (const node of contraption?.entityNodes?.values?.() || []) {
    if (node?.parentId === null) return String(node.id);
  }
  return '';
}

export class PlayerPhysics {
  world: World;
  contraptionManager: any;

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

  // Moving Platform attachment (when standing on a moving contraption)
  ridingContraption: any;
  ridingBodyId: string | null;
  lastRidingPlatformPos: any;

  constructor(world, contraptionManager = null) {
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

  setContraptionManager(contraptionManager) {
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
  }

  /**
   * Restore a player pose only after all terrain beneath its collision box is
   * available. If the saved feet position is below the world or now intersects
   * edited terrain, raise it to the first free height instead of leaving the
   * character permanently embedded.
   */
  setInitialPosition(x: number, y: number, z: number) {
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
  }

  beginRenderInterpolation(alpha) {
    if (this.renderInterpolated) return;
    const amount = Math.max(0, Math.min(1, Number(alpha) || 0));
    this.renderSimulationPosition.copy(this.position);
    this.position.lerpVectors(this.previousPosition, this.renderSimulationPosition, amount);
    this.renderInterpolated = true;
  }

  endRenderInterpolation() {
    if (!this.renderInterpolated) return;
    this.position.copy(this.renderSimulationPosition);
    this.renderInterpolated = false;
  }

  update(dt, moveInput, cameraYaw) {
    this.capturePreviousPosition();
    if (dt > 0.1) dt = 0.1;

    // 1. Moving Platform Attachment (Ride on moving contraptions smoothly)
    if (this.ridingContraption && this.isOnGround) {
      if (this.contraptionManager && this.contraptionManager.contraptions.includes(this.ridingContraption)) {
        const platVel = this.getContraptionBodyPointVelocity(
          this.ridingContraption,
          entityBodyId(this.ridingContraption, this.ridingBodyId),
          this.position
        );
        this.position.x += platVel.x * dt;
        this.position.y += platVel.y * dt;
        this.position.z += platVel.z * dt;
      } else {
        this.ridingContraption = null;
        this.ridingBodyId = null;
      }
    }

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

    // Ground/Walk Physics
    const accel = this.isOnGround ? 14.0 : 4.0;
    this.velocity.x += (targetMove.x * speed - this.velocity.x) * Math.min(1.0, accel * dt);
    this.velocity.z += (targetMove.z * speed - this.velocity.z) * Math.min(1.0, accel * dt);

    // Gravity
    this.velocity.y += this.gravity * dt;
    if (this.velocity.y < -30) this.velocity.y = -30;

    // Jump
    if (moveInput.jump && this.isOnGround) {
      if (this.ridingContraption) {
        // The character controller owns the requested jump velocity. Transfer
        // its equal-and-opposite momentum change to the supporting dynamic body.
        const jumpDeltaVelocity = Math.max(0, this.jumpForce - this.velocity.y);
        this.applyContraptionImpulse(
          this.ridingContraption,
          entityBodyId(this.ridingContraption, this.ridingBodyId),
          new THREE.Vector3(0, -this.mass * jumpDeltaVelocity, 0),
          this.position.clone()
        );
      }
      this.velocity.y = this.jumpForce;
      this.isOnGround = false;
      this.ridingContraption = null;
      this.ridingBodyId = null;
    }

    // Step-by-step collision resolution with terrain AND contraptions
    this.moveWithCollision(dt);
  }

  moveWithCollision(dt) {
    const nearbyContraptions = this.getNearbyContraptions();
    const collisionBoxes = this.getContraptionCollisionBoxes(nearbyContraptions);

    // -----------------------------------------------------------------------
    // 1. Move & Resolve Vertical (Y)
    // -----------------------------------------------------------------------
    const dy = this.velocity.y * dt;
    const previousYAABB = this.getAABB();
    this.position.y += dy;
    this.isOnGround = false;

    // 1a. World Voxel Collision Y
    let aabb = this.getAABB();
    const blocksY = this.getIntersectingSolidBlocks(aabb);
    const worldVerticalHit = this.resolveWorldVerticalCollision(blocksY, dy, previousYAABB);

    // 1b. Contraption collision Y. Only a downward face crossing can count as
    // landing; side penetration is deliberately never resolved by moving up.
    if (!worldVerticalHit) {
      this.resolveContraptionVerticalSweep(collisionBoxes, dy, previousYAABB);
    }

    // -----------------------------------------------------------------------
    // 2. Move & Resolve Horizontal (X)
    // -----------------------------------------------------------------------
    const dx = this.velocity.x * dt;
    const previousXAABB = this.getAABB();
    this.position.x += dx;
    aabb = this.getAABB();

    // 2a. World Voxel Collision X
    const blocksX = this.getIntersectingSolidBlocks(aabb);
    this.resolveWorldHorizontalCollision(blocksX, 'x', dx);

    // 2b. Swept cell collision catches a face even when one frame crosses the
    // entire cell, preventing tunnelling at high relative speed.
    this.resolveContraptionHorizontalSweep(collisionBoxes, 'x', dx, previousXAABB);

    // -----------------------------------------------------------------------
    // 3. Move & Resolve Horizontal (Z)
    // -----------------------------------------------------------------------
    const dz = this.velocity.z * dt;
    const previousZAABB = this.getAABB();
    this.position.z += dz;
    aabb = this.getAABB();

    // 3a. World Voxel Collision Z
    const blocksZ = this.getIntersectingSolidBlocks(aabb);
    this.resolveWorldHorizontalCollision(blocksZ, 'z', dz);

    // 3b. Contraption Collision Z
    this.resolveContraptionHorizontalSweep(collisionBoxes, 'z', dz, previousZAABB);

    // Recover from an entity that started the frame overlapping the player.
    // This routine only moves in X/Z, so it cannot become an auto-step system.
    this.resolveDynamicContraptionOverlaps(nearbyContraptions);
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

  getContraptionCollisionBoxes(contraptions = this.getNearbyContraptions()) {
    const boxes = [];
    for (const contraption of contraptions) {
      if (typeof contraption.getCollisionWorldAABBs !== 'function') continue;
      boxes.push(...contraption.getCollisionWorldAABBs());
    }
    return boxes;
  }

  getContraptionBodyPointVelocity(contraption, bodyId = entityBodyId(contraption), worldPoint = this.position) {
    const body = contraption?.getRigidBody?.(entityBodyId(contraption, bodyId));
    if (!body) return contraption?.getVelocityAtPoint?.(worldPoint) || new THREE.Vector3();
    const lever = worldPoint.clone().sub(body.position);
    return body.velocity.clone().add(body.angularVelocity.clone().cross(lever));
  }

  /** Apply a world-space impulse to one dynamic entity body. A contact on a
   * kinematic component is absorbed by its nearest dynamic ancestor, mirroring
   * entity-entity resolution: the component is a scene-graph child, so the
   * entity must still react when its arm is hit. */
  applyContraptionImpulse(contraption, bodyId, impulse, worldPoint) {
    if (!contraption || !impulse || impulse.lengthSq() <= 1e-12) return false;
    const owner = contraption.getRigidBody?.(entityBodyId(contraption, bodyId));
    if (!owner) return false;
    const physics = this.contraptionManager?.physics;
    if (typeof physics?.applyImpulse !== 'function') return false;
    const body = typeof physics.contactBodyFor === 'function'
      ? physics.contactBodyFor(contraption, owner)
      : owner;
    if (body.type !== 'dynamic' || body.simulationEnabled === false) return false;
    physics.applyImpulse(contraption, impulse, worldPoint, body.id);
    return true;
  }

  /**
   * The player is an authoritative character controller, but presents a finite
   * 50kg contact mass to dynamic entities. Whenever collision resolution removes
   * relative closing velocity from the player, transfer that momentum to the body.
   */
  applyPlayerContactImpulse(box, direction, relativeClosingSpeed, worldPoint) {
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
      impulse: Math.max(0, Number(relativeClosingSpeed) || 0) * this.mass
    });
    if (!(relativeClosingSpeed > 0)) return false;
    return this.applyContraptionImpulse(
      box.contraption,
      entityBodyId(box.contraption, box.bodyId ?? box.entityId),
      normal.multiplyScalar(this.mass * relativeClosingSpeed),
      worldPoint
    );
  }

  intervalsOverlap(minA, maxA, minB, maxB) {
    return maxA > minB + COLLISION_EPSILON && minA < maxB - COLLISION_EPSILON;
  }

  aabbIntersects(a, b) {
    return this.intervalsOverlap(a.minX, a.maxX, b.minX, b.maxX)
      && this.intervalsOverlap(a.minY, a.maxY, b.minY, b.maxY)
      && this.intervalsOverlap(a.minZ, a.maxZ, b.minZ, b.maxZ);
  }

  getBlockAABB(block) {
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

  resolveWorldVerticalCollision(blocks, dy, previousAABB) {
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

  resolveWorldHorizontalCollision(blocks, axis, delta) {
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

  resolveContraptionVerticalSweep(collisionBoxes, dy, previousAABB) {
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
    const relativeClosingSpeed = this.velocity.clone().sub(bodyVelocity).dot(impulseDirection);
    this.applyPlayerContactImpulse(hit.box, impulseDirection, relativeClosingSpeed, contactPoint);

    if (dy < 0) {
      this.position.y = hit.surface;
      this.isOnGround = true;
      this.ridingContraption = hit.contraption;
      this.ridingBodyId = entityBodyId(hit.contraption, hit.box.bodyId ?? hit.box.entityId);
    } else {
      const h = this.isCrouching ? 1.45 : this.height;
      this.position.y = hit.surface - h;
    }
    this.velocity.y = 0;
    return true;
  }

  resolveContraptionHorizontalSweep(collisionBoxes, axis, delta, previousAABB) {
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
    this.applyPlayerContactImpulse(hit.box, direction, relativeClosingSpeed, contactPoint);

    this.position[axis] = hit.stop;
    this.velocity[axis] = 0;
    return true;
  }

  /**
   * Resolve overlap caused by a moving entity after the player's own sweep.
   * There is intentionally no Y candidate here: side contact may push the
   * player sideways, but can never act like automatic climbing or teleport up.
   */
  resolveDynamicContraptionOverlaps(contraptions = this.getNearbyContraptions()) {
    if (this.isFlying || contraptions.length === 0) return false;

    const collisionBoxes = this.getContraptionCollisionBoxes(contraptions);
    let moved = false;

    for (let iteration = 0; iteration < 6; iteration++) {
      const aabb = this.getAABB();
      const overlaps = collisionBoxes.filter(box => this.aabbIntersects(aabb, box));
      if (overlaps.length === 0) break;

      // Standing on a ridden contraption: entity position corrections (terrain
      // push-out, entity-entity impulses) modify position directly without
      // touching velocity, so the player's velocity-follow can lag a few mm
      // into the top face. Lift the player back onto the face and keep riding
      // instead of shoving them sideways off the platform.
      const standingBox = overlaps.find(box =>
        box.contraption === this.ridingContraption &&
        aabb.minY >= box.maxY - STAND_TOLERANCE
      );
      if (standingBox) {
        this.position.y = standingBox.maxY;
        this.velocity.y = 0;
        this.isOnGround = true;
        moved = true;
        continue;
      }

      const correctionCandidates = [
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

      // If a moving dynamic body created the overlap, treat the correction
      // direction as the contact normal from body to player and apply the
      // opposite 50kg collision impulse back to the body.
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
        this.applyPlayerContactImpulse(
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

    return moved;
  }

  getIntersectingSolidBlocks(aabb) {
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

import * as THREE from 'three';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { BodyType } from '../contraption/Contraption.ts';
import { PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE } from '../simulation/EntitySimulationClock.ts';
import type { World } from '../voxel/World.ts';

const ENTITY_BROADPHASE_CELL_SIZE = 32;
const ENTITY_SWEEP_THRESHOLD = 0.05;
const TERRAIN_SWEEP_THRESHOLD = 0.1;
const ENTITY_CONTACT_ITERATIONS = 10;
const EXACT_TERRAIN_CONTACT_SLOP = 0.005;
// Entity contacts share the terrain resting rules: separation leaves one
// millimetre of contact slop instead of over-pushing, and residual normal
// velocity below this threshold is cancelled so supported bodies settle.
const ENTITY_CONTACT_SLOP = 0.001;
const RESTING_CONTACT_VELOCITY = 0.2;
// A support manifold narrower than this is a point or line balance (unstable,
// must topple); any real face rest, down to a 0.2m micro voxel, spans more.
const SUPPORT_WIDTH_NARROW = 0.05;
const TERRAIN_FACE_NORMALS = [
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0, 1)
];

export class ContraptionPhysics {
  private world: World;
  private gravity: THREE.Vector3;

  constructor(world) {
    this.world = world;
    this.gravity = new THREE.Vector3(0, -18.0, 0);
  }

  /**
   * Fast downward distance measurement to nearest solid voxel
   */
  getGroundDistance(worldPos, maxCheckDist = 40) {
    const down = new THREE.Vector3(0, -1, 0);
    const standardHit = this.world.raycast(worldPos, down, maxCheckDist);
    const microRaycast = this.world.raycastMicroCollision?.bind(this.world)
      ?? this.world.raycastMicro.bind(this.world);
    const microHit = microRaycast(worldPos, down, maxCheckDist);
    const standardDistance = standardHit.hit ? standardHit.distance : maxCheckDist;
    const microDistance = microHit.hit ? microHit.distance : maxCheckDist;
    return Math.max(0, Math.min(standardDistance, microDistance));
  }

  /**
   * Step physics for a single contraption. Kept as the one-call form used by
   * tests and simple hosts; the manager uses the split frame API below so it
   * can interleave entity-vs-entity collision with terrain collision at the
   * same substep cadence.
   */
  update(contraption, dt) {
    const frame = this.prepareContraptionFrame(contraption, dt);
    if (!frame) return;
    for (let step = 0; step < frame.subSteps; step++) this.stepContraptionFrame(frame);
    this.finishContraptionFrame(frame);
  }

  /**
   * Begin one fixed entity update: snapshot the accumulated script forces and
   * split its 50 ms interval into three immutable 60 Hz physics substeps.
   */
  prepareContraptionFrame(contraption, dt) {
    if (!contraption || !(dt > 0)) return null;
    if (contraption.isPhysicsSimulationEnabled?.() === false) return null;
    contraption.groundDistance = this.getGroundDistance(contraption.position);
    contraption.syncKinematicBodies?.(dt);
    const bodies = contraption.getRigidBodies?.() || [];
    const dynamicBodies = bodies.filter(body => this.isSimulatedDynamicBody(body));
    if (dynamicBodies.length === 0) return null;

    const frameInputs = new Map();
    for (const body of dynamicBodies) {
      frameInputs.set(body.id, {
        force: body.appliedForces.clone(),
        torque: body.appliedTorques.clone()
      });
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
      body.isOnGround = false;
    }

    const subSteps = PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE;
    return {
      contraption,
      dynamicBodies,
      frameInputs,
      subSteps,
      substepDt: dt / subSteps
    };
  }

  /** Run exactly one fixed substep: integrate, solve constraints, then
   * resolve terrain contacts with the same body poses every other entity
   * currently has, so entity-pair collision can run between substeps. */
  stepContraptionFrame(frame) {
    if (!frame) return;
    const { contraption, dynamicBodies, frameInputs, substepDt } = frame;
    const sdt = substepDt;
    const previous = new Map();
    for (const body of dynamicBodies) {
      previous.set(body.id, {
        position: body.position.clone(),
        quaternion: body.quaternion.clone()
      });
      const input = frameInputs.get(body.id);
      this.integrateBody(contraption, body, sdt, input.force, input.torque);
    }

    contraption.syncAllBodyTransforms?.();
    contraption.syncKinematicBodies?.(sdt, true);
    this.solveConstraints(contraption, sdt, 10);
    contraption.syncAllBodyTransforms?.();

    // Position-based constraint corrections become physical velocities.
    for (const body of dynamicBodies) {
      const before = previous.get(body.id);
      body.velocity.copy(body.position).sub(before.position).divideScalar(sdt);
      body.angularVelocity.copy(this.angularVelocityBetween(before.quaternion, body.quaternion, sdt));
      this.resolveTerrainCollisionBody(
        contraption,
        body,
        sdt,
        before
      );
    }
    contraption.syncAllBodyTransforms?.();
  }

  /** Close one contraption's physics frame after all substeps (and any
   * entity-pair resolution interleaved with them) have run. */
  finishContraptionFrame(frame) {
    if (!frame) return;
    const contraption = frame.contraption;
    contraption.isOnGround = contraption.getRigidBody?.(contraption.rootComponentId)?.isOnGround || false;
  }

  inverseMass(body) {
    return this.isSimulatedDynamicBody(body) && body.mass > 0 ? 1 / body.mass : 0;
  }

  isSimulatedDynamicBody(body) {
    return body?.type === BodyType.DYNAMIC && body.simulationEnabled !== false;
  }

  angularVelocityBetween(previous, current, dt) {
    if (!(dt > 0)) return new THREE.Vector3();
    const delta = current.clone().multiply(previous.clone().invert()).normalize();
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, delta.w)));
    const sinHalf = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
    if (angle < 1e-8 || sinHalf < 1e-8) return new THREE.Vector3();
    return new THREE.Vector3(delta.x, delta.y, delta.z).divideScalar(sinHalf).multiplyScalar(angle / dt);
  }

  rotateBody(body, worldRotation) {
    if (!this.isSimulatedDynamicBody(body)) return;
    const angle = worldRotation.length();
    if (angle < 1e-10) return;
    const rotation = new THREE.Quaternion().setFromAxisAngle(worldRotation.clone().divideScalar(angle), angle);
    body.quaternion.premultiply(rotation).normalize();
  }

  integrateBody(contraption, body, dt, frameForce, frameTorque) {
    const useGravity = contraption.getNodeGravityEnabled?.(body.id) !== false;
    if (useGravity) body.velocity.addScaledVector(this.gravity, dt);
    if (frameForce?.lengthSq() > 0.0001) {
      body.velocity.addScaledVector(frameForce, dt / body.mass);
    }
    if (frameTorque?.lengthSq() > 0.0001) {
      body.angularVelocity.addScaledVector(frameTorque, dt * body.inverseInertia);
    }
    body.velocity.multiplyScalar(Math.pow(body.linearDamping, dt * 60));
    body.angularVelocity.multiplyScalar(Math.pow(body.angularDamping, dt * 60));
    body.position.addScaledVector(body.velocity, dt);
    this.rotateBody(body, body.angularVelocity.clone().multiplyScalar(dt));
  }

  bodyAnchorWorld(body, localAnchor) {
    if (!body) return new THREE.Vector3().fromArray(localAnchor || [0, 0, 0]);
    return new THREE.Vector3().fromArray(localAnchor || [0, 0, 0])
      .applyQuaternion(body.quaternion)
      .add(body.position);
  }

  applyPointCorrection(body, impulse, lever) {
    const invMass = this.inverseMass(body);
    if (invMass <= 0) return;
    body.position.addScaledVector(impulse, invMass);
    this.rotateBody(body, lever.clone().cross(impulse).multiplyScalar(body.inverseInertia));
  }

  applyAngularPairCorrection(bodyA, bodyB, rotation) {
    const invA = this.isSimulatedDynamicBody(bodyA) ? bodyA.inverseInertia : 0;
    const invB = this.isSimulatedDynamicBody(bodyB) ? bodyB.inverseInertia : 0;
    const total = invA + invB;
    if (total <= 0 || rotation.lengthSq() < 1e-14) return;
    if (invA > 0) this.rotateBody(bodyA, rotation.clone().multiplyScalar(-invA / total));
    if (invB > 0) this.rotateBody(bodyB, rotation.clone().multiplyScalar(invB / total));
  }

  solvePointConstraint(bodyA, bodyB, constraint) {
    const anchorA = this.bodyAnchorWorld(bodyA, constraint.anchorA);
    const anchorB = this.bodyAnchorWorld(bodyB, constraint.anchorB);
    const error = anchorB.clone().sub(anchorA);
    const distance = error.length();
    if (distance < 1e-7) return;
    const normal = error.clone().divideScalar(distance);
    const leverA = bodyA ? anchorA.clone().sub(bodyA.position) : new THREE.Vector3();
    const leverB = anchorB.clone().sub(bodyB.position);
    const invA = this.inverseMass(bodyA);
    const invB = this.inverseMass(bodyB);
    const angularA = this.isSimulatedDynamicBody(bodyA)
      ? leverA.clone().cross(normal).lengthSq() * bodyA.inverseInertia
      : 0;
    const angularB = this.isSimulatedDynamicBody(bodyB)
      ? leverB.clone().cross(normal).lengthSq() * bodyB.inverseInertia
      : 0;
    const denominator = invA + invB + angularA + angularB;
    if (denominator <= 1e-10) return;
    const impulse = normal.multiplyScalar(distance * constraint.stiffness / denominator);
    this.applyPointCorrection(bodyA, impulse, leverA);
    this.applyPointCorrection(bodyB, impulse.clone().multiplyScalar(-1), leverB);
  }

  solveHingeOrientation(bodyA, bodyB, constraint, lockReference = false) {
    const axisA = new THREE.Vector3().fromArray(constraint.axisA).applyQuaternion(bodyA?.quaternion || new THREE.Quaternion()).normalize();
    const axisB = new THREE.Vector3().fromArray(constraint.axisB).applyQuaternion(bodyB.quaternion).normalize();
    const axisError = axisB.clone().cross(axisA).multiplyScalar(constraint.stiffness);
    this.applyAngularPairCorrection(bodyA, bodyB, axisError);

    const referenceA = new THREE.Vector3().fromArray(constraint.referenceA)
      .applyQuaternion(bodyA?.quaternion || new THREE.Quaternion());
    const referenceB = new THREE.Vector3().fromArray(constraint.referenceB).applyQuaternion(bodyB.quaternion);
    const hingeAxis = axisA.clone().add(axisB);
    if (hingeAxis.lengthSq() < 1e-9) hingeAxis.copy(axisA);
    hingeAxis.normalize();
    referenceA.addScaledVector(hingeAxis, -referenceA.dot(hingeAxis)).normalize();
    referenceB.addScaledVector(hingeAxis, -referenceB.dot(hingeAxis)).normalize();
    const angle = Math.atan2(
      hingeAxis.dot(referenceA.clone().cross(referenceB)),
      Math.max(-1, Math.min(1, referenceA.dot(referenceB)))
    );
    let targetAngle = angle;
    if (lockReference) targetAngle = 0;
    else if (constraint.limits) {
      targetAngle = Math.max(constraint.limits.min, Math.min(constraint.limits.max, angle));
    } else {
      return;
    }
    const correction = targetAngle - angle;
    if (Math.abs(correction) > 1e-7) {
      this.applyAngularPairCorrection(
        bodyA,
        bodyB,
        hingeAxis.multiplyScalar(correction * constraint.stiffness)
      );
    }
  }

  solveConstraints(contraption, dt, iterations = 8) {
    const constraints = contraption.constraintDefinitions?.values?.();
    if (!constraints) return;
    const list = [...constraints];
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const constraint of list) {
        const bodyA = constraint.bodyA === null ? null : contraption.getRigidBody?.(constraint.bodyA);
        const bodyB = contraption.getRigidBody?.(constraint.bodyB);
        if (!bodyB || (constraint.bodyA !== null && !bodyA)) continue;
        if (this.inverseMass(bodyA) + this.inverseMass(bodyB) <= 0) continue;
        this.solvePointConstraint(bodyA, bodyB, constraint);
        if (constraint.type === 'hinge') this.solveHingeOrientation(bodyA, bodyB, constraint, false);
        if (constraint.type === 'weld') this.solveHingeOrientation(bodyA, bodyB, constraint, true);
      }
    }
  }

  /**
   * The body that absorbs a contact found on `body`'s cells. A dynamic body
   * absorbs its own contacts. A kinematic body is rigidly attached to its
   * nearest dynamic ancestor in the scene graph (its local pose is constant
   * unless a script drives it), so the ancestor's body must react instead of
   * the contact being attributed to a zero-inverse-mass body. Without this,
   * two kinematic components of otherwise-dynamic entities pass through each
   * other: the pair clears the entity-level candidate filter (each entity has
   * a dynamic root) but every overlapping box pair is rejected because both
   * box owners are kinematic. Kinematic bodies with no dynamic ancestor keep
   * their scripted-contact behavior (zero inverse mass, own velocity).
   */
  contactBodyFor(contraption, body) {
    if (!body || body.type === BodyType.DYNAMIC) return body;
    let parentId = contraption.getEntityNode?.(body.nodeId || body.id)?.parentId;
    while (parentId) {
      const ancestor = contraption.getRigidBody?.(parentId);
      if (ancestor?.type === BodyType.DYNAMIC) return ancestor;
      parentId = contraption.getEntityNode?.(parentId)?.parentId || null;
    }
    return body;
  }

  /**
   * Entity collision resolves every collision-enabled body pair. Kinematic
   * bodies have zero impulse inverse mass but contribute their scripted
   * contact velocity; kinematic/kinematic overlap clips the commanded pose
   * instead of applying an impulse. A kinematic component carried by a dynamic
   * ancestor routes response to that ancestor. The manager calls this once per
   * physics substep so contacts are caught at terrain cadence.
   */
  resolveContraptionPairs(contraptions, dt = 1 / 60, broadphaseBounds = null) {
    return this.resolvePreparedContraptionPairs(
      this.prepareContraptionPairFrame(contraptions, broadphaseBounds),
      dt
    );
  }

  /** Build the spatial-hash candidate set once for a whole entity update.
   * Its broadphase bounds already cover all three fixed physics substeps, so
   * rebuilding identical buckets only creates garbage. */
  prepareContraptionPairFrame(contraptions, broadphaseBounds = null) {
    const colliders = (contraptions || []).filter(c => c?.getRigidBodies?.().length > 0);
    const buckets = new Map<string, number[]>();
    const candidates = new Map<string, [number, number]>();
    for (let index = 0; index < colliders.length; index++) {
      const collider = colliders[index];
      const bounds = broadphaseBounds?.get(collider) || this.contraptionBroadphaseBounds(collider);
      const minX = Math.floor(bounds.minX / ENTITY_BROADPHASE_CELL_SIZE);
      const maxX = Math.floor(bounds.maxX / ENTITY_BROADPHASE_CELL_SIZE);
      const minY = Math.floor(bounds.minY / ENTITY_BROADPHASE_CELL_SIZE);
      const maxY = Math.floor(bounds.maxY / ENTITY_BROADPHASE_CELL_SIZE);
      const minZ = Math.floor(bounds.minZ / ENTITY_BROADPHASE_CELL_SIZE);
      const maxZ = Math.floor(bounds.maxZ / ENTITY_BROADPHASE_CELL_SIZE);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            const key = `${x},${y},${z}`;
            const bucket = buckets.get(key) || [];
            for (const other of bucket) {
              const a = Math.min(other, index);
              const b = Math.max(other, index);
              candidates.set(`${a},${b}`, [a, b]);
            }
            bucket.push(index);
            buckets.set(key, bucket);
          }
        }
      }
    }
    // Collision participation is controlled by each component's
    // collisionEnabled flag, which is already reflected by its collision-box
    // list. Do not discard kinematic/kinematic pairs here: their commanded
    // poses are clipped by the narrow phase even though neither body accepts
    // an impulse.
    return { colliders, collisionCandidates: [...candidates.values()] };
  }

  resolvePreparedContraptionPairs(pairFrame, dt = 1 / 60) {
    const colliders = pairFrame?.colliders || [];
    const collisionCandidates = pairFrame?.collisionCandidates || pairFrame?.dynamicCandidates || [];
    for (let iteration = 0; iteration < ENTITY_CONTACT_ITERATIONS; iteration++) {
      let resolvedContacts = 0;
      for (const [a, b] of collisionCandidates) {
        // Every correction changes all world-space boxes on that body. Fresh
        // boxes let the solver propagate support through a stack instead of
        // leaving the next pair embedded until the following entity update.
        const boxesA = colliders[a].getCollisionWorldAABBs?.() || [];
        const boxesB = colliders[b].getCollisionWorldAABBs?.() || [];
        if (this.resolveContraptionPair(
          colliders[a],
          colliders[b],
          boxesA,
          boxesB,
          iteration === 0,
          dt
        )) resolvedContacts++;
      }
      if (resolvedContacts === 0) break;
    }
  }

  /**
   * Tight broadphase bounds for one contraption: the axis-aligned hull of its
   * collision boxes, which spans both the previous and current poses because
   * every box records both corner sets.
   */
  contraptionBroadphaseBounds(contraption) {
    const radius = Math.max(0.5, Number(contraption.boundingRadius) || 0.5) + 0.5;
    const boxes = contraption.getCollisionWorldAABBs?.(true) || [];
    if (boxes.length === 0) {
      const center = typeof contraption.getWorldCenter === 'function'
        ? contraption.getWorldCenter()
        : (contraption.localCenter ? contraption.localToWorld(contraption.localCenter.clone()) : contraption.position);
      return {
        minX: center.x - radius,
        minY: center.y - radius,
        minZ: center.z - radius,
        maxX: center.x + radius,
        maxY: center.y + radius,
        maxZ: center.z + radius
      };
    }
    return boxes.reduce((result, box) => ({
      minX: Math.min(result.minX, box.minX),
      minY: Math.min(result.minY, box.minY),
      minZ: Math.min(result.minZ, box.minZ),
      maxX: Math.max(result.maxX, box.maxX),
      maxY: Math.max(result.maxY, box.maxY),
      maxZ: Math.max(result.maxZ, box.maxZ)
    }), { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity });
  }

  /**
   * Conservative broadphase bounds covering one whole physics frame: the tight
   * pose hull padded by the maximum distance any body can travel this frame.
   * Computed once per frame by the manager and reused by every per-substep
   * entity-pair pass, so substep-cadence collision detection never misses a
   * swept crossing.
   */
  frameBroadphaseBounds(contraption, dt) {
    const bounds = this.contraptionBroadphaseBounds(contraption);
    const radius = Math.max(0.5, Number(contraption.boundingRadius) || 0.5);
    let travel = 0;
    for (const body of contraption.getRigidBodies?.() || []) {
      travel = Math.max(
        travel,
        (body.velocity.length() + body.angularVelocity.length() * radius)
        * Math.max(0, Number(dt) || 0)
      );
    }
    const pad = travel + 0.5;
    return {
      minX: bounds.minX - pad,
      minY: bounds.minY - pad,
      minZ: bounds.minZ - pad,
      maxX: bounds.maxX + pad,
      maxY: bounds.maxY + pad,
      maxZ: bounds.maxZ + pad
    };
  }

  isDynamicCollider(contraption) {
    return !!contraption?.getRigidBodies?.().some(body => this.isSimulatedDynamicBody(body));
  }

  sweptAabbContact(a, b) {
    const previousOverlap = ['x', 'y', 'z'].every(axis => (
      Math.min(a[`previousMax${axis.toUpperCase()}`], b[`previousMax${axis.toUpperCase()}`])
      - Math.max(a[`previousMin${axis.toUpperCase()}`], b[`previousMin${axis.toUpperCase()}`]) > 0
    ));
    if (previousOverlap) return null;

    const relativeDelta = new THREE.Vector3();
    for (const axis of ['x', 'y', 'z'] as const) {
      const centerA0 = (a[`previousMin${axis.toUpperCase()}`] + a[`previousMax${axis.toUpperCase()}`]) * 0.5;
      const centerA1 = (a[`currentMin${axis.toUpperCase()}`] + a[`currentMax${axis.toUpperCase()}`]) * 0.5;
      const centerB0 = (b[`previousMin${axis.toUpperCase()}`] + b[`previousMax${axis.toUpperCase()}`]) * 0.5;
      const centerB1 = (b[`currentMin${axis.toUpperCase()}`] + b[`currentMax${axis.toUpperCase()}`]) * 0.5;
      relativeDelta[axis] = (centerA1 - centerA0) - (centerB1 - centerB0);
    }
    // AABB sweep is deliberately reserved for meaningful frame travel. At
    // resting speed a rotated box's broadphase AABB can touch another AABB
    // even though the two oriented shapes are separated; treating that as a
    // CCD hit creates an invisible shelf that catches an overhanging body.
    if (relativeDelta.lengthSq() < ENTITY_SWEEP_THRESHOLD * ENTITY_SWEEP_THRESHOLD) return null;

    let entryTime = -Infinity;
    let exitTime = Infinity;
    let normal = null;
    for (const axis of ['x', 'y', 'z'] as const) {
      const delta = relativeDelta[axis];
      const aMin = a[`previousMin${axis.toUpperCase()}`];
      const aMax = a[`previousMax${axis.toUpperCase()}`];
      const bMin = b[`previousMin${axis.toUpperCase()}`];
      const bMax = b[`previousMax${axis.toUpperCase()}`];
      if (Math.abs(delta) < 1e-12) {
        if (aMax < bMin || aMin > bMax) return null;
        continue;
      }

      let entry;
      let exit;
      let direction;
      if (delta > 0) {
        entry = (bMin - aMax) / delta;
        exit = (bMax - aMin) / delta;
        direction = 1;
      } else {
        entry = (bMax - aMin) / delta;
        exit = (bMin - aMax) / delta;
        direction = -1;
      }
      if (entry > entryTime) {
        entryTime = entry;
        normal = new THREE.Vector3();
        normal[axis] = direction;
      }
      exitTime = Math.min(exitTime, exit);
      if (entryTime > exitTime) return null;
    }

    if (!normal || entryTime < 0 || entryTime > 1 || exitTime < 0) return null;
    return { time: entryTime, normal, relativeDelta };
  }

  entityContactPoint(boxA, boxB, normal, time = 1) {
    const point = new THREE.Vector3();
    const boundsAt = (box, axis, edge) => {
      const suffix = axis.toUpperCase();
      const previous = box[`previous${edge}${suffix}`];
      const current = box[`current${edge}${suffix}`];
      return previous + (current - previous) * time;
    };
    for (const axis of ['x', 'y', 'z'] as const) {
      const aMin = boundsAt(boxA, axis, 'Min');
      const aMax = boundsAt(boxA, axis, 'Max');
      const bMin = boundsAt(boxB, axis, 'Min');
      const bMax = boundsAt(boxB, axis, 'Max');
      if (Math.abs(normal[axis]) > 0.5) {
        point[axis] = normal[axis] > 0
          ? (aMax + bMin) * 0.5
          : (aMin + bMax) * 0.5;
      } else {
        point[axis] = (
          Math.max(aMin, bMin) + Math.min(aMax, bMax)
        ) * 0.5;
      }
    }
    return point;
  }

  entitySupportOffset(body, boxA, boxB) {
    const minX = Math.max(boxA.currentMinX, boxB.currentMinX);
    const maxX = Math.min(boxA.currentMaxX, boxB.currentMaxX);
    const minZ = Math.max(boxA.currentMinZ, boxB.currentMinZ);
    const maxZ = Math.min(boxA.currentMaxZ, boxB.currentMaxZ);
    if (minX >= maxX || minZ >= maxZ) return null;
    return new THREE.Vector3(
      body.position.x - Math.max(minX, Math.min(maxX, body.position.x)),
      0,
      body.position.z - Math.max(minZ, Math.min(maxZ, body.position.z))
    );
  }

  stableStackContactPoint(boxA, boxB, bodyA, bodyB, normal, time = 1) {
    const point = this.entityContactPoint(boxA, boxB, normal, time);
    const verticalSeparation = bodyB.position.y - bodyA.position.y;
    if (Math.abs(normal.y) <= 0.5 || Math.abs(verticalSeparation) <= 0.5) return point;
    const upperBody = verticalSeparation > 0 ? bodyB : bodyA;
    const supportOffset = this.entitySupportOffset(upperBody, boxA, boxB);
    if (supportOffset) {
      point.x = upperBody.position.x - supportOffset.x;
      point.z = upperBody.position.z - supportOffset.z;
    }
    return point;
  }

  entityCollisionObb(box, cache = null) {
    const cached = cache?.get(box);
    if (cached) return cached;
    const cell = box?.cell;
    const contraption = box?.contraption;
    if (!cell || !contraption) return null;
    const node = contraption.getEntityNode?.(cell.entityId)
      || contraption.getEntityNode?.();
    if (!node) return null;
    const quaternion = node.group.getWorldQuaternion(new THREE.Quaternion());
    const size = cell.span * 0.2;
    const obb = {
      center: contraption.entityLocalToWorld(cell.entityId, new THREE.Vector3(
        (cell.x + cell.span / 2) * 0.2,
        (cell.y + cell.span / 2) * 0.2,
        (cell.z + cell.span / 2) * 0.2
      )),
      axes: [
        new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize(),
        new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
        new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize()
      ],
      halfExtents: [size / 2, size / 2, size / 2]
    };
    cache?.set(box, obb);
    return obb;
  }

  /**
   * The vertices of one oriented box that extremise the projection onto `axis`.
   * sign=+1 returns the vertices farthest in +axis (a face, edge, or vertex of
   * the support face); sign=-1 the farthest in -axis. Ties within 1e-7 keep
   * every member of the support feature, so the count reveals its shape:
   * 4 tied vertices is a face, 2 an edge, 1 a vertex.
   */
  boxSupportVertices(obb, axis, sign) {
    const dots = obb.axes.map(obbAxis => obbAxis.dot(axis));
    const vertices = [];
    let best = -Infinity;
    for (let i = 0; i < 8; i++) {
      let projection = 0;
      const point = obb.center.clone();
      for (let k = 0; k < 3; k++) {
        const side = ((i >> k) & 1) ? 1 : -1;
        projection += side * obb.halfExtents[k] * dots[k];
        point.addScaledVector(obb.axes[k], side * obb.halfExtents[k]);
      }
      const score = sign * projection;
      if (score > best + 1e-7) {
        best = score;
        vertices.length = 0;
        vertices.push(point);
      } else if (best - score <= 1e-7) {
        vertices.push(point);
      }
    }
    return vertices;
  }

  orientedBoxPairContact(boxA, boxB, cache = null) {
    const obbA = this.entityCollisionObb(boxA, cache);
    const obbB = this.entityCollisionObb(boxB, cache);
    if (!obbA || !obbB) return null;
    const candidateAxes = [...obbA.axes, ...obbB.axes];
    for (const axisA of obbA.axes) {
      for (const axisB of obbB.axes) {
        const cross = new THREE.Vector3().crossVectors(axisA, axisB);
        if (cross.lengthSq() > 1e-10) candidateAxes.push(cross);
      }
    }

    const delta = obbB.center.clone().sub(obbA.center);
    let penetration = Infinity;
    let normal = null;
    for (const rawAxis of candidateAxes) {
      const axis = rawAxis.clone().normalize();
      const radiusA = obbA.halfExtents.reduce((sum, half, index) => (
        sum + half * Math.abs(obbA.axes[index].dot(axis))
      ), 0);
      const radiusB = obbB.halfExtents.reduce((sum, half, index) => (
        sum + half * Math.abs(obbB.axes[index].dot(axis))
      ), 0);
      const signedDistance = delta.dot(axis);
      const overlap = radiusA + radiusB - Math.abs(signedDistance);
      if (overlap <= 1e-7) return null;
      if (overlap < penetration) {
        penetration = overlap;
        normal = axis.multiplyScalar(signedDistance >= 0 ? 1 : -1);
      }
    }
    if (!normal || !Number.isFinite(penetration)) return null;

    // The contact feature on each box is its support set in the separating
    // direction: A's vertices deepest into +normal, B's deepest into -normal.
    // A face-face rest carries 4 tied vertices on both sides; any vertex or
    // edge involvement makes the support narrow (a point or line balance).
    const supportA = this.boxSupportVertices(obbA, normal, 1);
    const supportB = this.boxSupportVertices(obbB, normal, -1);
    const featurePoint = supportA.reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .divideScalar(supportA.length);
    const otherPoint = supportB.reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .divideScalar(supportB.length);
    featurePoint.add(otherPoint).multiplyScalar(0.5);

    return {
      normal,
      penetration,
      featurePoint,
      faceSupport: supportA.length >= 3 && supportB.length >= 3
    };
  }

  entityContactInverseMass(body, normalDirection) {
    const inverseMass = this.inverseMass(body);
    if (inverseMass <= 0) return 0;
    // Entity pairs are solved at the same substep cadence as terrain: a
    // grounded lower body carrying a downward load hands that load to the next
    // substep's terrain pass, so only a contact that actually pushes the
    // grounded body downward gets terrain-like infinite mass. Every other
    // contact stays fully dynamic - a grounded entity must still shove, tilt,
    // and slide like the terrain blocks it sits between.
    if (body.isOnGround && normalDirection.y < -0.5) return 0;
    return inverseMass;
  }

  bodyPointVelocity(body, contactPoint) {
    const lever = contactPoint.clone().sub(body.position);
    return body.velocity.clone().add(body.angularVelocity.clone().cross(lever));
  }

  /** Position-correction weights for one contact. Dynamic bodies use their
   * physical inverse mass. Stopped bodies have no inverse mass and remain fixed.
   * Active kinematic bodies cannot accept an impulse, but collisionEnabled still
   * means their commanded poses must not pass through another collider. In that
   * case clip only the active moving pose(s), weighted by contact advance. */
  entityContactCorrectionWeights(bodyA, bodyB, normal, boxA, boxB) {
    const inverseA = this.entityContactInverseMass(bodyA, normal.clone().multiplyScalar(-1));
    const inverseB = this.entityContactInverseMass(bodyB, normal);
    if (inverseA + inverseB > 0) {
      return { correctionA: inverseA, correctionB: inverseB, impulseA: inverseA, impulseB: inverseB };
    }
    const movableKinematicA = bodyA.type === BodyType.KINEMATIC && bodyA.simulationEnabled !== false;
    const movableKinematicB = bodyB.type === BodyType.KINEMATIC && bodyB.simulationEnabled !== false;
    if (!movableKinematicA && !movableKinematicB) {
      return { correctionA: 0, correctionB: 0, impulseA: inverseA, impulseB: inverseB };
    }

    const displacement = box => new THREE.Vector3(
      (box.currentMinX + box.currentMaxX - box.previousMinX - box.previousMaxX) * 0.5,
      (box.currentMinY + box.currentMaxY - box.previousMinY - box.previousMaxY) * 0.5,
      (box.currentMinZ + box.currentMaxZ - box.previousMinZ - box.previousMaxZ) * 0.5
    );
    const advanceA = movableKinematicA ? Math.max(0, displacement(boxA).dot(normal)) : 0;
    const advanceB = movableKinematicB ? Math.max(0, -displacement(boxB).dot(normal)) : 0;
    const movingTotal = advanceA + advanceB;
    return {
      correctionA: movingTotal > 1e-8 ? advanceA / movingTotal : (movableKinematicA ? 1 : 0),
      correctionB: movingTotal > 1e-8 ? advanceB / movingTotal : (movableKinematicB ? 1 : 0),
      impulseA: 0,
      impulseB: 0
    };
  }

  /** Keep a kinematic collision shape's own scripted velocity and material,
   * while applying the resulting impulse to its dynamic carrier (if any). */
  applyEntityCollisionImpulse(bodyA, bodyB, ownerA, ownerB, normal, contactPoint, invA, invB) {
    let appliedImpulseMagnitude = 0;
    const leverA = contactPoint.clone().sub(bodyA.position);
    const leverB = contactPoint.clone().sub(bodyB.position);
    const carrierVelocityA = this.bodyPointVelocity(bodyA, contactPoint);
    const carrierVelocityB = this.bodyPointVelocity(bodyB, contactPoint);
    const ownerOffsetA = ownerA === bodyA
      ? new THREE.Vector3()
      : this.bodyPointVelocity(ownerA, contactPoint).sub(carrierVelocityA);
    const ownerOffsetB = ownerB === bodyB
      ? new THREE.Vector3()
      : this.bodyPointVelocity(ownerB, contactPoint).sub(carrierVelocityB);
    const velocityA = carrierVelocityA.add(ownerOffsetA);
    const velocityB = carrierVelocityB.add(ownerOffsetB);
    const relativeVelocity = velocityB.sub(velocityA);
    const normalVelocity = relativeVelocity.dot(normal);
    if (normalVelocity < 0) {
      const angularA = invA > 0
        ? leverA.clone().cross(normal).lengthSq() * bodyA.inverseInertia
        : 0;
      const angularB = invB > 0
        ? leverB.clone().cross(normal).lengthSq() * bodyB.inverseInertia
        : 0;
      const effectiveInverseMass = invA + invB + angularA + angularB;
      if (effectiveInverseMass > 1e-10) {
        const restitution = Math.abs(normalVelocity) < 0.5
          ? 0
          : Math.max(ownerA.restitution, ownerB.restitution);
        const impulseMagnitude = -(1 + restitution) * normalVelocity / effectiveInverseMass;
        appliedImpulseMagnitude = impulseMagnitude;
        const impulse = normal.clone().multiplyScalar(impulseMagnitude);
        const applyPairImpulse = vector => {
          bodyA.velocity.addScaledVector(vector, -invA);
          bodyB.velocity.addScaledVector(vector, invB);
          if (invA > 0) {
            bodyA.angularVelocity.addScaledVector(
              leverA.clone().cross(vector),
              -bodyA.inverseInertia
            );
          }
          if (invB > 0) {
            bodyB.angularVelocity.addScaledVector(
              leverB.clone().cross(vector),
              bodyB.inverseInertia
            );
          }
        };
        applyPairImpulse(impulse);

        // Match terrain contact friction: cancel relative tangential motion at
        // the contact point, limited by the Coulomb cone μN, including angular
        // mass.
        const postVelocityA = this.bodyPointVelocity(bodyA, contactPoint).add(ownerOffsetA);
        const postVelocityB = this.bodyPointVelocity(bodyB, contactPoint).add(ownerOffsetB);
        const tangentVelocity = postVelocityB.sub(postVelocityA);
        tangentVelocity.addScaledVector(normal, -tangentVelocity.dot(normal));
        const tangentSpeed = tangentVelocity.length();
        if (tangentSpeed > 0.01 && impulseMagnitude > 0) {
          const tangent = tangentVelocity.divideScalar(tangentSpeed);
          const tangentAngularA = invA > 0
            ? leverA.clone().cross(tangent).lengthSq() * bodyA.inverseInertia
            : 0;
          const tangentAngularB = invB > 0
            ? leverB.clone().cross(tangent).lengthSq() * bodyB.inverseInertia
            : 0;
          const tangentInverseMass = invA + invB + tangentAngularA + tangentAngularB;
          if (tangentInverseMass > 1e-10) {
            const friction = Math.sqrt(Math.max(0, ownerA.friction * ownerB.friction));
            const frictionMagnitude = Math.max(
              -impulseMagnitude * friction,
              -tangentSpeed / tangentInverseMass
            );
            applyPairImpulse(tangent.multiplyScalar(frictionMagnitude));
          }
        }
      }
    }

    // Resting stabilization identical to terrain contact: residual relative
    // normal velocity below the terrain threshold - approaching creep as well
    // as a separating micro-bounce - is cancelled, so a supported body settles
    // on its support instead of buzzing on it. Only the relative velocity is
    // touched, so a body carried by a moving support keeps riding along.
    const totalInverseMass = invA + invB;
    if (totalInverseMass > 1e-10) {
      // Preserve the established linear-only resting stabilization for normal
      // rigid bodies. A mapped kinematic owner contributes only its relative
      // scripted offset; angular contact velocity is already handled by the
      // impulse calculation above and including it again destabilizes narrow
      // corner rests.
      const residualNormalVelocity = bodyB.velocity.clone().add(ownerOffsetB)
        .sub(bodyA.velocity.clone().add(ownerOffsetA))
        .dot(normal);
      if (Math.abs(residualNormalVelocity) < RESTING_CONTACT_VELOCITY) {
        const correction = -residualNormalVelocity / totalInverseMass;
        bodyA.velocity.addScaledVector(normal, -correction * invA);
        bodyB.velocity.addScaledVector(normal, correction * invB);
      }
    }
    return appliedImpulseMagnitude;
  }

  recordEntityPairContact(a, b, bodyA, bodyB, ownerA, ownerB, normal, contactPoint, penetration, impulse) {
    const relativeVelocity = bodyB.velocity.clone().sub(bodyA.velocity);
    a.recordScriptContact?.({
      kind: 'entity',
      selfNodeId: ownerA.id,
      otherEntityId: b.publicId,
      otherNodeId: ownerB.id,
      playerId: null,
      position: contactPoint.toArray(),
      normal: normal.clone().multiplyScalar(-1).toArray(),
      relativeVelocity: relativeVelocity.toArray(),
      penetration: Number(penetration) || 0,
      impulse: Number(impulse) || 0
    });
    b.recordScriptContact?.({
      kind: 'entity',
      selfNodeId: ownerB.id,
      otherEntityId: a.publicId,
      otherNodeId: ownerA.id,
      playerId: null,
      position: contactPoint.toArray(),
      normal: normal.toArray(),
      relativeVelocity: relativeVelocity.multiplyScalar(-1).toArray(),
      penetration: Number(penetration) || 0,
      impulse: Number(impulse) || 0
    });
  }

  syncKinematicCollisionResponses(contraption, bodies) {
    if (!contraption || !bodies || bodies.size === 0) return;
    contraption.syncAllBodyTransforms?.();
    for (const body of bodies) {
      if (body.type !== BodyType.KINEMATIC || body.simulationEnabled === false) continue;
      if (body.id !== contraption.rootComponentId) contraption.syncBodyToNode?.(body);
      body.previousKinematicPosition?.copy(body.position);
      body.previousKinematicQuaternion?.copy(body.quaternion);
    }
    contraption.invalidateCollisionPoseCache?.();
  }

  destabilizeOverhangingEntity(body, boxA, boxB, dt) {
    if (!this.isSimulatedDynamicBody(body)) return;
    const overhang = this.entitySupportOffset(body, boxA, boxB);
    if (!overhang) return;
    const distance = overhang.length();
    if (distance <= 0.01) return;

    // A projected COM outside the shared footprint has no static support
    // solution. SAT may nevertheless choose a slanted edge/face normal whose
    // line passes through the COM, producing a perfectly balanced voxel. Add
    // the missing gravity torque about the nearest support edge once per
    // frame so the body actually rolls off that edge.
    const torqueAxis = overhang.clone().cross(this.gravity);
    if (torqueAxis.lengthSq() <= 1e-12) return;
    const angularAcceleration = Math.min(
      this.gravity.length() * 2,
      this.gravity.length() * body.mass * body.inverseInertia * distance
    );
    const safeDt = Math.max(0, Math.min(0.08, dt || 0));
    body.angularVelocity.addScaledVector(
      torqueAxis.normalize(),
      angularAcceleration * safeDt
    );
  }

  resolveContraptionPair(a, b, boxesA = null, boxesB = null, allowSweep = true, dt = 1 / 60) {
    if (a === b) return false;

    boxesA ||= a.getCollisionWorldAABBs?.() || [];
    boxesB ||= b.getCollisionWorldAABBs?.() || [];
    let bestSweep = null;
    let shallowestContact = null;
    const contactGroups = new Map();
    const obbCache = new Map();
    const movedKinematicA = new Set();
    const movedKinematicB = new Set();

    for (const ba of boxesA) {
      for (const bb of boxesB) {
        // min/max include both previous and current poses. If these swept
        // hulls are disjoint, neither the current SAT nor CCD can possibly
        // produce a contact, so avoid all body lookup/vector allocation work.
        if (
          ba.maxX < bb.minX || ba.minX > bb.maxX
          || ba.maxY < bb.minY || ba.minY > bb.maxY
          || ba.maxZ < bb.minZ || ba.minZ > bb.maxZ
        ) continue;
        const ownerA = a.getRigidBody?.(ba.bodyId || ba.entityId || a.rootComponentId);
        const ownerB = b.getRigidBody?.(bb.bodyId || bb.entityId || b.rootComponentId);
        if (!ownerA || !ownerB) continue;
        // Kinematic components resolve through their nearest dynamic
        // ancestor: they are scene-graph children of it, so a hit on the
        // component must move the whole entity instead of tunnelling.
        const bodyA = this.contactBodyFor(a, ownerA);
        const bodyB = this.contactBodyFor(b, ownerB);

        const sweep = allowSweep ? this.sweptAabbContact(ba, bb) : null;
        if (sweep && (!bestSweep || sweep.time < bestSweep.time)) {
          bestSweep = { ...sweep, ba, bb, ownerA, ownerB, bodyA, bodyB };
        }

        const ox = Math.min(ba.currentMaxX, bb.currentMaxX) - Math.max(ba.currentMinX, bb.currentMinX);
        const oy = Math.min(ba.currentMaxY, bb.currentMaxY) - Math.max(ba.currentMinY, bb.currentMinY);
        const oz = Math.min(ba.currentMaxZ, bb.currentMaxZ) - Math.max(ba.currentMinZ, bb.currentMinZ);
        if (ox > 0 && oy > 0 && oz > 0) {
          const contact = this.orientedBoxPairContact(ba, bb, obbCache);
          if (!contact) continue;
          // Match terrain support: use the separating axis of the actual
          // oriented features and create rotation through the contact-point
          // lever arm, without injecting an artificial escape direction. The
          // center of the overlapping broadphase footprint is the impulse
          // lever: SAT support vertices are excellent for the normal but can
          // put a face contact almost directly below the upper COM, erasing
          // the torque of a real overhang.
          const contactPoint = this.stableStackContactPoint(
            ba,
            bb,
            bodyA,
            bodyB,
            contact.normal
          );
          // Terrain resolves a full contact manifold, grouping every contact
          // that shares a separating normal; entity pairs get the same
          // treatment instead of resolving one arbitrary cell pair at a time,
          // which let wide bodies rock on a single wandering contact point.
          const key = `${bodyA.id}|${ownerA.id}|${bodyB.id}|${ownerB.id}|${contact.normal.x.toFixed(3)
            },${contact.normal.y.toFixed(3)},${contact.normal.z.toFixed(3)}`;
          const group = contactGroups.get(key) || {
            normal: contact.normal,
            penetration: 0,
            contactPoints: [],
            featurePoints: [],
            faceSupport: false,
            ba,
            bb,
            ownerA,
            ownerB,
            bodyA,
            bodyB
          };
          group.penetration = Math.max(group.penetration, contact.penetration);
          group.contactPoints.push(contactPoint);
          group.featurePoints.push(contact.featurePoint);
          group.faceSupport = group.faceSupport || contact.faceSupport;
          contactGroups.set(key, group);
          if (!shallowestContact || contact.penetration < shallowestContact.penetration) {
            shallowestContact = { penetration: contact.penetration, ba, bb, bodyA, bodyB };
          }
        }
      }
    }

    const sweepVerticalSeparation = bestSweep
      ? bestSweep.bodyB.position.y - bestSweep.bodyA.position.y
      : 0;
    const sweepUpperBody = sweepVerticalSeparation > 0.5
      ? bestSweep?.bodyB
      : sweepVerticalSeparation < -0.5
        ? bestSweep?.bodyA
        : null;
    const sweepSupportOffset = bestSweep && sweepUpperBody
      ? this.entitySupportOffset(sweepUpperBody, bestSweep.ba, bestSweep.bb)
      : null;
    const sweepUpperOutsideSupport = !!sweepSupportOffset && sweepSupportOffset.lengthSq() > 0.0001;

    // Prefer the exact oriented contact at the current pose. The swept AABB is
    // a CCD fallback for bodies that crossed completely between frames; when
    // both exist, choosing the broadphase sweep can recreate a vertical ghost
    // shelf around a rotating overhang.
    if (bestSweep && contactGroups.size === 0 && !sweepUpperOutsideSupport) {
      const { ba, bb, ownerA, ownerB, bodyA, bodyB, normal, relativeDelta, time } = bestSweep;
      const weights = this.entityContactCorrectionWeights(bodyA, bodyB, normal, ba, bb);
      const totalCorrection = weights.correctionA + weights.correctionB;
      if (totalCorrection <= 0) return false;
      const relativeDistance = Math.max(1e-9, relativeDelta.length());
      const rewindFraction = Math.min(1, Math.max(0, 1 - time + 0.001 / relativeDistance));
      bodyA.position.addScaledVector(relativeDelta, -rewindFraction * weights.correctionA / totalCorrection);
      bodyB.position.addScaledVector(relativeDelta, rewindFraction * weights.correctionB / totalCorrection);
      if (bodyA.type === BodyType.KINEMATIC && weights.correctionA > 0) movedKinematicA.add(bodyA);
      if (bodyB.type === BodyType.KINEMATIC && weights.correctionB > 0) movedKinematicB.add(bodyB);
      const contactPoint = this.stableStackContactPoint(ba, bb, bodyA, bodyB, normal, time);
      const impulse = this.applyEntityCollisionImpulse(
        bodyA,
        bodyB,
        ownerA,
        ownerB,
        normal,
        contactPoint,
        weights.impulseA,
        weights.impulseB
      );
      this.recordEntityPairContact(
        a, b, bodyA, bodyB, ownerA, ownerB, normal, contactPoint, 0, impulse
      );
      this.markEntitySupport(a, b, bodyA, bodyB, normal);
      if (movedKinematicA.size > 0) this.syncKinematicCollisionResponses(a, movedKinematicA);
      else a.syncAllBodyTransforms?.();
      if (movedKinematicB.size > 0) this.syncKinematicCollisionResponses(b, movedKinematicB);
      else b.syncAllBodyTransforms?.();
      return true;
    }

    if (contactGroups.size === 0) return false;

    // Independent contact groups resolve in one pass, deepest first, exactly
    // like the terrain contact groups (for example floor + wall at a corner).
    const groups = [...contactGroups.values()].sort((first, second) => (
      second.penetration - first.penetration
    ));
    let separated = false;
    for (const group of groups) {
      const { normal, ownerA, ownerB, bodyA, bodyB } = group;
      const weights = this.entityContactCorrectionWeights(bodyA, bodyB, normal, group.ba, group.bb);
      const totalCorrection = weights.correctionA + weights.correctionB;
      if (totalCorrection <= 0) continue;
      // A face-to-face rest keeps the stable-stack COM-clamped lever: the
      // shared face spans the whole footprint, so clamping the upper COM onto
      // it is the true balance point and keeps wide stacks from rocking on a
      // wandering SAT vertex. A narrow rest - vertex or edge against anything
      // - must use the real contact feature instead: clamping the COM onto
      // the rotated box's broadphase footprint lands the fake contact almost
      // directly under the COM, zeroes the gravity torque, and locks the two
      // bodies in a corner interlock that no solver pass can escape.
      const points = group.faceSupport ? group.contactPoints : group.featurePoints;
      const contactPoint = points.length === 1
        ? points[0]
        : points.reduce(
          (sum, point) => sum.add(point),
          new THREE.Vector3()
        ).divideScalar(points.length);
      // Terrain contacts leave one millimetre of slop instead of
      // over-separating: a resting body then holds a stable shallow contact
      // instead of sinking a full frame and popping back out past the surface.
      const push = Math.max(0, group.penetration - ENTITY_CONTACT_SLOP);
      if (push > 0) {
        bodyA.position.addScaledVector(normal, -push * weights.correctionA / totalCorrection);
        bodyB.position.addScaledVector(normal, push * weights.correctionB / totalCorrection);
        if (bodyA.type === BodyType.KINEMATIC && weights.correctionA > 0) movedKinematicA.add(bodyA);
        if (bodyB.type === BodyType.KINEMATIC && weights.correctionB > 0) movedKinematicB.add(bodyB);
        separated = true;
      }
      const impulse = this.applyEntityCollisionImpulse(
        bodyA,
        bodyB,
        ownerA,
        ownerB,
        normal,
        contactPoint,
        weights.impulseA,
        weights.impulseB
      );
      this.recordEntityPairContact(
        a, b, bodyA, bodyB, ownerA, ownerB, normal, contactPoint, group.penetration, impulse
      );
      this.markEntitySupport(a, b, bodyA, bodyB, normal);
      // A narrow upward support is a point or line balance that cannot hold:
      // tip the supported body off it, exactly like terrain contacts do. Run
      // once per solver pass (the first iteration, gated on allowSweep) so the
      // magnitude matches the terrain per-substep cadence instead of being
      // multiplied by the contact iteration count.
      if (allowSweep && !group.faceSupport) {
        if (normal.y > 0.5) this.toppleNarrowSupport(bodyB, normal, dt);
        else if (normal.y < -0.5) this.toppleNarrowSupport(bodyA, normal.clone().multiplyScalar(-1), dt);
      }
    }

    if (allowSweep && shallowestContact) {
      const { bodyA, bodyB } = shallowestContact;
      const upperIsBodyB = bodyB.position.y > bodyA.position.y + 0.5;
      const upperIsBodyA = bodyA.position.y > bodyB.position.y + 0.5;
      const upperBody = upperIsBodyB ? bodyB : upperIsBodyA ? bodyA : null;
      this.destabilizeOverhangingEntity(
        upperBody,
        shallowestContact.ba,
        shallowestContact.bb,
        dt
      );
    }

    if (movedKinematicA.size > 0) this.syncKinematicCollisionResponses(a, movedKinematicA);
    else a.syncAllBodyTransforms?.();
    if (movedKinematicB.size > 0) this.syncKinematicCollisionResponses(b, movedKinematicB);
    else b.syncAllBodyTransforms?.();
    return separated;
  }

  markEntitySupport(a, b, bodyA, bodyB, normal) {
    if (normal.y < -0.5 && this.isSimulatedDynamicBody(bodyA)) {
      bodyA.isOnGround = true;
      if (bodyA.id === a.rootComponentId) a.isOnGround = true;
    }
    if (normal.y > 0.5 && this.isSimulatedDynamicBody(bodyB)) {
      bodyB.isOnGround = true;
      if (bodyB.id === b.rootComponentId) b.isOnGround = true;
    }
  }

  terrainCellAtPoint(point) {
    const bx = Math.floor(point.x);
    const by = Math.floor(point.y);
    const bz = Math.floor(point.z);
    if (this.world.getBlock(bx, by, bz) !== BlockTypes.AIR) {
      return { minX: bx, maxX: bx + 1, minY: by, maxY: by + 1, minZ: bz, maxZ: bz + 1 };
    }

    const mx = Math.floor(point.x * 5);
    const my = Math.floor(point.y * 5);
    const mz = Math.floor(point.z * 5);
    const collisionReader = (this.world as any).getMicroCollisionBlock;
    const micro = typeof collisionReader === 'function'
      ? collisionReader.call(this.world, mx, my, mz)
      : ((this.world as any).getMicroBlock?.(mx, my, mz)
        ?? (this.world as any).microVoxels?.get(mx, my, mz)
        ?? null);
    if (micro === null || micro === undefined) return null;
    return {
      minX: mx / 5,
      maxX: (mx + 1) / 5,
      minY: my / 5,
      maxY: (my + 1) / 5,
      minZ: mz / 5,
      maxZ: (mz + 1) / 5
    };
  }

  /**
   * Exact oriented collision boxes for the cells carried by one rigid body.
   * Point probes are useful for contact manifolds and sweeps, but they cannot
   * detect the dual case where a terrain edge pierces the interior of a body
   * face. Keeping the OBBs here lets the terrain solver cover that topology
   * with a separating-axis test.
   */
  getBodyCollisionWorldOBBs(contraption, body) {
    if (!contraption || !body) return [];
    const attached = contraption.getAttachedNodeIds?.(body.id) || new Set([body.id]);
    const boxes = [];
    const nodeTransforms = new Map();
    for (const cell of contraption.collisionSurfaceEntries || contraption.collisionEntries || []) {
      if (!attached.has(cell.entityId)) continue;
      if (contraption.isNodeCollisionEnabled?.(cell.entityId) === false) continue;
      const node = contraption.getEntityNode?.(cell.entityId) || contraption.getEntityNode?.();
      let transform = nodeTransforms.get(cell.entityId);
      if (!transform) {
        node?.group?.updateWorldMatrix?.(true, false);
        const quaternion = node?.group?.getWorldQuaternion?.(new THREE.Quaternion())
          || body.quaternion.clone();
        transform = {
          matrix: node?.group?.matrixWorld || null,
          pivot: node?.pivotLocal || new THREE.Vector3(),
          axes: [
            new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize(),
            new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
            new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize()
          ]
        };
        nodeTransforms.set(cell.entityId, transform);
      }
      const axes = transform.axes;
      const size = cell.span * 0.2;
      const halfExtents = [size / 2, size / 2, size / 2];
      const center = new THREE.Vector3(
        (cell.x + cell.span / 2) * 0.2,
        (cell.y + cell.span / 2) * 0.2,
        (cell.z + cell.span / 2) * 0.2
      );
      if (transform.matrix) center.sub(transform.pivot).applyMatrix4(transform.matrix);
      else center.copy(contraption.localToWorld(center));
      const radiusX = halfExtents.reduce((sum, half, index) => sum + half * Math.abs(axes[index].x), 0);
      const radiusY = halfExtents.reduce((sum, half, index) => sum + half * Math.abs(axes[index].y), 0);
      const radiusZ = halfExtents.reduce((sum, half, index) => sum + half * Math.abs(axes[index].z), 0);
      boxes.push({
        center,
        axes,
        halfExtents,
        minX: center.x - radiusX,
        maxX: center.x + radiusX,
        minY: center.y - radiusY,
        maxY: center.y + radiusY,
        minZ: center.z - radiusZ,
        maxZ: center.z + radiusZ,
        cell,
        body
      });
    }
    return boxes;
  }

  orientedBoxAabbContact(obb, box) {
    const terrainCenter = new THREE.Vector3(
      (box.minX + box.maxX) / 2,
      (box.minY + box.maxY) / 2,
      (box.minZ + box.maxZ) / 2
    );
    const terrainHalf = new THREE.Vector3(
      (box.maxX - box.minX) / 2,
      (box.maxY - box.minY) / 2,
      (box.maxZ - box.minZ) / 2
    );
    const worldAxes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1)
    ];
    const candidateAxes = [...obb.axes, ...worldAxes];
    for (const bodyAxis of obb.axes) {
      for (const terrainAxis of worldAxes) {
        const cross = new THREE.Vector3().crossVectors(bodyAxis, terrainAxis);
        if (cross.lengthSq() > 1e-10) candidateAxes.push(cross);
      }
    }

    const delta = obb.center.clone().sub(terrainCenter);
    let penetration = Infinity;
    let normal = null;
    for (const rawAxis of candidateAxes) {
      const axis = rawAxis.clone().normalize();
      const bodyRadius = obb.halfExtents.reduce((sum, half, index) => (
        sum + half * Math.abs(obb.axes[index].dot(axis))
      ), 0);
      const terrainRadius = terrainHalf.x * Math.abs(axis.x)
        + terrainHalf.y * Math.abs(axis.y)
        + terrainHalf.z * Math.abs(axis.z);
      const signedDistance = delta.dot(axis);
      const overlap = bodyRadius + terrainRadius - Math.abs(signedDistance);
      if (overlap <= 1e-7) return null;
      if (overlap < penetration) {
        penetration = overlap;
        normal = axis.multiplyScalar(signedDistance >= 0 ? 1 : -1);
      }
    }
    if (!normal || !Number.isFinite(penetration)) return null;

    // The terrain support feature is a face, edge, or vertex depending on the
    // separating normal. Its center is a much better angular-impulse lever arm
    // than an arbitrary OBB vertex, especially for face-edge contact.
    const hitPosition = terrainCenter.clone();
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(normal[axis]) > 1e-6) {
        hitPosition[axis] += terrainHalf[axis] * Math.sign(normal[axis]);
      }
    }
    return { normal, penetration, hitPosition };
  }

  terrainBoxesOverlapping(obb) {
    const boxes = [];
    // SAT requires positive overlap, so a box whose maximum lies exactly on a
    // voxel boundary does not overlap the cell on the far side. Half-open
    // ranges turn the common aligned case from eight queries into one.
    const maxX = Math.floor(obb.maxX - 1e-7);
    const maxY = Math.floor(obb.maxY - 1e-7);
    const maxZ = Math.floor(obb.maxZ - 1e-7);
    for (let x = Math.floor(obb.minX); x <= maxX; x++) {
      for (let y = Math.floor(obb.minY); y <= maxY; y++) {
        for (let z = Math.floor(obb.minZ); z <= maxZ; z++) {
          if (this.world.getBlock(x, y, z) === BlockTypes.AIR) continue;
          boxes.push({ minX: x, maxX: x + 1, minY: y, maxY: y + 1, minZ: z, maxZ: z + 1 });
        }
      }
    }

    const bounds = {
      minX: obb.minX,
      minY: obb.minY,
      minZ: obb.minZ,
      maxX: obb.maxX,
      maxY: obb.maxY,
      maxZ: obb.maxZ
    };
    const queriedMicro = this.world.getMicroBlocksInAABB?.(bounds, true);
    if (Array.isArray(queriedMicro)) {
      for (const cell of queriedMicro) {
        const size = Number(cell.size) || 0.2;
        boxes.push({
          minX: cell.x,
          maxX: cell.x + size,
          minY: cell.y,
          maxY: cell.y + size,
          minZ: cell.z,
          maxZ: cell.z + size
        });
      }
    } else if (typeof (this.world as any).getMicroBlock === 'function') {
      const maxMx = Math.floor(obb.maxX * 5 - 1e-7);
      const maxMy = Math.floor(obb.maxY * 5 - 1e-7);
      const maxMz = Math.floor(obb.maxZ * 5 - 1e-7);
      for (let mx = Math.floor(obb.minX * 5); mx <= maxMx; mx++) {
        for (let my = Math.floor(obb.minY * 5); my <= maxMy; my++) {
          for (let mz = Math.floor(obb.minZ * 5); mz <= maxMz; mz++) {
            const micro = (this.world as any).getMicroBlock(mx, my, mz);
            if (micro === null || micro === undefined) continue;
            boxes.push({
              minX: mx / 5,
              maxX: (mx + 1) / 5,
              minY: my / 5,
              maxY: (my + 1) / 5,
              minZ: mz / 5,
              maxZ: (mz + 1) / 5
            });
          }
        }
      }
    }
    return boxes;
  }

  exactTerrainContacts(contraption, body) {
    const contacts = [];
    for (const obb of this.getBodyCollisionWorldOBBs(contraption, body)) {
      for (const terrainBox of this.terrainBoxesOverlapping(obb)) {
        const contact = this.orientedBoxAabbContact(obb, terrainBox);
        if (!contact) continue;
        // A diagonal SAT normal selects a terrain edge or vertex. It is only a
        // real feature of the voxel union when every incident face selected by
        // that normal is exposed. Testing just beyond the diagonal corner is
        // insufficient: on a tiled floor that point is in the air even though
        // the horizontal face is an internal seam shared with its neighbour.
        const terrainCenter = new THREE.Vector3(
          (terrainBox.minX + terrainBox.maxX) / 2,
          (terrainBox.minY + terrainBox.maxY) / 2,
          (terrainBox.minZ + terrainBox.maxZ) / 2
        );
        let exposed = true;
        for (const axis of ['x', 'y', 'z'] as const) {
          if (Math.abs(contact.normal[axis]) <= 1e-6) continue;
          const facePoint = terrainCenter.clone();
          facePoint[axis] = contact.normal[axis] > 0
            ? terrainBox[`max${axis.toUpperCase()}`]
            : terrainBox[`min${axis.toUpperCase()}`];
          facePoint[axis] += Math.sign(contact.normal[axis]) * 0.002;
          if (this.terrainCellAtPoint(facePoint)) {
            exposed = false;
            break;
          }
        }
        if (!exposed) continue;
        contacts.push(contact);
      }
    }
    return contacts;
  }

  terrainContactAtPoint(point) {
    const cell = this.terrainCellAtPoint(point);
    if (!cell) return null;
    const penetrations = [
      point.x - cell.minX,
      cell.maxX - point.x,
      point.y - cell.minY,
      cell.maxY - point.y,
      point.z - cell.minZ,
      cell.maxZ - point.z
    ];
    // Rotated sample points land on voxel boundary planes all the time (a
    // 45-degree tilted block whose corner rides the seam between two floor
    // voxels is the classic case). floor() then snaps the point to one cell
    // where the shared face reports zero penetration. Those faces carry no
    // separation depth, but they must not abort the search: the point can sit
    // deep inside solid terrain while every face it touches is an interior
    // seam, and its only real way out is a face further away. Faces with
    // penetration > 0 but a solid cell on the far side are interior seams too.
    let remainingFaces = 0b111111;
    let fallbackIndex = -1;
    let fallbackPenetration = Infinity;
    while (remainingFaces) {
      let index = -1;
      let penetration = Infinity;
      for (let candidate = 0; candidate < TERRAIN_FACE_NORMALS.length; candidate++) {
        if (!(remainingFaces & (1 << candidate))) continue;
        if (penetrations[candidate] < penetration) {
          penetration = penetrations[candidate];
          index = candidate;
        }
      }
      if (index < 0) break;
      const normal = TERRAIN_FACE_NORMALS[index];
      const outside = point.clone().addScaledVector(normal, penetration + 0.002);
      // Shared faces inside solid terrain are not collision surfaces. Looking
      // just outside the candidate face leaves only the actual exposed shell.
      if (this.terrainCellAtPoint(outside)) {
        remainingFaces &= ~(1 << index);
        if (penetration > 0 && penetration < fallbackPenetration) {
          // Remember the shallowest seam in case every face is interior: a
          // body buried deep inside thick terrain must still receive a push,
          // otherwise it silently tunnels through the world.
          fallbackIndex = index;
          fallbackPenetration = penetration;
        }
        continue;
      }
      if (!(penetration > 0)) {
        // Exactly on an exposed shell face: touching, not overlapping.
        return null;
      }
      return { normal, penetration };
    }
    if (fallbackIndex >= 0) {
      return { normal: TERRAIN_FACE_NORMALS[fallbackIndex], penetration: fallbackPenetration };
    }
    return null;
  }

  sweepTerrainContact(start, end) {
    const movement = end.clone().sub(start);
    const distance = movement.length();
    if (distance < 1e-8) return null;
    const direction = movement.divideScalar(distance);
    const hits = [
      this.world.raycast?.(start, direction, distance + 0.002),
      this.world.raycastMicro?.(start, direction, distance + 0.002)
    ].filter(hit => hit?.hit
      && Number.isFinite(hit.distance)
      && hit.distance >= 0
      && hit.distance <= distance + 0.002);
    hits.sort((a, b) => a.distance - b.distance);

    for (const hit of hits) {
      const normal = new THREE.Vector3(
        Number(hit.normal?.x) || 0,
        Number(hit.normal?.y) || 0,
        Number(hit.normal?.z) || 0
      );
      if (normal.lengthSq() < 0.5) continue;
      normal.normalize();
      const approach = -direction.dot(normal);
      if (approach <= 1e-6) continue;
      const overtravel = Math.max(0, distance - hit.distance) * approach;
      if (overtravel <= 0) continue;
      return {
        normal,
        // solveTerrainContact retains one millimetre of resting slop. Add a
        // second millimetre here so a swept sample finishes strictly outside
        // the entry plane and the next fixed substep can sweep it again.
        penetration: overtravel + 0.002,
        hitPosition: start.clone().addScaledVector(direction, hit.distance)
      };
    }
    return null;
  }

  /**
   * Limit an editor-style wrench drive before it overwrites collision response.
   * Ordinary CCD runs after integration, but a held wrench writes a new target
   * velocity every frame; without this preflight, the next frame can drive the
   * body back into (and eventually through) the same wall. Probe every collider
   * sample through this frame's requested displacement and stop at the earliest
   * terrain or entity entry face.
   */
  sweepPointAabb(start, direction, maxDistance, box) {
    const inside = start.x >= box.minX && start.x <= box.maxX
      && start.y >= box.minY && start.y <= box.maxY
      && start.z >= box.minZ && start.z <= box.maxZ;
    if (inside) {
      const faces = [
        { distance: start.x - box.minX, normal: new THREE.Vector3(-1, 0, 0) },
        { distance: box.maxX - start.x, normal: new THREE.Vector3(1, 0, 0) },
        { distance: start.y - box.minY, normal: new THREE.Vector3(0, -1, 0) },
        { distance: box.maxY - start.y, normal: new THREE.Vector3(0, 1, 0) },
        { distance: start.z - box.minZ, normal: new THREE.Vector3(0, 0, -1) },
        { distance: box.maxZ - start.z, normal: new THREE.Vector3(0, 0, 1) }
      ].sort((a, b) => a.distance - b.distance);
      return { distance: 0, normal: faces[0].normal };
    }

    let near = 0;
    let far = maxDistance;
    let normal = null;
    for (const axis of ['x', 'y', 'z'] as const) {
      const component = direction[axis];
      const min = box[`min${axis.toUpperCase()}`];
      const max = box[`max${axis.toUpperCase()}`];
      if (Math.abs(component) < 1e-10) {
        if (start[axis] < min || start[axis] > max) return null;
        continue;
      }
      let entry = (min - start[axis]) / component;
      let exit = (max - start[axis]) / component;
      let entrySign = -1;
      if (entry > exit) {
        [entry, exit] = [exit, entry];
        entrySign = 1;
      }
      if (entry > near) {
        near = entry;
        normal = new THREE.Vector3();
        normal[axis] = entrySign;
      }
      far = Math.min(far, exit);
      if (near > far) return null;
    }
    if (!normal || near < 0 || near > maxDistance) return null;
    return { distance: near, normal };
  }

  /**
   * Sweep a world-space point against an entity cell's actual oriented box.
   * Entity collision boxes also expose a conservative world AABB for broad
   * phase queries. Using that AABB as the wrench's narrow phase makes empty
   * corners of a rotated box solid, and can therefore reject the only velocity
   * that would pull two resting bodies apart. Transforming the ray into the
   * cell's orthonormal frame keeps the inexpensive slab test while matching
   * the shape used by the entity contact solver.
   */
  sweepPointEntityBox(start, direction, maxDistance, box) {
    const obb = this.entityCollisionObb(box);
    if (!obb) return this.sweepPointAabb(start, direction, maxDistance, box);

    const relativeStart = start.clone().sub(obb.center);
    const localStart = new THREE.Vector3(
      relativeStart.dot(obb.axes[0]),
      relativeStart.dot(obb.axes[1]),
      relativeStart.dot(obb.axes[2])
    );
    const localDirection = new THREE.Vector3(
      direction.dot(obb.axes[0]),
      direction.dot(obb.axes[1]),
      direction.dot(obb.axes[2])
    );
    const contact = this.sweepPointAabb(localStart, localDirection, maxDistance, {
      minX: -obb.halfExtents[0],
      maxX: obb.halfExtents[0],
      minY: -obb.halfExtents[1],
      maxY: obb.halfExtents[1],
      minZ: -obb.halfExtents[2],
      maxZ: obb.halfExtents[2]
    });
    if (!contact) return null;

    const normal = new THREE.Vector3()
      .addScaledVector(obb.axes[0], contact.normal.x)
      .addScaledVector(obb.axes[1], contact.normal.y)
      .addScaledVector(obb.axes[2], contact.normal.z)
      .normalize();
    return { distance: contact.distance, normal };
  }

  constrainWrenchVelocity(contraption, body, desiredVelocity, dt, contraptions = []) {
    const velocity = desiredVelocity?.clone?.() || new THREE.Vector3();
    const safeDt = Math.max(1 / 240, Math.min(0.08, Number(dt) || 0));
    const frameDistance = velocity.length() * safeDt;
    if (!body || frameDistance < 1e-8) return { velocity, normals: [] };

    const direction = velocity.clone().normalize();
    const probeDistance = frameDistance + 0.02;
    const samples = contraption.getCollisionSamplePoints?.(body.id, true) || [];
    const normals: THREE.Vector3[] = [];
    let allowedFraction = 1;

    for (const start of samples) {
      const end = start.clone().addScaledVector(direction, probeDistance);
      const contact = this.sweepTerrainContact(start, end);
      if (!contact || velocity.dot(contact.normal) >= -1e-8) continue;
      const hitDistance = contact.hitPosition
        ? start.distanceTo(contact.hitPosition)
        : 0;
      const allowedDistance = Math.max(0, hitDistance - 0.004);
      allowedFraction = Math.min(allowedFraction, allowedDistance / frameDistance);
      if (!normals.some(normal => normal.dot(contact.normal) > 0.999)) {
        normals.push(contact.normal.clone());
      }
    }

    for (const other of contraptions || []) {
      if (!other || other === contraption) continue;
      const broadphaseDistance = Math.max(0.5, Number(contraption.boundingRadius) || 0.5)
        + Math.max(0.5, Number(other.boundingRadius) || 0.5)
        + probeDistance;
      const centerA = typeof contraption.getWorldCenter === 'function'
        ? contraption.getWorldCenter()
        : (contraption.localCenter ? contraption.localToWorld(contraption.localCenter.clone()) : contraption.position);
      const centerB = typeof other.getWorldCenter === 'function'
        ? other.getWorldCenter()
        : (other.localCenter ? other.localToWorld(other.localCenter.clone()) : other.position);
      const minDistanceSq = Math.min(
        centerA.distanceToSquared(centerB),
        contraption.position.distanceToSquared(other.position)
      );
      if (minDistanceSq > broadphaseDistance * broadphaseDistance) continue;
      const boxes = other.getCollisionWorldAABBs?.() || [];
      for (const start of samples) {
        for (const box of boxes) {
          const contact = this.sweepPointEntityBox(start, direction, probeDistance, box);
          if (!contact || velocity.dot(contact.normal) >= -1e-8) continue;
          const allowedDistance = Math.max(0, contact.distance - 0.004);
          allowedFraction = Math.min(allowedFraction, allowedDistance / frameDistance);
          if (!normals.some(normal => normal.dot(contact.normal) > 0.999)) {
            normals.push(contact.normal.clone());
          }
        }
      }
    }

    if (allowedFraction < 1) velocity.multiplyScalar(Math.max(0, allowedFraction));
    return { velocity, normals };
  }

  /**
   * Width of the narrowest principal axis of a support point set projected
   * onto the contact plane. Points that span a single point or a line (corner
   * or edge balance) have width ~0; any real face support is at least as wide
   * as its cell.
   */
  supportWidth(points, normal) {
    if (!points || points.length <= 2) return 0;
    const tangent = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) tangent.set(0, 1, 0);
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    tangent.crossVectors(bitangent, normal).normalize();
    let meanU = 0;
    let meanV = 0;
    for (const point of points) {
      meanU += point.dot(tangent);
      meanV += point.dot(bitangent);
    }
    meanU /= points.length;
    meanV /= points.length;
    let suu = 0;
    let svv = 0;
    let suv = 0;
    for (const point of points) {
      const du = point.dot(tangent) - meanU;
      const dv = point.dot(bitangent) - meanV;
      suu += du * du;
      svv += dv * dv;
      suv += du * dv;
    }
    const trace = suu + svv;
    const determinant = suu * svv - suv * suv;
    const discriminant = Math.max(0, trace * trace / 4 - determinant);
    const narrowEigenvalue = trace / 2 - Math.sqrt(discriminant);
    return 2 * Math.sqrt(Math.max(0, narrowEigenvalue));
  }

  /**
   * Tip a body that rests on a narrow (point or line) upward support. A face
   * flush with the support plane stays put; a tilted or corner-down body gets
   * a gravity-scaled angular kick around the contact edge so the balance
   * breaks instead of persisting forever. Shared by terrain contacts (width
   * check) and entity pairs (SAT feature check).
   */
  toppleNarrowSupport(body, normal, dt) {
    if (!this.isSimulatedDynamicBody(body)) return;
    const bodyAxes = [
      new THREE.Vector3(1, 0, 0).applyQuaternion(body.quaternion),
      new THREE.Vector3(0, 1, 0).applyQuaternion(body.quaternion),
      new THREE.Vector3(0, 0, 1).applyQuaternion(body.quaternion)
    ];
    let supportFace = bodyAxes[0];
    for (const axis of bodyAxes.slice(1)) {
      if (Math.abs(axis.dot(normal)) > Math.abs(supportFace.dot(normal))) supportFace = axis;
    }
    if (supportFace.dot(normal) < 0) supportFace.multiplyScalar(-1);
    const alignment = supportFace.dot(normal);
    if (alignment < 0.995) {
      const toppleAxis = supportFace.clone().cross(normal);
      const instability = toppleAxis.length();
      if (instability > 1e-6) {
        const acceleration = this.gravity.length() * 0.25 * instability;
        body.angularVelocity.addScaledVector(toppleAxis.divideScalar(instability), acceleration * dt);
      }
    }
  }

  solveTerrainContact(body, normal, hitPosition, penetration, contactPoints, dt) {
    body.position.addScaledVector(normal, Math.max(0, penetration - 0.001));
    if (normal.y > 0.5) body.isOnGround = true;

    const r = hitPosition.clone().sub(body.position);
    const contactVelocity = body.velocity.clone().add(body.angularVelocity.clone().cross(r));
    const normalVelocity = contactVelocity.dot(normal);
    if (normalVelocity >= 0) return 0;

    const restitution = Math.abs(normalVelocity) < 0.5 ? 0 : body.restitution;
    const inverseMass = 1 / body.mass;
    const normalLever = r.clone().cross(normal);
    const normalDenominator = inverseMass + normalLever.lengthSq() * body.inverseInertia;
    const normalImpulseMagnitude = normalDenominator > 1e-9
      ? -(1 + restitution) * normalVelocity / normalDenominator
      : 0;
    const normalImpulse = normal.clone().multiplyScalar(normalImpulseMagnitude);

    body.velocity.addScaledVector(normalImpulse, inverseMass);
    body.angularVelocity.addScaledVector(normalLever, normalImpulseMagnitude * body.inverseInertia);

    // Solve Coulomb friction after the support impulse. Its effective mass
    // includes the same contact lever arm, and the impulse is capped by μN.
    const postNormalVelocity = body.velocity.clone().add(body.angularVelocity.clone().cross(r));
    const tangentVelocity = postNormalVelocity
      .clone()
      .addScaledVector(normal, -postNormalVelocity.dot(normal));
    const tangentSpeed = tangentVelocity.length();
    if (tangentSpeed > 0.01 && normalImpulseMagnitude > 0) {
      const tangent = tangentVelocity.divideScalar(tangentSpeed);
      const tangentLever = r.clone().cross(tangent);
      const tangentDenominator = inverseMass + tangentLever.lengthSq() * body.inverseInertia;
      if (tangentDenominator > 1e-9) {
        const frictionImpulseMagnitude = Math.max(
          -normalImpulseMagnitude * body.friction,
          -tangentSpeed / tangentDenominator
        );
        body.velocity.addScaledVector(tangent, frictionImpulseMagnitude * inverseMass);
        body.angularVelocity.addScaledVector(
          tangentLever,
          frictionImpulseMagnitude * body.inverseInertia
        );
      }
    }

    // Perfect voxels can balance forever on a sampled corner or edge. Mimic
    // real contact asymmetry only on narrow upward support manifolds: a
    // support whose points span a point or a line has width ~0 and is
    // unstable, while any real face rest - including a 0.2m micro voxel face -
    // spans a visible area. This adds no linear energy and never turns a wall
    // collision into auto-levelling.
    if (normal.y > 0.5 && this.supportWidth(contactPoints, normal) < SUPPORT_WIDTH_NARROW) {
      this.toppleNarrowSupport(body, normal, dt);
    }

    const residualNormalVelocity = body.velocity.dot(normal);
    if (Math.abs(residualNormalVelocity) < RESTING_CONTACT_VELOCITY) {
      body.velocity.addScaledVector(normal, -residualNormalVelocity);
    }
    if (body.velocity.lengthSq() < 0.01) body.velocity.set(0, 0, 0);
    return normalImpulseMagnitude;
  }

  resolveTerrainCollisionBody(contraption, body, dt, previousPose = null) {
    // A dynamic body's terrain contact includes every kinematic part rigidly
    // attached to it: after a child component is split off, the child's cells
    // still move with the body (scene-graph parent), so they must keep the
    // structure supported instead of silently losing that ground contact.
    const samplePoints = contraption.getCollisionSamplePoints(body.id, true);
    const contacts = new Map();
    const translationDistance = previousPose
      ? body.position.distanceTo(previousPose.position)
      : 0;
    const rotationDistance = previousPose
      ? body.quaternion.angleTo(previousPose.quaternion) * Math.max(0.5, contraption.boundingRadius || 0)
      : 0;
    const shouldSweep = translationDistance + rotationDistance >= TERRAIN_SWEEP_THRESHOLD;
    const inverseCurrentQuaternion = previousPose ? body.quaternion.clone().invert() : null;

    const addContact = (resolvedContact, point) => {
      const key = [resolvedContact.normal.x, resolvedContact.normal.y, resolvedContact.normal.z]
        .map(value => value.toFixed(5))
        .join(',');
      const group = contacts.get(key) || {
        normal: resolvedContact.normal,
        penetration: 0,
        hitPosition: new THREE.Vector3(),
        points: [],
        count: 0
      };
      group.penetration = Math.max(group.penetration, resolvedContact.penetration);
      group.hitPosition.add(point);
      group.points.push(point);
      group.count++;
      contacts.set(key, group);
    };

    for (let index = 0; index < samplePoints.length; index++) {
      const pt = samplePoints[index];
      const previousPoint = previousPose
        ? pt.clone()
          .sub(body.position)
          .applyQuaternion(inverseCurrentQuaternion)
          .applyQuaternion(previousPose.quaternion)
          .add(previousPose.position)
        : null;
      const contact = this.terrainContactAtPoint(pt);
      let sweptContact = shouldSweep && previousPoint
        ? this.sweepTerrainContact(previousPoint, pt)
        : null;
      if (!sweptContact && contact && previousPoint) {
        // Below the sweep threshold the substep displacement can still carry a
        // rotated corner deep enough that its endpoint reports an exit face
        // (a wall seam) instead of the face it entered through. The sweep from
        // the previous position carries the actual entry face and is safe to
        // attempt: it returns null when the start point is already embedded.
        sweptContact = this.sweepTerrainContact(previousPoint, pt);
      }
      // A deeply embedded endpoint may be closer to the far side of a voxel
      // and therefore report its exit face. The sweep carries the actual entry
      // face and must win whenever the point travelled far enough to need CCD.
      const resolvedContact = sweptContact || contact;
      if (!resolvedContact) continue;
      addContact(resolvedContact, sweptContact?.hitPosition || pt);
    }

    // Sampling one body's surface cannot see the dual face-edge topology: a
    // terrain edge can enter the interior of an OBB face while every sampled
    // body point remains outside terrain. Exact SAT must augment even a
    // non-empty sampled manifold, because a few shallow point contacts do not
    // constrain a different edge that is already entering the face.
    const sampledNormals = [...contacts.values()].map(group => group.normal);
    for (const exactContact of this.exactTerrainContacts(contraption, body)) {
      if (exactContact.penetration <= EXACT_TERRAIN_CONTACT_SLOP) continue;
      const terrainFeatureDimensions = ['x', 'y', 'z'].filter(axis => (
        Math.abs(exactContact.normal[axis]) > 1e-6
      )).length;
      // A sampled face normal already gives the higher-quality manifold for a
      // normal terrain face. The exact supplement is needed alongside it only
      // for a terrain edge/vertex, or when the sampled points constrain an
      // unrelated direction (for example both Z faces while a top edge is
      // entering the body along Y).
      const constrainedBySamples = sampledNormals.some(normal => (
        normal.dot(exactContact.normal) > 0.999
      ));
      if (constrainedBySamples && terrainFeatureDimensions < 2) continue;
      addContact(exactContact, exactContact.hitPosition);
    }

    // Resolve independent exposed faces in one substep (for example floor +
    // wall at a corner). The ground flag is reset once per entity update, so a
    // contact found in any of its three substeps remains stable for that update.
    const groups = [...contacts.values()].sort((a, b) => b.penetration - a.penetration);
    for (const group of groups) {
      group.hitPosition.divideScalar(group.count);
      const relativeVelocity = body.velocity.clone();
      const impulse = this.solveTerrainContact(
        body,
        group.normal,
        group.hitPosition,
        group.penetration,
        group.points,
        dt
      );
      contraption.recordScriptContact?.({
        kind: 'terrain',
        selfNodeId: body.id,
        otherEntityId: null,
        otherNodeId: null,
        playerId: null,
        position: group.hitPosition.toArray(),
        normal: group.normal.toArray(),
        relativeVelocity: relativeVelocity.toArray(),
        penetration: Number(group.penetration) || 0,
        impulse: Number(impulse) || 0
      });
    }
    // Solving another face can reintroduce a small inward centre velocity on a
    // face that was handled earlier. Project all resolved normals once more so
    // a sustained force cannot ratchet a body through a wall between fixed
    // substeps.
    for (const group of groups) {
      const inwardVelocity = body.velocity.dot(group.normal);
      if (inwardVelocity < 0) {
        body.velocity.addScaledVector(group.normal, -inwardVelocity);
      }
    }
  }

  applyImpulse(contraption, impulse, worldPoint = null, nodeId = contraption?.rootComponentId) {
    const body = contraption.getRigidBody?.(nodeId);
    if (!this.isSimulatedDynamicBody(body)) return;
    body.velocity.addScaledVector(impulse, 1 / body.mass);

    if (worldPoint) {
      const r = worldPoint.clone().sub(body.position);
      const torque = r.cross(impulse);
      body.angularVelocity.add(torque.multiplyScalar(body.inverseInertia));
    }
  }
}

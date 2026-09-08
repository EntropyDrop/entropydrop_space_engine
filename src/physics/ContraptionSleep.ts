const SETTLE_SECONDS = 1;
const MAX_SPEED_SQ = 0.02 ** 2;
const MAX_POSE_DRIFT = 0.002;

type Pose = { shape: any; values: any[] };
type SleepState = {
  sleeping: boolean;
  quietTime: number;
  epoch: number;
  pose: Pose | null;
  startPose: Pose | null;
  terrainVersion: number;
  terrainStamp: any[] | null;
  restingContacts: any[];
  chunkWindow: any;
  supports: Map<any, { pose: Pose; epoch: number }>;
  pendingSupports: Set<any>;
};

/** Whole contraptions sleep together, including their constrained bodies.
 * Script scheduling is unchanged. Sleeping bodies retain resting contact
 * observations with zero impact impulse, and script forces wake them immediately. */
export class ContraptionSleep {
  private states = new WeakMap<object, SleepState>();
  private activeEntities: Set<any> | null = null;
  private stoppedPoses = new WeakMap<object, Pose>();
  private world: any;

  constructor(world: any) { this.world = world; }

  setActiveEntities(entities: any[]) {
    this.activeEntities = new Set(entities);
  }

  private state(entity): SleepState {
    let state = this.states.get(entity);
    if (!state) {
      state = { sleeping: false, quietTime: 0, epoch: 0, pose: null, startPose: null,
        terrainVersion: 0, terrainStamp: null, restingContacts: [], chunkWindow: null, supports: new Map(), pendingSupports: new Set() };
      this.states.set(entity, state);
    }
    return state;
  }

  isSleeping(entity): boolean { return this.states.get(entity)?.sleeping === true; }

  wake(entity) {
    const state = this.states.get(entity);
    if (!state) return;
    state.sleeping = false;
    state.quietTime = 0;
    state.epoch++;
    state.supports.clear();
    state.restingContacts = [];
  }

  suspend(entity) {
    const state = this.states.get(entity);
    if (state && (state.sleeping || state.quietTime > 0)) this.wake(entity);
  }

  private pose(entity): Pose {
    const values: any[] = [entity.isPhysicsSimulationEnabled?.(), entity.physicsWakeVersion,
      JSON.stringify([...(entity.constraintDefinitions?.values?.() || [])])];
    for (const body of entity.getRigidBodies?.() || []) {
      values.push(body, body.type, body.simulationEnabled, body.mass, body.inverseInertia,
        body.friction, body.restitution, body.linearDamping, body.angularDamping,
        entity.getNodeGravityEnabled?.(body.id), entity.getNodeCollisionEnabled?.(body.id),
        body.position.x, body.position.y, body.position.z,
        body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }
    // Include attached/kinematic geometry, even when it has no dynamic body.
    for (const node of entity.entityNodes?.values?.() || []) {
      values.push(node, ...node.group.matrixWorld.elements);
    }
    return { shape: entity.collisionEntries, values };
  }

  private samePose(a: Pose | null, b: Pose, tolerance = 0): boolean {
    return !!a && a.shape === b.shape && a.values.length === b.values.length
      && a.values.every((value, index) => value === b.values[index]
        || (tolerance > 0 && typeof value === 'number' && typeof b.values[index] === 'number'
          && Math.abs(value - b.values[index]) <= tolerance));
  }

  private eligible(entity): boolean {
    // A host without terrain revision notifications must keep polling physics:
    // sleeping there could miss a removed floor or a newly loaded collision chunk.
    if (!Number.isFinite(this.world.terrainVersion)) return false;
    if (entity.isPhysicsSimulationEnabled?.() === false) return false;
    return true;
  }

  private terrainStamp(entity): any[] | null {
    if (typeof this.world.getTerrainCollisionStamp !== 'function') return null;
    const boxes = entity.getPhysicsCollisionWorldAABBs?.() || entity.getCollisionWorldAABBs?.() || [];
    if (!boxes.length) return this.world.getTerrainCollisionStamp({
      minX: entity.position.x - 1, maxX: entity.position.x + 1,
      minZ: entity.position.z - 1, maxZ: entity.position.z + 1,
    });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const box of boxes) {
      minX = Math.min(minX, box.currentMinX ?? box.minX); maxX = Math.max(maxX, box.currentMaxX ?? box.maxX);
      minZ = Math.min(minZ, box.currentMinZ ?? box.minZ); maxZ = Math.max(maxZ, box.currentMaxZ ?? box.maxZ);
    }
    return this.world.getTerrainCollisionStamp({ minX: minX - 0.1, maxX: maxX + 0.1,
      minZ: minZ - 0.1, maxZ: maxZ + 0.1 });
  }

  private terrainChanged(entity, state: SleepState): boolean {
    const current = this.terrainStamp(entity);
    if (current === null || state.terrainStamp === null) {
      return state.terrainVersion !== this.world.terrainVersion
        || state.chunkWindow !== this.world.activeChunkKeys;
    }
    return current.length !== state.terrainStamp.length
      || current.some((value, index) => value !== state.terrainStamp![index]);
  }

  begin(entity) {
    const state = this.state(entity);
    if (!this.eligible(entity)) {
      if (state.sleeping || state.quietTime > 0) this.wake(entity);
      return false;
    }
    if (state.sleeping) {
      const changed = !this.eligible(entity)
        || this.terrainChanged(entity, state)
        || !this.samePose(state.pose, this.pose(entity))
        || (entity.getRigidBodies?.() || []).some(body => (
          body.velocity.lengthSq() > 1e-12 || body.angularVelocity.lengthSq() > 1e-12
          || body.appliedForces.lengthSq() > 1e-12 || body.appliedTorques.lengthSq() > 1e-12
        ))
        || [...state.supports].some(([support, saved]) => (
          (this.activeEntities && !this.activeEntities.has(support))
          || saved.epoch !== (this.states.get(support)?.epoch || 0)
          || !this.samePose(saved.pose, this.pose(support))
        ));
      if (changed) this.wake(entity);
    }
    if (!state.sleeping) {
      state.startPose = this.pose(entity);
      state.pendingSupports.clear();
    }
    if (state.sleeping) {
      for (const contact of state.restingContacts) entity.recordScriptContact?.(contact);
    }
    return state.sleeping;
  }

  stoppedColliderChanged(entity): boolean {
    const pose = this.pose(entity);
    const previous = this.stoppedPoses.get(entity);
    this.stoppedPoses.set(entity, pose);
    return !this.samePose(previous || null, pose);
  }

  recordSupport(entity, support) {
    this.state(entity).pendingSupports.add(support);
  }

  finish(entity, dt, frameInputs) {
    const state = this.state(entity);
    if (state.sleeping || !this.eligible(entity)) return;
    const bodies = entity.getRigidBodies?.() || [];
    const pose = this.pose(entity);
    const quiet = bodies.length > 0
      && this.samePose(state.startPose, pose, MAX_POSE_DRIFT)
      && bodies.every(body => (
        body.velocity.lengthSq() <= MAX_SPEED_SQ && body.angularVelocity.lengthSq() <= MAX_SPEED_SQ
        && (body.type !== 'dynamic' || body.simulationEnabled === false
          || entity.getNodeGravityEnabled?.(body.id) === false || body.isOnGround)
      ))
      && [...frameInputs.values()].every(input => input.force.lengthSq() <= 1e-12 && input.torque.lengthSq() <= 1e-12);
    state.quietTime = quiet ? state.quietTime + dt : 0;
    if (state.quietTime + 1e-9 < SETTLE_SECONDS) return;
    state.sleeping = true;
    for (const body of bodies) {
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    }
    state.pose = pose;
    state.terrainVersion = this.world.terrainVersion;
    state.terrainStamp = this.terrainStamp(entity);
    // ctx.contacts describes contact observations, not discrete collision events.
    // Preserve resting support without replaying the impulse of an old impact.
    const supports = new Set([...state.pendingSupports].map(support => support.publicId));
    state.restingContacts = (entity.pendingScriptContacts || [])
      .filter(contact => contact.kind === 'terrain'
        || (contact.kind === 'entity' && supports.has(contact.otherEntityId)))
      .map(contact => ({ ...contact, relativeVelocity: [0, 0, 0], impulse: 0,
        penetration: 0, sleeping: true }));
    state.chunkWindow = this.world.activeChunkKeys;
    state.supports = new Map([...state.pendingSupports].map(support => [support, {
      pose: this.pose(support), epoch: this.states.get(support)?.epoch || 0,
    }]));
  }
}

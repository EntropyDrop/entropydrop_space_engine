import * as THREE from 'three';
import {
  BodyType,
  Contraption,
  ContraptionMode,
  MAX_ENTITY_BOUNDS,
  createEntityPublicId,
  isValidComponentId
} from './Contraption.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import {
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  unwrapPeriodicNear,
  wrapX,
  wrapZ,
  wrapChunkX,
  wrapChunkZ,
  wrapMicroX,
  wrapMicroZ
} from '../torus/TorusWorld.ts';
import { MICRO_DIVISIONS } from '../voxel/MicroVoxelLayer.ts';
import { ActionDomain, executeBasicAction } from '../actions/BasicActions.ts';
import type { SpaceStorage } from '../storage/SpaceStorage.ts';

export const ENTITY_STORAGE_PREFIX = 'entropydrop_space_entities';
export const ENTITY_STORAGE_VERSION = 3;

export function worldEntitiesStorageKey(worldId: string) {
  return `${ENTITY_STORAGE_PREFIX}.${encodeURIComponent(worldId || 'default')}`;
}

function isFiniteVector3Array(value: any): boolean {
  return Array.isArray(value)
    && value.length >= 3
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Number.isFinite(Number(value[2]));
}

function isMicroOffset(value: any): boolean {
  return isFiniteVector3Array(value)
    && value.slice(0, 3).every(part => Number.isInteger(Number(part))
      && Number(part) >= 0 && Number(part) <= 4);
}

function scriptEditResult(field: 'placed' | 'removed', count: number, reason: string) {
  return Object.freeze({ ok: count > 0, [field]: count, reason });
}

function cloneEntityStreamData(value: any, fallback: any = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function getWorldVoxelCell(location: any) {
  if (!isFiniteVector3Array(location)) return null;
  const cell = {
    x: Math.floor(Number(location[0])),
    y: Math.floor(Number(location[1])),
    z: Math.floor(Number(location[2]))
  };
  return cell.y >= 0 && cell.y < CHUNK_SIZE_Y ? cell : null;
}

export class ContraptionManager {
  declare scene: any;
  declare world: any;
  declare sound: any;
  declare particles: any;
  declare contraptions: any[];
  /** Serialized, non-running entities grouped by their wrapped chunk id. */
  declare dormantContraptions: Map<string, Map<string, any>>;
  declare lastEntityChunkWindow: Set<string> | null;
  declare nextId: number;
  declare selectionCornerA: any;
  declare selectionCornerB: any;
  declare gluePoints: any[];
  declare connectedSelection: any;
  declare microSelection: any;
  declare childSelection: any;
  declare activeDrivable: any;
  declare activeProgrammingContraption: any;
  declare physics: any;
  declare runtimeContextProvider: any;
  declare scriptWorldApi: any;
  declare scriptSelectionApi: any;
  declare entitySelection: any;
  declare selectionHost: any;
  declare worldId: string;
  declare lastEntitySaveTime: number;
  declare persistentStorage: SpaceStorage | null;
  declare entityPersistenceMode: 'browser' | 'remote';
  declare remoteEntityPersistence: any;

  constructor(scene, world, soundManager, particleSystem, persistentStorage: SpaceStorage | null = null) {
    this.scene = scene;
    this.world = world;
    this.sound = soundManager;
    this.particles = particleSystem;

    this.contraptions = [];
    this.dormantContraptions = new Map();
    this.lastEntityChunkWindow = null;
    this.nextId = 1;
    this.worldId = 'default';
    this.lastEntitySaveTime = 0;
    this.persistentStorage = persistentStorage;
    this.entityPersistenceMode = 'browser';
    this.remoteEntityPersistence = null;

    // Selection State
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.gluePoints = []; // World Super Glue box mode: three points.
    this.connectedSelection = null; // World single mode: explicit cells, or null in box mode.
    this.microSelection = null; // World micro single mode: explicit 0.2 m cells, or null in standard mode.
    this.childSelection = null; // { contraption, parentId, mode, points, cells }
    this.entitySelection = null; // Shared entity subtree/block selection used by mouse and scripts.
    this.selectionHost = null; // Player-side selector state invalidated by shared runtime actions.

    // Active controlled or driven contraption
    this.activeDrivable = null;
    this.activeProgrammingContraption = null;

    // Physics Engine for Contraptions
    this.physics = null;
    this.runtimeContextProvider = null;

    // World capability exposed to entity programs. V2 separates standard and
    // micro voxels so one namespace never implicitly overwrites the other.
    const worldVoxels = Object.freeze({
      get: location => {
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'get-standard',
          cell: location,
          actor: { source: 'script' }
        });
        return Object.freeze(result);
      },
      set: (location, options = null) => {
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'place-standard',
          cell: location,
          options,
          actor: { source: 'script' }
        });
        return scriptEditResult('placed', result.placed || 0, result.reason);
      },
      clear: location => {
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'remove-standard',
          cell: location,
          actor: { source: 'script' }
        });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      paint: (location, options = null) => {
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'paint-standard',
          cell: location,
          options,
          actor: { source: 'script' }
        });
        return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
      },
      clearCell: location => {
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'clear-cell',
          cell: location,
          actor: { source: 'script' }
        });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      subdivide: (location, clearOffset = null) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || (clearOffset !== null && !isMicroOffset(clearOffset))) {
          return Object.freeze({ ok: false, subdivided: 0, removed: 0, reason: 'invalid_position' });
        }
        const micro = clearOffset === null ? null : [
          cell.x * 5 + Number(clearOffset[0]),
          cell.y * 5 + Number(clearOffset[1]),
          cell.z * 5 + Number(clearOffset[2])
        ];
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'subdivide-standard',
          cell,
          micro,
          actor: { source: 'script' }
        });
        return Object.freeze({
          ok: result.ok,
          subdivided: result.subdivided || 0,
          removed: result.removed || 0,
          reason: result.reason
        });
      }
    });
    const worldMicroVoxels = Object.freeze({
      get: (location, microOffset) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return Object.freeze({ block: BlockTypes.AIR, color: 0x000000 });
        }
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'get-micro',
          micro: [
            cell.x * 5 + Number(microOffset[0]),
            cell.y * 5 + Number(microOffset[1]),
            cell.z * 5 + Number(microOffset[2])
          ],
          actor: { source: 'script' }
        });
        return Object.freeze(result);
      },
      set: (location, microOffset, options = null) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return scriptEditResult('placed', 0, 'invalid_position');
        }
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'place-micro',
          micro: [
            cell.x * 5 + Number(microOffset[0]),
            cell.y * 5 + Number(microOffset[1]),
            cell.z * 5 + Number(microOffset[2])
          ],
          options,
          actor: { source: 'script' }
        });
        return scriptEditResult('placed', result.placed || 0, result.reason);
      },
      clear: (location, microOffset) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return scriptEditResult('removed', 0, 'invalid_position');
        }
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'remove-micro',
          micro: [
            cell.x * 5 + Number(microOffset[0]),
            cell.y * 5 + Number(microOffset[1]),
            cell.z * 5 + Number(microOffset[2])
          ],
          actor: { source: 'script' }
        });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      paint: (location, microOffset, options = null) => {
        const cell = getWorldVoxelCell(location);
        if (!cell || !isMicroOffset(microOffset)) {
          return Object.freeze({ ok: false, painted: 0, reason: 'invalid_position' });
        }
        const result = executeBasicAction({ manager: this, world: this.world }, {
          domain: ActionDomain.WORLD,
          action: 'paint-micro',
          micro: [
            cell.x * 5 + Number(microOffset[0]),
            cell.y * 5 + Number(microOffset[1]),
            cell.z * 5 + Number(microOffset[2])
          ],
          options,
          actor: { source: 'script' }
        });
        return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
      }
    });

    // Backward-compatible callable nearby query plus explicit random-id/chunk methods.
    const worldEntities = ((origin, radius = 16) => this.getNearbyEntityDescriptors(origin, radius)) as any;
    worldEntities.get = (entityId, chunkId = null) => this.getEntityDescriptorById(entityId, chunkId);
    worldEntities.list = chunkId => this.getEntityDescriptorsInChunk(chunkId);
    worldEntities.inChunk = worldEntities.list;
    Object.freeze(worldEntities);

    this.scriptWorldApi = Object.freeze({
      apiVersion: 2,
      voxels: worldVoxels,
      microVoxels: worldMicroVoxels,
      entities: worldEntities,
      raycast: (origin, direction, maxDistanceOrOptions: any = 24) => {
        if (!Array.isArray(origin) || !Array.isArray(direction)) return null;
        const options = maxDistanceOrOptions && typeof maxDistanceOrOptions === 'object'
          ? maxDistanceOrOptions
          : null;
        const maxDistance = options ? options.maxDistance : maxDistanceOrOptions;
        const include = options?.include === 'all' || options?.include === 'entities'
          ? options.include
          : 'world';
        const voxelKinds = Array.isArray(options?.voxelKinds)
          ? options.voxelKinds.filter(kind => kind === 'standard' || kind === 'micro')
          : ['standard'];
        const space = options?.space === 'bent' ? 'bent' : 'world';
        const query = this.performBasicAction({
          domain: ActionDomain.QUERY,
          action: 'raycast',
          origin,
          direction,
          maxDistance,
          space,
          include,
          voxelKinds: voxelKinds.length > 0 ? voxelKinds : ['standard'],
          actor: { source: 'script' }
        });
        if (!query?.hit) return null;
        if (query.kind === 'entity') {
          const hit = query.entityHit;
          const point = hit?.point;
          const normal = hit?.worldNormal || hit?.normal;
          return Object.freeze({
            kind: 'entity',
            voxelKind: hit?.kind || null,
            entityId: hit?.contraption?.publicId ?? null,
            runtimeId: hit?.contraption?.id ?? null,
            nodeId: hit?.entityId ?? hit?.entityNode?.id ?? hit?.contraption?.rootComponentId ?? null,
            block: hit?.block?.block ?? BlockTypes.COLOR_BLOCK,
            color: Number(hit?.color) || 0,
            normal: Object.freeze([
              Number(normal?.x) || 0,
              Number(normal?.y) || 0,
              Number(normal?.z) || 0
            ]),
            position: Object.freeze([
              Number(point?.x) || 0,
              Number(point?.y) || 0,
              Number(point?.z) || 0
            ]),
            distance: Number(hit?.distance) || 0
          });
        }
        const hit = query.worldHit;
        if (!hit?.hit) return null;
        return Object.freeze({
          kind: 'world',
          voxelKind: hit.kind || 'standard',
          entityId: null,
          runtimeId: null,
          nodeId: null,
          block: hit.block ?? BlockTypes.COLOR_BLOCK,
          color: Number(hit.color) || 0,
          normal: Object.freeze([hit.normal.x, hit.normal.y, hit.normal.z]),
          position: Object.freeze([hit.hitPos.x, hit.hitPos.y, hit.hitPos.z]),
          distance: hit.distance
        });
      }
    });

    const runSelection = (action, extra: any = {}) => this.performBasicAction({
      domain: ActionDomain.SELECTION,
      action,
      actor: { source: 'script' },
      ...extra
    });
    this.scriptSelectionApi = Object.freeze({
      get: () => Object.freeze(runSelection('get')),
      clear: () => {
        const result = runSelection('clear');
        return Object.freeze({ ok: result.ok, cleared: result.cleared || 0, reason: result.reason });
      },
      cornerA: (point, options: any = {}) => {
        const result = runSelection('corner-a', { point, micro: options?.micro === true });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, reason: result.reason });
      },
      cornerB: (point, options: any = {}) => {
        const result = runSelection('corner-b', { point, micro: options?.micro === true });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, clamped: !!result.clamped, reason: result.reason });
      },
      box: (cornerA, cornerB, options: any = {}) => {
        const result = runSelection('box', { cornerA, cornerB, micro: options?.micro === true });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, clamped: !!result.clamped, reason: result.reason });
      },
      cells: cells => {
        const result = runSelection('cells', { cells });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, reason: result.reason });
      },
      toggle: (point, options: any = {}) => {
        const result = runSelection('toggle-cell', { point, micro: options?.micro === true });
        return Object.freeze({
          ok: result.ok,
          selected: result.selection?.count || 0,
          reason: result.reason
        });
      },
      entity: (entityId, nodeId = null) => {
        const result = runSelection('entity-subtree', { entityId, nodeId });
        return Object.freeze({ ok: result.ok, selected: result.selected || 0, reason: result.reason });
      },
      entityBox: (entityId, nodeId, cornerA, cornerB, space = 'node-local', options: any = {}) => {
        const result = runSelection('entity-box', {
          entityId,
          nodeId,
          a: cornerA,
          b: cornerB,
          space,
          micro: options?.micro === true
        });
        return Object.freeze({
          ok: result.ok,
          selected: result.selected || 0,
          components: Object.freeze([...(result.components || [])]),
          reason: result.reason
        });
      },
      delete: () => {
        const result = runSelection('delete');
        return Object.freeze({
          ok: result.ok,
          removed: result.removed || 0,
          standard: result.standard || 0,
          micro: result.micro || 0,
          entities: result.entities || 0,
          components: result.components || 0,
          entityId: result.entityId ?? null,
          nodeId: result.nodeId ?? null,
          reason: result.reason
        });
      },
      assemble: (mode = ContraptionMode.PROGRAMMABLE, options = {}) => {
        const result = runSelection('assemble', { mode, options });
        return Object.freeze({
          ok: result.ok,
          assembled: result.assembled || 0,
          entityId: result.entityId ?? null,
          runtimeId: result.runtimeId ?? null,
          reason: result.reason
        });
      },
      createChild: (id = null) => {
        const result = runSelection('create-child', { id });
        return Object.freeze({ ok: result.ok, childId: result.childId ?? null, reason: result.reason });
      }
    });
  }

  normalizeChunkId(value) {
    let cx;
    let cz;
    if (typeof value === 'string') {
      const match = value.trim().match(/^(-?\d+)\s*,\s*(-?\d+)$/);
      if (!match) return null;
      cx = Number(match[1]);
      cz = Number(match[2]);
    } else if (Array.isArray(value) && value.length >= 2) {
      cx = Number(value[0]);
      cz = Number(value[1]);
    } else if (value && typeof value === 'object') {
      if (value.id !== undefined && (value.cx === undefined || value.cz === undefined)) {
        return this.normalizeChunkId(value.id);
      }
      cx = Number(value.cx);
      cz = Number(value.cz);
    } else {
      return null;
    }
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) return null;
    const wrappedCx = wrapChunkX(cx);
    const wrappedCz = wrapChunkZ(cz);
    return Object.freeze({ id: `${wrappedCx},${wrappedCz}`, cx: wrappedCx, cz: wrappedCz });
  }

  getContraptionChunk(contraption) {
    if (!contraption?.position) return null;
    const worldCoords = this.world?.worldToChunkCoords?.(contraption.position.x, contraption.position.z);
    return this.normalizeChunkId(worldCoords
      ? [worldCoords.cx, worldCoords.cz]
      : [
          Math.floor(contraption.position.x / CHUNK_SIZE_X),
          Math.floor(contraption.position.z / CHUNK_SIZE_Z)
        ]);
  }

  hasEntityStreamingWindow() {
    return this.world?.activeChunkKeys instanceof Set && this.world.activeChunkKeys.size > 0;
  }

  isEntityChunkLoaded(chunkId) {
    if (!this.hasEntityStreamingWindow()) return true;
    const normalized = this.normalizeChunkId(chunkId);
    return !!normalized && this.world.activeChunkKeys.has(normalized.id);
  }

  getDormantContraptionCount() {
    let count = 0;
    for (const records of this.dormantContraptions.values()) count += records.size;
    return count;
  }

  hasDormantPublicId(publicId) {
    for (const records of this.dormantContraptions.values()) {
      if (records.has(String(publicId))) return true;
    }
    return false;
  }

  findActiveContraptionByPublicId(publicId) {
    const id = String(publicId || '');
    return this.contraptions.find(contraption => String(contraption.publicId) === id) || null;
  }

  updateDormantServerEntity(publicId, metadata) {
    const id = String(publicId || '');
    for (const [chunkId, records] of this.dormantContraptions) {
      const record = records.get(id);
      if (!record) continue;
      const contentChanged = record.serverDefinitionDigest !== metadata.serverDefinitionDigest
        || record.serverSnapshotDigest !== metadata.serverSnapshotDigest;
      if (contentChanged) {
        records.delete(id);
        if (records.size === 0) this.dormantContraptions.delete(chunkId);
        return false;
      }
      const playbackChanged = Number(record.serverRevision) !== Number(metadata.serverRevision)
        || record.serverExecutesLocally !== metadata.serverExecutesLocally;
      Object.assign(record, metadata);
      if (playbackChanged) record.serverPlaybackRevision = 0;
      return true;
    }
    return false;
  }

  captureContraptionForStreaming(contraption, chunk) {
    const states = contraption.getSerializableComponentStates?.()
      || Object.fromEntries([...(contraption.componentVariables || [])]);
    const nodes = [...(contraption.entityNodes?.values?.() || [])].map(node => ({
      id: node.id,
      localPosition: node.localPosition?.toArray?.() || [0, 0, 0],
      localRotation: node.localQuaternion?.toArray?.() || [0, 0, 0, 1],
      localAngularVelocity: node.localAngularVelocity?.toArray?.() || [0, 0, 0]
    }));
    const bodies = (contraption.getRigidBodies?.() || []).map(body => ({
      id: body.id,
      type: body.type,
      position: body.position?.toArray?.() || [0, 0, 0],
      quaternion: body.quaternion?.toArray?.() || [0, 0, 0, 1],
      velocity: body.velocity?.toArray?.() || [0, 0, 0],
      angularVelocity: body.angularVelocity?.toArray?.() || [0, 0, 0],
      mass: body.mass,
      inverseInertia: body.inverseInertia,
      restitution: body.restitution,
      friction: body.friction,
      useGravity: contraption.getNodeGravityEnabled?.(body.id) ?? true,
      collisionEnabled: contraption.getNodeCollisionEnabled?.(body.id) ?? true,
      linearDamping: body.linearDamping,
      angularDamping: body.angularDamping,
      centerOfMassLocal: body.centerOfMassLocal?.toArray?.() || [0, 0, 0],
      previousKinematicPosition: body.previousKinematicPosition?.toArray?.() || [0, 0, 0],
      previousKinematicQuaternion: body.previousKinematicQuaternion?.toArray?.() || [0, 0, 0, 1],
      isOnGround: !!body.isOnGround
    }));
    const centerOffset = (contraption.localCenter || new THREE.Vector3())
      .clone()
      .applyQuaternion(contraption.quaternion);
    const constructorOrigin = contraption.position.clone().sub(centerOffset);
    return {
      id: contraption.id,
      publicId: contraption.publicId,
      chunkId: chunk.id,
      slot: contraption.serializeSubtree(contraption.rootComponentId),
      constructorOrigin: constructorOrigin.toArray(),
      position: contraption.position.toArray(),
      quaternion: contraption.quaternion.toArray(),
      velocity: contraption.velocity.toArray(),
      angularVelocity: contraption.angularVelocity.toArray(),
      // localCenter is the root's original coordinate anchor. It intentionally
      // stays fixed while live block edits change the bounds, so it must be
      // persisted separately from the final voxel layout.
      localCenter: contraption.localCenter?.toArray?.() || null,
      nodes,
      bodies,
      states,
      scriptStatus: contraption.scriptStatus,
      physicsSimulationEnabled: contraption.isPhysicsSimulationEnabled?.() !== false,
      scriptError: contraption.scriptError,
      nodeScriptErrors: [...contraption.nodeScriptErrors.entries()],
      scriptRuntime: contraption.scriptRuntime,
      tickCount: contraption.tickCount,
      totalRuntime: contraption.totalRuntime,
      lastExecutionTimeMs: contraption.lastExecutionTimeMs,
      scriptLogs: contraption.scriptLogs.slice(-100),
      rootPivotOverride: contraption.rootPivotOverride?.toArray?.() || null,
      useGravity: contraption.useGravity,
      isOnGround: contraption.isOnGround,
      groundDistance: contraption.groundDistance,
      behaviorPrompt: contraption.behaviorPrompt,
      agentInterpretation: contraption.agentInterpretation,
      serverManaged: contraption.serverManaged === true,
      serverExecutionMode: contraption.serverExecutionMode || 'browser',
      serverHostingEnabled: contraption.serverHostingEnabled === true,
      serverOwnerUserId: contraption.serverOwnerUserId || null,
      serverCanControl: contraption.serverCanControl === true,
      serverCanEdit: contraption.serverCanEdit === true,
      serverExecutesLocally: contraption.serverExecutesLocally === true,
      serverRevision: Number(contraption.serverRevision) || 0,
      serverPlaybackRevision: Number(contraption.serverPlaybackRevision) || 0,
      serverDesiredRunState: contraption.serverDesiredRunState || null,
      serverDefinitionDigest: contraption.serverDefinitionDigest || null,
      serverSnapshotDigest: contraption.serverSnapshotDigest || null,
      bearingAngle: contraption.bearingAngle,
      pistonProgress: contraption.pistonProgress,
      pistonDirection: contraption.pistonDirection,
      pistonBasePos: contraption.pistonBasePos?.toArray?.() || null
    };
  }

  storeDormantContraption(record) {
    if (!record?.chunkId || !record?.publicId) return;
    let records = this.dormantContraptions.get(record.chunkId);
    if (!records) {
      records = new Map();
      this.dormantContraptions.set(record.chunkId, records);
    }
    records.set(String(record.publicId), record);
  }

  deleteDormantContraption(publicId) {
    const id = String(publicId || '');
    for (const [chunkId, records] of this.dormantContraptions) {
      if (!records.delete(id)) continue;
      if (records.size === 0) this.dormantContraptions.delete(chunkId);
      return true;
    }
    return false;
  }

  unloadContraption(contraption) {
    const chunk = this.getContraptionChunk(contraption);
    if (!chunk) return false;
    const record = this.captureContraptionForStreaming(contraption, chunk);
    if (!record) return false;
    this.storeDormantContraption(record);
    this.removeContraption(contraption, { preserveDormant: true });
    return true;
  }

  restoreContraptionStreamingState(contraption, record) {
    contraption.position.fromArray(record.position || [0, 0, 0]);
    contraption.quaternion.fromArray(record.quaternion || [0, 0, 0, 1]).normalize();
    contraption.velocity.fromArray(record.velocity || [0, 0, 0]);
    contraption.angularVelocity.fromArray(record.angularVelocity || [0, 0, 0]);
    contraption.isOnGround = !!record.isOnGround;
    contraption.groundDistance = Number(record.groundDistance) || 0;
    contraption.rootPivotOverride = Array.isArray(record.rootPivotOverride)
      ? new THREE.Vector3().fromArray(record.rootPivotOverride)
      : null;

    for (const saved of record.nodes || []) {
      const node = contraption.entityNodes.get(String(saved.id));
      if (!node) continue;
      node.localPosition.fromArray(saved.localPosition || [0, 0, 0]);
      node.localQuaternion.fromArray(saved.localRotation || [0, 0, 0, 1]).normalize();
      node.localAngularVelocity.fromArray(saved.localAngularVelocity || [0, 0, 0]);
      node.group.position.copy(node.localPosition);
      node.group.quaternion.copy(node.localQuaternion);
    }

    for (const saved of record.bodies || []) {
      const body = contraption.getRigidBody(saved.id);
      if (!body) continue;
      const savedUseGravity = typeof saved.useGravity === 'boolean'
        ? saved.useGravity
        : (body.id === contraption.rootComponentId && typeof record.useGravity === 'boolean'
            ? record.useGravity
            : undefined);
      const restoresRuntimeMass = Number.isFinite(Number(saved.mass)) && Number(saved.mass) !== body.mass;
      const restoresRuntimeOverride = saved.type !== body.type
        || restoresRuntimeMass
        || (Number.isFinite(Number(saved.restitution)) && Number(saved.restitution) !== body.restitution)
        || (Number.isFinite(Number(saved.friction)) && Number(saved.friction) !== body.friction)
        || (typeof savedUseGravity === 'boolean'
          && savedUseGravity !== contraption.getNodeGravityEnabled?.(body.id))
        || (typeof saved.collisionEnabled === 'boolean'
          && saved.collisionEnabled !== contraption.getNodeCollisionEnabled?.(body.id));
      if (restoresRuntimeOverride) contraption.captureRuntimeBodyConfigDefault?.(body.id);
      if (saved.type === BodyType.DYNAMIC || saved.type === BodyType.KINEMATIC) {
        body.type = saved.type;
        const node = contraption.entityNodes.get(String(saved.id));
        if (node) node.bodyType = saved.type;
      }
      if (Number.isFinite(Number(saved.mass)) && Number(saved.mass) > 0) body.mass = Number(saved.mass);
      if (Number.isFinite(Number(saved.inverseInertia)) && Number(saved.inverseInertia) >= 0) {
        body.inverseInertia = Number(saved.inverseInertia);
      }
      if (Number.isFinite(Number(saved.restitution))) {
        body.restitution = Math.max(0, Math.min(1, Number(saved.restitution)));
      }
      if (Number.isFinite(Number(saved.friction))) {
        body.friction = Math.max(0, Math.min(1, Number(saved.friction)));
      }
      if (Number.isFinite(Number(saved.linearDamping))) {
        body.linearDamping = Math.max(0, Math.min(1, Number(saved.linearDamping)));
      }
      if (Number.isFinite(Number(saved.angularDamping))) {
        body.angularDamping = Math.max(0, Math.min(1, Number(saved.angularDamping)));
      }
      if (isFiniteVector3Array(saved.centerOfMassLocal)) {
        body.centerOfMassLocal.fromArray(saved.centerOfMassLocal);
      }
      body.position.fromArray(saved.position || [0, 0, 0]);
      body.quaternion.fromArray(saved.quaternion || [0, 0, 0, 1]).normalize();
      body.velocity.fromArray(saved.velocity || [0, 0, 0]);
      body.angularVelocity.fromArray(saved.angularVelocity || [0, 0, 0]);
      body.previousKinematicPosition.fromArray(saved.previousKinematicPosition || saved.position || [0, 0, 0]);
      body.previousKinematicQuaternion.fromArray(saved.previousKinematicQuaternion || saved.quaternion || [0, 0, 0, 1]).normalize();
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
      body.isOnGround = !!saved.isOnGround;

      if (body.id === contraption.rootComponentId) {
        contraption.bodyType = body.type;
        if (restoresRuntimeMass) contraption.massOverride = body.mass;
        contraption.mass = body.mass;
        contraption.restitution = body.restitution;
        contraption.friction = body.friction;
        contraption.linearDamping = body.linearDamping;
        contraption.angularDamping = body.angularDamping;
      } else {
        const definition = contraption.childDefinitions.get(body.id);
        if (definition) {
          definition.bodyType = body.type;
          if (restoresRuntimeMass) definition.mass = body.mass;
          definition.restitution = body.restitution;
          definition.friction = body.friction;
        }
      }
      if (typeof savedUseGravity === 'boolean'
        && savedUseGravity !== contraption.getNodeGravityEnabled?.(body.id)) {
        contraption.setNodeGravityEnabled?.(body.id, savedUseGravity, { runtimeOnly: true });
      }
      if (typeof saved.collisionEnabled === 'boolean'
        && saved.collisionEnabled !== contraption.getNodeCollisionEnabled?.(body.id)) {
        contraption.setNodeCollisionEnabled?.(body.id, saved.collisionEnabled, { runtimeOnly: true });
      }
    }
    contraption.syncAllBodyTransforms?.();

    for (const nodeId of contraption.entityNodes.keys()) {
      const target = contraption.getComponentState(nodeId);
      for (const key of Object.keys(target)) delete target[key];
      const saved = cloneEntityStreamData(record.states?.[nodeId], {});
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.assign(target, saved);
    }
    contraption.scriptRuntimeClient.reset(contraption.getSerializableComponentStates());
    contraption.scriptStatus = record.scriptStatus || 'stopped';
    contraption.setPhysicsSimulationEnabled?.(
      record.physicsSimulationEnabled !== false,
      { resetHistory: false }
    );
    contraption.scriptError = record.scriptError || null;
    contraption.nodeScriptErrors = new Map(record.nodeScriptErrors || []);
    contraption.scriptRuntime = Number(record.scriptRuntime) || 0;
    contraption.tickCount = Number(record.tickCount) || 0;
    contraption.totalRuntime = Number(record.totalRuntime) || 0;
    contraption.lastExecutionTimeMs = Number(record.lastExecutionTimeMs) || 0;
    contraption.scriptLogs = Array.isArray(record.scriptLogs) ? [...record.scriptLogs] : [];
    contraption.bearingAngle = Number(record.bearingAngle) || 0;
    contraption.pistonProgress = Number(record.pistonProgress) || 0;
    contraption.pistonDirection = Number(record.pistonDirection) || 1;
    if (Array.isArray(record.pistonBasePos)) contraption.pistonBasePos.fromArray(record.pistonBasePos);
    contraption.updateTransform();
    // spaceAPI Stop/configuration saves placement while discarding runtime state.
    if (record.resetRuntime === true) contraption.stopAllNodeScripts();
  }

  restoreDormantContraption(record) {
    const origin = new THREE.Vector3().fromArray(record.constructorOrigin || [0, 0, 0]);
    return this.buildFromSlot(record.slot, origin, record);
  }

  syncContraptionsToLoadedChunks() {
    if (!this.hasEntityStreamingWindow()) {
      this.lastEntityChunkWindow = null;
      return;
    }

    const activeWindow = this.world.activeChunkKeys;
    if (activeWindow !== this.lastEntityChunkWindow) {
      this.lastEntityChunkWindow = activeWindow;
      for (const chunkId of activeWindow) {
        const records = this.dormantContraptions.get(chunkId);
        if (!records) continue;
        this.dormantContraptions.delete(chunkId);
        for (const record of records.values()) {
          try {
            const restored = this.restoreDormantContraption(record);
            if (!restored) this.storeDormantContraption(record);
          } catch (error) {
            this.storeDormantContraption(record);
            console.warn('Entity chunk restore failed:', error);
          }
        }
      }
    }

    for (let index = this.contraptions.length - 1; index >= 0; index--) {
      const contraption = this.contraptions[index];
      const chunk = this.getContraptionChunk(contraption);
      if (chunk && !activeWindow.has(chunk.id)) this.unloadContraption(contraption);
    }
  }

  describeContraption(contraption, distance = null) {
    if (!contraption) return null;
    const chunk = this.getContraptionChunk(contraption);
    const descriptor: any = {
      id: contraption.publicId,
      runtimeId: contraption.id,
      chunkId: chunk?.id || null,
      position: Object.freeze([
        contraption.position.x,
        contraption.position.y,
        contraption.position.z
      ]),
      rotation: Object.freeze(contraption.quaternion.toArray()),
      velocity: Object.freeze(contraption.velocity.toArray()),
      angularVelocity: Object.freeze(contraption.angularVelocity.toArray()),
      mass: contraption.mass,
      bounds: Object.freeze({
        min: Object.freeze(contraption.minLocal.toArray()),
        max: Object.freeze(contraption.maxLocal.toArray()),
        size: Object.freeze(contraption.size.toArray()),
        center: Object.freeze(contraption.localCenter.toArray())
      }),
      boundingRadius: contraption.boundingRadius,
      bodyType: contraption.bodyType,
      collisionEnabled: contraption.collisionEnabled !== false,
      physicsEnabled: contraption.isPhysicsSimulationEnabled?.() !== false,
      isOnGround: contraption.isOnGround === true,
      groundDistance: contraption.groundDistance,
      scriptStatus: contraption.scriptStatus,
      componentCount: contraption.entityNodes?.size || 0
    };
    if (distance !== null) descriptor.distance = distance;
    return Object.freeze(descriptor);
  }

  getNearbyEntityDescriptors(origin, radius = 16) {
    if (!Array.isArray(origin) || origin.length < 3) return Object.freeze([]);
    const ox = Number(origin[0]) || 0;
    const oy = Number(origin[1]) || 0;
    const oz = Number(origin[2]) || 0;
    const r = Math.max(0, Number(radius) || 0);
    const result = [];
    for (const contraption of this.contraptions) {
      const dx = ((contraption.position.x - ox) % TORUS_SIZE_X
        + TORUS_SIZE_X + TORUS_SIZE_X / 2) % TORUS_SIZE_X - TORUS_SIZE_X / 2;
      const dy = contraption.position.y - oy;
      const dz = ((contraption.position.z - oz) % TORUS_SIZE_Z
        + TORUS_SIZE_Z + TORUS_SIZE_Z / 2) % TORUS_SIZE_Z - TORUS_SIZE_Z / 2;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= r) result.push(this.describeContraption(contraption, distance));
    }
    result.sort((a, b) => a.distance - b.distance);
    return Object.freeze(result);
  }

  getEntityDescriptorById(entityId, chunkId = null) {
    if (entityId === undefined || entityId === null) return null;
    const contraption = this.contraptions.find(item => (
      String(item.publicId) === String(entityId) || String(item.id) === String(entityId)
    ));
    if (!contraption) return null;
    if (chunkId !== null && chunkId !== undefined) {
      const expected = this.normalizeChunkId(chunkId);
      if (!expected || this.getContraptionChunk(contraption)?.id !== expected.id) return null;
    }
    return this.describeContraption(contraption);
  }

  getEntityDescriptorsInChunk(chunkId) {
    const target = this.normalizeChunkId(chunkId);
    if (!target) return Object.freeze([]);
    const result = this.contraptions
      .filter(contraption => this.getContraptionChunk(contraption)?.id === target.id)
      .map(contraption => this.describeContraption(contraption))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return Object.freeze(result);
  }

  /** Dispatch a canonical engine action from UI, mouse input, scripts or systems. */
  performBasicAction(command) {
    return executeBasicAction({ manager: this, world: this.world, selectionHost: this.selectionHost }, command);
  }

  /** Register an entity and bind its self.* API to this same command context. */
  registerContraption(contraption) {
    if (!contraption) return null;
    const runtimeId = Number(contraption.id);
    if (Number.isFinite(runtimeId)) this.nextId = Math.max(this.nextId, runtimeId + 1);
    while (!contraption.publicId || this.contraptions.some(item => (
      item !== contraption && item.publicId === contraption.publicId
    )) || this.hasDormantPublicId(contraption.publicId)) {
      contraption.publicId = createEntityPublicId();
    }
    contraption.setActionContext?.({ manager: this, world: this.world });
    if (!this.contraptions.includes(contraption)) this.contraptions.push(contraption);
    return contraption;
  }

  setPhysics(physics) {
    this.physics = physics;
  }

  setRuntimeContextProvider(provider) {
    this.runtimeContextProvider = typeof provider === 'function' ? provider : null;
  }

  setWorldId(worldId: string) {
    this.worldId = String(worldId || 'default');
  }

  /** Select browser persistence for offline worlds or backend persistence online. */
  setEntityPersistenceMode(mode: 'browser' | 'remote', adapter: any = null) {
    this.entityPersistenceMode = mode === 'remote' ? 'remote' : 'browser';
    this.remoteEntityPersistence = this.entityPersistenceMode === 'remote' ? adapter : null;
    if (this.entityPersistenceMode === 'remote') this.purgeBrowserEntityStorage();
  }

  setRemoteEntityPersistence(adapter: any) {
    this.entityPersistenceMode = 'remote';
    this.remoteEntityPersistence = adapter || null;
    this.purgeBrowserEntityStorage();
  }

  purgeBrowserEntityStorage(storage = this.entityStorage()): boolean {
    if (!storage) return false;
    try {
      storage.removeItem(worldEntitiesStorageKey(this.worldId));
      return true;
    } catch (err) {
      console.warn('Could not remove legacy browser entity storage:', err);
      return false;
    }
  }

  entityStorage(): SpaceStorage | null {
    if (this.persistentStorage) return this.persistentStorage;
    try {
      return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
    } catch {
      return null;
    }
  }

  /**
   * Persist all active and dormant entities to browser storage.
   */
  saveEntitiesToStorage(storage = this.entityStorage()): boolean {
    if (this.entityPersistenceMode === 'remote') {
      const seenPublicIds = new Set<string>();
      const queue = (record: any) => {
        if (!record?.publicId || seenPublicIds.has(String(record.publicId))) return;
        if (record.serverManaged === true && record.serverCanEdit !== true) return;
        seenPublicIds.add(String(record.publicId));
        this.remoteEntityPersistence?.save?.(record, { definitionChanged: true });
      };
      for (const contraption of this.contraptions) {
        if (!contraption) continue;
        const chunk = this.getContraptionChunk(contraption) || { id: '0,0', cx: 0, cz: 0 };
        queue(this.captureContraptionForStreaming(contraption, chunk));
      }
      for (const records of this.dormantContraptions.values()) {
        for (const record of records.values()) queue(record);
      }
      return true;
    }
    if (!storage) return false;
    try {
      const entityRecords: any[] = [];
      const seenPublicIds = new Set<string>();

      // 1. Active contraptions
      for (const c of this.contraptions) {
        if (!c || !c.publicId || c.serverManaged === true) continue;
        const chunk = this.getContraptionChunk(c) || { id: '0,0', cx: 0, cz: 0 };
        const record = this.captureContraptionForStreaming(c, chunk);
        if (record) {
          entityRecords.push(record);
          seenPublicIds.add(String(record.publicId));
        }
      }

      // 2. Dormant contraptions
      for (const records of this.dormantContraptions.values()) {
        for (const record of records.values()) {
          if (record?.publicId && record.serverManaged !== true && !seenPublicIds.has(String(record.publicId))) {
            entityRecords.push(record);
            seenPublicIds.add(String(record.publicId));
          }
        }
      }

      const payload = {
        type: 'space-entities',
        version: ENTITY_STORAGE_VERSION,
        worldId: this.worldId,
        entities: entityRecords
      };

      storage.setItem(worldEntitiesStorageKey(this.worldId), JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn('Could not save entities to storage:', err);
      return false;
    }
  }

  /**
   * Load and restore all saved entities from browser storage on world startup.
   */
  loadEntitiesFromStorage(storage = this.entityStorage()): number {
    if (this.entityPersistenceMode !== 'browser') return 0;
    if (!storage) return 0;
    try {
      const raw = storage.getItem(worldEntitiesStorageKey(this.worldId));
      if (!raw) return 0;
      const data = JSON.parse(raw);
      if (data?.type !== 'space-entities' || data?.version !== ENTITY_STORAGE_VERSION || !Array.isArray(data.entities)) {
        return 0;
      }

      while (this.contraptions.length > 0) {
        this.removeContraption(this.contraptions[0], { preserveDormant: true, skipSave: true });
      }
      this.dormantContraptions.clear();

      let loadedCount = 0;
      for (const record of data.entities) {
        if (!record?.slot) continue;
        const origin = new THREE.Vector3().fromArray(record.constructorOrigin || record.position || [0, 0, 0]);
        const contraption = this.buildFromSlot(record.slot, origin, record, false);
        if (contraption) {
          loadedCount++;
          const chunk = this.getContraptionChunk(contraption);
          if (chunk && !this.isEntityChunkLoaded(chunk.id)) {
            this.unloadContraption(contraption);
          }
        }
      }
      return loadedCount;
    } catch (err) {
      console.warn('Could not load entities from storage:', err);
      return 0;
    }
  }

  // =========================================================================
  // 1. SELECTION LOGIC
  // =========================================================================

  setCornerA(pos, opts: any = {}) {
    this.clearChildSelection();
    if (pos) {
      this.selectionCornerA = opts.micro === true
        ? this.microCellFromPoint(pos)
        : { x: wrapX(Math.floor(pos.x)), y: Math.floor(pos.y), z: wrapZ(Math.floor(pos.z)) };
    } else {
      this.selectionCornerA = null;
    }
    this.selectionCornerB = null;
    this.connectedSelection = null;
    this.microSelection = null;
    this.gluePoints = [];
    if (this.sound) this.sound.playWrenchClick();
  }

  /** Convert a world point to the inclusive micro cell (0.2 m grid) under it. */
  microCellFromPoint(pos) {
    return {
      x: wrapMicroX(Math.floor(pos.x * MICRO_DIVISIONS + 1e-6)),
      y: Math.max(0, Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, Math.floor(pos.y * MICRO_DIVISIONS + 1e-6))),
      z: wrapMicroZ(Math.floor(pos.z * MICRO_DIVISIONS + 1e-6)),
      micro: true
    };
  }

  /** Clamp a raw corner against the anchor corner so the box stays within MAX_ENTITY_BOUNDS cells per axis. */
  clampSelectionCorner(raw, anchor) {
    const pos = {
      x: unwrapPeriodicNear(Math.floor(raw.x), anchor.x, TORUS_SIZE_X),
      y: Math.floor(raw.y),
      z: unwrapPeriodicNear(Math.floor(raw.z), anchor.z, TORUS_SIZE_Z)
    };
    let clamped = false;
    for (const axis of ['x', 'y', 'z']) {
      if (pos[axis] - anchor[axis] > MAX_ENTITY_BOUNDS - 1) {
        pos[axis] = anchor[axis] + MAX_ENTITY_BOUNDS - 1;
        clamped = true;
      } else if (anchor[axis] - pos[axis] > MAX_ENTITY_BOUNDS - 1) {
        pos[axis] = anchor[axis] - (MAX_ENTITY_BOUNDS - 1);
        clamped = true;
      }
    }
    return { pos, clamped };
  }

  /** Clamp a raw micro corner against the anchor so the box stays within MAX_ENTITY_BOUNDS standard cells per axis. */
  clampMicroSelectionCorner(raw, anchor) {
    const pos = {
      x: unwrapPeriodicNear(raw.x, anchor.x, TORUS_SIZE_X * MICRO_DIVISIONS),
      y: raw.y,
      z: unwrapPeriodicNear(raw.z, anchor.z, TORUS_SIZE_Z * MICRO_DIVISIONS),
      micro: true
    };
    let clamped = false;
    const limit = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS - 1;
    for (const axis of ['x', 'y', 'z']) {
      if (pos[axis] - anchor[axis] > limit) {
        pos[axis] = anchor[axis] + limit;
        clamped = true;
      } else if (anchor[axis] - pos[axis] > limit) {
        pos[axis] = anchor[axis] - limit;
        clamped = true;
      }
    }
    const clampedY = Math.max(0, Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, pos.y));
    if (clampedY !== pos.y) {
      pos.y = clampedY;
      clamped = true;
    }
    return { pos, clamped };
  }

  /** True when the point AABB would exceed MAX_ENTITY_BOUNDS on any axis. */
  boundsExceedEntityLimit(bounds) {
    if (!bounds) return false;
    return (
      bounds.maxX - bounds.minX + 1 > MAX_ENTITY_BOUNDS
      || bounds.maxY - bounds.minY + 1 > MAX_ENTITY_BOUNDS
      || bounds.maxZ - bounds.minZ + 1 > MAX_ENTITY_BOUNDS
    );
  }

  setCornerB(pos, opts: any = {}) {
    this.clearChildSelection();
    const micro = opts.micro === true || !!this.selectionCornerA?.micro;
    if (micro && pos) {
      // A confirmed micro box materializes into the sparse set of existing
      // micro voxels, so downstream flows (G/T/Del) only touch real blocks.
      const cornerA = this.selectionCornerA?.micro
        ? this.selectionCornerA
        : this.selectionCornerA
          ? { x: this.selectionCornerA.x * MICRO_DIVISIONS, y: this.selectionCornerA.y * MICRO_DIVISIONS, z: this.selectionCornerA.z * MICRO_DIVISIONS, micro: true }
          : this.microCellFromPoint(pos);
      let cornerB = this.microCellFromPoint(pos);
      let clamped = false;
      const result = this.clampMicroSelectionCorner(cornerB, cornerA);
      cornerB = result.pos;
      clamped = result.clamped;
      const minMx = Math.min(cornerA.x, cornerB.x);
      const maxMx = Math.max(cornerA.x, cornerB.x);
      const minMy = Math.min(cornerA.y, cornerB.y);
      const maxMy = Math.max(cornerA.y, cornerB.y);
      const minMz = Math.min(cornerA.z, cornerB.z);
      const maxMz = Math.max(cornerA.z, cornerB.z);
      this.selectionCornerA = null;
      this.selectionCornerB = null;
      this.connectedSelection = null;
      this.microSelection = this.materializeMicroBox(minMx, minMy, minMz, maxMx, maxMy, maxMz);
      this.gluePoints = [];
      if (this.sound) this.sound.playWrenchClick();
      return { clamped, materialized: this.microSelection.length };
    }
    let clamped = false;
    if (pos) {
      const raw = {
        x: wrapX(Math.floor(pos.x)),
        y: Math.floor(pos.y),
        z: wrapZ(Math.floor(pos.z))
      };
      if (this.selectionCornerA) {
        const result = this.clampSelectionCorner(raw, this.selectionCornerA);
        pos = result.pos;
        clamped = result.clamped;
      } else {
        pos = raw;
      }
    }
    this.selectionCornerB = pos;
    this.connectedSelection = null;
    this.microSelection = null;
    this.gluePoints = [];
    if (this.sound) this.sound.playWrenchClick();
    return { clamped };
  }

  /** Collect the existing micro voxels and non-air standard blocks inside an inclusive micro-index box. */
  materializeMicroBox(minMx, minMy, minMz, maxMx, maxMy, maxMz) {
    const found = [];
    const loY = Math.max(0, minMy);
    const hiY = Math.min(CHUNK_SIZE_Y * MICRO_DIVISIONS - 1, maxMy);
    if (loY > hiY) return found;

    const existingMicroKeys = new Set<string>();
    const cells = this.world?.microVoxels?.cells;
    if (cells) {
      for (const key of cells.keys()) {
        const [mx, my, mz] = key.split(',').map(Number);
        const selectionMx = unwrapPeriodicNear(mx, minMx, TORUS_SIZE_X * MICRO_DIVISIONS);
        const selectionMz = unwrapPeriodicNear(mz, minMz, TORUS_SIZE_Z * MICRO_DIVISIONS);
        if (selectionMx < minMx || selectionMx > maxMx || my < loY || my > hiY
          || selectionMz < minMz || selectionMz > maxMz) continue;
        found.push({ x: selectionMx, y: my, z: selectionMz });
        existingMicroKeys.add(`${selectionMx},${my},${selectionMz}`);
      }
    }

    if (this.world?.getBlock) {
      const minWx = Math.floor(minMx / MICRO_DIVISIONS);
      const maxWx = Math.floor(maxMx / MICRO_DIVISIONS);
      const minWy = Math.floor(loY / MICRO_DIVISIONS);
      const maxWy = Math.floor(hiY / MICRO_DIVISIONS);
      const minWz = Math.floor(minMz / MICRO_DIVISIONS);
      const maxWz = Math.floor(maxMz / MICRO_DIVISIONS);

      for (let wx = minWx; wx <= maxWx; wx++) {
        for (let wy = minWy; wy <= maxWy; wy++) {
          for (let wz = minWz; wz <= maxWz; wz++) {
            const block = this.world.getBlock(wx, wy, wz);
            if (block === BlockTypes.AIR) continue;

            const baseMx = wx * MICRO_DIVISIONS;
            const baseMy = wy * MICRO_DIVISIONS;
            const baseMz = wz * MICRO_DIVISIONS;

            const startDx = Math.max(0, minMx - baseMx);
            const endDx = Math.min(MICRO_DIVISIONS - 1, maxMx - baseMx);
            const startDy = Math.max(0, loY - baseMy);
            const endDy = Math.min(MICRO_DIVISIONS - 1, hiY - baseMy);
            const startDz = Math.max(0, minMz - baseMz);
            const endDz = Math.min(MICRO_DIVISIONS - 1, maxMz - baseMz);

            for (let dx = startDx; dx <= endDx; dx++) {
              for (let dy = startDy; dy <= endDy; dy++) {
                for (let dz = startDz; dz <= endDz; dz++) {
                  const mx = baseMx + dx;
                  const my = baseMy + dy;
                  const mz = baseMz + dz;
                  const k = `${mx},${my},${mz}`;
                  if (!existingMicroKeys.has(k)) {
                    found.push({ x: mx, y: my, z: mz });
                  }
                }
              }
            }
          }
        }
      }
    }

    return found;
  }

  setConnectedSelection(blocks) {
    this.clearChildSelection();
    const anchor = blocks?.[0]
      ? { x: wrapX(Math.floor(blocks[0].x)), y: Math.floor(blocks[0].y), z: wrapZ(Math.floor(blocks[0].z)) }
      : null;
    const normalizedBlocks = anchor
      ? blocks.map(block => ({
          x: unwrapPeriodicNear(Math.floor(block.x), anchor.x, TORUS_SIZE_X),
          y: Math.floor(block.y),
          z: unwrapPeriodicNear(Math.floor(block.z), anchor.z, TORUS_SIZE_Z)
        }))
      : blocks;
    if (this.boundsExceedEntityLimit(this.getBoundsFromPoints(normalizedBlocks))) {
      return false;
    }
    this.connectedSelection = normalizedBlocks;
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.microSelection = null;
    this.gluePoints = [];
    if (this.sound) this.sound.playGlueApply();
    return true;
  }

  addGluePoint(pos) {
    if (!pos) return 0;
    this.clearChildSelection();
    // A plain click always returns from single mode to a fresh three-point
    // box. The click itself is point one, so only two more clicks are needed.
    if (this.connectedSelection !== null || this.gluePoints.length >= 3) {
      this.connectedSelection = null;
      this.gluePoints = [];
    }
    const anchor = this.gluePoints[0] || null;
    const pt = {
      x: anchor
        ? unwrapPeriodicNear(Math.floor(pos.x), anchor.x, TORUS_SIZE_X)
        : wrapX(Math.floor(pos.x)),
      y: Math.floor(pos.y),
      z: anchor
        ? unwrapPeriodicNear(Math.floor(pos.z), anchor.z, TORUS_SIZE_Z)
        : wrapZ(Math.floor(pos.z))
    };
    if (this.gluePoints.length > 0) {
      // Keep the completed three-point box within MAX_ENTITY_BOUNDS per axis.
      const bounds = this.getBoundsFromPoints(this.gluePoints);
      for (const axis of ['x', 'y', 'z']) {
        const min = bounds[`min${axis.toUpperCase()}`];
        const max = bounds[`max${axis.toUpperCase()}`];
        if (pt[axis] - min > MAX_ENTITY_BOUNDS - 1) pt[axis] = min + MAX_ENTITY_BOUNDS - 1;
        else if (max - pt[axis] > MAX_ENTITY_BOUNDS - 1) pt[axis] = max - (MAX_ENTITY_BOUNDS - 1);
      }
    }
    this.gluePoints.push(pt);
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.microSelection = null;
    if (this.sound) this.sound.playGlueApply();
    return this.gluePoints.length;
  }

  addSelectionPoint(pos, singleMode = false) {
    if (singleMode) {
      const info = this.toggleWorldGlueCell(pos);
      return info?.count || 0;
    }
    return this.addGluePoint(pos);
  }

  toggleWorldGlueCell(pos) {
    if (!pos) return null;
    this.clearChildSelection();
    const canonicalCell = { x: wrapX(Math.floor(pos.x)), y: Math.floor(pos.y), z: wrapZ(Math.floor(pos.z)) };
    const anchor = this.connectedSelection?.[0] || canonicalCell;
    const cell = {
      x: unwrapPeriodicNear(canonicalCell.x, anchor.x, TORUS_SIZE_X),
      y: canonicalCell.y,
      z: unwrapPeriodicNear(canonicalCell.z, anchor.z, TORUS_SIZE_Z)
    };
    const key = `${canonicalCell.x},${cell.y},${canonicalCell.z}`;

    // Shift always enters single mode. Any unfinished or completed box is
    // intentionally discarded so the two interaction modes never overlap.
    if (this.connectedSelection === null) {
      this.connectedSelection = [];
      this.microSelection = null;
      this.gluePoints = [];
      this.selectionCornerA = null;
      this.selectionCornerB = null;
    }

    const index = this.connectedSelection.findIndex(item => (
      `${wrapX(item.x)},${item.y},${wrapZ(item.z)}` === key
    ));
    let rejected = false;
    if (index >= 0) {
      this.connectedSelection.splice(index, 1);
    } else {
      // Adding must never push the single-cell selection past MAX_ENTITY_BOUNDS
      // on any axis; removals are always allowed.
      const bounds = this.getSelectionBounds();
      if (bounds && (
        Math.max(cell.x, bounds.maxX) - Math.min(cell.x, bounds.minX) + 1 > MAX_ENTITY_BOUNDS
        || Math.max(cell.y, bounds.maxY) - Math.min(cell.y, bounds.minY) + 1 > MAX_ENTITY_BOUNDS
        || Math.max(cell.z, bounds.maxZ) - Math.min(cell.z, bounds.minZ) + 1 > MAX_ENTITY_BOUNDS
      )) {
        rejected = true;
      } else {
        this.connectedSelection.push(cell);
      }
    }
    if (this.sound) this.sound.playGlueApply();
    const info = this.getWorldGlueSelectionInfo();
    if (rejected) info.rejected = true;
    return info;
  }

  /**
   * Toggle one 0.2 m micro cell in the world micro-selection (the Selector
   * tool's Tab-toggled micro mode). Mirrors toggleWorldGlueCell: shift always
   * enters single mode, and any unfinished or completed box is discarded.
   */
  toggleMicroCell(pos) {
    if (!pos) return null;
    this.clearChildSelection();
    const canonicalCell = this.microCellFromPoint(pos);
    const anchor = this.microSelection?.[0] || canonicalCell;
    const cell = {
      x: unwrapPeriodicNear(canonicalCell.x, anchor.x, TORUS_SIZE_X * MICRO_DIVISIONS),
      y: canonicalCell.y,
      z: unwrapPeriodicNear(canonicalCell.z, anchor.z, TORUS_SIZE_Z * MICRO_DIVISIONS)
    };
    const key = `${canonicalCell.x},${cell.y},${canonicalCell.z}`;

    if (this.microSelection === null) {
      this.microSelection = [];
      this.connectedSelection = null;
      this.gluePoints = [];
      this.selectionCornerA = null;
      this.selectionCornerB = null;
    }

    const index = this.microSelection.findIndex(item => (
      `${wrapMicroX(item.x)},${item.y},${wrapMicroZ(item.z)}` === key
    ));
    let rejected = false;
    if (index >= 0) {
      this.microSelection.splice(index, 1);
    } else {
      // Adding must never push the micro selection past MAX_ENTITY_BOUNDS
      // standard cells on any axis; removals are always allowed.
      const bounds = this.getMicroSelectionBounds();
      const limit = MAX_ENTITY_BOUNDS * MICRO_DIVISIONS - 1;
      if (bounds && (
        Math.max(cell.x, bounds.maxX) - Math.min(cell.x, bounds.minX) > limit
        || Math.max(cell.y, bounds.maxY) - Math.min(cell.y, bounds.minY) > limit
        || Math.max(cell.z, bounds.maxZ) - Math.min(cell.z, bounds.minZ) > limit
      )) {
        rejected = true;
      } else {
        this.microSelection.push({ x: cell.x, y: cell.y, z: cell.z });
      }
    }
    if (this.sound) this.sound.playGlueApply();
    const info = this.getWorldGlueSelectionInfo();
    if (rejected) info.rejected = true;
    return info;
  }

  /** Inclusive micro-index bounds of the sparse micro selection, or null. */
  getMicroSelectionBounds() {
    if (this.microSelection === null || this.microSelection.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const c of this.microSelection) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.z < minZ) minZ = c.z;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
      if (c.z > maxZ) maxZ = c.z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  getWorldGlueSelectionInfo(): {
    mode: string;
    granularity: string;
    pointCount: number;
    count: number;
    ready: boolean;
    cells: any;
    rejected?: boolean;
  } {
    const microMode = this.microSelection !== null;
    const singleMode = this.connectedSelection !== null;
    const count = microMode ? this.microSelection.length : singleMode ? this.connectedSelection.length : this.getSelectionBlockCount();
    // Prefer the two-point cornerA/B selection; retain legacy three-point gluePoints compatibility.
    const cornerA = this.selectionCornerA;
    const cornerB = this.selectionCornerB;
    const pointCount = (microMode || singleMode)
      ? 0
      : cornerA !== null
        ? (cornerB !== null ? 2 : 1)
        : this.gluePoints.length;
    // 'micro' when the Selector tool's Tab-toggled micro-block mode is active —
    // including a micro box that is still waiting for its second corner.
    const granularity = microMode || (cornerA !== null && cornerB === null && cornerA.micro === true)
      ? 'micro'
      : 'standard';
    return {
      mode: (microMode || singleMode) ? 'single' : 'box',
      granularity,
      pointCount,
      count,
      ready: (microMode || singleMode) ? count > 0 : cornerA !== null ? cornerB !== null : this.gluePoints.length === 3,
      cells: microMode
        ? this.microSelection.map(cell => ({ ...cell }))
        : singleMode ? this.connectedSelection.map(cell => ({ ...cell })) : null
    };
  }

  clearSelection() {
    this.clearChildSelection();
    if (this.entitySelection?.contraption) {
      this.entitySelection.contraption.clearSubtreeHighlight?.();
    }
    this.entitySelection = null;
    this.selectionCornerA = null;
    this.selectionCornerB = null;
    this.connectedSelection = null;
    this.microSelection = null;
    this.gluePoints = [];
    if (Array.isArray(this.contraptions)) {
      for (const contraption of this.contraptions) {
        contraption.clearSubtreeHighlight?.();
        contraption.clearGlueSelection?.();
      }
    }
  }

  clearChildSelection() {
    if (this.childSelection?.contraption) {
      this.childSelection.contraption.clearGlueSelection();
    }
    this.childSelection = null;
  }

  selectChildEntityCell(hit, isMultiSelect = false) {
    if (!hit?.contraption || !hit.cell) return null;
    if (!hit.contraption.canEditInternalSelection?.()) {
      if (this.childSelection?.contraption === hit.contraption) this.clearChildSelection();
      return null;
    }
    const parentId = hit.entityId || hit.entityNode?.id || hit.contraption.rootComponentId;
    const key = `${hit.cell.x},${hit.cell.y},${hit.cell.z}`;
    const selectableKeys = hit.contraption.getEntityCollisionCellKeys(parentId);
    if (!selectableKeys.has(key)) return null;

    const sameParent = this.childSelection
      && this.childSelection.contraption === hit.contraption
      && this.childSelection.parentId === parentId;

    if (!sameParent) {
      this.clearSelection();
      this.childSelection = {
        contraption: hit.contraption,
        parentId,
        mode: 'single',
        cells: new Set([key])
      };
    } else if (isMultiSelect) {
      if (this.childSelection.cells.has(key)) {
        this.childSelection.cells.delete(key);
      } else {
        this.childSelection.cells.add(key);
      }
    } else {
      this.childSelection.cells = new Set([key]);
    }

    if (this.childSelection.cells.size === 0) {
      this.childSelection.contraption.clearGlueSelection();
      this.childSelection.contraption.setFocusHighlight(parentId);
    } else {
      this.childSelection.contraption.setGlueSelection(parentId, this.childSelection.cells);
    }

    if (this.sound) this.sound.playGlueApply();
    return this.getChildSelectionInfo();
  }

  hasChildSelection() {
    return !!this.childSelection;
  }

  hasReadyChildSelection() {
    return !!(
      this.childSelection
      && this.childSelection.contraption?.canEditInternalSelection?.()
      && this.childSelection.cells.size > 0
    );
  }

  getChildSelectionInfo() {
    if (!this.childSelection) return null;
    if (!this.childSelection.contraption?.canEditInternalSelection?.()) {
      this.clearChildSelection();
      return null;
    }
    const contraption = this.childSelection.contraption;
    const descendantCount = [...contraption.entityNodes.keys()]
      .filter(nodeId => contraption.isEntityDescendantOf(nodeId, this.childSelection.parentId))
      .length;
    return {
      contraption,
      parentId: this.childSelection.parentId,
      mode: 'single',
      pointCount: 0,
      count: this.childSelection.cells.size,
      cells: new Set(this.childSelection.cells),
      ready: this.childSelection.cells.size > 0,
      existingChildCount: descendantCount
    };
  }

  createChildFromSelection(requestedId = null) {
    if (!this.hasReadyChildSelection()) return null;
    const { contraption, parentId, cells } = this.childSelection;
    if (!contraption.canEditInternalSelection?.()) {
      this.clearChildSelection();
      return null;
    }
    contraption.clearGlueSelection();
    const child = contraption.createChildEntity(parentId, cells, requestedId);
    this.childSelection = null;
    if (child && this.sound) this.sound.playAssemblyClack();
    return child ? { contraption, child } : null;
  }

  hasValidSelection() {
    if (this.childSelection) return this.hasReadyChildSelection();
    if (this.microSelection && this.microSelection.length > 0) return true;
    if (this.connectedSelection && this.connectedSelection.length > 0) return true;
    if (this.gluePoints && this.gluePoints.length === 3) return true;
    return this.selectionCornerA !== null && this.selectionCornerB !== null;
  }

  getSelectionBounds() {
    if (this.childSelection) return null;
    if (this.connectedSelection !== null && this.connectedSelection.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of this.connectedSelection) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.z < minZ) minZ = b.z;
        if (b.x > maxX) maxX = b.x;
        if (b.y > maxY) maxY = b.y;
        if (b.z > maxZ) maxZ = b.z;
      }
      return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    if (this.gluePoints && this.gluePoints.length > 0) {
      const minX = Math.min(...this.gluePoints.map(p => p.x));
      const maxX = Math.max(...this.gluePoints.map(p => p.x));
      const minY = Math.min(...this.gluePoints.map(p => p.y));
      const maxY = Math.max(...this.gluePoints.map(p => p.y));
      const minZ = Math.min(...this.gluePoints.map(p => p.z));
      const maxZ = Math.max(...this.gluePoints.map(p => p.z));
      return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    if (!this.selectionCornerA || !this.selectionCornerB) return null;

    const minX = Math.min(this.selectionCornerA.x, this.selectionCornerB.x);
    const maxX = Math.max(this.selectionCornerA.x, this.selectionCornerB.x);
    const minY = Math.min(this.selectionCornerA.y, this.selectionCornerB.y);
    const maxY = Math.max(this.selectionCornerA.y, this.selectionCornerB.y);
    const minZ = Math.min(this.selectionCornerA.z, this.selectionCornerB.z);
    const maxZ = Math.max(this.selectionCornerA.z, this.selectionCornerB.z);

    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  getSelectionBlockCount() {
    if (this.childSelection) return this.childSelection.cells.size;
    if (this.microSelection !== null) return this.microSelection.length;
    if (this.connectedSelection !== null) return this.connectedSelection.length;
    const bounds = this.getSelectionBounds();
    if (!bounds) return 0;
    return (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);
  }

  getBoundsFromPoints(points) {
    if (!points || points.length === 0) return null;
    return {
      minX: Math.min(...points.map(point => point.x)),
      maxX: Math.max(...points.map(point => point.x)),
      minY: Math.min(...points.map(point => point.y)),
      maxY: Math.max(...points.map(point => point.y)),
      minZ: Math.min(...points.map(point => point.z)),
      maxZ: Math.max(...points.map(point => point.z))
    };
  }

  // =========================================================================
  // 2. CONTRAPTION ASSEMBLY (physics instantiation)
  // =========================================================================

  normalizeAssemblyMode(mode = ContraptionMode.PROGRAMMABLE) {
    if (mode === 'auto') return ContraptionMode.PROGRAMMABLE;
    return Object.values(ContraptionMode).includes(mode) ? mode : null;
  }

  assembleSelection(mode = ContraptionMode.PROGRAMMABLE, customOptions = {}) {
    const finalMode = this.normalizeAssemblyMode(mode);
    // Validate before extracting any selected world voxels. Invalid modes must
    // never mutate the world or consume the current selection.
    if (!finalMode) return null;
    if (!this.hasValidSelection()) return null;

    let rawBlocks = [];
    let originPos = new THREE.Vector3(0, 0, 0);

    if (this.microSelection !== null) {
      // Sparse micro selection (Selector micro mode): extract exactly the
      // existing micro voxels at the selected 0.2 m cells.
      const cells = this.microSelection;
      let minMx = Infinity, minMy = Infinity, minMz = Infinity;
      for (const c of cells) {
        if (c.x < minMx) minMx = c.x;
        if (c.y < minMy) minMy = c.y;
        if (c.z < minMz) minMz = c.z;
      }
      if (minMx === Infinity) {
        this.clearSelection();
        return null;
      }
      originPos.set(
        minMx / MICRO_DIVISIONS,
        minMy / MICRO_DIVISIONS,
        minMz / MICRO_DIVISIONS
      );

      // Subdivide any standard blocks containing selected micro cells that haven't been subdivided yet
      const subdividedStandardCells = new Set<string>();
      for (const c of cells) {
        const wx = Math.floor(c.x / MICRO_DIVISIONS);
        const wy = Math.floor(c.y / MICRO_DIVISIONS);
        const wz = Math.floor(c.z / MICRO_DIVISIONS);
        const cellKey = `${wx},${wy},${wz}`;
        if (!subdividedStandardCells.has(cellKey)) {
          if (this.world?.getBlock && this.world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
            this.world.subdivideBlock?.(wx, wy, wz);
          }
          subdividedStandardCells.add(cellKey);
        }
      }

      const affectedChunks = new Set<any>();
      for (const c of cells) {
        const extracted = this.world.extractMicroCellRegion?.(c.x, c.y, c.z, c.x, c.y, c.z) || [];
        for (const micro of extracted) {
          rawBlocks.push({
            localX: micro.mx / MICRO_DIVISIONS - minMx / MICRO_DIVISIONS,
            localY: micro.my / MICRO_DIVISIONS - minMy / MICRO_DIVISIONS,
            localZ: micro.mz / MICRO_DIVISIONS - minMz / MICRO_DIVISIONS,
            size: 0.2,
            block: BlockTypes.COLOR_BLOCK,
            color: micro.color,
            part: micro.part
          });
          const { cx, cz } = this.world.worldToChunkCoords(
            Math.floor(micro.mx / MICRO_DIVISIONS),
            Math.floor(micro.mz / MICRO_DIVISIONS)
          );
          const chunk = this.world.getChunk(cx, cz);
          if (chunk) affectedChunks.add(chunk);
        }
      }
      for (const chunk of affectedChunks) {
        chunk.isDirty = true;
        this.world.dirtyChunks.add(chunk);
      }
    } else if (this.connectedSelection !== null) {
      const bounds = this.getSelectionBounds();
      originPos.set(bounds.minX, bounds.minY, bounds.minZ);

      const affectedChunks = new Set<any>();
      for (const b of this.connectedSelection) {
        const block = this.world.getBlock(b.x, b.y, b.z);
        if (block !== BlockTypes.AIR) {
          rawBlocks.push({
            localX: b.x - bounds.minX,
            localY: b.y - bounds.minY,
            localZ: b.z - bounds.minZ,
            size: 1,
            block,
            color: this.world.getBlockColor(b.x, b.y, b.z)
          });
          this.world.setBlock(b.x, b.y, b.z, BlockTypes.AIR, false);
          const { cx, cz } = this.world.worldToChunkCoords(b.x, b.z);
          const chunk = this.world.getChunk(cx, cz);
          if (chunk) affectedChunks.add(chunk);
        }

        const microBlocks = this.world.extractMicroRegion(b.x, b.y, b.z, b.x, b.y, b.z);
        for (const micro of microBlocks) {
          rawBlocks.push({
            localX: micro.mx / 5 - bounds.minX,
            localY: micro.my / 5 - bounds.minY,
            localZ: micro.mz / 5 - bounds.minZ,
            size: 0.2,
            block: BlockTypes.COLOR_BLOCK,
            color: micro.color,
            part: micro.part
          });
        }
      }

      for (const chunk of affectedChunks) {
        chunk.isDirty = true;
        this.world.dirtyChunks.add(chunk);
      }
    } else {
      const bounds = this.getSelectionBounds();
      originPos.set(bounds.minX, bounds.minY, bounds.minZ);

      const extracted = this.world.extractRegion(
        bounds.minX, bounds.minY, bounds.minZ,
        bounds.maxX, bounds.maxY, bounds.maxZ
      );

      for (const eb of extracted) {
        rawBlocks.push({
          localX: eb.worldX - bounds.minX,
          localY: eb.worldY - bounds.minY,
          localZ: eb.worldZ - bounds.minZ,
          size: 1,
          block: eb.block,
          color: eb.color
        });
      }
    }

    const bounds = this.getSelectionBounds();
    if (bounds && this.connectedSelection === null) {
      const microBlocks = this.world?.extractMicroRegion?.(
        bounds.minX, bounds.minY, bounds.minZ,
        bounds.maxX, bounds.maxY, bounds.maxZ
      ) || [];
      for (const micro of microBlocks) {
        rawBlocks.push({
          localX: micro.mx / 5 - bounds.minX,
          localY: micro.my / 5 - bounds.minY,
          localZ: micro.mz / 5 - bounds.minZ,
          size: 0.2,
          block: BlockTypes.COLOR_BLOCK,
          color: micro.color,
          part: micro.part
        });
      }
    }

    return this.commitPreparedAssembly(rawBlocks, originPos, finalMode, customOptions);
  }

  /**
   * Atomically turn already-extracted voxels into an entity. Large player edits
   * prepare/extract their blocks through BulkEditJob, then use this same commit
   * path so no partially constructed entity is ever registered.
   */
  commitPreparedAssembly(rawBlocks, originPos, mode = ContraptionMode.PROGRAMMABLE, customOptions = {}) {
    const finalMode = this.normalizeAssemblyMode(mode);
    if (!finalMode || !Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      this.clearSelection();
      return null;
    }

    const options = {
      ...customOptions,
      mode: finalMode,
      particleSystem: this.particles
    };
    const origin = originPos?.isVector3
      ? originPos.clone()
      : new THREE.Vector3(Number(originPos?.x) || 0, Number(originPos?.y) || 0, Number(originPos?.z) || 0);
    const contraption = new Contraption(
      this.nextId++,
      rawBlocks,
      origin,
      this.scene,
      options
    );

    this.registerContraption(contraption);
    this.activeProgrammingContraption = contraption;
    this.sound?.playAssemblyClack?.();
    this.sound?.playSteamHiss?.();
    this.particles?.emitSteamPuff?.(contraption.position, 25);
    this.clearSelection();
    this.saveEntitiesToStorage();
    return contraption;
  }

  /**
   * Rebuild an entity from a serialized inventory slot.
   * Inventory slots already contain one explicit root and need no identity remapping.
   * @returns The registered entity, or null for an empty slot.
   */
  buildFromSlot(slot, position, restoreState = null, autoSave = true, preparedBlocks = null) {
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) return null;

    const rootComponentId = String(slot.rootComponentId || '');
    if (!isValidComponentId(rootComponentId)) return null;
    const subtreeChildIds = new Set((slot.childEntities || []).map(d => d.id));
    if (subtreeChildIds.has(rootComponentId)) return null;

    const blocks = Array.isArray(preparedBlocks) ? preparedBlocks : slot.blocks.map(b => ({
      localX: b.localX,
      localY: b.localY,
      localZ: b.localZ,
      size: b.size || 1,
      color: b.color,
      block: b.block,
      entityId: b.entityId
    }));

    if (blocks.some(block => !block.entityId)) return null;

    // Keep only the explicit single-root tree carried by the slot.
    const childEntities = (slot.childEntities || [])
      .filter(d => subtreeChildIds.has(d.id))
      .map(d => ({ ...d }));
    const constraints = (slot.constraints || [])
      .filter(constraint => (
        constraint.bodyB === rootComponentId || subtreeChildIds.has(constraint.bodyB)
      ) && (
        constraint.bodyA === null
        || constraint.bodyA === rootComponentId
        || subtreeChildIds.has(constraint.bodyA)
      ));

    const restoredId = Number(restoreState?.id);
    const entityId = Number.isFinite(restoredId) ? restoredId : this.nextId++;
    if (Number.isFinite(restoredId)) this.nextId = Math.max(this.nextId, restoredId + 1);
    const contraption = new Contraption(
      entityId,
      blocks,
      position.clone(),
      this.scene,
      {
        rootComponentId,
        rootComponentName: slot.name,
        publicId: restoreState?.publicId,
        mode: slot.mode || ContraptionMode.FREE_PHYSICS,
        bodyType: slot.bodyType || BodyType.DYNAMIC,
        mass: slot.mass,
        restitution: slot.restitution,
        friction: slot.friction,
        useGravity: slot.useGravity,
        collisionEnabled: slot.collisionEnabled,
        seats: slot.seats,
        behaviorPrompt: restoreState?.behaviorPrompt,
        agentInterpretation: restoreState?.agentInterpretation,
        localCenter: restoreState?.localCenter,
        rootPivotOverride: Array.isArray(restoreState?.rootPivotOverride)
          ? restoreState.rootPivotOverride
          : slot.rootPivotOverride,
        anchorRotation: slot.anchorRotation,
        childEntities,
        constraints
      }
    );

    for (const entry of slot.scripts || []) {
      contraption.setNodeScript(entry.id, entry.code);
    }
    for (const entry of slot.enabled || []) {
      contraption.setNodeScriptEnabled(entry.id, entry.enabled);
    }

    this.registerContraption(contraption);
    if (restoreState?.serverManaged === true) {
      contraption.serverExecutionMode = restoreState.serverExecutionMode || 'browser';
      contraption.serverHostingEnabled = restoreState.serverHostingEnabled === true;
      contraption.serverManaged = true;
      contraption.serverOwnerUserId = restoreState.serverOwnerUserId || null;
      contraption.serverCanControl = restoreState.serverCanControl === true;
      contraption.serverCanEdit = restoreState.serverCanEdit === true;
      contraption.serverExecutesLocally = restoreState.serverExecutesLocally === true;
      contraption.serverRevision = Number(restoreState.serverRevision) || 0;
      contraption.serverPlaybackRevision = Number(restoreState.serverPlaybackRevision) || 0;
      contraption.serverDesiredRunState = restoreState.serverDesiredRunState || null;
      contraption.serverDefinitionDigest = restoreState.serverDefinitionDigest || null;
      contraption.serverSnapshotDigest = restoreState.serverSnapshotDigest || null;
    }
    if (restoreState) {
      try {
        this.restoreContraptionStreamingState(contraption, restoreState);
      } catch (error) {
        this.removeContraption(contraption, { preserveDormant: true, skipSave: true });
        throw error;
      }
    }
    if (autoSave) {
      this.saveEntitiesToStorage();
    }
    return contraption;
  }

  /** Merge an inventory entity into an existing stopped entity as a component subtree. */
  installSlotAsComponent(
    contraption,
    slot,
    parentNodeId,
    placementOrigin,
    autoSave = true,
    preparedBlocks = null,
    placementRotation = null
  ) {
    if (!contraption || !this.contraptions.includes(contraption)) {
      return Object.freeze({ ok: false, reason: 'target_entity_missing' });
    }
    const result = contraption.installEntitySlot?.(
      slot,
      parentNodeId,
      placementOrigin,
      preparedBlocks,
      placementRotation
    ) || Object.freeze({ ok: false, reason: 'install_unsupported' });
    if (result.ok && autoSave) this.saveEntitiesToStorage();
    return result;
  }

  // =========================================================================
  // 3. CONTRAPTION DISASSEMBLY / SOLIDIFY (restore to static voxels)
  // =========================================================================

  disassembleContraption(contraption) {
    if (!contraption) return false;

    // Ensure running entities are stopped and reset to base rest pose before converting to voxels
    if (contraption.scriptStatus !== 'stopped') {
      contraption.stopAllNodeScripts?.();
    }

    const affectedChunks = new Set<any>();

    for (const b of contraption.blocks) {
      const blockSize = b.size || 1;
      const localP = contraption.getBlockWorldCenter(b);

      if (blockSize < 1) {
        const targetMx = Math.round((localP.x - blockSize / 2) * 5);
        const targetMy = Math.round((localP.y - blockSize / 2) * 5);
        const targetMz = Math.round((localP.z - blockSize / 2) * 5);
        // Solidifying intentionally removes recursive entity motion metadata.
        this.world.setMicroBlock(targetMx, targetMy, targetMz, b.color, null);
        continue;
      }

      const targetX = Math.floor(localP.x);
      const targetY = Math.floor(localP.y);
      const targetZ = Math.floor(localP.z);

      if (targetY >= 0 && targetY < CHUNK_SIZE_Y) {
        this.world.setBlock(targetX, targetY, targetZ, BlockTypes.COLOR_BLOCK, false, b.color);
        const { cx, cz } = this.world.worldToChunkCoords(targetX, targetZ);
        const chunk = this.world.getChunk(cx, cz);
        if (chunk) affectedChunks.add(chunk);
      }
    }

    for (const chunk of affectedChunks) {
      chunk.isDirty = true;
      this.world.dirtyChunks.add(chunk);
    }

    if (this.sound) {
      this.sound.playDisassemblySound?.();
      this.sound.playSteamHiss?.();
    }
    if (this.particles) {
      this.particles.emitSteamPuff?.(contraption.position, 35);
    }

    this.removeContraption(contraption);
    return true;
  }

  removeContraption(contraption, options: any = {}) {
    if (this.childSelection?.contraption === contraption) this.clearChildSelection();
    if (this.entitySelection?.contraption === contraption) {
      this.entitySelection.contraption.clearSubtreeHighlight?.();
      this.entitySelection = null;
    }
    const idx = this.contraptions.indexOf(contraption);
    if (idx !== -1) {
      this.contraptions.splice(idx, 1);
    }
    if (this.activeDrivable === contraption) {
      this.activeDrivable = null;
    }
    if (this.activeProgrammingContraption === contraption) {
      this.activeProgrammingContraption = this.contraptions[this.contraptions.length - 1] || null;
    }
    if (!options.preserveDormant) {
      this.deleteDormantContraption(contraption.publicId);
      if (
        this.entityPersistenceMode === 'remote'
        && options.skipRemoteDelete !== true
        && (contraption.serverManaged !== true || contraption.serverCanEdit === true)
      ) {
        this.remoteEntityPersistence?.remove?.(String(contraption.publicId));
      }
    }
    contraption.setActionContext?.(null);
    contraption.dispose();
    if (!options.skipSave) {
      this.saveEntitiesToStorage();
    }
  }

  // =========================================================================
  // 4. RAYCAST CONTRAPTIONS
  // =========================================================================

  raycastContraptionHit(rayOrigin, rayDir, maxDistance = 15) {
    let closestHit = null;
    let closestDist = maxDistance;

    for (const c of this.contraptions) {
      const hit = c.raycastCollisionCells(rayOrigin, rayDir, closestDist);
      if (!hit || hit.distance > closestDist) continue;
      closestDist = hit.distance;
      closestHit = hit;
    }

    return closestHit;
  }

  /** Entity picking counterpart to World.raycastBent: both inputs are in the
   * visible torus space and returned distances can be compared directly. */
  raycastContraptionHitBent(rayOriginBent, rayDirBent, maxDistance = 15) {
    let closestHit = null;
    let closestDist = maxDistance;

    for (const c of this.contraptions) {
      const hit = c.raycastBentCollisionCells(rayOriginBent, rayDirBent, closestDist);
      if (!hit || hit.distance > closestDist) continue;
      closestDist = hit.distance;
      closestHit = hit;
    }

    return closestHit;
  }

  raycastContraption(rayOrigin, rayDir, maxDistance = 15) {
    return this.raycastContraptionHit(rayOrigin, rayDir, maxDistance)?.contraption || null;
  }

  beginRenderInterpolation(alpha) {
    for (const contraption of this.contraptions) {
      contraption.beginRenderInterpolation?.(alpha);
    }
  }

  endRenderInterpolation() {
    for (const contraption of this.contraptions) {
      contraption.endRenderInterpolation?.();
    }
  }

  // =========================================================================
  // 5. UPDATE LOOP
  // =========================================================================

  /**
   * Physics, entity proximity, editor picks, and broadphase all run in flat
   * (unwrapped) torus coordinates, but each entity keeps whichever periodic
   * representative its motion drifted into. Two entities on opposite sides of
   * a seam are a whole period apart in flat space and never become collision
   * candidates - so "the same block collides at point A but not at point B"
   * exactly where B straddles the seam relative to the other entity's frame.
   * Re-anchor every active entity into the local player's periodic window:
   * the shift is an integer multiple of the period and is invisible to bent
   * rendering, wrapped chunk ids, and wrapped terrain queries.
   */
  reanchorEntitiesToPlayer(players = null) {
    const local = Array.isArray(players)
      ? (players.find(player => player && player.id === 'local') || players[0])
      : null;
    const anchor = local?.position;
    if (!anchor || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[2])) return;
    for (const contraption of this.contraptions) {
      if (!contraption?.position) continue;
      const dx = unwrapPeriodicNear(contraption.position.x, anchor[0], TORUS_SIZE_X) - contraption.position.x;
      const dz = unwrapPeriodicNear(contraption.position.z, anchor[2], TORUS_SIZE_Z) - contraption.position.z;
      contraption.shiftFlatCoordinates?.(dx, dz);
    }
  }

  update(dt, inputState) {
    this.syncContraptionsToLoadedChunks();
    this.physics?.beginEntityUpdate?.(this.contraptions);
    const providedContext = this.runtimeContextProvider?.() || {};
    const runtimeContext = {
      ...providedContext,
      gravity: this.physics
        ? [this.physics.gravity.x, this.physics.gravity.y, this.physics.gravity.z]
        : [0, -18, 0],
      world: this.scriptWorldApi,
      selection: this.scriptSelectionApi
    };
    // 0. Before any entity captures its previous pose or integrates, keep every
    // active entity in the local player's periodic window.
    this.reanchorEntitiesToPlayer(providedContext.players);

    // 1. Update internal kinematics or programmable script evaluation for
    // every entity first, so every controller evaluates against the same
    // update-start state and every entity's swept "previous" pose is captured
    // before any body moves.
    const supportsSubstepFrames = !!(
      this.physics?.prepareContraptionFrame
      && this.physics?.stepContraptionFrame
    );
    const frames = [];
    for (let i = this.contraptions.length - 1; i >= 0; i--) {
      const c = this.contraptions[i];
      c.setActionContext?.({ manager: this, world: this.world });

      const isDriving = (this.activeDrivable === c);
      // Live keyboard input belongs only to the currently mounted entity.
      // Autonomous scripts keep running with a neutral snapshot after dismount.
      c.update(dt, isDriving ? inputState : null, runtimeContext);

      if (!this.physics) continue;
      if (supportsSubstepFrames) {
        const frame = this.physics.prepareContraptionFrame(c, dt);
        if (frame) frames.push(frame);
      } else {
        // Body type, not behavior mode, decides whether a body is integrated.
        // Kinematic bodies still enter this step so their contact velocity and
        // constraints against dynamic children stay current.
        this.physics.update(c, dt);
      }
    }

    // 2. Interleaved physics substeps. Terrain collision resolves inside every
    // substep, and entity-vs-entity collision resolves at the same substep
    // cadence, so a body resting on another entity is caught within a
    // millimetre of sinking - exactly like terrain - instead of falling
    // through the whole entity update first and being popped back afterwards.
    if (this.physics) {
      if (supportsSubstepFrames) {
        let maxSubSteps = 0;
        for (const frame of frames) maxSubSteps = Math.max(maxSubSteps, frame.subSteps);
        const substepCount = Math.max(1, maxSubSteps);
        const broadphaseBounds = this.physics.frameBroadphaseBounds ? new Map() : null;
        if (broadphaseBounds) {
          for (const c of this.contraptions) {
            if (!c?.getRigidBodies?.().length) continue;
            broadphaseBounds.set(c, this.physics.frameBroadphaseBounds(c, dt));
          }
        }
        const pairFrame = this.physics.prepareContraptionPairFrame?.(
          this.contraptions,
          broadphaseBounds || undefined
        );
        for (let step = 0; step < substepCount; step++) {
          for (const frame of frames) {
            if (step < frame.subSteps) this.physics.stepContraptionFrame(frame);
          }
          // Entity vs entity collisions (dynamic-dynamic + dynamic-static)
          if (pairFrame && this.physics.resolvePreparedContraptionPairs) {
            this.physics.resolvePreparedContraptionPairs(pairFrame, dt / substepCount);
          } else {
            this.physics.resolveContraptionPairs?.(
              this.contraptions,
              dt / substepCount,
              broadphaseBounds || undefined
            );
          }
        }
        for (const frame of frames) this.physics.finishContraptionFrame(frame);
      } else {
        this.physics.resolveContraptionPairs?.(this.contraptions, dt);
      }
    }

    // 3. Safety checks: streaming edge and falling into the void.
    // Autonomous entities can cross the streaming edge during this physics
    // step. Snapshot and destroy them instead of allowing one extra off-chunk
    // script/physics update.
    for (let i = this.contraptions.length - 1; i >= 0; i--) {
      const c = this.contraptions[i];
      const chunk = this.getContraptionChunk(c);
      if (this.hasEntityStreamingWindow() && chunk && !this.world.activeChunkKeys.has(chunk.id)) {
        this.unloadContraption(c);
        continue;
      }
      if (c.position.y < -30) {
        this.removeContraption(c);
      }
    }

    // 4. Periodic entity persistence
    this.lastEntitySaveTime = (this.lastEntitySaveTime || 0) + dt;
    const persistenceInterval = this.entityPersistenceMode === 'remote' ? 6.0 : 2.0;
    if (this.lastEntitySaveTime >= persistenceInterval) {
      this.lastEntitySaveTime = 0;
      if (this.contraptions.length > 0 || this.getDormantContraptionCount() > 0) {
        this.saveEntitiesToStorage();
      }
    }
  }
}

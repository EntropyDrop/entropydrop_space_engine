import * as THREE from 'three';
import { normalizeInventoryName } from '../storage/InventoryName.ts';
import { BlockTypes, DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import { ActionDomain, executeBasicAction } from '../actions/BasicActions.ts';
import {
  bendPoint,
  TORUS_GREF,
  TORUS_K_PHI,
  TORUS_MAX_RHO,
  TORUS_R,
  TORUS_RHO,
  TORUS_SIZE_X,
  TORUS_SIZE_Z
} from '../torus/TorusWorld.ts';
import { MICRO_DIVISIONS, MICRO_SIZE } from '../voxel/MicroVoxelLayer.ts';
import {
  EntityScriptRuntimeClient,
  remapEntityScriptChildIds,
  validateEntityScriptSyntax
} from '../scripting/EntityScriptRuntime.ts';
import { PLAYER_MASS_KG } from '../physics/PlayerPhysics.ts';
import { mergeCollisionCells, type CollisionBox } from '../physics/CollisionGeometry.ts';

// Must match createVoxelMesh(): the GPU bends these exact face vertices before
// rasterization, so bent-space picking intersects the same two triangles shown
// under the crosshair instead of approximating them in one flat tangent frame.
const COLLISION_RAYCAST_FACES = [
  { normal: [0, 1, 0], quad: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { normal: [0, -1, 0], quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, -1], quad: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
  { normal: [0, 0, 1], quad: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]] },
  { normal: [-1, 0, 0], quad: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
  { normal: [1, 0, 0], quad: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] }
];

function intersectCollisionTriangleInclusive(ray, a, b, c, point, barycentric) {
  const plane = new THREE.Plane().setFromCoplanarPoints(a, b, c);
  if (!ray.intersectPlane(plane, point)) return false;
  THREE.Triangle.getBarycoord(point, a, b, c, barycentric);
  const epsilon = 1e-5;
  return barycentric.x >= -epsilon
    && barycentric.y >= -epsilon
    && barycentric.z >= -epsilon;
}

function asVector3(value: any, fallback: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  if (value && typeof value === 'object') {
    return new THREE.Vector3(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
  }
  return fallback.clone();
}

function asQuaternion(value: any, fallback: THREE.Quaternion = new THREE.Quaternion()): THREE.Quaternion {
  if (value?.isQuaternion) return value.clone().normalize();
  if (Array.isArray(value) && value.length >= 4) {
    const components = value.slice(0, 4).map(Number);
    if (components.every(Number.isFinite)) {
      const quaternion = new THREE.Quaternion(
        components[0],
        components[1],
        components[2],
        components[3]
      );
      if (quaternion.lengthSq() > 1e-12) return quaternion.normalize();
    }
    return fallback.clone().normalize();
  }
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
      'YXZ'
    ));
  }
  return fallback.clone();
}

function collisionCellKey(block: any): string {
  return `${Math.floor(block.localX + 1e-6)},${Math.floor(block.localY + 1e-6)},${Math.floor(block.localZ + 1e-6)}`;
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
  return Object.freeze({
    ok: count > 0,
    [field]: count,
    reason
  });
}

const SLOW_SCRIPT_THRESHOLD_MS = 5;
const SLOW_SCRIPT_CONSECUTIVE_LIMIT = 3;
const DEFAULT_BLOCK_MASS_KG = 10;
const MIN_BODY_MASS_KG = 0.1;
// This is deliberately independent from the legacy ctx.limits control budget.
// Component bodies may exceed that gameplay budget, but still need a finite
// safety ceiling so repeated untrusted script calls cannot poison physics with
// Infinity/NaN. The ceiling remains three orders of magnitude above the
// largest force used by the built-in controllers and tests.
const MAX_BODY_VECTOR_COMPONENT = 1e12;
const COMPILED_SCRIPT_SENTINEL = function compiledEntityScript(_self, _ctx) {};
const SCRIPT_STATE_LIMIT_BYTES = 64 * 1024;
const MAX_ENTITY_HIERARCHY_DEPTH = 16;
const MAX_ENTITY_BLOCKS = 65_536;
const MAX_ENTITY_CONSTRAINTS = 256;
const MAX_ENTITY_TOTAL_SCRIPT_BYTES = 512 * 1024;

function installedIdCandidate(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || fallback).slice(0, MAX_COMPONENT_ID_LENGTH);
}

function installedComponentIdBase(value: unknown, fallback = 'component'): string {
  const candidate = installedIdCandidate(value, fallback);
  return !isValidComponentId(candidate) ? fallback : candidate;
}

function uniqueInstalledComponentId(preferred: string, reserved: Set<string>): string {
  const cleanPreferred = installedComponentIdBase(preferred);
  let candidate = cleanPreferred;
  let suffix = 2;
  while (reserved.has(candidate) || !isValidComponentId(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${cleanPreferred.slice(0, MAX_COMPONENT_ID_LENGTH - tail.length)}${tail}`;
  }
  reserved.add(candidate);
  return candidate;
}

function uniqueInstalledConstraintId(preferred: string, reserved: Set<string>): string {
  const cleanPreferred = installedIdCandidate(preferred, 'constraint');
  const base = isValidConstraintId(cleanPreferred) ? cleanPreferred : 'constraint';
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate) || !isValidConstraintId(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, MAX_COMPONENT_ID_LENGTH - tail.length)}${tail}`;
  }
  reserved.add(candidate);
  return candidate;
}

function boundedBodyVector(value: any): THREE.Vector3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const components = value.slice(0, 3).map(Number);
  if (components.some(component => !Number.isFinite(component)
    || Math.abs(component) > MAX_BODY_VECTOR_COMPONENT)) return null;
  return new THREE.Vector3(components[0], components[1], components[2]);
}

const SCRIPT_COMPONENT_COMMANDS = new Set([
  'applyThrust', 'applyLocalThrust', 'setLocalPosition', 'setLocalRotation', 'setLocalEuler', 'setLocalSpin', 'setPivot',
  'applyForce', 'applyLocalForce', 'applyForceAt', 'applyTorque', 'setSeats',
  'body.setType', 'body.setMass', 'body.setMaterial', 'body.setGravityEnabled',
  'body.setCollisionEnabled', 'body.applyForce', 'body.applyLocalForce', 'body.applyTorque',
  'constraints.create', 'constraints.remove', 'voxels.set', 'voxels.clear',
  'voxels.paint', 'voxels.clearCell', 'voxels.subdivide', 'microVoxels.set', 'microVoxels.clear',
  'microVoxels.paint'
]);
// These commands describe continuous physical output. If a runtime is still
// finishing an earlier request, its latest output remains held instead of
// dropping a motor or force command for one fixed simulation update.
const LATCHED_SCRIPT_COMPONENT_COMMANDS = new Set([
  'applyThrust', 'applyLocalThrust', 'setLocalPosition', 'setLocalRotation', 'setLocalEuler', 'setLocalSpin',
  'applyForce', 'applyLocalForce', 'applyForceAt', 'applyTorque',
  'body.applyForce', 'body.applyLocalForce', 'body.applyTorque'
]);
const SCRIPT_WORLD_COMMANDS = new Set([
  'voxels.set', 'voxels.clear', 'voxels.paint', 'voxels.clearCell', 'voxels.subdivide',
  'microVoxels.set', 'microVoxels.clear', 'microVoxels.paint'
]);
const SCRIPT_SELECTION_COMMANDS = new Set([
  'clear', 'cornerA', 'cornerB', 'box', 'cells', 'toggle', 'entity', 'entityBox',
  'delete', 'assemble', 'createChild'
]);

function cloneScriptData(value: any, fallback: any = null, maxBytes = SCRIPT_STATE_LIMIT_BYTES) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length > maxBytes) return fallback;
    return JSON.parse(json);
  } catch (_) {
    return fallback;
  }
}

function scriptInputCodes(inputState: any, phase: string): string[] {
  const values = inputState?.[phase];
  if (values instanceof Set) return [...values].map(String);
  if (Array.isArray(values)) return values.map(String);
  return [];
}

function normalizeBodyMass(value: any, fallback: number | null = null): number | null {
  const mass = Number(value);
  return Number.isFinite(mass) && mass > 0
    ? Math.max(MIN_BODY_MASS_KG, mass)
    : fallback;
}

function defaultBodyMass(blocks: any[]): number {
  if (!Array.isArray(blocks) || blocks.length === 0) return MIN_BODY_MASS_KG;
  const totalMass = blocks.reduce(
    (sum, b) => sum + Math.pow(b?.size || 1, 3) * DEFAULT_BLOCK_MASS_KG,
    0
  );
  return Math.max(MIN_BODY_MASS_KG, Number(totalMass.toFixed(3)));
}

/** Public, non-sequential identity used by scripts, chunk queries, and UI. */
export function createEntityPublicId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return `ent_${cryptoApi.randomUUID()}`;
  }
  // Browser fallback for contexts without randomUUID. The internal numeric id
  // remains separate, so this value is never used as an array/map index.
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, token => {
    const value = Math.floor(Math.random() * 16);
    return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
  return `ent_${hex}`;
}

export const ContraptionMode = {
  FREE_PHYSICS: 'free_physics', // Free rigid-body physics
  PROJECTILE: 'projectile',      // Ballistic projectile
  PROGRAMMABLE: 'programmable'  // Programmable force entity
};

/** Maximum AABB edge, in standard cells (1 m each), for one entity and for any
 * selection that can become an entity. */
export const MAX_ENTITY_BOUNDS = 64;
export const MAX_ENTITY_COMPONENTS = 64;
export const MAX_COMPONENT_ID_LENGTH = 64;
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Shared format for component and constraint ids. */
export function isValidPortableId(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_COMPONENT_ID_LENGTH) return false;
  return COMPONENT_ID_PATTERN.test(value);
}

/** Constraint ids live in their own namespace. */
export function isValidConstraintId(value: unknown): boolean {
  return isValidPortableId(value);
}

/** Component ids are portable identities. Hierarchy and external constraint
 * endpoints are represented structurally, so no string is reserved. */
export function isValidComponentId(value: unknown): boolean {
  return isValidPortableId(value);
}

/** Infer the structurally unique flat-tree root when callers already provide
 * component ownership/parent references. Ambiguous or bare block lists receive
 * an ordinary generated-model default; no particular ID has root semantics. */
function resolveRootComponentId(blocks: any[], options: any): string {
  if (isValidComponentId(options?.rootComponentId)) return options.rootComponentId;
  const children = Array.isArray(options?.childEntities) ? options.childEntities : [];
  const childIds = new Set<string>(
    children
      .map(definition => definition?.id)
      .filter((id): id is string => isValidComponentId(id))
  );
  const candidates = new Set<string>();
  const addCandidate = (value: unknown) => {
    if (isValidComponentId(value) && !childIds.has(value as string)) candidates.add(value as string);
  };
  for (const definition of children) addCandidate(definition?.parentId);
  for (const block of blocks || []) addCandidate(block?.entityId);
  for (const constraint of options?.constraints || []) {
    addCandidate(constraint?.bodyA);
    addCandidate(constraint?.bodyB);
  }
  return candidates.size === 1
    ? [...candidates][0]
    : uniqueInstalledComponentId('component', new Set(childIds));
}

/** Portable ids are ASCII, so ordinal comparison is deterministic across
 * browsers and matches the backend's string ordering. */
function compareIds(left: unknown, right: unknown): number {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareComponentIds(left: unknown, right: unknown): number {
  return compareIds(left, right);
}

/** World voxels are the only static collision layer. Entity bodies are either
 * script-driven kinematic bodies or force-driven dynamic bodies. */
export const BodyType = Object.freeze({
  KINEMATIC: 'kinematic',
  DYNAMIC: 'dynamic'
} as const);

export type BodyTypeValue = 'kinematic' | 'dynamic';

function normalizeBodyType(value: any, fallback: any = BodyType.DYNAMIC): any {
  return value === BodyType.KINEMATIC || value === BodyType.DYNAMIC ? value : fallback;
}

function clampUnit(value: any, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function angularVelocityBetween(previous: THREE.Quaternion, current: THREE.Quaternion, dt: number) {
  if (!(dt > 0)) return new THREE.Vector3();
  const delta = current.clone().multiply(previous.clone().invert()).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, delta.w)));
  const sinHalf = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
  if (angle < 1e-8 || sinHalf < 1e-8) return new THREE.Vector3();
  return new THREE.Vector3(delta.x, delta.y, delta.z).divideScalar(sinHalf).multiplyScalar(angle / dt);
}

/**
 * A node in the entity hierarchy. The tree describes ownership and authored
 * parent-relative transforms; each node also owns a kinematic or dynamic body.
 */
export interface EntityNode {
  id: string;
  parentId: string | null;
  pivotLocal: THREE.Vector3;
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  /** Authored mounting frame in this component's local coordinates. */
  anchorQuaternion: THREE.Quaternion;
  localAngularVelocity: THREE.Vector3;
  commandedThisFrame?: boolean;
  initialLocalPosition?: THREE.Vector3;
  initialLocalQuaternion?: THREE.Quaternion;
  group: THREE.Group;
  children: Set<string>;
  previousWorldMatrix?: THREE.Matrix4;
  previousLocalPosition?: THREE.Vector3;
  previousLocalQuaternion?: THREE.Quaternion;
  bodyType: string;
}

export interface EntityRigidBody {
  id: string;
  nodeId: string;
  type: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  appliedForces: THREE.Vector3;
  appliedTorques: THREE.Vector3;
  mass: number;
  inverseInertia: number;
  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  centerOfMassLocal: THREE.Vector3;
  previousKinematicPosition: THREE.Vector3;
  previousKinematicQuaternion: THREE.Quaternion;
  isOnGround: boolean;
  /** False while the entity is stopped. The authored body type is preserved,
   * but the solver treats this body as an immovable static collider. */
  simulationEnabled: boolean;
}

export class Contraption {
  // --- Identity & data ---
  id: string;
  publicId: string;
  /** The structurally distinguished root node's ordinary component id. */
  rootComponentId: string;
  rootComponentName: string;
  blocks: any[];
  scene: any;
  originWorldPos: THREE.Vector3;
  serverManaged?: boolean;
  serverExecutionMode?: 'browser' | 'hosted';
  serverHostingEnabled?: boolean;
  serverOwnerUserId?: string | null;
  serverCanControl?: boolean;
  serverCanEdit?: boolean;
  serverExecutesLocally?: boolean;
  serverRevision?: number;
  serverPlaybackRevision?: number;
  serverDesiredRunState?: 'running' | 'stopped' | null;
  serverDefinitionDigest?: string | null;
  serverSnapshotDigest?: string | null;

  // --- Spatial / 3D hierarchy ---
  rootGroup: THREE.Group;
  meshGroup: THREE.Group;
  rootAnchorQuaternion: THREE.Quaternion;
  entityNodes: Map<string, EntityNode>;
  childDefinitions: Map<string, any>;
  rigidBodies: Map<string, EntityRigidBody>;
  constraintDefinitions: Map<string, any>;
  childScriptApis: Map<string, any>;
  nextChildId: number;
  glueSelectionGroup: THREE.Group | null;
  glueHighlightEntries: Array<{ container: THREE.Group; role: string; cell: { x: number; y: number; z: number }; entityId: string }>;
  glueHighlightMaterials: { selectedLine: THREE.LineBasicMaterial; selectedFill: THREE.MeshBasicMaterial } | null;
  glueHighlightGeometries: { boxGeometry: THREE.BoxGeometry; edgeGeometry: THREE.EdgesGeometry } | null;
  focusHighlightEntries: Array<{ container: THREE.Group; ownerNode: EntityNode; isChild: boolean }>;
  focusHighlightGeometries: THREE.BufferGeometry[];
  focusHighlightMaterials: {
    focusedLine: THREE.LineBasicMaterial;
    focusedFill: THREE.MeshBasicMaterial;
    childLine: THREE.LineBasicMaterial;
    childFill: THREE.MeshBasicMaterial;
  } | null;
  focusedHighlightNodeId: string | null;
  nodeHighlightBox: THREE.Group | null;
  nodeHighlightGeometries: { box: THREE.BoxGeometry; edges: THREE.EdgesGeometry } | null;
  nodeHighlightMaterials: { lineMat: THREE.LineBasicMaterial; fillMat: THREE.MeshBasicMaterial; pivotMat?: any } | null;
  subtreeHighlightBoxes: any[];
  selectedNodeId: string | null;
  highlightBox: any;
  isHighlighted: boolean;

  // --- Physics state ---
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  previousPosition: THREE.Vector3;
  previousQuaternion: THREE.Quaternion;
  renderSimulationPosition: THREE.Vector3;
  renderSimulationQuaternion: THREE.Quaternion;
  renderInterpolated: boolean;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  voxelVolume: number;
  mass: number;
  massOverride: number | null;
  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  bodyType: string;
  useGravity: boolean;
  collisionEnabled: boolean;
  /** Entity-level dynamics switch. Stopped entities keep collision/query
   * shapes but do not integrate, solve constraints, or receive impulses. */
  physicsSimulationEnabled: boolean;
  physicsWakeVersion = 0;
  /** Original PB BodyConfig values captured before the first script-only mutation. */
  runtimeBodyConfigDefaults: Map<string, any>;
  isOnGround: boolean;
  groundDistance: number;
  maxForce: number;
  maxTorque: number;
  powerUtilization: number;
  boundingRadius: number;
  minLocal: THREE.Vector3;
  maxLocal: THREE.Vector3;
  size: THREE.Vector3;
  localCenter: THREE.Vector3;
  blockMap: Map<string, any>;
  /** Collision boxes quantized to the 0.2 micro grid: x/y/z are micro-cell
   *  indices and span is the box edge length in micro cells (5 for a standard
   *  voxel, 1 for a micro voxel). */
  collisionCells: Array<{ x: number; y: number; z: number; span: number }>;
  collisionEntries: Array<{ x: number; y: number; z: number; span: number; entityId: string }>;
  /** Collision entries that can actually reach the exterior of their node's
   * voxel union. Fully enclosed voxels never contribute a contact. */
  collisionSurfaceEntries: Array<{ x: number; y: number; z: number; span: number; entityId: string }>;
  collisionPhysicsBoxes: CollisionBox[];
  collisionTerrainBoxes: CollisionBox[];
  collisionCellCount: number;
  collisionPoseVersion: number;
  collisionWorldAabbCache: { version: number; all?: any[]; surface?: any[]; merged?: any[] } | null;
  collisionSamplePointCache: Map<string, { version: number; points: THREE.Vector3[] }>;

  // --- Applied forces ---
  appliedForces: THREE.Vector3;
  appliedTorques: THREE.Vector3;
  lastAppliedForce: THREE.Vector3;
  lastAppliedTorque: THREE.Vector3;

  // --- Operational mode ---
  mode: string;

  // --- Programmable script state ---
  scriptCode: string;
  compiledScript: Function | null;
  scriptError: string | null;
  scriptStatus: string;
  nodeScripts: Map<string, string>;
  compiledNodeScripts: Map<string, Function>;
  nodeScriptErrors: Map<string, string>;
  nodeScriptEnabled: Map<string, boolean>;
  componentVariables: Map<string, Record<string, any>>;
  slowScriptFrames: Map<string, number>;
  blocksChangedThisFrame: boolean;
  lastBlocksChangedEvent: any;
  /** Rotation-center override for a kinematic root, set by setPivot; null uses center of mass. */
  rootPivotOverride: THREE.Vector3 | null;
  /** Driver-seat positions relative to the root component pivot. */
  seats: Array<{ position: [number, number, number] }>;
  scriptLogs: string[];
  lastExecutionTimeMs: number;
  tickCount: number;
  scriptRuntime: number;
  totalRuntime: number;
  latchedScriptCommands: any[];
  pendingScriptInputDown: string[];
  pendingScriptInputPressed: Set<string>;
  pendingScriptInputReleased: Set<string>;
  pendingScriptBlocksEvent: any;
  pendingScriptContacts: any[];
  pendingScriptCommandResults: any[];
  scriptRuntimeClient: EntityScriptRuntimeClient;
  behaviorPrompt: string;
  agentInterpretation: string;
  scriptApi: any;
  particleSystem: any;
  actionContext: any;

  constructor(id: any, blocks: any[], originWorldPos: any, scene: any, options: any = {}) {
    this.id = id;
    this.publicId = typeof options.publicId === 'string' && options.publicId.trim()
      ? options.publicId.trim()
      : createEntityPublicId();
    this.rootComponentId = resolveRootComponentId(blocks, options);
    this.rootComponentName = normalizeInventoryName(options.rootComponentName);
    this.blocks = blocks; // [{ localX, localY, localZ, size, color, block, entityId }]
    for (const block of this.blocks) {
      block.entityId = block.entityId || this.rootComponentId;
    }
    this.scene = scene;
    this.originWorldPos = originWorldPos.clone();
    this.collisionPoseVersion = 0;
    this.collisionWorldAabbCache = null;
    this.collisionSamplePointCache = new Map();

    // Collision is a union of per-voxel boxes quantized to the 0.2 micro
    // grid, so micro voxels keep their own 0.2-size collision shape instead of
    // inflating their whole 1x1x1 parent cell.
    this.buildCollisionCells();
    this.calculateBoundsAndCenter();
    // A live block edit keeps the entity's original coordinate anchor instead
    // of re-centering it on the new bounds. Restore that anchor before any
    // transforms or hierarchy nodes are created so a persisted entity uses the
    // same pivot after a reload.
    if (isFiniteVector3Array(options.localCenter)) {
      this.localCenter.fromArray(options.localCenter);
    }

    // 3D Object Hierarchy
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = `Contraption_${id}`;
    this.rootGroup.position.copy(originWorldPos).add(this.localCenter);

    // Physics Transform
    this.position = this.rootGroup.position;
    this.quaternion = this.rootGroup.quaternion;
    this.previousPosition = this.position.clone();
    this.previousQuaternion = this.quaternion.clone();
    this.renderSimulationPosition = this.position.clone();
    this.renderSimulationQuaternion = this.quaternion.clone();
    this.renderInterpolated = false;
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.angularVelocity = new THREE.Vector3(0, 0, 0);

    // Physics Properties
    this.voxelVolume = this.blocks.reduce((sum, block) => sum + Math.pow(block.size || 1, 3), 0);
    this.massOverride = normalizeBodyMass(options.mass);
    this.mass = this.massOverride ?? defaultBodyMass(this.blocks);
    this.restitution = clampUnit(options.restitution, 0.1);
    this.friction = clampUnit(options.friction, 0.7);
    this.linearDamping = 0.98;
    this.angularDamping = 0.92;
    this.bodyType = normalizeBodyType(options.bodyType, BodyType.DYNAMIC);
    this.useGravity = options.useGravity !== undefined
      ? !!options.useGravity
      : this.bodyType === BodyType.DYNAMIC;
    this.collisionEnabled = options.collisionEnabled !== false;
    this.physicsSimulationEnabled = options.physicsSimulationEnabled !== false;
    this.runtimeBodyConfigDefaults = new Map();
    this.isOnGround = false;
    this.groundDistance = 0;

    // The legacy top-level root-force surface has a finite, shape-aware control
    // budget. Per-component self.body.apply* commands intentionally bypass it.
    this.maxForce = Math.max(80, this.mass * 65);
    this.maxTorque = Math.max(40, this.maxForce * Math.max(0.75, this.boundingRadius));
    this.powerUtilization = 0;

    // Operational Mode
    this.mode = options.mode || ContraptionMode.FREE_PHYSICS;

    // Force accumulators for custom/programmable forces
    this.appliedForces = new THREE.Vector3(0, 0, 0);
    this.appliedTorques = new THREE.Vector3(0, 0, 0);
    this.lastAppliedForce = new THREE.Vector3(0, 0, 0);
    this.lastAppliedTorque = new THREE.Vector3(0, 0, 0);

    // Programmable Script State
    this.scriptCode = options.scriptCode || '';
    this.compiledScript = null;
    this.scriptError = null;
    this.scriptStatus = 'stopped'; // 'running' | 'error' | 'stopped'
    this.nodeScripts = new Map();
    this.compiledNodeScripts = new Map();
    this.nodeScriptErrors = new Map();
    this.nodeScriptEnabled = new Map();
    this.componentVariables = new Map([[this.rootComponentId, {}]]);
    this.slowScriptFrames = new Map();
    this.blocksChangedThisFrame = false;
    this.lastBlocksChangedEvent = null;
    this.rootPivotOverride = isFiniteVector3Array(options.rootPivotOverride)
      ? new THREE.Vector3().fromArray(options.rootPivotOverride)
      : null;
    this.rootAnchorQuaternion = asQuaternion(options.anchorRotation);
    this.seats = this.normalizeSeats(options.seats);
    this.scriptLogs = [];
    this.lastExecutionTimeMs = 0;
    this.tickCount = 0;
    this.scriptRuntime = 0;
    this.totalRuntime = 0;
    this.latchedScriptCommands = [];
    this.pendingScriptInputDown = [];
    this.pendingScriptInputPressed = new Set();
    this.pendingScriptInputReleased = new Set();
    this.pendingScriptBlocksEvent = null;
    this.pendingScriptContacts = [];
    this.pendingScriptCommandResults = [];
    this.scriptRuntimeClient = new EntityScriptRuntimeClient();
    this.scriptRuntimeClient.onCompileResult = result => this.handleWorkerCompileResult(result);
    this.behaviorPrompt = options.behaviorPrompt || '';
    this.agentInterpretation = options.agentInterpretation || '';

    // Optional particle system reference
    this.particleSystem = options.particleSystem || null;

    // Component node highlight state
    this.nodeHighlightBox = null;
    this.nodeHighlightGeometries = null;
    this.nodeHighlightMaterials = null;
    this.subtreeHighlightBoxes = [];
    this.selectedNodeId = null;

    // Entity hierarchy. Every node owns blocks, an authored parent-relative
    // transform, and an independent kinematic or dynamic rigid body.
    this.meshGroup = new THREE.Group();
    this.rootGroup.add(this.meshGroup);
    this.entityNodes = new Map();
    this.childDefinitions = new Map();
    this.rigidBodies = new Map();
    this.constraintDefinitions = new Map();
    this.childScriptApis = new Map();
    this.nextChildId = 1;
    this.glueSelectionGroup = null;
    this.glueHighlightEntries = [];
    this.glueHighlightMaterials = null;
    this.glueHighlightGeometries = null;
    this.initializeEntityHierarchy(options.childEntities || []);
    this.initializeConstraints(options.constraints || []);

    // Every component (root included) receives the same unified `self` API
    // (script signature `(self, ctx)`). State is read from ctx; motion writes
    // are forces or per-component kinematics, depending on the node type.
    this.scriptApi = this.getComponentApi(this.rootComponentId);

    // Add to Scene
    this.scene.add(this.rootGroup);

    // Selection/Highlight Box
    this.createHighlightBox();

    // Programming is a capability, not an exclusive physical mode. Dynamic
    // and kinematic entities may both run code.
    if (this.scriptCode) {
      this.setScript(this.scriptCode);
    }
  }

  // =========================================================================
  // SPATIAL TRANSFORMS & SPATIAL QUERIES
  // =========================================================================

  worldToLocal(worldPos) {
    const diff = worldPos.clone().sub(this.position);
    diff.applyQuaternion(this.quaternion.clone().invert());
    return diff.add(this.localCenter);
  }

  localToWorld(localPos) {
    const diff = localPos.clone().sub(this.localCenter);
    diff.applyQuaternion(this.quaternion);
    return diff.add(this.position);
  }

  getEntityNode(nodeId = this.rootComponentId) {
    return this.entityNodes.get(nodeId || this.rootComponentId) || null;
  }

  entityLocalToWorld(nodeId, localPos) {
    const node = this.getEntityNode(nodeId) || this.getEntityNode(this.rootComponentId);
    if (!node?.group) return this.localToWorld(localPos);
    node.group.updateWorldMatrix(true, false);
    return node.group.localToWorld(localPos.clone().sub(node.pivotLocal));
  }

  worldToEntityLocal(nodeId, worldPos) {
    const node = this.getEntityNode(nodeId) || this.getEntityNode(this.rootComponentId);
    if (!node?.group) return this.worldToLocal(worldPos);
    node.group.updateWorldMatrix(true, false);
    return node.group.worldToLocal(worldPos.clone()).add(node.pivotLocal);
  }

  getEntityNodeWorldQuaternion(nodeId) {
    const node = this.getEntityNode(nodeId) || this.getEntityNode(this.rootComponentId);
    return node?.group?.getWorldQuaternion(new THREE.Quaternion()) || this.quaternion.clone();
  }

  getEntityNodeWorldPosition(nodeId) {
    const node = this.getEntityNode(nodeId) || this.getEntityNode(this.rootComponentId);
    return node?.group?.getWorldPosition(new THREE.Vector3()) || this.position.clone();
  }

  /** V2 persistent state is scoped to one component instead of shared by the entity. */
  getComponentState(nodeId) {
    const id = String(nodeId || this.rootComponentId);
    if (!this.componentVariables.has(id)) this.componentVariables.set(id, {});
    return this.componentVariables.get(id);
  }

  resolveComponentBlockColor(nodeId, options = null) {
    const ownBlocks = this.blocks.filter(blk => (blk.entityId || this.rootComponentId) === nodeId);
    const inherited = ownBlocks.length > 0 ? ownBlocks[0].color : DEFAULT_BLOCK_COLOR;
    if (options === null || options === undefined) return inherited;
    if (Number.isFinite(Number(options?.color))) return Number(options.color) & 0xffffff;
    if (options?.r !== undefined || options?.g !== undefined || options?.b !== undefined) {
      return ((Number(options.r) || 0) & 255) << 16
        | ((Number(options.g) || 0) & 255) << 8
        | ((Number(options.b) || 0) & 255);
    }
    return inherited;
  }

  getComponentStandardCell(node, location) {
    if (!isFiniteVector3Array(location)) return null;
    return {
      x: Math.floor(Number(location[0]) + node.pivotLocal.x + 1e-6),
      y: Math.floor(Number(location[1]) + node.pivotLocal.y + 1e-6),
      z: Math.floor(Number(location[2]) + node.pivotLocal.z + 1e-6)
    };
  }

  /** Bind the entity to the engine command context used by UI and scripts. */
  setActionContext(context) {
    this.actionContext = context || null;
    return this;
  }

  /** The sole entity mutation entry used by self.*, mouse controls and editor actions. */
  performBasicAction(command) {
    return executeBasicAction(
      { contraption: this, ...(this.actionContext || {}) },
      { domain: ActionDomain.ENTITY, target: { contraption: this }, actor: { source: 'script' }, ...command }
    );
  }

  setComponentMicroVoxel(nodeId, node, location, microOffset, options = null) {
    const cell = this.getComponentStandardCell(node, location);
    if (!cell || !isMicroOffset(microOffset)) {
      return scriptEditResult('placed', 0, 'invalid_position');
    }
    const result = this.performBasicAction({
      action: 'place-micro',
      nodeId,
      micro: [
        cell.x * 5 + Number(microOffset[0]),
        cell.y * 5 + Number(microOffset[1]),
        cell.z * 5 + Number(microOffset[2])
      ],
      options
    });
    return scriptEditResult('placed', result.placed || 0, result.reason);
  }

  setComponentStandardVoxel(nodeId, node, location, options = null) {
    const cell = this.getComponentStandardCell(node, location);
    if (!cell) return scriptEditResult('placed', 0, 'invalid_position');
    const result = this.performBasicAction({ action: 'place-standard', nodeId, cell, options });
    return scriptEditResult('placed', result.placed || 0, result.reason);
  }

  clearComponentStandardVoxel(nodeId, node, location) {
    const cell = this.getComponentStandardCell(node, location);
    if (!cell) return scriptEditResult('removed', 0, 'invalid_position');
    const result = this.performBasicAction({ action: 'remove-standard', nodeId, cell });
    return scriptEditResult('removed', result.removed || 0, result.reason);
  }

  clearComponentMicroVoxel(nodeId, node, location, microOffset) {
    const cell = this.getComponentStandardCell(node, location);
    if (!cell || !isMicroOffset(microOffset)) {
      return scriptEditResult('removed', 0, 'invalid_position');
    }
    const result = this.performBasicAction({
      action: 'remove-micro',
      nodeId,
      micro: [
        cell.x * 5 + Number(microOffset[0]),
        cell.y * 5 + Number(microOffset[1]),
        cell.z * 5 + Number(microOffset[2])
      ]
    });
    return scriptEditResult('removed', result.removed || 0, result.reason);
  }

  normalizeSeats(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap(seat => {
      const position = Array.isArray(seat) ? seat : seat?.position;
      if (!Array.isArray(position) || position.length < 3) return [];
      const normalized = position.slice(0, 3).map(Number);
      return normalized.every(Number.isFinite)
        ? [{ position: normalized as [number, number, number] }]
        : [];
    });
  }

  /** Keep the runtime hierarchy schema closed. Inputs may originate outside
   * protobuf decoding, so only fields represented by the current Component
   * contract are retained; ownership-only blockKeys are consumed separately. */
  normalizeChildDefinition(definition, id: string, parentId: string) {
    const normalized: any = {
      id,
      name: normalizeInventoryName(definition?.name),
      parentId,
      bodyType: normalizeBodyType(definition?.bodyType, BodyType.KINEMATIC),
      restitution: clampUnit(definition?.restitution, this.restitution),
      friction: clampUnit(definition?.friction, this.friction),
      useGravity: definition?.useGravity !== false,
      collisionEnabled: definition?.collisionEnabled !== false,
      seats: this.normalizeSeats(definition?.seats)
    };
    if (isFiniteVector3Array(definition?.pivot)) {
      normalized.pivot = definition.pivot.slice(0, 3).map(Number);
    }
    if (isFiniteVector3Array(definition?.localPosition)) {
      normalized.localPosition = definition.localPosition.slice(0, 3).map(Number);
    }
    const hasLocalRotation = Array.isArray(definition?.localRotation)
      && definition.localRotation.length >= 3
      && definition.localRotation.slice(0, 4).every(value => Number.isFinite(Number(value)));
    if (hasLocalRotation || definition?.localRotation?.isQuaternion) {
      normalized.localRotation = asQuaternion(definition.localRotation).toArray();
    }
    const hasAnchorRotation = Array.isArray(definition?.anchorRotation)
      && definition.anchorRotation.length >= 3
      && definition.anchorRotation.slice(0, 4).every(value => Number.isFinite(Number(value)));
    if (hasAnchorRotation || definition?.anchorRotation?.isQuaternion) {
      normalized.anchorRotation = asQuaternion(definition.anchorRotation).toArray();
    }
    const mass = normalizeBodyMass(definition?.mass);
    if (mass !== null) normalized.mass = mass;
    return normalized;
  }

  /** Serialize only current flat-slot Component fields. Runtime-only or
   * unknown input metadata must never be echoed into inventory/persistence. */
  serializeChildDefinition(definition, parentId = definition.parentId) {
    const defaults = this.getNodeDefaultBodyConfig(definition.id);
    const serialized = this.normalizeChildDefinition({
      id: definition.id,
      name: definition.name,
      parentId,
      pivot: definition.pivot,
      localPosition: definition.localPosition,
      localRotation: definition.localRotation,
      anchorRotation: this.entityNodes.get(definition.id)?.anchorQuaternion.toArray()
        || asQuaternion(definition.anchorRotation).toArray(),
      bodyType: defaults?.bodyType || definition.bodyType,
      mass: defaults?.mass,
      restitution: defaults?.restitution ?? definition.restitution,
      friction: defaults?.friction ?? definition.friction,
      useGravity: defaults?.useGravity ?? (definition.useGravity !== false),
      collisionEnabled: defaults?.collisionEnabled ?? (definition.collisionEnabled !== false),
      seats: definition.seats
    }, definition.id, parentId);
    const configuredMass = normalizeBodyMass(defaults?.mass);
    if (configuredMass === null) delete serialized.mass;
    else serialized.mass = configuredMass;
    return serialized;
  }

  getComponentSeats(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    const source = id === this.rootComponentId ? this.seats : this.childDefinitions.get(id)?.seats;
    return this.normalizeSeats(source);
  }

  setComponentSeats(nodeId, seats) {
    const id = String(nodeId || this.rootComponentId);
    const normalized = this.normalizeSeats(seats);
    if (id === this.rootComponentId) this.seats = normalized;
    else {
      const definition = this.childDefinitions.get(id);
      if (!definition) return false;
      definition.seats = normalized;
    }
    return true;
  }

  /** Resolve one component-relative seat through the current articulated pose. */
  getSeatWorldPosition(componentId = this.rootComponentId, seatIndex = 0) {
    const id = String(componentId || this.rootComponentId);
    const node = this.entityNodes.get(id);
    const seat = this.getComponentSeats(id)[Number(seatIndex)];
    if (!node || !seat) return null;
    const position = seat.position;
    return this.entityLocalToWorld(id, new THREE.Vector3(
      position[0] + node.pivotLocal.x,
      position[1] + node.pivotLocal.y,
      position[2] + node.pivotLocal.z
    ));
  }

  /** Find the seat whose current world position is closest to the aimed block. */
  getNearestSeat(worldFocus) {
    if (!worldFocus?.isVector3) return null;
    let nearest = null;
    const nodes = [...this.entityNodes.values()]
      .sort((left, right) => compareComponentIds(left.id, right.id));
    for (const node of nodes) {
      const seats = this.getComponentSeats(node.id);
      for (let index = 0; index < seats.length; index++) {
        const worldPosition = this.getSeatWorldPosition(node.id, index);
        if (!worldPosition) continue;
        const distanceSq = worldPosition.distanceToSquared(worldFocus);
        if (!nearest || distanceSq < nearest.distanceSq) {
          nearest = { componentId: node.id, seatIndex: index, worldPosition, distanceSq };
        }
      }
    }
    return nearest;
  }

  /**
   * Unified component API (`self`): roots and child components share one abstraction.
   * Scripts use the V2 (self, ctx) signature.
   * - A Common: transform queries, applyThrust, and getBounds work for every component.
   * - B Kinematic: pose controls work only on kinematic component bodies.
   * - C Rigid body: every component exposes its own body/material/constraint API.
   */
  getComponentApi(nodeId) {
    const id = String(nodeId || this.rootComponentId);
    const node = this.entityNodes.get(id);
    if (!node) return null;
    const isRoot = node.parentId === null;
    const noop = () => {};

    const api: any = {
      apiVersion: 2,
      id,
      parentId: node.parentId,

      // ---------- A. Common ----------
      /**
       * Apply thrust at this component along a root-entity local direction.
       * - Root: force at center of mass, matching applyLocalForce.
       * - Child: force at the component position, producing τ = r × F off-center.
       * Direction is independent of spin, follows root orientation, respects the
       * legacy root-body force budget, and has no effect on a kinematic root body.
       */
      applyThrust: (force) => {
        if (!Array.isArray(force) || force.length < 3) return;
        const worldForce = new THREE.Vector3(
          Number(force[0]) || 0,
          Number(force[1]) || 0,
          Number(force[2]) || 0
        ).applyQuaternion(this.quaternion);
        const componentWorldPos = this.getEntityNodeWorldPosition(id);
        const rootLocalPivot = this.worldToLocal(componentWorldPos);
        this.applyForceAt(
          [worldForce.x, worldForce.y, worldForce.z],
          [rootLocalPivot.x, rootLocalPivot.y, rootLocalPivot.z]
        );
      },
      /**
       * Apply thrust at this component using its full mounted local frame.
       * Unlike the legacy applyThrust, a side-mounted module's +Y therefore
       * follows the face normal stored in its installed localRotation.
       */
      applyLocalThrust: (force) => {
        if (!Array.isArray(force) || force.length < 3) return;
        const worldForce = new THREE.Vector3(
          Number(force[0]) || 0,
          Number(force[1]) || 0,
          Number(force[2]) || 0
        ).applyQuaternion(this.getEntityNodeWorldQuaternion(id));
        const componentWorldPos = this.getEntityNodeWorldPosition(id);
        const rootLocalPivot = this.worldToLocal(componentWorldPos);
        this.applyForceAt(
          [worldForce.x, worldForce.y, worldForce.z],
          [rootLocalPivot.x, rootLocalPivot.y, rootLocalPivot.z]
        );
      },
      getWorldPosition: () => Object.freeze(this.getEntityNodeWorldPosition(id).toArray()),
      /** World-orientation quaternion [x,y,z,w], including all ancestor rotations. */
      getWorldRotation: () => Object.freeze(this.getEntityNodeWorldQuaternion(id).toArray()),
      /** Current pivot in entity-local coordinates, shared by getBounds and setPivot. */
      getPivot: () => Object.freeze([node.pivotLocal.x, node.pivotLocal.y, node.pivotLocal.z]),
      localToWorldDirection: direction => {
        const localDirection = asVector3(direction, new THREE.Vector3());
        const worldDirection = localDirection.applyQuaternion(this.getEntityNodeWorldQuaternion(id));
        return Object.freeze(worldDirection.toArray());
      },
      /** Entity-local block bounds {min, max, size, center}, or null when empty. */
      getBounds: () => this.getNodeBlocksBounds(id),

      // ---------- B. Kinematic pose control ----------
      setLocalPosition: isRoot ? value => {
        // A kinematic root has no parent, so its local frame is world space.
        if (this.bodyType !== BodyType.KINEMATIC) return;
        this.position.copy(asVector3(value, this.position));
      } : value => {
        if (node.bodyType !== BodyType.KINEMATIC) return;
        node.localPosition.copy(asVector3(value, node.localPosition));
        node.group.position.copy(node.localPosition);
      },
      setLocalRotation: isRoot ? value => {
        if (this.bodyType !== BodyType.KINEMATIC) return;
        this.quaternion.copy(asQuaternion(value, this.quaternion));
        this.updateTransform();
      } : value => {
        if (node.bodyType !== BodyType.KINEMATIC) return;
        node.localQuaternion.copy(asQuaternion(value, node.localQuaternion));
        node.group.quaternion.copy(node.localQuaternion);
      },
      setLocalEuler: isRoot ? value => {
        if (this.bodyType !== BodyType.KINEMATIC || !Array.isArray(value) || value.length < 3) return;
        this.quaternion.setFromEuler(new THREE.Euler(
          Number(value[0]) || 0,
          Number(value[1]) || 0,
          Number(value[2]) || 0,
          'YXZ'
        ));
        this.updateTransform();
      } : value => {
        if (node.bodyType !== BodyType.KINEMATIC) return;
        if (!Array.isArray(value) || value.length < 3) return;
        node.localQuaternion.setFromEuler(new THREE.Euler(
          Number(value[0]) || 0,
          Number(value[1]) || 0,
          Number(value[2]) || 0,
          'YXZ'
        ));
        node.group.quaternion.copy(node.localQuaternion);
      },
      setLocalSpin: isRoot ? (axis, rpm) => {
        if (this.bodyType !== BodyType.KINEMATIC) return;
        const safeRpm = Number(rpm);
        const spinAxis = asVector3(axis, new THREE.Vector3(0, 1, 0));
        node.commandedThisFrame = true;
        if (!Number.isFinite(safeRpm) || spinAxis.lengthSq() < 1e-9) {
          node.localAngularVelocity.set(0, 0, 0);
          return;
        }
        node.localAngularVelocity.copy(spinAxis.normalize()).multiplyScalar(safeRpm * Math.PI * 2 / 60);
      } : (axis, rpm) => {
        if (node.bodyType !== BodyType.KINEMATIC) return;
        const safeRpm = Number(rpm);
        const spinAxis = asVector3(axis, new THREE.Vector3(0, 1, 0));
        node.commandedThisFrame = true;
        if (!Number.isFinite(safeRpm) || spinAxis.lengthSq() < 1e-9) {
          node.localAngularVelocity.set(0, 0, 0);
          return;
        }
        node.localAngularVelocity.copy(spinAxis.normalize()).multiplyScalar(safeRpm * Math.PI * 2 / 60);
      },
      getLocalPosition: () => Object.freeze(isRoot ? [0, 0, 0] : node.localPosition.toArray()),
      getLocalRotation: () => Object.freeze(isRoot ? this.quaternion.toArray() : node.localQuaternion.toArray()),
      /**
       * Update the pivot in the same entity-local coordinates as getBounds. Pivots
       * do not follow bounds automatically; setting one shifts the node or entity so
       * blocks keep their world positions. Kinematic bodies support this; dynamic
       * bodies use their physical center of mass.
       */
      setPivot: (value) => {
        this.setComponentPivot(id, value, {
          requireStopped: false,
          allowDynamic: false
        });
      },

      // ---------- C. Legacy root force surface. Component-local arguments are
      // converted to root entity space; self.body targets the component body. ----------
      applyForce: force => {
        if (!Array.isArray(force) || force.length < 3) return;
        // World-space force is identical for every component and applies at COM.
        this.applyForce(force);
      },
      applyLocalForce: force => {
        if (!Array.isArray(force) || force.length < 3) return;
        if (isRoot) {
          this.applyLocalForce(force);
          return;
        }
        // Component-local to root-local using the component's relative rotation.
        const local = new THREE.Vector3(
          Number(force[0]) || 0,
          Number(force[1]) || 0,
          Number(force[2]) || 0
        );
        const worldQuat = this.getEntityNodeWorldQuaternion(id);
        const relQuat = this.quaternion.clone().invert().multiply(worldQuat);
        local.applyQuaternion(relQuat);
        this.applyLocalForce([local.x, local.y, local.z]);
      },
      applyForceAt: (force, localPosition) => {
        if (!Array.isArray(force) || force.length < 3) return;
        if (!Array.isArray(localPosition) || localPosition.length < 3) return;
        if (isRoot) {
          this.applyForceAt(force, localPosition);
          return;
        }
        // Component-local application point through hierarchy to world, then back to root-local.
        const componentPoint = new THREE.Vector3(
          Number(localPosition[0]) + node.pivotLocal.x,
          Number(localPosition[1]) + node.pivotLocal.y,
          Number(localPosition[2]) + node.pivotLocal.z
        );
        const worldPoint = this.entityLocalToWorld(id, componentPoint);
        const rootLocalPoint = this.worldToLocal(worldPoint);
        this.applyForceAt(force, rootLocalPoint.toArray());
      },
      applyTorque: torque => {
        if (!Array.isArray(torque) || torque.length < 3) return;
        // World-space torque is identical for every component.
        this.applyTorque(torque);
      },
      /** Replace this component's driver-seat positions, relative to its pivot. */
      setSeats: values => this.setComponentSeats(id, values),
      /** Stop every script and reset runtime state. Root-only; children are a no-op. */
      stop: isRoot ? () => {
        this.performBasicAction({ action: 'stop-scripts' });
        return true;
      } : noop,
      /** Read this component's seat positions relative to its pivot. */
      getSeats: () => Object.freeze(this.getComponentSeats(id).map(seat => Object.freeze([...seat.position]))),
      /**
       * Find a direct child from any component, with chaining such as
       * ctx.root.child('arm').child('hand').
       */
      child: childId => {
        const targetId = String(childId || '');
        const childNode = node.children.has(targetId) ? this.entityNodes.get(targetId) : null;
        return childNode ? this.getChildScriptApi(targetId) : null;
      }
    };

    // ---------- V2: tree traversal + component-scoped state + explicit namespaces ----------
    api.state = this.getComponentState(id);
    api.children = () => Object.freeze(
      [...node.children]
        .sort(compareComponentIds)
        .map(childId => this.getChildScriptApi(childId))
        .filter(Boolean)
    );
    api.body = Object.freeze({
      getType: () => this.getNodeBodyType(id),
      setType: type => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'set-body-type',
          nodeId: id,
          bodyType: type,
          runtimeOnly: true
        });
        return Object.freeze({ ok: result.ok, type: result.bodyType || this.getNodeBodyType(id), reason: result.reason });
      },
      getMass: () => this.getNodeBodyMass(id),
      setMass: mass => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'set-body-mass',
          nodeId: id,
          mass,
          runtimeOnly: true
        });
        return Object.freeze({ ok: result.ok, mass: result.mass ?? this.getNodeBodyMass(id), reason: result.reason });
      },
      getMaterial: () => this.getNodeBodyMaterial(id),
      setMaterial: material => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'set-body-material',
          nodeId: id,
          material,
          runtimeOnly: true
        });
        return Object.freeze({ ok: result.ok, material: result.material || this.getNodeBodyMaterial(id), reason: result.reason });
      },
      getGravityEnabled: () => this.getNodeGravityEnabled(id),
      setGravityEnabled: enabled => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'set-body-gravity-enabled',
          nodeId: id,
          enabled,
          runtimeOnly: true
        });
        return Object.freeze({
          ok: result.ok,
          enabled: result.enabled ?? this.getNodeGravityEnabled(id),
          reason: result.reason
        });
      },
      getCollisionEnabled: () => this.getNodeCollisionEnabled(id),
      setCollisionEnabled: enabled => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'set-body-collision-enabled',
          nodeId: id,
          enabled,
          runtimeOnly: true
        });
        return Object.freeze({
          ok: result.ok,
          enabled: result.enabled ?? this.getNodeCollisionEnabled(id),
          reason: result.reason
        });
      },
      getVelocity: () => Object.freeze(this.getRigidBody(id)?.velocity.toArray() || [0, 0, 0]),
      getAngularVelocity: () => Object.freeze(this.getRigidBody(id)?.angularVelocity.toArray() || [0, 0, 0]),
      applyForce: force => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'apply-body-force',
          nodeId: id,
          force
        });
        return result.ok;
      },
      applyLocalForce: force => {
        if (!Array.isArray(force) || force.length < 3) return false;
        const worldForce = new THREE.Vector3(
          Number(force[0]) || 0,
          Number(force[1]) || 0,
          Number(force[2]) || 0
        ).applyQuaternion(this.getRigidBody(id)?.quaternion || new THREE.Quaternion());
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'apply-body-force',
          nodeId: id,
          force: worldForce.toArray()
        });
        return result.ok;
      },
      applyTorque: torque => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'apply-body-torque',
          nodeId: id,
          torque
        });
        return result.ok;
      }
    });
    api.constraints = Object.freeze({
      all: () => this.getConstraints(id),
      create: options => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'create-constraint',
          definition: { ...(options || {}), bodyB: id }
        });
        return Object.freeze({ ok: result.ok, id: result.constraint?.id || null, reason: result.reason });
      },
      remove: constraintId => {
        const result = this.performBasicAction({
          domain: ActionDomain.PHYSICS,
          action: 'remove-constraint',
          constraintId
        });
        return result.ok;
      }
    });
    api.voxels = Object.freeze({
      set: (location, options = null) => this.setComponentStandardVoxel(id, node, location, options),
      clear: location => this.clearComponentStandardVoxel(id, node, location),
      paint: (location, options = null) => {
        const cell = this.getComponentStandardCell(node, location);
        if (!cell) return Object.freeze({ ok: false, painted: 0, reason: 'invalid_position' });
        const result = this.performBasicAction({ action: 'paint-standard', nodeId: id, cell, options });
        return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
      },
      clearCell: location => {
        const cell = this.getComponentStandardCell(node, location);
        if (!cell) return scriptEditResult('removed', 0, 'invalid_position');
        const result = this.performBasicAction({ action: 'clear-cell', nodeId: id, cell });
        return scriptEditResult('removed', result.removed || 0, result.reason);
      },
      subdivide: (location, clearOffset = null) => {
        const cell = this.getComponentStandardCell(node, location);
        if (!cell || (clearOffset !== null && !isMicroOffset(clearOffset))) {
          return Object.freeze({ ok: false, subdivided: 0, removed: 0, reason: 'invalid_position' });
        }
        const micro = clearOffset === null ? null : [
          cell.x * 5 + Number(clearOffset[0]),
          cell.y * 5 + Number(clearOffset[1]),
          cell.z * 5 + Number(clearOffset[2])
        ];
        const result = this.performBasicAction({ action: 'subdivide-standard', nodeId: id, cell, micro });
        return Object.freeze({
          ok: result.ok,
          subdivided: result.subdivided || 0,
          removed: result.removed || 0,
          reason: result.reason
        });
      }
    });
    api.microVoxels = Object.freeze({
      set: (location, microOffset, options = null) => (
        this.setComponentMicroVoxel(id, node, location, microOffset, options)
      ),
      clear: (location, microOffset) => this.clearComponentMicroVoxel(id, node, location, microOffset),
      paint: (location, microOffset, options = null) => {
        const cell = this.getComponentStandardCell(node, location);
        if (!cell || !isMicroOffset(microOffset)) {
          return Object.freeze({ ok: false, painted: 0, reason: 'invalid_position' });
        }
        const result = this.performBasicAction({
          action: 'paint-micro',
          nodeId: id,
          micro: [
            cell.x * 5 + Number(microOffset[0]),
            cell.y * 5 + Number(microOffset[1]),
            cell.z * 5 + Number(microOffset[2])
          ],
          options
        });
        return Object.freeze({ ok: result.ok, painted: result.painted || 0, reason: result.reason });
      }
    });
    return Object.freeze(api);
  }

  /** Component API entry point. */
  getChildScriptApi(childId) {
    const id = String(childId || '');
    if (id === this.rootComponentId) return this.scriptApi;
    if (this.childScriptApis.has(id)) return this.childScriptApis.get(id);
    const api = this.getComponentApi(id);
    if (api) this.childScriptApis.set(id, api);
    return api;
  }

  getLocalBlock(lx, ly, lz) {
    // A standard voxel fills its whole 1x1 cell, so the parent cell wins for
    // any point inside it; otherwise fall back to the exact 0.2 micro cell.
    const standardKey = `s:${Math.floor(lx + 1e-6)},${Math.floor(ly + 1e-6)},${Math.floor(lz + 1e-6)}`;
    const standard = this.blockMap.get(standardKey);
    if (standard !== undefined) return standard;
    const microKey = `m:${Math.floor(lx / MICRO_SIZE + 1e-6)},${Math.floor(ly / MICRO_SIZE + 1e-6)},${Math.floor(lz / MICRO_SIZE + 1e-6)}`;
    return this.blockMap.get(microKey) || 0;
  }

  getVelocityAtPoint(worldPos) {
    const r = worldPos.clone().sub(this.position);
    const tangentialVel = this.angularVelocity.clone().cross(r);
    return this.velocity.clone().add(tangentialVel);
  }

  // =========================================================================
  // SCRIPT COMPILATION & EXECUTION (programmable script engine - each component runs its own code)
  // =========================================================================

  setNodeScript(nodeId, code) {
    const id = String(nodeId || this.rootComponentId);
    this.latchedScriptCommands = [];
    this.nodeScripts.set(id, code || '');
    this.nodeScriptErrors.delete(id);
    this.slowScriptFrames.delete(id);

    if (id === this.rootComponentId) {
      this.scriptCode = code || '';
    }

    if (!code || code.trim() === '') {
      this.compiledNodeScripts.delete(id);
      this.scriptRuntimeClient.setScript(id, '');
      if (id === this.rootComponentId) {
        this.compiledScript = null;
        if (this.compiledNodeScripts.size === 0) {
          this.scriptStatus = 'stopped';
        }
      }
      return true;
    }

    const syntaxError = validateEntityScriptSyntax(code);
    if (!syntaxError) {
      const compileResult = this.scriptRuntimeClient.setScript(id, code);
      if (compileResult && compileResult.ok === false) {
        return this.handleWorkerCompileResult(compileResult);
      }
      if (id === this.rootComponentId) {
        this.compiledScript = COMPILED_SCRIPT_SENTINEL;
        this.compiledNodeScripts.set(this.rootComponentId, COMPILED_SCRIPT_SENTINEL);
      } else {
        this.compiledNodeScripts.set(id, COMPILED_SCRIPT_SENTINEL);
      }
      this.scriptStatus = [...this.compiledNodeScripts.keys()]
        .some(nodeId => this.isNodeScriptEnabled(nodeId)) ? 'running' : 'stopped';
      if (this.scriptStatus === 'running') this.setPhysicsSimulationEnabled(true);
      this.latchedScriptCommands = [];
      this.scriptError = null;
      this.log(`[OK] [${id}] Script compiled and loaded successfully!`);
      return true;
    }

    // A failed recompile must not keep the previous version running in either realm.
    this.scriptRuntimeClient.setScript(id, '');
    this.nodeScriptErrors.set(id, syntaxError);
    if (id === this.rootComponentId) {
      this.compiledScript = null;
      this.scriptError = syntaxError;
    }
    this.scriptStatus = 'error';
    this.compiledNodeScripts.delete(id);
    this.log(`[ERR] [${id}] Compile error: ${syntaxError}`);
    return false;
  }

  handleWorkerCompileResult(result) {
    if (!result || result.ok !== false) return true;
    const id = String(result.nodeId || this.rootComponentId);
    const message = result.error || 'QuickJS compile failed';
    this.compiledNodeScripts.delete(id);
    this.nodeScriptErrors.set(id, message);
    if (id === this.rootComponentId) {
      this.compiledScript = null;
      this.scriptError = message;
    }
    this.scriptStatus = 'error';
    this.log(`[ERR] [${id}] Compile error: ${message}`);
    return false;
  }

  getNodeScript(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    if (this.nodeScripts.has(id)) {
      return this.nodeScripts.get(id);
    }
    if (id === this.rootComponentId) {
      return this.scriptCode || '';
    }
    return '';
  }

  setScript(code, nodeId = this.rootComponentId) {
    return this.setNodeScript(nodeId, code);
  }

  isNodeScriptEnabled(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    if (this.nodeScriptEnabled.has(id)) {
      return !!this.nodeScriptEnabled.get(id);
    }
    return true; // Default enabled
  }

  setNodeScriptEnabled(nodeId = this.rootComponentId, enabled = true) {
    const id = String(nodeId || this.rootComponentId);
    const state = !!enabled;
    this.nodeScriptEnabled.set(id, state);
    this.latchedScriptCommands = [];

    if (!state) {
      const node = this.entityNodes.get(id);
      if (node && node.parentId !== null) {
        node.localAngularVelocity.set(0, 0, 0);
      }
    }

    if (state && this.scriptStatus === 'stopped' && (this.compiledScript || this.compiledNodeScripts.size > 0)) {
      this.scriptStatus = 'running';
      this.setPhysicsSimulationEnabled(true);
    }

    this.log(`[SW] [${id}] Code switch: ${state ? 'ON (RUN)' : 'OFF'}`);
    return state;
  }

  enableAllNodeScripts() {
    this.nodeScriptEnabled.set(this.rootComponentId, true);
    for (const id of this.entityNodes.keys()) {
      this.nodeScriptEnabled.set(id, true);
    }
    this.latchedScriptCommands = [];
    this.setPhysicsSimulationEnabled(true);
    if (this.compiledScript || this.compiledNodeScripts.size > 0) {
      this.scriptStatus = 'running';
    }
    this.log(`[ON] All component scripts enabled`);
  }

  disableAllNodeScripts() {
    this.latchedScriptCommands = [];
    this.nodeScriptEnabled.set(this.rootComponentId, false);
    for (const id of this.entityNodes.keys()) {
      this.nodeScriptEnabled.set(id, false);
      const node = this.entityNodes.get(id);
      if (node && node.parentId !== null) {
        node.localAngularVelocity.set(0, 0, 0);
      }
    }
    this.appliedForces.set(0, 0, 0);
    this.appliedTorques.set(0, 0, 0);
    for (const body of this.rigidBodies.values()) {
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
    }
    this.log(`[OFF] All component scripts disabled`);
  }

  /**
   * Reset all component state: clear component-owned state and the script clock,
   * stop child rotations, restore child transforms, and clear pending forces.
   * Script content and component switches are preserved.
   */
  resetAllComponentState() {
    for (const state of this.componentVariables.values()) {
      for (const key of Object.keys(state)) delete state[key];
    }
    for (const node of this.entityNodes.values()) {
      node.localAngularVelocity.set(0, 0, 0);
      node.commandedThisFrame = false;
      if (node.parentId === null) continue;
      node.localPosition.copy(node.initialLocalPosition);
      node.localQuaternion.copy(node.initialLocalQuaternion);
      node.group.position.copy(node.localPosition);
      node.group.quaternion.copy(node.localQuaternion);
    }
    this.rootGroup.updateMatrixWorld(true);
    for (const body of this.rigidBodies.values()) {
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
      if (body.id === this.rootComponentId) continue;
      const node = this.entityNodes.get(body.id);
      if (!node) continue;
      body.position.copy(node.group.localToWorld(body.centerOfMassLocal.clone()));
      body.quaternion.copy(node.group.getWorldQuaternion(new THREE.Quaternion()));
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.previousKinematicPosition.copy(body.position);
      body.previousKinematicQuaternion.copy(body.quaternion);
    }

    this.appliedForces.set(0, 0, 0);
    this.appliedTorques.set(0, 0, 0);
    this.lastAppliedForce.set(0, 0, 0);
    this.lastAppliedTorque.set(0, 0, 0);
    this.scriptRuntime = 0;
    this.tickCount = 0;
    this.latchedScriptCommands = [];
    this.pendingScriptInputDown = [];
    this.pendingScriptInputPressed.clear();
    this.pendingScriptInputReleased.clear();
    this.pendingScriptBlocksEvent = null;
    this.pendingScriptContacts = [];
    this.pendingScriptCommandResults = [];
    this.lastExecutionTimeMs = 0;
    this.slowScriptFrames.clear();
    this.scriptRuntimeClient.reset(this.getSerializableComponentStates());
    this.log('[RESET] All component state reset (state/clock/transforms/forces cleared)');
    return true;
  }

  /** The single implementation used by both the UI Stop button and root self.stop(). */
  stopAllNodeScripts() {
    // Freeze this entity before restoring its construction pose. The manager
    // may already have prepared other entities for the current physics frame;
    // body-level flags ensure this entity cannot receive a late impulse from
    // that frame while its transforms are being reset.
    this.setPhysicsSimulationEnabled(false);
    this.disableAllNodeScripts();
    this.restoreRuntimeBodyConfigDefaults();
    this.resetAllComponentState();
    this.scriptStatus = 'stopped';
    this.setPhysicsSimulationEnabled(false);
    this.log('[STOP] Entity physics disabled; component scripts stopped and runtime BodyConfig restored');
    return true;
  }

  isPhysicsSimulationEnabled() {
    return this.physicsSimulationEnabled !== false;
  }

  /**
   * Enable or disable dynamic simulation without changing authored BodyConfig.
   * Disabled bodies remain in collision/raycast queries as immovable colliders.
   * Re-enabling starts from a clean, current pose so no stopped-time movement
   * becomes a swept collision or an artificial kinematic velocity.
   */
  setPhysicsSimulationEnabled(enabled = true, options: any = {}) {
    const next = !!enabled;
    const resetHistory = options.resetHistory !== false;
    const wakingFromStop = next && this.physicsSimulationEnabled === false && resetHistory;
    if (this.physicsSimulationEnabled !== next) this.physicsWakeVersion++;
    this.physicsSimulationEnabled = next;
    this.rootGroup.updateMatrixWorld(true);

    if (!next || wakingFromStop) {
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this.appliedForces.set(0, 0, 0);
      this.appliedTorques.set(0, 0, 0);
      this.lastAppliedForce.set(0, 0, 0);
      this.lastAppliedTorque.set(0, 0, 0);
    }
    if (!next) this.isOnGround = false;

    if (resetHistory) {
      this.previousPosition.copy(this.position);
      this.previousQuaternion.copy(this.quaternion);
      this.renderSimulationPosition.copy(this.position);
      this.renderSimulationQuaternion.copy(this.quaternion);
      this.renderInterpolated = false;
    }

    for (const node of this.entityNodes.values()) {
      node.commandedThisFrame = false;
      if (!next) node.localAngularVelocity.set(0, 0, 0);
      if (resetHistory) {
        node.previousLocalPosition?.copy(node.localPosition);
        node.previousLocalQuaternion?.copy(node.localQuaternion);
        node.group.updateWorldMatrix(true, false);
        node.previousWorldMatrix = node.group.matrixWorld.clone();
      }
    }

    for (const body of this.rigidBodies.values()) {
      body.simulationEnabled = next;
      if (resetHistory) {
        body.previousKinematicPosition.copy(body.position);
        body.previousKinematicQuaternion.copy(body.quaternion);
      }
      if (!next || wakingFromStop) {
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.appliedForces.set(0, 0, 0);
        body.appliedTorques.set(0, 0, 0);
      }
      if (!next) {
        body.isOnGround = false;
      }
    }
    this.invalidateCollisionPoseCache();
    return next;
  }

  /**
   * Structural edits use authored node-local voxel coordinates. Only Stop
   * restores every child to that construction pose; Individual code switches keep
   * the current runtime pose and therefore is not safe for component/block
   * selection.
   */
  canEditInternalSelection() {
    return this.scriptStatus === 'stopped' && !this.isPhysicsSimulationEnabled();
  }

  /**
   * Move one component's authored pivot without moving any voxel in its
   * subtree. This is the structural/editor form of setPivot: stopped entities
   * may also edit a dynamic body's pivot, while the script surface keeps its
   * existing kinematic-only rule.
   */
  setComponentPivot(nodeId = this.rootComponentId, value, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    const node = this.entityNodes.get(id);
    if (!node) return { ok: false, reason: 'component_not_found' };
    const isRoot = node.parentId === null;
    const definition = isRoot ? null : this.childDefinitions.get(id);
    if (!isRoot && !definition) return { ok: false, reason: 'component_not_found' };
    if (options.requireStopped !== false && !this.canEditInternalSelection()) {
      return { ok: false, reason: 'target_not_stopped' };
    }
    if (options.allowDynamic !== true && node.bodyType !== BodyType.KINEMATIC) {
      return { ok: false, reason: 'dynamic_body' };
    }

    const target = asVector3(value, node.pivotLocal);
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
      return { ok: false, reason: 'invalid_pivot' };
    }
    const previous = node.pivotLocal.clone();
    const delta = target.clone().sub(previous);
    if (delta.lengthSq() < 1e-12) {
      return { ok: true, changed: false, nodeId: id, pivot: previous.toArray() };
    }

    // Moving a parent pivot changes the origin inherited by its direct
    // children. Counter-shift them in the parent's local frame so every
    // descendant remains fixed in world space.
    for (const childId of node.children) {
      const child = this.entityNodes.get(childId);
      if (!child) continue;
      child.localPosition.addScaledVector(delta, -1);
      const childDefinition = this.childDefinitions.get(childId);
      if (childDefinition) childDefinition.localPosition = child.localPosition.toArray();
    }

    if (isRoot) {
      this.rootPivotOverride = target.clone();
      // Root position is world-space; rotate the node-local pivot delta first.
      this.position.add(delta.clone().applyQuaternion(this.quaternion));
    } else {
      definition.pivot = target.toArray();
      // A child origin lives in its parent's frame. Its own authored rotation
      // maps the pivot delta into that parent frame.
      node.localPosition.add(delta.clone().applyQuaternion(node.localQuaternion));
      definition.localPosition = node.localPosition.toArray();
    }

    this.rebuildEntityHierarchy();
    return { ok: true, changed: true, nodeId: id, pivot: target.toArray() };
  }

  /**
   * Serialize the component subtree rooted at rootNodeId, including block ownership,
   * microblocks, colors, child definitions, scripts, and enabled state. The result can
   * be passed directly to ContraptionManager.buildFromSlot to create an independent entity.
   */
  serializeSubtree(rootNodeId = this.rootComponentId) {
    const sourceRootId = String(rootNodeId || this.rootComponentId);
    if (!this.entityNodes.has(sourceRootId)) return null;
    const nodeIds = this.collectSubtreeNodeIds(sourceRootId);
    const rootBodyDefaults = this.getNodeDefaultBodyConfig(sourceRootId);
    const massOverride = normalizeBodyMass(rootBodyDefaults?.mass);

    const blocks = this.blocks
      .filter(b => nodeIds.has(b.entityId || this.rootComponentId))
      .map(b => ({
        localX: b.localX,
        localY: b.localY,
        localZ: b.localZ,
        size: b.size || 1,
        color: b.color,
        block: b.block,
        entityId: b.entityId || this.rootComponentId
      }));

    const childEntities = [...this.childDefinitions.values()]
      .filter(d => nodeIds.has(d.id) && d.id !== sourceRootId)
      .sort((left, right) => compareComponentIds(left.id, right.id))
      .map(d => this.serializeChildDefinition(d));

    const scripts = [...this.nodeScripts.entries()]
      .filter(([id]) => nodeIds.has(id))
      .sort(([left], [right]) => compareComponentIds(left, right))
      .map(([id, code]) => ({ id, code }));

    const enabled = [...this.entityNodes.keys()]
      .filter(id => nodeIds.has(id))
      .sort(compareComponentIds)
      .map(id => ({ id, enabled: this.isNodeScriptEnabled(id) }));
    const constraints = [...this.constraintDefinitions.values()]
      .filter(constraint => nodeIds.has(constraint.bodyB)
        && (constraint.bodyA === null || nodeIds.has(constraint.bodyA)))
      .sort((left, right) => compareIds(left.id, right.id))
      .map(constraint => ({
        ...constraint,
        bodyA: constraint.bodyA,
        bodyB: constraint.bodyB,
        limits: constraint.limits ? { ...constraint.limits } : null
      }));
    const rootPivotOverride = sourceRootId === this.rootComponentId
      ? this.rootPivotOverride?.toArray?.()
      : undefined;

    return {
      name: this.getComponentName(sourceRootId),
      rootComponentId: sourceRootId,
      nodeCount: 1 + childEntities.length,
      blockCount: blocks.length,
      blocks,
      childEntities,
      scripts,
      enabled,
      constraints,
      ...(Array.isArray(rootPivotOverride) ? { rootPivotOverride: [...rootPivotOverride] } : {}),
      anchorRotation: this.entityNodes.get(sourceRootId)?.anchorQuaternion.toArray()
        || new THREE.Quaternion().toArray(),
      bodyType: rootBodyDefaults?.bodyType || this.getNodeBodyType(sourceRootId),
      ...(massOverride !== null ? { mass: massOverride } : {}),
      restitution: rootBodyDefaults?.restitution,
      friction: rootBodyDefaults?.friction,
      useGravity: rootBodyDefaults?.useGravity,
      collisionEnabled: rootBodyDefaults?.collisionEnabled,
      seats: this.getComponentSeats(sourceRootId)
    };
  }

  /**
   * Serialize several independent component subtrees under one explicit root.
   * The root may own no voxels; every selected subtree root becomes its child.
  */
  serializeSubtrees(rootIds) {
    const normalizedRoots: string[] = (rootIds || []).map(id => String(id || '')).filter(Boolean);
    const requestedRoots = [...new Set<string>(normalizedRoots)];
    if (requestedRoots.includes(this.rootComponentId)) return this.serializeSubtree(this.rootComponentId);
    const requestedSet = new Set(requestedRoots);
    const roots = requestedRoots.filter(id => {
      let parentId = this.childDefinitions.get(id)?.parentId;
      while (parentId && parentId !== this.rootComponentId) {
        if (requestedSet.has(parentId)) return false;
        parentId = this.childDefinitions.get(parentId)?.parentId;
      }
      return true;
    });
    if (roots.length === 0) return null;
    if (roots.length === 1) return this.serializeSubtree(roots[0]);

    const nodeIds = new Set<string>();
    for (const id of roots) {
      for (const sub of this.collectSubtreeNodeIds(id)) nodeIds.add(sub);
    }
    const syntheticRootId = uniqueInstalledComponentId('selection', new Set(nodeIds));

    const blocks = this.blocks
      .filter(b => nodeIds.has(b.entityId || this.rootComponentId))
      .map(b => ({
        localX: b.localX,
        localY: b.localY,
        localZ: b.localZ,
        size: b.size || 1,
        color: b.color,
        block: b.block,
        entityId: b.entityId || this.rootComponentId
      }));

    const childEntities = [...this.childDefinitions.values()]
      .filter(d => nodeIds.has(d.id))
      .sort((left, right) => compareIds(left.id, right.id))
      .map(d => this.serializeChildDefinition(
        d,
        roots.includes(d.id) || !nodeIds.has(d.parentId) ? syntheticRootId : d.parentId
      ));

    const scripts = [...this.nodeScripts.entries()]
      .filter(([id]) => nodeIds.has(id))
      .sort(([left], [right]) => compareComponentIds(left, right))
      .map(([id, code]) => ({ id, code }));

    const enabled = [...this.entityNodes.keys()]
      .filter(id => nodeIds.has(id))
      .sort(compareComponentIds)
      .map(id => ({ id, enabled: this.isNodeScriptEnabled(id) }));
    const constraints = [...this.constraintDefinitions.values()]
      .filter(constraint => nodeIds.has(constraint.bodyB)
        && (constraint.bodyA === null || nodeIds.has(constraint.bodyA)))
      .sort((left, right) => compareIds(left.id, right.id))
      .map(constraint => ({ ...constraint, limits: constraint.limits ? { ...constraint.limits } : null }));

    return {
      name: `Entity ${roots.length} components`,
      rootComponentId: syntheticRootId,
      nodeCount: 1 + childEntities.length,
      blockCount: blocks.length,
      blocks,
      childEntities,
      scripts,
      enabled,
      constraints,
      anchorRotation: new THREE.Quaternion().toArray(),
      bodyType: this.getNodeDefaultBodyConfig(this.rootComponentId)?.bodyType || this.bodyType,
      restitution: this.getNodeDefaultBodyConfig(this.rootComponentId)?.restitution ?? this.restitution,
      friction: this.getNodeDefaultBodyConfig(this.rootComponentId)?.friction ?? this.friction,
      useGravity: this.getNodeDefaultBodyConfig(this.rootComponentId)?.useGravity ?? this.useGravity,
      collisionEnabled: this.getNodeDefaultBodyConfig(this.rootComponentId)?.collisionEnabled ?? this.collisionEnabled,
      seats: []
    };
  }

  /** Collect the ids of a node and all descendants. */
  collectSubtreeNodeIds(rootNodeId: string): Set<string> {
    const ids = new Set<string>();
    const walk = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      const nodes = [...this.entityNodes.values()]
        .sort((left, right) => compareComponentIds(left.id, right.id));
      for (const node of nodes) {
        if (node.parentId === id) walk(node.id);
      }
    };
    walk(rootNodeId);
    return ids;
  }

  /**
   * Instantiate an inventory entity as one reusable component subtree inside
   * this entity. The inventory root becomes a rigidly attached kinematic child;
   * its descendants retain their authored bodies, scripts, seats, and internal
   * constraints. The operation validates completely before mutating the tree.
   */
  installEntitySlot(
    slot,
    parentNodeId = this.rootComponentId,
    placementOrigin = new THREE.Vector3(),
    preparedBlocks = null,
    placementRotation = null
  ) {
    const fail = (reason: string) => Object.freeze({ ok: false, reason });
    const parentId = String(parentNodeId || this.rootComponentId);
    const parentNode = this.entityNodes.get(parentId);
    if (!parentNode) return fail('target_component_missing');
    if (!this.canEditInternalSelection()) return fail('target_not_stopped');
    if (!slot || !Array.isArray(slot.blocks) || slot.blocks.length === 0) return fail('empty_entity');
    if ((slot.childEntities !== undefined && !Array.isArray(slot.childEntities))
      || (slot.scripts !== undefined && !Array.isArray(slot.scripts))
      || (slot.enabled !== undefined && !Array.isArray(slot.enabled))
      || (slot.constraints !== undefined && !Array.isArray(slot.constraints))) {
      return fail('invalid_entity_slot');
    }

    const origin = placementOrigin?.isVector3
      ? placementOrigin.clone()
      : new THREE.Vector3(Number(placementOrigin?.x), Number(placementOrigin?.y), Number(placementOrigin?.z));
    if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return fail('invalid_placement');
    const worldRotation = asQuaternion(placementRotation);

    const sourceRootId = String(slot.rootComponentId || '');
    if (!isValidComponentId(sourceRootId)) return fail('invalid_root_component_id');
    const sourceDefinitions = Array.isArray(slot.childEntities) ? slot.childEntities : [];
    const sourceIds = new Set<string>([sourceRootId]);
    const sourceParents = new Map<string, string | null>([[sourceRootId, null]]);
    for (const definition of sourceDefinitions) {
      const id = String(definition?.id || '');
      const sourceParentId = String(definition?.parentId || '');
      if (!isValidComponentId(id) || sourceIds.has(id)) return fail('invalid_component_ids');
      sourceIds.add(id);
      sourceParents.set(id, sourceParentId);
    }
    for (const [id, sourceParentId] of sourceParents) {
      if (id !== sourceRootId && (!sourceIds.has(String(sourceParentId)) || sourceParentId === id)) {
        return fail('invalid_component_hierarchy');
      }
    }

    const sourceDepths = new Map<string, number>([[sourceRootId, 0]]);
    const sourceDepth = (id: string, visiting = new Set<string>()): number => {
      if (sourceDepths.has(id)) return sourceDepths.get(id)!;
      if (visiting.has(id)) return Number.POSITIVE_INFINITY;
      visiting.add(id);
      const sourceParentId = sourceParents.get(id);
      const depth = sourceParentId ? sourceDepth(sourceParentId, visiting) + 1 : 0;
      visiting.delete(id);
      sourceDepths.set(id, depth);
      return depth;
    };
    const maxSourceDepth = Math.max(...[...sourceIds].map(id => sourceDepth(id)));
    let targetDepth = 0;
    let targetAncestor = parentNode;
    const targetAncestors = new Set<string>();
    while (targetAncestor?.parentId) {
      if (targetAncestors.has(targetAncestor.id)) return fail('invalid_target_hierarchy');
      targetAncestors.add(targetAncestor.id);
      targetDepth += 1;
      targetAncestor = this.entityNodes.get(targetAncestor.parentId);
    }
    if (!Number.isFinite(maxSourceDepth)
      || targetDepth + 1 + maxSourceDepth > MAX_ENTITY_HIERARCHY_DEPTH) {
      return fail('hierarchy_too_deep');
    }
    if (this.entityNodes.size + sourceIds.size > MAX_ENTITY_COMPONENTS) return fail('too_many_components');

    const sourceBlocks = (Array.isArray(preparedBlocks) ? preparedBlocks : slot.blocks).map(block => ({
      localX: Number(block?.localX),
      localY: Number(block?.localY),
      localZ: Number(block?.localZ),
      size: Number(block?.size) || 1,
      color: block?.color,
      block: block?.block,
      part: block?.part,
      entityId: String(block?.entityId || '')
    }));
    if (this.blocks.length + sourceBlocks.length > MAX_ENTITY_BLOCKS) return fail('too_many_blocks');
    if (sourceBlocks.some(block => (
      !sourceIds.has(block.entityId)
      || ![block.localX, block.localY, block.localZ, block.size].every(Number.isFinite)
      || block.size <= 0
    ))) return fail('invalid_blocks');

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const sourceBounds = new Map<string, { min: THREE.Vector3; max: THREE.Vector3 }>();
    for (const block of sourceBlocks) {
      minX = Math.min(minX, block.localX); minY = Math.min(minY, block.localY); minZ = Math.min(minZ, block.localZ);
      maxX = Math.max(maxX, block.localX + block.size);
      maxY = Math.max(maxY, block.localY + block.size);
      maxZ = Math.max(maxZ, block.localZ + block.size);
      let bounds = sourceBounds.get(block.entityId);
      if (!bounds) {
        bounds = {
          min: new THREE.Vector3(Infinity, Infinity, Infinity),
          max: new THREE.Vector3(-Infinity, -Infinity, -Infinity)
        };
        sourceBounds.set(block.entityId, bounds);
      }
      bounds.min.set(
        Math.min(bounds.min.x, block.localX),
        Math.min(bounds.min.y, block.localY),
        Math.min(bounds.min.z, block.localZ)
      );
      bounds.max.set(
        Math.max(bounds.max.x, block.localX + block.size),
        Math.max(bounds.max.y, block.localY + block.size),
        Math.max(bounds.max.z, block.localZ + block.size)
      );
    }
    if ([...sourceBounds.values()].some(bounds => (
      bounds.max.x - bounds.min.x > MAX_ENTITY_BOUNDS
      || bounds.max.y - bounds.min.y > MAX_ENTITY_BOUNDS
      || bounds.max.z - bounds.min.z > MAX_ENTITY_BOUNDS
    ))) return fail('component_bounds_too_large');

    const sourceRootPivot = new THREE.Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2
    );
    const desiredRootWorldPosition = origin.clone().add(
      sourceRootPivot.clone().applyQuaternion(worldRotation)
    );
    const installedRootPivot = this.worldToLocal(desiredRootWorldPosition);
    const coordinateOffset = installedRootPivot.clone().sub(sourceRootPivot);

    const reservedIds = new Set(this.entityNodes.keys());
    const idMap = new Map<string, string>();
    const installedRootId = uniqueInstalledComponentId(
      sourceRootId,
      reservedIds
    );
    idMap.set(sourceRootId, installedRootId);
    for (const definition of sourceDefinitions) {
      const sourceId = String(definition.id);
      const preferred = reservedIds.has(sourceId) ? `${installedRootId}_${sourceId}` : sourceId;
      idMap.set(sourceId, uniqueInstalledComponentId(preferred, reservedIds));
    }

    const remappedBlocks = sourceBlocks.map(block => ({
      ...block,
      localX: block.localX + coordinateOffset.x,
      localY: block.localY + coordinateOffset.y,
      localZ: block.localZ + coordinateOffset.z,
      entityId: idMap.get(block.entityId)
    }));
    if (remappedBlocks.some(block => (
      !block.entityId || ![block.localX, block.localY, block.localZ].every(Number.isFinite)
    ))) return fail('invalid_transformed_blocks');

    parentNode.group.updateWorldMatrix(true, false);
    const installedLocalPosition = parentNode.group.worldToLocal(desiredRootWorldPosition.clone());
    const installedLocalRotation = parentNode.group
      .getWorldQuaternion(new THREE.Quaternion())
      .invert()
      .multiply(worldRotation);
    const installedDefinitions = [{
      id: installedRootId,
      name: normalizeInventoryName(slot.name),
      parentId,
      pivot: installedRootPivot.toArray(),
      localPosition: installedLocalPosition.toArray(),
      localRotation: installedLocalRotation.toArray(),
      anchorRotation: asQuaternion(slot.anchorRotation).toArray(),
      bodyType: BodyType.KINEMATIC,
      ...(slot.mass === undefined ? {} : { mass: Number(slot.mass) }),
      restitution: slot.restitution,
      friction: slot.friction,
      useGravity: false,
      collisionEnabled: slot.collisionEnabled !== false,
      seats: cloneScriptData(slot.seats || [], [])
    }];
    for (const definition of sourceDefinitions) {
      const pivot = isFiniteVector3Array(definition.pivot)
        ? new THREE.Vector3().fromArray(definition.pivot).add(coordinateOffset).toArray()
        : installedRootPivot.toArray();
      const installedId = idMap.get(String(definition.id));
      const installedParentId = idMap.get(String(definition.parentId || ''));
      if (!installedId || !installedParentId) return fail('invalid_component_hierarchy');
      const installedDefinition = this.normalizeChildDefinition(
        definition,
        installedId,
        installedParentId
      );
      installedDefinition.pivot = pivot;
      installedDefinitions.push(installedDefinition);
    }

    const changedChildIds = new Map<string, string>();
    for (const [sourceId, installedId] of idMap) {
      if (sourceId !== sourceRootId && sourceId !== installedId) changedChildIds.set(sourceId, installedId);
    }
    const scriptIds = new Set<string>();
    const installedScripts: Array<{ id: string; code: string; enabled: boolean }> = [];
    const enabledById = new Map((slot.enabled || []).map(entry => [String(entry.id || ''), entry.enabled !== false]));
    let addedScriptBytes = 0;
    for (const entry of slot.scripts || []) {
      const sourceId = String(entry?.id || '');
      const installedId = idMap.get(sourceId);
      if (!installedId || scriptIds.has(sourceId) || typeof entry?.code !== 'string') return fail('invalid_scripts');
      const code = remapEntityScriptChildIds(entry.code, changedChildIds);
      if (validateEntityScriptSyntax(code)) return fail('invalid_scripts');
      scriptIds.add(sourceId);
      addedScriptBytes += new TextEncoder().encode(code).byteLength;
      installedScripts.push({ id: installedId, code, enabled: enabledById.get(sourceId) !== false });
    }
    const currentScriptBytes = [...this.nodeScripts.values()]
      .reduce((total, code) => total + new TextEncoder().encode(String(code || '')).byteLength, 0);
    if (currentScriptBytes + addedScriptBytes > MAX_ENTITY_TOTAL_SCRIPT_BYTES) return fail('scripts_too_large');

    const installedConstraints = [];
    let skippedExternalConstraints = 0;
    const reservedConstraintIds = new Set(this.constraintDefinitions.keys());
    for (const source of slot.constraints || []) {
      const bodyA = source?.bodyA === null ? null : String(source?.bodyA || '');
      const bodyB = String(source?.bodyB || '');
      if (bodyA === null) {
        skippedExternalConstraints += 1;
        continue;
      }
      if (!idMap.has(bodyA) || !idMap.has(bodyB) || bodyA === bodyB) return fail('invalid_constraints');
      const preferredId = installedIdCandidate(
        source?.id || `${source?.type || 'point'}_${bodyA}_${bodyB}`,
        'constraint'
      );
      const id = uniqueInstalledConstraintId(preferredId, reservedConstraintIds);
      installedConstraints.push({
        ...cloneScriptData(source, {}),
        id,
        bodyA: idMap.get(bodyA),
        bodyB: idMap.get(bodyB)
      });
    }
    if (this.constraintDefinitions.size + installedConstraints.length > MAX_ENTITY_CONSTRAINTS) {
      return fail('too_many_constraints');
    }

    const previous = {
      blocks: this.blocks,
      childDefinitions: new Map(this.childDefinitions),
      constraintDefinitions: new Map(this.constraintDefinitions),
      nodeScripts: new Map(this.nodeScripts),
      compiledNodeScripts: new Map(this.compiledNodeScripts),
      nodeScriptErrors: new Map(this.nodeScriptErrors),
      nodeScriptEnabled: new Map(this.nodeScriptEnabled),
      componentVariables: new Map(this.componentVariables),
      scriptStatus: this.scriptStatus,
      scriptError: this.scriptError,
      physicsSimulationEnabled: this.physicsSimulationEnabled
    };

    try {
      this.blocks = [...this.blocks, ...remappedBlocks];
      for (const definition of installedDefinitions) {
        this.childDefinitions.set(definition.id, definition);
      }
      this.rebuildAfterBlockChange('install', installedRootId, {
        parentId,
        installedRootId,
        installedComponents: installedDefinitions.length,
        installedBlocks: remappedBlocks.length
      });
      for (const constraint of installedConstraints) {
        if (!this.createConstraint(constraint)) throw new Error('constraint_install_failed');
      }
      for (const script of installedScripts) {
        if (!this.setNodeScript(script.id, script.code)) throw new Error('script_install_failed');
        this.setNodeScriptEnabled(script.id, script.enabled);
      }
      // Structural edits are allowed only while stopped. Installing scripts
      // must not implicitly start the target entity.
      this.stopAllNodeScripts();
      return Object.freeze({
        ok: true,
        rootId: installedRootId,
        parentId,
        componentCount: installedDefinitions.length,
        blockCount: remappedBlocks.length,
        skippedExternalConstraints
      });
    } catch (error) {
      for (const id of idMap.values()) this.scriptRuntimeClient.setScript(id, '');
      this.blocks = previous.blocks;
      this.childDefinitions = previous.childDefinitions;
      this.constraintDefinitions = previous.constraintDefinitions;
      this.nodeScripts = previous.nodeScripts;
      this.compiledNodeScripts = previous.compiledNodeScripts;
      this.nodeScriptErrors = previous.nodeScriptErrors;
      this.nodeScriptEnabled = previous.nodeScriptEnabled;
      this.componentVariables = previous.componentVariables;
      this.scriptStatus = previous.scriptStatus;
      this.scriptError = previous.scriptError;
      this.rebuildAfterBlockChange('change', parentId);
      this.setPhysicsSimulationEnabled(previous.physicsSimulationEnabled);
      for (const [id, code] of this.nodeScripts) this.scriptRuntimeClient.setScript(id, code || '');
      return fail(error instanceof Error ? error.message : 'install_failed');
    }
  }

  /**
   * Remove a child component and every descendant owned by it.
   *
   * The root is owned by ContraptionManager and must be removed there so the
   * scene, physics registry, active controls, and public entity queries are all
   * cleaned up together. This method therefore handles child subtrees only.
   */
  removeComponentSubtree(rootNodeId) {
    const rootId = String(rootNodeId || '');
    const subtreeRoot = this.entityNodes.get(rootId);
    if (!subtreeRoot || subtreeRoot.parentId === null) return null;

    const nodeIds = this.collectSubtreeNodeIds(rootId);
    const removedBlocks = this.blocks.filter(block => nodeIds.has(block.entityId || this.rootComponentId));
    const standard = removedBlocks.filter(block => (block.size || 1) >= 1).length;
    const micro = removedBlocks.length - standard;

    this.clearSubtreeHighlight();
    if (this.selectedNodeId && nodeIds.has(this.selectedNodeId)) this.setHighlightedNode(null);
    if (this.focusedHighlightNodeId && nodeIds.has(this.focusedHighlightNodeId)) this.clearGlueSelection();

    this.blocks = this.blocks.filter(block => !nodeIds.has(block.entityId || this.rootComponentId));
    for (const id of nodeIds) {
      this.scriptRuntimeClient.setScript(id, '');
      this.childDefinitions.delete(id);
      this.nodeScripts.delete(id);
      this.compiledNodeScripts.delete(id);
      this.nodeScriptErrors.delete(id);
      this.nodeScriptEnabled.delete(id);
      this.componentVariables.delete(id);
      this.childScriptApis.delete(id);
      this.runtimeBodyConfigDefaults.delete(id);
    }
    for (const [id, constraint] of this.constraintDefinitions) {
      if (nodeIds.has(constraint.bodyA) || nodeIds.has(constraint.bodyB)) {
        this.constraintDefinitions.delete(id);
      }
    }

    this.rebuildAfterBlockChange('remove', rootId);
    return Object.freeze({
      nodeId: rootId,
      removed: removedBlocks.length,
      standard,
      micro,
      components: nodeIds.size
    });
  }

  /** The authored name; display callers fall back to the id when empty. */
  getComponentName(nodeId = this.rootComponentId): string {
    return nodeId === this.rootComponentId
      ? this.rootComponentName
      : (this.childDefinitions.get(nodeId)?.name || '');
  }

  setComponentName(nodeId: string, name: string): boolean {
    if (!this.entityNodes.has(nodeId) || typeof name !== 'string') return false;
    const normalized = normalizeInventoryName(name);
    if (nodeId === this.rootComponentId) this.rootComponentName = normalized;
    else this.childDefinitions.get(nodeId).name = normalized;
    return true;
  }

  /**
   * Inspector view of one component. The flat fields (bodyType/mass/restitution/
   * friction/useGravity/collisionEnabled) are the persisted defaults — what the
   * Entity Editor's "Defaults" tab edits and Stop restores. `runtimeBody` is the
   * live rigid-body snapshot for the read-only "Runtime" tab.
   */
  getNodeProperties(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    const node = this.entityNodes.get(id);
    if (!node) return null;
    const isRoot = node.parentId === null;
    const blocks = this.blocks.filter(b => (b.entityId || this.rootComponentId) === id);
    const volume = blocks.reduce((sum, b) => sum + Math.pow(b.size || 1, 3), 0);
    this.rootGroup.updateMatrixWorld(true);
    const localPosition = isRoot ? new THREE.Vector3() : node.localPosition.clone();
    // The root node's stored local quaternion is intentionally identity because
    // its live transform belongs to rootGroup. Showing it in the inspector made
    // a rotated root look unrotated, so use the same value exposed by
    // self.getLocalRotation().
    const localQuaternion = isRoot ? this.quaternion.clone() : node.localQuaternion.clone();
    const worldPosition = isRoot
      ? this.position.clone()
      : node.group.getWorldPosition(new THREE.Vector3());
    const worldQuaternion = isRoot
      ? this.quaternion.clone()
      : node.group.getWorldQuaternion(new THREE.Quaternion());
    const localEuler = new THREE.Euler().setFromQuaternion(localQuaternion, 'YXZ');
    const defaults = this.getNodeDefaultBodyConfig(id);
    const liveBody = this.getRigidBody(id);
    const round = (value, digits = 2) => {
      const rounded = Number(Number(value || 0).toFixed(digits));
      return Object.is(rounded, -0) ? 0 : rounded;
    };
    const vector = (value, digits = 2) => value.toArray().map(part => round(part, digits));
    const quaternion = value => value.toArray().map(part => round(part, 4));
    const runtimeBody = liveBody
      ? {
        bodyType: liveBody.type,
        mass: liveBody.mass,
        restitution: liveBody.restitution,
        friction: liveBody.friction,
        useGravity: this.getNodeGravityEnabled(id),
        collisionEnabled: this.getNodeCollisionEnabled(id),
        simulationEnabled: liveBody.simulationEnabled !== false,
        isOnGround: !!liveBody.isOnGround,
        position: vector(liveBody.position),
        quaternion: quaternion(liveBody.quaternion),
        centerOfMassLocal: vector(liveBody.centerOfMassLocal),
        velocity: vector(liveBody.velocity),
        angularVelocity: vector(liveBody.angularVelocity),
        speed: round(liveBody.velocity.length()),
        angularSpeed: round(liveBody.angularVelocity.length()),
        rpm: round(liveBody.angularVelocity.length() * 60 / (Math.PI * 2), 1)
      }
      : null;

    return {
      id: node.id,
      name: this.getComponentName(id),
      parentId: node.parentId,
      kind: node.parentId === null ? 'root' : 'child',
      bodyType: defaults?.bodyType || this.getNodeBodyType(id),
      mass: normalizeBodyMass(defaults?.mass) ?? defaultBodyMass(blocks),
      restitution: defaults?.restitution ?? this.restitution,
      friction: defaults?.friction ?? this.friction,
      useGravity: defaults?.useGravity ?? true,
      collisionEnabled: defaults?.collisionEnabled ?? true,
      runtimeBody,
      constraintCount: this.getConstraints(id).length,
      blockCount: blocks.length,
      volume: Number(volume.toFixed(2)),
      pivot: vector(node.pivotLocal),
      anchorQuaternion: quaternion(node.anchorQuaternion),
      restLocalPosition: isRoot ? null : vector(node.initialLocalPosition || node.localPosition),
      restLocalQuaternion: isRoot ? null : quaternion(node.initialLocalQuaternion || node.localQuaternion),
      localPosition: vector(localPosition),
      localQuaternion: quaternion(localQuaternion),
      worldPosition: vector(worldPosition),
      worldQuaternion: quaternion(worldQuaternion),
      localEuler: [
        round(localEuler.x * 180 / Math.PI, 1),
        round(localEuler.y * 180 / Math.PI, 1),
        round(localEuler.z * 180 / Math.PI, 1)
      ],
      rpm: round(node.localAngularVelocity.length() * 60 / (Math.PI * 2), 1),
      hasScript: !!(this.getNodeScript(id) && this.getNodeScript(id).trim().length > 0),
      isScriptEnabled: this.isNodeScriptEnabled(id),
      scriptError: this.nodeScriptErrors.get(id) || (isRoot ? this.scriptError : null) || null,
      stateKeyCount: Object.keys(this.getComponentState(id)).length
    };
  }

  /** Rename a globally unique non-root component id. */
  renameChildEntity(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return false;
    const cleanNewId = String(newId).trim();
    if (!isValidComponentId(cleanNewId)
      || this.entityNodes.has(cleanNewId)
      || this.childDefinitions.has(cleanNewId)) return false;

    const node = this.entityNodes.get(oldId);
    const def = this.childDefinitions.get(oldId);
    if (!node || node.parentId === null) return false;

    // Update blocks
    for (const block of this.blocks) {
      if (block.entityId === oldId) block.entityId = cleanNewId;
    }

    // Update child definition
    if (def) {
      this.childDefinitions.delete(oldId);
      def.id = cleanNewId;
      this.childDefinitions.set(cleanNewId, def);
    }

    // Update scripts
    if (this.nodeScripts.has(oldId)) {
      const s = this.nodeScripts.get(oldId);
      this.nodeScripts.delete(oldId);
      this.nodeScripts.set(cleanNewId, s);
      this.scriptRuntimeClient.setScript(oldId, '');
      this.scriptRuntimeClient.setScript(cleanNewId, s || '');
    }
    if (this.compiledNodeScripts.has(oldId)) {
      const c = this.compiledNodeScripts.get(oldId);
      this.compiledNodeScripts.delete(oldId);
      this.compiledNodeScripts.set(cleanNewId, c);
    }
    if (this.nodeScriptEnabled.has(oldId)) {
      const en = this.nodeScriptEnabled.get(oldId);
      this.nodeScriptEnabled.delete(oldId);
      this.nodeScriptEnabled.set(cleanNewId, en);
    }
    if (this.componentVariables.has(oldId)) {
      const state = this.componentVariables.get(oldId);
      this.componentVariables.delete(oldId);
      this.componentVariables.set(cleanNewId, state);
    }
    if (this.runtimeBodyConfigDefaults.has(oldId)) {
      const defaults = this.runtimeBodyConfigDefaults.get(oldId);
      this.runtimeBodyConfigDefaults.delete(oldId);
      this.runtimeBodyConfigDefaults.set(cleanNewId, defaults);
    }

    // Update children's parentId
    for (const childDef of this.childDefinitions.values()) {
      if (childDef.parentId === oldId) childDef.parentId = cleanNewId;
    }
    for (const constraint of this.constraintDefinitions.values()) {
      if (constraint.bodyA === oldId) constraint.bodyA = cleanNewId;
      if (constraint.bodyB === oldId) constraint.bodyB = cleanNewId;
    }

    this.rebuildEntityHierarchy();
    if (this.selectedNodeId === oldId) {
      this.selectedNodeId = cleanNewId;
      this.setHighlightedNode(cleanNewId);
    }
    return true;
  }

  restartScript() {
    if (this.scriptCode) {
      this.setScript(this.scriptCode);
    }
  }

  log(message) {
    const timeStr = (this.scriptRuntime || 0).toFixed(2);
    this.scriptLogs.push(`[${timeStr}s] ${message}`);
    if (this.scriptLogs.length > 40) {
      this.scriptLogs.shift();
    }
  }

  // =========================================================================
  // PROGRAMMABLE FORCES API (force interface exposed to scripts)
  // =========================================================================

  /**
   * Apply a force in World Coordinates (Newtons)
   */
  applyForce(forceVec) {
    if (this.bodyType !== BodyType.DYNAMIC) return;
    const force = boundedBodyVector(forceVec);
    if (!force) return;
    this.appliedForces.add(force);
    this.clampControlOutput();
  }

  /**
   * Apply a force in Entity Local Coordinates (Newtons)
   * Local axes: +X Right, +Y Up, -Z Forward (head of ship)
   */
  applyLocalForce(localForceVec) {
    if (this.bodyType !== BodyType.DYNAMIC) return;
    const local = boundedBodyVector(localForceVec);
    if (!local) return;
    // Rotate to world coordinates
    local.applyQuaternion(this.quaternion);
    this.appliedForces.add(local);
    this.clampControlOutput();
  }

  /**
   * Apply a world-space force at an entity-local point. The off-center force
   * produces torque using tau = r x F, so translation and rotation share one
   * physically meaningful primitive.
   */
  applyForceAt(forceVec, localPosition) {
    if (this.bodyType !== BodyType.DYNAMIC) return;
    const force = boundedBodyVector(forceVec);
    const localPoint = boundedBodyVector(localPosition);
    if (!force || !localPoint) return;
    const worldLever = localPoint.sub(this.localCenter).applyQuaternion(this.quaternion);

    this.appliedForces.add(force);
    this.appliedTorques.add(worldLever.cross(force));
    this.clampControlOutput();
  }

  /**
   * Apply rotational Torque (N*m)
   * [torqueX (Pitch), torqueY (Yaw), torqueZ (Roll)]
   */
  applyTorque(torqueVec) {
    if (this.bodyType !== BodyType.DYNAMIC) return;
    const torque = boundedBodyVector(torqueVec);
    if (!torque) return;
    this.appliedTorques.add(torque);
    this.clampControlOutput();
  }

  clampControlOutput() {
    const forceLength = this.appliedForces.length();
    if (!Number.isFinite(forceLength)) {
      this.appliedForces.set(0, 0, 0);
    }
    else if (forceLength > this.maxForce) {
      this.appliedForces.multiplyScalar(this.maxForce / forceLength);
    }

    const torqueLength = this.appliedTorques.length();
    if (!Number.isFinite(torqueLength)) {
      this.appliedTorques.set(0, 0, 0);
    }
    else if (torqueLength > this.maxTorque) {
      this.appliedTorques.multiplyScalar(this.maxTorque / torqueLength);
    }

    this.powerUtilization = Math.max(
      this.appliedForces.length() / this.maxForce,
      this.appliedTorques.length() / this.maxTorque
    );
  }

  // =========================================================================
  // BOUNDS & MESH GENERATION
  // =========================================================================

  buildCollisionCells() {
    this.blockMap = new Map();
    const cells = new Map();
    const entries = new Map();
    for (const block of this.blocks) {
      const size = block.size || 1;
      const span = Math.max(1, Math.round(size / MICRO_SIZE));
      const x = Math.floor(block.localX / MICRO_SIZE + 1e-6);
      const y = Math.floor(block.localY / MICRO_SIZE + 1e-6);
      const z = Math.floor(block.localZ / MICRO_SIZE + 1e-6);
      const entityId = block.entityId || this.rootComponentId;
      // Whole voxels fill their 1x1 cell, micro voxels only their 0.2 cell.
      const cellKey = span > 1
        ? `s:${Math.floor(x / MICRO_DIVISIONS)},${Math.floor(y / MICRO_DIVISIONS)},${Math.floor(z / MICRO_DIVISIONS)}`
        : `m:${x},${y},${z}`;
      this.blockMap.set(cellKey, block.block);
      const boxKey = `${x},${y},${z}:${span}`;
      if (!cells.has(boxKey)) cells.set(boxKey, { x, y, z, span });
      const entryKey = `${entityId}:${boxKey}`;
      if (!entries.has(entryKey)) entries.set(entryKey, { x, y, z, span, entityId });
    }
    this.collisionCells = [...cells.values()];
    this.collisionEntries = [...entries.values()];
    // A voxel completely enclosed by six same-resolution neighbours cannot
    // reach an exterior terrain contact. Keeping a conservative surface set
    // avoids thousands of invisible terrain boxes in solid imported
    // structures. Entity/player narrow phase still uses the complete set so a
    // direct editor teleport into a solid can recover from deep penetration.
    const entryKeys = new Set(this.collisionEntries.map(entry => (
      `${entry.entityId}:${entry.x},${entry.y},${entry.z}:${entry.span}`
    )));
    this.collisionSurfaceEntries = this.collisionEntries.filter(entry => {
      const { entityId, x, y, z, span } = entry;
      return ![
        [x - span, y, z], [x + span, y, z],
        [x, y - span, z], [x, y + span, z],
        [x, y, z - span], [x, y, z + span]
      ].every(([nx, ny, nz]) => entryKeys.has(`${entityId}:${nx},${ny},${nz}:${span}`));
    });
    this.collisionPhysicsBoxes = mergeCollisionCells(this.collisionEntries);
    // Bound terrain-query volumes on rotated, large solid structures. Keep the
    // original surface probes for support manifolds and swept terrain contacts.
    this.collisionTerrainBoxes = mergeCollisionCells(this.collisionSurfaceEntries, 20);
    this.collisionCellCount = this.collisionCells.length;
    this.invalidateCollisionPoseCache?.();
  }

  calculateBoundsAndCenter() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const cell of this.collisionCells) {
      const x0 = cell.x * MICRO_SIZE, x1 = (cell.x + cell.span) * MICRO_SIZE;
      const y0 = cell.y * MICRO_SIZE, y1 = (cell.y + cell.span) * MICRO_SIZE;
      const z0 = cell.z * MICRO_SIZE, z1 = (cell.z + cell.span) * MICRO_SIZE;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (z0 < minZ) minZ = z0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
      if (z1 > maxZ) maxZ = z1;
    }

    if (!Number.isFinite(minX)) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 1;
    }

    this.minLocal = new THREE.Vector3(minX, minY, minZ);
    this.maxLocal = new THREE.Vector3(maxX, maxY, maxZ);
    this.size = new THREE.Vector3(
      this.maxLocal.x - this.minLocal.x,
      this.maxLocal.y - this.minLocal.y,
      this.maxLocal.z - this.minLocal.z
    );

    // Initial center offset from origin
    if (!this.localCenter) {
      this.localCenter = new THREE.Vector3(
        (this.minLocal.x + this.maxLocal.x) / 2,
        (this.minLocal.y + this.maxLocal.y) / 2,
        (this.minLocal.z + this.maxLocal.z) / 2
      );
    }

    this.boundingRadius = this.size.length() / 2;
  }

  getWorldCenter(): THREE.Vector3 {
    if (this.localCenter) {
      return this.localToWorld(this.localCenter.clone());
    }
    return this.position.clone();
  }

  initializeEntityHierarchy(childEntities = []) {
    const definitions = Array.isArray(childEntities)
      ? childEntities
        .slice(0, MAX_ENTITY_COMPONENTS - 1)
        .sort((left, right) => compareComponentIds(left?.id, right?.id))
      : [];
    for (const definition of definitions) {
      const id = typeof definition?.id === 'string' ? definition.id : '';
      if (!isValidComponentId(id) || id === this.rootComponentId || this.childDefinitions.has(id)) continue;
      const requestedParent = String(definition.parentId || this.rootComponentId);
      const parentId = isValidComponentId(requestedParent) && requestedParent !== id
        ? requestedParent
        : this.rootComponentId;
      this.childDefinitions.set(id, this.normalizeChildDefinition(definition, id, parentId));

      // blockKeys is a constructor-only ownership selector, not runtime or
      // serialized component metadata.
      if (!Array.isArray(definition.blockKeys)) continue;
      const ownedCells = new Set(definition.blockKeys.map(key => Array.isArray(key) ? key.join(',') : String(key)));
      for (const block of this.blocks) {
        if (ownedCells.has(collisionCellKey(block))) block.entityId = id;
      }
    }

    this.rebuildEntityHierarchy();
  }

  disposeGroupChildren(group) {
    if (!group) return;
    group.traverse(child => {
      if (child === group) return;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
        else child.material.dispose();
      }
    });
    group.clear();
  }

  rebuildEntityHierarchy() {
    const previousBodies = this.rigidBodies || new Map();
    const previousState = new Map();
    for (const [id, node] of this.entityNodes || []) {
      previousState.set(id, {
        localPosition: node.localPosition?.clone(),
        localQuaternion: node.localQuaternion?.clone(),
        localAngularVelocity: node.localAngularVelocity?.clone()
      });
    }

    this.disposeGroupChildren(this.meshGroup);
    this.entityNodes = new Map();
    this.childScriptApis.clear();

    const rootNode = {
      id: this.rootComponentId,
      parentId: null,
      // Rotation center defaults to entity-local COM; kinematic-root scripts may override it with setPivot.
      pivotLocal: (this.rootPivotOverride || this.localCenter).clone(),
      localPosition: new THREE.Vector3(),
      localQuaternion: new THREE.Quaternion(),
      anchorQuaternion: this.rootAnchorQuaternion.clone(),
      localAngularVelocity: new THREE.Vector3(),
      commandedThisFrame: false,
      initialLocalPosition: new THREE.Vector3(),
      initialLocalQuaternion: new THREE.Quaternion(),
      previousLocalPosition: new THREE.Vector3(),
      previousLocalQuaternion: new THREE.Quaternion(),
      group: this.meshGroup,
      children: new Set<string>(),
      bodyType: this.bodyType
    };
    this.entityNodes.set(this.rootComponentId, rootNode);

    const pending = [...this.childDefinitions.values()]
      .sort((left, right) => compareComponentIds(left.id, right.id));
    let guard = pending.length + 1;
    while (pending.length > 0 && guard-- > 0) {
      let progressed = false;
      for (let index = 0; index < pending.length;) {
        const definition = pending[index];
        const parent = this.entityNodes.get(definition.parentId || this.rootComponentId);
        if (!parent) {
          index += 1;
          continue;
        }

        const pivotLocal = asVector3(definition.pivot, this.localCenter);
        const defaultPosition = pivotLocal.clone().sub(parent.pivotLocal);
        const authoredLocalPosition = asVector3(definition.localPosition, defaultPosition);
        const authoredLocalQuaternion = asQuaternion(definition.localRotation);
        const saved = previousState.get(definition.id);
        const localPosition = saved?.localPosition
          || authoredLocalPosition.clone();
        const localQuaternion = saved?.localQuaternion
          || authoredLocalQuaternion.clone();
        const anchorQuaternion = asQuaternion(definition.anchorRotation);
        const group = new THREE.Group();
        group.name = `Entity_${definition.id}`;
        group.position.copy(localPosition);
        group.quaternion.copy(localQuaternion);
        parent.group.add(group);

        const node = {
          id: definition.id,
          parentId: parent.id,
          pivotLocal,
          localPosition,
          localQuaternion,
          anchorQuaternion,
          localAngularVelocity: saved?.localAngularVelocity || new THREE.Vector3(),
          commandedThisFrame: false,
          // Live rebuilds preserve the current animated pose, but Stop must
          // always return to the authored, grid-aligned construction pose.
          initialLocalPosition: authoredLocalPosition.clone(),
          initialLocalQuaternion: authoredLocalQuaternion.clone(),
          previousLocalPosition: localPosition.clone(),
          previousLocalQuaternion: localQuaternion.clone(),
          group,
          children: new Set<string>(),
          bodyType: normalizeBodyType(definition.bodyType, BodyType.KINEMATIC)
        };
        this.entityNodes.set(node.id, node);
        parent.children.add(node.id);
        pending.splice(index, 1);
        progressed = true;
      }
      if (!progressed) break;
    }

    // Invalid or cyclic parents fall back to root instead of making their
    // blocks disappear. The editor never creates cycles, but imported data
    // should remain inspectable.
    for (const definition of pending) {
      definition.parentId = this.rootComponentId;
      const pivotLocal = asVector3(definition.pivot, this.localCenter);
      const group = new THREE.Group();
      group.name = `Entity_${definition.id}`;
      group.position.copy(pivotLocal).sub(this.localCenter);
      this.meshGroup.add(group);
      const node = {
        id: definition.id,
        parentId: this.rootComponentId,
        pivotLocal,
        localPosition: group.position.clone(),
        localQuaternion: new THREE.Quaternion(),
        anchorQuaternion: asQuaternion(definition.anchorRotation),
        localAngularVelocity: new THREE.Vector3(),
        initialLocalPosition: group.position.clone(),
        initialLocalQuaternion: new THREE.Quaternion(),
        previousLocalPosition: group.position.clone(),
        previousLocalQuaternion: group.quaternion.clone(),
        group,
        children: new Set<string>(),
        bodyType: normalizeBodyType(definition.bodyType, BodyType.KINEMATIC)
      };
      this.entityNodes.set(node.id, node);
      rootNode.children.add(node.id);
    }

    for (const node of this.entityNodes.values()) {
      const nodeBlocks = this.blocks.filter(block => (block.entityId || this.rootComponentId) === node.id);
      this.createVoxelMesh(nodeBlocks, node.pivotLocal, node.group);
    }

    this.buildCollisionCells();
    this.updateTransform();
    this.rebuildRigidBodies(previousBodies);
    for (const node of this.entityNodes.values()) {
      node.group.updateWorldMatrix(true, false);
      node.previousWorldMatrix = node.group.matrixWorld.clone();
    }
    // Refresh the root self API after rebuilding nodes because old node closures are stale.
    this.scriptApi = this.getComponentApi(this.rootComponentId);
  }

  rebuildRigidBodies(previousBodies = new Map()) {
    const nextBodies = new Map();
    this.rootGroup.updateMatrixWorld(true);

    for (const node of this.entityNodes.values()) {
      const previous = previousBodies.get(node.id);
      const isRoot = node.parentId === null;
      const definition = isRoot ? null : this.childDefinitions.get(node.id);
      const ownedBlocks = this.blocks.filter(block => (block.entityId || this.rootComponentId) === node.id);
      let volume = 0;
      const weightedCenter = new THREE.Vector3();
      let maxRadiusSq = 0;
      for (const block of ownedBlocks) {
        const size = block.size || 1;
        const blockVolume = Math.pow(size, 3);
        const center = new THREE.Vector3(
          block.localX + size / 2,
          block.localY + size / 2,
          block.localZ + size / 2
        );
        weightedCenter.addScaledVector(center, blockVolume);
        volume += blockVolume;
      }
      const centerEntity = volume > 0
        ? weightedCenter.divideScalar(volume)
        : node.pivotLocal.clone();
      const centerOfMassLocal = isRoot
        ? new THREE.Vector3()
        : centerEntity.sub(node.pivotLocal);
      for (const block of ownedBlocks) {
        const size = block.size || 1;
        const localCenter = new THREE.Vector3(
          block.localX + size / 2,
          block.localY + size / 2,
          block.localZ + size / 2
        ).sub(node.pivotLocal).sub(centerOfMassLocal);
        maxRadiusSq = Math.max(maxRadiusSq, localCenter.lengthSq() + size * size * 0.75);
      }

      const type = isRoot
        ? this.bodyType
        : normalizeBodyType(definition?.bodyType, BodyType.KINEMATIC);
      node.bodyType = type;
      node.group.updateWorldMatrix(true, false);
      const authoredPosition = isRoot
        ? this.position
        : node.group.localToWorld(centerOfMassLocal.clone());
      const authoredQuaternion = isRoot
        ? this.quaternion
        : node.group.getWorldQuaternion(new THREE.Quaternion());
      const configuredMass = isRoot
        ? this.massOverride
        : normalizeBodyMass(definition?.mass);
      const mass = configuredMass ?? defaultBodyMass(ownedBlocks);
      const inertia = mass * Math.max(0.5, maxRadiusSq * 0.4);

      const body: EntityRigidBody = {
        id: node.id,
        nodeId: node.id,
        type,
        position: isRoot
          ? this.position
          : (previous?.type === BodyType.DYNAMIC ? previous.position.clone() : authoredPosition.clone()),
        quaternion: isRoot
          ? this.quaternion
          : (previous?.type === BodyType.DYNAMIC ? previous.quaternion.clone() : authoredQuaternion.clone()),
        velocity: isRoot ? this.velocity : (previous?.velocity?.clone() || new THREE.Vector3()),
        angularVelocity: isRoot
          ? this.angularVelocity
          : (previous?.angularVelocity?.clone() || new THREE.Vector3()),
        appliedForces: isRoot
          ? this.appliedForces
          : (previous?.appliedForces?.clone() || new THREE.Vector3()),
        appliedTorques: isRoot
          ? this.appliedTorques
          : (previous?.appliedTorques?.clone() || new THREE.Vector3()),
        mass,
        inverseInertia: inertia > 1e-9 ? 1 / inertia : 0,
        restitution: isRoot
          ? this.restitution
          : clampUnit(definition?.restitution, this.restitution),
        friction: isRoot
          ? this.friction
          : clampUnit(definition?.friction, this.friction),
        linearDamping: isRoot ? this.linearDamping : 0.98,
        angularDamping: isRoot ? this.angularDamping : 0.92,
        centerOfMassLocal,
        previousKinematicPosition: previous?.previousKinematicPosition?.clone() || authoredPosition.clone(),
        previousKinematicQuaternion: previous?.previousKinematicQuaternion?.clone() || authoredQuaternion.clone(),
        isOnGround: previous?.isOnGround || false,
        simulationEnabled: this.physicsSimulationEnabled !== false
      };
      nextBodies.set(node.id, body);
    }

    this.rigidBodies = nextBodies;
    const rootBody = this.rigidBodies.get(this.rootComponentId);
    if (rootBody) {
      this.mass = rootBody.mass;
      this.maxForce = Math.max(80, this.mass * 65);
      this.maxTorque = Math.max(40, this.maxForce * Math.max(0.75, this.boundingRadius));
    }
    for (const body of this.rigidBodies.values()) {
      if (body.id !== this.rootComponentId && body.type === BodyType.DYNAMIC) this.syncBodyToNode(body);
    }

    // Imported or edited hierarchies can drop a body while retaining an old
    // joint definition. Keep the solver input self-consistent after every
    // hierarchy rebuild instead of leaving a permanently dangling constraint.
    for (const [id, constraint] of this.constraintDefinitions) {
      const hasBodyA = constraint.bodyA === null || this.rigidBodies.has(constraint.bodyA);
      const hasBodyB = this.rigidBodies.has(constraint.bodyB);
      if (!hasBodyA || !hasBodyB) this.constraintDefinitions.delete(id);
    }
  }

  getRigidBody(nodeId = this.rootComponentId) {
    return this.rigidBodies.get(String(nodeId || this.rootComponentId)) || null;
  }

  getRigidBodies() {
    return [...this.rigidBodies.values()];
  }

  /** Current authored/runtime BodyConfig. A snapshot of this value becomes the
   * PB default the first time a script mutates one of its fields. */
  getCurrentNodeBodyConfig(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    const body = this.getRigidBody(id);
    if (!body) return null;
    const isRoot = this.entityNodes.get(id)?.parentId === null;
    const definition = isRoot ? null : this.childDefinitions.get(id);
    return {
      bodyType: body.type,
      mass: isRoot ? this.massOverride : normalizeBodyMass(definition?.mass),
      restitution: body.restitution,
      friction: body.friction,
      useGravity: isRoot ? this.useGravity : definition?.useGravity !== false,
      collisionEnabled: isRoot ? this.collisionEnabled : definition?.collisionEnabled !== false
    };
  }

  getNodeDefaultBodyConfig(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    const source = this.runtimeBodyConfigDefaults.get(id) || this.getCurrentNodeBodyConfig(id);
    return source ? { ...source } : null;
  }

  captureRuntimeBodyConfigDefault(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    if (!this.runtimeBodyConfigDefaults.has(id)) {
      const current = this.getCurrentNodeBodyConfig(id);
      if (current) this.runtimeBodyConfigDefaults.set(id, current);
    }
  }

  updateCapturedBodyConfigDefault(nodeId, patch) {
    const saved = this.runtimeBodyConfigDefaults.get(String(nodeId || this.rootComponentId));
    if (saved) Object.assign(saved, patch);
  }

  getNodeBodyType(nodeId = this.rootComponentId) {
    return this.getRigidBody(nodeId)?.type || null;
  }

  setNodeBodyType(nodeId, value, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    const body = this.getRigidBody(id);
    const type = normalizeBodyType(value, null);
    if (!body || !type) return false;
    if (options.runtimeOnly) {
      if (options.captureDefault !== false) this.captureRuntimeBodyConfigDefault(id);
    } else {
      this.updateCapturedBodyConfigDefault(id, { bodyType: type });
    }
    if (body.type === type) return true;

    if (body.id !== this.rootComponentId && body.type === BodyType.KINEMATIC && type === BodyType.DYNAMIC) {
      const node = this.entityNodes.get(id);
      node?.group?.updateWorldMatrix(true, false);
      if (node?.group) {
        body.position.copy(node.group.localToWorld(body.centerOfMassLocal.clone()));
        body.quaternion.copy(node.group.getWorldQuaternion(new THREE.Quaternion()));
      }
    }
    body.type = type;
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.appliedForces.set(0, 0, 0);
    body.appliedTorques.set(0, 0, 0);
    body.previousKinematicPosition.copy(body.position);
    body.previousKinematicQuaternion.copy(body.quaternion);
    const node = this.entityNodes.get(id);
    if (node) node.bodyType = type;
    if (id === this.rootComponentId) {
      this.bodyType = type;
    } else {
      const definition = this.childDefinitions.get(id);
      if (definition) definition.bodyType = type;
    }
    return true;
  }

  setBodyType(value) {
    return this.setNodeBodyType(this.rootComponentId, value) ? this.bodyType : null;
  }

  getNodeBodyMass(nodeId = this.rootComponentId) {
    return this.getRigidBody(nodeId)?.mass ?? null;
  }

  setNodeBodyMass(nodeId, value, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    const body = this.getRigidBody(id);
    const mass = normalizeBodyMass(value);
    if (!body || mass === null) return null;
    if (options.runtimeOnly) {
      if (options.captureDefault !== false) this.captureRuntimeBodyConfigDefault(id);
    } else {
      this.updateCapturedBodyConfigDefault(id, { mass });
    }

    const previousMass = body.mass;
    body.mass = mass;
    if (body.inverseInertia > 0 && previousMass > 0) {
      // Shape is unchanged, so inertia scales linearly with mass.
      body.inverseInertia *= previousMass / mass;
    }

    if (id === this.rootComponentId) {
      this.massOverride = mass;
      this.mass = mass;
      this.maxForce = Math.max(80, this.mass * 65);
      this.maxTorque = Math.max(40, this.maxForce * Math.max(0.75, this.boundingRadius));
    } else {
      const definition = this.childDefinitions.get(id);
      if (definition) definition.mass = mass;
    }
    return mass;
  }

  getNodeBodyMaterial(nodeId = this.rootComponentId) {
    const body = this.getRigidBody(nodeId);
    return body ? Object.freeze({ restitution: body.restitution, friction: body.friction }) : null;
  }

  setNodeBodyMaterial(nodeId, material: any = {}, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    const body = this.getRigidBody(id);
    if (!body) return null;
    if (options.runtimeOnly) {
      if (options.captureDefault !== false) this.captureRuntimeBodyConfigDefault(id);
    } else {
      const defaults: any = {};
      if (material.restitution !== undefined) defaults.restitution = clampUnit(material.restitution, body.restitution);
      if (material.friction !== undefined) defaults.friction = clampUnit(material.friction, body.friction);
      this.updateCapturedBodyConfigDefault(id, defaults);
    }
    if (material.restitution !== undefined) body.restitution = clampUnit(material.restitution, body.restitution);
    if (material.friction !== undefined) body.friction = clampUnit(material.friction, body.friction);
    if (id === this.rootComponentId) {
      this.restitution = body.restitution;
      this.friction = body.friction;
    } else {
      const definition = this.childDefinitions.get(id);
      if (definition) {
        definition.restitution = body.restitution;
        definition.friction = body.friction;
      }
    }
    return this.getNodeBodyMaterial(id);
  }

  getNodeGravityEnabled(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    if (!this.getRigidBody(id)) return null;
    return id === this.rootComponentId
      ? this.useGravity
      : this.childDefinitions.get(id)?.useGravity !== false;
  }

  setNodeGravityEnabled(nodeId, enabled, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    if (!this.getRigidBody(id) || typeof enabled !== 'boolean') return null;
    if (options.runtimeOnly) {
      if (options.captureDefault !== false) this.captureRuntimeBodyConfigDefault(id);
    } else {
      this.updateCapturedBodyConfigDefault(id, { useGravity: enabled });
    }
    if (id === this.rootComponentId) this.useGravity = enabled;
    else {
      const definition = this.childDefinitions.get(id);
      if (!definition) return null;
      definition.useGravity = enabled;
    }
    return enabled;
  }

  getNodeCollisionEnabled(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    if (!this.getRigidBody(id)) return null;
    return id === this.rootComponentId
      ? this.collisionEnabled
      : this.childDefinitions.get(id)?.collisionEnabled !== false;
  }

  setNodeCollisionEnabled(nodeId, enabled, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    if (!this.getRigidBody(id) || typeof enabled !== 'boolean') return null;
    if (options.runtimeOnly) {
      if (options.captureDefault !== false) this.captureRuntimeBodyConfigDefault(id);
    } else {
      this.updateCapturedBodyConfigDefault(id, { collisionEnabled: enabled });
    }
    const previous = this.getNodeCollisionEnabled(id);
    if (id === this.rootComponentId) this.collisionEnabled = enabled;
    else {
      const definition = this.childDefinitions.get(id);
      if (!definition) return null;
      definition.collisionEnabled = enabled;
    }
    if (previous !== enabled) this.invalidateCollisionPoseCache();
    return enabled;
  }

  restoreRuntimeBodyConfigDefaults() {
    for (const [id, defaults] of this.runtimeBodyConfigDefaults) {
      if (!this.getRigidBody(id)) continue;
      this.setNodeBodyType(id, defaults.bodyType, { runtimeOnly: true, captureDefault: false });

      const ownedBlocks = this.blocks.filter(block => (block.entityId || this.rootComponentId) === id);
      const configuredMass = normalizeBodyMass(defaults.mass);
      const mass = configuredMass ?? defaultBodyMass(ownedBlocks);
      this.setNodeBodyMass(id, mass, { runtimeOnly: true, captureDefault: false });
      if (id === this.rootComponentId) this.massOverride = configuredMass;
      else {
        const definition = this.childDefinitions.get(id);
        if (definition) {
          if (configuredMass === null) delete definition.mass;
          else definition.mass = configuredMass;
        }
      }

      this.setNodeBodyMaterial(id, defaults, { runtimeOnly: true, captureDefault: false });
      this.setNodeGravityEnabled(id, defaults.useGravity, { runtimeOnly: true, captureDefault: false });
      this.setNodeCollisionEnabled(id, defaults.collisionEnabled, { runtimeOnly: true, captureDefault: false });
    }
    this.runtimeBodyConfigDefaults.clear();
  }

  applyNodeBodyForce(nodeId, force) {
    const body = this.getRigidBody(nodeId);
    const safeForce = boundedBodyVector(force);
    if (!body || body.type !== BodyType.DYNAMIC || !safeForce) return false;
    body.appliedForces.add(safeForce);
    return true;
  }

  applyNodeBodyTorque(nodeId, torque) {
    const body = this.getRigidBody(nodeId);
    const safeTorque = boundedBodyVector(torque);
    if (!body || body.type !== BodyType.DYNAMIC || !safeTorque) return false;
    body.appliedTorques.add(safeTorque);
    return true;
  }

  syncKinematicBodies(dt, dynamicParentsOnly = false) {
    this.rootGroup.updateMatrixWorld(true);
    for (const body of this.rigidBodies.values()) {
      if (body.type !== BodyType.KINEMATIC) continue;
      const node = this.entityNodes.get(body.nodeId);
      if (!node) continue;
      if (dynamicParentsOnly) {
        let parentId = node.parentId;
        let hasDynamicParent = false;
        while (parentId) {
          if (this.getRigidBody(parentId)?.type === BodyType.DYNAMIC) {
            hasDynamicParent = true;
            break;
          }
          parentId = this.entityNodes.get(parentId)?.parentId || null;
        }
        if (!hasDynamicParent) continue;
      }
      const position = body.id === this.rootComponentId
        ? this.position.clone()
        : node.group.localToWorld(body.centerOfMassLocal.clone());
      const quaternion = body.id === this.rootComponentId
        ? this.quaternion.clone()
        : node.group.getWorldQuaternion(new THREE.Quaternion());
      if (dt > 0) {
        body.velocity.copy(position).sub(body.previousKinematicPosition).divideScalar(dt);
        body.angularVelocity.copy(angularVelocityBetween(body.previousKinematicQuaternion, quaternion, dt));
      } else {
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
      }
      if (body.id !== this.rootComponentId) {
        body.position.copy(position);
        body.quaternion.copy(quaternion);
      }
      body.previousKinematicPosition.copy(position);
      body.previousKinematicQuaternion.copy(quaternion);
      body.appliedForces.set(0, 0, 0);
      body.appliedTorques.set(0, 0, 0);
    }
  }

  syncBodyToNode(body) {
    if (!body) return;
    if (body.id === this.rootComponentId) {
      this.updateTransform();
      return;
    }
    const node = this.entityNodes.get(body.nodeId);
    const parent = node && this.entityNodes.get(node.parentId || this.rootComponentId);
    if (!node || !parent) return;
    parent.group.updateWorldMatrix(true, false);
    const parentQuaternion = parent.group.getWorldQuaternion(new THREE.Quaternion());
    const pivotWorld = body.centerOfMassLocal.clone()
      .applyQuaternion(body.quaternion)
      .multiplyScalar(-1)
      .add(body.position);
    node.localPosition.copy(parent.group.worldToLocal(pivotWorld.clone()));
    node.localQuaternion.copy(parentQuaternion.invert().multiply(body.quaternion).normalize());
    node.group.position.copy(node.localPosition);
    node.group.quaternion.copy(node.localQuaternion);
    node.group.updateWorldMatrix(true, true);
  }

  syncAllBodyTransforms() {
    this.updateTransform();
    for (const body of this.rigidBodies.values()) {
      if (body.id !== this.rootComponentId && body.type === BodyType.DYNAMIC) this.syncBodyToNode(body);
    }
  }

  initializeConstraints(constraints = []) {
    this.constraintDefinitions.clear();
    for (const definition of constraints) this.createConstraint(definition);
  }

  createConstraint(definition: any = {}) {
    const bodyBId = String(definition.bodyB || definition.nodeId || '');
    const bodyB = this.getRigidBody(bodyBId);
    const requestedBodyA = definition.bodyA !== undefined
      ? definition.bodyA
      : definition.parentId !== undefined
        ? definition.parentId
        : this.entityNodes.get(bodyBId)?.parentId ?? null;
    const bodyAId = requestedBodyA === null ? null : String(requestedBodyA || '');
    const bodyA = bodyAId === null ? null : this.getRigidBody(bodyAId);
    if (!bodyB || (bodyAId !== null && !bodyA) || bodyAId === bodyBId) return null;
    const type = ['point', 'hinge', 'weld'].includes(definition.type) ? definition.type : 'point';
    const hasExplicitId = definition.id !== undefined;
    if (hasExplicitId && !isValidConstraintId(definition.id)) return null;
    const preferredId = hasExplicitId
      ? String(definition.id)
      : `${type}_${bodyAId ?? 'external'}_${bodyBId}`;
    const id = uniqueInstalledConstraintId(preferredId, new Set(this.constraintDefinitions.keys()));

    const nodeB = this.entityNodes.get(bodyBId);
    const pivotWorld = nodeB?.group?.getWorldPosition(new THREE.Vector3()) || bodyB.position.clone();
    const toLocal = (body, world) => world.clone().sub(body.position).applyQuaternion(body.quaternion.clone().invert());
    const anchorA = Array.isArray(definition.anchorA)
      ? asVector3(definition.anchorA)
      : (bodyA ? toLocal(bodyA, pivotWorld) : pivotWorld.clone());
    const anchorB = Array.isArray(definition.anchorB)
      ? asVector3(definition.anchorB)
      : toLocal(bodyB, pivotWorld);
    const axisA = asVector3(definition.axisA, new THREE.Vector3(0, 0, 1)).normalize();
    const axisB = asVector3(definition.axisB, new THREE.Vector3(0, 0, 1)).normalize();
    const perpendicular = Math.abs(axisA.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const referenceA = asVector3(definition.referenceA, perpendicular.clone().addScaledVector(axisA, -perpendicular.dot(axisA)).normalize());
    const referenceWorld = bodyA ? referenceA.clone().applyQuaternion(bodyA.quaternion) : referenceA.clone();
    const referenceB = asVector3(
      definition.referenceB,
      referenceWorld.applyQuaternion(bodyB.quaternion.clone().invert()).normalize()
    );
    const limitMin = Number(definition.limits?.min);
    const limitMax = Number(definition.limits?.max);
    const limits = Number.isFinite(limitMin) && Number.isFinite(limitMax)
      ? { min: Math.min(limitMin, limitMax), max: Math.max(limitMin, limitMax) }
      : null;
    const requestedStiffness = Number(definition.stiffness ?? 0.9);
    const constraint = {
      id,
      type,
      bodyA: bodyAId,
      bodyB: bodyBId,
      anchorA: anchorA.toArray(),
      anchorB: anchorB.toArray(),
      axisA: axisA.toArray(),
      axisB: axisB.toArray(),
      referenceA: referenceA.toArray(),
      referenceB: referenceB.toArray(),
      limits,
      stiffness: Number.isFinite(requestedStiffness)
        ? Math.max(0, Math.min(1, requestedStiffness))
        : 0.9,
      collideConnected: !!definition.collideConnected
    };
    this.constraintDefinitions.set(id, constraint);
    return constraint;
  }

  removeConstraint(id) {
    return this.constraintDefinitions.delete(String(id || ''));
  }

  getConstraints(nodeId = null) {
    const constraints = [...this.constraintDefinitions.values()]
      .filter(constraint => !nodeId || constraint.bodyA === nodeId || constraint.bodyB === nodeId)
      .sort((left, right) => compareIds(left.id, right.id))
      .map(constraint => ({ ...constraint, limits: constraint.limits ? { ...constraint.limits } : null }));
    return Object.freeze(constraints.map(constraint => Object.freeze(constraint)));
  }

  rebuildAfterBlockChange(type = 'change', nodeId = null, event = null) {
    this.buildCollisionCells();
    this.calculateBoundsAndCenter();
    this.voxelVolume = this.blocks.reduce((sum, block) => sum + Math.pow(block.size || 1, 3), 0);
    this.rebuildEntityHierarchy();
    if (this.scriptStatus !== 'running') {
      this.appliedForces.set(0, 0, 0);
      this.appliedTorques.set(0, 0, 0);
      for (const node of this.entityNodes.values()) {
        if (node.parentId !== null) node.localAngularVelocity.set(0, 0, 0);
      }
    }
    this.createHighlightBox();
    if (this.selectedNodeId) {
      this.setHighlightedNode(this.selectedNodeId);
    }
    // Block-change events fire even when bounds do not change, including color edits.
    // Scripts query them through ctx.blocks.pressed()/event(), mirroring ctx.input.
    // Pivots do not follow bounds automatically; use getBounds then setPivot when needed.
    this.notifyBlocksChanged(type, nodeId, event);
  }

  /**
   * Record a block edit between render frames. Types are place, remove, color, and
   * subdivide. Scripts observe it through ctx.blocks.pressed(type?) on the next frame;
   * the event clears at frame end.
   */
  notifyBlocksChanged(type, nodeId = null, event = null) {
    this.blocksChangedThisFrame = true;
    this.lastBlocksChangedEvent = Object.freeze({
      type,
      nodeId,
      ...(event && typeof event === 'object' ? cloneScriptData(event, {}) : {}),
      blockCount: this.blocks.length
    });
  }

  /** Entity-local block bounds for a component, or null when it has no blocks. */
  getNodeBlocksBounds(nodeId) {
    const id = String(nodeId || this.rootComponentId);
    const nodeBlocks = this.blocks.filter(b => (b.entityId || this.rootComponentId) === id);
    if (nodeBlocks.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of nodeBlocks) {
      const size = b.size || 1;
      minX = Math.min(minX, b.localX); minY = Math.min(minY, b.localY); minZ = Math.min(minZ, b.localZ);
      maxX = Math.max(maxX, b.localX + size); maxY = Math.max(maxY, b.localY + size); maxZ = Math.max(maxZ, b.localZ + size);
    }
    return Object.freeze({
      min: Object.freeze([minX, minY, minZ]),
      max: Object.freeze([maxX, maxY, maxZ]),
      size: Object.freeze([maxX - minX, maxY - minY, maxZ - minZ]),
      center: Object.freeze([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2])
    });
  }

  /**
   * Default editor pivot: the entity root returns to its authored entity
   * center, while a child returns to the center of the voxels it directly
   * owns. Empty components keep their current pivot.
   */
  getDefaultComponentPivot(nodeId = this.rootComponentId) {
    const id = String(nodeId || this.rootComponentId);
    const node = this.entityNodes.get(id);
    if (!node) return null;
    if (node.parentId === null) return this.localCenter.clone();
    const bounds = this.getNodeBlocksBounds(id);
    return bounds?.center
      ? new THREE.Vector3().fromArray(bounds.center as [number, number, number])
      : node.pivotLocal.clone();
  }

  /** Restore a component pivot to its default center without moving its subtree. */
  resetComponentPivot(nodeId = this.rootComponentId, options: any = {}) {
    const id = String(nodeId || this.rootComponentId);
    const target = this.getDefaultComponentPivot(id);
    if (!target) return { ok: false, reason: 'component_not_found' };
    const isRoot = this.entityNodes.get(id)?.parentId === null;
    const hadRootOverride = isRoot && this.rootPivotOverride !== null;
    const result: any = this.setComponentPivot(id, target, options);
    if (!result.ok) return result;
    if (isRoot) this.rootPivotOverride = null;
    return hadRootOverride && !result.changed
      ? { ...result, changed: true, pivot: target.toArray() }
      : result;
  }

  createChildEntity(parentId, cellKeysOrBlocks, requestedId = null) {
    const parent = this.entityNodes.get(parentId);
    if (!parent || !cellKeysOrBlocks || this.childDefinitions.size >= MAX_ENTITY_COMPONENTS - 1) return null;
    if (requestedId !== null && !isValidComponentId(String(requestedId))) return null;

    let selectedBlocks = [];
    if (Array.isArray(cellKeysOrBlocks) && cellKeysOrBlocks.length > 0 && typeof cellKeysOrBlocks[0] === 'object' && cellKeysOrBlocks[0] !== null && 'localX' in cellKeysOrBlocks[0]) {
      const blockSet = new Set(cellKeysOrBlocks);
      selectedBlocks = this.blocks.filter(block => (
        (block.entityId || this.rootComponentId) === parentId && blockSet.has(block)
      ));
    } else if (cellKeysOrBlocks instanceof Set && cellKeysOrBlocks.size > 0 && typeof [...cellKeysOrBlocks][0] === 'object' && [...cellKeysOrBlocks][0] !== null && 'localX' in ([...cellKeysOrBlocks][0] as any)) {
      const blockSet = cellKeysOrBlocks as Set<any>;
      selectedBlocks = this.blocks.filter(block => (
        (block.entityId || this.rootComponentId) === parentId && blockSet.has(block)
      ));
    } else {
      const selectedCells = new Set([...cellKeysOrBlocks].map(String));
      selectedBlocks = this.blocks.filter(block => (
        (block.entityId || this.rootComponentId) === parentId && selectedCells.has(collisionCellKey(block))
      ));
    }
    if (selectedBlocks.length === 0) return null;

    const bounds = this.getPreparedChildBounds(selectedBlocks);
    return this.createChildEntityFromPrepared(parentId, selectedBlocks, bounds, requestedId);
  }

  private getPreparedChildBounds(selectedBlocks) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of selectedBlocks) {
      const s = b.size || 1;
      minX = Math.min(minX, b.localX);
      minY = Math.min(minY, b.localY);
      minZ = Math.min(minZ, b.localZ);
      maxX = Math.max(maxX, b.localX + s);
      maxY = Math.max(maxY, b.localY + s);
      maxZ = Math.max(maxZ, b.localZ + s);
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /** Commit a child component after BulkEditJob has validated and bounded it. */
  createChildEntityFromPrepared(parentId, selectedBlocks, bounds, requestedId = null) {
    const parent = this.entityNodes.get(parentId);
    if (!parent || !Array.isArray(selectedBlocks) || selectedBlocks.length === 0
      || this.childDefinitions.size >= MAX_ENTITY_COMPONENTS - 1) return null;
    if (requestedId !== null && !isValidComponentId(String(requestedId))) return null;
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) return null;
    // Ownership and bounds were checked incrementally by BulkEditJob. The
    // entity remains stopped until this atomic hierarchy mutation completes.

    let id = String(requestedId || `child_${this.nextChildId++}`);
    while (this.entityNodes.has(id) || this.childDefinitions.has(id)) {
      id = `child_${this.nextChildId++}`;
    }

    const pivot = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2
    );

    for (const block of selectedBlocks) block.entityId = id;
    this.childDefinitions.set(id, {
      id,
      parentId,
      pivot: pivot.toArray(),
      bodyType: BodyType.KINEMATIC,
      restitution: this.restitution,
      friction: this.friction
    });
    this.rebuildEntityHierarchy();
    return this.entityNodes.get(id) || null;
  }

  /** Whole-voxel (1x1) parent-cell keys of one component, used by the child
   *  selection UI. Collision itself runs on the finer 0.2 micro boxes. */
  getEntityCollisionCellKeys(nodeId, bounds = null) {
    const keys = new Set();
    for (const block of this.blocks) {
      if ((block.entityId || this.rootComponentId) !== nodeId) continue;
      const x = Math.floor(block.localX + 1e-6);
      const y = Math.floor(block.localY + 1e-6);
      const z = Math.floor(block.localZ + 1e-6);
      if (bounds && (
        x < bounds.minX || x > bounds.maxX
        || y < bounds.minY || y > bounds.maxY
        || z < bounds.minZ || z > bounds.maxZ
      )) continue;
      keys.add(`${x},${y},${z}`);
    }
    return keys;
  }

  isEntityDescendantOf(nodeId, ancestorId) {
    let node = this.entityNodes.get(nodeId);
    while (node?.parentId) {
      if (node.parentId === ancestorId) return true;
      node = this.entityNodes.get(node.parentId);
    }
    return false;
  }

  setFocusHighlight(nodeId) {
    if (nodeId === this.focusedHighlightNodeId) return;
    this.clearFocusHighlight();
    if (!nodeId) return;

    const node = this.entityNodes.get(nodeId);
    if (!node) return;
    this.focusedHighlightNodeId = nodeId;

    const materials = {
      focusedLine: new THREE.LineBasicMaterial({ color: 0x00d2d3, transparent: true, opacity: 0.85 }),
      focusedFill: new THREE.MeshBasicMaterial({ color: 0x00d2d3, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
      childLine: new THREE.LineBasicMaterial({ color: 0x2ed573, transparent: true, opacity: 0.85 }),
      childFill: new THREE.MeshBasicMaterial({ color: 0x2ed573, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide })
    };
    this.focusHighlightMaterials = materials;
    this.focusHighlightGeometries = [];

    const createBoxForBlocks = (ownerNode, blocks, isChild = false) => {
      if (!blocks || blocks.length === 0) return;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of blocks) {
        const s = b.size || 1;
        minX = Math.min(minX, b.localX); minY = Math.min(minY, b.localY); minZ = Math.min(minZ, b.localZ);
        maxX = Math.max(maxX, b.localX + s); maxY = Math.max(maxY, b.localY + s); maxZ = Math.max(maxZ, b.localZ + s);
      }
      const sx = maxX - minX;
      const sy = maxY - minY;
      const sz = maxZ - minZ;
      const cx = (minX + maxX) / 2 - ownerNode.pivotLocal.x;
      const cy = (minY + maxY) / 2 - ownerNode.pivotLocal.y;
      const cz = (minZ + maxZ) / 2 - ownerNode.pivotLocal.z;

      const segX = Math.max(1, Math.min(64, Math.round(sx)));
      const segY = Math.max(1, Math.min(64, Math.round(sy)));
      const segZ = Math.max(1, Math.min(64, Math.round(sz)));
      const boxGeo = new THREE.BoxGeometry(sx, sy, sz, segX, segY, segZ);
      const edgeGeo = new THREE.EdgesGeometry(boxGeo);
      this.focusHighlightGeometries.push(boxGeo, edgeGeo);

      const container = new THREE.Group();
      container.name = isChild ? 'ChildBreathingHighlight' : 'FocusedNodeHighlight';
      container.position.set(cx, cy, cz);

      const fill = new THREE.Mesh(boxGeo, isChild ? materials.childFill : materials.focusedFill);
      const lines = new THREE.LineSegments(edgeGeo, isChild ? materials.childLine : materials.focusedLine);
      fill.renderOrder = 22;
      lines.renderOrder = 23;
      container.add(fill, lines);
      ownerNode.group.add(container);
      this.focusHighlightEntries.push({ container, ownerNode, isChild });
    };

    // 1. Focused node bounding box (non-descendant blocks of this node)
    const focusedBlocks = this.blocks.filter(b => (b.entityId || this.rootComponentId) === nodeId);
    createBoxForBlocks(node, focusedBlocks, false);

    // 2. Direct child components (ONLY 1 layer below - node.children) with green breathing light
    if (node.children) {
      for (const childId of node.children) {
        const childNode = this.entityNodes.get(childId);
        if (!childNode) continue;
        const childBlocks = this.blocks.filter(b => (b.entityId || this.rootComponentId) === childId);
        createBoxForBlocks(childNode, childBlocks, true);
      }
    }
  }

  clearFocusHighlight() {
    if (this.focusHighlightEntries) {
      for (const entry of this.focusHighlightEntries) entry.container.removeFromParent();
    }
    this.focusHighlightEntries = [];
    if (this.focusHighlightGeometries) {
      for (const geo of this.focusHighlightGeometries) geo.dispose();
    }
    this.focusHighlightGeometries = [];
    if (this.focusHighlightMaterials) {
      for (const mat of Object.values(this.focusHighlightMaterials)) mat.dispose();
    }
    this.focusHighlightMaterials = null;
    this.focusedHighlightNodeId = null;
  }

  setGlueSelection(nodeId, cellKeys) {
    this.clearGlueSelection();
    const node = this.entityNodes.get(nodeId);
    if (!node || !cellKeys) return;

    // Show focused node + direct child green breathing boxes
    this.setFocusHighlight(nodeId);

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1, 5, 5, 5);
    const edgeGeometry = new THREE.EdgesGeometry(boxGeometry);
    const materials = {
      selectedLine: new THREE.LineBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.95 }),
      selectedFill: new THREE.MeshBasicMaterial({
        color: 0xff9f43,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    };
    this.glueHighlightMaterials = materials;
    this.glueHighlightGeometries = { boxGeometry, edgeGeometry };

    for (const key of cellKeys) {
      const [x, y, z] = key.split(',').map(Number);
      const container = new THREE.Group();
      container.name = 'GluePendingChildHighlight';
      container.position.set(
        x + 0.5 - node.pivotLocal.x,
        y + 0.5 - node.pivotLocal.y,
        z + 0.5 - node.pivotLocal.z
      );
      const fill = new THREE.Mesh(boxGeometry, materials.selectedFill);
      const lines = new THREE.LineSegments(edgeGeometry, materials.selectedLine);
      fill.renderOrder = 24;
      lines.renderOrder = 25;
      container.add(fill, lines);
      node.group.add(container);
      this.glueHighlightEntries.push({ container, role: 'selected', cell: { x, y, z }, entityId: node.id });
    }
    this.glueSelectionGroup = node.group;
    this.updateGlueSelectionPulse();
  }

  clearGlueSelection() {
    for (const entry of this.glueHighlightEntries) entry.container.removeFromParent();
    this.glueHighlightEntries = [];
    this.glueHighlightGeometries?.boxGeometry?.dispose();
    this.glueHighlightGeometries?.edgeGeometry?.dispose();
    if (this.glueHighlightMaterials) {
      for (const material of Object.values(this.glueHighlightMaterials)) material.dispose();
    }
    this.glueHighlightGeometries = null;
    this.glueHighlightMaterials = null;
    this.glueSelectionGroup = null;
    this.clearFocusHighlight();
  }

  updateGlueSelectionPulse() {
    const wave = (Math.sin(this.totalRuntime * 4.4) + 1) * 0.5;
    const counterWave = (Math.sin(this.totalRuntime * 4.4 + Math.PI * 0.55) + 1) * 0.5;
    if (this.glueHighlightMaterials) {
      this.glueHighlightMaterials.selectedLine.opacity = 0.52 + counterWave * 0.46;
      this.glueHighlightMaterials.selectedFill.opacity = 0.07 + counterWave * 0.17;
    }
    if (this.focusHighlightMaterials) {
      // Green breathing light on direct children bounding boxes
      this.focusHighlightMaterials.childLine.opacity = 0.35 + wave * 0.60;
      this.focusHighlightMaterials.childFill.opacity = 0.04 + wave * 0.16;
      // Focused node bounding box steady or subtle pulse
      this.focusHighlightMaterials.focusedLine.opacity = 0.7 + counterWave * 0.25;
      this.focusHighlightMaterials.focusedFill.opacity = 0.04 + counterWave * 0.06;
    }
  }

  createVoxelMesh(blocks, coordinateOrigin, parentGroup) {
    if (blocks.length === 0) return null;
    const positions = [];
    const normals = [];
    const colors = [];

    const faces = [
      { dir: [0, 1, 0], norm: [0, 1, 0], quad: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], face: 'top' },
      { dir: [0, -1, 0], norm: [0, -1, 0], quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], face: 'bottom' },
      { dir: [0, 0, -1], norm: [0, 0, -1], quad: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], face: 'side' },
      { dir: [0, 0, 1], norm: [0, 0, 1], quad: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]], face: 'side' },
      { dir: [-1, 0, 0], norm: [-1, 0, 0], quad: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]], face: 'side' },
      { dir: [1, 0, 0], norm: [1, 0, 0], quad: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]], face: 'side' }
    ];

    const meshCellMap = new Map();
    const meshKey = (x, y, z, size) => `${Math.round(x * 5)},${Math.round(y * 5)},${Math.round(z * 5)},${Math.round(size * 5)}`;
    for (const b of blocks) {
      const size = b.size || 1;
      meshCellMap.set(meshKey(b.localX, b.localY, b.localZ, size), b);
    }

    const tempColor = new THREE.Color();

    for (const b of blocks) {
      const blockSize = b.size || 1;

      const ox = b.localX - coordinateOrigin.x;
      const oy = b.localY - coordinateOrigin.y;
      const oz = b.localZ - coordinateOrigin.z;

      for (const f of faces) {
        const nx = b.localX + f.dir[0] * blockSize;
        const ny = b.localY + f.dir[1] * blockSize;
        const nz = b.localZ + f.dir[2] * blockSize;

        if (meshCellMap.has(meshKey(nx, ny, nz, blockSize))) continue;

        const hexColor = b.color ?? DEFAULT_BLOCK_COLOR;
        tempColor.set(hexColor);
        const shade = f.face === 'top' ? 1.0 : f.face === 'bottom' ? 0.6 : 0.85;
        const r = tempColor.r * shade;
        const g = tempColor.g * shade;
        const bCol = tempColor.b * shade;

        const q = f.quad;
        const v0 = [ox + q[0][0] * blockSize, oy + q[0][1] * blockSize, oz + q[0][2] * blockSize];
        const v1 = [ox + q[1][0] * blockSize, oy + q[1][1] * blockSize, oz + q[1][2] * blockSize];
        const v2 = [ox + q[2][0] * blockSize, oy + q[2][1] * blockSize, oz + q[2][2] * blockSize];
        const v3 = [ox + q[3][0] * blockSize, oy + q[3][1] * blockSize, oz + q[3][2] * blockSize];

        positions.push(...v0, ...v1, ...v2);
        normals.push(...f.norm, ...f.norm, ...f.norm);
        colors.push(r, g, bCol, r, g, bCol, r, g, bCol);

        positions.push(...v0, ...v2, ...v3);
        normals.push(...f.norm, ...f.norm, ...f.norm);
        colors.push(r, g, bCol, r, g, bCol, r, g, bCol);
      }
    }

    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.65,
        metalness: 0.15
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parentGroup.add(mesh);
      return mesh;
    }
    return null;
  }

  createHighlightBox() {
    const wasVisible = this.isHighlighted || (this.highlightBox?.material?.opacity > 0);
    if (this.highlightBox) {
      this.highlightBox.removeFromParent();
      if (this.highlightBox.geometry) this.highlightBox.geometry.dispose();
      if (this.highlightBox.material) this.highlightBox.material.dispose();
      this.highlightBox = null;
    }
    if (!this.blocks || this.blocks.length === 0) return;

    const currentCenter = new THREE.Vector3(
      (this.minLocal.x + this.maxLocal.x) / 2,
      (this.minLocal.y + this.maxLocal.y) / 2,
      (this.minLocal.z + this.maxLocal.z) / 2
    );
    const boxOffset = currentCenter.sub(this.localCenter);

    const segX = Math.max(1, Math.min(64, Math.round(this.size.x)));
    const segY = Math.max(1, Math.min(64, Math.round(this.size.y)));
    const segZ = Math.max(1, Math.min(64, Math.round(this.size.z)));
    const geo = new THREE.BoxGeometry(
      Math.max(0.1, this.size.x),
      Math.max(0.1, this.size.y),
      Math.max(0.1, this.size.z),
      segX, segY, segZ
    );
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({
      color: 0xf1c40f,
      linewidth: 2,
      transparent: true,
      opacity: wasVisible ? 0.9 : 0.0
    });

    this.highlightBox = new THREE.LineSegments(edges, mat);
    this.highlightBox.position.copy(boxOffset);
    this.rootGroup.add(this.highlightBox);
  }

  setHighlighted(highlighted) {
    this.isHighlighted = !!highlighted;
    if (this.highlightBox) {
      this.highlightBox.material.opacity = highlighted ? 0.9 : 0.0;
    }
  }

  getHierarchyTree() {
    const buildNode = (id) => {
      const node = this.entityNodes.get(id);
      if (!node) return null;
      const blocks = this.blocks.filter(b => (b.entityId || this.rootComponentId) === id);
      const voxelVolume = blocks.reduce((sum, b) => sum + Math.pow(b.size || 1, 3), 0);
      const childArray = [];
      if (node.children) {
        for (const childId of [...node.children].sort(compareComponentIds)) {
          const childTree = buildNode(childId);
          if (childTree) childArray.push(childTree);
        }
      }
      return {
        id: node.id,
        name: this.getComponentName(id),
        parentId: node.parentId,
        kind: node.parentId === null ? 'root' : 'child',
        bodyType: this.getNodeDefaultBodyConfig(id)?.bodyType || this.getNodeBodyType(id),
        blockCount: blocks.length,
        volume: Number(voxelVolume.toFixed(2)),
        pivot: [node.pivotLocal.x, node.pivotLocal.y, node.pivotLocal.z],
        localPosition: node.localPosition.toArray(),
        children: childArray
      };
    };

    return buildNode(this.rootComponentId);
  }

  setHighlightedNode(nodeId) {
    if (this.nodeHighlightBox) {
      this.nodeHighlightBox.removeFromParent();
      if (this.nodeHighlightGeometries) {
        for (const g of Object.values(this.nodeHighlightGeometries)) (g as any)?.dispose?.();
      }
      if (this.nodeHighlightMaterials) {
        for (const m of Object.values(this.nodeHighlightMaterials)) (m as any)?.dispose?.();
      }
      this.nodeHighlightBox = null;
      this.nodeHighlightGeometries = null;
      this.nodeHighlightMaterials = null;
    }
    this.selectedNodeId = nodeId || null;
    if (!nodeId) return;

    const built = this.buildNodeHighlightBox(nodeId);
    if (built) {
      this.nodeHighlightBox = built.group;
      this.nodeHighlightGeometries = built.geometries;
      this.nodeHighlightMaterials = built.materials;
    }
  }

  /**
   * Create highlight boxes for subtree nodes; each box follows its node.
   */
  highlightSubtree(nodeIds) {
    this.clearSubtreeHighlight();
    if (!nodeIds || nodeIds.length === 0) return;
    for (const id of nodeIds) {
      const built = this.buildNodeHighlightBox(id);
      if (!built) continue;
      this.subtreeHighlightBoxes.push({ nodeId: id, ...built });
    }
  }

  clearSubtreeHighlight() {
    for (const entry of this.subtreeHighlightBoxes) {
      entry.group.removeFromParent();
      if (entry.geometries) {
        for (const g of Object.values(entry.geometries)) (g as any)?.dispose?.();
      }
      if (entry.materials) {
        for (const m of Object.values(entry.materials)) (m as any)?.dispose?.();
      }
    }
    this.subtreeHighlightBoxes = [];
  }

  /**
   * Highlight concrete blocks selected by a two-point box. Each wireframe attaches
   * to its owning node group and follows entity transforms.
   */
  highlightBlocks(blockList) {
    this.clearSubtreeHighlight();
    if (!blockList || blockList.length === 0) return;

    const nodeMap = new Map<string, any[]>();
    for (const b of blockList) {
      const nodeId = b.entityId || this.rootComponentId;
      let list = nodeMap.get(nodeId);
      if (!list) {
        list = [];
        nodeMap.set(nodeId, list);
      }
      list.push(b);
    }

    for (const [nodeId, blocks] of nodeMap) {
      const node = this.entityNodes.get(nodeId) || this.entityNodes.get(this.rootComponentId);
      if (!node) continue;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of blocks) {
        const s = b.size || 1;
        if (b.localX < minX) minX = b.localX;
        if (b.localY < minY) minY = b.localY;
        if (b.localZ < minZ) minZ = b.localZ;
        if (b.localX + s > maxX) maxX = b.localX + s;
        if (b.localY + s > maxY) maxY = b.localY + s;
        if (b.localZ + s > maxZ) maxZ = b.localZ + s;
      }

      const sx = Math.max(0.001, maxX - minX);
      const sy = Math.max(0.001, maxY - minY);
      const sz = Math.max(0.001, maxZ - minZ);
      const pivot = node.pivotLocal;
      const cx = (minX + maxX) / 2 - pivot.x;
      const cy = (minY + maxY) / 2 - pivot.y;
      const cz = (minZ + maxZ) / 2 - pivot.z;

      const boxGeo = new THREE.BoxGeometry(sx, sy, sz);
      const edgeGeo = new THREE.EdgesGeometry(boxGeo);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0xff9f43,
        transparent: true,
        opacity: 0.95,
        depthWrite: false
      });
      const lines = new THREE.LineSegments(edgeGeo, lineMat);
      lines.position.set(cx, cy, cz);
      lines.renderOrder = 33;
      node.group.add(lines);
      this.subtreeHighlightBoxes.push({ group: lines, geometries: { edges: edgeGeo, box: boxGeo }, materials: { lineMat } });
    }
  }

  /** Build a cyan highlight attached to one node group, including a red pivot indicator. */
  buildNodeHighlightBox(nodeId) {
    const node = this.entityNodes.get(nodeId);
    if (!node) return null;

    const group = new THREE.Group();
    group.name = `NodeHighlight_${nodeId}`;
    group.position.set(0, 0, 0);

    const geometries: any = {};
    const materials: any = {};

    // Red pivot indicator dot at node origin (0, 0, 0)
    // Fixed 3px screen-space square point without wireframe or mesh distortion
    const pivotGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0)]);
    const pivotMat = new THREE.PointsMaterial({
      color: 0xff2222,
      size: 3,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1.0
    });

    const pivotPoint = new THREE.Points(pivotGeo, pivotMat);
    pivotPoint.name = `NodePivotPoint_${nodeId}`;
    pivotPoint.renderOrder = 99;
    pivotPoint.position.set(0, 0, 0);

    group.add(pivotPoint);

    geometries.pivotGeo = pivotGeo;
    materials.pivotMat = pivotMat;

    const nodeBlocks = this.blocks.filter(b => (b.entityId || this.rootComponentId) === nodeId);
    if (nodeBlocks.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const b of nodeBlocks) {
        const s = b.size || 1;
        minX = Math.min(minX, b.localX);
        minY = Math.min(minY, b.localY);
        minZ = Math.min(minZ, b.localZ);
        maxX = Math.max(maxX, b.localX + s);
        maxY = Math.max(maxY, b.localY + s);
        maxZ = Math.max(maxZ, b.localZ + s);
      }

      const sx = maxX - minX;
      const sy = maxY - minY;
      const sz = maxZ - minZ;
      const cx = (minX + maxX) / 2 - node.pivotLocal.x;
      const cy = (minY + maxY) / 2 - node.pivotLocal.y;
      const cz = (minZ + maxZ) / 2 - node.pivotLocal.z;

      const segX = Math.max(1, Math.min(64, Math.round(sx)));
      const segY = Math.max(1, Math.min(64, Math.round(sy)));
      const segZ = Math.max(1, Math.min(64, Math.round(sz)));
      const box = new THREE.BoxGeometry(sx, sy, sz, segX, segY, segZ);
      const edges = new THREE.EdgesGeometry(box);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x00d2d3,
        linewidth: 2,
        transparent: true,
        opacity: 0.95
      });
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0x48dbfb,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false
      });

      const lines = new THREE.LineSegments(edges, lineMat);
      const fill = new THREE.Mesh(box, fillMat);
      lines.renderOrder = 32;
      fill.renderOrder = 31;

      lines.position.set(cx, cy, cz);
      fill.position.set(cx, cy, cz);

      group.add(fill, lines);

      geometries.box = box;
      geometries.edges = edges;
      materials.lineMat = lineMat;
      materials.fillMat = fillMat;
    }

    node.group.add(group);

    return { group, geometries, materials };
  }

  // =========================================================================
  // UPDATE LOOP (dispatch motion by mode)
  // =========================================================================

  update(dt, inputState = null, runtimeContext = null) {
    this.capturePreviousEntityTransforms();
    this.totalRuntime += dt;

    if (this.nodeHighlightMaterials) {
      const pulse = (Math.sin(this.totalRuntime * 5.0) + 1) * 0.5;
      if (this.nodeHighlightMaterials.lineMat) {
        this.nodeHighlightMaterials.lineMat.opacity = 0.6 + pulse * 0.38;
      }
      if (this.nodeHighlightMaterials.fillMat) {
        this.nodeHighlightMaterials.fillMat.opacity = 0.08 + pulse * 0.14;
      }
      if (this.nodeHighlightMaterials.pivotMat) {
        this.nodeHighlightMaterials.pivotMat.opacity = 0.85 + pulse * 0.15;
      }
    }

    // A controller may drive child entities regardless of the root motion mode.
    this.updateProgrammable(dt, inputState, runtimeContext);

    switch (this.mode) {
      case ContraptionMode.PROGRAMMABLE:
        break;

      case ContraptionMode.FREE_PHYSICS:
      case ContraptionMode.PROJECTILE:
      default:
        // Handled by physics engine
        break;
    }

    this.updateChildEntities(dt);
    // Kinematic-root spin integrates directly into entity orientation and,
    // like child kinematics, advances only on frames where the script commands it.
    if (this.bodyType === BodyType.KINEMATIC) {
      const rootNode = this.entityNodes.get(this.rootComponentId);
      if (rootNode?.commandedThisFrame) {
        const spinSpeed = rootNode.localAngularVelocity.length();
        if (spinSpeed > 1e-8) {
          const spinRotation = new THREE.Quaternion().setFromAxisAngle(
            rootNode.localAngularVelocity.clone().normalize(),
            spinSpeed * dt
          );
          this.quaternion.multiply(spinRotation).normalize();
        }
      }
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this.appliedForces.set(0, 0, 0);
      this.appliedTorques.set(0, 0, 0);
    }
    this.updateGlueSelectionPulse();
    this.updateTransform();

    // Component command flags are consumed by updateChildEntities above, then
    // reset for the next frame. A component may only keep spinning while code
    // re-commands it each simulation update: no command this update (switch off, code
    // cleared, compile error) leaves its angular velocity at the default 0,
    // mirroring how forces are cleared by physics.
    for (const node of this.entityNodes.values()) {
      node.commandedThisFrame = false;
    }
    // Blocks-changed is an edge snapshot (ctx.blocks.pressed()). Edits happen
    // between simulation updates, so the flag survives one script evaluation.
    this.blocksChangedThisFrame = false;
  }

  updateChildEntities(dt) {
    for (const node of this.entityNodes.values()) {
      if (node.parentId === null) continue;
      if (node.bodyType !== BodyType.KINEMATIC) {
        node.localAngularVelocity.set(0, 0, 0);
        continue;
      }
      // A component only rotates while code actually commanded it this frame.
      // Turning the switch off, clearing its code, or a compile error in the
      // driving script all leave the angular velocity at its default of 0.
      if (!this.isNodeScriptEnabled(node.id) || !node.commandedThisFrame) {
        node.localAngularVelocity.set(0, 0, 0);
        continue;
      }
      const speed = node.localAngularVelocity.length();
      if (speed < 1e-8) continue;
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        node.localAngularVelocity.clone().normalize(),
        speed * dt
      );
      node.localQuaternion.multiply(rotation).normalize();
      node.group.quaternion.copy(node.localQuaternion);
    }
  }

  capturePreviousEntityTransforms() {
    this.previousPosition.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
    this.rootGroup.updateMatrixWorld(true);
    for (const node of this.entityNodes.values()) {
      node.previousLocalPosition ||= node.localPosition.clone();
      node.previousLocalQuaternion ||= node.localQuaternion.clone();
      node.previousLocalPosition.copy(node.localPosition);
      node.previousLocalQuaternion.copy(node.localQuaternion);
      node.group.updateWorldMatrix(true, false);
      if (!node.previousWorldMatrix) node.previousWorldMatrix = new THREE.Matrix4();
      node.previousWorldMatrix.copy(node.group.matrixWorld);
    }
    this.invalidateCollisionPoseCache();
  }

  getSerializableComponentStates() {
    const states = {};
    const entries = [...this.componentVariables.entries()]
      .sort(([left], [right]) => compareComponentIds(left, right));
    for (const [id, state] of entries) {
      states[id] = cloneScriptData(state, {});
    }
    return states;
  }

  buildScriptRuntimeSnapshot(dt, inputState, runtimeContext, time, tick) {
    const euler = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
    const rawPlayers = Array.isArray(runtimeContext?.players) ? runtimeContext.players : [];
    const optionalVector = value => Array.isArray(value) && value.length >= 3
      ? value.slice(0, 3).map(part => Number(part) || 0)
      : null;
    const optionalNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
    const optionalBoolean = value => typeof value === 'boolean' ? value : null;
    const players = rawPlayers.map(player => {
      const requestedMass = Number(player?.mass);
      const eyePosition = optionalVector(player?.eyePosition || player?.position) || [0, 0, 0];
      return {
        id: String(player?.id || 'player'),
        position: [...eyePosition],
        eyePosition,
        feetPosition: optionalVector(player?.feetPosition),
        velocity: optionalVector(player?.velocity),
        yaw: optionalNumber(player?.yaw),
        pitch: optionalNumber(player?.pitch),
        isLocal: player?.isLocal === true,
        isOnGround: optionalBoolean(player?.isOnGround),
        isFlying: optionalBoolean(player?.isFlying),
        isCrouching: optionalBoolean(player?.isCrouching),
        isSprinting: optionalBoolean(player?.isSprinting),
        isInWater: optionalBoolean(player?.isInWater),
        ridingEntityId: player?.ridingEntityId == null ? null : String(player.ridingEntityId),
        ridingBodyId: player?.ridingBodyId == null ? null : String(player.ridingBodyId),
        avatarEntityId: player?.avatarEntityId == null ? null : String(player.avatarEntityId),
        mass: Number.isFinite(requestedMass) && requestedMass > 0
          ? requestedMass
          : PLAYER_MASS_KG
      };
    });
    const components = [...this.entityNodes.values()]
      .sort((left, right) => {
        if (left.parentId === null) return right.parentId === null ? 0 : -1;
        if (right.parentId === null) return 1;
        return compareComponentIds(left.id, right.id);
      })
      .map(node => {
        const body = this.getRigidBody(node.id);
        return {
          id: node.id,
          parentId: node.parentId,
          children: [...node.children].sort(compareComponentIds),
          worldPosition: this.getEntityNodeWorldPosition(node.id).toArray(),
          worldRotation: this.getEntityNodeWorldQuaternion(node.id).toArray(),
          localPosition: node.parentId === null ? [0, 0, 0] : node.localPosition.toArray(),
          localRotation: node.parentId === null ? this.quaternion.toArray() : node.localQuaternion.toArray(),
          pivot: node.pivotLocal.toArray(),
          seats: this.getComponentSeats(node.id).map(seat => [...seat.position]),
          bounds: this.getNodeBlocksBounds(node.id),
          constraints: this.getConstraints(node.id),
          body: {
            type: this.getNodeBodyType(node.id),
            mass: this.getNodeBodyMass(node.id),
            material: this.getNodeBodyMaterial(node.id),
            useGravity: this.getNodeGravityEnabled(node.id),
            collisionEnabled: this.getNodeCollisionEnabled(node.id),
            velocity: body?.velocity.toArray() || [0, 0, 0],
            angularVelocity: body?.angularVelocity.toArray() || [0, 0, 0]
          }
        };
      });
    let nearbyEntities = [];
    try {
      if ([...this.nodeScripts.values()].some(code => code?.includes('ctx.world'))) {
        nearbyEntities = runtimeContext?.world?.entities?.(this.position.toArray(), 64) || [];
      }
    } catch (_) {}
    let selection = null;
    try {
      if ([...this.nodeScripts.values()].some(code => code?.includes('ctx.selection'))) {
        selection = runtimeContext?.selection?.get?.() || null;
      }
    } catch (_) {}
    const scriptOrder = [...this.compiledNodeScripts.keys()].sort((left, right) => {
      if (left === this.rootComponentId) return right === this.rootComponentId ? 0 : -1;
      if (right === this.rootComponentId) return 1;
      return compareComponentIds(left, right);
    });
    return cloneScriptData({
      entityId: this.publicId,
      rootComponentId: this.rootComponentId,
      time,
      deltaTime: dt,
      tick,
      position: this.position.toArray(),
      velocity: this.velocity.toArray(),
      rotation: [euler.x, euler.y, euler.z],
      angularVelocity: this.angularVelocity.toArray(),
      groundDistance: this.groundDistance,
      isOnGround: this.isOnGround === true,
      mass: this.mass,
      bodyType: this.bodyType,
      gravity: runtimeContext?.gravity || [0, -18, 0],
      limits: { maxForce: this.maxForce, maxTorque: this.maxTorque },
      input: {
        down: scriptInputCodes(inputState, 'down'),
        pressed: scriptInputCodes(inputState, 'pressed'),
        released: scriptInputCodes(inputState, 'released')
      },
      blocks: {
        changed: !!this.pendingScriptBlocksEvent,
        event: this.pendingScriptBlocksEvent || this.lastBlocksChangedEvent
      },
      players,
      driver: runtimeContext?.driver?.entityId === this.publicId
        ? {
            playerId: String(runtimeContext.driver.playerId || 'local'),
            componentId: String(runtimeContext.driver.componentId || this.rootComponentId),
            seatIndex: Math.max(0, Math.floor(Number(runtimeContext.driver.seatIndex) || 0))
          }
        : null,
      contacts: this.pendingScriptContacts.map(contact => {
        const { key: _key, ...visible } = contact;
        return visible;
      }),
      commandResults: this.pendingScriptCommandResults,
      components,
      states: this.getSerializableComponentStates(),
      enabled: Object.fromEntries(
        scriptOrder
          .map(id => [id, this.isNodeScriptEnabled(id)])
      ),
      scriptOrder,
      world: {
        entities: nearbyEntities,
        size: [TORUS_SIZE_X, TORUS_SIZE_Z]
      },
      selection
    }, {}, 2 * 1024 * 1024);
  }

  syncComponentStatesFromWorker(states, frozenPaths = []) {
    if (!states || typeof states !== 'object') return;
    for (const nodeId of this.entityNodes.keys()) {
      const next = cloneScriptData(states[nodeId], {});
      const target = this.getComponentState(nodeId);
      for (const key of Object.keys(target)) delete target[key];
      if (next && typeof next === 'object' && !Array.isArray(next)) Object.assign(target, next);
    }
    const sortedPaths = Array.isArray(frozenPaths)
      ? [...frozenPaths].sort((a, b) => b.length - a.length)
      : [];
    for (const path of sortedPaths) {
      if (!Array.isArray(path) || path.length < 2) continue;
      let value: any = this.componentVariables.get(String(path[0]));
      for (const key of path.slice(1)) value = value?.[key];
      if (value && typeof value === 'object') Object.freeze(value);
    }
  }

  resolveScriptCommandTarget(root, path) {
    let target = root;
    const parts = String(path || '').split('.');
    for (let index = 0; index < parts.length - 1; index++) {
      target = target?.[parts[index]];
    }
    const method = target?.[parts[parts.length - 1]];
    return typeof method === 'function' ? { target, method } : null;
  }

  /** Record one bounded physics observation for the next script snapshot. */
  recordScriptContact(contact) {
    if (!this.isPhysicsSimulationEnabled()) return false;
    const normalized = cloneScriptData(contact, null, 16 * 1024);
    if (!normalized || typeof normalized !== 'object') return false;
    const position = Array.isArray(normalized.position) ? normalized.position : [0, 0, 0];
    const normal = Array.isArray(normalized.normal) ? normalized.normal : [0, 0, 0];
    const key = [
      normalized.kind,
      normalized.selfNodeId,
      normalized.otherEntityId,
      normalized.otherNodeId,
      normalized.playerId,
      ...position.map(value => Number(value).toFixed(2)),
      ...normal.map(value => Number(value).toFixed(2))
    ].join('|');
    normalized.key = key;
    const existing = this.pendingScriptContacts.findIndex(entry => entry?.key === key);
    if (existing >= 0) this.pendingScriptContacts.splice(existing, 1);
    this.pendingScriptContacts.push(Object.freeze(normalized));
    if (this.pendingScriptContacts.length > 32) this.pendingScriptContacts.shift();
    return true;
  }

  recordScriptCommandResult(command, result = undefined, error = null) {
    if (!command?.commandId) return;
    const rejected = !!error || result === false || (result && typeof result === 'object' && result.ok === false);
    const detail = cloneScriptData(result, null, 16 * 1024);
    const receipt: any = {
      commandId: String(command.commandId),
      status: rejected ? 'rejected' : 'committed',
      scope: String(command.scope || ''),
      path: String(command.path || ''),
      nodeId: command.nodeId === null || command.nodeId === undefined
        ? null
        : String(command.nodeId)
    };
    if (detail && typeof detail === 'object') Object.assign(receipt, detail);
    if (error) receipt.reason = String(error?.message || error).slice(0, 500);
    else if (!receipt.reason) receipt.reason = rejected ? 'rejected' : 'committed';
    receipt.status = rejected ? 'rejected' : 'committed';
    receipt.commandId = String(command.commandId);
    this.pendingScriptCommandResults.push(Object.freeze(receipt));
    if (this.pendingScriptCommandResults.length > 256) this.pendingScriptCommandResults.shift();
  }

  capturePendingScriptEvents(inputState) {
    this.pendingScriptInputDown = scriptInputCodes(inputState, 'down');
    for (const code of scriptInputCodes(inputState, 'pressed')) {
      this.pendingScriptInputPressed.add(code);
    }
    for (const code of scriptInputCodes(inputState, 'released')) {
      this.pendingScriptInputReleased.add(code);
    }
    if (this.blocksChangedThisFrame) {
      this.pendingScriptBlocksEvent = this.lastBlocksChangedEvent;
    }
  }

  clearPendingScriptEvents() {
    this.pendingScriptInputPressed.clear();
    this.pendingScriptInputReleased.clear();
    this.pendingScriptBlocksEvent = null;
    this.pendingScriptContacts = [];
    this.pendingScriptCommandResults = [];
  }

  applyLatchedScriptCommands(runtimeContext) {
    if (this.scriptStatus === 'stopped') return;
    for (const command of this.latchedScriptCommands) {
      if (!this.isNodeScriptEnabled(String(command.nodeId || this.rootComponentId))) continue;
      const api = this.getChildScriptApi(String(command.nodeId || this.rootComponentId));
      const resolved = this.resolveScriptCommandTarget(api, command.path);
      const args = Array.isArray(command.args) ? command.args : [];
      try { resolved?.method.apply(resolved.target, args); } catch (_) {}
    }
    this.lastAppliedForce.copy(this.appliedForces);
    this.lastAppliedTorque.copy(this.appliedTorques);
  }

  applyScriptRuntimeResult(result, runtimeContext) {
    if (!result) return;
    this.lastExecutionTimeMs = Number(result.elapsedMs) || 0;
    if (result.fatal) {
      const message = result.error || 'QuickJS runtime failed';
      this.scriptStatus = 'error';
      this.scriptError = message;
      this.disableAllNodeScripts();
      this.log(`[ERR] [runtime] ${message}`);
      return;
    }

    this.syncComponentStatesFromWorker(result.states, result.frozenStatePaths);
    for (const [nodeId, elapsed] of Object.entries(result.executionTimes || {})) {
      this.lastExecutionTimeMs = Math.max(this.lastExecutionTimeMs, Number(elapsed) || 0);
      this.recordScriptExecutionTime(nodeId, Number(elapsed) || 0);
    }

    for (const entry of result.errors || []) {
      const nodeId = String(entry?.nodeId || this.rootComponentId);
      const message = String(entry?.error || 'QuickJS runtime error');
      this.nodeScriptErrors.set(nodeId, message);
      this.nodeScriptEnabled.set(nodeId, false);
      if (nodeId === this.rootComponentId) this.scriptError = message;
      const node = this.entityNodes.get(nodeId);
      if (node && node.parentId !== null) node.localAngularVelocity.set(0, 0, 0);
      this.scriptStatus = 'error';
      this.log(`[ERR] [${nodeId}] Runtime error: ${message}`);
    }

    const commands = (result.commands || []).slice(0, 256);
    this.latchedScriptCommands = (result.errors?.length || result.stopped)
      ? []
      : commands
        .filter(command => command?.scope === 'component'
          && LATCHED_SCRIPT_COMPONENT_COMMANDS.has(command.path))
        .map(command => cloneScriptData(command, null))
        .filter(Boolean);

    for (const command of commands) {
      const args = Array.isArray(command?.args) ? command.args : [];
      const executeResolved = resolved => {
        if (!resolved) {
          this.recordScriptCommandResult(command, false, 'unsupported_command');
          return;
        }
        try {
          const output = resolved.method.apply(resolved.target, args);
          this.recordScriptCommandResult(command, output);
        } catch (error) {
          this.recordScriptCommandResult(command, false, error);
        }
      };
      if (command?.scope === 'log') {
        this.log(String(args[0] ?? '').slice(0, 1000));
        continue;
      }
      if (command?.scope === 'control' && command.path === 'stop') {
        this.stopAllNodeScripts();
        break;
      }
      if (command?.scope === 'component' && SCRIPT_COMPONENT_COMMANDS.has(command.path)) {
        const api = this.getChildScriptApi(String(command.nodeId || this.rootComponentId));
        const resolved = this.resolveScriptCommandTarget(api, command.path);
        executeResolved(resolved);
        continue;
      }
      if (command?.scope === 'world' && SCRIPT_WORLD_COMMANDS.has(command.path)) {
        const resolved = this.resolveScriptCommandTarget(runtimeContext?.world, command.path);
        executeResolved(resolved);
        continue;
      }
      if (command?.scope === 'selection' && SCRIPT_SELECTION_COMMANDS.has(command.path)) {
        const resolved = this.resolveScriptCommandTarget(runtimeContext?.selection, command.path);
        executeResolved(resolved);
        continue;
      }
      this.recordScriptCommandResult(command, false, 'unsupported_command');
    }

    // `stopped` is an out-of-band control result, so a full ordinary command
    // buffer cannot turn self.stop() into a silent no-op.
    if (result.stopped && this.scriptStatus !== 'stopped') {
      this.stopAllNodeScripts();
    }

    this.lastAppliedForce.copy(this.appliedForces);
    this.lastAppliedTorque.copy(this.appliedTorques);
  }

  updateProgrammable(dt, inputState, runtimeContext) {
    if (this.scriptStatus === 'stopped') {
      this.appliedForces.set(0, 0, 0);
      this.appliedTorques.set(0, 0, 0);
      return;
    }
    const hasEnabledScript = [...this.compiledNodeScripts.keys()]
      .some(nodeId => this.isNodeScriptEnabled(nodeId));
    if (!hasEnabledScript) {
      this.appliedForces.set(0, 0, 0);
      this.appliedTorques.set(0, 0, 0);
      return;
    }

    this.capturePendingScriptEvents(inputState);

    this.powerUtilization = 0;
    this.applyScriptRuntimeResult(this.scriptRuntimeClient.takePendingResult(), runtimeContext);
    if (this.scriptStatus === 'stopped'
      || ![...this.compiledNodeScripts.keys()].some(nodeId => this.isNodeScriptEnabled(nodeId))) return;

    const nextTime = this.scriptRuntime + dt;
    const nextTick = this.tickCount + 1;
    const scheduledInput = {
      down: this.pendingScriptInputDown,
      pressed: [...this.pendingScriptInputPressed],
      released: [...this.pendingScriptInputReleased]
    };
    const snapshot = this.buildScriptRuntimeSnapshot(dt, scheduledInput, runtimeContext, nextTime, nextTick);
    const submission = this.scriptRuntimeClient.tick(snapshot, {
      // QuickJS runs on the page thread, but receives only this bounded host
      // callback rather than the mutable World/manager objects themselves.
      worldRaycast: runtimeContext?.world?.raycast,
      worldVoxelGet: runtimeContext?.world?.voxels?.get,
      worldMicroVoxelGet: runtimeContext?.world?.microVoxels?.get
    });
    if (!submission.submitted) {
      this.applyLatchedScriptCommands(runtimeContext);
      return;
    }
    this.scriptRuntime = nextTime;
    this.tickCount = nextTick;
    this.clearPendingScriptEvents();
    if (submission.result) this.applyScriptRuntimeResult(submission.result, runtimeContext);
  }

  recordScriptExecutionTime(nodeId, elapsedMs) {
    const id = String(nodeId || this.rootComponentId);
    if (!(elapsedMs > SLOW_SCRIPT_THRESHOLD_MS)) {
      this.slowScriptFrames.delete(id);
      return false;
    }

    const consecutive = (this.slowScriptFrames.get(id) || 0) + 1;
    this.slowScriptFrames.set(id, consecutive);
    if (consecutive === 1) {
      this.log(`[WARN] [${id}] Slow script frame: ${elapsedMs.toFixed(2)} ms (limit ${SLOW_SCRIPT_THRESHOLD_MS} ms)`);
    }
    if (consecutive < SLOW_SCRIPT_CONSECUTIVE_LIMIT) return false;

    const message = `Script exceeded ${SLOW_SCRIPT_THRESHOLD_MS} ms for ${SLOW_SCRIPT_CONSECUTIVE_LIMIT} consecutive frames and was disabled`;
    this.nodeScriptEnabled.set(id, false);
    this.nodeScriptErrors.set(id, message);
    this.slowScriptFrames.delete(id);
    if (id === this.rootComponentId) this.scriptError = message;
    const node = this.entityNodes.get(id);
    if (node && node.parentId !== null) node.localAngularVelocity.set(0, 0, 0);
    this.scriptStatus = 'error';
    this.log(`[ERR] [${id}] ${message}`);
    return true;
  }

  getCenterOfMassWorld() {
    return this.position.clone();
  }

  /**
   * Node ids rigidly attached to `nodeId`'s body: descendants reachable
   * through kinematic (or body-less) parts only. Dynamic parts integrate on
   * their own, so their cells never count as the ancestor's collision shape.
   */
  getAttachedNodeIds(nodeId) {
    const attached = new Set([nodeId]);
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      const node = this.entityNodes.get(id);
      if (!node?.children) continue;
      for (const childId of node.children) {
        const body = this.rigidBodies?.get(childId);
        if (body && body.type === BodyType.DYNAMIC) continue;
        attached.add(childId);
        stack.push(childId);
      }
    }
    return attached;
  }

  /** Collision-disabled components remain editable and rendered but do not
   * become terrain, player, entity, or raycast collision shapes. */
  isNodeCollisionEnabled(nodeId) {
    return this.getNodeCollisionEnabled(nodeId) !== false;
  }

  getCollisionSamplePoints(bodyId = null, includeAttached = false) {
    const cacheKey = `${bodyId || '*'}:${includeAttached ? 1 : 0}`;
    const cached = this.collisionSamplePointCache.get(cacheKey);
    if (cached?.version === this.collisionPoseVersion) return cached.points;
    const points = [];
    const low = 0.001;
    const high = 0.999;
    const attached = bodyId && includeAttached ? this.getAttachedNodeIds(bodyId) : null;
    const nodeTransforms = new Map();

    const transformFor = entityId => {
      let transform = nodeTransforms.get(entityId);
      if (transform) return transform;
      const node = this.entityNodes.get(entityId) || this.entityNodes.get(this.rootComponentId);
      node?.group?.updateWorldMatrix?.(true, false);
      transform = node?.group
        ? { matrix: node.group.matrixWorld, pivot: node.pivotLocal }
        : null;
      nodeTransforms.set(entityId, transform);
      return transform;
    };

    const hasMicro = (this.collisionSurfaceEntries || this.collisionEntries || []).some(
      (cell: any) => (cell.span ?? 5) < 5
    );
    const sourceEntries: any[] = hasMicro && this.collisionTerrainBoxes?.length
      ? this.collisionTerrainBoxes
      : (this.collisionSurfaceEntries || this.collisionEntries);

    for (const cell of sourceEntries) {
      if (bodyId && cell.entityId !== bodyId && (!attached || !attached.has(cell.entityId))) continue;
      if (!this.isNodeCollisionEnabled(cell.entityId)) continue;
      const transform = transformFor(cell.entityId);
      // Box corners in flat entity-local space, inset one millimetre so the
      // samples stay strictly inside the 0.2-quantized collision box.
      const spanX = cell.spanX ?? cell.span;
      const spanY = cell.spanY ?? cell.span;
      const spanZ = cell.spanZ ?? cell.span;
      const sx = spanX * MICRO_SIZE;
      const sy = spanY * MICRO_SIZE;
      const sz = spanZ * MICRO_SIZE;
      const x0 = cell.x * MICRO_SIZE, y0 = cell.y * MICRO_SIZE, z0 = cell.z * MICRO_SIZE;
      // Point probes provide the swept contact manifold; exact OBB-vs-terrain
      // SAT in ContraptionPhysics covers face-edge and edge-edge intersections
      // that no finite set of surface samples can represent reliably.
      for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
          for (let iz = 0; iz < 2; iz++) {
            const point = new THREE.Vector3(
              x0 + (ix ? high : low) * sx,
              y0 + (iy ? high : low) * sy,
              z0 + (iz ? high : low) * sz
            );
            if (transform) point.sub(transform.pivot).applyMatrix4(transform.matrix);
            else point.copy(this.localToWorld(point));
            points.push(point);
          }
        }
      }

      // If this is a merged box spanning multiple microblocks, adaptively sample
      // top/bottom faces and edges with ~0.5m spacing so large surfaces don't miss terrain features.
      const nx = Math.max(1, Math.round(sx / 0.5));
      const nz = Math.max(1, Math.round(sz / 0.5));
      if (hasMicro && (nx > 1 || nz > 1)) {
        for (const dy of [low, high]) {
          for (let ix = 0; ix <= nx; ix++) {
            for (let iz = 0; iz <= nz; iz++) {
              if ((ix === 0 || ix === nx) && (iz === 0 || iz === nz)) continue;
              const fx = ix === 0 ? low : ix === nx ? high : ix / nx;
              const fz = iz === 0 ? low : iz === nz ? high : iz / nz;
              const point = new THREE.Vector3(
                x0 + fx * sx,
                y0 + dy * sy,
                z0 + fz * sz
              );
              if (transform) point.sub(transform.pivot).applyMatrix4(transform.matrix);
              else point.copy(this.localToWorld(point));
              points.push(point);
            }
          }
        }
        const ny = Math.max(1, Math.round(sy / 0.5));
        if (ny > 1) {
          for (let iy = 1; iy < ny; iy++) {
            const fy = iy / ny;
            for (const ix of [low, high]) {
              for (const iz of [low, high]) {
                const point = new THREE.Vector3(
                  x0 + ix * sx,
                  y0 + fy * sy,
                  z0 + iz * sz
                );
                if (transform) point.sub(transform.pivot).applyMatrix4(transform.matrix);
                else point.copy(this.localToWorld(point));
                points.push(point);
              }
            }
          }
        }
      } else {
        // The two Y-face centres stabilize broad floor/ceiling contact without
        // biasing a wall manifold toward the bottom of the body. Keeping the
        // pair symmetric also prevents centred wall forces from inventing spin.
        for (const dy of [low, high]) {
          const faceCenter = new THREE.Vector3(
            x0 + 0.5 * sx,
            y0 + dy * sy,
            z0 + 0.5 * sz
          );
          if (transform) faceCenter.sub(transform.pivot).applyMatrix4(transform.matrix);
          else faceCenter.copy(this.localToWorld(faceCenter));
          points.push(faceCenter);
        }
      }
    }

    this.collisionSamplePointCache.set(cacheKey, {
      version: this.collisionPoseVersion,
      points
    });
    return points;
  }

  /** Exact merged collision bounds for the entity solver. */
  getPhysicsCollisionWorldAABBs() {
    return this.getCollisionWorldAABBs(false, true);
  }

  /** World-space bounds, preserving individual voxels by default for player
   * collision. Rotated boxes transform all eight corners in both poses. */
  getCollisionWorldAABBs(surfaceOnly = false, merged = false) {
    const cacheKey: 'all' | 'surface' | 'merged' = merged ? 'merged' : surfaceOnly ? 'surface' : 'all';
    if (
      this.collisionWorldAabbCache?.version === this.collisionPoseVersion
      && this.collisionWorldAabbCache[cacheKey]
    ) {
      return this.collisionWorldAabbCache[cacheKey];
    }
    const boxes = [];
    const nodeTransforms = new Map();

    const entries: any[] = merged ? this.collisionPhysicsBoxes : surfaceOnly
      ? (this.collisionSurfaceEntries || this.collisionEntries)
      : this.collisionEntries;
    for (const cell of entries) {
      if (!this.isNodeCollisionEnabled(cell.entityId)) continue;
      const node = this.entityNodes.get(cell.entityId) || this.entityNodes.get(this.rootComponentId);
      let transform = nodeTransforms.get(cell.entityId);
      if (!transform) {
        node?.group?.updateWorldMatrix?.(true, false);
        transform = node?.group
          ? { matrix: node.group.matrixWorld, pivot: node.pivotLocal }
          : null;
        nodeTransforms.set(cell.entityId, transform);
      }
      const x0 = cell.x * MICRO_SIZE, x1 = (cell.x + (cell.spanX ?? cell.span)) * MICRO_SIZE;
      const y0 = cell.y * MICRO_SIZE, y1 = (cell.y + (cell.spanY ?? cell.span)) * MICRO_SIZE;
      const z0 = cell.z * MICRO_SIZE, z1 = (cell.z + (cell.spanZ ?? cell.span)) * MICRO_SIZE;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let currentMinX = Infinity, currentMinY = Infinity, currentMinZ = Infinity;
      let currentMaxX = -Infinity, currentMaxY = -Infinity, currentMaxZ = -Infinity;
      let previousMinX = Infinity, previousMinY = Infinity, previousMinZ = Infinity;
      let previousMaxX = -Infinity, previousMaxY = -Infinity, previousMaxZ = -Infinity;

      for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
          for (let iz = 0; iz < 2; iz++) {
            const cx = ix ? x1 : x0;
            const cy = iy ? y1 : y0;
            const cz = iz ? z1 : z0;
            const corner = new THREE.Vector3(cx, cy, cz);
            if (transform) corner.sub(transform.pivot).applyMatrix4(transform.matrix);
            else corner.copy(this.localToWorld(corner));
            minX = Math.min(minX, corner.x);
            minY = Math.min(minY, corner.y);
            minZ = Math.min(minZ, corner.z);
            maxX = Math.max(maxX, corner.x);
            maxY = Math.max(maxY, corner.y);
            maxZ = Math.max(maxZ, corner.z);
            currentMinX = Math.min(currentMinX, corner.x);
            currentMinY = Math.min(currentMinY, corner.y);
            currentMinZ = Math.min(currentMinZ, corner.z);
            currentMaxX = Math.max(currentMaxX, corner.x);
            currentMaxY = Math.max(currentMaxY, corner.y);
            currentMaxZ = Math.max(currentMaxZ, corner.z);
            if (node?.previousWorldMatrix) {
              const previousCorner = new THREE.Vector3(cx, cy, cz)
                .sub(node.pivotLocal).applyMatrix4(node.previousWorldMatrix);
              minX = Math.min(minX, previousCorner.x);
              minY = Math.min(minY, previousCorner.y);
              minZ = Math.min(minZ, previousCorner.z);
              maxX = Math.max(maxX, previousCorner.x);
              maxY = Math.max(maxY, previousCorner.y);
              maxZ = Math.max(maxZ, previousCorner.z);
              previousMinX = Math.min(previousMinX, previousCorner.x);
              previousMinY = Math.min(previousMinY, previousCorner.y);
              previousMinZ = Math.min(previousMinZ, previousCorner.z);
              previousMaxX = Math.max(previousMaxX, previousCorner.x);
              previousMaxY = Math.max(previousMaxY, previousCorner.y);
              previousMaxZ = Math.max(previousMaxZ, previousCorner.z);
            }
          }
        }
      }

      boxes.push({
        minX, minY, minZ,
        maxX, maxY, maxZ,
        currentMinX, currentMinY, currentMinZ,
        currentMaxX, currentMaxY, currentMaxZ,
        previousMinX: Number.isFinite(previousMinX) ? previousMinX : currentMinX,
        previousMinY: Number.isFinite(previousMinY) ? previousMinY : currentMinY,
        previousMinZ: Number.isFinite(previousMinZ) ? previousMinZ : currentMinZ,
        previousMaxX: Number.isFinite(previousMaxX) ? previousMaxX : currentMaxX,
        previousMaxY: Number.isFinite(previousMaxY) ? previousMaxY : currentMaxY,
        previousMaxZ: Number.isFinite(previousMaxZ) ? previousMaxZ : currentMaxZ,
        cell,
        entityId: cell.entityId,
        bodyId: cell.entityId,
        contraption: this
      });
    }

    if (this.collisionWorldAabbCache?.version !== this.collisionPoseVersion) {
      this.collisionWorldAabbCache = { version: this.collisionPoseVersion };
    }
    this.collisionWorldAabbCache[cacheKey] = boxes;
    return boxes;
  }

  raycastCollisionCells(rayOrigin, rayDirection, maxDistance = 15) {
    let closest = null;
    let closestDistance = maxDistance;
    const nodeRays = new Map();

    for (const block of this.blocks) {
      const entityId = block.entityId || this.rootComponentId;
      const node = this.entityNodes.get(entityId) || this.entityNodes.get(this.rootComponentId);
      if (!node) continue;

      let nodeRay = nodeRays.get(node.id);
      if (!nodeRay) {
        node.group.updateWorldMatrix(true, false);
        const localOrigin = node.group.worldToLocal(rayOrigin.clone());
        const worldRotation = node.group.getWorldQuaternion(new THREE.Quaternion());
        const localDirection = rayDirection.clone().applyQuaternion(worldRotation.invert()).normalize();
        nodeRay = { ray: new THREE.Ray(localOrigin, localDirection), node };
        nodeRays.set(node.id, nodeRay);
      }

      const size = block.size || 1;
      const min = new THREE.Vector3(block.localX, block.localY, block.localZ).sub(node.pivotLocal);
      const max = min.clone().addScalar(size);
      const localPoint = nodeRay.ray.intersectBox(new THREE.Box3(min, max), new THREE.Vector3());
      if (!localPoint) continue;

      const worldPoint = node.group.localToWorld(localPoint.clone());
      const distance = rayOrigin.distanceTo(worldPoint);
      if (distance <= closestDistance) {
        closestDistance = distance;

        // Calculate face normal in local node space
        const dMinX = Math.abs(localPoint.x - min.x);
        const dMaxX = Math.abs(localPoint.x - max.x);
        const dMinY = Math.abs(localPoint.y - min.y);
        const dMaxY = Math.abs(localPoint.y - max.y);
        const dMinZ = Math.abs(localPoint.z - min.z);
        const dMaxZ = Math.abs(localPoint.z - max.z);
        const minDist = Math.min(dMinX, dMaxX, dMinY, dMaxY, dMinZ, dMaxZ);
        const localNormal = new THREE.Vector3();
        if (minDist === dMinX) localNormal.set(-1, 0, 0);
        else if (minDist === dMaxX) localNormal.set(1, 0, 0);
        else if (minDist === dMinY) localNormal.set(0, -1, 0);
        else if (minDist === dMaxY) localNormal.set(0, 1, 0);
        else if (minDist === dMinZ) localNormal.set(0, 0, -1);
        else if (minDist === dMaxZ) localNormal.set(0, 0, 1);
        closest = this.buildCollisionRaycastHit(
          block, node, localPoint, worldPoint, distance, localNormal
        );
      }
    }
    return closest;
  }

  /**
   * Pick entity voxels in the same bent coordinate space used by the renderer.
   * Each face is split exactly like createVoxelMesh, then its transformed flat
   * vertices are passed through bendPoint just as the vertex shader does.
   */
  raycastBentCollisionCells(rayOriginBent, rayDirectionBent, maxDistance = 15) {
    const ray = new THREE.Ray(rayOriginBent.clone(), rayDirectionBent.clone().normalize());
    const barycentric = new THREE.Vector3();
    const flatCenter = new THREE.Vector3();
    const bentCenter = new THREE.Vector3();
    const centerDelta = new THREE.Vector3();
    const updatedNodes = new Set();
    let closest = null;
    let closestDistance = maxDistance;

    for (const block of this.blocks) {
      const node = this.entityNodes.get(block.entityId || this.rootComponentId)
        || this.entityNodes.get(this.rootComponentId);
      if (!node) continue;
      if (!updatedNodes.has(node)) {
        node.group.updateWorldMatrix(true, false);
        updatedNodes.add(node);
      }

      const size = block.size || 1;
      const baseX = block.localX - node.pivotLocal.x;
      const baseY = block.localY - node.pivotLocal.y;
      const baseZ = block.localZ - node.pivotLocal.z;
      // Most voxels are nowhere near the crosshair. A conservative bent-space
      // sphere avoids building twelve triangles for those cells. Its radius is
      // scaled by the local torus Jacobian so picking remains correct even for
      // flying entities far above the terrain, where tube-direction stretching
      // is larger than it is at normal building height.
      flatCenter.set(
        baseX + size / 2,
        baseY + size / 2,
        baseZ + size / 2
      ).applyMatrix4(node.group.matrixWorld);
      bendPoint(flatCenter.x, flatCenter.y, flatCenter.z, bentCenter);
      const rho = Math.min(TORUS_RHO + flatCenter.y - TORUS_GREF, TORUS_MAX_RHO);
      const thetaScale = Math.abs((TORUS_R + rho * Math.cos(flatCenter.z * TORUS_K_PHI)) / TORUS_R);
      const phiScale = Math.abs(rho / TORUS_RHO);
      const maxLocalScale = Math.max(1, thetaScale, phiScale);
      const pickRadius = size * Math.sqrt(3) * 0.5 * maxLocalScale * 1.02 + 0.02;
      const centerDistance = centerDelta.copy(bentCenter).sub(rayOriginBent).dot(ray.direction);
      if (centerDistance < -pickRadius || centerDistance > closestDistance + pickRadius) continue;
      if (ray.distanceSqToPoint(bentCenter) > pickRadius * pickRadius) continue;

      for (const face of COLLISION_RAYCAST_FACES) {
        const localCorners = face.quad.map(([x, y, z]) => new THREE.Vector3(
          baseX + x * size,
          baseY + y * size,
          baseZ + z * size
        ));
        const flatCorners = localCorners.map(corner => corner.clone().applyMatrix4(node.group.matrixWorld));
        const bentCorners = flatCorners.map(corner => bendPoint(corner.x, corner.y, corner.z));

        for (const [ia, ib, ic] of [[0, 1, 2], [0, 2, 3]]) {
          const bentPoint = new THREE.Vector3();
          if (!intersectCollisionTriangleInclusive(
            ray, bentCorners[ia], bentCorners[ib], bentCorners[ic], bentPoint, barycentric
          )) continue;
          const distance = rayOriginBent.distanceTo(bentPoint);
          if (distance > closestDistance) continue;
          const localPoint = localCorners[ia].clone().multiplyScalar(barycentric.x)
            .addScaledVector(localCorners[ib], barycentric.y)
            .addScaledVector(localCorners[ic], barycentric.z);
          const worldPoint = flatCorners[ia].clone().multiplyScalar(barycentric.x)
            .addScaledVector(flatCorners[ib], barycentric.y)
            .addScaledVector(flatCorners[ic], barycentric.z);
          const localNormal = new THREE.Vector3(...face.normal);

          closestDistance = distance;
          closest = this.buildCollisionRaycastHit(
            block, node, localPoint, worldPoint, distance, localNormal
          );
        }
      }
    }
    return closest;
  }

  buildCollisionRaycastHit(block, node, localPoint, worldPoint, distance, localNormal) {
    const size = block.size || 1;
    const worldNormal = localNormal.clone()
      .applyQuaternion(node.group.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    const cellX = Math.floor(block.localX + 1e-6);
    const cellY = Math.floor(block.localY + 1e-6);
    const cellZ = Math.floor(block.localZ + 1e-6);
    const placeCell = {
      x: cellX + localNormal.x,
      y: cellY + localNormal.y,
      z: cellZ + localNormal.z
    };

    let placeMicroX, placeMicroY, placeMicroZ;
    if (size < 1) {
      placeMicroX = block.localX + localNormal.x * 0.2;
      placeMicroY = block.localY + localNormal.y * 0.2;
      placeMicroZ = block.localZ + localNormal.z * 0.2;
    } else {
      const rawBlockLocal = localPoint.clone().add(node.pivotLocal);
      placeMicroX = localNormal.x !== 0
        ? (localNormal.x > 0 ? block.localX + 1 : block.localX - 0.2)
        : Math.floor(rawBlockLocal.x * 5) / 5;
      placeMicroY = localNormal.y !== 0
        ? (localNormal.y > 0 ? block.localY + 1 : block.localY - 0.2)
        : Math.floor(rawBlockLocal.y * 5) / 5;
      placeMicroZ = localNormal.z !== 0
        ? (localNormal.z > 0 ? block.localZ + 1 : block.localZ - 0.2)
        : Math.floor(rawBlockLocal.z * 5) / 5;
    }

    return {
      contraption: this,
      entityNode: node,
      entityId: node.id,
      distance,
      point: worldPoint,
      cell: { x: cellX, y: cellY, z: cellZ },
      block,
      kind: size < 1 ? 'micro' : 'standard',
      normal: localNormal,
      worldNormal,
      placeCell,
      placeMicroPos: {
        localX: Math.round(placeMicroX * 5) / 5,
        localY: Math.round(placeMicroY * 5) / 5,
        localZ: Math.round(placeMicroZ * 5) / 5
      },
      color: block.color
    };
  }

  getBlockWorldCenter(block) {
    const size = block.size || 1;
    return this.entityLocalToWorld(block.entityId || this.rootComponentId, new THREE.Vector3(
      block.localX + size / 2,
      block.localY + size / 2,
      block.localZ + size / 2
    ));
  }

  /**
   * Return the world-axis-aligned bounds of the visible block after applying
   * the complete root -> child -> descendant transform chain.
   *
   * A transformed block cannot be represented by worldCenter +/- size / 2:
   * rotation makes its world extents wider on some axes. Selector range tests
   * use these eight transformed corners so moving/rotating nested components
   * remain selectable, including 0.2 micro voxels.
   */
  getBlockWorldBounds(block, target = new THREE.Box3()) {
    target.makeEmpty();
    const entityId = block.entityId || this.rootComponentId;
    const node = this.entityNodes.get(entityId) || this.entityNodes.get(this.rootComponentId);
    if (!node) return target;

    node.group.updateWorldMatrix(true, false);
    const size = block.size || 1;
    const corner = new THREE.Vector3();
    for (const dx of [0, size]) {
      for (const dy of [0, size]) {
        for (const dz of [0, size]) {
          corner.set(
            block.localX + dx - node.pivotLocal.x,
            block.localY + dy - node.pivotLocal.y,
            block.localZ + dz - node.pivotLocal.z
          ).applyMatrix4(node.group.matrixWorld);
          target.expandByPoint(corner);
        }
      }
    }
    return target;
  }

  updateTransform() {
    this.rootGroup.position.copy(this.position);
    this.rootGroup.quaternion.copy(this.quaternion);
    this.rootGroup.updateMatrixWorld(true);
    this.invalidateCollisionPoseCache();
  }

  /** Apply a temporary presentation pose between the last two fixed entity
   * updates. Physics state is restored immediately after the Three.js render. */
  beginRenderInterpolation(alpha) {
    if (this.renderInterpolated) return;
    const amount = Math.max(0, Math.min(1, Number(alpha) || 0));
    this.renderSimulationPosition.copy(this.position);
    this.renderSimulationQuaternion.copy(this.quaternion);

    this.rootGroup.position.lerpVectors(
      this.previousPosition,
      this.renderSimulationPosition,
      amount
    );
    this.rootGroup.quaternion.slerpQuaternions(
      this.previousQuaternion,
      this.renderSimulationQuaternion,
      amount
    );
    for (const node of this.entityNodes.values()) {
      if (node.parentId === null) continue;
      node.group.position.lerpVectors(
        node.previousLocalPosition || node.localPosition,
        node.localPosition,
        amount
      );
      node.group.quaternion.slerpQuaternions(
        node.previousLocalQuaternion || node.localQuaternion,
        node.localQuaternion,
        amount
      );
    }
    this.rootGroup.updateMatrixWorld(true);
    this.renderInterpolated = true;
  }

  endRenderInterpolation() {
    if (!this.renderInterpolated) return;
    this.rootGroup.position.copy(this.renderSimulationPosition);
    this.rootGroup.quaternion.copy(this.renderSimulationQuaternion);
    for (const node of this.entityNodes.values()) {
      if (node.parentId === null) continue;
      node.group.position.copy(node.localPosition);
      node.group.quaternion.copy(node.localQuaternion);
    }
    this.rootGroup.updateMatrixWorld(true);
    this.renderInterpolated = false;
  }

  invalidateCollisionPoseCache() {
    this.collisionPoseVersion = (this.collisionPoseVersion || 0) + 1;
    this.collisionWorldAabbCache = null;
    this.collisionSamplePointCache?.clear();
  }

  /**
   * Pick a different periodic representative of this entity's flat
   * coordinates: shift every absolute flat coordinate by (dx, dz), where each
   * component is an integer multiple of the torus period. Bent rendering,
   * wrapped chunk ids, wrapped terrain lookups, and torus-distance queries are
   * all invariant to this shift, so it changes no physics. It exists so every
   * entity can be kept inside one common periodic window (the local
   * player's), where flat-space distance equals torus distance - without
   * that, entities on opposite sides of a seam are a whole period apart in
   * flat space and never collide.
   */
  shiftFlatCoordinates(dx, dz) {
    if (dx === 0 && dz === 0) return;
    if (this.position) {
      this.position.x += dx;
      this.position.z += dz;
    }
    if (this.previousPosition) {
      this.previousPosition.x += dx;
      this.previousPosition.z += dz;
    }
    if (this.renderSimulationPosition) {
      this.renderSimulationPosition.x += dx;
      this.renderSimulationPosition.z += dz;
    }
    for (const body of this.rigidBodies.values()) {
      if (body.position !== this.position) {
        body.position.x += dx;
        body.position.z += dz;
      }
      if (body.previousKinematicPosition) {
        body.previousKinematicPosition.x += dx;
        body.previousKinematicPosition.z += dz;
      }
    }
    for (const constraint of this.constraintDefinitions.values()) {
      // An external anchor is an absolute point; keep it in the same periodic
      // window as the entity it holds so the constraint stays consistent.
      if (constraint.bodyA === null && Array.isArray(constraint.anchorA)) {
        constraint.anchorA[0] += dx;
        constraint.anchorA[2] += dz;
      }
    }
    this.invalidateCollisionPoseCache();
  }

  dispose() {
    this.scriptRuntimeClient.dispose();
    this.setHighlightedNode(null);
    this.clearGlueSelection();
    if (this.rootGroup && this.scene) {
      this.scene.remove(this.rootGroup);
      this.rootGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        }
      });
    }
  }
}

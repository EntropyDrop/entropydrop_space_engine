import * as THREE from 'three';
import { DEFAULT_BLOCK_COLOR, normalizeColor } from './BlockTypes.ts';
import {
  computeChunkBentSphere,
  getWorldProjectionRevision,
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  unwrapPeriodicNear,
  wrapMicroX,
  wrapMicroZ
} from '../torus/TorusWorld.ts';

export const MICRO_DIVISIONS = 5;
export const MICRO_SIZE = 1 / MICRO_DIVISIONS;
const STANDARD_CHUNK_MICRO_SIZE = 16 * MICRO_DIVISIONS;
// Smaller than a standard terrain chunk so a dense imported model cannot turn
// one mesh rebuild into a long main-thread task. These are meshing partitions,
// not distance-based LOD: every 0.2 m cell remains represented exactly.
const MICRO_MESH_CHUNK_SIZE = 4 * MICRO_DIVISIONS;
const MICRO_MESH_CHUNKS_PER_STANDARD_AXIS = STANDARD_CHUNK_MICRO_SIZE / MICRO_MESH_CHUNK_SIZE;
const MICRO_WORLD_SIZE_X = TORUS_SIZE_X * MICRO_DIVISIONS;
const MICRO_WORLD_SIZE_Z = TORUS_SIZE_Z * MICRO_DIVISIONS;

const POSITIVE_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
const NEGATIVE_QUAD = [[0, 0], [0, 1], [1, 1], [1, 0]] as const;
const MESH_TIME_CHECK_INTERVAL = 256;

type MeshBuildPhase = 'scan' | 'mask' | 'greedy' | 'write';

type MicroMeshBuildJob = {
  chunkKey: string;
  standardChunkKey: string;
  revision: number;
  chunkCx: number;
  chunkCz: number;
  originMx: number;
  originMz: number;
  phase: MeshBuildPhase;
  cellIterator: Iterator<number>;
  minMicroY: number;
  maxMicroY: number;
  dimensions: [number, number, number] | null;
  axis: number;
  slice: number;
  u: number;
  v: number;
  maskWidth: number;
  maskHeight: number;
  mask: Int32Array | null;
  maskIndex: number;
  greedyIndex: number;
  quads: number[];
  positions: Uint16Array | null;
  normals: Int8Array | null;
  colors: Uint8Array | null;
  indices: Uint16Array | Uint32Array | null;
  writeQuadIndex: number;
};

type DeferredMeshPublication = {
  job: MicroMeshBuildJob;
  mesh: THREE.Mesh | null;
  barrierKey: string;
};

export type MicroChunkClearCursor = {
  targetMeshChunks: string[];
  cellIterators: Iterator<number>[];
  iteratorIndex: number;
  removed: number;
  complete: boolean;
};

// All valid micro coordinates fit exactly in JavaScript's 53-bit integer
// range. Numeric occupancy keys avoid allocating six strings per cell while
// rebuilding a large mesh.
function packedMicroKey(mx: number, my: number, mz: number): number {
  const wrappedX = mx >= 0 && mx < MICRO_WORLD_SIZE_X ? mx : wrapMicroX(mx);
  const wrappedZ = mz >= 0 && mz < MICRO_WORLD_SIZE_Z ? mz : wrapMicroZ(mz);
  return (my * MICRO_WORLD_SIZE_Z + wrappedZ) * MICRO_WORLD_SIZE_X + wrappedX;
}

function unpackMicroKey(value: number): [number, number, number] {
  const mx = value % MICRO_WORLD_SIZE_X;
  const plane = (value - mx) / MICRO_WORLD_SIZE_X;
  const mz = plane % MICRO_WORLD_SIZE_Z;
  const my = (plane - mz) / MICRO_WORLD_SIZE_Z;
  return [mx, my, mz];
}

function unpackMicroY(value: number): number {
  return Math.floor(value / MICRO_WORLD_SIZE_X / MICRO_WORLD_SIZE_Z);
}

function key(mx, my, mz) {
  return `${wrapMicroX(mx)},${my},${wrapMicroZ(mz)}`;
}

function meshChunkKey(mx, mz) {
  return `${Math.floor(wrapMicroX(mx) / MICRO_MESH_CHUNK_SIZE)},${Math.floor(wrapMicroZ(mz) / MICRO_MESH_CHUNK_SIZE)}`;
}

function standardChunkKeyForMeshChunk(meshKey: string): string {
  const [meshCx, meshCz] = meshKey.split(',').map(Number);
  return `${Math.floor(meshCx / MICRO_MESH_CHUNKS_PER_STANDARD_AXIS)},${Math.floor(meshCz / MICRO_MESH_CHUNKS_PER_STANDARD_AXIS)}`;
}

export class MicroVoxelLayer {
  cells: Map<string, number>;
  parts: Map<string, any>;
  dirty: boolean;
  group: THREE.Group;
  /** Compatibility alias for callers that only need to know whether a mesh exists. */
  mesh: any;
  meshChunks: Map<string, THREE.Mesh>;
  private chunkCells: Map<string, Set<number>>;
  private packedColors: Map<number, number>;
  private dirtyMeshChunks: Set<string>;
  private meshChunkRevisions: Map<string, number>;
  /** Old published values for cells changed while a partition is rebuilt. */
  private publishedCollisionSnapshots: Map<string, Map<number, number | null>>;
  private activeMeshBuild: MicroMeshBuildJob | null;
  private deferredPublicationChunkKeys: Set<string> | null;
  private deferredMeshPublications: Map<string, DeferredMeshPublication>;
  private recentlyRebuiltMeshes: THREE.Mesh[];
  private meshTempColor: THREE.Color;
  material: THREE.MeshStandardMaterial;

  constructor() {
    this.cells = new Map();
    this.parts = new Map();
    this.dirty = false;
    this.group = new THREE.Group();
    this.group.name = 'MicroVoxelLayer';
    this.mesh = null;
    this.meshChunks = new Map();
    this.chunkCells = new Map();
    this.packedColors = new Map();
    this.dirtyMeshChunks = new Set();
    this.meshChunkRevisions = new Map();
    this.publishedCollisionSnapshots = new Map();
    this.activeMeshBuild = null;
    this.deferredPublicationChunkKeys = null;
    this.deferredMeshPublications = new Map();
    this.recentlyRebuiltMeshes = [];
    this.meshTempColor = new THREE.Color();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.65,
      metalness: 0.15
    });
  }

  get(mx, my, mz) {
    return this.cells.get(key(mx, my, mz)) ?? null;
  }

  has(mx, my, mz) {
    return this.cells.has(key(mx, my, mz));
  }

  private invalidateMeshChunk(chunkKey: string) {
    // A staged mesh is immutable for the revision that produced it. Retire it
    // as soon as a newer edit invalidates that revision; otherwise an inactive
    // boundary companion cannot rebuild and its stale deferred entry can hold
    // the owning standard chunk's publication barrier forever.
    const deferred = this.deferredMeshPublications.get(chunkKey);
    if (deferred) {
      deferred.mesh?.geometry.dispose();
      this.deferredMeshPublications.delete(chunkKey);
    }
    this.dirtyMeshChunks.add(chunkKey);
    this.meshChunkRevisions.set(chunkKey, (this.meshChunkRevisions.get(chunkKey) ?? 0) + 1);
    this.dirty = true;
  }

  private markMeshChunkDirty(mx, mz) {
    for (const chunkKey of this.affectedMeshChunkKeys(mx, mz)) {
      this.invalidateMeshChunk(chunkKey);
    }
  }

  private affectedMeshChunkKeys(mx: number, mz: number) {
    const wrappedX = wrapMicroX(mx);
    const wrappedZ = wrapMicroZ(mz);
    const affected = [meshChunkKey(wrappedX, wrappedZ)];
    const localX = wrappedX % MICRO_MESH_CHUNK_SIZE;
    const localZ = wrappedZ % MICRO_MESH_CHUNK_SIZE;
    if (localX === 0) affected.push(meshChunkKey(wrappedX - 1, wrappedZ));
    if (localX === MICRO_MESH_CHUNK_SIZE - 1) {
      affected.push(meshChunkKey(wrappedX + 1, wrappedZ));
    }
    if (localZ === 0) affected.push(meshChunkKey(wrappedX, wrappedZ - 1));
    if (localZ === MICRO_MESH_CHUNK_SIZE - 1) {
      affected.push(meshChunkKey(wrappedX, wrappedZ + 1));
    }
    return affected;
  }

  /** Promote a local edit and its boundary companions ahead of background work. */
  prioritizeMeshAt(mx: number, mz: number) {
    const prioritized = this.affectedMeshChunkKeys(mx, mz)
      .filter(chunkKey => this.dirtyMeshChunks.has(chunkKey));
    if (prioritized.length === 0) return;

    // A resumable background build is no longer the highest-priority work once
    // direct input dirties another partition. Put it back in the queue before
    // reordering so the clicked partition can use the very next frame slice.
    if (
      this.activeMeshBuild
      && !prioritized.includes(this.activeMeshBuild.chunkKey)
    ) {
      this.dirtyMeshChunks.add(this.activeMeshBuild.chunkKey);
      this.activeMeshBuild = null;
    }

    // Reorder the one authoritative dirty queue instead of maintaining a
    // second eligibility set that can drift out of sync after invalidation.
    const reordered = new Set(prioritized);
    for (const chunkKey of this.dirtyMeshChunks) reordered.add(chunkKey);
    this.dirtyMeshChunks = reordered;
  }

  /** A standard cell can touch two micro partitions on either horizontal axis. */
  prioritizeStandardCell(wx: number, wz: number) {
    const baseMx = wx * MICRO_DIVISIONS;
    const baseMz = wz * MICRO_DIVISIONS;
    for (const mx of [baseMx, baseMx + MICRO_DIVISIONS - 1]) {
      for (const mz of [baseMz, baseMz + MICRO_DIVISIONS - 1]) {
        this.prioritizeMeshAt(mx, mz);
      }
    }
  }

  private addChunkCell(packedKey: number, mx, mz) {
    const chunkKey = meshChunkKey(mx, mz);
    let cells = this.chunkCells.get(chunkKey);
    if (!cells) {
      cells = new Set();
      this.chunkCells.set(chunkKey, cells);
    }
    cells.add(packedKey);
  }

  private removeChunkCell(packedKey: number, mx, mz) {
    const chunkKey = meshChunkKey(mx, mz);
    const cells = this.chunkCells.get(chunkKey);
    cells?.delete(packedKey);
    if (cells?.size === 0) this.chunkCells.delete(chunkKey);
  }

  /** Journal one cell before mutation so picking stays on the rendered mesh. */
  private preservePublishedCollisionCell(mx: number, my: number, mz: number) {
    const chunkKey = meshChunkKey(mx, mz);
    // No mesh means this partition currently presents empty space. New live
    // cells remain unpickable through getPublishedCollisionColor until their
    // first mesh publication.
    if (!this.meshChunks.has(chunkKey)) return;
    let snapshot = this.publishedCollisionSnapshots.get(chunkKey);
    if (!snapshot) {
      snapshot = new Map();
      this.publishedCollisionSnapshots.set(chunkKey, snapshot);
    }

    const packedKey = packedMicroKey(mx, my, mz);
    if (!snapshot.has(packedKey)) {
      snapshot.set(packedKey, this.packedColors.get(packedKey) ?? null);
    }
  }

  set(mx, my, mz, color = DEFAULT_BLOCK_COLOR, part = null) {
    mx = wrapMicroX(mx);
    mz = wrapMicroZ(mz);
    const normalized = normalizeColor(color);
    const cellKey = key(mx, my, mz);
    const packedKey = packedMicroKey(mx, my, mz);
    const isNew = !this.cells.has(cellKey);
    const currentPart = this.parts.get(cellKey) ?? null;
    if (this.cells.get(cellKey) === normalized && currentPart === part) return false;
    this.preservePublishedCollisionCell(mx, my, mz);
    this.cells.set(cellKey, normalized);
    this.packedColors.set(packedKey, normalized);
    if (isNew) this.addChunkCell(packedKey, mx, mz);
    if (part) this.parts.set(cellKey, part);
    else this.parts.delete(cellKey);
    this.markMeshChunkDirty(mx, mz);
    return true;
  }

  delete(mx, my, mz) {
    mx = wrapMicroX(mx);
    mz = wrapMicroZ(mz);
    const cellKey = key(mx, my, mz);
    const packedKey = packedMicroKey(mx, my, mz);
    if (this.cells.has(cellKey)) this.preservePublishedCollisionCell(mx, my, mz);
    const removed = this.cells.delete(cellKey);
    this.parts.delete(cellKey);
    if (removed) {
      this.packedColors.delete(packedKey);
      this.removeChunkCell(packedKey, mx, mz);
      this.markMeshChunkDirty(mx, mz);
    }
    return removed;
  }

  subdivide(wx, wy, wz, color = DEFAULT_BLOCK_COLOR) {
    const baseX = wx * MICRO_DIVISIONS;
    const baseY = wy * MICRO_DIVISIONS;
    const baseZ = wz * MICRO_DIVISIONS;
    const normalized = normalizeColor(color);
    for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
      for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
        for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
          const mx = baseX + dx;
          const my = baseY + dy;
          const mz = baseZ + dz;
          this.set(mx, my, mz, normalized, null);
        }
      }
    }
    return MICRO_DIVISIONS ** 3;
  }

  clearStandardCell(wx, wy, wz) {
    const baseX = wx * MICRO_DIVISIONS;
    const baseY = wy * MICRO_DIVISIONS;
    const baseZ = wz * MICRO_DIVISIONS;
    let removed = 0;
    for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
      for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
        for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
          if (this.delete(baseX + dx, baseY + dy, baseZ + dz)) removed++;
        }
      }
    }
    return removed;
  }

  hasAnyInStandardCell(wx, wy, wz) {
    const baseX = wx * MICRO_DIVISIONS;
    const baseY = wy * MICRO_DIVISIONS;
    const baseZ = wz * MICRO_DIVISIONS;
    for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
      for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
        for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
          if (this.packedColors.has(packedMicroKey(baseX + dx, baseY + dy, baseZ + dz))) return true;
        }
      }
    }
    return false;
  }

  /** Clear one horizontal 16x16 standard chunk without scanning all microcells. */
  clearChunk(chunkX, chunkZ) {
    const cursor = this.beginClearChunk(chunkX, chunkZ);
    this.continueClearChunk(cursor);
    return cursor.removed;
  }

  /** Detach a chunk's indexes in constant time before incremental removal. */
  beginClearChunk(chunkX: number, chunkZ: number): MicroChunkClearCursor {
    const originMx = chunkX * STANDARD_CHUNK_MICRO_SIZE;
    const originMz = chunkZ * STANDARD_CHUNK_MICRO_SIZE;
    const targetMeshChunks: string[] = [];
    const cellIterators: Iterator<number>[] = [];
    for (let dx = 0; dx < MICRO_MESH_CHUNKS_PER_STANDARD_AXIS; dx++) {
      for (let dz = 0; dz < MICRO_MESH_CHUNKS_PER_STANDARD_AXIS; dz++) {
        const targetMx = originMx + dx * MICRO_MESH_CHUNK_SIZE;
        const targetMz = originMz + dz * MICRO_MESH_CHUNK_SIZE;
        const targetKey = meshChunkKey(targetMx, targetMz);
        targetMeshChunks.push(targetKey);
        const cellKeys = this.chunkCells.get(targetKey);
        if (cellKeys?.size) cellIterators.push(cellKeys.values());
        this.chunkCells.delete(targetKey);
      }
    }
    return {
      targetMeshChunks,
      cellIterators,
      iteratorIndex: 0,
      removed: 0,
      complete: false,
    };
  }

  continueClearChunk(
    cursor: MicroChunkClearCursor,
    maxCells = Number.POSITIVE_INFINITY,
  ): boolean {
    if (cursor.complete) return true;
    let remaining = Number.isFinite(maxCells)
      ? Math.max(1, Math.floor(maxCells))
      : Number.POSITIVE_INFINITY;

    while (cursor.iteratorIndex < cursor.cellIterators.length && remaining > 0) {
      const iterator = cursor.cellIterators[cursor.iteratorIndex];
      const next = iterator.next();
      if (next.done) {
        cursor.iteratorIndex++;
        continue;
      }
      const packedKey = next.value;
      const [mx, my, mz] = unpackMicroKey(packedKey);
      const cellKey = `${mx},${my},${mz}`;
      this.preservePublishedCollisionCell(mx, my, mz);
      if (this.cells.delete(cellKey)) cursor.removed++;
      this.packedColors.delete(packedKey);
      this.parts.delete(cellKey);
      remaining--;
    }
    if (cursor.iteratorIndex < cursor.cellIterators.length) return false;
    if (cursor.removed === 0) {
      cursor.complete = true;
      return true;
    }

    // Rebuild the cleared subchunks plus their immediate neighbours so faces
    // exposed along the 16 m snapshot boundary appear immediately.
    for (const targetKey of cursor.targetMeshChunks) {
      const [meshCx, meshCz] = targetKey.split(',').map(Number);
      const targetMx = meshCx * MICRO_MESH_CHUNK_SIZE;
      const targetMz = meshCz * MICRO_MESH_CHUNK_SIZE;
      this.invalidateMeshChunk(targetKey);
      this.invalidateMeshChunk(meshChunkKey(targetMx - 1, targetMz));
      this.invalidateMeshChunk(meshChunkKey(targetMx + MICRO_MESH_CHUNK_SIZE, targetMz));
      this.invalidateMeshChunk(meshChunkKey(targetMx, targetMz - 1));
      this.invalidateMeshChunk(meshChunkKey(targetMx, targetMz + MICRO_MESH_CHUNK_SIZE));
    }
    cursor.complete = true;
    return true;
  }

  extractRegion(minX, minY, minZ, maxX, maxY, maxZ) {
    const extracted = [];
    const minMx = minX * MICRO_DIVISIONS;
    const minMy = minY * MICRO_DIVISIONS;
    const minMz = minZ * MICRO_DIVISIONS;
    const maxMx = (maxX + 1) * MICRO_DIVISIONS - 1;
    const maxMy = (maxY + 1) * MICRO_DIVISIONS - 1;
    const maxMz = (maxZ + 1) * MICRO_DIVISIONS - 1;

    for (const [cellKey, color] of this.cells) {
      const [mx, my, mz] = cellKey.split(',').map(Number);
      const extractedMx = unwrapPeriodicNear(mx, minMx, TORUS_SIZE_X * MICRO_DIVISIONS);
      const extractedMz = unwrapPeriodicNear(mz, minMz, TORUS_SIZE_Z * MICRO_DIVISIONS);
      if (extractedMx < minMx || extractedMx > maxMx || my < minMy || my > maxMy
        || extractedMz < minMz || extractedMz > maxMz) continue;
      extracted.push({ mx: extractedMx, my, mz: extractedMz, color, part: this.parts.get(cellKey) ?? null });
      this.preservePublishedCollisionCell(mx, my, mz);
      this.cells.delete(cellKey);
      const packedKey = packedMicroKey(mx, my, mz);
      this.packedColors.delete(packedKey);
      this.removeChunkCell(packedKey, mx, mz);
      this.parts.delete(cellKey);
      this.markMeshChunkDirty(mx, mz);
    }

    return extracted;
  }

  /**
   * Remove and return every microcell whose integer micro indices fall inside
   * the inclusive [min..max] range. Micro indices are absolute (0.2 m grid),
   * so callers can target a single cell by passing equal min/max values.
   */
  extractCellsInBox(minMx, minMy, minMz, maxMx, maxMy, maxMz) {
    const extracted = [];
    if (!Number.isFinite(minMx) || !Number.isFinite(minMy) || !Number.isFinite(minMz)
      || !Number.isFinite(maxMx) || !Number.isFinite(maxMy) || !Number.isFinite(maxMz)) {
      return extracted;
    }
    for (const [cellKey, color] of this.cells) {
      const [mx, my, mz] = cellKey.split(',').map(Number);
      const extractedMx = unwrapPeriodicNear(mx, minMx, TORUS_SIZE_X * MICRO_DIVISIONS);
      const extractedMz = unwrapPeriodicNear(mz, minMz, TORUS_SIZE_Z * MICRO_DIVISIONS);
      if (extractedMx < minMx || extractedMx > maxMx || my < minMy || my > maxMy
        || extractedMz < minMz || extractedMz > maxMz) continue;
      extracted.push({ mx: extractedMx, my, mz: extractedMz, color, part: this.parts.get(cellKey) ?? null });
      this.preservePublishedCollisionCell(mx, my, mz);
      this.cells.delete(cellKey);
      const packedKey = packedMicroKey(mx, my, mz);
      this.packedColors.delete(packedKey);
      this.removeChunkCell(packedKey, mx, mz);
      this.parts.delete(cellKey);
      this.markMeshChunkDirty(mx, mz);
    }
    return extracted;
  }

  getCellsInAABB(aabb) {
    const cells = [];
    const minX = Math.floor(aabb.minX * MICRO_DIVISIONS);
    const maxX = Math.floor(aabb.maxX * MICRO_DIVISIONS);
    const minY = Math.floor(aabb.minY * MICRO_DIVISIONS);
    const maxY = Math.floor(aabb.maxY * MICRO_DIVISIONS);
    const minZ = Math.floor(aabb.minZ * MICRO_DIVISIONS);
    const maxZ = Math.floor(aabb.maxZ * MICRO_DIVISIONS);

    for (let mx = minX; mx <= maxX; mx++) {
      for (let my = minY; my <= maxY; my++) {
        for (let mz = minZ; mz <= maxZ; mz++) {
          const color = this.get(mx, my, mz);
          if (color === null) continue;
          cells.push({
            x: mx * MICRO_SIZE,
            y: my * MICRO_SIZE,
            z: mz * MICRO_SIZE,
            size: MICRO_SIZE,
            color,
            part: this.parts.get(key(mx, my, mz)) ?? null,
            micro: true
          });
        }
      }
    }
    return cells;
  }

  /** Collision cells matching the mesh currently published to the scene. */
  getPublishedCollisionCellsInAABB(aabb) {
    const cells = [];
    const minX = Math.floor(aabb.minX * MICRO_DIVISIONS);
    const maxX = Math.floor(aabb.maxX * MICRO_DIVISIONS);
    const minY = Math.floor(aabb.minY * MICRO_DIVISIONS);
    const maxY = Math.floor(aabb.maxY * MICRO_DIVISIONS);
    const minZ = Math.floor(aabb.minZ * MICRO_DIVISIONS);
    const maxZ = Math.floor(aabb.maxZ * MICRO_DIVISIONS);

    for (let mx = minX; mx <= maxX; mx++) {
      for (let my = minY; my <= maxY; my++) {
        for (let mz = minZ; mz <= maxZ; mz++) {
          const color = this.getPublishedCollisionColor(mx, my, mz);
          if (color === null) continue;
          cells.push({
            x: mx * MICRO_SIZE,
            y: my * MICRO_SIZE,
            z: mz * MICRO_SIZE,
            size: MICRO_SIZE,
            color,
            part: this.parts.get(key(mx, my, mz)) ?? null,
            micro: true,
          });
        }
      }
    }
    return cells;
  }

  getPublishedCollisionColor(mx: number, my: number, mz: number) {
    const chunkKey = meshChunkKey(mx, mz);
    const snapshot = this.publishedCollisionSnapshots.get(chunkKey);
    if (!snapshot) {
      return this.meshChunks.has(chunkKey) ? this.get(mx, my, mz) : null;
    }
    const packedKey = packedMicroKey(mx, my, mz);
    return snapshot.has(packedKey)
      ? (snapshot.get(packedKey) ?? null)
      : (this.packedColors.get(packedKey) ?? null);
  }

  /** Drop empty no-op snapshots; dirty ones retire when their mesh publishes. */
  finalizeCollisionSnapshots(targetMeshChunks: string[]) {
    for (const chunkKey of targetMeshChunks) {
      if (this.dirtyMeshChunks.has(chunkKey)) continue;
      if (this.activeMeshBuild?.chunkKey === chunkKey) continue;
      this.publishedCollisionSnapshots.delete(chunkKey);
    }
  }

  raycast(
    origin,
    direction,
    maxDistance = 10,
    isCellReady: ((mx: number, mz: number) => boolean) | null = null,
    usePublishedCollision = false,
  ) {
    const startX = origin.x * MICRO_DIVISIONS;
    const startY = origin.y * MICRO_DIVISIONS;
    const startZ = origin.z * MICRO_DIVISIONS;
    const dirX = direction.x;
    const dirY = direction.y;
    const dirZ = direction.z;

    let mx = Math.floor(startX);
    let my = Math.floor(startY);
    let mz = Math.floor(startZ);
    const stepX = Math.sign(dirX);
    const stepY = Math.sign(dirY);
    const stepZ = Math.sign(dirZ);
    const deltaX = stepX ? Math.abs(1 / dirX) : Infinity;
    const deltaY = stepY ? Math.abs(1 / dirY) : Infinity;
    const deltaZ = stepZ ? Math.abs(1 / dirZ) : Infinity;
    let maxX = stepX === 0 ? Infinity : stepX > 0
      ? (Math.floor(startX) + 1 - startX) * deltaX
      : (startX - Math.floor(startX)) * deltaX;
    let maxY = stepY === 0 ? Infinity : stepY > 0
      ? (Math.floor(startY) + 1 - startY) * deltaY
      : (startY - Math.floor(startY)) * deltaY;
    let maxZ = stepZ === 0 ? Infinity : stepZ > 0
      ? (Math.floor(startZ) + 1 - startZ) * deltaZ
      : (startZ - Math.floor(startZ)) * deltaZ;
    let normal = { x: 0, y: 0, z: 0 };
    let scaledDistance = 0;
    const maxScaledDistance = maxDistance * MICRO_DIVISIONS;

    while (scaledDistance <= maxScaledDistance) {
      const color = usePublishedCollision
        ? this.getPublishedCollisionColor(mx, my, mz)
        : this.get(mx, my, mz);
      if (color !== null && (!isCellReady || isCellReady(mx, mz))) {
        return {
          hit: true,
          kind: 'micro',
          microPos: { x: mx, y: my, z: mz },
          hitPos: { x: mx * MICRO_SIZE, y: my * MICRO_SIZE, z: mz * MICRO_SIZE },
          placeMicroPos: { x: mx + normal.x, y: my + normal.y, z: mz + normal.z },
          normal,
          color,
          size: MICRO_SIZE,
          distance: scaledDistance * MICRO_SIZE
        };
      }

      if (maxX < maxY) {
        if (maxX < maxZ) {
          scaledDistance = maxX;
          maxX += deltaX;
          mx += stepX;
          normal = { x: -stepX, y: 0, z: 0 };
        } else {
          scaledDistance = maxZ;
          maxZ += deltaZ;
          mz += stepZ;
          normal = { x: 0, y: 0, z: -stepZ };
        }
      } else if (maxY < maxZ) {
        scaledDistance = maxY;
        maxY += deltaY;
        my += stepY;
        normal = { x: 0, y: -stepY, z: 0 };
      } else {
        scaledDistance = maxZ;
        maxZ += deltaZ;
        mz += stepZ;
        normal = { x: 0, y: 0, z: -stepZ };
      }
    }
    return { hit: false };
  }

  updateMesh(
    maxChunks = Number.POSITIVE_INFINITY,
    activeChunkKeys: Set<string> | null = null,
    blockedChunkKeys: Set<string> | null = null,
    timeBudgetMs = Number.POSITIVE_INFINITY,
    deferredPublicationChunkKeys: Set<string> | null = null,
  ) {
    this.deferredPublicationChunkKeys = deferredPublicationChunkKeys;
    if (!this.dirty && !this.activeMeshBuild) return false;
    this.recentlyRebuiltMeshes.length = 0;
    const limit = Number.isFinite(maxChunks) ? Math.max(1, Math.floor(maxChunks)) : Infinity;
    const startedAt = performance.now();
    const deadline = Number.isFinite(timeBudgetMs)
      ? startedAt + Math.max(0, timeBudgetMs)
      : Infinity;
    let completed = 0;

    while (completed < limit) {
      const activeJob = this.activeMeshBuild;
      if (activeJob && (
        (activeChunkKeys && !activeChunkKeys.has(activeJob.standardChunkKey))
        || blockedChunkKeys?.has(activeJob.standardChunkKey)
        || this.isOutsidePublicationCompanion(activeJob.chunkKey)
      )) {
        this.dirtyMeshChunks.add(activeJob.chunkKey);
        this.activeMeshBuild = null;
      }

      if (!this.activeMeshBuild) {
        const nextChunkKey = this.nextBuildableMeshChunk(activeChunkKeys, blockedChunkKeys);
        if (!nextChunkKey) break;
        this.dirtyMeshChunks.delete(nextChunkKey);
        this.activeMeshBuild = this.beginMeshBuild(nextChunkKey);
      }

      const job = this.activeMeshBuild;
      const result = this.advanceMeshBuild(job, deadline);
      if (result === 'pending') break;
      this.activeMeshBuild = null;
      if (result === 'complete') completed++;
      if (performance.now() >= deadline) break;
    }

    this.dirty = this.dirtyMeshChunks.size > 0 || this.activeMeshBuild !== null;
    this.mesh = this.meshChunks.values().next().value || null;
    return completed > 0;
  }

  private nextBuildableMeshChunk(
    activeChunkKeys: Set<string> | null,
    blockedChunkKeys: Set<string> | null,
  ): string | null {
    for (const chunkKey of this.dirtyMeshChunks) {
      const standardChunkKey = standardChunkKeyForMeshChunk(chunkKey);
      if (activeChunkKeys && !activeChunkKeys.has(standardChunkKey)) continue;
      if (blockedChunkKeys?.has(standardChunkKey)) continue;
      if (this.isOutsidePublicationCompanion(chunkKey)) continue;
      return chunkKey;
    }
    return null;
  }

  private beginMeshBuild(chunkKey: string): MicroMeshBuildJob {
    const [chunkCx, chunkCz] = chunkKey.split(',').map(Number);
    const cellKeys = this.chunkCells.get(chunkKey);
    return {
      chunkKey,
      standardChunkKey: standardChunkKeyForMeshChunk(chunkKey),
      revision: this.meshChunkRevisions.get(chunkKey) ?? 0,
      chunkCx,
      chunkCz,
      originMx: chunkCx * MICRO_MESH_CHUNK_SIZE,
      originMz: chunkCz * MICRO_MESH_CHUNK_SIZE,
      phase: 'scan',
      cellIterator: (cellKeys ?? new Set<number>()).values(),
      minMicroY: Infinity,
      maxMicroY: -Infinity,
      dimensions: null,
      axis: 0,
      slice: -1,
      u: 1,
      v: 2,
      maskWidth: 0,
      maskHeight: 0,
      mask: null,
      maskIndex: 0,
      greedyIndex: 0,
      quads: [],
      positions: null,
      normals: null,
      colors: null,
      indices: null,
      writeQuadIndex: 0,
    };
  }

  private advanceMeshBuild(
    job: MicroMeshBuildJob,
    deadline: number,
  ): 'pending' | 'complete' | 'stale' {
    if ((this.meshChunkRevisions.get(job.chunkKey) ?? 0) !== job.revision) return 'stale';

    if (job.phase === 'scan') {
      let scanned = 0;
      while (true) {
        const next = job.cellIterator.next();
        if (next.done) break;
        if (this.packedColors.has(next.value)) {
          const my = unpackMicroY(next.value);
          job.minMicroY = Math.min(job.minMicroY, my);
          job.maxMicroY = Math.max(job.maxMicroY, my);
        }
        scanned++;
        if (scanned % MESH_TIME_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
          return 'pending';
        }
      }

      if (!Number.isFinite(job.minMicroY) || !Number.isFinite(job.maxMicroY)) {
        this.replaceMeshChunk(job, null);
        return 'complete';
      }
      job.dimensions = [
        MICRO_MESH_CHUNK_SIZE,
        job.maxMicroY - job.minMicroY + 1,
        MICRO_MESH_CHUNK_SIZE,
      ];
      this.prepareMeshMask(job);
    }

    while (job.phase === 'mask' || job.phase === 'greedy') {
      if ((this.meshChunkRevisions.get(job.chunkKey) ?? 0) !== job.revision) return 'stale';
      if (job.axis >= 3) {
        this.prepareMeshOutput(job);
        break;
      }

      if (job.phase === 'mask') {
        const mask = job.mask!;
        const dimensions = job.dimensions!;
        let processed = 0;
        while (job.maskIndex < mask.length) {
          const index = job.maskIndex++;
          const i = index % job.maskWidth;
          const j = Math.floor(index / job.maskWidth);
          const position = [0, 0, 0];
          position[job.axis] = job.slice;
          position[job.u] = i;
          position[job.v] = j;
          const neighbor = [...position];
          neighbor[job.axis]++;
          const a = this.sampleMeshCell(job, position[0], position[1], position[2]);
          const b = this.sampleMeshCell(job, neighbor[0], neighbor[1], neighbor[2]);
          const aInside = job.slice >= 0;
          const bInside = job.slice + 1 < dimensions[job.axis];
          mask[index] = a !== undefined && b === undefined && aInside
            ? a + 1
            : a === undefined && b !== undefined && bInside
              ? -(b + 1)
              : 0;
          processed++;
          if (processed % MESH_TIME_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
            return 'pending';
          }
        }
        job.phase = 'greedy';
        job.greedyIndex = 0;
      }

      if (job.phase === 'greedy') {
        const mask = job.mask!;
        let processed = 0;
        while (job.greedyIndex < mask.length) {
          const maskIndex = job.greedyIndex;
          const value = mask[maskIndex];
          const i = maskIndex % job.maskWidth;
          const j = Math.floor(maskIndex / job.maskWidth);
          if (value === 0) {
            job.greedyIndex++;
          } else {
            let width = 1;
            while (i + width < job.maskWidth && mask[maskIndex + width] === value) width++;
            let height = 1;
            heightLoop: while (j + height < job.maskHeight) {
              const row = maskIndex + height * job.maskWidth;
              for (let k = 0; k < width; k++) {
                if (mask[row + k] !== value) break heightLoop;
              }
              height++;
            }

            const base = [0, 0, 0];
            const du = [0, 0, 0];
            const dv = [0, 0, 0];
            base[job.axis] = job.slice + 1;
            base[job.u] = i;
            base[job.v] = j;
            du[job.u] = width;
            dv[job.v] = height;
            job.quads.push(
              base[0], base[1], base[2],
              du[0], du[1], du[2],
              dv[0], dv[1], dv[2],
              value > 0 ? 1 : 0,
              job.axis,
              Math.abs(value) - 1,
            );
            for (let row = 0; row < height; row++) {
              mask.fill(0, maskIndex + row * job.maskWidth, maskIndex + row * job.maskWidth + width);
            }
            job.greedyIndex += width;
          }
          processed++;
          if (processed % MESH_TIME_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
            return 'pending';
          }
        }
        job.slice++;
        if (job.slice >= job.dimensions![job.axis]) {
          job.axis++;
          job.slice = -1;
        }
        this.prepareMeshMask(job);
        if (performance.now() >= deadline) return 'pending';
      }
    }

    if (job.phase === 'write') {
      let written = 0;
      const faceCount = job.quads.length / 12;
      while (job.writeQuadIndex < faceCount) {
        this.writeMeshQuad(job, job.writeQuadIndex++);
        written++;
        if (written % MESH_TIME_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
          return 'pending';
        }
      }
      if ((this.meshChunkRevisions.get(job.chunkKey) ?? 0) !== job.revision) return 'stale';
      this.finishMeshBuild(job);
      return 'complete';
    }

    return 'pending';
  }

  private prepareMeshMask(job: MicroMeshBuildJob) {
    if (job.axis >= 3) {
      this.prepareMeshOutput(job);
      return;
    }
    job.u = (job.axis + 1) % 3;
    job.v = (job.axis + 2) % 3;
    job.maskWidth = job.dimensions![job.u];
    job.maskHeight = job.dimensions![job.v];
    const maskLength = job.maskWidth * job.maskHeight;
    if (!job.mask || job.mask.length !== maskLength) job.mask = new Int32Array(maskLength);
    job.maskIndex = 0;
    job.greedyIndex = 0;
    job.phase = 'mask';
  }

  private sampleMeshCell(job: MicroMeshBuildJob, lx: number, ly: number, lz: number) {
    return this.packedColors.get(packedMicroKey(
      job.originMx + lx,
      job.minMicroY + ly,
      job.originMz + lz,
    ));
  }

  private prepareMeshOutput(job: MicroMeshBuildJob) {
    const faceCount = job.quads.length / 12;
    if (faceCount === 0) {
      this.replaceMeshChunk(job, null);
      job.phase = 'write';
      job.writeQuadIndex = 0;
      return;
    }
    const vertexCount = faceCount * 4;
    job.positions = new Uint16Array(vertexCount * 3);
    job.normals = new Int8Array(vertexCount * 3);
    job.colors = new Uint8Array(vertexCount * 3);
    job.indices = vertexCount <= 0xffff
      ? new Uint16Array(faceCount * 6)
      : new Uint32Array(faceCount * 6);
    job.phase = 'write';
    job.writeQuadIndex = 0;
  }

  private writeMeshQuad(job: MicroMeshBuildJob, quadIndex: number) {
    const offset = quadIndex * 12;
    const baseX = job.quads[offset];
    const baseY = job.quads[offset + 1];
    const baseZ = job.quads[offset + 2];
    const duX = job.quads[offset + 3];
    const duY = job.quads[offset + 4];
    const duZ = job.quads[offset + 5];
    const dvX = job.quads[offset + 6];
    const dvY = job.quads[offset + 7];
    const dvZ = job.quads[offset + 8];
    const positive = job.quads[offset + 9] === 1;
    const axis = job.quads[offset + 10];
    const color = job.quads[offset + 11];
    this.meshTempColor.setHex(color);
    const shade = axis === 1 ? (positive ? 1 : 0.6) : 0.85;
    const r = Math.round(this.meshTempColor.r * shade * 255);
    const g = Math.round(this.meshTempColor.g * shade * 255);
    const b = Math.round(this.meshTempColor.b * shade * 255);
    const quad = positive ? POSITIVE_QUAD : NEGATIVE_QUAD;
    const positions = job.positions!;
    const normals = job.normals!;
    const colors = job.colors!;
    let attributeOffset = quadIndex * 12;
    const vertexOffset = quadIndex * 4;
    for (let vertexIndex = 0; vertexIndex < 4; vertexIndex++) {
      const [alongU, alongV] = quad[vertexIndex];
      positions[attributeOffset] = baseX + duX * alongU + dvX * alongV;
      normals[attributeOffset] = (axis === 0 ? (positive ? 1 : -1) : 0) * 127;
      colors[attributeOffset++] = r;
      positions[attributeOffset] = job.minMicroY + baseY + duY * alongU + dvY * alongV;
      normals[attributeOffset] = (axis === 1 ? (positive ? 1 : -1) : 0) * 127;
      colors[attributeOffset++] = g;
      positions[attributeOffset] = baseZ + duZ * alongU + dvZ * alongV;
      normals[attributeOffset] = (axis === 2 ? (positive ? 1 : -1) : 0) * 127;
      colors[attributeOffset++] = b;
    }
    const indices = job.indices!;
    const indexOffset = quadIndex * 6;
    indices[indexOffset] = vertexOffset;
    indices[indexOffset + 1] = vertexOffset + 1;
    indices[indexOffset + 2] = vertexOffset + 2;
    indices[indexOffset + 3] = vertexOffset;
    indices[indexOffset + 4] = vertexOffset + 2;
    indices[indexOffset + 5] = vertexOffset + 3;
  }

  private finishMeshBuild(job: MicroMeshBuildJob) {
    if (!job.positions || !job.normals || !job.colors || !job.indices) {
      this.replaceMeshChunk(job, null);
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(job.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(job.normals, 3, true));
    geometry.setAttribute('color', new THREE.BufferAttribute(job.colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(job.indices, 1));
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `MicroVoxelChunk:${job.chunkKey}`;
    mesh.userData.microChunkKey = job.chunkKey;
    mesh.userData.standardChunkKey = job.standardChunkKey;
    mesh.userData.projectionChunkCx = job.chunkCx / MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    mesh.userData.projectionChunkCz = job.chunkCz / MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    mesh.userData.bentSpan = MICRO_MESH_CHUNK_SIZE * MICRO_SIZE;
    mesh.userData.occupiedMinY = job.minMicroY * MICRO_SIZE;
    mesh.userData.occupiedMaxY = (job.maxMicroY + 1) * MICRO_SIZE;
    mesh.userData.bentSphere = computeChunkBentSphere(
      mesh.userData.projectionChunkCx,
      mesh.userData.projectionChunkCz,
      null,
      mesh.userData.occupiedMinY,
      mesh.userData.occupiedMaxY,
      mesh.userData.bentSpan,
    );
    mesh.userData.bentSphereRevision = getWorldProjectionRevision();
    mesh.position.set(job.originMx * MICRO_SIZE, 0, job.originMz * MICRO_SIZE);
    mesh.scale.setScalar(MICRO_SIZE);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.replaceMeshChunk(job, mesh);
  }

  private replaceMeshChunk(job: MicroMeshBuildJob, mesh: THREE.Mesh | null) {
    const barrierKey = this.findPublicationBarrier(job.chunkKey);
    if (barrierKey) {
      const previousDeferred = this.deferredMeshPublications.get(job.chunkKey);
      if (previousDeferred?.mesh) previousDeferred.mesh.geometry.dispose();
      this.deferredMeshPublications.set(job.chunkKey, { job, mesh, barrierKey });
      return;
    }
    this.publishMeshChunk(job, mesh);
  }

  private findPublicationBarrier(meshKey: string) {
    const ownerKey = standardChunkKeyForMeshChunk(meshKey);
    return this.deferredPublicationChunkKeys?.has(ownerKey) ? ownerKey : null;
  }

  private isOutsidePublicationCompanion(meshKey: string) {
    const ownerKey = standardChunkKeyForMeshChunk(meshKey);
    // An adjacent conversion owns this partition through its own barrier. That
    // unique ownership avoids assigning one staged mesh to whichever barrier
    // happens to appear first in a Set.
    if (this.deferredPublicationChunkKeys?.has(ownerKey)) return false;
    for (const barrierKey of this.deferredPublicationChunkKeys ?? []) {
      if (this.isPublicationBarrierParticipant(barrierKey, meshKey)) return true;
    }
    return false;
  }

  private isPublicationBarrierParticipant(barrierKey: string, meshKey: string) {
    const [standardCx, standardCz] = barrierKey.split(',').map(Number);
    const [meshCx, meshCz] = meshKey.split(',').map(Number);
    const meshWorldX = MICRO_WORLD_SIZE_X / MICRO_MESH_CHUNK_SIZE;
    const meshWorldZ = MICRO_WORLD_SIZE_Z / MICRO_MESH_CHUNK_SIZE;
    const baseX = standardCx * MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    const baseZ = standardCz * MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    const dx = ((meshCx - baseX) % meshWorldX + meshWorldX) % meshWorldX;
    const dz = ((meshCz - baseZ) % meshWorldZ + meshWorldZ) % meshWorldZ;
    const insideX = dx < MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    const insideZ = dz < MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    const edgeX = dx === meshWorldX - 1 || dx === MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    const edgeZ = dz === meshWorldZ - 1 || dz === MICRO_MESH_CHUNKS_PER_STANDARD_AXIS;
    return (insideX && insideZ) || (edgeX && insideZ) || (insideX && edgeZ);
  }

  private publishMeshChunk(job: MicroMeshBuildJob, mesh: THREE.Mesh | null) {
    const previous = this.meshChunks.get(job.chunkKey);
    if (mesh) {
      this.meshChunks.set(job.chunkKey, mesh);
      this.group.add(mesh);
      this.recentlyRebuiltMeshes.push(mesh);
    } else {
      this.meshChunks.delete(job.chunkKey);
    }
    // Mesh publication and collision publication share the same synchronous
    // commit point, including empty -> filled and empty -> empty partitions.
    this.publishedCollisionSnapshots.delete(job.chunkKey);
    if (!previous) return;
    this.group.remove(previous);
    previous.geometry.dispose();
  }

  isDeferredPublicationReady(
    standardChunkKey: string,
    activeChunkKeys: Set<string> | null = null,
  ) {
    if (
      this.activeMeshBuild
      && this.activeMeshBuild.standardChunkKey === standardChunkKey
    ) return false;
    for (const chunkKey of this.dirtyMeshChunks) {
      if (standardChunkKeyForMeshChunk(chunkKey) !== standardChunkKey) continue;
      if (activeChunkKeys && !activeChunkKeys.has(standardChunkKey)) continue;
      return false;
    }
    for (const publication of this.deferredMeshPublications.values()) {
      if (publication.barrierKey !== standardChunkKey) continue;
      if ((this.meshChunkRevisions.get(publication.job.chunkKey) ?? 0) !== publication.job.revision) {
        return false;
      }
    }
    return true;
  }

  /** Whether any micro mesh belonging to the supplied standard-chunk AOI has
   * not reached its final published state yet. Dirty meshes outside the AOI do
   * not hold initial entry open. */
  hasPendingMeshWork(activeChunkKeys: Set<string>) {
    if (
      this.activeMeshBuild
      && activeChunkKeys.has(this.activeMeshBuild.standardChunkKey)
    ) return true;
    for (const chunkKey of this.dirtyMeshChunks) {
      if (activeChunkKeys.has(standardChunkKeyForMeshChunk(chunkKey))) return true;
    }
    for (const publication of this.deferredMeshPublications.values()) {
      if (activeChunkKeys.has(publication.barrierKey)) return true;
    }
    return false;
  }

  publishDeferredForStandardChunk(
    standardChunkKey: string,
    prepareMesh: (mesh: THREE.Mesh) => void,
  ) {
    let published = 0;
    for (const [chunkKey, publication] of this.deferredMeshPublications) {
      if (publication.barrierKey !== standardChunkKey) continue;
      if ((this.meshChunkRevisions.get(chunkKey) ?? 0) !== publication.job.revision) continue;
      if (publication.mesh) prepareMesh(publication.mesh);
      this.publishMeshChunk(publication.job, publication.mesh);
      this.deferredMeshPublications.delete(chunkKey);
      published++;
    }
    this.mesh = this.meshChunks.values().next().value || null;
    return published;
  }

  abortDeferredForStandardChunk(standardChunkKey: string) {
    for (const [chunkKey, publication] of this.deferredMeshPublications) {
      if (publication.barrierKey !== standardChunkKey) continue;
      publication.mesh?.geometry.dispose();
      this.deferredMeshPublications.delete(chunkKey);
      this.dirtyMeshChunks.add(chunkKey);
    }
    this.dirty = this.dirtyMeshChunks.size > 0 || this.activeMeshBuild !== null;
  }

  takeRecentlyRebuiltMeshes() {
    return this.recentlyRebuiltMeshes.splice(0);
  }
}

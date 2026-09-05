import * as THREE from 'three';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from './Chunk.ts';
import { BlockTypes, DEFAULT_BLOCK_COLOR, normalizeColor } from './BlockTypes.ts';
import { TerrainGenerator } from '../worldgen/TerrainGenerator.ts';
import { LowPolyMesher, type ChunkMeshData } from '../mesher/LowPolyMesher.ts';
import {
  MicroVoxelLayer,
  MICRO_DIVISIONS,
  type MicroChunkClearCursor,
} from './MicroVoxelLayer.ts';
import {
  WorldEditPersistence,
  type TerrainEditChunk,
  type PersistedMicroEdit,
  type PersistedStandardEdit,
  type RemoteChunkReplacementCursor,
  type WorldEditPersistenceOptions,
} from './WorldEditPersistence.ts';
import {
  DistantSurfaceLayer,
  type DistantSurfaceSettings,
} from '../render/DistantSurfaceLayer.ts';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import {
  wrapX, wrapZ, wrapChunkX, wrapChunkZ, wrapMicroX, wrapMicroZ,
  bendPoint, unbendPoint, computeChunkBentSphere, hookSceneMaterials,
  getWorldProjectionRevision, TORUS_SIZE_X, TORUS_SIZE_Z
} from '../torus/TorusWorld.ts';

// Leave most of a 120 Hz frame's 8.33 ms budget for simulation, culling and
// rendering. Missing detailed chunks may take a few more frames to stream in,
// while the already-present distant surface prevents visible holes.
const STREAM_WORK_BUDGET_MS = 3;
const BACKGROUND_MAIN_THREAD_BUDGET_MS = 1;
const MAX_STREAM_CHUNKS_PER_FRAME = 1;
const MAX_CHUNK_MESHES_PER_FRAME = 1;
const MAX_REMOTE_CHUNKS_PER_FRAME = 2;
const MAX_REMOTE_EDITS_PER_FRAME = 1_024;
const MAX_BACKGROUND_REMOTE_EDITS_PER_FRAME = 128;
const REMOTE_EDIT_TIME_CHECK_INTERVAL = 32;
const MAX_MICRO_MESH_CHUNKS_PER_FRAME = 1;
const INTERACTIVE_MICRO_WORK_BUDGET_MS = 1.25;
const MAX_CHUNK_EVICTIONS_PER_FRAME = 8;
const MAX_RECYCLED_PROCEDURAL_CHUNKS = 64;
export const DEFAULT_RENDER_DISTANCE = 8;

// Matches LowPolyMesher and MicroVoxelLayer exactly: each rendered quad is
// triangulated as 0-1-2 and 0-2-3 before the GPU applies the torus bend.
const BENT_VOXEL_RAYCAST_FACES = [
  { normal: [0, 1, 0], quad: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { normal: [0, -1, 0], quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, -1], quad: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
  { normal: [0, 0, 1], quad: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]] },
  { normal: [-1, 0, 0], quad: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
  { normal: [1, 0, 0], quad: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] }
];

type PendingRemoteChunkApplyJob = {
  update: TerrainEditChunk;
  key: string;
  cx: number;
  cz: number;
  revision: number;
  phase: 'micro-clear' | 'persistence' | 'micro' | 'standard';
  microClearCursor: MicroChunkClearCursor;
  persistenceCursor: RemoteChunkReplacementCursor | null;
  microIterator: Iterator<PersistedMicroEdit> | null;
  standardIterator: Iterator<PersistedStandardEdit> | null;
  rawMicroIndex: number;
  rawStandardIndex: number;
  chunk: Chunk | null;
  chunkPrepared: boolean;
  standardComplete: boolean;
  workerStandardEdits: PackedStandardEdit[];
  localStandardOverrides: PackedStandardEdit[];
  localMicroOverrides: PendingMicroOverride[];
};

type PackedStandardEdit = [number, number, number, number, number];

type PendingMicroOverride =
  | { type: 'set'; mx: number; my: number; mz: number; color: number; part: string | null }
  | { type: 'delete'; mx: number; my: number; mz: number }
  | { type: 'clear-standard'; wx: number; wy: number; wz: number }
  | { type: 'subdivide'; wx: number; wy: number; wz: number; color: number };

type PendingTerrainSnapshot = {
  key: string;
  cx: number;
  cz: number;
  revision: number;
  standardEdits: PackedStandardEdit[];
};

type TerrainWorkerJob = {
  requestId: number;
  type: 'generate' | 'remesh';
  key: string;
  cx: number;
  cz: number;
  dataVersion?: number;
  remeshChunk?: Chunk;
  recycledChunk?: Chunk | null;
  replacingChunk?: Chunk | null;
  snapshot?: PendingTerrainSnapshot;
};

type TerrainWorkerResult = {
  ok: boolean;
  type: 'generate' | 'remesh';
  requestId: number;
  cx: number;
  cz: number;
  error?: string;
  hasUserEdits?: boolean;
  dataVersion?: number;
  blocks?: Uint8Array;
  terrainColors?: Uint32Array;
  mesh?: ChunkMeshData;
};

type CompletedTerrainWorkerJob = {
  job: TerrainWorkerJob;
  result: TerrainWorkerResult;
};

type PublishedStandardCell = {
  block: number;
  color: number;
};

export type TerrainAoiLoadProgress = {
  readyChunks: number;
  totalChunks: number;
  ready: boolean;
};

function intersectTriangleInclusive(ray, a, b, c, point, barycentric) {
  const plane = new THREE.Plane().setFromCoplanarPoints(a, b, c);
  if (!ray.intersectPlane(plane, point)) return false;
  THREE.Triangle.getBarycoord(point, a, b, c, barycentric);
  const epsilon = 1e-5;
  return barycentric.x >= -epsilon
    && barycentric.y >= -epsilon
    && barycentric.z >= -epsilon;
}

export class World {
  scene: any;
  chunks: Map<string, Chunk>;
  terrainGen: TerrainGenerator;
  private terrainSeed: number;
  mesher: LowPolyMesher;
  renderDistance: number;
  worldGroup: THREE.Group;
  distantSurface: DistantSurfaceLayer;
  microVoxels: MicroVoxelLayer;
  /** Browser-local sparse overlay that survives a page refresh for this world. */
  editPersistence: WorldEditPersistence | null;
  dirtyChunks: Set<Chunk>;
  /** Locally edited chunks that must bypass idle-only terrain streaming. */
  private interactiveDirtyChunks: Set<Chunk>;
  activeChunkKeys: Set<string>;
  lastStreamCenterKey: string;
  private deferStreamWorkOnce: boolean;
  private pendingStreamChunks: { cx: number; cz: number; distanceSq: number }[];
  private pendingChunkEvictions: Map<string, Chunk>;
  private recycledProceduralChunks: Chunk[];
  private streamWorkScheduled: boolean;
  private requireOffThreadTerrainStreaming: boolean;
  private terrainWorker: Worker | null;
  private terrainWorkerJob: TerrainWorkerJob | null;
  private completedTerrainWorkerJobs: CompletedTerrainWorkerJob[];
  private nextTerrainWorkerRequestId: number;
  private pendingTerrainSnapshots: Map<string, PendingTerrainSnapshot>;
  private pendingRemoteChunkUpdates: Map<string, TerrainEditChunk>;
  private pendingRemoteChunkApply: PendingRemoteChunkApplyJob | null;
  private microMeshBuildBlockedChunks: Set<string>;
  private crossLayerPublicationChunks: Set<string>;
  private suspendedCrossLayerPublicationChunks: Set<string>;
  /** Standard values still represented by a visible standard/micro conversion mesh. */
  private crossLayerPublishedStandardCells: Map<string, Map<number, PublishedStandardCell>>;
  private remoteChunkRevisions: Map<string, number>;
  private rayBentPoint: THREE.Vector3;
  private rayFlatPoint: THREE.Vector3;
  /** Bumped on any block/micro-voxel mutation — lets caches (e.g. minimap) know terrain changed. */
  terrainVersion: number;

  constructor(
    scene,
    seed = 1337,
    persistenceOptions: WorldEditPersistenceOptions | null = null
  ) {
    this.scene = scene;
    this.chunks = new Map(); // key: "cx,cz" -> Chunk on the wrapped 1024x128 chunk grid.
    this.terrainSeed = Number.isFinite(Number(seed)) ? Number(seed) : 1337;
    this.terrainGen = new TerrainGenerator(this.terrainSeed);
    this.mesher = new LowPolyMesher();

    // Keep 1 m voxel detail nearby. The backend's compact zone snapshots fill
    // one instanced far-surface layer without generating the world in-browser.
    this.renderDistance = DEFAULT_RENDER_DISTANCE;
    this.terrainVersion = 0;
    this.worldGroup = new THREE.Group();
    this.worldGroup.name = 'VoxelWorld';
    this.scene.add(this.worldGroup);
    this.distantSurface = new DistantSurfaceLayer();
    this.worldGroup.add(this.distantSurface.mesh);
    this.microVoxels = new MicroVoxelLayer();
    this.worldGroup.add(this.microVoxels.group);
    this.editPersistence = persistenceOptions?.worldId
      ? new WorldEditPersistence(persistenceOptions)
      : null;

    // Generated terrain contains no micro voxels, so its sparse authored layer
    // can be restored immediately. Standard edits are applied lazily below when
    // their chunks stream in.
    if (this.editPersistence) {
      let restoredMicro = 0;
      for (const edit of this.editPersistence.getMicroEdits()) {
        if (!this.microVoxels.set(edit.mx, edit.my, edit.mz, edit.color, edit.part)) continue;
        restoredMicro++;
      }
      this.terrainVersion += restoredMicro;
    }

    // Dirty chunks queue for mesh regeneration
    this.dirtyChunks = new Set();
    this.interactiveDirtyChunks = new Set();
    this.activeChunkKeys = new Set();
    this.lastStreamCenterKey = '';
    this.deferStreamWorkOnce = false;
    this.pendingStreamChunks = [];
    this.pendingChunkEvictions = new Map();
    this.recycledProceduralChunks = [];
    this.streamWorkScheduled = false;
    this.requireOffThreadTerrainStreaming = typeof window !== 'undefined';
    this.terrainWorker = null;
    this.terrainWorkerJob = null;
    this.completedTerrainWorkerJobs = [];
    this.nextTerrainWorkerRequestId = 1;
    this.pendingTerrainSnapshots = new Map();
    this.initializeTerrainWorker();
    this.pendingRemoteChunkUpdates = new Map();
    this.pendingRemoteChunkApply = null;
    this.microMeshBuildBlockedChunks = new Set();
    this.crossLayerPublicationChunks = new Set();
    this.suspendedCrossLayerPublicationChunks = new Set();
    this.crossLayerPublishedStandardCells = new Map();
    this.remoteChunkRevisions = new Map();
    for (const chunk of persistenceOptions?.remote?.chunks ?? []) {
      const key = World.getChunkKey(wrapChunkX(chunk.chunk_x), wrapChunkZ(chunk.chunk_z));
      const revision = Number.isFinite(Number(chunk.revision)) ? Number(chunk.revision) : 0;
      this.remoteChunkRevisions.set(key, Math.max(this.remoteChunkRevisions.get(key) ?? -1, revision));
    }
    this.rayBentPoint = new THREE.Vector3();
    this.rayFlatPoint = new THREE.Vector3();
  }

  private initializeTerrainWorker() {
    // Unit tests and non-browser renderers retain the deterministic synchronous
    // path. Production browsers never generate or scan a streamed chunk on the
    // animation thread.
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return;
    try {
      const worker = new Worker(new URL('./TerrainStreamWorker.ts', import.meta.url), {
        type: 'module',
        name: 'space-terrain-stream',
      });
      worker.onmessage = (event: MessageEvent<TerrainWorkerResult>) => {
        const job = this.terrainWorkerJob;
        const result = event.data;
        if (!job || result.requestId !== job.requestId) return;
        this.terrainWorkerJob = null;
        if (!result.ok) {
          this.disableTerrainWorker(result.error || 'Terrain worker job failed.', job);
          return;
        }
        this.completedTerrainWorkerJobs.push({ job, result });
      };
      worker.onerror = event => {
        this.disableTerrainWorker(event.message || 'Terrain worker stopped unexpectedly.');
      };
      this.terrainWorker = worker;
    } catch (error) {
      console.warn('Space terrain worker is unavailable; detailed chunks will remain unloaded.', error);
    }
  }

  private disableTerrainWorker(message: string, failedJob = this.terrainWorkerJob) {
    if (failedJob?.snapshot) {
      this.requeueTerrainSnapshot(failedJob.snapshot);
    } else if (failedJob?.type === 'generate' && this.activeChunkKeys.has(failedJob.key)) {
      this.pendingStreamChunks.unshift({
        cx: failedJob.cx,
        cz: failedJob.cz,
        distanceSq: 0,
      });
    }
    this.terrainWorkerJob = null;
    this.terrainWorker?.terminate();
    this.terrainWorker = null;
    console.warn(`Space terrain worker disabled: ${message}`);
  }

  private requeueTerrainSnapshot(snapshot: PendingTerrainSnapshot) {
    if ((this.remoteChunkRevisions.get(snapshot.key) ?? -1) !== snapshot.revision) return;
    const pending = this.pendingTerrainSnapshots.get(snapshot.key);
    if (!pending || pending.revision <= snapshot.revision) {
      this.pendingTerrainSnapshots.set(snapshot.key, snapshot);
    }
  }

  static getChunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  getChunk(cx, cz) {
    return this.chunks.get(World.getChunkKey(cx, cz)) || null;
  }

  getOrCreateChunk(cx, cz) {
    cx = wrapChunkX(cx);
    cz = wrapChunkZ(cz);
    const key = World.getChunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = this.recycledProceduralChunks.pop() ?? new Chunk(cx, cz, this);
      chunk.reuseAt(cx, cz, this);
      this.chunks.set(key, chunk);
      this.terrainGen.generateChunk(chunk);
      let restoredStandard = 0;
      for (const edit of this.editPersistence?.getStandardEditsForChunk(cx, cz) ?? []) {
        const lx = edit.x - cx * CHUNK_SIZE_X;
        const lz = edit.z - cz * CHUNK_SIZE_Z;
        if (chunk.setLocalBlock(lx, edit.y, lz, edit.block, edit.color)) {
          restoredStandard++;
        }
      }
      if (restoredStandard > 0) {
        chunk.hasUserEdits = true;
        this.terrainVersion += restoredStandard;
      }
      this.dirtyChunks.add(chunk);
    }
    return chunk;
  }

  /**
   * Generate every chunk touched by the player's horizontal collision box
   * before restoring a saved pose. Normal streaming intentionally creates only
   * a couple of chunks per frame; near a chunk corner that can otherwise make
   * solid terrain appear around the player after physics has already started.
   */
  preparePlayerSpawnArea(playerX: number, playerZ: number, halfWidth = 0.3) {
    const prepared = new Set<string>();
    const radius = Math.max(0, Number(halfWidth) || 0);
    for (const x of [playerX - radius, playerX + radius]) {
      for (const z of [playerZ - radius, playerZ + radius]) {
        const { cx, cz } = this.worldToChunkCoords(x, z);
        const key = World.getChunkKey(cx, cz);
        if (prepared.has(key)) continue;
        this.getOrCreateChunk(cx, cz);
        prepared.add(key);
      }
    }
    return prepared.size;
  }

  worldToChunkCoords(wx, wz) {
    wx = wrapX(wx);
    wz = wrapZ(wz);
    const cx = Math.floor(wx / CHUNK_SIZE_X);
    const cz = Math.floor(wz / CHUNK_SIZE_Z);
    const lx = wx - cx * CHUNK_SIZE_X;
    const lz = wz - cz * CHUNK_SIZE_Z;
    return { cx, cz, lx, lz };
  }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SIZE_Y) return BlockTypes.AIR;
    const { cx, cz, lx, lz } = this.worldToChunkCoords(wx, wz);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return BlockTypes.AIR;
    return chunk.getLocalBlock(lx, wy, lz);
  }

  getBlockColor(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SIZE_Y) return DEFAULT_BLOCK_COLOR;
    const { cx, cz, lx, lz } = this.worldToChunkCoords(wx, wz);
    const chunk = this.getChunk(cx, cz);
    return chunk ? chunk.getLocalColor(lx, wy, lz) : DEFAULT_BLOCK_COLOR;
  }

  private preserveCrossLayerStandardCell(wx: number, wy: number, wz: number) {
    const { cx, cz, lx, lz } = this.worldToChunkCoords(wx, wz);
    const chunk = this.getChunk(cx, cz);
    if (!chunk?.mesh) return;
    const chunkKey = World.getChunkKey(cx, cz);
    let snapshot = this.crossLayerPublishedStandardCells.get(chunkKey);
    if (!snapshot) {
      snapshot = new Map();
      this.crossLayerPublishedStandardCells.set(chunkKey, snapshot);
    }
    const index = Chunk.getIndex(lx, wy, lz);
    if (!snapshot.has(index)) {
      snapshot.set(index, {
        block: chunk.getLocalBlock(lx, wy, lz),
        color: chunk.getLocalColor(lx, wy, lz),
      });
    }
  }

  private getPublishedStandardCell(wx: number, wy: number, wz: number) {
    if (wy < 0 || wy >= CHUNK_SIZE_Y) return null;
    const { cx, cz, lx, lz } = this.worldToChunkCoords(wx, wz);
    const snapshot = this.crossLayerPublishedStandardCells.get(World.getChunkKey(cx, cz));
    return snapshot?.get(Chunk.getIndex(lx, wy, lz)) ?? null;
  }

  setBlock(wx, wy, wz, blockType, updateMesh = true, color = DEFAULT_BLOCK_COLOR) {
    if (wy < 0 || wy >= CHUNK_SIZE_Y) return false;
    const { cx, cz, lx, lz } = this.worldToChunkCoords(wx, wz);
    const chunk = this.getOrCreateChunk(cx, cz);
    let clearedMicro = 0;
    if (blockType !== BlockTypes.AIR && this.microVoxels.cells.size > 0) {
      if (this.microVoxels.hasAnyInStandardCell(wrapX(wx), wy, wrapZ(wz))) {
        this.preserveCrossLayerStandardCell(wx, wy, wz);
      }
      clearedMicro = this.microVoxels.clearStandardCell(wrapX(wx), wy, wrapZ(wz));
    }
    const normalizedColor = normalizeColor(color);
    const changed = chunk.setLocalBlock(lx, wy, lz, blockType, normalizedColor);
    if (changed || clearedMicro > 0) chunk.hasUserEdits = true;
    if (changed && updateMesh) {
      this.dirtyChunks.add(chunk);
      this.queueInteractiveChunkRemesh(chunk, lx, lz);
    }
    if (changed || clearedMicro > 0) {
      this.terrainVersion++;
    }
    if (changed) {
      this.editPersistence?.recordStandard(wx, wy, wz, blockType, normalizedColor);
      this.trackPendingTerrainSnapshotEdit(
        World.getChunkKey(cx, cz),
        wrapX(wx),
        wy,
        wrapZ(wz),
        blockType,
        normalizedColor,
      );
    }
    if (clearedMicro > 0) {
      this.microVoxels.prioritizeStandardCell(wrapX(wx), wrapZ(wz));
      this.editPersistence?.removeMicroStandardCell(wx, wy, wz);
      if (changed) this.crossLayerPublicationChunks.add(World.getChunkKey(cx, cz));
      this.trackPendingRemoteMicroOverride({
        type: 'clear-standard',
        wx: wrapX(wx),
        wy,
        wz: wrapZ(wz),
      });
    }
    return changed;
  }

  private queueInteractiveChunkRemesh(chunk: Chunk, lx: number, lz: number) {
    // Keep the directly edited chunk first. Boundary edits also change which
    // faces are visible in an already-loaded neighbour, but those follow-up
    // meshes should never delay the block the player just placed.
    const affected: Array<Chunk | null> = [chunk];
    if (lx === 0) affected.push(this.getChunk(wrapChunkX(chunk.cx - 1), chunk.cz));
    if (lx === CHUNK_SIZE_X - 1) affected.push(this.getChunk(wrapChunkX(chunk.cx + 1), chunk.cz));
    if (lz === 0) affected.push(this.getChunk(chunk.cx, wrapChunkZ(chunk.cz - 1)));
    if (lz === CHUNK_SIZE_Z - 1) affected.push(this.getChunk(chunk.cx, wrapChunkZ(chunk.cz + 1)));
    for (const affectedChunk of affected) {
      if (!affectedChunk) continue;
      const key = World.getChunkKey(affectedChunk.cx, affectedChunk.cz);
      if (!this.activeChunkKeys.has(key)) continue;
      this.dirtyChunks.add(affectedChunk);
      this.interactiveDirtyChunks.add(affectedChunk);
    }
  }

  private trackPendingTerrainSnapshotEdit(
    key: string,
    x: number,
    y: number,
    z: number,
    block: number,
    color: number,
  ) {
    const edit: PackedStandardEdit = [x, y, z, block, color];
    const applying = this.pendingRemoteChunkApply;
    if (applying?.key === key) applying.localStandardOverrides.push(edit);

    const pending = this.pendingTerrainSnapshots.get(key);
    if (pending) pending.standardEdits.push(edit);

    const inFlight = this.terrainWorkerJob?.snapshot;
    if (inFlight?.key === key && inFlight !== pending) inFlight.standardEdits.push(edit);

    // onmessage moves a finished worker job into this queue before the next
    // frame publishes it. A local edit in that narrow window must also make a
    // stale retry carry the newest value.
    for (const completed of this.completedTerrainWorkerJobs) {
      const snapshot = completed.job.snapshot;
      if (snapshot?.key === key && snapshot !== pending && snapshot !== inFlight) {
        snapshot.standardEdits.push(edit);
      }
    }
  }

  setBlockColor(wx, wy, wz, color, updateMesh = true) {
    const block = this.getBlock(wx, wy, wz);
    if (block === BlockTypes.AIR) return false;
    return this.setBlock(wx, wy, wz, block, updateMesh, color);
  }

  subdivideBlock(wx, wy, wz) {
    wx = wrapX(wx);
    wz = wrapZ(wz);
    const block = this.getBlock(wx, wy, wz);
    if (block === BlockTypes.AIR) return 0;
    const color = this.getBlockColor(wx, wy, wz);
    this.preserveCrossLayerStandardCell(wx, wy, wz);
    this.setBlock(wx, wy, wz, BlockTypes.AIR, true);
    const n = this.microVoxels.subdivide(wx, wy, wz, color);
    if (n > 0) {
      this.microVoxels.prioritizeStandardCell(wx, wz);
      const { cx, cz } = this.worldToChunkCoords(wx, wz);
      this.crossLayerPublicationChunks.add(World.getChunkKey(cx, cz));
      this.trackPendingRemoteMicroOverride({ type: 'subdivide', wx, wy, wz, color });
      const baseX = wrapX(wx) * MICRO_DIVISIONS;
      const baseY = wy * MICRO_DIVISIONS;
      const baseZ = wrapZ(wz) * MICRO_DIVISIONS;
      for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
        for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
          for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
            this.editPersistence?.recordMicro(baseX + dx, baseY + dy, baseZ + dz, color);
          }
        }
      }
      this.terrainVersion++;
    }
    return n;
  }

  setMicroBlock(mx, my, mz, color = DEFAULT_BLOCK_COLOR, part = null) {
    if (my < 0 || my >= CHUNK_SIZE_Y * MICRO_DIVISIONS) return false;
    mx = wrapMicroX(mx);
    mz = wrapMicroZ(mz);
    const wx = Math.floor(mx / MICRO_DIVISIONS);
    const wy = Math.floor(my / MICRO_DIVISIONS);
    const wz = Math.floor(mz / MICRO_DIVISIONS);
    if (this.getBlock(wx, wy, wz) !== BlockTypes.AIR) return false;
    const ok = this.microVoxels.set(mx, my, mz, color, part);
    if (ok) {
      this.microVoxels.prioritizeMeshAt(mx, mz);
      const persistedColor = this.microVoxels.get(mx, my, mz);
      this.editPersistence?.recordMicro(mx, my, mz, persistedColor, part);
      this.trackPendingRemoteMicroOverride({
        type: 'set',
        mx,
        my,
        mz,
        color: persistedColor,
        part,
      });
      this.terrainVersion++;
    }
    return ok;
  }

  /** Read a microblock by integer microcell index (five microcells per standard cell). */
  getMicroBlock(mx, my, mz) {
    const color = this.microVoxels.get(wrapMicroX(mx), my, wrapMicroZ(mz));
    if (color === null || color === undefined) return null;
    return { block: BlockTypes.COLOR_BLOCK, color };
  }

  /** Read only micro occupancy represented by an already-published terrain view. */
  getMicroCollisionBlock(mx, my, mz) {
    mx = wrapMicroX(mx);
    mz = wrapMicroZ(mz);
    if (!this.isMicroCollisionReady(mx, mz)) return null;
    const color = this.microVoxels.getPublishedCollisionColor(mx, my, mz);
    if (color === null || color === undefined) return null;
    return { block: BlockTypes.COLOR_BLOCK, color };
  }

  removeMicroBlock(mx, my, mz) {
    mx = wrapMicroX(mx);
    mz = wrapMicroZ(mz);
    const publishedColor = this.microVoxels.getPublishedCollisionColor(mx, my, mz);
    const applying = this.pendingRemoteChunkApply;
    const { cx, cz } = this.worldToChunkCoords(
      mx / MICRO_DIVISIONS,
      mz / MICRO_DIVISIONS,
    );
    const pendingSameChunk = Boolean(applying?.key === World.getChunkKey(cx, cz));
    const alreadyPendingDelete = Boolean(
      applying
      && pendingSameChunk
      && this.pendingRemoteOverridesDeleteMicroCell(applying, mx, my, mz)
    );
    const removed = this.microVoxels.delete(mx, my, mz);
    // During incremental remote replacement the visible old cell may already
    // be absent from the live staging data. Still accept that visible delete
    // and replay it after the incoming snapshot, otherwise the block can pop
    // back after publication.
    const acceptedPublishedDelete = Boolean(
      !removed
      && applying
      && pendingSameChunk
      && publishedColor !== null
      && !alreadyPendingDelete
    );
    const acceptedLiveDelete = removed && !alreadyPendingDelete;
    if (acceptedLiveDelete || acceptedPublishedDelete) {
      if (removed) this.microVoxels.prioritizeMeshAt(mx, mz);
      this.editPersistence?.removeMicro(mx, my, mz, pendingSameChunk);
      this.trackPendingRemoteMicroOverride({ type: 'delete', mx, my, mz });
      this.terrainVersion++;
    }
    return acceptedLiveDelete || acceptedPublishedDelete;
  }

  clearMicroStandardCell(wx, wy, wz) {
    wx = wrapX(wx);
    wz = wrapZ(wz);
    const { cx, cz } = this.worldToChunkCoords(wx, wz);
    const pendingSameChunk = Boolean(
      this.pendingRemoteChunkApply?.key === World.getChunkKey(cx, cz),
    );
    let publishedCount = 0;
    if (pendingSameChunk) {
      const baseX = wx * MICRO_DIVISIONS;
      const baseY = wy * MICRO_DIVISIONS;
      const baseZ = wz * MICRO_DIVISIONS;
      for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
        for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
          for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
            if (this.microVoxels.getPublishedCollisionColor(
              baseX + dx,
              baseY + dy,
              baseZ + dz,
            ) !== null) publishedCount++;
          }
        }
      }
    }

    const removed = this.microVoxels.clearStandardCell(wx, wy, wz);
    const acceptedPublishedClear = removed === 0 && publishedCount > 0;
    if (removed || acceptedPublishedClear) {
      if (removed) this.microVoxels.prioritizeStandardCell(wx, wz);
      this.editPersistence?.removeMicroStandardCell(
        wx,
        wy,
        wz,
        true,
        pendingSameChunk,
      );
      this.trackPendingRemoteMicroOverride({
        type: 'clear-standard',
        wx,
        wy,
        wz,
      });
      this.terrainVersion++;
    }
    return Math.max(removed, publishedCount);
  }

  private trackPendingRemoteMicroOverride(override: PendingMicroOverride) {
    const applying = this.pendingRemoteChunkApply;
    if (!applying) return;
    const wx = override.type === 'set' || override.type === 'delete'
      ? override.mx / MICRO_DIVISIONS
      : override.wx;
    const wz = override.type === 'set' || override.type === 'delete'
      ? override.mz / MICRO_DIVISIONS
      : override.wz;
    const { cx, cz } = this.worldToChunkCoords(wx, wz);
    if (World.getChunkKey(cx, cz) === applying.key) applying.localMicroOverrides.push(override);
  }

  /** Whether the latest queued local intent already leaves this microcell empty. */
  private pendingRemoteOverridesDeleteMicroCell(
    applying: PendingRemoteChunkApplyJob,
    mx: number,
    my: number,
    mz: number,
  ) {
    const wx = Math.floor(mx / MICRO_DIVISIONS);
    const wy = Math.floor(my / MICRO_DIVISIONS);
    const wz = Math.floor(mz / MICRO_DIVISIONS);
    for (let index = applying.localMicroOverrides.length - 1; index >= 0; index--) {
      const override = applying.localMicroOverrides[index];
      if (override.type === 'set' || override.type === 'delete') {
        if (override.mx !== mx || override.my !== my || override.mz !== mz) continue;
        return override.type === 'delete';
      }
      if (override.wx !== wx || override.wy !== wy || override.wz !== wz) continue;
      return override.type === 'clear-standard';
    }
    return false;
  }

  hasMicroInStandardCell(wx, wy, wz) {
    return this.microVoxels.hasAnyInStandardCell(wrapX(wx), wy, wrapZ(wz));
  }

  raycastMicro(origin, direction, maxDistance = 10, usePublishedCollision = true) {
    // Interactive targeting follows the published view by default. Script
    // queries can opt into the immediate logical state instead.
    return this.microVoxels.raycast(
      origin,
      direction,
      maxDistance,
      null,
      usePublishedCollision,
    );
  }

  raycastMicroCollision(origin, direction, maxDistance = 10) {
    return this.microVoxels.raycast(
      origin,
      direction,
      maxDistance,
      (mx, mz) => this.isMicroCollisionReady(mx, mz),
      true,
    );
  }

  getMicroBlocksInAABB(aabb, collisionReadyOnly = false) {
    const cells = collisionReadyOnly
      ? this.microVoxels.getPublishedCollisionCellsInAABB(aabb)
      : this.microVoxels.getCellsInAABB(aabb);
    if (!collisionReadyOnly) return cells;
    return cells.filter(cell => this.isMicroCollisionReady(
      Math.round(cell.x * MICRO_DIVISIONS),
      Math.round(cell.z * MICRO_DIVISIONS),
    ));
  }

  private isMicroCollisionReady(mx: number, mz: number) {
    const wx = mx / MICRO_DIVISIONS;
    const wz = mz / MICRO_DIVISIONS;
    const { cx, cz } = this.worldToChunkCoords(wx, wz);
    // A dirty micro partition still has valid live cell data. Keep using it for
    // collision while its replacement mesh is built; only a standard chunk
    // that has never been published is intentionally treated as empty.
    return Boolean(this.getChunk(cx, cz)?.mesh);
  }

  /**
   * Bent-space aiming ray for standard terrain. Sampling only discovers nearby
   * occupied candidates; the final result comes from an exact intersection with
   * the same bent face triangles that LowPolyMesher sends to the GPU.
   */
  raycastBent(originBent, dirBent, maxDistance = 8, usePublishedCollision = true) {
    const result = this.raycastBentVoxelFaces(
      originBent,
      dirBent,
      maxDistance,
      1,
      (x, y, z) => usePublishedCollision
        ? (this.getPublishedStandardCell(x, y, z)?.block ?? this.getBlock(x, y, z))
        : this.getBlock(x, y, z),
      value => value !== BlockTypes.AIR
    );
    if (!result) return { hit: false };

    const { x, y, z } = result.cell;
    const normal = result.normal;
    return {
      hit: true,
      kind: 'standard',
      hitPos: { x, y, z },
      placePos: { x: x + normal.x, y: y + normal.y, z: z + normal.z },
      normal,
      block: result.value,
      color: usePublishedCollision
        ? (this.getPublishedStandardCell(x, y, z)?.color ?? this.getBlockColor(x, y, z))
        : this.getBlockColor(x, y, z),
      size: 1,
      distance: result.distance,
      entry: result.entry
    };
  }

  /**
   * Exact bent-face raycast for 0.2 m micro voxels.
   */
  raycastMicroBent(originBent, dirBent, maxDistance = 8, usePublishedCollision = true) {
    const result = this.raycastBentVoxelFaces(
      originBent,
      dirBent,
      maxDistance,
      MICRO_DIVISIONS,
      // The old mesh remains visible while a local edit or remote snapshot is
      // rebuilt. Pick the matching published occupancy so rapid clicks cannot
      // tunnel through that visible surface into live cells behind it.
      (mx, my, mz) => usePublishedCollision
        ? this.microVoxels.getPublishedCollisionColor(mx, my, mz)
        : this.microVoxels.get(mx, my, mz),
      value => value !== null && value !== undefined
    );
    if (!result) return { hit: false };

    const { x: mx, y: my, z: mz } = result.cell;
    const normal = result.normal;
    return {
      hit: true,
      kind: 'micro',
      microPos: { x: mx, y: my, z: mz },
      hitPos: {
        x: mx / MICRO_DIVISIONS,
        y: my / MICRO_DIVISIONS,
        z: mz / MICRO_DIVISIONS
      },
      placeMicroPos: {
        x: mx + normal.x,
        y: my + normal.y,
        z: mz + normal.z
      },
      normal,
      color: result.value,
      size: 1 / MICRO_DIVISIONS,
      distance: result.distance,
      entry: result.entry
    };
  }

  /**
   * Discover occupied cells along the inverse-bent screen ray, then intersect
   * their exposed faces exactly in bent space. The one-cell neighborhood makes
   * grazing hits independent of the discovery step size.
   */
  raycastBentVoxelFaces(originBent, dirBent, maxDistance, divisions, getValue, isOccupied) {
    const direction = dirBent.clone().normalize();
    const ray = new THREE.Ray(originBent.clone(), direction);
    const cellSize = 1 / divisions;
    // Candidate discovery can be coarser than the cell because every sample
    // checks its full one-cell neighborhood; exact triangles decide the hit.
    const step = Math.min(0.25, cellSize);
    const cappedDistance = Math.min(maxDistance, 32);
    const periodX = TORUS_SIZE_X * divisions;
    const periodZ = TORUS_SIZE_Z * divisions;
    const maxY = CHUNK_SIZE_Y * divisions;
    const candidates = new Map();
    const p = this.rayBentPoint;
    const flat = this.rayFlatPoint;

    for (let t = 0; t <= cappedDistance + step; t += step) {
      p.copy(originBent).addScaledVector(direction, Math.min(t, cappedDistance));
      unbendPoint(p.x, p.y, p.z, flat);
      const sampleX = Math.floor(flat.x * divisions);
      const sampleY = Math.floor(flat.y * divisions);
      const sampleZ = Math.floor(flat.z * divisions);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const y = sampleY + dy;
          if (y < 0 || y >= maxY) continue;
          for (let dz = -1; dz <= 1; dz++) {
            const x = ((sampleX + dx) % periodX + periodX) % periodX;
            const z = ((sampleZ + dz) % periodZ + periodZ) % periodZ;
            const key = `${x},${y},${z}`;
            if (candidates.has(key)) continue;
            const value = getValue(x, y, z);
            if (isOccupied(value)) candidates.set(key, { x, y, z, value });
          }
        }
      }
    }

    const barycentric = new THREE.Vector3();
    let closest = null;
    let closestDistance = cappedDistance;
    for (const cell of candidates.values()) {
      const originX = cell.x * cellSize;
      const originY = cell.y * cellSize;
      const originZ = cell.z * cellSize;

      for (const face of BENT_VOXEL_RAYCAST_FACES) {
        const [nx, ny, nz] = face.normal;
        const neighborX = ((cell.x + nx) % periodX + periodX) % periodX;
        const neighborZ = ((cell.z + nz) % periodZ + periodZ) % periodZ;
        if (isOccupied(getValue(neighborX, cell.y + ny, neighborZ))) continue;

        const flatCorners = face.quad.map(([x, y, z]) => new THREE.Vector3(
          originX + x * cellSize,
          originY + y * cellSize,
          originZ + z * cellSize
        ));
        const bentCorners = flatCorners.map(corner => bendPoint(corner.x, corner.y, corner.z));

        for (const [ia, ib, ic] of [[0, 1, 2], [0, 2, 3]]) {
          const bentPoint = new THREE.Vector3();
          if (!intersectTriangleInclusive(
            ray, bentCorners[ia], bentCorners[ib], bentCorners[ic], bentPoint, barycentric
          )) continue;
          const distance = originBent.distanceTo(bentPoint);
          if (distance > closestDistance + 1e-9) continue;
          const entry = flatCorners[ia].clone().multiplyScalar(barycentric.x)
            .addScaledVector(flatCorners[ib], barycentric.y)
            .addScaledVector(flatCorners[ic], barycentric.z);
          closestDistance = distance;
          closest = {
            cell,
            value: cell.value,
            normal: { x: nx, y: ny, z: nz },
            distance,
            entry: { x: entry.x, y: entry.y, z: entry.z }
          };
        }
      }
    }
    return closest;
  }

  /** Sample the hit-face normal, pointing from the hit cell toward the previous air cell. */
  static _faceNormal(lastAir, hx, hy, hz, dirFlat, periodX = 0, periodZ = 0) {
    if (lastAir) {
      const dx = World._wrappedDelta(lastAir.x, hx, periodX);
      const dy = hy - lastAir.y;
      const dz = World._wrappedDelta(lastAir.z, hz, periodZ);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      if (ax >= ay && ax >= az && ax > 0) return { x: -Math.sign(dx), y: 0, z: 0 };
      if (ay >= ax && ay >= az && ay > 0) return { x: 0, y: -Math.sign(dy), z: 0 };
      if (az > 0) return { x: 0, y: 0, z: -Math.sign(dz) };
    }
    const d = {
      x: -(dirFlat ? dirFlat.x : 0),
      y: -(dirFlat ? dirFlat.y : 0),
      z: -(dirFlat ? dirFlat.z : 0)
    };
    const ax = Math.abs(d.x);
    const ay = Math.abs(d.y);
    const az = Math.abs(d.z);
    if (ax >= ay && ax >= az) return { x: Math.sign(d.x) || 0, y: 0, z: 0 };
    if (ay >= az) return { x: 0, y: Math.sign(d.y) || 0, z: 0 };
    return { x: 0, y: 0, z: Math.sign(d.z) || 0 };
  }

  static _wrappedDelta(from, to, period) {
    let delta = to - from;
    if (period > 0) {
      if (delta > period / 2) delta -= period;
      else if (delta < -period / 2) delta += period;
    }
    return delta;
  }

  /** Approximate the sampled ray's exact face entry while retaining tangential aim. */
  static _entryPoint(flat, hx, hy, hz, normal, cellSize) {
    const entry = { x: flat.x, y: flat.y, z: flat.z };
    if (normal.x) entry.x = (hx + (normal.x > 0 ? 1 : 0)) * cellSize;
    if (normal.y) entry.y = (hy + (normal.y > 0 ? 1 : 0)) * cellSize;
    if (normal.z) entry.z = (hz + (normal.z > 0 ? 1 : 0)) * cellSize;
    return entry;
  }

  markChunkDirty(cx, cz) {
    cx = wrapChunkX(cx);
    cz = wrapChunkZ(cz);
    const chunk = this.getChunk(cx, cz);
    if (chunk) {
      chunk.isDirty = true;
      this.dirtyChunks.add(chunk);
    }
  }

  /**
   * Update and regenerate dirty chunks
   */
  updateChunksAround(
    playerX,
    playerZ,
    processWork = true,
    workBudgetMs = STREAM_WORK_BUDGET_MS,
    offThreadStreaming = false,
  ) {
    const frameWorkStartedAt = processWork ? performance.now() : 0;
    const boundedWorkBudgetMs = Number.isFinite(workBudgetMs)
      ? Math.max(0, Math.min(STREAM_WORK_BUDGET_MS, workBudgetMs))
      : STREAM_WORK_BUDGET_MS;
    const centerCx = Math.floor(wrapX(playerX) / CHUNK_SIZE_X);
    const centerCz = Math.floor(wrapZ(playerZ) / CHUNK_SIZE_Z);
    const r = this.renderDistance;
    this.distantSurface.setNearField(centerCx, centerCz, r);

    // Recompute the streaming window only after crossing a chunk boundary. The
    // old implementation repeated 169 modulo/map lookups on every frame and
    // kept every visited mesh resident forever.
    const streamCenterKey = `${centerCx},${centerCz}`;
    if (streamCenterKey !== this.lastStreamCenterKey) {
      const hadPreviousStreamCenter = Boolean(this.lastStreamCenterKey);
      const nextActive = new Set<string>();
      const pending: { cx: number; cz: number; distanceSq: number }[] = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const cx = wrapChunkX(centerCx + dx);
          const cz = wrapChunkZ(centerCz + dz);
          const key = World.getChunkKey(cx, cz);
          nextActive.add(key);
          this.pendingChunkEvictions.delete(key);
          if (this.suspendedCrossLayerPublicationChunks.delete(key)) {
            this.crossLayerPublicationChunks.add(key);
          }
          const chunk = this.getChunk(cx, cz);
          if (!chunk) {
            this.distantSurface.setDetailChunkReady(cx, cz, false);
            pending.push({ cx, cz, distanceSq: dx * dx + dz * dz });
          } else if (chunk.mesh) {
            chunk.mesh.visible = true;
            this.distantSurface.setDetailChunkReady(cx, cz, true);
            // A chunk can leave and re-enter before its deferred eviction runs.
            // Its old mesh is still publishable, but a pending edit must resume
            // the remesh instead of becoming permanently stranded.
            if (chunk.isDirty) this.dirtyChunks.add(chunk);
          } else if (!chunk.mesh) {
            this.distantSurface.setDetailChunkReady(cx, cz, false);
            chunk.isDirty = true;
            this.dirtyChunks.add(chunk);
          }
        }
      }

      for (const [key, chunk] of this.chunks) {
        if (nextActive.has(key)) continue;
        this.suspendCrossLayerPublication(key);
        this.dirtyChunks.delete(chunk);
        this.interactiveDirtyChunks.delete(chunk);
        this.distantSurface.setDetailChunkReady(chunk.cx, chunk.cz, false);
        if (chunk.mesh) chunk.mesh.visible = false;
        this.pendingChunkEvictions.set(key, chunk);
      }

      this.activeChunkKeys = nextActive;
      this.pendingStreamChunks = pending.sort((a, b) => a.distanceSq - b.distanceSq);
      this.lastStreamCenterKey = streamCenterKey;
      // Crossing a chunk boundary already updates physics, camera and active
      // visibility. Start background allocation on the following render frame
      // so that boundary input itself never shares a frame with loading work.
      if (hadPreviousStreamCenter) this.deferStreamWorkOnce = true;
    }

    // The fixed simulation step only needs the current active window for
    // entity streaming. Chunk generation and meshing are render-frame work and
    // must consume a single shared budget, not another budget every 20 Hz tick.
    if (!processWork) return;
    if (this.deferStreamWorkOnce) {
      this.deferStreamWorkOnce = false;
      return;
    }

    if (offThreadStreaming) {
      this.publishCompletedTerrainWorkerJob();
      this.dispatchTerrainWorkerJob();
    }

    this.processPendingRemoteChunkUpdates(
      frameWorkStartedAt,
      boundedWorkBudgetMs,
      offThreadStreaming,
    );
    this.processPendingChunkEvictions(frameWorkStartedAt, boundedWorkBudgetMs);

    // Player-authored and remote micro edits are visible work; service one
    // dirty micro mesh before spending the remaining frame budget on new
    // procedural chunks.
    if (
      performance.now() - frameWorkStartedAt < boundedWorkBudgetMs
      && this.microVoxels.updateMesh(
        MAX_MICRO_MESH_CHUNKS_PER_FRAME,
        this.activeChunkKeys,
        this.microMeshBuildBlockedChunks,
        Math.max(0, boundedWorkBudgetMs - (performance.now() - frameWorkStartedAt)),
        this.crossLayerPublicationChunks,
      )
    ) {
      for (const mesh of this.microVoxels.takeRecentlyRebuiltMeshes()) {
        hookSceneMaterials(mesh);
      }
    }

    if (offThreadStreaming) {
      // Standard terrain generation and voxel face scanning never run on the
      // page thread. A missing chunk therefore remains empty/non-colliding
      // until its complete result is ready for an atomic scene publication.
      this.dispatchTerrainWorkerJob();
      return;
    }

    // Allocate/generate the nearest missing chunks progressively instead of
    // synchronously constructing the entire window during one frame.
    let generated = 0;
    while (this.pendingStreamChunks.length > 0 && generated < MAX_STREAM_CHUNKS_PER_FRAME) {
      if (performance.now() - frameWorkStartedAt >= boundedWorkBudgetMs) break;
      const next = this.pendingStreamChunks.shift();
      if (!next) break;
      const { cx, cz } = next;
      const key = World.getChunkKey(cx, cz);
      if (!this.activeChunkKeys.has(key)) continue;
      const chunk = this.getOrCreateChunk(cx, cz);
      if (!chunk.mesh) {
        chunk.isDirty = true;
        this.dirtyChunks.add(chunk);
      }
      generated++;
    }

    // Process dirty chunks
    let updates = 0;
    const maxUpdatesPerFrame = MAX_CHUNK_MESHES_PER_FRAME;

    for (const chunk of this.dirtyChunks) {
      if (updates >= maxUpdatesPerFrame) break;
      if (performance.now() - frameWorkStartedAt >= boundedWorkBudgetMs) break;
      const key = World.getChunkKey(chunk.cx, chunk.cz);
      if (!this.activeChunkKeys.has(key)) continue;
      if (
        this.crossLayerPublicationChunks.has(key)
        && !this.microVoxels.isDeferredPublicationReady(key, this.activeChunkKeys)
      ) continue;

      this.publishChunkMesh(chunk, this.mesher.buildChunkMeshData(chunk));
      this.commitCrossLayerPublication(key);

      chunk.isDirty = false;
      this.dirtyChunks.delete(chunk);
      this.interactiveDirtyChunks.delete(chunk);
      updates++;
    }

  }

  /** Current publication progress for the detailed terrain AOI. */
  getTerrainAoiLoadProgress(): TerrainAoiLoadProgress {
    const totalChunks = this.activeChunkKeys.size;
    let readyChunks = 0;
    for (const key of this.activeChunkKeys) {
      const chunk = this.chunks.get(key);
      if (
        chunk?.mesh
        && !chunk.isDirty
        && !this.dirtyChunks.has(chunk)
        && !this.crossLayerPublicationChunks.has(key)
        && !this.pendingRemoteChunkUpdates.has(key)
        && this.pendingRemoteChunkApply?.key !== key
        && !this.pendingTerrainSnapshots.has(key)
      ) readyChunks++;
    }
    const microReady = !this.microVoxels.hasPendingMeshWork(this.activeChunkKeys);
    return {
      readyChunks,
      totalChunks,
      ready: totalChunks > 0 && readyChunks === totalChunks && microReady,
    };
  }

  /**
   * Build and publish every detailed chunk in the initial active AOI before
   * gameplay begins. Browser generation stays in the terrain worker and this
   * loop yields every frame so the entry screen can repaint its progress.
   */
  async preloadTerrainAoi(
    playerX: number,
    playerZ: number,
    onProgress?: (progress: TerrainAoiLoadProgress) => void,
  ) {
    this.updateChunksAround(playerX, playerZ, false);
    let lastReadyChunks = -1;

    while (true) {
      const progress = this.getTerrainAoiLoadProgress();
      if (progress.readyChunks !== lastReadyChunks || progress.ready) {
        onProgress?.(progress);
        lastReadyChunks = progress.readyChunks;
      }
      if (progress.ready) return progress;

      if (this.requireOffThreadTerrainStreaming && !this.terrainWorker) {
        throw new Error('The terrain worker stopped before the initial AOI finished loading.');
      }
      this.updateChunksAround(
        playerX,
        playerZ,
        true,
        STREAM_WORK_BUDGET_MS,
        this.requireOffThreadTerrainStreaming,
      );
      await new Promise<void>(resolve => {
        if (typeof globalThis.requestAnimationFrame === 'function') {
          globalThis.requestAnimationFrame(() => resolve());
        } else {
          globalThis.setTimeout(resolve, 0);
        }
      });
    }
  }

  private publishChunkMesh(
    chunk: Chunk,
    meshData: ChunkMeshData,
    dataVersion = chunk.dataVersion,
  ) {
    const previousMesh = chunk.mesh;
    const nextMesh = this.mesher.createChunkMeshFromData(chunk, meshData);
    nextMesh.userData.bentSphere = computeChunkBentSphere(
      chunk.cx,
      chunk.cz,
      null,
      nextMesh.userData.occupiedMinY,
      nextMesh.userData.occupiedMaxY,
    );
    nextMesh.userData.bentSphereRevision = getWorldProjectionRevision();
    // Install the projection and matching shadow shader before publication so
    // the first visible frame cannot flash in flat coordinates.
    hookSceneMaterials(nextMesh);
    nextMesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) child.frustumCulled = false;
    });

    // Publish first, then retire the previous mesh. The far-surface ownership
    // mask remains set throughout an edit, so rendering and collision never
    // observe an empty transition state.
    this.worldGroup.add(nextMesh);
    chunk.mesh = nextMesh;
    chunk.publishedDataVersion = dataVersion;
    this.distantSurface.setDetailChunkReady(chunk.cx, chunk.cz, true);
    if (previousMesh) this.disposeDetachedChunkMesh(previousMesh);
  }

  private disposeDetachedChunkMesh(mesh) {
    this.worldGroup.remove(mesh);
    mesh.traverse((child) => {
      if (child.isMesh && child.geometry) child.geometry.dispose();
    });
  }

  private publishCompletedTerrainWorkerJob() {
    const nextCompleted = this.completedTerrainWorkerJobs[0];
    if (!nextCompleted) return false;
    const { job: nextJob, result: nextResult } = nextCompleted;
    const nextChunk = this.chunks.get(nextJob.key) ?? null;
    if (
      this.crossLayerPublicationChunks.has(nextJob.key)
      && !this.activeChunkKeys.has(nextJob.key)
    ) {
      this.abortCrossLayerPublication(nextJob.key);
    }
    let waitsForMicroPublication = false;
    if (
      this.crossLayerPublicationChunks.has(nextJob.key)
      && this.activeChunkKeys.has(nextJob.key)
    ) {
      if (nextJob.type === 'remesh') {
        waitsForMicroPublication = nextChunk?.dataVersion === nextJob.dataVersion
          && Boolean(nextResult.mesh);
      } else if (nextJob.snapshot) {
        const queuedRevision = Number(
          this.pendingRemoteChunkUpdates.get(nextJob.key)?.revision ?? -1,
        );
        const applyingRevision = this.pendingRemoteChunkApply?.key === nextJob.key
          ? this.pendingRemoteChunkApply.revision
          : -1;
        const snapshotIsCurrent = (this.remoteChunkRevisions.get(nextJob.key) ?? -1)
            === nextJob.snapshot.revision
          && queuedRevision <= nextJob.snapshot.revision
          && applyingRevision <= nextJob.snapshot.revision;
        const replacementIsCurrent = nextJob.replacingChunk
          ? nextChunk === nextJob.replacingChunk && nextChunk.dataVersion === nextJob.dataVersion
          : nextChunk === null;
        waitsForMicroPublication = snapshotIsCurrent
          && replacementIsCurrent
          && Boolean(nextResult.blocks && nextResult.terrainColors && nextResult.mesh);
      } else {
        const blockedByRemoteSnapshot = this.pendingRemoteChunkUpdates.has(nextJob.key)
          || this.pendingRemoteChunkApply?.key === nextJob.key
          || this.pendingTerrainSnapshots.has(nextJob.key);
        waitsForMicroPublication = nextChunk === null
          && !blockedByRemoteSnapshot
          && Boolean(nextResult.blocks && nextResult.terrainColors && nextResult.mesh);
      }
    }
    if (
      waitsForMicroPublication
      && !this.microVoxels.isDeferredPublicationReady(
        nextCompleted.job.key,
        this.activeChunkKeys,
      )
    ) return false;
    const completed = this.completedTerrainWorkerJobs.shift()!;
    const { job, result } = completed;

    if (job.type === 'remesh') {
      const chunk = this.chunks.get(job.key);
      if (
        !chunk
        || !this.activeChunkKeys.has(job.key)
        || (job.remeshChunk && chunk !== job.remeshChunk)
        || !result.mesh
      ) return false;

      const resultDataVersion = job.dataVersion ?? -1;
      if (chunk.dataVersion !== resultDataVersion) {
        // Continuous placement can make every in-flight result stale. Publish
        // monotonically newer intermediate meshes so visual feedback keeps
        // advancing, then leave the latest chunk state queued for one more
        // rebuild. Cross-layer replacements retain their atomic barrier.
        if (
          !this.crossLayerPublicationChunks.has(job.key)
          && resultDataVersion > chunk.publishedDataVersion
        ) {
          this.publishChunkMesh(chunk, result.mesh, resultDataVersion);
          return true;
        }
        return false;
      }

      this.publishChunkMesh(chunk, result.mesh, resultDataVersion);
      this.commitCrossLayerPublication(job.key);
      chunk.isDirty = false;
      this.dirtyChunks.delete(chunk);
      this.interactiveDirtyChunks.delete(chunk);
      return true;
    }

    if (job.snapshot) {
      const snapshot = job.snapshot;
      const queuedRevision = Number(this.pendingRemoteChunkUpdates.get(job.key)?.revision ?? -1);
      const applyingRevision = this.pendingRemoteChunkApply?.key === job.key
        ? this.pendingRemoteChunkApply.revision
        : -1;
      const snapshotIsCurrent = (this.remoteChunkRevisions.get(job.key) ?? -1) === snapshot.revision
        && queuedRevision <= snapshot.revision
        && applyingRevision <= snapshot.revision;
      const replacingChunk = job.replacingChunk ?? null;
      const currentChunk = this.chunks.get(job.key) ?? null;
      const replacementIsCurrent = replacingChunk
        ? currentChunk === replacingChunk && currentChunk.dataVersion === job.dataVersion
        : currentChunk === null;
      if (
        !snapshotIsCurrent
        || !this.activeChunkKeys.has(job.key)
        || !replacementIsCurrent
        || !result.blocks
        || !result.terrainColors
        || !result.mesh
      ) {
        if (snapshotIsCurrent) this.requeueTerrainSnapshot(snapshot);
        this.recycleCompletedWorkerChunk(job, result);
        return false;
      }

      const chunk = replacingChunk
        ?? job.recycledChunk
        ?? new Chunk(job.cx, job.cz, this);
      if (!replacingChunk) chunk.reuseAt(job.cx, job.cz, this);
      chunk.installGeneratedData(
        result.blocks,
        result.terrainColors,
        result.mesh.occupiedMinY,
        result.mesh.occupiedMaxY - 1,
        result.hasUserEdits === true,
      );
      if (!replacingChunk) this.chunks.set(job.key, chunk);
      this.publishChunkMesh(chunk, result.mesh);
      this.commitCrossLayerPublication(job.key);
      chunk.isDirty = false;
      this.dirtyChunks.delete(chunk);
      this.interactiveDirtyChunks.delete(chunk);
      return true;
    }

    const blockedByRemoteSnapshot = this.pendingRemoteChunkUpdates.has(job.key)
      || this.pendingRemoteChunkApply?.key === job.key
      || this.pendingTerrainSnapshots.has(job.key);
    if (
      !this.activeChunkKeys.has(job.key)
      || this.chunks.has(job.key)
      || blockedByRemoteSnapshot
      || !result.blocks
      || !result.terrainColors
      || !result.mesh
    ) {
      if (blockedByRemoteSnapshot && this.activeChunkKeys.has(job.key) && !this.chunks.has(job.key)) {
        this.pendingStreamChunks.unshift({ cx: job.cx, cz: job.cz, distanceSq: 0 });
      }
      this.recycleCompletedWorkerChunk(job, result);
      return false;
    }

    const chunk = job.recycledChunk ?? new Chunk(job.cx, job.cz, this);
    chunk.reuseAt(job.cx, job.cz, this);
    chunk.installGeneratedData(
      result.blocks,
      result.terrainColors,
      result.mesh.occupiedMinY,
      result.mesh.occupiedMaxY - 1,
      result.hasUserEdits === true,
    );
    this.chunks.set(job.key, chunk);
    this.publishChunkMesh(chunk, result.mesh);
    this.commitCrossLayerPublication(job.key);
    return true;
  }

  private recycleCompletedWorkerChunk(job: TerrainWorkerJob, result: TerrainWorkerResult) {
    const chunk = job.recycledChunk;
    if (!chunk || !result.blocks || !result.terrainColors) return;
    chunk.blocks = result.blocks;
    chunk.colors = result.terrainColors;
    if (this.recycledProceduralChunks.length < MAX_RECYCLED_PROCEDURAL_CHUNKS) {
      this.recycledProceduralChunks.push(chunk);
    }
  }

  private dispatchTerrainWorkerJob() {
    const worker = this.terrainWorker;
    if (!worker || this.terrainWorkerJob) return false;
    if (this.completedTerrainWorkerJobs.length > 0) return false;

    // Authoritative snapshots replace a published chunk only after their full
    // generated data and mesh are ready. Until then, the previous collision
    // arrays and detailed mesh remain live.
    for (const [key, snapshot] of this.pendingTerrainSnapshots) {
      if (!this.activeChunkKeys.has(key)) continue;
      if (this.pendingRemoteChunkApply?.key === key) continue;
      const queuedRevision = Number(this.pendingRemoteChunkUpdates.get(key)?.revision ?? -1);
      if (queuedRevision > snapshot.revision) continue;

      const replacingChunk = this.chunks.get(key) ?? null;
      const recycledChunk = replacingChunk
        ? null
        : (this.recycledProceduralChunks.pop() ?? null);
      const job: TerrainWorkerJob = {
        requestId: this.nextTerrainWorkerRequestId++,
        type: 'generate',
        key,
        cx: snapshot.cx,
        cz: snapshot.cz,
        dataVersion: replacingChunk?.dataVersion,
        recycledChunk,
        replacingChunk,
        snapshot,
      };
      const request: any = {
        type: job.type,
        requestId: job.requestId,
        seed: this.terrainSeed,
        cx: job.cx,
        cz: job.cz,
        standardEdits: snapshot.standardEdits,
      };
      const transfer: ArrayBuffer[] = [];
      if (recycledChunk?.blocks.buffer.byteLength && recycledChunk?.colors.buffer.byteLength) {
        request.blocksBuffer = recycledChunk.blocks.buffer;
        request.colorsBuffer = recycledChunk.colors.buffer;
        transfer.push(
          recycledChunk.blocks.buffer as ArrayBuffer,
          recycledChunk.colors.buffer as ArrayBuffer,
        );
      }
      this.pendingTerrainSnapshots.delete(key);
      this.terrainWorkerJob = job;
      worker.postMessage(request, transfer);
      return true;
    }

    // Rebuild direct player edits before ordinary dirty chunks. Keeping this
    // queue separate also lets the render loop service it without waiting for
    // requestIdleCallback while movement is continuously streaming terrain.
    let remeshChunk: Chunk | null = null;
    for (const chunk of this.interactiveDirtyChunks) {
      const key = World.getChunkKey(chunk.cx, chunk.cz);
      if (!this.activeChunkKeys.has(key) || !this.dirtyChunks.has(chunk)) {
        this.interactiveDirtyChunks.delete(chunk);
        continue;
      }
      remeshChunk = chunk;
      break;
    }
    if (!remeshChunk) {
      for (const chunk of this.dirtyChunks) {
        const key = World.getChunkKey(chunk.cx, chunk.cz);
        if (!this.activeChunkKeys.has(key)) continue;
        remeshChunk = chunk;
        break;
      }
    }
    if (remeshChunk) {
      const key = World.getChunkKey(remeshChunk.cx, remeshChunk.cz);
      const occupied = remeshChunk.getOccupiedYRange();
      const blocks = remeshChunk.blocks.slice();
      const colors = remeshChunk.colors.slice();
      const job: TerrainWorkerJob = {
        requestId: this.nextTerrainWorkerRequestId++,
        type: 'remesh',
        key,
        cx: remeshChunk.cx,
        cz: remeshChunk.cz,
        dataVersion: remeshChunk.dataVersion,
        remeshChunk,
      };
      this.terrainWorkerJob = job;
      worker.postMessage({
        type: job.type,
        requestId: job.requestId,
        seed: this.terrainSeed,
        cx: job.cx,
        cz: job.cz,
        dataVersion: job.dataVersion,
        minOccupiedY: occupied?.min ?? 0,
        maxOccupiedY: occupied?.max ?? -1,
        blocksBuffer: blocks.buffer,
        colorsBuffer: colors.buffer,
      }, [blocks.buffer, colors.buffer]);
      return true;
    }

    while (this.pendingStreamChunks.length > 0) {
      const next = this.pendingStreamChunks.shift();
      if (!next) break;
      const key = World.getChunkKey(next.cx, next.cz);
      if (!this.activeChunkKeys.has(key) || this.chunks.has(key)) continue;
      if (
        this.pendingRemoteChunkUpdates.has(key)
        || this.pendingRemoteChunkApply?.key === key
        || this.pendingTerrainSnapshots.has(key)
      ) {
        this.pendingStreamChunks.push(next);
        return false;
      }

      const standardEdits = [...(this.editPersistence?.getStandardEditsForChunk(next.cx, next.cz)
        ?? [])].map(edit => [edit.x, edit.y, edit.z, edit.block, edit.color]);
      const recycledChunk = this.recycledProceduralChunks.pop() ?? null;
      const job: TerrainWorkerJob = {
        requestId: this.nextTerrainWorkerRequestId++,
        type: 'generate',
        key,
        cx: next.cx,
        cz: next.cz,
        recycledChunk,
      };
      const request: any = {
        type: job.type,
        requestId: job.requestId,
        seed: this.terrainSeed,
        cx: job.cx,
        cz: job.cz,
        standardEdits,
      };
      const transfer: ArrayBuffer[] = [];
      if (recycledChunk?.blocks.buffer.byteLength && recycledChunk?.colors.buffer.byteLength) {
        request.blocksBuffer = recycledChunk.blocks.buffer;
        request.colorsBuffer = recycledChunk.colors.buffer;
        transfer.push(
          recycledChunk.blocks.buffer as ArrayBuffer,
          recycledChunk.colors.buffer as ArrayBuffer,
        );
      }
      this.terrainWorkerJob = job;
      worker.postMessage(request, transfer);
      return true;
    }
    return false;
  }

  /**
   * Service player-authored terrain before the next draw. Background chunk
   * generation remains idle-budgeted, but an edit can publish a finished job
   * and launch its high-priority remesh even while movement keeps the browser
   * too busy to grant requestIdleCallback time.
   */
  processInteractiveTerrainWork() {
    // The layer's dirty queue is the single source of truth. Priority markers
    // only reorder work; losing or invalidating one can never make a dirty
    // partition ineligible for these guaranteed foreground slices.
    const microUpdated = this.microVoxels.updateMesh(
      MAX_MICRO_MESH_CHUNKS_PER_FRAME,
      this.activeChunkKeys,
      this.microMeshBuildBlockedChunks,
      INTERACTIVE_MICRO_WORK_BUDGET_MS,
      this.crossLayerPublicationChunks,
    );
    for (const mesh of this.microVoxels.takeRecentlyRebuiltMeshes()) {
      hookSceneMaterials(mesh);
    }

    if (!this.terrainWorker || this.interactiveDirtyChunks.size === 0) return microUpdated;
    const published = this.publishCompletedTerrainWorkerJob();
    const dispatched = this.dispatchTerrainWorkerJob();
    return microUpdated || published || dispatched;
  }

  private commitCrossLayerPublication(key: string) {
    if (!this.crossLayerPublicationChunks.has(key)) return;
    this.microVoxels.publishDeferredForStandardChunk(key, mesh => hookSceneMaterials(mesh));
    this.crossLayerPublicationChunks.delete(key);
    this.crossLayerPublishedStandardCells.delete(key);
  }

  private abortCrossLayerPublication(key: string) {
    if (!this.crossLayerPublicationChunks.delete(key)) return;
    this.microVoxels.abortDeferredForStandardChunk(key);
    if (!this.suspendedCrossLayerPublicationChunks.has(key)) {
      this.crossLayerPublishedStandardCells.delete(key);
    }
  }

  private suspendCrossLayerPublication(key: string) {
    if (!this.crossLayerPublicationChunks.has(key)) return;
    this.suspendedCrossLayerPublicationChunks.add(key);
    this.abortCrossLayerPublication(key);
  }

  /**
   * Run streaming after the current scene has rendered, and only when
   * the browser reports genuine idle time before the next display frame.
   */
  scheduleStreamingWork() {
    if (this.streamWorkScheduled || !this.lastStreamCenterKey) return;
    this.streamWorkScheduled = true;
    const run = (budgetMs: number) => {
      this.streamWorkScheduled = false;
      if (!this.lastStreamCenterKey) return;
      const [centerCx, centerCz] = this.lastStreamCenterKey.split(',').map(Number);
      this.updateChunksAround(
        centerCx * CHUNK_SIZE_X + CHUNK_SIZE_X * 0.5,
        centerCz * CHUNK_SIZE_Z + CHUNK_SIZE_Z * 0.5,
        true,
        budgetMs,
        this.requireOffThreadTerrainStreaming,
      );
    };
    const requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle === 'function') {
      requestIdle(deadline => {
        const remaining = deadline.timeRemaining();
        if (remaining < 1.5) {
          this.streamWorkScheduled = false;
          return;
        }
        run(Math.min(BACKGROUND_MAIN_THREAD_BUDGET_MS, remaining - 0.5));
      });
      return;
    }
    // Older browsers still run the work after the submitted render, using a
    // tighter cap so the timer cannot monopolize the next animation frame.
    globalThis.setTimeout(() => run(1), 0);
  }

  setRenderDistance(distance) {
    this.renderDistance = Math.max(3, Math.min(24, Math.round(Number(distance)) || DEFAULT_RENDER_DISTANCE));
    this.lastStreamCenterKey = null;
  }

  getDistantSurfaceSettings(): DistantSurfaceSettings {
    return this.distantSurface.getSettings();
  }

  setDistantSurfaceSettings(settings: Partial<DistantSurfaceSettings>): DistantSurfaceSettings {
    return this.distantSurface.setSettings(settings);
  }

  setDistantSurfaceEnabled(enabled: boolean): boolean {
    return this.distantSurface.setEnabled(enabled);
  }

  installSurfaceZone(zone: SurfaceZoneSnapshot) {
    this.distantSurface.installZone(zone);
  }

  finalizeSurfaceConnections() {
    return this.distantSurface.finalizeConnections();
  }

  removeSurfaceZone(zoneX: number, zoneZ: number) {
    this.distantSurface.removeZone(zoneX, zoneZ);
  }

  disposeChunkMesh(chunk) {
    if (!chunk?.mesh) return;
    this.distantSurface.setDetailChunkReady(chunk.cx, chunk.cz, false);
    this.disposeDetachedChunkMesh(chunk.mesh);
    chunk.mesh = null;
  }

  private processPendingChunkEvictions(frameWorkStartedAt: number, workBudgetMs: number) {
    let processed = 0;
    for (const [key, chunk] of this.pendingChunkEvictions) {
      if (processed >= MAX_CHUNK_EVICTIONS_PER_FRAME) break;
      if (performance.now() - frameWorkStartedAt >= workBudgetMs) break;
      this.pendingChunkEvictions.delete(key);
      if (this.activeChunkKeys.has(key)) continue;
      if (chunk.mesh) this.disposeChunkMesh(chunk);
      this.dirtyChunks.delete(chunk);
      this.interactiveDirtyChunks.delete(chunk);
      if (!chunk.hasUserEdits) {
        this.chunks.delete(key);
        if (this.recycledProceduralChunks.length < MAX_RECYCLED_PROCEDURAL_CHUNKS) {
          this.recycledProceduralChunks.push(chunk);
        }
      }
      processed++;
    }
  }

  /**
   * Fast 3D DDA Voxel Raycaster
   */
  raycast(origin, direction, maxDistance = 10) {
    const startX = origin.x;
    const startY = origin.y;
    const startZ = origin.z;

    const dirX = direction.x;
    const dirY = direction.y;
    const dirZ = direction.z;

    let x = Math.floor(startX);
    let y = Math.floor(startY);
    let z = Math.floor(startZ);

    const stepX = Math.sign(dirX);
    const stepY = Math.sign(dirY);
    const stepZ = Math.sign(dirZ);

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dirX) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dirY) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dirZ) : Infinity;

    let tMaxX = stepX === 0 ? Infinity : stepX > 0
      ? (Math.floor(startX) + 1 - startX) * tDeltaX
      : (startX - Math.floor(startX)) * tDeltaX;
    let tMaxY = stepY === 0 ? Infinity : stepY > 0
      ? (Math.floor(startY) + 1 - startY) * tDeltaY
      : (startY - Math.floor(startY)) * tDeltaY;
    let tMaxZ = stepZ === 0 ? Infinity : stepZ > 0
      ? (Math.floor(startZ) + 1 - startZ) * tDeltaZ
      : (startZ - Math.floor(startZ)) * tDeltaZ;

    let normal = { x: 0, y: 0, z: 0 };
    let distance = 0;

    while (distance <= maxDistance) {
      const block = this.getBlock(x, y, z);
      if (block !== BlockTypes.AIR) {
        return {
          hit: true,
          kind: 'standard',
          hitPos: { x, y, z },
          placePos: { x: x + normal.x, y: y + normal.y, z: z + normal.z },
          normal,
          block,
          color: this.getBlockColor(x, y, z),
          size: 1,
          distance
        };
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          distance = tMaxX;
          tMaxX += tDeltaX;
          x = wrapX(x + stepX);
          normal = { x: -stepX, y: 0, z: 0 };
        } else {
          distance = tMaxZ;
          tMaxZ += tDeltaZ;
          z = wrapZ(z + stepZ);
          normal = { x: 0, y: 0, z: -stepZ };
        }
      } else {
        if (tMaxY < tMaxZ) {
          distance = tMaxY;
          tMaxY += tDeltaY;
          y += stepY;
          normal = { x: 0, y: -stepY, z: 0 };
        } else {
          distance = tMaxZ;
          tMaxZ += tDeltaZ;
          z = wrapZ(z + stepZ);
          normal = { x: 0, y: 0, z: -stepZ };
        }
      }
    }

    return { hit: false };
  }

  /**
   * Super Glue: BFS Connected Component Flood Fill
   * Returns array of {x, y, z, blockType}
   */
  getConnectedBlocks(startX, startY, startZ, maxBlocks = 512) {
    const originBlock = this.getBlock(startX, startY, startZ);
    if (!originBlock || originBlock === BlockTypes.AIR) return [];

    const queue = [{ x: startX, y: startY, z: startZ }];
    const visited = new Set();
    const result = [];
    const originKey = `${wrapX(startX)},${startY},${wrapZ(startZ)}`;
    visited.add(originKey);

    const neighbors = [
      { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }
    ];

    while (queue.length > 0 && result.length < maxBlocks) {
      const current = queue.shift();
      const b = this.getBlock(current.x, current.y, current.z);

      if (b !== BlockTypes.AIR) {
        result.push({
          x: wrapX(current.x),
          y: current.y,
          z: wrapZ(current.z),
          block: b,
          color: this.getBlockColor(current.x, current.y, current.z)
        });

        for (const n of neighbors) {
          const nx = current.x + n.x;
          const ny = current.y + n.y;
          const nz = current.z + n.z;
          const key = `${wrapX(nx)},${ny},${wrapZ(nz)}`;

          if (!visited.has(key)) {
            visited.add(key);
            const nb = this.getBlock(nx, ny, nz);
            if (nb !== BlockTypes.AIR) {
              queue.push({ x: nx, y: ny, z: nz });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Extract region bounding box for contraption assembly
   */
  extractRegion(minX, minY, minZ, maxX, maxY, maxZ) {
    const blocks = [];
    const affectedChunks: Set<Chunk> = new Set();

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = this.getBlock(x, y, z);
          if (block !== BlockTypes.AIR) {
            blocks.push({
              worldX: x,
              worldY: y,
              worldZ: z,
              block,
              color: this.getBlockColor(x, y, z)
            });
            // Clear block from world
            this.setBlock(x, y, z, BlockTypes.AIR, false);
            const { cx, cz } = this.worldToChunkCoords(x, z);
            const chunk = this.getChunk(cx, cz);
            if (chunk) affectedChunks.add(chunk);
          }
        }
      }
    }

    // Mark affected chunks dirty to update meshes
    for (const chunk of affectedChunks) {
      chunk.isDirty = true;
      this.dirtyChunks.add(chunk);
    }

    return blocks;
  }

  extractMicroRegion(minX, minY, minZ, maxX, maxY, maxZ) {
    const extracted = this.microVoxels.extractRegion(minX, minY, minZ, maxX, maxY, maxZ);
    if (extracted.length > 0) {
      for (const cell of extracted) {
        this.microVoxels.prioritizeMeshAt(cell.mx, cell.mz);
        this.editPersistence?.removeMicro(cell.mx, cell.my, cell.mz);
        this.trackPendingRemoteMicroOverride({
          type: 'delete',
          mx: cell.mx,
          my: cell.my,
          mz: cell.mz,
        });
      }
      this.terrainVersion++;
    }
    return extracted;
  }

  /**
   * Remove and return microcells inside an inclusive integer micro-index box.
   * Unlike extractMicroRegion the bounds are 0.2 m grid coordinates, so a
   * single cell is addressed by equal min/max values without float artifacts.
   */
  extractMicroCellRegion(minMx, minMy, minMz, maxMx, maxMy, maxMz) {
    const extracted = this.microVoxels.extractCellsInBox(minMx, minMy, minMz, maxMx, maxMy, maxMz);
    if (extracted.length > 0) {
      for (const cell of extracted) {
        this.microVoxels.prioritizeMeshAt(cell.mx, cell.mz);
        this.editPersistence?.removeMicro(cell.mx, cell.my, cell.mz);
        this.trackPendingRemoteMicroOverride({
          type: 'delete',
          mx: cell.mx,
          my: cell.my,
          mz: cell.mz,
        });
      }
      this.terrainVersion++;
    }
    return extracted;
  }

  /** Force pending browser-local terrain edits to durable storage. */
  flushPersistedEdits() {
    return this.editPersistence?.flush() ?? false;
  }

  /**
   * Coalesce network/AOI updates and apply a small bounded batch per animation
   * frame. A direct synchronous entry point remains for tests and explicit
   * callers that need immediate visibility.
   */
  queueRemoteChunkUpdates(updates: TerrainEditChunk[]) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    for (const update of updates) {
      const cx = wrapChunkX(update.chunk_x);
      const cz = wrapChunkZ(update.chunk_z);
      const key = World.getChunkKey(cx, cz);
      const revision = Number.isFinite(Number(update.revision)) ? Number(update.revision) : 0;
      if ((this.remoteChunkRevisions.get(key) ?? -1) >= revision) continue;
      if (this.pendingRemoteChunkApply?.key === key
        && this.pendingRemoteChunkApply.revision >= revision) continue;
      const previous = this.pendingRemoteChunkUpdates.get(key);
      if (previous && Number(previous.revision) >= revision) continue;
      this.pendingRemoteChunkUpdates.set(key, {
        chunk_x: cx,
        chunk_z: cz,
        revision,
        standard: Array.isArray(update.standard) ? update.standard : [],
        micro: Array.isArray(update.micro) ? update.micro : [],
      });
    }
  }

  private processPendingRemoteChunkUpdates(
    frameWorkStartedAt: number,
    workBudgetMs: number,
    offThreadStreaming: boolean,
  ) {
    const maxEdits = offThreadStreaming
      ? MAX_BACKGROUND_REMOTE_EDITS_PER_FRAME
      : MAX_REMOTE_EDITS_PER_FRAME;
    let completedChunks = 0;
    while (completedChunks < MAX_REMOTE_CHUNKS_PER_FRAME) {
      if (!this.pendingRemoteChunkApply) {
        const next = this.pendingRemoteChunkUpdates.entries().next();
        if (next.done) return;
        const [key, update] = next.value;
        this.pendingRemoteChunkUpdates.delete(key);
        if ((this.remoteChunkRevisions.get(key) ?? -1) >= Number(update.revision)) continue;
        this.pendingRemoteChunkApply = this.beginPendingRemoteChunkApply(update);
      }

      if (!this.advancePendingRemoteChunkApply(
        frameWorkStartedAt,
        workBudgetMs,
        maxEdits,
        offThreadStreaming,
      )) return;
      completedChunks++;
      if (performance.now() - frameWorkStartedAt >= workBudgetMs) return;
    }
  }

  private beginPendingRemoteChunkApply(update: TerrainEditChunk): PendingRemoteChunkApplyJob {
    const cx = wrapChunkX(update.chunk_x);
    const cz = wrapChunkZ(update.chunk_z);
    const key = World.getChunkKey(cx, cz);
    const revision = Number.isFinite(Number(update.revision)) ? Number(update.revision) : 0;
    if (this.activeChunkKeys.has(key) && this.chunks.get(key)?.mesh) {
      this.crossLayerPublicationChunks.add(key);
    }
    this.microMeshBuildBlockedChunks.add(key);
    const microClearCursor = this.microVoxels.beginClearChunk(cx, cz);
    const persistenceCursor = this.editPersistence
      ? this.editPersistence.beginRemoteChunkReplacement(update)
      : null;
    return {
      update,
      key,
      cx,
      cz,
      revision,
      phase: 'micro-clear',
      microClearCursor,
      persistenceCursor,
      microIterator: null,
      standardIterator: null,
      rawMicroIndex: 0,
      rawStandardIndex: 0,
      chunk: null,
      chunkPrepared: false,
      standardComplete: false,
      workerStandardEdits: [],
      localStandardOverrides: [],
      localMicroOverrides: [],
    };
  }

  private advancePendingRemoteChunkApply(
    frameWorkStartedAt: number,
    workBudgetMs: number,
    maxEdits: number,
    offThreadStreaming: boolean,
  ): boolean {
    const job = this.pendingRemoteChunkApply;
    if (!job) return true;

    if (job.phase === 'micro-clear') {
      if (!this.microVoxels.continueClearChunk(job.microClearCursor, maxEdits)) return false;
      job.phase = job.persistenceCursor ? 'persistence' : 'micro';
      if (performance.now() - frameWorkStartedAt >= workBudgetMs) return false;
    }

    if (job.phase === 'persistence' && job.persistenceCursor) {
      const persistenceComplete = this.editPersistence!.continueRemoteChunkReplacement(
        job.persistenceCursor,
        maxEdits,
      );
      if (!persistenceComplete) return false;
      job.microIterator = this.editPersistence!.getMicroEditsForChunk(job.cx, job.cz);
      job.standardIterator = this.editPersistence!.getStandardEditsForChunk(job.cx, job.cz);
      job.phase = 'micro';
      if (performance.now() - frameWorkStartedAt >= workBudgetMs) return false;
    }

    let processed = 0;
    if (job.phase === 'micro') {
      while (processed < maxEdits) {
        const next = this.nextPendingRemoteMicroEdit(job);
        if (next.done) {
          job.phase = 'standard';
          break;
        }
        const edit = next.value;
        this.microVoxels.set(edit.mx, edit.my, edit.mz, edit.color, edit.part);
        processed++;
        if (
          processed % REMOTE_EDIT_TIME_CHECK_INTERVAL === 0
          && performance.now() - frameWorkStartedAt >= workBudgetMs
        ) return false;
      }
      if (job.phase === 'micro') return false;
    }

    if (!job.chunkPrepared) {
      job.chunk = this.chunks.get(job.key) ?? null;
      if (job.chunk && !offThreadStreaming) {
        // Startup/tests can explicitly request immediate visibility before the
        // animation loop exists. Runtime streaming never takes this branch.
        this.terrainGen.generateChunk(job.chunk);
      }
      job.chunkPrepared = true;
      processed = 0;
    }

    while (processed < maxEdits) {
      const next = this.nextPendingRemoteStandardEdit(job);
      if (next.done) {
        job.standardComplete = true;
        break;
      }
      const edit = next.value;
      if (offThreadStreaming) {
        job.workerStandardEdits.push([
          edit.x,
          edit.y,
          edit.z,
          edit.block,
          edit.color,
        ]);
      } else if (job.chunk) {
        const lx = edit.x - job.cx * CHUNK_SIZE_X;
        const lz = edit.z - job.cz * CHUNK_SIZE_Z;
        job.chunk.setLocalBlock(lx, edit.y, lz, edit.block, edit.color);
      }
      processed++;
      if (
        processed % REMOTE_EDIT_TIME_CHECK_INTERVAL === 0
        && performance.now() - frameWorkStartedAt >= workBudgetMs
      ) return false;
    }
    if (!job.standardComplete) return false;

    this.replayPendingRemoteMicroOverrides(job.localMicroOverrides);

    if (offThreadStreaming) {
      const snapshot: PendingTerrainSnapshot = {
        key: job.key,
        cx: job.cx,
        cz: job.cz,
        revision: job.revision,
        // Local writes can race any phase of a remote replacement. Append
        // them last so the worker preserves the user's newest intent.
        standardEdits: job.workerStandardEdits.concat(job.localStandardOverrides),
      };
      this.pendingTerrainSnapshots.set(job.key, snapshot);
      if (this.activeChunkKeys.has(job.key)) this.pendingChunkEvictions.delete(job.key);
    } else if (job.chunk) {
      job.chunk.hasUserEdits = true;
      if (this.activeChunkKeys.has(job.key)) {
        job.chunk.isDirty = true;
        this.dirtyChunks.add(job.chunk);
      } else {
        if (job.chunk.mesh) this.disposeChunkMesh(job.chunk);
        this.pendingChunkEvictions.delete(job.key);
        job.chunk.isDirty = false;
      }
    } else if (this.activeChunkKeys.has(job.key) && !this.chunks.has(job.key)) {
      this.pendingStreamChunks.unshift({ cx: job.cx, cz: job.cz, distanceSq: 0 });
    }
    this.remoteChunkRevisions.set(job.key, job.revision);
    this.terrainVersion++;
    this.microMeshBuildBlockedChunks.delete(job.key);
    this.microVoxels.finalizeCollisionSnapshots(job.microClearCursor.targetMeshChunks);
    this.pendingRemoteChunkApply = null;
    return true;
  }

  private replayPendingRemoteMicroOverrides(overrides: PendingMicroOverride[]) {
    for (const override of overrides) {
      if (override.type === 'set') {
        this.microVoxels.set(
          override.mx,
          override.my,
          override.mz,
          override.color,
          override.part,
        );
      } else if (override.type === 'delete') {
        this.microVoxels.delete(override.mx, override.my, override.mz);
      } else if (override.type === 'clear-standard') {
        this.microVoxels.clearStandardCell(override.wx, override.wy, override.wz);
      } else {
        this.microVoxels.subdivide(override.wx, override.wy, override.wz, override.color);
      }
    }
  }

  private nextPendingRemoteMicroEdit(
    job: PendingRemoteChunkApplyJob,
  ): IteratorResult<PersistedMicroEdit> {
    if (job.microIterator) return job.microIterator.next();
    while (job.rawMicroIndex < job.update.micro.length) {
      const packed = job.update.micro[job.rawMicroIndex++];
      if (!Array.isArray(packed) || packed.length < 4) continue;
      const mx = Number(packed[0]);
      const my = Number(packed[1]);
      const mz = Number(packed[2]);
      const color = Number(packed[3]);
      if (![mx, my, mz, color].every(Number.isFinite)) continue;
      if (my < 0 || my >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
      return {
        done: false,
        value: {
          mx: Math.floor(wrapMicroX(mx)),
          my: Math.floor(my),
          mz: Math.floor(wrapMicroZ(mz)),
          color: color & 0xffffff,
          part: typeof packed[4] === 'string' ? packed[4].slice(0, 64) : null,
        },
      };
    }
    return { done: true, value: undefined };
  }

  private nextPendingRemoteStandardEdit(
    job: PendingRemoteChunkApplyJob,
  ): IteratorResult<PersistedStandardEdit> {
    if (job.standardIterator) return job.standardIterator.next();
    while (job.rawStandardIndex < job.update.standard.length) {
      const packed = job.update.standard[job.rawStandardIndex++];
      if (!Array.isArray(packed) || packed.length < 5) continue;
      const x = Number(packed[0]);
      const y = Number(packed[1]);
      const z = Number(packed[2]);
      const block = Number(packed[3]);
      const color = Number(packed[4]);
      if (![x, y, z, block, color].every(Number.isFinite)) continue;
      if (y < 0 || y >= CHUNK_SIZE_Y) continue;
      const value = {
        x: Math.floor(wrapX(x)),
        y: Math.floor(y),
        z: Math.floor(wrapZ(z)),
        block: Math.max(0, Math.min(255, Math.floor(block))),
        color: color & 0xffffff,
      };
      return { done: false, value };
    }
    return { done: true, value: undefined };
  }

  applyRemoteChunkUpdates(updates: TerrainEditChunk[]) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    for (const update of updates) this.applyRemoteChunkUpdate(update);
  }

  private applyRemoteChunkUpdate(update: TerrainEditChunk) {
    const cx = wrapChunkX(update.chunk_x);
    const cz = wrapChunkZ(update.chunk_z);
    const key = World.getChunkKey(cx, cz);
    const revision = Number.isFinite(Number(update.revision)) ? Number(update.revision) : 0;
    if ((this.remoteChunkRevisions.get(key) ?? -1) >= revision) return;
    this.editPersistence?.replaceRemoteChunk({
      chunk_x: cx,
      chunk_z: cz,
      revision,
      standard: update.standard,
      micro: update.micro,
    });

    this.microVoxels.clearChunk(cx, cz);

    const microEdits = this.editPersistence
      ? [...this.editPersistence.getMicroEditsForChunk(cx, cz)]
      : (Array.isArray(update.micro) ? update.micro : [])
        .filter(edit => Array.isArray(edit) && edit.length >= 4)
        .map(edit => ({ mx: edit[0], my: edit[1], mz: edit[2], color: edit[3], part: edit[4] || null }));
    for (const edit of microEdits) {
      this.microVoxels.set(edit.mx, edit.my, edit.mz, edit.color, edit.part);
    }

    const standardEdits = this.editPersistence
      ? [...this.editPersistence.getStandardEditsForChunk(cx, cz)]
      : (Array.isArray(update.standard) ? update.standard : [])
        .filter(edit => Array.isArray(edit) && edit.length >= 5)
        .map(edit => ({ x: edit[0], y: edit[1], z: edit[2], block: edit[3], color: edit[4] }));

    // If chunk is currently loaded in memory, regenerate and apply standard blocks
    const chunk = this.chunks.get(key);
    if (chunk) {
      this.terrainGen.generateChunk(chunk);
      for (const edit of standardEdits) {
        const lx = edit.x - cx * CHUNK_SIZE_X;
        const lz = edit.z - cz * CHUNK_SIZE_Z;
        chunk.setLocalBlock(lx, edit.y, lz, edit.block, edit.color);
      }
      chunk.hasUserEdits = true;
      if (this.activeChunkKeys.has(key)) {
        chunk.isDirty = true;
        this.dirtyChunks.add(chunk);
      } else {
        if (chunk.mesh) this.disposeChunkMesh(chunk);
        this.pendingChunkEvictions.delete(key);
        chunk.isDirty = false;
      }
    }
    this.remoteChunkRevisions.set(key, revision);
    this.terrainVersion++;
  }
}

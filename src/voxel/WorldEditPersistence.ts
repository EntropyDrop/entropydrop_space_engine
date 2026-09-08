import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from './Chunk.ts';
import { MICRO_DIVISIONS } from './MicroVoxelLayer.ts';
import {
  TORUS_SIZE_X,
  TORUS_SIZE_Z,
  wrapMicroX,
  wrapMicroZ,
  wrapX,
  wrapZ,
} from '../torus/TorusWorld.ts';
import type { SpaceStorage } from '../storage/SpaceStorage.ts';

const STORAGE_SCHEMA_VERSION = 3;
const STORAGE_PREFIX = 'space.world-edits.v3';
const DEFAULT_SAVE_DELAY_MS = 75;
// A subdivision spans several batches. Drain its queued suffix after each ACK;
// the initial save delay still coalesces clicks, and failures retain retry backoff.
const DEFAULT_REMOTE_BATCH_DELAY_MS = 0;
const REMOTE_RETRY_DELAY_MS = 2_000;
const MAX_TRANSIENT_REMOTE_RETRY_DELAY_MS = 30_000;
const MAX_SERVER_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const MAX_MUTATIONS_PER_BATCH = 256;
const MAX_CHUNKS_PER_BATCH = 16;
const MAX_ZONES_PER_BATCH = 4;
const SURFACE_ZONE_SIZE_CHUNKS = 32;
const OUTBOX_HIGH_WATER_MUTATIONS = 4_096;
const OUTBOX_LOW_WATER_MUTATIONS = 2_048;
const MAX_STORED_STANDARD_EDITS = 250_000;
const MAX_STORED_MICRO_EDITS = 500_000;

export interface WorldEditStorage extends SpaceStorage {}

export type TerrainMutation =
  | { kind: 'set_standard'; x: number; y: number; z: number; block: number; color: number }
  | { kind: 'set_micro'; mx: number; my: number; mz: number; color: number; part?: string | null }
  | { kind: 'remove_micro'; mx: number; my: number; mz: number }
  | { kind: 'clear_micro_cell'; x: number; y: number; z: number };

export interface TerrainEditChunk {
  chunk_x: number;
  chunk_z: number;
  revision: number;
  standard: unknown[];
  micro: unknown[];
}

export interface WorldEditRemote {
  chunks: TerrainEditChunk[];
  loadArea?(
    centerChunkX: number,
    centerChunkZ: number,
    radiusChunks: number,
    onPage?: (chunks: TerrainEditChunk[]) => void
  ): Promise<TerrainEditChunk[]>;
  sendBatch(
    batchId: string,
    mutations: TerrainMutation[],
    metadata?: { dedupeEpoch: number; createdAtMs: number | null }
  ): Promise<unknown>;
}

export interface WorldEditSyncStatus {
  pendingBatches: number;
  pendingMutations: number;
  sending: boolean;
  retrying: boolean;
  retryDelayMs: number;
  acknowledgedBatches: number;
  acknowledgedMutations: number;
  backpressured: boolean;
  quota: TerrainEditQuota | null;
  blockedCode: string | null;
}

export interface TerrainEditQuota {
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
  resetAt: string;
}

export interface WorldEditPersistenceOptions {
  worldId: string;
  storage?: WorldEditStorage | null;
  saveDelayMs?: number;
  remoteBatchDelayMs?: number;
  remote?: WorldEditRemote | null;
  onSyncStatus?: (status: WorldEditSyncStatus) => void;
  onResyncRequired?: () => void;
}

export interface PersistedStandardEdit {
  x: number;
  y: number;
  z: number;
  block: number;
  color: number;
}

export interface PersistedMicroEdit {
  mx: number;
  my: number;
  mz: number;
  color: number;
  part: string | null;
}

interface RemoteChunkPendingBatch {
  batchId: string;
  mutations: TerrainMutation[];
  state: 'pending' | 'preserve' | 'resolved';
}

export interface RemoteChunkReplacementCursor {
  chunkKey: string;
  revision: number | null;
  previousStandardIterator: Iterator<[string, PersistedStandardEdit]> | null;
  previousMicroIterator: Iterator<[string, PersistedMicroEdit]> | null;
  standard: unknown[];
  micro: unknown[];
  standardIndex: number;
  microIndex: number;
  standardLimit: number;
  microLimit: number;
  previousStandard: Map<string, PersistedStandardEdit> | null;
  previousMicro: Map<string, PersistedMicroEdit> | null;
  comparisonStarted: boolean;
  comparisonStandardIterator: Iterator<[string, PersistedStandardEdit]> | null;
  comparisonMicroIterator: Iterator<[string, PersistedMicroEdit]> | null;
  baselineReady: boolean;
  baselineMutations: TerrainMutation[];
  baselineMutationIndex: number;
  localMutations: TerrainMutation[];
  localMutationIndex: number;
  pendingReplayed: boolean;
  pendingBatches: RemoteChunkPendingBatch[];
  acknowledgementVersion: number;
  replayedAcknowledgementVersion: number;
  /** Reliable only once complete: the replacement preserves the previous overlay. */
  unchanged: boolean;
  complete: boolean;
}

interface PersistedMutationBatch {
  batchId: string;
  mutations: TerrainMutation[];
  dedupeEpoch: number;
  createdAtMs: number | null;
}

function standardKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

function microKey(mx: number, my: number, mz: number) {
  return `${mx},${my},${mz}`;
}

function chunkKeyForWorldCell(x: number, z: number) {
  return `${Math.floor(x / CHUNK_SIZE_X)},${Math.floor(z / CHUNK_SIZE_Z)}`;
}

function chunkKeyForMicroCell(mx: number, mz: number) {
  return `${Math.floor(mx / (CHUNK_SIZE_X * MICRO_DIVISIONS))},${Math.floor(mz / (CHUNK_SIZE_Z * MICRO_DIVISIONS))}`;
}

function chunkKeyForMutation(mutation: TerrainMutation) {
  if (mutation.kind === 'set_micro' || mutation.kind === 'remove_micro') {
    return chunkKeyForMicroCell(mutation.mx, mutation.mz);
  }
  return chunkKeyForWorldCell(mutation.x, mutation.z);
}

function zoneKeyForChunkKey(chunkKey: string) {
  const [chunkX, chunkZ] = chunkKey.split(',').map(Number);
  return `${Math.floor(chunkX / SURFACE_ZONE_SIZE_CHUNKS)},${Math.floor(chunkZ / SURFACE_ZONE_SIZE_CHUNKS)}`;
}

interface BatchFootprint {
  indexedMutations: number;
  chunkKeys: Set<string>;
  zoneKeys: Set<string>;
}

// Keep derived bookkeeping outside the durable/wire payload. Mutation arrays
// are append-only while collecting; a server size split creates fresh arrays.
const batchFootprints = new WeakMap<TerrainMutation[], BatchFootprint>();

function batchAcceptsMutation(batch: PersistedMutationBatch, mutation: TerrainMutation) {
  let footprint = batchFootprints.get(batch.mutations);
  if (!footprint || footprint.indexedMutations > batch.mutations.length) {
    footprint = { indexedMutations: 0, chunkKeys: new Set(), zoneKeys: new Set() };
    batchFootprints.set(batch.mutations, footprint);
  }
  // Index each appended operation once instead of rescanning up to 256 prior
  // operations for every one of a spoon subdivision's 512 microcells.
  while (footprint.indexedMutations < batch.mutations.length) {
    const chunkKey = chunkKeyForMutation(batch.mutations[footprint.indexedMutations++]);
    if (footprint.chunkKeys.has(chunkKey)) continue;
    footprint.chunkKeys.add(chunkKey);
    footprint.zoneKeys.add(zoneKeyForChunkKey(chunkKey));
  }
  const chunkKey = chunkKeyForMutation(mutation);
  if (footprint.chunkKeys.has(chunkKey)) return true;
  if (footprint.chunkKeys.size >= MAX_CHUNKS_PER_BATCH) return false;
  return footprint.zoneKeys.has(zoneKeyForChunkKey(chunkKey))
    || footprint.zoneKeys.size < MAX_ZONES_PER_BATCH;
}

function acknowledgedChunkRevision(result: unknown, chunkKey: string): number | null {
  const chunks = (result as { chunks?: unknown })?.chunks;
  if (!Array.isArray(chunks)) return null;
  let revision: number | null = null;
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk?.chunk_x) || !Number.isSafeInteger(chunk?.chunk_z)
      || `${chunk.chunk_x},${chunk.chunk_z}` !== chunkKey) continue;
    if (!Number.isSafeInteger(chunk.revision) || chunk.revision < 0) return null;
    if (revision !== null && revision !== chunk.revision) return null;
    revision = chunk.revision;
  }
  return revision;
}

function parseTerrainEditQuota(value: unknown): TerrainEditQuota | null {
  const quota = value as any;
  const dailyLimit = finiteInteger(quota?.daily_limit);
  const usedToday = finiteInteger(quota?.used_today);
  const remainingToday = finiteInteger(quota?.remaining_today);
  if (dailyLimit === null || usedToday === null || remainingToday === null) return null;
  return {
    dailyLimit,
    usedToday,
    remainingToday,
    resetAt: typeof quota?.reset_at === 'string' ? quota.reset_at : '',
  };
}

function finiteInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function resolveDefaultStorage(): WorldEditStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function createBatchId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, marker => {
    const random = Math.floor(Math.random() * 16);
    const value = marker === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function worldEditStorageKey(worldId: string) {
  return `${STORAGE_PREFIX}.${encodeURIComponent(worldId)}`;
}

/**
 * Sparse local cache plus durable remote outbox for player-authored terrain.
 *
 * Standard AIR entries are tombstones over deterministic generated terrain.
 * Remote mutations are grouped into stable, idempotent batches of at most 256
 * operations, 16 chunks and 4 surface zones; a batch is committed to browser
 * storage before transmission and removed only after the server acknowledges it.
 */
export class WorldEditPersistence {
  readonly worldId: string;
  readonly storageKey: string;
  private readonly storage: WorldEditStorage | null;
  private readonly saveDelayMs: number;
  private readonly remoteBatchDelayMs: number;
  private readonly remote: WorldEditRemote | null;
  private readonly onSyncStatus: ((status: WorldEditSyncStatus) => void) | null;
  private readonly onResyncRequired: (() => void) | null;
  private readonly standardEdits = new Map<string, PersistedStandardEdit>();
  private readonly standardEditsByChunk = new Map<string, Map<string, PersistedStandardEdit>>();
  private readonly microEdits = new Map<string, PersistedMicroEdit>();
  private readonly microEditsByChunk = new Map<string, Map<string, PersistedMicroEdit>>();
  private readonly activeRemoteReplacements = new Map<string, RemoteChunkReplacementCursor>();
  private readonly pendingBatches: PersistedMutationBatch[] = [];
  /** A transmitted (or reload-restored) batch id must never gain new mutations. */
  private readonly sealedBatchIds = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private sendingBatchId: string | null = null;
  private remoteFailureCount = 0;
  private currentRetryDelayMs = 0;
  private acknowledgedBatches = 0;
  private acknowledgedMutations = 0;
  private backpressured = false;
  private quota: TerrainEditQuota | null = null;
  private blockedCode: string | null = null;
  private lastSyncStatusKey = '';
  private dirty = false;

  constructor(options: WorldEditPersistenceOptions) {
    this.worldId = String(options.worldId || '').trim();
    this.storageKey = worldEditStorageKey(this.worldId);
    this.storage = options.storage === undefined ? resolveDefaultStorage() : options.storage;
    this.remote = options.remote ?? null;
    this.onSyncStatus = options.onSyncStatus ?? null;
    this.onResyncRequired = options.onResyncRequired ?? null;
    const configuredSaveDelay = Number(options.saveDelayMs);
    this.saveDelayMs = Number.isFinite(configuredSaveDelay)
      ? Math.max(0, configuredSaveDelay)
      : DEFAULT_SAVE_DELAY_MS;
    const configuredRemoteBatchDelay = Number(options.remoteBatchDelayMs);
    this.remoteBatchDelayMs = Number.isFinite(configuredRemoteBatchDelay)
      ? Math.max(0, configuredRemoteBatchDelay)
      : DEFAULT_REMOTE_BATCH_DELAY_MS;

    if (this.remote) this.loadRemoteChunks(this.remote.chunks);
    this.loadLocalState();
    this.reconcileStandardMicroExclusion();
    this.installLifecycleFlush();

    if (this.remote) {
      this.dirty = true;
      this.refreshBackpressure();
      this.scheduleSave();
      this.scheduleRemoteFlush();
      this.notifySyncStatus(true);
    }
  }

  getSyncStatus(): WorldEditSyncStatus {
    return {
      pendingBatches: this.pendingBatches.length,
      pendingMutations: this.pendingMutationCount(),
      sending: this.sendingBatchId !== null,
      retrying: this.remoteFailureCount > 0 && this.remoteRetryTimer !== null,
      retryDelayMs: this.currentRetryDelayMs,
      acknowledgedBatches: this.acknowledgedBatches,
      acknowledgedMutations: this.acknowledgedMutations,
      backpressured: this.backpressured,
      quota: this.quota,
      blockedCode: this.blockedCode,
    };
  }

  getStandardEditsForChunk(cx: number, cz: number) {
    return this.standardEditsByChunk.get(`${cx},${cz}`)?.values() ?? [][Symbol.iterator]();
  }

  getMicroEdits() {
    return this.microEdits.values();
  }

  getMicroEditsForChunk(cx: number, cz: number) {
    return this.microEditsByChunk.get(`${cx},${cz}`)?.values() ?? [][Symbol.iterator]();
  }

  /** Replace one server-authored chunk snapshot without creating an outgoing echo batch. */
  replaceRemoteChunk(chunk: TerrainEditChunk) {
    const cursor = this.beginRemoteChunkReplacement(chunk);
    this.continueRemoteChunkReplacement(cursor);
  }

  /** Begin a replace operation that callers may install over several frames. */
  beginRemoteChunkReplacement(chunk: TerrainEditChunk): RemoteChunkReplacementCursor {
    const chunkCountX = TORUS_SIZE_X / CHUNK_SIZE_X;
    const chunkCountZ = TORUS_SIZE_Z / CHUNK_SIZE_Z;
    const cx = ((Math.floor(chunk.chunk_x) % chunkCountX) + chunkCountX) % chunkCountX;
    const cz = ((Math.floor(chunk.chunk_z) % chunkCountZ) + chunkCountZ) % chunkCountZ;
    const chunkKey = `${cx},${cz}`;
    const previousStandard = this.standardEditsByChunk.get(chunkKey);
    const previousMicro = this.microEditsByChunk.get(chunkKey);
    // Detach the per-chunk indexes immediately, but clear their global entries
    // incrementally in continueRemoteChunkReplacement. This avoids a 100k-cell
    // snapshot replacement becoming one long main-thread task.
    this.standardEditsByChunk.delete(chunkKey);
    this.microEditsByChunk.delete(chunkKey);

    const standard = Array.isArray(chunk.standard) ? chunk.standard : [];
    const micro = Array.isArray(chunk.micro) ? chunk.micro : [];
    const cursor: RemoteChunkReplacementCursor = {
      chunkKey,
      revision: Number.isSafeInteger(chunk.revision) && chunk.revision >= 0 ? chunk.revision : null,
      previousStandardIterator: previousStandard?.entries() ?? null,
      previousMicroIterator: previousMicro?.entries() ?? null,
      standard,
      micro,
      standardIndex: 0,
      microIndex: 0,
      standardLimit: Math.min(standard.length, MAX_STORED_STANDARD_EDITS),
      microLimit: Math.min(micro.length, MAX_STORED_MICRO_EDITS),
      previousStandard: previousStandard ?? null,
      previousMicro: previousMicro ?? null,
      comparisonStarted: false,
      comparisonStandardIterator: null,
      comparisonMicroIterator: null,
      baselineReady: false,
      baselineMutations: [],
      baselineMutationIndex: 0,
      localMutations: [],
      localMutationIndex: 0,
      pendingReplayed: false,
      pendingBatches: this.pendingBatches.flatMap(batch => {
        const mutations = batch.mutations.filter(mutation => chunkKeyForMutation(mutation) === chunkKey);
        return mutations.length > 0 ? [{ batchId: batch.batchId, mutations, state: 'pending' as const }] : [];
      }),
      acknowledgementVersion: 0,
      replayedAcknowledgementVersion: -1,
      unchanged: false,
      complete: false,
    };
    this.activeRemoteReplacements.set(chunkKey, cursor);
    return cursor;
  }

  /** Continue a bounded remote replacement; returns true once it is complete. */
  continueRemoteChunkReplacement(
    cursor: RemoteChunkReplacementCursor,
    maxPackedEdits = Number.POSITIVE_INFINITY,
  ): boolean {
    if (cursor.complete) return true;
    if (cursor.pendingReplayed
      && cursor.replayedAcknowledgementVersion !== cursor.acknowledgementVersion) {
      // ACKs establish whether the fetched snapshot predates a local commit.
      // Reinstall using the resolved per-chunk order, retaining newer commits.
      this.restartRemoteChunkTarget(cursor);
    }
    let remaining = Number.isFinite(maxPackedEdits)
      ? Math.max(1, Math.floor(maxPackedEdits))
      : Number.POSITIVE_INFINITY;

    while (cursor.previousStandardIterator && remaining > 0) {
      const next = cursor.previousStandardIterator.next();
      if (next.done) {
        cursor.previousStandardIterator = null;
        break;
      }
      const [key, previous] = next.value;
      if (this.standardEdits.get(key) === previous) this.standardEdits.delete(key);
      remaining--;
    }
    while (!cursor.previousStandardIterator && cursor.previousMicroIterator && remaining > 0) {
      const next = cursor.previousMicroIterator.next();
      if (next.done) {
        cursor.previousMicroIterator = null;
        break;
      }
      const [key, previous] = next.value;
      if (this.microEdits.get(key) === previous) this.microEdits.delete(key);
      remaining--;
    }

    if (cursor.previousStandardIterator || cursor.previousMicroIterator) return false;

    // The old maps also drive global-cache cleanup. Do not mutate their keys
    // until those iterators finish, or a local deletion could skip stale keys.
    while (!cursor.baselineReady && cursor.baselineMutationIndex < cursor.baselineMutations.length
      && remaining > 0) {
      this.applyMutationToReplacementBaseline(cursor, cursor.baselineMutations[cursor.baselineMutationIndex++]);
      remaining--;
    }
    if (cursor.baselineMutationIndex < cursor.baselineMutations.length) return false;
    cursor.baselineReady = true;

    while (cursor.standardIndex < cursor.standardLimit && remaining > 0) {
      this.loadPackedStandardEdit(cursor.standard[cursor.standardIndex++]);
      remaining--;
    }
    while (cursor.standardIndex >= cursor.standardLimit
      && cursor.microIndex < cursor.microLimit
      && remaining > 0) {
      this.loadPackedMicroEdit(cursor.micro[cursor.microIndex++]);
      remaining--;
    }
    if (cursor.standardIndex < cursor.standardLimit || cursor.microIndex < cursor.microLimit) {
      return false;
    }

    if (!cursor.pendingReplayed) {
      // Replay the captured outbox in its original order, keeping acknowledged
      // writes only when their chunk revision is newer than this snapshot.
      // Clicks made after the snapshot was fetched are always replayed last.
      this.replayPendingBatchesForReplacement(cursor);
      cursor.pendingReplayed = true;
      cursor.replayedAcknowledgementVersion = cursor.acknowledgementVersion;
    }
    while (cursor.localMutationIndex < cursor.localMutations.length && remaining > 0) {
      this.applyMutationLocally(cursor.localMutations[cursor.localMutationIndex++]);
      remaining--;
    }
    if (cursor.localMutationIndex < cursor.localMutations.length) return false;
    if (!cursor.comparisonStarted) {
      this.reconcileStandardMicroExclusionForChunk(cursor.chunkKey);
      cursor.comparisonStarted = true;
      cursor.comparisonStandardIterator = cursor.previousStandard?.entries() ?? null;
      cursor.comparisonMicroIterator = cursor.previousMicro?.entries() ?? null;
    }
    return this.continueRemoteChunkComparison(cursor, remaining);
  }

  private restartRemoteChunkTarget(cursor: RemoteChunkReplacementCursor) {
    cursor.previousStandardIterator = this.standardEditsByChunk.get(cursor.chunkKey)?.entries() ?? null;
    cursor.previousMicroIterator = this.microEditsByChunk.get(cursor.chunkKey)?.entries() ?? null;
    this.standardEditsByChunk.delete(cursor.chunkKey);
    this.microEditsByChunk.delete(cursor.chunkKey);
    cursor.standardIndex = cursor.microIndex = cursor.localMutationIndex = 0;
    cursor.pendingReplayed = cursor.comparisonStarted = false;
    cursor.comparisonStandardIterator = cursor.comparisonMicroIterator = null;
  }

  private finishRemoteChunkReplacement(cursor: RemoteChunkReplacementCursor, unchanged = false) {
    cursor.unchanged = unchanged;
    cursor.complete = true;
    if (this.activeRemoteReplacements.get(cursor.chunkKey) === cursor) {
      this.activeRemoteReplacements.delete(cursor.chunkKey);
    }
    return true;
  }

  private continueRemoteChunkComparison(cursor: RemoteChunkReplacementCursor, remaining: number) {
    const standard = this.standardEditsByChunk.get(cursor.chunkKey);
    const micro = this.microEditsByChunk.get(cursor.chunkKey);
    if (
      cursor.acknowledgementVersion > 0
      || this.activeRemoteReplacements.get(cursor.chunkKey) !== cursor
      || (cursor.previousStandard?.size ?? 0) !== (standard?.size ?? 0)
      || (cursor.previousMicro?.size ?? 0) !== (micro?.size ?? 0)
    ) {
      // A pre-existing outbox entry crossing an ACK boundary may have hidden a
      // later remote write. Keep the authoritative replacement in that case.
      return this.finishRemoteChunkReplacement(cursor);
    }
    while (cursor.comparisonStandardIterator && remaining > 0) {
      const next = cursor.comparisonStandardIterator.next();
      if (next.done) {
        cursor.comparisonStandardIterator = null;
        break;
      }
      const [key, previous] = next.value;
      const current = standard?.get(key);
      if (!current || current.block !== previous.block || current.color !== previous.color) {
        return this.finishRemoteChunkReplacement(cursor);
      }
      remaining--;
    }
    while (!cursor.comparisonStandardIterator && cursor.comparisonMicroIterator && remaining > 0) {
      const next = cursor.comparisonMicroIterator.next();
      if (next.done) {
        cursor.comparisonMicroIterator = null;
        break;
      }
      const [key, previous] = next.value;
      const current = micro?.get(key);
      if (!current || current.color !== previous.color || current.part !== previous.part) {
        return this.finishRemoteChunkReplacement(cursor);
      }
      remaining--;
    }
    if (cursor.comparisonStandardIterator || cursor.comparisonMicroIterator) return false;
    return this.finishRemoteChunkReplacement(cursor, true);
  }

  private applyMutationToReplacementBaseline(cursor: RemoteChunkReplacementCursor, mutation: TerrainMutation) {
    if (mutation.kind === 'set_micro') {
      const edit = this.normalizeMicroEdit(mutation.mx, mutation.my, mutation.mz, mutation.color, mutation.part);
      if (edit) (cursor.previousMicro ??= new Map()).set(microKey(edit.mx, edit.my, edit.mz), edit);
      return;
    }
    if (mutation.kind === 'remove_micro') {
      cursor.previousMicro?.delete(microKey(mutation.mx, mutation.my, mutation.mz));
      return;
    }
    if (mutation.kind === 'set_standard') {
      const edit = this.normalizeStandardEdit(mutation.x, mutation.y, mutation.z, mutation.block, mutation.color);
      if (!edit) return;
      (cursor.previousStandard ??= new Map()).set(standardKey(edit.x, edit.y, edit.z), edit);
      if (edit.block === 0) return;
    }
    const baseX = mutation.x * MICRO_DIVISIONS;
    const baseY = mutation.y * MICRO_DIVISIONS;
    const baseZ = mutation.z * MICRO_DIVISIONS;
    for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
      for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
        for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
          cursor.previousMicro?.delete(microKey(baseX + dx, baseY + dy, baseZ + dz));
        }
      }
    }
  }

  private noteRemoteBatchResolution(batchId: string, result?: unknown) {
    for (const cursor of this.activeRemoteReplacements.values()) {
      const batch = cursor.pendingBatches.find(batch => batch.batchId === batchId);
      if (!batch) continue;
      // A snapshot older than the ACK cannot contain that committed mutation.
      // Dropping its overlay would restore a microcell the server just deleted.
      // Equal/newer snapshots may contain a later player's write and win instead.
      const revision = acknowledgedChunkRevision(result, cursor.chunkKey);
      batch.state = revision !== null && cursor.revision !== null && revision > cursor.revision
        ? 'preserve'
        : 'resolved';
      cursor.acknowledgementVersion++;
    }
  }

  recordStandard(x: number, y: number, z: number, block: number, color: number) {
    const edit = this.normalizeStandardEdit(x, y, z, block, color);
    if (!edit) return;
    this.addStandardEdit(edit);
    if (edit.block !== 0) this.removeMicroStandardCell(edit.x, edit.y, edit.z, false);
    this.enqueueMutation({
      kind: 'set_standard',
      x: edit.x,
      y: edit.y,
      z: edit.z,
      block: edit.block,
      color: edit.color,
    });
  }

  recordMicro(mx: number, my: number, mz: number, color: number, part: unknown = null) {
    const edit = this.normalizeMicroEdit(mx, my, mz, color, part);
    if (!edit) return;
    this.addMicroEdit(edit);
    this.enqueueMutation({
      kind: 'set_micro',
      mx: edit.mx,
      my: edit.my,
      mz: edit.mz,
      color: edit.color,
      ...(edit.part ? { part: edit.part } : {}),
    });
  }

  removeMicro(mx: number, my: number, mz: number, enqueueIfMissing = false) {
    const normalizedX = Math.floor(wrapMicroX(mx));
    const normalizedY = Math.floor(my);
    const normalizedZ = Math.floor(wrapMicroZ(mz));
    const removed = this.deleteMicroEdit(normalizedX, normalizedY, normalizedZ);
    if (removed || enqueueIfMissing) {
      this.enqueueMutation({ kind: 'remove_micro', mx: normalizedX, my: normalizedY, mz: normalizedZ });
    }
    return removed;
  }

  removeMicroStandardCell(
    wx: number,
    wy: number,
    wz: number,
    enqueue = true,
    enqueueIfEmpty = false,
  ) {
    const normalizedX = Math.floor(wrapX(wx));
    const normalizedY = Math.floor(wy);
    const normalizedZ = Math.floor(wrapZ(wz));
    const removed = this.removeMicroStandardCellLocal(normalizedX, normalizedY, normalizedZ);
    if ((removed > 0 || enqueueIfEmpty) && enqueue) {
      this.enqueueMutation({
        kind: 'clear_micro_cell',
        x: normalizedX,
        y: normalizedY,
        z: normalizedZ,
      });
    }
    return removed;
  }

  flush() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.storage || !this.worldId) return false;

    try {
      // The server is authoritative in remote mode. Persist only the durable
      // outbox: acknowledged world snapshots are fetched by AOI and must not be
      // copied into every player's IndexedDB or synchronously JSON-stringified
      // after every local edit.
      const hasLocalOverlay = !this.remote && (
        this.standardEdits.size > 0 || this.microEdits.size > 0
      );
      if (!hasLocalOverlay && this.pendingBatches.length === 0) {
        this.storage.removeItem(this.storageKey);
      } else {
        const payload = {
          version: STORAGE_SCHEMA_VERSION,
          worldId: this.worldId,
          ...(!this.remote ? {
            standard: [...this.standardEdits.values()].map(edit => (
              [edit.x, edit.y, edit.z, edit.block, edit.color]
            )),
            micro: [...this.microEdits.values()].map(edit => (
              edit.part
                ? [edit.mx, edit.my, edit.mz, edit.color, edit.part]
                : [edit.mx, edit.my, edit.mz, edit.color]
            )),
          } : {}),
          pendingBatches: this.pendingBatches,
          savedAt: Date.now(),
        };
        this.storage.setItem(this.storageKey, JSON.stringify(payload));
      }
      this.dirty = false;
      return true;
    } catch (error) {
      console.warn('Space could not persist world edits in browser storage.', error);
      return false;
    }
  }

  private normalizeStandardEdit(x: number, y: number, z: number, block: number, color: number) {
    if (![x, y, z, block, color].every(value => Number.isFinite(Number(value)))) return null;
    const normalizedX = Math.floor(wrapX(x));
    const normalizedY = Math.floor(y);
    const normalizedZ = Math.floor(wrapZ(z));
    if (normalizedY < 0 || normalizedY >= CHUNK_SIZE_Y) return null;
    return {
      x: normalizedX,
      y: normalizedY,
      z: normalizedZ,
      block: Math.max(0, Math.min(255, Math.floor(Number(block) || 0))),
      color: Number(color) & 0xffffff,
    };
  }

  private normalizeMicroEdit(mx: number, my: number, mz: number, color: number, part: unknown = null) {
    if (![mx, my, mz, color].every(value => Number.isFinite(Number(value)))) return null;
    const normalizedX = Math.floor(wrapMicroX(mx));
    const normalizedY = Math.floor(my);
    const normalizedZ = Math.floor(wrapMicroZ(mz));
    if (normalizedY < 0 || normalizedY >= CHUNK_SIZE_Y * MICRO_DIVISIONS) return null;
    return {
      mx: normalizedX,
      my: normalizedY,
      mz: normalizedZ,
      color: Number(color) & 0xffffff,
      part: typeof part === 'string' ? part.slice(0, 64) : null,
    };
  }

  private addStandardEdit(edit: PersistedStandardEdit) {
    const key = standardKey(edit.x, edit.y, edit.z);
    this.standardEdits.set(key, edit);
    const chunkKey = chunkKeyForWorldCell(edit.x, edit.z);
    let chunkEdits = this.standardEditsByChunk.get(chunkKey);
    if (!chunkEdits) {
      chunkEdits = new Map();
      this.standardEditsByChunk.set(chunkKey, chunkEdits);
    }
    chunkEdits.set(key, edit);
  }

  private addMicroEdit(edit: PersistedMicroEdit) {
    const key = microKey(edit.mx, edit.my, edit.mz);
    this.microEdits.set(key, edit);
    const chunkKey = chunkKeyForMicroCell(edit.mx, edit.mz);
    let chunkEdits = this.microEditsByChunk.get(chunkKey);
    if (!chunkEdits) {
      chunkEdits = new Map();
      this.microEditsByChunk.set(chunkKey, chunkEdits);
    }
    chunkEdits.set(key, edit);
  }

  private deleteMicroEdit(mx: number, my: number, mz: number) {
    const key = microKey(mx, my, mz);
    const removed = this.microEdits.delete(key);
    if (!removed) return false;
    const chunkKey = chunkKeyForMicroCell(mx, mz);
    const chunkEdits = this.microEditsByChunk.get(chunkKey);
    chunkEdits?.delete(key);
    if (chunkEdits?.size === 0) this.microEditsByChunk.delete(chunkKey);
    return true;
  }

  private removeMicroStandardCellLocal(wx: number, wy: number, wz: number) {
    const baseX = wx * MICRO_DIVISIONS;
    const baseY = wy * MICRO_DIVISIONS;
    const baseZ = wz * MICRO_DIVISIONS;
    let removed = 0;
    for (let dx = 0; dx < MICRO_DIVISIONS; dx++) {
      for (let dy = 0; dy < MICRO_DIVISIONS; dy++) {
        for (let dz = 0; dz < MICRO_DIVISIONS; dz++) {
          if (this.deleteMicroEdit(baseX + dx, baseY + dy, baseZ + dz)) removed++;
        }
      }
    }
    return removed;
  }

  private reconcileStandardMicroExclusion() {
    for (const edit of this.standardEdits.values()) {
      if (edit.block !== 0) this.removeMicroStandardCellLocal(edit.x, edit.y, edit.z);
    }
  }

  private reconcileStandardMicroExclusionForChunk(chunkKey: string) {
    for (const edit of this.standardEditsByChunk.get(chunkKey)?.values() ?? []) {
      if (edit.block !== 0) this.removeMicroStandardCellLocal(edit.x, edit.y, edit.z);
    }
  }

  private enqueueMutation(mutation: TerrainMutation) {
    const cursor = this.activeRemoteReplacements.get(chunkKeyForMutation(mutation));
    if (cursor) {
      if (cursor.baselineReady) this.applyMutationToReplacementBaseline(cursor, mutation);
      else cursor.baselineMutations.push(mutation);
      // Even during comparison retain the journal for a possible ACK-driven
      // authoritative reinstall, but do not replay over newer live writes now.
      cursor.localMutations.push(mutation);
      if (cursor.comparisonStarted) cursor.localMutationIndex = cursor.localMutations.length;
    }
    if (this.remote) {
      let batch = this.pendingBatches[this.pendingBatches.length - 1];
      if (
        !batch
        || batch.mutations.length >= MAX_MUTATIONS_PER_BATCH
        || this.sealedBatchIds.has(batch.batchId)
        || !batchAcceptsMutation(batch, mutation)
      ) {
        batch = {
          batchId: createBatchId(),
          mutations: [],
          dedupeEpoch: 1,
          createdAtMs: Date.now(),
        };
        this.pendingBatches.push(batch);
      }
      batch.mutations.push(mutation);
      this.refreshBackpressure();
      this.scheduleSyncStatusPublish();
      this.scheduleRemoteFlush();
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    this.dirty = true;
    if (!this.storage || !this.worldId || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
  }

  private scheduleRemoteFlush(delay = this.saveDelayMs) {
    if (!this.remote || this.sendingBatchId || this.pendingBatches.length === 0) return;
    if (this.remoteRetryTimer !== null) return;
    this.remoteRetryTimer = setTimeout(() => {
      this.remoteRetryTimer = null;
      void this.flushNextRemoteBatch();
    }, delay);
  }

  private async flushNextRemoteBatch() {
    if (!this.remote || this.sendingBatchId || this.pendingBatches.length === 0) return;
    const batch = this.pendingBatches[0];
    this.sealedBatchIds.add(batch.batchId);
    // Reserve the batch while its IndexedDB transaction commits so another
    // zero-delay mutation timer cannot start a concurrent send of the same id.
    this.sendingBatchId = batch.batchId;
    this.currentRetryDelayMs = 0;
    this.notifySyncStatus();
    this.flush();
    try {
      await this.storage?.whenIdle?.();
    } catch (error) {
      // Never transmit an outbox batch that did not become durable. Keep its
      // stable id sealed and retry the same persistence operation later.
      this.dirty = true;
      this.sendingBatchId = null;
      console.warn('Space terrain batch is waiting for durable browser storage.', error);
      this.remoteFailureCount++;
      const delay = this.resolveRetryDelay(error);
      this.currentRetryDelayMs = delay;
      this.scheduleRemoteFlush(delay);
      this.notifySyncStatus();
      return;
    }
    try {
      const result = await this.remote.sendBatch(batch.batchId, batch.mutations, {
        dedupeEpoch: batch.dedupeEpoch,
        createdAtMs: batch.createdAtMs,
      });
      const quota = parseTerrainEditQuota((result as any)?.quota);
      if (quota) this.quota = quota;
      this.blockedCode = null;
      this.noteRemoteBatchResolution(batch.batchId, result);
      const index = this.pendingBatches.findIndex(item => item.batchId === batch.batchId);
      if (index >= 0) this.pendingBatches.splice(index, 1);
      this.sealedBatchIds.delete(batch.batchId);
      this.dirty = true;
      this.flush();
      this.sendingBatchId = null;
      this.remoteFailureCount = 0;
      this.currentRetryDelayMs = 0;
      this.acknowledgedBatches++;
      this.acknowledgedMutations += batch.mutations.length;
      this.refreshBackpressure();
      this.scheduleRemoteFlush(this.remoteBatchDelayMs);
      this.notifySyncStatus();
    } catch (error) {
      this.sendingBatchId = null;
      this.blockedCode = typeof (error as any)?.code === 'string' ? (error as any).code : null;
      if (
        (
          this.blockedCode === 'TERRAIN_BATCH_TOO_MANY_CHUNKS'
          || this.blockedCode === 'TERRAIN_BATCH_TOO_MANY_ZONES'
          || this.blockedCode === 'TERRAIN_EVENT_TOO_LARGE'
        )
        && this.splitRejectedBatch(batch)
      ) {
        this.remoteFailureCount = 0;
        this.currentRetryDelayMs = 0;
        this.dirty = true;
        this.flush();
        this.refreshBackpressure();
        this.scheduleRemoteFlush();
        this.notifySyncStatus();
        return;
      }
      if (
        this.blockedCode === 'TERRAIN_BATCH_TOO_MANY_CHUNKS'
        || this.blockedCode === 'TERRAIN_BATCH_TOO_MANY_ZONES'
        || this.blockedCode === 'TERRAIN_EVENT_TOO_LARGE'
      ) {
        (error as any).permanent = true;
      }
      if ((error as any)?.permanent === true) {
        this.noteRemoteBatchResolution(batch.batchId);
        const index = this.pendingBatches.findIndex(item => item.batchId === batch.batchId);
        if (index >= 0) this.pendingBatches.splice(index, 1);
        this.sealedBatchIds.delete(batch.batchId);
        this.remoteFailureCount = 0;
        this.currentRetryDelayMs = 0;
        this.dirty = true;
        this.flush();
        this.refreshBackpressure();
        this.notifySyncStatus();
        this.onResyncRequired?.();
        return;
      }
      console.warn('Space terrain batch remains queued for retry.', error);
      this.remoteFailureCount++;
      const delay = this.resolveRetryDelay(error);
      this.currentRetryDelayMs = delay;
      this.scheduleRemoteFlush(delay);
      this.notifySyncStatus();
    }
  }

  private pendingMutationCount() {
    let count = 0;
    for (const batch of this.pendingBatches) count += batch.mutations.length;
    return count;
  }

  private splitRejectedBatch(batch: PersistedMutationBatch) {
    if (batch.mutations.length <= 1) return false;
    const index = this.pendingBatches.findIndex(item => item.batchId === batch.batchId);
    if (index < 0) return false;
    const midpoint = Math.ceil(batch.mutations.length / 2);
    const first = { ...batch, mutations: batch.mutations.slice(0, midpoint) };
    const second = {
      batchId: createBatchId(),
      mutations: batch.mutations.slice(midpoint),
      dedupeEpoch: 1,
      createdAtMs: Date.now(),
    };
    this.pendingBatches.splice(index, 1, first, second);
    for (const cursor of this.activeRemoteReplacements.values()) {
      const capturedIndex = cursor.pendingBatches.findIndex(captured => captured.batchId === batch.batchId);
      if (capturedIndex < 0) continue;
      const replacements = [first, second].flatMap(split => {
        const mutations = split.mutations.filter(mutation => chunkKeyForMutation(mutation) === cursor.chunkKey);
        return mutations.length > 0
          ? [{ batchId: split.batchId, mutations, state: 'pending' as const }]
          : [];
      });
      cursor.pendingBatches.splice(capturedIndex, 1, ...replacements);
    }
    this.sealedBatchIds.add(first.batchId);
    this.sealedBatchIds.add(second.batchId);
    return true;
  }

  private refreshBackpressure() {
    if (!this.remote) {
      this.backpressured = false;
      return;
    }
    const pending = this.pendingMutationCount();
    if (this.backpressured) {
      if (pending <= OUTBOX_LOW_WATER_MUTATIONS) this.backpressured = false;
    } else if (pending >= OUTBOX_HIGH_WATER_MUTATIONS) {
      this.backpressured = true;
    }
  }

  private resolveRetryDelay(error: unknown) {
    const requested = Number((error as any)?.retryAfterMs);
    if (Number.isFinite(requested) && requested >= 0) {
      return Math.min(MAX_SERVER_RETRY_DELAY_MS, Math.max(REMOTE_RETRY_DELAY_MS, requested));
    }
    return Math.min(
      MAX_TRANSIENT_REMOTE_RETRY_DELAY_MS,
      REMOTE_RETRY_DELAY_MS * (2 ** Math.max(0, this.remoteFailureCount - 1))
    );
  }

  private scheduleSyncStatusPublish() {
    if (!this.onSyncStatus || this.syncStatusTimer !== null) return;
    this.syncStatusTimer = setTimeout(() => {
      this.syncStatusTimer = null;
      this.notifySyncStatus();
    }, 50);
  }

  private notifySyncStatus(force = false) {
    if (!this.onSyncStatus) return;
    const status = this.getSyncStatus();
    const key = JSON.stringify(status);
    if (!force && key === this.lastSyncStatusKey) return;
    this.lastSyncStatusKey = key;
    this.onSyncStatus(status);
  }

  private loadRemoteChunks(chunks: TerrainEditChunk[]) {
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      this.loadPackedEdits(chunk.standard, chunk.micro);
    }
  }

  private loadPackedEdits(standardInput: unknown, microInput: unknown) {
    const standard = Array.isArray(standardInput)
      ? standardInput.slice(0, MAX_STORED_STANDARD_EDITS)
      : [];
    for (const packed of standard) this.loadPackedStandardEdit(packed);

    const micro = Array.isArray(microInput)
      ? microInput.slice(0, MAX_STORED_MICRO_EDITS)
      : [];
    for (const packed of micro) this.loadPackedMicroEdit(packed);
  }

  private loadPackedStandardEdit(packed: unknown) {
    if (!Array.isArray(packed) || packed.length < 5) return;
    const x = finiteInteger(packed[0]);
    const y = finiteInteger(packed[1]);
    const z = finiteInteger(packed[2]);
    const block = finiteInteger(packed[3]);
    const color = finiteInteger(packed[4]);
    if (x === null || y === null || z === null || block === null || color === null) return;
    if (x < 0 || x >= TORUS_SIZE_X || y < 0 || y >= CHUNK_SIZE_Y || z < 0 || z >= TORUS_SIZE_Z) return;
    this.addStandardEdit({ x, y, z, block: Math.max(0, Math.min(255, block)), color: color & 0xffffff });
  }

  private loadPackedMicroEdit(packed: unknown) {
    if (!Array.isArray(packed) || packed.length < 4) return;
    const mx = finiteInteger(packed[0]);
    const my = finiteInteger(packed[1]);
    const mz = finiteInteger(packed[2]);
    const color = finiteInteger(packed[3]);
    if (mx === null || my === null || mz === null || color === null) return;
    if (
      mx < 0 || mx >= TORUS_SIZE_X * MICRO_DIVISIONS
      || my < 0 || my >= CHUNK_SIZE_Y * MICRO_DIVISIONS
      || mz < 0 || mz >= TORUS_SIZE_Z * MICRO_DIVISIONS
    ) return;
    this.addMicroEdit({
      mx,
      my,
      mz,
      color: color & 0xffffff,
      part: typeof packed[4] === 'string' ? packed[4].slice(0, 64) : null,
    });
  }

  private loadLocalState() {
    if (!this.storage || !this.worldId) return;
    try {
      const currentRaw = this.storage.getItem(this.storageKey);
      if (currentRaw) {
        const payload = JSON.parse(currentRaw);
        if (payload?.version !== STORAGE_SCHEMA_VERSION || payload?.worldId !== this.worldId) return;
        if (!this.remote) this.loadPackedEdits(payload.standard, payload.micro);
        this.loadPendingBatches(payload.pendingBatches);
        this.replayPendingBatches();
        return;
      }

    } catch (error) {
      console.warn('Space ignored an invalid persisted world-edit payload.', error);
      if (!this.remote) {
        this.standardEdits.clear();
        this.standardEditsByChunk.clear();
        this.microEdits.clear();
        this.microEditsByChunk.clear();
      }
      this.pendingBatches.length = 0;
    }
  }

  private loadPendingBatches(input: unknown) {
    if (!Array.isArray(input)) return;
    for (const item of input) {
      if (
        !item
        || typeof item.batchId !== 'string'
        || !Array.isArray(item.mutations)
        || item.mutations.length < 1
        || item.mutations.length > MAX_MUTATIONS_PER_BATCH
      ) continue;
      const mutations = item.mutations
        .map((mutation: any) => this.sanitizeMutation(mutation))
        .filter(Boolean) as TerrainMutation[];
      if (mutations.length > 0) {
        const hasBoundedDedupeMetadata = item.dedupeEpoch === 1
          && Number.isFinite(Number(item.createdAtMs));
        this.appendRestoredMutations(mutations, {
          firstBatchId: item.batchId,
          // Old V2 outboxes may already have reached the server and lost their
          // ACK. Keep their original id in epoch 0 so the server retains that
          // receipt; any newly split suffix gets bounded epoch-1 metadata.
          firstDedupeEpoch: hasBoundedDedupeMetadata ? 1 : 0,
          firstCreatedAtMs: hasBoundedDedupeMetadata ? Math.floor(Number(item.createdAtMs)) : null,
        });
      }
    }
  }

  private appendRestoredMutations(
    mutations: TerrainMutation[],
    options: {
      firstBatchId?: string;
      firstDedupeEpoch?: number;
      firstCreatedAtMs?: number | null;
    } = {}
  ) {
    let batch: PersistedMutationBatch | null = null;
    let batchIndex = 0;
    for (const mutation of mutations) {
      if (
        !batch
        || batch.mutations.length >= MAX_MUTATIONS_PER_BATCH
        || !batchAcceptsMutation(batch, mutation)
      ) {
        const keepOriginalMetadata = batchIndex === 0 && options.firstBatchId;
        batch = {
          batchId: keepOriginalMetadata ? options.firstBatchId! : createBatchId(),
          mutations: [],
          dedupeEpoch: keepOriginalMetadata ? (options.firstDedupeEpoch ?? 0) : 1,
          createdAtMs: keepOriginalMetadata ? (options.firstCreatedAtMs ?? null) : Date.now(),
        };
        this.pendingBatches.push(batch);
        this.sealedBatchIds.add(batch.batchId);
        batchIndex++;
      }
      batch.mutations.push(mutation);
    }
  }

  private sanitizeMutation(mutation: any): TerrainMutation | null {
    if (mutation?.kind === 'set_standard') {
      const edit = this.normalizeStandardEdit(
        mutation.x, mutation.y, mutation.z, mutation.block, mutation.color
      );
      return edit ? { kind: 'set_standard', ...edit } : null;
    }
    if (mutation?.kind === 'set_micro') {
      const edit = this.normalizeMicroEdit(
        mutation.mx, mutation.my, mutation.mz, mutation.color, mutation.part
      );
      return edit ? {
        kind: 'set_micro',
        mx: edit.mx,
        my: edit.my,
        mz: edit.mz,
        color: edit.color,
        ...(edit.part ? { part: edit.part } : {}),
      } : null;
    }
    if (mutation?.kind === 'remove_micro') {
      if (![mutation.mx, mutation.my, mutation.mz].every(value => Number.isFinite(Number(value)))) return null;
      const my = Math.floor(Number(mutation.my));
      if (my < 0 || my >= CHUNK_SIZE_Y * MICRO_DIVISIONS) return null;
      return {
        kind: 'remove_micro',
        mx: Math.floor(wrapMicroX(Number(mutation.mx))),
        my,
        mz: Math.floor(wrapMicroZ(Number(mutation.mz))),
      };
    }
    if (mutation?.kind === 'clear_micro_cell') {
      if (![mutation.x, mutation.y, mutation.z].every(value => Number.isFinite(Number(value)))) return null;
      const y = Math.floor(Number(mutation.y));
      if (y < 0 || y >= CHUNK_SIZE_Y) return null;
      return {
        kind: 'clear_micro_cell',
        x: Math.floor(wrapX(Number(mutation.x))),
        y,
        z: Math.floor(wrapZ(Number(mutation.z))),
      };
    }
    return null;
  }

  private replayPendingBatches() {
    for (const batch of this.pendingBatches) {
      for (const mutation of batch.mutations) this.applyMutationLocally(mutation);
    }
  }

  private replayPendingBatchesForReplacement(cursor: RemoteChunkReplacementCursor) {
    for (const batch of cursor.pendingBatches) {
      if (batch.state === 'resolved') continue;
      for (const mutation of batch.mutations) this.applyMutationLocally(mutation);
    }
  }

  private applyMutationLocally(mutation: TerrainMutation) {
    if (mutation.kind === 'set_standard') {
      const edit = this.normalizeStandardEdit(
        mutation.x, mutation.y, mutation.z, mutation.block, mutation.color
      );
      if (!edit) return;
      this.addStandardEdit(edit);
      if (edit.block !== 0) this.removeMicroStandardCellLocal(edit.x, edit.y, edit.z);
      return;
    }
    if (mutation.kind === 'set_micro') {
      const edit = this.normalizeMicroEdit(
        mutation.mx, mutation.my, mutation.mz, mutation.color, mutation.part
      );
      if (edit) this.addMicroEdit(edit);
      return;
    }
    if (mutation.kind === 'remove_micro') {
      this.deleteMicroEdit(
        Math.floor(wrapMicroX(mutation.mx)),
        Math.floor(mutation.my),
        Math.floor(wrapMicroZ(mutation.mz))
      );
      return;
    }
    this.removeMicroStandardCellLocal(
      Math.floor(wrapX(mutation.x)),
      Math.floor(mutation.y),
      Math.floor(wrapZ(mutation.z))
    );
  }

  private installLifecycleFlush() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', () => this.flush());
    window.addEventListener('beforeunload', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import {
  WorldEditPersistence,
  worldEditStorageKey,
  type WorldEditStorage,
} from '../src/voxel/WorldEditPersistence.ts';

class MemoryStorage implements WorldEditStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

class DeferredDurableStorage extends MemoryStorage {
  waitStarted = false;
  private releaseDurability: (() => void) | null = null;
  private readonly durable = new Promise<void>(resolve => {
    this.releaseDurability = resolve;
  });

  async whenIdle() {
    this.waitStarted = true;
    await this.durable;
  }

  release() {
    this.releaseDurability?.();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous world-edit sync');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('standard and micro terrain edits survive constructing a fresh world after refresh', () => {
  const storage = new MemoryStorage();
  const persistence = { worldId: 'refresh-test-world', storage };
  const first = new World(new THREE.Scene(), 1337, persistence) as any;

  // Added/recolored cells and AIR tombstones over generated terrain must both
  // survive. Without the tombstone, the y=0 block would regenerate on refresh.
  assert.equal(first.setBlock(40, 80, 48, BlockTypes.COLOR_BLOCK, false, 0x123456), true);
  assert.equal(first.setBlock(41, 0, 48, BlockTypes.AIR, false), true);

  // Persist standalone micro cells as well as the 512-cell subdivision path.
  assert.equal(first.setMicroBlock(42 * 8 + 1, 80 * 8 + 2, 48 * 8 + 3, 0xabcdef, 'tip'), true);
  assert.equal(first.setBlock(43, 80, 48, BlockTypes.COLOR_BLOCK, false, 0x55aa33), true);
  assert.equal(first.subdivideBlock(43, 80, 48), 512);
  assert.equal(first.removeMicroBlock(43 * 8 + 4, 80 * 8 + 4, 48 * 8 + 4), true);
  assert.equal(first.flushPersistedEdits(), true);

  const second = new World(new THREE.Scene(), 1337, persistence) as any;
  second.getOrCreateChunk(2, 3);

  assert.equal(second.getBlock(40, 80, 48), BlockTypes.COLOR_BLOCK);
  assert.equal(second.getBlockColor(40, 80, 48), 0x123456);
  assert.equal(second.getBlock(41, 0, 48), BlockTypes.AIR);
  assert.deepEqual(
    second.getMicroBlock(42 * 8 + 1, 80 * 8 + 2, 48 * 8 + 3),
    { block: BlockTypes.COLOR_BLOCK, color: 0xabcdef }
  );
  assert.equal(second.microVoxels.parts.get(`${42 * 8 + 1},${80 * 8 + 2},${48 * 8 + 3}`), 'tip');
  assert.equal(second.getBlock(43, 80, 48), BlockTypes.AIR);
  assert.equal(second.getMicroBlock(43 * 8, 80 * 8, 48 * 8)?.color, 0x55aa33);
  assert.equal(second.getMicroBlock(43 * 8 + 4, 80 * 8 + 4, 48 * 8 + 4), null);
});

test('world edit storage is isolated by world id and solid cells remove stale micro entries', () => {
  const storage = new MemoryStorage();
  const first = new WorldEditPersistence({ worldId: 'world-a', storage });
  first.recordMicro(81, 161, 241, 0xabcdef);
  first.recordStandard(10, 20, 30, BlockTypes.COLOR_BLOCK, 0x123456);
  assert.equal(first.flush(), true);

  const payload = JSON.parse(storage.getItem(worldEditStorageKey('world-a'))!);
  assert.deepEqual(payload.standard, [[10, 20, 30, BlockTypes.COLOR_BLOCK, 0x123456]]);
  assert.deepEqual(payload.micro, [], 'solid standard edit must clear micro cells in its parent cell');

  const otherWorld = new WorldEditPersistence({ worldId: 'world-b', storage });
  assert.deepEqual([...otherWorld.getStandardEditsForChunk(0, 1)], []);
  assert.deepEqual([...otherWorld.getMicroEdits()], []);
});

test('remote snapshot replacement touches only its indexed standard and micro chunk', () => {
  const persistence = new WorldEditPersistence({
    worldId: 'indexed-remote-world',
    storage: null,
    remote: {
      chunks: [
        {
          chunk_x: 0,
          chunk_z: 0,
          revision: 1,
          standard: [[1, 80, 1, BlockTypes.COLOR_BLOCK, 0x111111]],
          micro: [[5, 100, 5, 0xaaaaaa]],
        },
        {
          chunk_x: 1,
          chunk_z: 0,
          revision: 1,
          standard: [[17, 80, 1, BlockTypes.COLOR_BLOCK, 0x222222]],
          micro: [[136, 100, 5, 0xbbbbbb]],
        },
      ],
      async sendBatch() {}
    }
  });

  persistence.replaceRemoteChunk({
    chunk_x: 0,
    chunk_z: 0,
    revision: 2,
    standard: [[2, 80, 1, BlockTypes.COLOR_BLOCK, 0x333333]],
    micro: [[10, 100, 5, 0xcccccc]],
  });

  assert.deepEqual(
    [...persistence.getStandardEditsForChunk(0, 0)].map(edit => edit.x),
    [2]
  );
  assert.deepEqual(
    [...persistence.getMicroEditsForChunk(0, 0)].map(edit => edit.mx),
    [10]
  );
  assert.deepEqual(
    [...persistence.getStandardEditsForChunk(1, 0)].map(edit => edit.x),
    [17]
  );
  assert.deepEqual(
    [...persistence.getMicroEditsForChunk(1, 0)].map(edit => edit.mx),
    [136]
  );
});

test('large remote snapshot replacement can be installed in bounded slices', () => {
  const persistence = new WorldEditPersistence({
    worldId: 'incremental-remote-world',
    storage: null,
    remote: { chunks: [], async sendBatch() {} }
  });
  const micro = Array.from({ length: 3_000 }, (_, index) => [
    index % 80,
    Math.floor(index / 80),
    0,
    0x48dbfb,
  ]);
  const cursor = persistence.beginRemoteChunkReplacement({
    chunk_x: 0,
    chunk_z: 0,
    revision: 1,
    standard: [],
    micro,
  });

  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_000), false);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)].length, 1_000);
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_000), false);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)].length, 2_000);
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_000), true);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)].length, 3_000);

  const replacement = persistence.beginRemoteChunkReplacement({
    chunk_x: 0,
    chunk_z: 0,
    revision: 2,
    standard: [],
    micro: [[1, 1, 1, 0xff3366]],
  });
  assert.equal(
    persistence.continueRemoteChunkReplacement(replacement, 1_000),
    false,
    'clearing the previous large snapshot must consume the same bounded slices',
  );
  assert.equal(persistence.continueRemoteChunkReplacement(replacement, 1_000), false);
  assert.equal(persistence.continueRemoteChunkReplacement(replacement, 1_000), false);
  assert.equal(persistence.continueRemoteChunkReplacement(replacement, 1_000), true);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)].length, 1);
});

test('remote terrain mutations are split into stable batches of at most 256 operations', async () => {
  const storage = new MemoryStorage();
  const sent: { batchId: string; mutations: any[] }[] = [];
  const persistence = new WorldEditPersistence({
    worldId: 'remote-batch-world',
    storage,
    saveDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch(batchId, mutations) {
        sent.push({ batchId, mutations: structuredClone(mutations) });
      }
    }
  });

  for (let index = 0; index < 257; index++) {
    persistence.recordStandard(index, 80, 10, BlockTypes.COLOR_BLOCK, index);
  }
  await waitFor(() => sent.length === 2);

  assert.deepEqual(sent.map(batch => batch.mutations.length), [256, 1]);
  assert.equal(new Set(sent.map(batch => batch.batchId)).size, 2);
  assert.equal(
    storage.getItem(worldEditStorageKey('remote-batch-world')),
    null,
    'an acknowledged remote overlay must not remain duplicated in browser storage'
  );
});

test('remote terrain mutations are split by chunk and surface-zone footprint', async () => {
  const chunkBatches: any[][] = [];
  const chunkPersistence = new WorldEditPersistence({
    worldId: 'remote-chunk-footprint-world',
    storage: new MemoryStorage(),
    saveDelayMs: 0,
    remoteBatchDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch(_batchId, mutations) {
        chunkBatches.push(structuredClone(mutations));
      }
    }
  });
  for (let chunk = 0; chunk < 17; chunk++) {
    chunkPersistence.recordStandard(chunk * 16, 80, 1, BlockTypes.COLOR_BLOCK, chunk);
  }
  await waitFor(() => chunkBatches.length === 2);
  assert.deepEqual(chunkBatches.map(batch => batch.length), [16, 1]);

  const zoneBatches: any[][] = [];
  const zonePersistence = new WorldEditPersistence({
    worldId: 'remote-zone-footprint-world',
    storage: new MemoryStorage(),
    saveDelayMs: 0,
    remoteBatchDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch(_batchId, mutations) {
        zoneBatches.push(structuredClone(mutations));
      }
    }
  });
  for (let zone = 0; zone < 5; zone++) {
    zonePersistence.recordStandard(zone * 32 * 16, 80, 1, BlockTypes.COLOR_BLOCK, zone);
  }
  await waitFor(() => zoneBatches.length === 2);
  assert.deepEqual(zoneBatches.map(batch => batch.length), [4, 1]);
});

test('remote terrain acknowledgements expose the daily quota in sync status', async () => {
  const persistence = new WorldEditPersistence({
    worldId: 'remote-quota-status-world',
    storage: new MemoryStorage(),
    saveDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch() {
        return {
          quota: {
            daily_limit: 100_000,
            used_today: 12,
            remaining_today: 99_988,
            reset_at: '2026-09-05T00:00:00+00:00',
          },
        };
      }
    }
  });
  persistence.recordStandard(1, 80, 1, BlockTypes.COLOR_BLOCK, 1);
  await waitFor(() => persistence.getSyncStatus().acknowledgedBatches === 1);

  assert.deepEqual(persistence.getSyncStatus().quota, {
    dailyLimit: 100_000,
    usedToday: 12,
    remainingToday: 99_988,
    resetAt: '2026-09-05T00:00:00+00:00',
  });
});

test('a server size rejection splits the same durable outbox instead of dropping edits', async () => {
  const attempts: number[] = [];
  let resyncs = 0;
  const persistence = new WorldEditPersistence({
    worldId: 'remote-adaptive-split-world',
    storage: new MemoryStorage(),
    saveDelayMs: 0,
    remoteBatchDelayMs: 0,
    onResyncRequired: () => { resyncs++; },
    remote: {
      chunks: [],
      async sendBatch(_batchId, mutations) {
        attempts.push(mutations.length);
        if (mutations.length > 1) {
          throw Object.assign(new Error('too large'), { code: 'TERRAIN_EVENT_TOO_LARGE' });
        }
      }
    }
  });
  for (let index = 0; index < 4; index++) {
    persistence.recordStandard(index, 80, 1, BlockTypes.COLOR_BLOCK, index);
  }
  await waitFor(() => persistence.getSyncStatus().acknowledgedMutations === 4);

  assert.deepEqual(attempts, [4, 2, 1, 1, 2, 1, 1]);
  assert.equal(resyncs, 0);
  assert.equal(persistence.getSyncStatus().pendingMutations, 0);
});

test('restored legacy outbox batches are repartitioned to the current spatial limits', async () => {
  const storage = new MemoryStorage();
  const worldId = 'restored-spatial-outbox-world';
  const originalBatchId = '00000000-0000-4000-8000-000000000001';
  storage.setItem(worldEditStorageKey(worldId), JSON.stringify({
    version: 3,
    worldId,
    pendingBatches: [{
      batchId: originalBatchId,
      mutations: Array.from({ length: 17 }, (_value, chunk) => ({
        kind: 'set_standard',
        x: chunk * 16,
        y: 80,
        z: 1,
        block: BlockTypes.COLOR_BLOCK,
        color: chunk,
      })),
      dedupeEpoch: 0,
      createdAtMs: null,
    }],
  }));
  const sent: { batchId: string; mutations: any[] }[] = [];
  new WorldEditPersistence({
    worldId,
    storage,
    saveDelayMs: 0,
    remoteBatchDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch(batchId, mutations) {
        sent.push({ batchId, mutations: structuredClone(mutations) });
      }
    }
  });
  await waitFor(() => sent.length === 2);

  assert.deepEqual(sent.map(batch => batch.mutations.length), [16, 1]);
  assert.equal(sent[0].batchId, originalBatchId);
  assert.notEqual(sent[1].batchId, originalBatchId);
});

test('remote persistence stores only the durable outbox, not acknowledged world snapshots', async () => {
  const storage = new MemoryStorage();
  let releaseSend: (() => void) | null = null;
  const persistence = new WorldEditPersistence({
    worldId: 'outbox-only-world',
    storage,
    saveDelayMs: 0,
    remote: {
      chunks: [{
        chunk_x: 0,
        chunk_z: 0,
        revision: 1,
        standard: [[1, 80, 1, BlockTypes.COLOR_BLOCK, 0xabcdef]],
        micro: [],
      }],
      async sendBatch() {
        await new Promise<void>(resolve => { releaseSend = resolve; });
      }
    }
  });

  persistence.recordStandard(2, 80, 1, BlockTypes.COLOR_BLOCK, 0x123456);
  await waitFor(() => storage.getItem(worldEditStorageKey('outbox-only-world')) !== null);
  const cached = JSON.parse(storage.getItem(worldEditStorageKey('outbox-only-world'))!);

  assert.equal(cached.standard, undefined);
  assert.equal(cached.micro, undefined);
  assert.equal(cached.pendingBatches.length, 1);
  assert.equal(cached.pendingBatches[0].dedupeEpoch, 1);
  assert.equal(typeof cached.pendingBatches[0].createdAtMs, 'number');
  releaseSend?.();
});

test('successful remote batches are paced without allowing concurrent sends', async () => {
  const storage = new MemoryStorage();
  const starts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const persistence = new WorldEditPersistence({
    worldId: 'paced-batch-world',
    storage,
    saveDelayMs: 0,
    remoteBatchDelayMs: 35,
    remote: {
      chunks: [],
      async sendBatch() {
        starts.push(Date.now());
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
      }
    }
  });

  for (let index = 0; index < 257; index++) {
    persistence.recordStandard(index, 81, 12, BlockTypes.COLOR_BLOCK, index);
  }
  await waitFor(() => starts.length === 2);

  assert.equal(maxInFlight, 1);
  assert.ok(starts[1] - starts[0] >= 30, 'the next batch should wait after the prior ACK');
});

test('remote outbox exposes high-water backpressure for bulk edit producers', () => {
  const persistence = new WorldEditPersistence({
    worldId: 'backpressure-world',
    storage: new MemoryStorage(),
    saveDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch() {
        await new Promise(() => {});
      }
    }
  });

  for (let index = 0; index < 4_096; index++) {
    persistence.recordStandard(index, 82, 14, BlockTypes.COLOR_BLOCK, index);
  }

  const status = persistence.getSyncStatus();
  assert.equal(status.pendingMutations, 4_096);
  assert.equal(status.pendingBatches, 16);
  assert.equal(status.backpressured, true);
});

test('remote terrain outbox waits for IndexedDB durability before transmission', async () => {
  const storage = new DeferredDurableStorage();
  const sent: any[] = [];
  const persistence = new WorldEditPersistence({
    worldId: 'durable-outbox-world',
    storage,
    saveDelayMs: 0,
    remote: {
      chunks: [],
      async sendBatch(batchId, mutations) {
        sent.push({ batchId, mutations });
      }
    }
  });

  persistence.recordStandard(10, 80, 10, BlockTypes.COLOR_BLOCK, 0x123456);
  await waitFor(() => storage.waitStarted);
  assert.equal(sent.length, 0, 'network send must wait until the IndexedDB transaction commits');
  persistence.recordStandard(11, 80, 10, BlockTypes.COLOR_BLOCK, 0x654321);

  storage.release();
  await waitFor(() => sent.length === 2);
  assert.equal(sent[0].mutations[0].kind, 'set_standard');
  assert.deepEqual(sent.map(batch => batch.mutations.length), [1, 1]);
  assert.equal(new Set(sent.map(batch => batch.batchId)).size, 2);
});

test('obsolete browser-local grids are ignored without replay or upload', async () => {
  const storage = new MemoryStorage();
  const worldId = 'legacy-upload-world';
  storage.setItem(`space.world-edits.v1.${encodeURIComponent(worldId)}`, JSON.stringify({
    version: 1,
    worldId,
    standard: [[10, 80, 20, BlockTypes.COLOR_BLOCK, 0x123456]],
    micro: [[56, 401, 106, 0xabcdef]],
    savedAt: Date.now()
  }));
  const sent: any[] = [];

  const persistence = new WorldEditPersistence({
    worldId,
    storage,
    saveDelayMs: 0,
    remote: {
      chunks: [{
        chunk_x: 0,
        chunk_z: 1,
        revision: 1,
        standard: [[9, 80, 20, BlockTypes.COLOR_BLOCK, 0x999999]],
        micro: []
      }],
      async sendBatch(batchId, mutations) {
        sent.push({ batchId, mutations: structuredClone(mutations) });
      }
    }
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal([...persistence.getStandardEditsForChunk(0, 1)].length, 1);
  assert.deepEqual([...persistence.getMicroEdits()], []);
  assert.deepEqual(sent, []);
  assert.ok(storage.getItem(`space.world-edits.v1.${encodeURIComponent(worldId)}`));
});

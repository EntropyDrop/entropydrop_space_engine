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

test('a spoon subdivision drains all three durable batches without an ACK pacing gap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: { mutations: any[]; acknowledge: () => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const persistence = new WorldEditPersistence({
    worldId: 'spoon-subdivision-drain',
    storage: new MemoryStorage(),
    saveDelayMs: 75,
    remote: {
      chunks: [],
      async sendBatch(_id, mutations) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>(resolve => {
          sent.push({ mutations: structuredClone(mutations), acknowledge: resolve });
        });
        inFlight--;
      },
    },
  });
  persistence.recordStandard(1, 80, 1, BlockTypes.AIR, 0xffffff);
  for (let x = 8; x < 16; x++) {
    for (let y = 640; y < 648; y++) {
      for (let z = 8; z < 16; z++) persistence.recordMicro(x, y, z, 0xffffff);
    }
  }
  persistence.removeMicro(8, 640, 8);
  t.mock.timers.tick(74);
  await Promise.resolve();
  assert.equal(sent.length, 0, 'the initial durability/coalescing delay still applies');
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(sent.length, 1);
  for (let batch = 0; batch < 3; batch++) {
    sent[batch].acknowledge();
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(sent.length, Math.min(3, batch + 2), 'an ACK immediately enables the queued suffix');
  }
  assert.deepEqual(sent.map(batch => batch.mutations.length), [256, 256, 2]);
  assert.equal(maxInFlight, 1);
  assert.equal(persistence.getSyncStatus().pendingMutations, 0);
});

test('remote snapshot equality includes pending local intent and canonical cell data', () => {
  const original = {
    chunk_x: 0, chunk_z: 0, revision: 1,
    standard: [[1, 80, 1, 0, 0xffffff]],
    micro: [[8, 640, 8, 0x123456, 'old'], [9, 640, 8, 0xabcdef]],
  };
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-with-outbox', storage: null,
    remote: { chunks: [original], async sendBatch() { await new Promise(() => {}); } },
  });
  persistence.recordMicro(8, 640, 8, 0x334455, 'new');
  persistence.removeMicro(9, 640, 8);
  const sameEffective = persistence.beginRemoteChunkReplacement({ ...original, revision: 2 });
  assert.equal(persistence.continueRemoteChunkReplacement(sameEffective), true);
  assert.equal(sameEffective.unchanged, true, 'the echoed snapshot plus pending outbox matches live intent');

  const remoteChange = persistence.beginRemoteChunkReplacement({
    ...original, revision: 3, standard: [[2, 80, 1, 0, 0xffffff]],
  });
  assert.equal(persistence.continueRemoteChunkReplacement(remoteChange), true);
  assert.equal(remoteChange.unchanged, false, 'equal entry counts do not conceal changed coordinates');
});

test('snapshot equality detects micro color/part and standard block/color changes', () => {
  const original = {
    chunk_x: 0, chunk_z: 0, revision: 1,
    standard: [[1, 80, 1, 0, 0xffffff]],
    micro: [[8, 640, 8, 0x123456, 'part']],
  };
  for (const replacement of [
    { ...original, micro: [[8, 640, 8, 0x123457, 'part']] },
    { ...original, micro: [[8, 640, 8, 0x123456, 'other']] },
    { ...original, standard: [[1, 80, 1, 0, 0xfffffe]] },
    { ...original, standard: [[1, 80, 1, 1, 0xffffff]] },
  ]) {
    const persistence = new WorldEditPersistence({
      worldId: 'remote-equality-values', storage: null,
      remote: { chunks: [original], async sendBatch() {} },
    });
    const cursor = persistence.beginRemoteChunkReplacement({ ...replacement, revision: 2 });
    persistence.continueRemoteChunkReplacement(cursor);
    assert.equal(cursor.unchanged, false);
  }
});

test('large unchanged snapshots spend their comparison work across bounded slices', () => {
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
    micro: Array.from({ length: 3_000 }, (_, index) => [index % 80, Math.floor(index / 80), 0, 0x48dbfb]),
  };
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-bounded', storage: null,
    remote: { chunks: [chunk], async sendBatch() {} },
  });
  const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
  for (let slice = 0; slice < 6; slice++) {
    assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_000), false);
  }
  assert.equal(cursor.microIndex, 3_000, 'installation is complete before the comparison finishes');
  assert.equal(cursor.unchanged, false, 'equality is not exposed before every cell is checked');
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_000), false);
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_000), false);
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1_001), true);
  assert.equal(cursor.unchanged, true);
});

test('local edits keep already-compared baseline cells and the target in sync', () => {
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
    micro: [[8, 640, 8, 0x123456], [9, 640, 8, 0xabcdef]],
  };
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-edit-race', storage: null,
    remote: { chunks: [chunk], async sendBatch() { await new Promise(() => {}); } },
  });
  const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 5), false);
  assert.equal(cursor.comparisonStarted, true);
  persistence.recordMicro(8, 640, 8, 0x112233);
  assert.equal(persistence.continueRemoteChunkReplacement(cursor, 5), true);
  assert.equal(cursor.unchanged, true, 'the already-compared first cell received the same local edit on both sides');
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)][0].color, 0x112233);
});

test('continuous clicks during cleanup, installation and comparison still recognize an equivalent echo', () => {
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
    micro: Array.from({ length: 128 }, (_, index) => [index, 640, 8, 0xabcdef]),
  };
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-continuous', storage: null,
    remote: { chunks: [chunk], async sendBatch() { await new Promise(() => {}); } },
  });
  const expected = new Map(chunk.micro.map(([x, y, z, color]) => [`${x},${y},${z}`, color]));
  const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
  let complete = false;
  for (let slice = 0; slice < 300 && !complete; slice++) {
    if (slice % 2 === 0) {
      const x = slice % 80;
      persistence.removeMicro(x, 640, 8, true);
      expected.delete(`${x},640,8`);
    } else {
      const x = 100 + slice % 20;
      persistence.recordMicro(x, 640, 8, 0x123400 + slice);
      expected.set(`${x},640,8`, 0x123400 + slice);
    }
    complete = persistence.continueRemoteChunkReplacement(cursor, 4);
  }
  assert.equal(complete, true, 'comparison makes progress while clicks continue');
  assert.equal(cursor.unchanged, true);
  const actual = new Map([...persistence.getMicroEditsForChunk(0, 0)]
    .map(edit => [`${edit.mx},${edit.my},${edit.mz}`, edit.color]));
  assert.deepEqual(actual, expected);
  assert.equal([...persistence.getMicroEdits()].length, actual.size, 'cleanup must not orphan global entries');
});

test('continuous local clicks cannot conceal an untouched remote edit', () => {
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
    micro: Array.from({ length: 64 }, (_, index) => [index, 640, 8, 0xabcdef]),
  };
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-foreign-change', storage: null,
    remote: { chunks: [chunk], async sendBatch() { await new Promise(() => {}); } },
  });
  const cursor = persistence.beginRemoteChunkReplacement({
    ...chunk, revision: 2,
    micro: chunk.micro.map(edit => edit[0] === 63 ? [63, 640, 8, 0xff0000] : edit),
  });
  for (let slice = 0; slice < 300 && !cursor.complete; slice++) {
    persistence.recordMicro(slice % 8, 640, 8, slice);
    persistence.continueRemoteChunkReplacement(cursor, 4);
  }
  assert.equal(cursor.complete, true);
  assert.equal(cursor.unchanged, false);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)].find(edit => edit.mx === 63)?.color, 0xff0000);
});

test('local standard replacement preserves exclusion and cleanup during a remote comparison', () => {
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
    micro: [[8, 640, 8, 0x123456, 'old'], [9, 640, 8, 0xabcdef], [24, 640, 8, 0x112233]],
  };
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-standard-write', storage: null,
    remote: { chunks: [chunk], async sendBatch() { await new Promise(() => {}); } },
  });
  const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
  persistence.continueRemoteChunkReplacement(cursor, 1);
  persistence.recordStandard(1, 80, 1, BlockTypes.COLOR_BLOCK, 0xff0000);
  persistence.removeMicroStandardCell(3, 80, 1, true, true);
  while (!persistence.continueRemoteChunkReplacement(cursor, 2)) {}
  assert.equal(cursor.unchanged, true);
  assert.deepEqual([...persistence.getMicroEdits()], []);
  assert.deepEqual([...persistence.getMicroEditsForChunk(0, 0)], []);
  assert.equal([...persistence.getStandardEditsForChunk(0, 0)][0].color, 0xff0000);
});

test('an initial outbox ACK during replacement preserves authoritative color/deletion and newer clicks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const duringComparison of [false, true]) {
    for (const foreignDeletes of [false, true]) {
      const chunk = {
        chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
        micro: [[8, 640, 8, 0x123456], [9, 640, 8, 0xabcdef]],
      };
      const sends: (() => void)[] = [];
      const persistence = new WorldEditPersistence({
        worldId: `remote-equality-ack-race-${duringComparison}-${foreignDeletes}`,
        storage: new MemoryStorage(), saveDelayMs: 0,
        remote: {
          chunks: [chunk],
          async sendBatch() {
            await new Promise<void>(resolve => sends.push(resolve));
            return { chunks: [{ chunk_x: 0, chunk_z: 0, revision: 2 }] };
          },
        },
      });
      persistence.recordMicro(8, 640, 8, 0x0000ff);
      t.mock.timers.tick(0);
      await Promise.resolve();
      assert.equal(sends.length, 1);
      const cursor = persistence.beginRemoteChunkReplacement({
        ...chunk, revision: 3,
        micro: foreignDeletes
          ? [[9, 640, 8, 0xabcdef]]
          : [[8, 640, 8, 0xff0000], [9, 640, 8, 0xabcdef]],
      });
      if (duringComparison) {
        while (!cursor.comparisonStarted) {
          assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1), false);
        }
      }
      // This click happened after the incoming snapshot was fetched, so it
      // remains local intent even though the older batch is now acknowledged.
      persistence.recordMicro(9, 640, 8, 0xffff00);
      sends[0]();
      await Promise.resolve();
      await Promise.resolve();
      while (!persistence.continueRemoteChunkReplacement(cursor, 2)) {}
      assert.equal(cursor.unchanged, false, 'an ACK boundary must keep authoritative replacement');
      const actual = [...persistence.getMicroEditsForChunk(0, 0)];
      assert.equal(actual.find(edit => edit.mx === 8)?.color, foreignDeletes ? undefined : 0xff0000);
      assert.equal(actual.find(edit => edit.mx === 9)?.color, 0xffff00);
    }
  }
});

test('ACKs newer than an incoming snapshot preserve committed local colors and deletions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const duringComparison of [false, true]) {
    for (const localDeletes of [false, true]) {
      const chunk = {
        chunk_x: 0, chunk_z: 0, revision: 1, standard: [],
        micro: [[8, 640, 8, 0x123456], [9, 640, 8, 0xabcdef]],
      };
      const sends: (() => void)[] = [];
      const persistence = new WorldEditPersistence({
        worldId: `remote-equality-newer-ack-${duringComparison}-${localDeletes}`,
        storage: new MemoryStorage(), saveDelayMs: 0,
        remote: {
          chunks: [chunk],
          async sendBatch() {
            await new Promise<void>(resolve => sends.push(resolve));
            return { chunks: [{ chunk_x: 0, chunk_z: 0, revision: 3 }] };
          },
        },
      });
      if (localDeletes) persistence.removeMicro(8, 640, 8);
      else persistence.recordMicro(8, 640, 8, 0x0000ff);
      t.mock.timers.tick(0);
      await Promise.resolve();
      const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
      if (duringComparison) {
        while (!cursor.comparisonStarted) {
          assert.equal(persistence.continueRemoteChunkReplacement(cursor, 1), false);
        }
      }
      persistence.recordMicro(9, 640, 8, 0xffff00);
      sends[0]();
      await Promise.resolve();
      await Promise.resolve();
      while (!persistence.continueRemoteChunkReplacement(cursor, 2)) {}
      assert.equal(cursor.unchanged, false, 'ACK boundaries retain the normal publication path');
      const actual = [...persistence.getMicroEditsForChunk(0, 0)];
      assert.equal(actual.find(edit => edit.mx === 8)?.color, localDeletes ? undefined : 0x0000ff);
      assert.equal(actual.find(edit => edit.mx === 9)?.color, 0xffff00);
    }
  }
});

test('each chunk uses its own ACK revision when one batch spans several chunks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chunks = [0, 1].map(cx => ({
    chunk_x: cx, chunk_z: 0, revision: 1, standard: [],
    micro: [[cx * 128 + 8, 640, 8, 0xff0000]],
  }));
  let acknowledge = () => {};
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-per-chunk-ack', storage: new MemoryStorage(), saveDelayMs: 0,
    remote: {
      chunks,
      async sendBatch() {
        await new Promise<void>(resolve => { acknowledge = resolve; });
        return { chunks: [
          { chunk_x: 0, chunk_z: 0, revision: 3 },
          { chunk_x: 1, chunk_z: 0, revision: 5 },
        ] };
      },
    },
  });
  persistence.recordMicro(8, 640, 8, 0x0000ff);
  persistence.recordMicro(136, 640, 8, 0x0000ff);
  t.mock.timers.tick(0);
  await Promise.resolve();
  const older = persistence.beginRemoteChunkReplacement({ ...chunks[0], revision: 2 });
  const newer = persistence.beginRemoteChunkReplacement({
    ...chunks[1], revision: 5, micro: [[136, 640, 8, 0x00ff00]],
  });
  acknowledge();
  await Promise.resolve();
  await Promise.resolve();
  persistence.continueRemoteChunkReplacement(older);
  persistence.continueRemoteChunkReplacement(newer);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)][0].color, 0x0000ff);
  assert.equal([...persistence.getMicroEditsForChunk(1, 0)][0].color, 0x00ff00);
});

test('preserved ACK batches replay in their original order ahead of newer local intent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [], micro: [[8, 640, 8, 0xff0000]],
  };
  const sends: (() => void)[] = [];
  let revision = 2;
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-ack-order', storage: new MemoryStorage(), saveDelayMs: 0,
    remote: {
      chunks: [chunk],
      async sendBatch() {
        await new Promise<void>(resolve => sends.push(resolve));
        return { chunks: [{ chunk_x: 0, chunk_z: 0, revision: ++revision }] };
      },
    },
  });
  for (let index = 0; index < 256; index++) persistence.recordMicro(8, 640, 8, 0x0000ff);
  persistence.recordMicro(8, 640, 8, 0x00ff00);
  const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
  for (let index = 0; index < 2; index++) {
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(sends.length, index + 1);
    sends[index]();
    await Promise.resolve();
    await Promise.resolve();
  }
  persistence.continueRemoteChunkReplacement(cursor);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)][0].color, 0x00ff00);
});

test('a split batch preserves only its committed prefix when its suffix is rejected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chunk = {
    chunk_x: 0, chunk_z: 0, revision: 1, standard: [], micro: [[8, 640, 8, 0xff0000]],
  };
  const sends: { resolve: (result: unknown) => void; reject: (error: unknown) => void }[] = [];
  const persistence = new WorldEditPersistence({
    worldId: 'remote-equality-split-ack', storage: new MemoryStorage(), saveDelayMs: 0,
    remote: {
      chunks: [chunk],
      async sendBatch(_id, mutations) {
        if (mutations.length > 2) throw Object.assign(new Error('size'), { code: 'TERRAIN_EVENT_TOO_LARGE' });
        return new Promise((resolve, reject) => sends.push({ resolve, reject }));
      },
    },
  });
  for (const color of [0x0000ff, 0x0000ff, 0x00ff00, 0x00ff00]) {
    persistence.recordMicro(8, 640, 8, color);
  }
  const cursor = persistence.beginRemoteChunkReplacement({ ...chunk, revision: 2 });
  for (let tick = 0; sends.length < 1 && tick < 10; tick++) {
    t.mock.timers.tick(0);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(sends.length, 1);
  sends[0].resolve({ chunks: [{ chunk_x: 0, chunk_z: 0, revision: 3 }] });
  for (let tick = 0; sends.length < 2 && tick < 10; tick++) {
    t.mock.timers.tick(0);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(sends.length, 2);
  sends[1].reject(Object.assign(new Error('rejected'), { permanent: true }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  persistence.continueRemoteChunkReplacement(cursor);
  assert.equal([...persistence.getMicroEditsForChunk(0, 0)][0].color, 0x0000ff);
});

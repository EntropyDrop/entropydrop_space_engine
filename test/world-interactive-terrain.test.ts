import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { MICRO_DIVISIONS as D } from '../src/voxel/MicroGrid.ts';

function installedWorld(options = {}) {
  const world = new World(new THREE.Scene(), 12345, { worldId: 'echo-test', storage: null, ...options }) as any;
  const chunk = world.getOrCreateChunk(0, 0);
  world.activeChunkKeys.add('0,0');
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.dirtyChunks.clear();
  world.pendingStreamChunks = [];
  return world;
}

function snapshot(world: any, revision = 1) {
  return {
    chunk_x: 0, chunk_z: 0, revision,
    standard: [...world.editPersistence.getStandardEditsForChunk(0, 0)]
      .map(e => [e.x, e.y, e.z, e.block, e.color]),
    micro: [...world.editPersistence.getMicroEditsForChunk(0, 0)]
      .map(e => [e.mx, e.my, e.mz, e.color, e.part]),
  };
}

function drain(world: any) {
  let slices = 0;
  while (world.pendingRemoteChunkUpdates.size || world.pendingRemoteChunkApply) {
    world.processPendingRemoteChunkUpdates(performance.now(), 20, true);
    assert.ok(++slices < 100, 'a small snapshot should finish within bounded slices');
  }
  return slices;
}

test('own snapshot echoes advance the revision without clearing or rebuilding terrain', () => {
  const world = installedWorld();
  world.subdivideBlock(1, 10, 1);
  world.removeMicroBlock(D, 10 * D, D);
  world.microVoxels.updateMesh();
  const echo = snapshot(world);
  const version = world.terrainVersion;
  const meshes = new Map(world.microVoxels.meshChunks);
  const stamp = world.microVoxels.getCollisionStamp(0, 0);
  world.microVoxels.beginClearChunk = () => { throw new Error('an echo must not clear live microcells'); };
  world.queueRemoteChunkUpdates([echo]);
  assert.ok(drain(world) > 1, 'comparison of 511 cells stays incremental');
  assert.equal(world.remoteChunkRevisions.get('0,0'), 1);
  assert.equal(world.pendingTerrainSnapshots.size, 0);
  assert.equal(world.microMeshBuildBlockedChunks.size, 0);
  assert.equal(world.terrainVersion, version);
  assert.deepEqual(world.microVoxels.meshChunks, meshes);
  assert.deepEqual(world.microVoxels.getCollisionStamp(0, 0), stamp);
});

test('snapshot plus unacknowledged spoon edits can retain the current live geometry', () => {
  const world = installedWorld();
  world.setMicroBlock(8, 800, 8, 0xabcdef);
  world.setMicroBlock(9, 800, 8, 0xabcdef);
  world.microVoxels.updateMesh();
  const echo = snapshot(world);
  world.removeMicroBlock(8, 800, 8);
  world.editPersistence.pendingBatches.push({ batchId: 'pending-delete', mutations: [
    { kind: 'remove_micro', mx: 8, my: 800, mz: 8 },
  ], dedupeEpoch: 1, createdAtMs: Date.now() });
  world.microVoxels.beginClearChunk = () => { throw new Error('pending local intent matches the live geometry'); };
  world.queueRemoteChunkUpdates([echo]);
  drain(world);
  assert.equal(world.getMicroBlock(8, 800, 8), null);
  assert.ok(world.getMicroBlock(9, 800, 8));
  assert.equal(world.pendingTerrainSnapshots.size, 0);
});

test('different authoritative content is still installed and rebuilt', () => {
  const world = installedWorld();
  world.setMicroBlock(8, 800, 8, 0xabcdef);
  world.microVoxels.updateMesh();
  const incoming = snapshot(world);
  incoming.micro[0][3] = 0x112233;
  world.queueRemoteChunkUpdates([incoming]);
  drain(world);
  assert.equal(world.getMicroBlock(8, 800, 8).color, 0x112233);
  assert.ok(world.pendingTerrainSnapshots.has('0,0'));
  assert.equal(world.microVoxels.getPublishedCollisionColor(8, 800, 8), 0xabcdef,
    'the previous published surface stays stable until atomic publication');
});

test('matching persistence cannot skip a still-unpublished authoritative replacement', () => {
  const world = installedWorld();
  world.setMicroBlock(8, 800, 8, 0xabcdef);
  world.microVoxels.updateMesh();
  world.pendingTerrainSnapshots.set('0,0', { key: '0,0', cx: 0, cz: 0, revision: 1, standardEdits: [] });
  world.queueRemoteChunkUpdates([snapshot(world, 2)]);
  drain(world);
  assert.equal(world.pendingTerrainSnapshots.get('0,0').revision, 2);
});

test('direct edits dispatch before unrelated snapshot backlog but wait for their own replacement', () => {
  const world = installedWorld();
  world.activeChunkKeys.add('1,0');
  world.pendingTerrainSnapshots.set('1,0', { key: '1,0', cx: 1, cz: 0, revision: 1, standardEdits: [] });
  const requests: any[] = [];
  world.terrainWorker = { postMessage: request => requests.push(request) };
  world.setBlock(1, 100, 1, 1);
  world.dispatchTerrainWorkerJob();
  assert.equal(requests[0].type, 'remesh');
  assert.equal(requests[0].cx, 0);
  assert.ok(world.pendingTerrainSnapshots.has('1,0'));
  world.terrainWorkerJob = null;
  world.pendingTerrainSnapshots.clear();
  world.pendingTerrainSnapshots.set('0,0', { key: '0,0', cx: 0, cz: 0, revision: 1, standardEdits: [] });
  world.dispatchTerrainWorkerJob();
  assert.equal(requests[1].type, 'generate');
  assert.equal(requests[1].cx, 0);
});

test('consecutive local ACKs skip their queued echo without skipping another chunk', () => {
  const world = installedWorld();
  world.remoteChunkRevisions.set('0,0', 4);
  world.remoteChunkRevisions.set('1,0', 8);
  world.queueRemoteChunkUpdates([
    { chunk_x: 0, chunk_z: 0, revision: 5, standard: [], micro: [] },
    { chunk_x: 1, chunk_z: 0, revision: 9, standard: [], micro: [] },
  ]);
  world.acknowledgeLocalTerrainBatch([{ kind: 'remove_micro', mx: 8, my: 800, mz: 8 }], {
    chunks: [{ chunk_x: 0, chunk_z: 0, revision: 5 }], terrain_revision: 100,
  });
  assert.equal(world.remoteChunkRevisions.get('0,0'), 5);
  assert.equal(world.pendingRemoteChunkUpdates.has('0,0'), false);
  assert.equal(world.remoteChunkRevisions.get('1,0'), 8);
  assert.equal(world.pendingRemoteChunkUpdates.has('1,0'), true);
});

test('ACK gaps, unknown baselines and pending remote installations retain authoritative snapshots', () => {
  const mutation = [{ kind: 'remove_micro', mx: 8, my: 800, mz: 8 }];
  for (const state of ['gap', 'unknown', 'installing']) {
    const world = installedWorld();
    if (state !== 'unknown') world.remoteChunkRevisions.set('0,0', 4);
    if (state === 'installing') world.pendingRemoteChunkApply = { key: '0,0' };
    const revision = state === 'gap' ? 6 : 5;
    world.queueRemoteChunkUpdates([{ chunk_x: 0, chunk_z: 0, revision, standard: [], micro: [] }]);
    world.acknowledgeLocalTerrainBatch(mutation, { chunks: [{ chunk_x: 0, chunk_z: 0, revision }] });
    assert.equal(world.remoteChunkRevisions.get('0,0'), state === 'unknown' ? undefined : 4);
    assert.equal(world.pendingRemoteChunkUpdates.has('0,0'), true);
  }
});

test('an in-flight local remesh cannot release a newer authoritative micro publication', () => {
  const world = installedWorld();
  const chunk = world.getChunk(0, 0);
  world.setBlock(1, 100, 1, 1);
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.dirtyChunks.clear();
  world.interactiveDirtyChunks.clear();
  world.terrainWorker = { postMessage() {} };
  world.setBlock(2, 100, 1, 1);
  world.dispatchTerrainWorkerJob();
  const job = world.terrainWorkerJob;
  const result = { ok: true, requestId: job.requestId, mesh: world.mesher.buildChunkMeshData(chunk) };
  world.queueRemoteChunkUpdates([{ chunk_x: 0, chunk_z: 0, revision: 1,
    standard: [[1, 100, 1, 0, 0xffffff], [2, 100, 1, 1, 0xffffff]],
    micro: [[8, 800, 8, 0x123456]],
  }]);
  drain(world);
  world.microVoxels.updateMesh(Infinity, world.activeChunkKeys, world.microMeshBuildBlockedChunks,
    Infinity, world.crossLayerPublicationChunks);
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({ job, result });
  assert.equal(world.publishCompletedTerrainWorkerJob(), false);
  assert.equal(world.completedTerrainWorkerJobs.length, 0, 'the old remesh must not block the next worker');
  assert.equal(world.getBlock(1, 100, 1), 1);
  assert.equal(world.microVoxels.getPublishedCollisionColor(8, 800, 8), null);
  assert.ok(world.crossLayerPublicationChunks.has('0,0'));
  assert.ok(world.pendingTerrainSnapshots.has('0,0'));
  assert.equal(world.dispatchTerrainWorkerJob(), true);
  assert.equal(world.terrainWorkerJob.type, 'generate');
});

test('an ACK newer than a sliced snapshot cannot restore a successfully excavated microcell', async () => {
  let acknowledge!: (result: unknown) => void;
  const response = new Promise(resolve => { acknowledge = resolve; });
  const world = installedWorld({ remote: { chunks: [], sendBatch: () => response } });
  const incoming = { chunk_x: 0, chunk_z: 0, revision: 1, standard: [], micro: [] as number[][] };
  for (let x = 8; x < 24; x++) {
    for (let z = 8; z < 24; z++) {
      incoming.micro.push([x, 800, z, 0xabcdef]);
      world.microVoxels.set(x, 800, z, 0xabcdef);
    }
  }
  world.editPersistence.replaceRemoteChunk(incoming);
  world.microVoxels.updateMesh();
  world.remoteChunkRevisions.set('0,0', 0);
  world.removeMicroBlock(8, 800, 8);
  const sending = world.editPersistence.flushNextRemoteBatch();
  world.pendingRemoteChunkApply = world.beginPendingRemoteChunkApply(incoming);
  let slices = 0;
  while (!world.pendingRemoteChunkApply.persistenceCursor.comparisonStarted) {
    world.advancePendingRemoteChunkApply(performance.now(), Infinity, 1, true);
    assert.ok(++slices < 2000);
  }
  acknowledge({ chunks: [{ chunk_x: 0, chunk_z: 0, revision: 2 }] });
  await sending;
  drain(world);
  assert.equal(world.getMicroBlock(8, 800, 8), null);
  assert.ok(world.getMicroBlock(9, 800, 8));
  assert.equal(world.editPersistence.getSyncStatus().pendingMutations, 0);
});

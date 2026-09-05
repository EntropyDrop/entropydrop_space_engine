import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { MicroVoxelLayer, MICRO_SIZE } from '../src/voxel/MicroVoxelLayer.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';

test('standard voxels retain arbitrary per-instance colors', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setBlock(2, 20, 2, BlockTypes.COLOR_BLOCK, false, '#12abef' as any);
  assert.equal(world.getBlock(2, 20, 2), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(2, 20, 2), 0x12abef);
});

test('spoon subdivision replaces one standard voxel with exactly 5x5x5 cells', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setBlock(2, 20, 2, BlockTypes.COLOR_BLOCK, false, 0xff3366);
  assert.equal(world.subdivideBlock(2, 20, 2), 125);
  assert.equal(world.getBlock(2, 20, 2), BlockTypes.AIR);
  assert.equal(world.microVoxels.cells.size, 125);
  assert.equal(world.microVoxels.get(10, 100, 10), 0xff3366);
  world.microVoxels.updateMesh();

  const hit = world.raycastMicro(
    new THREE.Vector3(2.5, 20.5, 1),
    new THREE.Vector3(0, 0, 1),
    4
  );
  assert.equal(hit.hit, true);
  assert.equal(hit.kind, 'micro');
  assert.equal(hit.size, MICRO_SIZE);

  const axisHit = world.raycastMicro(
    new THREE.Vector3(1, 20, 2),
    new THREE.Vector3(1, 0, 0),
    4
  );
  assert.equal(axisHit.hit, true);
  assert.equal(axisHit.microPos.x, 10);
});

test('micro voxel edits rebuild only their dirty horizontal mesh chunk', () => {
  const layer = new MicroVoxelLayer() as any;
  layer.set(1, 10, 1, 0xff0000);
  layer.set(101, 10, 1, 0x00ff00);
  assert.equal(layer.updateMesh(), true);
  assert.equal(layer.meshChunks.size, 2);

  const nearKey = layer.mesh.userData.microChunkKey;
  const farEntry = [...layer.meshChunks.entries()].find(([key]) => key !== nearKey);
  const nearGeometry = layer.meshChunks.get(nearKey).geometry;
  const farGeometry = farEntry[1].geometry;
  layer.set(2, 10, 1, 0x0000ff);
  assert.equal(layer.updateMesh(), true);

  assert.notEqual(layer.meshChunks.get(nearKey).geometry, nearGeometry);
  assert.equal(layer.meshChunks.get(farEntry[0]).geometry, farGeometry);
});

test('micro voxel meshes use compact indexed attributes and metre-correct transforms', () => {
  const layer = new MicroVoxelLayer();
  layer.set(81, 10, 1, 0x48dbfb);
  layer.updateMesh();

  const mesh = layer.meshChunks.get('4,0')!;
  const geometry = mesh.geometry;
  assert.equal(geometry.getAttribute('position').count, 24);
  assert.equal(geometry.index?.count, 36);
  assert.ok(geometry.getAttribute('position').array instanceof Uint16Array);
  assert.ok(geometry.getAttribute('normal').array instanceof Int8Array);
  assert.ok(geometry.getAttribute('color').array instanceof Uint8Array);
  assert.equal(geometry.getAttribute('normal').normalized, true);
  assert.equal(geometry.getAttribute('color').normalized, true);
  assert.deepEqual(mesh.position.toArray(), [16, 0, 0]);
  assert.deepEqual(mesh.scale.toArray(), [MICRO_SIZE, MICRO_SIZE, MICRO_SIZE]);
});

test('same-color micro voxels merge their coplanar exterior into greedy quads', () => {
  const layer = new MicroVoxelLayer();
  for (let mx = 1; mx <= 3; mx++) {
    for (let my = 10; my <= 12; my++) {
      for (let mz = 1; mz <= 3; mz++) layer.set(mx, my, mz, 0x48dbfb);
    }
  }
  layer.updateMesh();

  const geometry = layer.meshChunks.get('0,0')!.geometry;
  assert.equal(geometry.getAttribute('position').count, 24, 'a solid cuboid needs six merged quads');
  assert.equal(geometry.index?.count, 36);
});

test('dense micro mesh rebuilds yield to the render-frame budget and retain the previous mesh', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 10, 1, 0x48dbfb);
  layer.updateMesh();
  const previousMesh = layer.mesh;

  for (let mx = 0; mx < 20; mx++) {
    for (let mz = 0; mz < 20; mz++) {
      for (let my = 0; my < 100; my++) layer.set(mx, my, mz, 0x48dbfb);
    }
  }

  assert.equal(layer.updateMesh(1, null, null, 0), false);
  assert.equal(layer.mesh, previousMesh, 'the last complete GPU mesh remains visible while rebuilding');

  let complete = false;
  let frames = 0;
  while (!complete && frames < 1_000) {
    complete = layer.updateMesh(1, null, null, 1);
    frames++;
  }
  assert.equal(complete, true);
  assert.ok(frames > 1, 'dense meshing should be distributed over multiple render budgets');
  assert.notEqual(layer.mesh, previousMesh);
  assert.equal(layer.mesh.geometry.index?.count, 36);
});

test('micro mesh work is deferred until its standard chunk is active', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 10, 1, 0xff0000);
  layer.set(81, 10, 1, 0x00ff00);

  assert.equal(layer.updateMesh(1, new Set(['0,0'])), true);
  assert.equal(layer.meshChunks.has('0,0'), true);
  assert.equal(layer.meshChunks.has('4,0'), false);

  assert.equal(layer.updateMesh(1, new Set(['1,0'])), true);
  assert.equal(layer.meshChunks.has('4,0'), true);
});

test('interactive micro edits are selected before ordinary queued mesh partitions', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 10, 1, 0xff0000);
  layer.set(101, 10, 1, 0x00ff00);
  layer.prioritizeMeshAt(101, 1);

  assert.equal(
    layer.updateMesh(1, new Set(['0,0', '1,0'])),
    true,
  );
  assert.equal(layer.meshChunks.has('5,0'), true,
    'the partition touched by direct input should publish first');
  assert.equal(layer.meshChunks.has('0,0'), false,
    'ordinary background work should remain queued for the idle path');
});

test('interactive micro edits preempt an already active background mesh build', () => {
  const layer = new MicroVoxelLayer() as any;
  for (let mx = 1; mx < 19; mx++) {
    for (let mz = 1; mz < 19; mz++) layer.set(mx, 10, mz, 0xff0000);
  }

  assert.equal(layer.updateMesh(1, null, null, 0), false);
  assert.equal(layer.activeMeshBuild?.chunkKey, '0,0',
    'the ordinary partition should be paused mid-build');

  layer.set(101, 10, 1, 0x00ff00);
  layer.prioritizeMeshAt(101, 1);
  assert.equal(layer.activeMeshBuild, null,
    'direct input should return unrelated active work to the queue');

  assert.equal(layer.updateMesh(1), true);
  assert.equal(layer.meshChunks.has('5,0'), true,
    'the clicked partition should publish in the next available slice');
  assert.equal(layer.meshChunks.has('0,0'), false,
    'the preempted background partition should remain resumable');
});

test('world publishes local micro placement and destruction before idle streaming', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);

  assert.equal(world.setMicroBlock(5, 1_000, 5, 0x48dbfb), true);
  assert.equal(world.microVoxels.meshChunks.size, 0);
  let placementFrames = 0;
  while (!world.microVoxels.meshChunks.has('0,0') && placementFrames < 8) {
    world.processInteractiveTerrainWork();
    placementFrames++;
  }
  assert.equal(world.microVoxels.meshChunks.has('0,0'), true,
    'placing a micro voxel should publish without requestIdleCallback');
  assert.ok(placementFrames < 8,
    'a sparse interactive partition should finish within a few foreground budgets');

  assert.equal(world.removeMicroBlock(5, 1_000, 5), true);
  assert.equal(world.processInteractiveTerrainWork(), true);
  assert.equal(world.microVoxels.meshChunks.has('0,0'), false,
    'destroying the last micro voxel should retire its mesh without idle time');
});

test('micro mesh chunks cull shared faces across their boundary', () => {
  const layer = new MicroVoxelLayer();
  layer.set(19, 10, 1, 0xff0000);
  layer.set(20, 10, 1, 0xff0000);
  layer.updateMesh();

  assert.equal(layer.meshChunks.get('0,0')?.geometry.index?.count, 30);
  assert.equal(layer.meshChunks.get('1,0')?.geometry.index?.count, 30);
});

test('micro voxel chunk replacement clears only the indexed target chunk', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 10, 1, 0xff0000);
  layer.set(81, 10, 1, 0x00ff00);

  assert.equal(layer.clearChunk(0, 0), 1);
  assert.equal(layer.get(1, 10, 1), null);
  assert.equal(layer.get(81, 10, 1), 0x00ff00);
});

test('dense micro voxel chunk clearing is resumable', () => {
  const layer = new MicroVoxelLayer();
  for (let index = 0; index < 3_000; index++) {
    layer.set(index % 80, Math.floor(index / 6_400), Math.floor(index / 80) % 80, 0x48dbfb);
  }
  const cursor = layer.beginClearChunk(0, 0);

  assert.equal(layer.continueClearChunk(cursor, 1_000), false);
  assert.equal(layer.cells.size, 2_000);
  assert.equal(layer.continueClearChunk(cursor, 1_000), false);
  assert.equal(layer.cells.size, 1_000);
  assert.equal(layer.continueClearChunk(cursor, 1_000), false);
  assert.equal(layer.cells.size, 0);
  assert.equal(layer.continueClearChunk(cursor, 1_000), true);
});

test('remote micro replacement retains published collision until its mesh swaps', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 10, 1, 0xff0000);
  layer.updateMesh();
  const cursor = layer.beginClearChunk(0, 0);
  layer.continueClearChunk(cursor);
  layer.set(2, 10, 1, 0x00ff00);
  layer.finalizeCollisionSnapshots(cursor.targetMeshChunks);

  assert.equal(layer.get(1, 10, 1), null, 'the incoming data view may already have removed the old cell');
  assert.equal(layer.getPublishedCollisionColor(1, 10, 1), 0xff0000,
    'physics must retain occupancy represented by the old mesh');
  assert.equal(layer.getPublishedCollisionColor(2, 10, 1), null,
    'new occupancy must wait for the matching mesh publication');

  layer.updateMesh();
  assert.equal(layer.getPublishedCollisionColor(1, 10, 1), null);
  assert.equal(layer.getPublishedCollisionColor(2, 10, 1), 0x00ff00,
    'mesh replacement and collision replacement should commit together');
});

test('cross-layer conversion can prepare a micro mesh without publishing it early', () => {
  const layer = new MicroVoxelLayer();
  const deferredChunks = new Set(['0,0']);
  layer.set(5, 100, 5, 0x48dbfb);

  assert.equal(layer.updateMesh(Infinity, null, null, Infinity, deferredChunks), true);
  assert.equal(layer.meshChunks.size, 0,
    'a subdivided micro mesh must wait while the old standard block is visible');
  assert.equal(layer.isDeferredPublicationReady('0,0'), true);

  const prepared: THREE.Mesh[] = [];
  assert.equal(layer.publishDeferredForStandardChunk('0,0', mesh => prepared.push(mesh)), 1);
  assert.equal(prepared.length, 1);
  assert.equal(layer.meshChunks.size, 1,
    'the prepared micro mesh should publish at the shared standard/micro commit point');
});

test('a cross-layer barrier also defers the adjacent boundary-face partition', () => {
  const layer = new MicroVoxelLayer();
  const deferredChunks = new Set(['0,0']);
  layer.set(79, 100, 5, 0x48dbfb);
  layer.updateMesh(Infinity, new Set(['0,0', '1,0']), null, Infinity, deferredChunks);

  assert.equal(layer.meshChunks.size, 0,
    'neither side of a 16 m boundary may publish before the shared commit');
  assert.equal(layer.publishDeferredForStandardChunk('0,0', () => {}), 1,
    'only partitions owned by the target standard chunk join its atomic commit');
  assert.equal(layer.meshChunks.size, 1,
    'the occupied target publishes while its outside companion keeps the old view');
  deferredChunks.delete('0,0');
  assert.equal(
    layer.updateMesh(Infinity, new Set(['0,0', '1,0']), null, Infinity, deferredChunks),
    true,
    'the outside companion should rebuild after the target commit instead of publishing early',
  );
});

test('a newer inactive boundary companion cannot hold the target barrier', () => {
  const layer = new MicroVoxelLayer();
  const deferredChunks = new Set(['0,0']);
  layer.set(79, 100, 5, 0x48dbfb);
  layer.updateMesh(Infinity, new Set(['0,0', '1,0']), null, Infinity, deferredChunks);

  // This is inside the blocked outside companion partition, but not on its
  // shared edge, so only that inactive partition receives a newer revision.
  layer.set(81, 100, 5, 0x22c55e);
  assert.equal(layer.isDeferredPublicationReady('0,0', new Set(['0,0'])), true,
    'an inactive stale companion must not hold the active standard result forever');
  assert.equal(layer.publishDeferredForStandardChunk('0,0', () => {}), 1,
    'the still-current target partition should remain available for the atomic commit');
});

test('adjacent cross-layer barriers retain unique micro partition ownership', () => {
  const layer = new MicroVoxelLayer();
  const deferredChunks = new Set(['0,0', '1,0']);
  layer.set(79, 100, 5, 0x48dbfb);
  layer.set(80, 100, 5, 0x22c55e);
  layer.updateMesh(Infinity, new Set(['0,0', '1,0']), null, Infinity, deferredChunks);

  assert.equal(layer.isDeferredPublicationReady('0,0'), true);
  assert.equal(layer.isDeferredPublicationReady('1,0'), true);
  assert.equal(layer.publishDeferredForStandardChunk('0,0', () => {}), 1,
    'the first barrier must not capture its neighbour partition');
  assert.equal(layer.publishDeferredForStandardChunk('1,0', () => {}), 1,
    'the adjacent barrier must retain its own staged partition');
});

test('selected micro voxels become one programmable rigid body and can be restored', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  world.setBlock(3, 20, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.subdivideBlock(3, 20, 3);

  const manager = new ContraptionManager(scene, world, null, null);
  manager.setCornerA({ x: 3, y: 20, z: 3 });
  manager.setCornerB({ x: 3, y: 20, z: 3 });
  const contraption = manager.assembleSelection() as any;

  assert.ok(contraption);
  assert.equal(contraption.blocks.length, 125);
  assert.ok(contraption.blocks.every(block => block.size === MICRO_SIZE));
  assert.ok(Math.abs(contraption.voxelVolume - 1) < 1e-9);
  assert.equal(world.microVoxels.cells.size, 0);

  assert.equal(manager.disassembleContraption(contraption), true);
  assert.equal(world.microVoxels.cells.size, 125);
});

test('standard entities solidify without losing blocks above the legacy y=32 boundary', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null);
  world.setBlock(3, 40, 3, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  manager.setCornerA({ x: 3, y: 40, z: 3 });
  manager.setCornerB({ x: 3, y: 40, z: 3 });

  const contraption = manager.assembleSelection() as any;
  assert.ok(contraption);
  assert.equal(world.getBlock(3, 40, 3), BlockTypes.AIR);
  assert.equal(manager.disassembleContraption(contraption), true);
  assert.equal(world.getBlock(3, 40, 3), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(3, 40, 3), 0x48dbfb);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { MICRO_DIVISIONS as D, MICRO_SIZE as S } from '../src/voxel/MicroGrid.ts';
import { TORUS_SIZE_X } from '../src/torus/TorusWorld.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { World } from '../src/voxel/World.ts';

const unit = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };

test('all 512 differently colored microcells share one exact collision box', () => {
  const layer = new MicroVoxelLayer();
  for (let x = 0; x < D; x++) for (let y = 0; y < D; y++) for (let z = 0; z < D; z++) {
    layer.set(x, y, z, (x + D * y + D * D * z) % 2 ? 0xffffff : 0);
  }
  const boxes = layer.getCollisionBoxesInAABB(unit);
  assert.deepEqual(boxes, [unit]);
  const first = boxes[0];
  assert.equal(layer.getCollisionBoxesInAABB(unit)[0], first, 'reuse immutable cached geometry');
  layer.delete(3, 3, 3);
  const carved = layer.getCollisionBoxesInAABB(unit);
  let volume = 0;
  for (const box of carved) {
    volume += (box.maxX - box.minX) * (box.maxY - box.minY) * (box.maxZ - box.minZ);
    assert.equal(box.minX <= 3.5 * S && box.maxX >= 3.5 * S
      && box.minY <= 3.5 * S && box.maxY >= 3.5 * S
      && box.minZ <= 3.5 * S && box.maxZ >= 3.5 * S, false, 'never fill the carved hole');
  }
  assert.equal(volume, 511 / 512);
});

test('published cached colliders swap atomically, including incremental clear and refill', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 1, 1, 1);
  layer.set(2, 1, 1, 2);
  layer.updateMesh();
  const before = layer.getCollisionBoxesInAABB(unit, true);
  layer.delete(1, 1, 1);
  assert.deepEqual(layer.getCollisionBoxesInAABB(unit, true), before);
  layer.updateMesh();
  assert.equal(layer.getCollisionBoxesInAABB(unit, true)[0].minX, 2 * S);
  // Exercise the cold-cache path when the live chunk index has been detached.
  layer.set(3, 1, 1, 3);
  layer.updateMesh();
  const cursor = layer.beginClearChunk(0, 0);
  layer.continueClearChunk(cursor, 1);
  assert.equal(layer.getCollisionBoxesInAABB(unit, true)[0].maxX, 4 * S);
  layer.continueClearChunk(cursor);
  layer.set(5, 1, 1, 5);
  assert.equal(layer.getCollisionBoxesInAABB(unit, true)[0].minX, 2 * S);
  layer.updateMesh();
  assert.deepEqual(layer.getCollisionBoxesInAABB(unit, true), [{
    minX: 5 * S, maxX: 6 * S, minY: S, maxY: 2 * S, minZ: S, maxZ: 2 * S,
  }]);
});

test('cached micro queries unwrap across the torus seam and skip empty volume', () => {
  const layer = new MicroVoxelLayer();
  layer.set(TORUS_SIZE_X * D - 1, 2, 1, 1);
  layer.set(0, 2, 1, 1);
  const boxes = layer.getCollisionBoxesInAABB({ ...unit, minX: -S, maxX: S });
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map(box => [box.minX, box.maxX]), [[-S, 0], [0, S]]);
  (layer as any).get = () => { throw new Error('must not scan empty microcells'); };
  assert.deepEqual(layer.getCollisionBoxesInAABB({ ...unit, minX: 32, maxX: 64, maxY: 256 }), []);
});

test('physics uses cached micro geometry when the world provides it', () => {
  const world = {
    getBlock: () => 0,
    getMicroCollisionBoxesInAABB: () => [unit],
    getMicroBlocksInAABB: () => { throw new Error('unmerged cell path must be bypassed'); },
  };
  const physics = new ContraptionPhysics(world as any);
  assert.deepEqual(physics.terrainBoxesOverlapping(unit), [unit]);
});

test('terrain stamps track only nearby chunks and published micro geometry', () => {
  const world = new World(new THREE.Scene());
  world.setBlock(2, 100, 2, 1, false);
  const near = { minX: 1, maxX: 4, minZ: 1, maxZ: 4 };
  const stamp = world.getTerrainCollisionStamp(near);
  world.setBlock(160, 100, 160, 1, false);
  assert.deepEqual(world.getTerrainCollisionStamp(near), stamp);
  world.setBlock(2, 100, 2, 0, false);
  assert.notDeepEqual(world.getTerrainCollisionStamp(near), stamp);
  const beforeMicro = world.getTerrainCollisionStamp(near);
  world.microVoxels.set(2 * D, 100 * D, 2 * D, 1);
  assert.deepEqual(world.getTerrainCollisionStamp(near), beforeMicro, 'unpublished shapes do not wake sleepers');
  world.microVoxels.updateMesh();
  assert.notDeepEqual(world.getTerrainCollisionStamp(near), beforeMicro);
  assert.deepEqual(world.getTerrainCollisionStamp({ minX: -1, maxX: -S, minZ: 1, maxZ: 2 }),
    world.getTerrainCollisionStamp({ minX: TORUS_SIZE_X - 1, maxX: TORUS_SIZE_X - S, minZ: 1, maxZ: 2 }));
});

test('a body rests on merged published microterrain, sleeps, and falls when it is removed', () => {
  const scene = new THREE.Scene();
  const world = new World(scene);
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  for (let x = 16; x < 24; x++) for (let z = 16; z < 24; z++) {
    world.setMicroBlock(x, 800, z, 0x123456);
  }
  world.microVoxels.updateMesh();
  const physics = new ContraptionPhysics(world);
  const manager = new ContraptionManager(scene, world, null, null);
  manager.setPhysics(physics);
  const body = new Contraption('micro-supported', [{ localX: 0, localY: 0, localZ: 0, block: 1 }],
    new THREE.Vector3(2, 101, 2), scene);
  manager.registerContraption(body);
  for (let i = 0; i < 100; i++) manager.update(0.05, null);
  assert.equal(physics.isSleeping(body), true);
  assert.ok(Math.abs(body.position.y - (100 + S + 0.5)) < 0.004);
  const height = body.position.y;
  world.microVoxels.clearStandardCell(2, 100, 2);
  manager.update(0.05, null);
  assert.equal(physics.isSleeping(body), true, 'the old published floor remains collision-ready');
  world.microVoxels.updateMesh();
  manager.update(0.05, null);
  assert.equal(physics.isSleeping(body), false);
  assert.ok(body.position.y < height);
});

test('color, part labels and adjacent visible faces retain cached collision geometry', () => {
  const layer = new MicroVoxelLayer();
  layer.set(15, 15, 1, 0xff0000);
  layer.set(16, 15, 1, 0xff0000);
  layer.updateMesh();
  const all = { minX: 1.8, maxX: 2.2, minY: 1.8, maxY: 2.2, minZ: 0, maxZ: 0.5 };
  const live = layer.getCollisionBoxesInAABB(all);
  const before = layer.getCollisionBoxesInAABB(all, true);
  const stamp = layer.getCollisionStamp(0, 0);
  layer.set(15, 15, 1, 0x00ff00, 'painted');
  assert.equal(layer.getCollisionBoxesInAABB(all)[0], live[0], 'live geometry ignores visual labels');
  layer.updateMesh();
  assert.equal(layer.getCollisionBoxesInAABB(all, true)[0], before[0]);
  assert.deepEqual(layer.getCollisionStamp(0, 0), stamp, 'paint must not wake resting bodies');
  layer.delete(15, 15, 1);
  layer.updateMesh();
  assert.equal(layer.getCollisionBoxesInAABB(all, true)[0], before[1],
    'a neighbor face becoming visible does not change its occupied geometry');
  assert.notDeepEqual(layer.getCollisionStamp(0, 0), stamp);
});

test('fully enclosed three-dimensional partitions retain published solid collision', () => {
  const layer = new MicroVoxelLayer();
  // One solid partition and a one-cell shell completely occluding its faces.
  for (let x = 15; x <= 32; x++) for (let y = 15; y <= 32; y++) for (let z = 15; z <= 32; z++) {
    layer.set(x, y, z, 0x123456);
  }
  layer.updateMesh();
  assert.equal(layer.meshChunks.has('1,1,1'), false, 'the enclosed partition emits no triangles');
  assert.equal(layer.getPublishedCollisionColor(24, 24, 24), 0x123456);
  assert.deepEqual(layer.getCollisionBoxesInAABB({ minX: 3, maxX: 3.1, minY: 3, maxY: 3.1, minZ: 3, maxZ: 3.1 }, true), [{
    minX: 2, maxX: 4, minY: 2, maxY: 4, minZ: 2, maxZ: 4,
  }]);
  layer.delete(24, 24, 24);
  assert.equal(layer.getPublishedCollisionColor(24, 24, 24), 0x123456, 'unpublished holes stay closed');
  layer.updateMesh();
  assert.equal(layer.getPublishedCollisionColor(24, 24, 24), null);
});

test('incremental clear does not prebuild every cold collision index synchronously', () => {
  const layer = new MicroVoxelLayer() as any;
  layer.set(2, 10, 2, 1);
  layer.set(2, 100, 2, 2);
  layer.updateMesh();
  const original = layer.collisionIndexForPartition.bind(layer);
  let queries = 0;
  layer.collisionIndexForPartition = (...args: any[]) => { queries++; return original(...args); };
  const cursor = layer.beginClearChunk(0, 0);
  assert.equal(queries, 0, 'clearing detaches memberships without synchronous collision construction');
  layer.continueClearChunk(cursor, 1);
  const beforePublication = layer.getCollisionBoxesInAABB({ minX: 0, maxX: 1, minY: 0, maxY: 20, minZ: 0, maxZ: 1 }, true);
  assert.equal(beforePublication.length, 2, 'a cold query still sees the entire old published shape');
  layer.continueClearChunk(cursor);
  layer.updateMesh();
  assert.deepEqual(layer.getCollisionBoxesInAABB({ minX: 0, maxX: 1, minY: 0, maxY: 20, minZ: 0, maxZ: 1 }, true), []);
});

test('collision queries include solids touching the bottom of a vertical partition boundary', () => {
  const layer = new MicroVoxelLayer();
  layer.set(2, 15, 2, 1);
  const bounds = { minX: 0.25, maxX: 0.375, minY: 2, maxY: 2.1, minZ: 0.25, maxZ: 0.375 };
  assert.equal(layer.getCollisionBoxesInAABB(bounds).length, 1);
});

test('revealing a face across a standard-chunk boundary does not wake that neighbor', () => {
  const layer = new MicroVoxelLayer();
  layer.set(127, 5, 5, 1);
  layer.set(128, 5, 5, 1);
  layer.updateMesh();
  const neighborStamp = layer.getCollisionStamp(1, 0);
  layer.delete(127, 5, 5);
  layer.updateMesh();
  assert.deepEqual(layer.getCollisionStamp(1, 0), neighborStamp);
  assert.equal(layer.meshChunks.get('8,0,0')!.geometry.index!.count, 36);
});

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

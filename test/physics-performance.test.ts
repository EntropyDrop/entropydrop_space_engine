import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption, ContraptionMode } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function makeGrid(sizeX: number, sizeY: number, sizeZ: number) {
  const blocks = [];
  for (let x = 0; x < sizeX; x++) {
    for (let y = 0; y < sizeY; y++) {
      for (let z = 0; z < sizeZ; z++) {
        blocks.push({ localX: x, localY: y, localZ: z, block: BlockTypes.COLOR_BLOCK, entityId: 'root' });
      }
    }
  }
  return new Contraption(
    `grid_${sizeX}_${sizeY}_${sizeZ}`,
    blocks,
    new THREE.Vector3(0, 30, 0),
    new THREE.Scene(),
    { mode: ContraptionMode.FREE_PHYSICS }
  ) as any;
}

test('solid voxel interiors are removed from the physics collision shell', () => {
  const solid = makeGrid(3, 3, 3);

  assert.equal(solid.collisionEntries.length, 27, 'editing still retains every voxel');
  assert.equal(solid.collisionSurfaceEntries.length, 26, 'only the enclosed centre is absent from physics');
  assert.equal(solid.getCollisionWorldAABBs().length, 27, 'deep entity penetration retains the full solid');
  assert.equal(solid.getCollisionWorldAABBs(true).length, 26, 'terrain broadphase uses only the exterior shell');
  assert.equal(solid.getCollisionSamplePoints().length, 26 * 10);

  const bounds = solid.getCollisionWorldAABBs(true).reduce((result, box) => ({
    minX: Math.min(result.minX, box.currentMinX),
    minY: Math.min(result.minY, box.currentMinY),
    minZ: Math.min(result.minZ, box.currentMinZ),
    maxX: Math.max(result.maxX, box.currentMaxX),
    maxY: Math.max(result.maxY, box.currentMaxY),
    maxZ: Math.max(result.maxZ, box.currentMaxZ)
  }), { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity });
  assert.deepEqual(bounds, { minX: 0, minY: 30, minZ: 0, maxX: 3, maxY: 33, maxZ: 3 });
});

test('collision queries reuse one stable result until the entity pose changes', () => {
  const entity = makeGrid(2, 1, 2);
  const boxes = entity.getCollisionWorldAABBs();
  const samples = entity.getCollisionSamplePoints('root', true);

  assert.equal(entity.getCollisionWorldAABBs(), boxes);
  assert.equal(entity.getCollisionSamplePoints('root', true), samples);

  entity.position.x += 3;
  entity.updateTransform();
  const movedBoxes = entity.getCollisionWorldAABBs();
  const movedSamples = entity.getCollisionSamplePoints('root', true);
  assert.notEqual(movedBoxes, boxes);
  assert.notEqual(movedSamples, samples);
  assert.equal(movedBoxes[0].currentMinX, boxes[0].currentMinX + 3);
  assert.equal(movedSamples[0].x, samples[0].x + 3);
});

test('surface terrain optimization keeps interior boxes for deep-penetration recovery', () => {
  const solid = makeGrid(3, 3, 3);
  const embedded = makeGrid(1, 1, 1);
  solid.setBodyType(BodyType.KINEMATIC);
  embedded.position.copy(solid.position);
  embedded.updateTransform();
  const start = embedded.position.clone();
  const physics = new ContraptionPhysics({
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false }),
    getBlock: () => BlockTypes.AIR
  } as any);

  physics.resolveContraptionPairs([solid, embedded]);

  assert.ok(
    embedded.position.distanceTo(start) > 0.0005,
    'the enclosed collision voxel must still participate in penetration correction'
  );
});

test('aligned collision boxes scan half-open terrain ranges without neighbour amplification', () => {
  const plate = makeGrid(10, 1, 10);
  plate.useGravity = false;
  let standardQueries = 0;
  let microQueries = 0;
  const physics = new ContraptionPhysics({
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false }),
    getBlock: () => {
      standardQueries++;
      return BlockTypes.AIR;
    },
    getMicroBlocksInAABB: () => {
      microQueries++;
      return [];
    }
  } as any);

  physics.update(plate, 1 / 60);

  // Three fixed substeps: 1,000 point probes plus one exact terrain-cell query
  // per 100 aligned OBBs in each step. The old inclusive maximum queried all
  // eight neighbouring cells for every OBB.
  assert.equal(standardQueries, 3 * (1000 + 100));
  assert.ok(microQueries <= 3 * 10,
    'merged terrain boxes should query the sparse micro layer in batches');
});

test('the manager builds entity broadphase candidates once for all frame substeps', () => {
  const scene = new THREE.Scene();
  const world = {
    getBlock: () => BlockTypes.AIR,
    getMicroBlocksInAABB: () => [],
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false })
  } as any;
  const physics = new ContraptionPhysics(world) as any;
  let broadphaseBuilds = 0;
  let pairSolves = 0;
  const preparePairs = physics.prepareContraptionPairFrame.bind(physics);
  const solvePairs = physics.resolvePreparedContraptionPairs.bind(physics);
  physics.prepareContraptionPairFrame = (...args) => {
    broadphaseBuilds++;
    return preparePairs(...args);
  };
  physics.resolvePreparedContraptionPairs = (...args) => {
    pairSolves++;
    return solvePairs(...args);
  };

  const manager = new ContraptionManager(scene, world, null, null) as any;
  manager.setPhysics(physics);
  const first = makeGrid(1, 1, 1);
  const second = makeGrid(1, 1, 1);
  first.useGravity = false;
  second.useGravity = false;
  second.position.x += 4;
  second.updateTransform();
  manager.registerContraption(first);
  manager.registerContraption(second);

  manager.update(1 / 60, null);

  assert.equal(broadphaseBuilds, 1);
  assert.equal(pairSolves, 3, 'all three fixed physics substeps reuse the same candidate set');
});

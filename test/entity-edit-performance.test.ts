import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption, BodyType } from '../src/contraption/Contraption.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function buildCastleBlocks(size = 70, height = 16) {
  const blocks: any[] = [];
  // 1. Perimeter curtain walls (70 x 70 outer boundary, height 16)
  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      const isPerimeter = (x === 0 || x === size - 1 || z === 0 || z === size - 1);
      if (isPerimeter) {
        for (let y = 0; y < height; y++) {
          blocks.push({
            localX: x, localY: y, localZ: z, size: 1,
            block: BlockTypes.COLOR_BLOCK, color: 0x888888, entityId: 'root'
          });
        }
        // Battlements
        if ((x + z) % 2 === 0) {
          blocks.push({
            localX: x, localY: height, localZ: z, size: 1,
            block: BlockTypes.COLOR_BLOCK, color: 0x999999, entityId: 'root'
          });
        }
      }
    }
  }

  // 2. Four corner towers (10x10, height 24)
  for (const [cornerX, cornerZ] of [[0, 0], [size - 10, 0], [0, size - 10], [size - 10, size - 10]]) {
    for (let x = cornerX; x < cornerX + 10; x++) {
      for (let z = cornerZ; z < cornerZ + 10; z++) {
        const isTowerWall = (x === cornerX || x === cornerX + 9 || z === cornerZ || z === cornerZ + 9);
        if (isTowerWall) {
          for (let y = 0; y < 24; y++) {
            blocks.push({
              localX: x, localY: y, localZ: z, size: 1,
              block: BlockTypes.COLOR_BLOCK, color: 0x777777, entityId: 'root'
            });
          }
        }
      }
    }
  }

  // 3. Keep in the center (20x20, height 12)
  for (let x = 25; x < 45; x++) {
    for (let z = 25; z < 45; z++) {
      const isKeepWall = (x === 25 || x === 44 || z === 25 || z === 44);
      if (isKeepWall) {
        for (let y = 0; y < 12; y++) {
          blocks.push({
            localX: x, localY: y, localZ: z, size: 1,
            block: BlockTypes.COLOR_BLOCK, color: 0x666666, entityId: 'root'
          });
        }
      }
    }
  }

  // 4. Child component with its own blocks (e.g. windmill / flag / gate)
  for (let i = 0; i < 50; i++) {
    blocks.push({
      localX: 35, localY: 13 + i * 0.25, localZ: 35, size: 0.25,
      block: BlockTypes.COLOR_BLOCK, color: 0xff0000, entityId: 'spire'
    });
  }

  return blocks;
}

test('castle structure with ~10000 blocks performs single-block edits in < 5ms without tearing down nodes', () => {
  const castleBlocks = buildCastleBlocks(70, 16);
  assert.ok(castleBlocks.length >= 8000, `expected at least 8000 blocks, got ${castleBlocks.length}`);

  const entity = new Contraption('castle_sim', castleBlocks, new THREE.Vector3(100, 20, 100), new THREE.Scene(), {
    childEntities: [{ id: 'spire', parentId: 'root', pivot: [35, 13, 35] }]
  }) as any;

  try {
    const rootNodeBefore = entity.entityNodes.get('root');
    const spireNodeBefore = entity.entityNodes.get('spire');
    const spireBodyBefore = entity.getRigidBody('spire');
    const rootGroupBefore = rootNodeBefore.group;
    const spireGroupBefore = spireNodeBefore.group;

    assert.ok(rootNodeBefore);
    assert.ok(spireNodeBefore);

    // Warm up spatial queries
    const queryBounds = { minX: 99, maxX: 103, minY: 19, maxY: 23, minZ: 99, maxZ: 103 };
    const initialHits = entity.queryCollisionWorldAABBs(queryBounds);
    assert.ok(initialHits.length > 0);

    const pickOrigin = new THREE.Vector3(100.5, 30, 100.5);
    const pickDir = new THREE.Vector3(0, -1, 0);
    const hitBefore = entity.raycastCollisionCells(pickOrigin, pickDir);
    assert.ok(hitBefore);

    const editTimes: number[] = [];

    // Test 1: Remove a block on root with shovel (10 sequential edits)
    for (let i = 0; i < 10; i++) {
      const targetIndex = entity.blocks.findIndex((b: any) => b.localX === i + 2 && b.localY === 0 && b.localZ === 0 && b.entityId === 'root');
      assert.ok(targetIndex >= 0);
      const targetBlock = entity.blocks[targetIndex];
      entity.blocks.splice(targetIndex, 1);

      const start = performance.now();
      entity.rebuildAfterBlockChange('remove', 'root', {
        cell: [targetBlock.localX, targetBlock.localY, targetBlock.localZ],
        size: targetBlock.size,
        block: targetBlock.block,
        color: targetBlock.color
      });
      const elapsed = performance.now() - start;
      editTimes.push(elapsed);
    }

    // Test 2: Place a block on root with shovel (10 sequential edits)
    for (let i = 0; i < 10; i++) {
      const newBlock = {
        localX: i + 2, localY: 0, localZ: 0, size: 1,
        block: BlockTypes.COLOR_BLOCK, color: 0x00ff00, entityId: 'root'
      };
      entity.blocks.push(newBlock);

      const start = performance.now();
      entity.rebuildAfterBlockChange('place', 'root', {
        cell: [newBlock.localX, newBlock.localY, newBlock.localZ],
        size: 1,
        block: newBlock.block,
        color: newBlock.color
      });
      const elapsed = performance.now() - start;
      editTimes.push(elapsed);
    }

    // Test 3: Color a block (10 sequential color edits)
    for (let i = 0; i < 10; i++) {
      const block = entity.blocks[i];
      block.color = 0x123456;

      const start = performance.now();
      entity.rebuildAfterBlockChange('color', block.entityId || 'root', {
        cell: [block.localX, block.localY, block.localZ],
        size: block.size || 1,
        color: block.color
      });
      const elapsed = performance.now() - start;
      editTimes.push(elapsed);
    }

    // Sort timings to find median and max
    const sorted = [...editTimes].sort((a, b) => a - b);
    const medianTime = sorted[Math.floor(sorted.length / 2)];
    const maxTime = sorted[sorted.length - 1];

    console.log(`[Castle Benchmark] 30 single-voxel edits on ${entity.blocks.length} blocks:`);
    console.log(`  Median: ${medianTime.toFixed(3)}ms, Max: ${maxTime.toFixed(3)}ms, Min: ${sorted[0].toFixed(3)}ms`);

    // Verify CPU time requirement: median edit time must be < 5ms (drastically down from 580-610ms)
    assert.ok(medianTime < 5.0, `Expected median edit time < 5ms, got ${medianTime.toFixed(3)}ms`);
    assert.ok(maxTime < 15.0, `Expected max edit time < 15ms, got ${maxTime.toFixed(3)}ms`);

    // Verify node & rigid body preservation
    assert.equal(entity.entityNodes.get('root'), rootNodeBefore, 'root node must be preserved');
    assert.equal(entity.entityNodes.get('spire'), spireNodeBefore, 'untouched child node must be preserved');
    assert.equal(rootNodeBefore.group, rootGroupBefore, 'root Three.js Group must be preserved');
    assert.equal(spireNodeBefore.group, spireGroupBefore, 'child Three.js Group must be preserved');
    assert.equal(entity.getRigidBody('spire'), spireBodyBefore, 'child rigid body must be preserved');

    // Verify picking and collision still work accurately
    const hitAfter = entity.raycastCollisionCells(pickOrigin, pickDir);
    assert.ok(hitAfter, 'raycast must still hit geometry');
    const hitsAfter = entity.queryCollisionWorldAABBs(queryBounds);
    assert.ok(hitsAfter.length > 0, 'collision query must return bounding boxes');

  } finally {
    entity.dispose();
  }
});

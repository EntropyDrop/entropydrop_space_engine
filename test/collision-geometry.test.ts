import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { CollisionBoxIndex, collisionBoundsOverlap, mergeCollisionCells } from '../src/physics/CollisionGeometry.ts';

function occupied(boxes) {
  const cells = new Set<string>();
  for (const box of boxes) {
    for (let x = box.x; x < box.x + (box.spanX ?? box.span); x++) {
      for (let y = box.y; y < box.y + (box.spanY ?? box.span); y++) {
        for (let z = box.z; z < box.z + (box.spanZ ?? box.span); z++) cells.add(`${box.entityId}:${x},${y},${z}`);
      }
    }
  }
  return cells;
}

test('a 100-voxel plate has one exact physics box and still has 100 editable/pickable voxels', () => {
  const blocks = [];
  for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) {
    blocks.push({ localX: x, localY: 0, localZ: z, entityId: 'root', block: BlockTypes.COLOR_BLOCK });
  }
  const entity = new Contraption('plate', blocks, new THREE.Vector3(), new THREE.Scene()) as any;
  assert.equal(entity.getPhysicsCollisionWorldAABBs().length, 1);
  assert.equal(entity.getCollisionWorldAABBs().length, 100);
  assert.equal(entity.blocks.length, 100);
  assert.deepEqual(occupied(entity.collisionPhysicsBoxes), occupied(entity.collisionEntries));
  for (const x of [0.5, 5.5, 9.5]) {
    assert.ok(entity.raycastCollisionCells(new THREE.Vector3(x, 3, 5.5), new THREE.Vector3(0, -1, 0)));
  }
});

test('mixed standard/micro voxels merge without filling holes or joining independent components', () => {
  const cells = [{ x: 5, y: 0, z: 0, span: 5, entityId: 'root' }];
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) {
    cells.push({ x, y, z, span: 1, entityId: 'root' });
  }
  assert.equal(mergeCollisionCells(cells).length, 1);
  cells.push({ x: 10, y: 0, z: 0, span: 5, entityId: 'wheel' });
  cells.push({ x: -5, y: 0, z: 0, span: 5, entityId: 'root' });
  cells.splice(cells.findIndex(cell => cell.x === 2 && cell.y === 2 && cell.z === 2), 1);
  const merged = mergeCollisionCells(cells);
  assert.deepEqual(occupied(merged), occupied(cells));
  assert.equal(occupied(merged).has('root:2,2,2'), false, 'the internal cavity must remain empty');
  assert.equal(merged.filter(box => box.entityId === 'wheel').length, 1);
});

test('box merging preserves the exact voxel union of irregular structures', () => {
  let seed = 9127;
  for (let sample = 0; sample < 20; sample++) {
    const cells = [];
    for (let x = -4; x < 4; x++) for (let y = -3; y < 3; y++) for (let z = -4; z < 4; z++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      if (seed % 5 < 2) cells.push({ x, y, z, span: 1, entityId: seed % 2 ? 'root' : 'child' });
    }
    assert.deepEqual(occupied(mergeCollisionCells(cells)), occupied(cells));
  }
});

test('the local collision index matches exhaustive swept-bounds queries in stable solver order', () => {
  const boxes = Array.from({ length: 1024 }, (_, i) => ({
    minX: (i % 32) * 3, maxX: (i % 32) * 3 + 1,
    minY: 0, maxY: 1, minZ: Math.floor(i / 32) * 3, maxZ: Math.floor(i / 32) * 3 + 1,
  }));
  const index = new CollisionBoxIndex(boxes);
  for (let i = 0; i < 100; i++) {
    const query = { minX: i - 3, maxX: i + 2, minY: -1, maxY: 2, minZ: i / 2, maxZ: i / 2 + 4 };
    assert.deepEqual(index.query(query), boxes.filter(box => collisionBoundsOverlap(box, query)));
  }
  let reads = 0;
  const watched = boxes.map(box => new Proxy(box, { get(target, key) { reads++; return target[key]; } }));
  const watchedIndex = new CollisionBoxIndex(watched);
  reads = 0;
  assert.equal(watchedIndex.query(boxes[500]).length, 1);
  assert.ok(reads < 150, `a local query must prune distant leaves, property reads=${reads}`);
});

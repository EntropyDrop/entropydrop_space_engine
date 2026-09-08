import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { collisionBoundsOverlap } from '../src/physics/CollisionGeometry.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { bendPoint, computeBentBoundsSphere, getWorldShapeMode, setWorldShapeMode,
  setWorldProjectionAnchor, TORUS_SIZE_X, TORUS_SIZE_Z } from '../src/torus/TorusWorld.ts';

const block = (x, y = 0, z = 0, size = 1, entityId = 'root') => ({
  localX: x, localY: y, localZ: z, size, entityId,
  block: BlockTypes.COLOR_BLOCK, color: 0xffffff,
});
const bounds = (x, y, z, width = 0.6) => ({
  minX: x, minY: y, minZ: z, maxX: x + width, maxY: y + 1.8, maxZ: z + width,
});
const create = (blocks, position = new THREE.Vector3(), options = {}) => (
  new Contraption(1, blocks, position, new THREE.Scene(), options) as any
);

test('local voxel queries preserve exhaustive swept bounds across parent and child rotations', () => {
  const blocks = Array.from({ length: 128 }, (_, i) => block(
    i % 8, Math.floor(i / 32) * 0.25, Math.floor(i / 8) % 4,
    i % 3 === 0 ? 0.125 : 1, i % 2 ? 'arm' : 'root',
  ));
  const c = create(blocks, new THREE.Vector3(10, 4, 20), {
    childEntities: [{ id: 'arm', parentId: 'root', pivot: [3, 0.5, 1] }],
  });
  try {
    let cached;
    for (let pose = 0; pose < 5; pose++) {
      c.capturePreviousEntityTransforms();
      c.position.x += 3;
      c.quaternion.setFromEuler(new THREE.Euler(pose * 0.2, pose * 0.5, pose * -0.1));
      const arm = c.entityNodes.get('arm');
      arm.localQuaternion.setFromEuler(new THREE.Euler(pose * 0.4, 0, pose * 0.3));
      arm.group.quaternion.copy(arm.localQuaternion);
      c.updateTransform();
      const all = c.getCollisionWorldAABBs();
      for (let i = 0; i < 80; i++) {
        const query = bounds(7 + (i * 7 % 25), 1 + (i * 3 % 8), 15 + (i * 11 % 14));
        const expected = all.filter(box => collisionBoundsOverlap(box, query));
        const actual = c.queryCollisionWorldAABBs(query).filter(box => collisionBoundsOverlap(box, query));
        assert.deepEqual(actual, expected, `pose ${pose}, query ${i}`);
      }
      if (cached) assert.equal(c.collisionVoxelIndexes, cached, 'pose changes must retain the geometry index');
      cached = c.collisionVoxelIndexes;
    }
    c.setNodeCollisionEnabled('arm', false);
    const query = bounds(-100, -100, -100, 300);
    query.maxY = 200;
    assert.deepEqual(c.queryCollisionWorldAABBs(query), c.getCollisionWorldAABBs());
    assert.ok(c.queryCollisionWorldAABBs(query).every(box => box.entityId === 'root'));
  } finally { c.dispose(); }
});

test('micro holes stay open and edits rebuild both collision and picking indexes', () => {
  const c = create([block(0, 0, 0, 0.125), block(0.25, 0, 0, 0.125)]);
  try {
    const gap = { minX: 0.15, maxX: 0.2, minY: 0.01, maxY: 0.1, minZ: 0.01, maxZ: 0.1 };
    const origin = new THREE.Vector3(0.175, 0.06, -1);
    const direction = new THREE.Vector3(0, 0, 1);
    assert.equal(c.queryCollisionWorldAABBs(gap).length, 0);
    assert.equal(c.raycastCollisionCells(origin, direction), null);
    c.blocks.push(block(0.125, 0, 0, 0.125));
    c.rebuildAfterBlockChange();
    assert.equal(c.queryCollisionWorldAABBs(gap).length, 1);
    assert.ok(c.raycastCollisionCells(origin, direction));
    c.blocks.pop();
    c.rebuildAfterBlockChange();
    assert.equal(c.queryCollisionWorldAABBs(gap).length, 0);
    assert.equal(c.raycastCollisionCells(origin, direction), null);
  } finally { c.dispose(); }
});

test('a local player query does not expand a large building after every pose update', () => {
  const c = create(Array.from({ length: 10000 }, (_, i) => block(i % 100, 0, Math.floor(i / 100))));
  try {
    const original = c.buildCollisionWorldAABBs.bind(c);
    let expanded = 0;
    c.buildCollisionWorldAABBs = entries => { expanded += entries.length; return original(entries); };
    for (let frame = 0; frame < 20; frame++) {
      c.capturePreviousEntityTransforms();
      c.updateTransform();
      assert.ok(c.queryCollisionWorldAABBs(bounds(49.1, 0.1, 49.1)).length > 0);
    }
    assert.ok(expanded <= 80, `expanded ${expanded} cells for 20 local queries`);
  } finally { c.dispose(); }
});

function comparePick(c, origin, direction, bent, distance = 30) {
  const method = bent ? 'raycastBentCollisionCells' : 'raycastCollisionCells';
  const actual = c[method](origin, direction, distance);
  const indexed = c.raycastCandidateBlocks;
  let expected;
  try {
    c.raycastCandidateBlocks = () => c.blocks;
    expected = c[method](origin, direction, distance);
  } finally { c.raycastCandidateBlocks = indexed; }
  assert.deepEqual(actual, expected);
  return actual;
}

test('indexed flat and bent picks match exhaustive picking, including high altitude and projection cuts', () => {
  const previousMode = getWorldShapeMode();
  try {
    for (const mode of ['earth', 'torus']) {
      setWorldShapeMode(mode);
      setWorldProjectionAnchor(TORUS_SIZE_X / 2, TORUS_SIZE_Z / 2, true);
      for (const position of [new THREE.Vector3(7450, 16, 580), new THREE.Vector3(7450, 1600, 580),
        new THREE.Vector3(-1, 40, -1)]) {
        const c = create(Array.from({ length: 64 }, (_, i) => block(i % 8, (i % 3) * 0.25,
          Math.floor(i / 8), i % 2 ? 0.125 : 1)), position);
        try {
          c.quaternion.setFromEuler(new THREE.Euler(0.2, 0.7, -0.15));
          c.updateTransform();
          let hits = 0;
          for (let i = 0; i < c.blocks.length; i += 3) {
            const b = c.blocks[i];
            const node = c.entityNodes.get('root');
            const target = new THREE.Vector3(b.localX, b.localY, b.localZ).addScalar(b.size / 2)
              .sub(node.pivotLocal).applyMatrix4(node.group.matrixWorld);
            const origin = target.clone().add(new THREE.Vector3(1, 8, -2));
            const bo = bendPoint(origin.x, origin.y, origin.z);
            const bt = bendPoint(target.x, target.y, target.z);
            comparePick(c, origin, target.clone().sub(origin).normalize(), false);
            if (comparePick(c, bo, bt.sub(bo).normalize(), true)) hits++;
          }
          assert.ok(hits > 0, `${mode}: rays must actually hit geometry`);
          const missOrigin = position.clone().addScalar(100);
          assert.equal(comparePick(c, missOrigin, new THREE.Vector3(0, 1, 0), false), null);
        } finally { c.dispose(); }
      }
    }
  } finally { setWorldShapeMode(previousMode); }
});

test('bent broadphase spheres contain projected points over large and tall bounds', () => {
  const previousMode = getWorldShapeMode();
  try {
    for (const mode of ['earth', 'torus']) {
      setWorldShapeMode(mode);
      setWorldProjectionAnchor(TORUS_SIZE_X / 2, TORUS_SIZE_Z / 2, true);
      for (const query of [bounds(7400, -600, 500, 100), bounds(4000, 1800, 300, 200), bounds(-1, 30, -1, 5)]) {
        query.maxY = query.minY + 300;
        const sphere = computeBentBoundsSphere(query);
        for (let ix = 0; ix <= 4; ix++) for (let iy = 0; iy <= 4; iy++) for (let iz = 0; iz <= 4; iz++) {
          const point = bendPoint(query.minX + ix / 4 * (query.maxX - query.minX),
            query.minY + iy / 4 * (query.maxY - query.minY), query.minZ + iz / 4 * (query.maxZ - query.minZ));
          assert.ok(sphere.containsPoint(point), `${mode}: projected point outside conservative bounds`);
        }
      }
    }
  } finally { setWorldShapeMode(previousMode); }
});

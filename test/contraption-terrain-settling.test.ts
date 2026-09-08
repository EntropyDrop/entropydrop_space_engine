import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function makeFloorWorld() {
  return {
    getBlock: (_x, y, _z) => y <= 0 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    raycast: () => ({ hit: false, distance: 0 }),
    raycastMicro: () => ({ hit: false, distance: 0 }),
    microVoxels: { get: () => null }
  };
}

function makeSingleBlockWorld() {
  return {
    getBlock: (x, y, z) => (x === 0 && y === 0 && z === 0)
      ? BlockTypes.COLOR_BLOCK
      : BlockTypes.AIR,
    raycast: (origin, direction, maxDistance) => {
      if (!(direction.y < -1e-8) || origin.y <= 1) return { hit: false };
      const distance = (1 - origin.y) / direction.y;
      if (!(distance >= 0 && distance <= maxDistance)) return { hit: false };
      const x = origin.x + direction.x * distance;
      const z = origin.z + direction.z * distance;
      return x >= -1e-8 && x <= 1 + 1e-8 && z >= -1e-8 && z <= 1 + 1e-8
        ? { hit: true, distance, normal: { x: 0, y: 1, z: 0 } }
        : { hit: false };
    },
    raycastMicro: () => ({ hit: false, distance: 0 }),
    microVoxels: { get: () => null }
  };
}

function orientedUnitBlockPenetration(center, quaternion, box) {
  const bodyAxes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion),
    new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion),
    new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
  ];
  const terrainAxes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)
  ];
  const terrainCenter = new THREE.Vector3(
    (box.minX + box.maxX) / 2,
    (box.minY + box.maxY) / 2,
    (box.minZ + box.maxZ) / 2
  );
  const terrainHalf = new THREE.Vector3(
    (box.maxX - box.minX) / 2,
    (box.maxY - box.minY) / 2,
    (box.maxZ - box.minZ) / 2
  );
  const axes = [...bodyAxes, ...terrainAxes];
  for (const bodyAxis of bodyAxes) {
    for (const terrainAxis of terrainAxes) {
      const cross = new THREE.Vector3().crossVectors(bodyAxis, terrainAxis);
      if (cross.lengthSq() > 1e-10) axes.push(cross);
    }
  }

  const delta = center.clone().sub(terrainCenter);
  let penetration = Infinity;
  for (const rawAxis of axes) {
    const axis = rawAxis.clone().normalize();
    const bodyRadius = bodyAxes.reduce((sum, bodyAxis) => (
      sum + 0.5 * Math.abs(bodyAxis.dot(axis))
    ), 0);
    const terrainRadius = terrainHalf.x * Math.abs(axis.x)
      + terrainHalf.y * Math.abs(axis.y)
      + terrainHalf.z * Math.abs(axis.z);
    const overlap = bodyRadius + terrainRadius - Math.abs(delta.dot(axis));
    if (overlap <= 0) return 0;
    penetration = Math.min(penetration, overlap);
  }
  return penetration;
}

test('a block dropped from height settles on one terrain block without embedding', () => {
  const contraption = new Contraption(
    0,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0, 20, 0),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01 }
  );
  const physics = new ContraptionPhysics(makeSingleBlockWorld() as any);
  let minimumBottom = Infinity;

  for (let tick = 0; tick < 200; tick++) {
    physics.update(contraption, 0.05);
    minimumBottom = Math.min(minimumBottom, contraption.getCollisionWorldAABBs()[0].currentMinY);
  }

  assert.ok(minimumBottom > 0.98, `falling body must not embed into the terrain block, bottom=${minimumBottom}`);
  assert.ok(Math.abs(contraption.position.y - 1.5) < 0.02, `falling body should rest on the terrain block, y=${contraption.position.y}`);
  assert.ok(Math.abs(contraption.velocity.y) < 0.05, `resting vertical velocity should be near zero, vy=${contraption.velocity.y}`);
});

test('a tilted dynamic block topples onto a stable face under gravity', () => {
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 5, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC }
  );
  // Near-edge balance used to expose the worst slow-motion case: the block
  // could spend more than 20 seconds creeping away from this pose.
  contraption.quaternion.setFromEuler(new THREE.Euler(0.1, 0, 0.78));

  const physics = new ContraptionPhysics(makeFloorWorld() as any);
  const faceAlignment = () => Math.max(
    Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(contraption.quaternion).y),
    Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(contraption.quaternion).y),
    Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(contraption.quaternion).y)
  );

  let stableFrame = null;
  for (let tick = 0; tick < 200; tick++) {
    physics.update(contraption, 0.05);
    if (stableFrame === null && faceAlignment() > 0.995) stableFrame = tick + 1;
  }

  assert.ok(stableFrame !== null && stableFrame <= 80, `the block should topple within 4 seconds, tick=${stableFrame}`);
  assert.ok(faceAlignment() > 0.995, `one block face should settle parallel to the floor, alignment=${faceAlignment()}`);
  assert.ok(contraption.isOnGround, 'the settled block should remain supported by terrain');
  assert.ok(contraption.angularVelocity.length() < 0.03, 'the settled block should stop rotating');
});

test('low restitution settles a long body without repeated launch bounces', () => {
  const blocks = [0, 1, 2].map(localX => ({
    localX,
    localY: 0,
    localZ: 0,
    block: BlockTypes.COLOR_BLOCK
  }));
  const contraption = new Contraption(
    2,
    blocks,
    new THREE.Vector3(10, 5, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01 }
  );
  contraption.quaternion.setFromEuler(new THREE.Euler(0.4, 0, 0.7));

  const physics = new ContraptionPhysics(makeFloorWorld() as any);
  let firstGroundHeight = null;
  let leftGroundCount = 0;
  let wasOnGround = false;
  let maxRiseAfterContact = 0;
  for (let tick = 0; tick < 200; tick++) {
    physics.update(contraption, 0.05);
    if (contraption.isOnGround && firstGroundHeight === null) firstGroundHeight = contraption.position.y;
    if (wasOnGround && !contraption.isOnGround) leftGroundCount++;
    if (firstGroundHeight !== null) {
      maxRiseAfterContact = Math.max(maxRiseAfterContact, contraption.position.y - firstGroundHeight);
    }
    wasOnGround = contraption.isOnGround;
  }

  // During the initial topple, individual fixed updates may alternate between
  // edge contact and a sub-millimetre separation. The launch-energy bound is
  // the meaningful bounce regression; the contact flag must still settle.
  assert.ok(leftGroundCount < 10, `contact should converge instead of chattering indefinitely, count=${leftGroundCount}`);
  assert.ok(maxRiseAfterContact < 0.25, `settling must not inject launch energy, rise=${maxRiseAfterContact}`);
  assert.ok(contraption.isOnGround, 'the long body should finish on the floor');
  assert.ok(contraption.velocity.length() < 0.05, 'the long body should finish without linear bounce');
});

test('terrain wall collision resolves sideways without climbing or frame rewind', () => {
  const wallWorld = {
    getBlock: (x, y, _z) => (y <= 0 || (x === 12 && y <= 4))
      ? BlockTypes.COLOR_BLOCK
      : BlockTypes.AIR,
    raycast: () => ({ hit: false, distance: 0 }),
    raycastMicro: () => ({ hit: false, distance: 0 }),
    microVoxels: { get: () => null }
  };
  const contraption = new Contraption(
    3,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 1, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01, friction: 0 }
  );
  contraption.velocity.x = 20;

  const physics = new ContraptionPhysics(wallWorld as any);
  let maxX = contraption.position.x;
  let maxY = contraption.position.y;
  let maxVerticalFrameStep = 0;
  let previousY = contraption.position.y;
  for (let frame = 0; frame < 180; frame++) {
    physics.update(contraption, 1 / 60);
    maxX = Math.max(maxX, contraption.position.x);
    maxY = Math.max(maxY, contraption.position.y);
    maxVerticalFrameStep = Math.max(maxVerticalFrameStep, Math.abs(contraption.position.y - previousY));
    previousY = contraption.position.y;
  }

  assert.ok(maxX < 11.55, `the body must not tunnel through the wall, maxX=${maxX}`);
  assert.ok(maxY < 2, `a side collision must not climb the wall, maxY=${maxY}`);
  assert.ok(maxVerticalFrameStep < 0.2, `collision correction must not jump between frame histories, step=${maxVerticalFrameStep}`);
  assert.ok(Math.abs(contraption.position.y - 1.5) < 0.02, 'the body should settle back on the floor');
});

test('terrain collision sweeps across a standard wall during a stalled frame', () => {
  const wallX = 12;
  const wallWorld = {
    getBlock: (x) => x === wallX ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    raycast: (origin, direction, maxDistance) => {
      if (!(direction.x > 0) || origin.x >= wallX) return { hit: false };
      const distance = (wallX - origin.x) / direction.x;
      return distance <= maxDistance
        ? { hit: true, distance, normal: { x: -1, y: 0, z: 0 } }
        : { hit: false };
    },
    raycastMicro: () => ({ hit: false }),
    microVoxels: { get: () => null }
  };
  // 25m/s ends a sub-step deep inside the wall; 60m/s skips the whole voxel.
  // Both must use the entry face instead of choosing the nearer exit face.
  for (const speed of [25, 60]) {
    const contraption = new Contraption(
      5,
      [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
      new THREE.Vector3(10, 1, 10),
      new THREE.Scene(),
      { bodyType: BodyType.DYNAMIC, restitution: 0.01, friction: 0 }
    );
    contraption.useGravity = false;
    contraption.velocity.x = speed;

    new ContraptionPhysics(wallWorld as any).update(contraption, 0.08);

    assert.ok(contraption.position.x < 11.55, `the body must stop at the swept wall at ${speed}m/s, x=${contraption.position.x}`);
    assert.ok(contraption.velocity.x < 1, `the wall must cancel ${speed}m/s approaching velocity, vx=${contraption.velocity.x}`);
  }
});

test('terrain collision sweeps across a 0.125m micro wall', () => {
  const wallX = 12;
  const wallMicroX = wallX * 5;
  const wallWorld = {
    getBlock: () => BlockTypes.AIR,
    getMicroBlock: (mx) => mx === wallMicroX ? { block: BlockTypes.COLOR_BLOCK } : null,
    raycast: () => ({ hit: false }),
    raycastMicro: (origin, direction, maxDistance) => {
      if (!(direction.x > 0) || origin.x >= wallX) return { hit: false };
      const distance = (wallX - origin.x) / direction.x;
      return distance <= maxDistance
        ? { hit: true, distance, normal: { x: -1, y: 0, z: 0 } }
        : { hit: false };
    },
    microVoxels: { get: () => null }
  };
  const contraption = new Contraption(
    6,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 1, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01, friction: 0 }
  );
  contraption.useGravity = false;
  contraption.velocity.x = 20;

  new ContraptionPhysics(wallWorld as any).update(contraption, 0.08);

  assert.ok(contraption.position.x < 11.55, `the body must not skip the micro wall, x=${contraption.position.x}`);
  assert.ok(contraption.velocity.x <= 0, `the micro wall must cancel approaching velocity, vx=${contraption.velocity.x}`);
});

test('persistent high force cannot push a dynamic body through terrain', () => {
  const wallX = 12;
  const wallWorld = {
    getBlock: (x) => x === wallX ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    raycast: (origin, direction, maxDistance) => {
      if (!(direction.x > 0) || origin.x >= wallX) return { hit: false };
      const distance = (wallX - origin.x) / direction.x;
      return distance <= maxDistance
        ? { hit: true, distance, normal: { x: -1, y: 0, z: 0 } }
        : { hit: false };
    },
    raycastMicro: () => ({ hit: false }),
    microVoxels: { get: () => null }
  };
  const contraption = new Contraption(
    7,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 1, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0, friction: 0 }
  );
  contraption.useGravity = false;
  const physics = new ContraptionPhysics(wallWorld as any);
  let maxX = contraption.position.x;
  for (let frame = 0; frame < 120; frame++) {
    contraption.appliedForces.set(1_000_000, 0, 0);
    physics.update(contraption, 1 / 60);
    maxX = Math.max(maxX, contraption.position.x);
  }

  assert.ok(maxX < 11.51, `continuous force must not tunnel through the wall, maxX=${maxX}`);
});

test('physics uses the same three substeps for fast angular motion', () => {
  const contraption = new Contraption(
    8,
    [0, 1, 2, 3].map(localX => ({
      localX,
      localY: 0,
      localZ: 0,
      block: BlockTypes.COLOR_BLOCK
    })),
    new THREE.Vector3(10, 8, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC }
  );
  contraption.useGravity = false;
  contraption.angularVelocity.set(0, 80, 0);
  const physics = new ContraptionPhysics({
    getBlock: () => BlockTypes.AIR,
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false }),
    microVoxels: { get: () => null }
  } as any) as any;
  const resolveTerrainCollisionBody = physics.resolveTerrainCollisionBody.bind(physics);
  let collisionSubsteps = 0;
  physics.resolveTerrainCollisionBody = (...args) => {
    collisionSubsteps++;
    return resolveTerrainCollisionBody(...args);
  };

  physics.update(contraption, 0.08);

  assert.equal(collisionSubsteps, 3);
});

test('resting terrain contact remains stable across physics frames', () => {
  const contraption = new Contraption(
    4,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(10, 1, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01 }
  );
  const physics = new ContraptionPhysics(makeFloorWorld() as any);
  for (let frame = 0; frame < 180; frame++) physics.update(contraption, 1 / 60);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let frame = 0; frame < 180; frame++) {
    physics.update(contraption, 1 / 60);
    assert.ok(contraption.isOnGround, `grounded state must not flicker at frame ${frame}`);
    minY = Math.min(minY, contraption.position.y);
    maxY = Math.max(maxY, contraption.position.y);
  }
  assert.ok(maxY - minY < 0.01, `resting pose should not jitter, range=${maxY - minY}`);
});

test('terrain contact at points exactly on voxel seams reports the exposed shell face', () => {
  // A 45-degree tilted block rides the seam between two floor voxels: its
  // sample points land exactly on the shared face plane where penetration is
  // zero. The contact search used to abort there and report "no contact",
  // letting the block tunnel straight through the floor surface.
  const physics = new ContraptionPhysics(makeFloorWorld() as any);

  const seamPoint = new THREE.Vector3(5, -0.4, 7);
  const contact = physics.terrainContactAtPoint(seamPoint);
  assert.ok(contact, 'a boundary point inside solid terrain must still produce a contact');
  assert.ok(contact.normal.y > 0.5, `the contact must escape through the surface, normal=(${contact.normal.x},${contact.normal.y},${contact.normal.z})`);
  assert.ok(Math.abs(contact.penetration - 0.4) < 0.01, `the contact must carry the real depth, penetration=${contact.penetration}`);
});

test('a tilted block falling onto a voxel seam must not wedge inside the terrain', () => {
  // Regression for the classic "tilted block gets stuck in blocks" report:
  // with its centre exactly on the seam (an integer coordinate) and corners
  // rotated onto the boundary planes, every contact used to be reported as
  // null, the block tunnelled half a unit into the floor and locked there.
  // Origin + the 0.5 local centre offset puts the physics position exactly on
  // the voxel seam x=10, so the rotated corners ride the boundary planes.
  const contraption = new Contraption(
    9,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(9.5, 6.0, 9.5),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01 }
  );
  contraption.quaternion.setFromEuler(new THREE.Euler(0, 0, Math.PI / 4));

  const physics = new ContraptionPhysics(makeFloorWorld() as any);
  let deepestBottom = Infinity;
  for (let tick = 0; tick < 200; tick++) {
    physics.update(contraption, 0.05);
    const bottom = Math.min(...contraption.getCollisionWorldAABBs().map(box => box.currentMinY));
    deepestBottom = Math.min(deepestBottom, bottom);
  }

  assert.ok(deepestBottom > 0.9, `the block must never embed into the floor, deepest bottom=${deepestBottom.toFixed(3)}`);
  assert.ok(Math.abs(contraption.position.y - 1.5) < 0.05, `the block should rest on the floor surface, y=${contraption.position.y.toFixed(3)}`);
  const faceAlignment = Math.max(
    Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(contraption.quaternion).y),
    Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(contraption.quaternion).y),
    Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(contraption.quaternion).y)
  );
  assert.ok(faceAlignment > 0.995, `the block should settle on a face, not balance on the seam edge, alignment=${faceAlignment.toFixed(3)}`);
});

test('a yaw-rotated block wedged into a pillar corner is pushed back out', () => {
  // Regression: point sampling cannot see a rotated box's bottom edge slicing
  // a pillar voxel's top corner, so the block rested with part of its volume
  // inside the pillar. Exact OBB-vs-AABB contact detects that overlap.
  const pillarWorld = {
    getBlock: (x, y, z) => (y <= 0 || (x === 1 && z === 1 && y <= 2))
      ? BlockTypes.COLOR_BLOCK
      : BlockTypes.AIR,
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false }),
    microVoxels: { get: () => null }
  };
  const contraption = new Contraption(
    10,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(2.258, 1.499, 1.801),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01 }
  );
  contraption.quaternion.setFromEuler(new THREE.Euler(0, -0.415, 0));

  const physics = new ContraptionPhysics(pillarWorld as any);
  for (let frame = 0; frame < 600; frame++) physics.update(contraption, 1 / 60);

  let inside = 0;
  let total = 0;
  for (const cell of contraption.collisionEntries) {
    const span = cell.span * 0.2;
    const x0 = cell.x * 0.2, y0 = cell.y * 0.2, z0 = cell.z * 0.2;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          const p = contraption.entityLocalToWorld(cell.entityId, new THREE.Vector3(
            x0 + (i + 0.5) * span / 4,
            y0 + (j + 0.5) * span / 4,
            z0 + (k + 0.5) * span / 4
          ));
          total++;
          if (pillarWorld.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) !== BlockTypes.AIR) inside++;
        }
      }
    }
  }
  const embedded = inside / total;
  assert.ok(embedded < 0.01, `the block must escape the pillar, embedded volume=${(embedded * 100).toFixed(1)}%`);
  assert.ok(contraption.isOnGround, 'the escaped block should rest supported by the floor');
});

test('a terrain edge cannot pierce the face of a falling tilted block', () => {
  // In the X/Y cross-section, the terrain block's top-right corner enters the
  // interior of the falling block's lower-left edge. In 3D this is an entire
  // terrain edge piercing an OBB face. None of the falling block's sampled
  // vertices, edge midpoints, or face centers need be inside the terrain, so
  // point-only collision detection allows roughly 0.2m of penetration.
  const contraption = new Contraption(
    11,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(0.6, 4.5, 0),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC, restitution: 0.01 }
  );
  contraption.quaternion.setFromEuler(new THREE.Euler(0, 0, 0.25));

  const physics = new ContraptionPhysics(makeSingleBlockWorld() as any);
  const terrainBox = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
  let maximumPenetration = 0;
  for (let frame = 0; frame < 120; frame++) {
    physics.update(contraption, 1 / 60);
    maximumPenetration = Math.max(
      maximumPenetration,
      orientedUnitBlockPenetration(contraption.position, contraption.quaternion, terrainBox)
    );
  }

  assert.ok(
    maximumPenetration < 0.03,
    `the terrain edge must not enter the falling block face, penetration=${maximumPenetration.toFixed(3)}`
  );
});

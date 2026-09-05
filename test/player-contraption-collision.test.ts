import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption, ContraptionMode } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { PlayerPhysics } from '../src/physics/PlayerPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function createSingleCellContraption() {
  return new Contraption(
    1,
    [{
      localX: 0,
      localY: 0,
      localZ: 0,
      size: 1,
      block: BlockTypes.COLOR_BLOCK,
      color: 0xffffff,
      entityId: 'root'
    }],
    new THREE.Vector3(0, 0, 0),
    new THREE.Scene()
  );
}

function createPlayer(contraption) {
  const world = {
    getBlock: () => BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  };
  return new PlayerPhysics(world, { contraptions: [contraption] }) as any;
}

test('each entity collision cell exposes its own transformed world AABB', () => {
  const contraption = createSingleCellContraption();
  const [box] = contraption.getCollisionWorldAABBs();

  assert.equal(contraption.getCollisionWorldAABBs().length, 1);
  assert.deepEqual(
    [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ],
    [0, 0, 0, 1, 1, 1]
  );
});

test('swept entity collision blocks a player crossing a full cell in one frame', () => {
  const contraption = createSingleCellContraption();
  const player = createPlayer(contraption);
  player.position.set(-2, 0.1, 0.5);
  player.velocity.set(30, 0, 0);

  player.moveWithCollision(0.1);

  assert.ok(Math.abs(player.position.x - (-0.3)) < 1e-9);
  assert.equal(player.velocity.x, 0);
  assert.equal(player.position.y, 0.1);
});

test('side overlap is resolved horizontally without automatic climbing', () => {
  const contraption = createSingleCellContraption();
  const player = createPlayer(contraption);
  player.position.set(-0.1, 0.1, 0.5);
  player.velocity.set(0, 0, 0);

  const moved = player.resolveDynamicContraptionOverlaps();

  assert.equal(moved, true);
  assert.ok(player.position.x < -0.3);
  assert.equal(player.position.y, 0.1);
});

test('touching an adjacent one-block step never lifts the player onto it', () => {
  const solids = new Set([
    '-1,0,0', // floor under the player
    '0,1,0'   // one-block-high step touching the player's right side
  ]);
  const world = {
    getBlock: (x, y, z) => solids.has(`${x},${y},${z}`)
      ? BlockTypes.COLOR_BLOCK
      : BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  };
  const player = new PlayerPhysics(world, { contraptions: [] }) as any;
  player.position.set(-0.3, 1, 0.5);
  player.velocity.set(0, -1, 0);

  // Gravity while exactly touching the step used to classify its top as
  // ground and teleport the player from y=1 to y=2.
  player.moveWithCollision(0.01);
  assert.equal(player.position.y, 1);

  // Walking into the step must remain a horizontal block, not auto-step.
  player.velocity.set(2, -1, 0);
  player.moveWithCollision(0.1);
  assert.equal(player.position.y, 1);
  assert.ok(Math.abs(player.position.x - (-0.3)) < 1e-9);
});

test('restoring inside terrain raises the player to the first free spawn height', () => {
  const solids = new Set([
    '0,0,0',
    '0,1,0',
    '0,2,0'
  ]);
  let prepared = null;
  const world = {
    preparePlayerSpawnArea(x, z, halfWidth) {
      prepared = { x, z, halfWidth };
    },
    getBlock: (x, y, z) => solids.has(`${x},${y},${z}`)
      ? BlockTypes.COLOR_BLOCK
      : BlockTypes.AIR,
    getMicroBlocksInAABB: () => []
  };
  const player = new PlayerPhysics(world as any, { contraptions: [] }) as any;

  const raised = player.setInitialPosition(0.5, -4, 0.5);

  assert.equal(raised, true);
  assert.deepEqual(prepared, { x: 0.5, z: 0.5, halfWidth: 0.3 });
  assert.equal(player.position.y, 3);
  assert.equal(player.velocity.lengthSq(), 0);
  assert.equal(player.getIntersectingSolidBlocks(player.getAABB()).length, 0);
});

test('near-top side contact with an entity does not use landing tolerance to climb', () => {
  const contraption = createSingleCellContraption();
  const player = createPlayer(contraption);
  player.position.set(-0.1, 0.95, 0.5);
  player.velocity.set(0, -0.1, 0);

  player.moveWithCollision(0.1);

  assert.ok(player.position.y < 0.95);
  assert.equal(player.isOnGround, false);
});

test('a downward face crossing still lands on top of an entity cell', () => {
  const contraption = createSingleCellContraption();
  const player = createPlayer(contraption);
  player.position.set(0.5, 1.2, 0.5);
  player.velocity.set(0, -4, 0);

  player.moveWithCollision(0.1);

  assert.equal(player.position.y, 1);
  assert.equal(player.velocity.y, 0);
  assert.equal(player.isOnGround, true);
  assert.equal(player.ridingContraption, contraption);
  const contact = contraption.pendingScriptContacts.find(item => item.kind === 'player');
  assert.ok(contact, 'player collision should be available to the entity script snapshot');
  assert.equal(contact.playerId, 'local');
  assert.equal(contact.selfNodeId, 'root');
  assert.deepEqual(contact.normal, [0, -1, 0]);
  assert.ok(contact.impulse > 0);
});

// ===========================================================================
// A standing player should not be pushed off by an entity's instantaneous collision correction.
// ===========================================================================

function standingPlayerOn(contraption) {
  const player = createPlayer(contraption);
  player.ridingContraption = contraption;
  player.isOnGround = true;
  // Stand at the center of a one-cell entity whose top face is y=1.
  player.position.set(0.5, 1.0, 0.5);
  player.velocity.set(0, 0, 0);
  return player;
}

test('an upward entity correction lifts the player to the top instead of pushing sideways', () => {
  const contraption = createSingleCellContraption();
  const player = standingPlayerOn(contraption);

  // Raise the top by 0.1 through position correction rather than velocity.
  contraption.position.y += 0.1;
  contraption.updateTransform();

  const moved = player.resolveDynamicContraptionOverlaps();

  assert.equal(moved, true);
  assert.ok(Math.abs(player.position.y - 1.1) < 1e-6, 'player should be lifted to top y=1.1');
  assert.equal(player.position.x, 0.5, 'player must not be pushed sideways');
  assert.equal(player.position.z, 0.5, 'player must not be pushed sideways');
  assert.equal(player.ridingContraption, contraption, 'riding state must remain active');
  assert.equal(player.isOnGround, true);
});

test('a player remains stable across frames while an entity rises slowly', () => {
  const contraption = createSingleCellContraption();
  const player = standingPlayerOn(contraption);

  for (let frame = 0; frame < 60; frame++) {
    // Simulate a 2 mm upward terrain-collision correction each frame.
    contraption.position.y += 0.002;
    contraption.updateTransform();
    player.resolveDynamicContraptionOverlaps();
    const expectedTop = 1.0 + (frame + 1) * 0.002;
    assert.ok(Math.abs(player.position.y - expectedTop) < 1e-6,
      `frame ${frame}: player should remain on top at y=${expectedTop.toFixed(3)}`);
    assert.equal(player.ridingContraption, contraption, 'riding state must remain active');
  }
});

test('deep penetration after entity teleport still resolves horizontally', () => {
  const contraption = createSingleCellContraption();
  const player = standingPlayerOn(contraption);

  // Raise the entity by 1.0, above STAND_TOLERANCE, burying half the player.
  contraption.position.y += 1.0;
  contraption.updateTransform();

  const moved = player.resolveDynamicContraptionOverlaps();

  assert.equal(moved, true);
  assert.ok(player.position.x !== 0.5 || player.position.z !== 0.5, 'deep penetration should move the player horizontally');
});

// ===========================================================================
// Player shoves a kinematic component of an entity: the impulse must route to
// the entity's dynamic body (the component's nearest dynamic ancestor), not be
// dropped because the component body itself is kinematic.
// ===========================================================================

test('a shove on a kinematic component routes its impulse to the entity dynamic body', () => {
  const world = {
    getBlock: () => BlockTypes.AIR,
    getMicroBlocksInAABB: () => [],
    activeChunkKeys: new Set(['0,0']),
    worldToChunkCoords: (x, z) => ({ cx: Math.floor(x / 16), cz: Math.floor(z / 16) }),
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false })
  };
  const physics = new ContraptionPhysics(world);
  const manager = new ContraptionManager(new THREE.Scene(), world, null, null);
  manager.setPhysics(physics);

  const reacher = new Contraption(
    1,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 4, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'arm' }
    ],
    new THREE.Vector3(0, 0, 0),
    manager.scene,
    {
      mode: ContraptionMode.FREE_PHYSICS,
      bodyType: BodyType.DYNAMIC,
      childEntities: [{ id: 'arm', parentId: 'root', bodyType: BodyType.KINEMATIC }]
    }
  );
  manager.registerContraption(reacher);

  const armBody = reacher.getRigidBody('arm');
  assert.equal(armBody.type, BodyType.KINEMATIC, 'test setup: the arm must be kinematic');

  const player = new PlayerPhysics(world, manager) as any;
  const impulse = new THREE.Vector3(20, 0, 0);
  const contactPoint = new THREE.Vector3(4.5, 0.5, 0.5);
  const applied = player.applyContraptionImpulse(reacher, 'arm', impulse, contactPoint);

  assert.equal(applied, true, 'the impulse must not be dropped for a kinematic component');
  const rootBody = reacher.getRigidBody('root');
  assert.ok(rootBody.velocity.x > 0, `the dynamic root must receive the shove, vx=${rootBody.velocity.x}`);
});

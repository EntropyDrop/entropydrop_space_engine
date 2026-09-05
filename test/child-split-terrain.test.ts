import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

/**
 * Child-component split regression: when a subset of an entity's blocks
 * becomes a child component, the remaining root body must keep its support.
 *
 * Before the fix, the terrain pass sampled only the root body's own
 * collision cells. A kinematic child's cells move with the root body (scene
 * graph parent), so a split that took the root's ground-contact layer left
 * the root falling straight through the child and into the terrain
 * ("root sinking and clipping terrain when creating child component").
 *
 * The fix exercised here: terrain contact of a dynamic body now includes
 * every kinematic part rigidly attached to it
 * (getCollisionSamplePoints(bodyId, includeAttached)). Before the fix a
 * split that took the root's support cells away left the structure
 * unsupported even though its attached child still occupied the contact
 * layer.
 */

const FLOOR_TOP = 5; // solid terrain for y <= 4

function makeFloorWorld() {
  return {
    getBlock: (x, y, z) => (y <= 4 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR),
    raycast: () => ({ hit: false, distance: 0 }),
    raycastMicro: () => ({ hit: false, distance: 0 }),
    microVoxels: { get: () => null }
  };
}

function makeCubeBlocks() {
  const blocks = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    blocks.push({ localX: x, localY: y, localZ: z, block: BlockTypes.COLOR_BLOCK, entityId: 'root' });
  }
  return blocks;
}

function stepEntity(contraption, physics, dt, frames) {
  for (let i = 0; i < frames; i++) {
    const ctx = {
      entityId: contraption.id,
      root: contraption.scriptApi,
      time: 0,
      deltaTime: dt,
      tick: i,
      position: contraption.position,
      velocity: contraption.velocity,
      rotation: [0, 0, 0],
      angularVelocity: contraption.angularVelocity,
      groundDistance: 0,
      mass: contraption.mass,
      bodyType: contraption.bodyType,
      gravity: [0, -18, 0],
      limits: {},
      input: {},
      blocks: { pressed: () => false },
      players: [],
      world: null,
      selection: null,
      log: () => {}
    };
    contraption.update(dt, null, ctx);
    physics.update(contraption, dt);
  }
}

test('root keeps resting on its split-off kinematic bottom layer (no sink/clip)', () => {
  const physics = new ContraptionPhysics(makeFloorWorld());
  const c = new Contraption(
    1,
    makeCubeBlocks(),
    new THREE.Vector3(10, FLOOR_TOP, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC }
  ) as any;
  c.scriptStatus = 'stopped';

  stepEntity(c, physics, 1 / 60, 120);
  assert.ok(Math.abs(c.position.y - (FLOOR_TOP + 1)) < 0.05, `entity should settle just above the floor, got ${c.position.y}`);

  // The BOTTOM layer (the ground-contact layer) becomes a kinematic child.
  const child = c.createChildEntity('root', new Set(['0,0,0', '1,0,0', '0,0,1', '1,0,1']), 'base');
  assert.ok(child, 'child component should be created');
  assert.equal(c.getRigidBody('base').type, BodyType.KINEMATIC);

  stepEntity(c, physics, 1 / 60, 300);

  // Before the fix the root fell through the child and the floor (y -> -50+).
  assert.ok(c.position.y > FLOOR_TOP, `root must not sink below its rest height, got ${c.position.y}`);
  assert.ok(c.getRigidBody('base').position.y > FLOOR_TOP, `child must not sink below its authored height, got ${c.getRigidBody('base').position.y}`);
});

test('splitting the TOP layer leaves the resting root untouched', () => {
  const physics = new ContraptionPhysics(makeFloorWorld());
  const c = new Contraption(
    1,
    makeCubeBlocks(),
    new THREE.Vector3(10, FLOOR_TOP, 10),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC }
  ) as any;
  c.scriptStatus = 'stopped';

  stepEntity(c, physics, 1 / 60, 120);
  const settledY = c.position.y;

  c.createChildEntity('root', new Set(['0,1,0', '1,1,0', '0,1,1', '1,1,1']), 'roof');
  stepEntity(c, physics, 1 / 60, 300);

  assert.ok(Math.abs(c.position.y - settledY) < 0.05, `root must keep resting, ${settledY} -> ${c.position.y}`);
});

test('getAttachedNodeIds includes kinematic descendants but not dynamic ones', () => {
  const c = new Contraption(
    1,
    makeCubeBlocks(),
    new THREE.Vector3(0, 0, 0),
    new THREE.Scene(),
    { bodyType: BodyType.DYNAMIC }
  ) as any;

  const bottom = c.createChildEntity('root', new Set(['0,0,0', '0,0,1']), 'base');
  const roof = c.createChildEntity('root', new Set(['1,1,1']), 'roof');
  // Kinematic child of the kinematic base -> attached to the root chain.
  const beam = c.createChildEntity('base', new Set(['0,0,0']), 'beam');
  assert.ok(bottom && roof && beam, 'all three child components should be created');
  // Make the roof DYNAMIC -> it moves on its own and must not count as attached.
  c.childDefinitions.get(roof.id).bodyType = BodyType.DYNAMIC;
  c.rebuildEntityHierarchy();

  const attached = c.getAttachedNodeIds('root');
  assert.ok(attached.has('root'));
  assert.ok(attached.has('base'));
  assert.ok(attached.has('beam'), 'kinematic descendant of a kinematic child stays attached');
  assert.ok(!attached.has(roof.id), 'dynamic children are not rigidly attached to the root body');

  const roofAttached = c.getAttachedNodeIds(roof.id);
  assert.ok(roofAttached.has(roof.id));
  assert.equal(roofAttached.size, 1, 'the dynamic roof has no attached parts of its own');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function setup(floor = false) {
  const world = {
    terrainVersion: 0, floor,
    getBlock: (_x, y, _z) => world.floor && y <= 0 ? BlockTypes.COLOR_BLOCK : BlockTypes.AIR,
    getMicroBlocksInAABB: () => [],
    raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }),
  };
  const scene = new THREE.Scene();
  const physics = new ContraptionPhysics(world as any) as any;
  const manager = new ContraptionManager(scene, world as any, null, null) as any;
  manager.setPhysics(physics);
  const add = (id = 'entity', x = 0, y = 1, gravity = floor) => {
    const entity = new Contraption(id, [{ localX: 0, localY: 0, localZ: 0,
      entityId: 'root', block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(x, y, 0), scene) as any;
    entity.useGravity = gravity;
    manager.registerContraption(entity);
    return entity;
  };
  const tick = (count = 1) => { for (let i = 0; i < count; i++) manager.update(0.05, null); };
  return { world, manager, physics, add, tick };
}

test('settled bodies sleep, skip terrain and pair work, and retain their collision geometry', () => {
  const { physics, add, tick } = setup(true);
  const entity = add();
  tick(80);
  assert.equal(physics.isSleeping(entity), true);
  const position = entity.position.clone();
  let terrainPasses = 0;
  const original = physics.resolveTerrainCollisionBody.bind(physics);
  physics.resolveTerrainCollisionBody = (...args) => { terrainPasses++; return original(...args); };
  tick(20);
  assert.equal(terrainPasses, 0);
  assert.deepEqual(entity.position, position);
  assert.equal(entity.isPhysicsSimulationEnabled(), true, 'sleep is distinct from Stop');
  assert.equal(entity.getPhysicsCollisionWorldAABBs().length, 1);
  assert.equal(physics.prepareContraptionPairFrame([entity]).collisionCandidates.length, 0);
});

test('forces, player impulses, pose edits, gravity changes and Stop/Play wake sleeping bodies', () => {
  for (const mutation of [
    (entity, physics) => entity.appliedForces.set(100, 0, 0),
    (entity, physics) => physics.applyImpulse(entity, new THREE.Vector3(5, 0, 0)),
    entity => { entity.position.x += 1; entity.updateTransform(); },
    entity => { entity.useGravity = true; },
    entity => { entity.setPhysicsSimulationEnabled(false); entity.setPhysicsSimulationEnabled(true); },
    entity => { entity.setNodeBodyMass('root', 25); },
    entity => { entity.setBodyType('kinematic'); },
    entity => { entity.setNodeCollisionEnabled('root', false); },
  ]) {
    const { physics, add, tick } = setup();
    const entity = add();
    tick(25);
    assert.equal(physics.isSleeping(entity), true);
    // Script/controller forces are sampled after entity.update clears the
    // preceding tick's command buffer, immediately before physics preparation.
    entity.update(0.05, null, {});
    mutation(entity, physics);
    physics.update(entity, 0.05);
    assert.equal(physics.isSleeping(entity), false);
  }
});

test('an impact wakes sleeping neighbours and propagates through a sleeping collision chain', () => {
  const { physics, add, tick } = setup();
  const a = add('a', 0), b = add('b', 1.01), c = add('c', 2.02);
  tick(30);
  assert.ok([a, b, c].every(entity => physics.isSleeping(entity)));
  a.velocity.x = 15;
  tick(2);
  assert.equal(physics.isSleeping(b), false);
  assert.equal(physics.isSleeping(c), false);
  assert.ok(c.velocity.x > 0 || c.position.x > 2.52);
});

test('terrain edits wake sleepers immediately and a removed floor no longer supports them', () => {
  const { world, physics, add, tick } = setup(true);
  const entity = add();
  tick(80);
  assert.equal(physics.isSleeping(entity), true);
  const before = entity.position.y;
  world.floor = false;
  world.terrainVersion++;
  tick();
  assert.equal(physics.isSleeping(entity), false);
  assert.ok(entity.position.y < before);
});

test('moving, disabling or removing a supporting entity wakes its sleeping load', () => {
  for (const change of ['move', 'disable', 'remove']) {
    const { physics, manager, add, tick } = setup();
    const support = add('support', 0, 3);
    support.setPhysicsSimulationEnabled(false);
    const load = add('load', 0, 4, true);
    tick(100);
    assert.equal(physics.isSleeping(load), true, change);
    const before = load.position.y;
    if (change === 'move') { support.position.x += 5; support.updateTransform(); }
    if (change === 'disable') support.setNodeCollisionEnabled('root', false);
    if (change === 'remove') manager.contraptions.splice(manager.contraptions.indexOf(support), 1);
    tick();
    assert.equal(physics.isSleeping(load), false, change);
    assert.ok(load.position.y < before, change);
  }
});

test('Stop excludes only stopped/stopped pairs and preserves active/stopped collisions', () => {
  const { physics, add } = setup();
  const a = add('a', 0), b = add('b', 0.8);
  a.setPhysicsSimulationEnabled(false);
  b.setPhysicsSimulationEnabled(false);
  assert.equal(physics.prepareContraptionPairFrame([a, b]).collisionCandidates.length, 0);
  const stoppedPosition = b.position.clone();
  a.setPhysicsSimulationEnabled(true);
  a.velocity.x = 3;
  physics.resolveContraptionPairs([a, b]);
  assert.ok(a.position.x < 0.5);
  assert.deepEqual(b.position, stoppedPosition);
});

test('airborne gravity bodies and hosts without terrain invalidation never sleep', () => {
  const { world, physics, add, tick } = setup();
  const flying = add('falling', 0, 100, true);
  const unversioned = add('unversioned', 5, 100);
  delete (world as any).terrainVersion;
  tick(30);
  assert.equal(physics.isSleeping(flying), false);
  assert.equal(physics.isSleeping(unversioned), false);
});

test('sleeping scripts retain tick cadence and resting contacts, then wake on script force', () => {
  const { physics, add, tick } = setup(true);
  const entity = add();
  assert.equal(entity.setScript(`
self.state.ticks = (self.state.ticks || 0) + 1;
self.state.contacts = ctx.contacts;
self.state.grounded = ctx.isOnGround;
if (self.state.kick) self.applyForce([1000, 0, 0]);
`), true);
  tick(80);
  assert.equal(physics.isSleeping(entity), true);
  const before = entity.getComponentState('root').ticks;
  tick(10);
  const state = entity.getComponentState('root');
  assert.equal(state.ticks, before + 10);
  assert.equal(state.grounded, true);
  assert.ok(state.contacts.length > 0);
  assert.ok(state.contacts.every(contact => contact.kind === 'terrain' && contact.sleeping
    && contact.impulse === 0 && contact.relativeVelocity.every(value => value === 0)));
  state.kick = true;
  tick();
  assert.equal(physics.isSleeping(entity), false);
  assert.ok(entity.velocity.x > 0);
});

test('only a local terrain stamp or local streaming change wakes a sleeping body', () => {
  const { world, physics, add, tick } = setup(true);
  const revisions = new Map([[0, 0], [2, 0]]);
  const loaded = new Set([0, 2]);
  (world as any).getTerrainCollisionStamp = bounds => {
    const chunk = Math.floor((bounds.minX + bounds.maxX) / 2 / 16);
    return [revisions.get(chunk) || 0, loaded.has(chunk)];
  };
  const local = add('local', 2), remote = add('remote', 34);
  tick(80);
  assert.ok([local, remote].every(entity => physics.isSleeping(entity)));
  revisions.set(2, 1);
  world.terrainVersion++;
  (world as any).activeChunkKeys = new Set(['0,0', '2,0', '99,99']);
  tick();
  assert.equal(physics.isSleeping(local), true, 'distant edits and window identity are irrelevant');
  assert.equal(physics.isSleeping(remote), false, 'the edited neighbourhood wakes');
  tick(30);
  loaded.delete(0);
  tick();
  assert.equal(physics.isSleeping(local), false, 'unloading local collision wakes its sleeper');
  assert.equal(physics.isSleeping(remote), true);
  tick(30);
  revisions.set(0, 1);
  world.floor = false;
  const height = local.position.y;
  tick();
  assert.equal(physics.isSleeping(local), false);
  assert.ok(local.position.y < height, 'removing local support lets the body fall');
});

test('a settled dynamic stack sleeps together and wakes when the ground changes', () => {
  const { world, physics, add, tick } = setup(true);
  const stack = [add('base', 0, 1), add('middle', 0, 2), add('top', 0, 3)];
  tick(200);
  assert.ok(stack.every(entity => physics.isSleeping(entity)),
    JSON.stringify(stack.map(entity => ({ id: entity.id, sleeping: physics.isSleeping(entity), velocity: entity.velocity.toArray() }))));
  world.floor = false;
  world.terrainVersion++;
  tick(4);
  assert.ok(stack.every(entity => !physics.isSleeping(entity)));
});


test('adding or moving a stopped collider into a sleeper wakes it before collision resolution', () => {
  for (const newlyAdded of [false, true]) {
    const { physics, add, tick } = setup();
    const sleeper = add('sleeper', 0);
    const stopped = newlyAdded ? null : add('stopped', 5);
    stopped?.setPhysicsSimulationEnabled(false);
    tick(30);
    assert.equal(physics.isSleeping(sleeper), true);
    const obstacle = stopped || add('new-stopped', 0.8);
    if (stopped) { stopped.position.x = 1.3; stopped.updateTransform(); }
    else obstacle.setPhysicsSimulationEnabled(false);
    tick();
    assert.equal(physics.isSleeping(sleeper), false);
    const a = sleeper.getPhysicsCollisionWorldAABBs()[0];
    const b = obstacle.getPhysicsCollisionWorldAABBs()[0];
    assert.ok((physics.orientedBoxPairContact(a, b)?.penetration || 0) <= 0.002);
  }
});

test('a previously sleeping support can be stopped without repeatedly waking its load', () => {
  const { physics, add, tick } = setup();
  const support = add('support', 0, 3);
  tick(30);
  assert.equal(physics.isSleeping(support), true);
  support.setPhysicsSimulationEnabled(false);
  const load = add('load', 0, 4, true);
  tick(100);
  assert.equal(physics.isSleeping(load), true);
  tick(20);
  assert.equal(physics.isSleeping(load), true);
});

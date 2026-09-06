import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function entity(id: number, children: any[] = []) {
  return new Contraption(
    id,
    [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK },
      { localX: 1, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }
    ],
    new THREE.Vector3(),
    new THREE.Scene(),
    { rootComponentId: 'root', childEntities: children }
  ) as any;
}

test('entity scripts execute in QuickJS without browser or host globals', () => {
  const contraption = entity(1);
  contraption.setScript(`
self.state.thisValue = this;
self.state.windowType = typeof window;
self.state.documentType = typeof document;
self.state.fetchType = typeof fetch;
self.state.storageType = typeof indexedDB;
self.state.workerType = typeof postMessage;
self.state.escapedWindowType = Function('return typeof window')();
`);

  contraption.update(1 / 60, null, {});
  const state = contraption.getComponentState('root');
  assert.equal(state.thisValue, undefined, 'strict QuickJS invocation must not bind the host Contraption');
  assert.equal(state.windowType, 'undefined');
  assert.equal(state.documentType, 'undefined');
  assert.equal(state.fetchType, 'undefined');
  assert.equal(state.storageType, 'undefined');
  assert.equal(state.workerType, 'undefined');
  assert.equal(state.escapedWindowType, 'undefined', 'Function constructor must remain inside the QuickJS realm');
});

test('an infinite loop is interrupted and immediately stops the whole entity', () => {
  const contraption = entity(2, [
    { id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] }
  ]);
  contraption.setNodeScript('root', 'while (true) {}');
  contraption.setNodeScript('arm', 'self.state.runs = (self.state.runs || 0) + 1;');

  const started = performance.now();
  contraption.update(1 / 60, null, {});
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 1000, `interrupt should return promptly, took ${elapsed.toFixed(1)} ms`);
  assert.equal(contraption.scriptStatus, 'error');
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.match(contraption.scriptError, /64 VM checkpoints/, 'the deterministic frame counter should trip before the wall-clock fallback');
  assert.equal(contraption.getComponentState('arm').runs, undefined);
});

test('each entity has an independent memory-limited runtime', () => {
  const abusive = entity(3);
  const healthy = entity(4);
  abusive.setScript(`self.state.data = new Array(2_000_000).fill('xxxxxxxxxxxxxxxx');`);
  healthy.setScript('self.state.runs = (self.state.runs || 0) + 1;');

  abusive.update(1 / 60, null, {});
  healthy.update(1 / 60, null, {});

  assert.equal(abusive.scriptStatus, 'error');
  assert.equal(healthy.getComponentState('root').runs, 1, 'another Entity Runtime must remain usable after OOM');
  assert.equal(healthy.isNodeScriptEnabled('root'), true);
});

test('the main-thread runtime caps components, VM checkpoints, and aggregate script time', () => {
  const source = readFileSync(new URL('../src/scripting/QuickJSScriptWorkerCore.ts', import.meta.url), 'utf8');
  const clientSource = readFileSync(new URL('../src/scripting/EntityScriptRuntime.ts', import.meta.url), 'utf8');
  assert.match(source, /MAX_SCRIPT_COMPONENTS = 64/);
  assert.match(source, /ENTITY_TICK_DEADLINE_MS = 25/);
  assert.match(source, /ENTITY_FRAME_INTERRUPT_LIMIT = 64/);
  assert.match(source, /slice\(0, MAX_SCRIPT_COMPONENTS\)/);
  assert.match(source, /exceeded the aggregate/);
  assert.doesNotMatch(source, /const QuickJS = await/, 'Space startup must not wait for QuickJS WASM');
  assert.doesNotMatch(clientSource, /new Worker\(/, 'entity QuickJS must execute on the page thread');
});

test('main-thread QuickJS exposes a bounded synchronous world raycast', () => {
  const contraption = entity(9);
  contraption.setScript(`
const hit = ctx.world.raycast([1, 2, 3], [0, -1, 0], 4);
self.state.hit = hit;
self.state.frozen = Object.isFrozen(hit) && Object.isFrozen(hit.normal) && Object.isFrozen(hit.position);
`);
  const calls: any[] = [];
  contraption.update(1 / 60, null, {
    world: {
      entities: () => [],
      raycast: (...args) => {
        calls.push(args);
        return {
          block: 1,
          color: 0x123456,
          normal: [0, 1, 0],
          position: [1, 0, 3],
          distance: 2
        };
      }
    }
  });

  assert.deepEqual(calls, [[[1, 2, 3], [0, -1, 0], 4]]);
  assert.deepEqual(contraption.getComponentState('root').hit, {
    block: 1,
    color: 0x123456,
    normal: [0, 1, 0],
    position: [1, 0, 3],
    distance: 2
  });
  assert.equal(contraption.getComponentState('root').frozen, true);
});

test('QuickJS exposes real standard/micro world reads and full raycast options', () => {
  const contraption = entity(91);
  contraption.setScript(`
self.state.standard = ctx.world.voxels.get([4, 5, 6]);
self.state.micro = ctx.world.microVoxels.get([7, 8, 9], [1, 2, 3]);
self.state.hit = ctx.world.raycast([1, 2, 3], [0, 0, -1], {
  maxDistance: 12,
  include: 'all',
  voxelKinds: ['standard', 'micro'],
  space: 'world'
});
self.state.frozen = Object.isFrozen(self.state.standard)
  && Object.isFrozen(self.state.micro)
  && Object.isFrozen(self.state.hit);
`);
  const calls: any[] = [];
  contraption.update(0.05, null, {
    world: {
      entities: () => [],
      voxels: { get: position => ({ block: 1, color: position[0] }) },
      microVoxels: { get: (cell, offset) => ({ block: 1, color: cell[0] * 10 + offset[0] }) },
      raycast: (...args) => {
        calls.push(args);
        return { kind: 'entity', entityId: 'ent-target', nodeId: 'arm', position: [1, 2, 0], normal: [0, 0, 1], distance: 3 };
      }
    }
  });

  const state = contraption.getComponentState('root');
  assert.deepEqual(state.standard, { block: 1, color: 4 });
  assert.deepEqual(state.micro, { block: 1, color: 71 });
  assert.equal(state.hit.entityId, 'ent-target');
  assert.deepEqual(calls, [[
    [1, 2, 3],
    [0, 0, -1],
    { maxDistance: 12, include: 'all', voxelKinds: ['standard', 'micro'], space: 'world' }
  ]]);
  assert.equal(state.frozen, true);
});

test('queued mutations publish final command receipts on the next script frame', () => {
  const contraption = entity(92);
  contraption.setScript(`
if (!self.state.commandId) {
  const queued = ctx.world.voxels.set([20, 20, 20], { color: 0x123456 });
  self.state.commandId = queued.commandId;
} else {
  self.state.receipt = ctx.commands.get(self.state.commandId);
  self.state.receiptsFrozen = Object.isFrozen(ctx.commands.all())
    && Object.isFrozen(self.state.receipt);
}
`);
  const runtimeContext = {
    world: {
      entities: () => [],
      voxels: {
        get: () => ({ block: 0, color: 0 }),
        set: () => ({ ok: true, placed: 1, reason: 'placed' })
      },
      microVoxels: { get: () => ({ block: 0, color: 0 }) }
    }
  };

  contraption.update(0.05, null, runtimeContext);
  const commandId = contraption.getComponentState('root').commandId;
  assert.match(commandId, /^cmd-\d+$/);
  contraption.update(0.05, null, runtimeContext);

  const state = contraption.getComponentState('root');
  assert.deepEqual(state.receipt, {
    commandId,
    status: 'committed',
    scope: 'world',
    path: 'voxels.set',
    nodeId: null,
    ok: true,
    placed: 1,
    reason: 'placed'
  });
  assert.equal(state.receiptsFrozen, true);
});

test('ctx exposes grounded, driver and bounded contact observations', () => {
  const contraption = entity(93);
  contraption.recordScriptContact({
    kind: 'player',
    selfNodeId: 'root',
    playerId: 'local',
    position: [1, 2, 3],
    normal: [0, 1, 0],
    relativeVelocity: [0, -2, 0],
    impulse: 100
  });
  contraption.isOnGround = true;
  contraption.setScript(`
self.state.isOnGround = ctx.isOnGround;
self.state.driver = ctx.driver;
self.state.contacts = ctx.contacts;
self.state.frozen = Object.isFrozen(ctx.contacts) && Object.isFrozen(ctx.contacts[0]);
`);
  contraption.update(0.05, null, {
    driver: {
      entityId: contraption.publicId,
      playerId: 'local',
      componentId: 'root',
      seatIndex: 0
    },
    world: { entities: () => [] }
  });

  const state = contraption.getComponentState('root');
  assert.equal(state.isOnGround, true);
  assert.deepEqual(state.driver, { playerId: 'local', componentId: 'root', seatIndex: 0 });
  assert.equal(state.contacts[0].kind, 'player');
  assert.equal(state.contacts[0].key, undefined, 'internal contact dedupe keys must not leak');
  assert.equal(state.frozen, true);
});

test('entity code receives the engine-owned fixed simulation step', () => {
  const contraption = entity(10, [
    { id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] }
  ]);
  contraption.setScript(`
self.state.runs = (self.state.runs || 0) + 1;
self.state.tickRateType = typeof ctx.setTickRate;
self.state.deltaTime = ctx.deltaTime;
if (ctx.input.pressed('KeyW')) self.state.presses = (self.state.presses || 0) + 1;
if (ctx.input.released('KeyW')) self.state.releases = (self.state.releases || 0) + 1;
self.applyForce([0, 10, 0]);
self.child('arm').setLocalSpin([0, 1, 0], 60);
`);

  const step = input => contraption.update(0.05, input, {});
  step({ down: new Set(['KeyW']), pressed: new Set(['KeyW']), released: new Set() });
  const arm = contraption.getEntityNode('arm');
  const rotation = arm.localQuaternion.clone();

  contraption.appliedForces.set(0, 0, 0);
  step({ down: new Set(), pressed: new Set(), released: new Set(['KeyW']) });

  const state = contraption.getComponentState('root');
  assert.equal(contraption.tickCount, 2);
  assert.equal(state.runs, 2);
  assert.equal(state.tickRateType, 'undefined');
  assert.equal(state.deltaTime, 0.05);
  assert.equal(state.presses, 1);
  assert.equal(state.releases, 1);
  assert.ok(!arm.localQuaternion.equals(rotation));
  assert.equal(contraption.appliedForces.y, 10);
});

test('untrusted force vectors cannot introduce non-finite physics state', () => {
  const contraption = entity(5);
  contraption.setScript(`
self.state.bodyAccepted = self.body.applyForce([1e308, 0, 0]);
self.applyForce([1e308, 0, 0]);
self.applyTorque([0, 1e308, 0]);
`);

  contraption.update(1 / 60, null, {});

  assert.equal(contraption.getComponentState('root').bodyAccepted, false);
  for (const vector of [
    contraption.appliedForces,
    contraption.appliedTorques,
    contraption.getRigidBody('root').appliedForces,
    contraption.getRigidBody('root').appliedTorques
  ]) {
    assert.ok(vector.toArray().every(Number.isFinite));
    assert.equal(vector.lengthSq(), 0);
  }
  assert.equal(contraption.scriptApi.body.applyForce([Infinity, 0, 0]), false);
  assert.equal(contraption.scriptApi.body.applyTorque([0, 0, 1e13]), false);
});

test('QuickJS can change every BodyConfig behavior at runtime and Stop restores PB defaults', () => {
  const contraption = entity(12);
  assert.ok(contraption.getCollisionWorldAABBs().length > 0);
  contraption.setScript(`
self.state.type = self.body.setType('kinematic');
self.state.mass = self.body.setMass(65);
self.state.material = self.body.setMaterial({ restitution: 0.8, friction: 0.2 });
self.state.gravity = self.body.setGravityEnabled(false);
self.state.collision = self.body.setCollisionEnabled(false);
`);

  contraption.update(1 / 60, null, {});

  assert.equal(contraption.getNodeBodyType('root'), 'kinematic');
  assert.equal(contraption.getNodeBodyMass('root'), 65);
  assert.deepEqual(contraption.getNodeBodyMaterial('root'), { restitution: 0.8, friction: 0.2 });
  assert.equal(contraption.getNodeGravityEnabled('root'), false);
  assert.equal(contraption.getNodeCollisionEnabled('root'), false);
  assert.equal(contraption.getCollisionWorldAABBs().length, 0,
    'disabling root collision must remove its cached collision shapes');
  assert.deepEqual(contraption.getComponentState('root').gravity,
    { ok: true, enabled: false, reason: 'queued', commandId: 'cmd-4' });
  assert.deepEqual(contraption.getComponentState('root').collision,
    { ok: true, enabled: false, reason: 'queued', commandId: 'cmd-5' });

  const serializedWhileRunning = contraption.serializeSubtree('root');
  assert.equal(serializedWhileRunning.bodyType, 'dynamic');
  assert.equal('mass' in serializedWhileRunning, false);
  assert.equal(serializedWhileRunning.restitution, 0.1);
  assert.equal(serializedWhileRunning.friction, 0.7);
  assert.equal(serializedWhileRunning.useGravity, true);
  assert.equal(serializedWhileRunning.collisionEnabled, true);

  contraption.disableAllNodeScripts();
  assert.equal(contraption.getNodeBodyMass('root'), 65, 'Disabled component code preserves runtime BodyConfig values');
  assert.equal(contraption.getNodeCollisionEnabled('root'), false);

  contraption.stopAllNodeScripts();
  assert.equal(contraption.getNodeBodyType('root'), 'dynamic');
  assert.equal(contraption.getNodeBodyMass('root'), 20);
  assert.deepEqual(contraption.getNodeBodyMaterial('root'), { restitution: 0.1, friction: 0.7 });
  assert.equal(contraption.getNodeGravityEnabled('root'), true);
  assert.equal(contraption.getNodeCollisionEnabled('root'), true);
  assert.ok(contraption.getCollisionWorldAABBs().length > 0,
    'Stop must invalidate caches and restore the default collision shapes');
});

test('world snapshots share admitted overlays and keep entity descriptors immutable', () => {
  const contraption = entity(6, [
    { id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] }
  ]);
  contraption.setNodeScript('root', `
const descriptor = ctx.world.entities.get('ent_other');
self.state.frozen = Object.isFrozen(descriptor) && Object.isFrozen(descriptor.position);
try { descriptor.position[0] = 999; } catch (_) {}
self.state.massResult = self.body.setMass(0);
self.state.writeResult = ctx.world.voxels.set([20, 20, 20], { color: 0x123456 });
`);
  contraption.setNodeScript('arm', `
self.state.voxel = ctx.world.voxels.get([20, 20, 20]);
self.state.near = ctx.world.entities([10, 0, 0], 1).length;
self.state.entityX = ctx.world.entities.get('ent_other').position[0];
`);
  const writes: any[] = [];
  const runtimeContext = {
    world: {
      entities: () => [{
        id: 'ent_other',
        runtimeId: 99,
        chunkId: '0,0',
        position: [10, 0, 0],
        bodyType: 'dynamic',
        scriptStatus: 'running',
        distance: 10
      }],
      voxels: { set: (...args) => writes.push(args) }
    }
  };

  contraption.update(1 / 60, null, runtimeContext);

  const rootState = contraption.getComponentState('root');
  const armState = contraption.getComponentState('arm');
  assert.equal(rootState.frozen, true);
  assert.deepEqual(rootState.massResult, { ok: false, mass: 10, reason: 'invalid_mass' });
  assert.deepEqual(rootState.writeResult, { ok: true, placed: 1, reason: 'queued', commandId: 'cmd-1' });
  assert.deepEqual(armState.voxel, { block: 1, color: 0x123456 });
  assert.equal(armState.near, 1, 'query radius must be measured from the supplied origin');
  assert.equal(armState.entityX, 10, 'one component must not mutate another component\'s snapshot');
  assert.equal(writes.length, 1);
});

test('full command buffers report admission failure and cannot swallow self.stop', () => {
  const limited = entity(7);
  limited.setScript(`
for (let i = 0; i < 256; i++) ctx.log(i);
self.state.result = ctx.world.voxels.set([1, 2, 3], { color: 0xffffff });
`);
  let writes = 0;
  limited.update(1 / 60, null, {
    world: {
      entities: () => [],
      voxels: { set: () => { writes++; } }
    }
  });
  assert.deepEqual(limited.getComponentState('root').result, {
    ok: false,
    placed: 0,
    reason: 'command_limit',
    commandId: null
  });
  assert.equal(writes, 0);

  const stopped = entity(8);
  stopped.setScript('for (let i = 0; i < 256; i++) ctx.log(i); self.stop();');
  stopped.update(1 / 60, null, {});
  assert.equal(stopped.scriptStatus, 'stopped');
  assert.equal(stopped.isNodeScriptEnabled('root'), false);
});

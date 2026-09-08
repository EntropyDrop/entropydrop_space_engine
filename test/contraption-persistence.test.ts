import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ContraptionManager,
  ENTITY_STORAGE_VERSION,
  worldEntitiesStorageKey
} from '../src/contraption/ContraptionManager.ts';
import { ContraptionMode } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

class MockStorage {
  store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

test('offline entity persistence rejects the obsolete v2 frontend shape', () => {
  const storage = new MockStorage();
  const worldId = 'obsolete-world-entities';
  storage.setItem(worldEntitiesStorageKey(worldId), JSON.stringify({
    type: 'space-entities',
    version: 2,
    worldId,
    entities: [{ slot: { blocks: [{ localX: 0, localY: 0, localZ: 0 }] } }]
  }));
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null, storage);
  manager.setWorldId(worldId);

  assert.equal(ENTITY_STORAGE_VERSION, 4);
  assert.equal(manager.loadEntitiesFromStorage(), 0);
  assert.equal(manager.contraptions.length, 0);
});

test('streaming preserves runtime BodyConfig overrides without replacing PB defaults', () => {
  const slot = {
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    blocks: [{
      localX: 0,
      localY: 0,
      localZ: 0,
      size: 1,
      color: 0xff0000,
      block: BlockTypes.COLOR_BLOCK,
      entityId: 'root'
    }],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: [],
    bodyType: 'dynamic',
    restitution: 0.2,
    friction: 0.4,
    useGravity: true,
    collisionEnabled: true
  };
  const managerA = new ContraptionManager(new THREE.Scene(), null, null, null);
  const source = managerA.buildFromSlot(slot, new THREE.Vector3(1, 2, 3), null, false);
  source.scriptApi.body.setType('kinematic');
  source.scriptApi.body.setMass(70);
  source.scriptApi.body.setMaterial({ restitution: 0.8, friction: 0.1 });
  source.scriptApi.body.setGravityEnabled(false);
  source.scriptApi.body.setCollisionEnabled(false);

  const record = managerA.captureContraptionForStreaming(source, { id: '0,0' });
  const managerB = new ContraptionManager(new THREE.Scene(), null, null, null);
  const restored = managerB.buildFromSlot(
    record.slot,
    new THREE.Vector3().fromArray(record.constructorOrigin),
    record,
    false
  );

  assert.equal(restored.getNodeBodyType('root'), 'kinematic');
  assert.equal(restored.getNodeBodyMass('root'), 70);
  assert.deepEqual(restored.getNodeBodyMaterial('root'), { restitution: 0.8, friction: 0.1 });
  assert.equal(restored.getNodeGravityEnabled('root'), false);
  assert.equal(restored.getNodeCollisionEnabled('root'), false);
  assert.equal(restored.serializeSubtree('root').bodyType, 'dynamic');

  restored.stopAllNodeScripts();
  assert.equal(restored.getNodeBodyType('root'), 'dynamic');
  assert.equal(restored.getNodeBodyMass('root'), 10);
  assert.deepEqual(restored.getNodeBodyMaterial('root'), { restitution: 0.2, friction: 0.4 });
  assert.equal(restored.getNodeGravityEnabled('root'), true);
  assert.equal(restored.getNodeCollisionEnabled('root'), true);

  const stoppedRecord = managerB.captureContraptionForStreaming(restored, { id: '0,0' });
  assert.equal(stoppedRecord.physicsSimulationEnabled, false);
  const managerC = new ContraptionManager(new THREE.Scene(), null, null, null);
  const stoppedRestored = managerC.buildFromSlot(
    stoppedRecord.slot,
    new THREE.Vector3().fromArray(stoppedRecord.constructorOrigin),
    stoppedRecord,
    false
  );
  assert.equal(stoppedRestored.isPhysicsSimulationEnabled(), false);
  assert.equal(stoppedRestored.getRigidBody('root').simulationEnabled, false);
  assert.equal(stoppedRestored.canEditInternalSelection(), true);
});

test('contraption manager saves assembled entity and restores it after simulated reload', () => {
  const storage = new MockStorage();
  const worldId = 'test-world-persist-1';

  const scene = new THREE.Scene();
  const managerA = new ContraptionManager(scene, null, null, null, storage);
  managerA.setWorldId(worldId);

  // Directly build an entity in managerA
  const slot = {
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xff0000, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 1, localY: 0, localZ: 0, size: 0.125, color: 0x00ff00, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [],
    scripts: [{ id: 'root', code: 'self.color = 0x123456;' }],
    enabled: [{ id: 'root', enabled: true }],
    constraints: []
  };

  const pos = new THREE.Vector3(100, 15, 200);
  const created = managerA.buildFromSlot(slot, pos, null, false);
  assert.ok(created);
  assert.equal(managerA.contraptions.length, 1);

  created.setNodeBodyMass('root', 987_654.5);
  created.setNodeBodyMaterial('root', { restitution: 0.013, friction: 0.27 });
  created.useGravity = false;
  created.quaternion.setFromEuler(new THREE.Euler(0.21, -0.37, 0.09));
  created.velocity.set(4.5, -2.25, 1.125);
  created.angularVelocity.set(-0.4, 0.8, 0.2);
  const createdBody = created.getRigidBody('root');
  createdBody.linearDamping = 0.876;
  createdBody.angularDamping = 0.654;
  created.linearDamping = createdBody.linearDamping;
  created.angularDamping = createdBody.angularDamping;
  createdBody.previousKinematicPosition.set(99, 14, 199);
  createdBody.previousKinematicQuaternion.setFromEuler(new THREE.Euler(0.1, 0.2, 0.3));
  createdBody.isOnGround = true;
  created.isOnGround = true;
  created.groundDistance = 0.125;

  // Save to storage
  const saved = managerA.saveEntitiesToStorage();
  assert.equal(saved, true);

  const raw = storage.getItem(worldEntitiesStorageKey(worldId));
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, ENTITY_STORAGE_VERSION);
  assert.equal(parsed.entities.length, 1);
  assert.equal(parsed.worldId, worldId);
  assert.equal(parsed.entities[0].bodies[0].mass, 987_654.5);
  assert.equal(parsed.entities[0].bodies[0].linearDamping, 0.876);
  assert.equal(parsed.entities[0].bodies[0].angularDamping, 0.654);

  // Now create managerB (simulating page reload)
  const sceneB = new THREE.Scene();
  const managerB = new ContraptionManager(sceneB, null, null, null, storage);
  managerB.setWorldId(worldId);

  assert.equal(managerB.contraptions.length, 0);
  const loadedCount = managerB.loadEntitiesFromStorage();
  assert.equal(loadedCount, 1);
  assert.equal(managerB.contraptions.length, 1);

  const restored = managerB.contraptions[0];
  assert.equal(restored.publicId, created.publicId);
  assert.equal(restored.blocks.length, 2);
  assert.equal(restored.position.x, created.position.x);
  assert.equal(restored.position.y, created.position.y);
  assert.equal(restored.position.z, created.position.z);
  assert.equal(restored.getNodeScript('root'), 'self.color = 0x123456;');
  assert.ok(Math.abs(restored.quaternion.dot(created.quaternion)) > 1 - 1e-12);
  assert.deepEqual(restored.velocity.toArray(), created.velocity.toArray());
  assert.deepEqual(restored.angularVelocity.toArray(), created.angularVelocity.toArray());
  assert.equal(restored.useGravity, false);
  assert.equal(restored.isOnGround, true);
  assert.equal(restored.groundDistance, 0.125);

  const restoredBody = restored.getRigidBody('root');
  assert.equal(restoredBody.type, createdBody.type);
  assert.equal(restoredBody.mass, createdBody.mass);
  assert.equal(restoredBody.inverseInertia, createdBody.inverseInertia);
  assert.equal(restoredBody.restitution, createdBody.restitution);
  assert.equal(restoredBody.friction, createdBody.friction);
  assert.equal(restoredBody.linearDamping, createdBody.linearDamping);
  assert.equal(restoredBody.angularDamping, createdBody.angularDamping);
  assert.deepEqual(restoredBody.centerOfMassLocal.toArray(), createdBody.centerOfMassLocal.toArray());
  assert.deepEqual(restoredBody.previousKinematicPosition.toArray(), createdBody.previousKinematicPosition.toArray());
  assert.ok(Math.abs(restoredBody.previousKinematicQuaternion.dot(createdBody.previousKinematicQuaternion)) > 1 - 1e-12);
  assert.equal(restoredBody.isOnGround, true);

  const airWorld = {
    getBlock: () => BlockTypes.AIR,
    raycast: () => ({ hit: false, distance: 0 }),
    raycastMicro: () => ({ hit: false, distance: 0 }),
    microVoxels: { get: () => null }
  };
  new ContraptionPhysics(airWorld as any).update(created, 1 / 60);
  new ContraptionPhysics(airWorld as any).update(restored, 1 / 60);
  assert.ok(restored.position.distanceTo(created.position) < 1e-12, 'the first post-refresh physics step must not change the trajectory');
  assert.deepEqual(restored.velocity.toArray(), created.velocity.toArray());
  assert.ok(Math.abs(restored.quaternion.dot(created.quaternion)) > 1 - 1e-12);
  assert.deepEqual(restored.angularVelocity.toArray(), created.angularVelocity.toArray());
});

test('refresh preserves the root pivot after live block edits change the bounds', () => {
  const storage = new MockStorage();
  const worldId = 'test-world-persist-edited-pivot';
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  manager.setWorldId(worldId);
  const entity = manager.buildFromSlot({
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    bodyType: 'kinematic',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xff0000, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  }, new THREE.Vector3(20, 5, 20), null, false);
  assert.ok(entity);

  const originalPivot = entity.scriptApi.getPivot();
  entity.blocks.push({
    localX: 3,
    localY: 0,
    localZ: 0,
    size: 1,
    color: 0x00ff00,
    block: BlockTypes.COLOR_BLOCK,
    entityId: 'root'
  });
  entity.rebuildAfterBlockChange('place', 'root');

  assert.deepEqual(entity.scriptApi.getBounds().center, [2, 0.5, 0.5]);
  assert.deepEqual(entity.scriptApi.getPivot(), originalPivot, 'live edits keep the original pivot');
  const blockWorldBefore = entity.getBlockWorldCenter(entity.blocks[0]);

  assert.equal(manager.saveEntitiesToStorage(storage as any), true);
  const saved = JSON.parse(storage.getItem(worldEntitiesStorageKey(worldId))!);
  assert.deepEqual(saved.entities[0].localCenter, originalPivot);

  const reloaded = new ContraptionManager(new THREE.Scene(), null, null, null);
  reloaded.setWorldId(worldId);
  assert.equal(reloaded.loadEntitiesFromStorage(storage as any), 1);
  const restored = reloaded.contraptions[0];

  assert.deepEqual(restored.scriptApi.getPivot(), originalPivot);
  assert.deepEqual(restored.localCenter.toArray(), originalPivot);
  assert.ok(
    restored.getBlockWorldCenter(restored.blocks[0]).distanceTo(blockWorldBefore) < 1e-12,
    'reload keeps the edited entity blocks at the same world positions'
  );
});

test('refresh applies an explicit root pivot before rebuilding the hierarchy', () => {
  const storage = new MockStorage();
  const worldId = 'test-world-persist-explicit-pivot';
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  manager.setWorldId(worldId);
  const entity = manager.buildFromSlot({
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    bodyType: 'kinematic',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xff0000, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  }, new THREE.Vector3(30, 5, 30), null, false);
  assert.ok(entity);

  entity.scriptApi.setPivot([2, 0.5, 0.5]);
  const blockWorldBefore = entity.getBlockWorldCenter(entity.blocks[0]);
  assert.equal(manager.saveEntitiesToStorage(storage as any), true);

  const reloaded = new ContraptionManager(new THREE.Scene(), null, null, null);
  reloaded.setWorldId(worldId);
  assert.equal(reloaded.loadEntitiesFromStorage(storage as any), 1);
  const restored = reloaded.contraptions[0];

  assert.deepEqual(restored.scriptApi.getPivot(), [2, 0.5, 0.5]);
  assert.ok(
    restored.getBlockWorldCenter(restored.blocks[0]).distanceTo(blockWorldBefore) < 1e-12,
    'reload keeps blocks fixed around an explicit pivot'
  );
});

test('refresh persistence restores dynamic child body parameters and motion', () => {
  const storage = new MockStorage();
  const worldId = 'test-world-persist-child-body';
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null);
  manager.setWorldId(worldId);
  const entity = manager.buildFromSlot({
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    bodyType: 'kinematic',
    blocks: [
      { localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'arm' }
    ],
    childEntities: [{
      id: 'arm',
      parentId: 'root',
      kind: 'child',
      pivot: [2.5, 0.5, 0.5],
      blockKeys: [['2', '0', '0']],
      bodyType: 'dynamic'
    }],
    scripts: [],
    enabled: [],
    constraints: []
  }, new THREE.Vector3(10, 5, 10), null, false);
  assert.ok(entity);

  entity.setNodeBodyMass('arm', 4321);
  entity.setNodeBodyMaterial('arm', { restitution: 0.041, friction: 0.19 });
  const childBody = entity.getRigidBody('arm');
  childBody.linearDamping = 0.81;
  childBody.angularDamping = 0.62;
  childBody.position.set(14, 8, 13);
  childBody.quaternion.setFromEuler(new THREE.Euler(-0.2, 0.3, 0.4));
  childBody.velocity.set(3, 2, 1);
  childBody.angularVelocity.set(0.7, -0.6, 0.5);
  entity.syncAllBodyTransforms();

  assert.equal(manager.saveEntitiesToStorage(storage as any), true);
  const reloaded = new ContraptionManager(new THREE.Scene(), null, null, null);
  reloaded.setWorldId(worldId);
  assert.equal(reloaded.loadEntitiesFromStorage(storage as any), 1);

  const restoredBody = reloaded.contraptions[0].getRigidBody('arm');
  assert.equal(restoredBody.type, childBody.type);
  assert.equal(restoredBody.mass, childBody.mass);
  assert.equal(restoredBody.inverseInertia, childBody.inverseInertia);
  assert.equal(restoredBody.restitution, childBody.restitution);
  assert.equal(restoredBody.friction, childBody.friction);
  assert.equal(restoredBody.linearDamping, childBody.linearDamping);
  assert.equal(restoredBody.angularDamping, childBody.angularDamping);
  assert.deepEqual(restoredBody.position.toArray(), childBody.position.toArray());
  assert.ok(Math.abs(restoredBody.quaternion.dot(childBody.quaternion)) > 1 - 1e-12);
  assert.deepEqual(restoredBody.velocity.toArray(), childBody.velocity.toArray());
  assert.deepEqual(restoredBody.angularVelocity.toArray(), childBody.angularVelocity.toArray());
});

test('disassembling or removing contraption updates storage so it stays removed after reload', () => {
  const storage = new MockStorage();
  const worldId = 'test-world-persist-2';

  const scene = new THREE.Scene();
  const manager = new ContraptionManager(scene, null, null, null);
  manager.setWorldId(worldId);

  const slot = {
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xff0000, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  };

  const created = manager.buildFromSlot(slot, new THREE.Vector3(50, 10, 50), null, true);
  assert.ok(created);

  // Remove the entity
  manager.removeContraption(created);
  assert.equal(manager.contraptions.length, 0);

  // Recreate manager to simulate refresh
  const managerReloaded = new ContraptionManager(new THREE.Scene(), null, null, null);
  managerReloaded.setWorldId(worldId);
  const loadedCount = managerReloaded.loadEntitiesFromStorage(storage as any);

  assert.equal(loadedCount, 0);
  assert.equal(managerReloaded.contraptions.length, 0);
});

test('server-managed entities stay out of browser persistence and preserve a rotated construction origin', () => {
  const storage = new MockStorage();
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null, storage);
  manager.setWorldId('shared-world');
  const origin = new THREE.Vector3(25, 10, 40);
  const entity = manager.buildFromSlot({
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    blocks: [
      { localX: 0, localY: 0, localZ: 0, size: 1, color: 0xff0000, block: BlockTypes.COLOR_BLOCK, entityId: 'root' },
      { localX: 2, localY: 0, localZ: 0, size: 1, color: 0x00ff00, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }
    ],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: []
  }, origin, null, false);
  assert.ok(entity);
  entity.serverManaged = true;
  entity.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  entity.position.copy(origin).add(entity.localCenter.clone().applyQuaternion(entity.quaternion));

  const streamRecord = manager.captureContraptionForStreaming(entity, { id: '0,0' });
  assert.ok(new THREE.Vector3().fromArray(streamRecord.constructorOrigin).distanceTo(origin) < 1e-12);
  assert.equal(streamRecord.serverManaged, true);

  assert.equal(manager.saveEntitiesToStorage(), true);
  const saved = JSON.parse(storage.getItem(worldEntitiesStorageKey('shared-world'))!);
  assert.deepEqual(saved.entities, []);
});

test('online entity persistence never reads or writes browser storage and delegates to the backend adapter', () => {
  const storage = new MockStorage();
  const worldId = 'online-world';
  storage.setItem(worldEntitiesStorageKey(worldId), JSON.stringify({
    type: 'space-entities', version: 1, worldId, entities: [{ publicId: 'legacy' }],
  }));
  const saved: any[] = [];
  const removed: string[] = [];
  const manager = new ContraptionManager(new THREE.Scene(), null, null, null, storage);
  manager.setWorldId(worldId);
  manager.setEntityPersistenceMode('remote', {
    save: record => saved.push(record),
    remove: publicId => removed.push(publicId),
  });

  assert.equal(storage.getItem(worldEntitiesStorageKey(worldId)), null);
  assert.equal(manager.loadEntitiesFromStorage(), 0);
  const entity = manager.buildFromSlot({
    rootComponentId: 'root',
    mode: ContraptionMode.PROGRAMMABLE,
    blocks: [{
      localX: 0, localY: 0, localZ: 0, size: 1,
      color: 0xff0000, block: BlockTypes.COLOR_BLOCK, entityId: 'root',
    }],
    childEntities: [], scripts: [], enabled: [], constraints: [],
  }, new THREE.Vector3(4, 5, 6));

  assert.ok(entity);
  assert.equal(saved.length, 1);
  assert.equal(storage.getItem(worldEntitiesStorageKey(worldId)), null);
  manager.removeContraption(entity);
  assert.deepEqual(removed, [entity.publicId]);
  assert.equal(storage.getItem(worldEntitiesStorageKey(worldId)), null);
});

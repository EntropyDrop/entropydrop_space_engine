import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

function streamingWorld(active = ['0,0']) {
  return {
    activeChunkKeys: new Set(active),
    worldToChunkCoords(x, z) {
      return { cx: Math.floor(Number(x) / 16), cz: Math.floor(Number(z) / 16) };
    }
  } as any;
}

test('entities only exist and run while their chunk is loaded', () => {
  const scene = new THREE.Scene();
  const world = streamingWorld();
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const original = new Contraption(
    41,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(2, 4, 2),
    scene,
    { rootComponentId: 'root' }
  ) as any;
  original.velocity.set(1, 2, 3);
  original.angularVelocity.set(0.1, 0.2, 0.3);
  original.quaternion.setFromEuler(new THREE.Euler(0.2, 0.4, -0.1));
  original.setScript('self.state.runs = (self.state.runs || 0) + 1;');
  manager.registerContraption(original);

  manager.update(1 / 60, null);
  assert.equal(original.getComponentState('root').runs, 1);
  const publicId = original.publicId;
  const oldRuntime = original.scriptRuntimeClient;
  const savedPosition = original.position.toArray();
  const savedVelocity = original.velocity.toArray();
  const savedAngularVelocity = original.angularVelocity.toArray();
  const savedQuaternion = original.quaternion.clone();

  world.activeChunkKeys = new Set(['1,0']);
  manager.update(1 / 60, null);
  assert.equal(manager.contraptions.length, 0, 'the off-window entity must leave every active system');
  assert.equal(manager.getDormantContraptionCount(), 1);
  assert.equal(oldRuntime.disposed, true, 'unloading must dispose the old QuickJS Runtime client');
  assert.equal(scene.children.includes(original.rootGroup), false, 'unloading must dispose the old scene object');

  manager.update(1 / 60, null);
  const dormant = manager.dormantContraptions.get('0,0').get(publicId);
  assert.equal(dormant.states.root.runs, 1, 'scripts must not run while the entity chunk is unloaded');
  assert.equal(dormant.tickCount, 1, 'script ticks must remain frozen while dormant');

  world.activeChunkKeys = new Set(['0,0']);
  manager.update(1 / 60, null);
  assert.equal(manager.getDormantContraptionCount(), 0);
  assert.equal(manager.contraptions.length, 1);

  const restored = manager.contraptions[0];
  assert.notEqual(restored, original, 'loading must construct a fresh Entity instance');
  assert.equal(restored.id, 41);
  assert.equal(restored.publicId, publicId);
  assert.notEqual(restored.scriptRuntimeClient, oldRuntime, 'loading must create a fresh Runtime client');
  assert.deepEqual(restored.position.toArray(), savedPosition);
  assert.deepEqual(restored.velocity.toArray(), savedVelocity);
  assert.deepEqual(restored.angularVelocity.toArray(), savedAngularVelocity);
  assert.ok(Math.abs(restored.quaternion.dot(savedQuaternion)) > 1 - 1e-12);
  assert.equal(restored.getComponentState('root').runs, 2, 'restored state resumes on the first loaded frame');
  assert.equal(restored.tickCount, 2);
});

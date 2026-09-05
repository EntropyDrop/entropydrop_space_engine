import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import {
  ENTITY_UPDATE_DT,
  ENTITY_UPDATE_HZ,
  EntitySimulationClock,
  PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE
} from '../src/simulation/EntitySimulationClock.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

test('render frames feed one immutable 20 Hz entity simulation clock', () => {
  const clock = new EntitySimulationClock();
  const steps: number[] = [];
  let lastAlpha = 0;

  for (let frame = 0; frame < 120; frame++) {
    const result = clock.advance(1 / 120, dt => steps.push(dt));
    lastAlpha = result.alpha;
  }

  assert.equal(ENTITY_UPDATE_HZ, 20);
  assert.equal(ENTITY_UPDATE_DT, 0.05);
  assert.equal(steps.length, 20);
  assert.ok(steps.every(dt => dt === 0.05));
  assert.ok(lastAlpha < 1e-6);
});

test('one entity update always contains three 60 Hz physics substeps', () => {
  const contraption = new Contraption(
    1,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(0, 10, 0),
    new THREE.Scene()
  ) as any;
  const physics = new ContraptionPhysics({
    getBlock: () => BlockTypes.AIR,
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false })
  } as any);

  const frame = physics.prepareContraptionFrame(contraption, ENTITY_UPDATE_DT);
  assert.equal(PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE, 3);
  assert.equal(frame.subSteps, 3);
  assert.ok(Math.abs(frame.substepDt - 1 / 60) < 1e-12);
});

test('render interpolation is temporary and never changes the solved entity pose', () => {
  const contraption = new Contraption(
    2,
    [{ localX: 0, localY: 0, localZ: 0, block: BlockTypes.COLOR_BLOCK, entityId: 'root' }],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  const startX = contraption.position.x;
  contraption.capturePreviousEntityTransforms();
  contraption.position.x = startX + 2;
  contraption.updateTransform();

  contraption.beginRenderInterpolation(0.25);
  assert.equal(contraption.position.x, startX + 0.5);
  contraption.endRenderInterpolation();
  assert.equal(contraption.position.x, startX + 2);
  assert.equal(contraption.getRigidBody('root').position.x, startX + 2);
});

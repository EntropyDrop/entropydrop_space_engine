/** Run with Node 24+: node tools/benchmark-physics.ts
 * CPU-only: no scripts, terrain occupancy, rendering, network or persistence.
 * The awake case deliberately omits terrainVersion so sleep cannot mask the
 * collision cost. Stopped/asleep cases retain the exact same loaded geometry. */
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';

const blocks = [];
for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) {
  blocks.push({ localX: x, localY: 0, localZ: z, entityId: 'root', block: BlockTypes.COLOR_BLOCK });
}
for (const mode of ['awake', 'stopped', 'asleep']) {
  const scene = new THREE.Scene();
  const world = {
    ...(mode === 'asleep' ? { terrainVersion: 0 } : {}),
    getBlock: () => BlockTypes.AIR, getMicroBlocksInAABB: () => [],
    raycast: () => ({ hit: false }), raycastMicro: () => ({ hit: false }),
  };
  const physics = new ContraptionPhysics(world as any);
  const manager = new ContraptionManager(scene, world as any, null, null);
  manager.setPhysics(physics);
  for (let i = 0; i < 100; i++) {
    const entity = new Contraption(`benchmark_${i}`, blocks,
      new THREE.Vector3((i % 10) * 11, 30, Math.floor(i / 10) * 11), scene);
    entity.useGravity = false;
    if (mode === 'stopped') entity.setPhysicsSimulationEnabled(false);
    manager.registerContraption(entity);
  }
  for (let i = 0; i < 40; i++) manager.update(0.05, null);
  const times = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    manager.update(0.05, null);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, entities: 100, voxelsEach: 100,
    sleeping: manager.contraptions.filter(entity => physics.isSleeping(entity)).length,
    medianMs: Number(times[20].toFixed(2)), p95Ms: Number(times[38].toFixed(2)),
  }));
  for (const entity of [...manager.contraptions]) entity.dispose();
}

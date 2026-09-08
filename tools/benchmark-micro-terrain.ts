/** Node 24+: node tools/benchmark-micro-terrain.ts
 * Compare queries of the same 8³ grid, with a 4 m²-axis micro floor inside a
 * 4×4×4 m query volume. This measures CPU query cost, not browser frame rate. */
import { performance } from 'node:perf_hooks';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { MICRO_DIVISIONS as D } from '../src/voxel/MicroGrid.ts';

const layer = new MicroVoxelLayer();
for (let x = 0; x < 4 * D; x++) for (let z = 0; z < 4 * D; z++) layer.set(x, 0, z, 0x123456);
layer.updateMesh();
const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 };
const start = performance.now();
const cold = layer.getCollisionBoxesInAABB(bounds, true);
console.log(JSON.stringify({ phase: 'cache-build', occupiedCells: layer.cells.size,
  collisionBoxes: cold.length, ms: +(performance.now() - start).toFixed(4) }));
for (const mode of ['cell-scan', 'cached-boxes']) {
  const query = mode === 'cell-scan'
    ? () => layer.getPublishedCollisionCellsInAABB(bounds)
    : () => layer.getCollisionBoxesInAABB(bounds, true);
  for (let i = 0; i < 30; i++) query();
  const times: number[] = [];
  let count = 0;
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    count = query().length;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, candidates: count, queries: 200,
    medianMs: +times[100].toFixed(4), p95Ms: +times[190].toFixed(4) }));
}

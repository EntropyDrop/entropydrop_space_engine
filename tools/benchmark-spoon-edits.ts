// CPU-only edit latency benchmark; each simulated render slice has a 2 ms budget.
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';

function timed(fn: () => void) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function createLayer(height: number, sparse = false) {
  const layer = new MicroVoxelLayer();
  for (let x = 0; x < 32; x++) {
    for (let z = 0; z < 32; z++) {
      for (let y = 0; y < height; y++) {
        if (!sparse || y === 0 || y === height - 1) layer.set(x, y, z, 0x888888);
      }
    }
  }
  layer.updateMesh();
  return layer;
}

for (const shape of ['dense', 'tallSparse']) {
  const height = shape === 'dense' ? 64 : 512;
  const layer = createLayer(height, shape === 'tallSparse');
  const aabb = {
    minX: 0.1, maxX: 1.8, minY: (height - 2) / 8,
    maxY: height / 8 + 0.01, minZ: 0.1, maxZ: 1.8,
  };
  layer.getCollisionBoxesInAABB(aabb, true);
  const collision: number[] = [];
  const mesh: number[] = [];
  const latency: number[] = [];
  for (let edit = 0; edit < 12; edit++) {
    layer.delete(edit + 1, height - 1, 2);
    layer.prioritizeMeshAt(edit + 1, 2, height - 1);
    let frames = 0;
    let sum = 0;
    while (layer.getPublishedCollisionColor(edit + 1, height - 1, 2) !== null && frames < 1000) {
      sum += timed(() => layer.updateMesh(Infinity, null, null, 2));
      frames++;
    }
    if (frames === 1000) throw new Error('Mesh publication did not finish');
    latency.push(frames);
    mesh.push(sum);
    collision.push(timed(() => { layer.getCollisionBoxesInAABB(aabb, true); }));
  }
  console.log(JSON.stringify({
    shape, rebuildCpuMs: stats(mesh), publicationFrames: stats(latency),
    collisionAfterPublishMs: stats(collision),
  }));
}

const layer = createLayer(64);
let completed = 0;
const slices: number[] = [];
for (let edit = 0; edit < 30; edit++) {
  const x = edit % 14 + 1;
  const z = Math.floor(edit / 14) + 1;
  layer.delete(x, 63, z);
  layer.prioritizeMeshAt(x, z, 63);
  for (let frame = 0; frame < 4; frame++) {
    slices.push(timed(() => layer.updateMesh(1, null, null, 2)));
  }
  if (layer.getPublishedCollisionColor(x, 63, z) === null) completed++;
}
console.log(JSON.stringify({
  continuousEdits: 30, editsVisibleBeforeNextClick: completed,
  frameMeshingMs: stats(slices),
}));

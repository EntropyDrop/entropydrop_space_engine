import test from 'node:test';
import assert from 'node:assert/strict';
import { MicroVoxelLayer } from '../src/voxel/MicroVoxelLayer.ts';
import { TORUS_SIZE_X } from '../src/torus/TorusWorld.ts';
import { MICRO_DIVISIONS as D } from '../src/voxel/MicroGrid.ts';

test('continuous local edits publish between clicks instead of restarting a whole terrain column', t => {
  const layer = new MicroVoxelLayer();
  for (let x = 0; x < 32; x++) for (let y = 0; y < 64; y++) for (let z = 0; z < 32; z++) {
    layer.set(x, y, z, 0x888888);
  }
  layer.updateMesh();
  // A deterministic work clock: each meshing budget check costs 0.02 ms.
  // This checks bounded work/publication progress without machine-speed assertions.
  let workTime = 0;
  t.mock.method(performance, 'now', () => workTime += 0.02);
  for (let edit = 0; edit < 30; edit++) {
    const x = edit % 14 + 1;
    const z = Math.floor(edit / 14) + 1;
    assert.equal(layer.delete(x, 63, z), true);
    layer.prioritizeMeshAt(x, z, 63);
    for (let frame = 0; frame < 4; frame++) layer.updateMesh(1, null, null, 2);
    assert.equal(layer.getPublishedCollisionColor(x, 63, z), null,
      `edit ${edit} must publish before the next click`);
  }
});

test('a distant height cannot increase the work of a local mesh or collision rebuild', () => {
  const layer = new MicroVoxelLayer() as any;
  for (let x = 1; x < 15; x++) for (let z = 1; z < 15; z++) {
    layer.set(x, 1, z, 0x888888);
    layer.set(x, 511, z, 0x888888);
  }
  layer.updateMesh();
  const lowerMesh = layer.meshChunks.get('0,0,0');
  let samples = 0;
  const sample = layer.sampleMeshCell.bind(layer);
  layer.sampleMeshCell = (...args: any[]) => { samples++; return sample(...args); };
  layer.delete(5, 511, 5);
  layer.updateMesh();
  assert.equal(layer.meshChunks.get('0,0,0'), lowerMesh, 'lower geometry must retain its identity');
  assert.ok(samples < 30_000, `local meshing must not traverse 64 m of empty height (${samples} samples)`);
  for (const keys of layer.chunkCells.values()) assert.ok(keys.size <= 4096);
  const bounds = { minX: 0.1, maxX: 1.8, minY: 63.7, maxY: 64, minZ: 0.1, maxZ: 1.8 };
  layer.getCollisionBoxesInAABB(bounds, true);
  assert.deepEqual([...layer.publishedCollisionIndexes.keys()], ['0,0,31'],
    'collision lookup must not rebuild the other heights in the column');
});

test('vertical boundary faces and torus seam faces stay exact after local edits', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 15, 1, 1);
  layer.set(1, 16, 1, 1);
  layer.set(TORUS_SIZE_X * D - 1, 48, 2, 1);
  layer.set(0, 48, 2, 1);
  layer.updateMesh();
  assert.equal(layer.meshChunks.get('0,0,0')!.geometry.index!.count, 30);
  assert.equal(layer.meshChunks.get('0,0,1')!.geometry.index!.count, 30);
  assert.equal(layer.meshChunks.get('0,0,3')!.geometry.index!.count, 30);
  layer.delete(1, 16, 1);
  layer.updateMesh();
  assert.equal(layer.meshChunks.get('0,0,0')!.geometry.index!.count, 36);
  assert.equal(layer.meshChunks.get('0,0,1'), undefined);
  layer.delete(TORUS_SIZE_X * D - 1, 48, 2);
  layer.updateMesh();
  assert.equal(layer.meshChunks.get('0,0,3')!.geometry.index!.count, 36);
});

test('indexed chunk previews enumerate only local live cells and revisions include paint and clear', () => {
  const layer = new MicroVoxelLayer();
  layer.set(1, 1, 1, 1);
  layer.set(1, 500, 1, 2);
  layer.set(129, 10, 1, 3);
  const initial = layer.getChunkRevision(0, 0);
  const distant = layer.getChunkRevision(1, 0);
  layer.set(1, 500, 1, 4);
  assert.ok(layer.getChunkRevision(0, 0) > initial);
  assert.equal(layer.getChunkRevision(1, 0), distant);
  const cells: number[][] = [];
  layer.forEachCellInChunk(0, 0, (x, y, z, color) => cells.push([x, y, z, color]));
  assert.deepEqual(cells, [[1, 1, 1, 1], [1, 500, 1, 4]]);
  const beforeClear = layer.getChunkRevision(0, 0);
  layer.clearChunk(0, 0);
  assert.ok(layer.getChunkRevision(0, 0) > beforeClear);
  layer.forEachCellInChunk(0, 0, () => assert.fail('cleared cells must leave the index'));
  assert.equal(layer.get(129, 10, 1), 3);
});

test('repeated snapshot clears do not spread work through empty vertical partitions', () => {
  const layer = new MicroVoxelLayer() as any;
  for (let replacement = 0; replacement < 8; replacement++) {
    layer.set(5, 5, 5, 1);
    layer.updateMesh();
    const cursor = layer.beginClearChunk(0, 0);
    assert.equal(cursor.targetMeshChunks.length, 1, 'only occupied/published source partitions need clearing');
    layer.continueClearChunk(cursor);
    layer.updateMesh();
  }
  assert.ok(layer.standardChunkPartitions.get('0,0').size <= 7,
    'empty boundary companions must not propagate into more empty heights on each clear');
});

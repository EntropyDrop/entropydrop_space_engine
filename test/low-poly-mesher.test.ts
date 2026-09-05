import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LowPolyMesher } from '../src/mesher/LowPolyMesher.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../src/voxel/Chunk.ts';

function meshGeometry(chunk: Chunk): THREE.BufferGeometry {
  const group = new LowPolyMesher().buildChunkMesh(chunk);
  const mesh = group.children.find(child => (child as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
  assert.ok(mesh, 'a non-empty chunk should create a mesh');
  return mesh.geometry;
}

test('chunk meshing uses indexed quads and preserves internal-face culling', () => {
  const chunk = new Chunk(0, 0, null);
  chunk.setLocalBlock(4, 5, 6, BlockTypes.COLOR_BLOCK, 0x48dbfb);
  chunk.setLocalBlock(5, 5, 6, BlockTypes.COLOR_BLOCK, 0x48dbfb);

  const geometry = meshGeometry(chunk);
  assert.ok(geometry.index);
  assert.equal(geometry.index.count, 10 * 6, 'two adjacent cubes expose ten quads');
  assert.equal(geometry.getAttribute('position').count, 10 * 4, 'each quad reuses four indexed vertices');
  assert.equal(geometry.getAttribute('normal').count, 10 * 4);
  assert.equal(geometry.getAttribute('color').count, 10 * 4);
  assert.ok(geometry.getAttribute('position').array instanceof Uint16Array);
  assert.ok(geometry.getAttribute('normal').array instanceof Int8Array);
  assert.equal(geometry.getAttribute('normal').normalized, true);
  assert.ok(geometry.getAttribute('color').array instanceof Uint8Array);
  assert.equal(geometry.getAttribute('color').normalized, true);
  assert.ok(geometry.index.array instanceof Uint16Array);
});

test('generated neighboring chunks cull their shared boundary faces', () => {
  const chunks = new Map<string, Chunk>();
  const world = {
    worldToChunkCoords(wx: number, wz: number) {
      return {
        cx: Math.floor(wx / CHUNK_SIZE_X),
        cz: Math.floor(wz / CHUNK_SIZE_Z)
      };
    },
    getChunk(cx: number, cz: number) {
      return chunks.get(`${cx},${cz}`);
    },
    markChunkDirty() {}
  };
  const center = new Chunk(0, 0, world);
  const east = new Chunk(1, 0, world);
  center.hasGenerated = true;
  east.hasGenerated = true;
  chunks.set('0,0', center);
  chunks.set('1,0', east);
  center.setLocalBlock(CHUNK_SIZE_X - 1, 8, 4, BlockTypes.COLOR_BLOCK);
  east.setLocalBlock(0, 8, 4, BlockTypes.COLOR_BLOCK);

  const geometry = meshGeometry(center);
  assert.equal(geometry.index?.count, 5 * 6, 'the occupied east neighbor hides the shared face');
});

test('missing procedural neighbors receive an opaque cut face', () => {
  const chunks = new Map<string, Chunk>();
  const world = {
    terrainGen: { sampleHeight: () => 8 },
    worldToChunkCoords(wx: number, wz: number) {
      return {
        cx: Math.floor(wx / CHUNK_SIZE_X),
        cz: Math.floor(wz / CHUNK_SIZE_Z)
      };
    },
    getChunk(cx: number, cz: number) {
      return chunks.get(`${cx},${cz}`);
    },
    markChunkDirty() {}
  };
  const center = new Chunk(0, 0, world);
  center.hasGenerated = true;
  chunks.set('0,0', center);
  center.setLocalBlock(CHUNK_SIZE_X - 1, 8, 4, BlockTypes.COLOR_BLOCK);

  const geometry = meshGeometry(center);
  assert.equal(
    geometry.index?.count,
    6 * 6,
    'the east face must remain visible until real neighboring geometry exists'
  );
});

test('temporary chunk-edge faces merge vertically without leaving a gap', () => {
  const world = {
    worldToChunkCoords(wx: number, wz: number) {
      return {
        cx: Math.floor(wx / CHUNK_SIZE_X),
        cz: Math.floor(wz / CHUNK_SIZE_Z)
      };
    },
    getChunk() {
      return null;
    },
    markChunkDirty() {}
  };
  const chunk = new Chunk(0, 0, world);
  chunk.hasGenerated = true;
  for (let y = 0; y < 16; y++) {
    chunk.setLocalBlock(CHUNK_SIZE_X - 1, y, 4, BlockTypes.COLOR_BLOCK, 0x48dbfb);
  }

  const geometry = meshGeometry(chunk);
  const positions = geometry.getAttribute('position').array as Uint16Array;
  const normals = geometry.getAttribute('normal').array as Int8Array;
  const eastFaceY: number[] = [];
  for (let vertex = 0; vertex < normals.length / 3; vertex++) {
    if (normals[vertex * 3] !== 127) continue;
    eastFaceY.push(positions[vertex * 3 + 1]);
  }

  assert.deepEqual(eastFaceY.sort((a, b) => a - b), [0, 0, 16, 16]);
});

test('chunk occupancy bounds shrink lazily and constrain meshing height', () => {
  const chunk = new Chunk(0, 0, null);
  assert.equal(chunk.getOccupiedYRange(), null);

  chunk.setLocalBlock(2, 5, 3, BlockTypes.COLOR_BLOCK);
  chunk.setLocalBlock(2, 200, 3, BlockTypes.COLOR_BLOCK);
  assert.deepEqual(chunk.getOccupiedYRange(), { min: 5, max: 200 });

  chunk.setLocalBlock(2, 200, 3, BlockTypes.AIR);
  assert.deepEqual(chunk.getOccupiedYRange(), { min: 5, max: 5 });

  const group = new LowPolyMesher().buildChunkMesh(chunk);
  assert.equal(group.userData.occupiedMinY, 5);
  assert.equal(group.userData.occupiedMaxY, 6);
});

test('large exposed meshes promote their index buffer to 32 bits', () => {
  const chunk = new Chunk(0, 0, null);
  for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
        if ((lx + ly + lz) % 2 === 0) {
          chunk.setLocalBlock(lx, ly, lz, BlockTypes.COLOR_BLOCK);
        }
      }
    }
  }

  const geometry = meshGeometry(chunk);
  assert.ok(geometry.getAttribute('position').count > 0xffff);
  const positions = geometry.getAttribute('position').array as Uint16Array;
  let maximumPosition = 0;
  for (const value of positions) maximumPosition = Math.max(maximumPosition, value);
  assert.equal(
    maximumPosition,
    CHUNK_SIZE_Y,
    'the compact position format must retain the top boundary at y=256'
  );
  assert.ok(geometry.index?.array instanceof Uint32Array);
  const maxIndex = geometry.index
    ? geometry.index.array.reduce((maximum, value) => Math.max(maximum, value), 0)
    : 0;
  assert.equal(maxIndex, geometry.getAttribute('position').count - 1);
});

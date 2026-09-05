/// <reference lib="webworker" />

import { LowPolyMesher } from '../mesher/LowPolyMesher.ts';
import { TerrainGenerator } from '../worldgen/TerrainGenerator.ts';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Z } from './Chunk.ts';
import { wrapChunkX, wrapChunkZ, wrapX, wrapZ } from '../torus/TorusWorld.ts';

type PackedStandardEdit = [number, number, number, number, number];

type GenerateRequest = {
  type: 'generate';
  requestId: number;
  seed: number;
  cx: number;
  cz: number;
  standardEdits: PackedStandardEdit[];
  blocksBuffer?: ArrayBuffer;
  colorsBuffer?: ArrayBuffer;
};

type RemeshRequest = {
  type: 'remesh';
  requestId: number;
  seed: number;
  cx: number;
  cz: number;
  dataVersion: number;
  minOccupiedY: number;
  maxOccupiedY: number;
  blocksBuffer: ArrayBuffer;
  colorsBuffer: ArrayBuffer;
};

type TerrainWorkerRequest = GenerateRequest | RemeshRequest;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const meshers = new Map<number, LowPolyMesher>();
const generators = new Map<number, TerrainGenerator>();

function terrainSystems(seed: number) {
  let terrainGen = generators.get(seed);
  let mesher = meshers.get(seed);
  if (!terrainGen) {
    terrainGen = new TerrainGenerator(seed);
    generators.set(seed, terrainGen);
  }
  if (!mesher) {
    mesher = new LowPolyMesher();
    meshers.set(seed, mesher);
  }
  return { terrainGen, mesher };
}

function makeWorkerWorld(terrainGen: TerrainGenerator) {
  return {
    terrainGen,
    worldToChunkCoords(wx: number, wz: number) {
      const x = wrapX(wx);
      const z = wrapZ(wz);
      return {
        cx: Math.floor(x / CHUNK_SIZE_X),
        cz: Math.floor(z / CHUNK_SIZE_Z),
      };
    },
    // Worker jobs are self-contained. Missing neighbors are sampled from the
    // same deterministic generator by LowPolyMesher instead of being loaded.
    getChunk() {
      return null;
    },
    markChunkDirty() {},
  };
}

function transferableMeshBuffers(mesh) {
  const buffers: ArrayBuffer[] = [];
  for (const array of [mesh.positions, mesh.normals, mesh.colors, mesh.indices]) {
    if (array?.buffer instanceof ArrayBuffer) buffers.push(array.buffer);
  }
  return buffers;
}

workerScope.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const request = event.data;
  try {
    const { terrainGen, mesher } = terrainSystems(request.seed);
    const world = makeWorkerWorld(terrainGen);
    const chunk = new Chunk(wrapChunkX(request.cx), wrapChunkZ(request.cz), world);

    if (request.type === 'generate') {
      if (request.blocksBuffer && request.colorsBuffer) {
        chunk.blocks = new Uint8Array(request.blocksBuffer);
        chunk.colors = new Uint32Array(request.colorsBuffer);
      }
      terrainGen.generateChunk(chunk);
      for (const [x, y, z, block, color] of request.standardEdits) {
        chunk.setLocalBlock(x - chunk.cx * CHUNK_SIZE_X, y, z - chunk.cz * CHUNK_SIZE_Z, block, color);
      }
      const mesh = mesher.buildChunkMeshData(chunk);
      const response = {
        ok: true,
        type: request.type,
        requestId: request.requestId,
        cx: chunk.cx,
        cz: chunk.cz,
        hasUserEdits: request.standardEdits.length > 0,
        blocks: chunk.blocks,
        terrainColors: chunk.colors,
        mesh,
      };
      workerScope.postMessage(response, [
        chunk.blocks.buffer,
        chunk.colors.buffer,
        ...transferableMeshBuffers(mesh),
      ]);
      return;
    }

    chunk.blocks = new Uint8Array(request.blocksBuffer);
    chunk.colors = new Uint32Array(request.colorsBuffer);
    chunk.setGeneratedOccupiedYRange(request.minOccupiedY, request.maxOccupiedY);
    chunk.hasGenerated = true;
    const mesh = mesher.buildChunkMeshData(chunk);
    workerScope.postMessage({
      ok: true,
      type: request.type,
      requestId: request.requestId,
      cx: chunk.cx,
      cz: chunk.cz,
      dataVersion: request.dataVersion,
      mesh,
    }, transferableMeshBuffers(mesh));
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      type: request.type,
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};

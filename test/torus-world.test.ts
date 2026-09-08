import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/voxel/World.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../src/voxel/Chunk.ts';
import {
  TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_R, TORUS_RHO, TORUS_GREF,
  TORUS_SPAWN_X, TORUS_SPAWN_Z, EARTH_R, DEFAULT_WORLD_SHAPE_MODE,
  wrapX, wrapZ, wrapChunkX, wrapChunkZ,
  bendPoint, unbendPoint, bendDirection, unbendDirection, bendFrameQuaternion,
  getWorldShapeMode, normalizeWorldShapeMode, setWorldProjectionAnchor, setWorldShapeMode,
  applyCameraBend, computeChunkBentSphere, cullChunks, getWorldProjectionRevision,
  hookSceneMaterials
} from '../src/torus/TorusWorld.ts';

test('world shape defaults to earth while preserving an explicit torus choice', () => {
  try {
    assert.equal(DEFAULT_WORLD_SHAPE_MODE, 'earth');
    assert.equal(getWorldShapeMode(), 'earth');
    assert.equal(normalizeWorldShapeMode(null), 'earth');
    assert.equal(normalizeWorldShapeMode('torus'), 'torus');
  } finally {
    // The remaining geometry tests explicitly exercise the original torus projection.
    setWorldShapeMode('torus');
  }
});

test('torus wrap: coordinates normalize into [0, size)', () => {
  assert.equal(wrapX(16384), 0);
  assert.equal(wrapX(-1), 16383);
  assert.equal(wrapZ(2048), 0);
  assert.equal(wrapZ(-1), 2047);
  assert.equal(wrapChunkX(1024), 0);
  assert.equal(wrapChunkX(-1), 1023);
  assert.equal(wrapChunkZ(128), 0);
  assert.equal(wrapChunkZ(-1), 127);
});

test('torus bend is geometrically continuous across wrapped seams', () => {
  const a = bendPoint(16383.9, 16, 100);
  const b = bendPoint(-0.1, 16, 100);
  assert.ok(a.distanceTo(b) < 1e-3, 'geometry should be continuous across the X seam');
  const c = bendPoint(100, 16, 2047.9);
  const d = bendPoint(100, 16, -0.1);
  assert.ok(c.distanceTo(d) < 1e-3, 'geometry should be continuous across the Z seam');
});

test('torus unbend is the inverse of bend throughout the world', () => {
  // The 1024x128 ring ratio keeps R large enough to avoid folding throughout y∈[0,255].
  for (const [x, y, z] of [[0, 16, 0], [8192, 16, 1024], [16383, 30, 2047], [100, 2, 64], [14208, 255, 1600]]) {
    const bent = bendPoint(x, y, z);
    const flat = unbendPoint(bent.x, bent.y, bent.z);
    assert.ok(Math.abs(flat.x - x) < 1e-4, `x ${x} -> ${flat.x}`);
    assert.ok(Math.abs(flat.y - y) < 1e-4, `y ${y} -> ${flat.y}`);
    assert.ok(Math.abs(flat.z - z) < 1e-4, `z ${z} -> ${flat.z}`);
  }
});

test('torus frame is orthonormal and direction conversion round-trips', () => {
  const x = TORUS_SPAWN_X, y = 18, z = TORUS_SPAWN_Z;
  const q = bendFrameQuaternion(x, y, z);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  // At the inner ring (φ=π), the surface normal points toward the hole center (+X).
  assert.ok(Math.abs(up.x - 1) < 1e-4 && Math.abs(up.y) < 1e-4 && Math.abs(up.z) < 1e-4,
    `inner-ring normal should be +X, got (${up.x.toFixed(3)}, ${up.y.toFixed(3)}, ${up.z.toFixed(3)})`);

  const flatDir = new THREE.Vector3(0, 0, -1);
  const bent = bendDirection(x, y, z, flatDir);
  const back = unbendDirection(x, y, z, bent);
  assert.ok(back.distanceTo(flatDir) < 1e-4, 'locally linearized direction conversion should be reversible');
});

test('earth mode keeps the local world metric and coordinate conversion stable', () => {
  setWorldShapeMode('earth');
  setWorldProjectionAnchor(TORUS_SPAWN_X, TORUS_SPAWN_Z);
  try {
    assert.equal(getWorldShapeMode(), 'earth');
    const origin = bendPoint(TORUS_SPAWN_X, TORUS_GREF, TORUS_SPAWN_Z);
    assert.ok(origin.distanceTo(new THREE.Vector3(EARTH_R, 0, 0)) < 1e-6);

    const xStep = origin.distanceTo(bendPoint(TORUS_SPAWN_X + 1, TORUS_GREF, TORUS_SPAWN_Z));
    const zStep = origin.distanceTo(bendPoint(TORUS_SPAWN_X, TORUS_GREF, TORUS_SPAWN_Z + 1));
    assert.ok(Math.abs(xStep - 1) < 1e-4, `earth X step should remain one metre, got ${xStep}`);
    assert.ok(Math.abs(zStep - 1) < 1e-4, `earth Z step should remain one metre, got ${zStep}`);

    const flat = new THREE.Vector3(TORUS_SPAWN_X + 12, 27, TORUS_SPAWN_Z - 9);
    const bent = bendPoint(flat.x, flat.y, flat.z);
    const roundTrip = unbendPoint(bent.x, bent.y, bent.z);
    assert.ok(roundTrip.distanceTo(flat) < 1e-4, 'earth projection should invert near the active player');

    const direction = new THREE.Vector3(0.3, 0.4, -0.5).normalize();
    const bentDirection = bendDirection(flat.x, flat.y, flat.z, direction);
    const restoredDirection = unbendDirection(flat.x, flat.y, flat.z, bentDirection);
    assert.ok(restoredDirection.distanceTo(direction) < 1e-4, 'earth tangent frame should round-trip directions');

    const frame = bendFrameQuaternion(TORUS_SPAWN_X, TORUS_GREF, TORUS_SPAWN_Z);
    const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(frame);
    const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(frame);
    const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(frame);
    assert.ok(cameraRight.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-4,
      'earth camera right must match the torus frame at the player');
    assert.ok(cameraUp.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-4,
      'earth camera up must follow the globe surface normal');
    assert.ok(cameraForward.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-4,
      'earth camera forward must preserve the player look direction');

    const projectedSurface = bendPoint(flat.x, TORUS_GREF, flat.z).normalize();
    const projectedUp = bendDirection(flat.x, TORUS_GREF, flat.z, new THREE.Vector3(0, 1, 0));
    assert.ok(projectedUp.distanceTo(projectedSurface) < 1e-4,
      'earth lighting normal must match the projected surface normal');

    const beforeAnchorMove = bendPoint(flat.x, flat.y, flat.z);
    setWorldProjectionAnchor(TORUS_SPAWN_X + 100, TORUS_SPAWN_Z + 100);
    const afterAnchorMove = bendPoint(flat.x, flat.y, flat.z);
    assert.ok(afterAnchorMove.distanceTo(beforeAnchorMove) < 1e-9,
      'earth projection anchor must stay fixed while the player moves');
  } finally {
    setWorldShapeMode('torus');
  }
});

test('torus world setBlock and getBlock wrap automatically', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setBlock(-1, 10, -1, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  assert.equal(world.getBlock(16383, 10, 2047), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(-1, 10, -1), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlockColor(-1, 10, -1), 0x48dbfb);
  // Equivalence: (-1,-1) ≡ (16383,2047), and (16384,2048) ≡ (0,0).
  assert.equal(world.getBlock(16384, 10, 2048), world.getBlock(0, 10, 0));
});

test('spawn preparation synchronously generates every chunk touched at a boundary', () => {
  const world = new World(new THREE.Scene()) as any;
  const prepared = world.preparePlayerSpawnArea(16, 16, 0.3);

  assert.equal(prepared, 4);
  assert.ok(world.getChunk(0, 0));
  assert.ok(world.getChunk(0, 1));
  assert.ok(world.getChunk(1, 0));
  assert.ok(world.getChunk(1, 1));
});

test('torus world raycastBent hits a known block', () => {
  const world = new World(new THREE.Scene()) as any;
  // Clear nearby terrain so procedural columns cannot occlude the known target.
  for (let x = 8; x <= 12; x++) {
    for (let z = 8; z <= 12; z++) {
      for (let y = 0; y <= 30; y++) world.setBlock(x, y, z, BlockTypes.AIR, false);
    }
  }
  world.setBlock(10, 5, 10, BlockTypes.COLOR_BLOCK, false, 0xff3366);

  const origin = bendPoint(10, 30, 10);
  const target = bendPoint(10, 5, 10);
  const dir = target.clone().sub(origin).normalize();
  const hit = world.raycastBent(origin, dir, 30);
  assert.equal(hit.hit, true);
  assert.equal(hit.kind, 'standard');
  assert.deepEqual(hit.hitPos, { x: 10, y: 5, z: 10 });
  assert.deepEqual(hit.normal, { x: 0, y: 1, z: 0 }, 'a top hit should point its normal toward air');
  assert.deepEqual(hit.placePos, { x: 10, y: 6, z: 10 }, 'placement should use the air side of the hit face');
  assert.equal(hit.color, 0xff3366);
  assert.ok(hit.entry && Math.abs(hit.entry.y - 6) < 1e-6, 'entry should lie on the hit block top face');
});

test('torus world raycastMicroBent hits a known microcell', () => {
  const world = new World(new THREE.Scene()) as any;
  for (let x = 8; x <= 12; x++) {
    for (let z = 8; z <= 12; z++) {
      for (let y = 0; y <= 30; y++) world.setBlock(x, y, z, BlockTypes.AIR, false);
    }
  }
  world.setMicroBlock(80, 40, 80, 0x12abef);
  world.microVoxels.updateMesh();
  const origin = bendPoint(10, 30, 10);
  const target = bendPoint(10, 5, 10);
  const dir = target.clone().sub(origin).normalize();
  const hit = world.raycastMicroBent(origin, dir, 30);
  assert.equal(hit.hit, true);
  assert.equal(hit.kind, 'micro');
  assert.equal(hit.color, 0x12abef);
  assert.ok(hit.microPos.x >= 78 && hit.microPos.x <= 82, 'hit should be near microcell x=80');
  assert.ok(hit.microPos.y >= 38 && hit.microPos.y <= 42, 'hit should be near microcell y=40');
  assert.ok(hit.hitPos.x >= 9.6 && hit.hitPos.x <= 10.4, 'hitPos should use world units rather than integer microcells');
  assert.deepEqual(hit.normal, { x: 0, y: 1, z: 0 }, 'microcell top-face normal should point toward air');
});

test('bent micro raycast cannot tunnel through the published mesh during a rebuild', () => {
  const world = new World(new THREE.Scene()) as any;
  const mx = TORUS_SPAWN_X * 8;
  const topMy = 161;
  const mz = TORUS_SPAWN_Z * 8;
  world.setMicroBlock(mx, topMy - 1, mz, 0x00ff00);
  world.setMicroBlock(mx, topMy, mz, 0xff0000);
  world.microVoxels.updateMesh();

  const publishedMesh = world.microVoxels.meshChunks.values().next().value;
  const origin = bendPoint(mx / 8 + 0.0625, 30, mz / 8 + 0.0625);
  const target = bendPoint(mx / 8 + 0.0625, (topMy - 1) / 8 + 0.0625, mz / 8 + 0.0625);
  const direction = target.clone().sub(origin).normalize();
  assert.equal(world.raycastMicroBent(origin, direction, 20).microPos.y, topMy);

  world.removeMicroBlock(mx, topMy, mz);
  world.microVoxels.updateMesh(1, null, null, 0);

  assert.equal(world.microVoxels.meshChunks.values().next().value, publishedMesh,
    'the previous complete mesh stays visible while the replacement is pending');
  const pendingHit = world.raycastMicroBent(origin, direction, 20);
  assert.equal(pendingHit.microPos.y, topMy,
    'picking must stay on the same visible surface until mesh publication');
  assert.equal(pendingHit.color, 0xff0000,
    'the pending pick should retain the published voxel color');
  assert.equal(world.raycastMicroBent(origin, direction, 20, false).microPos.y, topMy - 1,
    'a scoped live destructive query may advance without changing the published hover surface');

  while (world.microVoxels.dirty) world.microVoxels.updateMesh();
  assert.equal(world.raycastMicroBent(origin, direction, 20).microPos.y, topMy - 1,
    'picking may advance to the voxel behind only after the replacement mesh publishes');
});

test('standard-to-micro conversion keeps picking on the visible standard mesh', () => {
  const world = new World(new THREE.Scene()) as any;
  const wx = TORUS_SPAWN_X;
  const wy = 200;
  const wz = TORUS_SPAWN_Z;
  world.setRenderDistance(3);
  world.updateChunksAround(wx, wz);
  world.setBlock(wx, wy, wz, BlockTypes.COLOR_BLOCK, true, 0x12abef);
  world.updateChunksAround(wx, wz);

  const chunk = world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16));
  const publishedMesh = chunk.mesh;
  const origin = bendPoint(wx + 0.5, wy + 5, wz + 0.5);
  const target = bendPoint(wx + 0.5, wy + 0.5, wz + 0.5);
  const direction = target.clone().sub(origin).normalize();
  assert.deepEqual(world.raycastBent(origin, direction, 8).hitPos, { x: wx, y: wy, z: wz });

  assert.equal(world.subdivideBlock(wx, wy, wz), 512);
  assert.equal(chunk.mesh, publishedMesh,
    'the standard mesh remains visible until the micro replacement is ready');
  const pendingStandardHit = world.raycastBent(origin, direction, 8);
  assert.deepEqual(pendingStandardHit.hitPos, { x: wx, y: wy, z: wz },
    'rapid follow-up picking must not pass through the visible standard voxel');
  assert.equal(pendingStandardHit.color, 0x12abef);
  assert.equal(world.raycastMicroBent(origin, direction, 8).hit, false,
    'the new micro cells stay unpickable until their mesh is published');
});

test('bent micro ray returns the exact rendered face point near an edge', () => {
  const world = new World(new THREE.Scene()) as any;
  const mx = TORUS_SPAWN_X * 8;
  const my = 80 * 8;
  const mz = (TORUS_SPAWN_Z + 6.375) * 8;
  world.setMicroBlock(mx, my, mz, 0xff44aa);
  world.microVoxels.updateMesh();

  const visibleTarget = new THREE.Vector3(mx / 8 + 0.0625, my / 8 + 0.01, mz / 8);
  const eyeFlat = new THREE.Vector3(visibleTarget.x, visibleTarget.y, TORUS_SPAWN_Z);
  const eyeBent = bendPoint(eyeFlat.x, eyeFlat.y, eyeFlat.z);
  const targetBent = bendPoint(visibleTarget.x, visibleTarget.y, visibleTarget.z);
  const hit = world.raycastMicroBent(
    eyeBent,
    targetBent.clone().sub(eyeBent).normalize(),
    8
  );

  assert.equal(hit.hit, true);
  assert.deepEqual(hit.microPos, { x: mx, y: my, z: mz });
  assert.deepEqual(hit.normal, { x: 0, y: 0, z: -1 });
  const entry = new THREE.Vector3(hit.entry.x, hit.entry.y, hit.entry.z);
  assert.ok(entry.distanceTo(visibleTarget) < 1e-4, 'entry should coincide with the GPU-bent face under the crosshair');
});

test('torus constants preserve R/r=8 for the scaled 1024x128 chunk world', () => {
  assert.equal(TORUS_SIZE_X, 16384);
  assert.equal(TORUS_SIZE_Z, 2048);
  assert.ok(Math.abs(TORUS_R / TORUS_RHO - 8) < 1e-9, 'R:r should equal the 8:1 aspect ratio');
  assert.equal(TORUS_GREF, 16);
  assert.equal(CHUNK_SIZE_Y, 256);
  assert.ok(TORUS_RHO + (CHUNK_SIZE_Y - 1 - TORUS_GREF) < TORUS_R - 1, 'the full build height should not trigger fold protection');

  const atSpawn = bendPoint(TORUS_SPAWN_X, 16, TORUS_SPAWN_Z);
  const xEdge = atSpawn.distanceTo(bendPoint(TORUS_SPAWN_X + 1, 16, TORUS_SPAWN_Z));
  const zEdge = atSpawn.distanceTo(bendPoint(TORUS_SPAWN_X, 16, TORUS_SPAWN_Z + 1));
  assert.ok(xEdge > 0.874 && xEdge < 0.876, `inner-ring X edges should compress only 12.5%, got ${xEdge}`);
  assert.ok(Math.abs(zEdge - 1) < 0.001, `inner-ring Z edges should remain about one cell, got ${zEdge}`);
});

test('torus rendering starts with no synthetic far terrain and preserves near-field culling contracts', () => {
  const world = new World(new THREE.Scene()) as any;
  assert.equal(world.distantSurface.mesh.userData.distantSurfaceZones, true);
  assert.equal(world.distantSurface.mesh.visible, false);
  assert.equal(world.distantSurface.loadedZones.size, 0);
  assert.equal(world.distantSurface.mesh.geometry.instanceCount, 0,
    'unvisited terrain must not be replaced with synthetic geometry');

  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z);
  const expectedChunkCount = (2 * world.renderDistance + 1) ** 2;
  assert.ok(world.chunks.size > 0 && world.chunks.size <= 6,
    'the first streaming frame should allocate only the nearest bounded chunk batch');
  assert.equal(world.activeChunkKeys.size, expectedChunkCount,
    'the full configured window should be tracked while allocation proceeds');
  const meshed = [...world.chunks.values()].filter((chunk: any) => chunk.mesh);
  assert.equal(meshed.length, 1, 'only one expensive chunk mesh should build per frame');
  const detailMask = world.distantSurface.detailMaskTexture.image.data as Uint8Array;
  for (const chunk of meshed) {
    const maskIndex = chunk.cz * (TORUS_SIZE_X / 16) + chunk.cx;
    assert.equal(detailMask[maskIndex], 255,
      'far terrain must be hidden only after the detailed chunk mesh is ready');
    chunk.mesh.traverse((child) => {
      if (!child.isMesh) return;
      assert.equal(child.frustumCulled, false, 'child meshes must not be culled again by flat bounding spheres');
      if (child.castShadow) {
        assert.ok(child.customDepthMaterial, 'new chunks need torus depth material before attachment to prevent edit flicker');
      }
    });
  }

  world.setMicroBlock(TORUS_SPAWN_X * 8, 20 * 8, TORUS_SPAWN_Z * 8, 0x48dbfb);
  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z);
  assert.ok(world.microVoxels.mesh, 'microvoxel mesh should rebuild in the edit frame');
  assert.equal(world.microVoxels.mesh.frustumCulled, false, 'new microvoxel mesh should use torus culling immediately');
  assert.ok(world.microVoxels.mesh.customDepthMaterial, 'new microvoxel mesh should get torus depth material immediately');
});

test('simulation refreshes the active window without spending another mesh budget', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z, false);

  assert.equal(world.activeChunkKeys.size, 49);
  assert.equal(world.chunks.size, 0, 'simulation-only streaming must not synchronously generate chunks');

  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z);
  assert.ok(world.chunks.size > 0, 'the render-frame budget should still progress chunk streaming');
});

test('initial AOI preload waits until every active terrain chunk is published', async () => {
  const world = new World(new THREE.Scene()) as any;
  // Keep the focused test to a 3x3 AOI without changing the production clamp.
  world.renderDistance = 1;
  const progress: any[] = [];

  const complete = await world.preloadTerrainAoi(
    TORUS_SPAWN_X,
    TORUS_SPAWN_Z,
    (value: any) => progress.push(value),
  );

  assert.deepEqual(complete, { readyChunks: 9, totalChunks: 9, ready: true });
  assert.equal(progress.at(0).readyChunks < 9, true);
  assert.equal(progress.at(-1).ready, true);
  for (const key of world.activeChunkKeys) {
    assert.ok(world.chunks.get(key)?.mesh, `AOI chunk ${key} must be published before entry`);
  }
});

test('off-thread streaming leaves unfinished chunks empty and non-colliding', () => {
  const world = new World(new THREE.Scene()) as any;
  const requests: any[] = [];
  world.terrainWorker = {
    postMessage(request: any) {
      requests.push(request);
    },
  };
  world.setRenderDistance(3);
  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z, false);
  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z, true, 1, true);

  assert.equal(requests.length, 1, 'streaming should dispatch one complete worker job');
  assert.equal(requests[0].type, 'generate');
  assert.equal(world.chunks.size, 0, 'dispatching work must not publish partial collision data');
  assert.equal(
    world.getBlock(TORUS_SPAWN_X, 0, TORUS_SPAWN_Z),
    BlockTypes.AIR,
    'an unfinished chunk must behave as air to player and entity physics',
  );
  world.setMicroBlock(TORUS_SPAWN_X * 8, 5, TORUS_SPAWN_Z * 8, 0x48dbfb);
  assert.deepEqual(world.getMicroBlocksInAABB({
    minX: TORUS_SPAWN_X,
    maxX: TORUS_SPAWN_X + 0.2,
    minY: 1,
    maxY: 1.2,
    minZ: TORUS_SPAWN_Z,
    maxZ: TORUS_SPAWN_Z + 0.2,
  }, true), [], 'unpublished micro meshes must not create invisible collision');
  assert.equal(
    world.getMicroCollisionBlock(TORUS_SPAWN_X * 8, 5, TORUS_SPAWN_Z * 8),
    null,
    'point collision probes must follow the same unpublished-chunk rule',
  );
});

test('interactive standard edits bypass idle-only terrain scheduling', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  assert.ok(chunk?.mesh);
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();

  const requests: any[] = [];
  world.terrainWorker = {
    postMessage(request: any) {
      requests.push(request);
    },
  };
  world.requireOffThreadTerrainStreaming = true;

  assert.equal(world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, true, 0x48dbfb), true);
  assert.equal(requests.length, 0, 'the input handler should only mutate lightweight world data');
  assert.equal(world.processInteractiveTerrainWork(), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'remesh');
  assert.equal(requests[0].dataVersion, chunk.dataVersion);
});

test('continuous edits publish newer completed meshes without waiting for input to stop', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  assert.ok(chunk?.mesh);
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();

  const requests: any[] = [];
  world.terrainWorker = {
    postMessage(request: any) {
      requests.push(request);
    },
  };
  world.requireOffThreadTerrainStreaming = true;

  world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, true, 0x48dbfb);
  const firstMeshData = world.mesher.buildChunkMeshData(chunk);
  world.processInteractiveTerrainWork();
  const firstJob = world.terrainWorkerJob;
  const firstVersion = firstJob.dataVersion;
  const meshBeforeWorkerResult = chunk.mesh;

  world.setBlock(2, 200, 1, BlockTypes.COLOR_BLOCK, true, 0x22c55e);
  assert.ok(chunk.dataVersion > firstVersion);
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job: firstJob,
    result: {
      ok: true,
      type: 'remesh',
      requestId: firstJob.requestId,
      cx: 0,
      cz: 0,
      dataVersion: firstVersion,
      mesh: firstMeshData,
    },
  });

  assert.equal(world.processInteractiveTerrainWork(), true);
  assert.notEqual(chunk.mesh, meshBeforeWorkerResult,
    'the finished first edit should become visible even though a newer edit exists');
  assert.equal(chunk.publishedDataVersion, firstVersion);
  assert.equal(world.dirtyChunks.has(chunk), true,
    'the newer edit must remain queued after the intermediate mesh is published');
  assert.equal(requests.length, 2, 'the latest chunk state should immediately start another remesh');
  assert.equal(requests[1].dataVersion, chunk.dataVersion);
});

test('a dirty micro mesh keeps its already-published collision live', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  assert.ok(world.getChunk(0, 0)?.mesh);

  assert.equal(world.setMicroBlock(8, 1_600, 8, 0x112233), true);
  world.microVoxels.updateMesh();
  assert.equal(world.setMicroBlock(8, 1_600, 8, 0x445566), true);

  const collision = world.getMicroBlocksInAABB({
    minX: 1,
    maxX: 1.1249,
    minY: 200,
    maxY: 200.1249,
    minZ: 1,
    maxZ: 1.1249,
  }, true);
  assert.equal(collision.length, 1,
    'marking the 4 m render partition dirty must not disable its collision');
  assert.equal(world.getMicroCollisionBlock(8, 1_600, 8)?.color, 0x112233,
    'collision and picking should retain the color represented by the published mesh');
  world.microVoxels.updateMesh();
  assert.equal(world.getMicroCollisionBlock(8, 1_600, 8)?.color, 0x445566,
    'the new color becomes visible atomically with its replacement mesh');
});

test('a standard remesh swaps detailed geometry without clearing its ownership mask', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  assert.ok(chunk?.mesh);
  const previousMesh = chunk.mesh;
  const transitions: boolean[] = [];
  const setDetailChunkReady = world.distantSurface.setDetailChunkReady.bind(world.distantSurface);
  world.distantSurface.setDetailChunkReady = (cx, cz, ready) => {
    if (cx === 0 && cz === 0) transitions.push(ready);
    return setDetailChunkReady(cx, cz, ready);
  };

  world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));

  assert.notEqual(chunk.mesh, previousMesh);
  assert.equal(previousMesh.parent, null, 'the retired mesh should leave the scene after replacement');
  assert.deepEqual(transitions, [true], 'a remesh must never expose the far-surface fallback');
});

test('subdivision publishes standard and micro replacement meshes at one commit point', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.dirtyChunks.delete(chunk);
  const standardBeforeSubdivision = chunk.mesh;

  assert.equal(world.subdivideBlock(1, 200, 1), 512);
  world.microVoxels.updateMesh(
    Infinity,
    world.activeChunkKeys,
    null,
    Infinity,
    world.crossLayerPublicationChunks,
  );
  assert.equal(chunk.mesh, standardBeforeSubdivision,
    'the old standard block should remain visible while its micro replacement is staged');
  assert.equal(world.microVoxels.meshChunks.size, 0,
    'coplanar micro faces must not publish early and z-fight the standard block');

  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.commitCrossLayerPublication('0,0');
  assert.notEqual(chunk.mesh, standardBeforeSubdivision);
  assert.ok(world.microVoxels.mesh, 'the micro replacement should publish in the same task');
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), false);
});

test('leaving a cross-layer edit chunk cannot block the global worker result queue', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.pendingStreamChunks = [];
  world.dirtyChunks.clear();
  world.subdivideBlock(1, 200, 1);
  world.terrainWorker = { postMessage() {} };
  world.updateChunksAround(0, 0, true, 50, true);

  const job = world.terrainWorkerJob;
  world.terrainWorkerJob = null;
  world.completedTerrainWorkerJobs.push({
    job,
    result: {
      ok: true,
      type: 'remesh',
      requestId: job.requestId,
      cx: 0,
      cz: 0,
      dataVersion: job.dataVersion,
      mesh: world.mesher.buildChunkMeshData(chunk),
    },
  });

  world.updateChunksAround(10 * 16, 0, true, 50, true);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), false,
    'leaving the active window should abort the local publication barrier');
  world.updateChunksAround(10 * 16, 0, true, 50, true);
  assert.equal(world.completedTerrainWorkerJobs.length, 0,
    'the inactive result must be discarded instead of blocking every later terrain job');
});

test('a cross-layer edit resumes when its chunk quickly leaves and re-enters', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(0, 0);
  const chunk = world.getChunk(0, 0);
  world.setBlock(1, 200, 1, BlockTypes.COLOR_BLOCK, false, 0x48dbfb);
  world.publishChunkMesh(chunk, world.mesher.buildChunkMeshData(chunk));
  world.dirtyChunks.delete(chunk);

  world.subdivideBlock(1, 200, 1);
  world.microVoxels.updateMesh(
    Infinity,
    world.activeChunkKeys,
    null,
    Infinity,
    world.crossLayerPublicationChunks,
  );
  world.updateChunksAround(10 * 16, 0, false);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), false);
  assert.equal(world.suspendedCrossLayerPublicationChunks.has('0,0'), true);

  world.updateChunksAround(0, 0, false);
  assert.equal(world.suspendedCrossLayerPublicationChunks.has('0,0'), false);
  assert.equal(world.crossLayerPublicationChunks.has('0,0'), true,
    'the atomic standard/micro publication requirement must resume on re-entry');
  assert.equal(world.dirtyChunks.has(chunk), true,
    'the edited standard chunk must be queued for the remesh that was interrupted');
});

test('render-loop streaming waits for browser idle time', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z, false);
  assert.equal(world.chunks.size, 0);

  const previousRequestIdleCallback = globalThis.requestIdleCallback;
  let idleCallback: IdleRequestCallback | null = null;
  globalThis.requestIdleCallback = ((callback: IdleRequestCallback) => {
    idleCallback = callback;
    return 1;
  }) as typeof requestIdleCallback;
  try {
    world.scheduleStreamingWork();
    assert.equal(world.chunks.size, 0, 'scheduling alone must not run before the current render');
    idleCallback!({ didTimeout: false, timeRemaining: () => 4 });
    assert.ok(world.chunks.size > 0, 'an idle slice should advance terrain streaming');
  } finally {
    globalThis.requestIdleCallback = previousRequestIdleCallback;
  }
});

test('earth projection culls distant terrain with occupied-height bounds', () => {
  setWorldShapeMode('earth');
  setWorldProjectionAnchor(TORUS_SPAWN_X, TORUS_SPAWN_Z, true);
  try {
    const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 90);
    camera.position.set(TORUS_SPAWN_X, 22, TORUS_SPAWN_Z);
    camera.lookAt(TORUS_SPAWN_X, 22, TORUS_SPAWN_Z - 1);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    applyCameraBend(camera);

    const centerCx = Math.floor(TORUS_SPAWN_X / 16);
    const centerCz = Math.floor(TORUS_SPAWN_Z / 16);
    const chunks = new Map();
    const microMeshes = new Map();
    const activeChunkKeys = new Set<string>();
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        const cx = centerCx + dx;
        const cz = centerCz + dz;
        const key = `${cx},${cz}`;
        const mesh = new THREE.Group();
        mesh.userData.occupiedMinY = 0;
        mesh.userData.occupiedMaxY = 33;
        const microMesh = new THREE.Mesh();
        const terrainChild = new THREE.Mesh();
        terrainChild.castShadow = true;
        mesh.add(terrainChild);
        microMesh.castShadow = true;
        microMesh.userData.standardChunkKey = key;
        microMesh.userData.projectionChunkCx = cx;
        microMesh.userData.projectionChunkCz = cz;
        microMesh.userData.bentSpan = 4;
        microMesh.userData.occupiedMinY = 14;
        microMesh.userData.occupiedMaxY = 18;
        chunks.set(key, {
          cx,
          cz,
          mesh,
          getOccupiedYRange: () => ({ min: 0, max: 32 }),
        });
        microMeshes.set(key, microMesh);
        activeChunkKeys.add(key);
      }
    }

    cullChunks(camera, { chunks, activeChunkKeys, microVoxels: { meshChunks: microMeshes } });
    const visible = [...chunks.values()].filter(chunk => chunk.mesh.visible).length;
    const visibleMicro = [...microMeshes.values()].filter(mesh => mesh.visible).length;
    const shadowCasters = [...chunks.values()].filter(chunk => chunk.mesh.children[0].castShadow).length;
    const microShadowCasters = [...microMeshes.values()].filter(mesh => mesh.castShadow).length;
    assert.ok(visible > 0);
    assert.ok(visible < chunks.size, `earth culling should reject distant chunks, got ${visible}/${chunks.size}`);
    assert.ok(visibleMicro > 0 && visibleMicro < microMeshes.size,
      `earth culling should also reject distant micro meshes, got ${visibleMicro}/${microMeshes.size}`);
    assert.ok(shadowCasters > 0 && shadowCasters < visible,
      'only terrain near the player should enter the local sunlight shadow pass');
    assert.ok(microShadowCasters > 0 && microShadowCasters < visibleMicro,
      'far visible micro meshes should stay out of the local sunlight shadow pass');
    for (const chunk of chunks.values()) {
      assert.equal(chunk.mesh.userData.bentSphereRevision, getWorldProjectionRevision());
      assert.ok(chunk.mesh.userData.bentSphere.radius < 40,
        'terrain-height bounds should replace the old full 256-block sphere');
    }

    const fullHeight = computeChunkBentSphere(centerCx, centerCz);
    const terrainHeight = computeChunkBentSphere(centerCx, centerCz, null, 0, 33);
    assert.ok(terrainHeight.radius < fullHeight.radius / 2);
  } finally {
    setWorldShapeMode('torus');
  }
});

test('earth mode disables every distant terrain LOD and donut mode restores it', () => {
  const world = new World(new THREE.Scene()) as any;
  assert.equal(world.distantSurface.isEnabled(), true);
  world.setDistantSurfaceEnabled(false);
  assert.equal(world.distantSurface.isEnabled(), false);
  assert.equal(world.distantSurface.mesh.visible, false);
  assert.equal(world.distantSurface.sideMesh.visible, false);
  world.setDistantSurfaceEnabled(true);
  assert.equal(world.distantSurface.isEnabled(), true);
});

test('chunk streaming evicts procedural arrays but retains authored edits', () => {
  const world = new World(new THREE.Scene()) as any;
  world.setRenderDistance(3);
  world.updateChunksAround(TORUS_SPAWN_X, TORUS_SPAWN_Z);

  const center = world.worldToChunkCoords(TORUS_SPAWN_X, TORUS_SPAWN_Z);
  const editedKey = `${center.cx},${center.cz}`;
  const uneditedKey = `${center.cx + 1},${center.cz}`;
  const detailMask = world.distantSurface.detailMaskTexture.image.data as Uint8Array;
  const centerMaskIndex = center.cz * (TORUS_SIZE_X / 16) + center.cx;
  assert.equal(detailMask[centerMaskIndex], 255, 'the initial detailed chunk should own its pixels');
  assert.equal(world.setBlock(TORUS_SPAWN_X, 255, TORUS_SPAWN_Z, BlockTypes.COLOR_BLOCK), true);
  assert.equal(world.setBlock(TORUS_SPAWN_X, 256, TORUS_SPAWN_Z, BlockTypes.COLOR_BLOCK), false);
  assert.equal(world.chunks.get(editedKey).hasUserEdits, true);

  world.updateChunksAround(TORUS_SPAWN_X + 10 * 16, TORUS_SPAWN_Z);
  world.updateChunksAround(TORUS_SPAWN_X + 10 * 16, TORUS_SPAWN_Z);
  assert.equal(detailMask[centerMaskIndex], 0,
    'far terrain must resume before an old detailed chunk leaves the active window');
  assert.equal(world.chunks.has(editedKey), true, 'authored chunks must remain available for persistence/re-entry');
  assert.equal(world.chunks.has(uneditedKey), false, 'procedural chunks should be regenerated instead of retained');
  assert.ok(world.chunks.size <= world.activeChunkKeys.size + 1,
    'progressive streaming may leave active chunks pending without retaining inactive procedural chunks');
  for (const chunk of world.dirtyChunks) {
    assert.equal(world.activeChunkKeys.has(`${chunk.cx},${chunk.cz}`), true, 'inactive chunks must leave the rebuild queue');
  }
});

test('torus rendering avoids flat-space culling for runtime selections and entities', () => {
  const scene = new THREE.Scene();
  const selection = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial()
  );
  const entity = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const distant = new THREE.Mesh(new THREE.TorusGeometry(), new THREE.MeshBasicMaterial());
  distant.userData.torusPreBent = true;
  scene.add(selection, entity, distant);

  hookSceneMaterials(scene);

  assert.equal(selection.frustumCulled, false, 'GPU-bent selection wireframes must not use flat bounding spheres');
  assert.equal(entity.frustumCulled, false, 'GPU-bent entity meshes must not use flat bounding spheres');
  assert.equal(distant.frustumCulled, true, 'prebent LOD can use native bent-space culling');
});

test('earth shadows use the same live projection as visible geometry', () => {
  const scene = new THREE.Scene();
  const caster = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  caster.castShadow = true;
  scene.add(caster);
  hookSceneMaterials(scene);

  const shader: any = {
    uniforms: {},
    vertexShader: 'void main() { vec3 transformed = position; #include <project_vertex> }',
  };
  caster.customDepthMaterial.onBeforeCompile(shader, null);
  assert.match(shader.vertexShader, /earthBend/);
  assert.ok(shader.uniforms.uWorldProjectionAnchor, 'shadow depth shader needs the live earth anchor');

  setWorldShapeMode('earth');
  try {
    assert.equal(shader.uniforms.uWorldShapeMode.value, 1,
      'shadow depth shader must switch projection together with visible materials');
  } finally {
    setWorldShapeMode('torus');
  }
});

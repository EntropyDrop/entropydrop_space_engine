import * as THREE from 'three';
import type { SurfaceZoneSnapshot } from '../voxel/SurfaceZoneSnapshot.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, hookSceneMaterials } from '../torus/TorusWorld.ts';

const CHUNK_SIZE = 16;
const ZONE_SIZE_CHUNKS = 32;
const ZONE_WORLD_SIZE = CHUNK_SIZE * ZONE_SIZE_CHUNKS;
const FINE_SAMPLE_SIZE = 2;
const FINE_SAMPLES_PER_CHUNK_AXIS = CHUNK_SIZE / FINE_SAMPLE_SIZE;
const MAX_SURFACE_INSTANCES = 512 * 1024;
const MAX_SURFACE_CONNECTIONS = 1024 * 1024;
const LOD_SAMPLE_SIZES = [2, 4, 8, 16, 32, 64] as const;
const FINE_WORLD_Z_AXIS = TORUS_SIZE_Z / FINE_SAMPLE_SIZE;
const WORLD_CHUNKS_X = TORUS_SIZE_X / CHUNK_SIZE;
const WORLD_CHUNKS_Z = TORUS_SIZE_Z / CHUNK_SIZE;
const DISTANCE_STEP = 50;

export interface DistantSurfaceSettings {
  lod2Distance: number;
  lod4Distance: number;
  lod8Distance: number;
  lod16Distance: number;
  lod32Distance: number;
  maxDistance: number;
  connectionDistance: number;
  lod2Enabled: boolean;
  lod4Enabled: boolean;
  lod8Enabled: boolean;
  lod16Enabled: boolean;
  lod32Enabled: boolean;
  lod64Enabled: boolean;
}

export type DistantSurfaceSettingKey = keyof DistantSurfaceSettings;
export type DistantSurfaceDistanceSettingKey =
  | 'lod2Distance'
  | 'lod4Distance'
  | 'lod8Distance'
  | 'lod16Distance'
  | 'lod32Distance'
  | 'maxDistance'
  | 'connectionDistance';
export type DistantSurfaceEnabledSettingKey =
  | 'lod2Enabled'
  | 'lod4Enabled'
  | 'lod8Enabled'
  | 'lod16Enabled'
  | 'lod32Enabled'
  | 'lod64Enabled';

export const DEFAULT_DISTANT_SURFACE_SETTINGS: Readonly<DistantSurfaceSettings> = Object.freeze({
  lod2Distance: 400,
  lod4Distance: 600,
  lod8Distance: 800,
  lod16Distance: 1000,
  lod32Distance: 1600,
  maxDistance: 8500,
  connectionDistance: 4000,
  lod2Enabled: true,
  lod4Enabled: true,
  lod8Enabled: true,
  lod16Enabled: true,
  lod32Enabled: true,
  lod64Enabled: true,
});

export const DISTANT_SURFACE_SETTING_LIMITS = Object.freeze({
  lod2Distance: Object.freeze({ min: 100, max: 500, step: DISTANCE_STEP }),
  lod4Distance: Object.freeze({ min: 150, max: 1000, step: DISTANCE_STEP }),
  lod8Distance: Object.freeze({ min: 200, max: 1600, step: DISTANCE_STEP }),
  lod16Distance: Object.freeze({ min: 250, max: 3000, step: DISTANCE_STEP }),
  lod32Distance: Object.freeze({ min: 300, max: 8450, step: DISTANCE_STEP }),
  maxDistance: Object.freeze({ min: 350, max: 8500, step: DISTANCE_STEP }),
  connectionDistance: Object.freeze({ min: 0, max: 8500, step: 250 }),
});

const LOD_SETTING_KEYS = [
  'lod2Distance',
  'lod4Distance',
  'lod8Distance',
  'lod16Distance',
  'lod32Distance',
] as const;
const LOD_ENABLED_KEYS = [
  'lod2Enabled',
  'lod4Enabled',
  'lod8Enabled',
  'lod16Enabled',
  'lod32Enabled',
  'lod64Enabled',
] as const;
const ORDERED_DISTANCE_KEYS = [...LOD_SETTING_KEYS, 'maxDistance'] as const;

function snapDistance(value: unknown, fallback: number, step: number) {
  const numeric = Number(value);
  return Math.round((Number.isFinite(numeric) ? numeric : fallback) / step) * step;
}

export function normalizeDistantSurfaceSettings(
  value: Partial<DistantSurfaceSettings> | null | undefined,
): DistantSurfaceSettings {
  const normalized = {} as DistantSurfaceSettings;
  let previous = -DISTANCE_STEP;
  for (const key of ORDERED_DISTANCE_KEYS) {
    const limits = DISTANT_SURFACE_SETTING_LIMITS[key];
    const candidate = snapDistance(
      value?.[key],
      DEFAULT_DISTANT_SURFACE_SETTINGS[key],
      limits.step,
    );
    normalized[key] = Math.max(
      limits.min,
      previous + DISTANCE_STEP,
      Math.min(limits.max, candidate),
    );
    previous = normalized[key];
  }
  for (const key of LOD_ENABLED_KEYS) {
    normalized[key] = typeof value?.[key] === 'boolean'
      ? value[key]
      : DEFAULT_DISTANT_SURFACE_SETTINGS[key];
  }
  const connectionLimits = DISTANT_SURFACE_SETTING_LIMITS.connectionDistance;
  normalized.connectionDistance = Math.max(
    connectionLimits.min,
    Math.min(
      connectionLimits.max,
      snapDistance(
        value?.connectionDistance,
        DEFAULT_DISTANT_SURFACE_SETTINGS.connectionDistance,
        connectionLimits.step,
      ),
    ),
  );
  return normalized;
}
// Move the far topology anchor in 64 m increments. Ordinary chunk crossings
// then avoid rebuilding roughly 190k surface cells; a separate ready mask
// handles the exact per-chunk transition to detailed terrain.
const LOD_CENTER_STEP_CHUNKS = 4;
// A topology move may inspect roughly 190k cells. Work in short macrotasks so
// connection generation cannot consume a complete 8.33 ms frame at 120 Hz.
const CONNECTION_BUILD_BUDGET_MS = 2;
// Voxel colors are authored and serialized as sRGB hex values. Three.Color.setHex,
// used by the detailed chunk mesher, converts those values to linear RGB before
// placing them in a vertex attribute. Do the same conversion here so the two
// terrain layers receive identical lighting and tone mapping at their seam.
const SRGB_TO_LINEAR_BYTE = Uint8Array.from({ length: 256 }, (_, value) => {
  const srgb = value / 255;
  const linear = srgb <= 0.04045
    ? srgb / 12.92
    : ((srgb + 0.055) / 1.055) ** 2.4;
  return Math.round(linear * 255);
});

const SURFACE_VERTEX_DECLARATIONS = `
#define TORUS_SURFACE_POSITION
attribute vec2 surfaceOffset;
attribute float surfaceHeight;
attribute float surfaceSize;
varying vec2 vSurfaceFlatPosition;
varying float vSurfaceHeight;
`;

const SURFACE_BEGIN_VERTEX = `
vec3 transformed = vec3(
  position.x * surfaceSize + surfaceOffset.x,
  position.y * surfaceHeight * 0.2,
  position.z * surfaceSize + surfaceOffset.y
);
vSurfaceFlatPosition = transformed.xz;
vSurfaceHeight = surfaceHeight;
`;

const SURFACE_SIDE_VERTEX_DECLARATIONS = `
#define TORUS_SURFACE_POSITION
#define TORUS_SURFACE_AXIS
#define TORUS_SURFACE_NORMAL
attribute vec2 surfaceOffset;
attribute float surfaceHeight;
attribute float surfaceBottomHeight;
attribute float surfaceSize;
attribute float surfaceAxis;
attribute vec2 surfaceNormal;
varying vec2 vSurfaceFlatPosition;
varying float vSurfaceHeight;
`;

const SURFACE_SIDE_BEGIN_VERTEX = `
vec2 surfaceAlong = mix(vec2(1.0, 0.0), vec2(0.0, 1.0), surfaceAxis);
// The unit quad faces +Z when it runs on X and -X when it runs on Z. Reverse
// its along-edge coordinate for the opposite two directions so FrontSide can
// cull backfaces without making half of the terrain discontinuities vanish.
float surfaceWinding = mix(surfaceNormal.y, -surfaceNormal.x, surfaceAxis);
float surfaceAlongPosition = surfaceWinding >= 0.0 ? position.x : 1.0 - position.x;
vec2 surfaceFlatPosition = surfaceOffset + surfaceAlong * surfaceAlongPosition * surfaceSize;
vec3 transformed = vec3(
  surfaceFlatPosition.x,
  mix(surfaceBottomHeight, surfaceHeight, position.y) * 0.2,
  surfaceFlatPosition.y
);
vSurfaceFlatPosition = transformed.xz;
vSurfaceHeight = surfaceHeight;
`;

const SURFACE_FRAGMENT_DECLARATIONS = `
uniform vec2 uSurfaceWorldSize;
uniform vec2 uSurfaceWorldChunks;
uniform sampler2D uSurfaceDetailMask;
varying vec2 vSurfaceFlatPosition;
varying float vSurfaceHeight;
`;

const SURFACE_COLOR_FRAGMENT = `
if (vSurfaceHeight < 0.5) discard;
vec2 surfaceWrapped = mod(
  mod(vSurfaceFlatPosition, uSurfaceWorldSize) + uSurfaceWorldSize,
  uSurfaceWorldSize
);
vec2 surfaceChunk = floor(surfaceWrapped / ${CHUNK_SIZE.toFixed(1)});
vec2 surfaceMaskUv = (surfaceChunk + 0.5) / uSurfaceWorldChunks;
if (texture2D(uSurfaceDetailMask, surfaceMaskUv).r > 0.5) discard;
#include <color_fragment>
`;

interface SurfaceMip {
  cellSize: number;
  axis: number;
  heights: Uint16Array;
  colors: Uint8Array;
}

interface StoredSurfaceZone {
  zoneX: number;
  zoneZ: number;
  mips: Map<number, SurfaceMip>;
}

interface ConnectedSurfaceCell {
  worldX: number;
  worldZ: number;
  cellSize: number;
  height: number;
  red: number;
  green: number;
  blue: number;
}

function createTopGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;
  return geometry;
}

function createSideGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  // A connection is one exact vertical rectangle between two unequal surface
  // samples. Per-instance attributes rotate and place this unit quad.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 1, 0,
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;
  return geometry;
}

function createMaterial(detailMask: THREE.DataTexture, side = false) {
  // Match LowPolyMesher's solid terrain response exactly at the AOI handoff.
  // Keeping shadows disabled on the distant meshes avoids expanding the local
  // 90 m shadow workload, while the shared Standard parameters remove the
  // otherwise visible Lambert/PBR color step at the seam.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.65,
    metalness: 0.15,
    shadowSide: THREE.DoubleSide,
    side: THREE.FrontSide,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.uSurfaceWorldSize = { value: new THREE.Vector2(TORUS_SIZE_X, TORUS_SIZE_Z) };
    shader.uniforms.uSurfaceWorldChunks = { value: new THREE.Vector2(WORLD_CHUNKS_X, WORLD_CHUNKS_Z) };
    shader.uniforms.uSurfaceDetailMask = { value: detailMask };
    material.userData.shader = shader;
    const vertexDeclarations = side
      ? SURFACE_SIDE_VERTEX_DECLARATIONS
      : SURFACE_VERTEX_DECLARATIONS;
    const beginVertex = side ? SURFACE_SIDE_BEGIN_VERTEX : SURFACE_BEGIN_VERTEX;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexDeclarations}`)
      .replace('#include <begin_vertex>', beginVertex);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_FRAGMENT_DECLARATIONS}`)
      .replace('#include <color_fragment>', SURFACE_COLOR_FRAGMENT);
  };
  material.customProgramCacheKey = () => (
    side ? 'distant-surface-zone-v4-connections' : 'distant-surface-zone-v4-tops'
  );
  return material;
}

function buildMipPyramid(zone: SurfaceZoneSnapshot): Map<number, SurfaceMip> {
  const fineAxis = ZONE_SIZE_CHUNKS * FINE_SAMPLES_PER_CHUNK_AXIS;
  const finestHeights = new Uint16Array(fineAxis * fineAxis);
  const finestColors = new Uint8Array(fineAxis * fineAxis * 3);
  let sourceIndex = 0;
  for (let chunkX = 0; chunkX < ZONE_SIZE_CHUNKS; chunkX++) {
    for (let chunkZ = 0; chunkZ < ZONE_SIZE_CHUNKS; chunkZ++) {
      for (let sampleX = 0; sampleX < FINE_SAMPLES_PER_CHUNK_AXIS; sampleX++) {
        const gridX = chunkX * FINE_SAMPLES_PER_CHUNK_AXIS + sampleX;
        for (let sampleZ = 0; sampleZ < FINE_SAMPLES_PER_CHUNK_AXIS; sampleZ++) {
          const gridZ = chunkZ * FINE_SAMPLES_PER_CHUNK_AXIS + sampleZ;
          const targetIndex = gridX * fineAxis + gridZ;
          finestHeights[targetIndex] = zone.heightsMicro[sourceIndex];
          finestColors[targetIndex * 3] = SRGB_TO_LINEAR_BYTE[zone.colors[sourceIndex * 3]];
          finestColors[targetIndex * 3 + 1] = SRGB_TO_LINEAR_BYTE[zone.colors[sourceIndex * 3 + 1]];
          finestColors[targetIndex * 3 + 2] = SRGB_TO_LINEAR_BYTE[zone.colors[sourceIndex * 3 + 2]];
          sourceIndex++;
        }
      }
    }
  }

  const mips = new Map<number, SurfaceMip>();
  let current: SurfaceMip = {
    cellSize: FINE_SAMPLE_SIZE,
    axis: fineAxis,
    heights: finestHeights,
    colors: finestColors,
  };
  mips.set(current.cellSize, current);
  while (current.cellSize < 64) {
    const nextAxis = current.axis / 2;
    const nextHeights = new Uint16Array(nextAxis * nextAxis);
    const nextColors = new Uint8Array(nextAxis * nextAxis * 3);
    for (let x = 0; x < nextAxis; x++) {
      for (let z = 0; z < nextAxis; z++) {
        const targetIndex = x * nextAxis + z;
        let bestSource = (x * 2) * current.axis + z * 2;
        let bestHeight = current.heights[bestSource];
        for (let dx = 0; dx < 2; dx++) {
          for (let dz = 0; dz < 2; dz++) {
            const candidate = (x * 2 + dx) * current.axis + z * 2 + dz;
            if (current.heights[candidate] > bestHeight) {
              bestHeight = current.heights[candidate];
              bestSource = candidate;
            }
          }
        }
        nextHeights[targetIndex] = bestHeight;
        nextColors[targetIndex * 3] = current.colors[bestSource * 3];
        nextColors[targetIndex * 3 + 1] = current.colors[bestSource * 3 + 1];
        nextColors[targetIndex * 3 + 2] = current.colors[bestSource * 3 + 2];
      }
    }
    current = {
      cellSize: current.cellSize * 2,
      axis: nextAxis,
      heights: nextHeights,
      colors: nextColors,
    };
    mips.set(current.cellSize, current);
  }
  return mips;
}

function wrappedAxisDistanceToCell(
  player: number,
  cellStart: number,
  cellSize: number,
  worldSize: number,
) {
  const center = cellStart + cellSize / 2;
  const direct = Math.abs(center - player);
  const centerDistance = Math.min(direct, worldSize - direct);
  return Math.max(0, centerDistance - cellSize / 2);
}

function desiredSampleSize(distance: number, settings: DistantSurfaceSettings): number | null {
  const bands = ORDERED_DISTANCE_KEYS.map(key => settings[key]);
  for (let index = 0; index < bands.length; index++) {
    if (distance <= bands[index] && settings[LOD_ENABLED_KEYS[index]]) {
      return LOD_SAMPLE_SIZES[index];
    }
  }
  return null;
}

function quantizedChunkCenter(chunk: number, worldChunks: number) {
  const quantized = Math.round(chunk / LOD_CENTER_STEP_CHUNKS) * LOD_CENTER_STEP_CHUNKS;
  return ((quantized % worldChunks) + worldChunks) % worldChunks;
}

function yieldToRender() {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** One adaptive instanced far-field layer derived from backend surface snapshots. */
export class DistantSurfaceLayer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  readonly sideMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  readonly detailMaskTexture: THREE.DataTexture;
  readonly loadedZones = new Set<string>();
  private readonly detailMaskData = new Uint8Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z);
  private readonly zones = new Map<string, StoredSurfaceZone>();
  private settings = normalizeDistantSurfaceSettings(DEFAULT_DISTANT_SURFACE_SETTINGS);
  private offsets: Uint16Array | null = null;
  private heights: Uint16Array | null = null;
  private sizes: Uint8Array | null = null;
  private colors: Uint8Array | null = null;
  private sideOffsets: Uint16Array | null = null;
  private sideHeights: Uint16Array | null = null;
  private sideBottomHeights: Uint16Array | null = null;
  private sideSizes: Uint8Array | null = null;
  private sideAxes: Uint8Array | null = null;
  private sideNormals: Int8Array | null = null;
  private sideColors: Uint8Array | null = null;
  private readonly connectedCells: ConnectedSurfaceCell[] = [];
  // One origin lookup per emitted LOD cell avoids a 2 m occupancy grid. A dense
  // 4000 m connection grid would reserve about 66 MB and clear it on each move.
  private readonly connectionOwners = new Map<number, Map<number, ConnectedSurfaceCell>>(
    LOD_SAMPLE_SIZES.map(sampleSize => (
      [sampleSize, new Map<number, ConnectedSurfaceCell>()] as const
    )),
  );
  private writeIndex = 0;
  private sideWriteIndex = 0;
  private connectionsReady = false;
  private connectionsDirty = true;
  private connectionBuildGeneration = 0;
  private connectionBuildPending = false;
  private enabled = true;
  private centerChunkX = 0;
  private centerChunkZ = 0;
  private lodCenterKey = '';

  constructor() {
    this.detailMaskTexture = new THREE.DataTexture(
      this.detailMaskData,
      WORLD_CHUNKS_X,
      WORLD_CHUNKS_Z,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.detailMaskTexture.name = 'DistantSurfaceDetailMask';
    this.detailMaskTexture.magFilter = THREE.NearestFilter;
    this.detailMaskTexture.minFilter = THREE.NearestFilter;
    this.detailMaskTexture.wrapS = THREE.RepeatWrapping;
    this.detailMaskTexture.wrapT = THREE.RepeatWrapping;
    this.detailMaskTexture.generateMipmaps = false;
    this.detailMaskTexture.needsUpdate = true;

    this.mesh = new THREE.Mesh(createTopGeometry(), createMaterial(this.detailMaskTexture));
    this.mesh.name = 'DistantSurfaceZones';
    this.mesh.userData.distantSurfaceZones = true;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.sideMesh = new THREE.Mesh(createSideGeometry(), createMaterial(this.detailMaskTexture, true));
    this.sideMesh.name = 'DistantSurfaceZoneConnections';
    this.sideMesh.visible = false;
    this.sideMesh.frustumCulled = false;
    this.sideMesh.castShadow = false;
    this.sideMesh.receiveShadow = false;
    this.mesh.add(this.sideMesh);
    hookSceneMaterials(this.mesh);
  }

  private syncVisibility() {
    this.mesh.visible = this.enabled && this.mesh.geometry.instanceCount > 0;
    this.sideMesh.visible = this.enabled && this.sideMesh.geometry.instanceCount > 0;
  }

  setEnabled(enabled: boolean): boolean {
    const next = Boolean(enabled);
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    if (!next) {
      this.connectionBuildGeneration++;
      this.connectionBuildPending = false;
      this.connectionsDirty = true;
      this.syncVisibility();
      return this.enabled;
    }
    if (this.zones.size > 0) this.rebuild();
    else this.syncVisibility();
    return this.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Atomically hand one chunk between the snapshot surface and its detailed
   * mesh. The 128 KiB mask is sampled per fragment, so even a 64 m far cell can
   * be hidden one 16 m chunk at a time without rebuilding far topology.
   */
  setDetailChunkReady(chunkX: number, chunkZ: number, ready: boolean) {
    const wrappedX = ((chunkX % WORLD_CHUNKS_X) + WORLD_CHUNKS_X) % WORLD_CHUNKS_X;
    const wrappedZ = ((chunkZ % WORLD_CHUNKS_Z) + WORLD_CHUNKS_Z) % WORLD_CHUNKS_Z;
    const index = wrappedZ * WORLD_CHUNKS_X + wrappedX;
    const value = ready ? 255 : 0;
    if (this.detailMaskData[index] === value) return;
    this.detailMaskData[index] = value;
    this.detailMaskTexture.needsUpdate = true;
  }

  private ensureStorage() {
    if (
      this.offsets && this.heights && this.sizes && this.colors
      && this.sideOffsets && this.sideHeights && this.sideBottomHeights
      && this.sideSizes && this.sideAxes && this.sideNormals && this.sideColors
    ) return;
    this.offsets = new Uint16Array(MAX_SURFACE_INSTANCES * 2);
    this.heights = new Uint16Array(MAX_SURFACE_INSTANCES);
    this.sizes = new Uint8Array(MAX_SURFACE_INSTANCES);
    this.colors = new Uint8Array(MAX_SURFACE_INSTANCES * 3);
    this.sideOffsets = new Uint16Array(MAX_SURFACE_CONNECTIONS * 2);
    this.sideHeights = new Uint16Array(MAX_SURFACE_CONNECTIONS);
    this.sideBottomHeights = new Uint16Array(MAX_SURFACE_CONNECTIONS);
    this.sideSizes = new Uint8Array(MAX_SURFACE_CONNECTIONS);
    this.sideAxes = new Uint8Array(MAX_SURFACE_CONNECTIONS);
    this.sideNormals = new Int8Array(MAX_SURFACE_CONNECTIONS * 2);
    this.sideColors = new Uint8Array(MAX_SURFACE_CONNECTIONS * 3);
    this.attachTopAttributes();
    this.attachSideAttributes();
  }

  private attachTopAttributes() {
    const attributes = {
      surfaceOffset: new THREE.InstancedBufferAttribute(this.offsets!, 2),
      surfaceHeight: new THREE.InstancedBufferAttribute(this.heights!, 1),
      surfaceSize: new THREE.InstancedBufferAttribute(this.sizes!, 1),
      color: new THREE.InstancedBufferAttribute(this.colors!, 3, true),
    };
    for (const [name, attribute] of Object.entries(attributes)) {
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.mesh.geometry.setAttribute(name, attribute);
    }
  }

  private attachSideAttributes() {
    const attributes = {
      surfaceOffset: new THREE.InstancedBufferAttribute(this.sideOffsets!, 2),
      surfaceHeight: new THREE.InstancedBufferAttribute(this.sideHeights!, 1),
      surfaceBottomHeight: new THREE.InstancedBufferAttribute(this.sideBottomHeights!, 1),
      surfaceSize: new THREE.InstancedBufferAttribute(this.sideSizes!, 1),
      surfaceAxis: new THREE.InstancedBufferAttribute(this.sideAxes!, 1),
      surfaceNormal: new THREE.InstancedBufferAttribute(this.sideNormals!, 2, true),
      color: new THREE.InstancedBufferAttribute(this.sideColors!, 3, true),
    };
    for (const [name, attribute] of Object.entries(attributes)) {
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.sideMesh.geometry.setAttribute(name, attribute);
    }
  }

  private emit(
    zone: StoredSurfaceZone,
    localX: number,
    localZ: number,
    cellSize: number,
    distance: number,
  ) {
    const mip = zone.mips.get(cellSize)!;
    const sampleX = localX / cellSize;
    const sampleZ = localZ / cellSize;
    const sourceIndex = sampleX * mip.axis + sampleZ;
    const height = mip.heights[sourceIndex];
    const worldX = zone.zoneX * ZONE_WORLD_SIZE + localX;
    const worldZ = zone.zoneZ * ZONE_WORLD_SIZE + localZ;
    const red = mip.colors[sourceIndex * 3];
    const green = mip.colors[sourceIndex * 3 + 1];
    const blue = mip.colors[sourceIndex * 3 + 2];
    if (
      this.settings.connectionDistance > 0
      && distance <= this.settings.connectionDistance
    ) {
      this.connectedCells.push({ worldX, worldZ, cellSize, height, red, green, blue });
    }
    if (height === 0) return;
    if (this.writeIndex >= MAX_SURFACE_INSTANCES) {
      throw new Error('Adaptive Space surface instance budget exceeded.');
    }
    const index = this.writeIndex++;
    this.offsets![index * 2] = worldX;
    this.offsets![index * 2 + 1] = worldZ;
    this.heights![index] = height;
    this.sizes![index] = cellSize;
    this.colors![index * 3] = red;
    this.colors![index * 3 + 1] = green;
    this.colors![index * 3 + 2] = blue;
  }

  private visitCell(zone: StoredSurfaceZone, localX: number, localZ: number, cellSize: number) {
    const worldX = zone.zoneX * ZONE_WORLD_SIZE + localX;
    const worldZ = zone.zoneZ * ZONE_WORLD_SIZE + localZ;
    const playerX = (this.centerChunkX + 0.5) * CHUNK_SIZE;
    const playerZ = (this.centerChunkZ + 0.5) * CHUNK_SIZE;
    const dx = wrappedAxisDistanceToCell(playerX, worldX, cellSize, TORUS_SIZE_X);
    const dz = wrappedAxisDistanceToCell(playerZ, worldZ, cellSize, TORUS_SIZE_Z);
    const distance = Math.hypot(dx, dz);
    const sampleSize = desiredSampleSize(distance, this.settings);
    if (sampleSize === null) return;
    if (cellSize > sampleSize) {
      const childSize = cellSize / 2;
      this.visitCell(zone, localX, localZ, childSize);
      this.visitCell(zone, localX + childSize, localZ, childSize);
      this.visitCell(zone, localX, localZ + childSize, childSize);
      this.visitCell(zone, localX + childSize, localZ + childSize, childSize);
      return;
    }
    this.emit(zone, localX, localZ, cellSize, distance);
  }

  private appendZone(zone: StoredSurfaceZone) {
    for (let localX = 0; localX < ZONE_WORLD_SIZE; localX += 64) {
      for (let localZ = 0; localZ < ZONE_WORLD_SIZE; localZ += 64) {
        this.visitCell(zone, localX, localZ, 64);
      }
    }
  }

  private connectionCellKey(worldX: number, worldZ: number, cellSize: number) {
    const wrappedX = ((worldX % TORUS_SIZE_X) + TORUS_SIZE_X) % TORUS_SIZE_X;
    const wrappedZ = ((worldZ % TORUS_SIZE_Z) + TORUS_SIZE_Z) % TORUS_SIZE_Z;
    const originX = Math.floor(wrappedX / cellSize) * cellSize;
    const originZ = Math.floor(wrappedZ / cellSize) * cellSize;
    return (originX / FINE_SAMPLE_SIZE) * FINE_WORLD_Z_AXIS + originZ / FINE_SAMPLE_SIZE;
  }

  private emitConnection(
    cell: ConnectedSurfaceCell,
    worldX: number,
    worldZ: number,
    length: number,
    bottomHeight: number,
    axis: number,
    normalX: number,
    normalZ: number,
  ) {
    if (this.sideWriteIndex >= MAX_SURFACE_CONNECTIONS) {
      throw new Error('Connected Space surface instance budget exceeded.');
    }
    const index = this.sideWriteIndex++;
    this.sideOffsets![index * 2] = worldX;
    this.sideOffsets![index * 2 + 1] = worldZ;
    this.sideHeights![index] = cell.height;
    this.sideBottomHeights![index] = bottomHeight;
    this.sideSizes![index] = length;
    this.sideAxes![index] = axis;
    this.sideNormals![index * 2] = normalX * 127;
    this.sideNormals![index * 2 + 1] = normalZ * 127;
    this.sideColors![index * 3] = cell.red;
    this.sideColors![index * 3 + 1] = cell.green;
    this.sideColors![index * 3 + 2] = cell.blue;
  }

  private clearConnectionOwners() {
    for (const owners of this.connectionOwners.values()) owners.clear();
  }

  private fillConnectionOwner(cell: ConnectedSurfaceCell) {
    this.connectionOwners.get(cell.cellSize)!.set(
      this.connectionCellKey(cell.worldX, cell.worldZ, cell.cellSize),
      cell,
    );
  }

  private connectionOwnerAt(worldX: number, worldZ: number, preferredSize: number) {
    const preferred = this.connectionOwners.get(preferredSize)!.get(
      this.connectionCellKey(worldX, worldZ, preferredSize),
    );
    if (preferred) return preferred;
    for (const sampleSize of LOD_SAMPLE_SIZES) {
      if (sampleSize === preferredSize) continue;
      const owner = this.connectionOwners.get(sampleSize)!.get(
        this.connectionCellKey(worldX, worldZ, sampleSize),
      );
      if (owner) return owner;
    }
    return null;
  }

  private emitCellConnections(cell: ConnectedSurfaceCell) {
    const ownerAt = (worldX: number, worldZ: number) => {
      return this.connectionOwnerAt(worldX, worldZ, cell.cellSize);
    };
    const emitRuns = (
      axis: number,
      normalX: number,
      normalZ: number,
      neighborAt: (offset: number) => ConnectedSurfaceCell | null,
      edgeAt: (offset: number) => [number, number],
    ) => {
      let runStart = -1;
      let runBottom = -1;
      const flush = (end: number) => {
        if (runStart < 0) return;
        const [worldX, worldZ] = edgeAt(runStart);
        this.emitConnection(
          cell,
          worldX,
          worldZ,
          end - runStart,
          runBottom,
          axis,
          normalX,
          normalZ,
        );
        runStart = -1;
      };
      for (let offset = 0; offset <= cell.cellSize; offset += FINE_SAMPLE_SIZE) {
        const neighbor = offset < cell.cellSize ? neighborAt(offset) : null;
        const bottom = neighbor && cell.height > neighbor.height ? neighbor.height : -1;
        if (bottom >= 0 && bottom === runBottom) {
          if (runStart < 0) runStart = offset;
          continue;
        }
        flush(offset);
        runBottom = bottom;
        if (bottom >= 0) runStart = offset;
      }
    };

    emitRuns(
      1, -1, 0,
      offset => ownerAt(cell.worldX - FINE_SAMPLE_SIZE, cell.worldZ + offset),
      offset => [cell.worldX, cell.worldZ + offset],
    );
    emitRuns(
      1, 1, 0,
      offset => ownerAt(cell.worldX + cell.cellSize, cell.worldZ + offset),
      offset => [cell.worldX + cell.cellSize, cell.worldZ + offset],
    );
    emitRuns(
      0, 0, -1,
      offset => ownerAt(cell.worldX + offset, cell.worldZ - FINE_SAMPLE_SIZE),
      offset => [cell.worldX + offset, cell.worldZ],
    );
    emitRuns(
      0, 0, 1,
      offset => ownerAt(cell.worldX + offset, cell.worldZ + cell.cellSize),
      offset => [cell.worldX + offset, cell.worldZ + cell.cellSize],
    );
  }

  private finishConnectionUpload(previousCount: number) {
    if (this.sideWriteIndex < previousCount) {
      this.sideHeights!.fill(0, this.sideWriteIndex, previousCount);
    }
    this.sideMesh.geometry.instanceCount = this.sideWriteIndex;
    this.uploadRange(this.sideMesh, 0, Math.max(this.sideWriteIndex, previousCount), true);
    this.syncVisibility();
    this.connectionsDirty = false;
    this.connectionBuildPending = false;
  }

  private rebuildConnections() {
    this.ensureStorage();
    this.connectionBuildGeneration++;
    this.connectionBuildPending = false;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const cells = this.connectedCells;
    this.sideWriteIndex = 0;
    this.clearConnectionOwners();
    for (const cell of cells) this.fillConnectionOwner(cell);
    for (const cell of cells) this.emitCellConnections(cell);
    this.finishConnectionUpload(previousCount);
  }

  private async stageConnections(
    generation: number,
    cells: ConnectedSurfaceCell[],
  ): Promise<boolean> {
    this.sideWriteIndex = 0;
    this.clearConnectionOwners();

    let cellIndex = 0;
    while (cellIndex < cells.length) {
      const startedAt = performance.now();
      do {
        this.fillConnectionOwner(cells[cellIndex]);
        cellIndex++;
      } while (
        cellIndex < cells.length
        && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
      );
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return false;
    }

    cellIndex = 0;
    while (cellIndex < cells.length) {
      const startedAt = performance.now();
      do {
        this.emitCellConnections(cells[cellIndex]);
        cellIndex++;
      } while (
        cellIndex < cells.length
        && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
      );
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return false;
    }
    return true;
  }

  private scheduleConnectionRebuild(): Promise<void> {
    this.ensureStorage();
    const generation = ++this.connectionBuildGeneration;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const cells = this.connectedCells.slice();
    this.connectionsDirty = true;
    this.connectionBuildPending = true;

    return (async () => {
      // Let the final progressive top-surface upload reach WebGL before using
      // the separate side buffers for a frame-sliced connection build.
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return;
      if (!await this.stageConnections(generation, cells)) return;
      this.finishConnectionUpload(previousCount);
    })().catch(error => {
      if (generation !== this.connectionBuildGeneration) return;
      this.connectionBuildPending = false;
      console.error('Failed to rebuild distant surface connections:', error);
    });
  }

  private scheduleRebuild() {
    this.ensureStorage();
    const generation = ++this.connectionBuildGeneration;
    const previousTopCount = this.mesh.geometry.instanceCount;
    const previousCount = this.sideMesh.geometry.instanceCount;
    const rootCells = [...this.zones.values()].flatMap(zone => {
      const roots: { zone: StoredSurfaceZone; localX: number; localZ: number }[] = [];
      for (let localX = 0; localX < ZONE_WORLD_SIZE; localX += 64) {
        for (let localZ = 0; localZ < ZONE_WORLD_SIZE; localZ += 64) {
          roots.push({ zone, localX, localZ });
        }
      }
      return roots;
    });
    this.connectionsDirty = true;
    this.connectionBuildPending = true;

    void (async () => {
      // Retain the currently uploaded topology until the replacement is
      // complete. Typed arrays are only sent to WebGL after every staged batch.
      await yieldToRender();
      if (generation !== this.connectionBuildGeneration) return;

      this.writeIndex = 0;
      this.connectedCells.length = 0;
      let rootIndex = 0;
      while (rootIndex < rootCells.length) {
        const startedAt = performance.now();
        do {
          const root = rootCells[rootIndex];
          this.visitCell(root.zone, root.localX, root.localZ, 64);
          rootIndex++;
        } while (
          rootIndex < rootCells.length
          && performance.now() - startedAt < CONNECTION_BUILD_BUDGET_MS
        );
        await yieldToRender();
        if (generation !== this.connectionBuildGeneration) return;
      }

      const cells = this.connectedCells.slice();
      if (!await this.stageConnections(generation, cells)) return;

      if (this.writeIndex < previousTopCount) {
        this.heights!.fill(0, this.writeIndex, previousTopCount);
      }
      this.mesh.geometry.instanceCount = this.writeIndex;
      this.uploadRange(this.mesh, 0, Math.max(this.writeIndex, previousTopCount), true);
      this.syncVisibility();
      this.finishConnectionUpload(previousCount);
    })().catch(error => {
      if (generation !== this.connectionBuildGeneration) return;
      this.connectionBuildPending = false;
      console.error('Failed to rebuild distant surface connections:', error);
    });
  }

  private uploadRange(
    mesh: THREE.Mesh<THREE.InstancedBufferGeometry>,
    start: number,
    count: number,
    replacePending = false,
  ) {
    if (count <= 0) return;
    const names = mesh === this.sideMesh
      ? [
          'surfaceOffset',
          'surfaceHeight',
          'surfaceBottomHeight',
          'surfaceSize',
          'surfaceAxis',
          'surfaceNormal',
          'color',
        ]
      : ['surfaceOffset', 'surfaceHeight', 'surfaceSize', 'color'];
    for (const name of names) {
      const attribute = mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      if (replacePending) attribute.clearUpdateRanges();
      attribute.addUpdateRange(start * attribute.itemSize, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  private rebuild() {
    this.ensureStorage();
    const previousCount = this.mesh.geometry.instanceCount;
    const previousSideCount = this.sideMesh.geometry.instanceCount;
    this.writeIndex = 0;
    this.connectedCells.length = 0;
    for (const zone of this.zones.values()) this.appendZone(zone);
    if (this.writeIndex < previousCount) {
      this.heights!.fill(0, this.writeIndex, previousCount);
    }
    this.mesh.geometry.instanceCount = this.writeIndex;
    this.uploadRange(this.mesh, 0, Math.max(this.writeIndex, previousCount), true);
    this.syncVisibility();
    if (this.connectionsReady) {
      this.rebuildConnections();
    } else {
      this.connectionBuildGeneration++;
      this.connectionBuildPending = false;
      this.sideWriteIndex = 0;
      if (previousSideCount > 0) this.sideHeights!.fill(0, 0, previousSideCount);
      this.sideMesh.geometry.instanceCount = 0;
      this.uploadRange(this.sideMesh, 0, previousSideCount, true);
      this.sideMesh.visible = false;
    }
  }

  installZone(zone: SurfaceZoneSnapshot) {
    const recordsPerZone = ZONE_SIZE_CHUNKS ** 2 * FINE_SAMPLES_PER_CHUNK_AXIS ** 2;
    if (
      zone.samplesPerChunkAxis !== FINE_SAMPLES_PER_CHUNK_AXIS
      || zone.zoneSizeChunks !== ZONE_SIZE_CHUNKS
      || zone.heightsMicro.length !== recordsPerZone
      || zone.colors.length !== recordsPerZone * 3
      || zone.zoneX < 0
      || zone.zoneX >= TORUS_SIZE_X / ZONE_WORLD_SIZE
      || zone.zoneZ < 0
      || zone.zoneZ >= TORUS_SIZE_Z / ZONE_WORLD_SIZE
    ) {
      throw new Error('Surface zone does not match this world.');
    }
    this.ensureStorage();
    const key = `${zone.zoneX},${zone.zoneZ}`;
    const replacing = this.zones.has(key);
    const stored = { zoneX: zone.zoneX, zoneZ: zone.zoneZ, mips: buildMipPyramid(zone) };
    this.zones.set(key, stored);
    this.loadedZones.add(key);
    this.connectionsDirty = true;
    if (!this.enabled) return;
    if (replacing) {
      this.rebuild();
      return;
    }
    const start = this.writeIndex;
    this.appendZone(stored);
    this.mesh.geometry.instanceCount = this.writeIndex;
    this.uploadRange(this.mesh, start, this.writeIndex - start);
    this.syncVisibility();
    if (this.connectionsReady) void this.scheduleConnectionRebuild();
  }

  async finalizeConnections() {
    if (this.connectionsReady && !this.connectionsDirty) return;
    if (this.connectionsReady && this.connectionBuildPending) return;
    this.connectionsReady = true;
    if (!this.enabled) return;
    await this.scheduleConnectionRebuild();
  }

  removeZone(zoneX: number, zoneZ: number) {
    const key = `${zoneX},${zoneZ}`;
    if (!this.zones.delete(key)) return;
    this.loadedZones.delete(key);
    this.connectionsDirty = true;
    if (!this.enabled) return;
    this.rebuild();
  }

  getSettings(): DistantSurfaceSettings {
    return { ...this.settings };
  }

  setSettings(value: Partial<DistantSurfaceSettings>): DistantSurfaceSettings {
    const next = normalizeDistantSurfaceSettings({ ...this.settings, ...value });
    const changed = (Object.keys(next) as DistantSurfaceSettingKey[])
      .some(key => next[key] !== this.settings[key]);
    if (!changed) return this.getSettings();
    this.settings = next;
    if (this.enabled && this.zones.size > 0) {
      if (this.connectionsReady) this.scheduleRebuild();
      else this.rebuild();
    }
    return this.getSettings();
  }

  setNearField(centerChunkX: number, centerChunkZ: number, _renderDistance: number) {
    const lodCenterChunkX = quantizedChunkCenter(centerChunkX, TORUS_SIZE_X / CHUNK_SIZE);
    const lodCenterChunkZ = quantizedChunkCenter(centerChunkZ, TORUS_SIZE_Z / CHUNK_SIZE);
    const nextLodCenterKey = `${lodCenterChunkX},${lodCenterChunkZ}`;
    if (nextLodCenterKey === this.lodCenterKey) return;
    this.centerChunkX = lodCenterChunkX;
    this.centerChunkZ = lodCenterChunkZ;
    this.lodCenterKey = nextLodCenterKey;
    if (this.enabled && this.zones.size > 0) {
      // Progressive zone installation writes into the same staging arrays, so
      // only defer topology moves after the initial snapshot set is complete.
      if (this.connectionsReady) this.scheduleRebuild();
      else this.rebuild();
    }
  }
}

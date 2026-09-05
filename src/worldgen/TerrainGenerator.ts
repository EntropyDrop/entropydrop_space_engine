import { createNoise3D } from 'simplex-noise';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../voxel/Chunk.ts';
import { BlockTypes } from '../voxel/BlockTypes.ts';
import {
  TORUS_SIZE_X, TORUS_SIZE_Z, TORUS_R, TORUS_RHO, TORUS_GREF,
  TORUS_SPAWN_X, TORUS_SPAWN_Z
} from '../torus/TorusWorld.ts';

const TERRAIN_COLORS = {
  deep: 0x66707d,
  middle: 0x806b5c,
  surface: 0x718f61
};

// Terrain-flattening radius around the inner-ring spawn at flat coordinates (8192, 1024).
const SPAWN_PAD_RADIUS = 26;
// Favor broad gentle slopes with minimal detail; constrain elevation to ±5 m from the reference surface.
const TERRAIN_BROAD_FREQUENCY = 0.018;
const TERRAIN_DETAIL_FREQUENCY = 0.052;
const TERRAIN_BROAD_AMPLITUDE = 3.4;
const TERRAIN_DETAIL_AMPLITUDE = 1.2;
const TERRAIN_MIN_HEIGHT = TORUS_GREF - 5;
const TERRAIN_MAX_HEIGHT = TORUS_GREF + 5;

/**
 * Seamless terrain generation for the torus world.
 *
 * Flat coordinates map to torus angles (θ = wx·2π/16384,
 * φ = wz·2π/2048). Sampling 3D simplex noise at the embedded torus point
 * makes both seams continuous without explicit periodic noise.
 * Elevation stays near TORUS_GREF=16 (ρ = r ± 5), preserving the round tube
 * silhouette with only broad slopes. A separate flat pad surrounds the spawn point.
 */
export class TerrainGenerator {
  private noise3D: any;

  constructor(seed = 42) {
    let state = seed;
    const random = () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    };
    this.noise3D = createNoise3D(random);
  }

  sampleHeight(wx, wz) {
    // Torus angular coordinates.
    const theta = (wx / TORUS_SIZE_X) * Math.PI * 2;
    const phi = (wz / TORUS_SIZE_Z) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);

    // Embedded torus point near the tube's outer surface, radius R + r·cosφ.
    const px = (TORUS_R + TORUS_RHO * cp) * ct;
    const py = (TORUS_R + TORUS_RHO * cp) * st;
    const pz = TORUS_RHO * sp;

    // Two 3D noise layers: broad terrain around 55 m and low-amplitude detail around 19 m.
    // Separate their frequency and amplitude to avoid staircase artifacts and spikes.
    const broad = this.noise3D(
      px * TERRAIN_BROAD_FREQUENCY,
      py * TERRAIN_BROAD_FREQUENCY,
      pz * TERRAIN_BROAD_FREQUENCY
    );
    const detail = this.noise3D(
      px * TERRAIN_DETAIL_FREQUENCY,
      py * TERRAIN_DETAIL_FREQUENCY,
      pz * TERRAIN_DETAIL_FREQUENCY
    );
    let height = Math.round(
      TORUS_GREF
      + broad * TERRAIN_BROAD_AMPLITUDE
      + detail * TERRAIN_DETAIL_AMPLITUDE
    );

    // Flat spawn pad on the inner ring.
    const dSpawn = Math.hypot(wx - TORUS_SPAWN_X, wz - TORUS_SPAWN_Z);
    if (dSpawn < SPAWN_PAD_RADIUS) {
      const blend = Math.max(0, Math.min(1, (dSpawn - 10) / (SPAWN_PAD_RADIUS - 10)));
      height = Math.round(TORUS_GREF * (1 - blend) + height * blend);
    }

    return Math.max(TERRAIN_MIN_HEIGHT, Math.min(TERRAIN_MAX_HEIGHT, height));
  }

  generateChunk(chunk) {
    const origin = chunk.getWorldOrigin();
    chunk.resetForTerrainGeneration();
    let maxHeight = -1;

    for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
        const wx = origin.x + lx;
        const wz = origin.z + lz;
        const height = this.sampleHeight(wx, wz);
        maxHeight = Math.max(maxHeight, height);

        for (let wy = 0; wy <= height; wy++) {
          const color = wy === height
            ? TERRAIN_COLORS.surface
            : wy >= height - 3
              ? TERRAIN_COLORS.middle
              : TERRAIN_COLORS.deep;
          const index = Chunk.getIndex(lx, wy, lz);
          chunk.blocks[index] = BlockTypes.COLOR_BLOCK;
          chunk.colors[index] = color;
        }
      }
    }
    chunk.setGeneratedOccupiedYRange(0, maxHeight);
    chunk.hasGenerated = true;
  }
}

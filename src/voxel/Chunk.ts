import { DEFAULT_BLOCK_COLOR, normalizeColor } from './BlockTypes.ts';

// Voxel Chunk Data Storage (16x256x16)

export const CHUNK_SIZE_X = 16;
export const CHUNK_SIZE_Y = 256;
export const CHUNK_SIZE_Z = 16;

export class Chunk {
  cx: number;
  cz: number;
  world: any;
  blocks: Uint8Array;
  colors: Uint32Array;
  mesh: any;
  isDirty: boolean;
  hasGenerated: boolean;
  /** Changes whenever collision-relevant standard voxel data changes. */
  dataVersion: number;
  /** Newest data version represented by the currently published render mesh. */
  publishedDataVersion: number;
  /** Procedural chunks can be regenerated; edited chunks must survive streaming. */
  hasUserEdits: boolean;
  private minOccupiedY: number;
  private maxOccupiedY: number;
  private occupiedYBoundsDirty: boolean;

  constructor(cx, cz, world) {
    this.cx = cx;
    this.cz = cz;
    this.world = world;

    // 1D Uint8Array for performance & compactness
    this.blocks = new Uint8Array(CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z);
    this.colors = new Uint32Array(CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z);
    this.colors.fill(DEFAULT_BLOCK_COLOR);
    this.mesh = null;
    this.isDirty = true;
    this.hasGenerated = false;
    this.dataVersion = 0;
    this.publishedDataVersion = -1;
    this.hasUserEdits = false;
    this.minOccupiedY = CHUNK_SIZE_Y;
    this.maxOccupiedY = -1;
    this.occupiedYBoundsDirty = false;
  }

  static getIndex(lx, ly, lz) {
    return (ly * CHUNK_SIZE_Z + lz) * CHUNK_SIZE_X + lx;
  }

  /** Reuse the large typed-array allocation for another procedural chunk. */
  reuseAt(cx: number, cz: number, world: any) {
    this.cx = cx;
    this.cz = cz;
    this.world = world;
    this.mesh = null;
    this.isDirty = true;
    this.hasGenerated = false;
    this.dataVersion++;
    this.publishedDataVersion = -1;
    this.hasUserEdits = false;
    this.minOccupiedY = CHUNK_SIZE_Y;
    this.maxOccupiedY = -1;
    this.occupiedYBoundsDirty = false;
  }

  getLocalBlock(lx, ly, lz) {
    if (lx < 0 || lx >= CHUNK_SIZE_X || ly < 0 || ly >= CHUNK_SIZE_Y || lz < 0 || lz >= CHUNK_SIZE_Z) {
      return 0;
    }
    return this.blocks[Chunk.getIndex(lx, ly, lz)];
  }

  getLocalColor(lx, ly, lz) {
    if (lx < 0 || lx >= CHUNK_SIZE_X || ly < 0 || ly >= CHUNK_SIZE_Y || lz < 0 || lz >= CHUNK_SIZE_Z) {
      return DEFAULT_BLOCK_COLOR;
    }
    return this.colors[Chunk.getIndex(lx, ly, lz)];
  }

  setLocalBlock(lx, ly, lz, blockType, color = DEFAULT_BLOCK_COLOR) {
    if (lx < 0 || lx >= CHUNK_SIZE_X || ly < 0 || ly >= CHUNK_SIZE_Y || lz < 0 || lz >= CHUNK_SIZE_Z) {
      return false;
    }
    const idx = Chunk.getIndex(lx, ly, lz);
    const nextColor = normalizeColor(color);
    const previousBlock = this.blocks[idx];
    if (previousBlock !== blockType || (blockType !== 0 && this.colors[idx] !== nextColor)) {
      this.blocks[idx] = blockType;
      this.colors[idx] = nextColor;
      this.isDirty = true;
      this.dataVersion++;

      if (previousBlock === 0 && blockType !== 0 && !this.occupiedYBoundsDirty) {
        this.minOccupiedY = Math.min(this.minOccupiedY, ly);
        this.maxOccupiedY = Math.max(this.maxOccupiedY, ly);
      } else if (
        previousBlock !== 0
        && blockType === 0
        && (ly === this.minOccupiedY || ly === this.maxOccupiedY)
      ) {
        // Only removals at an extreme can shrink the range. Defer the scan
        // until a mesher or culler actually needs the bounds.
        this.occupiedYBoundsDirty = true;
      }

      // Mark neighbors dirty if on boundary
      if (lx === 0 && this.world) this.world.markChunkDirty(this.cx - 1, this.cz);
      if (lx === CHUNK_SIZE_X - 1 && this.world) this.world.markChunkDirty(this.cx + 1, this.cz);
      if (lz === 0 && this.world) this.world.markChunkDirty(this.cx, this.cz - 1);
      if (lz === CHUNK_SIZE_Z - 1 && this.world) this.world.markChunkDirty(this.cx, this.cz + 1);

      return true;
    }
    return false;
  }

  /** Reset reusable chunk arrays before deterministic terrain generation. */
  resetForTerrainGeneration() {
    this.blocks.fill(0);
    this.colors.fill(DEFAULT_BLOCK_COLOR);
    this.dataVersion++;
    this.minOccupiedY = CHUNK_SIZE_Y;
    this.maxOccupiedY = -1;
    this.occupiedYBoundsDirty = false;
    this.hasGenerated = false;
    this.isDirty = true;
  }

  /** Terrain generation writes arrays directly, then publishes its exact bounds once. */
  setGeneratedOccupiedYRange(min: number, max: number) {
    this.minOccupiedY = Math.max(0, Math.min(CHUNK_SIZE_Y - 1, Math.floor(min)));
    this.maxOccupiedY = Math.max(-1, Math.min(CHUNK_SIZE_Y - 1, Math.floor(max)));
    this.occupiedYBoundsDirty = false;
  }

  /** Install buffers produced off-thread without replaying every voxel write. */
  installGeneratedData(
    blocks: Uint8Array,
    colors: Uint32Array,
    minOccupiedY: number,
    maxOccupiedY: number,
    hasUserEdits = false,
  ) {
    this.blocks = blocks;
    this.colors = colors;
    this.minOccupiedY = Math.max(0, Math.min(CHUNK_SIZE_Y - 1, Math.floor(minOccupiedY)));
    this.maxOccupiedY = Math.max(-1, Math.min(CHUNK_SIZE_Y - 1, Math.floor(maxOccupiedY)));
    this.occupiedYBoundsDirty = false;
    this.hasGenerated = true;
    this.hasUserEdits = hasUserEdits;
    this.isDirty = false;
    this.dataVersion++;
  }

  getOccupiedYRange(): { min: number; max: number } | null {
    if (this.occupiedYBoundsDirty) {
      let min = CHUNK_SIZE_Y;
      let max = -1;
      const layerSize = CHUNK_SIZE_X * CHUNK_SIZE_Z;

      for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) {
        const start = ly * layerSize;
        const end = start + layerSize;
        for (let index = start; index < end; index++) {
          if (this.blocks[index] === 0) continue;
          min = Math.min(min, ly);
          max = ly;
          break;
        }
      }

      this.minOccupiedY = min;
      this.maxOccupiedY = max;
      this.occupiedYBoundsDirty = false;
    }

    if (this.maxOccupiedY < this.minOccupiedY) return null;
    return { min: this.minOccupiedY, max: this.maxOccupiedY };
  }

  getWorldOrigin() {
    return {
      x: this.cx * CHUNK_SIZE_X,
      y: 0,
      z: this.cz * CHUNK_SIZE_Z
    };
  }
}

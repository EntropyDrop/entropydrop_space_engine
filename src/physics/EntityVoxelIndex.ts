import { CollisionBoxIndex, type CollisionBounds } from './CollisionGeometry.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';

export type IndexedVoxel = CollisionBounds & { entry: any; order: number };

const INDEX_CHUNK_SIZE = 8;

type IndexChunk = {
  key: string;
  bounds: CollisionBounds;
  items: IndexedVoxel[];
  subIndex?: CollisionBoxIndex<IndexedVoxel>;
};

export class ChunkedVoxelIndex {
  bounds: CollisionBounds;
  private readonly chunks = new Map<string, IndexChunk>();
  private readonly itemMap = new Map<any, { chunkKey: string; voxel: IndexedVoxel }>();
  private nextOrder = 0;

  constructor(items: IndexedVoxel[] = []) {
    this.bounds = {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
    };
    for (const item of items) {
      this.addItem(item, false);
      if (item.order >= this.nextOrder) this.nextOrder = item.order + 1;
    }
    this.rebuildAllChunkSubIndexes();
    this.recomputeBounds();
  }

  private static chunkKey(x: number, y: number, z: number): string {
    const cx = Math.floor(x / INDEX_CHUNK_SIZE);
    const cy = Math.floor(y / INDEX_CHUNK_SIZE);
    const cz = Math.floor(z / INDEX_CHUNK_SIZE);
    return `${cx},${cy},${cz}`;
  }

  private addItem(voxel: IndexedVoxel, updateBounds = true) {
    const key = ChunkedVoxelIndex.chunkKey(voxel.minX, voxel.minY, voxel.minZ);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = {
        key,
        bounds: {
          minX: voxel.minX, minY: voxel.minY, minZ: voxel.minZ,
          maxX: voxel.maxX, maxY: voxel.maxY, maxZ: voxel.maxZ
        },
        items: []
      };
      this.chunks.set(key, chunk);
    } else {
      chunk.bounds.minX = Math.min(chunk.bounds.minX, voxel.minX);
      chunk.bounds.minY = Math.min(chunk.bounds.minY, voxel.minY);
      chunk.bounds.minZ = Math.min(chunk.bounds.minZ, voxel.minZ);
      chunk.bounds.maxX = Math.max(chunk.bounds.maxX, voxel.maxX);
      chunk.bounds.maxY = Math.max(chunk.bounds.maxY, voxel.maxY);
      chunk.bounds.maxZ = Math.max(chunk.bounds.maxZ, voxel.maxZ);
    }
    chunk.items.push(voxel);
    this.itemMap.set(voxel.entry, { chunkKey: key, voxel });

    if (updateBounds) {
      if (chunk.items.length > 16) {
        chunk.subIndex = new CollisionBoxIndex(chunk.items);
      }
      this.bounds.minX = Math.min(this.bounds.minX, voxel.minX);
      this.bounds.minY = Math.min(this.bounds.minY, voxel.minY);
      this.bounds.minZ = Math.min(this.bounds.minZ, voxel.minZ);
      this.bounds.maxX = Math.max(this.bounds.maxX, voxel.maxX);
      this.bounds.maxY = Math.max(this.bounds.maxY, voxel.maxY);
      this.bounds.maxZ = Math.max(this.bounds.maxZ, voxel.maxZ);
    }
  }

  add(entry: any, minX: number, minY: number, minZ: number, size: number, order?: number): IndexedVoxel {
    const ord = order !== undefined ? order : this.nextOrder++;
    const voxel: IndexedVoxel = {
      minX, minY, minZ,
      maxX: minX + size, maxY: minY + size, maxZ: minZ + size,
      entry,
      order: ord
    };
    this.addItem(voxel, true);
    return voxel;
  }

  remove(entry: any): boolean {
    const mapping = this.itemMap.get(entry);
    if (!mapping) return false;
    this.itemMap.delete(entry);
    const chunk = this.chunks.get(mapping.chunkKey);
    if (!chunk) return false;
    const idx = chunk.items.findIndex(item => item.entry === entry);
    if (idx >= 0) chunk.items.splice(idx, 1);

    if (chunk.items.length === 0) {
      this.chunks.delete(mapping.chunkKey);
    } else {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const it of chunk.items) {
        minX = Math.min(minX, it.minX); minY = Math.min(minY, it.minY); minZ = Math.min(minZ, it.minZ);
        maxX = Math.max(maxX, it.maxX); maxY = Math.max(maxY, it.maxY); maxZ = Math.max(maxZ, it.maxZ);
      }
      chunk.bounds = { minX, minY, minZ, maxX, maxY, maxZ };
      if (chunk.items.length > 16) {
        chunk.subIndex = new CollisionBoxIndex(chunk.items);
      } else {
        chunk.subIndex = undefined;
      }
    }
    this.recomputeBounds();
    return true;
  }

  private rebuildAllChunkSubIndexes() {
    for (const chunk of this.chunks.values()) {
      if (chunk.items.length > 16) {
        chunk.subIndex = new CollisionBoxIndex(chunk.items);
      }
    }
  }

  private recomputeBounds() {
    if (this.chunks.size === 0) {
      this.bounds = {
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
      };
      return;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const chunk of this.chunks.values()) {
      minX = Math.min(minX, chunk.bounds.minX);
      minY = Math.min(minY, chunk.bounds.minY);
      minZ = Math.min(minZ, chunk.bounds.minZ);
      maxX = Math.max(maxX, chunk.bounds.maxX);
      maxY = Math.max(maxY, chunk.bounds.maxY);
      maxZ = Math.max(maxZ, chunk.bounds.maxZ);
    }
    this.bounds = { minX, minY, minZ, maxX, maxY, maxZ };
  }

  query(bounds: CollisionBounds): IndexedVoxel[] {
    return this.queryMatchingBounds(candidate => candidate.maxX >= bounds.minX && candidate.minX <= bounds.maxX
      && candidate.maxY >= bounds.minY && candidate.minY <= bounds.maxY
      && candidate.maxZ >= bounds.minZ && candidate.minZ <= bounds.maxZ);
  }

  queryMatchingBounds(intersects: (bounds: CollisionBounds) => boolean): IndexedVoxel[] {
    if (this.chunks.size === 0 || !intersects(this.bounds)) return [];
    const matches: IndexedVoxel[] = [];
    for (const chunk of this.chunks.values()) {
      if (!intersects(chunk.bounds)) continue;
      if (chunk.subIndex) {
        matches.push(...chunk.subIndex.queryMatchingBounds(intersects));
      } else {
        for (const item of chunk.items) {
          if (intersects(item)) matches.push(item);
        }
      }
    }
    return matches;
  }
}

/** Geometry stays in component coordinates; poses never invalidate this index. */
export function buildEntityVoxelIndexes(entries: any[], rootId: string, collision: boolean) {
  const groups = new Map<string, IndexedVoxel[]>();
  entries.forEach((entry, order) => {
    const id = entry.entityId || rootId;
    const minX = collision ? entry.x * MICRO_SIZE : entry.localX;
    const minY = collision ? entry.y * MICRO_SIZE : entry.localY;
    const minZ = collision ? entry.z * MICRO_SIZE : entry.localZ;
    const size = collision ? entry.span * MICRO_SIZE : entry.size || 1;
    let group = groups.get(id);
    if (!group) groups.set(id, group = []);
    group.push({ minX, minY, minZ, maxX: minX + size, maxY: minY + size,
      maxZ: minZ + size, entry, order });
  });
  return new Map([...groups].map(([id, entries]) => [id, new ChunkedVoxelIndex(entries)]));
}

/** Transform an AABB using center/extents, optionally unioning the old pose.
 * This covers every descendant voxel's previous/current world AABB, including
 * fast translations, rotations, and parented moving components. */
export function transformVoxelBounds(bounds: CollisionBounds, node: any, out: CollisionBounds, swept = false) {
  const x = (bounds.minX + bounds.maxX) / 2 - node.pivotLocal.x;
  const y = (bounds.minY + bounds.maxY) / 2 - node.pivotLocal.y;
  const z = (bounds.minZ + bounds.maxZ) / 2 - node.pivotLocal.z;
  const hx = (bounds.maxX - bounds.minX) / 2;
  const hy = (bounds.maxY - bounds.minY) / 2;
  const hz = (bounds.maxZ - bounds.minZ) / 2;
  out.minX = out.minY = out.minZ = Infinity;
  out.maxX = out.maxY = out.maxZ = -Infinity;
  const count = swept && node.previousWorldMatrix ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const m = (i === 0 ? node.group.matrixWorld : node.previousWorldMatrix).elements;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const ex = Math.abs(m[0]) * hx + Math.abs(m[4]) * hy + Math.abs(m[8]) * hz + 1e-7;
    const ey = Math.abs(m[1]) * hx + Math.abs(m[5]) * hy + Math.abs(m[9]) * hz + 1e-7;
    const ez = Math.abs(m[2]) * hx + Math.abs(m[6]) * hy + Math.abs(m[10]) * hz + 1e-7;
    out.minX = Math.min(out.minX, cx - ex); out.maxX = Math.max(out.maxX, cx + ex);
    out.minY = Math.min(out.minY, cy - ey); out.maxY = Math.max(out.maxY, cy + ey);
    out.minZ = Math.min(out.minZ, cz - ez); out.maxZ = Math.max(out.maxZ, cz + ez);
  }
  return out;
}

import { CollisionBoxIndex, type CollisionBounds } from './CollisionGeometry.ts';
import { MICRO_SIZE } from '../voxel/MicroGrid.ts';

type IndexedVoxel = CollisionBounds & { entry: any; order: number };

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
  return new Map([...groups].map(([id, entries]) => [id, new CollisionBoxIndex(entries)]));
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

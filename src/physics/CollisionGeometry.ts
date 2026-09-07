/** Integer micro-grid boxes; authored voxels remain separate for editing/picking. */
export type CollisionBox = {
  x: number; y: number; z: number;
  spanX: number; spanY: number; spanZ: number;
  entityId: string;
};
export type CollisionBounds = {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
};

/** Merge only face-adjacent boxes with identical cross sections and ownership.
 * No voxel expansion, convex hulls, hole filling, or merging across joints. */
export function mergeCollisionCells(cells: readonly {
  x: number; y: number; z: number; span: number; entityId: string;
}[], maxSpan = Infinity): CollisionBox[] {
  let boxes: CollisionBox[] = cells.map(cell => ({
    x: cell.x, y: cell.y, z: cell.z,
    spanX: cell.span, spanY: cell.span, spanZ: cell.span, entityId: cell.entityId,
  }));
  let previousCount: number;
  do {
    previousCount = boxes.length;
    for (const [axis, size, a, sizeA, b, sizeB] of [
      ['x', 'spanX', 'y', 'spanY', 'z', 'spanZ'],
      ['y', 'spanY', 'x', 'spanX', 'z', 'spanZ'],
      ['z', 'spanZ', 'x', 'spanX', 'y', 'spanY'],
    ] as const) {
      const groups = new Map<string, CollisionBox[]>();
      for (const box of boxes) {
        const key = `${box.entityId}:${box[a]},${box[sizeA]},${box[b]},${box[sizeB]}`;
        let group = groups.get(key);
        if (!group) groups.set(key, group = []);
        group.push(box);
      }
      boxes = [];
      for (const group of groups.values()) {
        group.sort((first, second) => first[axis] - second[axis]);
        let current: CollisionBox | undefined;
        for (const box of group) {
          if (current && current[axis] + current[size] === box[axis]
            && current[size] + box[size] <= maxSpan) {
            current[size] += box[size];
          } else {
            current = box;
            boxes.push(current);
          }
        }
      }
    }
  } while (boxes.length < previousCount);
  return boxes;
}

export function collisionBoundsOverlap(a: CollisionBounds, b: CollisionBounds): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX
    && a.maxY >= b.minY && a.minY <= b.maxY
    && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

export function collisionBoundsOf(boxes: readonly CollisionBounds[]): CollisionBounds {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const box of boxes) {
    bounds.minX = Math.min(bounds.minX, box.minX);
    bounds.minY = Math.min(bounds.minY, box.minY);
    bounds.minZ = Math.min(bounds.minZ, box.minZ);
    bounds.maxX = Math.max(bounds.maxX, box.maxX);
    bounds.maxY = Math.max(bounds.maxY, box.maxY);
    bounds.maxZ = Math.max(bounds.maxZ, box.maxZ);
  }
  return bounds;
}

type IndexNode = CollisionBounds & { indices?: number[]; left?: IndexNode; right?: IndexNode };

/** A second collision level inside a complex entity. Indexed bounds include
 * previous/current poses so fast sweeps receive the same candidates as SAT. */
export class CollisionBoxIndex<T extends CollisionBounds> {
  readonly bounds: CollisionBounds;
  private readonly root: IndexNode;
  private readonly boxes: readonly T[];
  constructor(boxes: readonly T[]) {
    this.boxes = boxes;
    const build = (indices: number[]): IndexNode => {
      const bounds = collisionBoundsOf(indices.map(index => boxes[index]));
      if (indices.length <= 8) return { ...bounds, indices };
      const axes = [
        ['minX', 'maxX'], ['minY', 'maxY'], ['minZ', 'maxZ'],
      ] as const;
      const [min, max] = [...axes].sort((a, b) => (
        (bounds[b[1]] - bounds[b[0]]) - (bounds[a[1]] - bounds[a[0]])
      ))[0];
      indices.sort((a, b) => (boxes[a][min] + boxes[a][max]) - (boxes[b][min] + boxes[b][max]) || a - b);
      const middle = Math.floor(indices.length / 2);
      return { ...bounds, left: build(indices.slice(0, middle)), right: build(indices.slice(middle)) };
    };
    this.root = build(boxes.map((_, index) => index));
    this.bounds = this.root;
  }
  query(bounds: CollisionBounds): T[] {
    const matches: number[] = [];
    const visit = (node: IndexNode) => {
      if (!collisionBoundsOverlap(node, bounds)) return;
      if (node.indices) {
        for (const index of node.indices) {
          if (collisionBoundsOverlap(this.boxes[index], bounds)) matches.push(index);
        }
      } else {
        visit(node.left!);
        visit(node.right!);
      }
    };
    visit(this.root);
    // Preserve solver contact order independently of tree partitioning.
    return matches.sort((a, b) => a - b).map(index => this.boxes[index]);
  }
}

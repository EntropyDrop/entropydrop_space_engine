import * as THREE from 'three';
import { BlockTypes, DEFAULT_BLOCK_COLOR } from '../voxel/BlockTypes.ts';
import { CHUNK_SIZE_Y } from '../voxel/Chunk.ts';
import { MAX_ENTITY_BOUNDS } from '../contraption/Contraption.ts';
import { MICRO_DIVISIONS } from '../voxel/MicroVoxelLayer.ts';

/** True when a size-meter block at entity-local (x,y,z) keeps the entity AABB within MAX_ENTITY_BOUNDS. */
function entityAABBAllows(contraption, x, y, z, size = 1) {
  const min = contraption.minLocal;
  const max = contraption.maxLocal;
  if (!min || !max) return true;
  return (
    Math.max(x + size, max.x) - Math.min(x, min.x) <= MAX_ENTITY_BOUNDS
    && Math.max(y + size, max.y) - Math.min(y, min.y) <= MAX_ENTITY_BOUNDS
    && Math.max(z + size, max.z) - Math.min(z, min.z) <= MAX_ENTITY_BOUNDS
  );
}

/**
 * Canonical engine command entry point.
 *
 * Input adapters (entity programs, mouse controls and UI buttons) may use
 * different coordinate systems, but all mutations end up here after converting
 * their target to a canonical world/entity cell.
 */

export const ActionDomain = Object.freeze({
  WORLD: 'world',
  ENTITY: 'entity',
  SELECTION: 'selection',
  QUERY: 'query',
  PHYSICS: 'physics'
});

function actionResult(action: string, changed: number, reason: string, extra: any = {}) {
  return {
    ok: changed > 0,
    action,
    changed,
    reason,
    ...extra
  };
}

function finiteCell(value: any, boundedY = false) {
  const parts = Array.isArray(value)
    ? value
    : value && [value.x, value.y, value.z];
  if (!parts || parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(Number(part)))) {
    return null;
  }
  const cell = {
    x: Math.floor(Number(parts[0]) + 1e-6),
    y: Math.floor(Number(parts[1]) + 1e-6),
    z: Math.floor(Number(parts[2]) + 1e-6)
  };
  if (boundedY && (cell.y < 0 || cell.y >= CHUNK_SIZE_Y)) return null;
  return cell;
}

function finiteMicro(value: any) {
  const parts = Array.isArray(value)
    ? value
    : value && [value.x ?? value.mx, value.y ?? value.my, value.z ?? value.mz];
  if (!parts || parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(Number(part)))) {
    return null;
  }
  return {
    x: Math.round(Number(parts[0])),
    y: Math.round(Number(parts[1])),
    z: Math.round(Number(parts[2]))
  };
}

function resolveColor(value: any, fallback = DEFAULT_BLOCK_COLOR) {
  if (Number.isFinite(Number(value?.color))) return Number(value.color) & 0xffffff;
  if (value?.r !== undefined || value?.g !== undefined || value?.b !== undefined) {
    return ((Number(value.r) || 0) & 255) << 16
      | ((Number(value.g) || 0) & 255) << 8
      | ((Number(value.b) || 0) & 255);
  }
  if (Number.isFinite(Number(value))) return Number(value) & 0xffffff;
  return fallback;
}

function blockCell(block: any) {
  return {
    x: Math.floor(Number(block.localX) + 1e-6),
    y: Math.floor(Number(block.localY) + 1e-6),
    z: Math.floor(Number(block.localZ) + 1e-6)
  };
}

function blockInCell(block: any, cell: any) {
  const own = blockCell(block);
  return own.x === cell.x && own.y === cell.y && own.z === cell.z;
}

function entityRootId(contraption: any): string {
  const explicit = contraption?.rootComponentId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const structural = [...(contraption?.entityNodes?.values?.() || [])]
    .find((node: any) => node?.parentId === null)?.id;
  return typeof structural === 'string' ? structural : '';
}

function blockOwnerId(contraption: any, block: any): string {
  return String(block?.entityId ?? entityRootId(contraption));
}

function requestedNodeId(contraption: any, ...values: any[]): string {
  const selected = values.find(value => value !== undefined && value !== null);
  return String(selected ?? entityRootId(contraption));
}

function entityNodeColor(contraption: any, nodeId: string, options: any) {
  const inherited = contraption.blocks?.find(block => blockOwnerId(contraption, block) === nodeId)?.color
    ?? DEFAULT_BLOCK_COLOR;
  return resolveColor(options, inherited);
}

function resolveContraption(context: any, target: any) {
  if (target?.contraption) return target.contraption;
  if (context?.contraption) return context.contraption;
  const id = target?.entityId ?? target?.id;
  if (id === undefined || id === null) return null;
  return context?.manager?.contraptions?.find(item => (
    String(item.publicId) === String(id) || String(item.id) === String(id)
  )) || null;
}

function finishEntityMutation(context: any, contraption: any, type: string, nodeId: string, event: any = null) {
  const empty = !contraption.blocks || contraption.blocks.length === 0;
  const manager = context?.manager || contraption?.actionContext?.manager;
  if (empty && manager?.contraptions?.includes(contraption)) {
    manager.removeContraption(contraption);
  } else {
    contraption.rebuildAfterBlockChange?.(type, nodeId, event);
  }
  return empty;
}

function entityMutationEvent(command: any, extra: any = {}) {
  const source = String(command?.actor?.source || 'system');
  return {
    source,
    playerId: command?.actor?.playerId ?? (source === 'player' ? 'local' : null),
    ...extra
  };
}

function executeWorldAction(context: any, command: any) {
  const world = context?.world || context?.manager?.world;
  if (!world) return actionResult(command.action, 0, 'world_unavailable');
  const cell = finiteCell(command.cell ?? command.position, true);
  const micro = finiteMicro(command.micro);

  switch (command.action) {
    case 'get-standard': {
      if (!cell) return { block: BlockTypes.AIR, color: 0x000000 };
      const block = world.getBlock?.(cell.x, cell.y, cell.z) ?? BlockTypes.AIR;
      return {
        block,
        color: block === BlockTypes.AIR ? 0x000000 : (world.getBlockColor?.(cell.x, cell.y, cell.z) ?? DEFAULT_BLOCK_COLOR)
      };
    }
    case 'get-micro': {
      if (!micro) return { block: BlockTypes.AIR, color: 0x000000 };
      return world.getMicroBlock?.(micro.x, micro.y, micro.z)
        || { block: BlockTypes.AIR, color: 0x000000 };
    }
    case 'place-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      const occupied = (world.getBlock?.(cell.x, cell.y, cell.z) ?? BlockTypes.AIR) !== BlockTypes.AIR
        || !!world.hasMicroInStandardCell?.(cell.x, cell.y, cell.z);
      if (occupied && !command.replace) return actionResult(command.action, 0, 'occupied', { placed: 0 });
      const result = world.setBlock?.(
        cell.x, cell.y, cell.z,
        command.block || BlockTypes.COLOR_BLOCK,
        command.updateMesh !== false,
        resolveColor(command.options ?? command.color)
      );
      // A few lightweight adapters intentionally return void after performing the write.
      const placed = result === false ? 0 : 1;
      return actionResult(command.action, placed, placed ? 'placed' : 'out_of_bounds', { placed });
    }
    case 'remove-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      if (world.getBlock && world.getBlock(cell.x, cell.y, cell.z) === BlockTypes.AIR) {
        return actionResult(command.action, 0, 'not_found', { removed: 0 });
      }
      const result = world.setBlock?.(cell.x, cell.y, cell.z, BlockTypes.AIR, command.updateMesh !== false);
      const removed = result === false ? 0 : 1;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', { removed });
    }
    case 'paint-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { painted: 0 });
      const painted = world.setBlockColor?.(cell.x, cell.y, cell.z, resolveColor(command.options ?? command.color)) ? 1 : 0;
      return actionResult(command.action, painted, painted ? 'painted' : 'not_found', { painted });
    }
    case 'place-micro': {
      if (!micro || micro.y < 0 || micro.y >= CHUNK_SIZE_Y * 5) {
        return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      }
      const parent = { x: Math.floor(micro.x / 5), y: Math.floor(micro.y / 5), z: Math.floor(micro.z / 5) };
      const occupied = (world.getBlock?.(parent.x, parent.y, parent.z) ?? BlockTypes.AIR) !== BlockTypes.AIR
        || !!world.getMicroBlock?.(micro.x, micro.y, micro.z);
      if (occupied && !command.replace) return actionResult(command.action, 0, 'occupied', { placed: 0 });
      const result = world.setMicroBlock?.(
        micro.x, micro.y, micro.z,
        resolveColor(command.options ?? command.color),
        command.part || null
      );
      const placed = result === false ? 0 : 1;
      return actionResult(command.action, placed, placed ? 'placed' : 'out_of_bounds', { placed });
    }
    case 'remove-micro': {
      if (!micro) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      const removed = world.removeMicroBlock?.(micro.x, micro.y, micro.z) ? 1 : 0;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', { removed });
    }
    case 'paint-micro': {
      if (!micro) return actionResult(command.action, 0, 'invalid_position', { painted: 0 });
      if (world.getMicroBlock && !world.getMicroBlock(micro.x, micro.y, micro.z)) {
        return actionResult(command.action, 0, 'not_found', { painted: 0 });
      }
      const painted = world.setMicroBlock?.(micro.x, micro.y, micro.z, resolveColor(command.options ?? command.color)) ? 1 : 0;
      return actionResult(command.action, painted, painted ? 'painted' : 'not_found', { painted });
    }
    case 'clear-cell': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0, standard: 0, micro: 0 });
      let standard = 0;
      if (!command.microOnly && (!world.getBlock || world.getBlock(cell.x, cell.y, cell.z) !== BlockTypes.AIR)) {
        const removed = world.setBlock?.(cell.x, cell.y, cell.z, BlockTypes.AIR, command.updateMesh !== false);
        standard = removed === false ? 0 : 1;
      }
      const microCount = Number(world.clearMicroStandardCell?.(cell.x, cell.y, cell.z)) || 0;
      const removed = standard + microCount;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', {
        removed,
        standard,
        micro: microCount
      });
    }
    case 'subdivide-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { subdivided: 0, removed: 0 });
      const subdivided = Number(world.subdivideBlock?.(cell.x, cell.y, cell.z)) || 0;
      let removed = 0;
      if (subdivided > 0 && micro) removed = world.removeMicroBlock?.(micro.x, micro.y, micro.z) ? 1 : 0;
      return actionResult(command.action, subdivided, subdivided ? 'subdivided' : 'not_found', { subdivided, removed });
    }
    case 'remove-cells': {
      const cells = Array.isArray(command.cells) ? command.cells.map(item => finiteCell(item, true)).filter(Boolean) : [];
      let standard = 0;
      let microCount = 0;
      for (const item of cells) {
        const result = executeWorldAction(context, { action: 'clear-cell', cell: item, updateMesh: command.updateMesh });
        standard += result.standard || 0;
        microCount += result.micro || 0;
      }
      const removed = standard + microCount;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', {
        removed,
        standard,
        micro: microCount
      });
    }
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}

function executeEntityAction(context: any, command: any) {
  const contraption = resolveContraption(context, command.target);
  if (!contraption || !Array.isArray(contraption.blocks)) {
    return actionResult(command.action, 0, 'entity_not_found');
  }
  if (
    contraption.serverManaged === true
    && contraption.serverCanEdit !== true
    && command.actor?.source !== 'script'
    && command.actor?.source !== 'server-sync'
  ) {
    return actionResult(command.action, 0, 'server_entity_read_only');
  }
  const nodeId = requestedNodeId(contraption, command.nodeId, command.target?.nodeId);
  if (contraption.entityNodes?.has && !contraption.entityNodes.has(nodeId)) {
    return actionResult(command.action, 0, 'component_not_found');
  }
  const cell = finiteCell(command.cell ?? command.position);
  const micro = finiteMicro(command.micro);

  switch (command.action) {
    case 'place-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      if (contraption.blocks.some(block => blockInCell(block, cell))) {
        return actionResult(command.action, 0, 'occupied', { placed: 0 });
      }
      if (!entityAABBAllows(contraption, cell.x, cell.y, cell.z)) {
        return actionResult(command.action, 0, 'bounds_exceeded', { placed: 0 });
      }
      const placedBlock = {
        localX: cell.x,
        localY: cell.y,
        localZ: cell.z,
        size: 1,
        color: entityNodeColor(contraption, nodeId, command.options ?? command.color),
        block: command.block || BlockTypes.COLOR_BLOCK,
        entityId: nodeId
      };
      contraption.blocks.push(placedBlock);
      finishEntityMutation(context, contraption, 'place', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        size: 1,
        block: placedBlock.block,
        color: placedBlock.color
      }));
      return actionResult(command.action, 1, 'placed', { placed: 1, empty: false });
    }
    case 'remove-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      const index = contraption.blocks.findIndex(block => (
        blockOwnerId(contraption, block) === nodeId
        && (block.size || 1) >= 1
        && blockInCell(block, cell)
      ));
      if (index < 0) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      const removedBlock = contraption.blocks[index];
      contraption.blocks.splice(index, 1);
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        size: removedBlock.size || 1,
        block: removedBlock.block,
        color: removedBlock.color
      }));
      return actionResult(command.action, 1, 'removed', { removed: 1, empty });
    }
    case 'paint-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { painted: 0 });
      const block = contraption.blocks.find(item => (
        blockOwnerId(contraption, item) === nodeId
        && (item.size || 1) >= 1
        && blockInCell(item, cell)
      ));
      if (!block) return actionResult(command.action, 0, 'not_found', { painted: 0 });
      block.color = resolveColor(command.options ?? command.color, block.color ?? DEFAULT_BLOCK_COLOR);
      finishEntityMutation(context, contraption, 'color', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        size: block.size || 1,
        block: block.block,
        color: block.color
      }));
      return actionResult(command.action, 1, 'painted', { painted: 1, color: block.color });
    }
    case 'place-micro': {
      if (!micro) return actionResult(command.action, 0, 'invalid_position', { placed: 0 });
      const localX = micro.x / 5;
      const localY = micro.y / 5;
      const localZ = micro.z / 5;
      const parent = finiteCell([localX, localY, localZ]);
      const standardOccupied = contraption.blocks.some(block => (block.size || 1) >= 1 && blockInCell(block, parent));
      const microOccupied = contraption.blocks.some(block => (
        (block.size || 1) < 1
        && Math.abs(block.localX - localX) < 1e-3
        && Math.abs(block.localY - localY) < 1e-3
        && Math.abs(block.localZ - localZ) < 1e-3
      ));
      if (standardOccupied || microOccupied) {
        return actionResult(command.action, 0, 'occupied', { placed: 0 });
      }
      // A micro voxel extends the entity AABB through its parent standard cell.
      if (!entityAABBAllows(contraption, parent.x, parent.y, parent.z)) {
        return actionResult(command.action, 0, 'bounds_exceeded', { placed: 0 });
      }
      const placedBlock = {
        localX,
        localY,
        localZ,
        size: 0.2,
        color: entityNodeColor(contraption, nodeId, command.options ?? command.color),
        block: command.block || BlockTypes.COLOR_BLOCK,
        entityId: nodeId,
        ...(command.part ? { part: command.part } : {})
      };
      contraption.blocks.push(placedBlock);
      finishEntityMutation(context, contraption, 'place', nodeId, entityMutationEvent(command, {
        cell: [parent.x, parent.y, parent.z],
        microOffset: [
          ((micro.x % 5) + 5) % 5,
          ((micro.y % 5) + 5) % 5,
          ((micro.z % 5) + 5) % 5
        ],
        size: 0.2,
        block: placedBlock.block,
        color: placedBlock.color
      }));
      return actionResult(command.action, 1, 'placed', { placed: 1, empty: false });
    }
    case 'remove-micro':
    case 'paint-micro': {
      if (!micro) {
        const field = command.action === 'paint-micro' ? 'painted' : 'removed';
        return actionResult(command.action, 0, 'invalid_position', { [field]: 0 });
      }
      const localX = micro.x / 5;
      const localY = micro.y / 5;
      const localZ = micro.z / 5;
      const index = contraption.blocks.findIndex(block => (
        blockOwnerId(contraption, block) === nodeId
        && (block.size || 1) < 1
        && Math.abs(block.localX - localX) < 1e-3
        && Math.abs(block.localY - localY) < 1e-3
        && Math.abs(block.localZ - localZ) < 1e-3
      ));
      if (index < 0) {
        const field = command.action === 'paint-micro' ? 'painted' : 'removed';
        return actionResult(command.action, 0, 'not_found', { [field]: 0 });
      }
      if (command.action === 'paint-micro') {
        const block = contraption.blocks[index];
        block.color = resolveColor(command.options ?? command.color, block.color ?? DEFAULT_BLOCK_COLOR);
        finishEntityMutation(context, contraption, 'color', nodeId, entityMutationEvent(command, {
          cell: [Math.floor(localX), Math.floor(localY), Math.floor(localZ)],
          microOffset: [
            ((micro.x % 5) + 5) % 5,
            ((micro.y % 5) + 5) % 5,
            ((micro.z % 5) + 5) % 5
          ],
          size: 0.2,
          block: block.block,
          color: block.color
        }));
        return actionResult(command.action, 1, 'painted', { painted: 1, color: block.color });
      }
      const removedBlock = contraption.blocks[index];
      contraption.blocks.splice(index, 1);
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cell: [Math.floor(localX), Math.floor(localY), Math.floor(localZ)],
        microOffset: [
          ((micro.x % 5) + 5) % 5,
          ((micro.y % 5) + 5) % 5,
          ((micro.z % 5) + 5) % 5
        ],
        size: 0.2,
        block: removedBlock.block,
        color: removedBlock.color
      }));
      return actionResult(command.action, 1, 'removed', { removed: 1, empty });
    }
    case 'clear-cell': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { removed: 0 });
      const removedBlocks = contraption.blocks.filter(block => (
        blockOwnerId(contraption, block) === nodeId
        && blockInCell(block, cell)
        && (!command.microOnly || (block.size || 1) < 1)
      ));
      const before = contraption.blocks.length;
      contraption.blocks = contraption.blocks.filter(block => {
        if (blockOwnerId(contraption, block) !== nodeId || !blockInCell(block, cell)) return true;
        if (command.microOnly && (block.size || 1) >= 1) return true;
        return false;
      });
      const removed = before - contraption.blocks.length;
      if (!removed) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        cells: removedBlocks.slice(0, 64).map(block => [block.localX, block.localY, block.localZ]),
        truncated: removedBlocks.length > 64
      }));
      return actionResult(command.action, removed, 'removed', { removed, empty });
    }
    case 'subdivide-standard': {
      if (!cell) return actionResult(command.action, 0, 'invalid_position', { subdivided: 0, removed: 0 });
      const index = contraption.blocks.findIndex(block => (
        blockOwnerId(contraption, block) === nodeId
        && (block.size || 1) >= 1
        && blockInCell(block, cell)
      ));
      if (index < 0) return actionResult(command.action, 0, 'not_found', { subdivided: 0, removed: 0 });
      const original = contraption.blocks[index];
      contraption.blocks.splice(index, 1);
      for (let ix = 0; ix < 5; ix++) {
        for (let iy = 0; iy < 5; iy++) {
          for (let iz = 0; iz < 5; iz++) {
            contraption.blocks.push({
              localX: cell.x + ix * 0.2,
              localY: cell.y + iy * 0.2,
              localZ: cell.z + iz * 0.2,
              size: 0.2,
              color: original.color ?? DEFAULT_BLOCK_COLOR,
              block: original.block || BlockTypes.COLOR_BLOCK,
              entityId: original.entityId ?? nodeId,
              ...(original.part ? { part: original.part } : {})
            });
          }
        }
      }
      let removed = 0;
      if (micro) {
        const localX = micro.x / 5;
        const localY = micro.y / 5;
        const localZ = micro.z / 5;
        const carveIndex = contraption.blocks.findIndex(block => (
          blockOwnerId(contraption, block) === String(original.entityId ?? nodeId)
          && (block.size || 1) < 1
          && Math.abs(block.localX - localX) < 1e-3
          && Math.abs(block.localY - localY) < 1e-3
          && Math.abs(block.localZ - localZ) < 1e-3
        ));
        if (carveIndex >= 0) {
          contraption.blocks.splice(carveIndex, 1);
          removed = 1;
        }
      }
      finishEntityMutation(context, contraption, 'subdivide', String(original.entityId ?? nodeId), entityMutationEvent(command, {
        cell: [cell.x, cell.y, cell.z],
        microOffset: micro ? [
          ((micro.x % 5) + 5) % 5,
          ((micro.y % 5) + 5) % 5,
          ((micro.z % 5) + 5) % 5
        ] : null,
        size: 0.2,
        block: original.block,
        color: original.color
      }));
      return actionResult(command.action, 125, 'subdivided', { subdivided: 125, removed, empty: false });
    }
    case 'remove-blocks': {
      const selectedBlocks = Array.isArray(command.blocks) ? command.blocks : [];
      const selected = new Set(selectedBlocks);
      if (selected.size === 0) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      const before = contraption.blocks.length;
      contraption.blocks = contraption.blocks.filter(block => !selected.has(block));
      const removed = before - contraption.blocks.length;
      if (!removed) return actionResult(command.action, 0, 'not_found', { removed: 0 });
      const empty = finishEntityMutation(context, contraption, 'remove', nodeId, entityMutationEvent(command, {
        cells: selectedBlocks.slice(0, 64).map(block => [block.localX, block.localY, block.localZ]),
        truncated: selectedBlocks.length > 64
      }));
      return actionResult(command.action, removed, 'removed', { removed, empty });
    }
    case 'remove-subtree': {
      if (!contraption.entityNodes?.has(nodeId)) {
        return actionResult(command.action, 0, 'component_not_found', {
          removed: 0,
          standard: 0,
          micro: 0,
          entities: 0,
          components: 0
        });
      }
      const nodeIds = contraption.collectSubtreeNodeIds?.(nodeId) || new Set([nodeId]);
      const removedBlocks = contraption.blocks.filter(block => nodeIds.has(blockOwnerId(contraption, block)));
      const standard = removedBlocks.filter(block => (block.size || 1) >= 1).length;
      const micro = removedBlocks.length - standard;
      const manager = context?.manager || contraption.actionContext?.manager;
      const removesWholeEntity = nodeId === entityRootId(contraption) || removedBlocks.length === contraption.blocks.length;

      if (removesWholeEntity) {
        if (!manager?.contraptions?.includes(contraption)) {
          return actionResult(command.action, 0, 'entity_unmanaged', {
            removed: 0,
            standard: 0,
            micro: 0,
            entities: 0,
            components: 0
          });
        }
        const entityId = contraption.publicId ?? null;
        const runtimeId = contraption.id ?? null;
        manager.removeContraption(contraption);
        return actionResult(command.action, Math.max(1, removedBlocks.length), 'entity_removed', {
          removed: removedBlocks.length,
          standard,
          micro,
          entities: 1,
          components: nodeIds.size,
          entityId,
          runtimeId,
          nodeId,
          empty: true
        });
      }

      const result = contraption.removeComponentSubtree?.(nodeId);
      if (!result) {
        return actionResult(command.action, 0, 'component_not_found', {
          removed: 0,
          standard: 0,
          micro: 0,
          entities: 0,
          components: 0
        });
      }
      return actionResult(command.action, Math.max(1, result.removed + result.components), 'subtree_removed', {
        ...result,
        entities: 0,
        entityId: contraption.publicId ?? null,
        runtimeId: contraption.id ?? null,
        empty: false
      });
    }
    case 'start-scripts': {
      const hasRunnableCode = !!contraption.compiledScript || (contraption.compiledNodeScripts?.size || 0) > 0;
      if (!hasRunnableCode) {
        if (contraption.isPhysicsSimulationEnabled?.() === false) {
          contraption.enableAllNodeScripts?.();
          invalidateInternalEntitySelections(context, contraption);
          return actionResult(command.action, 1, 'started', {
            status: contraption.scriptStatus || 'stopped',
            physicsEnabled: true
          });
        }
        return actionResult(command.action, 0, 'no_scripts', { status: contraption.scriptStatus || 'stopped' });
      }
      contraption.enableAllNodeScripts?.();
      invalidateInternalEntitySelections(context, contraption);
      return actionResult(command.action, 1, 'started', {
        status: contraption.scriptStatus || 'running',
        physicsEnabled: contraption.isPhysicsSimulationEnabled?.() !== false
      });
    }
    case 'pause-scripts': {
      if (contraption.scriptStatus !== 'running') {
        return actionResult(command.action, 0, 'already_paused', { status: contraption.scriptStatus || 'stopped' });
      }
      contraption.disableAllNodeScripts?.();
      invalidateInternalEntitySelections(context, contraption);
      return actionResult(command.action, 1, 'paused', { status: contraption.scriptStatus || 'running' });
    }
    case 'stop-scripts': {
      if (contraption.scriptStatus === 'stopped' && contraption.isPhysicsSimulationEnabled?.() === false) {
        return actionResult(command.action, 0, 'already_stopped', { status: 'stopped', physicsEnabled: false });
      }
      contraption.stopAllNodeScripts?.();
      return actionResult(command.action, 1, 'stopped', {
        status: contraption.scriptStatus || 'stopped',
        physicsEnabled: contraption.isPhysicsSimulationEnabled?.() !== false
      });
    }
    case 'toggle-scripts': {
      const nextAction = contraption.isPhysicsSimulationEnabled?.() === false
        ? 'start-scripts'
        : 'stop-scripts';
      const result = executeEntityAction(context, { ...command, action: nextAction });
      return { ...result, action: command.action };
    }
    case 'disassemble': {
      if (contraption.scriptStatus !== 'stopped') {
        contraption.stopAllNodeScripts?.();
      }
      const changed = context?.manager?.disassembleContraption?.(contraption) ? 1 : 0;
      return actionResult(command.action, changed, changed ? 'disassembled' : 'not_found', { disassembled: changed });
    }
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}

function toPoint(value: any) {
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  if (value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)) && Number.isFinite(Number(value.z))) {
    return new THREE.Vector3(Number(value.x), Number(value.y), Number(value.z));
  }
  return null;
}

function executeQueryAction(context: any, command: any) {
  if (command.action !== 'raycast') return actionResult(command.action, 0, 'unsupported_action');
  const world = context?.world || context?.manager?.world;
  const manager = context?.manager;
  const origin = toPoint(command.origin);
  const direction = toPoint(command.direction);
  if (!origin || !direction || direction.lengthSq() < 1e-12) {
    return { ok: false, action: command.action, reason: 'invalid_ray', hit: null, worldHit: null, entityHit: null };
  }
  direction.normalize();
  const requestedDistance = Number(command.maxDistance);
  const maxDistance = Math.min(64, Math.max(0, Number.isFinite(requestedDistance) ? requestedDistance : 24));
  const space = command.space === 'bent' ? 'bent' : 'world';
  const includeWorld = command.include !== 'entities';
  const includeEntities = command.include === 'all' || command.include === 'entities';
  const kinds = Array.isArray(command.voxelKinds) ? command.voxelKinds : ['standard', 'micro'];
  // Player hover normally agrees with the mesh currently on screen while an
  // update is being built. A destructive interaction may explicitly inspect
  // the live view after its published target has already been consumed.
  const usePublishedCollision = typeof command.usePublishedCollision === 'boolean'
    ? command.usePublishedCollision
    : command.actor?.source !== 'script';

  let standardHit = null;
  let microHit = null;
  if (includeWorld && kinds.includes('standard')) {
    standardHit = space === 'bent'
      ? world?.raycastBent?.(origin, direction, maxDistance, usePublishedCollision)
      : world?.raycast?.(origin, direction, maxDistance);
  }
  if (includeWorld && kinds.includes('micro')) {
    microHit = space === 'bent'
      ? world?.raycastMicroBent?.(origin, direction, maxDistance, usePublishedCollision)
      : world?.raycastMicro?.(origin, direction, maxDistance, usePublishedCollision);
  }
  const standardDistance = standardHit?.hit && Number.isFinite(Number(standardHit.distance))
    ? Number(standardHit.distance)
    : Infinity;
  const microDistance = microHit?.hit && Number.isFinite(Number(microHit.distance))
    ? Number(microHit.distance)
    : Infinity;
  const worldHit = microDistance < standardDistance ? microHit : standardHit;
  const worldDistance = worldHit?.hit && Number.isFinite(Number(worldHit.distance))
    ? Number(worldHit.distance)
    : Infinity;

  let entityHit = null;
  if (includeEntities) {
    entityHit = space === 'bent'
      ? manager?.raycastContraptionHitBent?.(origin, direction, maxDistance)
      : manager?.raycastContraptionHit?.(origin, direction, maxDistance);
  }
  const entityDistance = entityHit && Number.isFinite(Number(entityHit.distance))
    ? Number(entityHit.distance)
    : Infinity;
  const hit = entityDistance <= worldDistance + 1e-4 ? entityHit : (worldHit?.hit ? worldHit : null);
  return {
    ok: !!hit,
    action: command.action,
    reason: hit ? 'hit' : 'miss',
    kind: hit === entityHit && hit ? 'entity' : hit ? 'world' : null,
    hit,
    worldHit: worldHit?.hit ? worldHit : null,
    entityHit
  };
}

function clearEntitySelection(managerOrOwner: any) {
  if (!managerOrOwner) return;
  managerOrOwner.entitySelection?.contraption?.clearSubtreeHighlight?.();
  managerOrOwner.entitySelection = null;
  managerOrOwner.selectedSubtree?.contraption?.clearSubtreeHighlight?.();
  managerOrOwner.selectedSubtree = null;
  managerOrOwner.selectedBlockSelection?.contraption?.clearSubtreeHighlight?.();
  managerOrOwner.selectedBlockSelection = null;
}

function canEditInternalSelection(contraption: any) {
  return !!contraption && (typeof contraption.canEditInternalSelection === 'function'
    ? contraption.canEditInternalSelection()
    : contraption.scriptStatus === 'stopped');
}

function isInternalEntitySelection(selection: any, contraption: any) {
  if (!selection || selection.contraption !== contraption) return false;
  if (selection.kind === 'entity-blocks' || Array.isArray(selection.blocks)) return true;
  return requestedNodeId(contraption, selection.nodeId, selection.rootId) !== entityRootId(contraption);
}

/**
 * Starting or pausing an entity invalidates any construction-grid selection
 * that was created while it was stopped. A whole-root selection remains valid.
 */
function invalidateInternalEntitySelections(context: any, contraption: any) {
  const owners = new Set([
    context?.selectionHost,
    context?.manager,
    contraption?.actionContext?.manager
  ].filter(Boolean));

  for (const owner of owners) {
    const hasInternalSelection = isInternalEntitySelection(owner.entitySelection, contraption)
      || owner.childSelection?.contraption === contraption
      || owner.selectedBlockSelection?.contraption === contraption
      || (owner.selectedSubtree?.contraption === contraption
        && requestedNodeId(contraption, owner.selectedSubtree.rootId) !== entityRootId(contraption))
      || owner.selectorLevel?.contraption === contraption
      || owner.selectorRange?.contraption === contraption;
    if (!hasInternalSelection) continue;

    contraption.clearSubtreeHighlight?.();
    contraption.clearGlueSelection?.();
    if (owner.entitySelection?.contraption === contraption) owner.entitySelection = null;
    if (owner.childSelection?.contraption === contraption) owner.childSelection = null;
    if (owner.selectedBlockSelection?.contraption === contraption) owner.selectedBlockSelection = null;
    if (owner.selectedSubtree?.contraption === contraption) owner.selectedSubtree = null;
    if (owner.selectorLevel?.contraption === contraption) owner.selectorLevel = null;
    if (owner.selectorRange?.contraption === contraption) owner.selectorRange = null;
  }
}

function entityBoxMatches(contraption: any, nodeId: string, pointA: any, pointB: any, space = 'node-local', microOnly = false) {
  const node = contraption?.entityNodes?.get(nodeId);
  const a = toPoint(pointA);
  const b = toPoint(pointB);
  if (!node || !a || !b) return { selected: [], components: [] };
  node.group?.updateWorldMatrix?.(true, false);
  const aLocal = space === 'world' ? node.group.worldToLocal(a.clone()) : a;
  const bLocal = space === 'world' ? node.group.worldToLocal(b.clone()) : b;
  const bounds = new THREE.Box3(
    new THREE.Vector3(Math.min(aLocal.x, bLocal.x), Math.min(aLocal.y, bLocal.y), Math.min(aLocal.z, bLocal.z)),
    new THREE.Vector3(Math.max(aLocal.x, bLocal.x), Math.max(aLocal.y, bLocal.y), Math.max(aLocal.z, bLocal.z))
  ).expandByScalar(1e-6);
  const isMicroBlock = block => (block.size || 1) < 1;
  const pivot = node.pivotLocal;
  const blockBounds = new THREE.Box3();
  const selected = contraption.blocks.filter(block => {
    if (blockOwnerId(contraption, block) !== nodeId) return false;
    if (microOnly && !isMicroBlock(block)) return false;
    const size = block.size || 1;
    blockBounds.set(
      new THREE.Vector3(block.localX - pivot.x, block.localY - pivot.y, block.localZ - pivot.z),
      new THREE.Vector3(block.localX + size - pivot.x, block.localY + size - pivot.y, block.localZ + size - pivot.z)
    );
    return blockBounds.intersectsBox(bounds);
  });

  const components: string[] = [];
  if (selected.length === 0 && node.group) {
    const worldA = space === 'world' ? a.clone() : node.group.localToWorld(a.clone());
    const worldB = space === 'world' ? b.clone() : node.group.localToWorld(b.clone());
    for (const other of contraption.entityNodes.values()) {
      if (other.id === nodeId) continue;
      const otherA = other.group.worldToLocal(worldA.clone());
      const otherB = other.group.worldToLocal(worldB.clone());
      const otherBounds = new THREE.Box3(
        new THREE.Vector3(Math.min(otherA.x, otherB.x), Math.min(otherA.y, otherB.y), Math.min(otherA.z, otherB.z)),
        new THREE.Vector3(Math.max(otherA.x, otherB.x), Math.max(otherA.y, otherB.y), Math.max(otherA.z, otherB.z))
      ).expandByScalar(1e-6);
      const otherPivot = other.pivotLocal;
      const found = contraption.blocks.some(block => {
        if (blockOwnerId(contraption, block) !== other.id) return false;
        if (microOnly && !isMicroBlock(block)) return false;
        const size = block.size || 1;
        blockBounds.set(
          new THREE.Vector3(block.localX - otherPivot.x, block.localY - otherPivot.y, block.localZ - otherPivot.z),
          new THREE.Vector3(block.localX + size - otherPivot.x, block.localY + size - otherPivot.y, block.localZ + size - otherPivot.z)
        );
        return blockBounds.intersectsBox(otherBounds);
      });
      if (found) components.push(other.id);
    }
  }
  return { selected, components };
}

function selectionSnapshot(manager: any) {
  let entity = manager?.entitySelection;
  if (entity && isInternalEntitySelection(entity, entity.contraption)
    && !canEditInternalSelection(entity.contraption)) {
    clearEntitySelection(manager);
    entity = null;
  }
  if (entity) {
    return {
      kind: entity.kind,
      entityId: entity.contraption?.publicId ?? null,
      runtimeId: entity.contraption?.id ?? null,
      nodeId: requestedNodeId(entity.contraption, entity.nodeId, entity.rootId),
      count: entity.kind === 'entity-blocks' ? entity.blocks.length : entity.nodeIds?.size || 0,
      ready: true
    };
  }
  const info = manager?.getWorldGlueSelectionInfo?.() || { mode: 'box', pointCount: 0, count: 0, ready: false };
  const bounds = manager?.getSelectionBounds?.() || null;
  return {
    kind: info.mode === 'single' ? 'world-cells' : 'world-box',
    ...info,
    bounds: bounds ? { ...bounds } : null
  };
}

function executeSelectionAction(context: any, command: any) {
  const manager = context?.manager;
  const owner = manager || context?.selectionHost;
  if (!owner) return actionResult(command.action, 0, 'selection_unavailable');

  switch (command.action) {
    case 'get':
      return selectionSnapshot(owner);
    case 'clear':
      clearEntitySelection(owner);
      manager?.clearSelection?.();
      return actionResult(command.action, 1, 'cleared', { cleared: 1 });
    case 'corner-a':
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      clearEntitySelection(owner);
      manager.setCornerA?.(toPoint(command.point), { micro: command.micro === true });
      return actionResult(command.action, 1, 'selected', { selected: 1 });
    case 'corner-b': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      clearEntitySelection(owner);
      const cornerInfo = manager.setCornerB?.(toPoint(command.point), { micro: command.micro === true });
      return actionResult(command.action, 1, 'selected', {
        selected: 1,
        clamped: !!cornerInfo?.clamped,
        materialized: cornerInfo?.materialized
      });
    }
    case 'box': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      const a = toPoint(command.a ?? command.cornerA);
      const b = toPoint(command.b ?? command.cornerB);
      if (!a || !b) return actionResult(command.action, 0, 'invalid_position', { selected: 0 });
      clearEntitySelection(owner);
      manager.setCornerA?.(a, { micro: command.micro === true });
      const boxInfo = manager.setCornerB?.(b, { micro: command.micro === true });
      const selected = manager.getSelectionBlockCount?.() || 0;
      return actionResult(command.action, 1, 'selected', { selected, clamped: !!boxInfo?.clamped, selection: selectionSnapshot(manager) });
    }
    case 'cells': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      const cells = Array.isArray(command.cells) ? command.cells.map(item => finiteCell(item, true)).filter(Boolean) : [];
      clearEntitySelection(owner);
      const accepted = manager.setConnectedSelection?.(cells) !== false;
      if (!accepted) return actionResult(command.action, 0, 'bounds_exceeded', { selected: 0 });
      return actionResult(command.action, cells.length, cells.length ? 'selected' : 'empty', { selected: cells.length });
    }
    case 'toggle-cell': {
      if (!manager) return actionResult(command.action, 0, 'selection_unavailable');
      clearEntitySelection(owner);
      const point = toPoint(command.point);
      const info = command.micro === true
        ? manager.toggleMicroCell?.(point)
        : manager.toggleWorldGlueCell?.(point);
      if (!info) return actionResult(command.action, 0, 'invalid_position', { selection: null });
      if (info.rejected) return actionResult(command.action, 0, 'bounds_exceeded', { selection: info });
      return actionResult(command.action, 1, 'selected', { selection: info });
    }
    case 'entity-subtree': {
      const contraption = resolveContraption(context, command.target || { entityId: command.entityId });
      const nodeId = requestedNodeId(contraption, command.nodeId);
      if (!contraption?.entityNodes?.has(nodeId)) return actionResult(command.action, 0, 'entity_not_found', { selected: 0 });
      if (nodeId !== entityRootId(contraption) && !canEditInternalSelection(contraption)) {
        invalidateInternalEntitySelections(context, contraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { selected: 0 });
      }
      clearEntitySelection(owner);
      manager?.clearSelection?.();
      const nodeIds = contraption.collectSubtreeNodeIds?.(nodeId) || new Set([nodeId]);
      contraption.clearSubtreeHighlight?.();
      contraption.highlightSubtree?.([...nodeIds]);
      owner.entitySelection = { kind: 'entity-subtree', contraption, rootId: nodeId, nodeId, nodeIds };
      const selected = contraption.blocks.filter(block => nodeIds.has(blockOwnerId(contraption, block))).length;
      return actionResult(command.action, selected || 1, 'selected', { selected, selection: owner.entitySelection });
    }
    case 'entity-box': {
      const contraption = resolveContraption(context, command.target || { entityId: command.entityId });
      const nodeId = requestedNodeId(contraption, command.nodeId);
      if (!contraption) return actionResult(command.action, 0, 'entity_not_found', { selected: 0, components: [] });
      if (!canEditInternalSelection(contraption)) {
        invalidateInternalEntitySelections(context, contraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { selected: 0, components: [] });
      }
      const matches = entityBoxMatches(contraption, nodeId, command.a, command.b, command.space, command.micro === true);
      if (matches.selected.length === 0) {
        return actionResult(command.action, 0, 'not_found', { selected: 0, components: matches.components });
      }
      clearEntitySelection(owner);
      manager?.clearSelection?.();
      contraption.clearSubtreeHighlight?.();
      contraption.highlightBlocks?.(matches.selected);
      owner.entitySelection = { kind: 'entity-blocks', contraption, nodeId, blocks: matches.selected };
      return actionResult(command.action, matches.selected.length, 'selected', {
        selected: matches.selected.length,
        selection: owner.entitySelection,
        components: []
      });
    }
    case 'toggle-entity-block': {
      const contraption = resolveContraption(context, command.target || { entityId: command.entityId });
      const nodeId = requestedNodeId(contraption, command.nodeId);
      const block = command.block;
      if (!contraption) return actionResult(command.action, 0, 'entity_not_found', { selected: 0 });
      if (!canEditInternalSelection(contraption)) {
        invalidateInternalEntitySelections(context, contraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { selected: 0 });
      }
      if (!block) return actionResult(command.action, 0, 'invalid_block', { selected: 0 });

      // If existing selection is on a different contraption, clear it first
      if (owner.entitySelection && owner.entitySelection.contraption !== contraption) {
        clearEntitySelection(owner);
      }
      manager?.clearSelection?.();

      let currentBlocks: any[] = [];
      const currentSelection = owner.entitySelection?.kind === 'entity-blocks' && owner.entitySelection?.contraption === contraption
        ? owner.entitySelection
        : (context?.selectionHost?.selectedBlockSelection?.contraption === contraption
          ? context.selectionHost.selectedBlockSelection
          : null);
      if (currentSelection && Array.isArray(currentSelection.blocks)) {
        currentBlocks = [...currentSelection.blocks];
      }

      const isSameBlock = (b1: any, b2: any) => {
        if (b1 === b2) return true;
        const e1 = blockOwnerId(contraption, b1);
        const e2 = blockOwnerId(contraption, b2);
        return e1 === e2
          && Math.abs(b1.localX - b2.localX) < 1e-4
          && Math.abs(b1.localY - b2.localY) < 1e-4
          && Math.abs(b1.localZ - b2.localZ) < 1e-4
          && Math.abs((b1.size || 1) - (b2.size || 1)) < 1e-4;
      };

      const existingIndex = currentBlocks.findIndex(b => isSameBlock(b, block));
      if (existingIndex >= 0) {
        currentBlocks.splice(existingIndex, 1);
      } else {
        const targetBlock = contraption.blocks.find((b: any) => isSameBlock(b, block)) || block;
        currentBlocks.push(targetBlock);
      }

      contraption.clearSubtreeHighlight?.();
      if (currentBlocks.length > 0) {
        contraption.highlightBlocks?.(currentBlocks);
        owner.entitySelection = { kind: 'entity-blocks', contraption, nodeId, blocks: currentBlocks };
        return actionResult(command.action, currentBlocks.length, 'selected', {
          selected: currentBlocks.length,
          selection: owner.entitySelection
        });
      } else {
        owner.entitySelection = null;
        return actionResult(command.action, 0, 'empty', { selected: 0, selection: null });
      }
    }
    case 'delete': {
      const selected = command.selection || owner.entitySelection;
      if (selected?.kind === 'entity-subtree' && selected?.contraption) {
        const nodeId = requestedNodeId(selected.contraption, selected.nodeId, selected.rootId);
        if (nodeId !== entityRootId(selected.contraption) && !canEditInternalSelection(selected.contraption)) {
          invalidateInternalEntitySelections(context, selected.contraption);
          return actionResult(command.action, 0, 'entity_not_stopped', {
            removed: 0,
            standard: 0,
            micro: 0,
            entities: 0,
            components: 0
          });
        }
        const result = executeEntityAction(context, {
          action: 'remove-subtree',
          target: { contraption: selected.contraption },
          nodeId,
          actor: command.actor
        });
        selected.contraption?.clearSubtreeHighlight?.();
        owner.entitySelection = null;
        return result;
      }
      if (selected?.kind === 'entity-blocks' || (selected?.contraption && Array.isArray(selected?.blocks))) {
        if (!canEditInternalSelection(selected.contraption)) {
          invalidateInternalEntitySelections(context, selected.contraption);
          return actionResult(command.action, 0, 'entity_not_stopped', {
            removed: 0,
            standard: 0,
            micro: 0,
            entities: 0,
            components: 0
          });
        }
        const result = executeEntityAction(context, {
          action: 'remove-blocks',
          target: { contraption: selected.contraption },
          nodeId: selected.nodeId,
          blocks: selected.blocks,
          actor: command.actor
        });
        selected.contraption?.clearSubtreeHighlight?.();
        owner.entitySelection = null;
        return result;
      }
      if (!manager?.hasValidSelection?.()) return actionResult(command.action, 0, 'no_selection', { removed: 0 });
      if (manager.microSelection !== null) {
        // Sparse micro selection (Selector micro mode): remove exactly the
        // selected 0.2 m cells that hold a micro voxel.
        const world = context?.world;
        const subdividedStandardCells = new Set<string>();
        for (const cell of manager.microSelection) {
          const wx = Math.floor(cell.x / MICRO_DIVISIONS);
          const wy = Math.floor(cell.y / MICRO_DIVISIONS);
          const wz = Math.floor(cell.z / MICRO_DIVISIONS);
          const cellKey = `${wx},${wy},${wz}`;
          if (!subdividedStandardCells.has(cellKey)) {
            if (world?.getBlock && world.getBlock(wx, wy, wz) !== BlockTypes.AIR) {
              world.subdivideBlock?.(wx, wy, wz);
            }
            subdividedStandardCells.add(cellKey);
          }
        }

        let removedMicro = 0;
        for (const cell of manager.microSelection) {
          if (cell.y < 0 || cell.y >= CHUNK_SIZE_Y * MICRO_DIVISIONS) continue;
          removedMicro += executeWorldAction(context, { action: 'remove-micro', micro: cell }).removed || 0;
        }
        manager.clearSelection?.();
        return actionResult(command.action, removedMicro, removedMicro ? 'removed' : 'not_found', {
          removed: removedMicro,
          standard: 0,
          micro: removedMicro,
          entities: 0,
          components: 0
        });
      }
      const bounds = manager.getSelectionBounds?.();
      const cells = manager.connectedSelection !== null
        ? [...(manager.connectedSelection || [])]
        : bounds
          ? (() => {
              const result: any[] = [];
              for (let x = bounds.minX; x <= bounds.maxX; x++) {
                for (let y = bounds.minY; y <= bounds.maxY; y++) {
                  for (let z = bounds.minZ; z <= bounds.maxZ; z++) result.push({ x, y, z });
                }
              }
              return result;
            })()
          : [];
      const result = executeWorldAction(context, { action: 'remove-cells', cells });
      manager.clearSelection?.();
      return result;
    }
    case 'assemble': {
      const mode = manager?.normalizeAssemblyMode?.(command.mode);
      if (!mode) {
        return actionResult(command.action, 0, 'invalid_mode', {
          assembled: 0,
          entity: null,
          entityId: null,
          runtimeId: null
        });
      }
      const prepared = command.prepared;
      if (!prepared && !manager?.hasValidSelection?.()) {
        return actionResult(command.action, 0, 'no_selection', {
          assembled: 0,
          entity: null,
          entityId: null,
          runtimeId: null
        });
      }
      const entity = prepared
        ? manager.commitPreparedAssembly?.(
            prepared.blocks,
            new THREE.Vector3(
              Number(prepared.origin?.x) || 0,
              Number(prepared.origin?.y) || 0,
              Number(prepared.origin?.z) || 0
            ),
            mode,
            command.options || {}
          )
        : manager.assembleSelection?.(mode, command.options || {});
      return actionResult(command.action, entity ? 1 : 0, entity ? 'assembled' : 'empty', {
        assembled: entity ? 1 : 0,
        entity,
        entityId: entity?.publicId ?? null,
        runtimeId: entity?.id ?? null
      });
    }
    case 'create-child': {
      const selected = command.selection || owner.entitySelection;
      const legacyContraption = manager?.childSelection?.contraption;
      const targetContraption = selected?.contraption || legacyContraption;
      if (targetContraption && !canEditInternalSelection(targetContraption)) {
        invalidateInternalEntitySelections(context, targetContraption);
        return actionResult(command.action, 0, 'entity_not_stopped', { child: null, childId: null });
      }
      if ((!selected?.contraption || !Array.isArray(selected.blocks) || selected.blocks.length === 0)
        && manager?.hasReadyChildSelection?.()) {
        const legacyResult = manager.createChildFromSelection?.(command.id || null);
        const child = legacyResult?.child || null;
        return actionResult(command.action, child ? 1 : 0, child ? 'created' : 'not_found', {
          child,
          childId: child?.id ?? null,
          contraption: legacyResult?.contraption || null
        });
      }
      if (!selected?.contraption || !Array.isArray(selected.blocks) || selected.blocks.length === 0) {
        return actionResult(command.action, 0, 'no_selection', { child: null });
      }
      const child = selected.preparedBounds
        ? selected.contraption.createChildEntityFromPrepared?.(
            requestedNodeId(selected.contraption, selected.nodeId),
            selected.blocks,
            selected.preparedBounds,
            command.id || null
          )
        : selected.contraption.createChildEntity?.(
            requestedNodeId(selected.contraption, selected.nodeId),
            selected.blocks,
            command.id || null
          );
      if (child) {
        selected.contraption.clearSubtreeHighlight?.();
        owner.entitySelection = null;
      }
      return actionResult(command.action, child ? 1 : 0, child ? 'created' : 'not_found', { child, childId: child?.id ?? null });
    }
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}

function executePhysicsAction(context: any, command: any) {
  const contraption = resolveContraption(context, command.target);
  if (!contraption) return actionResult(command.action, 0, 'entity_unavailable');
  const nodeId = requestedNodeId(contraption, command.nodeId);

  switch (command.action) {
    case 'get-body': {
      const body = contraption.getRigidBody?.(nodeId);
      if (!body) return null;
      return Object.freeze({
        nodeId,
        type: body.type,
        mass: body.mass,
        restitution: body.restitution,
        friction: body.friction,
        useGravity: contraption.getNodeGravityEnabled?.(nodeId) ?? true,
        collisionEnabled: contraption.getNodeCollisionEnabled?.(nodeId) ?? true,
        velocity: Object.freeze(body.velocity.toArray()),
        angularVelocity: Object.freeze(body.angularVelocity.toArray())
      });
    }
    case 'set-body-type': {
      const changed = contraption.setNodeBodyType?.(nodeId, command.bodyType, {
        runtimeOnly: command.runtimeOnly === true
      }) ? 1 : 0;
      return actionResult(command.action, changed, changed ? 'updated' : 'invalid_body_type', {
        bodyType: contraption.getNodeBodyType?.(nodeId) || null
      });
    }
    case 'set-body-mass': {
      const requestedMass = Number(command.mass);
      if (!Number.isFinite(requestedMass) || requestedMass <= 0) {
        return actionResult(command.action, 0, 'invalid_mass', {
          mass: contraption.getNodeBodyMass?.(nodeId) ?? null
        });
      }
      const mass = contraption.setNodeBodyMass?.(nodeId, requestedMass, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, mass !== null && mass !== undefined ? 1 : 0, mass !== null && mass !== undefined ? 'updated' : 'body_unavailable', {
        mass: mass ?? contraption.getNodeBodyMass?.(nodeId) ?? null
      });
    }
    case 'set-body-material': {
      const material = contraption.setNodeBodyMaterial?.(nodeId, command.material || {}, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, material ? 1 : 0, material ? 'updated' : 'body_unavailable', { material });
    }
    case 'set-body-gravity-enabled': {
      if (typeof command.enabled !== 'boolean') {
        return actionResult(command.action, 0, 'invalid_enabled', {
          enabled: contraption.getNodeGravityEnabled?.(nodeId) ?? null
        });
      }
      const enabled = contraption.setNodeGravityEnabled?.(nodeId, command.enabled, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, enabled !== null && enabled !== undefined ? 1 : 0,
        enabled !== null && enabled !== undefined ? 'updated' : 'body_unavailable', { enabled });
    }
    case 'set-body-collision-enabled': {
      if (typeof command.enabled !== 'boolean') {
        return actionResult(command.action, 0, 'invalid_enabled', {
          enabled: contraption.getNodeCollisionEnabled?.(nodeId) ?? null
        });
      }
      const enabled = contraption.setNodeCollisionEnabled?.(nodeId, command.enabled, {
        runtimeOnly: command.runtimeOnly === true
      });
      return actionResult(command.action, enabled !== null && enabled !== undefined ? 1 : 0,
        enabled !== null && enabled !== undefined ? 'updated' : 'body_unavailable', { enabled });
    }
    case 'apply-body-force': {
      const applied = contraption.applyNodeBodyForce?.(nodeId, command.force) ? 1 : 0;
      return actionResult(command.action, applied, applied ? 'applied' : 'not_dynamic', { applied });
    }
    case 'apply-body-torque': {
      const applied = contraption.applyNodeBodyTorque?.(nodeId, command.torque) ? 1 : 0;
      return actionResult(command.action, applied, applied ? 'applied' : 'not_dynamic', { applied });
    }
    case 'create-constraint': {
      const constraint = contraption.createConstraint?.(command.definition || {});
      return actionResult(command.action, constraint ? 1 : 0, constraint ? 'created' : 'invalid_constraint', { constraint });
    }
    case 'remove-constraint': {
      const removed = contraption.removeConstraint?.(command.constraintId) ? 1 : 0;
      return actionResult(command.action, removed, removed ? 'removed' : 'not_found', { removed });
    }
    case 'get-constraints':
      return contraption.getConstraints?.(command.nodeId || null) || Object.freeze([]);
    default:
      return actionResult(command.action, 0, 'unsupported_action');
  }
}

export function executeBasicAction(context: any, command: any) {
  if (!command || typeof command !== 'object') return actionResult('unknown', 0, 'invalid_command');
  switch (command.domain) {
    case ActionDomain.WORLD:
      return executeWorldAction(context, command);
    case ActionDomain.ENTITY:
      return executeEntityAction(context, command);
    case ActionDomain.SELECTION:
      return executeSelectionAction(context, command);
    case ActionDomain.QUERY:
      return executeQueryAction(context, command);
    case ActionDomain.PHYSICS:
      return executePhysicsAction(context, command);
    default:
      return actionResult(command.action || 'unknown', 0, 'unsupported_domain');
  }
}

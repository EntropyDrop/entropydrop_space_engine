// Shared engine entry for the backend's Node build. No hosting policy or IPC lives here.
// Export Three from the same dependency graph as the engine to avoid duplicate instances.
export * as THREE from 'three';
export { World } from './voxel/World.ts';
export { ContraptionManager } from './contraption/ContraptionManager.ts';
export { ContraptionPhysics } from './physics/ContraptionPhysics.ts';
export {
  portableEntityToRuntime, runtimeEntityToPortable, decodeInventoryResource, encodeInventoryResource,
} from './storage/InventoryProtobuf.ts';
export { preloadQuickJSScriptRuntime } from './scripting/QuickJSScriptWorkerCore.ts';
export {
  wrapX, wrapZ, wrapChunkX, wrapChunkZ, unwrapPeriodicNear, TORUS_SIZE_X, TORUS_SIZE_Z,
} from './torus/TorusWorld.ts';

import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import quickJSVariant from '@jitl/quickjs-wasmfile-release-sync';

const ENTITY_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024;
const ENTITY_STACK_LIMIT_BYTES = 512 * 1024;
const COMPONENT_DEADLINE_MS = 5;
const ENTITY_TICK_DEADLINE_MS = 25;
// QuickJS calls the interrupt handler at deterministic VM checkpoints. The
// wall-clock deadline protects the page on fast and slow devices; this second,
// per-entity frame budget also stops scripts whose work grows without bound,
// independent of timer resolution.
const ENTITY_FRAME_INTERRUPT_LIMIT = 64;
const MAX_HOST_RAYCASTS_PER_TICK = 64;
const MAX_HOST_WORLD_READS_PER_TICK = 256;
const MAX_SCRIPT_COMPONENTS = 64;
const BOOTSTRAP_DEADLINE_MS = 100;

// Do not put WASM initialization behind a module-level await: this module is in
// Space's application import graph, so doing that makes entering the world wait
// for QuickJS even when no programmable entity is loaded. The first actual
// script request starts this promise; evals remain synchronous after it resolves.
type QuickJSModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;
let quickJSModule: QuickJSModule | null = null;
let quickJSModulePromise: Promise<QuickJSModule> | null = null;

export function preloadQuickJSScriptRuntime() {
  if (quickJSModule) return Promise.resolve(quickJSModule);
  if (!quickJSModulePromise) {
    quickJSModulePromise = newQuickJSWASMModuleFromVariant(quickJSVariant).then(module => {
      quickJSModule = module;
      return module;
    });
  }
  return quickJSModulePromise;
}

export function isQuickJSScriptRuntimeReady() {
  return quickJSModule !== null;
}

const QUICKJS_BOOTSTRAP = String.raw`
(() => {
  const scripts = new Map();
  let states = Object.create(null);
  let frame = null;
  let rootComponentId = '';
  let componentMap = new Map();
  let selfCache = new Map();
  let commands = [];
  let nextCommandId = 1;
  let errors = [];
  let stopped = false;
  let worldVoxelOverlays = new Map();
  let worldMicroVoxelOverlays = new Map();
  const STOP = Object.freeze({ kind: 'space-stop' });
  const MAX_COMMANDS = 256;
  const MAX_BODY_VECTOR_COMPONENT = 1e12;

  const clone = value => {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  };
  const harden = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const key of Object.keys(value)) harden(value[key]);
    return Object.freeze(value);
  };
  const frozenClone = value => harden(clone(value));
  const collectFrozenPaths = (value, path = [], result = []) => {
    if (!value || typeof value !== 'object') return result;
    if (Object.isFrozen(value)) result.push(path);
    for (const key of Object.keys(value)) collectFrozenPaths(value[key], [...path, key], result);
    return result;
  };
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const vector = value => Array.isArray(value)
    ? [finite(value[0]), finite(value[1]), finite(value[2])]
    : [0, 0, 0];
  const boundedBodyVector = value => {
    if (!Array.isArray(value) || value.length < 3) return null;
    const result = value.slice(0, 3).map(Number);
    return result.every(component => Number.isFinite(component)
      && Math.abs(component) <= MAX_BODY_VECTOR_COMPONENT) ? result : null;
  };
  const emit = (scope, nodeId, path, args) => {
    if (commands.length >= MAX_COMMANDS) return null;
    const commandId = 'cmd-' + nextCommandId++;
    commands.push({
      commandId,
      scope,
      nodeId: nodeId === null || nodeId === undefined ? null : String(nodeId),
      path,
      args: clone(args) || []
    });
    return commandId;
  };
  const queuedEdit = (field, commandId, amount = 1) => Object.freeze({
    ok: !!commandId,
    [field]: commandId ? amount : 0,
    reason: commandId ? 'queued' : 'command_limit',
    commandId: commandId || null
  });
  const queuedResult = (commandId, values, rejectedValues = {}) => Object.freeze({
    ok: !!commandId,
    ...(commandId ? values : rejectedValues),
    reason: commandId ? 'queued' : 'command_limit',
    commandId: commandId || null
  });
  const inputCode = value => {
    if (typeof value !== 'string') return '';
    const clean = value.trim();
    const alias = { shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt' }[clean.toLowerCase()];
    return alias || clean;
  };
  const codeActive = (list, requested) => {
    const code = inputCode(requested);
    if (!code) return false;
    if (code === 'Shift') return list.includes('ShiftLeft') || list.includes('ShiftRight');
    if (code === 'Control') return list.includes('ControlLeft') || list.includes('ControlRight');
    if (code === 'Alt') return list.includes('AltLeft') || list.includes('AltRight');
    return list.includes(code);
  };
  const rotateVector = (direction, quaternion) => {
    const v = vector(direction);
    const q = Array.isArray(quaternion) ? quaternion.map(finite) : [0, 0, 0, 1];
    const x = v[0], y = v[1], z = v[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return Object.freeze([
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx
    ]);
  };

  function makeVoxelApi(nodeId, micro) {
    const prefix = micro ? 'microVoxels.' : 'voxels.';
    const api = {
      set(...args) { return queuedEdit('placed', emit('component', nodeId, prefix + 'set', args)); },
      clear(...args) { return queuedEdit('removed', emit('component', nodeId, prefix + 'clear', args)); },
      paint(...args) {
        return queuedEdit('painted', emit('component', nodeId, prefix + 'paint', args));
      }
    };
    if (!micro) {
      api.clearCell = (...args) => queuedEdit('removed', emit('component', nodeId, 'voxels.clearCell', args));
      api.subdivide = (...args) => {
        const accepted = emit('component', nodeId, 'voxels.subdivide', args);
        return queuedResult(accepted, { subdivided: 1, removed: 0 }, { subdivided: 0, removed: 0 });
      };
    }
    return Object.freeze(api);
  }

  function getSelf(nodeId) {
    const id = String(nodeId || rootComponentId);
    if (selfCache.has(id)) return selfCache.get(id);
    const node = componentMap.get(id);
    if (!node) return null;
    if (!states[id] || typeof states[id] !== 'object' || Array.isArray(states[id])) states[id] = {};
    const isRoot = node.parentId === null || node.parentId === undefined;
    const api = {
      apiVersion: 2,
      id,
      parentId: node.parentId ?? null,
      state: states[id],
      applyThrust: force => { emit('component', id, 'applyThrust', [force]); },
      applyLocalThrust: force => { emit('component', id, 'applyLocalThrust', [force]); },
      getWorldPosition: () => frozenClone(node.worldPosition || [0, 0, 0]),
      getWorldRotation: () => frozenClone(node.worldRotation || [0, 0, 0, 1]),
      getPivot: () => frozenClone(node.pivot || [0, 0, 0]),
      localToWorldDirection: direction => rotateVector(direction, node.worldRotation),
      getBounds: () => frozenClone(node.bounds),
      setLocalPosition: value => { emit('component', id, 'setLocalPosition', [value]); },
      setLocalRotation: value => { emit('component', id, 'setLocalRotation', [value]); },
      setLocalEuler: value => { emit('component', id, 'setLocalEuler', [value]); },
      setLocalSpin: (axis, rpm) => { emit('component', id, 'setLocalSpin', [axis, rpm]); },
      getLocalPosition: () => frozenClone(node.localPosition || [0, 0, 0]),
      getLocalRotation: () => frozenClone(node.localRotation || [0, 0, 0, 1]),
      setPivot: value => { emit('component', id, 'setPivot', [value]); },
      applyForce: force => { emit('component', id, 'applyForce', [force]); },
      applyLocalForce: force => { emit('component', id, 'applyLocalForce', [force]); },
      applyForceAt: (force, point) => { emit('component', id, 'applyForceAt', [force, point]); },
      applyTorque: torque => { emit('component', id, 'applyTorque', [torque]); },
      setSeats: values => { emit('component', id, 'setSeats', [values]); },
      getSeats: () => frozenClone(node.seats || []),
      stop: () => {
        if (!isRoot) return undefined;
        emit('control', id, 'stop', []);
        stopped = true;
        throw STOP;
      },
      child: childId => {
        const target = String(childId || '');
        return (node.children || []).includes(target) ? getSelf(target) : null;
      },
      children: () => Object.freeze((node.children || []).map(getSelf).filter(Boolean))
    };
    let bodyType = node.body?.type || 'dynamic';
    let bodyMass = finite(node.body?.mass);
    let bodyMaterial = frozenClone(node.body?.material || { restitution: 0.1, friction: 0.7 });
    let gravityEnabled = node.body?.useGravity !== false;
    let collisionEnabled = node.body?.collisionEnabled !== false;
    api.body = Object.freeze({
      getType: () => bodyType,
      setType: type => {
        if (type !== 'dynamic' && type !== 'kinematic') {
          return Object.freeze({ ok: false, type: bodyType, reason: 'invalid_body_type' });
        }
        const accepted = emit('component', id, 'body.setType', [type]);
        if (accepted) bodyType = type;
        return queuedResult(accepted, { type }, { type: bodyType });
      },
      getMass: () => bodyMass,
      setMass: mass => {
        const requestedMass = Number(mass);
        if (!Number.isFinite(requestedMass) || requestedMass <= 0) {
          return Object.freeze({ ok: false, mass: bodyMass, reason: 'invalid_mass' });
        }
        const safeMass = Math.max(0.1, requestedMass);
        const accepted = emit('component', id, 'body.setMass', [safeMass]);
        if (accepted) bodyMass = safeMass;
        return queuedResult(accepted, { mass: safeMass }, { mass: bodyMass });
      },
      getMaterial: () => bodyMaterial,
      setMaterial: material => {
        const nextMaterial = frozenClone(material);
        const accepted = emit('component', id, 'body.setMaterial', [material]);
        if (accepted) bodyMaterial = nextMaterial;
        return queuedResult(accepted, { material: nextMaterial }, { material: bodyMaterial });
      },
      getGravityEnabled: () => gravityEnabled,
      setGravityEnabled: enabled => {
        if (typeof enabled !== 'boolean') {
          return Object.freeze({ ok: false, enabled: gravityEnabled, reason: 'invalid_enabled' });
        }
        const accepted = emit('component', id, 'body.setGravityEnabled', [enabled]);
        if (accepted) gravityEnabled = enabled;
        return queuedResult(accepted, { enabled }, { enabled: gravityEnabled });
      },
      getCollisionEnabled: () => collisionEnabled,
      setCollisionEnabled: enabled => {
        if (typeof enabled !== 'boolean') {
          return Object.freeze({ ok: false, enabled: collisionEnabled, reason: 'invalid_enabled' });
        }
        const accepted = emit('component', id, 'body.setCollisionEnabled', [enabled]);
        if (accepted) collisionEnabled = enabled;
        return queuedResult(accepted, { enabled }, { enabled: collisionEnabled });
      },
      getVelocity: () => frozenClone(node.body?.velocity || [0, 0, 0]),
      getAngularVelocity: () => frozenClone(node.body?.angularVelocity || [0, 0, 0]),
      applyForce: force => {
        const safeForce = boundedBodyVector(force);
        return bodyType === 'dynamic' && !!safeForce
          ? !!emit('component', id, 'body.applyForce', [safeForce])
          : false;
      },
      applyLocalForce: force => {
        const safeForce = boundedBodyVector(force);
        return bodyType === 'dynamic' && !!safeForce
          ? !!emit('component', id, 'body.applyLocalForce', [safeForce])
          : false;
      },
      applyTorque: torque => {
        const safeTorque = boundedBodyVector(torque);
        return bodyType === 'dynamic' && !!safeTorque
          ? !!emit('component', id, 'body.applyTorque', [safeTorque])
          : false;
      }
    });
    api.constraints = Object.freeze({
      all: () => frozenClone(node.constraints || []),
      create: options => {
        const accepted = emit('component', id, 'constraints.create', [options]);
        return queuedResult(accepted, { id: null }, { id: null });
      },
      remove: constraintId => !!emit('component', id, 'constraints.remove', [constraintId])
    });
    api.voxels = makeVoxelApi(id, false);
    api.microVoxels = makeVoxelApi(id, true);
    Object.freeze(api);
    selfCache.set(id, api);
    return api;
  }

  function makeWorldApi() {
    const nearby = Array.isArray(frame.world?.entities) ? frame.world.entities : [];
    const positionKey = value => Array.isArray(value) ? value.slice(0, 3).map(v => Math.floor(finite(v))).join(',') : '';
    const microPositionKey = (cell, offset) => positionKey(cell) + '|' + (Array.isArray(offset)
      ? offset.slice(0, 3).map(v => Math.round(finite(v))).join(',')
      : '');
    const hostWorldRead = (kind, position, offset = null) => {
      try {
        const encoded = globalThis.__spaceHostWorldRead(kind, position, offset);
        return typeof encoded === 'string'
          ? frozenClone(JSON.parse(encoded))
          : Object.freeze({ block: 0, color: 0 });
      } catch (_) {
        return Object.freeze({ block: 0, color: 0 });
      }
    };
    const voxels = Object.freeze({
      get(position) {
        const key = positionKey(position);
        return worldVoxelOverlays.has(key)
          ? frozenClone(worldVoxelOverlays.get(key))
          : hostWorldRead('standard', position);
      },
      set(position, options) {
        const accepted = emit('world', null, 'voxels.set', [position, options]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 1, color: finite(options?.color) });
        return queuedEdit('placed', accepted);
      },
      clear(position) {
        const accepted = emit('world', null, 'voxels.clear', [position]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 0, color: 0 });
        return queuedEdit('removed', accepted);
      },
      paint(position, options) {
        const accepted = emit('world', null, 'voxels.paint', [position, options]);
        if (accepted) {
          const current = voxels.get(position);
          if (current?.block) worldVoxelOverlays.set(positionKey(position), { ...current, color: finite(options?.color) });
        }
        return queuedEdit('painted', accepted);
      },
      clearCell(position) {
        const accepted = emit('world', null, 'voxels.clearCell', [position]);
        if (accepted) worldVoxelOverlays.set(positionKey(position), { block: 0, color: 0 });
        return queuedEdit('removed', accepted);
      },
      subdivide(position, offset) {
        const accepted = emit('world', null, 'voxels.subdivide', [position, offset]);
        return queuedResult(accepted, { subdivided: 1, removed: 0 }, { subdivided: 0, removed: 0 });
      }
    });
    const microVoxels = Object.freeze({
      get(cell, offset) {
        const key = microPositionKey(cell, offset);
        return worldMicroVoxelOverlays.has(key)
          ? frozenClone(worldMicroVoxelOverlays.get(key))
          : hostWorldRead('micro', cell, offset);
      },
      set(cell, offset, options) {
        const accepted = emit('world', null, 'microVoxels.set', [cell, offset, options]);
        if (accepted) worldMicroVoxelOverlays.set(
          microPositionKey(cell, offset),
          { block: 1, color: finite(options?.color) }
        );
        return queuedEdit('placed', accepted);
      },
      clear(cell, offset) {
        const accepted = emit('world', null, 'microVoxels.clear', [cell, offset]);
        if (accepted) worldMicroVoxelOverlays.set(microPositionKey(cell, offset), { block: 0, color: 0 });
        return queuedEdit('removed', accepted);
      },
      paint(cell, offset, options) {
        const accepted = emit('world', null, 'microVoxels.paint', [cell, offset, options]);
        if (accepted) {
          const current = microVoxels.get(cell, offset);
          if (current?.block) worldMicroVoxelOverlays.set(
            microPositionKey(cell, offset),
            { ...current, color: finite(options?.color) }
          );
        }
        return queuedEdit('painted', accepted);
      }
    });
    const worldSize = Array.isArray(frame.world?.size) ? frame.world.size : [0, 0];
    const wrappedDelta = (a, b, period) => {
      const direct = Math.abs(finite(a) - finite(b));
      const size = finite(period);
      if (size <= 0) return direct;
      const normalized = direct % size;
      return Math.min(normalized, size - normalized);
    };
    const distanceFrom = (item, origin) => {
      const position = Array.isArray(item?.position) ? item.position : [0, 0, 0];
      const dx = wrappedDelta(position[0], origin[0], worldSize[0]);
      const dy = finite(position[1]) - origin[1];
      const dz = wrappedDelta(position[2], origin[2], worldSize[1]);
      return Math.hypot(dx, dy, dz);
    };
    const entities = (origin, radius = 16) => {
      const queryOrigin = Array.isArray(origin) ? vector(origin) : vector(frame.position);
      const limit = Math.max(0, finite(radius));
      return Object.freeze(nearby
        .map(item => ({ item, distance: distanceFrom(item, queryOrigin) }))
        .filter(entry => entry.distance <= limit)
        .sort((a, b) => a.distance - b.distance)
        .map(entry => frozenClone({ ...entry.item, distance: entry.distance })));
    };
    entities.get = entityId => frozenClone(
      nearby.find(item => item.id === String(entityId) || item.runtimeId === entityId) || null
    );
    entities.list = chunkId => Object.freeze(nearby.filter(item => item.chunkId === String(chunkId)).map(frozenClone));
    entities.inChunk = entities.list;
    Object.freeze(entities);
    return Object.freeze({
      apiVersion: 2,
      voxels,
      microVoxels,
      entities,
      raycast: (origin, direction, maxDistanceOrOptions = 24) => {
        try {
          const encoded = globalThis.__spaceHostRaycast(origin, direction, maxDistanceOrOptions);
          return typeof encoded === 'string' ? frozenClone(JSON.parse(encoded)) : null;
        } catch (_) {
          return null;
        }
      }
    });
  }

  function makeSelectionApi() {
    let current = clone(frame.selection) || { kind: 'none', count: 0 };
    const run = (path, args, next) => {
      const accepted = emit('selection', null, path, args);
      if (accepted && next) current = next;
      return queuedEdit('selected', accepted, Number(current.count) || 0);
    };
    return Object.freeze({
      get: () => frozenClone(current),
      clear: () => {
        const accepted = emit('selection', null, 'clear', []);
        const count = Number(current.count) || 0;
        if (accepted) current = { kind: 'none', count: 0 };
        return queuedEdit('cleared', accepted, count);
      },
      cornerA: (...args) => run('cornerA', args),
      cornerB: (...args) => run('cornerB', args),
      box: (...args) => run('box', args),
      cells: cells => run('cells', [cells], { kind: 'world-cells', count: Array.isArray(cells) ? cells.length : 0 }),
      toggle: (...args) => run('toggle', args),
      entity: (entityId, nodeId = null) => run('entity', [entityId, nodeId], { kind: 'entity-subtree', entityId, nodeId, count: 1 }),
      entityBox: (...args) => run('entityBox', args),
      delete: () => {
        const accepted = emit('selection', null, 'delete', []);
        const removed = Number(current.count) || 0;
        return queuedResult(
          accepted,
          { removed, standard: 0, micro: 0, entities: 0, components: 0, entityId: null, nodeId: null },
          { removed: 0, standard: 0, micro: 0, entities: 0, components: 0, entityId: null, nodeId: null }
        );
      },
      assemble: (...args) => {
        const accepted = emit('selection', null, 'assemble', args);
        return queuedResult(
          accepted,
          { assembled: 1, entityId: null, runtimeId: null },
          { assembled: 0, entityId: null, runtimeId: null }
        );
      },
      createChild: (...args) => {
        const accepted = emit('selection', null, 'createChild', args);
        return queuedResult(accepted, { childId: null }, { childId: null });
      }
    });
  }

  function makeCommandResultsApi() {
    const results = Array.isArray(frame.commandResults) ? frame.commandResults : [];
    return Object.freeze({
      get: commandId => frozenClone(
        results.find(result => result?.commandId === String(commandId)) || null
      ),
      all: () => frozenClone(results)
    });
  }

  globalThis.__spaceSetScript = (nodeIdJson, codeJson) => {
    const nodeId = JSON.parse(nodeIdJson);
    const code = JSON.parse(codeJson);
    scripts.delete(nodeId);
    if (!code || !String(code).trim()) return JSON.stringify({ ok: true, nodeId });
    try {
      const compiled = new Function('self', 'ctx', '"use strict";\n' + code + '\n//# sourceURL=entity-' + nodeId + '.js');
      scripts.set(nodeId, compiled);
      return JSON.stringify({ ok: true, nodeId });
    } catch (error) {
      return JSON.stringify({ ok: false, nodeId, error: String(error?.message || error) });
    }
  };

  globalThis.__spaceBeginTick = snapshotJson => {
    frame = JSON.parse(snapshotJson);
    states = clone(frame.states) || Object.create(null);
    componentMap = new Map((frame.components || []).map(node => [String(node.id), node]));
    rootComponentId = String(
      frame.rootComponentId
      || (frame.components || []).find(node => node.parentId === null)?.id
      || ''
    );
    selfCache = new Map();
    commands = [];
    errors = [];
    stopped = false;
    worldVoxelOverlays = new Map();
    worldMicroVoxelOverlays = new Map();
    return true;
  };

  globalThis.__spaceRunNode = nodeIdJson => {
    const nodeId = JSON.parse(nodeIdJson);
    const compiled = scripts.get(nodeId);
    if (!compiled || frame.enabled?.[nodeId] === false || stopped) return JSON.stringify({ ok: true, skipped: true });
    const self = getSelf(nodeId);
    if (!self) return JSON.stringify({ ok: true, skipped: true });
    const input = frame.input || { down: [], pressed: [], released: [] };
    const blocks = frame.blocks || {};
    const ctx = Object.freeze({
      apiVersion: 2,
      entityId: String(frame.entityId || ''),
      time: finite(frame.time),
      deltaTime: finite(frame.deltaTime),
      tick: finite(frame.tick),
      position: frozenClone(frame.position || [0, 0, 0]),
      velocity: frozenClone(frame.velocity || [0, 0, 0]),
      rotation: frozenClone(frame.rotation || [0, 0, 0]),
      angularVelocity: frozenClone(frame.angularVelocity || [0, 0, 0]),
      groundDistance: finite(frame.groundDistance),
      isOnGround: frame.isOnGround === true,
      mass: finite(frame.mass),
      bodyType: frame.bodyType || 'dynamic',
      gravity: frozenClone(frame.gravity || [0, -18, 0]),
      limits: frozenClone(frame.limits || { maxForce: 0, maxTorque: 0 }),
      root: getSelf(rootComponentId),
      blocks: Object.freeze({
        pressed: type => !!blocks.changed && (type === undefined || type === null || blocks.event?.type === type),
        event: () => frozenClone(blocks.event || null)
      }),
      input: Object.freeze({
        down: code => codeActive(input.down || [], code),
        pressed: code => codeActive(input.pressed || [], code),
        released: code => codeActive(input.released || [], code)
      }),
      players: frozenClone(frame.players || []),
      driver: frozenClone(frame.driver || null),
      contacts: frozenClone(frame.contacts || []),
      world: makeWorldApi(),
      selection: makeSelectionApi(),
      commands: makeCommandResultsApi(),
      log: message => { emit('log', nodeId, 'log', [String(message).slice(0, 1000)]); }
    });
    try {
      compiled(self, ctx);
      return JSON.stringify({ ok: true });
    } catch (error) {
      if (error === STOP) return JSON.stringify({ ok: true, stopped: true });
      const message = String(error?.message || error).slice(0, 2000);
      errors.push({ nodeId, error: message });
      return JSON.stringify({ ok: false, error: message });
    }
  };

  globalThis.__spaceShouldStop = () => stopped;
  globalThis.__spaceFinishTick = () => JSON.stringify({
    ok: true,
    commands,
    errors,
    states: clone(states) || {},
    frozenStatePaths: collectFrozenPaths(states),
    stopped
  });
  globalThis.__spaceReset = statesJson => {
    states = JSON.parse(statesJson || '{}');
    return true;
  };
})();
`;

type EntityRuntime = {
  runtime: any;
  context: any;
  scripts: Map<string, string>;
  stateCheckpoint: Record<string, any>;
  deadline: number;
  interruptBudgetMs: number;
  interruptReason: 'time' | 'count' | null;
  frameBudgetActive: boolean;
  frameInterruptChecks: number;
  hostApi: any;
  hostRaycastCount: number;
  hostWorldReadCount: number;
};

type WorkerPort = {
  postMessage: (message: any) => void;
  onMessage: (listener: (message: any) => void) => void;
};

function jsonExpression(name: string, ...values: any[]) {
  return `${name}(${values.map(value => JSON.stringify(JSON.stringify(value))).join(',')})`;
}

function writeSynchronizedResponse(buffer: SharedArrayBuffer, response: any) {
  const header = new Int32Array(buffer, 0, 2);
  const target = new Uint8Array(buffer, 8);
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  if (encoded.byteLength > target.byteLength) {
    const fallback = new TextEncoder().encode(JSON.stringify({
      requestId: response.requestId,
      ok: false,
      fatal: true,
      error: 'Entity script response exceeded the synchronized response limit'
    }));
    target.set(fallback);
    Atomics.store(header, 1, fallback.byteLength);
  } else {
    target.set(encoded);
    Atomics.store(header, 1, encoded.byteLength);
  }
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

export function createQuickJSScriptRuntimeService() {
  const QuickJS = quickJSModule;
  if (!QuickJS) {
    throw new Error('QuickJS runtime is not initialized; call preloadQuickJSScriptRuntime() first');
  }
  const runtimes = new Map<string, EntityRuntime>();

  const evaluate = (entity: EntityRuntime, expression: string, deadlineMs = BOOTSTRAP_DEADLINE_MS) => {
    // Start charging wall time at QuickJS's first interrupt check. VM checkpoint
    // counting remains active for the whole entity tick and is not reset here.
    entity.interruptBudgetMs = deadlineMs;
    entity.deadline = 0;
    entity.interruptReason = null;
    let result;
    try {
      result = entity.context.evalCode(expression);
    } finally {
      entity.deadline = Number.POSITIVE_INFINITY;
    }
    if (result.error) {
      const error = entity.context.dump(result.error);
      result.error.dispose();
      return { ok: false, error: error?.message || String(error) };
    }
    const value = entity.context.dump(result.value);
    result.value.dispose();
    return { ok: true, value };
  };

  const createEntity = (entityRuntimeId: string) => {
    const runtime = QuickJS.newRuntime();
    const entity: EntityRuntime = {
      runtime,
      context: null,
      scripts: new Map(),
      stateCheckpoint: {},
      deadline: Number.POSITIVE_INFINITY,
      interruptBudgetMs: BOOTSTRAP_DEADLINE_MS,
      interruptReason: null,
      frameBudgetActive: false,
      frameInterruptChecks: 0,
      hostApi: null,
      hostRaycastCount: 0,
      hostWorldReadCount: 0
    };
    runtime.setMemoryLimit(ENTITY_MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(ENTITY_STACK_LIMIT_BYTES);
    runtime.setInterruptHandler(() => {
      if (entity.frameBudgetActive) {
        entity.frameInterruptChecks++;
        if (entity.frameInterruptChecks > ENTITY_FRAME_INTERRUPT_LIMIT) {
          entity.interruptReason = 'count';
          return true;
        }
      }
      if (entity.deadline === Number.POSITIVE_INFINITY) return false;
      if (entity.deadline === 0) {
        entity.deadline = performance.now() + entity.interruptBudgetMs;
        return false;
      }
      if (performance.now() <= entity.deadline) return false;
      entity.interruptReason = 'time';
      return true;
    });
    entity.context = runtime.newContext();
    const hostRaycast = entity.context.newFunction('__spaceHostRaycast', (...args: any[]) => {
      let encoded = 'null';
      try {
        if (entity.hostRaycastCount >= MAX_HOST_RAYCASTS_PER_TICK) {
          return entity.context.newString(encoded);
        }
        entity.hostRaycastCount++;
        const origin = entity.context.dump(args[0]);
        const direction = entity.context.dump(args[1]);
        const maxDistance = entity.context.dump(args[2]);
        const result = entity.hostApi?.worldRaycast?.(origin, direction, maxDistance);
        const json = JSON.stringify(result ?? null);
        if (typeof json === 'string' && json.length <= 64 * 1024) encoded = json;
      } catch (_) {}
      return entity.context.newString(encoded);
    });
    entity.context.setProp(entity.context.global, '__spaceHostRaycast', hostRaycast);
    hostRaycast.dispose();
    const hostWorldRead = entity.context.newFunction('__spaceHostWorldRead', (...args: any[]) => {
      let encoded = JSON.stringify({ block: 0, color: 0 });
      try {
        if (entity.hostWorldReadCount >= MAX_HOST_WORLD_READS_PER_TICK) {
          return entity.context.newString(encoded);
        }
        entity.hostWorldReadCount++;
        const kind = entity.context.dump(args[0]);
        const position = entity.context.dump(args[1]);
        const offset = entity.context.dump(args[2]);
        const result = kind === 'micro'
          ? entity.hostApi?.worldMicroVoxelGet?.(position, offset)
          : entity.hostApi?.worldVoxelGet?.(position);
        const json = JSON.stringify(result ?? { block: 0, color: 0 });
        if (typeof json === 'string' && json.length <= 4 * 1024) encoded = json;
      } catch (_) {}
      return entity.context.newString(encoded);
    });
    entity.context.setProp(entity.context.global, '__spaceHostWorldRead', hostWorldRead);
    hostWorldRead.dispose();
    const boot = evaluate(entity, QUICKJS_BOOTSTRAP, BOOTSTRAP_DEADLINE_MS);
    if (!boot.ok) {
      entity.context.dispose();
      runtime.dispose();
      throw new Error(`QuickJS bootstrap failed: ${boot.error}`);
    }
    runtimes.set(entityRuntimeId, entity);
    return entity;
  };

  const getEntity = (entityRuntimeId: string) => (
    runtimes.get(entityRuntimeId) || createEntity(entityRuntimeId)
  );

  const disposeEntity = (entityRuntimeId: string) => {
    const entity = runtimes.get(entityRuntimeId);
    if (!entity) return;
    runtimes.delete(entityRuntimeId);
    entity.context.dispose();
    entity.runtime.dispose();
  };

  const handle = (message: any) => {
    const { type, entityRuntimeId, requestId } = message;
    try {
      if (type === 'dispose') {
        disposeEntity(entityRuntimeId);
        return { requestId, ok: true };
      }

      const entity = getEntity(entityRuntimeId);
      if (type === 'set-script') {
        const nodeId = String(message.nodeId || '');
        const code = String(message.code || '');
        entity.scripts.set(nodeId, code);
        const result = evaluate(entity, jsonExpression('__spaceSetScript', nodeId, code));
        if (!result.ok) return { requestId, ok: false, nodeId, error: result.error };
        const parsed = JSON.parse(result.value);
        return { requestId, ...parsed };
      }

      if (type === 'reset') {
        entity.stateCheckpoint = message.states || {};
        const result = evaluate(entity, jsonExpression('__spaceReset', entity.stateCheckpoint));
        return { requestId, ok: result.ok, error: result.ok ? undefined : result.error };
      }

      if (type === 'tick') {
        const started = performance.now();
        const snapshot = message.snapshot || {};
        entity.frameBudgetActive = true;
        entity.frameInterruptChecks = 0;
        entity.hostRaycastCount = 0;
        entity.hostWorldReadCount = 0;
        entity.hostApi = message.hostApi || null;
        try {
          const begin = evaluate(entity, jsonExpression('__spaceBeginTick', snapshot));
          if (!begin.ok) return { requestId, ok: false, fatal: true, error: begin.error };
          const scriptsStarted = performance.now();

          const errors: any[] = [];
          const executionTimes: Record<string, number> = {};
          const order = (Array.isArray(snapshot.scriptOrder) ? snapshot.scriptOrder : [...entity.scripts.keys()])
            .slice(0, MAX_SCRIPT_COMPONENTS);
          for (const nodeId of order) {
            if (snapshot.enabled?.[nodeId] === false || !entity.scripts.get(nodeId)?.trim()) continue;
            const componentStarted = performance.now();
            const run = evaluate(entity, jsonExpression('__spaceRunNode', nodeId), COMPONENT_DEADLINE_MS);
            executionTimes[nodeId] = performance.now() - componentStarted;
            if (!run.ok) {
              const budgetError = entity.interruptReason === 'count'
                ? `Entity exceeded ${ENTITY_FRAME_INTERRUPT_LIMIT} VM checkpoints in one frame and was stopped`
                : run.error === 'interrupted' || entity.interruptReason === 'time'
                  ? `Script exceeded ${COMPONENT_DEADLINE_MS} ms and the entity was stopped`
                  : null;
              if (budgetError) {
                return {
                  requestId,
                  ok: false,
                  fatal: true,
                  errors,
                  executionTimes,
                  error: budgetError
                };
              }
              errors.push({ nodeId, error: run.error });
            }
            const shouldStop = evaluate(entity, '__spaceShouldStop()', COMPONENT_DEADLINE_MS);
            if (!shouldStop.ok && entity.interruptReason) {
              return {
                requestId,
                ok: false,
                fatal: true,
                errors,
                executionTimes,
                error: entity.interruptReason === 'count'
                  ? `Entity exceeded ${ENTITY_FRAME_INTERRUPT_LIMIT} VM checkpoints in one frame and was stopped`
                  : `Script exceeded ${COMPONENT_DEADLINE_MS} ms and the entity was stopped`
              };
            }
            if (shouldStop.ok && shouldStop.value === true) break;
            if (performance.now() - scriptsStarted > ENTITY_TICK_DEADLINE_MS) {
              return {
                requestId,
                ok: false,
                fatal: true,
                errors,
                executionTimes,
                error: `Entity scripts exceeded the aggregate ${ENTITY_TICK_DEADLINE_MS} ms tick limit and were stopped`
              };
            }
          }

          const finish = evaluate(entity, '__spaceFinishTick()', BOOTSTRAP_DEADLINE_MS);
          if (!finish.ok) {
            const error = entity.interruptReason === 'count'
              ? `Entity exceeded ${ENTITY_FRAME_INTERRUPT_LIMIT} VM checkpoints in one frame and was stopped`
              : finish.error;
            return { requestId, ok: false, fatal: true, errors, executionTimes, error };
          }
          const output = JSON.parse(finish.value);
          entity.stateCheckpoint = output.states || {};
          return {
            requestId,
            ...output,
            errors: [...(output.errors || []), ...errors],
            executionTimes,
            interruptChecks: entity.frameInterruptChecks,
            elapsedMs: performance.now() - started
          };
        } finally {
          entity.frameBudgetActive = false;
          entity.hostApi = null;
          entity.deadline = Number.POSITIVE_INFINITY;
        }
      }

      return { requestId, ok: false, error: `Unknown worker message: ${type}` };
    } catch (error: any) {
      return { requestId, ok: false, fatal: true, error: error?.message || String(error) };
    }
  };

  return Object.freeze({ handle });
}

/** Legacy worker adapter retained for old hosts. The desktop/browser app now
 * uses createQuickJSScriptRuntimeService() directly on the page thread. */
export async function startQuickJSScriptWorker(port: WorkerPort) {
  await preloadQuickJSScriptRuntime();
  const service = createQuickJSScriptRuntimeService();
  let queue = Promise.resolve();
  const respond = (message: any, response: any) => {
    if (typeof SharedArrayBuffer !== 'undefined' && message.syncResponse instanceof SharedArrayBuffer) {
      writeSynchronizedResponse(message.syncResponse, response);
    } else {
      port.postMessage(response);
    }
  };

  port.onMessage(message => {
    queue = queue.then(() => respond(message, service.handle(message))).catch(error => {
      respond(message, {
        requestId: message.requestId,
        ok: false,
        fatal: true,
        error: error?.message || String(error)
      });
    });
  });
}

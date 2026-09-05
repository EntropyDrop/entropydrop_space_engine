/**
 * Canonical Space Script API V2 contract.
 *
 * API facts belong here exactly once. The in-game HTML reference, generated
 * Markdown, Agent API reference, and runtime-surface tests all consume this
 * structure. Agent behavior/output policy deliberately remains in AgentChat.
 */

export type ApiPromptVisibility = 'full' | 'omit';

export interface ApiEntry {
  signature: string;
  type?: string;
  description: string;
  prompt?: ApiPromptVisibility;
}

export interface ApiSection {
  id: string;
  title: string;
  intro?: string;
  facts?: string[];
  entries?: ApiEntry[];
  notes?: string[];
  examples?: Array<{ title?: string; code: string }>;
  subsections?: ApiSection[];
  prompt?: ApiPromptVisibility;
}

export interface ScriptApiContract {
  version: number;
  title: string;
  summary: string;
  sections: ApiSection[];
  runtimeSurfaces: Record<string, string[]>;
}

const ctxEntries: ApiEntry[] = [
  { signature: 'ctx.apiVersion', type: 'number', description: 'Current script API version: `2`.' },
  { signature: 'ctx.entityId', type: 'string', description: 'Stable random ID of the current entity.' },
  { signature: 'ctx.root', type: 'ComponentAPI', description: 'Root component and entry point for recursive tree traversal.' },
  { signature: 'ctx.time', type: 'number', description: 'Seconds with at least one component script enabled; Pause freezes it and Stop resets it.' },
  { signature: 'ctx.deltaTime', type: 'number', description: 'Fixed entity simulation step: always `0.05` seconds (20 Hz); scripts cannot change it.' },
  { signature: 'ctx.tick', type: 'number', description: 'Executed script-frame count; Pause freezes it and Stop resets it.' },
  { signature: 'ctx.position', type: '[x,y,z]', description: 'Root entity world position. It is continuous and does not wrap at the torus seam.' },
  { signature: 'ctx.velocity', type: '[x,y,z]', description: 'Root world-space velocity in m/s.' },
  { signature: 'ctx.rotation', type: '[x,y,z]', description: 'Root Euler angles in radians using YXZ order.' },
  { signature: 'ctx.angularVelocity', type: '[x,y,z]', description: 'Root angular velocity in rad/s.' },
  { signature: 'ctx.groundDistance', type: 'number', description: 'Distance in metres to the ground below.' },
  { signature: 'ctx.isOnGround', type: 'boolean', description: 'Whether the root dynamic body was supported during the latest completed physics frame.' },
  { signature: 'ctx.mass', type: 'number', description: 'Root entity mass in kg.' },
  { signature: 'ctx.bodyType', type: 'string', description: "Root body type: `'kinematic'` or `'dynamic'`." },
  { signature: 'ctx.gravity', type: '[x,y,z]', description: 'Current gravity vector; default `[0,-18,0]`.' },
  { signature: 'ctx.limits', type: 'object', description: '`{maxForce,maxTorque}` for the legacy root-body force surface only.' },
  { signature: 'ctx.input', type: 'object', description: 'Keyboard edge/held-state API described below.' },
  { signature: 'ctx.blocks', type: 'object', description: "Block-edit snapshot: `pressed(type?)` and `event()`; types are `'place'|'remove'|'color'|'subdivide'`." },
  { signature: 'ctx.players', type: 'array', description: 'Frozen player observations. `position` remains the eye-position compatibility alias; records also expose `eyePosition`, nullable `feetPosition`/`velocity`/pose and movement flags, riding IDs, `isLocal`, and fixed 50 kg mass.' },
  { signature: 'ctx.driver', type: 'object|null', description: 'Current local driver for this entity as `{playerId,componentId,seatIndex}`, or `null` when it is not mounted.' },
  { signature: 'ctx.contacts', type: 'array', description: 'Up to 32 frozen contacts observed since the previous submitted script frame. Kinds are `terrain|entity|player`; records include component IDs, point, normal, relative velocity, penetration, and impulse when available.' },
  { signature: 'ctx.world', type: 'object', description: 'World query and mutation API described below.' },
  { signature: 'ctx.selection', type: 'object', description: 'Shared engine selection command API described below.' },
  { signature: 'ctx.commands', type: 'object', description: 'Final main-thread command results from the previous submitted frame: `get(commandId)` and `all()`.' },
  { signature: 'ctx.log(msg)', type: 'function', description: 'Append one line to the component console.' }
];

const selfUniversalEntries: ApiEntry[] = [
  { signature: 'self.apiVersion', description: 'Current component API version: `2`.' },
  { signature: 'self.id / self.parentId', description: 'Component ID and direct parent ID; the root has an ordinary ID and `parentId:null`.' },
  { signature: 'self.state', description: 'Mutable persistent state scoped to this component and retained across completed ticks and streaming.' },
  { signature: 'self.child(id)', description: 'Look up a direct child by its ordinary ID; returns `null` when missing.' },
  { signature: 'self.children()', description: 'Return a frozen array of direct children. Recurse from `ctx.root` to traverse the tree.' },
  { signature: 'self.applyThrust([x,y,z])', description: 'Apply root-local force at this component. A child mounting offset produces torque; dynamic root only and subject to `ctx.limits`.' },
  { signature: 'self.applyLocalThrust([x,y,z])', description: 'Apply component-local force at this component. Installed anchor orientation controls its direction and an offset produces torque.' },
  { signature: 'self.applyForce([x,y,z])', description: 'Apply world-space force to the root center of mass; no effect on a kinematic root.' },
  { signature: 'self.applyLocalForce([x,y,z])', description: "Apply root/body-local force. A child's direction is interpreted in that component's local frame." },
  { signature: 'self.applyForceAt(force, localPoint)', description: 'Apply world-space force at a component-local offset, producing translation and torque.' },
  { signature: 'self.applyTorque([x,y,z])', description: 'Apply world-space torque to the root body.' },
  { signature: 'self.getWorldPosition()', description: 'Return this component world position as `[x,y,z]`.' },
  { signature: 'self.getWorldRotation()', description: 'Return this component world quaternion `[x,y,z,w]`, including ancestor rotations.' },
  { signature: 'self.localToWorldDirection(dir)', description: 'Convert a component-local direction to world space.' },
  { signature: 'self.getPivot()', description: 'Return the rotation pivot in entity-local coordinates.' },
  { signature: 'self.getBounds()', description: 'Return entity-local block bounds `{min,max,size,center}`, or `null` when empty.' },
  { signature: 'self.setSeats(points)', description: "Replace this component's pivot-relative driver seats. An entity is mountable when any component has a seat." },
  { signature: 'self.getSeats()', description: "Return this component's pivot-relative seat positions." },
  { signature: 'self.voxels.set(position, options?)', description: 'Queue one pivot-relative standard voxel placement; returns `{ok,placed,reason}`.' },
  { signature: 'self.voxels.clear(position)', description: 'Queue removal of one standard voxel; returns `{ok,removed,reason}`.' },
  { signature: 'self.voxels.paint(position, options?)', description: 'Queue repainting one standard voxel; returns `{ok,painted,reason}`.' },
  { signature: 'self.voxels.clearCell(position)', description: 'Queue removal of all standard and micro voxels in one 1 m component cell.' },
  { signature: 'self.voxels.subdivide(position, clearOffset?)', description: 'Queue conversion to 125 micro voxels, optionally removing one offset atomically.' },
  { signature: 'self.microVoxels.set(cell, offset, options?)', description: 'Queue a 0.2 m voxel; each offset coordinate is an integer from 0 through 4.' },
  { signature: 'self.microVoxels.clear(cell, offset)', description: 'Queue removal of one exact 0.2 m component voxel.' },
  { signature: 'self.microVoxels.paint(cell, offset, options?)', description: 'Queue repainting one exact 0.2 m component voxel.' }
];

const kinematicEntries: ApiEntry[] = [
  { signature: 'self.setLocalPosition([x,y,z])', description: 'Set a kinematic child relative to its parent, or a kinematic root in world space.' },
  { signature: 'self.setLocalEuler([x,y,z])', description: 'Set kinematic orientation in radians using YXZ Euler order.' },
  { signature: 'self.setLocalRotation([x,y,z,w])', description: 'Set kinematic orientation as a quaternion.' },
  { signature: 'self.setLocalSpin([ax,ay,az], rpm)', description: 'Command continuous local-axis spin; call each entity tick to sustain it.' },
  { signature: 'self.getLocalPosition()', description: 'Return current local position as `[x,y,z]`; root returns `[0,0,0]`.' },
  { signature: 'self.getLocalRotation()', description: 'Return current local quaternion `[x,y,z,w]`.' },
  { signature: 'self.setPivot([x,y,z])', description: 'Set a kinematic pivot in entity-local coordinates while preserving block world positions. Dynamic bodies use their physical center of mass.' }
];

const bodyEntries: ApiEntry[] = [
  { signature: 'self.body.getType() / self.body.setType(type)', description: "Read or set `'kinematic'|'dynamic'`; setter returns `{ok,type,reason}`. Entity bodies have no static type." },
  { signature: 'self.body.getMass() / self.body.setMass(kg)', description: 'Read or set runtime mass; setter returns `{ok,mass,reason}`. Automatic mass is owned block count × 10 kg; minimum is 0.1 kg and invalid input returns `invalid_mass`.' },
  { signature: 'self.body.getMaterial() / self.body.setMaterial(options)', description: 'Read or set `{restitution,friction}`; setter returns `{ok,material,reason}`. Both coefficients clamp to `[0,1]` and default to 0.1/0.7.' },
  { signature: 'self.body.getGravityEnabled() / self.body.setGravityEnabled(bool)', description: 'Read or set runtime gravity; setter returns `{ok,enabled,reason}`. Kinematic bodies retain the flag but are not gravity-driven.' },
  { signature: 'self.body.getCollisionEnabled() / self.body.setCollisionEnabled(bool)', description: 'Read or set collision participation for terrain, player, entity, and raycast shapes; setter returns `{ok,enabled,reason}`.' },
  { signature: 'self.body.getVelocity() / self.body.getAngularVelocity()', description: "Read this component body's world-space velocities." },
  { signature: 'self.body.applyForce(force)', description: 'Apply world force to this dynamic component body; returns boolean.' },
  { signature: 'self.body.applyLocalForce(force)', description: 'Apply body-local force to this dynamic component body; returns boolean.' },
  { signature: 'self.body.applyTorque(torque)', description: 'Apply world torque to this dynamic component body; returns boolean.' },
  { signature: 'self.constraints.all()', description: 'Return a frozen snapshot of constraints connected to this component.' },
  { signature: 'self.constraints.create({id?,type,bodyA?,anchorA?,anchorB?,axisA?,axisB?,limits?,stiffness?,collideConnected?})', description: "Queue a `point`, `hinge`, or `weld`; `bodyA:null` denotes the external world and an omitted `bodyA` uses the structural parent (or external world for the root). Immediate Worker success is provisional `{ok:true,id:null,reason:'queued'}`. Supply an explicit ID for later lookup. Stiffness defaults to 0.9, `collideConnected` to false, omitted anchors use pivots, and hinge limits are radians." },
  { signature: 'self.constraints.remove(id)', description: 'Queue removal of one constraint; returns boolean.' },
  { signature: 'self.stop()', description: 'Root-only global Stop: disable entity physics and scripts, clear state/time/tick/motion, reset child poses, and restore persisted BodyConfig defaults. Collision and selection shapes remain active. Child code must call `ctx.root.stop()`.' }
];

const worldEntries: ApiEntry[] = [
  { signature: 'ctx.world.apiVersion', description: 'Current world API version: `2`.' },
  { signature: 'ctx.world.voxels.get(position)', description: "Read a real standard world voxel as `{block,color}` plus the current tick's admitted-write overlay; maximum 256 combined standard/micro host reads per entity tick." },
  { signature: 'ctx.world.voxels.set(position, options?)', description: "Queue a standard placement; admitted result is provisional `{ok:true,placed:1,reason:'queued'}`." },
  { signature: 'ctx.world.voxels.clear(position)', description: 'Queue removal of one standard voxel without deleting micro voxels in its cell.' },
  { signature: 'ctx.world.voxels.paint(position, options?)', description: 'Queue repainting one existing standard voxel.' },
  { signature: 'ctx.world.voxels.clearCell(position)', description: 'Queue removal of all standard and micro voxels in one world cell.' },
  { signature: 'ctx.world.voxels.subdivide(position, clearOffset?)', description: 'Queue conversion of one standard voxel to 125 micro voxels.' },
  { signature: 'ctx.world.microVoxels.get(cell, offset)', description: 'Read one real 0.2 m world voxel as `{block,color}` plus the current tick overlay; offset coordinates are integers from 0 through 4.' },
  { signature: 'ctx.world.microVoxels.set(cell, offset, options?)', description: 'Queue one 0.2 m world voxel placement.' },
  { signature: 'ctx.world.microVoxels.clear(cell, offset)', description: 'Queue removal of one exact 0.2 m world voxel.' },
  { signature: 'ctx.world.microVoxels.paint(cell, offset, options?)', description: 'Queue repainting one existing micro world voxel.' },
  { signature: 'ctx.world.entities(origin, radius=16)', description: "Filter the prefetched 64 m nearby-entity snapshot using shortest wrapped X/Z distance. Descriptors include pose, velocities, mass, bounds, collision/ground state, physics enabled state, script status, and component count." },
  { signature: 'ctx.world.entities.get(id, chunkId?)', description: 'Look up an entity in the frozen nearby snapshot.' },
  { signature: 'ctx.world.entities.list(chunkId) / inChunk(chunkId)', description: 'Filter nearby entities by wrapped chunk ID `"cx,cz"`.' },
  { signature: 'ctx.world.raycast(origin, direction, maxDistance=24)', description: 'Compatibility form: bounded synchronous standard-world-voxel raycast.' },
  { signature: "ctx.world.raycast(origin, direction, {maxDistance=24,include='world',voxelKinds=['standard'],space='world'})", description: 'Full existing engine raycast over standard/micro world voxels and/or entities. Returns normalized kind, voxelKind, IDs, block/color, normal, position, and distance; maximum 64 calls per entity tick.' }
];

const selectionEntries: ApiEntry[] = [
  { signature: 'ctx.selection.get()', description: 'Read the current frozen shared selection snapshot.' },
  { signature: 'ctx.selection.clear()', description: 'Queue clearing the shared selection; returns `{ok,cleared,reason}`.' },
  { signature: 'ctx.selection.cornerA(point) / cornerB(point)', description: 'Set progressive world-box corners; accepts `{micro:true}` and returns `{ok,selected,reason}`.' },
  { signature: 'ctx.selection.box(a, b)', description: 'Set an atomic world box; accepts `{micro:true}`.' },
  { signature: 'ctx.selection.cells(list) / toggle(cell)', description: 'Replace or toggle sparse cells; micro mode uses 0.2 m cells.' },
  { signature: 'ctx.selection.entity(entityId, nodeId?)', description: 'Select a component subtree. Internal component selection requires a stopped entity.' },
  { signature: 'ctx.selection.entityBox(entityId, nodeId, a, b, space?)', description: 'Select directly owned voxels intersecting a node-local or world-space box; requires stopped.' },
  { signature: 'ctx.selection.delete()', description: 'Delete the shared selection; internal entity edits require stopped. Returns removal counts and IDs.' },
  { signature: "ctx.selection.assemble(mode='programmable', options={})", description: "Assemble world voxels in `auto|free_physics|projectile|programmable` mode; options are `{bodyType,restitution,friction,useGravity,mass}` and result is `{ok,assembled,entityId,runtimeId,reason}`. Invalid mode fails before changing selection or world." },
  { signature: 'ctx.selection.createChild(id?)', description: 'Create a child from selected entity blocks; requires stopped and returns `{ok,childId,reason}`.' }
];

export const SPACE_SCRIPT_API_V2: ScriptApiContract = {
  version: 2,
  title: 'Space Script API V2',
  summary: 'Canonical contract for component scripts running with `(self, ctx)` in the Space voxel-physics world.',
  sections: [
    {
      id: 'defaults',
      title: 'Defaults and coordinate conventions',
      facts: [
        'Coordinates are right-handed and Y-up: +X right, +Y up, -Z forward. Euler angles use YXZ order; quaternions are `[x,y,z,w]`.',
        "A component pivot starts at its own block AABB centroid and never moves automatically after block edits. Use `getBounds()` then `setPivot(bounds.center)` to recenter a kinematic body without moving its blocks.",
        "Component IDs are unique across the entire entity; no string is reserved. The root is identified structurally by `parentId:null`, and a child's local position is its pivot offset in the parent pivot frame.",
        'All scripts start enabled. Pause preserves active physics, state, and runtime BodyConfig values; Stop disables entity physics, clears state/time/tick/motion, resets child transforms, and restores persisted BodyConfig defaults. Play re-enables physics from the stopped construction pose.',
        'BodyConfig defaults are type, mass, restitution, friction, gravity, and collision. Script setters are runtime-only; serialization always writes defaults.',
        'Collision defaults to enabled. A disabled component remains rendered/editable but has no terrain, player, entity, or raycast shapes.'
      ]
    },
    {
      id: 'topology',
      title: 'World topology',
      facts: [
        'The world is a torus: X is `[0,16384)` and Z is `[0,2048)` for world voxel operations and raycasts. Y does not wrap; voxel edits require Y in `[0,256)`.',
        '`ctx.position` is continuous and does not wrap. Follow/orbit/seek logic must use shortest wrapped X/Z deltas.',
        'An entity whose root falls below `y = -30` is removed with its scripts and state.'
      ],
      examples: [{
        title: 'Shortest wrapped delta',
        code: `function wrappedDelta(from, to, size) {
  return ((to - from) % size + size + size / 2) % size - size / 2;
}
const dx = wrappedDelta(ctx.position[0], target[0], 16384);
const dz = wrappedDelta(ctx.position[2], target[2], 2048);`
      }]
    },
    {
      id: 'execution',
      title: 'Execution model',
      facts: [
        'Every component script receives `(self, ctx)` once per fixed 20 Hz entity tick. `self` is the target component; root body fields in `ctx` always describe the root entity.',
        'The root script runs before child scripts. All components share one frozen frame-start `ctx` snapshot; admitted commands commit after the synchronous QuickJS tick.',
        'Each component owns `self.state`. Completed state survives chunk streaming; Pause freezes it and Stop clears it.',
        "Queued mutation success means command-buffer admission (`reason:'queued'`), not final commit. Successful admission includes `commandId`; the main thread revalidates bounds, occupancy, and permissions and publishes the final result through `ctx.commands` on the next submitted frame.",
        'Limits: 4 MiB runtime memory, 512 KiB stack, 64 components per entity, 256 commands, 256 world voxel reads, and 64 raycasts per tick, 5 ms per component invocation, 25 ms aggregate entity time, and 64 VM interrupt checkpoints.',
        'A component exception disables that component. Aggregate time/checkpoint failure disables every component script and discards commands from the interrupted tick.',
        'Entities only exist and run while their wrapped root chunk is active; streaming serializes identity, hierarchy, physics, scripts, defaults, and completed state.'
      ]
    },
    { id: 'ctx', title: 'ctx — read-only frame snapshot', entries: ctxEntries },
    {
      id: 'self',
      title: 'Component API (self)',
      intro: 'Every root and child receives the same top-level API. Namespaces target the current component unless explicitly described as legacy root-body methods.',
      subsections: [
        {
          id: 'self-universal',
          title: 'Universal component surface',
          entries: selfUniversalEntries,
          notes: [
            'Component voxel cells are measured from the current pivot, not the entity corner. Fractional cell coordinates floor after applying the pivot.',
            'All voxel changes are queued and action-specific. Check `result.ok` and `result.reason`; entity bounds are capped at 64×64×64.',
            "Removing an entity's final voxel deletes the entity, scripts, and state."
          ]
        },
        { id: 'self-kinematics', title: 'Kinematics', intro: 'Only kinematic bodies accept direct pose commands; dynamic bodies are solver-driven.', entries: kinematicEntries },
        {
          id: 'self-body',
          title: 'Rigid body, constraints, and Stop',
          entries: bodyEntries,
          notes: [
            '`self.body` setters alter runtime values only. Pause preserves them and keeps physics active; global Stop disables dynamics while retaining static collision/query shapes and restores persisted defaults.',
            '`self.body.apply*` targets the current component body and bypasses the legacy `ctx.limits`/HUD budget, but rejects non-finite values and components above `1e12`.',
            'Constraint creation is queued. Supply an explicit ID when later script logic requires a stable name; hinge limits are radians.'
          ]
        }
      ]
    },
    {
      id: 'world',
      title: 'ctx.world',
      entries: worldEntries,
      notes: ['World writes never overwrite occupied cells or implicitly convert between standard and micro voxels. X/Z wrap automatically.']
    },
    {
      id: 'selection',
      title: 'ctx.selection',
      entries: selectionEntries,
      notes: [
        'Selections are capped at a 64×64×64 AABB. Boxes can clamp; sparse operations that exceed the cap fail with `bounds_exceeded`.',
        'Mutations update an optimistic in-tick snapshot, but the main thread can still reject internal entity edits with `entity_not_stopped`.',
        "Assembly defaults: dynamic body, restitution 0.1, friction 0.7, gravity enabled for dynamic bodies, and mass equal to owned block count × 10 kg with a 0.1 kg minimum.",
        'Gate destructive selection commands with `self.state` or an input edge so they run once.'
      ]
    },
    {
      id: 'input',
      title: 'ctx.input and ctx.blocks',
      facts: [
        '`ctx.input.down(code)`, `pressed(code)`, and `released(code)` expose held, leading-edge, and trailing-edge keyboard state.',
        'Only the mounted entity receives player input. Generic `Shift`, `Control`, and `Alt` match either side.',
        'Reserved keys never reach scripts: Escape, Backspace, Delete, F3, F5, C, E, F, G, R, V, and digits 0–9.',
        "`ctx.blocks.pressed(type?)` is a one-tick edit edge for `place|remove|color|subdivide`; `event()` returns type/node, source/player, affected cell(s), voxel metadata, truncation, and final blockCount when available."
      ]
    },
    {
      id: 'force-budget',
      title: 'Legacy root force budget',
      facts: [
        '`self.applyForce`, `applyLocalForce`, `applyThrust`, `applyForceAt`, and `applyTorque` target the root and share `maxForce = max(80, mass×65)` and `maxTorque = max(40, maxForce×max(0.75,boundingRadius))`.',
        'The engine clamps that legacy surface and displays its utilization in the Root Power Budget HUD.',
        '`self.body.apply*` is independent of that gameplay budget. Both force surfaces reject non-finite components and values above the separate `1e12` safety ceiling.'
      ]
    },
    {
      id: 'tips',
      title: 'Editor tips',
      prompt: 'omit',
      facts: [
        'Ctrl/Cmd+Enter saves code and returns to the game; Escape closes the panel.',
        'Mount with V before writing a driving script; only mounted entities receive keyboard input.',
        'Use `self.state` for target values, phases, counters, and timers.',
        'Use `ctx.deltaTime` only when explicitly integrating a rate. Forces and torques are already commands in N/N·m.'
      ]
    }
  ],
  runtimeSurfaces: {
    self: [
      'apiVersion', 'id', 'parentId', 'applyThrust', 'applyLocalThrust', 'getWorldPosition', 'getWorldRotation', 'getPivot',
      'localToWorldDirection', 'getBounds', 'setLocalPosition', 'setLocalRotation', 'setLocalEuler',
      'setLocalSpin', 'getLocalPosition', 'getLocalRotation', 'setPivot', 'applyForce', 'applyLocalForce',
      'applyForceAt', 'applyTorque', 'setSeats', 'stop', 'getSeats', 'child', 'state', 'children',
      'body', 'constraints', 'voxels', 'microVoxels'
    ],
    'self.body': [
      'getType', 'setType', 'getMass', 'setMass', 'getMaterial', 'setMaterial', 'getGravityEnabled',
      'setGravityEnabled', 'getCollisionEnabled', 'setCollisionEnabled', 'getVelocity', 'getAngularVelocity',
      'applyForce', 'applyLocalForce', 'applyTorque'
    ],
    'self.constraints': ['all', 'create', 'remove'],
    'self.voxels': ['set', 'clear', 'paint', 'clearCell', 'subdivide'],
    'self.microVoxels': ['set', 'clear', 'paint']
  }
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inlineHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderHtmlSection(section: ApiSection, depth = 2): string {
  const headingClass = depth <= 2 ? 'api-h2' : 'api-h3';
  const intro = section.intro ? `<p class="api-sub">${inlineHtml(section.intro)}</p>` : '';
  const facts = section.facts?.length
    ? `<ul class="api-ul">${section.facts.map(fact => `<li>${inlineHtml(fact)}</li>`).join('')}</ul>`
    : '';
  const hasTypes = !!section.entries?.some(entry => entry.type);
  const entries = section.entries?.length
    ? `<table class="api-table"><thead><tr><th>API</th>${hasTypes ? '<th>Type</th>' : ''}<th>Description</th></tr></thead><tbody>${section.entries.map(entry => (
      `<tr><td><code>${escapeHtml(entry.signature)}</code></td>${hasTypes ? `<td>${inlineHtml(entry.type || '')}</td>` : ''}<td>${inlineHtml(entry.description)}</td></tr>`
    )).join('')}</tbody></table>`
    : '';
  const notes = section.notes?.map(note => `<p class="api-sub">${inlineHtml(note)}</p>`).join('') || '';
  const examples = section.examples?.map(example => (
    `${example.title ? `<div class="api-code-title">${inlineHtml(example.title)}</div>` : ''}<pre class="api-code"><code>${escapeHtml(example.code)}</code></pre>`
  )).join('') || '';
  const subsections = section.subsections?.map(child => renderHtmlSection(child, depth + 1)).join('') || '';
  return `<div class="api-section"><div class="${headingClass}">${inlineHtml(section.title)}</div>${intro}${facts}${entries}${notes}${examples}${subsections}</div>`;
}

export function renderApiReferenceHtml(contract: ScriptApiContract = SPACE_SCRIPT_API_V2): string {
  return contract.sections.map(section => renderHtmlSection(section)).join('\n');
}

function markdownSection(section: ApiSection, depth = 2, agentOnly = false): string {
  if (agentOnly && section.prompt === 'omit') return '';
  const lines = [`${'#'.repeat(depth)} ${section.title}`, ''];
  if (section.intro) lines.push(section.intro, '');
  for (const fact of section.facts || []) lines.push(`- ${fact}`);
  if (section.facts?.length) lines.push('');
  const entries = (section.entries || []).filter(entry => !agentOnly || entry.prompt !== 'omit');
  if (entries.length) {
    if (agentOnly) {
      for (const entry of entries) lines.push(`- \`${entry.signature}\` — ${entry.description}`);
      lines.push('');
    } else {
      lines.push(`| API |${entries.some(entry => entry.type) ? ' Type |' : ''} Description |`);
      lines.push(`| --- |${entries.some(entry => entry.type) ? ' --- |' : ''} --- |`);
      for (const entry of entries) {
        const description = entry.description.replaceAll('|', '\\|');
        lines.push(`| \`${entry.signature}\` |${entries.some(item => item.type) ? ` ${entry.type || ''} |` : ''} ${description} |`);
      }
      lines.push('');
    }
  }
  for (const note of section.notes || []) lines.push(`> ${note}`, '');
  if (!agentOnly) {
    for (const example of section.examples || []) {
      if (example.title) lines.push(`**${example.title}**`, '');
      lines.push('```js', example.code, '```', '');
    }
  }
  for (const child of section.subsections || []) lines.push(markdownSection(child, depth + 1, agentOnly));
  return lines.join('\n').trimEnd();
}

export function renderApiReferenceMarkdown(contract: ScriptApiContract = SPACE_SCRIPT_API_V2): string {
  const header = [
    `# ${contract.title}`,
    '',
    '<!-- GENERATED from src/contraption/ScriptApiContract.ts. Do not edit by hand. -->',
    '',
    contract.summary,
    ''
  ];
  return `${header.join('\n')}${contract.sections.map(section => markdownSection(section)).join('\n\n')}\n`;
}

export function renderAgentApiReference(contract: ScriptApiContract = SPACE_SCRIPT_API_V2): string {
  const header = [
    `## Canonical ${contract.title} contract`,
    '',
    'Use only the API below. API facts in this section are generated from the same contract as the in-game reference.',
    ''
  ];
  return `${header.join('\n')}${contract.sections.map(section => markdownSection(section, 3, true)).filter(Boolean).join('\n\n')}`;
}

export function validateScriptApiContract(contract: ScriptApiContract = SPACE_SCRIPT_API_V2): string[] {
  const errors: string[] = [];
  const sectionIds = new Set<string>();
  const documentedSignatures: string[] = [];
  const visit = (section: ApiSection) => {
    if (sectionIds.has(section.id)) errors.push(`duplicate section id: ${section.id}`);
    sectionIds.add(section.id);
    for (const entry of section.entries || []) {
      if (!entry.signature.trim()) errors.push(`empty API signature in ${section.id}`);
      if (!entry.description.trim()) errors.push(`empty API description for ${entry.signature}`);
      documentedSignatures.push(entry.signature);
    }
    section.subsections?.forEach(visit);
  };
  contract.sections.forEach(visit);
  for (const [surface, keys] of Object.entries(contract.runtimeSurfaces)) {
    if (new Set(keys).size !== keys.length) errors.push(`duplicate runtime key in ${surface}`);
    for (const key of keys) {
      const qualified = `${surface}.${key}`;
      if (!documentedSignatures.some(signature => signature.includes(qualified))) {
        errors.push(`undocumented runtime key: ${qualified}`);
      }
    }
  }
  if (contract.version !== 2) errors.push(`unexpected API version: ${contract.version}`);
  return errors;
}

const contractErrors = validateScriptApiContract(SPACE_SCRIPT_API_V2);
if (contractErrors.length) throw new Error(`Invalid Space Script API contract:\n${contractErrors.join('\n')}`);

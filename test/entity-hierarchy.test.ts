import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyType, Contraption, ContraptionMode } from '../src/contraption/Contraption.ts';
import { ContraptionManager } from '../src/contraption/ContraptionManager.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';
import { BlockTypes } from '../src/voxel/BlockTypes.ts';
import { World } from '../src/voxel/World.ts';

function standardBlock(x, y = 0, z = 0) {
  return {
    localX: x,
    localY: y,
    localZ: z,
    size: 1,
    block: BlockTypes.COLOR_BLOCK,
    color: 0xf2a93b,
    entityId: 'root'
  };
}

test('root and world are ordinary component IDs', () => {
  const contraption = new Contraption(
    1001,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    new THREE.Scene(),
    {
      childEntities: [{
        id: 'arm',
        parentId: 'root',
        blockKeys: [['1', '0', '0']],
        kind: 'child',
        index: 17,
        obsoleteMetadata: { shouldNotEscape: true }
      }]
    }
  ) as any;

  const world = contraption.createChildEntity('root', new Set(['2,0,0']), 'world');
  assert.equal(world.id, 'world');

  const serialized = contraption.serializeSubtree('root');
  assert.ok(serialized.childEntities.some(component => component.id === 'world'));
  const serializedArm = serialized.childEntities.find(component => component.id === 'arm');
  assert.ok(serializedArm);
  assert.equal('kind' in serializedArm, false);
  assert.equal('index' in serializedArm, false);
  assert.equal('blockKeys' in serializedArm, false);
  assert.equal('obsoleteMetadata' in serializedArm, false);

  const combined = contraption.serializeSubtrees(['arm', 'world']);
  assert.ok(combined);
  for (const component of combined.childEntities) {
    assert.equal('kind' in component, false);
    assert.equal('index' in component, false);
    assert.equal('blockKeys' in component, false);
    assert.equal('obsoleteMetadata' in component, false);
  }
});

test('dynamic root IDs keep world/root components distinct across scripts, constraints, physics, and slots', () => {
  const scene = new THREE.Scene();
  const entity = new Contraption(
    1002,
    [
      { ...standardBlock(0), entityId: 'world' },
      { ...standardBlock(1), entityId: 'root' }
    ],
    new THREE.Vector3(0, 8, 0),
    scene,
    {
      rootComponentId: 'world',
      bodyType: BodyType.KINEMATIC,
      childEntities: [{
        id: 'root',
        parentId: 'world',
        pivot: [1.5, 0.5, 0.5],
        bodyType: BodyType.DYNAMIC,
        blockKeys: [[1, 0, 0]]
      }],
      constraints: [
        { id: 'internal', type: 'point', bodyA: 'world', bodyB: 'root' },
        { id: 'external', type: 'point', bodyA: null, bodyB: 'world' }
      ]
    }
  ) as any;

  assert.equal(entity.rootComponentId, 'world');
  assert.equal(entity.getEntityNode('world').parentId, null);
  assert.equal(entity.getEntityNode('root').parentId, 'world');
  assert.equal(entity.constraintDefinitions.get('internal').bodyA, 'world');
  assert.equal(entity.constraintDefinitions.get('external').bodyA, null);

  entity.setScript(`
self.state.id = self.id;
self.state.child = self.child('root').id;
`);
  entity.setNodeScript('root', `
self.state.id = self.id;
self.state.ctxRoot = ctx.root.id;
self.state.sameNamedChild = self.child('root') !== null;
`);
  entity.update(0.05, null, { gravity: [0, -18, 0] });
  assert.deepEqual(entity.getComponentState('world'), { id: 'world', child: 'root' });
  assert.deepEqual(entity.getComponentState('root'), {
    id: 'root',
    ctxRoot: 'world',
    sameNamedChild: false
  });

  const physics = new ContraptionPhysics({
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false }),
    getBlock: () => BlockTypes.AIR
  });
  physics.update(entity, 0.05);
  assert.equal(entity.getRigidBody('world').nodeId, 'world');
  assert.equal(entity.getRigidBody('root').nodeId, 'root');

  const slot = entity.serializeSubtree('world');
  assert.equal(slot.rootComponentId, 'world');
  assert.deepEqual(new Set(slot.blocks.map(block => block.entityId)), new Set(['world', 'root']));
  assert.equal(slot.constraints.find(constraint => constraint.id === 'internal').bodyA, 'world');
  assert.equal(slot.constraints.find(constraint => constraint.id === 'external').bodyA, null);
  assert.equal(entity.serializeSubtree('root').rootComponentId, 'root');

  const host = new Contraption(
    1003,
    [{ ...standardBlock(0), entityId: 'host' }],
    new THREE.Vector3(),
    scene,
    { rootComponentId: 'host' }
  ) as any;
  host.setPhysicsSimulationEnabled(false);
  const installed = host.installEntitySlot(slot, 'host', new THREE.Vector3(3, 0, 0));
  assert.equal(installed.ok, true);
  assert.ok(host.getEntityNode(installed.rootId));
  assert.ok(host.getEntityNode('root'), 'the source child named root remains an ordinary child');
  assert.equal(installed.skippedExternalConstraints, 1);
});

test('child entities can recursively own blocks and move relative to their parent', () => {
  const contraption = new Contraption(
    1,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    new THREE.Scene(),
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  const link1 = contraption.createChildEntity('root', new Set(['1,0,0', '2,0,0']), 'link_1');
  const link2 = contraption.createChildEntity('link_1', new Set(['2,0,0']), 'link_2');

  assert.equal(link1.parentId, 'root');
  assert.equal(link2.parentId, 'link_1');
  assert.equal(contraption.blocks.find(block => block.localX === 2).entityId, 'link_2');

  const before = link2.group.getWorldPosition(new THREE.Vector3());
  contraption.getChildScriptApi('link_1').setLocalSpin([0, 0, 1], 60);
  contraption.update(0.25, null, null);
  const after = link2.group.getWorldPosition(new THREE.Vector3());

  assert.equal(before.equals(after), false);
  assert.equal(contraption.getCollisionWorldAABBs().length, 3);
});

test('kinematic root ignores forces while child code keeps running', () => {
  const scriptCode = `
self.child('blades').setLocalSpin([0, 0, 1], 60);
self.applyForce([100000, 0, 0]);
`;
  const contraption = new Contraption(
    2,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(0, 8, 0),
    new THREE.Scene(),
    {
      bodyType: BodyType.KINEMATIC,
      mode: ContraptionMode.PROGRAMMABLE,
      scriptCode,
      childEntities: [{ id: 'blades', pivot: [1.5, 0.5, 0.5], blockKeys: [[1, 0, 0]] }]
    }
  ) as any;
  const physics = new ContraptionPhysics({
    raycast: () => ({ hit: false }),
    raycastMicro: () => ({ hit: false }),
    getBlock: () => BlockTypes.AIR
  });
  const startPosition = contraption.position.clone();
  const startRotation = contraption.getEntityNode('blades').localQuaternion.clone();

  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });
  physics.update(contraption, 0.25);

  assert.equal(contraption.position.equals(startPosition), true);
  assert.equal(contraption.velocity.lengthSq(), 0);
  assert.equal(contraption.getEntityNode('blades').localQuaternion.equals(startRotation), false);
});

test('Selector child selection uses single-click and Shift multi-select, with green breathing child bounding boxes', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    3,
    [standardBlock(0), standardBlock(1), standardBlock(2), standardBlock(3), standardBlock(4)],
    new THREE.Vector3(),
    scene
  ) as any;
  contraption.createChildEntity('root', new Set(['3,0,0', '4,0,0']), 'arm');
  contraption.stopAllNodeScripts();
  const manager = new ContraptionManager(scene, {}, null, null) as any;
  manager.contraptions.push(contraption);
  const hit = (x, entityId = 'root') => ({
    contraption,
    entityId,
    entityNode: contraption.getEntityNode(entityId),
    cell: { x, y: 0, z: 0 }
  });

  // 1. Plain click on root cell: single selection (1 cell)
  let info = manager.selectChildEntityCell(hit(0), false);
  assert.equal(info.mode, 'single');
  assert.equal(info.ready, true);
  assert.deepEqual([...info.cells], ['0,0,0']);

  // Plain click on another root cell replaces selection
  info = manager.selectChildEntityCell(hit(2), false);
  assert.deepEqual([...info.cells], ['2,0,0']);

  // Shift-click adds/multi-selects cells
  info = manager.selectChildEntityCell(hit(0), true);
  assert.equal(info.count, 2);
  assert.deepEqual(new Set(info.cells), new Set(['0,0,0', '2,0,0']));

  // Shift-click on already selected cell toggles it off
  info = manager.selectChildEntityCell(hit(2), true);
  assert.deepEqual([...info.cells], ['0,0,0']);

  // Shift-click cell 1 adds it
  info = manager.selectChildEntityCell(hit(1), true);
  assert.deepEqual(new Set(info.cells), new Set(['0,0,0', '1,0,0']));

  // Direct child 'arm' has green breathing bounding box in focusChildBreathing highlights
  assert.ok(contraption.focusHighlightMaterials);
  assert.equal(contraption.focusHighlightMaterials.childLine.color.getHex(), 0x2ed573);
  const beforePulse = contraption.focusHighlightMaterials.childLine.opacity;
  contraption.update(0.2, null, null);
  assert.notEqual(contraption.focusHighlightMaterials.childLine.opacity, beforePulse);

  // 2. Clicking 'arm' component focuses into 'arm', allowing child-of-child selection
  info = manager.selectChildEntityCell(hit(3, 'arm'), false);
  assert.equal(info.parentId, 'arm');
  assert.deepEqual([...info.cells], ['3,0,0']);

  // Shift-click adds cell 4 to arm's selection
  info = manager.selectChildEntityCell(hit(4, 'arm'), true);
  assert.deepEqual(new Set(info.cells), new Set(['3,0,0', '4,0,0']));

  const result = manager.createChildFromSelection('claw');
  assert.equal(result.child.id, 'claw');
  assert.equal(result.child.parentId, 'arm');
  assert.equal(contraption.blocks.find(block => block.localX === 3).entityId, 'claw');
  assert.equal(manager.hasChildSelection(), false);
});

test('Super Glue world selection switches between three-point and sparse single-cell modes', () => {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const manager = new ContraptionManager(scene, world, null, null) as any;
  for (const x of [2, 3, 4]) {
    world.setBlock(x, 10, 2, BlockTypes.COLOR_BLOCK, false, 0xf2a93b);
  }

  manager.addGluePoint({ x: 2, y: 10, z: 2 });
  let info = manager.toggleWorldGlueCell({ x: 2, y: 10, z: 2 });
  assert.equal(info.mode, 'single');
  assert.equal(info.count, 1);
  assert.equal(manager.gluePoints.length, 0);
  info = manager.toggleWorldGlueCell({ x: 4, y: 10, z: 2 });
  assert.equal(info.count, 2);

  // A plain click clears sparse cells and becomes point one of a fresh box.
  assert.equal(manager.addGluePoint({ x: 3, y: 10, z: 2 }), 1);
  assert.equal(manager.connectedSelection, null);
  assert.equal(manager.addGluePoint({ x: 4, y: 10, z: 2 }), 2);
  assert.equal(manager.addGluePoint({ x: 2, y: 10, z: 2 }), 3);
  assert.equal(manager.hasValidSelection(), true);

  // Re-enter sparse mode and assemble only the two endpoints; the middle
  // world block must remain untouched.
  manager.toggleWorldGlueCell({ x: 2, y: 10, z: 2 });
  manager.toggleWorldGlueCell({ x: 4, y: 10, z: 2 });
  const entity = manager.assembleSelection(ContraptionMode.PROGRAMMABLE) as any;
  assert.equal(entity.blocks.length, 2);
  assert.equal(world.getBlock(3, 10, 2), BlockTypes.COLOR_BLOCK);
  assert.equal(world.getBlock(2, 10, 2), BlockTypes.AIR);
  assert.equal(world.getBlock(4, 10, 2), BlockTypes.AIR);
});

test('getHierarchyTree builds complete component hierarchy and setHighlightedNode highlights node', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    5,
    [standardBlock(0), standardBlock(1), standardBlock(2), standardBlock(3)],
    new THREE.Vector3(),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  const arm = contraption.createChildEntity('root', new Set(['1,0,0', '2,0,0']), 'arm');
  const hand = contraption.createChildEntity('arm', new Set(['2,0,0']), 'hand');

  const tree = contraption.getHierarchyTree();
  assert.equal(tree.id, 'root');
  assert.equal(tree.blockCount, 2); // 0,0,0 and 3,0,0 belong to root
  assert.equal(tree.children.length, 1);

  const armNode = tree.children[0];
  assert.equal(armNode.id, 'arm');
  assert.equal(armNode.parentId, 'root');
  assert.equal(armNode.blockCount, 1); // 1,0,0 belongs to arm
  assert.equal(armNode.children.length, 1);

  const handNode = armNode.children[0];
  assert.equal(handNode.id, 'hand');
  assert.equal(handNode.parentId, 'arm');
  assert.equal(handNode.blockCount, 1); // 2,0,0 belongs to hand
  assert.equal(handNode.children.length, 0);

  // Test setHighlightedNode
  assert.equal(contraption.nodeHighlightBox, null);
  contraption.setHighlightedNode('arm');
  assert.ok(contraption.nodeHighlightBox);
  assert.equal(contraption.selectedNodeId, 'arm');
  assert.ok(contraption.nodeHighlightMaterials);

  // Node highlight updates and pulses
  const startOpacity = contraption.nodeHighlightMaterials.lineMat.opacity;
  contraption.update(0.25, null, null);
  assert.notEqual(contraption.nodeHighlightMaterials.lineMat.opacity, startOpacity);

  // Clear highlight
  contraption.setHighlightedNode(null);
  assert.equal(contraption.nodeHighlightBox, null);
  assert.equal(contraption.selectedNodeId, null);
});

test('per-node scripting, renaming and property inspection work as expected', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    6,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  const arm = contraption.createChildEntity('root', new Set(['1,0,0', '2,0,0']), 'arm_1');

  // Test getNodeProperties
  const rootProps = contraption.getNodeProperties('root');
  assert.equal(rootProps.id, 'root');
  assert.equal(rootProps.kind, 'root');
  assert.equal(rootProps.blockCount, 1);
  assert.equal(rootProps.hasScript, false);
  assert.deepEqual(rootProps.anchorQuaternion, [0, 0, 0, 1]);
  assert.deepEqual(rootProps.localQuaternion, [0, 0, 0, 1]);
  assert.deepEqual(rootProps.worldQuaternion, [0, 0, 0, 1]);

  const armProps = contraption.getNodeProperties('arm_1');
  assert.equal(armProps.id, 'arm_1');
  assert.equal(armProps.parentId, 'root');
  assert.equal(armProps.blockCount, 2);
  assert.deepEqual(armProps.restLocalQuaternion, [0, 0, 0, 1]);
  assert.deepEqual(armProps.runtimeBody.quaternion, [0, 0, 0, 1]);

  // Test setNodeScript & execution
  contraption.setNodeScript('root', `self.applyForce([10, 0, 0]);`);
  contraption.setNodeScript('arm_1', `self.setLocalSpin([0, 1, 0], 60);`);

  assert.equal(contraption.getNodeScript('root'), `self.applyForce([10, 0, 0]);`);
  assert.equal(contraption.getNodeScript('arm_1'), `self.setLocalSpin([0, 1, 0], 60);`);
  assert.equal(contraption.getNodeProperties('arm_1').hasScript, true);

  contraption.update(0.25, null, null);
  assert.notEqual(contraption.getEntityNode('arm_1').localQuaternion.w, 1);

  // Test renameChildEntity
  const renameSuccess = contraption.renameChildEntity('arm_1', 'robot_arm');
  assert.equal(renameSuccess, true);
  assert.equal(contraption.getEntityNode('arm_1'), null);
  assert.ok(contraption.getEntityNode('robot_arm'));
  assert.equal(contraption.getNodeScript('robot_arm'), `self.setLocalSpin([0, 1, 0], 60);`);

  const updatedProps = contraption.getNodeProperties('robot_arm');
  assert.equal(updatedProps.id, 'robot_arm');
  assert.equal(updatedProps.blockCount, 2);
  assert.equal(contraption.renameChildEntity('robot_arm', '<img_onerror>'), false);
  assert.ok(contraption.getEntityNode('robot_arm'), 'a rejected id must not mutate the hierarchy');

  // Verify child script updates NEVER overwrite root script
  contraption.setNodeScript('robot_arm', `self.setLocalPosition([0, 1, 0]);`);
  assert.equal(contraption.getNodeScript('root'), `self.applyForce([10, 0, 0]);`);
  assert.equal(contraption.getNodeScript('robot_arm'), `self.setLocalPosition([0, 1, 0]);`);
});

test('getNodeProperties reports the live root quaternion instead of its identity hierarchy placeholder', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    89,
    [standardBlock(0)],
    new THREE.Vector3(3, 4, 5),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  contraption.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  contraption.updateTransform();
  const props = contraption.getNodeProperties('root');

  assert.deepEqual(props.localPosition, [0, 0, 0], 'root script-local position has no parent');
  assert.deepEqual(props.localQuaternion, [0, 0.7071, 0, 0.7071]);
  assert.deepEqual(props.worldQuaternion, [0, 0.7071, 0, 0.7071]);
  assert.deepEqual(props.runtimeBody.quaternion, [0, 0.7071, 0, 0.7071]);
  assert.deepEqual(props.worldPosition, [3.5, 4.5, 5.5]);
  assert.equal(props.runtimeBody.simulationEnabled, true);
  assert.equal(props.runtimeBody.speed, 0);
  assert.equal(props.runtimeBody.rpm, 0);
});

test('getNodeProperties splits persisted defaults from live runtime values', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    90,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE, restitution: 0.25, friction: 0.35 }
  ) as any;

  // Script-side (runtimeOnly) overrides move the live body without touching the defaults.
  contraption.setNodeBodyMass('root', 77, { runtimeOnly: true });
  contraption.setNodeBodyType('root', 'kinematic', { runtimeOnly: true });
  contraption.setNodeBodyMaterial('root', { restitution: 0.9 }, { runtimeOnly: true });

  const props = contraption.getNodeProperties('root');
  assert.equal(props.bodyType, 'dynamic', 'default body type is untouched');
  assert.equal(props.mass, 20, 'default mass stays block-derived (2 × 10 kg)');
  assert.equal(props.restitution, 0.25, 'default restitution is untouched');
  assert.equal(props.friction, 0.35, 'default friction is untouched');
  assert.equal(props.runtimeBody.bodyType, 'kinematic', 'runtime view shows the live type');
  assert.equal(props.runtimeBody.mass, 77, 'runtime view shows the live mass');
  assert.equal(props.runtimeBody.restitution, 0.9, 'runtime view shows the live material');
  assert.deepEqual(props.runtimeBody.velocity, [0, 0, 0]);
  assert.deepEqual(props.runtimeBody.angularVelocity, [0, 0, 0]);
  assert.deepEqual(props.runtimeBody.centerOfMassLocal, [0, 0, 0]);
  assert.equal(props.runtimeBody.simulationEnabled, true);

  // Panel-side (persistent) edits update the defaults themselves.
  contraption.setNodeBodyMass('root', 30);
  const edited = contraption.getNodeProperties('root');
  assert.equal(edited.mass, 30, 'editor edits change the PB default');
  assert.equal(edited.runtimeBody.mass, 30, 'editor edits also apply to the live body');

  // Global Stop restores the defaults, including the editor edit.
  contraption.stopAllNodeScripts();
  const restored = contraption.getNodeProperties('root');
  assert.equal(restored.bodyType, 'dynamic');
  assert.equal(restored.mass, 30);
  assert.equal(restored.restitution, 0.25);
  assert.equal(restored.runtimeBody.bodyType, 'dynamic');
  assert.equal(restored.runtimeBody.mass, 30);
  assert.equal(restored.runtimeBody.restitution, 0.25);
  assert.equal(restored.runtimeBody.simulationEnabled, false);
});

test('shovel and spoon can directly modify running entities and append blocks to child components', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    7,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  const spinner = contraption.createChildEntity('root', new Set(['2,0,0']), 'spinner');
  assert.equal(contraption.getNodeProperties('spinner').blockCount, 1);
  assert.equal(contraption.getNodeProperties('root').blockCount, 2);

  // 1. Raycast hitting child component block (2,0,0)
  const hit = contraption.raycastCollisionCells(
    new THREE.Vector3(2.5, 0.5, 5),
    new THREE.Vector3(0, 0, -1),
    10
  );
  assert.ok(hit);
  assert.equal(hit.entityId, 'spinner');
  assert.deepEqual(hit.cell, { x: 2, y: 0, z: 0 });
  assert.deepEqual(hit.normal.toArray(), [0, 0, 1]);
  assert.deepEqual(hit.placeCell, { x: 2, y: 0, z: 1 });

  // 2. Append standard block (Shovel right-click simulation) to child component
  contraption.blocks.push({
    localX: hit.placeCell.x,
    localY: hit.placeCell.y,
    localZ: hit.placeCell.z,
    size: 1,
    color: '#ff0000',
    block: BlockTypes.COLOR_BLOCK,
    entityId: hit.entityId
  });
  contraption.rebuildAfterBlockChange();

  // Verify spinner child component now owns 2 blocks
  assert.equal(contraption.getNodeProperties('spinner').blockCount, 2);
  assert.equal(contraption.getNodeProperties('root').blockCount, 2);

  // 3. Subdivide block on child component (Spoon left-click simulation)
  const blockIdx = contraption.blocks.findIndex(b => b.localX === 2 && b.localY === 0 && b.localZ === 1);
  const oldBlock = contraption.blocks[blockIdx];
  contraption.blocks.splice(blockIdx, 1);
  for (let ix = 0; ix < 5; ix++) {
    for (let iy = 0; iy < 5; iy++) {
      for (let iz = 0; iz < 5; iz++) {
        contraption.blocks.push({
          localX: 2 + ix * 0.2,
          localY: 0 + iy * 0.2,
          localZ: 1 + iz * 0.2,
          size: 0.2,
          color: oldBlock.color,
          block: BlockTypes.COLOR_BLOCK,
          entityId: oldBlock.entityId
        });
      }
    }
  }
  contraption.rebuildAfterBlockChange();

  // Verify all 125 micro blocks belong to spinner
  const spinnerBlocks = contraption.blocks.filter(b => b.entityId === 'spinner');
  assert.equal(spinnerBlocks.length, 126); // 1 standard + 125 micro

  // 4. Raycast micro block on child component
  const microHit = contraption.raycastCollisionCells(
    new THREE.Vector3(2.1, 0.1, 5),
    new THREE.Vector3(0, 0, -1),
    10
  );
  assert.ok(microHit);
  assert.equal(microHit.entityId, 'spinner');
  assert.equal(microHit.kind, 'micro');

  // 5. Test bounding box resizing and highlightBox updates
  // Initial size was 3x1x1 (blocks at x=0, 1, 2). With block appended at z=1, size.z is now 2
  assert.equal(contraption.size.x, 3);
  assert.equal(contraption.size.y, 1);
  assert.equal(contraption.size.z, 2);
  assert.ok(contraption.highlightBox);

  // Highlight box geometry matches exact size
  const boxSize = new THREE.Vector3();
  contraption.highlightBox.geometry.computeBoundingBox();
  contraption.highlightBox.geometry.boundingBox.getSize(boxSize);
  assert.ok(Math.abs(boxSize.x - 3.0) < 1e-4);
  assert.ok(Math.abs(boxSize.z - 2.0) < 1e-4);

  // Test node highlight box updates for spinner
  contraption.setHighlightedNode('spinner');
  assert.ok(contraption.nodeHighlightBox);
  assert.ok(contraption.nodeHighlightGeometries?.box);
  assert.ok(Math.abs(contraption.nodeHighlightGeometries.box.parameters.depth - 2.0) < 1e-6);
});

test('per-component script switches allow independent control, global all-on/off, and state persistence', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    11,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  contraption.createChildEntity('root', new Set(['1,0,0']), 'arm');
  contraption.createChildEntity('root', new Set(['2,0,0']), 'rotor');

  // Set scripts for root, arm, and rotor
  contraption.setNodeScript('root', `self.applyForce([0, 100, 0]);`);
  contraption.setNodeScript('arm', `self.setLocalSpin([0, 1, 0], 60);`);
  contraption.setNodeScript('rotor', `self.setLocalSpin([1, 0, 0], 120);`);

  // Initial state: all enabled by default
  assert.equal(contraption.isNodeScriptEnabled('root'), true);
  assert.equal(contraption.isNodeScriptEnabled('arm'), true);
  assert.equal(contraption.isNodeScriptEnabled('rotor'), true);

  // 1. Disable arm script only
  contraption.setNodeScriptEnabled('arm', false);
  assert.equal(contraption.isNodeScriptEnabled('root'), true);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.equal(contraption.isNodeScriptEnabled('rotor'), true);

  // Update physics/scripts: root applies force, rotor rotates, arm stays stopped
  contraption.update(0.1, null, null);
  assert.ok(contraption.appliedForces.y > 0); // root executed
  assert.notEqual(contraption.getEntityNode('rotor').localQuaternion.x, 0); // rotor rotated
  assert.equal(contraption.getEntityNode('arm').localQuaternion.y, 0); // arm did NOT rotate!

  // 2. Disable all scripts
  contraption.disableAllNodeScripts();
  assert.equal(contraption.isNodeScriptEnabled('root'), false);
  assert.equal(contraption.isNodeScriptEnabled('arm'), false);
  assert.equal(contraption.isNodeScriptEnabled('rotor'), false);

  contraption.appliedForces.set(0, 0, 0);
  contraption.update(0.1, null, null);
  assert.equal(contraption.appliedForces.y, 0); // root did NOT execute!

  // 3. Enable root and arm only, rotor remains disabled
  contraption.setNodeScriptEnabled('root', true);
  contraption.setNodeScriptEnabled('arm', true);
  assert.equal(contraption.isNodeScriptEnabled('root'), true);
  assert.equal(contraption.isNodeScriptEnabled('arm'), true);
  assert.equal(contraption.isNodeScriptEnabled('rotor'), false);

  // 4. Modifying/saving script for rotor preserves rotor's disabled state!
  contraption.setNodeScript('rotor', `self.setLocalSpin([1, 0, 0], 360);`);
  assert.equal(contraption.isNodeScriptEnabled('rotor'), false);

  // 5. Global enable all
  contraption.enableAllNodeScripts();
  assert.equal(contraption.isNodeScriptEnabled('root'), true);
  assert.equal(contraption.isNodeScriptEnabled('arm'), true);
  assert.equal(contraption.isNodeScriptEnabled('rotor'), true);
});

test('adding blocks on a stopped contraption does not trigger tick script or component motion', () => {
  const scene = new THREE.Scene();
  const contraption = new Contraption(
    12,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    scene,
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;

  contraption.createChildEntity('root', new Set(['1,0,0']), 'fan');
  const fanNode = contraption.getEntityNode('fan');

  contraption.setNodeScript('root', `self.applyForce([0, 500, 0]);`);
  contraption.setNodeScript('fan', `self.setLocalSpin([0, 1, 0], 300);`);

  // Stop the contraption scripts
  contraption.stopAllNodeScripts();
  assert.equal(contraption.scriptStatus, 'stopped');

  // Verify forces and component spin are 0
  contraption.update(0.1, null, null);
  assert.equal(contraption.appliedForces.y, 0);
  assert.equal(fanNode.localAngularVelocity.length(), 0, 'a stopped component must not rotate');

  // Add a block to contraption (simulating shovel/spoon addition)
  contraption.blocks.push({
    localX: 2,
    localY: 0,
    localZ: 0,
    size: 1,
    color: 0xffffff,
    block: BlockTypes.COLOR_BLOCK,
    entityId: 'root'
  });
  contraption.rebuildAfterBlockChange();

  // Ensure scriptStatus is still stopped and components remain still!
  assert.equal(contraption.scriptStatus, 'stopped');

  // Update physics/scripts for 1 tick: force must remain 0 and fan must remain still
  contraption.update(0.1, null, null);
  assert.equal(contraption.appliedForces.y, 0);
  assert.equal(fanNode.localAngularVelocity.length(), 0, 'the component must remain still after rebuild');
  assert.equal(fanNode.localQuaternion.y, 0);
});

test('a live block rebuild preserves runtime motion but Stop restores the borrowed voxel grid', () => {
  const contraption = new Contraption(
    13,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene(),
    { mode: ContraptionMode.PROGRAMMABLE }
  ) as any;
  contraption.createChildEntity('root', new Set(['1,0,0']), 'arm');
  const authoredPosition = contraption.getEntityNode('arm').initialLocalPosition.clone();
  const arm = contraption.getChildScriptApi('arm');
  arm.setLocalPosition([-0.5, 0, 0]);
  arm.setLocalEuler([0, Math.PI / 4, 0]);
  contraption.scriptStatus = 'running';

  contraption.blocks.push({ ...standardBlock(2), entityId: 'root' });
  contraption.rebuildAfterBlockChange();
  assert.ok(contraption.getEntityNode('arm').localQuaternion.angleTo(new THREE.Quaternion()) > 0.1,
    'a live structural rebuild should not visually jump the moving component');

  contraption.stopAllNodeScripts();
  const stoppedArm = contraption.getEntityNode('arm');
  assert.ok(stoppedArm.localQuaternion.angleTo(new THREE.Quaternion()) < 1e-9);
  assert.ok(stoppedArm.localPosition.distanceTo(authoredPosition) < 1e-9);
  const centers = contraption.blocks.map(block => contraption.getBlockWorldCenter(block).x).sort((a, b) => a - b);
  assert.deepEqual(centers, [0.5, 1.5, 2.5], 'borrowed blocks return to distinct construction cells');
});

test('V2 ctx.root plus children traverses the real hierarchy without flat ctx.children', () => {
  const contraption = new Contraption(
    88,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene(),
    {
      childEntities: [
        { id: 'blade', parentId: 'root', pivot: [0.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] },
        { id: 'arm', parentId: 'root', pivot: [1.5, 0.5, 0.5] },
        { id: 'tip', parentId: 'blade', pivot: [1.5, 0.5, 0.5] }
      ]
    }
  ) as any;

  contraption.setScript(`
function walk(node, result = []) {
  result.push({ id: node.id, parentId: node.parentId });
  for (const child of node.children()) walk(child, result);
  return result;
}
self.state.nodes = walk(ctx.root);
self.state.rootIsSelf = ctx.root === self;
self.state.legacyChildren = ctx.children;
`);
  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });

  const state = contraption.scriptApi.state;
  assert.equal(state.rootIsSelf, true, 'ctx.root should equal self in a root script');
  assert.equal(state.legacyChildren, undefined, 'ctx.children should be removed');
  assert.deepEqual(
    state.nodes.map(node => node.id),
    ['root', 'arm', 'blade', 'tip'],
    'component traversal should use stable id order rather than authored sibling order'
  );
  assert.deepEqual(Object.fromEntries(state.nodes.map(node => [node.id, node.parentId])), {
    root: null,
    blade: 'root',
    tip: 'blade',
    arm: 'root'
  });

  const blade = contraption.scriptApi.child('blade');
  blade.state.owner = 'blade';
  assert.equal(contraption.scriptApi.state.owner, undefined, 'component state should be isolated');
  assert.equal(blade.children()[0].id, 'tip', 'children() should return direct children only');
});

test('component.applyThrust supports a custom direction independent of spin', () => {
  const contraption = new Contraption(
    89,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    new THREE.Scene(),
    {
      childEntities: [
        // An ordinary non-rotor child acts as a wheel, with pivot right of root COM.
        { id: 'wheel', parentId: 'root', kind: 'child', pivot: [2, 0.5, 0.5], blockKeys: [['2', '0', '0']] }
      ]
    }
  ) as any;

  // The wheel rolls around X and thrusts along root-local +Z without lateral X force.
  contraption.setScript(`
const w = self.child('wheel');
if (w) {
  w.setLocalSpin([1, 0, 0], 120);   // Wheel roll.
  w.applyThrust([0, 0, 60]);        // Forward thrust only.
}
`);
  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });
  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });

  assert.ok(contraption.appliedForces.z > 50, `forward thrust should have z=${contraption.appliedForces.z.toFixed(1)}`);
  assert.equal(contraption.appliedForces.x, 0, 'thrust direction should not be tied to the spin axis');
  assert.equal(contraption.appliedForces.y, 0, 'no vertical force should exist');
  assert.ok(
    contraption.appliedTorques.lengthSq() > 1e-6,
    'force at a component offset from COM should produce torque'
  );

  // Spin and thrust are independent, so thrust can remain while the wheel is stopped.
  contraption.setScript(`
const w = self.child('wheel');
if (w) w.applyThrust([0, 0, 30]);
`);
  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });
  assert.ok(contraption.appliedForces.z > 20, 'thrust should work without spin');
  assert.equal(contraption.getEntityNode('wheel').localAngularVelocity.lengthSq(), 0, 'the wheel should not be rotating');
});

test('component.applyThrust has no effect on a kinematic root', () => {
  const contraption = new Contraption(
    90,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene(),
    {
      bodyType: BodyType.KINEMATIC,
      childEntities: [
        { id: 'thruster', parentId: 'root', kind: 'child', pivot: [0.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] }
      ]
    }
  ) as any;
  contraption.setScript(`
self.child('thruster').applyThrust([0, 100, 0]);
`);
  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });
  assert.equal(contraption.appliedForces.lengthSq(), 0, 'a kinematic root should receive no thrust');
});

test('applyThrust rotates from body space into world space with root orientation', () => {
  const contraption = new Contraption(
    91,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene(),
    {
      childEntities: [
        { id: 'thruster', parentId: 'root', kind: 'child', pivot: [1.5, 0.5, 0.5], blockKeys: [['1', '0', '0']] }
      ]
    }
  ) as any;

  // After 90 degrees around Y, body +Z points along world +X.
  contraption.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
  contraption.updateTransform();

  contraption.setScript(`
const t = self.child('thruster');
if (t) t.applyThrust([0, 0, 40]);
`);
  contraption.update(0.25, null, { gravity: [0, -18, 0], world: null });

  assert.ok(contraption.appliedForces.x > 30, `body +Z should rotate to world +X: F=(${contraption.appliedForces.x.toFixed(1)},${contraption.appliedForces.y.toFixed(1)},${contraption.appliedForces.z.toFixed(1)})`);
  assert.ok(Math.abs(contraption.appliedForces.z) < 1e-9, 'no unrotated component should remain');
});

test('applyLocalThrust follows an installed component localRotation', () => {
  const sideRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    -Math.PI / 2
  );
  const contraption = new Contraption(
    911,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene(),
    {
      childEntities: [{
        id: 'thruster',
        parentId: 'root',
        pivot: [1.5, 0.5, 0.5],
        localRotation: sideRotation.toArray(),
        blockKeys: [['1', '0', '0']]
      }]
    }
  ) as any;

  contraption.getChildScriptApi('thruster').applyLocalThrust([0, 40, 0]);

  assert.ok(contraption.appliedForces.x > 30, 'component +Y should follow the side-mounted +X axis');
  assert.ok(Math.abs(contraption.appliedForces.y) < 1e-9);
});

test('getBounds and setPivot update rotation center while blocks stay in place', () => {
  const contraption = new Contraption(
    92,
    [standardBlock(0), standardBlock(1), standardBlock(2), standardBlock(3)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  const arm = contraption.createChildEntity('root', new Set(['1,0,0', '2,0,0']), 'arm');
  const api = contraption.getChildScriptApi('arm');

  // getBounds returns entity-local bounds and center.
  const bounds = api.getBounds();
  assert.deepEqual(bounds.min, [1, 0, 0]);
  assert.deepEqual(bounds.max, [3, 1, 1]);
  assert.deepEqual(bounds.size, [2, 1, 1]);
  assert.deepEqual(bounds.center, [2, 0.5, 0.5]);
  assert.deepEqual(contraption.getNodeBlocksBounds('root').size, [4, 1, 1], 'root owns endpoint blocks at 0 and 3');

  // Capture block world position before the change.
  const block1 = contraption.blocks.find(b => b.localX === 1);
  const before = contraption.getBlockWorldCenter(block1);

  // Move pivot to (1.5,0.5,0.5); blocks should keep their world positions.
  api.setPivot([1.5, 0.5, 0.5]);
  assert.deepEqual(contraption.getNodeBlocksBounds('arm').center, [2, 0.5, 0.5], 'bounds should remain unchanged');
  const node = contraption.getEntityNode('arm');
  assert.deepEqual(node.pivotLocal.toArray(), [1.5, 0.5, 0.5], 'pivot should update');
  const after = contraption.getBlockWorldCenter(block1);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.z - after.z) < 1e-6,
    `setPivot should preserve block world position: before=(${before.x.toFixed(2)},${before.z.toFixed(2)}) after=(${after.x.toFixed(2)},${after.z.toFixed(2)})`);

  // Rotating after setPivot should move the block around the new center. setPivot
  // rebuilds, so reacquire the component API first.
  const apiAfterPivot = contraption.getChildScriptApi('arm');
  apiAfterPivot.setLocalSpin([0, 1, 0], 60);
  contraption.update(1 / 60, null, null);
  const outerBlock = contraption.blocks.find(b => b.localX === 2);
  const rotatedCenter = contraption.getBlockWorldCenter(outerBlock);
  const pivotWorld = contraption.entityLocalToWorld('arm', new THREE.Vector3(1.5, 0.5, 0.5));
  assert.ok(Math.abs(rotatedCenter.distanceTo(pivotWorld) - 1.0) < 0.01, 'block should rotate one unit from the new pivot');
});

test('ctx.blocks reports block changes like ctx.input even when bounds do not change', () => {
  const contraption = new Contraption(
    93,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;

  // A between-frame color edit must fire even though bounds do not change.
  contraption.notifyBlocksChanged('color', 'root', {
    cell: [1, 0, 0],
    size: 1,
    block: BlockTypes.COLOR_BLOCK,
    color: 0xabcdef,
    source: 'player',
    playerId: 'local'
  });
  contraption.setScript(`
self.state.p = ctx.blocks.pressed();
self.state.pColor = ctx.blocks.pressed('color');
self.state.pPlace = ctx.blocks.pressed('place');
self.state.ev = ctx.blocks.event();
`);
  contraption.update(1 / 60, null, { gravity: [0, -18, 0], world: null });
  const state = contraption.getComponentState('root');
  assert.equal(state.p, true, 'the current frame should detect a block change');
  assert.equal(state.pColor, true, 'change queries should filter by type');
  assert.equal(state.pPlace, false, 'other types should not match');
  assert.equal(state.ev.type, 'color');
  assert.equal(state.ev.nodeId, 'root');
  assert.equal(state.ev.blockCount, 2);
  assert.deepEqual(state.ev.cell, [1, 0, 0]);
  assert.equal(state.ev.color, 0xabcdef);
  assert.equal(state.ev.source, 'player');
  assert.equal(state.ev.playerId, 'local');

  // The edge-trigger clears on the next frame.
  contraption.update(1 / 60, null, { gravity: [0, -18, 0], world: null });
  assert.equal(state.p, false, 'the second frame should no longer report the edge');

  // Other event types.
  contraption.notifyBlocksChanged('subdivide', 'arm');
  contraption.update(1 / 60, null, { gravity: [0, -18, 0], world: null });
  assert.equal(state.p, true);
  assert.equal(state.pColor, false);
  assert.equal(state.ev.type, 'subdivide');

  // event() retains the most recent change, matching input snapshot semantics.
  contraption.update(1 / 60, null, { gravity: [0, -18, 0], world: null });
  assert.equal(state.ev.type, 'subdivide');
});

test('self.child is universal: any component can look up its direct children (chainable)', () => {
  const contraption = new Contraption(
    94,
    [standardBlock(0, 0, 0), standardBlock(0, 1, 0), standardBlock(0, 2, 0), standardBlock(2, 0, 0)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  contraption.createChildEntity('root', new Set(['0,1,0', '0,2,0']), 'arm');
  contraption.createChildEntity('arm', new Set(['0,2,0']), 'hand');
  contraption.createChildEntity('root', new Set(['2,0,0']), 'wing');
  const rootApi = contraption.getChildScriptApi('root');
  const armApi = contraption.getChildScriptApi('arm');
  const handApi = contraption.getChildScriptApi('hand');

  // root.child('arm') → arm and arm.child('hand') → hand.
  assert.equal(rootApi.child('arm'), armApi, 'root should find its direct child');
  assert.equal(armApi.child('hand'), handApi, 'a child should find its own direct child');
  assert.equal(rootApi.child('arm').child('hand'), handApi, 'child lookup should chain');

  // Relative lookup returns null for non-direct children.
  assert.equal(armApi.child('wing'), null, 'wing is not a direct child of arm');
  assert.equal(handApi.child('arm'), null, 'hand has no arm child');

  // IDs have no global meaning: a non-direct lookup returns null.
  assert.equal(handApi.child('root'), null);
});

test('V2 component voxel namespaces separate standard/micro edits and return structured results', () => {
  const contraption = new Contraption(
    960,
    [standardBlock(0), standardBlock(1), standardBlock(2)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  contraption.createChildEntity('root', new Set(['1,0,0', '2,0,0']), 'arm');

  let arm = contraption.getChildScriptApi('arm');
  const standardPlaced = arm.voxels.set([1, 0, 0], { color: 0xff3300 });
  assert.deepEqual(standardPlaced, { ok: true, placed: 1, reason: 'placed' });
  assert.ok(contraption.blocks.some(block =>
    block.entityId === 'arm' && (block.size || 1) === 1
    && block.localX === 3 && block.color === 0xff3300
  ));

  arm = contraption.getChildScriptApi('arm');
  assert.deepEqual(arm.voxels.set([1, 0, 0]), {
    ok: false,
    placed: 0,
    reason: 'occupied'
  });

  arm = contraption.getChildScriptApi('arm');
  const microPlaced = arm.microVoxels.set([2, 0, 0], [1, 1, 1], { r: 0, g: 255, b: 0 });
  assert.deepEqual(microPlaced, { ok: true, placed: 1, reason: 'placed' });
  assert.ok(contraption.blocks.some(block =>
    block.entityId === 'arm' && (block.size || 1) === 0.2
    && block.localX === 4.2 && block.localY === 0.2 && block.localZ === 0.2
    && block.color === 0x00ff00
  ));

  arm = contraption.getChildScriptApi('arm');
  assert.deepEqual(arm.voxels.clear([1, 0, 0]), {
    ok: true,
    removed: 1,
    reason: 'removed'
  });
  arm = contraption.getChildScriptApi('arm');
  assert.deepEqual(arm.microVoxels.clear([2, 0, 0], [1, 1, 1]), {
    ok: true,
    removed: 1,
    reason: 'removed'
  });
});

test('component seats are pivot-relative and nearest-seat lookup follows articulated transforms', () => {
  const contraption = new Contraption(
    98,
    [standardBlock(0), { ...standardBlock(1), entityId: 'arm' }],
    new THREE.Vector3(10, 20, 30),
    new THREE.Scene(),
    {
      seats: [{ position: [1, 0, 0] }],
      childEntities: [{
        id: 'arm',
        parentId: 'root',
        pivot: [1.5, 0.5, 0.5],
        seats: [{ position: [0, 1, 0] }, { position: [2, 0, 0] }]
      }]
    }
  ) as any;

  assert.equal(contraption.getComponentSeats('root').length, 1);
  assert.equal(contraption.getComponentSeats('arm').length, 2);
  const rootSeat = contraption.getSeatWorldPosition('root', 0);
  assert.ok(rootSeat?.isVector3);

  const armSeat = contraption.getSeatWorldPosition('arm', 1);
  const nearest = contraption.getNearestSeat(armSeat.clone().add(new THREE.Vector3(0.05, 0, 0)));
  assert.equal(nearest.componentId, 'arm');
  assert.equal(nearest.seatIndex, 1);

  contraption.getEntityNode('arm').localQuaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
  contraption.getEntityNode('arm').group.quaternion.copy(contraption.getEntityNode('arm').localQuaternion);
  contraption.updateTransform();
  const rotatedSeat = contraption.getSeatWorldPosition('arm', 1);
  assert.ok(rotatedSeat.distanceTo(armSeat) > 0.5, 'child seats must follow the component transform');

  const slot = contraption.serializeSubtree('root');
  assert.deepEqual(slot.seats, [{ position: [1, 0, 0] }]);
  assert.deepEqual(slot.childEntities[0].seats, [
    { position: [0, 1, 0] },
    { position: [2, 0, 0] }
  ]);
});
test('ctx.players provides multiplayer-ready frozen id and position snapshots', () => {
  const contraption = new Contraption(
    99,
    [standardBlock(0), standardBlock(1)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  contraption.setScript(`
self.state.players = ctx.players;
self.state.playersLen = ctx.players.length;
`);

  // No players produces an empty array.
  contraption.update(1 / 60, null, { gravity: [0, -18, 0], world: null });
  const state = contraption.getComponentState('root');
  assert.equal(state.playersLen, 0, 'no players should produce an empty array');
  assert.deepEqual(state.players, [], 'player list should be empty');

  // Multiple players use {id, position, mass} records.
  contraption.update(1 / 60, null, {
    gravity: [0, -18, 0],
    world: null,
    players: [
      {
        id: 'local',
        position: [1, 2, 3],
        feetPosition: [1, 0.38, 3],
        velocity: [4, 5, 6],
        yaw: 0.5,
        pitch: -0.25,
        isLocal: true,
        isOnGround: true,
        isFlying: false,
        isCrouching: true,
        isSprinting: false,
        isInWater: false,
        ridingEntityId: 'ent-platform',
        ridingBodyId: 'deck'
      },
      { id: 'p2', position: [10, 20, 30], mass: 75 }
    ]
  });
  const players = state.players;
  assert.equal(players.length, 2, 'two players should be present');
  assert.equal(players[0].id, 'local');
  assert.deepEqual(players[0].position, [1, 2, 3]);
  assert.deepEqual(players[0].eyePosition, [1, 2, 3]);
  assert.deepEqual(players[0].feetPosition, [1, 0.38, 3]);
  assert.deepEqual(players[0].velocity, [4, 5, 6]);
  assert.equal(players[0].yaw, 0.5);
  assert.equal(players[0].pitch, -0.25);
  assert.equal(players[0].isLocal, true);
  assert.equal(players[0].isOnGround, true);
  assert.equal(players[0].isCrouching, true);
  assert.equal(players[0].ridingEntityId, 'ent-platform');
  assert.equal(players[0].ridingBodyId, 'deck');
  assert.equal(players[0].mass, 50, 'missing mass should use the fixed player default');
  assert.equal(players[1].id, 'p2');
  assert.deepEqual(players[1].position, [10, 20, 30]);
  assert.equal(players[1].mass, 75, 'an explicit valid runtime mass should be preserved');
  assert.equal(Object.isFrozen(players[0]), true, 'player records should be frozen');
  assert.equal(Object.isFrozen(players[0].position), true, 'snapshot positions should be frozen');
  assert.equal(Object.isFrozen(players[0].velocity), true, 'optional snapshot vectors should be frozen');

  // Tolerate missing id or position.
  contraption.update(1 / 60, null, { gravity: [0, -18, 0], world: null, players: [{ position: [5, 6, 7], mass: -1 }] });
  const fallback = state.players;
  assert.equal(fallback[0].id, 'player', 'missing id should use the default');
  assert.equal(fallback[0].mass, 50, 'invalid mass should use the fixed player default');
});

test('ctx.entityId exposes the same stable random id shown by entity queries', () => {
  const contraption = new Contraption(
    404,
    [standardBlock(0)],
    new THREE.Vector3(),
    new THREE.Scene()
  ) as any;
  contraption.setScript('self.state.seenEntityId = ctx.entityId;');
  contraption.update(1 / 60, null, null);

  assert.equal(contraption.getComponentState('root').seenEntityId, contraption.publicId);
});

test('world API supports color reads, raycast metadata, nearby entities, and building', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  // Create one ground block and explicitly clear test cells that generated terrain may fill.
  world.setBlock(5, 1, 5, BlockTypes.COLOR_BLOCK, true, 0x3366ff);
  world.setBlock(6, 1, 5, BlockTypes.AIR, true);
  world.setBlock(7, 1, 5, BlockTypes.AIR, true);
  world.setBlock(8, 1, 8, BlockTypes.AIR, true);
  const api = manager.scriptWorldApi;
  assert.equal(api.apiVersion, 2);
  assert.equal(api.getBlock, undefined);
  assert.equal(api.setBlock, undefined);
  assert.equal(api.placeBlock, undefined);

  // Standard voxel reads return {block, color}.
  const info = api.voxels.get([5, 1, 5]);
  assert.equal(info.block, BlockTypes.COLOR_BLOCK);
  assert.equal(info.color, 0x3366ff, 'color should be readable');
  assert.equal(api.voxels.get([8, 1, 8]).block, BlockTypes.AIR, 'air should be reported');

  // The micro namespace reads exact 0.2-unit cells.
  world.setBlock(9, 0, 0, BlockTypes.AIR, true); // Clear generated terrain.
  world.setMicroBlock(9 * 5 + 1, 1, 1, 0xabcdef); // Microcell (1,1,1) in cell 9.
  const micro = api.microVoxels.get([9, 0, 0], [1, 1, 1]);
  assert.equal(micro.block, 1, 'microblock should exist');
  assert.equal(micro.color, 0xabcdef, 'microblock color should match');
  assert.equal('size' in micro, false, 'result should contain no extra size field');
  assert.equal(api.microVoxels.get([9, 0, 0], [2, 1, 1]).block, 0, 'an empty microcell should report air');

  const microHit = api.raycast([8.5, 0.3, 0.3], [1, 0, 0], {
    maxDistance: 2,
    include: 'world',
    voxelKinds: ['micro']
  });
  assert.equal(microHit.kind, 'world');
  assert.equal(microHit.voxelKind, 'micro');
  assert.equal(microHit.color, 0xabcdef);

  // Raycast from the side and include color plus normal metadata.
  const hit = api.raycast([6.5, 1.5, 5.5], [-1, 0, 0], 3);
  assert.ok(hit, 'ray should hit');
  assert.equal(hit.block, BlockTypes.COLOR_BLOCK);
  assert.equal(hit.color, 0x3366ff, 'hit color should match');
  assert.deepEqual(hit.normal, [1, 0, 0], 'a left-face hit should have +X normal');

  // Nearby entity sensing sorts by distance.
  const c1 = new Contraption(1, [{ localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(10, 0, 10), scene) as any;
  const c2 = new Contraption(2, [{ localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(12, 0, 10), scene) as any;
  const c3 = new Contraption(3, [{ localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK }], new THREE.Vector3(32, 0, 10), scene) as any;
  manager.contraptions.push(c1, c2, c3);
  assert.match(c1.publicId, /^ent_[0-9a-f-]{36}$/);
  assert.notEqual(c1.publicId, c2.publicId, 'every entity should receive an independent random id');
  const nearby = api.entities([10, 0, 10], 5);
  assert.equal(nearby.length, 2, 'two entities should lie within the radius');
  assert.equal(nearby[0].id, c1.publicId, 'public query id should be the random entity id');
  assert.equal(nearby[0].runtimeId, 1, 'internal runtime id remains available for diagnostics');
  assert.equal(nearby[0].chunkId, '0,0');
  assert.deepEqual(nearby[0].rotation, c1.quaternion.toArray());
  assert.deepEqual(nearby[0].velocity, c1.velocity.toArray());
  assert.deepEqual(nearby[0].angularVelocity, c1.angularVelocity.toArray());
  assert.equal(nearby[0].mass, c1.mass);
  assert.equal(nearby[0].boundingRadius, c1.boundingRadius);
  assert.equal(nearby[0].collisionEnabled, true);
  assert.equal(nearby[0].componentCount, 1);
  assert.deepEqual(nearby[0].bounds.size, c1.size.toArray());
  // Entity position includes localCenter; c2 is at (12.5,0.5,10.5).
  const expected = Math.sqrt(2.5 * 2.5 + 0.5 * 0.5 + 0.5 * 0.5);
  assert.ok(Math.abs(nearby[1].distance - expected) < 1e-6, 'distance should be correct');
  assert.equal(api.entities([10, 0, 10], 1).length, 1, 'radius filtering should work');

  const entityHit = api.raycast([8, 0.5, 10.5], [1, 0, 0], {
    maxDistance: 5,
    include: 'entities',
    voxelKinds: ['standard', 'micro']
  });
  assert.equal(entityHit.kind, 'entity');
  assert.equal(entityHit.entityId, c1.publicId);
  assert.equal(entityHit.nodeId, c1.rootComponentId);
  assert.equal(entityHit.voxelKind, 'standard');

  const seamEntity = new Contraption(
    4,
    [{ localX: 0, localY: 0, localZ: 0, size: 1, block: BlockTypes.COLOR_BLOCK }],
    new THREE.Vector3(16382, 0, 0),
    scene
  ) as any;
  manager.contraptions.push(seamEntity);
  const acrossSeam = api.entities([0.5, 0.5, 0.5], 3);
  assert.equal(acrossSeam.length, 1, 'radius query should cross the torus X seam');
  assert.equal(acrossSeam[0].id, seamEntity.publicId);
  assert.equal(acrossSeam[0].distance, 2);

  // Random-id lookup and chunk lists use the same frozen descriptor shape.
  const byId = api.entities.get(c1.publicId, '0,0');
  assert.equal(byId.id, c1.publicId);
  assert.equal(byId.runtimeId, 1);
  assert.equal(api.entities.get(c1.publicId, '2,0'), null, 'optional chunk guard should reject a mismatch');
  assert.equal(api.entities.get(c3.publicId, '2,0').chunkId, '2,0');
  const chunkZero = api.entities.list('0,0');
  assert.deepEqual(new Set(chunkZero.map(entity => entity.id)), new Set([c1.publicId, c2.publicId]));
  assert.equal(api.entities.inChunk, api.entities.list, 'inChunk should alias list');
  assert.equal(api.entities.list([2, 0])[0].id, c3.publicId);
  assert.deepEqual(api.entities.list('invalid'), []);
  assert.equal(Object.isFrozen(chunkZero), true);
  assert.equal(Object.isFrozen(byId.position), true);

  // Standard and micro namespaces return structured results.
  world.setBlock(10, 1, 5, BlockTypes.AIR, true);
  world.setBlock(11, 1, 5, BlockTypes.AIR, true);
  assert.deepEqual(api.voxels.set([10, 1, 5], { color: 0xaa5500 }), {
    ok: true,
    placed: 1,
    reason: 'placed'
  });
  assert.equal(api.voxels.get([10, 1, 5]).color, 0xaa5500);
  assert.deepEqual(api.microVoxels.set([11, 1, 5], [1, 1, 1], { color: 0x00aaff }), {
    ok: true,
    placed: 1,
    reason: 'placed'
  });
  assert.equal(api.microVoxels.get([11, 1, 5], [1, 1, 1]).color, 0x00aaff);

  // V2 never overwrites a micro cell or replaces micro geometry with a standard voxel.
  assert.deepEqual(api.microVoxels.set([11, 1, 5], [1, 1, 1], { color: 0xff00ff }), {
    ok: false,
    placed: 0,
    reason: 'occupied'
  });
  assert.equal(api.microVoxels.get([11, 1, 5], [1, 1, 1]).color, 0x00aaff);
  assert.deepEqual(api.voxels.set([11, 1, 5], { color: 0xff00ff }), {
    ok: false,
    placed: 0,
    reason: 'occupied'
  });
  assert.deepEqual(api.voxels.clear([10, 1, 5]), {
    ok: true,
    removed: 1,
    reason: 'removed'
  });
  assert.equal(api.voxels.get([10, 1, 5]).block, BlockTypes.AIR);
  assert.deepEqual(api.microVoxels.clear([11, 1, 5], [1, 1, 1]), {
    ok: true,
    removed: 1,
    reason: 'removed'
  });
  assert.equal(api.microVoxels.get([11, 1, 5], [1, 1, 1]).block, BlockTypes.AIR);
});

test('ctx.world uses separate standard and micro voxel read namespaces', () => {
  const scene = new THREE.Scene();
  const world = new World(scene) as any;
  const manager = new ContraptionManager(scene, world, null, null) as any;
  const api = manager.scriptWorldApi;

  // Place a microblock using an integer microcell index.
  world.setBlock(3, 0, 0, BlockTypes.AIR, true); // Clear generated terrain.
  world.setMicroBlock(3 * 5 + 1, 1, 1, 0xabcdef); // Microcell (1,1,1) in cell 3.

  const micro = api.microVoxels.get([3, 0, 0], [1, 1, 1]);
  assert.equal(micro.block, 1, 'microblock should exist');
  assert.equal(micro.color, 0xabcdef, 'microblock color should match');
  assert.equal(api.microVoxels.get([3, 0, 0], [2, 1, 1]).block, 0, 'a neighboring empty microcell should report air');

  // Standard block queries remain unchanged.
  world.setBlock(5, 1, 5, BlockTypes.COLOR_BLOCK, true, 0x3366ff);
  const std = api.voxels.get([5, 1, 5]);
  assert.equal(std.block, 1);
  assert.equal(std.color, 0x3366ff);
});

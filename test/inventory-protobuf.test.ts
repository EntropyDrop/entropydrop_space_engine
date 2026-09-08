import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Backpack } from '../src/generated/backpack.ts';
import { InventoryResource } from '../src/generated/inventory.ts';
import {
  BACKPACK_PROTO_SOURCE_SHA256,
  INVENTORY_PROTO_SOURCE_SHA256,
} from '../src/generated/inventory_descriptor.ts';
import {
  decodeBackpack,
  decodeInventoryResource,
  encodeBackpack,
  encodeInventoryResource,
  inventoryResourcePreviewItem,
  portableEntityToRuntime,
  runtimeEntityToPortable,
} from '../src/storage/InventoryProtobuf.ts';


const CROSS_LANGUAGE_BLOCKSET_HEX = '080652150a0543726f7373120c08011004209d012d34ab1200';
const CROSS_LANGUAGE_CANONICAL_ENTITY_HEX = '08065a5a122c0a05776f726c641a0022052d0100000042070a01421a020801420a0a04726f6f741a02080162054f726465721a0f0a014122014261cdccccccccccec3f1a190a017a1a05776f726c642204726f6f7461cdccccccccccec3f';

test('checked-in protobuf bindings and descriptor match the source schema', () => {
  const inventory = readFileSync(new URL('../proto/inventory.proto', import.meta.url));
  const backpack = readFileSync(new URL('../proto/backpack.proto', import.meta.url));
  assert.equal(createHash('sha256').update(inventory).digest('hex'), INVENTORY_PROTO_SOURCE_SHA256);
  assert.equal(createHash('sha256').update(backpack).digest('hex'), BACKPACK_PROTO_SOURCE_SHA256);
});

test('inventory Protobuf has the same deterministic wire bytes as the backend codec', () => {
  const encoded = encodeInventoryResource('blockset', {
    type: 'space-blockset',
    version: 6,
    name: 'Cross',
    blocks: [{ dx: -1, dy: 2, dz: 0, mx: 4, my: 3, mz: 2, color: 0x12ab34 }],
  });
  assert.equal(Buffer.from(encoded).toString('hex'), CROSS_LANGUAGE_BLOCKSET_HEX);
  const decoded = decodeInventoryResource(Buffer.from(CROSS_LANGUAGE_BLOCKSET_HEX, 'hex'));
  assert.equal(decoded.category, 'blockset');
  assert.deepEqual(decoded.portable.blocks[0], {
    dx: -1, dy: 2, dz: 0, mx: 4, my: 3, mz: 2, block: 1, color: 0x12ab34,
  });
});

test('inventory encoder accepts only portable v6 resource shapes', () => {
  assert.throws(() => encodeInventoryResource('blockset', {
    type: 'space-blockset', version: 4, name: 'old', blocks: [],
  }), /space-blockset v6/i);
  assert.throws(() => encodeInventoryResource('colorset', {
    type: 'space-colorset', version: 4, name: 'old', colors: [],
  }), /space-colorset v6/i);
  assert.throws(() => encodeInventoryResource('entity', {
    type: 'space-entity', version: 4, root: { name: 'old' }, constraints: [],
  }), /space-entity v6/i);
  assert.throws(() => encodeInventoryResource('entity', {
    type: 'space-entity', version: 6, name: 'obsolete', root: {}, constraints: [],
  }), /root.name/);
});

test('inventory encoding uses the backend canonical ordering at every resource boundary', () => {
  const blockSet = decodeInventoryResource(encodeInventoryResource('blockset', {
    type: 'space-blockset',
    version: 6,
    name: 'Order',
    blocks: [
      { dx: 0, dy: 0, dz: 0, mx: 1, my: 0, mz: 0, color: 3 },
      { dx: 0, dy: 0, dz: 0, color: 2 },
      { dx: 0, dy: 0, dz: 0, mx: 0, my: 4, mz: 4, color: 1 },
    ],
  })).portable;
  assert.deepEqual(blockSet.blocks.map((block: any) => [
    block.mx ?? -1, block.my ?? -1, block.mz ?? -1, block.color,
  ]), [
    [-1, -1, -1, 2],
    [0, 4, 4, 1],
    [1, 0, 0, 3],
  ]);

  const portableEntity: any = {
    type: 'space-entity',
    version: 6,
    root: {
      name: 'Order',
      id: 'world',
      body: { type: 'dynamic' },
      blocks: [{ dx: 0, dy: 0, dz: 0, color: 1 }],
      seats: [],
      children: [
        { id: 'root', body: { type: 'kinematic' }, blocks: [], seats: [], children: [] },
        { id: 'B', body: { type: 'kinematic' }, blocks: [], seats: [], children: [] },
      ],
    },
    constraints: [
      { id: 'z', type: 'point', bodyA: 'world', bodyB: 'root', stiffness: 0.9 },
      { id: 'A', type: 'point', bodyA: null, bodyB: 'B', stiffness: 0.9 },
    ],
  };
  const entity = encodeInventoryResource('entity', portableEntity);
  assert.equal(Buffer.from(entity).toString('hex'), CROSS_LANGUAGE_CANONICAL_ENTITY_HEX);

  const omittedBodyA = {
    ...portableEntity,
    constraints: portableEntity.constraints.map((constraint: any) => {
      if (constraint.bodyA !== null) return constraint;
      const { bodyA: _bodyA, ...withoutBodyA } = constraint;
      return withoutBodyA;
    }),
  };
  assert.equal(
    Buffer.from(encodeInventoryResource('entity', omittedBodyA)).toString('hex'),
    CROSS_LANGUAGE_CANONICAL_ENTITY_HEX,
    'omitted and null bodyA must share the backend canonical external-world encoding',
  );
});

test('entity decoding makes sibling and constraint wire order non-semantic', () => {
  const encoded = InventoryResource.encode({
    schemaVersion: 6,
    content: {
      $case: 'entity',
      value: {

        root: {
          name: 'Order',
          id: 'world',
          body: { type: 0 },
          blocks: [],
          seats: [],
          children: [
            {
              id: 'root', body: { type: 1 }, blocks: [], seats: [],
              children: [
                { id: 'z', body: { type: 1 }, blocks: [], seats: [], children: [] },
                { id: 'A', body: { type: 1 }, blocks: [], seats: [], children: [] },
              ],
            },
            { id: 'B', body: { type: 1 }, blocks: [], seats: [], children: [] },
          ],
        },
        constraints: [
          { id: 'z', type: 0, bodyAComponentId: 'world', bodyBComponentId: 'root', stiffness: 0.9 },
          { id: 'A', type: 0, bodyAComponentId: undefined, bodyBComponentId: 'B', stiffness: 0.9 },
        ],
      },
    },
  }).finish();

  const decoded = decodeInventoryResource(encoded).portable;
  assert.deepEqual(decoded.root.children.map((child: any) => child.id), ['B', 'root']);
  assert.deepEqual(
    decoded.root.children.find((child: any) => child.id === 'root').children.map((child: any) => child.id),
    ['A', 'z'],
  );
  assert.deepEqual(decoded.constraints.map((constraint: any) => constraint.id), ['A', 'z']);
  assert.equal(decoded.constraints[0].bodyA, null);
  assert.equal(decoded.constraints[1].bodyA, 'world');
});

test('entity runtime adapters preserve arbitrary component ids without hierarchy kind metadata', () => {
  const portable = runtimeEntityToPortable({
    name: 'Arbitrary ids',
    rootComponentId: 'world',
    blocks: [
      { dx: 0, dy: 0, dz: 0, color: 1, entityId: 'world' },
      { dx: 1, dy: 0, dz: 0, color: 2, entityId: 'root' },
    ],
    childEntities: [{
      id: 'root',
      parentId: 'world',
      kind: 'bearing',
      bodyType: 'kinematic',
      seats: [],
    }],
    scripts: [],
    enabled: [],
    constraints: [
      { id: 'external', type: 'point', bodyA: null, bodyB: 'world', stiffness: 0.9 },
      { id: 'external_omitted', type: 'point', bodyB: 'world', stiffness: 0.9 },
      { id: 'components', type: 'point', bodyA: 'world', bodyB: 'root', stiffness: 0.9 },
    ],
  });

  assert.equal(portable.root.id, 'world');
  assert.equal(portable.root.children[0].id, 'root');
  assert.equal(Object.hasOwn(portable.root.children[0], 'kind'), false);
  const runtime = portableEntityToRuntime(portable);
  assert.equal(runtime.rootComponentId, 'world');
  assert.deepEqual(runtime.constraints.map((constraint: any) => constraint.bodyA), ['world', null, null]);
  assert.equal(
    Object.hasOwn(runtime.childEntities[0], 'kind'),
    false,
    'portable decoding must not recreate legacy hierarchy kind metadata'
  );
});

test('runtime-to-portable projection drops legacy and unknown in-memory fields', () => {
  const portable = runtimeEntityToPortable({
    name: 'Projected',
    rootComponentId: 'alpha',
    blocks: [{
      dx: -0,
      dy: 2,
      dz: 3,
      mx: 4,
      my: 1,
      mz: 0,
      block: 99,
      color: 0x123456,
      entityId: 'alpha',
      part: 'legacy-part',
      index: 7,
      kind: 'legacy',
      rootId: 'legacy-root',
      bodyAIsWorld: true,
      body_a_is_world: true,
      body_a: 'legacy-a',
      body_b: 'legacy-b',
      unknown: 'drop-me',
    }],
    childEntities: [],
    scripts: [],
    enabled: [],
    constraints: [{
      id: 'joint',
      type: 'hinge',
      bodyA: null,
      bodyB: 'alpha',
      anchorA: null,
      axisA: [1, -0, 0],
      limits: { min: -1, max: 1, index: 4, unknown: true },
      stiffness: 0.5,
      collideConnected: true,
      index: 8,
      kind: 'legacy',
      rootId: 'legacy-root',
      bodyAIsWorld: true,
      body_a_is_world: true,
      body_a: 'legacy-a',
      body_b: 'legacy-b',
      unknown: 'drop-me',
    }],
    index: 9,
    kind: 'legacy',
    rootId: 'legacy-root',
    unknown: 'drop-me',
  });

  assert.deepEqual(Object.keys(portable).sort(), ['constraints', 'root', 'type', 'version']);
  assert.equal(portable.root.name, 'Projected');
  assert.deepEqual(portable.root.blocks, [{
    dx: 0,
    dy: 2,
    dz: 3,
    block: 1,
    color: 0x123456,
    mx: 4,
    my: 1,
    mz: 0,
  }]);
  assert.deepEqual(portable.constraints, [{
    id: 'joint',
    type: 'hinge',
    bodyA: null,
    bodyB: 'alpha',
    axisA: [1, 0, 0],
    limits: { min: -1, max: 1 },
    stiffness: 0.5,
    collideConnected: true,
  }]);
});

test('portable-to-runtime projection drops legacy aliases and arbitrary fields', () => {
  const runtime = portableEntityToRuntime({
    type: 'space-entity',
    version: 6,
    root: {
      name: 'Projected',
      id: 'alpha',
      body: { type: 'dynamic', unknown: 'drop-me' },
      blocks: [{
        dx: 1,
        dy: 2,
        dz: 3,
        block: 99,
        color: 0xabcdef,
        index: 1,
        kind: 'legacy',
        rootId: 'legacy-root',
        bodyAIsWorld: true,
        body_a_is_world: true,
        body_a: 'legacy-a',
        body_b: 'legacy-b',
        unknown: 'drop-me',
      }],
      seats: [],
      children: [],
      index: 2,
      kind: 'legacy',
      rootId: 'legacy-root',
      unknown: 'drop-me',
    },
    constraints: [{
      id: 'joint',
      type: 'point',
      bodyA: null,
      bodyB: 'alpha',
      anchorA: null,
      limits: null,
      stiffness: 0.9,
      index: 3,
      kind: 'legacy',
      rootId: 'legacy-root',
      bodyAIsWorld: true,
      body_a_is_world: true,
      body_a: 'legacy-a',
      body_b: 'legacy-b',
      unknown: 'drop-me',
    }],
    index: 4,
    kind: 'legacy',
    rootId: 'legacy-root',
    unknown: 'drop-me',
  });

  assert.equal(runtime.rootComponentId, 'alpha');
  assert.deepEqual(runtime.blocks, [{
    dx: 1,
    dy: 2,
    dz: 3,
    block: 1,
    color: 0xabcdef,
    entityId: 'alpha',
  }]);
  assert.deepEqual(runtime.constraints, [{
    id: 'joint',
    type: 'point',
    bodyA: null,
    bodyB: 'alpha',
    stiffness: 0.9,
    collideConnected: false,
  }]);
  for (const legacy of ['index', 'kind', 'rootId', 'unknown']) {
    assert.equal(Object.hasOwn(runtime, legacy), false, `${legacy} must not escape the adapter`);
  }
});

test('oneof decoding follows protobuf last-member-wins semantics', () => {
  const blockSetThenEntity = Buffer.from(
    '0806520a0a014212052d010000005a140a0145120f0a04726f6f741a0022052d01000000',
    'hex',
  );
  const message = InventoryResource.decode(blockSetThenEntity);
  assert.equal(message.content?.$case, 'entity');
  assert.equal(decodeInventoryResource(blockSetThenEntity).category, 'entity');
});

test('descriptor-driven decoding matches standard protobuf merge and invalid-wire semantics', () => {
  const splitBlockSet = Buffer.from('080652030a0142520412020801', 'hex');
  const merged = decodeInventoryResource(splitBlockSet);
  assert.equal(merged.category, 'blockset');
  assert.equal(merged.portable.name, 'B');
  assert.equal(merged.portable.blocks.length, 1);
  assert.equal(merged.portable.blocks[0].dx, -1);

  const tagZeroTrailingData = Buffer.from(
    `${CROSS_LANGUAGE_BLOCKSET_HEX}00deadbeef`,
    'hex',
  );
  assert.throws(() => decodeInventoryResource(tagZeroTrailingData), /illegal tag/i);
  assert.throws(
    () => decodeInventoryResource(Buffer.from('080352070a01ff12020801', 'hex')),
    /utf-8/i,
  );
  assert.throws(
    () => decodeInventoryResource(Buffer.from(
      '08065a160a014512110a04726f6f741a0022052d010000003a00',
      'hex',
    )),
    /seat without a position/i,
  );

  assert.throws(
    () => decodeInventoryResource(Buffer.from('090352050a01781200', 'hex')),
    /expected inventory protobuf v6/i,
  );
  const wrongWireThenValid = Buffer.from(
    `090000000000000000${CROSS_LANGUAGE_BLOCKSET_HEX}`,
    'hex',
  );
  assert.equal(decodeInventoryResource(wrongWireThenValid).portable.name, 'Cross');
  assert.equal(
    decodeInventoryResource(Buffer.from('080652005001', 'hex')).category,
    'blockset',
  );

  const bomRoot = decodeInventoryResource(Buffer.from(
    '08065a120a0178120d0a07efbbbf726f6f741a002200',
    'hex',
  ));
  assert.equal(bomRoot.portable.root.id, '\ufeffroot');
});

test('canonical encoding normalizes negative zero while retaining optional field presence', () => {
  const negativeZero = {
    type: 'space-entity',
    version: 6,
    root: {
      name: 'Zero',
      id: 'world',
      pivot: [-0, -0, -0],
      anchorRotation: [-0, -0, -0, 1],
      body: { type: 'dynamic', mass: -0, restitution: -0, friction: -0 },
      blocks: [{ dx: 0, dy: 0, dz: 0, color: 1 }],
      seats: [{ position: [-0, -0, -0] }],
      children: [{
        id: 'arm',
        pivot: [-0, -0, -0],
        localPosition: [-0, -0, -0],
        localRotation: [-0, -0, -0, 1],
        anchorRotation: [-0, -0, -0, 1],
        body: { type: 'kinematic', mass: -0, restitution: -0, friction: -0 },
        blocks: [],
        seats: [],
        children: [],
      }],
    },
    constraints: [{
      id: 'joint',
      type: 'point',
      bodyA: null,
      bodyB: 'world',
      anchorA: [-0, -0, -0],
      anchorB: [-0, -0, -0],
      axisA: [-0, -0, -0],
      axisB: [-0, -0, -0],
      referenceA: [-0, -0, -0],
      referenceB: [-0, -0, -0],
      limits: { min: -0, max: -0 },
      stiffness: -0,
    }],
  };
  const negativeBytes = encodeInventoryResource('entity', negativeZero);
  const positiveBytes = encodeInventoryResource(
    'entity',
    JSON.parse(JSON.stringify(negativeZero)),
  );
  assert.deepEqual(negativeBytes, positiveBytes);

  const decoded = decodeInventoryResource(negativeBytes).portable;
  for (const value of [
    ...decoded.root.pivot,
    ...decoded.root.anchorRotation,
    ...decoded.root.seats[0].position,
    ...decoded.root.children[0].pivot,
    ...decoded.root.children[0].localPosition,
    ...decoded.root.children[0].localRotation,
    ...decoded.root.children[0].anchorRotation,
    ...decoded.constraints[0].anchorA,
    ...decoded.constraints[0].anchorB,
    ...decoded.constraints[0].axisA,
    ...decoded.constraints[0].axisB,
    ...decoded.constraints[0].referenceA,
    ...decoded.constraints[0].referenceB,
    decoded.root.body.mass,
    decoded.root.body.restitution,
    decoded.root.body.friction,
    decoded.root.children[0].body.mass,
    decoded.root.children[0].body.restitution,
    decoded.root.children[0].body.friction,
    decoded.constraints[0].limits.min,
    decoded.constraints[0].limits.max,
    decoded.constraints[0].stiffness,
  ]) assert.equal(Object.is(value, -0), false);
  assert.equal(Object.hasOwn(decoded.root.body, 'mass'), true);
  assert.equal(Object.hasOwn(decoded.root.body, 'restitution'), true);
  assert.equal(Object.hasOwn(decoded.root.body, 'friction'), true);
});

test('backpack decoder rejects a resource placed in the wrong category group', () => {
  const colorSet = InventoryResource.decode(encodeInventoryResource('colorset', {
    type: 'space-colorset',
    version: 6,
    name: 'Palette',
    colors: new Array(9).fill('#123456'),
  }));
  const encoded = Backpack.encode({
    schemaVersion: 7,
    activeCategory: 0,
    blockSets: { selected: 0, slots: [{ resource: colorSet }] },
    entities: undefined,
    colorSets: undefined,
  }).finish();
  assert.throws(() => decodeBackpack(encoded), /blockset group contains a colorset/);
});

test('backpack v7 positional wrappers preserve sparse slots and reject older schemas', () => {
  const currentBytes = encodeBackpack({
    activeCategory: 'blockset',
    categories: {
      blockset: {
        selected: 5,
        items: [
          { type: 'space-blockset', version: 6, name: 'First', blocks: [{ dx: 0, dy: 0, dz: 0, color: 1 }] },
          null, null, null, null,
          { type: 'space-blockset', version: 6, name: 'Sixth', blocks: [{ dx: 1, dy: 0, dz: 0, color: 2 }] },
        ],
      },
      entity: { selected: 0, items: [] },
      colorset: { selected: 0, items: [] },
    },
  });
  const currentMessage = Backpack.decode(currentBytes);
  assert.equal(currentMessage.schemaVersion, 7);
  assert.equal(currentMessage.blockSets?.slots?.length, 6);
  assert.equal('index' in currentMessage.blockSets!.slots![0], false);
  assert.equal(currentMessage.blockSets?.slots?.[1].resource, undefined);

  const current = decodeBackpack(currentBytes);
  assert.equal(current.sourceSchemaVersion, 7);
  assert.equal(current.categories.blockset.items[0].name, 'First');
  assert.equal(current.categories.blockset.items[1], null);
  assert.equal(current.categories.blockset.items[5].name, 'Sixth');
  assert.equal(current.categories.blockset.selected, 5);

  const oldVersion = Backpack.encode({ schemaVersion: 6 }).finish();
  assert.throws(() => decodeBackpack(oldVersion), /expected backpack protobuf v7/i);
});

test('market preview conversion preserves full resources and expands micro voxel coordinates', () => {
  const blockSet = inventoryResourcePreviewItem('blockset', {
    type: 'space-blockset',
    version: 6,
    name: 'Micro',
    blocks: [{
      dx: 2,
      dy: -1,
      dz: 4,
      mx: 3,
      my: 2,
      mz: 1,
      block: 99,
      color: 0x123456,
      index: 1,
      kind: 'legacy-block',
      rootId: 'legacy-root',
      body_a: 'legacy-a',
      unknown: 'drop-me',
    }],
    index: 2,
    kind: 'legacy-resource',
    rootId: 'legacy-root',
    unknown: 'drop-me',
  });
  assert.deepEqual(blockSet, {
    type: 'space-blockset',
    version: 6,
    name: 'Micro',
    kind: 'blockset',
    blockCount: 1,
    blocks: [{
      dx: 2.375,
      dy: -0.75,
      dz: 4.125,
      size: 0.125,
      block: 1,
      color: 0x123456,
      mx: 3,
      my: 2,
      mz: 1,
    }],
  });

  const colorSet = inventoryResourcePreviewItem('colorset', {
    type: 'space-colorset',
    version: 6,
    name: 'Nine',
    colors: ['#000000', '#111111'],
    index: 3,
    kind: 'legacy-resource',
    rootId: 'legacy-root',
    unknown: 'drop-me',
  });
  assert.deepEqual(colorSet, {
    type: 'space-colorset',
    version: 6,
    name: 'Nine',
    kind: 'colorset',
    colors: ['#000000', '#111111'],
  });

  const entity = inventoryResourcePreviewItem('entity', {
    type: 'space-entity',
    version: 6,
    root: {
      name: 'Arm',
      id: 'world', body: { type: 'dynamic', unknown: 'drop-me' }, blocks: [], seats: [], children: [{
        id: 'root', pivot: [1, 2, 3], body: { type: 'kinematic', unknown: 'drop-me' },
        blocks: [{
          dx: 1,
          dy: 2,
          dz: 3,
          block: 99,
          color: 0xabcdef,
          index: 4,
          kind: 'legacy-block',
          rootId: 'legacy-root',
          body_a_is_world: true,
          body_b: 'legacy-b',
          unknown: 'drop-me',
        }],
        seats: [], children: [], index: 5, kind: 'legacy-component', unknown: 'drop-me',
      }],
      index: 6,
      kind: 'legacy-component',
      unknown: 'drop-me',
    },
    constraints: [{
      id: 'joint',
      type: 'point',
      bodyA: null,
      bodyB: 'root',
      stiffness: 0.9,
      index: 7,
      kind: 'legacy-constraint',
      rootId: 'legacy-root',
      bodyAIsWorld: true,
      body_a_is_world: true,
      body_a: 'legacy-a',
      body_b: 'legacy-b',
      unknown: 'drop-me',
    }],
    index: 8,
    kind: 'legacy-resource',
    rootId: 'legacy-root',
    unknown: 'drop-me',
  });
  assert.equal(entity.kind, 'entity');
  assert.deepEqual(entity.blocks[0], {
    dx: 1,
    dy: 2,
    dz: 3,
    localX: 1,
    localY: 2,
    localZ: 3,
    size: 1,
    block: 1,
    color: 0xabcdef,
    entityId: 'root',
  });
  assert.deepEqual(entity.constraints, [{
    id: 'joint',
    type: 'point',
    bodyA: null,
    bodyB: 'root',
    stiffness: 0.9,
    collideConnected: false,
  }]);
  assert.equal(entity.rootComponentId, 'world');
  assert.equal(entity.childEntities[0].id, 'root');
  assert.equal(entity.childEntities[0].parentId, 'world');
  assert.deepEqual(entity.childEntities[0].pivot, [1, 2, 3]);
  for (const legacy of ['index', 'rootId', 'unknown']) {
    assert.equal(Object.hasOwn(entity, legacy), false, `${legacy} must not escape the preview adapter`);
  }
  assert.equal(Object.hasOwn(entity.childEntities[0], 'kind'), false);
});

test('inventory v6 round-trips every offset in an 8x8x8 cell, including index 512', () => {
  const blocks = [];
  for (let mx = 0; mx < 8; mx++) for (let my = 0; my < 8; my++) for (let mz = 0; mz < 8; mz++) {
    blocks.push({ dx: -1, dy: 255, dz: 0, mx, my, mz, block: 1, color: mx + 8 * my + 64 * mz });
  }
  const encoded = encodeInventoryResource('blockset', { type: 'space-blockset', version: 6, name: 'Grid', blocks });
  const decoded = decodeInventoryResource(encoded, 'blockset').portable;
  assert.equal(decoded.blocks.length, 512);
  assert.equal(new Set(decoded.blocks.map(b => `${b.mx},${b.my},${b.mz}`)).size, 512);
  assert.ok(decoded.blocks.some(b => b.mx === 7 && b.my === 7 && b.mz === 7 && b.color === 511));
  const wire = InventoryResource.decode(encoded);
  assert.equal(wire.content?.$case, 'blockSet');
  assert.ok(wire.content?.$case === 'blockSet' && wire.content.value.blocks.some(b => b.microIndex === 512));
});

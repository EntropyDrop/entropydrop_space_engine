import { MICRO_DIVISIONS, MICRO_SIZE, MICRO_CELLS_PER_BLOCK } from '../voxel/MicroGrid.ts';
import {
  createFileRegistry,
  fromBinary,
  ScalarType,
  type DescField,
  type DescMessage,
} from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { BinaryReader, configureTextEncoding, WireType } from '@bufbuild/protobuf/wire';
import {
  Backpack,
  InventoryCategory,
} from '../generated/backpack.ts';
import {
  BodyType,
  type Component,
  ConstraintType,
  InventoryResource,
  type InventoryResource as InventoryResourceMessage,
  type Quaternion,
  type Vector3,
  type Voxel,
} from '../generated/inventory.ts';
import { INVENTORY_DESCRIPTOR_SET_BYTES } from '../generated/inventory_descriptor.ts';

export const INVENTORY_PROTOBUF_SCHEMA_VERSION = 6;
export const BACKPACK_PROTOBUF_SCHEMA_VERSION = 7;
export const INVENTORY_PROTOBUF_MIME = 'application/x-protobuf';
export const MAX_BACKPACK_SLOTS_PER_CATEGORY = 99;
export type InventoryKind = 'blockset' | 'entity' | 'colorset';

export interface PortableBackpack {
  sourceSchemaVersion?: 7;
  activeCategory: InventoryKind;
  categories: Record<InventoryKind, {
    selected: number;
    items: Array<any | null>;
  }>;
}

const BODY_TYPE_TO_PROTO: Record<string, BodyType> = {
  dynamic: BodyType.BODY_TYPE_DYNAMIC,
  kinematic: BodyType.BODY_TYPE_KINEMATIC,
};
const BODY_TYPE_FROM_PROTO = ['dynamic', 'kinematic'] as const;
const CONSTRAINT_TO_PROTO: Record<string, ConstraintType> = {
  point: ConstraintType.CONSTRAINT_TYPE_POINT,
  hinge: ConstraintType.CONSTRAINT_TYPE_HINGE,
  weld: ConstraintType.CONSTRAINT_TYPE_WELD,
};
const CONSTRAINT_FROM_PROTO = ['point', 'hinge', 'weld'] as const;

// WHATWG TextDecoder removes an initial UTF-8 BOM by default, while the Python
// protobuf runtime preserves U+FEFF as string data. Use the same behavior on
// both sides, and retain strict proto3 UTF-8 validation.
const protobufTextEncoder = new TextEncoder();
const protobufTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const protobufTextDecoderStrict = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});
configureTextEncoding({
  encodeUtf8: value => protobufTextEncoder.encode(value),
  decodeUtf8: (bytes, strict) => (
    strict ? protobufTextDecoderStrict : protobufTextDecoder
  ).decode(bytes),
  checkUtf8: value => {
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  },
});

const inventoryRegistry = createFileRegistry(fromBinary(
  FileDescriptorSetSchema,
  INVENTORY_DESCRIPTOR_SET_BYTES,
));

function requiredMessageDescriptor(typeName: string): DescMessage {
  const descriptor = inventoryRegistry.getMessage(typeName);
  if (!descriptor) throw new Error(`Inventory Protobuf descriptor ${typeName} is missing.`);
  return descriptor;
}

const INVENTORY_RESOURCE_DESCRIPTOR = requiredMessageDescriptor(
  'entropydrop.space.inventory.v6.InventoryResource',
);
const BACKPACK_DESCRIPTOR = requiredMessageDescriptor(
  'entropydrop.space.backpack.v7.Backpack',
);

function scalarWireType(type: ScalarType): WireType {
  if (type === ScalarType.DOUBLE || type === ScalarType.FIXED64 || type === ScalarType.SFIXED64) {
    return WireType.Bit64;
  }
  if (type === ScalarType.STRING || type === ScalarType.BYTES) {
    return WireType.LengthDelimited;
  }
  if (type === ScalarType.FLOAT || type === ScalarType.FIXED32 || type === ScalarType.SFIXED32) {
    return WireType.Bit32;
  }
  return WireType.Varint;
}

function fieldAcceptsWireType(field: DescField, wireType: WireType): boolean {
  if (field.fieldKind === 'message' || field.fieldKind === 'map') {
    return wireType === (field.delimitedEncoding ? WireType.StartGroup : WireType.LengthDelimited);
  }
  if (field.fieldKind === 'enum') return wireType === WireType.Varint;
  if (field.fieldKind === 'scalar') return wireType === scalarWireType(field.scalar);
  if (field.listKind === 'message') {
    return wireType === (field.delimitedEncoding ? WireType.StartGroup : WireType.LengthDelimited);
  }
  const elementWireType = field.listKind === 'enum'
    ? WireType.Varint
    : scalarWireType(field.scalar);
  const packable = field.listKind === 'enum'
    || (field.scalar !== ScalarType.STRING && field.scalar !== ScalarType.BYTES);
  return wireType === elementWireType || (packable && wireType === WireType.LengthDelimited);
}

function nestedMessageDescriptor(field: DescField): DescMessage | undefined {
  if (field.fieldKind === 'message' && !field.delimitedEncoding) return field.message;
  if (field.fieldKind === 'list' && field.listKind === 'message' && !field.delimitedEncoding) {
    return field.message;
  }
  return undefined;
}

function encodeVarint32(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    const next = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining === 0 ? next : next | 0x80);
  } while (remaining !== 0);
  return Uint8Array.from(bytes);
}

/**
 * Python treats a known field with the wrong wire type as an unknown field.
 * Protobuf-ES dispatches by field number without checking that type, so strip
 * only those records before decoding and recurse into known message fields.
 */
function normalizeKnownFieldWireTypes(
  descriptor: DescMessage,
  encoded: Uint8Array,
  depth = 0,
): Uint8Array {
  if (depth > 100) throw new Error('Inventory Protobuf exceeds the recursion limit.');
  const reader = new BinaryReader(encoded);
  const fields = new Map(descriptor.fields.map(field => [field.number, field]));
  const chunks: Uint8Array[] = [];
  let changed = false;

  while (reader.pos < reader.len) {
    const recordStart = reader.pos;
    const [fieldNumber, wireType] = reader.tag();
    const valueStart = reader.pos;
    const field = fields.get(fieldNumber);
    if (field && !fieldAcceptsWireType(field, wireType)) {
      reader.skip(wireType, fieldNumber, 100 - depth);
      changed = true;
      continue;
    }

    const childDescriptor = field ? nestedMessageDescriptor(field) : undefined;
    if (childDescriptor && wireType === WireType.LengthDelimited) {
      const length = reader.uint32();
      const payloadStart = reader.pos;
      const payloadEnd = payloadStart + length;
      if (payloadEnd > reader.len) throw new RangeError('premature EOF');
      reader.pos = payloadEnd;
      const payload = encoded.subarray(payloadStart, payloadEnd);
      const normalized = normalizeKnownFieldWireTypes(childDescriptor, payload, depth + 1);
      if (normalized !== payload) {
        chunks.push(
          encoded.subarray(recordStart, valueStart),
          encodeVarint32(normalized.byteLength),
          normalized,
        );
        changed = true;
      } else {
        chunks.push(encoded.subarray(recordStart, payloadEnd));
      }
      continue;
    }

    reader.skip(wireType, fieldNumber, 100 - depth);
    chunks.push(encoded.subarray(recordStart, reader.pos));
  }

  if (!changed) return encoded;
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const normalized = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    normalized.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return normalized;
}

function decodeInventoryMessage(descriptor: DescMessage, encoded: Uint8Array): any {
  return fromBinary(descriptor, normalizeKnownFieldWireTypes(descriptor, encoded));
}

function canonicalDouble(value: unknown): number {
  const number = Number(value);
  return Object.is(number, -0) ? 0 : number;
}

/** Match Python's ordinal string ordering without locale-dependent collation. */
function compareCodePoints(left: unknown, right: unknown): number {
  const leftPoints = Array.from(String(left));
  const rightPoints = Array.from(String(right));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function compareVoxels(left: any, right: any): number {
  const leftKey = [
    Number(left.dx), Number(left.dy), Number(left.dz),
    Number(left.mx ?? -1), Number(left.my ?? -1), Number(left.mz ?? -1),
    Number(left.color) >>> 0,
  ];
  const rightKey = [
    Number(right.dx), Number(right.dy), Number(right.dz),
    Number(right.mx ?? -1), Number(right.my ?? -1), Number(right.mz ?? -1),
    Number(right.color) >>> 0,
  ];
  for (let index = 0; index < leftKey.length; index += 1) {
    const difference = leftKey[index] - rightKey[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function canonicalVoxelMessages(blocks: any[]): Voxel[] {
  return [...blocks].sort(compareVoxels).map(block => voxelMessage(block));
}

function vector3(value: unknown): Vector3 | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  return { x: canonicalDouble(value[0]), y: canonicalDouble(value[1]), z: canonicalDouble(value[2]) };
}

function vectorArray(value: Vector3 | undefined): number[] | undefined {
  return value
    ? [canonicalDouble(value.x), canonicalDouble(value.y), canonicalDouble(value.z)]
    : undefined;
}

function quaternion(value: unknown): Quaternion | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  return {
    x: canonicalDouble(value[0]),
    y: canonicalDouble(value[1]),
    z: canonicalDouble(value[2]),
    w: canonicalDouble(value[3]),
  };
}

function quaternionArray(value: Quaternion | undefined): number[] | undefined {
  return value
    ? [
      canonicalDouble(value.x),
      canonicalDouble(value.y),
      canonicalDouble(value.z),
      canonicalDouble(value.w),
    ]
    : undefined;
}

function voxelMessage(block: any): Voxel {
  const micro = block.mx !== undefined && block.mx !== null;
  return {
    dx: Number(block.dx),
    dy: Number(block.dy),
    dz: Number(block.dz),
    microIndex: micro
      ? 1 + Number(block.mx) + MICRO_DIVISIONS * Number(block.my) + MICRO_DIVISIONS ** 2 * Number(block.mz)
      : undefined,
    color: Number(block.color) >>> 0,
  };
}

function portableVoxel(block: Voxel): any {
  const portable: any = {
    dx: Number(block.dx),
    dy: Number(block.dy),
    dz: Number(block.dz),
    block: 1,
    color: Number(block.color) >>> 0,
  };
  if (block.microIndex !== undefined) {
    const packed = Number(block.microIndex) - 1;
    if (!Number.isInteger(packed) || packed < 0 || packed >= MICRO_CELLS_PER_BLOCK) {
      throw new Error('Micro voxel index is outside 0..511.');
    }
    portable.mx = packed % MICRO_DIVISIONS;
    portable.my = Math.floor(packed / MICRO_DIVISIONS) % MICRO_DIVISIONS;
    portable.mz = Math.floor(packed / MICRO_DIVISIONS ** 2);
  }
  return portable;
}

/** Copy only the fields carried by the portable v6 voxel shape. */
function portableVoxelFields(block: any): any {
  const portable: any = {
    dx: canonicalDouble(block?.dx),
    dy: canonicalDouble(block?.dy),
    dz: canonicalDouble(block?.dz),
    block: 1,
    color: Number(block?.color) >>> 0,
  };
  if (block?.mx != null && block?.my != null && block?.mz != null) {
    portable.mx = Number(block.mx);
    portable.my = Number(block.my);
    portable.mz = Number(block.mz);
  }
  return portable;
}

/** Normalize the one current constraint shape without accepting legacy aliases. */
function portableConstraintFields(constraint: any): any {
  const portable: any = {
    id: String(constraint?.id || ''),
    type: constraint?.type || 'point',
    bodyA: constraint?.bodyA == null ? null : String(constraint.bodyA),
    bodyB: String(constraint?.bodyB ?? ''),
  };
  for (const field of [
    'anchorA',
    'anchorB',
    'axisA',
    'axisB',
    'referenceA',
    'referenceB',
  ] as const) {
    if (constraint?.[field] != null) {
      portable[field] = constraint[field].map(canonicalDouble);
    }
  }
  if (constraint?.limits != null) {
    portable.limits = {
      min: canonicalDouble(constraint.limits.min),
      max: canonicalDouble(constraint.limits.max),
    };
  }
  portable.stiffness = canonicalDouble(constraint?.stiffness ?? 0.9);
  portable.collideConnected = constraint?.collideConnected === true;
  return portable;
}

function enumName<T extends string>(values: readonly T[], value: number, label: string): T {
  const result = values[value];
  if (result === undefined) throw new Error(`Unknown ${label} enum value ${value}.`);
  return result;
}

function componentMessage(component: any, includeNames = true): Component {
  const body = component?.body || {};
  if (includeNames && component?.name !== undefined && typeof component.name !== 'string') {
    throw new Error('Component name must be a string.');
  }
  return {
    id: String(component?.id || ''),
    name: includeNames ? String(component?.name ?? '') : '',
    pivot: vector3(component?.pivot),
    body: {
      type: BODY_TYPE_TO_PROTO[body.type || 'dynamic'],
      mass: body.mass === undefined ? undefined : canonicalDouble(body.mass),
      restitution: body.restitution === undefined ? undefined : canonicalDouble(body.restitution),
      friction: body.friction === undefined ? undefined : canonicalDouble(body.friction),
      useGravity: body.useGravity === undefined ? undefined : body.useGravity === true,
      collisionEnabled: body.collisionEnabled === undefined ? undefined : body.collisionEnabled === true,
    },
    blocks: canonicalVoxelMessages(component?.blocks || []),
    script: component?.script === undefined ? undefined : String(component.script),
    scriptDisabled: component?.scriptDisabled === true,
    seats: (component?.seats || []).map((seat: any) => ({ position: vector3(seat.position) })),
    children: [...(component?.children || [])]
      .sort((left: any, right: any) => compareCodePoints(left?.id || '', right?.id || ''))
      .map((child: any) => componentMessage(child, includeNames)),
    localPosition: vector3(component?.localPosition),
    localRotation: quaternion(component?.localRotation),
    anchorRotation: quaternion(component?.anchorRotation),
  };
}

function portableComponent(component: Component): any {
  if (!component.body) throw new Error(`Component ${String(component.id || '')} has no body config.`);
  const seats = (component.seats || []).map(seat => {
    const position = vectorArray(seat.position);
    if (!position) {
      throw new Error(`Component ${String(component.id || '')} contains a seat without a position.`);
    }
    return { position };
  });
  return {
    id: String(component.id || ''),
    name: String(component.name ?? ''),
    ...(component.pivot === undefined ? {} : { pivot: vectorArray(component.pivot) }),
    body: {
      type: enumName(BODY_TYPE_FROM_PROTO, Number(component.body.type), 'body type'),
      ...(component.body.mass === undefined ? {} : { mass: canonicalDouble(component.body.mass) }),
      ...(component.body.restitution === undefined ? {} : { restitution: canonicalDouble(component.body.restitution) }),
      ...(component.body.friction === undefined ? {} : { friction: canonicalDouble(component.body.friction) }),
      ...(component.body.useGravity === undefined ? {} : { useGravity: component.body.useGravity }),
      ...(component.body.collisionEnabled === undefined ? {} : { collisionEnabled: component.body.collisionEnabled }),
    },
    blocks: (component.blocks || []).map(block => portableVoxel(block)),
    ...(component.script === undefined ? {} : { script: String(component.script) }),
    ...(component.scriptDisabled === true ? { scriptDisabled: true } : {}),
    seats,
    children: [...(component.children || [])]
      .sort((left, right) => compareCodePoints(left.id || '', right.id || ''))
      .map(child => portableComponent(child)),
    ...(component.localPosition === undefined ? {} : { localPosition: vectorArray(component.localPosition) }),
    ...(component.localRotation === undefined ? {} : { localRotation: quaternionArray(component.localRotation) }),
    ...(component.anchorRotation === undefined ? {} : { anchorRotation: quaternionArray(component.anchorRotation) }),
  };
}

function resourceMessage(category: InventoryKind, portable: any, includeNames = true): InventoryResourceMessage {
  const expectedType = category === 'blockset'
    ? 'space-blockset'
    : category === 'entity'
      ? 'space-entity'
      : 'space-colorset';
  if (portable?.type !== expectedType || portable?.version !== INVENTORY_PROTOBUF_SCHEMA_VERSION) {
    throw new Error(`Expected a ${expectedType} v${INVENTORY_PROTOBUF_SCHEMA_VERSION} resource.`);
  }
  if (category === 'blockset') {
    return {
      schemaVersion: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      content: {
        $case: 'blockSet',
        value: {
          name: includeNames ? String(portable.name || '') : '',
          blocks: canonicalVoxelMessages(portable.blocks || []),
        },
      },
    };
  }
  if (category === 'colorset') {
    return {
      schemaVersion: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      content: {
        $case: 'colorSet',
        value: {
          name: includeNames ? String(portable.name || '') : '',
          colors: (portable.colors || []).map((color: string) => (
            Number.parseInt(String(color).replace(/^#/, ''), 16) >>> 0
          )),
        },
      },
    };
  }

  if (Object.hasOwn(portable, 'name')) throw new Error('Entity names belong to root.name.');
  return {
    schemaVersion: INVENTORY_PROTOBUF_SCHEMA_VERSION,
    content: {
      $case: 'entity',
      value: {
        root: componentMessage(portable.root, includeNames),
        constraints: [...(portable.constraints || [])]
          .sort((left: any, right: any) => compareCodePoints(left?.id || '', right?.id || ''))
          .map((constraint: any) => ({
            id: String(constraint.id || ''),
            type: CONSTRAINT_TO_PROTO[constraint.type || 'point'],
            bodyAComponentId: constraint.bodyA == null
              ? undefined
              : String(constraint.bodyA ?? ''),
            bodyBComponentId: String(constraint.bodyB ?? ''),
            anchorA: vector3(constraint.anchorA),
            anchorB: vector3(constraint.anchorB),
            axisA: vector3(constraint.axisA),
            axisB: vector3(constraint.axisB),
            referenceA: vector3(constraint.referenceA),
            referenceB: vector3(constraint.referenceB),
            limits: constraint.limits ? {
              min: canonicalDouble(constraint.limits.min),
              max: canonicalDouble(constraint.limits.max),
            } : undefined,
            stiffness: canonicalDouble(constraint.stiffness ?? 0.9),
            collideConnected: constraint.collideConnected === true,
          })),
      },
    },
  };
}

function resourceContent(message: any): InventoryResourceMessage['content'] {
  const content = message?.content;
  if (content?.$case) return content;
  if (content?.case === 'blockSet' || content?.case === 'entity' || content?.case === 'colorSet') {
    return { $case: content.case, value: content.value } as InventoryResourceMessage['content'];
  }
  return undefined;
}

function portableResource(message: any): { category: InventoryKind; portable: any } {
  if (Number(message.schemaVersion) !== INVENTORY_PROTOBUF_SCHEMA_VERSION) {
    throw new Error(`Expected inventory Protobuf v${INVENTORY_PROTOBUF_SCHEMA_VERSION}.`);
  }
  const content = resourceContent(message);
  if (content?.$case === 'blockSet') {
    const blockSet = content.value;
    const blocks = (blockSet.blocks || []).map(block => portableVoxel(block));
    return {
      category: 'blockset',
      portable: {
        type: 'space-blockset',
        version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
        name: blockSet.name,
        blocks,
      },
    };
  }
  if (content?.$case === 'colorSet') {
    const colorSet = content.value;
    return {
      category: 'colorset',
      portable: {
        type: 'space-colorset',
        version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
        name: colorSet.name,
        colors: (colorSet.colors || []).map(color => `#${(Number(color) >>> 0).toString(16).padStart(6, '0')}`),
      },
    };
  }
  if (content?.$case !== 'entity') throw new Error('Inventory Protobuf does not contain a resource.');

  const entity = content.value;
  if (!entity.root) throw new Error('Entity Protobuf does not contain a root component.');
  const portable: any = {
    type: 'space-entity',
    version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
    root: portableComponent(entity.root),
    constraints: [...(entity.constraints || [])]
      .sort((left, right) => compareCodePoints(left.id || '', right.id || ''))
      .map(constraint => ({
        id: String(constraint.id || ''),
        type: enumName(CONSTRAINT_FROM_PROTO, Number(constraint.type), 'constraint type'),
        bodyA: constraint.bodyAComponentId === undefined
          ? null
          : String(constraint.bodyAComponentId),
        bodyB: String(constraint.bodyBComponentId || ''),
        ...(constraint.anchorA === undefined ? {} : { anchorA: vectorArray(constraint.anchorA) }),
        ...(constraint.anchorB === undefined ? {} : { anchorB: vectorArray(constraint.anchorB) }),
        ...(constraint.axisA === undefined ? {} : { axisA: vectorArray(constraint.axisA) }),
        ...(constraint.axisB === undefined ? {} : { axisB: vectorArray(constraint.axisB) }),
        ...(constraint.referenceA === undefined ? {} : { referenceA: vectorArray(constraint.referenceA) }),
        ...(constraint.referenceB === undefined ? {} : { referenceB: vectorArray(constraint.referenceB) }),
        ...(constraint.limits === undefined ? {} : {
          limits: {
            min: canonicalDouble(constraint.limits.min),
            max: canonicalDouble(constraint.limits.max),
          },
        }),
        stiffness: canonicalDouble(constraint.stiffness),
        collideConnected: constraint.collideConnected === true,
      })),
  };
  return { category: 'entity', portable };
}

function bodyFromRuntime(source: any, fallbackType: 'dynamic' | 'kinematic'): any {
  return {
    type: source?.bodyType || fallbackType,
    ...(source?.mass === undefined ? {} : { mass: canonicalDouble(source.mass) }),
    ...(source?.restitution === undefined ? {} : { restitution: canonicalDouble(source.restitution) }),
    ...(source?.friction === undefined ? {} : { friction: canonicalDouble(source.friction) }),
    ...(source?.useGravity === undefined ? {} : { useGravity: source.useGravity === true }),
    ...(source?.collisionEnabled === undefined ? {} : { collisionEnabled: source.collisionEnabled === true }),
  };
}

/** Convert the engine's indexed runtime representation into the recursive wire shape. */
export function runtimeEntityToPortable(runtime: any): any {
  const definitions = Array.isArray(runtime?.childEntities) ? runtime.childEntities : [];
  const scripts = new Map((runtime?.scripts || []).map((entry: any) => [String(entry.id), String(entry.code || '')]));
  const enabled = new Map((runtime?.enabled || []).map((entry: any) => [String(entry.id), entry.enabled === true]));
  const nodes = new Map<string, any>();
  const makeNode = (source: any, id: string, fallbackType: 'dynamic' | 'kinematic') => ({
    id,
    name: String(source?.name ?? ''),
    ...(source?.pivot === undefined ? {} : { pivot: source.pivot.map(canonicalDouble) }),
    ...(source?.localPosition === undefined ? {} : { localPosition: source.localPosition.map(canonicalDouble) }),
    ...(source?.localRotation === undefined ? {} : { localRotation: source.localRotation.map(canonicalDouble) }),
    ...(source?.anchorRotation === undefined ? {} : { anchorRotation: source.anchorRotation.map(canonicalDouble) }),
    body: bodyFromRuntime(source, fallbackType),
    blocks: [],
    ...(scripts.has(id) ? { script: scripts.get(id) } : {}),
    ...(scripts.has(id) && enabled.get(id) === false ? { scriptDisabled: true } : {}),
    seats: (source?.seats || []).map((seat: any) => ({
      position: (Array.isArray(seat) ? seat : seat.position).map(canonicalDouble),
    })),
    children: [],
  });
  const rootComponentId = String(runtime?.rootComponentId ?? '');
  if (!rootComponentId) throw new Error('Runtime entity has no root component id.');
  const rootSource = runtime?.pivot === undefined && Array.isArray(runtime?.rootPivotOverride)
    ? { ...runtime, pivot: runtime.rootPivotOverride }
    : runtime;
  const root = makeNode(rootSource, rootComponentId, 'dynamic');
  nodes.set(rootComponentId, root);
  for (const definition of definitions) {
    const id = String(definition.id || '');
    if (!id || nodes.has(id)) throw new Error(`Duplicate or empty component ${id}.`);
    nodes.set(id, makeNode(definition, id, 'kinematic'));
  }
  for (const definition of definitions) {
    const parentId = String(definition.parentId ?? '');
    const parent = nodes.get(parentId);
    if (!parent) throw new Error(`Unknown parent ${String(definition.parentId)}.`);
    parent.children.push(nodes.get(String(definition.id)));
  }
  for (const block of runtime?.blocks || []) {
    const ownerId = String(block.entityId ?? '');
    const owner = nodes.get(ownerId);
    if (!owner) throw new Error(`Unknown component ${String(block.entityId)}.`);
    owner.blocks.push(portableVoxelFields(block));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const sortTree = (component: any) => {
    if (visiting.has(component.id)) throw new Error('Component hierarchy contains a cycle.');
    if (visited.has(component.id)) return;
    visiting.add(component.id);
    component.blocks.sort(compareVoxels);
    component.children.sort((left: any, right: any) => compareCodePoints(left.id, right.id));
    component.children.forEach(sortTree);
    visiting.delete(component.id);
    visited.add(component.id);
  };
  sortTree(root);
  if (visited.size !== nodes.size) throw new Error('Every component must descend from root.');
  return {
    type: 'space-entity',
    version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
    root,
    constraints: (runtime?.constraints || [])
      .map((constraint: any) => portableConstraintFields(constraint))
      .sort((left: any, right: any) => compareCodePoints(left.id, right.id)),
  };
}

/** Flatten a recursive portable entity only for the current in-memory engine. */
export function portableEntityToRuntime(portable: any): any {
  const blocks: any[] = [];
  const childEntities: any[] = [];
  const scripts: any[] = [];
  const enabled: any[] = [];
  let nodeCount = 0;
  const visit = (component: any, parentId: string | null) => {
    nodeCount += 1;
    const id = String(component.id || '');
    for (const block of component.blocks || []) {
      const runtimeBlock = portableVoxelFields(block);
      runtimeBlock.entityId = id;
      blocks.push(runtimeBlock);
    }
    if (component.script !== undefined) {
      scripts.push({ id, code: String(component.script) });
      enabled.push({ id, enabled: component.scriptDisabled !== true });
    }
    if (parentId !== null) {
      const body = component.body || {};
      childEntities.push({
        id,
        name: String(component.name ?? ''),
        parentId,
        ...(component.pivot === undefined ? {} : { pivot: component.pivot.map(canonicalDouble) }),
        ...(component.localPosition === undefined ? {} : { localPosition: component.localPosition.map(canonicalDouble) }),
        ...(component.localRotation === undefined ? {} : { localRotation: component.localRotation.map(canonicalDouble) }),
        ...(component.anchorRotation === undefined ? {} : { anchorRotation: component.anchorRotation.map(canonicalDouble) }),
        bodyType: body.type || 'kinematic',
        ...(body.mass === undefined ? {} : { mass: canonicalDouble(body.mass) }),
        ...(body.restitution === undefined ? {} : { restitution: canonicalDouble(body.restitution) }),
        ...(body.friction === undefined ? {} : { friction: canonicalDouble(body.friction) }),
        ...(body.useGravity === undefined ? {} : { useGravity: body.useGravity === true }),
        ...(body.collisionEnabled === undefined ? {} : { collisionEnabled: body.collisionEnabled === true }),
        seats: (component.seats || []).map((seat: any) => ({
          position: seat.position.map(canonicalDouble),
        })),
      });
    }
    for (const child of [...(component.children || [])]
      .sort((left: any, right: any) => compareCodePoints(left?.id || '', right?.id || ''))) {
      visit(child, id);
    }
  };
  visit(portable.root, null);
  const rootBody = portable.root?.body || {};
  return {
    type: 'space-entity',
    version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
    // Flat runtime slots carry the root component's fields at the top level.
    name: String(portable.root?.name ?? ''),
    rootComponentId: String(portable.root?.id ?? ''),
    nodeCount,
    blockCount: blocks.length,
    blocks,
    childEntities,
    scripts,
    enabled,
    constraints: (portable.constraints || [])
      .map((constraint: any) => portableConstraintFields(constraint))
      .sort((left: any, right: any) => compareCodePoints(left?.id || '', right?.id || '')),
    mode: 'free_physics',
    ...(portable.root?.pivot === undefined
      ? {}
      : { rootPivotOverride: portable.root.pivot.map(canonicalDouble) }),
    ...(portable.root?.anchorRotation === undefined
      ? {}
      : { anchorRotation: portable.root.anchorRotation.map(canonicalDouble) }),
    bodyType: rootBody.type || 'dynamic',
    ...(rootBody.mass === undefined ? {} : { mass: canonicalDouble(rootBody.mass) }),
    ...(rootBody.restitution === undefined ? {} : { restitution: canonicalDouble(rootBody.restitution) }),
    ...(rootBody.friction === undefined ? {} : { friction: canonicalDouble(rootBody.friction) }),
    ...(rootBody.useGravity === undefined ? {} : { useGravity: rootBody.useGravity === true }),
    ...(rootBody.collisionEnabled === undefined ? {} : { collisionEnabled: rootBody.collisionEnabled === true }),
    seats: (portable.root?.seats || []).map((seat: any) => ({
      position: seat.position.map(canonicalDouble),
    })),
  };
}

export function encodeInventoryResource(
  category: InventoryKind, portable: any, options: { includeNames?: boolean } = {},
): Uint8Array {
  return InventoryResource.encode(resourceMessage(category, portable, options.includeNames !== false)).finish();
}

/** List metadata derives from the root; an unnamed component displays its id. */
export function inventoryResourceName(category: InventoryKind, portable: any): string {
  return category === 'entity'
    ? String(portable?.root?.name || portable?.root?.id || '')
    : String(portable?.name || '');
}

export function decodeInventoryResource(
  encoded: Uint8Array,
  expectedCategory?: InventoryKind,
): { category: InventoryKind; portable: any } {
  const decoded = portableResource(decodeInventoryMessage(INVENTORY_RESOURCE_DESCRIPTOR, encoded));
  if (expectedCategory && decoded.category !== expectedCategory) {
    throw new Error(`Expected ${expectedCategory}, received ${decoded.category}.`);
  }
  return decoded;
}

function previewVoxel(block: any, entity: boolean): any {
  const isMicro = block?.mx != null
    && block?.my != null
    && block?.mz != null;
  const x = canonicalDouble(Number(block?.dx) + (isMicro ? Number(block.mx) / MICRO_DIVISIONS : 0));
  const y = canonicalDouble(Number(block?.dy) + (isMicro ? Number(block.my) / MICRO_DIVISIONS : 0));
  const z = canonicalDouble(Number(block?.dz) + (isMicro ? Number(block.mz) / MICRO_DIVISIONS : 0));
  const preview: any = entity
    ? {
      dx: canonicalDouble(block?.dx),
      dy: canonicalDouble(block?.dy),
      dz: canonicalDouble(block?.dz),
      localX: x,
      localY: y,
      localZ: z,
      size: isMicro ? MICRO_SIZE : 1,
      block: 1,
      color: Number(block?.color) >>> 0,
      entityId: String(block?.entityId ?? ''),
    }
    : {
      dx: x,
      dy: y,
      dz: z,
      size: isMicro ? MICRO_SIZE : 1,
      block: 1,
      color: Number(block?.color) >>> 0,
    };
  if (isMicro) {
    preview.mx = Number(block.mx);
    preview.my = Number(block.my);
    preview.mz = Number(block.mz);
  }
  return preview;
}

/** Convert portable v6 coordinates into the runtime shape used by thumbnail rendering. */
export function inventoryResourcePreviewItem(category: InventoryKind, portable: any): any {
  if (category === 'colorset') {
    return {
      type: 'space-colorset',
      version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      name: String(portable?.name || ''),
      kind: 'colorset',
      colors: (portable?.colors || []).map((color: any) => String(color)),
    };
  }

  if (category === 'blockset') {
    const blocks = (portable?.blocks || []).map((block: any) => previewVoxel(block, false));
    return {
      type: 'space-blockset',
      version: INVENTORY_PROTOBUF_SCHEMA_VERSION,
      name: String(portable?.name || ''),
      kind: 'blockset',
      blockCount: blocks.length,
      blocks,
    };
  }

  const source = portableEntityToRuntime(portable);
  const blocks = source.blocks.map((block: any) => previewVoxel(block, true));
  const preview: any = {
    type: source.type,
    version: source.version,
    name: source.name,
    kind: 'entity',
    rootComponentId: source.rootComponentId,
    nodeCount: source.nodeCount,
    blockCount: blocks.length,
    blocks,
    childEntities: source.childEntities,
    scripts: source.scripts,
    enabled: source.enabled,
    constraints: source.constraints,
    mode: source.mode,
    bodyType: source.bodyType,
    seats: source.seats,
  };
  if (source.rootPivotOverride !== undefined) preview.rootPivotOverride = source.rootPivotOverride;
  if (source.anchorRotation !== undefined) preview.anchorRotation = source.anchorRotation;
  if (source.mass !== undefined) preview.mass = source.mass;
  if (source.restitution !== undefined) preview.restitution = source.restitution;
  if (source.friction !== undefined) preview.friction = source.friction;
  if (source.useGravity !== undefined) preview.useGravity = source.useGravity;
  if (source.collisionEnabled !== undefined) preview.collisionEnabled = source.collisionEnabled;
  return preview;
}

function categoryEnum(category: InventoryKind): InventoryCategory {
  if (category === 'entity') return InventoryCategory.INVENTORY_CATEGORY_ENTITY;
  if (category === 'colorset') return InventoryCategory.INVENTORY_CATEGORY_COLOR_SET;
  return InventoryCategory.INVENTORY_CATEGORY_BLOCK_SET;
}

function categoryName(category: InventoryCategory): InventoryKind {
  if (category === InventoryCategory.INVENTORY_CATEGORY_ENTITY) return 'entity';
  if (category === InventoryCategory.INVENTORY_CATEGORY_COLOR_SET) return 'colorset';
  if (category === InventoryCategory.INVENTORY_CATEGORY_BLOCK_SET) return 'blockset';
  throw new Error(`Unknown backpack category enum value ${category}.`);
}

export function encodeBackpack(backpack: PortableBackpack): Uint8Array {
  const group = (category: InventoryKind) => {
    const source = backpack.categories[category];
    const items = source.items || [];
    if (items.length > MAX_BACKPACK_SLOTS_PER_CATEGORY) {
      throw new Error(`Backpack ${category} group exceeds ${MAX_BACKPACK_SLOTS_PER_CATEGORY} slots.`);
    }
    if (!Number.isSafeInteger(source.selected)
      || source.selected < 0
      || source.selected >= MAX_BACKPACK_SLOTS_PER_CATEGORY) {
      throw new Error(`Backpack ${category} group has an invalid selection.`);
    }
    let lastOccupied = items.length - 1;
    while (lastOccupied >= 0 && !items[lastOccupied]) lastOccupied -= 1;
    return {
      selected: source.selected,
      // Repeated-message order is the browser-local slot position.
      // Empty wrappers retain internal gaps; trailing empty slots need no bytes.
      slots: items.slice(0, lastOccupied + 1).map(portable => ({
        resource: portable ? resourceMessage(category, portable) : undefined,
      })),
    };
  };
  return Backpack.encode({
    schemaVersion: BACKPACK_PROTOBUF_SCHEMA_VERSION,
    activeCategory: categoryEnum(backpack.activeCategory),
    blockSets: group('blockset'),
    entities: group('entity'),
    colorSets: group('colorset'),
  }).finish();
}

export function decodeBackpack(encoded: Uint8Array): PortableBackpack {
  const backpack: any = decodeInventoryMessage(BACKPACK_DESCRIPTOR, encoded);
  const sourceSchemaVersion = Number(backpack.schemaVersion);
  if (sourceSchemaVersion !== BACKPACK_PROTOBUF_SCHEMA_VERSION) {
    throw new Error(`Expected backpack Protobuf v${BACKPACK_PROTOBUF_SCHEMA_VERSION}.`);
  }
  const decodeGroup = (category: InventoryKind, group: any) => {
    const slots = group?.slots || [];
    const selected = Number(group?.selected || 0);
    if (!Array.isArray(slots)
      || slots.length > MAX_BACKPACK_SLOTS_PER_CATEGORY
      || !Number.isSafeInteger(selected)
      || selected < 0
      || selected >= MAX_BACKPACK_SLOTS_PER_CATEGORY) {
      throw new Error('Backpack contains an invalid group.');
    }
    const items: Array<any | null> = [];
    for (let position = 0; position < slots.length; position += 1) {
      const slot = slots[position];
      if (!slot.resource) {
        items[position] = null;
        continue;
      }
      const decoded = portableResource(slot.resource);
      if (decoded.category !== category) {
        throw new Error(`Backpack ${category} group contains a ${decoded.category} resource.`);
      }
      items[position] = decoded.portable;
    }
    return {
      selected,
      items,
    };
  };
  return {
    sourceSchemaVersion,
    activeCategory: categoryName(backpack.activeCategory!),
    categories: {
      blockset: decodeGroup('blockset', backpack.blockSets),
      entity: decodeGroup('entity', backpack.entities),
      colorset: decodeGroup('colorset', backpack.colorSets),
    },
  };
}

export function protobufToBase64(encoded: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < encoded.length; index += 0x8000) {
    binary += String.fromCharCode(...encoded.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function protobufFromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}

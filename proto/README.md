# Space Protobuf contracts

`entropydrop_space_engine/proto/` is the single source of truth for every Space schema that
crosses a process boundary.

| File | Package | Purpose | Current version |
| --- | --- | --- | --- |
| `inventory.proto` | `entropydrop.space.inventory` | Portable `InventoryResource`: blocksets, entities, color sets. Used by backpack export, market upload/CDN, entity create/checkpoint and `.edpb` files. | **v7** |
| `backpack.proto` | `entropydrop.space.backpack` | Browser-local backpack UI state. Never uploaded; the backend has no backpack endpoint or message. | **v8** |
| `space_api.proto` | `entropydrop.space.api` | Binary REST request envelopes (`CreateEntityRequest`, `CheckpointEntityRequest`, `BuildBlocksetRequest`). `definition` carries raw canonical `InventoryResource` bytes. | **v2** |

`space.multiplayer.v2` (the authoritative realtime protocol) lives in the backend at
`entropydrop_backend/space/contracts/protocol.proto`. It is target design and is not yet
compiled or implemented; the running realtime channel is the transitional
`space-relay-v1` MessagePack relay. Do not add consumers for it until it is wired up.

## Ownership and versioning

- `inventory.proto` is the authority for portable content. Its Voxel geometry follows the
  realtime `VoxelMutation` conventions: `is_micro` guards `micro_x`/`micro_y`/`micro_z`
  (0..7) and color is the varint `color_rgb` (`0xRRGGBB`). The removed v6 packed
  `micro_index` and `fixed32 color` are not accepted.
- A wire-breaking change bumps the package version (`.v7` -> `.v8`) and the
  `schema_version` carried in the message. Old versions are intentionally rejected, not
  migrated, matching the project's "reset Space content" deployment policy.
- Never reuse a retired field number or name; add `reserved` entries instead. Additive,
  backward-compatible fields may stay in the current package version.
- Keep `space_api.proto` free of secrets and of typed imports; its `bytes definition`
  field is validated by the existing inventory codec so the Python binding keeps the
  `space/contracts/*_pb2` descriptor identity.

## Code generation

Generated artifacts are checked in; consumers do not need `protoc`.

```sh
npm run generate:protobuf   # engine: ts-proto bindings + descriptor set + source hashes
npm run check:protobuf      # verify the checked-in outputs are current
```

The backend Python bindings are generated from the backend root:

```sh
protoc --proto_path=space/contracts=../entropydrop_space_engine/proto --python_out=. space/contracts/inventory.proto
protoc --proto_path=space/contracts=../entropydrop_space_engine/proto --python_out=. space/contracts/space_api.proto
```

Then run `entropydrop_backend/space/sync_agent_docs.py --check --protobuf` to verify the
bindings and refresh the public agent reference copies.

## Linting and compatibility

`buf.yaml` (buf v2) configures `buf lint` and `buf breaking`. The CLI is pinned as a dev
dependency (`@bufbuild/buf`), so no global install is required:

```sh
npm run check:buf                                # buf lint (part of `npm run check`)
cd proto && buf breaking --against '.git#branch=main'   # manual / CI only
```

The lint exceptions are intentional: enum zero values are semantic
(`BODY_TYPE_DYNAMIC`, `CONSTRAINT_TYPE_POINT`, …), the versioned package names do not
mirror the proto directory, and the directory deliberately carries three independently
versioned packages (`inventory.v7`, `backpack.v8`, `api.v2`) side by side. `buf breaking`
compares the working tree against the last released branch, so a wire change without a
package version bump fails the check; run it before releasing, not on every commit.
`protoc` 33.2 and `protoc-gen-ts_proto` 2.12.1 generated the checked-in bindings; the
source hashes in `src/generated/inventory_descriptor.ts` fail `npm run check:protobuf` if
`proto/` changes without regenerating.

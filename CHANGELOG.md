# Changelog

## 2026-09 — Contracts

- `inventory.proto` v6 → v7: `Voxel` adopts `is_micro` + `micro_x`/`micro_y`/`micro_z` and
  the varint `color_rgb`, matching `space.multiplayer.v2.VoxelMutation`; `ColorSet.colors`
  becomes `repeated uint32`. Old v6 files are rejected.
- `backpack.proto` v7 → v8: embeds inventory v7.
- Added `space_api.proto` (`entropydrop.space.api.v2`) binary REST request envelopes so the
  canonical resource travels as raw bytes on upload and download.
- Added `proto/README.md` (ownership, versioning, codegen) and `proto/buf.yaml`
  (`buf lint` + `buf breaking`).
- `tools/generate-protobuf.mjs` now generates and verifies `space_api.ts` and its source
  hash alongside the inventory and backpack bindings.

## Earlier

- 8×8×8 micro grid (0.125 m) across editing, collision, inventory and snapshots.

# Space engine

[spaceAPI](docs/spaceAPI.md) · [entityAPI](docs/generated/api-v2.md)

entityAPI is the runtime interface for entity code (`self` / `ctx`); spaceAPI is the HTTP interface for Agent requests.

`@entropydrop/space-engine` contains the TypeScript engine shared by the Space browser
application and the backend hosting worker. It owns voxel/chunk data, terrain generation,
meshing, torus math, entities, physics, simulation timing, the QuickJS script sandbox,
entityAPI contracts, inventory Protobuf schemas/codecs, and their tests.

The engine does not import either application repository. `SpaceStorage` and
`SurfaceZoneSnapshot` define the data interfaces supplied by the browser or backend.
The shared World still includes optional terrain mesh/streaming support for the browser;
using the engine on Node does not create a WebGL renderer. React UI, character rendering,
input, sound, browser storage implementation, HTTP clients and login remain in the frontend.
Hosting policy, IPC, authentication, billing and persistence remain in the backend.

## Local setup

Keep the three repositories side by side:

```text
entropydrop_website/
  entropydrop_space_engine/
  entropydrop_frontend/
  entropydrop_backend/
```

Use Node 24+ and npm 10+. Install this repository's dependencies first:

```sh
npm ci
npm run check
```

Then run `npm ci` in `entropydrop_frontend`, and `npm ci` in
`entropydrop_backend/space/runtime` if building the hosting worker. Both consumers declare
a local `file:` dependency on this package. Keep `install-links=false` (configured in
the consumers) so source edits are immediately visible and Node resolves TypeScript
through the real repository path instead of copying it under `node_modules`.

The package exports TypeScript source: Vite builds it into the browser application, and
the backend's esbuild step builds it into the standalone Node runtime. Neither deployed
artifact needs this source checkout. Three is a peer dependency; Vite and the browser
integration tests deduplicate it so the application uses one Three instance.

```ts
import { World } from '@entropydrop/space-engine/voxel/World.ts';
import { ContraptionPhysics } from '@entropydrop/space-engine/physics/ContraptionPhysics.ts';
// The package root is the entry used by the backend's headless simulation.
```

## Contracts and validation

`npm run check` verifies generated Protobuf files and API docs, typechecks the package,
and runs engine tests. Protobuf generation/checks require `protoc` on PATH; the TypeScript
generator is a local dev dependency. Use `npm run generate:protobuf` after changing
`proto/`, and `npm run docs:generate` after changing `src/contraption/ScriptApiContract.ts`.
Generated files are checked in, so ordinary consumer builds do not need `protoc`.

The Python backend keeps its generated binding under `space/contracts/`; the only
resource schema source is `proto/inventory.proto` here. To regenerate that binding from
the backend root (using protoc 33.2 to match the checked-in Python runtime version):

```sh
protoc --proto_path=space/contracts=../entropydrop_space_engine/proto --python_out=. space/contracts/inventory.proto
```

The virtual proto path preserves the Python module name and descriptor identity. Moving
these files does not change the wire format or database schema. Frontend `npm run check:space` also runs the
engine checks and browser integration tests.

Rebuild both consumers after shared physics/script/codec changes. The optional hosting
Docker image builds from the backend and this repository only. Hosting remains disabled
in both applications until explicitly enabled; extracting this package does not enable it.

## Entity collision performance

Physics uses exact unions of merged, component-local voxel boxes. Standard and
micro voxels can merge where their complete faces match; gaps and component
boundaries remain intact. Editing, raycasts and player collision retain original
voxel cells. Terrain keeps its surface probes and uses merged boxes with bounded
extent for exact contacts, preserving support and fast-motion checks.

The entity solver rejects disjoint swept entity bounds before checking component
boxes, then uses a per-pose box tree for complex shapes. Bounds are checked again
at every substep/iteration because earlier impulses can move another entity.
Stopped/stopped pairs are omitted; stopped entities still collide with active ones.

Entities settle to sleep after one second of low motion when supported (or without
gravity). Their authored run state stays unchanged. Impacts, forces, impulses,
pose/shape/body-setting changes, Stop/Play and support movement/removal wake them.
World checks only overlapping terrain chunks and published micro partitions, so
remote edits and unrelated streaming-window changes leave sleepers alone. Hosts
without local collision stamps fall back to numeric `terrainVersion` and window
invalidation; hosts without revision notifications keep simulating.
Scripts still run every tick while physics sleeps. `ctx.contacts` retains resting
support observations with `sleeping: true`, zero relative velocity and zero impulse;
a script force wakes its body in the same update.

Microterrain caches exact merged collision boxes and a BVH per 4 m partition.
Geometry merges across colors and labels but never across holes. Live edits invalidate
the live cache; published colliders remain immutable until the replacement mesh is
published, including incremental chunk replacement and cross-layer subdivision.
Torus queries unwrap these boxes into the caller's periodic window.

The construction grid is 8×8×8: 512 cells of 0.125 m per standard 1 m block.
The pure `src/voxel/MicroGrid.ts` constants are shared by editing, geometry, physics,
inventory and the browser. Inventory v6, backpack v7, offline entities v4, local
world edits v3 and far-surface snapshots v3 intentionally reject older formats.
Backend deployment requires fresh Space content/storage; no historical migration
or automatic deletion is included.

Run a reproducible CPU benchmark with `node tools/benchmark-physics.ts`. It reports
median/p95 time per 50 ms simulation update for 100 entities of 100 voxels each,
with awake, stopped and sleeping cases. It excludes GPU drawing, terrain occupancy,
scripts and network work; it does not estimate browser FPS.

`node tools/benchmark-micro-terrain.ts` compares cell scans and cached box queries
on the same 8³ microgrid, reporting cold-cache cost separately.

# Space engine

`@entropydrop/space-engine` contains the TypeScript engine shared by the Space browser
application and the backend hosting worker. It owns voxel/chunk data, terrain generation,
meshing, torus math, entities, physics, simulation timing, the QuickJS script sandbox,
script API contracts, inventory Protobuf schemas/codecs, and their tests.

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

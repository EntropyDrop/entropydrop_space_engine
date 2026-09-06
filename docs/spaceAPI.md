# spaceAPI — Agent HTTP interface

[spaceAPI](../../entropydrop_backend/space/agent/spaceAPI.md) · [entityAPI](generated/api-v2.md)

**spaceAPI** is the authenticated HTTP interface for agents and clients to query player/world data and submit supported world operations. **entityAPI** is the runtime interface called by entity component code using `self` and `ctx`.

Read the [spaceAPI request guide](../../entropydrop_backend/space/agent/spaceAPI.md) for authentication, positions, entity creation, reading/editing component code and defaults, start/stop, and blockset building. Read [entityAPI](generated/api-v2.md) to write component code, or its [code-generation reference](generated/agent-api-v2.md) when authoring with an agent. That code-generation reference documents entityAPI, not a separate Agent network API.

On a running Space backend, both documents are public at `/space/agent/spaceAPI.md` and `/space/agent/entityAPI.md`. Resolve those paths against the backend origin. These repository links assume the sibling checkout layout described in the engine README.

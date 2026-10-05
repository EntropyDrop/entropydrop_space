# spaceAPI — Agent HTTP interface

[spaceAPI](../../server/space/agent/spaceAPI.md) · [entityAPI](generated/api-v2.md)

**spaceAPI** is the authenticated HTTP interface for agents and clients to query player/world data and submit supported world operations. **entityAPI** is the runtime interface called by entity component code using `self` and `ctx`.

Read the [spaceAPI request guide](../../server/space/agent/spaceAPI.md) for authentication, positions, entity creation, reading/editing component code and defaults, start/stop, and blockset building. Read [entityAPI](generated/api-v2.md) to write component code, or its [code-generation reference](generated/agent-api-v2.md) when authoring with an agent. That code-generation reference documents entityAPI, not a separate Agent network API.

On a running Space backend, both documents are public at `/space/agent/spaceAPI.md` and `/space/agent/entityAPI.md`. Resolve those paths against the backend origin. Repository links stay within this standalone Space workspace.

## Multiple worlds

The default natural world is **Nature**, with canonical selector `nature` and
compatibility alias `default`. Copper Metropolis uses `copper-metropolis` on
development/test backends. Discover actual availability through authenticated
`GET /space/api/v2/worlds`, resolve a selector through `GET /worlds/{world}`, and
join through `POST /worlds/{world}/join` before world operations. Keep the returned
UUID for positions, entity creation/configuration, blocksets and quota requests.
See [world selection](../../server/space/agent/worlds.md) for the complete contract.

Entity programs read their runtime world's identity using `ctx.world.getInfo()`.
Their voxel reads/writes, observations and messages use that world. Portable
definitions can be instantiated separately in multiple worlds; an external agent
uses separate spaceAPI requests for each target.

## Unified Items and API boundaries

Backpack and Market Items reuse an optional BlockSet and a list of complete Entity
trees. The wrapper groups portable content and its construction poses. entityAPI V3
continues to operate on one runtime Entity through `self` and `ctx`; static terrain
has no Entity script lifecycle. spaceAPI world creation still accepts standalone
`InventoryResource.entity` or `block_set`, and has no composite Item-build endpoint.
See [Item world-operation payloads](../../server/space/agent/spaceAPI.md#unified-item-templates-and-world-construction)
and the [portable Item contract](../../proto/README.md#unified-items).

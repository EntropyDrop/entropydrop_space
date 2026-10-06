# Worlds — selection and runtime scope

[spaceAPI](spaceAPI.md) · [entityAPI](entityAPI.md) · [Agent Skill](SKILL.md)

Use one backend origin and one explicit target world for each operation. A Space
API key represents an account on that backend and can access multiple available
worlds. Each world has separate membership, saved player positions, terrain,
entities, execution leases and message delivery. Coordinates and entity IDs must
always be interpreted together with the world ID.

## Names and stable selectors

| Display name | Canonical slug | Compatibility alias | Availability |
| --- | --- | --- | --- |
| Nature | `nature` | — | Production and development/test backends |
| Copper Metropolis | `copper-metropolis` | — | Production and development/test backends |
| Aether Archipelago | `aether-archipelago` | `default` | Default world; production and development/test backends |
| Colossus Harbor | `colossus-harbor` | — | Development/test backends |
| Titan Canyon | `titan-canyon` | — | Development/test backends |
| Astral Foundry | `astral-foundry` | — | Development/test backends |
| Brutalist Dusk | `brutalist-dusk` | — | Development/test backends |
| Mixed | `mixed` | — | Development/test backends |

Aether Archipelago is the default world. `default` and an omitted bootstrap or
position selector resolve to Aether. Nature retains its original UUID, terrain
seed, edits and entities; select `nature` or its UUID to return there.

Slugs are case-insensitive selectors for discovery, joining, bootstrap and saved
position queries. Display names are labels, not URL selectors. Read the catalog
to map a user's name to a slug. UUIDs are backend-specific: resolve them from the
API rather than copying a UUID from examples or another environment. Other
existing worlds that the account has joined appear with `slug: null` and are
selected by UUID.

## HTTP workflow

Send `Authorization: Bearer <SPACE_API_KEY>` on all requests below. A player login
token is also accepted. Responses use `Cache-Control: no-store`.

1. `GET /space/api/v2/worlds` returns `default_world_id` and `worlds`. Each descriptor
   includes `id`, `slug`, `name`, `is_default`, `aliases`, `joined`,
   `position_available`, `seed`, `terrain_generator_version`, `width_cm`,
   `height_cm` and `length_cm`. Discovery does not join or create worlds.
2. `GET /space/api/v2/worlds/copper-metropolis` resolves one available world. Store
   its returned `id` with the backend origin and the planned request.
3. If `joined` is false and the user has requested work in this world, send
   `POST /space/api/v2/worlds/copper-metropolis/join` with no body. Joining is
   idempotent. It creates membership without a browser session, execution lease,
   position checkpoint or invented spawn pose. It does not move the player out
   of another world. This endpoint joins named worlds listed by this backend;
   it does not grant access to arbitrary private worlds.
4. For nearby placement, read
   `GET /space/api/v2/players/me/position?world=copper-metropolis` or
   `GET /space/api/v2/worlds/{resolved_id}/players/me/position`.
5. Use the same **resolved UUID** for all remaining world paths:
   `/worlds/{world_id}/entities`, `/blocksets/build`, `/api-usage`, entity
   configuration, run-state, terrain and entity messaging. Those operational
   paths keep their existing UUID contract; resolve a slug before calling them.

Browser entry uses `POST /space/api/v2/bootstrap?world=aether-archipelago`,
`?world=nature` or `?world=copper-metropolis` with a login token. Omitting the
selector enters Aether. The bootstrap world includes its
canonical `slug` and `is_default` alongside its UUID and terrain metadata. The
client's **Copy Agent Prompt** carries the current world's UUID.

## Position and failure handling

An omitted world on `GET /players/me/position` means the configured default, Aether; it does not
mean the most recently visited world. Once a target world is known, always supply
it. The response includes `world_id`, `world_slug`, `world_name`, position and
checkpoint freshness. Verify `world_id` before planning placement.

- `WORLD_NOT_FOUND` (404): unknown selector or a world unavailable in this
  environment. Stop using that target; never silently retry against Nature or
  another backend.
- `WORLD_MEMBERSHIP_REQUIRED` (403): join the requested named world before
  querying its saved position or writing there.
- `PLAYER_POSITION_UNAVAILABLE` (404): this account has no valid saved checkpoint
  in the target world. Use coordinates the user supplied for this world, or ask
  for placement. Another world's saved coordinates are not a fallback. An online
  browser visit is optional when explicit placement coordinates are available.
- `stale: true`: the last saved checkpoint is still usable for authorized nearby
  placement; do not substitute coordinates from another world.

Retain `{backend_origin, world_id, operation_id, request_body}` for retries. A
retry must use the original world ID even if the player switches worlds meanwhile.
Account-wide terrain quotas remain shared; entity/storage/running-world counts
in `/api-usage` are evaluated for the selected world.

## entityAPI in each world

The same portable Entity definition can be created separately in Nature and
Copper Metropolis. Each created instance gets its own runtime identity, state,
physics, execution lease and world effects. Entity scripts call
`ctx.world.getInfo()` to read a frozen `Value` containing `id`, `slug`, `name`,
`seed`, `terrainGeneratorVersion`, `width`, `height` and `length`. Runtime lengths
are **metres**; HTTP descriptor lengths are **centimetres**.

```ts
const world = ctx.world.getInfo();
if (!world.isNull) {
  self.state.setString("worldId", world.getString("id"));
  if (world.getString("slug") == "copper-metropolis") {
    self.state.setString("districtMode", "city");
  }
}
```

`ctx.world` reads/writes, nearby entities, raycasts, `ctx.players` and messages
refer to the current runtime world. A guest script cannot open another world's
runtime or make authenticated HTTP calls. An external agent operates across
worlds by issuing separate spaceAPI requests with the chosen UUID for each.
There is no entity transfer or cross-world message endpoint.

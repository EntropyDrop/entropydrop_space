---
name: entropydrop-space
description: Use spaceAPI to discover and select EntropyDrop worlds such as Nature and Copper Metropolis, query the key owner's position in the selected world, create voxel entities or structures, edit stopped/unoccupied entities, and start or stop them. Generate entityAPI component code for programmable behavior.
---

# Space Agent Skill — spaceAPI and entityAPI

[spaceAPI](spaceAPI.md) · [entityAPI](entityAPI.md) · [entity messaging](entityMessaging.md)

Read [world selection and runtime scope](worlds.md) before querying positions or
building. Nature (`nature`, compatibility alias `default`) is the default world;
Copper Metropolis uses `copper-metropolis`. Resolve names on the designated
backend; do not assume world UUIDs match across environments.

- **spaceAPI** is the HTTP interface used by agents and clients. Read the [spaceAPI guide](spaceAPI.md) before sending requests; it covers authorization, coordinates, freshness, creation, code/default edits, start/stop, quotas, and error handling.
- **entityAPI** is the runtime interface called by entity component code using `self` and `ctx`. Read the [entityAPI reference](entityAPI.md) when generating component code; submit that code through spaceAPI for the entity runtime to execute.
- **Entity messaging** is the ephemeral, authenticated transport used by running entity runtimes. Read the [protocol reference](entityMessaging.md) when generating code that uses `ctx.messages`.
- **Unified Items** combine an optional static BlockSet and complete Entity trees for backpack and Market use. World construction endpoints still accept standalone Entity or BlockSet resources; entityAPI remains scoped to one runtime Entity. Read [Item templates and world construction](spaceAPI.md#unified-item-templates-and-world-construction) before submitting a portable Item as world input.

## Authorization & API Keys
World operations and position queries require a spaceAPI key. Prefer browser authorization; the user should not need to copy a key into the conversation.

1. Reuse a valid connection already available in your private credentials. Otherwise read `GET /space/api/v2/agent/authorization` on the designated Space backend. It returns `authorization_endpoint` and `token_endpoint` on this server's account service. These are the only account endpoints to use for pairing.
2. Send `POST` JSON `{ "name": "Your agent name" }` to `authorization_endpoint`. Keep the returned `device_code` private. Show the user `verification_uri_complete` and `user_code`, asking them to open the website, check that the code matches, and click **Authorize agent**. Do not approve on their behalf.
3. Poll `token_endpoint` with `POST` JSON `{ "device_code": "..." }`. Wait at least `interval` seconds before the first poll and between polls. On `authorization_pending`, continue; on `slow_down`, use the increased returned `interval`; on HTTP 429, honor `Retry-After`. Stop when the request's `expires_in` deadline is reached, or on `access_denied`, `expired_token`, or `invalid_grant`. Ask the user before starting a replacement for a denied or expired request.
4. A successful response contains `api_key`. Store it privately in the agent's credential storage (or a local file accessible only to the user), never in the transcript, source repository, generated code or public artifacts. Use it for the requested build. If the successful response was lost, retry with the same device code before expiry; the server returns the same key. Stop polling after receiving it.

Pairing requests last ten minutes. Issued keys have full Space access and remain valid until revoked under **Space → API Keys** or **Settings → API**. If `SPACE_API_KEY_LIMIT_REACHED` is returned, ask the user to revoke an unused connection, then retry while the pairing request is still valid. Revoked keys cannot be reclaimed through the same request.

If browser authorization is unavailable, explain the failure; use manual key setup only when the user explicitly chooses it. The main site's `/space/apikeys` page can create a key as an advanced option. Do not substitute a different server.

- **Header**: Send the key only in the `Authorization: Bearer <key>` HTTP header to the designated backend. Never put the key in URLs, generated code, or public artifacts. Model-provider API keys are separate from spaceAPI credentials.
- **Permissions**: All valid API keys (including existing keys) have full Space permissions without selecting scopes.
- **World entities**: Authorship does not restrict operations. All world members may edit stopped/unoccupied entities; only the occupying browser endpoint may stop or modify a live entity. Market publisher permissions remain separate.

## Agent Workflow
1. **API Key, World & Position**: Complete browser authorization or reuse the existing authorized spaceAPI key. Read `GET /space/api/v2/worlds` and select the world named by the user or supplied in the copied Agent Prompt. Resolve its slug/UUID with `GET /space/api/v2/worlds/{world}` and retain the returned UUID. If no world is specified, use Nature and state that choice. Join the requested named world with `POST /space/api/v2/worlds/{world}/join` when `joined` is false. Then query `GET /space/api/v2/worlds/{world_id}/players/me/position` for that same UUID. A stale position is still usable for nearby building. If no position is available, use explicit coordinates for this world or ask for placement; a browser visit is not required. Never use another world's position or silently fall back to Nature when the target is unavailable.
2. **Plan the World Effects Autonomously**: Infer each part's static terrain or independent Entity behavior from the player's request. Users handle one Item concept in the backpack and Market; do not ask them to choose internal `entity`/`blockset` resource kinds unless their requirements contradict one another.
   - Use a **blockset** for static construction that should become part of the world's terrain, such as buildings, walls, roads, landscaping, and non-interactive decoration. A stamped blockset does not move or run scripts and has no independent start/stop lifecycle.
   - Use an **entity** when the creation must remain a distinct object, move or use physics, run code, contain independently moving components, expose seats or controls, sense its surroundings, communicate, or be started/stopped as a unit. A visually static prop is still an entity when the player requires this independent behavior or lifecycle.
   - Honor an explicit category requested by the player when it can satisfy the requested behavior. For a mixed construction, classify and create its static terrain and interactive parts separately instead of forcing the whole build into one category.
3. **Requirements & Planning**: Infer reasonable implementation details and clarify only requirements that materially affect the result, not the `entity`/`blockset` label itself. Plan voxel geometry, dimensions, colors, and entity components where applicable.
4. **Programmable Scripts**: If the entity has programmable parts (thrusters, hinges, spinners, sensors), write `entityAPI` scripts using `self` and `ctx`.
5. **Execution**: Submit each part through the matching spaceAPI endpoint using standalone `InventoryResource.entity` or `block_set`, not `item`. Use the resolved world UUID for creation, blocksets, quotas, configurations and start/stop. Preserve the planned shared arrangement. Mixed constructions use separate commits; retain backend origin, world ID, operation ID and request body unchanged across retries, including when the player switches worlds.

The same Entity definition may be instantiated separately in different worlds.
`ctx.world.getInfo()` identifies the executing world; entityAPI observations,
mutations and messages stay inside it. Use separate authenticated spaceAPI calls
for work in another world. Guest code has no API key or network access.

When editing an existing entity, read its configuration and submit updates while stopped with the current revision. If a live endpoint occupies it, request that endpoint to stop/release it first or wait for lease expiry; an Agent cannot stop another endpoint's execution. Entities have running and stopped states. Use only documented capabilities and preserve the requested task and server.

Read [entity encoding and request examples](references/entity-create.md) for Protobuf submission. These documents are public, but world operations still require authorization.

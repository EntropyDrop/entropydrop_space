---
name: entropydrop-space
description: Use spaceAPI to query the key owner's position and create voxel entities or structures, edit stopped/unoccupied world-entity code/defaults, and start or stop entities in EntropyDrop Space. Generate entityAPI component code when the requested entity needs programmable behavior.
---

# Space Agent Skill — spaceAPI and entityAPI

[spaceAPI](spaceAPI.md) · [entityAPI](entityAPI.md) · [entity messaging](entityMessaging.md)

- **spaceAPI** is the HTTP interface used by agents and clients. Read the [spaceAPI guide](spaceAPI.md) before sending requests; it covers authorization, coordinates, freshness, creation, code/default edits, start/stop, quotas, and error handling.
- **entityAPI** is the runtime interface called by entity component code using `self` and `ctx`. Read the [entityAPI reference](entityAPI.md) when generating component code; submit that code through spaceAPI for the entity runtime to execute.
- **Entity messaging** is the ephemeral, authenticated transport used by running entity runtimes. Read the [protocol reference](entityMessaging.md) when generating code that uses `ctx.messages`.

## Authorization & API Keys
All world operations and position queries require a user-provided spaceAPI Key:
- **Obtaining a Key**: If the user has not provided a spaceAPI key yet, check whether one was given in the conversation. If not, ask the user for an existing key, or guide them to open `/space/apikeys` on the frontend (e.g. `{origin}/space/apikeys`) to create one.
- **Header**: Send the key only in the `Authorization: Bearer <key>` HTTP header to the designated backend. Never put the key in URLs, generated code, or public artifacts. Model-provider API keys are separate from spaceAPI credentials.
- **Permissions**: All valid API keys (including existing keys) have full Space permissions without selecting scopes.
- **World entities**: Authorship does not restrict operations. All world members may edit stopped/unoccupied entities; only the occupying browser endpoint may stop or modify a live entity. Market publisher permissions remain separate.

## Agent Workflow
1. **API Key & Position**: Ensure you have the user's spaceAPI key. Then query the player's saved position via `GET /space/api/v2/players/me/position`. A stale position is still usable: use the latest saved coordinates to build nearby even when the player is offline or inactive. If no position is available, ask for the desired coordinates or placement location; do not require the player to enter the online world just to create an entity or blockset.
2. **Classify the Build Autonomously**: Infer whether each requested creation should be an `entity` or a `blockset` from the behavior the player describes. Do not ask the player to choose this implementation category unless their requirements contradict one another.
   - Use a **blockset** for static construction that should become part of the world's terrain, such as buildings, walls, roads, landscaping, and non-interactive decoration. A stamped blockset does not move or run scripts and has no independent start/stop lifecycle.
   - Use an **entity** when the creation must remain a distinct object, move or use physics, run code, contain independently moving components, expose seats or controls, sense its surroundings, communicate, or be started/stopped as a unit. A visually static prop is still an entity when the player requires this independent behavior or lifecycle.
   - Honor an explicit category requested by the player when it can satisfy the requested behavior. For a mixed construction, classify and create its static terrain and interactive parts separately instead of forcing the whole build into one category.
3. **Requirements & Planning**: Infer reasonable implementation details and clarify only requirements that materially affect the result, not the `entity`/`blockset` label itself. Plan voxel geometry, dimensions, colors, and entity components where applicable.
4. **Programmable Scripts**: If the entity has programmable parts (thrusters, hinges, spinners, sensors), write `entityAPI` scripts using `self` and `ctx`.
5. **Execution**: Submit the construction through the matching spaceAPI endpoint. Keep operation IDs and request bodies stable across retries.

When editing an existing entity, read its configuration and submit updates while stopped with the current revision. If a live endpoint occupies it, request that endpoint to stop/release it first or wait for lease expiry; an Agent cannot stop another endpoint's execution. Entities have running and stopped states. Use only documented capabilities and preserve the requested task and server.

Read [entity encoding and request examples](references/entity-create.md) for Protobuf submission. These documents are public, but world operations still require authorization.

# Space networking

The browser talks to the Space backend over authenticated REST plus one binary WebSocket.
All paths below are served by this workspace's `server`; the authoritative architecture and
consistency contract is [the Space backend contract](../../server/docs/space-backend.md).

## Origins and credentials

- REST base: `VITE_API_BASE_URL` (default `http://localhost:8000`), paths under
  `/space/api/v2/`.
- Browser REST requests use the main site login token as `Authorization: Bearer`.
- External agents use an `edapi_…` spaceAPI key. Never send a key to a non-HTTPS remote
  origin; `NetworkSafety.ts` rejects unsafe URLs and oversize responses.
- The realtime socket uses a short-lived, single-use join ticket, not the login token.

## REST boundaries

| Endpoint | Method | Body / format | Purpose |
| --- | --- | --- | --- |
| `/space/api/v2/bootstrap` | POST | JSON | Load the authenticated user's world and start pose; random fallback when no snapshot exists |
| `/space/api/v2/players/me/position` | GET | JSON | Read the key owner's saved position |
| `/worlds/{id}/players/me/position` | PUT | JSON pose | Checkpoint a wrapped position/yaw |
| `/worlds/{id}/terrain-edits` | GET | JSON pages | Durable terrain-edit cursor for an AOI |
| `/worlds/{id}/terrain-edits/batches` | POST | JSON | Idempotent batch of 1–256 mutations |
| `/worlds/{id}/heartbeat` | POST | JSON | Terrain revision + nearby players when the socket is down |
| `/worlds/{id}/admission` | POST/DELETE | JSON | Redis-backed join queue (32 active slots per world) |
| `/worlds/{id}/join-ticket` | POST | JSON | Single-use realtime ticket + WebSocket URL |
| surface manifest / zone URLs | GET | JSON manifest, `application/vnd.entropydrop.surface-zone` | Far-surface zones (`EDSZ` v5) |
| `/worlds/{id}/entities` | GET/POST | JSON, or `application/x-protobuf` envelope | List / create world entities |
| `/worlds/{id}/entities/{id}` | GET | JSON | Read moving entity metadata on realtime AOI entry |
| `/worlds/{id}/entities/browser` | POST | `application/x-protobuf` envelope | Create a browser-authored entity with a runtime snapshot |
| `/worlds/{id}/entities/{id}/definition` | GET | raw `application/x-protobuf` | Verified canonical definition |
| `/worlds/{id}/entities/{id}/snapshot` | GET | JSON | Opaque runtime snapshot |
| `/worlds/{id}/entities/{id}/checkpoint` | PUT | `application/x-protobuf` envelope | Persist runtime state, optional definition |
| `/worlds/{id}/entities/{id}/run-state` | PUT | JSON | Start/stop with `expected_revision` |
| `/worlds/{id}/entities/execution-leases` | PUT | JSON | Claim the 8-second browser execution lease |
| `/worlds/{id}/entities/hosting/list` | GET | JSON | Requester's hosted jobs across the world plus global core capacity |
| `/worlds/{id}/entities/{id}/hosting` | GET/PUT | JSON, explicit credit budget + operation/epoch | Hosted status, Start, early Stop/release |
| `/markets/...`, `/api-keys`, `/api-usage` | — | JSON | Market, key management and allowances |

Entity definitions travel as raw `InventoryResource` v7 bytes: upload through the
`space_api.proto` envelope (`Content-Type: application/x-protobuf`), download as raw
protobuf. JSON `definition_base64` requests remain accepted for existing agents. See
[formats.md](formats.md).

Heartbeat responses fit the 16 MiB and 512-chunk client limits. `max_terrain_revision`
advances only past complete events. If one event spans several pages, echo the
opaque `terrain_cursor` alongside `since_terrain_revision` and the same terrain AOI
until the server returns a null cursor. Clear the cursor when the AOI changes.

Browser checkpoints for running entities, including a script stopping itself,
must include the current `execution_instance_id` and `execution_epoch`. The server
checks that this lease is still live and matches the authenticated holder account.
World-member entity operations do not check authorship: stopped/unoccupied entities
are editable by everyone, while an occupied entity requires its endpoint's proof.
Creator `owner_user_id` attribution stays unchanged; `execution_user_id` and
`executor_name` identify the actual operator. Market publisher permissions remain.
Stopped construction edits need no lease. Browser `/run-state` requests include
`execution_instance_id`; Start atomically sets the run bit and grants that endpoint's
lease under one row lock. Stop of a live browser entity also requires its current
`execution_epoch`. Delete supplies the same proof through
`X-Space-Execution-Instance` / `X-Space-Execution-Epoch` headers. Another endpoint,
including another tab of the same account or an administrator, receives
`409 ENTITY_OCCUPIED`; it cannot stop/delete/edit the occupied entity. API-key Start
can queue unoccupied running intent, but cannot acquire a browser lease or stop a
live browser executor. Server-hosted execution uses its separate hosting controls.
`/hosting/list` is polled independently every three seconds; it does not expand the
simulation AOI. Hosted status includes a safe `teleport_position` outside its bounded
activity area. Teleport moves the player AOI before asynchronous edited-terrain preload,
then places the player collision-safely in flight without changing camera orientation.
Hosting writes carry `operation_id` and `expected_execution_epoch` (not rapidly changing
pose revision); duplicate receipts never reopen stopped jobs. Early Stop uses
`release_to_browser:true`, preserves prepaid time, and makes the entity editable again.
Capacity is global: one pinned process/core per hosted entity, at most 128 slots and no
more than the advertised physical CPU capacity. See [hosting details](../../server/docs/entity-hosting.md).
The holder's Stop also sends `stop_pose` (`position`, `quaternion`) to atomically
save its current placement before resetting runtime defaults, rather than jumping
back to the previous checkpoint.
Owner replicas skip runtime autosaves, and the client freezes execution at lease
expiry even if polling fails or hangs. Lease validity is also checked before each
simulation frame after tab suspension. Newly created entities wait for their first lease.

Deploy the frontend and server together for this checkpoint contract change and
refresh existing browser tabs; older clients omit the required lease proof.

## Realtime relay (`space-relay-v1`)

The running channel is `/space/ws/v2` with the `space-relay-v1` MessagePack subprotocol
(`src/engine/network/MultiplayerSync.ts`, `entropydrop_backend/routers/space_realtime.py`).
Frames are binary MessagePack maps with a `type` string. There is no `.proto` for this
relay; the tables below are the schema.

Client → server:

| `type` | Fields |
| --- | --- |
| `hello` | `ticket` (string) — first frame, exchanged for admission |
| `pose` | `sequence` (int), `x_cm`/`y_cm`/`z_cm` (int cm), `yaw_q15`/`pitch_q15` (int −32767..32767) |
| `entity_pose` | `entity_id`, `instance_id` (UUID), `execution_epoch`, `sequence` (fixed-tick sequence), `bodies` |
| `ping` | `client_time` (any) — server supported; the current client does not send it |
| `leave` | none — frees the admission slot immediately |

Server → client:

| `type` | Fields |
| --- | --- |
| `hello` | `protocol`, `input_hz`, `snapshot_hz`, `persistence_seconds`, `entity_pose_hz` (20) |
| `state` | `server_tick` (int), `players` (array) at `snapshot_hz` |
| `entity_state` | `items` containing `entity_id`, `execution_epoch`, `sequence`, `revision`, `definition_digest`, `lease_expires_at`, `bodies` |
| `terrain` | `terrain_revision` (int) — invalidates the REST cursor |
| `pong` | `client_time` |

`state.players[]`: `user_id` (string, the Base58 account id), `username`, `player_entity_id`,
`skin_url` (≤4096), `skin_type` (`strong`/`slim`), integer `x_cm`/`y_cm`/`z_cm` in
centimetres, `yaw_q15`/`pitch_q15`, `is_self` (bool), `updated_at` (ISO string or null).
The client converts `yaw_q15 / 32767 * π` and drops out-of-range entries.

`bodies[]` has one entry per component, root first: `id`, `position` (world metres),
`quaternion` ([x,y,z,w]), `velocity` (m/s), `angularVelocity` (world radians/s).
Optional `collisionEnabled` (Boolean) follows runtime collision switches immediately.
Vectors must be finite and bounded, quaternions normalized, IDs unique; at most 128
bodies and 16 entity inputs per endpoint. The root height uses the player/runtime
height envelope and body centers stay within 256 m/root to bound collision work.
The relay reads current leases in one
narrow database query per active world tick before AOI fanout, fences old endpoints
and generations, and never forwards the private `instance_id` to observers.

The execution endpoint alone advances scripts, gravity, forces and constraints.
Replicas have a 100 ms bounded interpolation buffer (position lerp, shortest-arc
quaternion slerp, torus seam unwrapping), sampled before player collision on the
fixed 20 Hz clock. The same pose history feeds swept contacts and render interpolation.
Root and kinematic/dynamic child transforms are projected without enabling their
physics; contact velocity comes from the interpolated trajectory. No extrapolation:
an interrupted stream holds its last pose and clears contact motion. A live stream
or local executor is not teleported by older six-second durable checkpoint echoes.
Lease renewals, entity AOI/definitions and recovery snapshots still use REST.
Sequence spacing uses the source 50 ms tick clock, not bursty packet arrival times;
after a long pause/outage the buffer establishes a fresh time anchor. Realtime AOI
entry loads missing metadata by ID without waiting for a six-second position index
checkpoint, with bounded concurrency and retry frequency.

Hosting keeps its one-second atomic simulation/billing batches. Each successful
commit publishes all 50 ms body-pose samples through Redis; the API replays this
committed trajectory at 20 Hz. This deliberately retains roughly one batch of
hosting latency, without increasing database/billing write frequency. Uncommitted,
stopped or replaced batches are fenced. Cross-process hosting streaming requires
Redis fanout; when unavailable, durable snapshot polling remains the fallback.

Operational rules:

- 20 Hz changed-pose input, 10 Hz AOI snapshots, 5 s PostgreSQL position checkpoints.
- Server rejects ordinary frames over 4096 bytes; entity pose/internal hosted trajectory
  frames have a separate 64 KiB cap. It accepts binary messages only; the client caps
  frames at 1 MiB and closes with code 1009 on oversize.
- The client drops changed-pose frames while `WebSocket.bufferedAmount` exceeds 64 KiB
  instead of growing the send queue; the newest pose is re-sent on reconnect `hello`.
- The server sends one `state` per observer containing only players inside the wrapped AOI
  radius; Redis pub/sub fans out across instances.
- Up to four endpoint connections per account are allowed without replacing its existing
  executor socket. Presence remains one avatar/account and admission counts accounts;
  closing one tab releases admission only after its last endpoint disconnects.
- The client reconnects with exponential backoff (500 ms → 10 s) and re-sends its newest
  pose on `hello`.
- Queue packets are valid before `hello`; a queued socket has no entity or AOI
  subscription. The browser plays offline while queued and polls its one-based position.

## Contract tests

The frame names and field shapes above are pinned by shared wire fixtures rather than
prose alone:

- `test/fixtures/space-relay-v1.json` (this app) is generated by
  `node tools/generate-relay-fixtures.mjs` and verified by `test/space-relay-v1.test.ts`,
  including the live `encodePlayerPosition` / `parseRealtimePlayers` round trip and the
  4096-byte server inbound limit.
- A byte-identical copy lives in `entropydrop_backend/tests/fixtures/space-relay-v1.json`
  and is verified by `tests/test_space_relay_contract.py`, which also exercises the relay
  server's `_unpack_message` size gate. Re-run the generator after any relay schema change
  (the generator updates both workspace copies).

The authoritative `space.multiplayer.v2` protobuf protocol (zone workers, input batches,
AOI deltas, chunk snapshots) is target design and is not implemented. Do not assume those
messages exist on the wire.

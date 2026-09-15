# Entity hosting

The entity right-click menu uses English `Host…` and `Stop hosting` controls with
icons and visible captions. Hosting requires explicit confirmation of a maximum
**new credit budget** (1–168; default 1). It costs **1 credit/hour** of committed
simulation. Existing prepaid milliseconds survive pause, release and resumption;
stopping early does not refund an already consumed hour, but keeps its unused time.

HUD **Hosted Entities** lists the requesting account's enabled, starting and
automatically paused hosting jobs throughout the current world, including outside
the nearby simulation AOI. `Teleport` fetches a fresh destination, preloads edited
terrain and uses collision-safe placement in flight. `Stop` releases server execution
early and returns the entity to ordinary stopped/browser-editable mode.
The frontend shows hosting availability and active job counts, not the pool's
numeric ceiling or used/total capacity. Assigned core IDs remain visible.

## Capacity and authority

- One independent Node runtime process and one physical CPU reservation per hosted
  entity. Linux affinity is applied before sending guest input. Non-Linux development
  uses separate processes but cannot promise hard CPU affinity.
- `space_hosting_cores` contains exactly 128 slots (IDs 0–127). It is shared by all
  world coordinators on the hosting server, not 128 per account/world. Effective
  capacity is `min(128, available physical cores)` after cpuset, SMT-sibling and
  container CPU-time quota detection. Slot numbers in the UI are one-based.
- Allocation uses locked, skip-locked free/expired pool rows. A live reservation
  cannot be assigned to two entities. Stop fences late results immediately; a running
  slot remains occupied while its old process is killed/waited for before reuse.
  Core leases last 25 seconds, longer than the 15-second world lease and bounded
  10-second runtime IPC timeout. A dead coordinator cannot publish after lease expiry.
- World members may host any unoccupied entity regardless of authorship. Only the
  initiating account may change/stop its active paid hosting. A live browser executor
  must Stop first; the initiating browser automatically Stops its own execution
  before the confirmed handoff, but never stops another endpoint's execution.
- Hosted capacity does not consume the browser's 8-per-executor / 64-per-world
  running allowance. Existing bounds remain: 512 blocks, 8 components, bounded
  local geometry/activity area, 36 scene entities and terrain/storage/script quotas.
- Poses commit with billing and terrain state before 20 Hz realtime trajectory
  fanout. Other clients interpolate collidable proxies and do not compute scripts
  or physics for the hosted actor. Each core runs only its actor; independently
  simulated neighbors' pose-only commits are not static-scene revision conflicts.

## REST

All routes require normal Space account/API-key authentication and world membership.
Never expose private runtime stdin/stdout as an HTTP route.

`GET /space/api/v2/worlds/{world}/entities/hosting/list` returns `enabled`,
`worker_available`, global `capacity:{limit:128,total,used,available}`, and up to 256
owned hosting `items`, enabled first. Poll every three seconds independently of AOI.
Each status includes entity/world ID, name, position, safe `teleport_position`,
`core_id`, `can_manage`, `revision`, `execution_epoch`, `execution_mode`, `enabled`,
`state:starting|running|paused|unavailable`, budget/prepaid/billed hours and errors.

`GET /space/api/v2/worlds/{world}/entities/{entity}/hosting` returns fresh status
and the bounded script log/error/tick count, readable by any world member.

`PUT` to the same route accepts:

```json
{
  "operation_id": "new-random-uuid-per-intended-operation",
  "expected_execution_epoch": 4,
  "enabled": true,
  "max_credits": 1,
  "release_to_browser": false
}
```

For early Stop use `enabled:false`, `max_credits:0`, `release_to_browser:true`.
Epoch checks tolerate routine pose revisions while fencing changed execution.
Retain the same operation ID/payload for a transport retry; stored receipts do not
restart a subsequently stopped entity. Reusing an ID for a different payload is 409.
Start authorizes spending only after capacity and validation pass. Stop commits
locally without requiring a successful account-service RPC; the durable billing
outbox revokes/releases unused authorization/reservations when the worker recovers.

Failures shown by the frontend include 429 `HOSTING_CORES_FULL`, 503
`HOSTING_DISABLED` / `HOSTING_WORKER_UNAVAILABLE` / `HOSTING_CORE_UNAVAILABLE`,
402 `HOSTING_CREDITS_REQUIRED`, 409 `ENTITY_OCCUPIED` / `HOSTING_STATE_CHANGED`,
and 422 hosted-definition bounds/complexity limits. Asynchronous budget, membership,
runtime and scene failures remain visible on paused HUD rows.

## Start and rollout

1. Quiesce the old API and hosting worker before the schema migration. The deployment
   driver supports `--quiesce`; retain backups/old containers as usual.
2. From the workspace root, build `npm run build:server-runtime`. From `server/`,
   apply `python -m alembic -c space/alembic.ini upgrade head` (`space_0007`). Old
   enabled jobs pause with prepaid time preserved; they require explicit restart.
3. Configure the API **and** worker with `SPACE_HOSTING_ENABLED=true`, the existing
   trusted account service credentials, DB/Redis endpoints and world IDs. Backend
   default remains false; displaying controls never implicitly enables purchases.
4. From `server/`, run `python -m space.hosting_worker` as a separate supervised
   process/container. A native runtime probe must succeed before capacity is
   advertised. A machine with fewer than 128 physical cores advertises fewer slots.
5. Verify the list endpoint reports a live worker, actual cores and valid statuses.
   Coordinate frontend/server deployment; no physical-core reservation may be
   fabricated by the frontend. Restart old browser tabs for the metadata contract.

Downgrade refuses occupied reservations. Stop jobs and drain their processes first.

## Development troubleshooting

Starting Vite alone does not start or enable hosting. Hosting needs an online world,
an API and a separate live worker, with `SPACE_HOSTING_ENABLED=true` on **both**.
If only the worker is enabled, the API rejects Start with `HOSTING_DISABLED` even
when the worker heartbeat is healthy. The disabled default is intentional because
hosting spends credits; frontend controls do not opt a backend into purchases.

Check the running release and `space_alembic_version` as well as the environment
flags. A development database at `space_0004` is too old for the current execution
authority and dedicated-core contracts: upgrade the API/runtime/worker together
and migrate through `space_0007` using the rollout procedure above. Never just
switch on an old API while pointing a new frontend at it.

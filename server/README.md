# Space server

Run from this directory with Python 3.10+:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
# From the workspace root: npm ci && npm run build:server-runtime
.venv/bin/python -m pytest
.venv/bin/uvicorn space.main:app --host 127.0.0.1 --port 8001
```

The process always uses its own world database. `space/integrations/account_client.py`
calls the account API for identity and credit reservations; login secrets, API-key
records and authoritative balances never enter the Space schema.
`space/integrations/object_store.py` stores Market protobuf objects on the mounted
Space volume. `space/billing.py` owns the durable reservation/capture outbox.

The root `npm run check` includes Python tests and contract freshness checks.
Set `SPACE_PYTHON` when using an interpreter outside `server/.venv`. Optional real
PostgreSQL concurrency checks run when `SPACE_TEST_POSTGRES_URL` names a test
database; they create and remove a unique schema for each test.

Set `DATABASE_URL`, `REDIS_URL`, `SPACE_ACCOUNT_API_URL`,
`SPACE_ACCOUNT_SERVICE_TOKEN`, `SPACE_JOIN_TICKET_SECRET`, `SPACE_OBJECT_DIR`,
`SPACE_PUBLIC_API_URL`, and browser `CORS_ORIGINS`/`SPACE_WS_ALLOWED_ORIGINS`.
The internal account endpoint requires the same service token on both sides.
`SPACE_STANDALONE=false` is rejected. Paid hosting remains opt-in.

The existing migration chain and table names are preserved. Run
`python -m alembic -c space/alembic.ini upgrade head` before starting the updated API
and hosting workers. `space_0010` admits unified Item market resources while
preserving existing objects and their digests. Apply it before publishing Items.
`space_0006` adds the actual execution-holder account separately
from creator attribution and backfills older browser/hosting leases. World members
operate unoccupied entities equally; only market resources retain publisher checks.
`space_0007` creates the global 128-slot physical-core pool and adds per-entity core
assignments. Stop the old API/worker before migrating (`deploy_space.py --quiesce`);
previous hosting jobs pause with prepaid time preserved and require explicit restart.
The new worker probes its runtime, detects cpuset/physical cores/container CPU quota,
and advertises the actual capacity. Linux entity processes bind to their assigned CPU;
non-Linux development uses separate processes without hard affinity. See the
[hosting controls and deployment guide](docs/entity-hosting.md).
The ephemeral entity-to-entity message API is described in
[entity-messaging.md](docs/entity-messaging.md).
Development deploys reuse the existing isolated volumes.

Monitoring workers retain separate minute buffers and publish cumulative latency
counters to shared Redis every five seconds. Atomic, per-worker updates make retries
idempotent; completed-minute snapshots are stored in the world database without
allowing a delayed, smaller sample count to overwrite the aggregate. Monitoring reads
refresh history from that shared database. Redis outages retain unpublished samples
for retry within the 24-hour window. This aggregation change needs no schema migration.

Build the server image from the workspace root with
`docker build -f deploy/Dockerfile --target runtime .`. This requires only Space;
neither a backend nor frontend checkout is included in the image.

Schema revision `space_0012` adds expiring per-zone generation leases. Upgrade the
schema before running the new API/worker. Generation copies its inputs and releases
the database transaction before invoking the runtime or compressing LODs. Publication
briefly locks only the target world and verifies its configuration, terrain revision,
and lease token; expired or superseded work cannot overwrite a newer result.

Surface generation and LOD use the engine's shared WASM kernels through Wasmtime;
Copper's TypeScript grammar uses the same kernels in the Node surface runtime.
Install the pinned Python requirements when updating. Existing terrain snapshots
remain readable. See [kernel controls and benchmarks](../engine/wasm/README.md).

After changing Copper's generation grammar, update the development terrain and
hosting runtime bundles, then clear only that world's generated far-surface cache:

```sh
# Run inside the development API container, or server/ with its environment.
PYTHONPATH=. python tools/clear_copper_surface_cache.py --dry-run
PYTHONPATH=. python tools/clear_copper_surface_cache.py
```

The command requires the development environment and the configured Copper world
(generator version 2). It retains authored chunk edits and other world data.
The API's background job rebuilds the snapshots from the updated grammar, starting
at spawn. New snapshot digests automatically replace browser disk-cache entries;
Redis does not hold this terrain cache.

Terrain edit AOIs can be rectangular: `GET /worlds/{id}/terrain-edits` accepts
`radius_chunks_z` alongside the existing X radius `radius_chunks`; heartbeat
accepts the matching `terrain_radius_chunks_z`. Omitting Z retains the original
square window for older clients. Both axes wrap independently. The browser uses
X/Z snapshot radii 16/12 and maximum detailed radii 16/6. Detailed meshes are
clipped to the last synchronized AOI; its unsynchronized fringe stays in far
LOD while the next tiled snapshot loads. Nearby terrain defaults to radii 8/4; far
surface snapshots still cover the world, including when flying above the tube.


Agent connection discovery is public at `GET /space/api/v2/agent/authorization`.
Authenticated world discovery is `GET /space/api/v2/worlds`. The default world is
Nature (`nature`, legacy alias `default`). Copper Metropolis (`copper-metropolis`)
is also published in production; other named terrain-lab worlds remain development-only.
Resolve through `GET /worlds/{slug_or_uuid}` and explicitly
join with `POST /worlds/{slug_or_uuid}/join` when needed. Joining requires no online
browser and does not create a position checkpoint. Position queries accept
`?world={slug_or_uuid}`; omitting it continues to select Nature. Operational paths
use the resolved UUID. The public [world guide](space/agent/worlds.md) describes
membership, environment availability, world isolation and retry behavior.
Set `SPACE_ACCOUNT_PUBLIC_API_URL` if the agent-reachable account origin differs
from `SPACE_ACCOUNT_API_URL`; the latter is the default. The account backend must
include its agent-authorization migration and endpoints, and the main site must
serve `/space/authorize`. Account-side `SPACE_AGENT_VERIFICATION_URI` selects the
consent page (use the local frontend URL in development). Space stores no pairing
codes or account keys. Deploy all three applications together for the new Prompt.

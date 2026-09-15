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

Set `DATABASE_URL`, `REDIS_URL`, `SPACE_ACCOUNT_API_URL`,
`SPACE_ACCOUNT_SERVICE_TOKEN`, `SPACE_JOIN_TICKET_SECRET`, `SPACE_OBJECT_DIR`,
`SPACE_PUBLIC_API_URL`, and browser `CORS_ORIGINS`/`SPACE_WS_ALLOWED_ORIGINS`.
The internal account endpoint requires the same service token on both sides.
`SPACE_STANDALONE=false` is rejected. Paid hosting remains opt-in.

The existing migration chain and table names are preserved. Run
`python -m alembic -c space/alembic.ini upgrade head` before starting the updated API
and hosting workers. `space_0006` adds the actual execution-holder account separately
from creator attribution and backfills older browser/hosting leases. World members
operate unoccupied entities equally; only market resources retain publisher checks.
`space_0007` creates the global 128-slot physical-core pool and adds per-entity core
assignments. Stop the old API/worker before migrating (`deploy_space.py --quiesce`);
previous hosting jobs pause with prepaid time preserved and require explicit restart.
The new worker probes its runtime, detects cpuset/physical cores/container CPU quota,
and advertises the actual capacity. Linux entity processes bind to their assigned CPU;
non-Linux development uses separate processes without hard affinity. See the
[hosting controls and deployment guide](docs/entity-hosting.md).
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

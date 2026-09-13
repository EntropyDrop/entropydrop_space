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

The existing `space_0001`–`space_0004` migration chain and table names are preserved:
`python -m alembic -c space/alembic.ini upgrade head`. No new data migration is
introduced by extraction. Development deploys reuse the existing isolated volumes.

Build the server image from the workspace root with
`docker build -f deploy/Dockerfile --target runtime .`. This requires only Space;
neither a backend nor frontend checkout is included in the image.

# Production release gates

Use the existing account virtualenv and the DS proxy described in
[deployment setup](../deploy/README.md). All publication and verification HTTP
requests use `http://127.0.0.1:19100`.

```sh
../entropydrop_backend/venv/bin/python tools/build_prod_domain.py
../entropydrop_backend/venv/bin/python tools/deploy_space.py prod
../entropydrop_backend/venv/bin/python tools/deploy_domain.py prepare --release <new-release-id>
../entropydrop_backend/venv/bin/python tools/deploy_domain.py upload-main
```

Build with `build_prod_domain.py` so both applications receive the explicit
production account/Google configuration. A missing generated page or referenced
asset fails preflight. Static publication takes a private build snapshot and a
local writer lock; changes to the working build cannot mix files within a run.
The Space build also evaluates the emitted simulation, script runtime and SDK
chunks in separate Node processes. Both import orders must succeed: a circular
chunk dependency can initialize correctly from simulation but fail when the
application imports the runtime first. This gate catches module initialization
errors; it does not replace checking the actual production entry in a browser.

`prepare` now **uploads before switching** the Space origin. It retains previous
immutable assets for open browser tabs, checks staged objects against the build,
then changes only `space-static.OriginPath` using the distribution's ETag. Reusing
the active release identifier or changing bytes within an existing release fails.
The old `upload-space` command verifies the active release and cannot overwrite it.
Initial creation still requires the separate `activate` DNS step.

`upload-main` publishes assets before HTML, synchronizes every managed extensionless
Space page with its generated `index.html`, and publishes the managed router.
It checks that every affected CloudFront behavior uses that router. `/space/app`
and its descendants redirect through the main login page to the standalone client,
preserving the selected world and repeated query parameters. Existing objects use
conditional writes; conflicting immutable assets fail instead of being overwritten.
Unrelated bucket objects and old assets are retained.

Both release paths wait for CloudFront deployment and cache invalidation, with a
900-second timeout (`--timeout` overrides it). Success then requires exact SHA-256
matches for the live entry pages and **all current assets**, using normal URLs
without cache-busting. Main-site checks cover all three page forms: extensionless,
trailing slash, and explicit `index.html`, plus legacy login redirects. A 200
response containing old HTML is a failure. Exceptions exit nonzero; an upload or
healthy API alone is not release completion.

Read-only re-verification is available without republishing:

```sh
../entropydrop_backend/venv/bin/python tools/deploy_domain.py verify-main
../entropydrop_backend/venv/bin/python tools/deploy_domain.py verify-space
```

The DS server deployment runs `space.release_check` after migrations and before
replacing API/worker containers. It requires the migration head, available Nature,
Copper and Aether configurations, and valid byte lengths, SHA-256 hashes and decoding for
every stored entity definition and snapshot. The PostgreSQL transaction is read-only;
worlds are not provisioned by this check. After validation, the deployment
provisions any missing published worlds
before starting the worker, which discovers its world coordinators at startup.
Existing world identities, seeds and edits are preserved. Failure leaves old containers
in place unless `--quiesce` intentionally stopped writers for a breaking migration.
It does not automatically restore a database over live writes.

Static evidence lives under `.local/domain-migration/releases/<run>/`: the build
manifest, previous HTML/object bytes and metadata, previous router code, distribution
configuration, the object write plan (including newly created keys), activation
details and successful verification report. A missing
`verification.json` means the run has not passed acceptance. Preserve these files
for rollback; do not commit them. Restore a saved Space OriginPath with the current
distribution ETag, or restore the backed-up main-site HTML/router, then invalidate
and verify. Newly created HTML aliases are listed with `previous_etag: null`; during
rollback, remove only those aliases whose current bytes still match the write plan,
or point them at the restored entry. Keep immutable assets for open tabs. Never roll
back mutable application data as part of a static rollback.

These gates verify public delivery and persisted data, not an authenticated browser
session. Releases that change login, world entry or entity loading also need a real
browser check of all three published worlds; API readiness and HTML hashes do not prove
that login or in-game interactions work.

Offline regression checks:

```sh
../entropydrop_backend/venv/bin/python -m unittest discover -s tools -p 'test_deploy_*.py'
cd server
ENV_FILE=/nonexistent DATABASE_URL=sqlite:///:memory: ENVIRONMENT=test \
  SPACE_JOIN_TICKET_SECRET=test-space-release-secret \
  ../../entropydrop_backend/venv/bin/python -m pytest tests/test_release_check.py tests/test_entity_download_digest_migration.py
```

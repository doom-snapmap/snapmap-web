# Worker tests

## Purpose

Checks the API Worker's request-body bounds, write quotas and local runtime behavior without touching GitHub or deployed storage.

## Contents

- `worker_body_test.js` covers streamed body limits, JSON validation, CORS on refusals, upload overflow and quota refusals.
- `worker_quota_test.js` covers the SQLite quota store's atomic admission and rollback.
- `worker_mods_test.js` covers every `/mods/*` route against in-memory R2 and SQLite-backed Durable Object doubles: a unit begun, its files sent in archives and in parts, status, the manifest, blob and archive reads with ranges (an archive read in a few long ranges), the manifest and archive checks and their one-sentence refusals, signed claims with revs and releases, the 24-hour deletion delay and the purge, a remix's second claim, moderation (block, unblock, release-ref), the first-come account name and forget-key, asked paths, per-key and per-address limits, repair of a missing pack, the retired routes (410), the tables of earlier stores dropped, and the reset.
- `worker_contract_test.js` runs, under Miniflare, every exchange the product's map-content client makes, in the shape `contract/client.json` records from the product's source and from a run of its own client (`tests/unit_roundtrip.c` there), signed as the product signs, and checks each answer against what the client accepts.
- `worker_runtime_test.js` runs the Worker under Miniflare with local KV, R2 and Durable Objects, checking concurrent per-account quotas, persistence across restarts, and a unit's upload (an archive and a file in parts), reads and claims across a restart.
- `worker_purge_test.js` runs, under Miniflare with a short `MODS_DELETE_DELAY_MS` as on staging, a map published, unpublished and purged through `POST /mods/admin/purge`, and checks the store's stats and its bucket are empty afterwards; that a file another unit still names survives the purge of one; that a unit claimed again within its delay is kept; and that without the variable the purge keeps 24 hours and the route needs the maintainer token.
- `worker_rows_test.js` measures, under Miniflare, the rows the mod store's Durable Objects write (as the platform counts them, `api/sql_meter.js`) for a map publish of one unit of N files and a player's download of it in one request, against the file-by-file download it replaced. It is a measurement, not run by CI: `node tests/worker_rows_test.js build/worker-tests/node_modules/miniflare [files] [worker root]`.

## Working here

From the repository root, with Node 22.13 or newer:

```text
node tests/worker_body_test.js
node tests/worker_quota_test.js
node tests/worker_mods_test.js
npm install --prefix build/worker-tests --no-audit --no-fund --no-package-lock miniflare@4.20260730.0
node tests/worker_runtime_test.js build/worker-tests/node_modules/miniflare
node tests/worker_contract_test.js build/worker-tests/node_modules/miniflare
node tests/worker_purge_test.js build/worker-tests/node_modules/miniflare
```

CI runs all six. When the product's client changes, record its exchanges again (`contract/README.md`) and update `contract/client.json` with the Worker change that follows it. Preserve fixture data unless intentionally changing the case it represents.

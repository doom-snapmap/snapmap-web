# Worker tests

## Purpose

Checks the API Worker's request-body bounds, write quotas and local runtime behavior without touching GitHub or deployed storage.

## Contents

- `worker_body_test.js` covers streamed body limits, JSON validation, CORS on refusals, upload overflow and quota refusals.
- `worker_quota_test.js` covers the SQLite quota store's atomic admission and rollback.
- `worker_mods_test.js` covers every `/mods/*` route's success and refusal paths, the build archive checks (the product's archive after the 1.0 rules, with no mod version, and its Lua scripts), that every refusal is one plain sentence, takedown, per-address limits, claims, release, the serving window, purge and reset, with in-memory R2 and SQLite-backed Durable Object doubles.
- `worker_runtime_test.js` runs the Worker under Miniflare with local KV, R2 and a Durable Object, checking concurrent per-account quotas, persistence across restarts, and that R2 never commits a refused build archive.

## Working here

From the repository root, with Node 22.13 or newer:

```text
node tests/worker_body_test.js
node tests/worker_quota_test.js
node tests/worker_mods_test.js
npm install --prefix build/worker-tests --no-audit --no-fund --no-package-lock miniflare@4.20260730.0
node tests/worker_runtime_test.js build/worker-tests/node_modules/miniflare
```

CI runs all four. Preserve fixture data unless intentionally changing the case it represents.

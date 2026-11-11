# Worker tests

## Purpose

Checks the API Worker's request-body bounds, write quotas and local runtime behavior without touching GitHub or deployed storage.

## Contents

- `worker_body_test.js` covers streamed body limits, JSON validation, CORS on refusals, upload overflow and quota refusals.
- `worker_quota_test.js` covers the SQLite quota store's atomic admission and rollback.
- `worker_mods_test.js` covers every `/mods/*` route's success and refusal paths, the build archive checks (the product's archive after the 1.0 rules, with no mod version, and its Lua scripts and their count), that every refusal is one plain sentence, takedown, uploads in parts (resume, the same checks, cleanup of an abandoned upload), the release racing an upload, no limits (20,000 files, a 600-build claim, a 1.2 GiB archive streamed through the check), claims, release, the serving window, purge and reset, with in-memory R2 (multipart included) and SQLite-backed Durable Object doubles.
- `worker_runtime_test.js` runs the Worker under Miniflare with local KV, R2 and a Durable Object, checking concurrent per-account quotas, persistence across restarts, that a refused build archive is never kept, the scripts count, the release race, and an upload in parts resumed and read back; with a size in GiB as its second argument it also sends a generated build of that size in parts.

## Working here

From the repository root, with Node 22.13 or newer:

```text
node tests/worker_body_test.js
node tests/worker_quota_test.js
node tests/worker_mods_test.js
npm install --prefix build/worker-tests --no-audit --no-fund --no-package-lock miniflare@4.20260730.0
node tests/worker_runtime_test.js build/worker-tests/node_modules/miniflare
node tests/worker_runtime_test.js build/worker-tests/node_modules/miniflare 1.2
```

CI runs all four. Preserve fixture data unless intentionally changing the case it represents.

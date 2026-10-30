# API service

## Purpose

Serves the website's Community pages through GitHub Discussions on this repository, handles GitHub sign-in, stores uploaded screenshots and hosts the anonymous Snapmap+ mod asset store. Deployed as the Cloudflare Worker `snapmap-plus-community` at `https://api.snapmapplus.com`.

## Contents

- `worker.js` defines the HTTP API, authentication, discussion operations and media handling.
- `quota.js` and `quota_store.js` coordinate write limits across a user's sessions, and mod store limits per hashed client address.
- `mods_store.js` defines the `/mods/*` routes, bundle manifest validation and the scheduled purge.
- `mods_registry.js` and `mods_registry_store.js` hold the mod store index and its anonymous claims.
- `wrangler.toml` binds `SESSIONS` KV, `MEDIA` and `MODS` R2, the SQLite `WRITE_QUOTAS` and `MOD_REGISTRY` Durable Objects, the `MODS_BLOCKED` variable and the daily purge trigger.
- `request_body.js` bounds request bodies before parsing or uploading.

## Working here

Reads use a GitHub App installation token, with an optional `GITHUB_TOKEN` fallback. Writes use the signed-in user's token stored in KV; the browser receives an opaque session ID. Configure `APP_ID`, `APP_PRIVATE_KEY` (PKCS#8) and `CLIENT_SECRET` as Worker secrets. `TURNSTILE_SECRET` enables the optional challenge on supported write routes.

For a fork, provision your own KV namespace and R2 bucket, set the App callback URL to this Worker's `/auth/callback`, and update the repository, App client ID and site-origin constants, and point the `routes` custom domain in `wrangler.toml` at a zone on your Cloudflare account. Keep the Worker URL in `site/assets/community.js` aligned. CORS admits the configured site and local HTTP development origins.

Writes share a fixed UTC-hour quota per GitHub account: 10 posts, 60 comments,
120 reactions, 30 uploads, 120 previews and 60 edits/deletions. Counters are atomic
and persist across restarts; signing in again does not reset them. Quota exhaustion
returns 429, and unavailable quota storage returns 503. The first deployment of
this configuration provisions `CommunityQuota` through its recorded migration;
deploy the binding and code together. KV is used for sessions and OAuth state.

JSON requests are limited to 384 KiB and images to 8 MiB of actual streamed bytes.
Malformed JSON or UTF-8 returns 400; oversize bodies return 413. Health is exposed
at `GET /`. Preview locally before a maintainer deploys. See the
[service inventory](../docs/services.md) and [website source](../site/README.md).

Deploy from this directory with `npx wrangler deploy` after `npx wrangler login`. Secrets (`APP_ID`, `APP_PRIVATE_KEY`, `CLIENT_SECRET`, optional `GITHUB_TOKEN` and `TURNSTILE_SECRET`) are set once with `npx wrangler secret put` and survive redeploys.

From the repository root, run `node tests/worker_body_test.js`,
`node tests/worker_quota_test.js` and `node tests/worker_mods_test.js` with Node 22.13 or newer. The optional local
Cloudflare runtime check is `node tests/worker_runtime_test.js <miniflare-module-path>`;
it uses Miniflare 4.20260730.0 and never calls GitHub or deployed storage.

## HTTP routes

| Method and path | Purpose |
|---|---|
| `GET /auth/login`, `/auth/callback`, `/auth/me` | Start sign-in, finish it, or read the current session. |
| `POST /auth/logout` | Remove the current session. |
| `GET /community/categories`, `/community/discussions`, `/community/search` | Browse and search Discussions. |
| `GET /community/discussions/:number` | Read a discussion and its comments. |
| `POST /community/discussions` | Create a discussion. |
| `POST /community/discussions/:number/comments` | Add a comment. |
| `PATCH` or `DELETE /community/discussions/:number` | Edit or delete an owned discussion. |
| `PATCH` or `DELETE /community/comments/:id` | Edit or delete an owned comment. |
| `POST /community/reactions`, `/community/preview` | React to content or preview Markdown. |
| `POST /media/upload`, `GET /media/:key` | Store or retrieve a screenshot. |
| `POST /mods/missing` | Report which of up to 4096 blob hashes the mod store lacks. |
| `PUT`, `GET` or `HEAD /mods/blob/:sha256` | Store or fetch one cooked file by the SHA-256 of its bytes. |
| `PUT`, `GET` or `HEAD /mods/bundle/:hash` | Store or fetch a bundle manifest by the SHA-256 of its canonical text. |
| `POST /mods/claim`, `/mods/release` | Hold or drop an anonymous claim that keeps bundles served. |

Community write routes require a session; `/mods/*` routes are anonymous. Read `worker.js` for payloads, limits and the
additional ownership or moderator checks on editing and deletion.

## Mod asset store

The Snapmap+ product uploads the mod bundles a published or hosted map needs and
downloads them by hash when a player loads that map. Nothing is browsable and
nothing needs an account, session, OAuth or Turnstile: an object is reachable
only by its hash. Native clients send no `Origin`, so these routes need no CORS
header; browser callers get the same allowlist as the rest of the API.

R2 bucket `snapmap-plus-mods` (binding `MODS`) holds `blob/<sha256>`, one cooked
file per distinct byte content, and `bundle/<hash>`, a manifest whose hash is the
SHA-256 of its canonical text. The single `ModRegistry` Durable Object (binding
`MOD_REGISTRY`, object name `registry`) indexes both, records which blobs each
bundle names and holds claims, so claim counts, references and purges are
decided in one transaction.

- `POST /mods/missing` takes `{"blobs":[sha...]}`, at most 4096, and returns
  `{"missing":[...]}` in request order. Blocked and mid-purge blobs count as missing.
- `PUT /mods/blob/:sha256` needs `Content-Type: application/octet-stream` (else 415)
  and `Content-Length` (else 411), at most 64 MiB (else 413). The body streams
  straight to `blob/<sha256>` with that hash as R2's `sha256` checksum, so R2 refuses
  to commit mismatched bytes; the Worker hashes the same stream with `DigestStream`
  to answer 422. An existing blob answers 200 after the body is read and discarded,
  so a client mid-upload sees the answer rather than a reset; a new one answers 201.
  Either way the declared length counts toward the hourly byte limit.
- `PUT /mods/bundle/:hash` takes the canonical manifest text, at most 1 MiB:
  UTF-8 JSON, keys sorted at every level, no whitespace, `files` sorted by `path`,
  `JSON.stringify` escaping, `bundle` omitted or equal to the path hash. A
  pretty-printed or otherwise non-canonical body is refused with 422 so that every
  reader parses exactly the bytes that were hashed. The Worker checks the hash, the
  format, the id grammar, the required integer `build` (1 to 2147483647), the
  optional `version`, display fields, request paths (lowercase,
  relative, no `..`, no backslash, whitelisted extension), the path to request
  mapping, the declared logical name, the `mods/<id>/` namespace unless the request
  is a declared shadow, and the caps (4096 files, 64 MiB per file, 256 MiB total),
  answering 422 with the first cause. Blobs it names must already be stored with the
  declared sizes (409 with up to 100 missing hashes and `missingCount`). The stored
  object is the request body. A new bundle answers 201, an existing one 200.
- `GET` and `HEAD` on either object return it with
  `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`,
  a `default-src 'none'; sandbox` CSP, `Content-Disposition: attachment` and the hash
  as the ETag.
- `POST /mods/claim` takes `{"ref","bundles":[hash...]}` (ref 1-64 characters, at
  most 256 known bundles) and returns 201 `{"claim","secret"}`. The registry stores
  only the SHA-256 of the secret. Sending `{"ref","bundles","secret"}` with an existing
  claim's ref and secret replaces that claim's bundle set and returns 200 with the
  same claim; a secret matching no claim for that ref is 403. Unknown bundles are 409.
- `POST /mods/release` takes `{"claim","secret"}` and returns 204; a wrong secret is
  403 and an unknown claim 404. Releasing drops the claim and its counts.

A bundle is served while its claim count is positive or for one hour after its
upload (the time a publish needs between its `PUT`s and its claim). A blob is
served for one hour after its upload, and afterwards while any claimed bundle
names it. Otherwise both answer 404. Deletion is immediate: the release that
drops a bundle's last claim (`POST /mods/release`, or a re-claim that leaves the
bundle out) removes it from the index and the bucket at once and sweeps blobs
past the hour that no remaining bundle names. The daily cron (`[triggers]` in
`wrangler.toml`) only collects uploads nothing ever claimed: unclaimed bundles
past the hour first, then blobs past the hour that no bundle names. Blobs are
marked in the registry before deletion; marked blobs read as missing, refuse new
bundle registrations with 409 and answer blob uploads with 503 and `Retry-After`,
so a new bundle can never come to depend on a blob that is about to disappear.
Each run handles at most 10,000 bundles and 10,000 blobs and the next run
continues.

`POST /mods/admin/reset` empties the store: every blob and bundle object and the
whole index. It exists only when the `MODS_ADMIN_TOKEN` secret is set
(`npx wrangler secret put MODS_ADMIN_TOKEN`) and needs `Authorization: Bearer
<token>`; otherwise it answers 404 or 403. It returns the counts deleted.

Hourly limits per client address and UTC hour: 2048 blob uploads, 4 GiB of
declared upload bytes, 64 bundle uploads, 20,000 reads (blob and bundle `GET` or
`HEAD`, and `POST /mods/missing`) and 64 claim or release calls. Exhaustion
returns 429 with `Retry-After`. The counters live in `WRITE_QUOTAS` objects named
`mods-address:<digest>`; the raw address is never stored. IPv6 addresses are keyed
by their /64. Set the optional secret `MODS_ADDRESS_KEY` to make the digest an
HMAC that cannot be reversed by enumerating addresses. Uploads, claims and the
missing query fail closed with 503 when quota storage is unavailable; reads fail
open.

Takedown is the `MODS_BLOCKED` variable in `wrangler.toml`: a JSON array of blob
or bundle hashes. Edit it and redeploy. Every route answers a blocked hash with
451 and the blocked list, including bundle uploads that name a blocked blob and
claims of a blocked bundle. A malformed list fails closed with 503.

Before the first deployment of this configuration, create the bucket with
`npx wrangler r2 bucket create snapmap-plus-mods`. The `v2-mod-registry`
migration provisions `ModRegistry`; deploy the bindings and code together.

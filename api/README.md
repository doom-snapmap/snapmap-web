# API service

## Purpose

Serves the website's Community pages through GitHub Discussions on this repository, handles GitHub sign-in, stores uploaded screenshots and hosts the anonymous Snapmap+ mod store. Deployed as the Cloudflare Worker `snapmap-plus-community` at `https://api.snapmapplus.com`.

## Contents

- `worker.js` defines the HTTP API, authentication, discussion operations and media handling.
- `quota.js` and `quota_store.js` coordinate write limits across a user's sessions, and mod store limits per hashed client address.
- `mods_store.js` defines the `/mods/*` routes, the streamed check of each build archive and the scheduled purge.
- `mods_registry.js` and `mods_registry_store.js` hold the mod store index and its anonymous claims.
- `wrangler.toml` binds `SESSIONS` KV, `MEDIA` and `MODS` R2, the SQLite `WRITE_QUOTAS` and `MOD_REGISTRY` Durable Objects, the `MODS_BLOCKED` variable and the daily purge trigger.
- `request_body.js` bounds request bodies before parsing or uploading.

## Working here

Reads use a GitHub App installation token, with an optional `GITHUB_TOKEN` fallback. Writes use the signed-in user's token stored in KV; the browser receives an opaque session ID. Sign-in binds its OAuth state to the starting browser with a short-lived cookie scoped to `/auth/callback`, so a callback link from another browser is refused. A session lasts 30 days but never past the GitHub refresh token behind it: an expiring user token is renewed shortly before it lapses, and a session whose token can no longer be renewed is removed, which the page shows as signed out. Configure `APP_ID`, `APP_PRIVATE_KEY` (PKCS#8) and `CLIENT_SECRET` as Worker secrets. `TURNSTILE_SECRET` enables the optional challenge on supported write routes.

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
| `PUT`, `GET` or `HEAD /mods/build/:hash` | Store or fetch one mod build's archive by its build hash. |
| `POST /mods/claim`, `/mods/release` | Hold or drop an anonymous claim that keeps builds served. |
| `POST /mods/admin/reset` | Empty the mod store (maintainer only, hidden without its secret). |

Community write routes require a session; `/mods/*` routes are anonymous. Read `worker.js` for payloads, limits and the
additional ownership or moderator checks on editing and deletion.

## Mod store

The Snapmap+ product uploads one archive for each mod a published map declares and
downloads it by its build hash when a player loads that map. Nothing is browsable and
nothing needs an account, session, OAuth or Turnstile: an object is reachable only by
its hash. Native clients send no `Origin`, so these routes need no CORS header; browser
callers get the same allowlist as the rest of the API.

R2 bucket `snapmap-plus-mods` (binding `MODS`) holds `build/<hash>`, one archive per
build. The single `ModRegistry` Durable Object (binding `MOD_REGISTRY`, object name
`registry`) indexes the builds (`mod_build`: hash, size, salt, upload time, claim count)
and holds the claims (`mod_claim`, `mod_claim_build`), so claim counts, releases and
purges are decided in one transaction. The tables of the earlier blob and bundle store
are dropped when the object starts.

An archive is the mod's folder as the product's `modzip.c` writes it: a ZIP of stored
entries (method 0) holding `mod.json`, the whole file, and `assets/<request>` for every
carried file its builder block lists, nothing else. Stock pointers never upload: the
player's own game holds them. The Worker does not recompute the build hash; the client
checks every file's SHA-256 and the canonical hash against the map before it installs
anything.

- `PUT /mods/build/:hash` needs `Content-Type: application/zip` (else 415) and
  `Content-Length` (else 411), at most 96 MiB (else 413; under the 100 MB request body
  limit of the Free and Pro plans). The body streams to `build/<hash>` while the Worker
  reads it as a ZIP, holding only headers, the central directory and `mod.json`. It
  refuses with 422 and the first cause: a body that is not a ZIP; bytes before, between
  or after the entries; a ZIP64 or split archive; a compressed or encrypted entry; an
  entry without its sizes in the local header; two entries of one name; a central
  directory or end record that disagrees with the entries; a `mod.json` that is missing,
  over 1 MiB, not UTF-8 JSON, without a `snapmap-plus` block of `format` 2, without a
  valid `salt` (`[a-z][a-z0-9]{7}`), or whose `build` is not the path hash; a
  `requirements` member outside the builder's shape; an entry outside `assets/`; a
  request path that is not lowercase, has a `..`, `.` or empty segment, a backslash or
  an extension outside the whitelist (a `.mega2` only as
  `virtualtextures/mods/<salt>/<family>_sq<1..16>.mega2`, never a `_vmtr` family); an
  entry `files` does not list, a listed file the archive lacks, or an entry whose size
  differs from `files`. R2 commits an object once it has its declared length, so the
  archive's tail is passed on only after every check has passed: a refused archive is
  never committed. A new build answers 201 `{"build","size"}`. An existing one answers
  200 with the stored size after the body is read and discarded, and restarts the upload
  window of a build nothing claims. An unclaimed archive of another size is replaced by
  an upload that validates (201), so a forged archive cannot hold a hash against the
  real one; a claimed archive is never replaced. The declared length counts toward the
  hourly byte limit.
- `GET` and `HEAD /mods/build/:hash` return the archive with `Content-Type:
  application/zip`, its `Content-Length`, `Cache-Control: public, max-age=31536000,
  immutable`, `X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox` CSP,
  `Content-Disposition: attachment` and the hash as the ETag.
- `POST /mods/claim` takes `{"ref","builds":[hash...]}` (ref 1-64 characters, at most
  256 stored builds) and returns 201 `{"claim","secret"}`. The registry stores only the
  SHA-256 of the secret. One claim stands for one published item: sending
  `{"ref","builds","secret"}` with an existing claim's ref and secret replaces that
  claim's build set and returns 200 with the same claim and secret; a secret matching no
  claim for that ref is 403. Unknown builds are 409 `{"error","missing","missingCount"}`.
- `POST /mods/release` takes `{"claim","secret"}` and returns 204; a wrong secret is 403
  and an unknown claim 404.

A build is served while a claim names it or for one hour after its upload (the time a
publish needs between its `PUT`s and its claim); otherwise it answers 404. Deletion is
immediate: the release that drops a build's last claim (`POST /mods/release`, or a
re-claim that leaves the build out) removes it from the index and the bucket at once.
The daily cron (`[triggers]` in `wrangler.toml`) only collects uploads nothing ever
claimed, past the hour, at most 10,000 per run; the next run continues.

Hourly limits per client address and UTC hour: 64 build uploads, 4 GiB of declared
upload bytes, 20,000 reads (`GET` or `HEAD`) and 64 claim or release calls. Exhaustion
returns 429 with `Retry-After`. The counters live in `WRITE_QUOTAS` objects named
`mods-address:<digest>`; the raw address is never stored. IPv6 addresses are keyed by
their /64. Set the optional secret `MODS_ADDRESS_KEY` to make the digest an HMAC that
cannot be reversed by enumerating addresses. Uploads and claims fail closed with 503
when quota storage is unavailable; reads fail open.

Takedown is the `MODS_BLOCKED` variable in `wrangler.toml`: a JSON array of build
hashes. Edit it and redeploy. Every route answers a blocked hash with 451 and the
blocked list, including claims that name it. A malformed list fails closed with 503.

Before the first deployment of this configuration, create the bucket with
`npx wrangler r2 bucket create snapmap-plus-mods`. The `v2-mod-registry` migration
provisions `ModRegistry`; deploy the bindings and code together.

### Emptying the mod store

`POST /mods/admin/reset` deletes every object in the `MODS` bucket (build archives and
anything the earlier blob and bundle store left) and empties the index. It exists only
while the `MODS_ADMIN_TOKEN` secret is set and needs `Authorization: Bearer <token>`;
otherwise it answers 404 or 403. It returns
`{"deleted":{"builds","other"},"index":{"mod_claim_build","mod_claim","mod_build"}}`,
the counts removed. Every published map's claim goes with it, so it is for the wipe
before a release, not for routine use. After the Worker with this store is deployed,
from this directory:

```text
npx wrangler secret put MODS_ADMIN_TOKEN
curl -X POST -H "Authorization: Bearer <token>" https://api.snapmapplus.com/mods/admin/reset
npx wrangler secret delete MODS_ADMIN_TOKEN
```

The first command asks for the token (use a long random one); the last hides the route
again.

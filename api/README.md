# API service

## Purpose

Serves the website's Community pages through GitHub Discussions on this repository, handles GitHub sign-in, stores uploaded screenshots and hosts the anonymous Snapmap+ mod store. Deployed as the Cloudflare Worker `snapmap-plus-community` at `https://api.snapmapplus.com`.

## Contents

- `worker.js` defines the HTTP API, authentication, discussion operations and media handling.
- `quota.js` and `quota_store.js` coordinate write limits across a user's sessions, and mod store limits per hashed client address.
- `mods_store.js` defines the `/mods/*` routes, uploads in parts, the streamed check of each build archive and the scheduled purge.
- `mods_registry.js` and `mods_registry_store.js` hold the mod store index, its anonymous claims and the uploads in parts in progress.
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
it uses Miniflare 4.20260730.0 and never calls GitHub or deployed storage. Add a size in
GiB after the module path (`... <miniflare-module-path> 1.2`) to also upload, check and
read back a generated build of that size in parts through the runtime.

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
| `POST /mods/build/:hash/parts`, `PUT /mods/build/:hash/parts/:n`, `POST /mods/build/:hash/complete` | Upload an archive larger than one request in parts. |
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

The store imposes no limit of its own (the owner's decision 26 of the 1.0 program): not
on a build's size, its number of files, one file's size, its scripts, the builds one
claim names, a published item's reference or the length of a name or path. The per-address
hourly limits below are not limits on a mod: they protect the bucket and its bill from
abuse. What remains is what the platform and the archive form fix, stated here as theirs:

- one request body: 100 MB (100,000,000 bytes) on the Free and Pro plans (200 MB
  Business, 500 MB Enterprise). An archive up to one part goes in one `PUT`; a larger one
  goes in parts of `PART_SIZE`, 95 MiB (99,614,720 bytes), in `api/mods_store.js`;
- R2 multipart uploads: every part but the last of one size, at least 5 MiB, at most
  10,000 parts, an object of at most 5 TiB;
- the archive form Snapmap+ writes: a ZIP without ZIP64, so at most 65,535 entries and
  4 GiB, which the product refuses before it sends anything;
- a Worker's memory (128 MB) and CPU time per request (30 s by default on the paid plan,
  configurable up to 5 minutes with `limits.cpu_ms`; 10 ms on Free). The archive check
  streams: file contents pass through untouched and are never held, a script's bytes
  are checked a chunk at a time by a few integers, and the central directory is matched
  against the entries record by record as it arrives. What the check keeps is each
  entry's header fields and name and `mod.json` (parsed at the end), so its memory grows
  with the number of entries and the size of `mod.json` (about 5 MB for 20,000 files),
  never with the archive's size. Its CPU time is a loop over the bytes of each chunk's
  headers and scripts plus one `JSON.parse`; checking a 1.2 GiB archive takes about ten
  seconds of wall time in the local runtime, nearly all of it reading.

R2 bucket `snapmap-plus-mods` (binding `MODS`) holds each archive as its own object,
`build/<hash>/<32 hex>`, named when it is written. The single `ModRegistry` Durable Object
(binding `MOD_REGISTRY`, object name `registry`) indexes the builds (`mod_build`: hash,
size, salt, upload time, claim count, the object that serves it, and the number of
script files the build carries), holds the claims (`mod_claim`, `mod_claim_build`) and
the uploads in parts in progress (`mod_upload`), so claim counts, releases and purges
are decided in one transaction. A row names its object, and only that object is ever
deleted for it: a release or purge that races an upload of the same build deletes the
object it dropped, never the one the upload wrote, so a claim can never name a build
whose archive is missing. The tables of the earlier blob and bundle store are dropped
when the object starts; rows from before per-upload objects name `build/<hash>`.

An archive is the mod's folder as the product's `modsync.c` and `modzip.c` write it: a
ZIP of stored entries (method 0) holding `mod.json`, the whole file, and
`assets/<request>` for every carried file its builder block lists, nothing else, where
the request is the block's `path` below `assets/` in lower case. Stock pointers never
upload: the player's own game holds them. There is no mod version anywhere: an author's
`version` key is an unknown author key and is ignored, and no response or index row
carries one. The Worker does not recompute the build hash or check what a file
provides; the client checks every file's SHA-256 and the canonical hash against the map
before it installs anything. Every other rule mirrors the product's own reader of a
built `mod.json` and of a downloaded archive (`modbundle.c`, `modsync.c`), so the store
refuses what the product would refuse and nothing it writes.

The archive check, the same for one request and for parts, refuses with 422 and the
first cause, one sentence: a body that is not a ZIP; bytes before, between or after the
entries; a ZIP64 or split archive; a compressed or encrypted entry; an entry without its
sizes in the local header or without a name; two entries of one name; a central
directory or end record that disagrees with the entries; a `mod.json` that is missing,
not UTF-8 JSON, without a `snapmap-plus` block of `format` 2 holding only the keys the
builder writes, without a valid `salt` (`[a-z][a-z0-9]{7}`), recording a failed build
(`cause`), or whose `build` is not the path hash; an author part with a retired key
(`id`, `key`, `shadows`, `stock`, `scope`, `player`, `extends`, `replaces`, `legacy`,
`composes`, `schema`, `hud.schema`), `files`, `bundle` or `build` at its top level, no
name, an author that is not text, `strings` or `hud` that is not an object, or
`requirements` outside the builder's shape (at most 32 cvars, each a printable string of
up to 64 characters, an integer or a boolean; up to 16 `activate` and 16 `deactivate`
lines of 1 to 256 printable characters without `;`; these mirror the console settings
the product applies); a file entry other than `path`, `sha256`, `size` (at least 1
byte), `provides` and `needs`, or a pointer entry other than the builder's; two entries
of one request; an entry outside `assets/` or not in lower case; a request path with a
`..`, `.` or empty segment, a backslash, a segment starting with a space or ending in a
dot or space, or a character outside `a-z 0-9 . _ - $ + @ ~ ( )` and space; an engine
file (`decls/renderprogs/`, `generated/glsl/`, `generated/glslbinaries/`,
`vulkan_pipelines.bin`); a type the builder does not carry (a `.bswf` only under
`generated/swf/`, a `.mega2` only as `virtualtextures/mods/<salt>/<family>_sq<1..16>.mega2`,
never a `_vmtr` family); an entry `files` does not list, a listed file the archive
lacks, or an entry whose size differs from `files`.

Scripts: a build may carry Lua source at `assets/mods/<salt>/scripts/**/*.lua` (its own
salt), any number and any size. These are safety rules, not limits, and stay: the upload
is refused when a `.lua` file lies anywhere else, starts with the bytecode signature
`ESC L u a`, holds a NUL byte or is not UTF-8. The block's `scripts` member must be
present exactly when the archive carries scripts, with their count in `scripts.files`
(every `.lua` entry, `lib/` included). The index records that count, every answer about
a build says it, and the product asks before it downloads, so a player is told a map's
mods include scripts before anything arrives.

- `PUT /mods/build/:hash` needs `Content-Type: application/zip` (else 415) and
  `Content-Length` (else 411), at most one part (else 413, "An archive over 95 MiB goes
  to the mod store in parts."). The body streams to a new object through the check; an
  archive refused at any byte has that object deleted, and since no row names it, it is
  never served in between. A new build answers 201 `{"build","size","scripts"}`. An
  existing one answers 200 with the stored size after the body is read and discarded,
  and restarts the upload window of a build nothing claims. An unclaimed archive of
  another size is replaced by an upload that validates (201; the replaced object is
  deleted), so a forged archive cannot hold a hash against the real one; a claimed
  archive is never replaced.
- Uploads in parts:
  - `POST /mods/build/:hash/parts` `{"size"}` starts an upload of that build at that size
    (an R2 multipart upload to a new object) and answers 201
    `{"build","size","partSize","parts","have":[]}`; while one is in progress it answers
    200 with the parts the store holds in `have`, so a client that lost its connection
    resumes without sending a part again. A build the store holds already answers 200
    `{"build","size","scripts","stored":true}`.
  - `PUT /mods/build/:hash/parts/:n` with `Content-Type: application/octet-stream`,
    `Content-Length` and `X-Build-Size: <archive size>` stores part n (1-based), exactly
    `partSize` bytes but the last. 200 answers the session as above; 404 when no upload
    of that build and size is in progress; 400 for a part number outside the upload or a
    part of the wrong length. A part sent again replaces the earlier copy.
  - `POST /mods/build/:hash/complete` `{"size"}` joins the parts into the archive's
    object and reads it back once through the check before anything is registered: 201
    `{"build","size","scripts"}` when it passes, 422 with the cause (the object deleted)
    when it does not, 409 with `have` while parts are missing, 409 "upload the build
    again" when the parts did not join (the upload is dropped), 404 when no upload is in
    progress. The answer waits for the read, about ten seconds for a gigabyte.
  - An upload nobody touched for a day is aborted by the daily cron and what it stored
    is deleted; R2's own lifecycle also aborts multipart uploads left for seven days.
- `GET` and `HEAD /mods/build/:hash` return the archive with `Content-Type:
  application/zip`, its `Content-Length`, `X-Mod-Scripts` (the build's script files),
  `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options:
  nosniff`, a `default-src 'none'; sandbox` CSP, `Content-Disposition: attachment` and
  the hash as the ETag. The body streams from R2, so a download of any size never sits
  in the Worker.
- `POST /mods/claim` takes `{"ref","builds":[hash...]}` (any non-empty ref of text, any
  number of stored builds; the body is bounded only by the platform's request size) and
  returns 201 `{"claim","secret"}`. The registry stores only the SHA-256 of the secret.
  One claim stands for one published item: sending `{"ref","builds","secret"}` with an
  existing claim's ref and secret replaces that claim's build set and returns 200 with
  the same claim and secret; a secret matching no claim for that ref is 403. Unknown
  builds are 409 `{"error","missing"}`.
- `POST /mods/release` takes `{"claim","secret"}` and returns 204; a wrong secret is 403
  and an unknown claim 404.

Every refusal on a `/mods` route is JSON `{"error"}` (with `missing` on 409 and
`blocked` on 451) whose `error` is one plain sentence of printable ASCII, at most 160
characters, which the product shows as it is.

A build is served while a claim names it or for one hour after its upload (the time a
publish needs between its uploads and its claim); otherwise it answers 404. Deletion is
immediate: the release that drops a build's last claim (`POST /mods/release`, or a
re-claim that leaves the build out) removes it from the index and deletes its object at
once. The daily cron (`[triggers]` in `wrangler.toml`) collects uploads nothing ever
claimed, past the hour, and uploads in parts abandoned for a day, in batches; the next
run continues.

Hourly limits per client address and UTC hour: 64 build uploads, 4 GiB of declared
upload bytes, 20,000 reads (`GET` or `HEAD`) and 64 claim or release calls. A publish in
parts counts as one upload of its whole size, when its upload starts: its parts, its
resumes and its completion count nothing, so a large publish is never stopped half way.
Exhaustion returns 429 with `Retry-After`. The counters live in `WRITE_QUOTAS` objects named
`mods-address:<digest>`; the raw address is never stored. IPv6 addresses are keyed by their
/64. Set the optional secret `MODS_ADDRESS_KEY` to make the digest an HMAC that cannot be
reversed by enumerating addresses. Uploads and claims fail closed with 503 when quota storage
is unavailable; reads fail open.

Takedown is the `MODS_BLOCKED` variable in `wrangler.toml`: a JSON array of build
hashes. Edit it and redeploy. Every route answers a blocked hash with 451 and the
blocked list, including claims and uploads in parts that name it. A malformed list
fails closed with 503.

Before the first deployment of this configuration, create the bucket with
`npx wrangler r2 bucket create snapmap-plus-mods`. The `v2-mod-registry` migration
provisions `ModRegistry`; the index adds its new columns and table itself when the
object starts. Deploy the bindings and code together.

### Emptying the mod store

`POST /mods/admin/reset` aborts every upload in parts, deletes every object in the `MODS`
bucket (build archives and anything the earlier blob and bundle store left) and empties
the index. It exists only while the `MODS_ADMIN_TOKEN` secret is set and needs
`Authorization: Bearer <token>`; otherwise it answers 404 or 403. It returns
`{"deleted":{"builds","other"},"index":{"mod_claim_build","mod_claim","mod_build","mod_upload"}}`,
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

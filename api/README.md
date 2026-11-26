# API service

## Purpose

Serves the website's Community pages through GitHub Discussions on this repository, handles GitHub sign-in, stores uploaded screenshots and hosts the Snapmap+ map-content store. Deployed as the Cloudflare Worker `snapmap-plus-community` at `https://api.snapmapplus.com`.

## Contents

- `worker.js` defines the HTTP API, authentication, discussion operations and media handling.
- `quota.js` and `quota_store.js` coordinate write limits across a user's sessions, and mod store limits per hashed client address.
- `mods_store.js` defines the `/mods/*` routes, uploads in parts, the checks of each unit's archive and the scheduled purge.
- `mods_publisher.js` defines publishing keys, the first-come binding of an account name to a key and the check of a signed request.
- `mods_pack.js` holds the content-addressed storage: packs, unit archives and serving plans.
- `mods_registry.js` and `mods_registry_store.js` hold the mod store index (units, blobs, packs, map claims, publishers, uploads in parts) and the `ModChecker` that checks each unit's uploads.
- `wrangler.toml` binds `SESSIONS` KV, `MEDIA` and `MODS` R2, the active SQLite `WRITE_QUOTAS`, `UNIT_REGISTRY` and `MOD_CHECKER` Durable Objects and the daily purge trigger. The original `MOD_REGISTRY` remains dormant.
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

Deploy from this directory with `npx wrangler deploy` after `npx wrangler login`. Secrets (`APP_ID`, `APP_PRIVATE_KEY`, `CLIENT_SECRET`, optional `GITHUB_TOKEN`, `TURNSTILE_SECRET`, `MODS_ADDRESS_KEY` and `MODS_ADMIN_TOKEN`) are set once with `npx wrangler secret put` and survive redeploys. One optional setting is a variable, not a secret: `MODS_MINIMUM_VERSION`, dot-separated numbers such as `1.0.0`. When it is set, every `/mods/*` answer carries `X-Snapmap-Plus-Minimum: <version>`, the oldest product version the store serves; a product below it tells its player once per start to update.

From the repository root, run `node tests/worker_body_test.js`,
`node tests/worker_quota_test.js` and `node tests/worker_mods_test.js` with Node 22.13 or newer. The local
Cloudflare runtime checks are `node tests/worker_runtime_test.js <miniflare-module-path>` and
`node tests/worker_contract_test.js <miniflare-module-path>` (the product's client, `tests/contract`) and
`node tests/worker_purge_test.js <miniflare-module-path>` (an unpublish and its purge leave nothing behind, and a
shared pack is compacted with the live unit byte-identical);
they use Miniflare 4.20260730.0 and never call GitHub or deployed storage.
`tests/worker_rows_test.js`, which CI does not run, takes the module path, a file count and the Worker root:
`node tests/worker_rows_test.js <miniflare-module-path> [files] [worker root]`.

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
| `POST /mods/units` | Whether the store holds each of up to 4,096 units: held, missing or removed. |
| `GET /mods/unit/:hash`, `/mods/unit/:hash/archive[?want=<mask>]`, `/mods/blob/:sha` | A unit's manifest, a ZIP of `unit.json` and the unit's files (or the files a mask names: bit i of the base64url bytes, byte i >> 3, is the manifest's file i), or one file's bytes (ranges resume). A player's game gets a unit with the archive alone, in one request. |
| `POST /mods/unit/:hash/begin`, `PUT /mods/unit/:hash/archive`, `POST /mods/unit/:hash/complete` | Upload a unit: its manifest, then the files the store lacks (signed). |
| `POST /mods/blob/:sha/parts`, `PUT /mods/blob/:sha/parts/:n`, `POST /mods/blob/:sha/complete` | Upload one file larger than one request in parts. |
| `POST /mods/map/claim`, `/mods/map/release` | Make, replace or release a published map's claim of units (signed, with its secret and rev). |
| `POST /mods/unit/:hash/asked`, `POST /mods/asked` | Report a file a unit lacked, or list those reports for a publisher's claims. |
| `POST /mods/admin/stats`, `/block`, `/unblock`, `/release-ref`, `/forget-key` | The maintainer's actions (hidden without their secret). |

The `GET` reads of a unit, its archive and a blob also answer `HEAD`; a method a route does not take is
answered 405 with an `Allow` header. `GET /community/discussions` takes `category`, `after` and `sort`
(`top` or `active`), and `/community/search` takes `q` (at least 2 characters; text past 200 is cut).

Community write routes require a session; `/mods/*` reads are anonymous, and its writes are signed by a publishing key except the parts of an upload in parts and a player's `POST /mods/unit/:hash/asked`, which are anonymous.
Every `/mods/*` answer may carry `X-Snapmap-Plus-Minimum: <version>` (see `MODS_MINIMUM_VERSION` above).
Read `worker.js` for payloads, limits and the additional ownership or moderator checks on editing and deletion.

## Mod store

The store is internal to map publishing (the product's `SPEC-distribution` section 10). It holds the units published
maps claim and nothing else: no mod listings and no old versions. A unit is the closure of one placed object, named by
the SHA-256 of its canonical manifest (`unit.json`, written by the product's `modunit.c`); its files are blobs, named
by their SHA-256. Nothing is browsable: every object is reachable only by hash, and any player fetches any unit by hash
with no account, session, OAuth or Turnstile. Native clients send no `Origin`, so these routes need no CORS header;
browser callers get the same allowlist as the rest of the API.

### Publishing a map

The product (`modclaim.c`, `modcache.c` `sh_cache_publish_unit`, `modnet.c`) publishes each unit the map's rows name that the store
lacks: `POST /mods/unit/<hash>/begin` with the manifest's bytes answers `{held: true}` or the blobs the store lacks,
`{missing, partSize, oneRequest}`; `PUT /mods/unit/<hash>/archive` sends them as stored ZIPs of `unit.json` and those
files, each at most 95 MiB (several archives may carry one unit; the answer says `{held}` or what is still missing); a
file larger than one request goes in parts of `PART_SIZE` (16 MiB) through `/mods/blob/<sha>/parts`; `complete` says
whether the store now holds every file. Then `POST /mods/map/claim {ref, units, secret, rev}` names the map's units:
`rev` 1 makes a claim, a known `(ref, secret)` is replaced only at its stored rev + 1 (409 `{rev}` otherwise), every unit
must be held (409 `{missing}`), and a unit moderation removed is left out (451 `{removed}`; the claim holds the rest).
`POST /mods/map/release {ref, secret, rev}` removes it at the claim's stored rev + 1 and answers 204; 404 when no claim has that item and secret, 409 `{rev}` when the rev is stale. Whoever authored a mod, a publisher uploads the units the store
lacks: every byte is checked, so authorship does not matter for map content.

### Publishing keys and names

Every write carries `X-Publisher-Key` (base64url of the 65-byte P-256 point, unpadded), `X-Publisher-Name` (the
SnapMap account name, percent-encoded, absent when signed out) and `X-Publisher-Signature` (base64url of the 64-byte
IEEE P1363 signature) over `"snapmap-plus/request/1\n" + method + "\n" + path + "\n" + name header + "\n"` and the
lowercase hex SHA-256 of the body (`api/mods_publisher.js`). The key names the publisher for the limits and binds the
account name first come, first served (NFC, case-folded): a free name binds to the presenting key, which releases its
earlier name; a name another key holds is not bound and the request goes on. The key authorises nothing about content:
claims are authorised by their secrets (the product derives each map's secret from the key, so a key backup restores
them). An archive's signature is checked by the checker Durable Object over the archive's SHA-256 in the same pass that
checks its files; a part of a blob carries none (it is bound to its signed session and checked whole at the signed
completion). No clock takes part: claims are ordered by `rev`, and an upload is idempotent.

### Storage and the deletion delay

`api/mods_registry_store.js` holds the index in one `UNIT_REGISTRY` Durable Object (SQLite): units (`pending` from their
begin, `held` once every blob is), the blobs each names, blobs, packs, map claims and the units they name, publishers and
their names, asked paths (at most 256 per unit), blocked units and the delete queue. A checked unit archive is kept as
it is as a pack (`pack/<unit>/<32 hex>`): each file's bytes follow the local header it arrived with, and are moved
again only when the purge compacts the pack (below). A blob uploaded in parts is a pack of one
(`blob/<sha>/<32 hex>`). The archive route writes `unit.json` and the unit's files in the order their bytes lie in the
packs, reusing each stored header, so one answer reads a few long R2 ranges whatever the unit's file count
(`api/mods_pack.js`).

Rows written are what the account's plan counts (100,000 a day on Workers Free, billed past the included amount on
Workers Paid), every index a row of its own. A blob is one row (schema 5: keyed by its SHA-256, no row id and no
index by pack, so finding a missing pack's blobs scans); a unit's link to each of its files is two (the link and its
index by SHA-256, which every refcount and promotion reads); a purge changes each pack's counts once, not once per
file; the schema row is written only when it changes. The hourly counters of the quota objects are one row each.
`api/sql_meter.js` counts what each object's SQL reads and writes (`stats.sql` of the admin stats route), and
`tests/worker_rows_test.js` measures a publish and a download under Miniflare.

A unit no claim names records the store-clock time it lost its last claim (or its begin) and is kept and served for
24 hours (`DELETE_DELAY_MS`), so a download in flight never meets a delete; a claim within the delay clears it; the daily
cron then deletes it, the blobs no other unit names, and packs no blob row points into. A begin of an unclaimed unit
restarts its delay. An object found missing marks its blobs broken (missing to every unit) until an upload repairs
them. The daily purge also aborts uploads in parts untouched for a day and deletes objects no row names once a day old.

A pack that loses a blob while it keeps others, and a pack holding a blob that arrived twice (the later copy is
unused), holds slack: bytes nothing uses any more. `pack_slack` counts them (`slackBytes` in the stats), and the same
purge compacts such a pack: it copies the pack's live blobs, each with its stored local header and in the order they
lay, R2 range to R2 object, to the old key with `.<32 hex>` added (so a unit's archive, which orders its files by pack
key and offset, stays byte for byte the same), checks the copy's size, and switches the blob rows in one transaction
that first confirms the pack still holds exactly what was copied (otherwise the copy is deleted). The old object is
kept for the deletion delay (`dead_later`, `deadLater` in the stats), since a download already under way reads the
locations it was planned with, and is deleted by the first purge after it. A run compacts at most 10 packs and makes at
most 150 range reads; a pack needing more ranges than that is logged and keeps its slack counted. A pack with a broken
blob waits for its repair. After a purge `slackBytes` is 0.

`packBytes` minus `liveBytes` is then structure, not slack: `liveBytes` counts the files' bytes, while a pack also holds
each file's ZIP local header (kept so the archive route serves it as uploaded), and an uploaded archive's pack also its
`unit.json` entry and central directory until a compaction rewrites it. A fresh pack is not rewritten for those.

Production serves an unclaimed unit for 24 hours. The scheduled purge removes it after that delay. Abandoned uploads and unnamed objects also wait a day. Local tests can shorten the unit delay with `MODS_DELETE_DELAY_MS`.

What an unpublish leaves: the map's claim row and its links to units go at the release; each unit, its links to blobs,
its asked paths, the blobs no other unit names and the packs nothing points into go at the first purge after the delay,
their objects deleted from R2 and so off the delete queue; a pack another unit still uses is compacted by that purge,
and its old object deleted by the first purge a delay later. Publishing keys and their names stay (forget-key removes
them). The hourly limit counters (`WRITE_QUOTAS`, below) are not store rows: each is one row per kind of limit in the
quota object of one hashed address or one hashed key, overwritten each hour, naming no unit, blob or claim, so an
unpublish has nothing there to clean; a Worker cannot list those objects, so the stats do not count them.

### The checks

Every byte is checked in a `MOD_CHECKER` Durable Object, so the Worker only moves bytes: a begin's manifest against its
hash and the shape of `SPEC-distribution` 3.4 (exact keys, format 1, paths lower case, relative, inside one of a mod's
folders, files sorted and unique, one size per SHA-256); an archive's every entry stored, hashed and its CRC-32
computed, `unit.json` equal to the begun manifest, every other entry a file the manifest lists with its SHA-256, size
and CRC-32, nothing else, a Lua script source text; a blob in parts by its SHA-256. A refused upload is deleted. The
store sets no limit of its own on a unit's total size. What bounds a unit is one request body (100 MB on the Free and
Pro plans, hence 95 MiB archives and 16 MiB parts), R2's multipart rules (a file in parts is at most 10,000 parts, about
160 GiB), the manifest, which arrives in one request of at most 16 MiB and so limits a unit's files, and the claim, also
one request of at most 16 MiB; a status request names at most 4,096 units.

### Limits

Per hour, every signed write counts against its publishing key (the SHA-256 of the key names its quota object) and against
the client's hashed address (`WRITE_QUOTAS`): 1,024 begins, 64 GiB of uploaded bytes (soft: an upload of any size is
admitted while the hour is below it; an archive counts its length, the start of an upload in parts counts the file's
size, its parts and completion count nothing), 256 claim calls (a claim, a release or an asked report). A begin, a claim
and a release are counted against their publishing key only after the signature checks, so such a request its key did
not sign spends nothing of that key's hour; an archive, whose signature is checked once it has arrived, is counted as it
starts. The asked report, which is unsigned, counts against the address only. Reads count 20,000 per address
and fail open. `POST /mods/unit/<hash>/complete` reads at most 64 KiB. A refusal is 429 with `Retry-After`. The
numbers are the owner's to set (D45).

### Moderation and the maintainer

The admin routes take `Authorization: Bearer <MODS_ADMIN_TOKEN>` and answer 404 while the secret is unset:

- `POST /mods/admin/block {unit, reason}` removes a unit: it is no longer served, its blobs no other unit names are
  deleted, claims stop naming it, and its hash is blocked, so no upload can put it back (status `removed`, 451).
  Players who already have it keep it. `POST /mods/admin/unblock {unit}` lifts the block.
- `POST /mods/admin/release-ref {ref}` releases every claim of one published item, at its publisher's request (D42).
- `POST /mods/admin/forget-key {key}` deletes a publishing key's record and its name binding, freeing the name for the
  next key that presents it; the key's claims stay, since their secrets authorise them (SPEC 4.4).
- `POST /mods/admin/stats` says what the store holds: units (held, pending, claimed, unclaimed), blobs, packs and their
  bytes, claims, `claimUnitRows` (claims' links to units), `unitBlobRows` (units' links to blobs), publishers, names,
  blocked units, asked paths, uploads in parts, `dead` (objects queued for deletion), `deadLater` (compacted packs' old
  objects in their delay) and `slackBytes` in `slackPacks` packs (bytes nothing uses, which the next purge compacts).

The retired routes of earlier stores (`/mods/build/*`, `/mods/bundle/*`, `/mods/author/*`, `/mods/claim`,
`/mods/release`, `/mods/missing`, `PUT /mods/blob/<sha>`) answer 410 with "This version of Snapmap+ cannot use the mod
store; run the Snapmap+ installer to update."

### Production storage

The unit index uses its own SQLite namespace. The original bundle namespace retains its claims and their secret digests. The Worker leaves those tables untouched. Previously issued bundle URLs answer 410. A missing unit hash answers 404 and can be uploaded by a publisher. A moderated unit answers 451.

Keep the existing Worker name, route, session namespace, media bucket and secrets. The unit store uses the normal `snapmap-plus-mods` bucket. Inspect or clear old mod objects separately while publishing is paused. Screenshots and attachments live in `snapmap-plus-media`. A replacement Worker version must retain the class migrations and bindings already applied. Reverting Worker code cannot restore removed mod objects.

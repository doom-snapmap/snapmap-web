# API service

## Purpose

Serves the website's Community pages through GitHub Discussions on this repository, handles GitHub sign-in, stores uploaded screenshots and hosts the anonymous Snapmap+ mod store. Deployed as the Cloudflare Worker `snapmap-plus-community` at `https://api.snapmapplus.com`.

## Contents

- `worker.js` defines the HTTP API, authentication, discussion operations and media handling.
- `quota.js` and `quota_store.js` coordinate write limits across a user's sessions, and mod store limits per hashed client address.
- `mods_store.js` defines the `/mods/*` routes, uploads in parts, the check of each build archive and the scheduled purge.
- `mods_dist.js` defines the distribution routes: authors' signing keys and mods' listings.
- `mods_pack.js` holds the content-addressed storage: skeletons, packs, serving plans and the packer.
- `mods_registry.js` and `mods_registry_store.js` hold the mod store index (builds, blobs, packs, anonymous claims, uploads in parts) and the per-build checker.
- `wrangler.toml` binds `SESSIONS` KV, `MEDIA` and `MODS` R2, the SQLite `WRITE_QUOTAS`, `MOD_REGISTRY` and `MOD_CHECKER` Durable Objects, the `MODS_BLOCKED` variable and the daily purge trigger; `wrangler.staging.toml` is the same Worker on its own resources.
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
`node tests/worker_quota_test.js` and `node tests/worker_mods_test.js` with Node 22.13 or newer. The local
Cloudflare runtime checks are `node tests/worker_runtime_test.js <miniflare-module-path>` and
`node tests/worker_contract_test.js <miniflare-module-path>` (the product's client, `tests/contract`);
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
| `POST /mods/build/:hash/asked`, `POST /mods/asked` | Report a file a published map's part of a mod lacked, or list those reports for a claim's holder. |
| `POST /mods/author/:id/key`, `GET /mods/author/:id` | Bind or read a mod author's signing key. |
| `GET /mods/mod/:id`, `POST /mods/mod/:id/publish`, `/mods/mod/:id/delete` | Read, publish (signed) or withdraw (signed) a mod's listing. |
| `POST /mods/admin/reset`, `/mods/admin/stats`, `/mods/admin/remove-mod` | Empty the mod store, say what it holds, or remove a listing (maintainer only, hidden without its secret). |

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
abuse, and a single upload of any size is always admitted. What remains is what the
platform and the archive form fix, stated here as theirs:

- one request body: 100 MB (100,000,000 bytes) on the Free and Pro plans (200 MB
  Business, 500 MB Enterprise). An archive up to `ONE_REQUEST_MAX`, 95 MiB
  (99,614,720 bytes), may go in one `PUT`; a client sends a larger one, and any it wants
  sent faster, in parts of `PART_SIZE`, 16 MiB, several at once and in any order (both in
  `api/mods_store.js`). The product sends up to 32 MiB in one request and the rest in parts,
  four at a time;
- R2 multipart uploads: every part but the last of one size, at least 5 MiB, at most
  10,000 parts, an object of at most 5 TiB;
- none from the archive form: the product writes ZIP64 records exactly where a value does
  not fit a classic field (an entry of 4 GiB or more, an offset past 4 GiB, 65,535 entries
  or more), and the check reads them; a size past 2^53 bytes (about 9 PB) is past what a
  JavaScript number counts exactly and is refused as the platform's;
- CPU time: a Worker request has 10 ms on the Workers Free plan (30 s by default on Paid,
  configurable to 5 minutes), a Durable Object request 30 s on either. So the Worker never
  touches an archive's bytes: an upload is piped to R2 by the runtime, the check runs in the
  build's own `MOD_CHECKER` Durable Object, which walks the archive and has its files hashed by
  further checker objects, 512 MiB each and four at a time (hashing is about 6 ms of CPU a
  megabyte), the packer runs on the registry's alarm, and a download pipes ranges of R2 objects
  to the response. One file of a mod up to about 4.5 GB is hashed in one request; memory grows with the number of entries and
  the size of `mod.json` (about 5 MB for 20,000 files), never with the archive's size.

### Storage: every file once

Storage is content addressed (`api/mods_pack.js`, `api/mods_registry_store.js`). A file's
bytes are a blob, named by their SHA-256 and stored once in the `MODS` bucket however many
builds carry them: every revision of a mod, every map's part of it, and the per-object units a
map will name (each the closure of one placed object, stored as a build of its own) share the
blobs they have in common. Blobs live in packs, `pack/<32 hex>`, R2 objects of about 16 MiB holding blobs
end to end, each after the ZIP local header it had in the archive that brought it; a large file
is a pack of its own. A build is its skeleton, `skel/<hash>/<32 hex>` (the archive's own bytes
that are not file contents: each entry's local header, the central directory and end
records, which blob each entry holds, and for part of a build what it left out of its source)
and the blobs it names. The store serves the uploaded archive byte for byte, its size, CRCs and
offsets the uploader's own: a build whose entries have the headers its blobs were stored with
(every later build of the same mod, every part of it) is a few long ranges of its packs; a build
holding the same bytes under another name gets its own headers from its skeleton around them.

An upload is stored as an archive, `build/<hash>/<32 hex>`, checked, and served from it at
once (staged). The registry's alarm then packs it: the blobs the store does not hold yet are
copied into new packs in a few ranged reads of the archive, the build's serving plan (the
ranges, in order) is recorded in its row, and the archive is deleted. Two Tyrant revisions of
232 MB and 237 MB uploaded on staging were stored in 265 MB of packs.

The single `ModRegistry` Durable Object (binding `MOD_REGISTRY`, object name `registry`)
indexes builds (`build`: hash, size, salt, upload time, claim count, script count, `slice_of`
for part of a build, staged or packed, its archive, skeleton and plan, whether it is broken),
blobs (`blob`: SHA-256, size, pack, offset, header, the count of builds naming it), packs
(`pack`: object, size, live blobs), which blobs each build names (`build_blob`), the claims
(`claim`, `claim_build`, by build hash), what players asked of a part of a build (`asked`), the
uploads in parts in progress (`upload`) and the objects to delete (`dead`), so claim counts,
references, releases, purges and repairs are decided in one transaction. Every object a row
names has its own random key, written once; a row that stops naming an object queues it on
`dead` in the same transaction, so an object is never deleted while a row names it and never
left behind when a request fails. The tables of the earlier stores (the blob and bundle store,
then one archive per build) are dropped when the object starts.

`ModChecker` (binding `MOD_CHECKER`, one object per build hash) holds nothing: it reads an
uploaded archive back from R2 through the check, writes the skeleton and registers the build.

### The check

An archive is the mod's folder as the product's `modsync.c` and `modzip.c` write it: a
ZIP of stored entries (method 0) holding `mod.json`, the whole file, and
`assets/<request>` for every carried file its builder block lists, nothing else (part of a
build also carries `source.json`, below), where the request is the block's `path` below
`assets/` in lower case. Stock pointers never upload: the player's own game holds them.
There is no mod version anywhere: an author's `version` key is an unknown author key and is
ignored, and no response or index row carries one. Every entry's bytes are hashed, and every
carried file must have the SHA-256 and size its `mod.json` gives it, so a blob holds the bytes
its name says before any build can name it. The Worker does not recompute the build hash (the
canonical manifest the product derives from `mod.json`) or check what a file provides; the
client checks both, and every file again, before it installs anything. Every other rule
mirrors the product's own reader of a built `mod.json` and of a downloaded archive
(`modbundle.c`, `modsync.c`), so the store refuses what the product would refuse and nothing it
writes; `tests/contract/client.json` records what the product writes and the contract test
checks the store against it.

The check, the same for one request and for parts, refuses with 422 and the first cause, one
sentence: a body that is not a ZIP; bytes before, between or after the entries; a split
archive; a ZIP64 marker without its value in a ZIP64 extra field, a ZIP64 extra field no marker
asks for, or ZIP64 end records that disagree with the end record or each other; a compressed or
encrypted entry; an entry without its sizes in the local header or without a name; two entries
of one name; a central directory or end record that disagrees with the entries; a `mod.json`
that is missing, not UTF-8 JSON, without a `snapmap-plus` block of `format` 2 holding only the
keys the builder writes, without a valid `salt` (`[a-z][a-z0-9]{7}`), recording a failed build
(`cause`), or whose `build` is not the path hash; an author part with a retired key (`id`,
`key`, `shadows`, `stock`, `scope`, `player`, `extends`, `replaces`, `legacy`, `composes`,
`schema`, `hud.schema`), `files`, `bundle` or `build` at its top level, no name, an author that
is not text, `strings` or `hud` that is not an object, or `requirements` outside the builder's
shape; a file entry other than `path`, `sha256`, `size` (at least 1 byte), `provides` and
`needs`, or a pointer entry other than the builder's; two entries of one request; an entry
outside `assets/` or not in lower case; a request path with a `..`, `.` or empty segment, a
backslash, a segment starting with a space or ending in a dot or space, or a character outside
`a-z 0-9 . _ - $ + @ ~ ( )` and space; an engine file (`decls/renderprogs/`, `generated/glsl/`,
`generated/glslbinaries/`, `vulkan_pipelines.bin`); a type the builder does not carry (it
carries `CARRIED_EXTENSIONS`, `.baas_<class>`, a `.bswf` only under `generated/swf/`, a `.mega2`
only as `virtualtextures/mods/<salt>/<family>_sq<1..16>.mega2`, never a `_vmtr` family); an
entry `files` does not list, a listed file the archive lacks, an entry whose size differs from
`files`, or a file whose bytes are not the SHA-256 `files` gives it.

Scripts: a build may carry Lua source at `assets/mods/<salt>/scripts/**/*.lua` (its own
salt), any number and any size. These are safety rules, not limits, and stay: the upload
is refused when a `.lua` file lies anywhere else, starts with the bytecode signature
`ESC L u a`, holds a NUL byte or is not UTF-8. The block's `scripts` member must be
present exactly when the archive carries scripts, with their count in `scripts.files`
(every `.lua` entry, `lib/` included). The index records that count, every answer about
a build says it, and the product asks before it downloads, so a player is told a map's
mods include scripts before anything arrives.

### Routes

- `PUT /mods/build/:hash` needs `Content-Type: application/zip` (else 415) and
  `Content-Length` (else 411), at most one part (else 413, "An archive over 95 MiB goes
  to the mod store in parts."). The body is piped to a new object and then checked; a refused
  archive has that object deleted, and since no row names it, it is never served in between.
  A new build answers 201 `{"build","size","scripts"}`. A build a claim names, whole, answers
  200 with the stored size after the body is read and discarded. A build nothing claims is
  taken again: the same archive (size and `mod.json`) answers 200 and restarts its upload
  window, and any other archive that passes the check replaces it (201), so an archive that
  names a hash it is not cannot hold that hash against the real one. A claimed build is never
  replaced, unless an object it needs went missing (below).
- Uploads in parts:
  - `POST /mods/build/:hash/parts` `{"size"}` starts an upload of that build at that size
    (an R2 multipart upload to a new object) and answers 201
    `{"build","size","partSize","parts","have":[]}`; while one is in progress it answers
    200 with the parts the store holds in `have`, so a client that lost its connection
    resumes without sending a part again. A build a claim names, whole, answers 200
    `{"build","size","scripts","stored":true}`, and the client sends nothing.
  - `PUT /mods/build/:hash/parts/:n` with `Content-Type: application/octet-stream`,
    `Content-Length` and `X-Build-Size: <archive size>` stores part n (1-based), exactly
    `partSize` bytes but the last. 200 answers the session as above; 404 when no upload
    of that build and size is in progress; 400 for a part number outside the upload or a
    part of the wrong length. A part sent again replaces the earlier copy.
  - `POST /mods/build/:hash/complete` `{"size"}` joins the parts into the archive's
    object and checks it before anything is registered: 201 `{"build","size","scripts"}`
    when it passes, 422 with the cause (the object deleted) when it does not, 409 with
    `have` while parts are missing, 409 "upload the build again" when the parts did not
    join (the upload is dropped), 404 when no upload is in progress. The answer waits for
    the check, about fifteen seconds a gigabyte.
  - An upload nobody touched for a day is aborted by the daily cron and what it stored
    is deleted; R2's own lifecycle also aborts multipart uploads left for seven days.
- `GET` and `HEAD /mods/build/:hash` return the archive with `Content-Type:
  application/zip`, its `Content-Length`, `X-Mod-Scripts` (the build's script files),
  `Accept-Ranges: bytes`, `Cache-Control: public, max-age=31536000, immutable`,
  `X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox` CSP,
  `Content-Disposition: attachment` and the hash as the ETag. A `GET` with one
  `Range: bytes=a-b` (or `a-`, or `-n`) answers 206 with `Content-Range`, so a download that
  broke off resumes where it stopped; `If-Range` with another ETag, or several ranges, gets
  the whole archive; a range past the end is 416. The bytes stream from R2 and never sit in
  the Worker.
- Part of a build. A published map that uses only some files of a mod uploads just those, as a
  build of its own (the product's `modslice.c`): its `mod.json` author part names the build it was
  cut from in `"slice-of"` (64 lowercase hex), and its archive carries, beside `mod.json`, that
  build's canonical manifest as `source.json`. The check refuses such an archive, with 422 and one
  sentence, when it has no `source.json`, when the SHA-256 of `source.json` is not `slice-of`, when
  `source.json` is not UTF-8 JSON listing files, or is another mod (its `id` is not the salt), or when
  a carried file is not a file of `source.json` with the same `path`, SHA-256 (`blob`) and size. A
  `source.json` in a whole build is refused. Otherwise part of a build is stored, served, claimed,
  released and purged like any build; two maps that need the same files of one build name one hash,
  and parts of one build share every blob they have in common, `source.json` included. The
  per-object units a map will name are stored the same way and need no change here as long as each
  is an archive named by its hash; a claim names them like builds.
- `POST /mods/build/:hash/asked` takes `{"request","by"}`: a player's game asked a stored part of a
  build for `request`, which the part lacks; `by` is the name of what asked, or empty, and is cut to
  256 characters. Only a file the part's `source.json` lists and the part does not carry is kept, so
  an author never sees a report about anything else and a part never holds more reports than files
  it left out. Kept once per build and request (the first `by`), deleted with the build. 204; 404
  for a build the store does not hold or a whole one; 400 for any other request. Nothing about the
  player is sent or kept. It counts as a claim call.
- `POST /mods/asked` takes `{"claim","secret"}` and returns 200 `{"asked":[{"build","salt","request",
  "by"}]}` for every build that claim names, so the published map's author sees what players lacked
  and publishes again to carry it; 403 for a wrong secret, 404 for an unknown claim. It counts as a
  read.
- `POST /mods/claim` takes `{"ref","builds":[hash...]}` (any non-empty ref of text, any
  number of stored builds; the body is bounded only by the platform's request size) and
  returns 201 `{"claim","secret"}`. The registry stores only the SHA-256 of the secret.
  One claim stands for one published item: sending `{"ref","builds","secret"}` with an
  existing claim's ref and secret replaces that claim's build set and returns 200 with
  the same claim and secret; a secret matching no claim for that ref is 403. Builds the store
  does not hold, or holds broken, are 409 `{"error","missing"}`: the client uploads them again.
- `POST /mods/release` takes `{"claim","secret"}` and returns 204; a wrong secret is 403
  and an unknown claim 404.

Every refusal on a `/mods` route is JSON `{"error"}` (with `missing` on 409 and
`blocked` on 451) whose `error` is one plain sentence of printable ASCII, which the product
shows as it is.

A build is served while a claim names it or for one hour after its upload (the time a
publish needs between its uploads and its claim); otherwise it answers 404. Deletion is
immediate: the release that drops a build's last claim (`POST /mods/release`, or a
re-claim that leaves the build out) removes it from the index and deletes its archive or
skeleton at once, with every blob no other build names and every pack left without a live
blob. The daily cron (`[triggers]` in `wrangler.toml`) collects uploads nothing ever
claimed, past the hour, uploads in parts abandoned for a day, whatever the delete queue still
holds, and objects in the bucket that no row names and that are more than a day old (200,000
listed a run, continuing where the last run stopped), and wakes the packer.

Repair. A request that finds an object a build needs missing from R2 (a pack, an archive or a
skeleton) marks that build, and every build that needs the same pack, broken: they answer 404
from then on, a claim naming them is 409, and the store no longer says it holds them, so the
author's next publish uploads the build again; the upload replaces the broken build in place
(its claims stay), the packer rewrites the missing blobs, and every other build that needed them
is planned again and served once nothing of it is missing.

Hourly limits per client address and UTC hour: 1,024 new uploads, 64 GiB of declared upload
bytes, 20,000 reads (`GET` or `HEAD`) and 256 claim, release or report calls. The byte limit is
soft: an upload is admitted while the hour's bytes are below it, whatever its own size, so a
build of any size can always be published. A build the store already holds under a claim costs
nothing, and a publish in parts counts as one upload of its whole size, when its upload starts:
its parts, its resumes and its completion count nothing, so a large publish is never stopped
half way. Exhaustion returns 429 with `Retry-After`. The counters live in `WRITE_QUOTAS` objects
named `mods-address:<digest>`; the raw address is never stored. IPv6 addresses are keyed by their
/64. Set the optional secret `MODS_ADDRESS_KEY` to make the digest an HMAC that cannot be
reversed by enumerating addresses. Uploads and claims fail closed with 503 when quota storage
is unavailable; reads fail open.

Takedown is the `MODS_BLOCKED` variable in `wrangler.toml`: a JSON array of build
hashes. Edit it and redeploy. Every route answers a blocked hash with 451 and the
blocked list, including claims and uploads in parts that name it. A malformed list
fails closed with 503.

Before the first deployment of this configuration, create the bucket with
`npx wrangler r2 bucket create snapmap-plus-mods`. The `v2-mod-registry` migration
provisions `ModRegistry` and `v3-mod-checker` provisions `ModChecker`; the index makes its
tables itself when the object starts. Deploy the bindings and code together.

### Units, listings and authors

The distribution design (2026-11-17) is built on this storage. A published map names, for each
mod it uses, the units it places: a unit is the content-addressed closure of one placed object
(its files and pointers), uploaded, checked, packed and served exactly as a build, at
`/mods/unit/:hash` (the same routes as `/mods/build/:hash`). Any publisher may upload a unit the
store lacks; the check proves every file is the bytes its `mod.json` names. A map's claim
(`POST /mods/claim`, one per map, `builds` naming its units) keeps them until the map's own author
republishes (the claim's units replaced) or unpublishes it (`POST /mods/release`). A mod's listing
is what installing the mod gives: its current version only, its units by placed object, published
by the mod's author; it claims its units as a map does. A unit no map and no listing claims is
deleted at once. Keys govern listings only.

- `POST /mods/author/:id/key` `{"author","key","time"}` binds an Ed25519 public key (32 bytes,
  base64url) to the SnapMap author ID. The body is signed by that key, its signature in
  `X-Mod-Signature` (base64url). A new or unknown ID binds at once (201); the same key again is
  200; another key for a bound ID also needs `X-Mod-Previous-Signature`, the bound key's signature
  of the same body, else 409. `GET /mods/author/:id` returns `{"author","key","bound"}`.
- `POST /mods/mod/:id/publish` `{"author","mod","seq","name","time","objects":{"<object>":"<unit
  hash>"},"check"?}`, signed by the author's bound key: the listing's next version (`seq` one after
  the current one, so a replayed request changes nothing; `time` within 15 minutes). Every unit must
  be stored (409 `{"missing"}` otherwise). With `"check": true` nothing changes and the answer is
  `{"seq","size","newBytes"}`, the size to show before the publish. 201 for a new mod, 200 for an
  update, `{"seq","size","newBytes"}`; 403 for another author's mod or a bad signature, 409
  `{"seq"}` for a stale version, 410 for a removed mod, 429 past the author's hourly limits (256
  publishes, 256 GiB of units new to the store, soft). The units only the old version named lose
  the listing's claim; published maps never change with a listing.
- `GET /mods/mod/:id` returns the listing `{"mod","author","name","seq","size","objects"}`; 410
  for a withdrawn or removed one.
- `POST /mods/mod/:id/delete` `{"author","mod","time"}`, signed: withdraws the listing. Published
  maps keep every unit they claim; the author may publish the ID again.
- `POST /mods/admin/remove-mod` `{"mod"}` (maintainer token): moderation removes a listing. Maps
  that claim its units keep them; a unit itself is taken down with `MODS_BLOCKED`.

The registry keeps `author` (ID, key), `listing` (mod ID, author, name, version, size) and
`listing_unit` (mod, object, unit); a build's `vrefs` counts the listings naming it as a unit.
These shapes are the store's first form of the design; the product's client of them is not
written yet.
### Emptying the mod store, and what it holds

`POST /mods/admin/reset` aborts every upload in parts, deletes every object in the `MODS`
bucket (packs, skeletons, archives and anything an earlier store left) and empties the index.
`POST /mods/admin/stats` returns what the store holds: builds (claimed, staged, broken), their
archives' bytes, blobs and their bytes, packs and their bytes, claims and the delete queue. Both
exist only while the `MODS_ADMIN_TOKEN` secret is set and need `Authorization: Bearer <token>`;
otherwise they answer 404 or 403. The reset returns
`{"deleted":{"builds","other"},"index":{"claim_build","claim","build_blob","blob","pack","build","upload","asked","dead"}}`,
the counts removed (`builds` counts the objects this store writes, `other` everything else).
Every published map's claim goes with it, so it is for the wipe before a release, not for
routine use. After the Worker with this store is deployed, from this directory:

```text
npx wrangler secret put MODS_ADMIN_TOKEN
curl -X POST -H "Authorization: Bearer <token>" https://api.snapmapplus.com/mods/admin/reset
npx wrangler secret delete MODS_ADMIN_TOKEN
```

The first command asks for the token (use a long random one); the last hides the routes
again.

### Staging

`wrangler.staging.toml` deploys the same code as `snapmap-plus-community-staging` on
workers.dev, with its own KV namespace, buckets (`snapmap-plus-media-staging`,
`snapmap-plus-mods-staging`) and Durable Object namespaces, never the custom domain:
`npx wrangler deploy -c wrangler.staging.toml`. Point the product's `mods.store` setting at its
workers.dev address to publish and play against it.

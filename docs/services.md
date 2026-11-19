# External services

The services behind the website and its API, who holds their credentials, and
what a fork must provision. None of them is billed today; hosting charges depend
on the account plan and usage. The mod store is the first service whose cost grows
with community use; at Cloudflare's listed R2 prices it is expected to cost dollars
per month at plausible scale. The account is on the Workers Free plan, and the API runs on Free and
on Workers Paid from the same code (below).

| Service | Purpose | Credentials or bindings | Without it |
|---|---|---|---|
| Namecheap | Registrar for `snapmapplus.com` | Registrar account | The domain lapses. |
| Cloudflare DNS | Zone for `snapmapplus.com`; required for the Worker's custom domain | Cloudflare account | `api.snapmapplus.com` cannot exist; the Worker is reachable only at `*.workers.dev`. |
| GitHub Pages | Serves `site/` at `www.snapmapplus.com` | Workflow Pages permissions; `site/CNAME` | The site cannot publish. |
| GitHub Releases API (snapmap-plus) | Changelog page and Download button, read in the browser | None (public) | The changelog page shows its fallback link. |
| Community GitHub App (`snapmap-plus-community`) | Reads Discussions on this repository; GitHub sign-in | Worker secrets `APP_ID`, `APP_PRIVATE_KEY`, `CLIENT_SECRET`; optional `GITHUB_TOKEN` read fallback | Community reads or sign-in fail. |
| Workers KV | Sessions and OAuth state | `SESSIONS` binding | Sign-in and authenticated routes fail. |
| SQLite Durable Objects | Per-account write quotas | `WRITE_QUOTAS` binding and its migration | Authenticated writes fail closed with HTTP 503. |
| R2 | Screenshot uploads | `MEDIA` binding | Uploads and media retrieval fail. |
| R2 (mod store) | The Snapmap+ mod store, bucket `snapmap-plus-mods`: the units published maps claim, each file stored once by its SHA-256 in packs; billed per use for storage, Class A writes and Class B reads, with free egress | `MODS` binding | Players without a map's content load it with stand-ins and one notice; content already on their computer and vanilla maps are unaffected. |
| SQLite Durable Objects (mod index and checker) | Index of units, blobs, packs, map claims and publishing keys (`MOD_REGISTRY`); the check of each upload, one object per unit (`MOD_CHECKER`); per-key and per-address limits use `WRITE_QUOTAS` | `MOD_REGISTRY` and `MOD_CHECKER` bindings and their `v2-mod-registry` and `v3-mod-checker` migrations; optional secrets `MODS_ADDRESS_KEY` and `MODS_ADMIN_TOKEN` | Mod store routes fail closed with HTTP 503. |
| Workers Cron Trigger | Daily purge of units no claim has named for 24 hours, abandoned uploads in parts and objects no row names | `[triggers]` in `api/wrangler.toml` | Unclaimed units stay stored and served until a purge runs. |
| Turnstile | Optional write challenge | Worker secret `TURNSTILE_SECRET` and matching site setup | The Worker skips the challenge when the secret is absent. |

## DNS

The zone lives on Cloudflare; the registrar only points its nameservers there.

| Record | Target | Proxy |
|---|---|---|
| `A @` | GitHub Pages: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` | DNS only |
| `CNAME www` | `doom-snapmap.github.io` | DNS only |
| `api` | Managed by the Worker custom domain in `api/wrangler.toml` | Proxied (automatic) |

GitHub Pages serves `www.snapmapplus.com` and redirects the apex to it. Keep the
Pages records DNS-only so GitHub can issue and renew the certificate.

## Worker

[api/README.md](../api/README.md) covers the App, OAuth callback, KV, Durable
Objects and R2. App credentials live in Cloudflare as Worker secrets, separately
from GitHub Actions. The Worker stores signed-in users' GitHub tokens in KV and
sends browsers opaque session IDs; writes use the user's token. The Worker keeps
its original Cloudflare name, `snapmap-plus-community`, so its bindings and
secrets carried over from the product repository unchanged.

A fork must provision its own zone, KV namespace, R2 bucket and GitHub App, set
the App callback URL to its Worker's `/auth/callback`, and replace the
account-specific IDs and origin constants in `api/worker.js` and
`site/assets/community.js`.

## Workers plan

The account is on Workers Free (owner, 2026-11-17). The API, the mod store included, runs on Free
and on Workers Paid from the same code, and nothing in it depends on Free's limits being there.
The Worker only moves bytes; the work that reads every byte of a mod upload runs in Durable
Objects, which have 30 s of CPU a request on either plan, and a large upload is checked in parts of
about 512 MiB, each a request of its own.

### What Free limits, and what a player sees when a daily allowance runs out

| Free allowance (per day) | What reaches it | What the store answers | What the product does today |
|---|---|---|---|
| 100,000 Worker requests, for the whole account (staging and workers.dev included), reset at 00:00 UTC | every API call, the Community pages too; a mod publish is about 20, a download 2 | Cloudflare answers before the Worker with its error 1027 page (the HTTP status is not documented) and the whole API is down until 00:00 UTC | for a 429 or 5xx a publish says "The map was not published" with the reason, keeps the map and leaves the upload in the retry queue (retried at the next launch and after the next store call that works); another status is an unexpected answer and the publish is refused the same way; a download asks again later. The site's Community pages stop too. |
| 100,000 Durable Object requests, 5 million rows read, 100,000 rows written, 5 GB stored | every mod-store call is one or two; a publish of a unit of N new files writes about 3N + 20 rows (5N + 25 before R-DS6; `tests/worker_rows_test.js`), a download of a unit 2 | 503, "The mod store is unavailable right now; try again later.", with `Retry-After` until the next UTC day | the same as a 429: nothing is lost, the upload stays queued, the map stays on the author's machine |
| 10 ms of CPU a Worker request | the Worker's own work (3 to 6 ms an upload request, up to about 70 ms piping a 4 GB download, which Free has let through) | | |

The store never leaves half a state behind at a cap: an upload in parts keeps its parts for a day
and resumes, a claim is one transaction, a staged upload is packed later. The product should, and
does not yet, honour `Retry-After`, finish a refused publish by itself once the store answers again,
and say "the mod store is busy" rather than "could not be reached" for a 429 or 503 (the product's
own work, not this repository's).

### Switching to Workers Paid

One step, after subscribing to Workers Paid (5 USD a month) in the Cloudflare dashboard:

1. In `api/wrangler.toml` (and `api/wrangler.staging.toml` for staging), uncomment the two lines
   `[limits]` and `cpu_ms = 300000`, and deploy from `api/` with `npx wrangler deploy`.

What changes: every request (Worker or Durable Object) may use up to 5 minutes of CPU, and the
daily allowances become monthly included amounts with usage billing (10 million Worker requests,
1 million Durable Object requests, 50 million rows written, 25 billion rows read and 5 GB stored a
month included). Nothing in the code changes. On Free the same deploy is refused by Cloudflare
("CPU limits are not supported for the Free plan", code 100328) and the running version keeps
serving, so the line cannot be switched on by mistake.

How to verify: `npx wrangler deploy` succeeds and lists the limit; `npx wrangler deployments list`
shows the new version at 100%; `curl https://api.snapmapplus.com/` answers
"snapmap-plus community service: OK"; a mod publish from the product goes through. Rolling back
is commenting the two lines again and deploying (before leaving Paid).
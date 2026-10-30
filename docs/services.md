# External services

The services behind the website and its API, who holds their credentials, and
what a fork must provision. None of them is billed today; hosting charges depend
on the account plan and usage. The mod store is the first service whose cost grows
with community use; at Cloudflare's listed R2 prices it is expected to cost dollars
per month at plausible scale.

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
| R2 (mod store) | Anonymous Snapmap+ mod blobs and bundle manifests, bucket `snapmap-plus-mods`; billed per use for storage, Class A writes and Class B reads, with free egress | `MODS` binding | Players cannot fetch the mods a map needs; installed mods and vanilla maps are unaffected. |
| SQLite Durable Object (mod index) | Index of stored mod objects and their anonymous claims; per-address limits use `WRITE_QUOTAS` | `MOD_REGISTRY` binding and its `v2-mod-registry` migration; optional secret `MODS_ADDRESS_KEY` | Mod store routes fail closed with HTTP 503. |
| Workers Cron Trigger | Daily purge of unclaimed mod objects older than seven days | `[triggers]` in `api/wrangler.toml` | Unclaimed objects stay stored and unserved. |
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

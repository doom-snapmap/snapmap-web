# snapmap-web

## Purpose

The public website for Snapmap+ at [www.snapmapplus.com](https://www.snapmapplus.com/)
and the API that serves its Community pages. Snapmap+ itself, the DOOM (2016)
SnapMap editor extension, lives in [snapmap-plus](https://github.com/doom-snapmap/snapmap-plus);
this repository holds everything players see in a browser.

## Contents

| Path | Responsibility |
|---|---|
| [site/](site/README.md) | Jekyll source: landing page, player guide, changelog, privacy policy, Community pages. |
| [api/](api/README.md) | Cloudflare Worker: GitHub Discussions, sign-in sessions, screenshot uploads. |
| [tests/](tests/README.md) | Worker unit and local-runtime tests. |
| [docs/services.md](docs/services.md) | Hosted services, credentials and fork setup. |
| [.github/](.github/workflows/) | `ci.yml` checks pull requests; `pages.yml` publishes the site. |

## How the pieces connect

- The site is static and published by GitHub Pages on every push to `main`.
- The changelog page reads the product's published GitHub Releases in the browser.
  Release notes are written and reviewed in snapmap-plus; nothing here duplicates them.
- The Download button resolves the newest stable installer from the same Releases call.
- Community pages talk to the Worker at `https://api.snapmapplus.com`, which stores
  posts as GitHub Discussions on this repository.
- The in-app feedback relay is not here: it belongs to the product and files issues on
  snapmap-plus.

## Working here

Run the Worker tests from the repository root with Node 22.13 or newer:

```text
node tests/worker_body_test.js
node tests/worker_quota_test.js
node tests/worker_mods_test.js
npm install --prefix build/worker-tests --no-audit --no-fund --no-package-lock miniflare@4.20260730.0
node tests/worker_runtime_test.js build/worker-tests/node_modules/miniflare
```

Preview the site with a local Jekyll build of `site/`. Deploying the Worker is a
maintainer operation described in [api/README.md](api/README.md).

Commit messages follow the snapmap-plus
[contributing guide](https://github.com/doom-snapmap/snapmap-plus/blob/main/docs/contributing.md):
an imperative subject and one to three short sentences saying what changed and why.

## License

MIT. See [LICENSE](LICENSE).

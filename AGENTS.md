# Agent Instructions

This repository is the Snapmap+ website and its API Worker. The product, its
release notes and its feedback relay live in `doom-snapmap/snapmap-plus`; do not
copy release notes or product documentation here. The changelog page reads
published GitHub Releases, and the Community pages read this repository's
Discussions through the Worker in `api/`.

Commit messages follow the snapmap-plus contributing guide: a clear imperative
subject, then one to three short sentences (about 60 words, never more than 80)
saying what changed and why. No labeled fields, checklists or bullet lists.

Run the Worker tests in `tests/` before committing Worker changes. Deploying the
Worker or changing its secrets is a maintainer decision; never commit secrets,
`.dev.vars` or `.wrangler/` state. Keep GitHub Actions pinned to commit SHAs.

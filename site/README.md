# Website

## Purpose

Contains the Jekyll source for the public Snapmap+ website at
`https://www.snapmapplus.com/`: the landing page, player guide, changelog,
privacy policy and Community pages.

## Contents

- `index.html`, `changelog.html` and `community*.html` define the main pages.
- `snapmap-plus-guide.md` and `privacy.md` contain player documentation.
- `_layouts/` and `_includes/` share page framing and navigation.
- `assets/` contains scripts and styles; `images/` contains screenshots.
- `_config.yml` configures Jekyll; `sitemap.xml` lists public pages; `CNAME`
  names the custom domain for GitHub Pages.

## Working here

The [Pages workflow](../.github/workflows/pages.yml) builds this directory with
Jekyll on every push to `main`. The site holds no release notes: `changelog.html`
reads the product's published GitHub Releases in the browser (`assets/site.js`),
whose bodies are the reviewed `CHANGELOG.md` entries from the
[snapmap-plus](https://github.com/doom-snapmap/snapmap-plus) repository, and
renders them with the same grammar. Betas appear as prereleases. The Download
button resolves the newest stable installer from the same call.

Community pages call the [API Worker](../api/README.md) at
`https://api.snapmapplus.com`; keep `WORKER` in `assets/community.js` aligned with
its custom domain.

Use a local Jekyll preview to verify Liquid includes and Markdown pages. Check
narrow layouts and keyboard navigation when changing presentation. Directory
READMEs are contributor documentation and are excluded from the published site.

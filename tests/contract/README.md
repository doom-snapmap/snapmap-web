# The product's mod-store client

`client.json` is what the Snapmap+ product's map-content client (`src/backend/modnet.c`,
`modcache.c`, `modkey.c` and `modzip.c` in `doom-snapmap/snapmap-plus`) sends and what it
accepts, route by route, with the product commit it was read from and recorded against.
`../worker_contract_test.js` replays it against the Worker under Miniflare in CI, so a Worker
change the client would not understand fails before it is deployed.

## Recording it again

When the product's client changes:

1. Start the Worker on a loopback port with every exchange recorded:
   `node tests/contract/record_server.js . build/worker-tests/node_modules/miniflare 8799 record.json`.
2. Run the product's own client against it: `unit_roundtrip store=http://127.0.0.1:8799 work=<folder> mod=<a built pack>`
   `doom=<install> names=<two placed names> placed=<the entity map 1 places>` (the product's `tests/unit_roundtrip.c`,
   built by its `tests/run-tests.ps1`). It publishes two units with a P-256 key, downloads one into a clean cache and
   composes it, remixes it with a second key, reports and lists an asked path and releases every claim.
3. Compare `record.json` with `client.json`: every request shape (method, path, headers,
   body keys) and every status and answer the client read must be one `client.json` describes.
   Update `client.json` (its `product.commit`, the routes and `recorded`) and the Worker in the
   same change.
# The product's mod-store client

`client.json` is what the Snapmap+ product's mod-store client (`src/backend/modnet.c`,
`modsync.c`, `modzip.c` and `modbundle.c` in `doom-snapmap/snapmap-plus`) sends and what it
accepts, route by route, with the product commit it was read from and recorded against.
`../worker_contract_test.js` replays it against the Worker under Miniflare in CI, so a Worker
change the client would not understand fails before it is deployed.

## Recording it again

When the product's client changes:

1. Start the Worker on a loopback port with every exchange recorded:
   `node tests/contract/record_server.js . build/worker-tests/node_modules/miniflare 8799 record.json`.
2. Point the product's client at `http://127.0.0.1:8799` (the `mods.store` setting, or
   `modnet_set_base_url` in a test program) and publish a small mod (one request) and a mod over
   32 MiB (parts), play the map as a second player, republish, report a missing file, read the
   asked list and unpublish.
3. Compare `record.json` with `client.json`: every request shape (method, path, headers,
   body keys) and every status and answer the client read must be one `client.json` describes.
   Update `client.json` (its `product.commit`, the routes and `recorded`) and the Worker in the
   same change.
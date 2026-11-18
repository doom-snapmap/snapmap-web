'use strict';
/* The Worker under Miniflare on a loopback port, with every exchange recorded: method, path
 * (hashes and claim ids replaced by their kind), the request headers the client sends, the
 * request body's shape, the status, the response headers a client may read, and the response
 * body's shape. The product's client talks to it over plain http, which modnet.c accepts for a
 * loopback host (its mods.store setting, or modnet_set_base_url in a test program).
 *
 *   node tests/contract/record_server.js . build/worker-tests/node_modules/miniflare <port> <record.json>
 *
 * The maintainer token for /mods/admin/stats is in <scratch>/token, printed at start and deleted
 * with the scratch folder when the server stops (Ctrl+C). */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const [root, mfPath, portText, recordPath] = process.argv.slice(2);
const { Miniflare } = require(path.resolve(mfPath));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmap-web-record-'));
const token = crypto.randomBytes(24).toString('hex');
fs.writeFileSync(path.join(scratch, 'token'), token);   // for the driver's stats calls; deleted with the folder

const mf = new Miniflare({
  name: 'contract-record', modules: true, modulesRoot: root, scriptPath: path.join(root, 'api/worker.js'),
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2026-07-01',
  durableObjects: { WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true }, MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
  durableObjectsPersist: path.join(scratch, 'do'), r2Persist: path.join(scratch, 'r2'),
  kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'], bindings: { MODS_ADMIN_TOKEN: token },
  outboundService: () => { throw new Error('unexpected external request'); },
});

const SHOWN_REQUEST = ['content-type', 'content-length', 'x-blob-size', 'accept', 'range', 'if-range', 'x-publisher-key', 'x-publisher-name', 'x-publisher-signature', 'user-agent'];
const SHOWN_RESPONSE = ['content-type', 'content-length', 'etag', 'retry-after', 'content-range', 'accept-ranges'];
const exchanges = [];

function shape(value) {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, shape(value[k])]));
  if (typeof value === 'string') return /^[0-9a-f]{64}$/.test(value) ? 'hex64' : /^[0-9a-f]{32}$/.test(value) ? 'hex32' : 'string';
  return typeof value;
}

function route(p) {
  return p.replace(/[0-9a-f]{64}/g, '<hash>').replace(/\/parts\/\d+$/, '/parts/<n>');
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  let bytes = 0;
  const isJson = (req.headers['content-type'] || '').startsWith('application/json');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new ReadableStream({
    start(controller) {
      req.on('data', c => { bytes += c.length; if (isJson) chunks.push(c); controller.enqueue(new Uint8Array(c)); });
      req.on('end', () => controller.close());
      req.on('error', e => controller.error(e));
    },
  });
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (k !== 'host' && k !== 'connection') headers[k] = v;
  let response;
  try {
    response = await mf.dispatchFetch('http://local.test' + req.url, { method: req.method, headers, body, duplex: 'half' });
  } catch (error) {
    res.writeHead(502); res.end(String(error)); return;
  }
  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, out);
  let respBody = null;
  if (req.method !== 'HEAD' && response.body) {
    const json = (out['content-type'] || '').startsWith('application/json');
    const reader = response.body.getReader();
    const keep = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (json) keep.push(Buffer.from(value));
      res.write(Buffer.from(value));
    }
    if (json) { try { respBody = shape(JSON.parse(Buffer.concat(keep).toString('utf8'))); } catch { respBody = 'unparsed'; } }
  }
  res.end();
  const sent = {};
  for (const k of SHOWN_REQUEST) {
    if (req.headers[k] === undefined) continue;
    sent[k] = k === 'content-length' || k === 'x-blob-size' ? 'number' : k.startsWith('x-publisher-') ? 'present' : k === 'range' ? 'bytes=<from>-' : req.headers[k];
  }
  const got = {};
  for (const k of SHOWN_RESPONSE) if (out[k] !== undefined) got[k] = k === 'content-type' || k === 'accept-ranges' ? out[k] : typeof out[k];
  let reqBody = null;
  if (isJson && chunks.length) { try { reqBody = shape(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reqBody = 'unparsed'; } }
  exchanges.push({ method: req.method, route: route(req.url), request: { headers: sent, body: reqBody ?? (bytes ? 'bytes' : null) },
    status: response.status, response: { headers: got, body: respBody } });
  fs.writeFileSync(recordPath, JSON.stringify(exchanges, null, 1));
});

mf.ready.then(() => server.listen(Number(portText), '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: 'http://127.0.0.1:' + portText, scratch }));
}));

process.on('SIGINT', async () => { server.close(); await mf.dispose(); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); });

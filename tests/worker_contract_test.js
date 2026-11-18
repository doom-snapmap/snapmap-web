'use strict';
/* The product's mod-store client against this Worker: every request in the shape the client
 * sends it (tests/contract/client.json, read from the product's modnet.c and recorded from a run
 * of the product's own client), every answer checked against what the client accepts, under
 * Miniflare (the real runtime, with R2, the registry's alarm and its packer).
 *
 *   node tests/worker_contract_test.js <miniflare module path> */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomBytes } = require('node:crypto');
const { Miniflare } = require(process.argv[2] ? path.resolve(process.argv[2]) : 'miniflare');

const root = path.join(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract', 'client.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmap-web-contract-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const observed = new Set();

/* ---------------- archives in the client's form (modzip.c) ---------------- */

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zip(entries) {
  const parts = [], records = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name), local = Buffer.alloc(30), crc = crc32(data);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    records.push({ n, crc, size: data.length, offset });
    offset += 30 + n.length + data.length;
  }
  const cd = offset;
  for (const r of records) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(r.crc, 16);
    c.writeUInt32LE(r.size, 20); c.writeUInt32LE(r.size, 24); c.writeUInt16LE(r.n.length, 28); c.writeUInt32LE(r.offset, 42);
    parts.push(c, r.n);
    offset += 46 + r.n.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - cd, 12); end.writeUInt32LE(cd, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/* A built mod as the product writes it: the author part, the builder block, the archive. */
function built(salt, files, block = {}) {
  const hash = sha(randomBytes(32));
  const doc = { name: 'Contract Imp', author: 'contract', 'snapmap-plus': { format: 2, salt, rules: 12, built: 1794000000, build: hash,
    tree: 'a'.repeat(64), classes: { adds: files.length }, editor: [], registries: {}, ...block,
    files: files.map(f => ({ needs: [], path: 'assets/' + f.request, provides: { name: f.request, type: 'image' }, sha256: sha(f.data), size: f.data.length })) } };
  const modjson = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
  return { hash, bytes: zip([{ name: 'mod.json', data: modjson }, ...files.map(f => ({ name: 'assets/' + f.request, data: f.data }))]) };
}

/* ---------------- checking an answer against what the client accepts ---------------- */

function typed(value, type) {
  if (type === 'hex64') return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (type === 'hex32') return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'integer>=1') return Number.isSafeInteger(value) && value >= 1;
  if (type === 'array of part numbers') return Array.isArray(value) && value.every(n => Number.isSafeInteger(n) && n >= 1);
  if (type === true) return value === true;
  if (Array.isArray(type)) return Array.isArray(value) && value.every(v => Object.entries(type[0]).every(([k, t]) => typed(v[k], t)));
  throw new Error('unknown type ' + JSON.stringify(type));
}

function bodyMatches(body, spec) {
  return body && Object.entries(spec).every(([k, t]) => typed(body[k], t));
}

/* Sends a request the way the client builds it for `route` and checks the answer. Returns the
 * response and, for JSON, its body. */
async function exchange(send, routeName, { hash, n, body, bytes, size, expect } = {}) {
  const spec = contract.routes[routeName];
  const p = spec.request.path.replace('<hash>', hash || '').replace('<n>', String(n));
  const headers = { Accept: contract.transport.accept };
  let payload;
  if (spec.request.headers['content-type']) headers['Content-Type'] = spec.request.headers['content-type'];
  if (body !== undefined) payload = JSON.stringify(body);
  if (bytes !== undefined) payload = bytes;
  if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
  if (spec.request.headers['x-build-size']) headers['X-Build-Size'] = String(size);
  const response = await send(spec.request.method, p, payload, headers);
  const route = spec.request.path.replace(/\/parts\/<n>$/, '/parts/<n>');
  observed.add(spec.request.method + ' ' + route + ' ' + response.status);
  const json = (response.headers.get('content-type') || '').startsWith('application/json') && spec.request.method !== 'HEAD'
    ? await response.json() : null;
  if (!json && spec.request.method !== 'GET') await response.arrayBuffer();
  const what = routeName + ' ' + response.status;
  if (expect !== undefined) assert.equal(response.status, expect, what + ' ' + JSON.stringify(json));
  if (response.status >= 400) {
    /* What the client shows: the printable ASCII of "error", whole. */
    if (spec.request.method !== 'HEAD') assert.ok(json && typeof json.error === 'string' && /^[\x20-\x7e]+$/.test(json.error), what + ': a refusal is one sentence');
    return { response, json };
  }
  assert.ok(spec.accepts.status.includes(response.status), what + ': a status the client accepts');
  for (const [header, type] of Object.entries(spec.accepts.headers || {})) {
    const value = response.headers.get(header);
    assert.ok(value !== null && (type !== 'integer' || /^\d+$/.test(value)), what + ': ' + header);
  }
  if (spec.accepts.body && typeof spec.accepts.body === 'object') assert.ok(bodyMatches(json, spec.accepts.body), what + ': ' + JSON.stringify(json));
  if (spec.accepts.oneOf) {
    const which = spec.accepts.oneOf.find(o => bodyMatches(json, o.body));
    assert.ok(which, what + ': the parts answer is one of the forms the client reads: ' + JSON.stringify(json));
    if (which.rule) assert.equal(Math.ceil(size / json.partSize), json.parts, 'ceil(size / partSize) == parts');
  }
  return { response, json };
}

/* The client's upload: one PUT up to the single-request maximum, else parts, four at a time. */
async function upload(send, archive) {
  const size = archive.bytes.length;
  if (size <= contract.transport.singleRequestMax) return exchange(send, 'put', { hash: archive.hash, bytes: archive.bytes });
  const { json } = await exchange(send, 'partsStart', { hash: archive.hash, body: { size }, size });
  if (json.stored) return { json };
  const todo = Array.from({ length: json.parts }, (_, i) => i + 1).filter(k => !json.have.includes(k));
  const worker = async () => {
    for (let k; (k = todo.shift()) !== undefined;) {
      const bytes = archive.bytes.subarray((k - 1) * json.partSize, Math.min(size, k * json.partSize));
      await exchange(send, 'part', { hash: archive.hash, n: k, bytes, size, expect: 200 });
    }
  };
  await Promise.all(Array.from({ length: contract.transport.partWorkers }, worker));
  return exchange(send, 'complete', { hash: archive.hash, body: { size } });
}

async function run() {
  /* What the store must mirror of the product's rules. */
  const mods = await import(pathToFileURL(path.join(root, 'api', 'mods_store.js')));
  for (const ext of contract.archive.carriedExtensions) assert.ok(mods.CARRIED_EXTENSIONS.has(ext), 'the store carries .' + ext + ', as the product builder does');
  assert.ok(mods.ONE_REQUEST_MAX >= contract.transport.singleRequestMax, 'the store takes in one request what the client sends in one');

  const mf = new Miniflare({
    name: 'contract', modules: true, modulesRoot: root, scriptPath: path.join(root, 'api/worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2026-07-01',
    durableObjects: { WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true }, MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
    durableObjectsPersist: path.join(scratch, 'do'), kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'], bindings: { MODS_BLOCKED: '[]' },
    outboundService: () => { throw new Error('unexpected external request'); },
  });
  try {
    const send = (method, route, body, headers) => mf.dispatchFetch('http://local.test' + route, { method, body, headers });
    const salt = 'c0ntract';
    const small = built(salt, [{ request: 'generated/image/mods/' + salt + '/small.bimage', data: randomBytes(4096) }]);
    const large = built(salt, [{ request: 'generated/image/mods/' + salt + '/large.bimage', data: randomBytes(contract.transport.singleRequestMax + 1024) },
      { request: 'mods/' + salt + '/scripts/main.lua', data: Buffer.from('return {}\n') }], { scripts: { files: 1 } });

    /* Publish: HEAD each build, upload the ones the store lacks, claim them under the item. */
    for (const b of [small, large]) {
      await exchange(send, 'head', { hash: b.hash, expect: 404 });
      const { response } = await upload(send, b);
      assert.equal(response.status, 201, 'a new build is created');
    }
    const { json: made } = await exchange(send, 'claim', { body: { builds: [small.hash, large.hash], ref: 'contract-item' }, expect: 201 });

    /* A player: HEAD (size and scripts before asking), GET, byte for byte. */
    for (const b of [small, large]) {
      const { response } = await exchange(send, 'head', { hash: b.hash, expect: 200 });
      assert.equal(response.headers.get('content-length'), String(b.bytes.length));
      assert.equal(response.headers.get('x-mod-scripts'), b === large ? '1' : '0');
      const got = await exchange(send, 'get', { hash: b.hash, expect: 200 });
      assert.equal(sha(Buffer.from(await got.response.arrayBuffer())), sha(b.bytes), 'the archive comes back byte for byte');
    }

    /* Republish: what the store holds under a claim is not sent again; the re-claim keeps its secret. */
    const again = await upload(send, large);
    assert.ok(again.json.stored, 'a claimed build is answered "stored", so the client sends nothing');
    const { json: kept } = await exchange(send, 'claim', { body: { builds: [large.hash], ref: 'contract-item', secret: made.secret }, expect: 200 });
    assert.equal(kept.secret, made.secret, 'with a secret sent, the same secret comes back');
    await exchange(send, 'head', { hash: small.hash, expect: 404 });

    /* What players asked for: a whole build lacks nothing; the claim's list is readable. */
    await exchange(send, 'asked', { hash: large.hash, body: { by: 'contract', request: 'generated/image/mods/' + salt + '/x.bimage' }, expect: 404 });
    const { json: list } = await exchange(send, 'askedList', { body: { claim: made.claim, secret: made.secret }, expect: 200 });
    assert.deepEqual(list, { asked: [] });

    /* Unpublish: the release deletes what no claim names. */
    await exchange(send, 'release', { body: { claim: made.claim, secret: made.secret }, expect: 204 });
    await exchange(send, 'head', { hash: large.hash, expect: 404 });

    for (const r of contract.recorded) assert.ok(observed.has(r.method + ' ' + r.route + ' ' + r.status), 'the recorded exchange ' + JSON.stringify(r) + ' was replayed');
    console.log('worker contract: ' + observed.size + ' kinds of exchange, every one the product client makes, answered as it accepts');
  } finally { await mf.dispose(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

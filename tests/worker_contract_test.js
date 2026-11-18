'use strict';
/* The product's map-content client against this Worker: every request in the shape the client sends it
 * (tests/contract/client.json, read from the product's modnet.c and modcache.c and recorded from a run of the
 * product's own client, tests/unit_roundtrip.c there), signed as modkey.c signs, every answer checked against what
 * the client accepts, under Miniflare (the real runtime, with R2 and the registry and checker Durable Objects).
 *
 *   node tests/worker_contract_test.js <miniflare module path> */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomBytes, generateKeyPairSync, sign: nodeSign } = require('node:crypto');
const { Miniflare } = require(process.argv[2] ? path.resolve(process.argv[2]) : 'miniflare');

const root = path.join(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract', 'client.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmap-web-contract-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const observed = new Set();

/* ---------------- the client's forms ---------------- */

function zip(entries) {
  const parts = [], records = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name), local = Buffer.alloc(30), crc = zlib.crc32(data);
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

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

function unit(files) {
  const list = Object.keys(files).sort().map(p => ({ path: p, sha256: sha(files[p]), size: files[p].length }));
  const manifest = Buffer.from(canonical({ files: list, format: 1, game: [], mod: {}, root: { kind: 'entity', name: 'entities/contract' } }));
  return { hash: sha(manifest), manifest, list, files };
}

function key() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, pub: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url') };
}

/* modkey.c mk_sign's headers. */
function signedHeaders(k, method, route, body, name) {
  const header = name ? encodeURIComponent(name) : '';
  const message = 'snapmap-plus/request/1\n' + method + '\n' + route + '\n' + header + '\n' + sha(body);
  const h = { 'X-Publisher-Key': k.pub, 'X-Publisher-Signature': nodeSign('sha256', Buffer.from(message), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  if (header) h['X-Publisher-Name'] = header;
  return h;
}

/* ---------------- checking an answer against what the client accepts ---------------- */

function typed(value, type) {
  if (type === 'hex64') return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'integer>=1') return Number.isSafeInteger(value) && value >= 1;
  if (type === 'array of part numbers') return Array.isArray(value) && value.every(n => Number.isSafeInteger(n) && n >= 1);
  if (type === 'array of hex64 (at least one)') return Array.isArray(value) && value.length > 0 && value.every(v => typed(v, 'hex64'));
  if (type === true) return value === true;
  if (Array.isArray(type)) return Array.isArray(value) && value.every(v => Object.entries(type[0]).every(([k, t]) => typed(v[k], t)));
  throw new Error('unknown type ' + JSON.stringify(type));
}

function bodyMatches(body, spec) {
  return body && Object.entries(spec).every(([k, t]) => typed(body[k], t));
}

/* One exchange in the client's shape: the request built from client.json's route, the answer checked. */
async function exchange(mf, name, { hash, n, body, json, signer, headers = {}, expect }) {
  const r = contract.routes[name];
  assert.ok(r, 'client.json has no route ' + name);
  const route = r.request.path.replace('<hash>', hash || '').replace('<n>', String(n || ''));
  const bytes = body !== undefined ? Buffer.from(body) : json !== undefined ? Buffer.from(JSON.stringify(json)) : null;
  const h = { 'User-Agent': 'snapmap-plus/1.0', Accept: contract.transport.accept, 'CF-Connecting-IP': '203.0.113.50', ...headers };
  if (r.request.headers['content-type']) h['Content-Type'] = r.request.headers['content-type'];
  if (bytes) h['Content-Length'] = String(bytes.length);
  if (r.request.headers.signed) Object.assign(h, signedHeaders(signer, r.request.method, route, bytes || Buffer.alloc(0), 'Contract Tester'));
  const res = await mf.dispatchFetch('http://local.test' + route, { method: r.request.method, body: r.request.method === 'GET' ? undefined : (bytes || Buffer.alloc(0)), headers: h });
  const raw = Buffer.from(await res.arrayBuffer());
  const statuses = expect ? [expect] : r.accepts.status;
  assert.ok(statuses.includes(res.status), name + ' answered ' + res.status + ': ' + raw.toString().slice(0, 300));
  let parsed = null;
  if ((res.headers.get('content-type') || '').startsWith('application/json')) parsed = JSON.parse(raw.toString('utf8'));
  if (!expect && r.accepts.body && typeof r.accepts.body === 'object' && res.status < 300) assert.ok(bodyMatches(parsed, r.accepts.body), name + ' answer shape: ' + raw.toString().slice(0, 300));
  if (!expect && r.accepts.oneOf) assert.ok(r.accepts.oneOf.some(o => bodyMatches(parsed, o.body)), name + ' answer: ' + raw.toString());
  if (res.status >= 400) assert.ok(parsed && typeof parsed.error === 'string' && /^[\x20-\x7e]+$/.test(parsed.error), name + ' refusal is one plain sentence');
  observed.add(name);
  return { status: res.status, body: parsed, raw, headers: res.headers };
}

async function run() {
  const mf = new Miniflare({
    name: 'contract', modules: true, modulesRoot: root, scriptPath: path.join(root, 'api/worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2026-07-01',
    durableObjects: { WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true }, MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
    durableObjectsPersist: path.join(scratch, 'do'), r2Persist: path.join(scratch, 'r2'),
    kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'],
    outboundService: () => { throw new Error('unexpected external request'); },
  });
  try {
    const a = key(), b = key();
    const big = randomBytes(16 * 1024 * 1024 + 3000);
    const u = unit({ 'entities/contract.decl': Buffer.from('entityDef'), 'images/contract.bimage': randomBytes(70000),
      'virtual-textures/contract_sq1.mega2': big });
    let x = await exchange(mf, 'status', { json: { units: [u.hash] } });
    assert.equal(x.body[u.hash], 'missing');
    x = await exchange(mf, 'begin', { hash: u.hash, body: u.manifest, signer: a });
    assert.equal(x.body.missing.length, 3);
    const bigSha = sha(big);
    x = await exchange(mf, 'partsStart', { hash: bigSha, json: { size: big.length }, signer: a });
    assert.equal(Math.ceil(big.length / x.body.partSize), x.body.parts);
    for (let n = 1; n <= x.body.parts; n++) {
      const part = big.subarray((n - 1) * x.body.partSize, n * x.body.partSize);
      await exchange(mf, 'part', { hash: bigSha, n, body: part, headers: { 'X-Blob-Size': String(big.length) } });
    }
    await exchange(mf, 'partsComplete', { hash: bigSha, json: { size: big.length }, signer: a });
    const rest = u.list.filter(f => f.sha256 !== bigSha).map(f => ({ name: f.path, data: u.files[f.path] }));
    x = await exchange(mf, 'put', { hash: u.hash, body: zip([{ name: 'unit.json', data: u.manifest }, ...rest]), signer: a });
    assert.equal(x.body.held, true);
    await exchange(mf, 'complete', { hash: u.hash, body: '', signer: a });
    x = await exchange(mf, 'begin', { hash: u.hash, body: u.manifest, signer: b });
    assert.equal(x.body.held, true);
    x = await exchange(mf, 'manifest', { hash: u.hash });
    assert.equal(sha(x.raw), u.hash);
    x = await exchange(mf, 'blob', { hash: bigSha, headers: { Range: 'bytes=1000-' } });
    assert.equal(x.status, 206);
    assert.ok(x.raw.equals(big.subarray(1000)));
    x = await exchange(mf, 'archive', { hash: u.hash });
    assert.equal(x.status, 200);
    x = await exchange(mf, 'claim', { json: { ref: 'contract-map', rev: 1, secret: 'a'.repeat(64), units: [u.hash] }, signer: a });
    assert.equal(x.status, 201);
    assert.equal(x.body.rev, 1);
    x = await exchange(mf, 'claim', { json: { ref: 'contract-map', rev: 1, secret: 'a'.repeat(64), units: [u.hash] }, signer: a, expect: 409 });
    assert.equal(x.body.rev, 1);
    x = await exchange(mf, 'claim', { json: { ref: 'contract-remix', rev: 1, secret: 'b'.repeat(64), units: [u.hash] }, signer: b });
    await exchange(mf, 'asked', { hash: u.hash, json: { path: 'images/contract_missing.bimage' } });
    x = await exchange(mf, 'askedList', { json: { claims: [{ ref: 'contract-map', secret: 'a'.repeat(64) }] }, signer: a });
    assert.deepEqual(x.body.asked.map(e => e.path), ['images/contract_missing.bimage']);
    await exchange(mf, 'release', { json: { ref: 'contract-map', rev: 2, secret: 'a'.repeat(64) }, signer: a });
    await exchange(mf, 'release', { json: { ref: 'contract-map', rev: 3, secret: 'a'.repeat(64) }, signer: a, expect: 404 });
    await exchange(mf, 'release', { json: { ref: 'contract-remix', rev: 2, secret: 'b'.repeat(64) }, signer: b });
    x = await exchange(mf, 'manifest', { hash: u.hash });   /* the deletion delay: still served */
    for (const name of Object.keys(contract.routes)) assert.ok(observed.has(name), 'route not exercised: ' + name);
    console.log('worker contract: ' + observed.size + ' kinds of exchange, every one the product client makes, answered as it accepts');
  } finally { await mf.dispose(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { Miniflare } = require(process.argv[2] ? path.resolve(process.argv[2]) : 'miniflare');

const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmap-web-worker-'));
const sidA = 'a'.repeat(64), sidB = 'b'.repeat(64), sidC = 'c'.repeat(64);
const image = new Uint8Array(16);
image.set([0x89, 0x50, 0x4e, 0x47]);

function community() {
  return new Miniflare({
    name: 'community-runtime-test',
    modules: true, modulesRoot: root, scriptPath: path.join(root, 'api/worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-01',
    durableObjects: { WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true },
                      MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true } },
    durableObjectsPersist: path.join(scratch, 'quotas'),
    kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'], bindings: { MODS_BLOCKED: '[]' },
    outboundService: () => { throw new Error('unexpected external request'); },
  });
}

async function seed(mf) {
  const sessions = await mf.getKVNamespace('SESSIONS');
  for (const [sid, id] of [[sidA, '42'], [sidB, '42'], [sidC, '99']]) {
    await sessions.put('session:' + sid, JSON.stringify({ id, token: 'local-test-token', login: 'tester' }));
  }
}

function upload(mf, sid) {
  return mf.dispatchFetch('http://local.test/media/upload', { method: 'POST', body: image,
    headers: { Authorization: 'Bearer ' + sid, Origin: 'https://www.snapmapplus.com' } });
}

async function run() {
  let mf = community();
  try {
    await seed(mf);
    const replies = await Promise.all(Array.from({ length: 45 }, (_, i) => upload(mf, i % 2 ? sidA : sidB)));
    assert.equal(replies.filter(response => response.status === 200).length, 30);
    assert.equal(replies.filter(response => response.status === 429).length, 15);
    assert.ok(replies.every(response => response.headers.get('Access-Control-Allow-Origin') === 'https://www.snapmapplus.com'));
    for (const response of replies) await response.arrayBuffer();
    const other = await upload(mf, sidC);
    assert.equal(other.status, 200);
    await other.arrayBuffer();
    const media = await mf.getR2Bucket('MEDIA');
    assert.equal((await media.list()).objects.length, 31);
  } finally { await mf.dispose(); }

  mf = community();
  try {
    await seed(mf);
    const retained = await upload(mf, sidA);
    assert.equal(retained.status, 429, 'quota was lost when the object restarted');
    await retained.arrayBuffer();
  } finally { await mf.dispose(); }

  mf = community();
  try { await mods(mf); } finally { await mf.dispose(); }

  console.log('worker runtime: concurrent per-account quotas, restart persistence and R2 passed');
  console.log('worker runtime: mod store streaming, R2 checksum refusal, bundles and claims passed');
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value !== null && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);

async function mods(mf) {
  const send = (method, route, body, headers = {}) => mf.dispatchFetch('http://local.test' + route, { method, body, headers });
  const blob = randomBytes(5 * 1024 * 1024 + 17);
  const hash = sha(blob);
  const octet = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.length) };
  const wrong = sha(Buffer.from('wrong'));
  const mismatch = await send('PUT', '/mods/blob/' + wrong, blob, octet);
  assert.equal(mismatch.status, 422, await mismatch.text());
  const bucket = await mf.getR2Bucket('MODS');
  assert.equal(await bucket.head('blob/' + wrong), null, 'mismatched bytes were committed');
  await assert.rejects(bucket.put('probe', new Uint8Array([1]), { sha256: wrong }), 'R2 accepted a wrong sha256 checksum');

  const created = await send('PUT', '/mods/blob/' + hash, blob, octet);
  assert.equal(created.status, 201, await created.clone().text());
  await created.arrayBuffer();
  const again = await send('PUT', '/mods/blob/' + hash, blob, octet);
  assert.equal(again.status, 200);
  await again.arrayBuffer();
  const got = await send('GET', '/mods/blob/' + hash);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), hash);
  const head = await send('HEAD', '/mods/blob/' + hash);
  assert.equal(head.status, 200);
  await head.arrayBuffer();

  const request = 'generated/decls/entitydef/mods/alex.pink-imp/pink_imp.decl';
  const manifest = { format: 1, id: 'alex.pink-imp', build: 1, version: '1.0.0', name: 'Pink Imp', files: [{
    path: 'assets/' + request, request, blob: hash, size: blob.length, provides: { type: 'entityDef', name: 'mods/alex.pink-imp/pink_imp' } }] };
  const text = canonical(manifest), bundle = sha(Buffer.from(text));
  const missing = await send('POST', '/mods/missing', JSON.stringify({ blobs: [hash, wrong] }));
  assert.deepEqual(await missing.json(), { missing: [wrong] });
  const stored = await send('PUT', '/mods/bundle/' + bundle, text);
  assert.equal(stored.status, 201, await stored.clone().text());
  await stored.arrayBuffer();
  const served = await send('GET', '/mods/bundle/' + bundle);
  assert.equal(await served.text(), text);
  const claim = await send('POST', '/mods/claim', JSON.stringify({ ref: 'runtime-item', bundles: [bundle] }));
  assert.equal(claim.status, 201);
  const { claim: id, secret } = await claim.json();
  const release = await send('POST', '/mods/release', JSON.stringify({ claim: id, secret }));
  assert.equal(release.status, 204);
  await release.arrayBuffer();
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

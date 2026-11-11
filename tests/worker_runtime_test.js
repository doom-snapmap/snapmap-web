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
  console.log('worker runtime: mod store archive streaming, refusal before commit, claims and release passed');
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* A stored ZIP in the product's form (modzip.c): local headers, central directory, end record. */
function zip(entries) {
  const parts = [], records = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const n = Buffer.from(name), local = Buffer.alloc(30), crc = crc32(data);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    records.push({ n, crc, size: data.length, offset, method });
    offset += 30 + n.length + data.length;
  }
  const cd = offset;
  for (const r of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(r.method, 10);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(r.crc, 16); central.writeUInt32LE(r.size, 20); central.writeUInt32LE(r.size, 24);
    central.writeUInt16LE(r.n.length, 28); central.writeUInt32LE(r.offset, 42);
    parts.push(central, r.n);
    offset += 46 + r.n.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - cd, 12); end.writeUInt32LE(cd, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

function archive(salt, files, method = 0) {
  const hash = sha(randomBytes(32));
  const doc = { name: 'Pink Imp', 'snapmap-plus': { format: 2, salt, build: hash,
    files: files.map(f => ({ path: 'assets/' + f.request, sha256: sha(f.data), size: f.data.length, provides: { type: 'image', name: f.request }, needs: [] })) } };
  const modjson = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
  return { hash, bytes: zip([{ name: 'mod.json', data: modjson, method }, ...files.map(f => ({ name: 'assets/' + f.request, data: f.data }))]) };
}

async function mods(mf) {
  const send = (method, route, body, headers = {}) => mf.dispatchFetch('http://local.test' + route, { method, body, headers });
  const zipType = bytes => ({ 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) });
  const bucket = await mf.getR2Bucket('MODS');
  const salt = 'k7pinkim';
  const big = archive(salt, [{ request: 'generated/image/mods/' + salt + '/pink.bimage', data: randomBytes(5 * 1024 * 1024 + 17) },
    { request: 'generated/decls/entitydef/mods/' + salt + '/pink_imp.decl', data: Buffer.from('entityDef mods/' + salt + '/pink_imp {}\n') }]);

  const compressed = archive(salt, [], 8);
  const refused = await send('PUT', '/mods/build/' + compressed.hash, compressed.bytes, zipType(compressed.bytes));
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: 'The archive has a compressed entry; Snapmap+ stores every file uncompressed.' });
  assert.equal(await bucket.head('build/' + compressed.hash), null, 'a refused archive was committed');
  const damaged = Buffer.from(big.bytes);
  damaged.writeUInt32LE(0, damaged.length - 6);   // the end record's central directory offset
  const late = await send('PUT', '/mods/build/' + big.hash, damaged, zipType(damaged));
  assert.equal(late.status, 422, 'a fault found only at the end of a streamed upload');
  assert.equal((await late.json()).error, "The archive's end record places its central directory wrongly.");
  assert.equal(await bucket.head('build/' + big.hash), null, 'an archive refused at its last byte was committed');

  const created = await send('PUT', '/mods/build/' + big.hash, big.bytes, zipType(big.bytes));
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(await created.json(), { build: big.hash, size: big.bytes.length });
  const again = await send('PUT', '/mods/build/' + big.hash, big.bytes, zipType(big.bytes));
  assert.equal(again.status, 200);
  await again.arrayBuffer();
  const other = Buffer.from(compressed.bytes);   // another size, refused only at its end record
  other.writeUInt16LE(0, 8); other.writeUInt16LE(0, other.length - 22 - 46 - 8 + 10);
  other.writeUInt32LE(0, other.length - 6);
  const replacement = await send('PUT', '/mods/build/' + big.hash, other, zipType(other));
  assert.equal(replacement.status, 422, await replacement.clone().text());
  await replacement.arrayBuffer();
  assert.equal((await bucket.head('build/' + big.hash)).size, big.bytes.length, 'a refused replacement left the stored archive');
  const got = await send('GET', '/mods/build/' + big.hash);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/zip');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), sha(big.bytes));
  const head = await send('HEAD', '/mods/build/' + big.hash);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(big.bytes.length), 'HEAD carries the archive size');
  await head.arrayBuffer();

  const claim = await send('POST', '/mods/claim', JSON.stringify({ ref: 'runtime-item', builds: [big.hash] }));
  assert.equal(claim.status, 201);
  const { claim: id, secret } = await claim.json();
  const reclaim = await send('POST', '/mods/claim', JSON.stringify({ ref: 'runtime-item', builds: [big.hash], secret }));
  assert.equal(reclaim.status, 200);
  assert.deepEqual(await reclaim.json(), { claim: id, secret });
  const release = await send('POST', '/mods/release', JSON.stringify({ claim: id, secret }));
  assert.equal(release.status, 204);
  await release.arrayBuffer();
  const gone = await send('HEAD', '/mods/build/' + big.hash);
  assert.equal(gone.status, 404, 'a release deletes the build at once');
  await gone.arrayBuffer();
  assert.equal(await bucket.head('build/' + big.hash), null);
  for (const route of ['/mods/blob/' + big.hash, '/mods/bundle/' + big.hash]) {
    const retired = await send('GET', route);
    assert.equal(retired.status, 404);
    await retired.arrayBuffer();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

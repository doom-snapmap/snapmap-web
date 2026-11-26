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

function community(legacy = false) {
  return new Miniflare({
    name: 'community-runtime-test',
    modules: true, modulesRoot: root, scriptPath: path.join(root, legacy ? 'tests/fixtures/bundle_registry.js' : 'api/worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-01',
    durableObjects: legacy ? { MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true } } : {
                      MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true },
                      WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true },
                      UNIT_REGISTRY: { className: 'UnitRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
    durableObjectsPersist: path.join(scratch, 'quotas'),
    kvPersist: path.join(scratch, 'sessions'), r2Persist: path.join(scratch, 'buckets'),
    kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'],
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

async function registry(mf, name) {
  const ns = await mf.getDurableObjectNamespace(name);
  return ns.get(ns.idFromName('registry'));
}

async function run() {
  const hash = 'e'.repeat(64);
  let before;
  let mf = community(true);
  try {
    await seed(mf);
    await (await mf.getR2Bucket('MEDIA')).put('legacy-screen.png', image, { httpMetadata: { contentType: 'image/png' } });
    before = await (await registry(mf, 'MOD_REGISTRY')).seed(hash);
    assert.ok(JSON.parse(before).rows.every(table => table.length === 1));
  } finally { await mf.dispose(); }

  mf = community();
  try {
    assert.deepEqual((await (await mf.getR2Bucket('MODS')).list()).objects, []);
    const index = await registry(mf, 'UNIT_REGISTRY');
    const stats = await index.stats();
    for (const key of ['units', 'blobs', 'packs', 'claims', 'publishers', 'names', 'blocked']) assert.equal(stats[key], 0, key);
    const status = await mf.dispatchFetch('http://local.test/mods/units', { method: 'POST', body: JSON.stringify({ units: [hash] }) });
    assert.deepEqual(await status.json(), { [hash]: 'missing' });
    assert.equal((await mf.dispatchFetch('http://local.test/mods/bundle/' + hash)).status, 410);
    assert.equal((await mf.dispatchFetch('http://local.test/mods/unit/' + hash)).status, 404);
    const mediaResponse = await mf.dispatchFetch('http://local.test/media/legacy-screen.png');
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await mediaResponse.arrayBuffer()), image);
    const account = await mf.dispatchFetch('http://local.test/auth/me', { headers: { Authorization: 'Bearer ' + sidA } });
    assert.deepEqual(await account.json(), { login: 'tester' });
    const old = await registry(mf, 'MOD_REGISTRY');
    await assert.rejects(async () => old.snapshot(), /does not implement|not implemented|no such method|method.*exist/i);
    const replies = await Promise.all(Array.from({ length: 45 }, (_, i) => upload(mf, i % 2 ? sidA : sidB)));
    assert.equal(replies.filter(response => response.status === 200).length, 30);
    assert.equal(replies.filter(response => response.status === 429).length, 15);
    assert.ok(replies.every(response => response.headers.get('Access-Control-Allow-Origin') === 'https://www.snapmapplus.com'));
    for (const response of replies) await response.arrayBuffer();
    const other = await upload(mf, sidC);
    assert.equal(other.status, 200);
    await other.arrayBuffer();
    const media = await mf.getR2Bucket('MEDIA');
    assert.equal((await media.list()).objects.length, 32);
  } finally { await mf.dispose(); }

  mf = community();
  try {
    const retained = await upload(mf, sidA);
    assert.equal(retained.status, 429, 'quota was lost when the object restarted');
    await retained.arrayBuffer();
  } finally { await mf.dispose(); }

  mf = community();
  let unit;
  try { unit = await mods(mf); } finally { await mf.dispose(); }
  mf = community();
  try { await modsAfterRestart(mf, unit); } finally { await mf.dispose(); }

  mf = community(true);
  try {
    assert.equal(await (await registry(mf, 'MOD_REGISTRY')).snapshot(), before);
  } finally { await mf.dispose(); }
  console.log('worker cutover: original bundle tables, claims, sessions and media preserved; fresh unit namespace served and persisted');
  console.log('worker runtime: concurrent per-account quotas, restart persistence and R2 passed');
  console.log('worker runtime: mod store units (begin, an archive, a file in parts, status, manifest, blob and archive ranges, claim, release after a restart) passed');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const { generateKeyPairSync, sign: nodeSign } = require('node:crypto');
const zlib = require('node:zlib');

/* A stored ZIP in the product's form (modzip.c): local headers, central directory, end record. */
function zip(entries) {
  const parts = [], records = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name), local = Buffer.alloc(30), crc = zlib.crc32(data);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    records.push({ n, crc, size: data.length, offset });
    offset += 30 + n.length + data.length;
  }
  const cd = offset;
  for (const r of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(r.crc, 16); central.writeUInt32LE(r.size, 20); central.writeUInt32LE(r.size, 24);
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

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

function makeUnit(files, name) {
  const list = Object.keys(files).sort().map(p => ({ path: p, sha256: sha(files[p]), size: files[p].length }));
  const manifest = Buffer.from(canonical({ files: list, format: 1, game: [], mod: {}, root: { kind: 'entity', name } }));
  return { hash: sha(manifest), manifest, files: list, bytes: files };
}

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, pub: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url') };
}

function send(mf, key, method, route, body, headers = {}) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  const message = 'snapmap-plus/request/1\n' + method + '\n' + route + '\n\n' + sha(bytes);
  const signature = nodeSign('sha256', Buffer.from(message), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return mf.dispatchFetch('http://local.test' + route, { method, body: method === 'GET' ? undefined : bytes,
    headers: { 'X-Publisher-Key': key.pub, 'X-Publisher-Signature': signature, 'CF-Connecting-IP': '203.0.113.9', ...headers } });
}

async function json(response) { return JSON.parse(await response.text()); }

/* The unit routes through the real runtime: the registry and checker Durable Objects (their RPC
 * arguments: a manifest's bytes, a serving plan), R2 ranges and multipart, the deletion delay's
 * rows surviving a restart. */
async function mods(mf) {
  const key = makeKey();
  const big = Buffer.alloc(16 * 1024 * 1024 + 4096, 7);
  const unit = makeUnit({ 'entities/tyrant.decl': Buffer.from('entityDef'), 'images/a.bimage': randomBytes(200000), 'virtual-textures/t_sq1.mega2': big }, 'entities/tyrant');
  let res = await send(mf, key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest);
  assert.equal(res.status, 200, await res.clone().text());
  const begun = await json(res);
  assert.equal(begun.missing.length, 3);
  /* The large file in parts. */
  const bigSha = sha(big);
  res = await send(mf, key, 'POST', '/mods/blob/' + bigSha + '/parts', JSON.stringify({ size: big.length }));
  assert.equal(res.status, 201, await res.clone().text());
  const session = await json(res);
  for (let n = 1; n <= session.parts; n++) {
    const part = big.subarray((n - 1) * session.partSize, n * session.partSize);
    res = await mf.dispatchFetch('http://local.test/mods/blob/' + bigSha + '/parts/' + n, { method: 'PUT', body: part,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length), 'X-Blob-Size': String(big.length) } });
    assert.equal(res.status, 200, await res.clone().text());
    await res.arrayBuffer();
  }
  res = await send(mf, key, 'POST', '/mods/blob/' + bigSha + '/complete', JSON.stringify({ size: big.length }));
  assert.equal(res.status, 201, await res.clone().text());
  await res.arrayBuffer();
  /* The rest in one archive. */
  const entries = [{ name: 'unit.json', data: unit.manifest }];
  for (const f of unit.files) if (f.sha256 !== bigSha) entries.push({ name: f.path, data: unit.bytes[f.path] });
  const archive = zip(entries);
  res = await send(mf, key, 'PUT', '/mods/unit/' + unit.hash + '/archive', archive, { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) });
  assert.equal(res.status, 201, await res.clone().text());
  await res.arrayBuffer();
  res = await mf.dispatchFetch('http://local.test/mods/units', { method: 'POST', body: JSON.stringify({ units: [unit.hash] }) });
  assert.deepEqual(await json(res), { [unit.hash]: 'held' });
  /* Reads. */
  res = await mf.dispatchFetch('http://local.test/mods/unit/' + unit.hash);
  assert.equal(sha(Buffer.from(await res.arrayBuffer())), unit.hash);
  res = await mf.dispatchFetch('http://local.test/mods/blob/' + bigSha, { headers: { Range: 'bytes=16777000-' } });
  assert.equal(res.status, 206);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), big.subarray(16777000));
  res = await mf.dispatchFetch('http://local.test/mods/unit/' + unit.hash + '/archive');
  assert.equal(res.status, 200);
  const whole = Buffer.from(await res.arrayBuffer());
  for (const f of unit.files) {
    const at = whole.indexOf(Buffer.from(f.path));
    assert.ok(at > 0, f.path + ' in the archive');
  }
  res = await mf.dispatchFetch('http://local.test/mods/unit/' + unit.hash + '/archive', { headers: { Range: 'bytes=1000-' } });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), whole.subarray(1000));
  /* Claim, release. */
  res = await send(mf, key, 'POST', '/mods/map/claim', JSON.stringify({ ref: 'item', units: [unit.hash], secret: 'a'.repeat(64), rev: 1 }));
  assert.equal(res.status, 201, await res.clone().text());
  await res.arrayBuffer();
  return unit;
}

async function modsAfterRestart(mf, unit) {
  let res = await mf.dispatchFetch('http://local.test/mods/units', { method: 'POST', body: JSON.stringify({ units: [unit.hash] }) });
  assert.deepEqual(await json(res), { [unit.hash]: 'held' }, 'the index survives a restart');
  const key = makeKey();
  res = await send(mf, key, 'POST', '/mods/map/release', JSON.stringify({ ref: 'item', secret: 'a'.repeat(64), rev: 2 }));
  assert.equal(res.status, 204, await res.clone().text());
  /* Within the deletion delay the unit is still served. */
  res = await mf.dispatchFetch('http://local.test/mods/unit/' + unit.hash);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

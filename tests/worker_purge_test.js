'use strict';
/* The mod store's cleanup under Miniflare (the real Worker, its Durable Objects and R2): a map
 * published, unpublished and purged by the scheduled handler leaves no unit, blob, pack, claim,
 * link row or queued object behind and an empty bucket; a file another unit still names survives,
 * and the pack it shared is compacted to it (the live unit's archive byte-identical, the old object
 * deleted a delay later); a unit claimed again within its deletion delay is kept. The delay is MODS_DELETE_DELAY_MS, set
 * short in the isolated test; without it the purge keeps D40's 24 hours. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomBytes, generateKeyPairSync, sign: nodeSign } = require('node:crypto');
const { Miniflare } = require(process.argv[2] ? path.resolve(process.argv[2]) : 'miniflare');

const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmap-web-purge-'));
const TOKEN = randomBytes(24).toString('hex');   // a throwaway maintainer token for this run only
const DELAY = 1500;

function store(name, vars) {
  return new Miniflare({
    name, modules: true, modulesRoot: root, scriptPath: path.join(root, 'api/worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2026-07-01',
    durableObjects: { WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true }, UNIT_REGISTRY: { className: 'UnitRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
    durableObjectsPersist: path.join(scratch, name, 'do'), r2Persist: path.join(scratch, name, 'r2'),
    kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'],
    bindings: { MODS_ADMIN_TOKEN: TOKEN, ...vars },
    outboundService: () => { throw new Error('unexpected external request'); },
  });
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* A stored ZIP in the product's form (modzip.c). */
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
  const bytes = Object.fromEntries(Object.entries(files).map(([p, v]) => [p, Buffer.from(v)]));
  const list = Object.keys(bytes).sort().map(p => ({ path: p, sha256: sha(bytes[p]), size: bytes[p].length }));
  const manifest = Buffer.from(canonical({ files: list, format: 1, game: [], mod: {}, root: { kind: 'entity', name } }));
  return { hash: sha(manifest), manifest, files: list, bytes };
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

async function expect(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

/* A map's unit published as the product does: begin, one archive of what the store lacks. */
async function publish(mf, key, unit) {
  const begun = await expect(await send(mf, key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest), 200);
  if (begun.held) return begun;
  const entries = [{ name: 'unit.json', data: unit.manifest }];
  for (const f of unit.files) if (begun.missing.includes(f.sha256)) entries.push({ name: f.path, data: unit.bytes[f.path] });
  const archive = zip(entries);
  await expect(await send(mf, key, 'PUT', '/mods/unit/' + unit.hash + '/archive', archive,
    { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) }), 201);
  return begun;
}

const claim = async (mf, key, ref, units, secret, rev) =>
  expect(await send(mf, key, 'POST', '/mods/map/claim', JSON.stringify({ ref, units, secret, rev })), 201);
const release = async (mf, key, ref, secret, rev) =>
  expect(await send(mf, key, 'POST', '/mods/map/release', JSON.stringify({ ref, secret, rev })), 204);

function admin(mf, route, token = TOKEN) {
  return mf.dispatchFetch('http://local.test/mods/admin/' + route, { method: 'POST', body: '{}',
    headers: token ? { Authorization: 'Bearer ' + token } : {} });
}

async function purge(mf) {
  const worker = await mf.getWorker();
  const result = await worker.scheduled({ cron: '23 4 * * *' });
  assert.equal(result.outcome, 'ok');
  return stats(mf);
}
async function stats(mf) { return expect(await admin(mf, 'stats'), 200); }

async function status(mf, hashes) {
  return json(await mf.dispatchFetch('http://local.test/mods/units', { method: 'POST', body: JSON.stringify({ units: hashes }) }));
}

async function objects(mf) {
  return (await (await mf.getR2Bucket('MODS')).list()).objects.map(o => o.key);
}

/* Every row and object the store keeps for content, empty. Publishers and their names stay by design
 * (they go with forget-key, not with an unpublish). */
function assertEmpty(s, where) {
  for (const field of ['units', 'held', 'pending', 'blobs', 'packs', 'packBytes', 'claims', 'claimUnitRows', 'unitBlobRows', 'asked', 'uploads', 'dead',
    'deadLater', 'slackPacks', 'slackBytes']) {
    assert.equal(s[field], 0, where + ': ' + field + ' is ' + s[field]);
  }
}

const SECRET_A = 'a'.repeat(64), SECRET_B = 'b'.repeat(64), SECRET_C = 'c'.repeat(64);

/* Publish, unpublish, purge: nothing is left. */
async function unpublished(mf) {
  const key = makeKey();
  const unit = makeUnit({ 'entities/imp.decl': 'entityDef imp', 'images/imp.bimage': randomBytes(5000) }, 'entities/imp');
  await publish(mf, key, unit);
  await claim(mf, key, 'map-1', [unit.hash], SECRET_A, 1);
  let s = await stats(mf);
  assert.equal(s.units, 1); assert.equal(s.blobs, 2); assert.equal(s.claims, 1); assert.equal(s.claimUnitRows, 1); assert.equal(s.unitBlobRows, 2);
  assert.ok((await objects(mf)).length >= 1);
  await release(mf, key, 'map-1', SECRET_A, 2);
  /* Within the delay the purge keeps it. */
  assert.equal((await purge(mf)).units, 1);
  assert.deepEqual(await status(mf, [unit.hash]), { [unit.hash]: 'held' });
  await sleep(DELAY + 500);
  assertEmpty(await purge(mf), 'after the deletion delay');
  assert.deepEqual(await objects(mf), [], 'the bucket is empty');
  assert.deepEqual(await status(mf, [unit.hash]), { [unit.hash]: 'missing' });
  assert.equal((await mf.dispatchFetch('http://local.test/mods/unit/' + unit.hash)).status, 404);
}

/* A file two units carry survives the purge of one; it goes with the other. */
async function shared(mf) {
  const key = makeKey();
  const common = randomBytes(4000);
  const a = makeUnit({ 'entities/a.decl': 'entityDef a', 'images/shared.bimage': common }, 'entities/a');
  const b = makeUnit({ 'entities/b.decl': 'entityDef b', 'images/shared.bimage': common }, 'entities/b');
  await publish(mf, key, a);                            // the shared file is stored in a's pack
  const begunB = await publish(mf, key, b);
  assert.deepEqual(begunB.missing, [sha(Buffer.from('entityDef b'))], 'b uploads only its own file');
  await claim(mf, key, 'map-a', [a.hash], SECRET_A, 1);
  await claim(mf, key, 'map-b', [b.hash], SECRET_B, 1);
  const archiveOf = async (unit, range) => {
    const r = await mf.dispatchFetch('http://local.test/mods/unit/' + unit.hash + '/archive', range ? { headers: { Range: range } } : {});
    assert.equal(r.status, range ? 206 : 200);
    return Buffer.from(await r.arrayBuffer());
  };
  const before = await archiveOf(b);
  const firstHalf = await archiveOf(b, 'bytes=0-' + (Math.floor(before.length / 2) - 1));   // a ranged download in flight
  const [packA] = (await objects(mf)).filter(k => k.startsWith('pack/' + a.hash + '/'));
  assert.ok(packA, "a's archive is a pack");
  await release(mf, key, 'map-a', SECRET_A, 2);
  await sleep(DELAY + 500);
  const s = await purge(mf);
  assert.equal(s.units, 1); assert.equal(s.blobs, 2); assert.equal(s.packs, 2); assert.equal(s.claims, 1); assert.equal(s.dead, 0);
  assert.equal(s.claimUnitRows, 1); assert.equal(s.unitBlobRows, 2);
  assert.equal(s.slackBytes, 0, 'no byte nothing uses is left in a pack');
  assert.equal(s.slackPacks, 0);
  assert.equal(s.deadLater, 1, "a's old pack is kept for the delay");
  let keys = await objects(mf);
  const compacted = keys.find(k => k.startsWith(packA + '.'));
  assert.ok(compacted, 'the compacted pack keeps the old key and adds a suffix: ' + keys.join(' '));
  assert.ok(keys.includes(packA), 'the old pack stays while a download may still read it');
  /* The compacted pack is exactly the shared file's stored entry: its local header, then its bytes. */
  const name = Buffer.from('images/shared.bimage');
  const entry = zip([{ name: 'images/shared.bimage', data: common }]).subarray(0, 30 + name.length + common.length);
  const stored = Buffer.from(await (await (await mf.getR2Bucket('MODS')).get(compacted)).arrayBuffer());
  assert.deepEqual(stored, entry);
  /* The live unit reads byte for byte as before, whole and as the rest of a ranged download. */
  assert.deepEqual(await archiveOf(b), before);
  assert.deepEqual(Buffer.concat([firstHalf, await archiveOf(b, 'bytes=' + firstHalf.length + '-')]), before);
  assert.deepEqual(await status(mf, [a.hash, b.hash]), { [a.hash]: 'missing', [b.hash]: 'held' });
  let got = await mf.dispatchFetch('http://local.test/mods/blob/' + sha(common));
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), common);
  got = await mf.dispatchFetch('http://local.test/mods/blob/' + sha(Buffer.from('entityDef a')));
  assert.equal(got.status, 404);
  await got.arrayBuffer();
  /* After the delay the old pack object is deleted. */
  await sleep(DELAY + 500);
  const later = await purge(mf);
  assert.equal(later.deadLater, 0); assert.equal(later.dead, 0); assert.equal(later.slackBytes, 0);
  keys = await objects(mf);
  assert.equal(keys.length, 2, 'the compacted pack and b\'s pack: ' + keys.join(' '));
  assert.ok(keys.includes(compacted) && !keys.includes(packA));
  assert.deepEqual(await archiveOf(b), before);
  /* b unpublished too: everything goes. */
  await release(mf, key, 'map-b', SECRET_B, 2);
  await sleep(DELAY + 500);
  assertEmpty(await purge(mf), 'after both purges');
  assert.deepEqual(await objects(mf), []);
}

/* A unit claimed again within its delay is kept past it. */
async function reclaimed(mf) {
  const key = makeKey();
  const unit = makeUnit({ 'entities/c.decl': 'entityDef c' }, 'entities/c');
  await publish(mf, key, unit);
  await claim(mf, key, 'map-c', [unit.hash], SECRET_C, 1);
  await release(mf, key, 'map-c', SECRET_C, 2);
  await claim(mf, key, 'map-c', [unit.hash], SECRET_C, 1);   // republished within the delay
  await sleep(DELAY + 500);
  const res = await purge(mf);
  assert.equal(res.units, 1);
  assert.equal(res.claimed, 1);
  assert.deepEqual(await status(mf, [unit.hash]), { [unit.hash]: 'held' });
  await release(mf, key, 'map-c', SECRET_C, 2);
  await sleep(DELAY + 500);
  assertEmpty(await purge(mf), 'after the last release');
  assert.deepEqual(await objects(mf), []);
}

/* With production's delay, the same elapsed interval keeps an unclaimed unit. */
async function production(mf) {
  const key = makeKey();
  const unit = makeUnit({ 'entities/d.decl': 'entityDef d' }, 'entities/d');
  await publish(mf, key, unit);
  await claim(mf, key, 'map-d', [unit.hash], SECRET_A, 1);
  await release(mf, key, 'map-d', SECRET_A, 2);
  await sleep(DELAY + 500);
  const res = await purge(mf);
  assert.equal(res.units, 1);
  assert.equal(res.unclaimed, 1);
  assert.deepEqual(await status(mf, [unit.hash]), { [unit.hash]: 'held' });
}

async function run() {
  let mf = store('short-delay', { MODS_DELETE_DELAY_MS: String(DELAY) });
  try {
    await unpublished(mf);
    await shared(mf);
    await reclaimed(mf);
  } finally { await mf.dispose(); }
  mf = store('production', {});
  try { await production(mf); } finally { await mf.dispose(); }
  console.log('worker purge: publish, unpublish and purge leave an empty store; a shared file survives; a unit claimed again is kept; ' +
    'production keeps 24 hours passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

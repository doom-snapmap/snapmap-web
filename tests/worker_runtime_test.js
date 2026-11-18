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
                      MOD_REGISTRY: { className: 'ModRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
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

  /* A build of any size in parts, through the real runtime: node tests/worker_runtime_test.js
   * <miniflare> <GiB>. Off by default: it writes the archive twice to the local R2 store. */
  const gib = Number(process.argv[3] || 0);
  if (gib > 0) {
    mf = community();
    try { await largeBuild(mf, gib); } finally { await mf.dispose(); }
  }

  console.log('worker runtime: concurrent per-account quotas, restart persistence and R2 passed');
  console.log('worker runtime: mod store archive streaming, refusal, uploads in parts, the release race, claims and release passed');
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

function archive(salt, files, method = 0, block = {}) {
  const hash = sha(randomBytes(32));
  const doc = { name: 'Pink Imp', 'snapmap-plus': { format: 2, salt, build: hash, ...block,
    files: files.map(f => ({ path: 'assets/' + f.request, sha256: sha(f.data), size: f.data.length, provides: { type: 'image', name: f.request }, needs: [] })) } };
  const modjson = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
  return { hash, files, bytes: zip([{ name: 'mod.json', data: modjson, method }, ...files.map(f => ({ name: 'assets/' + f.request, data: f.data }))]) };
}

async function mods(mf) {
  const send = (method, route, body, headers = {}) => mf.dispatchFetch('http://local.test' + route, { method, body, headers });
  const zipType = bytes => ({ 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) });
  const bucket = await mf.getR2Bucket('MODS');
  /* A build's own objects: its archive while staged, its skeleton always. */
  const stored = async hash => [...(await bucket.list({ prefix: 'build/' + hash })).objects, ...(await bucket.list({ prefix: 'skel/' + hash })).objects].map(o => o.key);
  /* The packer runs on the registry's alarm: wait until the archive is gone (its files are in packs). */
  const packed = async hash => {
    for (let i = 0; i < 200; i++) {
      if (!(await bucket.list({ prefix: 'build/' + hash })).objects.length) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('build ' + hash.slice(0, 12) + ' was not packed');
  };
  const salt = 'k7pinkim';
  const big = archive(salt, [{ request: 'generated/image/mods/' + salt + '/pink.bimage', data: randomBytes(5 * 1024 * 1024 + 17) },
    { request: 'generated/decls/entitydef/mods/' + salt + '/pink_imp.decl', data: Buffer.from('entityDef mods/' + salt + '/pink_imp {}\n') }]);

  const compressed = archive(salt, [], 8);
  const refused = await send('PUT', '/mods/build/' + compressed.hash, compressed.bytes, zipType(compressed.bytes));
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: 'The archive has a compressed entry; Snapmap+ stores every file uncompressed.' });
  assert.deepEqual(await stored(compressed.hash), [], 'a refused archive was kept');
  assert.deepEqual((await bucket.list()).objects.map(o => o.key), [], 'nothing at all was kept');
  const damaged = Buffer.from(big.bytes);
  damaged.writeUInt32LE(0, damaged.length - 6);   // the end record's central directory offset
  const late = await send('PUT', '/mods/build/' + big.hash, damaged, zipType(damaged));
  assert.equal(late.status, 422, 'a fault found only at the end of a streamed upload');
  assert.equal((await late.json()).error, "The archive's end record places its central directory wrongly.");
  assert.deepEqual(await stored(big.hash), [], 'an archive refused at its last byte was kept');

  const created = await send('PUT', '/mods/build/' + big.hash, big.bytes, zipType(big.bytes));
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(await created.json(), { build: big.hash, size: big.bytes.length, scripts: 0 });
  assert.equal((await stored(big.hash)).length, 2, 'its archive and skeleton');
  const staged = await send('GET', '/mods/build/' + big.hash, undefined, { Range: 'bytes=100-199' });
  assert.equal(staged.status, 206);
  assert.deepEqual(Buffer.from(await staged.arrayBuffer()), big.bytes.subarray(100, 200));
  const again = await send('PUT', '/mods/build/' + big.hash, big.bytes, zipType(big.bytes));
  assert.equal(again.status, 200);
  await again.arrayBuffer();
  await packed(big.hash);
  assert.equal((await stored(big.hash)).length, 1, 'packed: its skeleton; the archive is gone');
  assert.ok((await bucket.list({ prefix: 'pack/' })).objects.length >= 1, 'its files are in a pack');
  const other = Buffer.from(compressed.bytes);   // another size, refused only at its end record
  other.writeUInt16LE(0, 8); other.writeUInt16LE(0, other.length - 22 - 46 - 8 + 10);
  other.writeUInt32LE(0, other.length - 6);
  const replacement = await send('PUT', '/mods/build/' + big.hash, other, zipType(other));
  assert.equal(replacement.status, 422, await replacement.clone().text());
  await replacement.arrayBuffer();
  const kept = await stored(big.hash);
  assert.equal(kept.length, 1, 'a refused replacement left only the stored build');
  const got = await send('GET', '/mods/build/' + big.hash);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/zip');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), sha(big.bytes), 'a packed build is served byte for byte');
  const tail = await send('GET', '/mods/build/' + big.hash, undefined, { Range: 'bytes=' + (big.bytes.length - 1000) + '-' });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), big.bytes.subarray(big.bytes.length - 1000), 'a range of a packed build');
  /* A revision that shares the large image stores only what is new. */
  const before = (await bucket.list({ prefix: 'pack/' })).objects.reduce((n, o) => n + o.size, 0);
  const revision = archive(salt, [big.files[0], { request: 'generated/decls/entitydef/mods/' + salt + '/pink_imp.decl', data: Buffer.from('entityDef mods/' + salt + '/pink_imp { v = 2; }\n') }]);
  assert.equal((await send('PUT', '/mods/build/' + revision.hash, revision.bytes, zipType(revision.bytes))).status, 201);
  await packed(revision.hash);
  const added = (await bucket.list({ prefix: 'pack/' })).objects.reduce((n, o) => n + o.size, 0) - before;
  assert.ok(added < 4096, 'the revision added ' + added + ' bytes of packs, not another copy of the image');
  const rev = await send('GET', '/mods/build/' + revision.hash);
  assert.equal(sha(Buffer.from(await rev.arrayBuffer())), sha(revision.bytes));
  const head = await send('HEAD', '/mods/build/' + big.hash);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(big.bytes.length), 'HEAD carries the archive size');
  assert.equal(head.headers.get('x-mod-scripts'), '0');
  await head.arrayBuffer();

  /* A scripted build: the index records how many scripts it carries and every answer says so. */
  const scripted = archive(salt, [{ request: 'mods/' + salt + '/scripts/main.lua', data: Buffer.from('api = 1\n') },
    { request: 'mods/' + salt + '/scripts/lib/fsm.lua', data: Buffer.from('return {}\n') }], 0, { scripts: { files: 2 } });
  const withScripts = await send('PUT', '/mods/build/' + scripted.hash, scripted.bytes, zipType(scripted.bytes));
  assert.deepEqual(await withScripts.json(), { build: scripted.hash, size: scripted.bytes.length, scripts: 2 });
  const scriptHead = await send('HEAD', '/mods/build/' + scripted.hash);
  assert.equal(scriptHead.headers.get('x-mod-scripts'), '2');
  await scriptHead.arrayBuffer();

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
  assert.deepEqual(await stored(big.hash), []);

  /* The release race (a release and an upload of one build at once): whichever order the
   * two land in, a claim never names a build whose archive is missing. */
  for (let round = 0; round < 8; round++) {
    const raced = archive(salt, [{ request: 'generated/image/mods/' + salt + '/r.bimage', data: randomBytes(64 * 1024) }]);
    await (await send('PUT', '/mods/build/' + raced.hash, raced.bytes, zipType(raced.bytes))).arrayBuffer();
    const made = await (await send('POST', '/mods/claim', JSON.stringify({ ref: 'race-' + round, builds: [raced.hash] }))).json();
    const [rel, up] = await Promise.all([
      send('POST', '/mods/release', JSON.stringify(made)),
      send('PUT', '/mods/build/' + raced.hash, raced.bytes, zipType(raced.bytes)),
    ]);
    await rel.arrayBuffer(); await up.arrayBuffer();
    const reclaim = await send('POST', '/mods/claim', JSON.stringify({ ref: 'race-again-' + round, builds: [raced.hash] }));
    if (reclaim.status === 201) {
      const served = await send('GET', '/mods/build/' + raced.hash);
      assert.equal(served.status, 200, 'a claimed build is served (round ' + round + ')');
      assert.equal(sha(Buffer.from(await served.arrayBuffer())), sha(raced.bytes));
    } else {
      assert.equal(reclaim.status, 409, 'the build is gone and the claim says to upload it again');
    }
    await reclaim.arrayBuffer();
  }

  await parts(send, bucket, stored, packed);
  for (const route of ['/mods/blob/' + big.hash, '/mods/bundle/' + big.hash]) {
    const retired = await send('GET', route);
    assert.equal(retired.status, 404);
    await retired.arrayBuffer();
  }
}

/* An archive streamed from a generator in parts of the store's part size: `files` carried
 * files of `size` bytes each, contents made a block at a time. */
function* generated(hash, salt, files, size) {
  const names = Array.from({ length: files }, (_, i) => 'assets/generated/image/mods/' + salt + '/big' + i + '.bimage');
  /* The same bytes for the same hash, so a resumed upload sends what the first attempt did. */
  const block = Buffer.alloc(4 * 1024 * 1024);
  for (let at = 0, seed = Buffer.from(hash, 'hex'); at < block.length; at += 32) {
    seed = createHash('sha256').update(seed).digest();
    seed.copy(block, at);
  }
  const sums = names.map(() => {
    const h = createHash('sha256');
    for (let left = size; left > 0; left -= block.length) h.update(block.subarray(0, Math.min(left, block.length)));
    return h.digest('hex');
  });
  const crc = (() => {
    let c = 0xffffffff;
    for (let left = size; left > 0; left -= block.length) {
      for (const b of block.subarray(0, Math.min(left, block.length))) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    }
    return (c ^ 0xffffffff) >>> 0;
  })();
  const doc = { name: 'Large', 'snapmap-plus': { format: 2, salt, build: hash,
    files: names.map((n, i) => ({ path: n, sha256: sums[i], size, provides: { type: 'image', name: n.slice(7) }, needs: [] })) } };
  const modjson = Buffer.from(JSON.stringify(doc));
  const entries = [{ name: 'mod.json', size: modjson.length, data: modjson, crc: crc32(modjson) }, ...names.map(name => ({ name, size, crc }))];
  let offset = 0;
  const records = [];
  for (const e of entries) {
    const n = Buffer.from(e.name), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.size, 18); local.writeUInt32LE(e.size, 22); local.writeUInt16LE(n.length, 26);
    records.push({ n, size: e.size, offset, crc: e.crc });
    yield Buffer.concat([local, n]);
    offset += 30 + n.length;
    if (e.data) { yield e.data; offset += e.size; continue; }
    for (let left = e.size; left > 0; left -= block.length) yield block.subarray(0, Math.min(left, block.length));
    offset += e.size;
  }
  const cd = offset;
  for (const r of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(r.crc, 16); central.writeUInt32LE(r.size, 20); central.writeUInt32LE(r.size, 24); central.writeUInt16LE(r.n.length, 28);
    central.writeUInt32LE(r.offset, 42);
    yield Buffer.concat([central, r.n]);
    offset += 46 + r.n.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - cd, 12); end.writeUInt32LE(cd, 16);
  yield end;
}

/* Sends a generated archive in parts and returns its size and SHA-256. */
async function sendInParts(send, hash, chunks, size, partSize, skip = new Set()) {
  let part = 1, pending = [], have = 0;
  const whole = createHash('sha256');
  const flush = async () => {
    const body = Buffer.concat(pending);
    pending = []; have = 0;
    if (!skip.has(part)) {
      const r = await send('PUT', '/mods/build/' + hash + '/parts/' + part, body,
        { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'X-Build-Size': String(size) });
      assert.equal(r.status, 200, 'part ' + part + ': ' + await r.clone().text());
      await r.arrayBuffer();
    }
    part++;
  };
  for (const chunk of chunks) {
    whole.update(chunk);
    let at = 0;
    while (at < chunk.length) {
      const n = Math.min(partSize - have, chunk.length - at);
      pending.push(Buffer.from(chunk.subarray(at, at + n)));
      have += n; at += n;
      if (have === partSize) await flush();
    }
  }
  if (have) await flush();
  return whole.digest('hex');
}

function sizeOf(chunks) {
  let n = 0;
  for (const chunk of chunks) n += chunk.length;
  return n;
}

/* Two parts through the runtime: start, one part, resume, the other, complete, read back. */
async function parts(send, bucket, stored, packed) {
  const salt = 'k7pinkim', hash = sha(randomBytes(32));
  const size = sizeOf(generated(hash, salt, 2, 50 * 1024 * 1024));
  const start = await send('POST', '/mods/build/' + hash + '/parts', JSON.stringify({ size }));
  assert.equal(start.status, 201, await start.clone().text());
  const { partSize, parts: count } = await start.json();
  assert.equal(count, Math.ceil(size / partSize));
  assert.ok(count > 1);
  /* The same generator, so the bytes are the same: send only part 1, then resume. */
  const gen = () => generated(hash, salt, 2, 50 * 1024 * 1024);
  await sendInParts(send, hash, gen(), size, partSize, new Set(Array.from({ length: count - 1 }, (_, i) => i + 2)));
  const resumed = await send('POST', '/mods/build/' + hash + '/parts', JSON.stringify({ size }));
  assert.deepEqual((await resumed.json()).have, [1]);
  const digest = await sendInParts(send, hash, gen(), size, partSize, new Set([1]));
  const done = await send('POST', '/mods/build/' + hash + '/complete', JSON.stringify({ size }));
  assert.equal(done.status, 201, await done.clone().text());
  await done.arrayBuffer();
  const got = await send('GET', '/mods/build/' + hash);
  assert.equal(got.status, 200);
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), digest, 'the joined archive is the bytes sent');
  await packed(hash);
  assert.equal((await stored(hash)).length, 1);
  const again = await send('GET', '/mods/build/' + hash);
  assert.equal(sha(Buffer.from(await again.arrayBuffer())), digest, 'and the packed build is the same bytes');
}

/* A build of `gib` GiB in parts: generated, uploaded, joined, checked and read back. */
async function largeBuild(mf, gib) {
  const send = (method, route, body, headers = {}) => mf.dispatchFetch('http://local.test' + route, { method, body, headers });
  const salt = 'k7pinkim', hash = sha(randomBytes(32));
  const fileSize = 95 * 1024 * 1024;
  const files = Math.ceil(gib * 1024 / 95);
  const size = sizeOf(generated(hash, salt, files, fileSize));
  const t0 = Date.now();
  const start = await send('POST', '/mods/build/' + hash + '/parts', JSON.stringify({ size }));
  assert.equal(start.status, 201, await start.clone().text());
  const { partSize, parts: count } = await start.json();
  const digest = await sendInParts(send, hash, generated(hash, salt, files, fileSize), size, partSize);
  const t1 = Date.now();
  const done = await send('POST', '/mods/build/' + hash + '/complete', JSON.stringify({ size }));
  assert.equal(done.status, 201, await done.clone().text());
  await done.arrayBuffer();
  const t2 = Date.now();
  const got = await send('GET', '/mods/build/' + hash);
  assert.equal(got.status, 200);
  const h = createHash('sha256');
  let received = 0;
  for await (const chunk of got.body) { h.update(chunk); received += chunk.length; }
  assert.equal(received, size);
  assert.equal(h.digest('hex'), digest, 'byte for byte');
  console.log('worker runtime: a ' + (size / 1024 ** 3).toFixed(2) + ' GiB build in ' + count + ' parts: sent in ' +
    ((t1 - t0) / 1000).toFixed(1) + ' s, joined and checked in ' + ((t2 - t1) / 1000).toFixed(1) + ' s, read back in ' +
    ((Date.now() - t2) / 1000).toFixed(1) + ' s');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

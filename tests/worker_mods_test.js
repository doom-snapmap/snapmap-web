'use strict';
/* The mod store's unit routes (SPEC-distribution section 10) against in-memory R2, SQLite-backed
 * Durable Object doubles and the Worker itself: begin, archive upload, parts, status, the manifest,
 * blob and archive reads with ranges, claims with signatures and revs, release, the deletion delay
 * and purge, remixes, moderation, forget-key, the first-come name, asked paths, per-key limits and
 * the retired routes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, generateKeyPairSync, sign: nodeSign } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const read = name => fs.readFileSync(path.join(root, 'api', name), 'utf8');
const bodyURL = dataURL(read('request_body.js'));
const packURL = dataURL(read('mods_pack.js'));
const publisherURL = dataURL(read('mods_publisher.js'));
const modsURL = dataURL(read('mods_store.js').replace('./request_body.js', bodyURL).replace('./mods_pack.js', packURL)
  .replace('./mods_publisher.js', publisherURL));
const workerURL = dataURL(read('worker.js').replace('./request_body.js', bodyURL).replace('./mods_store.js', modsURL)
  .replace("export { CommunityQuota } from './quota.js';", '').replace("export { ModRegistry, ModChecker } from './mods_registry.js';", ''));
const modsModule = import(modsURL);
const workerModule = import(workerURL);
const quotaModule = import(dataURL(read('quota_store.js')));
const registryModule = import(dataURL(read('mods_registry_store.js')));
const packModule = import(packURL);

const DAY = 86400000;
const HOUR = 3600000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const MIB = 1024 * 1024;

/* ---------------- workerd stream primitives absent from Node ---------------- */

if (!globalThis.FixedLengthStream) {
  globalThis.FixedLengthStream = class FixedLengthStream extends TransformStream {
    constructor(length) {
      let seen = 0;
      super({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > length) throw new Error('stream longer than declared');
          controller.enqueue(chunk);
        },
        flush() { if (seen !== length) throw new Error('stream shorter than declared'); },
      });
      this.readable.declaredLength = length;
    }
  };
}

/* workerd's streaming SHA-256 (crypto.DigestStream), over node:crypto. */
if (!globalThis.crypto.DigestStream) {
  globalThis.crypto.DigestStream = class DigestStream extends WritableStream {
    constructor(algorithm) {
      assert.equal(algorithm, 'SHA-256');
      const h = createHash('sha256');
      let resolve;
      const digest = new Promise(r => { resolve = r; });
      super({ write(chunk) { h.update(chunk); }, close() { const d = h.digest(); resolve(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); } });
      this.digest = digest;
    }
  };
}

/* ---------------- storage doubles ---------------- */

function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    sql: { exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

/* Like R2, a stream of declared length is committed once that many bytes have arrived,
 * even if the stream fails afterwards (miniflare shows the same). */
function memoryBucket() {
  async function readPut(key, stream) {
    const chunks = [];
    let got = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
      }
    } catch (error) {
      if (stream.declaredLength !== undefined && got === stream.declaredLength) {
        objects.set(key, { bytes: new Uint8Array(Buffer.concat(chunks)), uploaded: new Date() });
      }
      throw error;
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  const objects = new Map();
  const uploads = new Map();
  const log = [];
  let etagCounter = 0;
  /* R2 multipart: parts of one size but the last, joined by complete() in part order. */
  function multipart(key, uploadId) {
    return {
      key, uploadId,
      async uploadPart(partNumber, value) {
        log.push(['part', key, partNumber]);
        const upload = uploads.get(uploadId);
        if (!upload) throw new Error('uploadPart: no such upload');
        const chunks = [];
        const reader = value.getReader();
        for (;;) { const { value: chunk, done } = await reader.read(); if (done) break; chunks.push(chunk); }
        const etag = 'e' + (++etagCounter);
        upload.parts.set(partNumber, { bytes: new Uint8Array(Buffer.concat(chunks)), etag });
        return { partNumber, etag };
      },
      async abort() { log.push(['abort', key]); if (!uploads.delete(uploadId)) throw new Error('abort: no such upload'); },
      async complete(parts) {
        log.push(['complete', key]);
        const upload = uploads.get(uploadId);
        if (!upload) throw new Error('complete: no such upload');
        const joined = [];
        for (const { partNumber, etag } of parts) {
          const part = upload.parts.get(partNumber);
          if (!part || part.etag !== etag) throw new Error('complete: a part does not match its etag');
          joined.push(part.bytes);
        }
        uploads.delete(uploadId);
        objects.set(key, { bytes: new Uint8Array(Buffer.concat(joined)), uploaded: new Date(), httpMetadata: upload.httpMetadata });
        return meta(key, objects.get(key));
      },
    };
  }
  const meta = (key, o) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded, httpEtag: '"x"', httpMetadata: o.httpMetadata });
  return {
    objects, log, uploads,
    async createMultipartUpload(key, options = {}) {
      log.push(['create', key]);
      const uploadId = 'u' + (++etagCounter);
      uploads.set(uploadId, { key, parts: new Map(), httpMetadata: options.httpMetadata });
      return multipart(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) { return multipart(key, uploadId); },
    async head(key) { log.push(['head', key]); const o = objects.get(key); return o ? meta(key, o) : null; },
    async get(key, options = {}) {
      log.push(['get', key]);
      const o = objects.get(key);
      if (!o) return null;
      let cancelled = false;
      const r = options.range;
      const bytes = r ? o.bytes.subarray(r.offset, r.offset + (r.length ?? o.bytes.byteLength - r.offset)) : o.bytes;
      /* Several chunks, as R2 streams them, so readers that join or cut chunks are exercised. */
      const body = new ReadableStream({ start(c) {
        for (let at = 0; at < bytes.byteLength; at += 65536) c.enqueue(bytes.slice(at, at + 65536));
        c.close();
      }, cancel() { cancelled = true; } });
      return { ...meta(key, o), body, arrayBuffer: async () => bytes.slice().buffer, get cancelled() { return cancelled; } };
    },
    async put(key, value, options = {}) {
      log.push(['put', key]);
      const bytes = value instanceof Uint8Array ? value : await readPut(key, value);
      if (options.sha256 && sha(bytes) !== options.sha256) throw new Error('put: The SHA-256 checksum you specified did not match');
      objects.set(key, { bytes, uploaded: new Date(), httpMetadata: options.httpMetadata });
      return meta(key, objects.get(key));
    },
    async delete(keys) {
      for (const key of [].concat(keys)) { log.push(['delete', key]); objects.delete(key); }
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      log.push(['list', prefix]);
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map(key => ({ key, uploaded: objects.get(key).uploaded })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
}

async function modsEnv(extra = {}) {
  const { initializeQuota, consumeModQuota } = await quotaModule;
  const r = await registryModule;
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const quotaObjects = new Map();
  const names = [];
  const s = sqliteStorage();
  r.initializeRegistry(s);
  const now = () => clock.now();
  /* The methods of mods_registry.js ModRegistry, on the same functions, with the test's clock. */
  const methods = {
    unitStatus: h => r.unitStatus(s, h), unitRow: h => r.unitRow(s, h), unitServed: (h, b) => r.unitServed(s, h, b),
    beginUnit: u => r.beginUnit(s, u, now()), unitBlobs: h => r.unitBlobs(s, h),
    commitUnitArchive: (h, o, n, b) => r.commitUnitArchive(s, h, o, n, b, now()), completeUnit: h => r.completeUnit(s, h, now()),
    blobWanted: (sha, n) => r.blobWanted(s, sha, n), commitBlob: (sha, n, c, o) => r.commitBlob(s, sha, n, c, o, now()),
    blobLocation: sha => r.blobLocation(s, sha), markBroken: o => r.markBroken(s, o, now()), purgeUnits: l => r.purgeUnits(s, now(), l),
    claim: q => r.claimUnits(s, q, now()), release: q => r.releaseClaim(s, q, now()), claimRev: (a, b) => r.claimRev(s, a, b),
    releaseRef: ref => r.releaseRef(s, ref, now()), reportAsked: (h, p) => r.reportAsked(s, h, p, now()), listAsked: c => r.listAsked(s, c),
    publisherSeen: (k, n, f) => r.publisherSeen(s, k, n, f, now()), publisher: k => r.publisherRow(s, k), forgetKey: k => r.forgetKey(s, k),
    block: (h, why) => r.blockUnit(s, h, why, now()), unblock: h => r.unblockUnit(s, h),
    uploadSession: (sha, n) => r.uploadSession(s, sha, n), openUpload: q => r.openUpload(s, q, now()),
    recordPart: (sha, n, u, p, e) => r.recordPart(s, sha, n, u, p, e, now()), closeUpload: (sha, n, u) => r.closeUpload(s, sha, n, u),
    abandonUploads: (l, all) => r.abandonUploads(s, now(), l, all), deadObjects: l => r.deadObjects(s, l), forgetDead: o => r.forgetDead(s, o),
    unnamedObjects: k => r.unnamedObjects(s, k), stats: () => r.storeStats(s), reset: () => r.resetRegistry(s),
    meta: (key, value) => {
      if (value !== undefined) { s.sql.exec('INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)); return true; }
      return s.sql.exec('SELECT value FROM store_meta WHERE key = ?', key).toArray()[0]?.value ?? null;
    },
  };
  const stub = Object.fromEntries(Object.entries(methods).map(([k, f]) => [k, async (...a) => structuredClone(f(...a))]));
  return {
    clock, names, storage: s,
    MODS: memoryBucket(),
    MODS_ADMIN_TOKEN: 'admin-token',
    WRITE_QUOTAS: {
      idFromName(name) { names.push(name); return name; },
      get(name) {
        if (!quotaObjects.has(name)) { const q = sqliteStorage(); initializeQuota(q); quotaObjects.set(name, q); }
        const q = quotaObjects.get(name);
        return { consumeMods: async entries => consumeModQuota(q, entries, clock.now()) };
      },
    },
    MOD_REGISTRY: { idFromName(name) { assert.equal(name, 'registry'); return name; }, get() { return stub; } },
    ...extra,
  };
}

/* ---------------- requests ---------------- */

const ADDRESS = '203.0.113.7';

function call(method, route, { body, headers = {} } = {}) {
  return new Request('https://service.test' + route, { method, body, duplex: 'half', headers: { 'CF-Connecting-IP': ADDRESS, ...headers } });
}

async function fetchWorker(env, request) {
  return (await workerModule).default.fetch(request, env);
}

/* A publishing key as the product makes one (SPEC 4.2): P-256, the raw point base64url. */
function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { privateKey, pub: point.toString('base64url') };
}

/* The three headers of a signed request (SPEC 4.3). */
function signed(key, method, route, body, name = '') {
  const header = name ? encodeURIComponent(name) : '';
  const message = 'snapmap-plus/request/1\n' + method + '\n' + route + '\n' + header + '\n' + sha(body || Buffer.alloc(0));
  const signature = nodeSign('sha256', Buffer.from(message), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  const h = { 'X-Publisher-Key': key.pub, 'X-Publisher-Signature': signature.toString('base64url') };
  if (header) h['X-Publisher-Name'] = header;
  return h;
}

function signedCall(key, method, route, body, { headers = {}, name = '' } = {}) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  return call(method, route, { body: method === 'GET' ? undefined : bytes, headers: { ...signed(key, method, route, bytes, name), ...headers } });
}

function signedJson(key, route, value, opts = {}) {
  return signedCall(key, 'POST', route, JSON.stringify(value), { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}

/* ---------------- units, written as the product's modunit.c and modzip.c write them ---------------- */

/* The canonical manifest (SPEC 3.4): keys sorted, no whitespace. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

let counter = 0;
/* A unit of `files` ({ path: bytes }); returns { hash, manifest, blobs: Map(sha -> bytes), files }. */
function makeUnit(files, { kind = 'entity', name = 'entities/thing' + (++counter), game = [], mod = {}, spelled } = {}) {
  const list = Object.keys(files).sort().map(p => ({ path: p, sha256: sha(files[p]), size: Buffer.from(files[p]).length }));
  const doc = { files: list, format: 1, game, mod, root: { kind, name } };
  if (spelled) doc.spelled = spelled;
  const manifest = Buffer.from(canonical(doc));
  const blobs = new Map(Object.values(files).map(b => [sha(b), Buffer.from(b)]));
  return { hash: sha(manifest), manifest, blobs, files: list, doc };
}

/* entries: [{ name, data, crc? }] as modzip.c writes them: stored, sizes in the local header. */
function zip(entries) {
  const parts = [];
  let offset = 0;
  const records = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = entry.crc ?? zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    records.push({ name, crc, size: data.length, offset });
    parts.push(local, name, data);
    offset += 30 + name.length + data.length;
  }
  const cd = offset;
  for (const r of records) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(r.crc, 16); c.writeUInt32LE(r.size, 20); c.writeUInt32LE(r.size, 24);
    c.writeUInt16LE(r.name.length, 28); c.writeUInt32LE(r.offset, 42);
    parts.push(c, r.name);
    offset += 46 + r.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - cd, 12); end.writeUInt32LE(cd, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/* The archive of a unit's files the store lacks (`missing`, SHA-256s), unit.json first. */
function unitZip(unit, missing, edit = e => e) {
  const want = new Set(missing);
  const entries = [{ name: 'unit.json', data: unit.manifest }];
  for (const f of unit.files) if (want.has(f.sha256)) { entries.push({ name: f.path, data: unit.blobs.get(f.sha256) }); want.delete(f.sha256); }
  return zip(entries.map(edit));
}

/* Reads a stored ZIP (the store's archive answer): [{ name, data }], checking every CRC. */
function unzip(bytes) {
  const b = Buffer.from(bytes);
  const endAt = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(endAt + 10);
  let at = b.readUInt32LE(endAt + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50);
    const crc = b.readUInt32LE(at + 16), size = b.readUInt32LE(at + 24), nl = b.readUInt16LE(at + 28), xl = b.readUInt16LE(at + 30);
    const off = b.readUInt32LE(at + 42), name = b.subarray(at + 46, at + 46 + nl).toString('utf8');
    const lnl = b.readUInt16LE(off + 26), lxl = b.readUInt16LE(off + 28);
    const data = b.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size);
    assert.equal(zlib.crc32(data), crc, 'CRC of ' + name);
    out.push({ name, data });
    at += 46 + nl + xl;
  }
  return out;
}

/* begin, then the archive of what is missing: the publish of one unit. Returns the begin answer. */
async function publishUnit(env, key, unit) {
  const begin = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest));
  assert.equal(begin.status, 200, await begin.clone().text());
  const first = await begin.json();
  if (first.held) return first;
  const archive = unitZip(unit, first.missing);
  const put = await fetchWorker(env, signedCall(key, 'PUT', '/mods/unit/' + unit.hash + '/archive', archive,
    { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) } }));
  assert.equal(put.status, 201, await put.clone().text());
  return first;
}

async function status(env, hashes) {
  const res = await fetchWorker(env, call('POST', '/mods/units', { body: JSON.stringify({ units: hashes }) }));
  assert.equal(res.status, 200);
  return res.json();
}

async function claim(env, key, ref, units, secret, rev) {
  return fetchWorker(env, signedJson(key, '/mods/map/claim', { ref, units, secret, rev }));
}

const SECRET_A = 'a'.repeat(64), SECRET_B = 'b'.repeat(64);

function assertSentence(text, what) {
  assert.ok(typeof text === 'string' && /^[\x20-\x7e]+$/.test(text) && /[.?]$/.test(text), what + ': ' + text);
}

function admin(env, route, value) {
  return fetchWorker(env, call('POST', '/mods/admin/' + route, { body: JSON.stringify(value || {}), headers: { Authorization: 'Bearer admin-token' } }));
}

/* ---------------- tests ---------------- */

test('crc32 is the IEEE CRC-32 of any bytes, in any number of pieces', async () => {
  const { crc32 } = await packModule;
  for (const n of [0, 1, 7, 8, 9, 63, 4096, 100003]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
    assert.equal(crc32(bytes), zlib.crc32(bytes));
    assert.equal(crc32(bytes.subarray(Math.floor(n / 3)), crc32(bytes.subarray(0, Math.floor(n / 3)))), zlib.crc32(bytes));
  }
});

test('a unit is begun, its missing files sent in one archive, and served: status, manifest, blob with ranges, archive', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const unit = makeUnit({ 'entities/tyrant.decl': 'entityDef {}', 'images/skin.bimage': Buffer.alloc(70000, 3), 'virtual-textures/t_sq1.mega2': 'sq1' });
  assert.deepEqual(await status(env, [unit.hash]), { [unit.hash]: 'missing' });
  const begin = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest));
  const first = await begin.json();
  assert.deepEqual(first.missing.sort(), [...unit.blobs.keys()].sort());
  assert.equal(first.partSize, 16 * 1024 * 1024);
  assert.deepEqual(await status(env, [unit.hash]), { [unit.hash]: 'missing' });
  const archive = unitZip(unit, first.missing);
  const put = await fetchWorker(env, signedCall(key, 'PUT', '/mods/unit/' + unit.hash + '/archive', archive,
    { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) } }));
  assert.equal(put.status, 201);
  assert.deepEqual(await put.json(), { held: true });
  assert.deepEqual(await status(env, [unit.hash]), { [unit.hash]: 'held' });

  const manifest = await fetchWorker(env, call('GET', '/mods/unit/' + unit.hash));
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('Content-Type'), 'application/json');
  assert.ok(manifest.headers.get('Cache-Control').includes('immutable'));
  assert.equal(sha(Buffer.from(await manifest.arrayBuffer())), unit.hash);

  const skin = sha(Buffer.alloc(70000, 3));
  const blob = await fetchWorker(env, call('GET', '/mods/blob/' + skin));
  assert.equal(blob.status, 200);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.alloc(70000, 3));
  const tail = await fetchWorker(env, call('GET', '/mods/blob/' + skin, { headers: { Range: 'bytes=69990-' } }));
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('Content-Range'), 'bytes 69990-69999/70000');
  assert.equal((await tail.arrayBuffer()).byteLength, 10);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + skin, { headers: { Range: 'bytes=70000-' } }))).status, 416);

  const zipRes = await fetchWorker(env, call('GET', '/mods/unit/' + unit.hash + '/archive'));
  assert.equal(zipRes.status, 200);
  const whole = Buffer.from(await zipRes.arrayBuffer());
  const entries = unzip(whole);
  assert.deepEqual(entries.map(e => e.name), ['unit.json', ...unit.files.map(f => f.path)]);
  assert.deepEqual(entries[0].data, unit.manifest);
  for (const f of unit.files) assert.equal(sha(entries.find(e => e.name === f.path).data), f.sha256);
  /* The store's archive is the form its own upload check reads. */
  const { ArchiveWalker } = await modsModule;
  const w = new ArchiveWalker(whole.length, { hash: false });
  w.push(new Uint8Array(whole)); w.finish();
  assert.equal(w.error, null);
  /* Any range of it is that range of the whole. */
  const part = await fetchWorker(env, call('GET', '/mods/unit/' + unit.hash + '/archive', { headers: { Range: 'bytes=100-70100' } }));
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), whole.subarray(100, 70101));
});

test('a second unit sharing files sends only the files the store lacks, and each file is stored once', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const shared = Buffer.alloc(5000, 9);
  const a = makeUnit({ 'entities/a.decl': 'a', 'images/gore.bimage': shared });
  const b = makeUnit({ 'entities/b.decl': 'b', 'images/gore.bimage': shared });
  await publishUnit(env, key, a);
  const first = await publishUnit(env, key, b);
  assert.deepEqual(first.missing, [sha(Buffer.from('b'))]);
  const stats = await (await admin(env, 'stats')).json();
  assert.equal(stats.blobs, 3);
  assert.equal(stats.units, 2);
  /* A begin of a unit the store holds says so and sends nothing. */
  const again = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + a.hash + '/begin', a.manifest));
  assert.deepEqual(await again.json(), { held: true });
  /* A unit of files the store already holds is held at its begin. */
  const c = makeUnit({ 'entities/c.decl': 'a', 'images/gore.bimage': shared });
  assert.deepEqual(await publishUnit(env, key, c), { held: true });
});

test('the begin checks the manifest against its hash and SPEC 3.4, and needs a signature', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const good = makeUnit({ 'entities/x.decl': 'x' });
  const begin = (hash, bytes, headers) => fetchWorker(env, call('POST', '/mods/unit/' + hash + '/begin', { body: bytes, headers }));
  let res = await begin(good.hash, good.manifest, {});
  assert.equal(res.status, 403);
  assertSentence((await res.json()).error, 'unsigned');
  res = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + 'f'.repeat(64) + '/begin', good.manifest));
  assert.equal(res.status, 422);
  /* A signature over other bytes. */
  const other = makeKey();
  res = await begin(good.hash, good.manifest, { ...signed(other, 'POST', '/mods/unit/' + good.hash + '/begin', Buffer.from('x')), 'X-Publisher-Key': other.pub });
  assert.equal(res.status, 403);
  const bad = async (doc, why) => {
    const bytes = Buffer.from(typeof doc === 'string' ? doc : canonical(doc));
    const r = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + sha(bytes) + '/begin', bytes));
    assert.equal(r.status, 422, why);
    assertSentence((await r.json()).error, why);
  };
  const doc = good.doc;
  await bad('not json', 'not JSON');
  await bad({ ...doc, extra: 1 }, 'an unknown key');
  await bad({ ...doc, format: 2 }, 'an unknown format');
  await bad({ ...doc, files: [{ path: '../x.decl', sha256: 'a'.repeat(64), size: 1 }] }, 'a climbing path');
  await bad({ ...doc, files: [{ path: 'Entities/x.decl', sha256: 'a'.repeat(64), size: 1 }] }, 'upper case');
  await bad({ ...doc, files: [{ path: 'assets/x.decl', sha256: 'a'.repeat(64), size: 1 }] }, 'no mod folder');
  await bad({ ...doc, files: [{ path: 'entities/a\u0001.decl', sha256: 'a'.repeat(64), size: 1 }] }, 'a control byte');
  await bad({ ...doc, files: [{ path: 'entities/b.decl', sha256: 'a'.repeat(64), size: 1 }, { path: 'entities/a.decl', sha256: 'b'.repeat(64), size: 1 }] }, 'out of order');
  await bad({ ...doc, files: [{ path: 'entities/a.decl', sha256: 'a'.repeat(64), size: 1 }, { path: 'entities/b.decl', sha256: 'a'.repeat(64), size: 2 }] }, 'one sha two sizes');
  await bad({ ...doc, root: { kind: 'weapon', name: 'x' } }, 'a root kind');
  await bad({ ...doc, game: [{ path: 'generated/x.decl', sha256: 'a'.repeat(64) }] }, 'a pointer without source');
  await bad({ ...doc, spelled: 'BAD' }, 'a bad namespace');
});

test('the archive check refuses anything the begun manifest does not say, and keeps nothing it refused', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const unit = makeUnit({ 'entities/x.decl': 'x', 'images/x.bimage': 'pixels', 'scripts/x.lua': 'return 1' });
  const first = await (await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest))).json();
  const put = (bytes, k = key) => fetchWorker(env, signedCall(k, 'PUT', '/mods/unit/' + unit.hash + '/archive', bytes,
    { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) } }));
  const refused = async (bytes, why, code = 422) => {
    const res = await put(bytes);
    assert.equal(res.status, code, why);
    assertSentence((await res.json()).error, why);
  };
  await refused(unitZip(unit, first.missing, e => e.name === 'images/x.bimage' ? { ...e, name: 'images/y.bimage' } : e), 'a file not listed');
  await refused(unitZip(unit, first.missing, e => e.name === 'images/x.bimage' ? { ...e, data: 'pixelz' } : e), 'other bytes');
  await refused(unitZip(unit, first.missing, e => e.name === 'images/x.bimage' ? { ...e, crc: 1234 } : e), 'a wrong CRC');
  await refused(unitZip(unit, first.missing, e => e.name === 'unit.json' ? { ...e, data: 'x' } : e), 'another unit.json');
  await refused(zip(unitZip(unit, []).length ? [{ name: 'entities/x.decl', data: 'x' }] : []), 'no unit.json');
  /* A forged signature: the archive's hash is not what was signed. */
  const archive = unitZip(unit, first.missing);
  const forged = signed(key, 'PUT', '/mods/unit/' + unit.hash + '/archive', Buffer.from('other'));
  const res = await fetchWorker(env, call('PUT', '/mods/unit/' + unit.hash + '/archive', { body: archive,
    headers: { ...forged, 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) } }));
  assert.equal(res.status, 403);
  assert.equal([...env.MODS.objects.keys()].filter(k => k.startsWith('pack/')).length, 0, 'every refused archive deleted');
  assert.deepEqual(await status(env, [unit.hash]), { [unit.hash]: 'missing' });
  /* Lua bytecode is refused (a script is source text). */
  const compiled = makeUnit({ 'scripts/c.lua': Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x54, 0]) });
  const cb = await (await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + compiled.hash + '/begin', compiled.manifest))).json();
  const cz = unitZip(compiled, cb.missing);
  const cr = await fetchWorker(env, signedCall(key, 'PUT', '/mods/unit/' + compiled.hash + '/archive', cz, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(cz.length) } }));
  assert.equal(cr.status, 422);
  assertSentence((await cr.json()).error, 'bytecode');
  /* An archive of only some of the missing files leaves the rest missing; complete says which. */
  const some = unitZip(unit, [first.missing[0]]);
  const partial = await put(some);
  assert.equal(partial.status, 200);
  assert.equal((await partial.json()).missing.length, first.missing.length - 1);
  const complete = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + unit.hash + '/complete', ''));
  assert.equal(complete.status, 409);
  assert.equal((await put(unitZip(unit, first.missing.slice(1)))).status, 201);
  assert.equal((await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + unit.hash + '/complete', ''))).status, 201);
});

test('a file over one request goes up in parts, resumes, is checked whole and completes its unit', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const big = Buffer.alloc(16 * 1024 * 1024 + 5, 0);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 255;
  const unit = makeUnit({ 'entities/x.decl': 'x', 'virtual-textures/big_sq1.mega2': big });
  const first = await (await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest))).json();
  const bigSha = sha(big);
  assert.ok(first.missing.includes(bigSha));
  /* Parts of a file no begun unit needs are refused. */
  let res = await fetchWorker(env, signedJson(key, '/mods/blob/' + 'c'.repeat(64) + '/parts', { size: 100 }));
  assert.equal(res.status, 409);
  res = await fetchWorker(env, signedJson(key, '/mods/blob/' + bigSha + '/parts', { size: big.length }));
  assert.equal(res.status, 201);
  const session = await res.json();
  assert.equal(session.parts, 2);
  const sendPart = n => {
    const bytes = big.subarray((n - 1) * session.partSize, n * session.partSize);
    return fetchWorker(env, call('PUT', '/mods/blob/' + bigSha + '/parts/' + n, { body: bytes,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-Blob-Size': String(big.length) } }));
  };
  assert.equal((await sendPart(1)).status, 200);
  res = await fetchWorker(env, signedJson(key, '/mods/blob/' + bigSha + '/parts', { size: big.length }));
  assert.deepEqual((await res.json()).have, [1]);
  assert.equal((await fetchWorker(env, signedJson(key, '/mods/blob/' + bigSha + '/complete', { size: big.length }))).status, 409);
  assert.equal((await sendPart(2)).status, 200);
  res = await fetchWorker(env, signedJson(key, '/mods/blob/' + bigSha + '/complete', { size: big.length }));
  assert.equal(res.status, 201, await res.clone().text());
  const rest = first.missing.filter(s => s !== bigSha);
  assert.equal((await fetchWorker(env, signedCall(key, 'PUT', '/mods/unit/' + unit.hash + '/archive', unitZip(unit, rest),
    { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(unitZip(unit, rest).length) } }))).status, 201);
  assert.deepEqual(await status(env, [unit.hash]), { [unit.hash]: 'held' });
  const blob = await fetchWorker(env, call('GET', '/mods/blob/' + bigSha, { headers: { Range: 'bytes=16777215-16777220' } }));
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), big.subarray(16777215, 16777221));
  const zipRes = await fetchWorker(env, call('GET', '/mods/unit/' + unit.hash + '/archive'));
  const entries = unzip(Buffer.from(await zipRes.arrayBuffer()));
  assert.equal(sha(entries.find(e => e.name === 'virtual-textures/big_sq1.mega2').data), bigSha);
});

test('claims: rev 1 makes, rev + 1 replaces, a stale rev and a missing unit change nothing; release', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const a = makeUnit({ 'entities/a.decl': 'a' }), b = makeUnit({ 'entities/b.decl': 'b' });
  await publishUnit(env, key, a);
  let res = await claim(env, key, 'item-1', [a.hash, b.hash], SECRET_A, 1);
  assert.equal(res.status, 409);
  assert.deepEqual((await res.json()).missing, [b.hash]);
  await publishUnit(env, key, b);
  res = await claim(env, key, 'item-1', [a.hash, b.hash], SECRET_A, 2);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).rev, 0);
  res = await claim(env, key, 'item-1', [a.hash, b.hash], SECRET_A, 1);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).rev, 1);
  res = await claim(env, key, 'item-1', [a.hash], SECRET_A, 1);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).rev, 1);
  /* An unsigned claim is refused. */
  res = await fetchWorker(env, call('POST', '/mods/map/claim', { body: JSON.stringify({ ref: 'item-1', units: [a.hash], secret: SECRET_A, rev: 2 }) }));
  assert.equal(res.status, 403);
  /* The republish leaves b out: b starts its deletion delay and is still served during it. */
  res = await claim(env, key, 'item-1', [a.hash], SECRET_A, 2);
  assert.equal(res.status, 200);
  assert.equal(env.storage.sql.exec('SELECT claims, unclaimed_at FROM unit WHERE hash = ?', b.hash).toArray()[0].claims, 0);
  assert.deepEqual(await status(env, [b.hash]), { [b.hash]: 'held' });
  /* A release needs the secret and rev + 1. */
  res = await fetchWorker(env, signedJson(key, '/mods/map/release', { ref: 'item-1', secret: SECRET_B, rev: 3 }));
  assert.equal(res.status, 404);
  res = await fetchWorker(env, signedJson(key, '/mods/map/release', { ref: 'item-1', secret: SECRET_A, rev: 2 }));
  assert.equal(res.status, 409);
  res = await fetchWorker(env, signedJson(key, '/mods/map/release', { ref: 'item-1', secret: SECRET_A, rev: 3 }));
  assert.equal(res.status, 204);
});

test('the deletion delay: an unclaimed unit is kept and served 24 hours, a claim within it keeps it, then purge deletes it', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const shared = Buffer.from('shared bytes');
  const a = makeUnit({ 'entities/a.decl': 'a', 'images/s.bimage': shared });
  const b = makeUnit({ 'entities/b.decl': 'b', 'images/s.bimage': shared });
  await publishUnit(env, key, a);
  await publishUnit(env, key, b);
  assert.equal((await claim(env, key, 'map-b', [b.hash], SECRET_B, 1)).status, 201);
  const { purgeMods } = await modsModule;
  env.clock.offset = 23 * HOUR;
  await purgeMods(env);
  assert.deepEqual(await status(env, [a.hash]), { [a.hash]: 'held' }, 'kept within the delay');
  /* A claim within the delay clears it. */
  assert.equal((await claim(env, key, 'map-a', [a.hash], SECRET_A, 1)).status, 201);
  env.clock.offset = 49 * HOUR;
  await purgeMods(env);
  assert.deepEqual(await status(env, [a.hash, b.hash]), { [a.hash]: 'held', [b.hash]: 'held' });
  /* Unpublish map-a: a is deleted at the first purge after 24 hours; the shared file stays for b. */
  assert.equal((await fetchWorker(env, signedJson(key, '/mods/map/release', { ref: 'map-a', secret: SECRET_A, rev: 2 }))).status, 204);
  env.clock.offset = 49 * HOUR + DAY - 1000;
  await purgeMods(env);
  assert.deepEqual(await status(env, [a.hash]), { [a.hash]: 'held' });
  env.clock.offset = 49 * HOUR + DAY + 1000;
  const purged = await purgeMods(env);
  assert.equal(purged.units, 1);
  assert.deepEqual(await status(env, [a.hash, b.hash]), { [a.hash]: 'missing', [b.hash]: 'held' });
  assert.equal((await fetchWorker(env, call('GET', '/mods/unit/' + a.hash))).status, 404);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + sha(shared)))).status, 200);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + sha(Buffer.from('a'))))).status, 404);
  /* A unit begun and never claimed goes the same way. */
  const c = makeUnit({ 'entities/c.decl': 'c' });
  await publishUnit(env, key, c);
  env.clock.offset += DAY + 1000;
  await purgeMods(env);
  assert.deepEqual(await status(env, [c.hash]), { [c.hash]: 'missing' });
  /* Packs nothing names any more are deleted. */
  const stats = await (await admin(env, 'stats')).json();
  assert.equal(stats.units, 1);
  assert.equal(stats.blobs, 2);
});

test('a remix by another publisher claims the same unit; each claim keeps it; a deleted unit is uploaded again', async () => {
  const env = await modsEnv();
  const author = makeKey(), player = makeKey();
  const tyrant = makeUnit({ 'entities/tyrant.decl': 'tyrant', 'images/t.bimage': Buffer.alloc(3000, 1) });
  await publishUnit(env, author, tyrant);
  assert.equal((await claim(env, author, 'original', [tyrant.hash], SECRET_A, 1)).status, 201);
  /* The remix: the store holds the unit, so nothing uploads. */
  assert.deepEqual(await publishUnit(env, player, tyrant), { held: true });
  assert.equal((await claim(env, player, 'remix', [tyrant.hash], SECRET_B, 1)).status, 201);
  assert.equal(env.storage.sql.exec('SELECT claims FROM unit WHERE hash = ?', tyrant.hash).toArray()[0].claims, 2);
  assert.equal((await fetchWorker(env, signedJson(author, '/mods/map/release', { ref: 'original', secret: SECRET_A, rev: 2 }))).status, 204);
  const { purgeMods } = await modsModule;
  env.clock.offset = 2 * DAY;
  await purgeMods(env);
  assert.deepEqual(await status(env, [tyrant.hash]), { [tyrant.hash]: 'held' });
  assert.equal((await fetchWorker(env, signedJson(player, '/mods/map/release', { ref: 'remix', secret: SECRET_B, rev: 2 }))).status, 204);
  env.clock.offset = 4 * DAY;
  await purgeMods(env);
  assert.deepEqual(await status(env, [tyrant.hash]), { [tyrant.hash]: 'missing' });
  /* Someone who kept the map republishes it: the unit uploads again from their copy. */
  const first = await publishUnit(env, player, tyrant);
  assert.equal(first.missing.length, 2);
  assert.equal((await claim(env, player, 'remix-2', [tyrant.hash], SECRET_B, 1)).status, 201);
});

test('moderation removes a unit: 451 everywhere, no upload puts it back, a claim keeps the rest; unblock', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const bad = makeUnit({ 'entities/bad.decl': 'bad' }), good = makeUnit({ 'entities/good.decl': 'good' });
  await publishUnit(env, key, bad);
  await publishUnit(env, key, good);
  assert.equal((await claim(env, key, 'm', [bad.hash, good.hash], SECRET_A, 1)).status, 201);
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/block', { body: JSON.stringify({ unit: bad.hash }) }))).status, 403, 'refused without the token');
  const blocked = await admin(env, 'block', { unit: bad.hash, reason: 'test' });
  assert.equal(blocked.status, 200);
  assert.deepEqual(await status(env, [bad.hash, good.hash]), { [bad.hash]: 'removed', [good.hash]: 'held' });
  assert.equal((await fetchWorker(env, call('GET', '/mods/unit/' + bad.hash))).status, 451);
  assert.equal((await fetchWorker(env, call('GET', '/mods/unit/' + bad.hash + '/archive'))).status, 451);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + sha(Buffer.from('bad'))))).status, 404);
  const again = await fetchWorker(env, signedCall(key, 'POST', '/mods/unit/' + bad.hash + '/begin', bad.manifest));
  assert.equal(again.status, 451);
  assertSentence((await again.json()).error, 'blocked begin');
  const res = await claim(env, key, 'm', [bad.hash, good.hash], SECRET_A, 2);
  assert.equal(res.status, 451);
  const body = await res.json();
  assert.deepEqual(body.removed, [bad.hash]);
  assert.equal(body.rev, 2);
  assert.equal((await admin(env, 'unblock', { unit: bad.hash })).status, 200);
  assert.deepEqual(await status(env, [bad.hash]), { [bad.hash]: 'missing' });
  /* release-ref: every claim of one item. */
  assert.deepEqual(await (await admin(env, 'release-ref', { ref: 'm' })).json(), { claims: 1 });
});

test('the account name binds first come, first served; forget-key frees it', async () => {
  const env = await modsEnv();
  const alice = makeKey(), other = makeKey();
  const u = makeUnit({ 'entities/n.decl': 'n' });
  await fetchWorker(env, signedCall(alice, 'POST', '/mods/unit/' + u.hash + '/begin', u.manifest, { name: 'Ålice' }));
  const row = k => env.storage.sql.exec('SELECT display FROM publisher_name WHERE key = ?', k.pub).toArray()[0]?.display ?? null;
  assert.equal(row(alice), 'Ålice');
  await fetchWorker(env, signedCall(other, 'POST', '/mods/unit/' + u.hash + '/begin', u.manifest, { name: 'ålice' }));
  assert.equal(row(other), null, 'a name another key holds is not bound');
  /* A key presenting a new free name binds it and releases its old one. */
  await fetchWorker(env, signedCall(alice, 'POST', '/mods/unit/' + u.hash + '/begin', u.manifest, { name: 'Alice2' }));
  assert.equal(row(alice), 'Alice2');
  await fetchWorker(env, signedCall(other, 'POST', '/mods/unit/' + u.hash + '/begin', u.manifest, { name: 'ålice' }));
  assert.equal(row(other), 'ålice');
  /* The owner forgets a key: its name is free; its claims stay. */
  await publishUnit(env, other, u);
  assert.equal((await claim(env, other, 'x', [u.hash], SECRET_A, 1)).status, 201);
  const forgot = await (await admin(env, 'forget-key', { key: other.pub })).json();
  assert.deepEqual(forgot, { forgotten: true, name: 'ålice' });
  assert.equal(env.storage.sql.exec('SELECT count(*) AS n FROM map_claim').toArray()[0].n, 1);
  await fetchWorker(env, signedCall(alice, 'POST', '/mods/unit/' + u.hash + '/begin', u.manifest, { name: 'Ålice' }));
  assert.equal(row(alice), 'Ålice');
  /* Signed out: no name, nothing changes. */
  await fetchWorker(env, signedCall(other, 'POST', '/mods/unit/' + u.hash + '/begin', u.manifest));
  assert.equal(row(other), null);
});

test('asked paths: a well-formed path the unit lacks, at most 256 per unit; the publisher reads them by claim', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const u = makeUnit({ 'entities/a.decl': 'a' }, { name: 'entities/a' });
  await publishUnit(env, key, u);
  let from = 0;
  const ask = p => fetchWorker(env, call('POST', '/mods/unit/' + u.hash + '/asked', { body: JSON.stringify({ path: p }), headers: { 'CF-Connecting-IP': '192.0.2.' + (from++ % 250) } }));
  assert.equal((await ask('materials/a_skin.decl')).status, 204);
  assert.equal((await ask('entities/a.decl')).status, 400, 'the unit holds it');
  assert.equal((await ask('../x')).status, 400);
  assert.equal((await ask('generated/decls/x.decl')).status, 400, 'not a mod path');
  assert.equal((await fetchWorker(env, call('POST', '/mods/unit/' + 'e'.repeat(64) + '/asked', { body: JSON.stringify({ path: 'images/x.bimage' }) }))).status, 404);
  for (let i = 0; i < 300; i++) await ask('images/m' + i + '.bimage');
  assert.equal(env.storage.sql.exec('SELECT count(*) AS n FROM asked').toArray()[0].n, 256);
  assert.equal((await claim(env, key, 'm', [u.hash], SECRET_A, 1)).status, 201);
  const list = await fetchWorker(env, signedJson(key, '/mods/asked', { claims: [{ ref: 'm', secret: SECRET_A }, { ref: 'other', secret: SECRET_B }] }));
  const got = await list.json();
  assert.equal(got.asked.length, 256);
  assert.deepEqual(got.asked[0], { unit: u.hash, root: 'entities/a', path: 'materials/a_skin.decl' });
});

test('per-key and per-address limits: a key that spent its hour is refused with Retry-After, another is not', async () => {
  const env = await modsEnv();
  const a = makeKey(), b = makeKey();
  for (let i = 0; i < 256; i++) {
    const res = await fetchWorker(env, signedJson(a, '/mods/map/release', { ref: 'r' + i, secret: SECRET_A, rev: 1 }));
    assert.equal(res.status, 404);
  }
  const over = await fetchWorker(env, signedJson(a, '/mods/map/release', { ref: 'r', secret: SECRET_A, rev: 1 }));
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('Retry-After')) > 0);
  /* The address spent its 256 too; from another address the second key goes through. */
  const res = await fetchWorker(env, signedJson(b, '/mods/map/release', { ref: 'r', secret: SECRET_A, rev: 1 }, { headers: { 'CF-Connecting-IP': '198.51.100.9' } }));
  assert.equal(res.status, 404);
  assert.ok(env.names.some(n => n.startsWith('mods-key:')) && env.names.every(n => !n.includes(a.pub)), 'keys are hashed in quota names');
});

test('the retired routes answer 410 with the sentence for an old Snapmap+', async () => {
  const env = await modsEnv();
  const { RETIRED } = await modsModule;
  for (const [method, route] of [['GET', '/mods/build/' + 'a'.repeat(64)], ['PUT', '/mods/build/' + 'a'.repeat(64)], ['POST', '/mods/claim'],
    ['POST', '/mods/release'], ['PUT', '/mods/blob/' + 'a'.repeat(64)], ['GET', '/mods/bundle/x'], ['POST', '/mods/missing'],
    ['POST', '/mods/author/x/key']]) {
    const res = await fetchWorker(env, call(method, route, { body: method === 'GET' ? undefined : '{}' }));
    assert.equal(res.status, 410, route);
    assert.equal((await res.json()).error, RETIRED);
  }
});

test('every refusal on the unit routes is one plain sentence', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const h = 'd'.repeat(64);
  const cases = [
    call('GET', '/mods/unit/' + h), call('GET', '/mods/unit/' + h + '/archive'), call('GET', '/mods/blob/' + h),
    call('POST', '/mods/units', { body: '{"units":"x"}' }), call('POST', '/mods/units', { body: JSON.stringify({ units: Array(4097).fill(h) }) }),
    call('GET', '/mods/unit/' + h.toUpperCase()), call('DELETE', '/mods/unit/' + h), call('POST', '/mods/unit/' + h + '/complete'),
    signedCall(key, 'PUT', '/mods/unit/' + h + '/archive', 'x', { headers: { 'Content-Type': 'text/plain' } }),
    signedCall(key, 'POST', '/mods/unit/' + h + '/complete', ''),
    signedJson(key, '/mods/map/claim', { ref: '', units: [], secret: 'x', rev: 0 }),
    signedJson(key, '/mods/map/claim', { ref: 'r', units: ['x'], secret: SECRET_A, rev: 1 }),
    signedJson(key, '/mods/map/release', { ref: 'r', secret: 'short', rev: 1 }),
    signedJson(key, '/mods/asked', { claims: 'x' }), call('POST', '/mods/admin/stats', { headers: { Authorization: 'Bearer wrong' } }),
    call('GET', '/mods/nothing'),
  ];
  for (const req of cases) {
    const res = await fetchWorker(env, req);
    assert.ok(res.status >= 400, req.url);
    assertSentence((await res.json()).error, req.method + ' ' + req.url);
  }
});

test('a pack found missing breaks its files until an upload repairs them', async () => {
  const env = await modsEnv();
  const key = makeKey();
  const u = makeUnit({ 'entities/r.decl': 'r', 'images/r.bimage': 'rr' });
  await publishUnit(env, key, u);
  assert.equal((await claim(env, key, 'r', [u.hash], SECRET_A, 1)).status, 201);
  const packKey = [...env.MODS.objects.keys()].find(k => k.startsWith('pack/'));
  env.MODS.objects.delete(packKey);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + sha(Buffer.from('rr'))))).status, 404);
  assert.deepEqual(await status(env, [u.hash]), { [u.hash]: 'missing' });
  const first = await publishUnit(env, key, u);
  assert.equal(first.missing.length, 2);
  assert.deepEqual(await status(env, [u.hash]), { [u.hash]: 'held' });
  assert.equal((await claim(env, key, 'r', [u.hash], SECRET_A, 2)).status, 200);
});

test('the registry drops the tables of the stores it replaced', async () => {
  const r = await registryModule;
  const s = sqliteStorage();
  s.sql.exec('CREATE TABLE build (id INTEGER)');
  s.sql.exec('CREATE TABLE author (id TEXT)');
  s.sql.exec('CREATE TABLE blob (id INTEGER PRIMARY KEY, sha TEXT, refs INTEGER)');
  s.sql.exec("CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  s.sql.exec("INSERT INTO store_meta VALUES ('schema', '3')");
  r.initializeRegistry(s);
  const tables = new Set(s.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(t => t.name));
  assert.ok(!tables.has('build') && !tables.has('author'));
  const cols = new Set(s.sql.exec('PRAGMA table_info(blob)').toArray().map(c => c.name));
  assert.ok(cols.has('crc') && !cols.has('refs'));
  assert.ok(tables.has('unit') && tables.has('map_claim_unit') && tables.has('publisher_name') && tables.has('blocked'));
});

test('the reset empties the bucket and the index', async () => {
  const env = await modsEnv();
  const key = makeKey();
  await publishUnit(env, key, makeUnit({ 'entities/z.decl': 'z' }));
  const res = await admin(env, 'reset');
  assert.equal(res.status, 200);
  assert.equal(env.MODS.objects.size, 0);
  const stats = await (await admin(env, 'stats')).json();
  assert.equal(stats.units + stats.blobs + stats.packs + stats.publishers, 0);
});

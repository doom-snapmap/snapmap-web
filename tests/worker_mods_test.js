'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const read = name => fs.readFileSync(path.join(root, 'api', name), 'utf8');
const bodyURL = dataURL(read('request_body.js'));
const modsURL = dataURL(read('mods_store.js').replace('./request_body.js', bodyURL));
const workerURL = dataURL(read('worker.js').replace('./request_body.js', bodyURL).replace('./mods_store.js', modsURL)
  .replace("export { CommunityQuota } from './quota.js';", '').replace("export { ModRegistry } from './mods_registry.js';", ''));
const modsModule = import(modsURL);
const workerModule = import(workerURL);
const quotaModule = import(dataURL(read('quota_store.js')));
const registryModule = import(dataURL(read('mods_registry_store.js')));

const DAY = 86400000;
const HOUR = 3600000;
const MIB = 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

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
    async get(key) {
      log.push(['get', key]);
      const o = objects.get(key);
      if (!o) return null;
      let cancelled = false;
      const body = new ReadableStream({ start(c) { c.enqueue(o.bytes); c.close(); }, cancel() { cancelled = true; } });
      return { ...meta(key, o), body, get cancelled() { return cancelled; } };
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
      return { objects: page.map(key => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
}

async function modsEnv(extra = {}) {
  const { initializeQuota, consumeModQuota } = await quotaModule;
  const registry = await registryModule;
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const quotaObjects = new Map();
  const names = [];
  const storage = sqliteStorage();
  registry.initializeRegistry(storage);
  const env = {
    clock, names, registryStorage: storage,
    MODS: memoryBucket(),
    MODS_BLOCKED: '[]',
    WRITE_QUOTAS: {
      idFromName(name) { names.push(name); return name; },
      get(name) {
        if (!quotaObjects.has(name)) { const s = sqliteStorage(); initializeQuota(s); quotaObjects.set(name, s); }
        const s = quotaObjects.get(name);
        return { consumeMods: async entries => consumeModQuota(s, entries, clock.now()) };
      },
    },
    MOD_REGISTRY: {
      idFromName(name) { assert.equal(name, 'registry'); return name; },
      get() {
        return {
          buildRow: async hash => registry.buildRow(storage, hash),
          registerBuild: async (hash, size, salt, object, scripts) => registry.registerBuild(storage, hash, size, salt, object, scripts, clock.now()),
          touchBuild: async hash => registry.touchBuild(storage, hash, clock.now()),
          buildServed: async hash => registry.buildServed(storage, hash, clock.now()),
          claim: async request => registry.claimBuilds(storage, request, clock.now()),
          release: async (id, hash) => registry.releaseClaim(storage, id, hash),
          purgeBuilds: async limit => registry.purgeBuilds(storage, clock.now(), limit),
          uploadSession: async (hash, size) => registry.uploadSession(storage, hash, size),
          openUpload: async request => registry.openUpload(storage, request, clock.now()),
          recordPart: async (hash, size, upload, part, etag) => registry.recordPart(storage, hash, size, upload, part, etag, clock.now()),
          closeUpload: async (hash, size, upload) => registry.closeUpload(storage, hash, size, upload),
          abandonUploads: async (limit, all) => registry.abandonUploads(storage, clock.now(), limit, all),
          reset: async () => registry.resetRegistry(storage),
        };
      },
    },
    ...extra,
  };
  return env;
}

/* ---------------- request helpers ---------------- */

const ADDRESS = '203.0.113.7';

function call(method, route, { body, headers = {} } = {}) {
  return new Request('https://service.test' + route, { method, body, duplex: 'half', headers: { 'CF-Connecting-IP': ADDRESS, ...headers } });
}

async function fetchWorker(env, request) {
  return (await workerModule).default.fetch(request, env);
}

function putRequest(hash, bytes, headers = {}) {
  return call('PUT', '/mods/build/' + hash, { body: bytes, headers: {
    'Content-Type': 'application/zip', 'Content-Length': String(bytes.byteLength), ...headers } });
}

function postJson(route, value, headers = {}) {
  return call('POST', route, { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json', ...headers } });
}


/* ---------------- build archives, written as the product's modzip.c writes them ---------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* entries: [{ name, data, method?, flags?, extra? }]. Stored entries, fixed DOS time, the
 * UTF-8 flag on a non-ASCII name, central directory, end record. Returns the bytes and
 * where the central directory and end record start, for tests that damage one field. */
function zip(entries, { comment = Buffer.alloc(0), before = Buffer.alloc(0), between = Buffer.alloc(0), after = Buffer.alloc(0), zip64End = false } = {}) {
  const parts = [before];
  let offset = before.length;
  const records = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const extra = entry.extra || Buffer.alloc(0);
    const flags = entry.flags ?? (/^[\x00-\x7f]*$/.test(entry.name) ? 0 : 0x0800);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method || 0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    records.push({ name, extra, flags, crc, size: data.length, offset, method: entry.method || 0 });
    parts.push(local, name, extra, data);
    offset += 30 + name.length + extra.length + data.length;
    if (records.length === 1 && between.length) { parts.push(between); offset += between.length; }
  }
  const cd = offset;
  for (const r of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(r.flags, 8); central.writeUInt16LE(r.method, 10); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(r.crc, 16); central.writeUInt32LE(r.size, 20); central.writeUInt32LE(r.size, 24);
    central.writeUInt16LE(r.name.length, 28); central.writeUInt16LE(r.extra.length, 30); central.writeUInt32LE(r.offset, 42);
    parts.push(central, r.name, r.extra);
    offset += 46 + r.name.length + r.extra.length;
  }
  const cdSize = offset - cd;
  if (zip64End) { const z = Buffer.alloc(56); z.writeUInt32LE(0x06064b50, 0); parts.push(z); offset += 56; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(records.length, 0xffff), 8); end.writeUInt16LE(Math.min(records.length, 0xffff), 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cd, 16); end.writeUInt16LE(comment.length, 20);
  parts.push(end, comment, after);
  return { bytes: Buffer.concat(parts), cd, end: offset, records };
}

const SALT = 'k7pinkim';
let counter = 0;

function defaultFiles(salt) {
  return [
    { request: 'generated/decls/entitydef/mods/' + salt + '/pink_imp.decl', data: 'entityDef mods/' + salt + '/pink_imp { inherit = "monster/imp"; }\n' },
    { request: 'generated/image/mods/' + salt + '/pink.bimage', data: Buffer.alloc(300, 7) },
  ];
}

/* A refusal is one plain sentence the product shows as it is (modnet.c mn_error_text keeps
 * its printable ASCII, whole). */
function assertSentence(text, what) {
  assert.match(text, /^[A-Z][\x20-\x7e]*\.$/, what + ': ' + text);
}

function entriesFor(modjson, files) {
  return [{ name: 'mod.json', data: modjson }, ...files.map(f => ({ name: 'assets/' + f.request, data: f.data }))];
}

/* A build of a mod with the given carried files ({request, data, path?}) and pointers, its
 * mod.json as the product writes it (author part, then the "snapmap-plus" block). The block
 * lists a file by its path in the folder (path, which keeps the folder's case) and the
 * archive holds it at assets/<request>, lower case, as modsync.c writes it. There is no
 * version anywhere (decision 8). The Worker never recomputes the canonical hash (the client
 * does), so any fresh hash names it. */
function build({ salt = SALT, files = defaultFiles(salt), stock = [], hash = sha(Buffer.from('build-' + (++counter))), block = {}, author = {}, pretty = true } = {}) {
  const listed = files.map(f => ({ path: 'assets/' + (f.path || f.request), sha256: sha(Buffer.from(f.data)), size: Buffer.from(f.data).length,
    provides: { type: 'entityDef', name: f.request }, needs: [] }));
  const modBlock = { format: 2, salt, rules: 9, built: 1794000000, tree: 'a'.repeat(64), build: hash, classes: { adds: files.length },
    editor: [], registries: {}, files: listed, ...(stock.length ? { stock } : {}), ...block };
  const doc = { name: 'Pink Imp', description: 'A pinker imp.', ...author, 'snapmap-plus': modBlock };
  const modjson = Buffer.from(pretty ? JSON.stringify(doc, null, 2) + '\n' : JSON.stringify(doc), 'utf8');
  return { hash, modjson, doc, files, ...zip(entriesFor(modjson, files)) };
}

/* The build written as ZIP64, as the product writes an archive past 4 GiB or 65,535 entries:
 * every size and offset a marker with its value in a ZIP64 extra field, then the ZIP64 end
 * record and locator, then an end record of markers. */
function zip64Archive(archive) {
  const entries = entriesFor(archive.modjson, archive.files);
  const parts = [], records = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), crc = crc32(data);
    const local = Buffer.alloc(30), extra = Buffer.alloc(20);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(45, 4); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(20, 28);
    extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(data.length), 12);
    records.push({ name, crc, size: data.length, offset });
    parts.push(local, name, extra, data);
    offset += 30 + name.length + 20 + data.length;
  }
  const cd = offset;
  for (const r of records) {
    const central = Buffer.alloc(46), extra = Buffer.alloc(28);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(45, 4); central.writeUInt16LE(45, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(r.crc, 16); central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(r.name.length, 28); central.writeUInt16LE(28, 30); central.writeUInt32LE(0xffffffff, 42);
    extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(r.size), 4); extra.writeBigUInt64LE(BigInt(r.size), 12);
    extra.writeBigUInt64LE(BigInt(r.offset), 20);
    parts.push(central, r.name, extra);
    offset += 46 + r.name.length + 28;
  }
  const end64At = offset, end64 = Buffer.alloc(56), locator = Buffer.alloc(20), end = Buffer.alloc(22);
  end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(records.length), 24); end64.writeBigUInt64LE(BigInt(records.length), 32);
  end64.writeBigUInt64LE(BigInt(end64At - cd), 40); end64.writeBigUInt64LE(BigInt(cd), 48);
  locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(end64At), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  parts.push(end64, locator, end);
  return { hash: archive.hash, modjson: archive.modjson, bytes: Buffer.concat(parts), locator: end64At + 56 };
}

/* The same build's mod.json over other entries. */
function rezip(archive, list) {
  return { hash: archive.hash, modjson: archive.modjson, ...zip(list) };
}

async function put(env, archive, headers) {
  return fetchWorker(env, putRequest(archive.hash, archive.bytes, headers));
}

async function stored(env, ...archives) {
  for (const archive of archives) {
    const response = await put(env, archive);
    assert.equal(response.status, 201, 'store ' + (await response.clone().text()));
  }
}

function row(env, hash) {
  return env.registryStorage.sql.exec('SELECT size, salt, created, claims, scripts FROM mod_build WHERE hash = ?', hash).toArray()[0];
}

/* The object that serves a build (its own key, build/<hash>/<random>), or undefined. */
function objectOf(env, hash) {
  return env.registryStorage.sql.exec('SELECT object FROM mod_build WHERE hash = ?', hash).toArray()[0]?.object;
}

function bytesOf(env, hash) {
  return Buffer.from(env.MODS.objects.get(objectOf(env, hash)).bytes);
}

/* Every object stored for a build, registered or not. */
function objectsFor(env, hash) {
  return [...env.MODS.objects.keys()].filter(key => key.startsWith('build/' + hash));
}

/* ---------------- upload and serving ---------------- */

test('an archive PUT creates the build, a re-PUT is idempotent, GET and HEAD serve it', async () => {
  const env = await modsEnv();
  const archive = build();
  const created = await put(env, archive);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { build: archive.hash, size: archive.bytes.length, scripts: 0 });
  assert.match(objectOf(env, archive.hash), new RegExp('^build/' + archive.hash + '/[0-9a-f]{32}$'));
  assert.deepEqual([...env.MODS.objects.keys()], [objectOf(env, archive.hash)]);
  assert.deepEqual(bytesOf(env, archive.hash), archive.bytes);
  assert.equal(row(env, archive.hash).salt, SALT);
  assert.equal(row(env, archive.hash).size, archive.bytes.length);

  const again = await put(env, archive);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { build: archive.hash, size: archive.bytes.length, scripts: 0 });
  assert.equal(env.MODS.log.filter(([op]) => op === 'put').length, 1, 'the second body is read and discarded');

  const got = await fetchWorker(env, call('GET', '/mods/build/' + archive.hash));
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), archive.bytes);
  for (const response of [got, await fetchWorker(env, call('HEAD', '/mods/build/' + archive.hash))]) {
    assert.equal(response.headers.get('Content-Type'), 'application/zip');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
    assert.equal(response.headers.get('Content-Disposition'), 'attachment');
    assert.equal(response.headers.get('ETag'), '"' + archive.hash + '"');
    assert.equal(response.headers.get('Content-Length'), String(archive.bytes.length));
    assert.equal(response.headers.get('X-Mod-Scripts'), '0');
  }
  const head = await fetchWorker(env, call('HEAD', '/mods/build/' + archive.hash));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetchWorker(env, call('GET', '/mods/build/' + 'f'.repeat(64)))).status, 404);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/build/' + 'f'.repeat(64)))).status, 404);
});

/* A carried file 60 folders deep whose request path is 5,000 bytes. */
function deepRequest(salt) {
  const head = 'generated/decls/entitydef/mods/' + salt + '/';
  const leaf = 'deep_imp.decl';
  const folders = [];
  let used = head.length + leaf.length;
  for (let i = 0; i < 60; i++) {
    const room = Math.floor((5000 - used) / (60 - i)) - 1;
    const name = ('f' + i + '_').padEnd(room, 'x');
    folders.push(name);
    used += name.length + 1;
  }
  folders[59] = folders[59].padEnd(folders[59].length + (5000 - used), 'y');
  const request = head + folders.join('/') + '/' + leaf;
  assert.equal(request.length, 5000);
  assert.equal(request.split('/').length - head.split('/').length + 1, 61);
  return request;
}

test('a long name, author, homepage and a 60-folder, 5,000-byte path are carried whole', async () => {
  const env = await modsEnv();
  const request = deepRequest(SALT);
  const author = { name: 'N'.repeat(2000), author: 'A'.repeat(2000), homepage: 'https://example.test/' + 'h'.repeat(10000 - 21) };
  assert.equal(author.homepage.length, 10000);
  const archive = build({ files: [...defaultFiles(SALT), { request, data: 'entityDef deep { inherit = "monster/imp"; }\n' }], author });
  const created = await put(env, archive);
  assert.equal(created.status, 201, await created.clone().text());
  const got = await fetchWorker(env, call('GET', '/mods/build/' + archive.hash));
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), archive.bytes);

  /* A refusal names a long path whole. */
  const bad = request.replace(/deep_imp\.decl$/, 'deep_imp.exe');
  const refused = await put(env, build({ files: [{ request: bad, data: 'x' }] }));
  const text = JSON.parse(await refused.text()).error;
  assert.equal(refused.status, 422);
  assert.ok(text.includes(bad), 'the refusal names the path whole: ' + text.length + ' characters');
  assertSentence(text, 'the long-path refusal');
});

test('a mod.json-only archive, pointers that never upload, a BOM and a compact mod.json are accepted', async () => {
  const env = await modsEnv();
  const pointer = { path: 'assets/generated/decls/entitydef/monster/imp.decl', sha256: 'c'.repeat(64), source: 'generated/decls/entitydef/monster/imp.decl',
    provides: { type: 'entityDef', name: 'monster/imp' }, needs: [] };
  await stored(env, build({ files: [], stock: [pointer] }), build({ pretty: false }));
  const bom = build();
  await stored(env, rezip(bom, entriesFor(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bom.modjson]), bom.files)));
  const carried = build({ stock: [pointer] });
  const refused = await put(env, rezip(carried, [...entriesFor(carried.modjson, carried.files), { name: pointer.path, data: 'imp' }]));
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error, 'The archive holds assets/generated/decls/entitydef/monster/imp.decl, which mod.json does not list.');
});

test('the walker accepts the archive split at any byte', async () => {
  const { ArchiveWalker, buildVerdict } = await modsModule;
  const archive = build();
  for (const size of [1, 3, 29, 31, 64, 4096]) {
    const walker = new ArchiveWalker(archive.bytes.length);
    for (let at = 0; at < archive.bytes.length; at += size) walker.push(new Uint8Array(archive.bytes.subarray(at, at + size)));
    walker.finish();
    assert.equal(walker.error, null, 'chunk ' + size);
    assert.deepEqual(walker.entries.map(e => e.name), ['mod.json', ...defaultFiles(SALT).map(f => 'assets/' + f.request)]);
    assert.deepEqual(buildVerdict(archive.hash, walker.entries, walker.modjson), { salt: SALT, scripts: 0 });
  }
});

/* Each damaged archive is refused with 422 and its cause, and nothing is stored. */
async function refusedWith(env, archive, pattern, status = 422) {
  const response = await put(env, archive);
  const text = await response.text();
  assert.equal(response.status, status, pattern + ': ' + text);
  assert.match(JSON.parse(text).error, pattern);
  assertSentence(JSON.parse(text).error, String(pattern));
  assert.deepEqual(objectsFor(env, archive.hash), [], 'stored ' + pattern);
  assert.equal(row(env, archive.hash), undefined);
}

function damaged(archive, edit) {
  const bytes = Buffer.from(archive.bytes);
  edit(bytes, archive);
  return { ...archive, bytes };
}

test('archive PUT refuses every structural fault of the ZIP', async () => {
  const env = await modsEnv();
  await refusedWith(env, { hash: sha(Buffer.from('x')), bytes: Buffer.from('this is not a zip archive at all') }, /^The upload is not a ZIP archive\.$/);
  /* ZIP64 is read, but only as the format has it: a marker needs its value in a ZIP64 extra
   * field, an extra field no marker asks for is refused, and the end records must agree. */
  const ZIP64_EXTRA = /^The archive has a ZIP64 extra field that does not match its entry\.$/;
  await refusedWith(env, damaged(build(), b => b.writeUInt32LE(0xffffffff, 18)), ZIP64_EXTRA);
  const g64 = build();
  await refusedWith(env, { hash: g64.hash, ...zip(entriesFor(g64.modjson, g64.files), { zip64End: true }) }, /^The archive's ZIP64 end records are malformed\.$/);
  const gx = build({ files: [] });
  const zip64Extra = Buffer.alloc(20); zip64Extra.writeUInt16LE(0x0001, 0); zip64Extra.writeUInt16LE(16, 2);
  await refusedWith(env, rezip(gx, [{ name: 'mod.json', data: gx.modjson, extra: zip64Extra }]), ZIP64_EXTRA);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt16LE(0xffff, a.end + 10)), /^The archive's end record points to ZIP64 records the archive does not have\.$/);
  const z = zip64Archive(build());
  await refusedWith(env, { ...z, bytes: Buffer.concat([z.bytes.subarray(0, z.locator + 8), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), z.bytes.subarray(z.locator + 16)]) },
    /^The archive's ZIP64 end records are malformed\.$/);
  await refusedWith(env, { ...z, bytes: Buffer.concat([z.bytes.subarray(0, z.locator + 16), Buffer.from([2, 0, 0, 0]), z.bytes.subarray(z.locator + 20)]) },
    /^The archive is split across several files\.$/);
  const gc = build({ files: [] });
  await refusedWith(env, rezip(gc, [{ name: 'mod.json', data: gc.modjson, method: 8 }]), /^The archive has a compressed entry; Snapmap\+ stores every file uncompressed\.$/);
  await refusedWith(env, damaged(build(), b => b.writeUInt16LE(0x0001, 6)), /^The archive has an encrypted entry\.$/);
  await refusedWith(env, damaged(build(), b => b.writeUInt16LE(0x0008, 6)), /^The archive has an entry without its sizes in its local header\.$/);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt32LE(0, a.cd + 16)), /^The archive's central directory disagrees with its entry mod\.json\.$/);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt16LE(1, a.end + 8)), /^The archive's end record counts its entries wrongly\.$/);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt32LE(a.cd - 1, a.end + 16)), /^The archive's end record places its central directory wrongly\.$/);
  const gt = build();
  await refusedWith(env, { hash: gt.hash, ...zip(entriesFor(gt.modjson, gt.files), { after: Buffer.from('trailing') }) }, /^The archive has bytes after its end record\.$/);
  const gb = build();
  await refusedWith(env, { hash: gb.hash, ...zip(entriesFor(gb.modjson, gb.files), { before: Buffer.from('MZ') }) }, /^The upload is not a ZIP archive\.$/);
  const gw = build();
  await refusedWith(env, { hash: gw.hash, ...zip(entriesFor(gw.modjson, gw.files), { between: Buffer.from('junk') }) }, /^The archive has unexpected bytes after an entry\.$/);
  const gd = build({ files: [] });
  await refusedWith(env, rezip(gd, [{ name: 'mod.json', data: gd.modjson }, { name: 'mod.json', data: gd.modjson }]), /^The archive holds mod\.json twice\.$/);
  const truncated = build();
  await refusedWith(env, { hash: truncated.hash, bytes: truncated.bytes.subarray(0, truncated.cd) }, /^The archive ends before its central directory\.$/);
  assert.equal(env.MODS.objects.size, 0);
});

test('archive PUT refuses a mod.json or entries that do not describe the build', async () => {
  const env = await modsEnv();
  const files = defaultFiles(SALT);

  const extra = build();
  await refusedWith(env, rezip(extra, [...entriesFor(extra.modjson, files), { name: 'assets/generated/decls/entitydef/mods/' + SALT + '/stowaway.decl', data: 'x' }]),
    /^The archive holds assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/stowaway\.decl, which mod\.json does not list\.$/);
  const outside = build();
  await refusedWith(env, rezip(outside, [...entriesFor(outside.modjson, files), { name: 'readme.txt', data: 'hi' }]), /^The archive holds readme\.txt, which is outside assets\/\.$/);
  const dotdot = build();
  await refusedWith(env, rezip(dotdot, [...entriesFor(dotdot.modjson, files), { name: 'assets/generated/../../evil.decl', data: 'x' }]),
    /^The file assets\/generated\/\.\.\/\.\.\/evil\.decl climbs out of its folder with "\." or "\.\."\.$/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/../x.decl', data: 'x' }] }), /climbs out of its folder/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/Pink.decl', data: 'x' }] }),
    /^The archive holds assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/Pink\.decl, whose path is not in lower case\.$/);
  const upper = build();
  await refusedWith(env, rezip(upper, [...entriesFor(upper.modjson, files), { name: 'assets/Generated/x.decl', data: 'x' }]), /whose path is not in lower case/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/run.exe', data: 'MZ' }] }), /run\.exe is a type of file a mod cannot carry\.$/);
  await refusedWith(env, build({ files: [{ request: 'virtualtextures/mods/othersal/pink_sq1.mega2', data: 'v' }] }), /is not one of this mod's own virtual-texture members\.$/);
  await refusedWith(env, build({ files: [{ request: 'virtualtextures/mods/' + SALT + '/pink_vmtr_sq1.mega2', data: 'v' }] }), /is not one of this mod's own virtual-texture members\.$/);
  await refusedWith(env, build({ files: [{ request: 'virtualtextures/mods/' + SALT + '/pink_sq17.mega2', data: 'v' }] }), /is not one of this mod's own virtual-texture members\.$/);
  await stored(env, build({ files: [{ request: 'virtualtextures/mods/' + SALT + '/pink_sq16.mega2', data: 'v' }] }));

  await refusedWith(env, build({ block: { build: 'e'.repeat(64) } }), /^The archive's mod\.json names another build than the one uploaded\.$/);
  await refusedWith(env, build({ block: { build: undefined } }), /^The archive's mod\.json has no build hash\.$/);
  await refusedWith(env, build({ salt: 'Bad-salt' }), /^The archive's mod\.json has no valid salt\.$/);
  await refusedWith(env, build({ salt: '1abcdefg' }), /^The archive's mod\.json has no valid salt\.$/);
  await refusedWith(env, build({ block: { format: 1 } }), /^The archive's mod\.json is not in format 2, the only one Snapmap\+ builds\.$/);
  await refusedWith(env, build({ block: { files: undefined } }), /^The archive's mod\.json has no file list\.$/);
  await refusedWith(env, build({ author: { requirements: { cvars: { 'bad name': '1' } } } }), /^The archive's mod\.json has requirements Snapmap\+ would not apply\.$/);
  await refusedWith(env, build({ author: { requirements: { commands: { activate: ['g_x 1; quit'] } } } }), /^The archive's mod\.json has requirements Snapmap\+ would not apply\.$/);
  await stored(env, build({ author: { requirements: { cvars: { g_fov: '90' }, commands: { activate: ['g_fov 90'], deactivate: ['g_fov 80'] } } } }));

  const missing = build();
  await refusedWith(env, rezip(missing, entriesFor(missing.modjson, files).slice(0, 2)),
    /^The archive lacks assets\/generated\/image\/mods\/k7pinkim\/pink\.bimage, which mod\.json lists\.$/);
  const resized = build();
  await refusedWith(env, rezip(resized, entriesFor(resized.modjson, [{ ...files[0], data: files[0].data + ' ' }, files[1]])),
    /^The size of assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/pink_imp\.decl does not match mod\.json\.$/);
  const noModjson = build();
  await refusedWith(env, rezip(noModjson, entriesFor(noModjson.modjson, files).slice(1)), /^The archive has no mod\.json\.$/);
  await refusedWith(env, rezip(build(), [{ name: 'mod.json', data: '{"snapmap-plus":' }]), /^The archive's mod\.json is not valid JSON\.$/);
  await refusedWith(env, rezip(build(), [{ name: 'mod.json', data: '{"name":"x"}' }]), /^The archive's mod\.json has no "snapmap-plus" block, so the mod was never built\.$/);
  await refusedWith(env, rezip(build(), [{ name: 'mod.json', data: Buffer.from([0x7b, 0xff, 0x7d]) }]), /^The archive's mod\.json is not UTF-8 text\.$/);
});

/* ---------------- 1.0 rules: no versions, the product's archive, scripts ---------------- */

test('no mod version anywhere: a build without one is stored, and one an author wrote is ignored', async () => {
  const env = await modsEnv();
  const plain = build();
  assert.ok(!Object.hasOwn(plain.doc, 'version'));
  const response = await put(env, plain);
  assert.equal(response.status, 201);
  const answer = await response.json();
  assert.deepEqual(Object.keys(answer).sort(), ['build', 'scripts', 'size']);
  const written = build({ author: { version: '2.0.0-beta' } });
  assert.equal((await put(env, written)).status, 201, 'a hand-written version is an unknown author key');
  assert.deepEqual(Object.keys(row(env, written.hash)).sort(), ['claims', 'created', 'salt', 'scripts', 'size']);
  const columns = env.registryStorage.sql.exec("SELECT name FROM pragma_table_info('mod_build')").toArray().map(r => r.name);
  assert.ok(!columns.includes('version'), 'the index keeps no version');
});

test('the Worker stores what the product writes after decisions 8, 9 and 10', async () => {
  const env = await modsEnv();
  /* The block keeps the folder's case; the archive holds the lower-cased request. */
  await stored(env, build({ files: [{ path: 'generated/decls/entityDef/mods/' + SALT + '/Pink_Imp.decl',
    request: 'generated/decls/entitydef/mods/' + SALT + '/pink_imp.decl', data: 'entityDef x {}\n' }] }));
  /* Decision 10: an install keeps every file, unchanged game files at their game paths included. */
  await stored(env, build({ files: [...defaultFiles(SALT), { request: 'generated/decls/entitydef/monster/imp.decl', data: 'entityDef monster/imp {}\n' }] }));
  /* Decision 9: string edits stay unprefixed beside the mod's own prefixed keys. */
  await stored(env, build({ author: { strings: { en: { box: 'Crate', [SALT + '_pink_name']: 'Pink Imp' } } } }));
  /* Every type the builder carries, .baas_ classes with an underscore among them. */
  await stored(env, build({ files: [{ request: 'generated/baas/mods/' + SALT + '/pink.baas_monster_48', data: 'b' },
    { request: 'generated/swf/mods/' + SALT + '/menu.bswf', data: 's' }, { request: 'mods/' + SALT + '/odd name (2)~$@+.decl', data: 'd' }] }));
  /* Requirements in every shape the builder takes: integers, booleans, padded lines. */
  await stored(env, build({ author: { requirements: { cvars: { g_fov: 90, r_skipFog: true, g_name: 'x y', g_neg: -3 },
    commands: { activate: ['  g_fov 90  '], deactivate: [] } } } }));
  /* Requirements of any size: 200 cvars with long names and values, 300 long lines. */
  {
    const cvars = {}, lines = [];
    for (let i = 0; i < 200; i++) cvars['sh_a_cvar_name_longer_than_sixty_four_characters_for_the_test_' + i] = 'v'.repeat(300);
    for (let i = 0; i < 300; i++) lines.push('echo ' + 'x'.repeat(400) + ' ' + i);
    await stored(env, build({ author: { requirements: { cvars, commands: { activate: lines, deactivate: lines } } } }));
  }
  /* The block keys the builder writes, a pointer with closure, the largest file count. */
  const pointer = { path: 'assets/generated/decls/entitydef/monster/imp.decl', sha256: 'c'.repeat(64), source: 'generated/decls/entitydef/monster/imp.decl',
    provides: { type: 'entityDef', name: 'monster/imp' }, needs: [], closure: true };
  await stored(env, build({ stock: [pointer], block: { cause: undefined, warnings: ['a warning'], shadows: [], edits: [], classes: { adds: 1 } } }));
});

test('the Worker refuses what the product would refuse when it reads the archive back', async () => {
  const env = await modsEnv();
  const file = defaultFiles(SALT)[0];
  await refusedWith(env, build({ block: { cause: 'it did not build' } }), /^The archive's mod\.json records a build that failed; fix the mod and build it again\.$/);
  await refusedWith(env, build({ block: { bundle: 'x' } }), /^The archive's mod\.json has a key Snapmap\+ does not write in its "snapmap-plus" block: bundle\.$/);
  await refusedWith(env, build({ block: { tree: 'nothex' } }), /has a "snapmap-plus" block Snapmap\+ did not write\.$/);
  await refusedWith(env, build({ author: { id: 'pink' } }), /^The archive's mod\.json uses "id", which Snapmap\+ no longer reads\.$/);
  await refusedWith(env, build({ author: { hud: { schema: 1 } } }), /uses "hud\.schema", which Snapmap\+ no longer reads\.$/);
  await refusedWith(env, build({ author: { files: [] } }), /^The archive's mod\.json has "files" outside its "snapmap-plus" block\.$/);
  await refusedWith(env, build({ author: { name: '   ' } }), /^The archive's mod\.json has no name\.$/);
  await refusedWith(env, build({ author: { strings: [] } }), /has "strings" that is not an object\.$/);
  await refusedWith(env, build({ author: { requirements: { cvars: { g_fov: 1.5 } } } }), /has requirements Snapmap\+ would not apply\.$/);
  await refusedWith(env, build({ author: { requirements: { cvars: { g_fov: '1', G_FOV: '2' } } } }), /has requirements Snapmap\+ would not apply\.$/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/empty.decl', data: '' }] }),
    /^The archive's mod\.json gives assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/empty\.decl no valid size\.$/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/a#b.decl', data: 'x' }] }), /has a character a mod path may not use\.$/);
  await refusedWith(env, build({ files: [{ request: 'decls/renderprogs/mods/' + SALT + '/x.decl', data: 'x' }] }), /is an engine file a mod may not ship\.$/);
  await refusedWith(env, build({ files: [{ request: 'generated/mods/' + SALT + '/vulkan_pipelines.bin', data: 'x' }] }), /is an engine file a mod may not ship\.$/);
  const twice = build({ files: [file, { ...file, path: file.request.toUpperCase() }] });
  await refusedWith(env, rezip(twice, entriesFor(twice.modjson, [file])), /^The archive's mod\.json lists .* twice\.$/);
  const extraKey = build();
  extraKey.doc['snapmap-plus'].files[0].mtime = 1;
  await refusedWith(env, rezip(extraKey, entriesFor(Buffer.from(JSON.stringify(extraKey.doc)), extraKey.files)), /^The archive's mod\.json lists a file entry Snapmap\+ did not write\.$/);
  const badPointer = { path: 'assets/generated/decls/entitydef/monster/imp.decl', sha256: 'c'.repeat(64), source: 'Generated/Decls/x.decl',
    provides: { type: 'entityDef', name: 'monster/imp' }, needs: [] };
  await refusedWith(env, build({ stock: [badPointer] }), /^The archive's mod\.json lists a pointer entry Snapmap\+ did not write\.$/);
  /* A long path is named whole. */
  const deepPath = 'generated/decls/entitydef/mods/' + SALT + '/' + 'deep/'.repeat(70) + 'x.exe';
  const deep = build({ files: [{ request: deepPath, data: 'x' }] });
  await refusedWith(env, deep, new RegExp('^The file assets/' + deepPath.replace(/[.]/g, '\\.') + ' is a type of file a mod cannot carry\\.$'));
  assert.equal(env.MODS.objects.size, 0);
});

/* A mod's scripts: Lua source under assets/mods/<salt>/scripts/. */
function scripted(scripts, extra = {}) {
  return build({ files: [...defaultFiles(SALT), ...scripts.map(([name, data]) => ({ request: 'mods/' + SALT + '/scripts/' + name, data }))],
    block: { scripts: { files: scripts.length } }, ...extra });
}

test('a build may carry Lua source scripts under its own mods/<salt>/scripts/', async () => {
  const env = await modsEnv();
  const source = 'api = 1\nlocal lib = require("lib/util")\non.spawn("ai/tyrant", function (e) lib.roar(e) end)\n';
  await stored(env, scripted([['main.lua', source], ['lib/util.lua', 'local M = {}\nfunction M.roar(e) end\nreturn M\n'],
    ['bom.lua', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('-- ünïcödé comment\n')])]]));
  /* No limit on a script's size, their number or their total (decision 26). */
  const mods = await modsModule;
  for (const gone of ['MAX_SCRIPT', 'MAX_SCRIPTS', 'MAX_SCRIPT_BYTES', 'MAX_FILES', 'MAX_FILE', 'MAX_MODJSON', 'MAX_CLAIM_BUILDS', 'MAX_ARCHIVE']) {
    assert.equal(mods[gone], undefined, gone);
  }
  await stored(env, scripted([['big.lua', Buffer.alloc(3 * MIB, 0x20)]]));
  await stored(env, scripted(Array.from({ length: 300 }, (_, i) => ['s' + i + '.lua', 'return ' + i + '\n'])));
  const listed = await put(env, scripted([['a.lua', 'return 1\n'], ['lib/b.lua', 'return 2\n']]));
  assert.equal((await listed.json()).scripts, 2);
  /* A multi-byte character split across chunks is still UTF-8. */
  const split = scripted([['split.lua', Buffer.from('-- \u{1F600} \u00e9\n'.repeat(5000))]]);
  const { ArchiveWalker, buildVerdict } = mods;
  for (const size of [1, 2, 3, 7]) {
    const walker = new ArchiveWalker(split.bytes.length);
    for (let at = 0; at < split.bytes.length; at += size) walker.push(new Uint8Array(split.bytes.subarray(at, at + size)));
    walker.finish();
    assert.equal(walker.error, null);
    assert.deepEqual(buildVerdict(split.hash, walker.entries, walker.modjson), { salt: SALT, scripts: 1 });
  }
});

test('the Worker refuses Lua bytecode, oversize scripts and scripts outside the salt folder', async () => {
  const env = await modsEnv();
  const where = 'assets\\/mods\\/k7pinkim\\/scripts\\/';
  await refusedWith(env, scripted([['main.lua', Buffer.concat([Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x54, 0x00]), Buffer.alloc(40, 1)])]]),
    new RegExp('^The script ' + where + 'main\\.lua is compiled Lua bytecode; a mod carries its scripts as source text\\.$'));
  await refusedWith(env, scripted([['lib/x.lua', Buffer.from([0x1b, 0x4c, 0x75, 0x61])]]), /^The script .*lib\/x\.lua is compiled Lua bytecode/);
  await refusedWith(env, scripted([['nul.lua', Buffer.from('return 1\0\n')]]), /^The script .*nul\.lua contains a NUL byte; a script must be plain text\.$/);
  await refusedWith(env, scripted([['latin.lua', Buffer.from([0x2d, 0x2d, 0xe9, 0x0a])]]), /^The script .*latin\.lua is not UTF-8 text\.$/);
  await refusedWith(env, scripted([['cut.lua', Buffer.from([0x2d, 0x2d, 0xe2, 0x82])]]), /^The script .*cut\.lua is not UTF-8 text\.$/);
  await refusedWith(env, scripted([['sur.lua', Buffer.from([0xed, 0xa0, 0x80])]]), /^The script .*sur\.lua is not UTF-8 text\.$/);
  /* The block's "scripts" member says what the archive carries, no more and no less. */
  await refusedWith(env, scripted([['main.lua', 'return 1\n']], { block: {} }), /^The archive's mod\.json does not describe the scripts the archive carries\.$/);
  await refusedWith(env, scripted([['main.lua', 'return 1\n']], { block: { scripts: { files: 2 } } }), /^The archive's mod\.json describes scripts the archive does not carry\.$/);
  await refusedWith(env, build({ block: { scripts: { files: 0 } } }), /^The archive's mod\.json describes scripts the archive does not carry\.$/);
  const outside = /is a script outside this mod's mods\/k7pinkim\/scripts\/ folder\.$/;
  for (const request of ['mods/othersal/scripts/main.lua', 'mods/' + SALT + '/main.lua', 'scripts/main.lua', 'generated/decls/mods/' + SALT + '/scripts/x.lua',
    'mods/' + SALT + '/scripts/.lua']) {
    await refusedWith(env, build({ files: [...defaultFiles(SALT), { request, data: 'return 1\n' }], block: { scripts: { files: 1 } } }), outside);
  }
  /* A script entry the block does not list is still a stowaway. */
  const plain = build();
  await refusedWith(env, rezip(plain, [...entriesFor(plain.modjson, plain.files), { name: 'assets/mods/' + SALT + '/scripts/extra.lua', data: 'return 1\n' }]),
    /^The archive holds assets\/mods\/k7pinkim\/scripts\/extra\.lua, which mod\.json does not list\.$/);
  assert.equal(env.MODS.objects.size, 0);
});

test('every refusal on every mod route is one plain sentence', async () => {
  const env = await modsEnv();
  const archive = build();
  await stored(env, archive);
  const hash = archive.hash;
  const requests = [
    putRequest(hash, archive.bytes, { 'Content-Type': 'text/plain' }),
    call('PUT', '/mods/build/' + hash, { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archive.bytes)); c.close(); } }), headers: { 'Content-Type': 'application/zip' } }),
    call('PUT', '/mods/build/' + 'b'.repeat(64), { body: archive.bytes, headers: { 'Content-Type': 'application/zip', 'Content-Length': String(95 * MIB + 1) } }),
    putRequest('c'.repeat(64), Buffer.from('tiny')),
    putRequest(hash.toUpperCase(), archive.bytes),
    call('GET', '/mods/build/' + 'f'.repeat(64)),
    call('DELETE', '/mods/build/' + hash),
    call('GET', '/mods/claim'),
    call('GET', '/mods/elsewhere'),
    call('POST', '/mods/admin/reset'),
    postJson('/mods/claim', { ref: '', builds: [hash] }),
    postJson('/mods/claim', { ref: 'a', builds: [] }),
    postJson('/mods/claim', { ref: 'a', builds: 'nope' }),
    postJson('/mods/claim', { ref: 'a', builds: ['xyz'] }),
    postJson('/mods/claim', { ref: 'a', builds: [hash], secret: 'short' }),
    postJson('/mods/claim', { ref: 'a', builds: ['d'.repeat(64)] }),
    postJson('/mods/claim', { ref: 'a', builds: [hash], secret: 'e'.repeat(64) }),
    call('POST', '/mods/claim', { body: '[1,2]', headers: { 'Content-Type': 'application/json' } }),
    call('POST', '/mods/claim', { body: 'x'.repeat(70000), headers: { 'Content-Type': 'application/json' } }),
    postJson('/mods/build/' + 'b'.repeat(64) + '/parts', { size: 3 }),
    call('PUT', '/mods/build/' + 'b'.repeat(64) + '/parts/1', { body: 'x', headers: { 'Content-Type': 'application/octet-stream', 'X-Build-Size': '200000000', 'Content-Length': '1' } }),
    call('PUT', '/mods/build/' + 'b'.repeat(64) + '/parts/1', { body: 'x', headers: { 'Content-Type': 'application/zip', 'X-Build-Size': '200000000', 'Content-Length': '1' } }),
    postJson('/mods/build/' + 'b'.repeat(64) + '/complete', { size: 200000000 }),
    call('GET', '/mods/build/' + 'b'.repeat(64) + '/parts'),
    postJson('/mods/release', { claim: 'nothex', secret: 'a'.repeat(64) }),
    postJson('/mods/release', { claim: 'a'.repeat(32), secret: 'short' }),
    postJson('/mods/release', { claim: 'a'.repeat(32), secret: 'a'.repeat(64) }),
  ];
  const statuses = [];
  for (const request of requests) {
    const response = await fetchWorker(env, request);
    statuses.push(response.status);
    assert.ok(response.status >= 400, request.method + ' ' + request.url);
    assertSentence((await response.json()).error, request.method + ' ' + request.url);
  }
  assert.deepEqual(statuses, [415, 411, 413, 422, 400, 404, 405, 405, 404, 404, 400, 400, 400, 400, 400, 409, 403, 400, 400, 400, 404, 415, 404, 405, 400, 400, 404]);
  const { claim, secret } = await (await fetchWorker(env, postJson('/mods/claim', { ref: 'item-5', builds: [hash] }))).json();
  const wrong = await fetchWorker(env, postJson('/mods/release', { claim, secret: 'f'.repeat(64) }));
  assert.equal(wrong.status, 403);
  assertSentence((await wrong.json()).error, 'wrong secret');
  env.MODS_BLOCKED = JSON.stringify([hash]);
  const blocked = await fetchWorker(env, call('GET', '/mods/build/' + hash));
  assert.equal(blocked.status, 451);
  assertSentence((await blocked.json()).error, 'takedown');
  env.MODS_BLOCKED = 'not json';
  const broken = await fetchWorker(env, call('GET', '/mods/build/' + hash));
  assert.equal(broken.status, 503);
  assertSentence((await broken.json()).error, 'unavailable');
  env.MODS_BLOCKED = '[]';
  env.MOD_REGISTRY = { idFromName: () => 'x', get: () => ({ buildServed: async () => { throw new Error('down'); } }) };
  const down = await fetchWorker(env, call('GET', '/mods/build/' + hash));
  assert.equal(down.status, 503);
  assertSentence((await down.json()).error, 'index down');
  const limitedEnv = await modsEnv();
  for (let i = 0; i < 64; i++) await fetchWorker(limitedEnv, postJson('/mods/claim', { ref: 'a', builds: ['d'.repeat(64)] }));
  const limited = await fetchWorker(limitedEnv, postJson('/mods/claim', { ref: 'a', builds: ['d'.repeat(64)] }));
  assert.equal(limited.status, 429);
  assertSentence((await limited.json()).error, 'rate limited');
});

test('archive PUT refuses wrong type, no length, oversize and malformed hashes before reading', async () => {
  const env = await modsEnv();
  const archive = build();
  assert.equal((await put(env, archive, { 'Content-Type': 'application/octet-stream' })).status, 415);
  const unlengthed = await fetchWorker(env, call('PUT', '/mods/build/' + archive.hash, {
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archive.bytes)); c.close(); } }),
    headers: { 'Content-Type': 'application/zip' } }));
  assert.equal(unlengthed.status, 411);
  const huge = await fetchWorker(env, call('PUT', '/mods/build/' + archive.hash, { body: archive.bytes, headers: {
    'Content-Type': 'application/zip', 'Content-Length': String(95 * MIB + 1) } }));
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { error: 'An archive over 95 MiB goes to the mod store in parts.' });
  assert.equal((await fetchWorker(env, putRequest(archive.hash.toUpperCase(), archive.bytes))).status, 400);
  assert.equal((await fetchWorker(env, putRequest('abc', archive.bytes))).status, 404);
  assert.equal((await fetchWorker(env, call('DELETE', '/mods/build/' + archive.hash))).status, 405);
  const { PART_SIZE } = await modsModule;
  assert.equal(PART_SIZE, 95 * MIB);
  assert.equal(env.MODS.objects.size, 0);
  assert.equal((await put(env, archive, { 'Content-Type': 'application/zip; charset=binary' })).status, 201);
});

test('the retired blob, bundle and missing routes are gone', async () => {
  const env = await modsEnv();
  const hash = 'a'.repeat(64);
  for (const request of [call('GET', '/mods/blob/' + hash), call('PUT', '/mods/blob/' + hash, { body: 'x' }), call('GET', '/mods/bundle/' + hash),
    call('PUT', '/mods/bundle/' + hash, { body: '{}' }), postJson('/mods/missing', { blobs: [hash] }), call('GET', '/mods/elsewhere')]) {
    assert.equal((await fetchWorker(env, request)).status, 404, request.method + ' ' + request.url);
  }
  const mods = await modsModule;
  for (const gone of ['manifestError', 'canonicalText', 'canonicalSource', 'logicalName', 'MAX_BLOB']) assert.equal(mods[gone], undefined, gone);
});

test('an unclaimed archive of another size is replaced only by an upload that validates; a claimed one never', async () => {
  const env = await modsEnv();
  const hash = sha(Buffer.from('contested'));
  const forged = build({ hash, salt: 'zzzzzzzz', files: [{ request: 'generated/decls/entitydef/mods/zzzzzzzz/x.decl', data: 'forged' }] });
  const real = build({ hash });
  await stored(env, forged);
  assert.equal(row(env, hash).salt, 'zzzzzzzz');
  const broken = damaged(real, b => b.writeUInt16LE(8, 8));
  assert.equal((await put(env, broken)).status, 422);
  assert.deepEqual(bytesOf(env, hash), forged.bytes, 'a refused upload leaves the stored archive');
  assert.equal(objectsFor(env, hash).length, 1, 'and stores nothing of its own');
  const forgedObject = objectOf(env, hash);
  assert.equal(row(env, hash).salt, 'zzzzzzzz');
  const replaced = await put(env, real);
  assert.equal(replaced.status, 201);
  assert.deepEqual(bytesOf(env, hash), real.bytes);
  assert.ok(!env.MODS.objects.has(forgedObject), 'the replaced archive is deleted');
  assert.equal(row(env, hash).salt, SALT);
  assert.equal(row(env, hash).size, real.bytes.length);

  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-1', builds: [hash] }))).status, 201);
  const later = await put(env, forged);
  assert.equal(later.status, 200);
  assert.deepEqual(await later.json(), { build: hash, size: real.bytes.length, scripts: 0 });
  assert.deepEqual(bytesOf(env, hash), real.bytes, 'a claimed archive is never replaced');
  assert.equal(objectsFor(env, hash).length, 1);
});

test('blocked hashes are refused with 451 on every route', async () => {
  const env = await modsEnv();
  const archive = build(), clean = build();
  await stored(env, clean);
  env.MODS_BLOCKED = JSON.stringify([archive.hash.toUpperCase(), clean.hash]);
  assert.equal((await put(env, archive)).status, 451);
  assert.equal((await fetchWorker(env, call('GET', '/mods/build/' + clean.hash))).status, 451);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/build/' + clean.hash))).status, 451);
  assert.equal((await put(env, clean)).status, 451);
  const claim = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-1', builds: [clean.hash] }));
  assert.equal(claim.status, 451);
  assert.deepEqual((await claim.json()).blocked, [clean.hash]);
  env.MODS_BLOCKED = '{"not":"a list"}';
  assert.equal((await fetchWorker(env, call('GET', '/mods/build/' + clean.hash))).status, 503);
});

/* ---------------- quotas ---------------- */

test('per-address limits exhaust with 429, use hashed names and leave other addresses alone', async () => {
  const env = await modsEnv();
  const archive = build();
  for (let i = 0; i < 64; i++) assert.notEqual((await put(env, archive)).status, 429, 'put ' + i);
  const limited = await put(env, archive);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('Retry-After'), /^\d+$/);
  const elsewhere = call('PUT', '/mods/build/' + archive.hash, { body: archive.bytes, headers: {
    'CF-Connecting-IP': '198.51.100.9', 'Content-Type': 'application/zip', 'Content-Length': String(archive.bytes.length) } });
  assert.equal((await fetchWorker(env, elsewhere)).status, 200);
  assert.ok(env.names.length > 0);
  for (const name of env.names) {
    assert.match(name, /^mods-address:[0-9a-f]{64}$/);
    assert.ok(!name.includes(ADDRESS));
  }
  const keyed = await modsEnv({ MODS_ADDRESS_KEY: 'local-test-key' });
  await fetchWorker(keyed, call('GET', '/mods/build/' + archive.hash));
  assert.notEqual(keyed.names[0], env.names[0]);

  const failing = await modsEnv();
  failing.WRITE_QUOTAS = { idFromName: () => 'x', get: () => ({ consumeMods: async () => { throw new Error('down'); } }) };
  assert.equal((await put(failing, archive)).status, 503);
  assert.equal((await fetchWorker(failing, postJson('/mods/claim', { ref: 'a', builds: [archive.hash] }))).status, 503);
  assert.equal((await fetchWorker(failing, call('GET', '/mods/build/' + archive.hash))).status, 404, 'reads fail open');
});

test('the byte quota refuses an upload that would exceed the hourly bytes', async () => {
  const env = await modsEnv();
  const { MOD_LIMITS } = await quotaModule;
  let first = true;
  const original = env.WRITE_QUOTAS.get;
  env.WRITE_QUOTAS.get = name => {
    const stub = original(name);
    if (first) { first = false; stub.consumeMods([['mod_bytes', MOD_LIMITS.mod_bytes - 4]]); }
    return stub;
  };
  const response = await put(env, build());
  assert.equal(response.status, 429);
  assert.equal(env.MODS.objects.size, 0);
});

test('mod quota admits each limit exactly and all-or-nothing across kinds', async () => {
  const { initializeQuota, consumeModQuota, MOD_LIMITS } = await quotaModule;
  assert.deepEqual({ ...MOD_LIMITS }, { mod_build_put: 64, mod_bytes: 4 * 1024 ** 3, mod_get: 20000, mod_claim: 64 });
  const storage = sqliteStorage();
  initializeQuota(storage);
  const hour = 3600000 * 10;
  for (const kind of ['mod_build_put', 'mod_claim', 'mod_get']) {
    for (let i = 0; i < MOD_LIMITS[kind]; i++) assert.equal(consumeModQuota(storage, [[kind, 1]], hour).allowed, true);
    assert.equal(consumeModQuota(storage, [[kind, 1]], hour + 3599999).allowed, false, kind);
    assert.equal(consumeModQuota(storage, [[kind, 1]], hour + 3600000).allowed, true, kind);
  }
  const fresh = sqliteStorage();
  initializeQuota(fresh);
  assert.equal(consumeModQuota(fresh, [['mod_build_put', 1], ['mod_bytes', MOD_LIMITS.mod_bytes]], hour).allowed, true);
  assert.deepEqual(consumeModQuota(fresh, [['mod_build_put', 1], ['mod_bytes', 1]], hour + 1), { allowed: false, kind: 'mod_bytes' });
  assert.equal(fresh.sql.exec("SELECT used FROM mod_quota WHERE kind = 'mod_build_put'").toArray()[0].used, 1, 'refusal spent nothing');
  for (const bad of [[], [['post', 1]], [['mod_get', 0]], [['mod_get', 1], ['mod_get', 1]], [['mod_get', 1.5]], [['mod_blob_put', 1]]]) {
    assert.throws(() => consumeModQuota(storage, bad, hour));
  }
});

test('addresses normalize to IPv4 or an IPv6 /64', async () => {
  const { normalizeAddress } = await modsModule;
  assert.equal(normalizeAddress('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeAddress('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(normalizeAddress('2001:DB8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(normalizeAddress('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(normalizeAddress('::ffff:198.51.100.4'), '198.51.100.4');
  for (const junk of [null, '', 'example', '1::2::3', '1:2:3:4:5:6:7:8:9']) assert.equal(normalizeAddress(junk), 'unknown');
});

test('a publish in parts counts as one upload, so a large publish is never stopped half way', async () => {
  const env = await modsEnv();
  for (let i = 0; i < 63; i++) assert.notEqual((await put(env, build({ files: [] }))).status, 429, 'put ' + i);
  const archive = largeBuild();
  const size = archive.bytes.length;
  assert.equal((await startParts(env, archive.hash, size)).status, 201, 'the 64th upload');
  assert.equal((await sendPart(env, archive.hash, size, 1, slice(archive.bytes, 1))).status, 200);
  assert.equal((await startParts(env, archive.hash, size)).status, 200, 'a resume counts nothing');
  assert.equal((await sendPart(env, archive.hash, size, 2, slice(archive.bytes, 2))).status, 200);
  assert.equal((await completeParts(env, archive.hash, size)).status, 201);
  assert.equal((await put(env, build({ files: [] }))).status, 429, 'the 65th upload this hour');
  const other = await modsEnv();
  assert.equal((await startParts(other, archive.hash, size)).status, 201);
  const { MOD_LIMITS } = await quotaModule;
  for (let i = 0; i < MOD_LIMITS.mod_build_put - 1; i++) await put(other, build({ files: [] }));
  assert.equal((await startParts(other, sha(Buffer.from('another')), size)).status, 429, 'a new upload in parts is an upload');
});

/* ---------------- claims, serving window, release and purge ---------------- */

function claims(env, hash) {
  return row(env, hash)?.claims;
}

test('claim, re-claim with the secret, and release with wrong and right secrets', async () => {
  const env = await modsEnv();
  const first = build(), second = build();
  await stored(env, first, second);
  const made = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', builds: [first.hash] }));
  assert.equal(made.status, 201);
  const { claim, secret } = await made.json();
  assert.match(claim, /^[0-9a-f]{32}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(claims(env, first.hash), 1);
  const kept = env.registryStorage.sql.exec('SELECT secret FROM mod_claim').toArray()[0].secret;
  assert.equal(kept, sha(Buffer.from(secret)), 'only the digest of the secret is kept');

  const other = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', builds: [first.hash] }));
  assert.equal(other.status, 201, 'a second claimant holds its own claim');
  assert.notEqual((await other.json()).claim, claim);
  assert.equal(claims(env, first.hash), 2);

  const again = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', builds: [second.hash, second.hash], secret }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { claim, secret });
  assert.equal(claims(env, first.hash), 1);
  assert.equal(claims(env, second.hash), 1);

  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', builds: [first.hash], secret: 'a'.repeat(64) }))).status, 403);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-42', builds: [first.hash], secret }))).status, 403);
  const unknown = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-43', builds: ['d'.repeat(64)] }));
  assert.equal(unknown.status, 409);
  assert.deepEqual(await unknown.json(), { error: 'The mod store does not hold every build the claim names; upload them again.', missing: ['d'.repeat(64)] });
  for (const body of [{ ref: '', builds: [first.hash] }, { ref: 'a', builds: [] },
    { ref: 'a', builds: [first.hash], secret: 'short' }, { ref: 'a', bundles: [first.hash] }]) {
    assert.equal((await fetchWorker(env, postJson('/mods/claim', body))).status, 400, JSON.stringify(body).slice(0, 80));
  }

  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret: 'b'.repeat(64) }))).status, 403);
  assert.equal(claims(env, second.hash), 1);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim: 'c'.repeat(32), secret }))).status, 404);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim: 'nothex', secret }))).status, 400);
  env.MODS.log.length = 0;
  const secondObject = objectOf(env, second.hash);
  const released = await fetchWorker(env, postJson('/mods/release', { claim, secret }));
  assert.equal(released.status, 204);
  assert.equal(claims(env, second.hash), undefined, 'its last release removes the build from the index');
  assert.deepEqual(env.MODS.log.filter(([op]) => op === 'delete'), [['delete', secondObject]], 'and its archive at once');
  assert.ok(!env.MODS.objects.has(secondObject));
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/build/' + second.hash))).status, 404);
  assert.equal(claims(env, first.hash), 1, 'a build another claim names stays');
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 404);
});

test('a re-claim that leaves a build out deletes it when no other claim names it', async () => {
  const env = await modsEnv();
  const first = build(), second = build();
  await stored(env, first, second);
  const { claim, secret } = await (await fetchWorker(env, postJson('/mods/claim', { ref: 'map-1', builds: [first.hash, second.hash] }))).json();
  const firstObject = objectOf(env, first.hash);
  const again = await fetchWorker(env, postJson('/mods/claim', { ref: 'map-1', builds: [second.hash], secret }));
  assert.deepEqual(await again.json(), { claim, secret });
  assert.ok(!env.MODS.objects.has(firstObject));
  assert.equal(row(env, first.hash), undefined);
  assert.equal(claims(env, second.hash), 1);
});

test('serving is gated by the claim once the one-hour upload window has passed', async () => {
  const env = await modsEnv();
  const first = build(), second = build();
  await stored(env, first, second);
  const get = hash => fetchWorker(env, call('GET', '/mods/build/' + hash));
  assert.equal((await get(first.hash)).status, 200, 'a fresh build serves unclaimed');

  env.clock.offset = 2 * HOUR;
  assert.equal((await get(first.hash)).status, 404);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/build/' + first.hash))).status, 404);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-7', builds: [second.hash] }))).status, 201);
  assert.equal((await get(second.hash)).status, 200, 'claimed past the hour');

  assert.equal((await put(env, first)).status, 200);
  assert.equal((await get(first.hash)).status, 200, 'a re-upload reopens the window');
});

test('purge deletes unclaimed builds past the hour and keeps claimed ones', async () => {
  const { purgeMods } = await modsModule;
  const env = await modsEnv();
  const first = build(), second = build();
  await stored(env, first, second);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-9', builds: [second.hash] }))).status, 201);
  assert.deepEqual(await purgeMods(env), { builds: 0, uploads: 0 }, 'nothing is purged inside the window');
  env.clock.offset = 2 * HOUR;
  env.MODS.log.length = 0;
  const firstObject = objectOf(env, first.hash);
  assert.deepEqual(await purgeMods(env), { builds: 1, uploads: 0 });
  assert.deepEqual(env.MODS.log.filter(([op]) => op === 'delete'), [['delete', firstObject]]);
  assert.deepEqual([...env.MODS.objects.keys()], [objectOf(env, second.hash)]);
  assert.equal(row(env, first.hash), undefined);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-10', builds: [first.hash] }))).status, 409, 'a purged build cannot be claimed');
  assert.deepEqual(await purgeMods(env), { builds: 0, uploads: 0 });
});

test('the registry drops the retired blob and bundle tables', async () => {
  const registry = await registryModule;
  const storage = sqliteStorage();
  for (const statement of ['CREATE TABLE mod_blob (hash TEXT PRIMARY KEY)', 'CREATE TABLE mod_bundle (hash TEXT PRIMARY KEY)',
    'CREATE TABLE mod_bundle_blob (bundle TEXT, blob TEXT)', 'CREATE TABLE mod_claim_bundle (claim TEXT, bundle TEXT)',
    'CREATE TABLE mod_claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
    "INSERT INTO mod_claim VALUES ('x', 'r', 's', 1, 1)"]) storage.sql.exec(statement);
  registry.initializeRegistry(storage);
  const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map(r => r.name);
  assert.deepEqual(tables, ['mod_build', 'mod_claim', 'mod_claim_build', 'mod_upload']);
  assert.equal(storage.sql.exec('SELECT count(*) AS n FROM mod_claim').toArray()[0].n, 0, 'claims of bundles go with them');
  registry.initializeRegistry(storage);
  assert.throws(() => registry.registerBuild(storage, 'a'.repeat(64), 10, 'Bad', 'build/' + 'a'.repeat(64), 0, 1));
  /* An index from before per-upload objects names each archive at build/<hash>. */
  const old = sqliteStorage();
  old.sql.exec('CREATE TABLE mod_build (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0)');
  old.sql.exec("INSERT INTO mod_build VALUES (?, 10, 'k7pinkim', 1, 1)", 'a'.repeat(64));
  registry.initializeRegistry(old);
  assert.deepEqual({ ...registry.buildRow(old, 'a'.repeat(64)) }, { size: 10, salt: 'k7pinkim', created: 1, claims: 1, object: 'build/' + 'a'.repeat(64), scripts: 0 });
});

/* ---------------- uploads in parts, no limits, the release race ---------------- */

function startParts(env, hash, size) {
  return fetchWorker(env, postJson('/mods/build/' + hash + '/parts', { size }));
}

function sendPart(env, hash, size, part, bytes) {
  return fetchWorker(env, call('PUT', '/mods/build/' + hash + '/parts/' + part, { body: bytes, headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'X-Build-Size': String(size) } }));
}

function completeParts(env, hash, size) {
  return fetchWorker(env, postJson('/mods/build/' + hash + '/complete', { size }));
}

/* A build larger than one part: one carried file a little over 95 MiB. */
function largeBuild(extra = {}) {
  return build({ files: [{ request: 'generated/image/mods/' + SALT + '/huge.bimage', data: Buffer.alloc(95 * MIB + 4096, 3) }], ...extra });
}

function slice(bytes, part) {
  return bytes.subarray((part - 1) * 95 * MIB, Math.min(bytes.length, part * 95 * MIB));
}

test('a build larger than one part goes up in parts, resumes without resending a part, and serves its bytes', async () => {
  const env = await modsEnv();
  const archive = largeBuild();
  const size = archive.bytes.length;
  assert.equal((await put(env, archive)).status, 413, 'one request takes at most one part');

  const started = await startParts(env, archive.hash, size);
  assert.equal(started.status, 201);
  assert.deepEqual(await started.json(), { build: archive.hash, size, partSize: 95 * MIB, parts: 2, have: [] });
  const wrong = await sendPart(env, archive.hash, size, 1, archive.bytes.subarray(0, 1000));
  assert.equal(wrong.status, 400, 'a part is exactly its place in the archive');
  const first = await sendPart(env, archive.hash, size, 1, slice(archive.bytes, 1));
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).have, [1]);
  const early = await completeParts(env, archive.hash, size);
  assert.equal(early.status, 409, 'complete waits for every part');
  assert.deepEqual((await early.json()).have, [1]);

  /* The connection dropped: starting again answers what the store holds. */
  const resumed = await startParts(env, archive.hash, size);
  assert.equal(resumed.status, 200);
  assert.deepEqual((await resumed.json()).have, [1]);
  assert.equal((await sendPart(env, archive.hash, size, 2, slice(archive.bytes, 2))).status, 200);
  assert.deepEqual(env.MODS.log.filter(([op]) => op === 'part').map(([, , n]) => n), [1, 2], 'no part was sent twice');
  assert.equal(objectOf(env, archive.hash), undefined, 'nothing is served before the archive is complete and checked');

  const done = await completeParts(env, archive.hash, size);
  assert.equal(done.status, 201, await done.clone().text());
  assert.deepEqual(await done.json(), { build: archive.hash, size, scripts: 0 });
  assert.equal(env.MODS.uploads.size, 0);
  assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM mod_upload').toArray()[0].n, 0);
  const got = await fetchWorker(env, call('GET', '/mods/build/' + archive.hash));
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Content-Length'), String(size));
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), sha(archive.bytes), 'byte for byte');

  const again = await startParts(env, archive.hash, size);
  assert.deepEqual(await again.json(), { build: archive.hash, size, scripts: 0, stored: true });
  assert.equal((await completeParts(env, archive.hash, size)).status, 200);
});

test('an archive in parts is checked by the same rules, and a refused one leaves nothing', async () => {
  const env = await modsEnv();
  const archive = damaged(largeBuild(), (b, a) => b.writeUInt32LE(a.cd - 1, a.end + 16));
  const size = archive.bytes.length;
  assert.equal((await startParts(env, archive.hash, size)).status, 201);
  for (const part of [1, 2]) assert.equal((await sendPart(env, archive.hash, size, part, slice(archive.bytes, part))).status, 200);
  const refused = await completeParts(env, archive.hash, size);
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error, "The archive's end record places its central directory wrongly.");
  assert.deepEqual(objectsFor(env, archive.hash), []);
  assert.equal(row(env, archive.hash), undefined);
  assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM mod_upload').toArray()[0].n, 0);

  const script = largeBuild({ files: [{ request: 'generated/image/mods/' + SALT + '/huge.bimage', data: Buffer.alloc(95 * MIB, 3) },
    { request: 'mods/' + SALT + '/scripts/main.lua', data: Buffer.from([0x1b, 0x4c, 0x75, 0x61, 1, 2]) }], block: { scripts: { files: 1 } } });
  const ssize = script.bytes.length;
  await startParts(env, script.hash, ssize);
  for (const part of [1, 2]) await sendPart(env, script.hash, ssize, part, slice(script.bytes, part));
  const bytecode = await completeParts(env, script.hash, ssize);
  assert.equal(bytecode.status, 422);
  assert.match((await bytecode.json()).error, /main\.lua is compiled Lua bytecode/);
  assert.deepEqual(objectsFor(env, script.hash), []);
});

test('an upload in parts nobody finishes is aborted and its parts deleted', async () => {
  const { purgeMods } = await modsModule;
  const env = await modsEnv();
  const archive = largeBuild();
  const size = archive.bytes.length;
  await startParts(env, archive.hash, size);
  await sendPart(env, archive.hash, size, 1, slice(archive.bytes, 1));
  assert.deepEqual(await purgeMods(env), { builds: 0, uploads: 0 }, 'a live upload stays');
  env.clock.offset = 25 * HOUR;
  assert.deepEqual(await purgeMods(env), { builds: 0, uploads: 1 });
  assert.equal(env.MODS.uploads.size, 0, 'the multipart upload is aborted');
  assert.equal((await sendPart(env, archive.hash, size, 2, slice(archive.bytes, 2))).status, 404);
  assert.equal((await completeParts(env, archive.hash, size)).status, 404);
  assert.equal((await startParts(env, archive.hash, size)).status, 201, 'it starts again from nothing');
});

test('a release racing an upload of the same build never leaves a claim on a missing archive', async () => {
  const env = await modsEnv();
  const archive = build();
  await stored(env, archive);
  const { claim, secret } = await (await fetchWorker(env, postJson('/mods/claim', { ref: 'item-race', builds: [archive.hash] }))).json();
  /* The release drops the build's row, then deletes its object. In between, another
   * publisher uploads the same build: it is stored and registered again. */
  const original = env.MODS.delete;
  let raced = false;
  env.MODS.delete = async keys => {
    if (!raced) {
      raced = true;
      assert.equal(row(env, archive.hash), undefined, 'the row is gone before the object');
      assert.equal((await put(env, archive)).status, 201);
    }
    return original.call(env.MODS, keys);
  };
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 204);
  assert.ok(raced);
  env.MODS.delete = original;
  const again = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-race-2', builds: [archive.hash] }));
  assert.equal(again.status, 201);
  const got = await fetchWorker(env, call('GET', '/mods/build/' + archive.hash));
  assert.equal(got.status, 200, 'the claimed build is served');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), archive.bytes);
  assert.deepEqual(objectsFor(env, archive.hash), [objectOf(env, archive.hash)]);
});

test('no limit on files per mod, builds per claim or mod.json size', async () => {
  const env = await modsEnv();
  const many = build({ files: Array.from({ length: 20000 }, (_, i) => ({ request: 'generated/decls/entitydef/mods/' + SALT + '/f' + i + '.decl', data: 'entityDef f' + i + ' {}\n' })), pretty: false });
  assert.ok(many.modjson.length > 1024 * 1024, 'mod.json is over the old 1 MiB');
  const response = await put(env, many);
  assert.equal(response.status, 201, await response.clone().text());
  const got = await fetchWorker(env, call('GET', '/mods/build/' + many.hash));
  assert.equal(sha(Buffer.from(await got.arrayBuffer())), sha(many.bytes));

  const builds = Array.from({ length: 600 }, () => build({ files: [] }));
  for (const [i, b] of builds.entries()) {
    assert.equal((await put(env, b, { 'CF-Connecting-IP': '198.51.' + (i >> 6) + '.' + (i & 63) })).status, 201);
  }
  const made = await fetchWorker(env, postJson('/mods/claim', { ref: 'a map naming 600 mods', builds: builds.map(b => b.hash) }));
  assert.equal(made.status, 201);
  const { claim, secret } = await made.json();
  assert.ok(builds.every(b => claims(env, b.hash) === 1));
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 204);
  assert.ok(builds.every(b => row(env, b.hash) === undefined && objectsFor(env, b.hash).length === 0));
  const long = await fetchWorker(env, postJson('/mods/claim', { ref: 'x'.repeat(500), builds: [many.hash] }));
  assert.equal(long.status, 201, 'a published item reference of any length');
});

/* A ZIP of `files` entries of `size` bytes each, generated a chunk at a time without
 * holding it: only one block of zeros exists. */
function* streamedArchive(hash, files, size) {
  const names = Array.from({ length: files }, (_, i) => 'assets/generated/image/mods/' + SALT + '/big' + i + '.bimage');
  const doc = { name: 'Large', 'snapmap-plus': { format: 2, salt: SALT, build: hash,
    files: names.map(n => ({ path: n, sha256: 'a'.repeat(64), size, provides: { type: 'image', name: n.slice(7) }, needs: [] })) } };
  const modjson = Buffer.from(JSON.stringify(doc));
  const entries = [{ name: 'mod.json', size: modjson.length, data: modjson }, ...names.map(name => ({ name, size }))];
  const block = new Uint8Array(4 * MIB);
  let offset = 0;
  const records = [];
  for (const e of entries) {
    const n = Buffer.from(e.name), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(e.size, 18); local.writeUInt32LE(e.size, 22); local.writeUInt16LE(n.length, 26);
    records.push({ n, size: e.size, offset });
    yield Buffer.concat([local, n]);
    offset += 30 + n.length;
    if (e.data) { yield e.data; offset += e.size; continue; }
    for (let left = e.size; left > 0; left -= block.length) yield block.subarray(0, Math.min(left, block.length));
    offset += e.size;
  }
  const cd = offset;
  for (const r of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(r.size, 20); central.writeUInt32LE(r.size, 24); central.writeUInt16LE(r.n.length, 28); central.writeUInt32LE(r.offset, 42);
    yield Buffer.concat([central, r.n]);
    offset += 46 + r.n.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(offset - cd, 12); end.writeUInt32LE(cd, 16);
  yield end;
}

test('a ZIP64 archive is stored, and the check reads one entry past 4 GiB and 70,000 entries', async () => {
  const env = await modsEnv();
  const z = zip64Archive(build());
  const stored64 = await put(env, z);
  assert.equal(stored64.status, 201, await stored64.clone().text());
  const got = await fetchWorker(env, call('GET', '/mods/build/' + z.hash));
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), z.bytes);

  const { ArchiveWalker, buildVerdict } = await modsModule;
  /* One entry of 4.5 GiB, streamed from a block that is never larger than 4 MiB. */
  const hash = sha(Buffer.from('huge entry'));
  const name = 'assets/generated/image/mods/' + SALT + '/huge.bimage', size = 4.5 * 1024 * MIB;
  const doc = { name: 'Huge', 'snapmap-plus': { format: 2, salt: SALT, build: hash,
    files: [{ path: name, sha256: 'a'.repeat(64), size, provides: { type: 'image', name: name.slice(7) }, needs: [] }] } };
  const modjson = Buffer.from(JSON.stringify(doc));
  function* stream() {
    const nm = Buffer.from('mod.json'), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(modjson.length, 18); local.writeUInt32LE(modjson.length, 22); local.writeUInt16LE(nm.length, 26);
    yield Buffer.concat([local, nm, modjson]);
    const hn = Buffer.from(name), local2 = Buffer.alloc(30), x = Buffer.alloc(20);
    local2.writeUInt32LE(0x04034b50, 0); local2.writeUInt16LE(45, 4); local2.writeUInt32LE(0xffffffff, 18); local2.writeUInt32LE(0xffffffff, 22);
    local2.writeUInt16LE(hn.length, 26); local2.writeUInt16LE(20, 28);
    x.writeUInt16LE(1, 0); x.writeUInt16LE(16, 2); x.writeBigUInt64LE(BigInt(size), 4); x.writeBigUInt64LE(BigInt(size), 12);
    yield Buffer.concat([local2, hn, x]);
    const block = new Uint8Array(4 * MIB);
    for (let left = size; left > 0; left -= block.length) yield block.subarray(0, Math.min(left, block.length));
    const off2 = 30 + nm.length + modjson.length, cd = off2 + 30 + hn.length + 20 + size;
    const c1 = Buffer.alloc(46), c2 = Buffer.alloc(46), cx = Buffer.alloc(20);
    c1.writeUInt32LE(0x02014b50, 0); c1.writeUInt32LE(modjson.length, 20); c1.writeUInt32LE(modjson.length, 24); c1.writeUInt16LE(nm.length, 28);
    c2.writeUInt32LE(0x02014b50, 0); c2.writeUInt32LE(0xffffffff, 20); c2.writeUInt32LE(0xffffffff, 24); c2.writeUInt16LE(hn.length, 28);
    c2.writeUInt16LE(20, 30); c2.writeUInt32LE(off2, 42);
    cx.writeUInt16LE(1, 0); cx.writeUInt16LE(16, 2); cx.writeBigUInt64LE(BigInt(size), 4); cx.writeBigUInt64LE(BigInt(size), 12);
    const central = Buffer.concat([c1, nm, c2, hn, cx]);
    yield central;
    const end64 = Buffer.alloc(56), loc = Buffer.alloc(20), end = Buffer.alloc(22), at64 = cd + central.length;
    end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4); end64.writeBigUInt64LE(2n, 24); end64.writeBigUInt64LE(2n, 32);
    end64.writeBigUInt64LE(BigInt(central.length), 40); end64.writeBigUInt64LE(BigInt(cd), 48);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(at64), 8); loc.writeUInt32LE(1, 16);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(0xffffffff, 16);
    yield Buffer.concat([end64, loc, end]);
  }
  let length = 0;
  for (const chunk of stream()) length += chunk.length;
  assert.ok(length > 4.5 * 1024 * MIB);
  const walker = new ArchiveWalker(length);
  for (const chunk of stream()) walker.push(chunk);
  walker.finish();
  assert.equal(walker.error, null);
  assert.deepEqual(buildVerdict(hash, walker.entries, walker.modjson), { salt: SALT, scripts: 0 });

  /* 70,000 entries: past what the classic end record counts. */
  const many = build({ files: Array.from({ length: 70000 }, (_, i) => ({ request: 'generated/decls/entitydef/mods/' + SALT + '/m' + i + '.decl', data: 'x' })), pretty: false });
  const z2 = zip64Archive(many);
  const w2 = new ArchiveWalker(z2.bytes.length);
  for (let at = 0; at < z2.bytes.length; at += 1 << 20) w2.push(new Uint8Array(z2.bytes.subarray(at, at + (1 << 20))));
  w2.finish();
  assert.equal(w2.error, null);
  assert.equal(w2.entries.length, 70001);
  assert.deepEqual(buildVerdict(many.hash, w2.entries, w2.modjson), { salt: SALT, scripts: 0 });
});

test('the streaming check reads a 1.2 GiB archive holding only its headers and mod.json', async () => {
  const { ArchiveWalker, buildVerdict } = await modsModule;
  const hash = sha(Buffer.from('large'));
  let length = 0;
  for (const chunk of streamedArchive(hash, 13, 95 * MIB)) length += chunk.length;
  assert.ok(length > 1.2 * 1024 * MIB, 'over 1.2 GiB: ' + length);
  const walker = new ArchiveWalker(length);
  const before = process.memoryUsage().arrayBuffers;
  let peak = 0;
  for (const chunk of streamedArchive(hash, 13, 95 * MIB)) {
    walker.push(chunk);
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - before);
  }
  walker.finish();
  assert.equal(walker.error, null);
  assert.deepEqual(buildVerdict(hash, walker.entries, walker.modjson), { salt: SALT, scripts: 0 });
  assert.ok(peak < 64 * MIB, 'the check held ' + peak + ' bytes');
});

/* ---------------- CORS, configuration and reset ---------------- */

test('mod routes keep the site CORS allowlist and need no Origin', async () => {
  const env = await modsEnv();
  const archive = build();
  const native = await put(env, archive);
  assert.equal(native.status, 201);
  assert.equal(native.headers.get('Access-Control-Allow-Origin'), null);
  const site = await fetchWorker(env, call('GET', '/mods/build/' + archive.hash, { headers: { Origin: 'https://www.snapmapplus.com' } }));
  assert.equal(site.headers.get('Access-Control-Allow-Origin'), 'https://www.snapmapplus.com');
  const refusal = await fetchWorker(env, call('GET', '/mods/build/' + 'f'.repeat(64), { headers: { Origin: 'https://www.snapmapplus.com' } }));
  assert.equal(refusal.status, 404);
  assert.equal(refusal.headers.get('Access-Control-Allow-Origin'), 'https://www.snapmapplus.com');
  const foreign = await fetchWorker(env, call('GET', '/mods/build/' + archive.hash, { headers: { Origin: 'https://evil.example' } }));
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  const unconfigured = await modsEnv();
  delete unconfigured.MODS;
  assert.equal((await fetchWorker(unconfigured, call('GET', '/mods/build/' + archive.hash))).status, 503);
});

test('the maintainer reset route is hidden without the secret and empties the store with it', async () => {
  const env = await modsEnv();
  const first = build(), second = build();
  await stored(env, first, second);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-3', builds: [first.hash] }))).status, 201);
  await env.MODS.put('blob/' + 'a'.repeat(64), new Uint8Array([1]));
  await env.MODS.put('bundle/' + 'b'.repeat(64), new Uint8Array([2]));
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/reset'))).status, 404, 'no secret configured');
  env.MODS_ADMIN_TOKEN = 'correct horse battery staple\n';
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/reset'))).status, 403);
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/reset', { headers: { Authorization: 'Bearer nope' } }))).status, 403);
  assert.equal((await fetchWorker(env, call('GET', '/mods/admin/reset'))).status, 405);
  assert.equal(env.MODS.objects.size, 4);
  const response = await fetchWorker(env, call('POST', '/mods/admin/reset', { headers: { Authorization: 'Bearer correct horse battery staple' } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: { builds: 2, other: 2 }, index: { mod_claim_build: 1, mod_claim: 1, mod_build: 2, mod_upload: 0 } });
  assert.equal(env.MODS.objects.size, 0);
  for (const table of ['mod_build', 'mod_claim', 'mod_claim_build', 'mod_upload']) {
    assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM ' + table).toArray()[0].n, 0, table);
  }
  assert.equal((await fetchWorker(env, call('GET', '/mods/build/' + first.hash))).status, 404);
});

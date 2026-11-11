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
  const log = [];
  const meta = (key, o) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded, httpEtag: '"x"', httpMetadata: o.httpMetadata });
  return {
    objects, log,
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
          registerBuild: async (hash, size, salt) => registry.registerBuild(storage, hash, size, salt, clock.now()),
          touchBuild: async hash => registry.touchBuild(storage, hash, clock.now()),
          buildServed: async hash => registry.buildServed(storage, hash, clock.now()),
          claim: async request => registry.claimBuilds(storage, request, clock.now()),
          release: async (id, hash) => registry.releaseClaim(storage, id, hash),
          purgeBuilds: async limit => registry.purgeBuilds(storage, clock.now(), limit),
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
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
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

function entriesFor(modjson, files) {
  return [{ name: 'mod.json', data: modjson }, ...files.map(f => ({ name: 'assets/' + f.request, data: f.data }))];
}

/* A build of a mod with the given carried files ({request, data}) and pointers, its
 * mod.json as the product writes it (author part, then the "snapmap-plus" block). The
 * Worker never recomputes the canonical hash (the client does), so any fresh hash names it. */
function build({ salt = SALT, files = defaultFiles(salt), stock = [], hash = sha(Buffer.from('build-' + (++counter))), block = {}, author = {}, pretty = true } = {}) {
  const listed = files.map(f => ({ path: 'assets/' + f.request, sha256: sha(Buffer.from(f.data)), size: Buffer.from(f.data).length,
    provides: { type: 'entityDef', name: f.request }, needs: [] }));
  const modBlock = { format: 2, salt, rules: 8, built: 1794000000, tree: 'a'.repeat(64), build: hash, classes: { adds: files.length },
    editor: [], registries: {}, files: listed, ...(stock.length ? { stock } : {}), ...block };
  const doc = { name: 'Pink Imp', version: '1.0.0', description: 'A pinker imp.', ...author, 'snapmap-plus': modBlock };
  const modjson = Buffer.from(pretty ? JSON.stringify(doc, null, 2) + '\n' : JSON.stringify(doc), 'utf8');
  return { hash, modjson, doc, files, ...zip(entriesFor(modjson, files)) };
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
  return env.registryStorage.sql.exec('SELECT size, salt, created, claims FROM mod_build WHERE hash = ?', hash).toArray()[0];
}

/* ---------------- upload and serving ---------------- */

test('an archive PUT creates the build, a re-PUT is idempotent, GET and HEAD serve it', async () => {
  const env = await modsEnv();
  const archive = build();
  const created = await put(env, archive);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { build: archive.hash, size: archive.bytes.length });
  assert.deepEqual([...env.MODS.objects.keys()], ['build/' + archive.hash]);
  assert.deepEqual(Buffer.from(env.MODS.objects.get('build/' + archive.hash).bytes), archive.bytes);
  assert.equal(row(env, archive.hash).salt, SALT);
  assert.equal(row(env, archive.hash).size, archive.bytes.length);

  const again = await put(env, archive);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { build: archive.hash, size: archive.bytes.length });
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
  }
  const head = await fetchWorker(env, call('HEAD', '/mods/build/' + archive.hash));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetchWorker(env, call('GET', '/mods/build/' + 'f'.repeat(64)))).status, 404);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/build/' + 'f'.repeat(64)))).status, 404);
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
  assert.equal((await refused.json()).error, 'the archive holds a file mod.json does not list: assets/generated/decls/entitydef/monster/imp.decl');
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
    assert.deepEqual(buildVerdict(archive.hash, walker.entries, walker.modjson), { salt: SALT });
  }
});

/* Each damaged archive is refused with 422 and its cause, and nothing is stored. */
async function refusedWith(env, archive, pattern, status = 422) {
  const response = await put(env, archive);
  const text = await response.text();
  assert.equal(response.status, status, pattern + ': ' + text);
  assert.match(JSON.parse(text).error, pattern);
  assert.ok(!env.MODS.objects.has('build/' + archive.hash), 'stored ' + pattern);
  assert.equal(row(env, archive.hash), undefined);
}

function damaged(archive, edit) {
  const bytes = Buffer.from(archive.bytes);
  edit(bytes, archive);
  return { ...archive, bytes };
}

test('archive PUT refuses every structural fault of the ZIP', async () => {
  const env = await modsEnv();
  await refusedWith(env, { hash: sha(Buffer.from('x')), bytes: Buffer.from('this is not a zip archive at all') }, /^not a ZIP archive$/);
  await refusedWith(env, damaged(build(), b => b.writeUInt32LE(0xffffffff, 18)), /^a ZIP64 archive$/);
  const g64 = build();
  await refusedWith(env, { hash: g64.hash, ...zip(entriesFor(g64.modjson, g64.files), { zip64End: true }) }, /^a ZIP64 archive$/);
  const gx = build({ files: [] });
  const zip64Extra = Buffer.alloc(20); zip64Extra.writeUInt16LE(0x0001, 0); zip64Extra.writeUInt16LE(16, 2);
  await refusedWith(env, rezip(gx, [{ name: 'mod.json', data: gx.modjson, extra: zip64Extra }]), /^a ZIP64 archive$/);
  const gc = build({ files: [] });
  await refusedWith(env, rezip(gc, [{ name: 'mod.json', data: gc.modjson, method: 8 }]), /^a compressed entry; the archive must be stored$/);
  await refusedWith(env, damaged(build(), b => b.writeUInt16LE(0x0001, 6)), /^an encrypted entry$/);
  await refusedWith(env, damaged(build(), b => b.writeUInt16LE(0x0008, 6)), /^an entry without its sizes in the local header$/);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt32LE(0, a.cd + 16)), /^the central directory disagrees with the entry mod\.json$/);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt16LE(1, a.end + 8)), /^the end record counts the entries wrongly$/);
  await refusedWith(env, damaged(build(), (b, a) => b.writeUInt32LE(a.cd - 1, a.end + 16)), /^the end record places the central directory wrongly$/);
  const gt = build();
  await refusedWith(env, { hash: gt.hash, ...zip(entriesFor(gt.modjson, gt.files), { after: Buffer.from('trailing') }) }, /^bytes after the end record$/);
  const gb = build();
  await refusedWith(env, { hash: gb.hash, ...zip(entriesFor(gb.modjson, gb.files), { before: Buffer.from('MZ') }) }, /^not a ZIP archive$/);
  const gw = build();
  await refusedWith(env, { hash: gw.hash, ...zip(entriesFor(gw.modjson, gw.files), { between: Buffer.from('junk') }) }, /^unexpected bytes after an entry$/);
  const gd = build({ files: [] });
  await refusedWith(env, rezip(gd, [{ name: 'mod.json', data: gd.modjson }, { name: 'mod.json', data: gd.modjson }]), /^two entries named mod\.json$/);
  const big = build({ files: [] });
  await refusedWith(env, rezip(big, [{ name: 'mod.json', data: Buffer.alloc(1024 * 1024 + 1, 32) }]), /^mod\.json is larger than 1 MiB$/);
  const truncated = build();
  await refusedWith(env, { hash: truncated.hash, bytes: truncated.bytes.subarray(0, truncated.cd) }, /^the archive ends before its central directory$/);
  assert.equal(env.MODS.objects.size, 0);
});

test('archive PUT refuses a mod.json or entries that do not describe the build', async () => {
  const env = await modsEnv();
  const files = defaultFiles(SALT);

  const extra = build();
  await refusedWith(env, rezip(extra, [...entriesFor(extra.modjson, files), { name: 'assets/generated/decls/entitydef/mods/' + SALT + '/stowaway.decl', data: 'x' }]),
    /^the archive holds a file mod\.json does not list: assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/stowaway\.decl$/);
  const outside = build();
  await refusedWith(env, rezip(outside, [...entriesFor(outside.modjson, files), { name: 'readme.txt', data: 'hi' }]), /^the archive holds an entry outside assets\/: readme\.txt$/);
  const dotdot = build();
  await refusedWith(env, rezip(dotdot, [...entriesFor(dotdot.modjson, files), { name: 'assets/generated/../../evil.decl', data: 'x' }]),
    /^path traversal: assets\/generated\/\.\.\/\.\.\/evil\.decl$/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/../x.decl', data: 'x' }] }), /^path traversal/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/Pink.decl', data: 'x' }] }),
    /^request path is not lowercase: assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/Pink\.decl$/);
  const upper = build();
  await refusedWith(env, rezip(upper, [...entriesFor(upper.modjson, files), { name: 'assets/Generated/x.decl', data: 'x' }]), /^request path is not lowercase/);
  await refusedWith(env, build({ files: [{ request: 'generated/decls/entitydef/mods/' + SALT + '/run.exe', data: 'MZ' }] }), /^extension not allowed: /);
  await refusedWith(env, build({ files: [{ request: 'virtualtextures/mods/othersal/pink_sq1.mega2', data: 'v' }] }), /^extension not allowed/);
  await refusedWith(env, build({ files: [{ request: 'virtualtextures/mods/' + SALT + '/pink_vmtr_sq1.mega2', data: 'v' }] }), /^extension not allowed/);
  await refusedWith(env, build({ files: [{ request: 'virtualtextures/mods/' + SALT + '/pink_sq17.mega2', data: 'v' }] }), /^extension not allowed/);
  await stored(env, build({ files: [{ request: 'virtualtextures/mods/' + SALT + '/pink_sq16.mega2', data: 'v' }] }));

  await refusedWith(env, build({ block: { build: 'e'.repeat(64) } }), /^mod\.json build does not match the path$/);
  await refusedWith(env, build({ block: { build: undefined } }), /^mod\.json has no build hash$/);
  await refusedWith(env, build({ salt: 'Bad-salt' }), /^mod\.json has no valid salt$/);
  await refusedWith(env, build({ salt: '1abcdefg' }), /^mod\.json has no valid salt$/);
  await refusedWith(env, build({ block: { format: 1 } }), /^mod\.json is not format 2$/);
  await refusedWith(env, build({ block: { files: undefined } }), /^mod\.json has no file list$/);
  await refusedWith(env, build({ author: { requirements: { cvars: { 'bad name': '1' } } } }), /^bad requirements$/);
  await refusedWith(env, build({ author: { requirements: { commands: { activate: ['g_x 1; quit'] } } } }), /^bad requirements$/);
  await stored(env, build({ author: { requirements: { cvars: { g_fov: '90' }, commands: { activate: ['g_fov 90'], deactivate: ['g_fov 80'] } } } }));

  const missing = build();
  await refusedWith(env, rezip(missing, entriesFor(missing.modjson, files).slice(0, 2)),
    /^a file mod\.json lists is not in the archive: assets\/generated\/image\/mods\/k7pinkim\/pink\.bimage$/);
  const resized = build();
  await refusedWith(env, rezip(resized, entriesFor(resized.modjson, [{ ...files[0], data: files[0].data + ' ' }, files[1]])),
    /^the size of assets\/generated\/decls\/entitydef\/mods\/k7pinkim\/pink_imp\.decl does not match mod\.json$/);
  const noModjson = build();
  await refusedWith(env, rezip(noModjson, entriesFor(noModjson.modjson, files).slice(1)), /^the archive has no mod\.json$/);
  await refusedWith(env, rezip(build(), [{ name: 'mod.json', data: '{"snapmap-plus":' }]), /^mod\.json is not JSON$/);
  await refusedWith(env, rezip(build(), [{ name: 'mod.json', data: '{"name":"x"}' }]), /^mod\.json has no "snapmap-plus" block$/);
  await refusedWith(env, rezip(build(), [{ name: 'mod.json', data: Buffer.from([0x7b, 0xff, 0x7d]) }]), /^mod\.json is not UTF-8$/);
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
    'Content-Type': 'application/zip', 'Content-Length': String(96 * MIB + 1) } }));
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { error: 'the archive is over 96 MiB' });
  assert.equal((await fetchWorker(env, putRequest(archive.hash.toUpperCase(), archive.bytes))).status, 400);
  assert.equal((await fetchWorker(env, putRequest('abc', archive.bytes))).status, 404);
  assert.equal((await fetchWorker(env, call('DELETE', '/mods/build/' + archive.hash))).status, 405);
  const { MAX_ARCHIVE } = await modsModule;
  assert.equal(MAX_ARCHIVE, 96 * MIB);
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
  assert.deepEqual(Buffer.from(env.MODS.objects.get('build/' + hash).bytes), forged.bytes, 'a refused upload leaves the stored archive');
  assert.equal(row(env, hash).salt, 'zzzzzzzz');
  const replaced = await put(env, real);
  assert.equal(replaced.status, 201);
  assert.deepEqual(Buffer.from(env.MODS.objects.get('build/' + hash).bytes), real.bytes);
  assert.equal(row(env, hash).salt, SALT);
  assert.equal(row(env, hash).size, real.bytes.length);

  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-1', builds: [hash] }))).status, 201);
  const later = await put(env, forged);
  assert.equal(later.status, 200);
  assert.deepEqual(await later.json(), { build: hash, size: real.bytes.length });
  assert.deepEqual(Buffer.from(env.MODS.objects.get('build/' + hash).bytes), real.bytes, 'a claimed archive is never replaced');
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
  assert.deepEqual(await unknown.json(), { error: 'unknown builds', missing: ['d'.repeat(64)], missingCount: 1 });
  for (const body of [{ ref: '', builds: [first.hash] }, { ref: 'x'.repeat(65), builds: [first.hash] }, { ref: 'a', builds: [] },
    { ref: 'a', builds: [first.hash], secret: 'short' }, { ref: 'a', builds: Array(257).fill(first.hash) }, { ref: 'a', bundles: [first.hash] }]) {
    assert.equal((await fetchWorker(env, postJson('/mods/claim', body))).status, 400, JSON.stringify(body).slice(0, 80));
  }

  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret: 'b'.repeat(64) }))).status, 403);
  assert.equal(claims(env, second.hash), 1);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim: 'c'.repeat(32), secret }))).status, 404);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim: 'nothex', secret }))).status, 400);
  env.MODS.log.length = 0;
  const released = await fetchWorker(env, postJson('/mods/release', { claim, secret }));
  assert.equal(released.status, 204);
  assert.equal(claims(env, second.hash), undefined, 'its last release removes the build from the index');
  assert.deepEqual(env.MODS.log.filter(([op]) => op === 'delete'), [['delete', 'build/' + second.hash]], 'and its archive at once');
  assert.ok(!env.MODS.objects.has('build/' + second.hash));
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/build/' + second.hash))).status, 404);
  assert.equal(claims(env, first.hash), 1, 'a build another claim names stays');
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 404);
});

test('a re-claim that leaves a build out deletes it when no other claim names it', async () => {
  const env = await modsEnv();
  const first = build(), second = build();
  await stored(env, first, second);
  const { claim, secret } = await (await fetchWorker(env, postJson('/mods/claim', { ref: 'map-1', builds: [first.hash, second.hash] }))).json();
  const again = await fetchWorker(env, postJson('/mods/claim', { ref: 'map-1', builds: [second.hash], secret }));
  assert.deepEqual(await again.json(), { claim, secret });
  assert.ok(!env.MODS.objects.has('build/' + first.hash));
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
  assert.deepEqual(await purgeMods(env), { builds: 0 }, 'nothing is purged inside the window');
  env.clock.offset = 2 * HOUR;
  env.MODS.log.length = 0;
  assert.deepEqual(await purgeMods(env), { builds: 1 });
  assert.deepEqual(env.MODS.log.filter(([op]) => op === 'delete'), [['delete', 'build/' + first.hash]]);
  assert.deepEqual([...env.MODS.objects.keys()], ['build/' + second.hash]);
  assert.equal(row(env, first.hash), undefined);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-10', builds: [first.hash] }))).status, 409, 'a purged build cannot be claimed');
  assert.deepEqual(await purgeMods(env), { builds: 0 });
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
  assert.deepEqual(tables, ['mod_build', 'mod_claim', 'mod_claim_build']);
  assert.equal(storage.sql.exec('SELECT count(*) AS n FROM mod_claim').toArray()[0].n, 0, 'claims of bundles go with them');
  registry.initializeRegistry(storage);
  assert.throws(() => registry.registerBuild(storage, 'a'.repeat(64), 10, 'Bad', 1));
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
  assert.deepEqual(await response.json(), { deleted: { builds: 2, other: 2 }, index: { mod_claim_build: 1, mod_claim: 1, mod_build: 2 } });
  assert.equal(env.MODS.objects.size, 0);
  for (const table of ['mod_build', 'mod_claim', 'mod_claim_build']) {
    assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM ' + table).toArray()[0].n, 0, table);
  }
  assert.equal((await fetchWorker(env, call('GET', '/mods/build/' + first.hash))).status, 404);
});

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

if (!crypto.DigestStream) {
  crypto.DigestStream = class DigestStream extends WritableStream {
    constructor() {
      const hash = createHash('sha256');
      let resolve, reject;
      const digest = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      digest.catch(() => {});
      super({
        write(chunk) { hash.update(chunk); },
        close() { const out = hash.digest(); resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)); },
        abort(reason) { reject(reason); },
      });
      this.digest = digest;
    }
  };
}
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

function memoryBucket() {
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
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
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
          missing: async hashes => registry.missingBlobs(storage, hashes),
          noteBlob: async (hash, size) => registry.noteBlob(storage, hash, size, clock.now()),
          registerBundle: async (hash, files) => registry.registerBundle(storage, hash, files, clock.now()),
          bundleServed: async hash => registry.bundleServed(storage, hash, clock.now()),
          blobClaimed: async hash => registry.blobClaimed(storage, hash),
          claim: async request => registry.claimBundles(storage, request, clock.now()),
          release: async (id, hash) => registry.releaseClaim(storage, id, hash),
          purgeBundles: async limit => registry.purgeBundles(storage, clock.now(), limit),
          purgeBlobs: async limit => registry.purgeBlobs(storage, clock.now(), limit),
          reset: async () => registry.resetRegistry(storage),
          finishBlobs: async hashes => registry.finishBlobs(storage, hashes),
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

function putBlobRequest(bytes, hash = sha(bytes), headers = {}) {
  return call('PUT', '/mods/blob/' + hash, { body: bytes, headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), ...headers } });
}

function postJson(route, value, headers = {}) {
  return call('POST', route, { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json', ...headers } });
}

/* Independent canonicalizer: sorted keys at every level, files sorted by path, no whitespace. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function bundleOf(manifest) {
  const copy = { ...manifest, files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1)) };
  delete copy.bundle;
  const text = canonical(copy);
  return { manifest: copy, text, hash: sha(Buffer.from(text, 'utf8')) };
}

function declFile(id, stem, bytes) {
  const request = 'generated/decls/entitydef/mods/' + id + '/' + stem + '.decl';
  return { path: 'assets/' + request, request, blob: sha(bytes), size: bytes.byteLength,
    provides: { type: 'entityDef', name: 'mods/' + id + '/' + stem } };
}

function sampleManifest(files, extra = {}) {
  return { format: 1, id: 'alex.pink-imp', build: 1, version: '1.0.0', name: 'Pink Imp', author: 'alex', files, ...extra };
}

async function storeBlobs(env, ...buffers) {
  for (const bytes of buffers) {
    const response = await fetchWorker(env, putBlobRequest(bytes));
    assert.ok(response.status === 201 || response.status === 200, 'blob store ' + response.status);
  }
}

function putBundleRequest(text, hash) {
  return call('PUT', '/mods/bundle/' + hash, { body: text, headers: { 'Content-Type': 'application/json' } });
}

const blobA = Buffer.from('entityDef pink_imp { inherit = "monster/imp"; }\n');
const blobB = Buffer.from('entityDef pink_imp_boss { inherit = "mods/alex.pink-imp/pink_imp"; }\n');
const blobC = Buffer.from('third file');

/* ---------------- canonical form ---------------- */

test('canonical text matches a hand-written golden string and its hash', async () => {
  const { canonicalText } = await modsModule;
  const manifest = {
    name: 'Pink Imp', id: 'alex.pink-imp', format: 1, build: 2147483647, version: '1.0.0', bundle: 'ignored',
    requirements: { cvars: { g_useResourceBlackList: '0' } },
    files: [
      { size: 2, request: 'b.json', path: 'assets/b.json', blob: 'b'.repeat(64), provides: { type: 'file', name: 'b.json' } },
      { size: 1, request: 'a.json', path: 'assets/a.json', blob: 'a'.repeat(64), provides: { name: 'a.json', type: 'file' } },
    ],
  };
  const golden = '{"build":2147483647,"files":[{"blob":"' + 'a'.repeat(64) + '","path":"assets/a.json","provides":{"name":"a.json","type":"file"},' +
    '"request":"a.json","size":1},{"blob":"' + 'b'.repeat(64) + '","path":"assets/b.json","provides":{"name":"b.json","type":"file"},' +
    '"request":"b.json","size":2}],"format":1,"id":"alex.pink-imp","name":"Pink Imp",' +
    '"requirements":{"cvars":{"g_useResourceBlackList":"0"}},"version":"1.0.0"}';
  assert.equal(canonicalText(manifest), golden);
  assert.equal(canonicalText(manifest, true), golden.replace('"build":2147483647,', '"build":2147483647,"bundle":"ignored",'));
  assert.equal(bundleOf(manifest).text, golden);
});

/* ---------------- blobs ---------------- */

test('blob PUT creates, re-PUT is idempotent, GET and HEAD serve immutable bytes', async () => {
  const env = await modsEnv();
  const hash = sha(blobA);
  const created = await fetchWorker(env, putBlobRequest(blobA));
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { blob: hash, size: blobA.byteLength });
  assert.deepEqual([...env.MODS.objects.keys()], ['blob/' + hash]);
  const again = await fetchWorker(env, putBlobRequest(blobA));
  assert.equal(again.status, 200);
  assert.equal(env.MODS.log.filter(([op]) => op === 'put').length, 1);

  const got = await fetchWorker(env, call('GET', '/mods/blob/' + hash));
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), blobA);
  for (const response of [got, await fetchWorker(env, call('HEAD', '/mods/blob/' + hash))]) {
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('ETag'), '"' + hash + '"');
    assert.equal(response.headers.get('Content-Length'), String(blobA.byteLength));
  }
  const head = await fetchWorker(env, call('HEAD', '/mods/blob/' + hash));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + 'f'.repeat(64)))).status, 404);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/blob/' + 'f'.repeat(64)))).status, 404);
});

test('blob PUT refuses hash mismatch, oversize, wrong type, missing length and malformed hashes', async () => {
  const env = await modsEnv();
  const wrong = sha(Buffer.from('other bytes'));
  const mismatch = await fetchWorker(env, putBlobRequest(blobA, wrong));
  assert.equal(mismatch.status, 422);
  assert.equal(env.MODS.objects.size, 0);
  assert.deepEqual(env.registryStorage.sql.exec('SELECT hash FROM mod_blob').toArray(), []);

  const huge = await fetchWorker(env, call('PUT', '/mods/blob/' + sha(blobA), { body: blobA, headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(64 * MIB + 1) } }));
  assert.equal(huge.status, 413);
  const typed = await fetchWorker(env, putBlobRequest(blobA, sha(blobA), { 'Content-Type': 'text/plain' }));
  assert.equal(typed.status, 415);
  const unlengthed = await fetchWorker(env, call('PUT', '/mods/blob/' + sha(blobA), {
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(blobA)); c.close(); } }),
    headers: { 'Content-Type': 'application/octet-stream' } }));
  assert.equal(unlengthed.status, 411);
  assert.equal((await fetchWorker(env, putBlobRequest(blobA, sha(blobA).toUpperCase()))).status, 400);
  assert.equal((await fetchWorker(env, call('PUT', '/mods/blob/abc', { body: blobA }))).status, 404);
  assert.equal((await fetchWorker(env, call('DELETE', '/mods/blob/' + sha(blobA)))).status, 405);
  assert.equal((await fetchWorker(env, call('GET', '/mods/elsewhere'))).status, 404);
  assert.equal(env.MODS.objects.size, 0);

  const empty = new Uint8Array(0);
  assert.equal((await fetchWorker(env, putBlobRequest(empty))).status, 201);
  assert.equal(env.MODS.objects.get('blob/' + sha(empty)).bytes.byteLength, 0);
});

test('a storage layer that ignored the checksum still never keeps mismatched bytes', async () => {
  const env = await modsEnv();
  const put = env.MODS.put;
  env.MODS.put = (key, value, options) => put(key, value, { ...options, sha256: undefined });
  const response = await fetchWorker(env, putBlobRequest(blobA, sha(blobB)));
  assert.equal(response.status, 422);
  assert.equal(env.MODS.objects.size, 0);
});

/* ---------------- bundles ---------------- */

test('bundle PUT validates, stores the canonical body and serves it immutable', async () => {
  const env = await modsEnv();
  await storeBlobs(env, blobA, blobB);
  const { text, hash } = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp_boss', blobB), declFile('alex.pink-imp', 'pink_imp', blobA)]));
  const created = await fetchWorker(env, putBundleRequest(text, hash));
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(await created.json(), { bundle: hash });
  assert.equal(Buffer.from(env.MODS.objects.get('bundle/' + hash).bytes).toString(), text);
  assert.equal((await fetchWorker(env, putBundleRequest(text, hash))).status, 200);

  const got = await fetchWorker(env, call('GET', '/mods/bundle/' + hash));
  assert.equal(got.status, 200);
  assert.equal(await got.text(), text);
  assert.equal(got.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(got.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(got.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const head = await fetchWorker(env, call('HEAD', '/mods/bundle/' + hash));
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetchWorker(env, call('GET', '/mods/bundle/' + 'e'.repeat(64)))).status, 404);

  const withField = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp', blobA)]));
  const stored = canonical({ ...withField.manifest, bundle: withField.hash });
  assert.equal((await fetchWorker(env, putBundleRequest(stored, withField.hash))).status, 201);
});

test('bundle PUT refuses mismatch, non-canonical text, missing blobs and every manifest rule', async () => {
  const env = await modsEnv();
  await storeBlobs(env, blobA);
  const good = sampleManifest([declFile('alex.pink-imp', 'pink_imp', blobA)]);
  const ok = bundleOf(good);
  const status = async (text, hash) => {
    const response = await fetchWorker(env, putBundleRequest(text, hash));
    return [response.status, (await response.json()).error];
  };
  const expectRule = async (manifest, pattern) => {
    const { text, hash } = bundleOf(manifest);
    const [code, error] = await status(text, hash);
    assert.equal(code, 422, JSON.stringify(manifest).slice(0, 200));
    assert.match(error, pattern);
  };

  assert.deepEqual(await status(ok.text, sha(Buffer.from('x'))), [422, 'canonical manifest does not hash to the path']);
  assert.deepEqual(await status(JSON.stringify(ok.manifest, null, 2), ok.hash), [422, 'body is not the canonical manifest text']);
  const dup = ok.text.replace('"format":1', '"format":1,"format":1');
  assert.equal((await status(dup, ok.hash))[0], 422);
  assert.deepEqual(await status(canonical({ ...ok.manifest, bundle: 'a'.repeat(64) }), ok.hash), [422, 'bundle field does not match the path']);
  assert.equal((await status('{', ok.hash))[0], 400);

  const file = declFile('alex.pink-imp', 'pink_imp', blobA);
  const withRequest = (request, extra = {}) => ({ ...file, path: 'assets/' + request, request, provides: { type: 'file', name: request }, ...extra });
  await expectRule({ ...good, format: 2 }, /unsupported format/);
  for (const id of ['Alex', '.alex', 'alex..imp', 'a/b', 'x'.repeat(65), '']) await expectRule({ ...good, id }, /bad id/);
  await expectRule({ ...good, version: '../1' }, /bad version/);
  await expectRule({ ...good, version: '' }, /bad version/);
  for (const build of [0, -1, 2147483648, 1.5, '1', null]) await expectRule({ ...good, build }, /bad build/);
  const unbuilt = { ...good };
  delete unbuilt.build;
  await expectRule(unbuilt, /bad build/);
  const unversioned = { ...good };
  delete unversioned.version;
  const noVersion = bundleOf(unversioned);
  assert.ok(!noVersion.text.includes('"version"'));
  assert.equal((await fetchWorker(env, putBundleRequest(noVersion.text, noVersion.hash))).status, 201, 'version is optional');
  const rebuilt = bundleOf({ ...good, build: 2 });
  assert.notEqual(rebuilt.hash, ok.hash, 'build is part of the canonical text');
  await expectRule({ ...good, homepage: 'javascript:alert(1)' }, /bad homepage/);
  await expectRule({ ...good, extra: 1 }, /bad extra/);
  await expectRule({ ...good, extra: {} }, /bad extra/);
  await expectRule({ ...good, extra: { 'Bad Key': 1 } }, /bad extra key/);
  await expectRule({ ...good, extra: { legacy: 'x' } }, /bad extra legacy/);
  const commands = { activate: ['echo hi', 'bind x "say hi"'], deactivate: ['echo bye'] };
  const { manifestError } = await modsModule;
  assert.equal(manifestError({ ...good, requirements: { cvars: { com_maxFps: '120' }, commands } }), null, 'requirements may carry any cvar and console commands');
  for (const bad of [{ activate: ['echo hi; quit'] }, { activate: [' echo hi'] }, { later: ['echo hi'] },
                    { activate: Array(17).fill('echo hi') }, { activate: [1] }, ['echo hi']]) {
    assert.equal(manifestError({ ...good, requirements: { cvars: {}, commands: bad } }), 'bad requirements');
  }
  await expectRule({ ...good, extra: { big: 'x'.repeat(256 * 1024) } }, /extra too large/);
  await expectRule({ ...good, unknown: 1 }, /unknown manifest key/);
  const withExtra = bundleOf({ ...good, extra: { legacy: { digest: '856c0b308aaa62e5' }, strings: { greet: 'hi' } } });
  assert.notEqual(withExtra.hash, ok.hash, 'extra is part of the canonical text');
  assert.equal((await fetchWorker(env, putBundleRequest(withExtra.text, withExtra.hash))).status, 201, 'extra is accepted');
  await expectRule({ ...good, files: [] }, /no files/);
  await expectRule({ ...good, files: [withRequest('mods/alex.pink-imp/../../x.json')] }, /path traversal/);
  await expectRule({ ...good, files: [withRequest('/mods/alex.pink-imp/x.json')] }, /absolute/);
  await expectRule({ ...good, files: [withRequest('mods\\alex.pink-imp\\x.json')] }, /backslash/);
  await expectRule({ ...good, files: [withRequest('mods/alex.pink-imp/X.json')] }, /lowercase/);
  await expectRule({ ...good, files: [withRequest('mods/alex.pink-imp/x.exe')] }, /extension not allowed/);
  await expectRule({ ...good, files: [withRequest('mods/alex.pink-imp/x.bswf')] }, /extension not allowed/);
  {
    /* One accepted PUT covers the newer kinds: the per-address upload budget is shared with the rules below. */
    const kinds = ['generated/swf/mods/alex.pink-imp/x.bswf', 'generated/spirv/mods/alex.pink-imp/x.cspv', 'generated/discreteanimation/mods/alex.pink-imp/x.dmodel'];
    const b = bundleOf({ ...good, files: [file, ...kinds.map(request => withRequest(request)),
      { path: 'assets/mods/alex.pink-imp/pointer.tome', request: 'mods/alex.pink-imp/pointer.tome', provides: { type: 'file', name: 'mods/alex.pink-imp/pointer.tome' },
        stock: { source: 'generated/decls/entitydef/ai/demon/imp.decl', sha256: 'ab'.repeat(32) } }] });
    assert.equal((await fetchWorker(env, putBundleRequest(b.text, b.hash))).status, 201, 'movies, compute stages, dmodels and a stock pointer are accepted');
  }
  await expectRule({ ...good, files: [withRequest('mods/alex.pink-imp/x.json', { path: 'mods/alex.pink-imp/x.json' })] }, /path does not match/);
  await expectRule({ ...good, files: [{ ...file, provides: { type: 'entityDef', name: 'mods/alex.pink-imp/other' } }] }, /provides does not match/);
  await expectRule({ ...good, files: [{ ...file, extra: true }] }, /unknown file key/);
  const pointer = (request, stock, extra = {}) => ({ path: 'assets/' + request, request, provides: { type: 'file', name: request }, stock, ...extra });
  const goodStock = { source: 'generated/decls/entitydef/ai/demon/imp.decl', sha256: 'ab'.repeat(32) };
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', goodStock, { blob: 'cd'.repeat(32) })] }, /unknown file key blob/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', goodStock, { size: 1 })] }, /unknown file key size/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', { source: goodStock.source })] }, /bad stock pointer/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', { ...goodStock, extra: 1 })] }, /bad stock pointer/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', { ...goodStock, sha256: 'zz' })] }, /bad stock hash/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', { ...goodStock, source: '/abs/path.decl' })] }, /bad stock source/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', { ...goodStock, source: 'Upper/Case.decl' })] }, /bad stock source/);
  await expectRule({ ...good, files: [pointer('mods/alex.pink-imp/p.decl', goodStock, { extra: true })] }, /unknown file key/);
  await expectRule({ ...good, files: [{ ...file, size: 64 * MIB + 1 }] }, /file too large/);

  const stock = 'generated/decls/entitydef/monster/imp.decl';
  const stockFile = { ...file, path: 'assets/' + stock, request: stock, provides: { type: 'entityDef', name: 'monster/imp' } };
  await expectRule({ ...good, files: [stockFile] }, /namespace/);
  await expectRule({ ...good, files: [withRequest('generated/image/models/monsters/imp/skin.bimage', { provides: { type: 'image', name: 'models/monsters/imp/skin' } })] }, /namespace/);
  await expectRule({ ...good, files: [withRequest('mods/other.mod/x.json')] }, /namespace/);
  await expectRule({ ...good, files: [{ ...file, provides: { type: 'entityDef2', name: file.provides.name } }] }, /provides does not match/);
  const material = 'generated/decls/material/mods/alex.pink-imp/skin.decl';
  const materialFile = { ...file, path: 'assets/' + material, request: material, provides: { type: 'material', name: 'mods/alex.pink-imp/skin' } };
  await expectRule({ ...good, files: [{ ...materialFile, provides: { type: 'material2', name: 'mods/alex.pink-imp/skin' } }] }, /provides does not match/);
  const materialBundle = bundleOf({ ...good, files: [materialFile] });
  assert.equal((await fetchWorker(env, putBundleRequest(materialBundle.text, materialBundle.hash))).status, 201, 'decl type is the folder name');
  await expectRule({ ...good, shadows: ['generated/decls/entitydef/monster/cacodemon.decl'] }, /shadow names no file/);
  await expectRule({ ...good, shadows: ['../x.decl'] }, /shadow: path traversal/);

  const shadowed = bundleOf({ ...good, shadows: [stock], files: [stockFile] });
  assert.equal((await fetchWorker(env, putBundleRequest(shadowed.text, shadowed.hash))).status, 201);

  const many = Array.from({ length: 4097 }, (_, i) => withRequest('mods/alex.pink-imp/f' + i + '.json', { size: 1 }));
  await expectRule({ ...good, files: many }, /too many files/);
  const heavy = Array.from({ length: 5 }, (_, i) => withRequest('mods/alex.pink-imp/h' + i + '.bin', { size: 64 * MIB }));
  await expectRule({ ...good, files: heavy }, /bundle too large/);
  await expectRule({ ...good, files: [{ ...file, size: blobA.byteLength + 1 }] }, /size does not match/);

  const absent = Array.from({ length: 150 }, (_, i) => withRequest('mods/alex.pink-imp/m' + i + '.json',
    { blob: sha(Buffer.from('absent ' + i)), size: 7 }));
  const gap = bundleOf({ ...good, files: [file, ...absent] });
  const conflict = await fetchWorker(env, putBundleRequest(gap.text, gap.hash));
  assert.equal(conflict.status, 409);
  const body = await conflict.json();
  assert.equal(body.missing.length, 100);
  assert.equal(body.missingCount, 150);
  assert.ok(!body.missing.includes(sha(blobA)));
  assert.equal(env.MODS.objects.has('bundle/' + gap.hash), false);

  const big = await fetchWorker(env, call('PUT', '/mods/bundle/' + ok.hash, { body: new Uint8Array(MIB + 1) }));
  assert.equal(big.status, 413);
});

test('raw files of a dashed id may use the engine underscore spelling; decls keep the exact id', async () => {
  const env = await modsEnv();
  const mesh = Buffer.from('bmd6model bytes'), skin = Buffer.from('bimage bytes'), anim = Buffer.from('bmd6anim bytes');
  await storeBlobs(env, blobA, mesh, skin, anim);
  const raw = (request, bytes, type, name) => ({ path: 'assets/' + request, request, blob: sha(bytes), size: bytes.byteLength, provides: { type, name } });
  const files = [
    declFile('alex.r2-imp', 'r2_imp', blobA),
    raw('generated/basemodel/md6/mods/alex.r2_imp/imp.bmd6model', mesh, 'baseModel', 'md6/mods/alex.r2_imp/imp.md6mesh'),
    raw('generated/image/models/mods/alex.r2_imp/skin.bimage', skin, 'image', 'models/mods/alex.r2_imp/skin'),
    raw('cooked/anim/md6/mods/alex.r2-imp/idle.bmd6anim', anim, 'anim', 'md6/mods/alex.r2-imp/idle.md6anim'),
  ];
  const manifest = { format: 1, id: 'alex.r2-imp', build: 1, name: 'R2 Imp', files };
  const ok = bundleOf(manifest);
  const stored = await fetchWorker(env, putBundleRequest(ok.text, ok.hash));
  assert.equal(stored.status, 201, await stored.clone().text());

  const refused = async (changed, pattern) => {
    const { text, hash } = bundleOf({ ...manifest, files: changed });
    const response = await fetchWorker(env, putBundleRequest(text, hash));
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, pattern);
  };
  const underscoredDecl = 'generated/decls/entitydef/mods/alex.r2_imp/r2_imp.decl';
  await refused([{ ...files[0], path: 'assets/' + underscoredDecl, request: underscoredDecl,
    provides: { type: 'entityDef', name: 'mods/alex.r2_imp/r2_imp' } }], /namespace/);
  await refused([raw('generated/basemodel/md6/mods/alex.r2.imp/imp.bmd6model', mesh, 'baseModel', 'md6/mods/alex.r2.imp/imp.md6mesh')], /namespace/);
  await refused([raw('generated/basemodel/md6/mods/alex_r2_imp/imp.bmd6model', mesh, 'baseModel', 'md6/mods/alex_r2_imp/imp.md6mesh')], /namespace/);
});

/* ---------------- missing ---------------- */

test('missing answers present and absent blobs and bounds the list', async () => {
  const env = await modsEnv();
  await storeBlobs(env, blobA);
  const empty = await fetchWorker(env, postJson('/mods/missing', { blobs: [] }));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { missing: [] });
  const absent = sha(blobB);
  const mixed = await fetchWorker(env, postJson('/mods/missing', { blobs: [absent, sha(blobA), absent] }));
  assert.deepEqual(await mixed.json(), { missing: [absent] });
  const full = Array.from({ length: 4096 }, (_, i) => sha(Buffer.from('n' + i)));
  const many = await fetchWorker(env, postJson('/mods/missing', { blobs: full }));
  assert.equal(many.status, 200);
  assert.equal((await many.json()).missing.length, 4096);
  const over = await fetchWorker(env, postJson('/mods/missing', { blobs: [...full, sha(Buffer.from('extra'))] }));
  assert.equal(over.status, 400);
  assert.equal((await fetchWorker(env, postJson('/mods/missing', { blobs: ['nothex'] }))).status, 400);
  assert.equal((await fetchWorker(env, postJson('/mods/missing', {}))).status, 400);
  assert.equal((await fetchWorker(env, call('GET', '/mods/missing'))).status, 405);
});

/* ---------------- takedown ---------------- */

test('blocked hashes are refused with 451 on every route', async () => {
  const env = await modsEnv();
  await storeBlobs(env, blobA, blobB);
  const blob = sha(blobA);
  const { text, hash } = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp', blobA)]));
  const clean = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp_boss', blobB)]));
  assert.equal((await fetchWorker(env, putBundleRequest(clean.text, clean.hash))).status, 201);
  env.MODS_BLOCKED = JSON.stringify([blob.toUpperCase(), clean.hash]);
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + blob))).status, 451);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/blob/' + blob))).status, 451);
  assert.equal((await fetchWorker(env, putBlobRequest(blobA))).status, 451);
  const refused = await fetchWorker(env, putBundleRequest(text, hash));
  assert.equal(refused.status, 451);
  assert.deepEqual((await refused.json()).blocked, [blob]);
  assert.equal((await fetchWorker(env, call('GET', '/mods/bundle/' + clean.hash))).status, 451);
  assert.equal((await fetchWorker(env, putBundleRequest(clean.text, clean.hash))).status, 451);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-1', bundles: [clean.hash] }))).status, 451);
  assert.deepEqual(await (await fetchWorker(env, postJson('/mods/missing', { blobs: [blob, sha(blobB)] }))).json(), { missing: [blob] });
  env.MODS_BLOCKED = '{"not":"a list"}';
  assert.equal((await fetchWorker(env, call('GET', '/mods/blob/' + sha(blobB)))).status, 503);
});

/* ---------------- quotas ---------------- */

test('per-address limits exhaust with 429, use hashed names and leave other addresses alone', async () => {
  const env = await modsEnv();
  await storeBlobs(env, blobA);
  const { text, hash } = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp', blobA)]));
  for (let i = 0; i < 64; i++) assert.notEqual((await fetchWorker(env, putBundleRequest(text, hash))).status, 429, 'put ' + i);
  const limited = await fetchWorker(env, putBundleRequest(text, hash));
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('Retry-After'), /^\d+$/);
  const elsewhere = call('PUT', '/mods/bundle/' + hash, { body: text, headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal((await fetchWorker(env, elsewhere)).status, 200);
  assert.ok(env.names.length > 0);
  for (const name of env.names) {
    assert.match(name, /^mods-address:[0-9a-f]{64}$/);
    assert.ok(!name.includes(ADDRESS));
  }
  const keyed = await modsEnv({ MODS_ADDRESS_KEY: 'local-test-key' });
  await fetchWorker(keyed, call('GET', '/mods/blob/' + hash));
  assert.notEqual(keyed.names[0], env.names[0]);

  const failing = await modsEnv();
  failing.WRITE_QUOTAS = { idFromName: () => 'x', get: () => ({ consumeMods: async () => { throw new Error('down'); } }) };
  assert.equal((await fetchWorker(failing, putBlobRequest(blobA))).status, 503);
  assert.equal((await fetchWorker(failing, call('GET', '/mods/blob/' + sha(blobA)))).status, 404, 'reads fail open');
});

test('blob byte quota refuses an upload that would exceed the hourly bytes', async () => {
  const env = await modsEnv();
  const { MOD_LIMITS } = await quotaModule;
  let first = true;
  const original = env.WRITE_QUOTAS.get;
  env.WRITE_QUOTAS.get = name => {
    const stub = original(name);
    if (first) { first = false; stub.consumeMods([['mod_bytes', MOD_LIMITS.mod_bytes - 4]]); }
    return stub;
  };
  const response = await fetchWorker(env, putBlobRequest(blobA));
  assert.equal(response.status, 429);
  assert.equal(env.MODS.objects.size, 0);
});

test('mod quota admits each limit exactly and all-or-nothing across kinds', async () => {
  const { initializeQuota, consumeModQuota, MOD_LIMITS } = await quotaModule;
  assert.deepEqual({ ...MOD_LIMITS }, { mod_blob_put: 2048, mod_bytes: 4 * 1024 ** 3, mod_bundle_put: 64, mod_get: 20000, mod_claim: 64 });
  const storage = sqliteStorage();
  initializeQuota(storage);
  const hour = 3600000 * 10;
  for (const kind of ['mod_blob_put', 'mod_bundle_put', 'mod_claim', 'mod_get']) {
    for (let i = 0; i < MOD_LIMITS[kind]; i++) assert.equal(consumeModQuota(storage, [[kind, 1]], hour).allowed, true);
    assert.equal(consumeModQuota(storage, [[kind, 1]], hour + 3599999).allowed, false, kind);
    assert.equal(consumeModQuota(storage, [[kind, 1]], hour + 3600000).allowed, true, kind);
  }
  const fresh = sqliteStorage();
  initializeQuota(fresh);
  assert.equal(consumeModQuota(fresh, [['mod_blob_put', 1], ['mod_bytes', MOD_LIMITS.mod_bytes]], hour).allowed, true);
  assert.deepEqual(consumeModQuota(fresh, [['mod_blob_put', 1], ['mod_bytes', 1]], hour + 1), { allowed: false, kind: 'mod_bytes' });
  assert.equal(fresh.sql.exec("SELECT used FROM mod_quota WHERE kind = 'mod_blob_put'").toArray()[0].used, 1, 'refusal spent nothing');
  assert.equal(consumeModQuota(fresh, [['mod_blob_put', 1]], hour + 2).allowed, true);
  for (const bad of [[], [['post', 1]], [['mod_get', 0]], [['mod_get', 1], ['mod_get', 1]], [['mod_get', 1.5]]]) {
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

/* ---------------- claims, serving window and purge ---------------- */

async function publishTwoBundles(env) {
  await storeBlobs(env, blobA, blobB, blobC);
  const first = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp', blobA), declFile('alex.pink-imp', 'shared', blobB)]));
  const second = bundleOf(sampleManifest([declFile('alex.pink-imp', 'shared', blobB), declFile('alex.pink-imp', 'third', blobC)], { build: 2, version: '2.0.0' }));
  for (const bundle of [first, second]) assert.equal((await fetchWorker(env, putBundleRequest(bundle.text, bundle.hash))).status, 201);
  return { first, second };
}

function claims(env, hash) {
  return env.registryStorage.sql.exec('SELECT claims FROM mod_bundle WHERE hash = ?', hash).toArray()[0]?.claims;
}

test('claim, re-claim with the secret, and release with wrong and right secrets', async () => {
  const env = await modsEnv();
  const { first, second } = await publishTwoBundles(env);
  const made = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', bundles: [first.hash] }));
  assert.equal(made.status, 201);
  const { claim, secret } = await made.json();
  assert.match(claim, /^[0-9a-f]{32}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(claims(env, first.hash), 1);
  const stored = env.registryStorage.sql.exec('SELECT secret FROM mod_claim').toArray()[0].secret;
  assert.notEqual(stored, secret);
  assert.equal(stored, sha(Buffer.from(secret)));

  const other = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', bundles: [first.hash] }));
  assert.equal(other.status, 201, 'a second claimant holds its own claim');
  const second_ = await other.json();
  assert.notEqual(second_.claim, claim);
  assert.equal(claims(env, first.hash), 2);

  const again = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', bundles: [second.hash, second.hash], secret }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { claim, secret });
  assert.equal(claims(env, first.hash), 1);
  assert.equal(claims(env, second.hash), 1);

  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-41', bundles: [first.hash], secret: 'a'.repeat(64) }))).status, 403);
  assert.equal((await fetchWorker(env, postJson('/mods/claim', { ref: 'item-42', bundles: [first.hash], secret }))).status, 403);
  const unknown = await fetchWorker(env, postJson('/mods/claim', { ref: 'item-43', bundles: ['d'.repeat(64)] }));
  assert.equal(unknown.status, 409);
  assert.deepEqual((await unknown.json()).missing, ['d'.repeat(64)]);
  for (const body of [{ ref: '', bundles: [first.hash] }, { ref: 'x'.repeat(65), bundles: [first.hash] }, { ref: 'a', bundles: [] },
    { ref: 'a', bundles: [first.hash], secret: 'short' }, { ref: 'a', bundles: Array(257).fill(first.hash) }]) {
    assert.equal((await fetchWorker(env, postJson('/mods/claim', body))).status, 400, JSON.stringify(body).slice(0, 80));
  }

  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret: 'b'.repeat(64) }))).status, 403);
  assert.equal(claims(env, second.hash), 1);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim: 'c'.repeat(32), secret }))).status, 404);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim: 'nothex', secret }))).status, 400);
  const released = await fetchWorker(env, postJson('/mods/release', { claim, secret }));
  assert.equal(released.status, 204);
  assert.equal(claims(env, second.hash), undefined, 'its last release removes the bundle from the index');
  assert.equal(claims(env, first.hash), 1);
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 404);
});

test('serving is gated by claim count once the one-hour upload window has passed', async () => {
  const env = await modsEnv();
  const { first, second } = await publishTwoBundles(env);
  const get = route => fetchWorker(env, call('GET', route));
  assert.equal((await get('/mods/bundle/' + first.hash)).status, 200, 'fresh bundle serves unclaimed');
  assert.equal((await get('/mods/blob/' + sha(blobA))).status, 200, 'fresh blob serves unclaimed');

  env.clock.offset = 2 * HOUR;
  for (const object of env.MODS.objects.values()) object.uploaded = new Date(Date.now() - 2 * HOUR);
  assert.equal((await get('/mods/bundle/' + first.hash)).status, 404);
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/bundle/' + first.hash))).status, 404);
  assert.equal((await get('/mods/blob/' + sha(blobA))).status, 404);

  const { claim, secret } = await (await fetchWorker(env, postJson('/mods/claim', { ref: 'item-7', bundles: [second.hash] }))).json();
  assert.equal((await get('/mods/bundle/' + second.hash)).status, 200);
  assert.equal((await get('/mods/blob/' + sha(blobB))).status, 200, 'shared blob served through the claimed bundle');
  assert.equal((await get('/mods/blob/' + sha(blobC))).status, 200);
  assert.equal((await get('/mods/blob/' + sha(blobA))).status, 404, 'blob named only by the unclaimed bundle');
  assert.equal((await fetchWorker(env, call('HEAD', '/mods/blob/' + sha(blobC)))).status, 200);

  env.MODS.log.length = 0;
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 204);
  assert.equal((await get('/mods/bundle/' + second.hash)).status, 404);
  assert.equal((await get('/mods/blob/' + sha(blobC))).status, 404);
  const gone = env.MODS.log.filter(([op]) => op === 'delete').map(([, key]) => key);
  assert.ok(gone.includes('bundle/' + second.hash), 'the last release deletes the bundle object at once');
  assert.ok(gone.includes('blob/' + sha(blobC)), 'and sweeps the blob only it named');
  assert.ok(!env.MODS.objects.has('bundle/' + second.hash));
  assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM mod_bundle WHERE hash = ?', second.hash).toArray()[0].n, 0);

  assert.equal((await fetchWorker(env, putBundleRequest(first.text, first.hash))).status, 200);
  assert.equal((await get('/mods/bundle/' + first.hash)).status, 200, 're-upload reopens the claim window');
});

test('purge deletes unclaimed bundles before blobs and keeps blobs a claimed bundle names', async () => {
  const { purgeMods } = await modsModule;
  const env = await modsEnv();
  const { first, second } = await publishTwoBundles(env);
  const { claim, secret } = await (await fetchWorker(env, postJson('/mods/claim', { ref: 'item-9', bundles: [second.hash] }))).json();
  const orphan = Buffer.from('orphan blob');
  await storeBlobs(env, orphan);

  assert.deepEqual(await purgeMods(env), { bundles: 0, blobs: 0 }, 'nothing is purged inside the window');
  env.clock.offset = 2 * HOUR;
  env.MODS.log.length = 0;
  assert.deepEqual(await purgeMods(env), { bundles: 1, blobs: 2 });
  const deletes = env.MODS.log.filter(([op]) => op === 'delete').map(([, key]) => key);
  assert.deepEqual(deletes.slice(0, 1), ['bundle/' + first.hash]);
  assert.deepEqual(deletes.slice(1).sort(), ['blob/' + sha(blobA), 'blob/' + sha(orphan)].sort());
  assert.deepEqual([...env.MODS.objects.keys()].sort(),
    ['blob/' + sha(blobB), 'blob/' + sha(blobC), 'bundle/' + second.hash].sort());
  assert.deepEqual(await (await fetchWorker(env, postJson('/mods/missing', { blobs: [sha(blobA), sha(blobB)] }))).json(),
    { missing: [sha(blobA)] });

  env.MODS.log.length = 0;
  assert.equal((await fetchWorker(env, postJson('/mods/release', { claim, secret }))).status, 204);
  const order = env.MODS.log.filter(([op]) => op === 'delete').map(([, key]) => key.split('/')[0]);
  assert.deepEqual(order, ['bundle', 'blob', 'blob'], 'the release itself deletes the bundle, then the blobs nothing names');
  assert.equal(env.MODS.objects.size, 0);
  assert.deepEqual(await purgeMods(env), { bundles: 0, blobs: 0 }, 'nothing is left for the purge');
  assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM mod_blob').toArray()[0].n, 0);
});

test('blobs marked for purge read missing, refuse new bundles and ask uploads to retry', async () => {
  const registry = await registryModule;
  const env = await modsEnv();
  await storeBlobs(env, blobA);
  env.clock.offset = 2 * HOUR;
  assert.deepEqual(registry.purgeBlobs(env.registryStorage, env.clock.now(), 10), [sha(blobA)]);
  assert.deepEqual(await (await fetchWorker(env, postJson('/mods/missing', { blobs: [sha(blobA)] }))).json(), { missing: [sha(blobA)] });
  const { text, hash } = bundleOf(sampleManifest([declFile('alex.pink-imp', 'pink_imp', blobA)]));
  const refused = await fetchWorker(env, putBundleRequest(text, hash));
  assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json()).missing, [sha(blobA)]);
  const retry = await fetchWorker(env, putBlobRequest(blobA));
  assert.equal(retry.status, 503);
  assert.equal(retry.headers.get('Retry-After'), '60');
  assert.deepEqual(registry.purgeBlobs(env.registryStorage, env.clock.now(), 10), [sha(blobA)], 'interrupted purge is retried');
  registry.finishBlobs(env.registryStorage, [sha(blobA)]);
  env.MODS.objects.delete('blob/' + sha(blobA));
  assert.equal((await fetchWorker(env, putBlobRequest(blobA))).status, 201);
  assert.equal((await fetchWorker(env, putBundleRequest(text, hash))).status, 201);
});

/* ---------------- CORS and configuration ---------------- */

test('mod routes keep the site CORS allowlist and need no Origin', async () => {
  const env = await modsEnv();
  const native = await fetchWorker(env, putBlobRequest(blobA));
  assert.equal(native.status, 201);
  assert.equal(native.headers.get('Access-Control-Allow-Origin'), null);
  const site = await fetchWorker(env, call('GET', '/mods/blob/' + sha(blobA), { headers: { Origin: 'https://www.snapmapplus.com' } }));
  assert.equal(site.headers.get('Access-Control-Allow-Origin'), 'https://www.snapmapplus.com');
  const foreign = await fetchWorker(env, call('GET', '/mods/blob/' + sha(blobA), { headers: { Origin: 'https://evil.example' } }));
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  const unconfigured = await modsEnv();
  delete unconfigured.MODS;
  assert.equal((await fetchWorker(unconfigured, call('GET', '/mods/blob/' + sha(blobA)))).status, 503);
});

test('the maintainer reset route is hidden without the secret and empties the store with it', async () => {
  const env = await modsEnv();
  await publishTwoBundles(env);
  await (await fetchWorker(env, postJson('/mods/claim', { ref: 'item-3', bundles: [[...env.MODS.objects.keys()].find(k => k.startsWith('bundle/')).slice(7)] }))).json();
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/reset'))).status, 404, 'no secret configured');
  env.MODS_ADMIN_TOKEN = 'correct horse battery staple';
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/reset'))).status, 403);
  assert.equal((await fetchWorker(env, call('POST', '/mods/admin/reset', { headers: { Authorization: 'Bearer nope' } }))).status, 403);
  assert.equal((await fetchWorker(env, call('GET', '/mods/admin/reset'))).status, 405);
  const response = await fetchWorker(env, call('POST', '/mods/admin/reset', { headers: { Authorization: 'Bearer correct horse battery staple' } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.deleted, { blobs: 3, bundles: 2 });
  assert.equal(body.index.mod_claim, 1);
  assert.equal(env.MODS.objects.size, 0);
  for (const table of ['mod_blob', 'mod_bundle', 'mod_bundle_blob', 'mod_claim', 'mod_claim_bundle']) {
    assert.equal(env.registryStorage.sql.exec('SELECT count(*) AS n FROM ' + table).toArray()[0].n, 0, table);
  }
});

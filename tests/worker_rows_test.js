'use strict';
/* What the mod store's Durable Objects write, measured under Miniflare (workerd's own SQLite and its row counts, every
 * index a row as the platform bills it; api/sql_meter.js): a map publish of one unit of N files (begin, one archive,
 * complete, claim) and a player's download of it (status and the archive, one request), against the file-by-file
 * download it replaced (status, manifest and one request per file), and a download of a few files a player lacks.
 * Each step's rows written in the registry and in the quota objects of the address and the publishing key.
 *
 *   node tests/worker_rows_test.js <miniflare> [files] [worker root]
 *
 * The worker root defaults to this checkout; a copy of an earlier api/ with sql_meter.js measures it the same way. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomBytes, generateKeyPairSync, sign: nodeSign } = require('node:crypto');
const { Miniflare } = require(path.resolve(process.argv[2] || 'miniflare'));

const FILES = Number(process.argv[3] || 300);
const root = path.resolve(process.argv[4] || path.join(__dirname, '..'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmap-web-rows-'));
const IP = '203.0.113.9';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

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

function makeUnit(n) {
  const bytes = {};
  for (let i = 0; i < n; i++) bytes['images/f' + String(i).padStart(5, '0') + '.bimage'] = randomBytes(256);
  const files = Object.keys(bytes).sort().map(p => ({ path: p, sha256: sha(bytes[p]), size: bytes[p].length }));
  const manifest = Buffer.from(canonical({ files, format: 1, game: [], mod: {}, root: { kind: 'entity', name: 'entities/x' } }));
  return { hash: sha(manifest), manifest, files, bytes };
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
    headers: { 'X-Publisher-Key': key.pub, 'X-Publisher-Signature': signature, 'CF-Connecting-IP': IP, ...headers } });
}

const get = (mf, route, headers = {}) => mf.dispatchFetch('http://local.test' + route, { headers: { 'CF-Connecting-IP': IP, ...headers } });
const post = (mf, route, body) => mf.dispatchFetch('http://local.test' + route, { method: 'POST', body, headers: { 'CF-Connecting-IP': IP } });

async function meters(mf, key) {
  const reg = await mf.getDurableObjectNamespace('UNIT_REGISTRY');
  const quotas = await mf.getDurableObjectNamespace('WRITE_QUOTAS');
  const registry = (await reg.get(reg.idFromName('registry')).stats()).sql;
  const address = await quotas.get(quotas.idFromName('mods-address:' + sha(Buffer.from('snapmap-mods-address:' + IP)))).meter();
  const publisher = await quotas.get(quotas.idFromName('mods-key:' + sha(Buffer.from(key.pub)))).meter();
  return { registry: registry.rowsWritten, address: address.rowsWritten, key: publisher.rowsWritten };
}

async function measure(mf, key, label, results, step) {
  const before = await meters(mf, key);
  const requests = await step();
  const after = await meters(mf, key);
  const row = { step: label, requests, registry: after.registry - before.registry, address: after.address - before.address,
                key: after.key - before.key };
  row.total = row.registry + row.address + row.key;
  results.push(row);
}

async function run() {
  const mf = new Miniflare({
    name: 'rows-test', modules: true, modulesRoot: root, scriptPath: path.join(root, 'api/worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2026-07-01',
    durableObjects: { WRITE_QUOTAS: { className: 'CommunityQuota', useSQLite: true },
                      UNIT_REGISTRY: { className: 'UnitRegistry', useSQLite: true },
                      MOD_CHECKER: { className: 'ModChecker', useSQLite: true } },
    durableObjectsPersist: path.join(scratch, 'do'), kvNamespaces: ['SESSIONS'], r2Buckets: ['MEDIA', 'MODS'],
    outboundService: () => { throw new Error('unexpected external request'); },
  });
  const results = [];
  try {
    const key = makeKey();
    const unit = makeUnit(FILES);
    await (await post(mf, '/mods/units', JSON.stringify({ units: [unit.hash] }))).arrayBuffer();   /* the objects start */
    await meters(mf, key);
    await measure(mf, key, 'publish: begin, one archive, complete, claim', results, async () => {
      let res = await send(mf, key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest);
      assert.equal(res.status, 200, await res.clone().text());
      await res.arrayBuffer();
      const entries = [{ name: 'unit.json', data: unit.manifest }, ...unit.files.map(f => ({ name: f.path, data: unit.bytes[f.path] }))];
      const archive = zip(entries);
      res = await send(mf, key, 'PUT', '/mods/unit/' + unit.hash + '/archive', archive, { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) });
      assert.equal(res.status, 201, await res.clone().text());
      await res.arrayBuffer();
      res = await send(mf, key, 'POST', '/mods/unit/' + unit.hash + '/complete', '');
      await res.arrayBuffer();
      res = await send(mf, key, 'POST', '/mods/map/claim', JSON.stringify({ ref: 'item-1', units: [unit.hash], secret: 'a'.repeat(64), rev: 1 }));
      assert.equal(res.status, 201, await res.clone().text());
      await res.arrayBuffer();
      return 4;
    });
    await measure(mf, key, 'download, file by file: status, manifest, ' + FILES + ' files', results, async () => {
      await (await post(mf, '/mods/units', JSON.stringify({ units: [unit.hash] }))).arrayBuffer();
      await (await get(mf, '/mods/unit/' + unit.hash)).arrayBuffer();
      for (const f of unit.files) {
        const res = await get(mf, '/mods/blob/' + f.sha256);
        assert.equal(res.status, 200);
        await res.arrayBuffer();
      }
      return 2 + FILES;
    });
    await measure(mf, key, 'download, one request: status, the archive', results, async () => {
      await (await post(mf, '/mods/units', JSON.stringify({ units: [unit.hash] }))).arrayBuffer();
      const res = await get(mf, '/mods/unit/' + unit.hash + '/archive');
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      return 2;
    });
    await measure(mf, key, 'download of 3 files a player lacks: status, the archive with a mask', results, async () => {
      await (await post(mf, '/mods/units', JSON.stringify({ units: [unit.hash] }))).arrayBuffer();
      const mask = Buffer.alloc(Math.ceil(FILES / 8));
      for (const i of [0, 7, FILES - 1]) mask[i >> 3] |= 1 << (i & 7);
      const res = await get(mf, '/mods/unit/' + unit.hash + '/archive?want=' + mask.toString('base64url'));
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && body.length < 4096) assert.ok(body.includes(Buffer.from(unit.files[FILES - 1].path)));
      return 2;
    });
    await measure(mf, key, 'republish of the same unit: begin (held), claim', results, async () => {
      let res = await send(mf, key, 'POST', '/mods/unit/' + unit.hash + '/begin', unit.manifest);
      await res.arrayBuffer();
      res = await send(mf, key, 'POST', '/mods/map/claim', JSON.stringify({ ref: 'item-2', units: [unit.hash], secret: 'b'.repeat(64), rev: 1 }));
      await res.arrayBuffer();
      return 2;
    });
  } finally { await mf.dispose(); }
  console.log('rows written, ' + FILES + ' files a unit (' + root + ')');
  for (const r of results)
    console.log(`  ${r.step}: ${r.requests} request(s); registry ${r.registry}, address quota ${r.address}, key quota ${r.key}, total ${r.total}`);
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(scratch) !== os.tmpdir() || fs.lstatSync(scratch).isSymbolicLink()) throw new Error('unexpected test directory');
  fs.rmSync(scratch, { recursive: true, force: true });
});

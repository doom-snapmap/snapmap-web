/* Anonymous mod asset store (Contract 4 of the mod system, plus anonymous claims).
 * Blobs are cooked files addressed by the SHA-256 of their bytes; bundles are manifests
 * addressed by the SHA-256 of their canonical JSON text. Nothing is browsable: every
 * object is reachable only by hash. MODS R2 holds the bytes under blob/<sha> and
 * bundle/<hash>; the MOD_REGISTRY Durable Object indexes them and holds claims;
 * WRITE_QUOTAS enforces hourly limits per hashed client address. See README.md. */

import { RequestError, readBody, readJsonObject } from './request_body.js';

export const MAX_BLOB = 64 * 1024 * 1024;
export const MAX_BUNDLE_JSON = 1024 * 1024;
export const MAX_FILES = 4096;
export const MAX_TOTAL = 256 * 1024 * 1024;
export const MAX_QUERY = 4096;
export const MAX_CLAIM_BUNDLES = 256;
export const CLAIM_WINDOW_MS = 7 * 86400000;
const MAX_MISSING_JSON = 512 * 1024;
const MAX_CLAIM_JSON = 64 * 1024;
const MISSING_SHOWN = 100;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PURGE_BATCH = 500;
const PURGE_ROUNDS = 20;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SEGMENT_RE = /^[a-z0-9_.~$#@+=,()&!' -]+$/;
const CVAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EXTENSIONS = new Set(['decl', 'bmd6model', 'bmd6skl', 'bmd6anim', 'bimage', 'bmodel', 'bcm', 'bnk', 'json', 'bin', 'vspv', 'fspv', 'cspv', 'mrpr', 'dmodel']);
const TOP_KEYS = new Set(['format', 'id', 'build', 'version', 'name', 'author', 'homepage', 'requirements', 'shadows', 'extra', 'files', 'bundle']);
/* Descriptor keys the builder preserves verbatim (strings, hud, legacy, composes, ...). */
const MAX_EXTRA_KEYS = 64;
const MAX_EXTRA_JSON = 256 * 1024;
const EXTRA_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const EXTRA_OBJECT_KEYS = new Set(['strings', 'hud', 'legacy']);
const FILE_KEYS = new Set(['path', 'blob', 'size', 'request', 'provides', 'needs']);
/* A stock pointer names installed game content instead of carrying it: no blob, no size. */
const STOCK_FILE_KEYS = new Set(['path', 'request', 'provides', 'needs', 'stock']);
const STOCK_KEYS = new Set(['sha256', 'source']);

/* ---------------- responses ---------------- */

function reply(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...extra } });
}

function refuse(error, status, extra, headers) {
  return reply({ error, ...extra }, status, headers);
}

function retryAfterHour() {
  return String(Math.max(1, Math.ceil((3600000 - (Date.now() % 3600000)) / 1000)));
}

async function discard(req) {
  try { await req.body?.cancel(); } catch { /* The client may already have gone. */ }
}

async function drain(req) {
  if (!req.body) return;
  const reader = req.body.getReader();
  try { for (;;) if ((await reader.read()).done) break; }
  catch { /* A disconnected client gets no answer anyway. */ }
  finally { reader.releaseLock(); }
}

/* ---------------- hashing ---------------- */

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return hex(buf);
}

/* ---------------- takedown list ---------------- */

/* MODS_BLOCKED is a Worker variable holding a JSON array of blocked blob and bundle hashes.
 * A malformed list fails closed so an editing mistake cannot unblock anything. */
let blockedCache = { source: null, set: null };

function blockedSet(env) {
  const source = env.MODS_BLOCKED === undefined ? '[]' : String(env.MODS_BLOCKED);
  if (blockedCache.source === source) return blockedCache.set;
  let list;
  try { list = JSON.parse(source); } catch { list = null; }
  if (!Array.isArray(list) || !list.every(hash => typeof hash === 'string' && HEX64.test(hash.toLowerCase()))) {
    console.log('mods: MODS_BLOCKED is not a JSON array of SHA-256 hex strings; refusing mod requests');
    throw new RequestError('mod store unavailable', 503);
  }
  blockedCache = { source, set: new Set(list.map(hash => hash.toLowerCase())) };
  return blockedCache.set;
}

function blockedResponse(hashes) {
  return refuse('blocked by takedown', 451, { blocked: hashes.slice(0, MISSING_SHOWN) });
}

/* ---------------- per-address quotas ---------------- */

/* IPv6 clients are keyed by their /64, since one host can rotate freely inside it. */
export function normalizeAddress(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/%.*$/, '');
  if (!value.includes(':')) return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ? value : 'unknown';
  let text = value;
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = dotted[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return 'unknown';
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return 'unknown';
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  if (groups.length !== 8 || groups.some(Number.isNaN)) return 'unknown';
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');   // IPv4-mapped
  }
  return groups.slice(0, 4).map(group => group.toString(16)).join(':') + '::/64';
}

/* Only a digest of the address names the quota object. With the optional MODS_ADDRESS_KEY
 * secret the digest is an HMAC, so it cannot be reversed by enumerating addresses. */
async function addressKey(req, env) {
  const data = new TextEncoder().encode('snapmap-mods-address:' + normalizeAddress(req.headers.get('CF-Connecting-IP')));
  if (env.MODS_ADDRESS_KEY) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.MODS_ADDRESS_KEY)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, data));
  }
  return sha256Hex(data);
}

/* Writes fail closed when quota storage is unavailable; reads fail open so installed
 * content stays fetchable through a quota outage. */
async function admit(req, env, entries, failOpen) {
  try {
    const key = await addressKey(req, env);
    const stub = env.WRITE_QUOTAS.get(env.WRITE_QUOTAS.idFromName('mods-address:' + key));
    const result = await stub.consumeMods(entries);
    if (typeof result?.allowed !== 'boolean') throw new Error('invalid quota result');
    return result.allowed;
  } catch {
    if (failOpen) { console.log('mods: read quota unavailable; admitting'); return true; }
    throw new RequestError('mod store quota unavailable; try again later', 503);
  }
}

function rateLimited() {
  return refuse('rate limited', 429, {}, { 'Retry-After': retryAfterHour() });
}

/* ---------------- registry ---------------- */

async function registry(env, method, ...args) {
  try {
    const stub = env.MOD_REGISTRY.get(env.MOD_REGISTRY.idFromName('registry'));
    return await stub[method](...args);
  } catch {
    throw new RequestError('mod store index unavailable; try again later', 503);
  }
}

/* ---------------- manifest validation ---------------- */

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codePoints(text) {
  return [...text].length;
}

function displayText(value, max) {
  return typeof value === 'string' && value.isWellFormed() && codePoints(value) <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function validId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && ID_RE.test(id) && !id.includes('..');
}

/* Request paths are lowercase, relative and made of plain segments: no leading slash, no
 * backslash, no empty, "." or ".." segment, no segment ending in a dot or space, and a
 * whitelisted extension. */
export function requestPathError(path, options) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 512) return 'bad request path';
  if (path.startsWith('/')) return 'absolute request path';
  if (path.includes('\\')) return 'backslash in request path';
  if (path !== path.toLowerCase()) return 'request path is not lowercase';
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return 'path traversal';
    if (!segment || !SEGMENT_RE.test(segment) || /[. ]$/.test(segment) || segment.startsWith(' ')) return 'bad request path segment';
  }
  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1) : '';
  if (options && options.extension === false) return null;
  if (ext === 'bswf') return path.startsWith('generated/swf/') ? null : 'extension not allowed';
  if (!EXTENSIONS.has(ext) && !/^baas_[a-z0-9]+$/.test(ext)) return 'extension not allowed';
  return null;
}

/* The logical identity a request path must declare (Contract 1 name table). Returns the
 * fixed type and name, or a null type for classes whose name is the request path. */
export function logicalName(request) {
  let m = request.match(/^generated\/decls\/([^/]+)\/(.+)\.decl$/);
  if (m) return { decl: true, type: m[1], name: m[2] };
  if ((m = request.match(/^generated\/basemodel\/(.+)\.bmd6model$/))) return { type: 'basemodel', name: m[1] + '.md6mesh' };
  if ((m = request.match(/^generated\/skeleton\/(.+)\.bmd6skl$/))) return { type: 'skeleton', name: m[1] + '.md6skl' };
  if ((m = request.match(/^cooked\/anim\/(.+)\.bmd6anim$/))) return { type: 'anim', name: m[1] + '.md6anim' };
  if ((m = request.match(/^generated\/image\/(.+)\.bimage$/))) return { type: 'image', name: m[1] };
  return { type: null, name: request };
}

function logicalRef(value) {
  return plainObject(value) && Object.keys(value).length === 2 && typeof value.type === 'string' &&
    TYPE_RE.test(value.type) && displayText(value.name, 512) && value.name.length > 0;
}

/* Returns null when the manifest satisfies Contract 1, else the first cause. */
export function manifestError(manifest) {
  if (!plainObject(manifest)) return 'manifest is not an object';
  for (const key of Object.keys(manifest)) if (!TOP_KEYS.has(key)) return 'unknown manifest key ' + key;
  if (manifest.format !== 1) return 'unsupported format';
  if (!validId(manifest.id)) return 'bad id';
  const id = manifest.id;
  if (!Number.isSafeInteger(manifest.build) || manifest.build < 1 || manifest.build > 2147483647) return 'bad build';
  if (manifest.version !== undefined && (typeof manifest.version !== 'string' || manifest.version.length < 1 ||
      !displayText(manifest.version, 32) || /[\/\\:*?"<>|]/.test(manifest.version) || /[. ]$/.test(manifest.version))) return 'bad version';
  if (!displayText(manifest.name, 80) || !manifest.name.trim()) return 'bad name';
  if (manifest.author !== undefined && !displayText(manifest.author, 80)) return 'bad author';
  if (manifest.homepage !== undefined) {
    if (!displayText(manifest.homepage, 2048) || !/^https?:\/\/[^\s]+$/i.test(manifest.homepage)) return 'bad homepage';
    try { new URL(manifest.homepage); } catch { return 'bad homepage'; }
  }
  if (manifest.requirements !== undefined) {
    const req = manifest.requirements;
    if (!plainObject(req) || Object.keys(req).some(key => key !== 'cvars')) return 'bad requirements';
    if (req.cvars !== undefined) {
      if (!plainObject(req.cvars) || Object.keys(req.cvars).length > 32) return 'bad requirements';
      for (const [name, value] of Object.entries(req.cvars)) {
        if (!CVAR_RE.test(name) || !displayText(value, 64)) return 'bad requirements';
      }
    }
  }
  if (manifest.extra !== undefined) {
    const extra = manifest.extra;
    if (!plainObject(extra)) return 'bad extra';
    const keys = Object.keys(extra);
    if (keys.length < 1 || keys.length > MAX_EXTRA_KEYS) return 'bad extra';
    for (const key of keys) {
      if (!EXTRA_KEY_RE.test(key)) return 'bad extra key';
      if (EXTRA_OBJECT_KEYS.has(key) && !plainObject(extra[key])) return 'bad extra ' + key;
    }
    if (JSON.stringify(extra).length > MAX_EXTRA_JSON) return 'extra too large';
  }
  const shadows = new Set();
  if (manifest.shadows !== undefined) {
    if (!Array.isArray(manifest.shadows) || manifest.shadows.length > MAX_FILES) return 'bad shadows';
    for (const shadow of manifest.shadows) {
      const error = requestPathError(shadow);
      if (error) return 'shadow: ' + error;
      if (shadows.has(shadow)) return 'duplicate shadow';
      shadows.add(shadow);
    }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) return 'no files';
  if (manifest.files.length > MAX_FILES) return 'too many files';
  const paths = new Set(), requests = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (!plainObject(file)) return 'bad file entry';
    const stock = file.stock !== undefined;
    for (const key of Object.keys(file)) if (!(stock ? STOCK_FILE_KEYS : FILE_KEYS).has(key)) return 'unknown file key ' + key;
    const { path, request } = file;
    if (typeof request !== 'string') return 'bad request path';
    const error = requestPathError(request, { extension: !stock });
    if (error) return error + ': ' + request.slice(0, 200);
    if (path !== 'assets/' + request) return 'path does not match request: ' + request.slice(0, 200);
    if (paths.has(path)) return 'duplicate path: ' + path.slice(0, 200);
    paths.add(path);
    requests.add(request);
    if (stock) {
      /* blob and size are not stock keys, so a pointer that carries them is refused above. */
      const pointer = file.stock;
      if (!plainObject(pointer)) return 'bad stock pointer: ' + request.slice(0, 200);
      const keys = Object.keys(pointer);
      if (keys.length !== 2 || !keys.every(key => STOCK_KEYS.has(key))) return 'bad stock pointer: ' + request.slice(0, 200);
      if (typeof pointer.sha256 !== 'string' || !HEX64.test(pointer.sha256)) return 'bad stock hash: ' + request.slice(0, 200);
      if (typeof pointer.source !== 'string' || pointer.source.length > 400) return 'bad stock source: ' + request.slice(0, 200);
      const sourceError = requestPathError(pointer.source, { extension: false });
      if (sourceError) return 'bad stock source: ' + request.slice(0, 200);
    } else {
      if (typeof file.blob !== 'string' || !HEX64.test(file.blob)) return 'bad blob hash';
      if (!Number.isSafeInteger(file.size) || file.size < 0) return 'bad size';
      if (file.size > MAX_BLOB) return 'file too large: ' + request.slice(0, 200);
      total += file.size;
      if (total > MAX_TOTAL) return 'bundle too large';
    }
    if (!logicalRef(file.provides)) return 'bad provides: ' + request.slice(0, 200);
    const expected = logicalName(request);
    if ((expected.type !== null && file.provides.type.toLowerCase() !== expected.type.toLowerCase()) ||
        file.provides.name.toLowerCase() !== expected.name) return 'provides does not match request: ' + request.slice(0, 200);
    if (file.needs !== undefined && (!Array.isArray(file.needs) || file.needs.length > 1024 || !file.needs.every(logicalRef))) {
      return 'bad needs: ' + request.slice(0, 200);
    }
    if (!shadows.has(request)) {
      /* Decls keep the exact id. Cooked raw names are derived by the engine with every
       * "-" rewritten to "_", so either spelling of the id owns a raw file. */
      const owned = expected.decl ? expected.name.startsWith('mods/' + id + '/')
        : ['/mods/' + id + '/', '/mods/' + id.replaceAll('-', '_') + '/'].some(prefix => ('/' + request).includes(prefix));
      if (!owned) return 'outside the mods/' + id + '/ namespace and not a declared shadow: ' + request.slice(0, 200);
    }
  }
  for (const shadow of shadows) if (!requests.has(shadow)) return 'shadow names no file: ' + shadow.slice(0, 200);
  return null;
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
}

/* Canonical text: keys sorted at every level, no whitespace, files sorted by path,
 * JSON.stringify escaping. With includeBundle false the "bundle" key is omitted; the
 * bundle hash is the SHA-256 of that text. */
export function canonicalText(manifest, includeBundle = false) {
  const copy = { ...manifest };
  if (!includeBundle) delete copy.bundle;
  copy.files = [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(sortedKeys(copy));
}

/* ---------------- object responses ---------------- */

function objectHeaders(obj, contentType, hash) {
  const h = new Headers();
  h.set('Content-Type', contentType);
  h.set('Content-Length', String(obj.size));
  h.set('Cache-Control', IMMUTABLE);
  h.set('ETag', '"' + hash + '"');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Content-Disposition', 'attachment');
  return h;
}

async function serveObject(req, env, kind, hash) {
  if (blockedSet(env).has(hash)) return blockedResponse([hash]);
  if (!(await admit(req, env, [['mod_get', 1]], true))) return rateLimited();
  const key = kind + '/' + hash;
  if (kind === 'bundle' && !(await registry(env, 'bundleServed', hash))) return refuse('not found', 404);
  const obj = req.method === 'HEAD' ? await env.MODS.head(key) : await env.MODS.get(key);
  if (!obj) return refuse('not found', 404);
  if (kind === 'blob' && Date.now() - obj.uploaded.getTime() >= CLAIM_WINDOW_MS) {
    let served = false;
    try { served = await registry(env, 'blobClaimed', hash); }
    finally { if (!served) { try { await obj.body?.cancel(); } catch { /* nothing to release */ } } }
    if (!served) return refuse('not found', 404);
  }
  const headers = objectHeaders(obj, kind === 'blob' ? 'application/octet-stream' : 'application/json; charset=utf-8', hash);
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

/* ---------------- blob upload ---------------- */

/* The body streams straight to blob/<sha>. R2 receives the path hash as its sha256
 * checksum and refuses to commit mismatched bytes, so a bad upload never becomes visible.
 * The Worker hashes the same stream itself to report 422 and as a second check. */
async function storeBlob(env, hash, body, length) {
  const key = 'blob/' + hash;
  const options = { sha256: hash, httpMetadata: { contentType: 'application/octet-stream', cacheControl: IMMUTABLE } };
  if (length === 0) {
    if (body) { try { await body.cancel(); } catch { /* empty */ } }
    if ((await sha256Hex(new Uint8Array(0))) !== hash) return 'mismatch';
    await env.MODS.put(key, new Uint8Array(0), options);
    return 'stored';
  }
  if (!body) return 'interrupted';
  const digest = new crypto.DigestStream('SHA-256');
  const digestWriter = digest.getWriter();
  const tap = new TransformStream({
    async transform(chunk, controller) { await digestWriter.write(chunk); controller.enqueue(chunk); },
    async flush() { await digestWriter.close(); },
  });
  let failure = null;
  try { await env.MODS.put(key, body.pipeThrough(tap).pipeThrough(new FixedLengthStream(length)), options); }
  catch (error) { failure = error; digestWriter.abort().catch(() => {}); }
  let actual = null;
  try { actual = hex(await digest.digest); } catch { /* incomplete stream */ }
  if (actual !== null && actual !== hash) {
    if (!failure) await env.MODS.delete(key);   // only reachable if storage ignored the checksum
    return 'mismatch';
  }
  if (failure) {
    if (actual === null) return 'interrupted';
    console.log('mods: blob store failed:', String(failure && failure.message).slice(0, 200));
    throw new RequestError('mod store unavailable; try again later', 503);
  }
  return 'stored';
}

async function putBlob(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const type = (req.headers.get('Content-Type') || '').trim().toLowerCase();
  if (type !== 'application/octet-stream') { await discard(req); return refuse('content-type must be application/octet-stream', 415); }
  const declared = req.headers.get('Content-Length');
  if (declared === null) { await discard(req); return refuse('content-length required', 411); }
  if (!/^\d+$/.test(declared)) { await discard(req); return refuse('bad content length', 400); }
  if (Number(declared) > MAX_BLOB) { await discard(req); return refuse('too large', 413); }
  const length = Number(declared);
  if (!(await admit(req, env, [['mod_blob_put', 1]], false))) { await discard(req); return rateLimited(); }
  if (length > 0 && !(await admit(req, env, [['mod_bytes', length]], false))) { await discard(req); return rateLimited(); }
  const existing = await env.MODS.head('blob/' + hash);
  if (existing) {
    /* Read the body to its end before answering: a client still sending would otherwise
     * see a reset connection instead of the idempotent 200. */
    await drain(req);
    const noted = await registry(env, 'noteBlob', hash, existing.size);
    if (noted.deleting) return refuse('blob is being purged; retry shortly', 503, {}, { 'Retry-After': '60' });
    return reply({ blob: hash, size: existing.size }, 200);
  }
  const outcome = await storeBlob(env, hash, req.body, length);
  if (outcome === 'mismatch') return refuse('body does not hash to the path', 422);
  if (outcome === 'interrupted') return refuse('upload interrupted', 400);
  const noted = await registry(env, 'noteBlob', hash, length);
  if (noted.deleting) return refuse('blob is being purged; retry shortly', 503, {}, { 'Retry-After': '60' });
  return reply({ blob: hash, size: length }, 201);
}

/* ---------------- bundle upload ---------------- */

async function putBundle(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  if (!(await admit(req, env, [['mod_bundle_put', 1]], false))) { await discard(req); return rateLimited(); }
  const bytes = await readBody(req, MAX_BUNDLE_JSON);
  let text, manifest;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return refuse('bad utf-8', 400); }
  try { manifest = JSON.parse(text); }
  catch { return refuse('bad json', 400); }
  const error = manifestError(manifest);
  if (error) return refuse(error, 422);
  const canonical = canonicalText(manifest);
  if ((await sha256Hex(canonical)) !== hash) return refuse('canonical manifest does not hash to the path', 422);
  if (manifest.bundle !== undefined && manifest.bundle !== hash) return refuse('bundle field does not match the path', 422);
  /* The body must be the canonical text itself (optionally with "bundle"), so every parser
   * that reads the stored body sees exactly the manifest that was hashed. */
  if (text !== canonical && !(manifest.bundle !== undefined && text === canonicalText(manifest, true))) {
    return refuse('body is not the canonical manifest text', 422);
  }
  const carried = manifest.files.filter(file => file.blob !== undefined);
  const blocked = [...new Set(carried.map(file => file.blob))].filter(blob => blockedSet(env).has(blob));
  if (blocked.length) return blockedResponse(blocked);
  const registered = await registry(env, 'registerBundle', hash, carried.map(file => ({ blob: file.blob, size: file.size })));
  if (registered.missing?.length) {
    return refuse('missing blobs', 409, { missing: registered.missing.slice(0, MISSING_SHOWN), missingCount: registered.missing.length });
  }
  if (registered.mismatched?.length) return refuse('file size does not match the stored blob: ' + registered.mismatched[0], 422);
  const key = 'bundle/' + hash;
  if (await env.MODS.head(key)) return reply({ bundle: hash }, 200);
  await env.MODS.put(key, bytes, { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: IMMUTABLE } });
  return reply({ bundle: hash }, 201);
}

/* ---------------- queries and claims ---------------- */

function hashArray(value, max) {
  if (!Array.isArray(value)) throw new RequestError('expected an array of SHA-256 hex strings', 400);
  if (value.length > max) throw new RequestError('too many hashes (max ' + max + ')', 400);
  if (!value.every(hash => typeof hash === 'string' && HEX64.test(hash))) throw new RequestError('bad hash', 400);
  return [...new Set(value)];
}

async function postMissing(req, env) {
  if (!(await admit(req, env, [['mod_get', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readJsonObject(req, MAX_MISSING_JSON);
  const list = hashArray(body.blobs, MAX_QUERY);
  if (!list.length) return reply({ missing: [] });
  const blocked = blockedSet(env);
  const missing = new Set(await registry(env, 'missing', list.filter(hash => !blocked.has(hash))));
  return reply({ missing: list.filter(hash => blocked.has(hash) || missing.has(hash)) });
}

async function postClaim(req, env) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readJsonObject(req, MAX_CLAIM_JSON);
  if (!displayText(body.ref, 64) || !body.ref.length || body.ref.length > 64) return refuse('bad ref', 400);
  const bundles = hashArray(body.bundles, MAX_CLAIM_BUNDLES);
  if (!bundles.length) return refuse('no bundles', 400);
  if (body.secret !== undefined && !(typeof body.secret === 'string' && HEX64.test(body.secret))) return refuse('bad secret', 400);
  const blocked = bundles.filter(hash => blockedSet(env).has(hash));
  if (blocked.length) return blockedResponse(blocked);
  const secret = body.secret === undefined ? randomHex(32) : body.secret;
  const result = await registry(env, 'claim', {
    ref: body.ref, bundles, id: randomHex(16), secretHash: await sha256Hex(secret),
    presentedHash: body.secret === undefined ? null : await sha256Hex(body.secret),
  });
  if (result.forbidden) return refuse('no claim matches this ref and secret', 403);
  if (result.missing) return refuse('unknown bundles', 409, { missing: result.missing.slice(0, MISSING_SHOWN), missingCount: result.missing.length });
  return reply({ claim: result.claim, secret }, result.created ? 201 : 200);
}

async function postRelease(req, env) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readJsonObject(req, MAX_CLAIM_JSON);
  if (typeof body.claim !== 'string' || !HEX32.test(body.claim)) return refuse('bad claim', 400);
  if (typeof body.secret !== 'string' || !HEX64.test(body.secret)) return refuse('bad secret', 400);
  const result = await registry(env, 'release', body.claim, await sha256Hex(body.secret));
  if (result.notFound) return refuse('no such claim', 404);
  if (result.forbidden) return refuse('wrong secret', 403);
  return new Response(null, { status: 204 });
}

/* ---------------- routing ---------------- */

function notAllowed(req, allow) {
  return discard(req).then(() => refuse('method not allowed', 405, {}, { Allow: allow }));
}

/* Handles every path under /mods; anonymous, no session, no Turnstile. */
export async function handleMods(req, env, path) {
  if (!env.MODS || !env.MOD_REGISTRY || !env.WRITE_QUOTAS) { await discard(req); return refuse('mod store not configured', 503); }
  const object = path.match(/^\/mods\/(blob|bundle)\/([0-9a-fA-F]{64})$/);
  if (object) {
    const [, kind, raw] = object;
    if (raw !== raw.toLowerCase()) { await discard(req); return refuse('hash must be lowercase hex', 400); }
    if (req.method === 'GET' || req.method === 'HEAD') return serveObject(req, env, kind, raw);
    if (req.method === 'PUT') return kind === 'blob' ? putBlob(req, env, raw) : putBundle(req, env, raw);
    return notAllowed(req, 'GET, HEAD, PUT');
  }
  const action = { '/mods/missing': postMissing, '/mods/claim': postClaim, '/mods/release': postRelease }[path];
  if (action) return req.method === 'POST' ? action(req, env) : notAllowed(req, 'POST');
  await discard(req);
  return refuse('not found', 404);
}

/* ---------------- scheduled purge ---------------- */

/* Deletes unclaimed bundles older than the claim window, then blobs older than the window
 * that no remaining bundle names. Bounded per run; the next run continues. */
export async function purgeMods(env, { batch = PURGE_BATCH, rounds = PURGE_ROUNDS } = {}) {
  let bundles = 0, blobs = 0;
  for (let i = 0; i < rounds; i++) {
    const doomed = await registry(env, 'purgeBundles', batch);
    if (doomed.length) await env.MODS.delete(doomed.map(hash => 'bundle/' + hash));
    bundles += doomed.length;
    if (doomed.length < batch) break;
  }
  for (let i = 0; i < rounds; i++) {
    const doomed = await registry(env, 'purgeBlobs', batch);
    if (doomed.length) {
      await env.MODS.delete(doomed.map(hash => 'blob/' + hash));
      await registry(env, 'finishBlobs', doomed);
    }
    blobs += doomed.length;
    if (doomed.length < batch) break;
  }
  console.log('mods purge: deleted ' + bundles + ' bundles and ' + blobs + ' blobs');
  return { bundles, blobs };
}

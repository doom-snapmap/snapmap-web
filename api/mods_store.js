/* Anonymous mod store: one object per mod build. A build is a stored ZIP of the mod's
 * folder (mod.json and the assets/ files its builder block lists), named by the build hash
 * the product computed. Nothing is browsable: every object is reachable only by hash.
 * MODS R2 holds the archives under build/<hash>; the MOD_REGISTRY Durable Object indexes
 * them and holds the claims that keep them served; WRITE_QUOTAS enforces hourly limits per
 * hashed client address. See README.md. */

import { RequestError, readJsonObject } from './request_body.js';

/* Under the 100 MB request body limit of the Free and Pro plans. */
export const MAX_ARCHIVE = 96 * 1024 * 1024;
export const MAX_MODJSON = 1024 * 1024;
export const MAX_FILES = 4096;
export const MAX_CLAIM_BUILDS = 256;
export const CLAIM_WINDOW_MS = 3600000;   // upload-before-claim window (one hour), as in mods_registry_store.js
const MAX_CLAIM_JSON = 64 * 1024;
const MISSING_SHOWN = 100;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PURGE_BATCH = 500;
const PURGE_ROUNDS = 20;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SALT_RE = /^[a-z][a-z0-9]{7}$/;
const SEGMENT_RE = /^[a-z0-9_.~$#@+=,()&!' -]+$/;
const CVAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COMMAND_LINE_RE = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
const EXTENSIONS = new Set(['decl', 'bmd6model', 'bmd6skl', 'bmd6anim', 'bimage', 'bmodel', 'bcm', 'bnk', 'json', 'bin', 'vspv', 'fspv', 'cspv', 'mrpr', 'dmodel']);
const BLOCK_KEY = 'snapmap-plus';

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

/* MODS_BLOCKED is a Worker variable holding a JSON array of blocked build hashes. A
 * malformed list fails closed so an editing mistake cannot unblock anything. */
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

/* ---------------- request paths ---------------- */

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function displayText(value, max) {
  return typeof value === 'string' && value.isWellFormed() && [...value].length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function validSalt(salt) {
  return typeof salt === 'string' && SALT_RE.test(salt);
}

/* Request paths are lowercase, relative and made of plain segments: no leading slash, no
 * backslash, no empty, "." or ".." segment, no segment ending in a dot or space, and (for
 * a carried file) a whitelisted extension. A virtual-texture family member is admitted
 * only under the mod's own virtualtextures/mods/<salt>/, member 1 to 16, never a stock
 * _vmtr family (the product's builder, modbundle.c sh_mb_vt_member). */
export function requestPathError(path, options = {}) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 512) return 'bad request path';
  if (path.startsWith('/')) return 'absolute request path';
  if (path.includes('\\')) return 'backslash in request path';
  if (path !== path.toLowerCase()) return 'request path is not lowercase';
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return 'path traversal';
    if (!segment || !SEGMENT_RE.test(segment) || /[. ]$/.test(segment) || segment.startsWith(' ')) return 'bad request path segment';
  }
  if (options.extension === false) return null;
  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1) : '';
  if (ext === 'bswf') return path.startsWith('generated/swf/') ? null : 'extension not allowed';
  if (ext === 'mega2') {
    const prefix = 'virtualtextures/mods/' + (options.salt || '') + '/';
    const ok = options.salt && path.startsWith(prefix) && /_sq(?:[1-9]|1[0-6])\.mega2$/.test(path) &&
      path.length > prefix.length && !path.slice(prefix.length).includes('_vmtr');
    return ok ? null : 'extension not allowed';
  }
  if (!EXTENSIONS.has(ext) && !/^baas_[a-z0-9]+$/.test(ext)) return 'extension not allowed';
  return null;
}

function clip(text) {
  return String(text).slice(0, 200);
}

/* ---------------- the archive ---------------- */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_UTF8 = 0x0800;
const MAX_NAME = 1024;
const MAX_ENTRIES = MAX_FILES + 1;
/* The central directory and end record: at most MAX_ENTRIES records of 46 bytes, a name,
 * an extra field and a comment each, plus the end record and its comment. */
const MAX_TAIL = 8 * 1024 * 1024;
const NAME_DECODER = new TextDecoder('utf-8', { fatal: true });

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;

/* null when an extra field is well formed and holds no ZIP64 record, else the cause. */
function extraError(bytes) {
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 4) return 'a malformed extra field';
    const id = u16(bytes, at), len = u16(bytes, at + 2);
    if (id === 0x0001) return 'a ZIP64 archive';
    at += 4 + len;
    if (at > bytes.length) return 'a malformed extra field';
  }
  return null;
}

/* Reads an archive as it streams past, one chunk at a time, holding only headers, the
 * central directory and mod.json. The form is the product's (modzip.c): stored entries
 * with their sizes in the local header, then the central directory, then the end record;
 * nothing before, between or after. error is the first cause; once set, later bytes are
 * ignored. */
export class ArchiveWalker {
  constructor(length) {
    this.length = length;
    this.at = 0;                     // bytes consumed
    this.state = 'head';
    this.head = new Uint8Array(30 + MAX_NAME + 65535);
    this.need = 4;
    this.have = 0;
    this.headStart = 0;
    this.current = null;
    this.remaining = 0;
    this.entries = [];
    this.names = new Set();
    this.modjson = null;
    this.captured = 0;
    this.tail = null;
    this.tailLength = 0;
    this.tailStart = 0;
    this.error = null;
    this.done = false;
  }

  fail(cause) {
    if (!this.error) this.error = cause;
  }

  push(chunk) {
    if (this.error) { this.at += chunk.byteLength; return; }
    let i = 0;
    while (i < chunk.byteLength && !this.error) {
      if (this.state === 'data') {
        const n = Math.min(this.remaining, chunk.byteLength - i);
        if (this.current.capture) { this.modjson.set(chunk.subarray(i, i + n), this.captured); this.captured += n; }
        this.remaining -= n; i += n; this.at += n;
        if (this.remaining === 0) this.nextHeader();
        continue;
      }
      if (this.state === 'tail') {
        const n = chunk.byteLength - i;
        if (this.tailLength + n > this.tail.length) { this.fail('the central directory is too large'); break; }
        this.tail.set(chunk.subarray(i, i + n), this.tailLength);
        this.tailLength += n; i += n; this.at += n;
        continue;
      }
      if (this.have === 0) this.headStart = this.at;
      const n = Math.min(this.need - this.have, chunk.byteLength - i);
      this.head.set(chunk.subarray(i, i + n), this.have);
      this.have += n; i += n; this.at += n;
      if (this.have === this.need) this.headerStep();
    }
    if (this.error) this.at += chunk.byteLength - i;
  }

  nextHeader() {
    this.state = 'head';
    this.need = 4;
    this.have = 0;
    this.current = null;
  }

  headerStep() {
    const b = this.head;
    if (this.need === 4) {
      const sig = u32(b, 0);
      if (sig === SIG_LOCAL) { this.need = 30; return; }
      if (sig === SIG_CENTRAL || sig === SIG_END || sig === SIG_ZIP64_END) {
        this.state = 'tail';
        this.tailStart = this.headStart;
        this.tail = new Uint8Array(Math.min(MAX_TAIL, this.length - this.headStart));
        this.tail.set(b.subarray(0, 4));
        this.tailLength = 4;
        return;
      }
      this.fail(this.headStart === 0 ? 'not a ZIP archive' : 'unexpected bytes after an entry');
      return;
    }
    if (this.need === 30) {
      const flags = u16(b, 6), method = u16(b, 8), csize = u32(b, 18), usize = u32(b, 22), nameLength = u16(b, 26);
      if (flags & 0x0001) return this.fail('an encrypted entry');
      if (flags & 0x0008) return this.fail('an entry without its sizes in the local header');
      if (flags & ~FLAG_UTF8) return this.fail('an entry with unsupported flags');
      if (csize === 0xffffffff || usize === 0xffffffff) return this.fail('a ZIP64 archive');
      if (method !== 0) return this.fail('a compressed entry; the archive must be stored');
      if (csize !== usize) return this.fail('a stored entry whose sizes disagree');
      if (nameLength < 1 || nameLength > MAX_NAME) return this.fail('an entry name of bad length');
      this.current = { flags, crc: u32(b, 14), size: usize, nameLength, extraLength: u16(b, 28), offset: this.headStart };
      this.need = 30 + nameLength + this.current.extraLength;
      return;
    }
    const entry = this.current;
    let name;
    try { name = NAME_DECODER.decode(b.subarray(30, 30 + entry.nameLength)); }
    catch { return this.fail('an entry name that is not UTF-8'); }
    const extra = extraError(b.subarray(30 + entry.nameLength, this.need));
    if (extra) return this.fail(extra);
    if (this.names.has(name)) return this.fail('two entries named ' + clip(name));
    if (this.entries.length >= MAX_ENTRIES) return this.fail('more than ' + MAX_ENTRIES + ' entries');
    entry.name = name;
    this.names.add(name);
    this.entries.push(entry);
    if (name === 'mod.json') {
      if (entry.size > MAX_MODJSON) return this.fail('mod.json is larger than 1 MiB');
      this.modjson = new Uint8Array(entry.size);
      entry.capture = true;
    }
    if (entry.size === 0) { this.nextHeader(); return; }
    this.state = 'data';
    this.remaining = entry.size;
  }

  /* After the last byte: checks the central directory and the end record against the
   * entries read. Sets error, or done. */
  finish() {
    if (this.error) return;
    if (this.at !== this.length) return this.fail('the archive is shorter than its Content-Length');
    if (this.state !== 'tail') return this.fail('the archive ends before its central directory');
    const t = this.tail, n = this.tailLength;
    let at = 0;
    for (const entry of this.entries) {
      if (n - at < 46 || u32(t, at) !== SIG_CENTRAL) return this.fail('the central directory does not list every entry');
      const flags = u16(t, at + 8), method = u16(t, at + 10), crc = u32(t, at + 16), csize = u32(t, at + 20), usize = u32(t, at + 24);
      const nameLength = u16(t, at + 28), extraLength = u16(t, at + 30), commentLength = u16(t, at + 32);
      const disk = u16(t, at + 34), offset = u32(t, at + 42);
      const end = at + 46 + nameLength + extraLength + commentLength;
      if (end > n) return this.fail('a truncated central directory');
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff || disk === 0xffff) return this.fail('a ZIP64 archive');
      const extra = extraError(t.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
      if (extra) return this.fail(extra);
      let name;
      try { name = NAME_DECODER.decode(t.subarray(at + 46, at + 46 + nameLength)); }
      catch { return this.fail('an entry name that is not UTF-8'); }
      if (name !== entry.name || flags !== entry.flags || method !== 0 || crc !== entry.crc || csize !== entry.size ||
          usize !== entry.size || disk !== 0 || offset !== entry.offset) {
        return this.fail('the central directory disagrees with the entry ' + clip(entry.name));
      }
      at = end;
    }
    if (n - at >= 4) {
      const sig = u32(t, at);
      if (sig === SIG_ZIP64_END || sig === SIG_ZIP64_LOCATOR) return this.fail('a ZIP64 archive');
      if (sig === SIG_CENTRAL) return this.fail('the central directory lists an entry the archive does not hold');
    }
    if (n - at < 22 || u32(t, at) !== SIG_END) return this.fail('no end of central directory record');
    const disk = u16(t, at + 4), cdDisk = u16(t, at + 6), onDisk = u16(t, at + 8), total = u16(t, at + 10);
    const cdSize = u32(t, at + 12), cdOffset = u32(t, at + 16), commentLength = u16(t, at + 20);
    if (onDisk === 0xffff || total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return this.fail('a ZIP64 archive');
    if (disk !== 0 || cdDisk !== 0) return this.fail('a split archive');
    if (onDisk !== this.entries.length || total !== this.entries.length) return this.fail('the end record counts the entries wrongly');
    if (cdSize !== at || cdOffset !== this.tailStart) return this.fail('the end record places the central directory wrongly');
    if (at + 22 + commentLength !== n) return this.fail('bytes after the end record');
    this.done = true;
  }
}

/* The archive's mod.json against its entries. Returns { salt } or { error }. */
export function buildVerdict(hash, entries, modjson) {
  if (!modjson) return { error: 'the archive has no mod.json' };
  let text, doc;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(modjson); }
  catch { return { error: 'mod.json is not UTF-8' }; }
  try { doc = JSON.parse(text); }
  catch { return { error: 'mod.json is not JSON' }; }
  if (!plainObject(doc)) return { error: 'mod.json is not a JSON object' };
  const block = doc[BLOCK_KEY];
  if (!plainObject(block)) return { error: 'mod.json has no "snapmap-plus" block' };
  if (block.format !== 2) return { error: 'mod.json is not format 2' };
  if (!validSalt(block.salt)) return { error: 'mod.json has no valid salt' };
  const salt = block.salt;
  if (typeof block.build !== 'string' || !HEX64.test(block.build)) return { error: 'mod.json has no build hash' };
  if (block.build !== hash) return { error: 'mod.json build does not match the path' };
  const requirements = requirementsError(doc.requirements);
  if (requirements) return { error: requirements };
  if (!Array.isArray(block.files)) return { error: 'mod.json has no file list' };
  if (block.files.length > MAX_FILES) return { error: 'too many files' };
  const carried = new Map();
  for (const file of block.files) {
    if (!plainObject(file) || typeof file.path !== 'string' || !file.path.startsWith('assets/')) return { error: 'mod.json lists a bad file entry' };
    const request = file.path.slice(7);
    const error = requestPathError(request, { salt });
    if (error) return { error: error + ': ' + clip(file.path) };
    if (carried.has(file.path)) return { error: 'mod.json lists a file twice: ' + clip(file.path) };
    if (typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)) return { error: 'bad file hash: ' + clip(file.path) };
    if (!Number.isSafeInteger(file.size) || file.size < 0) return { error: 'bad file size: ' + clip(file.path) };
    carried.set(file.path, file.size);
  }
  /* A pointer names the player's own installed content and never uploads. */
  if (block.stock !== undefined) {
    if (!Array.isArray(block.stock) || block.stock.length > MAX_FILES) return { error: 'mod.json has a bad pointer list' };
    for (const pointer of block.stock) {
      if (!plainObject(pointer) || typeof pointer.path !== 'string' || !pointer.path.startsWith('assets/')) return { error: 'mod.json lists a bad pointer' };
      const error = requestPathError(pointer.path.slice(7), { extension: false });
      if (error) return { error: error + ': ' + clip(pointer.path) };
      if (carried.has(pointer.path)) return { error: 'mod.json lists a file and a pointer at ' + clip(pointer.path) };
    }
  }
  for (const entry of entries) {
    if (entry.name === 'mod.json') continue;
    if (!entry.name.startsWith('assets/')) return { error: 'the archive holds an entry outside assets/: ' + clip(entry.name) };
    const error = requestPathError(entry.name.slice(7), { salt });
    if (error) return { error: error + ': ' + clip(entry.name) };
    if (!carried.has(entry.name)) return { error: 'the archive holds a file mod.json does not list: ' + clip(entry.name) };
    if (carried.get(entry.name) !== entry.size) return { error: 'the size of ' + clip(entry.name) + ' does not match mod.json' };
  }
  const present = new Set(entries.map(entry => entry.name));
  for (const path of carried.keys()) if (!present.has(path)) return { error: 'a file mod.json lists is not in the archive: ' + clip(path) };
  return { salt };
}

/* Console lines and cvars the product applies while a mod's requirements are live: the
 * builder's shape and limits. */
function requirementsError(req) {
  if (req === undefined) return null;
  if (!plainObject(req) || Object.keys(req).some(key => key !== 'cvars' && key !== 'commands')) return 'bad requirements';
  if (req.cvars !== undefined) {
    if (!plainObject(req.cvars) || Object.keys(req.cvars).length > 32) return 'bad requirements';
    for (const [name, value] of Object.entries(req.cvars)) {
      if (!CVAR_RE.test(name) || !displayText(value, 64)) return 'bad requirements';
    }
  }
  if (req.commands !== undefined) {
    if (!plainObject(req.commands) || Object.keys(req.commands).some(key => key !== 'activate' && key !== 'deactivate')) return 'bad requirements';
    for (const list of Object.values(req.commands)) {
      if (!Array.isArray(list) || list.length > 16) return 'bad requirements';
      for (const line of list) {
        if (typeof line !== 'string' || !COMMAND_LINE_RE.test(line) || line.includes(';')) return 'bad requirements';
      }
    }
  }
  return null;
}

class ArchiveRefusal extends Error {}

/* The body streams to build/<hash> through the walker. R2 commits an object once it has
 * received the declared length, even if the stream fails afterwards, so the archive's tail
 * (the central directory and end record, which the walker holds anyway) is passed on only
 * after every check has passed. A refused archive therefore never reaches its length: R2
 * commits nothing, and a stored object at that key (an archive being replaced) stays as it
 * was. The whole body is read either way, so a client still sending sees the answer rather
 * than a reset. Returns { salt }, { refusal } or { interrupted }. */
async function storeArchive(env, hash, body, length) {
  if (!body) return { interrupted: true };
  const walker = new ArchiveWalker(length);
  let verdict = null, sent = 0;
  const tap = new TransformStream({
    transform(chunk, controller) {
      const start = walker.at;
      walker.push(chunk);
      if (walker.error) return;
      const limit = walker.state === 'tail' ? walker.tailStart : length - 1;   // a valid archive always ends in its tail
      const count = Math.max(0, Math.min(chunk.byteLength, limit - start));
      if (count) controller.enqueue(count === chunk.byteLength ? chunk : chunk.subarray(0, count));
      sent += count;
    },
    flush(controller) {
      if (walker.at !== length) throw new Error('upload interrupted');
      walker.finish();
      if (!walker.error) {
        verdict = buildVerdict(hash, walker.entries, walker.modjson);
        if (verdict.error) walker.fail(verdict.error);
      }
      if (walker.error) throw new ArchiveRefusal(walker.error);
      controller.enqueue(walker.tail.slice(sent - walker.tailStart, walker.tailLength));
    },
  });
  let failure = null;
  try {
    await env.MODS.put('build/' + hash, body.pipeThrough(tap).pipeThrough(new FixedLengthStream(length)),
      { httpMetadata: { contentType: 'application/zip', cacheControl: IMMUTABLE } });
  } catch (error) { failure = error; }
  if (walker.error) {
    if (!failure) await env.MODS.delete('build/' + hash);   // only reachable if storage ignored the failed stream
    return { refusal: walker.error };
  }
  if (failure) {
    if (walker.at !== length || !walker.done) return { interrupted: true };
    console.log('mods: archive store failed:', clip(failure && failure.message));
    throw new RequestError('mod store unavailable; try again later', 503);
  }
  return { salt: verdict.salt };
}

/* ---------------- build routes ---------------- */

function objectHeaders(obj, hash) {
  const h = new Headers();
  h.set('Content-Type', 'application/zip');
  h.set('Content-Length', String(obj.size));
  h.set('Cache-Control', IMMUTABLE);
  h.set('ETag', '"' + hash + '"');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Content-Disposition', 'attachment');
  return h;
}

/* A build is served while a claim names it, or for one hour after its upload. */
async function serveBuild(req, env, hash) {
  if (blockedSet(env).has(hash)) return blockedResponse([hash]);
  if (!(await admit(req, env, [['mod_get', 1]], true))) return rateLimited();
  if (!(await registry(env, 'buildServed', hash))) return refuse('not found', 404);
  const key = 'build/' + hash;
  const obj = req.method === 'HEAD' ? await env.MODS.head(key) : await env.MODS.get(key);
  if (!obj) return refuse('not found', 404);
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: 200, headers: objectHeaders(obj, hash) });
}

async function putBuild(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/zip') { await discard(req); return refuse('content-type must be application/zip', 415); }
  const declared = req.headers.get('Content-Length');
  if (declared === null) { await discard(req); return refuse('content-length required', 411); }
  if (!/^\d+$/.test(declared)) { await discard(req); return refuse('bad content length', 400); }
  const length = Number(declared);
  if (length > MAX_ARCHIVE) { await discard(req); return refuse('the archive is over 96 MiB', 413); }
  if (length < 22) { await discard(req); return refuse('not a ZIP archive', 422); }
  if (!(await admit(req, env, [['mod_build_put', 1], ['mod_bytes', length]], false))) { await discard(req); return rateLimited(); }
  const row = await registry(env, 'buildRow', hash);
  const existing = row ? await env.MODS.head('build/' + hash) : null;
  if (row && existing && (row.claims > 0 || existing.size === length)) {
    /* Read the body to its end before answering: a client still sending would otherwise
     * see a reset connection instead of the idempotent 200. */
    await drain(req);
    if (row.claims <= 0) await registry(env, 'touchBuild', hash);
    return reply({ build: hash, size: existing.size }, 200);
  }
  /* New, or an unclaimed archive of another size: an upload that validates replaces it
   * (a forged archive cannot hold a hash against the real one for its hour). */
  const outcome = await storeArchive(env, hash, req.body, length);
  if (outcome.refusal) return refuse(outcome.refusal, 422);
  if (outcome.interrupted) return refuse('upload interrupted', 400);
  await registry(env, 'registerBuild', hash, length, outcome.salt);
  return reply({ build: hash, size: length }, 201);
}

/* ---------------- claims ---------------- */

function hashArray(value, max) {
  if (!Array.isArray(value)) throw new RequestError('expected an array of SHA-256 hex strings', 400);
  if (value.length > max) throw new RequestError('too many hashes (max ' + max + ')', 400);
  if (!value.every(hash => typeof hash === 'string' && HEX64.test(hash))) throw new RequestError('bad hash', 400);
  return [...new Set(value)];
}

async function postClaim(req, env) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readJsonObject(req, MAX_CLAIM_JSON);
  if (!displayText(body.ref, 64) || !body.ref.length || body.ref.length > 64) return refuse('bad ref', 400);
  const builds = hashArray(body.builds, MAX_CLAIM_BUILDS);
  if (!builds.length) return refuse('no builds', 400);
  if (body.secret !== undefined && !(typeof body.secret === 'string' && HEX64.test(body.secret))) return refuse('bad secret', 400);
  const blocked = builds.filter(hash => blockedSet(env).has(hash));
  if (blocked.length) return blockedResponse(blocked);
  const secret = body.secret === undefined ? randomHex(32) : body.secret;
  const result = await registry(env, 'claim', {
    ref: body.ref, builds, id: randomHex(16), secretHash: await sha256Hex(secret),
    presentedHash: body.secret === undefined ? null : await sha256Hex(body.secret),
  });
  if (result.forbidden) return refuse('no claim matches this ref and secret', 403);
  if (result.missing) return refuse('unknown builds', 409, { missing: result.missing.slice(0, MISSING_SHOWN), missingCount: result.missing.length });
  await deleteBuilds(env, result.deleted);
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
  await deleteBuilds(env, result.deleted);
  return new Response(null, { status: 204 });
}

/* Builds whose last claim just went are already gone from the index; their archives go
 * now. */
async function deleteBuilds(env, hashes) {
  if (!Array.isArray(hashes) || !hashes.length) return;
  for (let i = 0; i < hashes.length; i += 1000) await env.MODS.delete(hashes.slice(i, i + 1000).map(hash => 'build/' + hash));
}

/* ---------------- maintainer reset ---------------- */

/* Deletes every object in the MODS bucket (build archives, and anything the retired blob
 * and bundle store left) and empties the index. Hidden unless the MODS_ADMIN_TOKEN secret
 * is set, and refused without exactly that bearer token. */
async function postReset(req, env) {
  const expected = env.MODS_ADMIN_TOKEN === undefined ? '' : String(env.MODS_ADMIN_TOKEN).trim();   // a secret piped in keeps its newline
  if (!expected) { await discard(req); return refuse('not found', 404); }
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !(await sameToken(given, expected))) { await discard(req); return refuse('forbidden', 403); }
  await discard(req);
  const deleted = { builds: 0, other: 0 };
  let cursor;
  do {
    const page = await env.MODS.list({ limit: 1000, cursor });
    const keys = page.objects.map(object => object.key);
    if (keys.length) await env.MODS.delete(keys);
    for (const key of keys) deleted[key.startsWith('build/') ? 'builds' : 'other']++;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const index = await registry(env, 'reset');
  console.log('mods reset: deleted ' + deleted.builds + ' builds and ' + deleted.other + ' other objects');
  return reply({ deleted, index });
}

async function sameToken(given, expected) {
  const [a, b] = await Promise.all([sha256Hex(new TextEncoder().encode(given)), sha256Hex(new TextEncoder().encode(expected))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- routing ---------------- */

function notAllowed(req, allow) {
  return discard(req).then(() => refuse('method not allowed', 405, {}, { Allow: allow }));
}

/* Handles every path under /mods; anonymous, no session, no Turnstile. */
export async function handleMods(req, env, path) {
  if (!env.MODS || !env.MOD_REGISTRY || !env.WRITE_QUOTAS) { await discard(req); return refuse('mod store not configured', 503); }
  const build = path.match(/^\/mods\/build\/([0-9a-fA-F]{64})$/);
  if (build) {
    const raw = build[1];
    if (raw !== raw.toLowerCase()) { await discard(req); return refuse('hash must be lowercase hex', 400); }
    if (req.method === 'GET' || req.method === 'HEAD') return serveBuild(req, env, raw);
    if (req.method === 'PUT') return putBuild(req, env, raw);
    return notAllowed(req, 'GET, HEAD, PUT');
  }
  const action = { '/mods/claim': postClaim, '/mods/release': postRelease, '/mods/admin/reset': postReset }[path];
  if (action) return req.method === 'POST' ? action(req, env) : notAllowed(req, 'POST');
  await discard(req);
  return refuse('not found', 404);
}

/* ---------------- scheduled purge ---------------- */

/* Deletes unclaimed builds older than the upload window (uploads nothing ever claimed).
 * Bounded per run; the next run continues. A released build does not wait for this: its
 * last release deletes it. */
export async function purgeMods(env, { batch = PURGE_BATCH, rounds = PURGE_ROUNDS } = {}) {
  let builds = 0;
  for (let i = 0; i < rounds; i++) {
    const doomed = await registry(env, 'purgeBuilds', batch);
    if (doomed.length) await deleteBuilds(env, doomed);
    builds += doomed.length;
    if (doomed.length < batch) break;
  }
  console.log('mods purge: deleted ' + builds + ' builds');
  return { builds };
}

/* Anonymous mod store: one object per mod build. A build is a stored ZIP of the mod's
 * folder (mod.json and the assets/ files its builder block lists), named by the build hash
 * the product computed. Nothing is browsable: every object is reachable only by hash.
 * MODS R2 holds the archives under build/<hash>; the MOD_REGISTRY Durable Object indexes
 * them and holds the claims that keep them served; WRITE_QUOTAS enforces hourly limits per
 * hashed client address. See README.md. */

import { RequestError, readJsonObject } from './request_body.js';

/* Under the 100 MB request body limit of the Free and Pro plans. */
export const MAX_ARCHIVE = 96 * 1024 * 1024;
/* The product's builder limits (snapmap-plus src/backend/modbundle.h): mod.json, files and
 * pointers together, one carried file, one request path in bytes. */
export const MAX_MODJSON = 1024 * 1024;
export const MAX_FILES = 4096;
export const MAX_FILE = 64 * 1024 * 1024;
const MAX_REQUEST = 400;
const MAX_NAME_POINTS = 80;
/* Scripts: Lua source text under assets/mods/<salt>/scripts/ (the scripting design's
 * section 6): each file at most 256 KiB, at most 64 files and 1 MiB per build. */
export const MAX_SCRIPT = 256 * 1024;
export const MAX_SCRIPTS = 64;
export const MAX_SCRIPT_BYTES = 1024 * 1024;
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
/* A path segment's characters as the builder allows them (modbundle.c mb_path_char),
 * lower-cased as every request path is. */
const SEGMENT_RE = /^[a-z0-9._$+@~() -]+$/;
const CVAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PRINTABLE_RE = /^[\x20-\x7e]*$/;
const EXTENSIONS = new Set(['decl', 'bmd6model', 'bmd6skl', 'bmd6anim', 'bimage', 'bmodel', 'bcm', 'bnk', 'json', 'bin', 'vspv', 'fspv', 'cspv', 'mrpr', 'dmodel']);
const BLOCK_KEY = 'snapmap-plus';
/* The builder block's keys (modbundle.c mb_load_root) and the author keys a built mod.json
 * may no longer use (mb_retired_key). A hand-written "version" is not among them: it is an
 * unknown author key, kept and ignored like any other. */
const BLOCK_KEYS = new Set(['build', 'built', 'cause', 'classes', 'edits', 'editor', 'files', 'format', 'registries',
  'rules', 'salt', 'shadows', 'stock', 'tree', 'warnings']);
const RETIRED_KEYS = ['id', 'key', 'shadows', 'stock', 'scope', 'player', 'extends', 'replaces', 'legacy', 'composes', 'schema'];
const FILE_KEYS = ['needs', 'path', 'provides', 'sha256', 'size'];
const POINTER_KEYS = new Set(['closure', 'needs', 'path', 'provides', 'sha256', 'source']);
const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61];   // "\x1bLua", the start of every precompiled chunk

/* Every refusal is one plain sentence the product shows as it is: printable ASCII, at most
 * 160 characters (modnet.c mn_error_text keeps no more). */
export const MAX_REFUSAL = 160;

/* ---------------- responses ---------------- */

const UNAVAILABLE = 'The mod store is unavailable right now; try again later.';
const NOT_FOUND = 'The mod store has nothing at this address.';
const NOT_ZIP = 'The upload is not a ZIP archive.';
const BAD_SECRET = 'The secret is not 64 lowercase hex characters.';

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
    throw new RequestError(UNAVAILABLE, 503);
  }
  blockedCache = { source, set: new Set(list.map(hash => hash.toLowerCase())) };
  return blockedCache.set;
}

function blockedResponse(hashes) {
  return refuse(hashes.length === 1 ? 'This build was taken down from the mod store.' : 'Some of these builds were taken down from the mod store.',
    451, { blocked: hashes.slice(0, MISSING_SHOWN) });
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
    throw new RequestError(UNAVAILABLE, 503);
  }
}

function rateLimited() {
  return refuse('Too many mod store requests came from this address this hour; try again later.', 429, {}, { 'Retry-After': retryAfterHour() });
}

/* ---------------- registry ---------------- */

async function registry(env, method, ...args) {
  try {
    const stub = env.MOD_REGISTRY.get(env.MOD_REGISTRY.idFromName('registry'));
    return await stub[method](...args);
  } catch {
    throw new RequestError(UNAVAILABLE, 503);
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

/* A path or key as a refusal names it: printable ASCII, the end kept when it is long, so
 * that every sentence stays within MAX_REFUSAL. */
function shown(text) {
  const t = String(text).replace(/[^\x20-\x7e]/g, '?');
  return t.length > 72 ? '...' + t.slice(-69) : t;
}

/* What is wrong with a request path (the part below assets/), as the end of a sentence
 * that starts with the path, or null. The rules are the builder's (modbundle.c
 * sh_mb_check_request, mb_rp_forbidden, sh_mb_extension_allowed, sh_mb_vt_member):
 * at most 400 bytes; relative; no backslash; no empty, "." or ".." segment; no segment
 * starting with a space or ending in a dot or space; the builder's characters only. A
 * carried file (options.carried) also needs a type the builder carries and must not be one
 * of the engine's own caches: a cooked movie only under generated/swf/, a virtual-texture
 * member only as the mod's own virtualtextures/mods/<salt>/..._sq1 to _sq16 outside any
 * stock _vmtr family, and a script (.lua) only under the mod's mods/<salt>/scripts/. */
export function pathFault(request, options = {}) {
  if (typeof request !== 'string' || request.length < 1) return 'has an empty path';
  if (request.length > MAX_REQUEST) return 'has a path longer than ' + MAX_REQUEST + ' characters';
  if (request.startsWith('/')) return 'is an absolute path';
  if (request.includes('\\')) return 'contains a backslash';
  const segments = request.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return 'climbs out of its folder with "." or ".."';
    if (!segment) return 'has an empty folder name';
    if (segment.startsWith(' ') || /[. ]$/.test(segment)) return 'has a name that starts with a space or ends in a dot or a space';
    if (!SEGMENT_RE.test(segment)) return 'has a character a mod path may not use';
  }
  if (!options.carried) return null;
  const leaf = segments[segments.length - 1];
  if (request.startsWith('decls/renderprogs/') || request.startsWith('generated/glslbinaries/') ||
      request.startsWith('generated/glsl/') || leaf === 'vulkan_pipelines.bin') return 'is an engine file a mod may not ship';
  const dot = leaf.lastIndexOf('.');
  const ext = dot >= 0 ? leaf.slice(dot + 1) : null;
  if (ext === 'lua') {
    const folder = 'mods/' + (options.salt || '') + '/scripts/';
    return options.salt && request.startsWith(folder) && dot > 0 ? null
      : 'is a script outside this mod\'s mods/' + (options.salt || '<salt>') + '/scripts/ folder';
  }
  if (ext === 'bswf') return request.startsWith('generated/swf/') ? null : 'is a movie outside generated/swf/';
  if (ext === 'mega2') {
    const prefix = 'virtualtextures/mods/' + (options.salt || '') + '/';
    const ok = options.salt && request.startsWith(prefix) && /_sq(?:[1-9]|1[0-6])\.mega2$/.test(request) &&
      request.length > prefix.length && !request.slice(prefix.length).includes('_vmtr');
    return ok ? null : 'is not one of this mod\'s own virtual-texture members';
  }
  if (ext === null || (!EXTENSIONS.has(ext) && !/^baas_[a-z0-9_]+$/.test(ext))) return 'is a type of file a mod cannot carry';
  return null;
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
const ZIP64 = 'The archive uses ZIP64, which Snapmap+ never writes.';
const MALFORMED_EXTRA = 'The archive has a malformed extra field.';

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;

/* null when an extra field is well formed and holds no ZIP64 record, else the refusal. */
function extraError(bytes) {
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 4) return MALFORMED_EXTRA;
    const id = u16(bytes, at), len = u16(bytes, at + 2);
    if (id === 0x0001) return ZIP64;
    at += 4 + len;
    if (at > bytes.length) return MALFORMED_EXTRA;
  }
  return null;
}

function isScript(name) {
  return name.toLowerCase().endsWith('.lua');
}

/* Reads an archive as it streams past, one chunk at a time, holding only headers, the
 * central directory, mod.json and the scripts (which their caps keep small). The form is
 * the product's (modzip.c): stored entries with their sizes in the local header, then the
 * central directory, then the end record; nothing before, between or after. error is the
 * first refusal; once set, later bytes are ignored. */
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
    this.scripts = 0;
    this.scriptBytes = 0;
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
        const entry = this.current;
        if (entry.data) { entry.data.set(chunk.subarray(i, i + n), entry.captured); entry.captured += n; }
        this.remaining -= n; i += n; this.at += n;
        if (this.remaining === 0) this.nextHeader();
        continue;
      }
      if (this.state === 'tail') {
        const n = chunk.byteLength - i;
        if (this.tailLength + n > this.tail.length) { this.fail('The archive\'s central directory is too large.'); break; }
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
      this.fail(this.headStart === 0 ? NOT_ZIP : 'The archive has unexpected bytes after an entry.');
      return;
    }
    if (this.need === 30) {
      const flags = u16(b, 6), method = u16(b, 8), csize = u32(b, 18), usize = u32(b, 22), nameLength = u16(b, 26);
      if (flags & 0x0001) return this.fail('The archive has an encrypted entry.');
      if (flags & 0x0008) return this.fail('The archive has an entry without its sizes in its local header.');
      if (flags & ~FLAG_UTF8) return this.fail('The archive has an entry with flags Snapmap+ never writes.');
      if (csize === 0xffffffff || usize === 0xffffffff) return this.fail(ZIP64);
      if (method !== 0) return this.fail('The archive has a compressed entry; Snapmap+ stores every file uncompressed.');
      if (csize !== usize) return this.fail('The archive has a stored entry whose two sizes disagree.');
      if (nameLength < 1 || nameLength > MAX_NAME) return this.fail('The archive has an entry name of a bad length.');
      this.current = { flags, crc: u32(b, 14), size: usize, nameLength, extraLength: u16(b, 28), offset: this.headStart };
      this.need = 30 + nameLength + this.current.extraLength;
      return;
    }
    const entry = this.current;
    let name;
    try { name = NAME_DECODER.decode(b.subarray(30, 30 + entry.nameLength)); }
    catch { return this.fail('The archive has an entry name that is not UTF-8.'); }
    const extra = extraError(b.subarray(30 + entry.nameLength, this.need));
    if (extra) return this.fail(extra);
    if (this.names.has(name)) return this.fail('The archive holds ' + shown(name) + ' twice.');
    if (this.entries.length >= MAX_ENTRIES) return this.fail('The archive holds more than ' + MAX_FILES + ' files besides mod.json.');
    entry.name = name;
    this.names.add(name);
    this.entries.push(entry);
    if (name === 'mod.json') {
      if (entry.size > MAX_MODJSON) return this.fail('The archive\'s mod.json is larger than 1 MiB.');
      entry.data = this.modjson = new Uint8Array(entry.size);
      entry.captured = 0;
    } else if (isScript(name)) {
      if (entry.size > MAX_SCRIPT) return this.fail('The script ' + shown(name) + ' is larger than 256 KiB.');
      if (++this.scripts > MAX_SCRIPTS) return this.fail('The mod carries more than ' + MAX_SCRIPTS + ' scripts.');
      this.scriptBytes += entry.size;
      if (this.scriptBytes > MAX_SCRIPT_BYTES) return this.fail('The mod\'s scripts come to more than 1 MiB.');
      entry.data = new Uint8Array(entry.size);
      entry.captured = 0;
    }
    if (entry.size === 0) { this.nextHeader(); return; }
    this.state = 'data';
    this.remaining = entry.size;
  }

  /* After the last byte: checks the central directory and the end record against the
   * entries read. Sets error, or done. */
  finish() {
    if (this.error) return;
    if (this.at !== this.length) return this.fail('The archive is shorter than its Content-Length.');
    if (this.state !== 'tail') return this.fail('The archive ends before its central directory.');
    const t = this.tail, n = this.tailLength;
    let at = 0;
    for (const entry of this.entries) {
      if (n - at < 46 || u32(t, at) !== SIG_CENTRAL) return this.fail('The archive\'s central directory does not list every entry.');
      const flags = u16(t, at + 8), method = u16(t, at + 10), crc = u32(t, at + 16), csize = u32(t, at + 20), usize = u32(t, at + 24);
      const nameLength = u16(t, at + 28), extraLength = u16(t, at + 30), commentLength = u16(t, at + 32);
      const disk = u16(t, at + 34), offset = u32(t, at + 42);
      const end = at + 46 + nameLength + extraLength + commentLength;
      if (end > n) return this.fail('The archive\'s central directory is cut short.');
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff || disk === 0xffff) return this.fail(ZIP64);
      const extra = extraError(t.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
      if (extra) return this.fail(extra);
      let name;
      try { name = NAME_DECODER.decode(t.subarray(at + 46, at + 46 + nameLength)); }
      catch { return this.fail('The archive has an entry name that is not UTF-8.'); }
      if (name !== entry.name || flags !== entry.flags || method !== 0 || crc !== entry.crc || csize !== entry.size ||
          usize !== entry.size || disk !== 0 || offset !== entry.offset) {
        return this.fail('The archive\'s central directory disagrees with its entry ' + shown(entry.name) + '.');
      }
      at = end;
    }
    if (n - at >= 4) {
      const sig = u32(t, at);
      if (sig === SIG_ZIP64_END || sig === SIG_ZIP64_LOCATOR) return this.fail(ZIP64);
      if (sig === SIG_CENTRAL) return this.fail('The archive\'s central directory lists an entry the archive does not hold.');
    }
    if (n - at < 22 || u32(t, at) !== SIG_END) return this.fail('The archive has no end of central directory record.');
    const disk = u16(t, at + 4), cdDisk = u16(t, at + 6), onDisk = u16(t, at + 8), total = u16(t, at + 10);
    const cdSize = u32(t, at + 12), cdOffset = u32(t, at + 16), commentLength = u16(t, at + 20);
    if (onDisk === 0xffff || total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return this.fail(ZIP64);
    if (disk !== 0 || cdDisk !== 0) return this.fail('The archive is split across several files.');
    if (onDisk !== this.entries.length || total !== this.entries.length) return this.fail('The archive\'s end record counts its entries wrongly.');
    if (cdSize !== at || cdOffset !== this.tailStart) return this.fail('The archive\'s end record places its central directory wrongly.');
    if (at + 22 + commentLength !== n) return this.fail('The archive has bytes after its end record.');
    this.done = true;
  }
}

const MODJSON = 'The archive\'s mod.json ';
const UNWRITTEN_FILE = MODJSON + 'lists a file entry Snapmap+ did not write.';
const UNWRITTEN_POINTER = MODJSON + 'lists a pointer entry Snapmap+ did not write.';
const POINTER_REQUIRED = ['path', 'sha256', 'source', 'provides', 'needs'];

/* The archive's mod.json against its entries, by the rules the product's own reader applies
 * to a built mod.json (modbundle.c mb_load_root, mb_descriptor_root, mb_common_fields,
 * mb_requirements, mb_load_block_file) and to a downloaded archive (modsync.c
 * msy_archive_matches): every carried file the block lists is in the archive at
 * assets/<its request path, in lower case>, and nothing else is. The Worker does not
 * recompute the build hash or check what each file provides; the product does both before
 * it installs. There is no mod version anywhere in this: a "version" key an author wrote is
 * an unknown author key and is ignored. Returns { salt } or { error }. */
export function buildVerdict(hash, entries, modjson) {
  if (!modjson) return { error: 'The archive has no mod.json.' };
  let text, doc;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(modjson); }
  catch { return { error: MODJSON + 'is not UTF-8 text.' }; }
  try { doc = JSON.parse(text); }
  catch { return { error: MODJSON + 'is not valid JSON.' }; }
  if (!plainObject(doc)) return { error: MODJSON + 'is not a JSON object.' };
  const block = doc[BLOCK_KEY];
  if (!plainObject(block)) return { error: MODJSON + 'has no "snapmap-plus" block, so the mod was never built.' };
  if (block.format !== 2) return { error: MODJSON + 'is not in format 2, the only one Snapmap+ builds.' };
  for (const key of Object.keys(block)) {
    if (!BLOCK_KEYS.has(key)) return { error: MODJSON + 'has a key Snapmap+ does not write in its "snapmap-plus" block: ' + shown(key) + '.' };
  }
  if (!validSalt(block.salt)) return { error: MODJSON + 'has no valid salt.' };
  const salt = block.salt;
  if (block.cause !== undefined) return { error: MODJSON + 'records a build that failed; fix the mod and build it again.' };
  if (typeof block.build !== 'string' || !HEX64.test(block.build)) return { error: MODJSON + 'has no build hash.' };
  if (block.build !== hash) return { error: MODJSON + 'names another build than the one uploaded.' };
  if ((block.built !== undefined && !(Number.isSafeInteger(block.built) && block.built >= 0)) ||
      (block.rules !== undefined && !(Number.isSafeInteger(block.rules) && block.rules >= 0)) ||
      (block.tree !== undefined && !(typeof block.tree === 'string' && HEX64.test(block.tree)))) {
    return { error: MODJSON + 'has a "snapmap-plus" block Snapmap+ did not write.' };
  }
  const author = authorError(doc);
  if (author) return { error: author };

  if (!Array.isArray(block.files)) return { error: MODJSON + 'has no file list.' };
  const pointers = block.stock === undefined ? [] : block.stock;
  if (!Array.isArray(pointers)) return { error: UNWRITTEN_POINTER };
  if (block.files.length + pointers.length > MAX_FILES) return { error: MODJSON + 'lists more than ' + MAX_FILES + ' files.' };
  const carried = new Map(), requests = new Set();
  for (const file of block.files) {
    const keys = plainObject(file) ? Object.keys(file) : [];
    if (keys.length !== FILE_KEYS.length || !FILE_KEYS.every(key => keys.includes(key)) || typeof file.path !== 'string' ||
        !file.path.startsWith('assets/')) {
      return { error: UNWRITTEN_FILE };
    }
    const request = file.path.slice(7).toLowerCase();
    const fault = pathFault(request, { salt, carried: true });
    if (fault) return { error: 'The file ' + shown(file.path) + ' ' + fault + '.' };
    if (requests.has(request)) return { error: MODJSON + 'lists ' + shown(file.path) + ' twice.' };
    if (typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)) return { error: MODJSON + 'gives ' + shown(file.path) + ' no valid hash.' };
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE) {
      return { error: MODJSON + 'gives ' + shown(file.path) + ' a size outside 1 byte to 64 MiB.' };
    }
    if (!providesOk(file.provides) || !needsOk(file.needs)) return { error: UNWRITTEN_FILE };
    requests.add(request);
    carried.set(request, file.size);
  }
  /* A pointer names the player's own installed content and never uploads. */
  for (const pointer of pointers) {
    const keys = plainObject(pointer) ? Object.keys(pointer) : [];
    if (!keys.every(key => POINTER_KEYS.has(key)) || POINTER_REQUIRED.some(key => !keys.includes(key)) ||
        typeof pointer.path !== 'string' || !pointer.path.startsWith('assets/') || typeof pointer.sha256 !== 'string' ||
        !HEX64.test(pointer.sha256) || typeof pointer.source !== 'string' || !pointer.source ||
        pointer.source !== pointer.source.toLowerCase() || pointer.source.includes('\\') ||
        (pointer.closure !== undefined && typeof pointer.closure !== 'boolean') || !providesOk(pointer.provides) || !needsOk(pointer.needs)) {
      return { error: UNWRITTEN_POINTER };
    }
    const request = pointer.path.slice(7).toLowerCase();
    const fault = pathFault(request);
    if (fault) return { error: 'The pointer ' + shown(pointer.path) + ' ' + fault + '.' };
    if (requests.has(request)) return { error: MODJSON + 'lists ' + shown(pointer.path) + ' twice.' };
    requests.add(request);
  }

  for (const entry of entries) {
    if (entry.name === 'mod.json') continue;
    if (!entry.name.startsWith('assets/')) return { error: 'The archive holds ' + shown(entry.name) + ', which is outside assets/.' };
    const request = entry.name.slice(7);
    if (request !== request.toLowerCase()) return { error: 'The archive holds ' + shown(entry.name) + ', whose path is not in lower case.' };
    const fault = pathFault(request, { salt, carried: true });
    if (fault) return { error: 'The file ' + shown(entry.name) + ' ' + fault + '.' };
    if (!carried.has(request)) return { error: 'The archive holds ' + shown(entry.name) + ', which mod.json does not list.' };
    if (carried.get(request) !== entry.size) return { error: 'The size of ' + shown(entry.name) + ' does not match mod.json.' };
    if (entry.data) {
      const script = scriptError(entry.data);
      if (script) return { error: 'The script ' + shown(entry.name) + ' ' + script + '.' };
    }
  }
  const present = new Set(entries.map(entry => entry.name));
  for (const request of carried.keys()) {
    if (!present.has('assets/' + request)) return { error: 'The archive lacks ' + shown('assets/' + request) + ', which mod.json lists.' };
  }
  return { salt };
}

function providesOk(value) {
  return plainObject(value) && Object.keys(value).length === 2 && typeof value.type === 'string' && typeof value.name === 'string';
}

function needsOk(value) {
  return Array.isArray(value) && value.every(need => plainObject(need) && Object.keys(need).length === 2 &&
    typeof need.type === 'string' && need.type.length > 0 && typeof need.name === 'string' && need.name.length > 0);
}

/* A script is Lua source: not a precompiled chunk, no NUL, UTF-8 throughout. */
function scriptError(bytes) {
  if (LUA_SIGNATURE.every((byte, i) => bytes[i] === byte)) return 'is compiled Lua bytecode; a mod carries its scripts as source text';
  if (bytes.includes(0)) return 'contains a NUL byte; a script must be plain text';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return 'is not UTF-8 text'; }
  return null;
}

/* The author part of a built mod.json as the product reads it back: no retired key, no
 * builder member at the top level, a name, short display text, and requirements in the
 * builder's shape. Every other key is the author's own and is ignored, "version" included. */
function authorError(doc) {
  for (const key of RETIRED_KEYS) {
    if (Object.hasOwn(doc, key)) return MODJSON + 'uses "' + key + '", which Snapmap+ no longer reads.';
  }
  if (plainObject(doc.hud) && Object.hasOwn(doc.hud, 'schema')) return MODJSON + 'uses "hud.schema", which Snapmap+ no longer reads.';
  for (const key of ['files', 'bundle', 'build']) {
    if (Object.hasOwn(doc, key)) return MODJSON + 'has "' + key + '" outside its "snapmap-plus" block.';
  }
  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  if (!name || name.includes('\u0000')) return MODJSON + 'has no name.';
  if ([...name].length > MAX_NAME_POINTS) return MODJSON + 'has a name longer than ' + MAX_NAME_POINTS + ' characters.';
  if (doc.author !== undefined && (typeof doc.author !== 'string' || doc.author.includes('\u0000') ||
      [...doc.author.trim()].length > MAX_NAME_POINTS)) {
    return MODJSON + 'has an author that is not text of at most ' + MAX_NAME_POINTS + ' characters.';
  }
  if (doc.homepage !== undefined && typeof doc.homepage !== 'string') return MODJSON + 'has a homepage that is not text.';
  for (const key of ['strings', 'hud']) {
    if (doc[key] !== undefined && !plainObject(doc[key])) return MODJSON + 'has "' + key + '" that is not an object.';
  }
  if (doc.requirements !== undefined && !requirementsOk(doc.requirements)) return MODJSON + 'has requirements Snapmap+ would not apply.';
  return null;
}

/* Console settings and lines the product applies while a mod's requirements are live, in
 * the builder's shape (modbundle.c mb_requirements): at most 32 cvars named like cvars,
 * each a string of printable ASCII up to 64 characters, an integer or a boolean, no name
 * twice in any case; activate and deactivate lists of up to 16 lines, each 1 to 256
 * printable ASCII characters without ';' once its spaces are trimmed. */
function requirementsOk(req) {
  if (!plainObject(req) || Object.keys(req).some(key => key !== 'cvars' && key !== 'commands')) return false;
  if (req.cvars !== undefined) {
    if (!plainObject(req.cvars) || Object.keys(req.cvars).length > 32) return false;
    const seen = new Set();
    for (const [name, value] of Object.entries(req.cvars)) {
      if (!CVAR_RE.test(name) || seen.has(name.toLowerCase())) return false;
      seen.add(name.toLowerCase());
      const ok = typeof value === 'boolean' || (Number.isSafeInteger(value) && Math.abs(value) < 1e15) ||
        (typeof value === 'string' && value.length <= 64 && PRINTABLE_RE.test(value));
      if (!ok) return false;
    }
  }
  if (req.commands !== undefined) {
    if (!plainObject(req.commands) || Object.keys(req.commands).some(key => key !== 'activate' && key !== 'deactivate')) return false;
    for (const list of Object.values(req.commands)) {
      if (!Array.isArray(list) || list.length > 16) return false;
      for (const line of list) {
        if (typeof line !== 'string') return false;
        const trimmed = line.replace(/^ +| +$/g, '');
        if (!trimmed || trimmed.length > 256 || !PRINTABLE_RE.test(trimmed) || trimmed.includes(';')) return false;
      }
    }
  }
  return true;
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
    console.log('mods: archive store failed:', String(failure && failure.message).slice(0, 200));
    throw new RequestError(UNAVAILABLE, 503);
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
  if (!(await registry(env, 'buildServed', hash))) return refuse('The mod store does not have this build.', 404);
  const key = 'build/' + hash;
  const obj = req.method === 'HEAD' ? await env.MODS.head(key) : await env.MODS.get(key);
  if (!obj) return refuse('The mod store does not have this build.', 404);
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: 200, headers: objectHeaders(obj, hash) });
}

async function putBuild(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/zip') { await discard(req); return refuse('A build archive must be sent as application/zip.', 415); }
  const declared = req.headers.get('Content-Length');
  if (declared === null) { await discard(req); return refuse('A build archive must be sent with its Content-Length.', 411); }
  if (!/^\d+$/.test(declared)) { await discard(req); return refuse('The Content-Length of the upload is not a number.', 400); }
  const length = Number(declared);
  if (length > MAX_ARCHIVE) { await discard(req); return refuse('The archive is over 96 MiB, the largest build the mod store takes.', 413); }
  if (length < 22) { await discard(req); return refuse(NOT_ZIP, 422); }
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
  if (outcome.interrupted) return refuse('The upload ended before the whole archive arrived; try again.', 400);
  await registry(env, 'registerBuild', hash, length, outcome.salt);
  return reply({ build: hash, size: length }, 201);
}

/* ---------------- claims ---------------- */

/* The claim and release bodies, with the shared reader's refusals in plain words. */
async function readRequestJson(req) {
  try { return await readJsonObject(req, MAX_CLAIM_JSON); }
  catch (error) {
    if (error instanceof RequestError && error.status === 413) throw new RequestError('The request body is larger than 64 KiB.', 413);
    if (error instanceof RequestError && error.status === 400) throw new RequestError('The request body is not a JSON object.', 400);
    throw error;
  }
}

function hashArray(value, max) {
  if (!Array.isArray(value)) throw new RequestError('The claim does not list its builds by hash.', 400);
  if (value.length > max) throw new RequestError('A claim names at most ' + max + ' builds.', 400);
  if (!value.every(hash => typeof hash === 'string' && HEX64.test(hash))) throw new RequestError('The claim names a build by something other than its hash.', 400);
  return [...new Set(value)];
}

async function postClaim(req, env) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readRequestJson(req);
  if (!displayText(body.ref, 64) || !body.ref.length || body.ref.length > 64) return refuse('The claim names no published item.', 400);
  const builds = hashArray(body.builds, MAX_CLAIM_BUILDS);
  if (!builds.length) return refuse('The claim names no builds.', 400);
  if (body.secret !== undefined && !(typeof body.secret === 'string' && HEX64.test(body.secret))) return refuse(BAD_SECRET, 400);
  const blocked = builds.filter(hash => blockedSet(env).has(hash));
  if (blocked.length) return blockedResponse(blocked);
  const secret = body.secret === undefined ? randomHex(32) : body.secret;
  const result = await registry(env, 'claim', {
    ref: body.ref, builds, id: randomHex(16), secretHash: await sha256Hex(secret),
    presentedHash: body.secret === undefined ? null : await sha256Hex(body.secret),
  });
  if (result.forbidden) return refuse('No claim on the mod store matches this item and secret.', 403);
  if (result.missing) return refuse('The mod store does not hold every build the claim names; upload them again.', 409, { missing: result.missing.slice(0, MISSING_SHOWN), missingCount: result.missing.length });
  await deleteBuilds(env, result.deleted);
  return reply({ claim: result.claim, secret }, result.created ? 201 : 200);
}

async function postRelease(req, env) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readRequestJson(req);
  if (typeof body.claim !== 'string' || !HEX32.test(body.claim)) return refuse('The release names no claim.', 400);
  if (typeof body.secret !== 'string' || !HEX64.test(body.secret)) return refuse(BAD_SECRET, 400);
  const result = await registry(env, 'release', body.claim, await sha256Hex(body.secret));
  if (result.notFound) return refuse('The mod store has no such claim.', 404);
  if (result.forbidden) return refuse('The secret does not match this claim.', 403);
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
  if (!expected) { await discard(req); return refuse(NOT_FOUND, 404); }
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !(await sameToken(given, expected))) { await discard(req); return refuse('This request needs the maintainer token.', 403); }
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
  return discard(req).then(() => refuse('This address of the mod store does not take that request.', 405, {}, { Allow: allow }));
}

/* Handles every path under /mods; anonymous, no session, no Turnstile. Every answer that
 * is not a success carries one plain sentence in "error". */
export async function handleMods(req, env, path) {
  try { return await routeMods(req, env, path); }
  catch (error) {
    if (error instanceof RequestError) return refuse(error.message, error.status);
    console.log('mods: unexpected failure:', String(error && error.message).slice(0, 200));
    return refuse(UNAVAILABLE, 503);
  }
}

async function routeMods(req, env, path) {
  if (!env.MODS || !env.MOD_REGISTRY || !env.WRITE_QUOTAS) { await discard(req); return refuse(UNAVAILABLE, 503); }
  const build = path.match(/^\/mods\/build\/([0-9a-fA-F]{64})$/);
  if (build) {
    const raw = build[1];
    if (raw !== raw.toLowerCase()) { await discard(req); return refuse('A build hash must be written in lowercase hex.', 400); }
    if (req.method === 'GET' || req.method === 'HEAD') return serveBuild(req, env, raw);
    if (req.method === 'PUT') return putBuild(req, env, raw);
    return notAllowed(req, 'GET, HEAD, PUT');
  }
  const action = { '/mods/claim': postClaim, '/mods/release': postRelease, '/mods/admin/reset': postReset }[path];
  if (action) return req.method === 'POST' ? action(req, env) : notAllowed(req, 'POST');
  await discard(req);
  return refuse(NOT_FOUND, 404);
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

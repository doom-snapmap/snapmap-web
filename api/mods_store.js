/* Anonymous mod store: one object per mod build. A build is a stored ZIP of the mod's
 * folder (mod.json and the assets/ files its builder block lists), named by the build hash
 * the product computed. Nothing is browsable: every object is reachable only by hash.
 * MODS R2 holds the archives, each under its own key build/<hash>/<random>; the
 * MOD_REGISTRY Durable Object indexes them, records which object serves each build, and
 * holds the claims that keep them served and the uploads in parts in progress. See
 * README.md.
 *
 * The store imposes no limit of its own on a build: not on its size, its file count, one
 * file's size, its scripts, the builds one claim names, or the length of a name or path.
 * What remains is what the platform fixes, stated where it applies: one request body
 * (which is why a large build goes in parts) and R2's multipart rules. The per-address
 * hourly limits (WRITE_QUOTAS) are not limits on a mod: they protect the bucket and its
 * bill from abuse, and a publish in parts counts as one upload against them. */

import { RequestError, readJsonObject } from './request_body.js';

/* One part, and the largest archive one PUT takes. The platform refuses a request body over
 * 100 MB (100,000,000 bytes) on the Free and Pro plans (200 MB Business, 500 MB
 * Enterprise); 95 MiB is 99,614,720 bytes. R2 multipart uploads need every part but the
 * last to have one size, at least 5 MiB, and allow at most 10,000 parts. */
export const PART_SIZE = 95 * 1024 * 1024;
export const CLAIM_WINDOW_MS = 3600000;   // upload-before-claim window (one hour), as in mods_registry_store.js
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PURGE_BATCH = 500;
const PURGE_ROUNDS = 20;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SALT_RE = /^[a-z][a-z0-9]{7}$/;
/* A path segment's characters as the builder allows them (modbundle.c mb_path_char),
 * lower-cased as every request path is. */
const SEGMENT_RE = /^[a-z0-9._$+@~() -]+$/;
const CVAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRINTABLE_RE = /^[\x20-\x7e]*$/;
const EXTENSIONS = new Set(['decl', 'bmd6model', 'bmd6skl', 'bmd6anim', 'bimage', 'bmodel', 'bcm', 'bnk', 'json', 'bin', 'vspv', 'fspv', 'cspv', 'mrpr', 'dmodel']);
const BLOCK_KEY = 'snapmap-plus';
/* The builder block's keys (modbundle.c mb_load_root) and the author keys a built mod.json
 * may no longer use (mb_retired_key). A hand-written "version" is not among them: it is an
 * unknown author key, kept and ignored like any other. */
const BLOCK_KEYS = new Set(['build', 'built', 'cause', 'classes', 'edits', 'editor', 'files', 'format', 'registries',
  'rules', 'salt', 'scripts', 'shadows', 'stock', 'tree', 'warnings']);
const RETIRED_KEYS = ['id', 'key', 'shadows', 'stock', 'scope', 'player', 'extends', 'replaces', 'legacy', 'composes', 'schema'];
const FILE_KEYS = ['needs', 'path', 'provides', 'sha256', 'size'];
const POINTER_KEYS = new Set(['closure', 'needs', 'path', 'provides', 'sha256', 'source']);
const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61];   // "\x1bLua", the start of every precompiled chunk

/* Every refusal is one plain sentence the product shows as it is: printable ASCII, whole
 * (modnet.c mn_error_text keeps the printable ASCII of the text, of any length). */

/* ---------------- responses ---------------- */

const UNAVAILABLE = 'The mod store is unavailable right now; try again later.';
const NOT_FOUND = 'The mod store has nothing at this address.';
const NOT_ZIP = 'The upload is not a ZIP archive.';
const BAD_SECRET = 'The secret is not 64 lowercase hex characters.';
const NO_BUILD = 'The mod store does not have this build.';

function reply(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...extra } });
}

function refuse(error, status, extra, headers) {
  return reply({ error, ...extra }, status, headers);
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

/* A new archive's own object: build/<hash>/<random>. */
function newObject(hash) {
  return 'build/' + hash + '/' + randomHex(16);
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

function retryAfterHour() {
  return String(Math.max(1, Math.ceil((3600000 - (Date.now() % 3600000)) / 1000)));
}

function blockedResponse(hashes) {
  return refuse(hashes.length === 1 ? 'This build was taken down from the mod store.' : 'Some of these builds were taken down from the mod store.',
    451, { blocked: hashes });
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

function displayText(value) {
  return typeof value === 'string' && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function validSalt(salt) {
  return typeof salt === 'string' && SALT_RE.test(salt);
}

/* A path or key as a refusal names it: whole, each character outside printable ASCII
 * shown as "?" (the product reads printable ASCII only). */
function shown(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?');
}

/* What is wrong with a request path (the part below assets/), as the end of a sentence
 * that starts with the path, or null. The rules are the builder's (modbundle.c
 * sh_mb_check_request, mb_rp_forbidden, sh_mb_extension_allowed, sh_mb_vt_member):
 * relative; no backslash; no empty, "." or ".." segment; no segment starting with a space
 * or ending in a dot or space; the builder's characters only. A carried file
 * (options.carried) also needs a type the builder carries and must not be one of the
 * engine's own caches: a cooked movie only under generated/swf/, a virtual-texture member
 * only as the mod's own virtualtextures/mods/<salt>/..._sq1 to _sq16 outside any stock _vmtr
 * family, and a script (.lua) only under the mod's mods/<salt>/scripts/. */
export function pathFault(request, options = {}) {
  if (typeof request !== 'string' || request.length < 1) return 'has an empty path';
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
const NAME_DECODER = new TextDecoder('utf-8', { fatal: true });
const MALFORMED_EXTRA = 'The archive has a malformed extra field.';
const ZIP64_EXTRA = 'The archive has a ZIP64 extra field that does not match its entry.';
const ZIP64_END = 'The archive\'s ZIP64 end records are malformed.';
const UNCOUNTABLE = 'The archive declares a size larger than this platform can count.';
const M32 = 0xffffffff, M16 = 0xffff;

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;

/* A 64-bit little-endian value, or null past what a JavaScript number counts exactly
 * (2^53 bytes, about 9 PB: the platform's limit, not the store's). */
function u64(b, at) {
  const hi = u32(b, at + 4);
  return hi > 0x1fffff ? null : u32(b, at) + hi * 0x100000000;
}

/* An extra field, well formed, whose ZIP64 record (id 1) holds exactly the `want` 64-bit
 * values the entry's markers ask for, in the format's order; there is none when nothing
 * asks. Returns { values } or { error }. */
function zip64Values(bytes, want) {
  let at = 0, values = null;
  while (at < bytes.length) {
    if (bytes.length - at < 4) return { error: MALFORMED_EXTRA };
    const id = u16(bytes, at), len = u16(bytes, at + 2);
    if (at + 4 + len > bytes.length) return { error: MALFORMED_EXTRA };
    if (id === 0x0001) {
      if (values || !want || len !== want * 8) return { error: ZIP64_EXTRA };
      values = [];
      for (let k = 0; k < want; k++) {
        const v = u64(bytes, at + 4 + 8 * k);
        if (v === null) return { error: UNCOUNTABLE };
        values.push(v);
      }
    }
    at += 4 + len;
  }
  if (want && !values) return { error: ZIP64_EXTRA };
  return { values: values || [] };
}

function isScript(name) {
  return name.toLowerCase().endsWith('.lua');
}

/* A script's bytes as they stream past: whether it starts like a precompiled Lua chunk,
 * holds a NUL, and is UTF-8 (a validating decoder of a few integers, so nothing of the
 * file is kept). These are safety rules, not limits: a script is source text. */
class ScriptCheck {
  constructor() {
    this.seen = 0;
    this.bytecode = true;
    this.nul = false;
    this.bad = false;
    this.need = 0;
    this.lo = 0x80;
    this.hi = 0xbf;
  }

  push(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.seen < 4 && b !== LUA_SIGNATURE[this.seen]) this.bytecode = false;
      this.seen++;
      if (b === 0) this.nul = true;
      if (this.bad) continue;
      if (this.need) {
        if (b < this.lo || b > this.hi) { this.bad = true; continue; }
        this.need--;
        this.lo = 0x80; this.hi = 0xbf;
        continue;
      }
      if (b < 0x80) continue;
      if (b >= 0xc2 && b <= 0xdf) this.need = 1;
      else if (b === 0xe0) { this.need = 2; this.lo = 0xa0; }
      else if ((b >= 0xe1 && b <= 0xec) || b === 0xee || b === 0xef) this.need = 2;
      else if (b === 0xed) { this.need = 2; this.hi = 0x9f; }
      else if (b === 0xf0) { this.need = 3; this.lo = 0x90; }
      else if (b >= 0xf1 && b <= 0xf3) this.need = 3;
      else if (b === 0xf4) { this.need = 3; this.hi = 0x8f; }
      else this.bad = true;
    }
  }

  /* The end of a sentence that starts with the script's path, or null. */
  fault() {
    if (this.bytecode && this.seen >= LUA_SIGNATURE.length) return 'is compiled Lua bytecode; a mod carries its scripts as source text';
    if (this.nul) return 'contains a NUL byte; a script must be plain text';
    if (this.bad || this.need) return 'is not UTF-8 text';
    return null;
  }
}

/* Reads an archive as it streams past, one chunk at a time, keeping only what it must
 * judge: each entry's header fields and name, mod.json (parsed at the end), and a few
 * integers per script. File contents pass through untouched and the central directory is
 * checked record by record against the entries as it streams, so memory grows with the
 * number of entries and the size of mod.json, never with the archive's size. The form is
 * the product's (modzip.c): stored entries with their sizes in the local header, then the
 * central directory, then (when a value needs it) the ZIP64 end record and locator, then
 * the end record; nothing before, between or after. ZIP64 values stand where a field holds
 * its marker, so there is no bound on an entry's size, the archive's size or the number of
 * entries. error is the first refusal; once set, later bytes are ignored. */
export class ArchiveWalker {
  constructor(length) {
    this.length = length;
    this.at = 0;                     // bytes consumed
    this.state = 'sig';              // sig, local, localVar, data, central, centralVar, end, endComment, trail
    this.buf = new Uint8Array(64);
    this.need = 4;
    this.have = 0;
    this.recordStart = 0;
    this.current = null;
    this.pending = null;             // a central record's fixed fields, until its name is read
    this.remaining = 0;
    this.entries = [];
    this.names = new Set();
    this.modjson = null;
    this.scripts = 0;
    this.central = 0;                // central records read
    this.cdStart = -1;
    this.cdEnd = -1;
    this.z64 = null;                 // the ZIP64 end record's values, when the archive has one
    this.error = null;
    this.done = false;
  }

  fail(cause) {
    if (!this.error) this.error = cause;
  }

  expect(n) {
    if (this.buf.length < n) {
      const larger = new Uint8Array(Math.max(n, this.buf.length * 2));
      larger.set(this.buf.subarray(0, this.have));
      this.buf = larger;
    }
    this.need = n;
  }

  push(chunk) {
    let i = 0;
    while (i < chunk.byteLength && !this.error) {
      if (this.state === 'data') {
        const n = Math.min(this.remaining, chunk.byteLength - i);
        const entry = this.current, bytes = chunk.subarray(i, i + n);
        if (entry.data) { entry.data.set(bytes, entry.captured); entry.captured += n; }
        else if (entry.check) entry.check.push(bytes);
        this.remaining -= n; i += n; this.at += n;
        if (this.remaining === 0) this.endEntry();
        continue;
      }
      if (this.state === 'trail') { this.fail('The archive has bytes after its end record.'); break; }
      if (this.have === 0) this.recordStart = this.at;
      const n = Math.min(this.need - this.have, chunk.byteLength - i);
      this.buf.set(chunk.subarray(i, i + n), this.have);
      this.have += n; i += n; this.at += n;
      if (this.have === this.need) this.step();
    }
    this.at += chunk.byteLength - i;
  }

  endEntry() {
    const entry = this.current;
    if (entry.check) { entry.scriptFault = entry.check.fault(); entry.check = null; }
    this.current = null;
    this.toSig();
  }

  toSig() {
    this.state = 'sig';
    this.need = 4;
    this.have = 0;
  }

  step() {
    const b = this.buf;
    switch (this.state) {
    case 'sig': {
      const sig = u32(b, 0);
      if (this.z64 && !this.z64.located) {
        if (sig !== SIG_ZIP64_LOCATOR) return this.fail(ZIP64_END);
        this.state = 'locator';
        this.expect(20);
        return;
      }
      if (this.z64 && sig !== SIG_END) return this.fail('The archive has no end of central directory record.');
      if (sig === SIG_ZIP64_LOCATOR) return this.fail(ZIP64_END);
      if (sig === SIG_ZIP64_END) {
        if (this.cdStart < 0) this.cdStart = this.recordStart;
        if (this.central < this.entries.length) return this.fail('The archive\'s central directory does not list every entry.');
        this.cdEnd = this.recordStart;
        this.state = 'end64';
        this.expect(56);
        return;
      }
      if (sig === SIG_LOCAL && this.cdStart < 0) { this.state = 'local'; this.expect(30); return; }
      if (sig === SIG_CENTRAL) {
        if (this.cdStart < 0) this.cdStart = this.recordStart;
        if (this.central >= this.entries.length) return this.fail('The archive\'s central directory lists an entry the archive does not hold.');
        this.state = 'central';
        this.expect(46);
        return;
      }
      if (sig === SIG_END) {
        if (this.cdStart < 0) this.cdStart = this.recordStart;
        if (this.central < this.entries.length) return this.fail('The archive\'s central directory does not list every entry.');
        if (!this.z64) this.cdEnd = this.recordStart;
        this.state = 'end';
        this.expect(22);
        return;
      }
      if (this.recordStart === 0) return this.fail(NOT_ZIP);
      if (this.cdStart < 0) return this.fail('The archive has unexpected bytes after an entry.');
      return this.fail(this.central < this.entries.length ? 'The archive\'s central directory does not list every entry.'
        : 'The archive has no end of central directory record.');
    }
    case 'local': {
      const flags = u16(b, 6), method = u16(b, 8), csize = u32(b, 18), usize = u32(b, 22), nameLength = u16(b, 26);
      if (flags & 0x0001) return this.fail('The archive has an encrypted entry.');
      if (flags & 0x0008) return this.fail('The archive has an entry without its sizes in its local header.');
      if (flags & ~FLAG_UTF8) return this.fail('The archive has an entry with flags Snapmap+ never writes.');
      if (method !== 0) return this.fail('The archive has a compressed entry; Snapmap+ stores every file uncompressed.');
      if (nameLength < 1) return this.fail('The archive has an entry without a name.');
      this.current = { flags, crc: u32(b, 14), usize, csize, nameLength, extraLength: u16(b, 28), offset: this.recordStart };
      this.state = 'localVar';
      this.expect(30 + nameLength + this.current.extraLength);
      if (this.have === this.need) this.step();
      return;
    }
    case 'localVar': {
      const entry = this.current;
      let name;
      try { name = NAME_DECODER.decode(b.subarray(30, 30 + entry.nameLength)); }
      catch { return this.fail('The archive has an entry name that is not UTF-8.'); }
      const mu = entry.usize === M32, mc = entry.csize === M32;
      const extra = zip64Values(b.subarray(30 + entry.nameLength, this.need), (mu ? 1 : 0) + (mc ? 1 : 0));
      if (extra.error) return this.fail(extra.error);
      if (mu) entry.usize = extra.values.shift();
      if (mc) entry.csize = extra.values.shift();
      if (entry.csize !== entry.usize) return this.fail('The archive has a stored entry whose two sizes disagree.');
      entry.size = entry.usize;
      delete entry.usize;
      delete entry.csize;
      if (this.names.has(name)) return this.fail('The archive holds ' + shown(name) + ' twice.');
      entry.name = name;
      this.names.add(name);
      this.entries.push(entry);
      if (name === 'mod.json') {
        entry.data = this.modjson = new Uint8Array(entry.size);
        entry.captured = 0;
      } else if (isScript(name)) {
        this.scripts++;
        entry.check = new ScriptCheck();
      }
      if (entry.size === 0) { this.endEntry(); return; }
      this.state = 'data';
      this.remaining = entry.size;
      return;
    }
    case 'central': {
      this.pending = {
        flags: u16(b, 8), method: u16(b, 10), crc: u32(b, 16), csize: u32(b, 20), usize: u32(b, 24),
        nameLength: u16(b, 28), extraLength: u16(b, 30), commentLength: u16(b, 32), disk: u16(b, 34), offset: u32(b, 42),
      };
      this.state = 'centralVar';
      this.expect(46 + this.pending.nameLength + this.pending.extraLength + this.pending.commentLength);
      if (this.have === this.need) this.step();
      return;
    }
    case 'centralVar': {
      const c = this.pending, entry = this.entries[this.central];
      if (c.disk !== 0) return this.fail('The archive is split across several files.');
      const mu = c.usize === M32, mc = c.csize === M32, mo = c.offset === M32;
      const extra = zip64Values(b.subarray(46 + c.nameLength, 46 + c.nameLength + c.extraLength), (mu ? 1 : 0) + (mc ? 1 : 0) + (mo ? 1 : 0));
      if (extra.error) return this.fail(extra.error);
      if (mu) c.usize = extra.values.shift();
      if (mc) c.csize = extra.values.shift();
      if (mo) c.offset = extra.values.shift();
      let name;
      try { name = NAME_DECODER.decode(b.subarray(46, 46 + c.nameLength)); }
      catch { return this.fail('The archive has an entry name that is not UTF-8.'); }
      if (name !== entry.name || c.flags !== entry.flags || c.method !== 0 || c.crc !== entry.crc || c.csize !== entry.size ||
          c.usize !== entry.size || c.disk !== 0 || c.offset !== entry.offset) {
        return this.fail('The archive\'s central directory disagrees with its entry ' + shown(entry.name) + '.');
      }
      this.central++;
      this.pending = null;
      this.toSig();
      return;
    }
    case 'end64': {
      const rest = u64(b, 4);
      if (rest === null || rest < 44 || rest > this.length - this.recordStart) return this.fail(ZIP64_END);
      this.z64 = { at: this.recordStart, rest };
      this.state = 'end64Var';
      this.expect(12 + rest);
      if (this.have === this.need) this.step();
      return;
    }
    case 'end64Var': {
      const z = this.z64;
      if (u32(b, 16) !== 0 || u32(b, 20) !== 0) return this.fail('The archive is split across several files.');
      z.onDisk = u64(b, 24); z.total = u64(b, 32); z.cdSize = u64(b, 40); z.cdOffset = u64(b, 48);
      if ([z.onDisk, z.total, z.cdSize, z.cdOffset].includes(null)) return this.fail(UNCOUNTABLE);
      if (z.onDisk !== z.total) return this.fail('The archive is split across several files.');
      this.toSig();
      return;
    }
    case 'locator': {
      const at = u64(b, 8);
      if (u32(b, 4) !== 0 || u32(b, 16) !== 1) return this.fail('The archive is split across several files.');
      if (at !== this.z64.at) return this.fail(ZIP64_END);
      this.z64.located = true;
      this.toSig();
      return;
    }
    case 'end': {
      const disk = u16(b, 4), cdDisk = u16(b, 6), commentLength = u16(b, 20);
      let onDisk = u16(b, 8), total = u16(b, 10), cdSize = u32(b, 12), cdOffset = u32(b, 16);
      if (this.z64) {
        /* A classic field holds its value or the marker; the ZIP64 record's values count. */
        const z = this.z64;
        if ((onDisk !== M16 && onDisk !== z.onDisk) || (total !== M16 && total !== z.total) ||
            (cdSize !== M32 && cdSize !== z.cdSize) || (cdOffset !== M32 && cdOffset !== z.cdOffset)) {
          return this.fail(ZIP64_END);
        }
        onDisk = z.onDisk; total = z.total; cdSize = z.cdSize; cdOffset = z.cdOffset;
      } else if (onDisk === M16 || total === M16 || cdSize === M32 || cdOffset === M32) {
        return this.fail('The archive\'s end record points to ZIP64 records the archive does not have.');
      }
      if (disk !== 0 || cdDisk !== 0) return this.fail('The archive is split across several files.');
      if (onDisk !== this.entries.length || total !== this.entries.length) return this.fail('The archive\'s end record counts its entries wrongly.');
      if (cdSize !== this.cdEnd - this.cdStart || cdOffset !== this.cdStart) return this.fail('The archive\'s end record places its central directory wrongly.');
      if (commentLength) { this.state = 'endComment'; this.expect(22 + commentLength); return; }
      this.state = 'trail';
      this.done = true;
      return;
    }
    case 'endComment':
      this.state = 'trail';
      this.done = true;
      return;
    default:
      return;
    }
  }

  /* After the last byte. Sets error unless the archive ended exactly at its end record. */
  finish() {
    if (this.error) return;
    if (this.at !== this.length) return this.fail('The archive is shorter than its Content-Length.');
    if (this.done) return;
    this.done = false;
    if (this.cdStart < 0) return this.fail('The archive ends before its central directory.');
    if (this.state === 'centralVar') return this.fail('The archive\'s central directory is cut short.');
    if (this.central < this.entries.length) return this.fail('The archive\'s central directory does not list every entry.');
    return this.fail('The archive has no end of central directory record.');
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
 * assets/<its request path, in lower case>, and nothing else is; the block's "scripts"
 * member is present exactly when the archive carries scripts and counts them. The Worker
 * does not recompute the build hash or check what each file provides; the product does
 * both before it installs. There is no mod version anywhere in this: a "version" key an
 * author wrote is an unknown author key and is ignored. Returns { salt, scripts } or
 * { error }. */
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
    if (!Number.isSafeInteger(file.size) || file.size < 1) return { error: MODJSON + 'gives ' + shown(file.path) + ' no valid size.' };
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

  let scripts = 0;
  for (const entry of entries) {
    if (entry.name === 'mod.json') continue;
    if (!entry.name.startsWith('assets/')) return { error: 'The archive holds ' + shown(entry.name) + ', which is outside assets/.' };
    const request = entry.name.slice(7);
    if (request !== request.toLowerCase()) return { error: 'The archive holds ' + shown(entry.name) + ', whose path is not in lower case.' };
    const fault = pathFault(request, { salt, carried: true });
    if (fault) return { error: 'The file ' + shown(entry.name) + ' ' + fault + '.' };
    if (!carried.has(request)) return { error: 'The archive holds ' + shown(entry.name) + ', which mod.json does not list.' };
    if (carried.get(request) !== entry.size) return { error: 'The size of ' + shown(entry.name) + ' does not match mod.json.' };
    if (isScript(entry.name)) {
      scripts++;
      if (entry.scriptFault) return { error: 'The script ' + shown(entry.name) + ' ' + entry.scriptFault + '.' };
    }
  }
  const present = new Set(entries.map(entry => entry.name));
  for (const request of carried.keys()) {
    if (!present.has('assets/' + request)) return { error: 'The archive lacks ' + shown('assets/' + request) + ', which mod.json lists.' };
  }
  /* The block's "scripts" member describes the scripts the archive carries (modbundle.h):
   * present exactly when there are any, with their count in "files". The index records
   * the count, and the store's answers say it, so a player is told before downloading. */
  if (block.scripts === undefined) {
    if (scripts) return { error: MODJSON + 'does not describe the scripts the archive carries.' };
  } else if (!scripts || !plainObject(block.scripts) || block.scripts.files !== scripts) {
    return { error: MODJSON + 'describes scripts the archive does not carry.' };
  }
  return { salt, scripts };
}

function providesOk(value) {
  return plainObject(value) && Object.keys(value).length === 2 && typeof value.type === 'string' && typeof value.name === 'string';
}

function needsOk(value) {
  return Array.isArray(value) && value.every(need => plainObject(need) && Object.keys(need).length === 2 &&
    typeof need.type === 'string' && need.type.length > 0 && typeof need.name === 'string' && need.name.length > 0);
}

/* The author part of a built mod.json as the product reads it back: no retired key, no
 * builder member at the top level, a name, display text, and requirements in the
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
  if (doc.author !== undefined && (typeof doc.author !== 'string' || doc.author.includes('\u0000'))) {
    return MODJSON + 'has an author that is not text.';
  }
  if (doc.homepage !== undefined && typeof doc.homepage !== 'string') return MODJSON + 'has a homepage that is not text.';
  for (const key of ['strings', 'hud']) {
    if (doc[key] !== undefined && !plainObject(doc[key])) return MODJSON + 'has "' + key + '" that is not an object.';
  }
  if (doc.requirements !== undefined && !requirementsOk(doc.requirements)) return MODJSON + 'has requirements Snapmap+ would not apply.';
  return null;
}

/* Console settings and lines the product applies while a mod's requirements are live, in
 * the builder's shape (modbundle.c mb_requirements): any number of cvars named like cvars,
 * each a string of printable ASCII, an integer or a boolean, no name twice in any case;
 * activate and deactivate lists of any length, each line printable ASCII without ';' and
 * not empty once its spaces are trimmed. No count or length of the store's own. */
function requirementsOk(req) {
  if (!plainObject(req) || Object.keys(req).some(key => key !== 'cvars' && key !== 'commands')) return false;
  if (req.cvars !== undefined) {
    if (!plainObject(req.cvars)) return false;
    const seen = new Set();
    for (const [name, value] of Object.entries(req.cvars)) {
      if (!CVAR_RE.test(name) || seen.has(name.toLowerCase())) return false;
      seen.add(name.toLowerCase());
      const ok = typeof value === 'boolean' || (Number.isSafeInteger(value) && Math.abs(value) < 1e15) ||
        (typeof value === 'string' && PRINTABLE_RE.test(value));
      if (!ok) return false;
    }
  }
  if (req.commands !== undefined) {
    if (!plainObject(req.commands) || Object.keys(req.commands).some(key => key !== 'activate' && key !== 'deactivate')) return false;
    for (const list of Object.values(req.commands)) {
      if (!Array.isArray(list)) return false;
      for (const line of list) {
        if (typeof line !== 'string') return false;
        const trimmed = line.replace(/^ +| +$/g, '');
        if (!trimmed || !PRINTABLE_RE.test(trimmed) || trimmed.includes(';')) return false;
      }
    }
  }
  return true;
}

/* Runs a stream through a fresh walker to its end. Returns the walker, with error set when
 * the archive is refused, or null when the stream broke off. */
async function walkStream(stream, length) {
  const walker = new ArchiveWalker(length);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      walker.push(value);
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
  walker.finish();
  return walker;
}

function verdictOf(walker, hash) {
  if (walker.error) return { refusal: walker.error };
  const verdict = buildVerdict(hash, walker.entries, walker.modjson);
  return verdict.error ? { refusal: verdict.error } : verdict;
}

/* Deletes objects nothing names any more (released, purged, refused, or replaced). */
async function deleteObjects(env, objects) {
  const keys = (objects || []).filter(Boolean);
  for (let i = 0; i < keys.length; i += 1000) await env.MODS.delete(keys.slice(i, i + 1000));
}

/* Records a validated archive and answers the upload. */
async function register(env, hash, size, verdict, object) {
  const result = await registry(env, 'registerBuild', hash, size, verdict.salt, object, verdict.scripts);
  await deleteObjects(env, [result.discard]);
  return reply({ build: hash, size, scripts: verdict.scripts }, result.created ? 201 : 200);
}

/* A build already held that an upload need not send again: a claimed one (never
 * replaced), or an unclaimed one of the same size. */
async function heldAlready(env, hash, size) {
  const row = await registry(env, 'buildRow', hash);
  if (!row || !(row.claims > 0 || row.size === size)) return null;
  if (!(await env.MODS.head(row.object))) return null;
  if (row.claims <= 0) await registry(env, 'touchBuild', hash);
  return row;
}

/* ---------------- build routes ---------------- */

function objectHeaders(obj, hash, scripts) {
  const h = new Headers();
  h.set('Content-Type', 'application/zip');
  h.set('Content-Length', String(obj.size));
  h.set('Cache-Control', IMMUTABLE);
  h.set('ETag', '"' + hash + '"');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Content-Disposition', 'attachment');
  h.set('X-Mod-Scripts', String(scripts));
  return h;
}

/* A build is served while a claim names it, or for one hour after its upload. Every answer
 * says how many scripts the build carries (X-Mod-Scripts), so a HEAD tells the product
 * before it asks the player. */
async function serveBuild(req, env, hash) {
  if (blockedSet(env).has(hash)) return blockedResponse([hash]);
  if (!(await admit(req, env, [['mod_get', 1]], true))) return rateLimited();
  const served = await registry(env, 'buildServed', hash);
  if (!served) return refuse(NO_BUILD, 404);
  const obj = req.method === 'HEAD' ? await env.MODS.head(served.object) : await env.MODS.get(served.object);
  if (!obj) return refuse(NO_BUILD, 404);
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: 200, headers: objectHeaders(obj, hash, served.scripts) });
}

function declaredLength(req) {
  const declared = req.headers.get('Content-Length');
  if (declared === null) return { refusal: refuse('A build archive must be sent with its Content-Length.', 411) };
  if (!/^\d+$/.test(declared)) return { refusal: refuse('The Content-Length of the upload is not a number.', 400) };
  return { length: Number(declared) };
}

/* One archive in one request, up to one part. The body streams to a new object of its own
 * through the walker; an archive refused at any byte has its object deleted, and since no
 * row names that object it is never served in between. */
async function putBuild(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/zip') { await discard(req); return refuse('A build archive must be sent as application/zip.', 415); }
  const { length, refusal } = declaredLength(req);
  if (refusal) { await discard(req); return refusal; }
  if (length > PART_SIZE) { await discard(req); return refuse('An archive over 95 MiB goes to the mod store in parts.', 413); }
  if (length < 22) { await discard(req); return refuse(NOT_ZIP, 422); }
  if (!(await admit(req, env, [['mod_build_put', 1], ['mod_bytes', length]], false))) { await discard(req); return rateLimited(); }
  const held = await heldAlready(env, hash, length);
  if (held) {
    /* Read the body to its end before answering: a client still sending would otherwise
     * see a reset connection instead of the idempotent 200. */
    await drain(req);
    return reply({ build: hash, size: held.size, scripts: held.scripts }, 200);
  }
  if (!req.body) return refuse('The upload ended before the whole archive arrived; try again.', 400);
  const object = newObject(hash);
  const walker = new ArchiveWalker(length);
  let verdict = null;
  const tap = new TransformStream({
    transform(chunk, controller) { walker.push(chunk); controller.enqueue(chunk); },
    flush() {
      walker.finish();
      verdict = verdictOf(walker, hash);
      if (verdict.refusal) throw new Error('refused');
    },
  });
  let failure = null;
  try {
    await env.MODS.put(object, req.body.pipeThrough(tap).pipeThrough(new FixedLengthStream(length)),
      { httpMetadata: { contentType: 'application/zip', cacheControl: IMMUTABLE } });
  } catch (error) { failure = error; }
  if (verdict && verdict.refusal) { await deleteObjects(env, [object]); return refuse(verdict.refusal, 422); }
  if (failure || !verdict) {
    await deleteObjects(env, [object]);
    if (walker.at !== length || !verdict) return refuse('The upload ended before the whole archive arrived; try again.', 400);
    console.log('mods: archive store failed:', String(failure && failure.message).slice(0, 200));
    throw new RequestError(UNAVAILABLE, 503);
  }
  return register(env, hash, length, verdict, object);
}

/* ---------------- uploads in parts ---------------- */

function partsOf(size) {
  return Math.ceil(size / PART_SIZE);
}

function partLength(size, part) {
  return part < partsOf(size) ? PART_SIZE : size - (partsOf(size) - 1) * PART_SIZE;
}

function sessionReply(hash, size, session, status) {
  const have = [];
  session.etags.forEach((etag, i) => { if (etag) have.push(i + 1); });
  return reply({ build: hash, size, partSize: session.partSize, parts: session.parts, have }, status);
}

async function readSize(req) {
  const body = await readRequestJson(req);
  if (!Number.isSafeInteger(body.size) || body.size < 22) throw new RequestError('The upload names no archive size.', 400);
  return body.size;
}

/* POST /mods/build/<hash>/parts {"size"}: starts an upload in parts, or resumes the one of
 * this build at this size, answering which parts the store holds already. Only a new upload
 * counts against the per-address limits, as one upload of its whole size: its parts, its
 * resumes and its completion count nothing, so a publish is never stopped half way. */
async function startParts(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const size = await readSize(req);
  const held = await heldAlready(env, hash, size);
  if (held) return reply({ build: hash, size: held.size, scripts: held.scripts, stored: true }, 200);
  const session = await registry(env, 'uploadSession', hash, size);
  if (session) return sessionReply(hash, size, session, 200);
  if (!(await admit(req, env, [['mod_build_put', 1], ['mod_bytes', size]], false))) return rateLimited();
  const object = newObject(hash);
  const upload = await env.MODS.createMultipartUpload(object, { httpMetadata: { contentType: 'application/zip', cacheControl: IMMUTABLE } });
  const opened = await registry(env, 'openUpload', { hash, size, object, upload: upload.uploadId, partSize: PART_SIZE, parts: partsOf(size) });
  if (opened.existing) {
    try { await upload.abort(); } catch { /* It held no parts. */ }
    return sessionReply(hash, size, opened, 200);
  }
  return sessionReply(hash, size, opened, 201);
}

/* PUT /mods/build/<hash>/parts/<n> with X-Build-Size: stores one part. Every part but the
 * last is exactly the part size. A part sent again replaces the earlier copy. */
async function putPart(req, env, hash, part) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') { await discard(req); return refuse('A part must be sent as application/octet-stream.', 415); }
  const sizeText = req.headers.get('X-Build-Size') || '';
  if (!/^\d+$/.test(sizeText)) { await discard(req); return refuse('A part must name its archive size in X-Build-Size.', 400); }
  const size = Number(sizeText);
  const { length, refusal } = declaredLength(req);
  if (refusal) { await discard(req); return refusal; }
  const session = Number.isSafeInteger(size) ? await registry(env, 'uploadSession', hash, size) : null;
  if (!session) { await discard(req); return refuse('The mod store has no upload of this build in progress; start it again.', 404); }
  if (part < 1 || part > session.parts) { await discard(req); return refuse('The upload has no part with that number.', 400); }
  if (length !== partLength(size, part)) { await discard(req); return refuse('The part is not the length its place in the archive needs.', 400); }
  if (!req.body) return refuse('The part ended before all of it arrived; send it again.', 400);
  const upload = env.MODS.resumeMultipartUpload(session.object, session.upload);
  let stored;
  try { stored = await upload.uploadPart(part, req.body.pipeThrough(new FixedLengthStream(length))); }
  catch { return refuse('The part ended before all of it arrived; send it again.', 400); }
  const after = await registry(env, 'recordPart', hash, size, session.upload, part, stored.etag);
  if (!after) return refuse('The mod store has no upload of this build in progress; start it again.', 404);
  return sessionReply(hash, size, after, 200);
}

/* POST /mods/build/<hash>/complete {"size"}: joins the parts into the archive's object,
 * then reads it back once through the walker, the same checks a one-request upload gets.
 * Only a passing archive is registered; a refused one is deleted. */
async function completeParts(req, env, hash) {
  if (blockedSet(env).has(hash)) { await discard(req); return blockedResponse([hash]); }
  const size = await readSize(req);
  const session = await registry(env, 'uploadSession', hash, size);
  if (!session) {
    const held = await heldAlready(env, hash, size);
    if (held) return reply({ build: hash, size: held.size, scripts: held.scripts }, 200);
    return refuse('The mod store has no upload of this build in progress; start it again.', 404);
  }
  const have = session.etags.filter(Boolean).length;
  if (have !== session.parts) return sessionReply(hash, size, session, 409);
  const upload = env.MODS.resumeMultipartUpload(session.object, session.upload);
  try {
    await upload.complete(session.etags.map((etag, i) => ({ partNumber: i + 1, etag })));
  } catch {
    /* A part was replaced under another etag, or the upload is gone: start over. */
    try { await upload.abort(); } catch { /* Already completed or aborted. */ }
    await registry(env, 'closeUpload', hash, size, session.upload);
    await deleteObjects(env, [session.object]);
    return refuse('The parts of this upload did not join into one archive; upload the build again.', 409);
  }
  const obj = await env.MODS.get(session.object);
  const walker = obj && obj.size === size ? await walkStream(obj.body, size) : null;
  await registry(env, 'closeUpload', hash, size, session.upload);
  if (!walker) {
    await deleteObjects(env, [session.object]);
    console.log('mods: a joined archive could not be read back');
    throw new RequestError(UNAVAILABLE, 503);
  }
  const verdict = verdictOf(walker, hash);
  if (verdict.refusal) { await deleteObjects(env, [session.object]); return refuse(verdict.refusal, 422); }
  return register(env, hash, size, verdict, session.object);
}

/* ---------------- claims ---------------- */

/* The claim and release bodies, with the shared reader's refusals in plain words. A body is
 * bounded only by the platform's request size. */
async function readRequestJson(req) {
  try { return await readJsonObject(req, PART_SIZE); }
  catch (error) {
    if (error instanceof RequestError && error.status === 413) throw new RequestError('The request body is larger than one request may be.', 413);
    if (error instanceof RequestError && error.status === 400) throw new RequestError('The request body is not a JSON object.', 400);
    throw error;
  }
}

function hashArray(value) {
  if (!Array.isArray(value)) throw new RequestError('The claim does not list its builds by hash.', 400);
  if (!value.every(hash => typeof hash === 'string' && HEX64.test(hash))) throw new RequestError('The claim names a build by something other than its hash.', 400);
  return [...new Set(value)];
}

async function postClaim(req, env) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readRequestJson(req);
  if (!displayText(body.ref) || !body.ref.length) return refuse('The claim names no published item.', 400);
  const builds = hashArray(body.builds);
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
  if (result.missing) return refuse('The mod store does not hold every build the claim names; upload them again.', 409, { missing: result.missing });
  await deleteObjects(env, result.deleted);
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
  await deleteObjects(env, result.deleted);
  return new Response(null, { status: 204 });
}

/* ---------------- maintainer reset ---------------- */

/* Deletes every object in the MODS bucket (build archives, uploads in parts, and anything
 * the retired blob and bundle store left), aborts every upload in parts, and empties the
 * index. Hidden unless the MODS_ADMIN_TOKEN secret is set, and refused without exactly that
 * bearer token. */
async function postReset(req, env) {
  const expected = env.MODS_ADMIN_TOKEN === undefined ? '' : String(env.MODS_ADMIN_TOKEN).trim();   // a secret piped in keeps its newline
  if (!expected) { await discard(req); return refuse(NOT_FOUND, 404); }
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !(await sameToken(given, expected))) { await discard(req); return refuse('This request needs the maintainer token.', 403); }
  await discard(req);
  await abortUploads(env, Infinity, true);
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
  const build = path.match(/^\/mods\/build\/([0-9a-fA-F]{64})(?:\/(parts|complete)(?:\/(\d{1,9}))?)?$/);
  if (build) {
    const [, raw, kind, part] = build;
    if (raw !== raw.toLowerCase()) { await discard(req); return refuse('A build hash must be written in lowercase hex.', 400); }
    if (!kind) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveBuild(req, env, raw);
      if (req.method === 'PUT') return putBuild(req, env, raw);
      return notAllowed(req, 'GET, HEAD, PUT');
    }
    if (kind === 'parts' && part === undefined) return req.method === 'POST' ? startParts(req, env, raw) : notAllowed(req, 'POST');
    if (kind === 'parts') return req.method === 'PUT' ? putPart(req, env, raw, Number(part)) : notAllowed(req, 'PUT');
    if (part === undefined) return req.method === 'POST' ? completeParts(req, env, raw) : notAllowed(req, 'POST');
  }
  const action = { '/mods/claim': postClaim, '/mods/release': postRelease, '/mods/admin/reset': postReset }[path];
  if (action) return req.method === 'POST' ? action(req, env) : notAllowed(req, 'POST');
  await discard(req);
  return refuse(NOT_FOUND, 404);
}

/* ---------------- scheduled purge ---------------- */

/* Aborts uploads in parts nobody touched for a day (every one, for the reset) and deletes
 * what they stored. */
async function abortUploads(env, rounds, all = false) {
  let count = 0;
  for (let i = 0; i < rounds; i++) {
    const doomed = await registry(env, 'abandonUploads', PURGE_BATCH, all);
    for (const { object, upload } of doomed) {
      try { await env.MODS.resumeMultipartUpload(object, upload).abort(); } catch { /* Completed or aborted already. */ }
    }
    await deleteObjects(env, doomed.map(d => d.object));
    count += doomed.length;
    if (doomed.length < PURGE_BATCH) break;
  }
  return count;
}

/* Deletes unclaimed builds older than the upload window (uploads nothing ever claimed) and
 * abandoned uploads in parts. Bounded per run; the next run continues. A released build
 * does not wait for this: its last release deletes it. */
export async function purgeMods(env, { batch = PURGE_BATCH, rounds = PURGE_ROUNDS } = {}) {
  let builds = 0;
  for (let i = 0; i < rounds; i++) {
    const doomed = await registry(env, 'purgeBuilds', batch);
    await deleteObjects(env, doomed);
    builds += doomed.length;
    if (doomed.length < batch) break;
  }
  const uploads = await abortUploads(env, rounds);
  console.log('mods purge: deleted ' + builds + ' builds and ' + uploads + ' abandoned uploads');
  return { builds, uploads };
}

/* The mod store (SPEC-distribution section 10). It is internal to map publishing: it holds the
 * units published maps claim, and nothing else. A unit is the closure of one placed object, named by
 * the SHA-256 of its canonical manifest (unit.json, the product's modunit.c); its files are blobs,
 * named by their SHA-256 and stored once however many units carry them. Nothing is browsable:
 * every object is reachable only by hash, and any player fetches any unit by hash.
 *
 * Publishing a map (the product's modpublish.c): POST /mods/units says which units the store holds;
 * for each it lacks, POST /mods/unit/<hash>/begin sends the manifest and learns which blobs the store
 * lacks; PUT /mods/unit/<hash>/archive sends them in one ZIP (a blob over one request goes in parts,
 * /mods/blob/<sha>/parts); then POST /mods/map/claim names the map's units. Writes are signed with
 * the publisher's key (mods_publisher.js). Every byte is checked in a MOD_CHECKER Durable Object
 * (every file's SHA-256, size and CRC-32 against the manifest, the manifest against its hash), so the
 * Worker only moves bytes; the MOD_REGISTRY Durable Object indexes units, blobs, packs, claims, the
 * deletion delay and uploads in parts (mods_registry_store.js).
 *
 * The store imposes no limit of its own on a unit: not its size, its file count, one file's size, or
 * the units one claim names. What remains is what the platform fixes (one request body, which is why
 * a large blob goes in parts, and R2's multipart rules). The per-key and per-address hourly limits
 * (WRITE_QUOTAS, D45) protect the bucket and its bill from abuse; a single upload of any size is
 * admitted. Every refusal is one plain sentence in "error". */

import { RequestError, readJsonObject, readBody } from './request_body.js';
import { planStream, unitArchive, crc32, newObjectKey } from './mods_pack.js';
import { authOf, verifySigned, verifyBody, claimedKey, foldedName } from './mods_publisher.js';

/* The largest body one PUT takes, and one part of a larger blob. The platform refuses a request body
 * over 100 MB (100,000,000 bytes) on the Free and Pro plans; 95 MiB is 99,614,720 bytes. R2
 * multipart uploads need every part but the last to have one size, at least 5 MiB, and allow at most
 * 10,000 parts (160 GiB at this size). */
export const ONE_REQUEST_MAX = 95 * 1024 * 1024;
export const PART_SIZE = 16 * 1024 * 1024;
export const UNITS_MAX = 4096;                 // units one status request names (SPEC 10.2)
export const MANIFEST_INLINE = 1024 * 1024;    // a manifest larger than this is an R2 object of its own
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PURGE_BATCH = 500;
const PURGE_ROUNDS = 20;
const SWEEP_PAGES = 200;                  // 200,000 objects listed per daily run
const ORPHAN_AGE_MS = 86400000;          // an object no row names is deleted once it is a day old
const READ_CHUNK = 1024 * 1024;           // the check reads an upload back this much at a time
const REF_MAX = 256;

const HEX64 = /^[0-9a-f]{64}$/;
const SALT_RE = /^[a-z][a-z0-9]{7}$/;
/* A path segment's characters as the builder allows them (modbundle.c mb_path_char), lower case. */
const SEGMENT_RE = /^[a-z0-9._$+@~() -]+$/;
const LUA_SIGNATURE = [0x1b, 0x4c, 0x75, 0x61];   // "\x1bLua", the start of every precompiled chunk
const UNIT_JSON = 'unit.json';
const UNIT_FORMAT = 1;
/* The folders of a mod's own files (R-NM1's layout, SPEC 3.10) and native/ for DOOM files it changes. */
const KIND_FOLDERS = new Set(['entities', 'materials', 'images', 'meshes', 'animations', 'effects', 'particles', 'sounds',
  'scripts', 'movies', 'programs', 'map-modules', 'virtual-textures', 'atlases', 'decls', 'environments', 'native']);
const ROOT_KINDS = new Set(['entity', 'toybox', 'module', 'mod']);
const SOURCE_RE = /^[a-z0-9_.-]{1,64}$/;

/* ---------------- responses ---------------- */

const UNAVAILABLE = 'The mod store is unavailable right now; try again later.';
const NOT_FOUND = 'The mod store has nothing at this address.';
const NOT_ZIP = 'The upload is not a ZIP archive.';
const BAD_SECRET = 'The secret is not 64 lowercase hex characters.';
const NO_UNIT = 'The mod store does not have this unit.';
const NO_BLOB = 'The mod store does not have this file.';
const REMOVED = 'This unit was removed from the mod store.';
/* SPEC 5.22: what a client that speaks the retired routes is told. */
export const RETIRED = 'This version of Snapmap+ cannot use the mod store; run the Snapmap+ installer to update.';

function reply(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...extra } });
}

function refuse(error, status, extra, headers) {
  return reply({ error, ...extra }, status, headers);
}

/* The shared body reader (request_body.js) refuses in a few words; the mod store says a sentence (SPEC section 8). */
const BODY_TOO_LARGE = 'The request body is larger than one request may be.';
const BODY_BROKEN = 'The request body did not arrive whole; send it again.';
async function modsBody(req, maxBytes) {
  try { return await readBody(req, maxBytes); }
  catch (error) {
    if (error instanceof RequestError && error.status === 413) throw new RequestError(BODY_TOO_LARGE, 413);
    if (error instanceof RequestError && error.status === 400) throw new RequestError(BODY_BROKEN, 400);
    throw error;
  }
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

/* A SHA-256 of bytes that stream past (the runtime's DigestStream): write, then end() for the
 * hex digest. Writes queue in order; the reader awaits the newest before it reads more, so
 * hashing keeps pace with the bytes and holds no more than one chunk. */
class StreamHash {
  constructor() {
    this.stream = new crypto.DigestStream('SHA-256');
    this.writer = this.stream.getWriter();
  }

  write(bytes) {
    const last = this.writer.write(bytes);
    last.catch(() => {});
    return last;
  }

  end() {
    const done = this.writer.close().then(() => this.stream.digest).then(hex);
    done.catch(() => {});
    return done;
  }
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return hex(buf);
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

/* The hourly limits (D45): every entry against the client's hashed address, and a write's also
 * against its publishing key (`publisher`, its base64url public half), so neither a key nor an
 * address can flood the store. Writes fail closed when quota storage is unavailable; reads fail
 * open so map content stays fetchable through a quota outage. */
async function admit(req, env, entries, failOpen, publisher = null) {
  try {
    if (publisher) {
      const stub = env.WRITE_QUOTAS.get(env.WRITE_QUOTAS.idFromName('mods-key:' + await sha256Hex(publisher)));
      const result = await stub.consumeMods(entries);
      if (typeof result?.allowed !== 'boolean') throw new Error('invalid quota result');
      if (!result.allowed) return false;
    }
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

function retryAfterHour() {
  return String(Math.max(1, Math.ceil((3600000 - (Date.now() % 3600000)) / 1000)));
}

function rateLimited() {
  return refuse('Too many mod store requests came from this computer or publishing key this hour; try again later.', 429, {}, { 'Retry-After': retryAfterHour() });
}

/* ---------------- registry ---------------- */

async function registry(env, method, ...args) {
  try {
    const stub = env.MOD_REGISTRY.get(env.MOD_REGISTRY.idFromName('registry'));
    return await stub[method](...args);
  } catch (error) {
    const refusal = new RequestError(UNAVAILABLE, 503);
    refusal.retryAfter = retryAfterFor(error);
    console.log('mods: the registry failed (' + method + '):', String(error && error.message).slice(0, 200));
    throw refusal;
  }
}

/* How long a client should wait after a failure of the platform: until the next UTC day when it
 * is a daily allowance of the Workers Free plan running out (the account's plan, docs/services.md),
 * else a minute. */
const RETRY_SOON = 60;
function retryAfterFor(error) {
  const text = String(error && error.message || '');
  if (/limit|exceeded|quota|allowance/i.test(text)) return Math.max(RETRY_SOON, Math.ceil((86400000 - (Date.now() % 86400000)) / 1000));
  return RETRY_SOON;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function displayText(value) {
  return typeof value === 'string' && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/* A path or key as a refusal names it: whole, each character outside printable ASCII
 * shown as "?" (the product reads printable ASCII only). */
function shown(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?');
}

/* What is wrong with a path, as the end of a sentence that starts with the path, or null. The rules
 * are the builder's (modbundle.c sh_mb_check_request, mb_rp_forbidden): relative; no backslash; no
 * empty, "." or ".." segment; no segment starting with a space or ending in a dot or space; the
 * builder's characters only (which excludes every control byte). */
export function pathFault(request) {
  if (typeof request !== 'string' || request.length < 1) return 'has an empty path';
  if (request.startsWith('/')) return 'is an absolute path';
  if (request.includes('\\')) return 'contains a backslash';
  for (const segment of request.split('/')) {
    if (segment === '..' || segment === '.') return 'climbs out of its folder with "." or ".."';
    if (!segment) return 'has an empty folder name';
    if (segment.startsWith(' ') || /[. ]$/.test(segment)) return 'has a name that starts with a space or ends in a dot or a space';
    if (!SEGMENT_RE.test(segment)) return 'has a character a mod path may not use';
  }
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
 * judge: each entry's header fields and name, the one entry named options.capture (unit.json)
 * whole, and a few integers per script. File contents pass through untouched and the central directory is
 * checked record by record against the entries as it streams, so memory grows with the
 * number of entries and the size of the captured entry, never with the archive's size. The form is
 * the product's (modzip.c): stored entries with their sizes in the local header, then the
 * central directory, then (when a value needs it) the ZIP64 end record and locator, then
 * the end record; nothing before, between or after. ZIP64 values stand where a field holds
 * its marker, so there is no bound on an entry's size, the archive's size or the number of
 * entries. error is the first refusal; once set, later bytes are ignored. */
export class ArchiveWalker {
  /* options: hash false, entries are not hashed as they pass; base, the archive offset the
   * stream starts at; segmentEnd, a part of the archive (whole entries, ending there, before its
   * central directory: walkSegment); tail, the central directory and end records only, against
   * the entries already walked (options.entries). length is the offset the stream ends at. */
  constructor(length, options = {}) {
    this.hashEntries = options.hash !== false;
    this.crc = !!options.crc;          // each entry's CRC-32 computed as it passes (entry.crcComputed)
    this.capture = options.capture || null;
    this.length = length;
    this.at = options.base || 0;     // the archive offset reached
    this.segmentEnd = options.segmentEnd ?? null;
    this.tailOnly = !!options.tail;
    this.state = 'sig';              // sig, local, localVar, data, central, centralVar, end, endComment, trail
    this.buf = new Uint8Array(64);
    this.need = 4;
    this.have = 0;
    this.recordStart = 0;
    this.current = null;
    this.pending = null;             // a central record's fixed fields, until its name is read
    this.remaining = 0;
    this.entries = options.entries || [];
    this.names = new Set(this.entries.map(e => e.name));
    this.captured = null;            // the bytes of the entry named options.capture
    this.scripts = 0;
    this.central = 0;                // central records read
    this.cdStart = -1;
    this.cdEnd = -1;
    this.z64 = null;                 // the ZIP64 end record's values, when the archive has one
    this.error = null;
    this.done = false;
    this.tailParts = [];             // the central directory and end records, as they arrived
    this.tailBytes = 0;
    this.hashing = Promise.resolve();   // the newest write to an entry's hash
  }

  /* Bytes of the central directory or the end records, kept for the skeleton. */
  keepTail(bytes) {
    if (this.cdStart < 0 || this.recordStart < this.cdStart) return;
    this.tailParts.push(bytes.slice());
    this.tailBytes += bytes.byteLength;
  }

  /* The central directory and end records, whole. */
  tail() {
    const out = new Uint8Array(this.tailBytes);
    let at = 0;
    for (const part of this.tailParts) { out.set(part, at); at += part.byteLength; }
    return out;
  }

  /* Resolves when every byte pushed so far is hashed. */
  settled() {
    return this.hashing;
  }

  /* Every entry's SHA-256, once the archive has ended: entry.sha set on each. */
  async digests() {
    await Promise.all(this.entries.map(async entry => { if (entry.digest) entry.sha = await entry.digest; }));
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
        if (entry.hash) this.hashing = entry.hash.write(bytes);
        if (this.crc) entry.crcRun = crc32(bytes, entry.crcRun);
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
    entry.digest = entry.hash ? entry.hash.end() : null;
    if (this.crc) entry.crcComputed = entry.crcRun;
    entry.hash = null;
    this.current = null;
    this.toSig();
  }

  toSig() {
    if (this.have) this.keepTail(this.buf.subarray(0, this.have));
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
      if (this.segmentEnd !== null && sig !== SIG_LOCAL) return this.fail('The archive has unexpected bytes after an entry.');
      if (sig === SIG_LOCAL && this.cdStart < 0 && !this.tailOnly) { this.state = 'local'; this.expect(30); return; }
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
      entry.header = b.slice(0, this.need);
      entry.hash = this.hashEntries ? new StreamHash() : null;
      this.names.add(name);
      this.entries.push(entry);
      if (this.crc) entry.crcRun = 0;
      if (this.capture !== null && name === this.capture) {
        if (entry.size > PART_SIZE) return this.fail('The archive\'s ' + shown(name) + ' is larger than a manifest may be.');
        entry.data = this.captured = new Uint8Array(entry.size);
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
      this.keepTail(b.subarray(0, this.need));
      this.state = 'trail';
      this.done = true;
      return;
    }
    case 'endComment':
      this.keepTail(b.subarray(0, this.need));
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
    if (this.segmentEnd !== null) {
      if (this.state !== 'sig' || this.have) this.fail('The archive ends inside an entry.');
      return;
    }
    if (this.done) {
      if (this.tailBytes !== this.length - this.cdStart) this.fail('The archive\'s central directory could not be read whole.');
      return;
    }
    this.done = false;
    if (this.cdStart < 0) return this.fail('The archive ends before its central directory.');
    if (this.state === 'centralVar') return this.fail('The archive\'s central directory is cut short.');
    if (this.central < this.entries.length) return this.fail('The archive\'s central directory does not list every entry.');
    return this.fail('The archive has no end of central directory record.');
  }
}

/* ---------------- the unit's manifest ---------------- */

/* What is wrong with a unit file's path (the mod's own path, author layout), as the end of a sentence
 * that starts with the path, or null: lower case, the builder's characters, inside one of a mod's
 * folders (SPEC 3.4). */
function authorPathFault(path) {
  if (typeof path !== 'string' || path !== path.toLowerCase()) return 'is not written in lower case';
  const fault = pathFault(path);
  if (fault) return fault;
  if (!path.includes('/') || !KIND_FOLDERS.has(path.slice(0, path.indexOf('/')))) return 'is in none of a mod\'s folders';
  return null;
}

/* The manifest (its exact bytes) judged by SPEC 3.7's upload checks 2: it parses, its keys are
 * exactly SPEC 3.4's, its paths are valid. Returns { files, game, root, spelled, size, distinct } or
 * { error } (one sentence). `distinct` is [[sha, size]] per blob. The hash is checked by the caller. */
export function unitVerdict(bytes) {
  const bad = what => ({ error: 'The unit\'s manifest ' + what });
  let doc;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { return bad('is not JSON text.'); }
  if (!plainObject(doc)) return bad('is not a JSON object.');
  for (const key of Object.keys(doc)) if (!['files', 'format', 'game', 'mod', 'root', 'spelled'].includes(key)) return bad('has a key a unit does not have: ' + shown(key) + '.');
  for (const key of ['files', 'format', 'game', 'mod', 'root']) if (!(key in doc)) return bad('has no "' + key + '".');
  if (doc.format !== UNIT_FORMAT) return bad('is in a unit format this mod store does not know.');
  if (!Array.isArray(doc.files)) return bad('lists its files by something other than a list.');
  if (!Array.isArray(doc.game)) return bad('lists DOOM\'s files by something other than a list.');
  if (!plainObject(doc.mod)) return bad('gives its mod part as something other than an object.');
  if (!plainObject(doc.root) || Object.keys(doc.root).length !== 2 || !ROOT_KINDS.has(doc.root.kind) ||
      typeof doc.root.name !== 'string' || !doc.root.name || !displayText(doc.root.name)) return bad('names its root wrongly.');
  if ('spelled' in doc && !(typeof doc.spelled === 'string' && SALT_RE.test(doc.spelled))) return bad('names the namespace its files spell wrongly.');
  const sizes = new Map();
  let size = 0, last = null;
  for (const f of doc.files) {
    if (!plainObject(f) || Object.keys(f).length !== 3 || typeof f.path !== 'string' || typeof f.sha256 !== 'string' ||
        !HEX64.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) return bad('lists a file entry Snapmap+ did not write.');
    const fault = authorPathFault(f.path);
    if (fault) return bad('lists ' + shown(f.path) + ', which ' + fault + '.');
    if (last !== null && !(f.path > last)) return bad('lists its files out of order or twice.');
    last = f.path;
    if (sizes.has(f.sha256) && sizes.get(f.sha256) !== f.size) return bad('names one SHA-256 at two sizes.');
    sizes.set(f.sha256, f.size);
    size += f.size;
  }
  last = null;
  for (const g of doc.game) {
    if (!plainObject(g) || typeof g.path !== 'string' || typeof g.sha256 !== 'string' || !HEX64.test(g.sha256) ||
        typeof g.source !== 'string' || !SOURCE_RE.test(g.source) ||
        Object.keys(g).some(k => !['at', 'path', 'sha256', 'source'].includes(k))) return bad('lists a DOOM file entry Snapmap+ did not write.');
    const fault = g.path !== g.path.toLowerCase() ? 'is not written in lower case' : pathFault(g.path);
    if (fault) return bad('lists DOOM\'s ' + shown(g.path) + ', which ' + fault + '.');
    if ('at' in g) { const f2 = authorPathFault(g.at); if (f2) return bad('places DOOM\'s file at ' + shown(g.at) + ', which ' + f2 + '.'); }
    if (last !== null && g.path < last) return bad('lists DOOM\'s files out of order.');
    last = g.path;
  }
  return { files: doc.files, game: doc.game, root: doc.root, spelled: doc.spelled ?? null, size, distinct: [...sizes] };
}

function hexOf(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/* The bytes of a unit's manifest the registry recorded: inline text or an R2 object. */
async function manifestBytes(env, row) {
  if (row.manifest !== null && row.manifest !== undefined) return new TextEncoder().encode(row.manifest);
  const obj = row.manifestObject || row.manifest_object ? await env.MODS.get(row.manifestObject || row.manifest_object) : null;
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

/* ---------------- the checks (in a MOD_CHECKER Durable Object) ---------------- */

/* A signed request's publisher is recorded and its account name bound (D31). It runs after the request's own work is
 * done, so a registry that fails here never turns a done claim or release into a refusal (B10): the next signed
 * request records it. */
async function seen(env, signed) {
  try { await registry(env, 'publisherSeen', signed.key, signed.name, foldedName(signed.name)); }
  catch (error) { console.log('mods: the publisher was not recorded:', String(error && error.message).slice(0, 200)); }
}

/* POST /mods/unit/<hash>/begin: `bytes` is the manifest. Its SHA-256 must be the hash (SPEC 3.7 upload
 * check 1); since it is, the request's body hash is the unit hash. Returns { status, body }. */
export async function beginIn(env, hash, bytes, auth) {
  if ((await sha256Hex(bytes)) !== hash) return { status: 422, body: { error: 'The unit\'s manifest does not have the SHA-256 its address names.' } };
  const signed = await verifySigned(auth, hash);
  if (signed.refusal) return { status: 403, body: { error: signed.refusal } };
  const verdict = unitVerdict(bytes);
  if (verdict.error) return { status: 422, body: { error: verdict.error } };
  let manifest = null, manifestObject = null;
  if (bytes.byteLength <= MANIFEST_INLINE) manifest = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  else {
    manifestObject = newObjectKey('manifest', hash);
    await env.MODS.put(manifestObject, bytes, { httpMetadata: { contentType: 'application/json' } });
  }
  const result = await registry(env, 'beginUnit', {
    hash, manifest, manifestObject, mlen: bytes.byteLength, size: verdict.size, files: verdict.distinct,
    spelled: verdict.spelled, rootKind: verdict.root.kind, rootName: verdict.root.name, key: signed.key,
  });
  await deleteQueued(env, result.discard);
  await seen(env, signed);
  if (result.blocked) return { status: 451, body: { error: REMOVED, removed: [hash] } };
  if (result.conflict) return { status: 422, body: { error: 'The unit\'s manifest names a file at another size than the bytes of that SHA-256.' } };
  if (result.held) return { status: 200, body: { held: true } };
  return { status: 200, body: { missing: result.missing, partSize: PART_SIZE, oneRequest: ONE_REQUEST_MAX } };
}

async function walkStream(stream, length, options = {}) {
  const walker = new ArchiveWalker(length, options);
  const whole = options.wholeHash ? new StreamHash() : null;
  let reader, byob = true;
  try { reader = stream.getReader({ mode: 'byob' }); } catch { byob = false; reader = stream.getReader(); }
  const feed = async bytes => {
    if (whole) whole.write(bytes);
    walker.push(bytes);
    await walker.settled();
  };
  try {
    for (;;) {
      if (!byob) {
        const { value, done } = await reader.read();
        if (done) break;
        await feed(value);
        continue;
      }
      let buf = new Uint8Array(READ_CHUNK), filled = 0, done = false;
      while (filled < buf.byteLength) {
        const r = await reader.read(new Uint8Array(buf.buffer, filled, buf.byteLength - filled));
        if (r.done) { done = true; if (r.value) buf = new Uint8Array(r.value.buffer); break; }
        buf = new Uint8Array(r.value.buffer);
        filled += r.value.byteLength;
      }
      if (filled) await feed(buf.subarray(0, filled));
      if (done) break;
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
  walker.finish();
  if (whole) walker.wholeSha = await whole.end();
  return walker;
}

/* The check of an uploaded unit archive stored as `object` (SPEC 3.7 upload checks 3 and 4): read
 * back once, every entry hashed and its CRC-32 computed; unit.json must be the unit's begun manifest,
 * every other entry a file that manifest lists, at its path, with its SHA-256 and size, and nothing
 * else. The signature covers the archive's SHA-256, computed in the same pass. A passing archive is
 * kept as a pack; a refused one is deleted. Returns { status, body }. */
export async function checkUnitArchiveIn(env, hash, object, size, auth) {
  const refuseWith = async (status, error, extra = {}) => { await deleteObjects(env, [object]); return { status, body: { error, ...extra } }; };
  const head = await env.MODS.head(object);
  if (!head || head.size !== size) return refuseWith(400, 'The upload ended before the whole archive arrived; try again.');
  const row = await registry(env, 'unitRow', hash);
  if (!row) return refuseWith(409, 'The mod store has no upload of this unit begun; begin it again.');
  const mbytes = await manifestBytes(env, row);
  if (!mbytes) return refuseWith(503, UNAVAILABLE);
  const verdict = unitVerdict(mbytes);
  if (verdict.error) return refuseWith(503, UNAVAILABLE);
  const listed = new Map(verdict.files.map(f => [f.path, f]));
  const obj = await env.MODS.get(object);
  const walker = obj ? await walkStream(obj.body, size, { crc: true, wholeHash: true, capture: UNIT_JSON }) : null;
  if (!walker) return refuseWith(503, UNAVAILABLE);
  if (walker.error) return refuseWith(422, walker.error);
  await walker.digests();
  const signed = await verifySigned(auth, walker.wholeSha);
  if (signed.refusal) return refuseWith(403, signed.refusal);
  let manifestSeen = false;
  const blobs = [];
  for (const e of walker.entries) {
    if (e.name === UNIT_JSON) {
      if (e.sha !== hash) return refuseWith(422, 'The archive\'s unit.json is not the unit\'s manifest.');
      manifestSeen = true;
      continue;
    }
    const f = listed.get(e.name);
    if (!f) return refuseWith(422, 'The archive holds ' + shown(e.name) + ', which the unit\'s manifest does not list.');
    if (f.sha256 !== e.sha || f.size !== e.size) return refuseWith(422, 'The archive\'s ' + shown(e.name) + ' is not the file the unit\'s manifest names.');
    if (e.crcComputed !== e.crc) return refuseWith(422, 'The archive\'s ' + shown(e.name) + ' does not have the CRC-32 its header gives.');
    if (e.scriptFault) return refuseWith(422, shown(e.name) + ' ' + e.scriptFault + '.');
    blobs.push({ sha: e.sha, size: e.size, crc: e.crc, at: e.offset, hlen: e.header.byteLength, hdr: hexOf(e.header) });
  }
  if (!manifestSeen) return refuseWith(422, 'The archive has no unit.json.');
  const result = await registry(env, 'commitUnitArchive', hash, object, size, blobs);
  await deleteQueued(env, result.discard);
  await seen(env, signed);
  if (result.gone) return { status: 409, body: { error: 'The mod store has no upload of this unit begun; begin it again.' } };
  if (result.held) return { status: 201, body: { held: true } };
  return { status: 200, body: { held: false, missing: result.missing } };
}

/* The check of one blob uploaded in parts, stored as `object`: its SHA-256, size and CRC-32. */
export async function checkBlobIn(env, sha, object, size) {
  const obj = await env.MODS.get(object);
  if (!obj || obj.size !== size) { await deleteObjects(env, [object]); return { status: 400, body: { error: 'The parts of this file did not arrive whole; upload it again.' } }; }
  const h = new StreamHash();
  let crc = 0;
  const reader = obj.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      crc = crc32(value, crc);
      await h.write(value);
    }
  } catch { await deleteObjects(env, [object]); return { status: 503, body: { error: UNAVAILABLE } }; }
  if ((await h.end()) !== sha) { await deleteObjects(env, [object]); return { status: 422, body: { error: 'The file\'s bytes do not have the SHA-256 its address names.' } }; }
  const result = await registry(env, 'commitBlob', sha, size, crc, object);
  await deleteQueued(env, result.discard);
  return { status: 201, body: { held: true } };
}

/* The serving plan of a unit's archive: { size, plan, raw } or null when it is not served. */
/* The files a `want` mask names, in the manifest's order: bit i (byte i >> 3, value 1 << (i & 7)) is the manifest's
 * file i. The mask is base64url of exactly ceil(files / 8) bytes; null for none (every file); 'bad' for one that is
 * not such a mask. */
export function wantedFiles(files, want) {
  if (want === null || want === undefined) return files;
  if (typeof want !== 'string' || !/^[A-Za-z0-9_-]*$/.test(want)) return 'bad';
  let mask;
  try { mask = Uint8Array.from(atob(want.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(want.length / 4) * 4, '=')), c => c.charCodeAt(0)); }
  catch { return 'bad'; }
  if (mask.length !== Math.ceil(files.length / 8)) return 'bad';
  return files.filter((f, i) => mask[i >> 3] & (1 << (i & 7)));
}

/* The serving plan of a unit's archive: unit.json and every file, or (`want`) the files a mask names, so a player who
 * holds most of a unit's files already still gets the rest in one request. */
export async function archivePlanIn(env, hash, want = null) {
  const served = await registry(env, 'unitServed', hash, true);
  if (!served) return null;
  const mbytes = await manifestBytes(env, served);
  const verdict = mbytes ? unitVerdict(mbytes) : null;
  if (!verdict || verdict.error) return null;
  const files = wantedFiles(verdict.files, want);
  if (files === 'bad') return { bad: true };
  return unitArchive(mbytes, files, served.blobs);
}

/* A player's game asked unit `hash` for `path` (3.8). Returns { status, body }. */
export async function askedIn(env, hash, path) {
  const row = await registry(env, 'unitRow', hash);
  if (!row) return { status: 404, body: { error: NO_UNIT } };
  const mbytes = await manifestBytes(env, row);
  const verdict = mbytes ? unitVerdict(mbytes) : null;
  if (!verdict || verdict.error) return { status: 503, body: { error: UNAVAILABLE } };
  if (verdict.files.some(f => f.path === path)) return { status: 400, body: { error: 'The unit holds that file already.' } };
  const result = await registry(env, 'reportAsked', hash, path);
  if (result.notFound) return { status: 404, body: { error: NO_UNIT } };
  return { status: 204, body: null };
}

/* A checker's method: in the unit's MOD_CHECKER Durable Object when the binding is there (deployed),
 * else here (the unit tests). */
async function checker(env, name, method, ...args) {
  const local = { begin: beginIn, archive: checkUnitArchiveIn, blob: checkBlobIn, plan: archivePlanIn, asked: askedIn }[method];
  if (!env.MOD_CHECKER) return local(env, ...args);
  try {
    return await env.MOD_CHECKER.get(env.MOD_CHECKER.idFromName(name))[method](...args);
  } catch (error) {
    console.log('mods: the check failed (' + method + '):', String(error && error.message).slice(0, 200));
    const refusal = new RequestError(UNAVAILABLE, 503);
    refusal.retryAfter = retryAfterFor(error);
    throw refusal;
  }
}

function answer(result) {
  return result.body === null ? new Response(null, { status: result.status }) : reply(result.body, result.status);
}

async function deleteObjects(env, objects) {
  const keys = (objects || []).filter(Boolean);
  for (let i = 0; i < keys.length; i += 1000) await env.MODS.delete(keys.slice(i, i + 1000));
}

/* Deletes objects the registry queued, then tells it so; what fails stays queued for the purge.
 * Returns how many left the queue (0 when the deletion failed). */
async function deleteQueued(env, objects) {
  const keys = (objects || []).filter(Boolean);
  if (!keys.length) return 0;
  try {
    await deleteObjects(env, keys);
    await registry(env, 'forgetDead', keys);
    return keys.length;
  } catch (error) {
    console.log('mods: deleting ' + keys.length + ' object(s) failed; they stay queued:', String(error && error.message).slice(0, 200));
    return 0;
  }
}

/* ---------------- reads ---------------- */

function objectHeaders(type, length, tag) {
  const h = new Headers();
  h.set('Content-Type', type);
  h.set('Content-Length', String(length));
  h.set('Cache-Control', IMMUTABLE);
  h.set('ETag', '"' + tag + '"');
  h.set('Accept-Ranges', 'bytes');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Content-Disposition', 'attachment');
  return h;
}

/* The one byte range a GET asks for, as { start, end } (end exclusive); null for the whole object
 * (no Range, an If-Range for another object, or a form this store does not serve, such as several
 * ranges); 'unsatisfiable' for a range wholly past the end. */
export function wantedRange(req, size, tag) {
  const header = req.headers.get('Range');
  if (!header) return null;
  const ifRange = req.headers.get('If-Range');
  if (ifRange && ifRange.trim() !== '"' + tag + '"') return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size };
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last)) return null;
  if (start >= size) return 'unsatisfiable';
  if (last < start) return null;
  return { start, end: Math.min(last, size - 1) + 1 };
}

function unsatisfiable(size) {
  return new Response(JSON.stringify({ error: 'The range asked for lies past the end of this file.' }),
    { status: 416, headers: { 'Content-Type': 'application/json', 'Content-Range': 'bytes */' + size } });
}

/* POST /mods/units {"units": [hash...]}: held, missing or removed for each (at most UNITS_MAX). */
async function postUnits(req, env) {
  if (!(await admit(req, env, [['mod_get', 1]], true))) { await discard(req); return rateLimited(); }
  const body = await readRequestJson(req);
  if (!Array.isArray(body.units) || !body.units.every(h => typeof h === 'string' && HEX64.test(h))) return refuse('The request does not list units by hash.', 400);
  if (body.units.length > UNITS_MAX) return refuse('The request names more than ' + UNITS_MAX + ' units; ask in several requests.', 400);
  return reply(await registry(env, 'unitStatus', body.units));
}

/* GET /mods/unit/<hash>: the manifest's exact bytes. Held units are served while a claim names them
 * or within their deletion delay. */
async function getUnit(req, env, hash) {
  if (!(await admit(req, env, [['mod_get', 1]], true))) return rateLimited();
  const status = await registry(env, 'unitStatus', [hash]);
  if (status[hash] === 'removed') return refuse(REMOVED, 451, { removed: [hash] });
  const served = await registry(env, 'unitServed', hash, false);
  if (!served) return refuse(NO_UNIT, 404);
  const bytes = await manifestBytes(env, served);
  if (!bytes) return refuse(NO_UNIT, 404);
  const headers = objectHeaders('application/json', bytes.byteLength, hash);
  headers.delete('Content-Disposition');
  return new Response(req.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

/* GET /mods/unit/<hash>/archive[?want=<mask>]: a ZIP of unit.json and every file at its path (or the files the mask
 * names, wantedFiles), written from the manifest and streamed from packs; one byte range resumes a broken-off
 * download. A player gets a unit in this one request (R-DS6: a file-by-file download passed every file through the
 * quota and the registry, and the account's daily rows written ran out). */
async function getUnitArchive(req, env, hash) {
  if (!(await admit(req, env, [['mod_get', 1]], true))) return rateLimited();
  const want = new URL(req.url).searchParams.get('want');
  const status = await registry(env, 'unitStatus', [hash]);
  if (status[hash] === 'removed') return refuse(REMOVED, 451, { removed: [hash] });
  const made = await checker(env, 'unit:' + hash, 'plan', hash, want);
  if (!made) return refuse(NO_UNIT, 404);
  if (made.bad) return refuse('The request names the unit\'s files with a mask that does not fit it.', 400);
  const tag = hash + (want === null ? '' : '.' + want) + '.zip';
  const range = req.method === 'GET' ? wantedRange(req, made.size, tag) : null;
  if (range === 'unsatisfiable') return unsatisfiable(made.size);
  const start = range ? range.start : 0, end = range ? range.end : made.size;
  const headers = objectHeaders('application/zip', end - start, tag);
  if (range) headers.set('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + made.size);
  if (req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const raw = made.raw instanceof Uint8Array ? made.raw : new Uint8Array(made.raw);
  const body = planStream(env, made.plan, raw, start, end, object => registry(env, 'markBroken', object));
  return new Response(body, { status: range ? 206 : 200, headers });
}

/* GET /mods/blob/<sha>: one file's bytes, while a held unit names it; one byte range resumes. */
async function getBlob(req, env, sha) {
  if (!(await admit(req, env, [['mod_get', 1]], true))) return rateLimited();
  const loc = await registry(env, 'blobLocation', sha);
  if (!loc) return refuse(NO_BLOB, 404);
  const range = req.method === 'GET' ? wantedRange(req, loc.size, sha) : null;
  if (range === 'unsatisfiable') return unsatisfiable(loc.size);
  const start = range ? range.start : 0, end = range ? range.end : loc.size;
  const headers = objectHeaders('application/octet-stream', end - start, sha);
  if (range) headers.set('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + loc.size);
  if (req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  if (end === start) return new Response(new Uint8Array(0), { status: range ? 206 : 200, headers });
  const obj = await env.MODS.get(loc.object, { range: { offset: loc.at + start, length: end - start } });
  if (!obj) { await registry(env, 'markBroken', loc.object); return refuse(NO_BLOB, 404); }
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

/* ---------------- uploads ---------------- */

function declaredLength(req) {
  const declared = req.headers.get('Content-Length');
  if (declared === null) return { refusal: refuse('An upload must be sent with its Content-Length.', 411) };
  if (!/^\d+$/.test(declared)) return { refusal: refuse('The Content-Length of the upload is not a number.', 400) };
  return { length: Number(declared) };
}

/* A signed write's key, for counting limits before its body is checked, or a refusal. */
function writerKey(auth) {
  const key = claimedKey(auth);
  return key ? { key } : { refusal: refuse('This request must be signed with a publishing key.', 403) };
}

/* POST /mods/unit/<hash>/begin: the manifest's bytes. */
async function postBegin(req, env, hash, path) {
  const auth = authOf(req, path);
  const { refusal } = writerKey(auth);
  if (refusal) { await discard(req); return refusal; }
  const bytes = await modsBody(req, PART_SIZE).catch(error => { throw error instanceof RequestError && error.status === 413
    ? new RequestError('The manifest is larger than one request may be.', 413) : error; });
  /* The key's quota is charged only for a request its key signed (B10). */
  const signed = await verifyBody(auth, bytes);
  if (signed.refusal) return refuse(signed.refusal, 403);
  if (!(await admit(req, env, [['mod_build_put', 1]], false, signed.key))) return rateLimited();
  return answer(await checker(env, 'unit:' + hash, 'begin', hash, bytes, auth));
}

/* PUT /mods/unit/<hash>/archive: a ZIP of unit.json and the blobs the begin answered missing, in one
 * request of at most ONE_REQUEST_MAX bytes. Piped to an object of its own, then checked; a refused
 * archive is deleted, and since no row names it, it is never served in between. */
async function putUnitArchive(req, env, hash, path) {
  const auth = authOf(req, path);
  const { key, refusal: unsigned } = writerKey(auth);
  if (unsigned) { await discard(req); return unsigned; }
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/zip') { await discard(req); return refuse('A unit archive must be sent as application/zip.', 415); }
  const { length, refusal } = declaredLength(req);
  if (refusal) { await discard(req); return refusal; }
  if (length > ONE_REQUEST_MAX) { await discard(req); return refuse('An archive over 95 MiB goes to the mod store as several archives, or a large file in parts.', 413); }
  if (length < 22) { await discard(req); return refuse(NOT_ZIP, 422); }
  if (!(await admit(req, env, [['mod_bytes', length]], false, key))) { await discard(req); return rateLimited(); }
  if (!req.body) return refuse('The upload ended before the whole archive arrived; try again.', 400);
  const object = newObjectKey('pack', hash);
  try {
    await env.MODS.put(object, req.body.pipeThrough(new FixedLengthStream(length)), { httpMetadata: { contentType: 'application/zip' } });
  } catch {
    await deleteObjects(env, [object]);
    return refuse('The upload ended before the whole archive arrived; try again.', 400);
  }
  return answer(await checker(env, 'unit:' + hash, 'archive', hash, object, length, auth));
}

/* POST /mods/unit/<hash>/complete: 201 when every blob is held, 409 with what is missing. */
async function postComplete(req, env, hash, path) {
  const auth = authOf(req, path);
  const bytes = await modsBody(req, 65536);
  const signed = await verifyBody(auth, bytes);
  if (signed.refusal) return refuse(signed.refusal, 403);
  const result = await registry(env, 'completeUnit', hash);
  if (result.notFound) return refuse('The mod store has no upload of this unit begun; begin it again.', 404);
  if (result.missing) return refuse('The mod store does not hold every file of this unit yet; upload the rest.', 409, { missing: result.missing });
  return reply({ held: true }, 201);
}

function partsOf(size) { return Math.ceil(size / PART_SIZE); }
function partLength(size, part) { return part < partsOf(size) ? PART_SIZE : size - (partsOf(size) - 1) * PART_SIZE; }

function sessionReply(sha, size, session, status) {
  const have = [];
  session.etags.forEach((etag, i) => { if (etag) have.push(i + 1); });
  return reply({ blob: sha, size, partSize: session.partSize, parts: session.parts, have }, status);
}

/* The size a parts request names, from its signed body. */
async function signedSize(req, path) {
  const bytes = await modsBody(req, 65536);
  const signed = await verifyBody(authOf(req, path), bytes);
  if (signed.refusal) return { refusal: refuse(signed.refusal, 403) };
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { body = null; }
  if (!plainObject(body) || !Number.isSafeInteger(body.size) || body.size < 1) return { refusal: refuse('The upload names no file size.', 400) };
  return { size: body.size, signed };
}

/* POST /mods/blob/<sha>/parts {"size"}: starts an upload in parts of one blob a begun unit names, or
 * resumes the one at this size, answering which parts the store holds. Only a new upload counts
 * against the limits, as its whole size; its parts and its completion count nothing. */
async function startParts(req, env, sha, path) {
  const { size, signed, refusal } = await signedSize(req, path);
  if (refusal) return refusal;
  const session = await registry(env, 'uploadSession', sha, size);
  if (session) return sessionReply(sha, size, session, 200);
  if (!(await registry(env, 'blobWanted', sha, size))) return refuse('No unit the mod store is receiving needs this file at this size.', 409);
  if (!(await admit(req, env, [['mod_bytes', size]], false, signed.key))) return rateLimited();
  const object = newObjectKey('blob', sha);
  const upload = await env.MODS.createMultipartUpload(object, { httpMetadata: { contentType: 'application/octet-stream' } });
  const opened = await registry(env, 'openUpload', { sha, size, object, upload: upload.uploadId, partSize: PART_SIZE, parts: partsOf(size) });
  if (opened.existing) {
    try { await upload.abort(); } catch { /* It held no parts. */ }
    return sessionReply(sha, size, opened, 200);
  }
  return sessionReply(sha, size, opened, 201);
}

/* PUT /mods/blob/<sha>/parts/<n> with X-Blob-Size: stores one part. A part is bound to its session;
 * whoever sends it, the blob's SHA-256 is checked whole at the completion, so a wrong part costs only
 * a retry. A part sent again replaces the earlier copy. */
async function putPart(req, env, sha, part) {
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') { await discard(req); return refuse('A part must be sent as application/octet-stream.', 415); }
  const sizeText = req.headers.get('X-Blob-Size') || '';
  if (!/^\d+$/.test(sizeText)) { await discard(req); return refuse('A part must name its file size in X-Blob-Size.', 400); }
  const size = Number(sizeText);
  const { length, refusal } = declaredLength(req);
  if (refusal) { await discard(req); return refusal; }
  const session = Number.isSafeInteger(size) ? await registry(env, 'uploadSession', sha, size) : null;
  if (!session) { await discard(req); return refuse('The mod store has no upload of this file in progress; start it again.', 404); }
  if (part < 1 || part > session.parts) { await discard(req); return refuse('The upload has no part with that number.', 400); }
  if (length !== partLength(size, part)) { await discard(req); return refuse('The part is not the length its place in the file needs.', 400); }
  if (!req.body) return refuse('The part ended before all of it arrived; send it again.', 400);
  const upload = env.MODS.resumeMultipartUpload(session.object, session.upload);
  let stored;
  try { stored = await upload.uploadPart(part, req.body.pipeThrough(new FixedLengthStream(length))); }
  catch { return refuse('The part ended before all of it arrived; send it again.', 400); }
  const after = await registry(env, 'recordPart', sha, size, session.upload, part, stored.etag);
  if (!after) return refuse('The mod store has no upload of this file in progress; start it again.', 404);
  return sessionReply(sha, size, after, 200);
}

/* POST /mods/blob/<sha>/complete {"size"}: joins the parts and checks the blob. */
async function completeParts(req, env, sha, path) {
  const { size, refusal } = await signedSize(req, path);
  if (refusal) return refusal;
  const session = await registry(env, 'uploadSession', sha, size);
  if (!session) return refuse('The mod store has no upload of this file in progress; start it again.', 404);
  if (session.etags.filter(Boolean).length !== session.parts) return sessionReply(sha, size, session, 409);
  const upload = env.MODS.resumeMultipartUpload(session.object, session.upload);
  try {
    await upload.complete(session.etags.map((etag, i) => ({ partNumber: i + 1, etag })));
  } catch {
    try { await upload.abort(); } catch { /* Already completed or aborted. */ }
    await registry(env, 'closeUpload', sha, size, session.upload);
    await deleteObjects(env, [session.object]);
    return refuse('The parts of this upload did not join into one file; upload it again.', 409);
  }
  let result;
  try { result = await checker(env, 'blob:' + sha, 'blob', sha, session.object, size); }
  finally { await registry(env, 'closeUpload', sha, size, session.upload); }
  return answer(result);
}

/* ---------------- claims ---------------- */

async function readRequestJson(req) {
  try { return await readJsonObject(req, PART_SIZE); }
  catch (error) {
    if (error instanceof RequestError && error.status === 413) throw new RequestError('The request body is larger than one request may be.', 413);
    if (error instanceof RequestError && error.status === 400) throw new RequestError('The request body is not a JSON object.', 400);
    throw error;
  }
}

/* A signed JSON body: { body, signed } or { refusal }. */
async function signedJson(req, path) {
  const bytes = await modsBody(req, PART_SIZE);
  const signed = await verifyBody(authOf(req, path), bytes);
  if (signed.refusal) return { refusal: refuse(signed.refusal, 403) };
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { body = null; }
  if (!plainObject(body)) return { refusal: refuse('The request body is not a JSON object.', 400) };
  return { body, signed };
}

function validRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= REF_MAX && displayText(ref);
}

/* POST /mods/map/claim {ref, units, secret, rev}, signed (SPEC 10.2, D33). */
async function postClaim(req, env, path) {
  const auth = authOf(req, path);
  const { refusal: unsigned } = writerKey(auth);
  if (unsigned) { await discard(req); return unsigned; }
  const { body, signed, refusal } = await signedJson(req, path);
  if (refusal) return refusal;
  if (!(await admit(req, env, [['mod_claim', 1]], false, signed.key))) return rateLimited();
  if (!validRef(body.ref)) return refuse('The claim names no published item.', 400);
  if (!Array.isArray(body.units) || !body.units.every(h => typeof h === 'string' && HEX64.test(h))) return refuse('The claim does not list its units by hash.', 400);
  if (typeof body.secret !== 'string' || !HEX64.test(body.secret)) return refuse(BAD_SECRET, 400);
  if (!Number.isSafeInteger(body.rev) || body.rev < 1) return refuse('The claim names no revision.', 400);
  const result = await registry(env, 'claim', { ref: body.ref, units: body.units, secretHash: await sha256Hex(body.secret), rev: body.rev,
    key: signed.key, id: randomHex(16) });
  await seen(env, signed);
  if (result.stale !== undefined) return refuse('This map\'s claim changed since this computer last saw it.', 409, { rev: result.stale });
  if (result.missing) return refuse('The mod store does not hold every unit the claim names; upload them first.', 409, { missing: result.missing });
  if (result.removed.length) return refuse(result.removed.length === 1 ? REMOVED : 'Some of these units were removed from the mod store.', 451,
    { removed: result.removed, claim: result.claim, rev: result.rev });
  return reply({ claim: result.claim, rev: result.rev }, result.created ? 201 : 200);
}

/* POST /mods/map/release {ref, secret, rev}, signed. */
async function postRelease(req, env, path) {
  const auth = authOf(req, path);
  const { refusal: unsigned } = writerKey(auth);
  if (unsigned) { await discard(req); return unsigned; }
  const { body, signed, refusal } = await signedJson(req, path);
  if (refusal) return refusal;
  if (!(await admit(req, env, [['mod_claim', 1]], false, signed.key))) return rateLimited();
  if (!validRef(body.ref)) return refuse('The release names no published item.', 400);
  if (typeof body.secret !== 'string' || !HEX64.test(body.secret)) return refuse(BAD_SECRET, 400);
  if (!Number.isSafeInteger(body.rev) || body.rev < 1) return refuse('The release names no revision.', 400);
  const result = await registry(env, 'release', { ref: body.ref, secretHash: await sha256Hex(body.secret), rev: body.rev });
  await seen(env, signed);
  if (result.notFound) return refuse('The mod store has no claim of this item with this secret.', 404);
  if (result.stale !== undefined) return refuse('This map\'s claim changed since this computer last saw it.', 409, { rev: result.stale });
  return new Response(null, { status: 204 });
}

/* ---------------- what players asked for ---------------- */

/* POST /mods/unit/<hash>/asked {"path"}: a path a player's game asked the unit for that it lacks.
 * Anonymous; counts as a claim call. */
async function postAsked(req, env, hash) {
  if (!(await admit(req, env, [['mod_claim', 1]], false))) { await discard(req); return rateLimited(); }
  const body = await readRequestJson(req);
  if (authorPathFault(body.path)) return refuse('The report names no file of a mod.', 400);
  return answer(await checker(env, 'unit:' + hash, 'asked', hash, body.path));
}

/* POST /mods/asked {"claims": [{ref, secret}]}, signed: what players asked of the units those claims
 * name, for their publisher. */
async function postAskedList(req, env, path) {
  if (!(await admit(req, env, [['mod_get', 1]], true))) { await discard(req); return rateLimited(); }
  const { body, refusal } = await signedJson(req, path);
  if (refusal) return refusal;
  if (!Array.isArray(body.claims) || !body.claims.every(c => plainObject(c) && validRef(c.ref) && typeof c.secret === 'string' && HEX64.test(c.secret))) {
    return refuse('The request does not list its claims by item and secret.', 400);
  }
  const claims = [];
  for (const c of body.claims) claims.push({ ref: c.ref, secretHash: await sha256Hex(c.secret) });
  return reply(await registry(env, 'listAsked', claims));
}

/* ---------------- the maintainer ---------------- */

async function maintainerDenied(req, env) {
  const expected = env.MODS_ADMIN_TOKEN === undefined ? '' : String(env.MODS_ADMIN_TOKEN).trim();   // a secret piped in keeps its newline
  if (!expected) return refuse(NOT_FOUND, 404);
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !(await sameToken(given, expected))) return refuse('This request needs the maintainer token.', 403);
  return null;
}

async function sameToken(given, expected) {
  const [a, b] = await Promise.all([sha256Hex(new TextEncoder().encode(given)), sha256Hex(new TextEncoder().encode(expected))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* POST /mods/admin/reset: deletes every object in the MODS bucket, aborts every upload in parts and
 * empties the index. */
async function adminReset(req, env) {
  await discard(req);
  await abortUploads(env, Infinity, true);
  let objects = 0;
  let cursor;
  do {
    const page = await env.MODS.list({ limit: 1000, cursor });
    const keys = page.objects.map(object => object.key);
    if (keys.length) await env.MODS.delete(keys);
    objects += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const index = await registry(env, 'reset');
  console.log('mods reset: deleted ' + objects + ' objects');
  return reply({ deleted: { objects }, index });
}

async function adminStats(req, env) {
  await discard(req);
  return reply(await registry(env, 'stats'));
}

/* POST /mods/admin/purge: runs the daily cron's purge now (purgeMods, with its own bounds; the body
 * is ignored) and answers what it deleted, the deletion delay this deployment uses and what the
 * store holds afterwards. */
async function adminPurge(req, env) {
  await discard(req);
  const { delayMs, ...deleted } = await purgeMods(env);
  return reply({ deleted, delayMs, stats: await registry(env, 'stats') });
}

/* POST /mods/admin/block {"unit", "reason"}: moderation removes a unit (5.19). */
async function adminBlock(req, env) {
  const body = await readRequestJson(req);
  if (typeof body.unit !== 'string' || !HEX64.test(body.unit)) return refuse('The request names no unit.', 400);
  const result = await registry(env, 'block', body.unit, typeof body.reason === 'string' ? body.reason.slice(0, 500) : '');
  await deleteQueued(env, result.objects);
  return reply({ unit: body.unit, removed: result.removed });
}

async function adminUnblock(req, env) {
  const body = await readRequestJson(req);
  if (typeof body.unit !== 'string' || !HEX64.test(body.unit)) return refuse('The request names no unit.', 400);
  return reply(await registry(env, 'unblock', body.unit));
}

/* POST /mods/admin/release-ref {"ref"}: the claims of one published item, at its publisher's request (D42). */
async function adminReleaseRef(req, env) {
  const body = await readRequestJson(req);
  if (!validRef(body.ref)) return refuse('The request names no published item.', 400);
  return reply(await registry(env, 'releaseRef', body.ref));
}

/* POST /mods/admin/forget-key {"key"}: the key's record and its name binding go (4.4). */
async function adminForgetKey(req, env) {
  const body = await readRequestJson(req);
  if (typeof body.key !== 'string' || !claimedKey({ key: body.key })) return refuse('The request names no publishing key.', 400);
  return reply(await registry(env, 'forgetKey', body.key));
}

/* ---------------- routing ---------------- */

function notAllowed(req, allow) {
  return discard(req).then(() => refuse('This address of the mod store does not take that request.', 405, {}, { Allow: allow }));
}

/* Handles every path under /mods; no session, no Turnstile. Every answer that is not a success
 * carries one plain sentence in "error". */
export async function handleMods(req, env, path) {
  return withMinimum(await routeModsSafely(req, env, path), env);
}

async function routeModsSafely(req, env, path) {
  try { return await routeMods(req, env, path); }
  catch (error) {
    if (error instanceof RequestError) {
      return refuse(error.message, error.status, {}, error.status === 503 ? { 'Retry-After': String(error.retryAfter || RETRY_SOON) } : undefined);
    }
    console.log('mods: unexpected failure:', String(error && error.message).slice(0, 200));
    return refuse(UNAVAILABLE, 503, {}, { 'Retry-After': String(retryAfterFor(error)) });
  }
}

/* SPEC 5.22, D41: with MODS_MINIMUM_VERSION set (dot-separated numbers, a deploy setting), every answer names the
 * oldest product version the store serves, and a product below it tells its player once per start to update. */
export const MINIMUM_HEADER = 'X-Snapmap-Plus-Minimum';
function withMinimum(response, env) {
  const minimum = String(env.MODS_MINIMUM_VERSION || '').trim();
  if (!/^\d+(\.\d+){0,3}$/.test(minimum)) return response;
  try { response.headers.set(MINIMUM_HEADER, minimum); return response; }
  catch {
    const copy = new Response(response.body, response);
    copy.headers.set(MINIMUM_HEADER, minimum);
    return copy;
  }
}

/* The routes of the stores this one replaced (SPEC 10.2): 410 with the sentence of 5.22. */
function retired(req, path) {
  if (/^\/mods\/(build|bundle|author)(\/|$)/.test(path) || ['/mods/claim', '/mods/release', '/mods/missing'].includes(path)) return true;
  return req.method === 'PUT' && /^\/mods\/blob\/[^/]+$/.test(path);
}

async function routeMods(req, env, path) {
  if (!env.MODS || !env.MOD_REGISTRY || !env.WRITE_QUOTAS) { await discard(req); return refuse(UNAVAILABLE, 503); }
  if (retired(req, path)) { await discard(req); return refuse(RETIRED, 410); }
  const unit = path.match(/^\/mods\/unit\/([0-9a-fA-F]{64})(?:\/(archive|begin|complete|asked))?$/);
  if (unit) {
    const [, raw, kind] = unit;
    if (raw !== raw.toLowerCase()) { await discard(req); return refuse('A unit hash must be written in lowercase hex.', 400); }
    if (!kind) return req.method === 'GET' || req.method === 'HEAD' ? getUnit(req, env, raw) : notAllowed(req, 'GET, HEAD');
    if (kind === 'archive') {
      if (req.method === 'GET' || req.method === 'HEAD') return getUnitArchive(req, env, raw);
      return req.method === 'PUT' ? putUnitArchive(req, env, raw, path) : notAllowed(req, 'GET, HEAD, PUT');
    }
    if (req.method !== 'POST') return notAllowed(req, 'POST');
    if (kind === 'begin') return postBegin(req, env, raw, path);
    if (kind === 'complete') return postComplete(req, env, raw, path);
    return postAsked(req, env, raw);
  }
  const blob = path.match(/^\/mods\/blob\/([0-9a-fA-F]{64})(?:\/(parts|complete)(?:\/(\d{1,9}))?)?$/);
  if (blob) {
    const [, raw, kind, part] = blob;
    if (raw !== raw.toLowerCase()) { await discard(req); return refuse('A file hash must be written in lowercase hex.', 400); }
    if (!kind) return req.method === 'GET' || req.method === 'HEAD' ? getBlob(req, env, raw) : notAllowed(req, 'GET, HEAD');
    if (kind === 'parts' && part === undefined) return req.method === 'POST' ? startParts(req, env, raw, path) : notAllowed(req, 'POST');
    if (kind === 'parts') return req.method === 'PUT' ? putPart(req, env, raw, Number(part)) : notAllowed(req, 'PUT');
    if (part === undefined) return req.method === 'POST' ? completeParts(req, env, raw, path) : notAllowed(req, 'POST');
  }
  const open = { '/mods/units': postUnits, '/mods/map/claim': postClaim, '/mods/map/release': postRelease, '/mods/asked': postAskedList }[path];
  if (open) return req.method === 'POST' ? open(req, env, path) : notAllowed(req, 'POST');
  const admin = { '/mods/admin/reset': adminReset, '/mods/admin/stats': adminStats, '/mods/admin/purge': adminPurge, '/mods/admin/block': adminBlock,
    '/mods/admin/unblock': adminUnblock, '/mods/admin/release-ref': adminReleaseRef, '/mods/admin/forget-key': adminForgetKey }[path];
  if (admin) {
    if (req.method !== 'POST') return notAllowed(req, 'POST');
    const denied = await maintainerDenied(req, env);
    if (denied) { await discard(req); return denied; }
    return admin(req, env);
  }
  await discard(req);
  return refuse(NOT_FOUND, 404);
}

/* ---------------- scheduled purge ---------------- */

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

/* Deletes the units past their deletion delay (D40), abandoned uploads in parts, what the delete
 * queue still holds and objects no row names. Bounded per run; the next run continues. The daily
 * cron runs it, and so does POST /mods/admin/purge. Returns what it deleted: units, blobs and packs
 * (rows), dead (delete-queue entries whose objects were deleted), uploads (abandoned uploads in
 * parts), queued (of `dead`, the entries an earlier request left), orphans (objects no row named)
 * and delayMs (the deletion delay the registry applied). */
export async function purgeMods(env, { batch = PURGE_BATCH, rounds = PURGE_ROUNDS, sweepPages = SWEEP_PAGES, now = Date.now() } = {}) {
  let units = 0, blobs = 0, packs = 0, dead = 0, delayMs = null;
  for (let i = 0; i < rounds; i++) {
    const doomed = await registry(env, 'purgeUnits', batch);
    delayMs = doomed.delayMs ?? delayMs;
    dead += await deleteQueued(env, doomed.objects);
    units += doomed.units;
    blobs += doomed.blobs || 0;
    packs += doomed.packs || 0;
    if (doomed.units < batch) break;
  }
  const uploads = await abortUploads(env, rounds);
  let queued = 0;
  for (let i = 0; i < rounds; i++) {
    const waiting = await registry(env, 'deadObjects', 1000);
    if (!waiting.length) break;
    queued += await deleteQueued(env, waiting);
  }
  dead += queued;
  const orphans = await sweepOrphans(env, sweepPages, now);
  console.log('mods purge: deleted ' + units + ' units, ' + blobs + ' blobs, ' + packs + ' packs, ' + uploads + ' abandoned uploads, ' +
    dead + ' queued objects and ' + orphans + ' objects no row names');
  return { units, blobs, packs, dead, uploads, queued, orphans, delayMs };
}

/* Deletes objects in the bucket that no row names and that are older than a day: what a request that
 * failed between writing an object and recording it left behind, and the objects of the stores this
 * one replaced. The listing continues from where the last run stopped, `pages` pages a run. */
async function sweepOrphans(env, pages, now) {
  let cursor = (await registry(env, 'meta', 'sweep_cursor')) || undefined;
  let deleted = 0;
  for (let i = 0; i < pages; i++) {
    const page = await env.MODS.list({ limit: 1000, cursor });
    const old = page.objects.filter(o => !o.uploaded || now - new Date(o.uploaded).getTime() > ORPHAN_AGE_MS).map(o => o.key);
    const unnamed = old.length ? await registry(env, 'unnamedObjects', old) : [];
    if (unnamed.length) { await deleteObjects(env, unnamed); deleted += unnamed.length; }
    cursor = page.truncated ? page.cursor : undefined;
    if (!cursor) break;
  }
  await registry(env, 'meta', 'sweep_cursor', cursor || '');
  return deleted;
}

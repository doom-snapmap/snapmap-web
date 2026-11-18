/* Distribution routes of the mod store (the design the owner set on 2026-11-17): authors and
 * their signing keys, and mods' listings. A published map claims the units it places by hash
 * through the claim routes of mods_store.js (one claim per map, naming units) and keeps them until
 * its own author republishes; any publisher may upload a unit the store lacks, which the store
 * checks file by file (a unit is stored, packed and served like a build; /mods/unit/<hash> is the
 * same as /mods/build/<hash>). A listing is what installing a mod gives: its current version
 * only, its units by placed object, published by the mod's author. It claims its units as a map
 * does; a unit no map and no listing claims is deleted.
 *
 * An author is the SnapMap author ID with an Ed25519 key the product creates. The first request
 * that binds an ID binds its key (a wiped store, or a new author); another key for a bound ID
 * needs a signature by the bound key. Keys govern listings only: every listing change is signed
 * by its author's key, the request body exactly as sent signed in X-Mod-Signature (base64url),
 * with the author, the mod and the time (milliseconds) inside the body; a publish names the
 * version it makes, one after the current one, so a replayed request changes nothing.
 *
 * These are the store's first shapes of the design; the specification across the product and
 * the store may move fields, and every refusal stays one sentence. */
import { RequestError, readJsonObject } from './request_body.js';

const AUTHOR_RE = /^[A-Za-z0-9._:-]{1,128}$/;      // a SnapMap author ID as the product writes it
const MOD_RE = /^[a-z][a-z0-9]{7}$/;               // a mod's permanent ID (the product's salt)
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const SKEW_MS = 15 * 60 * 1000;                     // a signed request is good for this long either way
const JSON_MAX = 16 * 1024 * 1024;

const UNAVAILABLE = 'The mod store is unavailable right now; try again later.';

function reply(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...extra } });
}

function refuse(error, status, extra) {
  return reply({ error, ...extra }, status);
}

function b64url(text) {
  if (typeof text !== 'string' || !B64URL.test(text)) return null;
  const s = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  try {
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch { return null; }
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}


/* Whether `signature` (base64url) is `key`'s (base64url, 32 bytes raw) Ed25519 signature of `bytes`. */
export async function signedBy(key, signature, bytes) {
  const raw = b64url(key), sig = b64url(signature);
  if (!raw || raw.byteLength !== 32 || !sig || sig.byteLength !== 64) return false;
  try {
    const pub = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, bytes);
  } catch { return false; }
}

async function registry(env, method, ...args) {
  try {
    const stub = env.MOD_REGISTRY.get(env.MOD_REGISTRY.idFromName('registry'));
    return await stub[method](...args);
  } catch {
    throw new RequestError(UNAVAILABLE, 503);
  }
}

/* The body as bytes and as a JSON object. */
async function readSigned(req) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > JSON_MAX) throw new RequestError('The request body is larger than one request may be.', 413);
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('The request body is not a JSON object.', 400);
  return { bytes, body };
}

/* A request of `author` about `mod`, signed by the author's bound key and fresh. Returns null when
 * it is, else a refusal. */
async function authorSigned(req, env, bytes, body, mod) {
  if (typeof body.author !== 'string' || !AUTHOR_RE.test(body.author)) return refuse('The request names no author.', 400);
  if (body.mod !== mod) return refuse('The request is signed for another mod.', 400);
  if (!Number.isSafeInteger(body.time) || Math.abs(Date.now() - body.time) > SKEW_MS) {
    return refuse('The request is too old or its clock is wrong; check the computer\'s date and time and try again.', 400);
  }
  const row = await registry(env, 'author', body.author);
  if (!row) return refuse('This author has no key in the mod store; publishing binds one.', 403);
  if (!(await signedBy(row.key, req.headers.get('X-Mod-Signature') || '', bytes))) {
    return refuse('The request is not signed with this author\'s key.', 403);
  }
  return null;
}

/* Per-author limits per UTC hour, in the same quota objects as the per-address ones: publishes,
 * and bytes of units new to the store (soft: a publish is admitted while the hour is below it). */
async function admitAuthor(env, author, bytes) {
  try {
    const stub = env.WRITE_QUOTAS.get(env.WRITE_QUOTAS.idFromName('mods-author:' + await sha256Hex(author)));
    const entries = [['mod_publish', 1]];
    if (bytes > 0) entries.push(['mod_author_bytes', bytes]);
    const result = await stub.consumeMods(entries);
    return result.allowed;
  } catch {
    throw new RequestError(UNAVAILABLE, 503);
  }
}

/* POST /mods/author/<id>/key {"author","key","time"}: binds the key to the author ID. Signed by
 * that key (X-Mod-Signature); to replace a key already bound, also by the bound one
 * (X-Mod-Previous-Signature). 201 bound, 200 the same key, 409 another key holds the ID. */
async function postKey(req, env, id) {
  const { bytes, body } = await readSigned(req);
  if (body.author !== id || !AUTHOR_RE.test(id)) return refuse('The request is for another author.', 400);
  const raw = b64url(body.key);
  if (!raw || raw.byteLength !== 32) return refuse('The key is not an Ed25519 public key in base64url.', 400);
  if (!Number.isSafeInteger(body.time) || Math.abs(Date.now() - body.time) > SKEW_MS) {
    return refuse('The request is too old or its clock is wrong; check the computer\'s date and time and try again.', 400);
  }
  if (!(await signedBy(body.key, req.headers.get('X-Mod-Signature') || '', bytes))) return refuse('The request is not signed with the key it binds.', 403);
  const bound = await registry(env, 'author', id);
  const previous = req.headers.get('X-Mod-Previous-Signature');
  const rotate = !!(bound && bound.key !== body.key && previous && await signedBy(bound.key, previous, bytes));
  const result = await registry(env, 'bindAuthor', id, body.key, rotate);
  if (result.conflict) {
    return refuse('This author ID is bound to another key; sign with that key, or restore it from its backup.', 409);
  }
  return reply({ author: id, bound: result.bound }, result.bound === 'same' ? 200 : 201);
}

async function getAuthor(env, id) {
  const row = AUTHOR_RE.test(id) ? await registry(env, 'author', id) : null;
  if (!row) return refuse('The mod store has no key for this author.', 404);
  return reply({ author: row.id, key: row.key, bound: row.bound });
}

/* GET /mods/mod/<id>: the mod's listing, what installing it gives: its current version's units by
 * placed object. */
async function getListing(env, id) {
  const mod = await registry(env, 'listing', id);
  if (!mod) return refuse('The mod store has no mod with this ID.', 404);
  if (mod.removed === 1) return refuse('This mod was removed from the mod store.', 410, { mod: id });
  if (mod.removed === 2) return refuse('This mod was withdrawn by its author.', 410, { mod: id });
  return reply(mod, 200, { 'Cache-Control': 'no-store' });
}

/* POST /mods/mod/<id>/publish {"author","mod","seq","name","time","objects":{object: unit},"check"?}:
 * the listing's new current version, signed. Every unit must be stored (uploaded by the unit
 * routes). With "check" nothing changes and the answer gives the size and the bytes new to the
 * store, for the product to show before the publish. Published maps never change with it. */
async function postPublish(req, env, id) {
  if (!MOD_RE.test(id)) return refuse('The mod ID is not a mod ID.', 400);
  const { bytes, body } = await readSigned(req);
  const bad = await authorSigned(req, env, bytes, body, id);
  if (bad) return bad;
  if (typeof body.name !== 'string' || !body.name.trim() || /[\u0000-\u001f]/.test(body.name)) return refuse('The mod has no name.', 400);
  const objects = body.objects;
  if (!objects || typeof objects !== 'object' || Array.isArray(objects) || !Object.keys(objects).length ||
      !Object.entries(objects).every(([o, u]) => o && !/[\u0000-\u001f\u007f]/.test(o) && typeof u === 'string' && HEX64.test(u))) {
    return refuse('The listing names its placed objects\' units by something other than their hashes.', 400);
  }
  if (!Number.isSafeInteger(body.seq) || body.seq < 1) return refuse('The listing has no version number.', 400);
  const request = { mod: id, author: body.author, name: body.name.trim(), seq: body.seq, objects, check: true };
  const preview = await registry(env, 'publishListing', request);
  const refusal = publishRefusal(preview);
  if (refusal) return refusal;
  if (body.check) return reply(preview);
  if (!(await admitAuthor(env, body.author, preview.newBytes))) {
    return refuse('This author has published a great deal this hour; the store takes the rest next hour.', 429);
  }
  const done = await registry(env, 'publishListing', { ...request, check: false });
  const late = publishRefusal(done);
  if (late) return late;
  return { done, response: reply({ seq: done.seq, size: done.size, newBytes: done.newBytes }, done.created ? 201 : 200) };
}

function publishRefusal(r) {
  if (r.forbidden) return refuse('This mod belongs to another author.', 403);
  if (r.removed) return refuse('This mod was removed from the mod store.', 410);
  if (r.stale !== undefined) return refuse('The mod store holds version ' + r.stale + ' of this mod; publish the one after it.', 409, { seq: r.stale });
  if (r.missing) return refuse('The mod store does not hold every unit this listing names; upload them first.', 409, { missing: r.missing });
  return null;
}

/* POST /mods/mod/<id>/delete {"author","mod","time"}: withdraws the listing (installing the mod is
 * no longer offered); published maps keep every unit they claim. Signed. */
async function postDelete(req, env, id) {
  const { bytes, body } = await readSigned(req);
  const bad = await authorSigned(req, env, bytes, body, id);
  if (bad) return bad;
  const r = await registry(env, 'deleteListing', id, body.author, false);
  if (r.notFound) return refuse('The mod store has no mod with this ID.', 404);
  if (r.forbidden) return refuse('This mod belongs to another author.', 403);
  return { done: r, response: reply({ mod: id, deleted: true }) };
}

/* The distribution routes under /mods, or null when the path is not one of them. `maintainer`
 * checks the maintainer token; `deleteQueued` deletes what the registry queued. */
export async function routeDist(req, env, path, { maintainer, deleteQueued }) {
  const notHere = () => refuse('This address of the mod store does not take that request.', 405);
  let m = path.match(/^\/mods\/author\/([^/]+)(\/key)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2]) return req.method === 'POST' ? postKey(req, env, id) : notHere();
    return req.method === 'GET' ? getAuthor(env, id) : notHere();
  }
  m = path.match(/^\/mods\/mod\/([^/]+)(?:\/(publish|delete))?$/);
  if (m) {
    const [, id, action] = m;
    if (!action) return req.method === 'GET' ? getListing(env, id) : notHere();
    if (req.method !== 'POST') return notHere();
    const out = await (action === 'publish' ? postPublish : postDelete)(req, env, id);
    if (out instanceof Response) return out;
    await deleteQueued(env, out.done.discard);
    return out.response;
  }
  if (path === '/mods/admin/remove-mod' && req.method === 'POST') {
    const denied = await maintainer(req);
    if (denied) return denied;
    const body = await readJsonObject(req, 65536);
    const r = await registry(env, 'deleteListing', String(body.mod || ''), '', true);
    if (r.notFound) return refuse('The mod store has no mod with this ID.', 404);
    await deleteQueued(env, r.discard);
    return reply({ mod: body.mod, removed: true });
  }
  return null;
}

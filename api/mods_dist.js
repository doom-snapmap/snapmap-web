/* Authors and their signing keys (the distribution design the owner set on 2026-11-17). The mod
 * store is internal to map publishing: content arrives when a map is published, as the units it
 * places (content-addressed closures of placed objects, stored, checked, packed and served by the
 * build routes of mods_store.js; /mods/unit/<hash> is /mods/build/<hash>), and leaves when no
 * published map claims it. Any publisher may upload a unit the store lacks; the check proves its
 * files. A published map's claim is signed by the map's author.
 *
 * An author is the SnapMap author ID with an Ed25519 key the product creates. The first request
 * that binds an ID binds its key (a wiped store, or a new author); another key for a bound ID needs
 * a signature by the bound key. A signed request carries the body exactly as sent, signed, in
 * X-Mod-Signature (base64url), with "author" and "time" (milliseconds) inside the body.
 *
 * Mod listings (installing a mod from the store) are a later feature; the index keeps room for
 * them (build.vrefs) and nothing here serves them. These are the store's first shapes of the
 * design; the specification across the product and the store may move fields, and every refusal
 * stays one sentence. */

import { RequestError } from './request_body.js';

export const AUTHOR_RE = /^[A-Za-z0-9._:-]{1,128}$/;      // a SnapMap author ID as the product writes it
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
export async function readSigned(req) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > JSON_MAX) throw new RequestError('The request body is larger than one request may be.', 413);
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('The request body is not a JSON object.', 400);
  return { bytes, body };
}

const STALE = 'The request is too old or its clock is wrong; check the computer\'s date and time and try again.';

/* A request of body.author, signed by the author's bound key and fresh: null when it is, else a
 * refusal. */
export async function authorSigned(req, env, bytes, body) {
  if (typeof body.author !== 'string' || !AUTHOR_RE.test(body.author)) return refuse('The request names no author.', 400);
  if (!Number.isSafeInteger(body.time) || Math.abs(Date.now() - body.time) > SKEW_MS) return refuse(STALE, 400);
  const row = await registry(env, 'author', body.author);
  if (!row) return refuse('This author has no key in the mod store; the product binds one when it publishes.', 403);
  if (!(await signedBy(row.key, req.headers.get('X-Mod-Signature') || '', bytes))) {
    return refuse('The request is not signed with this author\'s key.', 403);
  }
  return null;
}

/* POST /mods/author/<id>/key {"author","key","time"}: binds the key to the author ID. Signed by
 * that key (X-Mod-Signature); to replace a key already bound, also by the bound one
 * (X-Mod-Previous-Signature). 201 bound, 200 the same key, 409 another key holds the ID. */
async function postKey(req, env, id) {
  const { bytes, body } = await readSigned(req);
  if (body.author !== id || !AUTHOR_RE.test(id)) return refuse('The request is for another author.', 400);
  const raw = b64url(body.key);
  if (!raw || raw.byteLength !== 32) return refuse('The key is not an Ed25519 public key in base64url.', 400);
  if (!Number.isSafeInteger(body.time) || Math.abs(Date.now() - body.time) > SKEW_MS) return refuse(STALE, 400);
  if (!(await signedBy(body.key, req.headers.get('X-Mod-Signature') || '', bytes))) return refuse('The request is not signed with the key it binds.', 403);
  const bound = await registry(env, 'author', id);
  const previous = req.headers.get('X-Mod-Previous-Signature');
  const rotate = !!(bound && bound.key !== body.key && previous && await signedBy(bound.key, previous, bytes));
  const result = await registry(env, 'bindAuthor', id, body.key, rotate);
  if (result.conflict) return refuse('This author ID is bound to another key; sign with that key, or restore it from its backup.', 409);
  return reply({ author: id, bound: result.bound }, result.bound === 'same' ? 200 : 201);
}

async function getAuthor(env, id) {
  const row = AUTHOR_RE.test(id) ? await registry(env, 'author', id) : null;
  if (!row) return refuse('The mod store has no key for this author.', 404);
  return reply({ author: row.id, key: row.key, bound: row.bound });
}

/* The author routes under /mods, or null when the path is not one of them. */
export async function routeDist(req, env, path) {
  const m = path.match(/^\/mods\/author\/([^/]+)(\/key)?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const notHere = () => refuse('This address of the mod store does not take that request.', 405);
  if (m[2]) return req.method === 'POST' ? postKey(req, env, id) : notHere();
  return req.method === 'GET' ? getAuthor(env, id) : notHere();
}

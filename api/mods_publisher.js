/* Publishing keys (SPEC-distribution 4). The product makes an ECDSA P-256 key at a player's first map
 * publish; its public half (the raw uncompressed point, 65 bytes, base64url without padding) is the
 * publisher's identity at the store. Every write the product sends carries
 *   X-Publisher-Key: <base64url public point>
 *   X-Publisher-Name: <the SnapMap account name read from the signed-in game, or empty>
 *   X-Publisher-Signature: <base64url IEEE P1363 r||s, 64 bytes>
 * signed over the UTF-8 bytes of
 *   "snapmap-plus/request/1\n" + method + "\n" + path + "\n" + name + "\n" + lowercase hex SHA-256 of the body.
 * No clock takes part (I12): a claim change is ordered by its rev (D33), and an upload is idempotent.
 * The key names the publisher for limits (D45) and binds the account name first come, first served
 * (D31). It authorises nothing about content: units are named by hash, and claims by their secrets.
 * The name is header text: UTF-8 percent-encoded by the product (encodeURIComponent's form) so any
 * account name survives HTTP. */

const B64URL = /^[A-Za-z0-9_-]*$/;
const NAME_MAX = 128;

export function b64url(text) {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length % 4 === 1) return null;
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch { return null; }
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* The message a request's signature covers. */
export function signedMessage(method, path, name, bodyHash) {
  return new TextEncoder().encode('snapmap-plus/request/1\n' + method + '\n' + path + '\n' + name + '\n' + bodyHash);
}

/* The account name as compared (D31): NFC, then case-folded (toLowerCase; the product never types it,
 * so the simple fold is the one both sides apply). '' for none. */
export function foldedName(name) {
  return name ? name.normalize('NFC').toLowerCase() : '';
}

/* The name a request presents, decoded, or null when the header is malformed. */
export function presentedName(header) {
  if (header === null || header === undefined || header === '') return '';
  let name;
  try { name = decodeURIComponent(header); } catch { return null; }
  if (!name.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/.test(name) || [...name].length > NAME_MAX) return null;
  return name.normalize('NFC');
}

/* What a signature check needs from a request, as plain data (a checker Durable Object verifies an
 * upload once it has hashed the bytes): { method, path, key, nameHeader, signature }. */
export function authOf(req, path) {
  return { method: req.method, path, key: req.headers.get('X-Publisher-Key') || '',
    nameHeader: req.headers.get('X-Publisher-Name') || '', signature: req.headers.get('X-Publisher-Signature') || '' };
}

/* The key a request names, if it is well formed, else null (for counting limits before the body
 * is read; the signature is checked afterwards). */
export function claimedKey(auth) {
  const raw = b64url(auth.key);
  return raw && raw.byteLength === 65 && raw[0] === 4 ? auth.key : null;
}

/* Whether `auth` signs a body whose SHA-256 is `bodyHash` (lowercase hex) (4.3): { key, name } when it
 * does, else { refusal: sentence }. */
export async function verifySigned(auth, bodyHash) {
  if (!auth || !auth.key || !auth.signature) return { refusal: 'This request must be signed with a publishing key.' };
  const raw = b64url(auth.key), sig = b64url(auth.signature);
  if (!raw || raw.byteLength !== 65 || raw[0] !== 4) return { refusal: 'The publishing key is not a P-256 public key.' };
  if (!sig || sig.byteLength !== 64) return { refusal: 'The request\'s signature is not a P-256 signature.' };
  const name = presentedName(auth.nameHeader);
  if (name === null) return { refusal: 'The account name sent with this request is not readable text.' };
  let ok = false;
  try {
    const pub = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig,
      signedMessage(auth.method, auth.path, auth.nameHeader || '', bodyHash));
  } catch { ok = false; }
  if (!ok) return { refusal: 'The request is not signed by the publishing key it names.' };
  return { key: auth.key, name };
}

/* The same for a body in hand (claims, releases: small JSON). */
export async function verifyBody(auth, body) {
  return verifySigned(auth, hex(await crypto.subtle.digest('SHA-256', body)));
}

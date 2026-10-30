/* Index of the mod store: which blobs and bundles exist, which blobs each bundle names,
 * and the anonymous claims that keep bundles served. One object holds every row so claim
 * counts, references and purges are decided in single transactions. The clock comes
 * from the Durable Object, never from an HTTP client. */

export const CLAIM_WINDOW_MS = 3600000;   // upload-before-claim window (one hour)

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS mod_blob (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS mod_bundle (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS mod_bundle_blob (bundle TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (bundle, blob))',
  'CREATE INDEX IF NOT EXISTS mod_bundle_blob_by_blob ON mod_bundle_blob (blob)',
  'CREATE TABLE IF NOT EXISTS mod_claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS mod_claim_by_secret ON mod_claim (ref, secret)',
  'CREATE TABLE IF NOT EXISTS mod_claim_bundle (claim TEXT NOT NULL, bundle TEXT NOT NULL, PRIMARY KEY (claim, bundle))',
];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function rows(storage, query, ...bindings) {
  return storage.sql.exec(query, ...bindings).toArray();
}

function hashList(value, max) {
  if (!Array.isArray(value) || value.length > max || !value.every(hash => typeof hash === 'string' && HEX64.test(hash))) {
    throw new Error('bad hash list');
  }
  return [...new Set(value)];
}

export function initializeRegistry(storage) {
  for (const statement of SCHEMA) storage.sql.exec(statement);
}

// Absent and mid-purge blobs are both reported missing so a client uploads them again.
export function missingBlobs(storage, hashes) {
  return hashList(hashes, 4096).filter(hash => {
    const found = rows(storage, 'SELECT deleting FROM mod_blob WHERE hash = ?', hash);
    return !found.length || found[0].deleting !== 0;
  });
}

export function noteBlob(storage, hash, size, now) {
  if (!HEX64.test(hash) || !Number.isSafeInteger(size) || size < 0) throw new Error('bad blob');
  return storage.transactionSync(() => {
    const found = rows(storage, 'SELECT deleting FROM mod_blob WHERE hash = ?', hash);
    if (found.length) return found[0].deleting ? { deleting: true } : { ok: true };
    storage.sql.exec('INSERT INTO mod_blob (hash, size, created) VALUES (?, ?, ?)', hash, size, now);
    return { ok: true };
  });
}

/* Registers a validated bundle only when every blob it names is present, not being purged
 * and of the declared size. Registering an existing bundle refreshes its claim window. */
export function registerBundle(storage, hash, files, now) {
  if (!HEX64.test(hash) || !Array.isArray(files) || files.length > 4096) throw new Error('bad bundle');
  const sizes = new Map();
  for (const file of files) {
    if (!file || !HEX64.test(file.blob) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('bad bundle');
    if (sizes.has(file.blob) && sizes.get(file.blob) !== file.size) return { missing: [], mismatched: [file.blob] };
    sizes.set(file.blob, file.size);
  }
  return storage.transactionSync(() => {
    const missing = [], mismatched = [];
    for (const [blob, size] of sizes) {
      const found = rows(storage, 'SELECT size, deleting FROM mod_blob WHERE hash = ?', blob);
      if (!found.length || found[0].deleting) missing.push(blob);
      else if (found[0].size !== size) mismatched.push(blob);
    }
    if (missing.length || mismatched.length) return { missing, mismatched };
    storage.sql.exec('INSERT INTO mod_bundle (hash, created) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET created = max(created, excluded.created)', hash, now);
    for (const blob of sizes.keys()) storage.sql.exec('INSERT OR IGNORE INTO mod_bundle_blob (bundle, blob) VALUES (?, ?)', hash, blob);
    return { ok: true };
  });
}

export function bundleServed(storage, hash, now) {
  const found = rows(storage, 'SELECT created, claims FROM mod_bundle WHERE hash = ?', hash);
  return found.length > 0 && (found[0].claims > 0 || now - found[0].created < CLAIM_WINDOW_MS);
}

// A blob past its own window is served while any claimed bundle names it.
export function blobClaimed(storage, hash) {
  return rows(storage, 'SELECT 1 AS hit FROM mod_bundle_blob AS bb JOIN mod_bundle AS b ON b.hash = bb.bundle ' +
    'JOIN mod_blob AS o ON o.hash = bb.blob WHERE bb.blob = ? AND b.claims > 0 AND o.deleting = 0 LIMIT 1', hash).length > 0;
}

function claimedBundles(storage, id) {
  return rows(storage, 'SELECT bundle FROM mod_claim_bundle WHERE claim = ?', id).map(row => row.bundle);
}

/* Drops every listed bundle whose claim count has reached zero, so a bundle disappears the
 * moment its last claim is released instead of waiting for the purge. Returns the hashes
 * dropped; the caller deletes their objects. Blobs are left to the purge, whose window
 * protects an upload still in flight. */
function dropUnclaimed(storage, hashes) {
  const dropped = [];
  for (const hash of new Set(hashes)) {
    const found = rows(storage, 'SELECT claims FROM mod_bundle WHERE hash = ?', hash);
    if (!found.length || found[0].claims > 0) continue;
    storage.sql.exec('DELETE FROM mod_bundle_blob WHERE bundle = ?', hash);
    storage.sql.exec('DELETE FROM mod_bundle WHERE hash = ?', hash);
    dropped.push(hash);
  }
  return dropped;
}

/* Creates a claim, or replaces the bundle set of the claim matching ref and the presented
 * secret. Secrets are stored and compared only as SHA-256 digests. */
export function claimBundles(storage, { ref, bundles, id, secretHash, presentedHash }, now) {
  const list = hashList(bundles, 256);
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 64) throw new Error('bad ref');
  if (!HEX32.test(id) || !HEX64.test(secretHash) || (presentedHash !== null && !HEX64.test(presentedHash))) throw new Error('bad claim');
  return storage.transactionSync(() => {
    let existing = null;
    if (presentedHash !== null) {
      const found = rows(storage, 'SELECT id FROM mod_claim WHERE ref = ? AND secret = ?', ref, presentedHash);
      if (!found.length) return { forbidden: true };
      existing = found[0].id;
    }
    const missing = list.filter(hash => !rows(storage, 'SELECT 1 AS hit FROM mod_bundle WHERE hash = ?', hash).length);
    if (missing.length) return { missing };
    const claim = existing || id;
    const before = new Set(existing ? claimedBundles(storage, existing) : []);
    const after = new Set(list);
    if (existing) storage.sql.exec('UPDATE mod_claim SET updated = ? WHERE id = ?', now, claim);
    else storage.sql.exec('INSERT INTO mod_claim (id, ref, secret, created, updated) VALUES (?, ?, ?, ?, ?)', claim, ref, secretHash, now, now);
    const released = [];
    for (const bundle of before) {
      if (after.has(bundle)) continue;
      storage.sql.exec('DELETE FROM mod_claim_bundle WHERE claim = ? AND bundle = ?', claim, bundle);
      storage.sql.exec('UPDATE mod_bundle SET claims = claims - 1 WHERE hash = ?', bundle);
      released.push(bundle);
    }
    for (const bundle of after) {
      if (before.has(bundle)) continue;
      storage.sql.exec('INSERT INTO mod_claim_bundle (claim, bundle) VALUES (?, ?)', claim, bundle);
      storage.sql.exec('UPDATE mod_bundle SET claims = claims + 1 WHERE hash = ?', bundle);
    }
    return { claim, created: !existing, deleted: dropUnclaimed(storage, released) };
  });
}

export function releaseClaim(storage, id, presentedHash) {
  if (!HEX32.test(id) || !HEX64.test(presentedHash)) throw new Error('bad claim');
  return storage.transactionSync(() => {
    const found = rows(storage, 'SELECT secret FROM mod_claim WHERE id = ?', id);
    if (!found.length) return { notFound: true };
    if (found[0].secret !== presentedHash) return { forbidden: true };
    const held = claimedBundles(storage, id);
    for (const bundle of held) storage.sql.exec('UPDATE mod_bundle SET claims = claims - 1 WHERE hash = ?', bundle);
    storage.sql.exec('DELETE FROM mod_claim_bundle WHERE claim = ?', id);
    storage.sql.exec('DELETE FROM mod_claim WHERE id = ?', id);
    return { ok: true, deleted: dropUnclaimed(storage, held) };
  });
}

/* Purge step 1: drop unclaimed bundles past the window. Their rows go first, so they stop
 * being served and cannot be claimed before their objects are deleted. */
export function purgeBundles(storage, now, limit) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT hash FROM mod_bundle WHERE claims <= 0 AND created < ? ORDER BY created LIMIT ?',
      now - CLAIM_WINDOW_MS, limit).map(row => row.hash);
    for (const hash of doomed) {
      storage.sql.exec('DELETE FROM mod_bundle_blob WHERE bundle = ?', hash);
      storage.sql.exec('DELETE FROM mod_bundle WHERE hash = ?', hash);
    }
    return doomed;
  });
}

/* Purge step 2: mark blobs past the window that no remaining bundle names. Marked blobs
 * read as missing and refuse new bundle registrations until finishBlobs clears them, so a
 * new bundle can never come to depend on a blob that is about to disappear. Rows left
 * marked by an interrupted run are returned again first. */
export function purgeBlobs(storage, now, limit) {
  return storage.transactionSync(() => {
    const retry = rows(storage, 'SELECT hash FROM mod_blob WHERE deleting = 1 LIMIT ?', limit).map(row => row.hash);
    const fresh = rows(storage, 'SELECT hash FROM mod_blob AS o WHERE o.deleting = 0 AND o.created < ? AND NOT EXISTS ' +
      '(SELECT 1 FROM mod_bundle_blob AS bb WHERE bb.blob = o.hash) ORDER BY o.created LIMIT ?',
      now - CLAIM_WINDOW_MS, limit - retry.length).map(row => row.hash);
    for (const hash of fresh) storage.sql.exec('UPDATE mod_blob SET deleting = 1 WHERE hash = ?', hash);
    return [...retry, ...fresh];
  });
}

export function finishBlobs(storage, hashes) {
  const list = hashList(hashes, 1000);
  return storage.transactionSync(() => {
    for (const hash of list) storage.sql.exec('DELETE FROM mod_blob WHERE hash = ? AND deleting = 1', hash);
    return list.length;
  });
}

/* Empties the whole index. Only the maintainer's reset route calls it, after deleting
 * every stored object. */
export function resetRegistry(storage) {
  return storage.transactionSync(() => {
    const counts = {};
    for (const table of ['mod_claim_bundle', 'mod_claim', 'mod_bundle_blob', 'mod_bundle', 'mod_blob']) {
      counts[table] = rows(storage, 'SELECT count(*) AS n FROM ' + table)[0].n;
      storage.sql.exec('DELETE FROM ' + table);
    }
    return counts;
  });
}

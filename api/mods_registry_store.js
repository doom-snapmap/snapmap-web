/* Index of the mod store: which build archives exist and the anonymous claims that keep
 * them served, plus the uploads in parts still in progress. One object holds every row so
 * claim counts, releases and purges are decided in single transactions. The clock comes
 * from the Durable Object, never from an HTTP client.
 *
 * Every stored archive has its own R2 object, named build/<hash>/<random> when it is
 * written, and a build's row names the object that serves it. Deleting an archive deletes
 * that one object, so a release or purge racing an upload of the same build can never
 * delete the upload's object: the upload wrote a different one. Tables grow; nothing here
 * caps how many builds, claims or builds per claim there are. */

export const CLAIM_WINDOW_MS = 3600000;      // upload-before-claim window (one hour)
export const UPLOAD_IDLE_MS = 86400000;      // an upload in parts untouched this long is abandoned

/* Tables of the blob and bundle store this index replaced. The mod store is wiped before
 * the one-archive-per-build store goes live, so their rows are dropped, not migrated. */
const RETIRED_TABLES = ['mod_claim_bundle', 'mod_bundle_blob', 'mod_bundle', 'mod_blob'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS mod_build (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS mod_build_unclaimed ON mod_build (claims, created)',
  'CREATE TABLE IF NOT EXISTS mod_claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS mod_claim_by_secret ON mod_claim (ref, secret)',
  'CREATE TABLE IF NOT EXISTS mod_claim_build (claim TEXT NOT NULL, build TEXT NOT NULL, PRIMARY KEY (claim, build))',
  'CREATE TABLE IF NOT EXISTS mod_upload (hash TEXT NOT NULL, size INTEGER NOT NULL, object TEXT NOT NULL, upload TEXT NOT NULL, part_size INTEGER NOT NULL, parts INTEGER NOT NULL, etags TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (hash, size))',
  'CREATE INDEX IF NOT EXISTS mod_upload_idle ON mod_upload (updated)',
];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SALT = /^[a-z][a-z0-9]{7}$/;
const OBJECT = /^build\/[0-9a-f]{64}(\/[0-9a-f]{32})?$/;

function rows(storage, query, ...bindings) {
  return storage.sql.exec(query, ...bindings).toArray();
}

function hashList(value) {
  if (!Array.isArray(value) || !value.every(hash => typeof hash === 'string' && HEX64.test(hash))) throw new Error('bad hash list');
  return [...new Set(value)];
}

function checkObject(object) {
  if (typeof object !== 'string' || !OBJECT.test(object)) throw new Error('bad object');
}

export function initializeRegistry(storage) {
  const tables = new Set(rows(storage, "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
  /* Claims of the retired store name bundles; they go with it. */
  if (tables.has('mod_claim_bundle')) storage.sql.exec('DROP TABLE IF EXISTS mod_claim');
  for (const table of RETIRED_TABLES) if (tables.has(table)) storage.sql.exec('DROP TABLE IF EXISTS ' + table);
  for (const statement of SCHEMA) storage.sql.exec(statement);
  /* Rows from before per-upload objects name the archive at build/<hash>. */
  const columns = new Set(rows(storage, 'PRAGMA table_info(mod_build)').map(row => row.name));
  if (!columns.has('object')) {
    storage.sql.exec('ALTER TABLE mod_build ADD COLUMN object TEXT');
    storage.sql.exec("UPDATE mod_build SET object = 'build/' || hash WHERE object IS NULL");
  }
  if (!columns.has('scripts')) storage.sql.exec('ALTER TABLE mod_build ADD COLUMN scripts INTEGER NOT NULL DEFAULT 0');
}

/* The row of one build, or null: { size, salt, created, claims, object, scripts }. */
export function buildRow(storage, hash) {
  if (!HEX64.test(hash)) throw new Error('bad build');
  const found = rows(storage, 'SELECT size, salt, created, claims, object, scripts FROM mod_build WHERE hash = ?', hash);
  return found.length ? found[0] : null;
}

/* Records a validated archive stored as `object`. A new build takes it; an unclaimed build
 * of another size is replaced by it (a forged archive cannot hold a hash against the real
 * one); otherwise the build keeps the object it has. Any registration restarts the upload
 * window of a build nothing claims. Returns { created, discard }: created when the build
 * now has the new archive (new or replaced); discard is the object no
 * row names any more (the replaced one, or the new one when the build kept its own), which
 * the caller deletes. */
export function registerBuild(storage, hash, size, salt, object, scripts, now) {
  if (!HEX64.test(hash) || !Number.isSafeInteger(size) || size < 1 || typeof salt !== 'string' || !SALT.test(salt) ||
      !Number.isSafeInteger(scripts) || scripts < 0) {
    throw new Error('bad build');
  }
  checkObject(object);
  return storage.transactionSync(() => {
    const found = rows(storage, 'SELECT size, claims, object FROM mod_build WHERE hash = ?', hash);
    if (!found.length) {
      storage.sql.exec('INSERT INTO mod_build (hash, size, salt, created, object, scripts) VALUES (?, ?, ?, ?, ?, ?)',
        hash, size, salt, now, object, scripts);
      return { created: true, discard: null };
    }
    const kept = found[0];
    if (kept.claims <= 0 && kept.size !== size) {
      storage.sql.exec('UPDATE mod_build SET size = ?, salt = ?, object = ?, scripts = ?, created = max(created, ?) WHERE hash = ?',
        size, salt, object, scripts, now, hash);
      return { created: true, discard: kept.object === object ? null : kept.object };
    }
    if (kept.claims <= 0) storage.sql.exec('UPDATE mod_build SET created = max(created, ?) WHERE hash = ?', now, hash);
    return { created: false, discard: kept.object === object ? null : object };
  });
}

/* An idempotent re-upload of a stored build: restarts its upload window. */
export function touchBuild(storage, hash, now) {
  if (!HEX64.test(hash)) throw new Error('bad build');
  storage.sql.exec('UPDATE mod_build SET created = max(created, ?) WHERE hash = ?', now, hash);
  return true;
}

/* The served build's object, size and script count, or null when it is not served. */
export function buildServed(storage, hash, now) {
  const found = rows(storage, 'SELECT size, created, claims, object, scripts FROM mod_build WHERE hash = ?', hash);
  if (!found.length || !(found[0].claims > 0 || now - found[0].created < CLAIM_WINDOW_MS)) return null;
  return { object: found[0].object, size: found[0].size, scripts: found[0].scripts };
}

function claimedBuilds(storage, id) {
  return rows(storage, 'SELECT build FROM mod_claim_build WHERE claim = ?', id).map(row => row.build);
}

/* Drops every listed build whose claim count has reached zero, so an archive disappears the
 * moment its last claim goes instead of waiting for the purge. Returns the objects of the
 * builds dropped; the caller deletes them. */
function dropUnclaimed(storage, hashes) {
  const dropped = [];
  for (const hash of new Set(hashes)) {
    const found = rows(storage, 'SELECT claims, object FROM mod_build WHERE hash = ?', hash);
    if (!found.length || found[0].claims > 0) continue;
    storage.sql.exec('DELETE FROM mod_build WHERE hash = ?', hash);
    dropped.push(found[0].object);
  }
  return dropped;
}

/* Creates a claim, or replaces the build set of the claim matching ref and the presented
 * secret (one claim per published item). Secrets are stored and compared only as SHA-256
 * digests. */
export function claimBuilds(storage, { ref, builds, id, secretHash, presentedHash }, now) {
  const list = hashList(builds);
  if (typeof ref !== 'string' || ref.length < 1) throw new Error('bad ref');
  if (!HEX32.test(id) || !HEX64.test(secretHash) || (presentedHash !== null && !HEX64.test(presentedHash))) throw new Error('bad claim');
  return storage.transactionSync(() => {
    let existing = null;
    if (presentedHash !== null) {
      const found = rows(storage, 'SELECT id FROM mod_claim WHERE ref = ? AND secret = ?', ref, presentedHash);
      if (!found.length) return { forbidden: true };
      existing = found[0].id;
    }
    const missing = list.filter(hash => !rows(storage, 'SELECT 1 AS hit FROM mod_build WHERE hash = ?', hash).length);
    if (missing.length) return { missing };
    const claim = existing || id;
    const before = new Set(existing ? claimedBuilds(storage, existing) : []);
    const after = new Set(list);
    if (existing) storage.sql.exec('UPDATE mod_claim SET updated = ? WHERE id = ?', now, claim);
    else storage.sql.exec('INSERT INTO mod_claim (id, ref, secret, created, updated) VALUES (?, ?, ?, ?, ?)', claim, ref, secretHash, now, now);
    const released = [];
    for (const build of before) {
      if (after.has(build)) continue;
      storage.sql.exec('DELETE FROM mod_claim_build WHERE claim = ? AND build = ?', claim, build);
      storage.sql.exec('UPDATE mod_build SET claims = claims - 1 WHERE hash = ?', build);
      released.push(build);
    }
    for (const build of after) {
      if (before.has(build)) continue;
      storage.sql.exec('INSERT INTO mod_claim_build (claim, build) VALUES (?, ?)', claim, build);
      storage.sql.exec('UPDATE mod_build SET claims = claims + 1 WHERE hash = ?', build);
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
    const held = claimedBuilds(storage, id);
    for (const build of held) storage.sql.exec('UPDATE mod_build SET claims = claims - 1 WHERE hash = ?', build);
    storage.sql.exec('DELETE FROM mod_claim_build WHERE claim = ?', id);
    storage.sql.exec('DELETE FROM mod_claim WHERE id = ?', id);
    return { ok: true, deleted: dropUnclaimed(storage, held) };
  });
}

/* Drops unclaimed builds past the upload window. Their rows go first, so they stop being
 * served and cannot be claimed before their objects are deleted. Returns the objects. */
export function purgeBuilds(storage, now, limit) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT hash, object FROM mod_build WHERE claims <= 0 AND created < ? ORDER BY created LIMIT ?',
      now - CLAIM_WINDOW_MS, limit);
    for (const { hash } of doomed) storage.sql.exec('DELETE FROM mod_build WHERE hash = ?', hash);
    return doomed.map(row => row.object);
  });
}

/* ---------------- uploads in parts ---------------- */

function uploadRow(row) {
  return row ? { object: row.object, upload: row.upload, partSize: row.part_size, parts: row.parts, etags: JSON.parse(row.etags) } : null;
}

/* The upload in parts of this build at this size, or null. */
export function uploadSession(storage, hash, size) {
  if (!HEX64.test(hash) || !Number.isSafeInteger(size)) throw new Error('bad upload');
  return uploadRow(rows(storage, 'SELECT * FROM mod_upload WHERE hash = ? AND size = ?', hash, size)[0]);
}

/* Records a new upload in parts. When another start of the same build and size won the
 * race, its session is returned with { existing: true } and the caller aborts its own. */
export function openUpload(storage, { hash, size, object, upload, partSize, parts }, now) {
  checkObject(object);
  if (!HEX64.test(hash) || !Number.isSafeInteger(size) || size < 1 || typeof upload !== 'string' || !upload ||
      !Number.isSafeInteger(partSize) || partSize < 1 || !Number.isSafeInteger(parts) || parts < 1) {
    throw new Error('bad upload');
  }
  return storage.transactionSync(() => {
    const found = rows(storage, 'SELECT * FROM mod_upload WHERE hash = ? AND size = ?', hash, size)[0];
    if (found) return { ...uploadRow(found), existing: true };
    storage.sql.exec('INSERT INTO mod_upload (hash, size, object, upload, part_size, parts, etags, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      hash, size, object, upload, partSize, parts, JSON.stringify(Array(parts).fill(null)), now, now);
    return { object, upload, partSize, parts, etags: Array(parts).fill(null), existing: false };
  });
}

/* Records a stored part's etag. Returns the session, or null when it is gone (completed,
 * abandoned or replaced meanwhile). */
export function recordPart(storage, hash, size, upload, part, etag, now) {
  if (typeof etag !== 'string' || !etag) throw new Error('bad etag');
  return storage.transactionSync(() => {
    const found = rows(storage, 'SELECT * FROM mod_upload WHERE hash = ? AND size = ? AND upload = ?', hash, size, upload)[0];
    if (!found || !Number.isSafeInteger(part) || part < 1 || part > found.parts) return null;
    const etags = JSON.parse(found.etags);
    etags[part - 1] = etag;
    storage.sql.exec('UPDATE mod_upload SET etags = ?, updated = ? WHERE hash = ? AND size = ?', JSON.stringify(etags), now, hash, size);
    return uploadRow({ ...found, etags: JSON.stringify(etags) });
  });
}

/* Forgets an upload in parts (completed, refused or replaced). Returns 1 when it was there. */
export function closeUpload(storage, hash, size, upload) {
  const found = rows(storage, 'SELECT 1 AS hit FROM mod_upload WHERE hash = ? AND size = ? AND upload = ?', hash, size, upload).length;
  storage.sql.exec('DELETE FROM mod_upload WHERE hash = ? AND size = ? AND upload = ?', hash, size, upload);
  return found;
}

/* Drops uploads in parts nobody touched for UPLOAD_IDLE_MS (every one when `all`, for the
 * reset). Returns [{ object, upload }]; the caller aborts each multipart upload and deletes
 * its object (an upload completed but never registered left one). */
export function abandonUploads(storage, now, limit, all = false) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT hash, size, object, upload FROM mod_upload WHERE updated <= ? ORDER BY updated LIMIT ?',
      all ? Number.MAX_SAFE_INTEGER : now - UPLOAD_IDLE_MS - 1, limit);
    for (const { hash, size } of doomed) storage.sql.exec('DELETE FROM mod_upload WHERE hash = ? AND size = ?', hash, size);
    return doomed.map(({ object, upload }) => ({ object, upload }));
  });
}

/* Empties the whole index. Only the maintainer's reset route calls it, after deleting
 * every stored object. */
export function resetRegistry(storage) {
  return storage.transactionSync(() => {
    const counts = {};
    for (const table of ['mod_claim_build', 'mod_claim', 'mod_build', 'mod_upload']) {
      counts[table] = rows(storage, 'SELECT count(*) AS n FROM ' + table)[0].n;
      storage.sql.exec('DELETE FROM ' + table);
    }
    return counts;
  });
}

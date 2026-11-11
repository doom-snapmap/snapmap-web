/* Index of the mod store: which build archives exist and the anonymous claims that keep
 * them served. One object holds every row so claim counts, releases and purges are
 * decided in single transactions. The clock comes from the Durable Object, never from an
 * HTTP client. */

export const CLAIM_WINDOW_MS = 3600000;   // upload-before-claim window (one hour)

/* Tables of the blob and bundle store this index replaced. The mod store is wiped before
 * the one-archive-per-build store goes live, so their rows are dropped, not migrated. */
const RETIRED_TABLES = ['mod_claim_bundle', 'mod_bundle_blob', 'mod_bundle', 'mod_blob'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS mod_build (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS mod_build_unclaimed ON mod_build (claims, created)',
  'CREATE TABLE IF NOT EXISTS mod_claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS mod_claim_by_secret ON mod_claim (ref, secret)',
  'CREATE TABLE IF NOT EXISTS mod_claim_build (claim TEXT NOT NULL, build TEXT NOT NULL, PRIMARY KEY (claim, build))',
];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SALT = /^[a-z][a-z0-9]{7}$/;

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
  const tables = new Set(rows(storage, "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
  /* Claims of the retired store name bundles; they go with it. */
  if (tables.has('mod_claim_bundle')) storage.sql.exec('DROP TABLE IF EXISTS mod_claim');
  for (const table of RETIRED_TABLES) if (tables.has(table)) storage.sql.exec('DROP TABLE IF EXISTS ' + table);
  for (const statement of SCHEMA) storage.sql.exec(statement);
}

/* The row of one build, or null: { size, salt, created, claims }. */
export function buildRow(storage, hash) {
  if (!HEX64.test(hash)) throw new Error('bad build');
  const found = rows(storage, 'SELECT size, salt, created, claims FROM mod_build WHERE hash = ?', hash);
  return found.length ? found[0] : null;
}

/* Records a validated archive, after its object is stored. A replaced unclaimed archive
 * takes the new size and salt; any registration restarts the upload window of a build
 * nothing claims, so a re-upload is served for another hour. */
export function registerBuild(storage, hash, size, salt, now) {
  if (!HEX64.test(hash) || !Number.isSafeInteger(size) || size < 1 || typeof salt !== 'string' || !SALT.test(salt)) {
    throw new Error('bad build');
  }
  return storage.transactionSync(() => {
    const found = rows(storage, 'SELECT claims FROM mod_build WHERE hash = ?', hash);
    if (!found.length) {
      storage.sql.exec('INSERT INTO mod_build (hash, size, salt, created) VALUES (?, ?, ?, ?)', hash, size, salt, now);
      return { created: true };
    }
    storage.sql.exec('UPDATE mod_build SET size = ?, salt = ?, created = max(created, ?) WHERE hash = ?', size, salt, now, hash);
    return { created: false };
  });
}

/* An idempotent re-upload of a stored build: restarts its upload window. */
export function touchBuild(storage, hash, now) {
  if (!HEX64.test(hash)) throw new Error('bad build');
  storage.sql.exec('UPDATE mod_build SET created = max(created, ?) WHERE hash = ?', now, hash);
  return true;
}

export function buildServed(storage, hash, now) {
  const found = rows(storage, 'SELECT created, claims FROM mod_build WHERE hash = ?', hash);
  return found.length > 0 && (found[0].claims > 0 || now - found[0].created < CLAIM_WINDOW_MS);
}

function claimedBuilds(storage, id) {
  return rows(storage, 'SELECT build FROM mod_claim_build WHERE claim = ?', id).map(row => row.build);
}

/* Drops every listed build whose claim count has reached zero, so an archive disappears the
 * moment its last claim goes instead of waiting for the purge. Returns the hashes dropped;
 * the caller deletes their objects. */
function dropUnclaimed(storage, hashes) {
  const dropped = [];
  for (const hash of new Set(hashes)) {
    const found = rows(storage, 'SELECT claims FROM mod_build WHERE hash = ?', hash);
    if (!found.length || found[0].claims > 0) continue;
    storage.sql.exec('DELETE FROM mod_build WHERE hash = ?', hash);
    dropped.push(hash);
  }
  return dropped;
}

/* Creates a claim, or replaces the build set of the claim matching ref and the presented
 * secret (one claim per published item). Secrets are stored and compared only as SHA-256
 * digests. */
export function claimBuilds(storage, { ref, builds, id, secretHash, presentedHash }, now) {
  const list = hashList(builds, 256);
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 64) throw new Error('bad ref');
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
 * served and cannot be claimed before their objects are deleted. */
export function purgeBuilds(storage, now, limit) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT hash FROM mod_build WHERE claims <= 0 AND created < ? ORDER BY created LIMIT ?',
      now - CLAIM_WINDOW_MS, limit).map(row => row.hash);
    for (const hash of doomed) storage.sql.exec('DELETE FROM mod_build WHERE hash = ?', hash);
    return doomed;
  });
}

/* Empties the whole index. Only the maintainer's reset route calls it, after deleting
 * every stored object. */
export function resetRegistry(storage) {
  return storage.transactionSync(() => {
    const counts = {};
    for (const table of ['mod_claim_build', 'mod_claim', 'mod_build']) {
      counts[table] = rows(storage, 'SELECT count(*) AS n FROM ' + table)[0].n;
      storage.sql.exec('DELETE FROM ' + table);
    }
    return counts;
  });
}

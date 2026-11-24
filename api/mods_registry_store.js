/* Index of the mod store (SPEC-distribution section 10). One Durable Object holds every row, so
 * claim counts, deletion delays, purges and repairs are decided in single transactions. The clock
 * comes from the Durable Object, never from an HTTP client.
 *
 * The store is internal to map publishing: it holds the units published maps claim, and nothing
 * else. A unit is the closure of one placed object, named by the SHA-256 of its canonical manifest
 * (the product's modunit.c); it never changes. Its files are blobs, named by their SHA-256 and
 * stored once however many units carry them. A blob lives in a pack: an R2 object holding one or
 * more blobs, each after the ZIP local header it arrived with (hlen bytes, hdr in hex), or alone
 * with no header (an upload in parts). An uploaded unit archive (stored entries, the product's
 * modzip form) is checked and then kept as it is as a pack. A blob that arrives twice (two
 * publishers racing) is slack in the later pack, as are the bytes of a blob deleted from a pack that
 * other blobs keep: pack_slack counts them, and the purge compacts such a pack (a copy of its live
 * blobs, each with its header and in its order, under a new key; the old object is deleted a delay
 * later, in dead_later, so a download that read the old location still finds it).
 *
 * A unit is "pending" from its begin (its manifest is known, some blobs are not held yet) and
 * "held" once every blob it names is. A unit no map claim names records unclaimed_at (the store's
 * clock) and is served and kept for DELETE_DELAY_MS (deleteDelayMs), then deleted at the first purge; a claim
 * within the delay clears it (D40). A blob no unit names is deleted with it, and a pack no blob
 * row points into goes to the delete queue.
 *
 * Every R2 object a row names has its own random key, written once. A row that stops naming an
 * object puts the key on the delete queue (dead) in the same transaction, so an object is never
 * deleted while a row names it and never left behind when the deleting request fails. Tables
 * grow; nothing here caps units, blobs, claims or units per claim. */

export const DELETE_DELAY_MS = 86400000;     // D40: an unclaimed unit is kept and served this long
/* The deletion delay a deployment uses: MODS_DELETE_DELAY_MS when it is a positive whole number of
 * milliseconds (a staging copy sets it short so a purge can be shown at once), else D40's 24 hours.
 * Production never sets it. */
export function deleteDelayMs(env) {
  const raw = env ? env.MODS_DELETE_DELAY_MS : undefined;
  const value = typeof raw === 'string' && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DELETE_DELAY_MS;
}
export const UPLOAD_IDLE_MS = 86400000;      // an upload in parts untouched this long is abandoned
export const ASKED_MAX = 256;                // D44: asked paths kept per unit
export const SCHEMA_VERSION = 5;

/* Tables of the stores this index replaced (the blob and bundle store, one archive per build, and
 * ST1's builds and listings). The store is emptied before it goes live, so their rows are dropped,
 * not migrated; the daily sweep deletes their R2 objects, which no row names. */
const RETIRED_TABLES = ['mod_claim_bundle', 'mod_bundle_blob', 'mod_bundle', 'mod_blob', 'mod_claim_build', 'mod_claim',
  'mod_build', 'mod_upload', 'mod_asked', 'build', 'build_blob', 'claim', 'claim_build', 'author', 'dist_mod',
  'dist_version', 'dist_unit', 'map_claim_row'];
/* Tables whose shape changed with schema 4 or 5 (blob keyed by its SHA-256 alone): dropped when an older schema is
 * found. */
const RESHAPED_TABLES = ['blob', 'pack', 'upload', 'asked', 'dead', 'pack_slack', 'dead_later'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  /* A blob: one file's bytes, once. pack and at say where its header starts in the pack; the bytes
   * follow the hlen header bytes. crc is the CRC-32 the check computed (the archive route's). broken:
   * its pack is missing from R2; a later upload of the blob repairs it. One B-tree keyed by the
   * SHA-256 (no row id, no second index): a blob row is one row written, not three (R-DS6; the
   * account's rows written are billed). Finding a pack's blobs (a missing pack) scans, which is rare. */
  'CREATE TABLE IF NOT EXISTS blob (sha TEXT PRIMARY KEY, size INTEGER NOT NULL, ' +
    'crc INTEGER NOT NULL, pack INTEGER NOT NULL, at INTEGER NOT NULL, hlen INTEGER NOT NULL, hdr TEXT NOT NULL, ' +
    'broken INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID',
  /* A pack: an R2 object of blobs. live counts the blob rows pointing into it. */
  'CREATE TABLE IF NOT EXISTS pack (id INTEGER PRIMARY KEY, object TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, ' +
    'live INTEGER NOT NULL, live_bytes INTEGER NOT NULL, created INTEGER NOT NULL)',
  /* A unit: its manifest (the canonical bytes, inline, or an R2 object when over MANIFEST_INLINE),
   * what it carries, its claim count and the store-clock time it lost its last claim. */
  'CREATE TABLE IF NOT EXISTS unit (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, manifest TEXT, manifest_object TEXT, ' +
    'mlen INTEGER NOT NULL, size INTEGER NOT NULL, files INTEGER NOT NULL, spelled TEXT, root_kind TEXT NOT NULL, ' +
    'root_name TEXT NOT NULL, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0, unclaimed_at INTEGER, ' +
    'state TEXT NOT NULL, uploaded_by TEXT)',
  'CREATE INDEX IF NOT EXISTS unit_unclaimed ON unit (claims, unclaimed_at)',
  /* The blobs a unit names, by SHA-256 (a blob row exists once its bytes are held). A blob's
   * references are counted from here. */
  'CREATE TABLE IF NOT EXISTS unit_blob (unit INTEGER NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (unit, sha)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS unit_blob_by_sha ON unit_blob (sha)',
  /* An upload in parts of one large blob. */
  'CREATE TABLE IF NOT EXISTS upload (sha TEXT NOT NULL, size INTEGER NOT NULL, object TEXT NOT NULL, upload TEXT NOT NULL, ' +
    'part_size INTEGER NOT NULL, parts INTEGER NOT NULL, etags TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, ' +
    'PRIMARY KEY (sha, size))',
  'CREATE INDEX IF NOT EXISTS upload_idle ON upload (updated)',
  /* A published map's claim (one per item and secret): the SHA-256 of its secret, the publishing
   * key that last changed it, and its rev (D33). */
  'CREATE TABLE IF NOT EXISTS map_claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, key TEXT, ' +
    'rev INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS map_claim_by_secret ON map_claim (ref, secret)',
  'CREATE TABLE IF NOT EXISTS map_claim_unit (claim TEXT NOT NULL, unit TEXT NOT NULL, PRIMARY KEY (claim, unit)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS map_claim_unit_by_unit ON map_claim_unit (unit)',
  /* Publishing keys (base64url public halves) and the account names bound to them (D31). */
  'CREATE TABLE IF NOT EXISTS publisher (key TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS publisher_name (name TEXT PRIMARY KEY, display TEXT NOT NULL, key TEXT NOT NULL UNIQUE, bound INTEGER NOT NULL)',
  /* A path a player's game asked a unit for that the unit lacks (3.8). */
  'CREATE TABLE IF NOT EXISTS asked (unit TEXT NOT NULL, path TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (unit, path))',
  /* Units moderation removed: never served or uploaded again (5.19). */
  'CREATE TABLE IF NOT EXISTS blocked (hash TEXT PRIMARY KEY, reason TEXT NOT NULL, created INTEGER NOT NULL)',
  /* R2 objects no row names any more, to delete. */
  'CREATE TABLE IF NOT EXISTS dead (object TEXT PRIMARY KEY, queued INTEGER NOT NULL)',
  /* Packs holding bytes no blob row uses any more (bytes: headers and data of the blobs that left or
   * arrived twice): the purge compacts them. Added with no schema bump: an existing store keeps its rows. */
  'CREATE TABLE IF NOT EXISTS pack_slack (pack INTEGER PRIMARY KEY, bytes INTEGER NOT NULL)',
  /* The objects of compacted packs, kept until `after` (the deletion delay) so a download that read the
   * old location finds it, then moved to the delete queue. */
  'CREATE TABLE IF NOT EXISTS dead_later (object TEXT PRIMARY KEY, after INTEGER NOT NULL)',
];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
/* Every object this store writes: an uploaded unit archive (a pack), a blob uploaded in parts (a
 * pack of one), a large manifest. A compacted pack keeps its old key and adds .<32 hex>, so it sorts
 * where the old one did (a unit's archive orders its files by pack key). */
const OBJECT = /^((pack|blob)\/[0-9a-f]{64}\/[0-9a-f]{32}(\.[0-9a-f]{32})?|manifest\/[0-9a-f]{64}\/[0-9a-f]{32})$/;
const KEY_RE = /^[A-Za-z0-9_-]{87}$/;        // base64url of a 65-byte P-256 public point, unpadded

function rows(storage, query, ...bindings) {
  return storage.sql.exec(query, ...bindings).toArray();
}

function one(storage, query, ...bindings) {
  return rows(storage, query, ...bindings)[0] || null;
}

function hashList(value) {
  if (!Array.isArray(value) || !value.every(hash => typeof hash === 'string' && HEX64.test(hash))) throw new Error('bad hash list');
  return [...new Set(value)];
}

export function checkObject(object) {
  if (typeof object !== 'string' || !OBJECT.test(object)) throw new Error('bad object');
}

export function initializeRegistry(storage) {
  const tables = new Set(rows(storage, "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
  for (const table of RETIRED_TABLES) if (tables.has(table)) storage.sql.exec('DROP TABLE IF EXISTS ' + table);
  const meta = tables.has('store_meta') ? one(storage, "SELECT value FROM store_meta WHERE key = 'schema'") : null;
  if (!meta || Number(meta.value) < SCHEMA_VERSION) {
    for (const table of RESHAPED_TABLES) if (tables.has(table)) storage.sql.exec('DROP TABLE IF EXISTS ' + table);
  }
  for (const statement of SCHEMA) storage.sql.exec(statement);
  /* Written only when it changes: the object starts often, and a write each time is a row written each time. */
  if (!meta || Number(meta.value) !== SCHEMA_VERSION) {
    storage.sql.exec("INSERT INTO store_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(SCHEMA_VERSION));
  }
}

/* ---------------- the delete queue ---------------- */

function bury(storage, objects, now) {
  const queued = [];
  for (const object of objects) {
    if (!object) continue;
    storage.sql.exec('INSERT INTO dead (object, queued) VALUES (?, ?) ON CONFLICT(object) DO NOTHING', object, now);
    queued.push(object);
  }
  return queued;
}

export function deadObjects(storage, limit) {
  return rows(storage, 'SELECT object FROM dead ORDER BY queued LIMIT ?', limit).map(row => row.object);
}

export function forgetDead(storage, objects) {
  for (const object of objects) storage.sql.exec('DELETE FROM dead WHERE object = ?', object);
  return true;
}

/* Which of these keys (an R2 listing's page) no row names: the sweep deletes them. */
export function unnamedObjects(storage, keys) {
  return keys.filter(key => !(
    one(storage, 'SELECT 1 AS hit FROM pack WHERE object = ?', key) ||
    one(storage, 'SELECT 1 AS hit FROM upload WHERE object = ?', key) ||
    one(storage, 'SELECT 1 AS hit FROM unit WHERE manifest_object = ?', key) ||
    one(storage, 'SELECT 1 AS hit FROM dead WHERE object = ?', key) ||
    one(storage, 'SELECT 1 AS hit FROM dead_later WHERE object = ?', key)));
}

/* The compacted packs' old objects whose delay has passed go to the delete queue. Returns how many. */
export function dueDead(storage, now, limit) {
  return storage.transactionSync(() => {
    const due = rows(storage, 'SELECT object FROM dead_later WHERE after <= ? ORDER BY after LIMIT ?', now, limit).map(r => r.object);
    for (const object of due) storage.sql.exec('DELETE FROM dead_later WHERE object = ?', object);
    bury(storage, due, now);
    return due.length;
  });
}

/* ---------------- blobs and packs ---------------- */

/* A blob row that is held: present and not broken. */
function goodBlob(storage, sha) {
  return one(storage, 'SELECT sha, size FROM blob WHERE sha = ? AND broken = 0', sha);
}

/* Blob rows left packs ({ pack id -> [count, bytes] }): each pack's counts change once, and a pack goes when no blob
 * row points into it. Returns the objects queued; `tally.packs` (when given) counts the packs deleted. */
function unlinkFromPacks(storage, left, now, tally = null) {
  const queued = [];
  for (const [packId, [count, bytes, occupied]] of left) {
    storage.sql.exec('UPDATE pack SET live = live - ?, live_bytes = live_bytes - ? WHERE id = ?', count, bytes, packId);
    const pack = one(storage, 'SELECT object, live FROM pack WHERE id = ?', packId);
    if (pack && pack.live <= 0) {
      storage.sql.exec('DELETE FROM pack WHERE id = ?', packId);
      storage.sql.exec('DELETE FROM pack_slack WHERE pack = ?', packId);
      queued.push(...bury(storage, [pack.object], now));
      if (tally) tally.packs++;
    } else if (pack) {
      addSlack(storage, packId, occupied);
    }
  }
  return queued;
}

/* `bytes` of pack `packId` no blob row uses any more: the purge compacts it. */
function addSlack(storage, packId, bytes) {
  if (bytes > 0) {
    storage.sql.exec('INSERT INTO pack_slack (pack, bytes) VALUES (?, ?) ON CONFLICT(pack) DO UPDATE SET bytes = bytes + excluded.bytes', packId, bytes);
  }
}

/* A blob row left pack `packId`: [count, data bytes, bytes it occupied there (header and data)]. */
function leaving(left, packId, size, hlen) {
  const was = left.get(packId) || [0, 0, 0];
  left.set(packId, [was[0] + 1, was[1] + size, was[2] + hlen + size]);
}

/* Deletes the blob rows of `shas` that no unit names any more. Returns the objects queued; `tally`
 * (when given) counts the blobs and packs deleted. */
function dropUnnamedBlobs(storage, shas, now, tally = null) {
  const left = new Map();
  for (const sha of new Set(shas)) {
    if (one(storage, 'SELECT 1 AS hit FROM unit_blob WHERE sha = ? LIMIT 1', sha)) continue;
    const blob = one(storage, 'SELECT pack, size, hlen FROM blob WHERE sha = ?', sha);
    if (!blob) continue;
    storage.sql.exec('DELETE FROM blob WHERE sha = ?', sha);
    leaving(left, blob.pack, blob.size, blob.hlen);
    if (tally) tally.blobs++;
  }
  return unlinkFromPacks(storage, left, now, tally);
}

/* The SHA-256s a unit names that the store does not hold whole. */
function missingOf(storage, unitId) {
  return rows(storage, 'SELECT x.sha AS sha FROM unit_blob x LEFT JOIN blob b ON b.sha = x.sha AND b.broken = 0 ' +
    'WHERE x.unit = ? AND b.sha IS NULL ORDER BY x.sha', unitId).map(r => r.sha);
}

/* Pending units naming any of `shas` that now have every blob: held. */
function promote(storage, shas, now) {
  const held = [];
  const seen = new Set();
  for (const sha of new Set(shas)) {
    for (const r of rows(storage, "SELECT u.id AS id, u.hash AS hash FROM unit_blob x JOIN unit u ON u.id = x.unit WHERE x.sha = ? AND u.state = 'pending'", sha)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (!missingOf(storage, r.id).length) {
        storage.sql.exec("UPDATE unit SET state = 'held' WHERE id = ?", r.id);
        held.push(r.hash);
      }
    }
  }
  void now;
  return held;
}

/* Records `object` (`size` bytes) as a pack holding `blobs` ([{ sha, size, crc, at, hlen, hdr }]: each
 * blob's header offset in the object). A blob the store holds whole already is dead space here; a
 * broken blob is repaired by this copy (its old pack loses it); a new blob is added. A pack that holds
 * no live blob goes to the delete queue. Inside a transaction. Returns { packId, discard, added }. */
function recordPack(storage, object, size, blobs, now) {
  storage.sql.exec('INSERT INTO pack (object, size, live, live_bytes, created) VALUES (?, ?, 0, 0, ?)', object, size, now);
  const packId = one(storage, 'SELECT id FROM pack WHERE object = ?', object).id;
  let live = 0, liveBytes = 0, slack = 0;
  const discard = [];
  const added = [];
  const left = new Map();
  for (const b of blobs) {
    if (!HEX64.test(b.sha) || !Number.isSafeInteger(b.size) || !Number.isSafeInteger(b.at) || !Number.isSafeInteger(b.hlen) ||
        !Number.isSafeInteger(b.crc) || typeof b.hdr !== 'string') throw new Error('bad blob');
    const blob = one(storage, 'SELECT broken, pack, size, hlen FROM blob WHERE sha = ?', b.sha);
    if (blob && !blob.broken) { slack += b.hlen + b.size; continue; }   // held already: its copy here is slack
    if (blob) {
      storage.sql.exec('UPDATE blob SET size = ?, crc = ?, pack = ?, at = ?, hlen = ?, hdr = ?, broken = 0 WHERE sha = ?',
        b.size, b.crc, packId, b.at, b.hlen, b.hdr, b.sha);
      leaving(left, blob.pack, blob.size, blob.hlen);
    } else {
      storage.sql.exec('INSERT INTO blob (sha, size, crc, pack, at, hlen, hdr) VALUES (?, ?, ?, ?, ?, ?, ?)',
        b.sha, b.size, b.crc, packId, b.at, b.hlen, b.hdr);
    }
    live++; liveBytes += b.size;
    added.push(b.sha);
  }
  discard.push(...unlinkFromPacks(storage, left, now));
  if (live) { storage.sql.exec('UPDATE pack SET live = ?, live_bytes = ? WHERE id = ?', live, liveBytes, packId); addSlack(storage, packId, slack); }
  else { storage.sql.exec('DELETE FROM pack WHERE id = ?', packId); discard.push(...bury(storage, [object], now)); }
  return { packId, discard, added };
}

/* A request found a pack missing from R2: its blobs are broken (not served, and missing to every
 * unit that names them) until an upload of them repairs them. */
export function markBroken(storage, object, now) {
  checkObject(object);
  return storage.transactionSync(() => {
    const pack = one(storage, 'SELECT id FROM pack WHERE object = ?', object);
    if (!pack) return { blobs: 0 };
    storage.sql.exec('UPDATE blob SET broken = 1 WHERE pack = ?', pack.id);
    const n = one(storage, 'SELECT count(*) AS n FROM blob WHERE pack = ?', pack.id).n;
    console.log('mods: ' + object + ' is missing; ' + n + ' blob(s) wait for a repair');
    void now;
    return { blobs: n };
  });
}

/* ---------------- compaction ---------------- */

/* Up to `limit` packs that hold slack, with their blobs in the order they lie: [{ pack, object, size,
 * slack, blobs: [{ sha, at, hlen, size }] }]. A pack with a broken blob (its object is missing) waits
 * for its repair. Finding a pack's blobs scans the blob table (no index by pack): once per call. */
export function compactionPlan(storage, limit) {
  const packs = rows(storage, 'SELECT s.pack AS id, s.bytes AS slack, p.object AS object, p.size AS size, p.live AS live ' +
    'FROM pack_slack s JOIN pack p ON p.id = s.pack ORDER BY s.pack LIMIT ?', limit);
  if (!packs.length) return [];
  const blobs = new Map(packs.map(p => [p.id, []]));
  const broken = new Set();
  for (const b of rows(storage, 'SELECT sha, pack, at, hlen, size, broken FROM blob WHERE pack IN (' + packs.map(() => '?').join(', ') +
    ') ORDER BY pack, at', ...packs.map(p => p.id))) {
    if (b.broken) broken.add(b.pack);
    blobs.get(b.pack).push({ sha: b.sha, at: b.at, hlen: b.hlen, size: b.size });
  }
  return packs.filter(p => !broken.has(p.id) && blobs.get(p.id).length === p.live)
    .map(p => ({ pack: p.id, object: p.object, size: p.size, slack: p.slack, blobs: blobs.get(p.id) }));
}

/* A compacted copy of pack `pack` (its object `object`) is stored as `newObject` (`newSize` bytes),
 * each of `blobs` ([{ sha, at, newAt }]) at newAt. The switch happens only if the pack still holds
 * exactly those blobs at those places; otherwise nothing changes and the copy is queued for deletion.
 * The old object is kept until `now + delay`, so a download that read its location still finds it.
 * Returns { switched, freed, discard }. */
export function switchPack(storage, { pack, object, newObject, newSize, blobs }, now, delay = DELETE_DELAY_MS) {
  checkObject(object);
  checkObject(newObject);
  if (!Number.isSafeInteger(pack) || !Number.isSafeInteger(newSize) || newSize < 0 || !Array.isArray(blobs)) throw new Error('bad switch');
  return storage.transactionSync(() => {
    const p = one(storage, 'SELECT object, size, live FROM pack WHERE id = ?', pack);
    const same = p && p.object === object && p.live === blobs.length && new Set(blobs.map(b => b.sha)).size === blobs.length &&
      blobs.every(b => {
        const row = one(storage, 'SELECT pack, at, broken FROM blob WHERE sha = ?', b.sha);
        return row && row.pack === pack && row.at === b.at && !row.broken && Number.isSafeInteger(b.newAt);
      });
    if (!same) return { switched: false, freed: 0, discard: bury(storage, [newObject], now) };
    for (const b of blobs) storage.sql.exec('UPDATE blob SET at = ? WHERE sha = ?', b.newAt, b.sha);
    storage.sql.exec('UPDATE pack SET object = ?, size = ? WHERE id = ?', newObject, newSize, pack);
    storage.sql.exec('DELETE FROM pack_slack WHERE pack = ?', pack);
    storage.sql.exec('INSERT INTO dead_later (object, after) VALUES (?, ?) ON CONFLICT(object) DO NOTHING', object, now + delay);
    return { switched: true, freed: p.size - newSize, discard: [] };
  });
}

/* Where a blob's bytes are, for GET /mods/blob/<sha>: { object, at, size, crc }, or null when it is
 * not held or no held unit names it. */
export function blobLocation(storage, sha) {
  if (!HEX64.test(sha)) return null;
  const r = one(storage, "SELECT b.size AS size, b.crc AS crc, b.at AS at, b.hlen AS hlen, p.object AS object FROM blob b JOIN pack p ON p.id = b.pack " +
    "WHERE b.sha = ? AND b.broken = 0 AND EXISTS (SELECT 1 FROM unit_blob x JOIN unit u ON u.id = x.unit WHERE x.sha = b.sha AND u.state = 'held')", sha);
  return r ? { object: r.object, at: r.at + r.hlen, size: r.size, crc: r.crc } : null;
}

/* ---------------- units ---------------- */

function isBlocked(storage, hash) {
  return !!one(storage, 'SELECT 1 AS hit FROM blocked WHERE hash = ?', hash);
}

/* The status of each unit (SPEC 10.2 POST /mods/units): held (served now: every blob held), removed
 * (moderation blocked it), else missing. */
export function unitStatus(storage, hashes) {
  const out = {};
  for (const hash of hashList(hashes)) {
    if (isBlocked(storage, hash)) { out[hash] = 'removed'; continue; }
    const u = one(storage, 'SELECT id, state FROM unit WHERE hash = ?', hash);
    out[hash] = u && u.state === 'held' && !missingOf(storage, u.id).length ? 'held' : 'missing';
  }
  return out;
}

/* One unit's row, or null. */
export function unitRow(storage, hash) {
  if (!HEX64.test(hash)) throw new Error('bad unit');
  return one(storage, 'SELECT id, hash, manifest, manifest_object, mlen, size, files, spelled, root_kind, root_name, created, claims, ' +
    'unclaimed_at, state, uploaded_by FROM unit WHERE hash = ?', hash);
}

/* What serving a unit needs, or null when it is not served (unknown, pending, a blob not held):
 * { manifest | manifestObject, mlen, blobs: { sha -> { object, at, size, crc } } (with `withBlobs`) }. */
export function unitServed(storage, hash, withBlobs = false) {
  if (!HEX64.test(hash) || isBlocked(storage, hash)) return null;
  const u = one(storage, "SELECT id, manifest, manifest_object, mlen, size FROM unit WHERE hash = ? AND state = 'held'", hash);
  if (!u || missingOf(storage, u.id).length) return null;
  const out = { manifest: u.manifest, manifestObject: u.manifest_object, mlen: u.mlen, size: u.size };
  if (withBlobs) {
    out.blobs = {};
    for (const r of rows(storage, 'SELECT b.sha AS sha, b.size AS size, b.crc AS crc, b.at AS at, b.hlen AS hlen, b.hdr AS hdr, p.object AS object ' +
      'FROM unit_blob x JOIN blob b ON b.sha = x.sha JOIN pack p ON p.id = b.pack WHERE x.unit = ?', u.id)) {
      out.blobs[r.sha] = { object: r.object, at: r.at + r.hlen, size: r.size, crc: r.crc, hlen: r.hlen, hdr: r.hdr };
    }
  }
  return out;
}

/* The begin of a unit's upload (SPEC 10.2 POST /mods/unit/<hash>/begin): the Worker checked the
 * manifest (its hash, its shape) and gives what it says: { hash, manifest (text) or manifestObject,
 * mlen, size, files: [[sha, size], ...] (one per distinct blob), spelled, rootKind, rootName, key }.
 * A blocked hash: { blocked }. A held unit: { held: true } (its deletion delay restarts while nothing
 * claims it, so a publish in progress never meets a purge), or the blobs a repair needs. A new or
 * pending unit is recorded pending, its blobs linked, and { missing } answered; { held: true } when
 * the store already holds every blob. A blob the store holds at another size than the manifest
 * gives: { conflict: sha } (the manifest is wrong: a SHA-256 names one content). Returns, too, the
 * objects the caller deletes (a manifest object of a unit that already had one). */
export function beginUnit(storage, u, now) {
  const { hash, manifest = null, manifestObject = null, mlen, size, files, spelled = null, rootKind, rootName, key = null } = u;
  if (!HEX64.test(hash) || !Number.isSafeInteger(mlen) || mlen < 1 || !Number.isSafeInteger(size) || size < 0 ||
      !Array.isArray(files) || typeof rootKind !== 'string' || typeof rootName !== 'string' ||
      (manifest === null) === (manifestObject === null)) throw new Error('bad unit');
  if (manifestObject !== null) checkObject(manifestObject);
  for (const f of files) if (!Array.isArray(f) || !HEX64.test(f[0]) || !Number.isSafeInteger(f[1]) || f[1] < 0) throw new Error('bad unit');
  return storage.transactionSync(() => {
    const discard = manifestObject ? [manifestObject] : [];
    if (isBlocked(storage, hash)) return { blocked: true, discard: bury(storage, discard, now) };
    for (const [sha, n] of files) {
      const blob = one(storage, 'SELECT size FROM blob WHERE sha = ?', sha);
      if (blob && blob.size !== n) return { conflict: sha, discard: bury(storage, discard, now) };
    }
    let row = one(storage, 'SELECT id, state, claims FROM unit WHERE hash = ?', hash);
    if (row) {
      if (row.claims <= 0) storage.sql.exec('UPDATE unit SET unclaimed_at = ? WHERE id = ?', now, row.id);
    } else {
      storage.sql.exec('INSERT INTO unit (hash, manifest, manifest_object, mlen, size, files, spelled, root_kind, root_name, created, ' +
        "claims, unclaimed_at, state, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?)",
        hash, manifest, manifestObject, mlen, size, files.length, spelled, rootKind, rootName, now, now, key);
      row = one(storage, 'SELECT id, state, claims FROM unit WHERE hash = ?', hash);
      for (const [sha, n] of files) {
        storage.sql.exec('INSERT INTO unit_blob (unit, sha, size) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', row.id, sha, n);
      }
      discard.length = 0;
    }
    const missing = missingOf(storage, row.id);
    if (!missing.length && row.state !== 'held') storage.sql.exec("UPDATE unit SET state = 'held' WHERE id = ?", row.id);
    return missing.length ? { missing, discard: bury(storage, discard, now) } : { held: true, discard: bury(storage, discard, now) };
  });
}

/* The blobs a begun unit names: { sha -> size }, or null when the store has no such unit. */
export function unitBlobs(storage, hash) {
  const u = one(storage, 'SELECT id FROM unit WHERE hash = ?', hash);
  if (!u) return null;
  return Object.fromEntries(rows(storage, 'SELECT sha, size FROM unit_blob WHERE unit = ?', u.id).map(r => [r.sha, r.size]));
}

/* A checked archive of a unit's files, stored as `object`: kept as a pack (recordPack). Every pending
 * unit that now has all its blobs is held. Returns { held, missing, discard } for `hash`, or
 * { gone } (with the object queued for deletion) when the unit was purged since its begin. */
export function commitUnitArchive(storage, hash, object, size, blobs, now) {
  checkObject(object);
  return storage.transactionSync(() => {
    const u = one(storage, 'SELECT id FROM unit WHERE hash = ?', hash);
    if (!u) return { gone: true, discard: bury(storage, [object], now) };
    const { discard, added } = recordPack(storage, object, size, blobs, now);
    promote(storage, added, now);
    const missing = missingOf(storage, u.id);
    if (!missing.length) storage.sql.exec("UPDATE unit SET state = 'held' WHERE id = ?", u.id);
    return { held: !missing.length, missing, discard };
  });
}

/* POST /mods/unit/<hash>/complete: { held: true }, { missing }, or { notFound }. */
export function completeUnit(storage, hash, now) {
  return storage.transactionSync(() => {
    const u = one(storage, 'SELECT id FROM unit WHERE hash = ?', hash);
    if (!u) return { notFound: true };
    const missing = missingOf(storage, u.id);
    if (missing.length) return { missing };
    storage.sql.exec("UPDATE unit SET state = 'held' WHERE id = ?", u.id);
    void now;
    return { held: true };
  });
}

/* 1 when an upload in parts of this blob at this size is wanted: some begun unit names it at that
 * size and the store does not hold it whole. */
export function blobWanted(storage, sha, size) {
  if (!HEX64.test(sha) || !Number.isSafeInteger(size)) return false;
  return !goodBlob(storage, sha) && !!one(storage, 'SELECT 1 AS hit FROM unit_blob WHERE sha = ? AND size = ? LIMIT 1', sha, size);
}

/* A blob uploaded in parts and checked (its SHA-256, size and CRC-32), stored as `object` with no
 * header: a pack of one. Returns { held: [units now held], discard }. */
export function commitBlob(storage, sha, size, crc, object, now) {
  checkObject(object);
  return storage.transactionSync(() => {
    if (!one(storage, 'SELECT 1 AS hit FROM unit_blob WHERE sha = ? LIMIT 1', sha)) return { held: [], discard: bury(storage, [object], now) };
    const { discard, added } = recordPack(storage, object, size, [{ sha, size, crc, at: 0, hlen: 0, hdr: '' }], now);
    return { held: promote(storage, added, now), discard };
  });
}

/* Drops one unit's row and what only it named. Inside a transaction. Returns the objects queued;
 * `tally` (when given) counts the blobs and packs deleted. */
function dropUnit(storage, u, now, tally = null) {
  const shas = rows(storage, 'SELECT sha FROM unit_blob WHERE unit = ?', u.id).map(r => r.sha);
  storage.sql.exec('DELETE FROM unit_blob WHERE unit = ?', u.id);
  storage.sql.exec('DELETE FROM unit WHERE id = ?', u.id);
  storage.sql.exec('DELETE FROM asked WHERE unit = ?', u.hash);
  return [...dropUnnamedBlobs(storage, shas, now, tally), ...bury(storage, [u.manifest_object], now)];
}

/* Deletes the units no claim has named for `delay` ms (DELETE_DELAY_MS unless the deployment sets
 * another, deleteDelayMs): held, or pending since their begin. Rows go first, so they stop being
 * served before their objects are deleted. Returns { units, blobs, packs, objects, delayMs }. */
export function purgeUnits(storage, now, limit, delay = DELETE_DELAY_MS) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT id, hash, manifest_object FROM unit WHERE claims <= 0 AND unclaimed_at IS NOT NULL AND unclaimed_at <= ? ' +
      'ORDER BY unclaimed_at LIMIT ?', now - delay, limit);
    const objects = [];
    const tally = { blobs: 0, packs: 0 };
    for (const u of doomed) objects.push(...dropUnit(storage, u, now, tally));
    return { units: doomed.length, blobs: tally.blobs, packs: tally.packs, objects, delayMs: delay };
  });
}

/* ---------------- claims ---------------- */

function claimedUnits(storage, id) {
  return rows(storage, 'SELECT unit FROM map_claim_unit WHERE claim = ?', id).map(r => r.unit);
}

function loseClaim(storage, hash, now) {
  storage.sql.exec('UPDATE unit SET claims = claims - 1 WHERE hash = ?', hash);
  storage.sql.exec('UPDATE unit SET unclaimed_at = ? WHERE hash = ? AND claims <= 0', now, hash);
}

function gainClaim(storage, hash) {
  storage.sql.exec('UPDATE unit SET claims = claims + 1, unclaimed_at = NULL WHERE hash = ?', hash);
}

/* A published map's claim (SPEC 10.2 POST /mods/map/claim): { ref, units, secretHash, rev, key, id }.
 * The claim of (ref, secret) is replaced when rev is its stored rev + 1; a new one needs rev 1
 * (D33). Every unit must be held: { missing } otherwise, and nothing changes. A removed (blocked)
 * unit is left out and named in `removed`; the claim holds the rest. A stale rev: { stale: stored
 * rev, 0 for none }. Units only the old set named lose the claim and start their deletion delay. */
export function claimUnits(storage, { ref, units, secretHash, rev, key = null, id }, now) {
  const list = hashList(units);
  if (typeof ref !== 'string' || !ref.length || !HEX64.test(secretHash) || !Number.isSafeInteger(rev) || !HEX32.test(id)) throw new Error('bad claim');
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT id, rev FROM map_claim WHERE ref = ? AND secret = ?', ref, secretHash);
    if (rev !== (found ? found.rev + 1 : 1)) return { stale: found ? found.rev : 0 };
    const removed = list.filter(hash => isBlocked(storage, hash));
    const kept = list.filter(hash => !removed.includes(hash));
    const missing = kept.filter(hash => {
      const u = one(storage, "SELECT id FROM unit WHERE hash = ? AND state = 'held'", hash);
      return !u || missingOf(storage, u.id).length > 0;
    });
    if (missing.length) return { missing };
    const claim = found ? found.id : id;
    const before = new Set(found ? claimedUnits(storage, claim) : []);
    const after = new Set(kept);
    if (found) storage.sql.exec('UPDATE map_claim SET rev = ?, key = ?, updated = ? WHERE id = ?', rev, key, now, claim);
    else storage.sql.exec('INSERT INTO map_claim (id, ref, secret, key, rev, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', claim, ref, secretHash, key, rev, now, now);
    for (const hash of before) {
      if (after.has(hash)) continue;
      storage.sql.exec('DELETE FROM map_claim_unit WHERE claim = ? AND unit = ?', claim, hash);
      loseClaim(storage, hash, now);
    }
    for (const hash of after) {
      if (before.has(hash)) continue;
      storage.sql.exec('INSERT INTO map_claim_unit (claim, unit) VALUES (?, ?)', claim, hash);
      gainClaim(storage, hash);
    }
    return { claim, rev, created: !found, removed };
  });
}

/* Removes the claim of (ref, secret) when rev is its rev + 1: { ok }, { notFound }, { stale }. Its
 * units start their deletion delay when nothing else claims them. */
export function releaseClaim(storage, { ref, secretHash, rev }, now) {
  if (typeof ref !== 'string' || !ref.length || !HEX64.test(secretHash) || !Number.isSafeInteger(rev)) throw new Error('bad claim');
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT id, rev FROM map_claim WHERE ref = ? AND secret = ?', ref, secretHash);
    if (!found) return { notFound: true };
    if (rev !== found.rev + 1) return { stale: found.rev };
    dropClaim(storage, found.id, now);
    return { ok: true };
  });
}

function dropClaim(storage, id, now) {
  for (const hash of claimedUnits(storage, id)) loseClaim(storage, hash, now);
  storage.sql.exec('DELETE FROM map_claim_unit WHERE claim = ?', id);
  storage.sql.exec('DELETE FROM map_claim WHERE id = ?', id);
}

/* The rev of the claim of (ref, secret), or null: what a client that lost count asks after a stale. */
export function claimRev(storage, ref, secretHash) {
  const found = one(storage, 'SELECT rev FROM map_claim WHERE ref = ? AND secret = ?', ref, secretHash);
  return found ? found.rev : null;
}

/* Moderation (D42): releases every claim of one published item. Returns { claims }. */
export function releaseRef(storage, ref, now) {
  return storage.transactionSync(() => {
    const ids = rows(storage, 'SELECT id FROM map_claim WHERE ref = ?', ref).map(r => r.id);
    for (const id of ids) dropClaim(storage, id, now);
    return { claims: ids.length };
  });
}

/* ---------------- what players asked for ---------------- */

/* A player's game asked unit `hash` for `path`, which it lacks (the Worker checked the path is well
 * formed and absent from the unit's manifest). Kept once, at most ASKED_MAX paths per unit:
 * { added }, { full }, { notFound }. */
export function reportAsked(storage, hash, path, now) {
  if (!HEX64.test(hash) || typeof path !== 'string' || !path) throw new Error('bad report');
  return storage.transactionSync(() => {
    if (!one(storage, 'SELECT 1 AS hit FROM unit WHERE hash = ?', hash)) return { notFound: true };
    if (one(storage, 'SELECT 1 AS hit FROM asked WHERE unit = ? AND path = ?', hash, path)) return { added: false };
    if (one(storage, 'SELECT count(*) AS n FROM asked WHERE unit = ?', hash).n >= ASKED_MAX) return { full: true };
    storage.sql.exec('INSERT INTO asked (unit, path, created) VALUES (?, ?, ?)', hash, path, now);
    return { added: true };
  });
}

/* What players asked of the units the given claims ([{ ref, secretHash }]) name, for their
 * publisher: { asked: [{ unit, root, path }] }. A claim that does not match is skipped. */
export function listAsked(storage, claims) {
  const units = new Set();
  for (const c of claims) {
    const found = one(storage, 'SELECT id FROM map_claim WHERE ref = ? AND secret = ?', c.ref, c.secretHash);
    if (found) for (const hash of claimedUnits(storage, found.id)) units.add(hash);
  }
  const asked = [];
  for (const hash of [...units].sort()) {
    const root = one(storage, 'SELECT root_name FROM unit WHERE hash = ?', hash);
    for (const r of rows(storage, 'SELECT path FROM asked WHERE unit = ? ORDER BY created, path', hash)) {
      asked.push({ unit: hash, root: root ? root.root_name : '', path: r.path });
    }
  }
  return { asked };
}

/* ---------------- publishers ---------------- */

/* A signed request of `key` presenting the account name `name` ('' when signed out) (D31): the key
 * is recorded; a name no key holds binds to it (releasing the key's earlier name); a name another
 * key holds is not bound and the request goes on. `folded` is the name compared (NFC, case-folded,
 * by the caller). Returns { bound: 'new' | 'same' | 'taken' | 'none' }. */
export function publisherSeen(storage, key, name, folded, now) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('bad key');
  return storage.transactionSync(() => {
    storage.sql.exec('INSERT INTO publisher (key, first_seen) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', key, now);
    if (!folded) return { bound: 'none' };
    const held = one(storage, 'SELECT key FROM publisher_name WHERE name = ?', folded);
    if (held) {
      if (held.key !== key) return { bound: 'taken' };
      storage.sql.exec('UPDATE publisher_name SET display = ? WHERE name = ?', name, folded);
      return { bound: 'same' };
    }
    storage.sql.exec('DELETE FROM publisher_name WHERE key = ?', key);
    storage.sql.exec('INSERT INTO publisher_name (name, display, key, bound) VALUES (?, ?, ?, ?)', folded, name, key, now);
    return { bound: 'new' };
  });
}

/* The admin forget-key action (4.4): the key's row and its name binding go; its claims stay, since
 * their secrets authorise them. Returns { forgotten, name } (the freed name's display, or null). */
export function forgetKey(storage, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('bad key');
  return storage.transactionSync(() => {
    const had = one(storage, 'SELECT 1 AS hit FROM publisher WHERE key = ?', key);
    const name = one(storage, 'SELECT display FROM publisher_name WHERE key = ?', key);
    storage.sql.exec('DELETE FROM publisher_name WHERE key = ?', key);
    storage.sql.exec('DELETE FROM publisher WHERE key = ?', key);
    return { forgotten: !!had, name: name ? name.display : null };
  });
}

export function publisherRow(storage, key) {
  const p = one(storage, 'SELECT key, first_seen FROM publisher WHERE key = ?', key);
  if (!p) return null;
  const n = one(storage, 'SELECT name, display, bound FROM publisher_name WHERE key = ?', key);
  return { key: p.key, firstSeen: p.first_seen, name: n ? n.display : null };
}

/* ---------------- moderation ---------------- */

/* Removes a unit (5.19): it is no longer served, its blobs no other unit names are deleted, claims
 * stop naming it, and its hash is blocked so no upload can put it back. Returns { removed, objects }. */
export function blockUnit(storage, hash, reason, now) {
  if (!HEX64.test(hash) || typeof reason !== 'string') throw new Error('bad block');
  return storage.transactionSync(() => {
    storage.sql.exec('INSERT INTO blocked (hash, reason, created) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET reason = excluded.reason', hash, reason, now);
    storage.sql.exec('DELETE FROM map_claim_unit WHERE unit = ?', hash);
    const u = one(storage, 'SELECT id, hash, manifest_object FROM unit WHERE hash = ?', hash);
    return { removed: !!u, objects: u ? dropUnit(storage, u, now) : [] };
  });
}

export function unblockUnit(storage, hash) {
  if (!HEX64.test(hash)) throw new Error('bad block');
  const had = !!one(storage, 'SELECT 1 AS hit FROM blocked WHERE hash = ?', hash);
  storage.sql.exec('DELETE FROM blocked WHERE hash = ?', hash);
  return { unblocked: had };
}

/* ---------------- uploads in parts ---------------- */

function uploadRow(row) {
  return row ? { object: row.object, upload: row.upload, partSize: row.part_size, parts: row.parts, etags: JSON.parse(row.etags) } : null;
}

export function uploadSession(storage, sha, size) {
  if (!HEX64.test(sha) || !Number.isSafeInteger(size)) throw new Error('bad upload');
  return uploadRow(one(storage, 'SELECT * FROM upload WHERE sha = ? AND size = ?', sha, size));
}

export function openUpload(storage, { sha, size, object, upload, partSize, parts }, now) {
  checkObject(object);
  if (!HEX64.test(sha) || !Number.isSafeInteger(size) || size < 1 || typeof upload !== 'string' || !upload ||
      !Number.isSafeInteger(partSize) || partSize < 1 || !Number.isSafeInteger(parts) || parts < 1) {
    throw new Error('bad upload');
  }
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT * FROM upload WHERE sha = ? AND size = ?', sha, size);
    if (found) return { ...uploadRow(found), existing: true };
    storage.sql.exec('INSERT INTO upload (sha, size, object, upload, part_size, parts, etags, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sha, size, object, upload, partSize, parts, JSON.stringify(Array(parts).fill(null)), now, now);
    return { object, upload, partSize, parts, etags: Array(parts).fill(null), existing: false };
  });
}

export function recordPart(storage, sha, size, upload, part, etag, now) {
  if (typeof etag !== 'string' || !etag) throw new Error('bad etag');
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT * FROM upload WHERE sha = ? AND size = ? AND upload = ?', sha, size, upload);
    if (!found || !Number.isSafeInteger(part) || part < 1 || part > found.parts) return null;
    const etags = JSON.parse(found.etags);
    etags[part - 1] = etag;
    storage.sql.exec('UPDATE upload SET etags = ?, updated = ? WHERE sha = ? AND size = ?', JSON.stringify(etags), now, sha, size);
    return uploadRow({ ...found, etags: JSON.stringify(etags) });
  });
}

export function closeUpload(storage, sha, size, upload) {
  const found = one(storage, 'SELECT 1 AS hit FROM upload WHERE sha = ? AND size = ? AND upload = ?', sha, size, upload) ? 1 : 0;
  storage.sql.exec('DELETE FROM upload WHERE sha = ? AND size = ? AND upload = ?', sha, size, upload);
  return found;
}

export function abandonUploads(storage, now, limit, all = false) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT sha, size, object, upload FROM upload WHERE updated <= ? ORDER BY updated LIMIT ?',
      all ? Number.MAX_SAFE_INTEGER : now - UPLOAD_IDLE_MS - 1, limit);
    for (const { sha, size } of doomed) storage.sql.exec('DELETE FROM upload WHERE sha = ? AND size = ?', sha, size);
    return doomed.map(({ object, upload }) => ({ object, upload }));
  });
}

/* ---------------- accounting and reset ---------------- */

/* What the store holds. `unclaimed` counts units in their deletion delay; `claimUnitRows` and
 * `unitBlobRows` count the rows linking claims to units and units to blobs, so a row left behind by
 * an unpublish or a purge shows. `slackBytes` (in `slackPacks` packs) are bytes no blob uses any more,
 * which the next purge compacts away; `deadLater` counts compacted packs' old objects in their delay. */
export function storeStats(storage) {
  const u = one(storage, "SELECT count(*) AS units, coalesce(sum(state = 'held'), 0) AS held, coalesce(sum(state = 'pending'), 0) AS pending, " +
    'coalesce(sum(claims > 0), 0) AS claimed, coalesce(sum(claims <= 0), 0) AS unclaimed, coalesce(sum(size), 0) AS unitBytes FROM unit');
  const blobs = one(storage, 'SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes, coalesce(sum(broken), 0) AS broken FROM blob');
  const packs = one(storage, 'SELECT count(*) AS packs, coalesce(sum(size), 0) AS bytes, coalesce(sum(live_bytes), 0) AS live FROM pack');
  return { units: u.units, held: u.held, pending: u.pending, claimed: u.claimed, unclaimed: u.unclaimed, unitBytes: u.unitBytes,
    blobs: blobs.blobs, blobBytes: blobs.bytes, brokenBlobs: blobs.broken, packs: packs.packs, packBytes: packs.bytes, liveBytes: packs.live,
    claims: one(storage, 'SELECT count(*) AS n FROM map_claim').n, claimUnitRows: one(storage, 'SELECT count(*) AS n FROM map_claim_unit').n,
    unitBlobRows: one(storage, 'SELECT count(*) AS n FROM unit_blob').n, publishers: one(storage, 'SELECT count(*) AS n FROM publisher').n,
    names: one(storage, 'SELECT count(*) AS n FROM publisher_name').n, blocked: one(storage, 'SELECT count(*) AS n FROM blocked').n,
    asked: one(storage, 'SELECT count(*) AS n FROM asked').n, uploads: one(storage, 'SELECT count(*) AS n FROM upload').n,
    dead: one(storage, 'SELECT count(*) AS n FROM dead').n, deadLater: one(storage, 'SELECT count(*) AS n FROM dead_later').n,
    slackPacks: one(storage, 'SELECT count(*) AS n FROM pack_slack').n,
    slackBytes: one(storage, 'SELECT coalesce(sum(bytes), 0) AS n FROM pack_slack').n };
}

/* Empties the whole index (the maintainer's reset, after deleting every stored object). */
export function resetRegistry(storage) {
  return storage.transactionSync(() => {
    const counts = {};
    for (const table of ['map_claim_unit', 'map_claim', 'unit_blob', 'unit', 'blob', 'pack', 'pack_slack', 'upload', 'asked', 'dead',
      'dead_later', 'publisher_name', 'publisher', 'blocked']) {
      counts[table] = one(storage, 'SELECT count(*) AS n FROM ' + table).n;
      storage.sql.exec('DELETE FROM ' + table);
    }
    return counts;
  });
}

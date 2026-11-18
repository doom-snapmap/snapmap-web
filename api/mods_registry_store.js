/* Index of the mod store. One Durable Object holds every row, so claim counts, references,
 * releases, purges and repairs are decided in single transactions. The clock comes from the
 * Durable Object, never from an HTTP client.
 *
 * Storage is content addressed. A file's bytes (a blob, named by its SHA-256) are stored once
 * however many builds carry them, inside a pack: an R2 object of one or more blobs laid end to
 * end. A build is its skeleton (the archive's own ZIP headers and central directory, and which
 * blob each entry holds) plus the blobs it names; the store serves the build's archive byte for
 * byte as it was uploaded by writing the skeleton's headers around the blobs. A build arrives
 * as an archive, is checked (every file's SHA-256 against its mod.json), and is served from
 * that archive while it is staged; the packer (mods_pack.js, run by the Durable Object's alarm)
 * then moves the blobs it does not already hold into packs and deletes the archive. A published
 * map's part of a mod, and the per-object units a map will name (each the closure of one placed object), are builds like
 * any other, so units that share files share their blobs.
 *
 * Every R2 object a row names has its own random key, written once. A row that stops naming an
 * object puts the key on the delete queue (dead) in the same transaction, so an object is never
 * deleted while a row names it and never left behind when the deleting request fails; the
 * caller deletes what a call returns and forgets it, and the alarm and the daily purge finish
 * whatever is still queued. Tables grow; nothing here caps how many builds, blobs, claims or
 * builds per claim there are. */

import { planOf } from './mods_pack.js';

export const CLAIM_WINDOW_MS = 3600000;      // upload-before-claim window (one hour)
export const UPLOAD_IDLE_MS = 86400000;      // an upload in parts untouched this long is abandoned
export const SCHEMA_VERSION = 3;

/* Tables of the stores this index replaced (the blob and bundle store, then one archive per
 * build). The mod store is emptied before this store goes live (README.md, "Emptying the mod
 * store"), so their rows are dropped, not migrated; their R2 objects are deleted by the reset
 * route, and the daily sweep deletes any that no row names. */
const RETIRED_TABLES = ['mod_claim_bundle', 'mod_bundle_blob', 'mod_bundle', 'mod_blob',
  'mod_claim_build', 'mod_claim', 'mod_build', 'mod_upload', 'mod_asked'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  /* A build: its archive while staged, its skeleton always. broken: an object it needs is
   * missing from R2; it is not served until an upload repairs it. */
  'CREATE TABLE IF NOT EXISTS build (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, ' +
    'salt TEXT NOT NULL, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0, scripts INTEGER NOT NULL DEFAULT 0, ' +
    'slice_of TEXT, state TEXT NOT NULL, archive TEXT, skeleton TEXT NOT NULL, modjson TEXT NOT NULL, ' +
    'entries INTEGER NOT NULL, broken INTEGER NOT NULL DEFAULT 0, packed INTEGER, plan TEXT, replan INTEGER NOT NULL DEFAULT 0, ' +
    'vrefs INTEGER NOT NULL DEFAULT 0)',   // vrefs: the mod listings naming the build as a unit
  'CREATE INDEX IF NOT EXISTS build_unclaimed ON build (claims, created)',
  'CREATE INDEX IF NOT EXISTS build_state ON build (state, created)',
  /* A blob: one file's bytes, once, after the ZIP local header (hdr, hlen bytes) it had in the
   * archive that brought it. pack and at say where that header starts; refs counts the builds
   * naming the blob. */
  'CREATE TABLE IF NOT EXISTS blob (id INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, ' +
    'pack INTEGER NOT NULL, at INTEGER NOT NULL, hlen INTEGER NOT NULL, hdr TEXT NOT NULL, refs INTEGER NOT NULL DEFAULT 0, ' +
    'broken INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS blob_pack ON blob (pack)',
  /* A pack: an R2 object of blobs. live counts the blobs whose row points into it. */
  'CREATE TABLE IF NOT EXISTS pack (id INTEGER PRIMARY KEY, object TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, ' +
    'live INTEGER NOT NULL, live_bytes INTEGER NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS build_blob (build INTEGER NOT NULL, blob INTEGER NOT NULL, PRIMARY KEY (build, blob)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS build_blob_by_blob ON build_blob (blob)',
  'CREATE TABLE IF NOT EXISTS claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS claim_by_secret ON claim (ref, secret)',
  /* By hash: a claim names a build (or unit) by its hash, whichever upload of it is stored. */
  'CREATE TABLE IF NOT EXISTS claim_build (claim TEXT NOT NULL, build TEXT NOT NULL, PRIMARY KEY (claim, build)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS claim_build_by_build ON claim_build (build)',
  'CREATE TABLE IF NOT EXISTS upload (hash TEXT NOT NULL, size INTEGER NOT NULL, object TEXT NOT NULL, upload TEXT NOT NULL, ' +
    'part_size INTEGER NOT NULL, parts INTEGER NOT NULL, etags TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, ' +
    'PRIMARY KEY (hash, size))',
  'CREATE INDEX IF NOT EXISTS upload_idle ON upload (updated)',
  /* A file a published map's part of a mod lacked, which a player's game asked for: kept for
   * the map's author (the claim's holder) while the build is stored. */
  'CREATE TABLE IF NOT EXISTS asked (build TEXT NOT NULL, request TEXT NOT NULL, asker TEXT NOT NULL, created INTEGER NOT NULL, ' +
    'PRIMARY KEY (build, request))',
  /* R2 objects no row names any more, to delete. */
  'CREATE TABLE IF NOT EXISTS dead (object TEXT PRIMARY KEY, queued INTEGER NOT NULL)',
  /* Distribution (mods_dist.js): an author's signing key, bound to the SnapMap author ID. */
  'CREATE TABLE IF NOT EXISTS author (id TEXT PRIMARY KEY, key TEXT NOT NULL, bound INTEGER NOT NULL, updated INTEGER NOT NULL)',
  /* A mod's listing: a permanent ID owned by one author, its current version only (seq), what
   * installing the mod gives; it claims its units (build.vrefs) as a published map does. removed:
   * 1 by moderation, 2 by its author. */
  'CREATE TABLE IF NOT EXISTS listing (id TEXT PRIMARY KEY, author TEXT NOT NULL, name TEXT NOT NULL, seq INTEGER NOT NULL, ' +
    'size INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS listing_unit (mod TEXT NOT NULL, object TEXT NOT NULL, unit TEXT NOT NULL, PRIMARY KEY (mod, object)) WITHOUT ROWID',];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SALT = /^[a-z][a-z0-9]{7}$/;
/* Every object this store writes: an archive or upload in parts, a skeleton, a pack. */
const OBJECT = /^(build\/[0-9a-f]{64}\/[0-9a-f]{32}|skel\/[0-9a-f]{64}\/[0-9a-f]{32}|pack\/[0-9a-f]{32})$/;

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
  for (const statement of SCHEMA) storage.sql.exec(statement);
  /* Columns added after a table was first made (an index from an earlier form of this store). */
  for (const [table, column, type] of [['build', 'plan', 'TEXT'], ['build', 'replan', 'INTEGER NOT NULL DEFAULT 0'],
    ['build', 'vrefs', 'INTEGER NOT NULL DEFAULT 0']]) {
    const have = new Set(rows(storage, 'PRAGMA table_info(' + table + ')').map(r => r.name));
    if (!have.has(column)) storage.sql.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
  }
  storage.sql.exec("INSERT INTO store_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(SCHEMA_VERSION));
}

/* ---------------- the delete queue ---------------- */

/* Queues objects for deletion; returns them (the ones given that are keys). */
function bury(storage, objects, now) {
  const queued = [];
  for (const object of objects) {
    if (!object) continue;
    storage.sql.exec('INSERT INTO dead (object, queued) VALUES (?, ?) ON CONFLICT(object) DO NOTHING', object, now);
    queued.push(object);
  }
  return queued;
}

/* Objects queued for deletion, oldest first. */
export function deadObjects(storage, limit) {
  return rows(storage, 'SELECT object FROM dead ORDER BY queued LIMIT ?', limit).map(row => row.object);
}

/* Forgets queued objects the caller deleted. */
export function forgetDead(storage, objects) {
  for (const object of objects) storage.sql.exec('DELETE FROM dead WHERE object = ?', object);
  return true;
}

/* Which of these keys (an R2 listing's page) no row names: the sweep deletes them. */
export function unnamedObjects(storage, keys) {
  return keys.filter(key => !(
    one(storage, 'SELECT 1 AS hit FROM build WHERE archive = ? OR skeleton = ?', key, key) ||
    one(storage, 'SELECT 1 AS hit FROM pack WHERE object = ?', key) ||
    one(storage, 'SELECT 1 AS hit FROM upload WHERE object = ?', key) ||
    one(storage, 'SELECT 1 AS hit FROM dead WHERE object = ?', key)));
}

/* ---------------- builds ---------------- */

/* The row of one build, or null. */
export function buildRow(storage, hash) {
  if (!HEX64.test(hash)) throw new Error('bad build');
  return one(storage, 'SELECT id, size, salt, created, claims, vrefs, scripts, slice_of, state, archive, skeleton, modjson, entries, broken ' +
    'FROM build WHERE hash = ?', hash);
}

/* Drops one build's row: its blob references (and the blobs and packs no build names any
 * more), its asked rows, its objects onto the delete queue. Inside a transaction. Returns the
 * objects queued. */
function dropBuild(storage, row, now) {
  const blobs = rows(storage, 'SELECT blob FROM build_blob WHERE build = ?', row.id).map(r => r.blob);
  storage.sql.exec('DELETE FROM build_blob WHERE build = ?', row.id);
  for (const blob of blobs) storage.sql.exec('UPDATE blob SET refs = refs - 1 WHERE id = ?', blob);
  const queued = dropUnreferencedBlobs(storage, blobs, now);
  storage.sql.exec('DELETE FROM build WHERE id = ?', row.id);
  return queued.concat(bury(storage, [row.archive, row.skeleton], now));
}

function dropUnreferencedBlobs(storage, blobs, now) {
  const queued = [];
  for (const id of blobs) {
    const blob = one(storage, 'SELECT refs, pack, size FROM blob WHERE id = ?', id);
    if (!blob || blob.refs > 0) continue;
    storage.sql.exec('DELETE FROM blob WHERE id = ?', id);
    queued.push(...unlinkFromPack(storage, blob.pack, blob.size, now));
  }
  return queued;
}

/* One blob row left the pack: the pack goes when no blob row points into it. */
function unlinkFromPack(storage, packId, size, now) {
  storage.sql.exec('UPDATE pack SET live = live - 1, live_bytes = live_bytes - ? WHERE id = ?', size, packId);
  const pack = one(storage, 'SELECT object, live FROM pack WHERE id = ?', packId);
  if (pack && pack.live <= 0) {
    storage.sql.exec('DELETE FROM pack WHERE id = ?', packId);
    return bury(storage, [pack.object], now);
  }
  return [];
}

/* Records a checked archive stored as `archive`, with its skeleton object. A new build takes it
 * (staged). A build already stored keeps what it has when it is claimed and whole, or when the
 * upload is the same archive (the same size and mod.json); otherwise the upload replaces it: an
 * unclaimed build is replaced by any later archive that passes the checks (so an archive that
 * names a hash it is not cannot hold that hash against the real one), and a claimed build whose
 * objects went missing is repaired. Any registration restarts the upload window of a build
 * nothing claims. Returns { created, replaced, discard: [objects the caller deletes now] }. */
export function registerBuild(storage, b, now) {
  const { hash, size, salt, scripts, sliceOf = null, archive, skeleton, modjson, entries } = b;
  if (!HEX64.test(hash) || !Number.isSafeInteger(size) || size < 1 || typeof salt !== 'string' || !SALT.test(salt) ||
      !Number.isSafeInteger(scripts) || scripts < 0 || (sliceOf !== null && !HEX64.test(sliceOf)) || !HEX64.test(modjson) ||
      !Number.isSafeInteger(entries) || entries < 1) {
    throw new Error('bad build');
  }
  checkObject(archive);
  checkObject(skeleton);
  return storage.transactionSync(() => {
    const kept = one(storage, 'SELECT id, size, claims, vrefs, archive, skeleton, modjson, broken FROM build WHERE hash = ?', hash);
    if (kept) {
      const same = kept.size === size && kept.modjson === modjson;
      if (!kept.broken && (kept.claims > 0 || kept.vrefs > 0 || same)) {
        if (kept.claims <= 0 && kept.vrefs <= 0) storage.sql.exec('UPDATE build SET created = max(created, ?) WHERE id = ?', now, kept.id);
        return { created: false, replaced: false, discard: bury(storage, [archive, skeleton], now) };
      }
    }
    const discard = kept ? dropBuild(storage, kept, now) : [];
    /* The claims and the mod versions name the hash, so they stay with it. */
    storage.sql.exec('INSERT INTO build (hash, size, salt, created, claims, vrefs, scripts, slice_of, state, archive, skeleton, modjson, entries) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?)",
      hash, size, salt, now, kept ? kept.claims : 0, kept ? kept.vrefs : 0, scripts, sliceOf, archive, skeleton, modjson, entries);
    return { created: true, replaced: !!kept, discard };
  });
}

/* An idempotent re-upload of a stored build: restarts its upload window. */
export function touchBuild(storage, hash, now) {
  if (!HEX64.test(hash)) throw new Error('bad build');
  storage.sql.exec('UPDATE build SET created = max(created, ?) WHERE hash = ? AND claims <= 0 AND vrefs <= 0', now, hash);
  return true;
}

/* What serving a build needs, or null when it is not served (unknown, broken, being planned
 * again, or unclaimed past its hour): { size, scripts, state, archive, skeleton, sliceOf, plan }.
 * A staged build is served from its archive; a packed one by its plan (mods_pack.js), read from
 * one row. */
export function buildServed(storage, hash, now) {
  if (!HEX64.test(hash)) return null;
  const row = one(storage, 'SELECT size, created, claims, vrefs, scripts, state, archive, skeleton, broken, slice_of, plan FROM build WHERE hash = ?', hash);
  if (!row || row.broken || !(row.claims > 0 || row.vrefs > 0 || now - row.created < CLAIM_WINDOW_MS)) return null;
  if (row.state === 'packed' && !row.plan) return null;
  return { size: row.size, scripts: row.scripts, state: row.state, archive: row.archive, skeleton: row.skeleton, sliceOf: row.slice_of,
    plan: row.state === 'packed' ? JSON.parse(row.plan) : null };
}

/* Where each blob of a build is: sha -> { object, at, hlen, hdr }. */
function locationsOf(storage, id) {
  return new Map(rows(storage, 'SELECT b.sha AS sha, p.object AS object, b.at AS at, b.hlen AS hlen, b.hdr AS hdr FROM build_blob x ' +
    'JOIN blob b ON b.id = x.blob JOIN pack p ON p.id = b.pack WHERE x.build = ? AND b.broken = 0', id)
    .map(r => [r.sha, { object: r.object, at: r.at, hlen: r.hlen, hdr: r.hdr }]));
}

/* The build's plan from its skeleton and where its blobs are now, or null (a blob is missing). */
function planFor(storage, id, skel) {
  const made = planOf(skel, locationsOf(storage, id));
  return made && made.size === skel.size ? made.plan : null;
}

/* A request found an object a build needs missing from R2. The build is not served from now
 * on, nor is any other build that needs that object, until an upload of it repairs it; a blob
 * in a missing pack is rewritten by the next packed upload that carries it. */
export function markBroken(storage, hash, object, now) {
  checkObject(object);
  return storage.transactionSync(() => {
    const broken = new Set();
    const pack = one(storage, 'SELECT id FROM pack WHERE object = ?', object);
    if (pack) {
      storage.sql.exec('UPDATE blob SET broken = 1 WHERE pack = ?', pack.id);
      for (const r of rows(storage, 'SELECT DISTINCT x.build AS build FROM build_blob x JOIN blob b ON b.id = x.blob WHERE b.pack = ?', pack.id)) {
        broken.add(r.build);
      }
    }
    for (const r of rows(storage, 'SELECT id FROM build WHERE archive = ? OR skeleton = ?', object, object)) broken.add(r.id);
    for (const id of broken) storage.sql.exec('UPDATE build SET broken = 1 WHERE id = ?', id);
    console.log('mods: ' + object + ' is missing (found serving ' + hash.slice(0, 16) + '); ' + broken.size + ' build(s) wait for a repair');
    void now;
    return { builds: broken.size };
  });
}

/* ---------------- packing (mods_pack.js) ---------------- */

/* A packed build whose blobs a repair moved, or null: { id, hash, skeleton }. */
export function nextReplan(storage) {
  return one(storage, 'SELECT id, hash, skeleton FROM build WHERE replan = 1 LIMIT 1');
}

/* Plans a build again from its skeleton (decoded): served again when nothing of it is missing. */
export function replanBuild(storage, id, skeleton, skel) {
  return storage.transactionSync(() => {
    const row = one(storage, "SELECT id FROM build WHERE id = ? AND skeleton = ? AND state = 'packed'", id, skeleton);
    if (!row) return { replanned: false };
    const plan = planFor(storage, id, skel);
    storage.sql.exec('UPDATE build SET plan = ?, replan = 0, broken = ? WHERE id = ?', plan ? JSON.stringify(plan) : null, plan ? 0 : 1, id);
    return { replanned: true, served: !!plan };
  });
}

/* The oldest staged build, or null: { id, hash, archive, skeleton }. */
export function nextStaged(storage) {
  return one(storage, "SELECT id, hash, archive, skeleton FROM build WHERE state = 'staged' AND broken = 0 ORDER BY created LIMIT 1");
}

export function stagedCount(storage) {
  return one(storage, "SELECT count(*) AS n FROM build WHERE state = 'staged' AND broken = 0").n;
}

/* The first step of packing a staged build: every blob of `shas` the store already holds
 * whole is referenced by the build now (so it cannot go while the build is packed); the rest
 * are returned to be written. Null when the build is no longer that staged upload. */
export function reserveBlobs(storage, id, skeleton, shas) {
  if (!Array.isArray(shas) || !shas.every(s => HEX64.test(s))) throw new Error('bad blobs');
  return storage.transactionSync(() => {
    const row = one(storage, "SELECT id FROM build WHERE id = ? AND skeleton = ? AND state = 'staged'", id, skeleton);
    if (!row) return null;
    const needed = [];
    for (const sha of new Set(shas)) {
      const blob = one(storage, 'SELECT id, broken FROM blob WHERE sha = ?', sha);
      if (!blob || blob.broken) { needed.push(sha); continue; }
      const linked = one(storage, 'SELECT 1 AS hit FROM build_blob WHERE build = ? AND blob = ?', id, blob.id);
      if (!linked) {
        storage.sql.exec('INSERT INTO build_blob (build, blob) VALUES (?, ?)', id, blob.id);
        storage.sql.exec('UPDATE blob SET refs = refs + 1 WHERE id = ?', blob.id);
      }
    }
    return { needed };
  });
}

/* The last step: the packs written for the build's new blobs ({ object, size, blobs: [{ sha,
 * size, at, hlen, hdr }] }) are recorded, the build's plan is made from its skeleton (`skel`,
 * decoded), the build is packed and its archive goes to the delete queue. A blob another build
 * packed meanwhile keeps that copy (this pack's copy is dead space); a broken blob is repaired
 * by this copy, and the builds it had broken are planned again (the packer's next step) and
 * served once nothing of theirs is missing. When the build is no longer that staged upload,
 * nothing is recorded and the packs go to the delete queue. Returns { packed, discard }. */
export function commitPacks(storage, id, skeleton, packs, now, skel) {
  for (const p of packs) checkObject(p.object);
  return storage.transactionSync(() => {
    const row = one(storage, "SELECT id, archive FROM build WHERE id = ? AND skeleton = ? AND state = 'staged'", id, skeleton);
    if (!row) return { packed: false, discard: bury(storage, packs.map(p => p.object), now) };
    const repaired = new Set();
    const empty = [];
    for (const p of packs) {
      storage.sql.exec('INSERT INTO pack (object, size, live, live_bytes, created) VALUES (?, ?, 0, 0, ?)', p.object, p.size, now);
      const packId = one(storage, 'SELECT id FROM pack WHERE object = ?', p.object).id;
      let live = 0, liveBytes = 0;
      for (const b of p.blobs) {
        if (!HEX64.test(b.sha) || !Number.isSafeInteger(b.size) || !Number.isSafeInteger(b.at)) throw new Error('bad blob');
        let blob = one(storage, 'SELECT id, broken, pack, size FROM blob WHERE sha = ?', b.sha);
        if (blob && blob.broken) {
          const old = blob.pack;
          storage.sql.exec('UPDATE blob SET pack = ?, at = ?, hlen = ?, hdr = ?, broken = 0 WHERE id = ?', packId, b.at, b.hlen, b.hdr, blob.id);
          live++; liveBytes += b.size;
          empty.push(...unlinkFromPack(storage, old, blob.size, now));
          repaired.add(blob.id);
        } else if (!blob) {
          storage.sql.exec('INSERT INTO blob (sha, size, pack, at, hlen, hdr, refs) VALUES (?, ?, ?, ?, ?, ?, 0)', b.sha, b.size, packId, b.at, b.hlen, b.hdr);
          blob = one(storage, 'SELECT id FROM blob WHERE sha = ?', b.sha);
          live++; liveBytes += b.size;
        }
        if (!one(storage, 'SELECT 1 AS hit FROM build_blob WHERE build = ? AND blob = ?', id, blob.id)) {
          storage.sql.exec('INSERT INTO build_blob (build, blob) VALUES (?, ?)', id, blob.id);
          storage.sql.exec('UPDATE blob SET refs = refs + 1 WHERE id = ?', blob.id);
        }
      }
      if (live) storage.sql.exec('UPDATE pack SET live = ?, live_bytes = ? WHERE id = ?', live, liveBytes, packId);
      else { storage.sql.exec('DELETE FROM pack WHERE id = ?', packId); empty.push(...bury(storage, [p.object], now)); }
    }
    const plan = planFor(storage, id, skel);
    if (!plan) throw new Error('a packed build has a blob without a location');
    storage.sql.exec("UPDATE build SET state = 'packed', archive = NULL, packed = ?, plan = ? WHERE id = ?", now, JSON.stringify(plan), id);
    /* Builds a repaired blob had broken: planned again, then served when nothing is missing. */
    for (const blob of repaired) {
      for (const r of rows(storage, 'SELECT build FROM build_blob WHERE blob = ? AND build <> ?', blob, id)) {
        const still = one(storage, 'SELECT 1 AS hit FROM build_blob x JOIN blob b ON b.id = x.blob WHERE x.build = ? AND b.broken = 1', r.build);
        if (!still) storage.sql.exec("UPDATE build SET replan = 1 WHERE id = ? AND state = 'packed'", r.build);
      }
    }
    return { packed: true, discard: [...bury(storage, [row.archive], now), ...empty] };
  });
}

/* ---------------- claims ---------------- */

function claimedBuilds(storage, id) {
  return rows(storage, 'SELECT build FROM claim_build WHERE claim = ?', id).map(row => row.build);
}

/* Drops every listed build no claim names any more, so its objects go the moment its last
 * claim goes instead of waiting for the purge. Returns the objects queued; the caller deletes
 * them. */
function dropUnclaimed(storage, hashes, now) {
  const queued = [];
  for (const hash of new Set(hashes)) {
    const row = one(storage, 'SELECT id, claims, vrefs, archive, skeleton FROM build WHERE hash = ?', hash);
    if (!row || row.claims > 0 || row.vrefs > 0) continue;
    queued.push(...dropBuild(storage, row, now));
    storage.sql.exec('DELETE FROM asked WHERE build = ?', hash);
  }
  return queued;
}

/* Creates a claim, or replaces the build set of the claim matching ref and the presented
 * secret (one claim per published item). Secrets are stored and compared only as SHA-256
 * digests. A build that is not stored, or is broken, is missing: the client uploads it again. */
export function claimBuilds(storage, { ref, builds, id, secretHash, presentedHash }, now) {
  const list = hashList(builds);
  if (typeof ref !== 'string' || ref.length < 1) throw new Error('bad ref');
  if (!HEX32.test(id) || !HEX64.test(secretHash) || (presentedHash !== null && !HEX64.test(presentedHash))) throw new Error('bad claim');
  return storage.transactionSync(() => {
    let existing = null;
    if (presentedHash !== null) {
      const found = one(storage, 'SELECT id FROM claim WHERE ref = ? AND secret = ?', ref, presentedHash);
      if (!found) return { forbidden: true };
      existing = found.id;
    }
    const missing = list.filter(hash => !one(storage, 'SELECT 1 AS hit FROM build WHERE hash = ? AND broken = 0', hash));
    if (missing.length) return { missing };
    const claim = existing || id;
    const before = new Set(existing ? claimedBuilds(storage, existing) : []);
    const after = new Set(list);
    if (existing) storage.sql.exec('UPDATE claim SET updated = ? WHERE id = ?', now, claim);
    else storage.sql.exec('INSERT INTO claim (id, ref, secret, created, updated) VALUES (?, ?, ?, ?, ?)', claim, ref, secretHash, now, now);
    const released = [];
    for (const build of before) {
      if (after.has(build)) continue;
      storage.sql.exec('DELETE FROM claim_build WHERE claim = ? AND build = ?', claim, build);
      storage.sql.exec('UPDATE build SET claims = claims - 1 WHERE hash = ?', build);
      released.push(build);
    }
    for (const build of after) {
      if (before.has(build)) continue;
      storage.sql.exec('INSERT INTO claim_build (claim, build) VALUES (?, ?)', claim, build);
      storage.sql.exec('UPDATE build SET claims = claims + 1 WHERE hash = ?', build);
    }
    return { claim, created: !existing, deleted: dropUnclaimed(storage, released, now) };
  });
}

export function releaseClaim(storage, id, presentedHash, now = 0) {
  if (!HEX32.test(id) || !HEX64.test(presentedHash)) throw new Error('bad claim');
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT secret FROM claim WHERE id = ?', id);
    if (!found) return { notFound: true };
    if (found.secret !== presentedHash) return { forbidden: true };
    const held = claimedBuilds(storage, id);
    for (const build of held) storage.sql.exec('UPDATE build SET claims = claims - 1 WHERE hash = ?', build);
    storage.sql.exec('DELETE FROM claim_build WHERE claim = ?', id);
    storage.sql.exec('DELETE FROM claim WHERE id = ?', id);
    return { ok: true, deleted: dropUnclaimed(storage, held, now) };
  });
}

/* Drops unclaimed builds past the upload window. Their rows go first, so they stop being
 * served and cannot be claimed before their objects are deleted. Returns { builds, objects }. */
export function purgeBuilds(storage, now, limit) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT id, hash, archive, skeleton, claims FROM build WHERE claims <= 0 AND vrefs <= 0 AND created < ? ORDER BY created LIMIT ?',
      now - CLAIM_WINDOW_MS, limit);
    const objects = [];
    for (const row of doomed) {
      objects.push(...dropBuild(storage, row, now));
      storage.sql.exec('DELETE FROM asked WHERE build = ?', row.hash);
    }
    return { builds: doomed.length, objects };
  });
}

/* ---------------- what players asked for ---------------- */

/* A player's game asked a stored part of a build for `request`, which it lacks. `known`
 * (decided by the caller from the build's own source.json and files) is whether the request is
 * a file of the build it was cut from that the part does not carry. Kept once per build and
 * request (the first asker named). Returns { notFound } for a build the store does not hold,
 * { whole } for a whole build, { foreign } for a request that is not a file the part left out,
 * else { added } (false when it was known). */
export function reportAsked(storage, hash, request, asker, now, known = true) {
  if (!HEX64.test(hash) || typeof request !== 'string' || !request || typeof asker !== 'string') throw new Error('bad report');
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT salt, slice_of FROM build WHERE hash = ?', hash);
    if (!found) return { notFound: true };
    if (!found.slice_of) return { whole: true };
    if (!known) return { foreign: true };
    const had = one(storage, 'SELECT 1 AS hit FROM asked WHERE build = ? AND request = ?', hash, request);
    if (!had) storage.sql.exec('INSERT INTO asked (build, request, asker, created) VALUES (?, ?, ?, ?)', hash, request, asker, now);
    return { added: !had };
  });
}

/* What players asked for of the builds a claim names, for the claim's holder: { forbidden },
 * { notFound }, or { asked: [{ build, salt, request, by }] }. */
export function listAsked(storage, id, presentedHash) {
  if (!HEX32.test(id) || !HEX64.test(presentedHash)) throw new Error('bad claim');
  const found = one(storage, 'SELECT secret FROM claim WHERE id = ?', id);
  if (!found) return { notFound: true };
  if (found.secret !== presentedHash) return { forbidden: true };
  const asked = rows(storage, 'SELECT a.build AS build, b.salt AS salt, a.request AS request, a.asker AS asker FROM asked a ' +
    'JOIN claim_build c ON c.build = a.build JOIN build b ON b.hash = a.build WHERE c.claim = ? ORDER BY a.created, a.request', id);
  return { asked: asked.map(row => ({ build: row.build, salt: row.salt, request: row.request, by: row.asker })) };
}

/* ---------------- uploads in parts ---------------- */

function uploadRow(row) {
  return row ? { object: row.object, upload: row.upload, partSize: row.part_size, parts: row.parts, etags: JSON.parse(row.etags) } : null;
}

/* The upload in parts of this build at this size, or null. */
export function uploadSession(storage, hash, size) {
  if (!HEX64.test(hash) || !Number.isSafeInteger(size)) throw new Error('bad upload');
  return uploadRow(one(storage, 'SELECT * FROM upload WHERE hash = ? AND size = ?', hash, size));
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
    const found = one(storage, 'SELECT * FROM upload WHERE hash = ? AND size = ?', hash, size);
    if (found) return { ...uploadRow(found), existing: true };
    storage.sql.exec('INSERT INTO upload (hash, size, object, upload, part_size, parts, etags, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      hash, size, object, upload, partSize, parts, JSON.stringify(Array(parts).fill(null)), now, now);
    return { object, upload, partSize, parts, etags: Array(parts).fill(null), existing: false };
  });
}

/* Records a stored part's etag. Returns the session, or null when it is gone (completed,
 * abandoned or replaced meanwhile). */
export function recordPart(storage, hash, size, upload, part, etag, now) {
  if (typeof etag !== 'string' || !etag) throw new Error('bad etag');
  return storage.transactionSync(() => {
    const found = one(storage, 'SELECT * FROM upload WHERE hash = ? AND size = ? AND upload = ?', hash, size, upload);
    if (!found || !Number.isSafeInteger(part) || part < 1 || part > found.parts) return null;
    const etags = JSON.parse(found.etags);
    etags[part - 1] = etag;
    storage.sql.exec('UPDATE upload SET etags = ?, updated = ? WHERE hash = ? AND size = ?', JSON.stringify(etags), now, hash, size);
    return uploadRow({ ...found, etags: JSON.stringify(etags) });
  });
}

/* Forgets an upload in parts whose object a build row now names (or the caller deletes).
 * Returns 1 when it was there. */
export function closeUpload(storage, hash, size, upload) {
  const found = one(storage, 'SELECT 1 AS hit FROM upload WHERE hash = ? AND size = ? AND upload = ?', hash, size, upload) ? 1 : 0;
  storage.sql.exec('DELETE FROM upload WHERE hash = ? AND size = ? AND upload = ?', hash, size, upload);
  return found;
}

/* Drops uploads in parts nobody touched for UPLOAD_IDLE_MS (every one when `all`, for the
 * reset). Returns [{ object, upload }]; the caller aborts each multipart upload and deletes
 * its object (an upload completed but never registered left one). */
export function abandonUploads(storage, now, limit, all = false) {
  return storage.transactionSync(() => {
    const doomed = rows(storage, 'SELECT hash, size, object, upload FROM upload WHERE updated <= ? ORDER BY updated LIMIT ?',
      all ? Number.MAX_SAFE_INTEGER : now - UPLOAD_IDLE_MS - 1, limit);
    for (const { hash, size } of doomed) storage.sql.exec('DELETE FROM upload WHERE hash = ? AND size = ?', hash, size);
    return doomed.map(({ object, upload }) => ({ object, upload }));
  });
}

/* ---------------- accounting and reset ---------------- */

/* What the store holds: builds by state, blobs, packs, bytes stored and bytes the builds
 * would take one archive each (the saving of content addressing). */
export function storeStats(storage) {
  const b = one(storage, "SELECT count(*) AS builds, coalesce(sum(size), 0) AS archived, coalesce(sum(state = 'staged'), 0) AS staged, " +
    'coalesce(sum(broken), 0) AS broken, coalesce(sum(claims > 0 OR vrefs > 0), 0) AS claimed FROM build');
  const blobs = one(storage, 'SELECT count(*) AS blobs, coalesce(sum(size), 0) AS bytes FROM blob');
  const packs = one(storage, 'SELECT count(*) AS packs, coalesce(sum(size), 0) AS bytes, coalesce(sum(live_bytes), 0) AS live FROM pack');
  const staged = one(storage, "SELECT coalesce(sum(size), 0) AS bytes FROM build WHERE state = 'staged'");
  return { builds: b.builds, claimed: b.claimed, staged: b.staged, broken: b.broken, archiveBytes: b.archived,
    blobs: blobs.blobs, blobBytes: blobs.bytes, packs: packs.packs, packBytes: packs.bytes, stagedBytes: staged.bytes,
    claims: one(storage, 'SELECT count(*) AS n FROM claim').n, dead: one(storage, 'SELECT count(*) AS n FROM dead').n,
    authors: one(storage, 'SELECT count(*) AS n FROM author').n, listings: one(storage, 'SELECT count(*) AS n FROM listing WHERE removed = 0').n };
}

/* Empties the whole index. Only the maintainer's reset route calls it, after deleting
 * every stored object. */
export function resetRegistry(storage) {
  return storage.transactionSync(() => {
    const counts = {};
    for (const table of ['claim_build', 'claim', 'build_blob', 'blob', 'pack', 'build', 'upload', 'asked', 'dead',
      'listing_unit', 'listing', 'author']) {
      counts[table] = one(storage, 'SELECT count(*) AS n FROM ' + table).n;
      storage.sql.exec('DELETE FROM ' + table);
    }
    return counts;
  });
}


/* ---------------- distribution: authors and mod listings ---------------- */

/* The design the owner set (2026-11-17): a published map claims the units it places by hash
 * (claimBuilds above: a claim per map, naming units) and keeps them until its own author
 * republishes; a mod's listing is what installing the mod gives, its current version only,
 * published by the mod's author with a signed request, and it claims its version's units too.
 * A unit is kept while any map or listing claims it and deleted when none does. */
const OBJECT_TEXT = /^[^\u0000-\u001f\u007f]+$/;

export function authorRow(storage, id) {
  return one(storage, 'SELECT id, key, bound, updated FROM author WHERE id = ?', id);
}

/* Binds `key` to the author ID. The caller has checked the request is signed by `key` and, for
 * `rotate`, also by the key already bound. A wiped or new ID binds at once. Returns { bound:
 * 'new' | 'same' | 'rotated' } or { conflict: true } (another key holds the ID). */
export function bindAuthor(storage, id, key, rotate, now) {
  return storage.transactionSync(() => {
    const row = authorRow(storage, id);
    if (!row) {
      storage.sql.exec('INSERT INTO author (id, key, bound, updated) VALUES (?, ?, ?, ?)', id, key, now, now);
      return { bound: 'new' };
    }
    if (row.key === key) return { bound: 'same' };
    if (!rotate) return { conflict: true };
    storage.sql.exec('UPDATE author SET key = ?, updated = ? WHERE id = ?', key, now, id);
    return { bound: 'rotated' };
  });
}

function listingUnits(storage, mod) {
  return rows(storage, 'SELECT object, unit FROM listing_unit WHERE mod = ? ORDER BY object', mod);
}

/* The listing stops claiming its units; units nothing claims any more are dropped. Returns the
 * objects queued. */
function endListing(storage, mod, now) {
  const units = [...new Set(listingUnits(storage, mod).map(r => r.unit))];
  for (const unit of units) storage.sql.exec('UPDATE build SET vrefs = vrefs - 1 WHERE hash = ?', unit);
  storage.sql.exec('DELETE FROM listing_unit WHERE mod = ?', mod);
  return dropUnclaimed(storage, units, now);
}

/* A mod's listing as the product reads it to install the mod: its author, name, version number,
 * size and its units by placed object. Null when unknown. */
export function listingOf(storage, id) {
  const mod = one(storage, 'SELECT id, author, name, seq, size, removed, updated FROM listing WHERE id = ?', id);
  if (!mod) return null;
  return { mod: mod.id, author: mod.author, name: mod.name, seq: mod.seq, size: mod.size, removed: mod.removed, updated: mod.updated,
    objects: Object.fromEntries(listingUnits(storage, id).map(r => [r.object, r.unit])) };
}

/* What publishing `objects` (placed object -> unit hash) as version `seq` of the listing `mod`
 * would do, and (unless `check`) does it: the listing moves to the new version and claims its
 * units; the units only the old version named lose that claim. The caller has checked the
 * request is signed by `author`'s bound key. Returns { forbidden } (another author's mod),
 * { removed } (moderation), { stale: current seq }, { missing: [units the store lacks] }, or
 * { seq, size, newBytes, created, discard }. */
export function publishListing(storage, { mod, author, name, seq, objects, check = false }, now) {
  const entries = Object.entries(objects || {});
  if (!entries.length || !entries.every(([o, u]) => OBJECT_TEXT.test(o) && HEX64.test(u)) || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error('bad listing');
  }
  return storage.transactionSync(() => {
    const row = one(storage, 'SELECT author, seq, removed FROM listing WHERE id = ?', mod);
    if (row && row.author !== author) return { forbidden: true };
    if (row && row.removed === 1) return { removed: 1 };
    const expected = row ? row.seq + 1 : 1;
    if (seq !== expected) return { stale: row ? row.seq : 0 };
    const units = [...new Set(entries.map(([, u]) => u))];
    const missing = [];
    let size = 0, newBytes = 0;
    for (const unit of units) {
      const b = one(storage, 'SELECT size, claims, vrefs, broken FROM build WHERE hash = ?', unit);
      if (!b || b.broken) { missing.push(unit); continue; }
      size += b.size;
      if (b.claims <= 0 && b.vrefs <= 0) newBytes += b.size;
    }
    if (missing.length) return { missing };
    if (check) return { seq, size, newBytes, check: true };
    for (const unit of units) storage.sql.exec('UPDATE build SET vrefs = vrefs + 1 WHERE hash = ?', unit);
    const discard = row ? endListing(storage, mod, now) : [];
    if (row) storage.sql.exec('UPDATE listing SET seq = ?, name = ?, size = ?, removed = 0, updated = ? WHERE id = ?', seq, name, size, now, mod);
    else storage.sql.exec('INSERT INTO listing (id, author, name, seq, size, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', mod, author, name, seq, size, now, now);
    for (const [object, unit] of entries) storage.sql.exec('INSERT INTO listing_unit (mod, object, unit) VALUES (?, ?, ?)', mod, object, unit);
    return { seq, size, newBytes, created: !row, discard };
  });
}

/* The author deletes the listing (installing the mod is no longer offered; published maps keep
 * their units), or moderation removes it (`force`). The ID stays its author's: an author's own
 * deletion may publish again. Returns { deleted, discard }. */
export function deleteListing(storage, mod, author, now, force = false) {
  return storage.transactionSync(() => {
    const row = one(storage, 'SELECT author FROM listing WHERE id = ?', mod);
    if (!row) return { notFound: true };
    if (!force && row.author !== author) return { forbidden: true };
    const discard = endListing(storage, mod, now);
    storage.sql.exec('UPDATE listing SET removed = ?, size = 0, updated = ? WHERE id = ?', force ? 1 : 2, now, mod);
    return { deleted: true, discard };
  });
}

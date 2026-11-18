import { DurableObject } from 'cloudflare:workers';
import {
  initializeRegistry, unitStatus, unitRow, unitServed, beginUnit, unitBlobs, commitUnitArchive, completeUnit, blobWanted,
  commitBlob, blobLocation, markBroken, purgeUnits, claimUnits, releaseClaim, claimRev, releaseRef, reportAsked, listAsked,
  publisherSeen, forgetKey, publisherRow, blockUnit, unblockUnit, uploadSession, openUpload, recordPart, closeUpload,
  abandonUploads, deadObjects, forgetDead, unnamedObjects, storeStats, resetRegistry,
} from './mods_registry_store.js';
import { beginIn, checkUnitArchiveIn, checkBlobIn, archivePlanIn, askedIn } from './mods_store.js';

/* The single mod store index (named "registry"); see mods_registry_store.js. Every method is one
 * transaction on the object's SQLite storage, with the object's clock. */
export class ModRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeRegistry(this.ctx.storage);
  }

  get s() { return this.ctx.storage; }
  unitStatus(hashes) { return unitStatus(this.s, hashes); }
  unitRow(hash) { return unitRow(this.s, hash); }
  unitServed(hash, withBlobs) { return unitServed(this.s, hash, withBlobs); }
  beginUnit(u) { return beginUnit(this.s, u, Date.now()); }
  unitBlobs(hash) { return unitBlobs(this.s, hash); }
  commitUnitArchive(hash, object, size, blobs) { return commitUnitArchive(this.s, hash, object, size, blobs, Date.now()); }
  completeUnit(hash) { return completeUnit(this.s, hash, Date.now()); }
  blobWanted(sha, size) { return blobWanted(this.s, sha, size); }
  commitBlob(sha, size, crc, object) { return commitBlob(this.s, sha, size, crc, object, Date.now()); }
  blobLocation(sha) { return blobLocation(this.s, sha); }
  markBroken(object) { return markBroken(this.s, object, Date.now()); }
  purgeUnits(limit) { return purgeUnits(this.s, Date.now(), limit); }
  claim(request) { return claimUnits(this.s, request, Date.now()); }
  release(request) { return releaseClaim(this.s, request, Date.now()); }
  claimRev(ref, secretHash) { return claimRev(this.s, ref, secretHash); }
  releaseRef(ref) { return releaseRef(this.s, ref, Date.now()); }
  reportAsked(hash, path) { return reportAsked(this.s, hash, path, Date.now()); }
  listAsked(claims) { return listAsked(this.s, claims); }
  publisherSeen(key, name, folded) { return publisherSeen(this.s, key, name, folded, Date.now()); }
  publisher(key) { return publisherRow(this.s, key); }
  forgetKey(key) { return forgetKey(this.s, key); }
  block(hash, reason) { return blockUnit(this.s, hash, reason, Date.now()); }
  unblock(hash) { return unblockUnit(this.s, hash); }
  uploadSession(sha, size) { return uploadSession(this.s, sha, size); }
  openUpload(request) { return openUpload(this.s, request, Date.now()); }
  recordPart(sha, size, upload, part, etag) { return recordPart(this.s, sha, size, upload, part, etag, Date.now()); }
  closeUpload(sha, size, upload) { return closeUpload(this.s, sha, size, upload); }
  abandonUploads(limit, all) { return abandonUploads(this.s, Date.now(), limit, all); }
  deadObjects(limit) { return deadObjects(this.s, limit); }
  forgetDead(objects) { return forgetDead(this.s, objects); }
  unnamedObjects(keys) { return unnamedObjects(this.s, keys); }
  stats() { return storeStats(this.s); }
  meta(key, value) {
    if (value !== undefined) {
      this.s.sql.exec('INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
      return true;
    }
    return this.s.sql.exec('SELECT value FROM store_meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }
  reset() { return resetRegistry(this.s); }
}

/* The checks of one unit's (or one large blob's) uploads, named "unit:<hash>" or "blob:<sha>": they
 * read what a request stored back from R2 and hash every byte (mods_store.js), so the Worker that
 * took the request only moved its bytes. A Durable Object has the CPU time this needs on either
 * Workers plan. It keeps no state. */
export class ModChecker extends DurableObject {
  begin(hash, bytes, auth) { return beginIn(this.env, hash, bytes, auth); }
  archive(hash, object, size, auth) { return checkUnitArchiveIn(this.env, hash, object, size, auth); }
  blob(sha, object, size) { return checkBlobIn(this.env, sha, object, size); }
  plan(hash) { return archivePlanIn(this.env, hash); }
  asked(hash, path) { return askedIn(this.env, hash, path); }
}

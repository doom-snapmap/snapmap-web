import { DurableObject } from 'cloudflare:workers';
import {
  initializeRegistry, buildRow, registerBuild, touchBuild, buildServed, markBroken,
  claimBuilds, releaseClaim, purgeBuilds, resetRegistry, reportAsked, listAsked,
  uploadSession, openUpload, recordPart, closeUpload, abandonUploads,
  nextStaged, stagedCount, reserveBlobs, commitPacks, deadObjects, forgetDead, unnamedObjects, storeStats,
  nextReplan, replanBuild,
  authorRow, bindAuthor, listingOf, publishListing, deleteListing,
} from './mods_registry_store.js';
import { packStaged } from './mods_pack.js';
import { checkArchive, hashParts, leftOutIn } from './mods_store.js';

const ALARM_BUDGET_MS = 10 * 60 * 1000;   // one alarm packs for at most this long (the platform allows 15 minutes)

/* The registry functions bound to one storage and clock: what the packer calls. */
export function boundRegistry(storage, now = () => Date.now()) {
  return {
    nextStaged: () => nextStaged(storage),
    stagedCount: () => stagedCount(storage),
    reserveBlobs: (id, skeleton, shas) => reserveBlobs(storage, id, skeleton, shas),
    commitPacks: (id, skeleton, packs, skel) => commitPacks(storage, id, skeleton, packs, now(), skel),
    nextReplan: () => nextReplan(storage),
    replan: (id, skeleton, skel) => replanBuild(storage, id, skeleton, skel),
    markBroken: (hash, object) => markBroken(storage, hash, object, now()),
    deadObjects: limit => deadObjects(storage, limit),
    forgetDead: objects => forgetDead(storage, objects),
  };
}

// The single mod store index (named "registry"); see mods_registry_store.js.
export class ModRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeRegistry(this.ctx.storage);
    this.reg = boundRegistry(this.ctx.storage);
  }

  /* The packer runs on the alarm: a checked upload is served from its archive at once, and its
   * blobs move into packs in the background. */
  async schedule(delay = 50) {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > Date.now() + delay) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async alarm() {
    const result = await packStaged(this.env, this.reg, Date.now() + ALARM_BUDGET_MS);
    if (result.left > 0 || deadObjects(this.ctx.storage, 1).length) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /* Pack now, for tests and the maintainer: what a scheduled alarm would do. */
  async packNow(budgetMs = ALARM_BUDGET_MS) { return packStaged(this.env, this.reg, Date.now() + budgetMs); }
  async kick() { if (stagedCount(this.ctx.storage) || deadObjects(this.ctx.storage, 1).length) await this.schedule(); return true; }

  buildRow(hash) { return buildRow(this.ctx.storage, hash); }
  async registerBuild(build) {
    const result = registerBuild(this.ctx.storage, build, Date.now());
    if (result.created) await this.schedule();
    return result;
  }
  touchBuild(hash) { return touchBuild(this.ctx.storage, hash, Date.now()); }
  buildServed(hash) { return buildServed(this.ctx.storage, hash, Date.now()); }
  markBroken(hash, object) { return markBroken(this.ctx.storage, hash, object, Date.now()); }
  claim(request) { return claimBuilds(this.ctx.storage, request, Date.now()); }
  release(id, presentedHash) { return releaseClaim(this.ctx.storage, id, presentedHash, Date.now()); }
  purgeBuilds(limit) { return purgeBuilds(this.ctx.storage, Date.now(), limit); }
  uploadSession(hash, size) { return uploadSession(this.ctx.storage, hash, size); }
  openUpload(request) { return openUpload(this.ctx.storage, request, Date.now()); }
  recordPart(hash, size, upload, part, etag) { return recordPart(this.ctx.storage, hash, size, upload, part, etag, Date.now()); }
  closeUpload(hash, size, upload) { return closeUpload(this.ctx.storage, hash, size, upload); }
  abandonUploads(limit, all) { return abandonUploads(this.ctx.storage, Date.now(), limit, all); }
  reportAsked(hash, request, asker, known) { return reportAsked(this.ctx.storage, hash, request, asker, Date.now(), known); }
  listAsked(id, presentedHash) { return listAsked(this.ctx.storage, id, presentedHash); }
  deadObjects(limit) { return deadObjects(this.ctx.storage, limit); }
  forgetDead(objects) { return forgetDead(this.ctx.storage, objects); }
  unnamedObjects(keys) { return unnamedObjects(this.ctx.storage, keys); }
  stats() { return storeStats(this.ctx.storage); }
  meta(key, value) {
    if (value !== undefined) {
      this.ctx.storage.sql.exec('INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
      return true;
    }
    return this.ctx.storage.sql.exec('SELECT value FROM store_meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }
  reset() { return resetRegistry(this.ctx.storage); }

  /* Distribution (mods_dist.js): authors' keys and mods' listings. */
  author(id) { return authorRow(this.ctx.storage, id); }
  bindAuthor(id, key, rotate) { return bindAuthor(this.ctx.storage, id, key, rotate, Date.now()); }
  listing(id) { return listingOf(this.ctx.storage, id); }
  publishListing(request) { return publishListing(this.ctx.storage, request, Date.now()); }
  deleteListing(mod, author, force) { return deleteListing(this.ctx.storage, mod, author, Date.now(), force); }
}

/* The check of one build's uploads (named "check:<hash>"): reads an uploaded archive back from R2,
 * hashes every byte and judges it (mods_store.js checkArchive), so the Worker that took the
 * upload only moved its bytes. A Durable Object has the CPU time a large archive needs on any
 * plan; one per build keeps the checks of different builds apart, and the hashing of a large archive
 * is shared among several, named "hash:<hash>:<n>". It keeps no state. */
export class ModChecker extends DurableObject {
  check(hash, object, size) { return checkArchive(this.env, hash, object, size); }
  hashParts(object, start, length, parts) { return hashParts(this.env, object, start, length, parts); }
  leftOut(skeleton, request) { return leftOutIn(this.env, skeleton, request); }
}
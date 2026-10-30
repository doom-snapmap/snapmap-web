import { DurableObject } from 'cloudflare:workers';
import {
  initializeRegistry, missingBlobs, noteBlob, registerBundle, bundleServed, blobClaimed,
  claimBundles, releaseClaim, purgeBundles, purgeBlobs, finishBlobs, resetRegistry,
} from './mods_registry_store.js';

// The single mod store index (named "registry"); see mods_registry_store.js.
export class ModRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeRegistry(this.ctx.storage);
  }

  missing(hashes) { return missingBlobs(this.ctx.storage, hashes); }
  noteBlob(hash, size) { return noteBlob(this.ctx.storage, hash, size, Date.now()); }
  registerBundle(hash, files) { return registerBundle(this.ctx.storage, hash, files, Date.now()); }
  bundleServed(hash) { return bundleServed(this.ctx.storage, hash, Date.now()); }
  blobClaimed(hash) { return blobClaimed(this.ctx.storage, hash); }
  claim(request) { return claimBundles(this.ctx.storage, request, Date.now()); }
  release(id, presentedHash) { return releaseClaim(this.ctx.storage, id, presentedHash); }
  purgeBundles(limit) { return purgeBundles(this.ctx.storage, Date.now(), limit); }
  purgeBlobs(limit) { return purgeBlobs(this.ctx.storage, Date.now(), limit); }
  finishBlobs(hashes) { return finishBlobs(this.ctx.storage, hashes); }
  reset() { return resetRegistry(this.ctx.storage); }
}

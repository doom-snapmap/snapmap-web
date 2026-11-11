import { DurableObject } from 'cloudflare:workers';
import {
  initializeRegistry, buildRow, registerBuild, touchBuild, buildServed,
  claimBuilds, releaseClaim, purgeBuilds, resetRegistry, reportAsked, listAsked,
  uploadSession, openUpload, recordPart, closeUpload, abandonUploads,
} from './mods_registry_store.js';

// The single mod store index (named "registry"); see mods_registry_store.js.
export class ModRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeRegistry(this.ctx.storage);
  }

  buildRow(hash) { return buildRow(this.ctx.storage, hash); }
  registerBuild(hash, size, salt, object, scripts, sliceOf) {
    return registerBuild(this.ctx.storage, hash, size, salt, object, scripts, Date.now(), sliceOf ?? null);
  }
  touchBuild(hash) { return touchBuild(this.ctx.storage, hash, Date.now()); }
  buildServed(hash) { return buildServed(this.ctx.storage, hash, Date.now()); }
  claim(request) { return claimBuilds(this.ctx.storage, request, Date.now()); }
  release(id, presentedHash) { return releaseClaim(this.ctx.storage, id, presentedHash); }
  purgeBuilds(limit) { return purgeBuilds(this.ctx.storage, Date.now(), limit); }
  uploadSession(hash, size) { return uploadSession(this.ctx.storage, hash, size); }
  openUpload(request) { return openUpload(this.ctx.storage, request, Date.now()); }
  recordPart(hash, size, upload, part, etag) { return recordPart(this.ctx.storage, hash, size, upload, part, etag, Date.now()); }
  closeUpload(hash, size, upload) { return closeUpload(this.ctx.storage, hash, size, upload); }
  abandonUploads(limit, all) { return abandonUploads(this.ctx.storage, Date.now(), limit, all); }
  reportAsked(hash, request, asker) { return reportAsked(this.ctx.storage, hash, request, asker, Date.now()); }
  listAsked(id, presentedHash) { return listAsked(this.ctx.storage, id, presentedHash); }
  reset() { return resetRegistry(this.ctx.storage); }
}

import { DurableObject } from 'cloudflare:workers';
import {
  initializeRegistry, buildRow, registerBuild, touchBuild, buildServed,
  claimBuilds, releaseClaim, purgeBuilds, resetRegistry,
} from './mods_registry_store.js';

// The single mod store index (named "registry"); see mods_registry_store.js.
export class ModRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeRegistry(this.ctx.storage);
  }

  buildRow(hash) { return buildRow(this.ctx.storage, hash); }
  registerBuild(hash, size, salt) { return registerBuild(this.ctx.storage, hash, size, salt, Date.now()); }
  touchBuild(hash) { return touchBuild(this.ctx.storage, hash, Date.now()); }
  buildServed(hash) { return buildServed(this.ctx.storage, hash, Date.now()); }
  claim(request) { return claimBuilds(this.ctx.storage, request, Date.now()); }
  release(id, presentedHash) { return releaseClaim(this.ctx.storage, id, presentedHash); }
  purgeBuilds(limit) { return purgeBuilds(this.ctx.storage, Date.now(), limit); }
  reset() { return resetRegistry(this.ctx.storage); }
}

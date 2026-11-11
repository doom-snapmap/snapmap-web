import { DurableObject } from 'cloudflare:workers';
import { initializeQuota, consumeQuota, consumeModQuota } from './quota_store.js';

// One object coordinates every session belonging to the same GitHub account,
// or every request from the same hashed client address for the mod store.
export class CommunityQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initializeQuota(this.ctx.storage);
  }

  consume(kind) {
    return consumeQuota(this.ctx.storage, kind, Date.now());
  }

  consumeMods(entries) {
    return consumeModQuota(this.ctx.storage, entries, Date.now());
  }
}

import { DurableObject } from 'cloudflare:workers';
import { initializeQuota, consumeQuota, consumeModQuota } from './quota_store.js';
import { meteredStorage } from './sql_meter.js';

// One object coordinates every session belonging to the same GitHub account,
// or every request from the same hashed client address for the mod store.
export class CommunityQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.metered = meteredStorage(this.ctx.storage);
    initializeQuota(this.metered.storage);
  }

  get s() { this.metered.settle(); return this.metered.storage; }

  consume(kind) {
    return consumeQuota(this.s, kind, Date.now());
  }

  consumeMods(entries) {
    return consumeModQuota(this.s, entries, Date.now());
  }

  // The rows this object's SQL read and wrote since it started (sql_meter.js).
  meter() { return { ...this.metered.settle() }; }
}

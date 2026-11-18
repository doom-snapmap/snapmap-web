export const LIMITS = Object.freeze({ post: 10, comment: 60, reaction: 120, upload: 30, preview: 120, edit: 60 });
/* Anonymous mod store limits, per hashed client address per UTC hour. They protect the bucket and
 * its bill from abuse and are not limits on a mod: a count of new uploads, bytes of new uploads,
 * reads, and claim calls. The byte limit is soft (SOFT_MOD_LIMITS): an upload is admitted while
 * the hour's bytes are below it, whatever its own size, so a build of any size can always be
 * published, and an address that has sent that much this hour waits for the next. A build the
 * store already holds, a resumed upload and its parts count nothing. */
export const MOD_LIMITS = Object.freeze({
  mod_build_put: 1024, mod_bytes: 64 * 1024 * 1024 * 1024, mod_get: 20000, mod_claim: 256,
  /* Per author (mods_dist.js): mod publishes, and bytes of units new to the store, per UTC hour. */
  mod_publish: 256, mod_author_bytes: 256 * 1024 * 1024 * 1024,
});
export const SOFT_MOD_LIMITS = new Set(['mod_bytes', 'mod_author_bytes']);
const HOUR_MS = 3600000;

export function initializeQuota(storage) {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS quota (kind TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS mod_quota (kind TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL)');
}

// The clock is supplied by the Durable Object, never by an HTTP client.
export function consumeQuota(storage, kind, now) {
  if (!Object.hasOwn(LIMITS, kind)) throw new Error('unknown quota kind');
  const window = Math.floor(now / HOUR_MS);
  return storage.transactionSync(() => {
    const rows = storage.sql.exec('SELECT window, used FROM quota WHERE kind = ?', kind).toArray();
    const used = rows.length && rows[0].window === window ? rows[0].used : 0;
    if (used >= LIMITS[kind]) return { allowed: false };
    storage.sql.exec('INSERT INTO quota (kind, window, used) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET window = excluded.window, used = excluded.used', kind, window, used + 1);
    return { allowed: true };
  });
}

// Admits every [kind, amount] entry or none of them, so a refused upload never spends its count.
export function consumeModQuota(storage, entries, now) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > Object.keys(MOD_LIMITS).length) throw new Error('bad quota entries');
  const seen = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('bad quota entries');
    const [kind, amount] = entry;
    if (!Object.hasOwn(MOD_LIMITS, kind) || seen.has(kind)) throw new Error('unknown quota kind');
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('bad quota amount');
    seen.add(kind);
  }
  const window = Math.floor(now / HOUR_MS);
  return storage.transactionSync(() => {
    const used = entries.map(([kind]) => {
      const rows = storage.sql.exec('SELECT window, used FROM mod_quota WHERE kind = ?', kind).toArray();
      return rows.length && rows[0].window === window ? rows[0].used : 0;
    });
    for (let i = 0; i < entries.length; i++) {
      const [kind, amount] = entries[i];
      if (SOFT_MOD_LIMITS.has(kind) ? used[i] >= MOD_LIMITS[kind] : used[i] + amount > MOD_LIMITS[kind]) return { allowed: false, kind };
    }
    for (let i = 0; i < entries.length; i++) {
      storage.sql.exec('INSERT INTO mod_quota (kind, window, used) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET window = excluded.window, used = excluded.used',
        entries[i][0], window, used[i] + entries[i][1]);
    }
    return { allowed: true };
  });
}

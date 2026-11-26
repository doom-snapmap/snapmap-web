import { DurableObject } from 'cloudflare:workers';

// Production bundle schema at c381e650. Only this test fixture writes the five sample rows.
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS mod_blob (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS mod_bundle (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS mod_bundle_blob (bundle TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (bundle, blob))',
  'CREATE INDEX IF NOT EXISTS mod_bundle_blob_by_blob ON mod_bundle_blob (blob)',
  'CREATE TABLE IF NOT EXISTS mod_claim (id TEXT PRIMARY KEY, ref TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS mod_claim_by_secret ON mod_claim (ref, secret)',
  'CREATE TABLE IF NOT EXISTS mod_claim_bundle (claim TEXT NOT NULL, bundle TEXT NOT NULL, PRIMARY KEY (claim, bundle))',
];

export class ModRegistry extends DurableObject {
  seed(hash) {
    const sql = this.ctx.storage.sql;
    for (const statement of SCHEMA) sql.exec(statement);
    sql.exec('INSERT INTO mod_blob VALUES (?, 27, 1, 0)', hash);
    sql.exec('INSERT INTO mod_bundle VALUES (?, 2, 1)', hash);
    sql.exec('INSERT INTO mod_bundle_blob VALUES (?, ?)', hash, hash);
    sql.exec('INSERT INTO mod_claim VALUES (?, ?, ?, 3, 4)', 'c'.repeat(32), 'published-map', 'd'.repeat(64));
    sql.exec('INSERT INTO mod_claim_bundle VALUES (?, ?)', 'c'.repeat(32), hash);
    return this.snapshot();
  }

  snapshot() {
    const sql = this.ctx.storage.sql;
    const schema = sql.exec("SELECT name, sql FROM sqlite_master WHERE name NOT GLOB '_cf_*' ORDER BY name").toArray();
    const rows = ['mod_blob', 'mod_bundle', 'mod_bundle_blob', 'mod_claim', 'mod_claim_bundle'].map(table =>
      sql.exec('SELECT * FROM ' + table).toArray());
    return JSON.stringify({ schema, rows });
  }
}

export default { fetch() { return new Response(null, { status: 404 }); } };

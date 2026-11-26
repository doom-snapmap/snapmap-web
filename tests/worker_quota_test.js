'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../api/quota_store.js'), 'utf8');
const quotaModule = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function immediateStorage(db) {
  return {
    sql: { exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

test('each quota admits exactly its configured count in a fixed hour', async () => {
  const { initializeQuota, consumeQuota, LIMITS } = await quotaModule;
  const db = new DatabaseSync(':memory:');
  try {
    const storage = immediateStorage(db);
    initializeQuota(storage);
    for (const [kind, limit] of Object.entries(LIMITS)) {
      for (let i = 0; i < limit; i++) assert.equal(consumeQuota(storage, kind, 3600000 + i).allowed, true);
      assert.equal(consumeQuota(storage, kind, 7199999).allowed, false, kind);
      assert.equal(consumeQuota(storage, kind, 7200000).allowed, true, kind);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM quota').get().n, Object.keys(LIMITS).length);
  } finally { db.close(); }
});

test('reinitialization preserves quotas and unknown operation names cannot allocate rows', async () => {
  const { initializeQuota, consumeQuota } = await quotaModule;
  const db = new DatabaseSync(':memory:');
  try {
    const storage = immediateStorage(db);
    initializeQuota(storage);
    for (let i = 0; i < 10; i++) consumeQuota(storage, 'post', 1);
    initializeQuota(storage);
    assert.equal(consumeQuota(storage, 'post', 2).allowed, false);
    for (const kind of ['unknown', 'constructor', '__proto__']) assert.throws(() => consumeQuota(storage, kind, 1), /unknown quota kind/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM quota').get().n, 1);
  } finally { db.close(); }
});

test('failed storage transaction rolls back admission instead of returning success', async () => {
  const { initializeQuota, consumeQuota } = await quotaModule;
  const db = new DatabaseSync(':memory:');
  try {
    const storage = immediateStorage(db);
    initializeQuota(storage);
    const exec = storage.sql.exec;
    storage.sql.exec = (query, ...args) => {
      const result = exec(query, ...args);
      if (query.startsWith('INSERT')) throw new Error('injected write failure');
      return result;
    };
    assert.throws(() => consumeQuota(storage, 'post', 1), /injected write failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM quota').get().n, 0);
  } finally { db.close(); }
});

test('upgrading the quota object preserves earlier mod counters and existing Community quotas', async () => {
  const { initializeQuota, consumeQuota, consumeModQuota } = await quotaModule;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE quota (kind TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL);" +
      "INSERT INTO quota VALUES ('post', 0, 10);" +
      "CREATE TABLE mod_quota (kind TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL);" +
      "INSERT INTO mod_quota VALUES ('mod_get', 0, 15);");
    const storage = immediateStorage(db);
    initializeQuota(storage);
    assert.equal(consumeQuota(storage, 'post', 1).allowed, false);
    assert.equal(consumeModQuota(storage, [['mod_get', 1]], 1).allowed, true);
    assert.equal(db.prepare("SELECT used FROM mod_quota WHERE kind = 'mod_get'").get().used, 15);
  } finally { db.close(); }
});

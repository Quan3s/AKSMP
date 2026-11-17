'use strict';

/**
 * Luu tai khoan VSPhone vao PostgreSQL.
 * - connection string lay tu config.database.connectionString hoac env DATABASE_URL
 * - tu tao bang neu chua co
 */

function loadPg() {
  try {
    return require('pg');
  } catch (_) {
    throw new Error('Thieu module "pg". Chay: npm install pg');
  }
}

class AccountDB {
  constructor({ connectionString, table = 'vsphone_accounts', log = console.log } = {}) {
    this.connectionString = connectionString || process.env.DATABASE_URL || '';
    this.table = table;
    this.log = log;
    this.pool = null;
  }

  get enabled() {
    return !!this.connectionString;
  }

  async connect() {
    if (!this.enabled) throw new Error('Chua cau hinh DATABASE_URL / database.connectionString');
    const { Pool } = loadPg();
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    await this.pool.query(`SELECT 1`);
    await this.createTable();
    this.log(`[db] da ket noi PostgreSQL, bang "${this.table}" san sang`);
    return this;
  }

  async createTable() {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT,
        token       TEXT,
        user_id     BIGINT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await this.pool.query(sql);
  }

  async save(account) {
    if (!this.pool) return false;
    const q = `
      INSERT INTO ${this.table} (email, password, token, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET
        password   = EXCLUDED.password,
        token      = EXCLUDED.token,
        user_id    = EXCLUDED.user_id,
        updated_at = NOW()
      RETURNING id`;
    const uid = account.userId === null || account.userId === undefined ? null : Number(account.userId);
    const { rows } = await this.pool.query(q, [
      account.email,
      account.password || null,
      account.token || null,
      uid !== null && Number.isFinite(uid) ? uid : null,
    ]);
    this.log(`[db] da luu ${account.email} (id=${rows[0] ? rows[0].id : '?'})`);
    return true;
  }

  async count() {
    if (!this.pool) return 0;
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${this.table}`);
    return rows[0] ? rows[0].n : 0;
  }

  async close() {
    try {
      if (this.pool) await this.pool.end();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { AccountDB };

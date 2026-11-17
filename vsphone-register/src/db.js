'use strict';

function loadPg() {
  try { return require('pg'); }
  catch (_) { throw new Error('Thieu module "pg". Chay: npm install pg'); }
}

class AccountDB {
  constructor({ connectionString, table = 'vsphone_accounts', log = console.log } = {}) {
    this.connectionString = connectionString || process.env.DATABASE_URL || '';
    this.table = table;
    this.log   = log;
    this.pool  = null;
  }

  get enabled() { return !!this.connectionString; }

  async connect() {
    if (!this.enabled) throw new Error('Chua cau hinh DATABASE_URL');
    const { Pool } = loadPg();
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl: { rejectUnauthorized: false },
    });
    await this.pool.query('SELECT 1');
    await this._migrate();
    this.log(`[db] ket noi OK, bang "${this.table}" san sang`);
    return this;
  }

  async _migrate() {
    // chi luu email|password + created_at de biet bao gio het han 60p
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id         BIGSERIAL PRIMARY KEY,
        email      TEXT NOT NULL UNIQUE,
        password   TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  }

  async save(email, password) {
    if (!this.pool) return false;
    const { rows } = await this.pool.query(`
      INSERT INTO ${this.table} (email, password)
      VALUES ($1, $2)
      ON CONFLICT (email) DO UPDATE SET
        password   = EXCLUDED.password,
        created_at = NOW()
      RETURNING id`,
      [email, password]);
    this.log(`[db] saved ${email} (id=${rows[0]?.id})`);
    return true;
  }

  // pop account cu nhat con song (< 60p)
  async popAccount() {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`
      DELETE FROM ${this.table}
      WHERE id = (
        SELECT id FROM ${this.table}
        WHERE created_at > NOW() - INTERVAL '60 minutes'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING email, password`);
    return rows[0] || null;
  }

  // xoa het tk het han 60p
  async deleteExpired() {
    if (!this.pool) return 0;
    const { rowCount } = await this.pool.query(`
      DELETE FROM ${this.table}
      WHERE created_at <= NOW() - INTERVAL '60 minutes'`);
    return rowCount;
  }

  async count() {
    if (!this.pool) return 0;
    const { rows } = await this.pool.query(`
      SELECT COUNT(*)::int AS n FROM ${this.table}
      WHERE created_at > NOW() - INTERVAL '60 minutes'`);
    return rows[0]?.n || 0;
  }

  async close() {
    try { if (this.pool) await this.pool.end(); } catch (_) {}
  }
}

module.exports = { AccountDB };

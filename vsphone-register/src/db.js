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
    // bang chinh: luu account + api_token (de link sau khi pop)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id            BIGSERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password      TEXT,
        vstoken       TEXT,
        user_id       BIGINT,
        local_storage JSONB,
        api_token     TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

    // bang map: api_token -> gist_url (ton tai vinh vien, doc lap voi account)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vsphone_tokens (
        api_token  TEXT PRIMARY KEY,
        gist_url   TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  }

  /**
   * Luu account vao db.
   * apiToken va gistUrl duoc truyen vao de luu cung 1 lan.
   */
  async save(account, apiToken, gistUrl) {
    if (!this.pool) return false;
    const uid = account.userId == null ? null : Number(account.userId);
    const ls  = account.localStorage ? JSON.stringify(account.localStorage) : null;

    // luu account kem api_token
    const { rows } = await this.pool.query(`
      INSERT INTO ${this.table} (email, password, vstoken, user_id, local_storage, api_token)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT (email) DO UPDATE SET
        password      = EXCLUDED.password,
        vstoken       = EXCLUDED.vstoken,
        user_id       = EXCLUDED.user_id,
        local_storage = EXCLUDED.local_storage,
        api_token     = EXCLUDED.api_token,
        created_at    = NOW()
      RETURNING id`,
      [account.email, account.password || null, account.token || null,
       Number.isFinite(uid) ? uid : null, ls, apiToken]);

    // luu token -> gist_url (vinh vien, khong xoa theo account)
    await this.pool.query(`
      INSERT INTO vsphone_tokens (api_token, gist_url)
      VALUES ($1,$2) ON CONFLICT (api_token) DO NOTHING`,
      [apiToken, gistUrl]);

    this.log(`[db] saved ${account.email} (id=${rows[0]?.id})`);
    return true;
  }

  /**
   * Pop 1 account (lay ra + xoa luon).
   * Tra ve { email, password, vstoken, user_id, local_storage, api_token } hoac null.
   */
  async popAccount() {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`
      DELETE FROM ${this.table}
      WHERE id = (SELECT id FROM ${this.table} ORDER BY created_at ASC LIMIT 1)
      RETURNING email, password, vstoken, user_id, local_storage, api_token`);
    return rows[0] || null;
  }

  /** Lay gist_url tu api_token (bang ton tai vinh vien). */
  async getGistUrl(apiToken) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      'SELECT gist_url FROM vsphone_tokens WHERE api_token=$1', [apiToken]);
    return rows[0]?.gist_url || null;
  }

  /** So luong account con trong db. */
  async count() {
    if (!this.pool) return 0;
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${this.table}`);
    return rows[0]?.n || 0;
  }

  async close() {
    try { if (this.pool) await this.pool.end(); } catch (_) {}
  }
}

module.exports = { AccountDB };

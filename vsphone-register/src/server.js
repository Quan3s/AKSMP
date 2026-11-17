'use strict';

/**
 * vsphone-register — server.js
 *
 * WorkerPool: N browser workers chay song song, moi worker vong lap:
 *   1. spawn chromium (headless)
 *   2. dang ky tk -> luu email|password vao db
 *   3. KHONG dong browser -> giu trang thai login
 *   4. danh dau worker "ready"
 *   5. khi API goi -> SIGSTOP browser (freeze 5p) roi kill + spawn worker moi
 *   6. tk > 60p -> expire -> kill + xoa db + spawn moi
 *
 * API:
 *   GET /register?apikey=<key>
 *     -> { ok, account: "email|password" }
 *   GET /health
 *     -> { ok, ready, building, waiting, dbQueued }
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const { VSPhoneRegistrar, sleep } = require('./registrar');
const { createMailbox }           = require('./mailbox');
const { AccountDB }               = require('./db');

const ROOT = path.resolve(__dirname, '..');

// ── config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%&*?!';
  const req = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '@#$%&*?!',
  ].map(s => s[Math.floor(Math.random() * s.length)]);
  while (req.length < len) req.push(chars[Math.floor(Math.random() * chars.length)]);
  for (let i = req.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [req[i], req[j]] = [req[j], req[i]];
  }
  return req.join('');
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  return idx === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

// ── Worker ────────────────────────────────────────────────────────────────────
// state: 'building' | 'ready' | 'frozen' | 'dying'

let workerIdSeq = 0;

class Worker {
  constructor({ cfg, providers, db, pool, log }) {
    this.id        = ++workerIdSeq;
    this.cfg       = cfg;
    this.providers = providers;
    this.db        = db;
    this.pool      = pool;
    this.log       = (...a) => log(`[W${this.id}]`, ...a);
    this.state     = 'building';
    this.email     = null;
    this.password  = null;
    this.createdAt = null;
    this._reg      = null;
    this._expireTimer = null;
    this._freezeTimer = null;
  }

  async start() {
    try {
      await this._build();
    } catch (err) {
      this.log(`FAIL build: ${err.message}`);
      this.state = 'dying';
      await this._cleanup();
      await sleep(10000);
      this.pool.spawnWorker();
    }
  }

  async _build() {
    this.state = 'building';

    const reg = new VSPhoneRegistrar(
      { ...this.cfg, headless: true, autoCaptcha: this.cfg.autoCaptcha ?? true },
      this.log,
    );
    await reg.launch();
    this._reg = reg;

    // chon mailbox provider hoat dong
    let mailbox = null;
    for (const p of this.providers) {
      try {
        const mb = createMailbox({ ...(this.cfg.mailbox || {}), provider: p }, this.log);
        await mb.create();
        mailbox = mb;
        this.log(`mailbox OK: ${mb.address} (${p})`);
        break;
      } catch (e) {
        this.log(`mailbox ${p} loi: ${e.message}`);
      }
    }
    if (!mailbox) throw new Error('tat ca mailbox provider deu loi');

    const email    = mailbox.address;
    const password = genPassword(this.cfg.passwordLength || 12);
    this.log(`dang ky: ${email}`);

    // dang ky — khong luu localStorage, chi can email+password
    const account = await reg.registerOne({ email, password, mailbox });

    // luu vao db
    await this.db.save(account.email, account.password);

    this.email     = account.email;
    this.password  = account.password;
    this.createdAt = Date.now();
    this.state     = 'ready';
    this.log(`READY: ${this.email}`);

    // expire sau 60 phut
    this._expireTimer = setTimeout(() => this._onExpire(), 60 * 60 * 1000);

    // thong bao pool
    this.pool.onWorkerReady(this);
  }

  // duoc goi khi api lay tk nay
  async handoff() {
    if (this.state !== 'ready') return null;
    this.state = 'frozen';
    clearTimeout(this._expireTimer);

    const result = { email: this.email, password: this.password };
    this.log(`handoff ${this.email} -> SIGSTOP 5p`);

    this._freezeBrowser();

    // sau 5p kill han
    this._freezeTimer = setTimeout(() => this._onFreezeExpire(), 5 * 60 * 1000);

    // spawn worker moi ngay lap tuc
    this.pool.spawnWorker();

    return result;
  }

  _freezeBrowser() {
    try {
      if (this._reg?.browser) {
        const proc = this._reg.browser.process();
        if (proc?.pid) {
          process.kill(proc.pid, 'SIGSTOP');
          this.log(`SIGSTOP PID=${proc.pid}`);
        }
      }
    } catch (e) {
      this.log(`freeze err: ${e.message}`);
    }
  }

  _thawBrowser() {
    try {
      if (this._reg?.browser) {
        const proc = this._reg.browser.process();
        if (proc?.pid) {
          process.kill(proc.pid, 'SIGCONT');
          this.log(`SIGCONT PID=${proc.pid}`);
        }
      }
    } catch (_) {}
  }

  async _onFreezeExpire() {
    this.log('freeze 5p xong -> kill');
    this.state = 'dying';
    this._thawBrowser();
    await this._cleanup();
    // KHONG spawn moi o day — da spawn khi handoff
  }

  async _onExpire() {
    this.log('tk > 60p -> expire -> kill + spawn moi');
    this.state = 'dying';

    // xoa khoi pool._ready truoc khi cleanup
    this.pool.removeWorker(this);

    // xoa khoi db
    if (this.email) {
      try {
        await this.db.pool?.query(
          `DELETE FROM ${this.db.table} WHERE email=$1`, [this.email],
        );
      } catch (_) {}
    }

    await this._cleanup();
    this.pool.spawnWorker();
  }

  async _cleanup() {
    clearTimeout(this._expireTimer);
    clearTimeout(this._freezeTimer);
    try {
      this._thawBrowser();
      if (this._reg) await this._reg.close();
    } catch (_) {}
    this._reg = null;
  }
}

// ── WorkerPool ────────────────────────────────────────────────────────────────

class WorkerPool {
  constructor({ cfg, providers, db, maxWorkers, log }) {
    this.cfg        = cfg;
    this.providers  = providers;
    this.db         = db;
    this.maxWorkers = maxWorkers;
    this.log        = log;
    this._ready     = [];   // Worker[] san sang (state==='ready')
    this._building  = 0;    // so worker dang build
    this._waitQueue = [];   // [(resolve, reject)] cho tk
  }

  get readyCount()    { return this._ready.length; }
  get buildingCount() { return this._building; }
  get waitingCount()  { return this._waitQueue.length; }

  start() {
    for (let i = 0; i < this.maxWorkers; i++) this.spawnWorker();
  }

  spawnWorker() {
    // dem chinh xac: chi ready + building (frozen/dying khong tinh)
    const liveReady = this._ready.filter(w => w.state === 'ready').length;
    const total = liveReady + this._building;
    if (total >= this.maxWorkers) return;

    this._building++;
    const w = new Worker({
      cfg:       this.cfg,
      providers: this.providers,
      db:        this.db,
      pool:      this,
      log:       this.log,
    });
    w.start();
  }

  // Worker tu xoa minh khoi _ready khi expire
  removeWorker(worker) {
    const idx = this._ready.indexOf(worker);
    if (idx !== -1) this._ready.splice(idx, 1);
  }

  // callback tu Worker khi build xong -> state chuyen thanh 'ready'
  onWorkerReady(worker) {
    this._building = Math.max(0, this._building - 1);

    // co request dang cho -> phuc vu ngay
    if (this._waitQueue.length > 0) {
      const { resolve } = this._waitQueue.shift();
      worker.handoff().then(resolve);
      return;
    }

    this._ready.push(worker);
  }

  // lay tk: neu co san -> tra ngay, neu khong -> cho queue
  async acquire(timeoutMs = 300000) {
    // tim worker ready
    while (this._ready.length > 0) {
      const w = this._ready.shift();
      if (w.state === 'ready') {
        const result = await w.handoff();
        if (result) return result;
      }
    }

    // khong co -> vao queue
    this.log(`[pool] khong co tk san, them vao queue (#${this._waitQueue.length + 1})`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waitQueue.findIndex(e => e.reject === reject);
        if (idx !== -1) this._waitQueue.splice(idx, 1);
        reject(new Error('timeout waiting for account'));
      }, timeoutMs);
      this._waitQueue.push({
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject,
      });
    });
  }

  status() {
    return {
      ready:    this._ready.filter(w => w.state === 'ready').length,
      building: this._building,
      waiting:  this._waitQueue.length,
    };
  }

  async stopAll() {
    for (const w of [...this._ready]) {
      w.state = 'dying';
      await w._cleanup().catch(() => {});
    }
    this._ready = [];
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  const port = Number(process.env.PORT) || cfg.server?.port || 3000;

  const apiKeys = new Set([
    ...(cfg.server?.apiKeys || []),
    ...(process.env.API_KEYS ? process.env.API_KEYS.split(',').map(k => k.trim()) : []),
  ].filter(Boolean));

  if (apiKeys.size === 0) log('[server] CANH BAO: chua co API_KEYS');

  // db
  const db = new AccountDB({
    connectionString: process.env.DATABASE_URL || cfg.database?.connectionString || '',
    table: cfg.database?.table || 'vsphone_accounts',
    log,
  });
  await db.connect();

  // clear db cu khi khoi dong
  await db.pool?.query(`DELETE FROM ${db.table}`).catch(() => {});
  log('[db] cleared all old accounts');

  // mailbox providers
  const providers = cfg.mailbox?.providers?.length
    ? cfg.mailbox.providers
    : [cfg.mailbox?.provider || 'inboxkitten', 'mailtm', 'guerrillamail'];

  // headless -> co the spawn nhieu hon
  const maxWorkers = Number(process.env.MAX_WORKERS)
    || cfg.server?.maxParallel
    || 5;   // default tang len 5 vi headless nhe hon headed

  const pool = new WorkerPool({ cfg, providers, db, maxWorkers, log });
  pool.start();

  // xoa tk het han moi 5p (du phong, worker tu xu ly nhung truong hop chinh)
  setInterval(async () => {
    const n = await db.deleteExpired();
    if (n > 0) log(`[db] xoa ${n} tk het han (60p)`);
  }, 5 * 60 * 1000);

  // ── http server ───────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url      = req.url || '/';
    const query    = parseQuery(url);
    const pathname = url.split('?')[0];

    if (pathname === '/health' || pathname === '/ping') {
      const s = pool.status();
      return send(res, 200, { ok: true, ...s, dbQueued: await db.count() });
    }

    if (pathname !== '/register') {
      return send(res, 404, { ok: false, error: 'not found' });
    }

    // auth
    const key = req.headers['x-api-key'] || query.apikey || query.apiKey || '';
    if (apiKeys.size > 0 && !apiKeys.has(key)) {
      return send(res, 401, { ok: false, error: 'invalid api key' });
    }

    try {
      // acquire cho toi da 5p neu chua co tk
      const account = await pool.acquire(300000);
      return send(res, 200, {
        ok:      true,
        account: `${account.email}|${account.password}`,
      });
    } catch (err) {
      return send(res, 503, { ok: false, error: err.message, ...pool.status() });
    }
  });

  server.listen(port, () => {
    log(`[server] port=${port} | workers=${maxWorkers} | keys=${apiKeys.size}`);
  });

  const shutdown = async () => {
    log('[server] shutdown...');
    server.close();
    await pool.stopAll();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });

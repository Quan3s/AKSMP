'use strict';

/**
 * vsphone-register — API Server (multi-worker pool)
 *
 * POST/GET /register
 *   Header: x-api-key: <key>  hoac  ?apikey=<key>
 *
 * POST/GET /register?max=3   <- override so worker cho session nay
 *
 * GET /health  -> { ok, workers: [{id, busy}], queued }
 *
 * Config:
 *   server.maxParallel  trong config.json  (default 1)
 *   env MAX_PARALLEL    ghi de config
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { VSPhoneRegistrar, sleep } = require('./registrar');
const { createMailbox }           = require('./mailbox');

const ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────── helpers ────────────────────

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function genPassword(len = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const sym   = '@#$%&*?!';
  const all   = upper + lower + digit + sym;
  const pick  = (s) => s[Math.floor(Math.random() * s.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(sym)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ─────────────────────────────────────────────── worker pool ────────────────

class WorkerPool {
  /**
   * @param {object}   baseCfg    - config goc tu config.json
   * @param {number}   maxWorkers - so session browser toi da
   * @param {string[]} providers  - mailbox providers
   * @param {Function} log
   */
  constructor(baseCfg, maxWorkers, providers, log) {
    this.baseCfg    = baseCfg;
    this.maxWorkers = maxWorkers;
    this.providers  = providers;
    this.log        = log;

    // mang cac worker: { id, session: VSPhoneRegistrar|null, busy: bool }
    this.workers = Array.from({ length: maxWorkers }, (_, i) => ({
      id:      i + 1,
      session: null,
      busy:    false,
    }));

    // hang doi khi tat ca worker deu ban
    this.queue = [];
  }

  /** Khoi dong browser cho worker neu chua co. */
  async _ensureSession(worker) {
    if (worker.session) return;
    this.log(`[pool] worker #${worker.id} — khoi dong browser...`);
    const cfg = { ...this.baseCfg, headless: true, autoCaptcha: this.baseCfg.autoCaptcha ?? true };

    if (worker.id === 1) {
      // worker dau tien: browser rieng
      const registrar = new VSPhoneRegistrar(cfg, this.log);
      await registrar.launch();
      worker.session = registrar;
    } else {
      // cac worker sau: dung newSession() de share browser process
      // nhung moi worker co context + page rieng
      const first = this.workers[0].session;
      if (!first) throw new Error('worker #1 chua khoi dong');
      worker.session = await first.newSession();
    }
    this.log(`[pool] worker #${worker.id} san sang`);
  }

  /** Tim worker ranh, neu het thi tra null. */
  _freeWorker() {
    return this.workers.find((w) => !w.busy) || null;
  }

  /** Chay 1 task tao tai khoan tren worker cu the. */
  async _run(worker) {
    await this._ensureSession(worker);

    const cfg       = this.baseCfg;
    const provider  = this.providers[0];
    const mailbox   = createMailbox(
      { ...(cfg.mailbox || {}), provider },
      this.log,
    );
    const created  = await mailbox.create();
    const email    = created.address;
    const password = genPassword(cfg.passwordLength || 12);

    const account = await worker.session.registerOne({ email, password, mailbox });
    return {
      ok:           true,
      account:      `${account.email}|${account.password}`,
      localStorage: account.localStorage || {},
      worker:       worker.id,
    };
  }

  /**
   * Nhan 1 request:
   *  - neu co worker ranh -> chay ngay
   *  - neu het -> day vao queue, cho worker ranh
   */
  enqueue() {
    return new Promise((resolve, reject) => {
      const task = { resolve, reject };
      const worker = this._freeWorker();
      if (worker) {
        this._dispatch(worker, task);
      } else {
        this.log(`[pool] tat ca ${this.maxWorkers} worker deu ban — them vao hang doi (${this.queue.length + 1})`);
        this.queue.push(task);
      }
    });
  }

  /** Gan task cho worker va chay. */
  _dispatch(worker, task) {
    worker.busy = true;
    this.log(`[pool] worker #${worker.id} bat dau task (queue con lai: ${this.queue.length})`);

    this._run(worker)
      .then((result) => task.resolve(result))
      .catch((err)   => task.reject(err))
      .finally(() => {
        worker.busy = false;
        this.log(`[pool] worker #${worker.id} xong`);
        this._drain();
      });
  }

  /** Lay task tiep theo tu queue neu co worker ranh. */
  _drain() {
    if (this.queue.length === 0) return;
    const worker = this._freeWorker();
    if (!worker) return;
    const task = this.queue.shift();
    this._dispatch(worker, task);
  }

  status() {
    return {
      workers: this.workers.map((w) => ({ id: w.id, busy: w.busy, ready: !!w.session })),
      queued:  this.queue.length,
    };
  }

  async shutdown() {
    for (const w of this.workers) {
      if (w.session) {
        try { await w.session.close(); } catch (_) { /* ignore */ }
      }
    }
  }
}

// ─────────────────────────────────────────────── main ───────────────────────

async function main() {
  const cfg = loadConfig();

  const port       = Number(process.env.PORT)         || cfg.server?.port        || 3000;
  const maxWorkers = Number(process.env.MAX_PARALLEL) || cfg.server?.maxParallel || 1;

  const apiKeys = new Set(
    (cfg.server?.apiKeys || [])
      .concat(process.env.API_KEYS ? process.env.API_KEYS.split(',').map((k) => k.trim()) : [])
      .filter(Boolean),
  );

  if (apiKeys.size === 0) {
    console.error('[server] CANH BAO: chua co apiKey — moi request deu bi tu choi');
  }

  const regCfg = {
    ...cfg,
    headless:    true,
    autoCaptcha: cfg.autoCaptcha ?? true,
    mailbox: {
      ...(cfg.mailbox || {}),
      provider: cfg.mailbox?.provider || 'mailtm',
    },
  };

  const providers = cfg.mailbox?.providers?.length
    ? cfg.mailbox.providers
    : [regCfg.mailbox.provider, 'guerrillamail'].filter((v, i, a) => a.indexOf(v) === i);

  console.log(`[server] khoi dong pool ${maxWorkers} worker...`);
  const pool = new WorkerPool(regCfg, maxWorkers, providers, console.log);

  // khoi dong worker #1 ngay (cac worker khac lazy-init khi can)
  await pool._ensureSession(pool.workers[0]);

  // ── http server ──────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url      = req.url || '/';
    const query    = parseQuery(url);
    const pathname = url.split('?')[0];

    // health
    if (pathname === '/health' || pathname === '/ping') {
      return send(res, 200, { ok: true, ...pool.status() });
    }

    if (pathname !== '/register') {
      return send(res, 404, { ok: false, error: 'not found' });
    }

    // auth
    const key = req.headers['x-api-key'] || query.apikey || query.apiKey || '';
    if (apiKeys.size > 0 && !apiKeys.has(key)) {
      return send(res, 401, { ok: false, error: 'invalid api key' });
    }

    const st = pool.status();
    console.log(`[server] /register — workers busy: ${st.workers.filter((w) => w.busy).length}/${maxWorkers}, queued: ${st.queued}`);

    try {
      const result = await pool.enqueue();
      return send(res, 200, result);
    } catch (err) {
      console.error('[server] loi:', err.message);
      return send(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`[server] lang nghe port ${port} | ${maxWorkers} worker | apiKeys: ${apiKeys.size}`);
    console.log(`[server] POST/GET http://localhost:${port}/register`);
    console.log(`[server] GET       http://localhost:${port}/health`);
  });

  const shutdown = async () => {
    console.log('[server] dang tat...');
    server.close();
    await pool.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

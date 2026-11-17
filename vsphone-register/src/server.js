'use strict';

/**
 * vsphone-register — server.js
 *
 * Background loop: tao tk lien tuc (1 tk -> sleep 25s -> tiep).
 *   - thanh cong: luu postgres + tao github gist -> luu api_token
 *   - that bai: KHONG luu db, kill playwright, spawn lai sau sleep
 *
 * API:
 *   GET/POST /register?apikey=<key>
 *     -> { ok, account: "email|password", token: "<api_token>" }
 *     (account bi xoa khoi db ngay sau khi tra ve)
 *
 *   GET /token/<api_token>
 *     -> { ok, gist_url: "https://gist.githubusercontent.com/..." }
 *     (bang vsphone_tokens khong bi xoa, truy cap bat cu luc nao)
 *
 *   GET /health
 *     -> { ok, queued, loop }
 *
 * Env:
 *   DATABASE_URL   postgres connection string (Railway tu inject)
 *   GITHUB_TOKEN   PAT scope: gist
 *   API_KEYS       comma-separated
 *   PORT           default 3000
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { VSPhoneRegistrar, sleep } = require('./registrar');
const { createMailbox }           = require('./mailbox');
const { AccountDB }               = require('./db');
const { createGist }              = require('./gist');

const ROOT = path.resolve(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

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
  return idx === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

// ── background loop ───────────────────────────────────────────────────────────

class RegistrarLoop {
  constructor(cfg, db, providers, log) {
    this.cfg       = cfg;
    this.db        = db;
    this.providers = providers;
    this.log       = log;
    this.state     = 'stopped';
    this._reg      = null;
  }

  async _kill() {
    if (this._reg) {
      try { await this._reg.close(); } catch (_) {}
      this._reg = null;
    }
  }

  async _spawn() {
    await this._kill();
    const r = new VSPhoneRegistrar(
      { ...this.cfg, headless: true, autoCaptcha: this.cfg.autoCaptcha ?? true },
      this.log,
    );
    await r.launch();
    this._reg = r;
    return r;
  }

  async run() {
    this.state = 'running';
    while (this.state !== 'stopped') {
      try {
        this.state = 'running';
        const reg = await this._spawn();

        // chon mailbox provider theo failover
        let mailbox = null;
        let usedProvider = null;
        for (const p of this.providers) {
          try {
            const mb = createMailbox({ ...(this.cfg.mailbox || {}), provider: p }, this.log);
            await mb.create();
            mailbox      = mb;
            usedProvider = p;
            break;
          } catch (e) {
            this.log(`[loop] mailbox ${p} loi: ${e.message}`);
          }
        }
        if (!mailbox) throw new Error('Tat ca mailbox provider deu loi');

        const email    = mailbox.address;
        const password = genPassword(this.cfg.passwordLength || 12);
        this.log(`[loop] tao tk: ${email} (${usedProvider})`);

        // dang ky (neu loi se throw -> xuong catch -> kill + restart)
        const account = await reg.registerOne({ email, password, mailbox });

        // tao gist chua localStorage
        const apiToken = crypto.randomBytes(24).toString('hex');
        const gistUrl  = await createGist({
          email:        account.email,
          localStorage: account.localStorage,
        });

        // luu vao db (ca account lan token -> gist)
        await this.db.save(account, apiToken, gistUrl);
        this.log(`[loop] OK: ${account.email} token=${apiToken}`);

      } catch (err) {
        // FAIL -> kill playwright, KHONG luu db
        this.log(`[loop] FAIL (${err.message}) — kill playwright, restart sau sleep`);
        this.state = 'restarting';
        await this._kill();
      }

      // nghi 25s du thanh cong hay that bai
      if (this.state !== 'stopped') {
        this.log('[loop] sleep 25s...');
        await sleep(25000);
      }
    }
  }

  async stop() {
    this.state = 'stopped';
    await this._kill();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  const port = Number(process.env.PORT) || cfg.server?.port || 3000;

  const apiKeys = new Set([
    ...(cfg.server?.apiKeys || []),
    ...(process.env.API_KEYS ? process.env.API_KEYS.split(',').map((k) => k.trim()) : []),
  ].filter(Boolean));

  if (apiKeys.size === 0) log('[server] CANH BAO: chua co API_KEYS');

  // db
  const db = new AccountDB({
    connectionString: process.env.DATABASE_URL || cfg.database?.connectionString || '',
    table: cfg.database?.table || 'vsphone_accounts',
    log,
  });
  await db.connect();

  // providers
  const providers = cfg.mailbox?.providers?.length
    ? cfg.mailbox.providers
    : [cfg.mailbox?.provider || 'inboxkitten', 'mailtm', 'guerrillamail'];

  // start loop (non-blocking)
  const loop = new RegistrarLoop(cfg, db, providers, log);
  loop.run().catch((err) => log('[loop] FATAL:', err.message));

  // ── http server ───────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url      = req.url || '/';
    const query    = parseQuery(url);
    const pathname = url.split('?')[0];

    // /health
    if (pathname === '/health' || pathname === '/ping') {
      return send(res, 200, { ok: true, queued: await db.count(), loop: loop.state });
    }

    // /token/<48-char hex>
    const tokenMatch = pathname.match(/^\/token\/([a-f0-9]{48})$/);
    if (tokenMatch) {
      const gistUrl = await db.getGistUrl(tokenMatch[1]);
      if (!gistUrl) return send(res, 404, { ok: false, error: 'token not found' });
      return send(res, 200, { ok: true, gist_url: gistUrl });
    }

    // /register
    if (pathname !== '/register') return send(res, 404, { ok: false, error: 'not found' });

    // auth
    const key = req.headers['x-api-key'] || query.apikey || query.apiKey || '';
    if (apiKeys.size > 0 && !apiKeys.has(key)) {
      return send(res, 401, { ok: false, error: 'invalid api key' });
    }

    // pop account (lay ra + xoa db ngay)
    const row = await db.popAccount();
    if (!row) {
      return send(res, 503, {
        ok:    false,
        error: 'no accounts available yet, loop is building',
        loop:  loop.state,
      });
    }

    return send(res, 200, {
      ok:      true,
      account: `${row.email}|${row.password}`,
      token:   row.api_token || null,
    });
  });

  server.listen(port, () => {
    log(`[server] port=${port} | loop=running | db=${db.enabled ? 'ON' : 'OFF'} | keys=${apiKeys.size}`);
  });

  const shutdown = async () => {
    log('[server] shutdown...');
    server.close();
    await loop.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error('[FATAL]', err); process.exit(1); });

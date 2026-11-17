'use strict';

/**
 * vsphone-register — API Server mode
 *
 * POST /register  (hoac GET /register)
 *   Header: x-api-key: <key>
 *   hoac Query: ?apikey=<key>
 *
 * Response 200:
 *   {
 *     "ok": true,
 *     "email": "...",
 *     "password": "...",
 *     "token": "...",
 *     "userId": "...",
 *     "localStorage": { ...toan bo keys tu browser... },
 *     "createdAt": "..."
 *   }
 *
 * Response 4xx/5xx:
 *   { "ok": false, "error": "..." }
 *
 * Khong luu gi ca — tat ca tra thang ve response.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { VSPhoneRegistrar, sleep } = require('./registrar');
const { createMailbox } = require('./mailbox');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- config ----
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

// ---------------------------------------------------------------- http helpers ----
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

// ---------------------------------------------------------------- queue ----
// Moi request chay tuan tu (1 browser, 1 viec 1 luc).
// Neu muon parallel thi can nhieu browser instance — de don gian: queue.
let busy = false;
const queue = [];

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drainQueue();
  });
}

async function drainQueue() {
  if (busy || queue.length === 0) return;
  busy = true;
  const { task, resolve, reject } = queue.shift();
  try {
    resolve(await task());
  } catch (err) {
    reject(err);
  } finally {
    busy = false;
    drainQueue();
  }
}

// ---------------------------------------------------------------- main ----
async function main() {
  const cfg = loadConfig();
  const port = cfg.server?.port || Number(process.env.PORT) || 3000;
  const apiKeys = new Set(
    (cfg.server?.apiKeys || []).concat(
      process.env.API_KEYS ? process.env.API_KEYS.split(',').map((k) => k.trim()) : []
    ).filter(Boolean)
  );

  if (apiKeys.size === 0) {
    console.error('[server] CANH BAO: chua co apiKey nao trong config.server.apiKeys — moi request deu bi tu choi');
  }

  // Build cfg cho registrar (headless bat buoc khi chay server)
  const regCfg = {
    ...cfg,
    headless: true,
    autoCaptcha: cfg.autoCaptcha ?? true,
    mailbox: {
      ...(cfg.mailbox || {}),
      provider: cfg.mailbox?.provider || 'mailtm',
    },
  };
  const providers = cfg.mailbox?.providers?.length
    ? cfg.mailbox.providers
    : [regCfg.mailbox.provider, 'guerrillamail'].filter((v, i, a) => a.indexOf(v) === i);

  // Khoi dong 1 browser duy nhat, tai su dung cho moi request
  const registrar = new VSPhoneRegistrar(regCfg, console.log);
  await registrar.launch();
  console.log(`[server] browser da khoi dong`);

  // ---- xu ly 1 request tao tai khoan ----
  async function handleRegister() {
    const provider = providers[0];
    const mailbox  = createMailbox({ ...regCfg.mailbox, provider }, console.log);
    const created  = await mailbox.create();
    const email    = created.address;
    const password = genPassword(regCfg.passwordLength || 12);

    const account = await registrar.registerOne({ email, password, mailbox });
    // account = { email, password, token, userId, localStorage, createdAt }
    return {
      ok: true,
      account: `${account.email}|${account.password}`,
      localStorage: account.localStorage || {},
    };
  }

  // ---- http server ----
  const server = http.createServer(async (req, res) => {
    const url   = req.url || '/';
    const query = parseQuery(url);
    const pathname = url.split('?')[0];

    // health check
    if (pathname === '/health' || pathname === '/ping') {
      return send(res, 200, { ok: true, busy, queued: queue.length });
    }

    if (pathname !== '/register') {
      return send(res, 404, { ok: false, error: 'not found' });
    }

    // xac thuc apikey
    const key = req.headers['x-api-key'] || query.apikey || query.apiKey || '';
    if (apiKeys.size > 0 && !apiKeys.has(key)) {
      return send(res, 401, { ok: false, error: 'invalid api key' });
    }

    console.log(`[server] /register request (busy=${busy}, queued=${queue.length})`);

    try {
      const result = await enqueue(handleRegister);
      return send(res, 200, result);
    } catch (err) {
      console.error('[server] loi khi tao tai khoan:', err.message);
      return send(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`[server] dang lang nghe tren port ${port}`);
    console.log(`[server] apiKeys: ${apiKeys.size > 0 ? [...apiKeys].join(', ') : '(chua co - tat ca bi tu choi)'}`);
    console.log(`[server] POST/GET http://localhost:${port}/register`);
    console.log(`[server] Header: x-api-key: <key>  hoac  ?apikey=<key>`);
  });

  // graceful shutdown
  const shutdown = async () => {
    console.log('[server] dang tat...');
    server.close();
    await registrar.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

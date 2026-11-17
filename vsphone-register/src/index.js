'use strict';

const fs = require('fs');
const path = require('path');
const { VSPhoneRegistrar, sleep } = require('./registrar');
const { createMailbox } = require('./mailbox');
const { AccountDB } = require('./db');

const ROOT = path.resolve(__dirname, '..');

function log(...args) {
  console.log(...args);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return cfg;
}

function genPassword(len = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const sym = '@#$%&*?!';
  const all = upper + lower + digit + sym;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(sym)];
  while (chars.length < len) chars.push(pick(all));
  // shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function saveAccount(outDir, account) {
  ensureDir(outDir);
  const jsonFile = path.join(outDir, 'accounts.json');
  let list = [];
  if (fs.existsSync(jsonFile)) {
    try {
      list = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    } catch (_) {
      list = [];
    }
  }
  list.push(account);
  fs.writeFileSync(jsonFile, JSON.stringify(list, null, 2));

  // dinh dang "mail|mk": email|mật khẩu - moi tai khoan 1 dong
  const txtFile = path.join(outDir, 'accounts.txt');
  fs.appendFileSync(txtFile, `${account.email}|${account.password}\n`);

  const csvFile = path.join(outDir, 'accounts.csv');
  const header = 'email,password,token,userId,createdAt';
  const line = [
    account.email,
    account.password,
    account.token || '',
    account.userId || '',
    account.createdAt,
  ]
    .map((v) => `"${String(v).replace(/"/g, '""')}"`)
    .join(',');
  if (!fs.existsSync(csvFile)) fs.writeFileSync(csvFile, header + '\n');
  fs.appendFileSync(csvFile, line + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();

  const count = Number(args.count || cfg.count || 1);
  const headless = args.headless ? true : args.headed ? false : !!cfg.headless;
  const delayMs = Number(args.delay ?? cfg.delayMs ?? 25000);
  const delayJitter = Number(args.jitter ?? cfg.delayJitterMs ?? 10000);
  const password = args.password || null;
  const outDir = path.resolve(ROOT, args.out || cfg.output?.dir || 'output');
  const dryRun = !!args['dry-run'];
  const simulate = !!args.simulate;
  const parallel = Math.max(1, Number(args.parallel || cfg.parallel || 1));

  const autoCaptcha = args.manual ? false : args['no-auto-captcha'] ? false : (cfg.autoCaptcha ?? true);
  const powDelay = Number(args['pow-delay'] ?? cfg.powDelay ?? 6000);
  const saveDebug = !!args['save-debug'] || !!cfg.saveDebug;
  const debug = !!args.debug || !!cfg.debug;

  cfg.loginUrl = args.url || cfg.loginUrl || 'https://cloud.vsphone.com/login';
  cfg.headless = headless;
  cfg.captchaTimeoutMs = Number(args['captcha-timeout'] ?? cfg.captchaTimeoutMs ?? 300000);
  cfg.mailTimeoutMs = Number(args['mail-timeout'] ?? cfg.mailTimeoutMs ?? 180000);
  cfg.slowMo = Number(args.slowmo ?? cfg.slowMo ?? 0);
  cfg.autoCaptcha = autoCaptcha;
  cfg.powDelay = powDelay;
  cfg.saveDebug = saveDebug;
  cfg.debug = debug;
  cfg.mailbox = {
    ...(cfg.mailbox || {}),
    provider: args.provider || cfg.mailbox?.provider || 'mailtm',
    domain: args.domain || cfg.mailbox?.domain || '',
    inboxkittenApiBase: cfg.mailbox?.inboxkittenApiBase || 'https://inboxkitten.com/api/v1/mail',
    inboxkittenDomain: args.ikdomain || cfg.mailbox?.inboxkittenDomain || 'inboxkitten.com',
  };
  // danh sach provider de failover: neu domain cu bi chan, thu provider tiep theo
  const providers = args.provider
    ? [args.provider]
    : cfg.mailbox.providers && cfg.mailbox.providers.length
      ? cfg.mailbox.providers
      : [cfg.mailbox.provider, 'guerrillamail'].filter((v, i, a) => a.indexOf(v) === i);

  // PostgreSQL
  const dbCfg = {
    ...(cfg.database || {}),
    connectionString: args['db-url'] || cfg.database?.connectionString || process.env.DATABASE_URL || '',
    table: args['db-table'] || cfg.database?.table || 'vsphone_accounts',
  };
  const useDb = !!args.db || !!dbCfg.enabled || !!dbCfg.connectionString;

  log('=====================================================');
  log('  VSPhone auto-register (integrated Aliyun Captcha Solver)');
  log(`  so tai khoan: ${count} | headless: ${headless} | delay: ${delayMs}ms | song song: ${parallel}`);
  log(`  captcha solver: ${autoCaptcha ? 'AUTO (vlolhaha/vmos)' : 'MANUAL'}${autoCaptcha ? ` (powDelay: ${powDelay}ms)` : ''}`);
  log(`  mailbox: ${providers.join(' -> ')}${cfg.mailbox.domain ? ' @' + cfg.mailbox.domain : ''}`);
  log(`  output: ${outDir}`);
  log(`  postgres: ${useDb ? dbCfg.table : 'off'}`);
  log('=====================================================');

  const registrar = new VSPhoneRegistrar(cfg, log);
  if (!simulate) await registrar.launch();
  let db = null;
  if (useDb) {
    db = new AccountDB(dbCfg, log);
    try {
      await db.connect();
    } catch (err) {
      log(`[!] Khong ket noi duoc PostgreSQL: ${err.message}`);
      db = null;
    }
  }

  let ok = 0;
  let failed = 0;
  const results = [];

  /** Xu ly 1 tai khoan (dung chung cho ca che do sequential va song song). */
  async function processOne(index, session, slot) {
    log(`\n--- [${index + 1}/${count}]${slot ? ` (slot ${slot})` : ''} ---`);
    const provider = providers[index % providers.length];
    const mailbox = createMailbox({ ...cfg.mailbox, provider }, log);
    let account = null;
    try {
      const created = await mailbox.create();
      const email = created.address;
      const pwd = password || genPassword(cfg.passwordLength || 12);

      if (dryRun) {
        const isNew = await session.checkEmail(email);
        log(`[dry-run] ${email} -> checkEmail data=${isNew} (true = chua ton tai)`);
        results.push({ email, password: pwd, status: isNew ? 'available' : 'exists' });
        ok++;
      } else if (simulate) {
        // khuong thu luu duong (khong goi website) - dung de test pipeline file + DB
        account = {
          email,
          password: pwd,
          token: 'simulated_token',
          userId: '0',
          createdAt: new Date().toISOString(),
        };
        saveAccount(outDir, account);
        if (db) await db.save(account).catch((err) => log(`[!] Luu PostgreSQL that bai: ${err.message}`));
        results.push({ ...account, status: 'success' });
        log(`[simulate] da ghi "${email}|${pwd}"`);
        ok++;
      } else {
        account = await session.registerOne({ email, password: pwd, mailbox });
        saveAccount(outDir, account);
        if (db) {
          try {
            await db.save(account);
          } catch (err) {
            log(`[!] Luu PostgreSQL that bai: ${err.message}`);
          }
        }
        results.push({ ...account, status: 'success' });
        ok++;
      }
    } catch (err) {
      failed++;
      log(`[!] Loi: ${err.message}`);
      results.push({ email: mailbox.address, status: 'failed', error: err.message });
      await sleep(3000);
    }
  }

  try {
    if (parallel > 1 && !simulate) {
      // ---- che do song song: moi slot 1 cua so, 1 popup slider ----
      log(`[*] Chay song song ${parallel} cua so - moi cua so 1 popup slider, xoay vong keo`);
      const sessions = [];
      for (let s = 0; s < parallel; s++) sessions.push(await registrar.newSession());
      let cursor = 0;
      const workers = sessions.map(async (session, slot) => {
        while (cursor < count) {
          const index = cursor++;
          await processOne(index, session, slot + 1);
          if (cursor < count && !dryRun) {
            const wait = delayMs + Math.floor(Math.random() * delayJitter);
            log(`[*] slot ${slot + 1}: nghi ${Math.round(wait / 1000)}s truoc tai khoan tiep theo`);
            await sleep(wait);
          }
        }
      });
      await Promise.all(workers);
    } else {
      for (let i = 0; i < count; i++) {
        await processOne(i, registrar, 0);
        if (i < count - 1 && !dryRun) {
          const wait = delayMs + Math.floor(Math.random() * delayJitter);
          log(`[*] Nghi ${Math.round(wait / 1000)}s truoc khi tao tai khoan tiep theo...`);
          await sleep(wait);
        }
      }
    }
  } finally {
    if (!args['keep-open']) {
      if (!simulate) await registrar.close();
    } else {
      log('[*] Giu browser mo (--keep-open)');
    }
    if (db) {
      try {
        log(`[db] tong so tai khoan trong bang: ${await db.count()}`);
      } catch (_) {
        /* ignore */
      }
      await db.close();
    }
  }

  log('\n=====================================================');
  log(`  Ket qua: ${ok} thanh cong / ${failed} that bai`);
  log('=====================================================');
  if (results.some((r) => r.status !== 'success')) {
    log(JSON.stringify(results.filter((r) => r.status !== 'success'), null, 2));
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

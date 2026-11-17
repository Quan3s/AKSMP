'use strict';

const { chromium } = require('playwright');
const { solveAliyunPuzzle, attachImageCollector } = require('./aliyun-captcha');

const SEL = {
  email: 'input[placeholder="Please enter your email address"]',
  code: 'input[placeholder="Please enter the verification code"]',
  password: 'input[placeholder="Please enter your login password"]',
  invite: 'input[placeholder="Please enter the invitation code"]',
  getCode: '#get-captcha-code',
  submit: 'button.submit-button',
  tos: '.tos label.el-checkbox',
  tosInput: 'input[type="checkbox"].el-checkbox__original',
  captchaWindow: '#aliyunCaptcha-window-popup',
  captchaMask: '#aliyunCaptcha-mask',
};

const API = {
  checkEmail: '/api/user/checkEmail',
  smsSend: '/api/sms/smsSend',
  login: '/api/user/login',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** VSPhone tra code 1014 khi tan so qua nhanh (rate-limit). */
function isRateLimited(res) {
  if (!res) return false;
  return res.code === 1014 || res.code === 500 || /too frequent/i.test(String(res.msg || ''));
}

class VSPhoneRegistrar {
  constructor(cfg, log = console.log) {
    this.cfg = cfg;
    this.log = log;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: !!this.cfg.headless,
      slowMo: this.cfg.slowMo || 0,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    this.page = await this.context.newPage();
    this.imageBuffers = { back: null, shadow: null, backAt: 0, shadowAt: 0 };
    attachImageCollector(this.page, this.imageBuffers, !!this.cfg.debug, this.log);
    return this.page;
  }

  async close() {
    try {
      if (this.browser) await this.browser.close();
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Mo them 1 cua so browser (context rieng) de chay song song.
   * Moi cua so co 1 popup captcha rieng -> nguoi dung xoay vong keo slider.
   */
  async newSession() {
    if (!this.browser) await this.launch();
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    const session = Object.create(VSPhoneRegistrar.prototype);
    session.cfg = this.cfg;
    session.log = this.log;
    session.browser = this.browser;
    session.context = context;
    session.page = page;
    session.imageBuffers = { back: null, shadow: null, backAt: 0, shadowAt: 0 };
    attachImageCollector(page, session.imageBuffers, !!this.cfg.debug, this.log);
    return session;
  }

  /** Cho doi mot response API khop pattern (tra ve {code,msg,data}). */
  waitForApi(path, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout ${timeoutMs}ms cho ${path}`));
      }, timeoutMs);
      const onResponse = async (res) => {
        if (!res.url().includes(path)) return;
        try {
          // bo qua preflight CORS / request khong phai API that
          const method = res.request().method();
          if (method === 'OPTIONS') return;
          const text = await res.text();
          if (this.cfg && this.cfg.debug) {
            this.log(`[api] ${method} ${res.status()} ${res.url()} :: ${text.slice(0, 300)}`);
          }
          const json = JSON.parse(text);
          if (!json || typeof json !== 'object') return;
          cleanup();
          resolve(json);
        } catch (err) {
          // body rong hoac khong phai JSON -> bo qua, tiep tuc cho
          if (this.cfg && this.cfg.debug) {
            this.log(`[api] bo qua response khong phai JSON (${err.message})`);
          }
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.page.off('response', onResponse);
      };
      this.page.on('response', onResponse);
    });
  }

  /** Doc toast/loi dang hien tren trang (dung khi login that bai). */
  async readPageError() {
    return this.page
      .evaluate(() => {
        const selectors = [
          '.el-message--error',
          '.el-message',
          '.el-form-item__error',
          '.el-notification',
          '[class*="toast"]',
        ];
        for (const sel of selectors) {
          const el = [...document.querySelectorAll(sel)].find(
            (e) => e.offsetParent !== null && (e.innerText || '').trim(),
          );
          if (el) return el.innerText.trim().replace(/\s+/g, ' ').slice(0, 300);
        }
        return '';
      })
      .catch(() => '');
  }

  /** Go tung ky tu (Vue/Element UI doi khi bo qua su kien go phim cua fill). */
  async typeInto(selector, value, delay = 45) {
    const page = this.page;
    await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(selector, value, { delay });
  }

  async dumpInputs(label = 'form') {
    if (!this.cfg.debug) return;
    try {
      const inputs = await this.page.evaluate(() =>
        [...document.querySelectorAll('input')].map((i) => ({
          ph: i.placeholder,
          value: i.value,
          visible: i.offsetParent !== null,
          type: i.type,
        })),
      );
      this.log(`[${label}] ${JSON.stringify(inputs)}`);
    } catch (_) {
      /* ignore */
    }
  }

  async ensureTosChecked() {
    const page = this.page;
    try {
      await page.waitForSelector(SEL.tosInput, { state: 'attached', timeout: 10000 });
      const checked = await page.$eval(SEL.tosInput, (el) => el.checked);
      if (!checked) {
        await page.click(SEL.tos);
        await sleep(300);
      }
    } catch (err) {
      this.log(`[tos] khong tim thay checkbox: ${err.message}`);
    }
  }

  /** Buoc 1: kiem tra email da ton tai hay chua (khong can captcha). */
  async checkEmail(email) {
    await this.page.goto(this.cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForSelector(SEL.email, { timeout: 30000 });
    await this.page.fill(SEL.email, email);
    await this.ensureTosChecked();
    const p = this.waitForApi(API.checkEmail, 30000);
    await this.page.click(SEL.submit);
    const res = await p;
    if (res.code !== 200) throw new Error(`checkEmail loi: ${JSON.stringify(res)}`);
    return res.data === true; // true => email chua ton tai => can dang ky moi
  }

  /**
   * Mo popup captcha Aliyun.
   * Luu y: SDK Aliyun can thoi gian load, bam "Get code" som se bi loi
   * "Failed to load the captcha component" -> tool doi chieu cho popup xuat hien.
   */
  async openCaptcha({ attempts = 4 } = {}) {
    const page = this.page;
    const log = this.log;

    // cho SDK tao xong DOM cua captcha
    try {
      await page.waitForSelector(SEL.captchaWindow, { state: 'attached', timeout: 25000 });
    } catch (_) {
      log('[captcha] SDK Aliyun chua san sang, van thu tiep');
    }

    for (let i = 1; i <= attempts; i++) {
      // dong hop thoai loi neu co
      try {
        const okBtn = page.locator('.el-message-box__btns .el-button').last();
        if (await okBtn.count()) {
          await okBtn.click({ timeout: 2000 });
          await sleep(300);
        }
      } catch (_) {
        /* ignore */
      }

      await page.click(SEL.getCode, { timeout: 10000 }).catch((e) => log(`[captcha] click loi: ${e.message}`));
      await sleep(2500);

      const state = await page
        .evaluate(
          (sel) => {
            const w = document.querySelector(sel.captchaWindow);
            return { exists: !!w, hidden: w ? w.className.includes('aliyunCaptcha-hidden') : null };
          },
          { captchaWindow: SEL.captchaWindow },
        )
        .catch(() => ({ exists: false, hidden: null }));

      if (state.exists && !state.hidden) {
        log(`[captcha] popup captcha da mo (lan ${i})`);
        return true;
      }
      log(`[captcha] popup chua mo, thu lai (lan ${i})`);
    }
    throw new Error('Khong mo duoc popup captcha Aliyun');
  }

  /** 1 lan goi checkEmail (khong retry). Tra {code, data}. */
  async checkEmailOnce(email) {
    const page = this.page;
    await page.goto(this.cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(SEL.email, { timeout: 30000 });
    await page.fill(SEL.email, email);
    await this.ensureTosChecked();
    const pCheck = this.waitForApi(API.checkEmail, 30000);
    await page.click(SEL.submit);
    return pCheck;
  }

  /**
   * Kiem tra email co ton tai hay khong, tu retry khi VSPhone tra code 1014
   * ("Your operations are too frequent").
   */
  async checkEmail(email, { retries = 5, baseDelayMs = 60000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const res = await this.checkEmailOnce(email);
      if (res && res.code === 200) return res.data === true;
      if (isRateLimited(res)) {
        const wait = baseDelayMs * attempt;
        this.log(`[rate-limit] server chan tan so (code ${res.code}), nghi ${Math.round(wait / 1000)}s roi thu lai (${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      throw new Error(`checkEmail loi: ${JSON.stringify(res)}`);
    }
    throw new Error('VSPhone chan tan so lien tuc (code 1014) - dung lai lau hon');
  }

  /**
   * Dang ky 1 tai khoan.
   * - email: dia chi se dung
   * - password: mat khau (6-20 ky tu)
   * - mailbox: provider co waitForCode()
   */
  async registerOne({ email, password, mailbox }) {
    const page = this.page;
    const log = this.log;

    log(`[*] Dang ky: ${email}`);

    // --- buoc 1: check email (co retry khi bi rate-limit)
    const isNew = await this.checkEmail(email);
    if (!isNew) throw new Error('Email da ton tai tren VSPhone');

    // --- buoc 2: form dang ky xuat hien
    await page.waitForSelector(SEL.getCode, { timeout: 20000 });

    // --- buoc 3: bam "Get code" -> Aliyun slider captcha
    let sms = null;
    const autoSolve = this.cfg.autoCaptcha !== false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const pSms = this.waitForApi(API.smsSend, this.cfg.captchaTimeoutMs);
      await this.openCaptcha();

      if (autoSolve) {
        log(`[*] Dang tu dong giai captcha Aliyun bang solver tu vlolhaha/vmos (lan ${attempt}/3)...`);
        try {
          const solved = await solveAliyunPuzzle(page, this.imageBuffers, log, {
            maxAttempts: 3,
            powDelay: this.cfg.powDelay ?? 6000,
            saveDebug: !!this.cfg.saveDebug,
          });
          if (!solved.success) {
            log(`[!] Auto-solver chua giai duoc: ${solved.reason || 'that bai'}`);
          }
        } catch (solveErr) {
          log(`[!] Loi trong qua trinh auto solve: ${solveErr.message}`);
        }
      } else {
        log('[*] Che do thu cong: hay keo slider de gui ma...');
      }

      sms = await pSms.catch((e) => {
        log(`[captcha] Cho smsSend timeout/loi: ${e.message}`);
        return null;
      });

      if (sms && sms.code === 200) break;
      if (isRateLimited(sms)) {
        const wait = 60000 * attempt;
        log(`[rate-limit] chan tan so khi gui ma, nghi ${Math.round(wait / 1000)}s roi mo lai captcha`);
        await sleep(wait);
        continue;
      }
      log(`[captcha] Lan ${attempt} chua nhan duoc ma hop le, thu lai...`);
    }
    if (!sms || sms.code !== 200) throw new Error('Khong gui duoc ma xac thuc sau 3 lan giai captcha');
    log(`[*] Da gui ma xac thuc (isRegister=${sms.isRegister})`);

    // --- buoc 4: lay ma 6 so tu mailbox
    const code = await mailbox.waitForCode({ timeoutMs: this.cfg.mailTimeoutMs });
    await this.typeInto(SEL.code, code);
    await this.typeInto(SEL.password, password);
    await this.ensureTosChecked();
    await this.dumpInputs('form');

    // --- buoc 5: submit -> login
    // Luu y: response cua /api/user/login co the bi mat body do browser
    // navigate ngay sau khi server tra ve -> khong doi JSON, doi token trong
    // localStorage giong cach bot vmos lam.
    await page.click(SEL.submit);

    let token = null;
    let userId = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      token = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
      userId = await page.evaluate(() => localStorage.getItem('userId')).catch(() => null);
      if (token) break;
      const pageError = await this.readPageError();
      if (pageError) throw new Error(`Dang nhap that bai: ${pageError}`);
      await sleep(1000);
    }

    if (!token) {
      const pageError = await this.readPageError();
      throw new Error(
        `Dang nhap that bai: khong thay token trong localStorage${pageError ? ` (${pageError})` : ''}`,
      );
    }

    // dump TOAN BO localStorage de tra ve qua API (khong luu gi ca)
    const localStorage_ = await page
      .evaluate(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          // thu parse JSON, neu loi thi giu nguyen string
          try { out[k] = JSON.parse(v); } catch (_) { out[k] = v; }
        }
        return out;
      })
      .catch(() => ({}));

    if (!userId) {
      // fallback: lay tu localStorage_ neu co
      userId = localStorage_.userId
        || (Array.isArray(localStorage_.users) && localStorage_.users[0]?.userId
            ? String(localStorage_.users[0].userId) : null)
        || null;
    }

    log(`[+] Dang ky thanh cong: ${email} (localStorage keys: ${Object.keys(localStorage_).join(', ')})`);
    return {
      email,
      password,
      token: token || null,
      userId: userId ? String(userId) : null,
      localStorage: localStorage_,
      createdAt: new Date().toISOString(),
    };
  }
}

module.exports = { VSPhoneRegistrar, SEL, API, sleep, isRateLimited };

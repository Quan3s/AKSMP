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
  checkEmail: '/vsphone/api/user/checkEmail',
  smsSend: '/vsphone/api/sms/smsSend',
  login: '/vsphone/api/user/login',
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

  /**
   * Dang ky lang nghe response NGAY (non-async, tra ve Promise).
   * Goi truoc khi trigger action de tranh race condition khi page navigate.
   *
   * Dung page.on('response') + doc body NGAY TRONG CALLBACK truoc khi page navigate.
   * Khong dung waitForResponse().then(res => res.text()) vi body bi giai phong sau navigate.
   */
  waitForApi(path, timeoutMs) {
    const cfg = this.cfg;
    const log = this.log;
    const page = this.page;

    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        page.off('response', handler);
        reject(new Error(`Timeout ${timeoutMs}ms cho ${path}`));
      }, timeoutMs);

      const handler = async (res) => {
        if (done) return;
        if (!res.url().includes(path)) return;
        if (res.request().method() === 'OPTIONS') return;

        // Doc body NGAY trong callback — truoc khi bat ky navigation nao xay ra
        let text;
        try {
          const buf = await res.body(); text = buf.toString('utf8');
        } catch (e) {
          // body mat roi (trang da navigate) — thu tiep lan sau
          if (cfg && cfg.debug) log(`[api] body mat (navigate?): ${e.message}`);
          return;
        }

        if (!text || !text.trim().startsWith('{')) return; // khong phai JSON

        done = true;
        clearTimeout(timer);
        page.off('response', handler);

        if (cfg && cfg.debug) {
          log(`[api] ${res.request().method()} ${res.status()} ${res.url()} :: ${text.slice(0, 300)}`);
        }

        try {
          const json = JSON.parse(text);
          if (!json || typeof json !== 'object') {
            return reject(new Error(`response khong phai JSON object (${path})`));
          }
          resolve(json);
        } catch (err) {
          reject(new Error(`Parse response loi (${path}): ${err.message} | raw: ${text.slice(0,100)}`));
        }
      };

      page.on('response', handler);
    });
  }

  /**
   * Dung page.route() de intercept va doc body TRUOC khi browser nhan response
   * (tranh race condition khi page navigate ngay sau login).
   * Goi truoc khi trigger action. Sau khi lay duoc data, tu dong unroute.
   */
  waitForApiRoute(urlPattern) {
    const log = this.log;
    const page = this.page;
    return new Promise((resolve, reject) => {
      let done = false;
      const routeHandler = async (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') { return route.continue(); }
        // forward request va lay response
        let resp;
        try {
          resp = await route.fetch();
        } catch (e) {
          if (!done) reject(e);
          done = true;
          return route.abort();
        }
        // doc body truoc khi fulfill (body van con vi chua navigate)
        let body;
        try {
          body = await resp.body();
        } catch (e) {
          await route.fulfill({ response: resp });
          if (!done) reject(new Error('route body err: ' + e.message));
          done = true;
          return;
        }
        // forward response ve browser binh thuong
        await route.fulfill({ response: resp, body });
        if (done) return;
        const text = body.toString('utf8');
        if (!text || !text.trim().startsWith('{')) return;
        done = true;
        page.unroute(urlPattern, routeHandler);
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('parse loi: ' + e.message));
        }
      };
      page.route(urlPattern, routeHandler).catch(reject);
    });
  }

  /** Doc toast/loi dang hien tren trang. */
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

  /** 1 lan goi checkEmail (khong retry). */
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

  async checkEmail(email, { retries = 5, baseDelayMs = 60000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const res = await this.checkEmailOnce(email);
      if (res && res.code === 200) return res.data === true;
      if (isRateLimited(res)) {
        const wait = baseDelayMs * attempt;
        this.log(`[rate-limit] code ${res.code}, nghi ${Math.round(wait / 1000)}s (${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      throw new Error(`checkEmail loi: ${JSON.stringify(res)}`);
    }
    throw new Error('VSPhone chan tan so lien tuc (1014)');
  }

  async openCaptcha({ attempts = 4 } = {}) {
    const page = this.page;
    const log = this.log;

    try {
      await page.waitForSelector(SEL.captchaWindow, { state: 'attached', timeout: 25000 });
    } catch (_) {
      log('[captcha] SDK Aliyun chua san sang, van thu tiep');
    }

    for (let i = 1; i <= attempts; i++) {
      try {
        const okBtn = page.locator('.el-message-box__btns .el-button').last();
        if (await okBtn.count()) {
          await okBtn.click({ timeout: 2000 });
          await sleep(300);
        }
      } catch (_) {}

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
        log(`[captcha] popup mo (lan ${i})`);
        return true;
      }
      log(`[captcha] popup chua mo, thu lai (lan ${i})`);
    }
    throw new Error('Khong mo duoc popup captcha Aliyun');
  }

  /**
   * Dang ky 1 tai khoan.
   * Khong doc/ghi localStorage — verify login qua API response.
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
        log(`[*] Auto giai captcha (lan ${attempt}/3)...`);
        try {
          const solved = await solveAliyunPuzzle(page, this.imageBuffers, log, {
            maxAttempts: 3,
            powDelay: this.cfg.powDelay ?? 6000,
            saveDebug: !!this.cfg.saveDebug,
          });
          if (!solved.success) log(`[!] Solver chua giai duoc: ${solved.reason || 'that bai'}`);
        } catch (solveErr) {
          log(`[!] Loi auto solve: ${solveErr.message}`);
        }
      } else {
        log('[*] Thu cong: hay keo slider...');
      }

      sms = await pSms.catch((e) => {
        log(`[captcha] smsSend timeout/loi: ${e.message}`);
        return null;
      });

      if (sms && sms.code === 200) break;
      if (isRateLimited(sms)) {
        const wait = 60000 * attempt;
        log(`[rate-limit] gui ma bi chan, nghi ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      log(`[captcha] Lan ${attempt} chua nhan ma hop le, thu lai...`);
    }
    if (!sms || sms.code !== 200) throw new Error('Khong gui duoc ma xac thuc sau 3 lan');
    log(`[*] Da gui ma xac thuc`);

    // --- buoc 4: lay ma 6 so tu mailbox
    const code = await mailbox.waitForCode({ timeoutMs: this.cfg.mailTimeoutMs });
    await this.typeInto(SEL.code, code);
    await this.typeInto(SEL.password, password);
    await this.ensureTosChecked();
    await this.dumpInputs('form');

    // --- buoc 5: submit -> intercept /api/user/login response voi route() (tranh body mat khi navigate)
    const pLogin = this.waitForApiRoute('**/vsphone/api/user/login');
    await page.click(SEL.submit);

    const loginRes = await pLogin.catch((e) => {
      log(`[login] timeout/loi khi cho response: ${e.message}`);
      return null;
    });

    // Kiem tra ket qua dang nhap
    if (!loginRes) {
      const pageError = await this.readPageError();
      throw new Error(
        `Dang nhap that bai: timeout${pageError ? ` | trang hien: ${pageError}` : ''}`,
      );
    }

    if (loginRes.code !== 200) {
      const pageError = await this.readPageError();
      throw new Error(
        `Dang nhap that bai: code=${loginRes.code} msg=${loginRes.msg}${pageError ? ` | trang: ${pageError}` : ''}`,
      );
    }

    // Lay token + userId tu response (khong dung localStorage)
    const data   = loginRes.data || {};
    const token  = data.token || data.accessToken || data.access_token || null;
    const userId = data.userId || data.user_id
      ? String(data.userId || data.user_id)
      : null;

    log(`[+] Dang ky thanh cong: ${email} | token=${token ? 'co' : 'khong'} userId=${userId || 'null'}`);

    return {
      email,
      password,
      token,
      userId,
      createdAt: new Date().toISOString(),
    };
  }
}

module.exports = { VSPhoneRegistrar, SEL, API, sleep, isRateLimited };

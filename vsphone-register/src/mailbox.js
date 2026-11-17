'use strict';

/**
 * Mailbox provider dung de nhan ma xac thuc 6 so cua VSPhone.
 *
 * Provider "mailtm"  : tao hop thu thoai tam (mail.tm) -> doc ma tu API.
 * Provider "stdin"   : tu ngoi, tool se hoi ban nhap ma (dung khi ban tu tao email).
 */

const DEFAULT_BASE = 'https://api.mail.tm';

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function pickCode(text) {
  if (!text) return null;
  const subjectMatch = /(?:code|codigo|mã|ma|xác thực|xac thuc|verification|verify|otp)\D{0,20}(\d{6})/i.exec(text);
  if (subjectMatch) return subjectMatch[1];
  const m = /\b(\d{6})\b/.exec(text);
  return m ? m[1] : null;
}

async function httpJson(url, { method = 'GET', body, token, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* ignore */
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 200)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function asList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    return json['hydra:member'] || json.member || json.items || json.data || [];
  }
  return [];
}

class MailTmMailbox {
  constructor({ apiBase = DEFAULT_BASE, domain = '', log = console.log } = {}) {
    this.base = apiBase.replace(/\/$/, '');
    this.fixedDomain = domain;
    this.log = log;
    this.token = null;
    this.address = null;
    this.password = null;
    this.seen = new Set();
  }

  async pickDomain() {
    if (this.fixedDomain) return this.fixedDomain;
    const json = await httpJson(`${this.base}/domains`);
    const list = asList(json).filter((d) => d && d.isActive !== false && d.domain);
    if (!list.length) throw new Error('mail.tm: khong lay duoc domain nao');
    const pick = list[Math.floor(Math.random() * list.length)];
    return pick.domain;
  }

  async create() {
    const domain = await this.pickDomain();
    const rand = Math.random().toString(36).slice(2, 10);
    const name = `vs${rand}${Date.now().toString(36).slice(-4)}`;
    this.address = `${name}@${domain}`;
    this.password = `Vs${Math.random().toString(36).slice(2, 8)}!${Math.floor(Math.random() * 900 + 100)}`;
    const res = await httpJson(`${this.base}/accounts`, {
      method: 'POST',
      body: { address: this.address, password: this.password },
    });
    const tokenRes = await httpJson(`${this.base}/token`, {
      method: 'POST',
      body: { address: this.address, password: this.password },
    });
    this.token = tokenRes.token;
    this.log(`[mail] da tao hop thu ${this.address} (${res && res.id ? res.id : 'ok'})`);
    return { address: this.address, password: this.password };
  }

  async listMessages() {
    const json = await httpJson(`${this.base}/messages`, { token: this.token });
    return asList(json);
  }

  async readMessage(id) {
    const json = await httpJson(`${this.base}/messages/${id}`, { token: this.token });
    return json || {};
  }

  /** Cho doi ma xac thuc 6 so trong hop thu. */
  async waitForCode({ timeoutMs = 180000, pollMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let list = [];
      try {
        list = await this.listMessages();
      } catch (err) {
        this.log(`[mail] loi khi doc inbox: ${err.message}`);
      }
      const fresh = list
        .filter((m) => m && m.id && !this.seen.has(m.id))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      for (const m of fresh) {
        this.seen.add(m.id);
        let full = m;
        try {
          full = await this.readMessage(m.id);
        } catch (_) {
          /* ignore */
        }
        const haystack = [full.subject, stripHtml(full.text), stripHtml(full.html)].join('\n');
        const code = pickCode(haystack);
        if (code) {
          this.log(`[mail] nhan duoc ma ${code} tu "${full.subject || full.id}"`);
          return code;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Timeout: khong nhan duoc ma xac thuc trong thoi gian cho');
  }
}

class GuerrillaMailbox {
  /** API cua GuerrillaMail: khong can dang ky, lay 1 hop thu tam ngay. */
  constructor({ apiBase = 'https://api.guerrillamail.com/ajax.php', log = console.log } = {}) {
    this.base = apiBase;
    this.log = log;
    this.cookie = '';
    this.sid = '';
    this.address = null;
    this.password = null;
    this.seen = new Set();
  }

  async request(params) {
    const url = `${this.base}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/ld+json',
        'User-Agent': 'Mozilla/5.0',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length) {
      const usersession = setCookie.find((c) => c.startsWith('usersession='));
      if (usersession) this.cookie = usersession.split(';')[0];
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`GuerrillaMail tra ve khong phai JSON: ${text.slice(0, 150)}`);
    }
  }

  async create() {
    let info = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        info = await this.request({ f: 'get_email_address', lang: 'en' });
      } catch (err) {
        info = null;
        this.log(`[mail] GuerrillaMail loi (lan ${attempt}): ${err.message}`);
      }
      if (info && info.email_addr) break;
      this.log(`[mail] GuerrillaMail chua cap duoc email (lan ${attempt}), thu lai...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!info || !info.email_addr) {
      throw new Error(`GuerrillaMail khong cap duoc dia chi email: ${JSON.stringify(info).slice(0, 200)}`);
    }
    this.sid = info.sid_token;
    this.address = info.email_addr;
    this.password = null;
    this.log(`[mail] da tao hop thu ${this.address} (guerrillamail)`);
    return { address: this.address, password: null };
  }

  async listMessages() {
    const json = await this.request({ f: 'check_email', seq: '0', sid_token: this.sid });
    return Array.isArray(json && json.list) ? json.list : [];
  }

  async readMessage(id) {
    const json = await this.request({ f: 'fetch_email', email_id: id, sid_token: this.sid });
    return json || {};
  }

  async waitForCode({ timeoutMs = 180000, pollMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let list = [];
      try {
        list = await this.listMessages();
      } catch (err) {
        this.log(`[mail] loi khi doc inbox: ${err.message}`);
      }
      const fresh = list
        .filter((m) => m && m.mail_id && !this.seen.has(m.mail_id))
        .sort((a, b) => String(b.mail_date || '').localeCompare(String(a.mail_date || '')));
      for (const m of fresh) {
        this.seen.add(m.mail_id);
        let full = m;
        try {
          full = await this.readMessage(m.mail_id);
        } catch (_) {
          /* ignore */
        }
        const haystack = [full.mail_subject, full.mail_excerpt, full.mail_body].join('\n');
        const code = pickCode(haystack);
        if (code) {
          this.log(`[mail] nhan duoc ma ${code} tu "${full.mail_subject || m.mail_subject || m.mail_id}"`);
          return code;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Timeout: khong nhan duoc ma xac thuc trong thoi gian cho');
  }
}

class InboxKittenMailbox {
  /**
   * inboxkitten.com - disposable email, khong can dang ky.
   * API: GET /api/v1/mail/list?recipient=<local>
   *      GET /api/v1/mail/getHtml?region=<r>&key=<k>
   *      GET /api/v1/mail/getKey?region=<r>&key=<k>
   */
  constructor({ apiBase = 'https://inboxkitten.com/api/v1/mail', domain = 'inboxkitten.com', log = console.log } = {}) {
    this.base = apiBase.replace(/\/$/, '');
    this.domain = domain;
    this.log = log;
    this.address = null;
    this.password = null;
    this.seen = new Set();
  }

  async get(path, params, accept = 'application/json') {
    const url = `${this.base}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { headers: { Accept: accept } });
    if (!res.ok) throw new Error(`inboxkitten HTTP ${res.status} ${path}`);
    return accept.includes('json') ? res.json() : res.text();
  }

  async create() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const local = Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    this.address = `${local}@${this.domain}`;
    this.log(`[mail] da tao hop thu ${this.address} (inboxkitten)`);
    return { address: this.address, password: null };
  }

  async listMessages() {
    const local = String(this.address || '').split('@')[0];
    const rows = await this.get('/list', { recipient: local });
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const storage = (r && r.storage) || {};
      const headers = (r && r.message && r.message.headers) || {};
      return {
        id: storage.key || r.id,
        region: storage.region || '',
        key: storage.key || '',
        subject: headers.subject || '',
        from: headers.from || '',
        timestamp: r.timestamp || '',
      };
    });
  }

  async readMessage(msg) {
    const out = { subject: msg.subject, text: '', html: '' };
    if (!msg.region || !msg.key) return out;
    try {
      const meta = await this.get('/getKey', { region: msg.region, key: msg.key });
      if (meta && meta.subject) out.subject = meta.subject;
      if (meta && meta.name) out.from = meta.name;
    } catch (_) {
      /* ignore */
    }
    try {
      const html = await this.get('/getHtml', { region: msg.region, key: msg.key }, 'text/html,*/*');
      out.html = html;
      out.text = stripHtml(html);
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  async waitForCode({ timeoutMs = 180000, pollMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let list = [];
      try {
        list = await this.listMessages();
      } catch (err) {
        this.log(`[mail] loi khi doc inbox: ${err.message}`);
      }
      const fresh = list
        .filter((m) => m.id && !this.seen.has(m.id))
        .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      for (const m of fresh) {
        this.seen.add(m.id);
        const full = await this.readMessage(m);
        const code = pickCode([full.subject, full.text, full.html].join('\n'));
        if (code) {
          this.log(`[mail] nhan duoc ma ${code} tu "${full.subject || m.id}"`);
          return code;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Timeout: khong nhan duoc ma xac thuc trong thoi gian cho');
  }
}

class StdinMailbox {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.address = null;
    this.password = null;
    this.seen = new Set();
  }

  async create() {
    return { address: null, password: null };
  }

  async waitForCode() {
    this.log('=== Nhap ma xac thuc 6 so (khong giu phim Enter sau khi nhap ma) ===');
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question('Ma 6 so: ', resolve));
    rl.close();
    const code = (answer || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) throw new Error('Ma khong hop le');
    return code;
  }
}

function createMailbox(cfg, log) {
  const provider = (cfg.provider || 'mailtm').toLowerCase();
  if (provider === 'mailtm') {
    return new MailTmMailbox({ apiBase: cfg.apiBase, domain: cfg.domain, log });
  }
  if (provider === 'guerrillamail') {
    return new GuerrillaMailbox({ apiBase: cfg.guerillaApiBase, log });
  }
  if (provider === 'inboxkitten') {
    return new InboxKittenMailbox({ apiBase: cfg.inboxkittenApiBase, domain: cfg.inboxkittenDomain, log });
  }
  if (provider === 'stdin') return new StdinMailbox({ log });
  throw new Error(`Mailbox provider khong ho tro: ${provider}`);
}

module.exports = {
  createMailbox,
  MailTmMailbox,
  GuerrillaMailbox,
  InboxKittenMailbox,
  StdinMailbox,
  pickCode,
  stripHtml,
};

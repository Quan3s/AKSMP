'use strict';

/**
 * Tao GitHub Gist chua:
 *   - email|password (dong dau tien trong field "account")
 *   - TOAN BO localStorage cua VSPhone
 *
 * Gist la private, raw URL tra ve thang de api /register dung.
 *
 * env GITHUB_TOKEN = Personal Access Token (scope: gist)
 */

async function createGist({ email, password, localStorage: ls, githubToken }) {
  const token = githubToken || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('Thieu GITHUB_TOKEN');

  // localStorage that cua browser: stringify lai tat ca value thanh string phang
  const flat = {};
  for (const [k, v] of Object.entries(ls || {})) {
    flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  const safeEmail = email.replace(/[^a-z0-9@._-]/gi, '_');
  const filename  = `vsphone_${safeEmail}.json`;

  // noi dung gist: them truong "account" chua email|password de de doc
  const content = JSON.stringify(
    {
      account:      `${email}|${password}`,
      email,
      password,
      localStorage: flat,
    },
    null,
    2,
  );

  const body = {
    description: `VSPhone localStorage — ${email}`,
    public: false,
    files: { [filename]: { content } },
  };

  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization:          `Bearer ${token}`,
      Accept:                 'application/vnd.github+json',
      'Content-Type':         'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub Gist API ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  // raw_url dang: https://gist.githubusercontent.com/<user>/<id>/raw/<hash>/<filename>
  const rawUrl = json.files?.[filename]?.raw_url || json.html_url;
  return rawUrl;
}

module.exports = { createGist };

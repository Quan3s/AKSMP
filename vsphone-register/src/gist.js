'use strict';

/**
 * Tao GitHub Gist chua localStorage cua VSPhone.
 * env GITHUB_TOKEN = Personal Access Token (scope: gist)
 *
 * Format gist: 1 file "vsphone_<email>.json"
 * Noi dung = JSON.stringify(localStorage) dung y nhu copy tu DevTools
 * tuc la object phang { key: value } tat ca deu la string (giong localStorage that).
 */

async function createGist({ email, localStorage: ls, githubToken }) {
  const token = githubToken || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('Thieu GITHUB_TOKEN');

  // localStorage that cua browser: tat ca value la string
  // ls o day co the da JSON.parse tung value -> can stringify lai thanh string
  const flat = {};
  for (const [k, v] of Object.entries(ls || {})) {
    flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  const filename = `vsphone_${email.replace(/[^a-z0-9@._-]/gi, '_')}.json`;
  const content  = JSON.stringify(flat, null, 2);

  const body = {
    description: `VSPhone localStorage — ${email}`,
    public: false,
    files: { [filename]: { content } },
  };

  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub Gist API ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  // raw url: https://gist.githubusercontent.com/<user>/<gist_id>/raw/<filename>
  const rawUrl = json.files?.[filename]?.raw_url || json.html_url;
  return rawUrl;
}

module.exports = { createGist };

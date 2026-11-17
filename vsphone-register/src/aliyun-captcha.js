'use strict';

const sharp = require('sharp');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// HELPERS — morphology cho mask
// ============================================================
function erode(mask, w, h, iter) {
  let m = mask;
  for (let k = 0; k < iter; k++) {
    const n = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w]) n[i] = 1;
      }
    }
    m = n;
  }
  return m;
}

function dilate(mask, w, h, iter) {
  let m = mask;
  for (let k = 0; k < iter; k++) {
    const n = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!m[i]) continue;
        n[i] = 1;
        if (x > 0) n[i - 1] = 1;
        if (x < w - 1) n[i + 1] = 1;
        if (y > 0) n[i - w] = 1;
        if (y < h - 1) n[i + w] = 1;
      }
    }
    m = n;
  }
  return m;
}

// ============================================================
// PIECE — doc shadow.png, lay alpha mask + bbox
// ============================================================
async function analyzePiece(shadowBuf, log = console.log) {
  const { data, info } = await sharp(shadowBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const mask = new Uint8Array(width * height);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let count = 0;
  let sumX = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i * channels + 3] > 200) {
        mask[i] = 1;
        count++;
        sumX += x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < 100 || maxX < 0) throw new Error('Khong detect duoc piece');

  const piece = {
    mask,
    width,
    height,
    count,
    minX,
    maxX,
    minY,
    maxY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    centerX: sumX / count,
  };
  log(`  [captcha-solver] Piece ${piece.w}x${piece.h} minX=${minX} minY=${minY} count=${count}`);
  return piece;
}

// ============================================================
// GAP — mask cua piece truot tren back.png
// ============================================================
async function detectGap(backBuf, piece, log = console.log) {
  const { data, info } = await sharp(backBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const gray = new Float32Array(width * height);
  const sat = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * channels];
    const g = data[i * channels + 1];
    const b = data[i * channels + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  const yScale = height / piece.height;
  const erodeBy = Math.max(3, Math.round(Math.min(piece.w, piece.h) * 0.1));

  const insideMask = erode(piece.mask, piece.width, piece.height, erodeBy);
  const ringOuter = dilate(piece.mask, piece.width, piece.height, erodeBy + 5);
  const ringInner = dilate(piece.mask, piece.width, piece.height, erodeBy - 1);
  const ringMask = new Uint8Array(piece.width * piece.height);
  for (let i = 0; i < ringMask.length; i++) {
    ringMask[i] = ringOuter[i] && !ringInner[i] ? 1 : 0;
  }

  const inside = [];
  const ring = [];
  for (let y = 0; y < piece.height; y++) {
    const by = Math.round(y * yScale);
    if (by < 0 || by >= height) continue;
    for (let x = 0; x < piece.width; x++) {
      const i = y * piece.width + x;
      if (insideMask[i]) inside.push([x, by]);
      else if (ringMask[i]) ring.push([x, by]);
    }
  }
  if (inside.length < 200) throw new Error('Piece mask qua nho');

  let best = null;
  const xStart = Math.max(1, Math.round(width * 0.12));
  const xEnd = width - piece.w - 1;

  for (let dx = xStart; dx <= xEnd; dx++) {
    let is = 0;
    let is2 = 0;
    let ss = 0;
    let rs = 0;
    let rn = 0;

    for (let k = 0; k < inside.length; k++) {
      const [px, py] = inside[k];
      const g = gray[py * width + dx + px];
      is += g;
      is2 += g * g;
      ss += sat[py * width + dx + px];
    }
    for (let k = 0; k < ring.length; k++) {
      const [px, py] = ring[k];
      const x = dx + px;
      if (x < 0 || x >= width) continue;
      rs += gray[py * width + x];
      rn++;
    }
    if (!rn) continue;

    const n = inside.length;
    const im = is / n;
    const std = Math.sqrt(Math.max(0, is2 / n - im * im));
    const rm = rs / rn;
    const sm = ss / n;

    const score = (im - rm) - 1.2 * std - 0.3 * sm;
    if (!best || score > best.score) {
      best = { dx, score, insideMean: im, outsideMean: rm, std, sat: sm };
    }
  }

  if (!best) throw new Error('Khong detect duoc gap');
  if (best.insideMean - best.outsideMean < 8) {
    throw new Error(`Gap khong du tuong phan (in=${best.insideMean.toFixed(0)} out=${best.outsideMean.toFixed(0)})`);
  }

  const gap = {
    dx: best.dx,
    minX: best.dx + piece.minX,
    maxX: best.dx + piece.maxX,
    minY: piece.minY,
    maxY: piece.maxY,
    w: piece.w,
    h: piece.h,
    backWidth: width,
    backHeight: height,
    score: best.score,
  };

  log(
    `  [captcha-solver] Gap x=${gap.minX} (dx=${gap.dx}) score=${best.score.toFixed(1)} ` +
      `in=${best.insideMean.toFixed(0)} out=${best.outsideMean.toFixed(0)} std=${best.std.toFixed(0)}`,
  );
  return gap;
}

// ============================================================
// TRAJECTORY human-like
// ============================================================
function generateTrajectory(distance) {
  const track = [];
  let t = 0;

  const accel = 5 + Math.floor(Math.random() * 4);
  for (let i = 1; i <= accel; i++) {
    const p = i / accel;
    const x = distance * 0.6 * (1 - Math.pow(1 - p, 3));
    t += 15 + Math.random() * 12;
    track.push({ x: Math.round(x), y: Math.round((Math.random() - 0.5) * 2), t });
  }

  const decel = 4 + Math.floor(Math.random() * 3);
  const startX = distance * 0.6;
  for (let i = 1; i <= decel; i++) {
    const p = i / decel;
    const x = startX + distance * 0.4 * p;
    t += 30 + Math.random() * 25;
    track.push({ x: Math.round(x), y: Math.round((Math.random() - 0.5) * 3), t });
  }

  for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
    const x = distance + (Math.random() - 0.5) * 4;
    t += 40 + Math.random() * 30;
    track.push({ x: Math.round(x), y: Math.round((Math.random() - 0.5) * 2), t });
  }

  track.push({ x: distance, y: 0, t: t + 60 });
  return track;
}

// ============================================================
// REPLAY qua Playwright page.mouse
// ============================================================
async function replay(page, startX, startY, track, log = console.log) {
  log(`  [captcha-solver] Replay ${track.length} diem / ${track[track.length - 1].t}ms`);
  await page.mouse.move(startX, startY);
  await sleep(100 + Math.random() * 80);
  await page.mouse.down();
  await sleep(80 + Math.random() * 50);

  const tStart = Date.now();
  for (const p of track) {
    const wait = p.t - (Date.now() - tStart);
    if (wait > 0) await sleep(wait);
    await page.mouse.move(startX + p.x, startY + p.y);
  }
  await sleep(80 + Math.random() * 120);
  await page.mouse.up();
}

// ============================================================
// FIND SLIDER + GEOMETRY
// ============================================================
async function findSlider(page, log = console.log) {
  const info = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const slider =
      q('#aliyunCaptcha-sliding-slider') ||
      q('.aliyunCaptcha-sliding-slider') ||
      q('[class*="slider-move"]') ||
      q('.captcha-slider-btn') ||
      q('[class*="slider-btn"]');
    if (!slider || slider.offsetParent === null) return null;

    const img = q('#aliyunCaptcha-img');
    const puzzle = q('#aliyunCaptcha-puzzle');
    const body = q('#aliyunCaptcha-sliding-body');
    const sRect = slider.getBoundingClientRect();
    const iRect = img ? img.getBoundingClientRect() : null;
    const pRect = puzzle ? puzzle.getBoundingClientRect() : null;
    const bRect = body ? body.getBoundingClientRect() : null;

    return {
      sliderX: sRect.x + sRect.width / 2,
      sliderY: sRect.y + sRect.height / 2,
      sliderWidth: sRect.width,
      sliderHeight: sRect.height,
      trackWidth: bRect ? bRect.width - sRect.width : null,
      imgWidth: iRect ? iRect.width : null,
      imgHeight: iRect ? iRect.height : null,
      puzzleWidth: pRect ? pRect.width : null,
      puzzleHeight: pRect ? pRect.height : null,
    };
  });

  if (!info) throw new Error('Khong tim thay slider trong DOM');
  log(
    `  [captcha-solver] Slider @ (${Math.round(info.sliderX)},${Math.round(info.sliderY)}) ` +
      `track=${info.trackWidth ? Math.round(info.trackWidth) : '?'}px img=${info.imgWidth ? Math.round(info.imgWidth) : '?'}px`,
  );
  return info;
}

// ============================================================
// EXTRACT CAPTCHA IMAGES TU DOM (fallback neu khong bat duoc network)
// ============================================================
async function extractCaptchaFromDom(page) {
  return page.evaluate(() => {
    const get = (id) => {
      const el = document.getElementById(id);
      return el && el.src && el.src.startsWith('data:') ? el.src.split(',')[1] : null;
    };
    return { back: get('aliyunCaptcha-img'), shadow: get('aliyunCaptcha-puzzle') };
  });
}

// ============================================================
// WAIT FOR CAPTCHA IMAGES (DOM hoac Network)
// ============================================================
async function waitForCaptchaImages(page, imageBuffers, log = console.log, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (imageBuffers.back && imageBuffers.shadow) return true;
    try {
      const domData = await extractCaptchaFromDom(page);
      if (domData.back && domData.shadow) {
        imageBuffers.back = Buffer.from(domData.back, 'base64');
        imageBuffers.shadow = Buffer.from(domData.shadow, 'base64');
        imageBuffers.backAt = Date.now();
        imageBuffers.shadowAt = Date.now();
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    await sleep(400);
  }
  return false;
}

// ============================================================
// CHECK RESULT
// ============================================================
async function checkResult(page) {
  return page.evaluate(() => {
    const popup = document.querySelector(
      '#aliyunCaptcha-window-popup, #aliyunCaptcha-window-embed, #aliyunCaptcha-window-float',
    );
    const body = document.querySelector('#aliyunCaptcha-sliding-body');
    const otp = document.querySelector('input[type="number"][maxlength="1"]');
    const errEl = document.querySelector(
      '.aliyunCaptcha-error, [class*="captcha-error"], #aliyunCaptcha-sliding-body.fail',
    );

    const popupHidden = popup
      ? getComputedStyle(popup).display === 'none' || /hidden/i.test(popup.className || '')
      : true;

    return {
      popupHidden,
      verified: !!body?.classList.contains('verified'),
      failed: !!body?.classList.contains('fail'),
      otpVisible: !!otp,
      error: errEl?.innerText?.trim() || null,
    };
  });
}

// ============================================================
// REFRESH CAPTCHA
// ============================================================
async function refreshCaptcha(page, imageBuffers, prevBackAt, prevShadowAt, log = console.log) {
  const clicked = await page.evaluate(() => {
    const btn =
      document.querySelector('#aliyunCaptcha-btn-refresh') ||
      document.querySelector('[aria-label*="刷新"]') ||
      document.querySelector('[class*="refresh"]') ||
      document.querySelector('[class*="reload"]');
    if (!btn) return false;
    btn.click();
    return true;
  });

  if (!clicked) {
    log('  [captcha-solver] Khong tim thay nut refresh captcha');
    return false;
  }

  log('  [captcha-solver] Da click refresh, cho anh moi...');
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await sleep(500);
    const freshBack = !imageBuffers.backAt || imageBuffers.backAt > (prevBackAt || 0);
    const freshShadow = !imageBuffers.shadowAt || imageBuffers.shadowAt > (prevShadowAt || 0);
    if (imageBuffers.back && imageBuffers.shadow && freshBack && freshShadow) {
      await sleep(800);
      return true;
    }
    // thu doc lai tu DOM
    try {
      const domData = await extractCaptchaFromDom(page);
      if (domData.back && domData.shadow) {
        const b = Buffer.from(domData.back, 'base64');
        const s = Buffer.from(domData.shadow, 'base64');
        imageBuffers.back = b;
        imageBuffers.shadow = s;
        imageBuffers.backAt = Date.now();
        imageBuffers.shadowAt = Date.now();
        await sleep(500);
        return true;
      }
    } catch (_) {
      /* ignore */
    }
  }

  log('  [captcha-solver] Khong nhan duoc anh captcha moi sau refresh');
  return false;
}

// ============================================================
// ATTACH NETWORK LISTENER (ghi nhan back.png / shadow.png)
// ============================================================
function attachImageCollector(page, imageBuffers, debug = false, log = console.log) {
  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (/\/back\.png(\?|$)/.test(url)) {
        imageBuffers.back = await res.body();
        imageBuffers.backAt = Date.now();
        if (debug) log(`  [captcha] network back.png (${imageBuffers.back.length}B)`);
      } else if (/\/shadow\.png(\?|$)/.test(url)) {
        imageBuffers.shadow = await res.body();
        imageBuffers.shadowAt = Date.now();
        if (debug) log(`  [captcha] network shadow.png (${imageBuffers.shadow.length}B)`);
      }
    } catch (_) {
      /* ignore */
    }
  };
  page.on('response', onResponse);
  return () => page.off('response', onResponse);
}

// ============================================================
// MAIN SOLVER
// ============================================================
async function solveAliyunPuzzle(page, imageBuffers, log = console.log, options = {}) {
  const {
    maxAttempts = 4,
    saveDebug = false,
    offsetBias = 0,
    nonlinear = true,
    powDelay = 6000,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`\n[captcha-solver] Giai Aliyun captcha lan ${attempt}/${maxAttempts}`);

    if (powDelay > 0) {
      log(`  [captcha-solver] Cho ${Math.round(powDelay / 1000)}s cho POW/risk engine...`);
      await sleep(powDelay);
      const vp = page.viewportSize() || { width: 1280, height: 900 };
      for (let i = 0; i < 6; i++) {
        await page.mouse.move(
          Math.round(vp.width * (0.15 + Math.random() * 0.6)),
          Math.round(vp.height * (0.15 + Math.random() * 0.5)),
        );
        await sleep(80 + Math.random() * 120);
      }
    }

    const ready = await waitForCaptchaImages(page, imageBuffers, log, 10000);
    if (!ready) {
      log('  [captcha-solver] Khong san sang anh captcha');
      continue;
    }

    let backBuf = imageBuffers.back;
    let shadowBuf = imageBuffers.shadow;

    try {
      if (!backBuf || !shadowBuf) throw new Error('Thieu buffer anh captcha');

      if (saveDebug) {
        fs.writeFileSync(`debug-back-${attempt}.png`, backBuf);
        fs.writeFileSync(`debug-shadow-${attempt}.png`, shadowBuf);
      }

      const piece = await analyzePiece(shadowBuf, log);
      const gap = await detectGap(backBuf, piece, log);
      const slider = await findSlider(page, log);

      const backScale = slider.imgWidth ? slider.imgWidth / gap.backWidth : 1;
      const pieceScale = slider.puzzleWidth ? slider.puzzleWidth / piece.width : 1;
      const pieceCenter = (piece.minX + piece.maxX) / 2;
      const gapCenter = gap.dx + pieceCenter;

      let pieceTarget = gapCenter * backScale - pieceCenter * pieceScale + offsetBias;

      let distance = pieceTarget;
      const maxD = Number.isFinite(slider.trackWidth) ? slider.trackWidth : 260;
      if (nonlinear && maxD > 0) {
        const k = maxD / 12;
        const pt = Math.max(0, Math.min(pieceTarget, maxD));
        distance = (-k + Math.sqrt(k * k + 4 * pt * (maxD + k))) / 2;
        const predicted = (distance * (distance + k)) / (maxD + k);
        log(
          `  [captcha-solver] Piece target=${pt.toFixed(1)}px -> slider=${distance.toFixed(1)}px (predicted piece=${predicted.toFixed(1)}px)`,
        );
      } else if (Number.isFinite(slider.trackWidth)) {
        distance = Math.max(0, Math.min(distance, slider.trackWidth));
      }
      distance = Math.round(distance);

      log(`  [captcha-solver] Offset tinh duoc: ${distance}px (gapCenter=${gapCenter.toFixed(1)}, scale=${backScale.toFixed(4)})`);

      const track = generateTrajectory(distance);
      await replay(page, slider.sliderX, slider.sliderY, track, log);

      log('  [captcha-solver] Cho he thong verify...');
      await sleep(3000);

      const result = await checkResult(page);
      if (result.verified || result.popupHidden || result.otpVisible) {
        log('  [captcha-solver] >>> CAPTCHA PASSED <<<');
        return { success: true, offset: distance, attempt };
      }

      log(`  [captcha-solver] Chua pass${result.error ? ': ' + result.error : ''}`);

      if (attempt < maxAttempts) {
        const prevBackAt = imageBuffers.backAt;
        const prevShadowAt = imageBuffers.shadowAt;
        const refreshed = await refreshCaptcha(page, imageBuffers, prevBackAt, prevShadowAt, log);
        if (!refreshed) await sleep(2000);
      }
    } catch (e) {
      log(`  [captcha-solver] Loi o lan ${attempt}: ${e.message}`);
      if (attempt === maxAttempts) {
        return { success: false, reason: e.message };
      }
      const prevBackAt = imageBuffers.backAt;
      const prevShadowAt = imageBuffers.shadowAt;
      const refreshed = await refreshCaptcha(page, imageBuffers, prevBackAt, prevShadowAt, log);
      if (!refreshed) await sleep(2000);
    }
  }

  return { success: false, reason: 'Vuot qua so lan thu toi da' };
}

module.exports = {
  analyzePiece,
  detectGap,
  generateTrajectory,
  findSlider,
  checkResult,
  refreshCaptcha,
  extractCaptchaFromDom,
  waitForCaptchaImages,
  attachImageCollector,
  solveAliyunPuzzle,
};

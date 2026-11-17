'use strict';

const assert = require('assert');
const sharp = require('sharp');
const { analyzePiece, detectGap, generateTrajectory } = require('../src/aliyun-captcha');

const W = 300;
const H = 200;
const PIECE = { x: 20, y: 80, w: 40, h: 40 };
const GAP_X = 100;

async function makeShadow() {
  const buf = Buffer.alloc(W * H * 4, 0);
  for (let y = PIECE.y; y < PIECE.y + PIECE.h; y++) {
    for (let x = PIECE.x; x < PIECE.x + PIECE.w; x++) {
      const i = (y * W + x) * 4;
      buf[i] = 240;
      buf[i + 1] = 240;
      buf[i + 2] = 240;
      buf[i + 3] = 255;
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function makeBack() {
  // nen co nhieu + vung gap sang, phang (mo phong lop phu trang cua Aliyun)
  const buf = Buffer.alloc(W * H * 3);
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const inGap = x >= GAP_X && x < GAP_X + PIECE.w && y >= PIECE.y && y < PIECE.y + PIECE.h;
      const v = inGap ? 170 : Math.round(60 + rand() * 70);
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function main() {
  const shadow = await makeShadow();
  const back = await makeBack();

  const piece = await analyzePiece(shadow, () => {});
  assert.strictEqual(piece.minX, PIECE.x, 'piece minX');
  assert.strictEqual(piece.maxX, PIECE.x + PIECE.w - 1, 'piece maxX');
  assert.strictEqual(piece.minY, PIECE.y, 'piece minY');
  assert.strictEqual(piece.w, PIECE.w, 'piece width');

  const gap = await detectGap(back, piece, () => {});
  const tolerance = 2;
  assert.ok(
    Math.abs(gap.dx - (GAP_X - PIECE.x)) <= tolerance,
    `gap dx ${gap.dx} != ${GAP_X - PIECE.x} (+-${tolerance})`,
  );

  const track = generateTrajectory(137);
  assert.ok(track.length >= 8, 'trajectory co du diem');
  assert.strictEqual(track[track.length - 1].x, 137, 'diem cuoi phai bang distance');
  for (let i = 1; i < track.length; i++) {
    assert.ok(track[i].t >= track[i - 1].t, 'thoi gian khong giam');
  }
  const maxJitter = Math.max(...track.map((p) => Math.abs(p.y)));
  assert.ok(maxJitter <= 4, 'jitter doc truc y nho');

  console.log('solver.test.js: OK');
  console.log(`  piece ${piece.w}x${piece.h} @ (${piece.minX},${piece.minY})`);
  console.log(`  gap dx=${gap.dx} (expected ${GAP_X - PIECE.x})`);
  console.log(`  track ${track.length} diem, jitter y <= ${maxJitter}px`);
}

main().catch((err) => {
  console.error('solver.test.js: FAIL');
  console.error(err);
  process.exit(1);
});

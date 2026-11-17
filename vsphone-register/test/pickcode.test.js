'use strict';

/** Test nho cho phan tach ma 6 so tu email. Chay: node test/pickcode.test.js */

const assert = require('assert');
const { pickCode, stripHtml } = require('../src/mailbox');

const cases = [
  ['VSPhone verification code: 483920', '483920'],
  ['Your verification code is 123456', '123456'],
  ['Mã xác thực của bạn là 654321', '654321'],
  ['<p>Your code is <b>778899</b></p>', '778899'],
  ['verification code 112233 (valid 5 minutes)', '112233'],
  ['no code here', null],
];

for (const [input, expected] of cases) {
  const got = pickCode(stripHtml(input));
  assert.strictEqual(got, expected, `input="${input}" expected=${expected} got=${got}`);
  console.log(`OK  ${JSON.stringify(input)} -> ${got}`);
}
console.log('tat ca test deu pass');

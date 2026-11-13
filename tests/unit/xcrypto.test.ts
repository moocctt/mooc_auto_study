/** 浏览器侧 AES-128-ECB: 与 Node crypto / openssl 逐字节一致 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { test } from 'vitest';
import { encField, decField, AES_KEY } from '../../extension/lib/crypto.js';

/** 独立参照: Node 的 aes-128-ecb + PKCS7 */
function nodeEnc(plain) {
  const c = createCipheriv('aes-128-ecb', AES_KEY, null);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');
}

test('与 Node crypto 逐字节一致 (多组输入)', () => {
  const samples = ['a', 'hello', '13800012345', '测试数据123', '全行业', 'x'.repeat(15), 'x'.repeat(16), 'x'.repeat(17), '😀 emoji'];
  for (const s of samples) assert.equal(encField(s), nodeEnc(s), `不一致: ${s}`);
});

test('随机二进制也一致 (hex 长度覆盖 1..64 字节)', () => {
  for (let n = 1; n <= 64; n++) {
    const raw = randomBytes(n).toString('hex');   // 纯 ASCII, 便于等值比较
    assert.equal(encField(raw), nodeEnc(raw), `长度 ${n} 不一致`);
  }
});

test('解密可还原 (含中文与填充边界)', () => {
  for (const s of ['a', '测试数据123', 'x'.repeat(16), '😀']) {
    assert.equal(decField(encField(s)), s);
    const d = createDecipheriv('aes-128-ecb', AES_KEY, null);
    d.setAutoPadding(false);
    const raw = Buffer.concat([d.update(Buffer.from(encField(s), 'base64')), d.final()]);
    assert.equal(raw.subarray(0, raw.length - raw[raw.length - 1]).toString('utf8'), s);
  }
});

test('空串与 null 按协议原样返回', () => {
  assert.equal(encField(''), '');
  assert.equal(encField(null), null);
});

test('布尔与数字按前端约定转字符串', () => {
  assert.equal(encField(true), nodeEnc('true'));
  assert.equal(encField(false), nodeEnc('false'));
  assert.equal(encField(999), nodeEnc('999'));
});

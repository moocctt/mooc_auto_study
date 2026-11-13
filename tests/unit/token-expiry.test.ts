/** 令牌到期闹钟: 只排「还没到期」的令牌, 最小 30s / 最大 24h（MV3 闹钟约束） */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_ALARM_MS, MIN_ALARM_MS, nextExpiryDelay } from '../../extension/lib/tokenExpiry.js';

const NOW = 1_700_000_000_000;
const tok = (expiresIn: number, obtainedAt: number) => ({ access_token: 't', expires_in: expiresIn, obtainedAt });

test('nextExpiryDelay: 取最早的一个到期点（含余量 1.5s）', () => {
  const d = nextExpiryDelay({
    a: tok(14400, NOW - 3600e3),   // 还剩 3h
    b: tok(600, NOW - 300e3),      // 还剩 5min → 最近
  }, NOW);
  assert.equal(d, 300e3 + 1500);
});

test('nextExpiryDelay: 没有可排的到期点 → null（清闹钟）', () => {
  assert.equal(nextExpiryDelay(null, NOW), null);
  assert.equal(nextExpiryDelay({}, NOW), null);
  // 平台没下发有效期 / 没给取得时间: 判断不了 → 交给 401 兜底, 不排闹钟
  assert.equal(nextExpiryDelay({ a: { access_token: 't' } }, NOW), null);
  assert.equal(nextExpiryDelay({ a: { access_token: 't', expires_in: 600 } }, NOW), null);
});

test('nextExpiryDelay: 已过期的令牌不排（否则会退化成每 30s 自唤醒）', () => {
  assert.equal(nextExpiryDelay({ a: tok(600, NOW - 3600e3) }, NOW), null);
});

test('nextExpiryDelay: 到期点很近也钳到 30s（MV3 发布版最小间隔）', () => {
  assert.equal(nextExpiryDelay({ a: tok(600, NOW - 599e3) }, NOW), MIN_ALARM_MS);
});

test('nextExpiryDelay: 上限 24h（超长令牌每天复核一次）', () => {
  assert.equal(nextExpiryDelay({ a: tok(30 * 86400, NOW) }, NOW), MAX_ALARM_MS);
});

test('nextExpiryDelay: 坏数据不炸', () => {
  assert.equal(nextExpiryDelay({ a: null, b: 'x', c: { expires_in: 'abc', obtainedAt: NOW } }, NOW), null);
});

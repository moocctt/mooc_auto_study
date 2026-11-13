// @ts-nocheck —— 纯函数测试
/** 学时达成率: 真实值可以超过 100%, 进度条宽度封顶 100% */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { barPercent, formatPercent } from '../../extension/lib/core.js';

test('formatPercent: 超额完成显示真实百分比（165.9 / 50 = 331.8%）', () => {
  assert.equal(formatPercent(165.9, 50), '331.8%');
  assert.equal(formatPercent(100, 50), '200%');
  assert.equal(formatPercent(50, 50), '100%');       // 整数不带小数位
  assert.equal(formatPercent(0, 50), '0%');
  assert.equal(formatPercent(12.5, 50), '25%');      // 25.0 → 25%
});

test('formatPercent: 没有要求学时/非法值 → 0%（不除零）', () => {
  assert.equal(formatPercent(10, 0), '0%');
  assert.equal(formatPercent(10, NaN), '0%');
  assert.equal(formatPercent(NaN, 50), '0%');
});

test('barPercent: 进度条封顶 100, 不因超额撑破', () => {
  assert.equal(barPercent(165.9, 50), 100);
  assert.equal(barPercent(25, 50), 50);
  assert.equal(barPercent(0, 50), 0);
  assert.equal(barPercent(10, 0), 0);
});

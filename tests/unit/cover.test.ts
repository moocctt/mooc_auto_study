/** 封面渐变: 名称稳定哈希 → 主题色双色渐变 */
import { describe, expect, it } from 'vitest';
import { coverGradient, coverOf } from '../../extension/lib/cover.js';
import { CHART_PALETTE } from '../../extension/lib/theme.js';

describe('coverGradient', () => {
  it('同名永远同色（确定性）', () => {
    expect(coverGradient('烟草专卖管理师')).toEqual(coverGradient('烟草专卖管理师'));
  });
  it('取自项目主题色板且两端不同', () => {
    for (const name of ['a', '烟草', '电子烟管理办法解读', 'x'.repeat(40)]) {
      const g = coverGradient(name);
      expect(CHART_PALETTE).toContain(g.from as any);
      expect(CHART_PALETTE).toContain(g.to as any);
      expect(g.from).not.toBe(g.to);
    }
  });
  it('不同名称有足够分散度', () => {
    const set = new Set(Array.from({ length: 20 }, (_, i) => coverGradient(`课程-${i}`).from));
    expect(set.size).toBeGreaterThanOrEqual(5);
  });
});

describe('coverOf', () => {
  it('平台图片 URL 优先, 否则纯渐变', () => {
    expect(coverOf({ name: 'a', cover: 'https://x/y.jpg' }).img).toBe('https://x/y.jpg');
    expect(coverOf({ name: 'a', cover: '/relative.png' }).img).toBeUndefined();
    expect(coverOf({ name: 'a' }).img).toBeUndefined();
  });
});

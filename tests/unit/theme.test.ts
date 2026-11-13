import { describe, expect, it } from 'vitest';
import { CHART_PALETTE, THEME } from '../../extension/lib/theme.js';

// 视觉基线: 对齐烟草网络学院主站（#007556 主绿 / #2A8B72 按钮 / #DEDEDE 边框）
describe('主题色与主站对齐', () => {
  it('品牌绿体系', () => {
    expect(THEME.brand).toBe('#007556');
    expect(THEME.brandMid).toBe('#2A8B72');
    expect(THEME.brandDark).toBe('#00543D');
    expect(THEME.line).toBe('#DEDEDE');
    expect(THEME.ink).toBe('#333333');
  });
  it('图表色板 7 色', () => {
    expect(CHART_PALETTE).toHaveLength(7);
    expect(CHART_PALETTE[0]).toBe(THEME.brand);
  });
});

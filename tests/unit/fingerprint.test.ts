/** 设备指纹: 与 web 分支 src/fingerprint.ts 同算法同口径（parity） */
import { describe, expect, it } from 'vitest';
import { BRANDS, fingerprintFor } from '../../extension/lib/fingerprint.js';

// 与 web/cli 相同的 FNV-1a 32 位散列（独立实现, 用于交叉验证）
function refHash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

describe('设备指纹 parity（对齐 web/cli 口径）', () => {
  it('同一账号派生稳定指纹', () => {
    expect(fingerprintFor('13800138000')).toEqual(fingerprintFor('13800138000'));
  });
  it('不同账号得到不同指纹（分散度）', () => {
    const fps = Array.from({ length: 20 }, (_, i) => fingerprintFor(`user-${i}`));
    const uas = new Set(fps.map((f) => f.userAgent));
    expect(uas.size).toBeGreaterThanOrEqual(8);
  });
  it('与参考实现逐字段一致（终端/系统/语言/UA）', () => {
    for (const seed of ['a', '13800138000', '张三', 'x'.repeat(40)]) {
      const h = refHash32(seed.trim() || 'default');
      const brands = ['Xiaomi', 'HUAWEI', 'OPPO', 'vivo', 'HONOR', 'realme', 'OnePlus', 'Google', 'samsung', 'motorola'];
      const devices = [
        { brand: 'Xiaomi', android: 14, chrome: 126 }, { brand: 'HUAWEI', android: 12, chrome: 121 },
        { brand: 'OPPO', android: 13, chrome: 124 }, { brand: 'vivo', android: 13, chrome: 123 },
        { brand: 'HONOR', android: 13, chrome: 124 }, { brand: 'realme', android: 14, chrome: 127 },
        { brand: 'OnePlus', android: 14, chrome: 128 }, { brand: 'Google', android: 14, chrome: 129 },
        { brand: 'samsung', android: 13, chrome: 125 }, { brand: 'motorola', android: 13, chrome: 122 },
      ];
      const d = devices[h % devices.length];
      const systems = ['Linux armv8l', 'Linux aarch64'];
      const languages = ['zh-CN,zh;q=0.9', 'zh-CN,zh-Hans;q=0.9,en;q=0.8'];
      const f = fingerprintFor(seed);
      expect(f.terminal).toBe(brands[h % brands.length]);
      expect(f.system).toBe(systems[(h >>> 8) % systems.length]);
      expect(f.language).toBe(languages[(h >>> 16) % languages.length]);
      expect(f.userAgent).toContain(`Android ${d.android}; `);
      expect(f.userAgent).toContain(`Chrome/${d.chrome}.0.`);
      void BRANDS;
    }
  });
  it('空种子回退 default', () => {
    expect(fingerprintFor('')).toEqual(fingerprintFor('default'));
  });
});

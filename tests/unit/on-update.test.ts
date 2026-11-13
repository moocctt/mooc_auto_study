import { describe, expect, it } from 'vitest';
import { UPDATE_NOTICE_KEY, isUpgrade, normalizeVersion, updateNotice } from '../../extension/lib/onUpdate.js';

describe('normalizeVersion', () => {
  it('标准三段', () => {
    expect(normalizeVersion('2.11.2')).toEqual([2, 11, 2]);
  });
  it('带后缀的段只取数字', () => {
    expect(normalizeVersion('2.11.2-beta.1')).toEqual([2, 11, 2]);
    expect(normalizeVersion('2.11-beta')).toEqual([2, 11, 0]);
  });
  it('非法/缺失输入退化为 [0,0,0]', () => {
    expect(normalizeVersion(undefined)).toEqual([0, 0, 0]);
    expect(normalizeVersion('')).toEqual([0, 0, 0]);
    expect(normalizeVersion('x.y.z')).toEqual([0, 0, 0]);
  });
});

describe('isUpgrade', () => {
  it('真正的升级 → true（含跨多个小版本）', () => {
    expect(isUpgrade('2.11.1', '2.11.2')).toBe(true);
    expect(isUpgrade('2.9.9', '2.11.2')).toBe(true);
  });
  it('同版本重装 / 降级 → false', () => {
    expect(isUpgrade('2.11.2', '2.11.2')).toBe(false);
    expect(isUpgrade('2.11.2', '2.11.1')).toBe(false);
  });
  it('首装（previous 缺失）→ false', () => {
    expect(isUpgrade(undefined, '2.11.2')).toBe(false);
    expect(isUpgrade(null, '2.11.2')).toBe(false);
    expect(isUpgrade('', '2.11.2')).toBe(false);
  });
  it('非法 current → false', () => {
    expect(isUpgrade('2.11.1', undefined as any)).toBe(false);
  });
});

describe('updateNotice', () => {
  it('升级时产出完整通知', () => {
    const n = updateNotice('2.11.1', '2.11.2', 1700000000000);
    expect(n).toEqual({ from: '2.11.1', to: '2.11.2', at: 1700000000000 });
  });
  it('非升级返回 null（background 不写 storage）', () => {
    expect(updateNotice('2.11.2', '2.11.2')).toBeNull();
    expect(updateNotice(undefined, '2.11.2')).toBeNull();
  });
  it('storage 键为固定字符串', () => {
    expect(UPDATE_NOTICE_KEY).toBe('mooc.updateNotice');
  });
});

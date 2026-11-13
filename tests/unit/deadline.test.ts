/** 必修临近截止提醒 */
import { describe, expect, it } from 'vitest';
import { daysLeftText, dueSoon } from '../../extension/lib/deadline.js';

const NOW = new Date('2026-11-06T12:00:00').getTime();
const D = (days: number) => NOW + days * 864e5;
const row = (o: object) => ({ name: 'x', required: '必修', state: '未开始', endTime: D(3), ...o });

describe('dueSoon', () => {
  it('只取 7 天内截止的必修未完成项, 按截止升序', () => {
    const rows = [
      row({ name: 'A', endTime: D(5) }),
      row({ name: 'B', endTime: D(1) }),
      row({ name: 'C', endTime: D(30) }),                 // 超出窗口
      row({ name: 'D', endTime: D(2), state: '已完成' }),  // 已完成
      row({ name: 'E', endTime: D(2), state: '已完成(复习)' }),
      row({ name: 'F', endTime: D(2), state: '已过期' }),
      row({ name: 'G', endTime: D(2), required: '选修' }), // 非必修
      row({ name: 'H', endTime: undefined }),             // 无截止
      row({ name: 'I', endTime: NOW - 864e5 }),           // 已过截止
    ];
    expect(dueSoon(rows as any, { now: NOW }).map((r: any) => r.name)).toEqual(['B', 'A']);
  });
  it('窗口可调', () => {
    const rows = [row({ name: 'A', endTime: D(5) })];
    expect(dueSoon(rows as any, { now: NOW, days: 3 })).toHaveLength(0);
    expect(dueSoon(rows as any, { now: NOW, days: 10 })).toHaveLength(1);
  });
});

describe('daysLeftText', () => {
  it('分钟/小时/天档位', () => {
    expect(daysLeftText(NOW + 30 * 6e4, NOW)).toBe('30 分钟');
    expect(daysLeftText(NOW + 5 * 36e5, NOW)).toBe('5 小时');
    expect(daysLeftText(NOW + 1.5 * 864e5, NOW)).toBe('1.5 天');
    expect(daysLeftText(NOW + 12 * 864e5, NOW)).toBe('12 天');
    expect(daysLeftText(NOW - 1, NOW)).toBe('已截止');
  });
});

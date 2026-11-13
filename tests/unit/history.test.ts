/** 学习历史与热力图数据 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getHistory, heatmapCells, levelOf, recordHistoryDay, setHistoryStorage, summarize } from '../../extension/lib/history.js';

const m = new Map<string, string>();
const mem: Storage = { getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 } as Storage;

beforeEach(() => { m.clear(); setHistoryStorage(mem); });

describe('recordHistoryDay', () => {
  it('同一日期只增不减（盘中多次刷新取较大值）', () => {
    recordHistoryDay('a', '2026-11-06', 0.4);
    recordHistoryDay('a', '2026-11-06', 1.2);
    recordHistoryDay('a', '2026-11-06', 0.8);
    expect(getHistory('a')['2026-11-06']).toBe(1.2);
  });
  it('非正数不落库', () => {
    expect(recordHistoryDay('a', '2026-11-06', 0)).toBe(false);
    expect(recordHistoryDay('a', '2026-11-06', -1)).toBe(false);
    expect(getHistory('a')).toEqual({});
  });
  it('多账号隔离', () => {
    recordHistoryDay('a', '2026-11-06', 2);
    recordHistoryDay('b', '2026-11-06', 1);
    expect(getHistory('a')['2026-11-06']).toBe(2);
    expect(getHistory('b')['2026-11-06']).toBe(1);
  });
});

describe('levelOf', () => {
  it('五档阈值', () => {
    expect([0, 0.2, 0.5, 0.9, 1, 1.9, 2].map(levelOf)).toEqual([0, 1, 2, 2, 3, 3, 4]);
  });
});

describe('heatmapCells', () => {
  it('26 周 = 26 列 × 7 格, 末列包含今天', () => {
    const today = new Date('2026-11-06T12:00:00');   // 周五
    const cols = heatmapCells({}, { weeks: 26, today });
    expect(cols).toHaveLength(26);
    for (const col of cols) expect(col).toHaveLength(7);
    const flat = cols.flat();
    expect(flat).toHaveLength(182);
    const last = cols[25];
    expect(last[5].date).toBe('2026-11-06');          // 周五落在第 6 行(周日=0)
    expect(last[5].future).toBe(false);
    expect(last[6].future).toBe(true);                // 周六在未来
    expect(flat.filter((c) => c.future)).toHaveLength(1);
  });
  it('按历史着色, 缺失为 0 档', () => {
    const today = new Date('2026-11-06T12:00:00');
    const cols = heatmapCells({ '2026-11-06': 2.5, '2026-11-05': 0.4 }, { weeks: 26, today });
    const flat = cols.flat();
    expect(flat.find((c) => c.date === '2026-11-06')!.level).toBe(4);
    expect(flat.find((c) => c.date === '2026-11-05')!.level).toBe(1);
    expect(flat.find((c) => c.date === '2026-11-04')!.level).toBe(0);
  });
});

describe('summarize（今日/本周/本月/今年）', () => {
  it('按周一为周起点统计, 排除未来与昨日之前', () => {
    const today = new Date('2026-11-06T12:00:00');   // 周五
    const history = {
      '2026-11-06': 1.5,   // 今天
      '2026-11-05': 2,     // 周四(本周)
      '2026-11-02': 0.5,   // 周一(本周)
      '2026-11-01': 3,     // 上周日(本月, 非本周)
      '2026-10-31': 4,     // 上个月
      '2025-12-31': 10,    // 去年
      '2026-11-07': 9,     // 未来: 不计
    };
    const s = summarize(history, { today });
    expect(s.today).toEqual({ hours: 1.5, days: 1 });
    expect(s.week).toEqual({ hours: 4, days: 3 });
    expect(s.month).toEqual({ hours: 7, days: 4 });
    expect(s.year).toEqual({ hours: 11, days: 5 });
  });
  it('todayHours 覆盖历史旧值（盘中实时值更大时）', () => {
    const today = new Date('2026-11-06T12:00:00');
    const s = summarize({ '2026-11-06': 0.4 }, { today, todayHours: 1.2 });
    expect(s.today.hours).toBe(1.2);
  });
  it('空历史', () => {
    const s = summarize({}, { today: new Date('2026-11-06T12:00:00') });
    expect(s.today).toEqual({ hours: 0, days: 0 });
    expect(s.year.hours).toBe(0);
  });
});

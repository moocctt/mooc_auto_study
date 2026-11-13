/** 当日额度记账：hourSelf 基准口径（对齐 main/cli/web） */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordTodayHours, recordTodayUsed, setTodayStorage, todayCapacity, todayHoursTotal, todayStr, todayUsed } from '../../extension/lib/today.js';

const KEY = 'mooc.console.today.v1.default';
const m = new Map<string, string>();
const mem: Storage = { getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;

const today = todayStr();
const write = (o: object): void => { m.set(KEY, JSON.stringify(o)); };
const readRaw = (): any => JSON.parse(m.get(KEY) || '{}');

beforeEach(() => { m.clear(); setTodayStorage(mem); });

describe('当日额度记账', () => {
  it('旧 used 格式仍可读', () => {
    write({ date: today, used: 3.5 });
    expect(todayUsed()).toBe(3.5);
  });
  it('跨日归零', () => {
    write({ date: '2000-01-01', used: 9 });
    expect(todayUsed()).toBe(0);
  });
  it('首次落账用学习前读数作基准', () => {
    recordTodayHours(152.5, 150);
    expect(readRaw().base).toBe(150);
    expect(todayUsed(152.5)).toBe(2.5);
  });
  it('后续只更新 last，基准不变', () => {
    recordTodayHours(152.5, 150);
    recordTodayHours(155, 0);
    expect(readRaw().base).toBe(150);
    expect(todayUsed(155)).toBe(5);
  });
  it('旧账本迁移时 used 折进基准', () => {
    write({ date: today, used: 0.6 });
    recordTodayHours(10.5, 10);
    expect(todayUsed(10.5)).toBe(1.1);
  });
  it('recordTodayUsed 旧口径累加（有 base 时忽略）', () => {
    write({ date: today, used: 1 });
    recordTodayUsed(0.5);
    expect(todayUsed()).toBe(1.5);
    recordTodayHours(20, 18);
    recordTodayUsed(3);
    // 旧账本 1.5 折进基准(18-1.5=16.5), 新学 20-18=2 → 合计 3.5, 不重复计数
    expect(todayUsed(20)).toBe(3.5);
  });
  it('非法输入不落账', () => {
    recordTodayHours(0);
    recordTodayHours(-1);
    expect(readRaw().date).toBeUndefined();
  });
});

describe('容量口径与零起点', () => {
  afterEach(() => vi.useRealTimers());
  it('周五=工作日(2h), 周六=周末(4h)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:00:00'));   // 周五
    expect(todayCapacity()[0]).toBe(2);
    vi.setSystemTime(new Date('2026-11-07T10:00:00'));   // 周六
    expect(todayCapacity()[0]).toBe(4);
    vi.setSystemTime(new Date('2026-11-08T10:00:00'));   // 周日
    expect(todayCapacity()[0]).toBe(4);
  });
  it('零起点账号: 学习前读数 0 作基准, 增量可见', () => {
    m.clear(); setTodayStorage(mem);
    recordTodayHours(0.3, 0);
    expect(todayUsed(0.3)).toBe(0.3);
  });
});

describe('多账号隔离', () => {
  it('账号 A/B 账本互不影响', () => {
    m.clear(); setTodayStorage(mem);
    recordTodayHours(20, 10, 'accA');
    recordTodayHours(50, 20, 'accB');
    expect(todayUsed(20, 'accA')).toBe(10);
    expect(todayUsed(50, 'accB')).toBe(30);
    // 不传 hourSelf 时读各自账本的 last：A 的 last 不被 B 改写（隔离）
    expect(todayUsed(undefined, 'accA')).toBe(10);
    expect(todayUsed(undefined, 'accB')).toBe(30);
  });
});

// 首页「今日已学」与「学习统计·今日」必须同口径（曾出现 0.0 / 0.5 两个数字）
describe('todayHoursTotal: 今日学时唯一口径', () => {
  it('账本增量与历史当日记录取较大者', () => {
    const today = todayStr();
    expect(todayHoursTotal(0, 'acc-x', { [today]: 0.5 })).toBe(0.5);   // 历史有值、无账本 → 采信历史
    expect(todayHoursTotal(0, 'acc-x', {})).toBe(0);                    // 都没有 → 0
    recordTodayHours(2, 0.5, 'acc-z');                                 // 账本: base 0.5 → 现值 2
    expect(todayHoursTotal(2, 'acc-z', { [today]: 1 })).toBe(1.5);     // 账本增量更大 → 采信账本
  });
});

/** 「完整功能」解锁状态持久化: 刷新/重开控制台后不应回到未解锁 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const mem = new Map<string, string>();
const stub = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const install = () => {
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
};

afterEach(() => {
  vi.resetModules();
  mem.clear();
  // 还原成不可用，避免影响其它测试
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
});

describe('store unlocked 持久化', () => {
  test('首次为未解锁，setState 写入本机存储', async () => {
    install();
    vi.resetModules();
    const m = await import('../../extension/lib/store.js');
    expect(m.getState().unlocked).toBe(false);
    m.setState({ unlocked: true });
    expect(m.getState().unlocked).toBe(true);
    expect(mem.get('mooc.console.unlocked')).toBe('1');
  });

  test('重新载入模块后从本机存储恢复解锁态', async () => {
    install();
    mem.set('mooc.console.unlocked', '1');
    vi.resetModules();
    const m = await import('../../extension/lib/store.js');
    expect(m.getState().unlocked).toBe(true);
  });

  test('显式关闭后写入 0，重新载入为未解锁', async () => {
    install();
    mem.set('mooc.console.unlocked', '1');
    vi.resetModules();
    const m = await import('../../extension/lib/store.js');
    m.setState({ unlocked: false });
    expect(mem.get('mooc.console.unlocked')).toBe('0');
    vi.resetModules();
    const m2 = await import('../../extension/lib/store.js');
    expect(m2.getState().unlocked).toBe(false);
  });
});

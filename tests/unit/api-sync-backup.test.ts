/** 跨标签页状态同步 + 数据备份/导入（无敏感字段） */
import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';
import { getLedger, setTodayStorage } from '../../extension/lib/today.js';

const LS_KEY = 'mooc.console.state.v1';

const memStore = (init: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(), key: () => null, length: 0, dump: () => Object.fromEntries(m),
  } as unknown as Storage & { dump: () => Record<string, string> };
};

/** 假 window: 记录并手动触发 storage 事件 */
const fakeWin = () => {
  const handlers: Record<string, ((e: any) => void)[]> = {};
  return {
    addEventListener: (k: string, fn: (e: any) => void) => { (handlers[k] ||= []).push(fn); },
    fire: (k: string, e: any) => (handlers[k] || []).forEach((fn) => fn(e)),
  };
};

const reply = (data: object, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data });

const makeApi = (opts: { win?: any } = {}) => {
  const storage = memStore();
  const today = memStore();
  setTodayStorage(today);
  const api = createBrowserApi({
    storage, sessionStore: memStore(), win: opts.win, apiOrigin: '',
    fetchImpl: async () => reply({}),
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { close() {} send() {} },
  });
  return { api, storage, today };
};

describe('跨标签页同步', () => {
  it('其它标签写入共享存储后, 本页经 storage 事件重载状态并通知 UI', async () => {
    const win = fakeWin();
    const { api, storage } = makeApi({ win });
    const events: any[] = [];
    api.subscribe((e: any) => events.push(e));

    // 模拟“另一个标签”写入账号
    storage.setItem(LS_KEY, JSON.stringify({
      accounts: [{ key: 'tab2', username: 'u2', displayName: '二号' }],
      tokens: { tab2: { access_token: 't' } }, mode: 'auto', dryRun: false,
      runs: [], activeKey: 'tab2',
    }));
    win.fire('storage', { key: LS_KEY });

    const st = await (await api.fetch('/api/state')).json();
    expect(st.accounts.map((a: any) => a.key)).toEqual(['tab2']);
    expect(events.some((e) => e.type === 'state' && e.external)).toBe(true);
  });

  it('无关 key 的 storage 事件不触发重载', async () => {
    const win = fakeWin();
    const { api } = makeApi({ win });
    const events: any[] = [];
    api.subscribe((e: any) => events.push(e));
    win.fire('storage', { key: 'unrelated' });
    expect(events.filter((e) => e.external).length).toBe(0);
  });
});

describe('数据备份 / 导入', () => {
  it('导出不含密码与 token, 含账号/运行记录/账本', async () => {
    const win = fakeWin();
    const { api, storage, today } = makeApi({ win });
    storage.setItem(LS_KEY, JSON.stringify({
      accounts: [{ key: 'a1', username: '{{PHONE_2upjjnib}}', displayName: '甲' }],
      tokens: { a1: { access_token: 'SECRET-TOKEN' } },
      mode: 'auto', dryRun: false, activeKey: 'a1',
      runs: [{ id: 'r1', label: '学习 X', startedAt: 1, endedAt: 2, status: 'done' }],
    }));
    // 触发一次重载让内存状态与存储一致
    const hist = win;
    hist.fire('storage', { key: LS_KEY });
    today.setItem(`mooc.console.today.v1.a1`, JSON.stringify({ date: '2026-11-06', base: 10, last: 12 }));

    const d = await (await api.fetch('/api/backup')).json();
    expect(d.accounts[0]).toEqual({ key: 'a1', username: '{{PHONE_2upjjnib}}', displayName: '甲' });
    expect(JSON.stringify(d)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(d)).not.toContain('passwords');
    expect(d.runs).toHaveLength(1);
    expect(d.ledgers.a1).toMatchObject({ base: 10, last: 12 });
  });

  it('导入按 key/id 去重合并, 并写入账本', async () => {
    const win = fakeWin();
    const { api, today } = makeApi({ win });
    const payload = {
      version: 1,
      accounts: [{ key: 'a1', username: 'u1', displayName: '甲' }, { key: 'a1', username: 'dup' }],
      runs: [{ id: 'r1', label: 'X', startedAt: 1, status: 'done' }, { id: 'r1', label: 'dup' }],
      ledgers: { a1: { date: '2026-11-06', base: 5, last: 8 } },
    };
    const r = await (await api.fetch('/api/backup/import', { method: 'POST', body: JSON.stringify(payload) })).json();
    expect(r.addedAccounts).toBe(1);
    expect(r.addedRuns).toBe(1);
    expect(getLedger('a1')).toMatchObject({ base: 5, last: 8 });

    // 再导一次: 全部去重
    const r2 = await (await api.fetch('/api/backup/import', { method: 'POST', body: JSON.stringify(payload) })).json();
    expect(r2.addedAccounts).toBe(0);
    expect(r2.addedRuns).toBe(0);
    expect(today).toBeTruthy();
  });
});

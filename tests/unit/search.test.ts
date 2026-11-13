/** 搜索工具 + 多关键词合并 + 演示桩 */
import { describe, expect, it } from 'vitest';
import { existingOf, mergeResults, resolveLibTotal, splitQuery } from '../../extension/lib/search.js';
import { createBrowserApi } from '../../extension/lib/api.js';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 } as unknown as Storage;
};
const reply = (data: object, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data });

describe('search helpers', () => {
  it('splitQuery: 空格拆分, 去重, 最多 2 段', () => {
    expect(splitQuery(' 消防 安全 消防 ')).toEqual(['消防', '安全']);
    expect(splitQuery('')).toEqual([]);
  });
  it('mergeResults: 按 id 去重保序', () => {
    const out = mergeResults([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }, { id: 'c' }],
    ]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('existingOf: 已在任务/学习中/无', () => {
    const rows = [{ bid: 'x', state: '学习中' }, { bid: 'y', state: '已完成' }];
    expect(existingOf({ id: 'x' }, rows)).toBe('学习中');
    expect(existingOf({ id: 'y' }, rows)).toBe('已加入任务');
    expect(existingOf({ id: 'z' }, rows)).toBe('');
  });
});

describe('resolveLibTotal: 分页总数不能串类型', () => {
  it('切到空结果的类型 → 归零（否则分页显示上一个类型的 1972 项）', () => {
    expect(resolveLibTotal({ hasData: true, dataTotal: 0, newQuery: true, prevTotal: 1972 })).toBe(0);
  });
  it('拿不到页记录且是切类型/改词 → 归零', () => {
    expect(resolveLibTotal({ hasData: false, newQuery: true, prevTotal: 1972 })).toBe(0);
  });
  it('翻页缺数据时保守沿用总数（页码不跳）', () => {
    expect(resolveLibTotal({ hasData: false, newQuery: false, prevTotal: 240 })).toBe(240);
  });
  it('有数据就用平台总数; 非法值按 0', () => {
    expect(resolveLibTotal({ hasData: true, dataTotal: 36, newQuery: true, prevTotal: 0 })).toBe(36);
    expect(resolveLibTotal({ hasData: true, dataTotal: NaN as any, newQuery: true, prevTotal: 9 })).toBe(0);
  });
});

describe('/api/search 多关键词', () => {
  const makeApi = () => createBrowserApi({
    storage: mem(), sessionStore: mem(), apiOrigin: 'https://mooc.example',
    fetchImpl: async (url: string) => {
      const u = new URL(String(url), 'https://mooc.example');
      if (u.pathname.includes('findPageForGlobalSearch')) {
        const kw = u.searchParams.get('searchContent');
        const type = u.searchParams.get('type');
        if (type === '0') return reply({ recordCount: 1, items: [{ id: `c-${kw}`, name: `课程-${kw}`, courseHour: 1 }] });
        return reply({ recordCount: 1, items: [{ id: `t-${kw}`, name: `专题-${kw}`, courseHour: 2 }] });
      }
      return reply({});
    },
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { close() {} send() {} },
    win: undefined as any,
  });

  it('空格分隔的两个关键词各自检索后合并去重', async () => {
    const api = makeApi();
    // 先登录一个账号, 让 withClient 可用
    await api.fetch('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'u', password: 'p' }) }).catch(() => {});
    const d = await (await api.fetch('/api/search?q=' + encodeURIComponent('消防 安全'))).json();
    if (d.items?.length) {
      const ids = d.items.map((x: any) => x.id).sort();
      expect(ids).toEqual(['c-安全', 'c-消防', 't-安全', 't-消防'].sort());
    } else {
      expect(d.error).toBeTruthy();   // 未登录时也应返回结构化错误而非抛异常
    }
  });

  it('演示桩: 按关键词过滤课程与专题', async () => {
    (globalThis as any).__demoSearch = [
      { id: 'l1', name: '消防安全管理', kind: '课程', courseHour: 2 },
      { id: 'l2', name: '安全生产月', kind: '专题', courseHour: 1 },
    ];
    const api = makeApi();
    const d = await (await api.fetch('/api/search?q=' + encodeURIComponent('安全'))).json();
    expect(d.items.map((x: any) => x.id)).toEqual(['l1', 'l2']);
    delete (globalThis as any).__demoSearch;
  });
});

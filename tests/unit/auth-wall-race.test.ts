// @ts-nocheck —— 测试桩动态结构
/** 「刚登录就说登录态失效」: 旧令牌的迟到 401 不能给新令牌落标记 + 横幅只对激活账号显示 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';
import { readNeedLogin, wallBannerVisible } from '../../extension/lib/needLogin.js';

const LS_KEY = 'mooc.console.state.v1';

function memStore(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: any) => m.set(k, String(v)),
    removeItem: (k: string) => m.delete(k),
  };
}

const reply = (data: any, status = 200) => ({
  status, ok: status < 400, text: async () => JSON.stringify(data), json: async () => data,
});

function makeApi(fetchImpl: any) {
  const storage = memStore({
    [LS_KEY]: JSON.stringify({
      accounts: [{ key: 'u1', username: 'u1', displayName: '甲', active: true }],
      tokens: { u1: { access_token: 'T-OLD', obtainedAt: Date.now(), source: 'password' } },
      mode: 'auto', dryRun: false, runs: [], activeKey: 'u1',
    }),
  });
  // sessionStore 故意不放密码: 模拟「这个上下文没法自动换发」的分支
  const api = createBrowserApi({
    storage,
    sessionStore: memStore(),
    fetchImpl,
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { close() {} send() {} },
    win: undefined as any,
  });
  return api;
}

beforeEach(() => {
  globalThis.localStorage = memStore();
  globalThis.sessionStorage = memStore();
});

test('登录竞态: 旧令牌在飞的 401 不落标记（新令牌是好的）', async () => {
  let release: (v: any) => void = () => {};
  const pending = new Promise<any>((r) => { release = r; });
  const api = makeApi(() => pending);
  const p = api.fetch('/api/overview').catch(() => null);

  // 请求还在飞的时候「账密登录成功」: 令牌被换掉
  (api as any).state.tokens.u1 = { access_token: 'T-NEW', obtainedAt: Date.now(), source: 'password' };
  release(reply({ errorCode: 90901 }, 401));
  await p;

  assert.equal(await readNeedLogin(), null, '旧令牌的 401 不能给新登录的账号写失效标记');
  assert.equal((api as any).state.tokens.u1.access_token, 'T-NEW', '新令牌不能被删除');
});

test('令牌没换过时, 401 仍然要落标记（别把检测关掉）', async () => {
  const api = makeApi(async () => reply({ errorCode: 90901 }, 401));
  await api.fetch('/api/overview').catch(() => null);
  // markNeedLogin 是 fire-and-forget, 等它落地
  let wall = await readNeedLogin();
  for (let i = 0; i < 30 && !wall; i++) {
    await new Promise((r) => setTimeout(r, 10));
    wall = await readNeedLogin();
  }
  assert.ok(wall, '当前令牌被拒 → 必须记录');
  assert.equal(wall!.account, 'u1');
});

test('wallBannerVisible: 只有激活账号的失效才弹横幅', () => {
  const wall = { at: Date.now(), why: '平台接口返回 401', account: 'u1' };
  assert.equal(wallBannerVisible(wall, 'u1', ['u1', 'u2']), true);
  assert.equal(wallBannerVisible(wall, 'u2', ['u1', 'u2']), false, '别家失效不该吓唬正在用 u2 的人');
  assert.equal(wallBannerVisible(wall, 'u1', ['u2']), false, '标记指向已删除的账号 → 作废');
  assert.equal(wallBannerVisible({ ...wall, dismissed: true }, 'u1', ['u1']), false);
  assert.equal(wallBannerVisible({ at: Date.now(), why: '平台跳转到登录页' }, 'u1', ['u1']), true, '无归属=全局提醒');
  assert.equal(wallBannerVisible(null, 'u1', ['u1']), false);
});

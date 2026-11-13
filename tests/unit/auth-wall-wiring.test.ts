// @ts-nocheck —— 测试桩动态结构, 类型检查豁免
/**
 * 接线级测试: 平台拒绝令牌后, **保管箱里的令牌必须真的消失**, 且落「需重新登录」标记。
 * 这条路径以前是「删了又被 save() 写回」(review-loop 第二轮 Critical), 只测纯函数抓不住。
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';
import { allTokens } from '../../extension/lib/vault.js';
import { readNeedLogin, clearNeedLogin } from '../../extension/lib/needLogin.js';

function memStore() {
  const m = new Map();
  return {
    _m: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假平台: mode='ok' 正常; mode='reject' 数据接口 401、登录接口 422（密码已改的典型场景） */
function fakePlatform() {
  const cfg = { mode: 'ok' };
  const reply = (data, status = 200) => ({
    status, ok: status < 400, text: async () => JSON.stringify(data), json: async () => data,
  });
  const fetchImpl = async (path) => {
    const p = String(path).split('?')[0];
    if (p === '/oauth/api/v1/app-login') {
      return cfg.mode === 'reject' ? reply({ errorCode: '90908', message: '账号或密码不正确' }, 422) : reply({ access_token: 'tok-1', expires_in: 2592000 });
    }
    if (p === '/api/v1/human/member/center') return reply({ fullName: '测试用户' });
    if (cfg.mode === 'reject') return reply({ message: '登录态已失效' }, 401);
    return reply({});
  };
  return { fetchImpl, cfg };
}

beforeEach(async () => {
  globalThis.localStorage = memStore();
  globalThis.sessionStorage = memStore();
  globalThis.localStorage.removeItem('mooc.needLogin');   // 测试环境无 chrome, needLogin 退回 localStorage
});

test('平台拒绝令牌 → 保管箱里的令牌被真正删除 + 落「需重新登录」标记', async () => {
  const { fetchImpl, cfg } = fakePlatform();
  const api = createBrowserApi({
    storage: memStore(),
    sessionStore: memStore(),
    fetchImpl,
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { close() {} send() {} },
    apiOrigin: '',
  });

  await api.fetch('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'u1', password: 'pw' }) });
  await sleep(30);                                   // flushTokens 是后台异步写
  assert.deepEqual(Object.keys(await allTokens()), ['u1'], '登录后令牌应落在保管箱');

  cfg.mode = 'reject';                               // 平台开始拒: 数据 401 + 重新登录 422
  await api.consoleApi.overview().catch(() => {});
  await sleep(80);                                   // 等 dropToken / flushTokens 落地

  assert.deepEqual(await allTokens(), {}, '被拒的令牌不能留在保管箱（否则图标会一直是彩色）');
  const wall = await readNeedLogin();
  assert.equal(wall?.account, 'u1', '标记要指向失败的账号');
  await clearNeedLogin();
});

test('网络故障不算登录墙: 令牌保留, 不落标记', async () => {
  const { fetchImpl } = fakePlatform();
  const api = createBrowserApi({
    storage: memStore(),
    sessionStore: memStore(),
    fetchImpl: async (path, init) => {
      if (String(path).includes('app-login')) return fetchImpl(path, init);
      throw new TypeError('fetch failed');
    },
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { close() {} send() {} },
    apiOrigin: '',
  });

  await api.fetch('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'u2', password: 'pw' }) });
  await sleep(30);
  await api.consoleApi.overview().catch(() => {});
  await sleep(50);

  assert.deepEqual(Object.keys(await allTokens()), ['u2'], '网络错误不能删令牌');
  assert.equal(await readNeedLogin(), null, '网络错误不能误标成登录失效');
});

// @ts-nocheck —— 测试桩动态结构
/** 账号身份: 档案同步只能改展示信息, 不能覆盖登录名（手机号/userid） */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const reply = (data, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(data), json: async () => data });

function makeApi() {
  const fetchImpl = async (path) => {
    const p = String(path).split('?')[0];
    if (p === '/oauth/api/v1/app-login') return reply({ access_token: 'tok', expires_in: 2592000 });
    if (p === '/api/v1/human/member/center') return reply({ fullName: '张三' });
    return reply({});
  };
  return createBrowserApi({
    storage: memStore(), sessionStore: memStore(), fetchImpl,
    sleepFn: () => Promise.resolve(), WebSocketImpl: class { close() {} send() {} }, apiOrigin: '',
  });
}

test('syncProfile: 只改 displayName, 登录名(username)保持不变', async () => {
  const api = makeApi();
  await api.fetch('/api/accounts', { method: 'POST', body: JSON.stringify({ username: '13900001234', password: 'pw' }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(api.state.accounts[0].username, '13900001234');

  await api.consoleApi.syncProfile();
  const a = api.state.accounts[0];
  assert.equal(a.displayName, '张三', '姓名应更新到 displayName');
  assert.equal(a.username, '13900001234', '登录名不能被姓名覆盖（否则自动续期会用姓名登录）');
});

// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 凭据保管箱 + 令牌到期换发（有效期按 expires_in 算, 各登录方式不同）: ensureFresh / adoptCreds / vault round-trip */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';
import { allCreds, dropCred, formatTtl, putCred, renewWithinMs, tokenLifetimeLeft, tokenTtlMs } from '../../extension/lib/vault.js';

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// vault 无扩展存储时退回 globalThis.localStorage —— 测试环境补一个内存桩
globalThis.localStorage = memStore();
globalThis.sessionStorage = memStore();

/** 假平台: 登录可控（成功/密码错/网络故障）, cfg.loginMode 可运行时切换 */
function fakePlatform({ loginMode = 'ok' } = {}) {
  const calls = [];
  const cfg = { loginMode };
  const reply = (data, status = 200) => ({
    status, ok: status < 400, text: async () => JSON.stringify(data), json: async () => data,
  });
  const fetchImpl = async (path, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ path, method, body: init.body ? String(init.body) : null });
    const p = path.split('?')[0];
    if (p === '/oauth/api/v1/app-login') {
      if (cfg.loginMode === 'network') throw new TypeError('fetch failed');
      if (cfg.loginMode === 'badpw') return reply({ errorCode: '90908', message: '登录失败' }, 422);
      return reply({ access_token: 'tok', token_type: 'Bearer' });
    }
    if (p === '/api/v1/human/member/center') return reply({ fullName: '陈学新' });
    return reply({}, 404);
  };
  return { fetchImpl, calls, cfg };
}

function makeApi(opts = {}) {
  const { fetchImpl, calls, cfg } = fakePlatform(opts);
  const api = createBrowserApi({
    storage: memStore(),
    sessionStore: memStore(),
    fetchImpl,
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { constructor() {} close() {} send() {} },
    apiOrigin: '',
  });
  return { api, calls, cfg };
}

const loginCalls = (calls) => calls.filter((c) => c.path.includes('app-login')).length;

/** 登录一个账号并返回 key */
async function seedAccount(api) {
  const res = await api.fetch('/api/accounts', {
    method: 'POST', body: JSON.stringify({ username: '13800138000', password: 'pw' }),
  });
  assert.equal(res.status, 200);
  return api.state.accounts[0].key;
}

test('ensureFresh: 令牌快到期 → 用保管箱密码重登换新', async () => {
  const { api, calls } = makeApi();
  const key = await seedAccount(api);
  const before = loginCalls(calls);
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 30 * 86400, obtainedAt: Date.now() - 29 * 864e5 };
  const r = await api.ensureFresh();
  assert.deepEqual(r.renewed, [key]);
  assert.deepEqual(r.failed, []);
  assert.equal(loginCalls(calls), before + 1, '应重新调用 login');
  assert.ok(api.state.tokens[key].obtainedAt > Date.now() - 60_000, '应写入新的 obtainedAt');
});

test('ensureFresh: 令牌还有充足寿命 → 不调用 login', async () => {
  const { api, calls } = makeApi();
  const key = await seedAccount(api);
  const before = loginCalls(calls);
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 30 * 86400, obtainedAt: Date.now() };
  const r = await api.ensureFresh();
  assert.deepEqual(r.renewed, []);
  assert.deepEqual(r.failed, []);
  assert.equal(loginCalls(calls), before, '不应重新登录');
});

test('ensureFresh: 登录失败（鉴权被拒）→ 清掉该账号密码', async () => {
  const { api, cfg } = makeApi();
  const key = await seedAccount(api);
  cfg.loginMode = 'badpw';
  await putCred(key, 'pw');                       // 保管箱里也有, 应一并清掉
  api.state.passwords[key] = 'pw';
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 30 * 86400, obtainedAt: Date.now() - 29 * 864e5 };
  const r = await api.ensureFresh();
  assert.deepEqual(r.failed, [key]);
  assert.equal(api.state.passwords[key], undefined, '密码应被清除');
  await new Promise((r) => setTimeout(r, 0));   // dropCred 是 void 异步, 先让微任务跑完
  assert.deepEqual(await allCreds(), {}, '保管箱凭据应被清除');
});

test('ensureFresh: 网络错误 → 保留凭据, 不清密码', async () => {
  const { api, cfg } = makeApi();
  const key = await seedAccount(api);
  cfg.loginMode = 'network';
  api.state.passwords[key] = 'pw';
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 30 * 86400, obtainedAt: Date.now() - 29 * 864e5 };
  const r = await api.ensureFresh();
  assert.deepEqual(r.renewed, []);
  assert.deepEqual(r.failed, [], '网络错误不算换发失败');
  assert.equal(api.state.passwords[key], 'pw', '网络错误不应清除密码');
});

test('adoptCreds: 只给已存在且缺密码的账号补齐', async () => {
  const { api } = makeApi();
  const key = await seedAccount(api);
  delete api.state.passwords[key];
  const keys = api.adoptCreds({ [key]: 'restored', nobody: 'x' });
  assert.equal(api.state.passwords[key], 'restored');
  assert.equal(api.state.passwords.nobody, undefined, '不存在的账号不应写入');
  assert.ok(keys.includes(key));
});

test('vault: putCred / dropCred / allCreds round-trip', async () => {
  await dropCred('a');
  await putCred('a', 'pw-a');
  await putCred('b', 'pw-b');
  assert.deepEqual(await allCreds(), { a: 'pw-a', b: 'pw-b' });
  await putCred('a', 'pw-a2');
  assert.equal((await allCreds()).a, 'pw-a2');
  await dropCred('a');
  assert.deepEqual(await allCreds(), { b: 'pw-b' });
});

test('tokenLifetimeLeft: 已知 obtainedAt/expires_in', () => {
  const t0 = 1_000_000;
  assert.equal(tokenLifetimeLeft({ expires_in: 3600, obtainedAt: t0 }, t0 + 600_000), 3_000_000);
  assert.equal(tokenLifetimeLeft({ expires_in: 3600, login_time: t0 }, t0 + 600_000), 3_000_000);
  assert.equal(tokenLifetimeLeft({}, t0), null, '无 expires_in 返回 null');
});

test('ensureFresh: 短寿命令牌（扫码 7 天）刚登录 → 不触发换发', async () => {
  const { api, calls } = makeApi();
  const key = await seedAccount(api);
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 7 * 86400, obtainedAt: Date.now(), source: 'qr-app' };
  const before = loginCalls(calls);
  const r = await api.ensureFresh();
  assert.deepEqual(r.renewed, [], '固定 7 天阈值会把它误判成快到期');
  assert.equal(loginCalls(calls), before, '不应白登一次');
});

test('ensureFresh: 短寿命令牌剩 1 天 → 进入换发窗口', async () => {
  const { api, calls } = makeApi();
  const key = await seedAccount(api);
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 7 * 86400, obtainedAt: Date.now() - 6 * 864e5 };
  const before = loginCalls(calls);
  const r = await api.ensureFresh();
  assert.deepEqual(r.renewed, [key]);
  assert.equal(loginCalls(calls), before + 1);
});

test('ensureFresh: 扫码账号（无密码）未过期 → 不报失败, 也不换发', async () => {
  const { api, calls } = makeApi();
  const key = await seedAccount(api);
  delete api.state.passwords[key];
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 7 * 86400, obtainedAt: Date.now() - 6.5 * 864e5, source: 'qr-wechat' };
  const before = loginCalls(calls);
  const r = await api.ensureFresh();
  assert.deepEqual(r.failed, [], '没密码不等于换发失败');
  assert.deepEqual(r.needsLogin, []);
  assert.deepEqual(r.renewed, []);
  assert.equal(loginCalls(calls), before);
});

test('ensureFresh: 扫码账号已过期 → needsLogin（提示重新扫码）', async () => {
  const { api } = makeApi();
  const key = await seedAccount(api);
  delete api.state.passwords[key];
  api.state.tokens[key] = { ...api.state.tokens[key], expires_in: 7 * 86400, obtainedAt: Date.now() - 8 * 864e5, source: 'qr-app' };
  const r = await api.ensureFresh();
  assert.deepEqual(r.needsLogin, [key]);
  assert.deepEqual(r.failed, []);
});

test('ensureFresh: 没有 expires_in（官网导入）→ 不预判, 交给 401', async () => {
  const { api, calls } = makeApi();
  const key = await seedAccount(api);
  api.state.tokens[key] = { access_token: 'tok', token_type: 'Bearer', obtainedAt: Date.now() - 90 * 864e5, source: 'import' };
  const before = loginCalls(calls);
  const r = await api.ensureFresh();
  assert.deepEqual(r.renewed, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.needsLogin, [], '寿命未知时不要误报「已过期」');
  assert.equal(loginCalls(calls), before);
});

test('tokenTtlMs / renewWithinMs: 窗口按令牌实际寿命算', () => {
  assert.equal(tokenTtlMs({ expires_in: 30 * 86400 }), 30 * 864e5);
  assert.equal(tokenTtlMs({ expires_in: 0 }), null);
  assert.equal(tokenTtlMs({}), null);
  assert.equal(renewWithinMs({ expires_in: 30 * 86400 }), 6 * 864e5, '30 天的 20% = 6 天');
  assert.equal(renewWithinMs({ expires_in: 7 * 86400 }), 120_960_000, '7 天的 20% = 1.4 天');
  assert.equal(renewWithinMs({ expires_in: 3600 }), 30 * 60e3, '短寿命保底 30 分钟');
  assert.equal(renewWithinMs({}), null);
});

test('实测值回归: 扫码令牌（APP/微信通道均 14400 = 4 小时, 无 refresh_token）', () => {
  const tok = { expires_in: 14400, obtainedAt: Date.now(), source: 'qr-wechat' };
  assert.equal(tokenTtlMs(tok), 4 * 36e5);
  assert.equal(renewWithinMs(tok), 48 * 6e4, '4 小时的 20% = 48 分钟');
  assert.equal(formatTtl(tokenTtlMs(tok)), '4 小时', '账号卡片应显示「登录态剩余 4 小时」');
});

test('formatTtl: 天 / 小时 / 未知', () => {
  assert.equal(formatTtl(6 * 864e5), '6 天');
  assert.equal(formatTtl(2 * 36e5), '2 小时');
  assert.equal(formatTtl(45 * 6e4), '45 分钟');
  assert.equal(formatTtl(null), '未知');
});

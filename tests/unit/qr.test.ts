// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 扫码登录: /api/qr/issue + /api/qr/check 双通道（离线桩平台） */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** 桩平台: APP 通道第 2 次轮询授权; 微信通道走 checkUUIDStatus + weChat-auth */
function fakePlatform({ appScanOn = 2, wechatIssueFail = false } = {}) {
  const calls = [];
  let appPolls = 0;
  const reply = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data });
  const fetchImpl = async (path, init = {}) => {
    const p = path.split('?')[0];
    calls.push(p);
    if (p === '/oauth/api/v1/deriveQRCode') return reply({ uuid: 'app-uuid-1', data: 'aGk=' });
    if (p === '/oauth/api/v1/createQRCode') {
      if (wechatIssueFail) return reply({ message: 'busy' }, 500);
      return reply({ uuid: new URLSearchParams(path.split('?')[1]).get('uuid') });
    }
    if (p === '/oauth/api/v1/loginCheck') {
      appPolls++;
      return appPolls >= appScanOn ? reply({ access_token: 'tok-app', userid: 'u9' }) : reply({}, 200);
    }
    if (p === '/oauth/api/v1/checkUUIDStatus') return reply({ status: 1, openId: 'openid-7' });
    if (p === '/oauth/api/v1/weChat-auth') return reply({ access_token: 'tok-wx', userid: 'u8' });
    if (p === '/api/v1/human/member/center') return reply({ fullName: '扫码用户' });
    return reply({}, 404);
  };
  return { fetchImpl, calls };
}

const makeApi = (opts) => {
  const { fetchImpl, calls } = fakePlatform(opts);
  const api = createBrowserApi({
    storage: memStore(), sessionStore: memStore(), fetchImpl,
    sleepFn: () => Promise.resolve(), WebSocketImpl: class { close() {} send() {} }, apiOrigin: '',
  });
  return { api, calls };
};

test('APP 扫码: issue 出图, check 未扫→已扫并注册账号', async () => {
  const { api } = makeApi();
  const issue = await (await api.fetch('/api/qr/issue?kind=app')).json();
  assert.equal(issue.kind, 'app');
  assert.equal(issue.uuid, 'app-uuid-1');
  assert.match(issue.png, /^data:image\/png;base64,/);
  const w1 = await (await api.fetch(`/api/qr/check?kind=app&uuid=${issue.uuid}`)).json();
  assert.equal(w1.done, false);
  const w2 = await (await api.fetch(`/api/qr/check?kind=app&uuid=${issue.uuid}`)).json();
  assert.equal(w2.done, true);
  const acc = w2.accounts.find((a) => a.key === 'u9');
  assert.ok(acc, '扫码成功应注册账号');
  assert.equal(acc.displayName, '扫码用户');
  const st = await (await api.fetch('/api/state')).json();
  assert.equal(st.accounts.find((a) => a.active).key, 'u9');
});

test('微信扫码: 本地渲染码内容, checkUUIDStatus+weChat-auth 换票', async () => {
  const { api, calls } = makeApi();
  const issue = await (await api.fetch('/api/qr/issue?kind=wechat')).json();
  assert.match(issue.png, /^data:image\/gif;base64,/);
  const st = await (await api.fetch(`/api/qr/check?kind=wechat&uuid=${issue.uuid}`)).json();
  assert.equal(st.done, true);
  assert.ok(calls.includes('/oauth/api/v1/weChat-auth'), '应调用 weChat-auth 换票');
  const st2 = await (await api.fetch('/api/state')).json();
  assert.equal(st2.accounts.find((a) => a.active).key, 'u8');
});

test('扫码会话防错配: 未知 uuid 返回 404', async () => {
  const { api } = makeApi();
  const res = await api.fetch('/api/qr/check?kind=app&uuid=nope');
  assert.equal(res.status, 404);
});

test('默认源站: 未传 apiOrigin 时请求探测到的平台源站', async () => {
  const urls: string[] = [];
  const api = createBrowserApi({
    storage: memStore(), sessionStore: memStore(), apiOrigin: 'https://mooc.ctt.cn',
    fetchImpl: async (url: any) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ uuid: 'u1', data: 'aGk=' }), json: async () => ({ uuid: 'u1', data: 'aGk=' }) };
    },
    sleepFn: () => Promise.resolve(), WebSocketImpl: class { close() {} send() {} },
  });
  await api.fetch('/api/qr/issue?kind=app');
  assert.ok(urls.some((u) => u.startsWith('https://mooc.ctt.cn/oauth/api/v1/deriveQRCode')), `实际请求: ${urls.join(',')}`);
});

test('微信取码: 平台登记失败时返回错误而不是死码', async () => {
  const { api } = makeApi({ wechatIssueFail: true });
  const res = await api.fetch('/api/qr/issue?kind=wechat');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(String(body.error), /微信取码失败/);
  assert.equal(body.png, undefined);
});

// @ts-nocheck —— 纯函数测试, 语法上允许 window 相关桩
/** 「重新登录」入口: 地址构造 / 深链判定 / 参数清理 / 预填账号 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { consoleUrl, prefillForAccount, stripLogin, wantsLogin } from '../../extension/lib/loginEntry.js';

const BASE = 'chrome-extension://abc/console.html';

test('consoleUrl: login/onboard 两种深链参数, 都不带多余问号', () => {
  assert.equal(consoleUrl(BASE), BASE);
  assert.equal(consoleUrl(BASE, { login: true }), `${BASE}?login=1`);
  assert.equal(consoleUrl(BASE, { onboard: true }), `${BASE}?onboard=1`);
  assert.equal(consoleUrl(BASE, { login: true, onboard: true }), `${BASE}?login=1&onboard=1`);
});

test('wantsLogin: 只认 login=1', () => {
  assert.equal(wantsLogin('?login=1'), true);
  assert.equal(wantsLogin('?onboard=1&login=1#/settings'), true);
  assert.equal(wantsLogin('?login=0'), false);
  assert.equal(wantsLogin('?onboard=1'), false);
  assert.equal(wantsLogin(''), false);
  assert.equal(wantsLogin('#/report'), false);
});

test('stripLogin: 只摘 login, 保留其它 query 与 hash', () => {
  assert.equal(stripLogin(`${BASE}?login=1`), BASE);
  assert.equal(stripLogin(`${BASE}?login=1&onboard=1#/settings`), `${BASE}?onboard=1#/settings`);
  // 没有该参数时原样返回（不要顺手重排 URL）
  const url = `${BASE}?onboard=1#/report`;
  assert.equal(stripLogin(url), url);
});

test('prefillForAccount: 只给账密账号预填（key === username）', () => {
  assert.equal(prefillForAccount({ key: '15980250706', username: '15980250706' }), '15980250706');
  // 扫码账号: key 是 userid / uuid, username 是姓名 → 预填会让用户以姓名新建重复账号
  assert.equal(prefillForAccount({ key: 'a1b2-uuid', username: '陈学新', displayName: '陈学新' }), '');
  assert.equal(prefillForAccount({ key: 'u1', username: '' }), '');
  assert.equal(prefillForAccount({ key: '', username: 'u1' }), '');
  assert.equal(prefillForAccount(null), '');
  assert.equal(prefillForAccount(undefined), '');
});

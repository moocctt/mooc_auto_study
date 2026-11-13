// @ts-nocheck —— 测试桩动态结构, 类型检查豁免
/** 工具栏图标/角标决策: 账号级可用性、被拒账号的归属、角标优先级 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { accountUsable, authUi, loginState, tokenUsableAt } from '../../extension/lib/iconState.js';

const NOW = 1_700_000_000_000;
const tok = (expiresIn = 14400, obtainedAt = NOW - 60_000) => ({ access_token: 't', expires_in: expiresIn, obtainedAt });

test('tokenUsableAt: 按 expires_in 判过期（扫码 4 小时）', () => {
  assert.equal(tokenUsableAt(tok(14400), NOW), true);
  assert.equal(tokenUsableAt({ access_token: 't', expires_in: 14400, obtainedAt: NOW - 5 * 3600e3 }, NOW), false);
  assert.equal(tokenUsableAt({ access_token: 't', expires_in: 2592000, obtainedAt: NOW - 86400e3 }, NOW), true);
});

test('tokenUsableAt: 平台没给有效期/没给取得时间 → 不预判（交给 401 兜底）', () => {
  assert.equal(tokenUsableAt({ access_token: 't', obtainedAt: NOW - 365 * 86400e3 }, NOW), true);
  assert.equal(tokenUsableAt({ access_token: 't', expires_in: 60 }, NOW), true);
  assert.equal(tokenUsableAt({ access_token: 't', expires_in: -1 }, NOW), true);
  assert.equal(tokenUsableAt({ access_token: 't', expires_in: 60, obtainedAt: NOW + 86400e3 }, NOW), true);
});

test('tokenUsableAt: 空值/缺 access_token → 不可用', () => {
  assert.equal(tokenUsableAt(null, NOW), false);
  assert.equal(tokenUsableAt({}, NOW), false);
  assert.equal(tokenUsableAt({ expires_in: 14400 }, NOW), false);
});

test('loginState: 无令牌 = none，全部过期 = expired，任一家可用 = ok', () => {
  assert.equal(loginState(null, NOW), 'none');
  assert.equal(loginState({}, NOW), 'none');
  assert.equal(loginState({ 'user-a': { access_token: 't', expires_in: 60, obtainedAt: NOW - 3600e3 } }, NOW), 'expired');
  assert.equal(loginState({
    'user-a': { access_token: 'a', expires_in: 60, obtainedAt: NOW - 3600e3 },
    'user-b': tok(14400),
  }, NOW), 'ok');
});

test('accountUsable: 被平台拒过且之后没换发 → 不可用; 换发后自动愈合', () => {
  const wall = { at: NOW, account: 'user-b' };
  // 令牌是 1 分钟前取的, 标记比它新 → 这家不算可用
  assert.equal(accountUsable(tok(14400, NOW - 60_000), wall, 'user-b', NOW), false);
  // 换发拿到新令牌（obtainedAt 晚于标记）→ 又可用
  assert.equal(accountUsable(tok(14400, NOW + 1000), wall, 'user-b', NOW), true);
  // 标记记的是别家, 不影响这家
  assert.equal(accountUsable(tok(14400), wall, 'user-a', NOW), true);
});

test('loginState: 按激活账号判定 —— 激活的那家被拒就是 expired, 别家可用也不兜底', () => {
  const tokens = { 'user-a': tok(2592000), 'user-b': tok(14400) };
  assert.equal(loginState(tokens, NOW, { at: NOW, account: 'user-b' }, 'user-b'), 'expired');
  // 激活的是 a → 仍是 ok
  assert.equal(loginState(tokens, NOW, { at: NOW, account: 'user-b' }, 'user-a'), 'ok');
  // 没有激活线索（旧数据）才退化成「有任意一家可用」
  assert.equal(loginState(tokens, NOW, null, ''), 'ok');
});

test('authUi: 别的账号被拒 + 当前账号可用 → 彩色, 且不亮红点', () => {
  const ui = authUi({
    tokens: { 'user-a': tok(2592000), 'user-b': tok(14400) },
    wall: { at: NOW, account: 'user-b' },
    activeKey: 'user-a',
  }, NOW);
  assert.deepEqual(ui, { grey: false, title: '', badge: 'off' });
});

test('authUi: 激活账号被拒 → 置灰 + 红点（多账号是「一次只激活一个」）', () => {
  const ui = authUi({
    tokens: { 'user-a': tok(2592000), 'user-b': tok(14400) },
    wall: { at: NOW, account: 'user-b' },
    activeKey: 'user-b',
  }, NOW);
  assert.equal(ui.grey, true, '激活账号失效就必须置灰, 别家可用也不能冒充能用');
  assert.equal(ui.badge, 'alert');
  assert.equal(ui.title, '登录态已失效 · 点击重新登录');
});

test('authUi: 激活账号过期、别家可用 → 灰 + 提示可以切换账号', () => {
  const ui = authUi({
    tokens: {
      'user-a': { access_token: 'a', expires_in: 60, obtainedAt: NOW - 3600e3 },   // 激活且 expired
      'user-b': tok(2592000),
    },
    activeKey: 'user-a',
  }, NOW);
  assert.equal(ui.grey, true);
  assert.equal(ui.badge, 'alert');
  assert.match(ui.title, /切换账号/);
});

test('authUi: 全员失效 → 灰色 + 红点 + 失效文案', () => {
  const ui = authUi({
    tokens: { 'user-b': { access_token: 't', expires_in: 60, obtainedAt: NOW - 3600e3 } },
    wall: null,
    activeKey: 'user-b',
  }, NOW);
  assert.deepEqual(ui, { grey: true, title: '登录态已过期 · 点击重新登录', badge: 'alert' });
});

test('authUi: 从未登录 → 灰色但没有红点（不吓唬刚装好的用户）', () => {
  assert.deepEqual(authUi({ tokens: {}, wall: null }, NOW), { grey: true, title: '未登录 · 点击登录', badge: 'off' });
  assert.deepEqual(authUi({ tokens: null, wall: null }, NOW).badge, 'off');
});

test('authUi: 有标记时文案统一为「已失效」, 即使令牌只是过期', () => {
  const ui = authUi({
    tokens: { 'user-a': { access_token: 't', expires_in: 60, obtainedAt: NOW - 3600e3 } },
    wall: { at: NOW, account: 'user-a' },
  }, NOW);
  assert.equal(ui.title, '登录态已失效 · 点击重新登录');
  assert.equal(ui.badge, 'alert');
});

test('authUi: 值守运行中 → ▶/…, 但失效优先于运行态', () => {
  const playing = authUi({ tokens: { a: tok(2592000) }, apOn: true, apPlaying: true }, NOW);
  assert.deepEqual(playing, { grey: false, title: '', badge: 'playing' });
  const busy = authUi({ tokens: { a: tok(2592000) }, apOn: true, apPlaying: false }, NOW);
  assert.equal(busy.badge, 'busy');

  const alert = authUi({
    tokens: { a: tok(2592000) },
    wall: { at: NOW, account: 'a' },
    activeKey: 'a',
    apOn: true,
    apPlaying: true,
  }, NOW);
  assert.equal(alert.badge, 'alert', '失效必须压过运行态, 否则用户看不到要重新登录');
});

test('authUi: 令牌被删空但还留着标记 → 仍是「失效」+ 红点（不能退化成未登录）', () => {
  const ui = authUi({ tokens: {}, wall: { at: NOW, account: 'user-a' }, activeKey: 'user-a' }, NOW);
  assert.equal(ui.grey, true);
  assert.equal(ui.badge, 'alert');
  assert.equal(ui.title, '登录态已失效 · 点击重新登录');
});

test('authUi: 激活账号已删（activeKey 不在 tokens 里）→ 不能悄悄换成别家变彩色', () => {
  const ui = authUi({
    tokens: { 'user-b': tok(2592000) },      // 只剩 B 的令牌
    activeKey: 'user-a',                      // 但用户还在 A 上操作
  }, NOW);
  assert.equal(ui.grey, true, '激活账号没有令牌 = 不可用, 别家的令牌不能冒充');
  assert.equal(ui.badge, 'alert');
});

test('authUi: 旧标记 + 该账号已换发新令牌 → 自动恢复彩色', () => {
  const ui = authUi({
    tokens: { a: tok(2592000, NOW + 5000) },   // 换发时间晚于标记
    wall: { at: NOW, account: 'a' },
    activeKey: 'a',
  }, NOW);
  assert.equal(ui.grey, false);
  assert.equal(ui.badge, 'off');
});

// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 登录态失效标记: 登录墙识别 + 标记读写（值守遇 4 小时扫码令牌过期就靠它停下来） */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import { isLoginWallError } from '../../extension/lib/needLogin.js';

function memArea() {
  const m = new Map();
  return {
    _m: m,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (m.has(String(k))) out[String(k)] = m.get(String(k));
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items)) m.set(k, v); },
    async remove(k) { m.delete(String(k)); },
  };
}

const local = memArea();
globalThis.chrome = { storage: { local } };

const { NEED_LOGIN_KEY, clearNeedLogin, detectLoginWall, markNeedLogin, readNeedLogin } =
  await import('../../extension/lib/needLogin.js');

beforeEach(() => { local._m.clear(); });

/* ── 登录墙识别 ─────────────────────────────────────────── */

test('detectLoginWall: 正常学习页不误判', () => {
  assert.equal(detectLoginWall({
    href: 'https://mooc.ctt.cn/#/study/course/detail/1&abc123',
    hash: '#/study/course/detail/1&abc123',
    pathname: '/',
    bodyText: '第一节: 烟草专卖法 视频 学习中 剩余 12:30',
  }), '');
});

test('detectLoginWall: 平台 oauth 登录页（主站 oauth/#login/<b64>）', () => {
  assert.equal(detectLoginWall({ pathname: '/oauth', hash: '#login/eyJyZXNw', bodyText: '' }), '平台跳转到登录页');
  assert.equal(detectLoginWall({ hash: '#login/abc', bodyText: '' }), '平台跳转到登录页');
  assert.equal(detectLoginWall({ hash: '#/login', bodyText: '' }), '平台跳转到登录页');
});

test('detectLoginWall: 平台文案（401 弹窗）', () => {
  assert.equal(
    detectLoginWall({ hash: '#/study/course/detail/1&abc', bodyText: '登录已失效，请重新登录' }),
    '平台提示登录已失效',
  );
  assert.equal(detectLoginWall({ bodyText: '用户未登录' }), '平台提示登录已失效');
});

test('detectLoginWall: SPA 换出登录表单（路由没变但表单在）', () => {
  assert.equal(
    detectLoginWall({ hash: '#/study/course/detail/1&abc', bodyText: '请登录', hasLoginForm: true }),
    '页面出现登录表单',
  );
  // 「请先登录」已在文案规则里命中, 表单是兜底
  assert.equal(detectLoginWall({ hasLoginForm: true }), '页面出现登录表单');
});

/* ── 标记读写 ───────────────────────────────────────────── */

test('markNeedLogin / readNeedLogin / clearNeedLogin: 往返', async () => {
  assert.equal(await readNeedLogin(), null);
  const rec = await markNeedLogin('平台接口返回 401', { url: 'https://mooc.ctt.cn/#/study/course/detail/1&abc' });
  assert.ok(rec && rec.at > 0);
  assert.equal(local._m.has(NEED_LOGIN_KEY), true, '落在保管箱同层存储, 网页脚本读不到');

  const got = await readNeedLogin();
  assert.equal(got.why, '平台接口返回 401');
  assert.match(got.url, /course\/detail/);

  await clearNeedLogin();
  assert.equal(await readNeedLogin(), null);
  assert.equal(local._m.has(NEED_LOGIN_KEY), false);
});

test('clearNeedLogin: 带 account 时只清该账号的标记（多账号互不干扰）', async () => {
  await markNeedLogin('平台接口返回 401', { account: 'user-b' });
  await clearNeedLogin('user-a');                 // 另一个账号重新登录, 不能抹掉 B 的提示
  assert.equal((await readNeedLogin())?.account, 'user-b');
  await clearNeedLogin('user-b');
  assert.equal(await readNeedLogin(), null);
});

test('markNeedLogin: 记录值守账号, 便于控制台点名', async () => {
  const rec = await markNeedLogin('平台跳转到登录页', { account: 'user-a', url: 'https://mooc.ctt.cn/oauth/#login/x' });
  assert.equal(rec.account, 'user-a');
  assert.equal((await readNeedLogin())?.account, 'user-a');
});

test('readNeedLogin: {at:0} 之类的脏记录当不存在（否则图标灰、横幅却不出）', async () => {
  await chrome.storage.local.set({ 'mooc.needLogin': { at: 0, why: '坏的' } });
  assert.equal(await readNeedLogin(), null);
  await chrome.storage.local.set({ 'mooc.needLogin': { at: 'x', why: '坏的' } });
  assert.equal(await readNeedLogin(), null);
});

test('markNeedLogin: url 只留页面, 不带 query/hash（SSO 的 #access_token 不能复制进存储）', async () => {
  const rec = await markNeedLogin('平台跳转到登录页', {
    url: 'https://mooc.ctt.cn/oauth/#login/eyJhIjoxfQ==?x=1',
    account: 'user-a',
  });
  assert.ok(rec);
  // 保留 hash 路由（平台是 hash 路由）, 但 hash 内的 query 与令牌参数不进存储
  assert.equal(rec.url, 'https://mooc.ctt.cn/oauth/#login/eyJhIjoxfQ==');
  assert.equal((await readNeedLogin()).url, 'https://mooc.ctt.cn/oauth/#login/eyJhIjoxfQ==');
  assert.ok(!/access_token=/.test(rec.url));
});

test('markNeedLogin: 同账号同原因 30s 内只写一次（内容脚本 2s 一拍, 避免写风暴）', async () => {
  await chrome.storage.local.remove('mooc.needLogin');
  let writes = 0;
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async (items) => { if ('mooc.needLogin' in items) writes++; return realSet(items); };
  const at = Date.now();
  await markNeedLogin('平台接口返回 401', { account: 'dup-user', at });
  await markNeedLogin('平台接口返回 401', { account: 'dup-user', at: at + 1000 });
  await markNeedLogin('平台接口返回 401', { account: 'dup-user', at: at + 2000 });
  chrome.storage.local.set = realSet;
  assert.equal(writes, 1);
});

test('isLoginWallError: 平台 401/风控码 与 扩展自抛的「登录态已失效」都算', () => {
  assert.equal(isLoginWallError(Object.assign(new Error('unauthorized'), { status: 401 })), true);
  // 裸 422 是数据接口的参数/业务校验失败, 不能判成登录墙
  assert.equal(isLoginWallError(Object.assign(new Error('参数错误'), { status: 422 })), false);
  assert.equal(isLoginWallError(Object.assign(new Error('x'), { errorCode: '90908' })), true);
  assert.equal(isLoginWallError(Object.assign(new Error('x'), { errorCode: '90105' })), true);
  // 自动换发不可用时扩展自己抛的错没有 status —— 之前漏判, 导致图标不灰、没有横幅
  assert.equal(isLoginWallError(new Error('登录态已失效, 请重新登录')), true);
  assert.equal(isLoginWallError(new Error('登录状态已过期')), true);
  // 非认证类错误不能算
  assert.equal(isLoginWallError(new Error('fetch failed')), false);
  assert.equal(isLoginWallError(new Error('配额已用完')), false);
  assert.equal(isLoginWallError(null), false);
});

test('markNeedLogin: 长文案截断, 不把整页文本塞进存储', async () => {
  const rec = await markNeedLogin('x'.repeat(500));
  assert.equal(rec.why.length, 120);
});

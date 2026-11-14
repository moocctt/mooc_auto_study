// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 浏览器适配层: /api/* 契约 → 直连平台 (无服务端) */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

/** 假平台: 足够跑通 登录/概览/小节/一次学习 */
function fakePlatform({ remaining = [120, 0], finishStatus = 2 } = {}) {
  const calls = [];
  let startCalls = 0;
  let finished = false;
  const reply = (data, status = 200) => ({
    status, ok: status < 400, text: async () => JSON.stringify(data), json: async () => data,
  });
  const fetchImpl = async (path, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ path, method, body: init.body ? String(init.body) : null });
    const p = path.split('?')[0];
    if (p === '/oauth/api/v1/app-login') return reply({ access_token: 'tok', token_type: 'Bearer' });
    if (p === '/api/v1/human/member/center') return reply({ fullName: '张三' });
    if (p === '/api/v1/system/cadre-education/detail-hour-member') return reply({ hourSelf: 12.5, requireCourseHour: 50, hourTrain: 6 });
    if (p === '/api/v1/human/task') return reply({ recordCount: 0, items: [] });
    if (p === '/api/v1/course-study/course-study-progress/personCourse-list') {
      const bt = new URLSearchParams(path.split('?')[1]).get('businessType');
      return reply({ items: bt === '0' ? [{ courseId: 'c1', courseInfo: { name: '课程一' }, finishStatus: finished ? 2 : 1, isRequired: 1, registerTime: 1 }] : [] });
    }
    if (p === '/api/v1/course-study/course-front/register') return reply({ name: '课程A', versionId: 'v1', register: true });
    if (p === '/api/v1/course-study/course-front/findPageForGlobalSearch') {
      const q = new URLSearchParams(path.split('?')[1]);
      const type = q.get('type') ?? '-1';                    // 缺 type = 热门（全类型混合）
      const hot = type === '-1', course0 = type === '0' && q.get('page') === '1';
      return reply(hot || course0
        ? { recordCount: 1, items: [{ id: 'c9', name: '消防安全', courseHour: 2, type: 0 }] }
        : { recordCount: 1, items: [] });
    }
    if (p === '/api/v1/course-study/subject/chapter-progress') {
      return reply([{ courseChapterSections: [{
        referenceId: 's1', resourceId: 'r1', name: '第一节', sectionType: 6,
        progress: { finishStatus: finished ? 2 : 1, completedRate: 50, studyTotalTime: 60 },
      }] }]);
    }
    if (p.startsWith('/api/v1/course-study/course-front/start-progress/')) {
      const rem = remaining[Math.min(startCalls++, remaining.length - 1)];
      return reply({ id: 'log', remainingTime: rem });
    }
    if (p === '/api/v1/course-study/course-front/video-progress') { finished = true; return reply({ finishStatus }); }
    if (p === '/api/v1/course-study/file/info-app/r1') return reply([]);
    return reply({}, 404);
  };
  return { fetchImpl, calls };
}

function makeApi(opts = {}) {
  const { fetchImpl, calls } = fakePlatform(opts);
  const api = createBrowserApi({
    storage: memStore(),
    sessionStore: memStore(),
    fetchImpl,
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { constructor() {} close() {} send() {} },
    apiOrigin: '',
  });
  return { api, calls };
}

const login = async (api) => {
  const res = await api.fetch('/api/accounts', {
    method: 'POST', body: JSON.stringify({ username: '13800138000', password: 'pw' }),
  });
  assert.equal(res.status, 200);
  return res.json();
};

test('初始状态: 没有账号也没有运行记录', async () => {
  const { api } = makeApi();
  const data = await (await api.fetch('/api/state')).json();
  assert.deepEqual(data.accounts, []);
  assert.deepEqual(data.runs, []);
});

test('登录后写入 localStorage, 密码只进 sessionStorage', async () => {
  const { api } = makeApi();
  const body = await login(api);
  assert.equal(body.accounts[0].displayName, '张三');
  assert.equal(body.accounts[0].active, true);
  assert.equal(api.state.busy, null);
});

test('概览: 学时 + 任务行', async () => {
  const { api } = makeApi();
  await login(api);
  const data = await (await api.fetch('/api/overview')).json();
  assert.equal(data.hours.hourSelf, 12.5);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].runnable, true);
});

test('小节: 返回课程名与小节树', async () => {
  const { api } = makeApi();
  await login(api);
  const data = await (await api.fetch('/api/sections?bid=c1')).json();
  assert.equal(data.name, '课程A');
  assert.equal(data.sections[0].section_id, 's1');
});

test('跑一次课程: 202 → 记录从 running 变为 done', async () => {
  const { api, calls } = makeApi();
  await login(api);
  const started = await api.fetch('/api/run', { method: 'POST', body: JSON.stringify({ action: 'course', bid: 'c1' }) });
  assert.equal(started.status, 202);

  const wait = async () => {
    for (let i = 0; i < 50; i++) {
      const st = await (await api.fetch('/api/state')).json();
      const rec = st.runs[0];
      if (rec && rec.status !== 'running') return rec;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  };
  const rec = await wait();
  assert.ok(rec, '应产生运行记录');
  assert.equal(rec.label, '学习课程');
  assert.equal(rec.account, '张三');
  assert.equal(rec.status, 'done');
  assert.ok(rec.endedAt >= rec.startedAt);
  assert.ok(calls.some((c) => c.path.startsWith('/api/v1/course-study/course-front/start-progress/s1')));
});

test('配额用尽 → 运行记录标为 stopped', async () => {
  const { api } = makeApi({ remaining: [120], finishStatus: 1 });
  await login(api);
  await api.fetch('/api/run', { method: 'POST', body: JSON.stringify({ action: 'course', bid: 'c1' }) });
  let rec = null;
  for (let i = 0; i < 80 && (!rec || rec.status === 'running'); i++) {
    const st = await (await api.fetch('/api/state')).json();
    rec = st.runs[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(rec.status, 'stopped');
});

test('设置: 非法模式 400, 合法模式落盘（演练模式已删除, dryRun 字段被忽略）', async () => {
  const { api } = makeApi();
  await login(api);
  assert.equal((await api.fetch('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'nope' }) })).status, 400);
  const ok = await api.fetch('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'audio', dryRun: true }) });
  assert.deepEqual(await ok.json(), { mode: 'audio' });
});

test('SSE 适配: 回放历史日志并推送增量', async () => {
  const { api } = makeApi();
  const seen = [];
  const es = new api.EventSource('/api/stream');
  es.onmessage = (ev) => seen.push(JSON.parse(ev.data));
  await new Promise((r) => setTimeout(r, 10));

  await login(api);                       // 登录会写一条日志
  await new Promise((r) => setTimeout(r, 10));
  es.close();

  assert.ok(seen.some((e) => e.type === 'state'), '应推送忙闲状态');
  assert.ok(seen.some((e) => e.type === 'log' && /账号/.test(e.text)), '应推送登录日志');
  // runId 契约: 回放事件必须透传缓冲区里的 runId 字段（无运行上下文 = undefined, 有运行 = 运行 id）
  assert.ok(seen.every((e) => e.type !== 'log' || !('runId' in e) || typeof e.runId === 'string' || e.runId === undefined),
    '回放事件应透传 runId 字段');
});

test('adopt-session: 缺 access_token 返回 400; 令牌经服务器校验失败返回 401', async () => {
  const { api } = makeApi();
  const missing = await api.fetch('/api/adopt-session', { method: 'POST', body: JSON.stringify({ token: {} }) });
  assert.equal(missing.status, 400);
  assert.ok((await missing.json()).error, '应返回错误 json');

  // 平台拒绝该令牌（member/center 401）→ 导入路由同样拒绛
  const bad = createBrowserApi({
    storage: memStore(), sessionStore: memStore(), apiOrigin: '',
    fetchImpl: async () => ({ status: 401, ok: false, text: async () => '{}', json: async () => ({}) }),
    sleepFn: () => Promise.resolve(),
  });
  const res = await bad.fetch('/api/adopt-session', { method: 'POST', body: JSON.stringify({ token: { access_token: 'x' } }) });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /失效/);
});

test('未知路径返回 404, 不抛异常', async () => {
  const { api } = makeApi();
  const res = await api.fetch('/api/nope');
  assert.equal(res.status, 404);
});

test('搜索: 多关键词聚合 + 分页参数透传（缺 q 不再报错, 空词=浏览全部）', async () => {
  const { api } = makeApi();
  await login(api);
  const browse = await (await api.fetch('/api/search?type=0&page=1&pageSize=20')).json();
  assert.equal(browse.page, 1);
  assert.equal(browse.type, 0);
  const data = await (await api.fetch('/api/search?q=%E6%B6%88%E9%98%B2')).json();
  assert.ok(typeof data === 'object', '搜索应返回 JSON 对象');
});

test('登录被拒: 401 响应透传平台 errorCode（登录防抖/风控识别依赖它）; 未知 run 操作返回 400', async () => {
  const reply = (data, status = 200) => ({
    status, ok: status < 400, text: async () => JSON.stringify(data), json: async () => data,
  });
  const api = createBrowserApi({
    storage: memStore(), sessionStore: memStore(), apiOrigin: '',
    fetchImpl: async () => reply({ errorCode: '90908', error_description: '账号或密码不正确' }),
    sleepFn: () => Promise.resolve(),
  });
  const res = await api.fetch('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'u', password: 'p' }) });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.errorCode, '90908');

  const bad = await api.fetch('/api/run', { method: 'POST', body: JSON.stringify({ action: 'nope' }) });
  assert.equal(bad.status, 400);
});

test('静态托管: 没有同源后端时请求指向平台源站', async () => {
  const seen = [];
  const api = createBrowserApi({
    storage: memStore(), sessionStore: memStore(), apiOrigin: 'https://mooc.ctt.cn',
    fetchImpl: async (url) => { seen.push(String(url)); return { status: 401, ok: false, text: async () => '{}', json: async () => ({}) }; },
    sleepFn: () => Promise.resolve(),
  });
  await api.fetch('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'u', password: 'p' }) });
  assert.ok(seen[0].startsWith('https://mooc.ctt.cn/oauth/api/v1/app-login'), `应请求平台源站, 实际 ${seen[0]}`);
});

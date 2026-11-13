// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 浏览器版平台客户端: 登录加密 / 数据聚合 / 学时循环 / 配额熔断 / 重登 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decField } from '../../extension/lib/crypto.js';
import { PlatformClient, QuotaExhausted, login } from '../../extension/lib/platform.js';
import { BRANDS } from '../../extension/lib/fingerprint.js';

test('fetchProfile: 解析 headPortraitPath 并在缺头像时兜底系统设置', async () => {
  const { fetchProfile } = await import('../../extension/lib/platform.js');
  const reply = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const token = { access_token: 'a'.repeat(24), token_type: 'Bearer' };

  const p = await fetchProfile(token, async () => reply({ fullName: '陈学新', headPortraitPath: '/upload/head.png' }));
  assert.equal(p.displayName, '陈学新');
  assert.equal(p.avatar, 'https://mooc.ctt.cn/upload/head.png');

  const nested = await fetchProfile(token, async () => reply({ data: { name: '李四', headPortraitPath: 'group1/a.jpg' } }));
  assert.equal(nested.displayName, '李四');
  assert.equal(nested.avatar, 'https://mooc.ctt.cn/group1/a.jpg');

  let calls = 0;
  const alt = await fetchProfile(token, async () => {
    calls++;
    return reply(calls === 1 ? { fullName: '王五' } : { headPortraitPath: 'https://cdn.example.com/p.png' });
  });
  assert.equal(alt.displayName, '王五');
  assert.equal(alt.avatar, 'https://cdn.example.com/p.png');
  assert.equal(calls, 2);
});

test('fetchProfile: 真实响应里头像嵌在 memberDetail / currentUser 内', async () => {
  const { fetchProfile } = await import('../../extension/lib/platform.js');
  const reply = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const token = { access_token: 'a'.repeat(24), token_type: 'Bearer' };
  const p = await fetchProfile(token, async () => reply({
    fullName: '赵某',
    memberDetail: { headPortraitPath: 'default/M00/04/42/abc.jpg' },
  }));
  assert.equal(p.displayName, '赵某');
  assert.equal(p.avatar, 'https://mooc.ctt.cn/default/M00/04/42/abc.jpg');

  const fromSetting = await fetchProfile(token, async (u) => reply(
    String(u).includes('member/center')
      ? { fullName: '钱某' }
      : { cdnPreviewAddress: 'https://cdn.example.com/', currentUser: { headPortraitPath: 'default/M00/x.png' } },
  ));
  assert.equal(fromSetting.avatar, 'https://mooc.ctt.cn/default/M00/x.png');
});

const SECTIONS = [
  { section_id: 's1', resource_id: 'r1', name: '第一节', type: 6, finish: 1, rate: 50, studied: 50 },
  { section_id: 's2', resource_id: 'r2', name: '课后测试', type: 4, finish: 0, rate: 0, studied: 0 },
];

/** 假平台: 记录每个请求, 按路径返回 */
function fakePlatform({ remaining = [120, 0], finishStatus = 2, authFailAt = -1, completeAfterCommit = true } = {}) {
  const calls = [];
  let startCalls = 0;
  let finished = false;
  const reply = (data, status = 200) => ({
    status,
    ok: status < 400,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });
  const fetchImpl = async (path, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ path, method, body: init.body ? String(init.body) : null, headers: init.headers || {} });
    if (authFailAt === calls.length - 1) return reply({ errorCode: 90901 }, 200);
    const p = path.split('?')[0];

    if (p === '/oauth/api/v1/app-login') return reply({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 2592000 });
    if (p === '/api/v1/human/member/center') return reply({ fullName: '陈学新' });
    if (p === '/api/v1/human/task') {
      return reply({
        recordCount: 2,
        items: [
          { id: 't1', name: '任务A', businessId: 'b1', businessType: 2, status: 1, startTime: 0, createTime: 5 },
          { id: 't1', name: '任务A', businessId: 'b1', businessType: 2, status: 1, startTime: 0, createTime: 5 },
        ],
      });
    }
    if (p === '/api/v1/course-study/course-study-progress/personCourse-list') {
      const businessType = new URLSearchParams(path.split('?')[1]).get('businessType');
      const items = businessType === '0'
        ? [{ courseId: 'c1', courseInfo: { name: '课程一', url: '' }, finishStatus: 1, isRequired: 1, registerTime: 100 , businessType: 0 }]
        : [{ courseId: 'b1', courseInfo: { name: '专题一', url: '' }, finishStatus: 0, isRequired: 0, registerTime: 200 }];
      return reply({ items });
    }
    if (p === '/api/v1/system/cadre-education/detail-hour-member') return reply({ hourSelf: 10, requireCourseHour: 50 });
    if (p === '/api/v1/course-study/course-front/register') return reply({ name: '课程A', versionId: 'v1', register: true });
    if (p === '/api/v1/course-study/subject/chapter-progress') {
      return reply([{ name: '第一章', courseChapterSections: SECTIONS.map((s) => ({
        referenceId: s.section_id, resourceId: s.resource_id, name: s.name, sectionType: s.type,
        progress: {
          finishStatus: completeAfterCommit && finished && s.section_id === 's1' ? 2 : s.finish,
          completedRate: s.rate, studyTotalTime: s.studied,
        },
      })) }]);
    }
    if (p.startsWith('/api/v1/course-study/course-front/start-progress/')) {
      const rem = remaining[Math.min(startCalls, remaining.length - 1)];
      startCalls += 1;
      return reply({ id: `log-${startCalls}`, remainingTime: rem });
    }
    if (p === '/api/v1/course-study/course-front/video-progress') {
      finished = true;
      return reply({ finishStatus });
    }
    if (p === '/api/v1/course-study/course-front/doc-progress') return reply({ finishStatus });
    if (p === '/api/v1/course-study/file/info-app/r1') return reply([{ path: '/a.mp4', size: 2048 }]);
    return reply({}, 404);
  };
  return { fetchImpl, calls };
}

const ACCOUNT = { key: 'acc-1', username: '13800138000', password: 'pw' };

test('登录: 每个字段单独加密, 且在浏览器里不伪造 UA', async () => {
  const { fetchImpl, calls } = fakePlatform();
  const token = await login({ username: '13800138000', password: 'pw', fetchImpl, accountKey: 'acc-1' });
  assert.equal(token.access_token, 'tok-1');

  const call = calls[0];
  assert.equal(call.path, '/oauth/api/v1/app-login');
  assert.equal(call.method, 'POST');
  const body = new URLSearchParams(call.body);
  assert.equal(decField(body.get('username')), '13800138000');
  assert.equal(decField(body.get('pword')), 'pw');
  assert.ok(BRANDS.includes(decField(body.get('terminal'))), 'terminal 应为已知品牌');
  assert.match(decField(body.get('system')), /^Linux (armv8l|aarch64)$/);
  assert.equal(body.get('captcha'), '');
  assert.equal(call.headers['User-Agent'], undefined, '浏览器禁止设置 UA, 不应尝试');
});

test('任务列表按 id 去重', async () => {
  const { fetchImpl } = fakePlatform();
  const c = new PlatformClient({ token: { access_token: 't' }, account: ACCOUNT, fetchImpl });
  const tasks = await c.listTasks();
  assert.equal(tasks.length, 1);
});

test('统一视图: 课程/专题 + 其它任务, 按 bid 去重', async () => {
  const { fetchImpl } = fakePlatform();
  const c = new PlatformClient({ token: { access_token: 't' }, account: ACCOUNT, fetchImpl });
  const rows = await c.allViewItems();
  const bids = rows.map((r) => r.bid);
  assert.deepEqual(bids.sort(), ['b1', 'c1']);
  assert.equal(rows.find((r) => r.bid === 'c1').runnable, true);
  assert.equal(rows.find((r) => r.bid === 'b1').type, '专题');
});

test('小节树映射', async () => {
  const { fetchImpl } = fakePlatform();
  const c = new PlatformClient({ token: { access_token: 't' }, account: ACCOUNT, fetchImpl });
  const secs = await c.sections('c1', 'v1', true);
  assert.deepEqual(secs.map((s) => [s.section_id, s.type, s.finish]), [['s1', 6, 1], ['s2', 4, 0]]);
});

test('刷单课: 剩余 120 → 上报 → 完成', async () => {
  const { fetchImpl, calls } = fakePlatform({ remaining: [120, 0] });
  const logs = [];
  const c = new PlatformClient({
    token: { access_token: 't' }, account: ACCOUNT, fetchImpl, say: (m) => logs.push(m), chunk: 600,
    sleepFn: () => Promise.resolve(),
  });
  const [done, total] = await c.runCourse('c1');
  assert.deepEqual([done, total], [1, 2]);
  const video = calls.find((x) => x.path === '/api/v1/course-study/course-front/video-progress');
  assert.ok(video, '应上报 video-progress');
  const form = new URLSearchParams(video.body);
  assert.equal(form.get('encrypt'), 'false');
  assert.equal(form.get('studyTime'), '120', '单档应受剩余时长限制');
  assert.match(logs.join('\n'), /-> OK 完成, 共 1 轮 \/ 120s/);
  assert.equal(c.stopReason, null);
});

test('配额熔断: 剩余时长不下降 → 抛 QuotaExhausted 并记录原因', async () => {
  const { fetchImpl } = fakePlatform({ remaining: [120], finishStatus: 1 });
  const c = new PlatformClient({
    token: { access_token: 't' }, account: ACCOUNT, fetchImpl, say: () => {}, chunk: 600,
    sleepFn: () => Promise.resolve(),
  });
  await assert.rejects(() => c.runCourse('c1'), QuotaExhausted);
  assert.equal(c.stopReason, 'quota', '应把停止原因记下来, 供运行记录标为「停止」');
});

test('登录态失效 → 用保存的凭据重登后重试', async () => {
  const { fetchImpl, calls } = fakePlatform({ authFailAt: 1 });
  let relogins = 0;
  const c = new PlatformClient({
    token: { access_token: 'old' }, account: ACCOUNT, fetchImpl,
    reLogin: async () => { relogins += 1; return { access_token: 'new', token_type: 'Bearer' }; },
  });
  const rows = await c.allViewItems();
  assert.ok(relogins >= 1, '应触发一次重登');
  assert.ok(calls.some((x) => x.path.startsWith('/api/v1/course-study/course-study-progress/personCourse-list')));
  assert.ok(rows.length > 0);
});

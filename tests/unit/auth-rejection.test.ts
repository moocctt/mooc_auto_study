// @ts-nocheck —— 测试桩大量动态结构, 类型检查豁免
/** 审计修复点回归: isAuthRejection 收紧(P0-3) / remainingTime 缺失不假完成(P1-8) / 章节接口异常抛错(P1-9) */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAuthRejection } from '../../extension/lib/crypto.js';
import { PlatformClient } from '../../extension/lib/platform.js';

const ACCOUNT = { key: 'acc-1', username: '13800138000', password: 'pw' };

test('isAuthRejection: 只认 401 与平台登录态错误码, 422/403/429 不再误判', () => {
  assert.equal(isAuthRejection({ status: 401 }), true);
  assert.equal(isAuthRejection({ status: 422, errorCode: '90908' }), true);
  for (const code of ['90901', '90902', '90908', '90105']) {
    assert.equal(isAuthRejection({ status: 400, errorCode: code }), true, `errorCode ${code} 应视为凭据被拒`);
  }
  // 422 参数非法 / 403 403 风控 / 429 限流: 与密码无关, 不得删凭据或计失败
  assert.equal(isAuthRejection({ status: 422 }), false);
  assert.equal(isAuthRejection({ status: 403 }), false);
  assert.equal(isAuthRejection({ status: 429 }), false);
  assert.equal(isAuthRejection({ status: 400, message: 'Invalid input.' }), false);
  assert.equal(isAuthRejection({ status: 0, message: 'fetch failed' }), false);
  assert.equal(isAuthRejection(null), false);
});

const reply = (data, status = 200) => ({
  status,
  ok: status < 400,
  text: async () => JSON.stringify(data),
  json: async () => data,
});

function makeClient(routes) {
  const calls = [];
  const fetchImpl = async (path, init = {}) => {
    calls.push({ path, method: (init.method || 'GET').toUpperCase() });
    const p = path.split('?')[0];
    for (const [match, handler] of routes) {
      if (p === match || (match.endsWith('*') && p.startsWith(match.slice(0, -1)))) return handler(path);
    }
    return reply({}, 404);
  };
  const c = new PlatformClient({ token: { access_token: 't' }, account: ACCOUNT, fetchImpl, say: () => {}, sleepFn: () => Promise.resolve() });
  return { c, calls };
}

test('P1-8: start-progress 未返回 remainingTime 时按失败处理, 不再假完成', async () => {
  const { c } = makeClient([
    ['/api/v1/course-study/course-front/start-progress/*', () => reply({ id: 'log-1' })],
  ]);
  const [good, msg] = await c.fakeSection({ section_id: 's1', resource_id: 'r1', type: 6, finish: 0, studied: 0 });
  assert.equal(good, false);
  assert.match(String(msg), /remainingTime/);
});

test('P1-9: sections 收到 422/非数组直接抛错, 不再返回空数组', async () => {
  const { c } = makeClient([
    ['/api/v1/course-study/subject/chapter-progress', () => reply({ timestamp: 1, error: 'Invalid input.' }, 422)],
  ]);
  await assert.rejects(() => c.sections('c1', 'v1', true), /章节接口返回异常/);
});

test('P1-9: openCourse 缺 versionId 时先取课程详情补齐', async () => {
  const { c, calls } = makeClient([
    ['/api/v1/course-study/course-front/register', () => reply({ name: '课程B', register: true })],
    ['/api/v1/course-study/course-front/info/c1', () => reply({ versionId: 'v9', courseChapters: [] })],
    ['/api/v1/course-study/subject/chapter-progress', (path) => reply([])],
  ]);
  const [det, secs] = await c.openCourse('c1');
  assert.equal(det.versionId, 'v9');
  assert.deepEqual(secs, []);
  const chapters = calls.find((x) => x.path.startsWith('/api/v1/course-study/subject/chapter-progress'));
  assert.match(chapters.path, /versionId=v9/, '章节接口应拿到补齐后的 versionId');
});

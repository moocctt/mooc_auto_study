/** runCourse 真实执行（桩平台）: 课程库课程 clientType=0 + AES 加密上报 / rem<=0 收尾语义 */
import { describe, expect, it } from 'vitest';
import { PlatformClient, setApiOrigin } from '../../extension/lib/platform.js';
import { decField } from '../../extension/lib/crypto.js';

const reply = (data: object, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data,
});

type Call = { url: string; method: string; body: Record<string, string> | null; params: URLSearchParams };

const makeClient = (fetchImpl: any) => {
  setApiOrigin('https://mooc.example');
  return new PlatformClient({
    token: { access_token: 't', token_type: 'Bearer' },
    account: { key: 'k', username: 'u', password: 'p' },
    fetchImpl, sleepFn: () => Promise.resolve(), chunk: 600,
  });
};

const LIB_SECTIONS = [
  { id: 'sec-video', attachmentId: 'r1', name: '视频节', fileType: 'mp4' },
  { id: 'sec-doc', attachmentId: 'r2', name: '文档节', fileType: 'pdf' },
];

/** 桩平台: register 404 → 课程库分支; 每小节一次 start + 一次加密上报即完成 */
function libraryStub({ finishOnCommit = true, zeroAfterFirst = false } = {}) {
  const calls: Call[] = [];
  let starts = 0;
  const fetchImpl = async (url: string, init: any = {}) => {
    const u = new URL(String(url), 'https://mooc.example');
    const body: any = {};
    if (init.body) for (const [k, v] of new URLSearchParams(String(init.body))) body[k] = v;
    calls.push({ url: u.pathname, method: (init.method || 'GET').toUpperCase(), body, params: u.searchParams });
    const p = u.pathname;
    if (p.endsWith('/course-front/register')) return reply({}, 404);
    if (p.includes('/course-front/registerStudy')) return reply({ ok: true });
    if (p.includes('/course-front/info/lib-c')) {
      return reply({ name: '库课', courseChapters: [{ courseChapterSections: LIB_SECTIONS }] });
    }
    if (p.includes('/course-front/start-progress/')) {
      starts += 1;
      if (zeroAfterFirst && starts > 1) return reply({ id: `log${starts}`, remainingTime: 0 });
      return reply({ id: `log${starts}`, remainingTime: 1200 });
    }
    if (p.endsWith('/video-progress') || p.endsWith('/doc-progress')) {
      return reply({ finishStatus: finishOnCommit ? 4 : 1 });
    }
    if (p.endsWith('/course-progress-update')) return reply({ ok: true });
    if (p.includes('/subject/chapter-progress')) {
      return reply([{ courseChapterSections: LIB_SECTIONS.map((s) => ({
        referenceId: s.id, resourceId: s.attachmentId, name: s.name,
        sectionType: s.fileType === 'mp4' ? 6 : 1, progress: { finishStatus: 4 },
      })) }]);
    }
    return reply({ items: [] });
  };
  return { fetchImpl, calls };
}

describe('runCourse · 课程库课程（clientType=0 + 加密上报）', () => {
  it('register 404 → registerStudy + info, 加密上报, 完成后 2/2', async () => {
    const { fetchImpl, calls } = libraryStub();
    const c = makeClient(fetchImpl);
    const [done, total] = await c.runCourse('lib-c');
    expect([done, total]).toEqual([2, 2]);

    // start-progress 必须 clientType=0
    const starts = calls.filter((x) => x.url.includes('start-progress'));
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(s.params.get('clientType')).toBe('0');

    // video-progress 全字段 AES, 无 encrypt 字段
    const video = calls.find((x) => x.url.endsWith('/video-progress'))!;
    expect(video).toBeTruthy();
    expect(video.body!.encrypt).toBeUndefined();
    expect(decField(video.body!.logId)).toBe('log1');
    expect(decField(video.body!.lessonLocation)).toBeDefined();
    expect(decField(video.body!.studyTime)).toBeDefined();
    expect(decField(video.body!.resourceTotalTime)).toBeDefined();
    expect(decField(video.body!.organizationId)).toBe('1');
    expect(decField(video.body!.singleMark)).toMatch(/^[0-9a-f-]{36}$/);

    // doc-progress 同款加密 + singleMark
    const doc = calls.find((x) => x.url.endsWith('/doc-progress'))!;
    expect(doc).toBeTruthy();
    expect(decField(doc.body!.organizationId)).toBe('1');
    expect(decField(doc.body!.singleMark)).toMatch(/^[0-9a-f-]{36}$/);

    // 每次上报后刷新进度
    expect(calls.some((x) => x.url.endsWith('/course-progress-update'))).toBe(true);
  });

  it('rem<=0 但本轮已上报 → OK（待平台汇总），不再返回 FAIL', async () => {
    const { fetchImpl } = libraryStub({ finishOnCommit: false, zeroAfterFirst: true });
    const c = makeClient(fetchImpl);
    const logs: string[] = [];
    c.say = (t: string) => logs.push(String(t));
    const [done] = await c.runCourse('lib-c', { onlyUnfinished: true });
    expect(logs.join('\n')).toContain('学习时长已用完（待平台汇总，共 600s）');
    expect(done).toBeGreaterThanOrEqual(1);
  });
});

describe('runCourse · 我的课程（明文 + clientType=1，回归保护）', () => {
  it('register 成功 → start clientType=1, 明文上报', async () => {
    const calls: Call[] = [];
    let committed = 0;
    const fetchImpl = async (url: string, init: any = {}) => {
      const u = new URL(String(url), 'https://mooc.example');
      const body: any = {};
      if (init.body) for (const [k, v] of new URLSearchParams(String(init.body))) body[k] = v;
      calls.push({ url: u.pathname, method: (init.method || 'GET').toUpperCase(), body, params: u.searchParams });
      const p = u.pathname;
      if (p.endsWith('/course-front/register')) return reply({ name: '我的课', versionId: 'v1', register: true });
      if (p.includes('/course-front/start-progress/')) return reply({ id: 'logM', remainingTime: 1200 });
      if (p.endsWith('/video-progress')) { committed += 1; return reply({ finishStatus: 4 }); }
      if (p.includes('/subject/chapter-progress')) {
        return reply([{ courseChapterSections: [{ referenceId: 's1', resourceId: 'r1', name: '节', sectionType: 6,
          progress: { finishStatus: committed ? 4 : 1 } }] }]);
      }
      return reply({ items: [] });
    };
    const c = makeClient(fetchImpl);
    await c.runCourse('mine-1');
    const starts = calls.filter((x) => x.url.includes('start-progress'));
    for (const s of starts) expect(s.params.get('clientType')).toBe('1');
    const video = calls.find((x) => x.url.endsWith('/video-progress'))!;
    expect(video.body!.encrypt).toBe('false');
    expect(video.body!.logId).toBe('logM');
  });
});

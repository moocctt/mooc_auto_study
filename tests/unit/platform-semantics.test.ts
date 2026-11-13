/** 平台语义对齐 cli/web: 任务 status 1/2/3 + expired、完成态 {2,4}、未完成筛选 [1,2] */
import { beforeEach, describe, expect, it } from 'vitest';
import { DONE_FINISH, FINISH_NAME, PlatformClient } from '../../extension/lib/platform.js';
import { filterRows } from '../../extension/lib/core.js';
import { setApiOrigin } from '../../extension/lib/platform.js';

const reply = (data: object, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data,
});

const makeClient = (fetchImpl: any) => {
  setApiOrigin('https://mooc.example');
  return new PlatformClient({ token: { access_token: 't', token_type: 'Bearer' }, account: { key: 'k', username: 'u', password: 'p' }, fetchImpl });
};

const TASKS = [
  { id: 't1', businessId: 'b1', name: '未开始任务', businessType: 3, status: 1, expired: false, startTime: Date.now() + 864e5, createTime: 1 },
  { id: 't2', businessId: 'b2', name: '进行中任务', businessType: 3, status: 2, expired: false, startTime: Date.now() - 864e5, createTime: 2 },
  { id: 't3', businessId: 'b3', name: '已完成任务', businessType: 3, status: 3, expired: false, startTime: Date.now() - 864e5, createTime: 3 },
  { id: 't4', businessId: 'b4', name: '已过期任务', businessType: 3, status: 1, expired: true, startTime: Date.now() - 864e5, createTime: 4 },
  { id: 't5', businessId: 'b5', name: '进行中课程', businessType: 1, status: 2, expired: false, createTime: 5 },
];

describe('平台语义对齐 cli/web', () => {
  it('完成态集合 {2,4}', () => {
    expect([...DONE_FINISH].sort()).toEqual([2, 4]);
    expect(FINISH_NAME[2]).toBe('已完成(复习)');
    expect(FINISH_NAME[4]).toBe('已完成');
  });

  it('任务状态映射: 3=已完成, expired=已过期, 2=学习中, 1=按开始时间', async () => {
    const c = makeClient(async (url: string) => {
      if (String(url).includes('/api/v1/human/task')) return reply({ items: TASKS });
      return reply({ items: [] });
    });
    const rows = await c.allViewItems();
    const byName = Object.fromEntries(rows.map((r: any) => [r.name, r.state]));
    expect(byName['已完成任务']).toBe('已完成');
    expect(byName['已过期任务']).toBe('已过期');
    expect(byName['进行中任务']).toBe('学习中');
    expect(byName['未开始任务']).toBe('未开始');
  });

  it('未完成筛选 [1,2] 且排除 expired', async () => {
    const c = makeClient(async (url: string) => {
      if (String(url).includes('/api/v1/human/task')) return reply({ items: TASKS });
      return reply({ items: [] });
    });
    const undone = await c.undoneTasks();
    const names = undone.map((t: any) => t.name);
    expect(names).toContain('进行中课程');
    expect(names).not.toContain('已完成任务');
    expect(names).not.toContain('已过期任务');
    expect(names).not.toContain('进行中任务'); // businessType 3 非课程/专题
  });

  it('finishStatus=4 视为完成且不可再跑', async () => {
    const c = makeClient(async (url: string) => {
      if (String(url).includes('personCourse-list')) {
        return reply({ items: [
          { courseId: 'c4', courseInfo: { name: '已完成课' }, finishStatus: 4, isRequired: 1, registerTime: 1 },
          { courseId: 'c2', courseInfo: { name: '复习课' }, finishStatus: 2, isRequired: 0, registerTime: 2 },
          { courseId: 'c1', courseInfo: { name: '学习中课' }, finishStatus: 1, isRequired: 1, registerTime: 3 },
        ] });
      }
      return reply({ items: [] });
    });
    const rows = (await c.personCourses(0)).filter((r: any) => r.bid.startsWith('c'));
    const by = Object.fromEntries(rows.map((r: any) => [r.name, r]));
    expect(by['已完成课'].state).toBe('已完成');
    expect(by['已完成课'].runnable).toBe(false);
    expect(by['复习课'].state).toBe('已完成(复习)');
    expect(by['复习课'].runnable).toBe(false);
    expect(by['学习中课'].runnable).toBe(true);
  });
});

describe('课程库课程（未加入我的课程）', () => {
  it('register 失败 → registerStudy + info 取章节（_library）', async () => {
    const calls: string[] = [];
    const c = makeClient(async (url: string, init: any = {}) => {
      const u = String(url); calls.push(u);
      if (u.endsWith('/course-front/register')) return reply({}, 404);           // 未报名 → 触发 fallback
      if (u.includes('/course-front/registerStudy')) return reply({ ok: true });
      if (u.includes('/course-front/info/lib-1')) {
        return reply({ name: '库课', courseChapters: [{ courseChapterSections: [
          { id: 's1', attachmentId: 'r1', name: '第一章', fileType: 'mp4' },
        ] }] });
      }
      return reply({ items: [] });
    });
    const [det, secs] = await c.openCourse('lib-1');
    expect(det._library).toBe(true);
    expect(calls.some((u) => u.includes('registerStudy'))).toBe(true);
    expect(secs).toHaveLength(1);
    expect(secs[0].type).toBe(6);   // mp4 → 6
    expect(secs[0].section_id).toBe('s1');
  });
});

describe('完成态在计划层生效', () => {
  it('undoneTasks 用 finishStatus 兜底：小节已完成但 status 滞后也被排除', async () => {
    const c = makeClient(async (url: string) => {
      if (String(url).includes('/api/v1/human/task')) {
        return reply({ items: [
          { id: 't9', name: '滞后任务', businessId: 'b9', businessType: 1, status: 1, finishStatus: 2, expired: false },
          { id: 't10', name: '正常未完成', businessId: 'b10', businessType: 1, status: 2, expired: false },
        ] });
      }
      return reply({ items: [] });
    });
    const undone = await c.undoneTasks();
    expect(undone.map((t: any) => t.name)).toEqual(['正常未完成']);
  });

  it('filterRows: 「已完成」包含复习态；finishStatus=4 不计待处理', async () => {
    const rows = [
      { name: 'a', type: '课程', state: '已完成', bid: '1', required: '必修', runnable: false, reg_ts: 0, push_ts: 0, url: '' },
      { name: 'b', type: '课程', state: '已完成(复习)', bid: '2', required: '必修', runnable: false, reg_ts: 0, push_ts: 0, url: '' },
      { name: 'c', type: '课程', state: '学习中', bid: '3', required: '必修', runnable: true, reg_ts: 0, push_ts: 0, url: '' },
    ];
    const done = filterRows(rows, { status: '已完成' });
    expect(done.map((r: any) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('runCourse 待处理列表排除 finishStatus=4 的小节', async () => {
    const c = makeClient(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/course-front/register')) return reply({ name: '课', versionId: 'v1', register: true });
      if (u.includes('/subject/chapter-progress')) {
        return reply([{ courseChapterSections: [
          { referenceId: 's4', resourceId: 'r4', name: '完成打勾', sectionType: 6, progress: { finishStatus: 4 } },
          { referenceId: 's1', resourceId: 'r1', name: '学习中', sectionType: 6, progress: { finishStatus: 1 } },
        ] }]);
      }
      return reply({ items: [] });
    });
    // 只用内部过滤逻辑验证：openCourse 后手动过滤等价于 runCourse 的 todo 构造
    const [, secs] = await c.openCourse('c1');
    const todo = secs.filter((x: any) => !DONE_FINISH.has(x.finish));
    expect(todo.map((x: any) => x.section_id)).toEqual(['s1']);
  });
});

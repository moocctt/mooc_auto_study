import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { platformToken, withPlatform } from '../auth/routes.js';
import { hoursSelf, librarySearch, personCourses, search, studyLogDays, studyLogs, scheduleItems, type PersonCourse } from '../platform/service.js';
import { platformReq, PlatformError } from '../platform/client.js';
import { API, DONE } from '../platform/endpoints.js';
import { startRun, stopRun, runStatus } from '../engine/runner.js';
import { buildIcs, type IcsEvent } from '../platform/ics.js';
import { prisma } from '../db.js';

export const apiRouter = Router();

// Express 4 不接 async rejection：统一包一层
const asyncH = (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) =>
  (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => { fn(req, res).catch(next); };
apiRouter.use(requireAuth);

const fmtH = (sec: number) => (sec / 3600).toFixed(2);

/** 统一错误出口：未绑定平台账号返回 400 + code=UNBOUND，其余 502 */
function sendErr(res: import('express').Response, e: unknown): void {
  if (e instanceof PlatformError && e.auth) { res.status(400).json({ message: e.message, code: 'UNBOUND' }); return; }
  const detail = e instanceof Error ? e.message : String(e);
  console.error('[api]', detail);
  // 平台内部错误细节不回传客户端（生产环境）
  res.status(502).json({ message: process.env.NODE_ENV === 'production' ? '上游服务暂不可用' : detail });
}
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 学时账单双轨 + 达标预测（按近 4 周周均速推算自学轨达标日期） */
apiRouter.get('/hours', async (req, res) => {
  try {
    const { b, weeklySec } = await withPlatform(req.user!.id, async (t) => {
      const [b, byDay] = await Promise.all([hoursSelf(t), studyLogDays(t)]);
      // 近 28 天（不含今天更准，含中也行——取含今天）
      let sum = 0;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = 1; i <= 28; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        sum += byDay[dayKey(d)] ?? 0;
      }
      return { b, weeklySec: sum / 4 };
    });
    const hourSelf = Number(b.hourSelf ?? 0);
    const hourTrain = Number(b.hourTrain ?? 0);
    const requireCourseHour = Number(b.requireCourseHour ?? 0);
    const requireClassHour = Number(b.requireClassHour ?? 0);
    const remainingH = Math.max(0, requireCourseHour - hourSelf);
    const weeklyH = weeklySec / 3600;
    const eta = remainingH > 0 && weeklyH > 0.05
      ? Date.now() + Math.ceil(remainingH / weeklyH) * 7 * 86400_000
      : null;
    res.json({
      self: { done: hourSelf, required: requireCourseHour, pct: requireCourseHour ? hourSelf / requireCourseHour : 0 },
      train: { done: hourTrain, required: requireClassHour, pct: requireClassHour ? hourTrain / requireClassHour : 0 },
      gap: Math.max(0, requireClassHour - hourTrain), // 面授缺口：网课补不上
      raw: { hourSelf, hourTrain, requireCourseHour, requireClassHour },
      forecast: { weeklyH: Number(weeklyH.toFixed(2)), remainingH: Number(remainingH.toFixed(2)), eta },
    });
  } catch (e) { sendErr(res, e); }
});

export async function taskRows(t: string) {
  const [courses, subjects, taskPages] = await Promise.all([
    personCourses(t, 0),
    personCourses(t, 2),
    (async () => {
      const out: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (let page = 1; page <= 10; page++) {
        const { status, body } = await platformReq(t, 'GET', API.TASKS, { params: { page, pageSize: 500, status: '', filterAuthExam: 1 } });
        if (status !== 200 || !body || Array.isArray(body)) break;
        const items = ((body as Record<string, unknown>).items ?? []) as Array<Record<string, unknown>>;
        for (const it of items) {
          const id = String(it.businessId ?? it.id ?? '');
          if (id && !seen.has(id)) { seen.add(id); out.push(it); }
        }
        if (!items.length || items.length < 500) break;
      }
      return out;
    })(),
  ]);
  const byBid = new Map(taskPages.filter((t) => t.businessId).map((t) => [String(t.businessId), t]));
  const now = Date.now();
  const tasks = [...courses, ...subjects].map((c) => {
    const tk = byBid.get(c.bid);
    const endTime = c.endTime || Number(tk?.endTime ?? 0) || null;
    const state = (endTime && endTime < now) || (tk && tk.expired === true) ? '已过期'
      : DONE.has(c.finish) ? '已完成' : '进行中';
    return {
      bid: c.bid,
      name: c.name,
      kind: c.kind,
      required: c.required,
      finish: c.finish,
      studiedH: fmtH(c.studiedSec),
      endTime,
      state,
    };
  });
  const due = tasks
    .filter((x) => x.required && x.state === '进行中' && x.endTime && x.endTime > now && x.endTime <= now + 7 * 86400_000)
    .sort((a, b) => (a.endTime as number) - (b.endTime as number));
  return { tasks, due };
}

/** 任务列表（含必修标记与截止信息）。
 *  主源 personCourse-list（真学习负载，bt=0 课程 2=专题），human/task 只补充 endTime/expired；
 *  human/task 现在只剩少量活动任务（bt=5 培训班等），老的“任务接口拉全部”模式已失效。 */
apiRouter.get('/tasks', async (req, res) => {
  try {
    const result = await withPlatform(req.user!.id, (t) => taskRows(t));
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

/** 学习记录明细：某天的每门课学时流水（热力图下钻） */
apiRouter.get('/history', async (req, res) => {
  const date = String(req.query.date ?? '') || dayKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ message: 'date 需为 YYYY-MM-DD' }); return; }
  try {
    const logs = await withPlatform(req.user!.id, (t) => studyLogs(t));
    const items = logs.filter((e) => e.day === date)
      .sort((a, b) => b.sec - a.sec)
      .map((e) => ({ name: e.name, minutes: Math.round(e.sec / 60), kind: e.kind, required: e.required }));
    res.json({ date, totalMin: items.reduce((s, x) => s + x.minutes, 0), items });
  } catch (e) { sendErr(res, e); }
});

/** 日程：班级/考试/调研/直播，窗口过去7天～未来一年 */
apiRouter.get('/schedule', async (req, res) => {
  try {
    const items = await withPlatform(req.user!.id, (t) => scheduleItems(t));
    res.json({ items });
  } catch (e) { sendErr(res, e); }
});

/** 日历导出：日程活动 + 必修未完任务的截止日（各带 3 天提前提醒） */
apiRouter.get('/ics', async (req, res) => {
  try {
    const events = await withPlatform(req.user!.id, async (t) => {
      const [sched, rows] = await Promise.all([scheduleItems(t), taskRows(t)]);
      const out: IcsEvent[] = [];
      for (const s of sched) {
        if (!s.start) continue;
        const end = s.end && s.end > s.start ? new Date(s.end) : undefined;
        out.push({ uid: `${s.id}@mooc-auto-study`, summary: `【${s.kind}】${s.name}`, start: new Date(s.start), end });
      }
      for (const x of rows.due) {
        const end = new Date(x.endTime as number);
        out.push({
          uid: `due:${x.bid}@mooc-auto-study`,
          summary: `【必修截止】${x.name}（${x.kind}）`,
          start: end,
          alarmDays: 3,
        });
      }
      return out;
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mooc-schedule.ics"');
    res.send(buildIcs(events));
  } catch (e) { sendErr(res, e); }
});

/** 26 周热力图 */
apiRouter.get('/heatmap', async (req, res) => {
  try {
    const byDay = await withPlatform(req.user!.id, (t) => studyLogDays(t));
    const today = new Date();
    const cells: Array<{ day: string; hours: number; level: number; future: boolean }> = [];
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - 26 * 7 + 1); // 26 周窗口
    // 从周日开始补齐首周
    start.setDate(start.getDate() - start.getDay());
    const levelOf = (h: number) => (h <= 0 ? 0 : h < 0.5 ? 1 : h < 1 ? 2 : h < 2 ? 3 : 4);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d);
      const sec = byDay[key] ?? 0;
      cells.push({ day: key, hours: Number((sec / 3600).toFixed(2)), level: levelOf(sec / 3600), future: false });
    }
    const todayKey = dayKey(today);
    const todayH = (byDay[todayKey] ?? 0) / 3600;
    const weekStart = new Date(end); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const sumRange = (from: Date, to: Date) => {
      let s = 0;
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) s += (byDay[dayKey(d)] ?? 0);
      return s / 3600;
    };
    res.json({
      cells,
      summary: {
        today: todayH,
        week: sumRange(weekStart, end),
        month: sumRange(new Date(today.getFullYear(), today.getMonth(), 1), end),
        year: sumRange(new Date(today.getFullYear(), 0, 1), end),
      },
    });
  } catch (e) { sendErr(res, e); }
});

/** 课程库 12 类检索 */
apiRouter.get('/library', async (req, res) => {
  const typeId = Number(req.query.kind ?? 0);
  const kw = String(req.query.kw ?? '');
  const page = Number(req.query.page ?? 1);
  try {
    const out = await withPlatform(req.user!.id, async (t) => {
      const [courses, subjects] = await Promise.all([personCourses(t, 0), personCourses(t, 2)]);
      const joined = new Set([...courses, ...subjects].map((c) => c.bid));
      return librarySearch(t, typeId, kw, page, joined);
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

/** 快速搜索（课程/专题） */
apiRouter.get('/search', async (req, res) => {
  const kw = String(req.query.kw ?? '');
  const kind = String(req.query.kind ?? 'course');
  try { res.json(await withPlatform(req.user!.id, (t) => search(t, kw, kind))); }
  catch (e) { sendErr(res, e); }
});

/** 引擎控制 */
apiRouter.post('/engine/start', asyncH(async (req, res) => {
  const courseId = String((req.body as { courseId?: string } | undefined)?.courseId ?? '').trim();
  const out = await startRun(req.user!.id, courseId);
  res.status(out.ok ? 200 : 409).json(out);
}));
apiRouter.post('/engine/stop', (req, res) => { res.json(stopRun(req.user!.id)); });
apiRouter.get('/engine/status', (req, res) => { res.json(runStatus(req.user!.id)); });

/** 引擎运行历史（最近 N 次） */
apiRouter.get('/engine/runs', async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 5)));
  try {
    const rows = await prisma.engineRun.findMany({
      where: { userId: req.user!.id, endedAt: { not: null } },
      orderBy: { startedAt: 'desc' }, take: limit,
    });
    res.json(rows.map((r) => ({
      id: r.id, startedAt: r.startedAt.getTime(), endedAt: r.endedAt?.getTime() ?? null,
      trigger: r.trigger, reason: r.reason, submitted: r.submitted,
    })));
  } catch (e) { sendErr(res, e); }
});

/** 定时引擎排程（每用户一条） */
apiRouter.get('/engine/schedule', async (req, res) => {
  try {
    const row = await prisma.engineSchedule.findUnique({ where: { userId: req.user!.id } });
    res.json({ enabled: row?.enabled ?? false, hour: row?.hour ?? 9, minute: row?.minute ?? 0, lastRunDay: row?.lastRunDay ?? null });
  } catch (e) { sendErr(res, e); }
});
apiRouter.put('/engine/schedule', asyncH(async (req, res) => {
  const b = (req.body ?? {}) as { enabled?: boolean; hour?: number; minute?: number };
  const prev = await prisma.engineSchedule.findUnique({ where: { userId: req.user!.id } });
  const enabled = b.enabled === undefined ? (prev?.enabled ?? false) : Boolean(b.enabled);
  const hour = b.hour === undefined ? (prev?.hour ?? 9) : Number(b.hour);
  const minute = b.minute === undefined ? (prev?.minute ?? 0) : Number(b.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    res.status(400).json({ message: 'hour 需 0-23，minute 需 0-59' }); return;
  }
  await prisma.engineSchedule.upsert({
    where: { userId: req.user!.id },
    update: { enabled, hour, minute },
    create: { userId: req.user!.id, enabled, hour, minute },
  });
  res.json({ ok: true, enabled, hour, minute });
}));

/** 课程详情预览：章节/小节树（启动引擎前先看会跑什么） */
apiRouter.get('/course-info', async (req, res) => {
  const bid = String(req.query.bid ?? '').trim();
  if (!bid) { res.status(400).json({ message: '缺 bid' }); return; }
  try {
    const out = await withPlatform(req.user!.id, async (t) => {
      const { body } = await platformReq(t, 'GET', `${API.INFO}/${encodeURIComponent(bid)}`, { params: { _: Date.now() } });
      const j = (body && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const chapters = ((j.courseChapters ?? []) as Array<Record<string, unknown>>).map((c) => ({
        title: String(c.title ?? ''),
        sections: ((c.courseChapterSections ?? []) as Array<Record<string, unknown>>).map((x) => ({
          id: String(x.id ?? ''),
          name: String(x.name ?? ''),
          kind: String(x.fileType ?? ''),
          minutes: Number(x.timeMinute ?? 0) || (Number(x.totalTime ?? 0) ? Math.round(Number(x.totalTime) / 60) : null),
        })),
      }));
      return { name: String(j.name ?? ''), lecturer: String(j.lecturer ?? ''), courseHour: Number(j.courseHour ?? 0) || null, chapters };
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

/** 已加入任务集合（给课程库打标用） */
apiRouter.get('/joined', async (req, res) => {
  try {
    const out = await withPlatform(req.user!.id, async (t) => {
      const [courses, subjects] = await Promise.all([personCourses(t, 0), personCourses(t, 2)]);
      return [...courses, ...subjects].map((c) => ({ bid: c.bid, name: c.name, kind: c.businessType === 2 ? '专题' : '课程', required: c.required, finish: c.finish, studiedH: fmtH(c.studiedSec) }));
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

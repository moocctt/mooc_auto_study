// 平台数据服务：在 platformReq 之上提供业务查询（与 v0.1 lib/api.js 对齐）。
import { PlatformError, platformReq } from './client.js';
import { API, LIBRARY_TYPES, SEARCH_TYPE, type LibrarySpec } from './endpoints.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v) || 0;
const asRow = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});

export async function search(token: string, keyword: string, kind = 'course', page = 1) {
  const kw = keyword.trim();
  if (!kw) return { items: [] as Row[], total: 0 };
  const type = SEARCH_TYPE[kind] ?? 0;
  const { status, body } = await platformReq(token, 'GET', API.SEARCH, { params: { type, publishClient: 1, searchContent: kw, page, pageSize: 20 } });
  if (status !== 200 || !body || Array.isArray(body)) throw new PlatformError(`搜索失败（HTTP ${status}）`);
  const data = asRow((body as Row).data !== undefined && !Array.isArray((body as Row).data) ? (body as Row).data : body);
  const items = (data.items ?? []) as Row[];
  return { items, total: num(data.total) || items.length };
}

const rawTypeOf = (it: Row): number | null => {
  for (const k of ['type', 'courseType', 'businessType', 'kindType']) {
    const v = it[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const coverOf = (it: Row): string => {
  const path = (it.coverPath ?? it.coverImage ?? it.coverUrl ?? it.img ?? it.pic ?? it.cover ?? '') as string;
  if (!path) return '';
  return /^https?:\/\//.test(path) ? path : `https://mooc.ctt.cn/${path}`;
};
const nameOf = (it: Row): string =>
  String(it.name ?? it.className ?? it.subject ?? it.title ?? it.newsName ?? it.interchangeName ?? it.fileName ?? '');

export interface LibraryItem {
  id: string; name: string; kind: string; courseHour: number; credit: number;
  startTime: number | null; endTime: number | null; cover: string; linkable: boolean; joined?: boolean;
}

export async function librarySearch(token: string, typeId: number, keyword: string, page = 1, joinedBids = new Set<string>()) {
  const spec = LIBRARY_TYPES.find((t) => t.id === typeId) ?? (LIBRARY_TYPES[0] as LibrarySpec);
  const kw = keyword.trim();
  if (!kw) return { items: [] as LibraryItem[], total: 0, spec };
  const { status, body } = await platformReq(token, 'GET', spec.path, { params: { ...spec.params(kw), page, pageSize: 20, _: Date.now() } });
  if (status !== 200 || !body || Array.isArray(body)) throw new PlatformError(`${spec.label}检索失败（HTTP ${status}）`);
  const items: LibraryItem[] = [];
  for (const raw of ((body as Row).items ?? []) as Row[]) {
    const id = raw.id as string | undefined;
    if (!id) continue;
    if (spec.id === 0 || spec.id === 2) {
      const rt = rawTypeOf(raw);
      if (rt !== null && rt !== spec.id) continue;
    }
    items.push({
      id, name: nameOf(raw), kind: spec.label,
      courseHour: num(raw.courseHour), credit: num(raw.credit),
      startTime: num(raw.startTime) || null, endTime: num(raw.endTime) || null,
      cover: coverOf(raw), linkable: !!spec.linkable,
      joined: joinedBids.has(id),
    });
  }
  return { items, total: num((body as Row).recordCount) || items.length, spec };
}

export async function hoursSelf(token: string): Promise<Row> {
  const { status, body } = await platformReq(token, 'GET', API.HOURS);
  if (status !== 200 || !body || Array.isArray(body)) throw new PlatformError(`学时账单获取失败（HTTP ${status}）`);
  return body as Row;
}

export interface PersonCourse {
  bid: string; name: string; required: boolean; finish: number; studiedSec: number;
  businessType: number; regTime: number | null; endTime: number | null; kind: string;
}

export async function personCourses(token: string, businessType: number, pageSize = 500): Promise<PersonCourse[]> {
  const { status, body } = await platformReq(token, 'GET', API.PERSON_COURSE, {
    params: { page: 1, pageSize, findStudy: 0, businessType, studyTimeOrder: 'desc', finishStatus: '', isRequired: '' },
  });
  if (status !== 200 || !body || Array.isArray(body)) return [];
  const out: PersonCourse[] = [];
  const seen = new Set<string>();
  for (const it of ((body as Row).items ?? []) as Row[]) {
    const bid = it.courseId as string | undefined;
    if (!bid || seen.has(bid)) continue;
    seen.add(bid);
    out.push({
      bid,
      name: String(asRow(it.courseInfo).name ?? ''),
      required: it.isRequired === 1,
      finish: Number(it.finishStatus ?? 0),
      studiedSec: num(it.studyTotalTime),
      businessType,
      regTime: num(it.registerTime) || null,
      endTime: num(asRow(it.courseInfo).endTime) || null,
      kind: businessType === 0 ? '课程' : '专题',
    });
  }
  return out;
}

/** 学习日志明细：每门课的学时归到 lastAccessTime 那天（docs/API-NOTES.md §3）。
   热力图聚合与「学习记录明细」共用同一份拉取。 */
export interface StudyLogEntry {
  day: string;          // YYYY-MM-DD
  name: string;
  kind: string;         // 课程 | 专题
  required: boolean;
  sec: number;
  last: number | null;  // lastAccessTime ms
}

export async function studyLogs(token: string): Promise<StudyLogEntry[]> {
  const y = new Date().getFullYear();
  const start = new Date(y, 0, 1).getTime();
  const end = new Date(y, 11, 31, 23, 59, 59, 999).getTime();
  const out: StudyLogEntry[] = [];
  const collect = async (path: string, businessType: number) => {
    for (let page = 1; page <= 20; page++) {
      let body: Row | null = null;
      try {
        const { body: b } = await platformReq(token, 'GET', path, { params: { businessType, startTime: start, endTime: end, page, pageSize: 100 } });
        if (b && !Array.isArray(b)) body = b as Row;
      } catch { return; }
      for (const it of ((body?.items ?? []) as Row[])) {
        const sec = num(it.studyTotalTime);
        const ts = it.lastAccessTime ?? it.finishTime ?? it.markTime;
        if (!sec || !ts) continue;
        const d = new Date(Number(ts));
        out.push({
          day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
          name: String(asRow(it.courseInfo).name ?? ''),
          kind: businessType === 0 ? '课程' : '专题',
          required: it.isRequired === 1,
          sec,
          last: num(it.lastAccessTime) || null,
        });
      }
      if (page * 100 >= num(body?.recordCount)) return;
    }
  };
  await collect(API.COURSE_LOG, 0);
  await collect(API.SUBJECT_LOG, 2);
  return out;
}

/** 按日学时秒聚合（热力图用） */
export async function studyLogDays(token: string): Promise<Record<string, number>> {
  const byDay: Record<string, number> = {};
  for (const e of await studyLogs(token)) byDay[e.day] = (byDay[e.day] ?? 0) + e.sec;
  return byDay;
}

/** 日程：班级/考试/调研/直播全量列表（无关键词即可拉全量，2026-11-13 实测）。
   只保留有起止时间且在窗口内（过去 7 天 ～ 未来 365 天）的项，按开始时间升序。 */
export interface ScheduleItem {
  id: string; name: string; kind: string; start: number | null; end: number | null;
}

const SCHEDULE_SOURCES: Array<{ kind: string; slug: string; path: string; params: Record<string, unknown> }> = [
  { kind: '班级', slug: 'cls', path: '/api/v1/training/student/class-info/simple-activity-list', params: { name: '' } },
  { kind: '考试', slug: 'exam', path: '/api/v1/exam/exam/front/activity-list', params: { clientType: 1, name: '' } },
  { kind: '调研', slug: 'survey', path: '/api/v1/exam/research-activity/activity-list', params: { name: '' } },
  { kind: '直播', slug: 'live', path: '/api/v1/course-study/gensee/activity-list', params: { clientType: 1, name: '' } },
];

export async function scheduleItems(token: string, windowDays = 365): Promise<ScheduleItem[]> {
  const from = Date.now() - 7 * 86400_000;
  const to = Date.now() + windowDays * 86400_000;
  const out: ScheduleItem[] = [];
  for (const src of SCHEDULE_SOURCES) {
    for (let page = 1; page <= 4; page++) {
      let body: Row | null = null;
      try {
        const { body: b } = await platformReq(token, 'GET', src.path, { params: { ...src.params, page, pageSize: 50, _: Date.now() } });
        if (b && !Array.isArray(b)) body = b as Row;
      } catch { break; }
      for (const it of ((body?.items ?? []) as Row[])) {
        const id = it.id as string | undefined;
        if (!id) continue;
        const s = num(it.startTime) || null;
        const e = num(it.endTime) || null;
        const latest = s ?? e;
        const name = String(it.className ?? it.name ?? it.genseeDesc ?? it.subject ?? '');
        if (!name || latest === null) continue;
        if (latest < from || (s && s > to)) continue;
        out.push({ id: `${src.slug}:${id}`, name, kind: src.kind, start: s, end: e });
      }
      if (page * 50 >= num(body?.recordCount)) break;
    }
  }
  return out.sort((a, b) => (a.start ?? a.end ?? 0) - (b.start ?? b.end ?? 0));
}

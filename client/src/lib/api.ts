/** API 客户端：fetch 封装 + 401 统一处理（ TanStack Query 层负责缓存） */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    credentials: 'same-origin',
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const b = body as { message?: string; code?: string } | null;
    // 401 交给 useMe 换登录页；code 让页面做机器可读分支，不猜文案
    throw new ApiError(b?.message ?? `HTTP ${res.status}`, res.status, res.status === 401 ? 'AUTH' : b?.code);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data === undefined ? '{}' : JSON.stringify(data) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: data === undefined ? '{}' : JSON.stringify(data) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---------- 类型 ----------

export interface Me { id: string; username: string }
export interface PlatformBound { username: string; company: string }

export interface Hours {
  self: { done: number; required: number; pct: number };
  train: { done: number; required: number; pct: number };
  gap: number;
  forecast?: { weeklyH: number; remainingH: number; eta: number | null };
}

export interface ScheduleCfg { enabled: boolean; hour: number; minute: number; lastRunDay: string | null }

export interface EngineRunRow {
  id: string; startedAt: number; endedAt: number | null;
  trigger: string; reason: string | null; submitted: number | null;
}

export interface TaskRow {
  bid: string; name: string; kind: string; required: boolean;
  finish: number; studiedH: string; endTime: number | null; state: string;
}

export interface DueRow {
  bid: string; name: string; kind: string; required: boolean;
  finish: number; studiedH: string; endTime: number | null; state: string;
}

export interface Heatmap {
  cells: Array<{ day: string; hours: number; level: number; future: boolean }>;
  summary: { today: number; week: number; month: number; year: number };
}

export interface HistoryDay {
  date: string; totalMin: number;
  items: Array<{ name: string; minutes: number; kind: string; required: boolean }>;
}

export interface ScheduleItem { id: string; name: string; kind: string; start: number | null; end: number | null }

export interface CourseSection { id: string; name: string; kind: string; minutes: number | null }
export interface CourseChapter { title: string; sections: CourseSection[] }
export interface CourseInfo { name: string; lecturer: string; courseHour: number | null; chapters: CourseChapter[] }

export interface LibraryItem {
  id: string; name: string; kind: string; courseHour: number; credit: number;
  startTime: number | null; endTime: number | null; cover: string; linkable: boolean; joined?: boolean;
}
export interface LibraryResult { items: LibraryItem[]; total: number; spec: { id: number; label: string } }

export interface EngineStatus {
  running: boolean; startedAt: number | null;
  course: string; section: string; round: number; submitted: number;
  logs: string[];
}

export const LIBRARY_KINDS = [
  { id: 0, label: '课程' }, { id: 2, label: '专题' }, { id: 4, label: '班级' },
  { id: 5, label: '考试' }, { id: 6, label: '调研' }, { id: 7, label: '直播' },
  { id: 11, label: '话题' }, { id: 12, label: '知识' }, { id: 14, label: '微吼直播' },
  { id: 15, label: '新闻资讯' }, { id: 16, label: '交流园地' }, { id: 20, label: '专区专家' },
];

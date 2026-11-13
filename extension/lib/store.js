/**
 * 全局状态：极简外部 store（订阅-通知, 无框架依赖）
 * 状态形状与 ext 分支 lib/store.tsx 一致, 行为对齐; UI 层由 console/app.js 订阅渲染。
 */

/* 「完整功能」解锁是一次性开关, 刷新/重开控制台后应保持 —— 与侧栏折叠一样存本机 localStorage */
const UNLOCK_KEY = 'mooc.console.unlocked';
const readUnlocked = () => {
  try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch { return false; }
};

const initial = {
  ready: false, route: 'report', accounts: [], hours: {}, rows: [],
  mode: 'auto', busy: null, runs: [], logs: [],
  error: '', loading: false,
  filters: { status: 'all', type: 'all', q: '' },
  drawer: null, logOpen: false, loginOpen: false, loginPrefill: '', stream: null, autoScroll: true, onlyErrors: false,
  searchQuery: '', searchRows: [], searching: false, libType: 0, libPage: 1, libTotal: 0,
  history: {}, libraryRecs: [], tasksTab: 'mine', settingsTab: 'prefs',
  unlocked: readUnlocked(), toasts: [], modal: null,
  ap: { on: false, status: '', at: 0 },
  needLogin: null,
};

let state = initial;
const listeners = new Set();

export const getState = () => state;

export function setState(patch) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if ('unlocked' in p) {
    try { localStorage.setItem(UNLOCK_KEY, state.unlocked ? '1' : '0'); } catch { /* 忽略 */ }
  }
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let toastSeq = 0;
export function toast(message, kind = 'info', ms = 3600) {
  import('./sfx.js').then(({ sfx }) => { if (kind === 'ok' || kind === 'err') sfx(kind); }).catch(() => {});
  const id = ++toastSeq;
  setState({ toasts: [...state.toasts, { id, message, kind }] });
  setTimeout(() => setState({ toasts: getState().toasts.filter((t) => t.id !== id) }), ms);
}

export function openModal(m) { setState({ modal: m }); }
export const openLog = (runId) => setState({ logOpen: true, drawer: null, logRun: runId });   // 浮层互斥
export const closeLog = () => setState({ logOpen: false });
export const openLogin = (prefill = '') => setState({ loginOpen: true, loginPrefill: String(prefill || '') });
export const closeLogin = () => setState({ loginOpen: false, loginPrefill: '' });

/** 确认弹窗（body 传纯文本; HTML 需自转义, 避免把平台数据当标记注入） */
export function confirmAction(title, message, confirmLabel, onOk) {
  openModal({
    title,
    body: message,
    actions: [
      { label: '取消' },
      { label: confirmLabel, kind: 'primary', onClick: (close) => { close(); onOk(); } },
    ],
  });
}

/** 旧路由 → 新页面 + 页内标签（保持书签/深链可用） */
export const ALIAS = {
  overview: { route: 'report' },
  search: { route: 'tasks', patch: { tasksTab: 'library' } },
  accounts: { route: 'settings', patch: { settingsTab: 'accounts' } },
};

export function go(route) {
  const hit = ALIAS[route];
  if (hit) { if (hit.patch) setState(hit.patch); route = hit.route; }
  setState({ route });
  try { if (location.hash !== `#/${route}`) history.replaceState(null, '', `${location.pathname}${location.search}#/${route}`); } catch { /* srcdoc 等环境忽略 */ }
}

export const NAV = [
  { id: 'report', label: '概览', title: '概览', sub: '学时账单、截止提醒与统计', icon: 'bar' },
  { id: 'tasks', label: '课程', title: '课程', sub: '任务、小节与课程库', icon: 'grid' },
  { id: 'settings', label: '设置', title: '设置', sub: '账号、偏好与隐私', icon: 'sliders' },
];

/** 课程页: 我的任务（筛选/分页/双视图）+ 课程库（搜索/类型/分页）+ 任务行/封面卡。
 *  移植自 src/components/{Tasks,SearchPage,TaskRow,CourseCard}.tsx。
 *  输入不进 store: 本地变量 + 只重渲染结果区, 键入不丢焦点。 */
import { getState, setState } from '../../lib/store.js';
import { STORE } from '../../lib/flags.js';
import { barPercent, filterRows, formatPercent, PAGE_SIZE, isAutopilotTarget } from '../../lib/core.js';
import {
  doSearch, getCurrentToken, openSections, probeLibraryTypes, runCourse, startAutopilotFrom, startAutopilotFromLibrary,
} from '../../lib/actions.js';
import { existingOf } from '../../lib/search.js';
import { LIBRARY_TYPES, readAvailTypes } from '../../lib/library.js';
import { coverOf } from '../../lib/cover.js';
import { ssoCourseUrl } from '../../lib/links.js';
import { el, icon, pagination } from '../ui.js';

/* ── 任务行（列表视图, 概览「继续学习」复用）────────────────────── */
export function taskRow(r, unlocked, busy) {
  const token = getCurrentToken();
  const done = String(r.state).startsWith('已完成');
  const row = el('div', {
    class: 'task-row', role: 'button', tabindex: 0,
    onclick: () => void openSections(r),
  });
  row.addEventListener('keydown', (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openSections(r); }
  });
  row.append(
    el('span', {
      class: 'tdot',
      style: { background: r.state === '学习中' ? 'var(--brand-mid)' : done ? 'var(--brand)' : r.state === '已过期' ? 'var(--line)' : 'var(--amber)' },
    }),
    el('div', { class: 'task-main' },
      el('div', { class: 'task-title' },
        el('a', {
          href: ssoCourseUrl(r, token), target: '_blank', rel: 'noopener noreferrer',
          title: '在学院平台打开这门课程学习（用当前登录态，免再次登录）',
          class: done ? 'done' : '', text: r.name,
          onclick: (e) => e.stopPropagation(),
        }),
        r.required === '必修' ? el('span', { class: 'req-badge', text: '必修' }) : '',
      ),
      el('div', { class: 'task-meta' },
        `${r.type} · ${r.endTime ? `截止 ${new Date(r.endTime).toLocaleDateString('zh-CN')}` : r.state === '已过期' ? '已过期' : (r.push_ts ? `推送 ${new Date(r.push_ts).toLocaleDateString('zh-CN')}` : '')}`,
        hoursMeta(r),
      ),
    ),
    el('div', { class: 'task-side' },
      pillFor(r.state),
      r.runnable && unlocked && !STORE ? el('button', {
        class: 'run-btn-sm', disabled: !!busy,
        title: `快速刷课：在后台按小节连播《${r.name}》，尽快推进进度`,
        onclick: (e) => { e.stopPropagation(); void runCourse(r); },
      }, icon('pulse', 'ic12'), '快速刷课') : '',
      !STORE && isAutopilotTarget(r) ? el('button', {
        type: 'button', class: 'ap-btn-sm', 'data-testid': 'row-autopilot',
        'aria-label': `无人值守播放「${r.name}」`,
        title: `从「${r.name}」开始无人值守自动播放，之后接着播放其它待学课程/专题`,
        onclick: (e) => { e.stopPropagation(); void startAutopilotFrom(r); },
      }, icon('play', 'ic12'), '自动学习') : '',
    ),
  );
  return row;
}

const PILL_CLS = { ok: 'pill-ok', err: 'pill-err', warn: 'pill-warn', info: 'pill-info' };
/** 状态显示名: 数据值保持平台原值(学习中), 显示用「已开始」—— 纯生命周期词, 免被误读为自动化在学 */
const stateText = (s) => (s === '学习中' ? '已开始' : s);

/** 学时信息: 目标与已学都已知 → 「已学 X / Y 学时」; 仅目标 → 「Y 学时」; 仅已学 → 维持旧式「已学 X 学时」。
 *  已学不足 0.1 学时(约 6 分钟)不显示, 免得出现无信息量的「已学 0.0」 */
function hoursMeta(r) {
  const studied = Number(r.studiedSec || 0);
  const ch = Number(r.courseHour || 0);
  const studiedH = (studied / 3600).toFixed(1);
  if (studied > 0 && studiedH !== '0.0' && ch > 0) return ` · 已学 ${studiedH} / ${ch} 学时`;
  if (studied > 0 && studiedH !== '0.0') return ` · 已学 ${studiedH} 学时`;
  if (ch > 0) return ` · ${ch} 学时`;
  return '';
}
function pillFor(state) {
  const kind = state === '学习中' ? 'info' : String(state).startsWith('已完成') ? 'ok' : state === '已过期' ? '' : 'warn';
  return el('span', { class: `pill ${PILL_CLS[kind] || ''}`, text: stateText(state) });
}

/* ── 封面卡（任务页卡片视图）────────────────────────────── */
const failedCovers = new Set();

export function courseCard(r, unlocked, busy) {
  const token = getCurrentToken();
  const cover = coverOf(r);
  const done = String(r.state).startsWith('已完成');
  const kindCls = { 学习中: 'pill-info', 已完成: 'pill-ok', 已过期: '' }[r.state] ?? 'pill-warn';
  const cardStateText = stateText(r.state);

  const art = el('div', { class: 'ph' });
  if (cover.img && !failedCovers.has(cover.img)) {
    const img = el('img', { src: cover.img, alt: r.name, loading: 'lazy' });
    img.addEventListener('error', () => { failedCovers.add(cover.img); art.replaceChildren(coverPlaceholder(cover, r)); });
    art.append(img);
  } else {
    art.append(coverPlaceholder(cover, r));
  }

  const card = el('article', { class: 'course-card', 'data-testid': 'course-card' },
    el('button', {
      type: 'button', class: 'cc-cover', 'aria-label': `查看《${r.name}》小节`, title: '查看课程小节',
      onclick: (e) => { e.stopPropagation(); void openSections(r); },
    },
      art,
      el('span', { class: 'cc-kind', text: r.type }),
      r.required === '必修' ? el('span', { class: 'cc-required', text: '必修' }) : '',
    ),
    el('div', { class: 'cc-body' },
      el('div', { class: 'cc-title-row' },
        el('a', {
          href: ssoCourseUrl(r, token), target: '_blank', rel: 'noopener noreferrer',
          title: '去学院平台学习（免再次登录）', text: r.name,
        }),
        el('span', { class: `pill ${kindCls}`, text: cardStateText }),
      ),
      el('div', { class: 'cc-meta' },
        r.endTime ? `截止 ${new Date(r.endTime).toLocaleDateString('zh-CN')}` : (r.push_ts ? `推送 ${new Date(r.push_ts).toLocaleDateString('zh-CN')}` : ''),
        hoursMeta(r),
      ),
      !STORE && ((unlocked && r.runnable) || isAutopilotTarget(r)) ? el('div', { class: 'cc-actions' },
        unlocked && r.runnable ? el('button', {
          class: 'run-btn', disabled: !!busy, title: `快速刷课：在后台按小节连播《${r.name}》，尽快推进进度`,
          onclick: () => void runCourse(r),
        }, icon('pulse', 'ic12'), '快速刷课') : '',
        isAutopilotTarget(r) ? el('button', {
          type: 'button', class: 'ap-btn', 'data-testid': 'card-autopilot',
          'aria-label': `无人值守播放「${r.name}」`,
          title: `从「${r.name}」开始无人值守自动播放，之后接着播放其它待学课程/专题`,
          onclick: (e) => { e.stopPropagation(); void startAutopilotFrom(r); },
        }, icon('play', 'ic12'), '自动学习') : '',
      ) : '',
    ),
  );
  return card;
}

function coverPlaceholder(cover, r) {
  return el('div', {
    class: 'ph',
    style: { background: `linear-gradient(135deg, ${cover.from}, ${cover.to})` },
  }, el('span', { text: r.name }));
}

/* ── 任务页: 两 tab ────────────────────────────────────── */
export function renderTasks(host, s) {
  const sig = s.tasksTab;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  for (const [v, label] of [['mine', '我的任务'], ['library', '课程库']]) {
    const b = el('button', { class: 'tab', role: 'tab', 'aria-selected': String(s.tasksTab === v), text: label });
    b.addEventListener('click', () => setState({ tasksTab: v }));
    tabs.append(b);
  }
  const body = el('div', {});
  host.replaceChildren(el('div', { class: 'stack' }, tabs, body));
  if (s.tasksTab === 'library') renderLibrary(body, s);
  else renderTasksMine(body, s);
}

/* ── 我的任务 ──────────────────────────────────────────── */
let filters = { status: 'all', type: 'all', q: '' };
let page = 1;
let view = (() => {
  try { return localStorage.getItem('mooc.console.view') || 'cards'; } catch { return 'cards'; }
})();

export function renderTasksMine(host, s) {
  const outerSig = JSON.stringify([s.hours, s.rows, s.loading, s.error, s.busy, s.unlocked]);
  if (host.dataset.sig !== outerSig) {
    host.dataset.sig = outerSig;
    host.replaceChildren(tasksMineView(s));
  }
  updateMineResults(host, s);
}

function tasksMineView(s) {
  const root = el('div', { class: 'stack' });

  const req = Number(s.hours.requireCourseHour || 0);
  const done = Number(s.hours.hourSelf || 0);
  const remain = Math.max(0, req - done);
  const pctText = formatPercent(done, req);
  const pct = barPercent(done, req);
  if (req > 0) {
    root.append(el('div', { class: 'hours-card' },
      el('div', { class: 'hours-line' },
        el('span', { text: '网络自学学时' }),
        el('span', { class: 'pct', title: '已完成 ÷ 总要求', text: pctText }),
        el('span', { class: '', style: { color: 'var(--ink2)' } }, '已完成 ', el('b', { text: String(done) }), ` / 总要求 ${req} 学时`),
        el('span', { style: { color: 'var(--ink2)' } }, '剩余 ', el('b', { class: remain > 0 ? 'remain-over' : '', style: remain > 0 ? {} : { color: 'var(--brand)' }, text: String(remain) }), ' 学时'),
        el('span', { class: 'tail', text: `集中培训 ${Number(s.hours.hourTrain || 0)} / 参考 ${s.hours.requireClassHour ?? '—'} 学时` }),
      ),
      el('div', { class: 'bar-page', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        el('i', { style: { width: `${pct}%` } })),
    ));
  }

  const types = ['all', ...new Set(s.rows.map((r) => r.type))];
  const seg = el('div', { class: 'seg' });
  for (const key of ['all', '未开始', '学习中', '已完成', '已过期']) {
    const b = el('button', { 'aria-pressed': String(filters.status === key), text: key === 'all' ? '全部' : stateText(key) });
    b.addEventListener('click', () => {
      filters = { ...filters, status: key };
      page = 1;
      const label = key === 'all' ? '全部' : stateText(key);
      for (const btn of seg.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.textContent === label));
      updateMineResults(root, getState());
    });
    seg.append(b);
  }
  const select = el('select', { class: 'tool-select', 'aria-label': '任务类型' });
  for (const t of types) select.append(el('option', { value: t, text: t === 'all' ? '全部类型' : t }));
  select.value = filters.type;
  select.addEventListener('change', () => { filters = { ...filters, type: select.value }; page = 1; updateMineResults(root, getState()); });

  const qInput = el('input', { type: 'search', placeholder: '搜索课程名称…', class: 'tool-input', value: filters.q });
  qInput.addEventListener('input', () => { filters = { ...filters, q: qInput.value }; page = 1; updateMineResults(root, getState()); });

  const viewSeg = el('div', { class: 'seg', role: 'group', 'aria-label': '视图切换' });
  for (const [v, label, ic] of [['cards', '封面', 'grid'], ['list', '列表', 'list']]) {
    const b = el('button', { 'aria-pressed': String(view === v) }, icon(ic, 'ic14'), label);
    b.addEventListener('click', () => {
      view = v;
      try { localStorage.setItem('mooc.console.view', v); } catch { /* 忽略 */ }
      for (const btn of viewSeg.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.textContent === label));
      updateMineResults(root, getState());
    });
    viewSeg.append(b);
  }

  root.append(el('div', { class: 'task-tools' }, seg, select, qInput,
    el('span', { class: 'count-note' }), viewSeg));
  root.append(el('div', { class: 'mine-results' }));
  return root;
}

function updateMineResults(host, s) {
  const results = host.querySelector('.mine-results');
  const countNote = host.querySelector('.count-note');
  if (!results) return;
  const filtered = filterRows(s.rows, filters);
  if (countNote) countNote.textContent = `共 ${filtered.length} 项`;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const sig = JSON.stringify([filters, safePage, view, s.rows, s.loading, s.error, s.busy, s.unlocked]);
  if (results.dataset.sig === sig) return;
  results.dataset.sig = sig;

  const out = el('div', { class: 'stack' });
  if (s.error) out.append(el('p', { class: 'err-box', text: s.error }));
  if (!filtered.length) {
    out.append(el('p', { class: 'empty-box', text: s.loading ? '正在读取学习任务…' : '没有符合条件的任务' }));
  } else if (view === 'cards') {
    const grid = el('div', { class: 'card-grid anim-fade-in', 'data-testid': 'course-cards' });
    paged.forEach((r, i) => {
      grid.append(el('div', { style: { animationDelay: `${Math.min(i * 15, 200)}ms` } }, courseCard(r, s.unlocked, !!s.busy)));
    });
    out.append(grid);
  } else {
    const list = el('div', { class: 'anim-fade-in sec-list' });
    for (const r of paged) list.append(taskRow(r, s.unlocked, !!s.busy));
    out.append(list);
  }
  if (filtered.length > PAGE_SIZE) {
    out.append(pagination({ page: safePage, totalPages, total: filtered.length, onPage: (p) => { page = p; updateMineResults(host, getState()); }, unit: '项' }));
  }
  results.replaceChildren(out);
}

/* ── 课程库 ────────────────────────────────────────────── */
const HIST_KEY = 'mooc.console.searchHistory';
const VIEW_KEY = 'mooc.console.searchView';

const loadHist = () => {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
};
const pushHist = (q) => {
  const list = [q, ...loadHist().filter((x) => x !== q)].slice(0, 5);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
  return list;
};

let q = '';
let libView = (() => {
  try { return localStorage.getItem(VIEW_KEY) || 'cards'; } catch { return 'cards'; }
})();
let hist = loadHist();
let availIds = null;
let probedAk = '';
let libErr = '';

export function renderLibrary(host, s) {
  const ak = s.accounts.find((a) => a.active)?.key || '';
  // 打开课程库: 先浏览当前类型的全部内容（分页）; 只在每次进入 tab 时跑一次
  if (!s.searchQuery && !s.searchRows.length && !s.searching && host.dataset.entered !== '1') {
    host.dataset.entered = '1';
    void doSearch('', { type: s.libType, page: 1, silent: true });
  }
  // 探测各类型是否真有内容（按账号缓存 24h）; 切账号重新探
  if (probedAk !== ak) {
    probedAk = ak;
    availIds = ak ? readAvailTypes(ak) : null;
    void (async () => {
      try {
        const ids = await probeLibraryTypes();
        if (ids && host.isConnected) { availIds = ids; renderLibrary(host, getState()); }
      } catch { /* 探测失败保持上次结果（不隐藏任何类型） */ }
    })();
  }
  // 当前选中的类型被隐藏了 → 回到课程, 别把用户留在不存在的 tab 上
  if (availIds && !availIds.includes(s.libType) && host.dataset.typeFixed !== String(s.libType)) {
    host.dataset.typeFixed = String(s.libType);
    void doSearch('', { type: 0, page: 1, silent: true });
    return;
  }
  host.dataset.typeFixed = '';

  const sig = JSON.stringify([s.searchQuery, s.libType, availIds, hist, libView]);
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.replaceChildren(libraryView(s));
  }
  updateLibResults(host, s);
}

function libraryView(s) {
  const root = el('div', { class: 'stack' });

  // 搜索卡: 输入框不随搜索/翻页重建（值在 DOM 里, 键入不丢焦点）
  const input = el('input', {
    placeholder: '搜索课程、专题、班级、考试、直播等 12 类内容',
    class: 'lib-search-input', value: q,
  });
  input.addEventListener('input', () => { q = input.value; updateTryRow(root); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) runSearch(root, getState()); });   // IME 确认候选词的 Enter 不触发搜索
  const searchBtn = el('button', { class: 'btn btn-primary', style: { width: '80px' } });
  searchBtn.addEventListener('click', () => runSearch(root, getState()));

  const histRow = el('div', { class: 'hist-row' }, el('span', { class: 'cap', text: '最近：' }));
  for (const h of hist) {
    const chip = el('button', { class: 'hist-chip', text: h });
    chip.addEventListener('click', () => { q = h; runSearch(root, s, h); });
    histRow.append(chip);
  }
  if (!hist.length) histRow.style.display = 'none';

  const tryRow = el('div', { class: 'hist-row', style: { marginTop: '12px' } }, el('span', { class: 'cap', text: '试试：' }));
  for (const kw of ['专卖', '安全', '规范化', '电子烟']) {
    const chip = el('button', { class: 'try-chip', text: kw });
    chip.addEventListener('click', () => { q = kw; runSearch(root, s, kw); });
    tryRow.append(chip);
  }

  const errNote = el('p', { class: 'lib-hint', style: { color: 'var(--danger)', display: libErr ? '' : 'none' }, text: libErr });

  root.append(el('div', { class: 'lib-search-card' },
    el('div', { class: 'lib-search-line' }, input, searchBtn),
    histRow,
    tryRow,
    el('p', { class: 'lib-hint', text: '覆盖平台全部 12 类内容；课程/专题可直接去平台学习，已加入任务的会标记出来。' }),
    errNote,
  ));
  syncSearchBtn(root, s);

  // 类型 + 视图切换: 常驻
  const typeChips = el('div', { class: 'type-chips', role: 'group', 'aria-label': '内容类型' });
  const visibleTypes = LIBRARY_TYPES.filter((t) => !availIds || availIds.includes(t.id));
  for (const t of visibleTypes) {
    const chip = el('button', {
      class: 'type-chip', 'aria-pressed': String(s.libType === t.id),
      'aria-label': `浏览${t.label}`, title: `浏览${t.label}`, text: t.label,
    });
    chip.addEventListener('click', () => {
      q = '';
      void doSearch('', { type: t.id, page: 1, silent: true });
    });
    typeChips.append(chip);
  }
  const viewSeg = el('div', { class: 'seg' });
  for (const [v, label, ic] of [['cards', '封面', 'grid'], ['list', '列表', 'list']]) {
    const b = el('button', { 'aria-pressed': String(libView === v), title: v === 'list' ? '列表视图' : '封面视图' }, icon(ic, 'ic14'), label);
    b.addEventListener('click', () => {
      libView = v;
      try { localStorage.setItem(VIEW_KEY, v); } catch { /* 忽略 */ }
      for (const btn of viewSeg.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.textContent === label));
      updateLibResults(root, getState());
    });
    viewSeg.append(b);
  }
  root.append(el('div', { class: 'lib-types' }, typeChips, el('div', { class: 'seg', style: { marginLeft: 'auto' } }, viewSeg)));

  root.append(el('div', { class: 'lib-results' }));
  return root;
}

function updateTryRow(root) {
  // 试试区只在「无输入且无结果」时显示
  const s = getState();
  const show = !q && !s.searchQuery;
  const row = root.querySelectorAll('.hist-row')[1];
  if (row) row.style.display = show ? '' : 'none';
}

function syncSearchBtn(root, s) {
  const btn = root.querySelector('.lib-search-line .btn-primary');
  if (!btn) return;
  btn.disabled = s.searching;
  btn.textContent = s.searching ? '加载中…' : '搜索';
}

function runSearch(root, s, kw) {
  const st = s || getState();
  const input = root.querySelector('.lib-search-input');
  const word = kw !== undefined ? kw : (input?.value.trim() || '');
  libErr = '';
  if (word) { hist = pushHist(word); renderLibrary(root, getState()); }
  void doSearch(word, { type: st.libType, page: 1 }).catch(() => {
    libErr = '搜索失败：平台不可达或登录态失效';
    updateLibResults(root, getState());
  });
}

function updateLibResults(host, s) {
  syncSearchBtn(host, s);
  updateTryRow(host);
  const results = host.querySelector('.lib-results');
  if (!results) return;
  const items = s.searchRows;
  const totalPages = Math.max(1, Math.ceil(s.libTotal / PAGE_SIZE));
  // 结果指纹: 只有数据真正变了才重放淡入, 翻页瞬间不拿旧数据重挂网格
  const resultKey = `${items[0]?.id ?? ''}:${items.length}`;
  const sig = JSON.stringify([s.searchQuery, s.libType, resultKey, s.searching, s.libPage, s.libTotal, s.unlocked, !!s.busy, s.rows, libView, libErr]);
  if (results.dataset.sig === sig) return;
  results.dataset.sig = sig;

  const out = el('div', { class: 'stack' });
  if (s.searching && !s.searchRows.length) out.append(el('p', { style: { margin: 0, fontSize: '14px', color: 'var(--muted)' }, text: '搜索中…' }));

  if (items.length > 0) {
    if (libView === 'cards') {
      const grid = el('div', {
        class: `card-grid anim-fade-in lib-dim ${s.searching ? 'busy' : ''}`,
        'data-testid': 'search-cards', 'aria-busy': String(s.searching),
      });
      items.forEach((r, i) => {
        grid.append(el('div', { style: { animationDelay: `${Math.min(i * 15, 200)}ms` } }, searchCard(r, s)));
      });
      out.append(grid);
    } else {
      const wrap = el('div', {
        class: `lib-table-wrap anim-fade-in lib-dim ${s.searching ? 'busy' : ''}`,
        'aria-busy': String(s.searching),
      });
      const table = el('table', { class: 'lib-table' });
      table.append(el('thead', {}, el('tr', {},
        el('th', { text: '类型' }), el('th', { class: 'grow', text: '名称' }), el('th', { text: '学时' }),
        el('th', { text: '状态' }), el('th', {}))));
      const tbody = el('tbody');
      items.forEach((r, i) => {
        const token = getCurrentToken();
        const ex = existingOf(r, s.rows);
        const tr = el('tr', { style: { animationDelay: `${Math.min(i * 15, 200)}ms` } },
          el('td', {}, el('span', { class: 'kind-tag', text: r.kind })),
          el('td', { class: 'name' },
            r.linkable
              ? el('a', { href: ssoCourseUrl({ id: r.id }, token), target: '_blank', rel: 'noopener noreferrer', text: r.name })
              : el('span', { title: '该类型暂不支持站内直达', text: r.name })),
          el('td', { text: r.courseHour ? String(r.courseHour) : '—' }),
          el('td', { text: ex || '未加入' }),
          el('td', { class: 'ops' },
            !STORE && r.linkable ? el('div', { class: 'ops-inner' },
              s.unlocked ? el('button', {
                class: 'run-btn-sm', disabled: !!s.busy,
                title: `快速刷课：在后台按小节连播《${r.name}》，尽快推进进度`,
                onclick: () => runCourse({ bid: r.id, name: r.name }),
              }, icon('pulse', 'ic12'), '快速刷课') : '',
              el('button', {
                type: 'button', class: 'ap-btn-sm', 'data-testid': 'lib-row-autopilot',
                'aria-label': `自动学习「${r.name}」`,
                title: `从「${r.name}」开始无人值守自动播放（真实播放到 100%），之后接着播放其它待学课程/专题`,
                onclick: () => void startAutopilotFromLibrary(r),
              }, icon('play', 'ic12'), '自动学习'),
            ) : ''),
        );
        tbody.append(tr);
      });
      table.append(tbody);
      wrap.append(table);
      out.append(wrap);
    }
  }

  // 空态: 浏览整类时列表为空也要说明白
  if (!s.searching && !s.searchRows.length && !libErr) {
    const typeLabel = LIBRARY_TYPES.find((t) => t.id === s.libType)?.label ?? '该类型';
    out.append(el('p', {
      style: { margin: 0, fontSize: '14px', color: 'var(--muted)' },
      text: s.searchQuery
        ? `${typeLabel}下没有匹配「${s.searchQuery}」的内容，试试其它关键词或类型`
        : `${typeLabel}暂无可展示内容（平台未返回数据）`,
    }));
  }

  if (s.libTotal > 0 && s.searchRows.length > 0) {
    out.append(pagination({
      page: s.libPage, totalPages, total: s.libTotal,
      onPage: (p) => void doSearch(s.searchQuery, { type: s.libType, page: p, paging: true }),
      unit: '项',
    }));
  }
  results.replaceChildren(out);
}

function searchCard(r, s) {
  const token = getCurrentToken();
  const cover = coverOf({ name: r.name, cover: r.cover });
  const ex = existingOf(r, s.rows);
  const art = el('div', { class: 'ph' });
  if (r.cover && !failedCovers.has(r.cover)) {
    const img = el('img', { src: r.cover, alt: r.name, loading: 'lazy' });
    img.addEventListener('error', () => { failedCovers.add(r.cover); art.replaceChildren(searchCover(cover, r, ex)); });
    art.append(img);
  } else {
    art.append(searchCover(cover, r, ex));
  }

  return el('article', { class: 'course-card', 'data-testid': 'search-card' },
    r.linkable
      ? el('button', {
          type: 'button', class: 'cc-cover', 'aria-label': `查看《${r.name}》小节`, title: '查看课程小节',
          onclick: () => void openSections({ bid: r.id, name: r.name }),
        }, art)
      : el('div', { class: 'cc-cover', style: { cursor: 'default' } }, art),
    el('div', { class: 'cc-body' },
      r.linkable
        ? el('a', {
            href: ssoCourseUrl({ id: r.id }, token), target: '_blank', rel: 'noopener noreferrer',
            title: '去学院平台学习（免再次登录）', text: r.name,
          })
        : el('h3', { title: r.name, text: r.name }),
      el('p', { class: 'cc-meta', text: r.courseHour ? `${r.courseHour} 学时` : '' }),
      !STORE && r.linkable ? el('div', { class: 'cc-actions' },
        s.unlocked ? el('button', {
          class: 'run-btn', disabled: !!s.busy,
          title: `快速刷课：在后台按小节连播《${r.name}》，尽快推进进度`,
          onclick: () => runCourse({ bid: r.id, name: r.name }),
        }, icon('pulse', 'ic12'), '快速刷课') : '',
        // 课程库课程可能还没加入「我的任务」, 平台打开详情页时会自动报名
        el('button', {
          type: 'button', class: 'ap-btn', 'data-testid': 'lib-card-autopilot',
          'aria-label': `自动学习「${r.name}」`,
          title: `从「${r.name}」开始无人值守自动播放（真实播放到 100%），之后接着播放其它待学课程/专题`,
          onclick: () => void startAutopilotFromLibrary(r),
        }, icon('play', 'ic12'), '自动学习'),
      ) : '',
    ),
  );
}

function searchCover(cover, r, ex) {
  const box = el('div', { class: 'ph' });
  if (r.cover) {
    box.append(el('img', { src: r.cover, alt: r.name, loading: 'lazy' }));
  } else {
    box.style.background = `linear-gradient(135deg, ${cover.from}, ${cover.to})`;
    box.append(el('span', { text: r.name }));
  }
  return box;
}

/** 概览页: 年度账单 + 统计 + 提醒 + 推荐 + 热力图 + 继续学习 + 最近运行 + 解锁手势。
 *  移植自 src/components/{Home,DueSoon,Recommended,Stats,Heatmap}.tsx */
import { getState, go, setState, toast } from '../../lib/store.js';
import { STORE } from '../../lib/flags.js';
import {
  forceRefreshAll, isAutopilotOn, openPlatformLoggedIn, runTodo, startAutopilot, stopAutopilot,
} from '../../lib/actions.js';
import { barPercent, continueList, fmtNum, formatPercent } from '../../lib/core.js';
import { todayCapacity, todayHoursTotal } from '../../lib/today.js';
import { dueSoon, daysLeftText } from '../../lib/deadline.js';
import { summarize, heatmapCells } from '../../lib/history.js';
import { THEME } from '../../lib/theme.js';
import { getCurrentToken } from '../../lib/actions.js';
import { ssoCourseUrl } from '../../lib/links.js';
import { runHours } from '../overlays.js';
import { el, icon, num, pill, progress, statCard, runChip } from '../ui.js';
import { taskRow } from './tasks.js';

let taps = 0;
let lastTapAt = 0;

/* 值守状态提示轮询（storage 每 2s, 对齐 React 版 useEffect） */
let apStatus = '';
let apTimer = 0;

function stopApPoll() { if (apTimer) { clearInterval(apTimer); apTimer = 0; } }

function startApPoll(onChange) {
  stopApPoll();
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.get) return;
  const tick = async () => {
    try {
      const got = await storage.get(['mooc.autopilot', 'mooc.autopilotStatus']);
      const next = got?.['mooc.autopilot'] ? (got['mooc.autopilotStatus'] || '值守中') : '';
      if (next !== apStatus) { apStatus = next; onChange(); }
    } catch { /* 存储不可用: 忽略 */ }
  };
  void tick();
  apTimer = setInterval(tick, 2000);
}

export function renderHome(host, s) {
  const activeKey = s.accounts.find((a) => a.active)?.key || 'default';
  const sig = JSON.stringify([s.hours, s.rows, s.loading, s.runs, s.error, s.unlocked, s.history,
    s.accounts.map((a) => [a.key, a.active]), apStatus]);
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  startApPoll(() => renderHome(host, getState()));
  host.replaceChildren(homeView(s, activeKey));
}

function homeView(s, activeKey) {
  const hs = Number(s.hours.hourSelf || 0);
  const req = Number(s.hours.requireCourseHour || 0);
  const train = Number(s.hours.hourTrain || 0);
  const pct = barPercent(hs, req);
  const done = s.rows.filter((r) => String(r.state).startsWith('已完成')).length;
  const required = s.rows.filter((r) => r.required === '必修').length;
  const undone = s.rows.filter((r) => r.runnable && r.state !== '已完成' && r.state !== '已过期');
  const reqMust = s.rows.filter((r) => r.runnable && r.required === '必修' && r.state !== '已完成' && r.state !== '已过期').length;
  const cont = continueList(s.rows);
  const year = new Date().getFullYear();
  const todayTotal = todayHoursTotal(hs, activeKey, s.history);
  const cap = todayCapacity()[0];


  const toggleAutopilot = async () => {
    if (await isAutopilotOn()) { await stopAutopilot(); return; }
    // startAutopilot 内会带入当前账号 SSO 登录态, 并把必修课程/专题排在队列最前
    await startAutopilot(s.rows);
  };

  const unlock = () => {
    const now = Date.now();
    taps = now - lastTapAt < 3000 ? taps + 1 : 1;
    lastTapAt = now;
    if (taps >= 5 && !getState().unlocked) {
      setState({ unlocked: true });
      toast('已开启完整功能', 'ok');
    }
  };

  // 必修完成度: 必修是合规底线, 堆叠条一眼看清还剩多少(替代无决策价值的「月度新增安排」)
  const reqRows = s.rows.filter((r) => r.required === '必修');
  const reqDone = reqRows.filter((r) => String(r.state).startsWith('已完成')).length;
  const reqDoing = reqRows.filter((r) => r.state === '学习中').length;
  const reqTodo = Math.max(0, reqRows.length - reqDone - reqDoing);
  const reqSeg = (n, cls, tip) => n > 0 ? el('i', { class: cls, style: { width: `${(n / reqRows.length) * 100}%` }, title: tip }) : '';

  // 年度对标: 学时要求按年计, 用学时进度 vs 年度时间进度直接回答「照此速度年底达不达得到标」
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEnd = new Date(year + 1, 0, 1).getTime();
  const yearPct = Math.round(Math.min(100, Math.max(0, ((Date.now() - yearStart) / (yearEnd - yearStart)) * 100)));

  const dash = '—';
  const loadingNode = () => s.loading ? dash : '';

  // 年度账单（主视觉）: 双轨分开核算 —— 网络自学 / 集中培训 各一行进度
  const classReq = Number(s.hours.requireClassHour || 0);
  const trainPct = barPercent(train, classReq);
  // bullet graph: 进度条上的刻度线 = 年度时间进度(target), 说明进 tooltip —— 句子改形状
  const trackRow = (label, val, target, p, done, tickPct = 0, tickTip = '') => el('div', { class: 'bill-track' },
    el('span', { class: 'bill-track-label', text: label }),
    target > 0 ? el('div', { class: 'bill-track-bar' },
      progress(p, done),
      tickPct > 0 && tickPct < 100 ? el('i', { class: 'bill-tick', style: { left: `${tickPct}%` }, title: tickTip }) : '',
    ) : '',
    el('span', { class: 'bill-track-val', text: target > 0 ? `${fmtNum(val, 1)} / ${fmtNum(target)} 学时` : `${fmtNum(val, 1)} 学时` }),
  );

  return el('div', { class: 'stack' },
    el('section', { class: 'card bill-card' },
      el('span', { class: 'bill-label', text: `${year} 年度 · 学时账单` }),
      el('div', { class: 'bill-num' },
        el('span', { class: 'big' }, s.loading ? dash : num(hs, 1, `home.bill.self:${activeKey}`)),
        req > 0 ? el('small', { text: `/ ${fmtNum(req)} 学时` }) : '',
      ),
      s.loading ? '' : el('div', { class: 'bill-tracks' },
        trackRow('网络自学', hs, req, pct, pct >= 100, yearPct, `年度时间进度 ${yearPct}%`),
        classReq > 0 ? trackRow('集中培训', train, classReq, trainPct, false) : '',
      ),
      req <= 0 ? el('p', { class: 'bill-note', text: '登录后生成你的账单' }) : '',
    ),

    el('section', { class: 'stat-grid' },
      statCard('待学任务', s.loading ? dash : num(undone.length, 0, `home.stat.undone:${activeKey}`), `其中已开始 ${s.rows.filter((r) => r.state === '学习中').length}`),
      statCard('今日已学', s.loading ? dash : num(todayTotal, 1, `home.stat.today:${activeKey}`), `额度 ${cap} 学时/天`, todayTotal >= cap ? 'amber' : 'brand', cap > 0 ? (todayTotal / cap) * 100 : 0),
      statCard('已完成', s.loading ? dash : num(done, 0, `home.stat.done:${activeKey}`), `共 ${s.rows.length} 项`),
    ),

    dueSoonBanner(s.rows),
    statsSection(s, todayTotal, heatmapSection(s.history)),

    el('section', { class: 'card card-pad' },
      el('div', { class: 'card-head' },
        el('h2', { text: '继续学习' }),
        // 必修进度在此由迷你条承载(say-it-once); hint 只在无必修(选修回退)时说明池子
        el('span', { class: 'hint', text: reqRows.length ? '' : cont.hint }),
        el('span', { class: 'right' }, el('a', { href: '#/tasks', onclick: (e) => { e.preventDefault(); go('tasks'); } }, '全部任务 →')),
      ),
      // 必修完成度迷你条: 「必修还剩多少」是「接下来学什么」的直接上下文, 不再单独立卡
      reqRows.length && !s.loading ? el('div', { class: 'cont-req' },
        el('div', { class: 'reqbar' },
          reqSeg(reqDone, 'done', `已完成 ${reqDone}`),
          reqSeg(reqDoing, 'doing', `已开始 ${reqDoing}`),
          reqSeg(reqTodo, 'todo', `未开始 ${reqTodo}`),
        ),
        el('span', { class: 'reqbar-note', text: `必修 ${reqDone} / ${reqRows.length} · 已开始 ${reqDoing}` }),
      ) : '',
      s.loading
        ? el('div', {}, skels(3))
        : cont.rows.length
          ? el('div', { class: 'sec-list' }, cont.rows.map((r) => taskRow(r, s.unlocked, !!s.busy)))
          : el('p', { style: { margin: 0, fontSize: '14px', color: 'var(--muted)' }, text: '必修任务已全部完成' }),
    ),

    el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '12px', color: 'var(--ink)', fontSize: '15px' }, text: '快捷操作' }),
      el('div', { class: 'divide' },
        s.unlocked && !STORE ? [
          quickRow('一键完成待学任务', `${undone.length} 项（必修 ${reqMust}）`, () => void runTodo()),
          quickRow('补齐学时差额', `差 ${fmtNum(Math.max(0, req - hs))} 学时`, () => runHours()),
        ] : '',
        quickRow('刷新数据', '重新读取任务与学时', () => void forceRefreshAll()),
        quickRow('打开课程库', '12 类内容检索', () => { setState({ tasksTab: 'library' }); go('tasks'); }),
        quickRow('无人值守看课', apStatus || '必修课程/专题优先 · 自动带入登录态 · 真实播放', () => void toggleAutopilot()),
        quickRow('打开学院官网', '用当前登录态免再次登录', () => void openPlatformLoggedIn()),
      ),
    ),

    !STORE ? el('section', { class: 'card card-pad' },
      el('h2', { style: { marginBottom: '12px', color: 'var(--ink)', fontSize: '15px' }, text: '最近运行' }),
      s.runs.length
        ? el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } }, s.runs.slice(0, 5).map((r) => runChip(r)))
        : el('p', { style: { margin: 0, fontSize: '14px', color: 'var(--muted)' }, text: '还没有运行记录' }),
    ) : '',

    s.error ? el('p', { class: 'err-box', text: s.error }) : '',

    el('footer', { class: 'page-foot' },
      el('span', { text: '数据仅存于本浏览器' }),
      !STORE ? el('span', { class: 'unlock-dot', text: ' · ', 'data-testid': 'unlock-dot', onclick: unlock }) : '',
      !STORE && s.unlocked ? el('span', { class: 'unlocked-note', text: '完整功能已开启' }) : '',
    ),
  );
}

function quickRow(label, hint, onClick) {
  return el('button', { class: 'quick-row', onclick: onClick },
    el('span', {}, label, el('span', { class: 'tail', text: hint })),
    el('span', { class: 'arrow', text: '→' }),
  );
}

function skels(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(el('div', { class: 'skel', style: { width: `${90 - i * 15}%` } }));
  return out;
}

/* ── 必修临近截止提醒 ──────────────────────────────────── */
function dueSoonBanner(rows, days = 7) {
  const list = dueSoon(rows, { days });
  if (!list.length) return '';
  const token = getCurrentToken();
  const box = el('section', { class: 'due-banner', 'data-testid': 'due-soon' },
    el('div', { class: 'due-head' },
      el('span', { class: 'due-mark', text: '!' }),
      el('h2', { text: '必修临近截止' }),
      el('span', { class: 'sub', text: `${days} 天内有 ${list.length} 项，尽快去学院完成` }),
    ),
  );
  const rowsBox = el('div', { class: 'divide-amber' });
  for (const r of list.slice(0, 5)) {
    rowsBox.append(el('div', { class: 'due-row' },
      el('span', { class: 'left', text: `剩 ${daysLeftText(r.endTime)}` }),
      el('a', { href: ssoCourseUrl(r, token), target: '_blank', rel: 'noopener noreferrer', title: '去学院平台学习', text: r.name }),
      el('span', { class: 'meta', text: `${r.type} · ${r.state}` }),
    ));
  }
  box.append(rowsBox);
  if (list.length > 5) box.append(el('p', { class: 'due-more', text: `还有 ${list.length - 5} 项…` }));
  return box;
}

/* ── 课程库发现（站内推荐已并入「继续学习」, 这里只保留任务外的新内容）── */
function libraryRecsSection(s) {
  if (!s.libraryRecs.length) return '';
  const token = getCurrentToken();
  const box = el('section', { class: 'card card-pad', 'data-testid': 'library-recs' },
    el('div', { class: 'card-head' },
      el('h2', { text: '课程库发现' }),
      el('span', { class: 'hint', text: '按你近期学的课程挑的, 不在你的任务里' }),
    ),
  );
  const rowsBox = el('div', { class: 'divide' });
  for (const r of s.libraryRecs) {
    rowsBox.append(el('div', { class: 'rec-row' },
      el('span', { class: 'rec-kind', text: r.kind }),
      el('a', { href: ssoCourseUrl({ id: r.id }, token), target: '_blank', rel: 'noopener noreferrer', text: r.name }),
      el('span', { style: { flexShrink: 0, fontSize: '12px', color: 'var(--muted)' }, text: r.courseHour ? `${r.courseHour} 学时` : '' }),
      s.unlocked && !STORE ? el('button', { class: 'rec-btn', disabled: !!s.busy, onclick: () => runCourse({ bid: r.id, name: r.name }) }, '学习') : '',
    ));
  }
  box.append(rowsBox);
  return box;
}

/* ── 学习统计 ──────────────────────────────────────────── */
function statsSection(s, todayTotal, extra = '') {
  const ak = s.accounts.find((a) => a.active)?.key || 'default';
  const sum = summarize(s.history, { todayHours: todayTotal });
  const tiles = [['今日', sum.today], ['本周', sum.week], ['本月', sum.month], ['今年', sum.year]];
  return el('section', { class: 'card card-pad', 'data-testid': 'study-stats' },
    el('div', { class: 'card-head' },
      el('h2', { text: '学习统计' }),
      el('span', { class: 'hint', text: '按每日学时累计（含今日实时值）' }),
    ),
    el('div', { class: 'stat-tiles' },
      tiles.map(([label, p]) => el('div', { class: 'stat-tile', 'data-testid': 'stat-tile' },
        el('span', { class: 'lbl', text: label }),
        el('div', { class: 'val' }, num(p.hours, 1), el('small', { text: '学时' })),
        el('p', { class: 'days', text: `${p.days} 天有学习` }),
      )),
    ),
    extra ? el('div', { style: { marginTop: '24px' } }, extra) : '',
  );
}

/* ── 学习热力图 ────────────────────────────────────────── */
const HM_COLORS = ['#EEF1EE', THEME.brandSoft, THEME.brandTint, THEME.brandMid, THEME.brand];
const LEVEL_TEXT = ['无学习', '少于半小时', '半小时~1 小时', '1~2 小时', '2 小时以上'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const DAY_LABELS = ['', '一', '', '三', '', '五', ''];

function calcWeeks() {
  const vw = Number(globalThis.innerWidth) || 1280;
  return Math.max(26, Math.min(53, Math.round((vw - 340) / 15)));
}
let hmWeeks = calcWeeks();
let hmResizeBound = false;

function heatmapSection(history) {
  if (!hmResizeBound) {
    // 窗口宽度变化 → 周数变化 → 下一次重渲染按新周数铺格子
    globalThis.addEventListener?.('resize', () => { hmWeeks = calcWeeks(); }, { passive: true });
    hmResizeBound = true;
  }
  const cols = heatmapCells(history, { weeks: hmWeeks });
  const cells = cols.flat().filter((c) => !c.future);
  const learned = cells.filter((c) => c.hours > 0);
  const total = learned.reduce((a, c) => a + c.hours, 0);
  const max = Math.max(1, ...cells.map((c) => c.hours));

  const monthMarks = [];
  let lastMonth = -1;
  cols.forEach((col, i) => {
    const m = Number(col[0].date.slice(5, 7));
    if (m !== lastMonth) { monthMarks.push({ idx: i, label: MONTHS[m - 1] }); lastMonth = m; }
  });

  const grid = el('div', {
    class: 'hm-grid', role: 'img',
    'aria-label': `最近 ${cols.length} 周学习热力图：共 ${total.toFixed(1)} 学时，${learned.length} 天有学习`,
    style: { gridTemplateColumns: `16px repeat(${cols.length}, minmax(0, 1fr))` },
  });
  for (const m of monthMarks.filter((m, i, arr) => i === 0 || m.idx - arr[i - 1].idx >= (hmWeeks > 30 ? 4 : 5))) {
    grid.append(el('span', { class: 'hm-month', text: m.label, style: { gridColumn: String(m.idx + 2), gridRow: '1' } }));
  }
  DAY_LABELS.forEach((d, i) => {
    if (!d) return;
    grid.append(el('span', { class: 'hm-day', text: d, style: { gridColumn: '1', gridRow: String(i + 2) } }));
  });
  cols.forEach((col, ci) => col.forEach((c, ri) => {
    grid.append(el('span', {
      class: 'hm-cell',
      title: `${c.date} · ${c.hours ? `${c.hours.toFixed(1)} 学时（${LEVEL_TEXT[c.level]}）` : '无学习'}`,
      style: {
        gridColumn: String(ci + 2), gridRow: String(ri + 2),
        background: c.future ? 'transparent' : HM_COLORS[c.level],
        opacity: c.future ? '0' : '1',
        animationDelay: `${Math.min(ci * 5, 260)}ms`,
      },
    }));
  }));

  const legend = el('div', { class: 'hm-legend' }, el('span', { text: '少' }));
  HM_COLORS.forEach((c, i) => legend.append(el('span', { class: 'sw', title: LEVEL_TEXT[i], style: { background: c } })));
  legend.append(el('span', { text: '多' }), el('span', { class: 'note', text: '每格一天，颜色越深学时越多' }));

  return el('div', { 'data-testid': 'heatmap' },
    el('div', { class: 'hm-head' },
      el('h2', { text: '学习热力图' }),
      el('span', { class: 'sub' }, `最近 ${hmWeeks} 周 · 共 `, num(total, 1), ` 学时 · ${learned.length} 天有学习 · 单日最高 ${max.toFixed(1)}`),
    ),
    grid,
    legend,
  );
}

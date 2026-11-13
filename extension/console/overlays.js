/** 浮层: 弹窗（原生 <dialog>）/ Toast / 小节抽屉 / 运行日志（popover 侧板）/ 权限门 / APP 下载 / 补学时。
 *  移植自 src/components/{ui(Toasts,ModalHost),Overlay,Drawer,LogOverlay,Activity,PlatformPermissionGate,AppDownload,HoursModal}.tsx */
import { getState, setState, toast, openModal, closeLog, openLog } from '../lib/store.js';
import { STORE } from '../lib/flags.js';
import {
  getCurrentToken, closeDrawer, drillSection, popDrawer, runCourse, submitHours,
} from '../lib/actions.js';
import { fmtDur, fmtNum, fmtTime, logClass, SEC_TYPE } from '../lib/core.js';
import { ssoCourseUrl } from '../lib/links.js';
import { DONE_FINISH } from '../lib/platform.js';
import { APP_LINKS, makeQr } from '../lib/appdownload.js';
import { el, icon, pill, button, buildStamp, runPill } from './ui.js';

/* ── Toasts（aria-live, 增量 keyed 更新, 不重放已有动画）────────────── */
let toastHost = null;
const shownToasts = new Map();

export function renderToasts(s) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const ids = new Set(s.toasts.map((t) => t.id));
  for (const [id, node] of shownToasts) {
    if (!ids.has(id)) { node.remove(); shownToasts.delete(id); }
  }
  for (const t of s.toasts) {
    if (shownToasts.has(t.id)) continue;
    const node = el('div', { class: `toast ${t.kind}`, text: t.message });
    toastHost.append(node);
    shownToasts.set(t.id, node);
  }
}

/* ── 弹窗（原生 dialog: showModal / Esc 走 cancel / 背景点击关闭）────── */
let dlg = null;
let curModal = null;
let modalClosing = false;

function requestModalClose() {
  if (!dlg || modalClosing) return;
  modalClosing = true;
  const node = dlg;   // 捕获本弹窗: 关闭窗口期内若换弹窗, 旧定时器不能再关到新弹窗
  dlg.classList.add('modal-closing');
  setTimeout(() => { try { node.close(); } catch { /* 已关闭 */ } }, 240);
}

function destroyModal() {
  if (!dlg) return;
  const node = dlg;
  dlg = null; curModal = null; modalClosing = false;
  try { node.close(); } catch { /* 已关闭 */ }
  node.remove();
}

export function renderModal(s) {
  const m = s.modal;
  if (!m) {
    if (dlg && dlg.open && !modalClosing) requestModalClose();
    return;
  }
  if (m === curModal) return;
  destroyModal();
  curModal = m;
  modalClosing = false;
  dlg = el('dialog', { class: 'modal-dlg' });
  // Esc 关闭走 cancel 事件（浏览器原生焦点管理, 不手写 keydown / 焦点陷阱）
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); requestModalClose(); });
  dlg.addEventListener('close', (e) => {
    // close 事件异步触发, 此刻模块级 dlg 可能已指向新弹窗 —— 只操作事件源本身,
    // 且仅当事件源仍是当前弹窗时才清 store, 避免换弹窗时误清新弹窗
    const node = e.target;
    node.remove();
    if (dlg === node && getState().modal) setState({ modal: null });
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) requestModalClose(); });

  dlg.append(el('h2', { text: m.title }));
  if (typeof m.body === 'function') {
    const body = m.body(() => requestModalClose());
    dlg.append(body instanceof Node ? body : el('div', { class: 'modal-body-text', text: String(body) }));
  } else if (m.body !== undefined) {
    dlg.append(el('p', { class: 'modal-body-text', text: String(m.body) }));
  }
  const actions = el('div', { class: 'modal-actions' });
  m.actions.forEach((a, i) => {
    const b = button(a.kind === 'primary' ? 'primary' : 'ghost', {}, a.label);
    if (i === 0) b.setAttribute('autofocus', '');   // 破坏性确认: 焦点落在安全的第一个按钮上
    b.addEventListener('click', () => (a.onClick ? a.onClick(() => requestModalClose()) : requestModalClose()));
    actions.append(b);
  });
  dlg.append(actions);
  document.body.append(dlg);
  dlg.showModal();
}

/* ── 侧板公共: popover="auto" 提供原生 Esc 关闭与轻消散（不手写监听）── */
function makePanel(id, wide) {
  const panel = el('div', { class: `side-panel anim-slide-in ${wide ? 'wide' : ''}`, popover: 'auto', id });
  // 流式渲染 replaceChildren 会整体换掉子树, 落在瞬时节点上的 onclick 随节点销毁而丢事件;
  // 在常驻 panel 上代理关闭点击, 保证 X / 关闭按钮在任意刷新时机都点得中
  panel.addEventListener('click', (e) => { if (e.target.closest('[data-panel-close]')) panel.hidePopover(); });
  // 隐藏开始(beforetoggle 同步触发)立即落库 —— close 事件被关闭过渡动画推迟,
  // 若等它落库, 窗口期内流式日志渲染会看到 logOpen=true 而面板已不在顶层, 误判"未打开"重新
  // showPopover 打断关闭动画, 表现为浮层永远关不掉。X/遮罩/Esc 所有关闭路径都经过这里。
  panel.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'closed') return;
    if (id === 'mooc-drawer' && getState().drawer) setState({ drawer: null });
    if (id === 'mooc-log' && getState().logOpen) closeLog();
  });
  document.body.append(panel);
  return panel;
}

/* ── 小节抽屉 ──────────────────────────────────────────── */
let drawerPanel = null;
let drawerSig = '';

export function renderDrawer(s) {
  // 登录浮层打开时抽屉不叠在上面（对齐 React 版卸载行为）; 关闭后随 store 恢复
  const d = s.drawer && !s.loginOpen ? s.drawer : null;
  const open = drawerPanel ? drawerPanel.matches(':popover-open') : false;
  if (!d) {
    if (open) drawerPanel.hidePopover();
    drawerSig = '';
    return;
  }
  const sig = JSON.stringify([d.name, d.bid, d.loading, d.err, d.sections, d.stack?.length, s.unlocked, s.busy]);
  if (!drawerPanel) drawerPanel = makePanel('mooc-drawer', false);
  if (!open) drawerPanel.showPopover();
  if (sig === drawerSig) return;
  drawerSig = sig;

  const token = getCurrentToken();
  const doneCount = (d.sections || []).filter((sec) => DONE_FINISH.has(sec.finish)).length;

  const body = el('div', { class: 'drawer-body' });
  if (d.stack.length > 0) body.append(el('button', { class: 'back-btn', text: '← 返回', onclick: () => popDrawer() }));
  if (d.loading) {
    for (let i = 0; i < 4; i++) body.append(el('div', { class: 'skel', style: { width: `${85 - i * 10}%` } }));
  } else if (d.err) {
    body.append(el('p', { class: 'err-box', text: `无法获取小节：${d.err}` }));
  } else {
    const list = el('div', { class: 'sec-list' });
    for (const sec of d.sections) {
      const nested = sec.type === 10;
      const done = DONE_FINISH.has(sec.finish);
      const row = el('div', { class: `sec-row ${nested ? 'nested' : ''}`, title: nested ? '查看该专题的小节' : undefined },
        el('div', { class: 'sec-info' },
          el('a', {
            href: ssoCourseUrl({ bid: d.bid }, token), target: '_blank', rel: 'noopener noreferrer',
            title: '去学院平台学习（在课程页找到这一节）', class: 'sec-name', text: sec.name,
            onclick: (e) => e.stopPropagation(),
          }),
          el('div', { class: 'sec-meta' },
            `${SEC_TYPE[sec.type] || sec.type} · ${done ? '已完成' : sec.finish === 1 ? `已开始 ${sec.rate ?? 0}%` : '未开始'}`,
            nested ? el('span', { class: 'more', text: '›' }) : '',
          ),
        ),
        el('span', { class: `sec-state ${done ? 'ok' : ''}`, text: done ? '已完成' : sec.finish === 1 ? '已开始' : '未开始' }),
        nested ? '' : el('span', { class: 'sec-type', text: SEC_TYPE[sec.type] || '' }),
      );
      if (nested) {
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.addEventListener('click', () => void drillSection(sec));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void drillSection(sec); }
        });
      }
      list.append(row);
    }
    body.append(list);
  }

  const foot = el('div', { class: 'drawer-foot' },
    s.unlocked && !STORE ? button('primary', {
      disabled: !!s.busy || d.loading,
      onclick: () => runCourse({ bid: d.bid, name: d.name }),
    }, s.busy ? '有任务在运行中' : '开始学习这门课') : '',
    button('ghost', { 'data-panel-close': '' }, '关闭'),
  );

  drawerPanel.replaceChildren(
    el('div', { class: 'drawer-head' },
      el('div', { class: 'info' },
        el('h2', {}, el('a', {
          href: ssoCourseUrl({ bid: d.bid }, token), target: '_blank', rel: 'noopener noreferrer',
          title: '在学院平台打开', text: d.name,
        })),
        el('p', { text: d.loading ? '加载中…' : `${doneCount}/${d.sections.length} 小节已完成` }),
      ),
      el('button', { class: 'x-btn', 'data-panel-close': '', 'aria-label': '关闭小节列表' }, icon('x', 'ic16')),
    ),
    body,
    foot,
  );
}

/* ── 运行记录 + 日志（内嵌正文, 日志浮层与页面共用）──────────────── */
let logClearArmed = 0;

export function activityBody({ compact = false, logs: logsProp, runId } = {}) {
  const s = getState();
  const src = logsProp ?? s.logs;
  const lines = s.onlyErrors ? src.filter((l) => /FAIL|错误|异常|配额/.test(l.text)) : src;
  const runs = s.runs;

  const runsCard = el('section', { class: 'runs-card' },
    el('div', { class: 'runs-head' },
      el('h2', { text: '运行记录' }),
      el('span', { class: 'count', text: `共 ${runs.length} 次` }),
      el('span', { class: 'right' }, s.busy
        ? el('span', { class: 'free-pill busy' }, el('span', { class: 'dot' }), s.busy)
        : el('span', { class: 'free-pill idle', text: '空闲' })),
    ),
  );
  if (runs.length) {
    const table = el('table', { class: 'runs-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: '开始时间' }), el('th', { class: 'hide-sm', text: '账号' }), el('th', { text: '操作' }),
        el('th', { text: '结果' }), el('th', { class: 'hide-sm', text: '耗时' })),
      ),
    );
    const tbody = el('tbody');
    for (const r of runs) {
      const tr = el('tr', { tabindex: 0, title: '查看该次运行的日志（回车打开）' },
        el('td', { text: fmtTime(r.startedAt) }),
        el('td', { class: 'hide-sm', text: r.account || '—' }),
        el('td', { class: 'label', text: r.label }),
        el('td', {}, runPill(r)),
        el('td', { class: 'hide-sm', text: r.status === 'running' || r.interrupted || !r.endedAt ? '—' : fmtDur(r.endedAt - r.startedAt) }),
      );
      tr.addEventListener('click', () => openLog(r.id));
      tr.addEventListener('keydown', (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLog(r.id); }
      });
      tbody.append(tr);
    }
    table.append(tbody);
    // 浮层内高度固定: 运行记录多了内滚, 不把整卡(和日志区)无限撑高
    runsCard.append(el('div', { style: { overflowX: 'auto', maxHeight: '240px', overflowY: 'auto' } }, table));
  } else {
    runsCard.append(el('p', { style: { fontSize: '14px', color: 'var(--muted)' }, text: '还没有运行记录 —— 到任务页点「开始学习」，或在概览点「一键完成待学任务」。' }));
  }

  const box = el('div', { class: 'log-box' });
  lines.forEach((l, i) => {
    const cls = logClass(l.text);
    box.append(el('div', { class: 'log-line' },
      el('span', { class: 'no', text: String(i + 1).padStart(3, ' ') }),
      el('span', {
        class: cls === 'l-ok' ? 't-ok' : cls === 'l-err' ? 't-err' : cls === 'l-warn' ? 't-warn' : cls === 'l-tag' ? 't-tag' : 't-default',
        text: l.text,
      }),
    ));
  });
  if (!lines.length) {
    box.append(el('p', { class: 'log-empty', text: runId
      ? '这次运行没有留存日志 —— 实时日志只保留在当前控制台会话里；历史运行只保留值守的关键节点。'
      : s.onlyErrors && src.length
        ? `暂无错误日志（共 ${src.length} 行，均非错误）。`
        : '暂无日志 —— 开始学习或开启值守后，这里会实时滚动。' }));
  }

  const onlyErrors = el('input', { type: 'checkbox' });
  onlyErrors.checked = s.onlyErrors;
  onlyErrors.addEventListener('change', () => setState({ onlyErrors: onlyErrors.checked }));
  const autoScroll = el('input', { type: 'checkbox' });
  autoScroll.checked = s.autoScroll;
  autoScroll.addEventListener('change', () => setState({ autoScroll: autoScroll.checked }));

  // 清屏两段式: 点一次变「确认清屏」, 3 秒内再点才清 —— 实时日志缓冲不可恢复, 防误触;
  // 不用弹窗(低风险任务不值得打断)。arm 状态放模块级, 流式重渲染后按钮文字不丢
  const clearBtn = el('button', { class: `log-clear${logClearArmed ? ' armed' : ''}`, title: '清屏', 'aria-label': '清屏日志' });
  if (logClearArmed) clearBtn.textContent = '确认清屏';
  else clearBtn.append(icon('x', 'ic14'));
  clearBtn.addEventListener('click', () => {
    if (logClearArmed && Date.now() - logClearArmed < 3000) {
      logClearArmed = 0;
      setState({ logs: [] });
      return;
    }
    logClearArmed = Date.now();
    clearBtn.classList.add('armed');
    clearBtn.textContent = '确认清屏';
    setTimeout(() => {
      if (logClearArmed && Date.now() - logClearArmed >= 2900) {
        logClearArmed = 0;
        clearBtn.classList.remove('armed');
        clearBtn.replaceChildren(icon('x', 'ic14'));
      }
    }, 3000);
  });

  const root = el('div', { class: `activity ${compact ? 'compact' : ''}` },
    runsCard,
    el('section', { class: 'log-card' },
      el('div', { class: 'log-controls' },
        el('h2', { text: '运行日志' }),
        el('label', {}, onlyErrors, '只看错误'),
        el('label', {}, autoScroll, '自动滚动'),
        clearBtn,
      ),
      box,
    ),
  );
  // 自动滚动: 内容变化后跟到底（与 React 版 effect 行为一致）
  if (s.autoScroll) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  return root;
}

/* ── 运行日志浮层 ──────────────────────────────────────── */
let logPanel = null;
let logSig = '';

export function renderLogOverlay(s) {
  const logOpen = s.logOpen && !s.loginOpen;
  const open = logPanel ? logPanel.matches(':popover-open') : false;
  if (!logOpen) {
    if (open) logPanel.hidePopover();
    logSig = '';
    return;
  }
  const filtered = s.logRun ? s.logs.filter((l) => l.runId === s.logRun) : s.logs;
  const runLabel = s.logRun ? (s.runs.find((r) => r.id === s.logRun)?.label ?? '') : '';
  const sig = JSON.stringify([s.logRun, runLabel, s.busy, s.runs, filtered.map((l) => l.seq), s.onlyErrors, s.autoScroll]);
  if (!logPanel) logPanel = makePanel('mooc-log', true);
  // logOpen 与面板可见性已由 beforetoggle 同步落库保持一致, 这里 logOpen=true 且未打开
  // 只可能是"刚被要求打开还没弹", 直接弹即可; 关闭窗口期 logOpen 已为 false 走上面的分支
  if (!open) logPanel.showPopover();
  if (sig === logSig) return;
  logSig = sig;

  const busyPill = s.busy
    ? el('span', { class: 'free-pill busy' }, el('span', { class: 'dot' }), s.busy)
    : el('span', { class: 'free-pill idle', text: '空闲' });

  logPanel.replaceChildren(
    el('div', { class: 'log-head' },
      el('h2', {}, '运行日志 ', el('span', { class: 'build', text: `build ${buildStamp()}` })),
      busyPill,
      el('button', { class: 'x-btn', 'data-panel-close': '', 'aria-label': '关闭运行日志' }, icon('x', 'ic16')),
    ),
    el('div', { class: 'log-filter-row' },
      s.logRun ? el('div', { class: 'run-filter' },
        el('span', { text: `仅显示：${runLabel || s.logRun}` }),
        el('button', { text: '显示全部日志', onclick: () => setState({ logRun: undefined }) }),
      ) : '',
      activityBody({ compact: true, logs: filtered, runId: s.logRun }),
    ),
  );
}

/* ── 平台权限门（自填充; block 模式下未授权不渲染 children）────────── */
export function platformGate({ block = false, children = null } = {}) {
  const host = el('span', {});
  let granted = null;   // null = 检查中
  let asked = null;
  let error = '';
  const storage = () => globalThis.chrome?.storage?.local;
  const perm = () => globalThis.chrome?.permissions;

  const render = () => {
    if (granted === null) { host.replaceChildren(block ? el('p', { style: { fontSize: '14px', color: 'var(--muted)' }, text: '正在检查平台访问权限…' }) : ''); return; }
    if (granted === true) {
      if (block && children) host.replaceChildren(children);
      else host.replaceChildren();
      return;
    }
    const note = el('div', { class: 'perm-note' },
      el('p', { text: '扩展需要访问学习平台（mooc.ctt.cn）才能读取你的学习进度。点击下方按钮授权，授权后即可正常使用。' }),
    );
    if (asked === false) {
      note.append(button('default', { onclick: request }, '授权访问学习平台'));
    } else {
      const retry = el('button', { class: 'retry', text: '已询问过授权 —— 点此重新尝试' });
      retry.addEventListener('click', request);
      note.append(retry);
    }
    if (error) note.append(el('p', { class: 'perr', text: error }));
    host.replaceChildren(note);
  };

  async function request() {
    const p = perm();
    try { await storage()?.set({ 'mooc.permAsked': true }); } catch { /* 忽略 */ }
    asked = true;
    if (!p?.request) { error = '当前环境不支持权限请求'; render(); return; }
    const ok = await new Promise((res) => p.request({ origins: ['https://mooc.ctt.cn/*'] }, res));
    if (ok) { granted = true; error = ''; }
    else error = '未授权 — 扩展无法与平台通信，点击「重新授权」可再试';
    render();
  }

  (async () => {
    const p = perm();
    if (!p?.contains) { granted = true; asked = false; render(); return; }
    try {
      granted = await new Promise((res) => p.contains({ origins: ['https://mooc.ctt.cn/*'] }, res));
    } catch { granted = false; }
    try {
      const v = await storage()?.get?.('mooc.permAsked');
      asked = !!v?.['mooc.permAsked'];
    } catch { asked = false; }
    render();
  })();
  render();
  return host;
}

/* ── APP 下载弹窗正文（二维码逻辑在 lib/appdownload.js, 不复制）────── */
function qrBlock(title, sub, text) {
  const img = el('img', { src: makeQr(text), alt: `${title} 下载二维码`, width: 160, height: 160 });
  return el('div', { class: 'dl-block' }, img, el('strong', { text: title }), el('span', { text: sub }));
}

export function appDownloadBody(close) {
  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    el('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--ink2)' }, text: '手机扫码安装「烟草网络学院」APP，扫一扫登录更方便。' }),
    el('div', { class: 'dl-grid' },
      qrBlock('Android', 'APK 直接下载', APP_LINKS.android),
      qrBlock('鸿蒙 / 华为', '华为应用市场', APP_LINKS.harmony),
    ),
    el('p', { class: 'dl-note' }, '其他机型或想先看安装说明：',
      el('a', { href: APP_LINKS.guide, target: '_blank', rel: 'noopener noreferrer' }, '官方下载引导页')),
    el('div', { class: 'dl-foot' }, button('ghost', { onclick: close }, '关闭')),
  );
}

export function openDownload() {
  openModal({
    title: '下载烟草网络学院 APP',
    body: (close) => appDownloadBody(close),
    actions: [],
  });
}

/* ── 补齐学时弹窗 ──────────────────────────────────────── */
export function runHours() {
  const hours = getState().hours;
  const diff = Math.max(0, Number(hours.requireCourseHour || 0) - Number(hours.hourSelf || 0));
  openModal({
    title: '补齐网络自学学时',
    body: (close) => {
      const s = getState();
      let busy = false;
      const input = el('input', { type: 'text', value: 'auto' });
      const startBtn = button('primary', { text: '开始' });
      const root = el('div', {},
        el('p', { class: 'hours-modal-line', text: `当前 ${fmtNum(s.hours.hourSelf || 0)} / ${fmtNum(s.hours.requireCourseHour || 0)} 学时，差 ${fmtNum(diff)} 学时。` }),
        el('div', { class: 'hours-modal-field' },
          el('span', { class: 'cap', text: '目标（auto = 补齐到要求线）' }),
          input,
        ),
        el('div', { class: 'modal-actions' },
          button('ghost', { onclick: close }, '取消'),
          startBtn,
        ),
      );
      startBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        startBtn.disabled = true;
        // startRun 成功时已 toast「已启动：补齐学时 ××」, 不重复报更模糊的「已提交」
        try {
          await submitHours(input.value.trim() || 'auto');
          close();
        } finally {
          busy = false;
          startBtn.disabled = false;   // submitHours 抛错时允许重试, 不留死按钮
        }
      });
      return root;
    },
    actions: [],
  });
}

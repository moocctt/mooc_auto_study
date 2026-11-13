/**
 * 通用小件: DOM 助手 / 图标 / 徽章 / 统计卡 / 进度条 / 分页 / 读数动画 / 运行状态。
 * 移植自 ext 分支 src/components/ui.tsx（Tailwind 工具类 → 语义类名）。
 * 平台数据一律 textContent 注入；html 属性只允许传本文件内的常量（图标 path）。
 */
import { PAGE_SIZE, fmtDur, fmtTime } from '../lib/core.js';
import { openLog } from '../lib/store.js';

/** 构建元素: children 里的字符串按文本节点处理（默认转义），元素/节点原样插入 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;               // 仅限可信常量（图标/装饰 SVG）
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === true || c === '') continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/* 图标: 与 ui.tsx ICONS 同一套 path（可信常量） */
const ICON_PATHS = {
  bar: '<path d="M6 20V10M12 20V4M18 20v-6"/>',
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  refresh: '<path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  'chevron-left': '<path d="M15 18l-6-6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
};

export function icon(name, className = 'w-4 h-4') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

/** SVG 元素（SVG 命名空间; html 只允许传本模块内/本文件内的可信常量路径） */
export function svg(attrs = {}, inner = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.innerHTML = inner;
  return node;
}

/** 构建号（manifest version），替代 WXT 编译期注入的 __BUILD__ */
export function buildStamp() {
  try { return chrome.runtime.getManifest().version; } catch { return 'dev'; }
}

/* 读数动画: 自定义元素, 首屏从 0 涨到目标值, 之后从上次值续涨; 只改文本。
 * 数据分波到达时 UI 会重建 DOM, 新挂载的元素必须按 data-key 续上上次的值,
 * 否则同一个数字会从 0 重新涨一遍 —— 概览「学时账单」刷新抖动即此因。
 * data-key 语义: 同一个展示槽位（如「当前账号的网络自学学时」）。 */
class XNum extends HTMLElement {
  static get observedAttributes() { return ['value', 'dec']; }
  static _last = new Map();
  _key() { return this.getAttribute('data-key') || ''; }
  _remember(target) { const k = this._key(); if (k) XNum._last.set(k, target); }
  connectedCallback() {
    const k = this._key();
    this._from = k && XNum._last.has(k) ? XNum._last.get(k) : 0;
    this._raf = 0;
    this._run();
  }
  disconnectedCallback() { if (this._raf) cancelAnimationFrame(this._raf); }
  attributeChangedCallback() { if (this.isConnected) this._run(); }
  _run() {
    const reduce = (() => { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; } })();
    const dec = Number(this.getAttribute('dec') || 0);
    // 学时类数据在加载中可能出现瞬时负值（平台扣减）, 读数按 0 兜底
    const target = Math.max(0, Number.isFinite(Number(this.getAttribute('value'))) ? Number(this.getAttribute('value')) : 0);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (reduce || this._from === target) { this._from = target; this._remember(target); this.textContent = target.toFixed(dec); return; }
    const from = this._from;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 320);
      const eased = 1 - Math.pow(1 - p, 3);
      this.textContent = Math.max(0, from + (target - from) * eased).toFixed(dec);
      if (p < 1) this._raf = requestAnimationFrame(step);
      else { this._from = target; this._raf = 0; this._remember(target); }
    };
    this._raf = requestAnimationFrame(step);
  }
}
if (!customElements.get('x-num')) customElements.define('x-num', XNum);

export function num(value, decimals = 0, key = '') {
  const e = document.createElement('x-num');
  e.setAttribute('value', String(value));
  if (decimals) e.setAttribute('dec', String(decimals));
  if (key) e.setAttribute('data-key', String(key));
  return e;
}

const PILL_KIND = { ok: 'pill-ok', err: 'pill-err', warn: 'pill-warn', info: 'pill-info' };
export function pill(kind = '', className = '', ...children) {
  return el('span', { class: `pill ${PILL_KIND[kind] || ''} ${className || ''}`.trim() }, ...children);
}

export function statCard(label, value, hint, accent, goalPct = 0) {
  const card = el('article', { class: `stat ${accent === 'amber' ? 'amber' : accent === 'danger' ? 'danger' : ''}` },
    el('span', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value' }, value),
  );
  if (hint) card.append(el('p', { class: 'stat-hint', text: hint }));
  // goal beside the number: 目标细条, 度量「今日已学 vs 额度」这类自带目标的度量
  if (goalPct > 0) {
    const goal = el('div', { class: 'stat-goal', title: `目标进度 ${Math.min(100, Math.round(goalPct))}%` }, el('i'));
    setTimeout(() => { goal.firstChild.style.width = `${Math.max(2, Math.min(100, goalPct))}%`; }, 30);
    card.append(goal);
  }
  return card;
}

/** 进度条: 插入下一帧再设宽度, 让过渡可见（对齐 React 版 setTimeout(30) 语义） */
export function progress(pct, done) {
  const bar = el('div', { class: `progress ${done ? 'done' : ''}` }, el('i'));
  setTimeout(() => { bar.firstChild.style.width = `${Math.max(0, Math.min(100, pct))}%`; }, 30);
  return bar;
}

/** 分页条: 共 N 条 · 第 X/Y 页 · 页码（带省略号） · 输入页码跳转 */
export function pagination({ page, totalPages, total, onPage, unit = '条', pageSize = PAGE_SIZE }) {
  if (totalPages <= 0) return null;
  const lastCount = total - (totalPages - 1) * pageSize;
  const jump = el('input', {
    type: 'text', inputmode: 'numeric', placeholder: String(page),
    'aria-label': `跳转到页码，共 ${totalPages} 页`, title: '输入页码后回车或点跳转',
    class: 'pager-jump-input',
  });
  jump.addEventListener('input', () => { jump.value = jump.value.replace(/\D/g, '').slice(0, 4); });
  const doJump = () => {
    const n = Number(jump.value);
    jump.value = '';
    if (!Number.isFinite(n) || n < 1) return;
    const p = Math.min(Math.max(1, Math.round(n)), totalPages);
    if (p !== page) onPage(p);
  };
  jump.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) doJump();   // IME 确认候选词的 Enter 不触发跳转
    else if (e.key === 'Escape') jump.value = '';
  });
  const wrap = el('div', { class: 'pager' },
    el('span', { text: `共 ${total} ${unit} · 每页 ${pageSize} ${unit} · 第 ${page} / ${totalPages} 页${lastCount > 0 && lastCount < pageSize ? ` · 末页 ${lastCount} ${unit}` : ''}` }),
    el('div', { class: 'pager-btns' },
      el('button', { class: 'pager-btn', text: '上一页', disabled: page <= 1, onclick: () => onPage(page - 1) }),
      ...pageButtons(page, totalPages, onPage),
      el('button', { class: 'pager-btn', text: '下一页', disabled: page >= totalPages, onclick: () => onPage(page + 1) }),
      el('div', { class: 'pager-jump' }, jump, el('button', { class: 'pager-btn', text: '跳转', onclick: doJump })),
    ),
  );
  return wrap;
}

function pageButtons(page, totalPages, onPage) {
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter((p) => Math.abs(p - page) <= 2 || p === 1 || p === totalPages);
  const out = [];
  pages.forEach((p, idx) => {
    if (idx > 0 && pages[idx - 1] !== p - 1) out.push(el('span', { class: 'pager-gap', text: '…' }));
    out.push(el('button', {
      class: 'pager-num', text: String(p), 'aria-label': `第 ${p} 页`,
      'aria-current': p === page ? 'page' : undefined, onclick: () => onPage(p),
    }));
  });
  return out;
}

export function button(kind = 'default', attrs = {}, ...children) {
  const cls = {
    primary: 'btn-primary', danger: 'btn-danger', ghost: 'btn-ghost btn', default: 'btn',
  }[kind] || 'btn';
  return el('button', { ...attrs, class: `${cls} ${attrs.class || ''}`.trim() }, ...children);
}

/* 运行记录状态: 中断（控制台被关/浏览器被杀）与「用户主动停止」不是一回事, 分开显示 */
export function runStatus(r) {
  if (r.interrupted) return 'interrupted';
  if (r.status) return r.status;
  if (r.endedAt === undefined) return 'running';
  return r.ok ? 'done' : 'failed';
}

export const RUN_TEXT = { running: '运行中', done: '完成', failed: '失败', stopped: '停止', interrupted: '中断' };
export const RUN_PILL = { running: 'warn', done: 'ok', failed: 'err', stopped: 'warn', interrupted: 'warn' };

export function runPill(r) {
  const st = runStatus(r);
  return pill(RUN_PILL[st], '', st === 'running' ? el('span', { class: 'dot' }) : '', RUN_TEXT[st]);
}

export function runChip(r) {
  const st = runStatus(r);
  const dotColor = st === 'running' ? 'var(--amber)' : st === 'done' ? 'var(--brand)' : 'var(--danger)';
  const chip = el('button', {
    type: 'button', class: 'run-chip', title: `查看该次运行的日志 · ${fmtTime(r.startedAt)} · ${r.label}`,
    onclick: () => openLog(r.id),
  },
    el('span', { class: 'cdot', style: { background: dotColor, animation: st === 'running' ? 'pop 1.4s var(--ease-out) infinite alternate' : '' } }),
    el('span', { class: 'lbl', text: r.label.length > 18 ? `${r.label.slice(0, 18)}…` : r.label }),
    el('span', { class: 'st', text: st === 'running' ? RUN_TEXT[st] : `${RUN_TEXT[st]} · ${fmtDur((r.endedAt || 0) - r.startedAt)}` }),
  );
  return chip;
}

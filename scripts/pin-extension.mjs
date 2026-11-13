#!/usr/bin/env node
/**
 * 把扩展图标固定到工具栏。
 *
 * 为什么不用「直接改 profile 的 Preferences」: `extensions.pinned_extensions` 会在浏览器
 * 启动时被 Chrome 自己重算/清理（实测写入后重启即被丢弃, key 整个消失）。唯一可靠的路径是走
 * Chrome 自己的 UI: `chrome://extensions/?id=<id>` 详情页里的 `extensions-toggle-row#pin-to-toolbar`
 * 开关 —— 它写入的是同一份偏好, 但走的是 Chrome 的代码路径, 重启后保留。
 *
 * 用法:
 *   node scripts/pin-extension.mjs           # 需要就点（幂等）, 结束后回读校验
 *   node scripts/pin-extension.mjs --check   # 只读（未固定 → 退出码 1）
 *   node scripts/pin-extension.mjs --keep-tab
 *
 * 依赖 dev 已启动（CDP 9223, 可用 CDP_URL 覆盖）。
 */
import WebSocket from 'ws';
import { readExpectedId } from './lib/extension-id.mjs';

const CDP = (process.env.CDP_URL || 'http://127.0.0.1:9223').replace(/\/$/, '');
const CHECK_ONLY = process.argv.includes('--check');
const KEEP_TAB = process.argv.includes('--keep-tab');
const log = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };

const extensionId = readExpectedId();
if (!extensionId) die('读不到扩展 ID（先 npm run dev 生成 .output/chrome-mv3-dev/manifest.json）');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const evaluate = async (expression) => {
    await ready;
    return new Promise((res) => {
      const id = ++seq;
      pending.set(id, (m) => res(
        m.result?.exceptionDetails
          ? { error: m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text }
          : m.result?.result?.value,
      ));
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      }));
    });
  };
  return { ws, evaluate };
}

/** 详情页里读/点「固定到工具栏」；返回 { found, pinned, clicked } */
const toggleScript = (id, action) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(120); }
    return null;
  };
  const manager = document.querySelector('extensions-manager');
  const sr = manager && manager.shadowRoot;
  if (!sr) return { error: 'no-manager' };

  const detail = await waitFor(() => sr.querySelector('extensions-detail-view'));
  if (!detail) return { error: 'no-detail-view' };
  const row = await waitFor(() => detail.shadowRoot.querySelector('#pin-to-toolbar'));
  if (!row) return { error: 'no-pin-row' };

  const out = { found: true, pinned: !!row.checked, clicked: false };
  if (!out.pinned && ${action === 'fix'}) {
    const toggle = row.shadowRoot && row.shadowRoot.querySelector('#crToggle');
    (toggle || row).click();
    await sleep(900);
    out.pinned = !!row.checked;
    out.clicked = true;
  }
  return out;
})()`;

const main = async () => {
  const url = `chrome://extensions/?id=${extensionId}`;
  const res = await fetch(`${CDP}/json/list`).catch(() => null);
  if (!res?.ok) die(`连不上 CDP：${CDP}（先 npm run dev）`);
  const targets = await res.json();

  let target = targets.find((t) => t.type === 'page' && t.url.startsWith('chrome://extensions'));
  let created = false;
  if (!target) {
    const made = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => null);
    if (!made?.ok) die('打不开 chrome://extensions（CDP /json/new 失败）');
    target = await made.json();
    created = true;
    await sleep(1800);
  }

  const { ws, evaluate } = connect(target.webSocketDebuggerUrl);
  let state = await evaluate(toggleScript(extensionId, CHECK_ONLY ? 'read' : 'fix'));

  // 页面停在列表页（不是详情页）时: 导航到详情 URL 再来一次
  if (state?.error === 'no-detail-view') {
    await evaluate(`location.href = ${JSON.stringify(url)}; 'nav'`);
    await sleep(2000);
    state = await evaluate(toggleScript(extensionId, CHECK_ONLY ? 'read' : 'fix'));
  }
  // 修完回读, 以回读为准
  if (!CHECK_ONLY && state?.found && !state.pinned) state = await evaluate(toggleScript(extensionId, 'read'));
  ws.close();
  if (created && !KEEP_TAB) await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});

  if (!state || state.error) die(`读不到固定开关：${JSON.stringify(state)}（扩展可能被停用, 先 npm run extension:ensure）`);
  if (!state.pinned) {
    die(`图标未固定在工具栏${CHECK_ONLY ? '（去掉 --check 可自动固定）' : '（点击后仍未生效, 检查扩展是否被停用）'}`);
  }
  log(`✓ 图标已固定在工具栏（${extensionId}）${CHECK_ONLY ? ' [只读检查]' : ''}`);
};

main().catch((e) => die(e?.message || String(e)));

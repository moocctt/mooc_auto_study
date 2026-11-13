#!/usr/bin/env node
/**
 * 让「开发者模式 + 扩展已启用」自动到位 —— 不用再人工去 chrome://extensions 点开关。
 *
 * 为什么需要: `wxt dev` 起的 Chrome 里, 未打包扩展会在这两种情况下被停用（页面报
 * ERR_BLOCKED_BY_CLIENT, 控制台打不开、CDP 探针全挂）:
 *   1. 浏览器重启后开发者模式被关掉（profile 里的偏好被重置/换了 profile 目录）
 *   2. manifest 新增权限（例如这次加 alarms）→ Chrome 把扩展停用, 等用户重新启用
 * 这两步都只是 chrome://extensions 里的一个开关, 完全可以自动化。
 *
 * 用法:
 *   node scripts/ensure-extension.mjs            # 需要就修, 修完回读校验
 *   node scripts/ensure-extension.mjs --check    # 只读检查（CI/自检用, 不点任何按钮）
 *   node scripts/ensure-extension.mjs --keep-tab # 修完保留 extensions 标签页（默认关掉自己开的）
 *
 * 依赖 dev 已启动（CDP 端口 9223, 可用 CDP_URL 覆盖）。
 */
import WebSocket from 'ws';
import { readExpectedId } from './lib/extension-id.mjs';

const CDP = (process.env.CDP_URL || 'http://127.0.0.1:9223').replace(/\/$/, '');
const CHECK_ONLY = process.argv.includes('--check');
const KEEP_TAB = process.argv.includes('--keep-tab');
const WAIT_UI = Number(process.env.ENSURE_WAIT_MS || 2500);

const log = (...a) => console.log(...a);
const fail = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };

/* ── CDP 小工具 ───────────────────────────────────────────── */
async function listTargets() {
  const res = await fetch(`${CDP}/json/list`).catch(() => null);
  if (!res?.ok) fail(`连不上 CDP：${CDP}（先 npm run dev）`);
  return res.json();
}

async function openExtensionsPage() {
  const existing = (await listTargets()).find((t) => t.type === 'page' && t.url.startsWith('chrome://extensions'));
  if (existing) return { target: existing, created: false };
  const res = await fetch(`${CDP}/json/new?chrome%3A%2F%2Fextensions%2F`, { method: 'PUT' }).catch(() => null);
  if (!res?.ok) fail('打不开 chrome://extensions（CDP /json/new 失败）');
  const target = await res.json();
  // chrome:// 页面加载 + shadow DOM 挂载需要一点时间
  await new Promise((r) => setTimeout(r, WAIT_UI));
  return { target, created: true };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ready = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
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
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      }));
    });
  };
  return { ws, evaluate };
}

/**
 * 读 chrome://extensions 的状态。全部走 shadow DOM。
 * action: 'read' | 'fix'（fix 会点开发者模式与启用开关）
 */
const probeScript = (expectedId, action) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (root, sel) => (root ? root.querySelector(sel) : null);

  const manager = q(document, 'extensions-manager');
  const sr = manager && manager.shadowRoot;
  if (!sr) return { error: 'no-manager' };

  const toolbar = q(sr, 'extensions-toolbar');
  const devToggle = q(toolbar && toolbar.shadowRoot, '#devMode');
  const out = { devMode: null, devModeOff: null, items: [], expectedId: ${JSON.stringify(expectedId)} };

  if (!devToggle) return { ...out, error: 'no-devmode-toggle' };
  out.devMode = !!devToggle.checked;

  // 开发者模式关着 → 打不开「加载已解压的扩展」, 未打包扩展也会被停用
  if (!out.devMode && ${action === 'fix'}) {
    devToggle.click();
    await sleep(1200);
    out.devModeOff = !devToggle.checked;
    out.devMode = !!devToggle.checked;
  }

  const list = q(sr, 'extensions-item-list');
  const items = list && list.shadowRoot ? [...list.shadowRoot.querySelectorAll('extensions-item')] : [];
  for (const item of items) {
    const isr = item.shadowRoot;
    const toggle = q(isr, '#enableToggle');
    const name = (q(isr, '#name') || {}).textContent || '';
    const id = item.getAttribute('id') || '';
    const row = { id, name: name.trim(), enabled: toggle ? !!toggle.checked : null, clicked: false };
    if (toggle && !toggle.checked && ${action === 'fix'} && ${JSON.stringify(expectedId)} && id === ${JSON.stringify(expectedId)}) {
      toggle.click();
      row.clicked = true;
      await sleep(1500);
      row.enabled = !!toggle.checked;
    }
    out.items.push(row);
  }
  return out;
})()`;

const main = async () => {
  const expectedId = readExpectedId();
  const { target, created } = await openExtensionsPage();
  const { ws, evaluate } = connect(target.webSocketDebuggerUrl);

  const state = await evaluate(probeScript(expectedId, CHECK_ONLY ? 'read' : 'fix'));
  // 修完再读一次, 以回读结果为准（点了按钮不等于生效）
  const after = CHECK_ONLY || state?.error ? state : await evaluate(probeScript(expectedId, 'read'));
  ws.close();
  if (created && !KEEP_TAB) {
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
  }

  if (!after || after.error) fail(`读不到扩展管理页状态：${JSON.stringify(after)}`);

  const mine = expectedId ? after.items.find((i) => i.id === expectedId) : after.items[0];
  const rows = after.items.map((i) => `${i.enabled ? '已启用' : '已停用'} ${i.name}（${i.id}）`);

  if (!after.devMode) {
    fail(`开发者模式未开启${CHECK_ONLY ? '（去掉 --check 可自动开启）' : '，且自动点击未生效'}\n  当前扩展: ${rows.join(' / ') || '(无)'}`);
  }
  if (!mine) {
    fail(`扩展未出现在列表里（id=${expectedId || '未知'}）—— 多半是构建失败/扩展加载失败，先看 .tmp-wxtdev.log\n  现有: ${rows.join(' / ') || '(无)'}`);
  }
  if (mine.enabled !== true) {
    fail(`扩展仍处于停用状态${CHECK_ONLY ? '（去掉 --check 可自动启用）' : '（点击后仍未启用，Chrome 可能弹了权限确认，需要人工点一次）'}`);
  }

  log(`✓ 开发者模式已开启，扩展已启用: ${mine.name}（${mine.id}）${CHECK_ONLY ? ' [只读检查]' : ''}`);
};

main().catch((e) => fail(e?.message || String(e)));

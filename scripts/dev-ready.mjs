#!/usr/bin/env node
/**
 * dev:ready —— 让调试 Chrome「开发者模式开启 + extension/ 已加载 + 已启用」一次到位。
 *
 * 背景: Chrome 137+ 官方版移除了 --load-extension（scripts/dev-chrome.sh 里的该参数会被忽略）,
 * 未打包扩展不再随命令行加载。改用浏览器级 CDP `Extensions.loadUnpacked`:
 *   1. 等 127.0.0.1:9223 就绪
 *   2. 打开 chrome://extensions 并确保开发者模式开启（关闭时未打包扩展会被停用）
 *   3. Extensions.loadUnpacked({ path: extension/ 绝对路径 })
 *   4. 回读 /json/list 校验后台 service_worker 目标
 *
 * 用法:
 *   npm run dev          # 终端 A: 起调试 Chrome（CDP 9223）
 *   npm run dev:ready    # 终端 B: 幂等加载/校验扩展
 *
 * 环境变量: CDP_URL 覆盖 CDP 地址（默认 http://127.0.0.1:9223）
 * 退出码: 0 = 已就绪; 1 = 失败（会打印原因）
 */
import WebSocket from 'ws';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { idFromKey } from './lib/extension-id.mjs';

const CDP = (process.env.CDP_URL || 'http://127.0.0.1:9223').replace(/\/$/, '');
const EXT_DIR = resolve('extension');
const MANIFEST = resolve(EXT_DIR, 'manifest.json');
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!existsSync(MANIFEST)) fail(`找不到 ${MANIFEST}（在仓库根目录执行）`);
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const expectedId = manifest.key ? idFromKey(manifest.key) : '';

const list = async () => (await (await fetch(`${CDP}/json/list`)).json());
const loaded = async (id) => (await list()).some((t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${id}/`));

async function waitCdp() {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${CDP}/json/version`)).ok) return; } catch { /* 还没起来 */ }
    await SLEEP(1000);
  }
  fail(`CDP ${CDP} 不可达（先在另一个终端 npm run dev）`);
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.once('open', () => res({
      send: (method, params = {}) => new Promise((done) => {
        const id = ++seq;
        pending.set(id, (m) => done(m.result?.exceptionDetails ? { err: m.result.exceptionDetails.text } : (m.result ?? m.error)));
        ws.send(JSON.stringify({ id, method, params }));
      }),
      close: () => { try { ws.close(); } catch { /* 忽略 */ } },
    }));
    ws.once('error', rej);
  });
}

async function openExtensionsPage() {
  const hit = (await list()).find((t) => t.type === 'page' && t.url.startsWith('chrome://extensions'));
  if (hit) return { target: hit, created: false };
  const r = await fetch(`${CDP}/json/new?chrome%3A%2F%2Fextensions%2F`, { method: 'PUT' });
  if (!r.ok) fail('打不开 chrome://extensions（CDP /json/new 失败）');
  const target = await r.json();
  await SLEEP(2200); // chrome:// 页面 + shadow DOM 挂载
  return { target, created: true };
}

async function ensureDevMode(page) {
  const expr = `(() => {
    const q = (r, s) => r ? r.querySelector(s) : null;
    const sr = q(document, 'extensions-manager')?.shadowRoot;
    if (!sr) return { error: 'no-manager' };
    const toggle = q(q(sr, 'extensions-toolbar')?.shadowRoot, '#devMode');
    if (!toggle) return { error: 'no-devmode-toggle' };
    const before = !!toggle.checked;
    if (!before) toggle.click();
    return { before, after: !!toggle.checked };
  })()`;
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  return r?.result?.value ?? r;
}

async function main() {
  await waitCdp();
  if (expectedId && await loaded(expectedId)) {
    log(`✓ 扩展已加载并在运行: ${manifest.name}（${expectedId}）`);
    return;
  }

  const { target, created } = await openExtensionsPage();
  const page = await connect(target.webSocketDebuggerUrl);
  const dev = await ensureDevMode(page);
  if (dev?.error) fail(`无法确认开发者模式: ${dev.error}（可手动打开 chrome://extensions 勾选）`);
  if (dev && dev.before === false && dev.after === false) fail('开发者模式未能开启（Chrome 可能弹了确认框）');
  if (dev?.before === false) log('· 已开启开发者模式');
  await SLEEP(800);

  const version = await (await fetch(`${CDP}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);
  const path = process.platform === 'win32' ? EXT_DIR.replace(/\//g, '\\') : EXT_DIR;
  const r = await browser.send('Extensions.loadUnpacked', { path });
  browser.close();
  if (r?.err) fail(`Extensions.loadUnpacked 失败: ${r.err}`);

  const id = r?.id || expectedId;
  await SLEEP(1200);
  if (!await loaded(id)) fail(`加载后仍看不到后台 service_worker（id=${id}）—— 检查 extension/manifest.json 是否合法`);
  if (expectedId && id !== expectedId) log(`⚠ 实际扩展 ID ${id} 与 manifest key 推算的 ${expectedId} 不一致`);

  const probe = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const q = (r, s) => r ? r.querySelector(s) : null;
      const items = [...(q(q(document, 'extensions-manager')?.shadowRoot, 'extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') || [])];
      const it = items.find((i) => i.id === ${JSON.stringify(id)});
      return it ? { enabled: !!q(it.shadowRoot, '#enableToggle')?.checked, name: (q(it.shadowRoot, '#name')?.textContent || '').trim() } : null;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const info = probe?.result?.value;
  page.close();
  if (created) await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});

  if (info && info.enabled === false) fail(`扩展已加载但处于停用状态: ${info.name || id}`);
  log(`✓ 扩展已加载: ${info?.name || manifest.name}（${id}）· CDP ${CDP}`);
}

main().catch((e) => fail(e?.message || String(e)));

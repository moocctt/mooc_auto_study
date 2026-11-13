#!/usr/bin/env node
/**
 * CDP 调试小工具 —— 连上 `npm run dev`（scripts/dev-chrome.sh）打开的那个 Chrome（默认 127.0.0.1:9223）
 * 直接执行一段 JS / 导航 / 截图。MCP 没接上时用它，行为等价于 MCP 的 evaluate_script。
 *
 * 用法:
 *   node scripts/cdp-eval.mjs --list                          # 列出目标（页面/扩展页/后台 SW）
 *   node scripts/cdp-eval.mjs --target ext                    # 在控制台页里跑一段默认探针
 *   node scripts/cdp-eval.mjs --target site --expr "document.title"
 *   node scripts/cdp-eval.mjs --target site --file probe.js    # 从文件读表达式（长脚本用这个）
 *   node scripts/cdp-eval.mjs --target site --goto https://mooc.ctt.cn/ --shot .tmp/shot.png
 *   node scripts/cdp-eval.mjs --target site --contexts --reload # 看内容脚本的隔离世界是否在页面上
 *
 * 目标选择（按顺序取第一个命中的）:
 *   ext  = chrome-extension:// 页面（控制台）      sw  = 后台 service worker
 *   site = mooc.ctt.cn 页面                        match=<子串> = URL 含该子串的页面
 *   不传  = 第一个普通页面
 * 环境变量: CDP_URL 覆盖地址（默认 http://127.0.0.1:9223）
 *
 * 注意: `chrome.runtime.getContexts()` 只列扩展**自己**的页面（扩展页/offscreen/SW）,
 * 不包含内容脚本 —— 判断内容脚本是否注入要看页面上的隔离世界（--contexts）。
 */
import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9223';

const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`${CDP}/json/list`).catch(() => null);
  if (!res?.ok) throw new Error(`连不上 CDP：${CDP}（先跑 npm run dev）`);
  return res.json();
}

function pick(list) {
  const pages = list.filter((t) => t.type === 'page');
  const want = arg('target');
  const match = arg('match');
  if (match) return pages.find((t) => String(t.url).includes(match)) || list.find((t) => String(t.url).includes(match));
  if (want === 'ext') return pages.find((t) => String(t.url).startsWith('chrome-extension://'));
  if (want === 'sw') return list.find((t) => t.type === 'service_worker') || pages.find((t) => String(t.url).includes('/background.js'));
  if (want === 'site') return pages.find((t) => String(t.url).includes('mooc.ctt.cn'));
  return pages.find((t) => !String(t.url).startsWith('chrome://')) || pages[0];
}

class Cdp {
  constructor(url, onEvent) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.onEvent = onEvent;
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method) { this.onEvent?.(m); return; }   // 事件（executionContextCreated 等）
      const w = this.waiting.get(m.id);
      if (w) { this.waiting.delete(m.id); w(m); }
    });
  }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.id;
      this.waiting.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

async function run() {
  const list = await targets();
  if (flag('list')) {
    for (const t of list) {
      if (t.type === 'browser_ui') continue;
      console.log(`${t.type.padEnd(14)} ${String(t.url).slice(0, 110)}`);
    }
    return;
  }

  const target = pick(list);
  if (!target) throw new Error('没匹配到目标（用 --list 看看有哪些）');
  console.log(`› 目标: ${target.type} ${String(target.url).slice(0, 100)}`);

  const contexts = [];
  const cdp = new Cdp(target.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
  });
  await cdp.open();
  await cdp.send('Runtime.enable');

  const goto = arg('goto');
  if (goto) {
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: goto });
    await sleep(Number(arg('wait', '4000')));
    console.log(`› 已导航: ${goto}`);
  }

  // 内容脚本注入核对: 页面上的隔离世界（名字 = 扩展名）才是证据
  if (flag('contexts')) {
    await cdp.send('Page.enable');
    if (flag('reload')) await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(Number(arg('wait', '5000')));
    const rows = contexts.map((c) => ({
      type: c.auxData?.isDefault === false ? 'isolated' : 'main',
      world: String(c.name || '(main)').slice(0, 50),
      origin: String(c.origin || '').slice(0, 40),
    }));
    console.log(rows.length ? JSON.stringify(rows, null, 1) : '（没抓到上下文, 加大 --wait 试试）');
    if (!rows.some((r) => r.type === 'isolated')) console.log('⚠ 没有隔离世界 → 内容脚本没注入（检查 matches / 扩展是否重载）');
    cdp.close();
    return;
  }

  const file = arg('file');
  const expr = file ? readFileSync(file, 'utf8') : (arg('expr') || '1');
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) {
    const desc = ex.exception?.description || ex.text || JSON.stringify(ex);
    console.error(`✗ 执行出错: ${String(desc).slice(0, 800)}`);
    process.exitCode = 1;
  } else {
    const v = r.result?.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }

  const shot = arg('shot');
  if (shot) {
    await cdp.send('Page.enable');
    const cap = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const b64 = cap.result?.data;
    if (b64) { writeFileSync(shot, Buffer.from(b64, 'base64')); console.log(`› 截图: ${shot}`); }
    else console.error('✗ 截图失败');
  }
  cdp.close();
}

run().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });

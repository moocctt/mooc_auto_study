#!/usr/bin/env node
/**
 * E2E 回归运行器（Windows/CDP 版, 替代 Linux 专用的 extension_e2e.sh）。
 * 对运行中的调试 Chrome（scripts/dev-chrome.sh, 端口 9223）逐套执行 tests/checks-*.json 断言。
 *
 * 用法:
 *   node tests/e2e.mjs                 # 跑全部套件（缺对应页面自动 SKIP）
 *   node tests/e2e.mjs console mooc    # 只跑指定套件
 * 退出码: 0=全过(或全跳过), 1=有 FAIL。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9223';

const targets = async () => {
  const r = await fetch(`${BASE}/json/list`);
  if (!r.ok) throw new Error(`CDP ${BASE} 不可达 (${r.status})`);
  return r.json();
};

/** 对单个 target 跑一段 JS, 返回返回值（8s 超时） */
function evalOn(target, expr) {
  return new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const done = (v) => { try { ws.close(); } catch { /* 忽略 */ } resolve(v); };
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })));
    ws.on('message', (m) => {
      const d = JSON.parse(m);
      if (d.id === 1) done(d.result?.result?.value ?? { __err: d.result?.exceptionDetails?.text || 'eval-error' });
    });
    ws.on('error', () => done({ __err: 'ws-error' }));
    setTimeout(() => done({ __err: 'TIMEOUT' }), 8000);
  });
}

/**
 * 保持一个常连 CDP 会话开启焦点模拟。
 * 控制台 UI 用 requestAnimationFrame 批处理渲染: 标签切到后台后 rAF 被挂起,
 * navHash 改了 hash 也要等很久才重绘, 套件会读到旧页面（典型假 FAIL）。
 * 焦点模拟只在当前 CDP 会话有效, 所以必须在整个跑批期间保持连接。
 */
async function keepConsoleFocused() {
  try {
    const ts = await targets();
    const page = ts.find((t) => t.type === 'page' && t.url.includes('console.html'));
    if (!page) return null;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ id: 1, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }));
    ws.send(JSON.stringify({ id: 2, method: 'Page.bringToFront' }));
    return ws;
  } catch {
    return null;
  }
}

/** 套件自导航: 命中页面后把 hash 切到目标路由并等渲染 */
async function navHash(target, hash) {
  await evalOn(target, `location.hash = ${JSON.stringify(hash)}; 'ok'`);
  await new Promise(r => setTimeout(r, 1500));
}

/** 单条断言判定 */
function checkOne(expect, val) {
  if (typeof expect === 'boolean') return val === expect;
  if (typeof expect === 'number') return typeof val === 'number' && val >= expect;
  if (typeof expect === 'string') return val === expect;
  if (expect && typeof expect === 'object') {
    if ('contains' in expect) return String(val ?? '').includes(expect.contains);
    if ('matches' in expect) return new RegExp(expect.matches).test(String(val ?? ''));
    if ('min' in expect) return typeof val === 'number' && val >= expect.min;
    if ('anyOf' in expect) return expect.anyOf.some((e) => checkOne(e, val));
  }
  return false;
}

/** 按 a.b.c 路径取值 */
const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

async function runSuite(file, name) {
  const spec = JSON.parse(readFileSync(file, 'utf-8'));
  const ts = await targets();
  const page = ts.find((t) => t.type === (spec.type || 'page')
    && (!spec.urlIncludes || t.url.includes(spec.urlIncludes)));
  if (!page) {
    console.log(`  SKIP ${name}  （无匹配页面: ${spec.urlIncludes || '*'}）`);
    return 'skip';
  }
  if (spec.hash) await navHash(page, spec.hash);
  const out = await evalOn(page, `(${spec.expression})()`);
  if (out && out.__err) {
    console.log(`  FAIL ${name}  eval: ${out.__err}`);
    return 'fail';
  }
  const rows = Object.entries(spec.expect).map(([path, exp]) => {
    const val = dig(out, path);
    const ok = checkOne(exp, val);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}  ${path} = ${JSON.stringify(val)}  (期望 ${JSON.stringify(exp)})`);
    return ok ? 'pass' : 'fail';
  });
  return rows.includes('fail') ? 'fail' : 'pass';
}

const wanted = process.argv.slice(2);
const files = readdirSync(DIR).filter((f) => /^checks-.*\.json$/.test(f)
  && (!wanted.length || wanted.some((w) => f.includes(w))));
if (!files.length) { console.error('无匹配的 checks-*.json'); process.exit(1); }

try { await targets(); } catch (e) {
  console.error(`E2E 前置失败: ${e.message}（先启动 scripts/dev-chrome.sh 调试实例）`);
  process.exit(1);
}

console.log(`E2E: ${BASE} · ${files.length} 套件`);
const focus = await keepConsoleFocused();
const tally = { pass: 0, fail: 0, skip: 0 };
for (const f of files) {
  const name = f.replace(/^checks-|\.json$/g, '');
  tally[await runSuite(join(DIR, f), name)] += 1;
}
focus?.close();
console.log(`结果: ${tally.pass} 过 / ${tally.fail} 挂 / ${tally.skip} 跳过`);
process.exit(tally.fail ? 1 : 0);

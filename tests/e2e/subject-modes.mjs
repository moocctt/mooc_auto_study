#!/usr/bin/env node
/**
 * E2E: 两种模式各真实完成一个专题 —— 快刷(bot) / 无人值守(真实页面播放)。真机回归。
 * 前置: npm run dev 的调试 Chrome(9223) 控制台已打开、账号已登录、完整功能已解锁。
 * 用法: node tests/e2e/subject-modes.mjs [CDP_BASE]
 * 逻辑:
 *   快刷     → mode=auto, 挑含未完成媒体小节的专题, run({action:'course'}) → 断言平台全部小节记完成
 *   无人值守 → 挑「第一个未完成小节是媒体且完成率最高」的专题(剩余时间最短, AP 天然从它开播,
 *             1x 真实播放) → 轮询该节平台记完成 → 立即停止值守(后续长视频不烧时间)
 * 注意: 会向平台上报真实学习记录(用户授权的真机测试); 退出码 0=全过, 1=有 FAIL。
 */
import WebSocket from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:9223';
const BOT_TIMEOUT_MS = 20 * 60_000;
const AP_TIMEOUT_MS = 40 * 60_000;
const results = [];
const note = (ok, label, detail = '') => { results.push({ ok, label, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); };

const list = await (await fetch(`${BASE}/json/list`)).json();
// 扩展重载会留下一堆孤儿 console 页(chrome.runtime 已死) —— 只认活着的那一个
let console_ = null;
for (const cand of list.filter((x) => x.type === 'page' && x.url.includes('console.html'))) {
  const ws0 = new WebSocket(cand.webSocketDebuggerUrl);
  const ok = await new Promise((res) => {
    const to = setTimeout(() => res(false), 3000);
    ws0.on('open', () => ws0.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '!!(globalThis.chrome?.runtime?.id && window.__moocApi?.consoleApi?.state)', returnByValue: true } })));
    ws0.on('message', (m) => { const d = JSON.parse(m); if (d.id === 1) { clearTimeout(to); res(d.result?.result?.value === true); ws0.close(); } });
    ws0.on('error', () => { clearTimeout(to); res(false); });
  });
  if (ok) { console_ = cand; break; }
}
if (!console_) { console.log('FAIL 未找到活着的控制台页 —— 前置: npm run dev 且控制台已打开并登录(孤儿页不算)'); process.exit(1); }

const ws = new WebSocket(console_.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } });
await new Promise((r) => ws.on('open', r));
const evalPage = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面执行出错: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sectionsOf = (bid) => evalPage(`(async () => JSON.stringify((await window.__moocApi.consoleApi.sections('${bid}')).sections.map((x) => [x.finish, x.rate ?? 0]))) ()`).then(JSON.parse);

/** 选题:
 *  快刷 → 含未完成媒体小节(类型 5/6)的专题(非媒体会被 bot 跳过, 全文档专题必 0 完成);
 *  无人值守 → 「第一个未完成小节」是媒体且完成率最高的专题(剩余时间最短, AP 按节序天然先播它) */
const pick = await evalPage(`(async () => {
  const api = window.__moocApi;
  const s = await api.consoleApi.overview();
  const subjects = s.rows.filter((r) => r.type === '专题' && r.runnable && !String(r.state).startsWith('已完成')).slice(0, 12);
  const MEDIA = new Set([5, 6]);
  const botSet = new Map();
  let best = null;   // { bid, subject, secIdx, secName, rate }
  for (const r of subjects) {
    try {
      const det = await api.consoleApi.sections(r.bid);
      const unMedia = det.sections.filter((x) => ![2, 4].includes(x.finish) && MEDIA.has(x.type));
      if (unMedia.length) botSet.set(r.bid, { bid: r.bid, name: r.name, mediaUn: unMedia.length });
      const firstUn = det.sections.find((x) => ![2, 4].includes(x.finish));
      if (firstUn && MEDIA.has(firstUn.type)) {
        const rate = firstUn.rate ?? 0;
        if (!best || rate > best.rate) best = { bid: r.bid, subject: r.name, secName: firstUn.name || String(firstUn.resource_id), rate };
      }
    } catch { /* 拉不动的跳过 */ }
  }
  return JSON.stringify({ bot: [...botSet.values()].slice(0, 2), ap: best });
})()`);
const { bot, ap } = JSON.parse(pick);
note(!!bot.length, '快刷候选专题(含可提交媒体小节)', bot.map((t) => t.name).join(' / ') || '无');
note(!!ap, '无人值守目标专题(首个未完成小节剩余最短)', ap ? `${ap.subject} — 「${ap.secName}」完成率 ${ap.rate}%` : '无');
if (!bot.length) process.exit(1);

/** 快刷: mode auto, bot 按 chunk 提交学习轮次, 分钟级完成 */
const runFast = async (subj) => {
  console.log(`  … 快刷开始: ${subj.name}`);
  await evalPage(`window.__moocApi.consoleApi.settings({ mode: 'auto' })`);
  await evalPage(`window.__moocApi.consoleApi.run({ action: 'course', bid: '${subj.bid}' })`);
  const t0 = Date.now();
  let lastLine = '';
  while (Date.now() - t0 < BOT_TIMEOUT_MS) {
    await sleep(10_000);
    const s = await evalPage(`(async () => {
      const api = window.__moocApi;
      const st = await api.consoleApi.state();
      const un = (await api.consoleApi.sections('${subj.bid}')).sections.filter((x) => ![2, 4].includes(x.finish));
      const run = (st.runs || [])[0] || {};
      return JSON.stringify({ busy: st.busy, un: un.length, runStatus: run.status, label: run.label });
    })()`);
    const p = JSON.parse(s);
    const line = `${p.label} · 未完成 ${p.un}`;
    if (line !== lastLine) { lastLine = line; console.log(`  … ${line}`); }
    if (!p.busy && p.runStatus === 'done') {
      const secs = await sectionsOf(subj.bid);
      const doneN = secs.filter(([f, rate]) => [2, 4].includes(f) || rate >= 100).length;
      note(doneN === secs.length, `快刷 完成专题: ${subj.name}`, `平台小节 ${doneN}/${secs.length} 已记完成`);
      return;
    }
    if (!p.busy && p.runStatus && p.runStatus !== 'running') {
      note(false, `快刷 异常结束: ${subj.name}`, `runStatus=${p.runStatus}`);
      return;
    }
  }
  note(false, `快刷 超时: ${subj.name}`, `${BOT_TIMEOUT_MS / 60000}min 上限`);
};

/** 无人值守: 定向开播(首个未完成小节即目标), 1x 真实播放, 该节平台记完成后立即停止 */
const runUnattended = async (tgt) => {
  console.log(`  … 无人值守开始: ${tgt.subject} — 「${tgt.secName}」(完成率 ${tgt.rate}%, 1x 真实播放)`);
  await evalPage(`(async () => {
    const a = await import(chrome.runtime.getURL('lib/actions.js'));
    const st = await (await import(chrome.runtime.getURL('lib/store.js'))).getState();
    const row = st.rows.find((r) => r.bid === '${tgt.bid}');
    await a.startAutopilotFrom(row);
  })()`);
  const t0 = Date.now();
  let lastLine = '';
  while (Date.now() - t0 < AP_TIMEOUT_MS) {
    await sleep(30_000);
    const s = await evalPage(`(async () => {
      const g = await chrome.storage.local.get(['mooc.autopilot', 'mooc.autopilotStatus']);
      const secs = (await window.__moocApi.consoleApi.sections('${tgt.bid}')).sections;
      return JSON.stringify({ on: g['mooc.autopilot'], status: g['mooc.autopilotStatus'], secs: secs.map((x) => [x.finish, x.rate ?? 0]) });
    })()`);
    const p = JSON.parse(s);
    const doneN = p.secs.filter(([f, rate]) => [2, 4].includes(f) || rate >= 100).length;
    const line = `${p.status} · 已记完成 ${doneN}/${p.secs.length}`;
    if (line !== lastLine) { lastLine = line; console.log(`  … ${line}`); }
    // 目标小节(最初完成率最高的那个)记完成 → 达成, 立即停止
    if (p.secs[tgt.secIdx ?? 0] && ([2, 4].includes(p.secs[tgt.secIdx][0]) || p.secs[tgt.secIdx][1] >= 100) && tgt.rate < 100) {
      note(true, `无人值守 播完目标小节: ${tgt.subject} — 「${tgt.secName}」`, `耗时 ${Math.round((Date.now() - t0) / 60000)}min, 平台已记完成`);
      await evalPage(`(async () => (await import(chrome.runtime.getURL('lib/actions.js'))).stopAutopilot()) ()`);
      return;
    }
    if (p.secs.every(([f, rate]) => [2, 4].includes(f) || rate >= 100)) {
      note(true, `无人值守 完成专题: ${tgt.subject}`, `耗时 ${Math.round((Date.now() - t0) / 60000)}min`);
      await evalPage(`(async () => (await import(chrome.runtime.getURL('lib/actions.js'))).stopAutopilot()) ()`);
      return;
    }
    if (!p.on) {
      note(false, `无人值守 自停: ${tgt.subject}`, `值守停止(${p.status}), 未完成 ${p.secs.length - doneN}/${p.secs.length}`);
      return;
    }
  }
  await evalPage(`(async () => (await import(chrome.runtime.getURL('lib/actions.js'))).stopAutopilot()) ()`);
  note(false, `无人值守 超时: ${tgt.subject}`, `${AP_TIMEOUT_MS / 60000}min 上限, 1x 真实播放无法加速`);
};

try {
  if (bot[0]) await runFast(bot[0]);
  if (ap) await runUnattended(ap);
} catch (e) {
  note(false, '执行异常', String(e.message || e));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果: ${results.length - failed} 过 / ${failed} 挂`);
process.exit(failed ? 1 : 0);

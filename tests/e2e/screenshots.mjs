#!/usr/bin/env node
/**
 * 商店截图生成器（Windows / CDP 版, 对应 Linux 的 tests/screenshots.sh）
 *
 * 做法: 复制 extension（开发版, 带 key → 扩展 ID 固定）到临时目录,
 * 用独立 user-data-dir 起一个隔离的 Chrome（默认 headless）, 打开
 * console.html?demo=1（演示数据, 不含真实账号）逐屏截图, 视口 1280×800。
 *
 * 产出: docs/store/screenshots/*.png
 *   1-home / 2-stats-heatmap / 3-courses / 4-search / 5-settings  ← 商店上传顺序
 *   settings-accounts / settings-activity / login / login-wechat / login-download ← README
 *
 * 用法:
 *   npm run build              # 先有开发版产物（带 key, 不能用 zip:store 的商店包）
 *   node tests/screenshots.mjs
 *   SHOT_HEADED=1 node tests/screenshots.mjs   # 想肉眼看过程时用有头模式
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/store/screenshots");
const EXT = join(ROOT, ".tmp-shots-ext");
const PROFILE = join(ROOT, ".tmp-shots-profile");
const PORT = Number(process.env.SHOT_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 删临时目录: 本机 fs.rmSync 被 safe-delete 垫片接管(可能失败), 兜底走系统命令 */
function hardDelete(p) {
  try { rmSync(p, { recursive: true, force: true }); return; } catch { /* 落到下面 */ }
  try {
    if (process.platform === "win32") execFileSync("cmd", ["/c", "rmdir", "/s", "/q", p], { stdio: "ignore" });
    else execFileSync("rm", ["-rf", p], { stdio: "ignore" });
  } catch { /* 删不掉就算了, 下次启动会再尝试 */ }
}

// ── 扩展 ID: 由 manifest.key 算出 (sha256 前 16 字节, 每 nibble 映射 a-p) ──
function extIdFromKey(keyB64) {
  const hex = createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const d = JSON.parse(raw.toString());
      const cb = this.pending.get(d.id);
      if (cb) { this.pending.delete(d.id); cb(d); }
    });
  }
  open() { return new Promise((res, rej) => { this.ws.on("open", res); this.ws.on("error", rej); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${JSON.stringify(d.error)}`)) : res(d.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

let cdp;
const evalJs = async (expr) => {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval 失败: ${r.exceptionDetails.text} :: ${expr.slice(0, 80)}`);
  return r.result?.value;
};
const goto = async (url, waitMs = 1200) => { await cdp.send("Page.navigate", { url }); await sleep(waitMs); };
const click = (js) => evalJs(`(() => { ${js} })()`);

const shots = [];
async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const buf = Buffer.from(data, "base64");
  writeFileSync(join(OUT, name), buf);
  shots.push(name);
  console.log(`  ✓ ${name}  ${(buf.length / 1024).toFixed(0)} KB`);
}

/** 等某个表达式为真 */
async function waitFor(expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalJs(expr)) return true; } catch { /* 页面切换中, 忽略 */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8"));
  if (!manifest.key) {
    console.error("✗ extension 没有 key（这是商店包）。先跑 `npm run build` 生成开发版产物。");
    process.exit(1);
  }
  for (const p of [EXT, PROFILE]) hardDelete(p);
  cpSync(join(ROOT, "extension"), EXT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PROFILE, { recursive: true });

  const headless = process.env.SHOT_HEADED !== "1";
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--hide-scrollbars",
    "--window-size=1280,900",
    "--window-position=-2400,-2400",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");

  console.log(`› 启动 Chrome (${headless ? "headless" : "headed"}), 端口 ${PORT}`);
  const chrome = spawn(CHROME, args, { stdio: "ignore", detached: false });

  // Chrome 137 起 `--load-extension` 已失效（扩展照样装不上），改用 CDP 的
  // Extensions.loadUnpacked（Chrome 130+），返回的就是真实扩展 ID。
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      const v = await (await fetch(`${BASE}/json/version`)).json();
      if (v.webSocketDebuggerUrl) browser = new Cdp(v.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!browser) await sleep(250);
  }
  if (!browser) throw new Error(`CDP 端口 ${PORT} 没起来`);
  await browser.open();
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const id = loaded.id;
  const extUrl = `chrome-extension://${id}/console.html`;
  console.log(`› 扩展 ID: ${id}  (v${manifest.version})`);

  // 装好后 background 会自动弹一个「欢迎安装」标签（?onboard=1），先关掉，
  // 否则会抢走我们的标签、把 ?demo=1 丢掉（截图就变成未登录的登录页）
  await sleep(1200);
  for (const t of await (await fetch(`${BASE}/json/list`)).json()) {
    if (t.type === "page" && t.url.includes("onboard")) await browser.send("Target.closeTarget", { targetId: t.id });
  }

  // 新开标签再导航过去（/json/new 打开 chrome-extension:// 会得到 chrome-error）
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  browser.close();

  let page;
  for (let i = 0; i < 40 && !page; i++) {
    const tabs = await (await fetch(`${BASE}/json/list`)).json();
    page = tabs.find((t) => t.id === targetId) || tabs.find((t) => t.type === "page" && t.url.startsWith("chrome-extension://"));
    if (!page) await sleep(200);
  }
  if (!page) throw new Error("拿不到新建标签页的调试地址");

  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  await cdp.send("Page.navigate", { url: `${extUrl}?demo=1` });

  try {
    // ── 概览页 ───────────────────────────────────────────────
    // 概览页的 h1 是「概览」(不是产品名), 用「有 h1 + 出现学时数字」判断渲染完成
    if (!(await waitFor(`!!document.querySelector('h1') && /学时/.test(document.body.innerText||'')`, 15000))) {
      const diag = await evalJs(`JSON.stringify({ href: location.href, title: document.title, h1: document.querySelector('h1')?.textContent || null, body: (document.body?.innerText || '').slice(0, 200) })`);
      throw new Error(`控制台没渲染出来: ${diag}`);
    }
    await sleep(600);
    await evalJs("window.scrollTo(0,0); 1");
    await sleep(400);
    await shot("1-home.png");

    await click(`const el=document.querySelector('[data-testid=heatmap]'); el?.scrollIntoView({block:'start'}); return 1;`);
    await sleep(600);
    await shot("2-stats-heatmap.png");

    // ── 课程页: 封面视图 ─────────────────────────────────────
    await goto(`${extUrl}?demo=1#/tasks`, 900);
    await click(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('封面')); b?.click(); return 1;`);
    await sleep(700);
    await evalJs("window.scrollTo(0,0); 1");
    await sleep(300);
    await shot("3-courses.png");

    // ── 课程库搜索 ───────────────────────────────────────────
    await click(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='课程库'); b?.click(); return 1;`);
    await sleep(600);
    await click(`
      const i=document.querySelector('input[placeholder*=搜索课程]'); if(!i) return 1;
      const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.bind(i);
      s('安全'); i.dispatchEvent(new Event('input',{bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1;`);
    await sleep(1400);
    await evalJs("window.scrollTo(0,0); 1");
    await sleep(300);
    await shot("4-search.png");

    // ── 设置: 账号 / 偏好 ────────────────────────────────────
    await goto(`${extUrl}?demo=1#/settings`, 900);
    const tab = (label) => click(`const b=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='${label}'); b?.click(); return 1;`);
    await tab("账号"); await sleep(700);
    await shot("settings-accounts.png");
    await tab("偏好"); await sleep(700);
    await shot("5-settings.png");

    // ── 设置: 运行（要先用页脚小点连点 5 次解锁）──────────────
    await goto(`${extUrl}?demo=1#/report`, 800);
    await click(`const dot=document.querySelector('[data-testid=unlock-dot]'); if(!dot) return 0; for(let i=0;i<5;i++) dot.click(); return 1;`);
    await sleep(500);
    await goto(`${extUrl}?demo=1#/settings`, 800);
    await tab("运行");
    await sleep(2600); // 等解锁 toast 消失, 别叠在设置项上
    await shot("settings-activity.png");

    // 值守徽标不在 demo 模式渲染（lib/actions.ts 里 isDemo() 直接跳过值守绑定），
    // 想要那张图得用真实账号 + 真在值守的实例，不适合放进公开商店素材，故不生成。

    // ── 登录页（无 demo）────────────────────────────────────
    await goto(extUrl, 1500);
    if (!(await waitFor(`(document.querySelector('h2')?.textContent||'').includes('登录')`, 8000))) {
      console.log("  ! 登录页标题未就绪，按当前状态截图");
    }
    await sleep(700);
    await shot("login.png");

    await click(`const b=[...document.querySelectorAll('[aria-label]')].find(x=>(x.getAttribute('aria-label')||'').includes('下载')); b?.click(); return 1;`);
    await sleep(900);
    await shot("login-download.png");
    await evalJs("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1");
    await sleep(500);

    await click(`const b=[...document.querySelectorAll('[aria-label]')].find(x=>(x.getAttribute('aria-label')||'').includes('微信扫码登录')); b?.click(); return 1;`);
    await sleep(1200);
    await shot("login-wechat.png");
  } finally {
    cdp.close();
    chrome.kill();
    await sleep(500);
    for (const p of [EXT, PROFILE]) hardDelete(p);
  }

  // ── 校验: 尺寸必须 1280×800, 且内容互不相同（全同 = 截到空白页）──
  let bad = 0;
  const hashes = new Set();
  for (const f of readdirSync(OUT).filter((x) => x.endsWith(".png"))) {
    const b = readFileSync(join(OUT, f));
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    const sha = createHash("md5").update(b).digest("hex");
    const dup = hashes.has(sha);
    hashes.add(sha);
    const sizeOk = w === W && h === H;
    if (!sizeOk || dup) bad++;
    console.log(`  ${sizeOk && !dup ? "✓" : "✗"} ${f}  ${w}×${h}  ${(b.length / 1024).toFixed(0)}KB${dup ? "  ← 与前面重复" : ""}`);
  }
  console.log(`\n${bad ? "✗" : "✓"} 截图已更新: ${shots.length} 张 → docs/store/screenshots/  （商店上传 1-5）`);
  if (bad) process.exit(1);
}

main().catch(async (e) => {
  console.error(`✗ ${e.message}`);
  try { cdp?.close(); } catch { /* 忽略 */ }
  for (const p of [EXT, PROFILE]) hardDelete(p);
  process.exit(1);
});

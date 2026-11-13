#!/usr/bin/env node
/**
 * 扫码核对探针（本地实机, 不是单测）
 * ================================
 * 目的: 用真实手机扫一次码, 把平台**实际下发**的令牌原样核对清楚:
 *   · token 里到底有没有 expires_in（APP 通道 / 微信通道各自不同）
 *   · 落库时 source 记成什么（qr-app / qr-wechat）
 *   · 控制台账号卡片据此显示的「登录态剩余」文案是否合理
 *
 * 做法: 独立 user-data-dir + 开发版产物（带 key, 扩展 ID 固定）起一个**有头** Chrome,
 * 打开 console.html（无账号 → 登录页, 左栏常驻 APP 码 / 右栏可切微信码）,
 * 手机扫码后轮询 chrome.storage.local 里的 mooc.vault.tokens, 拿到令牌就打元数据
 * （只打字段与寿命, **不打印 access_token 本体**）, 顺便截设置页账号卡片存证。
 *
 * 用法:
 *   npm run build                 # 开发版即 extension/ 目录, 无需构建
 *   node scripts/qr-probe.mjs     # 有头; 手机扫屏幕上的码, 扫完自动收尾
 *   QR_PROBE_WAIT=600 node scripts/qr-probe.mjs   # 加长等待（秒）
 *   QR_PROBE_HEADLESS=1 node scripts/qr-probe.mjs # 无头（只能靠保存的截图扫）
 *
 * 产出: .tmp-qr/01-login.png · 02-accounts.png · result.json
 * 说明: 令牌只落在临时 profile 里, 退出后可整个删掉（不碰你日常用的浏览器配置）。
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".tmp-qr");
const EXT = join(ROOT, ".tmp-qr-ext");
const PROFILE = join(ROOT, ".tmp-qr-profile");
const PORT = Number(process.env.QR_PROBE_PORT || 9334);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const WAIT_S = Number(process.env.QR_PROBE_WAIT || 420);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hardDelete(p) {
  try { rmSync(p, { recursive: true, force: true }); return; } catch { /* 落到下面 */ }
  try {
    if (process.platform === "win32") execFileSync("cmd", ["/c", "rmdir", "/s", "/q", p], { stdio: "ignore" });
    else execFileSync("rm", ["-rf", p], { stdio: "ignore" });
  } catch { /* 删不掉就算了 */ }
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

async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
  console.log(`  ✓ .tmp-qr/${name}`);
}

async function waitFor(expr, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalJs(expr)) return true; } catch { /* 页面切换中 */ }
    await sleep(250);
  }
  return false;
}

/** 读保管箱里的令牌（只读元数据, 不碰 access_token 本体） */
const READ_TOKENS = `(async () => {
  const got = await chrome.storage.local.get('mooc.vault.tokens');
  return JSON.stringify(got['mooc.vault.tokens'] || {});
})()`;

function describe(name, tok, now = Date.now()) {
  const ttl = Number(tok?.expires_in || 0) || null;
  const obtainedAt = Number(tok?.obtainedAt || 0) || null;
  const expiresAt = ttl && obtainedAt ? obtainedAt + ttl * 1000 : null;
  return {
    '账号': name,
    '来源 source': tok?.source || '(未标)',
    'token 字段': Object.keys(tok || {}).sort().join(', '),
    expires_in: ttl || '(未下发)',
    寿命天: ttl ? +(ttl / 86400).toFixed(2) : null,
    obtainedAt: obtainedAt ? new Date(obtainedAt).toLocaleString('zh-CN') : '(无)',
    到期时间: expiresAt ? new Date(expiresAt).toLocaleString('zh-CN') : '(未知, 靠 401 兜底)',
    剩余天: expiresAt ? +((expiresAt - now) / 864e5).toFixed(2) : null,
    '含 refresh_token': !!tok?.refresh_token,
    token_type: tok?.token_type || '(无)',
  };
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8"));
  if (!manifest.key) {
    console.error("✗ extension 没有 key（商店包）。（extension/ 即开发版, key 常驻）。");
    process.exit(1);
  }
  for (const p of [EXT, PROFILE]) hardDelete(p);
  cpSync(join(ROOT, "extension"), EXT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PROFILE, { recursive: true });

  const headless = process.env.QR_PROBE_HEADLESS === "1";
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--window-size=1280,860",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  console.log(`› 启动 Chrome (${headless ? "headless" : "有头"}), 端口 ${PORT}, 扩展 v${manifest.version}`);
  const chrome = spawn(CHROME, args, { stdio: "ignore", detached: false });

  let browser;
  for (let i = 0; i < 240 && !browser; i++) {
    try {
      const v = await (await fetch(`${BASE}/json/version`)).json();
      if (v.webSocketDebuggerUrl) browser = new Cdp(v.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!browser) await sleep(250);
  }
  if (!browser) throw new Error(`CDP 端口 ${PORT} 没起来`);
  await browser.open();
  const { id } = await browser.send("Extensions.loadUnpacked", { path: EXT });
  console.log(`› 扩展 ID: ${id}`);
  console.log(`› (key 指纹 ${createHash("sha256").update(manifest.key).digest("hex").slice(0, 8)})`);

  await sleep(1200);
  for (const t of await (await fetch(`${BASE}/json/list`)).json()) {
    if (t.type === "page" && t.url.includes("onboard")) await browser.send("Target.closeTarget", { targetId: t.id });
  }
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  const extUrl = `chrome-extension://${id}/console.html`;
  await cdp.send("Page.navigate", { url: extUrl });
  const loginShown = await waitFor(`/扫码|登录/.test(document.body?.innerText || '') && !!document.querySelector('img[alt*="二维码"]')`, 20000);
  console.log(loginShown ? "› 登录页已就绪（左栏 APP 码 / 右栏切微信码）" : "! 没等到二维码, 仍继续（先看截图）");
  await sleep(800);
  await shot("01-login.png");
  if (!headless) console.log("› 请用手机扫浏览器窗口里的二维码（APP 或微信通道均可）");

  const t0 = Date.now();
  let found = null;
  let lastPrint = 0;
  while (Date.now() - t0 < WAIT_S * 1000) {
    try {
      const raw = await evalJs(READ_TOKENS);
      const tokens = JSON.parse(raw || "{}");
      const keys = Object.keys(tokens);
      if (keys.length) { found = tokens; break; }
    } catch { /* 页面重载中 */ }
    const left = Math.round((WAIT_S * 1000 - (Date.now() - t0)) / 1000);
    if (Date.now() - lastPrint > 15000) { console.log(`  … 等待扫码, 剩余 ${left}s`); lastPrint = Date.now(); }
    await sleep(2000);
  }

  const result = { checkedAt: new Date().toLocaleString("zh-CN"), version: manifest.version, accounts: [] };
  if (!found) {
    console.log("✗ 等待超时, 没拿到令牌（码过期未扫 / 换票失败, 看 01-login.png 的提示文字）");
    const note = await evalJs(`(document.body?.innerText || '').slice(0, 600)`).catch(() => "");
    result.timeout = true;
    result.pageText = note;
  } else {
    for (const [k, v] of Object.entries(found)) result.accounts.push(describe(k, v));
    console.log("\n=== 平台实际下发的令牌 ===");
    for (const a of result.accounts) console.log(JSON.stringify(a, null, 2));

    // 账号卡片文案: 设置 → 账号
    await cdp.send("Page.navigate", { url: `${extUrl}#/settings` });
    await sleep(1500);
    await evalJs(`[...document.querySelectorAll('button,a')].find(x=>/账号/.test(x.textContent||''))?.click(); 1`).catch(() => {});
    await sleep(900);
    await shot("02-accounts.png");
    const text = await evalJs(`(document.body?.innerText || '')`);
    result.cardLines = String(text || "").split("\n").map((s) => s.trim())
      .filter((s) => /登录态|有效期|到期|扫码|账号/.test(s)).slice(0, 40);
    console.log("\n=== 账号卡片相关文案 ===");
    for (const l of result.cardLines) console.log("  " + l);
  }
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(`\n✓ 结果已写入 .tmp-qr/result.json`);

  cdp.close();
  try { chrome.kill(); } catch { /* 忽略 */ }
}

main().catch((e) => { console.error("✗", e.message); process.exitCode = 1; });

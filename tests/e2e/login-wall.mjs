#!/usr/bin/env node
/**
 * 登录墙停机冒烟（本地实机, 需要 Chrome）
 * ======================================
 * 验证「值守中令牌失效 → 自动停值守 + 提示重新扫码」这条链路:
 *   1. 装开发版扩展（带 key → 扩展 ID 固定）, 先建 about:blank 再导航到官网
 *      （直接带 URL 建标签会在内容脚本注册前就开始加载, 脚本不会注入）
 *   2. 从扩展页把 mooc.autopilot 打开（模拟值守运行中, 并记下值守账号）
 *   3. 把该标签页导到平台真实登录页 `oauth/#login/<b64>`（等价于令牌过期被踢回登录）
 *   4. 断言内容脚本 2s 内自己停值守: autopilot=false + mooc.needLogin 有记录 + 状态文案 + 账号
 *   5. 截图控制台横幅（红色「值守已停止：登录态失效」+ 重新登录 / 去官网登录）
 *
 * 用法: node tests/e2e/login-wall.mjs        # 有头; LOGIN_WALL_HEADLESS=1 无头
 * 产出: .tmp-loginwall/02-console-banner.png
 */
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, ".tmp-loginwall");
const EXT = join(ROOT, ".tmp-loginwall-ext");
const PROFILE = join(ROOT, ".tmp-loginwall-profile");
const PORT = Number(process.env.LOGIN_WALL_PORT || 9335);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SITE = "https://mooc.ctt.cn/";
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

/** 平台登录页 hash: OAuth 参数 Base64（见 lib/qr.ts oauthHashKey） */
function platformLoginUrl() {
  const params = "response_type=token&client_id=999"
    + `&redirect_uri=${encodeURIComponent(SITE)}`
    + `&state=${encodeURIComponent("index")}&lang=cn&cancelRememberState=0`;
  return `${SITE}oauth/#login/${Buffer.from(params).toString("base64")}`;
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8"));
  if (!manifest.key) { console.error("✗ extension 没有 key（商店包）。先跑 `npm run build`。"); process.exit(1); }
  for (const p of [EXT, PROFILE]) hardDelete(p);
  cpSync(join(ROOT, "extension"), EXT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PROFILE, { recursive: true });

  const headless = process.env.LOGIN_WALL_HEADLESS === "1";
  const args = [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--window-size=1280,860", "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const chrome = spawn(CHROME, args, { stdio: "ignore" });
  console.log(`› 启动 Chrome, 端口 ${PORT}, 扩展 v${manifest.version}`);

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
  await sleep(1500);
  for (const t of await (await fetch(`${BASE}/json/list`)).json()) {
    if (t.type === "page" && t.url.includes("onboard")) await browser.send("Target.closeTarget", { targetId: t.id });
  }

  const siteTarget = await browser.send("Target.createTarget", { url: "about:blank" });
  const consTarget = await browser.send("Target.createTarget", { url: "about:blank" });
  browser.close();
  await sleep(600);
  const tabs = await (await fetch(`${BASE}/json/list`)).json();
  const siteTab = tabs.find((t) => t.id === siteTarget.targetId);
  const consTab = tabs.find((t) => t.id === consTarget.targetId);
  if (!siteTab || !consTab) throw new Error("拿不到标签页调试地址");

  // ── 控制台页: 后续所有 storage 读写 / 截图都从这里发起 ──
  const cdp = new Cdp(consTab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `chrome-extension://${id}/console.html` });
  await sleep(2500);
  const evalExt = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails.exception || {});
      throw new Error(`eval 失败: ${r.exceptionDetails.text} ${d}`);
    }
    return r.result?.value;
  };
  const readStore = async () => JSON.parse(await evalExt(`(async () => {
    const d = await chrome.storage.local.get(['mooc.autopilot','mooc.autopilotStatus','mooc.needLogin']);
    return JSON.stringify({ on: !!d['mooc.autopilot'], status: d['mooc.autopilotStatus'] || '', needLogin: d['mooc.needLogin'] || null });
  })()`));

  // ── 官网标签页: 先置前再导航（后台标签的 2s 定时器会被 Chrome 节流） ──
  const siteCdp = new Cdp(siteTab.webSocketDebuggerUrl);
  await siteCdp.open();
  await siteCdp.send("Page.enable");
  await siteCdp.send("Runtime.enable");
  try { await siteCdp.send("Page.bringToFront"); } catch { /* 忽略 */ }
  await siteCdp.send("Page.navigate", { url: SITE });
  await sleep(6000);

  const tabId = await evalExt(`(async () => {
    const list = await chrome.tabs.query({ url: 'https://mooc.ctt.cn/*' });
    return list.length ? list[0].id : -1;
  })()`);
  console.log(`› 值守标签页 tabId: ${tabId}`);
  if (!Number(tabId) || Number(tabId) < 0) throw new Error("拿不到官网标签页的 tabId");

  const injected = await evalExt(`(async () => {
    if (!chrome.runtime.getContexts) return 'no-getContexts';
    const l = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    return JSON.stringify(l.map((c) => c.documentUrl));
  })()`);
  console.log(`› 已注入的内容脚本: ${injected}`);
  if (String(injected) === "[]") throw new Error("内容脚本没注入到官网页面（检查 matches / 导航时机）");

  // 模拟值守运行中（含值守账号, 多账号时用来点名）
  await evalExt(`(async () => {
    await chrome.storage.local.set({
      'mooc.autopilot': true,
      'mooc.autopilotStatus': '播放中 12%',
      'mooc.autopilotTab': ${tabId},
      'mooc.autopilotAccount': 'smoke-user',
    });
    return 1;
  })()`);
  console.log("› 已开启值守（模拟运行中）");

  // 把官网标签页导到平台登录页 → 等价于令牌过期被踢回登录
  await siteCdp.send("Page.navigate", { url: platformLoginUrl() });
  await sleep(2000);
  const pageInfo = await siteCdp.send("Runtime.evaluate", {
    expression: "JSON.stringify({ url: location.href.slice(0,70), text: document.body.innerText.replace(/\\s+/g,' ').slice(0,70) })",
    returnByValue: true,
  });
  console.log(`› 登录页: ${pageInfo.result?.value}`);
  try { await siteCdp.send("Page.bringToFront"); } catch { /* 忽略 */ }
  siteCdp.close();

  // 内容脚本 2s 一拍, 给 15s 余量
  let got = null;
  for (let i = 0; i < 30; i++) {
    got = await readStore();
    if (!got.on && got.needLogin) break;
    await sleep(500);
  }
  console.log("\n=== storage 状态 ===");
  console.log(JSON.stringify(got, null, 2));

  if (got.on) throw new Error("✗ 仍在值守: 内容脚本没有识别登录墙");
  if (!got.needLogin) throw new Error("✗ 没有写入 mooc.needLogin 标记");
  if (!/登录态已失效/.test(got.status)) throw new Error(`✗ 状态文案不对: ${got.status}`);
  if (got.needLogin.account !== "smoke-user") throw new Error(`✗ 标记没带上值守账号: ${JSON.stringify(got.needLogin)}`);

  // 控制台横幅
  await cdp.send("Page.navigate", { url: `chrome-extension://${id}/console.html` });
  await sleep(2500);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(OUT, "02-console-banner.png"), Buffer.from(data, "base64"));
  console.log("  ✓ .tmp-loginwall/02-console-banner.png");
  const banner = await evalExt(`document.querySelector('[role=alert]')?.innerText || ''`);
  console.log(`› 横幅文案: ${JSON.stringify(String(banner).replace(/\s+/g, " ").slice(0, 140))}`);
  if (!/值守已停止/.test(String(banner))) throw new Error("✗ 控制台没有出现登录失效横幅");

  console.log("\n✓ 登录墙停机链路通过（停值守 + 标记 + 账号 + 文案 + 横幅）");
  cdp.close();
  try { chrome.kill(); } catch { /* 忽略 */ }
}

main().catch((e) => { console.error("✗", e.message); process.exitCode = 1; });

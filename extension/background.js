import { courseIdOf, freshUrl, landedUrlOk } from "./lib/mooc-routes.js";
import { NEED_LOGIN_KEY, readNeedLogin } from "./lib/needLogin.js";
import { authUi } from "./lib/iconState.js";
import { consoleUrl as buildConsoleUrl } from "./lib/loginEntry.js";
import { createSerializer } from "./lib/serializer.js";
import { EXPIRY_ALARM, nextExpiryDelay } from "./lib/tokenExpiry.js";
import { UPDATE_NOTICE_KEY, updateNotice } from "./lib/onUpdate.js";
import { STORE } from "./lib/flags.js";
// 商店版的能力级门控: STORE 不能只关 UI —— 一键值守/AUTOPILOT_* 消息链/内容脚本驱动
// 都要在这里短路, 否则改常量 ≠ 关自动化（审计 P0-1）
if (STORE) {
  void chrome.storage.local.set({ "mooc.storeBuild": true }).catch(() => {});
}
const AP = {
  on: "mooc.autopilot",
  at: "mooc.autopilotOnAt",
  // 本次值守的激活时间戳（内容脚本用它去重「强制切普清」）
  queue: "mooc.autopilotQueue",
  status: "mooc.autopilotStatus",
  tab: "mooc.autopilotTab",
  account: "mooc.autopilotAccount"
  // 本次值守用哪个账号（失效时标记才有归属）
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function landedOn(tabId, targetId, timeoutMs = 1e4) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (landedUrlOk(String(tab?.url || ""), targetId)) return true;
    } catch {
      return false;
    }
    await sleep(600);
  }
  return false;
}
const serializeOpen = createSerializer();
async function openCourseTab(url) {
  try {
    await serializeOpen(() => doOpenCourseTab(url));
  } catch {
  }
}
async function doOpenCourseTab(rawUrl) {
  const courseId = courseIdOf(rawUrl);
  const pinIt = async (tabId) => {
    try {
      await chrome.tabs.update(tabId, { pinned: true });
    } catch {
    }
    try {
      await chrome.tabs.update(tabId, { muted: true });
    } catch {
    }
  };
  const tryLand = async (id2) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await chrome.tabs.update(id2, { url: freshUrl(rawUrl), active: true });
      await pinIt(id2);
      if (!courseId || await landedOn(id2, courseId, 12e3)) return true;
    }
    return false;
  };
  const got = await chrome.storage.local.get(AP.tab);
  const id = Number(got?.[AP.tab]) || 0;
  if (id) {
    try {
      if (await tryLand(id)) return;
    } catch {
    }
  }
  if (courseId) {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => {
      try {
        return decodeURIComponent(t.url || "").includes(courseId);
      } catch {
        return false;
      }
    });
    if (hit?.id) {
      try {
        if (await tryLand(hit.id)) {
          await chrome.storage.local.set({ [AP.tab]: hit.id });
          return;
        }
      } catch {
      }
    }
  }
  const tab = await chrome.tabs.create({ url: freshUrl(rawUrl), active: true, pinned: true });
  if (tab?.id) {
    await chrome.storage.local.set({ [AP.tab]: tab.id });
    await pinIt(tab.id);
  }
}
const consoleUrl = (opts = {}) => buildConsoleUrl(chrome.runtime.getURL("/console.html"), opts);
async function openConsoleLogin(opts = {}) {
  const active = opts.active ?? true;
  const pat = new URLPattern({ protocol: "chrome-extension", hostname: chrome.runtime.id, pathname: "/console.html" });
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => {
    try {
      return pat.test(t.url || "");
    } catch {
      return false;
    }
  });
  if (hit?.id) {
    await chrome.tabs.update(hit.id, { active });
    try {
      await chrome.tabs.sendMessage(hit.id, { type: "CONSOLE_OPEN_LOGIN" });
    } catch {
      await chrome.tabs.update(hit.id, { url: consoleUrl({ login: true }), active });
    }
    if (active) {
      try {
        const win = await chrome.windows.get(hit.windowId);
        await chrome.windows.update(win.id, { focused: true });
      } catch {
      }
    }
    return;
  }
  await chrome.tabs.create({ url: consoleUrl({ login: true }), active });
}
async function openConsoleTab(url, opts = {}) {
  const active = opts.active ?? true;
  const pat = new URLPattern({ protocol: "chrome-extension", hostname: chrome.runtime.id, pathname: "/console.html" });
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => {
    try {
      return pat.test(t.url || "");
    } catch {
      return false;
    }
  });
  if (hit?.id) {
    const same = (() => {
      try {
        const a = new URL(hit.url || "");
        const b = new URL(url);
        return a.pathname === b.pathname && a.search === b.search;
      } catch {
        return false;
      }
    })();
    await chrome.tabs.update(hit.id, same ? { active } : { url, active });
    try {
      const win = await chrome.windows.get(hit.windowId);
      await chrome.windows.update(win.id, { focused: true });
    } catch {
    }
    return;
  }
  const created = await chrome.tabs.create({ url, active });
  if (active && created?.windowId !== void 0) {
    try {
      await chrome.windows.update(created.windowId, { focused: true });
    } catch {
    }
  }
}
const BADGE = {
  playing: { text: "\u25B6", color: "#16a34a" },
  busy: { text: "\u2026", color: "#f59e0b" },
  alert: { text: "!", color: "#dc2626" }
  // 登录态失效/过期
};
const DUE_COLOR = "#C98A3E";
const TOKENS_KEY = "mooc.vault.tokens";
const ACTIVE_KEY = "mooc.activeAccount";
const DUE_KEY = "mooc.dueSoon";
const ICON_SIZES = [16, 32, 48, 128];
const ICON_PATHS = {
  16: "/icon/16.png",
  32: "/icon/32.png",
  48: "/icon/48.png",
  128: "/icon/128.png"
};
const GREY_PATHS = {
  16: "/icon/grey-16.png",
  32: "/icon/grey-32.png",
  48: "/icon/grey-48.png",
  128: "/icon/grey-128.png"
};
let greyIcons = null;
async function buildGreyIcons() {
  if (greyIcons) return greyIcons;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return null;
    const out = {};
    for (const size of ICON_SIZES) {
      const res = await fetch(chrome.runtime.getURL(ICON_PATHS[size]));
      const bmp = await createImageBitmap(await res.blob());
      const cv = new OffscreenCanvas(size, size);
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bmp, 0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        d[i] = g;
        d[i + 1] = g;
        d[i + 2] = g;
        d[i + 3] = Math.round(d[i + 3] * 0.55);
      }
      out[size] = img;
    }
    greyIcons = out;
    return out;
  } catch {
    return null;
  }
}
import { isCourseDetailUrl as onCoursePage } from "./lib/links.js";
const idleTitle = async () => {
  let url = "";
  try {
    const [act] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = act?.url || "";
  } catch {
  }
  return onCoursePage(url) ? "\u70B9\u51FB\u5F00\u59CB\u81EA\u52A8\u5B66\u4E60\u672C\u8BFE\u7A0B/\u4E13\u9898" : "\u70DF\u8349\u7F51\u7EDC\u5B66\u9662\u5B66\u4E60\u52A9\u624B";
};
let uiSeq = 0;
async function paintChromeUi() {
  const seq = ++uiSeq;
  const got = await chrome.storage.local.get([TOKENS_KEY, AP.on, AP.status, ACTIVE_KEY, DUE_KEY]).catch(() => ({}));
  const need = await readNeedLogin();
  const apStatus = String(got?.[AP.status] || "");
  const ui = authUi({
    tokens: got?.[TOKENS_KEY],
    wall: need,
    activeKey: got?.[ACTIVE_KEY],
    apOn: !!got?.[AP.on],
    apPlaying: /播放中|续播/.test(apStatus)
  });
  if (seq !== uiSeq) return;
  try {
    if (ui.grey) {
      const imgs = await buildGreyIcons();
      await chrome.action.setIcon(imgs ? { imageData: imgs } : { path: GREY_PATHS });
    } else {
      await chrome.action.setIcon({ path: ICON_PATHS });
    }
  } catch {
  }
  if (seq !== uiSeq) return;
  scheduleExpiryCheck(got?.[TOKENS_KEY]);
  const due = got?.[DUE_KEY] || null;
  const dueN = Number(due?.n) || 0;
  if (seq !== uiSeq) return;
  try {
    if (ui.badge === "off") {
      if (!ui.grey && dueN > 0) {
        await chrome.action.setBadgeText({ text: String(dueN) });
        await chrome.action.setBadgeBackgroundColor({ color: DUE_COLOR });
        await chrome.action.setTitle({ title: `\u5FC5\u4FEE ${Number(due?.days) || 7} \u5929\u5185\u622A\u6B62 ${dueN} \u9879` });
        return;
      }
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: ui.grey ? ui.title : await idleTitle() });
      return;
    }
    const b = BADGE[ui.badge];
    await chrome.action.setBadgeText({ text: b.text });
    await chrome.action.setBadgeBackgroundColor({ color: b.color });
    if (seq !== uiSeq) return;
    if (ui.badge === "alert") await chrome.action.setTitle({ title: ui.title || "\u767B\u5F55\u6001\u5DF2\u5931\u6548 \xB7 \u70B9\u51FB\u91CD\u65B0\u767B\u5F55" });
    else await chrome.action.setTitle({ title: `\u81EA\u52A8\u5B66\u4E60\u4E2D \xB7 ${(apStatus || "\u8FD0\u884C\u4E2D").slice(0, 80)}` });
  } catch {
  }
}
function scheduleExpiryCheck(tokens, now = Date.now()) {
  const delay = nextExpiryDelay(tokens, now);
  if (delay === null) {
    void chrome.alarms.clear(EXPIRY_ALARM);
    return;
  }
  chrome.alarms.create(EXPIRY_ALARM, { when: now + delay });
}
let uiTimer = null;
const refreshChromeUi = () => {
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    uiTimer = null;
    void paintChromeUi();
  }, 60);
};
let uiCheckedAt = 0;
const maybeRefreshChromeUi = () => {
  if (Date.now() - uiCheckedAt < 6e4) return;
  uiCheckedAt = Date.now();
  refreshChromeUi();
};
  refreshChromeUi();
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === EXPIRY_ALARM) refreshChromeUi();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const watched = [TOKENS_KEY, NEED_LOGIN_KEY, AP.on, AP.status, ACTIVE_KEY, DUE_KEY];
    if (watched.some((k) => k in changes)) refreshChromeUi();
  });
  chrome.tabs.onActivated.addListener(() => {
    maybeRefreshChromeUi();
  });
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if ((info.url || info.status === "complete") && tab.active) maybeRefreshChromeUi();
  });
  chrome.action.onClicked.addListener((tab) => {
    if (STORE) return;
    refreshChromeUi();
    const url = tab?.url || "";
    void (async () => {
      const got = await chrome.storage.local.get([TOKENS_KEY, ACTIVE_KEY]).catch(() => ({}));
      const ui = authUi({ tokens: got?.[TOKENS_KEY], wall: await readNeedLogin(), activeKey: got?.[ACTIVE_KEY] });
      if (ui.grey) {
        void openConsoleLogin();
        return;
      }
      if (!onCoursePage(url)) {
        void openConsoleTab(consoleUrl());
        return;
      }
      const cur = await chrome.storage.local.get(AP.on);
      if (cur?.[AP.on]) {
        await chrome.storage.local.set({ [AP.on]: false, [AP.status]: "\u5DF2\u5173\u95ED\uFF08\u8BFE\u7A0B\u9875\u70B9\u51FB\u56FE\u6807\uFF09" });
        return;
      }
      await chrome.storage.local.set({
        [AP.on]: true,
        [AP.at]: Date.now(),
        [AP.status]: "\u503C\u5B88\u4E2D \xB7 \u5F53\u524D\u8BFE\u7A0B\u9875",
        ...tab?.id ? { [AP.tab]: tab.id } : {},
        ...String(got?.[ACTIVE_KEY] || "") ? { [AP.account]: String(got[ACTIVE_KEY]) } : {}
      });
      for (const upd of [{ pinned: true }, { muted: true }]) {
        try {
          await chrome.tabs.update(tab.id, upd);
        } catch {
        }
      }
    })();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "AUTOPILOT_NEED_LOGIN") return;
    void (async () => {
      try {
        await openConsoleLogin({ active: false });
      } catch {
      }
    })();
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "AUTOPILOT_TICK") return;
    // 驱动中的标签页会持续发 TICK: 把它的 tab.id 回写到 AP.tab, 修正 whoami 失败导致的 owner 缺失
    const tickTab = Number(sender?.tab?.id) || 0;
    if (tickTab > 0 && msg.playing) {
      void chrome.storage.local.get(AP.tab).then((g) => {
        if (Number(g?.[AP.tab]) !== tickTab) {
          return chrome.storage.local.set({ [AP.tab]: tickTab });
        }
      }).catch(() => {});
    }
    void (async () => {
      const got = await chrome.storage.local.get([TOKENS_KEY, ACTIVE_KEY]).catch(() => ({}));
      const need = await readNeedLogin();
      const ui = authUi({
        tokens: got?.[TOKENS_KEY],
        wall: need,
        activeKey: got?.[ACTIVE_KEY],
        apOn: true,
        apPlaying: !!msg.playing
      });
      if (ui.badge !== "playing" && ui.badge !== "busy") return;
      try {
        const b = BADGE[ui.badge];
        await chrome.action.setBadgeText({ text: b.text });
        await chrome.action.setBadgeBackgroundColor({ color: b.color });
        await chrome.action.setTitle({ title: `\u81EA\u52A8\u5B66\u4E60\u4E2D \xB7 ${String(msg.text || "\u8FD0\u884C\u4E2D").slice(0, 80)}` });
      } catch {
      }
    })();
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "AUTOPILOT_WHOAMI") return;
    sendResponse({ tabId: sender?.tab?.id ?? -1 });
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "AUTOPILOT_OPEN" || !msg.url) return;
    if (STORE) return;
    const fromConsole = String(sender?.url || "").includes("console.html");
    if (sender?.tab?.id && !fromConsole) {
      void (async () => {
        const got = await chrome.storage.local.get(AP.tab);
        const apTab = Number(got?.[AP.tab]) || 0;
        if (apTab && Number(sender.tab.id) !== apTab) return;
        void openCourseTab(String(msg.url));
      })();
      return;
    }
    void openCourseTab(String(msg.url));
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "AUTOPILOT_COURSE_DONE") return;
    if (STORE) return;
    void (async () => {
      const got0 = await chrome.storage.local.get(AP.tab);
      const apTab = Number(got0?.[AP.tab]) || 0;
      if (apTab && sender?.tab?.id && Number(sender.tab.id) !== apTab) return;
      const got = await chrome.storage.local.get([AP.queue]);
      const queue = got?.[AP.queue] || [];
      const next = queue[0];
      if (!next) {
        await chrome.storage.local.set({ [AP.on]: false, [AP.status]: "\u5168\u90E8\u8BFE\u7A0B\u5DF2\u5B8C\u6210 \u2713" });
        return;
      }
      const verified = msg.verified === true ? "\uFF08\u5E73\u53F0\u5DF2\u786E\u8BA4 100%\uFF09" : "";
      await chrome.storage.local.set({
        [AP.queue]: queue.slice(1),
        [AP.status]: `\u503C\u5B88\u4E2D \xB7 \u4E0B\u4E00\u8BFE: ${next.name || ""}${verified}`
      });
      await openCourseTab(next.url);
    })();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const got = await chrome.storage.local.get([AP.tab, AP.on]);
      if (Number(got?.[AP.tab]) !== Number(tabId)) return;
      await chrome.storage.local.remove(AP.tab);
      // 值守中的播放页被关闭(手动或意外): 停止值守并写明原因 —— 不自动重开标签页对抗用户,
      // 控制台/图标一键可重启; 否则开关仍是 true 而心跳已死, 表现为幽灵值守
      if (got?.[AP.on]) {
        await chrome.storage.local.set({ [AP.on]: false, [AP.status]: "值守已停止：播放页已关闭（重新点击图标可再次开启）" });
        refreshChromeUi();
      }
    })();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "TOKEN_CAPTURE" || !msg.token?.access_token) return;
    void (async () => {
      try {
        const got = await chrome.storage.local.get([TOKENS_KEY, ACTIVE_KEY, "mooc.awaitImport", "mooc.importSuppressed"]);
        const tokens = got?.[TOKENS_KEY] || {};
        const activeKey = got?.[ACTIVE_KEY] || Object.keys(tokens)[0];
        const cur = tokens[activeKey];
        // 已登出/已跳过自动导入: 不再收集令牌，避免明文副本长期驻留
        if (got?.["mooc.importSuppressed"]) return;
        // 已有有效登录态且不是「去官网登录」意图: 丢弃，否则每次官网心跳都会重写副本
        if (cur?.access_token && !got?.["mooc.awaitImport"]) return;
        await chrome.storage.local.set({ "mooc.capturedToken": { token: msg.token, at: Date.now() } });
      } catch { /* 存储不可用: 忽略 */ }
    })();
  });
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void openConsoleTab(consoleUrl({ onboard: true }), { active: true });
      return;
    }
    if (details.reason === "update") {
      const to = chrome.runtime.getManifest().version;
      const notice = updateNotice(details.previousVersion, to);
      if (notice) void chrome.storage.local.set({ [UPDATE_NOTICE_KEY]: notice });
    }
  });

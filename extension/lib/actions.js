import { createBrowserApi } from "./api.js";
import { resolveLibTotal } from "./search.js";
import { LIBRARY_TYPES, readAvailTypes, writeAvailTypes } from "./library.js";
import { recordTodayHours, todayUsed } from "./today.js";
import { dayStr, getHistory, recordHistoryDay } from "./history.js";
import { platformSsoUrl, ssoCourseUrl } from "./links.js";
import { allCreds, clearVault, dropCred, dropToken, formatTtl, putCred, tokenLifetimeLeft, tokenTtlMs } from "./vault.js";
import { GUARD_POLICY, loginStatus, recordAttempt, recordFailure, recordSuccess } from "./loginGuard.js";
import { isAuthRejection } from "./crypto.js";
import { STORE } from "./flags.js";
import { dueSoon } from "./deadline.js";
import { filterLibrary, keywordOf, recentNames } from "./recommend.js";
import { confirmAction, getState, go, setState, toast } from "./store.js";
import { NEED_LOGIN_KEY, clearNeedLogin } from "./needLogin.js";
import { UPDATE_NOTICE_KEY } from "./onUpdate.js";
import { LIB_BLOCK_PAGES, PAGE_SIZE, autopilotQueueOf, isAutopilotTarget } from "./core.js";
const __apiOverride = (() => {
  if (STORE) return void 0;
  try {
    return new URLSearchParams(location.search).get("api") || void 0;
  } catch {
    return void 0;
  }
})();
const api = createBrowserApi({ apiOrigin: __apiOverride });
let __lastExternalSync = 0;
api.subscribe((e) => {
  if (!e || e.type !== "state" || !e.external) return;
  const t = Date.now();
  if (t - __lastExternalSync < 500) return;
  __lastExternalSync = t;
  void loadState().catch(() => {
  });
});
const lastHourSelfByAccount = /* @__PURE__ */ new Map();
let __lastAccountKey = "";
const loadState = async () => {
  await loadLibraryCache();
  const d = await api.consoleApi.state();
  const ak = accountKey();
  if (__lastAccountKey && ak !== __lastAccountKey) invalidate("all");
  __lastAccountKey = ak;
  try {
    const g = globalThis;
    if (g.chrome?.storage?.local?.set && ak && ak !== "anon") void g.chrome.storage.local.set({ "mooc.activeAccount": ak });
  } catch {
  }
  setState({
    accounts: d.accounts || [],
    mode: d.mode || "auto",
    busy: d.busy || null,
    runs: d.runs || []
  });
  if (!(d.accounts || []).length) setState({ ready: false });
  else setState({ ready: true });
  void refreshAccountProfile();
};
function accountKey() {
  const s = api.state;
  return String(s?.activeKey || getState().accounts.find((a) => a.active)?.key || "anon");
}
const PROFILE_TTL = 6 * 60 * 60 * 1e3;
const ICS_TTL = 15 * 60 * 1e3;
const PROFILE_SYNC_KEY = "mooc.console.profileSyncAt.v1";
let icsCache = null;
function profileSyncAt(ak) {
  try {
    return Number(JSON.parse(localStorage.getItem(PROFILE_SYNC_KEY) || "{}")[ak] || 0);
  } catch {
    return 0;
  }
}
function markProfileSync(ak, at) {
  try {
    const m = JSON.parse(localStorage.getItem(PROFILE_SYNC_KEY) || "{}");
    m[ak] = at;
    localStorage.setItem(PROFILE_SYNC_KEY, JSON.stringify(m));
  } catch {
  }
}
function clearProfileSync() {
  try {
    localStorage.removeItem(PROFILE_SYNC_KEY);
  } catch {
  }
}
async function refreshAccountProfile(force = false) {
  const ak = accountKey();
  const now = Date.now();
  if (!force && now - profileSyncAt(ak) < PROFILE_TTL) return;
  markProfileSync(ak, now);
  try {
    const d = await api.consoleApi.syncProfile();
    if (d?.accounts?.length) setState({ accounts: d.accounts });
  } catch {
    markProfileSync(ak, 0);
  }
}
const loadOverview = async () => {
  const akSnapshot = String(getState().accounts.find((a) => a.active)?.key || "default");
  setState({ loading: true });
  try {
    const d = await api.consoleApi.overview();
    const akNow = String(getState().accounts.find((a) => a.active)?.key || "default");
    if (akNow !== akSnapshot) return;
    setState({
      hours: d.hours || {},
      rows: d.rows || [],
      mode: d.mode || getState().mode,
      busy: d.busy ?? getState().busy,
      error: ""
    });
    const hs = Number((d.hours || {}).hourSelf || 0);
    const ak = akSnapshot;
    const prev = lastHourSelfByAccount.has(ak) ? lastHourSelfByAccount.get(ak) : null;
    if (hs > 0) recordTodayHours(hs, prev === null ? void 0 : prev, ak);
    lastHourSelfByAccount.set(ak, hs);
    syncBadge();
    void loadLibraryRecs();
    const todayUsedHours = todayUsed(hs, ak);
    if (todayUsedHours > 0) recordHistoryDay(ak, dayStr(), todayUsedHours);
    void api.consoleApi.studyLog().then((days) => {
      if (!days?.length) return;
      const akNow2 = String(getState().accounts.find((x) => x.active)?.key || "default");
      if (akNow2 !== ak) return;
      const merged = { ...getHistory(ak) };
      let changed = false;
      for (const { day, sec } of days) {
        const h = Math.round(sec / 3600 * 100) / 100;
        if (h > (merged[day] ?? 0)) {
          merged[day] = h;
          changed = true;
        }
      }
      if (changed) setState({ history: merged });
    }).catch(() => {
    });
    setState({ history: getHistory(ak) });
  } catch (e) {
    setState({ error: e.message });
  } finally {
    setState({ loading: false });
  }
};
const isDemo = () => new URLSearchParams(location.search).get("demo") === "1";
function seedDemo() {
  const now = Date.now();
  setState({
    ready: true,
    loading: false,
    error: "",
    accounts: [
      { key: "demo-a", username: "13800000001", displayName: "\u5F20\u4E09", active: true },
      { key: "demo-b", username: "13800000002", displayName: "\u674E\u56DB", active: false }
    ],
    hours: { hourSelf: 12.5, requireCourseHour: 40, hourTrain: 6, requireClassHour: 90 },
    rows: [
      { type: "\u4E13\u9898", required: "\u5FC5\u4FEE", state: "\u5B66\u4E60\u4E2D", name: "\u70DF\u8349\u4E13\u5356\u7BA1\u7406\u5E08\u57FA\u7840\u77E5\u8BC6\u4E0E\u5B9E\u52A1\uFF08\u793A\u4F8B\u4E13\u9898\uFF09", bid: "b1f3c2d4e5a6978800112233", runnable: true, reg_ts: now - 864e5, push_ts: now - 3e5, url: "", endTime: now + 2.5 * 864e5 },
      { type: "\u8BFE\u7A0B", required: "\u5FC5\u4FEE", state: "\u672A\u5F00\u59CB", name: "\u6DF1\u5165\u8D2F\u5F7B\u884C\u4E1A\u9AD8\u8D28\u91CF\u53D1\u5C55\u8981\u6C42\uFF08\u793A\u4F8B\u8BFE\u7A0B\uFF09", bid: "c2a4d6e8f00123456789abcd", runnable: true, reg_ts: now - 864e5 * 2, push_ts: now - 9e5, url: "", endTime: now + 5 * 864e5 },
      { type: "\u8BFE\u7A0B", required: "\u9009\u4FEE", state: "\u672A\u5F00\u59CB", name: "\u7535\u5B50\u70DF\u7BA1\u7406\u529E\u6CD5\u89E3\u8BFB", bid: "d3b5e7f90123456789abcdef", runnable: true, reg_ts: now - 864e5 * 4, push_ts: now - 2e6, url: "" },
      { type: "\u4E13\u9898", required: "\u9009\u4FEE", state: "\u5B66\u4E60\u4E2D", name: "\u5B89\u5168\u751F\u4EA7\u6708\u4E13\u9898\u5B66\u4E60\uFF08\u793A\u4F8B\uFF09", bid: "e4c6a8b0123456789abcdef0", runnable: true, reg_ts: now - 864e5 * 6, push_ts: now - 4e6, url: "" },
      { type: "\u8BFE\u7A0B", required: "\u5FC5\u4FEE", state: "\u5DF2\u5B8C\u6210", name: "\u300A\u70DF\u8349\u4E13\u5356\u6CD5\u300B\u666E\u6CD5\u4E13\u9898", bid: "f5d7b9c123456789abcdef01", runnable: false, reg_ts: now - 864e5 * 9, push_ts: now - 7e6, url: "", endTime: now + 3 * 864e5 },
      { type: "\u8003\u8BD5", required: "\u2014", state: "\u672A\u5F00\u59CB", name: "\u4E13\u5356\u6267\u6CD5\u4EBA\u5458\u8D44\u683C\u8003\u8BD5", bid: "a6e8c0d23456789abcdef012", runnable: false, reg_ts: 0, push_ts: now - 1e6, url: "" },
      { type: "\u8C03\u7814", required: "\u2014", state: "\u5DF2\u8FC7\u671F", name: "\u5E74\u5EA6\u57F9\u8BAD\u9700\u6C42\u8C03\u7814\u95EE\u5377", bid: "b7f9d1e3456789abcdef0123", runnable: false, reg_ts: 0, push_ts: now - 8e6, url: "" },
      { type: "\u8BFE\u7A0B", required: "\u9009\u4FEE", state: "\u5DF2\u5B8C\u6210", name: "\u516C\u6587\u5199\u4F5C\u4E0E\u89C4\u8303\u5316\u529E\u6587", bid: "c8a0e2f456789abcdef01234", runnable: false, reg_ts: now - 864e5 * 12, push_ts: now - 9e6, url: "" }
    ],
    runs: [
      { id: "demo1", label: "\u5B66\u4E60 \u70DF\u8349\u4E13\u5356\u7BA1\u7406\u5E08\u57FA\u7840\u77E5\u8BC6\u4E0E\u5B9E\u52A1", account: "\u5F20\u4E09", startedAt: now - 36e5, endedAt: now - 33e5, status: "done" },
      { id: "demo2", label: "\u5B8C\u6210\u5168\u90E8\uFF08\u5F53\u65E5\u914D\u989D\u5DF2\u6EE1\uFF09", account: "\u674E\u56DB", startedAt: now - 72e5, endedAt: now - 7e6, status: "stopped" }
    ],
    history: (() => {
      const hist = {};
      for (let i = 0; i < 182; i++) {
        const d = new Date(now - i * 864e5);
        const dow = d.getDay();
        const base = i * 37 % 11 / 10;
        if (dow === 0 || dow === 6) hist[dayStr(d)] = Math.round((0.5 + base * 2) * 100) / 100;
        else if (dow === 2 || dow === 4) hist[dayStr(d)] = Math.round((0.3 + base) * 100) / 100;
        else if (i % 9 === 0) hist[dayStr(d)] = 0.5;
      }
      return hist;
    })(),
    logs: [
      { seq: 1, text: "[TUI] \u6A21\u5F0F auto | dry-run \u5173" },
      { seq: 2, text: "===== \u70DF\u8349\u4E13\u5356\u7BA1\u7406\u5E08\u57FA\u7840\u77E5\u8BC6\u4E0E\u5B9E\u52A1\uFF08\u793A\u4F8B\u4E13\u9898\uFF09 =====" },
      { seq: 3, text: "\u5C0F\u8282 6 \u4E2A | \u5DF2\u62A5\u540D true | \u6A21\u5F0F auto | \u5355\u6863 600s" },
      { seq: 4, text: "\u5F85\u5904\u7406 4 \u4E2A" },
      { seq: 5, text: "[1/4] (mp4) \u7B2C\u4E09\u7AE0 \u76D1\u7763\u7BA1\u7406\u4E0E\u6CD5\u5F8B\u8D23\u4EFB\uFF08\u4E0A\uFF09" },
      { seq: 6, text: "         -> OK \u5B8C\u6210, \u5171 4 \u8F6E / 2400s" },
      { seq: 7, text: "[2/4] (mp4) \u7B2C\u4E09\u7AE0 \u76D1\u7763\u7BA1\u7406\u4E0E\u6CD5\u5F8B\u8D23\u4EFB\uFF08\u4E0B\uFF09" },
      { seq: 8, text: "         -> FAIL \u4E0A\u62A5\u5931\u8D25 HTTP 409 \u670D\u52A1\u7AEF\u9650\u6D41" }
    ]
  });
}
const boot = async () => {
  const now0 = () => Date.now();
  if (isDemo()) {
    globalThis.__demoRun = true;
    globalThis.__demoSearch = [
      { id: "lib-1", name: "\u65B0\u4E00\u4EE3\u4EBA\u5DE5\u667A\u80FD\u6570\u636E\u6CBB\u7406", kind: "\u8BFE\u7A0B", typeId: 0, courseHour: 0.2 },
      { id: "lib-2", name: "\u65B0\u4E00\u4EE3\u4EBA\u5DE5\u667A\u80FD\u6280\u672F\u7279\u70B9\u548C\u6218\u7565\u4EF7\u503C", kind: "\u8BFE\u7A0B", typeId: 0, courseHour: 0.2 },
      { id: "lib-3", name: "AI\u8D4B\u80FD\u7ECF\u6D4E\uFF1A\u4ECE\u6548\u7387\u9769\u547D\u5230\u589E\u957F\u65B0\u52A8\u80FD", kind: "\u8BFE\u7A0B", typeId: 0, courseHour: 0.2 },
      { id: "lib-4", name: "\u4F9D\u6CD5\u52A0\u5F3A\u5BC4\u9012\u73AF\u8282\u76D1\u7BA1", kind: "\u8BFE\u7A0B", typeId: 0, courseHour: 2 },
      { id: "lib-5", name: "\u6D88\u9632\u5B89\u5168\u7BA1\u7406", kind: "\u8BFE\u7A0B", typeId: 0, courseHour: 2.3 },
      { id: "lib-6", name: "\u62CD\u597D\u5DE5\u4F5C\u7167\uFF0C\u624B\u673A\u5C31\u591F\u7528\u2014\u2014\u70DF\u6280\u5458\u624B\u673A\u6444\u5F71\u4E09\u62DB\u5F0F", kind: "\u8BFE\u7A0B", typeId: 0, courseHour: 0.3 },
      { id: "b1f3c2d4e5a6978800112233", name: "\u70DF\u8349\u4E13\u5356\u7BA1\u7406\u5E08\u57FA\u7840\u77E5\u8BC6\u4E0E\u5B9E\u52A1\uFF08\u793A\u4F8B\u4E13\u9898\uFF09", kind: "\u4E13\u9898", typeId: 2, courseHour: 6 },
      { id: "lib-7", name: "\u5BA1\u8BA1\u5B9E\u52A1\u4E0E\u5185\u63A7\u98CE\u9669\u5B66\u4E60\u4E13\u9898", kind: "\u4E13\u9898", typeId: 2, courseHour: 29 },
      { id: "lib-8", name: "\u667E\u6652\u70DF\u751F\u4EA7\u6280\u672F\u4E0E\u7BA1\u7406\u5B66\u4E60\u4E13\u9898", kind: "\u4E13\u9898", typeId: 2, courseHour: 24 },
      { id: "lib-9", name: "\u70DF\u8349\u6253\u5047\u6253\u79C1\u80FD\u529B\u63D0\u5347\u5B66\u4E60\u4E13\u9898", kind: "\u4E13\u9898", typeId: 2, courseHour: 5.4 },
      { id: "lib-10", name: "2026\u5E74\u5EA6\u70DF\u8349\u884C\u4E1A\u57F9\u8BAD\u6559\u6750\u5F00\u53D1\u4E0E\u4FEE\u8BA2\u4E13\u9898\u57F9\u8BAD", kind: "\u4E13\u9898", typeId: 2, courseHour: 16.4 },
      { id: "lib-11", name: "2026\u5E74\u5168\u7701\u7CFB\u7EDF\u4ECE\u4E1A\u4EBA\u5458\u5B89\u5168\u751F\u4EA7\u518D\u6559\u80B2\u7F51\u7EDC\u57F9\u8BAD", kind: "\u4E13\u9898", typeId: 2, courseHour: 12 }
    ];
    seedDemo();
    const rows = getState().rows.filter((r) => r.required === "\u5FC5\u4FEE" && r.state !== "\u5DF2\u5B8C\u6210" && r.state !== "\u5DF2\u8FC7\u671F");
    window.__demoCalendar = rows.map((r, i) => ({ businessId: r.bid, name: r.name, businessType: r.type === "\u4E13\u9898" ? 2 : 1, endTime: (r.push_ts || now0()) + 864e5 * (i + 3) }));
    return;
  }
  try {
    const creds = await allCreds();
    api.adoptCreds(creds);
    const fresh = await api.ensureFresh();
    ensureRenewTimer();
    if (fresh.needsLogin.length) toast("\u626B\u7801\u767B\u5F55\u7684\u8D26\u53F7\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801\u767B\u5F55", "err", 8e3);
    await loadState();
    connectStream();
    await refreshAll();
    watchVisibility();
    watchAutopilot();
    announceUpdate();
  } catch {
  }
};
function announceUpdate() {
  try {
    const g = globalThis;
    const ext = g.browser || g.chrome;
    if (!ext?.storage?.local?.get) return;
    ext.storage.local.get([UPDATE_NOTICE_KEY], (d) => {
      const n = d?.[UPDATE_NOTICE_KEY];
      if (!n?.to) return;
      toast(`\u5DF2\u66F4\u65B0\u5230 v${n.to}`, "ok");
      void ext.storage.local.remove(UPDATE_NOTICE_KEY);
    });
  } catch {
  }
}
let __visibilityBound = false;
function watchVisibility() {
  if (__visibilityBound || typeof document === "undefined") return;
  __visibilityBound = true;
  let last = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - last < 6e4) return;
    last = Date.now();
    invalidate("tasks");
    void refreshAll();
  });
}
let __renewTimer = null;
function ensureRenewTimer() {
  if (__renewTimer || isDemo()) return;
  __renewTimer = setInterval(() => {
    void api.ensureFresh().then((r) => {
      if (r.renewed.length) {
        toast("\u767B\u5F55\u6001\u5DF2\u81EA\u52A8\u7EED\u671F", "ok");
        void refreshAll();
      }
      if (r.failed.length) {
        toast("\u51ED\u636E\u6362\u53D1\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55", "err");
      }
      if (r.needsLogin.length) {
        toast("\u626B\u7801\u767B\u5F55\u7684\u8D26\u53F7\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801\u767B\u5F55", "err", 8e3);
      }
    }).catch(() => {
    });
  }, 6 * 36e5);
}
const AP_KEYS = { on: "mooc.autopilot", status: "mooc.autopilotStatus", ctx: "mooc.autopilotCtx", log: "mooc.autopilotLog" };
let __apBound = false;
let __apPoll = null;
let __apLastRefresh = 0;
let __apLastLogged = "";
let __apRunId = "";
async function apLog(text) {
  const ext = globalThis.browser || globalThis.chrome;
  try {
    const d = await ext?.storage?.local?.get?.([AP_KEYS.log]);
    const arr = Array.isArray(d?.[AP_KEYS.log]) ? d[AP_KEYS.log] : [];
    const t = (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
    arr.push({ seq: `ap-${Date.now()}`, text: `[\u503C\u5B88 ${t}] ${text}`, ...__apRunId ? { runId: __apRunId } : {} });
    await ext?.storage?.local?.set?.({ [AP_KEYS.log]: arr.slice(-300) });
  } catch {
  }
  api.say(`[\u503C\u5B88] ${text}`);
}
const AP_NOISY = /播放中|续播|等待|切换画质|处理平台弹窗|播放被拦截|播放停顿|等平台记账|已让位|值守中/;
function applyAp(on, status, ctx) {
  const next = { on: !!on, status: String(status || ""), at: Date.now(), ctx: ctx || null };
  const prev = getState().ap;
  const same = prev.on === next.on && prev.status === next.status && JSON.stringify(prev.ctx || {}) === JSON.stringify(next.ctx || {});
  if (next.on && __apRunId) api.apRun.pulse(__apRunId);
  // 值守换课/换节: 运行记录的操作名跟着当前视频走, 不再整场挂第一节课的名头
  if (next.on && __apRunId && next.ctx?.video) api.apRun.relabel(__apRunId, `值守 ${next.ctx.video}`);
  if (next.on && !prev.on) {
    const label = `\u503C\u5B88 ${next.ctx?.video || next.ctx?.subjectName || ""}`.trim();
    __apRunId = api.apRun.start(label || "\u65E0\u4EBA\u503C\u5B88\u5B66\u4E60");
    void apLog("\u503C\u5B88\u5F00\u542F");
  } else if (!next.on && prev.on) {
    // 结果按停止原因落: 登录态失效/异常 → 失败; 用户/系统主动停 → 停止; 队列自然播完 → 完成
    const verdict = /失效|失败|错误|过期/.test(next.status) ? "failed" : /停止|关闭/.test(next.status) ? "stopped" : "done";
    for (const r of (api.state.runs || []).filter((r2) => r2.status === "running" && /^值守/.test(r2.label))) {
      api.apRun.finish(r.id, verdict);
    }
    __apRunId = "";
  }
  // 让位进入沿只记一行(不带倒计时), 持续期由 AP_NOISY 静默 —— 事后审计可见, 又不刷屏
  const yieldRe = /已让位/;
  if (next.status && yieldRe.test(next.status) && !yieldRe.test(String(__apLastLogged))) {
    void apLog("值守让位：你手动暂停（90s 后自动恢复）");
  }
  if (next.status && next.status !== __apLastLogged && prev.at) {
    if (!next.on && prev.on) void apLog(`\u5DF2\u7ED3\u675F\uFF08\u6700\u540E\u72B6\u6001: ${next.status}\uFF09`);
    else if (next.on && !AP_NOISY.test(next.status)) void apLog(next.status);
  }
  if (next.status) __apLastLogged = next.status;
  if (same) return;
  setState({ ap: next });
  const t = Date.now();
  if (!next.on || t - __apLastRefresh > 6e4) {
    __apLastRefresh = t;
    invalidate("tasks");
    void refreshAll();
  }
  if (__apPoll) {
    clearInterval(__apPoll);
    __apPoll = null;
  }
  if (next.on) __apPoll = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (__apRunId) api.apRun.pulse(__apRunId);
    __apLastRefresh = Date.now();
    invalidate("tasks");
    void refreshAll();
  }, 9e4);
}
function watchAutopilot() {
  if (__apBound || isDemo()) return;
  __apBound = true;
  const ext = globalThis.browser || globalThis.chrome;
  if (!ext?.storage?.onChanged) return;
  ext.storage.local.get([AP_KEYS.on, AP_KEYS.status, AP_KEYS.ctx, AP_KEYS.log, NEED_LOGIN_KEY], (d) => {
    for (const e of (Array.isArray(d?.[AP_KEYS.log]) ? d[AP_KEYS.log] : []).slice(-80)) {
      api.say(e.text, e.runId || "");
    }
    applyAp(d?.[AP_KEYS.on], d?.[AP_KEYS.status], d?.[AP_KEYS.ctx]);
    applyNeedLogin(d?.[NEED_LOGIN_KEY], { quiet: true });
    if (api.reapStaleRuns() > 0) setState({ runs: [...api.state.runs || []] });
    if (!d?.[AP_KEYS.on]) {
      for (const r of (api.state.runs || []).filter((r2) => r2.status === "running" && /^值守/.test(r2.label))) {
        api.apRun.finish(r.id, "stopped");
      }
    }
  });
  ext.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (NEED_LOGIN_KEY in ch) applyNeedLogin(ch[NEED_LOGIN_KEY].newValue);
    if (!(AP_KEYS.status in ch) && !(AP_KEYS.on in ch) && !(AP_KEYS.ctx in ch)) return;
    applyAp(
      AP_KEYS.on in ch ? ch[AP_KEYS.on].newValue : getState().ap.on,
      AP_KEYS.status in ch ? ch[AP_KEYS.status].newValue : getState().ap.status,
      AP_KEYS.ctx in ch ? ch[AP_KEYS.ctx].newValue : getState().ap.ctx
    );
  });
}
function applyNeedLogin(raw, opts = {}) {
  const rec = raw && typeof raw === "object" ? raw : null;
  const at = Number(rec?.at);
  const next = rec && at > 0 ? { at, why: String(rec.why || "\u767B\u5F55\u6001\u5DF2\u5931\u6548"), ...rec.url ? { url: rec.url } : {}, ...rec.account ? { account: rec.account } : {}, ...rec.dismissed ? { dismissed: true } : {} } : null;
  const prev = getState().needLogin;
  if ((prev?.at || 0) === (next?.at || 0) && (prev?.why || "") === (next?.why || "")) return;
  setState({ needLogin: next });
  if (!next) return;
  if (!opts.quiet) {
    toast("\u503C\u5B88\u5DF2\u505C\u6B62\uFF1A\u767B\u5F55\u6001\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801\u6216\u8D26\u5BC6\u767B\u5F55", "err", 12e3);
    void apLog(`\u503C\u5B88\u5DF2\u505C\u6B62\uFF08\u767B\u5F55\u6001\u5931\u6548: ${next.why}\uFF09\xB7 \u8BF7\u91CD\u65B0\u626B\u7801\u6216\u8D26\u5BC6\u767B\u5F55`);
  }
}
async function dismissNeedLogin() {
  const cur = getState().needLogin;
  if (!cur) return;
  const next = { ...cur, dismissed: true };
  setState({ needLogin: next });
  try {
    const g = globalThis;
    await g.chrome?.storage?.local?.set?.({ "mooc.needLogin": next });
  } catch {
  }
}
let lastActiveDay = dayStr();
function checkDayRoll() {
  const d = dayStr();
  if (d !== lastActiveDay) {
    lastActiveDay = d;
    invalidate("tasks");
  }
}
const refreshAll = async () => {
  checkDayRoll();
  await Promise.all([loadState().catch(() => {
  }), loadOverview()]);
};
function connectStream() {
  if (getState().stream) return;
  const es = new api.EventSource("/api/stream");
  setState({ stream: es });
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "log") {
      const logs = [...getState().logs, { seq: msg.seq, text: msg.text, runId: msg.runId }];
      setState({ logs: logs.length > 4e3 ? logs.slice(-3e3) : logs });
    } else if (msg.type === "state") {
      const wasBusy = !!getState().busy;
      setState({ busy: msg.busy || null });
      if (wasBusy && !getState().busy) {
        toast("\u4EFB\u52A1\u5DF2\u7ED3\u675F", "ok");
        invalidate("tasks");
        void refreshAll();
      }
    }
  };
  es.onerror = () => {
    es.close?.();
    setState({ stream: null });
    setTimeout(() => {
      if (getState().ready) connectStream();
    }, 3e3);
  };
}
async function loadLibraryRecs() {
  const st = getState();
  if (!st.ready || !st.accounts.some((a) => a.active)) return;
  const names = recentNames(st.rows);
  if (!names.length) return;
  const seenNames = /* @__PURE__ */ new Set();
  const found = [];
  for (const name of names.slice(0, 2)) {
    const kw = keywordOf(name);
    if (!kw || seenNames.has(kw)) continue;
    seenNames.add(kw);
    try {
      const d = await api.consoleApi.search(kw, 0, 1, 20);
      found.push(...d.items || []);
    } catch {
    }
  }
  setState({ libraryRecs: filterLibrary(found, st.rows, 4) });
}
function syncBadge(days = 7) {
  try {
    const g = globalThis;
    if (!g.chrome?.storage?.local?.set) return;
    const list = dueSoon(getState().rows, { days });
    void g.chrome.storage.local.set({ "mooc.dueSoon": { n: list.length, days } });
  } catch {
  }
}
function onLoggedIn(d) {
  setState({ accounts: d.accounts, ready: true, loading: true, loginOpen: false, loginPrefill: "" });
  connectStream();
  go("overview");
  void refreshAll();
}
async function startRun(payload, label) {
  if (STORE) {
    toast("\u5546\u5E97\u7248\u4E0D\u63D0\u4F9B\u81EA\u52A8\u5316\u6267\u884C\u529F\u80FD", "err");
    return;
  }
  if (getState().busy) {
    toast(`\u5DF2\u6709\u4EFB\u52A1\u5728\u8FD0\u884C\uFF1A${getState().busy}`, "err");
    return;
  }
  const demo = isDemo();
  try {
    await api.consoleApi.run(payload);
    if (!demo) setState({ busy: label });
    toast(`\u5DF2\u542F\u52A8\uFF1A${label}\uFF08\u5E95\u90E8\u8FD0\u884C\u6761\u53EF\u770B\u65E5\u5FD7\uFF09`, "info");
  } catch (e) {
    toast(e.message, "err");
  }
}
const runCourse = (row) => startRun({ action: "course", bid: row.bid }, `\u5FEB\u5237 ${String(row.name).slice(0, 14)}`);
function runTodo() {
  const undone = getState().rows.filter((r) => r.state === "\u672A\u5F00\u59CB" || r.state === "\u5B66\u4E60\u4E2D");
  if (!undone.length) {
    toast("\u6CA1\u6709\u5F85\u5B66\u4EFB\u52A1", "info");
    return;
  }
  confirmAction(
    "\u4E00\u952E\u5B8C\u6210\u5F85\u5B66\u4EFB\u52A1",
    `\u5C06\u9010\u4E2A\u5B8C\u6210 ${undone.length} \u9879\u672A\u5F00\u59CB/\u5B66\u4E60\u4E2D\u7684\u8BFE\u7A0B\u4E0E\u4E13\u9898\uFF0C\u53EF\u80FD\u8017\u65F6\u8F83\u957F\u3002`,
    "\u5F00\u59CB\u6267\u884C",
    () => startRun({ action: "todo" }, "\u5FEB\u5237\u5F85\u5B66\u4EFB\u52A1")
  );
}
const submitHours = (v) => startRun({ action: "hours", hours: v }, `\u8865\u9F50\u5B66\u65F6 ${v}`);
async function exportBackup() {
  try {
    const d = await api.consoleApi.backup();
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "\u70DF\u8349\u7F51\u7EDC\u5B66\u9662\u5B66\u4E60\u52A9\u624B\u5907\u4EFD.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("\u5907\u4EFD\u5DF2\u5BFC\u51FA\uFF08\u4E0D\u542B\u5BC6\u7801\u4E0E token\uFF09", "ok");
  } catch (e) {
    toast(e.message || "\u5BFC\u51FA\u5931\u8D25", "err");
  }
}
async function importBackup(text) {
  try {
    const payload = JSON.parse(text);
    const r = await api.consoleApi.backupImport(payload);
    setState({ accounts: r.accounts, runs: r.runs });
    toast(`\u5DF2\u5BFC\u5165\uFF1A\u8D26\u53F7 +${r.addedAccounts}\uFF0C\u8BB0\u5F55 +${r.addedRuns}`, "ok");
    void refreshAll();
  } catch (e) {
    toast(`\u5BFC\u5165\u5931\u8D25\uFF1A${e.message || e}`, "err");
  }
}
function getCurrentToken() {
  const st = api.state;
  const key = st?.activeKey;
  return key ? st?.tokens?.[key] : null;
}
function tokenStatusOf(key) {
  const st = api.state;
  const token = key ? st?.tokens?.[key] : null;
  const wall = getState().needLogin;
  if (wall && wall.account === key) {
    return { leftMs: 0, ttlMs: token ? tokenTtlMs(token) : null, label: `\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08${wall.why}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55`, kind: "err" };
  }
  if (!token) return null;
  const left = tokenLifetimeLeft(token);
  const ttl = tokenTtlMs(token);
  const canRenew = !!st?.passwords?.[key];
  const qr = /^qr-/.test(String(token.source || ""));
  if (left == null) {
    return { leftMs: null, ttlMs: null, label: "\u767B\u5F55\u6001\u6709\u6548\u671F\u7531\u5E73\u53F0\u5224\u5B9A", kind: "ok" };
  }
  if (left <= 0) {
    return { leftMs: left, ttlMs: ttl, label: qr ? "\u767B\u5F55\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801" : "\u767B\u5F55\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55", kind: "err" };
  }
  const text = `\u767B\u5F55\u6001\u5269\u4F59 ${formatTtl(left)}`;
  const tail = canRenew ? "" : qr ? "\uFF08\u5230\u671F\u9700\u91CD\u65B0\u626B\u7801\uFF09" : "\uFF08\u5230\u671F\u9700\u91CD\u65B0\u767B\u5F55\uFF09";
  return { leftMs: left, ttlMs: ttl, label: `${text}${tail}`, kind: left < 864e5 ? "warn" : "ok" };
}
function openPlatformHome() {
  try {
    window.open("https://mooc.ctt.cn/", "_blank", "noopener,noreferrer");
  } catch {
  }
  try {
    const g = globalThis;
    void g.chrome?.storage?.local?.set?.({ "mooc.awaitImport": Date.now() });
  } catch {
  }
  toast("\u767B\u5F55\u5B8C\u6210\u540E\u56DE\u5230\u63A7\u5236\u53F0\uFF0C\u5B98\u7F51\u767B\u5F55\u6001\u4F1A\u81EA\u52A8\u5BFC\u5165", "info", 6e3);
}
function openPlatformLoggedIn() {
  const st = api.state;
  const key = st?.activeKey;
  const token = key ? st.tokens?.[key] : null;
  if (!token?.access_token) {
    toast("\u8BF7\u5148\u767B\u5F55/\u9009\u62E9\u4E00\u4E2A\u8D26\u53F7", "err");
    return;
  }
  const url = platformSsoUrl(token);
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
  }
  toast("\u5DF2\u7528\u5F53\u524D\u767B\u5F55\u6001\u6253\u5F00\u5B98\u7F51\uFF08\u4F1A\u9876\u6389\u8BE5\u8D26\u53F7\u5176\u5B83\u7AEF\u767B\u5F55\uFF09", "info", 5e3);
}
const AP = { on: "mooc.autopilot", queue: "mooc.autopilotQueue", status: "mooc.autopilotStatus", account: "mooc.autopilotAccount" };
const apStorage = () => globalThis.chrome?.storage?.local;
async function isAutopilotOn() {
  const s = apStorage();
  if (!s?.get) return false;
  const got = await s.get(AP.on);
  return !!got?.[AP.on];
}
async function stopAutopilot() {
  const s = apStorage();
  if (!s?.set) {
    toast("\u4EC5\u6269\u5C55\u73AF\u5883\u53EF\u7528", "err");
    return;
  }
  await s.set({ [AP.on]: false, [AP.status]: "\u5DF2\u5173\u95ED" });
  toast("\u81EA\u52A8\u5B66\u4E60\u5DF2\u5173\u95ED", "info");
}
function openAutopilotTab(url) {
  const rt = globalThis.chrome?.runtime;
  if (rt?.sendMessage) {
    try {
      rt.sendMessage({ type: "AUTOPILOT_OPEN", url }, () => void globalThis.chrome?.runtime?.lastError);
      return;
    } catch {
    }
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
  }
}
async function startAutopilot(list, opts = {}) {
  const s = apStorage();
  if (!s?.set) {
    toast("\u4EC5\u6269\u5C55\u73AF\u5883\u53EF\u7528", "err");
    return 0;
  }
  const token = getCurrentToken();
  if (!token?.access_token) {
    toast("\u8BF7\u5148\u767B\u5F55/\u9009\u62E9\u8D26\u53F7\uFF0C\u518D\u5F00\u542F\u65E0\u4EBA\u503C\u5B88", "err");
    return 0;
  }
  const ordered = autopilotQueueOf(list);
  const lead = opts.lead;
  const rows = lead ? [lead, ...ordered.filter((r) => String(r.bid) !== String(lead.bid))] : ordered;
  if (!rows.length) {
    toast("\u6CA1\u6709\u5F85\u5B66\u7684\u8BFE\u7A0B\u6216\u4E13\u9898", "info");
    return 0;
  }
  const queue = rows.map((r) => ({
    bid: r.bid,
    name: r.name,
    url: ssoCourseUrl({ bid: r.bid }, token, r.type === "\u4E13\u9898" ? 2 : 1)
  }));
  const accKey = getState().accounts.find((a) => a.active)?.key || "";
  await s.set({
    [AP.on]: true,
    [AP.queue]: queue,
    [AP.status]: `\u503C\u5B88\u4E2D \xB7 ${queue.length} \u95E8\u5F85\u5B66`,
    ...accKey ? { [AP.account]: accKey } : {}
  });
  const first = lead ? `\u4ECE\u300A${lead.name}\u300B\u5F00\u59CB` : "\u5FC5\u4FEE\u4F18\u5148";
  toast(`\u81EA\u52A8\u5B66\u4E60\u5DF2\u5F00\u542F\uFF1A${first}\uFF0C\u5171 ${queue.length} \u95E8\uFF08\u5DF2\u5E26\u5165\u767B\u5F55\u6001\uFF09`, "ok", 6e3);
  openAutopilotTab(queue[0].url);
  return queue.length;
}
async function startAutopilotFrom(row) {
  if (!isAutopilotTarget(row)) {
    toast("\u8BE5\u4EFB\u52A1\u4E0D\u53EF\u65E0\u4EBA\u503C\u5B88\u64AD\u653E", "info");
    return 0;
  }
  return startAutopilot(getState().rows || [], { lead: row });
}
async function startAutopilotFromLibrary(row) {
  if (!row?.id) {
    toast("\u8BE5\u5185\u5BB9\u6682\u4E0D\u652F\u6301\u7AD9\u5185\u64AD\u653E", "info");
    return 0;
  }
  const lead = {
    bid: String(row.id),
    name: String(row.name || ""),
    type: row.kind === "\u4E13\u9898" ? "\u4E13\u9898" : "\u8BFE\u7A0B",
    runnable: true,
    state: "\u672A\u5F00\u59CB",
    required: "",
    url: ""
  };
  return startAutopilot(getState().rows || [], { lead });
}
async function downloadCalendar() {
  try {
    const ak = accountKey();
    let ics;
    if (icsCache && icsCache.ak === ak && Date.now() - icsCache.at < ICS_TTL) {
      ics = icsCache.ics;
    } else {
      const d = await api.consoleApi.calendar();
      ics = d.ics;
      icsCache = { ak, ics, at: Date.now() };
    }
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mooc-\u5FC5\u4FEE\u4EFB\u52A1.ics";
    a.click();
    URL.revokeObjectURL(url);
    toast("\u65E5\u5386\u5DF2\u4E0B\u8F7D", "ok");
  } catch (e) {
    toast(e.message || "\u65E5\u5386\u5BFC\u51FA\u5931\u8D25", "err");
  }
}
async function switchAccount(key) {
  try {
    const d = await api.consoleApi.switchAccount(key);
    invalidate("all");
    setState({ accounts: d.accounts });
    try {
      const g = globalThis;
      if (g.chrome?.storage?.local?.set) void g.chrome.storage.local.set({ "mooc.activeAccount": key });
    } catch {
    }
    toast("\u5DF2\u5207\u6362\u8D26\u53F7", "ok");
    await refreshAll();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function addAccount(username, password, remember = false) {
  const st = loginStatus(username);
  if (!st.allowed) {
    throw new Error(st.waitMs > 6e4 ? `\u5DF2\u6682\u505C\u767B\u5F55\uFF1A\u8BE5\u8D26\u53F7\u5931\u8D25 ${st.fails} \u6B21\uFF0C\u4E3A\u907F\u514D\u88AB\u5E73\u53F0\u5C01\u7981\uFF08\u4E00\u5929\uFF09\uFF0C\u8BF7 ${Math.ceil(st.waitMs / 6e4)} \u5206\u949F\u540E\u518D\u8BD5` : `\u64CD\u4F5C\u8FC7\u5FEB\uFF1A\u8BF7 ${Math.ceil(st.waitMs / 1e3)} \u79D2\u540E\u518D\u63D0\u4EA4\uFF08\u5E73\u53F0\u9650\u5236\u767B\u5F55\u9891\u7387\uFF09`);
  }
  recordAttempt(username);
  let d;
  try {
    d = await api.consoleApi.addAccount(username, password);
  } catch (ex) {
    if (!isAuthRejection(ex)) throw ex;
    const r = recordFailure(username);
    const hint = r.left > 0 ? `\u5BC6\u7801\u9519\u8BEF ${r.fails} \u6B21\uFF0C\u8FD8\u53EF\u5C1D\u8BD5 ${r.left} \u6B21\u3002\u5E73\u53F0\u591A\u6B21\u5931\u8D25\u4F1A\u5C01\u7981\u8D26\u53F7\u4E00\u5929\uFF0C\u8BF7\u786E\u8BA4\u5BC6\u7801\u540E\u518D\u8BD5\u3002` : `\u5931\u8D25 ${r.fails} \u6B21\uFF0C\u5DF2\u4E34\u65F6\u6682\u505C\u767B\u5F55 ${Math.round(GUARD_POLICY.LOCK_MS / 6e4)} \u5206\u949F\uFF08\u907F\u514D\u8D26\u53F7\u88AB\u5E73\u53F0\u5C01\u7981\u4E00\u5929\uFF09\u3002`;
    const msg = String(ex.message || "");
    throw new Error(/90908|90105|422/.test(msg) ? `${hint}
\uFF08\u5E73\u53F0\u8FD4\u56DE\uFF1A\u8D26\u53F7\u6216\u5BC6\u7801\u4E0D\u6B63\u786E\uFF0C\u6216\u8BE5\u51FA\u53E3 IP \u88AB\u98CE\u63A7\uFF09` : `${msg}
${hint}`);
  }
  recordSuccess(username);
  if (remember) await putCred(username, password);
  setState({ accounts: d.accounts, ready: true, loading: true });
  connectStream();
  ensureRenewTimer();
  void refreshAll();
  return d;
}
async function removeAccount(key) {
  const d = await api.consoleApi.removeAccount(key);
  await dropCred(key);
  await dropToken(key);
  await clearNeedLogin(key).catch(() => {
  });
  try {
    const g = globalThis;
    const next = (d.accounts || []).find((a) => a.active)?.key || "";
    if (next) await g.chrome?.storage?.local?.set?.({ "mooc.activeAccount": next });
    else await g.chrome?.storage?.local?.remove?.(["mooc.activeAccount"]);
  } catch {
  }
  setState({ accounts: d.accounts });
}
async function clearCreds() {
  await clearVault();
  api.clearPasswords();
  await clearNeedLogin().catch(() => {
  });
  try {
    const g = globalThis;
    await g.chrome?.storage?.local?.set?.({
      "mooc.autopilot": false,
      "mooc.autopilotStatus": "",
      "mooc.dueSoon": { n: 0, days: 7 }
    });
    await g.chrome?.storage?.local?.remove?.([
      "mooc.autopilotAccount",
      "mooc.autopilotQueue",
      "mooc.autopilotTab",
      "mooc.autopilotCtx",
      "mooc.autopilotLog",
      "mooc.activeAccount"
    ]);
  } catch {
  }
  const st = api.state;
  if (st) {
    st.accounts = [];
    st.tokens = {};
    st.runs = [];
    st.activeKey = null;
  }
  setState({ accounts: [], runs: [], busy: null });
  toast("\u5DF2\u6E05\u9664\u672C\u673A\u4FDD\u5B58\u7684\u51ED\u636E", "ok");
}
async function logout() {
  const key = getState().accounts.find((a) => a.active)?.key;
  if (key) {
    await dropCred(key).catch(() => {
    });
    await dropToken(key).catch(() => {
    });
    await clearNeedLogin(key).catch(() => {
    });
  }
  try {
    const g = globalThis;
    await g.chrome?.storage?.local?.set?.({
      "mooc.autopilot": false,
      "mooc.autopilotStatus": "\u5DF2\u767B\u51FA\uFF0C\u503C\u5B88\u5DF2\u505C\u6B62",
      "mooc.dueSoon": { n: 0, days: 7 }
    });
    await g.chrome?.storage?.local?.remove?.(["mooc.autopilotAccount", "mooc.autopilotQueue", "mooc.autopilotTab", "mooc.activeAccount"]);
  } catch {
  }
  await api.consoleApi.logout().catch(() => {
  });
  try {
    await globalThis.chrome?.storage?.local?.set({ "mooc.importSuppressed": true });
  } catch {
  }
  invalidate("all");
  location.reload();
}
async function setSettings(patch) {
  try {
    const d = await api.consoleApi.settings(patch);
    setState({ mode: d.mode });
    toast("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "ok", 1800);
  } catch (e) {
    toast(e.message, "err");
  }
}
const CACHE_TTL = 6 * 60 * 60 * 1e3;
const CACHE_MAX = 240;
const PERSIST_KEY = "mooc.libCache.v1";
const PERSIST_MAX = 120;
const pageCache = /* @__PURE__ */ new Map();
const inflight = /* @__PURE__ */ new Map();
let queryGen = 0;
let cacheReady = null;
let saveTimer = null;
function loadLibraryCache() {
  if (cacheReady) return cacheReady;
  cacheReady = (async () => {
    try {
      const s = globalThis.chrome?.storage?.local;
      if (!s?.get) return;
      const raw = (await s.get(PERSIST_KEY))?.[PERSIST_KEY];
      if (!raw || typeof raw !== "object") return;
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (v && now - v.at < CACHE_TTL) pageCache.set(k, v);
      }
    } catch {
    }
  })();
  return cacheReady;
}
function persistCache() {
  const s = globalThis.chrome?.storage?.local;
  if (!s?.set) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = {};
      const now = Date.now();
      const ak = accountKey() + "\0";
      const all = [...pageCache.entries()];
      const entries = [...all.filter(([k]) => !k.startsWith(ak)), ...all.filter(([k]) => k.startsWith(ak))].slice(-PERSIST_MAX);
      for (const [k, v] of entries) if (now - v.at < CACHE_TTL) obj[k] = v;
      void s.set({ [PERSIST_KEY]: obj });
    } catch {
    }
  }, 400);
}
const pageKey = (ak, q, type, page) => `${ak}\0${q}\0${type}\0${page}`;
const blockKey = (ak, q, type, block, bp) => `${ak}\0${q}\0${type}\0b${block}:${bp}`;
const pagesPerBlock = (q) => q ? 1 : LIB_BLOCK_PAGES;
const blockOf = (page, bp) => Math.floor((page - 1) / bp) + 1;
function getCached(key) {
  const e = pageCache.get(key);
  if (!e) return void 0;
  if (Date.now() - e.at > CACHE_TTL) {
    pageCache.delete(key);
    return void 0;
  }
  return e.data;
}
function putCache(key, data) {
  pageCache.set(key, { data, at: Date.now() });
  if (pageCache.size > CACHE_MAX) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== void 0) pageCache.delete(oldest);
  }
  persistCache();
}
function requestBlock(ak, q, type, block, bp, gen) {
  const bk = blockKey(ak, q, type, block, bp);
  const hit = inflight.get(bk);
  if (hit) return hit;
  const p = api.consoleApi.search(q, type, block, PAGE_SIZE * bp).then((d) => {
    const items = d.items || [];
    const total = Number(d.total || 0) || items.length;
    if (gen === queryGen) {
      const first = (block - 1) * bp + 1;
      let cached = 0;
      for (let i = 0; i < bp; i++) {
        const slice = items.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
        if (!slice.length) break;
        putCache(pageKey(ak, q, type, first + i), { items: slice, total });
        cached++;
      }
      if (!cached) putCache(pageKey(ak, q, type, first), { items: [], total: 0 });
    }
    return total;
  }).finally(() => {
    inflight.delete(bk);
  });
  inflight.set(bk, p);
  return p;
}
async function probeLibraryTypes(force = false) {
  const ak = accountKey();
  if (!ak || ak === "anon") return null;
  if (!force) {
    const hit = readAvailTypes(ak);
    if (hit) return hit;
  }
  const queue = LIBRARY_TYPES.map((t) => t.id);
  const ok = [];
  const unknown = [];
  let failed = 0;
  const worker = async () => {
    for (let id = queue.shift(); id !== void 0; id = queue.shift()) {
      try {
        const d = await api.consoleApi.search("", id, 1, 1);
        const n = Number(d?.total) || (Array.isArray(d?.items) ? d.items.length : 0);
        if (n > 0) ok.push(id);
      } catch {
        failed++;
        unknown.push(id);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (failed >= 3) return null;
  const ids = [...ok, ...unknown].sort((a, b) => a - b);
  writeAvailTypes(ak, ids);
  return ids;
}
let searchSeq = 0;
async function doSearch(q, opts = {}) {
  const prev = getState();
  const ak = accountKey();
  const type = Number(opts.type ?? prev.libType ?? 0);
  const page = Math.max(1, Number(opts.page ?? 1));
  const bp = pagesPerBlock(q);
  const newQuery = q !== prev.searchQuery || type !== prev.libType;
  if (newQuery) queryGen++;
  const gen = queryGen;
  const paging = !!opts.paging && !newQuery;
  const seq = ++searchSeq;
  const pk = pageKey(ak, q, type, page);
  const cached = getCached(pk);
  setState({
    searchQuery: q,
    searching: !cached,
    libType: type,
    libPage: page,
    ...paging || cached ? {} : { searchRows: [], libTotal: 0 }
  });
  if (!cached) {
    try {
      await requestBlock(ak, q, type, blockOf(page, bp), bp, gen);
      if (bp > 1 && !getCached(pk)) await requestBlock(ak, q, type, page, 1, gen);
    } catch {
      if (seq !== searchSeq) return;
      setState({ ...paging ? { libPage: prev.libPage } : { searchRows: [], libTotal: 0 }, searching: false });
      if (!opts.silent) toast("\u641C\u7D22\u5931\u8D25", "err");
      return;
    }
  }
  if (seq !== searchSeq) return;
  const data = getCached(pk);
  const total = resolveLibTotal({ dataTotal: data?.total, hasData: !!data, newQuery, prevTotal: prev.libTotal });
  setState({ searchRows: data?.items || [], libTotal: total, searching: false });
  if (bp > 1 && (page - 1) % bp >= bp - 2 && page * PAGE_SIZE < (data?.total || 0)) {
    void requestBlock(ak, q, type, blockOf(page, bp) + 1, bp, gen).catch(() => {
    });
  }
}
function invalidate(scope = "all") {
  const all = scope === "all";
  if (all || scope === "library") {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pageCache.clear();
    inflight.clear();
    queryGen++;
    try {
      const s = globalThis.chrome?.storage?.local;
      void s?.remove?.(PERSIST_KEY);
    } catch {
    }
  }
  if (all || scope === "profile") clearProfileSync();
  if (all || scope === "tasks") icsCache = null;
}
function forceRefreshAll() {
  invalidate("all");
  void refreshAll();
  const s = getState();
  if (s.tasksTab === "library") {
    void doSearch(s.searchQuery, { type: s.libType, page: s.libPage, silent: true, paging: true });
  }
}
const DEMO_SECTIONS = (bid) => ({
  name: "\u793A\u4F8B\u8BFE\u7A0B",
  sections: [
    { section_id: "s1", resource_id: "r1", name: "\u7B2C\u4E00\u7AE0 \u603B\u5219\u4E0E\u7ACB\u6CD5\u76EE\u7684", type: 6, finish: 2, rate: 100 },
    { section_id: "s2", resource_id: "r2", name: "\u7B2C\u4E8C\u7AE0 \u70DF\u8349\u4E13\u5356\u8BB8\u53EF\u5236\u5EA6", type: 6, finish: 2, rate: 100 },
    { section_id: "s3", resource_id: "r3", name: "\u7B2C\u4E09\u7AE0 \u76D1\u7763\u7BA1\u7406\u4E0E\u6CD5\u5F8B\u8D23\u4EFB\uFF08\u4E0A\uFF09", type: 6, finish: 1, rate: 42 },
    { section_id: "s4", resource_id: "r4", name: "\u7B2C\u4E09\u7AE0 \u76D1\u7763\u7BA1\u7406\u4E0E\u6CD5\u5F8B\u8D23\u4EFB\uFF08\u4E0B\uFF09", type: 6, finish: 0, rate: 0 },
    { section_id: "s5", resource_id: "r5", name: "\u8BFE\u7A0B\u8BB2\u4E49\uFF08PDF\uFF09", type: 1, finish: 0, rate: 0 },
    { section_id: "s6", resource_id: "r6", name: "\u914D\u5957\u4E13\u9898\uFF1A\u884C\u4E1A\u9AD8\u8D28\u91CF\u53D1\u5C55", type: 10, finish: 0, rate: 0 }
  ]
});
async function openSections(row) {
  setState({ drawer: { name: row.name, bid: row.bid, sections: [], loading: true, err: "", stack: [] }, logOpen: false });
  if (isDemo()) {
    const d = DEMO_SECTIONS(row.bid);
    setState({ drawer: { ...getState().drawer, sections: d.sections, name: d.name, loading: false } });
    return;
  }
  try {
    const d = await api.consoleApi.sections(row.bid);
    const drawer = getState().drawer;
    if (!drawer) return;
    setState({ drawer: { ...drawer, sections: d.sections || [], name: d.name || row.name } });
  } catch (e) {
    const drawer = getState().drawer;
    if (drawer) setState({ drawer: { ...drawer, err: e.message } });
  } finally {
    const drawer = getState().drawer;
    if (drawer) setState({ drawer: { ...drawer, loading: false } });
  }
}
async function drillSection(sec) {
  const d = getState().drawer;
  if (!d) return;
  setState({
    drawer: {
      ...d,
      stack: [...d.stack, { name: d.name, bid: d.bid, sections: d.sections }],
      name: sec.name || "\u5173\u8054\u8BFE\u7A0B",
      bid: sec.resource_id || "",
      sections: [],
      loading: true,
      err: ""
    }
  });
  if (isDemo()) {
    const d2 = DEMO_SECTIONS(getState().drawer.bid);
    setState({ drawer: { ...getState().drawer, sections: d2.sections, name: d2.name, loading: false } });
    return;
  }
  try {
    const res = await api.consoleApi.sections(getState().drawer.bid);
    setState({ drawer: { ...getState().drawer, sections: res.sections || [], loading: false } });
  } catch (e) {
    setState({ drawer: { ...getState().drawer, err: e.message, loading: false } });
  }
}
const popDrawer = () => {
  const d = getState().drawer;
  if (!d) return;
  const prev = d.stack[d.stack.length - 1];
  setState({ drawer: { ...prev, stack: [], loading: false, err: "" } });
};
const closeDrawer = () => setState({ drawer: null });
export {
  accountKey,
  addAccount,
  api,
  boot,
  clearCreds,
  closeDrawer,
  connectStream,
  dismissNeedLogin,
  doSearch,
  downloadCalendar,
  drillSection,
  exportBackup,
  forceRefreshAll,
  getCurrentToken,
  importBackup,
  invalidate,
  isAutopilotOn,
  isDemo,
  loadLibraryCache,
  loadLibraryRecs,
  loadState,
  logout,
  onLoggedIn,
  openPlatformHome,
  openPlatformLoggedIn,
  openSections,
  popDrawer,
  probeLibraryTypes,
  refreshAccountProfile,
  refreshAll,
  removeAccount,
  runCourse,
  runTodo,
  setSettings,
  startAutopilot,
  startAutopilotFrom,
  startAutopilotFromLibrary,
  startRun,
  stopAutopilot,
  submitHours,
  switchAccount,
  syncBadge,
  tokenStatusOf,
  watchAutopilot
};

import { PlatformClient, QuotaExhausted, fetchProfile, login, setApiOrigin } from "./platform.js";
import { checkQr, issueQr, sessionKey, QR_INTERVAL_MS, QR_TTL_MS } from "./qr.js";
import { renderIcs } from "./ics.js";
import { getLedger, putLedger } from "./today.js";
import { allTokens, dropCred, dropToken, formatTtl, putTokens, renewWithinMs, tokenLifetimeLeft, tokenTtlMs } from "./vault.js";
import { mergeResults, splitQuery } from "./search.js";
import { isAuthRejection } from "./crypto.js";
import { clearNeedLogin, isLoginWallError, markNeedLogin } from "./needLogin.js";
import { STORE } from "./flags.js";
import { PAGE_SIZE } from "./core.js";
function detectApiOrigin() {
  const host = globalThis.location && globalThis.location.host || "";
  if (!host) return "";
  return /(^|\.)mooc\.ctt\.cn$/.test(host) ? "" : "https://mooc.ctt.cn";
}
const LS_KEY = ["mooc", "console", "state", "v1"].join(".");
const SS_KEY = ["mooc", "console", "pw", "v1"].join(".");
const json = (status, data) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(data),
  json: async () => data
});
function createBrowserApi({
  storage = globalThis.localStorage,
  sessionStore = globalThis.sessionStorage,
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  WebSocketImpl = globalThis.WebSocket,
  sleepFn,
  now = () => Date.now(),
  apiOrigin,
  win = typeof window !== "undefined" ? window : globalThis
} = {}) {
  setApiOrigin(apiOrigin === void 0 ? detectApiOrigin() : apiOrigin);
  const qrSessions = /* @__PURE__ */ new Map();
  const pruneQrSessions = (now2 = Date.now()) => {
    for (const [k, v] of qrSessions) if (now2 - Number(v.at || 0) > QR_TTL_MS * 2) qrSessions.delete(k);
    while (qrSessions.size > 200) qrSessions.delete(qrSessions.keys().next().value);
  };
  const reLoginFails = {};
  const state = {
    accounts: [],
    // [{ key, username, displayName, active }]
    tokens: {},
    // key -> token
    passwords: {},
    // key -> password (sessionStorage)
    mode: "auto",
    busy: null,
    runs: [],
    // [{ id, label, account, startedAt, endedAt?, status }]
    activeKey: null
  };
  let seq = 0;
  const logs = [];
  const subscribers = /* @__PURE__ */ new Set();
  let client = null;
  let stopHeartbeat = null;
  const TOMBSTONE_MS = 5 * 6e4;
  const tombstones = {};
  const dropTokenDeep = (key) => {
    delete state.tokens[key];
    tombstones[key] = Date.now();
    void dropToken(key).catch(() => {
    });
  };
  const flushTokens = async () => {
    try {
      const vault = await allTokens();
      const merged = { ...vault };
      for (const [k, t] of Object.entries(state.tokens || {})) {
        const tok = t;
        if (tok && tok.access_token) merged[k] = tok;
      }
      const now2 = Date.now();
      for (const [k, at] of Object.entries(tombstones)) {
        if (now2 - at < TOMBSTONE_MS) delete merged[k];
        else delete tombstones[k];
      }
      await putTokens(merged);
    } catch {
    }
  };
  const hydrateTokens = async () => {
    try {
      const vault = await allTokens();
      const vaultKeys = Object.keys(vault);
      if (vaultKeys.length) {
        state.tokens = { ...vault };
        storage.setItem(LS_KEY, JSON.stringify({
          accounts: state.accounts,
          tokens: state.tokens,
          mode: state.mode,
          runs: state.runs.slice(0, 100),
          activeKey: state.activeKey
        }));
      } else if (Object.keys(state.tokens || {}).length) {
        await flushTokens();
      }
    } catch {
    }
  };
  const save = () => {
    try {
      storage.setItem(LS_KEY, JSON.stringify({
        accounts: state.accounts,
        tokens: state.tokens,
        mode: state.mode,
        runs: state.runs.slice(0, 100),
        activeKey: state.activeKey
      }));
      sessionStore.setItem(SS_KEY, JSON.stringify(state.passwords));
      void flushTokens();
    } catch {
    }
  };
  const load = () => {
    try {
      const raw = storage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        state.accounts = d.accounts || [];
        state.tokens = d.tokens || {};
        state.mode = d.mode || "auto";
        state.runs = d.runs || [];
        state.activeKey = d.activeKey || state.accounts[0] && state.accounts[0].key || null;
        state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === state.activeKey }));
      }
      const pws = JSON.parse(sessionStore.getItem(SS_KEY) || "{}");
      state.passwords = pws || {};
    } catch {
    }
  };
  load();
  void hydrateTokens();
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("storage", (e) => {
      if (e && e.key !== void 0 && e.key !== null && e.key !== LS_KEY) return;
      load();
      emit({ type: "state", busy: state.busy, external: true });
    });
  }
  const activeAccount = () => state.accounts.find((a) => a.key === state.activeKey) || null;
  const emit = (event) => {
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
      }
    }
  };
  const say = (text, runId = "") => {
    const rid = runId || currentRunId;
    for (const line of String(text).split("\n")) {
      const event = { type: "log", seq: ++seq, text: line, runId: rid || void 0 };
      logs.push({ seq: event.seq, text: line, runId: rid || void 0 });
      if (logs.length > 2e3) logs.splice(0, logs.length - 2e3);
      emit(event);
    }
  };
  let currentRunId = "";
  const setBusy = (label) => {
    state.busy = label;
    if (!label) currentRunId = "";
    emit({ type: "state", busy: label, running: !!label });
  };
  const startRun = (label, account) => {
    const rec = {
      id: Math.random().toString(16).slice(2, 14),
      label,
      account,
      startedAt: now(),
      status: "running",
      pulseAt: now()
      // 心跳: 跑着的运行会定时刷新, 刷新停了才算「残影」
    };
    currentRunId = rec.id;
    state.runs.unshift(rec);
    if (state.runs.length > 100) state.runs.length = 100;
    save();
    return rec;
  };
  const finishRun = (rec, status) => {
    rec.endedAt = now();
    rec.status = status;
    delete rec.pulseAt;
    if (rec.id === currentRunId) currentRunId = "";
    save();
  };
  const reapStaleRuns = (maxIdle = 5 * 6e4) => {
    const cutoff = now() - maxIdle;
    let n = 0;
    for (const r of state.runs || []) {
      if (r.status !== "running") continue;
      const beat = Number(r.pulseAt) || Number(r.startedAt) || 0;
      if (beat > cutoff) continue;
      r.status = "stopped";
      r.endedAt = null;
      r.interrupted = true;
      delete r.pulseAt;
      n++;
    }
    if (n) save();
    return n;
  };
  const pulseRun = (id) => {
    const rec = (state.runs || []).find((r) => r.id === id);
    if (!rec || rec.status !== "running") return;
    rec.pulseAt = now();
    save();
  };
  /** 值守换课/换节时同步运行记录的操作名, 免得整场值守都挂着第一节课的名头 */
  const relabelRun = (id, label) => {
    const rec = (state.runs || []).find((r) => r.id === id);
    if (!rec || rec.status !== "running" || rec.label === label) return;
    rec.label = label;
    save();
    subscribers.forEach((fn) => fn());
  };
  const makeClient = () => {
    const acc = activeAccount();
    if (!acc) throw Object.assign(new Error("\u8BF7\u5148\u6DFB\u52A0\u5E76\u9009\u62E9\u4E00\u4E2A\u8D26\u53F7"), { status: 401 });
    const token = state.tokens[acc.key];
    if (!token) throw Object.assign(new Error("\u767B\u5F55\u6001\u5DF2\u5931\u6548, \u8BF7\u91CD\u65B0\u767B\u5F55"), { status: 401 });
    const cli = new PlatformClient({
      token,
      account: { key: acc.key, username: acc.username, password: state.passwords[acc.key] || "" },
      fetchImpl,
      say,
      mode: state.mode,
      WebSocketImpl,
      sleepFn,
      reLogin: async () => {
        const wall = (why) => {
          void markNeedLogin(why, { account: acc.key });
        };
        if (reLoginFails[acc.key]) {
          delete state.passwords[acc.key];
          save();
          wall("\u81EA\u52A8\u7EED\u671F\u5931\u8D25\uFF08\u5DF2\u505C\u6B62\u91CD\u8BD5\uFF09");
          throw new Error("\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08\u81EA\u52A8\u7EED\u671F\u5931\u8D25\uFF09\u3002\u8BF7\u5230\u300C\u8BBE\u7F6E\u2192\u8D26\u53F7\u300D\u9875\u79FB\u9664\u6B64\u8D26\u53F7\u540E\u91CD\u65B0\u6DFB\u52A0\uFF0C\u6216\u6539\u7528\u626B\u7801\u767B\u5F55");
        }
        const pw = state.passwords[acc.key];
        if (!pw) {
          const current = String(state.tokens[acc.key]?.access_token || "");
          if (current && current === String(token?.access_token || "")) wall("\u5E73\u53F0\u62D2\u7EDD\u4E86\u5F53\u524D\u4EE4\u724C");
          throw new Error("\u767B\u5F55\u6001\u5DF2\u5931\u6548, \u8BF7\u91CD\u65B0\u767B\u5F55");
        }
        say(`[\u51ED\u8BC1] ${acc.username} \u91CD\u65B0\u767B\u5F55 ...`);
        try {
          const tok = await login({ username: acc.username, password: pw, fetchImpl, accountKey: acc.key });
          state.tokens[acc.key] = { ...tok, obtainedAt: Date.now(), source: "password" };
          void clearNeedLogin(acc.key);
          reLoginFails[acc.key] = 0;
          save();
          return tok;
        } catch (e) {
          reLoginFails[acc.key] = 1;
          delete state.passwords[acc.key];
          dropTokenDeep(acc.key);
          void dropCred(acc.key).catch(() => {
          });
          markNeedLogin("\u81EA\u52A8\u91CD\u65B0\u767B\u5F55\u5931\u8D25\uFF08\u5DF2\u505C\u6B62\u91CD\u8BD5\uFF09", { account: acc.key });
          save();
          throw e;
        }
      }
    });
    cli.accountKey = acc.key;
    cli.tokenId = String(token?.access_token || "");
    return cli;
  };
  const noteAuthWall = (e, key, tokenId) => {
    const target = String(key || client?.accountKey || "");
    if (!target || !state.tokens[target]) return;
    const used = String(tokenId || client?.tokenId || "");
    if (used && String(state.tokens[target]?.access_token || "") !== used) return;
    if (!isLoginWallError(e)) return;
    const code = Number(e?.status) || 0;
    const why = code ? `\u5E73\u53F0\u63A5\u53E3\u8FD4\u56DE ${code}` : "\u5E73\u53F0\u62D2\u7EDD\u4E86\u5F53\u524D\u4EE4\u724C";
    void markNeedLogin(why, { account: target });
  };
  const withClient = async (fn) => {
    client = client || makeClient();
    const reqKey = String(client?.accountKey || "");
    const reqToken = String(client?.tokenId || "");
    client.mode = state.mode;
    try {
      return await fn(client);
    } catch (e) {
      noteAuthWall(e, reqKey, reqToken);
      throw e;
    } finally {
      client = null;
    }
  };
  const runAction = (body) => {
    if (state.busy) throw Object.assign(new Error(`\u5DF2\u6709\u4EFB\u52A1\u5728\u8DD1: ${state.busy}`), { status: 409 });
    const action = String(body.action || "");
    const label = action === "course" ? "\u5B66\u4E60\u8BFE\u7A0B" : action === "todo" ? "\u5B8C\u6210\u5168\u90E8" : action === "hours" ? "\u8865\u5B66\u65F6" : "";
    if (!label) throw Object.assign(new Error(`\u672A\u77E5\u64CD\u4F5C: ${action}`), { status: 400 });
    if (action === "course" && !body.bid) throw Object.assign(new Error("\u7F3A\u5C11 bid"), { status: 400 });
    const acc = activeAccount();
    setBusy(label);
    const rec = startRun(label, acc && (acc.displayName || acc.username) || "\u672A\u77E5\u8D26\u53F7");
    const pulseTimer = setInterval(() => pulseRun(rec.id), 3e4);
    (async () => {
      let bot = null;
      try {
        bot = makeClient();
        stopHeartbeat = action === "course" || action === "todo" ? bot.startHeartbeat({ intervalMs: 1e4 }) : null;
        if (action === "course") await bot.runCourse(String(body.bid), { syncOnly: !!body.sync });
        else if (action === "todo") await bot.runTodo();
        else await bot.runHours(body.hours === void 0 || body.hours === "" ? "auto" : body.hours);
        finishRun(rec, bot.stopReason ? "stopped" : "done");
      } catch (e) {
        if (stopHeartbeat) {
          stopHeartbeat();
          stopHeartbeat = null;
        }
        const quota = e instanceof QuotaExhausted || /配额/.test(e.message || "");
        say(`[\u9519\u8BEF] ${e.message || e}`);
        finishRun(rec, quota ? "stopped" : "failed");
      } finally {
        clearInterval(pulseTimer);
        if (stopHeartbeat) {
          stopHeartbeat();
          stopHeartbeat = null;
        }
        setBusy(null);
      }
    })();
    return label;
  };
  const route = async (method, path, query, body) => {
    if (method === "GET" && path === "/api/health") {
      return json(200, { ok: true, local: true, accounts: state.accounts.length, runs: state.runs.length });
    }
    if (method === "POST" && path === "/api/accounts") {
      const username = String(body && body.username || "").trim();
      const password = String(body && body.password || "");
      if (!username || !password) return json(400, { error: "\u8D26\u53F7\u4E0E\u5BC6\u7801\u90FD\u4E0D\u80FD\u4E3A\u7A7A" });
      let token;
      try {
        token = await login({ username, password, fetchImpl, accountKey: username });
      } catch (e) {
        say(`[\u767B\u5F55] ${username} \u5931\u8D25: ${e.message}`);
        return json(401, { error: `\u767B\u5F55\u5931\u8D25: ${e.message}`, errorCode: e.errorCode });
      }
      const profile = await fetchProfile(token, fetchImpl);
      const displayName = profile.displayName || void 0;
      const avatar = profile.avatar || void 0;
      const existing = state.accounts.find((a) => a.key === username);
      if (existing) Object.assign(existing, { displayName: displayName || existing.displayName, avatar: avatar || existing.avatar });
      else state.accounts.push({ key: username, username, displayName, avatar });
      state.tokens[username] = { ...token, obtainedAt: Date.now(), source: "password" };
      void clearNeedLogin(username);
      state.passwords[username] = password;
      state.activeKey = username;
      state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === username }));
      client = null;
      save();
      say(`[\u8D26\u53F7] \u5DF2\u767B\u5F55 ${displayName || username}`);
      return json(200, { accounts: state.accounts });
    }
    if (method === "POST" && path === "/api/logout") {
      const key = state.activeKey;
      if (key) {
        delete state.passwords[key];
        dropTokenDeep(key);
        void clearNeedLogin(key);
        state.accounts = state.accounts.filter((a) => a.key !== key);
        state.activeKey = state.accounts[0] && state.accounts[0].key || null;
        state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === state.activeKey }));
      }
      client = null;
      save();
      return json(200, { ok: true });
    }
    if (method === "GET" && path === "/api/state") {
      return json(200, {
        accounts: state.accounts,
        mode: state.mode,
        busy: state.busy,
        runs: state.runs
      });
    }
    if (method === "POST" && path === "/api/accounts/active") {
      const key = String(body && body.key || "");
      if (!state.accounts.some((a) => a.key === key)) return json(404, { error: "\u8D26\u53F7\u4E0D\u5B58\u5728" });
      state.activeKey = key;
      state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === key }));
      client = null;
      save();
      return json(200, { accounts: state.accounts });
    }
    if (method === "DELETE" && path.startsWith("/api/accounts/")) {
      const key = decodeURIComponent(path.slice("/api/accounts/".length));
      delete state.tokens[key];
      delete state.passwords[key];
      state.accounts = state.accounts.filter((a) => a.key !== key);
      if (state.activeKey === key) state.activeKey = state.accounts[0] && state.accounts[0].key || null;
      state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === state.activeKey }));
      client = null;
      save();
      return json(200, { accounts: state.accounts });
    }
    if (method === "POST" && path === "/api/settings") {
      if (body && body.mode !== void 0) {
        const mode = String(body.mode);
        if (!["auto", "audio", "video"].includes(mode)) return json(400, { error: "mode \u53EA\u80FD\u662F auto/audio/video" });
        state.mode = mode;
      }
      save();
      return json(200, { mode: state.mode });
    }
    if (method === "GET" && path === "/api/overview") {
      return withClient(async (bot) => {
        const hours = await bot.hoursSelf();
        const rows = await bot.allViewItems();
        return json(200, { hours, rows, mode: state.mode, busy: state.busy });
      });
    }
    if (method === "GET" && path === "/api/sections") {
      const bid = query.get("bid") || "";
      if (!bid) return json(400, { error: "\u7F3A\u5C11 bid" });
      return withClient(async (bot) => {
        const [det, sections] = await bot.openCourse(bid);
        return json(200, { name: det.name || "", sections });
      });
    }
    if (method === "GET" && path === "/api/qr/issue") {
      const kind = query.get("kind") === "wechat" ? "wechat" : "app";
      try {
        const key = sessionKey();
        const { uuid, png } = await issueQr(kind, { fetchImpl });
        pruneQrSessions();
        qrSessions.set(uuid, { kind, key, at: Date.now() });
        return json(200, { kind, uuid, png, ttl: QR_TTL_MS, interval: QR_INTERVAL_MS });
      } catch (e) {
        return json(502, { error: e.message });
      }
    }
    if (method === "POST" && path === "/api/adopt-session") {
      const token = body && body.token;
      if (!token || !token.access_token) return json(400, { error: "\u7F3A\u5C11 token" });
      const profile = await fetchProfile(token, fetchImpl);
      const displayName = profile.displayName;
      const avatar = profile.avatar || void 0;
      if (!displayName && !globalThis.__demoSearch) {
        return json(401, { error: "\u5BFC\u5165\u7684\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u6539\u7528\u626B\u7801\u6216\u8D26\u5BC6\u767B\u5F55" });
      }
      const key = String(token.userid || "") || displayName || "imported";
      const existing = state.accounts.find((x) => x.key === key);
      if (existing) Object.assign(existing, {
        displayName: displayName || existing.displayName,
        avatar: avatar || existing.avatar,
        username: displayName || existing.username
      });
      else state.accounts.push({ key, username: displayName || key, displayName, avatar });
      state.tokens[key] = { ...token, obtainedAt: Date.now(), source: "import" };
      void clearNeedLogin(key);
      state.activeKey = key;
      state.accounts = state.accounts.map((x) => ({ ...x, active: x.key === state.activeKey }));
      save();
      return json(200, { accounts: state.accounts, imported: true });
    }
    if (method === "POST" && path === "/api/profile/sync") {
      const acc = activeAccount();
      const token = acc && state.tokens[acc.key];
      if (!token?.access_token) return json(401, { error: "\u6682\u65E0\u6709\u6548\u767B\u5F55\u6001" });
      const profile = await fetchProfile(token, fetchImpl);
      const a = state.accounts.find((x) => x.key === state.activeKey);
      if (a && (profile.displayName || profile.avatar)) {
        Object.assign(a, {
          displayName: profile.displayName || a.displayName,
          avatar: profile.avatar || a.avatar
        });
        save();
      }
      return json(200, { accounts: state.accounts });
    }
    if (method === "GET" && path === "/api/qr/check") {
      const kind = query.get("kind") === "wechat" ? "wechat" : "app";
      const uuid = query.get("uuid") || "";
      const sess = qrSessions.get(uuid);
      if (!sess || sess.kind !== kind) return json(404, { error: "\u626B\u7801\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" });
      let r;
      try {
        r = await checkQr(kind, uuid, sess.key, { fetchImpl });
      } catch (e) {
        return json(502, { error: e.message });
      }
      if (r.error) {
        say(`[\u626B\u7801] ${r.error}${r.raw ? " \xB7 \u54CD\u5E94: " + r.raw : ""}`);
        return json(200, { done: false, error: r.error });
      }
      if (!r.done) return json(200, { done: false });
      const token = r.token;
      const profile = await fetchProfile(token, fetchImpl);
      const displayName = profile.displayName || void 0;
      const avatar = profile.avatar || void 0;
      const key = String(token.userid || "") || displayName || `qr-${kind}`;
      const existing = state.accounts.find((a) => a.key === key);
      if (existing) Object.assign(existing, { displayName: displayName || existing.displayName, avatar: avatar || existing.avatar });
      else state.accounts.push({ key, username: displayName || key, displayName, avatar });
      state.tokens[key] = { ...token, obtainedAt: Date.now(), source: `qr-${kind}` };
      void clearNeedLogin(key);
      state.activeKey = key;
      state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === key }));
      client = null;
      qrSessions.delete(uuid);
      save();
      say(`[\u8D26\u53F7] \u626B\u7801\u767B\u5F55\u6210\u529F ${displayName || key}\uFF08${kind === "app" ? "APP" : "\u5FAE\u4FE1"}\u901A\u9053\uFF09`);
      return json(200, { done: true, accounts: state.accounts });
    }
    if (method === "GET" && path === "/api/studylog") {
      try {
        return json(200, await withClient((bot) => bot.studyLogDays()) || []);
      } catch {
        return json(200, []);
      }
    }
    if (method === "GET" && path === "/api/calendar") {
      const demoTasks = globalThis.__demoCalendar;
      if (demoTasks) return json(200, { ics: renderIcs(demoTasks) });
      return withClient(async (bot) => json(200, { ics: renderIcs(await bot.listTasks()) }));
    }
    if (method === "GET" && path === "/api/backup") {
      const ledgers = {};
      for (const a of state.accounts) {
        const l = getLedger(a.key);
        if (l) ledgers[a.key] = l;
      }
      return json(200, {
        version: 1,
        exportedAt: now(),
        accounts: state.accounts.map((a) => ({ key: a.key, username: a.username, displayName: a.displayName })),
        activeKey: state.activeKey,
        runs: state.runs,
        ledgers
      });
    }
    if (method === "POST" && path === "/api/backup/import") {
      const p = body || {};
      let addedAccounts = 0;
      let addedRuns = 0;
      for (const a of Array.isArray(p.accounts) ? p.accounts : []) {
        if (!a || !a.key) continue;
        if (!state.accounts.some((x) => x.key === a.key)) {
          state.accounts.push({ key: a.key, username: a.username || a.key, displayName: a.displayName });
          addedAccounts += 1;
        }
      }
      for (const r of Array.isArray(p.runs) ? p.runs : []) {
        if (!r || !r.id) continue;
        if (!state.runs.some((x) => x.id === r.id)) {
          state.runs.push(r);
          addedRuns += 1;
        }
      }
      if (p.ledgers && typeof p.ledgers === "object") {
        for (const [k, v] of Object.entries(p.ledgers)) putLedger(k, v);
      }
      if (!state.accounts.some((a) => a.key === state.activeKey)) {
        state.activeKey = state.accounts[0] && state.accounts[0].key || null;
      }
      state.accounts = state.accounts.map((a) => ({ ...a, active: a.key === state.activeKey }));
      save();
      return json(200, { addedAccounts, addedRuns, accounts: state.accounts, runs: state.runs });
    }
    if (method === "GET" && path === "/api/search") {
      const q = (query.get("q") || "").trim();
      const type = Number(query.get("type") ?? -1);
      const page = Math.max(1, Number(query.get("page") || 1));
      const pageSize = Math.min(99999, Math.max(1, Number(query.get("pageSize") || PAGE_SIZE)));
      const demo = globalThis.__demoSearch;
      if (demo) {
        const kws = splitQuery(q);
        const pool = demo.filter((it) => type === -1 ? true : Number(it.typeId ?? 0) === type);
        const hits = kws.length ? pool.filter((it) => kws.some((k) => String(it.name || "").toLowerCase().includes(k.toLowerCase()))) : pool;
        const start = (page - 1) * pageSize;
        return json(200, { items: hits.slice(start, start + pageSize), total: hits.length, page, pageSize, type, demo: true });
      }
      return withClient(async (bot) => {
        const kws = splitQuery(q);
        if (!kws.length) {
          const r = await bot.searchPage({ keyword: "", type, page, pageSize });
          return json(200, { items: r.items, total: r.total, page, pageSize, type });
        }
        const lists = [];
        let total = 0;
        for (const kw of kws) {
          const r = await bot.searchPage({ keyword: kw, type, page, pageSize });
          lists.push(r.items);
          total = Math.max(total, r.total);
        }
        return json(200, { items: mergeResults(lists), total, page, pageSize, type });
      });
    }
    if (method === "POST" && path === "/api/run") {
      if (STORE) return json(403, { error: "\u5546\u5E97\u7248\u4E0D\u63D0\u4F9B\u81EA\u52A8\u5316\u6267\u884C\u529F\u80FD" });
      if (globalThis.__demoRun) {
        const a = body && body.action || "course";
        return json(202, { started: a, demo: true });
      }
      const label = runAction(body || {});
      return json(202, { started: label });
    }
    return json(404, { error: "Not found" });
  };
  const adapterFetch = async (path, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const url = new URL(path, "https://mooc.console.local/");
    let body;
    try {
      body = init.body ? JSON.parse(init.body) : void 0;
    } catch {
      body = void 0;
    }
    try {
      return await route(method, url.pathname, url.searchParams, body);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) say(`[\u9519\u8BEF] ${e.message || e}`);
      return json(status, { error: e.message || String(e) });
    }
  };
  class AdapterEventSource {
    constructor(_url) {
      this.onmessage = null;
      this.onerror = null;
      this._fn = (event) => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify(event) });
      };
      setTimeout(() => {
        for (const l of logs) this._fn({ type: "log", seq: l.seq, text: l.text, runId: l.runId });
        this._fn({ type: "state", busy: state.busy, running: !!state.busy });
        subscribers.add(this._fn);
      }, 0);
    }
    close() {
      subscribers.delete(this._fn);
    }
  }
  const call = async (method, path, query, body) => {
    const res = await route(method, path, query, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data && data.error || `\u8BF7\u6C42\u5931\u8D25 (HTTP ${res.status})`);
      e.status = res.status;
      e.errorCode = data && data.errorCode;
      e.body = data;
      throw e;
    }
    return data;
  };
  const qs = (pairs) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(pairs)) sp.append(k, String(v));
    return sp;
  };
  return {
    /** 具名操作: UI/Actions 的深接口（不再手拼字符串路径; fetch 面保留给测试/桩/demo） */
    consoleApi: {
      overview: () => call("GET", "/api/overview"),
      state: () => call("GET", "/api/state"),
      syncProfile: () => call("POST", "/api/profile/sync"),
      addAccount: (username, password) => call("POST", "/api/accounts", void 0, { username, password }),
      removeAccount: (key) => call("DELETE", `/api/accounts/${encodeURIComponent(key)}`),
      switchAccount: (key) => call("POST", "/api/accounts/active", void 0, { key }),
      logout: () => call("POST", "/api/logout"),
      settings: (patch) => call("POST", "/api/settings", void 0, patch),
      run: (payload) => call("POST", "/api/run", void 0, payload),
      search: (q, type = 0, page = 1, pageSize = PAGE_SIZE) => call("GET", "/api/search", qs({ q, type, page, pageSize })),
      sections: (bid) => call("GET", "/api/sections", qs({ bid })),
      qrIssue: (kind) => call("GET", "/api/qr/issue", qs({ kind })),
      qrCheck: (kind, uuid) => call("GET", "/api/qr/check", qs({ kind, uuid })),
      adoptSession: (token) => call("POST", "/api/adopt-session", void 0, { token }),
      calendar: () => call("GET", "/api/calendar"),
      studyLog: () => call("GET", "/api/studylog"),
      backup: () => call("GET", "/api/backup"),
      backupImport: (payload) => call("POST", "/api/backup/import", void 0, payload)
    },
    fetch: adapterFetch,
    EventSource: AdapterEventSource,
    state,
    /** 用保管箱里的密码补齐运行时密码（跨重启免重登） */
    adoptCreds(map) {
      for (const [k, pw] of Object.entries(map || {})) {
        if (state.accounts.some((a) => a.key === k) && !state.passwords[k]) state.passwords[k] = pw;
      }
      return Object.keys(state.passwords);
    },
    /**
     * 令牌到期前自动换发。
     *
     * 有效期**不是统一的 30 天**：账密登录、APP 扫码、微信扫码、官网导入各不相同，
     * 所以窗口按令牌实际的 expires_in 算（20%，封顶 7 天），不再用固定 7 天阈值 ——
     * 短寿命令牌否则会在登录后立刻被判「快到期」，每次启动都白登一次。
     *
     * 分类返回：
     *   · renewed    已用保管箱密码换到新令牌
     *   · failed     账密账号换发被拒（密码已失效，停止重试，避免触发平台封禁）
     *   · needsLogin 没有密码可换（扫码 / 导入）且令牌已过期 → 只能重新扫码
     * 寿命未知（官网导入的令牌没有 expires_in）时不做预判，交给接口 401 兜底。
     */
    async ensureFresh({ withinMs } = {}) {
      const renewed = [];
      const failed = [];
      const needsLogin = [];
      for (const acc of [...state.accounts]) {
        const token = state.tokens[acc.key];
        if (!token) continue;
        const left = tokenLifetimeLeft(token);
        if (left == null) continue;
        const within = withinMs ?? renewWithinMs(token) ?? 7 * 864e5;
        if (left > within) continue;
        const pw = state.passwords[acc.key];
        if (!pw) {
          if (left <= 0) {
            needsLogin.push(acc.key);
            void markNeedLogin("\u767B\u5F55\u51ED\u8BC1\u5DF2\u8FC7\u671F\uFF08\u65E0\u6CD5\u81EA\u52A8\u7EED\u671F\uFF09", { account: acc.key });
          }
          continue;
        }
        try {
          const fresh = await login({ username: acc.username, password: pw, fetchImpl, accountKey: acc.key });
          state.tokens[acc.key] = { ...fresh, obtainedAt: Date.now(), source: "password" };
          void clearNeedLogin(acc.key);
          reLoginFails[acc.key] = 0;
          renewed.push(acc.key);
          say(`[\u51ED\u636E] ${acc.displayName || acc.key} \u4EE4\u724C\u5DF2\u6362\u53D1\uFF08\u7EED ${formatTtl(tokenTtlMs(fresh))}\uFF09`);
        } catch (e) {
          const msg = String(e?.message || e);
          if (isAuthRejection(e)) {
            reLoginFails[acc.key] = 1;
            delete state.passwords[acc.key];
            dropTokenDeep(acc.key);
            void dropCred(acc.key).catch(() => {
            });
            void markNeedLogin("\u81EA\u52A8\u6362\u53D1\u5931\u8D25\uFF08\u5DF2\u505C\u6B62\u91CD\u8BD5\uFF09", { account: acc.key });
            failed.push(acc.key);
            say(`[\u51ED\u636E] ${acc.displayName || acc.key} \u6362\u53D1\u5931\u8D25: ${msg}\uFF08\u5DF2\u505C\u6B62\u81EA\u52A8\u91CD\u8BD5\uFF09`);
          } else {
            say(`[\u51ED\u636E] ${acc.displayName || acc.key} \u6362\u53D1\u5931\u8D25: ${msg}\uFF08\u7F51\u7EDC\u5F02\u5E38, \u4FDD\u7559\u51ED\u636E, \u7A0D\u540E\u91CD\u8BD5\uFF09`);
          }
        }
      }
      if (renewed.length || failed.length || needsLogin.length) save();
      return { renewed, failed, needsLogin };
    },
    /** 清空运行时密码（配合保管箱清理） */
    clearPasswords() {
      state.passwords = {};
      sessionStore.setItem(SS_KEY, "{}");
    },
    /** 订阅内部事件（external 标记表示来自其它标签页的同步） */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    logs,
    /** 测试/调试用: 注入日志 */
    say,
    /** 无人值守值守会话的运行记录: 开始/结束（持久化, 供「运行记录」列表展示） */
    apRun: {
      start(label) {
        const existing = state.runs.find((r) => r.status === "running" && /^值守/.test(r.label));
        if (existing) {
          currentRunId = existing.id;
          existing.pulseAt = now();
          return existing.id;
        }
        const acc = activeAccount();
        const rec = startRun(label, acc ? acc.displayName || acc.username : "");
        return rec.id;
      },
      /** 值守还活着: 蹬心跳, 免得被当成残影收尾 */
      pulse(id) {
        pulseRun(id);
      },
      relabel(id, label) {
        relabelRun(id, label);
      },
      finish(id, status) {
        const rec = state.runs.find((r) => r.id === id);
        if (rec) finishRun(rec, status);
      }
    },
    reapStaleRuns,
    stop() {
      if (stopHeartbeat) stopHeartbeat();
      subscribers.clear();
    }
  };
}
export {
  createBrowserApi
};

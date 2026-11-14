// ==UserScript==
// @name         烟草网络学院 · 快速刷课学习助手
// @namespace    https://github.com/moocctt/tobacco-mooc-study
// @version      0.0.1
// @license      MIT
// @homepageURL  https://github.com/moocctt/tobacco-mooc-study
// @supportURL   https://github.com/moocctt/tobacco-mooc-study/issues
// @description  快速模式刷课：按单档秒数回填开始时间、快速批量上报（600s/轮、轮间仅歇 1 秒），一门课几分钟刷完。与「无人值守学习助手」互斥运行。非官方工具，使用风险自担。
// @author       tobacco-mooc-study
// @match        https://mooc.ctt.cn/*
// @noframes
// @run-at       document-start
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4IiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCI+DQogIDwhLS0g5a2m5Lmg6L+b5bqm5Yqp5omLOiDlpb3lpYfnmoTkuabmnKwgKyDov5vluqbkuabnrb4gKOWvueixoS/liqjkvZwv5oOF57uqID0g5LmmICsg5ZCR5LiK6L+b5bqmICsg5aW95aWH5b6u56yRKSAtLT4NCiAgPGRlZnM+DQogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMC40IiB5Mj0iMSI+DQogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMxMjRBMzEiLz4NCiAgICAgIDxzdG9wIG9mZnNldD0iMC41NSIgc3RvcC1jb2xvcj0iIzFGNkY0QSIvPg0KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMkU4QjVGIi8+DQogICAgPC9saW5lYXJHcmFkaWVudD4NCiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InJpYmJvbiIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPg0KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjRkREQTM0Ii8+DQogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNDOThBM0UiLz4NCiAgICA8L2xpbmVhckdyYWRpZW50Pg0KICA8L2RlZnM+DQoNCiAgPCEtLSDog4zmma86IOWTgeeJjOe7vyAoZWRnZS10by1lZGdlLCDlnIbop5IpIC0tPg0KICA8cmVjdCB4PSIwIiB5PSIwIiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSJ1cmwoI2JnKSIvPg0KDQogIDwhLS0g5Lmm5pysOiDkuKTniYflpKflnIbop5LlnZcgKyDph43mj4/ovrksIOi9u+W+ruWAvuaWnCAtLT4NCiAgPGcgdHJhbnNmb3JtPSJyb3RhdGUoLTcgNjQgNjgpIj4NCiAgICA8IS0tIOS5puiEiihwYWdlIGJsb2NrKSAtLT4NCiAgICA8cmVjdCB4PSIzMCIgeT0iMzQiIHdpZHRoPSI3MCIgaGVpZ2h0PSI2MiIgcng9IjE2IiBmaWxsPSIjRThGMkVDIiBzdHJva2U9IiMxNjIxMUMiIHN0cm9rZS13aWR0aD0iNyIvPg0KICAgIDwhLS0g5bCB6Z2iIC0tPg0KICAgIDxyZWN0IHg9IjI0IiB5PSIyOCIgd2lkdGg9IjcwIiBoZWlnaHQ9IjYyIiByeD0iMTYiIGZpbGw9IiNGOEY2RjUiIHN0cm9rZT0iIzE2MjExQyIgc3Ryb2tlLXdpZHRoPSI3Ii8+DQogICAgPCEtLSDkuabpobXnur86IOS4gOadoeWuvee6v+WNs+WPr+WcqCAxNnB4IOWtmOa0uyAtLT4NCiAgICA8cGF0aCBkPSJNMzggNzYgaDMwIiBzdHJva2U9IiM4RkJGQTYiIHN0cm9rZS13aWR0aD0iNyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+DQogIDwvZz4NCg0KICA8IS0tIOi/m+W6puS5puetvijllK/kuIDphY3ku7YpOiAzLzQg6auYLCDlupXpg6jnh5XlsL4gLS0+DQogIDxnIHRyYW5zZm9ybT0icm90YXRlKC03IDY0IDY4KSI+DQogICAgPHBhdGggZD0iTTgwIDIyIGgxNiB2MzQgbC04IC03IC04IDcgeiIgZmlsbD0idXJsKCNyaWJib24pIiBzdHJva2U9IiMxNjIxMUMiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPg0KICA8L2c+DQoNCiAgPCEtLSDooajmg4U6IOWPjOecvCArIOWwj+W+rueskSjnlaXlgY8sIOW4puS4gOeCueWlveWlhykgLS0+DQogIDxnIHRyYW5zZm9ybT0icm90YXRlKC03IDY0IDY4KSI+DQogICAgPGNpcmNsZSBjeD0iNDkiIGN5PSI1MyIgcj0iNi40IiBmaWxsPSIjMTYyMTFDIi8+DQogICAgPGNpcmNsZSBjeD0iNzIiIGN5PSI1MSIgcj0iNi40IiBmaWxsPSIjMTYyMTFDIi8+DQogICAgPGNpcmNsZSBjeD0iNTEiIGN5PSI1MSIgcj0iMi4xIiBmaWxsPSIjRjhGNkY1Ii8+DQogICAgPGNpcmNsZSBjeD0iNzQiIGN5PSI0OSIgcj0iMi4xIiBmaWxsPSIjRjhGNkY1Ii8+DQogICAgPHBhdGggZD0iTTUyIDY1IHE3IDYgMTQgMiIgc3Ryb2tlPSIjMTYyMTFDIiBzdHJva2Utd2lkdGg9IjUuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIi8+DQogIDwvZz4NCjwvc3ZnPg0K
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==
(() => {
  // src/token.js
  function createTokenHunter({ log = () => {
  }, storage = typeof localStorage !== "undefined" ? localStorage : null } = {}) {
    const st = storage || { getItem: () => null };
    let token = null;
    let tokenWaiters = [];
    function setToken(v) {
      if (!v || v === token) return;
      token = v;
      log(`\u4EE4\u724C\u5DF2\u6355\u83B7 (${v.slice(-8)})`);
      const ws = tokenWaiters;
      tokenWaiters = [];
      ws.forEach((w) => w());
    }
    function waitToken(ms = 3e4) {
      if (token) return Promise.resolve();
      tokenFromStorage();
      if (token) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let entry = null;
        const t = setTimeout(() => {
          tokenWaiters = tokenWaiters.filter((w) => w !== entry);
          const e = new Error("\u672A\u6355\u83B7\u5230\u4EE4\u724C: \u9875\u9762\u672A\u53D1\u51FA\u5E26\u6388\u6743\u5934\u7684\u8BF7\u6C42, \u4E14 localStorage \u65E0\u4EE4\u724C");
          // 这就是「登录态失效」的一种：打上 auth 标记，runAll 才会报 authFailed，入口才不会误走自动刷新分支
          e.auth = true;
          reject(e);
        }, ms);
        entry = () => {
          clearTimeout(t);
          resolve();
        };
        tokenWaiters.push(entry);
      });
    }
    function tokenFromStorage() {
      try {
        const raw = st.getItem("token");
        if (!raw) return false;
        const obj = JSON.parse(raw);
        if (!obj || !obj.access_token) return false;
        const v = `${obj.token_type || "Bearer"}__${obj.access_token}`;
        if (v === token) return false;
        setToken(v);
        return true;
      } catch {
        return false;
      }
    }
    function installHooks(args = {}) {
      const win = args.win || globalThis;
      const XHR = args.XMLHttpRequest || win.XMLHttpRequest;
      const origFetch = args.fetch || win.fetch;
      if (!XHR || !origFetch) return;
      const origSetHeader = XHR.prototype.setRequestHeader;
      XHR.prototype.setRequestHeader = function(k, v) {
        try {
          if (/^authorization$/i.test(k) && /^Bearer/.test(String(v))) setToken(String(v));
        } catch {
        }
        return origSetHeader.call(this, k, v);
      };
      win.fetch = function(input, init) {
        try {
          const h = init && init.headers || input && input.headers;
          if (h) {
            const get = (k) => typeof h.get === "function" ? h.get(k) : h[k];
            const v = get("Authorization") || get("authorization");
            if (v && /^Bearer/.test(String(v))) setToken(String(v));
          }
        } catch {
        }
        return origFetch.apply(this, arguments);
      };
    }
    return { getToken: () => token, setToken, waitToken, tokenFromStorage, installHooks };
  }

  // src/constants.js
  var ORIGIN = "https://mooc.ctt.cn";
  var API = {
    LOGIN: "/oauth/api/v1/app-login",
    TASKS: "/api/v1/human/task",
    START: "/api/v1/course-study/course-front/start-progress",
    VIDEO: "/api/v1/course-study/course-front/video-progress",
    DOC: "/api/v1/course-study/course-front/doc-progress",
    PROGRESS_UPD: "/api/v1/course-study/course-front/course-progress-update",
    CHAPTERS: "/api/v1/course-study/subject/chapter-progress",
    REGISTER: "/api/v1/course-study/course-front/register",
    SECTION_PROGRESS: "/api/v1/course-study/course-front/course-section-progress",
    INFO: "/api/v1/course-study/course-front/info",
    REGISTER_STUDY: "/api/v1/course-study/course-front/registerStudy",
    MAX_STEP: 90
    // 单步上报上限（实测 ≥120s 会被平台静默丢弃）
  };
  var MEDIA = /* @__PURE__ */ new Set([5, 6]);
  var NESTED = 10;
  var SKIP = /* @__PURE__ */ new Set([4, 8, 9, 12, 13, 15]);
  var DONE = /* @__PURE__ */ new Set([2, 4]);
  var TYPE_NAME = { 1: "pdf", 2: "\u56FE\u7247", 3: "\u5916\u94FE", 4: "scorm", 5: "mp3", 6: "mp4", 7: "epub", 8: "\u4EFB\u52A1", 9: "\u8003\u8BD5", 10: "\u5173\u8054\u8BFE\u7A0B", 12: "\u95EE\u5377", 13: "\u8BC4\u4F30", 15: "\u8BFE\u4EF6" };

  // src/aes.js
  var KEY = new Uint8Array(16);
  for (let i = 0; i < 16; i++) KEY[i] = parseInt("64386367386756616b45713941677570".substr(i * 2, 2), 16);
  var SBOX = new Uint8Array(256);
  var rotl = (x, n) => (x << n | x >>> 8 - n) & 255;
  function mul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 128;
      a = a << 1 & 255;
      if (hi) a ^= 27;
      b >>= 1;
    }
    return p;
  }
  (function build() {
    function inv(a) {
      let r = 1;
      for (let i = 0; i < 8; i++) {
        r = mul(r, r);
        if (i < 7) r = mul(r, a);
      }
      return r;
    }
    for (let x = 0; x < 256; x++) {
      const v = x === 0 ? inv(0) : inv(x);
      SBOX[x] = v ^ rotl(v, 1) ^ rotl(v, 2) ^ rotl(v, 3) ^ rotl(v, 4) ^ 99;
    }
  })();
  function expandKey(key) {
    const w = new Uint8Array(176);
    w.set(key, 0);
    for (let i = 4; i < 44; i++) {
      let t = [w[i * 4 - 4], w[i * 4 - 3], w[i * 4 - 2], w[i * 4 - 1]];
      if (i % 4 === 0) t = [SBOX[t[1]] ^ rcon(i / 4), SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - 4) * 4 + j] ^ t[j];
    }
    return w;
  }
  function rcon(n) {
    let v = 1;
    for (let i = 1; i < n; i++) v = mul(v, 2);
    return v;
  }
  var RK = expandKey(KEY);
  function encryptBlock(inp, out, off) {
    const s = new Uint8Array(16), t = new Uint8Array(16);
    s.set(inp);
    for (let r = 0; r < 10; r++) {
      for (let i = 0; i < 16; i++) t[i] = s[i] ^ RK[r * 16 + i];
      for (let i = 0; i < 16; i++) s[i] = SBOX[t[i]];
      const sh = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
      for (let i = 0; i < 16; i++) t[i] = s[sh[i]];
      if (r < 9) {
        for (let c = 0; c < 4; c++) {
          const a = t.slice(c * 4, c * 4 + 4);
          s[c * 4 + 0] = mul(a[0], 2) ^ mul(a[1], 3) ^ a[2] ^ a[3];
          s[c * 4 + 1] = a[0] ^ mul(a[1], 2) ^ mul(a[2], 3) ^ a[3];
          s[c * 4 + 2] = a[0] ^ a[1] ^ mul(a[2], 2) ^ mul(a[3], 3);
          s[c * 4 + 3] = mul(a[0], 3) ^ a[1] ^ a[2] ^ mul(a[3], 2);
        }
      } else s.set(t);
    }
    for (let i = 0; i < 16; i++) out[off + i] = s[i] ^ RK[160 + i];
  }
  function encField(value) {
    const text = String(value);
    const raw = new TextEncoder().encode(text);
    const pad = 16 - raw.length % 16;
    const padded = new Uint8Array(raw.length + pad);
    padded.set(raw);
    padded.fill(pad, raw.length);
    const out = new Uint8Array(padded.length);
    for (let i = 0; i < padded.length; i += 16) encryptBlock(padded.subarray(i, i + 16), out, i);
    let bin = "";
    for (const b of out) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // src/fingerprint.js
  var DEVICES = [
    { brand: "Xiaomi", model: "23127PN0CC", android: 14 },
    { brand: "HUAWEI", model: "NOH-AN00", android: 12 },
    { brand: "OPPO", model: "PHA120", android: 13 },
    { brand: "vivo", model: "V2227A", android: 13 },
    { brand: "HONOR", model: "PGT-AN10", android: 13 },
    { brand: "realme", model: "RMX3706", android: 14 },
    { brand: "OnePlus", model: "PJD110", android: 14 },
    { brand: "Google", model: "Pixel 7", android: 14 },
    { brand: "samsung", model: "SM-S9180", android: 13 },
    { brand: "motorola", model: "XT2301-3", android: 13 }
  ];
  var SYSTEMS = ["Linux armv8l", "Linux aarch64"];
  function hash32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function fingerprintFor(seed) {
    const h = hash32(seed && String(seed).trim() ? String(seed).trim() : "default");
    const device = DEVICES[h % DEVICES.length];
    return { terminal: device.brand, system: SYSTEMS[(h >>> 8) % SYSTEMS.length] };
  }

  // src/util.js
  var rand = (a, b) => a + Math.random() * (b - a);
  var pystr = (v) => v === true ? "True" : v === false ? "False" : v === null || v === void 0 ? "" : String(v);
  function toParams(data) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(data || {})) if (v !== null && v !== void 0) sp.append(k, pystr(v));
    return sp;
  }
  var qs = (params) => toParams(params).toString();
  var form = (data) => toParams(data);

  // src/api.js
  var AUTH_CODES = /* @__PURE__ */ new Set([90901, 90902]);
  function createApi({ hunter: hunter2, gm: gm2, fetchImpl, log = () => {
  }, origin = ORIGIN, timeoutMs = 2e4 }) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    // 全链路无超时会让整批永远卡在一个请求上，这里统一加硬超时
    async function doFetchWithTimeout(url, init, ms = timeoutMs) {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      let timer = null;
      const guard = new Promise((_r, reject) => {
        timer = setTimeout(() => {
          if (ctl) ctl.abort();
          const e = new Error(`请求超时（${Math.round(ms / 1e3)}s）: ${url}`);
          e.timeout = true;
          reject(e);
        }, ms);
      });
      try {
        return await Promise.race([doFetch(url, ctl ? Object.assign({}, init, { signal: ctl.signal }) : init), guard]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function relogin() {
      const acc = gm2.getValue("account");
      if (!acc || !acc.username || !acc.password) return null;
      const fp = fingerprintFor(acc.username);
      const body = form({
        username: encField(acc.username),
        pword: encField(acc.password),
        // 换单位可在油猴菜单「设置单位名称」改（默认全行业）
        company_name: encField(gm2.getValue("companyName") || "\u5168\u884C\u4E1A"),
        login_method: encField("login-by-user"),
        client_id: encField(999),
        displayDynamic: encField(true),
        terminal: encField(fp.terminal),
        system: encField(fp.system),
        captcha: ""
      });
      const res = await doFetchWithTimeout(origin + API.LOGIN, {
        method: "POST",
        body,
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Accept: "application/json;charset=UTF-8" }
      });
      const text = await res.text();
      let data = null;
      if (text.trimStart().startsWith("{")) {
        try {
          data = JSON.parse(text);
        } catch {
        }
      }
      if (!data || !data.access_token) {
        log(`\u91CD\u767B\u5931\u8D25 (HTTP ${res.status})`);
        return null;
      }
      hunter2.setToken(`${data.token_type || "Bearer"}__${data.access_token}`);
      log("\u91CD\u767B\u6210\u529F");
      return data;
    }
    async function req(method, path, { params, data } = {}, retried = false) {
      await hunter2.waitToken();
      const url = origin + path + (params ? `?${qs(params)}` : "");
      const res = await doFetchWithTimeout(url, {
        method: method.toUpperCase(),
        body: data ? form(data) : void 0,
        credentials: "include",
        headers: { Authorization: hunter2.getToken(), Accept: "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }
      });
      const text = await res.text();
      let body = null;
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        try {
          body = JSON.parse(text);
        } catch {
        }
      }
      const authError = res.status === 401 || body && AUTH_CODES.has(body.errorCode);
      if (authError && !retried) {
        const before = hunter2.getToken();
        hunter2.tokenFromStorage();
        if (hunter2.getToken() && hunter2.getToken() !== before) {
          log("\u5DF2\u56DE\u8BFB localStorage \u4E2D\u7684\u65B0\u9C9C\u4EE4\u724C, \u91CD\u8BD5\u8BF7\u6C42");
          return req(method, path, { params, data }, true);
        }
        log("\u767B\u5F55\u6001\u5931\u6548, \u5C1D\u8BD5\u91CD\u767B\u2026");
        const nt = await relogin();
        if (nt) return req(method, path, { params, data }, true);
        const err = new Error("\u767B\u5F55\u6001\u5931\u6548\u4E14\u65E0\u4FDD\u5B58\u7684\u8D26\u5BC6/\u65B0\u9C9C\u4EE4\u724C \u2014\u2014 \u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5, \u6216\u5728\u6CB9\u7334\u83DC\u5355\u300C\u4FDD\u5B58\u8D26\u53F7\u5BC6\u7801\u300D\u540E\u91CD\u8BD5");
        err.auth = true;
        throw err;
      }
      if (authError) {
        const err = new Error(`登录态失效 (HTTP ${res.status}) —— 已重试仍失败, 请刷新页面重新登录`);
        err.auth = true;
        throw err;
      }
      return [res.status, body];
    }
    return { req, relogin };
  }

  // src/engine.js
  var QuotaExhausted = class extends Error {
  };
  function buildStartParams(backdateS, clientType, nowMs = Date.now()) {
    return { clientType, createTime: nowMs - Math.trunc(backdateS * 1e3) };
  }
  function parseRemaining(v) {
    if (v === null || v === void 0 || v === "") return { kind: "missing", value: null };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { kind: "invalid", value: v };
    return { kind: "number", value: n };
  }
  function normalizeReport(code, body) {
    const raw = body && body.errorCode;
    const ec = raw === null || raw === void 0 ? 0 : Number(raw);
    if (ec === 40909) return { status: "conflict", errorCode: ec };
    if (code !== 200) return { status: "fail", errorCode: ec, reason: `\u4E0A\u62A5\u5931\u8D25 HTTP ${code}` };
    if (!Number.isFinite(ec)) return { status: "fail", errorCode: raw, reason: `\u4E0A\u62A5\u5931\u8D25 errorCode ${raw}` };
    if (ec !== 0) return { status: "fail", errorCode: ec, reason: `\u4E0A\u62A5\u5931\u8D25 errorCode ${ec}` };
    return { status: "ok", errorCode: 0 };
  }
  function computeMaxRounds(total, step0, slack) {
    const t = Number(total), per = Math.min(Number(step0) || 0, API.MAX_STEP);
    const n = Math.ceil(t / per) + (Number(slack) || 0);
    return Number.isFinite(n) && n > 0 ? n : 5000;
  }
  function taskFilter(all) {
    return (all || []).filter((t) => [1, 2].includes(t.status) && [1, 2].includes(t.businessType) && !DONE.has(t.finishStatus) && !t.expired);
  }
  function sectionSkipped(type) {
    return SKIP.has(type);
  }
  function createEngine({ api: api2, state: state2, config: config2, log = () => {
  }, ui = () => {
  }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), lock: lock2 = null, currentBid: currentBid2 = () => "", playSection = null }) {
    async function undoneTasks() {
      const all = [];
      const seen = /* @__PURE__ */ new Set();
      for (let page = 1; page <= 50; page++) {
        const [code, body] = await api2.req("GET", API.TASKS, { params: { page, pageSize: 500, status: "", filterAuthExam: 1 } });
        if (code !== 200 || !body) throw new Error(`\u4EFB\u52A1\u5217\u8868\u8BF7\u6C42\u5931\u8D25 (HTTP ${code})`);
        const items = body.items || [];
        const before = all.length;
        for (const t of items) if (!seen.has(t.id)) {
          seen.add(t.id);
          all.push(t);
        }
        if (!items.length) break;
        if (page > 1 && all.length === before) break;
        if (body.total && all.length >= Number(body.total)) break;
      }
      return taskFilter(all);
    }
    async function sections(courseId, versionId, register) {
      const [code, body] = await api2.req("GET", API.CHAPTERS, { params: { courseId, versionId, isRegister: register } });
      if (code !== 200 || !Array.isArray(body)) throw new Error(`\u7AE0\u8282\u5217\u8868\u8BF7\u6C42\u5931\u8D25 (HTTP ${code})`);
      const out = [];
      for (const ch of body) {
        for (const sec of ch.courseChapterSections || []) {
          const p = sec.progress || {};
          out.push({
            id: sec.referenceId,
            rid: sec.resourceId,
            name: sec.sectionName || sec.name || "",
            type: sec.sectionType,
            finish: p.finishStatus ?? 0,
            studied: p.studyTotalTime || 0
          });
        }
      }
      return out;
    }
    async function openCourse(courseId) {
      const [code, det] = await api2.req("POST", API.REGISTER, { data: { courseId } });
      if (code !== 200 || typeof det !== "object" || !det) return openLibraryCourse(courseId);
      state2.versionId = det.versionId || "";
      state2.isRegister = !!det.register;
      return [det, await sections(courseId, det.versionId || "", det.register || false), false];
    }
    async function openLibraryCourse(courseId) {
      await api2.req("POST", API.REGISTER_STUDY, { data: { courseId, type: 1, isRequired: 0 } });
      state2.versionId = "";
      state2.isRegister = false;
      const [infoCode, det] = await api2.req("GET", `${API.INFO}/${courseId}`, { params: { source: 1, type: 1 } });
      if (infoCode !== 200 || !det) throw new Error(`\u8BFE\u7A0B\u4FE1\u606F\u8BF7\u6C42\u5931\u8D25 (HTTP ${infoCode})`);
      const secs = [];
      const map = { pdf: 1, image: 2, url: 3, scorm: 4, mp3: 5, mp4: 6, epub: 7, task: 8, exam: 9, other: 10, survey: 12, assessment: 13, kj: 15 };
      for (const ch of det && det.courseChapters || []) {
        for (const sec of ch.courseChapterSections || []) {
          const ft = String(sec.fileType || "").toLowerCase();
          secs.push({ id: sec.id, rid: sec.attachmentId, name: sec.name || sec.sectionName || "", type: map[ft] ?? 0, finish: 0, studied: 0 });
        }
      }
      return [Object.assign(det || {}, { _library: true }), secs, true];
    }
    async function startProgress(sectionId, backdateS, clientType) {
      const [code, body] = await api2.req("GET", `${API.START}/${sectionId}`, { params: buildStartParams(backdateS, clientType) });
      if (code !== 200 || !body || !body.id) return { ok: false, logId: null, rem: null, reason: `start-progress \u5931\u8D25 (HTTP ${code})` };
      return { ok: true, logId: body.id, rem: parseRemaining(body.remainingTime) };
    }
    async function progressUpdate(courseId) {
      await api2.req("POST", API.PROGRESS_UPD, { data: { encrypt: "false", courseId } });
    }
    async function settleNested(parentId, childId, sectionId, tries = 4) {
      await api2.req("POST", API.SECTION_PROGRESS, { data: { courseId: parentId, resourceIds: childId } });
      for (let i = 0; i < tries; i++) {
        if (state2.stopFlag) return false;
        const sp = await startProgress(sectionId, 300, 1);
        if (sp.ok) {
          const [, body] = await api2.req("POST", API.DOC, { data: { encrypt: "false", logId: sp.logId, lessonLocation: 999 } });
          if (body && DONE.has(body.finishStatus)) return true;
        }
        await sleep(rand(2500, 4e3));
      }
      const [, rows] = await api2.req("POST", API.SECTION_PROGRESS, { data: { courseId: parentId, resourceIds: childId } });
      return Array.isArray(rows) && rows.length ? DONE.has(rows[0].finishStatus) : false;
    }
    async function doSection(sec, { depth = 0, courseId, library = false } = {}) {
      if (SKIP.has(sec.type)) {
        const human = [9, 12, 13].includes(sec.type);
        return [false, `${TYPE_NAME[sec.type] || sec.type} ${human ? "\u9700\u771F\u5B9E\u4F5C\u7B54" : "\u6682\u65E0\u4E0A\u62A5\u534F\u8BAE"}, \u8DF3\u8FC7`];
      }
      if (DONE.has(sec.finish)) return [true, "\u5DF2\u5B8C\u6210, \u8DF3\u8FC7"];
      if (MEDIA.has(sec.type) && playSection) {
        state2.section = sec.name;
        return await playSection(sec, { courseId });
      }
      if (sec.type === NESTED) {
        if (depth >= 2) return [false, "\u5D4C\u5957\u8FC7\u6DF1, \u8DF3\u8FC7"];
        const parentCourse = state2.course;
        const parentVid = state2.versionId, parentReg = state2.isRegister;
        log(`\u21B3 \u5173\u8054\u8BFE\u7A0B ${sec.rid}`);
        const [done, total2] = await runCourse(sec.rid, depth + 1);
        state2.course = parentCourse;
        state2.versionId = parentVid;
        state2.isRegister = parentReg;
        if (done < total2) return [false, `\u5B50\u8BFE\u7A0B\u672A\u5B8C\u6210 ${done}/${total2}`];
        const settled = await settleNested(courseId, sec.rid, sec.id);
        return [settled, settled ? "\u5B50\u8BFE\u7A0B\u5B8C\u6210, \u7236\u8BB0\u5F55\u5DF2\u7ED3\u7B97" : "\u5B50\u8BFE\u7A0B\u5B8C\u6210, \u7236\u8BB0\u5F55\u7ED3\u7B97\u672A\u786E\u8BA4(\u7A0D\u540E\u590D\u6838)"];
      }
      const step0 = config2.getStep();
      let total = null, submitted = 0, prevRem = null, stuck = 0, maxRounds = 0, conflicts = 0;
      for (let i = 0; ; i++) {
        if (state2.stopFlag) return [false, "\u5DF2\u505C\u6B62"];
        if (maxRounds && i >= maxRounds) return [false, `\u8F6E\u6B21\u7528\u5B8C (\u5DF2\u63D0\u4EA4 ${submitted}s)`];
        state2.round = i + 1;
        // 记录本轮起点：本轮网络耗时要从等待里扣掉，否则节奏不是 1:1（越慢的网络睡得越久）
        const roundStart = Date.now();
        const sp = await startProgress(sec.id, config2.backdateS(step0), library ? 0 : 1);
        if (!sp.ok) return [false, sp.reason];
        const logId = sp.logId;
        if (sp.rem.kind === "missing") {
          const progress = submitted || Number(sec.studied) || 0;
          return progress ? [true, `\u5B8C\u6210\uFF08\u5DF2\u4E0A\u62A5 ${progress}s\uFF0C\u65E0\u5269\u4F59\u65F6\u957F\uFF09`] : [false, "start-progress \u65E0 remainingTime \u5B57\u6BB5"];
        }
        if (sp.rem.kind === "invalid") return [false, `remainingTime \u5F02\u5E38: ${String(sp.rem.value)}`];
        const rem = sp.rem.value;
        if (rem <= 0) {
          if (submitted || sec.studied) return [true, `\u65F6\u957F\u5DF2\u7528\u5B8C\uFF08\u5171 ${submitted}s\uFF09`];
          return [true, "\u8BE5\u5C0F\u8282\u65E0\u5269\u4F59\u65F6\u957F"];
        }
        if (prevRem !== null && rem >= prevRem) {
          stuck += 1;
          if (stuck >= 2) throw new QuotaExhausted(`\u5269\u4F59\u65F6\u957F\u672A\u4E0B\u964D (${prevRem}\u2192${rem}) \u2014\u2014 \u5224\u5B9A\u5F53\u65E5\u5B66\u65F6\u914D\u989D\u5DF2\u6EE1`);
        } else stuck = 0;
        prevRem = rem;
        if (total === null) {
          total = rem + (Number(sec.studied) || 0);
          maxRounds = computeMaxRounds(total, step0, config2.roundsSlack);
        }
        const step = Math.min(step0, rem, API.MAX_STEP);
        const isMedia = MEDIA.has(sec.type);
        const [code, body] = isMedia ? await api2.req("POST", API.VIDEO, { data: { encrypt: "false", logId, studyTime: Math.trunc(step), lessonLocation: Math.trunc(Math.min(total, total - rem + step)), resourceTotalTime: Math.trunc(total), flush: "false" } }) : await api2.req("POST", API.DOC, { data: { encrypt: "false", logId, lessonLocation: 999 } });
        const rep = normalizeReport(code, body);
        if (rep.status === "conflict") {
          conflicts += 1;
          if (conflicts > 20) return [false, "\u5E76\u53D1\u51B2\u7A81(40909)\u91CD\u8BD5\u8FC7\u591A, \u5DF2\u653E\u5F03\u8BE5\u5C0F\u8282"];
          i -= 1;
          await sleep(Math.min(1e3 * conflicts, 5e3));
          continue;
        }
        if (rep.status !== "ok") return [false, rep.reason];
        conflicts = 0;
        submitted += step;
        state2.submitted = submitted;
        if (courseId) await progressUpdate(courseId);
        ui();
        await sleep(Math.max(0, config2.roundSleepMs(step) - (Date.now() - roundStart)));
      }
    }
    async function runCourse(courseId, depth = 0) {
      const managed = !state2.running;
      if (managed) {
        state2.running = true;
        state2.stopFlag = false;
      }
      try {
        return await runCourseInner(courseId, depth);
      } finally {
        if (managed) state2.running = false;
      }
    }
    async function runCourseInner(courseId, depth = 0) {
      if (config2.canStart && !config2.canStart()) {
        log(`\u26D4 \u68C0\u6D4B\u5230\u5176\u4ED6\u6807\u7B7E\u9875\u6B63\u5728\u5B66\u4E60, \u8DF3\u8FC7\u300C${String(courseId).slice(0, 8)}\u2026\u300D(\u9632\u591A\u5F00)`);
        return [0, 1];
      }
      const [det, secs, library] = await openCourse(courseId);
      const name = det && det.name || courseId;
      state2.course = name;
      log(`===== ${name} =====`);
      const todo = secs.filter((s) => !DONE.has(s.finish));
      log(`\u5C0F\u8282 ${secs.length} \u4E2A, \u5F85\u5904\u7406 ${todo.length}`);
      if (!secs.length) {
        log("\u26A0 \u7AE0\u8282\u5217\u8868\u4E3A\u7A7A(\u63A5\u53E3\u5F02\u5E38\u6216\u8BFE\u7A0B\u65E0\u5C0F\u8282), \u6309\u672A\u5B8C\u6210\u5904\u7406");
        return [0, 1];
      }
      let ok = 0, skipped = 0;
      for (let i = 0; i < todo.length; i++) {
        if (state2.stopFlag) break;
        const sec = todo[i];
        state2.section = `${i + 1}/${todo.length} (${TYPE_NAME[sec.type] || sec.type}) ${String(sec.name).slice(0, 30)}`;
        state2.round = 0;
        state2.submitted = 0;
        ui();
        log(`[${i + 1}/${todo.length}] ${state2.section}`);
        try {
          const [good, msg] = await doSection(sec, { depth, courseId, library });
          if (good) ok += 1;
          else if (SKIP.has(sec.type)) skipped += 1;
          log(`   \u2192 ${msg}`);
        } catch (e) {
          if (e instanceof QuotaExhausted) {
            if (depth === 0) log("[\u914D\u989D] " + e.message + ", \u7EC8\u6B62\u5168\u90E8");
            throw e;
          }
          if (e.auth) throw e;
          log(`   \u2717 ${e.message}`);
        }
      }
      return [ok, todo.length - skipped];
    }
    async function runAll() {
      const owner = lock2 ? lock2.lockOwner() : "";
      if (owner || state2.running) {
        log(`\u2717 ${owner || "\u5F53\u524D\u4EFB\u52A1"}\u6B63\u5728\u8FD0\u884C, \u8BF7\u5148\u505C\u6B62\u5B83`);
        return { quotaHit: false, ok: false, authFailed: false };
      }
      if (lock2) lock2.acquire();
      state2.running = true;
      state2.stopFlag = false;
      ui();
      let failCount = 0, quotaHit = false;
      const bid = currentBid2();
      const mode = bid ? "course" : "tasks";
      try {
        if (bid) {
          log(`\u5F53\u524D\u4E3A\u8BFE\u7A0B/\u4E13\u9898\u9875 \u2192 ${config2.coursePageLabel}`);
          try {
            const [ok, total] = await runCourse(bid);
            if (state2.stopFlag) log(`\u25A0 \u5DF2\u505C\u6B62 (${ok}/${total})`);
            else if (ok < total) {
              failCount += 1;
              log(`\u26A0 \u672A\u5B8C\u6210 (${ok}/${total})`);
            }
          } catch (e) {
            if (e instanceof QuotaExhausted) quotaHit = true;
            else if (e.auth) throw e;
            else {
              failCount += 1;
              log(`\u2717 \u8BFE\u7A0B\u5931\u8D25: ${e.message}`);
            }
          }
        } else {
          const tasks = await undoneTasks();
          log(`\u5F53\u524D\u4E0D\u662F\u8BFE\u7A0B/\u4E13\u9898\u9875 \u2192 \u6267\u884C\u4E2A\u4EBA\u5B66\u4E60\u4EFB\u52A1: \u672A\u5B8C\u6210 ${tasks.length} \u95E8`);
          if (!tasks.length) log("\u6CA1\u6709\u672A\u5B8C\u6210\u7684\u5B66\u4E60\u4EFB\u52A1");
          for (const t of tasks) {
            if (state2.stopFlag) {
              log("\u5DF2\u505C\u6B62");
              break;
            }
            try {
              const [ok, total] = await runCourse(t.businessId);
              if (ok < total) {
                failCount += 1;
                log(`\u26A0 ${String(t.name || "").slice(0, 20)} \u672A\u5B8C\u6210 (${ok}/${total})`);
              }
            } catch (e) {
              if (e instanceof QuotaExhausted) {
                quotaHit = true;
                break;
              }
              if (e.auth) throw e;
              failCount += 1;
              log(`\u2717 \u8BFE\u7A0B\u5931\u8D25: ${e.message}`);
            }
            await sleep(config2.taskGapMs());
          }
        }
        if (quotaHit) log("\u26A0 \u5B66\u65F6\u914D\u989D\u5DF2\u6EE1, \u5DF2\u505C\u6B62 (\u6B21\u65E5\u518D\u8BD5)");
        else if (!state2.stopFlag) {
          if (mode === "course") log(failCount ? `\u26A0 \u672C\u8BFE\u7A0B/\u4E13\u9898\u5904\u7406\u5B8C\u6BD5 (\u5931\u8D25 ${failCount} \u5904)` : "\u2705 \u672C\u8BFE\u7A0B/\u4E13\u9898\u5904\u7406\u5B8C\u6BD5");
          else log(failCount ? `\u26A0 \u5168\u90E8\u4EFB\u52A1\u5904\u7406\u5B8C\u6BD5 (\u5931\u8D25 ${failCount} \u95E8)` : "\u2705 \u5168\u90E8\u4EFB\u52A1\u5904\u7406\u5B8C\u6BD5");
        }
        return { quotaHit, ok: !quotaHit && !state2.stopFlag && failCount === 0, authFailed: false };
      } catch (e) {
        log(`\u2717 ${e.message}`);
        return { quotaHit, ok: false, authFailed: !!(e && e.auth) };
      } finally {
        state2.running = false;
        state2.course = "";
        state2.section = "";
        if (lock2) lock2.release();
        ui();
      }
    }
    return { undoneTasks, sections, openCourse, startProgress, settleNested, doSection, runCourse, runAll };
  }

  // src/lock.js
  function createLock(kind, win = globalThis) {
    const MY = `${kind}#${Math.random().toString(36).slice(2, 8)}`;
    const other = kind === "fast" ? "realtime" : "fast";
    const lockOwner = () => {
      const cur = win.__MOOC_US_LOCK;
      if (!cur || cur === MY) return "";
      return String(cur).startsWith(other) ? "\u53E6\u4E00\u4E2A\u811A\u672C" : "\u53E6\u4E00\u6761\u4EFB\u52A1";
    };
    const acquire = () => {
      win.__MOOC_US_LOCK = MY;
    };
    const release = () => {
      if (win.__MOOC_US_LOCK === MY) win.__MOOC_US_LOCK = null;
    };
    return { MY, lockOwner, acquire, release };
  }

  // src/guard.js
  var KEY2 = "__MOOC_US_SESSION__";
  var mem = /* @__PURE__ */ new Map();
  function createSessionGuard(gm2, { ttlMs = 45e3, now = () => Date.now() } = {}) {
    const read = () => {
      if (!gm2) return mem.get(KEY2) || null;
      try {
        return JSON.parse(gm2.getValue(KEY2) || "null");
      } catch {
        return null;
      }
    };
    const write = (v) => {
      if (!gm2) {
        if (v) mem.set(KEY2, v);
        else mem.delete(KEY2);
        return;
      }
      if (v) gm2.setValue(KEY2, JSON.stringify(v));
      else gm2.deleteValue(KEY2);
    };
    return {
      // 占住会话; 已被其他 owner 占用且未过期时返回 false
      hold(owner) {
        const cur = read();
        if (cur && cur.owner !== owner && now() - cur.ts < ttlMs) return false;
        write({ owner, ts: now() });
        const back = read();
        return !!(back && back.owner === owner);
      },
      held(owner) {
        const cur = read();
        return !!(cur && now() - cur.ts < ttlMs && (owner ? cur.owner !== owner : true));
      },
      release(owner) {
        const cur = read();
        if (cur && cur.owner === owner) write(null);
      }
    };
  }

  // src/panel.js
  function createPanel({
    prefix,
    title,
    fallbackColor,
    emoji,
    verb,
    consoleTag,
    state: state2,
    lockOwner,
    currentBid: currentBid2,
    gm: gm2,
    onStart
  }) {
    let box, logEl, statusEl, btnStart;
    const pendingLogs = [];
    function log(msg) {
      const t = (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
      if (logEl) {
        const line = document.createElement("div");
        line.textContent = `[${t}] ${msg}`;
        logEl.appendChild(line);
        while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      } else {
        // boot 先于 mount 时（如 tokenFromStorage 的「令牌已捕获」），暂存起来等面板挂上再补显
        pendingLogs.push(`[${t}] ${msg}`);
        if (pendingLogs.length > 60) pendingLogs.shift();
      }
      console.log(`[${consoleTag}] ${msg}`);
    }
    function ui() {
      if (!statusEl) return;
      statusEl.textContent = state2.running ? `${emoji} ${state2.course || "\u51C6\u5907\u4E2D"} | ${state2.section || ""} | \u8F6E ${state2.round} | \u5DF2\u62A5 ${state2.submitted}s` : lockOwner() ? "\u25A0 \u5DF2\u505C\u6B62 (\u53E6\u4E00\u4EFB\u52A1/\u811A\u672C\u8FD0\u884C\u4E2D)" : currentBid2() ? "\u25A0 \u5DF2\u505C\u6B62 \xB7 \u5F53\u524D\u9875\u8BFE\u7A0B/\u4E13\u9898" : "\u25A0 \u5DF2\u505C\u6B62 \xB7 \u4E2A\u4EBA\u5B66\u4E60\u4EFB\u52A1";
      btnStart.textContent = state2.running ? "\u23F8 \u505C\u6B62" : currentBid2() ? `${emoji} ${verb}\u672C\u8BFE\u7A0B/\u4E13\u9898` : `${emoji} \u6267\u884C\u5B66\u4E60\u4EFB\u52A1`;
    }
    function headerColor(fallback) {
      try {
        const els = document.elementsFromPoint(1, 1);
        const top = els.find((el) => {
          if (el === document.documentElement || el === document.body) return false;
          const cs = getComputedStyle(el);
          return (cs.position === "fixed" || cs.position === "sticky") && el.offsetHeight > 0 && el.offsetHeight < 200;
        });
        if (top) {
          for (const el of [top, ...top.querySelectorAll("*")]) {
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/);
            if (!m) continue;
            if (m[4] !== void 0 && parseFloat(m[4]) < 1) continue;
            const [r, g, b] = [+m[1], +m[2], +m[3]];
            if (r > 246 && g > 246 && b > 246) continue;
            return { bg, light: 0.299 * r + 0.587 * g + 0.114 * b < 160 };
          }
        }
      } catch {
      }
      return { bg: fallback, light: true };
    }
    function makeDraggable(head, panel2, onToggle) {
      let sx = 0, sy = 0, px = 0, py = 0, moved = false;
      head.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = panel2.getBoundingClientRect();
        sx = e.clientX;
        sy = e.clientY;
        px = r.left;
        py = r.top;
        moved = false;
        const mv = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          state2.pinned = true;
          const w = panel2.offsetWidth, h = panel2.offsetHeight;
          const left = Math.min(Math.max(0, px + dx), window.innerWidth - w);
          const top = Math.min(Math.max(0, py + dy), window.innerHeight - h);
          panel2.style.left = left + "px";
          panel2.style.top = top + "px";
          panel2.style.right = "auto";
          panel2.style.bottom = "auto";
        };
        const up = () => {
          document.removeEventListener("mousemove", mv);
          document.removeEventListener("mouseup", up);
          if (moved) {
            state2.pinned = true;
            gm2.setValue("pos", { left: parseFloat(panel2.style.left), top: parseFloat(panel2.style.top), v: 2 });
          } else onToggle();
        };
        document.addEventListener("mousemove", mv);
        document.addEventListener("mouseup", up);
      });
      head.addEventListener("click", (e) => e.preventDefault());
    }
    function setCollapsed(c) {
      state2.collapsed = c;
      gm2.setValue("collapsed", c);
      if (!box) return;
      const body = box.querySelector(`.${prefix}-body`);
      body.style.display = c ? "none" : "";
      box.style.width = c ? "auto" : "340px";
      box.querySelector(`.${prefix}-toggle`).textContent = c ? "\u25A3" : "\u2014";
      box.title = c ? "\u70B9\u51FB\u6807\u9898\u680F\u5C55\u5F00" : "\u70B9\u51FB\u6807\u9898\u680F\u6298\u53E0";
    }
    function mount() {
      if (box && (!document.contains || document.contains(box))) return;
      const theme = headerColor(fallbackColor);
      const fg = theme.light ? "#fff" : "#1f2328";
      const buddy = document.querySelector(".um-head, .uf-head");
      if (buddy) state2.stacked = true;
      const posCss = state2.stacked ? `top:${Math.round(buddy.parentElement.getBoundingClientRect().bottom + 12)}px` : "bottom:16px";
      box = document.createElement("div");
      box.style.cssText = `position:fixed;${posCss};right:12px;z-index:999999;width:340px;background:rgba(255,255,255,.85);backdrop-filter:blur(6px);border:1px solid rgba(208,215,222,.8);border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.15);font:12px/1.5 monospace;color:#1f2328;`;
      box.innerHTML = `
      <div class="${prefix}-head" style="padding:6px 10px;background:${theme.bg};color:${fg};display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none">
        <b>${title}</b><span class="${prefix}-toggle" style="cursor:pointer">\u2014</span>
      </div>
      <div class="${prefix}-body">
        <div id="${prefix}-status" style="padding:6px 10px;color:#57606a"></div>
        <div style="padding:0 10px 6px">
          <button id="${prefix}-start" style="display:inline-flex;width:100%;align-items:center;justify-content:center;height:28px;padding:0 8px;font:inherit;line-height:1;cursor:pointer;border:1px solid ${theme.bg};background:${theme.bg};color:${fg};border-radius:6px"></button>
        </div>
        <div id="${prefix}-log" style="height:180px;overflow-y:auto;padding:4px 10px;border-top:1px solid #eaeef2;white-space:pre-wrap"></div>
      </div>`;
      const root = document.documentElement || document.body;
      if (!root) return;
      root.appendChild(box);
      const pos = gm2.getValue("pos");
      if (pos && pos.v === 2) {
        box.style.left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - box.offsetWidth)) + "px";
        box.style.top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - box.offsetHeight)) + "px";
        box.style.right = "auto";
        box.style.bottom = "auto";
        state2.pinned = true;
      }
      logEl = box.querySelector(`#${prefix}-log`);
      statusEl = box.querySelector(`#${prefix}-status`);
      btnStart = box.querySelector(`#${prefix}-start`);
      if (pendingLogs.length) {
        for (const msg of pendingLogs.splice(0)) {
          const line = document.createElement("div");
          line.textContent = msg;
          logEl.appendChild(line);
        }
        while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      }
      makeDraggable(box.querySelector(`.${prefix}-head`), box, () => setCollapsed(!state2.collapsed));
      btnStart.onclick = (e) => {
        e.stopPropagation();
        onStart();
      };
      setCollapsed(!!gm2.getValue("collapsed", false));
      ui();
      watchTheme();
    }
    function watchTheme() {
      let last = "";
      const tick = () => {
        if (!box) return;
        ui();
        if (state2.stacked && !state2.pinned) {
          const buddy = Array.from(document.querySelectorAll(".um-head, .uf-head")).find((el) => el.parentElement !== box);
          const rect = buddy && buddy.parentElement.getBoundingClientRect();
          if (rect && rect.height > 0) {
            const top = Math.min(Math.round(rect.bottom + 12), Math.max(0, window.innerHeight - box.offsetHeight));
            box.style.top = top + "px";
          }
        }
        const theme = headerColor(fallbackColor);
        const key = theme.bg + (theme.light ? "L" : "D");
        if (key === last) return;
        last = key;
        const fg = theme.light ? "#fff" : "#1f2328";
        const head = box.querySelector(`.${prefix}-head`);
        const btn = box.querySelector(`#${prefix}-start`);
        head.style.background = theme.bg;
        head.style.color = fg;
        if (btn) {
          btn.style.background = theme.bg;
          btn.style.borderColor = theme.bg;
          btn.style.color = fg;
        }
        if (!state2.pinned && !state2.stacked) {
          box.style.top = "auto";
          box.style.bottom = "16px";
        }
      };
      tick();
      setInterval(tick, 2e3);
      window.addEventListener("hashchange", tick);
    }
    function destroy() {
      if (box && box.remove) box.remove();
      box = null;
    }
    return { log, ui, mount, setCollapsed, destroy, getBox: () => box };
  }

  // src/routes.js
  function currentBidFromHash(hash) {
    try {
      const h = decodeURIComponent(hash || "");
      const m = h.match(/course\/detail\/\d+&([^&/]+)/) || h.match(/subject\/detail\/([^&/?#]+)/) || h.match(/course\/detail\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return m ? m[1] : "";
    } catch {
      return "";
    }
  }
  var AUTH_PAGE_RE = /#\/(?:login|register|forget|auth)\b/i;
  var isAuthPage = (hash) => AUTH_PAGE_RE.test(hash || "");

  // src/entry-fast.js
  var gm = {
    getValue: (k, d) => {
      try {
        const v = GM_getValue(k);
        return v === void 0 ? d : v;
      } catch {
        return d;
      }
    },
    setValue: (k, v) => {
      try {
        GM_setValue(k, v);
      } catch {
      }
    },
    deleteValue: (k) => {
      try {
        GM_deleteValue(k);
      } catch {
      }
    }
  };
  var state = { running: false, stopFlag: false, course: "", section: "", round: 0, submitted: 0, collapsed: false, pinned: false, stacked: false };
  var hunter = createTokenHunter({ log: (m) => panel.log(m) }); // panel.log lazy ref: panel exists by boot time, so storage-restored token shows in panel too
  var api = createApi({ hunter, gm, log: (m) => panel.log(m) });
  var normalizeChunk = (raw) => Math.min(86400, Math.max(30, Number(raw) || 600)); // cap 24h: bigger values backdate createTime to 1970
  var chunk = () => normalizeChunk(gm.getValue("chunk"));
  var config = {
    getStep: () => chunk(),
    backdateS: (step) => step + Math.trunc(rand(60, 300)),
    roundSleepMs: () => rand(600, 1600),
    roundsSlack: 5,
    taskGapMs: () => rand(1500, 3e3),
    coursePageLabel: "\u5FEB\u901F\u5237\u672C\u8BFE\u7A0B/\u4E13\u9898"
  };
  var lock = createLock("fast");
  var INSTANCE = "fast#" + Math.random().toString(36).slice(2, 8);
  var guard = createSessionGuard(gm);
  config.canStart = () => guard.hold(INSTANCE);
  var currentBid = () => currentBidFromHash(location.hash);
  var engine;
  var panel = createPanel({
    prefix: "uf",
    title: "\u5FEB\u901F\u5237\u8BFE\u5B66\u4E60\u52A9\u624B",
    fallbackColor: "#b35900",
    emoji: "\u26A1",
    verb: "\u5237",
    consoleTag: "\u5FEB\u901F\u5237\u8BFE",
    state,
    lockOwner: lock.lockOwner,
    currentBid,
    gm,
    onStart: () => {
      if (state.running) {
        state.stopFlag = true;
        panel.log("\u6B63\u5728\u505C\u6B62(\u7B49\u5F53\u524D\u8F6E\u7ED3\u675F)\u2026");
      } else if (guard.held(INSTANCE)) {
        panel.log("\u26D4 \u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u7684\u5B66\u4E60\u811A\u672C\u6B63\u5728\u8FD0\u884C, \u4E0D\u542F\u52A8(\u9632\u591A\u5F00)");
      } else {
        panel.setCollapsed(false);
        guard.hold(INSTANCE);
        engine.runAll().then((r) => {
          if (r && r.ok && !state.stopFlag) {
            panel.log("\u21BB 2 \u79D2\u540E\u5237\u65B0\u9875\u9762\u4EE5\u66F4\u65B0\u8FDB\u5EA6\u2026");
            setTimeout(() => location.reload(), 2e3);
          } else if (r && r.authFailed) {
            panel.log("\u2717 \u767B\u5F55\u6001\u5931\u6548, \u5DF2\u505C\u6B62(\u4E0D\u81EA\u52A8\u5237\u65B0)");
          }
        }).catch((e) => panel.log(`\u2717 ${e && e.message || e}`)).finally(() => guard.release(INSTANCE));
      }
    }
  });
  engine = createEngine({ api, state, config, log: panel.log, ui: panel.ui, lock, currentBid });
  setInterval(() => {
    if (state.running) guard.hold(INSTANCE);
  }, 15e3);
  hunter.installHooks({});
  (function boot() {
    hunter.tokenFromStorage();
    const mountPanel = () => { if (!isAuthPage(location.hash)) panel.mount(); };
    if (document.documentElement) mountPanel();
    else document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
    window.addEventListener("hashchange", () => {
      if (!isAuthPage(location.hash)) {
        if (!panel.getBox()) panel.mount();
      } else if (panel.getBox()) {
        panel.destroy();
      }
    });
    window.__MOOC_US_DEBUG__ = Object.assign(window.__MOOC_US_DEBUG__ || {}, {
      fast: {
        state,
        runCourse: (id) => engine.runCourse(id),
        runAll: () => engine.runAll(),
        currentBidFromHash: () => currentBid(),
        log: panel.log,
        core: {
          KEY,
          encField,
          expandKey,
          encryptBlock,
          hash32,
          fingerprintFor,
          pystr,
          toParams,
          qs,
          form,
          createTokenHunter,
          createApi,
          createEngine,
          createLock,
          createSessionGuard,
          QuotaExhausted,
          buildStartParams,
          parseRemaining,
          normalizeReport,
          computeMaxRounds,
          normalizeChunk,
          currentBidFromHash: (hash) => currentBidFromHash(hash),
          isAuthPage,
          taskFilter,
          sectionSkipped,
          getStep: () => config.getStep(),
          roundsSlack: config.roundsSlack,
          engine,
          constants: { API, MEDIA, NESTED, SKIP, DONE, TYPE_NAME }
        }
      }
    });
  })();
  GM_registerMenuCommand("\u663E\u793A/\u9690\u85CF\u9762\u677F", () => {
    if (!panel.getBox()) {
      panel.mount();
      return;
    }
    const b = panel.getBox();
    b.style.display = b.style.display === "none" ? "" : "none";
  });
  GM_registerMenuCommand("\u8BBE\u7F6E\u5355\u6863\u79D2\u6570(\u226530)", () => {
    const v = Number(prompt("\u6BCF\u4E2A\u5C0F\u8282\u6BCF\u6B21\u4E0A\u62A5\u7684\u79D2\u6570(\u226530, \u9ED8\u8BA4600):", String(gm.getValue("chunk") || 600)));
    if (Number.isFinite(v) && v >= 30 && v <= 86400) {
      gm.setValue("chunk", Math.trunc(v));
      panel.log(`\u5355\u6863\u79D2\u6570 \u2192 ${Math.trunc(v)}`);
    } else if (v) panel.log("\u79D2\u6570\u65E0\u6548(\u987B 30\u201586400)");
  });
  GM_registerMenuCommand("\u8BBE\u7F6E\u5355\u4F4D\u540D\u79F0", () => {
    const v = prompt("\u5355\u4F4D\u540D\u79F0(\u9ED8\u8BA4\u5168\u884C\u4E1A):", gm.getValue("companyName") || "\u5168\u884C\u4E1A");
    if (v && v.trim()) {
      gm.setValue("companyName", v.trim());
      panel.log(`\u5355\u4F4D\u540D\u79F0\u5DF2\u4FDD\u5B58`);
    }
  });
  GM_registerMenuCommand("\u4FDD\u5B58\u8D26\u53F7\u5BC6\u7801(\u7528\u4E8E\u5931\u6548\u81EA\u52A8\u91CD\u767B)", () => {
    const u = prompt("\u8D26\u53F7:");
    if (!u) return;
    const p = prompt("\u5BC6\u7801:");
    if (!p) return;
    gm.setValue("account", { username: u, password: p });
    panel.log("\u8D26\u5BC6\u5DF2\u4FDD\u5B58(\u4EC5\u5B58\u4E8E\u672C\u673A\u6CB9\u7334\u5B58\u50A8)");
  });
  GM_registerMenuCommand("\u6E05\u9664\u8D26\u53F7\u5BC6\u7801", () => {
    gm.deleteValue("account");
    panel.log("\u8D26\u5BC6\u5DF2\u6E05\u9664");
  });
})();

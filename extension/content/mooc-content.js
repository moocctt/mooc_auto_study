(() => {
  // ../../tmp/build/src/lib/capture.ts
  function readCapturedToken(get) {
    try {
      const raw = get("token");
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && typeof obj.access_token === "string" && obj.access_token.length > 20) {
        return obj;
      }
    } catch {
    }
    return null;
  }

  // ../../tmp/build/src/lib/mooc-routes.ts
  var SUBJECT_SECTION_RE = /\/study\/course\/detail\/\d+&[0-9a-zA-Z-]+\/\d+\/\d+\/([0-9a-zA-Z-]+)/;
  function courseEntryHash(type, rid) {
    return `#/study/course/detail/${type}&${rid}`;
  }
  function subjectHash(subjectId) {
    return `#/study/subject/detail/${subjectId}`;
  }

  // ../../tmp/build/src/lib/autopilot-rules.ts
  var ELECTIVE_RE = /(?:^|[\s/|【[(（])选修(?:[\s/|】\])）]|$)/;
  function isElectiveText(text) {
    const t = String(text || "");
    if (!t.trim()) return false;
    return ELECTIVE_RE.test(t);
  }
  function shouldSkipRow(row) {
    if (!row) return true;
    if (row.skipped) return true;
    if (row.elective) return true;
    return /复习|已完成/.test(String(row.state || ""));
  }
  function knowledgeIdOf(hash) {
    const m = String(hash || "").match(/#\/knowledge\/details\/([^/?#]+)/);
    return m ? m[1] : "";
  }
  function docBottomTop(host) {
    return Math.max(0, Number(host.scrollHeight || 0) - Number(host.clientHeight || 0));
  }
  function isAtDocBottom(host, tolerance = 2) {
    return Number(host.scrollTop || 0) >= docBottomTop(host) - tolerance;
  }
  function docNudgeTop(host, jitter) {
    return Math.max(0, docBottomTop(host) - Math.max(0, Number(jitter) || 0));
  }
  function docGrew(prevMax, nowMax, threshold = 80) {
    return nowMax > prevMax + threshold;
  }
  function planDocTick(host, state, now, holdMs = 8e3, jitter = 1) {
    const nowMax = docBottomTop(host);
    let bottomAt = state.bottomAt;
    if (docGrew(state.max, nowMax)) bottomAt = 0;
    const next = { bottomAt, max: Math.max(state.max, nowMax) };
    if (!isAtDocBottom(host)) return { action: "jump", top: nowMax, state: next };
    if (!bottomAt) return { action: "wait", top: nowMax, state: { ...next, bottomAt: now } };
    if (now - bottomAt > holdMs) return { action: "leave", top: nowMax, state: next };
    return { action: "nudge", top: docNudgeTop(host, jitter), state: next };
  }
  function shouldDriveHere(myTab, apTab) {
    if (!(apTab > 0)) return true;
    if (!(myTab > 0)) return true;
    return myTab === apTab;
  }

  // ../../tmp/build/src/lib/needLogin.ts
  var NEED_LOGIN_KEY = "mooc.needLogin";
  function stripSensitive(raw) {
    const src = String(raw);
    const [beforeHash, ...rest] = src.split("#");
    const base = beforeHash.split("?")[0];
    const hash = rest.join("#").split("?")[0];
    const out = (base + (hash ? `#${hash}` : "")).replace(/([?&#](?:access_token|refresh_token|id_token|token|code)=)[^&]*/gi, "$1***");
    return out.slice(0, 300);
  }
  var DEDUPE_MS = 3e4;
  var ext = () => globalThis.browser || globalThis.chrome;
  async function activeAccountKey() {
    try {
      const api = ext();
      if (!api?.storage?.local?.get) return "";
      const got = await api.storage.local.get("mooc.activeAccount");
      return String(got?.["mooc.activeAccount"] || "");
    } catch {
      return "";
    }
  }
  async function markNeedLogin(why, opts = {}) {
    const now = opts.at || Date.now();
    const rec = {
      at: now,
      why: String(why || "\u767B\u5F55\u6001\u5DF2\u5931\u6548").slice(0, 120),
      ...opts.url ? { url: stripSensitive(opts.url) } : {},
      ...opts.account ? { account: String(opts.account).slice(0, 80) } : {}
    };
    try {
      const cur = await readNeedLogin();
      if (cur && cur.at > 0 && now - cur.at < DEDUPE_MS && (cur.account || "") === (rec.account || "") && cur.why === rec.why) {
        return cur;
      }
      if (cur?.account && rec.account && cur.account !== rec.account) {
        const act = await activeAccountKey();
        if (cur.account === act && rec.account !== act) return cur;
      }
      const api = ext();
      if (api?.storage?.local?.set) await api.storage.local.set({ [NEED_LOGIN_KEY]: rec });
      else globalThis.localStorage?.setItem(NEED_LOGIN_KEY, JSON.stringify(rec));
      return rec;
    } catch {
      return null;
    }
  }
  async function readNeedLogin() {
    try {
      const api = ext();
      let raw;
      if (api?.storage?.local?.get) raw = (await api.storage.local.get(NEED_LOGIN_KEY))?.[NEED_LOGIN_KEY];
      else {
        const s = globalThis.localStorage?.getItem(NEED_LOGIN_KEY);
        raw = s ? JSON.parse(s) : null;
      }
      if (!raw || typeof raw !== "object") return null;
      const at = Number(raw.at);
      if (!(at > 0)) return null;
      return {
        at,
        why: String(raw.why || ""),
        url: raw.url ? String(raw.url) : void 0,
        account: raw.account ? String(raw.account) : void 0,
        ...raw.dismissed ? { dismissed: true } : {}
      };
    } catch {
      return null;
    }
  }
  var LOGIN_ROUTE_RE = /#!?\/(login|oauth|sso)\b|#login\/|\/oauth(?:\/|$)/i;
  var LOGIN_TEXT_RE = /登录已失效|登录已过期|登录超时|登录状态已过期|请重新登录|重新登录后继续|请先登录|用户未登录/;
  function detectLoginWall(input) {
    const path = String(input.pathname || "");
    const hash = String(input.hash || "");
    const href = String(input.href || "");
    if (LOGIN_ROUTE_RE.test(hash) || LOGIN_ROUTE_RE.test(path)) return "\u5E73\u53F0\u8DF3\u8F6C\u5230\u767B\u5F55\u9875";
    if (LOGIN_TEXT_RE.test(String(input.bodyText || ""))) return "\u5E73\u53F0\u63D0\u793A\u767B\u5F55\u5DF2\u5931\u6548";
    if (input.hasLoginForm) return "\u9875\u9762\u51FA\u73B0\u767B\u5F55\u8868\u5355";
    if (LOGIN_ROUTE_RE.test(href) && !/#\/study\//.test(href)) return "\u5E73\u53F0\u8DF3\u8F6C\u5230\u767B\u5F55\u9875";
    return "";
  }

  // ../../tmp/build/src/entrypoints/mooc.content.ts
  var __script = {
    matches: ["https://mooc.ctt.cn/*"],
    runAt: "document_idle",
    main() {
      const read = () => readCapturedToken((k) => localStorage.getItem(k));
      const send = () => {
        const t = read();
        if (t) {
          try {
            const api = globalThis.browser || globalThis.chrome;
            api?.runtime?.sendMessage?.({ type: "TOKEN_CAPTURE", token: t })?.catch?.(() => {
            });
          } catch {
          }
        }
      };
      send();
      window.addEventListener("storage", (e) => {
        if (e.key === "token") send();
      });
      setInterval(() => {
        if (document.visibilityState === "visible") send();
      }, 3e4);
      setInterval(() => {
        void driveOnce();
      }, 2e3);
      document.addEventListener("play", () => {
        void driveOnce();
      }, true);
      document.addEventListener("ended", () => {
        setTimeout(() => {
          void driveOnce();
        }, 800);
      }, true);
    }
  };
  var AP = {
    on: "mooc.autopilot",
    at: "mooc.autopilotOnAt",
    tab: "mooc.autopilotTab",
    queue: "mooc.autopilotQueue",
    status: "mooc.autopilotStatus",
    account: "mooc.autopilotAccount"
    // 本次值守用的是哪个账号（多账号时用于定位谁失效）
  };
  var setStatus = (text) => {
    try {
      globalThis.chrome?.storage?.local?.set({ [AP.status]: text });
    } catch {
    }
    try {
      globalThis.chrome?.runtime?.sendMessage?.({
        type: "AUTOPILOT_TICK",
        playing: /播放中|续播/.test(text),
        text
      })?.catch?.(() => {
      });
    } catch {
    }
  };
  var saw401 = false;
  var haltedForLogin = false;
  var drivingAccount = "";
  var NEED_LOGIN_STATUS = (why) => `\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF08${why}\uFF09\uFF0C\u503C\u5B88\u5DF2\u505C\u6B62 \xB7 \u8BF7\u91CD\u65B0\u626B\u7801\u6216\u8D26\u5BC6\u767B\u5F55`;
  var loginWallNow = () => detectLoginWall({
    href: location.href,
    hash: location.hash,
    pathname: location.pathname,
    bodyText: (document.body?.innerText || "").slice(0, 4e3),
    // 平台登录表单的 input 没有 placeholder, 只按 placeholder 匹配会漏判 → 以「可见密码框」为准
    hasLoginForm: [...document.querySelectorAll('input[type="password"]')].some((el) => visible(el))
  });
  var haltForLogin = async (why) => {
    if (haltedForLogin) return;
    haltedForLogin = true;
    const api = globalThis.browser || globalThis.chrome;
    const status = NEED_LOGIN_STATUS(why);
    try {
      document.querySelector("video")?.pause();
    } catch {
    }
    try {
      await markNeedLogin(why, { url: location.href, account: drivingAccount || void 0 });
    } catch {
    }
    try {
      await api?.storage?.local?.set?.({ [AP.on]: false, [AP.status]: status });
    } catch {
    }
    try {
      await api?.runtime?.sendMessage?.({ type: "AUTOPILOT_NEED_LOGIN", why })?.catch?.(() => {
      });
    } catch {
    }
  };
  var AP_CTX = "mooc.autopilotCtx";
  var setCtx = (patch) => {
    try {
      const cur = JSON.parse(sessionStorage.getItem("mooc.ap.ctx") || "{}");
      const next = { ...cur, ...patch };
      if (JSON.stringify(cur) === JSON.stringify(next)) return;
      sessionStorage.setItem("mooc.ap.ctx", JSON.stringify(next));
      globalThis.chrome?.storage?.local?.set({ [AP_CTX]: next });
    } catch {
    }
  };
  var sectionName = () => {
    const li = currentSection()?.closest("li") || document.querySelector(".section-item")?.closest("li");
    const t = norm(li?.textContent || "");
    if (!t) return "";
    const m = t.match(/第[^:：\n]{1,6}[:：]\s*([^\n]+)/);
    if (m) return m[1].replace(/(视频|文档|音频|学习中|已完成|复习|剩余.*|暂停).*$/, "").trim();
    return t.slice(0, 40);
  };
  var norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  var visible = (el) => !!el && el.offsetParent !== null;
  var clickText = (re) => {
    const el = [...document.querySelectorAll("button, a, div, span")].find((x) => {
      const t = norm(x.textContent);
      return t && t.length <= 12 && re.test(t) && visible(x);
    });
    if (el) {
      el.click();
      return true;
    }
    return false;
  };
  var keepPageActive = () => {
    const x = Math.floor(Math.random() * Math.max(1, window.innerWidth - 2)) + 1;
    const y = Math.floor(Math.random() * Math.max(1, window.innerHeight - 2)) + 1;
    for (const type of ["mousemove", "pointermove"]) {
      try {
        window.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          movementX: 2,
          movementY: 1
        }));
      } catch {
      }
    }
  };
  var fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  var sections = () => [...document.querySelectorAll(".section-item")];
  var secText = (el) => norm(el.innerText);
  var secDone = (el) => /已完成|复习/.test(secText(el)) || isElectiveText(secText(el));
  var currentSection = () => sections().find((x) => x.className.includes("focus"));
  var allSectionsDone = () => {
    const list = sections();
    return list.length > 0 && list.every((x) => secDone(x));
  };
  var nextSection = () => {
    const list = sections();
    const cur = currentSection();
    const from = cur ? list.indexOf(cur) + 1 : 0;
    const order = [...list.slice(from), ...list.slice(0, Math.max(0, from - 1))];
    // 优先跳过 H5 课件等无播放器的小节(点了也无法播, 会死磕), 先播完可播的; 全剩不可播时再回退原序
    return order.find((x) => !secDone(x) && !/^H5/.test(secText(x))) || order.find((x) => !secDone(x));
  };
  var clickSection = (el) => {
    const target = el.querySelector(".item.pointer, .item") || el;
    target.click();
  };
  var COURSE_ID = () => {
    const m = location.hash.match(/\/study\/course\/detail\/\d+&([0-9a-zA-Z-]+)/);
    return m ? m[1] : "";
  };
  var authHeaders = () => {
    const t = readCapturedToken((k) => localStorage.getItem(k));
    if (!t?.access_token) return null;
    return {
      Authorization: `${t.token_type || "Bearer"}__${t.access_token}`,
      Accept: "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    };
  };
  var fetchProgress = async (courseId) => {
    const h = authHeaders();
    if (!h || !courseId) return null;
    try {
      const infoRes = await fetch(
        `/api/v1/course-study/course-front/info/${courseId}?source=1&type=1&_=${Date.now()}`,
        { headers: h, credentials: "include" }
      );
      if (infoRes.status === 401) {
        saw401 = true;
        return null;
      }
      const info = await infoRes.json();
      const secs = [];
      for (const ch of info?.courseChapters || []) {
        for (const s of ch.courseChapterSections || []) {
          secs.push({ section_id: s.id, resource_id: s.resourceId, finish: 0, rate: 0 });
        }
      }
      if (!secs.length) return null;
      const rid = secs.map((s) => s.resource_id).filter(Boolean).join(",");
      const rowsRes = await fetch("/api/v1/course-study/course-front/course-section-progress", {
        method: "POST",
        headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        body: new URLSearchParams({ courseId, resourceIds: rid }).toString()
      });
      if (rowsRes.status === 401) {
        saw401 = true;
        return null;
      }
      const rows = await rowsRes.json();
      const map = /* @__PURE__ */ new Map();
      for (const r of Array.isArray(rows) ? rows : []) map.set(String(r.resourceId || r.courseResourceId || ""), r);
      for (const s of secs) {
        const got = map.get(s.resource_id);
        if (got) {
          s.finish = Number(got.finishStatus || 0);
          s.rate = Number(got.completedRate || 0);
        }
      }
      return secs;
    } catch {
      return null;
    }
  };
  var allDoneByApi = (secs) => {
    if (!secs || !secs.length) return null;
    return secs.every((s) => (s.finish === 2 || s.finish === 4) && s.rate >= 100);
  };
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var QUALITY = "\u666E\u6E05";
  var qualityControl = () => [...document.querySelectorAll(".vjs-subs-caps-button")].find((x) => /原图|高清|普清|标清|超清/.test(norm(x.textContent)));
  var currentQuality = (ctl) => norm(ctl.querySelector(".vjs-control-text")?.textContent || "");
  var hasQualityItem = (ctl, name) => [...ctl.querySelectorAll(".vjs-menu-item")].some((x) => norm(x.textContent) === name);
  var maybeQuality = () => {
    const ctl = qualityControl();
    if (!ctl || currentQuality(ctl) === QUALITY) return false;
    const item = [...ctl.querySelectorAll(".vjs-menu-item")].find((x) => norm(x.textContent) === QUALITY);
    if (!item) return false;
    item.click();
    return true;
  };
  // 用户手动暂停让位: 真实手势(click/keydown)后短暂出现的 pause 视为用户主动暂停,
  // 值守停 90s 不抢(状态栏说明), 到期自动恢复 —— 平台自身的暂停(弹窗/画质切换/自动播放拦截)
  // 无可信手势伴随, 照旧立即续播。对抗用户比暂停同几秒视频代价高得多
  var lastGestureAt = 0;
  var userPauseUntil = 0;
  document.addEventListener("click", (e) => { if (e.isTrusted) lastGestureAt = Date.now(); }, true);
  document.addEventListener("keydown", (e) => { if (e.isTrusted) lastGestureAt = Date.now(); }, true);
  var hookUserPause = (video) => {
    if (!video || video.__apPauseHooked) return;
    video.__apPauseHooked = true;
    video.addEventListener("pause", () => {
      if (Date.now() - lastGestureAt < 800) userPauseUntil = Date.now() + 90e3;
    });
    video.addEventListener("play", () => {
      if (Date.now() - lastGestureAt < 800) userPauseUntil = 0;
    });
  };
  var ensurePlay = async (video) => {
    const ctl = document.querySelector(".vjs-play-control");
    if (ctl && visible(ctl)) {
      ctl.click();
      await sleep(500);
      if (!video.paused) return "button";
    }
    const big = document.querySelector(".vjs-big-play-button");
    if (big && visible(big)) {
      big.click();
      await sleep(500);
      if (!video.paused) return "big";
    }
    try {
      await video.play();
      return "play";
    } catch {
    }
    try {
      video.muted = true;
      await video.play();
      return "muted";
    } catch {
      return "fail";
    }
  };
  var lastSecId = "";
  var lastCur = -1;
  var movedAt = 0;
  var endAt = 0;
  var ackAt = 0;
  var ackSecs = null;
  var qualityTries = 0;
  var playingIdx = -1;
  var forceQuality = false;
  var wasOn = false;
  var subjReloadAt = 0;
  var bounceBackAt = 0;
  var ssGet = (key) => {
    try {
      return Number(sessionStorage.getItem(`mooc.ap.${key}`) || 0) || 0;
    } catch {
      return 0;
    }
  };
  var ssSet = (key, v) => {
    try {
      sessionStorage.setItem(`mooc.ap.${key}`, String(v));
    } catch {
    }
  };
  var ssGetS = (key) => {
    try {
      return sessionStorage.getItem(`mooc.ap.${key}`) || "";
    } catch {
      return "";
    }
  };
  var ssSetS = (key, v) => {
    try {
      sessionStorage.setItem(`mooc.ap.${key}`, v);
    } catch {
    }
  };
  var ownTabId = null;
  var whoami = async (api) => {
    if (ownTabId !== null) return ownTabId;
    let id = -1;
    try {
      const r = await api?.runtime?.sendMessage?.({ type: "AUTOPILOT_WHOAMI" });
      id = Number(r?.tabId ?? -1);
    } catch {
    }
    if (id > 0) ownTabId = id;
    return id;
  };
  var resetTick = () => {
    lastCur = -1;
    movedAt = 0;
    endAt = 0;
    ackAt = 0;
    ackSecs = null;
  };
  var DOC_MAX_TRIES = 2;
  var DOC_BOTTOM_HOLD_MS = 8e3;
  var DOC_STATE = { id: "", startedAt: 0, bottomAt: 0, max: 0 };
  var resetDocFails = () => {
    try {
      const del = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i) || "";
        if (k.startsWith("mooc.ap.docFail:") || k.startsWith("mooc.ap.docSkip:")) del.push(k);
      }
      for (const k of del) sessionStorage.removeItem(k);
    } catch {
    }
  };
  var scrollHost = () => {
    const cands = [];
    const push = (el) => {
      if (el instanceof HTMLElement) cands.push(el);
    };
    push(document.scrollingElement);
    push(document.body);
    const scan = (root, win) => {
      for (const el of root.querySelectorAll("div, main, section, article")) {
        const style = win.getComputedStyle(el);
        if (!/auto|scroll/.test(style.overflowY)) continue;
        const room = el.scrollHeight - el.clientHeight;
        if (room > 120) cands.push(el);
      }
    };
    scan(document, window);
    for (const f of [...document.querySelectorAll("iframe")]) {
      try {
        const win = f.contentWindow;
        const doc = f.contentDocument;
        if (!win || !doc) continue;
        push(doc.scrollingElement);
        scan(doc, win);
      } catch {
      }
    }
    let best = null;
    let max = 0;
    for (const el of cands) {
      const room = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (room > max) {
        max = room;
        best = el;
      }
    }
    return best && max > 60 ? best : null;
  };
  var readDocument = async (id) => {
    if (DOC_STATE.id !== id) {
      DOC_STATE.id = id;
      DOC_STATE.startedAt = Date.now();
      DOC_STATE.bottomAt = 0;
      DOC_STATE.max = 0;
      setStatus("\u6587\u6863\u5C0F\u8282: \u8DF3\u5230\u6700\u540E\u4E00\u9875");
    }
    if (ssGet(`docFail:${id}`) > DOC_MAX_TRIES) {
      const rid = ssGetS("pendingRid");
      if (rid) ssSet(`docSkip:${rid}`, 1);
      await leaveDoc("\u6587\u6863\u591A\u6B21\u8BFB\u5230\u5E95\u4ECD\u672A\u8BB0\u8D26, \u8DF3\u8FC7\u672C\u5C0F\u8282");
      return;
    }
    const host = scrollHost();
    if (!host) {
      if (Date.now() - DOC_STATE.startedAt > 2e4) await leaveDoc("\u6587\u6863\u6CA1\u6709\u53EF\u6EDA\u52A8\u5185\u5BB9");
      else setStatus("\u6587\u6863\u52A0\u8F7D\u4E2D");
      return;
    }
    const fireScroll = () => {
      try {
        host.dispatchEvent(new Event("scroll", { bubbles: true }));
      } catch {
      }
      keepPageActive();
    };
    const plan = planDocTick(host, DOC_STATE, Date.now(), DOC_BOTTOM_HOLD_MS, Math.random() < 0.5 ? 1 : 2);
    DOC_STATE.bottomAt = plan.state.bottomAt;
    DOC_STATE.max = plan.state.max;
    if (plan.action === "jump") {
      host.scrollTop = plan.top;
      fireScroll();
      if (!DOC_STATE.bottomAt) setStatus("\u8DF3\u5230\u6700\u540E\u4E00\u9875\u2026");
      return;
    }
    if (plan.action === "wait") {
      setStatus("\u6587\u6863\u5DF2\u5230\u6700\u540E\u4E00\u9875, \u7B49\u5E73\u53F0\u8BB0\u8D26");
      return;
    }
    host.scrollTop = plan.top;
    fireScroll();
    if (plan.action === "leave") {
      ssSet(`docFail:${id}`, ssGet(`docFail:${id}`) + 1);
      await leaveDoc("\u6587\u6863\u5DF2\u8BFB\u5230\u5E95");
    }
  };
  var leaveDoc = async (why) => {
    setStatus(`${why} \u2192 \u8FD4\u56DE\u7EE7\u7EED`);
    DOC_STATE.id = "";
    DOC_STATE.startedAt = 0;
    DOC_STATE.bottomAt = 0;
    DOC_STATE.max = 0;
    if (window.opener) {
      try {
        window.close();
        return;
      } catch {
      }
    }
    const subj = ssGetS("curSubject");
    try {
      location.hash = subj ? subjectHash(subj) : "#/center/my/task";
    } catch {
    }
  };
  var driveOnce = async () => {
    const api = globalThis.browser || globalThis.chrome;
    const got = await api?.storage?.local?.get?.([AP.on, AP.at, AP.tab, AP.account]);
    const on = !!got?.[AP.on];
    if (!on) {
      if (wasOn) {
        try {
          document.querySelector("video")?.pause();
        } catch {
        }
        resetTick();
      }
      wasOn = false;
      return;
    }
    drivingAccount = String(got?.[AP.account] || "");
    if (!drivingAccount) {
      const act = await api?.storage?.local?.get?.("mooc.activeAccount");
      drivingAccount = String(act?.["mooc.activeAccount"] || "");
    }
    const apTab = Number(got?.[AP.tab]) || 0;
    if (apTab && !shouldDriveHere(await whoami(api), apTab)) return;
    if (!wasOn) {
      wasOn = true;
      const onAt = Number(got?.[AP.at]) || 0;
      if (onAt && ssGet("onAt") !== onAt) {
        ssSet("onAt", onAt);
        forceQuality = true;
        qualityTries = 0;
        resetDocFails();
      }
    }
    if (!haltedForLogin) {
      const wall = loginWallNow() || (saw401 ? "\u5E73\u53F0\u63A5\u53E3\u8FD4\u56DE 401" : "");
      if (wall) {
        await haltForLogin(wall);
        return;
      }
    }
    const docId = knowledgeIdOf(location.hash);
    if (docId && !document.querySelector("video")) {
      await readDocument(docId);
      return;
    }
    keepPageActive();
    if (/\/study\/errors\//.test(location.hash)) {
      const eid = location.hash.match(/\/study\/errors\/([0-9a-zA-Z-]+)/)?.[1] || "";
      const subjectId = eid ? ssGetS(`subjOf:${eid}`) : "";
      setStatus("\u6062\u590D\u88AB\u9876\u6389\u7684\u8BFE\u7A0B\u9875");
      try {
        if (subjectId) location.hash = subjectHash(subjectId);
        else if (eid) location.hash = `#/study/course/detail/1&${eid}`;
      } catch {
      }
      return;
    }
    if (/已打开新的课程详情页/.test(document.body.innerText) && clickText(/^继续学习$/)) {
      setStatus("\u5904\u7406\u5E73\u53F0\u5F39\u7A97");
      return;
    }
    const video = document.querySelector("video");
    hookUserPause(video);
    const courseId = COURSE_ID();
    if (!video) {
      resetTick();
      const subj = location.hash.match(SUBJECT_SECTION_RE);
      if (subj) {
        ssSetS(`subjOf:${courseId}`, subj[1]);
        ssSetS("curSubject", subj[1]);
        setStatus("\u7B49\u5F85\u64AD\u653E\u5668\u52A0\u8F7D");
        return;
      }
      if (/\/study\/subject\/detail\//.test(location.hash)) {
        const sid = location.hash.match(/\/study\/subject\/detail\/([0-9a-zA-Z-]+)/)?.[1] || "";
        if (sid) ssSetS("curSubject", sid);
        if (allSectionsDone()) {
          await finishCourse(courseId, "\u76EE\u5F55\u5DF2\u5168\u90E8\u5B8C\u6210");
          return;
        }
        const btns = [...document.querySelectorAll('[id*="studyBtn-"]')];
        const rows = btns.map((b) => {
          const rid = b.getAttribute("data-resource-id") || "";
          const box = b.closest('[id*="sectionDiv-"]');
          return {
            rid,
            type: b.getAttribute("data-section-type") || "10",
            state: b.querySelector("a div")?.textContent?.trim() || b.textContent?.trim() || "",
            elective: isElectiveText(norm(box?.innerText || b.innerText || "")),
            skipped: !!rid && ssGet(`docSkip:${rid}`) > 0
          };
        }).filter((r) => r.rid);
        const next = rows.find((r) => !shouldSkipRow(r));
        if (!next && rows.length > 0) {
          await finishCourse(courseId, "\u4E13\u9898\u8BFE\u7A0B\u5DF2\u5168\u90E8\u5B8C\u6210");
          return;
        }
        if (next) {
          ssSet("subjReloads", 0);
          ssSetS("pendingRid", next.rid);
          ssSetS(`subjOf:${next.rid}`, sid);
          const firstName = btns.map((b) => b.closest('[id*="sectionDiv-"]')?.innerText || "").map((t) => {
            const line = t.split("\n").find((l) => l.includes("\u2014\u2014")) || "";
            return line.split("\u2014\u2014")[0].replace(/^\s*(课程|专题)?\s*(\[?必修\]?|\[?选修\]?)?\s*/, "").trim();
          }).find((s) => s.length >= 4);
          if (firstName) setCtx({ subjectId: sid, subjectName: firstName });
          else setCtx({ subjectId: sid });
          setStatus(`\u8FDB\u5165\u8BFE\u7A0B: ${next.state === "\u7EE7\u7EED\u5B66\u4E60" ? "\u7EE7\u7EED" : "\u5F00\u59CB"}\u5B66\u4E60`);
          try {
            location.hash = courseEntryHash(next.type, next.rid);
          } catch {
          }
          return;
        }
        if (!subjReloadAt) subjReloadAt = Date.now();
        if (Date.now() - subjReloadAt > 25e3 && ssGet("subjReloads") < 6) {
          ssSet("subjReloads", ssGet("subjReloads") + 1);
          setStatus("\u91CD\u65B0\u52A0\u8F7D\u4E13\u9898\u9875");
          location.reload();
          return;
        }
        setStatus("\u7B49\u5F85\u4E13\u9898\u9875\u8BFE\u7A0B\u5217\u8868");
        return;
      }
      if (/^#\/(task|home|center)/.test(location.hash) && ssGetS("curSubject")) {
        if (!bounceBackAt) bounceBackAt = Date.now();
        if (Date.now() - bounceBackAt > 2e4) {
          bounceBackAt = Date.now();
          setStatus("\u56DE\u5230\u4E13\u9898\u9875\u7EE7\u7EED\u503C\u5B88");
          try {
            location.hash = subjectHash(ssGetS("curSubject"));
          } catch {
          }
        }
        return;
      }
      const broken = location.hash.match(/\/study\/course\/detail\/([0-9a-zA-Z-]{16,})$/);
      if (broken) {
        const subjectId = ssGetS(`subjOf:${broken[1]}`) || ssGetS("curSubject");
        if (subjectId) {
          setStatus("\u8DEF\u7531\u5F02\u5E38, \u56DE\u4E13\u9898\u9875\u91CD\u6765");
          try {
            location.hash = subjectHash(subjectId);
          } catch {
          }
        }
        return;
      }
      if (allSectionsDone()) {
        await finishCourse(courseId, "\u76EE\u5F55\u5DF2\u5168\u90E8\u5B8C\u6210");
        return;
      }
      const nxt2 = nextSection();
      if (nxt2) {
        clickSection(nxt2);
        setStatus("\u8FDB\u5165\u672A\u5B8C\u6210\u5C0F\u8282");
        return;
      }
      if (clickText(/^(开始学习|继续学习)$/)) {
        setStatus("\u8FDB\u5165\u5C0F\u8282");
        return;
      }
      return;
    }
    const list = sections();
    const focused = currentSection();
    const focusIdx = focused ? list.indexOf(focused) : -1;
    if (focusIdx >= 0) playingIdx = focusIdx;
    const sec = focused || (playingIdx >= 0 ? list[playingIdx] : void 0);
    const secId = sec ? sec.querySelector("[id*=finishStatus-]")?.id || "" : "";
    if (secId && secId !== lastSecId) {
      lastSecId = secId;
      resetTick();
      qualityTries = 0;
    }
    if (courseId) setCtx({ courseId });
    const vidName = sectionName();
    if (vidName) setCtx({ video: vidName });
    const dur = Number(video.duration || 0);
    const cur = Number(video.currentTime || 0);
    const pct = dur > 0 ? Math.min(100, Math.floor(cur / dur * 100)) : 0;
    const qctl = qualityControl();
    if (qctl && (currentQuality(qctl) === QUALITY || !hasQualityItem(qctl, QUALITY))) {
      forceQuality = false;
    }
    if ((cur < 30 || forceQuality) && qualityTries < 2 && maybeQuality()) {
      qualityTries += 1;
      forceQuality = false;
      endAt = 0;
      setStatus(`\u5207\u6362\u753B\u8D28 ${QUALITY}`);
      await sleep(1200);
      return;
    }
    if (!video.ended && !(dur > 0 && cur >= dur - 0.5)) {
      endAt = 0;
      if (video.paused) {
        movedAt = 0;
        if (Date.now() < userPauseUntil) {
          setStatus(`已让位：你手动暂停了视频，${Math.ceil((userPauseUntil - Date.now()) / 1000)}s 后恢复值守`);
          return;
        }
        const how = await ensurePlay(video);
        setStatus(how === "fail" ? `\u64AD\u653E\u88AB\u62E6\u622A, \u91CD\u8BD5\u4E2D\uFF08${pct}%\uFF09` : `\u7EED\u64AD ${pct}%`);
        return;
      }
      if (lastCur >= 0 && cur - lastCur < 0.05) {
        if (movedAt && Date.now() - movedAt > 8e3) {
          await ensurePlay(video);
          movedAt = Date.now();
          setStatus(`\u64AD\u653E\u505C\u987F ${pct}%, \u5DF2\u91CD\u65B0\u62C9\u8D77`);
        }
      } else {
        lastCur = cur;
        movedAt = Date.now();
      }
      setStatus(`\u64AD\u653E\u4E2D ${pct}% \xB7 ${fmtSec(cur)} / ${fmtSec(dur)}`);
      return;
    }
    if (!endAt) {
      endAt = Date.now();
      ackAt = 0;
      ackSecs = null;
    }
    const waited = Date.now() - endAt;
    if (!ackAt || Date.now() - ackAt > 5e3) {
      ackAt = Date.now();
      ackSecs = await fetchProgress(courseId);
    }
    const myId = secId.replace(/^.*finishStatus-/, "");
    const idx = sec ? sections().indexOf(sec) : -1;
    const mine = myId && ackSecs?.find((s) => s.section_id === myId) || (idx >= 0 ? ackSecs?.[idx] : void 0) || null;
    const acked = !!(mine && (mine.finish === 2 || mine.finish === 4) && mine.rate >= 100 || sec && secDone(sec));
    setStatus(acked ? `\u672C\u8282 100%\uFF08\u5E73\u53F0\u5DF2\u8BB0\u8D26\uFF09, \u5207\u4E0B\u4E00\u8282` : `\u672C\u8282\u5DF2\u64AD\u5230 100%, \u7B49\u5E73\u53F0\u8BB0\u8D26\u2026\uFF08${Math.round(waited / 1e3)}s\uFF09`);
    if (!acked && waited < 45e3) return;
    const replayKey = `replay:${courseId}:${myId || idx}`;
    if (!acked) {
      const tries = ssGet(replayKey);
      if (tries < 3 && sec) {
        ssSet(replayKey, tries + 1);
        clickSection(sec);
        resetTick();
        setStatus(`\u5E73\u53F0\u672A\u8BB0\u8D26, \u91CD\u8FDB\u672C\u8282\u7EED\u64AD\uFF08${tries + 1}/3\uFF09`);
        return;
      }
    }
    const nxt = nextSection();
    if (nxt) {
      clickSection(nxt);
      resetTick();
      setStatus("\u672C\u8282 100%, \u5207\u4E0B\u4E00\u8282");
      return;
    }
    await finishCourse(courseId, acked ? "\u5168\u90E8\u5C0F\u8282\u5DF2\u770B\u5B8C" : "\u672B\u8282\u5DF2\u64AD\u5B8C\u4ECD\u672A\u89C1\u5E73\u53F0\u8BB0\u8D26");
  };
  var finishCourse = async (courseId, why) => {
    const api = globalThis.browser || globalThis.chrome;
    const subjectId = location.hash.match(SUBJECT_SECTION_RE)?.[1] || ssGetS(`subjOf:${courseId}`) || "";
    if (subjectId) {
      if (ssGet(`done:${courseId}`) === 1) {
        const secs2 = await fetchProgress(courseId);
        const done2 = allDoneByApi(secs2);
        const detail2 = done2 === null ? "" : done2 ? ", \u5E73\u53F0\u5DF2\u786E\u8BA4 100%" : "";
        setStatus(`\u4E13\u9898\u6240\u6709\u5C0F\u8282\u5DF2\u5B8C\u6210\uFF08${why}${detail2}\uFF09\u2192 \u4E0B\u4E00\u95E8`);
        try {
          await api?.runtime?.sendMessage?.({ type: "AUTOPILOT_COURSE_DONE", courseId, verified: done2 })?.catch?.(() => {
          });
        } catch {
        }
        return;
      }
      ssSet(`done:${courseId}`, 1);
      setStatus("\u672C\u8282 100%, \u56DE\u4E13\u9898\u9875\u8FDB\u4E0B\u4E00\u8282");
      try {
        location.hash = subjectHash(subjectId);
      } catch {
      }
      return;
    }
    if (ssGet(`done:${courseId}`) === 1) return;
    ssSet(`done:${courseId}`, 1);
    const secs = await fetchProgress(courseId);
    const done = allDoneByApi(secs);
    const detail = done === null ? "" : done ? ", \u5E73\u53F0\u5DF2\u786E\u8BA4 100%" : ", \u5E73\u53F0\u4ECD\u672A\u5168\u90E8\u5224\u5B9A\u5B8C\u6210";
    setStatus(`\u672C\u8BFE\u7ED3\u675F\uFF08${why}${detail}\uFF09\u2192 \u4E0B\u4E00\u95E8`);
    try {
      await api?.runtime?.sendMessage?.({ type: "AUTOPILOT_COURSE_DONE", courseId, verified: done })?.catch?.(() => {
      });
    } catch {
    }
  };
  __script.main();
})();

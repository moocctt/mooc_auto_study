// ==UserScript==
// @name         烟草网络学院 · 快速刷课学习助手
// @namespace    https://github.com/gandli/tobacco-mooc-study
// @version      1.1.2
// @license      MIT
// @homepageURL  https://github.com/moocctt/mooc_auto_study
// @supportURL   https://github.com/moocctt/mooc_auto_study/issues
// @description  快速模式刷课：按单档秒数回填开始时间、快速批量上报（600s/轮、轮间仅歇 1 秒），一门课几分钟刷完。与「无人值守学习助手」互斥运行。非官方工具，使用风险自担。
// @author       tobacco-mooc-study
// @match        https://mooc.ctt.cn/
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/**
 * 快速刷课（油猴版）
 * ==================
 * 与「无人值守学习助手」(tobacco-mooc-unattended.user.js) 的差别只在推进节奏：
 *
 *   真实版: 30s/轮, studyTime == 真实流逝秒数, 页面挂够时长才完成
 *   快速版: 单档 600s/轮(可调), createTime 回填为「当前时间 - (档长 + 随机 60~300s)」,
 *           轮间只歇 0.6~1.6 秒 —— 一节 30 分钟的课 ≈ 3 轮 ≈ 半分钟刷完
 *
 * 其余协议完全一致: 令牌自动捕获 / 401 自动重登(AES-128-ECB) / 配额检测 / 考试类跳过 / 关联课程递归。
 * 两个脚本通过 window.__MOOC_US_LOCK 互斥, 同一页面只会有一方在跑。
 *
 * ⚠️ 快速模式上报的学习秒数大于真实流逝秒数, 属平台条款灰区, 请自行评估后果。
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- 常量
  const ORIGIN = 'https://mooc.ctt.cn';
  const API = {
    LOGIN: '/oauth/api/v1/app-login',
    TASKS: '/api/v1/human/task',
    START: '/api/v1/course-study/course-front/start-progress',
    VIDEO: '/api/v1/course-study/course-front/video-progress',
    DOC: '/api/v1/course-study/course-front/doc-progress',
    PROGRESS_UPD: '/api/v1/course-study/course-front/course-progress-update',
    CHAPTERS: '/api/v1/course-study/subject/chapter-progress',
    REGISTER: '/api/v1/course-study/course-front/register',
    SECTION_PROGRESS: '/api/v1/course-study/course-front/course-section-progress',
    INFO: '/api/v1/course-study/course-front/info',
    REGISTER_STUDY: '/api/v1/course-study/course-front/registerStudy',
  };
  const MEDIA = new Set([5, 6]);
  const NESTED = 10;
  const SKIP = new Set([4, 8, 9, 12, 13, 15]); // exam/survey/assessment 需真实作答; scorm/kj 暂无上报协议 —— 均无法自动完成
  const DONE = new Set([2, 4]);              // 完成态 finishStatus（注意: 与 SKIP 里的数字含义不同, 勿混用）
  const TYPE_NAME = { 1: 'pdf', 2: '图片', 3: '外链', 4: 'scorm', 5: 'mp3', 6: 'mp4', 7: 'epub', 8: '任务', 9: '考试', 10: '关联课程', 12: '问卷', 13: '评估', 15: '课件' };

  // ---------------------------------------------------------------- AES-128-ECB（登录加密用，与扩展 crypto.ts 同款）
  const KEY = new Uint8Array(16);
  for (let i = 0; i < 16; i++) KEY[i] = parseInt('64386367386756616b45713941677570'.substr(i * 2, 2), 16);
  const SBOX = new Uint8Array(256);
  const rotl = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
  function mul(a, b) { let p = 0; for (let i = 0; i < 8; i++) { if (b & 1) p ^= a; const hi = a & 0x80; a = (a << 1) & 0xff; if (hi) a ^= 0x1b; b >>= 1; } return p; }
  (function build() {
    function inv(a) { let r = 1; for (let i = 0; i < 8; i++) { r = mul(r, r); if (i < 7) r = mul(r, a); } return r; }
    for (let x = 0; x < 256; x++) {
      const v = x === 0 ? inv(0) : inv(x);
      SBOX[x] = v ^ rotl(v, 1) ^ rotl(v, 2) ^ rotl(v, 3) ^ rotl(v, 4) ^ 0x63;
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
  function rcon(n) { let v = 1; for (let i = 1; i < n; i++) v = mul(v, 2); return v; }
  const RK = expandKey(KEY);
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
    const pad = 16 - (raw.length % 16);
    const padded = new Uint8Array(raw.length + pad);
    padded.set(raw);
    padded.fill(pad, raw.length);
    const out = new Uint8Array(padded.length);
    for (let i = 0; i < padded.length; i += 16) encryptBlock(padded.subarray(i, i + 16), out, i);
    let bin = '';
    for (const b of out) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // ---------------------------------------------------------------- 登录指纹
  const DEVICES = [
    { brand: 'Xiaomi', model: '23127PN0CC', android: 14 }, { brand: 'HUAWEI', model: 'NOH-AN00', android: 12 },
    { brand: 'OPPO', model: 'PHA120', android: 13 }, { brand: 'vivo', model: 'V2227A', android: 13 },
    { brand: 'HONOR', model: 'PGT-AN10', android: 13 }, { brand: 'realme', model: 'RMX3706', android: 14 },
    { brand: 'OnePlus', model: 'PJD110', android: 14 }, { brand: 'Google', model: 'Pixel 7', android: 14 },
    { brand: 'samsung', model: 'SM-S9180', android: 13 }, { brand: 'motorola', model: 'XT2301-3', android: 13 },
  ];
  const SYSTEMS = ['Linux armv8l', 'Linux aarch64'];
  function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function fingerprintFor(seed) {
    const h = hash32(seed && String(seed).trim() ? String(seed).trim() : 'default');
    const device = DEVICES[h % DEVICES.length];
    return { terminal: device.brand, system: SYSTEMS[(h >>> 8) % SYSTEMS.length] };
  }

  // ---------------------------------------------------------------- 令牌捕获
  let token = null;
  let tokenWaiters = [];
  function setToken(v) {
    if (!v || v === token) return;
    token = v;
    log(`令牌已捕获 (${v.slice(-8)})`);
    const ws = tokenWaiters; tokenWaiters = [];
    ws.forEach((w) => w());
  }
  function waitToken(ms = 30000) {
    if (token) return Promise.resolve();
    tokenFromStorage();               // 兜底: 页面把令牌存在 localStorage.token
    if (token) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {    // 超时拒绝而不是裸发请求 —— 没有令牌的请求注定 401
        tokenWaiters = [];
        reject(new Error('未捕获到令牌: 页面未发出带授权头的请求, 且 localStorage 无令牌'));
      }, ms);
      tokenWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  // 平台 SPA 会把登录令牌写入 localStorage.token ({"access_token":...,"token_type":"Bearer"})。
  // 返回 true 表示令牌发生了更新 —— 401 时回读可拿到其他标签页刚刷新的令牌。
  function tokenFromStorage() {
    try {
      const raw = localStorage.getItem('token');
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj || !obj.access_token) return false;
      const v = `${obj.token_type || 'Bearer'}__${obj.access_token}`;
      if (v === token) return false;
      setToken(v);
      return true;
    } catch { return false; }
  }
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (/^authorization$/i.test(k) && /^Bearer/.test(String(v))) setToken(String(v)); } catch {}
    return origSetHeader.call(this, k, v);
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const h = (init && init.headers) || (input && input.headers);
      if (h) {
        const get = (k) => (typeof h.get === 'function' ? h.get(k) : h[k]);
        const v = get('Authorization') || get('authorization');
        if (v && /^Bearer/.test(String(v))) setToken(String(v));
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  // ---------------------------------------------------------------- API 客户端
  const AUTH_CODES = new Set([90901, 90902]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pystr = (v) => (v === true ? 'True' : v === false ? 'False' : v === null || v === undefined ? '' : String(v));
  const qs = (params) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) sp.append(k, pystr(v));
    return sp.toString();
  };
  const form = (data) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(data || {})) if (v !== null && v !== undefined) sp.append(k, pystr(v));
    return sp;
  };

  async function relogin() {
    const acc = GM_getValue('account');
    if (!acc || !acc.username || !acc.password) return null;
    const fp = fingerprintFor(acc.username);
    const body = form({
      username: encField(acc.username), pword: encField(acc.password),
      // 换单位可在油猴菜单「设置单位名称」改（默认全行业）
      company_name: encField(GM_getValue('companyName') || '全行业'), login_method: encField('login-by-user'),
      client_id: encField(999), displayDynamic: encField(true),
      terminal: encField(fp.terminal), system: encField(fp.system), captcha: '',
    });
    const res = await fetch(ORIGIN + API.LOGIN, {
      method: 'POST', body, credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json;charset=UTF-8' },
    });
    const text = await res.text();
    let data = null;
    if (text.trimStart().startsWith('{')) { try { data = JSON.parse(text); } catch {} }
    if (!data || !data.access_token) { log(`重登失败 (HTTP ${res.status})`); return null; }
    setToken(`${data.token_type || 'Bearer'}__${data.access_token}`);
    log('重登成功');
    return data;
  }

  async function req(method, path, { params, data } = {}, retried = false) {
    await waitToken();
    const url = ORIGIN + path + (params ? `?${qs(params)}` : '');
    const res = await fetch(url, {
      method: method.toUpperCase(),
      body: data ? form(data) : undefined,
      credentials: 'include',
      headers: { Authorization: token, Accept: 'application/json;charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const text = await res.text();
    let body = null;
    if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) { try { body = JSON.parse(text); } catch {} }
    const authError = res.status === 401 || (body && AUTH_CODES.has(body.errorCode));
    if (authError && !retried) {
      const before = token;
      tokenFromStorage();               // 别的标签页可能刚重新登录过
      if (token && token !== before) {
        log('已回读 localStorage 中的新鲜令牌, 重试请求');
        return req(method, path, { params, data }, true);
      }
      log('登录态失效, 尝试重登…');
      const nt = await relogin();
      if (nt) return req(method, path, { params, data }, true);
      const err = new Error('登录态失效且无保存的账密/新鲜令牌 —— 请刷新页面重试, 或在油猴菜单「保存账号密码」后重试');
      err.auth = true;                 // 让上层终止整轮, 而不是逐个小节空等
      throw err;
    }
    return [res.status, body];
  }

  // ---------------------------------------------------------------- 引擎（快速节奏）
  const state = { running: false, stopFlag: false, course: '', section: '', round: 0, submitted: 0, collapsed: false, pinned: false, stacked: false };
  class QuotaExhausted extends Error {}
  const chunk = () => Math.max(30, Number(GM_getValue('chunk', 600)) || 600);

  async function undoneTasks() {
    const all = [];
    const seen = new Set();
    for (let page = 1; page <= 10; page++) {
      const [code, body] = await req('GET', API.TASKS, { params: { page, pageSize: 500, status: '', filterAuthExam: 1 } });
      if (code !== 200 || !body) throw new Error(`任务列表请求失败 (HTTP ${code})`); // 别把失败伪装成"没有任务"
      const items = body.items || [];
      for (const t of items) if (!seen.has(t.id)) { seen.add(t.id); all.push(t); }
      if (!items.length || items.length < 500 || all.length >= (body.total || 0)) break;
    }
    return all.filter((t) =>
      [1, 2].includes(t.status) && [1, 2].includes(t.businessType)
      && !DONE.has(t.finishStatus) && !t.expired);
  }

  async function sections(courseId, versionId, register) {
    const [code, body] = await req('GET', API.CHAPTERS, { params: { courseId, versionId, isRegister: register } });
    if (code !== 200 || !Array.isArray(body)) throw new Error(`章节列表请求失败 (HTTP ${code})`); // 失败不能当"没有小节"
    const out = [];
    for (const ch of body) {
      for (const sec of ch.courseChapterSections || []) {
        const p = sec.progress || {};
        out.push({
          id: sec.referenceId, rid: sec.resourceId, name: sec.name || sec.sectionName || '',
          type: sec.sectionType, finish: p.finishStatus ?? 0, studied: p.studyTotalTime || 0,
        });
      }
    }
    return out;
  }

  async function openCourse(courseId) {
    const [code, det] = await req('POST', API.REGISTER, { data: { courseId } });
    if (code !== 200 || typeof det !== 'object' || !det) return openLibraryCourse(courseId);
    return [det, await sections(courseId, det.versionId || '', det.register || false), false];
  }

  async function openLibraryCourse(courseId) {
    await req('POST', API.REGISTER_STUDY, { data: { courseId, type: 1, isRequired: 0 } });
    const [infoCode, det] = await req('GET', `${API.INFO}/${courseId}`, { params: { source: 1, type: 1 } });
    if (infoCode !== 200 || !det) throw new Error(`课程信息请求失败 (HTTP ${infoCode})`);
    const secs = [];
    const map = { pdf: 1, image: 2, url: 3, scorm: 4, mp3: 5, mp4: 6, epub: 7, task: 8, exam: 9, other: 10, survey: 12, assessment: 13, kj: 15 };
    for (const ch of (det && det.courseChapters) || []) {
      for (const sec of ch.courseChapterSections || []) {
        const ft = String(sec.fileType || '').toLowerCase();
        secs.push({ id: sec.id, rid: sec.attachmentId, name: sec.name || sec.sectionName || '', type: map[ft] ?? 0, finish: 0, studied: 0 });
      }
    }
    return [Object.assign(det || {}, { _library: true }), secs, true];
  }

  async function startProgress(sectionId, backdateS, clientType) {
    const ct = Date.now() - Math.trunc(backdateS * 1000);
    const [code, body] = await req('GET', `${API.START}/${sectionId}`, { params: { clientType, createTime: ct } });
    if (code !== 200 || !body || !body.id) return [null, null];
    return [body.id, body.remainingTime ?? null];
  }

  async function progressUpdate(courseId) {
    await req('POST', API.PROGRESS_UPD, { data: { encrypt: 'false', courseId } });
  }

  async function settleNested(parentId, childId, sectionId, tries = 4) {
    await req('POST', API.SECTION_PROGRESS, { data: { courseId: parentId, resourceIds: childId } });
    for (let i = 0; i < tries; i++) {
      if (state.stopFlag) return false;
      const [logId] = await startProgress(sectionId, 3600, 1);
      if (logId) {
        const [, body] = await req('POST', API.DOC, { data: { encrypt: 'false', logId } });
        if (body && DONE.has(body.finishStatus)) return true;
      }
      await sleep(rand(2500, 4000));
    }
    const [, rows] = await req('POST', API.SECTION_PROGRESS, { data: { courseId: parentId, resourceIds: childId } });
    return Array.isArray(rows) && rows.length ? DONE.has(rows[0].finishStatus) : false;
  }

  /** 单个小节: 快速推进。返回 [完成?, 消息] */
  async function doSection(sec, { depth = 0, courseId, library = false }) {
    if (SKIP.has(sec.type)) {
      const human = [9, 12, 13].includes(sec.type);   // 考试/问卷/评估 需作答; 其余是无上报协议
      return [false, `${TYPE_NAME[sec.type] || sec.type} ${human ? '需真实作答' : '暂无上报协议'}, 跳过`];
    }
    if (DONE.has(sec.finish)) return [true, '已完成, 跳过'];
    if (sec.type === NESTED) {
      if (depth >= 2) return [false, '嵌套过深, 跳过'];
      const parentCourse = state.course;
      log(`↳ 关联课程 ${sec.rid}`);
      const [done, total] = await runCourse(sec.rid, depth + 1);
      state.course = parentCourse;      // 子课程会改写 state.course, 恢复父课程名
      if (done < total) return [false, `子课程未完成 ${done}/${total}`];
      const settled = await settleNested(courseId, sec.rid, sec.id);
      return [settled, settled ? '子课程完成, 父记录已结算' : '子课程完成, 父记录结算未确认(稍后复核)'];
    }

    const step0 = chunk();
    let total = null, submitted = 0, prevRem = null, stuck = 0, maxRounds = 0;
    for (let i = 0; ; i++) {
      if (state.stopFlag) return [false, '已停止'];
      if (maxRounds && i >= maxRounds) return [false, `轮次用完 (已提交 ${submitted}s)`];
      state.round = i + 1;
      // 快速模式: createTime 回填「当前时间 - (档长 + 随机 1~5 分钟)」, 模拟更早开始学习
      const [logId, remRaw] = await startProgress(sec.id, step0 + Math.trunc(rand(60, 300)), library ? 0 : 1);
      if (logId === null) return [false, 'start-progress 失败'];
      if (remRaw === null) return [false, '接口未返回剩余时长, 无法确认完成'];
      const rem = remRaw;
      if (rem <= 0) {
        if (submitted || sec.studied) return [true, `时长已用完（共 ${submitted}s）`];
        return [true, '该小节无剩余时长'];
      }
      if (prevRem !== null && rem >= prevRem) {
        stuck += 1;
        if (stuck >= 2) throw new QuotaExhausted(`剩余时长未下降 (${prevRem}→${rem}) —— 判定当日学时配额已满`);
      } else stuck = 0;
      prevRem = rem;

      if (total === null) {
        total = rem + sec.studied;
        maxRounds = Math.ceil(total / step0) + 5;   // 按剩余时长动态算上限
      }
      const step = Math.min(step0, rem);
      const loc = Math.min(total, total - rem + step);
      const isMedia = MEDIA.has(sec.type);
      const [code, body] = isMedia
        ? await req('POST', API.VIDEO, { data: { encrypt: 'false', logId, studyTime: Math.trunc(step), lessonLocation: Math.trunc(loc), resourceTotalTime: Math.trunc(total), flush: 'false' } })
        : await req('POST', API.DOC, { data: { encrypt: 'false', logId, lessonLocation: Math.trunc(loc) } });

      if (code !== 200) {
        if (body && body.errorCode === 40909) { await sleep(1000); continue; }
        return [false, `上报失败 HTTP ${code}`];
      }
      submitted += step;
      state.submitted = submitted;
      if (courseId) await progressUpdate(courseId);
      ui();
      if (body && DONE.has(body.finishStatus)) return [true, `完成, ${i + 1} 轮 / ${submitted}s`];
      await sleep(rand(600, 1600));   // 快速模式: 轮间只歇约 1 秒
    }
  }

  async function runCourse(courseId, depth = 0) {
    const [det, secs, library] = await openCourse(courseId);
    state.course = (det && det.name) || courseId;
    log(`===== ${state.course} =====`);
    const todo = secs.filter((s) => !DONE.has(s.finish));
    log(`小节 ${secs.length} 个, 待处理 ${todo.length} | 单档 ${chunk()}s`);
    if (!secs.length) { log('⚠ 章节列表为空(接口异常或课程无小节), 按未完成处理'); return [0, 1]; }
    let ok = 0, skipped = 0;
    for (let i = 0; i < todo.length; i++) {
      if (state.stopFlag) break;
      const sec = todo[i];
      state.section = `${i + 1}/${todo.length} (${TYPE_NAME[sec.type] || sec.type}) ${String(sec.name).slice(0, 30)}`;
      state.round = 0; state.submitted = 0;
      ui();
      log(`[${i + 1}/${todo.length}] ${state.section}`);
      try {
        const [good, msg] = await doSection(sec, { depth, courseId, library });
        if (good) ok += 1;
        else if (SKIP.has(sec.type)) skipped += 1;   // 不支持类型不算"未完成", 否则父课程永远结不了
        log(`   → ${msg}`);
      } catch (e) {
        if (e instanceof QuotaExhausted) { if (depth === 0) log('[配额] ' + e.message + ', 终止全部'); throw e; }
        if (e.auth) throw e;                         // 鉴权失败: 整轮终止, 不逐节空等
        log(`   ✗ ${e.message}`);
      }
    }
    return [ok, todo.length - skipped];
  }

  // 锁值带随机后缀: 只有拿到锁的那一轮流程才能释放它（防止先结束的一方清掉另一方的锁）
  const MY_LOCK = 'fast#' + Math.random().toString(36).slice(2, 8);
  const lockOwner = () => (window.__MOOC_US_LOCK && window.__MOOC_US_LOCK !== MY_LOCK
    ? (String(window.__MOOC_US_LOCK).startsWith('realtime') ? '另一个脚本' : '另一条任务')
    : '');

  async function runFast() {
    // 互斥锁: 任何一方持有(另一脚本/另一条任务)都拒绝 —— 同页两条流程会共享 state 互相踩踏
    const owner = lockOwner();
    if (owner || state.running) {
      log(`✗ ${owner || '当前任务'}正在运行, 请先停止它`);
      return;
    }
    window.__MOOC_US_LOCK = MY_LOCK;
    state.running = true; state.stopFlag = false;
    ui();
    log(`⚡ 快速模式: 单档 ${chunk()}s, 回填开始时间, 轮间歇 ~1s`);
    let failCount = 0, quotaHit = false;
    // 页面类型决定跑什么: 课程/专题详情页 → 刷当前页面; 其他页面 → 执行个人学习任务
    const bid = currentBidFromHash();
    const mode = bid ? 'course' : 'tasks';
    try {
      if (bid) {
        log('当前为课程/专题页 → 快速刷本课程/专题');
        try {
          const [ok, total] = await runCourse(bid);
          if (state.stopFlag) log(`■ 已停止 (${ok}/${total})`);
          else if (ok < total) { failCount += 1; log(`⚠ 未完成 (${ok}/${total})`); }
        } catch (e) {
          if (e instanceof QuotaExhausted) quotaHit = true;   // 收尾统一报配额, 避免重复日志
          else if (e.auth) throw e;
          else { failCount += 1; log(`✗ 课程失败: ${e.message}`); }
        }
      } else {
        const tasks = await undoneTasks();
        log(`当前不是课程/专题页 → 执行个人学习任务: 未完成 ${tasks.length} 门`);
        if (!tasks.length) log('没有未完成的学习任务');
        for (const t of tasks) {
          if (state.stopFlag) { log('已停止'); break; }
          try {
            const [ok, total] = await runCourse(t.businessId);
            if (ok < total) { failCount += 1; log(`⚠ ${String(t.name || '').slice(0, 20)} 未完成 (${ok}/${total})`); }
          }
          catch (e) {
            if (e instanceof QuotaExhausted) { quotaHit = true; break; }   // 配额是"终止态", 不算某门课失败
            if (e.auth) throw e;
            failCount += 1;
            log(`✗ 课程失败: ${e.message}`);
          }
          await sleep(rand(1500, 3000));
        }
      }
      if (quotaHit) log('⚠ 学时配额已满, 已停止 (次日再试)');
      else if (!state.stopFlag) {
        if (mode === 'course') log(failCount ? `⚠ 本课程/专题处理完毕 (失败 ${failCount} 处)` : '✅ 本课程/专题处理完毕');
        else log(failCount ? `⚠ 全部任务处理完毕 (失败 ${failCount} 门)` : '✅ 全部任务处理完毕');
      }
    } catch (e) {
      log(`✗ ${e.message}`);
    } finally {
      state.running = false; state.course = ''; state.section = '';
      if (window.__MOOC_US_LOCK === MY_LOCK) window.__MOOC_US_LOCK = null;
      ui();
    }
  }

  /** 只刷一门（面板「学习当前页」按钮）: 带互斥锁, 完成或失败后释放 */
  async function runSingle(bid) {
    const owner = lockOwner();
    if (owner || state.running) {
      log(`✗ ${owner || '当前任务'}正在运行, 请先停止它`);
      return;
    }
    window.__MOOC_US_LOCK = MY_LOCK;
    state.running = true; state.stopFlag = false;
    ui();
    try {
      const [done, total] = await runCourse(bid);
      if (state.stopFlag) log(`■ 已停止 (${done}/${total})`);
      else if (done < total) log(`⚠ 未完全完成 (${done}/${total}) —— 部分小节失败或被跳过`);
      else log('✅ 当前页面课程/专题处理完毕');
    } catch (e) {
      log(e instanceof QuotaExhausted ? '[配额] ' + e.message : `✗ ${e.message}`);
    } finally {
      state.running = false; state.course = ''; state.section = '';
      if (window.__MOOC_US_LOCK === MY_LOCK) window.__MOOC_US_LOCK = null;
      ui();
    }
  }

  // ---------------------------------------------------------------- 播放器偏好（运行中生效）
  // 静音: 直接置 video 属性（比点按钮稳, 播放器/平台重设音量时下一拍会压回）;
  // 普清: 平台用 video.js 自建画质菜单(.vjs-subs-caps-button 内 li: 普清/高清/原图,
  //       按钮文案 = 当前画质)。切画质会重载视频源, 所以同一个源最多尝试 2 次。
  const QUALITY = '普清';
  const qualityTried = new Map();
  function applyPlayerPrefs() {
    if (!state.running) return;
    let video = null;
    document.querySelectorAll('video').forEach((v) => {
      video = v;
      if (!v.muted) v.muted = true;
      if (v.volume !== 0) { try { v.volume = 0; } catch { /* ignore */ } }
    });
    const box = document.querySelector('.vjs-subs-caps-button');
    if (!box || !video) return;
    const cur = ((box.querySelector('.vjs-control-text') || {}).textContent || '').trim();
    if (!cur || cur === QUALITY) return;
    const key = video.currentSrc || location.hash;
    const tried = qualityTried.get(key) || 0;
    if (tried >= 2) return;
    const item = Array.from(box.querySelectorAll('.vjs-menu-item'))
      .find((el) => (el.textContent || '').trim() === QUALITY);
    if (!item) return;
    qualityTried.set(key, tried + 1);   // 先记账再点: 切源会换 currentSrc, 避免连点
    item.click();
    log(`画质 → ${QUALITY}`);
  }
  setInterval(applyPlayerPrefs, 3000);

  // ---------------------------------------------------------------- UI
  let box, logEl, statusEl, btnStart;
  function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (logEl) {
      const line = document.createElement('div');
      line.textContent = `[${t}] ${msg}`;
      logEl.appendChild(line);
      while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log(`[快速刷课] ${msg}`);
  }
  function ui() {
    if (!statusEl) return;
    statusEl.textContent = state.running
      ? `⚡ ${state.course || '准备中'} | ${state.section || ''} | 轮 ${state.round} | 已报 ${state.submitted}s`
      : (lockOwner() ? '■ 已停止 (另一任务/脚本运行中)'
        : (currentBidFromHash() ? '■ 已停止 · 当前页课程/专题' : '■ 已停止 · 个人学习任务'));
    btnStart.textContent = state.running ? '⏸ 停止'
      : (currentBidFromHash() ? '⚡ 刷本课程/专题' : '⚡ 执行学习任务');
  }
  // 计算面板 top: 避开网站顶栏 —— 找视口顶部第一个 fixed/sticky 元素, 取其底边 + 8px;
  // 量不到时退回 64px（平台顶栏常见高度）。
  function headerOffset() {
    try {
      const els = document.elementsFromPoint(1, 1);
      for (const el of els) {
        if (el === document.documentElement || el === document.body) continue;
        const cs = getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'sticky') && el.offsetHeight > 0 && el.offsetHeight < 200)
          return el.getBoundingClientRect().bottom + 8;
      }
    } catch { /* ignore */ }
    return 64;
  }
  // 从网站顶栏提取主题色: 找到顶栏元素后, 在其自身及后代里找第一个不透明、非纯白的
  // 背景色; 量不到时退回默认色。light = 背景偏深(可用白字), 否则用深色文字。
  function headerColor(fallback) {
    try {
      const els = document.elementsFromPoint(1, 1);
      const top = els.find((el) => {
        if (el === document.documentElement || el === document.body) return false;
        const cs = getComputedStyle(el);
        return (cs.position === 'fixed' || cs.position === 'sticky') && el.offsetHeight > 0 && el.offsetHeight < 200;
      });
      if (top) {
        for (const el of [top, ...top.querySelectorAll('*')]) {
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/);
          if (!m) continue;
          if (m[4] !== undefined && parseFloat(m[4]) < 1) continue;      // 半透明拿不准真实色
          const [r, g, b] = [+m[1], +m[2], +m[3]];
          if (r > 246 && g > 246 && b > 246) continue;                   // 纯白不算主题色
          return { bg, light: 0.299 * r + 0.587 * g + 0.114 * b < 160 };
        }
      }
    } catch { /* ignore */ }
    return { bg: fallback, light: true };
  }
  // 标题栏拖动: 移动超过 4px 判为拖拽(切换为 left/top 定位, 松手持久化到 GM 存储),
  // 未超过判为点击 → 折叠/展开。折叠态(只剩标题条)同样可拖。
  function makeDraggable(head, panel, onToggle) {
    let sx = 0, sy = 0, px = 0, py = 0, moved = false;
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; px = r.left; py = r.top; moved = false;
      const mv = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        state.pinned = true;   // 一开始拖动就固定: 叠放模式 2s tick 不能在拖动中途把面板拉回去
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const left = Math.min(Math.max(0, px + dx), window.innerWidth - w);
        const top = Math.min(Math.max(0, py + dy), window.innerHeight - h);
        panel.style.left = left + 'px'; panel.style.top = top + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        if (moved) { state.pinned = true; GM_setValue('pos', { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) }); }
        else onToggle();
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    head.addEventListener('click', (e) => e.preventDefault());
  }
  function setCollapsed(c) {
    state.collapsed = c;
    GM_setValue('collapsed', c);
    if (!box) return;
    const body = box.querySelector('.uf-body');
    body.style.display = c ? 'none' : '';
    box.style.width = c ? 'auto' : '340px';
    box.style.borderRadius = c ? '8px' : '';
    box.querySelector('.uf-toggle').textContent = c ? '▣' : '—';
    box.title = c ? '点击标题栏展开' : '点击标题栏折叠';
  }
  function mount() {
    if (box) return;
    const theme = headerColor('#b35900');
    const fg = theme.light ? '#fff' : '#1f2328';
    // 两个脚本同时启用时避免面板完全重叠: 检测到对方面板就叠在它下方
    const buddy = document.querySelector('.um-head, .uf-head');
    const baseTop = buddy
      ? Math.round(buddy.parentElement.getBoundingClientRect().bottom + 12)
      : headerOffset();
    if (buddy) state.stacked = true;   // 叠放在对方面板下方；位置由 watchTheme 每轮重算
    box = document.createElement('div');
    box.style.cssText = `position:fixed;top:${baseTop}px;right:12px;z-index:999999;width:340px;background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:12px/1.5 monospace;color:#1f2328;`;
    box.innerHTML = `
      <div class="uf-head" style="padding:6px 10px;background:${theme.bg};color:${fg};border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none">
        <b>快速刷课学习助手</b><span class="uf-toggle" style="cursor:pointer">—</span>
      </div>
      <div class="uf-body">
        <div id="uf-status" style="padding:6px 10px;color:#57606a"></div>
        <div style="padding:0 10px 6px;display:flex;gap:6px">
          <button id="uf-start" style="flex:2;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;font:inherit;line-height:1;cursor:pointer;border:1px solid ${theme.bg};background:${theme.bg};color:${fg};border-radius:6px"></button>
          <button id="uf-here" title="快速刷完当前页面打开的课程/专题（不看任务列表）" style="flex:1;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;font:inherit;line-height:1;cursor:pointer;border:1px solid ${theme.bg};background:#fff;color:${theme.light ? theme.bg : '#1f2328'};border-radius:6px">刷当前页</button>
        </div>
        <div id="uf-log" style="height:180px;overflow-y:auto;padding:4px 10px;border-top:1px solid #eaeef2;white-space:pre-wrap"></div>
      </div>`;
    document.documentElement.appendChild(box);
    const pos = GM_getValue('pos');
    if (pos) { // 恢复上次拖放位置(钳制在视口内)
      box.style.left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - box.offsetWidth)) + 'px';
      box.style.top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - box.offsetHeight)) + 'px';
      box.style.right = 'auto';
      state.pinned = true;   // 用户定位过 → 换肤刷新不再改 top
    }
    logEl = box.querySelector('#uf-log');
    statusEl = box.querySelector('#uf-status');
    btnStart = box.querySelector('#uf-start');
    makeDraggable(box.querySelector('.uf-head'), box, () => setCollapsed(!state.collapsed));
    btnStart.onclick = (e) => {
      e.stopPropagation();
      if (state.running) { state.stopFlag = true; log('正在停止(等当前轮结束)…'); }
      else { setCollapsed(false); runFast(); }
    };
    box.querySelector('#uf-here').onclick = (e) => {
      e.stopPropagation();
      if (state.running) { log('已有任务在跑, 请先停止'); return; }
      const bid = currentBidFromHash();
      if (!bid) { log('✗ 当前页面不是课程/专题详情页, 无法定位学习目标'); return; }
      setCollapsed(false);
      runSingle(bid);
    };
    setCollapsed(!!GM_getValue('collapsed', false));
    ui();
    watchTheme();
  }
  // 顶栏主题色跟随: 平台按栏目换肤(顶栏色会变), 每 2s + hash 变化时重取顶栏色,
  // 变化才更新面板(标题栏/按钮同色 + top 偏移), 不变色不动 DOM。
  // 叠放模式(stacked, 检测到对方面板)每次 tick 重算位置 —— 对方折叠/展开/隐藏都能跟上。
  function watchTheme() {
    const FALLBACK = '#b35900';
    let last = '';
    const tick = () => {
      if (!box) return;
      ui();   // 对方开始/结束运行时也能及时更新"另一任务运行中"提示
      if (state.stacked && !state.pinned) {
        const buddy = Array.from(document.querySelectorAll('.um-head, .uf-head'))
          .find((el) => el.parentElement !== box);
        const rect = buddy && buddy.parentElement.getBoundingClientRect();
        if (rect && rect.height > 0) {
          const top = Math.min(Math.round(rect.bottom + 12), Math.max(0, window.innerHeight - box.offsetHeight));
          box.style.top = top + 'px';
        }
      }
      const theme = headerColor(FALLBACK);
      const key = theme.bg + (theme.light ? 'L' : 'D');
      if (key === last) return;
      last = key;
      const fg = theme.light ? '#fff' : '#1f2328';
      const head = box.querySelector('.uf-head');
      const btn = box.querySelector('#uf-start');
      head.style.background = theme.bg; head.style.color = fg;
      if (btn) { btn.style.background = theme.bg; btn.style.borderColor = theme.bg; btn.style.color = fg; }
      const here = box.querySelector('#uf-here');
      if (here) { here.style.borderColor = theme.bg; here.style.color = theme.light ? theme.bg : '#1f2328'; }
      if (!state.pinned && !state.stacked) box.style.top = headerOffset() + 'px'; // 用户拖过/叠放的 top 不被换肤刷新覆盖
    };
    tick();
    setInterval(tick, 2000);
    window.addEventListener('hashchange', tick);
  }
  GM_registerMenuCommand('显示/隐藏面板', () => { if (!box) mount(); else box.style.display = box.style.display === 'none' ? '' : 'none'; });
  GM_registerMenuCommand('单档秒数: ' + chunk() + 's（点击改为自定义）', () => {
    const v = prompt('每轮上报秒数（建议 60~1200，默认 600）:', String(chunk()));
    if (v && Number(v) >= 30) GM_setValue('chunk', Math.trunc(Number(v)));
  });
  GM_registerMenuCommand('设置单位名称（当前: ' + (GM_getValue('companyName') || '全行业') + '）', () => {
    const v = prompt('单位名称（登录用, 需与平台登录页一致, 留空回车恢复默认「全行业」）:', GM_getValue('companyName') || '全行业');
    if (v === null) return;
    GM_setValue('companyName', v.trim() || '全行业');
    alert('已保存: ' + (v.trim() || '全行业'));
  });
  GM_registerMenuCommand('保存账号密码（用于令牌失效自动重登）', () => {
    const u = prompt('账号:');
    if (!u) return;
    const p = prompt('密码（将以明文保存在 Tampermonkey 本地存储, 仅本机使用）:');
    if (!p) return;
    GM_setValue('account', { username: u, password: p });
    alert('已保存到油猴存储（仅本机）。令牌失效时会自动重登。');
  });
  GM_registerMenuCommand('清除账号密码', () => { GM_deleteValue('account'); alert('已清除'); });

  // ---------------------------------------------------------------- 启动
  // 当前页面课程/专题 ID（与扩展 mooc-routes.ts 同款路由表）:
  //   课程 #/study/course/detail/<type>&<id>（专题小节播放页可带 /章/节/专题id, 取第一段 id）
  //   专题 #/study/subject/detail/<id>
  //   真实样例: #/study/course/detail/1&b14d1b30-31f2-4db7-9bd2-9bac2f06b264
  //             #/study/subject/detail/6a3153f5-9e94-4d26-926f-8aed05095341
  //   注: 课程与专题共用 register/chapter-progress 接口（ID 直接作 courseId, 真机已验证专题可跑通）
  function currentBidFromHash() {
    try {
      const h = decodeURIComponent(location.hash);
      const m = h.match(/course\/detail\/\d+&([^&/]+)/) || h.match(/subject\/detail\/([^&/?#]+)/);
      return m ? m[1] : '';
    } catch { return ''; }
  }
  // 调试/自动化测试入口（命名空间 realtime/fast, 避免两个脚本互相覆盖）。
  // 高级用户或端到端测试可用它直接驱动单门课程（runCourse 返回 [完成数, 总数]）。
  window.__MOOC_US_DEBUG__ = Object.assign(window.__MOOC_US_DEBUG__ || {}, {
    fast: { state, runCourse, runFast, runSingle, currentBidFromHash, log },
  });
  // 面板在全站自动出现: 课程/专题页 → 刷当前页面; 其他页面 → 执行个人学习任务。
  // 登录/注册页不挂载（无令牌时面板无意义）。主题色取自网站顶栏(.header)。
  const AUTH_PAGE_RE = /#\/(?:login|register|forget|auth)\b/i;
  const isAuthPage = () => AUTH_PAGE_RE.test(location.hash);
  function bootMount() {
    if (box || isAuthPage()) return;
    mount();
    log('就绪 —— 令牌会在页面自己发请求时自动捕获');
  }
  function boot() {
    bootMount();
    window.addEventListener('hashchange', bootMount);   // SPA 导航到任何页面都能补挂面板
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

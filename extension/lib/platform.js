import { encField } from "./crypto.js";
import { STORE } from "./flags.js";
import { LIBRARY_TYPES, rawTypeOf } from "./library.js";
import { fingerprintFor } from "./fingerprint.js";
import { PAGE_SIZE } from "./core.js";
let API_ORIGIN = "";
function setApiOrigin(origin) {
  API_ORIGIN = String(origin || "").replace(/\/+$/, "");
}
const apiUrl = (path) => `${API_ORIGIN}${path}`;
function resolveCover(it) {
  const path = it.coverPath || it.coverImage || it.coverUrl || it.img || it.pic || "";
  if (!path) return "";
  return /^https?:\/\//.test(path) ? path : `https://mooc.ctt.cn/${path}`;
}
const API_START = "/api/v1/course-study/course-front/start-progress";
const API_VIDEO = "/api/v1/course-study/course-front/video-progress";
const API_DOC = "/api/v1/course-study/course-front/doc-progress";
const API_PROGRESS_UPD = "/api/v1/course-study/course-front/course-progress-update";
const API_GLOBAL_SEARCH = "/api/v1/course-study/course-front/findPageForGlobalSearch";
const API_REGISTER = "/api/v1/course-study/course-front/register";
const API_CHAPTERS = "/api/v1/course-study/subject/chapter-progress";
const API_TASKS = "/api/v1/human/task";
const API_DETAIL_HOUR = "/api/v1/system/cadre-education/detail-hour-member";
const API_PERSON_COURSE = "/api/v1/course-study/course-study-progress/personCourse-list";
const API_COURSE_LOG = "/api/v1/course-study/course-study-progress/person-courselog";
const API_SUBJECT_LOG = "/api/v1/course-study/course-study-progress/subject-log";
const API_FILE = "/api/v1/course-study/file/info-app";
const API_SECTION_PROGRESS = "/api/v1/course-study/course-front/course-section-progress";
const LOGIN_URL = "/oauth/api/v1/app-login";
const CENTER_URL = "/api/v1/human/member/center";
const WS_PATH = "/api/v1/course-study/ws/course?token=";
const MEDIA_TYPES = /* @__PURE__ */ new Set([5, 6]);
const NESTED_TYPE = 10;
const SKIP_TYPES = /* @__PURE__ */ new Set([4, 8, 9, 12, 13, 15]);
const MAX_DEPTH = 2;
const API_COURSE_FRONT = "/api/v1/course-study/course-front";
const FTYPE = { mp4: 6, mp3: 5, pdf: 1, image: 2, url: 3, epub: 7 };
const DONE_FINISH = /* @__PURE__ */ new Set([2, 4]);
const FINISH_NAME = { 0: "\u672A\u5F00\u59CB", 1: "\u5B66\u4E60\u4E2D", 2: "\u5DF2\u5B8C\u6210(\u590D\u4E60)", 4: "\u5DF2\u5B8C\u6210" };
const TYPE_NAME = {
  1: "pdf",
  2: "image",
  3: "url",
  4: "scorm",
  5: "mp3",
  6: "mp4",
  7: "epub",
  8: "task",
  9: "exam",
  10: "other",
  12: "survey",
  13: "assessment",
  15: "kj"
};
class QuotaExhausted extends Error {
}
class AuthError extends Error {
}
const pystr = (v) => typeof v === "boolean" ? v ? "True" : "False" : v === null || v === void 0 ? "" : String(v);
function toQuery(params) {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === void 0) continue;
    sp.append(k, pystr(v));
  }
  return sp.toString();
}
function toForm(data) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(data || {})) {
    if (v === null || v === void 0) continue;
    sp.append(k, pystr(v));
  }
  return sp;
}
const AUTH_CODES = /* @__PURE__ */ new Set([90901, 90902]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
async function login({ username, password, fetchImpl = (u, i) => globalThis.fetch(u, i), accountKey }) {
  const fp = fingerprintFor(accountKey || username);
  const body = toForm({
    username: encField(username),
    pword: encField(password),
    company_name: encField("\u5168\u884C\u4E1A"),
    login_method: encField("login-by-user"),
    client_id: encField(999),
    displayDynamic: encField(true),
    terminal: encField(fp.terminal),
    system: encField(fp.system),
    captcha: ""
  });
  const res = await fetchImpl(apiUrl(LOGIN_URL), {
    method: "POST",
    body,
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json;charset=UTF-8"
    }
  });
  const text = await res.text();
  let data = null;
  if (text.trimStart().startsWith("{")) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!data) {
    const e = new Error(`\u5E73\u53F0\u62D2\u7EDD\u4E86\u672C\u6B21\u8BBF\u95EE (HTTP ${res.status})`);
    e.status = res.status;
    throw e;
  }
  if (!data.access_token) {
    const e = new Error(`\u767B\u5F55\u5931\u8D25 (HTTP ${res.status}): ${JSON.stringify(data)}`);
    e.status = res.status;
    e.errorCode = data.errorCode;
    throw e;
  }
  return data;
}
const AVATAR_KEYS = [
  "headPortraitPath",
  "headImg",
  "headImage",
  "headPhoto",
  "headPortraitUrl",
  "headUrl",
  "headPic",
  "avatar",
  "avatarUrl",
  "photo",
  "photoUrl",
  "userPhoto",
  "portrait",
  "imgUrl",
  "imageUrl",
  "image",
  "headPortrait"
];
const PLATFORM_HOST = "https://mooc.ctt.cn";
const SETTING_URL = "/api/v1/system/setting";
function normalizeAvatar(v) {
  if (/^(javascript|data|vbscript):/i.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/")) return `${PLATFORM_HOST}${v}`;
  if (/^[\w\-./]+$/.test(v)) return `${PLATFORM_HOST}/${v}`;
  return null;
}
function pickAvatar(src, depth = 0) {
  if (!src || typeof src !== "object" || depth > 4) return null;
  for (const k of AVATAR_KEYS) {
    const v = src[k];
    if (typeof v === "string" && v.trim()) {
      const ok = normalizeAvatar(v.trim());
      if (ok) return ok;
    }
  }
  for (const nest of ["memberDetail", "currentUser", "member", "user", "userInfo", "memberInfo", "data"]) {
    const got = pickAvatar(src[nest], depth + 1);
    if (got) return got;
  }
  return null;
}
async function profileFrom(path, token, fetchImpl) {
  try {
    const res = await fetchImpl(apiUrl(path), {
      credentials: "include",
      headers: {
        "Authorization": `${token.token_type || "Bearer"}__${token.access_token}`,
        "Accept": "application/json;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const json = await res.json();
    const root = json?.data && typeof json.data === "object" ? json.data : json;
    const displayName = root?.fullName || root?.name || json?.fullName || json?.name || null;
    return { displayName: displayName || null, avatar: pickAvatar(root) || pickAvatar(json) };
  } catch {
    return { displayName: null, avatar: null };
  }
}
async function fetchProfile(token, fetchImpl = (u, i) => globalThis.fetch(u, i)) {
  const primary = await profileFrom(CENTER_URL, token, fetchImpl);
  if (primary.avatar || !token?.access_token) return primary;
  const alt = await profileFrom(SETTING_URL, token, fetchImpl);
  return { displayName: primary.displayName || alt.displayName, avatar: alt.avatar || primary.avatar };
}
async function fetchDisplayName(token, fetchImpl = (u, i) => globalThis.fetch(u, i)) {
  return (await fetchProfile(token, fetchImpl)).displayName;
}
class PlatformClient {
  /**
   * @param {{ token: object, account: { key: string, username: string, password: string },
   *           fetchImpl?: Function, log?: Function, say?: Function,
   *           mode?: 'auto'|'audio'|'video', realtime?: boolean, chunk?: number,
   *           WebSocketImpl?: Function, reLogin?: Function }} opts
   */
  constructor(opts) {
    this.token = opts.token;
    this.account = opts.account;
    this.F = opts.fetchImpl || ((u, i) => globalThis.fetch(u, i));
    this.say = opts.say || opts.log || (() => {
    });
    this.mode = opts.mode || "auto";
    this.realtime = !!opts.realtime || STORE;
    this.chunk = opts.chunk || (this.mode === "audio" ? 300 : 600);
    this.WS = opts.WebSocketImpl || globalThis.WebSocket;
    this.reLogin = opts.reLogin;
    this.sleep = opts.sleepFn || sleep;
    this.wsOrigin = opts.wsOrigin || "";
    this.fp = fingerprintFor(opts.account.key);
    this.stopReason = null;
    this.mediaCache = /* @__PURE__ */ new Map();
  }
  headers() {
    return {
      "Authorization": `${this.token.token_type || "Bearer"}__${this.token.access_token}`,
      "Accept": "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    };
  }
  /** 登录态请求: 401 / 90901 / 90902 时重登一次 */
  async req(method, path, { params, data } = {}) {
    const send = async () => {
      const qs = toQuery(params);
      const res = await this.F(apiUrl(qs ? `${path}?${qs}` : path), {
        method: method.toUpperCase(),
        body: data ? toForm(data) : void 0,
        credentials: "include",
        headers: this.headers(),
        signal: AbortSignal.timeout(2e4)
      });
      const text = await res.text();
      let body2 = null;
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        try {
          body2 = JSON.parse(text);
        } catch {
          body2 = null;
        }
      }
      return [res.status, body2];
    };
    let [code, body] = await send();
    const authError = code === 401 || body && typeof body === "object" && AUTH_CODES.has(body.errorCode);
    if (authError) {
      if (!this.reLogin) throw new AuthError("\u767B\u5F55\u6001\u5DF2\u5931\u6548, \u8BF7\u91CD\u65B0\u767B\u5F55");
      this.token = await this.reLogin();
      [code, body] = await send();
    }
    return [code, body];
  }
  // ---------------------------------------------------------------- 数据
  async listTasks() {
    const [, body] = await this.req("GET", API_TASKS, {
      params: { page: 1, pageSize: 500, status: "", filterAuthExam: 1 }
    });
    const items = body && body.items || [];
    const seen = /* @__PURE__ */ new Set();
    return items.filter((t) => seen.has(t.id) ? false : (seen.add(t.id), true));
  }
  async sections(courseId, versionId, register) {
    const [code, body] = await this.req("GET", API_CHAPTERS, {
      params: { courseId, versionId, isRegister: register }
    });
    // 非 200/非数组（如空 versionId 触发的 422）必须抛错: 返回 [] 会被收尾重算算成 0/0 "全部完成"
    if (code !== 200 || !Array.isArray(body)) {
      throw new Error(`章节接口返回异常 (HTTP ${code})`);
    }
    const out = [];
    for (const ch of Array.isArray(body) ? body : []) {
      for (const sec of ch.courseChapterSections || []) {
        const p = sec.progress || {};
        out.push({
          section_id: sec.referenceId,
          resource_id: sec.resourceId,
          name: sec.name || sec.sectionName || "",
          type: sec.sectionType,
          finish: p.finishStatus ?? 0,
          rate: p.completedRate || 0,
          studied: p.studyTotalTime || 0
        });
      }
    }
    return out;
  }
  async openCourse(courseId) {
    const [code, det] = await this.req("POST", API_REGISTER, { data: { courseId } });
    if (code !== 200 || typeof det !== "object" || !det) {
      return this.openLibraryCourse(courseId);
    }
    const d = det || {};
    if (!d.versionId) {
      // register 响应缺 versionId 时先取课程详情补齐: 空 versionId 会让章节接口 422（审计 P1-9）
      try {
        const [, info] = await this.req("GET", `${API_COURSE_FRONT}/info/${courseId}`, { params: { source: 1, type: 1 } });
        if (info && info.versionId) d.versionId = info.versionId;
      } catch {
      }
    }
    return [d, await this.sections(courseId, d.versionId || "", d.register || false)];
  }
  /** 课程库课程：registerStudy 报名 + info/<id> 取章节（对齐 cli open_library_course）。 */
  async openLibraryCourse(courseId) {
    await this.req(
      "POST",
      `${API_COURSE_FRONT}/registerStudy`,
      { data: { courseId, type: 1, isRequired: 0 } }
    );
    const [, det] = await this.req(
      "GET",
      `${API_COURSE_FRONT}/info/${courseId}`,
      { params: { source: 1, type: 1 } }
    );
    const d = det || {};
    d._library = true;
    const secs = [];
    for (const ch of d.courseChapters || []) {
      for (const sec of ch.courseChapterSections || []) {
        const ft = String(sec.fileType || "").toLowerCase();
        secs.push({
          section_id: sec.id,
          resource_id: sec.attachmentId,
          name: sec.name || sec.sectionName || "",
          type: FTYPE[ft] ?? 0,
          finish: 0,
          rate: 0,
          studied: 0
        });
      }
    }
    return [d, secs];
  }
  async mediaSources(resourceId) {
    if (resourceId && this.mediaCache.has(resourceId)) return this.mediaCache.get(resourceId);
    if (!resourceId) return [null, null];
    const [, body] = await this.req("GET", `${API_FILE}/${resourceId}`);
    let mp3 = null;
    let mp4 = null;
    for (const it of Array.isArray(body) ? body : []) {
      const clean = String(it.path || "").toLowerCase().split("?")[0];
      if (clean.endsWith(".mp3") || it.def === 4) mp3 = mp3 || it;
      else if (clean.endsWith(".mp4")) mp4 = mp4 || it;
    }
    this.mediaCache.set(resourceId, [mp3, mp4]);
    return [mp3, mp4];
  }
  async hoursSelf() {
    const [, body] = await this.req("GET", API_DETAIL_HOUR);
    return body || {};
  }
  async personCourses(businessType) {
    const stateName = FINISH_NAME;
    const [, body] = await this.req("GET", API_PERSON_COURSE, {
      params: {
        page: 1,
        pageSize: 500,
        findStudy: 0,
        businessType,
        studyTimeOrder: "desc",
        finishStatus: "",
        isRequired: ""
      }
    });
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const it of body && body.items || []) {
      const bid = it.courseId;
      if (!bid || seen.has(bid)) continue;
      seen.add(bid);
      const ci = it.courseInfo || {};
      const fin = it.finishStatus ?? 0;
      out.push({
        bid,
        name: ci.name || "",
        required: it.isRequired === 1 ? "\u5FC5\u4FEE" : "\u9009\u4FEE",
        finish: fin,
        state: stateName[fin] ?? String(fin),
        runnable: !DONE_FINISH.has(fin),
        reg_ts: it.registerTime || 0,
        // 平台封面字段因课程而异, 常见几种都兜一下; 都没有则前端用渐变封面
        cover: [ci.coverPath, ci.coverImage, ci.coverUrl, ci.img, ci.pic, ci.homeImg].map((s) => {
          const v = String(s || "");
          return !v ? "" : /^https?:\/\//.test(v) ? v : `https://mooc.ctt.cn/${v}`;
        }).find(Boolean) || "",
        url: ci.url || `https://mooc.ctt.cn/home?courseId=${bid}`,
        courseHour: Number(ci.courseHour || it.courseHour || 0),
        studiedSec: Number(it.studyTotalTime || 0)
        // 已学秒数（personCourse-list 自带, 换算学时显示）
      });
    }
    return out;
  }
  /**
   * 课程库单页查询（课程/专题/考试/调研/直播 共用接口, type 区分）。
   * 返回项自带 type 时回验: 不一致就丢掉, 避免类型值猜错时张冠李戴。
   * @returns {{ items: Array, total: number }}
   */
  async searchPage({ keyword = "", type = 0, page = 1, pageSize = PAGE_SIZE } = {}) {
    const spec = LIBRARY_TYPES.find((t) => t.id === Number(type)) ?? LIBRARY_TYPES[0];
    const params = { ...spec.params(keyword), page, pageSize, _: Date.now() };
    const [, body] = await this.req("GET", spec.path, { params });
    const items = [];
    for (const it of body?.items ?? []) {
      if (!it?.id) continue;
      if (spec.id === 0 || spec.id === 2) {
        const rt = rawTypeOf(it);
        if (rt !== null && rt !== spec.id) continue;
      }
      const name = it.name ?? it.className ?? it.subject ?? it.title ?? it.newsName ?? it.interchangeName ?? it.fileName ?? "";
      items.push({
        id: it.id,
        name: String(name),
        kind: spec.label,
        courseHour: Number(it.courseHour || 0),
        cover: resolveCover(it),
        linkable: spec.id === 0 || spec.id === 2
      });
    }
    return { items, total: Number(body?.recordCount || items.length) };
  }
  /**
   * 学习日志 → 按日学时（秒聚合）。数据源 person-courselog（课程）+ subject-log（专题）。
   * 平台只提供每课累计 studyTotalTime + lastAccessTime, 无按日明细 ——
   * 近似归属: 全部学时记到最后学习日。当年范围, 每边最多 20 页。
   */
  async studyLogDays() {
    const y = (/* @__PURE__ */ new Date()).getFullYear();
    const start = new Date(y, 0, 1).getTime();
    const end = new Date(y, 11, 31, 23, 59, 59, 999).getTime();
    const byDay = {};
    const collect = async (path, businessType) => {
      for (let page = 1; page <= 20; page++) {
        let body;
        try {
          const [, b] = await this.req("GET", path, { params: { businessType, startTime: start, endTime: end, page, pageSize: 100 } });
          body = b;
        } catch {
          return;
        }
        const items = body?.items ?? [];
        for (const it of items) {
          const sec = Number(it.studyTotalTime || 0);
          const ts = it.lastAccessTime || it.finishTime || it.markTime;
          if (!sec || !ts) continue;
          const d = new Date(Number(ts));
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          byDay[day] = (byDay[day] || 0) + sec;
        }
        if (page * 100 >= Number(body?.recordCount || 0)) return;
      }
    };
    await collect(API_COURSE_LOG, 0);
    await collect(API_SUBJECT_LOG, 2);
    return Object.entries(byDay).map(([day, sec]) => ({ day, sec }));
  }
  async allViewItems() {
    const rows = [];
    const build = (type, it) => ({
      type,
      required: it.required,
      state: it.state,
      name: it.name,
      bid: it.bid,
      runnable: !DONE_FINISH.has(it.finish),
      reg_ts: it.reg_ts,
      push_ts: it.reg_ts,
      url: it.url,
      endTime: void 0,
      courseHour: it.courseHour || 0,
      studiedSec: it.studiedSec || 0,
      cover: it.cover || ""
    });
    for (const it of await this.personCourses(0)) rows.push(build("\u8BFE\u7A0B", it));
    for (const it of await this.personCourses(2)) rows.push(build("\u4E13\u9898", it));
    const now = Date.now();
    const tname = { 3: "\u8003\u8BD5", 4: "\u8C03\u7814", 5: "\u73ED\u7EA7", 6: "\u76F4\u64AD" };
    const byBid = new Map(rows.map((r) => [r.bid, r]));
    for (const t of await this.listTasks()) {
      const hit = byBid.get(t.businessId);
      if (hit) {
        if (t.endTime) hit.endTime = t.endTime;
        continue;
      }
      if ([1, 2].includes(t.businessType)) continue;
      let state;
      if (t.status === 3) state = "\u5DF2\u5B8C\u6210";
      else if (t.expired) state = "\u5DF2\u8FC7\u671F";
      else if (t.status === 2) state = "\u5B66\u4E60\u4E2D";
      else state = (t.startTime || 0) > now ? "\u672A\u5F00\u59CB" : "\u5B66\u4E60\u4E2D";
      rows.push({
        type: tname[t.businessType] ?? String(t.businessType),
        required: "\u2014",
        state,
        name: t.name || "",
        bid: t.businessId,
        runnable: false,
        reg_ts: 0,
        push_ts: t.createTime || 0,
        url: t.url || ""
      });
    }
    return rows;
  }
  async undoneTasks() {
    return (await this.listTasks()).filter((t) => [1, 2].includes(t.status) && [1, 2].includes(t.businessType) && !DONE_FINISH.has(t.finishStatus) && !t.expired);
  }
  // ---------------------------------------------------------------- 学时
  async startProgress(sectionId, backdateS, clientType = 1) {
    const ct = Date.now() - Math.trunc(backdateS * 1e3);
    const [code, body] = await this.req("GET", `${API_START}/${sectionId}`, {
      params: { clientType, createTime: ct }
      // 1=我的课程, 0=课程库课程（cli HAR 实测）
    });
    if (code !== 200 || !body || !body.id) return [null, null];
    return [body.id, body.remainingTime ?? null];
  }
  commitVideo(logId, study, loc, total) {
    return this.req("POST", API_VIDEO, {
      data: {
        encrypt: "false",
        logId,
        studyTime: Math.trunc(study),
        lessonLocation: Math.trunc(loc),
        resourceTotalTime: Math.trunc(total),
        flush: "false"
      }
    });
  }
  /** 课程库课程的 video-progress：全字段 AES-128-ECB + 随机 singleMark（无 encrypt 字段） */
  commitVideoEnc(logId, study, loc, total) {
    return this.req("POST", API_VIDEO, {
      data: {
        logId: encField(logId),
        lessonLocation: encField(loc),
        studyTime: encField(study),
        resourceTotalTime: encField(total),
        organizationId: encField(1),
        singleMark: encField(crypto.randomUUID())
      }
    });
  }
  /** 课程库课程的 doc-progress：与 video 同款全字段 AES（对齐 cli commit_doc_enc） */
  commitDocEnc(logId, loc, singleMark) {
    const d = {
      logId: encField(logId),
      organizationId: encField(1),
      singleMark: encField(singleMark || crypto.randomUUID())
    };
    if (loc !== void 0) d.lessonLocation = encField(loc);
    return this.req("POST", API_DOC, { data: d });
  }
  /** 对齐前端 commitProgressUpdate：上报后让平台重算该课进度 */
  progressUpdate(courseId) {
    return this.req("POST", API_PROGRESS_UPD, { data: { encrypt: "false", courseId } });
  }
  commitDoc(logId, loc) {
    const d = { encrypt: "false", logId };
    if (loc !== void 0) d.lessonLocation = Math.trunc(loc);
    return this.req("POST", API_DOC, { data: d });
  }
  async settleNested(parentCourseId, childCourseId, sectionId, tries = 4) {
    await this.req("POST", API_SECTION_PROGRESS, {
      data: { courseId: parentCourseId, resourceIds: childCourseId }
    });
    for (let i = 0; i < tries; i++) {
      const [logId] = await this.startProgress(sectionId, 3600);
      if (logId) {
        const [, body] = await this.commitDoc(logId);
        if (body && DONE_FINISH.has(body.finishStatus)) return true;
      }
      await this.sleep(rand(2500, 4e3));
    }
    const [, rows] = await this.req("POST", API_SECTION_PROGRESS, {
      data: { courseId: parentCourseId, resourceIds: childCourseId }
    });
    return Array.isArray(rows) && rows.length ? DONE_FINISH.has(rows[0].finishStatus) : false;
  }
  /** 把单个小节刷到 finishStatus=2 */
  async fakeSection(sec, { chunk, depth = 0, parentCourseId, library = false, courseId } = {}) {
    const step0 = this.realtime ? 30 : chunk || this.chunk;
    const stype = sec.type;
    if (SKIP_TYPES.has(stype)) return [false, `\u7C7B\u578B ${TYPE_NAME[stype] || stype} \u9700\u771F\u5B9E\u4F5C\u7B54, \u8DF3\u8FC7`];
    if (DONE_FINISH.has(sec.finish)) return [true, "\u5DF2\u5B8C\u6210, \u8DF3\u8FC7"];
    if (stype === NESTED_TYPE) {
      if (depth >= MAX_DEPTH) return [false, "\u5D4C\u5957\u8FC7\u6DF1, \u8DF3\u8FC7"];
      this.say(`         \u21B3 \u5173\u8054\u8BFE\u7A0B ${sec.resource_id}`);
      const [done, total2] = await this.runCourse(sec.resource_id, { depth: depth + 1 });
      if (done < total2) return [false, `\u5B50\u8BFE\u7A0B\u672A\u5B8C\u6210 ${done}/${total2}`];
      const settled = await this.settleNested(parentCourseId, sec.resource_id, sec.section_id);
      return [settled, settled ? "\u5B50\u8BFE\u7A0B\u5B8C\u6210 + \u7236\u8BB0\u5F55\u5DF2\u5224\u5B8C\u6210" : `\u5B50\u8BFE\u7A0B ${done}/${total2}, \u7236\u8BB0\u5F55\u5F85\u5E73\u53F0\u590D\u6838`];
    }
    let note = "";
    if (MEDIA_TYPES.has(stype) && this.mode !== "video") {
      const [mp3, mp4] = await this.mediaSources(sec.resource_id);
      const use = mp3 || (this.mode === "auto" ? mp4 : null);
      if (mp3) note = `\u97F3\u8F68 mp3 ${((mp3.size || 0) / 1048576).toFixed(1)}MB`;
      else if (this.mode === "audio") note = "\u65E0 mp3 \u97F3\u8F68, \u56DE\u9000 mp4";
      else note = "\u65E0 mp3 \u97F3\u8F68, \u7528 mp4";
      if (use) this.say(`         (${note})`);
    }
    let total = null;
    const sessionUuid = library ? crypto.randomUUID() : void 0;
    let rounds = 0;
    let submitted = 0;
    let prevRem = null;
    let stuck = 0;
    const maxRounds = this.realtime ? 400 : 60;
    for (let i = 0; i < maxRounds; i++) {
      rounds += 1;
      const [logId, remRaw] = await this.startProgress(
        sec.section_id,
        this.realtime ? step0 : step0 + Math.trunc(rand(60, 300)),
        library ? 0 : 1
      );
      if (logId === null) return [false, "start-progress \u5931\u8D25"];
      // remainingTime 缺失(null)不能按 0 处理: 那会把未学完的小节误判成"学时已用完"而假完成（审计 P1-8）
      if (remRaw === null) return [false, "start-progress 未返回 remainingTime, 无法判定学时状态"];
      const rem = remRaw;
      if (rem <= 0) {
        if (submitted || sec.studied) return [true, `\u5B66\u4E60\u65F6\u957F\u5DF2\u7528\u5B8C\uFF08\u5F85\u5E73\u53F0\u6C47\u603B\uFF0C\u5171 ${submitted}s\uFF09`];
        break;
      }
      if (prevRem !== null && rem >= prevRem) {
        stuck += 1;
        if (stuck >= 2) throw new QuotaExhausted("\u5269\u4F59\u65F6\u957F\u672A\u4E0B\u964D \u2014\u2014 \u5F53\u65E5\u5B66\u65F6\u914D\u989D\u5DF2\u6EE1, \u8BF7\u6B21\u65E5\u91CD\u8DD1");
      } else {
        stuck = 0;
      }
      prevRem = rem;
      if (total === null) total = rem + sec.studied;
      const step = Math.min(step0, rem);
      const loc = Math.min(total, total - rem + step);
      const [code, body] = MEDIA_TYPES.has(stype) ? library ? await this.commitVideoEnc(logId, step, loc, total) : await this.commitVideo(logId, step, loc, total) : library ? await this.commitDocEnc(logId, loc, sessionUuid) : await this.commitDoc(logId, loc);
      if (code !== 200) {
        if (body && body.errorCode === 40909) {
          await this.sleep(1e3);
          continue;
        }
        return [false, `\u4E0A\u62A5\u5931\u8D25 HTTP ${code} ${JSON.stringify(body)}`];
      }
      submitted += step;
      if (courseId) await this.progressUpdate(courseId);
      if (body && DONE_FINISH.has(body.finishStatus)) return [true, `\u5B8C\u6210, \u5171 ${rounds} \u8F6E / ${submitted}s`];
      await this.sleep(this.realtime ? step * 1e3 : rand(600, 1600));
    }
    return [false, `\u8F6E\u6B21\u7528\u5B8C\u4ECD\u672A\u89C1\u5B8C\u6210 (\u5DF2\u63D0\u4EA4 ${submitted}s)`];
  }
  async runCourse(courseId, { onlyUnfinished = true, depth = 0, syncOnly = false } = {}) {
    const [det, secs] = await this.openCourse(courseId);
    this.say(`
===== ${det.name} =====`);
    if (this.realtime) this.say("[\u771F\u5B9E\u5B66\u65F6] \u6309\u8BFE\u7A0B\u771F\u5B9E\u65F6\u957F\u9010\u8282\u63A8\u8FDB, \u4E0A\u62A5\u91CF == \u771F\u5B9E\u6D41\u901D\u65F6\u95F4");
    this.say(`\u5C0F\u8282 ${secs.length} \u4E2A | \u5DF2\u62A5\u540D ${det.register} | \u6A21\u5F0F ${this.mode}${this.realtime ? " + realtime" : ""} | \u5355\u6863 ${this.realtime ? 30 : this.chunk}s`);
    let todo = onlyUnfinished ? secs.filter((s) => !DONE_FINISH.has(s.finish)) : secs;
    if (syncOnly) {
      todo = todo.filter((s) => s.type === NESTED_TYPE);
      this.say(`[sync] \u53EA\u590D\u6838\u5173\u8054\u8BFE\u7A0B\u7236\u8BB0\u5F55 ${todo.length} \u4E2A
`);
    } else {
      this.say(`\u5F85\u5904\u7406 ${todo.length} \u4E2A
`);
    }
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < todo.length; i++) {
      const sec = todo[i];
      this.say(`[${i + 1}/${todo.length}] (${TYPE_NAME[sec.type] || sec.type}) ${String(sec.name).slice(0, 38)}`);
      let good = false;
      let msg = "";
      try {
        if (syncOnly) {
          good = await this.settleNested(courseId, sec.resource_id, sec.section_id);
          msg = good ? "\u7236\u8BB0\u5F55\u5DF2\u5224\u5B8C\u6210" : "\u5E73\u53F0\u4ECD\u672A\u5224\u5B9A";
        } else {
          [good, msg] = await this.fakeSection(sec, {
            depth,
            parentCourseId: courseId,
            library: !!det._library,
            courseId
          });
        }
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          this.stopReason = "quota";
          this.say("[\u914D\u989D] \u5F53\u65E5\u5B66\u65F6\u914D\u989D\u5DF2\u6EE1, \u7EC8\u6B62\u672C\u8BFE\u7A0B\u5269\u4F59\u5C0F\u8282");
          throw e;
        }
        good = false;
        msg = `\u5F02\u5E38 ${e.name}: ${e.message}`;
      }
      this.say(`         -> ${good ? "OK" : "FAIL"} ${msg}`);
      ok += good ? 1 : 0;
      fail += good ? 0 : 1;
      await this.sleep(rand(2e3, 5e3));
    }
    const secs2 = await this.sections(courseId, det.versionId || "", det.register || false);
    const done = secs2.filter((s) => DONE_FINISH.has(s.finish)).length;
    this.say(`
\u7ED3\u679C: \u6210\u529F ${ok} / \u5931\u8D25 ${fail} | \u5C0F\u8282\u5B8C\u6210\u5EA6 ${done}/${secs2.length}`);
    return [done, secs2.length];
  }
  async runTodo() {
    let items = await this.undoneTasks();
    const now = Date.now();
    const future = items.filter((t) => (t.startTime || 0) > now);
    if (future.length) {
      items = items.filter((t) => !future.includes(t));
      this.say(`[todo] ${future.length} \u4E2A\u4EFB\u52A1\u672A\u5230\u5F00\u59CB\u65F6\u95F4, \u8DF3\u8FC7:`);
      for (const t of future.slice(0, 5)) this.say(`         - ${String(t.name).slice(0, 40)}`);
    }
    this.say(`[todo] \u5F85\u5904\u7406 ${items.length} \u4E2A
`);
    const summary = [];
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      this.say(`
########## \u4EFB\u52A1 [${i + 1}/${items.length}] ${String(t.name).slice(0, 40)} ##########`);
      let done = 0;
      let total = 0;
      try {
        [done, total] = await this.runCourse(t.businessId);
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          this.stopReason = "quota";
          this.say("[todo] \u26D4 \u5F53\u65E5\u5B66\u65F6\u914D\u989D\u5DF2\u6EE1, \u505C\u6B62\u5904\u7406\u5269\u4F59\u4EFB\u52A1, \u8BF7\u6B21\u65E5\u91CD\u8DD1");
          break;
        }
        this.say(`         -> FAIL \u5F02\u5E38 ${e.name}: ${e.message}`);
      }
      summary.push([t.name, done, total]);
    }
    this.say("\n========== \u6C47\u603B ==========");
    for (const [name, done, total] of summary) {
      this.say(`${done === total && total ? "\u2705" : "\u26A0\uFE0F "} ${done}/${total}  ${String(name).slice(0, 40)}`);
    }
  }
  async runHours(target = "auto") {
    const info = await this.hoursSelf();
    const base = Number(info.hourSelf || 0);
    const req = Number(info.requireCourseHour || 0);
    const goal = target === "auto" ? Math.max(0, req - base) : Number(target);
    this.say(`[\u5B66\u65F6] \u7F51\u7EDC\u81EA\u5B66 ${base.toFixed(1)} / \u8981\u6C42 ${req.toFixed(1)} \u5B66\u65F6 | \u76EE\u6807: \u518D\u5237 ${goal.toFixed(2)} \u5B66\u65F6
`);
    if (goal <= 0) {
      this.say("[\u5B66\u65F6] \u2705 \u7F51\u7EDC\u81EA\u5B66\u5DF2\u8FBE\u6807, \u65E0\u9700\u518D\u5237");
      return;
    }
    const items = await this.undoneTasks();
    if (!items.length) {
      this.say("[\u5B66\u65F6] \u6CA1\u6709 \u672A\u5B8C\u6210 \u7684\u8BFE\u7A0B/\u4E13\u9898\u53EF\u4F9B\u5237\u5B66\u65F6");
      return;
    }
    let gained = 0;
    let flat = 0;
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      this.say(`
########## \u5B66\u65F6\u4EFB\u52A1 [${i + 1}/${items.length}] ${String(t.name).slice(0, 40)} ##########`);
      try {
        await this.runCourse(t.businessId);
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          this.stopReason = "quota";
          this.say("[\u5B66\u65F6] \u26D4 \u5F53\u65E5\u5B66\u65F6\u914D\u989D\u5DF2\u6EE1, \u505C\u6B62\u5904\u7406, \u8BF7\u6B21\u65E5\u91CD\u8DD1");
          return;
        }
        this.say(`         -> FAIL \u5F02\u5E38 ${e.name}: ${e.message}`);
        continue;
      }
      const now = await this.hoursSelf();
      gained = Number(now.hourSelf || 0) - base;
      this.say(`[\u5B66\u65F6] \u5DF2\u7D2F\u8BA1 ${gained.toFixed(2)}/${goal} \u5B66\u65F6`);
      if (gained >= goal) {
        this.say(`[\u5B66\u65F6] \u{1F389} \u5DF2\u8FBE\u6210\u76EE\u6807: +${gained.toFixed(2)} \u5B66\u65F6`);
        return;
      }
      flat = gained <= 0 ? flat + 1 : 0;
      if (flat >= 2) {
        this.stopReason = "no-progress";
        this.say("[\u5B66\u65F6] \u26D4 \u8FDE\u7EED\u4E24\u95E8\u8BFE\u540E\u5B66\u65F6\u65E0\u589E\u957F, \u505C\u6B62");
        return;
      }
    }
    this.say(`[\u5B66\u65F6] \u672A\u5B8C\u6210\u4EFB\u52A1\u5168\u90E8\u5237\u5B8C, \u7D2F\u8BA1 +${gained.toFixed(2)}/${goal} \u5B66\u65F6`);
  }
  // ---------------------------------------------------------------- 心跳
  /** 浏览器原生 WebSocket: 每 10s 发 PING, 断线重连 (无法/无需伪造 UA) */
  startHeartbeat({ intervalMs = 1e4 } = {}) {
    let ws = null;
    let stopped = false;
    let origin = this.wsOrigin || (API_ORIGIN && /^https?:/.test(API_ORIGIN) ? API_ORIGIN : "");
    if (!origin) {
      const loc = globalThis.location;
      if (loc && loc.host) origin = loc.origin;
      else if (globalThis.document && globalThis.document.baseURI) origin = new URL(globalThis.document.baseURI).origin;
    }
    if (!origin || !this.WS) {
      this.say("[\u5FC3\u8DF3] \u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 WebSocket, \u8DF3\u8FC7");
      return () => {
      };
    }
    const url = `${origin.replace(/^http/, "ws")}${WS_PATH}${encodeURIComponent(this.token.access_token)}`;
    const connect = () => {
      if (stopped) return;
      try {
        ws = new this.WS(url);
      } catch {
        return;
      }
      let timer = null;
      ws.onopen = () => {
        this.say("[\u5FC3\u8DF3] WebSocket \u5DF2\u8FDE\u63A5");
        try {
          ws.send("PING");
        } catch {
        }
        timer = setInterval(() => {
          try {
            ws.send("PING");
          } catch {
          }
        }, intervalMs);
      };
      ws.onmessage = (ev) => {
        const msg = String(ev.data);
        if (msg === "otherClientStudy" || msg === "multipleClientStudy") {
          this.say(`[\u5FC3\u8DF3] \u670D\u52A1\u7AEF\u4E0B\u53D1 ${msg}: \u6709\u5176\u5B83\u7AEF\u5728\u5B66\u540C\u4E00\u95E8\u8BFE`);
        }
      };
      ws.onclose = () => {
        clearInterval(timer);
        if (!stopped) setTimeout(connect, 3e3);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
        }
      };
    };
    connect();
    this.say("[\u5FC3\u8DF3] \u5DF2\u542F\u52A8");
    return () => {
      stopped = true;
      try {
        ws && ws.close();
      } catch {
      }
    };
  }
}
export {
  API_CHAPTERS,
  API_COURSE_FRONT,
  API_COURSE_LOG,
  API_DETAIL_HOUR,
  API_DOC,
  API_FILE,
  API_GLOBAL_SEARCH,
  API_PERSON_COURSE,
  API_PROGRESS_UPD,
  API_REGISTER,
  API_SECTION_PROGRESS,
  API_START,
  API_SUBJECT_LOG,
  API_TASKS,
  API_VIDEO,
  CENTER_URL,
  DONE_FINISH,
  FINISH_NAME,
  FTYPE,
  LOGIN_URL,
  MAX_DEPTH,
  MEDIA_TYPES,
  NESTED_TYPE,
  PlatformClient,
  QuotaExhausted,
  SKIP_TYPES,
  TYPE_NAME,
  WS_PATH,
  apiUrl,
  fetchDisplayName,
  fetchProfile,
  login,
  setApiOrigin
};

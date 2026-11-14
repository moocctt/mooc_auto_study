# 模块地图 · 油猴脚本（main 分支）

对象：`userscript/tobacco-mooc-fast.user.js`（快速刷课版）与
`userscript/tobacco-mooc-unattended.user.js`（真实节奏/无人值守版）。
两者是同一套源码按 `// src/<模块>.js` 分节打包的产物，共享段逐行一致（实测仅
engine 的 `playSection` 与 routes 的 `isStudyPage` 有差异），行号以 fast 为准，
unattended 偏移约 +50 行。

## 模块清单

| 行区间（fast） | 模块 | 职责 | 关键导出/挂载 |
|---|---|---|---|
| :21–93 | token.js | 令牌猎取：XHR/fetch 钩子抓 `Authorization: Bearer…`，localStorage `token` 兜底，`waitToken` 等待/超时 | `createTokenHunter` → `{getToken, setToken, waitToken, tokenFromStorage, installHooks}` |
| :94–116 | constants.js | 常量与接口表 | `ORIGIN=https://mooc.ctt.cn`、`API`（TASKS/START/VIDEO/DOC/CHAPTERS/REGISTER/SECTION_PROGRESS/INFO/REGISTER_STUDY）、`MAX_STEP=90` |
| :117–196 | aes.js | 字段级 AES-128-ECB/PKCS7 加密（上报体脱敏用） | `KEY/encField/expandKey/encryptBlock` |
| :197–224 | fingerprint.js | 设备指纹 | `hash32`（FNV-1a）、`fingerprintFor` |
| :225–235 | util.js | 报文/参数工具 | `pystr/toParams/qs/form` |
| :236–338 | api.js | HTTP 层：超时（`doFetchWithTimeout`，默认 20s）、401 自愈（换 token→重登→二次 401 抛 `err.auth`） | `createApi({hunter, gm, fetchImpl, origin, timeoutMs})` → `req/get/post`；`AUTH_CODES={90901,90902}` |
| :339–656 | engine.js | 业务引擎：任务/小节遍历、上报循环、配额判定、嵌套课程 | `createEngine` → `{undoneTasks, sections, openCourse, startProgress, settleNested, doSection, runCourse, runAll}`；`runAll` 返回 `{quotaHit, ok, authFailed}` |
| :657–674 | lock.js | 页面内互斥锁 | `createLock` |
| :675–715 | guard.js | 跨标签页会话锁（GM 存储 + 唯一实例 id + 写后回读） | `createSessionGuard` → `{hold, held, release}` |
| :716–900 | panel.js | 面板 UI 与日志（fast 前缀 `uf`，unattended 前缀 `rt`） | `createPanel` → `{log, setStatus, mount, destroy, getBox}`；日志元素 `#uf-log` / `#rt-log` |
| :901–913 | routes.js | 路由识别 | `currentBidFromHash`、`isAuthPage`（`AUTH_PAGE_RE=/#\/(?:login|register|forget|auth)\b/i`） |
| :914–1001 | entry-fast.js | 启动编排：`tokenFromStorage` → 非 auth 页 `panel.mount()` → `hunter.installHooks()` → 心跳/菜单 | — |
| :1002–1030 | debug 导出 | `window.__MOOC_US_DEBUG__.<fast\|unattended>` = `{state, runCourse, runAll, currentBidFromHash, log, core}`；`core` 含全部纯函数与工厂（只增不减） | — |

unattended 独有：`mooc-ws.js`（WebSocket 心跳）、`player/`（`playSection` 真实节奏播放、
`reqWakeLock`、画质设置）、`config` 的 `roundSleepMs` 按 step 折算。

## 接口清单（全部走 `https://mooc.ctt.cn/api/v1`，头 `Authorization: Bearer__<token>`）

| 接口 | 方法 | 用途 |
|---|---|---|
| `/human/task` | GET | 任务列表（`page/pageSize`，按 `body.total` 翻页） |
| `/course-study/subject/chapter-progress` | GET | 章节/小节进度（须带 `courseId+versionId+isRegister`） |
| `/course-study/course-front/start-progress/<sid>` | GET | 开小节，返回 `remainingTime`（只在提交被接受后下降） |
| `/course-study/course-front/video-progress` | POST | 视频秒数上报（明文或 AES 字段级，`errorCode 40909`=冲突） |
| `/course-study/course-front/doc-progress` | POST | 文档上报（只报 `lessonLocation`，无学时语义） |
| `/course-study/course-front/course-progress-update` | POST | 课程级进度 |
| `/course-study/course-front/register` / `registerStudy` | GET/POST | 开课（建学习记录） |
| `/course-study/course-info/front/info/<id>` | GET | 课程详情 |
| 登录态判定 | — | HTTP 401 才算失效；`errorCode 90901/90902` 与实测不符（见测试报告 §7） |

## 数据流（一次 runAll）

`entry boot` → `guard.hold(INSTANCE)` → `runAll()` → `undoneTasks()`（翻页拉全量 →
`taskFilter` 过滤已完成/跳过类型）→ 逐任务 `runCourse` → `openCourse`（register +
chapter-progress）→ 逐小节 `doSection`（`startProgress` 拿 `remainingTime` →
`parseRemaining` 三态判定 → 循环 `video/doc-progress` 上报，`normalizeReport` 归一化，
40909 退避重试不占轮次）→ 汇总 `{quotaHit, ok, authFailed}` → 入口按结果决定
reload（仅 ok）/停（authFailed）/继续。

## 测试入口

- 单测/引擎/会话锁：`tests/runner.js`（`node tests/runner.js`，36 用例）。
- 本地 mock 联调：`tests/mock-server.js` + `tests/mock-integration.test.js`。
- 真实站点冒烟（无头 Edge + CDP，未登录态）：`node tests/browser-smoke.mjs`。

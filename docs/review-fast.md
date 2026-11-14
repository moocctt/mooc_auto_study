﻿# 代码审查报告 · tobacco-mooc-fast.user.js（2026-11-14，修复前基线）

> 只读审查，行号对应当时的代码；后续修复情况见 docs/test-report-2026-11-14.md。

我先读取目标文件和相关文档。# 代码审查报告 · `userscript/tobacco-mooc-fast.user.js`（966 行，只读）

> 路径前缀统一为 `userscript/tobacco-mooc-fast.user.js`，下文省略重复前缀时仍保留完整路径 + 行号。
> 已交叉比对 `userscript/tobacco-mooc-unattended.user.js`（同一 engine 代码，仅 config/playSection 不同）与 `README.md`、`userscript/tobacco-mooc-fast.additional-info.md`。

---

## P0 — 会导致错误结果或账号风险，必须修

### P0-1 会话防多开完全失效：owner 是常量字符串，`held()` 是死分支
- `userscript/tobacco-mooc-fast.user.js:881` `config.canStart = () => guard.hold("fast");`
- `userscript/tobacco-mooc-fast.user.js:899` `} else if (guard.held("fast")) {`
- `userscript/tobacco-mooc-fast.user.js:635` `if (cur && cur.owner !== owner && now() - cur.ts < ttlMs) return false;`
- `userscript/tobacco-mooc-fast.user.js:641` `return !!(cur && now() - cur.ts < ttlMs && (owner ? cur.owner !== owner : true));`

**现象/原因**：`owner` 在所有标签页里都是字面量 `"fast"`（对比 unattended 用 `"realtime"`，跨脚本互斥是有效的，跨标签页同脚本互斥完全无效）。
- 标签 B 读到的 `cur.owner === "fast"`，`cur.owner !== owner` 为 `false` → `hold()` 恒返回 `true` 并直接覆写 `ts`；
- 于是 `held("fast")` 恒为 `false`，`:899` 那条「另一个标签页正在运行，不启动」分支永远进不去；`:476` 的 `canStart()` 也永远放行。

**后果**：两个标签页同时跑同一账号 → 平台 `enableUnique=1` 判多端学习 → 学时被撤销/风控。而 README 明确承诺「跨标签页 45 秒防多开」「同时启用会直接拒启动」。

**建议**：`owner` 用每页唯一的随机 id（如 `` `${kind}#${Math.random().toString(36).slice(2,8)}` ``，lock 里已有同样写法），并把「是否同 kind」与「是否同一个 owner」分开判断：别的 fast 实例占用时也要拒绝。另外 `read()`+`write()` 是 TOCTOU（`:634-637`），GM 存储无 CAS，两个标签仍可能同时通过，建议 `hold` 里写入后回读校验。

### P0-2 `remainingTime` 缺失被当作「已完成」，把没上报过的小节标记成完成
- `userscript/tobacco-mooc-fast.user.js:381` `return [body.id, body.remainingTime ?? null];`
- `userscript/tobacco-mooc-fast.user.js:431` `if (remRaw === null) return [true, submitted ? ... : "已完成（无剩余时长）"];`

**原因**：`startProgress` 用 `null` 同时表示两种完全不同的语义：
1. 请求成功，但响应里没有 `id`（`:380` `if (code !== 200 || !body || !body.id) return [null, null];`）；
2. 请求成功，但响应里没有/为 `null` 的 `remainingTime`。

`doSection` 用 `logId === null`（`:430`）区分情况 1，用 `remRaw === null`（`:431`）区分情况 2——可只要平台把字段改名、包一层 `data`、或某类小节不返 `remainingTime`，**每一个小节都会在第一次 `startProgress` 后立刻被判定为「已完成」**，`ok += 1`，最终 `runAll` 打印「✅ 全部任务处理完毕」并自动刷新页面，实际一秒都没入账。这是最坏的失败模式（静默假装成功）。

**建议**：拆成三态 `{ok:true, logId, rem}` / `{ok:false, reason}`，把「字段缺失」显式记为失败（`return [false, "start-progress 无 remainingTime 字段"]`），只有 `rem === 0` 或服务端明确 `finishStatus ∈ DONE` 才判完成。同时确认响应是否包在 `body.data` 内（`:380` 目前只认 `body.id`）。

### P0-3 两条「剩余时长没下降」= 当日配额耗尽 → 中止整个批次
- `userscript/tobacco-mooc-fast.user.js:437-441`
```js
if (prevRem !== null && rem >= prevRem) {
  stuck += 1;
  if (stuck >= 2) throw new QuotaExhausted(`剩余时长未下降 (${prevRem}→${rem}) —— 判定当日学时配额已满`);
} else stuck = 0;
```
**原因**：`prevRem` 来自**每一轮新开的** `startProgress`（`:429`），而「没下降」的可能原因远不止日配额：文档类小节（`doc-progress` 根本不带 `studyTime`，见 P1-7）不一定按秒扣减、`enableUnique` 多端冲突、单步被静默丢弃、服务端读到旧值。任一小节连续两轮不变就 `throw QuotaExhausted`，被 `:539` / `:562` / `:505` 一路向上解释成「学时配额已满, 已停止 (次日再试)」，**整个任务列表全部放弃**，用户以为是平台限流，实际只是某一门课/某一节卡住。

**建议**：把配额判定从「单小节两轮不变」升级为「跨小节/跨课程全局不变」，或只在 `errorCode` 明确表示配额时判定；单小节卡住应只判该小节失败并记录，不 throw 全局异常。至少把消息改成「该小节连续两轮未入账」，不要断言配额。

### P0-4 `runAll` 吞掉异常并返回 `undefined`，入口把它当成功 → 失败后照样刷新页面
- `userscript/tobacco-mooc-fast.user.js:576-578`
```js
return { quotaHit };
} catch (e) {
  log(`✗ ${e.message}`);
}
```
- `userscript/tobacco-mooc-fast.user.js:905-908`
```js
engine.runAll().then((r) => {
  if (!state.stopFlag && !(r && r.quotaHit)) {
    panel.log("↻ 2 秒后刷新页面以更新进度…");
    setTimeout(() => location.reload(), 2e3);
```

**原因**：`e.auth`（token 失效且无账密）、`undoneTasks()` 抛错、任何网络异常都被 `:577` 吞成一条日志，函数返回 `undefined` → `r` 为 `undefined` → `!(r && r.quotaHit)` 为 `true` → **硬失败也会自动 reload**。调用方无法区分「成功」「配额」「致命错误」三种结果；同时 `runAll` 没有 `.catch`，一旦 `panel.log` 自身抛错就是 unhandled rejection。

**建议**：`catch` 里 `return { failed: true, error: e }`（或把错误 rethrow 让入口 `.catch` 处理），入口只在 `r && r.ok && !r.quotaHit && !state.stopFlag` 时 reload；`.then()` 后面补 `.catch(e => panel.log(...))`。

---

## P1 — 明确逻辑错误 / 会卡死或永久性故障

### P1-1 访问一次登录页，面板永久消失（`box` 引用从不置空）
- `userscript/tobacco-mooc-fast.user.js:751-752` `function mount() { if (box) return; ...`
- `userscript/tobacco-mooc-fast.user.js:828` `getBox: () => box`
- `userscript/tobacco-mooc-fast.user.js:922-926`
```js
if (!isAuthPage(location.hash)) { if (!panel.getBox()) panel.mount(); }
else if (panel.getBox()) { panel.getBox().remove(); }
```
**原因**：`:925` 只 `remove()` 节点，闭包变量 `box` 仍指向被摘除的节点。之后 `getBox()` 恒真 → `mount()` 早退（`:752`）→ 面板再也回不来；菜单项 `显示/隐藏面板`（`:933-938`）也只是在操作一个游离节点。SPA 里从 `#/login` 回到业务页就会触发（非常常见：登录态过期 → 重新登录）。

**建议**：`remove()` 后显式 `box = null`（给 panel 一个 `unmount()`），并清掉 `watchTheme` 的 interval / hashchange 监听。

### P1-2 全链路没有超时、没有 `AbortController`，网络一挂就永久卡住
- `userscript/tobacco-mooc-fast.user.js:237` `const doFetch = fetchImpl || ((...a) => fetch(...a));`
- `userscript/tobacco-mooc-fast.user.js:278-289`、`:255-266`（relogin）均无 `signal`
- `userscript/tobacco-mooc-fast.user.js:426` `if (state2.stopFlag) return [false, "已停止"];` —— 只在每轮循环顶部检查

**原因**：`fetch` 没有超时；服务端 keep-alive 挂死或移动网络断流时，`await doFetch` 永不 settle。此时 `state.running` 永远为 `true`、`__MOOC_US_LOCK` 永不释放、按钮变不回来、停止按钮只置了 flag 却没人看（`:426` 还没被走到）。面板状态卡在「轮 N」。

**建议**：包一层 `withTimeout(promise, ms, signal)`，`AbortController` 由 stop 按钮触发；`sleep()` 也要可中断。这是「停止」语义能真正生效的前提。

### P1-3 `waitToken` 超时会清空**所有**等待者
- `userscript/tobacco-mooc-fast.user.js:38-46`
```js
const t = setTimeout(() => {
  tokenWaiters = [];
  reject(new Error("未捕获到令牌: 页面未发出带授权头的请求, 且 localStorage 无令牌"));
}, ms);
tokenWaiters.push(() => { clearTimeout(t); resolve(); });
```
**原因**：`tokenWaiters = []` 把别人的 waiter 一起删掉。任何一个 `waitToken` 超时后，token 随后被 `setToken()` 捕获（`:30-32`）也不会唤醒其他仍在等待的调用者——它们只能各自等满 30s 再收到「未捕获到令牌」的**错误**结果，随后这个请求被当作失败，错失本可成功的整批任务。

**建议**：超时回调里只删除自己的那个 waiter（用索引 `splice` 或 `Set` 存 waiter），`setToken` 时整体清空才是正确的。

### P1-4 token 钩子可能根本没生效，而且被 noop 日志掩盖
- `userscript/tobacco-mooc-fast.user.js:17`（`@grant GM_registerMenuCommand` 等，非 `@grant none`）+ `:63-87`（`win.fetch = ...` / `XHR.prototype.setRequestHeader = ...`）+ `:866` `var hunter = createTokenHunter({});` + `:917` `hunter.installHooks({});`
- `userscript/tobacco-mooc-fast.user.js:21-22` `function createTokenHunter({ log = () => {}, ...`
- `userscript/tobacco-mooc-fast.user.js:29` `log(`令牌已捕获 (${v.slice(-8)})`);`

**原因**：① 有 `@grant` ⇒ 脚本跑在管理器沙箱里，`win.fetch = ...` 与 `XMLHttpRequest.prototype` 补丁是否落到页面上下文取决于管理器（Tampermonkey 通常需要 `unsafeWindow`），失败时不会有任何报错；② 即使生效，`createTokenHunter({})` 没传 `log`，默认是空函数，所以「令牌已捕获」这条唯一的可见反馈被完全吞掉——用户只会看到 30 秒后一句「未捕获到令牌」，无法判断是钩子失效还是要先让页面发一次请求。

**建议**：`installHooks` 里显式 `unsafeWindow`（并加 `// @grant unsafeWindow`），或加自检（`setRequestHeader` 被替换后打一条 debug 日志）；把 `log: (m) => panel.log(m)` 传给 `createTokenHunter`（同时脱敏，见 P2-5）。

### P1-5 二次 401 被降级成「上报失败 HTTP 401」，然后拿死 token 跑完整批
- `userscript/tobacco-mooc-fast.user.js:294` `const authError = res.status === 401 || body && AUTH_CODES.has(body.errorCode);`
- `userscript/tobacco-mooc-fast.user.js:295-311`（只在 `!retried` 时处理；重试后直接 `return [res.status, body]`）

**原因**：`retried === true` 时 401 直接返回给调用方，`doSection` 看到 `code !== 200` 就 `return [false, "上报失败 HTTP 401"]`（`:452-453`），`runCourseInner` 记为一条普通失败并继续下一节、下一门课。结果：登录态彻底失效后，脚本会用同一个死 token 把所有课程、所有小节全部请求一遍再报「全部任务处理完毕」。

**建议**：重试仍 401 时抛 `auth` 错误（和 `:306-308` 一致），让 `runAll` 立即中止；同时对 `AUTH_CODES` 做数字/字符串归一（见 P2-2）。

### P1-6 嵌套课程结束后恢复 `state` 的代码不在 `finally` 里
- `userscript/tobacco-mooc-fast.user.js:413-418`
```js
const parentCourse = state2.course;
const parentVid = state2.versionId, parentReg = state2.isRegister;
log(`↳ 关联课程 ${sec.rid}`);
const [done, total2] = await runCourse(sec.rid, depth + 1);
state2.course = parentCourse; state2.versionId = parentVid; state2.isRegister = parentReg;
```
**原因**：`runCourse` 抛 `QuotaExhausted` / `auth` 时（`:505-511` 会 rethrow），这三行被跳过。虽然配额会中止全局，但 `auth` 之外的异常（例如网络错误未标记 auth、或调试接口直接调 `runCourse`）会让父课程后续小节用**子课程的 `versionId`/`isRegister`** 去请求 `chapter-progress`/`start-progress`，把进度记到错误课程上。

**建议**：`try { ... } finally { 恢复 }`。

### P1-7 文档类上报的行里 `submitted += step` 是假的，且 200 无 body 也算成功
- `userscript/tobacco-mooc-fast.user.js:448`（`isMedia ? VIDEO(studyTime/lessonLocation/resourceTotalTime) : DOC({logId, lessonLocation: 999})`）
- `userscript/tobacco-mooc-fast.user.js:456` `submitted += step;`
- `userscript/tobacco-mooc-fast.user.js:449-455` 只判 `code !== 200`

**原因**：`doc-progress` 请求体里根本没有 `studyTime`，「已报 Ns」计数器照样每轮 +90，面板/日志显示的时长与实际入账无关；同时 `code === 200` 但 `body === null`（HTML/空响应）也计入成功，没有任何服务端确认。

**建议**：doc 类型单独计一个「提交次数」而不是秒数；用响应体的 `finishStatus`/`remainingTime` 确认入账；`body` 为 `null` 时判失败或至少告警。

### P1-8 `maxRounds` 可能是 `NaN` → `for(;;)` 无上限、无限打请求
- `userscript/tobacco-mooc-fast.user.js:443-444`
```js
total = rem + sec.studied;
maxRounds = Math.ceil(total / Math.min(step0, API.MAX_STEP)) + config2.roundsSlack;
```
- `userscript/tobacco-mooc-fast.user.js:427` `if (maxRounds && i >= maxRounds) return ...`

**原因**：`sec.studied` 来自 `p.studyTotalTime || 0`（`:348`），若该字段是对象或非数字字符串，`total` 为 `NaN` → `maxRounds` 为 `NaN` → `NaN` 是 falsy，`:427` 的保护失效 → 循环只靠 `40909 continue`/服务端响应退出，可能长时间高频请求。另外 `rem + sec.studied` 在 `remainingTime` 是字符串时是**字符串拼接**（`"600" + 0 = "6000"`，`:348` + `:443`），轮次上限被算成 67 而不是 7。

**建议**：入口处 `Number()` 归一（`const rem = Number(remRaw), studied = Number(sec.studied) || 0`，非有限数直接判失败）；`maxRounds` 计算后 `if (!Number.isFinite(maxRounds)) maxRounds = 100;`。

### P1-9 `courseId.slice(0, 8)` 在 id 是数字时直接抛 TypeError
- `userscript/tobacco-mooc-fast.user.js:477` `log(`⛔ 检测到其他标签页正在学习, 跳过「${courseId.slice(0, 8)}…」(防多开)`);`

**原因**：`courseId` 来自 `t.businessId`（`:556`）或 hash 解析（字符串）。任务列表里 `businessId` 若是 number，`.slice` 不存在 → TypeError，从 `runCourseInner` 冒泡到 `runCourse` 的 `finally`，再被 `:560-565` 记为「课程失败」——一门课都没跑就整批失败（只在 canStart 为 false 时触发，而 canStart 详见 P0-1）。

**建议**：统一 `String(courseId).slice(0, 8)`；并且 `businessId` 缺失时应跳过该任务并记录。

### P1-10 章节只遍历一层，嵌套章节结构被丢掉
- `userscript/tobacco-mooc-fast.user.js:339-350`
```js
for (const ch of body) {
  for (const sec of ch.courseChapterSections || []) {
```
**原因**：`chapter-progress` 若返回树形结构（章节里还有子章节，平台常见 `children`/`courseChapters` 嵌套），第二层之后的小节全部被忽略；`runCourseInner` 只看到部分小节，`todo` 不全，`settleNested` 的父级结算自然失败。`:370-375`（库课程）同样是单层。

**建议**：递归展开（并限制深度），或至少检测 `ch.children?.length` 时记录一条明确日志，避免静默漏课。

### P1-11 任务列表分页会漏课（`body.total || 0` + 硬编码 500）
- `userscript/tobacco-mooc-fast.user.js:320-333`
```js
const [code, body] = await api2.req("GET", API.TASKS, { params: { page, pageSize: 500, status: "", filterAuthExam: 1 } });
...
if (!items.length || items.length < 500 || all.length >= (body.total || 0)) break;
```
**原因**：① 服务端常把 `pageSize` 上限压到 100/50，此时 `items.length < 500` 立刻 break，**第 1 页之后的所有任务被静默丢弃**；② `body.total` 缺失时 `(0)` 使 `all.length >= 0` 恒真，同样只取第一页；③ `body.total` 若是「总页数」而不是「总条数」，也会提前结束；④ 按 `t.id` 去重，若 `id` 缺失则所有 undefined 互相吞掉（`:327-329`）。

**建议**：以「本页返回条数 < 实际请求条数」为准，并显式读取服务端回显的 `pageSize`/`total`；无 `id` 时用 `businessId` 兜底。

### P1-12 任务过滤的魔法数字可能漏掉「未开始」的任务
- `userscript/tobacco-mooc-fast.user.js:333` `return all.filter((t) => [1, 2].includes(t.status) && [1, 2].includes(t.businessType) && !DONE.has(t.finishStatus) && !t.expired);`

**原因**：`status`/`businessType` 白名单是裸数字，README 与附加说明都没有给出枚举含义，平台枚举变更/新增值即静默漏课；`!t.expired` 若接口返回字符串 `"0"`（未过期）则为 `false` → 任务被丢弃。`finishStatus` 未做 `Number()` 归一，字符串 `"2"` 不会被 `DONE` 命中 → 已完成课程被重跑。

**建议**：把枚举写成常量表并注释来源；`expired` 用 `t.expired === 1 || t.expired === true` 判定；`finishStatus: Number(t.finishStatus)`。

### P1-13 库课程分支：`registerStudy` 结果被丢弃 + 完成状态恒为 0（每次都重刷）
- `userscript/tobacco-mooc-fast.user.js:362` `await api2.req("POST", API.REGISTER_STUDY, { data: { courseId, type: 1, isRequired: 0 } });`（返回值完全不用）
- `userscript/tobacco-mooc-fast.user.js:371-372` `secs.push({ ..., type: map[ft] ?? 0, finish: 0, studied: 0 });`

**原因**：① 报名失败也继续请求 `info`，错误信息最后显示成「课程信息请求失败(HTTP …)」，误导排查方向；② `finish` 硬编码 0 ⇒ `todo` 包含全部小节，**已完成的库课程每次运行都会被重新 `start-progress` + 上报一遍**（幂等性/风控面都变差），而任务模式会用 `finishStatus` 跳过（`:484`）。③ `map[ft] ?? 0` 让未知 `fileType` 变成 type 0，落进「通用 doc 上报」分支（`:448` 走 `DOC`），可能给 scorm/kj 之类不该报的类型伪造 doc 进度。

**建议**：检查 `registerStudy` 的 `code`/`errorCode`；库课程从 `info` 响应里读真实 `finishStatus`/`studyTotalTime`；未知 `fileType` 直接判跳过并记录日志，不要默认走 doc 上报。

### P1-14 库课程里 `other`(10) 被当成关联课程递归
- `userscript/tobacco-mooc-fast.user.js:369` `const map = { ..., other: 10, ... };`
- `userscript/tobacco-mooc-fast.user.js:409-410` `if (sec.type === NESTED) { ... await runCourse(sec.rid, depth + 1); }`

**原因**：`NESTED = 10`（`:111`）在任务模式里代表「关联课程」（`referenceId`=子课、`resourceId`=资源），但库课程里 `other` 被映射成 10，`rid` 却是 `attachmentId`（`:371`）。结果是拿附件 id 去 `POST register` 当课程报名，产生无意义请求、可能错误报名，并把父级结算逻辑套在非课程小节上。

**建议**：库课程映射改用独立枚举值（如 `-1`/`100`），或在库分支禁用 `NESTED` 递归。

---

## P2 — 健壮性 / 细节 / 安全

### P2-1 每轮重新 `start-progress`：孤儿日志 + 40909 冲突面变大
- `userscript/tobacco-mooc-fast.user.js:429`（每轮新建日志）、`:450-452`（40909 → `sleep(1e3); continue;`）、`:392`（`settleNested` 每次重试也 `startProgress`，最多 4 个额外日志）
**问题**：一次小节要开 `ceil(total/90)` 条学习日志；中途停止（`stopFlag` 只在 `:426` 检查）或被 `startProgress` 之后的异常打断，会留下**没有进度上报的空日志**（与附加说明「停止…不会留下半条日志」矛盾）；`40909 continue` 不消耗新日志但消耗轮次，且不计入 `stuck`/失败计数，可能一直重试到轮次用完才报「轮次用完」。
**建议**：一轮一个日志能复用就复用（`startProgress` 返回的 `logId` 在 `remainingTime` 未归零前可继续用），40909 改为带指数退避的重试并计数上限。

### P2-2 `errorCode` 未做类型归一
- `userscript/tobacco-mooc-fast.user.js:235` `new Set([90901, 90902])`、`:294`、`:451` `body.errorCode === 40909`
**问题**：若接口把 `errorCode` 序列化为字符串（Python 后端常见），鉴权判断与并发冲突判断双双失效。
**建议**：`Number(body.errorCode)` 后比较。

### P2-3 面板 2 秒定时器既不清理也会叠加
- `userscript/tobacco-mooc-fast.user.js:792-826`（`watchTheme()` 内 `tick()` + `setInterval(tick, 2e3)` + `window.addEventListener("hashchange", tick)`）
**问题**：每次 `mount()` 都新建一个 2 秒定时器与一个 hashchange 监听，从不 `clearInterval`/`removeEventListener`；面板被 `remove()`（`:925`）后定时器仍在跑。`tick()` 里每次调 `headerColor()`（`:682-706`：`document.elementsFromPoint` + 对顶栏所有子孙做 `getComputedStyle`），长期驻留页面上是持续开销；`:795-800` 里 `buddy.parentElement.getBoundingClientRect()` 在 `parentElement` 为 null 时会抛错，且因为在 `setInterval` 中会每 2 秒刷一次报错。
**建议**：保存 interval/监听句柄并在 `unmount` 时清理；`tick` 整体 `try/catch`；`headerColor` 结果缓存（`last` 已有，但计算在判重之前）。

### P2-4 `document-start` 直接 `appendChild(documentElement)`，无就绪保护
- `userscript/tobacco-mooc-fast.user.js:751`/`:771` `document.documentElement.appendChild(box);`
- `userscript/tobacco-mooc-fast.user.js:919-930`（`boot()` 内先 `mount()`，之后才导出 DEBUG）
**问题**：`document-start` 阶段若 `document.documentElement` 为 null，`mount()` 抛 TypeError → `boot()` IIFE 中断 → **连 `__MOOC_US_DEBUG__` 和后面全部 `GM_registerMenuCommand` 都不会注册**（在 Try 之外）。
**建议**：`mount()` 入口判 `if (!document.documentElement) { document.addEventListener("DOMContentLoaded", mount, {once:true}); return; }`；`boot()` 用 `try/catch` 包住；菜单注册提到 `boot()` 之前。

### P2-5 令牌后缀与全部日志进 console / 面板 DOM
- `userscript/tobacco-mooc-fast.user.js:29` `log(`令牌已捕获 (${v.slice(-8)})`);`（目前被 `:21` 的默认 noop 吞掉）
- `userscript/tobacco-mooc-fast.user.js:665-675` `log()` 把每条消息同时写入 `logEl`（页面 DOM，屏幕可见）和 `console.log`
**问题**：一旦按 P1-4 接通日志，token 末 8 位会进入 console 与页面 DOM（直播/录屏/共享屏幕即泄露）；面板常驻 DOM 也让它可被平台前端脚本检测（工具指纹）。
**建议**：令牌只打长度/前 4 位或完全不打印；面板与 console 分离（console 保留、DOM 脱敏），或加「隐藏日志」开关。

### P2-6 账号密码明文存 GM
- `userscript/tobacco-mooc-fast.user.js:954-960`
```js
const u = prompt("账号:"); ... const p = prompt("密码:");
gm.setValue("account", { username: u, password: p });
panel.log("账密已保存(仅存于本机油猴存储)");
```
**问题**：① 明文落盘到扩展存储，任何能读扩展数据目录/同 namespace 脚本的程序都能拿到；② `prompt` 的密码框**不是** 密码类型，输入时明文可见；③ 用户名不 `trim()`、不做长度/字符校验；④ 「仅存于本机」的措辞给人错误的安全感。
**建议**：至少提示「明文存储、建议用带独立密码的专用账号」；`username.trim()`；对长度做上限；若可行用 `GM_setValue` + 本地口令派生（`crypto.subtle`）加密后才落盘。

### P2-7 单档秒数 prompt 无上限
- `userscript/tobacco-mooc-fast.user.js:940-944`
```js
const v = Number(prompt("每个小节每次上报的秒数(≥30, 默认600):", ...));
if (Number.isFinite(v) && v >= 30) { gm.setValue("chunk", Math.trunc(v)); ... }
```
**问题**：没有上限。填 `1e9` 会让 `backdateS` 变成 `Date.now() - 1e12`（1970 年附近甚至负数），`createTime` 语义彻底失真，服务端可能直接拒绝或给出异常额度；`maxRounds` 也随之膨胀。另外提示文案（"每次上报的秒数"）与实际行为不符——真正上报恒为 ≤90s（`:446`）。
**建议**：`v >= 30 && v <= 86400`；文案改为「createTime 回填档位（单轮实际上报恒 ≤90s）」。

### P2-8 重登可能踢掉页面自身会话 / 反复重登
- `userscript/tobacco-mooc-fast.user.js:239-274`（`relogin()`）
**问题**：`credentials: "include"` + `app-login` 会刷新会话 cookie；若平台单会话，登录台会把页面原本的会话顶掉（或反过来被页面顶掉），形成「401 → 重登 → 401」抖动；连续重登还可能触发风控/图形验证（`captcha: ""` 是写死的，遇到验证码必然失败但日志只显示「重登失败 (HTTP 200)」）。另外 `relogin` 成功后只更新内存 token，不写回 `localStorage`，页面自己的请求仍在用旧 token。
**建议**：加全局重登冷却（如 60s 内只允许一次）与失败计数；失败时把响应 body 的 `errorCode`/`message` 打出来（现在是空信息）；成功后视情况同步写入 `localStorage.token`。

### P2-9 `__MOOC_US_DEBUG__` 在生产环境暴露可执行的批量入口
- `userscript/tobacco-mooc-fast.user.js:928-930`
```js
fast: { state, runCourse: (id) => engine.runCourse(id), runAll: () => engine.runAll(), currentBidFromHash: () => currentBid(), log: panel.log }
```
**问题**：① 暴露 `state`（可变）与 `runAll/runCourse`；② 调试用的 `runCourse` **绕过了 `lock.acquire()`**（`lock` 只在 `runAll` 里拿），与正在运行的任务并发执行时会互相覆写 `state.course/section/versionId/round` → 日志错乱、日志记录交叉、40909 增多；③ `currentBidFromHash: () => currentBid()` 绑死了 `location.hash`，外部无法传入 hash 测试（见「无法单测」一节）。
**建议**：用 GM 开关或 `location.search` 上的显式参数 gate 住；`runCourse` 包一层 `runAll` 式互斥；导出真正的 `(hash) => currentBidFromHash(hash)`。

### P2-10 `settleNested` 的硬编码与空值处理
- `userscript/tobacco-mooc-fast.user.js:386-398`
```js
const [logId] = await startProgress(sectionId, 300, 1);
if (logId) { const [, body] = await api2.req("POST", API.DOC, { data: { encrypt: "false", logId, lessonLocation: 999 } }); if (body && DONE.has(body.finishStatus)) return true; }
...
return Array.isArray(rows) && rows.length ? DONE.has(rows[0].finishStatus) : false;
```
**问题**：回填 300s 与 `config.backdateS()` 不一致（配置改了这里不跟随）；用 `doc-progress` + `lessonLocation:999` 给「关联课程」小节上报，语义上是伪造文档进度；`rows[0]` 为 `null` 时 `.finishStatus` 抛错（`rows.length` 检查不到元素为 null 的情况）；`finishStatus` 未 `Number()` 归一。
**建议**：回填值走 config；`rows[0] && DONE.has(Number(rows[0].finishStatus))`。

### P2-11 库课程的 `id` 与任务模式的 `id` 语义不一致
- `userscript/tobacco-mooc-fast.user.js:343` `id: sec.referenceId,`（任务模式）
- `userscript/tobacco-mooc-fast.user.js:371` `secs.push({ id: sec.id, rid: sec.attachmentId, ...`（库模式）
**问题**：同一个 `start-progress/<sectionId>`（`:379`）在两个分支里分别用 `referenceId` 和 `id`，至少有一个是错的（`referenceId` 为空时 URL 会变成 `.../start-progress/undefined`，`req` 仍然 200/404 兜底，最后显示成「start-progress 失败」）。
**建议**：两个分支统一优先取 `referenceId`，回退 `id`，并在为空时跳过该小节并记录日志。

### P2-12 其它小项
- `userscript/tobacco-mooc-fast.user.js:476-482`：`canStart()` 失败返回 `[0, 1]`，被上层计为「未完成 (0/1)」，于是每门课都刷一条 ⚠ 警告；应返回单独的 `{blocked:true}` 让上层静默跳过。
- `userscript/tobacco-mooc-fast.user.js:486-488`：`secs.length === 0` 记 `[0,1]` 并打成「失败」，实际是「无小节」，噪音告警。
- `userscript/tobacco-mooc-fast.user.js:404`：`if (DONE.has(sec.finish)) return [true, "已完成, 跳过"]` 在本路径是死代码（`todo` 已在 `:484` 过滤）。
- `userscript/tobacco-mooc-fast.user.js:522` + `:464-472`：`state2.stopFlag = false` 由 `runAll`/`runCourse` 无条件重置，外部（DEBUG / 上一轮残留）调用会清掉用户刚按下的停止。
- `userscript/tobacco-mooc-fast.user.js:613-649`：`guard` 只写不校验（`hold` 写入后不读回），且 `gm.setValue` 每 15s 一次（`:914-916`），是同步写盘的存储，属于不必要的 IO。
- `userscript/tobacco-mooc-fast.user.js:676-680`：`ui()` 只判 `statusEl`，若 `btnStart` 查询失败（选择器/前缀改动）则在 2s 定时器里持续抛错。
- `userscript/tobacco-mooc-fast.user.js:705-706`：`headerColor` 用 `parseFloat(m[4]) < 1` 过滤透明色，但 `rgba(...)` 无 alpha 时 `m[4]` 为 undefined 已单独判断——逻辑正确，仅提示颜色正则不支持 `color(display-p3 …)`/`rgb(0 0 0 / 50%)` 新语法，取不到就 fallback（可接受）。
- `userscript/tobacco-mooc-fast.user.js:250`：`displayDynamic: encField(true)` 加密的是 `"true"`，而 `toParams`/`pystr`（`:214`）对布尔输出 `"True"`——同一份代码里两套布尔字面量，重登若因该字段失败很难定位。建议与平台实测值对齐并统一。
- `userscript/tobacco-mooc-fast.user.js:245`：`pword` 若含非 ASCII（中文/全角字符），`encField` 先 `TextEncoder` 再 PKCS#7，块长按 UTF-8 字节算——实现本身正确，但与 Java/App 端「按字符数填充」的实现不一致时会被服务端解出乱码；建议加一条「仅支持与 App 一致的 UTF-8 输入」的注释，或对超长密码做长度校验。

---

## 已逐项核对、未发现问题的部分（供参考）

- **AES-128-ECB**（`userscript/tobacco-mooc-fast.user.js:116-192`）：`inv()` 的 8 次平方 + 7 次乘 = `a^254`、SBOX 仿射变换、密钥扩展 `RotWord/SubWord/rcon`、ShiftRows 的 `[0,5,10,15,4,9,14,3,8,13,2,7,12,1,6,11]`、MixColumns 列内字节序、11 次 `AddRoundKey`（`RK[0..160]`）与 PKCS#7 填充、base64 输出，逐项与标准 AES-128 一致，**没有实现错误**。
- **跨脚本互斥**（fast vs realtime）：`createLock`（`:593-608`）+ `guard` 的 owner 字符串不同（`"fast"` / `"realtime"`），这一层是有效的。
- **`AUTH_PAGE_RE`**（`:841`）对 `#/login`、`#/register`、`#/forget`、`#/auth` 匹配正常，不会误伤 `#/authorize`（依赖 `\b`）。
- **`startProgress` 的 `createTime`**（`:378`）整数化正确，`Date.now()` 精度足够。
- **未发现** token 被写入 DOM 或在 `panel.log` 中出现（当前唯一的 token 日志被 noop 吞掉，见 P2-5）。

---

## 无法单测的核心逻辑

### 已导出（`userscript/tobacco-mooc-fast.user.js:928-930`）
```js
window.__MOOC_US_DEBUG__ = Object.assign(window.__MOOC_US_DEBUG__ || {}, {
  fast: { state, runCourse: (id) => engine.runCourse(id), runAll: () => engine.runAll(), currentBidFromHash: () => currentBid(), log: panel.log }
});
```
仅 5 项：`state`（可变状态对象）、`runCourse(id)`、`runAll()`、`currentBidFromHash()`（**无参数、绑死 `location.hash`，等于不可测**）、`log(msg)`。

### 未导出、因而完全无法单测的核心逻辑（按重要性）
1. **`encField` / `expandKey` / `encryptBlock` / `KEY` / `SBOX`**（`:116-192`）——最该有测试向量（NIST FIPS-197 已知答案测试）的部分，一个字节错就会导致重登/上报全部 400，但对外完全不可见。
2. **`createTokenHunter` 的内部函数** `setToken` / `waitToken` / `tokenFromStorage` / `installHooks`（`:21-90`，即使 `createTokenHunter` 本身也未导出；`hunter` 是模块内局部变量 `:866`）。
3. **`createApi` 的 `req` / `relogin`**（`:236-312`）——鉴权重试、409/401 分流、`retry once` 逻辑是最高风险区，`api` 也是局部变量（`:867`）。
4. **engine 的全部内部函数**（`:317-591`）：`undoneTasks`（分页/过滤）、`sections`（章节树展开）、`openCourse`/`openLibraryCourse`（报名回退）、`startProgress`（三态解析）、`progressUpdate`、`settleNested`、`doSection`（轮次/秒数/配额判定主循环）、`runCourseInner`、`QuotaExhausted`。`createEngine` 未导出，导出的只有两个外层包装。
5. **`config` 生成逻辑**（`:870-878`）：`getStep()`（`chunk()` 的 `Math.max(30, …)` 兜底）、`backdateS()`（660–900 区间）、`roundSleepMs`、`taskGapMs`、`roundsSlack` —— 「600s/轮」这类最容易回归的数值全在这里。
6. **`fingerprintFor` / `hash32` / `DEVICES` / `SYSTEMS`**（`:195-215`）：设备指纹必须稳定，改一个样本条目就会让所有用户的 `terminal` 变化（可能触发风控），却不可测。
7. **`util` 的 `pystr` / `toParams` / `qs` / `form`**（`:217-231`）：`True/False`、`null` 跳过、`""` 保留等平台契约细节。
8. **`createLock` / `createSessionGuard`**（`:593-649`）：互斥语义（正是 P0-1 的 bug 所在），完全不可注入 `win`/`now` 来测。
9. **`createPanel`**（`:651-829`）：`headerColor`、拖拽边界、`mount` 幂等（P1-1）、`watchTheme` 清理 —— 全是纯 DOM 逻辑，理论上可用 jsdom 测，但没有导出。
10. **`routes`**（`:832-843`）：`currentBidFromHash(hash)` 本身是纯函数、最适合写用例，却被包成 `() => currentBid()` 后导出；`isAuthPage(hash)` 未导出。
11. **常量表** `API` / `MAX_STEP` / `MEDIA` / `NESTED` / `SKIP` / `DONE` / `TYPE_NAME`（`:93-113`）：无法对「跳过规则」写断言。

**建议（不改代码，仅方向）**：把 `window.__MOOC_US_DEBUG__` 扩成 `{ aes: {encField}, token: createTokenHunter, api: {createApi, relogin}, engine: {createEngine}, routes: {currentBidFromHash, isAuthPage}, config, constants: {API, MEDIA, SKIP, DONE, NESTED, TYPE_NAME}, lock: createLock, guard: createSessionGuard }`，并让 `engine` 的 `sleep`/`now`/`fetchImpl`/`win` 全部可注入——现有签名（`createApi({fetchImpl})`、`createEngine({sleep, lock, currentBid, playSection})`、`createLock(kind, win)`、`createSessionGuard(gm, {now})` 都已预留注入点，只差「导出」。

---

## 文档不一致清单

对照 `README.md` 与 `userscript/tobacco-mooc-fast.additional-info.md`：

| # | 文档位置 | 文档说法 | 代码实际 | 行号 |
|---|---|---|---|---|
| 1 | `userscript/tobacco-mooc-fast.additional-info.md`「token 不用填…**脚本不收集、不保存、也不代你登录**」「登录态失效时它会**直接停下**报「登录态失效」」 | 不保存账密、不代登录、失效即停 | 完整实现了账密保存（明文）、`app-login` 重登、`company_name` 单位名，并在 401 后自动重登重试 | `userscript/tobacco-mooc-fast.user.js:239-274`、`:947-952`、`:954-960` |
| 2 | `userscript/tobacco-mooc-fast.additional-info.md` 菜单表 | 只列 2 项（显示/隐藏面板、设置单档秒数） | 实际注册 5 项：+`设置单位名称`、`保存账号密码`、`清除账号密码` | `:932`、`:940`、`:947`、`:954`、`:962` |
| 3 | `userscript/tobacco-mooc-fast.additional-info.md` FAQ「报 401 或 errorCode 90901 / 90902」 | 「没有（新令牌）就**停下**」 | 有保存账密时会自动重登并重试（README 描述才是对的） | `:297-305` |
| 4 | `userscript/tobacco-mooc-fast.additional-info.md`「停止是等当前这一轮报完再退，**不会留下半条日志**」 | 不留残缺日志 | 每轮都新开 `start-progress`（`:429`），`stopFlag` 仅在循环顶部检查（`:426`），停止/异常会留下无上报的空日志；`settleNested` 每次重试再开一条（`:391`） | `:426`、`:429`、`:391` |
| 5 | `README.md`「面板按钮会先看当前 URL：停在**课程/专题详情页**就只处理这一门」 | 详情页即单课模式 | `currentBidFromHash` 的正则要求 `course/detail/<数字>&<…>`（必须带 `&`）或 `subject/detail/<id>`；兄弟脚本另有 `STUDY_PAGE_RE = /#\/study\/(?:course\/detail\/\d|subject\/detail\/[0-9a-zA-Z-]{8,})/`（`userscript/tobacco-mooc-unattended.user.js:889`），说明 `#/study/course/detail/123` 这类地址也算学习页，本脚本却会解析出空 `bid` → **回退到任务列表模式，把整批课都刷了** | `userscript/tobacco-mooc-fast.user.js:832-838`、`:515-547` |
| 6 | `README.md`「平台开了 `enableUnique=1`…同一账号不要在多台设备、多个浏览器上同时跑」+ `additional-info`「同页互斥，**跨标签页 45 秒防多开**…同时启用会直接拒启动」 | 跨标签页有防护 | 同脚本跨标签页防护**完全无效**（owner 常量，见 P0-1）；只有 fast/realtime 跨脚本互斥有效 | `:635`、`:641`、`:881`、`:899`、`:903` |
| 7 | `README.md`「全部处理完（且不是配额耗尽）会在 2 秒后自动刷新页面」 | 只有正常完成才刷新 | `runAll` 吞异常后返回 `undefined`，入口判为「非配额」→ **失败/致命错误后同样自动刷新** | `:576-578`、`:905-908` |
| 8 | `README.md` / `@description`「600s/轮」「每轮提交时长 90s（平台上限）」 | 600s 是回填档位 | 代码正确（`step = min(600, rem, 90)`），但**菜单 prompt 文案**仍写「每个小节**每次上报**的秒数(≥30, 默认600)」，与实际每次上报 ≤90s 冲突 | `:446`、`:941` |
| 9 | `additional-info`「设置单档秒数(≥30)…低于 30 直接拒收」 | 只校验下限 | 只有下限，**无上限**，可填 `1e9` 使 `createTime` 进入 1970 年（P2-7） | `:940-944` |
| 10 | `README.md`「能刷：…关联课程(10，**递归两层**，子课刷完再结算父记录)」 | 两层 | 实现是 `depth >= 2` 即跳过（`doSection` 里），父课 depth 0 → 子课 depth 1 可跑，子的孙（depth 2）被拒；**库课程**里 `other` 也被映射成 10 并被递归（P1-14），文档未提这个差异 | `:409-410`、`:369` |
| 11 | `README.md`「跳过：…scorm(4)、任务(8)、课件(15) 暂无上报协议」 | 这些类型一律跳过 | 任务模式正确（`SKIP` 含 4/8/15）；**库课程**里未知 `fileType` 被 `map[ft] ?? 0` 变成 type 0 并走 `doc-progress` 上报，绕过了跳过规则 | `:111`、`:448`、`:371-372` |
| 12 | `README.md`「面板按钮…否则拉「我的任务」列表按课推进」+ 接口清单「10 页 × 500 条」 | 最多 10 页 × 500 | 只要单页返回少于 500 条就停止翻页（多数服务端会压 `pageSize`），实际很可能只拉一页（P1-11） | `:324`、`:331` |
| 13 | `README.md` / `additional-info`「已完成的（`finishStatus ∈ {2,4}`）直接略过，不重复提交」 | 幂等 | 仅任务模式成立；库课程 `finish` 恒为 0，每次运行都重新上报（P1-13） | `:371-372`、`:484` |
| 14 | `README.md`「面板可拖拽」 | 可拖拽 | 只绑了 `mousedown/mousemove/mouseup`，无 `pointerdown`/touch，触屏设备上拖不动 | `:707-748` |
| 15 | `README.md`「两个脚本用同一把会话锁，**同页互斥**」 | 同页互斥 | `__MOOC_US_LOCK` / `__MOOC_US_DEBUG__` 挂在沙箱 `window` 上，跨脚本可见性依赖管理器（TM/Violentmonkey 行为不同），建议用 `unsafeWindow` 固定语义 | `:593-608`、`:928` |
| 16 | `additional-info` 版本/升级 | — | 两个脚本 `@version 0.0.1`（`userscript/tobacco-mooc-fast.user.js:4`），仓库只有 `959e1c2 Initial commit`；README 已在 GreasyFork/ScriptCat 上发布（604497 / 9059），发布版本号从未递增，用户端不会收到更新 | `userscript/tobacco-mooc-fast.user.js:4` |
| 17 | `README.md`「学时按日累计上限 **24 小时**」 | 24h/日 | 平台未在代码中体现，也无接口校验；纯假设。而 P0-3 的配额判定逻辑与之并不等价（单小节两轮不变即判满） | `:437-441` |
| 18 | `README.md`「每 10s 查一次播放进度…`wakeLock`…每 12s 补鼠标移动」 | 无人值守专属 | 标注清楚，快速模式确实没有 `playSection`（`createEngine` 调用未传，`:910`），此处**一致**，仅提示读者别混淆 | — |

---

**最高优先级修复顺序建议**：P0-1（防多开，账号风险）→ P0-2（假完成，结果错误）→ P0-4（失败也 reload，误导）→ P0-3（误判配额）→ P1-1（面板消失）→ P1-2/P1-3（卡死与令牌失手）→ P1-4/P1-5（服务可用性）→ 其余。
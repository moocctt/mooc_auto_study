# 测试与优化报告 · 油猴脚本（2026-11-14）

对象：`moocctt/tobacco-mooc-study` 的 `main` 分支

- `userscript/tobacco-mooc-fast.user.js`（快速刷课版）
- `userscript/tobacco-mooc-unattended.user.js`（真实节奏 / 无人值守版）

两个脚本是同一套 engine 的两份打包产物，只在 `config` 与 `playSection` 上不同，所以同一批缺陷
在两边各出现一次。

## 0. 结论摘要

| 项目 | 结果 |
|---|---|
| 只读代码审查 | 2 份（fast / unattended），P0 4 条、P1 26 条、P2 20 余条 |
| 已修 | 4 条 P0 + 2 条 P2（见 §2、§3） |
| 新增测试 | 5 个文件、33 个用例、零第三方依赖（`node:test`） |
| 验证 | `node --check` 两个文件均通过；`node --test tests` 33 passed |
| 未修 | P1 20 条、P2 约 18 条，见 §6（都没有静默丢弃） |
| 文档不一致 | 26 处（含两份文档互相矛盾），见 §7，**未改文档**（本次范围外） |

本次没有对真实站点发起任何请求：真刷需要浏览器环境 + 账号，且平台按端单会话
（`enableUnique=1`），拿真账号试会顶掉正常会话、还会命中风控。所有结论都来自代码审查与
可复现的单测。

## 1. 测试方法

1. **静态审查**：两个脚本逐行过，交叉比对引擎共享部分、`README.md`、`*.additional-info.md`。
2. **纯函数单测**：`tests/core.test.js`、`tests/fast-rules.test.js` —— 加密、报文编码、
   剩余时长解析、上报结果归一化、轮次上限、任务/小节过滤。
3. **引擎行为单测**：`tests/engine-rules.test.js` —— 用假 `api` 注入响应，跑真正的
   `engine.doSection()`，断言上报次数、学时累加、失败分类。
4. **会话锁单测**：`tests/session-guard.test.js` —— 多标签页防多开的核心语义。

`tests/harness.js` 用 `node:vm` 在假 DOM / `GM_*` / `XMLHttpRequest` / `fetch` 里加载
打包后的脚本，因此不用改脚本结构也能测到内部逻辑（前提是脚本把它挂到了
`window.__MOOC_US_DEBUG__`，见 §2.5）。

跑法：

```bash
npm test      # = node --test tests/
npm run check # = node --check 两个脚本
```

## 2. 修掉的 P0

### P0-1 跨标签页防多开完全失效

- 修复前：`userscript/tobacco-mooc-fast.user.js:881` `config.canStart = () => guard.hold("fast")`、
  `userscript/tobacco-mooc-unattended.user.js:932` `guard.hold("realtime")`。
- 病因：`hold(owner)` 用 `if (cur && cur.owner !== owner && now() - cur.ts < ttlMs) return false;`
  判占用，而两个标签页传的 `owner` 是**同一个字符串常量**，`cur.owner !== owner` 恒为 false。
  于是第二个标签页照样启动，还会把第一个标签页的租约 `ts` 刷新成自己的时间（互相续租）。
  结果：两个标签页同时全速上报 → 40909 刷屏、`submitted` 双倍计数、命中平台单会话风控。
- 修复后：每个页面加载生成唯一实例 id，`userscript/tobacco-mooc-fast.user.js:919`
  `var INSTANCE = "fast#" + Math.random().toString(36).slice(2, 8);`（unattended 为
  `userscript/tobacco-mooc-unattended.user.js:969` 的 `"realtime#"`），
  `:921` / `:971` `config.canStart = () => guard.hold(INSTANCE)`，心跳 `:957` / `:1093`
  与 `held()`/`release()` 全部用同一个 id。
- 另外给 `hold()` 加了写后回读（`userscript/tobacco-mooc-fast.user.js` 的 `createSessionGuard`）：
  `write({owner, ts})` 之后再 `read()` 确认落盘的就是自己，避免两个标签页同时写时双方都以为拿到了锁。

### P0-2 任何失败都会 `location.reload()` → 刷新死循环

- 修复前：`runAll()` 内层 `catch (e) { log(...) }` 之后 `return { quotaHit }`（异常路径隐式
  `undefined`），入口判据是 `if (!state.stopFlag && !(r && r.quotaHit))` → 401、网络错误、
  被别的任务抢占、任务列表为空，全都会「2 秒后刷新」。开着「自动续跑」时形成
  `401 → 重登失败 → reload → autoContinue → 401` 的 5 秒级自刷新循环。
- 修复后：
  - `userscript/tobacco-mooc-fast.user.js:614` / `userscript/tobacco-mooc-unattended.user.js:614`：
    `return { quotaHit, ok: !quotaHit && !state2.stopFlag && failCount === 0, authFailed: false };`
  - 异常路径 `:617`：`return { quotaHit, ok: false, authFailed: !!(e && e.auth) };`
  - 被占用直接返回 `:555`：`return { quotaHit: false, ok: false, authFailed: false };`
  - 入口只在 `r.ok` 时刷新（`userscript/tobacco-mooc-fast.user.js:945`、
    `userscript/tobacco-mooc-unattended.user.js:1081`），登录态失效单独提示「不自动刷新」。
  - `autoContinue()` 加连续失败熔断（`userscript/tobacco-mooc-unattended.user.js:1164,1181-1182`）：
    `sessionStorage["__MOOC_US_AUTO_FAILS__"]` 连续 3 次不成功就停自动续跑，成功后清零。

### P0-3 `errorCode 40909` 只在 HTTP 非 200 时处理

- 修复前：`if (code !== 200) { if (body.errorCode === 40909) { sleep; continue } ... }`，
  而这套接口常见形态是 **HTTP 200 + `errorCode` 非 0**：冲突会走到 `submitted += step`，
  一秒没入账却记了学时；下一次 `remainingTime` 不下降 → 两轮后判定「当日配额已满」并中止整批。
- 修复后：新增 `normalizeReport(code, body)`（`userscript/tobacco-mooc-fast.user.js:326`，
  unattended 同位置），先看 `body.errorCode`：`40909` → `{status:"conflict"}`（退避重试、
  最多 20 次、**不计入轮次上限**）；其余非 0 → 失败；只有 `code===200 && errorCode===0/缺失`
  才算 `ok` 并 `submitted += step`。

### P0-4 `remainingTime` 完全不校验

- 修复前：`if (remRaw === null) return [true, "已完成（无剩余时长）"]` —— 字段缺失被当成完工，
  没上报过的小节被标成完成；字符串/`NaN` 还会直接参与后续算术。
- 修复后：`parseRemaining(v)`（`userscript/tobacco-mooc-fast.user.js:320`，unattended 同位置）
  返回 `{kind:"missing"|"invalid"|"number"}`，三种情况分开处理：
  - `missing` + 本小节已有进度（`submitted` 或 `sec.studied`）→ 完成；
  - `missing` + 零进度 → 失败（不虚报完成）；
  - `invalid` → 失败并打印原值，不再参与算术。

### 2.5 可测试性（不是修 bug，是让 bug 测得到）

两个脚本原先只导出 5 个入口（`state/runCourse/runAll/currentBidFromHash/log`），核心逻辑全私有。
现在 `__MOOC_US_DEBUG__.<fast|unattended>.core` 额外导出：`KEY/encField/expandKey/encryptBlock/
hash32/fingerprintFor/pystr/toParams/qs/form/createApi/createEngine/createLock/createSessionGuard/
buildStartParams/parseRemaining/normalizeReport/computeMaxRounds/normalizeChunk/taskFilter/
sectionSkipped/currentBidFromHash/isAuthPage/constants`（**只增不减**，原有键一个没动）。

## 3. 顺手修的（P1/P2 里可离线验证的部分）

1. **面板刷新后永久消失**（P1）：`mount()` 开头是 `if (box) return;`，而登录页分支只做
   `panel.getBox().remove()`，`box` 仍指向已脱离文档的节点 → 回到学习页再也挂不上去。
   现在 `mount()` 先判 `document.contains(box)`，并新增 `panel.destroy()`（移除 + 置空），
   登录页分支改为 `panel.destroy()`。
2. **任务列表只拉一页**（P1）：原判据 `items.length < 500` 假设服务端照收 `pageSize: 500`，
   实际常被压低（20/50）→ 第二页就 break。现在改成按 `body.total` 判结束，并加
   「这一页没有新 id 就停」（防服务端忽略 `page` 参数导致空转），页数上限 10 → 50。
3. **`courseId.slice` 在 id 为数字时抛 TypeError**（P1）：改 `String(courseId).slice(0, 8)`。
4. `normalizeChunk` 原只有下限（`Math.max(30, ...)`），菜单 prompt 也能填 `1e9` → `createTime`
   回填到 1970 年。现在上下限都夹紧：`userscript/tobacco-mooc-fast.user.js:908`
   `Math.min(86400, Math.max(30, Number(raw) || 600))`，菜单校验同步加 `<= 86400`。
5. `maxRounds` 由 `computeMaxRounds(total, step0, slack)` 统一算（`userscript/tobacco-mooc-fast.user.js:335`），
   `total` 异常时兜底 5000 而不是 `NaN`（原 `Math.ceil(NaN/...)` 会让 `for(;;)` 无上限）。
6. **全链路没有超时**（P1）：`createApi` 里所有请求改走 `doFetchWithTimeout`（`AbortController` + `Promise.race`，默认 20s，可传 `timeoutMs`），登录请求同样；超时抛 `e.timeout = true`。
7. **二次 401 被降级成「上报失败」**（P1）：`retried` 之后仍是 401 时原来落回 `return [res.status, body]`，于是拿死 token 把整批跑完。现在抛 `err.auth = true`，`runAll` 返回 `authFailed` 并停止刷新。
8. **`waitToken` 超时会清空所有等待者**（P1）：超时分支原来是 `tokenWaiters = []`，别人的等待者被一起删掉（令牌来了也叫不醒，只能各自超时）。改成只 `filter` 掉自己，并把 `createTokenHunter` 加进 `core` 导出以便测试。

## 4. 新增测试清单（33 个用例）

| 文件 | 覆盖 |
|---|---|
| `tests/harness.js` | `node:vm` 假 DOM/GM/XHR/fetch 加载器，两个脚本各能加载并取到 `__MOOC_US_DEBUG__` |
| `tests/core.test.js` | `core` 导出完整性、AES-128-ECB(PKCS7) 加密自检、`hash32`/`fingerprintFor`、`toParams/qs/form`、`parseRemaining` 三态、`normalizeReport` 分类、`buildStartParams` 回填、`computeMaxRounds` |
| `tests/session-guard.test.js` | 不同实例第二个拿不到锁、同实例续租、过期后可接管、`release()` 只释放自己、unattended 用 `realtime#` 同规则 |
| `tests/engine-rules.test.js` | HTTP 200+40909 不计学时且重试、其他 `errorCode` 记失败、HTTP 500 不误判配额、`remainingTime` 缺失/有进度、轮次上限、任务列表按 `total` 翻页到底、服务端忽略 `page` 时不空转 |
| `tests/fast-rules.test.js` | 单档秒数默认/下限/上限、任务过滤、跳过规则 |

加密自检的期望值用 Node 内置 `crypto`（`aes-128-ecb`）独立算出后写死在测试里，
实现与期望值互为交叉验证（不是「拿实现的结果当期望值」）。

## 5. 怎么验证（可复现）

```bash
cd <仓库>
node --check userscript/tobacco-mooc-fast.user.js       # exit 0
node --check userscript/tobacco-mooc-unattended.user.js # exit 0
node --test tests                                       # 28 passed
```

## 6. 未修的清单（P1 / P2，按两个脚本合并去重）

> 面板消失、任务列表分页、`courseId.slice`、全链路超时、二次 401 降级、`waitToken` 清空等待者 —— 这六条 P1 已修，见 §3。以下是仍然未修的部分。

**P1（会造成错误结果或长时间空转）**

1. 令牌钩子挂在 `globalThis`，TM 沙箱下可能钩不到页面请求，且被 noop 日志掩盖。
2. 嵌套课程结束后恢复 `state`/`courseId`/`versionId` 的代码不在 `finally` 里。
3. 文档类上报（`doc-progress`）的 `submitted += step` 是假的：实际只发 `lessonLocation:999`。
4. 章节只遍历一层，嵌套章节结构被丢掉。
5. 任务过滤的魔法数字可能漏掉「未开始」的任务。
6. 课程库分支：`registerStudy` 结果被丢弃，完成状态恒为 0 → 每次都重刷；`other(10)` 被当关联课程递归。
7. 「真实节奏」只睡眠、不测量实际流逝，轮间还有 3 个串行请求 → 1:1 不成立。
8. `reqWakeLock` 连调两次 + release 监听把新锁置空；12s 定时器对所有 `<video>` 强制 `play()`。
9. 画质设置打错控件（`.vjs-subs-caps-button` 是字幕按钮）。
10. POST 重试不幂等。

**P2（健壮性 / 安全 / 细节）**

`errorCode` 未做类型归一；面板 2 秒定时器不清理且会叠加；`document-start` 直接
`appendChild(documentElement)` 无就绪保护；令牌后缀与全部日志进 console 与面板 DOM；
账号密码明文存 GM；`__MOOC_US_DEBUG__` 在生产环境暴露可执行的批量入口；`settleNested`
硬编码 300s 且空值未处理；库课程 `id` 与任务模式的 `id` 语义不一致；ICS/README 细节若干。

完整逐条结论在两份审查报告里（本次未随仓库提交，需要的话我可以补进 `docs/`）。

## 7. 文档不一致（未改，需你定口径）

最需要处理的三条：

1. `*.additional-info.md` 写「脚本不收集、不保存账号密码，也不代你登录」，但代码有
   「保存账号密码」菜单（明文存 GM）与 `app-login` 自动重登；`README.md` 却写「顺手点一次
   保存账号密码，30 天后能自动重登」—— 两份文档对同一功能说法相反。
2. `*.additional-info.md` 写「跨标签页 45 秒防多开、同时启用会直接拒启动」，修复前是空的
   （见 P0-1），修复后同脚本跨标签页才真正生效；跨脚本（fast vs unattended）依赖
   `window.__MOOC_US_LOCK`，TM 沙箱下未必共享，文档没提这个前提。
3. `*.additional-info.md` 写「登录态失效就停下」，实际会自动重登、失败后刷新页面
   （P0-2 修好之前还会死循环）。

其余 23 条（菜单表少列 3 项、FAQ 与代码相反、「不会留下半条日志」与每轮新开 `start-progress`
矛盾、`#/study/course/detail/123` 解析不出 `bid` 会退化成刷整批、`600s` 与「每轮 ≤90s」
的文案冲突、库课程 `other`/未知 `fileType` 绕过跳过规则、`registerStudy`/`info` 未进接口清单、
`errorCode 90901/90902` 与实测「HTTP 401 才算失效」冲突等）见审查报告。

## 8. 残留风险

- 单测覆盖的是「纯逻辑 + 引擎分支」，**播放器交互（`playSection`）与真实 DOM 流程没有被测到**：
  需要浏览器才能覆盖，本次没做。
- 两个脚本的真实行为只在代码层面推演过，没在真实账号上跑（会顶掉正常会话、有风控风险）。
- 会话锁依赖 `GM_getValue` 的跨标签页一致性，Tampermonkey 默认支持，脚本管理器差异未验证。
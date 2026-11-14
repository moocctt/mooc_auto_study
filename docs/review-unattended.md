﻿# 代码审查报告 · tobacco-mooc-unattended.user.js（2026-11-14，修复前基线）

> 只读审查，行号对应当时的代码；后续修复情况见 docs/test-report-2026-11-14.md。

# 代码审查报告 · `C:\Users\user\desktop\tobacco-mooc-study\userscript\tobacco-mooc-unattended.user.js`

（约 1125 行，单 IIFE 打包产物，内部按 `// src/xxx.js` 分段。下文行号均指该文件；为便于阅读缩写为 `userscript/tobacco-mooc-unattended.user.js:N`。**未修改任何文件**。）

---

## P0 · 会直接破坏核心契约或造成无界循环

### P0-1 跨标签页「防多开」彻底失效 —— owner 是常量 `"realtime"`
- 位置：`userscript/tobacco-mooc-unattended.user.js:611-648`（`createSessionGuard`）、`:932`、`:1035`、`:1051-1053`
- 现象：
  ```js
  // :633-636
  hold(owner) { const cur = read();
    if (cur && cur.owner !== owner && now() - cur.ts < ttlMs) return false; ... }
  // :639-641
  held(owner) { ... && (owner ? cur.owner !== owner : true) }
  // :932
  config.canStart = () => guard.hold("realtime");
  ```
  两个标签页调用时传入的 `owner` **都是字符串 `"realtime"`**，`cur.owner !== owner` 永远为 `false`。
- 为什么错：`hold()` 因此永远返回 `true`，`held()` 永远返回 `false`。标签页 A 在跑、标签页 B 点开始时，B 不会拒绝启动，而且 `hold()` 还会**把 A 的租约 ts 刷新成 B 的当前时间**（互相续租）。结果：两个标签页同时全速上报 → 40909 并发冲突刷屏、`剩余时长` 抖动、`submitted` 双倍计数、平台 `enableUnique=1` 风控直接命中。README「跨标签页 45 秒防多开」是空头承诺。
- 建议：owner 用每次加载唯一的实例 id（`const INSTANCE = 'realtime#' + Math.random().toString(36).slice(2,8)`，lock.js 里的 `MY` 已经是这种写法，这里却没复用），`hold(INSTANCE)` 且判重时比较"是否同一 instance"；心跳 `/ :1051-1053` 用同一个 INSTANCE；再加一个 `tabId` 到 `held()` 的语义（同 owner 不同 instance 也算占用）。

### P0-2 401 / 任何失败都会触发 `location.reload()` → 刷新死循环（含 autoContinue 放大器）
- 位置：`:1041-1046` + `:579-580`
  ```js
  // :1041-1045
  engine.runAll().then((r) => {
    if (!state.stopFlag && !(r && r.quotaHit)) {
      panel.log("↻ 2 秒后刷新页面以更新进度…");
      setTimeout(() => location.reload(), 2e3);
  ```
  ```js
  // :578-580  runAll 内层 catch 把错误全吃掉，只 log，然后 return undefined
  return { quotaHit };
  } catch (e) { log(`✗ ${e.message}`); }
  ```
- 为什么错：`r === undefined` 时 `!(r && r.quotaHit)` 为 `true`，于是**登录态失效、任务列表请求失败、`start-progress` 失败、被其它任务抢占、用户点了停止后又……** 全部走刷新。打开 `自动续跑` 且停在课程页时（`:1082-1089`，刷新 3s 后 `engine.runAll()`），形成 `401 → relogin 失败 → throw err.auth → catch 吞掉 → reload → autoContinue → 401 → reload`，页面每 ~5 秒自我刷新一次，日志被刷没，用户看不到任何错误原因。
- 建议：`runAll` 明确返回 `{quotaHit, ok, authFailed, fatal}`，只在「全部小节 ok 且无 failCount 且非 auth/quota」时刷新；`catch` 里用 `err.auth` 分支返回 `{authFailed:true}` 而不是吞掉；`autoContinue` 加失败次数上限（例如 sessionStorage 记 `consecutiveFailures`，≥3 就不再自动启动）。

### P0-3 `errorCode 40909` 只在 `code !== 200` 时处理；HTTP 200 + 非 0 errorCode 一律当成功
- 位置：`:448-457`
  ```js
  const [code, body] = isMedia ? await api2.req("POST", API.VIDEO, {...}) : ...;
  if (code !== 200) {
    if (body && body.errorCode === 40909) { await sleep(1e3); continue; }
    return [false, `上报失败 HTTP ${code}`];
  }
  submitted += step;
  ```
- 为什么错：这套接口的常见形态正是 **HTTP 200 + `errorCode` 非 0**。若并发冲突以 200 + 40909 返回，代码会走 `submitted += step` 并进入 30s 睡眠，**实际一秒都没入账**；下一轮 `start-progress` 的 `remainingTime` 不下降 → 两次后 `stuck>=2` → 抛 `QuotaExhausted("当日学时配额已满")`（`:437-439`）——把并发冲突误诊为配额耗尽，并且**终止整个任务队列**。同理其他 `errorCode`（非 0、非 401 系）也被当作成功。
- 建议：先统一解析 `body.errorCode`：`40909` → 退避重试（并把该轮 `i` 不计入 maxRounds）；其余非 0 → `return [false, ...]`；只有 `code === 200 && (body.errorCode === 0 || body.errorCode == null)` 才算入账。

### P0-4 `remainingTime` 完全未校验：`null` 被当「已完成」、非数字被当总量
- 位置：`:429-446`
  ```js
  const [logId, remRaw] = await startProgress(sec.id, config2.backdateS(step0), library ? 0 : 1);
  if (remRaw === null) return [true, submitted ? `完成（共 ${submitted}s）` : "已完成（无剩余时长）"];
  const rem = remRaw;
  ...
  total = rem + sec.studied;                                  // :443
  maxRounds = Math.ceil(total / Math.min(step0, API.MAX_STEP)) + config2.roundsSlack;  // :444
  const step = Math.min(step0, rem, API.MAX_STEP);             // :446
  ```
- 为什么错：
  1. `startProgress` 里 `remainingTime ?? null`（`:381`）把「接口没给这个字段」和「真的没有剩余」合并了。对 pdf/epub/外链这类不返回 `remainingTime` 的资源，`doSection` **一秒钟都没上报就 `return [true, ...]`**，于是 `runCourseInner` 记 `ok++`，最终日志打出「✅ 全部任务处理完毕」，而服务端进度纹丝不动 → 下次运行再全套重来。
  2. `rem` 若是字符串/时间串（`"01:30:00"`）或 undefined，`total`/`step` 变 `NaN`：`Math.ceil(NaN) = NaN` → `maxRounds = NaN` → `:427` 的 `if (maxRounds && ...)` 因 `NaN` falsy **永远不成立**，轮次上限静默关闭 → `for (let i = 0; ; i++)` 无界循环；同时 `lessonLocation` 发出 `"NaN"`、面板显示「已报 NaNs」。
- 建议：`startProgress` 返回 `[logId, rem]` 时区分三态（`no-remaining` / `unknown` / `number`）；调用侧 `const rem = Number(remRaw); if (!Number.isFinite(rem) || rem < 0) return [false, 'remainingTime 异常']`；`maxRounds` 计算后显式校验 `Number.isFinite(maxRounds) && maxRounds > 0`，否则退回一个硬上限（如 5000 轮）。

---

## P1 · 会造成错误结果、长时间空转或状态污染

### P1-1 关联课程（type 10）抛错后不还原 `versionId/isRegister/course`
- 位置：`:409-421`
  ```js
  const parentCourse = state2.course;
  const parentVid = state2.versionId, parentReg = state2.isRegister;
  const [done, total2] = await runCourse(sec.rid, depth + 1);
  state2.course = parentCourse; state2.versionId = parentVid; state2.isRegister = parentReg;  // 仅 happy path
  ```
- 为什么错：`runCourse` 一旦抛错（`openCourse`/`sections` 网络失败、`QuotaExhausted`），还原语句被跳过 → 父课程后续所有 `chapterProgress(...)`（`:957-958` 用 `state.versionId`）和 `sections()` 都用了**子课的 versionId/isRegister** → 查到空的/别的章节，进度判定全错，面板也一直显示子课名字（`:482` 覆盖 `state2.course`）。父课程会以错误状态一路跑到「小节全失败」。
- 建议：`try/finally` 包住 `runCourse(sec.rid, depth+1)`，还原放 `finally`。

### P1-2 library 分支把已完成小节当未完成，media 会被整段重播
- 位置：`:361-375`（`openLibraryCourse` 里每节都写死 `finish: 0`）、`:406-408`、`:974`
  ```js
  secs.push({ id: sec.id, ..., finish: 0, studied: 0 });        // :373
  ...
  if (MEDIA.has(sec.type) && playSection2) return await playSection2(sec, { courseId });  // :406-408
  const deadline = Date.now() + (media.duration || 3600) * 1e3 * 2 + 3e5;                 // :974
  ```
- 为什么错：library 路径拿不到任何进度，`todo` 里全是「未完成」；`doSection` 又先判 `MEDIA` 再看剩余时长，于是**已经刷完的 4 小时视频会被完整重播一遍**（`deadline` 甚至给到 2×时长+5min）；更糟的是 library 课的 `chapterProgress(courseId, sec.id)`（`:957`）依赖 `versionId/isRegister`，library 下两者为空/false → 恒返回 `null` → `loc` 恒 0 → `p && DONE.has(...)` 与 `loc >= dur-5` 永远不成立 → 每节必然耗到 deadline 才 `return [false, "播放超时"]`。一门多节 library 课可以白烧数小时并占满当日 24h 配额。
- 建议：library 分支也要拉真实进度（章节接口带 `source/type`，或先 `start-progress` 读 `remainingTime` 决定是否播放）；`doSection` 里把 `MEDIA` 分支挪到「先查一次进度/剩余时长」之后。

### P1-3 `findSectionItem("")` 会点击页面上任意一个最短元素
- 位置：`:1013-1017`，调用点 `:970`
  ```js
  const target = norm(name);
  const hits = Array.from(document.querySelectorAll("li, dl, a, [class*=section], [class*=chapter]"))
    .filter((el) => norm(el.textContent).includes(target) && norm(el.textContent).length <= target.length + 20);
  ```
- 为什么错：`sec.name` 来自 `sec.sectionName || sec.name || ""`（`:346`），**可能为空**。`includes("")` 恒 `true`，`length <= 20` 恒筛出一堆元素，排序后点第一个 → 在 SPA 里点击侧边栏任意链接（可能跳到别的课程/首页），而后续上报仍按 `sec.id` 进行，等于在错误页面上给另一节记学时。`target` 很短时（如「第一章」）也会误命中。
- 建议：`if (!target) return null;` 并在 `playSection` 里对空名直接返回失败；匹配用 `el.textContent.trim() === target` 优先，`includes` 只作 fallback。

### P1-4 播放循环把 auth 错误吞成 `null`，令牌失效时静默空转数小时
- 位置：`:979`
  ```js
  const p = await chapterProgress(courseId, sec.id).catch(() => null);
  ```
- 为什么错：`chapterProgress` → `api.req` 在 `err.auth = true`（`:305-307`）时抛出，被这个 `.catch(() => null)` 就地吞掉；外层 `playSection` 的 `while` 只检查 `stopFlag` 与 `deadline`，于是**令牌失效后仍会一直轮询到 deadline（最长 2×视频时长+5min）**，中途 `relogin` 也不再尝试（每次 `req` 都会重试，但如果 relogin 失败，`err.auth` 会被安静丢弃）。日志里只有「⏸ xx%」停顿，用户完全不知道已经掉线。
- 建议：`.catch((e) => { if (e && e.auth) throw e; return null; })`，让 `playSection` 把 auth 错误抛给 `runCourseInner` 的 `if (e.auth) throw e`（`:509`）。

### P1-5 `waitToken` 超时会清空**所有**等待者，导致其它请求永久挂起
- 位置：`:34-46`
  ```js
  const t = setTimeout(() => { tokenWaiters = []; reject(new Error("未捕获到令牌…")); }, ms);
  tokenWaiters.push(() => { clearTimeout(t); resolve(); });
  ```
- 为什么错：超时回调把共享数组整个换成新数组，**别的并发 `waitToken()` 注册的 resolve 被丢弃**，那些 Promise 既不 resolve 也不 reject → 对应 `req` 永久 pending，整个引擎在某次 `await` 上静默停住（面板显示「轮 N」不动，无任何报错）。慢网络/冷启动时多个 `req` 并发（`playSection` 轮询与主循环同时发）就会触发。
- 建议：用 `Set`/索引删除只清自己那条；或超时后 `reject` 所有 waiter（各自 reject 而不是丢弃）。

### P1-6 令牌钩子挂在 `globalThis` 上，TM 沙箱下可能钩不到页面请求；跨脚本锁也可能不共享
- 位置：`:63-89`（`installHooks` 默认 `win = globalThis`）、`:1054` `hunter.installHooks({})`、`:593-608`（`win.__MOOC_US_LOCK`）
- 为什么错：脚本声明了 `@grant GM_getValue/GM_setValue/...`，Tampermonkey 会启用沙箱；沙箱里的 `globalThis.XMLHttpRequest`/`window` 未必是被页面使用的那个对象（需要 `unsafeWindow`）。钩子若打在沙箱对象上则**形同不存在**，只能靠 `localStorage.token`（`:49-61`）——而 `localStorage` 在沙箱里通常可用，所以「有时能跑、有时 30s 后报未捕获令牌」。同理 `window.__MOOC_US_LOCK` 与 `window.__MOOC_US_DEBUG__` 若写在沙箱窗口上，**快速版与无人值守版的同页互斥锁根本看不到彼此**（`:596-601`）。README 明确把这条锁列为互斥保障。
- 建议：加 `@grant unsafeWindow`，`installHooks({ win: unsafeWindow, XMLHttpRequest: unsafeWindow.XMLHttpRequest, fetch: unsafeWindow.fetch })`，锁与 DEBUG 也挂 `unsafeWindow`；并在启动时做一次自检（钩子是否真的拦到了请求）并写日志。

### P1-7 「真实节奏」的时间基准与实际流逝脱钩：只睡眠、不测量
- 位置：`:460` `await sleep(config2.roundSleepMs(step));`、`:924` `roundSleepMs: (step) => step * 1e3`、`:429` `startProgress(sec.id, config2.backdateS(step0), ...)`
- 为什么错：
  1. 每轮真实耗时 = `start-progress` RTT + `video/doc-progress` RTT + `progressUpdate` RTT + 30s 睡眠，**恒大于 30s**（实测每次 3 个请求，按 200~600ms 算，4 小时课累积 3~8 分钟偏差）。文档宣称「学时和真实时间 1:1」「每轮上报秒数 == 真实流逝秒数」，实际是 1:1.02 左右。
  2. 反向问题更要紧：后台标签页节流 / 系统睡眠时 `setTimeout(30s)` 可能 60s+ 才返回，此时**真实流逝 60s 却只报 30s**（安全方向），但 `stuck` 配额判定（`:437-439`）与「连续两轮不下降」的时间语义完全失去意义——被节流时两轮之间可能过了 2 分钟，判「配额已满」的推理不成立。
  3. 没有任何 `Date.now()` 基准校正：暂停、断网重连、`await` 抛错重入都不会重设基准。
- 建议：记录 `roundStart = performance.now()`，睡眠改成 `sleep(Math.max(0, roundStart + step*1000 - performance.now()))`（把 RTT 计入本轮）；`createTime` 反推用**上一轮实际提交时刻**而不是 `Date.now()`；给 `stuck` 判定加「两轮间隔 ≥ 阈值」的前置条件。

### P1-8 面板被 `remove()` 之后永久无法再挂载
- 位置：`:1068-1077`（hashchange 里 `panel.getBox().remove()`）、`:751-752`（`if (box) return;`）、`:828`
  ```js
  } else if (panel.getBox()) { panel.getBox().remove(); }     // :1075
  ```
- 为什么错：`remove()` 只摘 DOM，闭包里的 `box` 仍非空 → 回到非登录页时 `if (!panel.getBox()) panel.mount()`（`:1073`）判定为「已挂载」不再重挂；油猴菜单「显示/隐藏面板」（`:1092-1098`）也只是改这个游离节点的 `style.display`。**进了登录页再回来，面板就永久消失**，只能刷新整页。
- 建议：`remove()` 后把 `box/logEl/statusEl/btnStart` 一并置 `null`（提供一个 `unmount()`），或 `mount()` 里用 `box.isConnected` 判断。

### P1-9 POST 重试不幂等
- 位置：`:295-304`
  ```js
  if (authError && !retried) { ... return req(method, path, { params, data }, true); }
  ```
- 为什么错：`doc-progress` / `video-progress` / `course-progress-update` 都是写操作。若首个请求其实**已被服务端接受**但响应是 401（令牌恰好过期，或中间层改写状态码），重试会在日志年龄已消耗的情况下二次入账 / 触发 40909。`start-progress` 尤其危险：重试会新建一条学习日志。
- 建议：只对幂等 GET（TASKS/CHAPTERS/INFO）自动重试；写操作重试前先 `start-progress` 校验 `remainingTime`，或干脆不重试、把 `err.auth` 抛给上层统一处理。

### P1-10 `reqWakeLock` 连调两次 + release 监听把新锁置空
- 位置：`:935-946`、`:972-973`、`:1039`
  ```js
  wakeLock = await navigator.wakeLock.request("screen");
  wakeLock.addEventListener("release", () => { wakeLock = null; });
  ...
  reqWakeLock(); reqWakeLock();      // :972-973 连发两次
  ```
- 为什么错：两次请求产生两个 screen 锁，第二个覆盖变量，第一个变孤儿；任一释放都会把 `wakeLock` 置 `null`（哪怕另一个仍在生效）→ 状态判断失真。另外 `visibilitychange` 只在 `visible` 时补锁，锁被系统释放（电量策略）而页面一直 visible 时不会重试。
- 建议：`if (wakeLock || requesting) return;` 加单飞守卫；`release` 回调里判断 `e.target === wakeLock` 再置空；删掉 `:972-973` 的重复调用；在 `release` 时若 `state.running` 立即重请求。

### P1-11 画质设置打错了控件（`.vjs-subs-caps-button` 是字幕按钮）
- 位置：`:862-873`
  ```js
  const box = document.querySelector(".vjs-subs-caps-button");
  const cur = ((box.querySelector(".vjs-control-text") || {}).textContent || "").trim();
  if (!cur || cur === quality) return;
  const item = [...box.querySelectorAll(".vjs-menu-item")].find((el) => el.textContent.trim() === quality);
  item.click();
  ```
- 为什么错：`.vjs-subs-caps-button` 是 **Captions/字幕** 按钮，其菜单项是字幕轨（「关闭/中文」），不会有「普清」；`cur` 是字幕文案（如「Captions」）永远不等于「普清」→ 每 3s 进一次菜单查找、`qualityTried` 记 2 次后放弃。功能实际是**静默无效**（文档声称「画质切到普清」）；最坏情况是点中同名字幕项把字幕打开。另外 `video` 取的是 `querySelectorAll("video")` 循环的**最后一个**元素，与播放器未必是同一个。
- 建议：换成实际的清晰度控件（video.js 常见 `.vjs-quality-selector`/`.vjs-resolutions-button`，或按 `[class*=quality]` 探测），并只对 `document.querySelector("video")`（第一个/正在播放的）操作；日志里区分「已切换/未找到控件」。

### P1-12 12 秒定时器对**所有** video 强制执行 `play()`
- 位置：`:1056-1065`
  ```js
  setInterval(() => { if (!state.running) return;
    const v = document.querySelector("video"); humanPointer(v || document.body);
    document.querySelectorAll("video").forEach((x) => { if (x.paused && !x.ended) x.play().catch(() => {}); });
  }, 12e3);
  ```
- 为什么错：只要脚本在跑，页面上任何被用户手动暂停的视频都会被强播（包括首页推荐位、广告位、别的课程预览）；`play()` 触发声音/流量，且用户的暂停意图被反复推翻。另外 `humanPointer` 无 `isTrusted`，且 `pointermove` 用 `MouseEvent` 构造（`:832-845`），发出的事件缺 `pointerType/pointerId`，若播放器监听 PointerEvent 会读到 `undefined`。
- 建议：只在 `state.section` 活跃（即 `playSection` 正在跑）时启用；只作用于当前播放器元素（缓存引用）；`pointermove` 用 `new PointerEvent('pointermove', {...})`。

---

## P2 · 健壮性 / 安全 / 可维护性

1. **HTTP 200 但非 JSON 响应体被当成 `null`**：`:283-291` 只在 `trimStart().startsWith("{")||"["` 时解析；带 BOM、`text/html` 登录跳转页、`jsonp(` 前缀都变 `body = null` → `undoneTasks` 抛「任务列表请求失败 (HTTP 200)」（`:325`），错误信息误导。建议 `try { body = JSON.parse(text) } catch {}` 直接试，并对 `content-type` 记录日志。
2. **无超时、无重试、无退避**：`doFetch`（`:277-293`）没有 `AbortController`，一个挂死的请求会永久阻塞整轮；`undoneTasks`/`openCourse` 任一瞬时失败即终止整次运行（`:324-326`, `:354-359`）。建议 `signal: AbortSignal.timeout(20000)` + 2 次指数退避。
3. **`relogin` 并发无单飞**：`:239-275` 无 in-flight 去重；多个 `req` 同时 401 会并发调用 `app-login`，而平台 `enableUnique=1` 下每次登录都会**把上一个会话顶下线** → 拿到的 token 互相作废 → 401 风暴。建议用一个共享 `reloginPromise`。
4. **`AUTH_CODES = {90901, 90902}` 与已知契约冲突**：`:235` 把这两个 errorCode 当令牌失效，但同项目 Python 实测结论是「**HTTP 401 才代表 token 失效，errorCode 可能为 0**」。若这两个码实为服务端错误，会触发无谓重登（叠加第 3 条 = 顶号循环）。建议：以 401 为主判据，`9090x` 降级为「重试一次、不重登」并打日志观察。
5. **`setToken` 把 token 末 8 位写进面板 DOM 与 console**：`:29` `log(`令牌已捕获 (${v.slice(-8)})`)`，而面板日志是页面 DOM（`:668-671`），任何页面脚本可读；`:674` `console.log` 把所有运行细节打到页面上下文，也是一种明显的**自动化指纹**。建议：只输出 `v.length` 或 `v.slice(-4)`，并给 console 输出加开关（默认关）。
6. **账密明文存 GM + 明文 `prompt`**：`:1113-1119`（`gm.setValue("account", { username: u, password: p })`）。GM 存储（尤其 Violentmonkey）就是扩展侧明文/可读存储，`prompt` 也不遮显。建议：至少二次确认 + 支持「只存 token 不存密码」，并在面板提示明文存储风险。
7. **`window.__MOOC_US_DEBUG__` 把运行控制权交给页面上下文**：`:1078-1080` 暴露 `state`、`runAll()`、`runCourse(id)`、`log`。任何被注入的页面脚本（广告、第三方 SDK）都能无授权启动刷课、读取当前课程/小节名、读取日志。建议：仅在 `gm.getValue("debug")` 时挂载，或用 `unsafeWindow` + 一次性 nonce。
8. **`settleNested` 的 300s 回填与「真实节奏」自相矛盾**：`:390` `startProgress(sectionId, 300, 1)`，紧接着 `:392` 直接 `doc-progress lessonLocation:999`（无 `studyTime`），属于「凭空把日志年龄推到 5 分钟前」，正是 README 里描述快速模式手法的简化版；且 `clientType` 与主循环不一致（`:429` 用 `library ? 0 : 1`）。建议：改成与主循环一致的 30s 回填 + 至少一次真实 `studyTime`，或明确写注释说明这是结算探测而非计时。
9. **`DONE = {2,4}` 语义混用**：`:111-112` 同时用于任务 `t.finishStatus`（`:333`）、小节 `p.finishStatus`（`:347`）、`doc-progress` 返回（`:393`/`:398`）。`4` 也出现在 `SKIP`（scorm 类型）里，容易误读；若 `4` 实为「未通过/待复核」，会把未完成任务整门跳过。建议拆成 `SECTION_DONE` / `TASK_DONE` 两个具名常量并附枚举注释。
10. **`undoneTasks` 分页提前退出**：`:330` `if (!items.length || items.length < 500 || all.length >= (body.total || 0)) break;` —— `body.total` 缺失时按 `0` 处理，第一页就 break，只拿到 500 条；`[1,2].includes(t.status) && [1,2].includes(t.businessType)`（`:333`）是无注释魔数，且 `t.businessId` 未做存在性校验（`openCourse(undefined)` 会以 `courseId=""` 发请求）。
11. **`openCourse` 的成功判定太宽**：`:355-356` `typeof det !== "object"` 不排除 `{errorCode:40909}` 这类 200 错误体；随后 `det.versionId` 为 `undefined` → `sections(courseId,"",false)` 返回空 → 日志「章节列表为空」→ 计一次失败 → 触发 P0-2 的刷新。建议校验 `det.id/versionId` 或 `det.errorCode === 0`。
12. **`openLibraryCourse` 静默吞错**：`:362` `registerStudy` 的返回码完全没看；`map[ft] ?? 0` 把未知 fileType 映射成 `0`，而 `0` 既不在 `SKIP` 也不在 `MEDIA`/`NESTED` → 走通用 `doc-progress lessonLocation:999` 盲报（`:448`），可能给不支持的类型硬记进度。建议 `0` 进 `SKIP` 并在日志里列出未知类型。
13. **`progressUpdate` 失败会中断整个小节**：`:458` `if (courseId) await progressUpdate(courseId);` 无 try/catch，一次失败即从 `doSection` 抛出、被 `:504-511` 记一行 ✗ 后丢弃该小节**剩余的所有轮次**。建议单独 try/catch，失败只记日志。
14. **`createSessionGuard` 用墙钟算 TTL**：`:635`/`:641` `now() - cur.ts < ttlMs`，系统时间回拨会让 `差值为负` → 锁永不过期（`held` 恒 true，永远提示「另一标签页正在运行」）；且 `hold` 是「读-判-写」，跨标签页非原子（GM 无 CAS）。建议用 `performance.now()` + 单调序，或写入 `Date.now()` 同时做 `Math.abs(delta) > ttl` 判定。
15. **定时器/监听器从不清理**：`:825`（面板 2s tick）、`:875`（播放器偏好 3s）、`:1051`（心跳 15s）、`:1056`（12s）、`:736-737`（拖拽 `mousemove/mouseup` 挂在 `document` 且**只在 mouseup 时移除**——鼠标在窗口外松开就永久泄漏，之后不按键移动也会拖动面板并不断 `gm.setValue("pos")`）。建议统一登记句柄，`unmount`/停止时清理，拖拽补 `pointercancel`/`blur`/`mouseleave` 兜底。
16. **`headerColor` 每 2 秒一次强制样式计算**：`:681-702` 遍历 `[top, ...top.querySelectorAll("*")]` 逐个 `getComputedStyle`，配合 `:825` 的 2s tick，在重型页面上是持续的主线程开销（且注释含义上它其实是「取顶栏颜色」，与 `.um-head`——脚本自己的头——同名，`:755`/`:798` 会把自己的/对方脚本的头当成站点顶栏，两个脚本同开时互相堆叠错位）。
17. **`setCollapsed`/`mount` 未做 `document.documentElement` 存在性保护**：`boot()`（`:1068-1081`）整体无 try/catch，`@run-at document-start` 下任一步抛错（`documentElement` 为空、`prompt` 被拦、`GM_registerMenuCommand` 不可用）都会**静默终止整个脚本**，包括菜单注册。建议 `boot` 包 try/catch 并在失败时至少 `console.error`，面板挂载延到 `DOMContentLoaded`。
18. **`undoneTasks` 与 `playSection` 没有 `stopFlag` 检查**：`:320-333`（10 页 × 500 条串行请求，无中断点）、`:974` 的 deadline 最长 2×时长。点了停止后可能要几十秒才真正停下，`onStart` 的「正在停止(等当前轮结束)」文案与实际体验不符。
19. **`relogin` 成功后不写回 `localStorage.token`**：`:273` 只更新内存 token。刷新页面（P0-2 的 reload）后内存 token 丢失，又退回「必须在页面上手动触发一次带 Authorization 的请求」的路径，形成「重登成功 → 刷新 → 无令牌 → 30s 超时」的循环。建议 `setToken` 时同步把 `{token_type, access_token}` 写回 `localStorage.token`。
20. **`@version 0.0.1` / 无 `@updateURL`**：发布在 GreasyFork/ScriptCat，但没有 `@updateURL`/`@downloadURL`，商店渠道之外的「复制源码粘贴」用户永远收不到修复更新（考虑到上面几个 P0，这点实际影响不小）。

---

## 无法单测的核心逻辑

`window.__MOOC_US_DEBUG__`（`:1078-1080`）只导出：

```js
{ realtime: { state, runCourse: (id) => engine.runCourse(id), runAll: () => engine.runAll(),
              currentBidFromHash: () => currentBid(), log: panel.log } }
```

即：运行状态对象、两个**必须打真网络**的入口、一个 hash 解析包装（不是纯函数本身，传参不可控）、一个 logger。除此之外全部封死在 IIFE 里，且文件底部有大量**导入即副作用**（`boot()`、`autoContinue()`、4 个 `setInterval`、5 个 `GM_registerMenuCommand`、`hunter.installHooks`），无法 `require`/`import` 做隔离测试。

不可单测（或只能靠真实网络 + 真实页面黑盒驱动）的关键逻辑：

1. **`doSection` 的轮次状态机**（`:424-461`）：`maxRounds` 推导、`stuck` 配额判定、`rem<=0` / `remRaw===null` 的完成判定、`step` 钳位、`40909` 重试。这是全脚本最容易出错、也最该有表驱动测试的一段，目前只能靠跑真实账号。
2. **`min(total, total - rem + step)` 的 `lessonLocation` 累计公式**（`:448`）：一旦 `total` 快照与 `sec.studied` 语义不一致就整段偏移。
3. **`req` 的 401/errorCode/重试状态机**（`:277-310`）：`retried` 只允许一次、`tokenFromStorage` 的「是否更新」判定、`err.auth` 传播，全部依赖真实 401。
4. **`createSessionGuard` 的 TTL/抢锁语义**（`:611-648`）：本是纯逻辑（`gm` 与 `now` 都可注入，构造参数已经留了口子），却没有任何测试能触达。
5. **`createLock`**（`:593-608`）：同上，`kind`/前缀判定完全可以测。
6. **`createEngine` 的其它导出**（`:589` 返回了 `undoneTasks/sections/openCourse/startProgress/settleNested`，但 `engine` 本身没进 DEBUG）：任务过滤规则（`:333`）、章节扁平化与 `finish/studied` 映射（`:335-352`）、`openCourse` → `openLibraryCourse` 的降级链、fileType 映射表（`:367`）全不可测。
7. **`currentBidFromHash` / `isStudyPage` / `isAuthPage` 三个正则**（`:879-891`）：纯函数，最省力的测试目标，但目前只暴露了一个零参包装（读 `location.hash`）。
8. **`encField`/`encryptBlock`/`fingerprintFor`**（`:170-232`）：确定性纯函数，本可用已知向量校验（AES-128-ECB + PKCS7、FNV-1a 设备映射），现在完全没有回归保护——一旦有人「优化」S 盒或 ShiftRows，只有线上登录失败才会发现。
9. **`playSection` 的完成判定与唤醒策略**（`:965-1011`）、**`findSectionItem` 的匹配排序**（`:1013-1017`，纯 DOM 逻辑，可用 jsdom 测）。
10. **`humanPointer` / `startPlayerPrefs`**（`:832-875`）：`humanPointer` 已经接受 `{doc, MouseEventCtor}` 注入口，说明作者本意是可测，但没有导出。

**建议**（不改代码，仅评审意见）：把 `createTokenHunter/createApi/createEngine/createLock/createSessionGuard/humanPointer/currentBidFromHash` 在 `__MOOC_US_DEBUG__` 下一并挂出（或加一个 `?debug` 分支），并把 `boot()`/定时器/菜单注册挪进显式的 `main()`，由 `if (!globalThis.__MOOC_US_TEST__)` 守卫，这样纯逻辑就能在 node/jsdom 下跑。

---

## 文档不一致清单

| # | 文档说法 | 代码实际 | 位置 |
|---|---|---|---|
| 1 | README「两个脚本用同一把会话锁，同页互斥、**跨标签页 45 秒防多开**，同时启用会直接拒启动」 | 跨标签页防多开因 owner 恒为 `"realtime"` 而失效；且 `window.__MOOC_US_LOCK` 在 TM 沙箱下未必与另一脚本共享 | `:932`, `:1035`, `:633-641`, `:593-608` |
| 2 | 附加说明「脚本**不收集、不保存账号密码，也不代你登录**」 | 提供「保存账号密码」菜单（明文存 GM），并有 `relogin()` 用账密复现 App 登录 | `:1113-1119`, `:239-275` |
| 3 | 同上（与 README 主文档自相矛盾）：README 说「顺手点一次保存账号密码，令牌 30 天过期后能自动重登」 | 两份发布文档对同一功能描述相反，附加说明已过期 | README「安装」段 vs 附加说明「怎么用」段 |
| 4 | 附加说明 FAQ「报 401 … 没有新鲜令牌就**停下**」「登录态失效时它会停下报错」 | 实际会 `location.reload()`，并可能进入刷新循环（P0-2） | `:1041-1045`, `:579-580` |
| 5 | README「全部处理完（**且不是配额耗尽**）会在 2 秒后自动刷新」 | 除配额耗尽外，**失败、401、被抢占、任务列表为空**也会刷新 | `:1042` |
| 6 | README 表格「轮间等待 30s（真实流逝）」/ 附加说明「轮与轮之间真的等满 30 秒」 | 睡眠 30s 之外还有 3 个串行 HTTP 往返，实际 >30s（1:1 不成立） | `:448-460` |
| 7 | README「无人值守：`createTime` 回填 30s（等于上报秒数）」/ 附加说明「压根不多要」 | `settleNested` 用 **300s** 回填并立即以 `lessonLocation:999` 结算 | `:386-398` |
| 8 | 附加说明「播放器设置：自动静音、音量归零、**画质切到「普清」**」 | 选择器 `.vjs-subs-caps-button` 是字幕按钮，画质实际未被切换 | `:862-873` |
| 9 | README「已完成的（`finishStatus ∈ {2,4}`）直接略过」 | 仅对章节接口路径成立；library 路径所有小节 `finish: 0`，已完成课会被重播 | `:373`, `:484` |
| 10 | 附加说明「跳过不是失败：日志会写「跳过」，整门课其他小节照常推进」 | `type 0`（未知 fileType 映射结果）既不跳过也不属于任何分支，会走盲报 | `:367-372`, `:401-448` |
| 11 | README「每 12s 向播放器补一次随机鼠标移动」 | 同一 tick 还会对所有 `<video>` 强制 `play()`，文档未提 | `:1056-1065` |
| 12 | 附加说明「页面长时间挂着会保活」 | `wakeLock` 释放后不自动续、连调两次导致句柄错乱 | `:935-946`, `:972-973` |
| 13 | 接口清单里没有 `registerStudy` / `info`（library 课路径） | 代码使用 `/course-front/registerStudy` 与 `/course-front/info/<id>` | `:104-106`, `:361-365` |
| 14 | README「`errorCode ∈ {90901,90902}` 视为令牌失效」 | 与同项目 Python 实测契约「HTTP 401 才算失效」冲突（见 P2-4） | `:235`, `:295` |

---

**优先级建议**：先修 P0-1 / P0-2 / P0-3（三者叠加会放大彼此：多标签页 → 40909 → 误判配额/null → 刷新循环），再修 P1-1 / P1-2（状态污染 + 数小时空转），其余按 P2 顺序清理定时器与日志暴露面。
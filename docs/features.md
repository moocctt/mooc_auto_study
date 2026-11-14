# 功能契约：三分支对齐矩阵

三个分支（`main` = agent skill、`cli` = python CLI/TUI、`web` = TypeScript 应用）对齐同一核心功能集。
本文件是**契约**：任何分支新增/修改功能，必须同步更新本矩阵与对应测试。

## 统一语义（三分支必须一致）

| 语义 | 契约值 | 说明 |
| --- | --- | --- |
| 小节/课程完成态 `finishStatus` | **0 未学 / 1 学习中 / 2 复习(已完成) / 4 完成** | 完成态集合 = **{2, 4}**；不存在 3 |
| 任务 `status` | **1 未开始 / 2 进行中 / 3 已完成** | "复习"只是 3 的 UI 表现 |
| 过期判定 | 独立字段 `expired`（布尔） | 与 status 无关；过期任务不进自动目标 |
| 完成态写入 | 服务端**异步结算**（实测 2–18 分钟） | 客户端请求无法触发；未汇总 ≠ 失败 |
| 认证头 | `Authorization: Bearer__<token>`（双下划线） | "Bearer "（空格）会 401 |
| 登录端归属 | 账密 `app-login`=APP 端 / 扫码=`qr-wechat`/`qr-app` 网页端 | 平台按端单会话，同端互顶 |
| 登录 key | APP 扫码轮询的 `key` 任意非空值即可 | 实测 2026-11-04；缺失/空 → 422 |
| 当日额度 | `min(工作档位当日容量 − 当日已学, 网络自学缺口)` | 当日已学 = `max(last − base, extra)`，账本 `data/today_used.json`，跨日归零 |
| 额度停止条件 | 本次实际提交秒数（`sent` 累计）达到缺口，且在小节内部也会截断（`partial`） | 平台 `hourSelf` 只做事后校正：结算滞后 2–18 分钟，且按「小节完成」结算（实测提交 60s → +2.2h） |
| 单日上限 | 平台累计 24 小时 | remainingTime 连续 2 轮不降 = 配额满 |
| 任务的"复习" | status=3 的 UI 表现 | 不是独立状态值 |
| 扫码 widget | 单文件 HTML（`templates/qr-widget.html`），二维码内联 base64 PNG，**不含 JS** | 带 JS 需沙箱渲染，等到渲染完码已过期 |
| 扫码等待/换码 | `--wait` 240 / `--ttl` 55 | 到点自动换新码，再输出一行 `{"event":"qr",...}` |

### 退出码（`mooc_study.py`）

| 码 | 含义 | 触发 |
| --- | --- | --- |
| 0 | 成功 | 含「今天不用再学」「已达标」，同样带 `RESULT|ok=true` |
| 1 | 目标未达成 / 运行出错 | 有课未学完、上报失败 |
| 2 | 会话失效 | `AuthExpired`（401）或 `--course` 名称匹配不到 |
| 3 | 当日配额已满 | `QuotaExhausted`，今日不要再跑 |

## 功能矩阵

| # | 功能 | main (skill) | cli | web |
| --- | --- | --- | --- | --- |
| F1 | 登录：微信扫码（**首选**，扫到即换票落盘） | ✅ `mooc_api.py qr wechat` | ✅ qr_login | ⚠️ login.ts |
| F1 | 登录：APP 扫码通道 | ✅ `mooc_api.py qr app`（或 `qr both`） | ✅ qr_login | ⚠️ login.ts |
| F1 | 扫码 widget 展示（内联 base64 PNG、无 JS） | ✅ `widget_html` / `show_widget`（`templates/qr-widget.html`） | ❌ | ⚠️ 前端画码 |
| F1 | 二维码兜底（终端 ASCII / 只要 PNG / 浏览器打开） | ✅ `--ascii` / `--no-widget` / `--open` | ❌ | ❌ |
| F1 | 扫码等待与自动换码 | ✅ `--wait 240` / `--ttl 55` / `--interval` | ❌ | ❌ |
| F1 | 登录卡片（二维码 + 账号 + 下一步） | ✅ `mooc_api.py card`（`templates/login-widget.html`） | ❌ | ❌ |
| F1 | 登录：账密（免验证码、30 天） | ✅ `login-pwd`（兜底，会顶掉手机端） | ✅ app-login | ✅ login.ts |
| F1 | 登录态探活（不做自动续期/重登） | ✅ status（`probe_ok`；失效只报 `AuthExpired`） | ✅ fresh_token | ⚠️ |
| F1 | 端归属记录与提示 | ✅ token_source | ✅ | ⚠️ |
| F2 | 学时账本（两组 + 互抵提醒） | ✅ summary | ✅ hours_self | ⚠️ |
| F3 | 任务列表与分类（四态） | ✅ sync+plan | ✅ list/classify | ✅ |
| F4 | 学习：指定课程（名称/ID/URL） | ✅ --course | ✅ --course | ⚠️ study.ts |
| F4 | 学习：按学时缺口选课 | ✅ --hours | ✅ --hours | ✅ runHours |
| F4 | 学习：全部未完成/未开始 | ✅ --todo | ✅ --todo | ✅ runTodo |
| F4 | 学习：今日额度 | ✅ --today + 记账 | ✅ --today + 记账 | ❌（规划：页面只读，学习仍走 CLI） |
| F4 | dry-run 体检 | ✅ | ✅ | ⚠️ |
| F4 | 音轨模式（mp3） | ❌ 刻意不做 | ✅ --mode | ❌ |
| F5 | 完成态等待复核（只读轮询） | ✅ wait_finish | ✅ | ⚠️ |
| F5 | 回退小节补 settle | ✅ | ✅ | ❌ |
| F5 | 汇总三态 ✅/⏳/⚠️ | ✅ | ✅ | ✅（按分支聚合） |
| F6 | 过期任务排除 | ✅ | ✅ | ✅ |
| F7 | 当日额度本地记账 | ✅ today_used.json（`date/base/last/extra`，used = max(last−base, extra)；旧 `used` 账本自动迁移；`base` 用 `hourSelf − 平台今日已记` 反推，平台读不到就按本地估算） | ✅ 同左 | ✅ 同左 |
| F8 | dry-run / RESULT 机器行 | ✅ | ✅ | ✅ HTTP API |
| F9 | 心跳 WS（防掉线判定） | ❌ 刻意不做 | ✅ Heartbeat | ✅ ws.ts |
| F10 | 日历 ICS 导出（必修+脱敏+提醒） | ✅ report --format ics | ✅ --ics <文件> | ✅ /api/calendar.ics（会话内生成） |
| F10 | 日历订阅发布（GitHub Pages 多用户） | ✅ publish_calendar.sh | ❌（订阅用 main/cli 的产物） | ⚠️ 需外部托管地址 |
| F11 | 年度报告 | ✅ mooc_annual | ❌ | ❌ |
| F11 | 线下培训明细 | ✅ mooc_training | ❌ | ❌ |
| F12 | 多账号隔离 | ✅ | ⚠️ | ⚠️ |
| F14 | 平台课程库搜索（发现非任务课程） | ✅ --search（`type=0` 课程/`type=2` 专题，`publishClient=1` 必填，**翻页取全**；实测「消防」48 门） | ✅ --search | ✅ `/api/search?q=` + 前端「搜索」页（结果一键学习） |
| F14' | 课程库课程按 ID 直接学习 | ✅ `registerStudy`(type=1,isRequired=0) → `course-front/info/<id>` 取章节 → `start-progress(clientType=0)` + **全字段 AES `video-progress`**（随机 singleMark）；实测 16 门消防课学完；文档类小节同样走加密上报（逆向 commitDocProgress） | ✅ 同左 | ✅ `openLibraryCourse` + 自动回退 + `commitDocEnc`（AES 上报） |
| F13 | CORS 代理（浏览器调平台 API） | ❌ 不需要 | ❌ | ✅ cors-proxy.mjs |

图例：✅ 完整 / ⚠️ 部分（见行内说明）/ ❌ 未实现（"待开发"= 本契约要求补齐）

## 当前状态（main 分支）

main 的测试在 `tests/`：`test_mooc_api.py`（加密 / 二维码 / widget）、
`test_study_ledger.py`（今日额度账本）、`test_tobacco.py`（任务库 / 优先级 / 排期）、
`test_study_flow.py`（假平台联调：分档降级、40909 重试、401 穿透、小节课内额度、嵌套课额度）、
`test_live_contracts.py`（真实接口契约：`versionId`、`studyTotalTime` 不可用、去重口径）。
上表 ⚠️ 项为「部分实现」：不影响对齐语义，仅功能面较小。

## 测试门槛

| 分支 | 框架 | 命令 | 门槛 |
| --- | --- | --- | --- |
| main / cli | pytest | `python -m pytest tests -q` | 全绿；核心模块行覆盖不下降 |
| web | node --test | `npm test` | 全绿；对齐语义用例必须存在 |


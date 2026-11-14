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
| 当日额度 | `min(工作档位当日容量 − 当日已学, 网络自学缺口)` | 当日已学本地记账（跨日归零） |
| 单日上限 | 平台累计 24 小时 | remainingTime 连续 2 轮不降 = 配额满 |
| 任务的"复习" | status=3 的 UI 表现 | 不是独立状态值 |

## 功能矩阵

| # | 功能 | main (skill) | cli | web |
| --- | --- | --- | --- | --- |
| F1 | 登录：账密（免验证码、30 天） | ✅ login-password | ✅ app-login | ✅ login.ts |
| F1 | 登录：微信 / APP 扫码（双通道） | ✅ dual_login | ✅ qr_login | ⚠️ login.ts |
| F1 | 登录态探活 / 自动续期 | ✅ status | ✅ fresh_token | ⚠️ |
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
| F7 | 当日额度本地记账 | ✅ today_used.json（**hourSelf 基准**：last−base，旧 used 自动迁移） | ✅ 同左 | ✅ 同左 |
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

## 终态（2026-11-05 对齐完成后）

三分支全量测试：main 89 passed（mooc_study.py 覆盖 100%）、cli 156 passed
（mooc_api_login/client/tasks 100%、mooc_auto_study 83%）、web 136 passed。
上表 ⚠️ 项为「部分实现」：不影响对齐语义，仅功能面较小。

## 测试门槛

| 分支 | 框架 | 命令 | 门槛 |
| --- | --- | --- | --- |
| main / cli | pytest | `python -m pytest tests -q` | 全绿；核心模块行覆盖不下降 |
| web | node --test | `npm test` | 全绿；对齐语义用例必须存在 |


---
name: tobacco-mooc-study
display_name: 烟草网络学院学习助手
display_name_en: Tobacco MOOC Learning Assistant
description: 中国烟草网络学院（mooc.ctt.cn）学习任务管理。当用户需要登录烟草网络学院（扫码优先，扫码不成再用账号密码）、查看学习与班级任务、核对学时与截止日期、按在职工作状态生成学习计划、跟踪学习进度或导出任务清单时使用。先判断凭据是否有效，必修与临期任务优先，支持按目标自动完成学习任务（仅本人账号、用户显式要求时，风险见硬性边界），考试与作业必须本人完成。
description_zh: 自动判断登录态（扫码优先、账密兜底），采集学习任务与学时，按在职工作状态排期；可在用户明确要求时按目标（指定课程/学时缺口/全部未完成）自动完成学习任务。
description_en: Check saved credentials, log in by QR first (account/password fallback), fetch MOOC tasks and study hours, then build a work-aware study plan that prioritizes required and soon-due tasks.
examples_zh:
  - "登录烟草网络学院，看看我还有哪些学习任务"
  - "我在职坐班，工作日要上班，帮我按必修和临期优先排这周的学习计划"
  - "导出学习任务清单和学时完成情况"
  - "生成2026年的年度学习报告"
examples_en:
  - "Log in to the tobacco MOOC and list my pending learning tasks"
  - "I work office hours on weekdays; plan my study with required and soon-due tasks first"
  - "Export my task list and study-hour progress"
version: 0.1.0
author: "moocctt"
---

# 烟草网络学院自动学习

## 硬性边界

只用于**本人账号**。不进他人账号、不批量跑号、不代考：考试与作业必须本人完成。

## 快速开始

```bash
pip install -r requirements.txt
python scripts/mooc_tasks.py status --json    # 第一道门禁：判断凭据是否有效
python scripts/mooc_study.py --list           # 任务清单与学时缺口
```

仓库没有 `.env` 文件，也不需要：凭据走扫码或 `login-pwd` 落盘的加密会话。两个可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `MOOC_TOKEN` | 直接给 access_token，优先级高于本地会话文件 |
| `TOBACCO_HOME` | 数据目录，默认仓库下 `data/`（会话、任务库、今日额度账本都在这里） |

## 登录：扫码优先

首选微信扫码。取码即发 widget，扫到就换票并写入本地会话，一条命令到底：

```bash
python scripts/mooc_api.py qr wechat          # 默认 --wait 240
```

- 输出一行 JSON，其中 `widget_html` 是可直接交给宿主 `show_widget` 的 HTML 文件路径（等同 `show_widget.widget_code_file`）。模板 `templates/qr-widget.html`，内联 base64 PNG、无 JS，秒渲染。
- 单张码 55 秒过期，脚本自动换新码并再输出一行 `{"event":"qr",...}`；把新的 widget 再发一次即可。
- 无 widget 能力时的兜底：`--ascii`（终端直接打印二维码）、`--no-widget`（只要 PNG）、`--open`（浏览器打开单文件 HTML）。

次选学院 APP 扫码通道：

```bash
python scripts/mooc_api.py qr app
```

登录卡片（已有账号、或需要一张说明页时）：`python scripts/mooc_api.py card --account <手机号>`，输出 `data/login-card.html`（模板 `templates/login-widget.html`）。

最后才用账密（APP 通道，token 30 天，会顶掉手机端登录，所以不首选）：

```bash
python scripts/mooc_tasks.py login-pwd --username <手机号> --pwd-stdin
```

密码从标准输入读，不要写进命令行（`--pwd` 只用于本机调试）。

## 常用命令（scripts/mooc_study.py）

| 参数 | 作用 |
| --- | --- |
| `--list` | 任务清单与学时缺口 |
| `--today` | 只学今天该学的量（工作档位容量与缺口取小，同日不重复给额度） |
| `--hours N` | 再刷够 N 学时（自动选课） |
| `--todo` | 完成全部未完成任务 |
| `--course <id/名称>` | 学完指定课程/专题，可重复，支持模糊匹配 |
| `--search <关键词>` | 搜平台课程库（配合 `--course <id>`） |
| `--logs [N]` | 最近 N 天学习记录，默认 7 |
| `--dry-run` | 只体检不上报 |
| `--chunk N` | 单次上报秒数，默认 600 |
| `--wait-sync N` | 学完后轮询平台完成态的秒数 |
| `--json` | 附加机器可读输出（`RESULT|ok=..|mode=..` 行始终打印） |

`--ics` 不属于本脚本。必修截止日导出日历是 `tobacco.py report`：

```bash
python scripts/tobacco.py report --format ics --required-only --alarm-days 3 --out out.ics
```

`report` 的参数：`--format md|csv|ics`（默认 md）、`--out`、`--required-only`、`--alarm-days`、`--mask-titles`。

## 学时与当日额度

`--today` / `--hours` 的停止条件是**本次实际提交出去的秒数**（`sent` 累计）达到缺口，并且额度会传到单个小节内部：一个小节要 600s、本次只剩 90s 时只提交 90s 就停手（日志 `已达本次学时额度（本小节未完成…）`，`--json` 里 `"partial": true`），不会为了学完这一节把额度冲爆。平台 `hourSelf` 只做事后校正，因为平台结算滞后 2–18 分钟，而且**平台是按「小节完成」给学时的**：实测提交 60s、小节变完成态后 `hourSelf` 涨 2.2h —— 平台给多少不由我们控制，工具只能保证不多提交。

`person-courselog` 能拿到学习记录（`--logs`），但里面的 `studyTotalTime` **不能当学时用**（实测我们学完 2340s，该字段仍是 0；81 条记录里只有 8 条非 0）。所以脚本读不到非零值时就返回「未知」，额度按本地账本估算。

当日账本 `data/today_used.json` 只有四个字段：

| 字段 | 含义 |
| --- | --- |
| `date` | 账本日期（北京时间），跨日归零 |
| `base` | 当日基准（学前 `hourSelf` − 平台今日已记） |
| `last` | 最近一次 `hourSelf` |
| `extra` | 本次运行本地已确认上报、平台尚未结算的学时 |

`used = max(last - base, extra)`；`--today` 额度 = min(工作档位当日容量 − used, 网络自学缺口)。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含「今天不用再学」「已达标」） |
| 1 | 目标未达成或运行出错 |
| 2 | 会话失效（`AuthExpired`）—— 重新扫码或 `login-pwd` |
| 3 | 当日配额已满（`QuotaExhausted`） |

`--course` 名称匹配不到时也返回 2（带 `RESULT|ok=false`）。

## 年度报告

```bash
python scripts/mooc_annual.py --year 2026 --out report.md   # .html 结尾出网页版
```

参数：`--year`（默认今年）、`--out`、`--html`、`--json`、`--login-links`。线下培训明细另用 `python scripts/mooc_training.py --year 2026 --refresh`。

## 凭据输出

所有命令默认**不打印完整 token**：stdout 只有前 10 位（`_mask_token`）。需要拿完整凭据（自己拼直达链接、写脚本）时显式加旗标：

| 命令 | 默认 | 显式输出完整 token |
| --- | --- | --- |
| `mooc_annual.py` | 打码，且 Markdown 里不含直达链接 | `--print-token` |
| `dual_login.py` / `flow_test.py` | 打码（`LOGIN_OK` 里也是打码） | `--full` |

理由：stdout 常被日志、会话记录、转发留存，完整 token 等于账号。`--out` 落盘的文件会用 `icacls`/`chmod 600` 收紧权限。

## 使用例子

- 「登录烟草网络学院，看看我还有哪些学习任务」→ `--list`
- 「生成 2026 年的年度学习报告」→ `mooc_annual.py --year 2026`
- 「这周把必修和临期的学完」→ `--todo`（或 `--today` 分天学）
- 「刷够 5 个学时」→ `--hours 5`
- 「搜一下有没有消防安全相关的课」→ `--search 消防`
- 「把必修截止日记到日历」→ `tobacco.py report --format ics --out out.ics`
- 「扫码登录」→ `mooc_api.py qr wechat`

## 关键规则

1. 完成态 `finishStatus` 2/4 算学完；任务状态 3 是「已完成」；过期看 `expired` 字段
2. 平台结算延迟 2–18 分钟：任务变「已完成」要等，⏳ ≠ 失败，别重跑
3. 配额熔断：上报 200 但 `remainingTime` 连续两轮不降 → `QuotaExhausted`（退出码 3）。注意 `remainingTime` 只在提交被接受后才下降，单轮不降是正常的；每轮按“上一轮降了多少”自适应缩小单档秒数（`chunk` 会自动降级），不是失败
4. token 失效**不会自动重登**：脚本抛 `AuthExpired` 并以退出码 2 结束，需用户重新扫码或 `login-pwd`
5. 单端会话：同端重复登录会顶掉另一端；别边学边在 App 里操作
6. 加密上报：字段各自 AES-128-ECB/PKCS7（key 见 `mooc_api.AES_KEY`），Base64 后提交

## 常见问题

- 401：token 失效或同端被顶下线 → 重新 `qr wechat` 或 `login-pwd`，脚本不会自己续期
- 任务不消失：等 2–18 分钟再查，别重学
- `QuotaExhausted`（退出码 3）：当天配额满，次日再跑
- 学时涨得比提交的多 / 提交 60s 却涨了 2h：平台按「小节完成」结算，属平台规则；想让记录干净就用 `--dry-run` 先看要打开哪些课
- dry-run 只体检第一个目标：体检不累计已提交秒数，继续枚举会把全部候选课都打开一遍（早期版本因此在真实账号上打开过 91 门课）
- 课程库课程（不在任务里的）：`--course <id>` 可直接学，文档类小节同样支持加密上报

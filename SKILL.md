---
name: tobacco-mooc-study
display_name: 烟草网络学院学习助手
display_name_en: Tobacco MOOC Learning Assistant
description: 中国烟草网络学院（mooc.ctt.cn）学习任务管理。当用户需要登录烟草网络学院（微信扫码、APP 扫码或账号密码）、查看学习与班级任务、核对学时与截止日期、按在职工作状态生成学习计划、跟踪学习进度或导出任务清单时使用。先判断凭据是否有效，必修与临期任务优先，支持按目标自动完成学习任务（仅本人账号、用户显式要求时，风险见硬性边界），考试与作业必须本人完成。
description_zh: 自动判断登录态，采集学习任务与学时，按在职工作状态排期；可在用户明确要求时按目标（指定课程/学时缺口/全部未完成）自动完成学习任务。
description_en: Check saved credentials, fetch MOOC tasks and study hours, then build a work-aware study plan that prioritizes required and soon-due tasks.
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

# 烟草网络学院学习任务管理

面向 https://mooc.ctt.cn （中国烟草网络学院）的端到端流程：建立登录会话 → 采集学习任务 → 排期 → 跟踪汇报。

平台是 Vue 单页应用（hash 路由 `#/`）。登录页提供烟草网络学院 APP 扫码、微信扫码（隐藏在右上角角标里）与账号密码登录（网页表单可能追加微信/短信双因子验证码）；登录配置里 `weChatLogin=0` 只影响界面入口，不代表微信扫码通道不可用。**账号密码有两条接口**：网页 `/auth` 要会话 key 且可能弹验证码，APP 端 `app-login` 两样都不需要且签发 30 天 token——优先用后者。学习任务通过业务 API 获取，DOM 只作兜底。详见 `@//references/api.md`、`@//references/task-api.md`。

## 硬性边界

- **自动学习只在用户明确要求时执行，且只对本人账号**。平台页脚标注"禁止刷课"，并配置了防刷机制
  （`enableAuti=1`、`enableUnique=1` 多端检测、单日累计 24 小时上限）。`scripts/mooc_study.py` 复现的是
  **学习日志上报接口**（`start-progress` 的 `createTime` 回溯 + 逐轮 `video/doc-progress`），
  等于绕过平台的时长校验——**这是明确的账号风险**：一旦被判定刷课，可能导致学时清零、成绩作废或账号处罚。
  所以：用户没说要"学完/刷完/补齐学时"就**不要主动执行**；执行前把这段风险讲给用户；先给 `--list` / `--dry-run`，
  用户确认后再真实上报。
- **不代考、不代答**。考试与问卷只在用户本人操作时提供页面导航和截止提醒。
- **不处理支付、报名审批等具业务后果的操作**，需要时引导用户在页面上自行确认。
- **凭据只在必要时取值**。密码仅用于发起账密登录，不在回复、日志、计划文件、导出报告中复现。用户明确要求保存时才写入本地加密文件。
- **扫码必须由用户本人完成**。只负责把二维码呈现给用户并等待，不尝试绕过。

## 目录约定

```
scripts/tobacco.py    本地任务库、凭据、排期、导出（不联网）
scripts/mooc_api.py   OAuth API 客户端：微信码/APP 码、轮询扫码、账密登录 app-login（纯 HTTP）
scripts/mooc_tasks.py 凭据状态判断、账密登录、学时总览、任务采集、同步入库（纯 HTTP）
scripts/mooc_training.py 线下集中培训采集：个人中心「班级」清单 + 逐班详情（带 1 小时缓存）
scripts/mooc_annual.py 年度学习报告：汇总学时/任务/培训，出 MD/HTML/JSON（纯 HTTP）
scripts/mooc_study.py 按目标自动完成学习任务：--course/--hours/--todo（复现学习日志上报，仅本人账号）
scripts/dual_login.py 双通道并列出码：两张码一起发、任一扫到即登录、同时过期同时换新
scripts/flow_test.py  单通道分步实测 / watch 模式（--inline 出 base64、--widget 出 HTML）
data/tasks.json       任务库（自动生成）
data/credentials.dat  凭据（仅在用户要求保存时生成，DPAPI 加密）
references/           api.md 登录接口与加密；task-api.md 业务接口与学时分组；
                      planning.md 工作档位与优先级；task-schema.md 字段与排期算法；
                      page-map.md 页面锚点；examples.md 示例数据
templates/            import-template.json 采集结果模板；qr-widget.html 内联渲染模板；
                      workflow.sh 端到端工作流模板
```

`data/` 里的 `tasks.json`（学习记录）与 `session.dat`（加密 token）只在**本机**使用，打分发包时必须排除，绝不外发。

下文命令中的 `$SKILL` 指本 skill 根目录，`$PY` 指可用的 Python 3 解释器。

## 步骤 0 · 先判断凭据是否有效（每次使用 skill 都先做）

**不要一上来就让用户扫码。** 先查本机是否已有可用会话：

```bash
$PY scripts/mooc_tasks.py status --json
```

返回字段：`valid`、`source`（env/session）、`expires_at`、`remaining_seconds`、
`probe_ok`、`member`、`has_password`、`has_session_file`、`next_action`、`reason`、
`login_methods`（恒为 `wechat_qr`/`app_qr`/`password` 三种）。

| 判定 | 你要做的 |
| --- | --- |
| `next_action=skip_login` | **整个阶段 1 跳过**，直接进阶段 2 采集任务。可顺带告诉用户"已有有效登录态，无需重复登录"。 |
| `next_action=need_probe` | 只用了 `--no-probe`，本地时间看着没过期但没探活；**再跑一次不带该参数的 `status`** 才能免登录。 |
| `next_action=password_login` | 本机已存账号密码：**直接走方式三账密登录**（一条命令，免扫码免验证码），不要再去要二维码。 |
| `valid=false` 且 `has_password=false` | 先问用户要账号密码走方式三；用户不愿给密码，再走阶段 1 的两种扫码。 |

必须注意三点：

1. **默认会向 `/human/member/center` 探活**，因为本地 `expires_at` 只是预估，token 可能被平台提前吊销（2026-11-04 实测：扫码 token 标称 4 小时，实际不到 30 分钟就返回 401）；`probe_ok=false` 时一律按无效处理。`--no-probe` 只用于离线快速判断，不能作为免登录依据。
2. 无效时脚本返回退出码 1，这是"需要登录"的信号，**不是脚本崩溃**；判断请以 JSON 的 `valid` 为准。
3. 登录成功后 `dual_login.py` / `flow_test.py` / `login-password` 都会**自动调用 `save_token_from_login()`** 把 token 加密写入 `data/session.dat`，下次 `status` 就能直接放行；无需手工再存一次。

凭据分两类，别混：`data/credentials.dat` 是账号密码（方式三首选凭据），`data/session.dat` 是 access_token（供业务接口）。账密登录签发的 token 标称 **30 天**，扫码签发的只有 4 小时；两者都可能在平台侧被提前作废，所以 `status` 永远以探活结果为准。

## 阶段 1 · 建立登录会话

**三条链路：扫码优先，账密兜底**（用户 2026-11-04 明确要求此顺序）：

| 优先级 | 方式 | 取密 / 授权 | 命令 | token |
| --- | --- | --- | --- | --- |
| 1 | 方式一 微信扫码 | 手机扫码，不接触密码 | `dual_login.py` | 4 小时 |
| 2 | 方式二 APP 扫码 | 手机扫码，不接触密码 | `dual_login.py` | 4 小时 |
| 3 | 账密 · 本机表单页 | 浏览器一次性表单，密码只到 `127.0.0.1` | `mooc_tasks.py login-form` | 30 天 |
| 4 | 账密 · 对话 widget | 对话内表单，密码作为一条消息经 `sendPrompt()` 回传 | Agent 直接调 `login_password` | 30 天 |
| 5 | 账密 · 命令行 | 标准输入 `--password-stdin` | `mooc_tasks.py login-password` | 30 天 |

**默认扫码**：全程不接触密码，凭据由平台下发，本地只留加密 token。用户不愿扫码、或手机不在手边时，才走账密兜底；兜底里优先 `login-form` 本机表单页——密码不进对话记录、不进命令历史、不进进程参数与进程列表，提交后端口立即关闭。

`login-form` 实测（2026-11-04）：GET 表单 200，错误一次性 token 返回 404，响应头带 `no-store` / `no-referrer` / `X-Frame-Options: DENY` / `CSP default-src 'none'`；错误凭据回显 `[90908] 账号或密码不正确` 并保留表单可重试（上限 5 次）；超时自动关端口并返回 `{"ok": false, "reason": "timeout"}`。只监听回环地址，表单路径是一次性随机 token，`log_message` 已静音避免 token 打到控制台。

**对话 widget 表单是最后手段**：widget 内的输入没有独立回传通道，只能靠 `sendPrompt()` 变成一条用户消息，密码会明文写进会话记录（`*.jsonl`）。用它之前必须先告诉用户这一点；用户提交后要提醒改密，或建议之后改用扫码。

方式三走 APP 端接口 `POST /oauth/api/v1/app-login`：**不需要会话 key、不需要浏览器、不触发任何验证码**，是唯一不需要"等人配合"的链路。账号未开通、密码遗忘、单位要求双因子时，扫码是唯一选择。

2026-11-04 20:48 真实账号实测：账密登录一次成功，返回 `expires_in=2592000`，`status`/`summary`/`sync` 三条后续命令全部通过（平台 69 条任务、scope=active 命中 6 条，复跑幂等）。密码少一位时返回 `90908`，改正后即成功——**`90908` 就是密码不对**，别误判成协议问题。

**优先走 API 通道**（`scripts/mooc_api.py`），比驱动浏览器点坐标稳定得多，也不受页面改版影响。API 不可用时再退回浏览器 UI。接口与加密细节见 @//references/api.md。

### 1.1 先读配置

```bash
$PY scripts/mooc_api.py config
```

`loginPageConfig` 里几个关键字段：`accountValue=1` 账号密码可用、`doubleValidate=1` 登录必须过验证码、`weChatLogin` 控制微信切页按钮是否显示。

**注意 `weChatLogin="0"` 只代表登录页不显示那个按钮，不代表微信通道关闭。** 2026-11-04 实测：本组织 `weChatLogin=0`，手动切到该步后二维码正常生成、`createQRCode` 正常返回，扫码链路可用。不要因为看到 0 就告诉用户"微信扫码不可用"。

### 展示二维码：必须在对话里内联渲染

二维码是给人扫的，**只打印 uuid、URL，或只存成文件等于没做**。用户要的是"码出现在对话里"。

2026-11-04 实测四种写法，只有一种能显示：

| 写法 | 结果 |
| --- | --- |
| `<img src="mooc-qr/x.png">` 相对路径 | ❌ 坏图 |
| `<img src="/c/Users/.../x.png">` 绝对路径 | ❌ 坏图 |
| `<img src="file:///C:/.../x.png">` file 协议 | ❌ 坏图 |
| `<img src="data:image/png;base64,...">` **内嵌数据** | ✅ 正常显示 |

所以固定做法：**取 PNG 字节 → base64 → 拼 data URI → 用 `show_widget` 内联渲染**。
`present_files` 只会弹一张附件卡，不算"发在对话里"，只能当补充。

**渲染性能是硬要求：widget 里禁止放 `<script>`（包括倒计时）。** 带 JS 的 widget 需要宿主起沙箱渲染管道，会长时间停在「正在渲染组件」，而二维码只有约 1 分钟寿命，等渲染完码就废了。2026-11-04 实测：同样的两张码，带倒计时 JS 时用户明显感到卡顿；改成纯静态 HTML（有效期写成静态文字「约 55 秒内有效」）后立即出现。过期换新码由 Agent 再发一条消息，不需要前端计时。

图片本身很小（微信码约 1.6 KB、APP 码约 0.6 KB，base64 后合计约 3 KB），体积不是瓶颈，不要为此牺牲清晰度去压缩二维码。

`scripts/flow_test.py ... --inline` 会为每轮二维码输出一行：

```
QR_B64#<轮次>|<uuid>|<ttl>|<base64>
```

拿到后按模板渲染（模板见 @//templates/qr-widget.html），并在文案里写清三件事：**扫法、剩余秒数、过期会自动换新码**。

**失效即更新**：每个 `<img>` 里嵌的是那一轮的码，过期后旧消息里的图必然扫不动。必须在拿到 `QR_EXPIRED#n` 或新一轮 `QR_B64` 后**立刻再发一张新消息**，并明确写"上一张已过期，这是第 n 张"。不要只更新文件、不重发消息。


### 默认做法：两张码一起发（双通道并列）

用户没指明用哪种扫码时，**不要替他选，也不要追问**——一次把微信码和 APP 码并排发在对话里，让他手边有什么就扫什么：

```bash
$PY scripts/dual_login.py --key "<会话key>" \
    --ttl 55 --cycles 3 --out "$WORKSPACE/mooc-dual"
```

每轮同时登记两条通道，输出：

| 行 | 含义 | 你要做的 |
| --- | --- | --- |
| `DUAL_QR#n\|ttl\|wx_uuid\|app_uuid\|<b64微信>\|<b64APP>` | 第 n 组两张码 | 备用原始数据 |
| `WIDGET#n\|<html>` | **并排两张内嵌 base64 的完整 HTML** | 原样交给 `show_widget` |
| `DUAL_EXPIRED#n\|reason=...\|elapsed=..s` | 本组两张都已过期 | 等下一行 `WIDGET#n+1`，立刻再发一条消息 |
| `LOGIN_OK\|{"channel":...,"token":{...}}` | 任一通道扫到并换到 token | 进入阶段 2 |

行为约定（脚本已实现，不要自己改坏）：

- 微信与 APP 用**独立的 requests Session**，避免 cookie/uuid 串扰。
- 轮询时交替查 `checkUUIDStatus` 与 `loginCheck`，**任一通道扫到就立即换凭证并结束**，不用等另一条。
- 两条都没人扫、本地 55 秒计时到点 → **同时重取两张码**再输出一轮。绝不只换其中一张，也绝不复用旧 uuid。
- 换码后必须在对话里**再发一条新消息**并说明"上一组已过期，这是新的一组"。旧消息里的图是静态数据 URI，不会自己更新。

单通道只需要一张码时，才用下面的 `flow_test.py watch --channel ...`。


### 1.2 微信扫码（API 直出码）

```bash
$PY scripts/mooc_api.py qr wechat --out ./mooc-wechat-qr.png --verify
```

`--verify` 会把生成的图片解码回验，确认里面确实是 `wx.zhixueyun.com/.../login/<uuid>/v5/online`。

连续等待 + 过期自动重取用脚本的 `watch` 模式，它会把每轮的 base64 打出来：

```bash
$PY scripts/flow_test.py watch --channel wechat --key "<会话key>" \
    --ttl 55 --cycles 3 --out "$WORKSPACE/mooc-qr" --widget
```

带 `--widget` 时每轮直接输出 `WIDGET#n|<html>`，**把这段 HTML 原样交给 `show_widget` 即可**，不用自己拼模板。
需要原始数据则用 `--inline`，输出 `QR_B64#n|<uuid>|<ttl>|<base64>`。

它输出三类行，按顺序消费即可：

| 行 | 含义 | 你要做的 |
| --- | --- | --- |
| `QR_B64#n\|uuid\|ttl\|<base64>` 或 `WIDGET#n\|<html>` | 第 n 张码已生成 | 立即内联渲染发出去 |
| `QR_EXPIRED#n\|reason=...\|elapsed=..s` | 第 n 张已过期 | 不必动作，等下一行直接发新图 |
| `LOGIN_OK\|{"access_token":...}` | 扫码成功并换到 token | 进入阶段 2 |

也可以在 Python 里自己挂回调：

```python
import base64
from mooc_api import MoocAuth
m = MoocAuth(session_key="<会话key>")

def show(kind, uid, png, cycle):
    b64 = base64.b64encode(png).decode()
    # 用 templates/qr-widget.html 模板把 b64 填进 data URI，交给 show_widget
    # 同时说明：用哪个 App 扫、剩余多少秒、过期会自动换新

res = m.wait_login(kind="wechat", ttl=55, max_cycles=3, on_qr=show)
# res = {"ok": True, "token": {...}} 或 {"ok": False, "timeout": True}
```

`wait_login` 的行为：取码 → 轮询 → 55 秒无人扫就换新码 → 再展示，最多 `max_cycles` 轮。每次重取 uuid 都会变，旧图重发必然扫不动。

**回调里必须真的把图发出去**——只写文件、只 print uuid，用户在这一端是看不到码的。


用户未关注/未绑定公众号时，微信侧会引导绑定，这一步只能在手机上完成。

### 1.3 APP 扫码

```bash
$PY scripts/mooc_api.py qr app --out ./mooc-app-qr.png --verify
```

服务端直接下发 PNG（`deriveQRCode`），内容形如 `infosec|<uuid>|<毫秒时间戳>`。请用户用「烟草网络学院」APP 右上角扫一扫。等待同样用 `wait_login(kind="app", ...)`。

**两条通道都拿不到服务端的过期通知**：实测 70 秒、35 次轮询，返回始终是 `{}`/`null`，`code:"0002"` 一次都没出现过。前端那句「二维码已失效」是它自己数到第 10 次（50 秒）翻的文案。所以过期判断只能靠本地计时，到点就换码，别指望接口告诉你。

2026-11-04 实测：**两条通道都已完整跑通「取码 → 轮询 → 换凭证」**。微信通道 19:46 扫码 33 秒拿到 token；APP 通道 19:56 首次被真人扫中，第 1 轮即返回 `{"access_token":"<access_token>","token_type":"Bearer","expires_in":14400,"state":"/home"}`——与微信通道 token 结构一致，可直接用于阶段 2。此前"APP 凭证未取到"只是当时无人扫码，不是链路问题。

### 二维码有效期：约 1 分钟

前端轮询节奏是 **10 次 × 5 秒**，第 10 次仍无结果就翻成「二维码已失效」。所以：

- **必须现场生成、当场扫**。不要提前生成、不要缓存复用、不要隔几分钟再展示——过期不是脚本的 bug。
- 展示时同步说一句"这张码 1 分钟内有效，扫完告诉我"，避免双方空等。
- 超时一律重新取码，不复用旧 uuid。

### 1.4 方式三 · 账密登录（首选）

用户给出账号密码时，一条命令走完「登录 → 存会话 → 探活」：

```bash
printf '%s' "$MOOC_PWD" | $PY scripts/mooc_tasks.py login-password \
    --username "<账号>" --password-stdin --json
```

密码从**标准输入**传入，不要用 `--password`（会留在进程列表与命令历史里）。成功返回：

```json
{"ok": true, "login_method": "app-login", "member": {"name": "...", "org": "..."},
 "expires_in": 2592000, "expires_at": "2026-12-04T20:45:00", "session_file": ".../session.dat"}
```

`ok=false` 时按 `code` 处理，别按 HTTP 状态（失败也返回 422）：

| code | 含义 | 处理 |
| --- | --- | --- |
| `90908` / `90904` | 账号或密码不正确 | 请用户核对；连续失败先别重试，避免锁号 |
| `90907` | 校验未通过，常跟在多次失败之后 | 疑似频率限制：**立刻停止重试**，让用户稍后再试或改用扫码 |
| `90105` | 账号格式不合规（平台只认手机号/工号） | 请用户改用登录用的手机号或工号，别填姓名 |
| `900000` | 请求格式/加密有误 | 属于脚本问题，**不要归因给用户密码** |
| `900001` | 登录过于频繁 | 停 5–10 分钟再试 |

**关键协议细节**（改脚本时必读，详见 @//references/api.md）：`app-login` 是 form-urlencoded，**每个字段值单独加密**；必填五项 `username`/`pword`/`login_method`/`company_name`/`client_id`；`captcha` 留空即可——**这条链路不触发双因子**，所以不要照着网页表单去要验证码。

用户同意保存凭据时加 `--save-creds`，账号密码以 DPAPI 密文落在 `data/credentials.dat`，下次 `status` 会直接给出 `next_action=password_login`，无需再问密码。**回复、日志、导出文件中一律不复现密码。**

网页端 `/auth` 只在 `app-login` 不可用时作为备选：

```python
r = m.login(username, password)          # POST /oauth/api/v1/auth，需要会话 key
# {"errorCode": 90908} 多为账号或密码不正确
```

它受 `doubleValidate` 约束，验证码必须由用户提供（查收微信或短信的 6 位码），不猜、不跳过、不绕过。既然 `app-login` 更省事，除非确认后者报 900000/90105 之外的结构性错误，否则不要退回这条路径。

### 1.5 会话 key

`loginCheck`、`auth`、`weChat-auth` 都要一个会话 `key`（即前端 `app.global.hashKey`），服务端按登录会话下发。没有时：

1. 用浏览器打开登录页（`mcp__browser__tabs_new` → `https://mooc.ctt.cn` → 点 `a[title="登录"]`）；
2. 从任一 `oauth/api` 请求的 URL 里取 `key=` 的值，交给 `MoocAuth(session_key=...)`。

实测可跨请求复用。接口返回 `900000` 而参数确实已加密时，优先怀疑 key 过期，重新抓一次。

**方式三（`app-login`）不需要这个 key**，这也是它在无浏览器环境下最可靠的原因——扫码链路一旦 key 拿不到就整条走不通，账密链路没有这个依赖。

### 1.5.1 端归属与单端登录（401 最常见的原因）

平台的登录有**两端**，token 不通用、也不共存：

| 登录方式 | 所属端 | 会话文件里的 `token_source` |
| --- | --- | --- |
| 方式三账密（`app-login`） | **APP 端** | `app-login` |
| 微信扫码（`weChat-auth`） | 网页端 | `qr-wechat` |
| APP 扫码（`loginCheck`） | 网页端 | `qr-app` |

`enableUnique=1` 按端单会话：同一端再登录一次，之前那个会话立即失效（表现是 401）。
所以：

- 用户在用手机 App 看课时，**不要**拿账密 token 跑脚本——会把他顶下线，反过来也会被顶；
- 要边跑脚本边在网页端操作，就用扫码得到的网页端 token；
- 批量学习期间尽量退出同端的 App / 网页，少一个"在线"争用点；
- 401 先看 `token_source` 与登录时间，再怀疑密码；`mooc_tasks.py status` 会打印端归属。

### 1.6 兜底：浏览器 UI

API 全线失败、或用户要求"就按网页上的样子点"时，用浏览器工具：

1. `mcp__browser__browsers_list` → `browser_info`；用户已在自己浏览器登录过时，用 `user_open_tabs` + `tabs_claim` 接管现有标签页复用会话。
2. `tabs_new` 打开 `https://mooc.ctt.cn`，`dom_cua_get_visible_dom` 读页面。出现「个人学习中心」或用户姓名即已登录。
3. 未登录时点右上角「登录」（`a[title="登录"]`），跳到 `https://mooc.ctt.cn/oauth/#login/<base64>`。表单真实属性为 `input[name=username]` 与 `input[name=pword]`——**用这两个 name 定位，比文本锚点可靠**。
4. 两个视图切换按钮无文本，DOM 快照里读不到文字：`#D13step-1`（表单）、`#D13step-2`（扫码）。它们常被标题层遮挡，Playwright 点击会报 "intercepts pointer events"，改用 `browser_evaluate` 执行 `document.querySelector('#D13step-2').click()` 即可。
5. 填表可直接 `browser_evaluate` 设置 input 值并派发 `input`/`change` 事件（Vue 双向绑定需要这两个事件）。
6. 登录成功后 URL 变成带 `#access_token=...` 的地址，从 hash 取令牌。

登录失败按现象处理：密码错误 → 询问是否改用扫码；验证码过期（5 分钟）→ 重新获取；页面空白 → 重新加载再读 DOM；提示"仅面向烟草行业内职工开放注册" → 账号未开通，需用户联系本单位培训管理员。

## 阶段 2 · 采集学习任务（API 优先）

业务接口与字段映射详见 @//references/task-api.md。**不要靠 DOM 一个个点页签**——主接口一次能拿全 69 条。

### 2.1 先保存 token

登录拿到 `access_token` 后立刻存好（DPAPI 加密落盘，默认 4 小时有效）：

```bash
$PY scripts/mooc_tasks.py session --token "<access_token>" --expires 14400
```

之后所有 `mooc_tasks.py` 命令自动读本地会话；也可改用环境变量 `MOOC_TOKEN`。
⚠️ 业务接口认证头是 **`Authorization: Bearer__<token>`（双下划线）**，写成 "Bearer " 会 401。

### 2.2 先看学时总览（这一步别省）

```bash
$PY scripts/mooc_tasks.py summary
```

输出两组，字段分组是用户确认过的，不要混：

| 名称 | 已完成 | 要求 |
| --- | --- | --- |
| 网络自学 | `courseHourResult.totalHour` | `requireCourseHour` |
| 集中培训 | `totalClassHour` | `requireClassHour` |

`courseHourResult` 是嵌套对象，没有顶层 `totalHour`。**把差额单独汇报给用户**（例如「集中培训还差 26 学时」），这是年度考核要求，不等于任何单条任务的时长，排期时不要把它硬塞进 `hours`。两组**独立考核、不能互相抵扣**：网课学时再多也补不了集中培训的缺口。

班级任务（`businessType=5`）属于**集中培训、线下形式**：列表接口对它不返回学时和截止，`sync` 会自动调班级详情接口（`/training/student/class-info/front/basic/<businessId>`）补全真实学时（如 24.0）、起止日期和线下地点。排期时它作为**固定日程**单列，不参与每日容量分配——详见 @//references/planning.md。

### 2.3 采集并入库

```bash
$PY scripts/mooc_tasks.py sync --scope active        # 一步完成采集 + 入库 + 打印学时总览
$PY scripts/tobacco.py task list                     # 核对
$PY scripts/tobacco.py task stats
```

只看 JSON 不入库时用 `fetch --scope active --out tasks.json`；`--dry-run` 可预览 sync 内容。

**scope 是硬要求**：真实账号 69 条任务里，45 条已完成、18 条是 2020–2024 年已作废的问卷/直播答疑，真正要安排的只有 6 条。全量灌进任务库会淹没排期。

| scope | 含义 |
| --- | --- |
| `active`（默认） | 未完成、未过期、截止日不在过去 → **排期只用它** |
| `pending` | 所有未完成（含历史遗留） |
| `year` | 本年度开始或截止 |
| `all` | 全量归档 / 核对 |

重复 sync 是幂等的（实测：首次「新增 6」，复跑「新增 0、更新 6」），不会覆盖用户手工标记的完成状态。

### 2.4 两个必须说清的数据边界

- 平台**不返回逐任务进度百分比**，只有 `status`，所以 `progress` 只能是 0 或 100。
- 平台多数任务**不返回 `duration`**，`hours` 是按类型估的（课程 2.0 学时等）；班级任务由详情接口补真实学时。`notes` 里会写「时长为估值」。排期前要向用户说明每日学时是估算出来的。

### 2.5 兜底：DOM 采集

API 失效（改版/权限变化）时才走浏览器：进入「学习中心」→ 逐个页签读 DOM → 按 @//templates/import-template.json 结构写临时 JSON → `$PY scripts/tobacco.py task import --file <文件>`。列表要翻到底，每翻一页重新读 DOM。新锚点补进 @//references/page-map.md。读不到的字段留空并在 `notes` 标注，不要猜。

## 阶段 3 · 排期（在职工作状态 + 必修/临期优先）

### 3.1 先确认在职工作状态

用户是**在职员工，工作日上班时间不可学习**，所以工作日与周末必须取不同的每日容量。
每次排期前先读已保存的档位：

```bash
$PY scripts/tobacco.py profile get --json
```

首次使用，或用户提到"上班 / 加班 / 出差 / 休假 / 轮班"时，先问清当前状态并保存：

```bash
$PY scripts/tobacco.py profile set --work-profile office \
    --weekday-hours 1 --weekend-hours 3 --priority layered
```

默认 `office`（工作日 1 学时、周末 3 学时）。其它档位：`overtime` 加班出差、`leave` 休假脱产、
`shift` 轮班、`flat` 统一。档位表与覆盖顺序见 @//references/planning.md。

### 3.2 生成计划

```bash
$PY scripts/tobacco.py plan --days 14 --out <输出目录>/plan.md
```

**不要再加 `--daily-hours`**，除非用户明确要求"每天都一样"——它会把工作日/周末覆盖成统一档。
需要临时变化时用 `--work-profile`、`--weekday-hours`、`--weekend-hours`、`--priority`，
这些只影响本次，不写回配置。端到端命令串见 @//templates/workflow.sh。

### 3.2.1 免登录直达链接（`--login-links`）

用户希望在计划里**点一下就进去学，不用再登录**时加这个开关：

```bash
$PY scripts/tobacco.py plan --days 14 --login-links --out <输出目录>/plan.md
```

- 任务标题变成 Markdown 链接，点开自动带 token 登录并直接落到该课程/班级详情页；
- 链接形如 `https://mooc.ctt.cn/#access_token=<token>&token_type=Bearer&state=<urlencoded 路由>`，
  依据是平台前端 `main.js` 的 OAuth 初始化逻辑（读 hash → 写 `localStorage.token` → 跳 `state`）。
  `state` **必须整段 URL 编码**，否则路由里的 `&`（如 `/study/course/detail/4&<bid>`）会被截断；
- 没有直达路由的任务类型（未验证过的 `businessType`）保留纯文本并标注「无直达链接」，不生成死链；
- token 取自 `data/session.dat`；没有会话或已过期时**不会**悄悄生成无效链接，而是在计划里追加一条警告。

**安全边界怎么守住**：链接里的 token 等于账号密码，所以

1. 文件顶部必须写明"含登录凭据、勿转发/勿截图/勿提交仓库"；
2. 写完立刻收窄权限（脚本已自动做）；需要分享时用**不带** `--login-links` 的版本另存一份；
3. 回复里只贴链接本身，不复述 token 字符串；
4. token 到期后旧链接失效，重新生成即可，不需要重新登录。

2026-11-04 实测：专题（`/study/subject/detail/<bid>`）与班级（`/train-new/class-detail/<bid>`）
两类链接点开后均落在目标页，顶栏显示已登录账号，无登录框、无 401。

### 3.3 优先级：必修优先、临期优先

默认 `layered` 分层加权：**必修大幅优先**，但**今天/明天截止的选修允许插队抢救**，
避免为了两个月后的必修课而错过明天的考试。用户明确要求"必修绝对优先"或"临期绝对优先"
时再用 `--priority required-first|deadline-first` 切换，并说明切换后的后果。
分数表、冲突样例与取舍理由见 @//references/planning.md。

排期硬约束不变：未到期任务绝不排到自己的截止日之后；已逾期任务尽快补完。

### 3.4 呈现与调整

- 先给结论：今天做什么、最紧的是什么、当前档位与每日容量、有无风险；再给分段表格。
- 每天要能看到「工作日 / 周末」和「已排 / 当日容量」学时，空档日也要显示容量。
- 把阶段 2 的**学时缺口**一并摆出来：任务排完 ≠ 年度考核达标（例如 6 条任务合计 14 学时，
  但集中培训还差 26 学时）。
- 任务时长本身是平台估算值，向用户说明这一点。
- 容量不足时不要擅自加班加点：先说明"按当前档位 X 项无法在截止前完成"，再问是提高工作日/周末学时、
  延长 `--days`，还是放弃选修。

用户可调整：改档位、改窗口天数、切换优先级策略、标记完成、临时删除任务。

## 阶段 3.5 · 自动完成学习任务（按目标学完，仅在用户明确要求时）

用户说"帮我学完这个专题 / 把网络自学学时补齐 / 把未完成的任务都刷完"时才进入本阶段。
先看目标、再体检、最后才真实上报：

```bash
$PY scripts/mooc_study.py --list                                  # ① 可学目标 + 学时缺口
$PY scripts/mooc_study.py --course "<名称|businessId|页面URL>" --dry-run   # ② 体检: 选课与剩余时长
$PY scripts/mooc_study.py --course "<名称>"                        # ③ 学完这一门
$PY scripts/mooc_study.py --hours 8                                # ④ 刷够 8 学时(按缺口自动选课)
$PY scripts/mooc_study.py --hours 0                                #    补齐到 requireCourseHour
$PY scripts/mooc_study.py --todo                                   # ⑤ 全部未完成/未开始
$PY scripts/mooc_study.py --today                                  # ⑥ 只学今天的量(按工作档位容量)
```

| 参数 | 含义 |
| --- | --- |
| `--course` | 名称模糊匹配 / `businessId` / 页面 URL，可重复给多个 |
| `--hours N` | 按「网络自学 = `courseHourResult.totalHour` / `requireCourseHour`」的缺口自动挑课，达标即停；`0` = 补齐到要求线 |
| `--todo` | "我的任务"里 `status` 为 1(未开始)/2(进行中) 且**未过期**的课程与专题 |
| `--today` | 只学今天该学的量：`min(工作档位容量 − 今天已学, 学时缺口)`，学完即停；当天用量记在 `data/today_used.json`（**所有真实上报模式都记**：`--course`/`--todo`/`--hours`/`--today`），同日重跑不会重复给额度 |
| `--dry-run` | 只查选课与剩余时长，**不上报**；不确定先跑这个 |
| `--chunk` | 单轮上报秒数（默认 600） |
| `--wait-sync N` | 学完后只读等待专题层汇总的秒数（默认 0 不等） |

**可学的范围（不限于"我的任务"）**：

1. `--course` 给 **businessId 或课程页面 URL** 时，直接按 id 学习——哪怕是平台课程库里没被推送、
   不在"我的任务/我的课程"里的课程；脚本会用 `course-info/front/find-by-ids` 取名称确认这是哪门课。
2. 给**名称**时按顺序匹配：我的任务 → 我的课程/专题（`personCourse-list`，含自选课与专题内嵌子课程）。
3. 已知限制：平台的课程库**关键词检索接口**（`/course-study/course-front`）需要未公开的必填参数，
   直接调用返回 422 `900000`。所以"库里随便搜一门没加过的课"目前做不到——让用户从页面复制**课程 URL**
   或 businessId 即可，`--course "<URL>"` 一条命令就能学。

输出以机器可读行收尾，供后续判断：

```
RESULT|ok=true|mode=course|courses=1|done=3|total=3|failed=0|hours_gained=null
```

执行时必须向用户交代的几条行为（脚本已实现，不要自己改口径）：

- **完成态是 `finishStatus` 2(复习) 或 4(完成)**，两者都算完成；任务层的 `status` 是 1 未开始 / 2 进行中 / 3 已完成，**过期与否看 `expired` 字段**，不是 `status`。
- **专题层汇总由服务端异步结算**（实测 2–18 分钟，客户端请求触发不了）。所以刚学完看到专题仍是"学习中"属正常：**不要重跑**，重跑只会重复学习、白扣配额。要等就加 `--wait-sync 1200`（只读轮询，不耗学时）。
- **关联课程（sectionType=10）父小节会被平台复核打回**：脚本在课程结束时会回读、发现回退就补一次 settle；仍失败就报"待平台复核"，同样不要重跑。
- **单日累计学时上限 24 小时**：`remainingTime` 连续两轮不下降即判定配额满，脚本停止并在 `RESULT|` 里带 `failed`。
- 考试/作业/调研/SCORM 需真实作答，脚本记 **skipped** 并跳过（不算失败），不代答。
- **别一天刷完**：平台单日上限只有 24 小时，但一次刷太猛更像机器；日常用 `--today` 按
  档位容量（`office` 工作日 1 小时 / 周末 3 小时）分批推进，`--hours` 留给"月底补缺口"。

汇报口径：给"目标 → 完成了哪些小节 → 学时变化 → 是否还要等汇总"，不要把"平台尚未汇总"报成失败。

实测补充（2026-11-05）：非任务课程「内部控制及风险管理」（`6c4e0020-…`）用 `--course` 学完 2/2 小节，
课程层 `finishStatus` 直接回 2，网络自学学时 124.90 → 128.00 —— 说明"任意可学课程"这条路是通的。

## 阶段 4 · 跟踪与汇报

- 查看进度：`$PY scripts/tobacco.py task stats --json`
- 平台侧进度变化：重跑 `$PY scripts/mooc_tasks.py sync --scope active`，按「班级名 + 标题」增量合并；本地已标记完成的条目保持完成状态。
- 用户在平台上学完后，也可用 `task done --id <ID>` 手工记录。平台状态与本地记录是两套数据，以用户实际看到的为准。
- 导出交付物：`$PY scripts/tobacco.py report --format md`（`csv` 带 BOM，Excel 可直接打开；
  `ics` 导出日历文件（每个截止日一条全天事件 + 提前 N 天提醒）。
  **想让手机自动提醒必修截止日**，用订阅而不是一次性导入：

  ```bash
  # 只导必修、提前 7 天提醒；--out 指向你要托管的静态目录
  $PY scripts/tobacco.py report --format ics --required-only --alarm-days 7 \
      --out <静态目录>/mooc.ics
  ```

  **一条命令发布到 GitHub Pages（含多用户）**：

  ```bash
  bash scripts/publish_calendar.sh                 # → https://<owner>.github.io/mooc-calendar/mooc-<用户名>.ics
  CAL_USER=alice bash scripts/publish_calendar.sh  # 另一个用户，同仓库不同文件
  CAL_REPO=alice/mooc-calendar bash scripts/publish_calendar.sh  # 各自 fork，完全隔离
  # 脚本内部用 $PY 调 Python；用 PY=/path/to/python3 可指定解释器
  ```

  文件名按 `CAL_USER`（默认取 git user.name）生成，**每个用户一个地址，互不覆盖**；
  地址的 owner 取自 `CAL_REPO`，所以 fork 后自动变成 `<你的账号>.github.io/…`。
  订阅仓库是公开的，因此脚本默认 `--mask-titles`（课程名换成「必修任务 #n」）；
  内容不敏感时用 `MASK_TITLES=0` 保留课程名。

  订阅要**每天重新生成**才准（截止日与剩余天数会变），配 crontab 每天跑一次即可。
  文件里只有标题/学时/普通课程链接——**不要**把 `--login-links` 生成的带 token 链接放进公开位置。
- 用户提到"每天提醒我"时，可创建定时自动化：每次运行采集、输出当天计划。注意 token 只有 4 小时有效，自动化里要包含重新登录或提示用户扫码，创建前先确认时间与推送方式。

## 阶段 5 · 年度学习报告

用户说"生成年学习报告 / 年度报告 / 总结一下今年学习情况"时使用：

```bash
$PY scripts/mooc_annual.py --year 2026 --out 2026年度学习报告.html   # .html 结尾 = 网页版
$PY scripts/mooc_annual.py --year 2026 --out 报告.md                # 其余后缀 = Markdown
$PY scripts/mooc_annual.py --year 2026 --json                       # 原始数据给下游
```

报告结构：关键指标（两组学时 + 年度任务完成率 + 累计学习时长）→ 学时达成进度条 →
集中培训（线下）清单 → 年度任务执行（已完成/待完成）→ 类型分布与历年趋势 →
自动生成的结论与建议 → 数据口径说明。`--login-links` 同样可生成免登录直达链接（含凭据勿外发）。

HTML 版交互行为（2026-11 起定型）：

- **A4 分页**（`210mm×297mm`），桌面端 JS 等比缩放适配窗口；**移动端（≤760px）自动切换为纵向流式布局**，
  表格横向滚动、KPI 两列、封面单列；支持触屏左右滑动翻页。
- **默认自动播放 + 背景音乐**：打开即 11 秒/页自动翻页，WebAudio 现场合成欢快背景音乐
  （C–G–Am–F 琶音 + 低音 + 轻打击，无外部音频文件）；浏览器拦截自动出声时，首次点击/按键/滚动自动恢复。
- **无底部控制条**（deckbar/hint 已按用户要求删除）；键盘保留：←/→/空格/PgUp/PgDn 翻页，
  Home/End 首尾，`A` 暂停/继续自动播放，`M` 开/关音乐。
- 注意：不要把 `backdrop-filter` 等重滤镜加回固定悬浮条——实测会导致该 Chrome 环境页面周期性自动刷新。

三条硬口径，报告里已写死，**不要在回复里改口**：

1. **学时不能按年拆分**。学时接口不接受 year 参数（实测 2024/2025/2026 返回同值），
   所以学时按"平台当前考核口径"呈现；年度维度只用**任务**数据（按 `startTime` 年份归属）。
2. **没有完成时间**。平台只给 `status`，报告不提供"月度完成趋势"，用截止时间冒充完成时间是错的。
3. **结论别越界**。集中培训缺口只能建议报班/面授，不要建议用网课补；逾期待办只能建议确认补学或豁免，不代做。

用户没指明年份时默认当前年；跨年报告（如"2025 年总结"）同一条命令换 `--year` 即可。

## 故障排查

DOM 里找不到锚点、点击后没反应，说明页面结构变了：

1. 重新 `dom_cua_get_visible_dom`，搜索相近文案（如把「我的学习」扩到「学习」「课程」）。
2. 仍找不到时用 `tab_screenshot` 看实际界面，再决定点哪里。
3. 把新锚点补进 @//references/page-map.md，让下次不必重新摸索。

扫码后一直未跳转：确认用户是否已关注并绑定公众号；二维码有效期通常很短，直接点刷新重扫。页面提示"仅面向烟草行业内职工开放注册"时，说明账号未开通，只能由用户联系本单位培训管理员。

## 参考

- @//references/api.md — OAuth 登录接口、AES 加密机制、三条登录链路的实测可用性
- @//references/task-api.md — 业务接口、Bearer__ 认证、学时字段分组、任务字段映射、scope 过滤
- @//references/planning.md — 在职工作状态档位、按天容量、三种优先级策略与取舍
- @//references/task-schema.md — 任务字段、状态机、排期算法基础
- @//references/page-map.md — 站点结构、文本锚点、校准步骤（DOM 兜底用）
- @//references/examples.md — 示例数据：凭据状态、学时总览、任务归一化、计划输出
- @//templates/workflow.sh — 端到端工作流模板（判断凭据 → 同步 → 排期 → 导出）
- @//templates/import-template.json — 采集结果 JSON 模板
- @//templates/qr-widget.html — 二维码内联渲染模板（纯静态，禁止放 script）

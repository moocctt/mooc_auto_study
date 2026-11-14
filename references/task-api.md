# 学习任务业务接口（2026-11-04 真实账号抓包验证）

与 `api.md`（OAuth 登录接口）分开：这里全部是**登录成功后**的业务接口，走另一套认证头。

## 认证：不是标准 Bearer

```
Authorization: Bearer__<access_token>
```

**`Bearer__` 后面是双下划线，不是空格。** 前端 `oauth` 登录页里也能看到 `Authorization: undefined__undefined`，格式一致。
写成 `Bearer <token>`、省略该头，或只带 cookie，均返回：

```
401 {"errorCode":0,"message":"Access is Denied", ...}
```

其余建议头：`X-Requested-With: XMLHttpRequest`、`Referer: https://mooc.ctt.cn/`。
token 来自登录轮询结果，`expires_in=14400`（4 小时）；过期需重新扫码。

## 接口清单

| 用途 | 方法与路径 | 关键响应 |
| --- | --- | --- |
| **学习任务列表（主）** | `GET /api/v1/human/task?page=1&pageSize=100` | `{items:[...], recordCount:69}` |
| 学时总览 | `GET /api/v1/system/credit/detail-hour-member` | 见下节 |
| 当前用户信息 | `GET /api/v1/human/member/center` | `fullName`、`organization.fullName`、`id`(memberId) |
| 日历任务 | `GET /api/v1/human/task/findMyTaskCalendar` | 8 条带 `completeTime`/`status` 的近期任务 |
| 提醒任务 | `GET /api/v1/human/task/findMyTaskRemind` | 首页实测为空数组 `[]` |
| 月度任务 | `GET /api/v1/human/task/findMyTaskByMonth` | 月度聚合 |
| 学习进度（下属） | `GET /api/v1/course-study/course-study-progress/find-my-subordinate` | 实测 `{items:[],recordCount:0}` |

`pageSize` 实测 100 / 200 都能一次拿全 69 条，无需翻页；脚本仍保留分页兜底。
`_` 时间戳参数只是防缓存，可传可不传。

## 学时总览：两组字段，不要混用

响应体（真实值）：

```json
{
  "courseHourResult": {"id": null, "maxHour": null, "totalHour": 116.10},
  "requireCourseHour": 50.0,
  "totalClassHour": 64.00,
  "requireClassHour": 90.0,
  "totalScore": 180.10
}
```

| 中文名 | 已完成 | 要求 | 真实值 | 结论 |
| --- | --- | --- | --- | --- |
| **网络自学** | `courseHourResult.totalHour` | `requireCourseHour` | 116.10 / 50.00 | 超额 66.10，已达标 |
| **集中培训** | `totalClassHour` | `requireClassHour` | 64.00 / 90.00 | **缺口 26.00，未达标** |

⚠️ `courseHourResult` 是**嵌套对象**，不存在顶层 `totalHour`。首页文案「50 / 116.1 网络自学（时）」是「要求 / 已完成」的顺序，别读反。

学时缺口是**平台年度考核要求**，不等于任何单条任务的 `hours`，排期时要单独向用户提示，不要把它硬塞进任务时长。

## 线下集中培训：我的班级接口与学时口径（实测 2026-11-04）

- 列表：`GET /api/v1/training/student/class-student/front/center-page?page=&pageSize=50`
  （个人中心 →「班级」标签页）。返回 `items[]`：`classId`、`graduateStatus`（1=在读、
  3=已完成、4=已结业）、`createTime`、嵌套 `classInfo`（名称/起止/状态）。
  列表项的 `obtainCourseHour` / `studyTime` 恒为 null，**不要**拿它当已获学时。
- 详情：`GET /api/v1/training/student/class-info/front/basic/<classId>`，取
  `classHour`（线下学时）、`classCourseHour`（线上课程学时）、`trainPlace`、起止、
  `trainContent`、`classStudent`。
- **学时口径（已反证）**：平台 `totalClassHour`（集中培训）＝Σ 当年、graduateStatus=4
  的 `classHour`。实测 2026：13 期班、12 期结业，合计 64.00，与接口 64.0 完全一致；
  在读的 24 学时不计入。纯线上班 `classHour=0`，不算集中培训。
- 全量班级（含历史年份）要翻页取尽；详情逐班请求，加 0.06s 间隔并写缓存
  （`scripts/mooc_training.py` 已实现，缓存 `data/trainings.json`，1 小时有效）。

## 任务字段与映射

`/api/v1/human/task` 的 `items[]` 原始字段：

| 字段 | 含义 | 映射到 `tobacco.py` |
| --- | --- | --- |
| `name` | 任务名 | `title` |
| `businessType` | 1/2 课程专题、3 考试、4 问卷、5 班级、6 直播 | `kind`：`course/exam/survey/class_task/live` |
| `status` | 1 未开始、2 进行中、3 已完成 | `status` + `progress`（3 → 100/done） |
| `sourceForm` | 1=平台派发（必修），null=班级/直播等 | `required`（另：`businessType=5` 也算必修） |
| `endTime` / `startTime` | **毫秒时间戳** | `deadline` → `YYYY-MM-DD` |
| `duration` | 时长（秒），多数为 0/null | `hours = duration/3600`；缺失时按类型给保守估值并在 `notes` 标注 |
| `expired` | 平台标记已过期 | 用于 scope 过滤，`notes` 留痕 |
| `businessId` | 业务 ID | 拼详情 URL |
| `id` | 任务 ID | 存进 `notes` 的 `platform_id`，**不要当本地 `id` 传** |

`mooc_tasks.py` 输出**不带 `id`**，让 `tobacco.py` 按「班级名 + 标题」生成稳定 ID，保证重复 sync 幂等（实测复跑：新增 0、更新 6）。

### 详情 URL（已验证）

| businessType | URL |
| --- | --- |
| 2 专题 | `https://mooc.ctt.cn/#/study/subject/detail/<businessId>` |
| 5 班级 | `https://mooc.ctt.cn/#/train-new/class-detail/<businessId>` |
| 1 课程 | `https://mooc.ctt.cn/#/study/course/detail/4&<businessId>`（由首页课程链接推断） |

3/4/6 的详情路由未在页面上验证，**不拼 URL**，只在 `notes` 留 `business_id`，避免给出打不开的链接。

## scope：历史噪音必须过滤

真实账号 69 条任务的分布（2026-11-04）：

- `status=3` 已完成 45 条，`status=1` 未完成 23 条，`status=2` 1 条；
- `expired=true` 18 条，几乎全是 2020–2024 年的问卷、直播答疑、旧专题；
- 未完成且未过期的**真正当前任务只有 6 条**，5 条截止 2026-12-31，1 条班级任务无截止日。

若把 69 条全灌进任务库，排期会被一堆已作废的历史任务淹没。故 `mooc_tasks.py` 提供：

| scope | 条数（实测） | 用途 |
| --- | --- | --- |
| `active`（默认） | 6 | 未完成、未过期、截止日不在过去 —— 用于排期 |
| `pending` | 24 | 所有未完成（含历史遗留） |
| `year` | 10 | 本年度开始或截止的任务 |
| `all` | 69 | 全量归档 / 核对 |

## 凭据状态判断（每次使用 skill 的第一道门禁）

```bash
python scripts/mooc_tasks.py status --json
```

输出 `valid / source / token_source / expires_at / remaining_seconds / expired_locally / probe_ok / member /
has_password / has_session_file / next_action / reason / login_methods`。

- `next_action=skip_login` → 跳过整个登录流程，直接采集任务；
- `next_action=need_probe` → 只用了 `--no-probe`，本地时间没过期但没探活，需再跑一次不带该参数的 `status`；
- 默认会向 `/human/member/center` **探活**：本地 `expires_at` 只是预估，平台可能提前吊销 token，
  `probe_ok=false` 一律按无效处理；`--no-probe` 仅供离线快速查看，不能作为免登录依据；
- 无效时退出码为 1（表示"需要登录"，不是崩溃），判断以 JSON 的 `valid` 为准；
- `has_password` 报告是否保存了账号密码，供表单登录兜底（仍需人工给双因子验证码）。
- `token_source` 是 `qr-wechat` / `qr-app` / `app-login`，说明 token 从哪端来；平台按端单会话，
  排 401 时先看它。

扫码成功后 `mooc_api.py qr`（以及调试用的 `dual_login.py` / `flow_test.py`）会自己调用
`save_token_from_login()` 写入 `data/session.dat`，下一次 `status` 即可直接放行。

## 用法

```bash
# 0) 每次先判断凭据；有效则以下登录步骤全部跳过
python scripts/mooc_tasks.py status --json

# 1) 首选登录：微信扫码，扫到即换票并写 data/session.dat
python scripts/mooc_api.py qr wechat
#    拿不到 widget 时兜底：--ascii / --no-widget / --open；微信扫不了换 `qr app`
#    扫码全不通才用账密（APP 通道 30 天，会顶掉手机端）
#    python scripts/mooc_tasks.py login-pwd --username <手机号> --pwd-stdin

# 1b) 已有 token（别处拿到的）时手工落盘，DPAPI 加密，4 小时有效
python scripts/mooc_tasks.py session --token <access_token> --expires 14400

# 2) 学时总览
python scripts/mooc_tasks.py summary [--json]

# 3) 采集（输出到文件 / stdout）
python scripts/mooc_tasks.py fetch --scope active --out tasks.json

# 4) 直接同步进本地任务库并打印学时总览（幂等）
python scripts/mooc_tasks.py sync --scope active

# 5) 排期与导出
python scripts/tobacco.py plan --days 10 --daily-hours 2
python scripts/tobacco.py report --format csv --out study-tasks.csv
```

token 也可通过环境变量 `MOOC_TOKEN` 传入（优先级高于本地会话文件）。

## 年度报告相关接口（mooc_annual.py 使用）

| 接口 | 用途 | 关键字段 |
| --- | --- | --- |
| `GET /system/credit/detail-hour-member` | 两组学时（同 `summary`） | 见上方分组表 |
| `GET /system/cadre-education/detail-hour-member` | 干部教育口径，交叉校验 | `hourSelf`/`hourTrain`（与上表同值） |
| `GET /course-study/course-study-progress/history-and-now-duration` | 学习时长（秒） | `studyTime`：`"0"=历史累计，"1"=近期新增，"2"=合计`（实测 0+1=2） |
| `GET /human/task` | 全部任务（含历史年份） | `status`、`startTime`/`endTime`、`expired` |
| `GET /training/student/class-info/front/basic/<id>` | 班级详情 | 见上文班级小节 |

**注意**：`detail-hour-member` 不接受 `year` 参数（实测 2024/2025/2026 返回同值），
学时无法按年拆分；年度报告的"年度"维度只能基于任务的 `startTime` 归属。
`/human/task/findMyTaskByMonth` 只返回"当天是否有任务"的日历布尔值，不能当月度统计用。

## 学习进度相关接口（2026-11-14 真实账号逐条验证）

| 用途 | 方法与路径 | 关键点 |
| --- | --- | --- |
| 我的学习记录 | `GET /api/v1/course-study/course-study-progress/person-courselog` | **必须**带 `businessType`、`startTime`、`endTime`、`page`、`pageSize`；行字段见下 |
| 逐节进度 | `GET /api/v1/course-study/subject/chapter-progress` | **必须**带 `courseId` + 非空 `versionId` + `isRegister` |
| 批量课详情 | `POST /api/v1/course-study/course-info/front/find-by-ids` | 已报名课程会返回 `versionId`、`register` |
| 报名/开始学习 | `POST /api/v1/course-study/course-front/register` | 会建学习记录；**dry-run 不得调用** |

**`chapter-progress` 的参数坑**：只给 `courseId`、或给 `versionId: ""`、或只给 `isRegister`，一律返回
`HTTP 422 {"errorCode":900000,"message":"Invalid input."}`（不是 401、也不是空列表，很容易被误读成“没有进度”）。
`versionId` 只能从 `find-by-ids`（已报名课程）或 `register` 的响应里拿，
`GET /course-study/course-front/info/<id>` **不返回** `versionId`。
因此未报名课程拿不到逐节进度，脚本会在 `course_detail()` 里标 `_progress_unknown`，
dry-run 明确提示“完成度 0 不代表没学”。实测教训：某课 `finishStatus: 2 / completedRate: 100 / lessonLocation: "2340"`，
只给 `courseId` 去查时返回 422，曾被误判成“学时没落库”。

**`person-courselog` 的字段**：`beginTime`、`courseId`、`courseInfo`、`finishStatus`、`finishTime`、`id`、
`isRequired`、`lastAccessTime`、`registerTime`、`studyTotalTime`、`type`。

**`studyTotalTime` 不能当学时**：实测学完 2340s 后该字段仍为 `0`，95 条记录里只有 8 条非 0。
所以 `platform_today_hours()` 读到非零才返回数字，否则返回 `None`（当日额度按本地账本估算），
真学时只认 `detail-hour-member` 的 `hourSelf`。

**平台按「小节完成」结算**：实测提交 60s、小节变完成态后 `hourSelf` 涨 2.2h。
所以工具侧的额度闸门只能保证“不多提交”（提交秒数在小节内部也被截断），
不能让平台少给 —— 报告里要向用户说明这一点。

## 已知边界

- 平台**不返回逐任务的完成百分比**，只有 `status`，因此 `progress` 只能是 0 或 100。
- 平台多数任务**不返回 `duration`**，`hours` 是按类型估的（课程 2.0、班级任务 4.0、直播 1.5、考试 1.0、问卷 0.2、其它 1.0 学时；见 `mooc_tasks.py` 的 `DEFAULT_HOURS`），`notes` 会明确标注「时长为估值」。排期前应向用户说明这一点。
- **班级（businessType=5）是例外**：列表接口对它 `endTime/duration` 恒为 `null`，学时和日程必须再调班级详情接口：

  ```
  GET /api/v1/training/student/class-info/front/basic/<businessId>
  ```

  关键字段：`classHour`（集中培训学时，如 24.0）、`classCourseHour`（其中网课部分，实测为 0）、
  `startTime`/`endTime`（培训起止毫秒时间戳）、`trainPlace`（线下地点）、`trainType`（0 线下 / 1 线上）、
  `registerEndTime`（报名截止）。`sync` 会自动补全，无需手工调用。
- **学时分两组考核，不能互相抵扣**：网络自学 = `courseHourResult.totalHour / requireCourseHour`；
  集中培训 = `totalClassHour / requireClassHour`。班级任务计入集中培训（线下形式，2026-11-04 实测：
  序号34 机器学习与深度学习技术实操培训班，24 学时，11-02~11-06，XX烟草·XX培训中心），
  网课学时再多也不能抵集中培训的缺口。
- 本文件只覆盖任务与学时读取接口；自动学习（学习上报、今日额度）见 `@//references/api.md` 与 `scripts/mooc_study.py`。不挂机保活、不代考，平台页脚明示「禁止刷课」。

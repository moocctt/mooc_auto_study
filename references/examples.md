# 示例数据（脱敏）

供执行技能时对照字段形状与输出格式。所有 uuid / token / 姓名均为示例或截断值。

## 凭据状态 `mooc_tasks.py status --json`

有效（带平台探活）：

```json
{
  "valid": true, "source": "session",
  "expires_at": "2026-11-05T00:15:04", "remaining_seconds": 14101,
  "expired_locally": false, "probe_ok": true,
  "member": {"name": "张××", "org": "XX烟草-->XX市局(分公司)-->XX部门",
             "member_id": "707e08fe-..."},
  "has_password": false, "has_session_file": true,
  "next_action": "skip_login", "reason": "凭据有效，可直接进入阶段 2 采集任务"
}
```

需要登录（token 被平台拒绝）：

```json
{"valid": false, "source": "env", "probe_ok": false,
 "next_action": "need_login", "reason": "401 Access is Denied：token 无效或已过期，请重新扫码登录。"}
```

本机存过账号密码时，脚本会把下一步直接改成方式三：

```json
{"valid": false, "source": null, "has_password": true, "has_session_file": false,
 "next_action": "password_login",
 "reason": "没有任何已保存的会话或 token；本机已保存账号密码，可直接走方式三账密登录（免扫码、免验证码）",
 "login_methods": ["wechat_qr", "app_qr", "password"]}
```

## 账密登录 `mooc_tasks.py login-password --json`

成功：

```json
{
  "ok": true, "login_method": "app-login",
  "username": "13800138000", "userid": "707e08fe-...",
  "member": {"name": "张××", "org": "XX烟草-->XX市局(分公司)-->XX部门",
             "member_id": "707e08fe-..."},
  "probe_error": null, "token_type": "Bearer",
  "expires_in": 2592000, "expires_at": "2026-12-04T20:45:00",
  "session_file": "<skill>/data/session.dat"
}
```

失败（平台用 422 承载业务错误，按 `code` 判断而非 HTTP 状态）：

```json
{"ok": false, "login_method": "app-login", "code": "90908",
 "hint": "账号或密码不正确", "http_status": 422}
```

| code | 归因 | 处理 |
| --- | --- | --- |
| `90908` / `90904` | 用户侧 | 核对密码，别连续重试 |
| `90907` | 疑似频率限制 | 停止重试，改扫码或稍后 |
| `90105` | 用户侧 | 账号要用手机号/工号，不是姓名 |
| `900000` | 脚本侧 | 加密或 content-type 出问题，不要归因给用户密码 |

## 学时总览 `GET /api/v1/system/credit/detail-hour-member`

```json
{
  "courseHourResult": {"totalHour": 116.10},
  "requireCourseHour": 50.0,
  "totalClassHour": 64.00,
  "requireClassHour": 90.0,
  "totalScore": 180.10
}
```

`mooc_tasks.py summary` 输出：

```
学时总览（两组独立考核，不可互相抵扣）
  网络自学：已完成 116.10 / 要求 50.00 学时（网络课程/在线学习）→ 超额 66.10，完成率 232.2% · 已达标
    字段：courseHourResult.totalHour ÷ requireCourseHour
    靠网络课程补；超额部分不能抵集中培训
  集中培训：已完成 64.00 / 要求 90.00 学时（培训班/集中面授）→ 缺口 26.00，完成率 71.1% · 未达标
    字段：totalClassHour ÷ requireClassHour
    只能报班补；网络课程学时不计入这一组
  合计：180.10 学时（平台字段 totalScore，= 两组已完成之和 180.1，校验通过）
```

分组规则见 `@//references/task-api.md`：`courseHourResult` 是嵌套对象，与 `requireCourseHour` 配成「网络自学」；`totalClassHour` 与 `requireClassHour` 配成「集中培训」。`totalScore` 不是第三项指标，就是两组已完成之和。

## 任务原始 item 与归一化结果

平台 `GET /api/v1/human/task` 的一条：

```json
{
  "id": "afe45b77-...", "businessId": "0dac0b1b-...", "businessType": 2,
  "name": "加强国有企业管理，筑牢合法合规防线",
  "status": 1, "sourceForm": 1, "expired": false,
  "startTime": 1773048360000, "endTime": 1798689600000, "duration": 0
}
```

`mooc_tasks.py fetch --scope active` 归一化后（可直接喂给 `tobacco.py task import`）：

```json
{
  "title": "加强国有企业管理，筑牢合法合规防线",
  "kind": "course", "required": true,
  "deadline": "2026-12-31", "hours": 2.0,
  "progress": 0, "status": "todo", "class_name": "",
  "url": "https://mooc.ctt.cn/#/study/subject/detail/0dac0b1b-...",
  "platform_status": "未开始",
  "notes": "平台类型=专题(businessType=2)；platform_id=afe45b77-...；business_id=0dac0b1b-...；开始=2026-03-09；时长为估值2.0学时（平台未返回 duration）"
}
```

注意：**不带 `id`**——让 `tobacco.py` 按「班级名 + 标题」生成稳定 ID，重复 sync 才幂等。

## 工作状态档位 `tobacco.py profile get --json`

```json
{
  "label": "在职坐班（工作日上班，仅晚间可学）",
  "work_profile": "office",
  "weekday_hours": 1.0, "weekend_hours": 3.0,
  "priority": "layered",
  "note": "在职员工，工作日上班时间不可学习，仅晚间与周末可安排"
}
```

对应的 `plan.md` 每日标题（工作日容量 1、周末容量 3）：

```
### 2026-11-04 周三 · 工作日（1.0 / 1.0 学时）
### 2026-11-07 周六 · 周末（3.0 / 3.0 学时）
### 2026-11-11 周三 · 工作日（空档；当日可排 1.0 学时）
```

## 优先级冲突样例（layered 策略）

| 任务 | 必修 | 截止 | 得分要点 | 排位 |
| --- | --- | --- | --- | --- |
| 线上综合考核 | 是 | 今天 | 980 + 800 + 考试 120 | 1 |
| 临时安全测验 | 否 | 明天 | 920 + 350 插队 + 考试 120 | 2 |
| 合规专题 | 是 | 57 天后 | 150 + 800 + 课程 40 | 3 |
| 选修：数据分析 | 否 | 3 天后 | 800 + 课程 40 | 4 |

即：**必修常态优先；只有今天/明天截止的选修允许插队抢救**；3 天后截止的选修排在两个必修之后。策略可切换，详见 `@//references/planning.md`。

# 测试与优化报告 · tobacco-mooc-study（2026-11-14）

被测对象：`gandli/tobacco-mooc-study` main（起点 `85d1a3c Initial commit`），本地检出 `C:\Users\user\desktop\tobacco-skill`。
范围：8 个脚本 + 6 篇 reference + 3 个模板 + CI。

## 一、结论摘要

| 维度 | 结果 |
| --- | --- |
| 静态审查 | 4 份独立审查（登录 / 学习 / 本地数据 / 文档）共 91 条问题，其中 **P0 3 条、P1 17 条** |
| 自动化测试 | 新建 `tests/`，**70 条用例全绿**（含 11 条假平台状态机联调、3 条真实接口契约钉子） |
| CLI 冒烟 | 8 个脚本 `--help` 全 exit=0；无会话时按契约 exit=2 并给出可执行提示 |
| 真实账号 | 登录 → 学时总览 → 任务清单 → dry-run → 小额度真跑，全链路走通；过程中现场发现 **3 个会造成真实副作用的生产级 bug** |
| CI | 原 workflow 引用了 3 个不存在的模块（`mooc_auto_study`/`mooc_api_login`/`mooc_client`）且仓库无 `tests/`，必然失败；已重写为双平台 × 双版本矩阵 |
| 登录体验 | 按需求改为 **widget 优先 + 扫码优先**：单文件 HTML 登录卡片 / 二维码卡片 + 内联 base64 图 + `--ascii` 终端兜底，账密降为最后手段 |

## 二、测试方法（四层，逐层加真实度）

1. **静态审查**：4 个子代理并行只读审查，输出 `file:line` + 修复建议；所有 P0/P1 都被我逐条复核（不接受未验证的结论）。
2. **单元 + 契约测试**：`tests/` 新增 6 个文件，用 `TOBACCO_HOME` 隔离数据目录；`AES_FINGERPRINT` 自检、`render_qr` 用 `gcd` 校验模块整数倍、`_safe_out` 拒绝覆盖 `session.dat`。
3. **假平台联调**：`tests/test_study_flow.py` 实现 5 个真实接口的最小服务端，可模拟「服务端限幅」「remainingTime 冻住」「40909」「全程 401」「课程库报名」等分支——这部分以前完全没有覆盖。
4. **真实账号端到端**：本人账号，登录后只读为主，写入侧控制在个位数学时。

## 三、修掉的缺陷（按危害排序，节选关键项）

### P0 / 会让功能直接报废

| # | 位置 | 现象 | 改法 |
| --- | --- | --- | --- |
| 1 | `scripts/mooc_study.py:957` | 调用 `wait_finish(..., deadline=…)` 但函数签名为 `(s, course_id, timeout)` → `TypeError`，且抛在写账本前，当天账本不落账，下次 `--today` 又给满额 | 签名加 `deadline`，用 `min(timeout, deadline - t0)` 封顶 |
| 2 | `scripts/mooc_study.py` 学时循环 | 停止条件依赖「学完立刻回读 `hourSelf`」，但平台结算滞后 2–18 分钟、课程库课不计入该字段 → 判据恒不成立，把候选课全部学完 | 改为「本次实际提交秒数」硬闸门，`hourSelf` 只做事后校正 |
| 3 | `templates/login-widget.html` + `_template()` | 模板缺失时 `_template` 静默返回空串，`render_login_widget` 无兜底 → 用户看到空白卡片，二维码永远不出现 | 空模板时 stderr 告警 + 内联兜底模板 |

### 现场跑出来的 3 个真实副作用（静态审查没看出来，只有真跑才暴露）

1. **`--dry-run` 会真的报名课程**：dry-run 时本地秒数恒 0，额度判断永不触发，于是把 167 个候选逐个打开；而打开课程会 `POST /course-study/course-front/register`（课程库课还 `registerStudy`）→ 实测在真实账号上产生 **91 次服务端写入**。
   改法：新增 `open_course_readonly()`（只走 `find-by-ids` + `chapter-progress`，失败退回 `course-front/info`），`run_course` 在 dry-run 分支不再调用 `open_course`；dry-run 只体检首个目标并明确提示原因；回归断言 `count("POST", API_REGISTER) == 0`。
2. **额度闸门没下沉到小节**：`--hours 0.03` 真跑，单个 url 小节刷到 `39 轮 / 9407s`（本地记 2.61h，平台 `hourSelf` 277.2 → 281.7，涨 3.6h）。
   改法：`study_section(..., budget=…)` 每轮 `step = max(1, min(step, int(budget - sent)))`，额度到点返回 `partial`；区分 `sent`（提交出去，额度看它）与 `accepted`（平台回报收下，记账看它）。
3. **失败数叠加**：配额熔断 +1 与「目标未达成」+1 计的是同一件事 → `RESULT|failed=2`。
   改法：`unmet` 独立状态位，`RESULT` 增 `error=target_unmet`，`--json` 增 `unmet`；退出码语义固定为 0/1/2/3。

### P1 其它（全部已修）

- `scripts/mooc_study.py`：`rem is None` 与 `rem == 0` 混为一谈（字段缺失被当成「剩 0 秒」，还把 accepted 虚增成整个剩余时长）；40909 重试不清 `prev_rem` → 误抛配额熔断；`max_rounds` 与 `chunk` 无关；回读复核把「未结算」当「被打回」→ 重复上报扣学时；`_req` 401 抛 `SystemExit` 绕过收尾；嵌套课程秒数不进额度；`_today_capacity` 回落 2.0/4.0 与 `tobacco` 默认 1.0/3.0 不一致；日期用本地 `date.today()` 而平台按 UTC+8。
- `scripts/mooc_api.py`：微信轮询只看 `status_code == 200` 不看 `access_token` → 换票被拒也报「扫码成功」；APP 分支把 `{"raw": 错误文本}` 当登录成功；`persist_login` 不传 `source` 一律写 `qr-wechat`；`render_qr` 非整数倍缩放导致模块宽窄交替（微信扫不出）；取码与轮询用了两个不同的 Session（uuid 与会话解绑）。
- `scripts/mooc_annual.py` / `mooc_training.py`：完成率为 `None` 时 `format` 崩、`float(totalScore)` 崩、两组学时都 0 时除零；详情接口失败被 `except Exception: return {}` 吞成「集中培训 0 学时未达标」并写入缓存；「与平台核对一致」是写死文案。
- `scripts/tobacco.py`：`parse_date` 返回 `None` 时 `None - today` → 整个任务库失效；`cred clear` 不清 `session.dat`（里面的 token 仍可用）与 `.bak`；`save_json` 重试耗尽抛 `SystemExit`（学习中途猝死）；`_restrict_permissions` 只查第二条 icacls 且用英文字面账户名（中文系统上还会因 GBK 输出炸）。
- `scripts/flow_test.py` / `dual_login.py`：成功判据与主程序不一致；token 明文进 stdout/落盘；瞬时拒绝永久拉黑微信 openid。
- 文档：`SKILL.md` 首行是字面量 `\n\n#`；引用不存在的 `.env.example` 与 `mooc_api_login.py`；`--ics` 归属错到 `mooc_study.py`；宣称「401 会自动重登」。

## 四、这轮真跑新摸清的平台契约（已写进 `references/task-api.md`）

1. `chapter-progress` **必须**带 `courseId` + 非空 `versionId` + `isRegister`，缺一个就 `HTTP 422 {"errorCode":900000,"message":"Invalid input."}`；`versionId` 只能从 `find-by-ids` 或 `register` 拿，`course-front/info` 不返回。
2. `person-courselog` 可用（必须带 `businessType/startTime/endTime/page/pageSize`），但 `studyTotalTime` **不能当学时**：学完 2340s 后该字段仍是 `0`，95 条里仅 8 条非 0。
3. 平台按「小节完成」结算：提交 60s → 小节变完成 → `hourSelf` 涨 **2.2h**。工具能保证「不多提交」，无法控制平台「多给」。
4. `remainingTime` 只在提交被接受后才下降，单轮不降是正常的；应据「上一轮降了多少」自适应降档，而不是直接判配额满。

## 五、验证证据

```
python -m compileall -q scripts      -> 0
python -m pytest tests -q            -> 70 passed
8 个脚本 --help                      -> 全部 exit=0
无会话 mooc_study.py --list          -> RESULT|ok=false|mode=auth|…|error=no_session, exit=2
mooc_api.py qr wechat --wait 0       -> 真实 uuid + qr-wechat-1.png(159×159) + qr-wechat-1.html(3.1KB), exit=0
mooc_study.py --hours 0.1 --dry-run  -> 3s、只开 1 门、0 次 register、exit=0
mooc_study.py --today                -> 今日容量 3.00h｜已学 0.90h｜剩余 2.10h｜✅ 今天不用再学, exit=0
mooc_study.py --hours 0.03 --chunk 60-> 1 轮 60s 停手，不再跑飞, exit=0
```

## 六、已知残留（明确不掩盖）

- `dual_login.py`：APP uuid 仍用微信实例的 Session 轮询，需真实扫码才能验证（已加注释与降级提示）。
- `mooc_annual.derive()` 的 `per_class` 有 24.0 兜底；`int(r.get("status") or 1)` 未走容错转换。
- 账本 `base` 只做了「平台读不到就告警 + 按本地估算」，没有做上界夹紧。
- 平台给学时远大于提交量属平台规则，报告里必须向用户说明（已写入 `SKILL.md` 与 `task-api.md`）。

## 七、变更规模

19 个文件改动、+1725 / −448；新增 `templates/login-widget.html`、`tests/`（6 个文件）。按规矩未提交，等你确认后我再分批 `git add`。

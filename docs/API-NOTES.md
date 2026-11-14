# 接口考古笔记（web 版新功能的数据源）

来源：extension 分支 `extension/lib/{platform,library,deadline,history}.js`（05504da）反查 + 真机实测（账号 13900001234，2026-11-13，全部 HTTP 200）。所有请求需 `Authorization: Bearer__<token>` + 浏览器 UA。

## 1. 学时账单双轨

`GET /api/v1/system/cadre-education/detail-hour-member`

实测响应：

```json
{"hourSelf":255.70,"hourTrain":64.00,"id":"3870f29c-…","requireCourseHour":50.0,"requireClassHour":90.0}
```

| 字段 | 含义 |
| :-- | :-- |
| `hourSelf` | 网络自学已得学时（刷课能补的就是这条轨） |
| `requireCourseHour` | 网络自学要求学时（50） |
| `hourTrain` | 集中培训学时（面授，刷课补不上） |
| `requireClassHour` | 集中培训要求学时（90） |

证据：`extension/lib/platform.js:24` `API_DETAIL_HOUR`；`:341 hoursSelf()`；`:730-767 runHours()` 用 `hourSelf`/`requireCourseHour` 算缺口。**注意**：网课补不上面授缺口，账单页要把 `hourTrain < requireClassHour` 的缺口单独标出来，不能诱导「再刷 24 学时」这类错误结论。

## 2. 已学学时 / 必修标记（我的课程）

`GET /api/v1/course-study/course-study-progress/personCourse-list`

参数：`page, pageSize, findStudy=0, businessType(0=课程,2=专题), studyTimeOrder=desc, finishStatus=(空), isRequired=(空)`

响应项关键字段（实测）：`courseId, courseInfo{name,coverPath,versionId}, finishStatus(0 未开始/1 学习中/2 已完成(复习)/4 已完成), isRequired(1=必修,0=选修), studyTotalTime(秒), registerTime, beginTime, finishTime`。

证据：`extension/lib/platform.js:25 API_PERSON_COURSE`；`:346-390 personCourses(businessType)`（required/studiedSec/cover 兜底逻辑照抄）。

## 3. 26 周热力图数据

`GET /api/v1/course-study/course-study-progress/person-courselog`（businessType=0，课程）
`GET /api/v1/course-study/course-study-progress/subject-log`（businessType=2，专题）

公共参数：`startTime=<当年1月1日ms>, endTime=<当年12月31日ms>, page, pageSize=100`，翻页条件 `page*100 < recordCount`，每边最多 20 页（extension 的护栏）。

响应项（实测）：`studyTotalTime(秒), lastAccessTime, finishTime, markTime, isRequired, courseInfo{name}`。

**归属近似**：平台只有每课累计 + 最后访问时间，没有按日明细 —— 每条记录的学时全部记到 `lastAccessTime || finishTime || markTime` 所在的那一天（extension 同款近似，`platform.js:415-451 studyLogDays()`）。

热力图渲染规格照抄 `extension/lib/history.js`：26 周 × 7 天，从本周日往回推；等级 `<0.5h=1, <1h=2, <2h=3, ≥2h=4`；未来日期灰格。

## 4. 截止清单

数据源就是任务接口 `GET /api/v1/human/task`（已在用）：items 带 `endTime`（ms，可为 null）、`expired`、`status`。必修/选修不在这接口上 —— 用 personCourse-list 的 `isRequired` 按 `businessId==courseId` 合并；非课程/专题类型（考试 3、调研 4、班级 5、直播 6）必修列显示「—」。

证据：`extension/lib/platform.js:466-489 allViewItems()`（endTime 按 businessId 回填）；`extension/lib/deadline.js`：`dueSoon = required==='必修' && state∉{已完成,已过期} && endTime ∈ (now, now+7d]`，按 endTime 升序；`daysLeftText`：<1h 显示分钟、<24h 显示小时、<10 天显示 1 位小数天。

## 5. 课程库 12 类检索

统一入口 `extension/lib/library.js` 的 `LIBRARY_TYPES`（id → 端点 → 关键词参数），全部实测 200：

| id | 类别 | 端点 | 关键词参数 | 实测返回形状 |
| :-- | :-- | :-- | :-- | :-- |
| 0 | 课程 | `/api/v1/course-study/course-front/findPageForGlobalSearch` | `type=0, publishClient=1, searchContent` | items[]: id/name/credit/courseHour/coverPath |
| 2 | 专题 | 同上 | `type=2` | 同上 |
| 4 | 班级 | `/api/v1/training/student/class-info/simple-activity-list` | `name` | items[]: id/className/startTime/endTime/coverPath |
| 5 | 考试 | `/api/v1/exam/exam/front/activity-list` | `clientType=1, name` | items[]: id/name/credit/startTime/endTime |
| 6 | 调研 | `/api/v1/exam/research-activity/activity-list` | `name` | items[]: id/name/startTime/endTime |
| 7 | 直播 | `/api/v1/course-study/gensee/activity-list` | `clientType=1, name` | items[]: id/coverPath/endTime |
| 11 | 话题 | `/api/v1/ask-bar/topic/name` | `name` | items[]: id/name/description/articleCount |
| 12 | 知识 | `/api/v1/course-study/knowledge/front` | `clientType=1, orderType=0, name` | items[]: id/…（字段多，名称取 `name`） |
| 14 | 微吼直播 | `/api/v1/live/new/activity-list` | `clientType=1, subject` | 实测 0 条（端点有效，无数据） |
| 15 | 新闻资讯 | `/api/v1/system/home-news/findNewsForGlobalSearch` | `newsName` | items[]: id/content/coverPath/createTime |
| 16 | 交流园地 | `/api/v1/system/home-interchange/findInterchangeForGlobalSearch` | `interchangeName` | items[]: id/content/createTime/fullName |
| 20 | 专区专家 | `/api/v1/system/expert-database/findExpertDatabaseForGlobalSearch` | `expertDatabaseName` | 实测 0 条（端点有效，无数据） |

注意：返回里名称字段不统一 —— 依次兜 `name ?? className ?? subject ?? title ?? newsName ?? interchangeName ?? fileName`（`library.js` 同款）。课程/专题项的 `type` 字段要与请求的 id 一致，不一致就丢（`rawTypeOf`，防类型猜错张冠李戴）。封面字段兜 `coverPath/coverImage/coverUrl/img/pic`，相对路径补 `https://mooc.ctt.cn/` 前缀。分页字段是 `recordCount`（不是 total）。

## 6. 可跳转详情链接

课程 `https://mooc.ctt.cn/home?courseId=<bid>`；其余类型 extension 只对课程/专题置 `linkable`（`platform.js:409`），web 版同样只给这两类加跳转。

## 7. 日程四类（班级/考试/调研/直播）

2026-11-13 实测：**无关键词（name 空串或省略）即可拉全量**，分页 `page/pageSize`，总数 `recordCount`：

| 类型 | 端点 | 关键参数 | 名称字段 | 时间字段 |
| :-- | :-- | :-- | :-- | :-- |
| 班级 | `/api/v1/training/student/class-info/simple-activity-list` | `name=''` | `className` | startTime / endTime（ms） |
| 考试 | `/api/v1/exam/exam/front/activity-list` | `clientType=1, name=''` | `name` | startTime / endTime |
| 调研 | `/api/v1/exam/research-activity/activity-list` | `name=''` | `name` | startTime / endTime / publishTime |
| 直播 | `/api/v1/course-study/gensee/activity-list` | `clientType=1, name=''` | `genseeDesc`（兜 `subject`） | startTime / endTime |

数据量：班级 184 / 考试 3 / 调研 3 / 直播 4。窗口过滤取 [now-7d, now+365d]。ICS 导出为协议最小实现（fold/esc 规则同 extension lib/ics.js）：日程生成 timed VEVENT；必修未完任务的截止日生成全天 VEVENT + VALARM -P3D。UID 用 `slug:id@mooc-auto-study`（slug ∈ cls/exam/survey/live，避免中文 UID）。

## 8. 引擎运行历史与定时排程（本地库，非平台接口）

- `engine_runs`：userId/startedAt/endedAt/trigger(manual|schedule)/reason(completed|quota|stopped|error)/submitted；
- `engine_schedules`：userId(主键)/enabled/hour/minute/lastRunDay；scheduler 每 60s 扫描 enabled 行，当天未跑且到达时刻（含 30 分钟宽限）即 startRun，先落 lastRunDay 再启动防重复触发。

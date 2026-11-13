# 功能对齐清单（web ↔ extension）

web 分支从零开始，功能上对齐 `extension` 分支（gandli/tobacco-mooc-study `ext-native`，05504da）。
逐项核对 extension 的 PRODUCT.md 与 views/、lib/ 结构后整理如下。

## 已对齐（v0.1）

| extension 功能 | web 对应 | 状态 |
| :-- | :-- | :-- |
| 登录三通道（账密 / App 扫码 / 微信扫码） | 账密走 `/oauth/api/v1/app-login`、App 扫码走 `deriveQRCode`+`loginCheck` | ✅ 两条通道；微信扫码平台侧凭证未配好（90141），等平台修 |
| 学时快刷（任务 → 课程 → 小节 → 上报） | `lib/engine.js`，与插件版同一套引擎 | ✅ |
| 课程 / 专题搜索 | `findPageForGlobalSearch`，type 0/2 | ✅（并入课程库） |
| 学习任务列表（未完成过滤） | `undoneTasks()`：10 页 × 500、status 1/2、businessType 1/2 | ✅ |
| 运行日志（实时滚动） | 日志卡，500 行环形 | ✅ |
| 运行中防换账号 / 防退出 | 引擎 running 状态守卫 | ✅ |

## 已对齐（v0.2，本轮补齐）

| extension 功能 | web 对应 | 状态 |
| :-- | :-- | :-- |
| 学时账单双轨（网络自学 / 集中培训分开核算） | `detail-hour-member`：两根进度条 + 集中培训缺口单独提示（面授学时网课补不上） | ✅ 真机验证，数字与平台一致 |
| 必修临近截止 7 天清单 | personCourse-list（必修/已学）× 任务接口（endTime）按 businessId 合并，7 天窗口升序 | ✅ 过滤规则单测 + 真机验证 |
| 26 周学习热力图 | person-courselog + subject-log 按日聚合（学时归到最后访问日，extension 同款近似），今日/本周/本月/本年汇总 | ✅ 真机验证 26 列 |
| 课程库 12 类内容检索 | `LIBRARY_TYPES` 12 类全部接入，逐类真机实测（微咆 14 / 专区专家 20 端点有效但平台无数据） | ✅ |
| 封面 + 列表双视图、已加入任务标记 | 封面卡（封面兑底链）+ 列表行切换；已加入标记来自 personCourse-list + 任务接口 | ✅ 真机验证 |

接口考古证据（端点、参数、响应形状、extension 源码行号）见 [docs/API-NOTES.md](./API-NOTES.md)。

## 已对齐（v0.3，本轮补齐）

| extension 功能 | web 对应 | 状态 |
| :-- | :-- | :-- |
| 学习档案/历史记录（学时流水） | 学习记录明细：热力图任意一天下钻当日每门课流水 | ✅ 真机验证 |
| 班级/考试/调研/直播日程 + ICS 导出 | 日程页四类活动全量拉取 + ICS（含必修截止全天事件 + 3 天提醒，ics.js 同款 fold/esc） | ✅ 真机验证 |
| 无人值守的定时能力 | 定时引擎：服务端 scheduler，每天到点自动开跑、配额满自停、当天不重复——web 版反而比 extension 更适合挂机 | ✅ 真机验证 |
| 运行日志联动运行记录 | 引擎运行历史落库（触发方式/结束原因/提交轮次） | ✅ |
| —（extension 无此功能） | 达标预测：近 4 周周均速推算自学轨达标日期；引擎必修优先排序 | ✅ 新增 |
| 官网登录态无感导入 | 不适用 | extension 靠浏览器共享 localStorage；web 版拿不到，只能走自己的登录 |
| 无人值守看课（驱动真实播放器） | 不适用 | 必须在平台页面里真实播放；web 版是独立页面，驱动不了，这项由 extension 承担 |
| 多标签页状态同步 | 不适用 | 单页应用天然单实例 |
| 双轨分发（商店版 / 完整版） | 不适用 | web 版本地运行，无商店审核问题 |

## 架构决策：为什么必须带一个本地服务

实测（2026-11-13）：`OPTIONS https://mooc.ctt.cn/api/v1/human/task` 预检 → **403，无任何
CORS 响应头**。纯静态网页部署在别的源上无法直接调平台接口，这条路是死的，所以：

- Express（server/）同时当静态服务器和平台代理：浏览器请求同名 `/api` 业务路由，
  服务端转发到 `https://mooc.ctt.cn/*`，浏览器与平台「同源」，CORS 不存在。
- 平台凭据 AES-256-GCM 加密落库（Prisma + SQLite/PostgreSQL 双 schema），
  登录的 AES-128-ECB 字段加密放服务端 —— WebCrypto 不支持 ECB 模式。
- 学院 access_token 只存在服务端进程内存里，浏览器拿不到；进程退出即失效，不落盘。
- 本地跑：`bun dev`（tsx :8080 + vite :5173）；生产 Docker Compose（app + PostgreSQL + Nginx）。

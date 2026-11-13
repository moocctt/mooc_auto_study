# 框架对比 — WXT(ext 分支) vs 原生 MV3(ext-native 分支)

> 2026-11-14 · 基于 worktree 并行开发与两分支对齐过程的一手数据。两版功能已对齐（PR #244），同为 v2.11.3。

## 结论先行

**原生的优势是「少」：零依赖、零构建、源码即产物。WXT 的优势是「稳」：类型检查、声明式 UI、多浏览器、编译期开关。** 当前双轨维护可行（两分支模块 1:1 对应），长期建议二选一时看第 6 节。

## 1. 架构与产物

| 维度 | WXT (ext) | 原生 (ext-native) |
|---|---|---|
| 技术栈 | React 19 + Tailwind 4 + TypeScript | 原生 JS + 手写 CSS（token 化） |
| 构建链 | wxt build（实测 2.9s）+ Vite | 无（extension/ 即产物）；唯一例外：content script 需 esbuild bundle（MV3 不支持 ESM 注册） |
| 产物体积 | 1.18 MB（含 react-dom） | 约 250 KB（源码直载，无框架运行时） |
| 依赖 | package-lock 289 KB，node_modules 重 | 零运行时依赖（vendor 仅 qrcode.js） |
| manifest | wxt.config.ts 生成（含条件字段） | 手写静态文件 |

## 2. 开发体验

| 维度 | WXT | 原生 |
|---|---|---|
| 开发环 | dev server + HMR，改组件即时热更 | 改完 `chrome.runtime.reload()` + 页面刷新（脚本可自动化） |
| 类型检查 | tsc 全量（strict 关但仍有 2339 类错误可拦） | 无类型；**import 遗漏只在运行时爆炸**（openLog 事故） |
| UI 修改 | JSX 声明式，React 卸载管理浮层 | 手写 el() 树 + 手动 replaceChildren，需自己管竞态 |
| 联调 | web-ext run 自动起 Chrome + 固定扩展 ID | scripts/dev-chrome.sh 自建 profile + CDP 9223，等价可用 |

## 3. 修复成本实证（本会话 8 类修复的双向移植）

- **WXT→原生方向（历史移植）**：原生是 WXT 的手工移植版，移植时引入了直角漂移、圆角体系矛盾、`openLog` 未导入、浮层定时器竞态（`requestModalClose` 引用模块级 dlg）等 6+ 缺陷——**手工移植 + 无类型是缺陷的主要来源**。
- **原生→WXT 方向（本次对齐）**：同样 8 类修复，WXT 侧 +174 -132 一趟过，`tsc` 直接拦下合成事件类型问题（isComposing 不在 React.KeyboardEvent 上），无运行时意外。
- **React 免疫的 bug**：modal 关闭竞态（声明式卸载天然无此问题）、事件监听器泄漏（卸载自动清理）。
- **原生独有的坑**：content script bundle 的源码（/tmp/build/src）**从未入库**——产物即源码，改内容脚本等于盲改压缩前产物。这是原生分支当前最大的工程债。

## 4. 多浏览器与商店

| 维度 | WXT | 原生 |
|---|---|---|
| Firefox | `wxt build -b firefox-mv3` 一键（SW 自动转 background.scripts） | 无 |
| 商店版开关 | `STORE_BUILD=1` 编译期注入，manifest 条件字段干净 | `flags.js STORE=false` 运行时常量，manifest 需手改 |
| AMO 适配 | 有（innerHTML 静态扫描消音插件） | 无 |

## 5. 测试

| 维度 | WXT | 原生 |
|---|---|---|
| 单测 | 262（vitest + jsdom 环境） | 248（vitest，纯逻辑） |
| DOM/UI 测试 | 可加（React Testing Library 顺手） | 需自建（现靠 CDP e2e 兜底） |
| e2e | tests/e2e + web-ext run | tests/e2e + dev-chrome + CDP，等价 |

## 6. 建议

1. **短期维持双轨**：worktree 并行，行为对齐以 ext-native 为先（它是活跃分支），每批原生修复同步 WXT（本次已建立对齐清单模板）。
2. **必须还的债（原生分支）**：content script 源码入库，否则内容脚本不可维护。
3. **若二选一**：
   - 追求**长期可维护 + 多浏览器 + 商店合规流程** → WXT（类型、HMR、声明式 UI 的错误前移价值已被本会话实证）
   - 追求**极致轻量 + 零供应链 + 完全可控** → 原生（1.18MB vs 250KB，零依赖审计面）
4. 任何一方停止维护前，先跑一次 `extension-analyze` + 商店预扫确认退役方不含独家能力。

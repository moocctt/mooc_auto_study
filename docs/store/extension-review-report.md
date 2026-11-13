# Extension Review 报告 — 烟草网络学院学习助手（原生 MV3）

- 扫描对象：`extension/`（manifest v2.11.3，无构建工具链，extension/ 即加载目标）
- 扫描日期：2026-11-14
- 扫描范围：manifest.json + 41 个 JS + vendor 库 + docs/store 上架材料

---

## 总评

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 2 |
| MEDIUM   | 1 |
| PASS     | 12 |

**Verdict: WILL BE REJECTED（当前构建不得提交公开商店）**

首要原因不是技术违规，而是**项目铁律与商店政策双重禁止**：本构建含自动学习值守（自动化执行），
`extension/lib/flags.js` 中 `STORE = false`（含 shortcut 注释：商店合规发布需手动改 true 并核对 manifest 权限），
AGENTS.md 登录安全铁律第 6 条明确「含自动化执行的产物永不上架公开商店（STORE_BUILD=1 构建剔除）」。
`docs/store/` 下的上架材料描述的是 STORE 变体，**提交前必须产出 STORE_BUILD 版本**，本分支产物不可直接上架。

---

## Issue 1: 自动化功能 —— 当前构建禁止上架（阻断项）

- **Severity**: CRITICAL（政策层面，非代码缺陷）
- **Violation Code**: Red Magnesium（单一用途/功能合规）+ 平台服务条款风险
- **Root Cause**: 自动学习值守（`lib/platform.js` 自动播放、后台 `AP.on` 值守状态机）在本构建中默认启用入口（`STORE=false`）
- **File(s)**: `extension/lib/flags.js:10`（`STORE = false`）、`extension/lib/platform.js`、`extension/background.js:320-330`
- **Solution**:
  1. 商店版走 `STORE_BUILD` 流程：`flags.js` 改 `STORE = true`，剔除自动化入口、日志浮层、完整名称/描述
  2. 对照 `docs/store/submission-guide.md` 逐项核对
  3. 自动学习辅助已在描述/单一用途/隐私政策三处如实披露（listing.md 头部声明），若平台方认定违规仍会被下架——上架决策需自行评估该风险

## Issue 2: 未使用的 host 权限

- **Severity**: HIGH
- **Violation Code**: Purple Potassium（权限过度）
- **Root Cause**: `host_permissions` 含 `http://127.0.0.1/*`，但全代码库无任何调用（API origin 由平台页动态下发，均为 `https://mooc.ctt.cn`）
- **File(s)**: `extension/manifest.json:9`
- **Solution**: 商店版 manifest 移除 `http://127.0.0.1/*`。开发版可保留（与 flags.js shortcut 注释的「商店发布时核对权限」口径一致），故本次未改动运行分支

## Issue 3: 视频自动播放与版权/平台条款的边界

- **Severity**: MEDIUM
- **Violation Code**: Blue Zinc（版权规避，边界情形）
- **Root Cause**: 自动值守代为操作播放器积累学时。缓解因素：播放由本机浏览器真实进行、不伪造记录、仅本人已登录会话、三处如实披露
- **File(s)**: `extension/lib/platform.js`（播放器自动化）、`PRIVACY.md` 第四节
- **Solution**: 已有缓解措施充分；仅商店版需维持披露一致性，并接受平台方可能的下架裁量

---

## 通过项明细

| # | 检查 | 结果 | 备注 |
|---|------|------|------|
| 1 | 远程代码执行（Blue Argon） | ✅ PASS | 无 eval / new Function / 外链脚本 / 动态远程 import |
| 2 | 代码混淆（Red Titanium） | ✅ PASS* | `lib/crypto.js` 的 btoa/atob 为凭据保险库 AES（合理用途）；`lib/vendor/qrcode.js` 为开源二维码库 |
| 3 | 权限最小化 | ⚠️ Issue 2 | `storage`/`alarms` 均有实际使用；tabs API 未声明 `tabs` 权限（更优），host 仅 mooc.ctt.cn + 多余的 127.0.0.1 |
| 4 | 隐私政策（Purple Lithium） | ✅ PASS | `PRIVACY.md` 与 `docs/store/privacy-policy.html` 同步维护（`npm run privacy:check` 校验）；数据全部本机存放，无自有服务器 |
| 5 | 元数据（Yellow Zinc） | ✅ PASS | 16/32/48/128 图标齐全；描述为一句话功能说明；screenshots/promo/changelog 备齐 |
| 6 | 单一用途（Red Magnesium） | ✅ PASS* | 进度查看 + 任务清单 + 自动学习辅助同属「学习助手」单一用途，披露一致；但见 Issue 1 阻断项 |
| 7 | 描述与功能一致（Red Nickel） | ✅ PASS | listing.md 明确声明「如实披露自动学习辅助，不含规避性表述」 |
| 8 | 明文传输（Purple Copper） | ✅ PASS | 业务通信全走 `https://mooc.ctt.cn`；http:// 仅存于 vendor 库注释 |
| 9 | 关键词堆砌（Yellow Argon） | ✅ PASS | 名称 10 字符，描述单句，无堆砌 |
| 10 | 最低功能（Yellow Potassium） | ✅ PASS | 41 个 JS、36 个测试文件 250 用例、完整控制台 UI |
| 11 | 挖矿（Grey Silicon） | ✅ PASS | 无挖矿特征 |
| 12 | 版权规避（Blue Zinc） | ⚠️ Issue 3 | 边界情形，缓解措施已到位 |
| 13 | 通知滥发（Yellow Nickel） | ✅ PASS | 未使用 chrome.notifications，无角标骚扰（iconState 仅状态灰显） |
| 14 | 无感知数据收集（Purple Nickel） | ✅ PASS | 无 history/webNavigation；tabs.onUpdated 仅取活动标签 URL 做课程页判断，纯本地；密码仅在显式勾选后保存；凭据同步默认关闭（选择加入） |
| 15 | 敏感信息硬编码 | ✅ PASS | 无密钥/token 硬编码；manifest key 为商店打包占位 |

---

## 提交商店前检查单（若决定上架 STORE 版）

1. [ ] `extension/lib/flags.js` → `STORE = true`（剔除自动化入口）
2. [ ] `manifest.json` 移除 `http://127.0.0.1/*`
3. [ ] `npm run privacy:check` + `release:check` 通过
4. [ ] 上架材料（listing/截图/权限说明）与 STORE 版实际功能逐条比对
5. [ ] 评估平台条款风险后自行决策（本项目铁律倾向不上架自动化版；STORE 版已剔除自动化，可独立决策）

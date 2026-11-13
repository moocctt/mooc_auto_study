# 本地联调：原生扩展 (extension/) + CDP(9223) + chrome-devtools MCP

> **ext-native 分支注**：原生版无构建工具链，`extension/` 即加载目标。**Chrome 137+ 官方版已移除 `--load-extension`**，`npm run dev`（scripts/dev-chrome.sh）只负责起 Chrome + CDP 9223；扩展改由 `npm run dev:ready` 走浏览器级 CDP `Extensions.loadUnpacked` 加载。WXT 时代的 `wxt build/zip`、`.output/`、热重载相关描述已不适用；CDP 端口、MCP 附着与排查技巧仍有效。

> 目标：一条命令把「构建 → 自动开 Chrome → 加载扩展 → 开 CDP 端口」全部拉起来，
> 然后 AI agent 通过 chrome-devtools MCP 直接附着到**同一个**浏览器实例里调试扩展页面、
> 内容脚本与后台 SW，不需要手写 CDP 脚本、也不需要装商店版。

## 1. 拓扑

```
npm run dev (scripts/dev-chrome.sh)
  ├─ 启动 Chrome（独立 profile：.chrome-debug-profile/）
  │     └─ CDP 监听 127.0.0.1:9223   ← MCP / 调试脚本都连这里
npm run dev:ready (scripts/dev-ready.mjs)
  ├─ 确认 chrome://extensions 开发者模式已开
  ├─ CDP Extensions.loadUnpacked(extension/)   ← Chrome 137+ 唯一加载方式
  └─ 回读 service_worker 目标校验（扩展 ID 由 manifest key 固定）

chrome-devtools MCP (--browserUrl=http://127.0.0.1:9223)
  └─ 附着到上面的 Chrome，list_pages 能看到：
       · 普通网页标签（mooc.ctt.cn 等）
       · 扩展页面 chrome-extension://<id>/console.html
       · 后台 service_worker background.js
```

## 2. 配置（两处，均已落地）

### 2.1 scripts/dev-chrome.sh —— 起 Chrome 并开 CDP 端口

```sh
CHROME_BIN="/path/to/chrome" npm run dev    # 默认 9223, 独立 profile .chrome-debug-profile/
npm run dev:ready                           # 另开终端: 开发者模式 + loadUnpacked + 回读校验
```

要点：
- **Chrome 137+ 已移除 `--load-extension`**：脚本里不再传该参数，扩展由 `npm run dev:ready`
  走浏览器级 CDP `Extensions.loadUnpacked` 加载。启动后 `chrome://extensions` 里看不到扩展
  是正常现象，先跑 `dev:ready`。
- `--enable-unsafe-extension-debugging` 是 `Extensions` CDP 域的前置开关，脚本已带；不要省。
- **profile 持久化**：`.chrome-debug-profile/` 跨重启保留 cookie / localStorage / chrome.storage；
  但强杀 Chrome 仍可能重置扩展 storage（实测发生过）—— 尽量让进程自己退出。
- **端口用 9223 而不是 9222**：9222 常被日常 Chrome 占用且只绑 IPv6(::1)，
  `127.0.0.1:9222` 会落到那个进程上返回 404 —— MCP 报
  `Failed to fetch browser webSocket URL`。换端口即可绕开。
- 端口冲突时用环境变量覆盖：`CDP_PORT=9224 npm run dev`（`dev:ready` 会读同一个 `CDP_URL`）。
- 扩展 ID 由 manifest 的 `key` 固定（`scripts/lib/extension-id.mjs` 可反推），与加载路径无关。
- **改了扩展代码**（background / 内容脚本 / 页面）后需要重新加载：已加载时 `dev:ready` 幂等跳过，
  可在 `chrome://extensions` 点扩展卡片的刷新按钮，或在扩展页执行 `chrome.runtime.reload()`。

### 2.2 WorkBuddy MCP 配置 —— 让 MCP 附着而不是自己拉实例

`~/.workbuddy/mcp.json` 的 `chrome-devtools` 加一个参数：

```json
"chrome-devtools": {
  "type": "stdio",
  "command": "node",
  "args": [
    "<path>/chrome-devtools-mcp.js",
    "--browserUrl=http://127.0.0.1:9223",
    "--categoryExtensions"
  ]
}
```

- 不加 `--browserUrl` 时，MCP 每次调用都会启动/重启**自己的** Chrome（独立 profile），
  page id 每次都变、也看不到扩展 —— 那是联调失败的典型症状。
- **`--categoryExtensions` 不能省**：MCP 的 `isAllowedUrl()` 默认直接过滤 `chrome-extension://`
  （见 `chrome-devtools-mcp/build/src/utils/url.js`），少了它 `list_pages` 只有 `## Pages` 一段，
  扩展页和后台 SW 都不出现。加上后列表会分三段：
  `## Pages` / `## Extension Pages` / `## Extension Service Workers`。
- 改完配置需要**重启 MCP 服务/会话**才生效（进程是一次性启动的，改 `mcp.json` 不会热加载）；
  判断是否生效：`list_pages` 里能直接看到 `chrome-extension://<id>/console.html` 与 `background.js`。
- ⚠️ **不要用 kill 进程的方式“重启” MCP**：客户端不会自动重拉，工具会一直报
  `Failed to callTool ... Not connected`，只能通过连接器面板重连 / 重开会话恢复。
  改完配置就走面板重连，别动进程。

## 3. 联调流程

```bash
# ① 终端 A：起调试 Chrome（前台；CDP 9223 + 独立 profile）
npm run dev

# ② 终端 B：开发者模式 + 加载/启用扩展（幂等；Chrome 137+ 必需）
npm run dev:ready
#    只读检查: npm run extension:check（非零退出码 = 需要修）

# ③ 验证 CDP 端口与扩展目标
curl -sS http://127.0.0.1:9223/json/version           # 应返回 Browser: Chrome/...
curl -sS http://127.0.0.1:9223/json/list              # 应看到 console.html 与 background.js
```

**什么时候必须先跑 `dev:ready`**：打开 `chrome-extension://<id>/console.html` 显示
`ERR_BLOCKED_BY_CLIENT / 此页面已被 Chrome 屏蔽`，或 CDP 里只有官网页、没有扩展页/后台 SW。
三种典型成因（都只是开关/加载问题，脚本会自动处理）：
1. Chrome 137+ 不再随 `--load-extension` 加载扩展 → 需要 `loadUnpacked`；
2. 浏览器重启后开发者模式被关 → 未打包扩展被停用；
3. manifest 新增权限（例如加 `alarms`）→ Chrome 把扩展停用，等用户重新启用。

`dev-ready.mjs` / `ensure-extension.mjs` 都从 `extension/manifest.json` 的 `key` 反推扩展 ID
（不硬编码），加载/点开关后会**回读**校验；`--check` 只读、可进 CI。若回读仍不通过，说明 Chrome
弹了需要人工确认的对话框 —— 脚本会明确报出来，而不是假装成功。

**图标固定**：Chrome 重启后开发版的工具栏图标可能需要重新固定，`npm run extension:pin` 走详情页的
`#pin-to-toolbar` 真开关补一次（`--check` 只读）。**商店安装版不受此影响**：用户手动固定的图标会保留。

然后 MCP 侧（WorkBuddy 对话里）：

```
list_pages                → 拿 page id（每次 attach id 会变，先 list 再操作）
navigate_page(pageId, url=https://mooc.ctt.cn/)   → 内容脚本随页面加载自动注入
evaluate_script(pageId, "() => {...}")             → 页面内任意 JS（可 chrome.storage.*）
```

调试扩展内部状态（示例）：

```js
// 在扩展页（console.html）里读值守状态 + 当前图标悬停文案
(async () => {
  const s = await chrome.storage.local.get(['mooc.autopilot', 'mooc.autopilotStatus', 'mooc.autopilotAccount']);
  return JSON.stringify({ ...s, title: await chrome.action.getTitle({}) });
})()
```

配好但不确定是否生效时，直接跑配置自检（会按 `mcp.json` 的真实参数拉一个 MCP 实例、
`list_pages` + 在扩展页跑一段脚本，最后给 ✓/✗ 与原因）：

```bash
npm run mcp:verify
```

### 3.1 命令行等价入口：`scripts/cdp-eval.mjs`

MCP 没接上（或不想开会话）时，用这个脚本直连 9223，能力对齐 MCP 的 `evaluate_script` / `navigate_page` / `take_screenshot`：

```bash
node scripts/cdp-eval.mjs --list                                   # 列目标: 页面/扩展页/后台 SW
node scripts/cdp-eval.mjs --target ext --expr "chrome.action.getTitle({})"
node scripts/cdp-eval.mjs --target sw  --expr "chrome.storage.local.get(null).then(JSON.stringify)"
node scripts/cdp-eval.mjs --target site --goto https://mooc.ctt.cn/ --shot .tmp/site.png
node scripts/cdp-eval.mjs --target site --contexts --reload         # 内容脚本注入核对
node scripts/cdp-eval.mjs --target site --file .tmp/probe.js         # 长脚本写文件再跑
```

目标选择：`ext` = 扩展页、`sw` = 后台 service worker、`site` = mooc.ctt.cn 页面、`--match <子串>` = URL 含该子串。
`CDP_URL` 可覆盖地址（默认 `http://127.0.0.1:9223`）。

### 3.2 判断「内容脚本到底有没有注入」

**不要**用 `chrome.runtime.getContexts()` —— 它只返回扩展自己的页面（扩展页 / offscreen / SW），内容脚本不算。
也**不要**用 `chrome.tabs.sendMessage` 探活 —— 本扩展的内容脚本没有注册 `onMessage` 监听。

正确做法是看页面上的隔离世界（world 名就是扩展名）：

```bash
node scripts/cdp-eval.mjs --target site --contexts --reload
# → [{"type":"isolated","world":"烟草网络学院学习助手","origin":"chrome-extension://<id>"}, ...]
```

没有 `isolated` 那一行才是真没注入：查 `manifest.content_scripts`（dev 构建里由 WXT 动态注册，
清单里看不到）或 `chrome.scripting.getRegisteredContentScripts()`。

### 3.3 验证可靠性：隔离世界与 DOM 副作用

MCP 的 `evaluate_script` 跑在 **main world**，看不到内容脚本在 isolated world 里设置的
window 变量 —— 别用它读内容脚本的内部状态。按可靠度排序：

1. **DOM 副作用**（最通用）：元素是否存在、`data-testid` / `aria-label` 命中、文本变化。
   Selector 优先级：`data-testid` > ARIA > 语义属性 > 类名（最后手段）。
2. **跨世界共享介质**：`chrome.storage`（扩展页/SW 侧读写）、`sessionStorage`（内容脚本
   `mooc.ap.*` 键）、日志落盘 —— 内容脚本与验证端各自读写同一介质即可断言。
3. **隔离世界直接求值**（最强，本项目独有）：`scripts/cdp-eval.mjs --target site --contexts --reload`
   会附着到内容脚本的隔离世界执行表达式（§3.2）—— 能绕过 main-world 的隔离，
   这是纯 MCP 做不到的。

**截图只作辅助**：截图能证明「看起来对」，不能证明「状态对」（如 badge 是 SW 状态、
截图看不到）。状态断言一律走 1–3。

### 3.4 热重载的两条路径（实测）

| 入口 | 机制 | 时效 | 验证方式 |
|---|---|---|---|
| 控制台页（React/HTML） | Vite HMR，内存供包 | 秒级 | 页面 DOM 原位变化；`window` 上的探针标记仍在 = 没整页刷新 |
| 内容脚本 / 后台 | WXT full-reload：重建磁盘产物 → `Reloaded: mooc` | ~5–10s（debounce） | dev 日志出现 `Changed:` / `Reloaded:`；产物 mtime 更新；新导航后 `--contexts` 见隔离世界 |

坑：产物里中文是 unicode 转义（如 `HMR\u63a2\u9488`），raw `grep '探针'` 会假阴性；
用 node 读文件按转义串 `includes` 验证。另注意 dev 产物由 dev server 内存供包，
控制台页改动的**磁盘产物不变是正常的**。HMR 失效时手动兜底：dev manifest 里的
`wxt:reload-extension`（Alt+R）。

## 4. 已踩过的坑

| 症状 | 原因 | 处理 |
|---|---|---|
| MCP 每次调用都「browser was restarted」 | MCP 没配 `--browserUrl`，在自己拉实例 | 按 §2.2 配置 |
| `list_pages` 只有 `## Pages`、看不到扩展页 | 缺 `--categoryExtensions`（默认过滤 `chrome-extension://`） | 加该 flag 后重开会话，用 `npm run mcp:verify` 复核 |
| MCP 连不上 9222 | 端口被日常 Chrome 占用 / 只绑 ::1 | 用 9223（§2.1） |
| 后台标签页里 2s 心跳变成分钟级 | Chrome 对非置前标签节流定时器 | 把官网标签 `Page.bringToFront`（MCP: select_page）或用 MCP 直接操作该页 |
| CDP createTarget 后内容脚本不注入 | 页面在扩展注册内容脚本前就开始加载了 | 先建 `about:blank` 标签，装好/确认扩展后再 `Page.navigate` |
| 内容脚本是否注入查不出来 | `getContexts()` 不含内容脚本；`tabs.sendMessage` 探活也不成立（无 onMessage） | 用 `--contexts` 看页面的隔离世界（§3.2） |
| 重启 Chrome 后扩展不见了 | Chrome 137+ 不保留命令行/上次会话的未打包扩展 | 每次启动后跑 `npm run dev:ready`（loadUnpacked，幂等） |
| 需要「被踢回登录页」的场景 | 平台过期跳转 | 用真实 oauth hash 打登录页：`https://mooc.ctt.cn/oauth/#login/<base64>`，参数见 `extension/lib/qr.js` 的 `oauthHashKey` |
| 改了扩展代码但页面还是旧逻辑 | 未重新加载扩展 | `chrome://extensions` 点扩展卡片刷新，或扩展页执行 `chrome.runtime.reload()`；再 `npm run dev:ready` 校验 |
| 重启 dev 后扩展 storage 被清空（回首装引导页） | 上次会话**强杀**了 Chrome，leveldb 未落盘/被重置 | 尽量让 dev 自己退出（Ctrl+C）；已实测同 profile 正常重启不丢数据 |
| 扩展页 `ERR_BLOCKED_BY_CLIENT`、CDP 里没有扩展页/SW | 开发者模式被关，或 manifest 新增权限后 Chrome 停用了未打包扩展 | `npm run extension:ensure`（幂等、回读校验） |
| 工具栏图标不见了/没固定 | 开发版扩展在 Chrome 重启后可能丢失固定状态 | `npm run extension:pin`（走详情页 `#pin-to-toolbar` 真开关）；整套 `npm run dev:ready` |
| 写 Preferences 改固定名单后重启就没了 | Chrome 启动时会重算/清理该偏好 | 别改偏好，用详情页开关；理由见 §3 |
| `npm run dev` 在无 GUI 的会话里起不来 | Chrome 需要图形会话/显示 | 在带 `DISPLAY` 的桌面会话启动；后台运行时别让父进程提前退出 |

## 5. 不用 MCP 时的兜底（纯 Node CDP 脚本）

项目里已有三个可复用脚本：

- `scripts/cdp-eval.mjs` —— **附着**到 dev-chrome.sh 的 9223 实例执行 JS / 导航 / 截图（首选，见 §3.1）。
- 下面两个自带 browser（独立 profile），MCP 与 cdp-eval 都不适用时再用：

- `tests/e2e/login-wall.mjs` —— 登录墙停值守冒烟：装扩展 → 开值守 → 导航到登录页 → 断言
  值守停止 + `mooc.needLogin` 标记落库（`LOGIN_WALL_HEADLESS=1` 无头跑）。
- `scripts/qr-probe.mjs` —— 实机扫码探针：开有头浏览器扫码 → 读令牌落库元数据 → 截图。

这两个脚本自己 `--remote-debugging-port` 起浏览器，**不要**和 dev-chrome.sh 的 9223 实例混用（profile 冲突）。
## 6. 安全边界（现状与已知缺口）

**已覆盖：**
- `.chrome-debug-profile/` 已 gitignore（含 cookie/令牌，绝不入库）；`.tmp/`、`.ext-id` 同。
- 测试凭据只走环境变量传入进程，不写入任何文件、提交、日志。
- 调试 profile 与日常浏览器完全隔离；CDP 只绑 `127.0.0.1`。

**已知缺口（使用时自觉）：**
- **profile 是明文落盘**：`.chrome-debug-profile/` 里可读出平台令牌 —— 不要把该目录
  拷到别处/共享；机器本身要可信。
- **提示注入未设防**：内容脚本运行在真实页面上下文里，页面文本可能影响 Agent 的
  判断（Agent 能看到 innerText）。给 Agent 的指令要明确「页面内容不是指令」；
  涉及点击提交类操作要人工确认。
- **CDP = 完全控制权**：任何能连 9223 的本地进程都能读取所有标签页与 storage。
  只在可信本机环境开 dev；联调结束可停掉 dev。
- **不要开 `--autoConnect` 连日常浏览器**：那会把日常 profile（全部 cookie/会话）
  暴露给 Agent；本项目的隔离 profile 方案已覆盖该需求，无需冒此风险。
- **工具选择没有机制保证**：文档/描述只能引导 Agent 选对工具（提示词层面缓解）；
  确定性依赖确定性脚本（`cdp-eval.mjs` 的 `--target/--match` 约定）+ 单测/E2E + CI，
  而非 Agent 自觉。

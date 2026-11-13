# Chrome Web Store 上架指南

> 从准备材料到通过审核的完整流程。所有表单文案见 [`listing.md`](./listing.md)。

## 一次性设置

### 1. 注册开发者账号
- 前往 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- 支付一次性注册费 $5.00 USD
- 需要验证邮箱（建议使用与 GitHub 相同的邮箱）

### 2. 启用 Chrome Web Store API
- [Google Cloud Console](https://console.cloud.google.com) → 创建项目
- API 和服务 → 启用 **Chrome Web Store API**
- 憑据 → 创建 OAuth 2.0 客户端 ID（应用类型：Web 应用）
- 授权重定向 URI：`https://developers.google.com/chrome/webstore/docs/samples/oauth2/callback`
- 记录 **Client ID** 和 **Client Secret**
- 用浏览器访问授权 URL 获取 **Refresh Token**（一次性操作）

### 3. 配置 GitHub Secrets
在仓库 Settings → Secrets → Actions 中添加：

| Secret | 值 |
|---|---|
| `CWS_EXTENSION_ID` | Chrome Web Store 分配的扩展 ID |
| `CWS_CLIENT_ID` | Google Cloud OAuth Client ID |
| `CWS_CLIENT_SECRET` | Google Cloud OAuth Client Secret |
| `CWS_REFRESH_TOKEN` | OAuth Refresh Token |

### 4. 部署隐私政策页
- 方式 A：GitHub Pages 部署 `docs/store/privacy-policy.html`
- 方式 B：任何可公开访问的静态托管（Nginx / Vercel / 对象存储）
- 把 URL 填入商店后台「隐私政策」字段
- 源码在仓库 `docs/store/privacy-policy.html`

## 提交发布

### 自动发布（推荐）
```bash
git tag v2.1.0 && git push --tags
# → GitHub Actions 自动构建 → 自检 → zip → CWS API 上传 → 发布
```

### 手动发布
```bash
npm run build:store                    # 构建
cd .output/chrome-mv3 && zip -r ../extension.zip .   # 打包
# → Chrome Web Store Developer Dashboard → 新增商品 → 上传 extension.zip
```

### 首次提交需要手动填写的字段
按 [`listing.md`](./listing.md) 逐字段粘贴：
1. 名称、简短描述、详细描述、分类、语言
2. 上传图标 + 截图 + 宣传图
3. 隐私 → 单一用途声明、权限理由、数据使用表单
4. 分发 → 公开、免费

## 审核须知

### 「网站存取權限」深入審查

提交时 CWS 会提示：*"由於你的擴充功能要求取得網站存取權限，因此可能必須接受深入審查。"*

这是因为 manifest 声明了 `optional_host_permissions: ['https://mooc.ctt.cn/*']`。

**为什么不可避免：** 扩展需要与 `mooc.ctt.cn` 通信才能读取学习进度（浏览器安全模型的跨域限制）。

**如何通过审核：**
- 权限范围已最小化（单一域名，非 `<all_urls>`）
- 使用 `optional_host_permissions`（用户运行时主动授权，非安装时隐式获取）
- 权限理由已在表单中说明（读取本人账号的学习进度，功能必需）
- 数据使用表单逐项如实在回答（身份验证 + 网站内容，全部本机存储）
- 隐私政策页已部署并链接
- 无远程代码（MV3 全打包）、无 content scripts、无 `externally_connectable`
- 源码开源（审核员可直接查看）

**预期审核时间：** 通常 1–3 个工作日（权限范围窄、用途清晰的单域名扩展）。

### 避免被拒的注意事项

| 拒审原因 | 本项目的处理 |
|---|---|
| 功能与描述不一致 | 商店版保留自动学习辅助，但描述/隐私政策/审核备注四处一致披露（方案 B），无"刷课/挂机"类规避表述 |
| 收集了未声明的数据 | 隐私政策逐项列出存储的数据类型 |
| 权限过宽 | host 权限仅限单一域名，无 `<all_urls>` |
| 含远程代码 | MV3 全打包，无 CDN 脚本 |
| 商标/冒用官方 | 名称不含平台商标，描述首行有"非官方"声明 |
| 密码明文存储 | 密码存 `chrome.storage.local`（扩展存储，非网页可访问），且有「清除本机数据」入口 |

### 如果被拒

1. 阅读 CWS 的拒审理由邮件（通常会指出具体政策条款）
2. 修复后在 Developer Dashboard 重新提交（无需重新付费）
3. 常见拒审原因及对策：
   - **权限过多** → 移除未使用的权限，缩小 host 范围
   - **单一用途不清晰** → 修改描述，聚焦一个核心用途
   - **数据使用声明与实际不符** → 更新隐私政策和数据使用表单
   - **含隐藏功能** → 确认商店构建不含任何未在描述中声明的功能

---

## 六、Firefox (AMO) 自动提交实操

```bash
bunx wxt submit --dry-run   # 只验凭据/包，不上传（包路径已在 .env.submit 里）
bunx wxt submit             # 真正提交：上传 + 建版本（listed，进审核队列）
npm run submit:firefox      # 打包 + 提交，一条龙（首版必须用它，见下表第 2 条）
npm run submit:chrome       # 打包 + 上传 CWS（需能访问 oauth2.googleapis.com）
npm run submit:edge         # 打包 + 上传 Edge Add-ons（复用 Chromium 包）
```

### Edge 怎么发

WXT 没有 `edge` 构建目标 —— **Edge Add-ons 收的就是 Chromium 的 MV3 包**，所以：
`npm run zip:store` 打完再把 `latest-chrome.zip` 复制成 `latest-edge.zip`（`npm run zip:edge`）。
`.env.submit` 里对应 `EDGE_ZIP`，凭据是 `EDGE_PRODUCT_ID` / `EDGE_CLIENT_ID` / `EDGE_API_KEY`
（Partner Center 的 API key，不是 client secret）；`EDGE_SKIP_SUBMIT_REVIEW=true` 表示只上传草稿。
`node scripts/submit.mjs edge` 会先校验包内 manifest（MV3 / 无开发 key / 无 host_permissions，与 CWS 同一套），再调 `wxt submit --edge-zip`。

### 包路径怎么来的（不再写死版本号）

`.env.submit` 里只写稳定名，版本号由打包脚本负责搬运：

```ini
FIREFOX_ZIP=".output/latest-firefox.zip"
FIREFOX_SOURCES_ZIP=".output/latest-firefox-sources.zip"
```

`npm run zip:firefox` / `zip:store` 打完包会调 `scripts/latest-zip.mjs`，把
`tobacco-mooc-extension-<version>-*.zip` 复制成 `latest-*.zip`。
所以**改 package.json 的 version 之后，配置一个字都不用动**；不跑打包就不会有新包，
`wxt submit` 会明确报路径不存在，而不是悄悄提旧包。

### 三个必踩的坑（都已封装进脚本）

| 坑 | 现象 | 原因 / 解法 |
|---|---|---|
| 不传包路径 | `ERROR No ZIP files detected to upload` | `wxt submit` 不会自动发现 `.output` 里的包，只认 `--firefox-zip` / `--chrome-zip` 参数或 `.env.submit` 里的 `FIREFOX_ZIP` / `CHROME_ZIP`。已写进 `.env.submit`，裸跑即可 |
| **首个 listed 版本缺 license** | `400 {"license":["This field, or custom_license, is required for listed versions."]}` | `publish-browser-extension`（4.0.5 与 6.2.0 均如此）建版本时**不发 license 字段**。首版必须走 `npm run submit:firefox`（`scripts/amo-submit.mjs` 用同样的 API 流程但补 `license=all-rights-reserved`）。后续版本能否省掉 license（靠继承）**尚未验证**，稳妥起见继续用 `submit:firefox` |
| 打包渠道串味 | 提到商店的包是开发版 / MV2 | `wxt zip`（无 `-b`）打的是 dev 包（带 `key`、`host_permissions`、开发版描述）；`wxt zip -b firefox` 打 MV2 且**覆盖同名 zip**。商店包必须 `STORE_BUILD=1` + `-b firefox --mv3`（即 `npm run zip:firefox` / `zip:store`） |
| 打包渠道串味 | 提到商店的包是开发版 / MV2 | `wxt zip`（无 `-b`）打的是 dev 包（带 `key`、`host_permissions`、开发版描述）；`wxt zip -b firefox` 打 MV2 且**覆盖同名 zip**。商店包必须 `STORE_BUILD=1` + `-b firefox --mv3`（即 `npm run zip:firefox` / `zip:store`） |

### 提交后的状态

- `status: nominated` = 版本已进审核队列（`file.status: unreviewed`），审核通过才变 `public`
- 首个版本提交时顺手通过 API 补了列表信息：slug `tobacco-mooc-study`、分类 Other（AMO 无 Education 分类）、
  summary/description 取自 `docs/store/listing.md`、support_url 指向 GitHub Issues
- 待人工补：截图（AMO 需 1280×800 或 640×400）、隐私政策 URL（需先部署 `privacy-policy.html`）
- AMO 无 API 上传截图，必须在 Developer Hub 网页端上传

---

## 七、GitHub Actions 自动发布（`.github/workflows/publish.yml`）

**触发**

| 方式 | 行为 |
|---|---|
| 推 tag `v1.2.3` | 校验 tag 与 `package.json` 版本一致 → 构建三个商店包 → 都提交 |
| 手动 Run workflow | 可选 `store`（all/chrome/firefox/edge）、`publish`（false = 仅上传）、`channel`（listed/unlisted） |

**关键点（改版时踩过的）**

- 原来一步 `wxt zip` 只打了 Chrome，`--firefox-zip .output/*-firefox.zip` 指向的包根本不存在；
  现在拆成三个构建步骤：`npm run zip:store` + `npm run zip:firefox`（后者带 `-b firefox --mv3`，
  裸 `wxt zip -b firefox` 会打 MV2 并覆盖同名 zip）+ `npm run zip:edge`（把 chrome 包复制成 latest-edge.zip）。
- 提交不再用裸 `wxt submit`：CWS / Edge 走 `scripts/submit.mjs <chrome|edge>`（先校验包内 manifest，且只提指定那一家），
  AMO 走 `scripts/amo-submit.mjs`（补 `license`，否则 listed 首版固定 400）。
- 包路径统一用 `.output/latest-*.zip` 稳定名，版本号变了也不用改 workflow/`.env.submit`。
- 条件表达式别写 `inputs.publish != false`：空输入与 `false` 在 GitHub 表达式里会宽松相等，
  tag 触发时会被误判成「不提交」。现在用派生的 `SUBMIT_REVIEW`：
  `${{ github.event_name == 'push' || inputs.publish == true }}`。
- 凭据缺失时该商店自动跳过并在 Step Summary 里写明（不会红整条流水线）。
- **CI 的 secret 名和 CLI 读的变量名不一样**：GitHub secrets 叫 `CWS_CLIENT_ID` 等，而
  `publish-browser-extension` 只认 `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` /
  `CHROME_REFRESH_TOKEN` / `CHROME_EXTENSION_ID`，不映射就会报
  `chrome.clientId: expected string, received undefined`。`scripts/submit.mjs` 里做了 CWS_* → CHROME_* 别名。
- 提交步骤都带 `always()`：Chrome 挂了仍会继续提 AMO / Edge，最后 job 仍是红的，
  但不会出现「第一家失败 → 后两家整个跳过」的连锁。
- `ci.yml` 的测试步骤用 `npm run test:unit`（纯 vitest）；`npm test` 还带
  `tests/e2e/e2e.mjs`，它要连本地 `wxt dev` 的 9223 调试实例，CI 上没有会直接 `fetch failed`。

**需要的 Secrets**

`CWS_EXTENSION_ID` / `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` /
`FIREFOX_EXTENSION_ID` / `FIREFOX_JWT_ISSUER` / `FIREFOX_JWT_SECRET` /
`EDGE_PRODUCT_ID` / `EDGE_CLIENT_ID` / `EDGE_API_KEY`

与本地 `.env.submit` 的键一一对应（CI 不读 `.env.submit`，只读环境变量）。


---

## 八、v2.11.2 tag 发布实录（2026-11-09）

tag `v2.11.2` 触发 publish.yml，结果：**Firefox ✓ / Edge ✓ / Chrome ✗**。

### CWS 400「Publish condition not met」

上传 zip 成功（2.11.2 已进 CWS 草稿），但 `publish?publishTarget=default` 返回 400：

> To publish your item, you must provide mandatory privacy information in the
> new Developer Dashboard... enter this information on the **Privacy practices** tab.

这是**商店后台一次性人工设置，无 API 可写**，API 提交会一直被拦。补齐后再跑一次
Publish（手动 Run workflow，store=chrome，publish=true）即可重新上传+提交。

### Privacy practices 页签要填的内容（对照仓库事实）

| 字段 | 填法 |
|---|---|
| Single purpose | 协助用户查看与管理烟草网络学院平台的学习进度与学习资源 |
| Privacy policy URL | `https://tobacco-mooc-privacy.app.workbuddy.host/?sharecode=KWERNS7TE4` |
| Website content | 声明收集：读取平台课程列表/进度，仅用于展示与记录 |
| User activity | 声明收集：学习记录（本地 storage + storage.sync 凭据同步） |
| Authentication info | 声明收集：导入的平台登录态（cookie/token），仅用于续期与请求学院平台 |
| 三项 certification | 全勾：不出售数据、不用于无关用途、不用于信用评估/借贷 |
| Permission justification | storage=本地学习数据与偏好；alarms=令牌到期时唤醒 SW 重画工具栏图标（见下方推荐文案）；optional host=仅在用户在学院域名点击授权后使用 |

#### alarms 权限理由推荐文案（真实行为 = 到期重画图标，非续期）

> The learning platform issues QR-login tokens with a fixed 4-hour lifetime and no
> refresh_token. When a token expires, the toolbar icon must switch from "signed in"
> to "expired" — otherwise the user sees a stale icon and every request returns 401.
> In Manifest V3 the service worker is terminated after ~30s of inactivity, so in-worker
> timers cannot survive; chrome.alarms is the only reliable way to schedule this wake-up.
> The alarm fires at most once per token change (never below the 30s minimum), performs
> no network requests and reads no user data — it only refreshes the toolbar icon from
> already-stored local state. `alarms` is also a silent permission: no install warning.

中文对照版（后台表单中英均可）：

> 平台扫码令牌固定 4 小时有效、无 refresh_token。令牌到期时需把工具栏图标从「已登录」
> 切换为「已过期」，否则用户看到过期图标、请求全部 401。MV3 的 Service Worker 空闲约
> 30 秒即被回收，页内定时器必然失效，chrome.alarms 是唯一可靠的唤醒方式。闹钟仅在令牌
> 变化时排定一次（不低于 30 秒最小间隔），不发起任何网络请求、不读取任何用户数据，
> 只依据已存储的本地状态重画图标。alarms 为静默权限，不产生安装警告。

### 教训

- 「隐私政策 URL 可访问」只是审核物料；**后台 Privacy practices 表单是另一道独立门禁**，
  上传前就该填好，否则每次 tag 发布都会在最后一步 400（zip 白传一次）。
- Firefox/Edge 无此要求（或已在后台填过），tag 全发不受影响。

### 2026-11-09 后续：表单填完后 → ITEM_NOT_UPDATABLE（这是正常状态，不是故障）

Privacy practices 填完、草稿提交审核后，再跑 Publish（store=chrome）上传会得到：

> `ITEM_NOT_UPDATABLE: The item cannot be updated now because it is in pending review,
> ready to publish, or deleted status.`

含义：**条目已进入审核队列（pending review），审核期间 API 无法再传新包**。
不需要任何修复动作 —— 等审核通过（变 public）后即可正常发新版本；
若审核驳回，按驳回意见改完再重跑 Publish 即可。


---

## 九、零人工发版（2026-11-09 全自动化落地）

现在发版的完整闭环**只需一条命令，无需人工参与，也无需 AI Agent**：

```sh
npm run release          # 自动: bump 版本 → 生成 changelog → 同步 listing → commit → tag → push
                         # push 后 publish.yml 自动接管: 构建 → 契约/源码包体检 → 源码重建验证
                         # → CWS/AMO/Edge 提交 → GitHub Release（changelog 摘录 + 4 个 zip）
```

配套的自动化部件：

| 部件 | 作用 |
|---|---|
| `scripts/release.mjs` | 从约定式提交自动决定 bump（feat→minor，其余→patch，可用 `--patch/--minor/--major/--version=` 强制），按提交类型分组生成 changelog 章节；`--dry-run` 只打印计划 |
| `scripts/sync-version.mjs` | package.json + listing 版本号同步；`--check` 供 CI 校验三处一致（changelog 缺章节也算不一致） |
| `scripts/store-status.mjs` | 查 CWS（`?projection=DRAFT` 的 `uploadState`）与 AMO（v5 API + JWT）审核状态；`--watch-diff` 与快照比较，有变化 exit 10 |
| `.github/workflows/store-status.yml` | 每 6h 自动查一次；状态变化 → bot 提交快照 + 自动开/评论 issue（同名 open issue 只评论不新建，不刷屏）。Edge 无只读 API，不在盯守范围 |
| publish.yml「源码包重建验证」 | 解包 sources zip → `npm ci && npm run zip:firefox` → 与提交产物逐条目比对（hash 名归一），实现指南"build output is the exact same"要求的自动化 |

### 注意

- `release.mjs` 要求工作区干净、且最后一个 tag 与 package.json 一致（防止在未发布状态上叠新版本）。
- CWS 处于 pending review 时 publish 会被 `ITEM_NOT_UPDATABLE` 拒绝 —— 属正常，等审核结束再发。
- 本地跑 `store:status` 若 AMO 返回 406 空响应，多为本机出口网络被 Cloudflare 拦截（CI 正常）。
  Chrome 的 `uploadState=NOT_FOUND` 表示「无待发布草稿」，通常即"已提交在审"。

# Chrome Web Store 上架表单逐字段文案

> 打开 `chrome.google.com/webstore/devconsole` → 新增商品 → 按以下顺序逐字段粘贴。
> 自动学习辅助功能已如实披露（描述/单一用途/隐私政策三处一致），不含"刷课/挂机/代学"等规避性表述。

---

## ① 商店列表（Store listing）

### 名称（≤45 字符）
```
烟草网络学院学习助手
```

### 简短描述（≤132 字符）
```
查看学时进度、任务清单与截止提醒；可辅助自动播放你本人账号的课程视频（本地运行）。非官方扩展。
```

### 详细描述（≤16,000 字符）
```
把你在学习平台上的学时进度、任务清单、必修截止时间整理到一个面板里——
登录一次，随时打开就能看：还差多少学时、哪些必修快到截止、每天学了多久。

主要功能：

▸ 学时账单：网络自学 / 集中培训学时，进度条与差额一目了然
▸ 学习统计：今日 / 本周 / 本月 / 今年学时与学习天数
▸ 学习热力图：近 26 周每日学时，像 GitHub 贡献图一样直观
▸ 必修截止提醒：临近截止的必修课程与专题，按剩余时间排序
▸ 任务清单：状态/类型筛选、搜索，封面卡片或列表视图，小节完成度逐层查看
▸ 课程库搜索：找还没加入任务的课程与专题，一键打开平台页面
▸ 自动学习辅助（可选，默认关闭）：在课程/专题页点击扩展图标开启，扩展在你本人已登录的
  页面内代为操作播放器——切普清、静音固定标签页、按小节顺序连续播放、进度实时显示；
  仅在本地运行，不修改平台数据，随时可停
▸ 多账号：同时管理多个平台账号，随时切换
▸ 日历导出：必修截止日生成 .ics，导入手机日历
▸ 数据备份：账号与学习记录导出 / 导入，换设备不丢历史

数据与隐私：

· 全部数据只保存在你自己的浏览器里（本机存储），不上传任何服务器
· 不收集浏览历史，不出售、不共享任何数据
· 扩展仅与你本人的学习平台通信，用于读取你账号的学习进度

说明：本扩展为非官方工具，与平台及其运营方无关联；
仅用于查看与管理本人账号的学习进度。自动学习辅助仅以你本人的登录会话在本地
驱动页面播放器，是否使用请自行评估并遵守平台用户协议。
```

### 分类
```
教育（Education）
```

### 语言
```
中文（简体）
```

### 截图（1280×800，按顺序上传 5 張，24-bit PNG 無 alpha）
```
1. docs/store/screenshots/1-home.png          — 学习首页：账单/统计/截止提醒/推荐
2. docs/store/screenshots/2-stats-heatmap.png — 学习热力图与统计
3. docs/store/screenshots/3-courses.png       — 课程页：封面卡片视图
4. docs/store/screenshots/4-search.png        — 课程库搜索结果
5. docs/store/screenshots/5-settings.png      — 设置 · 偏好（凭据同步/提示音/学习额度/备份）
（不上传 login*.png（含 login-download）与 settings-accounts.png / settings-activity.png —— 5 張上限用功能頁填滿；
  这几张只给 README 用）
> 文件名前缀即上传顺序；全部由 `npm run screenshots` 生成（配 SCREENSHOT_PROXY 取真实二维码），
> README 也直接引用这一份，不再另存副本。
```

### 小宣传图（440×280，24-bit RGB 無 alpha）
```
docs/store/promo/promo-small.png
```

### 大宣传图（1400×560，24-bit RGB 無 alpha）
```
docs/store/promo/promo-large.png
```

### 图标（128×128，24-bit RGB 無 alpha）
```
public/icon/128.png
```

---

## ② 隐私（Privacy）

### 单一用途描述（Single purpose）
```
查看并提醒本人在学习平台上的学习进度（学时、任务、截止时间）、导出相关统计；
以及可选的自动学习辅助——在你本人已登录的课程页内代为操作播放器（切普清、
静音固定标签、按小节连播），不修改平台数据。以上均仅限本人账号、本地运行。
```

### 权限理由（Permission justification）

**storage**
```
保存账号标识、会话令牌、偏好设置与学习统计缓存（全部仅本机）。
```

**alarms**
```
仅在登录令牌到期的那一刻唤醒一次后台，把工具栏图标刷新为「需重新登录」。
不涉及任何数据读取，不常驻运行，不弹授权提示。
```

**optional_host_permissions: https://mooc.ctt.cn/\***
```
读取你本人账号在该平台的学习进度与任务列表。声明为 optional：
安装时不授予，首次使用时由你点击「授权访问学习平台」主动授权。
扩展不向任何其它域名发请求（除平台域名外无网络请求）。
```

**content_scripts: https://mooc.ctt.cn/\***
```
仅在平台页面注入：课程/任务页读取进度并展示；课程播放页在你开启自动学习辅助后
代为操作页面内播放器（清晰度/静音/小节推进），使用你本人的登录会话，不修改平台数据。
```

### 权限理由中的同步说明
```
可选功能「凭据同步」使用 storage.sync，仅在用户主动开启后写入密码副本，
用于在其自己的多台设备间共享登录凭据；默认关闭，关闭即删除云端副本。
```

### 远程代码（Remote code）
```
否。全部脚本随扩展包分发，无 CDN 加载、无 eval、无远程代码。
```

### 数据使用（Data usage）逐项

| 表单问题 | 答案 | 理由（如需填写） |
|---|---|---|
| Does your item collect personal data? | Yes | 扩展需要账号凭据才能与平台通信 |
| Does your item collect personally identifiable information? | Yes | 平台用户名（手机号）与显示姓名，仅用于多账号切换与界面展示 |
| Does your item collect authentication info? | Yes | 用户名/密码/会话令牌，用于维持登录态；密码仅在用户勾选「记住凭据」时保存 |
| Does your item collect personal communications? | No | — |
| Does your item collect health information? | No | — |
| Does your item collect financial information? | No | — |
| Does your item collect user activity? | No | 不记录点击/滚动/键击等行为；学习任务与进度属于平台返回的课程数据 |
| Does your item collect website content? | Yes | 平台返回的课程名/学时/小节进度，仅用于展示与统计 |
| Do you use this data for any purpose other than the single purpose? | No | — |
| Do you transfer this data to any third party? | No | 无自有服务器、无分析/广告 SDK。可选「凭据同步」仅写入浏览器内置 storage.sync（由用户自己的浏览器账号承载），不传给我们或第三方服务 |
| Do you sell this data? | No | — |
| Do you use this data for creditworthiness? | No | — |

### 隐私政策 URL（已部署，可直接填入）
```
https://tobacco-mooc-privacy.app.workbuddy.host/?sharecode=KWERNS7TE4
```
> 源文件：`docs/store/privacy-policy.html`（单一来源）。公开托管页 `docs/privacy/index.html` 由
> `npm run privacy:sync` 从源文件生成，改完政策后先同步再重新发布，避免两份内容漂移。
> 该链接已实测可公开访问（200 + 渲染 <title>隐私政策</title>），不受仓库可见性影响
> （本仓库是 private，免费计划无法开 GitHub Pages —— 若之后改用 Pages/自有域名，
> 只需替换本行 URL，政策正文不用动）。
> 表单上传前请再打开一次确认非 404。

---

## ③ 分发（Distribution）

### 可见性
```
公开（Public）
```

### 定价
```
免费（Free）
```

### 地区
```
所有地区（或仅中国，根据你的用户群选择）
```

---

## ④ 打包（Package）

### 上传文件
```bash
STORE_BUILD=1 npm run build
# 产物: .output/chrome-mv3/
# 压缩: cd .output/chrome-mv3 && zip -r ../extension.zip .
```

### 版本号
```
2.11.3
```

---

## ⑤ 提交前检查清单

- [ ] `STORE_BUILD=1 npm run build` 后 manifest 仅含 `mooc.ctt.cn` + `storage` + `alarms`
- [x] 隐私政策页已部署并可公开访问（含「自动学习辅助」「凭据同步」说明段）
- [ ] 截图使用演示数据（无真实姓名/手机号/token）
- [ ] 自动学习辅助已在 简短描述/详细描述/单一用途/隐私政策 四处一致披露，无"刷课/挂机"等规避性表述
- [ ] 源码仓库链接已提供（开源，便于审核）
- [ ] 名称含平台字样属灰区（已评估）：描述/单一用途/隐私政策首屏均声明「非官方、与平台无关联」；
      若收到商标投诉，按「学习进度面板」中性名方案改名（备选名见 Issue #1 记录）
- [ ] 描述首行有"非官方"声明
- [ ] 版本号已更新
- [ ] zip 包体积 < 2MB

## 自动发布（CI/CD）

```bash
# 一次性设置:
# 1. Google Cloud Console → 启用 Chrome Web Store API → 创建 OAuth 客户端
# 2. 获取 refresh token → 存入 GitHub Secrets（CWS_EXTENSION_ID / CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN）
# 3. git tag v2.1.0 && git push --tags → 自动构建 + 上传 + 发布

# 手动触发: GitHub Actions → Publish → Run workflow → 勾选 publish=true
```

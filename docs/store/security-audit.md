# 扩展安全与合规自审报告

- 对象: 烟草网络学院学习助手 v2.9.0（ext @ d49353d, 商店版构建核验）
- 日期: 2026-11-07 · MV3 · WXT 0.20
- 结论: **Critical 0 / High 0 / Medium 3 / Low 2**，可安全上架

## Medium（均有披露与缓解，接受现状）

1. **明文密码镜像 chrome.storage.sync（opt-in）** — `src/lib/vault.ts:107-111`
   用户显式开启「凭据同步」后，勾选「记住凭据」的密码随浏览器账号同步。
   缓解: opt-in + 隐私政策第二章完整披露 + tokens 不参与同步 + 一键清除（含云端副本）。
   已评估并拒绝的加固: sync 侧 encField 加密 —— 平台协议密钥本身在包内，属混淆非安全，
   且会破坏已同步数据需迁移；浏览器同步通道自带 TLS 与账号隔离。
2. **本机密码明文存 chrome.storage.local** — `src/lib/vault.ts:8-10`
   扩展存储对网页脚本不可访问；UI 已提示「公共电脑请勿勾选」。
   可选加固（未实施）: WebCrypto 静态加密，同攻击面收益有限。
3. **捕获令牌明文暂存（mooc.capturedToken, chrome.storage.local）** — `src/entrypoints/mooc.content.ts` → `background.ts`
   官网页面内容脚本读取 localStorage['token'] 后经 runtime.sendMessage 暂存，等待登录页消费。
   缓解: 单次消费（读取即删除）、采用前经服务器校验（adopt-session 401 拒绝无效令牌），
   且在「清除本机数据」生命周期内（src/lib/vault.ts clearVault 一并删除）。
   已接受风险: 内容脚本信任页面脚本植入的任意 localStorage['token']（会话固定角落案例）——
   攻击者须已能控制官网页面本身，此时已有更大攻击面；记录为已接受风险。

## Low

- 开发版 host_permissions 含 `http://127.0.0.1/*`（E2E stub 用），商店版剥离（store-contract 强制）。
- devDependencies 链存在 critical/high 漏洞（vitest/wxt 工具链），商店产物 bundle 零残留（grep 复核）。

## 通过项

- CSP: MV3 默认，无 unsafe-inline/eval 声明
- XSS: 全库零 innerHTML/outerHTML/document.write/insertAdjacentHTML
- 远程代码: 零 importScripts/动态 .js 加载
- chrome.scripting.executeScript: 无 executeScript（importSession 已退役，改为 mooc.ctt.cn 内容脚本捕获令牌）
- 消息面: 仅 background 与自有内容脚本间的 runtime.onMessage（TOKEN_CAPTURE），无外部消息面（externally_connectable 未声明）
- HTTPS: 无明文 http:// API 调用
- 硬编码密钥: 无（crypto.ts KEY_HEX 为平台协议字段加密的平台自有密钥，协议仿真非凭据）
- web_accessible_resources: 未声明

## 与上架材料的映射

- 隐私政策 `docs/store/privacy-policy.html` 第二章已逐条披露凭据同步行为，与代码一致。
- CWS Privacy practices 表单: 权限申辩理由见仓库评审记录（storage/scripting/可选 host）。

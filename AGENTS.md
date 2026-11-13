# 烟草网络学院学习助手 · 项目规则

> 以下规则仅适用于 tobacco-mooc-study 项目，全局通用规则在 ~/.pi/agent/AGENTS.md

<!-- instabox-pentest:begin · 渗透测试算力/跳板机 -->
# instabox 渗透跳板机(算力担当)

本环境的渗透测试**计算资源由 instabox box `pentest` 承担**;当前主机(oracle-arm-1-sgp,ARM64)只作**控制面/操作台**。重活(扫描/爆破/fuzz/逆向/编译插桩)一律放到 box 上跑。

## 架构
- **控制面(本机)**: 编排、结果收集、报告。工具: `instabox` CLI / `ssh` / `rsync` / `tmux`。
- **算力面(box `pentest`)**: x86_64 Debian 13, 4 vCPU / 8 GiB, 16 GiB root + 20 GiB `/data`;出口 AWS us-west-2(IPv4 NAT, IPv6 独立 `/128`)。Docker、Go、Node、Rust、JDK 齐备。
- **跳板**: box 可作出站 SOCKS5 出口(隐藏本机);也可作 pivot 中转内网。

## 访问方式
```sh
ib sh                       # 交互 shell
ib run <cmd...>             # 同步执行(前台 exec 上限 600s)
ib bg <cmd...>              # 后台执行(长任务必须用这个, 无 exec 超时)
ib jobs | ib logs <id> -f   # 后台任务
ib push <local> [sub]       # rsync 推到 box:~/ops/scripts/
ib pull <remote> [dir]      # 从 box 拉回证据
ib proxy [port]             # box 作 SOCKS5 出口跳板(默认 1080)
ib snap --name N [...]      # 给 box 存快照
```
- `ib` = `/root/ops/ib`(也软链到 `~/.local/bin/ib`);`IB_BOX=<name>` 可切盒子。
- 等价原生:`instabox exec pentest -- '<cmd>'` / `ssh instabox-pentest` / `rsync -az --mkpath ...`。
- GUI(Termius 等): `instabox ssh-token pentest --ttl 30d` 输出的 `ibssh_...` 当**用户名**,地址 `ssh.instabox.sh:2222`,免密钥。

## box 上的能力(已装齐, 基线见当前 `pentest-toolkit-*` 快照)
- **渗透**: nmap / masscan / sqlmap / ffuf / gobuster / nuclei / httpx / subfinder / hydra / john / hashcat / nxc(netexec) / impacket / responder / bettercap / mitmproxy / nikto / wpscan。
- **后渗透**: Sliver / Metasploit / donpapi / BloodHound(certipy,kerbrute,evil-winrm,coercer,lsassy) / PEASS(linpeas,winPEAS) / pspy / ligolo-ng / frp / gost / chisel / iodine / sshuttle / proxychains4;Windows 二进制在 `~/tools/windows`。
- **逆向(REA)**: `rea analyze|decompile|function|inspect-*|execute-rizin-command ...`;引擎已配 **Ghidra 12.1.4 + JDK21 + JADX + frida + unblob + binwalk + rizin + wabt + wakaru + tshark + pwntools**。环境变量集中在 `/etc/profile.d/rea.sh`。
- **字典**: `~/wordlists/{rockyou.txt, SecLists}`。
- **AI agent**: `claude`(2.1.288) / `codex`(0.160.0) 已装但**未认证**(需 ANTHROPIC/OPENAI key;可用 `instabox secrets` 或 `--env`)。可用 `instabox agent prompt pentest "..."` 驱动。

## 关键路径(box)
- 工具: `~/tools/{linux,windows}` · `~/go/bin` · `~/.local/bin`
- REA: `~/.bun/bin/rea`;JADX JAR 在 `~/.local/share/rea/android/`
- 工作区: `~/ops/{scripts,loot,wordlists}` · 持久盘 `/data`

## 边界与注意(必须遵守)
- 只对**授权目标**使用;按上文"授权与边界"用 `dig/nslookup/host TXT` 验证。box 出站经 instabox 基础设施,**不是匿名网络**。
- **免费额度**: 1 台机 / 5 快照 / **100 GiB 出站/月**(扫描最耗——大范围扫描前必须限速/限端口) / 空闲 **30 分钟自动暂停**(不可改) / 单次运行 **8 小时上限**。
- 长任务一律 `ib bg`;前台 exec 最长 600s。
- box 是**易失资源**: **每次重要变更后立刻 `ib resnap`**(一键: 存带时间戳新快照 + 删旧基线, 永远只留最新一个), 不要手写 save/rm;环境损坏用 `instabox rm --yes pentest` + `instabox create --name pentest --snapshot <最新快照>` 重建。
- 快照含 `$HOME` 里的凭据(gh/claude/git/ssh),共享或长期保留前先清理。
- 不要用 box 做与当前授权目标无关的扫描、外传或持久化。
<!-- instabox-pentest:end -->

<!-- server-inventory:begin · 服务器资源清单 -->
# 服务器资源清单(全部为自有资产)

## 1. Oracle Cloud — 免费长期主力(5 台, tailnet 内网)
- 控制面/操作台(本机): `oracle-arm-1-sgp` · tailnet `100.67.14.24` · 公网出口 `213.35.110.13` · ARM64
- 被管节点(纯被管理, 已装保活脚本, 已开 Tailscale SSH):
  - `oracle-amd-1-sjc` · `100.71.61.17` · 出口 `192.9.147.226`
  - `oracle-amd-2-sjc` · `100.94.66.100` · 出口 `163.192.49.41`
  - `oracle-amd-3-sgp` · `100.85.196.103` · 出口 `168.107.69.227`
  - `oracle-amd-4-sgp` · `100.96.193.22` · 出口 `138.2.85.187`
- 其它: `desktop-s82lad1`(Windows, `100.71.215.22`, 常 offline)
- 4 台 AMD 保活: spiritLHLS/Oracle-server-keep-alive-script(CPU 40% + 内存 25% + 带宽 45min/次, systemd 管理)

## 2. DediOne VPS — 长期独立公网机(代理/出口)
- IP: `144.225.6.71` · Debian 12 · 1 核 / 949MiB / 30G
- 服务: sing-box(多端口) + nginx + docker(空)
- 定位: 固定公网操作入口/代理节点(fail2ban 脚本 `OPERATOR_IP`)
- 登录: `ssh -i ~/.ssh/win-pc root@144.225.6.71`

## 3. RackNerd VPS — 长期独立公网机(代理/出口)
- IP: `104.168.15.137` · IPv6 `2607:9d00:2000:3d::29ee:d04c` · 域名 `rn.gandli.eu.org`
- Debian 12 · 1 核 / 973MiB / 25G
- 服务: sing-box + nginx(v2ray-agent 部署)
- 登录: `ssh -i ~/.ssh/win-pc root@104.168.15.137`
- 现状: TCP 端口被 GFW 阻断, UDP(hysteria2 `39751` / TUIC `41014`)可用

## 4. instabox — 临时沙箱算力机(非长期, 见上文 instabox-pentest)
- x86_64 Debian 13 · 4 vCPU / 8 GiB · 出口 AWS us-west-2
- 额度: 100 GiB 出站/月 · 空闲 30min 暂停 · 易失(用完即弃)

## 定位一句话
- **Oracle(5台)** = 免费长期主力, tailnet 内网编排(控制面 + 被管节点)
- **DediOne + RackNerd** = 两台独立长期公网 VPS, 跑代理/出口
- **instabox** = 随用随启的一次性算力

## SSH 私钥约定(均在 `~/.ssh/`)
- `win-pc` → 5 台 Oracle + DediOne + RackNerd 全部受信(当前主力)
- `honghorn-education`(root@HongHorn-Education)→ 阿里云青岛 `zbsmartlink-mail`(118.190.146.193)
<!-- server-inventory:end -->

<!-- gost-proxy:begin · 出站 gost 代理（自有 DediOne + 阿里云青岛） -->
# gost 出站代理（渗透侦察用）

自有机队上的两层 SOCKS5 链，用于避免控制面直连国内 CDN 超时、统一出站视角。

## 拓扑

```
本机 --socks5--> DediOne(144.225.6.71:1080) --gost -F--> 阿里云青岛(118.190.146.193:8081) --> 目标
```

**纯 gost 两层链，无 SSH 隧道**。出口 = 青岛（China/Qingdao）。

## 凭据与地址

| 项 | 值 |
|---|---|
| 用户名 | **mindun2026** |
| 密码 | `a4a25e30b879e1d92fb01b65` |
| 入口（本机连这个） | `144.225.6.71:1080` |
| 第二跳（DediOne 连这个） | `118.190.146.193:8081` |
| 凭据文件 | 本机 `/tmp/gost.cred`、两台机器 `/root/gost.cred`，格式 `mindun2026:<pass>` |

## 用法

```sh
CRED=$(cat /tmp/gost.cred)
curl -sk --socks5-hostname "$CRED@144.225.6.71:1080" https://admin.pupumall.com/
```

## 服务端管理

```sh
# 青岛（第二跳）
pkill -9 -x gost
setsid nohup /tmp/gost -L "socks5://$(cat /root/gost.cred)@0.0.0.0:8081" \
  > /tmp/gost.log 2>&1 < /dev/null &

# DediOne（链式）
pkill -9 -x gost
setsid nohup /tmp/gost -L "socks5://$(cat /root/gost.cred)@0.0.0.0:1080" \
  -F "socks5://$(cat /root/gost.cred)@118.190.146.193:8081" \
  > /tmp/gost-chain.log 2>&1 < /dev/null &

# 查看
pgrep -ax gost; ss -ltn | grep -E '1080|8081'
```

## 端口选择依据（阿里云安全组实测）

对青岛做端口探测，用 **closed(RST)=安全组放行但无服务** vs **filtered(超时)=云防火墙丢弃** 区分：

| 状态 | 端口 | 含义 |
|---|---|---|
| open | 22, 80, 443, 3000, 8080, 8443 | 放行且有服务 |
| **closed（可用）** | **8081**, 8888, 9000, 9090, 3306 | **安全组放行，无监听 → 可自由占用** |
| filtered | 25,53,110,143,465,587,993,995,1080,3128,5000,6379,8000,9443,10000,11211,27017 | 云防火墙丢包 |

故第二跳选 **8081**（80/443 已被 nginx 占用，不可复用）。

## 安全约束（已生效）

- 两台均启用 SOCKS5 **认证**（mindun2026）；
- 青岛端 iptables 仅放行源 `144.225.6.71`（DediOne）访问 8081，其余 DROP；
- DediOne 端仅放行源 `213.35.110.13`（控制面）访问 1080，其余 DROP；
- 凭据文件权限 600。

## 重要边界：代理不解决可达性

目标方 IP 白名单是**具体企业 IP 清单**（非地域）。实测出口 `144.225.6.71`（美国）与
`118.190.146.193`（中国青岛）访问内部服务**均返回 `403 Your IP address is not allowed`**。
代理只解决直连超时、稳定性与脚本化，**不能绕过任何 ACL**。

## 清理

```sh
pkill -9 -x gost
rm -f /root/gost.cred /tmp/gost.cred /tmp/gost
```
<!-- gost-proxy:end -->

<!-- git-workflow:begin · 2026-11-05 用户明确要求 -->
# Git 工作流（强制）

## 本地联调（浏览器扩展调试）

- 调扩展/内容脚本/后台 SW 统一走 `npm run dev`（scripts/dev-chrome.sh 起独立 profile 的 Chrome + CDP 9223，
  自动加载 extension/，无构建步骤），AI agent 用 chrome-devtools MCP
  `--browserUrl=http://127.0.0.1:9223` 附着调试。完整流程与坑表见 **`docs/dev-debugging.md`**。
- MCP 没接上时用 `npm run cdp -- --target ext --expr "..."`（`scripts/cdp-eval.mjs`，附着 9223 执行 JS / 导航 / 截图）；环境预检可用 browser-extension-debug 技能的 `check-env.mjs --port 9223`。
- **content script 产物即源码**：`extension/content/mooc-content.js` 是 esbuild IIFE 产物，其原始 TS 源码（/tmp/build/src）未入库且已不可考 —— **决策：直接维护该产物**，改它时保持经典脚本风格（var/函数表达式，勿用 import/export），改完用 `node -e "new (require('vm').Script)(require('fs').readFileSync(...))"` 做语法校验，勿尝试重建源码树。
- `tests/e2e/login-wall.mjs` / `scripts/qr-probe.mjs` 是自带浏览器的兜底脚本，勿与 dev-chrome.sh 的 9223 实例混用。

- **所有改动经 PR 合入**：不直推长期分支（`main` / `cli` / `web` / `reverse-analysis`）。
  临时分支命名 `feat/*`、`fix/*`、`docs/*` → `git push -u origin <br>` → `gh pr create` → `gh pr merge`。
- **PR 检查失败时禁止合并**：`gh pr checks` 显示 fail 或 pending 时，必须修复后重推，
  确认 CI 全绿后才执行 `gh pr merge`。不允许跳过失败检查强行合并。
- **合并后立即清理分支**：本地 `git branch -D <br>` + 远端 `git push origin --delete <br>`。
  任何时刻远端只保留 `main` / `cli` / `web` / `reverse-analysis` 四个分支。
- 分支内容归属：`reverse-analysis` 的归档文档以 `reverse-analysis` 为 base 开 PR。
- **验证同步状态**用 `git ls-remote origin refs/heads/<br>` 取 SHA，再 `git show <SHA>:<file>` 看内容；
  不要相信本地 `origin/<br>` 追踪引用（可能过期，曾据此误报"未同步"）。
- 提交信息用中文，说明「做了什么 + 为什么」，修复类要写清纠正的错误结论。
<!-- git-workflow:end -->

<!-- login-safety:begin · 2026-11-06 事故教训 -->
# 平台登录安全铁律（强制）

事故：为排查 90106，用错误密码做"对照测试"+ 多次大小写不符的密码尝试，导致用户账号被平台锁定一天。

1. **禁止用错误凭据探测**：任何平台（不止本项目）的登录接口，不得提交故意错误的密码/验证码去做对照实验。
2. **失败一次即停**：登录失败后不得自动重试；确认密码来源（用户提供）后**只提交一次**，失败只回报错误码。
3. **本地闸门必须保留**：客户端登录前做 15 秒节流 + 连续 3 次失败锁定 30 分钟（见 `src/lib/loginGuard.ts` 口径），只增不减。
4. **自动重登失败即停**：令牌续期/自动重登失败一次即清除本地密码并停止自动重试。
5. **凭据持久化须显式同意**：默认不保存密码；用户勾选「记住凭据」才落 `chrome.storage.local`。
6. **自动化能力与商店版隔离**：含自动化执行的产物永不上架公开商店（`STORE_BUILD=1` 构建剔除）。
7. **令牌有效期按平台下发，不写死**：账密 / APP 扫码 / 微信扫码 / 官网导入的有效期各不相同，
   换发窗口按令牌的 `expires_in` 算（`src/lib/vault.ts: renewWithinMs`，20%、封顶 7 天）。
   官网导入的令牌没有 `expires_in`（平台自己存 token 时会删掉），交给接口 401 兜底，不要预判过期。
<!-- login-safety:end -->


# InstaBox 部署指引

「可完整续用的全功能 Linux 虚拟机」天然满足本工具的三个需求：
token 持久化（本地文件 30 天有效）、cron 定时、低频访问。

## 合规自查（部署前）

InstaBox 条款对照：

| 条款 | 结论 |
|---|---|
| 禁止挖矿 / 扫描攻击 | ✅ 不涉及 |
| 禁止使用非本人凭证 | ✅ 刷的是本人账号 |
| 禁止违反网站条款的爬取 | ⚠️ 唯一灰区：自动化操作**本人账号**。缓解：每天最多 2 次、配额熔断、不碰他人数据。建议自查平台用户协议 |

## 方式 A：原生 venv + cron（推荐，最简）

```bash
# 1. 代码上机
git clone git@github.com:gandli/mooc_auto_study.git /opt/mooc
cd /opt/mooc
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p logs

# 2. 账密（TUI 写入或手动编辑, 不入库）
cp .env.example .env && vim .env        # 填 MOOC_LOGIN / MOOC_PASS

# 3. 首次登录验证
.venv/bin/python mooc_api_login.py

# 4. dry-run 体检 (只读, 观察平台反应, 建议先跑几天)
.venv/bin/python mooc_auto_study.py --todo --dry-run --no-ws

# 5. 安排定时
cp deploy/crontab.example /tmp/cron && crontab /tmp/cron
```

## 方式 B：Docker

```bash
cd /opt/mooc
docker build -t mooc-auto -f deploy/Dockerfile .
docker run --rm --env-file .env mooc-auto
# 定时: crontab 里换成 docker run 那行
```

## 观察要点（首周）

- 登录是否顺畅（判断 InstaBox 出口 IP 是否触发平台风控）
- 学时是否正常入账（看 TUI 顶栏或 `--list`）
- 是否出现验证码/异常登录提示 → 出现则停用

## 运行纪律

- 每天最多 2 次（crontab 示例即是）
- 配额熔断已内置：学时满 / 上报无进展自动停
- 账号或密码变更后重跑 `mooc_api_login.py`

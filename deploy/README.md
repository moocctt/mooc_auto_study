# 部署：定时自动学习

三件事需要持久化：token（30 天有效）、定时任务、日志。以下两种方式任选。

## 方式 A：原生 venv + cron（最简）

```bash
git clone <repo> /opt/mooc && cd /opt/mooc
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && vi .env           # 填 MOOC_USER / MOOC_PWD
mkdir -p logs
crontab -e                                 # 粘贴 deploy/crontab.example 内容
```

`.env` 也可以不放仓库目录：`TOBACCO_ENV_FILE=/etc/mooc.env` 或
`TOBACCO_HOME=/var/lib/mooc`（token 与额度记账也跟随该目录）。

## 方式 B：Docker

```bash
docker build -f deploy/Dockerfile -t mooc-study .
docker run --rm --env-file .env mooc-study
```

或用 cron 触发同样的 `docker run`。容器内没有持久化，token 每次重建
（30 天内复用需要挂卷：`-v $PWD/data:/app/data`）。

## 合规自查

自动化操作的是**本人账号**，每天最多两次、有配额熔断、不触碰他人数据；
上机前请自行核对平台用户协议对自动化的约定。

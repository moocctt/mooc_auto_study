# 部署

两套方式，镜像与配置完全一致。

## 前置

- 应用镜像：仓库根 Dockerfile（多阶段：client 构建 → server 构建 → 精简运行镜像，启动时 `prisma db push` 建表）
- 密钥：
  - `POSTGRES_PASSWORD` 数据库口令（自定强口令）
  - `PLATFORM_ENC_KEY` 32 字节 hex（`openssl rand -hex 32`），用于加密库里的平台密码；**一经设定不可更改**，否则旧密文解不开
- 拓扑：nginx:80 → app:8080（Express，静态 + API）→ db:5432（PostgreSQL 16，卷 `db-data` 持久化）

## 方式一：docker compose

```bash
cp .env.example .env   # 填 POSTGRES_PASSWORD 与 PLATFORM_ENC_KEY
docker compose up -d --build
# 访问 http://<主机>/
```

## 方式二：WSL 容器（wslc 3.0+，无 Docker Desktop）

wslc 是 WSL 自带的容器 CLI（`C:\Program Files\WSL\wslc.exe`），与 docker 命令同形；没有 compose，按下面顺序起三只容器：

```powershell
# 1. 构建应用镜像（在仓库根）
wslc build -t tobacco-mooc-web:latest .

# 2. 网络与数据卷
wslc network create webnet
wslc volume create db-data

# 3. 数据库（命名 db，app 的 DATABASE_URL 按主机名 db 连接）
wslc run -d --name db --restart always --network webnet --network-alias db `
  -v db-data:/var/lib/postgresql/data `
  -e POSTGRES_DB=mooc -e POSTGRES_USER=mooc -e POSTGRES_PASSWORD=<强口令> `
  --health-cmd "pg_isready -U mooc -d mooc" --health-interval 5s --health-retries 10 `
  postgres:16-alpine

# 4. 应用（命名 app，nginx 的 upstream 按主机名 app 转发）
wslc run -d --name app --restart always --network webnet --network-alias app `
  -e "DATABASE_URL=postgres://mooc:<强口令>@db:5432/mooc" `
  -e PLATFORM_ENC_KEY=<32字节hex> -e PORT=8080 `
  --health-cmd "node -e \"fetch('http://localhost:8080/api/auth/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"" `
  --health-interval 10s --health-retries 12 --health-start-period 30s `
  tobacco-mooc-web:latest

# 5. 反代（挂完整主配置 nginx/nginx.conf；发布到宿主 80 端口）
wslc run -d --name nginx --restart always --network webnet `
  -p 80:80 `
  -v "<仓库绝对路径>\nginx\nginx.conf:/etc/nginx/nginx.conf:ro" `
  nginx:alpine
```

### wslc 与 docker compose 的差异（踩过的坑）

| 差异 | 说明 |
| :-- | :-- |
| restart 策略 | 只支持 `no` / `always`，**不支持 `unless-stopped`** |
| 无 compose | 三只容器手工编排；容器名/别名（db、app）即服务发现，与 compose 里的 hostname 对齐 |
| nginx 挂载 | 必须挂**完整主配置**（nginx/nginx.conf → /etc/nginx/nginx.conf）；挂 server 块到 conf.d/default.conf 时 `map` 指令报 "not allowed here" |
| 端口发布 | `-p 80:80` 实际发布到 `127.0.0.1:80`（本机访问）；对外暴露需在宿主再架一层（TLS 终结推荐在这一层做） |

## 验证

```bash
curl -s http://localhost/api/auth/me            # {"message":"未登录","code":"AUTH"} 401 → 反代通
# 浏览器注册账号 → 绑定平台账号 → 总览出双轨学时即为全链路就绪
```

## 运维

```bash
wslc list                     # 三只容器应全部 Up（app/db 带 healthy）
wslc logs app                 # 应用日志（启动可见 prisma db push 结果）
wslc restart app              # 改代码后重新 build + rm -f app + 按上面第 4 步重建
wslc volume rm db-data        # 危险：清库（用户、绑定、运行历史全丢）
```

# 烟草网络学院 · 学习助手（web 版）

多用户 Web 版：注册站点账号 → 绑定烟草网络学院账号 → 学习任务自动跑。
功能上对齐 [extension 分支](../../extension)，对齐清单见
[docs/ALIGNMENT.md](./docs/ALIGNMENT.md)。

## 技术栈

| 层 | 选型 |
| :-- | :-- |
| 前端 | Vite + React 18 + TypeScript + React Router + TanStack Query + Ant Design |
| 后端 | Node.js + Express 4 + Prisma |
| 数据库 | 开发 SQLite / 生产 PostgreSQL（双 schema，字段一致） |
| 认证 | Lucia 式自管会话：httpOnly cookie + sessions 表，scrypt 密码哈希 |
| 部署 | Docker Compose（app + PostgreSQL + Nginx 反代） |

平台凭据（学院账号密码）AES-256-GCM 加密落库，密钥来自 `PLATFORM_ENC_KEY`；
学院 access_token 只驻留服务端内存，不落盘。

## 本地开发

要求 Node ≥ 20。

```bash
npm install                     # workspaces: server + client
npm run dev:db                  # prisma generate + db push（SQLite）
npm run dev                     # tsx server(:8080) + vite(:5173)
```

用 bun 也一样（脚本已兼容）：`bun install` → `bun dev:db` → `bun dev`。

打开 http://localhost:5173 → 注册 → 「绑定平台账号」→ 任务页点「开始全部」。

- **学时账单**：网络自学 / 集中培训两根轨道分开看，缺多少一目了然（网课只能补前一根）
- **学习任务**：点「学」单门刷，或「开始全部」跑完所有未完成任务
- **临近截止**：必修任务剩 7 天内的按紧迫度排序
- **学习热力图**：26 周学时分布，GitHub 贡献图风格
- **课程库**：12 类内容检索，封面 / 列表两种视图，已加入任务的会打标

## 目录

```text
.
├── server/
│   ├── prisma/             # schema.prisma（postgres）· schema.dev.prisma（sqlite）
│   └── src/
│       ├── auth/           # 注册/登录/会话（scrypt + httpOnly cookie）
│       ├── platform/       # 平台客户端：AES-ECB 加密、app-login、接口封装、12 类课程库
│       ├── engine/         # 学时引擎（与插件版同一套逻辑）+ 运行器
│       ├── routes/api.ts   # /api/hours /tasks /heatmap /library /engine/*
│       └── app.ts          # Express 入口，生产环境托管 client/dist
├── client/
│   └── src/pages/          # Login / Dashboard / Tasks / Library（React + AntD）
├── nginx/nginx.conf        # 生产反代配置
├── docker-compose.yml      # postgres + app + nginx
├── docs/ALIGNMENT.md       # 与 extension 分支的功能对齐清单
└── docs/API-NOTES.md       # 平台接口考古证据
```

## 生产部署

```bash
cp .env.example .env            # 填 POSTGRES_PASSWORD 和 PLATFORM_ENC_KEY（openssl rand -hex 32）
docker compose up -d --build    # nginx:80 → app:8080 → postgres
```

## 节奏

| 参数 | 值 |
| :-- | :-- |
| 单轮上报 | ≤90s（平台硬上限，实测 ≥120s 被静默丢弃） |
| `createTime` 回填 | 上报秒数 + 60–300s |
| 轮间等待 | 0.6–1.6s |
| 课程之间 | 1.5–3s |

## 边界

- 登录失败一次即停，不自动重试（平台按错误次数锁定账号 24 小时）
- 每日学时上限 24 小时，到顶引擎自动判定配额耗尽并停下
- 单课程累计 5 个小节未完成即中止，避免空转
- 考试、问卷、评估需要真实作答，自动跳过
- 无人值守（驱动真实播放器）在 web 版不适用，由 extension 分支承担

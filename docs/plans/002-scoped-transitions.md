# 002 — 裸 transition（全属性）改为 scoped

- **Status**: DONE
- **Commit**: 2297b2c
- **Severity**: MEDIUM
- **Category**: 性能
- **Estimated scope**: 4 文件，6 处，每处一行

## Problem

裸 `transition`（等价 transition: all）让 hover 时 padding/border-radius 等布局属性一并插值。
命中频率最高的界面（任务行、课程卡、筛选分段）。

- `src/components/TaskRow.tsx:13`：`... bg-paper p-3 transition hover:border-brand-mid hover:bg-[#fbfdfc]`
- `src/components/CourseCard.tsx:20`：`... bg-paper transition hover:border-brand-mid`
- `src/components/CourseCard.tsx:25`：`... object-cover transition group-hover:scale-[1.03]`（需要 transform）
- `src/components/Accounts.tsx:49`：`... border-dashed ... transition hover:border-brand`
- `src/components/Tasks.tsx:55`：筛选分段按钮
- `src/components/Tasks.tsx:71`：视图切换按钮

## Target

- 颜色/边框类：`transition-colors duration-[var(--motion-fast)]`（等价 120ms）。
- CourseCard 封面：`transition-transform duration-[var(--motion-base)]`（仅 transform）。

## Repo conventions to follow

- 全站已有 `transition-colors` 先例：`src/components/Login.tsx:82`、`src/components/Settings.tsx:21`。
- 令牌：`src/entrypoints/console/style.css` `--motion-fast: 120ms`。

## Steps

1. TaskRow.tsx:13 — `transition` → `transition-colors duration-[var(--motion-fast)]`。
2. CourseCard.tsx:20 — `transition` → `transition-colors duration-[var(--motion-fast)]`。
3. CourseCard.tsx:25 — `transition` → `transition-transform duration-[var(--motion-base)]`。
4. Accounts.tsx:49 — 同 1。
5. Tasks.tsx:55、71 — 同 1。

## Boundaries

- 只改 transition 类名，不动 hover 的目标样式。
- 全仓 grep `className=.*"[^"]*\btransition\b[^-]` 兜底，发现同类一并处理（Sidebar 宽度过渡是
  `transition-[width]`，不受影响）。

## Verification

- **Mechanical**: `npx tsc --noEmit` 0；`npm run build` 成功。
- **Feel check**: hover 任务行/课程卡：只有底色与边框在变，无 padding/圆角跳动；
  课程卡封面缩放仍平滑。
- **Done when**: 全仓无裸 `transition`（`transition-[width]`/`transition-colors` 等带限定的不算）。

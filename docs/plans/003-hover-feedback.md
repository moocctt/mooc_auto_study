# 003 — 可检视元素的悬停反馈体系

- **Status**: DONE
- **Commit**: 2297b2c
- **Severity**: MEDIUM
- **Category**: 错过的机会（用户点名）
- **Estimated scope**: 4 文件，~10 行

## Problem

热力图格子、月度柱形图、构成明细行、运行 chip、推荐行——这些「可检视」元素悬停无任何响应。
产品约定（DESIGN.md）：hover = 可检视（inspectable），120ms。

## Target

统一 hover 语言（120ms、只动 transform/opacity/颜色）：
- 热力图格子：`hover:scale-[1.15] hover:ring-brand relative cursor-help transition-transform duration-[var(--motion-fast)]`
- 柱形图 `<i>`：`transition-[opacity,filter] hover:opacity-100 cursor-help`（默认 opacity-85）
- 构成明细行：`rounded px-2 -mx-2 transition-colors duration-[var(--motion-fast)] hover:bg-page/60`
- 运行 chip（ui.tsx RunChip）：`transition-colors hover:border-brand-mid`
- 推荐行：`transition-colors hover:bg-page/60 rounded`（行内已有 divide，改用行内 hover 底色）

## Repo conventions to follow

- 行内 hover 底色先例：`src/components/TaskRow.tsx:13` `hover:bg-[#fbfdfc]`。
- cursor 语义：可检视但不可点的元素用 `cursor-default`，不假装可点。

## Steps

1. `src/components/Heatmap.tsx` 格子 span：加 hover 类（见上）。
2. `src/components/Home.tsx` 柱形图 `<i>`：加 `transition-[height,opacity] duration-[var(--motion-fast)]`（height 过渡保留——数据变化时平滑）、`hover:opacity-100 cursor-default`。
3. `src/components/Home.tsx` 构成明细行 div：加 `rounded transition-colors duration-[var(--motion-fast)] hover:bg-page/60 px-2 -mx-2`。
4. `src/components/ui.tsx` RunChip：加 `transition-colors duration-[var(--motion-fast)] hover:border-brand-mid`。
5. `src/components/Recommended.tsx` 两个行容器：加 `rounded transition-colors duration-[var(--motion-fast)] hover:bg-page/60`。

## Boundaries

- 不给状态 Pill（学习中/已完成）加 hover——它们不是可检视数据点。
- 不动已完成行的透明度（对比度规则）。

## Verification

- **Mechanical**: `npx tsc --noEmit` 0；`npm run build` 成功。
- **Feel check**: 热力图上扫过：格子放大但不推挤邻居（transform 只影响自身）；
  构成明细行悬停有浅底色且文字不横移（-mx-2 补偿）。
- **Done when**: 五类元素悬停均有 120ms 响应。

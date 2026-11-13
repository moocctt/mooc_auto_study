# 004 — 侧栏折叠的文本过渡 + 令牌统一

- **Status**: DONE
- **Commit**: 2297b2c
- **Severity**: MEDIUM
- **Category**: 一致性/打断
- **Estimated scope**: 1 文件，~8 行

## Problem

`src/components/Shell.tsx:26` 侧栏折叠：宽度 200ms 过渡（硬编码 duration-200，未用令牌），
但文字/账号区瞬间卸载——文本闪没。

## Target

方案 A（推荐，简单可靠）：宽度过渡保留但换令牌 `duration-[var(--motion-base)]`；
文字卸载前先淡出——给侧栏内容容器加
`transition-opacity duration-[var(--motion-fast)]` 并在折叠瞬间对文本元素挂 `opacity-0`
（用 `data-collapsing` 属性 + 120ms 后再置 collapsed）。若实现成本高，退方案 B：
宽度瞬切（去掉 width 过渡），文字卸载就不突兀。

两方案都必须：`duration-200` → 令牌。

## Repo conventions to follow

- 令牌：`src/entrypoints/console/style.css` `--motion-fast/base/slow`。

## Steps

1. `src/components/Shell.tsx:26` — `duration-200` → `duration-[var(--motion-base)]`。
2. 方案 B（若 A 需要状态机则不做）：移除宽度过渡类，折叠/展开瞬切。

## Boundaries

- 不动折叠后的图标布局与账号区结构。

## Verification

- **Mechanical**: `npx tsc --noEmit` 0。
- **Feel check**: 快速连点折叠/展开不卡顿；折叠过程文字消失方式不突兀（fade 或瞬切，二选一后固定）。
- **Done when**: `duration-200` 从侧栏消失，令牌统一。

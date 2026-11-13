# 001 — 浮层退出动画（抽屉/日志/弹窗关闭不再瞬断）

- **Status**: DONE
- **Commit**: 2297b2c
- **Severity**: HIGH
- **Category**: 物理性/一致性
- **Estimated scope**: 2 文件（src/components/Overlay.tsx、src/components/ui.tsx），~40 行

## Problem

所有右侧浮层与弹窗关闭时瞬间卸载。进入有 200ms 滑入，退出 0ms，前后不对称。
每一处引用：`src/components/Overlay.tsx:24`（`if (!open) return null;`）；
`src/components/ui.tsx` ModalHost 同样模式。

## Target

关闭时先播 240ms 退出动画（面板 `translateX(16px)` + 整体 opacity 0，缓动 `var(--ease-out)`），
`animationend`/超时后再真卸载。退出时长可以比进入略短（240ms）。

## Repo conventions to follow

- 动效令牌在 `src/entrypoints/console/style.css:82-85`：`--motion-base: 200ms; --motion-slow: 320ms; --ease-out: cubic-bezier(0.2,0,0,1)`。
- 既有入场动画类：`src/entrypoints/console/style.css` 的 `.anim-slide-in / .anim-fade-in`——退出类照此命名 `.anim-slide-out`。
- 只动 transform/opacity。

## Steps

1. `src/entrypoints/console/style.css`：新增
   `@keyframes slide-out-right { from { transform: none; opacity: 1; } to { transform: translateX(16px); opacity: 0; } }`
   与 `.anim-slide-out { animation: slide-out-right 240ms var(--ease-out) both; }`、
   `.anim-fade-out { animation: fade-in 160ms var(--ease-out) reverse both; }`。
2. `src/components/Overlay.tsx`：加 `closing` 内部状态。`onClose` 被调用（Esc/遮罩/关闭按钮）时不立即 `onClose()`，
   先置 `closing=true`，320ms 超时后调用 `onClose()`；面板 className 加
   `${closing ? 'anim-slide-out' : 'anim-slide-in'}`，遮罩 `${closing ? 'anim-fade-out' : 'anim-fade-in'}`。
   注意：`useEffect` 的焦点归还在真卸载（onClose 后的 cleanup）发生即可，现状已满足。
3. `src/components/ui.tsx` ModalHost：同法加 `closing` 状态（关闭按钮/遮罩/Esc 均走 `requestClose()`，
   内部先播退出再 `closeModal()`）。
4. `src/components/LogOverlay.tsx`：头部关闭按钮把 `closeLog` 替换为 Overlay 的 onClose 通道（Overlay 已接收 onClose，
   无需改动——确认 LogOverlay 内部没有绕过 onClose 直接调 closeLog 的调用，若有改为透传）。

## Boundaries

- 不要动 Login 页（无浮层）。
- 不要改 Drawer/LogOverlay 的业务内容结构。
- 不引入依赖；不加 exit 时长超过 320ms。

## Verification

- **Mechanical**: `npx tsc --noEmit` 0 错误；`npm run build` 成功；`npm test` 全过。
- **Feel check**: 打开小节抽屉 → Esc 关闭：面板向右滑出 240ms 后消失，不是瞬断；
  Esc 连按两次不报错、不卡住；关闭后焦点回到触发按钮。
- **Done when**: 所有三处浮层（小节抽屉/运行日志/通用弹窗）关闭均有退出动画。

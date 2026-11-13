#!/usr/bin/env sh
# 原生版调试启动器（替代 wxt dev）: 起独立 profile 的 Chrome, 开 CDP 9223。
# 注意: Chrome 137+ 已移除 --load-extension, 扩展不随本脚本加载 —— 起来后跑 `npm run dev:ready`
# （走浏览器级 CDP Extensions.loadUnpacked）。e2e、cdp-eval、mcp-verify 都连这个实例。
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$DIR/.chrome-debug-profile"
PORT="${CDP_PORT:-9223}"
mkdir -p "$PROFILE"
CHROME="${CHROME_BIN:-google-chrome}"
command -v "$CHROME" >/dev/null 2>&1 || CHROME=chromium
# --enable-unsafe-extension-debugging: Extensions CDP 域（loadUnpacked）的前置开关
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --enable-unsafe-extension-debugging \
  "$@"

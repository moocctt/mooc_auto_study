#!/usr/bin/env bash
# 自动生成商店截图（?demo=1 演示数据渲染，不含真实账号信息）
# 产出: docs/store/screenshots/*.png (1280×800, 24-bit RGB 無 alpha)
#      1-home / 2-stats-heatmap / 3-courses / 4-search / 5-settings 为商店上传顺序;
#      settings-accounts.png / settings-activity.png / login.png / login-wechat.png 只给 README
# 用法: bash tests/screenshots.sh                      # 直连（登录页二维码会停在加载态）
#       SCREENSHOT_PROXY=socks5://127.0.0.1:1087 bash tests/screenshots.sh   # 走代理取真实二维码
set -u
cd "$(dirname "$0")/../.."
if [[ -z "${DISPLAY:-}" && "${INSIDE_XVFB:-}" != "1" ]]; then INSIDE_XVFB=1 exec xvfb-run -a "$0" "$@"; fi

OUT=docs/store/screenshots
EXT_ID=$(cat .ext-id 2>/dev/null || echo "")
mkdir -p "$OUT"

PROXY_ARGS=()
if [[ -n "${SCREENSHOT_PROXY:-}" ]]; then PROXY_ARGS=(--proxy "$SCREENSHOT_PROXY"); fi

agent-browser close --all >/dev/null 2>&1

agent-browser "${PROXY_ARGS[@]}" --extension extension --executable-path /usr/bin/chromium \
  open "chrome-extension://$EXT_ID/console.html?demo=1" >/dev/null 2>&1

# 等待渲染完成
for i in $(seq 1 40); do
  h=$(agent-browser eval "document.querySelector('h1')?.textContent||''" 2>/dev/null)
  [[ "$h" == *学习* ]] && break
  sleep 0.25
done
agent-browser set viewport 1280 800 >/dev/null 2>&1 || true
sleep 0.5

# 守卫: 页面没起来就失败（常见原因: 上次构建是 STORE 版, 扩展 ID 与 .ext-id 不符 → 空白页）
if ! agent-browser eval "document.body.innerText.includes('学习') || document.body.innerText.includes('账号登录')" 2>/dev/null | grep -q true; then
  echo "✗ 控制台页面未加载（检查调试 Chrome 是否已用 scripts/dev-chrome.sh 加载 extension/）" >&2
  agent-browser close --all >/dev/null 2>&1
  exit 1
fi

# ── 截图 1: 学习首页（顶部：账单+统计卡+截止提醒+推荐）──
agent-browser eval "window.scrollTo(0,0); 1" >/dev/null; sleep 0.4
agent-browser screenshot "$OUT/1-home.png" >/dev/null 2>&1

# ── 截图 2: 热力图 + 学习统计 ──
agent-browser eval "(() => { const el=document.querySelector('[data-testid=heatmap]'); el?.scrollIntoView({block:'start'}); return 1; })()" >/dev/null
sleep 0.5
agent-browser screenshot "$OUT/2-stats-heatmap.png" >/dev/null 2>&1

# ── 课程页（封面卡片视图）────────────────────────────────────────
agent-browser eval "(() => { [...document.querySelectorAll('nav a')].find(a=>a.getAttribute('href').includes('tasks'))?.click(); return 1; })()" >/dev/null
sleep 0.8
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('封面')); b?.click(); return 1; })()" >/dev/null
sleep 0.6
agent-browser eval "window.scrollTo(0,0); 1" >/dev/null; sleep 0.3
agent-browser screenshot "$OUT/3-courses.png" >/dev/null 2>&1

# ── 课程库搜索（结果页）────────────────────────────────────────
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='课程库'); b?.click(); return 1; })()" >/dev/null
sleep 0.6
agent-browser eval "(() => { const i=document.querySelector('input[placeholder*=搜索课程]'); if(!i) return 1; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.bind(i); s('安全'); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1; })()" >/dev/null
sleep 1.2
agent-browser eval "window.scrollTo(0,0); 1" >/dev/null; sleep 0.3
agent-browser screenshot "$OUT/4-search.png" >/dev/null 2>&1

# ── 设置: 三个子标签各一张（账号 / 偏好 → 商店第 5 张 / 运行 → README）──────
agent-browser eval "(() => { [...document.querySelectorAll('nav a')].find(a=>a.getAttribute('href').includes('settings'))?.click(); return 1; })()" >/dev/null
sleep 0.6
tab_settings() { agent-browser eval "(() => { const b=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()==='$1'); b?.click(); return 1; })()" >/dev/null; sleep 0.6; }

tab_settings '账号'
agent-browser screenshot "$OUT/settings-accounts.png" >/dev/null 2>&1

tab_settings '偏好'
agent-browser screenshot "$OUT/5-settings.png" >/dev/null 2>&1

# 「运行」需要完整功能解锁: 回概览页对页脚小点连点 5 次（开发版才有的手势）
agent-browser eval "(() => { [...document.querySelectorAll('nav a')].find(a=>a.getAttribute('href')==='#/report')?.click(); return 1; })()" >/dev/null
sleep 0.6
agent-browser eval "(() => { const dot=document.querySelector('[data-testid=unlock-dot]'); if(!dot) return 0; for (let i=0;i<5;i++) dot.click(); return 1; })()" >/dev/null
sleep 0.5
agent-browser eval "(() => { [...document.querySelectorAll('nav a')].find(a=>a.getAttribute('href').includes('settings'))?.click(); return 1; })()" >/dev/null
sleep 0.6
tab_settings '运行'
agent-browser screenshot "$OUT/settings-activity.png" >/dev/null 2>&1

# ── 登录页: 两种扫码通道各一张（配了代理时等真实二维码到位再拍）──────
agent-browser open "chrome-extension://$EXT_ID/console.html" >/dev/null 2>&1
for i in $(seq 1 40); do h=$(agent-browser eval "document.querySelector('h2')?.textContent||''" 2>/dev/null); [[ "$h" == *登录* ]] && break; sleep 0.25; done

# 等某个二维码渲染出来（sel 传选择器; 没配代理时直接返回）
wait_qr() {
  local sel=$1
  [[ -n "${SCREENSHOT_PROXY:-}" ]] || return 0
  local got=""
  for i in $(seq 1 50); do
    got=$(agent-browser eval "!!document.querySelector('$sel')" 2>/dev/null)
    [[ "$got" == "true" ]] && return 0
    sleep 0.5
  done
  echo "⚠ 未取到二维码（$sel）, 仍按当前状态截图（检查代理是否可用）" >&2
}

wait_qr "img[alt*=二维码]"; sleep 0.6
agent-browser screenshot "$OUT/login.png" >/dev/null 2>&1

# 下载 APP 弹窗（右下折角）
agent-browser eval "(() => { const b=[...document.querySelectorAll('[aria-label]')].find(x=>(x.getAttribute('aria-label')||'').includes('下载')); b?.click(); return 1; })()" >/dev/null
sleep 0.9
agent-browser screenshot "$OUT/login-download.png" >/dev/null 2>&1
agent-browser eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1" >/dev/null; sleep 0.4

# 微信扫码通道（入口是卡片右上角折角, 按 aria-label 点）
agent-browser eval "(() => { const b=[...document.querySelectorAll('[aria-label]')].find(x=>(x.getAttribute('aria-label')||'').includes('微信扫码登录')); b?.click(); return 1; })()" >/dev/null
sleep 0.8
wait_qr "img[src*=gif]"; sleep 0.6
agent-browser screenshot "$OUT/login-wechat.png" >/dev/null 2>&1

agent-browser close --all >/dev/null 2>&1

# 校验: 每张必须互不相同（全同 = 截到了空白页）
total=$(ls "$OUT"/*.png | wc -l)
uniq=$(md5sum "$OUT"/*.png | awk '{print $1}' | sort -u | wc -l)
if [[ "$uniq" -lt "$total" ]]; then
  echo "✗ 截图内容重复（$uniq/$total 唯一），可能截到了空白页" >&2
  exit 1
fi
echo "✓ 截图已更新: $total 张 → $OUT/（商店上传 1-5, 其余 README）"

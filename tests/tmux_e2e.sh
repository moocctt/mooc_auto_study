#!/usr/bin/env bash
# TUI 真终端 E2E：tmux 起真 TUI，send-keys 真按键，capture-pane 抓真渲染做断言。
# 用法: bash tests/tmux_e2e.sh    (仓库根目录执行; 离线假数据, 不碰真实账号)
set -u
cd "$(dirname "$0")/.."

SESS=tui-e2e
tmux kill-session -t "$SESS" 2>/dev/null
tmux new-session -d -s "$SESS" "python3 tests/fake_tui_app.py"
tmux set-window-option -t "$SESS" window-size manual
tmux resize-window -t "$SESS" -x 120 -y 40
PANE=$(tmux display-message -p -t "$SESS" '#{pane_id}')   # base-index 可能非 0, 动态取
PASS=0; FAIL=0

start=$(date +%s)
say() { printf '%-4s %-22s %s\n' "$1" "$2" "$3"; }

wait_for() {  # wait_for <text> <timeout秒> — 等文本出现在屏幕上
    local text=$1 t=${2:-10} i=0
    while (( i < t * 10 )); do
        tmux capture-pane -p -t "$PANE" 2>/dev/null | grep -qF "$text" && return 0
        sleep 0.1; ((i++))
    done
    return 1
}

check() {  # check <标签> <期望文本或 '-'>
    local label=$1 expect=${2:--}
    local frame; frame=$(tmux capture-pane -p -t "$PANE" 2>/dev/null)
    if [[ "$expect" == "-" || "$frame" == *"$expect"* ]]; then
        say PASS "$label" "${expect:+匹配到: $expect}"; ((PASS++))
    else
        say FAIL "$label" "屏幕上没有: $expect"; ((FAIL++))
        echo "$frame" | sed 's/^/    │ /' | tail -20
    fi
}

gone() {  # 断言文本已从屏幕消失
    local label=$1 text=$2
    if ! tmux capture-pane -p -t "$PANE" 2>/dev/null | grep -qF "$text"; then
        say PASS "$label" "已消失: $text"; ((PASS++))
    else
        say FAIL "$label" "仍在屏幕: $text"; ((FAIL++))
    fi
}

key() { tmux send-keys -t "$PANE" "$@"; sleep 0.6; }

if wait_for "必修-学习中" 15; then
    sleep 1   # 等首轮 repaint 稳定, 避免抓到中间帧
    say PASS "启动" "默认列表渲染完成"; ((PASS++))
else
    say FAIL "启动" "15 秒内列表未出现"; tmux kill-session -t "$SESS"; exit 1
fi
check "默认隐藏已完成" "必修-学习中" 
gone "默认隐藏已完成(无已完成行)" "选修-已完成"
check "学时卡片" "网络自学"
check "页脚快捷键" "学习选中"

# ── x 已完成显示/隐藏 ───────────────────────────────────────────
key x
check "x 显示已完成" "选修-已完成"
key x
gone "x 再按恢复隐藏" "选修-已完成"

# ── o 排序循环 ──────────────────────────────────────────────────
key o
check "o 排序通知" "排序: 必修优先"

# ── / 搜索 + Esc 清除 ──────────────────────────────────────────
key /
check "/ 搜索框出现" "搜索任务"
key 必修 Enter
check "/ 筛选生效" "筛选: 必修"
gone "/ 筛选后无资格考试" "资格考试"
key /          # 重新打开输入框(带上当前筛选词), Esc 才会清筛
key Escape
check "Esc 清筛选" "已清除筛选"
check "Esc 后资格考试回归" "资格考试"

# ── s 学习选中 ─────────────────────────────────────────────────
key s   # 光标默认在第 0 行 = 必修-学习中
wait_for "开始学习: 必修-学习中" 5 && say PASS "s 学习选中" "日志出现" && ((PASS++)) || { say FAIL "s 学习选中" "无日志"; ((FAIL++)); }
wait_for "学习 必修-学习中 结束" 5 && say PASS "s 任务结束" "日志出现" && ((PASS++)) || { say FAIL "s 任务结束" "无结束日志"; ((FAIL++)); }

# ── a 完成全部: 先取消后确认 ────────────────────────────────────
key a
check "a 确认框弹出" "确认开始?"
key Escape   # 焦点在[开始]按钮, Esc 不绑定; 用 tab 到取消再回车更稳
key Tab Enter
sleep 0.5
check "a 取消提示" "已取消"
key a
key Enter    # 焦点默认在[开始]
wait_for "开始完成全部" 5 && say PASS "a 确认后执行" "日志出现" && ((PASS++)) || { say FAIL "a 确认后执行" "无日志"; ((FAIL++)); }

# ── h 补学时 ────────────────────────────────────────────────────
key h
key BSpace BSpace BSpace BSpace   # tmux 键名是 BSpace 不是 BackSpace
check "h 学时输入框" "学时数"
key 2 0 Enter
wait_for "补网络自学学时: 20" 5 && say PASS "h 输入学时" "日志出现" && ((PASS++)) || { say FAIL "h 输入学时" "无日志"; ((FAIL++)); }

# ── d dry-run 切换 ──────────────────────────────────────────────
key d
check "d dry-run 日志" "dry-run = True"
key d
check "d 切回" "dry-run = False"

# ── Q 扫码登录(假码) + Esc 退出 ────────────────────────────────
key Q
wait_for "APP → 右上角扫一扫" 10 && say PASS "Q 扫码屏" "两路日志出现" && ((PASS++)) || { say FAIL "Q 扫码屏" "无日志"; ((FAIL++)); }
check "Q 微信通道" "微信 → 右上角"
key Escape
sleep 0.5
check "Esc 退出扫码屏" "必修-学习中"

# ── 回车 小节详情 ───────────────────────────────────────────────
key Enter   # 第 0 行是课程, 直接进小节详情
wait_for "第一节" 8 && say PASS "小节详情屏" "小节列表渲染" && ((PASS++)) || { say FAIL "小节详情屏" "无小节"; ((FAIL++)); }
key Escape
sleep 0.5

# ── n 添加账号(只测 UI 流程, Esc 中止) ──────────────────────────
key n
check "n 添加账号[1/2]" "[1/2] 登录用户名"
key Escape
check "n Esc 取消" "必修-学习中"

# ── u 切换账号(只测输入框出现) ──────────────────────────────────
key u
check "u 切换账号输入框" "账号名"
key Escape

# ── q 退出 ──────────────────────────────────────────────────────
key q
sleep 1
if ! tmux has-session -t "$SESS" 2>/dev/null; then
    say PASS "q 退出" "会话已结束"; ((PASS++))
else
    say FAIL "q 退出" "进程仍存活"; ((FAIL++))
fi
tmux kill-session -t "$SESS" 2>/dev/null

echo "── $FAIL 个失败 / $PASS 个通过, 耗时 $(( $(date +%s) - start ))s ──"
exit "$FAIL"

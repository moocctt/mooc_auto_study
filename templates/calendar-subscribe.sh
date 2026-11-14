#!/usr/bin/env bash
# 日历订阅：每天把「必修任务的截止日」重新生成成 .ics，推到静态地址给手机日历订阅。
#
# 手机日历「添加日历订阅」填的是这个文件的 URL（https://…/mooc.ics 或 webcal://…），
# 日历 App 会按自己的节奏（通常几小时到一天）重新拉取，所以文件必须被定时刷新。
#
# 用法：
#   1) 改下面的 STATIC_DIR 为你要托管的目录（GitHub Pages 的仓库目录 / 内网静态站的同步目录）
#   2) crontab -e 加入（每天 07:10 刷新）：
#        10 7 * * *  /path/to/skill/templates/calendar-subscribe.sh  >> ~/mooc-ics.log 2>&1
#
# 注意：.ics 只含标题/学时/普通课程链接，不要在这里开启带 access_token 的直达链接。

set -euo pipefail

SKILL="${SKILL:-$(cd "$(dirname "$0")/.." && pwd)}"
PY="${PY:-python3}"
STATIC_DIR="${STATIC_DIR:-$HOME/public/mooc}"     # 改成你实际托管的目录
OUT="$STATIC_DIR/mooc.ics"

mkdir -p "$STATIC_DIR"

# ① 用本地加密会话重新采集任务（会话过期会明确报错，不会悄悄生成旧数据）
#    用 --scope year：--scope active 不含已完成，日历会一直提醒早就学完的课；
#    而 --scope all 会把 2020 年以来的历史任务灌进同一个 tasks.json，日历与日常计划
#    都会被早已放弃的旧任务填满。本年度范围既能刷新完成状态，又不倒垃圾。
"$PY" "$SKILL/scripts/mooc_tasks.py" sync --scope year || {
    echo "[warn] 同步失败，继续用本地任务库重新生成日历" >&2
}

# ② 只导出必修截止日，提前 3 天提醒
"$PY" "$SKILL/scripts/tobacco.py" report --format ics \
    --required-only --alarm-days 3 --out "$OUT"

# ③ 推到静态地址（按你的托管方式二选一）
#    GitHub Pages:  cd "$STATIC_DIR" && git add mooc.ics && git commit -m "refresh" && git push
#    内网静态站:    rsync -a "$OUT" user@host:/var/www/html/mooc.ics
#    Tailscale:     任意 tailnet 内机器起个静态服务即可，手机在 tailnet 内订阅
echo "[ok] $OUT $(wc -c < "$OUT") bytes"

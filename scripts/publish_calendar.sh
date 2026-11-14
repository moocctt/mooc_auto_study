#!/usr/bin/env bash
# 把「必修截止日」发布到 GitHub Pages，供手机日历订阅。
#
#   https://<user>.github.io/<repo>/mooc.ics
#
# 主仓库是私有仓库，私有仓库的 Pages 订阅时需要认证，手机日历做不到，
# 所以日历单独放在一个**公开**仓库里（默认 gandli/mooc-calendar）。
# 公开 = 谁都能看到事件标题，因此默认开启 --mask-titles（课程名换成「必修任务 #n」）；
# 你的日历内容不敏感时可以用 MASK_TITLES=0 保留课程名。
#
# 多用户：每个用户一个文件 mooc-<用户名>.ics，订阅地址互不覆盖。两种隔离方式：
#   ① 同一个仓库多文件（家人/同事共用一个 Pages 站点）
#        CAL_USER=alice scripts/publish_calendar.sh   → …/mooc-alice.ics
#   ② 各自 fork 仓库（完全隔离，推荐给不同账号）
#        CAL_REPO=alice/mooc-calendar scripts/publish_calendar.sh
#   订阅地址的 owner 取自 CAL_REPO，所以 fork 后自动变成 alice.github.io/…
#
# 用法：
#   scripts/publish_calendar.sh                    # 生成 + 推送 + 打印订阅地址
#   CAL_USER=bob scripts/publish_calendar.sh       # 另一个用户的日历
#   MASK_TITLES=0 scripts/publish_calendar.sh      # 保留真实课程名
#   CAL_REPO=you/calendar CAL_WORK=/tmp/cal scripts/publish_calendar.sh
#
# 定时刷新（截止日与剩余天数每天都变）：
#   10 7 * * *  /path/to/skill/scripts/publish_calendar.sh >> ~/mooc-ics.log 2>&1

set -euo pipefail

SKILL="${SKILL:-$(cd "$(dirname "$0")/.." && pwd)}"
PY="${PY:-python3}"
REPO="${CAL_REPO:-gandli/mooc-calendar}"
# 缓存按仓库分目录：切换 CAL_REPO 用不同目录，绝不删除用户已有内容
WORK="${CAL_WORK:-$HOME/.cache/mooc-calendar}/$(echo "$REPO" | tr '/' '-')"
BRANCH="${CAL_BRANCH:-main}"
ALARM_DAYS="${ALARM_DAYS:-3}"
MASK="${MASK_TITLES:-1}"
# 多用户：文件名按用户区分，避免互相覆盖
CAL_USER="${CAL_USER:-$(git config user.name 2>/dev/null || echo "${USER:-me}")}"
SLUG="$(printf '%s' "$CAL_USER" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')"
[ -n "$SLUG" ] || SLUG="me"
FILE="mooc-$SLUG.ics"

command -v git >/dev/null 2>&1 || { echo "需要 git" >&2; exit 1; }

# ① 取到日历仓库的最新状态（缓存目录按仓库隔离，换 CAL_REPO 天然用新目录）
if [ -d "$WORK/.git" ]; then
    HAVE="$(git -C "$WORK" remote get-url origin 2>/dev/null || true)"
    case "$HAVE" in
        *"$REPO"*) ;;
        *) echo "[info] 缓存的 origin 与 CAL_REPO 不符，改用该仓库地址" >&2
           git -C "$WORK" remote set-url origin "https://github.com/$REPO.git" ;;
    esac
    git -C "$WORK" fetch -q origin "$BRANCH"
    git -C "$WORK" reset -q --hard "origin/$BRANCH"
else
    mkdir -p "$(dirname "$WORK")"
    git clone -q "https://github.com/$REPO.git" "$WORK"
fi

# ② 用本地任务库生成 .ics（不联网；想让数据最新就先跑 mooc_tasks.py sync）
ARGS=(report --format ics --required-only --alarm-days "$ALARM_DAYS"
      --out "$WORK/$FILE")
[ "$MASK" = "1" ] && ARGS+=(--mask-titles)
"$PY" "$SKILL/scripts/tobacco.py" "${ARGS[@]}"

# ③ 有变化才推送
cd "$WORK"
# 注意：全新文件是 untracked，`git diff` 对它返回"无差异"，要连 untracked 一起看
if [ -z "$(git status --porcelain -- "$FILE")" ]; then
    echo "[ok] $FILE 内容无变化，跳过推送"
else
    git add "$FILE"
    git -c user.name="$(git config user.name 2>/dev/null || echo calendar-bot)" \
        -c user.email="$(git config user.email 2>/dev/null || echo calendar@local)" \
        commit -q -m "calendar: refresh $(date -u +%F)"
    git push -q origin "HEAD:$BRANCH"
    echo "[ok] 已推送 $FILE（Pages 通常 1 分钟内生效）"
fi

USER_PART="$(echo "$REPO" | cut -d/ -f1)"
REPO_PART="$(echo "$REPO" | cut -d/ -f2)"
echo "[sub] https://$USER_PART.github.io/$REPO_PART/$FILE"
echo "[tip] 手机日历 → 添加日历订阅，填上面的地址；iOS 也可用 webcal:// 前缀"
